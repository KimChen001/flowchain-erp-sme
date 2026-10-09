import { useEffect, type RefObject } from "react";

// On phones every table in the module content shows as cards (phone.css,
// table.fc-cards): each cell prints its column header as a label. This keeps
// the labels on the cells as pages render and update, so no page has to
// change its table markup. Print documents (.print-data-table) and tables
// marked data-mobile-table="keep" stay tables.

function headerLabels(table: HTMLTableElement) {
  const row = table.tHead?.rows[table.tHead.rows.length - 1];
  if (!row) return [];
  const labels: string[] = [];
  for (const cell of Array.from(row.cells)) {
    const text = (cell.textContent || "").replace(/\s+/g, " ").trim();
    // The buttons say what they do; "Actions" above them adds nothing.
    const label = /^(actions?|操作)$/i.test(text) ? "" : text;
    for (let span = 0; span < Math.max(1, cell.colSpan); span += 1) labels.push(label);
  }
  return labels;
}

export function labelTableCells(root: ParentNode) {
  for (const table of Array.from(root.querySelectorAll("table"))) {
    if (table.classList.contains("print-data-table") || table.closest('[data-mobile-table="keep"]')) continue;
    if (!table.classList.contains("fc-cards")) table.classList.add("fc-cards");
    const labels = headerLabels(table);
    for (const body of Array.from(table.tBodies)) {
      for (const row of Array.from(body.rows)) {
        let column = 0;
        for (const cell of Array.from(row.cells)) {
          const label = labels[column] || "";
          if (cell.getAttribute("data-label") !== label) cell.setAttribute("data-label", label);
          column += Math.max(1, cell.colSpan);
        }
      }
    }
  }
}

export function useTableCardLabels(ref: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const root = ref.current;
    if (!root || typeof MutationObserver === "undefined") return;
    // One pass per batch of changes. A microtask, not an animation frame, so
    // labelling never waits for the page to paint.
    let pending = false;
    let active = true;
    const schedule = () => {
      if (pending) return;
      pending = true;
      queueMicrotask(() => { pending = false; if (active) labelTableCells(root); });
    };
    labelTableCells(root);
    // Only added or removed nodes and changed text matter; attribute writes
    // made here do not trigger the observer again.
    const observer = new MutationObserver(schedule);
    observer.observe(root, { childList: true, subtree: true, characterData: true });
    return () => {
      active = false;
      observer.disconnect();
    };
  }, [ref]);
}
