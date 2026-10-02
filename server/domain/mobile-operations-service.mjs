import { isUnavailableProductRoute } from "../../shared/unavailable-product-routes.mjs";
import { randomUUID } from "node:crypto";
import { assertAuthorized, can } from "../auth/authorization-service.mjs";
import { resolveProvisionedActor } from "./pilot-identity.mjs";
import { createReceivingPostingCommandService, ReceivingCommandError } from "./receiving-posting-command-service.mjs";
import { createReceivingWorkbenchQueryService } from "./receiving-workbench-query-service.mjs";
import { createReceivingDraftCommandService, RECEIVING_DRAFT_CHANNELS } from "./receiving-draft-command-service.mjs";
import { capabilityForEnvironment } from "./capability-registry.mjs";
import { PURCHASE_ORDER_STATUS } from "./procurement-status-authority.mjs";
import { receivingDecimalString, receivingDecimalUnits } from "./receiving-transaction-policy.mjs";

export class MobileOperationsError extends Error {
  constructor(code, message, status = 400, details) { super(message); this.name = "MobileOperationsError"; this.code = code; this.status = status; this.details = details; }
}
const fail = (code, message, status = 400, details) => { throw new MobileOperationsError(code, message, status, details); };
const text = (value) => String(value ?? "").trim();
const serial = (value) => value?.toISOString?.() || value || null;
const decimal = (value) => receivingDecimalString(receivingDecimalUnits(value || 0));

export function createMobileOperationsService({ prisma, procurementAuthority, env = process.env, idFactory = randomUUID, now = () => new Date() } = {}) {
  if (!prisma) throw new Error("prisma is required");
  const actorFor = (context) => resolveProvisionedActor(prisma, context?.identity || context);
  const requireProcurementAuthority = () => {
    if (!procurementAuthority) fail("PROCUREMENT_DATABASE_AUTHORITY_REQUIRED", "Mobile procurement requires the PostgreSQL command authority.", 409);
  };
  const receivingCommand = createReceivingPostingCommandService({ prisma, env });
  const receivingDrafts = createReceivingDraftCommandService({ prisma, idFactory, now });
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
    // Settlements and internal transfers belong to the frozen settlement workflow
    // and cashbook; they are not offered as mobile tasks.
    if (!isUnavailableProductRoute("mobile-operations:settlement-detail") && can({ actor, permission: "finance.settlement.read", tenantId: actor.tenantId })) {
      const settlements = await prisma.settlementDocument.findMany({ where: { tenantId: actor.tenantId, workflowStatus: { in: ["submitted", "approved"] } }, orderBy: { updatedAt: "desc" } });
      for (const row of settlements) { const approval = row.workflowStatus === "submitted"; const permission = approval ? "finance.settlement.approve" : "finance.settlement.post"; if (!actor.permissionCodes.has(permission)) continue; tasks.push(task({ taskId: `${approval ? "settlement_approval" : "settlement_posting"}:${row.id}`, taskType: approval ? "settlement_approval" : "settlement_posting", entityType: "SettlementDocument", entityId: row.id, title: `Settlement ${row.settlementNumber}`, summary: actor.permissionCodes.has("finance.partner_snapshot.read") ? row.counterpartyNameSnapshot : null, amountSummary: actor.permissionCodes.has("finance.amounts.read") ? { amount: decimal(row.cashAmount), currency: row.currency } : null, availableActions: approval ? ["approve", "reject"] : ["preview", "post"], entityVersion: row.version, deepLink: `/app/mobile/settlements/${encodeURIComponent(row.id)}` }, actor)); }
    }
    if (!isUnavailableProductRoute("finance:reconciliation") && can({ actor, permission: "finance.internal_transfer.read", tenantId: actor.tenantId }) && can({ actor, permission: "finance.internal_transfer.approve", tenantId: actor.tenantId })) {
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

  // The draft commands are the shared receiving core; the facade adds the
  // mobile permissions and keeps device fields on the document.
  async function searchReceivingPurchaseOrders(search, context) {
    const actor = await actorFor(context); assertAuthorized({ actor, permission: "mobile.receiving.read", tenantId: actor.tenantId });
    const { items, total, warehouses } = await receivingDrafts.listReceivablePurchaseOrders({ search }, context, RECEIVING_DRAFT_CHANNELS.mobile);
    return { items: items.map(({ id, status, supplierName, currency, lines }) => ({ id, status, supplierName, currency, lines: lines.map(({ id: lineId, sku, itemName, orderedQuantity, receivedQuantity, remainingQuantity, unit }) => ({ id: lineId, sku, itemName, orderedQuantity, receivedQuantity, remainingQuantity, unit })) })), total, warehouses };
  }
  const createReceivingDraft = (input, context) => receivingDrafts.createDraft(input, context, RECEIVING_DRAFT_CHANNELS.mobile);
  const reviseReceivingDraft = (id, input, context) => receivingDrafts.reviseDraft(id, input, context, RECEIVING_DRAFT_CHANNELS.mobile);
  const submitReceivingDraft = (id, input, context) => receivingDrafts.submitDraft(id, input, context, RECEIVING_DRAFT_CHANNELS.mobile);
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
