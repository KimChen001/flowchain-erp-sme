import { capabilityForEnvironment } from "./capability-registry.mjs";
import { procurementDocumentNumber } from "../../shared/document-numbering.mjs";

const text = (value) => String(value ?? "").trim();
const serial = (value) => value?.toISOString?.() || value || null;
const decimal = (value) => {
  if (value === null || value === undefined) return null;
  const raw = String(value).trim();
  if (!/^[+-]?\d+(?:\.\d{1,4})?$/.test(raw)) return null;
  const negative = raw.startsWith("-"), unsigned = raw.replace(/^[+-]/, ""), [whole, fraction = ""] = unsigned.split(".");
  const units = BigInt(whole) * 10_000n + BigInt(fraction.padEnd(4, "0")), signed = negative ? -units : units, absolute = signed < 0n ? -signed : signed;
  return `${signed < 0n ? "-" : ""}${absolute / 10_000n}.${String(absolute % 10_000n).padStart(4, "0")}`;
};

const registry = {
  PurchaseOrder: { moduleKey: "procurement", capabilityId: "procurement", requiredReadPermission: "procurement.purchase_order.read", amountSensitive: true, partnerSensitive: true, priceSensitive: true, model: "purchaseOrder", include: { lines: true } },
  PurchaseOrderLine: { moduleKey: "procurement", capabilityId: "procurement", requiredReadPermission: "procurement.purchase_order.read", amountSensitive: true, partnerSensitive: true, priceSensitive: true, model: "purchaseOrderLine", parent: "purchaseOrder" },
  ReceivingDocument: { moduleKey: "receiving", capabilityId: "receiving-posting", requiredReadPermission: "receiving.read", warehouseScoped: true, model: "receivingDocument", include: { lines: true } },
  ReceivingLine: { moduleKey: "receiving", capabilityId: "receiving-posting", requiredReadPermission: "receiving.read", warehouseScoped: true, model: "receivingLine", parent: "receivingDocument" },
  InventoryMovement: { moduleKey: "inventory", capabilityId: "inventory", requiredReadPermission: "inventory.balance.read", warehouseScoped: true, model: "inventoryMovement" },
  InventoryBalance: { moduleKey: "inventory", capabilityId: "inventory", requiredReadPermission: "inventory.balance.read", warehouseScoped: true, model: "inventoryBalance" },
  ReturnRequest: { moduleKey: "returns", capabilityId: "return-request", requiredReadPermission: "returns.request.read", model: "returnRequest" },
  ReturnAuthorization: { moduleKey: "returns", capabilityId: "return-authorization", requiredReadPermission: "returns.authorization.read", model: "returnAuthorization" },
  ReturnPostingDocument: { moduleKey: "returns", capabilityId: "return-posting", requiredReadPermission: "returns.posting.read", model: "returnPostingDocument" },
  SupplierInvoice: { moduleKey: "finance", capabilityId: "supplier-invoice", requiredReadPermission: "finance.supplier_invoice.read", amountSensitive: true, partnerSensitive: true, model: "supplierInvoice" },
  PayableObligation: { moduleKey: "finance", capabilityId: "payable-obligation", requiredReadPermission: "finance.payable.read", amountSensitive: true, partnerSensitive: true, model: "payableObligation" },
  CustomerInvoice: { moduleKey: "finance", capabilityId: "customer-invoice", requiredReadPermission: "finance.customer_invoice.read", amountSensitive: true, partnerSensitive: true, model: "customerInvoice" },
  ReceivableObligation: { moduleKey: "finance", capabilityId: "receivable-obligation", requiredReadPermission: "finance.receivable.read", amountSensitive: true, partnerSensitive: true, model: "receivableObligation" },
  SettlementDocument: { moduleKey: "finance", capabilityId: "settlement-workflow", requiredReadPermission: "finance.settlement.read", amountSensitive: true, partnerSensitive: true, model: "settlementDocument", include: { allocations: true } },
  SettlementAllocation: { moduleKey: "finance", capabilityId: "settlement-workflow", requiredReadPermission: "finance.settlement.read", amountSensitive: true, model: "settlementAllocation", parent: "settlement" },
  CashbookAccount: { moduleKey: "finance", capabilityId: "internal-settlement", requiredReadPermission: "finance.cashbook.read", amountSensitive: true, model: "cashbookAccount" },
  CashbookEntry: { moduleKey: "finance", capabilityId: "internal-settlement", requiredReadPermission: "finance.cashbook.read", amountSensitive: true, model: "cashbookEntry", parent: "cashbookAccount" },
  PartnerAdvance: { moduleKey: "finance", capabilityId: "settlement-workflow", requiredReadPermission: "finance.advance.read", amountSensitive: true, partnerSensitive: true, model: "partnerAdvance" },
  AdvanceApplicationDocument: { moduleKey: "finance", capabilityId: "settlement-workflow", requiredReadPermission: "finance.advance.read", amountSensitive: true, model: "advanceApplicationDocument" },
  InternalTransferDocument: { moduleKey: "finance", capabilityId: "settlement-workflow", requiredReadPermission: "finance.internal_transfer.read", amountSensitive: true, model: "internalTransferDocument" },
  SettlementAttachment: { moduleKey: "finance", capabilityId: "settlement-workflow", requiredReadPermission: "finance.settlement_attachment.read", partnerSensitive: true, model: "settlementAttachment" },
  ReceivingAttachment: { moduleKey: "receiving", capabilityId: "receiving-posting", requiredReadPermission: "receiving.read", warehouseScoped: true, model: "receivingAttachment" },
  BankStatementImportBatch: { moduleKey: "finance", capabilityId: "bank-statement-reconciliation", requiredReadPermission: "finance.bank_statement.read", amountSensitive: true, partnerSensitive: true, model: "bankStatementImportBatch", tombstonePolicy: "fail_closed_metadata" },
  BankStatementLine: { moduleKey: "finance", capabilityId: "bank-statement-reconciliation", requiredReadPermission: "finance.bank_statement.read", amountSensitive: true, partnerSensitive: true, model: "bankStatementLine", tombstonePolicy: "fail_closed_metadata" },
  BankReconciliationGroup: { moduleKey: "finance", capabilityId: "bank-statement-reconciliation", requiredReadPermission: "finance.bank_reconciliation.read", amountSensitive: true, partnerSensitive: true, model: "bankReconciliationGroup", tombstonePolicy: "fail_closed_metadata" },
  BankReconciliationException: { moduleKey: "finance", capabilityId: "bank-statement-reconciliation", requiredReadPermission: "finance.bank_reconciliation.read", amountSensitive: true, partnerSensitive: true, model: "bankReconciliationException", tombstonePolicy: "fail_closed_metadata" },
};

const moduleEnabled = (tenant, moduleKey) => {
  const modules = tenant?.operationalSettings?.modules || tenant?.operationalSettings?.moduleSettings;
  if (!modules) return true;
  if (modules[moduleKey] === false) return false;
  const items = Array.isArray(modules) ? modules : Array.isArray(modules.items) ? modules.items : [];
  const item = items.find((entry) => text(entry?.id) === moduleKey);
  return item ? item.enabled !== false : true;
};

const visibleWarehouse = (actor, warehouseId) => !warehouseId || actor.allWarehouses || Boolean(actor.readWarehouseIds?.has?.(warehouseId));
const entityWarehouse = (row, policy) => text(row?.warehouseId || row?.warehouseKey || row?.locationWarehouseId || row?.receivingDocument?.warehouseId || row?.purchaseOrder?.warehouseId || row?.metadata?.warehouseId);
const hasPermission = (actor, permission) => Boolean(actor?.permissionCodes?.has?.(permission));

function project(row, entityType, policy, actor) {
  const prices = !policy.priceSensitive || hasPermission(actor, "procurement.prices.read");
  const amounts = !policy.amountSensitive || hasPermission(actor, "finance.amounts.read");
  const partner = !policy.partnerSensitive || hasPermission(actor, "finance.partner_snapshot.read");
  const base = { id: row.id, entityType, version: row.version ?? null, status: row.status ?? row.workflowStatus ?? null, updatedAt: serial(row.updatedAt), warehouseId: entityWarehouse(row, policy) || null };
  if (entityType === "PurchaseOrder") return { ...base, number: procurementDocumentNumber(row), orderNumber: procurementDocumentNumber(row), supplierId: partner ? row.supplierId : null, supplierName: partner ? row.supplierName : null, currency: row.currency, amount: amounts ? decimal(row.amount) : null, lines: (row.lines || []).map((line) => ({ id: line.id, sku: line.sku, itemName: line.itemName, orderedQuantity: decimal(line.orderedQuantity), receivedQuantity: decimal(line.receivedQuantity), unit: line.unit, unitPrice: prices && amounts ? decimal(line.unitPrice) : null, lineAmount: prices && amounts ? decimal(line.amount) : null })) };
  if (entityType === "PurchaseOrderLine") return { ...base, purchaseOrderId: row.purchaseOrderId, sku: row.sku, itemName: row.itemName, orderedQuantity: decimal(row.orderedQuantity), receivedQuantity: decimal(row.receivedQuantity), unit: row.unit, unitPrice: prices && amounts ? decimal(row.unitPrice) : null, amount: prices && amounts ? decimal(row.amount) : null };
  if (entityType === "ReceivingDocument") return { ...base, documentNumber: row.documentNumber, poId: row.poId, supplierId: partner ? row.supplierId : null, supplierName: partner ? row.supplierName : null, lines: (row.lines || []).map((line) => ({ id: line.id, purchaseOrderLineId: line.purchaseOrderLineId, sku: line.sku, itemName: line.itemName, acceptedQty: decimal(line.acceptedQty), rejectedQty: decimal(line.rejectedQty), warehouseId: line.warehouseId })) };
  if (entityType === "ReceivingLine") return { ...base, receivingDocumentId: row.receivingDocumentId, purchaseOrderLineId: row.purchaseOrderLineId, sku: row.sku, itemName: row.itemName, acceptedQty: decimal(row.acceptedQty), rejectedQty: decimal(row.rejectedQty), warehouseId: row.warehouseId };
  if (["InventoryMovement", "InventoryBalance"].includes(entityType)) return { ...base, sku: row.sku, itemName: row.itemName, quantityIn: decimal(row.quantityIn), quantityOut: decimal(row.quantityOut), availableQuantity: decimal(row.availableQuantity), onHandQuantity: decimal(row.onHandQuantity), reservedQuantity: decimal(row.reservedQuantity), movementType: row.movementType };
  if (entityType.endsWith("Attachment")) return { ...base, fileName: row.fileName, mimeType: row.mimeType, sizeBytes: row.sizeBytes, sha256: row.sha256, status: row.status };
  const result = { ...base, currency: row.currency || null };
  if (policy.amountSensitive) Object.assign(result, amounts
    ? { amount: decimal(row.amount ?? row.totalAmount ?? row.originalAmount ?? row.outstandingAmount ?? row.appliedAmount ?? row.remainingAmount ?? row.currentBalance), originalAmount: decimal(row.originalAmount), outstandingAmount: decimal(row.outstandingAmount), remainingAmount: decimal(row.remainingAmount) }
    : { amount: null, originalAmount: null, outstandingAmount: null, remainingAmount: null });
  if (policy.partnerSensitive) Object.assign(result, partner
    ? { supplierId: row.supplierId || row.supplierInvoice?.supplierId || null, supplierNameSnapshot: row.supplierNameSnapshot || null, customerId: row.customerId || row.customerInvoice?.customerId || null, customerNameSnapshot: row.customerNameSnapshot || row.customerInvoice?.customerNameSnapshot || null }
    : { supplierId: null, supplierNameSnapshot: null, customerId: null, customerNameSnapshot: null });
  if (entityType === "SettlementDocument") Object.assign(result, { workflowStatus: row.workflowStatus, postingStatus: row.postingStatus, settlementNumber: row.settlementNumber });
  if (entityType === "AdvanceApplicationDocument") Object.assign(result, { advanceId: row.advanceId, workflowStatus: row.workflowStatus, postingStatus: row.postingStatus });
  if (entityType === "BankStatementImportBatch") Object.assign(result, { batchNumber: row.batchNumber, workflowStatus: row.workflowStatus, validationStatus: row.validationStatus, activeLineCount: row.mobileReconciliationCounts?.activeLineCount ?? 0, unmatchedCount: row.mobileReconciliationCounts?.unmatchedCount ?? 0, partiallyMatchedCount: row.mobileReconciliationCounts?.partiallyMatchedCount ?? 0, matchedCount: row.mobileReconciliationCounts?.matchedCount ?? 0, exceptionCount: row.mobileReconciliationCounts?.exceptionCount ?? 0, desktopDeepLink: `/app/finance/bank-reconciliation?batch=${encodeURIComponent(row.id)}` });
  if (entityType === "BankStatementLine") Object.assign(result, { transactionDate: serial(row.transactionDate), direction: row.direction, reconciliationStatus: row.reconciliationStatus, amount: amounts ? decimal(row.amount) : null, matchedAmount: amounts ? decimal(row.matchedAmount) : null, remainingAmount: amounts ? decimal(row.remainingAmount) : null, counterpartyName: partner ? row.counterpartyName : null, counterpartyAccountMasked: partner ? row.counterpartyAccountMasked : null, desktopDeepLink: `/app/finance/bank-reconciliation?line=${encodeURIComponent(row.id)}` });
  if (entityType === "BankReconciliationGroup") Object.assign(result, { reconciliationNumber: row.reconciliationNumber, workflowStatus: row.workflowStatus, integrityStatus: row.integrityStatus, totalBankAmount: amounts ? decimal(row.totalBankAmount) : null, totalCashbookAmount: amounts ? decimal(row.totalCashbookAmount) : null, desktopDeepLink: `/app/finance/bank-reconciliation?group=${encodeURIComponent(row.id)}` });
  if (entityType === "BankReconciliationException") Object.assign(result, { exceptionType: row.exceptionType, severity: row.severity, reconciliationGroupId: row.reconciliationGroupId, desktopDeepLink: `/app/finance/bank-reconciliation?exception=${encodeURIComponent(row.id)}` });
  return result;
}

export const mobileSyncEntityPolicy = Object.freeze(registry);

export function validateMobileSyncEntityPolicy(value = registry) {
  for (const [entityType, policy] of Object.entries(value)) {
    const permission = text(policy.requiredReadPermission);
    const action = permission.split(".").at(-1);
    if (action === "read") continue;
    if (text(policy.readPermissionExceptionReason)) continue;
    throw new Error(`${entityType} requiredReadPermission must be a read action; received ${permission || "<empty>"}.`);
  }
  return true;
}

validateMobileSyncEntityPolicy();

export function getMobileSyncEntityPolicy(entityType) {
  return registry[text(entityType)] || null;
}

export async function loadAuthorizedSyncProjection({ prisma, tenant, actor, entityType, entityId, operation = "upsert", feedContext, env = process.env }) {
  const policy = getMobileSyncEntityPolicy(entityType);
  if (!policy) return null;
  if (operation === "tombstone") {
    const feedTenantId = text(feedContext?.tenantId);
    const resourceTenantId = text(feedContext?.resourceTenantId);
    if (policy.tombstonePolicy === "fail_closed_metadata" && (!feedTenantId || !resourceTenantId || !text(feedContext?.moduleKey) || !text(feedContext?.authorizationClass))) return null;
    if (feedTenantId && feedTenantId !== actor.tenantId) return null;
    if (resourceTenantId && resourceTenantId !== actor.tenantId) return null;
    if (policy.warehouseScoped && resourceTenantId !== actor.tenantId) return null;
    if (text(feedContext?.moduleKey) && text(feedContext.moduleKey) !== policy.moduleKey) return null;
    if (text(feedContext?.authorizationClass) && text(feedContext.authorizationClass) !== policy.requiredReadPermission) return null;
  }
  if (!moduleEnabled(tenant, policy.moduleKey)) return null;
  const capability = capabilityForEnvironment(policy.capabilityId, env);
  if (capability?.requiresExplicitEnable && !capability.enabled) return null;
  if (!hasPermission(actor, policy.requiredReadPermission)) return null;
  if (operation === "tombstone") {
    if (policy.warehouseScoped && !actor.allWarehouses) {
      const scopeWarehouseIds = Array.isArray(feedContext?.scopeWarehouseIds) ? feedContext.scopeWarehouseIds.map(text).filter(Boolean) : [];
      if (!scopeWarehouseIds.length || !scopeWarehouseIds.some((warehouseId) => actor.readWarehouseIds?.has?.(warehouseId))) return null;
    }
    return { id: text(entityId), entityType, tombstone: true };
  }
  const model = prisma[policy.model];
  if (!model) return null;
  const where = { id: text(entityId) };
  if (!policy.parent) where.tenantId = actor.tenantId;
  if (policy.parent === "purchaseOrder") where.purchaseOrder = { tenantId: actor.tenantId };
  if (policy.parent === "receivingDocument") where.receivingDocument = { tenantId: actor.tenantId };
  if (policy.parent === "settlement") where.settlement = { tenantId: actor.tenantId };
  if (policy.parent === "cashbookAccount") where.cashbookAccount = { tenantId: actor.tenantId };
  const row = await model.findFirst({ where, ...(policy.include ? { include: policy.include } : {}) });
  if (!row) return null;
  if (entityType === "BankStatementImportBatch") {
    const grouped = await prisma.bankStatementLine.groupBy({ by: ["reconciliationStatus"], where: { tenantId: actor.tenantId, batchId: row.id, status: "active" }, _count: { _all: true } });
    const counts = new Map(grouped.map((item) => [item.reconciliationStatus, item._count._all]));
    const exceptionCount = (counts.get("exception") || 0) + await prisma.bankReconciliationException.count({ where: { tenantId: actor.tenantId, status: { in: ["open", "acknowledged"] }, severity: "blocking", group: { bankAllocations: { some: { bankStatementLine: { batchId: row.id } } } } } });
    row.mobileReconciliationCounts = { activeLineCount: grouped.reduce((total, item) => total + item._count._all, 0), unmatchedCount: counts.get("unmatched") || 0, partiallyMatchedCount: counts.get("partially_matched") || 0, matchedCount: counts.get("matched") || 0, exceptionCount };
  }
  if (policy.warehouseScoped && !visibleWarehouse(actor, entityWarehouse(row, policy))) return null;
  return project(row, entityType, policy, actor);
}
