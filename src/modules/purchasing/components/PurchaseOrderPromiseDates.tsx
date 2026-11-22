import { useEffect, useMemo, useState } from "react";
import { readAuthorizationContext } from "../../../lib/authorizationContext";
import { toast } from "sonner";
import { apiJson } from "../../../lib/api-client";
import { useI18n } from "../../../i18n/I18n";
import { procurementErrorCode, procurementErrorText } from "../../procurement/procurementErrors";
import { listTableCardsRef, tableBodyTextClass, tdClass, tdNowrapClass, thClass } from "../../../components/ui/workbenchTable";
import { listButtonClass, listHeadRowStyle, listRowClass, listRowStyle } from "../../../components/ui/listLayout";
import { A, Card, SectionHeader } from "../../../components/ui";
import { fieldControlStyle, fieldLabelClass, fieldLabelStyle } from "../../../components/ui/formLayout";

// Promised dates of an approved or issued PO: each line's original promise,
// its current date and the revisions between them. Before issue a date (such
// as the one the supplier confirms) simply changes: the original promise is
// recorded when the PO is issued or first received (design audit L1-05).
// After issue a change needs a reason; the server keeps the original promise
// and records the revision.

type PromiseLine = { id: string; sku: string | null; itemName: string | null; orderedQuantity: string | null; receivedQuantity: string | null; unit: string | null; promisedDate: string | null; originalPromisedDate: string | null };
type PromiseRevision = { id: string; purchaseOrderLineId: string; previousDate: string | null; newDate: string; reason: string; createdAt: string };
type PurchaseOrderPromises = { id: string; status: string; version: number; lines: PromiseLine[]; promiseRevisions: PromiseRevision[] };

const REVISABLE = new Set(["approved", "issued", "partially_received"]);
const COPY: Record<string, [string, string]> = {
  title: ["Promised dates", "承诺交期"],
  note: ["Supplier scorecards measure deliveries against the original promise.", "供应商绩效按原始承诺交期衡量交付。"],
  notIssuedNote: ["Not issued yet: set the date the supplier confirms. The original promise is recorded when the PO is issued or first received.", "尚未下达：可填写供应商确认的日期。原始承诺交期在下达或首次收货时记录。"],
  line: ["Line", "订单行"], original: ["Original promise", "原始承诺交期"], current: ["Current date", "当前交期"],
  notRecorded: ["Not recorded", "未记录"], change: ["Change promised date", "修改承诺交期"],
  newDate: ["New promised date", "新的承诺交期"], reason: ["Reason", "原因"], reasonPlaceholder: ["For example: the supplier moved the ship date", "例如：供应商推迟了发货日期"],
  save: ["Save revision", "保存修改"], cancel: ["Cancel", "取消"], saved: ["Promised date revised", "承诺交期已修改"], failed: ["The promised date could not be revised", "承诺交期修改失败"],
  history: ["Revisions", "修改记录"], noHistory: ["No revisions", "暂无修改"], dateRequired: ["Enter the date as YYYY-MM-DD.", "请按 YYYY-MM-DD 输入日期。"], reasonRequired: ["Give a reason for the change.", "请填写修改原因。"],
  allSame: ["All {n} lines are promised for {date}, as first promised.", "全部 {n} 行承诺交期均为 {date}，与原始承诺一致。"],
  showLines: ["Show lines", "展开各行"], hideLines: ["Hide lines", "收起各行"],
};

// More lines than this, all still on one unchanged date, fold into one sentence.
const FOLD_AFTER = 3;

export function PurchaseOrderPromiseDates({ poId, onChanged }: { poId: string; onChanged?: () => void }) {
  const { language, locale, timezone } = useI18n();
  const tr = (key: string) => COPY[key][language === "en-US" ? 0 : 1];
  const day = useMemo(() => { const format = new Intl.DateTimeFormat(locale, { timeZone: "UTC", year: "numeric", month: "short", day: "numeric" }); return (value: string | null) => (value ? format.format(new Date(`${value.slice(0, 10)}T12:00:00Z`)) : "—"); }, [locale]);
  const when = useMemo(() => { const format = new Intl.DateTimeFormat(locale, { timeZone: timezone, year: "numeric", month: "short", day: "numeric" }); return (value: string) => format.format(new Date(value)); }, [locale, timezone]);
  const [po, setPo] = useState<PurchaseOrderPromises | null>(null);
  const [canRevise, setCanRevise] = useState(false);
  const [form, setForm] = useState<{ lineId: string; date: string; reason: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const load =() => apiJson<PurchaseOrderPromises>(`/api/procurement/orders/${encodeURIComponent(poId)}`).then(setPo).catch(() => setPo(null));
  useEffect(() => { void load(); }, [poId]);
  useEffect(() => {
    readAuthorizationContext().then((context) => setCanRevise((context.effectivePermissions || []).includes("procurement.purchase_order.revise"))).catch(() => setCanRevise(false));
  }, []);
  if (!po || !po.lines.length) return null;
  const revisable = canRevise && REVISABLE.has(po.status);
  // A long order whose lines all keep one first promise reads as one line;
  // the table opens on request, or by itself once a date moves.
  const firstDate = po.lines[0].promisedDate;
  const unchanged = po.lines.length > FOLD_AFTER && !po.promiseRevisions.length && Boolean(firstDate)
    && po.lines.every((line) => line.promisedDate === firstDate && (line.originalPromisedDate || line.promisedDate) === firstDate);
  const folded = unchanged && !expanded && !form;
  const submit = async () => {
    if (!form) return;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(form.date)) return toast.warning(tr("dateRequired"));
    if (!form.reason.trim()) return toast.warning(tr("reasonRequired"));
    setBusy(true);
    try {
      await apiJson(`/api/procurement/orders/${encodeURIComponent(poId)}/promised-dates`, { method: "POST", body: JSON.stringify({ expectedVersion: po.version, lines: [{ purchaseOrderLineId: form.lineId, promisedDate: form.date }], reason: form.reason.trim() }) });
      toast.success(tr("saved"));
      setForm(null);
      await load();
      onChanged?.();
    } catch (error) {
      toast.error(tr("failed"), { description: <span title={procurementErrorCode(error)}>{procurementErrorText(error, language, ["Try again in a moment.", "请稍后重试。"])}</span> });
    } finally {
      setBusy(false);
    }
  };
  return (
    // A section of the order page like its others: the title above, the card below.
    <section data-testid="po-promise-dates">
      <SectionHeader title={tr("title")} right={unchanged && !form ? (
        <button type="button" aria-expanded={!folded} data-testid="po-promise-toggle" className="h-8 rounded-lg px-2 text-xs font-medium text-blue-600 hover:bg-blue-50 max-sm:h-9" onClick={() => setExpanded(!expanded)}>
          {tr(folded ? "showLines" : "hideLines")}
        </button>
      ) : undefined} />
      <Card className="p-4">
      <p className="text-xs" style={{ color: A.sub }}>{tr("note")}</p>{po.status === "approved" && <p className="text-xs" style={{ color: A.sub }} data-testid="po-promise-not-issued">{tr("notIssuedNote")}</p>}
      {unchanged && <p className="mt-2 text-xs text-slate-700" data-testid="po-promise-summary">{tr("allSame").replace("{n}", String(po.lines.length)).replace("{date}", day(firstDate))}</p>}
      {/* Below 640 px each line is a card (listTableCardsRef): the line on top,
          the original and current dates under it with their names, and the
          change button below at a full tap size. */}
      {!folded && <div className="mt-2 overflow-x-auto" ref={listTableCardsRef} data-testid="po-promise-table">
        <table className={`w-full min-w-[560px] text-left ${tableBodyTextClass}`}>
          <thead><tr style={listHeadRowStyle}>{[tr("line"), tr("original"), tr("current"), ""].map((header, index) => <th key={index} className={thClass} style={{ color: A.gray1 }} {...(index === 0 ? { "data-card-title": "" } : {})}>{header}</th>)}</tr></thead>
          <tbody>
            {po.lines.map((line, index) => (
              <tr key={line.id} className={listRowClass} style={listRowStyle(index, po.lines.length)} data-testid={`po-promise-line-${line.id}`}>
                <td className={`${tdClass} font-medium`}>{line.sku}{line.itemName ? ` · ${line.itemName}` : ""}</td>
                <td className={tdNowrapClass}>{line.originalPromisedDate ? day(line.originalPromisedDate) : tr("notRecorded")}</td>
                <td className={tdNowrapClass}>{day(line.promisedDate)}</td>
                <td className={tdNowrapClass}>{revisable && <button type="button" data-testid={`po-promise-change-${line.id}`} className="inline-flex h-8 items-center whitespace-nowrap rounded-lg px-2 text-xs font-medium text-blue-600 hover:bg-blue-50" onClick={() => setForm({ lineId: line.id, date: line.promisedDate || "", reason: "" })}>{tr("change")}</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>}
      {form && (
        <div className="mt-3 grid gap-2 rounded-lg bg-slate-50 p-3 md:grid-cols-[10rem_1fr_auto]" data-testid="po-promise-form">
          <label className={fieldLabelClass} style={fieldLabelStyle}>{tr("newDate")}<input aria-label={tr("newDate")} placeholder="YYYY-MM-DD" inputMode="numeric" maxLength={10} value={form.date} onChange={(event) => setForm({ ...form, date: event.target.value })} style={fieldControlStyle} /></label>
          <label className={fieldLabelClass} style={fieldLabelStyle}>{tr("reason")}<input aria-label={tr("reason")} placeholder={tr("reasonPlaceholder")} value={form.reason} onChange={(event) => setForm({ ...form, reason: event.target.value })} style={fieldControlStyle} /></label>
          <div className="flex items-end gap-2"><button type="button" onClick={() => setForm(null)} className={listButtonClass.outline}>{tr("cancel")}</button><button type="button" disabled={busy} onClick={() => void submit()} className={listButtonClass.primary}>{tr("save")}</button></div>
        </div>
      )}
      <div className="mt-3">
        {po.promiseRevisions.length ? <h4 className="text-xs font-semibold">{tr("history")}</h4> : null}
        {po.promiseRevisions.length ? (
          <ul className="mt-1 space-y-1 text-[11px] text-slate-600" data-testid="po-promise-history">
            {po.promiseRevisions.map((revision) => (
              <li key={revision.id}>{when(revision.createdAt)} · {po.lines.find((line) => line.id === revision.purchaseOrderLineId)?.sku || revision.purchaseOrderLineId}: {day(revision.previousDate)} → {day(revision.newDate)} · {revision.reason}</li>
            ))}
          </ul>
        ) : <p className="mt-1 text-[11px] text-slate-500">{tr("noHistory")}</p>}
      </div>
      </Card>
    </section>
  );
}
