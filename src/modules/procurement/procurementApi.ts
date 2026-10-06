import { apiJson } from "../../lib/api-client";
import type { PriceHistory } from "../../../shared/price-history.mjs";
import type { ProcurementDocument, ProcurementDocumentType, ProcurementRfqDocument, PurchaseOrder, PurchaseRequestSummary, RfqAwardDecision, RfqAwardDecisionInput, RfqSupplierComparison, RfqSupplierResponseCommandInput, RfqSupplierResponseCommandResult } from "./procurementTypes";

// The price history of items on the workspace's own issued purchase orders:
// one request for every item, unit and currency a page shows.
export type PriceHistoryResponse = { histories: PriceHistory[]; timeZone: string; priceLabel: "purchase_order_price"; restrictedFields?: string[] };

export const procurementApi = {
  priceHistory: (keys: string[]) =>
    apiJson<PriceHistoryResponse>(`/api/procurement/price-history?${keys.map((key) => `key=${encodeURIComponent(key)}`).join("&")}`),
  listRequests: () => apiJson<PurchaseRequestSummary[]>("/api/procurement/requests"),
  listOrders: () => apiJson<PurchaseOrder[]>("/api/procurement/orders"),
  listDocuments: (type: string) => apiJson<{ documents: ProcurementDocument[] }>(`/api/procurement/documents?type=${encodeURIComponent(type)}`).then((payload) => payload.documents || []),
  getDocument: (type: ProcurementDocumentType, id: string) =>
    apiJson<{ document: ProcurementDocument }>(
      `/api/procurement/documents/${encodeURIComponent(type)}/${encodeURIComponent(id)}`,
    ).then((payload) => payload.document),
  getRfqDocument: (id: string) =>
    apiJson<{ document: ProcurementRfqDocument }>(
      `/api/procurement/documents/rfq/${encodeURIComponent(id)}`,
    ).then((payload) => payload.document),
  getRfqSupplierComparison: (id: string) =>
    apiJson<RfqSupplierComparison>(
      `/api/procurement/rfqs/${encodeURIComponent(id)}/comparison`,
    ),
  getRfqAwardDecision: (id: string) =>
    apiJson<{ awardDecision: RfqAwardDecision | null }>(
      `/api/procurement/rfqs/${encodeURIComponent(id)}/award-decision`,
    ).then((payload) => payload.awardDecision),
  createRfqAwardDecision: (rfqId: string, input: RfqAwardDecisionInput) =>
    apiJson<RfqAwardDecision>(
      `/api/procurement/rfqs/${encodeURIComponent(rfqId)}/award-decisions`,
      {
        method: "POST",
        headers: { "Idempotency-Key": input.idempotencyKey },
        body: JSON.stringify(input),
      },
    ),
  recordRfqSupplierResponse: (rfqId: string, input: RfqSupplierResponseCommandInput) =>
    apiJson<RfqSupplierResponseCommandResult>(
      `/api/procurement/rfqs/${encodeURIComponent(rfqId)}/supplier-responses`,
      {
        method: "POST",
        headers: { "Idempotency-Key": input.idempotencyKey },
        body: JSON.stringify(input),
      },
    ),
  appendRfqSupplierResponseRevision: (rfqId: string, supplierId: string, input: RfqSupplierResponseCommandInput) =>
    apiJson<RfqSupplierResponseCommandResult>(
      `/api/procurement/rfqs/${encodeURIComponent(rfqId)}/supplier-responses/${encodeURIComponent(supplierId)}/revisions`,
      {
        method: "POST",
        headers: { "Idempotency-Key": input.idempotencyKey },
        body: JSON.stringify(input),
      },
    ),
};
