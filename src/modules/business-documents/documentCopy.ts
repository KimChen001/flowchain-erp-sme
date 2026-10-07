import type { DocumentLanguage } from "../../../shared/business-documents.mjs";

// Labels printed on a business document, in the document's language: the
// workspace default or the one picked for a single print. They follow the
// document language, not the interface language, because the document goes
// to a supplier or customer. Numbers, dates and currencies never follow it
// (documentFormat.ts).
const COPY = {
  purchaseOrder: ["Purchase Order", "采购订单"],
  poNumber: ["PO number", "采购订单号"],
  approvedOn: ["Approved on", "批准日期"],
  issueDate: ["Issue date", "下达日期"],
  expectedDelivery: ["Expected delivery", "预计交期"],
  currency: ["Currency", "币种"],
  supplier: ["Supplier", "供应商"],
  supplierCode: ["Supplier code", "供应商编号"],
  contact: ["Contact", "联系人"],
  phone: ["Phone", "电话"],
  email: ["Email", "邮箱"],
  taxId: ["Tax ID", "税号"],
  shipTo: ["Ship to", "收货仓库"],
  lineNo: ["#", "序号"],
  sku: ["SKU", "物料编码"],
  supplierSku: ["Supplier SKU", "供应商料号"],
  description: ["Description", "品名"],
  quantity: ["Quantity", "数量"],
  unit: ["Unit", "单位"],
  unitPrice: ["Unit price", "单价"],
  amount: ["Amount", "金额"],
  requestedDate: ["Requested date", "需求日期"],
  promisedDate: ["Promised date", "承诺交期"],
  total: ["Total ({currency})", "合计（{currency}）"],
  terms: ["Terms", "条款"],
  signature: ["Authorized signature", "授权签字"],
  signatureDate: ["Date", "日期"],
  // The customer invoice.
  invoice: ["Invoice", "销售发票"],
  billTo: ["Bill to", "开票对象"],
  customerCode: ["Customer code", "客户编号"],
  paymentTerms: ["Payment terms", "付款条件"],
  invoiceNumber: ["Invoice number", "发票号"],
  invoiceDate: ["Invoice date", "开票日期"],
  dueDate: ["Due date", "到期日"],
  salesOrder: ["Sales order", "销售订单"],
  shipment: ["Shipment", "发货单"],
  tax: ["Tax", "税额"],
  lineTotal: ["Line total", "行合计"],
  subtotal: ["Subtotal", "小计"],
  amountPaid: ["Amount paid", "已收金额"],
  creditsApplied: ["Credits applied", "已抵扣贷项"],
  balanceDue: ["Balance due", "应收余额"],
  paymentInstructions: ["Payment instructions", "付款说明"],
} as const;

export type DocumentCopyKey = keyof typeof COPY;

export function documentCopy(language: DocumentLanguage) {
  const index = language === "zh-CN" ? 1 : 0;
  return (key: DocumentCopyKey, variables: Record<string, string> = {}) =>
    Object.entries(variables).reduce<string>((text, [name, value]) => text.replaceAll(`{${name}}`, value), COPY[key][index]);
}
