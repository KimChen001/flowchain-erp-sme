import { useMemo, useState } from "react";
import { Link } from "react-router";
import { ChevronDown, ChevronRight } from "lucide-react";
import { toast } from "sonner";
import { A } from "../../../components/ui";
import { listButtonClass } from "../../../components/ui/listLayout";
import { useI18n } from "../../../i18n/I18n";
import { unitLabel } from "../../../i18n/unitLabels";
import { apiJson } from "../../../lib/api-client";
import { formatCalendarDay, formatQuantity, instantDayInTimeZone } from "../../../lib/format";
import { procurementErrorCode, procurementErrorText } from "../../procurement/procurementErrors";
import { SUPPLIER_REPLY_ERROR_TEXT, supplierReplyText, type SupplierReplyCopyKey } from "./supplierReplyCopy";
import { SupplierReplyStockLine } from "./SupplierReplyStockLine";
import { SUPPLIER_REPLY_NOTE_LIMIT, dismissReady, formStart, isOpenReply, isOutage, lineNow, markQuotes, needsManualForm, openQuestions, pickableReadings, proposalRecord, recordKey, recordLines, replyErrorKind } from "./supplierReplyLogic";
import type { SupplierReplyCardData, SupplierReplyDismissReason, SupplierReplyLine } from "./supplierReplyTypes";

// One supplier reply on an order (docs/supplier-reply-dates-design.md §4.5–4.9):
// the proposal to record, the reply and the manual form when the person is
// needed or AI could not read it, or what became of it. FlowChain never
// answers the supplier; recording writes promised dates only, as the person,
// with the supplier's sentence as the reason (the server does that).

const BUTTON = { primary: `${listButtonClass.primary} !text-[12px]`, secondary: `${listButtonClass.secondary} !text-[12px]` };
const DISMISS_REASONS: SupplierReplyDismissReason[] = ["wrong_reading", "supplier_will_confirm", "other"];
// A reading of an ambiguous date, on the grey form line: white, and blue once picked.
const readingClass = (picked: boolean) => `inline-flex h-7 items-center rounded-lg border px-2 text-[12px] font-medium disabled:opacity-60 ${picked ? "border-blue-500 bg-blue-50 text-blue-700" : "border-slate-200 bg-white text-slate-800 hover:bg-slate-100"}`;

export function SupplierReplyCard({ card, onChanged, onRefused, notice = null, mayChange = false }: {
  card: SupplierReplyCardData;
  // The card after a decision, as the server answered it.
  onChanged: (next: SupplierReplyCardData, recorded: boolean) => void;
  // A stale card or a reply no longer open: the list keeps the sentence for
  // this reply (`notice`) across the reload it then makes.
  onRefused: (kind: "stale" | "moved" | "closed") => void;
  notice?: string | null;
  // The reader may change the order: a card without canDecide is then a
  // paste kept beside another open reply, not a matter of permission.
  mayChange?: boolean;
}) {
  const { language, locale, timezone } = useI18n();
  const t = (key: SupplierReplyCopyKey, values?: Record<string, string | number>) => supplierReplyText(language, key, values);
  const day = (value: string | null | undefined) => (value ? formatCalendarDay(value, locale) : t("noDate"));
  const qty = (value: number | null, unit: string | null) => (value === null ? "—" : `${formatQuantity(value)}${unit ? ` ${unitLabel(unit, language, value)}` : ""}`);
  // Our SKU and name; the supplier's own code beside them, as a reply may quote it.
  const lineName = (line: { sku: string | null; supplierSku?: string | null; itemName: string | null }) =>
    [line.sku, line.supplierSku && line.supplierSku !== line.sku ? `(${t("supplierCode", { code: line.supplierSku })})` : null, line.itemName].filter(Boolean).join(" · ").replace(" · (", " (") || t("unnamedLine");
  const late = (days: number | null) => (days ? (days === 1 ? t("dayLate") : t("daysLate", { n: days })) : null);

  const open = isOpenReply(card);
  const manual = needsManualForm(card);
  const [editing, setEditing] = useState(false);
  const [values, setValues] = useState<Record<string, string>>(() => formStart(card));
  const [dismissing, setDismissing] = useState(false);
  const [reason, setReason] = useState<SupplierReplyDismissReason>("wrong_reading");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [showReply, setShowReply] = useState(manual || card.state === "nothing_to_record");
  const [showQuoted, setShowQuoted] = useState(false);
  // Open questions on a proposal the person chose to leave as they are.
  const [skipped, setSkipped] = useState<Set<string>>(() => new Set());

  const byLine = useMemo(() => new Map(card.lines.filter((line) => line.purchaseOrderLineId).map((line) => [line.purchaseOrderLineId as string, line])), [card.lines]);
  const proposedLines = card.lines.filter((line) => line.outcome === "proposed" || line.outcome === "confirmed");
  const droppedLines = card.lines.filter((line) => line.outcome === "dropped" || (line.outcome === "needs_you" && !line.purchaseOrderLineId));
  // Lines of a proposed card that still need the person (#363 §4.8).
  const questions = openQuestions(card);
  const proposal = proposalRecord(card, values, skipped);
  // The dates Record would write: the proposal's, with the open questions'
  // answers once each is answered or left (proposal.lines).
  const proposedDates = useMemo(() => card.lines.filter((line) => line.outcome === "proposed" && line.purchaseOrderLineId && line.proposedDate).map((line) => ({ purchaseOrderLineId: line.purchaseOrderLineId!, promisedDate: line.proposedDate! })), [card.lines]);
  // A day the server stamped (an instant) as the workspace's calendar day.
  const decidedDay = card.decision ? instantDayInTimeZone(card.decision.decidedAt, timezone) : "";
  // The sentences the card points at, marked on the reply.
  const segments = useMemo(() => markQuotes(card.text, [...card.lines.map((line) => line.quote), ...card.lines.flatMap((line) => (line.parts || []).map((part) => part.quote)), card.reason]), [card.text, card.lines, card.reason]);
  const formOpen = open && (manual || editing);

  const act = async (work: () => Promise<{ reply: SupplierReplyCardData }>, done: (next: SupplierReplyCardData) => string, recorded = false) => {
    setBusy(true);
    setMessage(null);
    try {
      const { reply } = await work();
      toast.success(done(reply));
      setEditing(false);
      setDismissing(false);
      onChanged(reply, recorded);
    } catch (error) {
      const kind = replyErrorKind(error);
      if (kind !== "other") {
        onRefused(kind);
      } else {
        toast.error(t("failed"), { description: <span title={procurementErrorCode(error)}>{procurementErrorText(error, language, [t("retry"), t("retry")], SUPPLIER_REPLY_ERROR_TEXT)}</span> });
      }
    } finally {
      setBusy(false);
    }
  };
  // The reply's routes (SUPPLIER_REPLY_ROUTES in shared/supplier-reply-contract.mjs),
  // written out so the write-route caller test reads them.
  const reply = `/api/procurement/orders/${encodeURIComponent(card.purchaseOrderId)}/supplier-replies/${encodeURIComponent(card.id)}`;
  const send = <T,>(url: string, body: unknown) => apiJson<T>(url, { method: "POST", body: JSON.stringify(body) });
  // The proposal as it stands, or with the open questions' dates added.
  const recordProposal = () => {
    if (!proposal.ready) { setMessage(t("resolveFirst")); return; }
    const lines = proposal.lines;
    return act(() => send(`${reply}/record`, { expectedVersion: card.orderVersion, ...(lines ? { lines } : {}), idempotencyKey: recordKey(card, lines) }), () => t("recordedToast", { po: card.purchaseOrderNumber }), true);
  };
  const recordForm = () => {
    const lines = recordLines(card, values);
    if (!lines.length) { setMessage(t("enterADate")); return; }
    return act(() => send(`${reply}/record`, { expectedVersion: card.orderVersion, lines, idempotencyKey: recordKey(card, lines) }), () => t("recordedToast", { po: card.purchaseOrderNumber }), true);
  };
  const notNow = () => act(() => send(`${reply}/not-now`, {}), () => t("notNowToast", { po: card.purchaseOrderNumber }));
  const dismiss = () => act(() => send(`${reply}/dismiss`, { reason, ...(note.trim() ? { note: note.trim() } : {}) }), () => t("dismissedToast", { po: card.purchaseOrderNumber }));

  const nowCell = (line: { purchaseOrderLineId: string | null; currentDate: string | null; overdueDays: number | null }) => {
    const { now, overdueDays, movedFrom } = lineNow(card, line);
    return (
      <>
        {day(now)}
        {late(overdueDays ?? line.overdueDays) ? <span className="text-red-700"> · {late(overdueDays ?? line.overdueDays)}</span> : null}
        {movedFrom !== undefined ? <div className="text-amber-800" data-testid="supplier-reply-moved">{t("movedLine", { now: day(now), was: day(movedFrom) })}</div> : null}
      </>
    );
  };
  // The two readings to pick from, where one click may pick (pickableReadings).
  const readingButtons = (line: SupplierReplyLine, lineId: string) => {
    const readings = pickableReadings(line);
    if (!readings) return null;
    return (
      <div className="mt-1 flex flex-wrap items-center gap-1.5" data-testid="supplier-reply-readings">
        <span className="w-full">{t(line.issue === "several_dates" ? "severalDates" : line.issue === "vague" ? "vagueChoices" : line.issue === "ambiguous_weekday" ? "weekdayChoices" : "ambiguous")}</span>
        {readings.map((reading) => <button key={reading} type="button" disabled={!card.canDecide} className={readingClass(values[lineId] === reading)} aria-pressed={values[lineId] === reading} onClick={() => { setValues({ ...values, [lineId]: reading }); setSkipped(new Set([...skipped].filter((id) => id !== lineId))); }}>{t("useReading", { date: day(reading) })}</button>)}
      </div>
    );
  };
  const lineExtras = (line: SupplierReplyLine | undefined) => {
    if (!line) return null;
    return (
      <>
        {/* A day read from the reply, not stated as the delivery day, says so;
            a relative date says what it counts from. */}
        {line.readAs ? <div className={`text-[11px] ${line.inferred ? "text-amber-800" : ""}`} style={line.inferred ? undefined : { color: A.sub }} data-testid="supplier-reply-read-as" data-inferred={line.inferred ? "true" : "false"}>{line.inferred ? t("readInferred", { date: day(line.readAs.date) }) : t("readAs", { phrase: line.readAs.phrase, date: day(line.readAs.date), from: day(line.readAs.from) })}</div> : null}
        {line.parts?.length ? <div className="text-[11px]" style={{ color: A.sub }} data-testid="supplier-reply-split">{t("split", { parts: line.parts.map((part) => (part.quantity === null ? t("partNoQty", { date: day(part.date) }) : t("part", { qty: qty(part.quantity, line.unit), date: day(part.date) }))).join("; ") })}</div> : null}
      </>
    );
  };

  return (
    <section className="rounded-lg border bg-white p-3 text-xs" data-testid="supplier-reply-card" data-state={card.state} data-reading={card.readingStatus}>
      <div className="text-sm font-semibold" style={{ color: A.label }}>{t("title")}</div>
      <div className="mt-0.5" style={{ color: A.sub }} data-testid="supplier-reply-meta">{[card.purchaseOrderNumber, card.supplierName, t("received", { date: day(card.receivedOn) }), t(card.source === "email" ? "emailed" : "pasted")].filter(Boolean).join(" · ")}</div>

      {card.instructionsIgnored ? <p className="mt-2 rounded-md bg-amber-50 px-2 py-1 text-amber-800" role="note" data-testid="supplier-reply-instructions-ignored">{t("instructionsIgnored")}</p> : null}

      {/* What the card says the reply is. */}
      {open && isOutage(card) ? <p className="mt-2 rounded-md bg-slate-50 px-2 py-1" data-testid="supplier-reply-outage">{t(`outage_${card.readingStatus}` as SupplierReplyCopyKey)}</p> : null}
      {open && !isOutage(card) && card.state === "needs_you" ? <p className="mt-2 rounded-md bg-amber-50 px-2 py-1 text-amber-800" data-testid="supplier-reply-needs-you">{t("needsYou")}</p> : null}
      {card.state === "nothing_to_record" ? <p className="mt-2" style={{ color: A.sub }} data-testid="supplier-reply-nothing">{t("nothing")}</p> : null}
      {card.state === "recorded" && card.decision ? <p className="mt-2 text-emerald-700" data-testid="supplier-reply-recorded">{card.decision.editedLines ? t("recordedEdited", { date: day(decidedDay), n: card.decision.editedLines }) : t("recorded", { date: day(decidedDay) })}</p> : null}
      {card.state === "not_recorded" && card.decision ? <p className="mt-2" style={{ color: A.sub }} data-testid="supplier-reply-not-recorded">{t("notRecorded", { date: day(decidedDay), reason: card.decision.reason ? t(`dismiss_${card.decision.reason}` as SupplierReplyCopyKey) : "—" })}{card.decision.note ? ` ${card.decision.note}` : ""}</p> : null}
      {card.state === "superseded" ? <p className="mt-2" style={{ color: A.sub }} data-testid="supplier-reply-superseded">{t("superseded")}</p> : null}
      {open && card.notNowUntil ? <p className="mt-2" style={{ color: A.sub }} data-testid="supplier-reply-set-aside">{t("setAside", { date: day(card.notNowUntil) })}</p> : null}

      {/* The proposal: each line now and proposed, with the sentence it came from (#363 §4.6). */}
      {card.state === "proposed" && !editing && proposedLines.length ? (
        <div className="mt-2">
          <table className="w-full text-xs" data-testid="supplier-reply-proposal">
            <thead><tr style={{ color: A.sub }}><th className="py-1 pr-3 text-left font-medium">{t("line")}</th><th className="py-1 pr-3 text-left font-medium">{t("now")}</th><th className="py-1 text-left font-medium">{t("proposed")}</th></tr></thead>
            <tbody>
              {proposedLines.map((line, index) => (
                <tr key={line.purchaseOrderLineId || index} className="border-t align-top" data-testid="supplier-reply-line" data-outcome={line.outcome}>
                  <td className="py-1.5 pr-3"><div className="font-medium">{lineName(line)}</div><div style={{ color: A.sub }}>{t("left", { qty: qty(line.remaining, line.unit) })}</div></td>
                  <td className="py-1.5 pr-3">{nowCell(line)}</td>
                  <td className="py-1.5">
                    {line.outcome === "confirmed" ? <span style={{ color: A.sub }}>{t("confirms")}</span> : <span className="font-semibold" data-testid="supplier-reply-proposed-date">{day(line.proposedDate)}</span>}
                    {line.quote ? <div className="mt-0.5 italic" style={{ color: A.gray1 }}>“{line.quote}”</div> : null}
                    {lineExtras(line)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {questions.length ? (
            <div className="mt-2 space-y-2" data-testid="supplier-reply-questions">
              <p className="font-medium text-amber-800">{t("openQuestions")}</p>
              {questions.map((line) => {
                const lineId = line.purchaseOrderLineId!;
                const leave = skipped.has(lineId);
                return (
                  <div key={lineId} className="rounded-md bg-amber-50/60 p-2" data-testid="supplier-reply-question" data-line={lineId}>
                    <div className="font-medium">{lineName(line)} <span className="font-normal" style={{ color: A.sub }}>· {t("left", { qty: qty(line.remaining, line.unit) })}</span></div>
                    <div style={{ color: A.sub }}>{t("now")}: {nowCell(line)}</div>
                    {line.issue && !pickableReadings(line) ? <div className="text-amber-800">{t(`issue_${line.issue}` as SupplierReplyCopyKey)}</div> : null}
                    {line.quote ? <div className="italic" style={{ color: A.gray1 }}>{t("vagueSaid", { quote: line.quote })}</div> : null}
                    {readingButtons(line, lineId)}
                    {lineExtras(line)}
                    {card.canDecide ? (
                      <div className="mt-1 flex flex-wrap items-center gap-3">
                        <label className="flex items-center gap-2 text-xs font-normal">
                          <span>{t("promisedDate")}</span>
                          <input type="date" disabled={leave} aria-label={`${t("promisedDate")} · ${lineName(line)}`} className="rounded border bg-white px-1 py-0.5 text-xs" value={values[lineId] || ""} onChange={(event) => setValues({ ...values, [lineId]: event.target.value })} />
                        </label>
                        <label className="flex items-center gap-1.5 text-xs font-normal">
                          <input type="checkbox" checked={leave} data-testid="supplier-reply-leave" onChange={(event) => setSkipped(event.target.checked ? new Set([...skipped, lineId]) : new Set([...skipped].filter((id) => id !== lineId)))} />
                          <span>{t("leaveUnchanged")}</span>
                        </label>
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          ) : null}
          {/* What the dates being recorded do to stock before they come (#363 §4.6). */}
          {open ? <SupplierReplyStockLine reply={reply} lines={proposal.lines ?? proposedDates} /> : null}
          {card.reason ? <p className="mt-1" data-testid="supplier-reply-reason"><span style={{ color: A.sub }}>{t("reasonGiven")}</span><span className="italic">“{card.reason}”</span></p> : null}
          <p className="mt-1 text-[11px]" style={{ color: A.sub }}>{t("reasonNote")}</p>
        </div>
      ) : null}

      {/* The manual form: needs you, an outage, or Edit. */}
      {formOpen ? (
        <div className={`mt-2 grid gap-3 ${manual ? "md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]" : ""}`}>
          <div className="space-y-2" data-testid="supplier-reply-form">
            {card.formLines.map((formLine) => {
              const lineId = formLine.purchaseOrderLineId || "";
              const line = byLine.get(lineId);
              return (
                <div key={lineId} className="rounded-md bg-slate-50 p-2" data-testid="supplier-reply-form-line" data-line={lineId}>
                  <div className="font-medium">{lineName(formLine)} <span className="font-normal" style={{ color: A.sub }}>· {t("left", { qty: qty(formLine.remaining, formLine.unit) })}</span></div>
                  <div style={{ color: A.sub }}>{t("now")}: {nowCell({ purchaseOrderLineId: lineId, currentDate: line ? line.currentDate : formLine.currentDate, overdueDays: formLine.overdueDays })}</div>
                  {line?.issue && line.outcome === "needs_you" && !pickableReadings(line) ? <div className="text-amber-800">{t(`issue_${line.issue}` as SupplierReplyCopyKey)}</div> : null}
                  {line?.quote ? <div className="italic" style={{ color: A.gray1 }} data-testid="supplier-reply-form-quote">{t("vagueSaid", { quote: line.quote })}</div> : null}
                  {line ? readingButtons(line, lineId) : null}
                  {lineExtras(line)}
                  {card.canDecide ? (
                    <label className="mt-1 flex items-center gap-2 text-xs font-normal">
                      <span>{t("promisedDate")}</span>
                      <input type="date" aria-label={`${t("promisedDate")} · ${lineName(formLine)}`} className="rounded border bg-white px-1 py-0.5 text-xs" value={values[lineId] || ""} onChange={(event) => setValues({ ...values, [lineId]: event.target.value })} />
                    </label>
                  ) : null}
                </div>
              );
            })}
          </div>
          {manual ? <ReplyText card={card} segments={segments} showQuoted={showQuoted} setShowQuoted={setShowQuoted} t={t} /> : null}
        </div>
      ) : null}

      {/* Lines not used, and what the reply mentions that is not recorded here. */}
      {open && droppedLines.length ? (
        <div className="mt-2" data-testid="supplier-reply-not-used">
          <span style={{ color: A.sub }}>{t("notUsed")}</span>
          <ul className="ml-4 list-disc">{droppedLines.map((line, index) => <li key={index}>{lineName(line)}{line.issue ? ` — ${t(`issue_${line.issue}` as SupplierReplyCopyKey)}` : ""}{line.quote ? ` (“${line.quote}”)` : ""}</li>)}</ul>
        </div>
      ) : null}
      {card.flags.length ? (
        <div className="mt-2" data-testid="supplier-reply-flags">
          <span style={{ color: A.sub }}>{t("alsoMentioned")}</span>
          <ul className="ml-4 list-disc">{card.flags.map((flag, index) => <li key={index} data-flag={flag.kind}><span className="font-medium">{t(`flag_${flag.kind}` as SupplierReplyCopyKey)}</span> (“{flag.quote}”){flag.orderNumber ? <> · <Link className="font-medium text-blue-600 hover:underline" to={`/app/procurement/orders/${encodeURIComponent(flag.orderNumber)}`} data-testid="supplier-reply-other-order">{t("openOrder", { po: flag.orderNumber })}</Link></> : ""}</li>)}</ul>
        </div>
      ) : null}

      {/* The reply itself, when the form does not already show it beside the dates. */}
      {!(formOpen && manual) ? (
        <div className="mt-2">
          <button type="button" className="flex items-center gap-1 font-medium" style={{ color: A.gray1 }} aria-expanded={showReply} data-testid="supplier-reply-toggle" onClick={() => setShowReply(!showReply)}>
            {showReply ? <ChevronDown size={13} aria-hidden /> : <ChevronRight size={13} aria-hidden />}{t(showReply ? "hideReply" : "showReply")}
          </button>
          {showReply ? <ReplyText card={card} segments={segments} showQuoted={showQuoted} setShowQuoted={setShowQuoted} t={t} /> : null}
        </div>
      ) : null}

      {/* The buttons: only for someone who may change the order (card.canDecide). */}
      {open && card.canDecide ? (
        <div className="mt-3 flex flex-wrap items-center gap-2" data-testid="supplier-reply-actions">
          {card.state === "proposed" && !editing && proposedLines.some((line) => line.outcome === "proposed") ? <button type="button" disabled={busy || !proposal.ready} className={BUTTON.primary} data-testid="supplier-reply-record" onClick={() => void recordProposal()}>{t("record")}</button> : null}
          {card.state === "proposed" && !editing && !proposal.ready ? <span className="text-amber-800" data-testid="supplier-reply-resolve-first">{t("resolveFirst")}</span> : null}
          {formOpen ? <button type="button" disabled={busy} className={BUTTON.primary} data-testid="supplier-reply-record-form" onClick={() => void recordForm()}>{t("recordThese")}</button> : null}
          {card.state === "proposed" && !manual ? <button type="button" disabled={busy} className={BUTTON.secondary} data-testid="supplier-reply-edit" aria-pressed={editing} onClick={() => { setEditing(!editing); setValues(formStart(card)); setMessage(null); }}>{t(editing ? "cancel" : "edit")}</button> : null}
          <div className="flex gap-2 sm:ml-auto">
            <button type="button" disabled={busy} className={BUTTON.secondary} data-testid="supplier-reply-not-now" onClick={() => void notNow()}>{t("notNow")}</button>
            <button type="button" disabled={busy} className={BUTTON.secondary} aria-expanded={dismissing} data-testid="supplier-reply-dont-record" onClick={() => setDismissing(!dismissing)}>{t("dontRecord")} ▾</button>
          </div>
        </div>
      ) : null}
      {open && !card.canDecide ? <p className="mt-2" style={{ color: A.sub }} data-testid="supplier-reply-view-only">{t(mayChange ? "inactive" : "viewOnly")}</p> : null}
      {open && card.canDecide && dismissing ? (
        <div className="mt-2 flex flex-wrap items-center gap-2 rounded-md bg-slate-50 p-2" data-testid="supplier-reply-dismiss-form">
          <label className="flex items-center gap-1">
            <span>{t("dismissReason")}</span>
            <select className="rounded border px-1 py-0.5" value={reason} onChange={(event) => setReason(event.target.value as SupplierReplyDismissReason)}>
              {DISMISS_REASONS.map((code) => <option key={code} value={code}>{t(`dismiss_${code}` as SupplierReplyCopyKey)}</option>)}
            </select>
          </label>
          <input className="min-w-48 flex-1 rounded border px-2 py-0.5" maxLength={SUPPLIER_REPLY_NOTE_LIMIT} aria-label={t("notePlaceholder")} placeholder={t("notePlaceholder")} value={note} onChange={(event) => setNote(event.target.value)} />
          <button type="button" disabled={busy || !dismissReady(reason, note)} className={BUTTON.primary} data-testid="supplier-reply-dismiss-save" onClick={() => void dismiss()}>{t("save")}</button>
          <button type="button" className={BUTTON.secondary} onClick={() => setDismissing(false)}>{t("cancel")}</button>
        </div>
      ) : null}
      {notice ? <p className="mt-2 rounded-md bg-amber-50 px-2 py-1 text-amber-800" role="status" data-testid="supplier-reply-notice">{notice}</p> : null}
      {message ? <p className="mt-2" style={{ color: A.sub }} role="status" data-testid="supplier-reply-message">{message}</p> : null}
    </section>
  );
}

// The reply as kept on the order, with the supplier's sentences marked. The
// quoted earlier message is hidden, never read, and shown only on request.
function ReplyText({ card, segments, showQuoted, setShowQuoted, t }: {
  card: SupplierReplyCardData;
  segments: Array<{ text: string; marked: boolean }>;
  showQuoted: boolean;
  setShowQuoted: (value: boolean) => void;
  t: (key: SupplierReplyCopyKey, values?: Record<string, string | number>) => string;
}) {
  return (
    <div className="mt-1" data-testid="supplier-reply-text">
      <div className="text-[11px] font-medium" style={{ color: A.sub }}>{t("reply")}</div>
      <p className="mt-0.5 whitespace-pre-wrap rounded-md border bg-white p-2 leading-relaxed">
        {segments.map((segment, index) => (segment.marked ? <mark key={index} className="rounded bg-amber-100 px-0.5" data-testid="supplier-reply-marked">{segment.text}</mark> : <span key={index}>{segment.text}</span>))}
      </p>
      {card.quotedTextHidden ? (
        <div className="mt-1 text-[11px]" style={{ color: A.sub }} data-testid="supplier-reply-quoted">
          {t("quotedHidden")}
          {card.quotedText ? <button type="button" className="ml-2 font-medium text-blue-600" aria-expanded={showQuoted} onClick={() => setShowQuoted(!showQuoted)}>{t(showQuoted ? "hideQuoted" : "showQuoted")}</button> : null}
          {showQuoted && card.quotedText ? <><p className="mt-1">{t("quotedNote")}</p><p className="mt-0.5 whitespace-pre-wrap rounded-md bg-slate-50 p-2" data-testid="supplier-reply-quoted-text">{card.quotedText}</p></> : null}
        </div>
      ) : null}
    </div>
  );
}
