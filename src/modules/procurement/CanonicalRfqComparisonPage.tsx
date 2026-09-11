import { useCallback, useEffect, useState } from "react";
import { ArrowLeft, CheckCircle2, CircleAlert, RefreshCw, Scale, ShieldCheck, TriangleAlert } from "lucide-react";
import { Link } from "react-router";
import { A, Card, Chip } from "../../components/ui";
import { ApiError } from "../../lib/api-client";
import { procurementApi } from "./procurementApi";
import { useI18n } from "../../i18n/I18n";
import type {
  RfqAwardDecision,
  RfqComparisonEligibility,
  RfqComparisonResponse,
  RfqSupplierComparison,
} from "./procurementTypes";

type ReadState = "loading" | "loaded" | "notFound" | "unauthenticated" | "forbidden" | "invalid" | "error" | "network" | "malformed";
type Tr = (zh: string, en: string) => string;

const RFQ_STATUS_LABELS: Record<string, readonly [string, string]> = {
  draft: ["草稿", "Draft"],
  open: ["开放", "Open"],
  collecting_quotes: ["收集报价", "Collecting quotes"],
  closed: ["已关闭", "Closed"],
  cancelled: ["已取消", "Cancelled"],
};

const REVISION_STATUS_LABELS: Record<string, readonly [string, string]> = {
  draft: ["草稿", "Draft"],
  incomplete: ["信息不完整", "Incomplete"],
  submitted: ["已提交", "Submitted"],
  shortlisted: ["已入围", "Shortlisted"],
  not_selected: ["历史未中选", "Previously not selected"],
  withdrawn: ["已撤回", "Withdrawn"],
};

const PARTICIPATION_STATUS_LABELS: Record<string, readonly [string, string]> = {
  planned: ["计划参与", "Planned"],
  invited_internal: ["已内部邀请", "Invited internally"],
  response_recorded: ["已记录响应", "Response recorded"],
  declined: ["已拒绝", "Declined"],
  withdrawn: ["已撤回", "Withdrawn"],
  closed: ["已关闭", "Closed"],
};

const ELIGIBILITY_LABELS: Record<RfqComparisonEligibility, readonly [string, string]> = {
  eligible: ["可比较", "Eligible"],
  not_ready: ["尚未形成有效提交", "Not ready"],
  historical_only: ["历史报价", "Historical quotation"],
  withdrawn: ["已撤回", "Withdrawn"],
  incomplete_coverage: ["行项目覆盖不完整", "Incomplete line coverage"],
  authority_missing: ["缺少权威 Revision", "Authoritative revision missing"],
  unknown_status: ["状态无法确认", "Unknown status"],
};

const AVAILABILITY_COPY = {
  no_eligible_responses: [["暂无可比较的有效报价", "No eligible quotations to compare"], ["当前没有满足完整提交与行项目覆盖要求的报价。", "No quotation currently meets the complete submission and line coverage requirements."]],
  single_eligible_response: [["当前只有 1 个有效报价，无法进行横向比较", "Only one eligible quotation is available"], ["仍可查看该供应商的权威商业事实。", "You can still review the supplier's authoritative commercial facts."]],
  side_by_side_available: [["可进行并列比价", "Side-by-side comparison available"], ["已有多份同币种有效报价，页面仅作事实并列展示。", "Multiple eligible quotations share one currency. This page presents facts without ranking them."]],
  multi_currency_unconverted: [["多币种，未折算", "Multiple currencies, not converted"], ["报价币种不同，当前未进行汇率换算，因此总金额不能直接横向比较。", "Quotation currencies differ. Totals cannot be compared directly because no exchange-rate conversion is applied."]],
} as const;

function localLabel(labels: Record<string, readonly [string, string]>, key: string, language: string, fallback: string) {
  const label = labels[key];
  return label ? label[language === "en-US" ? 1 : 0] : fallback;
}

function failureState(error: unknown): Exclude<ReadState, "loading" | "loaded" | "malformed"> {
  if (error instanceof ApiError) {
    if (error.status === 404) return "notFound";
    if (error.status === 401) return "unauthenticated";
    if (error.status === 403) return "forbidden";
    if (error.status === 422) return "invalid";
    return "error";
  }
  return error instanceof TypeError ? "network" : "error";
}

function dateOnly(value?: string | null) {
  if (!value) return "—";
  return /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : value;
}

function date(value?: string | null) {
  if (!value) return "—";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime())
    ? value
    : parsed.toISOString().replace("T", " ").replace("Z", " UTC");
}

function exactAmount(value: string | null | undefined, currency?: string | null) {
  return value == null ? "—" : `${value}${currency ? ` ${currency}` : ""}`;
}

function eligibilityChip(eligibility: RfqComparisonEligibility, language: string) {
  const eligible = eligibility === "eligible";
  return <Chip label={localLabel(ELIGIBILITY_LABELS, eligibility, language, eligibility)} color={eligible ? A.blue : A.sub} bg={eligible ? "#eff6ff" : "#f1f5f9"} />;
}

function Availability({ comparison }: { comparison: RfqSupplierComparison }) {
  const { language } = useI18n();
  const [[titleZh, titleEn], [descriptionZh, descriptionEn]] = AVAILABILITY_COPY[comparison.comparisonAvailability];
  const title = language === "en-US" ? titleEn : titleZh;
  const description = language === "en-US" ? descriptionEn : descriptionZh;
  const multiCurrency = comparison.comparisonAvailability === "multi_currency_unconverted";
  return (
    <Card className={`p-4 ${multiCurrency ? "border-amber-300 bg-amber-50" : ""}`} data-testid="rfq-comparison-availability">
      <div className="flex items-start gap-3">
        {multiCurrency ? <TriangleAlert className="mt-0.5 text-amber-600" size={18} /> : <Scale className="mt-0.5 text-blue-600" size={18} />}
        <div>
          <h2 className="text-sm font-semibold">{title}</h2>
          <p className="mt-1 text-xs" style={{ color: A.sub }}>{description}</p>
        </div>
      </div>
    </Card>
  );
}

function ResponseSummary({ responses }: { responses: RfqComparisonResponse[] }) {
  const { language } = useI18n();
  const tr: Tr = (zh, en) => language === "en-US" ? en : zh;
  return (
    <Card className="overflow-hidden" data-testid="rfq-comparison-responses">
      <div className="border-b p-4">
        <h2 className="text-sm font-semibold">{tr("供应商响应摘要", "Supplier response summary")}</h2>
        <p className="mt-1 text-xs" style={{ color: A.sub }}>{tr("顺序来自后端 supplier ID 升序权威；未按价格排序。", "The server orders suppliers by ID. Prices do not determine display order.")}</p>
      </div>
      {responses.length === 0 ? <div className="p-8 text-center text-xs" style={{ color: A.sub }}>{tr("当前 RFQ 尚无报价记录。", "This RFQ has no quotation records.")}</div> : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1100px] text-left text-xs">
            <thead className="bg-slate-50" style={{ color: A.sub }}><tr>{[tr("供应商", "Supplier"), tr("报价 / Revision", "Quotation / revision"), tr("状态", "Status"), tr("比较资格", "Eligibility"), tr("原币总额", "Original-currency total"), tr("提交时间", "Submitted"), tr("行项目覆盖", "Line coverage")].map((label) => <th className="p-3 font-medium" key={label}>{label}</th>)}</tr></thead>
            <tbody>{responses.map((response) => {
              const revision = response.latestRevision;
              return <tr className="border-t align-top" data-testid={`rfq-comparison-response-${response.supplierId}`} key={`${response.supplierId}:${response.quotationId}`}>
                <td className="p-3"><div className="font-medium">{response.supplierName || tr("未提供名称", "Name not provided")}</div><div className="mt-1" style={{ color: A.sub }}>{response.supplierId}</div></td>
                <td className="p-3"><div>{response.quotationId}</div><div className="mt-1" style={{ color: A.sub }}>{revision ? `Revision ${revision.revisionNumber}` : tr("权威 Revision 缺失", "Authoritative revision missing")}</div></td>
                <td className="p-3">{revision?.status ? localLabel(REVISION_STATUS_LABELS, revision.status, language, revision.statusRaw || tr("未知", "Unknown")) : tr("不可用", "Unavailable")}</td>
                <td className={`p-3 ${response.comparisonEligibility === "eligible" ? "" : "bg-slate-50/70 text-slate-500"}`}>{eligibilityChip(response.comparisonEligibility, language)}{response.eligibilityReasons.length > 0 && <div className="mt-2 text-[11px]" style={{ color: A.sub }}>{response.eligibilityReasons.join(" · ")}</div>}</td>
                <td className="p-3 font-medium tabular-nums">{exactAmount(revision?.quotedAmount, revision?.currency)}</td>
                <td className="p-3">{date(revision?.submittedAt)}</td>
                <td className="p-3"><div>{response.coverage.matchedLineCount} / {response.coverage.requiredLineCount}</div><div className="mt-1" style={{ color: A.sub }}>{response.coverage.state === "complete" ? tr("完整覆盖", "Complete") : response.coverage.state === "not_applicable" ? tr("无目标行项目", "No target lines") : tr("覆盖不完整", "Incomplete")}</div></td>
              </tr>;
            })}</tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function LineMatrix({ comparison }: { comparison: RfqSupplierComparison }) {
  const { language } = useI18n();
  const tr: Tr = (zh, en) => language === "en-US" ? en : zh;
  return (
    <Card className="overflow-hidden" data-testid="rfq-comparison-line-matrix">
      <div className="border-b p-4"><h2 className="text-sm font-semibold">{tr("行项目并列展示", "Line-by-line comparison")}</h2><p className="mt-1 text-xs" style={{ color: A.sub }}>{tr("金额直接显示 API Decimal 字符串，不在浏览器重算。", "Amounts use the exact decimal values returned by the API and are not recalculated in the browser.")}</p></div>
      {comparison.lines.length === 0 ? <div className="p-8 text-center text-xs" style={{ color: A.sub }}>{tr("当前 RFQ 没有权威行项目。", "This RFQ has no authoritative line items.")}</div> : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-max text-left text-xs">
            <thead className="bg-slate-50" style={{ color: A.sub }}><tr><th className="sticky left-0 z-10 min-w-[260px] bg-slate-50 p-3 font-medium">{tr("RFQ 行项目", "RFQ line item")}</th>{comparison.responses.map((response) => <th className="min-w-[230px] p-3 font-medium" key={response.supplierId}><div>{response.supplierName || response.supplierId}</div><div className="mt-1 font-normal">{response.supplierId}</div></th>)}</tr></thead>
            <tbody>{comparison.lines.map((line) => <tr className="border-t align-top" data-testid={`rfq-comparison-line-${line.rfqLineId}`} key={line.rfqLineId}>
              <td className="sticky left-0 z-10 bg-white p-3"><div className="font-medium">{line.itemName || line.sku || line.itemId || line.rfqLineId}</div><div className="mt-1" style={{ color: A.sub }}>{line.sku || "—"} · {line.rfqLineId}</div><div className="mt-2 tabular-nums">{tr("需求", "Required")}: {line.requestedQuantity || "—"} {line.unit || ""}</div></td>
              {comparison.responses.map((response) => {
                const quotedLine = response.latestRevision?.lines.find((candidate) => candidate.rfqLineId === line.rfqLineId && candidate.lineAuthorityState === "exact_target_rfq_line");
                return <td className="p-3" data-testid={`rfq-comparison-cell-${line.rfqLineId}-${response.supplierId}`} key={response.supplierId}>{quotedLine ? <div className="space-y-1"><div>{tr("数量", "Quantity")}: <span className="tabular-nums">{quotedLine.quantity || "—"}</span> {quotedLine.unit || ""}</div><div>{tr("单价", "Unit price")}: <span className="tabular-nums">{exactAmount(quotedLine.unitPrice, response.latestRevision?.currency)}</span></div><div>{tr("行金额", "Line total")}: <span className="tabular-nums">{exactAmount(quotedLine.amount, response.latestRevision?.currency)}</span></div><div style={{ color: A.sub }}>{tr("交期", "Delivery")}: {dateOnly(quotedLine.deliveryDate || response.latestRevision?.deliveryDate)}</div></div> : <span style={{ color: A.sub }}>{tr("未覆盖", "Not covered")}</span>}</td>;
              })}
            </tr>)}</tbody>
          </table>
        </div>
      )}
      {comparison.responses.some((response) => response.latestRevision?.lines.some((line) => line.lineAuthorityState !== "exact_target_rfq_line")) && <div className="border-t p-4 text-xs" style={{ color: A.sub }}><div className="font-semibold text-slate-700">{tr("无法与 RFQ 行建立权威对应", "Lines without an authoritative RFQ match")}</div>{comparison.responses.flatMap((response) => (response.latestRevision?.lines || []).filter((line) => line.lineAuthorityState !== "exact_target_rfq_line").map((line) => <div key={`${response.supplierId}:${line.revisionLineId}`} className="mt-1">{response.supplierName || response.supplierId} · {line.revisionLineId} · {tr("未能与 RFQ 行建立权威对应", "No authoritative RFQ line match")}</div>))}</div>}
    </Card>
  );
}

function AwardDecisionPanel({ comparison, award, canAward, onAward }: { comparison: RfqSupplierComparison; award: RfqAwardDecision | null; canAward: boolean; onAward: (award: RfqAwardDecision) => void }) {
  const { language } = useI18n();
  const tr = (zh: string, en: string) => language === "en-US" ? en : zh;
  const eligible = comparison.responses.filter((response) => response.comparisonEligibility === "eligible" && response.latestRevision);
  const [supplierId, setSupplierId] = useState("");
  const [reason, setReason] = useState("");
  const [reviewed, setReviewed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const selected = eligible.find((response) => response.supplierId === supplierId);
  const awardSupplier = comparison.responses.find((response) => response.supplierId === award?.supplierId);

  if (award) return <Card className="border-emerald-200 bg-emerald-50 p-4" data-testid="rfq-award-decision"><div className="flex items-start gap-3"><CheckCircle2 className="mt-0.5 text-emerald-700" size={18} /><div><h2 className="text-sm font-semibold">{tr("正式授标决定已记录", "Formal award decision recorded")}</h2><p className="mt-1 text-xs text-slate-700">{awardSupplier?.supplierName || award.supplierId} · Revision {award.quotationRevisionNumber} · {award.quotedAmount} {award.currency}</p><p className="mt-2 text-xs text-slate-600">{award.decisionReason}</p><p className="mt-2 text-[11px] text-slate-500">{tr("不可修改的人工决定", "Immutable human decision")} · {date(award.decidedAt)}</p></div></div></Card>;

  const unavailable = comparison.rfqStatus !== "collecting_quotes" || eligible.length === 0;
  const submit = async () => {
    if (!selected?.latestRevision || !reviewed || !reason.trim()) return;
    if (!window.confirm(tr("确认记录这项不可修改的正式授标决定？", "Record this immutable formal award decision?"))) return;
    setBusy(true); setError("");
    try {
      const result = await procurementApi.createRfqAwardDecision(comparison.rfqId, {
        supplierId: selected.supplierId,
        quotationId: selected.quotationId,
        quotationRevisionId: selected.latestRevision.revisionId,
        expectedQuotationRevisionNumber: selected.latestRevision.revisionNumber,
        decisionReason: reason.trim(),
        idempotencyKey: globalThis.crypto.randomUUID(),
      });
      onAward(result);
    } catch (next) {
      setError(next instanceof Error ? next.message : tr("授标决定无法记录。", "The award decision could not be recorded."));
    } finally { setBusy(false); }
  };

  return <Card className="p-4" data-testid="rfq-award-decision"><div className="flex items-start gap-3"><ShieldCheck className="mt-0.5 text-blue-600" size={18} /><div className="min-w-0 flex-1"><h2 className="text-sm font-semibold">{tr("人工复核授标", "Reviewed award decision")}</h2><p className="mt-1 text-xs text-slate-500">{tr("选择一份符合资格的最新报价 Revision。系统不会排名、推荐供应商或自动创建采购订单。", "Select one eligible latest quotation revision. The system does not rank or recommend suppliers, and it does not create a purchase order automatically.")}</p>
    {!canAward ? <p className="mt-3 rounded-lg bg-slate-50 p-3 text-xs text-slate-600">{tr("当前角色可以查看比价，但没有记录正式授标决定的权限。", "Your role can review the comparison but cannot record a formal award decision.")}</p> : unavailable ? <p className="mt-3 rounded-lg bg-slate-50 p-3 text-xs text-slate-600">{comparison.rfqStatus !== "collecting_quotes" ? tr("只有处于收集报价状态的 RFQ 可以授标。", "An award can be recorded only while the RFQ is collecting quotes.") : tr("当前没有符合授标要求的完整报价。", "No complete eligible quotation is available for award.")}</p> : <div className="mt-4 space-y-3">
      <fieldset className="space-y-2"><legend className="text-xs font-semibold">{tr("选择供应商报价", "Select supplier quotation")}</legend>{eligible.map((response) => <label key={response.supplierId} className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3 text-xs ${supplierId === response.supplierId ? "border-blue-500 bg-blue-50" : "border-slate-200"}`}><input className="mt-0.5" type="radio" name="rfq-award-supplier" value={response.supplierId} checked={supplierId === response.supplierId} onChange={() => { setSupplierId(response.supplierId); setReviewed(false); }} /><span><strong>{response.supplierName || response.supplierId}</strong><span className="mt-1 block text-slate-600">Revision {response.latestRevision?.revisionNumber} · {exactAmount(response.latestRevision?.quotedAmount, response.latestRevision?.currency)}</span></span></label>)}</fieldset>
      <label className="block text-xs font-semibold">{tr("决定理由", "Decision reason")}<textarea rows={3} maxLength={2000} value={reason} onChange={(event) => setReason(event.target.value)} className="mt-1 w-full rounded-lg border border-slate-300 p-2 font-normal" placeholder={tr("说明价格、交期、质量或业务判断依据", "Describe the price, lead time, quality, or business basis")}/></label>
      <label className="flex items-start gap-2 text-xs"><input className="mt-0.5" type="checkbox" checked={reviewed} onChange={(event) => setReviewed(event.target.checked)} /><span>{tr("我已复核所选供应商、报价金额及确切 Revision，并理解授标记录不可修改。", "I reviewed the supplier, quoted amount, and exact revision, and understand that the award record is immutable.")}</span></label>
      {error && <p className="rounded-lg bg-rose-50 p-2 text-xs text-rose-700" role="alert">{error}</p>}
      <button type="button" data-testid="record-rfq-award" disabled={busy || !selected || !reviewed || !reason.trim()} onClick={() => void submit()} className="rounded-lg bg-blue-600 px-4 py-2 text-xs font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50">{busy ? tr("正在记录…", "Recording…") : tr("记录正式授标决定", "Record formal award decision")}</button>
    </div>}
  </div></div></Card>;
}

function LoadedComparison({ comparison, award, canAward, onAward }: { comparison: RfqSupplierComparison; award: RfqAwardDecision | null; canAward: boolean; onAward: (award: RfqAwardDecision) => void }) {
  const { language } = useI18n();
  const tr: Tr = (zh, en) => language === "en-US" ? en : zh;
  const noParticipants = comparison.participationSummary.participantCount === 0;
  const noQuotations = comparison.summary.quotationCount === 0;
  return (
    <div className="space-y-4" data-testid="canonical-rfq-comparison">
      <Card className="p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0"><div className="text-xs font-semibold uppercase tracking-wide" style={{ color: A.sub }}>{tr("只读供应商报价比较", "Supplier quotation comparison")} · {comparison.rfqId}</div><h1 className="mt-1 text-xl font-semibold">{comparison.rfqTitle || comparison.rfqId}</h1><p className="mt-2 text-xs" style={{ color: A.sub }}>{tr("本页不排名、不推荐、不授标，也不创建采购订单。", "This page does not rank or recommend suppliers. A formal award requires a separate authorized human decision and does not create a purchase order.")}</p></div>
          <div className="flex flex-wrap gap-2"><Chip label={tr("只读比较", "Read-only comparison")} color={A.blue} bg="#eff6ff" /><Chip label={localLabel(RFQ_STATUS_LABELS, comparison.rfqStatus || "", language, comparison.rfqStatusRaw || tr("状态未知", "Unknown status"))} color={A.sub} bg="#f1f5f9" /></div>
        </div>
        <dl className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {[[tr("RFQ 编号", "RFQ ID"), comparison.rfqId], [tr("RFQ 币种", "RFQ currency"), comparison.rfqCurrency || "—"], [tr("有效报价", "Eligible quotations"), String(comparison.summary.eligibleResponseCount)], [tr("权威响应", "Authoritative responses"), String(comparison.summary.authoritativeResponseCount)], [tr("参与供应商", "Participating suppliers"), String(comparison.participationSummary.participantCount)], [tr("全部报价记录", "All quotation records"), String(comparison.summary.quotationCount)], [tr("显示顺序", "Display order"), tr("供应商 ID 升序", "Supplier ID ascending")], [tr("生成时间", "Generated at"), date(comparison.generatedAt)]].map(([label, value]) => <div className="rounded-lg bg-slate-50 p-3" key={label}><dt className="text-xs" style={{ color: A.sub }}>{label}</dt><dd className="mt-1 break-words text-sm font-medium">{value}</dd></div>)}
        </dl>
      </Card>

      <Availability comparison={comparison} />
      <AwardDecisionPanel comparison={comparison} award={award} canAward={canAward} onAward={onAward} />

      {(noParticipants || noQuotations || comparison.comparisonAvailability === "no_eligible_responses") && <Card className="p-4" data-testid="rfq-comparison-empty-context"><div className="flex items-start gap-2"><CircleAlert className="mt-0.5 text-slate-500" size={16} /><p className="text-xs" style={{ color: A.sub }}>{noParticipants ? tr("当前 RFQ 尚无供应商参与记录。", "This RFQ has no supplier participation records.") : noQuotations ? tr("已有参与记录，但尚无报价。", "Suppliers are participating, but no quotations have been recorded.") : tr("现有报价均为草稿、不完整、已撤回、历史记录或缺少完整行项目覆盖。", "All current quotations are drafts, incomplete, withdrawn, historical, or missing complete line coverage.")}</p></div></Card>}

      <Card className="p-4" data-testid="rfq-comparison-participation-summary">
        <h2 className="text-sm font-semibold">{tr("Participation 摘要", "Participation summary")}</h2>
        <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-8">{[[tr("参与总数", "Total"), comparison.participationSummary.participantCount], [tr("计划参与", "Planned"), comparison.participationSummary.plannedCount], [tr("内部邀请", "Invited"), comparison.participationSummary.invitedInternalCount], [tr("已记录响应", "Responses"), comparison.participationSummary.responseRecordedCount], [tr("尚无报价", "No quotation"), comparison.participationSummary.noResponseCount], [tr("已拒绝", "Declined"), comparison.participationSummary.declinedCount], [tr("已撤回", "Withdrawn"), comparison.participationSummary.withdrawnCount], [tr("已关闭", "Closed"), comparison.participationSummary.closedCount]].map(([label, value]) => <div className="rounded-lg bg-slate-50 p-3" key={label}><div className="text-[11px]" style={{ color: A.sub }}>{label}</div><div className="mt-1 text-lg font-semibold tabular-nums">{value}</div></div>)}</div>
      </Card>

      <ResponseSummary responses={comparison.responses} />
      <LineMatrix comparison={comparison} />

      <Card className="overflow-hidden" data-testid="rfq-comparison-commercial-terms">
        <div className="border-b p-4"><h2 className="text-sm font-semibold">{tr("商业条款", "Commercial terms")}</h2></div>
        {comparison.responses.length === 0 ? <div className="p-8 text-center text-xs" style={{ color: A.sub }}>{tr("当前没有可展示的供应商商业条款。", "No supplier commercial terms are available.")}</div> : <div className="overflow-x-auto"><table className="w-full min-w-[900px] text-left text-xs"><thead className="bg-slate-50" style={{ color: A.sub }}><tr>{[tr("供应商", "Supplier"), tr("付款条款", "Payment terms"), tr("有效期", "Valid until"), tr("交付日期", "Delivery date"), tr("原币报价", "Original-currency quote"), tr("资格", "Eligibility")].map((label) => <th className="p-3 font-medium" key={label}>{label}</th>)}</tr></thead><tbody>{comparison.responses.map((response) => <tr className="border-t" key={response.supplierId}><td className="p-3 font-medium">{response.supplierName || response.supplierId}</td><td className="p-3">{response.latestRevision?.paymentTerms || "—"}</td><td className="p-3">{dateOnly(response.latestRevision?.validUntil)}</td><td className="p-3">{dateOnly(response.latestRevision?.deliveryDate)}</td><td className="p-3 tabular-nums">{exactAmount(response.latestRevision?.quotedAmount, response.latestRevision?.currency)}</td><td className="p-3">{localLabel(ELIGIBILITY_LABELS, response.comparisonEligibility, language, response.comparisonEligibility)}</td></tr>)}</tbody></table></div>}
      </Card>

      <Card className="p-4" data-testid="rfq-comparison-non-response">
        <h2 className="text-sm font-semibold">{tr("已参与但尚无报价", "Participating without a quotation")}</h2>
        <p className="mt-1 text-xs" style={{ color: A.sub }}>{tr("这里展示已有 Participation、但尚不存在 SupplierQuotation 报价记录的供应商。", "These suppliers have participation records but no supplier quotation record.")}</p>
        <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">{comparison.nonResponseParticipants.map((participant) => <div className="rounded-lg border p-3 text-xs" data-testid={`rfq-comparison-non-response-${participant.supplierId}`} key={participant.supplierId}><div className="font-medium">{participant.supplierName || tr("未提供名称", "Name not provided")}</div><div className="mt-1" style={{ color: A.sub }}>{participant.supplierId}</div><div className="mt-2">{localLabel(PARTICIPATION_STATUS_LABELS, participant.status || "", language, participant.statusRaw || tr("状态不可识别", "Unrecognized status"))}</div><div className="mt-1" style={{ color: A.sub }}>{tr("内部邀请时间", "Internal invitation")}: {date(participant.invitedAt)}</div><div className="mt-1" style={{ color: A.sub }}>{tr("响应状态：尚无报价记录", "Response status: no quotation recorded")}</div></div>)}{comparison.nonResponseParticipants.length === 0 && <div className="rounded-lg bg-slate-50 p-4 text-xs" style={{ color: A.sub }}>{tr("当前没有仅有 Participation、尚无报价的供应商。", "Every participating supplier has a quotation record.")}</div>}</div>
      </Card>

      <Card className="p-4" data-testid="rfq-comparison-limitations">
        <div className="flex items-center gap-2"><ShieldCheck size={16} className="text-blue-600" /><h2 className="text-sm font-semibold">{tr("权限与数据边界", "Authority and data boundaries")}</h2></div>
        <ul className="mt-3 space-y-2 text-xs" style={{ color: A.sub }}><li>· {tr("商业事实仅来自每个 SupplierQuotation 最大 revisionNumber。", "Commercial facts come only from the highest revision number for each supplier quotation.")}</li><li>· {tr("非有效响应继续展示，但不计入 comparisonAvailability。", "Ineligible responses remain visible but do not affect comparison availability.")}</li><li>· {tr("Participation 只证明内部记录；不证明邮件送达、供应商登录或线上提交。", "Participation proves only an internal record; it does not prove email delivery, supplier login, or online submission.")}</li><li>· {tr("排名、推荐与 PO Conversion 权威仍为 unavailable；Award 必须由有权限的用户明确确认。", "Ranking, recommendations, and purchase-order conversion remain unavailable. An authorized user must explicitly confirm an award.")}</li>{comparison.limitations.map((limitation) => <li key={limitation}>· {limitation}</li>)}</ul>
      </Card>

      <Link className="inline-flex items-center gap-2 text-sm font-semibold text-blue-600" to={`/app/procurement/rfq/${encodeURIComponent(comparison.rfqId)}`}><ArrowLeft size={16} />{tr("返回 RFQ 详情", "Back to RFQ details")}</Link>
    </div>
  );
}

export function CanonicalRfqComparisonPage({ documentId, effectivePermissionCodes, authorizationLoadState }: { documentId: string; effectivePermissionCodes: Set<string>; authorizationLoadState: "loading" | "ready" | "failed" }) {
  const { language } = useI18n();
  const tr: Tr = (zh, en) => language === "en-US" ? en : zh;
  const [comparison, setComparison] = useState<RfqSupplierComparison | null>(null);
  const [award, setAward] = useState<RfqAwardDecision | null>(null);
  const [state, setState] = useState<ReadState>(documentId.trim() ? "loading" : "malformed");

  const load = useCallback(async () => {
    if (!documentId.trim()) { setState("malformed"); return; }
    setState("loading");
    setComparison(null);
    setAward(null);
    try {
      const nextComparison = await procurementApi.getRfqSupplierComparison(documentId);
      setComparison(nextComparison);
      try { setAward(await procurementApi.getRfqAwardDecision(documentId)); } catch { setAward(null); }
      setState("loaded");
    } catch (error) {
      setState(failureState(error));
    }
  }, [documentId]);

  useEffect(() => { void load(); }, [load]);

  if (state === "loaded" && comparison) return <LoadedComparison comparison={comparison} award={award} canAward={authorizationLoadState === "ready" && effectivePermissionCodes.has("procurement.rfq_award.create")} onAward={setAward} />;

  const messages: Record<Exclude<ReadState, "loading" | "loaded">, string> = {
    malformed: tr("RFQ 比较链接缺少有效编号。", "The RFQ comparison link has no valid ID."),
    notFound: tr("当前租户下找不到该 RFQ，或该记录不可见。", "This RFQ was not found in the current workspace or is not visible to you."),
    unauthenticated: tr("登录状态已失效，无法读取供应商报价比较。", "Your session has expired. Sign in to view the supplier quotation comparison."),
    forbidden: tr("当前用户没有查看供应商价格比较的权限。", "You do not have permission to view supplier price comparisons."),
    invalid: tr("RFQ 编号格式无效，无法读取供应商报价比较。", "The RFQ ID is invalid."),
    error: tr("供应商报价比较暂时无法读取，请稍后重试。", "The supplier quotation comparison is temporarily unavailable. Try again later."),
    network: tr("无法连接到供应商报价比较服务，请检查网络后重试。", "The supplier quotation comparison service could not be reached. Check your connection and try again."),
  };
  return <div className="space-y-4" data-testid="canonical-rfq-comparison-state"><Card className="p-8 text-center">{state === "loading" ? <div className="text-sm" style={{ color: A.sub }}>{tr("正在读取供应商报价比较…", "Loading supplier quotation comparison…")}</div> : <><TriangleAlert className="mx-auto text-amber-600" size={30} /><div className="mt-3 text-sm font-semibold">{messages[state]}</div>{state !== "malformed" && <button className="mt-4 inline-flex items-center gap-2 text-sm font-semibold text-blue-600" onClick={() => void load()} type="button"><RefreshCw size={15} />{tr("重试", "Retry")}</button>}</>}</Card><Link className="inline-flex items-center gap-2 text-sm font-semibold text-blue-600" to={documentId ? `/app/procurement/rfq/${encodeURIComponent(documentId)}` : "/app/procurement/rfq"}><ArrowLeft size={16} />{tr("返回 RFQ", "Back to RFQ")}</Link></div>;
}
