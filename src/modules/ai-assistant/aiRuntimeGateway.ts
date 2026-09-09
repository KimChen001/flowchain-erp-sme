import { apiJson } from "../../lib/api-client";
import type { AiResponseV2 } from "../../domain/ai/response-contract";
import type { ActiveContext } from "./Panel";

export type AiRuntimeRequestV2 = {
  answerLanguage?: "en-US" | "zh-CN";
  message: string;
  activeModuleId?: string;
  activeViewId?: string;
  focusTarget?: {
    entityType?: string;
    entityId?: string;
    entityLabel?: string;
  } | null;
  conversationContext?: {
    previousIntent?: string;
    previousQuestion?: string;
    previousConclusionTitle?: string;
    previousAnswerSummary?: string;
    userIntentLabel?: string;
    previousEntityRefs?: Array<Record<string, unknown>>;
    previousNavigationRefs?: Array<Record<string, unknown>>;
    previousEvidenceRefs?: Array<Record<string, unknown>>;
    previousModuleId?: string;
    previousViewId?: string;
    previousFocusTarget?: Record<string, unknown> | null;
    breadcrumbTrail?: Array<Record<string, unknown>>;
    lastResponseId?: string;
    returnContext?: Record<string, unknown> | null;
  };
  sessionGrounding?: unknown;
  returnTo?: string;
};

export type AiRuntimeResponseV2 = AiResponseV2 & {
  responseId: string;
  runtimeModeLabel: string;
  safetyBoundaries: string[];
  sourceSummary: Array<Record<string, unknown>>;
  readinessSignals: Array<Record<string, unknown>>;
  generatedAt: string;
  dataScopeLabel: string;
};

export type AiRuntimeReadinessV2 = {
  summary: Record<string, unknown>;
  supportedIntents: Array<Record<string, unknown>>;
  evidenceSources: Array<Record<string, unknown>>;
  reviewBoundaries: Array<Record<string, unknown>>;
  providerContract: Record<string, unknown>;
  dataLimitations: Array<Record<string, unknown>>;
  generatedAt: string;
  dataScopeLabel: string;
};

export function focusTargetFromActiveContext(activeContext?: ActiveContext | null) {
  if (!activeContext?.entityId) return null;
  return {
    entityType: activeContext.entityType,
    entityId: activeContext.entityId,
    entityLabel: activeContext.entityLabel,
  };
}

export function postAiRuntimeResponse(request: AiRuntimeRequestV2, signal?: AbortSignal) {
  return apiJson<AiRuntimeResponseV2>("/api/ai-runtime/respond", {
    method: "POST",
    signal,
    body: JSON.stringify(request),
  });
}

export function fetchAiRuntimeReadiness() {
  return apiJson<AiRuntimeReadinessV2>("/api/ai-runtime/readiness");
}
