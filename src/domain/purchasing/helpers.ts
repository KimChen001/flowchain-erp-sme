import type { PurchaseOrder, PurchaseOrderLine } from "../../types/scm";

export function toNumber(value: unknown, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export function poLinesOf(po?: PurchaseOrder | null): PurchaseOrderLine[] {
  if (!po) return [];
  if (Array.isArray(po.lines) && po.lines.length > 0) {
    return po.lines.map((line, index) => ({
      poLineId: line.poLineId || `${po.po}-L${String(index + 1).padStart(3, "0")}`,
      poId: line.poId || po.po,
      sku: line.sku || po.sourceSku || "SKU-UNKNOWN",
      itemName: line.itemName || po.sourceName || "未命名物料",
      quantityOrdered: toNumber(line.quantityOrdered, toNumber(po.recommendedQty, toNumber(po.items))),
      quantityReceived: toNumber(line.quantityReceived),
      quantityAccepted: toNumber(line.quantityAccepted),
      quantityRejected: toNumber(line.quantityRejected),
      unit: line.unit || po.unit || "件",
      unitPrice: toNumber(line.unitPrice, toNumber(po.unitPrice)),
      currency: line.currency || po.currency || "",
      supplierId: line.supplierId || po.supplierId || po.supplier,
      warehouseId: line.warehouseId || po.warehouseId || "MAIN",
      requiredDate: line.requiredDate,
      promisedDate: line.promisedDate || po.eta,
      status: line.status || "open",
    }));
  }

  const orderedQty = toNumber(po.totalOrderedQty, toNumber(po.recommendedQty, toNumber(po.items)));
  const receivedQty = toNumber(po.totalReceivedQty, toNumber(po.received));
  return [{
    poLineId: `${po.po}-LEGACY-001`,
    poId: po.po,
    sku: po.sourceSku || "SKU-LEGACY",
    itemName: po.sourceName || `${po.supplier} 采购项`,
    quantityOrdered: orderedQty,
    quantityReceived: receivedQty,
    quantityAccepted: toNumber(po.totalAcceptedQty, receivedQty),
    quantityRejected: toNumber(po.totalRejectedQty),
    unit: po.unit || "件",
    unitPrice: toNumber(po.unitPrice, orderedQty > 0 ? toNumber(po.amount) / orderedQty : 0),
    currency: po.currency || "",
    supplierId: po.supplierId || po.supplier,
    warehouseId: po.warehouseId || "MAIN",
    promisedDate: po.eta,
    status: receivedQty >= orderedQty && orderedQty > 0 ? "received" : receivedQty > 0 ? "partially_received" : "open",
  }];
}

export function poTotals(po?: PurchaseOrder | null) {
  const lines = poLinesOf(po);
  const totalOrderedQty = lines.reduce((sum, line) => sum + toNumber(line.quantityOrdered), 0);
  const totalReceivedQty = lines.reduce((sum, line) => sum + toNumber(line.quantityReceived), 0);
  const totalAcceptedQty = lines.reduce((sum, line) => sum + toNumber(line.quantityAccepted), 0);
  const totalRejectedQty = lines.reduce((sum, line) => sum + toNumber(line.quantityRejected), 0);
  const totalAmount = lines.reduce((sum, line) => sum + toNumber(line.quantityOrdered) * toNumber(line.unitPrice), 0);
  return {
    lineCount: po?.lineCount ?? lines.length,
    totalOrderedQty: po?.totalOrderedQty ?? totalOrderedQty,
    totalReceivedQty: po?.totalReceivedQty ?? totalReceivedQty,
    totalAcceptedQty: po?.totalAcceptedQty ?? totalAcceptedQty,
    totalRejectedQty: po?.totalRejectedQty ?? totalRejectedQty,
    totalAmount: po?.totalAmount ?? totalAmount,
  };
}

export function lineRemaining(line: PurchaseOrderLine) {
  return Math.max(0, toNumber(line.quantityOrdered) - toNumber(line.quantityReceived));
}

export function lineStatusLabel(status?: string) {
  const labels: Record<string, string> = {
    open: "待收货",
    partially_received: "部分到货",
    received: "已收货",
    closed: "已关闭",
  };
  return labels[status || ""] || status || "待收货";
}

export function lineStatusStyle(status?: string) {
  if (status === "received" || status === "closed") return { color: "#34c759", bg: "#f0faf4" };
  if (status === "partially_received") return { color: "#32ade6", bg: "#e8f6fc" };
  return { color: "#0071e3", bg: "#f0f6ff" };
}
