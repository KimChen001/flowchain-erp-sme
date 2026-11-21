import React, { useLayoutEffect, useRef, useState, useId } from "react";
import { FileSpreadsheet, Plus, RefreshCw, SlidersHorizontal } from "lucide-react";
import { A, Card } from "./index";
import { typography } from "./typography";
import { listTableCardsRef } from "./workbenchTable";
import { useI18n } from "../../i18n/I18n";

// The list page layout every procurement tab shares, taken from the purchase
// order list: metric cards, a search card with labelled filters, then a list
// card holding the table. Callers pass copy already in the interface language.

const COPY = {
  reset: ["Reset", "重置"],
  refresh: ["Refresh", "刷新"],
  export: ["Export results", "导出当前结果"],
  loading: ["Loading…", "加载中…"],
  retry: ["Retry", "重试"],
  shown: ["{total} total, {shown} shown", "共 {total} 条，当前显示 {shown} 条"],
  matching: ["{total} of {all} match the filters, {shown} shown", "{all} 条中 {total} 条符合筛选，当前显示 {shown} 条"],
  filters: ["Filters ({count})", "筛选（{count}）"],
  filtersNone: ["Filters", "筛选"],
  hideFilters: ["Hide filters", "收起筛选"],
} as const;

// The metric cards above a list: two per row on phones, four from 1024 px.
export const metricGridClass = "grid grid-cols-2 gap-3 lg:grid-cols-4";

export function useListCopy() {
  const { language, formatNumber } = useI18n();
  // Counts read with the workspace's digit grouping ("5,760 total").
  return (key: keyof typeof COPY, values: Record<string, string | number> = {}) =>
    COPY[key][language === "en-US" ? 0 : 1].replace(/\{(\w+)\}/g, (_, name) => typeof values[name] === "number" ? formatNumber(values[name] as number) : String(values[name] ?? ""));
}

export const listButtonClass = {
  // 32 px on a desk, 36 px on a phone, for a finger.
  secondary: `inline-flex h-8 items-center gap-1.5 rounded-lg bg-slate-50 px-3 max-sm:h-9 ${typography.denseButton} text-slate-900 hover:bg-slate-100`,
  export: `inline-flex h-8 items-center gap-1.5 rounded-lg bg-blue-50 px-3 max-sm:h-9 ${typography.denseButton} text-blue-600 hover:bg-blue-100`,
  // The secondary look on a grey box or on the page background, where the
  // slate fill above has no visible edge: white with a light border.
  outline: `inline-flex h-8 items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 max-sm:h-9 ${typography.denseButton} text-slate-900 hover:bg-slate-50 disabled:opacity-60`,
  primary: `inline-flex h-8 items-center gap-1.5 rounded-lg bg-blue-600 px-3 max-sm:h-9 ${typography.denseButton} text-white hover:bg-blue-700 disabled:opacity-60`,
  // Reject and cancel: one look on every detail page (design audit U-17).
  danger: `inline-flex h-8 items-center gap-1.5 rounded-lg bg-red-50 px-3 max-sm:h-9 ${typography.denseButton} text-red-700 hover:bg-red-100 disabled:opacity-50`,
};

// Buttons inside a table row: the main one tinted, the others neutral. On a
// phone the row is a card and these are thumb targets: at least 36 px tall,
// with room between them (theme.css spaces the card's action row).
const rowActionSize = "inline-flex items-center justify-center rounded-md px-2 py-1 text-[11px] font-medium max-sm:min-h-9 max-sm:px-3 max-sm:text-xs";
export const rowActionClass = {
  primary: `${rowActionSize} bg-blue-50 text-blue-600 hover:bg-blue-100`,
  neutral: `${rowActionSize} bg-slate-100 text-slate-700 hover:bg-slate-200`,
  danger: `${rowActionSize} bg-red-50 text-red-700 hover:bg-red-100`,
};

export function ResetButton({ onClick }: { onClick: () => void }) {
  const say = useListCopy();
  return <button type="button" onClick={onClick} className={listButtonClass.secondary}>{say("reset")}</button>;
}

export function RefreshButton({ onClick }: { onClick: () => void }) {
  const say = useListCopy();
  return <button type="button" onClick={onClick} className={listButtonClass.secondary}><RefreshCw size={13} />{say("refresh")}</button>;
}

export function ExportButton({ onClick }: { onClick: () => void }) {
  const say = useListCopy();
  return <button type="button" onClick={onClick} className={listButtonClass.export}><FileSpreadsheet size={13} />{say("export")}</button>;
}

export function PrimaryButton({ onClick, children, testId }: { onClick: () => void; children: React.ReactNode; testId?: string }) {
  return <button type="button" onClick={onClick} className={listButtonClass.primary} data-testid={testId}><Plus size={13} />{children}</button>;
}

// Below 768 px only the first field (the search) shows; the other filters
// open from a Filters button. The button counts the filters in use
// (`activeFilters`), never the fields it hides, so "Filters (2)" means two
// filters narrow the list.
export function ListSearchCard({ title, subtitle, actions, children, activeFilters = 0 }: {
  title: string;
  subtitle?: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
  activeFilters?: number;
}) {
  const say = useListCopy();
  const [filtersOpen, setFiltersOpen] = useState(false);
  const moreFiltersId = useId();
  const [first, ...rest] = React.Children.toArray(children);
  return (
    <Card className="p-4 sm:p-5">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="fc-section-title" style={{ color: A.label }}>{title}</h2>
          {subtitle && <div className="mt-1 text-xs" style={{ color: A.sub }}>{subtitle}</div>}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-4" data-testid="list-search-fields">
        {first}
        {rest.length > 0 && <div id={moreFiltersId} className={filtersOpen ? "contents" : "hidden md:contents"} data-testid="list-search-more-filters">{rest}</div>}
      </div>
      {rest.length > 0 && (
        <button
          type="button"
          aria-expanded={filtersOpen}
          aria-controls={moreFiltersId}
          onClick={() => setFiltersOpen((open) => !open)}
          className={`mt-3 md:hidden ${listButtonClass.secondary}`}
          data-testid="list-search-filters-toggle"
        >
          <SlidersHorizontal size={13} />
          {filtersOpen ? say("hideFilters") : activeFilters > 0 ? say("filters", { count: activeFilters }) : say("filtersNone")}
        </button>
      )}
    </Card>
  );
}

// A list's count line: `total` is the rows the filters match, `shown` the
// rows this page draws, and `all` the rows before any filter. With a filter
// that narrows the list it reads "1 of 196 match the filters, 1 shown", not
// "196 total, 1 shown" (design audit U-14, W-04).
export function ListCard({ title, total, all, shown, right, children, testId }: {
  title: string;
  total?: number;
  all?: number;
  shown?: number;
  right?: React.ReactNode;
  children: React.ReactNode;
  testId?: string;
}) {
  const say = useListCopy();
  return (
    <Card data-testid={testId}>
      <div className="flex flex-wrap items-center gap-3 px-4 py-3.5 sm:px-5" style={{ borderBottom: "0.5px solid rgba(0,0,0,0.08)" }}>
        <div>
          <div className="text-sm font-semibold" style={{ color: A.label }}>{title}</div>
          {total !== undefined && <div className="mt-0.5 text-[11px]" style={{ color: A.sub }} data-testid="list-count">{all !== undefined && all !== total ? say("matching", { total, all, shown: shown ?? total }) : say("shown", { total, shown: shown ?? total })}</div>}
        </div>
        {right && <div className="ml-auto flex items-center gap-2">{right}</div>}
      </div>
      <div ref={listTableCardsRef}>{children}</div>
    </Card>
  );
}

// The phone card layout of list tables (workbenchTable.ts): ListCard applies
// it to its body; other list tables put listTableCardsRef on their scroll box.
export { listTableCardsRef };

// A row's "More" menu. The menu stays inside the row, so the row's buttons
// are found there, but is placed against the window: the table's scroll box
// cannot clip it, and it opens upward when the row is near the bottom. It
// closes on a choice, a click elsewhere or Escape, and follows the row while
// the page scrolls.
export function RowMenu({ label, children, testId }: { label: string; children: React.ReactNode; testId?: string }) {
  return (
    <RowPopover summary={label} summaryClassName={rowActionClass.neutral} panelClassName="flex w-max min-w-40 max-w-64 flex-col p-1" closeOnClick testId={testId}>
      {children}
    </RowPopover>
  );
}

// A small panel opened from a row (a menu, a preview), placed like RowMenu.
export function RowPopover({ summary, summaryClassName, panelClassName, closeOnClick = false, children, testId }: { summary: React.ReactNode; summaryClassName: string; panelClassName: string; closeOnClick?: boolean; children: React.ReactNode; testId?: string }) {
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const close = () => {
    if (detailsRef.current) detailsRef.current.open = false;
  };
  useLayoutEffect(() => {
    const details = detailsRef.current, menu = menuRef.current;
    const summary = details?.querySelector("summary");
    if (!open || !details || !menu || !summary) return;
    const place = () => {
      const anchor = summary.getBoundingClientRect();
      const gap = 4, edge = 8;
      const roomBelow = window.innerHeight - anchor.bottom;
      const up = roomBelow < menu.offsetHeight + gap + edge && anchor.top > roomBelow;
      const top = up ? anchor.top - gap - menu.offsetHeight : anchor.bottom + gap;
      const left = Math.max(edge, Math.min(anchor.right - menu.offsetWidth, window.innerWidth - menu.offsetWidth - edge));
      menu.style.left = `${left}px`;
      menu.style.top = `${top}px`;
      // A transformed ancestor would make "fixed" relative to itself.
      const placed = menu.getBoundingClientRect();
      if (Math.abs(placed.left - left) > 0.5 || Math.abs(placed.top - top) > 0.5) {
        menu.style.left = `${2 * left - placed.left}px`;
        menu.style.top = `${2 * top - placed.top}px`;
      }
    };
    place();
    // A sticky cell holds the menu in its own stacking context, so the cell
    // itself is raised: above the rows below it, and above the floating AI
    // assistant button (z-40, later in the page), which would otherwise cover
    // the menu's last items when the row is near the bottom of the window.
    const cell = details.closest("td, th") as HTMLElement | null;
    const zIndex = cell?.style.zIndex ?? "";
    if (cell) cell.style.zIndex = "50";
    const outside = (event: Event) => {
      if (!details.contains(event.target as Node)) close();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      close();
      summary.focus();
    };
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
      if (cell) cell.style.zIndex = zIndex;
    };
  }, [open]);
  return (
    <details ref={detailsRef} className="relative" onToggle={(event) => setOpen(event.currentTarget.open)} data-testid={testId}>
      <summary className={`cursor-pointer list-none ${summaryClassName}`}>{summary}</summary>
      <div
        ref={menuRef}
        className={`fixed z-50 whitespace-normal rounded-lg border border-slate-200 bg-white shadow-lg ${panelClassName}`}
        style={{ visibility: open ? "visible" : "hidden" }}
        onClick={closeOnClick ? close : undefined}
      >
        {children}
      </div>
    </details>
  );
}

// A table row standing in for the rows: loading, a load error with Retry, or
// nothing to show.
export function ListStateRow({ colSpan, state, title, detail, onRetry }: {
  colSpan: number;
  state: "loading" | "error" | "empty";
  title?: string;
  detail?: string;
  onRetry?: () => void;
}) {
  const say = useListCopy();
  return (
    <tr>
      <td colSpan={colSpan} className="px-4 py-12 text-center text-sm" style={{ color: A.sub }}>
        {state === "loading" ? say("loading") : (
          <>
            {title && <div className="font-semibold" style={{ color: A.label }}>{title}</div>}
            {detail && <div className="mt-1 text-xs">{detail}</div>}
            {state === "error" && onRetry && <button type="button" onClick={onRetry} className="mt-3 text-xs font-semibold text-blue-600">{say("retry")}</button>}
          </>
        )}
      </td>
    </tr>
  );
}

export const listHeadRowStyle: React.CSSProperties = { borderBottom: "0.5px solid rgba(0,0,0,0.06)" };
export const listRowClass = "transition-colors hover:bg-blue-50/40";
export const listRowStyle = (index: number, count: number): React.CSSProperties => ({
  borderBottom: index < count - 1 ? "0.5px solid rgba(0,0,0,0.04)" : "none",
});

// Status tones come from the one table in statusTones.ts (design audit L6-08).
export { statusToneOf, type StatusTone } from "./statusTones";
import type { StatusTone } from "./statusTones";

const TONE_CLASS: Record<StatusTone, string> = {
  success: "bg-teal-50 text-teal-700",
  warning: "bg-amber-50 text-amber-700",
  danger: "bg-red-50 text-red-700",
  info: "bg-blue-50 text-blue-700",
  neutral: "bg-slate-100 text-slate-600",
};

export function StatusChip({ label, tone, testId }: { label: string; tone: StatusTone; testId?: string }) {
  return <span className={`fc-status-chip inline-flex w-fit items-center whitespace-nowrap ${TONE_CLASS[tone]}`} data-testid={testId}>{label}</span>;
}
