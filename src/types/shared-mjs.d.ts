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
  export type DocumentSettings = {
    version: 1;
    documentLanguage: DocumentLanguage;
    letterhead: { companyName: string | null; addressLines: string[]; phone: string | null; email: string | null; taxId: string | null };
    purchaseOrder: { title: string | null; columns: PurchaseOrderColumns; termsText: string; footerText: string; signatureBlock: boolean };
  };
  // Every value is the recorded one or null; amounts and quantities are decimal strings.
  export type PurchaseOrderDocument = {
    kind: 'purchase_order';
    orderId: string | null;
    number: string | null;
    status: string | null;
    issuedAt: string | null;
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
  export const DOCUMENT_LANGUAGES: readonly DocumentLanguage[];
  export const PRINTABLE_PURCHASE_ORDER_STATUSES: readonly string[];
  export const PURCHASE_ORDER_COLUMNS: readonly (keyof PurchaseOrderColumns)[];
  export const DOCUMENT_SETTINGS_LIMITS: Readonly<{ companyName: number; addressLines: number; addressLine: number; phone: number; email: number; taxId: number; title: number; termsText: number; footerText: number }>;
  export const documentSettingsSeed: DocumentSettings;
  export function normalizeDocumentSettings(value: unknown): DocumentSettings;
  export function validateDocumentSettings(value: unknown): DocumentSettings;
  export function buildPurchaseOrderDocument(input: unknown): PurchaseOrderDocument;
}
