import { useState, type ReactNode } from "react";
import { ArrowDown, ArrowUp } from "lucide-react";
import { isUnavailableProductRoute } from "../../../../../shared/unavailable-product-routes.mjs";
import { A } from "../../../../components/ui";
import { RefChip, StatusPill, cardStyle, codeLabel, isRef, usePartCopy, type Navigate, type PartCopy } from "./partKit";
import type { MoneyCell, StatusValue, TableCell, TableColumnKind, TableProps } from "./types";

const isMoney = (value: unknown): value is MoneyCell => Boolean(value) && typeof value === "object" && "amount" in (value as object) && "currency" in (value as object);
const isStatus = (value: unknown): value is StatusValue => Boolean(value) && typeof value === "object" && typeof (value as StatusValue).code === "string" && !isRef(value);
const NUMERIC: TableColumnKind[] = ["number", "quantity", "money", "percent", "days"];
// In a narrow panel a table shows this many rows as cards until the user asks
// for all of them (2026-11-05: fifteen cards pushed the answer off screen).
export const NARROW_ROWS = 5;

type Row = TableProps["rows"][number];
type Column = TableProps["columns"][number];

// What a cell sorts by: its number, or its text as shown.
function sortKey(cell: TableCell, copy: PartCopy): number | string | null {
  if (cell === null || cell === undefined) return null;
  if (typeof cell === "number" || typeof cell === "string") return cell;
  if (isRef(cell)) return cell.label;
  if (isMoney(cell)) return cell.amount;
  if (isStatus(cell)) return codeLabel(cell.code, copy);
  return null;
}

// The unit a quantity cell is counted in, from its row: the server puts it
// beside the cells in the answer's language (moq_unit for a minimum order
// quantity; *_one for a quantity of 1: "1 box", "300 boxes").
function unitOf(row: Row, code: string, value: number) {
  const base = code === "minimum_order_quantity" && row.moq_unit ? "moq_unit" : "unit";
  const unit = value === 1 ? row[`${base}_one`] ?? row[base] : row[base];
  return typeof unit === "string" && unit.trim() ? unit.trim() : null;
}

function Cell({ cell, kind, code, row, copy, onNavigate }: { cell: TableCell; kind: TableColumnKind; code: string; row: Row; copy: PartCopy; onNavigate?: Navigate }): ReactNode {
  if (cell === null || cell === undefined) return "—";
  if (isRef(cell)) return <RefChip value={cell} onNavigate={onNavigate} />;
  if (isMoney(cell)) return copy.value(cell.amount, "money", cell.currency);
  if (isStatus(cell)) return <StatusPill status={cell} copy={copy} />;
  if (kind === "status" && typeof cell === "string") return <StatusPill status={{ code: cell }} copy={copy} />;
  if (kind === "date" && typeof cell === "string") return copy.day(cell);
  // An order that is not late shows no days overdue.
  if (code === "days_overdue" && typeof cell === "number" && cell <= 0) return "—";
  if (kind === "quantity" && typeof cell === "number") return copy.value(cell, "quantity", null, unitOf(row, code, cell));
  // An amount with no currency of its own stays a plain number rather than guessing one.
  if (typeof cell === "number") return copy.value(cell, kind === "percent" || kind === "days" ? kind : "count");
  return cell;
}

// A table the server built from a tool's rows. Columns sort; in a narrow
// panel each row becomes a small card, the first five until "Show all".
// "Show all" past the rows given opens the module's list.
export function DataTablePart({ props, language, onNavigate }: { props: TableProps; language?: string; onNavigate?: Navigate }) {
  const copy = usePartCopy(language);
  const [sort, setSort] = useState<{ code: string; direction: 1 | -1 } | null>(null);
  const [expanded, setExpanded] = useState(false);
  const label = (code: string) => copy.known("ai.v2.column", code);
  const rows = sort
    ? [...props.rows].sort((left, right) => {
        const a = sortKey(left[sort.code] ?? null, copy);
        const b = sortKey(right[sort.code] ?? null, copy);
        if (a === null || b === null) return a === b ? 0 : a === null ? 1 : -1;
        return (typeof a === "number" && typeof b === "number" ? a - b : String(a).localeCompare(String(b), copy.locale, { numeric: true })) * sort.direction;
      })
    : props.rows;
  const toggle = (code: string) => setSort((current) => current?.code === code ? { code, direction: current.direction === 1 ? -1 : 1 } : { code, direction: 1 });
  const showAll = props.more && props.listRoute && onNavigate && !isUnavailableProductRoute(props.listRoute.moduleId) ? props.listRoute : null;
  const folded = !expanded && rows.length > NARROW_ROWS;
  const cards = folded ? rows.slice(0, NARROW_ROWS) : rows;
  const [lead, ...rest] = props.columns;
  const cell = (row: Row, column: Column) => <Cell cell={row[column.code] ?? null} kind={column.kind} code={column.code} row={row} copy={copy} onNavigate={onNavigate} />;
  const linkClass = "text-[13px] font-medium hover:underline";
  return (
    <section data-testid="ai-v2-table" lang={copy.language} className="@container space-y-2">
      {props.title ? <h4 className="text-[13px] font-semibold" style={{ color: A.label }}>{props.title}</h4> : null}
      <div className="hidden overflow-x-auto rounded-xl @lg:block" style={cardStyle}>
        <table className="w-full text-[13px]">
          <thead>
            <tr style={{ borderBottom: `1px solid ${A.gray4}` }}>
              {props.columns.map((column) => {
                const active = sort?.code === column.code;
                return (
                  <th key={column.code} scope="col" aria-sort={active ? (sort.direction === 1 ? "ascending" : "descending") : "none"} className={`px-3 py-2 font-medium ${NUMERIC.includes(column.kind) ? "text-right" : "text-left"}`} style={{ color: A.sub }}>
                    <button type="button" onClick={() => toggle(column.code)} title={copy.t("ai.v2.sortBy", { column: label(column.code) })} className="inline-flex items-center gap-1 hover:underline">
                      {label(column.code)}
                      {active ? sort.direction === 1 ? <ArrowUp size={12} aria-hidden /> : <ArrowDown size={12} aria-hidden /> : null}
                    </button>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => (
              <tr key={index} data-testid="ai-v2-table-row" style={{ borderTop: index ? `1px solid ${A.gray5}` : undefined }}>
                {props.columns.map((column) => <td key={column.code} className={`px-3 py-2 align-top ${NUMERIC.includes(column.kind) ? "text-right tabular-nums" : ""}`} style={{ color: A.label }}>{cell(row, column)}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {/* In the narrow panel: the record and its status on one line, the rest of its row on the next. */}
      <ul className="divide-y rounded-xl px-3 py-1 @lg:hidden" style={cardStyle}>
        {cards.map((row, index) => {
          const present = rest.filter((column) => row[column.code] !== null && row[column.code] !== undefined && row[column.code] !== "");
          const statuses = present.filter((column) => column.kind === "status");
          const filled = present.filter((column) => column.kind !== "status");
          return (
            <li key={index} data-testid="ai-v2-table-card" className="py-1.5 text-[13px] leading-5" style={{ borderColor: A.gray5 }}>
              <div className="flex flex-wrap items-center gap-x-2 font-medium" style={{ color: A.label }}>{cell(row, lead)}{statuses.map((column) => <span key={column.code}>{cell(row, column)}</span>)}</div>
              {filled.length ? <div style={{ color: A.sub }}>{filled.map((column, position) => (
                <span key={column.code}>{position ? " · " : ""}<span className={column.kind === "text" || column.kind === "ref" ? "" : "whitespace-nowrap"}>{column.kind === "text" || column.kind === "ref" || column.code === "days" ? null : <>{label(column.code)} </>}<span className={NUMERIC.includes(column.kind) ? "tabular-nums" : ""} style={{ color: A.label }}>{cell(row, column)}</span></span></span>
              ))}</div> : null}
            </li>
          );
        })}
      </ul>
      {folded ? (
        // The rows this answer holds, never more (2026-11-05: "Show all 10"
        // when the list had 18).
        <button type="button" data-testid="ai-v2-table-expand" onClick={() => setExpanded(true)} className={`${linkClass} @lg:hidden`} style={{ color: A.blue }}>{copy.t("ai.v2.showMore", { count: copy.number(rows.length - NARROW_ROWS) })}</button>
      ) : null}
      {props.total > props.rows.length ? (
        <p data-testid="ai-v2-table-count" className="text-[12px]" style={{ color: A.gray1 }}>{copy.t("ai.v2.tableShowing", { shown: copy.number(props.rows.length), total: copy.number(props.total) })}</p>
      ) : null}
      {showAll ? (
        // In a narrow panel the list opens only once every row given is shown.
        <button type="button" data-testid="ai-v2-show-all" onClick={() => onNavigate?.(showAll.moduleId, null, { returnTo: "ai", source: "ai", query: showAll.query })} className={`${linkClass} ${folded ? "hidden @lg:inline" : ""}`} style={{ color: A.blue }}>{copy.t("ai.v2.showAll", { count: copy.number(props.total) })}</button>
      ) : null}
    </section>
  );
}
