import { PAGE_SIZES, type PrintDocumentType, type PrintLayoutElement, type PrintLayoutTemplate, type PrintTableColumn } from "./printLayoutTypes";
import type { PrintLayoutCopy } from "./printLayoutElements";

// The built-in templates, their titles and text in the interface language.
// Like the elements the toolbar adds, the text is template content: a template
// saved from a built-in keeps the language it was saved in.

const field = (id: string, title: string, binding: string, x: number, y: number, width = 220): PrintLayoutElement => ({
  id, type: "field", title, field: binding, x, y, width, height: 28, visible: true, draggable: true, resizable: true,
  style: { fontSize: 12, align: "left" },
});

function columnsFor(type: PrintDocumentType, copy: PrintLayoutCopy): PrintTableColumn[] {
  const sku = { key: "sku", title: copy("printLayout.preset.column.sku"), visible: true };
  const item = { key: "itemName", title: copy("printLayout.preset.column.itemName"), visible: true };
  const unit = { key: "unit", title: copy("printLayout.preset.column.unit"), visible: true, align: "center" as const };
  const remarks = { key: "remarks", title: copy("printLayout.preset.column.remarks"), visible: true };
  if (type === "receive_sheet") return [
    { ...sku, width: 95 }, { ...item, width: 190 },
    { key: "quantity", title: copy("printLayout.preset.column.receivedQuantity"), visible: true, width: 80, align: "right" }, { ...unit, width: 55 },
    { key: "batchNo", title: copy("printLayout.preset.column.batchNo"), visible: true, width: 95 }, { ...remarks, width: 120 },
  ];
  if (type === "delivery_note") return [
    { ...sku, width: 90 }, { ...item, width: 170 },
    { key: "orderedQty", title: copy("printLayout.preset.column.orderedQty"), visible: true, width: 70, align: "right" }, { key: "shippedQty", title: copy("printLayout.preset.column.shippedQty"), visible: true, width: 70, align: "right" },
    { ...unit, width: 50 }, { key: "batchNo", title: copy("printLayout.preset.column.batchNo"), visible: true, width: 90 },
    { key: "cartonCount", title: copy("printLayout.preset.column.cartonCount"), visible: true, width: 55, align: "right" }, { ...remarks, width: 105 },
  ];
  return [
    { ...sku, width: 90 }, { ...item, width: 180 },
    { key: "shippedQty", title: copy("printLayout.preset.column.shippedQty"), visible: true, width: 75, align: "right" }, { key: "receivedQty", title: copy("printLayout.preset.column.receivedQty"), visible: true, width: 75, align: "right" },
    { key: "damagedQty", title: copy("printLayout.preset.column.damagedQty"), visible: true, width: 75, align: "right" }, { ...unit, width: 55 },
    { ...remarks, width: 135 },
  ];
}

const common = (title: string, type: PrintDocumentType, copy: PrintLayoutCopy): PrintLayoutElement[] => [
  { id: "company", type: "field", title: copy("printLayout.preset.company"), field: "companyName", x: 52, y: 42, width: 690, height: 30, visible: true, draggable: true, resizable: true, required: true, style: { fontSize: 14, bold: true, align: "center" } },
  { id: "title", type: "text", title: copy("printLayout.preset.documentTitle"), value: title, x: 52, y: 78, width: 690, height: 44, visible: true, draggable: true, resizable: true, required: true, style: { fontSize: 24, bold: true, align: "center" } },
  field("documentNo", copy("printLayout.preset.documentNo"), "documentNo", 52, 140, 300),
  field("documentDate", copy("printLayout.preset.date"), "documentDate", 442, 140, 300),
  field("warehouse", copy("printLayout.preset.warehouse"), "warehouse", 52, 174, 300),
  field("sourceOrderNo", copy("printLayout.preset.sourceOrder"), "sourceOrderNo", 442, 174, 300),
  field("handler", copy("printLayout.preset.handler"), "handler", 52, 208, 300),
  { id: "lines", type: "table", title: copy("printLayout.preset.lines"), field: "lines", x: 52, y: 320, width: 690, height: 330, visible: true, draggable: true, resizable: true, required: true, style: { fontSize: 11, bordered: true }, tableColumns: columnsFor(type, copy) },
  field("remarks", copy("printLayout.preset.remarks"), "remarks", 52, 672, 690),
  { id: "signatures", type: "signature", title: copy("printLayout.preset.signatures"), value: copy("printLayout.preset.signaturesValue"), x: 52, y: 742, width: 690, height: 58, visible: true, draggable: true, resizable: true, style: { fontSize: 12, align: "left", bordered: true } },
  { id: "footer", type: "footer", title: copy("printLayout.preset.footer"), value: copy("printLayout.preset.footerValue"), x: 52, y: 1040, width: 560, height: 24, visible: true, draggable: true, resizable: true, style: { fontSize: 10, align: "left" } },
  { id: "pageNumber", type: "pageNumber", title: copy("printLayout.preset.pageNumber"), x: 620, y: 1040, width: 122, height: 24, visible: true, draggable: true, resizable: true, style: { fontSize: 10, align: "right" } },
];

function receivePreset(copy: PrintLayoutCopy): PrintLayoutTemplate {
  const elements = common(copy("printLayout.preset.receiveSheetTitle"), "receive_sheet", copy);
  elements.splice(6, 0,
    field("supplier", copy("printLayout.preset.supplier"), "supplier", 52, 242, 300),
    field("receiveDate", copy("printLayout.preset.receiveDate"), "receiveDate", 442, 242, 300),
    field("receiver", copy("printLayout.preset.receiver"), "receiver", 52, 276, 300),
    field("reviewedBy", copy("printLayout.preset.reviewedBy"), "reviewedBy", 442, 276, 300),
  );
  return { id: "default-receive-sheet", name: copy("printLayout.preset.receiveSheetName"), documentType: "receive_sheet", isDefault: true, version: 1, page: { paper: "A4", orientation: "portrait", ...PAGE_SIZES.portrait, margin: 52 }, elements };
}

function deliveryPreset(copy: PrintLayoutCopy): PrintLayoutTemplate {
  const elements = common(copy("printLayout.preset.deliveryNoteTitle"), "delivery_note", copy);
  elements.splice(6, 0,
    field("customer", copy("printLayout.preset.customer"), "customer", 52, 242, 300), field("logisticsCompany", copy("printLayout.preset.carrier"), "logisticsCompany", 442, 242, 300),
    field("driver", copy("printLayout.preset.driver"), "driver", 52, 276, 220), field("vehicleNo", copy("printLayout.preset.vehicle"), "vehicleNo", 292, 276, 220), field("cartonCount", copy("printLayout.preset.cartons"), "cartonCount", 532, 276, 210),
  );
  return { id: "default-delivery-note", name: copy("printLayout.preset.deliveryNoteName"), documentType: "delivery_note", isDefault: true, version: 1, page: { paper: "A4", orientation: "portrait", ...PAGE_SIZES.portrait, margin: 52 }, elements };
}

function receiptPreset(copy: PrintLayoutCopy): PrintLayoutTemplate {
  const elements = common(copy("printLayout.preset.signReceiptTitle"), "sign_receipt", copy);
  elements.splice(6, 0,
    field("customer", copy("printLayout.preset.customer"), "customer", 52, 242, 300), field("receiverName", copy("printLayout.preset.signer"), "receiverName", 442, 242, 300),
    field("receiverPhone", copy("printLayout.preset.signerPhone"), "receiverPhone", 52, 276, 220), field("signDate", copy("printLayout.preset.signDate"), "signDate", 292, 276, 220), field("deliveryNo", copy("printLayout.preset.deliveryNo"), "deliveryNo", 532, 276, 210),
    field("exceptionNote", copy("printLayout.preset.exceptionNote"), "exceptionNote", 52, 812, 690),
    { id: "customerSignature", type: "signature", title: copy("printLayout.preset.customerSignature"), field: "signature", x: 52, y: 856, width: 690, height: 72, visible: true, draggable: true, resizable: true, style: { fontSize: 12, bordered: true } },
  );
  return { id: "default-sign-receipt", name: copy("printLayout.preset.signReceiptName"), documentType: "sign_receipt", isDefault: true, version: 1, page: { paper: "A4", orientation: "portrait", ...PAGE_SIZES.portrait, margin: 52 }, elements };
}

const PRESETS: Record<PrintDocumentType, (copy: PrintLayoutCopy) => PrintLayoutTemplate> = {
  receive_sheet: receivePreset, delivery_note: deliveryPreset, sign_receipt: receiptPreset,
};

export function defaultPrintTemplate(type: PrintDocumentType, copy: PrintLayoutCopy): PrintLayoutTemplate {
  return PRESETS[type](copy);
}
