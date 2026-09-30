import { createHash, randomUUID } from "node:crypto";
import { assertAuthorized } from "../auth/authorization-service.mjs";
import { resolveProvisionedActor } from "../domain/pilot-identity.mjs";
import {
  PR_TRANSITIONS,
  PURCHASE_REQUEST_STATUS,
  canonicalPurchaseRequestLines,
  procurementError,
  tenantScopedProcurementMasterData,
} from "../domain/procurement-workflow.mjs";
import { receivingDecimalString, receivingDecimalUnits } from "../domain/receiving-transaction-policy.mjs";
import { getPrismaClient } from "../persistence/prisma-client.mjs";
import { mapPurchaseRequest } from "../repositories/db-procurement-read-repository.mjs";

// The permission catalog has no purchase-request codes, and adding one means
// migrating the TenantRolePermission catalog CHECK constraint. Each command
// therefore uses the closest existing purchase-order permission: drafting and
// converting follow "revise" (buyer, manager, admin); decisions follow
// "approve" and "reject" (manager, admin).
export const PURCHASE_REQUEST_PERMISSIONS = Object.freeze({
  read: "procurement.purchase_order.read",
  create: "procurement.purchase_order.revise",
  update: "procurement.purchase_order.revise",
  submit: "procurement.purchase_order.revise",
  withdraw: "procurement.purchase_order.revise",
  cancel: "procurement.purchase_order.revise",
  approve: "procurement.purchase_order.approve",
  reject: "procurement.purchase_order.reject",
});

const NEXT_STATUS = Object.freeze({
  submit: PURCHASE_REQUEST_STATUS.SUBMITTED,
  approve: PURCHASE_REQUEST_STATUS.APPROVED,
  reject: PURCHASE_REQUEST_STATUS.REJECTED,
  withdraw: PURCHASE_REQUEST_STATUS.DRAFT,
  cancel: PURCHASE_REQUEST_STATUS.CANCELLED,
});

const SCALE = 10_000n;
const text = (value) => String(value ?? "").trim();
const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const serial = (value) => value?.toISOString?.() || value || null;
const documentId = (prefix) => `${prefix}-${randomUUID().slice(0, 8).toUpperCase()}`;
const fail = (code, message, status = 400, details = [], extra = {}) => { throw procurementError(code, message, details, status, extra); };

function units(value, field) {
  try {
    return receivingDecimalUnits(String(value));
  } catch {
    return fail("LINE_VALUE_INVALID", `${field} must be a number with at most four decimal places.`, 400, [{ field }]);
  }
}
// Four-place fixed point multiply, rounded half up; inputs are non-negative.
const multiply = (left, right) => (left * right + SCALE / 2n) / SCALE;

function currencyCode(value, field) {
  const code = text(value).toUpperCase();
  if (!/^[A-Z]{3}$/.test(code)) fail("CURRENCY_INVALID", `${field} must be a three-letter currency code.`, 400, [{ field }]);
  return code;
}

function dateOnly(value, field) {
  const raw = text(value);
  if (!raw) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw) || Number.isNaN(Date.parse(`${raw}T00:00:00Z`))) fail("DATE_INVALID", `${field} must be a YYYY-MM-DD date.`, 400, [{ field }]);
  return raw;
}

const versionOf = (row) => Number(row?.metadata?.version ?? 0);
function expected(value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) fail("VERSION_INVALID", "expectedVersion must be a non-negative integer.", 422, [{ field: "expectedVersion" }]);
  return parsed;
}
function assertCurrentVersion(row, expectedVersion) {
  const currentVersion = versionOf(row);
  if (currentVersion !== expectedVersion) fail("VERSION_CONFLICT", "This purchase request was changed by someone else. Reload it and try again.", 409, [], { entityId: row.id, expectedVersion, currentVersion });
}

// Turns validated canonical lines into PurchaseRequestLine rows with exact
// four-place amounts. The PR total is only kept when every line uses the PR
// currency: amounts in different currencies are never added together.
function persistableLines(lines, headerCurrency) {
  let total = 0n;
  let singleCurrency = true;
  const rows = lines.map((line, index) => {
    const currency = currencyCode(line.currency || headerCurrency, `lines.${index}.currency`);
    const byAmount = line.lineBasis === "amount";
    const quantity = byAmount ? null : units(line.quantity, `lines.${index}.quantity`);
    const unitPrice = byAmount ? null : units(line.estimatedUnitPrice, `lines.${index}.estimatedUnitPrice`);
    const amount = byAmount ? units(line.estimatedAmount, `lines.${index}.estimatedAmount`) : multiply(quantity, unitPrice);
    if (currency !== headerCurrency) singleCurrency = false;
    total += amount;
    return {
      id: randomUUID(),
      itemId: line.itemId || null,
      sku: line.sku || null,
      itemName: text(line.itemNameSnapshot || line.itemName) || null,
      quantity: quantity === null ? null : receivingDecimalString(quantity),
      unit: text(line.unitSnapshot || line.unit) || null,
      unitPrice: unitPrice === null ? null : receivingDecimalString(unitPrice),
      amount: receivingDecimalString(amount),
      metadata: {
        clientLineId: text(line.lineId) || null,
        sourceType: line.sourceType || line.lineType,
        lineBasis: line.lineBasis || "quantity",
        supplierId: line.supplierId,
        supplierSnapshot: line.supplierSnapshot || null,
        currency,
        targetWarehouseId: text(line.targetWarehouseId || line.warehouseId) || null,
        needByDate: dateOnly(line.needByDate, `lines.${index}.needByDate`),
        serviceStartDate: text(line.serviceStartDate) || null,
        serviceEndDate: text(line.serviceEndDate) || null,
        specificationSnapshot: text(line.specificationSnapshot) || null,
        commodityId: text(line.commodityId) || null,
        internalLineComment: text(line.internalLineComment) || null,
      },
    };
  });
  const suppliers = [...new Set(rows.map((row) => row.metadata.supplierId))];
  return {
    rows,
    amount: singleCurrency ? receivingDecimalString(total) : null,
    supplierId: suppliers.length === 1 ? suppliers[0] : null,
    supplierName: suppliers.length === 1 ? text(rows[0].metadata.supplierSnapshot?.supplierName) || null : null,
  };
}

export function createProcurementRequestCommandService({ prisma, masterData, env = process.env, idFactory = randomUUID, now = () => new Date() } = {}) {
  const db = async () => prisma || getPrismaClient(env);
  const actorFor = async (client, context, permission) => {
    const actor = await resolveProvisionedActor(client, context?.identity || context);
    assertAuthorized({ actor, permission, tenantId: actor.tenantId });
    return actor;
  };
  const validateLines = async (lines, tenantId) => {
    if (!Array.isArray(lines) || !lines.length) fail("LINES_REQUIRED", "A purchase request needs at least one line.", 400, [{ field: "lines" }]);
    if (!masterData) fail("MASTER_DATA_UNAVAILABLE", "Master data is not configured.", 503);
    return canonicalPurchaseRequestLines(lines, tenantScopedProcurementMasterData(masterData, tenantId));
  };
  const readRequest = async (client, tenantId, id) => client.purchaseRequest.findFirst({ where: { id: text(id), tenantId }, include: { lines: { orderBy: { id: "asc" } } } });
  const lockRequest = async (tx, tenantId, id) => {
    await tx.$queryRawUnsafe('SELECT "id" FROM "PurchaseRequest" WHERE "tenantId" = $1 AND "id" = $2 FOR UPDATE', tenantId, text(id));
    const row = await readRequest(tx, tenantId, id);
    if (!row) fail("ENTITY_NOT_FOUND", "Purchase request was not found.", 404);
    return row;
  };
  const timelineEntry = (action, actor, reason) => ({ action, actorId: actor.user.id, at: serial(now()), reason: text(reason) || null });

  // Runs one command exactly once per (tenant, commandType, idempotencyKey):
  // a repeat with the same payload returns the stored result, a repeat with a
  // different payload is refused. The write, its audit row and the execution
  // record commit together. When the client sends no key, the key is derived
  // from the target, the expected version and the payload, so a resend is a
  // replay and a changed request still meets the version check.
  async function runCommand({ context, permission, commandType, idempotencyKey, derivedKey, payload, execute }) {
    const client = await db();
    const initial = await actorFor(client, context, permission);
    const requestHash = hash(payload);
    const key = text(idempotencyKey) || `${derivedKey}:${requestHash.slice(0, 24)}`;
    const where = { tenantId_commandType_idempotencyKey: { tenantId: initial.tenantId, commandType, idempotencyKey: key } };
    const replay = (row) => {
      if (!row) return null;
      if (row.requestHash !== requestHash) fail("IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD", "The idempotency key was reused with a different payload.", 409);
      if (row.status !== "completed" || !row.resultPayload) fail("COMMAND_EXECUTION_IN_PROGRESS", "The command is already in progress.", 409);
      return { ...row.resultPayload, idempotentReplay: true };
    };
    const prior = replay(await client.businessCommandExecution.findUnique({ where }));
    if (prior) return prior;
    try {
      return await client.$transaction(async (tx) => {
        const actor = await actorFor(tx, context, permission);
        const inside = replay(await tx.businessCommandExecution.findUnique({ where }));
        if (inside) return inside;
        const execution = await tx.businessCommandExecution.create({ data: { id: idFactory(), tenantId: actor.tenantId, commandType, idempotencyKey: key, requestHash, status: "pending" } });
        const { result, entityType, entityId, audit } = await execute(tx, actor);
        await tx.auditLog.create({ data: { id: idFactory(), tenantId: actor.tenantId, actorId: actor.user.id, source: "procurement_request_command_service", module: "procurement", entityType, entityId, ...audit, metadata: { commandType, idempotencyKey: key, ...(audit.metadata || {}) } } });
        await tx.businessCommandExecution.update({ where: { id: execution.id }, data: { status: "completed", entityType, entityId, resultPayload: result, completedAt: now() } });
        return { ...result, idempotentReplay: false };
      }, { isolationLevel: "Serializable", maxWait: 10_000, timeout: 30_000 });
    } catch (error) {
      if (error?.code === "P2002") {
        const committed = replay(await client.businessCommandExecution.findUnique({ where }));
        if (committed) return committed;
      }
      throw error;
    }
  }

  async function createPurchaseRequest(input = {}, context) {
    const client = await db();
    const actor = await actorFor(client, context, PURCHASE_REQUEST_PERMISSIONS.create);
    const lines = await validateLines(input.lines, actor.tenantId);
    const tenant = await client.tenant.findUnique({ where: { id: actor.tenantId }, select: { currency: true } });
    const currency = currencyCode(input.defaultCurrency || input.currency || tenant?.currency, "defaultCurrency");
    const needBy = dateOnly(input.defaultNeedByDate, "defaultNeedByDate");
    const persisted = persistableLines(lines, currency);
    const id = documentId("PR");
    return runCommand({
      context,
      permission: PURCHASE_REQUEST_PERMISSIONS.create,
      commandType: "purchase_request.create",
      // Without a client key every create is a new request.
      idempotencyKey: input.idempotencyKey || idFactory(),
      payload: { departmentId: text(input.departmentId), currency, needBy, lines: persisted.rows.map(({ id: _id, ...row }) => row) },
      execute: async (tx, commandActor) => {
        const created = await tx.purchaseRequest.create({
          data: {
            id, tenantId: commandActor.tenantId, status: PURCHASE_REQUEST_STATUS.DRAFT,
            requester: commandActor.user.id, supplierId: persisted.supplierId, supplierName: persisted.supplierName,
            requiredDate: needBy ? new Date(`${needBy}T00:00:00Z`) : null, amount: persisted.amount, currency,
            reason: text(input.reason) || null, source: "manual",
            metadata: { version: 1, requesterId: commandActor.user.id, departmentId: text(input.departmentId), procurementPath: "undecided", emergencyPurchase: Boolean(input.emergencyPurchase), singleSource: Boolean(input.singleSource), timeline: [timelineEntry("create", commandActor)] },
            lines: { create: persisted.rows },
          },
        });
        const purchaseRequest = mapPurchaseRequest(await readRequest(tx, commandActor.tenantId, created.id));
        return { result: purchaseRequest, entityType: "PurchaseRequest", entityId: created.id, audit: { action: "purchase_request_created", summary: `Created purchase request ${created.id}.`, metadata: { version: 1, amount: persisted.amount, currency } } };
      },
    });
  }

  async function updatePurchaseRequestDraft(id, input = {}, context) {
    const client = await db();
    const actor = await actorFor(client, context, PURCHASE_REQUEST_PERMISSIONS.update);
    const expectedVersion = expected(input.expectedVersion);
    const lines = input.lines === undefined ? null : await validateLines(input.lines, actor.tenantId);
    const payload = { id: text(id), expectedVersion, departmentId: input.departmentId ?? null, defaultCurrency: input.defaultCurrency ?? null, defaultNeedByDate: input.defaultNeedByDate ?? null, lines };
    return runCommand({
      context,
      permission: PURCHASE_REQUEST_PERMISSIONS.update,
      commandType: "purchase_request.update",
      idempotencyKey: input.idempotencyKey,
      derivedKey: `purchase_request.update:${text(id)}:v${expectedVersion}`,
      payload,
      execute: async (tx, commandActor) => {
        const row = await lockRequest(tx, commandActor.tenantId, id);
        assertCurrentVersion(row, expectedVersion);
        if (row.status !== PURCHASE_REQUEST_STATUS.DRAFT) fail("INVALID_STATE_TRANSITION", "Only a draft purchase request can be edited.", 409, [], { currentStatus: row.status, currentVersion: versionOf(row) });
        const currency = input.defaultCurrency === undefined ? row.currency : currencyCode(input.defaultCurrency, "defaultCurrency");
        const needBy = input.defaultNeedByDate === undefined ? serial(row.requiredDate)?.slice(0, 10) || null : dateOnly(input.defaultNeedByDate, "defaultNeedByDate");
        const persisted = lines ? persistableLines(lines, currency) : null;
        const version = versionOf(row) + 1;
        if (persisted) await tx.purchaseRequestLine.deleteMany({ where: { purchaseRequestId: row.id } });
        await tx.purchaseRequest.update({
          where: { id: row.id },
          data: {
            currency,
            requiredDate: needBy ? new Date(`${needBy}T00:00:00Z`) : null,
            ...(persisted ? { amount: persisted.amount, supplierId: persisted.supplierId, supplierName: persisted.supplierName, lines: { create: persisted.rows } } : {}),
            ...(input.reason !== undefined ? { reason: text(input.reason) || null } : {}),
            metadata: { ...(row.metadata || {}), version, ...(input.departmentId !== undefined ? { departmentId: text(input.departmentId) } : {}), timeline: [...(row.metadata?.timeline || []), timelineEntry("update", commandActor)] },
          },
        });
        const purchaseRequest = mapPurchaseRequest(await readRequest(tx, commandActor.tenantId, row.id));
        return { result: purchaseRequest, entityType: "PurchaseRequest", entityId: row.id, audit: { action: "purchase_request_updated", summary: `Updated purchase request ${row.id}.`, metadata: { expectedVersion, version } } };
      },
    });
  }

  async function transitionPurchaseRequest(id, action, input = {}, context) {
    const next = NEXT_STATUS[action];
    if (!next) fail("UNSUPPORTED_ACTION", `Unsupported purchase request action: ${action}.`, 400);
    const expectedVersion = expected(input.expectedVersion);
    const reason = text(input.reason);
    if (action === "reject" && !reason) fail("REJECT_REASON_REQUIRED", "A reason is required to reject a purchase request.", 400, [{ field: "reason" }]);
    const commandType = `purchase_request.${action}`;
    return runCommand({
      context,
      permission: PURCHASE_REQUEST_PERMISSIONS[action],
      commandType,
      idempotencyKey: input.idempotencyKey,
      derivedKey: `${commandType}:${text(id)}:v${expectedVersion}`,
      payload: { id: text(id), action, expectedVersion, reason },
      execute: async (tx, actor) => {
        const row = await lockRequest(tx, actor.tenantId, id);
        assertCurrentVersion(row, expectedVersion);
        if (!(PR_TRANSITIONS[row.status] || []).includes(next)) fail("INVALID_STATE_TRANSITION", `A ${row.status} purchase request cannot be moved to ${next}.`, 409, [], { currentStatus: row.status, currentVersion: versionOf(row) });
        const version = versionOf(row) + 1;
        await tx.purchaseRequest.update({
          where: { id: row.id },
          data: {
            status: next,
            ...(action === "approve" ? { buyer: row.buyer || null } : {}),
            metadata: { ...(row.metadata || {}), version, lastAction: action, lastActorId: actor.user.id, lastReason: reason || null, timeline: [...(row.metadata?.timeline || []), timelineEntry(action, actor, reason)] },
          },
        });
        const purchaseRequest = mapPurchaseRequest(await readRequest(tx, actor.tenantId, row.id));
        return { result: purchaseRequest, entityType: "PurchaseRequest", entityId: row.id, audit: { action: `purchase_request_${action}`, summary: `${action} purchase request ${row.id}.`, metadata: { expectedVersion, version, from: row.status, to: next, reason: reason || null } } };
      },
    });
  }

  async function readPurchaseRequest(id, context) {
    const client = await db();
    const actor = await actorFor(client, context, PURCHASE_REQUEST_PERMISSIONS.read);
    const row = await readRequest(client, actor.tenantId, id);
    if (!row) fail("ENTITY_NOT_FOUND", "Purchase request was not found.", 404);
    return mapPurchaseRequest(row);
  }

  return {
    readPurchaseRequest,
    createPurchaseRequest,
    updatePurchaseRequestDraft,
    transitionPurchaseRequest,
  };
}
