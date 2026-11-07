import { typography } from "./typography";

export const tableScrollClass = "overflow-x-auto";
export const tableBodyTextClass = typography.tableCell;
export const tableBaseClass = `w-full ${tableBodyTextClass}`;
export const tableMinSmClass = `w-full min-w-[980px] ${tableBodyTextClass}`;
export const tableMinMdClass = `w-full min-w-[1180px] ${tableBodyTextClass}`;
export const tableMinLgClass = `w-full min-w-[1280px] ${tableBodyTextClass}`;
export const tableMinXlClass = `w-full min-w-[1480px] ${tableBodyTextClass}`;

export const thClass = `text-left px-4 py-3 ${typography.tableHeader} whitespace-nowrap`;
export const thRightClass = `text-right px-4 py-3 ${typography.tableHeader} whitespace-nowrap`;
export const thWideClass = `text-left px-5 py-3 ${typography.tableHeader} whitespace-nowrap`;
export const tdClass = "px-4 py-3";
export const tdWideClass = "px-5 py-3";
export const tdNowrapClass = "px-4 py-3 whitespace-nowrap";
export const tdWideNowrapClass = "px-5 py-3 whitespace-nowrap";
export const tdIdClass = "px-4 py-3 whitespace-nowrap font-medium tabular-nums";
export const tdWideIdClass = "px-5 py-3 whitespace-nowrap font-medium tabular-nums";
export const tdNumericClass = "px-4 py-3 whitespace-nowrap tabular-nums";
export const tdWideNumericClass = "px-5 py-3 whitespace-nowrap tabular-nums";
export const tdNumericRightClass = "px-4 py-3 whitespace-nowrap tabular-nums text-right";
export const tdActionClass = "px-4 py-3 whitespace-nowrap min-w-[140px]";
export const tdWideActionClass = "px-5 py-3 whitespace-nowrap min-w-[140px]";
export const tdNameClass = "px-4 py-3 whitespace-nowrap";
export const tdWideNameClass = "px-5 py-3 whitespace-nowrap";
export const tableLinkClass = `${typography.tableLink} tabular-nums hover:underline rounded-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-200`;

// Phones (below 640 px) show a list table's rows as cards (CSS in theme.css,
// under table[data-list-cards]): the record's number or name with its status
// on the first line, the other cells as label/value pairs, the row's actions
// at the bottom. The roles come from the header: the first column (after a
// checkbox column) is the record, the first column named "Status" its
// status, a column named "Actions" (or an unnamed last column) its actions;
// each other cell gets its column name in data-label. Wider screens ignore
// these attributes, so the table there is unchanged.
const STATUS_HEADER = /status|状态/i;
const ACTION_HEADER = /^(actions?|操作)$/i;

function setAttribute(element: Element, name: string, value: string) {
  if (element.getAttribute(name) !== value) element.setAttribute(name, value);
}

function labelListTable(table: HTMLTableElement) {
  const head = table.tHead?.rows[0];
  if (!head) return;
  const labels: string[] = [];
  // A header cell marked data-card-title names the record when the first
  // column does not (a date, say).
  let markedTitle = -1;
  for (const cell of Array.from(head.cells)) {
    const text = (cell.textContent || "").replace(/\s+/g, " ").trim();
    if (cell.hasAttribute("data-card-title")) markedTitle = labels.length;
    for (let span = 0; span < Math.max(1, cell.colSpan); span += 1) labels.push(text);
  }
  if (labels.length < 2) return;
  const selectColumn = !labels[0] && head.cells[0]?.querySelector("input[type=checkbox]") ? 0 : -1;
  const titleColumn = markedTitle >= 0 ? markedTitle : selectColumn === 0 ? 1 : 0;
  // A column named just "Status" wins over "Credit status" and the like.
  const statusNamed = (pattern: RegExp) => labels.findIndex((label, index) => index > titleColumn && pattern.test(label));
  const statusColumn = statusNamed(/^(status|状态)$/i) >= 0 ? statusNamed(/^(status|状态)$/i) : statusNamed(STATUS_HEADER);
  const last = labels.length - 1;
  const isActions = (column: number) => column > titleColumn && (ACTION_HEADER.test(labels[column]) || (column === last && !labels[column]));
  setAttribute(table, "data-list-cards", "");
  const rows = [...Array.from(table.tBodies).flatMap((body) => Array.from(body.rows)), ...Array.from(table.tFoot?.rows || [])];
  for (const row of rows) {
    const cells = Array.from(row.cells);
    // A loading, empty or error row, or a row holding a panel across the table.
    if (cells.length === 1 && cells[0].colSpan > 1) {
      setAttribute(row, "data-card-row", "full");
      setAttribute(cells[0], "data-card-role", "full");
      continue;
    }
    setAttribute(row, "data-card-row", "record");
    let column = 0;
    for (const cell of cells) {
      const role = column === selectColumn ? "select" : column === titleColumn ? "title" : column === statusColumn ? "status" : isActions(column) ? "actions" : "field";
      setAttribute(cell, "data-card-role", role);
      if (role === "field" && labels[column]) setAttribute(cell, "data-label", labels[column]);
      else cell.removeAttribute("data-label");
      column += Math.max(1, cell.colSpan);
    }
  }
}

const watchedLists = new WeakSet<HTMLElement>();

// Ref for a list's table container (ListCard sets it on its body): labels the
// tables inside for the phone card layout, again whenever rows or header text
// change. Put it on the scroll box of a list table that is not in a ListCard.
export function listTableCardsRef(element: HTMLElement | null) {
  if (!element || watchedLists.has(element) || typeof MutationObserver === "undefined") return;
  watchedLists.add(element);
  let frame = 0;
  const label = () => {
    frame = 0;
    const tables = element instanceof HTMLTableElement ? [element] : Array.from(element.querySelectorAll("table"));
    tables.forEach(labelListTable);
  };
  label();
  new MutationObserver(() => {
    if (!frame) frame = requestAnimationFrame(label);
  }).observe(element, { childList: true, subtree: true, characterData: true });
}
