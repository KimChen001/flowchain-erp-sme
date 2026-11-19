// The order and shipment timelines (OutboundWorkbench.tsx), built from the
// rows the workbench API returns (server/domain/outbound-workbench-read-service.mjs).
// Each row's summary has a fixed shape for its kind of record, so its parts
// are read by position, never guessed from how they look: an SKU of digits
// ("15036") is an SKU, not a quantity.
//   - a reservation event:  "<quantity> · <reservation id>" (· <reason>, added below)
//   - a stock movement:     "<SKU> · <warehouse id> · <quantity>"
//   - an audit event:       "<document number> · <reason>", shown as recorded
// Kept free of React so it can be unit tested (server/domain/outbound-timeline-text.test.mjs).
import { quantityWithUnit } from "./salesOrderFacts.ts";

export type TimelineRow = {
  eventType: string;
  title: string;
  summary: string;
  occurredAt: string;
  entityType: string;
  entityId: string;
  commandExecutionId?: string | null;
  idempotencyKey?: string | null;
};

export type TimelineLookup = {
  language: string;
  // A reservation by its id: where it is ("Main warehouse / A-01") and its unit.
  reservation?: (id: string) => { place: string; unit?: string | null } | undefined;
  // A warehouse's name by its id.
  warehouse?: (id: string) => string | undefined;
  // The unit an SKU is ordered in.
  unitForSku?: (sku: string) => string | null | undefined;
};

// The server writes this when a movement has no warehouse.
const NO_WAREHOUSE = "未指定仓库";

export function timelineSummary(row: TimelineRow, lookup: TimelineLookup): string {
  const parts = String(row.summary || "").split(" · ");
  if (row.entityType === "InventoryReservation") {
    const [quantity = "", reservationId = "", ...rest] = parts;
    const reservation = lookup.reservation?.(reservationId);
    // A reservation the reader cannot see is left out, never named by its id.
    return [quantityWithUnit(quantity, reservation?.unit, lookup.language), reservation?.place || "", ...rest].filter(Boolean).join(" · ");
  }
  if (row.entityType === "InventoryMovement") {
    const [sku = "", warehouseId = "", quantity = ""] = parts;
    const warehouse =
      warehouseId === NO_WAREHOUSE
        ? lookup.language === "en-US" ? "No warehouse" : NO_WAREHOUSE
        : lookup.warehouse?.(warehouseId) || "";
    return [sku, warehouse, quantity ? quantityWithUnit(quantity, lookup.unitForSku?.(sku), lookup.language) : ""].filter(Boolean).join(" · ");
  }
  return row.summary;
}

// Reserving and releasing write an audit row for the order and an event for
// each reservation, so each reservation read twice ("Stock reserved · 44 ·
// Main warehouse / A-01" and "Stock reserved for the order · SO-…"). The
// order's audit row is left out where the same command's reservation events
// are shown; a release keeps its reason on those events.
const FOLDED: Record<string, string> = {
  sales_inventory_reserved: "reservation_reserved",
  sales_reservation_released: "reservation_released",
};
export function foldReservationAudits<T extends TimelineRow>(rows: T[]): T[] {
  const sameCommand = (audit: T, event: T) =>
    audit.idempotencyKey ? event.idempotencyKey === audit.idempotencyKey : event.occurredAt === audit.occurredAt;
  const folded = new Set<T>();
  const reasons = new Map<T, string>();
  for (const audit of rows) {
    const eventType = FOLDED[audit.eventType];
    if (!eventType) continue;
    const events = rows.filter((row) => row.eventType === eventType && sameCommand(audit, row));
    if (!events.length) continue;
    folded.add(audit);
    // "SO-… · <reason>": the reason follows the order number.
    const reason = String(audit.summary || "").split(" · ").slice(1).join(" · ");
    if (reason) for (const event of events) reasons.set(event, reason);
  }
  return rows
    .filter((row) => !folded.has(row))
    .map((row) => (reasons.has(row) ? { ...row, summary: `${row.summary} · ${reasons.get(row)}` } : row));
}
