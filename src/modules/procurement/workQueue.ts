import type { ProcurementDocument, ProcurementWorkItem } from "./procurementTypes";

// The purchasing workbench's queues (ProcurementWorkbench.tsx), kept apart
// from the page so a test can check that each card's number is the number of
// rows the queue it opens lists.
//
//   all        every row: requests and orders still open, and supplier
//              invoices held by a match exception
//   approval   requests and orders submitted for approval
//   tracking   requests and orders approved or issued, not finished
//   issues     supplier invoices held by a match exception, whatever the
//              status of the order they bill (design audit L1-18 = L7-02,
//              L7-03): a closed order's held invoice still needs the buyer.
//              The rule is the supplier invoice list's "exception" filter and
//              its Match exceptions card (matchHeldInvoiceWhere on the
//              server), so the three agree.

export type Queue = "all" | "approval" | "tracking" | "issues";
export const QUEUES: Queue[] = ["all", "approval", "tracking", "issues"];
// A row with how many days it is past its date (0 when it is not): an
// order's expected arrival, or a held invoice's due date.
export type WorkRow = ProcurementWorkItem & { daysLate?: number; orderNumber?: string };

// The status code an invoice the three-way match held is stored with, until
// it is approved or cancelled.
export const MATCH_HELD_INVOICE_STATUS = "exception";
// The match status of a held invoice whose every difference was approved:
// it waits for its own approval, not for a review.
const MATCH_VARIANCE_APPROVED = "variance_approved";

// Whole calendar days from one YYYY-MM-DD day to another.
export const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from.slice(0, 10)}T00:00:00Z`)) / 86_400_000);

// Held by a match exception, by the code the invoice is stored with
// (workflowStatus; status on a record that carries no separate code). A
// variance amount alone is not the test: an approved invoice keeps its
// variance amount, and a quantity difference has none (design audit L2-08).
export function isMatchHeldInvoice(invoice: Pick<ProcurementDocument, "status"> & { workflowStatus?: string }) {
  return String(invoice.workflowStatus || invoice.status || "").trim() === MATCH_HELD_INVOICE_STATUS;
}

// One row per supplier invoice held by a match exception: its number, the
// order it bills, the supplier, its due date (late once past it, by the
// workspace day `today`), its amount (null when hidden) and what it waits
// for: a review of the difference, or approval once every difference was
// approved.
export function heldInvoiceRows(invoices: ProcurementDocument[], today: string): WorkRow[] {
  return invoices.filter(isMatchHeldInvoice).map((invoice) => {
    const id = String(invoice.id || "");
    const due = String(invoice.dueDate || "").slice(0, 10);
    const late = due && today ? daysBetween(due, today) : 0;
    const daysLate = Number.isFinite(late) && late > 0 ? late : 0;
    const differencesApproved = String(invoice.matchStatus || "") === MATCH_VARIANCE_APPROVED;
    // A role that may not see amounts gets null, never 0.
    const amount = invoice.amount as number | null | undefined;
    return {
      daysLate,
      id,
      number: invoice.invoiceNumber || id,
      kind: "supplier_invoice",
      status: differencesApproved ? MATCH_VARIANCE_APPROVED : MATCH_HELD_INVOICE_STATUS,
      bucket: "issues",
      amount: amount === null || amount === undefined ? null : Number(amount),
      currency: invoice.currency,
      item: "",
      moreLines: 0,
      supplier: invoice.supplierName || "",
      dueDate: due || undefined,
      orderNumber: invoice.poNumber || invoice.relatedPo || undefined,
      signals: [...(daysLate ? ["overdue"] : []), differencesApproved ? "invoice_to_approve" : "match_exception"],
    };
  });
}

export function inWorkQueue(row: WorkRow, queue: Queue) {
  return queue === "all" || row.bucket === queue;
}

export function workQueueCount(rows: WorkRow[], queue: Queue) {
  return rows.filter((row) => inWorkQueue(row, queue)).length;
}
