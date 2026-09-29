import { ITEM_MASTER, PAYMENT_TERMS, SUPPLIER_MASTER, TAX_CODES, WAREHOUSE_BINS } from "../../data/master-data";

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
