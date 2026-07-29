import type { EntityKind } from "../../components/business/EntityLink";

export type ProcurementFocus = { entityType: string; entityId: string; at: number } | null;
export type ProcurementNavigate = (moduleId: string, focus?: unknown) => void;
export type PurchaseRequestSummary = { id: string; status: string; totalAmount: number };
export type PurchaseOrderLine = { sourcePurchaseRequestLineId: string; itemNameSnapshot: string; estimatedAmount: number };
export type PurchaseOrder = { id: string; status: string; transmissionStatus: string; totalAmount: number; supplierId: string; supplierSnapshot?: { supplierName?: string }; targetWarehouseId?: string; sourcePrId?: string; sourcePurchaseRequestId?: string; lines: PurchaseOrderLine[] };
export type ProcurementDocument = { id?: string; invoiceNumber?: string; relatedPo?: string; matchStatus?: string; varianceType?: string; varianceAmount?: number; status?: string };
export type ProcurementWorkItem = { id: string; type: string; status: string; amount: number; bucket: "approval" | "tracking"; kind: EntityKind; signals?: string[] };
