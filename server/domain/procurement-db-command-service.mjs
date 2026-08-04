import { createHash, randomUUID } from "node:crypto";
import { assertAuthorized } from "../auth/authorization-service.mjs";
import { getPrismaClient } from "../persistence/prisma-client.mjs";
import { resolveProvisionedActor } from "./pilot-identity.mjs";
import { PURCHASE_ORDER_STATUS } from "./procurement-status-authority.mjs";
import { receivingDecimalString, receivingDecimalUnits } from "./receiving-transaction-policy.mjs";

export class ProcurementCommandError extends Error {
  constructor(code, message, status = 400, details) {
    super(message);
    this.name = "ProcurementCommandError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

const fail = (code, message, status = 400, details) => { throw new ProcurementCommandError(code, message, status, details); };
const text = (value) => String(value ?? "").trim();
const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const serial = (value) => value?.toISOString?.() || value || null;
const decimal = (value) => value === null || value === undefined ? null : receivingDecimalString(receivingDecimalUnits(value));
const decimalDifference = (left, right) => receivingDecimalString(receivingDecimalUnits(left || 0) - receivingDecimalUnits(right || 0));
const version = (value) => {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) fail("PURCHASE_ORDER_VERSION_INVALID", "expectedVersion must be a non-negative integer.", 422);
  return parsed;
};

function databaseEnabled(env) {
  return true;
}

function mapLine(line = {}, includePrices = true) {
  return {
    id: line.id,
    purchaseOrderLineId: line.id,
    itemId: line.itemId,
    sku: line.sku,
    itemName: line.itemName,
    quantity: decimal(line.orderedQuantity),
    orderedQuantity: decimal(line.orderedQuantity),
    receivedQuantity: decimal(line.receivedQuantity),
    remainingQuantity: decimalDifference(line.orderedQuantity, line.receivedQuantity),
    unit: line.unit,
    unitPrice: includePrices ? decimal(line.unitPrice) : null,
    amount: includePrices ? decimal(line.amount) : null,
  };
}

function mapPurchaseOrder(row, { includePrices = true, includePartner = true } = {}) {
  return {
    id: row.id,
    orderNumber: row.metadata?.orderNumber || row.id,
    status: row.status,
    supplierId: row.supplierId,
    supplierSnapshot: includePartner && (row.supplierId || row.supplierName) ? { id: row.supplierId, supplierName: row.supplierName } : null,
    currency: row.currency,
    totalAmount: includePrices ? decimal(row.amount) : null,
    amountSummary: includePrices ? { amount: decimal(row.amount), currency: row.currency } : null,
    sourceRequestId: row.sourceRequestId,
    sourceRfqId: row.sourceRfqId,
    expectedDate: serial(row.expectedDate),
    receivingBaseStatus: row.receivingBaseStatus,
    version: row.version,
    lines: (row.lines || []).map((line) => mapLine(line, includePrices)),
    approvalTimeline: Array.isArray(row.metadata?.approvalTimeline) ? row.metadata.approvalTimeline : [],
    metadata: row.metadata || {},
    updatedAt: serial(row.updatedAt),
  };
}

export function createDbProcurementCommandService({ prisma, env = process.env, idFactory = randomUUID, now = () => new Date(), faultInjection } = {}) {
  const db = async () => prisma || getPrismaClient(env);
  const inject = async (stage) => {
    const requested = text(faultInjection || env.FLOWCHAIN_TEST_FAULT_INJECTION);
    if (requested === stage) fail("PROCUREMENT_FAULT_INJECTED", `Fault injected at ${stage}.`, 500, { stage });
  };
  const actorFor = async (client, context, permission) => {
    const actor = await resolveProvisionedActor(client, context?.identity || context);
    assertAuthorized({ actor, permission, tenantId: actor.tenantId });
    return actor;
  };

  async function readPurchaseOrder(id, context, options = {}) {
    databaseEnabled(env);
    const client = await db();
    const actor = await actorFor(client, context, "procurement.purchase_order.read");
    const row = await client.purchaseOrder.findFirst({ where: { id: text(id), tenantId: actor.tenantId }, include: { lines: true } });
    if (!row) fail("PURCHASE_ORDER_NOT_FOUND", "Purchase order was not found.", 404);
    return mapPurchaseOrder(row, options);
  }

  async function listPurchaseOrdersForApproval(context, options = {}) {
    databaseEnabled(env);
    const client = await db();
    const actor = await actorFor(client, context, "procurement.purchase_order.read");
    const rows = await client.purchaseOrder.findMany({ where: { tenantId: actor.tenantId, status: PURCHASE_ORDER_STATUS.PENDING_APPROVAL }, include: { lines: true }, orderBy: [{ updatedAt: "desc" }, { id: "asc" }], take: Math.min(200, Math.max(1, Number(options.limit || 100))) });
    return rows.map((row) => mapPurchaseOrder(row, options));
  }

  async function executeAction(id, action, input = {}, context) {
    databaseEnabled(env);
    const client = await db();
    const permission = action === "approve" ? "procurement.purchase_order.approve" : action === "reject" ? "procurement.purchase_order.reject" : "procurement.purchase_order.revise";
    const initial = await actorFor(client, context, permission);
    const key = text(input.idempotencyKey);
    if (!key) fail("IDEMPOTENCY_KEY_REQUIRED", "idempotencyKey is required.", 422);
    const expectedVersion = version(input.expectedVersion);
    if (["reject", "return_for_revision"].includes(action) && !text(input.reason)) fail("PO_ACTION_REASON_REQUIRED", "A reason is required.", 422);
    const commandType = `purchase_order.${action}`;
    const payload = { id: text(id), action, expectedVersion, reason: text(input.reason), sourceDeviceId: text(input.sourceDeviceId) || null };
    const requestHash = hash(payload);
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
      const execution = await tx.businessCommandExecution.create({ data: { id: idFactory(), tenantId: actor.tenantId, commandType, idempotencyKey: key, requestHash, status: "pending", entityType: "PurchaseOrder", entityId: text(id) } });
      await tx.$queryRawUnsafe('SELECT "id" FROM "PurchaseOrder" WHERE "tenantId" = $1 AND "id" = $2 FOR UPDATE', actor.tenantId, text(id));
      const row = await tx.purchaseOrder.findFirst({ where: { id: text(id), tenantId: actor.tenantId }, include: { lines: true } });
      if (!row) fail("PURCHASE_ORDER_NOT_FOUND", "Purchase order was not found.", 404);
      if (row.version !== expectedVersion) fail("SYNC_VERSION_CONFLICT", "Purchase order changed concurrently.", 409, { entityId: row.id, expectedVersion, currentVersion: row.version, conflictFields: ["version", "status"], availableActions: ["reload"], serverTime: serial(now()) });
      if (row.status !== PURCHASE_ORDER_STATUS.PENDING_APPROVAL) fail("PURCHASE_ORDER_WORKFLOW_CONFLICT", `Purchase order cannot be ${action}ed from ${row.status}.`, 409);
      const nextStatus = action === "approve" ? PURCHASE_ORDER_STATUS.APPROVED : action === "reject" ? PURCHASE_ORDER_STATUS.REJECTED : PURCHASE_ORDER_STATUS.DRAFT;
      const timeline = [...(Array.isArray(row.metadata?.approvalTimeline) ? row.metadata.approvalTimeline : []), { action, actorId: actor.user.id, at: serial(now()), reason: text(input.reason) || null }];
      const updated = await tx.purchaseOrder.update({ where: { id: row.id }, data: { status: nextStatus, receivingBaseStatus: action === "approve" ? PURCHASE_ORDER_STATUS.APPROVED : row.receivingBaseStatus, version: { increment: 1 }, metadata: { ...(row.metadata || {}), approvalTimeline: timeline, lastApprovalAction: action, lastApprovalActorId: actor.user.id, lastApprovalReason: text(input.reason) || null, sourceDeviceId: text(input.sourceDeviceId) || null } }, include: { lines: true } });
      await inject("after_po_update");
      const result = { entityType: "PurchaseOrder", entityId: updated.id, status: updated.status, entityVersion: updated.version, purchaseOrder: mapPurchaseOrder(updated), pendingSync: false, serverTime: serial(now()) };
      await inject("before_audit");
      await tx.auditLog.create({ data: { id: idFactory(), tenantId: actor.tenantId, actorId: actor.user.id, source: "procurement_db_command_service", module: "procurement", action: `purchase_order_${action}`, entityType: "PurchaseOrder", entityId: updated.id, summary: `${action} purchase order ${updated.id}.`, metadata: { commandType, idempotencyKey: key, expectedVersion, reason: text(input.reason) || null, sourceDeviceId: text(input.sourceDeviceId) || null } } });
      await inject("before_change_feed");
      await tx.domainChangeFeed.create({ data: { tenantId: actor.tenantId, entityType: "PurchaseOrder", entityId: updated.id, operation: "upsert", entityVersion: updated.version, actorId: actor.user.id, source: "procurement_db_command_service", requestId: key, payloadHash: hash({ id: updated.id, version: updated.version, status: updated.status }), sensitivityGroups: ["procurement_prices", "finance_partner_snapshot"], moduleKey: "procurement", authorizationClass: "procurement.purchase_order.read", resourceTenantId: actor.tenantId } });
      await inject("before_commit");
      await tx.businessCommandExecution.update({ where: { id: execution.id }, data: { status: "completed", entityType: "PurchaseOrder", entityId: updated.id, resultPayload: result, completedAt: now() } });
      return { ...result, idempotentReplay: false };
      }, { isolationLevel: "Serializable", maxWait: 10_000, timeout: 30_000 });
    } catch (error) {
      // A concurrent device may win the idempotency unique key between the
      // preflight read and transaction. Return its committed result.
      if (error?.code === "P2002") {
        const committed = replay(await client.businessCommandExecution.findUnique({ where }));
        if (committed) return committed;
      }
      throw error;
    }
  }

  return {
    readPurchaseOrder,
    listPurchaseOrdersForApproval,
    approvePurchaseOrder: (id, input, context) => executeAction(id, "approve", input, context),
    rejectPurchaseOrder: (id, input, context) => executeAction(id, "reject", input, context),
    returnPurchaseOrderForRevision: (id, input, context) => executeAction(id, "return_for_revision", input, context),
  };
}
