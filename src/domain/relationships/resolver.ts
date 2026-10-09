import { resolveBusinessLinkedRecord, type BusinessLinkedRecordInput } from "../../lib/businessLinks";
import type {
  BusinessRelationship,
  DataLimitation,
  RelationshipEntityType,
  RelationshipGraph,
  RelationshipType,
} from "./model";
import { groupRelationships } from "./model";

export type RelationshipResolverContext = {
  purchaseRequests?: any[];
  rfqs?: any[];
  purchaseOrders?: any[];
  receivingDocs?: any[];
  supplierInvoices?: any[];
  inventoryItems?: any[];
  inventoryMovements?: any[];
  inventoryExceptions?: any[];
  suppliers?: any[];
  auditEvents?: any[];
};

export type RelationshipResolverInput = {
  context: RelationshipResolverContext;
  sourceEntityType: RelationshipEntityType;
  sourceEntityId: string;
  maxDepth?: 1 | 2;
};

function text(value: unknown) {
  return String(value ?? "").trim();
}

function firstText(...values: unknown[]) {
  for (const value of values) {
    const next = text(value);
    if (next && next !== "—") return next;
  }
  return "";
}

function asArray<T = any>(value: unknown): T[] {
  return Array.isArray(value) ? value as T[] : [];
}

function norm(value: unknown) {
  return text(value).toLowerCase();
}

function poId(po: any) {
  return firstText(po?.po, po?.id, po?.poId);
}

function prId(pr: any) {
  return firstText(pr?.pr, pr?.id, pr?.prId);
}

function rfqId(rfq: any) {
  return firstText(rfq?.id, rfq?.rfqId);
}

function grnId(grn: any) {
  return firstText(grn?.grn, grn?.id, grn?.grnId, grn?.receivingId);
}

function invoiceId(invoice: any) {
  return firstText(invoice?.invoiceNumber, invoice?.id, invoice?.invoiceId);
}

function skuId(item: any) {
  return firstText(item?.sku, item?.sourceSku, item?.itemSku, item?.itemIdOrSku, item?.id);
}

function supplierId(row: any) {
  return firstText(row?.supplier, row?.supplierName, row?.supplierId, row?.name, row?.code, row?.id);
}

function routeType(entityType: RelationshipEntityType) {
  if (entityType === "purchaseOrder") return "purchaseOrder";
  if (entityType === "purchaseRequest") return "purchaseRequest";
  if (entityType === "receivingDocument") return "grn";
  if (entityType === "invoiceMatch") return "invoice";
  return entityType;
}

function limitation(code: string, message: string, entityType: RelationshipEntityType, entityId: string, relationshipType?: RelationshipType): DataLimitation {
  return { code, message, entityType, entityId, relationshipType };
}

function displayLabel(entityType: RelationshipEntityType, entityId: string, row?: any) {
  if (entityType === "sku" || entityType === "item") return firstText(row?.name, row?.sourceName, entityId);
  if (entityType === "supplier") return firstText(row?.supplier, row?.supplierName, row?.name, entityId);
  return entityId;
}

function makeRelationship(input: {
  sourceEntityType: RelationshipEntityType;
  sourceEntityId: string;
  targetEntityType: RelationshipEntityType;
  targetEntityId: string;
  targetDisplayLabel?: string;
  relationshipType: RelationshipType;
  relationshipLabel: string;
  relationshipReason?: string;
  evidenceSource: string;
  confidence?: "high" | "medium" | "low";
  status?: string;
  recordFound?: boolean;
  dataLimitation?: DataLimitation;
}) {
  const linkedRecordInput: BusinessLinkedRecordInput = {
    type: routeType(input.targetEntityType),
    id: input.targetEntityId,
    displayLabel: input.targetDisplayLabel || input.targetEntityId,
    relationshipLabel: input.relationshipLabel,
    relationshipReason: input.relationshipReason || input.evidenceSource,
    status: input.status,
    recordFound: input.recordFound,
  };
  const linkedRecord = resolveBusinessLinkedRecord(linkedRecordInput);
  const id = [
    input.sourceEntityType,
    input.sourceEntityId,
    input.relationshipType,
    input.targetEntityType,
    input.targetEntityId,
  ].join(":");
  return {
    id,
    sourceEntityType: input.sourceEntityType,
    sourceEntityId: input.sourceEntityId,
    targetEntityType: input.targetEntityType,
    targetEntityId: input.targetEntityId,
    targetDisplayLabel: input.targetDisplayLabel || input.targetEntityId,
    targetModule: linkedRecord.module,
    relationshipType: input.relationshipType,
    relationshipLabel: input.relationshipLabel,
    confidence: input.confidence || "high",
    evidenceSource: input.evidenceSource,
    route: linkedRecord.route,
    linkedRecord,
    dataLimitation: input.dataLimitation || (linkedRecord.disabledReason ? limitation(linkedRecord.disabledReason === "Route not available yet" ? "route_not_available" : "record_not_found", linkedRecord.disabledReason, input.targetEntityType, input.targetEntityId, input.relationshipType) : undefined),
  } satisfies BusinessRelationship;
}

function uniqueRelationships(relationships: BusinessRelationship[]) {
  const seen = new Set<string>();
  return relationships.filter((relationship) => {
    if (seen.has(relationship.id)) return false;
    seen.add(relationship.id);
    return true;
  });
}

function matchesSku(row: any, sku: string) {
  const wanted = norm(sku);
  if (!wanted) return false;
  if (norm(row?.sourceSku) === wanted || norm(row?.sku) === wanted || norm(row?.itemSku) === wanted) return true;
  return asArray(row?.lines).some((line: any) => norm(line?.sku) === wanted);
}

function poContainsSku(po: any, sku: string) {
  return matchesSku(po, sku);
}

function invoiceContainsSku(invoice: any, sku: string) {
  return asArray(invoice?.lines).some((line: any) => norm(line?.sku) === norm(sku));
}

function resolveForPo(context: RelationshipResolverContext, po: any, sourceId: string) {
  const relationships: BusinessRelationship[] = [];
  const limitations: DataLimitation[] = [];
  const sourceEntityType = "purchaseOrder";
  const sourceEntityId = sourceId;
  const sourcePr = firstText(po?.sourceRequest, po?.linkedPr);
  const sourceRfq = firstText(po?.sourceRfq, po?.linkedRfq);
  const sourceSku = firstText(po?.sourceSku, asArray(po?.lines)[0]?.sku);
  const supplier = supplierId(po);

  if (sourcePr) {
    const found = asArray(context.purchaseRequests).some((pr) => prId(pr) === sourcePr);
    relationships.push(makeRelationship({ sourceEntityType, sourceEntityId, targetEntityType: "purchaseRequest", targetEntityId: sourcePr, relationshipType: "created_from", relationshipLabel: "Created from", evidenceSource: "PO sourceRequest", recordFound: found }));
  } else {
    limitations.push(limitation("missing_source_pr", `${sourceId} has no source PR link in current data.`, sourceEntityType, sourceEntityId, "created_from"));
  }

  if (sourceRfq) {
    const found = asArray(context.rfqs).some((rfq) => rfqId(rfq) === sourceRfq);
    relationships.push(makeRelationship({ sourceEntityType, sourceEntityId, targetEntityType: "rfq", targetEntityId: sourceRfq, relationshipType: "sourced_by_rfq", relationshipLabel: "Created from", evidenceSource: "PO sourceRfq", recordFound: found }));
  } else {
    limitations.push(limitation("missing_rfq_link", `${sourceId} has no RFQ link in current data.`, sourceEntityType, sourceEntityId, "sourced_by_rfq"));
  }

  if (sourceSku) {
    relationships.push(makeRelationship({ sourceEntityType, sourceEntityId, targetEntityType: "sku", targetEntityId: sourceSku, targetDisplayLabel: firstText(po?.sourceName, sourceSku), relationshipType: "contains_item", relationshipLabel: "Affects inventory", evidenceSource: "PO source SKU or line SKU" }));
  }

  if (supplier) {
    relationships.push(makeRelationship({ sourceEntityType, sourceEntityId, targetEntityType: "supplier", targetEntityId: supplier, relationshipType: "related_supplier", relationshipLabel: "Supplier relationship", evidenceSource: "PO supplier header" }));
  }

  const grns = asArray(context.receivingDocs).filter((grn) => grn?.po === sourceId || grn?.poId === sourceId || grn?.relatedPo === sourceId);
  if (!grns.length) limitations.push(limitation("missing_grn", `${sourceId} has no linked GRN in current data.`, sourceEntityType, sourceEntityId, "received_by"));
  for (const grn of grns) {
    relationships.push(makeRelationship({ sourceEntityType, sourceEntityId, targetEntityType: "grn", targetEntityId: grnId(grn), relationshipType: "received_by", relationshipLabel: "Receives PO", evidenceSource: "GRN po reference", status: text(grn?.status) }));
  }

  const invoices = asArray(context.supplierInvoices).filter((invoice) => invoice?.relatedPo === sourceId || invoice?.poId === sourceId || invoice?.po === sourceId);
  if (!invoices.length) limitations.push(limitation("missing_invoice_match", `${sourceId} has no linked invoice in current data.`, sourceEntityType, sourceEntityId, "matched_to_invoice"));
  for (const invoice of invoices) {
    relationships.push(makeRelationship({ sourceEntityType, sourceEntityId, targetEntityType: "invoice", targetEntityId: invoiceId(invoice), relationshipType: "matched_to_invoice", relationshipLabel: "Matches invoice", evidenceSource: "Invoice relatedPo", status: text(invoice?.matchStatus || invoice?.status) }));
  }

  const movements = asArray(context.inventoryMovements).filter((movement) => movement?.relatedPo === sourceId);
  for (const movement of movements) {
    relationships.push(makeRelationship({ sourceEntityType, sourceEntityId, targetEntityType: "inventoryMovement", targetEntityId: firstText(movement?.movementId, movement?.id), relationshipType: "affects_inventory", relationshipLabel: "Affects inventory", evidenceSource: "Inventory movement relatedPo", status: text(movement?.status) }));
  }

  return { relationships, limitations };
}

function resolveForSku(context: RelationshipResolverContext, sku: string) {
  const relationships: BusinessRelationship[] = [];
  const limitations: DataLimitation[] = [];
  const sourceEntityType = "sku";
  const sourceEntityId = sku;
  const item = asArray(context.inventoryItems).find((row) => norm(skuId(row)) === norm(sku));
  if (!item) limitations.push(limitation("missing_inventory_balance", `${sku} has no inventory balance in current data.`, sourceEntityType, sourceEntityId));
  const lotsSupplier = asArray(context.inventoryItems).find((row) => norm(skuId(row)) === norm(sku));
  const supplier = supplierId(lotsSupplier);
  if (supplier) relationships.push(makeRelationship({ sourceEntityType, sourceEntityId, targetEntityType: "supplier", targetEntityId: supplier, relationshipType: "supplied_by", relationshipLabel: "Supplied by", evidenceSource: "Inventory item supplier" }));

  for (const po of asArray(context.purchaseOrders).filter((row) => poContainsSku(row, sku))) {
    relationships.push(makeRelationship({ sourceEntityType, sourceEntityId, targetEntityType: "purchaseOrder", targetEntityId: poId(po), relationshipType: "contains_item", relationshipLabel: "Contained in PO", evidenceSource: "PO source SKU or line SKU", status: text(po?.status) }));
    if (supplierId(po)) relationships.push(makeRelationship({ sourceEntityType, sourceEntityId, targetEntityType: "supplier", targetEntityId: supplierId(po), relationshipType: "supplied_by", relationshipLabel: "Supplied by", evidenceSource: "PO supplier for SKU", confidence: "medium" }));
  }
  for (const pr of asArray(context.purchaseRequests).filter((row) => matchesSku(row, sku))) {
    relationships.push(makeRelationship({ sourceEntityType, sourceEntityId, targetEntityType: "purchaseRequest", targetEntityId: prId(pr), relationshipType: "requested_item", relationshipLabel: "Requested item", evidenceSource: "PR source SKU", status: text(pr?.status) }));
  }
  for (const rfq of asArray(context.rfqs).filter((row) => matchesSku(row, sku) || text(row?.title).includes(sku))) {
    relationships.push(makeRelationship({ sourceEntityType, sourceEntityId, targetEntityType: "rfq", targetEntityId: rfqId(rfq), relationshipType: "sourced_by_rfq", relationshipLabel: "Sourced by RFQ", evidenceSource: "RFQ title or source SKU", status: text(rfq?.status) }));
  }
  for (const movement of asArray(context.inventoryMovements).filter((row) => norm(row?.sku) === norm(sku))) {
    relationships.push(makeRelationship({ sourceEntityType, sourceEntityId, targetEntityType: "inventoryMovement", targetEntityId: firstText(movement?.movementId, movement?.id), relationshipType: "affects_inventory", relationshipLabel: "Affects inventory", evidenceSource: "Inventory movement SKU", status: text(movement?.status) }));
  }
  for (const invoice of asArray(context.supplierInvoices).filter((row) => invoiceContainsSku(row, sku))) {
    relationships.push(makeRelationship({ sourceEntityType, sourceEntityId, targetEntityType: "invoice", targetEntityId: invoiceId(invoice), relationshipType: "matched_to_invoice", relationshipLabel: "Matches invoice", evidenceSource: "Invoice line SKU", status: text(invoice?.matchStatus || invoice?.status) }));
  }
  return { relationships, limitations };
}

function resolveForGrn(context: RelationshipResolverContext, grn: any, sourceId: string) {
  const relationships: BusinessRelationship[] = [];
  const limitations: DataLimitation[] = [];
  const sourceEntityType = "grn";
  const sourceEntityId = sourceId;
  const po = firstText(grn?.po, grn?.poId, grn?.relatedPo);
  if (po) relationships.push(makeRelationship({ sourceEntityType, sourceEntityId, targetEntityType: "purchaseOrder", targetEntityId: po, relationshipType: "received_by", relationshipLabel: "Receives PO", evidenceSource: "GRN po reference" }));
  const supplier = supplierId(grn);
  if (supplier) relationships.push(makeRelationship({ sourceEntityType, sourceEntityId, targetEntityType: "supplier", targetEntityId: supplier, relationshipType: "related_supplier", relationshipLabel: "Supplier relationship", evidenceSource: "GRN supplier" }));
  for (const line of asArray(grn?.lines)) {
    if (line?.sku) relationships.push(makeRelationship({ sourceEntityType, sourceEntityId, targetEntityType: "sku", targetEntityId: text(line.sku), targetDisplayLabel: firstText(line.itemName, line.name, line.sku), relationshipType: "affects_inventory", relationshipLabel: "Affects inventory", evidenceSource: "GRN line SKU" }));
  }
  for (const movement of asArray(context.inventoryMovements).filter((row) => row?.relatedGrn === sourceId || row?.sourceDocument === sourceId)) {
    relationships.push(makeRelationship({ sourceEntityType, sourceEntityId, targetEntityType: "inventoryMovement", targetEntityId: firstText(movement?.movementId, movement?.id), relationshipType: "affects_inventory", relationshipLabel: "Affects inventory", evidenceSource: "Inventory movement relatedGrn", status: text(movement?.status) }));
  }
  const invoices = asArray(context.supplierInvoices).filter((invoice) => invoice?.relatedGrn === sourceId || (po && invoice?.relatedPo === po));
  if (!invoices.length) limitations.push(limitation("missing_invoice_match", `${sourceId} has no linked invoice in current data.`, sourceEntityType, sourceEntityId, "matched_to_invoice"));
  for (const invoice of invoices) {
    relationships.push(makeRelationship({ sourceEntityType, sourceEntityId, targetEntityType: "invoice", targetEntityId: invoiceId(invoice), relationshipType: "matched_to_invoice", relationshipLabel: "Matches invoice", evidenceSource: "Invoice relatedGrn or relatedPo", status: text(invoice?.matchStatus || invoice?.status) }));
  }
  return { relationships, limitations };
}

function resolveForInvoice(context: RelationshipResolverContext, invoice: any, sourceId: string) {
  const relationships: BusinessRelationship[] = [];
  const limitations: DataLimitation[] = [];
  const sourceEntityType = "invoice";
  const sourceEntityId = sourceId;
  const po = firstText(invoice?.relatedPo, invoice?.po, invoice?.poId);
  const grn = firstText(invoice?.relatedGrn, invoice?.grn, invoice?.grnId);
  if (po) relationships.push(makeRelationship({ sourceEntityType, sourceEntityId, targetEntityType: "purchaseOrder", targetEntityId: po, relationshipType: "matched_to_invoice", relationshipLabel: "Source document", evidenceSource: "Invoice relatedPo" }));
  else limitations.push(limitation("missing_invoice_match", `${sourceId} has no linked PO in current data.`, sourceEntityType, sourceEntityId, "matched_to_invoice"));
  if (grn) relationships.push(makeRelationship({ sourceEntityType, sourceEntityId, targetEntityType: "grn", targetEntityId: grn, relationshipType: "matched_to_invoice", relationshipLabel: "Source document", evidenceSource: "Invoice relatedGrn" }));
  else limitations.push(limitation("missing_grn", `${sourceId} has no linked GRN in current data.`, sourceEntityType, sourceEntityId, "matched_to_invoice"));
  const supplier = supplierId(invoice);
  if (supplier) relationships.push(makeRelationship({ sourceEntityType, sourceEntityId, targetEntityType: "supplier", targetEntityId: supplier, relationshipType: "related_supplier", relationshipLabel: "Supplier relationship", evidenceSource: "Invoice supplier" }));
  for (const line of asArray(invoice?.lines)) {
    if (line?.sku) relationships.push(makeRelationship({ sourceEntityType, sourceEntityId, targetEntityType: "sku", targetEntityId: text(line.sku), targetDisplayLabel: firstText(line.name, line.itemName, line.sku), relationshipType: "contains_item", relationshipLabel: "Matches invoice", evidenceSource: "Invoice line SKU" }));
  }
  relationships.push(makeRelationship({ sourceEntityType, sourceEntityId, targetEntityType: "invoiceMatch", targetEntityId: sourceId, relationshipType: "matched_to_invoice", relationshipLabel: "Matches invoice", evidenceSource: "Invoice matching status", status: text(invoice?.matchStatus) }));
  return { relationships, limitations };
}

function resolveForSupplier(context: RelationshipResolverContext, supplier: string) {
  const relationships: BusinessRelationship[] = [];
  const limitations: DataLimitation[] = [];
  const sourceEntityType = "supplier";
  const sourceEntityId = supplier;
  for (const po of asArray(context.purchaseOrders).filter((row) => norm(supplierId(row)) === norm(supplier))) {
    relationships.push(makeRelationship({ sourceEntityType, sourceEntityId, targetEntityType: "purchaseOrder", targetEntityId: poId(po), relationshipType: "related_supplier", relationshipLabel: "Supplier relationship", evidenceSource: "PO supplier", status: text(po?.status) }));
    const sku = firstText(po?.sourceSku, asArray(po?.lines)[0]?.sku);
    if (sku) relationships.push(makeRelationship({ sourceEntityType, sourceEntityId, targetEntityType: "sku", targetEntityId: sku, targetDisplayLabel: firstText(po?.sourceName, sku), relationshipType: "supplied_by", relationshipLabel: "Supplies item", evidenceSource: "PO supplier and SKU", confidence: "medium" }));
  }
  for (const rfq of asArray(context.rfqs).filter((row) => norm(row?.bestSupplier) === norm(supplier) || asArray(row?.supplierNames).some((name) => norm(name) === norm(supplier)))) {
    relationships.push(makeRelationship({ sourceEntityType, sourceEntityId, targetEntityType: "rfq", targetEntityId: rfqId(rfq), relationshipType: "sourced_by_rfq", relationshipLabel: "Supplier relationship", evidenceSource: "RFQ supplier", status: text(rfq?.status) }));
  }
  for (const grn of asArray(context.receivingDocs).filter((row) => norm(supplierId(row)) === norm(supplier))) {
    relationships.push(makeRelationship({ sourceEntityType, sourceEntityId, targetEntityType: "grn", targetEntityId: grnId(grn), relationshipType: "received_by", relationshipLabel: "Receives PO", evidenceSource: "GRN supplier", status: text(grn?.status) }));
  }
  for (const invoice of asArray(context.supplierInvoices).filter((row) => norm(supplierId(row)) === norm(supplier))) {
    relationships.push(makeRelationship({ sourceEntityType, sourceEntityId, targetEntityType: "invoice", targetEntityId: invoiceId(invoice), relationshipType: "matched_to_invoice", relationshipLabel: "Matches invoice", evidenceSource: "Invoice supplier", status: text(invoice?.matchStatus || invoice?.status) }));
  }
  if (!relationships.length) limitations.push(limitation("missing_relationship", `${supplier} has no linked PO/RFQ/GRN/invoice in current data.`, sourceEntityType, sourceEntityId));
  return { relationships, limitations };
}

function resolveForRfq(context: RelationshipResolverContext, rfq: any, sourceId: string) {
  const relationships: BusinessRelationship[] = [];
  const limitations: DataLimitation[] = [];
  const sourceEntityType = "rfq";
  const sourceEntityId = sourceId;
  const pr = firstText(rfq?.sourceRequest, rfq?.linkedPr, rfq?.prId);
  const po = firstText(rfq?.linkedPo, rfq?.poId);
  if (pr) relationships.push(makeRelationship({ sourceEntityType, sourceEntityId, targetEntityType: "purchaseRequest", targetEntityId: pr, relationshipType: "created_from", relationshipLabel: "Created from", evidenceSource: "RFQ sourceRequest" }));
  else limitations.push(limitation("missing_source_pr", `${sourceId} has no source PR link in current data.`, sourceEntityType, sourceEntityId, "created_from"));
  if (po) relationships.push(makeRelationship({ sourceEntityType, sourceEntityId, targetEntityType: "purchaseOrder", targetEntityId: po, relationshipType: "awarded_to_po", relationshipLabel: "Awarded to PO", evidenceSource: "RFQ linkedPo" }));
  const supplier = supplierId({ supplier: rfq?.bestSupplier });
  if (supplier) relationships.push(makeRelationship({ sourceEntityType, sourceEntityId, targetEntityType: "supplier", targetEntityId: supplier, relationshipType: "related_supplier", relationshipLabel: "Supplier relationship", evidenceSource: "RFQ bestSupplier" }));
  return { relationships, limitations };
}

function resolveForPr(context: RelationshipResolverContext, pr: any, sourceId: string) {
  const relationships: BusinessRelationship[] = [];
  const limitations: DataLimitation[] = [];
  const sourceEntityType = "purchaseRequest";
  const sourceEntityId = sourceId;
  const sku = firstText(pr?.sourceSku, pr?.itemSku);
  const po = firstText(pr?.linkedPo, asArray(context.purchaseOrders).find((row) => row?.sourceRequest === sourceId)?.po);
  if (sku) relationships.push(makeRelationship({ sourceEntityType, sourceEntityId, targetEntityType: "sku", targetEntityId: sku, targetDisplayLabel: firstText(pr?.sourceName, sku), relationshipType: "requested_item", relationshipLabel: "Requested item", evidenceSource: "PR source SKU" }));
  const rfqs = asArray(context.rfqs).filter((row) => firstText(row?.sourceRequest, row?.linkedPr, row?.prId) === sourceId);
  for (const rfq of rfqs) relationships.push(makeRelationship({ sourceEntityType, sourceEntityId, targetEntityType: "rfq", targetEntityId: rfqId(rfq), relationshipType: "sourced_by_rfq", relationshipLabel: "Sourced by RFQ", evidenceSource: "RFQ sourceRequest", status: text(rfq?.status) }));
  if (po) relationships.push(makeRelationship({ sourceEntityType, sourceEntityId, targetEntityType: "purchaseOrder", targetEntityId: po, relationshipType: "awarded_to_po", relationshipLabel: "Created PO", evidenceSource: "PR linked PO" }));
  else limitations.push(limitation("missing_relationship", `${sourceId} has no linked PO in current data.`, sourceEntityType, sourceEntityId, "awarded_to_po"));
  return { relationships, limitations };
}

export function resolveEntityRelationships(input: RelationshipResolverInput): RelationshipGraph {
  const context = input.context || {};
  const sourceEntityType = input.sourceEntityType;
  const sourceEntityId = text(input.sourceEntityId);
  let result: { relationships: BusinessRelationship[]; limitations: DataLimitation[] } = { relationships: [], limitations: [] };

  if (!sourceEntityId) {
    result.limitations.push(limitation("record_not_found", "Source record id is required.", sourceEntityType, sourceEntityId));
  } else if (sourceEntityType === "purchaseOrder") {
    const po = asArray(context.purchaseOrders).find((row) => poId(row) === sourceEntityId);
    result = po ? resolveForPo(context, po, sourceEntityId) : { relationships: [], limitations: [limitation("record_not_found", `${sourceEntityId} was not found in current PO data.`, sourceEntityType, sourceEntityId)] };
  } else if (sourceEntityType === "sku" || sourceEntityType === "item") {
    result = resolveForSku(context, sourceEntityId);
  } else if (sourceEntityType === "supplier") {
    result = resolveForSupplier(context, sourceEntityId);
  } else if (sourceEntityType === "grn" || sourceEntityType === "receivingDocument") {
    const grn = asArray(context.receivingDocs).find((row) => grnId(row) === sourceEntityId);
    result = grn ? resolveForGrn(context, grn, sourceEntityId) : { relationships: [], limitations: [limitation("record_not_found", `${sourceEntityId} was not found in current GRN data.`, sourceEntityType, sourceEntityId)] };
  } else if (sourceEntityType === "invoice" || sourceEntityType === "invoiceMatch") {
    const invoice = asArray(context.supplierInvoices).find((row) => invoiceId(row) === sourceEntityId);
    result = invoice ? resolveForInvoice(context, invoice, sourceEntityId) : { relationships: [], limitations: [limitation("record_not_found", `${sourceEntityId} was not found in current invoice data.`, sourceEntityType, sourceEntityId)] };
  } else if (sourceEntityType === "rfq") {
    const rfq = asArray(context.rfqs).find((row) => rfqId(row) === sourceEntityId);
    result = rfq ? resolveForRfq(context, rfq, sourceEntityId) : { relationships: [], limitations: [limitation("record_not_found", `${sourceEntityId} was not found in current RFQ data.`, sourceEntityType, sourceEntityId)] };
  } else if (sourceEntityType === "purchaseRequest") {
    const pr = asArray(context.purchaseRequests).find((row) => prId(row) === sourceEntityId);
    result = pr ? resolveForPr(context, pr, sourceEntityId) : { relationships: [], limitations: [limitation("record_not_found", `${sourceEntityId} was not found in current PR data.`, sourceEntityType, sourceEntityId)] };
  } else {
    result.limitations.push(limitation("route_not_available", `${sourceEntityType} relationship resolver is not available yet.`, sourceEntityType, sourceEntityId));
  }

  const relationships = uniqueRelationships(result.relationships);
  const relationshipLimitations = relationships.flatMap((relationship) => relationship.dataLimitation ? [relationship.dataLimitation] : []);
  const dataLimitations = [...result.limitations, ...relationshipLimitations];
  return {
    source: { entityType: sourceEntityType, entityId: sourceEntityId, displayLabel: displayLabel(sourceEntityType, sourceEntityId) },
    relationships,
    groupedRelationships: groupRelationships(relationships),
    linkedRecords: relationships.map((relationship) => relationship.linkedRecord).filter(Boolean),
    dataLimitations,
  };
}
