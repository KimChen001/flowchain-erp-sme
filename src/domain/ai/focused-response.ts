import type {
  AiResponseV2,
  AiResponseV2BusinessImpactItem,
  AiResponseV2DataLimitation,
  AiResponseV2EvidenceItem,
  AiResponseV2NavigationLink,
  AiResponseV2ReviewCard,
  AiResponseV2Severity,
} from "./response-contract";

export type AiFocusedAnswerMode = "today" | "diagnosis" | "status" | "comparison" | "draft" | "insufficient";

export type AiFocusedPrimaryItem = {
  id: string;
  title: string;
  reason: string;
  impact: string;
  status: string;
  severity: AiResponseV2Severity;
  evidence: AiResponseV2EvidenceItem;
};

export type AiFocusedAction =
  | { kind: "navigation"; label: string; link: AiResponseV2NavigationLink }
  | { kind: "text_draft"; label: string; card: AiResponseV2ReviewCard }
  | { kind: "structured_draft"; label: string; card: AiResponseV2ReviewCard };

export type AiFocusedResponseModel = {
  answerMode: AiFocusedAnswerMode;
  headline: string;
  summary: string;
  severity: AiResponseV2Severity;
  primaryItems: AiFocusedPrimaryItem[];
  primaryAction: AiFocusedAction | null;
  secondaryActions: AiFocusedAction[];
  evidence: AiResponseV2EvidenceItem[];
  businessImpact: AiResponseV2BusinessImpactItem[];
  limitations: AiResponseV2DataLimitation[];
  reviewDraft: AiResponseV2ReviewCard | null;
  followUps: Array<{ label: string; prompt: string; skillHint?: string }>;
};

const severityScore: Record<AiResponseV2Severity, number> = { risk: 400, warning: 300, info: 200, success: 100 };

type Language = "en-US" | "zh-CN";
const focusedCopy = {
  "en-US": { rfqDraft: "Create RFQ draft", taskDraft: "Create task draft", prDraft: "Create purchase request draft", textDraft: "Prepare text draft", reason: "Review it against the current business status.", headline: "Business review complete", summary: "Review the priorities and suggested next steps." },
  "zh-CN": { rfqDraft: "创建正式 RFQ 草稿", taskDraft: "创建正式任务草稿", prDraft: "创建正式 PR 草稿", textDraft: "生成文本草稿", reason: "需要结合当前业务状态处理。", headline: "已完成业务分析", summary: "请查看重点事项和建议下一步。" },
} as const;

function priorityScore(item: AiResponseV2EvidenceItem) {
  const text = `${item.status || ""} ${item.summary || ""} ${item.value ?? ""}`;
  const urgency = /逾期|阻断|缺货|严重|高风险|待处理/i.test(text) ? 180 : /临期|差异|不足|缺少|关注/i.test(text) ? 90 : 0;
  const numeric = Number(String(item.value ?? "").replace(/[^0-9.-]/g, ""));
  const scale = Number.isFinite(numeric) && numeric > 0 ? Math.min(60, Math.log10(numeric + 1) * 10) : 0;
  return severityScore[item.severity || "info"] + urgency + scale;
}

function answerMode(response: AiResponseV2): AiFocusedAnswerMode {
  const query = `${response.query || ""} ${response.intent || ""}`;
  if (response.reviewCards?.length && /草稿|draft|消息|备注|说明|新建|创建/i.test(query)) return "draft";
  if ((!response.keyEvidence?.length && response.dataLimitations?.length) || /数据不足|缺少数据|not_found|missing/i.test(query)) return "insufficient";
  if (/比较|对比|同比|上期|comparison|compare/i.test(query)) return "comparison";
  if (/多少|数量|状态|还有|status|count|remaining/i.test(query)) return "status";
  if (/今天|重点|优先|风险最高|today|priority|attention/i.test(query)) return "today";
  return "diagnosis";
}

function actions(response: AiResponseV2, language: Language) {
  const navigation = (response.navigationLinks || []).filter((link) => Boolean(link.moduleId)).map<AiFocusedAction>((link) => ({ kind: "navigation", label: link.label, link }));
  const drafts = (response.reviewCards || []).map<AiFocusedAction>((card) => {
    const structured = ["purchase_request_draft", "rfq_draft", "task_draft"].includes(card.draftType || "");
    // An order card names its SKU ("Open request: 12 pcs of LDM-001"), so
    // several of them can be told apart.
    const named = typeof card.autoOpen === "boolean" && card.allowedNextStep;
    return {
      kind: structured ? "structured_draft" : "text_draft",
      label: named ? card.allowedNextStep : structured
        ? card.draftType === "rfq_draft" ? focusedCopy[language].rfqDraft : card.draftType === "task_draft" ? focusedCopy[language].taskDraft : focusedCopy[language].prDraft
        : card.allowedNextStep || focusedCopy[language].textDraft,
      card,
    };
  });
  const explicitDraftRequest = /草稿|draft|消息|备注|说明|新建|创建/i.test(`${response.query || ""} ${response.intent || ""}`);
  return explicitDraftRequest ? [...drafts, ...navigation] : navigation;
}

// The help answer ("Here is what I can help with"): it reads no records.
export function isAiCapabilityAnswer(response: AiResponseV2) {
  return response.skill?.id === "capability_overview";
}

export function toAiFocusedResponse(response: AiResponseV2, language: Language = "en-US"): AiFocusedResponseModel {
  const copy = focusedCopy[language];
  // A workspace skill answer always carries its own summary, in the answer
  // language; it is never filled with interface-language text.
  const answerCopy = focusedCopy[response.language === "zh-CN" || response.language === "en-US" ? response.language : language];
  const impacts = (response.businessImpact || []).slice(0, 3);
  // The server's rank, when it gives one, is the order; otherwise a heuristic.
  const ranked = (response.keyEvidence || []).every((item) => typeof item.rank === "number");
  const evidence = [...(response.keyEvidence || [])].sort((a, b) => ranked ? (a.rank as number) - (b.rank as number) : priorityScore(b) - priorityScore(a));
  const primaryItems = evidence.slice(0, 3).map((item, index) => ({
    id: item.id || `${item.entityType}-${item.entityId}-${index}`,
    title: item.entityLabel || item.label || item.entityId,
    reason: item.summary || copy.reason,
    impact: impacts[index]?.explanation || impacts[index]?.impact || "",
    status: item.status || "",
    severity: item.severity || impacts[index]?.severity || "info",
    evidence: item,
  }));
  const availableActions = actions(response, language);
  // The help answer has no records to show, so its suggestions are the answer:
  // all four of them. Any other answer offers two next questions.
  const followUps = (response.followUpSuggestions || [])
    .filter((item, index, rows) => Boolean(item.label && item.prompt) && rows.findIndex((row) => row.prompt === item.prompt) === index)
    .slice(0, isAiCapabilityAnswer(response) ? 4 : 2)
    .map((item) => ({ label: item.label, prompt: item.prompt, ...(item.skillHint ? { skillHint: item.skillHint } : {}) }));
  return {
    answerMode: answerMode(response),
    headline: response.conclusion?.title || answerCopy.headline,
    summary: response.conclusion?.summary || (response.answerSource === "workspace_rules" ? "" : answerCopy.summary),
    severity: response.conclusion?.severity || "info",
    primaryItems,
    primaryAction: availableActions[0] || null,
    secondaryActions: availableActions.slice(1, 3),
    evidence: evidence.slice(0, 5),
    businessImpact: impacts,
    limitations: (response.dataLimitations || []).slice(0, 4),
    reviewDraft: response.reviewCards?.[0] || null,
    followUps,
  };
}
