import type { CanonicalFocusTarget } from "./evidenceLinks";
import type { WorkflowContext } from "./workflowContext";

export type BusinessEntityType =
  | "purchaseRequest"
  | "rfq"
  | "purchaseOrder"
  | "sku"
  | "item"
  | "supplier"
  | "grn"
  | "receivingDocument"
  | "invoice"
  | "invoiceMatch"
  | "inventoryMovement"
  | "inventoryException"
  | "auditEvent"
  | string;

export type BusinessLinkedRecordInput = {
  entityType?: BusinessEntityType;
  type?: BusinessEntityType;
  entityId?: string;
  id?: string;
  displayLabel?: string;
  label?: string;
  module?: string;
  route?: string;
  status?: string;
  risk?: string;
  relationshipLabel?: string;
  relationshipReason?: string;
  sourceContext?: WorkflowContext | null;
  recordFound?: boolean;
};

export type BusinessLinkedRecord = {
  entityType: string;
  entityId: string;
  displayLabel: string;
  module: string;
  route: string;
  routeAvailable: boolean;
  disabledReason?: string;
  relationshipLabel: string;
  relationshipReason?: string;
  status?: string;
  risk?: string;
  sourceContext?: WorkflowContext | null;
  focusTarget?: CanonicalFocusTarget;
};

type RouteTarget = {
  module: string;
  route: string;
  focusEntityType: string;
  detailAvailable?: boolean;
};

const ROUTES: Record<string, RouteTarget> = {
  purchase_request: { module: "procurement", route: "procurement:requests", focusEntityType: "purchase_request" },
  purchaseRequest: { module: "procurement", route: "procurement:requests", focusEntityType: "purchase_request" },
  pr: { module: "procurement", route: "procurement:requests", focusEntityType: "purchase_request" },
  rfq: { module: "procurement", route: "procurement:rfq", focusEntityType: "rfq" },
  purchase_order: { module: "procurement", route: "procurement:orders", focusEntityType: "purchase_order" },
  purchaseOrder: { module: "procurement", route: "procurement:orders", focusEntityType: "purchase_order" },
  po: { module: "procurement", route: "procurement:orders", focusEntityType: "purchase_order" },
  sku: { module: "inventory", route: "inventory", focusEntityType: "inventory_item" },
  item: { module: "inventory", route: "inventory", focusEntityType: "inventory_item" },
  inventory_item: { module: "inventory", route: "inventory", focusEntityType: "inventory_item" },
  supplier: { module: "srm", route: "srm:master", focusEntityType: "supplier" },
  grn: { module: "procurement", route: "procurement:receiving", focusEntityType: "receiving_doc" },
  receiving_doc: { module: "procurement", route: "procurement:receiving", focusEntityType: "receiving_doc" },
  receivingDocument: { module: "procurement", route: "procurement:receiving", focusEntityType: "receiving_doc" },
  invoice: { module: "procurement", route: "procurement:bills", focusEntityType: "supplier_invoice" },
  supplier_invoice: { module: "procurement", route: "procurement:bills", focusEntityType: "supplier_invoice" },
  invoiceMatch: { module: "procurement", route: "procurement:bills", focusEntityType: "supplier_invoice" },
  inventoryMovement: { module: "inventory", route: "inventory:movements", focusEntityType: "inventory_movement", detailAvailable: false },
  inventoryException: { module: "inventory", route: "inventory:exceptions", focusEntityType: "inventory_exception" },
  auditEvent: { module: "audit", route: "", focusEntityType: "audit_event", detailAvailable: false },
};

function text(value: unknown) {
  return String(value ?? "").trim();
}

export function inferBusinessEntityType(input: BusinessLinkedRecordInput) {
  const explicit = text(input.entityType || input.type);
  if (explicit) return explicit;
  const id = text(input.entityId || input.id);
  const label = text(input.label || input.displayLabel).toLowerCase();
  if (/^PO-/i.test(id) || label.includes("po")) return "purchaseOrder";
  if (/^PR-/i.test(id)) return "purchaseRequest";
  if (/^RFQ-/i.test(id)) return "rfq";
  if (/^GRN-/i.test(id)) return "grn";
  if (/^SKU-/i.test(id)) return "sku";
  if (/^INV-/i.test(id) || label.includes("invoice") || label.includes("发票")) return "invoice";
  if (label.includes("supplier") || label.includes("供应商")) return "supplier";
  return "unknown";
}

function targetFor(input: BusinessLinkedRecordInput) {
  const type = inferBusinessEntityType(input);
  return ROUTES[type] || ROUTES[type.replace(/-/g, "_")];
}

export function resolveBusinessLinkedRecord(input: BusinessLinkedRecordInput): BusinessLinkedRecord {
  const entityType = inferBusinessEntityType(input);
  const entityId = text(input.entityId || input.id || input.displayLabel || input.label);
  const target = targetFor(input);
  const route = target?.route || text(input.route);
  const recordMissing = input.recordFound === false || !entityId;
  const routeAvailable = Boolean(target && route && target.detailAvailable !== false && !recordMissing);
  const displayLabel = text(input.displayLabel || input.label) || entityId || "Related record";
  const disabledReason = recordMissing
    ? "Record not found in current data"
    : routeAvailable
      ? undefined
      : target?.detailAvailable === false
        ? "Relationship exists, but detail page is not available"
        : "Route not available yet";

  return {
    entityType,
    entityId,
    displayLabel,
    module: target?.module || text(input.module),
    route,
    routeAvailable,
    disabledReason,
    relationshipLabel: text(input.relationshipLabel) || "Related record",
    relationshipReason: text(input.relationshipReason),
    status: text(input.status),
    risk: text(input.risk),
    sourceContext: input.sourceContext || null,
    focusTarget: routeAvailable ? { entityType: target!.focusEntityType, entityId } : undefined,
  };
}

export function resolveBusinessLinkedRecords(inputs: BusinessLinkedRecordInput[]) {
  return inputs.map(resolveBusinessLinkedRecord);
}

export function groupBusinessLinkedRecords(records: BusinessLinkedRecord[]) {
  return records.reduce<Record<string, BusinessLinkedRecord[]>>((groups, record) => {
    const key = record.relationshipLabel || "Related record";
    groups[key] = groups[key] || [];
    groups[key].push(record);
    return groups;
  }, {});
}
