import type { ReceivingDoc, ReceivingDocLine } from "../../types/scm";
import { toNumber } from "../purchasing/helpers";

export function grnLinesOf(grn?: ReceivingDoc | null): ReceivingDocLine[] {
  if (!grn) return [];
  if (Array.isArray(grn.lines) && grn.lines.length > 0) {
    return grn.lines.map((line, index) => ({
      grnLineId: line.grnLineId || `${grn.grn}-L${String(index + 1).padStart(3, "0")}`,
      poLineId: line.poLineId,
      poId: line.poId || grn.po,
      sku: line.sku || "SKU-UNKNOWN",
      itemName: line.itemName || "未命名物料",
      receivedQty: toNumber(line.receivedQty),
      acceptedQty: toNumber(line.acceptedQty),
      rejectedQty: toNumber(line.rejectedQty),
      warehouseId: line.warehouseId || grn.warehouse || "MAIN",
      unit: line.unit || "件",
      status: line.status,
    }));
  }

  return [{
    grnLineId: `${grn.grn}-LEGACY-001`,
    poId: grn.po,
    sku: "SKU-LEGACY",
    itemName: `${grn.supplier} 到货项`,
    receivedQty: toNumber(grn.passed) + toNumber(grn.failed) || toNumber(grn.items),
    acceptedQty: toNumber(grn.passed),
    rejectedQty: toNumber(grn.failed),
    warehouseId: grn.warehouse || "MAIN",
    unit: "件",
    status: grn.status,
  }];
}
