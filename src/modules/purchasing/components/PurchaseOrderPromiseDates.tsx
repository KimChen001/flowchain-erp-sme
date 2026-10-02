import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { apiJson } from "../../../lib/api-client";
import { useI18n } from "../../../i18n/I18n";

// Promised dates of an issued PO: each line's original promise, its current
// date and the revisions between them. Revising needs a reason; the server
// keeps the original promise and records the revision.

type PromiseLine = { id: string; sku: string | null; itemName: string | null; orderedQuantity: string | null; receivedQuantity: string | null; unit: string | null; promisedDate: string | null; originalPromisedDate: string | null };
type PromiseRevision = { id: string; purchaseOrderLineId: string; previousDate: string | null; newDate: string; reason: string; createdAt: string };
type PurchaseOrderPromises = { id: string; status: string; version: number; lines: PromiseLine[]; promiseRevisions: PromiseRevision[] };

const REVISABLE = new Set(["issued", "partially_received"]);
const COPY: Record<string, [string, string]> = {
  title: ["Promised dates", "承诺交期"],
  note: ["Supplier scorecards measure deliveries against the original promise.", "供应商绩效按原始承诺交期衡量交付。"],
  line: ["Line", "订单行"], original: ["Original promise", "原始承诺交期"], current: ["Current date", "当前交期"],
  notRecorded: ["Not recorded", "未记录"], change: ["Change promised date", "修改承诺交期"],
  newDate: ["New promised date", "新的承诺交期"], reason: ["Reason", "原因"], reasonPlaceholder: ["For example: the supplier moved the ship date", "例如：供应商推迟了发货日期"],
  save: ["Save revision", "保存修改"], cancel: ["Cancel", "取消"], saved: ["Promised date revised", "承诺交期已修改"], failed: ["The promised date could not be revised", "承诺交期修改失败"],
  history: ["Revisions", "修改记录"], noHistory: ["No revisions", "暂无修改"], dateRequired: ["Enter the date as YYYY-MM-DD.", "请按 YYYY-MM-DD 输入日期。"], reasonRequired: ["Give a reason for the change.", "请填写修改原因。"],
};

export function PurchaseOrderPromiseDates({ poId, onChanged }: { poId: string; onChanged?: () => void }) {
  const { language, locale, timezone } = useI18n();
  const tr = (key: string) => COPY[key][language === "en-US" ? 0 : 1];
  const day = useMemo(() => { const format = new Intl.DateTimeFormat(locale, { timeZone: "UTC", year: "numeric", month: "short", day: "numeric" }); return (value: string | null) => (value ? format.format(new Date(`${value.slice(0, 10)}T12:00:00Z`)) : "—"); }, [locale]);
  const when = useMemo(() => { const format = new Intl.DateTimeFormat(locale, { timeZone: timezone, year: "numeric", month: "short", day: "numeric" }); return (value: string) => format.format(new Date(value)); }, [locale, timezone]);
  const [po, setPo] = useState<PurchaseOrderPromises | null>(null);
  const [canRevise, setCanRevise] = useState(false);
  const [form, setForm] = useState<{ lineId: string; date: string; reason: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const load = () => apiJson<PurchaseOrderPromises>(`/api/procurement/orders/${encodeURIComponent(poId)}`).then(setPo).catch(() => setPo(null));
  useEffect(() => { void load(); }, [poId]);
  useEffect(() => {
    apiJson<{ effectivePermissions?: string[] }>("/api/authorization/context").then((context) => setCanRevise((context.effectivePermissions || []).includes("procurement.purchase_order.revise"))).catch(() => setCanRevise(false));
  }, []);
  if (!po || !po.lines.length) return null;
  const revisable = canRevise && REVISABLE.has(po.status);
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
      toast.error(tr("failed"), { description: error instanceof Error ? error.message : undefined });
    } finally {
      setBusy(false);
    }
  };
  return (
    <section data-testid="po-promise-dates" className="rounded-xl border bg-white p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div><h3 className="text-sm font-semibold">{tr("title")}</h3><p className="text-[11px] text-slate-500">{tr("note")}</p></div>
      </div>
      <div className="mt-2 overflow-x-auto">
        <table className="w-full min-w-[560px] text-xs">
          <thead><tr>{[tr("line"), tr("original"), tr("current"), ""].map((header, index) => <th key={index} className="p-2 text-left text-slate-500">{header}</th>)}</tr></thead>
          <tbody>
            {po.lines.map((line) => (
              <tr key={line.id} className="border-t" data-testid={`po-promise-line-${line.id}`}>
                <td className="p-2">{line.sku}{line.itemName ? ` · ${line.itemName}` : ""}</td>
                <td className="p-2">{line.originalPromisedDate ? day(line.originalPromisedDate) : tr("notRecorded")}</td>
                <td className="p-2">{day(line.promisedDate)}</td>
                <td className="p-2">{revisable && <button type="button" data-testid={`po-promise-change-${line.id}`} className="text-blue-600" onClick={() => setForm({ lineId: line.id, date: line.promisedDate || "", reason: "" })}>{tr("change")}</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {form && (
        <div className="mt-3 grid gap-2 rounded-lg bg-slate-50 p-3 md:grid-cols-[10rem_1fr_auto]" data-testid="po-promise-form">
          <label className="text-[11px] font-medium text-slate-600">{tr("newDate")}<input aria-label={tr("newDate")} placeholder="YYYY-MM-DD" inputMode="numeric" maxLength={10} value={form.date} onChange={(event) => setForm({ ...form, date: event.target.value })} className="mt-1 block h-8 w-full rounded border px-2" /></label>
          <label className="text-[11px] font-medium text-slate-600">{tr("reason")}<input aria-label={tr("reason")} placeholder={tr("reasonPlaceholder")} value={form.reason} onChange={(event) => setForm({ ...form, reason: event.target.value })} className="mt-1 block h-8 w-full rounded border px-2" /></label>
          <div className="flex items-end gap-2"><button type="button" disabled={busy} onClick={() => void submit()} className="h-8 rounded-lg bg-blue-600 px-3 text-xs font-semibold text-white disabled:opacity-50">{tr("save")}</button><button type="button" onClick={() => setForm(null)} className="h-8 rounded-lg border px-3 text-xs">{tr("cancel")}</button></div>
        </div>
      )}
      <div className="mt-3">
        <h4 className="text-xs font-semibold">{tr("history")}</h4>
        {po.promiseRevisions.length ? (
          <ul className="mt-1 space-y-1 text-[11px] text-slate-600" data-testid="po-promise-history">
            {po.promiseRevisions.map((revision) => (
              <li key={revision.id}>{when(revision.createdAt)} · {po.lines.find((line) => line.id === revision.purchaseOrderLineId)?.sku || revision.purchaseOrderLineId}: {day(revision.previousDate)} → {day(revision.newDate)} · {revision.reason}</li>
            ))}
          </ul>
        ) : <p className="mt-1 text-[11px] text-slate-500">{tr("noHistory")}</p>}
      </div>
    </section>
  );
}
