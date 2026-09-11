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

const RFQ_STATUS_LABELS: Record<string, string> = {
  draft: "草稿",
  open: "开放",
  collecting_quotes: "收集报价",
  closed: "已关闭",
  cancelled: "已取消",
};

const REVISION_STATUS_LABELS: Record<string, string> = {
  draft: "草稿",
  incomplete: "信息不完整",
  submitted: "已提交",
  shortlisted: "已入围",
  not_selected: "历史未中选",
  withdrawn: "已撤回",
};

const PARTICIPATION_STATUS_LABELS: Record<string, string> = {
  planned: "计划参与",
  invited_internal: "已内部邀请",
  response_recorded: "已记录响应",
  declined: "已拒绝",
  withdrawn: "已撤回",
  closed: "已关闭",
};

const ELIGIBILITY_LABELS: Record<RfqComparisonEligibility, string> = {
  eligible: "可比较",
  not_ready: "尚未形成有效提交",
  historical_only: "历史报价",
  withdrawn: "已撤回",
  incomplete_coverage: "行项目覆盖不完整",
  authority_missing: "缺少权威 Revision",
  unknown_status: "状态无法确认",
};

const AVAILABILITY_COPY = {
  no_eligible_responses: ["暂无可比较的有效报价", "当前没有满足完整提交与行项目覆盖要求的报价。"],
  single_eligible_response: ["当前只有 1 个有效报价，无法进行横向比较", "仍可查看该供应商的权威商业事实。"],
  side_by_side_available: ["可进行并列比价", "已有多份同币种有效报价，页面仅作事实并列展示。"],
  multi_currency_unconverted: ["多币种，未折算", "报价币种不同，当前未进行汇率换算，因此总金额不能直接横向比较。"],
} as const;

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

function eligibilityChip(eligibility: RfqComparisonEligibility) {
  const eligible = eligibility === "eligible";
  return <Chip label={ELIGIBILITY_LABELS[eligibility]} color={eligible ? A.blue : A.sub} bg={eligible ? "#eff6ff" : "#f1f5f9"} />;
}

function Availability({ comparison }: { comparison: RfqSupplierComparison }) {
  const [title, description] = AVAILABILITY_COPY[comparison.comparisonAvailability];
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
  return (
    <Card className="overflow-hidden" data-testid="rfq-comparison-responses">
      <div className="border-b p-4">
        <h2 className="text-sm font-semibold">供应商响应摘要</h2>
        <p className="mt-1 text-xs" style={{ color: A.sub }}>顺序来自后端 supplier ID 升序权威；未按价格排序。</p>
      </div>
      {responses.length === 0 ? <div className="p-8 text-center text-xs" style={{ color: A.sub }}>当前 RFQ 尚无报价记录。</div> : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1100px] text-left text-xs">
            <thead className="bg-slate-50" style={{ color: A.sub }}><tr>{["供应商", "报价 / Revision", "状态", "比较资格", "原币总额", "提交时间", "行项目覆盖"].map((label) => <th className="p-3 font-medium" key={label}>{label}</th>)}</tr></thead>
            <tbody>{responses.map((response) => {
              const revision = response.latestRevision;
              return <tr className="border-t align-top" data-testid={`rfq-comparison-response-${response.supplierId}`} key={`${response.supplierId}:${response.quotationId}`}>
                <td className="p-3"><div className="font-medium">{response.supplierName || "未提供名称"}</div><div className="mt-1" style={{ color: A.sub }}>{response.supplierId}</div></td>
                <td className="p-3"><div>{response.quotationId}</div><div className="mt-1" style={{ color: A.sub }}>{revision ? `Revision ${revision.revisionNumber}` : "权威 Revision 缺失"}</div></td>
                <td className="p-3">{revision?.status ? REVISION_STATUS_LABELS[revision.status] || revision.statusRaw || "未知" : "不可用"}</td>
                <td className={`p-3 ${response.comparisonEligibility === "eligible" ? "" : "bg-slate-50/70 text-slate-500"}`}>{eligibilityChip(response.comparisonEligibility)}{response.eligibilityReasons.length > 0 && <div className="mt-2 text-[11px]" style={{ color: A.sub }}>{response.eligibilityReasons.join(" · ")}</div>}</td>
                <td className="p-3 font-medium tabular-nums">{exactAmount(revision?.quotedAmount, revision?.currency)}</td>
                <td className="p-3">{date(revision?.submittedAt)}</td>
                <td className="p-3"><div>{response.coverage.matchedLineCount} / {response.coverage.requiredLineCount}</div><div className="mt-1" style={{ color: A.sub }}>{response.coverage.state === "complete" ? "完整覆盖" : response.coverage.state === "not_applicable" ? "无目标行项目" : "覆盖不完整"}</div></td>
              </tr>;
            })}</tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function LineMatrix({ comparison }: { comparison: RfqSupplierComparison }) {
  return (
    <Card className="overflow-hidden" data-testid="rfq-comparison-line-matrix">
      <div className="border-b p-4"><h2 className="text-sm font-semibold">行项目并列展示</h2><p className="mt-1 text-xs" style={{ color: A.sub }}>金额直接显示 API Decimal 字符串，不在浏览器重算。</p></div>
      {comparison.lines.length === 0 ? <div className="p-8 text-center text-xs" style={{ color: A.sub }}>当前 RFQ 没有权威行项目。</div> : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-max text-left text-xs">
            <thead className="bg-slate-50" style={{ color: A.sub }}><tr><th className="sticky left-0 z-10 min-w-[260px] bg-slate-50 p-3 font-medium">RFQ 行项目</th>{comparison.responses.map((response) => <th className="min-w-[230px] p-3 font-medium" key={response.supplierId}><div>{response.supplierName || response.supplierId}</div><div className="mt-1 font-normal">{response.supplierId}</div></th>)}</tr></thead>
            <tbody>{comparison.lines.map((line) => <tr className="border-t align-top" data-testid={`rfq-comparison-line-${line.rfqLineId}`} key={line.rfqLineId}>
              <td className="sticky left-0 z-10 bg-white p-3"><div className="font-medium">{line.itemName || line.sku || line.itemId || line.rfqLineId}</div><div className="mt-1" style={{ color: A.sub }}>{line.sku || "—"} · {line.rfqLineId}</div><div className="mt-2 tabular-nums">需求：{line.requestedQuantity || "—"} {line.unit || ""}</div></td>
              {comparison.responses.map((response) => {
                const quotedLine = response.latestRevision?.lines.find((candidate) => candidate.rfqLineId === line.rfqLineId && candidate.lineAuthorityState === "exact_target_rfq_line");
                return <td className="p-3" data-testid={`rfq-comparison-cell-${line.rfqLineId}-${response.supplierId}`} key={response.supplierId}>{quotedLine ? <div className="space-y-1"><div>数量：<span className="tabular-nums">{quotedLine.quantity || "—"}</span> {quotedLine.unit || ""}</div><div>单价：<span className="tabular-nums">{exactAmount(quotedLine.unitPrice, response.latestRevision?.currency)}</span></div><div>行金额：<span className="tabular-nums">{exactAmount(quotedLine.amount, response.latestRevision?.currency)}</span></div><div style={{ color: A.sub }}>交期：{dateOnly(quotedLine.deliveryDate || response.latestRevision?.deliveryDate)}</div></div> : <span style={{ color: A.sub }}>未覆盖</span>}</td>;
              })}
            </tr>)}</tbody>
          </table>
        </div>
      )}
      {comparison.responses.some((response) => response.latestRevision?.lines.some((line) => line.lineAuthorityState !== "exact_target_rfq_line")) && <div className="border-t p-4 text-xs" style={{ color: A.sub }}><div className="font-semibold text-slate-700">无法与 RFQ 行建立权威对应</div>{comparison.responses.flatMap((response) => (response.latestRevision?.lines || []).filter((line) => line.lineAuthorityState !== "exact_target_rfq_line").map((line) => <div key={`${response.supplierId}:${line.revisionLineId}`} className="mt-1">{response.supplierName || response.supplierId} · {line.revisionLineId} · 未能与 RFQ 行建立权威对应</div>))}</div>}
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
  const noParticipants = comparison.participationSummary.participantCount === 0;
  const noQuotations = comparison.summary.quotationCount === 0;
  return (
    <div className="space-y-4" data-testid="canonical-rfq-comparison">
      <Card className="p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0"><div className="text-xs font-semibold uppercase tracking-wide" style={{ color: A.sub }}>只读供应商报价比较 · {comparison.rfqId}</div><h1 className="mt-1 text-xl font-semibold">{comparison.rfqTitle || comparison.rfqId}</h1><p className="mt-2 text-xs" style={{ color: A.sub }}>本页不排名、不推荐、不授标，也不创建采购订单。</p></div>
          <div className="flex flex-wrap gap-2"><Chip label="只读比较" color={A.blue} bg="#eff6ff" /><Chip label={RFQ_STATUS_LABELS[comparison.rfqStatus || ""] || comparison.rfqStatusRaw || "状态未知"} color={A.sub} bg="#f1f5f9" /></div>
        </div>
        <dl className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {[["RFQ 编号", comparison.rfqId], ["RFQ 币种", comparison.rfqCurrency || "—"], ["有效报价", String(comparison.summary.eligibleResponseCount)], ["权威响应", String(comparison.summary.authoritativeResponseCount)], ["参与供应商", String(comparison.participationSummary.participantCount)], ["全部报价记录", String(comparison.summary.quotationCount)], ["显示顺序", "供应商 ID 升序"], ["生成时间", date(comparison.generatedAt)]].map(([label, value]) => <div className="rounded-lg bg-slate-50 p-3" key={label}><dt className="text-xs" style={{ color: A.sub }}>{label}</dt><dd className="mt-1 break-words text-sm font-medium">{value}</dd></div>)}
        </dl>
      </Card>

      <Availability comparison={comparison} />
      <AwardDecisionPanel comparison={comparison} award={award} canAward={canAward} onAward={onAward} />

      {(noParticipants || noQuotations || comparison.comparisonAvailability === "no_eligible_responses") && <Card className="p-4" data-testid="rfq-comparison-empty-context"><div className="flex items-start gap-2"><CircleAlert className="mt-0.5 text-slate-500" size={16} /><p className="text-xs" style={{ color: A.sub }}>{noParticipants ? "当前 RFQ 尚无供应商参与记录。" : noQuotations ? "已有参与记录，但尚无报价。" : "现有报价均为草稿、不完整、已撤回、历史记录或缺少完整行项目覆盖。"}</p></div></Card>}

      <Card className="p-4" data-testid="rfq-comparison-participation-summary">
        <h2 className="text-sm font-semibold">Participation 摘要</h2>
        <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-8">{[["参与总数", comparison.participationSummary.participantCount], ["计划参与", comparison.participationSummary.plannedCount], ["内部邀请", comparison.participationSummary.invitedInternalCount], ["已记录响应", comparison.participationSummary.responseRecordedCount], ["尚无报价", comparison.participationSummary.noResponseCount], ["已拒绝", comparison.participationSummary.declinedCount], ["已撤回", comparison.participationSummary.withdrawnCount], ["已关闭", comparison.participationSummary.closedCount]].map(([label, value]) => <div className="rounded-lg bg-slate-50 p-3" key={label}><div className="text-[11px]" style={{ color: A.sub }}>{label}</div><div className="mt-1 text-lg font-semibold tabular-nums">{value}</div></div>)}</div>
      </Card>

      <ResponseSummary responses={comparison.responses} />
      <LineMatrix comparison={comparison} />

      <Card className="overflow-hidden" data-testid="rfq-comparison-commercial-terms">
        <div className="border-b p-4"><h2 className="text-sm font-semibold">商业条款</h2></div>
        {comparison.responses.length === 0 ? <div className="p-8 text-center text-xs" style={{ color: A.sub }}>当前没有可展示的供应商商业条款。</div> : <div className="overflow-x-auto"><table className="w-full min-w-[900px] text-left text-xs"><thead className="bg-slate-50" style={{ color: A.sub }}><tr>{["供应商", "付款条款", "有效期", "交付日期", "原币报价", "资格"].map((label) => <th className="p-3 font-medium" key={label}>{label}</th>)}</tr></thead><tbody>{comparison.responses.map((response) => <tr className="border-t" key={response.supplierId}><td className="p-3 font-medium">{response.supplierName || response.supplierId}</td><td className="p-3">{response.latestRevision?.paymentTerms || "—"}</td><td className="p-3">{dateOnly(response.latestRevision?.validUntil)}</td><td className="p-3">{dateOnly(response.latestRevision?.deliveryDate)}</td><td className="p-3 tabular-nums">{exactAmount(response.latestRevision?.quotedAmount, response.latestRevision?.currency)}</td><td className="p-3">{ELIGIBILITY_LABELS[response.comparisonEligibility]}</td></tr>)}</tbody></table></div>}
      </Card>

      <Card className="p-4" data-testid="rfq-comparison-non-response">
        <h2 className="text-sm font-semibold">已参与但尚无报价</h2>
        <p className="mt-1 text-xs" style={{ color: A.sub }}>这里展示已有 Participation、但尚不存在 SupplierQuotation 报价记录的供应商。</p>
        <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">{comparison.nonResponseParticipants.map((participant) => <div className="rounded-lg border p-3 text-xs" data-testid={`rfq-comparison-non-response-${participant.supplierId}`} key={participant.supplierId}><div className="font-medium">{participant.supplierName || "未提供名称"}</div><div className="mt-1" style={{ color: A.sub }}>{participant.supplierId}</div><div className="mt-2">{PARTICIPATION_STATUS_LABELS[participant.status || ""] || participant.statusRaw || "状态不可识别"}</div><div className="mt-1" style={{ color: A.sub }}>内部邀请时间：{date(participant.invitedAt)}</div><div className="mt-1" style={{ color: A.sub }}>响应状态：尚无报价记录</div></div>)}{comparison.nonResponseParticipants.length === 0 && <div className="rounded-lg bg-slate-50 p-4 text-xs" style={{ color: A.sub }}>当前没有仅有 Participation、尚无报价的供应商。</div>}</div>
      </Card>

      <Card className="p-4" data-testid="rfq-comparison-limitations">
        <div className="flex items-center gap-2"><ShieldCheck size={16} className="text-blue-600" /><h2 className="text-sm font-semibold">权限与数据边界</h2></div>
        <ul className="mt-3 space-y-2 text-xs" style={{ color: A.sub }}><li>· 商业事实仅来自每个 SupplierQuotation 最大 revisionNumber。</li><li>· 非有效响应继续展示，但不计入 comparisonAvailability。</li><li>· Participation 只证明内部记录；不证明邮件送达、供应商登录或线上提交。</li><li>· 排名、推荐与 PO Conversion 权威仍为 unavailable；Award 必须由有权限的用户明确确认。</li>{comparison.limitations.map((limitation) => <li key={limitation}>· {limitation}</li>)}</ul>
      </Card>

      <Link className="inline-flex items-center gap-2 text-sm font-semibold text-blue-600" to={`/app/procurement/rfq/${encodeURIComponent(comparison.rfqId)}`}><ArrowLeft size={16} />返回 RFQ 详情</Link>
    </div>
  );
}

export function CanonicalRfqComparisonPage({ documentId, effectivePermissionCodes, authorizationLoadState }: { documentId: string; effectivePermissionCodes: Set<string>; authorizationLoadState: "loading" | "ready" | "failed" }) {
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
    malformed: "RFQ 比较链接缺少有效编号。",
    notFound: "当前租户下找不到该 RFQ，或该记录不可见。",
    unauthenticated: "登录状态已失效，无法读取供应商报价比较。",
    forbidden: "当前用户没有查看供应商价格比较的权限。",
    invalid: "RFQ 编号格式无效，无法读取供应商报价比较。",
    error: "供应商报价比较暂时无法读取，请稍后重试。",
    network: "无法连接到供应商报价比较服务，请检查网络后重试。",
  };
  return <div className="space-y-4" data-testid="canonical-rfq-comparison-state"><Card className="p-8 text-center">{state === "loading" ? <div className="text-sm" style={{ color: A.sub }}>正在读取供应商报价比较…</div> : <><TriangleAlert className="mx-auto text-amber-600" size={30} /><div className="mt-3 text-sm font-semibold">{messages[state]}</div>{state !== "malformed" && <button className="mt-4 inline-flex items-center gap-2 text-sm font-semibold text-blue-600" onClick={() => void load()} type="button"><RefreshCw size={15} />重试</button>}</>}</Card><Link className="inline-flex items-center gap-2 text-sm font-semibold text-blue-600" to={documentId ? `/app/procurement/rfq/${encodeURIComponent(documentId)}` : "/app/procurement/rfq"}><ArrowLeft size={16} />返回 RFQ</Link></div>;
}
