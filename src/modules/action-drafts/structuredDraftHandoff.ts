import { prefillOrigin } from "../../lib/prefill";

// Drafts that open a normal creation screen with its fields prefilled, rather
// than the text draft review. The screen's own save button is the only way to
// save; the query only fills the form. An RFQ starts from an approved purchase
// request in FlowChain, so an RFQ draft opens the purchase request form, which
// says so (intent=rfq).
export function isStructuredDraftType(type?: string | null) {
  return type === "purchase_request_draft" || type === "rfq_draft" || type === "task_draft";
}

export function structuredDraftTarget(type: string, payload: Record<string, unknown> = {}, source?: string | null) {
  const query = Object.fromEntries(Object.entries({
    mode: "create",
    itemId: payload.itemIdOrSku,
    sku: payload.itemIdOrSku,
    quantity: payload.quantity,
    reason: payload.reason,
    suppliers: Array.isArray(payload.supplierCandidates) ? payload.supplierCandidates.join(",") : payload.supplierCandidates || payload.supplierId,
    due: payload.quotationDeadline || payload.requestedDeliveryDate,
    origin: prefillOrigin(source),
    intent: type === "rfq_draft" ? "rfq" : undefined,
  }).filter(([, value]) => value !== undefined && value !== null && String(value) !== "").map(([key, value]) => [key, String(value)]));
  return { moduleId: type === "task_draft" ? "mobile-operations:tasks" : "procurement:requests", query };
}
