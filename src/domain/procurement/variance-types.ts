import { workspaceCopy } from "../../i18n/workspaceCopy";

// Invoice and three-way match variance types. Stored and server values are the
// stable codes of INVOICE_VARIANCE_TYPES (server/domain/invoice-matching-review.mjs)
// plus amount_variance; older rows still carry Chinese business values. Both
// resolve to one code, and each code has one label key that workspaceCopy
// translates, so a legacy value and its code show the same label and match the
// same filter option.
export const INVOICE_VARIANCE_TYPE_LABEL_KEYS = Object.freeze({
  none: "无差异",
  price_variance: "价格差异",
  quantity_variance: "数量差异",
  amount_variance: "金额差异",
  tax_variance: "税额差异",
  freight_variance: "运费差异",
  supplier_mismatch: "供应商不一致",
  missing_grn: "缺少收货",
  missing_po: "缺少PO",
  invoice_before_receipt: "发票早于收货",
  duplicate_invoice: "重复发票",
});

export type InvoiceVarianceCode = keyof typeof INVOICE_VARIANCE_TYPE_LABEL_KEYS;

export const INVOICE_VARIANCE_CODES = Object.freeze(Object.keys(INVOICE_VARIANCE_TYPE_LABEL_KEYS) as InvoiceVarianceCode[]);

const codeByLegacyValue = new Map<string, InvoiceVarianceCode>(
  INVOICE_VARIANCE_CODES.map((code) => [INVOICE_VARIANCE_TYPE_LABEL_KEYS[code], code]),
);

// The code for a stored variance type, or "" when the value is empty or unknown.
export function invoiceVarianceCode(value: unknown): InvoiceVarianceCode | "" {
  const text = String(value ?? "").trim();
  if (Object.prototype.hasOwnProperty.call(INVOICE_VARIANCE_TYPE_LABEL_KEYS, text)) return text as InvoiceVarianceCode;
  return codeByLegacyValue.get(text) || "";
}

export function isNoInvoiceVariance(value: unknown) {
  return invoiceVarianceCode(value) === "none";
}

export function isInvoiceVarianceType(value: unknown, code: InvoiceVarianceCode) {
  return invoiceVarianceCode(value) === code;
}

// The workspaceCopy key for a variance type. An unknown value is returned as it
// is, so free text is still shown rather than hidden.
export function invoiceVarianceLabelKey(value: unknown) {
  const code = invoiceVarianceCode(value);
  return code ? INVOICE_VARIANCE_TYPE_LABEL_KEYS[code] : String(value ?? "");
}

export function invoiceVarianceLabel(value: unknown, language: string) {
  return workspaceCopy(invoiceVarianceLabelKey(value), language);
}

// A filter option ("all" or a code) matches an invoice when both resolve to the
// same code, whether the invoice stores a code or a legacy Chinese value.
export function matchesInvoiceVarianceFilter(value: unknown, filter: string) {
  if (!filter || filter === "all") return true;
  const code = invoiceVarianceCode(filter);
  return Boolean(code) && invoiceVarianceCode(value) === code;
}
