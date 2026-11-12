import { useMemo, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { ChevronDown, ChevronRight, Sparkles } from "lucide-react";
import { A, Card } from "../../components/ui";
import { rowActionClass } from "../../components/ui/listLayout";
import { useI18n } from "../../i18n/I18n";
import { unitLabel } from "../../i18n/unitLabels";
import { ApiError, apiJson } from "../../lib/api-client";
import { useDocumentNumbers } from "../../lib/documentNumbers";
import { formatQuantity } from "../../lib/format";
import { followUpMessage, useDecisionCopy, type DecisionCopyKey } from "./decisionCopy";

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
type Draft = ReorderDraft | FollowUpDraft | ConversionDraft;
export type WaitingEntry = { key: string; row: TodayRow; raisedAt: string | null; returned: boolean; draft: Draft | null };
export type SetAsideEntry = {
  key: string; row: TodayRow; decision: "not_now" | "not_needed" | "chased" | "accepted" | "covered"; reasonCode: string | null; note: string | null;
  returnOn: string | null; decidedAt: string | null; decidedOn: string | null; decidedBy: { name: string } | null;
  documentType: string | null; documentIds: string[]; documentNumber: string | null;
};
export type TodayDecisions = { available: boolean; canDecide?: boolean; waiting?: WaitingEntry[]; setAside?: SetAsideEntry[] };

const REASONS = ["seasonal", "discontinued", "covered_elsewhere", "supplier_confirmed", "other"] as const;
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

export function DecisionSection({ decisions, overdueOnly, ...rest }: Omit<Shared, "canDecide"> & { decisions: TodayDecisions; overdueOnly: boolean }) {
  const t = useDecisionCopy();
  const shared: Shared = { ...rest, canDecide: decisions.canDecide === true };
  const waiting = (decisions.waiting || []).filter((entry) => !overdueOnly || entry.row.overdueDays > 0);
  const setAside = decisions.setAside || [];
  return (
    <Card className="p-5" data-testid="today-decisions">
      <div className="flex items-start gap-2">
        <Sparkles size={16} className="mt-0.5 shrink-0" style={{ color: "#2563eb" }} aria-hidden />
        <div>
          <h2 className="text-sm font-semibold">{t("title")}</h2>
          <p className="mt-0.5 text-xs" style={{ color: A.sub }}>{shared.canDecide ? t("note") : t("readOnly")}</p>
        </div>
      </div>
      {waiting.length === 0 ? (
        <p className="py-6 text-center text-sm" style={{ color: A.sub }} data-testid="today-decisions-empty">{t("none")}</p>
      ) : (
        <ul className="mt-3 space-y-3" data-testid="today-decision-list">
          {waiting.map((entry) => <DecisionCard key={entry.key} entry={entry} {...shared} />)}
        </ul>
      )}
      {setAside.length ? <SetAsideList entries={setAside} {...shared} /> : null}
    </Card>
  );
}

function DecisionCard({ entry, canDecide, today, day, dateText, tone, kindLabel, labelOf, onChanged }: Shared & { entry: WaitingEntry }) {
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

  return (
    <li className="rounded-lg border p-4" style={{ borderColor: A.gray4 }} data-testid="today-decision" data-kind={row.kind} data-key={entry.key}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="inline-block rounded px-2 py-0.5 text-xs font-medium" style={tone(row)}>{dateText(row)}</span>
        <span className="text-sm font-medium">{kindLabel(row)}</span>
        <Link to={row.href} className={`text-xs ${LINK}`}>{labelOf(row)}</Link>
        {row.name ? <span className="text-xs" style={{ color: A.sub }}>{row.name}</span> : null}
        {entry.returned ? <span className="rounded bg-amber-50 px-1.5 py-0.5 text-[11px] font-medium text-amber-700">{t("returned")}</span> : null}
      </div>
      {draft?.type === "purchase_request" ? <ReorderBody draft={draft} row={row} day={day} busy={busy} canDecide={canDecide} />
        : draft?.type === "supplier_follow_up" ? <FollowUpBody draft={draft} row={row} day={day} busy={busy} canDecide={canDecide} onChased={(text) => run(async () => {
          try { await navigator.clipboard.writeText(text); } catch { throw new Error(t("copyFailed")); }
          await decide(entry.key, { option: "chased" });
          return t("copied");
        })} />
          : draft?.type === "purchase_orders_from_request" ? <ConversionBody draft={draft} row={row} busy={busy} canDecide={canDecide} onCreate={() => run(async () => {
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
            : null}
      {canDecide ? (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button type="button" disabled={busy} className={rowActionClass.neutral} aria-expanded={mode === "not_now"} onClick={() => setMode(mode === "not_now" ? null : "not_now")} data-testid="decision-not-now">{t("notNow")}</button>
          <button type="button" disabled={busy} className={rowActionClass.neutral} aria-expanded={mode === "not_needed"} onClick={() => setMode(mode === "not_needed" ? null : "not_needed")} data-testid="decision-not-needed">{t("notNeeded")}</button>
        </div>
      ) : null}
      {mode === "not_now" ? <NotNowForm today={today} busy={busy} onCancel={() => setMode(null)} onSave={(returnOn) => run(async () => { await decide(entry.key, { option: "not_now", returnOn }); setMode(null); })} /> : null}
      {mode === "not_needed" ? <NotNeededForm busy={busy} onCancel={() => setMode(null)} onSave={(reasonCode, note) => run(async () => { await decide(entry.key, { option: "not_needed", reasonCode, note }); setMode(null); })} /> : null}
      {message ? <p className="mt-2 text-xs" style={{ color: A.sub }} role="status">{message}</p> : null}
    </li>
  );
}

function Prepared({ children }: { children: ReactNode }) {
  const t = useDecisionCopy();
  return <div className="mt-2 text-sm"><span className="mr-1 text-xs font-medium uppercase tracking-wide text-blue-700">{t("prepared")}</span>{children}</div>;
}
function Basis({ children }: { children: ReactNode }) {
  const t = useDecisionCopy();
  return <div className="mt-1 text-xs" style={{ color: A.sub }}><span className="mr-1 font-medium">{t("basis")}</span>{children}</div>;
}

function ReorderBody({ draft, row, day, busy, canDecide }: { draft: ReorderDraft; row: TodayRow; day: (value: string) => string; busy: boolean; canDecide: boolean }) {
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
  return (
    <>
      <Prepared>{prepared}{draft.raisedToMinimum && draft.supplier?.minimumOrderQuantity ? <span className="text-xs" style={{ color: A.sub }}> {t("raisedToMinimum", { shortfall: qty(draft.shortfall), minimum: qty(draft.supplier.minimumOrderQuantity) })}</span> : null}</Prepared>
      <Basis>{t("reorderBasis", { position: qty(draft.position), reorderPoint: qty(draft.reorderPoint) })}{row.actionHref ? <> <Link to={row.actionHref} className={LINK}>↗</Link></> : null}</Basis>
      {canDecide ? (
        <div className="mt-3">
          <Link to={`/app/procurement/requests?${params.toString()}`} aria-disabled={busy} className={`${rowActionClass.primary} inline-block !no-underline`} data-testid="decision-primary">{t("reviewRequest")}</Link>
        </div>
      ) : null}
    </>
  );
}

function FollowUpBody({ draft, row, day, busy, canDecide, onChased }: { draft: FollowUpDraft; row: TodayRow; day: (value: string) => string; busy: boolean; canDecide: boolean; onChased: (text: string) => void }) {
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
  const who = [draft.supplier.contactName, draft.supplier.email ? `<${draft.supplier.email}>` : null].filter(Boolean).join(" ");
  return (
    <>
      <Prepared>{t("followUpDraft", { supplier: draft.supplier.name || row.name || "—" })}</Prepared>
      <Basis>{who ? t("followUpTo", { who }) : t("followUpNoEmail")}</Basis>
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
      <p className="mt-1 text-[11px]" style={{ color: A.sub }}>{t("followUpNotSent")}</p>
      {canDecide ? (
        <div className="mt-2 flex flex-wrap gap-2">
          <button type="button" disabled={busy} className={rowActionClass.primary} onClick={() => onChased(text)} data-testid="decision-primary">{t("copyAndChased")}</button>
          <Link to={row.href} className={`${rowActionClass.neutral} inline-block !no-underline`}>{t("recordNewDate")}</Link>
        </div>
      ) : null}
    </>
  );
}

function ConversionBody({ draft, row, busy, canDecide, onCreate }: { draft: ConversionDraft; row: TodayRow; busy: boolean; canDecide: boolean; onCreate: () => void }) {
  const t = useDecisionCopy();
  const fields = (codes: string[]) => codes.map((code) => t(`field_${code}` as DecisionCopyKey)).join(t.language === "zh-CN" ? "、" : ", ");
  return (
    <>
      <Prepared>{t.count("convertDraft", draft.orders.length)}</Prepared>
      <ul className="mt-1 list-disc pl-5 text-xs" style={{ color: A.sub }}>
        {draft.orders.map((order) => <li key={`${order.supplierId}:${order.currency}:${order.warehouseId}`}>{t.count("convertOrder", order.lines, { supplier: order.supplierName, currency: order.currency })}</li>)}
      </ul>
      {draft.missing.map((line) => <p key={line.line} className="mt-1 text-xs text-amber-700">{t("convertMissing", { line: line.line, sku: line.sku || "—", fields: fields(line.fields) })}</p>)}
      <div className="mt-3 flex flex-wrap gap-2">
        {canDecide && draft.missing.length === 0 && draft.orders.length > 0 ? (
          <button type="button" disabled={busy} className={rowActionClass.primary} onClick={onCreate} data-testid="decision-primary">{busy ? t("creating") : t("createOrders")}</button>
        ) : null}
        <Link to={row.href} className={`${rowActionClass.neutral} inline-block !no-underline`}>{t("openRequest")}</Link>
      </div>
    </>
  );
}

function NotNowForm({ today, busy, onSave, onCancel }: { today: string; busy: boolean; onSave: (day: string) => void; onCancel: () => void }) {
  const t = useDecisionCopy();
  const [picked, setPicked] = useState("");
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2 rounded-md bg-slate-50 p-2 text-xs" data-testid="decision-not-now-form">
      <button type="button" disabled={busy} className={rowActionClass.neutral} onClick={() => onSave(addDays(today, 1))}>{t("tomorrow")}</button>
      <button type="button" disabled={busy} className={rowActionClass.neutral} onClick={() => onSave(nextMonday(today))}>{t("nextMonday")}</button>
      <label className="flex items-center gap-1">
        <span>{t("pickDay")}</span>
        <input type="date" className="rounded border px-1 py-0.5" min={addDays(today, 1)} max={addDays(today, 90)} value={picked} onChange={(event) => setPicked(event.target.value)} />
      </label>
      <button type="button" disabled={busy || !picked} className={rowActionClass.primary} onClick={() => onSave(picked)}>{t("save")}</button>
      <button type="button" className={rowActionClass.neutral} onClick={onCancel}>{t("cancel")}</button>
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
      <button type="button" disabled={busy || !ready} className={rowActionClass.primary} onClick={() => onSave(reason, note.trim())}>{t("save")}</button>
      <button type="button" className={rowActionClass.neutral} onClick={onCancel}>{t("cancel")}</button>
    </div>
  );
}

function SetAsideList({ entries, canDecide, day, kindLabel, labelOf, onChanged }: Shared & { entries: SetAsideEntry[] }) {
  const t = useDecisionCopy();
  const [open, setOpen] = useState(false);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const numberOf = useDocumentNumbers(entries.flatMap((entry) => entry.documentIds.map((id) => [entry.documentType, id] as const)));
  const documents = (entry: SetAsideEntry) => entry.documentNumber || entry.documentIds.map((id) => numberOf(entry.documentType, id) || id).join(", ") || "—";
  const status = (entry: SetAsideEntry) => {
    switch (entry.decision) {
      case "not_now": return t("aside_not_now", { date: entry.returnOn ? day(entry.returnOn) : "—" });
      case "not_needed": return t("aside_not_needed", { reason: entry.reasonCode ? t(`reason_${entry.reasonCode}` as DecisionCopyKey) : "—" }) + (entry.note ? ` (${entry.note})` : "");
      case "chased": return t("aside_chased", { date: entry.decidedOn ? day(entry.decidedOn) : "—" });
      case "accepted": return t("aside_accepted", { document: documents(entry) });
      default: return t("aside_covered", { document: documents(entry) });
    }
  };
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
                {canDecide ? <button type="button" disabled={busyKey === entry.key} className={`${rowActionClass.neutral} ml-auto`} onClick={() => reopen(entry.key)}>{t("reopen")}</button> : null}
              </li>
            ))}
          </ul>
          {message ? <p className="mt-1 text-xs" style={{ color: A.sub }} role="status">{message}</p> : null}
        </>
      ) : null}
    </div>
  );
}
