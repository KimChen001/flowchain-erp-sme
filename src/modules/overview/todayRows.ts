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

// Today's work as one group per kind (owner 11/13: sixty rows of three lines
// were too much): the groups in the order of their earliest row, each with
// its rows in the list's order (earliest date first).
export function groupsByKind<T extends { kind: string }>(rows: T[]): Array<{ kind: T["kind"]; rows: T[] }> {
  const groups = new Map<string, { kind: T["kind"]; rows: T[] }>();
  for (const row of rows) {
    const group = groups.get(row.kind);
    if (group) group.rows.push(row);
    else groups.set(row.kind, { kind: row.kind, rows: [row] });
  }
  return [...groups.values()];
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

// How many of Today's rows are not on the page: the server lists its first
// rows (workItems) of workTotal. A row that became a decision card or was set
// aside is shown in its own section, so it is not "not shown", whether or not
// it was among the rows listed. (Product review 2026-11-20: the count was
// the tile less the list, so it counted the cards shown above.)
export function todayRowsNotShown(
  overview: { workTotal?: number; workItems?: Array<{ kind: string; recordId: string }> } | null | undefined,
  decisionKeys: Set<string>,
) {
  const listed = overview?.workItems || [];
  const listedKeys = new Set(listed.map((item) => `${item.kind}:${item.recordId}`));
  const cardsBeyond = [...decisionKeys].filter((key) => !listedKeys.has(key)).length;
  return Math.max(0, (overview?.workTotal ?? listed.length) - listed.length - cardsBeyond);
}

// The counts Today's two tiles and the priorities summary show: Today's work
// and the decisions waiting on it, less what was set aside. Both count the
// same rows, so Overdue is never more than Needs action (design audit L6-03,
// L6-04, L7-11).
export type TodayCountSource = {
  workTotal?: number;
  overdue?: number;
  decisions?: { available?: boolean; setAside?: Array<{ key: string; row: { overdueDays: number } }> };
} | null | undefined;

export function todayTileCounts(overview: TodayCountSource, fallbackTotal = 0) {
  const setAside = overview?.decisions?.available ? overview.decisions.setAside || [] : [];
  const keys = new Set(setAside.map((entry) => entry.key));
  return {
    work: Math.max(0, (overview?.workTotal ?? fallbackTotal) - keys.size),
    overdue: Math.max(0, (overview?.overdue ?? 0) - setAside.filter((entry) => entry.row.overdueDays > 0).length),
  };
}
