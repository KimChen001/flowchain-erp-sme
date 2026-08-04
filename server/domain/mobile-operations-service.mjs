import { createHash, randomUUID } from "node:crypto";
import { assertAuthorized, can } from "../auth/authorization-service.mjs";
import { assertWarehouseAccess, resolveProvisionedActor } from "./pilot-identity.mjs";
import { createReceivingPostingCommandService, ReceivingCommandError } from "./receiving-posting-command-service.mjs";
import { createReceivingWorkbenchQueryService } from "./receiving-workbench-query-service.mjs";
import { capabilityForEnvironment } from "./capability-registry.mjs";
import { PURCHASE_ORDER_STATUS, RECEIVABLE_PURCHASE_ORDER_INPUTS, RECEIVING_POSTING_STATUS, RECEIVING_WORKFLOW_STATUS } from "./procurement-status-authority.mjs";
import { receivingDecimalString, receivingDecimalUnits } from "./receiving-transaction-policy.mjs";

export class MobileOperationsError extends Error {
  constructor(code, message, status = 400, details) { super(message); this.name = "MobileOperationsError"; this.code = code; this.status = status; this.details = details; }
}
const fail = (code, message, status = 400, details) => { throw new MobileOperationsError(code, message, status, details); };
const text = (value) => String(value ?? "").trim();
const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const serial = (value) => value?.toISOString?.() || value || null;
const decimal = (value) => receivingDecimalString(receivingDecimalUnits(value || 0));
const quantityUnits = (value, label) => { try { return receivingDecimalUnits(value || 0); } catch (error) { fail("RECEIVING_VALIDATION_FAILED", `${label}: ${error.message}`, 422); } };

export function createMobileOperationsService({ prisma, procurementAuthority, env = process.env, idFactory = randomUUID, now = () => new Date() } = {}) {
  if (!prisma) throw new Error("prisma is required");
  const actorFor = (context) => resolveProvisionedActor(prisma, context?.identity || context);
  const requireProcurementAuthority = () => {
    if (!procurementAuthority) fail("PROCUREMENT_DATABASE_AUTHORITY_REQUIRED", "Mobile procurement requires the PostgreSQL command authority.", 409);
  };
  const receivingCommand = createReceivingPostingCommandService({ prisma, env });
  const receivingRead = createReceivingWorkbenchQueryService({ prisma, capabilities: { posting: capabilityForEnvironment("receiving-posting", env), reversal: capabilityForEnvironment("receiving-reversal", env) } });
  const fieldVisibility = (actor) => ({ finance_amounts: { visible: actor.permissionCodes.has("finance.amounts.read") }, finance_partner_snapshot: { visible: actor.permissionCodes.has("finance.partner_snapshot.read") }, procurement_prices: { visible: actor.permissionCodes.has("procurement.prices.read") } });
  const task = (value, actor) => ({ priority: "normal", dueAt: null, status: "open", evidenceSummary: [], limitations: [], updatedAt: serial(now()), ...value, fieldVisibility: fieldVisibility(actor) });

  async function listTasks(context) {
    const actor = await actorFor(context); assertAuthorized({ actor, permission: "mobile.tasks.read", tenantId: actor.tenantId });
    const tasks = [];
    if (can({ actor, permission: "mobile.procurement.approval.read", tenantId: actor.tenantId }) && can({ actor, permission: "procurement.purchase_order.read", tenantId: actor.tenantId })) {
      requireProcurementAuthority();
      if (procurementAuthority) {
        const rows = await procurementAuthority.listPurchaseOrdersForApproval(context, { includePrices: actor.permissionCodes.has("procurement.prices.read"), includePartner: actor.permissionCodes.has("finance.partner_snapshot.read") });
        for (const po of rows.filter((row) => row.status === PURCHASE_ORDER_STATUS.PENDING_APPROVAL)) tasks.push(task({ taskId: `purchase_order_approval:${po.id}`, taskType: "purchase_order_approval", entityType: "PurchaseOrder", entityId: po.id, title: `Purchase order ${po.orderNumber || po.id}`, summary: text(po.supplierSnapshot?.supplierName || po.supplierId), amountSummary: actor.permissionCodes.has("procurement.prices.read") ? { amount: po.totalAmount, currency: po.currency } : null, availableActions: can({ actor, permission: "mobile.procurement.approval.execute", tenantId: actor.tenantId }) && can({ actor, permission: "procurement.purchase_order.approve", tenantId: actor.tenantId }) ? ["approve", "reject", "return_for_revision"] : [], entityVersion: po.version, deepLink: `/app/mobile/purchase-orders/${encodeURIComponent(po.id)}` }, actor));
      }
    }
    if (can({ actor, permission: "finance.settlement.read", tenantId: actor.tenantId })) {
      const settlements = await prisma.settlementDocument.findMany({ where: { tenantId: actor.tenantId, workflowStatus: { in: ["submitted", "approved"] } }, orderBy: { updatedAt: "desc" } });
      for (const row of settlements) { const approval = row.workflowStatus === "submitted"; const permission = approval ? "finance.settlement.approve" : "finance.settlement.post"; if (!actor.permissionCodes.has(permission)) continue; tasks.push(task({ taskId: `${approval ? "settlement_approval" : "settlement_posting"}:${row.id}`, taskType: approval ? "settlement_approval" : "settlement_posting", entityType: "SettlementDocument", entityId: row.id, title: `Settlement ${row.settlementNumber}`, summary: actor.permissionCodes.has("finance.partner_snapshot.read") ? row.counterpartyNameSnapshot : null, amountSummary: actor.permissionCodes.has("finance.amounts.read") ? { amount: decimal(row.cashAmount), currency: row.currency } : null, availableActions: approval ? ["approve", "reject"] : ["preview", "post"], entityVersion: row.version, deepLink: `/app/mobile/settlements/${encodeURIComponent(row.id)}` }, actor)); }
    }
    if (can({ actor, permission: "finance.internal_transfer.read", tenantId: actor.tenantId }) && can({ actor, permission: "finance.internal_transfer.approve", tenantId: actor.tenantId })) {
      const transfers = await prisma.internalTransferDocument.findMany({ where: { tenantId: actor.tenantId, workflowStatus: "submitted" } });
      for (const row of transfers) tasks.push(task({ taskId: `internal_transfer_approval:${row.id}`, taskType: "internal_transfer_approval", entityType: "InternalTransferDocument", entityId: row.id, title: `Internal transfer ${row.transferNumber}`, summary: `${row.fromCashbookAccountId} -> ${row.toCashbookAccountId}`, amountSummary: actor.permissionCodes.has("finance.amounts.read") ? { amount: decimal(row.amount), currency: row.currency } : null, availableActions: ["approve", "reject"], entityVersion: row.version, deepLink: `/app/mobile/tasks/internal_transfer_approval:${row.id}` }, actor));
    }
    if (capabilityForEnvironment("bank-statement-reconciliation", env)?.enabled && can({ actor, permission: "finance.bank_reconciliation.read", tenantId: actor.tenantId })) {
      const exceptions = await prisma.bankReconciliationException.findMany({ where: { tenantId: actor.tenantId, status: "open" }, orderBy: { detectedAt: "desc" }, take: 50 });
      for (const row of exceptions) tasks.push(task({ taskId: `bank_reconciliation_exception:${row.id}`, taskType: "bank_reconciliation_exception", entityType: "BankReconciliationException", entityId: row.id, title: "Bank reconciliation evidence exception", summary: row.exceptionType, amountSummary: null, availableActions: [], deepLink: `/app/finance/bank-reconciliation?exception=${encodeURIComponent(row.id)}`, evidenceSummary: [row.severity, row.exceptionType], limitations: ["Read-only on mobile", "Open the desktop workbench to resolve"] }, actor));
    }
    return { items: tasks, total: tasks.length, serverTime: serial(now()) };
  }
  async function taskDetail(taskId, context) { const result = await listTasks(context), item = result.items.find((row) => row.taskId === text(taskId)); if (!item) fail("MOBILE_TASK_NOT_FOUND", "Task was not found or is no longer authorized.", 404); return item; }

  async function purchaseOrderDetail(id, context) {
    const actor = await actorFor(context); assertAuthorized({ actor, permission: "mobile.procurement.approval.read", tenantId: actor.tenantId }); assertAuthorized({ actor, permission: "procurement.purchase_order.read", tenantId: actor.tenantId });
    requireProcurementAuthority();
    const po = await procurementAuthority.readPurchaseOrder(text(id), context, { includePrices: actor.permissionCodes.has("procurement.prices.read"), includePartner: actor.permissionCodes.has("finance.partner_snapshot.read") });
    if (!po) fail("PURCHASE_ORDER_NOT_FOUND", "Purchase order was not found.", 404);
    const prices = actor.permissionCodes.has("procurement.prices.read"), partner = actor.permissionCodes.has("finance.partner_snapshot.read");
    return { id: po.id, orderNumber: po.orderNumber || po.id, status: po.status, supplierSnapshot: partner ? po.supplierSnapshot || { id: po.supplierId } : null, lines: (po.lines || []).map((line) => ({ ...line, unitPrice: prices ? line.unitPrice : null, amount: prices ? line.amount ?? null : null })), amountSummary: prices ? { totalAmount: po.totalAmount, currency: po.currency } : null, sourceRequestId: po.sourcePrId, sourceRfqId: po.sourceRfqId, deliveryTerms: po.deliveryTerms || null, approvalTimeline: po.auditTrailIds || [], attachments: po.attachments || [], entityVersion: po.version, availableActions: po.status === PURCHASE_ORDER_STATUS.PENDING_APPROVAL && actor.permissionCodes.has("mobile.procurement.approval.execute") && actor.permissionCodes.has("procurement.purchase_order.approve") ? ["approve", "reject", "return_for_revision"] : [], fieldVisibility: fieldVisibility(actor), limitations: [], deepLink: `/app/mobile/purchase-orders/${encodeURIComponent(po.id)}` };
  }
  async function actOnPurchaseOrder(id, action, input, context) {
    const actor = await actorFor(context); assertAuthorized({ actor, permission: "mobile.procurement.approval.execute", tenantId: actor.tenantId }); const formalPermission = action === "approve" ? "procurement.purchase_order.approve" : action === "reject" ? "procurement.purchase_order.reject" : "procurement.purchase_order.revise"; assertAuthorized({ actor, permission: formalPermission, tenantId: actor.tenantId });
    requireProcurementAuthority();
    if (procurementAuthority) {
      const command = action === "approve" ? "approvePurchaseOrder" : action === "reject" ? "rejectPurchaseOrder" : "returnPurchaseOrderForRevision";
      return procurementAuthority[command](text(id), input, context);
    }
    fail("MOBILE_PO_NOT_AVAILABLE", "The PostgreSQL procurement command authority did not handle this action.", 409);
  }

  async function searchReceivingPurchaseOrders(search, context) {
    const actor = await actorFor(context); assertAuthorized({ actor, permission: "mobile.receiving.read", tenantId: actor.tenantId }); assertAuthorized({ actor, permission: "receiving.read", tenantId: actor.tenantId });
    const value = text(search); const rows = await prisma.purchaseOrder.findMany({ where: { tenantId: actor.tenantId, status: { in: [...RECEIVABLE_PURCHASE_ORDER_INPUTS] }, ...(value ? { id: { contains: value, mode: "insensitive" } } : {}) }, include: { lines: true }, take: 50, orderBy: { updatedAt: "desc" } });
    const warehouseWhere = actor.allWarehouses ? { tenantId: actor.tenantId, status: "active" } : { tenantId: actor.tenantId, status: "active", id: { in: [...(actor.operateWarehouseIds || [])] } };
    const warehouses = await prisma.warehouse.findMany({ where: warehouseWhere, orderBy: { code: "asc" }, select: { id: true, code: true, name: true } });
    return { items: rows.map((po) => ({ id: po.id, status: po.status, supplierName: actor.permissionCodes.has("finance.partner_snapshot.read") ? po.supplierName : null, currency: po.currency, lines: po.lines.map((line) => ({ id: line.id, sku: line.sku, itemName: line.itemName, orderedQuantity: decimal(line.orderedQuantity), receivedQuantity: decimal(line.receivedQuantity), remainingQuantity: receivingDecimalString(quantityUnits(line.orderedQuantity, "orderedQuantity") - quantityUnits(line.receivedQuantity, "receivedQuantity")), unit: line.unit })) })), total: rows.length, warehouses };
  }
  async function createReceivingDraft(input, context) {
    const actor = await actorFor(context); assertAuthorized({ actor, permission: "mobile.receiving.prepare", tenantId: actor.tenantId }); assertAuthorized({ actor, permission: "receiving.prepare", tenantId: actor.tenantId });
    const warehouseIds = [...new Set([text(input.warehouseId), ...(input.lines || []).map((line) => text(line.warehouseId || input.warehouseId))].filter(Boolean))]; assertWarehouseAccess(actor, warehouseIds, "operate");
    const key = text(input.idempotencyKey); if (!key) fail("IDEMPOTENCY_KEY_REQUIRED", "idempotencyKey is required.", 422); const commandType = "mobile.receiving.create", requestHash = digest(input), where = { tenantId_commandType_idempotencyKey: { tenantId: actor.tenantId, commandType, idempotencyKey: key } };
    const prior = await prisma.businessCommandExecution.findUnique({ where }); if (prior) { if (prior.requestHash !== requestHash) fail("IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD", "The idempotency key was reused with another payload.", 409); return { ...prior.resultPayload, idempotentReplay: true }; }
    return prisma.$transaction(async (tx) => {
      const po = await tx.purchaseOrder.findFirst({ where: { id: text(input.poId), tenantId: actor.tenantId }, include: { lines: true } }); if (!po) fail("PURCHASE_ORDER_NOT_FOUND", "Purchase order was not found.", 404);
      const poLines = new Map(po.lines.map((line) => [line.id, line])), lines = [];
      for (const value of input.lines || []) { const source = poLines.get(text(value.purchaseOrderLineId)); if (!source) fail("RECEIVING_LINE_INVALID", "Each receiving line must reference the selected PO.", 422); const accepted = quantityUnits(value.acceptedQuantity || value.acceptedQty || 0, "acceptedQuantity"), damaged = quantityUnits(value.damagedQuantity || 0, "damagedQuantity"), rejected = quantityUnits(value.rejectedQuantity || value.rejectedQty || 0, "rejectedQuantity"), remaining = quantityUnits(source.orderedQuantity, "orderedQuantity") - quantityUnits(source.receivedQuantity, "receivedQuantity"); if (accepted <= 0n || damaged < 0n || rejected < 0n || accepted > remaining) fail("RECEIVING_OVER_RECEIPT", "Accepted quantity exceeds the PO remaining quantity.", 409, { purchaseOrderLineId: source.id, remainingQuantity: receivingDecimalString(remaining) }); lines.push({ id: idFactory(), purchaseOrderLineId: source.id, itemId: source.itemId, sku: source.sku, itemName: source.itemName, acceptedQty: receivingDecimalString(accepted), rejectedQty: receivingDecimalString(rejected), unit: source.unit, warehouseId: text(value.warehouseId || input.warehouseId), location: text(value.location), locationKey: text(value.location).toLowerCase(), metadata: { damagedQuantity: receivingDecimalString(damaged), note: text(value.note) } }); }
      if (!lines.length) fail("RECEIVING_LINES_REQUIRED", "At least one receiving line is required.", 422);
      const document = await tx.receivingDocument.create({ data: { id: idFactory(), tenantId: actor.tenantId, documentNumber: text(input.documentNumber) || `GRN-${now().getTime()}`, poId: po.id, supplierId: po.supplierId, supplierName: po.supplierName, status: "receiving", workflowStatus: RECEIVING_WORKFLOW_STATUS.DRAFT, postingStatus: RECEIVING_POSTING_STATUS.UNPOSTED, warehouseId: text(input.warehouseId), receiver: actor.user.name, arrivedAt: input.arrivedAt ? new Date(input.arrivedAt) : now(), currency: po.currency, metadata: { note: text(input.note), clientMutationId: text(input.clientMutationId), sourceDeviceId: text(input.sourceDeviceId) }, lines: { create: lines } } });
      const result = { entityId: document.id, receivingDocument: { id: document.id, documentNumber: document.documentNumber, workflowStatus: document.workflowStatus, postingStatus: document.postingStatus, version: document.version }, pendingSync: false };
      await tx.businessCommandExecution.create({ data: { id: idFactory(), tenantId: actor.tenantId, commandType, idempotencyKey: key, requestHash, status: "completed", entityType: "ReceivingDocument", entityId: document.id, resultPayload: result, completedAt: now() } }); await tx.auditLog.create({ data: { id: idFactory(), tenantId: actor.tenantId, actorId: actor.user.id, source: "mobile_receiving_facade", module: "procurement_receiving", action: "receiving_draft_created", entityType: "ReceivingDocument", entityId: document.id, summary: `Created receiving draft ${document.documentNumber}.`, metadata: { poId: po.id } } }); await tx.domainChangeFeed.create({ data: { tenantId: actor.tenantId, entityType: "ReceivingDocument", entityId: document.id, operation: "upsert", entityVersion: document.version, actorId: actor.user.id, source: "mobile_receiving_facade", requestId: key, payloadHash: digest({ id: document.id, version: document.version }), sensitivityGroups: [], moduleKey: "receiving", authorizationClass: "receiving.read", scopeWarehouseIds: [document.warehouseId].filter(Boolean), resourceTenantId: actor.tenantId } });
      return { ...result, idempotentReplay: false };
    }, { isolationLevel: "Serializable" });
  }
  async function reviseReceivingDraft(id, input, context) {
    const actor = await actorFor(context); assertAuthorized({ actor, permission: "mobile.receiving.prepare", tenantId: actor.tenantId }); assertAuthorized({ actor, permission: "receiving.prepare", tenantId: actor.tenantId }); const expected = Number(input.expectedVersion);
    return prisma.$transaction(async (tx) => {
      const row = await tx.receivingDocument.findFirst({ where: { id: text(id), tenantId: actor.tenantId }, include: { lines: true } });
      if (!row) fail("RECEIVING_NOT_FOUND", "Receiving draft was not found.", 404);
      if (row.version !== expected) fail("SYNC_VERSION_CONFLICT", "Receiving draft changed concurrently.", 409, { entityId: row.id, expectedVersion: expected, currentVersion: row.version });
      if (row.workflowStatus !== RECEIVING_WORKFLOW_STATUS.DRAFT || row.postingStatus !== RECEIVING_POSTING_STATUS.UNPOSTED) fail("RECEIVING_IMMUTABLE", "Submitted or posted receiving documents cannot be revised.", 409);
      const warehouseIds = [...new Set([row.warehouseId, ...(input.lines || []).map((line) => text(line.warehouseId || row.warehouseId))].filter(Boolean))];
      assertWarehouseAccess(actor, warehouseIds, "operate");
      await tx.receivingLine.deleteMany({ where: { receivingDocumentId: row.id } });
      const po = await tx.purchaseOrder.findFirst({ where: { id: row.poId, tenantId: actor.tenantId }, include: { lines: true } });
      const poLines = new Map(po.lines.map((line) => [line.id, line]));
      const lines = (input.lines || []).map((value) => {
        const source = poLines.get(text(value.purchaseOrderLineId));
        if (!source) fail("RECEIVING_LINE_INVALID", "Receiving line is not on the selected PO.", 422);
        const accepted = quantityUnits(value.acceptedQuantity || value.acceptedQty || 0, "acceptedQuantity");
        const remaining = quantityUnits(source.orderedQuantity, "orderedQuantity") - quantityUnits(source.receivedQuantity, "receivedQuantity");
        if (accepted <= 0n || accepted > remaining) fail("RECEIVING_OVER_RECEIPT", "Accepted quantity exceeds remaining quantity.", 409);
        return { id: idFactory(), receivingDocumentId: row.id, purchaseOrderLineId: source.id, itemId: source.itemId, sku: source.sku, itemName: source.itemName, acceptedQty: receivingDecimalString(accepted), rejectedQty: decimal(value.rejectedQuantity || 0), unit: source.unit, warehouseId: text(value.warehouseId || row.warehouseId), location: text(value.location), locationKey: text(value.location).toLowerCase(), metadata: { damagedQuantity: decimal(value.damagedQuantity || 0), note: text(value.note) } };
      });
      if (!lines.length) fail("RECEIVING_LINES_REQUIRED", "At least one receiving line is required.", 422);
      await tx.receivingLine.createMany({ data: lines });
      const updated = await tx.receivingDocument.update({ where: { id: row.id }, data: { metadata: { ...row.metadata, note: text(input.note), clientMutationId: text(input.clientMutationId), sourceDeviceId: text(input.sourceDeviceId) }, version: { increment: 1 } } });
      await tx.domainChangeFeed.create({ data: { tenantId: actor.tenantId, entityType: "ReceivingDocument", entityId: row.id, operation: "upsert", entityVersion: updated.version, actorId: actor.user.id, source: "mobile_receiving_facade", requestId: text(input.clientMutationId) || null, payloadHash: digest({ id: row.id, version: updated.version }), sensitivityGroups: [] } });
      return { entityId: row.id, receivingDocument: { id: row.id, documentNumber: row.documentNumber, workflowStatus: updated.workflowStatus, postingStatus: updated.postingStatus, version: updated.version } };
    }, { isolationLevel: "Serializable" });
  }
  async function submitReceivingDraft(id, input, context) {
    const actor = await actorFor(context); assertAuthorized({ actor, permission: "mobile.receiving.prepare", tenantId: actor.tenantId }); assertAuthorized({ actor, permission: "receiving.prepare", tenantId: actor.tenantId });
    const expected = Number(input.expectedVersion), key = text(input.idempotencyKey), commandType = "mobile.receiving.submit";
    if (!key) fail("IDEMPOTENCY_KEY_REQUIRED", "idempotencyKey is required.", 422);
    const requestHash = digest({ id: text(id), expectedVersion: expected }), where = { tenantId_commandType_idempotencyKey: { tenantId: actor.tenantId, commandType, idempotencyKey: key } };
    const prior = await prisma.businessCommandExecution.findUnique({ where });
    if (prior) { if (prior.requestHash !== requestHash) fail("IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD", "The idempotency key was reused with another payload.", 409); return { ...prior.resultPayload, idempotentReplay: true }; }
    return prisma.$transaction(async (tx) => {
      await tx.$queryRawUnsafe('SELECT "id" FROM "ReceivingDocument" WHERE "tenantId" = $1 AND "id" = $2 FOR UPDATE', actor.tenantId, text(id));
      const row = await tx.receivingDocument.findFirst({ where: { id: text(id), tenantId: actor.tenantId }, include: { lines: true } });
      if (!row) fail("RECEIVING_NOT_FOUND", "Receiving draft was not found.", 404);
      assertWarehouseAccess(actor, [...new Set([row.warehouseId, ...row.lines.map((line) => line.warehouseId)].filter(Boolean))], "operate");
      if (row.version !== expected) fail("SYNC_VERSION_CONFLICT", "Receiving draft changed concurrently.", 409, { entityId: row.id, expectedVersion: expected, currentVersion: row.version, conflictFields: ["workflowStatus"], availableActions: ["reload"], serverTime: serial(now()) });
      if (row.workflowStatus !== RECEIVING_WORKFLOW_STATUS.DRAFT || row.postingStatus !== RECEIVING_POSTING_STATUS.UNPOSTED) fail("RECEIVING_WORKFLOW_CONFLICT", "Only a draft may be submitted.", 409);
      const execution = await tx.businessCommandExecution.create({ data: { id: idFactory(), tenantId: actor.tenantId, commandType, idempotencyKey: key, requestHash, status: "pending", entityType: "ReceivingDocument", entityId: row.id } });
      const updated = await tx.receivingDocument.update({ where: { id: row.id }, data: { workflowStatus: RECEIVING_WORKFLOW_STATUS.READY_FOR_RECEIVING, version: { increment: 1 } } });
      const result = { entityId: row.id, receivingDocument: { id: row.id, documentNumber: row.documentNumber, workflowStatus: updated.workflowStatus, postingStatus: updated.postingStatus, version: updated.version }, pendingSync: false };
      await tx.auditLog.create({ data: { id: idFactory(), tenantId: actor.tenantId, actorId: actor.user.id, source: "mobile_receiving_facade", module: "procurement_receiving", action: "receiving_submitted", entityType: "ReceivingDocument", entityId: row.id, summary: `Submitted receiving ${row.documentNumber}.`, metadata: { commandExecutionId: execution.id, expectedVersion: expected, sourceDeviceId: text(input.sourceDeviceId) || null } } });
      await tx.domainChangeFeed.create({ data: { tenantId: actor.tenantId, entityType: "ReceivingDocument", entityId: row.id, operation: "upsert", entityVersion: updated.version, actorId: actor.user.id, source: "mobile_receiving_facade", requestId: key, payloadHash: digest({ id: row.id, version: updated.version }), sensitivityGroups: [] } });
      await tx.businessCommandExecution.update({ where: { id: execution.id }, data: { status: "completed", resultPayload: result, completedAt: now() } });
      return { ...result, idempotentReplay: false };
    }, { isolationLevel: "Serializable" });
  }
  async function receivingDetail(id, context) {
    const actor = await actorFor(context);
    assertAuthorized({ actor, permission: "mobile.receiving.read", tenantId: actor.tenantId });
    assertAuthorized({ actor, permission: "receiving.read", tenantId: actor.tenantId });
    const receivingDocumentId = text(id);
    const detail = await receivingRead.getReceivingDetail({ receivingDocumentId }, { identity: context?.identity || context });
    const movements = await prisma.inventoryMovement.findMany({
      where: { tenantId: actor.tenantId, relatedGrnId: receivingDocumentId },
      orderBy: { occurredAt: "asc" },
    });
    return {
      ...detail,
      inventoryImpact: movements.map((movement) => ({
        id: movement.id,
        movementType: movement.movementType,
        sku: movement.sku,
        warehouseId: movement.warehouseId,
        location: movement.location,
        quantityIn: decimal(movement.quantityIn),
        quantityOut: decimal(movement.quantityOut),
        postingBatchId: movement.postingBatchId,
        reversalOfMovementId: movement.reversalOfMovementId,
      })),
    };
  }
  async function previewReceiving(id, context) { const actor = await actorFor(context); assertAuthorized({ actor, permission: "mobile.receiving.post", tenantId: actor.tenantId }); assertAuthorized({ actor, permission: "receiving.post", tenantId: actor.tenantId }); return receivingRead.getReceivingImpactPreview({ receivingDocumentId: text(id), operation: "post" }, { identity: context?.identity || context }); }
  async function postReceiving(id, input, context) { const actor = await actorFor(context); assertAuthorized({ actor, permission: "mobile.receiving.post", tenantId: actor.tenantId }); assertAuthorized({ actor, permission: "receiving.post", tenantId: actor.tenantId }); try { return await receivingCommand.postReceiving({ receivingDocumentId: text(id), idempotencyKey: text(input.idempotencyKey), expectedVersion: input.expectedVersion }, { identity: context?.identity || context }); } catch (error) { if (error instanceof ReceivingCommandError && ["RECEIVING_VERSION_CONFLICT", "RECEIVING_CONCURRENT_POSTING_CONFLICT", "RECEIVING_ALREADY_POSTED"].includes(error.code)) fail("SYNC_VERSION_CONFLICT", error.message, 409, { entityId: text(id), expectedVersion: input.expectedVersion, conflictFields: ["postingStatus"], availableActions: ["reload"], serverTime: serial(now()) }); throw error; } }
  async function receivingEvidence(id, context) { const detail = await receivingDetail(id, context), evidence = await receivingRead.getReceivingEvidenceTimeline({ receivingDocumentId: text(id) }, { identity: context?.identity || context }); return { grn: detail.receivingDocument, inventoryImpact: detail.inventoryImpact, evidence }; }
  return { listTasks, taskDetail, purchaseOrderDetail, actOnPurchaseOrder, searchReceivingPurchaseOrders, createReceivingDraft, reviseReceivingDraft, submitReceivingDraft, receivingDetail, previewReceiving, postReceiving, receivingEvidence };
}
