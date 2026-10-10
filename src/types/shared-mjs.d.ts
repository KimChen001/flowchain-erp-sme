declare module '../../shared/roles.mjs' {
  export const ROLE_LABELS: Readonly<Record<string, string>>;
  export function roleLabel(role: string): string;
}
declare module '../../../shared/unavailable-product-routes.mjs' {
  export const FROZEN_PRODUCT_ROUTE_IDS: readonly string[];
  export function isUnavailableProductRoute(target: string | null | undefined): boolean;
}
declare module '../../shared/unavailable-product-routes.mjs' {
  export const FROZEN_PRODUCT_ROUTE_IDS: readonly string[];
  export function isUnavailableProductRoute(target: string | null | undefined): boolean;
}
declare module '../../shared/prefill-suggestions.mjs' {
  export function prefillOrigin(value: unknown): 'ai_assistant' | 'today_cockpit' | 'reorder_list' | 'form';
  export function buildSuggestionTrail(input: unknown): any;
}
declare module '../../shared/purchase-request-prefill.mjs' {
  export function planPurchaseRequestPrefill(input: unknown): any;
  export function addCalendarDays(day: string, days: number): string;
}
declare module '../../../shared/price-history.mjs' {
  export type PriceFact = {
    purchaseOrderId: string;
    orderNumber: string;
    lineId: string;
    supplierId: string | null;
    supplierName: string | null;
    unit: string | null;
    currency: string | null;
    unitPrice: string | null;
    orderedQuantity: string | null;
    date: string | null;
    dateSource: 'issue_date' | 'order_date' | 'order_date_not_issued';
    instant: string | null;
  };
  export type PriceHistory = {
    key: string;
    itemId: string;
    supplierId: string | null;
    unit: string | null;
    unitSource: 'entered' | 'item' | 'not_recorded';
    currency: string | null;
    status: 'found' | 'none' | 'unit_not_recorded';
    latest: PriceFact | null;
    earlier: PriceFact[];
    average: { unitPrice: string | null; n: number } | null;
    otherCurrencies: string[];
    otherUnits: string[];
    unitNotRecordedCount: number;
    restrictedFields?: string[];
  };
  export type QuoteComparison =
    | { status: 'compared'; lastPo: PriceFact; percent: string; average: PriceHistory['average'] }
    | { status: 'zero_base' | 'hidden' | 'no_quote_price'; lastPo: PriceFact; average: PriceHistory['average'] }
    | { status: 'not_comparable'; reason: 'currency' | 'unit' | 'unit_not_recorded'; values?: string[] }
    | { status: 'no_earlier_po' };
  export const PRICE_HISTORY_MAX_KEYS: number;
  export function priceHistoryKeyString(key: { itemId?: string | null; unit?: string | null; currency?: string | null; supplierId?: string | null }): string;
  export function compareQuote(input: { unitPrice: string | number | null | undefined; history: PriceHistory | null | undefined }): QuoteComparison;
}
declare module '../../../shared/supplier-override-reasons.mjs' {
  export type SupplierOverrideReasonCode = 'price' | 'lead_time' | 'stock_now' | 'quality' | 'moq_fit' | 'customer_specified' | 'other';
  export type SupplierOverrideIssue = { field: 'reasonCode' | 'note'; code: 'REASON_REQUIRED' | 'REASON_UNKNOWN' | 'NOTE_LENGTH' };
  export const SUPPLIER_OVERRIDE_REASONS: readonly SupplierOverrideReasonCode[];
  export const SUPPLIER_OVERRIDE_NOTE_LIMITS: { readonly min: number; readonly max: number };
  export function overrideNeeded(input: { supplierId?: string | null; preferredId?: string | null; preferredIds?: readonly (string | null | undefined)[] }): boolean;
  export function validateSupplierOverride(raw: unknown, needed: boolean): { value: { reasonCode: SupplierOverrideReasonCode; note: string | null } | null; issues: SupplierOverrideIssue[] };
}

declare module '../../../shared/data-import-columns.mjs' {
  export type DataImportColumn = { key: string; en: string; zh: string; required: boolean; example: string; aliases: readonly string[] };
  export const DATA_IMPORT_TYPES: readonly string[];
  export const DATA_IMPORT_COLUMNS: Readonly<Record<string, readonly DataImportColumn[]>>;
  export function dataImportCsv(rows: ReadonlyArray<ReadonlyArray<unknown>>): string;
  export function dataImportCsvCell(value: unknown): string;
}
declare module '../../../shared/business-documents.mjs' {
  export type DocumentLanguage = 'en-US' | 'zh-CN';
  export type PurchaseOrderColumns = { supplierSku: boolean; requestedDate: boolean; promisedDate: boolean };
  export type CustomerInvoiceColumns = { tax: boolean };
  // A calendar day (YYYY-MM-DD) or an instant (ISO), as the value was stored.
  export type RecordedDayOrInstant = { day: string | null; instant: string | null };
  export type DocumentSettings = {
    version: 1;
    documentLanguage: DocumentLanguage;
    letterhead: { companyName: string | null; addressLines: string[]; phone: string | null; email: string | null; taxId: string | null };
    purchaseOrder: { title: string | null; columns: PurchaseOrderColumns; termsText: string; footerText: string; signatureBlock: boolean };
    customerInvoice: { title: string | null; columns: CustomerInvoiceColumns; showPaymentSummary: boolean; paymentInstructions: string; termsText: string; footerText: string };
    // Saved print layouts; their shape is PrintLayoutTemplate (src/modules/print-layout/printLayoutTypes.ts).
    layouts: StoredPrintLayout[];
    // Stored layouts that no longer pass the check, kept exactly as stored and sent back unchanged.
    unreadableLayouts: unknown[];
  };
  export type StoredPrintLayout = {
    id: string;
    name: string;
    documentType: 'receive_sheet' | 'delivery_note' | 'sign_receipt';
    version: number;
    page: { paper: 'A4'; orientation: 'portrait' | 'landscape'; width: number; height: number; margin: number };
    elements: Array<Record<string, unknown> & { id: string; type: string }>;
    updatedAt?: string;
  };
  export const PRINT_LAYOUT_LIMITS: Readonly<{ templates: number; bytes: number; elements: number; columns: number; id: number; name: number; title: number; value: number; field: number; placeholder: number; coordinate: number }>;
  export const PRINT_LAYOUT_DOCUMENT_TYPES: readonly StoredPrintLayout['documentType'][];
  export function validatePrintLayout(value: unknown, field?: string): StoredPrintLayout;
  export function validatePrintLayouts(value: unknown, options?: { unreadableLayouts?: unknown[]; stored?: unknown }): StoredPrintLayout[];
  export const PRINT_LAYOUT_STYLE_LIMITS: Readonly<{ fontSize: Readonly<{ min: number; max: number }>; lineHeight: Readonly<{ min: number; max: number }> }>;
  // Every value is the recorded one or null; amounts and quantities are decimal strings.
  export type PurchaseOrderDocument = {
    kind: 'purchase_order';
    orderId: string | null;
    number: string | null;
    status: string | null;
    issuedAt: string | null;
    approvedAt: string | null;
    expectedDate: string | null;
    documentLanguage: DocumentLanguage;
    printable: { ok: boolean; reason: null | 'status' | 'prices_hidden' };
    buyer: { companyName: string | null; addressLines: string[]; phone: string | null; email: string | null; taxId: string | null };
    supplier: { name: string | null; code: string | null; contactName: string | null; email: string | null; telephone: string | null; address: string | null; postalCode: string | null };
    shipTo: { code: string | null; name: string | null };
    currency: string | null;
    lines: Array<{ lineNo: number; sku: string | null; supplierSku: string | null; description: string | null; quantity: string | null; unit: string | null; unitPrice: string | null; amount: string | null; requestedDate: string | null; promisedDate: string | null }>;
    totals: Array<{ currency: string | null; amount: string | null }>;
    title: string | null;
    columns: PurchaseOrderColumns;
    termsText: string | null;
    footerText: string | null;
    signatureBlock: boolean;
  };
  // Every value is the recorded one or null; amounts and quantities are decimal strings.
  export type CustomerInvoiceDocument = {
    kind: 'customer_invoice';
    invoiceId: string | null;
    number: string | null;
    status: string | null;
    invoiceDate: RecordedDayOrInstant;
    dueDate: string | null;
    salesOrderNumber: string | null;
    shipmentNumber: string | null;
    documentLanguage: DocumentLanguage;
    printable: { ok: boolean; reason: null | 'status' | 'not_issued' | 'amounts_hidden' };
    seller: { companyName: string | null; addressLines: string[]; phone: string | null; email: string | null; taxId: string | null };
    billTo: { name: string | null; code: string | null; contactName: string | null; email: string | null; telephone: string | null; address: string | null };
    paymentTerms: string | null;
    currency: string | null;
    lines: Array<{ lineNo: number; sku: string | null; description: string | null; quantity: string | null; unit: string | null; unitPrice: string | null; amount: string | null; tax: string | null; total: string | null }>;
    totals: Array<{ currency: string | null; subtotal: string | null; tax: string | null; total: string | null }>;
    paymentSummary: null | { currency: string | null; amountPaid: string | null; creditsApplied: string | null; balanceDue: string | null };
    title: string | null;
    columns: CustomerInvoiceColumns;
    paymentInstructions: string | null;
    termsText: string | null;
    footerText: string | null;
  };
  export const DOCUMENT_LANGUAGES: readonly DocumentLanguage[];
  export const PRINTABLE_PURCHASE_ORDER_STATUSES: readonly string[];
  export const PURCHASE_ORDER_COLUMNS: readonly (keyof PurchaseOrderColumns)[];
  export const PRINTABLE_CUSTOMER_INVOICE_STATUSES: readonly string[];
  export const PREVIEW_CUSTOMER_INVOICE_STATUSES: readonly string[];
  export const CUSTOMER_INVOICE_COLUMNS: readonly (keyof CustomerInvoiceColumns)[];
  export const DOCUMENT_SETTINGS_LIMITS: Readonly<{ companyName: number; addressLines: number; addressLine: number; phone: number; email: number; taxId: number; title: number; termsText: number; footerText: number; paymentInstructions: number }>;
  export const documentSettingsSeed: DocumentSettings;
  export function normalizeDocumentSettings(value: unknown): DocumentSettings;
  export function validateDocumentSettings(value: unknown, options?: { stored?: unknown }): DocumentSettings;
  export function buildPurchaseOrderDocument(input: unknown): PurchaseOrderDocument;
  export function buildCustomerInvoiceDocument(input: unknown): CustomerInvoiceDocument;
  export function recordedDayOrInstant(value: unknown): RecordedDayOrInstant;
  export function recordedPaymentTerms(value: unknown, terms?: ReadonlyArray<{ id?: string | null; code?: string | null; name?: string | null }>): string | null;
}
declare module '../../../shared/contract-status.mjs' {
  export type ContractType = 'purchase_agreement' | 'service_agreement' | 'nda' | 'quality_agreement' | 'other';
  export type ContractStatus = 'draft' | 'active' | 'terminated';
  export type ContractRenewal = 'none' | 'automatic' | 'by_agreement';
  export type ContractState = 'draft' | 'active' | 'notice_due' | 'ending' | 'ended' | 'past_end' | 'renewed' | 'terminated';
  export type ContractKeyDateKind = 'notice_deadline' | 'end' | 'terminated';
  export type ContractShownState = {
    state: ContractState;
    keyDate: string | null;
    keyDateKind: ContractKeyDateKind | null;
    daysUntilKeyDate: number | null;
    noticeDeadline: string | null;
    inReminderWindow: boolean;
  };
  export const CONTRACT_TYPES: readonly ContractType[];
  export const CONTRACT_STATUSES: readonly ContractStatus[];
  export const CONTRACT_RENEWALS: readonly ContractRenewal[];
  export const CONTRACT_STATES: readonly ContractState[];
  export const CONTRACT_DEFAULT_REMINDER_DAYS: number;
  export const CONTRACT_MAX_NOTICE_DAYS: number;
  export const CONTRACT_MAX_REMINDER_DAYS: number;
  export function contractCalendarDay(value: string | Date | null | undefined): string;
  export function contractDaysBetween(from: string, to: string): number;
  export function addContractDays(day: string, days: number): string;
  export function contractShownState(
    contract: { status?: string; renewal?: string; endDate?: string | Date | null; noticeDays?: number | null; reminderDays?: number | null; terminatedOn?: string | Date | null },
    options: { today: string; renewalActivated?: boolean },
  ): ContractShownState;
}
