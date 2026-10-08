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
