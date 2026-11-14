import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { ChevronDown, ChevronRight, Sparkles } from "lucide-react";
import { A, Card } from "../../components/ui";
import { listButtonClass, rowActionClass } from "../../components/ui/listLayout";
import { useI18n } from "../../i18n/I18n";
import { unitLabel } from "../../i18n/unitLabels";
import { ApiError, apiJson } from "../../lib/api-client";
import { useDocumentNumbers } from "../../lib/documentNumbers";
import { formatQuantity } from "../../lib/format";
import { followUpMessage, invoiceCorrectionMessage, useDecisionCopy, type DecisionCopyKey } from "./decisionCopy";
import { formatLocaleAmount } from "../../lib/format";
import { useTodayRowFormat } from "./todayRowFormat";

// The decision cards on Today (docs/drafted-decisions-design.md): for each row
// the server prepared a next step for (GET /api/home/overview, decisions),
// the draft, why, and one click to act on it; "Not now" and "Not needed" set
// it aside until its condition changes. The list of rows set aside sits
// below, collapsed. Every write goes through its own route: the purchase
// request form, POST /api/procurement/requests/:id/generate-purchase-orders,
// and POST /api/decision-items/decide or /reopen.

export type TodayRow = {
  id: string;
  kind: string;
  entityType: string;
  recordId: string;
  label: string;
  name: string | null;
  href: string;
  actionHref: string | null;
  date: string | null;
  dateKind: string;
  overdueDays: number;
  detail: Record<string, any>;
};
type ReorderDraft = {
  type: "purchase_request"; itemId: string; sku: string; itemName: string | null; unit: string | null; quantity: number | null; raisedToMinimum: boolean;
  shortfall: number | null; position: number | null; reorderPoint: number | null; orderByDate: string | null;
  supplier: { id: string; name: string; minimumOrderQuantity: number | null; leadTimeDays: number | null } | null;
  openRequests: Array<{ id: string; number: string; status: string }>;
};
type FollowUpDraft = {
  type: "supplier_follow_up"; purchaseOrderId: string; orderNumber: string; dueDate: string | null; overdueDays: number;
  supplier: { id: string | null; name: string | null; contactName: string | null; email: string | null };
  lines: Array<{ sku: string | null; remaining: number | null; unit: string | null; promisedDate: string | null }>; moreLines: number;
};
type ConversionDraft = {
  type: "purchase_orders_from_request"; purchaseRequestId: string; number: string; version: number;
  orders: Array<{ supplierId: string; supplierName: string; currency: string; warehouseId: string; lines: number }>;
  missing: Array<{ line: number; sku: string | null; fields: string[] }>;
};
// A supplier invoice the three-way match held (server/domain/invoice-exception-draft.mjs).
type InvoiceDifference = {
  exceptionId: string; kind: "price" | "quantity" | "amount"; cause: string | null; sku: string | null; unit: string | null;
  expected: number | null; actual: number | null; variance: number | null; percent?: number | null; evidenceOrder?: string | null;
  ordered?: number | null; received?: number | null; previouslyInvoiced?: number | null; invoiced?: number | null; missing?: number | null;
};
type InvoiceExceptionDraft = {
  type: "invoice_exception"; invoiceId: string; invoiceNumber: string; orderId: string | null; orderNumber: string | null; currency: string | null; amountsVisible: boolean;
  supplier: { id: string | null; name: string | null; contactName: string | null; email: string | null };
  step: "ask_supplier" | "review_price" | "wait_receipt"; differences: InvoiceDifference[]; moreDifferences: number;
};
type Draft = ReorderDraft | FollowUpDraft | ConversionDraft | InvoiceExceptionDraft;
export type WaitingEntry = { key: string; row: TodayRow; raisedAt: string | null; returned: boolean; draft: Draft | null };
export type SetAsideEntry = {
  key: string; row: TodayRow; decision: "not_now" | "not_needed" | "chased" | "accepted" | "covered"; reasonCode: string | null; note: string | null;
  returnOn: string | null; decidedAt: string | null; decidedOn: string | null; decidedBy: { name: string } | null;
  documentType: string | null; documentIds: string[]; documentNumber: string | null;
};
// supplierEmail: whether follow-ups may be emailed from the cards (the
// workspace switch, the reader's permission and a mail provider), and whether
// an email would only reach the local outbox.
export type SupplierEmail = { enabled: boolean; canSend: boolean; outbox: boolean };
export type TodayDecisions = { available: boolean; canDecide?: boolean; supplierEmail?: SupplierEmail; waiting?: WaitingEntry[]; setAside?: SetAsideEntry[] };

const REASONS = ["seasonal", "discontinued", "covered_elsewhere", "supplier_confirmed", "other"] as const;
// A card's actions read like the buttons on top of the list pages: the one
// that acts in blue, the others light.
const BUTTON = { primary: `${listButtonClass.primary} !text-[12px] !no-underline`, secondary: `${listButtonClass.secondary} !text-[12px] !no-underline` };
const LINK = "fc-entity-link font-semibold text-blue-600 underline-offset-2 hover:underline";

const addDays = (day: string, days: number) => {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
};
const nextMonday = (day: string) => {
  const weekday = new Date(`${day}T00:00:00Z`).getUTCDay();
  return addDays(day, ((8 - weekday) % 7) || 7);
};

async function decide(key: string, body: Record<string, unknown>) {
  return apiJson("/api/decision-items/decide", { method: "POST", body: JSON.stringify({ key, ...body }) });
}

type Shared = {
  // Whether this reader may decide; otherwise the cards are read only.
  canDecide: boolean;
  today: string;
  day: (value: string) => string;
  dateText: (row: TodayRow) => string;
  tone: (row: TodayRow) => { color: string; background: string };
  kindLabel: (row: TodayRow) => string;
  labelOf: (row: TodayRow) => string;
  onChanged: () => void;
};

// Today shows this many cards before "Show {n} more".
const SHOWN = 5;

export function DecisionSection({ decisions, overdueOnly, ...rest }: Omit<Shared, "canDecide"> & { decisions: TodayDecisions; overdueOnly: boolean }) {
  const t = useDecisionCopy();
  const [all, setAll] = useState(false);
  const shared: Shared = { ...rest, canDecide: decisions.canDecide === true };
  const waiting = (decisions.waiting || []).filter((entry) => !overdueOnly || entry.row.overdueDays > 0);
  const shown = all ? waiting : waiting.slice(0, SHOWN);
  const setAside = decisions.setAside || [];
  return (
    <Card className="p-5" data-testid="today-decisions">
      <div className="flex items-start gap-2">
        <Sparkles size={16} className="mt-0.5 shrink-0" style={{ color: "#2563eb" }} aria-hidden />
        <div>
          <h2 className="text-sm font-semibold">{waiting.length ? t("welcomeTitle", { n: waiting.length }) : t("title")}</h2>
          <p className="mt-0.5 text-xs" style={{ color: A.sub }}>{shared.canDecide ? t("note") : t("readOnly")}</p>
        </div>
      </div>
      {waiting.length === 0 ? (
        <p className="py-6 text-center text-sm" style={{ color: A.sub }} data-testid="today-decisions-empty">{t("none")}</p>
      ) : (
        <ul className="mt-3 space-y-2" data-testid="today-decision-list">
          {shown.map((entry) => <DecisionCard key={entry.key} entry={entry} email={decisions.supplierEmail?.canSend ? decisions.supplierEmail : null} {...shared} />)}
        </ul>
      )}
      {waiting.length > SHOWN ? (
        <button type="button" className="mt-2 text-xs font-medium text-blue-600" onClick={() => setAll((value) => !value)} data-testid="today-decisions-more">
          {all ? t("fewerDecisions") : t("moreDecisions", { n: waiting.length - SHOWN })}
        </button>
      ) : null}
      {setAside.length ? <SetAsideList entries={setAside} {...shared} /> : null}
    </Card>
  );
}

type Overview = { today: string; decisions?: TodayDecisions };

// Today's decision cards inside an assistant answer (the decisions part of
// assistant v2, show_decisions): the items the answer named, read from Today
// itself (GET /api/home/overview), each with the same card and buttons as on
// Today. After a click the cards read Today again; an item no longer waiting
// says how it was settled. Without keys (the assistant's welcome) it is one
// line, "Waiting for your decision · 4", that opens the first `limit` items;
// nothing when none waits.
export function TodayDecisionCards({ keys: named, more: namedMore = 0, limit = 3 }: { keys?: string[]; more?: number; limit?: number }) {
  const t = useDecisionCopy();
  const [overview, setOverview] = useState<Overview | null>(null);
  const [failed, setFailed] = useState(false);
  const [welcomeOpen, setWelcomeOpen] = useState(false);
  const load = async () => {
    try {
      setOverview(await apiJson<Overview>("/api/home/overview"));
      setFailed(false);
    } catch {
      setFailed(true);
    }
  };
  useEffect(() => { void load(); }, [(named || []).join("|")]);
  const today = overview?.today || "";
  const { day, dateText, tone, kindLabel } = useTodayRowFormat(today);
  const decisions = overview?.decisions;
  const waiting = new Map((decisions?.waiting || []).map((entry) => [entry.key, entry]));
  const aside = new Map((decisions?.setAside || []).map((entry) => [entry.key, entry]));
  const welcome = !named;
  const keys = named || [...waiting.keys()].slice(0, limit);
  const more = named ? namedMore : Math.max(0, waiting.size - keys.length);
  const shownRows = keys.map((key) => waiting.get(key)?.row || aside.get(key)?.row).filter((row): row is TodayRow => Boolean(row));
  const shownNumber = useDocumentNumbers(shownRows.filter((row) => row.label === row.recordId).map((row) => [row.entityType, row.recordId] as const));
  const labelOf = (row: TodayRow) => (row.label === row.recordId ? shownNumber(row.entityType, row.recordId) || row.label : row.label);
  const status = useAsideStatus([...aside.values()], day);
  if (welcome && (failed || !overview || !decisions?.available || !keys.length)) return null;
  if (failed || (overview && !decisions?.available)) return <p className="text-xs" style={{ color: A.sub }} data-testid="ai-decisions-unavailable">{t("chatUnavailable")}</p>;
  if (!overview) return <p className="text-xs" style={{ color: A.sub }}>{t("chatLoading")}</p>;
  const shared: Shared = { canDecide: decisions?.canDecide === true, today, day, dateText, tone, kindLabel, labelOf, onChanged: () => { void load(); } };
  const heading = welcome ? (
    <button type="button" className="flex w-full items-center gap-1.5 rounded-lg border px-3 py-2 text-left text-[13px] font-semibold hover:bg-slate-50" style={{ color: A.label, borderColor: A.gray4 }} aria-expanded={welcomeOpen} onClick={() => setWelcomeOpen((value) => !value)} data-testid="ai-welcome-decisions-toggle">
      <Sparkles size={14} style={{ color: "#2563eb" }} aria-hidden />
      <span className="flex-1">{t("welcomeTitle", { n: waiting.size })}</span>
      {welcomeOpen ? <ChevronDown size={14} style={{ color: A.gray1 }} aria-hidden /> : <ChevronRight size={14} style={{ color: A.gray1 }} aria-hidden />}
    </button>
  ) : null;
  if (welcome && !welcomeOpen) return <div data-testid="ai-welcome-decisions">{heading}</div>;
  return (
    <div className="space-y-2" data-testid={welcome ? "ai-welcome-decisions" : "ai-decisions"}>
      {heading}
      <ul className="space-y-2">
        {keys.map((key) => {
          const entry = waiting.get(key);
          if (entry) return <DecisionCard key={key} entry={entry} email={decisions?.supplierEmail?.canSend ? decisions.supplierEmail : null} {...shared} />;
          const settled = aside.get(key);
          return (
            <li key={key} className="rounded-lg border px-3 py-2 text-xs" style={{ borderColor: A.gray4, color: A.sub }} data-testid="ai-decision-settled">
              {settled ? <><span className="font-medium" style={{ color: A.label }}>{kindLabel(settled.row)}</span> <Link to={settled.row.href} className={LINK}>{labelOf(settled.row)}</Link> · {status(settled)}</> : t("chatGone")}
            </li>
          );
        })}
      </ul>
      {more > 0 ? <Link to="/app/overview/risks" className={`text-xs ${LINK}`}>{t("chatMore", { n: more })}</Link> : null}
    </div>
  );
}

function DecisionCard({ entry, email, canDecide, today, day, dateText, tone, kindLabel, labelOf, onChanged }: Shared & { entry: WaitingEntry; email: SupplierEmail | null }) {
  const t = useDecisionCopy();
  const { row, draft } = entry;
  const [mode, setMode] = useState<null | "not_now" | "not_needed">(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const run = async (work: () => Promise<string | null | void>) => {
    setBusy(true);
    setMessage(null);
    try {
      const done = await work();
      if (done) setMessage(done);
      onChanged();
    } catch (error) {
      if (error instanceof ApiError && error.code === "DECISION_ALREADY_MADE") { setMessage(t("stale")); onChanged(); }
      else setMessage(t("failed", { message: error instanceof Error ? error.message : String(error) }));
    } finally {
      setBusy(false);
    }
  };
  // One line until Details opens it: the card's short fact and main button
  // stay on the line; why, the message, "Not now" and "Not needed" are under
  // Details. The body stays mounted, so an edited message survives closing it.
  const [open, setOpen] = useState(false);
  const toggle = (
    <button type="button" className="flex shrink-0 items-center gap-0.5 text-xs font-medium text-blue-600" aria-expanded={open} onClick={() => setOpen((value) => !value)} data-testid="decision-details">
      {open ? <ChevronDown size={14} aria-hidden /> : <ChevronRight size={14} aria-hidden />}
      {open ? t("hideDetails") : t("details")}
    </button>
  );
  const view: View = { open, toggle, onOpen: () => setOpen(true) };
  // "Not now" and "Not needed", at the end of the card's row of actions.
  const aside = canDecide ? (
    <>
      <button type="button" disabled={busy} className={BUTTON.secondary} aria-expanded={mode === "not_now"} onClick={() => setMode(mode === "not_now" ? null : "not_now")} data-testid="decision-not-now">{t("notNow")}</button>
      <button type="button" disabled={busy} className={BUTTON.secondary} aria-expanded={mode === "not_needed"} onClick={() => setMode(mode === "not_needed" ? null : "not_needed")} data-testid="decision-not-needed">{t("notNeeded")}</button>
    </>
  ) : null;

  return (
    <li className="rounded-lg border px-3 py-2.5" style={{ borderColor: A.gray4 }} data-testid="today-decision" data-kind={row.kind} data-key={entry.key}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
        <span className="inline-block shrink-0 rounded px-2 py-0.5 text-xs font-medium" style={tone(row)}>{dateText(row)}</span>
        <span className="shrink-0 text-sm font-medium">{kindLabel(row)}</span>
        <Link to={row.href} className={`shrink-0 text-xs ${LINK}`}>{labelOf(row)}</Link>
        {row.name ? <span className="max-w-[14rem] truncate text-xs" style={{ color: A.sub }} title={row.name}>{row.name}</span> : null}
        {entry.returned ? <span className="shrink-0 rounded bg-amber-50 px-1.5 py-0.5 text-[11px] font-medium text-amber-700">{t("returned")}</span> : null}
      {draft?.type === "purchase_request" ? <ReorderBody draft={draft} row={row} day={day} busy={busy} canDecide={canDecide} aside={aside} {...view} />
        : draft?.type === "supplier_follow_up" ? <FollowUpBody draft={draft} row={row} day={day} busy={busy} canDecide={canDecide} aside={aside} email={email} {...view} onChased={(text) => run(async () => {
          try { await navigator.clipboard.writeText(text); } catch { throw new Error(t("copyFailed")); }
          await decide(entry.key, { option: "chased" });
          return t("copied");
        })} onSend={(mail) => run(async () => {
          // The address the person confirmed on the second step is the one sent to.
          const result = await apiJson<{ outbox?: boolean }>("/api/decision-items/send-follow-up", { method: "POST", body: JSON.stringify({ key: entry.key, to: mail.to, confirmedTo: mail.to, subject: mail.subject, body: mail.body }) });
          return result?.outbox ? t("sentOutbox") : t("sentEmail", { to: mail.to });
        })} />
          : draft?.type === "invoice_exception" ? <InvoiceExceptionBody draft={draft} row={row} busy={busy} canDecide={canDecide} aside={aside} {...view} onContacted={(text) => run(async () => {
            try { await navigator.clipboard.writeText(text); } catch { throw new Error(t("copyFailed")); }
            await decide(entry.key, { option: "chased" });
            return t("invoiceCopied");
          })} />
          : draft?.type === "purchase_orders_from_request" ? <ConversionBody draft={draft} row={row} busy={busy} canDecide={canDecide} aside={aside} {...view} onCreate={() => run(async () => {
            const result = await apiJson<any>(`/api/procurement/requests/${encodeURIComponent(draft.purchaseRequestId)}/generate-purchase-orders`, {
              method: "POST",
              body: JSON.stringify({ expectedVersion: draft.version, idempotencyKey: `today-decision:${entry.key}:v${draft.version}` }),
            });
            const orders: any[] = result?.createdPurchaseOrders || result?.result?.createdPurchaseOrders || [];
            const ids = orders.map((order) => String(order.id || "")).filter(Boolean);
            // The orders exist now; recording the decision is secondary, so a
            // failure there does not hide them.
            if (ids.length) await decide(entry.key, { option: "accepted", documentType: "purchase_order", documentIds: ids }).catch(() => null);
            return t("created", { numbers: orders.map((order) => order.orderNumber || order.number || order.id).join(", ") });
          })} />
            : <GenericBody aside={aside} {...view} />}
      </div>
      {open && mode === "not_now" ? <NotNowForm today={today} busy={busy} onCancel={() => setMode(null)} onSave={(returnOn) => run(async () => { await decide(entry.key, { option: "not_now", returnOn }); setMode(null); })} /> : null}
      {open && mode === "not_needed" ? <NotNeededForm busy={busy} onCancel={() => setMode(null)} onSave={(reasonCode, note) => run(async () => { await decide(entry.key, { option: "not_needed", reasonCode, note }); setMode(null); })} /> : null}
      {message ? <p className="mt-2 text-xs" style={{ color: A.sub }} role="status">{message}</p> : null}
    </li>
  );
}

// Whether a card is open, its Details button, and a way to open it (a main
// button that needs the details, Review and send, opens them first).
type View = { open: boolean; toggle: ReactNode; onOpen: () => void };
// On the card's one line: the fact that decides it, then its main button and
// Details on the right. Open, Details stays on the line and the rest drops below.
function Short({ children }: { children: ReactNode }) {
  return <span className="min-w-0 truncate text-xs" style={{ color: A.sub }}>· {children}</span>;
}
function LineEnd({ children }: { children: ReactNode }) {
  return <div className="ml-auto flex shrink-0 flex-wrap items-center gap-2">{children}</div>;
}
function Below({ children }: { children: ReactNode }) {
  return <div className="w-full">{children}</div>;
}
function GenericBody({ aside, open, toggle }: View & { aside: ReactNode }) {
  if (!aside) return null;
  if (!open) return <LineEnd>{toggle}</LineEnd>;
  return <><LineEnd>{toggle}</LineEnd><Below><Actions aside={aside} /></Below></>;
}

function Prepared({ children }: { children: ReactNode }) {
  const t = useDecisionCopy();
  return <div className="mt-1 text-sm"><span className="mr-1.5 text-xs font-medium text-blue-700">{t("prepared")}</span>{children}</div>;
}
function Basis({ children }: { children: ReactNode }) {
  const t = useDecisionCopy();
  return <div className="mt-1 text-xs" style={{ color: A.sub }}><span className="mr-1.5 font-medium">{t("basis")}</span>{children}</div>;
}
// One row of actions: what the card prepared first, then "Not now" and
// "Not needed" on the right.
function Actions({ children, aside }: { children?: ReactNode; aside: ReactNode }) {
  if (!children && !aside) return null;
  return (
    <div className="mt-3 flex flex-wrap items-center gap-2">
      {children}
      {aside ? <div className="flex gap-2 sm:ml-auto">{aside}</div> : null}
    </div>
  );
}

function ReorderBody({ draft, row, day, busy, canDecide, aside, open, toggle }: View & { draft: ReorderDraft; row: TodayRow; day: (value: string) => string; busy: boolean; canDecide: boolean; aside: ReactNode }) {
  const t = useDecisionCopy();
  const qty = (value: number | null) => (value === null ? "—" : `${formatQuantity(value)}${draft.unit ? ` ${unitLabel(draft.unit, t.language, value)}` : ""}`);
  const supplier = draft.supplier?.name || "";
  const prepared = draft.quantity === null
    ? (supplier ? t("reorderDraftNoQuantity", { supplier }) : t("reorderDraftNoSupplier", { qty: "—" }))
    : supplier ? t("reorderDraft", { qty: qty(draft.quantity), supplier }) : t("reorderDraftNoSupplier", { qty: qty(draft.quantity) });
  // The request form, prefilled as the reorder list prefills it
  // (shared/purchase-request-prefill.mjs); the person checks it and clicks Create.
  const params = new URLSearchParams({
    itemId: draft.itemId,
    origin: "reorder_list",
    reason: t("reorderReason", { position: qty(draft.position), reorderPoint: qty(draft.reorderPoint), date: draft.orderByDate ? day(draft.orderByDate) : "—" }),
  });
  if (draft.quantity !== null) params.set("quantity", String(draft.quantity));
  if (draft.supplier?.id) params.set("suppliers", draft.supplier.id);
  const primary = canDecide ? <Link to={`/app/procurement/requests?${params.toString()}`} aria-disabled={busy} className={BUTTON.primary} data-testid="decision-primary">{t("reviewRequest")}</Link> : null;
  if (!open) return <><Short>{draft.quantity === null ? t("reorderShortNoQuantity") : t("reorderShort", { qty: qty(draft.quantity) })}</Short><LineEnd>{primary}{toggle}</LineEnd></>;
  return (
    <>
      <LineEnd>{toggle}</LineEnd>
      <Below>
        <Prepared>{prepared}{draft.raisedToMinimum && draft.supplier?.minimumOrderQuantity ? <span className="text-xs" style={{ color: A.sub }}> {t("raisedToMinimum", { shortfall: qty(draft.shortfall), minimum: qty(draft.supplier.minimumOrderQuantity) })}</span> : null}</Prepared>
        <Basis>{t("reorderBasis", { position: qty(draft.position), reorderPoint: qty(draft.reorderPoint) })}{row.actionHref ? <> <Link to={row.actionHref} className={LINK}>↗</Link></> : null}</Basis>
        <Actions aside={aside}>{primary}</Actions>
      </Below>
    </>
  );
}

function FollowUpBody({ draft, row, day, busy, canDecide, aside, email, onChased, onSend, open, toggle, onOpen }: View & { draft: FollowUpDraft; row: TodayRow; day: (value: string) => string; busy: boolean; canDecide: boolean; aside: ReactNode; email: SupplierEmail | null; onChased: (text: string) => void; onSend: (mail: { to: string; subject: string; body: string }) => void }) {
  const t = useDecisionCopy();
  const { language } = useI18n();
  const [mailLanguage, setMailLanguage] = useState<"en-US" | "zh-CN">(language === "zh-CN" ? "zh-CN" : "en-US");
  const generated = useMemo(() => followUpMessage(mailLanguage, {
    orderNumber: draft.orderNumber,
    contactName: draft.supplier.contactName,
    due: draft.dueDate ? day(draft.dueDate) : null,
    overdueDays: draft.overdueDays,
    lines: draft.lines.map((line) => ({
      sku: line.sku || "—",
      quantity: line.remaining === null ? "—" : `${formatQuantity(line.remaining)}${line.unit ? ` ${unitLabel(line.unit, mailLanguage, line.remaining)}` : ""}`,
      promised: line.promisedDate ? day(line.promisedDate) : null,
    })),
    moreLines: draft.moreLines,
  }), [draft, mailLanguage, day]);
  const [edited, setEdited] = useState<{ language: string; text: string } | null>(null);
  const text = edited && edited.language === mailLanguage ? edited.text : `${generated.subject}\n\n${generated.body}`;
  const [showMessage, setShowMessage] = useState(false);
  // Sending takes two confirmations (DD-9): the text, then the address.
  const [step, setStep] = useState<"text" | "address" | null>(null);
  const [to, setTo] = useState(draft.supplier.email || "");
  const [subjectLine, ...bodyLines] = text.split("\n");
  const mail = { to: to.trim(), subject: subjectLine.trim(), body: bodyLines.join("\n").trim() };
  const addressOk = /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]+$/.test(mail.to);
  const who = [draft.supplier.contactName, draft.supplier.email ? `<${draft.supplier.email}>` : null].filter(Boolean).join(" ");
  const qty = (value: number | null, unit: string | null) => (value === null ? "—" : `${formatQuantity(value)}${unit ? ` ${unitLabel(unit, t.language, value)}` : ""}`);
  const first = draft.lines[0];
  const linesLeft = draft.lines.length + draft.moreLines;
  if (!open) {
    const short = linesLeft === 1 && first ? t("followUpShortOne", { sku: first.sku || "—", qty: qty(first.remaining, first.unit) }) : t("followUpShort", { n: linesLeft });
    // Review and send needs the message, so it opens the card first.
    const primary = !canDecide ? null : email
      ? <button type="button" disabled={busy} className={BUTTON.primary} onClick={() => { onOpen(); setShowMessage(true); setStep("text"); }} data-testid="decision-primary">{t("reviewAndSend")}</button>
      : <button type="button" disabled={busy} className={BUTTON.primary} onClick={() => onChased(text)} data-testid="decision-primary">{t("copyAndChased")}</button>;
    return <><Short>{short}</Short><LineEnd>{primary}{toggle}</LineEnd></>;
  }
  return (
    <>
      <LineEnd>{toggle}</LineEnd>
      <Below>
      <Prepared>{t("followUpDraft", { supplier: draft.supplier.name || row.name || "—" })}</Prepared>
      <Basis>
        {linesLeft === 1 && first
          ? t("followUpBasisOne", { sku: first.sku || "—", qty: qty(first.remaining, first.unit), date: draft.dueDate ? day(draft.dueDate) : "—" })
          : t("followUpBasis", { n: linesLeft, date: draft.dueDate ? day(draft.dueDate) : "—" })}
      </Basis>
      <div className="mt-1 text-xs" style={{ color: A.sub }}>{who ? t("followUpTo", { who }) : t("followUpNoEmail")}</div>
      <button type="button" className="mt-2 flex items-center gap-1 text-xs font-medium text-blue-600" aria-expanded={showMessage} onClick={() => setShowMessage((value) => !value)} data-testid="decision-follow-up-toggle">
        {showMessage ? <ChevronDown size={14} aria-hidden /> : <ChevronRight size={14} aria-hidden />}
        {showMessage ? t("hideMessage") : t("showMessage")}
      </button>
      {showMessage ? (
        <>
          <div className="mt-2 flex items-center gap-2 text-xs" style={{ color: A.sub }}>
            <span>{t("followUpLanguage")}</span>
            {(["en-US", "zh-CN"] as const).map((code) => (
              <button key={code} type="button" aria-pressed={mailLanguage === code} onClick={() => setMailLanguage(code)} className={mailLanguage === code ? rowActionClass.primary : rowActionClass.neutral}>{code === "en-US" ? "English" : "中文"}</button>
            ))}
          </div>
          <textarea
            className="mt-2 w-full rounded-md border p-2 font-mono text-xs leading-5"
            style={{ borderColor: A.gray4 }}
            rows={Math.min(14, text.split("\n").length + 1)}
            value={text}
            onChange={(event) => setEdited({ language: mailLanguage, text: event.target.value })}
            data-testid="decision-follow-up-text"
          />
          <p className="mt-1 text-[11px]" style={{ color: A.sub }}>{email ? t("followUpSendNote") : t("followUpNotSent")}</p>
        </>
      ) : null}
      {email && step === "text" ? (
        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs" data-testid="decision-send-text">
          <span style={{ color: A.sub }}>{t("confirmText")}</span>
          <button type="button" className={BUTTON.primary} disabled={!mail.subject || !mail.body} onClick={() => setStep("address")} data-testid="decision-send-next">{t("nextRecipient")}</button>
          <button type="button" className={BUTTON.secondary} onClick={() => setStep(null)}>{t("cancel")}</button>
        </div>
      ) : null}
      {email && step === "address" ? (
        <div className="mt-2 space-y-2 rounded-md bg-slate-50 p-3 text-xs" data-testid="decision-send-address">
          <label className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{t("toLabel")}</span>
            <input type="email" className="min-w-64 flex-1 rounded border px-2 py-1" value={to} onChange={(event) => setTo(event.target.value)} data-testid="decision-send-to" />
          </label>
          <p style={{ color: A.sub }}>{t("replyToYou")}{email.outbox ? " " + t("outboxNote") : ""}</p>
          <div className="flex flex-wrap gap-2">
            <button type="button" className={BUTTON.primary} disabled={busy || !addressOk} onClick={() => onSend(mail)} data-testid="decision-send-confirm">{t("sendTo", { to: mail.to || "—" })}</button>
            <button type="button" className={BUTTON.secondary} onClick={() => setStep("text")}>{t("back")}</button>
          </div>
        </div>
      ) : null}
      <Actions aside={aside}>
        {canDecide ? (
          <>
            {email ? <button type="button" disabled={busy || step !== null} className={BUTTON.primary} onClick={() => { setShowMessage(true); setStep("text"); }} data-testid="decision-primary">{t("reviewAndSend")}</button> : null}
            <button type="button" disabled={busy} className={email ? BUTTON.secondary : BUTTON.primary} onClick={() => onChased(text)} data-testid={email ? "decision-copy" : "decision-primary"}>{t("copyAndChased")}</button>
            <Link to={row.href} className={BUTTON.secondary}>{t("recordNewDate")}</Link>
          </>
        ) : null}
      </Actions>
      </Below>
    </>
  );
}

// A held supplier invoice: on the line, its first difference and the step's
// button; under Details, each difference with its likely cause, the message
// to the supplier (copy it, then it is marked contacted), and the invoice.
function InvoiceExceptionBody({ draft, row, busy, canDecide, aside, onContacted, open, toggle }: View & { draft: InvoiceExceptionDraft; row: TodayRow; busy: boolean; canDecide: boolean; aside: ReactNode; onContacted: (text: string) => void }) {
  const t = useDecisionCopy();
  const { language, locale } = useI18n();
  const [mailLanguage, setMailLanguage] = useState<"en-US" | "zh-CN">(language === "zh-CN" ? "zh-CN" : "en-US");
  const [showMessage, setShowMessage] = useState(false);
  const [edited, setEdited] = useState<{ language: string; text: string } | null>(null);
  const money = (value: number | null | undefined) => (value === null || value === undefined ? "—" : formatLocaleAmount(value, draft.currency, locale, { maximumFractionDigits: 4 }));
  const qty = (value: number | null | undefined, unit: string | null, lang: string = t.language) => (value === null || value === undefined ? "—" : `${formatQuantity(value)}${unit ? ` ${unitLabel(unit, lang, value)}` : ""}`);
  const generated = useMemo(() => invoiceCorrectionMessage(mailLanguage, {
    invoiceNumber: draft.invoiceNumber,
    orderNumber: draft.orderNumber,
    contactName: draft.supplier.contactName,
    differences: draft.differences.map((entry) => ({
      kind: entry.kind,
      sku: entry.sku || "—",
      expected: entry.kind === "quantity" ? qty(entry.expected, entry.unit, mailLanguage) : money(entry.expected),
      actual: entry.kind === "quantity" ? qty(entry.invoiced ?? entry.actual, entry.unit, mailLanguage) : money(entry.actual),
      received: qty(entry.received, entry.unit, mailLanguage),
      previouslyInvoiced: entry.previouslyInvoiced ? qty(entry.previouslyInvoiced, entry.unit, mailLanguage) : null,
    })),
    moreDifferences: draft.moreDifferences,
  }), [draft, mailLanguage, locale]);
  const text = edited && edited.language === mailLanguage ? edited.text : `${generated.subject}\n\n${generated.body}`;
  // The first difference, in figures, for the card's one line.
  const first = draft.differences[0];
  const shortOf = (entry: InvoiceDifference) => entry.kind === "price"
    ? (entry.actual === null ? t("invoiceShortPriceHidden", { sku: entry.sku || "—" }) : t("invoiceShortPrice", { sku: entry.sku || "—", invoice: money(entry.actual), order: money(entry.expected), percent: entry.percent === null || entry.percent === undefined ? "" : ` (${entry.percent > 0 ? "+" : ""}${entry.percent}%)` }))
    : entry.kind === "quantity"
      ? t("invoiceShortQuantity", { sku: entry.sku || "—", invoiced: qty(entry.invoiced, entry.unit), received: qty(entry.received, entry.unit) })
      : t("invoiceShortAmount", { sku: entry.sku || "—", variance: money(entry.variance) });
  const extra = draft.differences.length - 1 + draft.moreDifferences;
  const short = first ? `${shortOf(first)}${extra > 0 ? t("invoiceShortMore", { n: extra }) : ""}` : "";
  const causeOf = (entry: InvoiceDifference) => {
    switch (entry.cause) {
      case "price_changed": return t("cause_price_changed", { order: entry.evidenceOrder || "—", price: money(entry.actual) });
      case "invoice_price": return t("cause_invoice_price");
      case "over_ordered": return t("cause_over_ordered", { ordered: qty(entry.ordered, entry.unit) });
      case "already_invoiced": return t("cause_already_invoiced", { previous: qty(entry.previouslyInvoiced, entry.unit) });
      case "not_yet_received": return t("cause_not_yet_received", { missing: qty(entry.missing, entry.unit) });
      case "line_amount": return t("cause_line_amount");
      default: return t("cause_hidden");
    }
  };
  const invoiceLeads = draft.step === "review_price" || (draft.step === "wait_receipt" && !draft.orderId);
  const openInvoice = <Link to={row.href} className={invoiceLeads ? BUTTON.primary : BUTTON.secondary} data-testid={invoiceLeads ? "decision-primary" : undefined}>{t("openInvoice")}</Link>;
  const openOrder = draft.orderId ? <Link to={`/app/procurement/orders/${encodeURIComponent(draft.orderId)}`} className={draft.step === "wait_receipt" ? BUTTON.primary : BUTTON.secondary} data-testid={draft.step === "wait_receipt" ? "decision-primary" : undefined}>{t("checkReceipt")}</Link> : null;
  const contact = <button type="button" disabled={busy} className={draft.step === "ask_supplier" ? BUTTON.primary : BUTTON.secondary} onClick={() => onContacted(text)} data-testid={draft.step === "ask_supplier" ? "decision-primary" : "decision-copy"}>{t("copyAndContacted")}</button>;
  const primary = !canDecide ? null : draft.step === "review_price" ? openInvoice : draft.step === "wait_receipt" ? openOrder || openInvoice : contact;
  if (!open) return <><Short>{short}</Short><LineEnd>{primary}{toggle}</LineEnd></>;
  return (
    <>
      <LineEnd>{toggle}</LineEnd>
      <Below>
        <Prepared>{t(`invoiceStep_${draft.step}` as DecisionCopyKey)}</Prepared>
        <ul className="mt-1 space-y-1 text-xs" data-testid="decision-invoice-differences">
          {draft.differences.map((entry) => (
            <li key={entry.exceptionId} data-cause={entry.cause || ""}>
              <span style={{ color: A.label }}>{shortOf(entry)}</span>
              <span style={{ color: A.sub }}> · {causeOf(entry)}</span>
            </li>
          ))}
          {draft.moreDifferences ? <li style={{ color: A.sub }}>{t("invoiceShortMore", { n: draft.moreDifferences })}</li> : null}
        </ul>
        <div className="mt-1 text-xs" style={{ color: A.sub }}>{draft.orderNumber ? t("invoiceForOrder", { invoice: draft.invoiceNumber, order: draft.orderNumber }) : draft.invoiceNumber}</div>
        <button type="button" className="mt-2 flex items-center gap-1 text-xs font-medium text-blue-600" aria-expanded={showMessage} onClick={() => setShowMessage((value) => !value)} data-testid="decision-invoice-message-toggle">
          {showMessage ? <ChevronDown size={14} aria-hidden /> : <ChevronRight size={14} aria-hidden />}
          {showMessage ? t("hideMessage") : t("showInvoiceMessage")}
        </button>
        {showMessage ? (
          <>
            <div className="mt-2 flex items-center gap-2 text-xs" style={{ color: A.sub }}>
              <span>{t("followUpLanguage")}</span>
              {(["en-US", "zh-CN"] as const).map((code) => (
                <button key={code} type="button" aria-pressed={mailLanguage === code} onClick={() => setMailLanguage(code)} className={mailLanguage === code ? rowActionClass.primary : rowActionClass.neutral}>{code === "en-US" ? "English" : "中文"}</button>
              ))}
            </div>
            <textarea className="mt-2 w-full rounded-md border p-2 font-mono text-xs leading-5" style={{ borderColor: A.gray4 }} rows={Math.min(14, text.split("\n").length + 1)} value={text} onChange={(event) => setEdited({ language: mailLanguage, text: event.target.value })} data-testid="decision-invoice-message" />
            <p className="mt-1 text-[11px]" style={{ color: A.sub }}>{t("followUpNotSent")}</p>
          </>
        ) : null}
        <Actions aside={aside}>
          {!canDecide ? openInvoice
            : draft.step === "ask_supplier" ? <>{contact}{openInvoice}</>
              : draft.step === "review_price" ? <>{openInvoice}{contact}</>
                : openOrder ? <>{openOrder}{contact}{openInvoice}</> : <>{openInvoice}{contact}</>}
        </Actions>
      </Below>
    </>
  );
}

function ConversionBody({ draft, row, busy, canDecide, aside, onCreate, open, toggle }: View & { draft: ConversionDraft; row: TodayRow; busy: boolean; canDecide: boolean; aside: ReactNode; onCreate: () => void }) {
  const t = useDecisionCopy();
  const fields = (codes: string[]) => codes.map((code) => t(`field_${code}` as DecisionCopyKey)).join(t.language === "zh-CN" ? "、" : ", ");
  const ready = canDecide && draft.missing.length === 0 && draft.orders.length > 0;
  const create = ready ? <button type="button" disabled={busy} className={BUTTON.primary} onClick={onCreate} data-testid="decision-primary">{busy ? t("creating") : t("createOrders")}</button> : null;
  const openRequest = <Link to={row.href} className={BUTTON.secondary}>{t("openRequest")}</Link>;
  if (!open) return <><Short>{t.count("convertDraft", draft.orders.length)}</Short><LineEnd>{create || openRequest}{toggle}</LineEnd></>;
  return (
    <>
      <LineEnd>{toggle}</LineEnd>
      <Below>
        <Prepared>{t.count("convertDraft", draft.orders.length)}</Prepared>
        <ul className="mt-1 list-disc pl-5 text-xs" style={{ color: A.sub }}>
          {draft.orders.map((order) => <li key={`${order.supplierId}:${order.currency}:${order.warehouseId}`}>{t.count("convertOrder", order.lines, { supplier: order.supplierName, currency: order.currency })}</li>)}
        </ul>
        {draft.missing.map((line) => <p key={line.line} className="mt-1 text-xs text-amber-700">{t("convertMissing", { line: line.line, sku: line.sku || "—", fields: fields(line.fields) })}</p>)}
        <Actions aside={aside}>
          {create}
          {openRequest}
        </Actions>
      </Below>
    </>
  );
}

function NotNowForm({ today, busy, onSave, onCancel }: { today: string; busy: boolean; onSave: (day: string) => void; onCancel: () => void }) {
  const t = useDecisionCopy();
  const [picked, setPicked] = useState("");
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2 rounded-md bg-slate-50 p-2 text-xs" data-testid="decision-not-now-form">
      <button type="button" disabled={busy} className={BUTTON.secondary} onClick={() => onSave(addDays(today, 1))}>{t("tomorrow")}</button>
      <button type="button" disabled={busy} className={BUTTON.secondary} onClick={() => onSave(nextMonday(today))}>{t("nextMonday")}</button>
      <label className="flex items-center gap-1">
        <span>{t("pickDay")}</span>
        <input type="date" className="rounded border px-1 py-0.5" min={addDays(today, 1)} max={addDays(today, 90)} value={picked} onChange={(event) => setPicked(event.target.value)} />
      </label>
      <button type="button" disabled={busy || !picked} className={BUTTON.primary} onClick={() => onSave(picked)}>{t("save")}</button>
      <button type="button" className={BUTTON.secondary} onClick={onCancel}>{t("cancel")}</button>
    </div>
  );
}

function NotNeededForm({ busy, onSave, onCancel }: { busy: boolean; onSave: (reason: string, note: string) => void; onCancel: () => void }) {
  const t = useDecisionCopy();
  const [reason, setReason] = useState<string>("seasonal");
  const [note, setNote] = useState("");
  const ready = reason !== "other" || note.trim().length >= 3;
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2 rounded-md bg-slate-50 p-2 text-xs" data-testid="decision-not-needed-form">
      <label className="flex items-center gap-1">
        <span>{t("reason")}</span>
        <select className="rounded border px-1 py-0.5" value={reason} onChange={(event) => setReason(event.target.value)}>
          {REASONS.map((code) => <option key={code} value={code}>{t(`reason_${code}` as DecisionCopyKey)}</option>)}
        </select>
      </label>
      <input className="min-w-48 flex-1 rounded border px-2 py-0.5" maxLength={200} placeholder={t("notePlaceholder")} value={note} onChange={(event) => setNote(event.target.value)} />
      <button type="button" disabled={busy || !ready} className={BUTTON.primary} onClick={() => onSave(reason, note.trim())}>{t("save")}</button>
      <button type="button" className={BUTTON.secondary} onClick={onCancel}>{t("cancel")}</button>
    </div>
  );
}

// How a set-aside item was settled, in words: "Not now, until Nov 13, 2026",
// "Emailed on Nov 12, 2026", "Created PO-202611-0003".
function useAsideStatus(entries: SetAsideEntry[], day: (value: string) => string) {
  const t = useDecisionCopy();
  const numberOf = useDocumentNumbers(entries.flatMap((entry) => entry.documentIds.map((id) => [entry.documentType, id] as const)));
  const documents = (entry: SetAsideEntry) => entry.documentNumber || entry.documentIds.map((id) => numberOf(entry.documentType, id) || id).join(", ") || "—";
  return (entry: SetAsideEntry) => {
    switch (entry.decision) {
      case "not_now": return t("aside_not_now", { date: entry.returnOn ? day(entry.returnOn) : "—" });
      case "not_needed": return t("aside_not_needed", { reason: entry.reasonCode ? t(`reason_${entry.reasonCode}` as DecisionCopyKey) : "—" }) + (entry.note ? ` (${entry.note})` : "");
      case "chased": return t(entry.row.kind === "bill_exception" ? "aside_contacted" : entry.note === "email" ? "aside_emailed" : "aside_chased", { date: entry.decidedOn ? day(entry.decidedOn) : "—" });
      case "accepted": return t("aside_accepted", { document: documents(entry) });
      default: return t("aside_covered", { document: documents(entry) });
    }
  };
}

function SetAsideList({ entries, canDecide, day, kindLabel, labelOf, onChanged }: Shared & { entries: SetAsideEntry[] }) {
  const t = useDecisionCopy();
  const [open, setOpen] = useState(false);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const status = useAsideStatus(entries, day);
  const reopen = async (key: string) => {
    setBusyKey(key);
    setMessage(null);
    try {
      await apiJson("/api/decision-items/reopen", { method: "POST", body: JSON.stringify({ key }) });
      onChanged();
    } catch (error) {
      setMessage(t("failed", { message: error instanceof Error ? error.message : String(error) }));
    } finally {
      setBusyKey(null);
    }
  };
  return (
    <div className="mt-4 border-t pt-3" data-testid="today-set-aside">
      <button type="button" className="flex items-center gap-1 text-xs font-medium" style={{ color: A.gray1 }} aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        {open ? <ChevronDown size={14} aria-hidden /> : <ChevronRight size={14} aria-hidden />}
        {t("setAsideTitle", { n: entries.length })}
      </button>
      {open ? (
        <>
          <p className="mt-1 text-[11px]" style={{ color: A.sub }}>{t("setAsideNote")}</p>
          <ul className="mt-2 divide-y" data-testid="today-set-aside-list">
            {entries.map((entry) => (
              <li key={entry.key} className="flex flex-wrap items-center gap-2 py-2 text-xs" data-testid="today-set-aside-item" data-decision={entry.decision}>
                <span className="font-medium">{kindLabel(entry.row)}</span>
                <Link to={entry.row.href} className={LINK}>{labelOf(entry.row)}</Link>
                <span style={{ color: A.sub }}>{status(entry)}</span>
                {entry.decidedBy ? <span style={{ color: A.gray2 }}>{t("by", { name: entry.decidedBy.name, date: entry.decidedOn ? day(entry.decidedOn) : "" })}</span> : null}
                {canDecide ? <button type="button" disabled={busyKey === entry.key} className={`${BUTTON.secondary} ml-auto`} onClick={() => reopen(entry.key)}>{t("reopen")}</button> : null}
              </li>
            ))}
          </ul>
          {message ? <p className="mt-1 text-xs" style={{ color: A.sub }} role="status">{message}</p> : null}
        </>
      ) : null}
    </div>
  );
}
