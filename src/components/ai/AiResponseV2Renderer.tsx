import type { ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { Link } from "react-router";
import type { ActionDraftPreviewRequest } from "../../modules/action-drafts/ActionDraftReviewShell";
import type { AiBusinessQuerySectionCard, AiResponseV2, AiResponseV2EvidenceItem, AiResponseV2NavigationLink, AiResponseV2ReviewCard } from "../../domain/ai/response-contract";
import { toAiFocusedResponse, type AiFocusedAction } from "../../domain/ai/focused-response";
import { routePathForId } from "../../app/routeRegistry";
import { BusinessEntityLink } from "../business/BusinessEntityLink";
import { businessEntityRouteRegistry, type BusinessEntityType } from "../business/businessEntityRoutes";
import { A } from "../ui";

type NavigateOptions = { returnTo?: string; entityLabel?: string; source?: string; returnContext?: unknown };
type Navigate = (moduleId: string, focusTarget?: { entityType: string; entityId: string } | null, options?: NavigateOptions) => void;

const severityLabel = { info: "信息", warning: "提醒", risk: "风险", success: "正常" } as const;
const severityTone = {
  info: { color: A.blue, bg: "#eef5ff" }, warning: { color: "#8a5a00", bg: "#fff7db" },
  risk: { color: A.red, bg: "#fff1f2" }, success: { color: A.green, bg: "#effaf3" },
};

const businessStateTone = {
  confirmed: { color: A.red, bg: "#fff1f2" },
  confirmed_zero: { color: A.green, bg: "#effaf3" },
  incomplete: { color: "#8a5a00", bg: "#fff7db" },
  hidden: { color: A.gray1, bg: A.gray6 },
  unavailable: { color: A.gray2, bg: A.gray6 },
} as const;
const blockReasonLabels: Record<string, string> = {
  invoice_disputed: "发票存在争议",
  payment_hold: "付款已暂停",
  missing_invoice: "缺少正式发票",
  missing_receiving_evidence: "缺少收货证据",
  three_way_match_difference: "三单匹配存在差异",
  supplier_mismatch: "供应商不一致",
  currency_mismatch: "币种不一致",
  settlement_not_posted: "结算单尚未过账",
  bank_reconciliation_exception: "银行核对存在阻断异常",
  data_incomplete: "数据不完整",
};
const countLabels: Record<string, string> = { due: "到期", overdue: "逾期", ready: "可付款", blocked: "被阻断", open: "开放", mismatch: "差异", disputed: "争议", missingEvidence: "缺证据", openPo: "开放 PO", overduePo: "延期 PO", unreceivedPo: "未收完", exceptions: "异常", pendingEvidence: "待补证据", awaitingResponse: "待回复", expired: "已过期", unreconciledPayments: "未核对付款", blockingExceptions: "阻断异常", incompleteRecords: "不完整记录" };

function Chip({ tone, children }: { tone: keyof typeof severityTone; children: ReactNode }) {
  const color = severityTone[tone] || severityTone.info;
  return <span className="inline-flex rounded-full px-2 py-0.5 text-[11px] font-semibold" style={{ color: color.color, background: color.bg }}>{children}</span>;
}

function entityType(value = ""): BusinessEntityType | null {
  const aliases: Record<string, BusinessEntityType> = { inventory_item: "item", sku: "item", po: "purchase_order", pr: "purchase_request", grn: "receiving_doc", invoice: "supplier_invoice" };
  const candidate = aliases[value] || value;
  return candidate in businessEntityRouteRegistry ? candidate as BusinessEntityType : null;
}

function EvidenceLink({ item, children }: { item: AiResponseV2EvidenceItem; children?: ReactNode }) {
  const type = entityType(item.entityType);
  if (!type || !item.entityId) return <span style={{ color: A.label }}>{children || item.entityLabel || item.label}</span>;
  return <BusinessEntityLink entityType={type} entityId={item.entityId} returnLabel="返回 AI 助手">{children || item.entityLabel || item.label || item.entityId}</BusinessEntityLink>;
}

function reviewRequest(card: AiResponseV2ReviewCard): ActionDraftPreviewRequest | null {
  if (!card.draftType) return null;
  return { type: card.draftType, title: card.draftTitle || card.title, source: "ai_assistant", originEvidence: card.originEvidence || [], payload: { ...(card.payload || {}), reason: card.payload?.reason || card.description || card.allowedNextStep } };
}

function NavigationAction({ link, primary = false }: { link: AiResponseV2NavigationLink; primary?: boolean }) {
  const type = entityType(link.entityType);
  const className = primary ? "inline-flex min-h-9 items-center gap-1 rounded-lg px-3 py-2 text-xs font-semibold text-white" : "inline-flex min-h-9 items-center gap-1 rounded-lg px-3 py-2 text-xs font-semibold";
  if (type && link.entityId) return <BusinessEntityLink entityType={type} entityId={link.entityId} returnLabel="返回 AI 助手" className={className}>{link.label}<ChevronRight size={13} /></BusinessEntityLink>;
  return <Link to={routePathForId(link.moduleId)} className={className} style={primary ? { background: A.blue } : { background: A.gray6, color: A.blue }}>{link.label}<ChevronRight size={13} /></Link>;
}

function Action({ action, primary, onReviewActionDraft }: { action: AiFocusedAction; primary?: boolean; onReviewActionDraft?: (request: ActionDraftPreviewRequest) => void }) {
  if (action.kind === "navigation") return <NavigationAction link={action.link} primary={primary} />;
  const request = reviewRequest(action.card);
  if (!request || !onReviewActionDraft) return null;
  return <button type="button" onClick={() => onReviewActionDraft(request)} data-testid="ai-action-draft-preview" className={primary ? "min-h-9 rounded-lg px-3 py-2 text-xs font-semibold text-white" : "min-h-9 rounded-lg px-3 py-2 text-xs font-semibold"} style={primary ? { background: A.blue } : { background: A.gray6, color: A.blue }}>{action.label || "审阅草稿"}</button>;
}

function Detail({ title, children, testId }: { title: string; children: ReactNode; testId: string }) {
  return <details data-testid={testId} className="rounded-lg" style={{ border: `1px solid ${A.border}` }}><summary className="cursor-pointer px-3 py-2 text-xs font-semibold" style={{ color: A.gray1 }}>{title}</summary><div className="space-y-2 px-3 pb-3">{children}</div></details>;
}

function BusinessQueryRow({ row }: { row: Record<string, unknown> }) {
  const supplier = row.supplier && typeof row.supplier === "object" ? row.supplier as Record<string, unknown> : {};
  const priority = row.priority && typeof row.priority === "object" ? row.priority as Record<string, unknown> : {};
  const blocks = Array.isArray(row.blocks) ? row.blocks as Array<Record<string, unknown>> : [];
  const overduePoIds = Array.isArray(row.overduePoIds) ? row.overduePoIds : [];
  const title = String(supplier.displayName || supplier.name || supplier.id || "供应商事项");
  return (
    <div className="min-w-0 rounded-lg px-2.5 py-2" style={{ background: A.gray6 }}>
      <div className="flex min-w-0 items-center justify-between gap-2">
        <span className="min-w-0 truncate text-[11px] font-semibold" style={{ color: A.label }}>{title}</span>
        {priority.level ? <span className="shrink-0 text-[10px]" style={{ color: A.gray2 }}>{String(priority.level)} · {String(priority.score ?? "")}</span> : null}
      </div>
      {blocks.length ? <div className="mt-1 space-y-0.5">{blocks.slice(0, 3).map((block, index) => <div key={`${String(block.payableId)}-${index}`} className="break-words text-[10px] leading-4" style={{ color: A.red }}>{blockReasonLabels[String(block.reason)] || String(block.reason)}</div>)}</div> : null}
      {overduePoIds.length ? <div className="mt-1 break-words text-[10px] leading-4" style={{ color: A.gray1 }}>延期 PO：{overduePoIds.slice(0, 4).map(String).join("、")}</div> : null}
    </div>
  );
}

function BusinessQuerySection({ section }: { section: AiBusinessQuerySectionCard }) {
  const tone = businessStateTone[section.state] || businessStateTone.unavailable;
  const metrics = [...Object.entries(section.counts || {}), ...Object.entries(section.amounts || {}).map(([key, value]) => [`amount_${key}`, value] as [string, number | null])].filter(([, value]) => value !== null && value !== undefined);
  return (
    <article data-testid="ai-business-query-section" data-state={section.state} className="min-w-0 space-y-2 rounded-xl p-3" style={{ border: `1px solid ${A.border}` }}>
      <div className="flex min-w-0 items-center justify-between gap-2">
        <h4 className="min-w-0 truncate text-xs font-semibold" style={{ color: A.label }}>{section.label}</h4>
        <span className="shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold" style={{ color: tone.color, background: tone.bg }}>{section.stateLabel}</span>
      </div>
      {metrics.length ? <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3">{metrics.slice(0, 6).map(([key, value]) => <div key={key} className="min-w-0 rounded-lg px-2 py-1.5" style={{ background: A.gray6 }}><div className="truncate text-[10px]" style={{ color: A.gray2 }}>{key.startsWith("amount_") ? `${countLabels[key.slice(7)] || key.slice(7)}金额` : countLabels[key] || key}</div><div className="truncate text-[11px] font-semibold" style={{ color: A.label }}>{Number(value).toLocaleString()}</div></div>)}</div> : null}
      {section.rows?.length ? <div className="space-y-1.5">{section.rows.slice(0, 5).map((row, index) => <BusinessQueryRow key={`${section.goal}-${index}`} row={row} />)}</div> : null}
      {section.limitations?.length ? <div className="break-words text-[10px] leading-4" style={{ color: A.gray2 }}>{section.limitations.join("；")}</div> : null}
    </article>
  );
}

function BusinessQueryPresentation({ response }: { response: AiResponseV2 }) {
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

export function AiResponseV2Renderer({ response, onReviewActionDraft, onFollowUp }: { response: AiResponseV2; onNavigate?: Navigate; onReviewActionDraft?: (request: ActionDraftPreviewRequest) => void; onFollowUp?: (prompt: string) => void }) {
  if (!response || response.version !== "v2") return null;
  const focused = toAiFocusedResponse(response);
  return (
    <div data-testid="ai-response-v2" data-answer-mode={focused.answerMode} className="space-y-3 rounded-xl p-3" style={{ background: A.white, border: `1px solid ${A.border}` }}>
      <section data-testid="ai-focused-conclusion">
        <div className="flex items-start justify-between gap-2"><div><h3 className="text-sm font-semibold leading-5" style={{ color: A.label }}>{focused.headline}</h3><p className="mt-1 text-xs leading-5" style={{ color: A.gray1 }}>{focused.summary}</p></div><Chip tone={focused.severity}>{severityLabel[focused.severity]}</Chip></div>
      </section>

      <BusinessQueryPresentation response={response} />

      {focused.primaryItems.length ? <section data-testid="ai-focused-primary-items" className="space-y-2"><div className="text-[11px] font-semibold" style={{ color: A.gray1 }}>重点事项</div>{focused.primaryItems.map((item) => <article key={item.id} className="rounded-lg p-2.5" style={{ background: A.gray6 }}><div className="flex items-start justify-between gap-2"><div className="min-w-0 text-xs font-semibold"><EvidenceLink item={item.evidence}>{item.title}</EvidenceLink></div>{item.status ? <span className="shrink-0 text-[11px]" style={{ color: A.gray2 }}>{item.status}</span> : null}</div><p className="mt-1 text-[11px] leading-5" style={{ color: A.gray1 }}>{item.reason}</p>{item.impact ? <p className="mt-1 text-[11px] leading-5" style={{ color: A.sub }}>影响：{item.impact}</p> : null}</article>)}</section> : null}

      {focused.primaryAction || focused.secondaryActions.length ? <section data-testid="ai-focused-actions"><div className="text-[11px] font-semibold" style={{ color: A.gray1 }}>下一步</div><div className="mt-2 flex flex-wrap gap-2">{focused.primaryAction ? <Action action={focused.primaryAction} primary onReviewActionDraft={onReviewActionDraft} /> : null}{focused.secondaryActions.map((action, index) => <Action key={`${action.kind}-${action.label}-${index}`} action={action} onReviewActionDraft={onReviewActionDraft} />)}</div></section> : null}

      {focused.evidence.length || focused.businessImpact.length || focused.limitations.length ? <section className="space-y-2" data-testid="ai-focused-details">
        {focused.evidence.length ? <Detail title={`查看关键证据（${Math.min(5, focused.evidence.length)}）`} testId="ai-evidence-details">{focused.evidence.map((item) => <div key={item.id} className="text-[11px] leading-5"><EvidenceLink item={item} /><div style={{ color: A.gray2 }}>{[item.status, item.value, item.sourceLabel].filter((value) => value !== undefined && value !== null && value !== "").join(" · ")}</div></div>)}</Detail> : null}
        {focused.businessImpact.length ? <Detail title="查看业务影响" testId="ai-impact-details">{focused.businessImpact.map((item) => <div key={`${item.area}-${item.impact}`} className="text-[11px] leading-5"><div className="font-semibold" style={{ color: A.label }}>{item.area} · {item.impact}</div><div style={{ color: A.gray1 }}>{item.explanation}</div></div>)}</Detail> : null}
        {focused.limitations.length ? <Detail title="查看数据限制" testId="ai-limitations-details">{focused.limitations.map((item) => <div key={item.label} className="text-[11px] leading-5"><div className="font-semibold" style={{ color: A.label }}>{item.label}</div><div style={{ color: A.gray1 }}>{item.description}</div>{item.consequence ? <div style={{ color: A.gray2 }}>{item.consequence}</div> : null}</div>)}</Detail> : null}
      </section> : null}

      {focused.followUps.length ? <section data-testid="ai-focused-follow-ups" className="flex flex-wrap gap-2">{focused.followUps.map((item) => <button key={item.prompt} type="button" onClick={() => onFollowUp?.(item.prompt)} disabled={!onFollowUp} className="rounded-full px-2.5 py-1 text-[11px] font-medium disabled:opacity-50" style={{ background: A.gray6, color: A.blue }}>{item.label}</button>)}</section> : null}
    </div>
  );
}
