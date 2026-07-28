import { apiJson } from "../../lib/api-client";
import type { ProcurementDocument, PurchaseOrder, PurchaseRequestSummary } from "./procurementTypes";

export const procurementApi = {
  listRequests: () => apiJson<PurchaseRequestSummary[]>("/api/procurement/requests"),
  listOrders: () => apiJson<PurchaseOrder[]>("/api/procurement/orders"),
  listDocuments: (type: string) => apiJson<{ documents: ProcurementDocument[] }>(`/api/procurement/documents?type=${encodeURIComponent(type)}`).then((payload) => payload.documents || []),
};
