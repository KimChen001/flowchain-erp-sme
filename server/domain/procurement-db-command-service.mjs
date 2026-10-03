import { createHash, randomUUID } from "node:crypto";
import { assertAuthorized } from "../auth/authorization-service.mjs";
import { getPrismaClient } from "../persistence/prisma-client.mjs";
import { resolveProvisionedActor } from "./pilot-identity.mjs";
import { PURCHASE_ORDER_STATUS } from "./procurement-status-authority.mjs";
import { receivingDecimalString, receivingDecimalUnits } from "./receiving-transaction-policy.mjs";
import { applyPromisedDateChanges, currentPromisedDay, isIssuedPurchaseOrder, promiseDay, recordOriginalPromises } from "./purchase-order-promise-dates.mjs";

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

// Each PO command: the statuses it starts from, the status it leaves, and the
// catalog permission it needs. Drafting commands use "revise" (buyer, manager,
// admin); approval decisions use "approve" and "reject" (manager, admin).
// Cancelling a PO that is already pending or approved needs "reject".
const { DRAFT, PENDING_APPROVAL, APPROVED, ISSUED, PARTIALLY_RECEIVED, CLOSED, CANCELLED } = PURCHASE_ORDER_STATUS;
const PURCHASE_ORDER_COMMANDS = Object.freeze({
  submit: { from: [DRAFT], to: PENDING_APPROVAL, permission: "procurement.purchase_order.revise" },
  approve: { from: [PENDING_APPROVAL], to: APPROVED, permission: "procurement.purchase_order.approve" },
  reject: { from: [PENDING_APPROVAL], to: PURCHASE_ORDER_STATUS.REJECTED, permission: "procurement.purchase_order.reject", reasonRequired: true },
  return_for_revision: { from: [PENDING_APPROVAL], to: DRAFT, permission: "procurement.purchase_order.revise", reasonRequired: true },
  issue: { from: [APPROVED], to: ISSUED, permission: "procurement.purchase_order.revise" },
  cancel: { from: [DRAFT, PENDING_APPROVAL, APPROVED], to: CANCELLED, permission: "procurement.purchase_order.revise", elevatedFrom: { [PENDING_APPROVAL]: "procurement.purchase_order.reject", [APPROVED]: "procurement.purchase_order.reject" } },
  // Short-close: the supplier will not deliver the rest. Received quantities,
  // receipts and invoices stay as they are; nothing more can be received.
  close: { from: [ISSUED, PARTIALLY_RECEIVED], to: CLOSED, permission: "procurement.purchase_order.reject", reasonRequired: true },
});

function mapLine(line = {}, includePrices = true, purchaseOrder = {}) {
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
    // The current expected date, and the date first promised at issue (null
    // when it was not recorded).
    promisedDate: currentPromisedDay(line, purchaseOrder),
    originalPromisedDate: promiseDay(line.originalPromisedDate),
  };
}

const mapPromiseRevision = (row) => ({
  id: row.id,
  purchaseOrderLineId: row.purchaseOrderLineId,
  previousDate: promiseDay(row.previousDate),
  newDate: promiseDay(row.newDate),
  reason: row.reason,
  actorId: row.actorId,
  source: row.source,
  createdAt: serial(row.createdAt),
});

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
    lines: (row.lines || []).map((line) => mapLine(line, includePrices, row)),
    promiseRevisions: (row.lines || []).flatMap((line) => line.promiseRevisions || []).sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id)).map(mapPromiseRevision),
    approvalTimeline: Array.isArray(row.metadata?.approvalTimeline) ? row.metadata.approvalTimeline : [],
    metadata: row.metadata || {},
    updatedAt: serial(row.updatedAt),
  };
}

const LINES_WITH_REVISIONS = { lines: { orderBy: { id: "asc" }, include: { promiseRevisions: { orderBy: [{ createdAt: "asc" }, { id: "asc" }] } } } };

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
    const row = await client.purchaseOrder.findFirst({ where: { id: text(id), tenantId: actor.tenantId }, include: LINES_WITH_REVISIONS });
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

  // Runs one idempotent PO command in a serializable transaction: replays a
  // completed command with the same key, locks and version-checks the PO, then
  // lets execute() change it and writes the audit, change feed and command rows.
  async function runCommand({ id, commandType, permission, input, payload, context, execute }) {
    databaseEnabled(env);
    const client = await db();
    const initial = await actorFor(client, context, permission);
    const key = text(input.idempotencyKey);
    if (!key) fail("IDEMPOTENCY_KEY_REQUIRED", "idempotencyKey is required.", 422);
    const expectedVersion = payload.expectedVersion;
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
      const row = await tx.purchaseOrder.findFirst({ where: { id: text(id), tenantId: actor.tenantId }, include: { lines: { orderBy: { id: "asc" } } } });
      if (!row) fail("PURCHASE_ORDER_NOT_FOUND", "Purchase order was not found.", 404);
      if (row.version !== expectedVersion) fail("SYNC_VERSION_CONFLICT", "Purchase order changed concurrently.", 409, { entityId: row.id, expectedVersion, currentVersion: row.version, conflictFields: ["version", "status"], availableActions: ["reload"], serverTime: serial(now()) });
      const audit = await execute(tx, actor, row);
      const updated = await tx.purchaseOrder.findFirst({ where: { id: row.id, tenantId: actor.tenantId }, include: LINES_WITH_REVISIONS });
      await inject("after_po_update");
      const result = { entityType: "PurchaseOrder", entityId: updated.id, status: updated.status, entityVersion: updated.version, purchaseOrder: mapPurchaseOrder(updated), pendingSync: false, serverTime: serial(now()) };
      await inject("before_audit");
      await tx.auditLog.create({ data: { id: idFactory(), tenantId: actor.tenantId, actorId: actor.user.id, source: "procurement_db_command_service", module: "procurement", action: audit.action, entityType: "PurchaseOrder", entityId: updated.id, summary: audit.summary, metadata: { commandType, idempotencyKey: key, expectedVersion, ...audit.metadata } } });
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

  async function executeAction(id, action, input = {}, context) {
    const command = PURCHASE_ORDER_COMMANDS[action];
    if (!command) fail("PURCHASE_ORDER_ACTION_UNSUPPORTED", `Unsupported purchase order action: ${action}.`, 400);
    const permission = command.permission;
    await actorFor(await db(), context, permission);
    if (!text(input.idempotencyKey)) fail("IDEMPOTENCY_KEY_REQUIRED", "idempotencyKey is required.", 422);
    const expectedVersion = version(input.expectedVersion);
    if (command.reasonRequired && !text(input.reason)) fail("PO_ACTION_REASON_REQUIRED", "A reason is required.", 422);
    return runCommand({
      id,
      commandType: `purchase_order.${action}`,
      permission,
      input,
      context,
      payload: { id: text(id), action, expectedVersion, reason: text(input.reason), sourceDeviceId: text(input.sourceDeviceId) || null },
      execute: async (tx, actor, row) => {
        if (!command.from.includes(row.status)) fail("PURCHASE_ORDER_WORKFLOW_CONFLICT", `A ${row.status} purchase order cannot take the ${action} action.`, 409, { entityId: row.id, currentStatus: row.status, currentVersion: row.version });
        const elevated = command.elevatedFrom?.[row.status];
        if (elevated) assertAuthorized({ actor, permission: elevated, tenantId: actor.tenantId });
        if (action === "cancel" || action === "close") {
          // A receipt still being prepared against the PO would become unpostable.
          const openReceipt = await tx.receivingDocument.findFirst({ where: { tenantId: actor.tenantId, poId: row.id, postingStatus: "unposted", workflowStatus: { not: "cancelled" } }, select: { id: true, documentNumber: true } });
          if (openReceipt) fail("PURCHASE_ORDER_HAS_OPEN_RECEIPTS", `Cancel or post receipt ${openReceipt.documentNumber || openReceipt.id}, which is still being prepared for this purchase order, first.`, 409, { receivingDocumentId: openReceipt.id });
        }
        // What was still open when the PO was closed, for the audit and the PO.
        const closedOpenQuantities = action === "close"
          ? row.lines.map((line) => ({ purchaseOrderLineId: line.id, sku: line.sku, openQuantity: decimalDifference(line.orderedQuantity, line.receivedQuantity) })).filter((line) => receivingDecimalUnits(line.openQuantity) > 0n)
          : [];
        const closed = action === "close" ? { closedAt: serial(now()), closedById: actor.user.id, closeReason: text(input.reason), closedOpenQuantities } : {};
        const nextStatus = command.to;
        const timeline = [...(Array.isArray(row.metadata?.approvalTimeline) ? row.metadata.approvalTimeline : []), { action, actorId: actor.user.id, at: serial(now()), reason: text(input.reason) || null }];
        // Receiving restores receivingBaseStatus when a receipt is reversed.
        const receivingBaseStatus = [APPROVED, ISSUED].includes(nextStatus) ? nextStatus : row.receivingBaseStatus;
        // FlowChain records the issue; the buyer sends the PO to the supplier.
        const issued = action === "issue" ? { transmissionStatus: "issued_outside_flowchain", issuedAt: serial(now()), issuedById: actor.user.id } : {};
        // Issuing fixes each dated line's original promise, which supplier
        // scorecards measure against.
        const originalPromisesRecorded = action === "issue" ? await recordOriginalPromises(tx, { purchaseOrder: row }) : [];
        await tx.purchaseOrder.update({ where: { id: row.id }, data: { status: nextStatus, receivingBaseStatus, version: { increment: 1 }, metadata: { ...(row.metadata || {}), ...issued, ...closed, approvalTimeline: timeline, lastApprovalAction: action, lastApprovalActorId: actor.user.id, lastApprovalReason: text(input.reason) || null, sourceDeviceId: text(input.sourceDeviceId) || null } } });
        return { action: `purchase_order_${action}`, summary: `${action} purchase order ${row.id}.`, metadata: { reason: text(input.reason) || null, sourceDeviceId: text(input.sourceDeviceId) || null, ...(action === "issue" ? { originalPromisesRecorded } : {}), ...(action === "close" ? { closedOpenQuantities } : {}) } };
      },
    });
  }

  // Changes promised dates on lines of an issued PO. Each changed line gets a
  // revision row and an audit row (purchase-order-promise-dates.mjs); the PO
  // gets the usual command audit row.
  async function revisePromisedDates(id, input = {}, context) {
    const permission = "procurement.purchase_order.revise";
    await actorFor(await db(), context, permission);
    if (!text(input.idempotencyKey)) fail("IDEMPOTENCY_KEY_REQUIRED", "idempotencyKey is required.", 422);
    const expectedVersion = version(input.expectedVersion);
    const changes = (Array.isArray(input.lines) ? input.lines : []).map((line) => ({ purchaseOrderLineId: text(line?.purchaseOrderLineId), promisedDate: text(line?.promisedDate) }));
    if (!changes.length) fail("PROMISED_DATE_CHANGES_REQUIRED", "Choose at least one line and a new promised date.", 422, [{ field: "lines" }]);
    if (!text(input.reason)) fail("PROMISE_REVISION_REASON_REQUIRED", "Give a reason for changing the promised date.", 422, [{ field: "reason" }]);
    return runCommand({
      id,
      commandType: "purchase_order.revise_promised_dates",
      permission,
      input,
      context,
      payload: { id: text(id), expectedVersion, lines: changes, reason: text(input.reason) },
      execute: async (tx, actor, row) => {
        if (!isIssuedPurchaseOrder(row)) fail("PURCHASE_ORDER_NOT_ISSUED", "Promised dates are revised on issued purchase orders.", 409, { entityId: row.id, currentStatus: row.status });
        const outcome = await applyPromisedDateChanges(tx, { tenantId: actor.tenantId, purchaseOrder: row, changes, reason: input.reason, actorId: actor.user.id, source: "procurement_db_command_service", at: now(), idFactory });
        if (!outcome.revisions.length) fail("PROMISED_DATE_UNCHANGED", "The lines already have these promised dates.", 422, [{ field: "lines" }]);
        return { action: "purchase_order_promised_dates_revised", summary: `Revised promised dates on ${outcome.revisions.length} line(s) of purchase order ${row.id}.`, metadata: { reason: text(input.reason), revisionIds: outcome.revisions.map((revision) => revision.id), originalPromisesRecorded: outcome.originalPromisesRecorded } };
      },
    });
  }

  return {
    readPurchaseOrder,
    listPurchaseOrdersForApproval,
    submitPurchaseOrder: (id, input, context) => executeAction(id, "submit", input, context),
    approvePurchaseOrder: (id, input, context) => executeAction(id, "approve", input, context),
    issuePurchaseOrder: (id, input, context) => executeAction(id, "issue", input, context),
    cancelPurchaseOrder: (id, input, context) => executeAction(id, "cancel", input, context),
    closePurchaseOrder: (id, input, context) => executeAction(id, "close", input, context),
    rejectPurchaseOrder: (id, input, context) => executeAction(id, "reject", input, context),
    returnPurchaseOrderForRevision: (id, input, context) => executeAction(id, "return_for_revision", input, context),
    revisePromisedDates,
  };
}
