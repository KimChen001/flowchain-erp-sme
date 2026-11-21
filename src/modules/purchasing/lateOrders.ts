// When a purchase order counts as overdue, for the list's overdue line and a
// late order's link to Today (product review 2026-11-20, #408 review). The
// same rule as Today and the "N days late" column: open (committed, with
// quantity still to receive), and due before the workspace day. Pure, so
// server/domain/purchasing-late-and-terms.test.mjs can run it.

// Open and due before the workspace's today. `due` is a calendar day
// (YYYY-MM-DD): the line's promised date, else the order's expected date.
export function isOverdueOpen(open: boolean, due: string | null | undefined, workspaceToday: string | null | undefined) {
  return Boolean(open && workspaceToday && due && String(due) < workspaceToday);
}

// The statuses Today chases a supplier for: an order the supplier has. An
// approved order not yet sent gets "send", not a follow-up; a draft, pending
// or rejected order has no supplier to chase.
const CHASED_STATUSES = new Set(["issued", "partially_received"]);

// Whether a late order's page should point to the follow-up on Today.
export function todayChasesOrder(statusCode: string, open: boolean, due: string | null | undefined, workspaceToday: string | null | undefined) {
  return CHASED_STATUSES.has(statusCode) && isOverdueOpen(open, due, workspaceToday);
}
