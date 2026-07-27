import type { ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { Link } from "react-router";
import type { ActionDraftPreviewRequest } from "../../modules/action-drafts/ActionDraftReviewShell";
import type { AiResponseV2, AiResponseV2EvidenceItem, AiResponseV2NavigationLink, AiResponseV2ReviewCard } from "../../domain/ai/response-contract";
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

export function AiResponseV2Renderer({ response, onReviewActionDraft, onFollowUp }: { response: AiResponseV2; onNavigate?: Navigate; onReviewActionDraft?: (request: ActionDraftPreviewRequest) => void; onFollowUp?: (prompt: string) => void }) {
  if (!response || response.version !== "v2") return null;
  const focused = toAiFocusedResponse(response);
  return (
    <div data-testid="ai-response-v2" data-answer-mode={focused.answerMode} className="space-y-3 rounded-xl p-3" style={{ background: A.white, border: `1px solid ${A.border}` }}>
      <section data-testid="ai-focused-conclusion">
        <div className="flex items-start justify-between gap-2"><div><h3 className="text-sm font-semibold leading-5" style={{ color: A.label }}>{focused.headline}</h3><p className="mt-1 text-xs leading-5" style={{ color: A.gray1 }}>{focused.summary}</p></div><Chip tone={focused.severity}>{severityLabel[focused.severity]}</Chip></div>
        <div className="mt-2 flex gap-2 text-[11px]" style={{ color: A.gray2 }}>
          <span>可核验业务证据 {response.realEvidenceCount ?? response.keyEvidence.length}</span>
          <span>· 系统说明 {response.contextCardCount ?? response.contextCards?.length ?? 0}</span>
          <span>· 数据限制 {response.limitationCount ?? response.dataLimitations.length}</span>
        </div>
      </section>

      {focused.primaryItems.length ? <section data-testid="ai-focused-primary-items" className="space-y-2"><div className="text-[11px] font-semibold" style={{ color: A.gray1 }}>重点事项</div>{focused.primaryItems.map((item) => <article key={item.id} className="rounded-lg p-2.5" style={{ background: A.gray6 }}><div className="flex items-start justify-between gap-2"><div className="min-w-0 text-xs font-semibold"><EvidenceLink item={item.evidence}>{item.title}</EvidenceLink></div>{item.status ? <span className="shrink-0 text-[11px]" style={{ color: A.gray2 }}>{item.status}</span> : null}</div><p className="mt-1 text-[11px] leading-5" style={{ color: A.gray1 }}>{item.reason}</p>{item.impact ? <p className="mt-1 text-[11px] leading-5" style={{ color: A.sub }}>影响：{item.impact}</p> : null}</article>)}</section> : null}

      {focused.primaryAction || focused.secondaryActions.length ? <section data-testid="ai-focused-actions"><div className="text-[11px] font-semibold" style={{ color: A.gray1 }}>下一步</div><div className="mt-2 flex flex-wrap gap-2">{focused.primaryAction ? <Action action={focused.primaryAction} primary onReviewActionDraft={onReviewActionDraft} /> : null}{focused.secondaryActions.map((action, index) => <Action key={`${action.kind}-${action.label}-${index}`} action={action} onReviewActionDraft={onReviewActionDraft} />)}</div></section> : null}

      {response.contextCards?.length ? <Detail title="系统说明与操作入口" testId="ai-context-details">{response.contextCards.slice(0, 5).map((item) => <div key={item.id} className="text-[11px] leading-5"><div className="font-semibold">{item.entityLabel || item.label}</div><div style={{ color: A.gray1 }}>{item.summary}</div></div>)}</Detail> : null}

      {focused.evidence.length || focused.businessImpact.length || focused.limitations.length ? <section className="space-y-2" data-testid="ai-focused-details">
        {focused.evidence.length ? <Detail title={`查看关键证据（${Math.min(5, focused.evidence.length)}）`} testId="ai-evidence-details">{focused.evidence.map((item) => <div key={item.id} className="text-[11px] leading-5"><EvidenceLink item={item} /><div style={{ color: A.gray2 }}>{[item.status, item.value, item.sourceLabel].filter((value) => value !== undefined && value !== null && value !== "").join(" · ")}</div></div>)}</Detail> : null}
        {focused.businessImpact.length ? <Detail title="查看业务影响" testId="ai-impact-details">{focused.businessImpact.map((item) => <div key={`${item.area}-${item.impact}`} className="text-[11px] leading-5"><div className="font-semibold" style={{ color: A.label }}>{item.area} · {item.impact}</div><div style={{ color: A.gray1 }}>{item.explanation}</div></div>)}</Detail> : null}
        {focused.limitations.length ? <Detail title="查看数据限制" testId="ai-limitations-details">{focused.limitations.map((item) => <div key={item.label} className="text-[11px] leading-5"><div className="font-semibold" style={{ color: A.label }}>{item.label}</div><div style={{ color: A.gray1 }}>{item.description}</div>{item.consequence ? <div style={{ color: A.gray2 }}>{item.consequence}</div> : null}</div>)}</Detail> : null}
      </section> : null}

      {focused.followUps.length ? <section data-testid="ai-focused-follow-ups" className="flex flex-wrap gap-2">{focused.followUps.map((item) => <button key={item.prompt} type="button" onClick={() => onFollowUp?.(item.prompt)} disabled={!onFollowUp} className="rounded-full px-2.5 py-1 text-[11px] font-medium disabled:opacity-50" style={{ background: A.gray6, color: A.blue }}>{item.label}</button>)}</section> : null}
    </div>
  );
}
