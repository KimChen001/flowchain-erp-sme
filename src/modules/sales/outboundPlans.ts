// Whole-order reserving and shipping (design audit L4-08). The order page
// reserved and shipped one line at a time, so a ten-line order became ten
// shipments and ten invoices. These plans fill the server's existing
// multi-line requests: one reservation request for every open line, one
// shipment for everything reserved. Pure functions over the order workbench
// read, so a node test can check them (server/domain/outbound-ship-all.test.mjs);
// the server's preview checks the plan again before anything is saved.

import { quantityUnits, unitsToPlain } from "./salesOrderFacts";

type PlanLine = { id: string; sku: string; remainingToReserve: string | null };
type PlanBalance = { id: string; warehouseId: string; location: string; availableQuantity: string; selectable: boolean };
type PlanAvailability = { salesOrderLineId: string; balances: PlanBalance[] };
type PlanReservation = { id: string; salesOrderLineId: string; allocatableQuantity: string };

export type ReserveAllocation = { salesOrderLineId: string; warehouseId: string; location: string; quantity: string };
export type ReserveAllPlan = {
  allocations: ReserveAllocation[];
  // Lines the stock this user may use cannot cover in full, with what is left.
  short: Array<{ salesOrderLineId: string; quantity: string }>;
};

const units = (value?: string | null) => quantityUnits(value) ?? 0n;

// What each open line still needs, from the stock this user may reserve:
// the largest balance first, so a line takes stock from as few places as it
// can. Lines of the same SKU share their balances, so stock is never counted
// twice. A line whose remainder is hidden (a reader who sees only some
// warehouses) is left out.
export function reserveAllPlan(lines: PlanLine[], availability: PlanAvailability[]): ReserveAllPlan {
  const used = new Map<string, bigint>();
  const allocations: ReserveAllocation[] = [];
  const short: ReserveAllPlan["short"] = [];
  for (const line of lines) {
    if (line.remainingToReserve == null) continue;
    let need = units(line.remainingToReserve);
    if (need <= 0n) continue;
    const balances = (availability.find((row) => row.salesOrderLineId === line.id)?.balances || [])
      .filter((balance) => balance.selectable)
      .map((balance) => ({ balance, free: units(balance.availableQuantity) - (used.get(balance.id) || 0n) }))
      .filter((entry) => entry.free > 0n)
      .sort((a, b) => (a.free === b.free ? 0 : a.free > b.free ? -1 : 1));
    for (const { balance, free } of balances) {
      if (need <= 0n) break;
      const take = free < need ? free : need;
      allocations.push({ salesOrderLineId: line.id, warehouseId: balance.warehouseId, location: balance.location, quantity: unitsToPlain(take) });
      used.set(balance.id, (used.get(balance.id) || 0n) + take);
      need -= take;
    }
    if (need > 0n) short.push({ salesOrderLineId: line.id, quantity: unitsToPlain(need) });
  }
  return { allocations, short };
}

export type ShipAllLine = { salesOrderLineId: string; allocations: Array<{ reservationId: string; quantity: string }> };

// One shipment for everything reserved and not yet on a shipment: each line
// with every reservation's free quantity. Lines with nothing reserved are
// left for later.
export function shipAllPlan(lines: Array<Pick<PlanLine, "id">>, reservations: PlanReservation[]): ShipAllLine[] {
  return lines.flatMap((line) => {
    const allocations = reservations
      .filter((row) => row.salesOrderLineId === line.id && units(row.allocatableQuantity) > 0n)
      .map((row) => ({ reservationId: row.id, quantity: unitsToPlain(units(row.allocatableQuantity)) }));
    return allocations.length ? [{ salesOrderLineId: line.id, allocations }] : [];
  });
}

// The order's progress, as the purchase order page shows its own (design
// audit L7-42): placed, reserved, shipped, invoiced, paid. A step is done,
// the current one, waiting, or a warning (an order on hold).
export type SalesProgressStep = { key: "ordered" | "reserved" | "shipped" | "invoiced" | "paid"; status: "done" | "current" | "warning" | "pending" };
export type SalesProgressFacts = {
  workflowStatus: string;
  lines: Array<{ orderedQuantity: string; reservedQuantity: string; fulfilledQuantity: string }>;
  // Null for a reader who may not read customer invoices: the last two
  // steps then say nothing.
  invoicing: "nothing_shipped" | "not_invoiced" | "partly_invoiced" | "invoiced" | null;
  // The order's customer invoices: their status and, once issued, where
  // their payment stands (to_be_paid, partially_settled, settled).
  invoices: Array<{ status: string; paymentStatus?: string | null }> | null;
};

export function salesOrderProgress(facts: SalesProgressFacts): SalesProgressStep[] {
  const cancelled = facts.workflowStatus === "cancelled",
    placed = !["draft", "cancelled"].includes(facts.workflowStatus),
    // Shipping uses up a reservation, so what is shipped counts as reserved.
    reserved = facts.lines.length > 0 && facts.lines.every((line) => units(line.reservedQuantity) + units(line.fulfilledQuantity) >= units(line.orderedQuantity)),
    shipped = facts.lines.length > 0 && facts.lines.every((line) => units(line.fulfilledQuantity) >= units(line.orderedQuantity)),
    invoiced = shipped && facts.invoicing === "invoiced",
    // Drafts and cancelled invoices bill nothing; every other invoice must be paid.
    billing = (facts.invoices || []).filter((invoice) => !["draft", "cancelled", "void", "voided"].includes(invoice.status)),
    paid = invoiced && billing.length > 0 && billing.every((invoice) => invoice.paymentStatus === "settled");
  const done = [placed, reserved, shipped, invoiced, paid];
  const keys: SalesProgressStep["key"][] = ["ordered", "reserved", "shipped", "invoiced", "paid"];
  const current = cancelled ? -1 : done.findIndex((value) => !value);
  return keys.map((key, index) => ({
    key,
    status: done[index]
      ? "done"
      : index === current
        ? facts.workflowStatus === "on_hold" ? "warning" : "current"
        : "pending",
  }));
}
