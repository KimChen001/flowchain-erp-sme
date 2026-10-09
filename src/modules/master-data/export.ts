import { toast } from "sonner";
import { exportRowsToCsv } from "../../lib/data-export";
import type { PaymentTerm, TaxCode, WarehouseBin } from "../../types/scm";
import type { MasterItem } from "./ItemMasterWorkbench";

// An item row as the items list shows it, with its preferred supplier's name.
export type ItemExportRow = MasterItem & { preferredSupplierName: string };

type Copy = (value: string, params?: Record<string, string | number>) => string;
export type ExportableMasterDataTab = "items" | "warehouses" | "tax-codes" | "payment-terms";

// Column headers and yes/no cells follow the interface language, so an
// English workspace gets an English spreadsheet. Values stay as stored.
export function exportMasterDataCsv(
  tab: ExportableMasterDataTab,
  data: { items?: ItemExportRow[]; warehouses?: WarehouseBin[]; taxCodes?: TaxCode[]; paymentTerms?: PaymentTerm[] },
  copy: Copy,
) {
  const yesNo = (value: boolean) => copy(value ? "Yes" : "No");
  const row = (pairs: Array<[string, unknown]>) => Object.fromEntries(pairs.map(([header, value]) => [copy(header), value]));
  const configs: Record<ExportableMasterDataTab, { filename: string; rows: () => Record<string, unknown>[] }> = {
    // The headers and their order are the item import's columns
    // (shared/data-import-columns.mjs), so an exported file imports again.
    // Fields items do not record (default bin, maximum stock, QA) stay empty.
    items: {
      filename: "master-data-items-export.csv",
      rows: () => (data.items || []).map((item) => row([
        ["SKU", item.sku], ["Item name", item.itemName], ["Category", item.category], ["Specification", item.specification],
        ["Unit", item.baseUnit], ["Default warehouse", item.defaultWarehouseId], ["Default bin", ""],
        ["Safety stock", item.safetyStock], ["Maximum stock", ""], ["Reorder point", item.reorderPoint > 0 ? item.reorderPoint : ""],
        ["Lead time (days)", item.purchaseLeadTimeDays > 0 ? item.purchaseLeadTimeDays : ""], ["Batch managed", yesNo(item.batchManaged)], ["Serial managed", yesNo(item.serialManaged)],
        ["QA required", ""], ["Default supplier", item.preferredSupplierName], ["Default tax code", item.taxCodeId],
        ["Status", copy(item.status === "active" ? "Active" : item.status === "inactive" ? "Inactive" : item.status)],
      ])),
    },
    warehouses: {
      filename: "master-data-warehouse-bins-export.csv",
      rows: () => (data.warehouses || []).map((item) => row([
        ["Warehouse code", item.warehouseCode], ["Warehouse name", item.warehouseName], ["Zone", item.zone], ["Bin", item.bin],
        ["Capacity", item.capacity], ["Utilization", item.utilization], ["Temperature requirement", item.temperatureRequirement],
        ["QA status", copy(item.qaStatus)], ["Available", yesNo(item.available)], ["Owner", item.owner],
      ])),
    },
    "tax-codes": {
      filename: "master-data-tax-codes-export.csv",
      rows: () => (data.taxCodes || []).map((item) => row([
        ["Tax code", item.code], ["Tax code name", item.name], ["Tax rate", item.rate], ["Tax type", item.type],
        ["Region", item.region], ["Default", yesNo(item.isDefault)], ["Status", copy(item.status)], ["Description", item.description],
      ])),
    },
    "payment-terms": {
      filename: "master-data-payment-terms-export.csv",
      rows: () => (data.paymentTerms || []).map((item) => row([
        ["Term code", item.code], ["Term name", item.name], ["Net days", item.netDays], ["Discount rule", item.discountRule],
        ["Due date rule", item.dueDateRule], ["Status", copy(item.status)], ["Description", item.description],
      ])),
    },
  };

  const current = configs[tab];
  exportRowsToCsv(current.filename, current.rows());
  toast.success(copy("Export file created"));
}

