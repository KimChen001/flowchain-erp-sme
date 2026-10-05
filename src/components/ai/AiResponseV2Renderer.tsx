import { RagAnswerCard } from "../../modules/ai-assistant/KnowledgeLibrary";
import { isUnavailableProductRoute } from "../../../shared/unavailable-product-routes.mjs";
import { BusinessQueryPresentation } from "./BusinessQueryPresentation";
import type { ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import type { ActionDraftPreviewRequest } from "../../modules/action-drafts/ActionDraftReviewShell";
import { structuredDraftTarget } from "../../modules/action-drafts/structuredDraftHandoff";
import type { AiResponseV2, AiResponseV2EvidenceItem, AiResponseV2NavigationLink, AiResponseV2ReviewCard, AiResponseV2Section } from "../../domain/ai/response-contract";
import { isAiCapabilityAnswer, toAiFocusedResponse, type AiFocusedAction } from "../../domain/ai/focused-response";
import { businessEntityRouteRegistry, type BusinessEntityType } from "../business/businessEntityRoutes";
import { A } from "../ui";
import { useI18n } from "../../i18n/I18n";

type Language = "en-US" | "zh-CN";
// The renderer's own labels, in the UI language. Answer text comes from the server.
const rendererCopy = {
  "en-US": {
    severity: { info: "Info", warning: "Attention", risk: "Risk", success: "OK" },
    textDraft: "Prepare text draft",
    evidenceCount: "Verifiable records {count}",
    contextCount: "System notes {count}",
    limitationCount: "Data limitations {count}",
    primaryItems: "Priorities",
    sections: "Answer by part",
    impact: "Impact: {impact}",
    nextStep: "Next step",
    contextDetails: "System notes and entry points",
    evidenceDetails: "View key evidence ({count})",
    impactDetails: "View business impact",
    limitationDetails: "View data limitations",
    limitedMode: "AI planning was unavailable, so this answer comes from the standard rules and may not cover every part of your question.",
  },
  "zh-CN": {
    severity: { info: "信息", warning: "提醒", risk: "风险", success: "正常" },
    textDraft: "生成文本草稿",
    evidenceCount: "可核验业务证据 {count}",
    contextCount: "系统说明 {count}",
    limitationCount: "数据限制 {count}",
    primaryItems: "重点事项",
    sections: "分项回答",
    impact: "影响：{impact}",
    nextStep: "下一步",
    contextDetails: "系统说明与操作入口",
    evidenceDetails: "查看关键证据（{count}）",
    impactDetails: "查看业务影响",
    limitationDetails: "查看数据限制",
    limitedMode: "AI 规划暂不可用，本回答来自标准规则，可能没有覆盖问题的每个部分。",
  },
} as const;
const fill = (template: string, values: Record<string, string | number>) => template.replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? ""));

type NavigateOptions = { returnTo?: string; entityLabel?: string; source?: string; returnContext?: unknown; query?: Record<string, string> };
type FocusTarget = { entityType: string; entityId: string; focusArea?: "exception" | "receiving" | "invoice" | "inventory" | "evidence" | "receiving-invoice-variance" };
type Navigate = (moduleId: string, focusTarget?: FocusTarget | null, options?: NavigateOptions) => void;

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

function EvidenceLink({ item, children, onNavigate }: { item: AiResponseV2EvidenceItem; children?: ReactNode; onNavigate?: Navigate }) {
  const type = entityType(item.entityType);
  const route = type ? businessEntityRouteRegistry[type] : null;
  if (!route || !item.entityId || !onNavigate || isUnavailableProductRoute(route.listRouteId)) return <span style={{ color: A.label }}>{children || item.entityLabel || item.label}</span>;
  const focusArea = type === "purchase_order" ? "evidence" : undefined;
  return <button type="button" data-action-kind="view_evidence" className="font-semibold text-blue-600 hover:underline" onClick={() => onNavigate(route.listRouteId, { entityType: type, entityId: item.entityId, focusArea }, { returnTo: "ai", entityLabel: item.entityLabel || item.entityId, source: "ai" })}>{children || item.entityLabel || item.label || item.entityId}</button>;
}

function reviewRequest(card: AiResponseV2ReviewCard): ActionDraftPreviewRequest | null {
  if (!card.draftType || !["supplier_followup_draft", "po_followup_draft", "exception_note", "inventory_exception_closure_draft"].includes(card.draftType)) return null;
  return { type: card.draftType, title: card.draftTitle || card.title, source: "ai_assistant", originEvidence: card.originEvidence || [], payload: { ...(card.payload || {}), reason: card.payload?.reason || card.description || card.allowedNextStep } , ...(card.prefill ? { prefill: card.prefill } : {}) };
}

function NavigationAction({ link, primary = false, onNavigate }: { link: AiResponseV2NavigationLink; primary?: boolean; onNavigate?: Navigate }) {
  const type = entityType(link.entityType);
  const className = primary ? "inline-flex min-h-9 items-center gap-1 rounded-lg px-3 py-2 text-xs font-semibold text-white" : "inline-flex min-h-9 items-center gap-1 rounded-lg px-3 py-2 text-xs font-semibold";
  // Frozen or unavailable surfaces are never offered as a destination.
  if (!onNavigate || isUnavailableProductRoute(link.moduleId)) return null;
  const focusTarget = link.focusTarget || (type && link.entityId ? {
    entityType: type,
    entityId: link.entityId,
    ...(type === "purchase_order" ? { focusArea: "receiving-invoice-variance" as const } : {}),
  } : null);
  return <button type="button" data-testid="ai-business-navigation-action" data-action-kind="view_business_object" data-business-id={link.entityId || ""} className={className} style={primary ? { background: A.blue } : { background: A.gray6, color: A.blue }} onClick={() => onNavigate(link.moduleId, focusTarget, { returnTo: "ai", entityLabel: link.label, source: "ai", returnContext: link.returnContext })}>{link.label}<ChevronRight size={13} /></button>;
}

function Action({ action, primary, onNavigate, onReviewActionDraft, language }: { action: AiFocusedAction; primary?: boolean; onNavigate?: Navigate; onReviewActionDraft?: (request: ActionDraftPreviewRequest) => void; language: Language }) {
  if (action.kind === "navigation") return <NavigationAction link={action.link} primary={primary} onNavigate={onNavigate} />;
  if (action.kind === "structured_draft") {
    const target = structuredDraftTarget(action.card.draftType || "", action.card.payload, "ai_assistant");
    if (!onNavigate) return null;
    return <button type="button" onClick={() => onNavigate(target.moduleId, null, { returnTo: "ai", entityLabel: action.label, source: "ai", query: target.query })} data-testid="ai-structured-draft-action" data-action-kind="create_formal_business_draft" className={primary ? "min-h-9 rounded-lg px-3 py-2 text-xs font-semibold text-white" : "min-h-9 rounded-lg px-3 py-2 text-xs font-semibold"} style={primary ? { background: A.blue } : { background: A.gray6, color: A.blue }}>{action.label}</button>;
  }
  const request = reviewRequest(action.card);
  if (!request || !onReviewActionDraft) return null;
  return <button type="button" onClick={() => onReviewActionDraft(request)} data-testid="ai-action-draft-preview" data-action-kind="generate_text_draft" className={primary ? "min-h-9 rounded-lg px-3 py-2 text-xs font-semibold text-white" : "min-h-9 rounded-lg px-3 py-2 text-xs font-semibold"} style={primary ? { background: A.blue } : { background: A.gray6, color: A.blue }}>{action.label || rendererCopy[language].textDraft}</button>;
}

// One part of a compound answer: its title and summary, in the answer
// language, and up to two of the records it cited.
function AnswerSection({ section, evidence, language, answerLanguage, onNavigate }: { section: AiResponseV2Section; evidence: AiResponseV2EvidenceItem[]; language: Language; answerLanguage?: string; onNavigate?: Navigate }) {
  const tone = section.severity in severityTone ? section.severity : "info";
  return (
    <article data-testid="ai-answer-section" data-skill={section.skillId} className="rounded-lg p-2.5" style={{ background: A.gray6 }}>
      <div className="flex items-start justify-between gap-2"><div lang={answerLanguage || undefined}><h4 className="text-xs font-semibold leading-5" style={{ color: A.label }}>{section.title}</h4>{section.summary ? <p className="mt-1 text-[11px] leading-5" style={{ color: A.gray1 }}>{section.summary}</p> : null}</div><Chip tone={tone}>{rendererCopy[language].severity[tone]}</Chip></div>
      {evidence.slice(0, 2).map((item) => <div key={item.id} className="mt-1 text-[11px] leading-5"><EvidenceLink item={item} onNavigate={onNavigate} />{item.status ? <span style={{ color: A.gray2 }}> · {item.status}</span> : null}</div>)}
    </article>
  );
}

function Detail({ title, children, testId }: { title: string; children: ReactNode; testId: string }) {
  return <details data-testid={testId} className="rounded-lg" style={{ border: `1px solid ${A.border}` }}><summary className="cursor-pointer px-3 py-2 text-xs font-semibold" style={{ color: A.gray1 }}>{title}</summary><div className="space-y-2 px-3 pb-3">{children}</div></details>;
}

export function AiResponseV2Renderer({ response, onNavigate, onReviewActionDraft, onFollowUp }: { response: AiResponseV2; onNavigate?: Navigate; onReviewActionDraft?: (request: ActionDraftPreviewRequest) => void; onFollowUp?: (prompt: string, skillHint?: string) => void }) {
  const { language: uiLanguage } = useI18n();
  const language: Language = uiLanguage === "zh-CN" ? "zh-CN" : "en-US";
  const copy = rendererCopy[language];
  if (!response || response.version !== "v2") return null;
  if (response.rag) return <RagAnswerCard rag={response.rag} title={response.conclusion.title} summary={response.conclusion.summary} />;
  const focused = toAiFocusedResponse(response, language);
  // A compound answer shows a section per part in place of the summary and
  // the priorities, which repeat the sections.
  const sections = (response.sections || []).filter((section) => Boolean(section?.title));
  const compound = sections.length > 1;
  const evidenceById = new Map((response.keyEvidence || []).map((item) => [item.id, item]));
  return (
    <div data-testid="ai-response-v2" data-answer-mode={focused.answerMode} data-answer-source={response.answerSource || undefined} className="space-y-3 rounded-xl p-3" style={{ background: A.white, border: `1px solid ${A.border}` }}>
      {response.answerSourceLabel ? <div data-testid="ai-answer-source" className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px]" style={{ color: A.gray2 }}><span className="inline-flex rounded-full px-2 py-0.5 font-semibold" style={{ background: A.gray6, color: A.gray1 }}>{response.answerSourceLabel}</span>{response.checkedLabel ? <span data-testid="ai-answer-checked">{response.checkedLabel}</span> : null}</div> : null}
      {/* A model step was tried and failed; the rules answered (limited mode). */}
      {response.agentPlanning?.status === "degraded" ? <p data-testid="ai-limited-mode" role="status" className="rounded-md px-2 py-1 text-[11px]" style={{ background: "#FDF1E3", color: "#92400E" }}>{copy.limitedMode}</p> : null}
      <section data-testid="ai-focused-conclusion">
        <div className="flex items-start justify-between gap-2"><div lang={response.language || undefined}><h3 className="text-sm font-semibold leading-5" style={{ color: A.label }}>{focused.headline}</h3>{focused.summary && !compound ? <p className="mt-1 text-xs leading-5" style={{ color: A.gray1 }}>{focused.summary}</p> : null}</div><Chip tone={focused.severity}>{copy.severity[focused.severity]}</Chip></div>
        {/* The help answer reads no records, so "0 records" would read as a failed lookup. */}
        {isAiCapabilityAnswer(response) ? null : (
          <div className="mt-2 flex gap-2 text-[11px]" style={{ color: A.gray2 }}>
            <span>{fill(copy.evidenceCount, { count: response.realEvidenceCount ?? response.keyEvidence.length })}</span>
            <span>· {fill(copy.contextCount, { count: response.contextCardCount ?? response.contextCards?.length ?? 0 })}</span>
            <span>· {fill(copy.limitationCount, { count: response.limitationCount ?? response.dataLimitations.length })}</span>
          </div>
        )}
      </section>

      <BusinessQueryPresentation response={response} />

      {compound ? <section data-testid="ai-answer-sections" className="space-y-2"><div className="text-[11px] font-semibold" style={{ color: A.gray1 }}>{copy.sections}</div>{sections.map((section) => <AnswerSection key={section.id} section={section} evidence={(section.evidenceIds || []).map((id) => evidenceById.get(id)).filter((item): item is AiResponseV2EvidenceItem => Boolean(item))} language={language} answerLanguage={response.language} onNavigate={onNavigate} />)}</section> : null}

      {!compound && focused.primaryItems.length ? <section data-testid="ai-focused-primary-items" className="space-y-2"><div className="text-[11px] font-semibold" style={{ color: A.gray1 }}>{copy.primaryItems}</div>{focused.primaryItems.map((item) => <article key={item.id} className="rounded-lg p-2.5" style={{ background: A.gray6 }}><div className="flex items-start justify-between gap-2"><div className="min-w-0 text-xs font-semibold"><EvidenceLink item={item.evidence} onNavigate={onNavigate}>{item.title}</EvidenceLink></div>{item.status ? <span className="shrink-0 text-[11px]" style={{ color: A.gray2 }}>{item.status}</span> : null}</div><p className="mt-1 text-[11px] leading-5" style={{ color: A.gray1 }}>{item.reason}</p>{item.impact ? <p className="mt-1 text-[11px] leading-5" style={{ color: A.sub }}>{fill(copy.impact, { impact: item.impact })}</p> : null}{item.nextStep || item.draft ? <div data-testid="ai-line-next-step" className="mt-2 flex flex-wrap items-center gap-2">{item.nextStep ? <span className="text-[11px] font-medium leading-5" lang={response.language || undefined} style={{ color: A.blue }}>{item.nextStep}</span> : null}{item.draft ? <Action action={item.draft} onNavigate={onNavigate} onReviewActionDraft={onReviewActionDraft} language={language} /> : null}</div> : null}</article>)}</section> : null}

      {focused.primaryAction || focused.secondaryActions.length ? <section data-testid="ai-focused-actions"><div className="text-[11px] font-semibold" style={{ color: A.gray1 }}>{copy.nextStep}</div><div className="mt-2 flex flex-wrap gap-2">{focused.primaryAction ? <Action action={focused.primaryAction} primary onNavigate={onNavigate} onReviewActionDraft={onReviewActionDraft} language={language} /> : null}{focused.secondaryActions.map((action, index) => <Action key={`${action.kind}-${action.label}-${index}`} action={action} onNavigate={onNavigate} onReviewActionDraft={onReviewActionDraft} language={language} />)}</div></section> : null}

      {response.contextCards?.length ? <Detail title={copy.contextDetails} testId="ai-context-details">{response.contextCards.slice(0, 5).map((item) => <div key={item.id} className="text-[11px] leading-5"><div className="font-semibold">{item.entityLabel || item.label}</div><div style={{ color: A.gray1 }}>{item.summary}</div></div>)}</Detail> : null}

      {focused.evidence.length || focused.businessImpact.length || focused.limitations.length ? <section className="space-y-2" data-testid="ai-focused-details">
        {focused.evidence.length ? <Detail title={fill(copy.evidenceDetails, { count: Math.min(5, focused.evidence.length) })} testId="ai-evidence-details">{focused.evidence.map((item) => <div key={item.id} className="text-[11px] leading-5"><EvidenceLink item={item} onNavigate={onNavigate} /><div style={{ color: A.gray2 }}>{[item.status, item.value, item.sourceLabel].filter((value) => value !== undefined && value !== null && value !== "").join(" · ")}</div></div>)}</Detail> : null}
        {focused.businessImpact.length ? <Detail title={copy.impactDetails} testId="ai-impact-details">{focused.businessImpact.map((item, index) => <div key={`${index}-${item.area}-${item.impact}`} className="text-[11px] leading-5"><div className="font-semibold" style={{ color: A.label }}>{item.area} · {item.impact}</div><div style={{ color: A.gray1 }}>{item.explanation}</div></div>)}</Detail> : null}
        {focused.limitations.length ? <Detail title={copy.limitationDetails} testId="ai-limitations-details">{focused.limitations.map((item) => <div key={item.label} className="text-[11px] leading-5"><div className="font-semibold" style={{ color: A.label }}>{item.label}</div><div style={{ color: A.gray1 }}>{item.description}</div>{item.consequence ? <div style={{ color: A.gray2 }}>{item.consequence}</div> : null}</div>)}</Detail> : null}
      </section> : null}

      {response.supplementalKnowledge && <RagAnswerCard rag={response.supplementalKnowledge.rag} title={response.supplementalKnowledge.title} summary={response.supplementalKnowledge.summary} />}
      {focused.followUps.length ? <section data-testid="ai-focused-follow-ups" className="flex flex-wrap gap-2">{focused.followUps.map((item) => <button key={item.prompt} type="button" onClick={() => onFollowUp?.(item.prompt, item.skillHint)} disabled={!onFollowUp} className="rounded-full px-2.5 py-1 text-[11px] font-medium disabled:opacity-50" style={{ background: A.gray6, color: A.blue }}>{item.label}</button>)}</section> : null}
    </div>
  );
}
