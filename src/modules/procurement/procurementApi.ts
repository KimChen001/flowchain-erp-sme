import { apiJson } from "../../lib/api-client";
import type { ProcurementDocument, ProcurementDocumentType, ProcurementRfqDocument, PurchaseOrder, PurchaseRequestSummary, RfqSupplierResponseCommandInput, RfqSupplierResponseCommandResult } from "./procurementTypes";

export const procurementApi = {
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
