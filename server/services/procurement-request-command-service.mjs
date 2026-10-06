import { createHash, randomUUID } from "node:crypto";
import { assertAuthorized } from "../auth/authorization-service.mjs";
import { resolveProvisionedActor } from "../domain/pilot-identity.mjs";
import {
  PR_TRANSITIONS,
  PURCHASE_ORDER_STATUS,
  PURCHASE_REQUEST_STATUS,
  RFQ_STATUS,
  RFQ_TRANSITIONS,
  canonicalPurchaseRequestLines,
  procurementError,
  tenantScopedProcurementMasterData,
} from "../domain/procurement-workflow.mjs";
import { receivingDecimalString, receivingDecimalUnits } from "../domain/receiving-transaction-policy.mjs";
import { applyPromisedDateChanges } from "../domain/purchase-order-promise-dates.mjs";
import { getPrismaClient } from "../persistence/prisma-client.mjs";
import { sanitizeSuggestionTrail } from "../../shared/prefill-suggestions.mjs";
import { mapPurchaseOrder, mapPurchaseRequest, mapRfq } from "../repositories/db-procurement-read-repository.mjs";

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
  createRfq: "procurement.purchase_order.revise",
  createPurchaseOrders: "procurement.purchase_order.revise",
  openRfq: "procurement.purchase_order.revise",
  cancelRfq: "procurement.purchase_order.revise",
});
const RFQ_NEXT_STATUS = Object.freeze({ open: RFQ_STATUS.OPEN, cancel: RFQ_STATUS.CANCELLED });
const INACTIVE_RFQ_STATUSES = [RFQ_STATUS.CANCELLED, RFQ_STATUS.CLOSED];

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
const decimalText = (value) => value === null || value === undefined ? null : receivingDecimalString(receivingDecimalUnits(String(value)));
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
        // Why a supplier other than the item's preferred one was chosen.
        ...(line.supplierOverride ? { supplierOverride: line.supplierOverride } : {}),
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

// The audit row's list of lines that use a supplier other than the item's
// preferred one, with the reason given.
function supplierOverrideAudit(rows, extra = () => ({})) {
  return rows
    .filter((row) => row.metadata?.supplierOverride)
    .map((row) => {
      const override = row.metadata.supplierOverride;
      return { clientLineId: row.metadata.clientLineId || null, ...extra(row), itemId: row.itemId || null, supplierId: row.metadata.supplierId, preferredSupplierId: override.preferredSupplierId || null, reasonCode: override.reasonCode, note: override.note || null };
    });
}
const withOverrides = (list) => (list.length ? { supplierOverrides: list } : {});

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
        const { result, entityType, entityId, audit } = await execute(tx, actor, { idempotencyKey: key });
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
    // Which values a prefilled form suggested and what the user did with
    // them: codes and ids only. It goes to the audit row, outside the
    // idempotency payload, so it never changes what the request means.
    const suggestions = sanitizeSuggestionTrail(input.suggestionTrail);
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
        return { result: purchaseRequest, entityType: "PurchaseRequest", entityId: created.id, audit: { action: "purchase_request_created", summary: `Created purchase request ${created.id}.`, metadata: { version: 1, amount: persisted.amount, currency, ...withOverrides(supplierOverrideAudit(persisted.rows)), ...(suggestions ? { suggestions } : {}) } } };
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
        return { result: purchaseRequest, entityType: "PurchaseRequest", entityId: row.id, audit: { action: "purchase_request_updated", summary: `Updated purchase request ${row.id}.`, metadata: { expectedVersion, version, ...(persisted ? withOverrides(supplierOverrideAudit(persisted.rows)) : {}) } } };
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
        // Withdrawing or cancelling an approved PR must not orphan its RFQ or POs.
        if (row.status === PURCHASE_REQUEST_STATUS.APPROVED) await assertNoActiveDownstream(tx, actor.tenantId, row.id);
        const version = versionOf(row) + 1;
        await tx.purchaseRequest.update({
          where: { id: row.id },
          data: {
            status: next,
            metadata: { ...(row.metadata || {}), version, lastAction: action, lastActorId: actor.user.id, lastReason: reason || null, timeline: [...(row.metadata?.timeline || []), timelineEntry(action, actor, reason)] },
          },
        });
        const purchaseRequest = mapPurchaseRequest(await readRequest(tx, actor.tenantId, row.id));
        return { result: purchaseRequest, entityType: "PurchaseRequest", entityId: row.id, audit: { action: `purchase_request_${action}`, summary: `${action} purchase request ${row.id}.`, metadata: { expectedVersion, version, from: row.status, to: next, reason: reason || null } } };
      },
    });
  }

  // An approved PR feeds either one open RFQ or its purchase orders, never both.
  async function assertNoActiveDownstream(tx, tenantId, purchaseRequestId) {
    const po = await tx.purchaseOrder.findFirst({ where: { tenantId, sourceRequestId: purchaseRequestId, status: { not: PURCHASE_ORDER_STATUS.CANCELLED } }, select: { id: true } });
    if (po) fail("DOWNSTREAM_OBJECT_ALREADY_EXISTS", `Purchase order ${po.id} already exists for this purchase request.`, 409, [], { entityId: po.id });
    const rfq = await tx.rfq.findFirst({ where: { tenantId, sourceRequestId: purchaseRequestId, status: { notIn: INACTIVE_RFQ_STATUSES } }, select: { id: true } });
    if (rfq) fail("DOWNSTREAM_OBJECT_ALREADY_EXISTS", `RFQ ${rfq.id} is still open for this purchase request.`, 409, [], { entityId: rfq.id });
  }
  const assertApproved = (row) => {
    if (row.status !== PURCHASE_REQUEST_STATUS.APPROVED) fail("INVALID_STATE_TRANSITION", "Only an approved purchase request can be sourced.", 409, [], { currentStatus: row.status, currentVersion: versionOf(row) });
  };
  const sourcedRequest = (row, actor, action, patch = {}) => ({
    ...patch,
    metadata: { ...(row.metadata || {}), ...(patch.metadata || {}), version: versionOf(row) + 1, lastAction: action, lastActorId: actor.user.id, timeline: [...(row.metadata?.timeline || []), timelineEntry(action, actor)] },
  });

  async function createRfqFromPurchaseRequest(id, input = {}, context) {
    const expectedVersion = expected(input.expectedVersion);
    const dueDate = dateOnly(input.dueDate, "dueDate");
    const invitedSupplierIds = [...new Set((Array.isArray(input.invitedSupplierIds) ? input.invitedSupplierIds : []).map(text).filter(Boolean))].sort();
    const title = text(input.title);
    return runCommand({
      context,
      permission: PURCHASE_REQUEST_PERMISSIONS.createRfq,
      commandType: "purchase_request.create_rfq",
      idempotencyKey: input.idempotencyKey,
      derivedKey: `purchase_request.create_rfq:${text(id)}:v${expectedVersion}`,
      payload: { id: text(id), expectedVersion, dueDate, invitedSupplierIds, title },
      execute: async (tx, actor) => {
        const row = await lockRequest(tx, actor.tenantId, id);
        assertCurrentVersion(row, expectedVersion);
        assertApproved(row);
        await assertNoActiveDownstream(tx, actor.tenantId, row.id);
        const suppliers = invitedSupplierIds.length ? await tx.supplier.findMany({ where: { tenantId: actor.tenantId, id: { in: invitedSupplierIds } } }) : [];
        for (const supplierId of invitedSupplierIds) {
          const supplier = suppliers.find((entry) => entry.id === supplierId);
          if (!supplier || text(supplier.status || "active").toLowerCase() !== "active") fail("SUPPLIER_NOT_FOUND", `Supplier ${supplierId} is not an active supplier of this workspace.`, 400, [{ field: "invitedSupplierIds" }]);
        }
        const rfqId = documentId("RFQ");
        await tx.rfq.create({ data: {
          id: rfqId, tenantId: actor.tenantId, title: title || `RFQ for ${row.id}`, status: RFQ_STATUS.DRAFT,
          supplierCount: invitedSupplierIds.length, respondedSupplierCount: 0,
          dueDate: dueDate ? new Date(`${dueDate}T00:00:00Z`) : row.requiredDate, sourceRequestId: row.id, currency: row.currency,
          metadata: { version: 1, createdBy: actor.user.id, sourcePurchaseRequestVersion: versionOf(row), invitedSupplierIds, timeline: [timelineEntry("create", actor)] },
        } });
        await tx.rfqLine.createMany({ data: row.lines.map((line) => ({
          id: idFactory(), tenantId: actor.tenantId, rfqId, itemId: line.itemId, sku: line.sku, itemName: line.itemName, quantity: line.quantity, unit: line.unit,
          metadata: { sourcePurchaseRequestLineId: line.id, requiredDate: line.metadata?.needByDate || null, warehouseId: line.metadata?.targetWarehouseId || null, targetUnitPrice: decimalText(line.unitPrice) },
        })) });
        if (invitedSupplierIds.length) await tx.rfqSupplierParticipation.createMany({ data: invitedSupplierIds.map((supplierId) => ({ id: idFactory(), tenantId: actor.tenantId, rfqId, supplierId, status: "planned", metadata: { createdBy: actor.user.id } })) });
        await tx.purchaseRequest.update({ where: { id: row.id }, data: sourcedRequest(row, actor, "create_rfq", { linkedRfqId: rfqId, metadata: { procurementPath: "rfq" } }) });
        const rfq = await tx.rfq.findUnique({ where: { id: rfqId }, include: { lines: true } });
        const purchaseRequest = mapPurchaseRequest(await readRequest(tx, actor.tenantId, row.id));
        return { result: { purchaseRequest, rfq: mapRfq(rfq) }, entityType: "Rfq", entityId: rfqId, audit: { action: "rfq_created_from_purchase_request", summary: `Created RFQ ${rfqId} from purchase request ${row.id}.`, metadata: { purchaseRequestId: row.id, expectedVersion, invitedSupplierIds, currency: row.currency } } };
      },
    });
  }

  async function transitionRfq(id, action, input = {}, context) {
    const next = RFQ_NEXT_STATUS[action];
    if (!next) fail("UNSUPPORTED_ACTION", `Unsupported RFQ action: ${action}.`, 400);
    const expectedVersion = expected(input.expectedVersion);
    const commandType = `rfq.${action}`;
    return runCommand({
      context,
      permission: action === "open" ? PURCHASE_REQUEST_PERMISSIONS.openRfq : PURCHASE_REQUEST_PERMISSIONS.cancelRfq,
      commandType,
      idempotencyKey: input.idempotencyKey,
      derivedKey: `${commandType}:${text(id)}:v${expectedVersion}`,
      payload: { id: text(id), action, expectedVersion, reason: text(input.reason) },
      execute: async (tx, actor) => {
        await tx.$queryRawUnsafe('SELECT "id" FROM "Rfq" WHERE "tenantId" = $1 AND "id" = $2 FOR UPDATE', actor.tenantId, text(id));
        const row = await tx.rfq.findFirst({ where: { id: text(id), tenantId: actor.tenantId } });
        if (!row) fail("ENTITY_NOT_FOUND", "RFQ was not found.", 404);
        const currentVersion = versionOf(row);
        if (currentVersion !== expectedVersion) fail("VERSION_CONFLICT", "This RFQ was changed by someone else. Reload it and try again.", 409, [], { entityId: row.id, expectedVersion, currentVersion });
        if (!(RFQ_TRANSITIONS[row.status] || []).includes(next)) fail("INVALID_STATE_TRANSITION", `A ${row.status} RFQ cannot be moved to ${next}.`, 409, [], { currentStatus: row.status, currentVersion });
        // Opening records that the buyer invited the planned suppliers inside
        // FlowChain; nothing is sent to them.
        if (action === "open") await tx.rfqSupplierParticipation.updateMany({ where: { tenantId: actor.tenantId, rfqId: row.id, status: "planned" }, data: { status: "invited_internal", invitedAt: now(), version: { increment: 1 } } });
        const updated = await tx.rfq.update({ where: { id: row.id }, data: { status: next, metadata: { ...(row.metadata || {}), version: currentVersion + 1, lastAction: action, lastActorId: actor.user.id, lastReason: text(input.reason) || null, timeline: [...(row.metadata?.timeline || []), timelineEntry(action, actor, input.reason)] } }, include: { lines: true } });
        return { result: mapRfq(updated), entityType: "Rfq", entityId: row.id, audit: { action: `rfq_${action}`, summary: `${action} RFQ ${row.id}.`, metadata: { expectedVersion, version: currentVersion + 1, from: row.status, to: next } } };
      },
    });
  }

  // Groups the approved PR's lines by supplier, currency and delivery
  // warehouse and creates one draft PO per group, so no PO mixes currencies.
  async function createPurchaseOrdersFromPurchaseRequest(id, input = {}, context) {
    const expectedVersion = expected(input.expectedVersion);
    return runCommand({
      context,
      permission: PURCHASE_REQUEST_PERMISSIONS.createPurchaseOrders,
      commandType: "purchase_request.create_purchase_orders",
      idempotencyKey: input.idempotencyKey,
      derivedKey: `purchase_request.create_purchase_orders:${text(id)}:v${expectedVersion}`,
      payload: { id: text(id), expectedVersion },
      execute: async (tx, actor, { idempotencyKey }) => {
        const row = await lockRequest(tx, actor.tenantId, id);
        assertCurrentVersion(row, expectedVersion);
        assertApproved(row);
        await assertNoActiveDownstream(tx, actor.tenantId, row.id);
        const missing = row.lines.flatMap((line, index) => ["supplierId", "currency", "targetWarehouseId"].filter((field) => !text(line.metadata?.[field])).map((field) => ({ field: `lines.${index}.${field}` })));
        if (!row.lines.length || missing.length) fail("DIRECT_PO_NOT_ALLOWED", "Every line needs a supplier, a currency and a delivery warehouse before a PO can be created.", 422, missing.length ? missing : [{ field: "lines" }]);
        const groups = new Map();
        for (const line of row.lines) {
          const meta = line.metadata || {};
          const groupKey = [meta.supplierId, meta.currency, meta.targetWarehouseId].join("::");
          if (!groups.has(groupKey)) groups.set(groupKey, { supplierId: meta.supplierId, supplierName: text(meta.supplierSnapshot?.supplierName) || null, currency: meta.currency, warehouseId: meta.targetWarehouseId, lines: [] });
          groups.get(groupKey).lines.push(line);
        }
        const purchaseOrderIds = [];
        const carriedOverrides = [];
        for (const group of groups.values()) {
          const poId = documentId("PO");
          purchaseOrderIds.push(poId);
          let total = 0n;
          const lines = group.lines.map((line) => {
            const amount = receivingDecimalUnits(String(line.amount ?? "0"));
            total += amount;
            // An amount-basis line (a service) is ordered as one unit at its amount.
            const quantity = line.quantity === null ? "1.0000" : decimalText(line.quantity);
            const unitPrice = line.unitPrice === null ? receivingDecimalString(amount) : decimalText(line.unitPrice);
            // The reason for a non-preferred supplier travels with the line as
            // recorded: the PO approver sees what the requester gave.
            const supplierOverride = line.metadata?.supplierOverride || null;
            return { id: idFactory(), itemId: line.itemId, sku: line.sku, itemName: line.itemName, orderedQuantity: quantity, receivedQuantity: "0.0000", unit: line.unit, unitPrice, amount: receivingDecimalString(amount), metadata: { sourcePurchaseRequestLineId: line.id, targetWarehouseId: group.warehouseId, requestedDate: line.metadata?.needByDate || null, ...(supplierOverride ? { supplierOverride } : {}) } };
          });
          carriedOverrides.push(...supplierOverrideAudit(group.lines, (line) => ({ purchaseOrderId: poId, purchaseRequestLineId: line.id })));
          const dates = group.lines.map((line) => line.metadata?.needByDate).filter(Boolean).sort();
          await tx.purchaseOrder.create({ data: {
            id: poId, tenantId: actor.tenantId, status: PURCHASE_ORDER_STATUS.DRAFT, supplierId: group.supplierId, supplierName: group.supplierName,
            sourceRequestId: row.id, expectedDate: dates[0] ? new Date(`${dates[0]}T00:00:00Z`) : row.requiredDate,
            amount: receivingDecimalString(total), currency: group.currency, owner: actor.user.name || actor.user.id, version: 0,
            metadata: { orderNumber: poId, targetWarehouseId: group.warehouseId, procurementPath: "direct_po", transmissionStatus: "not_sent", createdBy: actor.user.id, sourcePurchaseRequestVersion: versionOf(row) },
            lines: { create: lines },
          } });
          // Each line's date from its PR line (a promised date, or else the need-by
          // date) goes through the promise-date helper, like every later change.
          // On a draft it only sets the date; the original promise is recorded
          // when the PO is issued.
          const lineDates = lines.map((line, index) => ({ purchaseOrderLineId: line.id, promisedDate: group.lines[index].metadata?.promisedDate || group.lines[index].metadata?.needByDate || null })).filter((change) => change.promisedDate);
          if (lineDates.length) {
            await applyPromisedDateChanges(tx, { tenantId: actor.tenantId, purchaseOrder: await tx.purchaseOrder.findFirst({ where: { id: poId, tenantId: actor.tenantId }, include: { lines: true } }), changes: lineDates, actorId: actor.user.id, source: "procurement_request_command_service", at: now(), idFactory, bumpVersions: false });
          }
          await tx.domainChangeFeed.create({ data: { tenantId: actor.tenantId, entityType: "PurchaseOrder", entityId: poId, operation: "upsert", entityVersion: 0, actorId: actor.user.id, source: "procurement_request_command_service", requestId: idempotencyKey, payloadHash: hash({ id: poId, version: 0, status: PURCHASE_ORDER_STATUS.DRAFT }), sensitivityGroups: ["procurement_prices", "finance_partner_snapshot"], moduleKey: "procurement", authorizationClass: "procurement.purchase_order.read", resourceTenantId: actor.tenantId } });
        }
        await tx.purchaseRequest.update({ where: { id: row.id }, data: sourcedRequest(row, actor, "create_purchase_orders", { status: PURCHASE_REQUEST_STATUS.CONVERTED, linkedPoId: purchaseOrderIds[0], metadata: { procurementPath: "direct_po", linkedPurchaseOrderIds: purchaseOrderIds } }) });
        const orders = await tx.purchaseOrder.findMany({ where: { tenantId: actor.tenantId, id: { in: purchaseOrderIds } }, include: { lines: true }, orderBy: { id: "asc" } });
        const purchaseRequest = mapPurchaseRequest(await readRequest(tx, actor.tenantId, row.id));
        return { result: { purchaseRequestId: row.id, purchaseRequest, createdPurchaseOrders: orders.map(mapPurchaseOrder) }, entityType: "PurchaseRequest", entityId: row.id, audit: { action: "purchase_request_converted_to_purchase_orders", summary: `Created ${purchaseOrderIds.length} purchase order(s) from purchase request ${row.id}.`, metadata: { expectedVersion, purchaseOrderIds, ...withOverrides(carriedOverrides) } } };
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
    createRfqFromPurchaseRequest,
    transitionRfq,
    createPurchaseOrdersFromPurchaseRequest,
  };
}
