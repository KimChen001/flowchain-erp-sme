import { KnowledgeLibrary } from "./KnowledgeLibrary";
import { useI18n } from "../../i18n/I18n";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { BookOpen, Clock3, FilePlus2, ListChecks, Loader2, Maximize2, MessageSquareText, Minimize2, MoreHorizontal, RotateCcw, Send, Square, SquarePen, Sparkles, X, type LucideIcon } from "lucide-react";
import type { CanonicalFocusTarget } from "../../lib/evidenceLinks";
import { A } from "../../components/ui";
import { AiResponseV2Renderer } from "../../components/ai/AiResponseV2Renderer";
import type { ActionDraftPreviewRequest } from "../action-drafts/ActionDraftReviewShell";
import type { AiResponseV2 } from "../../domain/ai/response-contract";
import { autoOpenDraftCard, structuredDraftTarget } from "../action-drafts/structuredDraftHandoff";
import { focusTargetFromActiveContext, postAiRuntimeResponse, type AiRuntimeProgress } from "./aiRuntimeGateway";
import { ApiError } from "../../lib/api-client";
import { aiProgressLine, looksLikeRawJson, sanitizeAiMessage } from "./presentation";

export type ActiveContext = {
  module?: string;
  entityType?: "supplier" | "item" | "rfq" | "purchase_request" | "purchase_order" | "sales_order";
  entityId?: string;
  entityLabel?: string;
  view?: string;
  route?: string;
};

type AiChatMessage = {
  role: "user" | "assistant";
  content: string;
  cards?: AiChatCard[];
  retryPrompt?: string;
  // The skill the failed question asked for, so a retry asks for it again.
  retrySkillHint?: string;
};

type AiChatCard = {
  type?: string;
  data?: Record<string, unknown>;
  actions?: {
    label?: string;
    kind?: string;
    target?: string;
    draftType?: string;
    draftTitle?: string;
    payload?: Record<string, unknown>;
    originEvidence?: Record<string, unknown>[];
  }[];
  evidence?: { type?: string; id?: string; label?: string; status?: string; route?: string; summary?: string }[];
};

type AiNavigateOptions = {
  returnTo?: string;
  entityLabel?: string;
  source?: string;
  returnContext?: unknown;
  query?: Record<string, string>;
};

type AiNavigate = (moduleId: string, focusTarget?: CanonicalFocusTarget | null, options?: AiNavigateOptions) => void;

type AiSessionGrounding = {
  lastIntent?: string;
  lastPrimaryEntity?: { type?: string; id?: string; label?: string } | null;
  lastEvidenceIds?: string[];
  lastVisibleBusinessIds?: Record<string, string[]>;
  activeContext?: ActiveContext | null;
};

type SafeConversationContext = {
  previousIntent?: string;
  previousQuestion?: string;
  previousConclusionTitle?: string;
  previousEntityRefs?: Array<{ entityType?: string; entityId?: string; entityLabel: string; source: string; confidence: string }>;
  previousNavigationRefs?: Array<{ label: string; moduleId?: string; entityType?: string; entityId?: string; entityLabel?: string; returnTo: "ai-assistant" }>;
  previousEvidenceRefs?: Array<{ id?: string; label?: string; entityType?: string; entityId?: string; entityLabel?: string; moduleId?: string }>;
  // The records of the latest answer that listed several, so "the second one"
  // still means that list after a "why?" about one of them.
  previousListRefs?: Array<{ id?: string; label?: string; entityType?: string; entityId?: string; entityLabel?: string; moduleId?: string }>;
  previousModuleId?: string;
  previousViewId?: string;
  previousFocusTarget?: { entityType?: string; entityId?: string; entityLabel?: string } | null;
  breadcrumbTrail?: Array<{ label: string; moduleId?: string; entityLabel?: string; returnTo: "ai-assistant" }>;
  lastResponseId?: string;
  returnContext?: { returnTo: "ai-assistant"; returnLabel: string; sourceModuleId?: string; sourceViewId?: string };
  // The last few questions and answers of this panel, as text, so the
  // model-first assistant reads a follow-up with what came before.
  previousTurns?: Array<{ question: string; answer: string }>;
};

// The welcome cards (owner-approved panel design, 2026-11-01): what to handle
// first, overdue orders, a purchase request draft, and the purchasing policy.
export const AI_EMPTY_STATE_PROMPT_CHIPS = [
  { label: "What should I handle first today?", prompt: "What should I handle first today?", zhLabel: "今天先处理什么？", zhPrompt: "今天先处理什么？" },
  { label: "Which purchase orders are overdue?", prompt: "Which purchase orders are overdue?", zhLabel: "哪些采购订单逾期了？", zhPrompt: "哪些采购订单逾期了？" },
  { label: "Draft a purchase request", prompt: "Draft a purchase request", zhLabel: "帮我起草一份采购申请", zhPrompt: "帮我起草一份采购申请" },
  { label: "What does our purchasing policy say?", prompt: "What does our purchasing policy say?", zhLabel: "公司的采购制度是怎么规定的？", zhPrompt: "公司的采购制度是怎么规定的？" },
];

// The workspace skill each card asks for, by card position; the hint only
// tells the server which skill to run. The request and policy cards have none:
// they are asked as typed, so the request asks which item and the policy
// question goes to the company documents.
const EMPTY_STATE_SKILL_HINTS = ["today_priorities", "purchase_orders", "", ""];
const EMPTY_STATE_ICONS: LucideIcon[] = [ListChecks, Clock3, FilePlus2, BookOpen];
const PO_SKILL_HINTS = ["today_priorities", "records_needing_data", "highest_risk_items", "prepare_action_draft"];
const SKU_SKILL_HINTS = ["today_priorities", "inventory_availability", "highest_risk_items", "prepare_action_draft"];

const PO_EMPTY_PROMPTS = {
  "en-US": ["Why does this PO need attention?", "Which receipt or invoice evidence is missing?", "What will a delay affect?", "What should happen next?"],
  "zh-CN": ["这个 PO 为什么需要关注？", "还差哪些收货或发票证据？", "延误会影响什么？", "建议下一步是什么？"],
};
const SKU_EMPTY_PROMPTS = {
  "en-US": ["Does this SKU need replenishment?", "What is the available inventory?", "Which orders will be affected?", "What action is recommended?"],
  "zh-CN": ["这个 SKU 需要补货吗？", "当前可用库存是多少？", "哪些订单会受影响？", "建议如何处理？"],
};

function requestScopeLabel(message: string, language: "en-US" | "zh-CN") {
  if (/\bPOs?\b|PO-|采购订单|收货|GRN|发票|匹配/i.test(message)) return language === "zh-CN" ? "正在查询业务数据：采购订单、收货和发票记录" : "Checking purchase orders, receipts, and invoice records";
  if (/库存|SKU|补货|可用量|inventory|replenish/i.test(message)) return language === "zh-CN" ? "正在查询业务数据：库存余额和关联订单" : "Checking inventory balances and related orders";
  if (/供应商|RFQ|报价|supplier|quote/i.test(message)) return language === "zh-CN" ? "正在查询业务数据：供应商和询报价记录" : "Checking supplier and sourcing records";
  if (/今天|重点|风险|待办|today|risk|priority/i.test(message)) return language === "zh-CN" ? "正在查询业务数据：当前工作区重点事项" : "Checking current workspace priorities";
  return language === "zh-CN" ? "正在查询业务数据：当前工作区记录" : "Checking your workspace records";
}

const CONTEXT_ENTITY_LABELS: Record<string, { "en-US": string; "zh-CN": string }> = {
  purchase_order: { "en-US": "Purchase order", "zh-CN": "采购单" },
  item: { "en-US": "Inventory SKU", "zh-CN": "库存 SKU" },
  rfq: { "en-US": "RFQ", "zh-CN": "询价单" },
  supplier: { "en-US": "Supplier", "zh-CN": "供应商" },
  purchase_request: { "en-US": "Purchase request", "zh-CN": "采购申请" },
  sales_order: { "en-US": "Sales order", "zh-CN": "客户订单" },
};
// What the assistant answers about: always the whole workspace, which page or
// module is open does not change it. On a record's page the record is named
// too, since "this PO" then means it; the chip's clear button sets it aside.
export function getAiContextLabel(activeContext?: ActiveContext | null, language: "en-US" | "zh-CN" = "en-US") {
  const workspace = language === "zh-CN" ? "整个工作区" : "Whole workspace";
  if (!activeContext?.entityId) return workspace;
  const label = CONTEXT_ENTITY_LABELS[activeContext.entityType || ""]?.[language] || (language === "zh-CN" ? "业务对象" : "Business record");
  return `${workspace} · ${language === "zh-CN" ? "本页：" : "this page: "}${label} ${activeContext.entityLabel || activeContext.entityId}`;
}

// How the placeholder names the page's record. The assistant answers about the
// whole workspace; it uses this record only when the question says "this ...".
const CONTEXT_ENTITY_PHRASES: Record<string, { "en-US": string; "zh-CN": string }> = {
  purchase_order: { "en-US": "this PO", "zh-CN": "这个 PO" },
  item: { "en-US": "this SKU", "zh-CN": "这个 SKU" },
  rfq: { "en-US": "this RFQ", "zh-CN": "这个 RFQ" },
  supplier: { "en-US": "this supplier", "zh-CN": "这个供应商" },
  sales_order: { "en-US": "this sales order", "zh-CN": "这个客户订单" },
  purchase_request: { "en-US": "this purchase request", "zh-CN": "这个采购申请" },
};

// The same on every page; a record's page only offers the record as well.
export function getAiInputPlaceholder(activeContext?: ActiveContext | null, language: "en-US" | "zh-CN" = "en-US") {
  const zh = language === "zh-CN";
  const phrase = CONTEXT_ENTITY_PHRASES[activeContext?.entityType || ""]?.[language];
  if (phrase) return zh ? `问点什么（也可以问${phrase}），或让我帮你做…` : `Ask about ${phrase} or anything else, or tell me what to do…`;
  return zh ? "问点什么，或让我帮你做…" : "Ask a question, or tell me what to do…";
}

// The greeting's name: a Chinese name whole, else the first name.
export function aiGreetingName(name?: string | null) {
  const value = String(name || "").trim();
  if (!value) return "";
  return /[㐀-鿿]/.test(value) ? value : value.split(/\s+/)[0];
}

// Wide enough to sit beside the page: the panel docks to the right and the
// page narrows. Narrower, it covers the page (a drawer, full screen on phones).
const DOCK_QUERY = "(min-width: 1024px)";
function useDocked() {
  const [docked, setDocked] = useState(() => typeof window !== "undefined" && Boolean(window.matchMedia?.(DOCK_QUERY).matches));
  useEffect(() => {
    const media = window.matchMedia?.(DOCK_QUERY);
    if (!media) return;
    const update = () => setDocked(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  return docked;
}

function textValue(value: unknown) {
  if (typeof value === "boolean") return value ? "是" : "否";
  if (typeof value === "number") return Number.isFinite(value) ? value.toLocaleString() : "";
  if (typeof value === "object") return "";
  if (typeof value === "string") return sanitizeAiMessage(value);
  return String(value ?? "");
}

function arrayValue(value: unknown) {
  return Array.isArray(value) ? value : [];
}

// Answers arrive from /api/ai-runtime/respond as ai_response_v2 cards; the
// panel creates no other card type.
function AiResponseCard({
  card,
  latest,
  onNavigate,
  onReviewActionDraft,
  onFollowUp,
}: {
  card: AiChatCard;
  latest: boolean;
  onNavigate?: AiNavigate;
  onReviewActionDraft?: (request: ActionDraftPreviewRequest) => void;
  onFollowUp?: (prompt: string, skillHint?: string) => void;
}) {
  if (card.type !== "ai_response_v2") return null;
  return (
    <AiResponseV2Renderer
      response={(card.data || {}) as unknown as AiResponseV2}
      latest={latest}
      onNavigate={onNavigate}
      onReviewActionDraft={onReviewActionDraft}
      onFollowUp={onFollowUp}
    />
  );
}

function businessTypeFromId(id = "") {
  if (/^PO-/i.test(id)) return "po";
  if (/^PR-/i.test(id)) return "pr";
  if (/^RFQ-/i.test(id)) return "rfq";
  if (/^GRN-/i.test(id)) return "grn";
  if (/^INV-/i.test(id)) return "invoice";
  if (/^SKU-/i.test(id)) return "sku";
  return "";
}

function visibleBusinessId(...values: unknown[]) {
  for (const value of values) {
    const found = String(value ?? "").match(/\b(?:PO|PR|RFQ|GRN|INV|SKU)-[A-Z0-9-]+\b/i)?.[0];
    if (found) return found.toUpperCase();
  }
  return "";
}

function collectBusinessIdsFromCards(cards: AiChatCard[] = []) {
  const grouped: Record<string, string[]> = {};
  const push = (id: unknown) => {
    const value = String(id ?? "").trim().toUpperCase();
    const type = businessTypeFromId(value);
    if (!type) return;
    grouped[type] = grouped[type] || [];
    if (!grouped[type].includes(value)) grouped[type].push(value);
  };
  for (const card of cards) {
    if (card.type === "ai_response_v2") {
      const response = card.data as Record<string, unknown>;
      for (const item of arrayValue(response.keyEvidence)) {
        if (item && typeof item === "object") {
          const row = item as Record<string, unknown>;
          push(row.entityId);
          push(visibleBusinessId(row.entityId, row.entityLabel, row.label, row.summary));
        }
      }
      for (const item of arrayValue(response.navigationLinks)) {
        if (item && typeof item === "object") {
          const row = item as Record<string, unknown>;
          push(row.entityId);
          push(visibleBusinessId(row.entityId, row.label, row.reason));
        }
      }
    }
    for (const evidence of card.evidence || []) {
      push(evidence.id);
      push(visibleBusinessId(evidence.id, evidence.route, evidence.label, evidence.summary));
    }
    for (const action of card.actions || []) {
      push(String(action.target || "").match(/\b(?:PO|PR|RFQ|GRN|INV|SKU)-[A-Z0-9-]+\b/i)?.[0]);
      for (const evidence of action.originEvidence || []) {
        push(evidence.id);
        push(visibleBusinessId(evidence.id, evidence.route, evidence.label, evidence.summary));
      }
    }
    const data = card.data || {};
    Object.values(data).forEach((value) => {
      if (typeof value === "string") push(value.match(/\b(?:PO|PR|RFQ|GRN|INV|SKU)-[A-Z0-9-]+\b/i)?.[0]);
    });
  }
  return grouped;
}

function primaryEntityFromCards(cards: AiChatCard[] = []) {
  for (const card of cards) {
    if (card.type !== "ai_response_v2") continue;
    const response = card.data as Record<string, unknown>;
    const firstEvidence = arrayValue(response.keyEvidence).find((item) => item && typeof item === "object") as Record<string, unknown> | undefined;
    const id = visibleBusinessId(firstEvidence?.entityId, firstEvidence?.entityLabel, firstEvidence?.label, firstEvidence?.summary);
    if (id) return { type: businessTypeFromId(id), id, label: id };
  }
  for (const card of cards) {
    const data = card.data || {};
    const priorityItems = arrayValue(data.priorityItems);
    const firstPriority = priorityItems.find((item) => item && typeof item === "object") as Record<string, unknown> | undefined;
    const priorityId = firstPriority
      ? visibleBusinessId(firstPriority.id, firstPriority.sourceDocument, firstPriority.title, firstPriority.reason, firstPriority.explanation)
      : "";
    if (priorityId) return { type: businessTypeFromId(priorityId), id: priorityId, label: priorityId };
  }
  for (const card of cards) {
    for (const evidence of card.evidence || []) {
      const id = visibleBusinessId(evidence.id, evidence.route, evidence.label, evidence.summary);
      if (id) return { type: businessTypeFromId(id), id, label: id };
    }
  }
  return null;
}

function buildSessionGrounding(messages: AiChatMessage[], activeContext: ActiveContext | null): AiSessionGrounding {
  const assistant = [...messages].reverse().find((message) => message.role === "assistant" && message.cards?.length);
  const cards = assistant?.cards || [];
  const lastVisibleBusinessIds = collectBusinessIdsFromCards(cards);
  const lastEvidenceIds = Object.values(lastVisibleBusinessIds).flat().slice(0, 12);
  const primaryType = Object.keys(lastVisibleBusinessIds).find((type) => lastVisibleBusinessIds[type]?.length === 1);
  const primaryId = primaryType ? lastVisibleBusinessIds[primaryType]?.[0] : "";
  const primaryEntity = primaryEntityFromCards(cards);
  return {
    // The skill or plan that answered, not the card type.
    lastIntent: typeof cards[0]?.data?.intent === "string" ? cards[0].data.intent : cards[0]?.type,
    lastPrimaryEntity: primaryEntity || (primaryId ? { type: primaryType, id: primaryId, label: primaryId } : null),
    lastEvidenceIds,
    lastVisibleBusinessIds,
    activeContext,
  };
}

function safeEntityType(value: unknown) {
  const raw = String(value || "");
  if (/purchase_order|PO/i.test(raw)) return "PO";
  if (/purchase_request|PR/i.test(raw)) return "PR";
  if (/rfq/i.test(raw)) return "RFQ";
  if (/receiving|GRN/i.test(raw)) return "GRN";
  if (/invoice|发票/i.test(raw)) return "Invoice";
  if (/supplier|供应商/i.test(raw)) return "Supplier";
  if (/inventory|item|SKU/i.test(raw)) return "SKU";
  return "Unknown";
}

function aiRuntimeResponses(messages: AiChatMessage[]): AiResponseV2[] {
  return messages.flatMap((message) => message.role === "assistant" ? (message.cards || []).filter((card) => card.type === "ai_response_v2" && card.data).map((card) => card.data as unknown as AiResponseV2) : []);
}

function latestAiRuntimeResponse(messages: AiChatMessage[]): AiResponseV2 | null {
  return aiRuntimeResponses(messages).at(-1) || null;
}

// Up to three earlier turns: each question with the headline and summary of
// the answer that followed it.
function previousTurns(messages: AiChatMessage[]) {
  const turns: Array<{ question: string; answer: string }> = [];
  messages.forEach((message, index) => {
    if (message.role !== "user") return;
    const reply = messages[index + 1];
    const response = reply?.role === "assistant" ? (reply.cards || []).find((card) => card.type === "ai_response_v2" && card.data)?.data as unknown as AiResponseV2 | undefined : undefined;
    if (!response) return;
    const answer = [response.conclusion?.title, response.conclusion?.summary].filter(Boolean).join(" — ");
    turns.push({ question: message.content.slice(0, 300), answer: answer.slice(0, 800) });
  });
  return turns.slice(-3);
}

function evidenceRefs(response: AiResponseV2 | null | undefined) {
  return (response?.keyEvidence || []).slice(0, 8).map((item) => ({
    id: item.id,
    label: item.label,
    entityType: safeEntityType(item.entityType || item.entityId),
    entityId: item.entityId,
    entityLabel: item.entityLabel,
    moduleId: item.moduleId,
  }));
}

function buildSafeConversationContext(messages: AiChatMessage[], activeContext: ActiveContext | null, sessionGrounding: AiSessionGrounding, language: "en-US" | "zh-CN" = "en-US"): SafeConversationContext {
  const response = latestAiRuntimeResponse(messages);
  const refs: SafeConversationContext["previousEntityRefs"] = [];
  const pushRef = (input: { entityType?: unknown; entityId?: unknown; entityLabel?: unknown; source: string; confidence?: string }) => {
    const entityLabel = textValue(input.entityLabel || input.entityId);
    if (!entityLabel) return;
    const entityId = textValue(input.entityId);
    const key = `${input.source}:${entityId || entityLabel}`;
    if (refs.some((item) => `${item.source}:${item.entityId || item.entityLabel}` === key)) return;
    refs.push({
      entityType: safeEntityType(input.entityType || entityId || entityLabel),
      entityId,
      entityLabel,
      source: input.source,
      confidence: input.confidence || (entityId ? "high" : "medium"),
    });
  };

  if (activeContext?.entityId || activeContext?.entityLabel) {
    pushRef({ entityType: activeContext.entityType, entityId: activeContext.entityId, entityLabel: activeContext.entityLabel, source: "activePage", confidence: "high" });
  }
  if (sessionGrounding.lastPrimaryEntity) {
    pushRef({ entityType: sessionGrounding.lastPrimaryEntity.type, entityId: sessionGrounding.lastPrimaryEntity.id, entityLabel: sessionGrounding.lastPrimaryEntity.label, source: "session", confidence: "high" });
  }
  for (const item of response?.keyEvidence || []) {
    pushRef({ entityType: item.entityType, entityId: item.entityId, entityLabel: item.entityLabel || item.label, source: "evidence", confidence: "high" });
  }
  for (const link of response?.navigationLinks || []) {
    const navEntityType = link.entityType;
    const navEntityId = link.entityId;
    const navLabel = link.label;
    pushRef({ entityType: navEntityType, entityId: navEntityId, entityLabel: navLabel || navEntityId, source: "navigation", confidence: navEntityId ? "high" : "medium" });
  }
  for (const card of response?.reviewCards || []) {
    pushRef({ entityType: card.targetEntityType, entityId: card.targetEntityId, entityLabel: card.title, source: "reviewCard", confidence: card.targetEntityId ? "high" : "medium" });
  }

  return {
    previousIntent: response?.intent || sessionGrounding.lastIntent,
    previousQuestion: response?.query,
    previousConclusionTitle: response?.conclusion?.title,
    previousEntityRefs: refs.slice(0, 12),
    previousNavigationRefs: (response?.navigationLinks || []).slice(0, 8).map((link) => {
      const navEntityType = link.entityType;
      const navEntityId = link.entityId;
      const navLabel = link.label;
      return {
        label: textValue(navLabel || navEntityId || link.moduleId),
        moduleId: link.moduleId,
        entityType: safeEntityType(navEntityType || navEntityId || navLabel),
        entityId: textValue(navEntityId),
        entityLabel: textValue(navLabel || navEntityId),
        returnTo: "ai-assistant",
      };
    }),
    previousEvidenceRefs: evidenceRefs(response),
    previousListRefs: evidenceRefs([...aiRuntimeResponses(messages)].reverse().find((item) => (item.keyEvidence || []).length > 1)),
    previousModuleId: response?.scope?.module || activeContext?.module,
    previousViewId: activeContext?.view,
    previousFocusTarget: activeContext?.entityId ? {
      entityType: activeContext.entityType,
      entityId: activeContext.entityId,
      entityLabel: activeContext.entityLabel || activeContext.entityId,
    } : null,
    breadcrumbTrail: (response?.contextBreadcrumbs || []).slice(0, 4).map((item) => ({
      label: item.label,
      moduleId: item.moduleId,
      entityLabel: item.entityLabel,
      returnTo: "ai-assistant",
    })),
    lastResponseId: (response as (AiResponseV2 & { responseId?: string }) | null)?.responseId,
    previousTurns: previousTurns(messages),
    returnContext: {
      returnTo: "ai-assistant",
      returnLabel: language === "zh-CN" ? "返回 AI 助手" : "Back to AI assistant",
      sourceModuleId: activeContext?.module,
      sourceViewId: activeContext?.view,
    },
  };
}

function uniqueFollowUpChips(chips: { label: string; prompt: string }[]) {
  const seen = new Set<string>();
  return chips.filter((chip) => {
    const key = `${chip.label}|${chip.prompt}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 3);
}

type AiRecoveryReason = "signed_out" | "invalid_question" | "unavailable" | "timeout" | "network";

// Why a request failed, from the server's status and code. A 400 shows the
// server's own message, which is already in the question's language.
export function aiRecoveryReason(error: unknown, timedOut: boolean): { reason: AiRecoveryReason; serverMessage?: string } {
  if (timedOut) return { reason: "timeout" };
  if (error instanceof ApiError) {
    if (error.status === 401) return { reason: "signed_out" };
    if (error.status === 400) return { reason: "invalid_question", serverMessage: error.payload?.error || error.message };
    return { reason: "unavailable" };
  }
  return { reason: "network" };
}

const RECOVERY_COPY = {
  "en-US": {
    heading: "Assistant · Your workspace data · Review first",
    conclusion: "Conclusion",
    evidence: "Where to look",
    next: "Next step",
    boundary: "Review boundary",
    reasons: {
      signed_out: "Your session has ended. Sign in again, then ask again.",
      invalid_question: "The question could not be answered as asked.",
      unavailable: "The assistant could not read your workspace data just now. Nothing was changed.",
      timeout: "The assistant took too long to answer. Nothing was changed.",
      network: "The assistant could not be reached. Check your connection. Nothing was changed.",
    },
    topics: { receiving: "Receiving exceptions, purchase orders and invoice matching", inventory: "Inventory items, SKU risk and replenishment", po: "Purchase orders, receipts and supplier evidence", other: "Home, inventory and source records" },
    where: "{topic} can be reviewed from Home, Inventory, Receiving, Purchase orders and Finance.",
    nextStep: "Retry, or open the related module to review the source records. Drafts always go to human review.",
    boundaryLine: "Draft preview · Human review · Nothing is submitted, sent, posted or paid",
  },
  "zh-CN": {
    heading: "证据辅助回答 · 当前工作区数据 · 复核优先",
    conclusion: "结论",
    evidence: "关键证据",
    next: "建议动作",
    boundary: "人工复核边界",
    reasons: {
      signed_out: "登录已失效，请重新登录后再提问。",
      invalid_question: "当前问题无法按原样回答。",
      unavailable: "当前工作区数据暂时未能完整读取，仍可先从相关模块查看来源证据并进入人工复核。",
      timeout: "AI 助手响应超时，未修改任何数据。",
      network: "暂时无法连接 AI 助手，请检查网络。未修改任何数据。",
    },
    topics: { receiving: "收货异常、采购订单和发票匹配", inventory: "库存项目、SKU 风险和补货建议", po: "采购订单、收货和供应商证据", other: "首页、库存管理和来源证据" },
    where: "{topic} 可从首页、库存管理、收货记录、采购订单和结算管理继续查看。",
    nextStep: "打开今日行动或相关模块查看来源证据，必要时预览草稿并交由人工复核。",
    boundaryLine: "草稿预览 · 人工复核 · 不提交 · 不外发 · 不写库存 · 不写财务凭证 · 不处理资金 · 不改主数据",
  },
} as const;

export function displaySafeAssistantRecoveryMessage(prompt: string, language: "en-US" | "zh-CN" = "en-US", failure: { reason: AiRecoveryReason; serverMessage?: string } = { reason: "unavailable" }) {
  const copy = RECOVERY_COPY[language];
  const topicKey = /收货|GRN|到货|receiv/i.test(prompt)
    ? "receiving"
    : /库存|SKU|补货|可用量|可承诺量|inventory|stock|replenish/i.test(prompt)
      ? "inventory"
      : /\bPOs?\b|PO-|采购订单|purchase order/i.test(prompt)
        ? "po"
        : "other";
  const conclusion = failure.reason === "invalid_question" && failure.serverMessage ? failure.serverMessage : copy.reasons[failure.reason];
  return [
    copy.heading,
    "",
    copy.conclusion,
    conclusion,
    "",
    copy.evidence,
    copy.where.replace("{topic}", copy.topics[topicKey]),
    "",
    copy.next,
    copy.nextStep,
    "",
    copy.boundary,
    copy.boundaryLine,
  ].join("\n");
}

function hasRuntimeFollowUpSuggestions(message: AiChatMessage) {
  return Boolean(message.cards?.some((card) =>
    card.type === "ai_response_v2"
    && Array.isArray((card.data as AiResponseV2 | undefined)?.followUpSuggestions)
    && ((card.data as AiResponseV2 | undefined)?.followUpSuggestions || []).length > 0
  ));
}

export function getAiFollowUpChips(message: AiChatMessage, language: "en-US" | "zh-CN" = "zh-CN") {
  if (message.role !== "assistant" || !message.cards?.length) return [];
  if (hasRuntimeFollowUpSuggestions(message)) return [];
  if (message.cards.some((card) => card.type === "ai_response_v2" && (card.data as AiResponseV2 | undefined)?.rag?.mode === "no_results")) return [];
  // The chips follow the answer's language (a Chinese question in the English
  // interface gets Chinese chips), else the interface language.
  const answerLanguage = message.cards.map((card) => (card.data as AiResponseV2 | undefined)?.language).find((value) => value === "en-US" || value === "zh-CN");
  const zh = (answerLanguage || language) === "zh-CN";
  const localizedChip = (zhLabel: string, enLabel: string, zhPrompt: string, enPrompt: string) => ({
    label: zh ? zhLabel : enLabel,
    prompt: zh ? zhPrompt : enPrompt,
  });
  const ids = collectBusinessIdsFromCards(message.cards);
  const firstPo = ids.po?.[0] || "";
  const firstSku = ids.sku?.[0] || "";
  const firstRfq = ids.rfq?.[0] || "";
  const cardTypes = new Set(message.cards.map((card) => card.type || ""));
  const chips: { label: string; prompt: string }[] = [];

  if (cardTypes.has("ai_response_v2")) {
    if (firstPo) chips.push(localizedChip("为什么这个 PO 优先？", "Why is this PO a priority?", "这个 PO 为什么优先？", "Why is this PO a priority?"));
    if (firstSku) chips.push(localizedChip("查看关联 SKU", "View related SKU", "这个 SKU 和哪些单据有关？", "Which records are related to this SKU?"));
    chips.push(localizedChip("哪些数据不完整？", "Which data is incomplete?", "哪些数据依据不完整？", "Which supporting data is incomplete?"));
  }
  if (firstSku) {
    chips.push(localizedChip("需要补货吗？", "Does it need replenishment?", "这个 SKU 需要补货吗？", "Does this SKU need replenishment?"));
    chips.push(localizedChip("关联哪些采购单？", "Which purchase orders?", "这个 SKU 关联哪些采购单？", "Which purchase orders are related to this SKU?"));
    chips.push(localizedChip("预览补货 PR 草稿", "Preview replenishment PR", "预览补货 PR 草稿", "Preview a replenishment purchase request draft"));
  }
  if (firstRfq) {
    chips.push(localizedChip("有几家回复了？", "How many suppliers replied?", "刚才那个 RFQ 有几家回复了？", "How many suppliers replied to that RFQ?"));
    chips.push(localizedChip("谁还没回复？", "Who has not replied?", "谁还没回复这个 RFQ？", "Who has not replied to this RFQ?"));
    chips.push(localizedChip("预览供应商提醒草稿", "Preview supplier reminder", "预览供应商提醒草稿", "Preview a supplier reminder draft"));
  }

  return uniqueFollowUpChips(chips);
}

function AiResponseCards({
  cards = [],
  latest = true,
  onNavigate,
  onReviewActionDraft,
  onFollowUp,
}: {
  cards?: AiChatCard[];
  latest?: boolean;
  onNavigate?: AiNavigate;
  onReviewActionDraft?: (request: ActionDraftPreviewRequest) => void;
  onFollowUp?: (prompt: string, skillHint?: string) => void;
}) {
  const visibleCards = cards.filter((card) => card.type);
  if (!visibleCards.length) return null;
  return (
    <div className="space-y-3">
      {visibleCards.map((card, index) => (
        <AiResponseCard key={`${card.type}-${index}`} card={card} latest={latest} onNavigate={onNavigate} onReviewActionDraft={onReviewActionDraft} onFollowUp={onFollowUp} />
      ))}
    </div>
  );
}

function HeaderButton({ label, onClick, children, testId, expanded }: { label: string; onClick: () => void; children: ReactNode; testId?: string; expanded?: boolean }) {
  return (
    <button type="button" onClick={onClick} data-testid={testId} aria-label={label} title={label} aria-expanded={expanded} className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg hover:bg-slate-100" style={{ color: A.gray1 }}>
      {children}
    </button>
  );
}

function cleanActiveContext(context?: ActiveContext | null) {
  if (!context?.entityType || !context.entityId) return null;
  return {
    module: context.module,
    entityType: context.entityType,
    entityId: context.entityId,
    entityLabel: context.entityLabel,
    view: context.view,
    route: context.route,
  };
}

export default function FloatingAiAssistant({
  moduleId,
  activeContext,
  openSignal,
  userName,
  onNavigate,
  onReviewActionDraft,
}: {
  moduleId: string;
  activeContext?: ActiveContext | null;
  openSignal?: number;
  userName?: string | null;
  onNavigate?: AiNavigate;
  onReviewActionDraft?: (request: ActionDraftPreviewRequest) => void;
}) {
  const { language } = useI18n();
  const zh = language === "zh-CN";
  const docked = useDocked();
  const [knowledgeOpen, setKnowledgeOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [input, setInput] = useState("");
  const [asking, setAsking] = useState(false);
  const [slowRequest, setSlowRequest] = useState(false);
  // What the model-first assistant is reading, while it answers a typed question.
  const [progress, setProgress] = useState<AiRuntimeProgress | null>(null);
  const [messages, setMessages] = useState<AiChatMessage[]>([]);
  const [dismissedContextKey, setDismissedContextKey] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const restoreButtonRef = useRef<HTMLButtonElement>(null);
  const requestInFlightRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  const requestSeqRef = useRef(0);
  const abortReasonRef = useRef<"timeout" | "superseded" | "unmount" | null>(null);

  useEffect(() => {
    if (openSignal) setOpen(true);
  }, [openSignal]);

  const minimizeAssistant = () => setOpen(false);
  const restoreAssistant = () => setOpen(true);
  // Docked beside the page, the assistant stays open next to the record it
  // opened; covering the page, it gets out of the way.
  const minimizeAfterNavigate: AiNavigate = (moduleId, focusTarget, options) => {
    onNavigate?.(moduleId, focusTarget || null, { source: "ai", returnTo: activeContext?.route || moduleId, ...options });
    if (!docked) minimizeAssistant();
  };

  useEffect(() => {
    if (open && docked) inputRef.current?.focus();
  }, [open, docked]);

  // A new answer is shown from its first line, where it says what matters
  // most (for an order, what is already on order), not scrolled to its end.
  // Anything else (a question, the loading line) scrolls to the end.
  useEffect(() => {
    if (!open) return;
    const area = scrollRef.current;
    if (!area) return;
    const answers = area.querySelectorAll<HTMLElement>('[data-testid="ai-message-assistant"]');
    const latest = !asking && messages.at(-1)?.role === "assistant" ? answers[answers.length - 1] : null;
    const top = latest ? area.scrollTop + latest.getBoundingClientRect().top - area.getBoundingClientRect().top - 12 : area.scrollHeight;
    area.scrollTo({ top, behavior: "smooth" });
  }, [messages, open, asking]);

  useEffect(() => {
    return () => {
      abortReasonRef.current = "unmount";
      abortRef.current?.abort();
    };
  }, []);

  // Covering the page, a click outside or Escape closes the assistant. Docked
  // beside it, working on the page leaves it open; Escape inside it closes it.
  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (!panelRef.current?.contains(target)) setMenuOpen(false);
      if (docked) return;
      if (panelRef.current?.contains(target) || restoreButtonRef.current?.contains(target)) return;
      const element = target instanceof Element ? target : null;
      if (element?.closest('[role="dialog"], [data-ai-ignore-outside-minimize="true"]')) return;
      minimizeAssistant();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && (!docked || panelRef.current?.contains(document.activeElement))) minimizeAssistant();
    };
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open, docked]);

  useEffect(() => {
    if (!asking) {
      setSlowRequest(false);
      return;
    }
    const timer = window.setTimeout(() => setSlowRequest(true), 1500);
    return () => window.clearTimeout(timer);
  }, [asking]);

  // The page's record, until the user sets it aside for this record. Opening
  // another record brings its context back.
  const pageContext = cleanActiveContext(activeContext);
  const pageContextKey = pageContext ? `${pageContext.entityType}:${pageContext.entityId}` : null;
  const currentContext = pageContext && pageContextKey !== dismissedContextKey ? pageContext : null;
  const sessionGrounding = useMemo(() => buildSessionGrounding(messages, currentContext), [messages, currentContext]);
  const contextLabel = getAiContextLabel(currentContext, language);
  const inputPlaceholder = getAiInputPlaceholder(currentContext, language);
  // On a PO or SKU page: two questions about the record, then two about the
  // workspace, so the assistant never turns into a single-record bot.
  const workspacePrompts = AI_EMPTY_STATE_PROMPT_CHIPS.map((item) => language === "zh-CN" ? item.zhPrompt : item.prompt);
  const recordPrompts = currentContext?.entityType === "purchase_order" ? PO_EMPTY_PROMPTS[language]
    : currentContext?.entityType === "item" ? SKU_EMPTY_PROMPTS[language] : [];
  const recordHints = currentContext?.entityType === "purchase_order" ? PO_SKILL_HINTS : SKU_SKILL_HINTS;
  const emptyPrompts = recordPrompts.length ? [...recordPrompts.slice(0, 2), ...workspacePrompts.slice(0, 2)] : workspacePrompts;
  const emptyPromptSkillHints = recordPrompts.length ? [...recordHints.slice(0, 2), ...EMPTY_STATE_SKILL_HINTS.slice(0, 2)] : EMPTY_STATE_SKILL_HINTS;
  const emptyPromptIcons = recordPrompts.length ? [MessageSquareText, MessageSquareText, ...EMPTY_STATE_ICONS.slice(0, 2)] : EMPTY_STATE_ICONS;
  const currentRequestLabel = requestScopeLabel(messages.filter((message) => message.role === "user").at(-1)?.content || input, language);
  // The header names the conversation by its first question once there is one.
  const firstQuestion = messages.find((message) => message.role === "user")?.content || "";
  const panelTitle = firstQuestion || (zh ? "FlowChain 助手" : "FlowChain assistant");
  const greetingName = aiGreetingName(userName);
  const greeting = zh ? (greetingName ? `你好，${greetingName}` : "你好") : (greetingName ? `Hi ${greetingName}` : "Hi there");
  const lastAssistantIndex = messages.map((message) => message.role).lastIndexOf("assistant");

  function startNewConversation() {
    abortReasonRef.current = "superseded";
    abortRef.current?.abort();
    requestInFlightRef.current = false;
    setAsking(false);
    setSlowRequest(false);
    setProgress(null);
    setMessages([]);
    setInput("");
  }

  function cancelRequest() {
    abortReasonRef.current = "superseded";
    abortRef.current?.abort();
  }

  async function askAi(text: string, skillHint?: string) {
    const message = text.trim();
    if (!message || requestInFlightRef.current) return;

    const context = currentContext;
    const requestStartedAt = performance.now();
    const requestId = requestSeqRef.current + 1;
    const controller = new AbortController();
    let timeoutHit = false;
    requestSeqRef.current = requestId;
    requestInFlightRef.current = true;
    abortReasonRef.current = null;
    abortRef.current?.abort();
    abortRef.current = controller;
    setAsking(true);
    setProgress(null);
    setInput("");
    setMessages((current) => [...current, { role: "user", content: message }]);
    // A chip answers from its skill and keeps the 12 s limit. A typed question
    // may go to the model-first loop, which takes up to 20 s before the rules
    // answer instead.
    const timeout = window.setTimeout(() => {
      timeoutHit = true;
      abortReasonRef.current = "timeout";
      controller.abort();
    }, skillHint ? 12000 : 25000);

    try {
      const safeConversationContext = buildSafeConversationContext(messages, context, sessionGrounding, language);
      const response = await postAiRuntimeResponse({
        answerLanguage: language,
        // The server picks records or company documents from the question.
        queryMode: "auto",
        message,
        ...(skillHint ? { skillHint } : {}),
        activeModuleId: moduleId,
        activeViewId: context?.view,
        focusTarget: focusTargetFromActiveContext(context),
        conversationContext: {
          ...safeConversationContext,
          previousQuestion: safeConversationContext.previousQuestion || sessionGrounding.lastIntent,
          previousAnswerSummary: sessionGrounding.lastPrimaryEntity?.label,
          userIntentLabel: context?.entityLabel || contextLabel,
        },
        sessionGrounding,
        returnTo: "ai-assistant",
        // A typed question may go to the model-first loop, which says what it
        // reads while it answers; a chip answers at once from its skill.
      }, controller.signal, skillHint ? undefined : (event) => { if (requestSeqRef.current === requestId) setProgress(event); });
      const rawContent = response.runtimeModeLabel || "";
      const content = "";
      if (looksLikeRawJson(rawContent)) console.debug("AI assistant raw content suppressed", rawContent);
      if (import.meta.env.DEV) {
        console.debug("AI assistant request completed", {
          elapsedMs: Math.round(performance.now() - requestStartedAt),
          cards: 1,
        });
      }
      if (requestSeqRef.current !== requestId) return;
      setMessages((current) => [
        ...current,
        { role: "assistant", content, cards: [{ type: "ai_response_v2", data: response as unknown as Record<string, unknown> }] },
      ]);
      // Asked for an order with a clear choice: open its form, filled in, as
      // the answer's own button would. Nothing is saved. The assistant stays
      // open, so the user reads first why the page changed and what is
      // already on order; the answer keeps the button to open it again.
      const opening = autoOpenDraftCard((response as unknown as AiResponseV2).reviewCards);
      if (opening?.draftType) {
        const target = structuredDraftTarget(opening.draftType, opening.payload, "ai_assistant");
        onNavigate?.(target.moduleId, null, { source: "ai", returnTo: "ai", entityLabel: opening.allowedNextStep, query: target.query });
      }
    } catch (error) {
      if (requestSeqRef.current !== requestId || abortReasonRef.current === "unmount" || abortReasonRef.current === "superseded") return;
      if (import.meta.env.DEV) {
        console.warn("AI assistant request failed", {
          elapsedMs: Math.round(performance.now() - requestStartedAt),
          timeout: timeoutHit || abortReasonRef.current === "timeout",
          name: error instanceof Error ? error.name : "unknown",
          healthCheck: "/api/health",
          devHint: "Check npm run api, /api/health, SCM_API_PROXY_TARGET, stale node on 8787, current HEAD with git rev-parse --short HEAD, browser refresh, and UTF-8 byte bodies for PowerShell Chinese prompt tests.",
        });
      }
      setMessages((current) => [
        ...current,
        {
          role: "assistant",
          content: displaySafeAssistantRecoveryMessage(message, language, aiRecoveryReason(error, timeoutHit || abortReasonRef.current === "timeout")),
          retryPrompt: message,
          ...(skillHint ? { retrySkillHint: skillHint } : {}),
        },
      ]);
    } finally {
      window.clearTimeout(timeout);
      if (requestSeqRef.current === requestId) {
        requestInFlightRef.current = false;
        abortRef.current = null;
        abortReasonRef.current = null;
        setAsking(false);
        setProgress(null);
      }
    }
  }

  return (
    <div className="contents" data-testid="ai-assistant-root">
      {knowledgeOpen && <KnowledgeLibrary onClose={() => setKnowledgeOpen(false)} />}
      {open && (
        <aside
          ref={panelRef}
          data-testid="ai-assistant-panel"
          data-docked={docked ? "true" : "false"}
          aria-label={zh ? "FlowChain 助手" : "FlowChain assistant"}
          className={`fixed inset-0 z-50 flex flex-col bg-white sm:left-auto sm:w-[440px] sm:shadow-2xl lg:static lg:z-auto lg:h-screen lg:shrink-0 lg:shadow-none ${expanded ? "lg:w-[min(760px,55vw)]" : "lg:w-[440px]"}`}
          style={{ borderLeft: `1px solid ${A.gray4}` }}
        >
          <header className="flex h-14 shrink-0 items-center gap-1.5 pl-4 pr-2" style={{ borderBottom: `1px solid ${A.gray4}` }}>
            <span className="mr-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg" style={{ background: "#EFF4FF" }}><Sparkles size={15} style={{ color: A.blue }} aria-hidden /></span>
            <h2 data-testid="ai-assistant-title" className="min-w-0 flex-1 truncate text-[15px] font-semibold" style={{ color: A.label }} title={panelTitle}>{panelTitle}</h2>
            {/* Shown only when the panel was opened on a record: answers may use it ("this PO"). */}
            {currentContext && pageContextKey ? (
              <span data-testid="ai-context-chip" title={contextLabel} className="flex min-w-0 max-w-[140px] shrink items-center gap-0.5 rounded-md py-0.5 pl-2 pr-0.5 text-xs font-medium" style={{ background: A.gray5, color: A.gray1 }}>
                <span className="truncate">{currentContext.entityLabel || currentContext.entityId}</span>
                <button
                  type="button"
                  data-testid="ai-context-clear"
                  onClick={() => setDismissedContextKey(pageContextKey)}
                  className="flex h-5 w-5 shrink-0 items-center justify-center rounded hover:bg-slate-200"
                  aria-label={zh ? "不限于这条记录，回答整个工作区" : "Stop using this record; answer about the whole workspace"}
                  title={zh ? "不限于这条记录" : "Stop using this record"}
                >
                  <X size={12} />
                </button>
              </span>
            ) : null}
            <HeaderButton label={zh ? "新对话" : "New conversation"} onClick={startNewConversation}><SquarePen size={16} /></HeaderButton>
            <div className="relative">
              <HeaderButton testId="ai-more-menu" label={zh ? "更多" : "More"} expanded={menuOpen} onClick={() => setMenuOpen((value) => !value)}><MoreHorizontal size={16} /></HeaderButton>
              {menuOpen ? (
                <div role="menu" className="absolute right-0 top-9 z-10 w-52 rounded-xl bg-white p-1 shadow-lg" style={{ border: `1px solid ${A.gray4}` }}>
                  <button type="button" role="menuitem" data-testid="ai-knowledge-library" onClick={() => { setMenuOpen(false); setKnowledgeOpen(true); }} className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm hover:bg-slate-50" style={{ color: A.label }}>
                    <BookOpen size={15} style={{ color: A.gray1 }} aria-hidden />
                    {zh ? "管理资料" : "Knowledge library"}
                  </button>
                </div>
              ) : null}
            </div>
            {docked ? <HeaderButton label={expanded ? (zh ? "收起 AI 工作区" : "Collapse AI workspace") : (zh ? "展开 AI 工作区" : "Expand AI workspace")} onClick={() => setExpanded((value) => !value)}>{expanded ? <Minimize2 size={15} /> : <Maximize2 size={15} />}</HeaderButton> : null}
            <button type="button" onClick={minimizeAssistant} className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg hover:bg-slate-100" style={{ color: A.gray1 }} aria-label={language === "zh-CN" ? "最小化 AI 助手" : "Minimize AI assistant"}><X size={17} /></button>
          </header>

          <div ref={scrollRef} data-testid="ai-assistant-messages" className="min-h-0 flex-1 overflow-auto px-4 py-5">
            {messages.length === 0 && (
              <div data-testid="ai-welcome">
                <h3 className="text-xl font-semibold" style={{ color: A.label }}>{greeting}</h3>
                <p data-testid="ai-runtime-boundary" className="mt-1.5 text-sm leading-relaxed" style={{ color: A.gray1 }}>{zh ? "我能查采购、库存和发票，也能帮你起草单据，你确认后才会提交。" : "I can look up purchasing, inventory and invoices, and draft documents for you to confirm."}</p>
                <div className="mt-5 grid grid-cols-2 gap-2.5">
                  {emptyPrompts.slice(0, 4).map((prompt, index) => {
                    const Icon = emptyPromptIcons[index] || MessageSquareText;
                    return (
                      <button
                        key={prompt}
                        type="button"
                        onClick={() => askAi(prompt, emptyPromptSkillHints[index] || undefined)}
                        disabled={asking}
                        data-testid="ai-empty-prompt-chip"
                        className="flex min-h-[92px] flex-col items-start gap-2.5 rounded-xl border border-slate-200 bg-white p-3 text-left transition-colors hover:border-blue-300 hover:bg-blue-50/40 disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        <span className="flex h-7 w-7 items-center justify-center rounded-lg" style={{ background: "#EFF4FF" }}><Icon size={15} style={{ color: A.blue }} aria-hidden /></span>
                        <span className="text-[13px] font-medium leading-snug" style={{ color: A.label }}>{prompt}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
            {messages.length > 0 && (
              <div className="space-y-6">
                {messages.map((message, index) => message.role === "user" ? (
                  <div key={`${message.role}-${index}`} className="flex justify-end">
                    <div data-testid="ai-message-user" className="max-w-[85%] whitespace-pre-wrap break-words rounded-2xl rounded-br-md px-3.5 py-2 text-sm leading-relaxed" style={{ background: "#EFF4FF", color: A.label }}>
                      {message.content}
                    </div>
                  </div>
                ) : (
                  <div key={`${message.role}-${index}`} data-testid="ai-message-assistant" className="space-y-3 text-sm leading-relaxed" style={{ color: A.label }}>
                    {message.content ? <div className="whitespace-pre-wrap">{message.content}</div> : null}
                    <AiResponseCards cards={message.cards} latest={index === lastAssistantIndex} onNavigate={minimizeAfterNavigate} onReviewActionDraft={onReviewActionDraft} onFollowUp={askAi} />
                    {/* Next questions only under the latest answer. */}
                    {index === lastAssistantIndex && getAiFollowUpChips(message, language).length ? (
                      <div className="flex flex-wrap gap-1.5">
                        {getAiFollowUpChips(message, language).map((chip) => (
                          <button
                            key={`${chip.label}-${chip.prompt}`}
                            type="button"
                            onClick={() => askAi(chip.prompt)}
                            disabled={asking}
                            data-testid="ai-follow-up-chip"
                            className="rounded-full px-3 py-1.5 text-[13px] font-medium hover:bg-blue-50 disabled:cursor-not-allowed"
                            style={{ background: A.white, color: asking ? A.gray3 : A.blue, border: `1px solid ${A.gray4}` }}
                          >
                            {chip.label}
                          </button>
                        ))}
                      </div>
                    ) : null}
                    {message.retryPrompt ? (
                      <button
                        type="button"
                        onClick={() => askAi(message.retryPrompt || "", message.retrySkillHint)}
                        disabled={asking}
                        className="inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[13px] font-medium disabled:cursor-not-allowed"
                        style={{ background: A.white, color: asking ? A.gray3 : A.blue, border: `1px solid ${A.gray4}` }}
                      >
                        <RotateCcw size={13} />
                        {language === "zh-CN" ? "重试" : "Retry"}
                      </button>
                    ) : null}
                  </div>
                ))}
                {asking && (
                  <div data-testid="ai-progress-line" aria-live="polite" className="flex items-center gap-2 text-[13px]" style={{ color: A.gray1 }}>
                    <Loader2 size={14} className="animate-spin" aria-hidden />
                    {progress ? aiProgressLine(progress, language) : slowRequest ? currentRequestLabel : (language === "zh-CN" ? "正在确认查询范围" : "Checking your question")}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* On a phone one row, the send button beside the text; docked, a taller box. */}
          <div className="shrink-0 px-3 pb-3 pt-2 lg:px-4 lg:pb-4">
            <div className="flex items-end gap-1 rounded-2xl border border-slate-200 bg-white p-1 shadow-sm transition focus-within:border-blue-400 focus-within:ring-2 focus-within:ring-blue-100 lg:block lg:p-0">
              <textarea
                ref={inputRef}
                value={input}
                onChange={(event) => setInput(event.target.value)}
                data-testid="ai-assistant-input"
                aria-label={zh ? "给助手的消息" : "Message to the assistant"}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    if (!asking) askAi(input);
                  }
                }}
                disabled={asking}
                rows={1}
                placeholder={inputPlaceholder}
                onInput={(event) => { const target = event.currentTarget; target.style.height = "auto"; target.style.height = `${Math.min(target.scrollHeight, 160)}px`; }}
                className="block max-h-40 min-h-[40px] w-full flex-1 resize-none overflow-y-auto rounded-2xl bg-transparent px-2.5 py-2 text-sm leading-relaxed outline-none placeholder:text-slate-400 disabled:cursor-not-allowed lg:min-h-[60px] lg:px-3.5 lg:pb-0 lg:pt-3"
                style={{ color: A.label, fontFamily: "inherit" }}
              />
              <div className="flex shrink-0 items-center justify-end p-1 lg:px-2 lg:pb-2 lg:pt-0">
                <button
                  type="button"
                  onClick={() => asking ? cancelRequest() : askAi(input)}
                  disabled={!asking && !input.trim()}
                  data-testid="ai-assistant-send"
                  className="flex h-8 w-8 items-center justify-center rounded-lg text-white disabled:cursor-not-allowed"
                  style={{ background: asking || input.trim() ? A.blue : A.gray3 }}
                  aria-label={asking ? (language === "zh-CN" ? "取消请求" : "Cancel request") : (language === "zh-CN" ? "发送" : "Send")}
                >
                  {asking ? <Square size={13} /> : <Send size={15} />}
                </button>
              </div>
            </div>
          </div>
        </aside>
      )}

      {/* The launcher only while the assistant is closed: open, it covers nothing. */}
      {!open && (
        <button
          ref={restoreButtonRef}
          onClick={restoreAssistant}
          data-testid="ai-assistant-toggle"
          className="fixed bottom-3 right-3 z-40 flex h-12 items-center gap-2 rounded-full pl-4 pr-5 text-sm font-semibold text-white shadow-xl transition-shadow hover:shadow-2xl sm:bottom-5 sm:right-5"
          style={{ background: A.blue }}
          aria-label={language === "zh-CN" ? "展开 AI 助手" : "Open AI assistant"}
        >
          <Sparkles size={17} aria-hidden />
          {language === "zh-CN" ? "AI 助手" : "AI assistant"}
        </button>
      )}
    </div>
  );
}
