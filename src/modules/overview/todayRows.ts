// Which of Today's rows show first, and the reorder row's prefilled request.
// Pure functions, so server/domain/today-rows.test.mjs can run them.

// The rows Today shows before "Show all": the earliest row of every kind of
// work, so a long run of one kind (sixty overdue receivables) never hides
// another (the items to reorder), then the next earliest rows until there are
// `count`. They keep the list's order (earliest date first). With more kinds
// than `count`, every kind still gets its row.
export function firstRowsByKind<T extends { kind: string }>(rows: T[], count: number): T[] {
  const picked = new Set<number>();
  const kinds = new Set<string>();
  rows.forEach((row, index) => {
    if (kinds.has(row.kind)) return;
    kinds.add(row.kind);
    picked.add(index);
  });
  for (let index = 0; index < rows.length && picked.size < count; index += 1) picked.add(index);
  return rows.filter((_, index) => picked.has(index));
}

// How many rows of each kind the list holds.
export function rowsPerKind(rows: Array<{ kind: string }>): Map<string, number> {
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(row.kind, (counts.get(row.kind) || 0) + 1);
  return counts;
}

export type ReorderRequest = { itemId: string; supplierId: string | null; quantity: number | null; raisedToMinimum?: boolean };

// The purchase request form prefilled from the reorder list's row for the
// item, as the reorder list's own "Create purchase request" opens it
// (ReorderListPage purchaseRequestHref, shared/purchase-request-prefill.mjs).
// Without a shortfall in the request line's unit the quantity is left for
// the person to enter; a shortfall raised to the supplier's minimum says so
// and hands over the shortfall too.
export function reorderRequestHref(request: ReorderRequest, reason: string, shortfall?: number | null) {
  const params = new URLSearchParams({ itemId: request.itemId, origin: "reorder_list", reason });
  const quantity = request.quantity !== null && request.quantity !== undefined;
  if (quantity) params.set("quantity", String(request.quantity));
  if (quantity && request.raisedToMinimum) {
    params.set("quantityFrom", "supplier_minimum");
    params.set("shortfall", String(shortfall));
  }
  if (request.supplierId) params.set("suppliers", request.supplierId);
  return `/app/procurement/requests?${params.toString()}`;
}
