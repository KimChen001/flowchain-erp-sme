import { invoiceVarianceLabel, isNoInvoiceVariance } from "../procurement/variance-types";
import type { ContextualAIInsight } from "../../components/ai/ContextualAIInsightPanel";
import { buildContextualAiAction, type ContextualAiAction, type ContextualAiLinkedRecord } from "./actions";
import type { EvidenceBundle } from "../relationships";
import {
  resolveInvoiceMatchingEvidence,
  resolvePoDelayEvidence,
  resolveReceivingExceptionEvidence,
  resolveSkuShortageEvidence,
} from "../relationships";

function linked(type: string, id?: string, label?: string): ContextualAiLinkedRecord[] {
  return id ? [{ type, id, label }] : [];
}

function recordsFromEvidence(bundle: EvidenceBundle): ContextualAiLinkedRecord[] {
  return bundle.linkedRecords.map((record) => ({ type: record.entityType, id: record.entityId, label: record.displayLabel, route: record.route }));
}

function evidenceSummaries(bundle: EvidenceBundle, fallback: string[]) {
  const summaries = bundle.evidence.map((item) => item.summary).filter(Boolean);
  return summaries.length ? summaries : fallback;
}

function limitationMessages(bundle: EvidenceBundle, fallback: string[]) {
  const limitations = bundle.dataLimitations.map((item) => item.message).filter(Boolean);
  return limitations.length ? limitations : fallback;
}

export function poDelayedRisk(eta: string | undefined, status: string, orderedQty: number, receivedQty: number, now = new Date()) {
  if (!eta) return { delayed: false, openQty: Math.max(0, orderedQty - receivedQty), reason: "Missing ETA." };
  const due = new Date(eta.replace(/\//g, "-"));
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startDue = new Date(due.getFullYear(), due.getMonth(), due.getDate());
  const open = !["已完成", "已关闭", "已取消"].includes(status) && receivedQty < orderedQty;
  const delayed = Number.isFinite(startDue.getTime()) && startDue < startToday && open;
  return {
    delayed,
    openQty: Math.max(0, orderedQty - receivedQty),
    reason: delayed ? `ETA ${eta} has passed and open quantity is ${Math.max(0, orderedQty - receivedQty)}.` : "No delayed open quantity detected.",
  };
}

export function makePoInsight(input: {
  po: string;
  supplier: string;
  status: string;
  eta: string;
  orderedQty: number;
  receivedQty: number;
  sourceRequest?: string;
  sourceRfq?: string;
  grns: string[];
  invoices: string[];
}): ContextualAIInsight {
  const risk = poDelayedRisk(input.eta, input.status, input.orderedQty, input.receivedQty);
  const evidenceBundle = resolvePoDelayEvidence({
    purchaseOrders: [{ po: input.po, supplier: input.supplier, status: input.status, eta: input.eta, items: input.orderedQty, received: input.receivedQty, sourceRequest: input.sourceRequest, sourceRfq: input.sourceRfq }],
    receivingDocs: input.grns.map((grn) => ({ grn, po: input.po, supplier: input.supplier })),
    supplierInvoices: input.invoices.map((invoiceNumber) => ({ invoiceNumber, relatedPo: input.po, supplier: input.supplier })),
  }, { po: input.po, supplier: input.supplier, status: input.status, eta: input.eta, items: input.orderedQty, received: input.receivedQty, sourceRequest: input.sourceRequest, sourceRfq: input.sourceRfq });
  const records = recordsFromEvidence(evidenceBundle).length ? recordsFromEvidence(evidenceBundle) : [
    ...linked("purchase_request", input.sourceRequest),
    ...linked("rfq", input.sourceRfq),
    ...input.grns.map((id) => ({ type: "grn", id })),
    ...input.invoices.map((id) => ({ type: "supplier_invoice", id })),
  ];
  const actions: ContextualAiAction[] = [
    buildContextualAiAction({ intent: "explain_po_delay", sourceModule: "procurement", sourceEntityType: "purchase_order", sourceEntityId: input.po, sourceRoute: "procurement:orders", linkedRecords: records }),
    buildContextualAiAction({ intent: "trace_receiving_exception", sourceModule: "procurement", sourceEntityType: "purchase_order", sourceEntityId: input.po, sourceRoute: "procurement:orders", linkedRecords: records, label: `Trace receiving status for ${input.po}` }),
    buildContextualAiAction({ intent: "preview_supplier_followup_draft", sourceModule: "procurement", sourceEntityType: "purchase_order", sourceEntityId: input.po, sourceRoute: "procurement:orders", linkedRecords: records, allowedOutputType: "draft_preview" }),
  ];
  return {
    title: `PO insight · ${input.po}`,
    sourceContext: `Procurement / PO ${input.po}`,
    trigger: "Explain PO delay",
    conclusion: risk.delayed ? `${input.po} is delayed and still open.` : `${input.po} is not currently classified as delayed from the available ETA and receipt data.`,
    riskLevel: risk.delayed ? "高" : "中",
    reason: risk.reason,
    evidence: evidenceSummaries(evidenceBundle, [`Supplier ${input.supplier}`, `Status ${input.status}`, `Ordered ${input.orderedQty}, received ${input.receivedQty}`, `ETA ${input.eta}`]),
    impact: risk.delayed ? ["Open receiving quantity may affect inventory availability and downstream invoice matching."] : ["Continue monitoring receiving and invoice linkage."],
    recommendedActions: actions,
    linkedRecords: records,
    limitations: limitationMessages(evidenceBundle, records.length ? ["Relationship depth depends on current PR/RFQ/GRN/invoice links."] : ["No linked RFQ, GRN, or invoice found in current data."]),
    provenance: "PO detail read model and linked workspace records.",
    auditPreview: "ai_contextual_po_insight_previewed",
  };
}

export function makeSkuInsight(input: {
  sku: string;
  name: string;
  currentStock: number;
  safetyStock: number;
  reorderPoint: number;
  suggestedQty: number;
  supplier?: string;
  movements: string[];
  exceptions: string[];
}): ContextualAIInsight {
  const shortage = input.currentStock < input.safetyStock || input.suggestedQty > 0;
  const evidenceBundle = resolveSkuShortageEvidence({
    inventoryItems: [{ sku: input.sku, name: input.name, qty: input.currentStock, min: input.safetyStock, reorderPoint: input.reorderPoint }],
    inventoryMovements: input.movements.map((movementId) => ({ movementId, sku: input.sku })),
    inventoryExceptions: input.exceptions.map((id) => ({ id, sku: input.sku })),
  }, { sku: input.sku, name: input.name, qty: input.currentStock, min: input.safetyStock, reorderPoint: input.reorderPoint });
  const records = recordsFromEvidence(evidenceBundle).length ? recordsFromEvidence(evidenceBundle) : [
    ...input.movements.map((id) => ({ type: "inventory_movement", id })),
    ...input.exceptions.map((id) => ({ type: "inventory_exception", id })),
    ...linked("supplier", input.supplier),
  ];
  return {
    title: `SKU insight · ${input.sku}`,
    sourceContext: `Inventory / SKU ${input.sku}`,
    trigger: "Explain shortage",
    conclusion: shortage ? `${input.sku} needs replenishment review.` : `${input.sku} is above the shortage threshold in current data.`,
    riskLevel: shortage ? "高" : "低",
    reason: `Available/current stock ${input.currentStock}, safety stock ${input.safetyStock}, reorder point ${input.reorderPoint}.`,
    evidence: evidenceSummaries(evidenceBundle, [`${input.name}`, `Suggested replenishment ${input.suggestedQty}`, `Supplier ${input.supplier || "not specified"}`]),
    impact: shortage ? ["Production or sales orders may be constrained if replenishment is not reviewed."] : ["No immediate replenishment draft is required from current evidence."],
    recommendedActions: [
      buildContextualAiAction({ intent: "explain_sku_shortage", sourceModule: "inventory", sourceEntityType: "inventory_item", sourceEntityId: input.sku, sourceRoute: "inventory", linkedRecords: records }),
      buildContextualAiAction({ intent: "preview_replenishment_draft", sourceModule: "inventory", sourceEntityType: "inventory_item", sourceEntityId: input.sku, sourceRoute: "inventory", linkedRecords: records, allowedOutputType: "draft_preview" }),
    ],
    linkedRecords: records,
    limitations: limitationMessages(evidenceBundle, records.length ? ["Open PO/RFQ coverage is limited to linked records exposed on this page."] : ["No movement, exception, or supplier link found in current data."]),
    provenance: "Inventory detail, planning calculation, and linked movement/exception records.",
    auditPreview: "ai_contextual_sku_insight_previewed",
  };
}

export function makeGrnInsight(input: {
  grn: string;
  po: string;
  supplier: string;
  status: string;
  receivedQty: number;
  rejectedQty: number;
  invoices: string[];
}): ContextualAIInsight {
  const evidenceBundle = resolveReceivingExceptionEvidence({
    receivingDocs: [{ grn: input.grn, po: input.po, supplier: input.supplier, status: input.status, items: input.receivedQty, failed: input.rejectedQty }],
    supplierInvoices: input.invoices.map((invoiceNumber) => ({ invoiceNumber, relatedPo: input.po, relatedGrn: input.grn, supplier: input.supplier })),
  }, { grn: input.grn, po: input.po, supplier: input.supplier, status: input.status, items: input.receivedQty, failed: input.rejectedQty });
  const records = recordsFromEvidence(evidenceBundle).length ? recordsFromEvidence(evidenceBundle) : [{ type: "purchase_order", id: input.po }, ...input.invoices.map((id) => ({ type: "supplier_invoice", id }))];
  return {
    title: `GRN insight · ${input.grn}`,
    sourceContext: `Receiving / GRN ${input.grn}`,
    trigger: "Explain receiving exception",
    conclusion: input.rejectedQty > 0 || input.status === "异常处理" ? `${input.grn} has receiving exception impact to review.` : `${input.grn} has no rejected quantity in current detail.`,
    riskLevel: input.rejectedQty > 0 ? "高" : "中",
    reason: `Received ${input.receivedQty}, rejected ${input.rejectedQty}, status ${input.status}.`,
    evidence: evidenceSummaries(evidenceBundle, [`Supplier ${input.supplier}`, `Linked PO ${input.po}`, `${input.invoices.length} linked invoice(s)`]),
    impact: input.rejectedQty > 0 ? ["Rejected quantity can affect inventory posting, supplier follow-up, and invoice matching."] : ["Receiving status should still be checked before invoice matching closes."],
    recommendedActions: [
      buildContextualAiAction({ intent: "trace_receiving_exception", sourceModule: "receiving", sourceEntityType: "receiving_doc", sourceEntityId: input.grn, sourceRoute: "receiving", linkedRecords: records }),
      buildContextualAiAction({ intent: "preview_exception_note", sourceModule: "receiving", sourceEntityType: "receiving_doc", sourceEntityId: input.grn, sourceRoute: "receiving", linkedRecords: records, allowedOutputType: "draft_preview" }),
    ],
    linkedRecords: records,
    limitations: limitationMessages(evidenceBundle, input.invoices.length ? ["Invoice impact is based on currently linked invoices."] : ["No linked invoice found in current data."]),
    provenance: "GRN detail, receipt lines, and linked invoice records.",
    auditPreview: "ai_contextual_grn_insight_previewed",
  };
}

export function makeInvoiceInsight(input: {
  invoiceNumber: string;
  supplier: string;
  po?: string;
  grn?: string;
  matchStatus: string;
  varianceType: string;
  varianceAmount: number;
}): ContextualAIInsight {
  const evidenceBundle = resolveInvoiceMatchingEvidence({
    supplierInvoices: [{ invoiceNumber: input.invoiceNumber, supplier: input.supplier, relatedPo: input.po, relatedGrn: input.grn, matchStatus: input.matchStatus, varianceType: input.varianceType, varianceAmount: input.varianceAmount }],
  }, { invoiceNumber: input.invoiceNumber, supplier: input.supplier, relatedPo: input.po, relatedGrn: input.grn, matchStatus: input.matchStatus, varianceType: input.varianceType, varianceAmount: input.varianceAmount });
  const records = recordsFromEvidence(evidenceBundle).length ? recordsFromEvidence(evidenceBundle) : [...linked("purchase_order", input.po), ...linked("grn", input.grn)];
  return {
    title: `Invoice matching insight · ${input.invoiceNumber}`,
    sourceContext: `Invoice Matching / ${input.invoiceNumber}`,
    trigger: "Explain matching failure",
    conclusion: input.varianceAmount || !isNoInvoiceVariance(input.varianceType) ? `${input.invoiceNumber} needs matching review before approval or posting.` : `${input.invoiceNumber} is currently aligned by available matching data.`,
    riskLevel: input.varianceAmount ? "高" : "低",
    reason: `Match status ${input.matchStatus}, variance ${invoiceVarianceLabel(input.varianceType, "en-US")}, amount ${input.varianceAmount}.`,
    evidence: evidenceSummaries(evidenceBundle, [`Supplier ${input.supplier}`, `PO ${input.po || "missing"}`, `GRN ${input.grn || "missing"}`]),
    impact: input.varianceAmount ? ["Do not approve, pay, or post until PO/GRN/invoice variance is resolved."] : ["Keep standard AP review before posting or payment."],
    recommendedActions: [
      buildContextualAiAction({ intent: "trace_invoice_matching_failure", sourceModule: "finance", sourceEntityType: "supplier_invoice", sourceEntityId: input.invoiceNumber, sourceRoute: "finance:invoices", linkedRecords: records }),
      buildContextualAiAction({ intent: "preview_invoice_resolution_note", sourceModule: "finance", sourceEntityType: "supplier_invoice", sourceEntityId: input.invoiceNumber, sourceRoute: "finance:invoices", linkedRecords: records, allowedOutputType: "draft_preview" }),
    ],
    linkedRecords: records,
    limitations: limitationMessages(evidenceBundle, records.length === 2 ? ["Variance depends on available PO and GRN line fields."] : ["Missing PO or GRN link limits variance explanation."]),
    provenance: "Supplier invoice detail and deterministic three-way match calculation.",
    auditPreview: "ai_contextual_invoice_insight_previewed",
  };
}
