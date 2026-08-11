import type { EntityKind } from "../../components/business/EntityLink";

export type ProcurementFocus = { entityType: string; entityId: string; at: number } | null;
export type ProcurementNavigate = (moduleId: string, focus?: unknown) => void;
export type ProcurementDocumentType = "pr" | "rfq" | "po" | "grn" | "invoice" | "threeWayMatch";
export type ProcurementDocumentReference = { type: ProcurementDocumentType; id: string; label?: string };
export type ProcurementRfqLine = {
  id: string;
  itemId?: string | null;
  sku?: string | null;
  itemName?: string | null;
  quantity?: number | null;
  unit?: string | null;
  targetUnitPrice?: number | null;
  requiredDate?: string;
  deliveryLocation?: string | null;
};
export type ProcurementQuotationLine = {
  id: string;
  rfqLineId?: string | null;
  sourceQuotationLineId?: string | null;
  itemId?: string | null;
  sku?: string | null;
  itemName?: string | null;
  quantity?: number | null;
  unit?: string | null;
  unitPrice?: number | null;
  amount?: number | null;
  deliveryDate?: string;
};
export type ProcurementQuotationRevision = {
  id: string;
  revisionNumber: number;
  status?: string | null;
  statusRaw?: string | null;
  currency: string;
  quotedAmount?: number | null;
  submittedAt?: string;
  deliveryDate?: string;
  paymentTerms?: string | null;
  validity?: string | null;
  source?: string;
  createdByActorId?: string | null;
  createdAt?: string;
  isLatest: boolean;
  lines: ProcurementQuotationLine[];
};
export type ProcurementRfqQuotation = {
  id: string;
  authorityState: "revision_authoritative" | "revision_missing";
  supplierId?: string | null;
  supplierName?: string | null;
  status?: string | null;
  statusRaw?: string | null;
  quotedAmount?: number | null;
  currency?: string | null;
  submittedAt?: string;
  deliveryDate?: string;
  paymentTerms?: string | null;
  validity?: string | null;
  revisionNumber?: number | null;
  isLatest?: boolean | null;
  lines: ProcurementQuotationLine[];
  latestRevision?: ProcurementQuotationRevision | null;
  revisions: ProcurementQuotationRevision[];
  historicalRevisions: ProcurementQuotationRevision[];
};
export type ProcurementRfqParticipant = {
  participationId?: string | null;
  supplierId: string;
  supplierName?: string | null;
  status?: string | null;
  statusRaw?: string | null;
  participationState: string;
  responseState: "response_recorded" | "no_response" | "declined" | "withdrawn";
  invitedAt?: string;
  respondedAt?: string;
  withdrawnAt?: string;
  authoritySource: "participation" | "quotation";
  quotationIds: string[];
};
export type ProcurementRfqDocument = ProcurementDocument & {
  status: string | null;
  statusRaw?: string | null;
  description?: string | null;
  lines: ProcurementRfqLine[];
  suppliers: {
    participantCount: number;
    responseRecordedCount: number;
    noResponseCount: number;
    invitedInternalCount: number;
    knownParticipants: ProcurementRfqParticipant[];
    participationAuthority: "authoritative";
    invitationDeliveryAuthority: "unavailable";
    externalSupplierIdentityAuthority: "unavailable";
  };
  quotations: ProcurementRfqQuotation[];
  relatedEvidence: Array<{ type: string; id: string; label: string; relation: string }>;
  revisionAuthority: { available: true; immutable: true; latestRule: "maximum_revision_number" };
  limitations: string[];
};
export type RfqComparisonAvailability =
  | "no_eligible_responses"
  | "single_eligible_response"
  | "side_by_side_available"
  | "multi_currency_unconverted";
export type RfqComparisonEligibility =
  | "eligible"
  | "not_ready"
  | "historical_only"
  | "withdrawn"
  | "incomplete_coverage"
  | "authority_missing"
  | "unknown_status";
export type ComparisonRfqLine = {
  rfqLineId: string;
  itemId: string | null;
  sku: string | null;
  itemName: string | null;
  requestedQuantity: string | null;
  unit: string | null;
};
export type ComparisonRevisionLine = {
  revisionLineId: string;
  rfqLineId: string | null;
  lineAuthorityState: "exact_target_rfq_line" | "different_rfq_line" | "unlinked";
  itemId: string | null;
  sku: string | null;
  itemName: string | null;
  quantity: string | null;
  unit: string | null;
  unitPrice: string | null;
  amount: string | null;
  deliveryDate: string | null;
};
export type ComparisonRevision = {
  revisionId: string;
  revisionNumber: number;
  status: string | null;
  statusRaw: string | null;
  currency: string | null;
  quotedAmount: string | null;
  submittedAt: string | null;
  validUntil: string | null;
  deliveryDate: string | null;
  paymentTerms: string | null;
  source: string | null;
  createdAt: string | null;
  lines: ComparisonRevisionLine[];
};
export type ComparisonCoverage = {
  state: "complete" | "partial" | "none" | "not_applicable";
  requiredLineCount: number;
  matchedLineCount: number;
  missingRfqLineIds: string[];
  unmappedLineCount: number;
};
export type ComparisonResponse = {
  quotationId: string;
  supplierId: string;
  supplierName: string | null;
  authorityState: "revision_authoritative" | "revision_missing";
  comparisonEligibility: RfqComparisonEligibility;
  eligibilityReasons: string[];
  latestRevision: ComparisonRevision | null;
  coverage: ComparisonCoverage;
};
export type NonResponseParticipant = {
  participationId: string;
  supplierId: string;
  supplierName: string | null;
  status: string | null;
  statusRaw: string | null;
  invitedAt: string | null;
  respondedAt: string | null;
  withdrawnAt: string | null;
  version: number;
};
export type ComparisonParticipationSummary = {
  participantCount: number;
  plannedCount: number;
  invitedInternalCount: number;
  responseRecordedCount: number;
  noResponseCount: number;
  declinedCount: number;
  withdrawnCount: number;
  closedCount: number;
};
export type RfqComparisonLine = ComparisonRfqLine;
export type RfqComparisonRevisionLine = ComparisonRevisionLine;
export type RfqComparisonResponse = ComparisonResponse;
export type RfqComparisonParticipant = NonResponseParticipant;
export type RfqSupplierComparison = {
  entityType: "RfqSupplierComparison";
  rfqId: string;
  rfqTitle: string | null;
  rfqStatus: string | null;
  rfqStatusRaw: string | null;
  rfqCurrency: string | null;
  generatedAt: string;
  comparisonAvailability: RfqComparisonAvailability;
  commercialAuthority: "supplier_quotation_revision_max_revision_number";
  displayOrderAuthority: "supplier_id_ascending";
  rankingAuthority: "unavailable";
  recommendationAuthority: "unavailable";
  awardAuthority: "unavailable";
  poConversionAuthority: "unavailable";
  participationAuthority: "authoritative";
  invitationDeliveryAuthority: "unavailable";
  externalSupplierIdentityAuthority: "unavailable";
  currencies: string[];
  lines: ComparisonRfqLine[];
  responses: ComparisonResponse[];
  participationSummary: ComparisonParticipationSummary;
  nonResponseParticipants: NonResponseParticipant[];
  summary: {
    quotationCount: number;
    authoritativeResponseCount: number;
    submittedResponseCount: number;
    completeCoverageCount: number;
    eligibleResponseCount: number;
  };
  limitations: string[];
};
export type PurchaseRequestSummary = { id: string; status: string; totalAmount: number };
export type PurchaseOrderLine = { sourcePurchaseRequestLineId: string; itemNameSnapshot: string; estimatedAmount: number };
export type PurchaseOrder = { id: string; status: string; transmissionStatus: string; totalAmount: number; supplierId: string; supplierSnapshot?: { supplierName?: string }; targetWarehouseId?: string; sourcePrId?: string; sourcePurchaseRequestId?: string; lines: PurchaseOrderLine[] };
export type ProcurementDocument = {
  id?: string;
  invoiceNumber?: string;
  relatedPo?: string;
  linkedPr?: string;
  linkedPo?: string;
  po?: string;
  poId?: string;
  supplierName?: string;
  supplierId?: string;
  title?: string;
  itemName?: string;
  quantity?: number;
  unit?: string;
  supplierCount?: number;
  respondedSupplierCount?: number;
  dueDate?: string;
  matchStatus?: string;
  varianceType?: string;
  varianceAmount?: number;
  status?: string;
  arrived?: string;
  createdAt?: string;
  updatedAt?: string;
  receiver?: string;
  warehouse?: string;
  receivedQuantity?: number;
  acceptedQty?: number;
  rejectedQty?: number;
  linkedInvoices?: string[];
  relatedGrn?: string;
  grnId?: string;
  invoiceId?: string;
  invoiceDate?: string;
  invoiceStatus?: string;
  amount?: number;
  currency?: string;
  poAmount?: number;
  invoiceAmount?: number;
  blockingReason?: string;
  exceptionReason?: string;
  relatedDocuments?: ProcurementDocumentReference[];
  evidence?: Array<Record<string, unknown>>;
};
export type ProcurementWorkItem = { id: string; type: string; status: string; amount: number; bucket: "approval" | "tracking"; kind: EntityKind; signals?: string[] };
