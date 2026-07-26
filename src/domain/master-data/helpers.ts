import { ITEM_MASTER, PAYMENT_TERMS, SUPPLIER_MASTER, TAX_CODES, WAREHOUSE_BINS } from "../../data/master-data";
import {
  INVENTORY_MOVEMENT_LEDGER,
  PAYABLES,
  SUPPLIER_CREDIT_MEMOS,
  SUPPLIER_INVOICES,
  SUPPLIER_RECONCILIATION_STATEMENTS,
  inventoryItems,
  purchaseOrders,
} from "../../data/empty-business-state";

export function itemUsageSummary(sku: string) {
  const inventory = inventoryItems.find((item) => item.sku === sku);
  const openPurchaseOrders = purchaseOrders.filter((order) =>
    order.sourceSku === sku && !["已完成", "已取消", "已驳回"].includes(order.status)
  );
  const movements = INVENTORY_MOVEMENT_LEDGER.filter((movement) => movement.sku === sku);
  return {
    currentInventory: inventory?.qty ?? 0,
    inventoryStatus: inventory?.status || "待维护",
    openPrCount: 0,
    openPoCount: openPurchaseOrders.length,
    movementCount: movements.length,
  };
}

export function supplierUsageSummary(supplier: string) {
  const relatedPurchaseOrders = purchaseOrders.filter((order) => order.supplier === supplier);
  const invoices = SUPPLIER_INVOICES.filter((invoice) => invoice.supplier === supplier);
  const payables = PAYABLES.filter((payable) => payable.supplier === supplier && payable.status !== "已付款");
  const credits = SUPPLIER_CREDIT_MEMOS.filter((memo) => memo.supplier === supplier);
  const reconciliation = SUPPLIER_RECONCILIATION_STATEMENTS.find((statement) => statement.supplier === supplier);
  return {
    poCount: relatedPurchaseOrders.length,
    invoiceCount: invoices.length,
    openApAmount: payables.reduce((sum, item) => sum + item.amount, 0),
    creditMemoAmount: credits.reduce((sum, item) => sum + item.totalCredit, 0),
    reconciliationStatus: reconciliation?.status || "待生成",
  };
}

export function warehouseUsageSummary(bin: string) {
  const itemCount = ITEM_MASTER.filter((item) => item.defaultBin === bin).length;
  const movementCount = INVENTORY_MOVEMENT_LEDGER.filter((movement) => movement.location.includes(bin)).length;
  const warehouse = WAREHOUSE_BINS.find((item) => item.bin === bin);
  return {
    itemCount,
    movementCount,
    utilization: warehouse?.utilization ?? 0,
    cycleCountStatus: warehouse?.qaStatus === "冻结" ? "需复核" : "可盘点",
  };
}

export function masterDataQualitySignals() {
  const missingTaxCode = ITEM_MASTER.filter((item) => !item.defaultTaxCode).length + SUPPLIER_MASTER.filter((supplier) => !supplier.defaultTaxCode).length;
  const missingSupplier = ITEM_MASTER.filter((item) => !item.defaultSupplier).length;
  const inactiveBins = WAREHOUSE_BINS.filter((bin) => !bin.available || bin.qaStatus !== "可用").length;
  const incompleteItems = ITEM_MASTER.filter((item) => item.status === "待完善").length;
  const supplierReview = SUPPLIER_MASTER.filter((supplier) => ["整改中", "待复核"].includes(supplier.certificationStatus)).length;
  const taxCodeReview = TAX_CODES.filter((taxCode) => taxCode.status === "待复核").length;
  const paymentTermReview = PAYMENT_TERMS.filter((term) => term.status === "待复核").length;
  return {
    missingTaxCode,
    missingSupplier,
    inactiveBins,
    totalIssues: missingTaxCode + missingSupplier + inactiveBins + incompleteItems + supplierReview + taxCodeReview + paymentTermReview,
  };
}
