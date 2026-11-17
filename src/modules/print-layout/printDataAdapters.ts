import type { PrintDocumentData, PrintDocumentType, PrintFieldOption } from "./printLayoutTypes";

// The fields a sheet can print, by document type, named in the interface
// language (design audit L6-18, L11-28: the list was Chinese only).
const FIELD_LABELS: Record<string, [string, string]> = {
  companyName: ["Company", "公司名称"], documentNo: ["Document number", "单据编号"], documentDate: ["Document date", "单据日期"],
  supplier: ["Supplier", "供应商"], customer: ["Customer", "客户"], warehouse: ["Warehouse", "仓库"], handler: ["Handled by", "经办人"],
  receiver: ["Received by", "收货人"], receiveDate: ["Received on", "收货日期"], createdBy: ["Created by", "创建人"], reviewedBy: ["Reviewed by", "审核人"],
  remarks: ["Notes", "备注"], deliveryDate: ["Shipped on", "发货日期"], logisticsCompany: ["Carrier", "物流公司"], driver: ["Driver", "司机"],
  vehicleNo: ["Vehicle", "车辆"], cartonCount: ["Cartons", "箱数"], receiptNo: ["Receipt number", "签收单号"], deliveryNo: ["Delivery number", "发货单号"],
  receiverName: ["Signed by", "签收人"], receiverPhone: ["Signer phone", "签收电话"], signDate: ["Signed on", "签收日期"], exceptionNote: ["Exception note", "异常说明"],
  deliveryPerson: ["Delivered by", "配送人"], signature: ["Customer signature", "客户签名"],
};
// The order a sheet names its source by: a purchase order on a receipt, a sales order on a delivery or a signed receipt.
const SOURCE_ORDER: Record<PrintDocumentType, [string, string]> = { receive_sheet: ["Purchase order", "采购订单"], delivery_note: ["Sales order", "销售订单"], sign_receipt: ["Sales order", "销售订单"] };
const FIELD_KEYS: Record<PrintDocumentType, string[]> = {
  receive_sheet: ["companyName", "documentNo", "documentDate", "supplier", "warehouse", "sourceOrderNo", "handler", "receiver", "receiveDate", "createdBy", "reviewedBy", "remarks"],
  delivery_note: ["companyName", "documentNo", "documentDate", "customer", "warehouse", "sourceOrderNo", "handler", "deliveryDate", "logisticsCompany", "driver", "vehicleNo", "cartonCount", "createdBy", "reviewedBy", "remarks"],
  sign_receipt: ["companyName", "documentNo", "documentDate", "receiptNo", "deliveryNo", "sourceOrderNo", "customer", "receiverName", "receiverPhone", "signDate", "exceptionNote", "deliveryPerson", "reviewedBy", "signature", "remarks"],
};
export function printFieldOptionsFor(documentType: PrintDocumentType, language: string): PrintFieldOption[] {
  const index = language === "en-US" ? 0 : 1;
  return FIELD_KEYS[documentType].map((key) => ({ key, label: (key === "sourceOrderNo" ? SOURCE_ORDER[documentType] : FIELD_LABELS[key])[index] }));
}

// Every sheet prints what its record holds and nothing else. A value the
// record does not hold is left empty (the sheet prints a dash, a signature
// stays a blank box), never filled in. The company is left empty here; the
// editor prints the workspace letterhead's company name, else the
// workspace's name.

// The receipt detail page (/app/procurement/receiving/:id) reads the
// receiving workbench API, whose quantities are decimal strings. The sheet
// prints each line's accepted quantity on the receipt and its rejected
// quantity, in the line's own unit, and the arrival day in the workspace
// timezone. Receipts in this API record no lot numbers, so none is printed.
export type ReceivingDetailForPrint = {
  receivingDocument: {
    id: string;
    documentNumber?: string | null;
    arrivedAt?: string | null;
    receiver?: string | null;
    supplier?: { name?: string } | null;
    warehouse?: { name?: string; code?: string } | null;
  };
  // number: the order's document number, printed in place of its internal id.
  purchaseOrder: { id: string; number?: string };
  lines: Array<{ sku: string; itemName: string; documentAcceptedQuantity: string; rejectedQuantity: string; unit?: string }>;
};

export function adaptReceivingDetailSheet(detail: ReceivingDetailForPrint, { quantity, rejectedLabel, day }: {
  quantity: (value: string) => string;
  rejectedLabel: (quantity: string) => string;
  day: (instant: string | null | undefined) => string;
}): PrintDocumentData {
  const grn = detail.receivingDocument;
  const arrived = grn.arrivedAt ? day(grn.arrivedAt) : "";
  return {
    companyName: "", documentNo: grn.documentNumber || grn.id, documentDate: arrived, supplier: grn.supplier?.name || "",
    warehouse: grn.warehouse?.name || grn.warehouse?.code || "", sourceOrderNo: detail.purchaseOrder.number || detail.purchaseOrder.id, handler: "",
    receiver: grn.receiver || "", receiveDate: arrived, createdBy: "", reviewedBy: "", remarks: "",
    lines: detail.lines.map((line) => ({
      sku: line.sku || "",
      itemName: line.itemName || "",
      quantity: quantity(line.documentAcceptedQuantity),
      unit: line.unit || "",
      batchNo: "",
      remarks: Number(line.rejectedQuantity) > 0 ? rejectedLabel(quantity(line.rejectedQuantity)) : "",
    })),
  };
}
