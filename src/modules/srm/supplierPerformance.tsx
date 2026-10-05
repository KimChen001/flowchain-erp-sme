import { Fragment, useEffect, useMemo, useState } from "react";
import { Info, RefreshCw } from "lucide-react";
import { useSearchParams } from "react-router";
import { A, Card } from "../../components/ui";
import { EntityLink } from "../../components/business/EntityLink";
import { ApiError, apiJson } from "../../lib/api-client";
import { useI18n } from "../../i18n/I18n";
import { ReportDateInput } from "../reports/ReportDateInput";

// Supplier delivery performance, measured against each PO line's original
// promised date (server/domain/supplier-scorecard.mjs). Shown on the supplier
// detail page and in Reports › Supplier analytics.

type Interval = { low: number; high: number } | null;
type LineRate = { count: number; of: number; rate: number | null; interval: Interval };
type MoneyByCurrency = Array<{ currency: string | null; amount: number }>;
export type ScorecardLine = {
  purchaseOrderId: string; purchaseOrderLineId: string; sku: string; itemName: string; unit: string;
  orderedQuantity: number; receivedQuantity: number; rejectedQuantity: number; acceptedByPromise?: number;
  originalPromisedDate: string | null; currentPromisedDate: string | null; revised: boolean;
  firstReceiptDay: string | null; fullDay: string | null; closed: boolean; acceptedQuantity: number; receipts: Array<{ receivingDocumentId: string; day: string; accepted: number; rejected: number }>;
  onTime?: boolean; onTimeCurrent?: boolean; early?: boolean; inFull?: boolean | null; inFullPending?: boolean; otif?: boolean | null; otifCurrent?: boolean; daysLate?: number; overdueUndelivered?: boolean;
  currency: string | null; amount: number | null;
};
type ScorecardInvoice = { supplierInvoiceId: string; invoiceNumber: string; invoiceDate: string; purchaseOrderId: string | null; currency: string | null; varianceAmount: number | null };
export type SupplierScorecardRow = {
  supplierId: string; supplierName: string; sampleSize: number; sampleStatus: "ok" | "insufficient_sample" | "no_lines";
  inFullPendingCount: number; overdueUndeliveredCount?: number; originalNotRecordedCount: number; revisedCount: number;
  metrics: {
    onTime: LineRate; onTimeCurrent: LineRate; early: LineRate; inFull: LineRate; otif: LineRate; otifCurrent: LineRate;
    rejection: { rejectedQuantity: number; receivedQuantity: number; unit: string | null; mixedUnits: boolean; rate: number | null; interval: Interval };
    averageDelayDays: { value: number | null; lateCount: number };
    priceVariances: { count: number | null; visible: boolean; amounts: MoneyByCurrency };
  };
  orderedValue: MoneyByCurrency; lines: ScorecardLine[]; pendingLines: ScorecardLine[]; originalNotRecordedLines: ScorecardLine[]; invoices: ScorecardInvoice[];
};
export type SupplierScorecard = { version: string; asOf: string; timeZone: string; period: { from: string; to: string }; rules: { graceDays: number; earlyDays: number; minimumSample: number }; limitations: string[]; suppliers: SupplierScorecardRow[] };

// English source copy with its Chinese translation.
const COPY: Record<string, [string, string]> = {
  performance: ["Performance", "绩效"],
  details: ["Details", "资料"],
  title: ["Supplier performance", "供应商绩效"],
  subtitle: ["Delivery measured against the date each PO line was first promised.", "按每个采购订单行最初承诺的交期衡量交付表现。"],
  from: ["From", "开始日期"], to: ["To", "结束日期"], graceDays: ["Grace days", "宽限天数"],
  last30: ["Last 30 days", "最近 30 天"], last90: ["Last 90 days", "最近 90 天"], last180: ["Last 180 days", "最近 180 天"], last365: ["Last 12 months", "最近 12 个月"],
  refresh: ["Refresh", "刷新"], loading: ["Loading supplier performance…", "正在加载供应商绩效…"],
  loadFailed: ["Could not load supplier performance.", "无法加载供应商绩效。"], retry: ["Retry", "重试"],
  periodInvalid: ["Enter the period as calendar dates, starting on or before its end.", "请按日历日期输入统计期，开始日期不得晚于结束日期。"],
  periodTooLong: ["The period can cover at most {n} days. Choose a shorter range.", "统计期最多 {n} 天，请选择更短的范围。"],
  graceInvalid: ["Grace days must be a whole number from 0 to {n}.", "宽限天数必须是 0 到 {n} 之间的整数。"],
  supplier: ["Supplier", "供应商"], lines: ["Lines", "行数"],
  onTime: ["On time", "准时率"], onTimeOriginal: ["On time vs original promise", "按原始承诺准时率"], onTimeCurrent: ["vs current date", "按当前日期"], onTimeCurrentFull: ["On time vs current date", "按当前日期准时率"],
  overdueCount: ["{n} overdue, nothing received", "{n} 行逾期未到货"],
  inFull: ["In full", "足量率"], otif: ["OTIF", "OTIF"], otifOriginal: ["OTIF vs original promise", "按原始承诺 OTIF"], otifCurrentFull: ["OTIF vs current date", "按当前日期 OTIF"], pendingCount: ["{n} not in full yet", "{n} 行尚未足量"], pendingLines: ["Not in full yet", "尚未足量"], early: ["Early", "过早到货"], rejection: ["Rejection rate", "拒收率"],
  averageDelay: ["Average delay", "平均延迟"], priceVariances: ["Price variances", "价格差异"],
  insufficient: ["Insufficient sample", "样本不足"], noLines: ["No received lines with an original promise in this period", "本期没有带原始承诺交期的已收货订单行"],
  linesCount: ["{n} lines", "{n} 行"], days: ["{n} days", "{n} 天"], lateLines: ["{n} late", "迟到 {n} 行"],
  interval: ["95% range {low}–{high}", "95% 区间 {low}–{high}"],
  hidden: ["Hidden", "无权查看"], mixedUnits: ["Mixed units", "单位不同"],
  notRecorded: ["{n} received lines have no original promise recorded and are not counted.", "有 {n} 个已收货订单行没有记录原始承诺交期，未计入统计。"],
  pending: ["{n} lines are still open with a shortfall: not in full yet, and left out of the in-full rate until they are fully received or closed.", "有 {n} 个订单行仍未收齐且未关闭：尚未足量，在收齐或关闭前不计入足量率。"],
  revisedNote: ["{n} lines had their promised date revised after the PO was issued.", "有 {n} 个订单行在下达后修改过承诺交期。"],
  hiddenInvoices: ["Price variances are hidden: you cannot view supplier invoices.", "价格差异已隐藏：你没有查看供应商发票的权限。"],
  warehouseScoped: ["Only receipts in your warehouses are counted.", "仅统计你有权限的仓库的收货。"],
  definitionTitle: ["How these figures are calculated", "指标口径"],
  definition: [
    "Each figure counts PO lines whose original promised date falls in the period and that have a posted receipt or are overdue. A line with nothing received past its original promised date plus the grace days is overdue: late, not OTIF, and not in full yet; a line not yet due with nothing received is left out. On time: the line's first receipt arrived by the original promised date plus the grace days. A first receipt more than 3 days early counts as early, not as a failure. In full: the accepted quantity eventually reached the ordered quantity. A line still open with a shortfall is not in full yet; it is listed as pending and left out of the in-full rate until it is fully received or closed. OTIF: the accepted quantity reached the ordered quantity by the original promised date plus the grace days; a line still short inside that window is undecided and left out of the OTIF rate. Rejection rate: rejected ÷ received quantity; it is not shown when the lines use different units. Average delay: mean days from the original promised date to the first receipt, or to today for an overdue line, over the late lines. Price variances: supplier invoices dated in the period with a price variance. \"vs current date\" repeats on time and OTIF against the current expected date, with the same grace days; a line not yet due against its current date counts as on time against it. The current date moves when a supplier revises, so the gap shows how much the revisions hide. Fewer than 5 lines is an insufficient sample. Ranges are Wilson 95% intervals.",
    "统计单位是原始承诺交期在统计期内、已过账收货或已逾期的采购订单行。超过原始承诺交期加宽限天数仍未收货的订单行为逾期：记为迟到、非 OTIF，并列为尚未足量；尚未到期且未收货的订单行不计入。准时：该行第一次收货在原始承诺交期加宽限天数之内到货；第一次收货提前超过 3 天记为过早到货，不算违约。足量：累计合格收货最终达到订购数量；仍未收齐且未关闭的订单行记为尚未足量，列为待定，在收齐或关闭前不计入足量率。OTIF：截至原始承诺交期加宽限天数，累计合格收货已达到订购数量；仍在该期限内且尚未收齐的订单行暂不判定，不计入 OTIF。拒收率：拒收数量 ÷ 收货数量；各行单位不同时不显示。平均延迟：迟到行从原始承诺交期到第一次收货（逾期未收货的行算到今天）的平均天数。价格差异：统计期内开具且存在价格差异的供应商发票张数。“按当前日期”用当前预计交期和相同宽限天数重复准时和 OTIF 判断；按当前日期尚未到期的订单行视为准时。供应商改期时当前日期会随之变化，两者的差距就是改期掩盖的延迟。少于 5 行为样本不足。区间为 Wilson 95% 置信区间。",
  ],
  drilldown: ["Lines behind {metric}", "{metric} 对应的订单行"], allLines: ["All lines", "全部订单行"], close: ["Close", "关闭"],
  po: ["PO", "采购订单"], sku: ["SKU", "SKU"], original: ["Original promise", "原始承诺交期"], current: ["Current date", "当前交期"],
  arrived: ["First receipt", "首次到货"], fullOn: ["In full on", "足量日期"], otifShort: ["OTIF", "OTIF"], received: ["Received", "收货"], rejected: ["Rejected", "拒收"], lateBy: ["Days late", "迟到天数"],
  result: ["Result", "结果"], resultOnTime: ["On time", "准时"], resultLate: ["Late", "迟到"], resultEarly: ["Early", "过早"],
  inFullYes: ["In full", "足量"], inFullNo: ["Short", "不足量"], inFullNotYet: ["Not in full yet", "尚未足量"], yes: ["Yes", "是"], no: ["No", "否"], revised: ["Revised", "已改期"], amount: ["Amount", "金额"],
  invoice: ["Invoice", "发票"], invoiceDate: ["Invoice date", "发票日期"], variance: ["Variance", "差异金额"],
  noDrilldown: ["No lines for this figure.", "该指标没有对应的订单行。"],
  noSuppliers: ["No supplier deliveries in this period.", "本期没有供应商交付记录。"],
  view: ["View lines", "查看订单行"],
};

function useCopy() {
  const { language } = useI18n();
  return (key: string, values: Record<string, string | number> = {}) => {
    const entry = COPY[key];
    const template = entry ? entry[language === "en-US" ? 0 : 1] : key;
    return Object.entries(values).reduce((result, [name, value]) => result.replace(`{${name}}`, String(value)), template);
  };
}

function useFormat() {
  const { locale } = useI18n();
  return useMemo(() => {
    const percent = new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 1, minimumFractionDigits: 0 });
    const number = new Intl.NumberFormat(locale, { maximumFractionDigits: 2 });
    const date = new Intl.DateTimeFormat(locale, { timeZone: "UTC", year: "numeric", month: "short", day: "numeric" });
    return {
      percent: (value: number | null) => (value === null ? "—" : percent.format(value)),
      number: (value: number | null | undefined) => (value === null || value === undefined ? "—" : number.format(value)),
      day: (value: string | null) => (value ? date.format(new Date(`${value}T12:00:00Z`)) : "—"),
      // Money stays in its document currency; with no currency, a plain number.
      money: (amount: number | null, currency: string | null) => {
        if (amount === null) return "—";
        if (!currency || !/^[A-Z]{3}$/.test(currency)) return number.format(amount);
        return new Intl.NumberFormat(locale, { style: "currency", currency }).format(amount);
      },
    };
  }, [locale]);
}

const isoDay = (date: Date) => date.toISOString().slice(0, 10);
const shiftDay = (day: string, days: number) => isoDay(new Date(Date.parse(`${day}T12:00:00Z`) + days * 86_400_000));
const PRESETS = [["last30", 30], ["last90", 90], ["last180", 180], ["last365", 365]] as const;

// The scorecard's own error codes, in the reader's language; any other error
// keeps the server's message.
const SCORECARD_ERRORS: Record<string, string> = { SCORECARD_PERIOD_INVALID: "periodInvalid", SCORECARD_PERIOD_TOO_LONG: "periodTooLong", SCORECARD_GRACE_DAYS_INVALID: "graceInvalid" };
type ScorecardFailure = { key: string; n: string } | { message: string };
function scorecardFailure(reason: unknown): ScorecardFailure {
  if (reason instanceof ApiError && reason.code && SCORECARD_ERRORS[reason.code]) return { key: SCORECARD_ERRORS[reason.code], n: String(reason.details.find((item) => item.maxDays !== undefined)?.maxDays ?? "") };
  return { message: reason instanceof Error ? reason.message : "" };
}
function ScorecardError({ failure, onRetry }: { failure: ScorecardFailure; onRetry: () => void }) {
  const tr = useCopy();
  return <>{tr("loadFailed")} {"key" in failure ? tr(failure.key, { n: failure.n }) : failure.message} <button type="button" className="ml-2 underline" onClick={onRetry}>{tr("retry")}</button></>;
}

export function useSupplierScorecard(query: { supplierId?: string; from: string; to: string; graceDays: number }) {
  const [data, setData] = useState<SupplierScorecard | null>(null);
  const [error, setError] = useState<ScorecardFailure | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let alive = true;
    const params = new URLSearchParams();
    if (query.supplierId) params.set("supplierId", query.supplierId);
    if (query.from) params.set("from", query.from);
    if (query.to) params.set("to", query.to);
    params.set("graceDays", String(query.graceDays));
    setLoading(true);
    setError(null);
    apiJson<SupplierScorecard>(`/api/reports/supplier-scorecard?${params}`)
      .then((value) => { if (alive) setData(value); })
      .catch((reason) => { if (alive) setError(scorecardFailure(reason)); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [query.supplierId, query.from, query.to, query.graceDays, tick]);
  return { data, error, loading, reload: () => setTick((value) => value + 1) };
}

// Period filter: presets plus explicit dates. An empty period means the
// server's default, the 90 days ending today in the workspace timezone.
function PeriodFilter({ from, to, graceDays, asOf, onChange, onReload }: { from: string; to: string; graceDays: number; asOf?: string; onChange: (next: { from: string; to: string; graceDays: number }) => void; onReload: () => void }) {
  const tr = useCopy();
  const { language } = useI18n();
  const today = asOf || isoDay(new Date());
  return (
    <div className="flex flex-wrap items-end gap-2" data-testid="supplier-performance-period">
      <div className="flex flex-wrap gap-1">
        {PRESETS.map(([key, days]) => (
          <button key={key} type="button" onClick={() => onChange({ from: shiftDay(to || today, -(days - 1)), to: to || today, graceDays })} className="h-8 rounded-lg px-2.5 text-xs font-medium" style={{ background: A.gray6, color: A.blue }}>{tr(key)}</button>
        ))}
      </div>
      {(["from", "to"] as const).map((field) => (
        <label key={field} className="w-32 text-[11px] font-medium" style={{ color: A.gray1 }}>
          {tr(field)}
          <ReportDateInput label={tr(field)} value={field === "from" ? from : to} language={language} onChange={(value) => onChange({ from: field === "from" ? value : from, to: field === "to" ? value : to, graceDays })} />
        </label>
      ))}
      <label className="text-[11px] font-medium" style={{ color: A.gray1 }}>
        {tr("graceDays")}
        <select aria-label={tr("graceDays")} value={graceDays} onChange={(event) => onChange({ from, to, graceDays: Number(event.target.value) })} className="mt-1 block h-8 rounded-lg bg-slate-50 px-2 text-xs">
          {[0, 1, 2, 3, 5, 7].map((value) => <option key={value} value={value}>{value}</option>)}
        </select>
      </label>
      <button type="button" onClick={onReload} className="h-8 rounded-lg px-2.5 text-xs" style={{ background: A.gray6, color: A.blue }}><RefreshCw size={12} className="mr-1 inline" />{tr("refresh")}</button>
    </div>
  );
}

function Definition() {
  const tr = useCopy();
  const [open, setOpen] = useState(false);
  return (
    <span className="relative inline-flex">
      <button type="button" aria-label={tr("definitionTitle")} aria-expanded={open} data-testid="supplier-performance-definition-toggle" onClick={() => setOpen((value) => !value)} onBlur={() => setOpen(false)} className="rounded p-1 hover:bg-slate-100" title={tr("definitionTitle")}>
        <Info size={14} color={A.blue} />
      </button>
      {open && (
        <span role="tooltip" data-testid="supplier-performance-definition" className="absolute left-0 top-7 z-20 w-[min(28rem,80vw)] rounded-lg border bg-white p-3 text-left text-[11px] leading-5 shadow-lg" style={{ color: A.label, borderColor: A.border }}>
          <span className="mb-1 block font-semibold">{tr("definitionTitle")}</span>
          {tr("definition")}
        </span>
      )}
    </span>
  );
}

type MetricKey = "onTime" | "onTimeCurrent" | "early" | "inFull" | "pending" | "otif" | "otifCurrent" | "rejection" | "averageDelay" | "priceVariances" | "all";
const LINE_FILTERS: Record<Exclude<MetricKey, "priceVariances">, (line: ScorecardLine) => boolean> = {
  all: () => true,
  onTime: (line) => Boolean(line.onTime),
  onTimeCurrent: (line) => Boolean(line.onTimeCurrent),
  early: (line) => Boolean(line.early),
  inFull: (line) => line.inFull === true,
  pending: (line) => Boolean(line.inFullPending),
  otif: (line) => Boolean(line.otif),
  otifCurrent: (line) => Boolean(line.otifCurrent),
  rejection: (line) => line.rejectedQuantity > 0,
  averageDelay: (line) => line.onTime === false,
};

function rateText(metric: LineRate | { rate: number | null }, sampleStatus: string, format: ReturnType<typeof useFormat>, tr: ReturnType<typeof useCopy>) {
  if (sampleStatus !== "ok" || metric.rate === null) return tr("insufficient");
  return format.percent(metric.rate);
}

function Tile({ label, value, detail, onClick, testId }: { label: string; value: string; detail?: string; onClick: () => void; testId: string }) {
  return (
    <button type="button" onClick={onClick} data-testid={testId} className="rounded-lg p-3 text-left hover:bg-slate-100" style={{ background: A.gray6 }}>
      <div className="text-[11px]" style={{ color: A.sub }}>{label}</div>
      <div className="mt-1 text-lg font-semibold tabular-nums" style={{ color: A.label }}>{value}</div>
      {detail && <div className="mt-0.5 text-[11px] tabular-nums" style={{ color: A.gray1 }}>{detail}</div>}
    </button>
  );
}

// The lines (or invoices) behind one figure.
function Drilldown({ row, metric, onClose }: { row: SupplierScorecardRow; metric: MetricKey; onClose: () => void }) {
  const tr = useCopy();
  const format = useFormat();
  const labels: Record<MetricKey, string> = { all: tr("allLines"), onTime: tr("onTimeOriginal"), onTimeCurrent: tr("onTimeCurrentFull"), early: tr("early"), inFull: tr("inFull"), pending: tr("pendingLines"), otif: tr("otifOriginal"), otifCurrent: tr("otifCurrentFull"), rejection: tr("rejection"), averageDelay: tr("averageDelay"), priceVariances: tr("priceVariances") };
  const heading = metric === "all" ? labels.all : tr("drilldown", { metric: labels[metric] });
  if (metric === "priceVariances") {
    return (
      <div className="mt-3 rounded-lg border p-3" style={{ borderColor: A.border }} data-testid="supplier-performance-drilldown">
        <div className="flex items-center justify-between"><h3 className="text-xs font-semibold">{heading}</h3><button type="button" onClick={onClose} className="text-xs" style={{ color: A.blue }}>{tr("close")}</button></div>
        {row.invoices.length ? (
          <div className="mt-2 overflow-x-auto"><table className="w-full min-w-[520px] text-xs"><thead><tr>{[tr("invoice"), tr("invoiceDate"), tr("po"), tr("variance")].map((header) => <th key={header} className="p-2 text-left" style={{ color: A.gray1 }}>{header}</th>)}</tr></thead>
            <tbody>{row.invoices.map((invoice) => (
              <tr key={invoice.supplierInvoiceId} className="border-t">
                <td className="p-2"><EntityLink kind="supplier_invoice" id={invoice.supplierInvoiceId}>{invoice.invoiceNumber}</EntityLink></td>
                <td className="p-2">{format.day(invoice.invoiceDate)}</td>
                <td className="p-2">{invoice.purchaseOrderId ? <EntityLink kind="purchase_order" id={invoice.purchaseOrderId} /> : "—"}</td>
                <td className="p-2 tabular-nums">{format.money(invoice.varianceAmount, invoice.currency)}</td>
              </tr>
            ))}</tbody></table></div>
        ) : <p className="mt-2 text-xs" style={{ color: A.sub }}>{tr("noDrilldown")}</p>}
      </div>
    );
  }
  const lines = row.lines.filter(LINE_FILTERS[metric]);
  const result = (line: ScorecardLine) => line.onTime ? (line.early ? tr("resultEarly") : tr("resultOnTime")) : tr("resultLate");
  const inFullText = (line: ScorecardLine) => line.inFullPending ? tr("inFullNotYet") : line.inFull ? tr("inFullYes") : tr("inFullNo");
  return (
    <div className="mt-3 rounded-lg border p-3" style={{ borderColor: A.border }} data-testid="supplier-performance-drilldown">
      <div className="flex items-center justify-between"><h3 className="text-xs font-semibold">{heading}</h3><button type="button" onClick={onClose} className="text-xs" style={{ color: A.blue }}>{tr("close")}</button></div>
      {lines.length ? (
        <div className="mt-2 overflow-x-auto"><table className="w-full min-w-[860px] text-xs"><thead><tr>{[tr("po"), tr("sku"), tr("original"), tr("current"), tr("arrived"), tr("lateBy"), tr("result"), tr("received"), tr("rejected"), tr("fullOn"), tr("inFull"), tr("otifShort"), tr("amount")].map((header) => <th key={header} className="p-2 text-left" style={{ color: A.gray1 }}>{header}</th>)}</tr></thead>
          <tbody>{lines.map((line) => (
            <tr key={line.purchaseOrderLineId} className="border-t" data-testid={`supplier-performance-line-${line.purchaseOrderLineId}`}>
              <td className="p-2"><EntityLink kind="purchase_order" id={line.purchaseOrderId} /></td>
              <td className="p-2">{line.sku}{line.itemName ? ` · ${line.itemName}` : ""}</td>
              <td className="p-2">{format.day(line.originalPromisedDate)}</td>
              <td className="p-2">{format.day(line.currentPromisedDate)}{line.revised && <span className="ml-1 rounded bg-amber-50 px-1 text-[11px] text-amber-700">{tr("revised")}</span>}</td>
              <td className="p-2">{format.day(line.firstReceiptDay)}</td>
              <td className="p-2 tabular-nums">{line.daysLate ? format.number(line.daysLate) : "—"}</td>
              <td className="p-2">{result(line)}</td>
              <td className="p-2 tabular-nums">{format.number(line.acceptedQuantity)} / {format.number(line.orderedQuantity)} {line.unit}</td>
              <td className="p-2 tabular-nums">{format.number(line.rejectedQuantity)}</td>
              <td className="p-2">{format.day(line.fullDay)}</td>
              <td className="p-2">{inFullText(line)}</td>
              <td className="p-2">{line.otif === null || line.otif === undefined ? "—" : line.otif ? tr("yes") : tr("no")}</td>
              <td className="p-2 tabular-nums">{format.money(line.amount, line.currency)}</td>
            </tr>
          ))}</tbody></table></div>
      ) : <p className="mt-2 text-xs" style={{ color: A.sub }}>{tr("noDrilldown")}</p>}
    </div>
  );
}

function intervalText(interval: Interval, sampleStatus: string, format: ReturnType<typeof useFormat>, tr: ReturnType<typeof useCopy>) {
  return sampleStatus === "ok" && interval ? tr("interval", { low: format.percent(interval.low), high: format.percent(interval.high) }) : undefined;
}

function Notes({ row, limitations }: { row: SupplierScorecardRow; limitations: string[] }) {
  const tr = useCopy();
  const notes = [
    row.revisedCount ? tr("revisedNote", { n: row.revisedCount }) : "",
    row.originalNotRecordedCount ? tr("notRecorded", { n: row.originalNotRecordedCount }) : "",
    row.inFullPendingCount ? tr("pending", { n: row.inFullPendingCount }) : "",
    limitations.includes("price_variances_hidden_by_permission") ? tr("hiddenInvoices") : "",
    limitations.includes("receipts_limited_to_your_warehouses") ? tr("warehouseScoped") : "",
  ].filter(Boolean);
  if (!notes.length) return null;
  return <ul className="mt-3 list-disc space-y-0.5 pl-4 text-[11px]" style={{ color: A.sub }}>{notes.map((note) => <li key={note}>{note}</li>)}</ul>;
}

// One supplier's figures as tiles; each tile opens the lines behind it.
function SupplierFigures({ row, limitations }: { row: SupplierScorecardRow; limitations: string[] }) {
  const tr = useCopy();
  const format = useFormat();
  const [metric, setMetric] = useState<MetricKey | null>(null);
  const m = row.metrics;
  if (row.sampleStatus === "no_lines") return <><p className="py-6 text-center text-xs" style={{ color: A.sub }}>{tr("noLines")}</p><Notes row={row} limitations={limitations} /></>;
  const status = row.sampleStatus;
  const rejectionValue = status !== "ok" ? tr("insufficient") : m.rejection.mixedUnits ? tr("mixedUnits") : format.percent(m.rejection.rate);
  return (
    <div>
      {status === "insufficient_sample" && <div className="mb-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800" data-testid="supplier-performance-insufficient">{tr("insufficient")} · {tr("linesCount", { n: row.sampleSize })}</div>}
      <div className="grid grid-cols-2 gap-2 md:grid-cols-4" data-testid="supplier-performance-figures">
        <Tile testId="supplier-performance-on-time" label={`${tr("onTimeOriginal")} · ${tr("onTimeCurrent")}`} value={status === "ok" ? `${format.percent(m.onTime.rate)} · ${format.percent(m.onTimeCurrent.rate)}` : tr("insufficient")} detail={[`${m.onTime.count}/${m.onTime.of} · ${m.onTimeCurrent.count}/${m.onTimeCurrent.of}`, row.overdueUndeliveredCount ? tr("overdueCount", { n: row.overdueUndeliveredCount }) : ""].filter(Boolean).join(" · ")} onClick={() => setMetric("onTime")} />
        <Tile testId="supplier-performance-in-full" label={tr("inFull")} value={rateText(m.inFull, status, format, tr)} detail={[`${m.inFull.count}/${m.inFull.of}`, row.inFullPendingCount ? tr("pendingCount", { n: row.inFullPendingCount }) : ""].filter(Boolean).join(" · ")} onClick={() => setMetric(row.inFullPendingCount ? "pending" : "inFull")} />
        <Tile testId="supplier-performance-otif" label={`${tr("otifOriginal")} · ${tr("onTimeCurrent")}`} value={status === "ok" ? `${format.percent(m.otif.rate)} · ${format.percent(m.otifCurrent.rate)}` : tr("insufficient")} detail={`${m.otif.count}/${m.otif.of} · ${m.otifCurrent.count}/${m.otifCurrent.of}`} onClick={() => setMetric("otif")} />
        <Tile testId="supplier-performance-early" label={tr("early")} value={rateText(m.early, status, format, tr)} detail={`${m.early.count}/${m.early.of}`} onClick={() => setMetric("early")} />
        <Tile testId="supplier-performance-rejection" label={tr("rejection")} value={rejectionValue} detail={m.rejection.mixedUnits ? undefined : `${format.number(m.rejection.rejectedQuantity)} / ${format.number(m.rejection.receivedQuantity)}${m.rejection.unit ? ` ${m.rejection.unit}` : ""}`} onClick={() => setMetric("rejection")} />
        <Tile testId="supplier-performance-delay" label={tr("averageDelay")} value={m.averageDelayDays.value === null ? "—" : tr("days", { n: format.number(m.averageDelayDays.value) })} detail={tr("lateLines", { n: m.averageDelayDays.lateCount })} onClick={() => setMetric("averageDelay")} />
        <Tile testId="supplier-performance-price-variances" label={tr("priceVariances")} value={m.priceVariances.visible ? format.number(m.priceVariances.count) : tr("hidden")} detail={m.priceVariances.amounts.map((item) => format.money(item.amount, item.currency)).join(" · ") || undefined} onClick={() => setMetric("priceVariances")} />
        <Tile testId="supplier-performance-lines" label={tr("lines")} value={format.number(row.sampleSize)} detail={row.orderedValue.map((item) => format.money(item.amount, item.currency)).join(" · ") || undefined} onClick={() => setMetric("all")} />
      </div>
      {status === "ok" && <p className="mt-2 text-[11px]" style={{ color: A.gray1 }} data-testid="supplier-performance-on-time-interval">{tr("onTimeOriginal")}: {intervalText(m.onTime.interval, status, format, tr)} · {tr("onTimeCurrent")}: {intervalText(m.onTimeCurrent.interval, status, format, tr)}<br />{tr("inFull")}: {intervalText(m.inFull.interval, status, format, tr) || tr("insufficient")} · {tr("otifOriginal")}: {intervalText(m.otif.interval, status, format, tr)}</p>}
      {metric && <Drilldown row={row} metric={metric} onClose={() => setMetric(null)} />}
      <Notes row={row} limitations={limitations} />
    </div>
  );
}

function usePeriod() {
  const [period, setPeriod] = useState({ from: "", to: "", graceDays: 0 });
  return [period, setPeriod] as const;
}

type Period = { from: string; to: string; graceDays: number };

// On Reports › Supplier analytics the period and grace days live in the page
// URL, shared with the supplier dashboard below the table, so the table and
// the dashboard's on-time figures always measure the same lines. Without
// dates both use the scorecard's default, the last 90 days.
function useUrlPeriod() {
  const [params, setParams] = useSearchParams();
  const grace = Number(params.get("graceDays") || 0);
  const period: Period = { from: params.get("from") || "", to: params.get("to") || "", graceDays: Number.isInteger(grace) && grace >= 0 ? grace : 0 };
  const setPeriod = (next: Period) => {
    const updated = new URLSearchParams(params);
    const values: Array<[string, string]> = [["from", next.from], ["to", next.to], ["graceDays", next.graceDays ? String(next.graceDays) : ""]];
    for (const [key, value] of values) {
      if (value) updated.set(key, value);
      else updated.delete(key);
    }
    setParams(updated, { replace: true });
  };
  return [period, setPeriod] as const;
}

// The Performance tab of the supplier detail page.
export function SupplierPerformancePanel({ supplierId }: { supplierId: string }) {
  const tr = useCopy();
  const [period, setPeriod] = usePeriod();
  const { data, error, loading, reload } = useSupplierScorecard({ supplierId, ...period });
  const row = data?.suppliers.find((item) => item.supplierId === supplierId);
  return (
    <Card className="p-5" data-testid="supplier-performance-panel">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-1 text-sm font-semibold">{tr("title")}<Definition /></h2>
          <p className="mt-1 text-xs" style={{ color: A.sub }}>{tr("subtitle")}</p>
          {data && <p className="mt-1 text-[11px]" style={{ color: A.gray1 }} data-testid="supplier-performance-scope">{data.period.from} — {data.period.to} · {tr("graceDays")}: {data.rules.graceDays}</p>}
        </div>
        <PeriodFilter from={period.from || data?.period.from || ""} to={period.to || data?.period.to || ""} graceDays={period.graceDays} asOf={data?.asOf} onChange={setPeriod} onReload={reload} />
      </div>
      <div className="mt-4">
        {loading ? <p className="py-6 text-center text-xs" style={{ color: A.sub }}>{tr("loading")}</p>
          : error ? <div role="alert" className="rounded-lg bg-red-50 p-3 text-xs text-red-800"><ScorecardError failure={error} onRetry={reload} /></div>
          : row ? <SupplierFigures row={row} limitations={data?.limitations || []} />
          : <p className="py-6 text-center text-xs" style={{ color: A.sub }}>{tr("noLines")}</p>}
      </div>
    </Card>
  );
}

// Reports › Supplier analytics: one row per supplier.
export function SupplierPerformanceTable() {
  const tr = useCopy();
  const format = useFormat();
  const [period, setPeriod] = useUrlPeriod();
  const { data, error, loading, reload } = useSupplierScorecard(period);
  const [open, setOpen] = useState<string | null>(null);
  const cell = (row: SupplierScorecardRow, value: string) => (row.sampleStatus === "ok" ? value : tr("insufficient"));
  return (
    <Card className="p-4" data-testid="supplier-performance-table">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-1 text-sm font-semibold">{tr("title")}<Definition /></h2>
          <p className="mt-1 text-xs" style={{ color: A.sub }}>{tr("subtitle")}</p>
          {data && <p className="mt-1 text-[11px]" style={{ color: A.gray1 }}>{data.period.from} — {data.period.to} · {tr("graceDays")}: {data.rules.graceDays}</p>}
        </div>
        <PeriodFilter from={period.from || data?.period.from || ""} to={period.to || data?.period.to || ""} graceDays={period.graceDays} asOf={data?.asOf} onChange={setPeriod} onReload={reload} />
      </div>
      {loading ? <p className="py-6 text-center text-xs" style={{ color: A.sub }}>{tr("loading")}</p>
        : error ? <div role="alert" className="mt-3 rounded-lg bg-red-50 p-3 text-xs text-red-800"><ScorecardError failure={error} onRetry={reload} /></div>
        : !data?.suppliers.length ? <p className="py-6 text-center text-xs" style={{ color: A.sub }}>{tr("noSuppliers")}</p>
        : (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[980px] text-xs">
              <thead><tr>{[tr("supplier"), tr("lines"), tr("onTimeOriginal"), tr("onTimeCurrentFull"), tr("inFull"), tr("otifOriginal"), tr("otifCurrentFull"), tr("early"), tr("rejection"), tr("averageDelay"), tr("priceVariances"), ""].map((header, index) => <th key={`${header}-${index}`} className="p-2 text-left" style={{ color: A.gray1 }}>{header}</th>)}</tr></thead>
              <tbody>
                {data.suppliers.map((row) => (
                  <Fragment key={row.supplierId}>
                    <tr className="border-t" data-testid={`supplier-performance-row-${row.supplierId}`}>
                      <td className="p-2"><EntityLink kind="supplier" id={row.supplierId}>{row.supplierName}</EntityLink></td>
                      <td className="p-2 tabular-nums">{row.sampleSize}</td>
                      <td className="p-2 tabular-nums">{cell(row, format.percent(row.metrics.onTime.rate))}</td>
                      <td className="p-2 tabular-nums">{cell(row, format.percent(row.metrics.onTimeCurrent.rate))}</td>
                      <td className="p-2 tabular-nums">{row.sampleStatus === "ok" && row.metrics.inFull.rate !== null ? format.percent(row.metrics.inFull.rate) : tr("insufficient")}</td>
                      <td className="p-2 tabular-nums">{cell(row, format.percent(row.metrics.otif.rate))}</td>
                      <td className="p-2 tabular-nums">{cell(row, format.percent(row.metrics.otifCurrent.rate))}</td>
                      <td className="p-2 tabular-nums">{cell(row, format.percent(row.metrics.early.rate))}</td>
                      <td className="p-2 tabular-nums">{cell(row, row.metrics.rejection.mixedUnits ? tr("mixedUnits") : format.percent(row.metrics.rejection.rate))}</td>
                      <td className="p-2 tabular-nums">{row.metrics.averageDelayDays.value === null ? "—" : tr("days", { n: format.number(row.metrics.averageDelayDays.value) })}</td>
                      <td className="p-2 tabular-nums">{row.metrics.priceVariances.visible ? format.number(row.metrics.priceVariances.count) : tr("hidden")}</td>
                      <td className="p-2"><button type="button" onClick={() => setOpen(open === row.supplierId ? null : row.supplierId)} style={{ color: A.blue }} aria-expanded={open === row.supplierId}>{tr("view")}</button></td>
                    </tr>
                    {open === row.supplierId && <tr><td colSpan={12} className="p-2"><SupplierFigures row={row} limitations={data.limitations} /></td></tr>}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}
    </Card>
  );
}

export function supplierPerformanceTabLabel(language: string, tab: "details" | "performance") {
  return COPY[tab][language === "en-US" ? 0 : 1];
}
