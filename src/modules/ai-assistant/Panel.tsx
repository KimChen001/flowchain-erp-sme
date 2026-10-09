import { KnowledgeLibrary } from "./KnowledgeLibrary";
import { useI18n } from "../../i18n/I18n";
import { useEffect, useMemo, useRef, useState } from "react";
import { Loader2, Maximize2, MessageCircle, Minimize2, Plus, RotateCcw, Send, Square, Sparkles, X } from "lucide-react";
import type { CanonicalFocusTarget } from "../../lib/evidenceLinks";
import { A } from "../../components/ui";
import { AiResponseV2Renderer } from "../../components/ai/AiResponseV2Renderer";
import type { ActionDraftPreviewRequest } from "../action-drafts/ActionDraftReviewShell";
import type { AiResponseV2 } from "../../domain/ai/response-contract";
import { autoOpenDraftCard, structuredDraftTarget } from "../action-drafts/structuredDraftHandoff";
import { focusTargetFromActiveContext, postAiRuntimeResponse } from "./aiRuntimeGateway";
import { ApiError } from "../../lib/api-client";
import { looksLikeRawJson, sanitizeAiMessage } from "./presentation";

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
};

export const AI_EMPTY_STATE_PROMPT_CHIPS = [
  { label: "What should I handle first today?", prompt: "What should I handle first today?", zhLabel: "今天先处理什么？", zhPrompt: "今天先处理什么？" },
  { label: "What is at risk right now?", prompt: "What is at risk right now?", zhLabel: "现在有哪些风险？", zhPrompt: "现在有哪些风险？" },
  { label: "Which records need more data?", prompt: "Which records need more data?", zhLabel: "哪些数据需要补齐？", zhPrompt: "哪些数据需要补齐？" },
  { label: "Prepare an action draft", prompt: "Prepare an action draft", zhLabel: "帮我准备一个处理草稿", zhPrompt: "帮我准备一个处理草稿" },
];

// The workspace skill each chip asks for, by chip position. The chip texts
// above stay as they are; the hint only tells the server which skill to run.
const EMPTY_STATE_SKILL_HINTS = ["today_priorities", "highest_risk_items", "records_needing_data", "prepare_action_draft"];
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
  if (phrase) return zh ? `问工作区的任何问题，或问${phrase}` : `Ask anything about your workspace, or about ${phrase}`;
  return zh ? "问工作区的任何问题" : "Ask anything about your workspace";
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
  onNavigate,
  onReviewActionDraft,
  onFollowUp,
}: {
  card: AiChatCard;
  onNavigate?: AiNavigate;
  onReviewActionDraft?: (request: ActionDraftPreviewRequest) => void;
  onFollowUp?: (prompt: string, skillHint?: string) => void;
}) {
  if (card.type !== "ai_response_v2") return null;
  return (
    <AiResponseV2Renderer
      response={(card.data || {}) as unknown as AiResponseV2}
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
  }).slice(0, 4);
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
  const zh = language === "zh-CN";
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
  onNavigate,
  onReviewActionDraft,
  onFollowUp,
}: {
  cards?: AiChatCard[];
  onNavigate?: AiNavigate;
  onReviewActionDraft?: (request: ActionDraftPreviewRequest) => void;
  onFollowUp?: (prompt: string, skillHint?: string) => void;
}) {
  const visibleCards = cards.filter((card) => card.type);
  if (!visibleCards.length) return null;
  return (
    <div className="mt-2 space-y-2">
      {visibleCards.map((card, index) => (
        <AiResponseCard key={`${card.type}-${index}`} card={card} onNavigate={onNavigate} onReviewActionDraft={onReviewActionDraft} onFollowUp={onFollowUp} />
      ))}
    </div>
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
  onNavigate,
  onReviewActionDraft,
}: {
  moduleId: string;
  activeContext?: ActiveContext | null;
  openSignal?: number;
  onNavigate?: AiNavigate;
  onReviewActionDraft?: (request: ActionDraftPreviewRequest) => void;
}) {
  const { language } = useI18n();
  const [knowledgeOpen, setKnowledgeOpen] = useState(false);
  const [queryMode, setQueryMode] = useState<"auto" | "business" | "knowledge">("auto");
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [input, setInput] = useState("");
  const [asking, setAsking] = useState(false);
  const [slowRequest, setSlowRequest] = useState(false);
  const [messages, setMessages] = useState<AiChatMessage[]>([]);
  const [dismissedContextKey, setDismissedContextKey] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
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
  const minimizeAfterNavigate: AiNavigate = (moduleId, focusTarget, options) => {
    onNavigate?.(moduleId, focusTarget || null, { source: "ai", returnTo: activeContext?.route || moduleId, ...options });
    minimizeAssistant();
  };

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

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (panelRef.current?.contains(target) || restoreButtonRef.current?.contains(target)) return;
      const element = target instanceof Element ? target : null;
      if (element?.closest('[role="dialog"], [data-ai-ignore-outside-minimize="true"]')) return;
      minimizeAssistant();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") minimizeAssistant();
    };
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

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
  const currentRequestLabel = requestScopeLabel(messages.filter((message) => message.role === "user").at(-1)?.content || input, language);

  function startNewConversation() {
    abortReasonRef.current = "superseded";
    abortRef.current?.abort();
    requestInFlightRef.current = false;
    setAsking(false);
    setSlowRequest(false);
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
    setInput("");
    setMessages((current) => [...current, { role: "user", content: message }]);
    const timeout = window.setTimeout(() => {
      timeoutHit = true;
      abortReasonRef.current = "timeout";
      controller.abort();
    }, 12000);

    try {
      const safeConversationContext = buildSafeConversationContext(messages, context, sessionGrounding, language);
      const response = await postAiRuntimeResponse({
        answerLanguage: language,
        queryMode,
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
      }, controller.signal);
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
      }
    }
  }

  return (
    <div className="fixed right-3 bottom-3 z-40 pointer-events-none sm:right-5 sm:bottom-5" data-testid="ai-assistant-root">
      {knowledgeOpen && <KnowledgeLibrary onClose={() => setKnowledgeOpen(false)} />}
      {open && (
        <div
          ref={panelRef}
          data-testid="ai-assistant-panel"
          className={`${expanded ? "w-[min(760px,calc(100vw-24px))]" : "w-[min(460px,calc(100vw-24px))]"} pointer-events-auto mb-3 flex h-[min(72vh,760px)] max-h-[calc(100vh-88px)] flex-col overflow-hidden rounded-2xl bg-white shadow-2xl`}
          style={{ border: `1px solid ${A.border}` }}
        >
          <div className="h-12 px-4 flex items-center justify-between" style={{ borderBottom: `1px solid ${A.border}` }}>
            <div className="min-w-0">
              <div className="text-sm font-semibold flex items-center gap-2" style={{ color: A.label }}>
                <Sparkles size={15} style={{ color: A.blue }} />
                {language === "zh-CN" ? "AI 助手" : "AI assistant"}
              </div>
              <div data-testid="ai-context-chip" className="flex min-w-0 items-center gap-1 text-[11px]" style={{ color: A.gray2 }}>
                <span className="truncate">{language === "zh-CN" ? "范围：" : "Scope: "}{contextLabel}</span>
                {currentContext && pageContextKey ? (
                  <button
                    type="button"
                    data-testid="ai-context-clear"
                    onClick={() => setDismissedContextKey(pageContextKey)}
                    className="flex h-4 w-4 shrink-0 items-center justify-center rounded hover:bg-slate-100"
                    style={{ color: A.gray2 }}
                    aria-label={language === "zh-CN" ? "不限于这条记录，回答整个工作区" : "Stop using this record; answer about the whole workspace"}
                    title={language === "zh-CN" ? "不限于这条记录" : "Stop using this record"}
                  >
                    <X size={11} />
                  </button>
                ) : null}
              </div>
            </div>
            <div className="flex items-center gap-1">
              <button type="button" onClick={startNewConversation} className="flex h-8 items-center gap-1 rounded-lg px-2 text-[11px] font-medium hover:bg-slate-100" style={{ color: A.gray1 }} aria-label={language === "zh-CN" ? "新对话" : "New conversation"}><Plus size={13} />{language === "zh-CN" ? "新对话" : "New conversation"}</button>
              <button type="button" onClick={() => setExpanded((value) => !value)} className="fc-ai-expand flex h-8 w-8 items-center justify-center rounded-lg hover:bg-slate-100" style={{ color: A.gray1 }} aria-label={expanded ? (language === "zh-CN" ? "收起 AI 工作区" : "Collapse AI workspace") : (language === "zh-CN" ? "展开 AI 工作区" : "Expand AI workspace")}>{expanded ? <Minimize2 size={14} /> : <Maximize2 size={14} />}</button>
              <button type="button" onClick={minimizeAssistant} className="flex h-8 w-8 items-center justify-center rounded-lg hover:bg-slate-100" style={{ color: A.gray1 }} aria-label={language === "zh-CN" ? "最小化 AI 助手" : "Minimize AI assistant"}><X size={15} /></button>
            </div>
          </div>

          <div ref={scrollRef} data-testid="ai-assistant-messages" className="min-h-0 flex-1 overflow-auto px-4 py-3 space-y-3">
            {messages.length === 0 && (
              <div className="rounded-xl px-3 py-3 space-y-3" style={{ background: A.gray6, color: A.sub }}>
                <p data-testid="ai-runtime-boundary" className="text-xs leading-5" style={{ color: A.gray1 }}>{language === 'zh-CN' ? '基于当前工作区数据 · 涉及业务变更时需要确认' : 'Based on workspace data · Business changes require confirmation'}</p>
                <p className="text-xs leading-5" style={{ color: A.sub }}>{language === 'zh-CN' ? '询问业务情况，或从产品与公司知识库查找有来源的资料。' : 'Ask about business records, or search product and company knowledge with sources.'}</p>
                <div className="flex flex-wrap gap-2">
                  {emptyPrompts.slice(0, 4).map((prompt, index) => (
                    <button
                      key={prompt}
                      type="button"
                      onClick={() => askAi(prompt, emptyPromptSkillHints[index])}
                      disabled={asking}
                      data-testid="ai-empty-prompt-chip"
                      className="rounded-full px-2.5 py-1 text-[11px] font-medium hover:bg-slate-100 disabled:cursor-not-allowed"
                      style={{ background: A.white, color: asking ? A.gray3 : A.gray1, border: `1px solid ${A.border}` }}
                    >
                      {prompt}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {messages.map((message, index) => (
              <div key={`${message.role}-${index}`} className={`flex ${message.role === "user" ? "justify-end" : "justify-start"}`}>
                <div
                  data-testid={message.role === "assistant" ? "ai-message-assistant" : "ai-message-user"}
                  className="max-w-[86%] rounded-2xl px-3 py-2 text-sm leading-6"
                  style={{
                    background: message.role === "user" ? A.blue : A.gray6,
                    color: message.role === "user" ? A.white : A.label,
                  }}
                >
                  {message.content ? <div className="whitespace-pre-wrap">{message.content}</div> : null}
                  {message.role === "assistant" && <AiResponseCards cards={message.cards} onNavigate={minimizeAfterNavigate} onReviewActionDraft={onReviewActionDraft} onFollowUp={askAi} />}
                  {message.role === "assistant" && getAiFollowUpChips(message, language).length ? (
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {getAiFollowUpChips(message, language).map((chip) => (
                        <button
                          key={`${chip.label}-${chip.prompt}`}
                          type="button"
                          onClick={() => askAi(chip.prompt)}
                          disabled={asking}
                          data-testid="ai-follow-up-chip"
                          className="rounded-full px-2.5 py-1 text-[11px] font-medium disabled:cursor-not-allowed"
                          style={{ background: A.white, color: asking ? A.gray3 : A.blue, border: `1px solid ${A.border}` }}
                        >
                          {chip.label}
                        </button>
                      ))}
                    </div>
                  ) : null}
                  {message.role === "assistant" && message.retryPrompt ? (
                    <button
                      type="button"
                      onClick={() => askAi(message.retryPrompt || "", message.retrySkillHint)}
                      disabled={asking}
                      className="mt-2 inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium disabled:cursor-not-allowed"
                      style={{ background: A.white, color: asking ? A.gray3 : A.blue, border: `1px solid ${A.border}` }}
                    >
                      <RotateCcw size={12} />
                      {language === "zh-CN" ? "重试" : "Retry"}
                    </button>
                  ) : null}
                </div>
              </div>
            ))}
            {asking && (
              <div className="flex justify-start">
                <div className="rounded-2xl px-3 py-2 text-sm flex items-center gap-2" style={{ background: A.gray6, color: A.gray1 }}>
                  <Loader2 size={14} className="animate-spin" />
                  {slowRequest ? currentRequestLabel : (language === "zh-CN" ? "正在确认查询范围" : "Checking your question")}
                </div>
              </div>
            )}
          </div>

          <div className="px-4 pb-3">
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-xs">
              <label>{language === 'zh-CN' ? '查询范围' : 'Search'} <select data-testid="ai-query-mode" value={queryMode} onChange={e => setQueryMode(e.target.value as 'auto' | 'business' | 'knowledge')} className="rounded border p-1"><option value="auto">{language === 'zh-CN' ? '自动选择' : 'Auto-detect'}</option><option value="business">{language === 'zh-CN' ? '业务记录' : 'Business records'}</option><option value="knowledge">{language === 'zh-CN' ? '产品／公司知识库' : 'Product & company knowledge'}</option></select></label>
              <button type="button" data-testid="ai-knowledge-library" className="text-blue-700 underline" onClick={() => setKnowledgeOpen(true)}>{language === 'zh-CN' ? '管理资料' : 'Knowledge library'}</button>
            </div>
            <div className="flex items-end gap-2">
              <textarea
                value={input}
                onChange={(event) => setInput(event.target.value)}
                data-testid="ai-assistant-input"
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    if (!asking) askAi(input);
                  }
                }}
                disabled={asking}
                rows={1}
                placeholder={inputPlaceholder}
                onInput={(event) => { const target = event.currentTarget; target.style.height = "auto"; target.style.height = `${Math.min(target.scrollHeight, 96)}px`; }}
                className="min-h-10 max-h-24 flex-1 resize-none overflow-y-auto rounded-xl px-3 py-2 text-sm outline-none disabled:cursor-not-allowed"
                style={{ background: A.gray6, color: A.label, fontFamily: "inherit" }}
              />
              <button
                onClick={() => asking ? cancelRequest() : askAi(input)}
                disabled={!asking && !input.trim()}
                data-testid="ai-assistant-send"
                className="w-10 h-10 rounded-xl flex items-center justify-center text-white disabled:cursor-not-allowed"
                style={{ background: asking || input.trim() ? A.blue : A.gray3 }}
                aria-label={asking ? (language === "zh-CN" ? "取消请求" : "Cancel request") : (language === "zh-CN" ? "发送" : "Send")}
              >
                {asking ? <Square size={14} /> : <Send size={16} />}
              </button>
            </div>
          </div>
        </div>
      )}

      <button
        ref={restoreButtonRef}
        onClick={() => open ? minimizeAssistant() : restoreAssistant()}
        data-testid="ai-assistant-toggle"
        className="pointer-events-auto h-12 rounded-full pl-4 pr-5 flex items-center gap-2 text-sm font-semibold text-white shadow-xl hover:shadow-2xl transition-shadow"
        style={{ background: A.blue }}
        aria-label={open ? (language === "zh-CN" ? "最小化 AI 助手" : "Minimize AI assistant") : (language === "zh-CN" ? "展开 AI 助手" : "Open AI assistant")}
      >
        <MessageCircle size={18} />
        {language === "zh-CN" ? "AI 助手" : "AI assistant"}
      </button>
    </div>
  );
}
