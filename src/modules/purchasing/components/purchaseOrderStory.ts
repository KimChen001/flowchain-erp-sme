// What a purchase order still waits on once it is with the supplier: what is
// left to receive, to invoice and to pay, how its supplier invoices' variances
// were decided, and the one next action. Pure functions over the PO detail
// read, so a node test can check them (server/domain/purchase-order-story.test.mjs);
// the page turns the result into words with the pairs below. Display only:
// nothing here is sent to the server or changes what it accepts.

export type StoryExceptions = { count: number; open: number; approved: number; rejected: number };
// amount: what is owed on the invoice; openAmount: what is still unpaid. Null
// when the role cannot see invoice amounts.
export type StoryPayment = { status: string; amount: number | null; openAmount: number | null; currency?: string };

export type StoryInvoice = {
  // The invoice's own status (draft, submitted, matched, exception, approved, cancelled), when read.
  workflowStatus?: string;
  status?: string;
  matchStatus?: string;
  // The invoice's variance type, amount or match status says it has one.
  hasVariance: boolean;
  quantityVariance?: boolean;
  matchExceptions?: StoryExceptions | null;
  payment?: StoryPayment | null;
  // Older records mark a paid invoice with a flag instead of a payable.
  paid?: boolean;
};

export type VarianceState = "none" | "open" | "approved" | "rejected";

const EPSILON = 0.00005;
const CENT = 0.005;

export function isCancelledInvoice(invoice: Pick<StoryInvoice, "workflowStatus" | "status">) {
  return (invoice.workflowStatus || invoice.status) === "cancelled";
}

// The server's word for a match whose exceptions were all approved (for
// example variance_approved); "已解决" on older records.
const RESOLVED_MATCH_STATUS = /approved|^resolved$|已批准|已解决/i;

// Whether an invoice's variance still needs a decision. A variance is settled
// once every match exception on it is approved, which the server may also say
// in the match status, and which an approved invoice implies: an invoice with
// an exception is approved only after each exception is.
export function invoiceVarianceState(invoice: StoryInvoice): VarianceState {
  if (!invoice.hasVariance) return "none";
  if (RESOLVED_MATCH_STATUS.test(String(invoice.matchStatus || "").trim())) return "approved";
  if (invoice.workflowStatus === "approved") return "approved";
  const exceptions = invoice.matchExceptions;
  if (exceptions && exceptions.count > 0) {
    if (exceptions.open > 0) return "open";
    if (exceptions.rejected > 0) return "rejected";
    if (exceptions.approved > 0) return "approved";
  }
  return "open";
}

// unknown: the read says nothing about payment (the PO list's read).
export type PaymentState = "none" | "outstanding" | "partly_paid" | "paid" | "unknown";
export type PaymentSummary = { state: PaymentState; paid: number | null; open: number | null; owed: number | null };

const PAYABLE_DONE = new Set(["draft", "cancelled"]);
const round2 = (value: number) => Math.round(value * 100) / 100;

// What is paid on the order's supplier invoices: nothing to pay until an
// invoice is approved (its payable exists), then outstanding, partly paid or
// paid. An approved invoice with no payable recorded is owed, its amount not
// known. The amounts are null when a role cannot see them. payment undefined
// means the read did not say; null, that there is no payable.
export function paymentSummary(invoices: StoryInvoice[]): PaymentSummary {
  const active = invoices.filter((invoice) => !isCancelledInvoice(invoice));
  const approvedUnread = active.filter((invoice) => invoice.workflowStatus === "approved" && invoice.payment === undefined && !invoice.paid);
  const payables = active.filter((invoice) => (invoice.payment && !PAYABLE_DONE.has(invoice.payment.status)) || invoice.paid || (invoice.workflowStatus === "approved" && invoice.payment === null));
  if (!payables.length) return approvedUnread.length ? { state: "unknown", paid: null, open: null, owed: null } : { state: "none", paid: 0, open: 0, owed: 0 };
  let paid = 0;
  let open = 0;
  let known = !approvedUnread.length;
  let settled = !approvedUnread.length;
  let anyPaid = false;
  for (const invoice of payables) {
    const payment = invoice.payment;
    if (!payment) {
      known = false;
      // An older paid flag: paid, the amount not recorded on a payable.
      if (invoice.paid) anyPaid = true;
      // Approved with no payable recorded: owed.
      else settled = false;
      continue;
    }
    const amount = payment.amount;
    const openAmount = payment.openAmount;
    if (amount === null || amount === undefined || openAmount === null || openAmount === undefined) known = false;
    else {
      paid += amount - openAmount;
      open += openAmount;
    }
    const fullyPaid = payment.status === "settled" || (openAmount !== null && openAmount !== undefined && openAmount < CENT && amount !== null && amount !== undefined && amount > 0);
    const somePaid = payment.status === "partially_settled" || fullyPaid || (amount !== null && amount !== undefined && openAmount !== null && openAmount !== undefined && amount - openAmount >= CENT);
    if (!fullyPaid) settled = false;
    if (somePaid) anyPaid = true;
  }
  const state: PaymentState = settled ? "paid" : anyPaid ? "partly_paid" : "outstanding";
  return { state, paid: known ? round2(paid) : null, open: known ? round2(open) : null, owed: known ? round2(paid + open) : null };
}

// One PO line: ordered, received (accepted) and invoiced on active invoices.
export type StoryLine = { ordered: number; accepted: number; invoiced: number; unit: string };

// A quantity left on some lines: one total when they share a unit, else the
// number of lines.
export type Remaining = { quantity: number; unit: string; lines: number } | { quantity: null; unit: null; lines: number };

function remainingOf(lines: StoryLine[], left: (line: StoryLine) => number): Remaining | null {
  const open = lines.map((line) => ({ line, left: left(line) })).filter((entry) => entry.left > EPSILON);
  if (!open.length) return null;
  const units = new Set(open.map((entry) => entry.line.unit));
  if (units.size === 1) return { quantity: open.reduce((sum, entry) => sum + entry.left, 0), unit: open[0].line.unit, lines: open.length };
  return { quantity: null, unit: null, lines: open.length };
}

export type NextAction =
  | { kind: "review_quantity_variance" }
  | { kind: "review_invoice_variance" }
  | { kind: "variance_rejected" }
  | { kind: "receive"; started: boolean; remaining: Remaining }
  | { kind: "submit_invoice" }
  | { kind: "match_invoice" }
  | { kind: "approve_invoice" }
  | { kind: "invoice_rest"; remaining: Remaining }
  | { kind: "pay"; open: number | null }
  | { kind: "check_payment" }
  | { kind: "done" };

// The next action for an order the supplier has, from what is left, in the
// order the work happens: a variance waiting on a decision first, then goods
// still to receive, a supplier invoice still on its way to approval, received
// goods not invoiced yet, and invoices not paid yet. Received means accepted;
// what is invoiced is checked against it. invoiceLinesKnown is false when the
// read carries no invoice lines (the PO list), so nothing is said about
// quantities left to invoice.
export function nextOpenAction({ receivable, lines, invoices, invoiceLinesKnown = true }: { receivable: boolean; lines: StoryLine[]; invoices: StoryInvoice[]; invoiceLinesKnown?: boolean }): NextAction {
  const active = invoices.filter((invoice) => !isCancelledInvoice(invoice));
  const states = active.map((invoice) => ({ invoice, state: invoiceVarianceState(invoice) }));
  const open = states.filter((entry) => entry.state === "open");
  if (open.length) return open.some((entry) => entry.invoice.quantityVariance) ? { kind: "review_quantity_variance" } : { kind: "review_invoice_variance" };
  if (states.some((entry) => entry.state === "rejected")) return { kind: "variance_rejected" };
  const toReceive = receivable ? remainingOf(lines, (line) => line.ordered - line.accepted) : null;
  if (toReceive) return { kind: "receive", started: lines.some((line) => line.accepted > EPSILON), remaining: toReceive };
  const workflow = new Set(active.map((invoice) => invoice.workflowStatus || ""));
  if (workflow.has("draft")) return { kind: "submit_invoice" };
  if (workflow.has("submitted")) return { kind: "match_invoice" };
  if (workflow.has("matched") || workflow.has("exception")) return { kind: "approve_invoice" };
  const toInvoice = invoiceLinesKnown ? remainingOf(lines, (line) => line.accepted - line.invoiced) : null;
  if (toInvoice) return { kind: "invoice_rest", remaining: toInvoice };
  const payment = paymentSummary(active);
  if (payment.state === "unknown") return { kind: "check_payment" };
  if (payment.state === "outstanding" || payment.state === "partly_paid") return { kind: "pay", open: payment.open };
  return { kind: "done" };
}

// Words: English first, with the Chinese translation.
export type StoryWords = {
  language: string;
  // "14 pcs" in the interface language.
  quantity: (value: number, unit: string) => string;
  number: (value: number) => string;
  money: (value: number) => string;
};

export function nextActionText(action: NextAction, words: StoryWords): string {
  const pick = (pair: [string, string]) => (words.language === "en-US" ? pair[0] : pair[1]);
  const amount = (remaining: Remaining) => (remaining.quantity === null ? null : words.quantity(remaining.quantity, remaining.unit));
  switch (action.kind) {
    case "review_quantity_variance":
      return pick(["Review the quantity variance on the supplier invoice", "复核采购发票的数量差异"]);
    case "review_invoice_variance":
      return pick(["Review the variance on the supplier invoice", "复核采购发票的差异"]);
    case "variance_rejected":
      return pick(["Variance rejected: ask the supplier for a corrected invoice", "差异已驳回：请供应商更正发票"]);
    case "receive": {
      const quantity = amount(action.remaining);
      const lines = words.number(action.remaining.lines);
      if (action.started) return quantity ? pick([`Receive the remaining ${quantity}`, `收货剩余 ${quantity}`]) : pick([`Receive the rest of ${lines} lines`, `收货剩余 ${lines} 行`]);
      return quantity ? pick([`Receive ${quantity} when they arrive`, `到货后收货 ${quantity}`]) : pick([`Receive ${lines} lines when they arrive`, `到货后收货 ${lines} 行`]);
    }
    case "submit_invoice":
      return pick(["Submit the supplier invoice", "提交采购发票"]);
    case "match_invoice":
      return pick(["Run the three-way match on the supplier invoice", "对采购发票执行三单匹配"]);
    case "approve_invoice":
      return pick(["Approve the supplier invoice", "批准采购发票"]);
    case "invoice_rest": {
      const quantity = amount(action.remaining);
      const lines = words.number(action.remaining.lines);
      return quantity
        ? pick([`Record a supplier invoice for the remaining ${quantity}`, `为剩余 ${quantity}录入采购发票`])
        : pick([`Record supplier invoices for the rest of ${lines} lines`, `为剩余 ${lines} 行录入采购发票`]);
    }
    case "check_payment":
      return pick(["Invoiced; see Payables for payment", "已开票；付款情况见应付"]);
    case "pay":
      return action.open === null
        ? pick(["Awaiting payment", "等待付款"])
        : pick([`Awaiting payment: ${words.money(action.open)} outstanding`, `等待付款：未付 ${words.money(action.open)}`]);
    case "done":
      return pick(["Nothing left to do: received, invoiced and paid", "已全部完成：已收货、已开票并已付款"]);
  }
}

// The payment stage in words: its chip and the amounts under it.
export function paymentStateLabel(state: PaymentState, language: string) {
  const pairs: Record<PaymentState, [string, string]> = {
    none: ["Nothing to pay yet", "暂无应付"],
    unknown: ["See Payables", "见应付"],
    outstanding: ["Outstanding", "待付款"],
    partly_paid: ["Partly paid", "部分付款"],
    paid: ["Paid", "已付款"],
  };
  return pairs[state][language === "en-US" ? 0 : 1];
}

export function paymentAmountsText(summary: PaymentSummary, words: StoryWords): string {
  const pick = (pair: [string, string]) => (words.language === "en-US" ? pair[0] : pair[1]);
  if (summary.state === "none" || summary.paid === null || summary.open === null) return "";
  const paid = words.money(summary.paid);
  const open = words.money(summary.open);
  if (summary.state === "paid") return pick([`${paid} paid`, `已付 ${paid}`]);
  if (summary.state === "outstanding") return pick([`${open} outstanding`, `未付 ${open}`]);
  return pick([`${paid} paid · ${open} outstanding`, `已付 ${paid} · 未付 ${open}`]);
}
