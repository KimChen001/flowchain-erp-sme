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
  export function prefillOrigin(value: unknown): 'ai_assistant' | 'today_cockpit' | 'form';
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
