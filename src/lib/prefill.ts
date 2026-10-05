// Typed access to the shared prefill rules (shared/prefill-suggestions.mjs),
// which the server applies to the same trail.
import { buildSuggestionTrail as buildTrail, prefillOrigin as originOf } from "../../shared/prefill-suggestions.mjs";
import { planPurchaseRequestPrefill as planRequest } from "../../shared/purchase-request-prefill.mjs";

export type PrefillSource = "record" | "default" | "template" | "history" | "workspace_history" | "model";
export type PrefillOutcome = "accepted" | "edited" | "cleared";
export type PrefillOrigin = "ai_assistant" | "today_cockpit" | "form";
// A suggested value, where it came from, and an id that lets anyone recompute it.
export type PrefillEntry = { source: PrefillSource; ref?: string; value: string };
export type SuggestionTrail = { origin: PrefillOrigin; fields: { field: string; source: PrefillSource; ref?: string; outcome: PrefillOutcome }[] };

export function prefillOrigin(value: unknown): PrefillOrigin {
  return originOf(value);
}

export function buildSuggestionTrail(input: { origin?: unknown; prefills?: Record<string, PrefillEntry>; values?: Record<string, unknown> }): SuggestionTrail | null {
  return buildTrail(input);
}

export type PurchaseRequestPrefillField = "itemId" | "supplierId" | "quantity" | "estimatedUnitPrice" | "targetWarehouseId" | "needByDate" | "internalLineComment";
export type PurchaseRequestPrefillPlan = {
  origin: PrefillOrigin;
  intent: "rfq" | null;
  values: Record<PurchaseRequestPrefillField | "currency", string>;
  fields: Partial<Record<PurchaseRequestPrefillField, PrefillEntry>>;
};

// One purchase request line from a handoff query and the item's master data.
export function planPurchaseRequestPrefill(input: {
  query: Record<string, string>;
  item: { itemId: string; defaultWarehouseId?: string };
  suppliers: { id: string; supplierCode?: string; name?: string; supplierName?: string; preferred?: boolean; referencePrice?: number | string | null; currency?: string | null; leadTimeDays?: number | null; minimumOrderQuantity?: number | string | null }[];
  today: string;
  defaultDate: string;
}): PurchaseRequestPrefillPlan {
  return planRequest(input);
}
