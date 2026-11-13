import { useEffect, useMemo, useRef, useState } from "react";
import { A } from "../../components/ui";
import { listButtonClass } from "../../components/ui/listLayout";
import { useI18n } from "../../i18n/I18n";

// Paging for the long procurement and inventory lists, in the look of the
// sales order list: "Page 2 of 9 · 412 results" with Previous and Next under
// the table. Only one page of rows is drawn; search and filters still run
// over every row the page holds (or, for server-paged lists, on the server).

const COPY = {
  page: ["Page {page} of {pages} · {total} results", "第 {page} / {pages} 页 · 共 {total} 条"],
  previous: ["Previous", "上一页"],
  next: ["Next", "下一页"],
} as const;

export function ListPager({ page, pageSize, total, onPage, testId = "list-pager" }: {
  page: number;
  pageSize: number;
  total: number;
  onPage: (page: number) => void;
  testId?: string;
}) {
  const { language, formatNumber } = useI18n();
  const ref = useRef<HTMLDivElement>(null);
  const say = (key: keyof typeof COPY, values: Record<string, string | number> = {}) =>
    COPY[key][language === "en-US" ? 0 : 1].replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? ""));
  if (total <= 0) return null;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  // A new page starts at the top of its list, not at the pager the person clicked.
  const go = (next: number) => {
    onPage(next);
    const card = ref.current?.parentElement?.parentElement;
    if (card && card.getBoundingClientRect().top < 0) card.scrollIntoView({ block: "start" });
  };
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 text-xs sm:px-5" style={{ borderTop: "0.5px solid rgba(0,0,0,0.06)", color: A.sub }} data-testid={testId} ref={ref}>
      <span>{say("page", { page: formatNumber(page), pages: formatNumber(pages), total: formatNumber(total) })}</span>
      <div className="flex gap-2">
        <button type="button" className={`${listButtonClass.secondary} disabled:opacity-50`} disabled={page <= 1} onClick={() => go(page - 1)}>{say("previous")}</button>
        <button type="button" className={`${listButtonClass.secondary} disabled:opacity-50`} disabled={page >= pages} onClick={() => go(page + 1)}>{say("next")}</button>
      </div>
    </div>
  );
}

// One page of rows held in the browser. The page goes back to 1 whenever
// `resetKey` (the search and filters) changes, and never past the last page.
export function usePagedRows<T>(rows: T[], pageSize: number, resetKey: string) {
  const [state, setState] = useState({ key: resetKey, page: 1 });
  const pages = Math.max(1, Math.ceil(rows.length / pageSize));
  const page = Math.min(state.key === resetKey ? state.page : 1, pages);
  const pageRows = useMemo(() => rows.slice((page - 1) * pageSize, page * pageSize), [rows, page, pageSize]);
  return { page, pages, pageRows, setPage: (next: number) => setState({ key: resetKey, page: next }) };
}

// True while the window matches the media query, so a list draws either its
// table or its phone cards, never both.
export function useMediaQuery(query: string) {
  const read = () => typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(query).matches;
  const [matches, setMatches] = useState(read);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const media = window.matchMedia(query);
    const change = () => setMatches(media.matches);
    change();
    media.addEventListener("change", change);
    return () => media.removeEventListener("change", change);
  }, [query]);
  return matches;
}
