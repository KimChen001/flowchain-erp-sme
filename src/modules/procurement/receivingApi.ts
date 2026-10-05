import type { SuggestionTrail } from "../../lib/prefill";
import { apiJson } from "../../lib/api-client";

// Desktop receiving commands. Quantities travel as decimal strings; the server
// checks permission, warehouse scope, version and over-receipt on every call.
export type ReceivableLine = { id: string; sku: string; itemName: string; orderedQuantity: string; receivedQuantity: string; remainingQuantity: string; unit?: string | null };
export type ReceivablePurchaseOrder = { id: string; status: string; version: number; receivable: boolean; supplierName?: string | null; currency?: string | null; defaultWarehouseId?: string | null; lines: ReceivableLine[] };
export type ReceivingWarehouse = { id: string; code: string; name: string };
export type ReceiptLineInput = { purchaseOrderLineId: string; acceptedQuantity: string; rejectedQuantity: string; rejectionReason: string; location: string };
export type ReceiptInput = { warehouseId: string; arrivedAt: string; note?: string; lines: ReceiptLineInput[]; suggestionTrail?: SuggestionTrail | null };
export type ReceiptSummary = { id: string; documentNumber: string; poId: string; workflowStatus: string; postingStatus: string; version: number };
export type ReceiptCommandResult = { entityId: string; receivingDocument: ReceiptSummary; idempotentReplay?: boolean };
export type ReceiptListItem = ReceiptSummary & {
  supplierName?: string | null; receiver?: string | null; currency?: string | null;
  warehouse?: ReceivingWarehouse | null; arrivedAt?: string | null; postedAt?: string | null; createdAt?: string | null;
  lineCount: number; acceptedQuantity: string; rejectedQuantity: string;
};

const json = (method: string, body: unknown) => ({ method, body: JSON.stringify(body) });

export const receivingApi = {
  list: (purchaseOrderId?: string) =>
    apiJson<{ items: ReceiptListItem[] }>(`/api/procurement/receiving${purchaseOrderId ? `?poId=${encodeURIComponent(purchaseOrderId)}` : ""}`).then((payload) => payload.items || []),
  receivableLines: (purchaseOrderId: string) =>
    apiJson<{ purchaseOrder: ReceivablePurchaseOrder; warehouses: ReceivingWarehouse[] }>(`/api/procurement/purchase-orders/${encodeURIComponent(purchaseOrderId)}/receivable-lines`),
  create: (purchaseOrderId: string, input: ReceiptInput, idempotencyKey: string) =>
    apiJson<ReceiptCommandResult>("/api/procurement/receiving", json("POST", { ...input, poId: purchaseOrderId, idempotencyKey })),
  revise: (receiptId: string, input: ReceiptInput, expectedVersion: number, idempotencyKey: string) =>
    apiJson<ReceiptCommandResult>(`/api/procurement/receiving/${encodeURIComponent(receiptId)}`, json("PATCH", { ...input, expectedVersion, idempotencyKey })),
  submit: (receiptId: string, expectedVersion: number, idempotencyKey: string) =>
    apiJson<ReceiptCommandResult>(`/api/procurement/receiving/${encodeURIComponent(receiptId)}/submit`, json("POST", { expectedVersion, idempotencyKey })),
};
