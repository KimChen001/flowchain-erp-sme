import type { ReactNode } from "react";
import { Link } from "react-router";
import { isDocumentNumberType, useDocumentNumber } from "../../lib/documentNumbers";

export type EntityKind = "item" | "sales_order" | "purchase_request" | "rfq" | "purchase_order" | "supplier" | "customer" | "receiving_doc" | "supplier_invoice" | "contract";

const routeFor: Record<EntityKind, (id: string) => string> = {
  item: (id) => `/app/master-data/items/${encodeURIComponent(id)}`,
  sales_order: (id) => `/app/sales/orders/${encodeURIComponent(id)}`,
  purchase_request: (id) => `/app/procurement/requests/${encodeURIComponent(id)}`,
  rfq: (id) => `/app/procurement/rfq/${encodeURIComponent(id)}`,
  purchase_order: (id) => `/app/procurement/orders/${encodeURIComponent(id)}`,
  supplier: (id) => `/app/master-data/suppliers/${encodeURIComponent(id)}`,
  customer: (id) => `/app/master-data/customers/${encodeURIComponent(id)}`,
  receiving_doc: (id) => `/app/procurement/receiving/${encodeURIComponent(id)}`,
  supplier_invoice: (id) => `/app/procurement/bills/${encodeURIComponent(id)}`,
  contract: (id) => `/app/contracts/${encodeURIComponent(id)}`,
};

// `number`: the document number when the payload carries it (purchase requests, RFQs and purchase orders).
export function EntityLink({ kind, id, number, children, className = "" }: { kind: EntityKind; id?: string | null; number?: string | null; children?: ReactNode; className?: string }) {
  const value = String(id || "").trim();
  // Purchase requests, RFQs and purchase orders are shown by their number; the id stays in the link.
  const shown = useDocumentNumber(isDocumentNumberType(kind) ? kind : null, value, number) || value;
  const text = children === undefined || children === null || children === value ? shown : children;
  if (!value) return <span className={className}>{children}</span>;
  return <Link className={`fc-entity-link font-semibold text-blue-600 underline-offset-2 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 ${className}`} to={routeFor[kind](value)}>{text}</Link>;
}
