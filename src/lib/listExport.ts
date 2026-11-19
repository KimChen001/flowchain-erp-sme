import { apiJson } from "./api-client.ts";

type ReadPage = (path: string) => Promise<Record<string, unknown>>;

// "Export results" on a list the server pages (design audit U-14): every row
// the list's filters match, not only the page on screen. The servers answer
// at most 100 rows a page, so this reads page after page until it has the
// total, up to `maxRows`; `truncated` says when the list was longer.
export async function fetchAllListRows<T>(
  endpoint: string,
  filters: URLSearchParams,
  { itemsKey = "items", pageSize = 100, maxRows = 5000, read = (path: string) => apiJson<Record<string, unknown>>(path) }: { itemsKey?: string; pageSize?: number; maxRows?: number; read?: ReadPage } = {},
): Promise<{ rows: T[]; total: number; truncated: boolean }> {
  const rows: T[] = [];
  let total = Number.POSITIVE_INFINITY;
  for (let page = 1; rows.length < total && rows.length < maxRows; page += 1) {
    const query = new URLSearchParams(filters);
    query.set("page", String(page));
    query.set("pageSize", String(pageSize));
    const payload = await read(`${endpoint}?${query.toString()}`);
    const items = Array.isArray(payload?.[itemsKey]) ? (payload[itemsKey] as T[]) : [];
    const reported = Number(payload?.total);
    total = Number.isFinite(reported) ? reported : rows.length + items.length;
    rows.push(...items);
    if (items.length < pageSize) break;
  }
  const known = Number.isFinite(total) ? total : rows.length;
  return { rows: rows.slice(0, maxRows), total: known, truncated: known > Math.min(rows.length, maxRows) };
}
