import type { EvidenceBundle, EvidenceItem, EvidenceRiskLevel, RelationshipEntityType } from "./model";
import { resolveEntityRelationships, type RelationshipResolverContext } from "./resolver";

function text(value: unknown) {
  return String(value ?? "").trim();
}

function riskLevelFromChinese(value: unknown): EvidenceRiskLevel {
  const raw = text(value);
  if (raw === "高" || raw === "high") return "high";
  if (raw === "中" || raw === "medium") return "medium";
  if (raw === "低" || raw === "low") return "low";
  return "none";
}

function reason(value: unknown, fallback: string) {
  const raw = text(value);
  if (!raw || ["高", "中", "低", "high", "medium", "low"].includes(raw)) return fallback;
  return raw;
}

function evidenceItem(input: EvidenceItem): EvidenceItem {
  return {
    ...input,
    reason: reason(input.reason, "Current data does not provide a separate reason beyond the measured status."),
  };
}

function bundle(context: RelationshipResolverContext, entityType: RelationshipEntityType, entityId: string, evidence: EvidenceItem[]): EvidenceBundle {
  const graph = resolveEntityRelationships({ context, sourceEntityType: entityType, sourceEntityId: entityId });
  return {
    sourceEntityType: entityType,
    sourceEntityId: entityId,
    evidence: evidence.map(evidenceItem),
    relationships: graph.relationships,
    linkedRecords: graph.linkedRecords,
    dataLimitations: graph.dataLimitations,
  };
}

export function resolvePoDelayEvidence(context: RelationshipResolverContext, po: any): EvidenceBundle {
  const poId = text(po?.po || po?.id);
  const ordered = Number(po?.totalOrderedQty ?? po?.items ?? 0);
  const received = Number(po?.totalReceivedQty ?? po?.received ?? 0);
  const openQty = Math.max(0, ordered - received);
  const delayed = !["已完成", "已关闭", "已取消"].includes(text(po?.status)) && openQty > 0;
  return bundle(context, "purchaseOrder", poId, [
    evidenceItem({
      id: `${poId}:delay`,
      title: "PO delay evidence",
      sourceModule: "procurement",
      sourceEntityType: "purchaseOrder",
      sourceEntityId: poId,
      evidenceType: "po_delay",
      summary: `${poId} status ${text(po?.status) || "unknown"}, open quantity ${openQty}.`,
      metric: openQty,
      riskLevel: delayed ? "high" : "low",
      reason: delayed ? `Open quantity ${openQty} remains against ETA ${text(po?.eta) || "missing"}.` : "No delayed open quantity detected from current PO quantities.",
      route: "procurement:orders",
    }),
  ]);
}

export function resolveSkuShortageEvidence(context: RelationshipResolverContext, item: any): EvidenceBundle {
  const sku = text(item?.sku || item?.id);
  const current = Number(item?.qty ?? item?.availableQuantity ?? 0);
  const safety = Number(item?.min ?? item?.safetyStock ?? 0);
  const reorderPoint = Number(item?.reorderPoint ?? item?.min ?? 0);
  const shortage = current < safety || current < reorderPoint;
  return bundle(context, "sku", sku, [
    evidenceItem({
      id: `${sku}:shortage`,
      title: "SKU shortage evidence",
      sourceModule: "inventory",
      sourceEntityType: "sku",
      sourceEntityId: sku,
      evidenceType: "sku_shortage",
      summary: `${sku} current ${current}, safety ${safety}, reorder point ${reorderPoint}.`,
      metric: current,
      riskLevel: shortage ? "high" : "low",
      reason: shortage ? `Current stock ${current} is below safety/reorder threshold.` : "Current stock is not below the configured shortage threshold.",
      route: "inventory",
    }),
  ]);
}

export function resolveSupplierRiskEvidence(context: RelationshipResolverContext, supplier: string): EvidenceBundle {
  const graph = resolveEntityRelationships({ context, sourceEntityType: "supplier", sourceEntityId: supplier });
  const risky = graph.relationships.filter((relationship) => /差异|异常|待复核|逾期|高/.test(`${relationship.linkedRecord?.status || ""} ${relationship.relationshipLabel}`));
  return {
    sourceEntityType: "supplier",
    sourceEntityId: supplier,
    evidence: [evidenceItem({
      id: `${supplier}:supplier-risk`,
      title: "Supplier risk evidence",
      sourceModule: "srm",
      sourceEntityType: "supplier",
      sourceEntityId: supplier,
      evidenceType: "supplier_risk",
      summary: `${supplier} has ${graph.relationships.length} linked business records and ${risky.length} risk signals.`,
      metric: risky.length,
      riskLevel: risky.length ? "medium" : "low",
      reason: risky.length ? "Linked PO/GRN/invoice records include exception or variance statuses." : "No linked variance or exception status found in current relationships.",
      route: "srm:master",
    })],
    relationships: graph.relationships,
    linkedRecords: graph.linkedRecords,
    dataLimitations: graph.dataLimitations,
  };
}

export function resolveReceivingExceptionEvidence(context: RelationshipResolverContext, grn: any): EvidenceBundle {
  const grnId = text(grn?.grn || grn?.id);
  const failed = Number(grn?.failed ?? grn?.rejectedQty ?? 0);
  return bundle(context, "grn", grnId, [
    evidenceItem({
      id: `${grnId}:receiving-exception`,
      title: "Receiving exception evidence",
      sourceModule: "receiving",
      sourceEntityType: "grn",
      sourceEntityId: grnId,
      evidenceType: "receiving_exception",
      summary: `${grnId} status ${text(grn?.status) || "unknown"}, rejected ${failed}.`,
      metric: failed,
      riskLevel: failed > 0 || text(grn?.status) === "异常处理" ? "high" : "low",
      reason: failed > 0 ? `Rejected quantity ${failed} requires receiving and invoice review.` : "No rejected quantity found in current GRN detail.",
      route: "procurement:receiving",
    }),
  ]);
}

export function resolveInvoiceMatchingEvidence(context: RelationshipResolverContext, invoice: any): EvidenceBundle {
  const id = text(invoice?.invoiceNumber || invoice?.id);
  const variance = Number(invoice?.varianceAmount ?? invoice?.variance ?? 0);
  const status = text(invoice?.matchStatus || invoice?.status);
  return bundle(context, "invoice", id, [
    evidenceItem({
      id: `${id}:invoice-match`,
      title: "Invoice matching evidence",
      sourceModule: "procurement",
      sourceEntityType: "invoice",
      sourceEntityId: id,
      evidenceType: "invoice_matching",
      summary: `${id} match status ${status || "unknown"}, variance ${variance}.`,
      metric: variance,
      riskLevel: variance || /差异|人工复核|未匹配/.test(status) ? "high" : "low",
      reason: variance ? `Variance amount ${variance} must be resolved before approval, AP posting, or payment.` : "No variance amount found in current invoice matching data.",
      route: "procurement:bills",
    }),
  ]);
}

export function resolveRfqTimingEvidence(context: RelationshipResolverContext, rfq: any): EvidenceBundle {
  const id = text(rfq?.id || rfq?.rfqId);
  const quoted = Number(rfq?.quoted ?? 0);
  const suppliers = Number(rfq?.suppliers ?? 0);
  const incomplete = suppliers > 0 && quoted < suppliers;
  return bundle(context, "rfq", id, [
    evidenceItem({
      id: `${id}:rfq-timing`,
      title: "RFQ timing evidence",
      sourceModule: "procurement",
      sourceEntityType: "rfq",
      sourceEntityId: id,
      evidenceType: "rfq_timing",
      summary: `${id} has ${quoted}/${suppliers} supplier responses.`,
      metric: `${quoted}/${suppliers}`,
      riskLevel: incomplete ? "medium" : "low",
      reason: incomplete ? `Only ${quoted} of ${suppliers} invited suppliers have responded.` : "RFQ response count is complete in current data.",
      route: "procurement:rfq",
    }),
  ]);
}

export { riskLevelFromChinese };
