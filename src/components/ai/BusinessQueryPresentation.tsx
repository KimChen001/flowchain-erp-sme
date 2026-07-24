import type { AiResponseV2, AiBusinessQuerySectionCard } from "../../domain/ai/response-contract";
import { useI18n } from "../../i18n/I18n";
import { A } from "../ui";

const businessStateTone = {
  confirmed: { color: A.red, bg: "#fff1f2" },
  confirmed_zero: { color: A.green, bg: "#effaf3" },
  incomplete: { color: "#8a5a00", bg: "#fff7db" },
  hidden: { color: A.gray1, bg: A.gray6 },
  unavailable: { color: A.gray2, bg: A.gray6 },
} as const;
const blockReasonLabels: Record<string, [string, string]> = {
  invoice_disputed: ["Invoice disputed", "发票存在争议"],
  payment_hold: ["Payment on hold", "付款已暂停"],
  missing_invoice: ["Invoice missing", "缺少正式发票"],
  missing_receiving_evidence: ["Receiving evidence missing", "缺少收货证据"],
  three_way_match_difference: ["Three-way match difference", "三单匹配存在差异"],
  supplier_mismatch: ["Supplier mismatch", "供应商不一致"],
  currency_mismatch: ["Currency mismatch", "币种不一致"],
  settlement_not_posted: ["Settlement not posted", "结算单尚未过账"],
  bank_reconciliation_exception: ["Bank reconciliation blocked", "银行核对存在阻断异常"],
  data_incomplete: ["Incomplete data", "数据不完整"],
};
const countLabels: Record<string, [string, string]> = { due: ["Due", "到期"], overdue: ["Overdue", "逾期"], ready: ["Ready to pay", "可付款"], blocked: ["Blocked", "被阻断"], open: ["Open", "开放"], mismatch: ["Mismatch", "差异"], disputed: ["Disputed", "争议"], missingEvidence: ["Missing evidence", "缺证据"], openPo: ["Open POs", "开放 PO"], overduePo: ["Overdue POs", "延期 PO"], unreceivedPo: ["Not fully received", "未收完"], exceptions: ["Exceptions", "异常"], pendingEvidence: ["Pending evidence", "待补证据"], awaitingResponse: ["Awaiting response", "待回复"], expired: ["Expired", "已过期"], unreconciledPayments: ["Unreconciled payments", "未核对付款"], blockingExceptions: ["Blocking exceptions", "阻断异常"], incompleteRecords: ["Incomplete records", "不完整记录"] };

function BusinessQueryRow({ row }: { row: Record<string, unknown> }) {
  const { language } = useI18n();
  const index = language === "zh-CN" ? 1 : 0;
  const supplier = row.supplier && typeof row.supplier === "object" ? row.supplier as Record<string, unknown> : {};
  const priority = row.priority && typeof row.priority === "object" ? row.priority as Record<string, unknown> : {};
  const blocks = Array.isArray(row.blocks) ? row.blocks as Array<Record<string, unknown>> : [];
  const overduePoIds = Array.isArray(row.overduePoIds) ? row.overduePoIds : [];
  const title = String(supplier.displayName || supplier.name || supplier.id || (index ? "供应商事项" : "Supplier item"));
  return (
    <div className="min-w-0 rounded-lg px-2.5 py-2" style={{ background: A.gray6 }}>
      <div className="flex min-w-0 items-center justify-between gap-2">
        <span className="min-w-0 truncate text-[11px] font-semibold" style={{ color: A.label }}>{title}</span>
        {priority.level ? <span className="shrink-0 text-[10px]" style={{ color: A.gray2 }}>{String(priority.level)} · {String(priority.score ?? "")}</span> : null}
      </div>
      {blocks.length ? <div className="mt-1 space-y-0.5">{blocks.slice(0, 3).map((block, index) => <div key={`${String(block.payableId)}-${index}`} className="break-words text-[10px] leading-4" style={{ color: A.red }}>{blockReasonLabels[String(block.reason)]?.[index] || String(block.reason)}</div>)}</div> : null}
      {overduePoIds.length ? <div className="mt-1 break-words text-[10px] leading-4" style={{ color: A.gray1 }}>{index ? "延期 PO：" : "Overdue POs: "}{overduePoIds.slice(0, 4).map(String).join("、")}</div> : null}
    </div>
  );
}

function BusinessQuerySection({ section }: { section: AiBusinessQuerySectionCard }) {
  const { language } = useI18n();
  const index = language === "zh-CN" ? 1 : 0;
  const tone = businessStateTone[section.state] || businessStateTone.unavailable;
  const metrics = [...Object.entries(section.counts || {}), ...Object.entries(section.amounts || {}).map(([key, value]) => [`amount_${key}`, value] as [string, number | null])].filter(([, value]) => value !== null && value !== undefined);
  return (
    <article data-testid="ai-business-query-section" data-state={section.state} className="min-w-0 space-y-2 rounded-xl p-3" style={{ border: `1px solid ${A.border}` }}>
      <div className="flex min-w-0 items-center justify-between gap-2">
        <h4 className="min-w-0 truncate text-xs font-semibold" style={{ color: A.label }}>{section.label}</h4>
        <span className="shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold" style={{ color: tone.color, background: tone.bg }}>{section.stateLabel}</span>
      </div>
      {metrics.length ? <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3">{metrics.slice(0, 6).map(([key, value]) => <div key={key} className="min-w-0 rounded-lg px-2 py-1.5" style={{ background: A.gray6 }}><div className="truncate text-[10px]" style={{ color: A.gray2 }}>{key.startsWith("amount_") ? `${countLabels[key.slice(7)]?.[index] || key.slice(7)}${index ? "金额" : " amount"}` : countLabels[key]?.[index] || key}</div><div className="truncate text-[11px] font-semibold" style={{ color: A.label }}>{Number(value).toLocaleString()}</div></div>)}</div> : null}
      {section.rows?.length ? <div className="space-y-1.5">{section.rows.slice(0, 5).map((row, index) => <BusinessQueryRow key={`${section.goal}-${index}`} row={row} />)}</div> : null}
      {section.limitations?.length ? <div className="break-words text-[10px] leading-4" style={{ color: A.gray2 }}>{section.limitations.join("；")}</div> : null}
    </article>
  );
}

export function BusinessQueryPresentation({ response }: { response: AiResponseV2 }) {
  const query = response.businessQuery;
  if (!query) return null;
  return (
    <section data-testid="ai-business-query-presentation" className="min-w-0 space-y-3">
      <div className="flex min-w-0 flex-wrap gap-1.5">
        <span data-testid="ai-business-query-scope" className="max-w-full truncate rounded-full px-2.5 py-1 text-[11px] font-semibold" style={{ background: "#eef5ff", color: A.blue }}>{query.scopeBadge}</span>
        {query.goalLabels.slice(0, 8).map((label) => <span key={label} className="rounded-full px-2 py-1 text-[10px]" style={{ background: A.gray6, color: A.gray1 }}>{label}</span>)}
      </div>
      {query.clarification?.needed ? <div data-testid="ai-business-query-clarification" className="break-words rounded-xl p-3 text-xs leading-5" style={{ background: "#fff7db", color: "#6f4900" }}>{query.clarification.question}</div> : null}
      {query.sectionCards.length ? <div className="grid min-w-0 grid-cols-1 gap-2">{query.sectionCards.map((section) => <BusinessQuerySection key={section.goal} section={section} />)}</div> : null}
    </section>
  );
}

