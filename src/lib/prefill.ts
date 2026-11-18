// Typed access to the shared prefill rules (shared/prefill-suggestions.mjs),
// which the server applies to the same trail.
import { buildSuggestionTrail as buildTrail, prefillOrigin as originOf } from "../../shared/prefill-suggestions.mjs";
import { PREFILL_LINES_MAX as LINES_MAX, addCalendarDays as addDays, parsePrefillLines as parseLines, planNonCatalogPrefill as planNonCatalog, planPurchaseRequestPrefill as planRequest, prefillLineQuery as lineQuery, prefillLineValue as lineValue } from "../../shared/purchase-request-prefill.mjs";

export type PrefillSource = "record" | "default" | "template" | "history" | "workspace_history" | "model";
export type PrefillOutcome = "accepted" | "edited" | "cleared";
export type PrefillOrigin = "ai_assistant" | "today_cockpit" | "reorder_list" | "form";
// A suggested value, where it came from, and an id that lets anyone recompute it.
export type PrefillEntry = { source: PrefillSource; ref?: string; value: string };
export type SuggestionTrail = { origin: PrefillOrigin; fields: { field: string; source: PrefillSource; ref?: string; outcome: PrefillOutcome }[] };

/** A calendar day (YYYY-MM-DD) a whole number of days later. */
export function addCalendarDays(day: string, days: number): string {
  return addDays(day, days);
}

export function prefillOrigin(value: unknown): PrefillOrigin {
  return originOf(value);
}

// Several rows in one request (shared/purchase-request-prefill.mjs, design audit L3-24).
export type PrefillLine = { itemId: string; quantity: string; supplierId: string; shortfall: string };
export const PREFILL_LINES_MAX: number = LINES_MAX;
export function prefillLineValue(line: { itemId: string; quantity?: number | string | null; supplierId?: string | null; shortfall?: number | string | null }): string {
  return lineValue(line);
}
export function parsePrefillLines(values: string[]): PrefillLine[] {
  return parseLines(values);
}
export function prefillLineQuery(shared: Record<string, string>, line: PrefillLine): Record<string, string> {
  return lineQuery(shared, line);
}

export function buildSuggestionTrail(input: { origin?: unknown; prefills?: Record<string, PrefillEntry>; values?: Record<string, unknown> }): SuggestionTrail | null {
  return buildTrail(input);
}

export type PurchaseRequestPrefillField = "itemId" | "supplierId" | "quantity" | "estimatedUnitPrice" | "targetWarehouseId" | "needByDate" | "internalLineComment";
// The fields of a non-catalog ("Other") line the user's own words fill.
export type NonCatalogPrefillField = "itemNameSnapshot" | "quantity" | "unitSnapshot" | "supplierId" | "needByDate" | "internalLineComment";
// The last issued PO of the item with one supplier, as a workspace day.
export type SupplierLastOrder = { purchaseOrderId: string; orderNumber: string; day: string; dateSource: "issue_date" | "order_date" | "order_date_not_issued" | string };
// An approved source for a person to choose, when none is preferred. lastOrder
// is null when nothing was ordered from it, and absent when the dates could
// not be read.
export type SupplierChoice = { id: string; name: string; lastOrder?: SupplierLastOrder | null };
export type PurchaseRequestPrefillPlan = {
  origin: PrefillOrigin;
  intent: "rfq" | null;
  values: Record<PurchaseRequestPrefillField | "currency", string>;
  fields: Partial<Record<PurchaseRequestPrefillField, PrefillEntry>>;
  supplierChoices: SupplierChoice[];
};

// One purchase request line from a handoff query and the item's master data.
export function planPurchaseRequestPrefill(input: {
  query: Record<string, string>;
  item: { itemId: string; defaultWarehouseId?: string };
  suppliers: { id: string; supplierCode?: string; name?: string; supplierName?: string; preferred?: boolean; referencePrice?: number | string | null; currency?: string | null; leadTimeDays?: number | null; minimumOrderQuantity?: number | string | null }[];
  today: string;
  defaultDate: string;
  // By supplier id; null when the PO dates could not be read.
  lastOrders?: Record<string, SupplierLastOrder> | Map<string, SupplierLastOrder> | null;
}): PurchaseRequestPrefillPlan {
  return planRequest(input);
}

// One non-catalog ("Other") line from the assistant: only what the user wrote,
// each field marked as theirs; no SKU, price or category.
export function planNonCatalogPrefill(input: {
  query: Record<string, string>;
  units: { id: string; code?: string; label?: string }[];
  suppliers: { id: string; supplierCode?: string; name?: string; supplierName?: string }[];
  defaultDate: string;
}): { origin: PrefillOrigin; intent: null; values: Record<NonCatalogPrefillField, string>; fields: Partial<Record<NonCatalogPrefillField, PrefillEntry>>; supplierChoices: SupplierChoice[] } {
  return planNonCatalog(input);
}
