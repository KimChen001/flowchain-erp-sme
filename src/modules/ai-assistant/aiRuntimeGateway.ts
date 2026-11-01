import { ApiError, apiErrorFrom, apiFetch, apiJson } from "../../lib/api-client";
import type { ApiErrorPayload } from "../../types/api";
import type { AiResponseV2 } from "../../domain/ai/response-contract";
import type { ActiveContext } from "./Panel";

export type AiRuntimeRequestV2 = {
  queryMode?: "auto" | "business" | "knowledge";
  answerLanguage?: "en-US" | "zh-CN";
  message: string;
  // The workspace skill a prompt chip asks for; the server routes the text otherwise.
  skillHint?: string;
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
    previousListRefs?: Array<Record<string, unknown>>;
    previousModuleId?: string;
    previousViewId?: string;
    previousFocusTarget?: Record<string, unknown> | null;
    breadcrumbTrail?: Array<Record<string, unknown>>;
    lastResponseId?: string;
    returnContext?: Record<string, unknown> | null;
    previousTurns?: Array<{ question: string; answer: string }>;
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

// What the model-first assistant is doing while it answers (codes only; the
// panel words them): reading some sources, writing, or checking the figures.
export type AiRuntimeProgress = { step: "reading" | "writing" | "checking"; sources?: string[] };

const STREAM_TYPE = "application/x-ndjson";

// With onProgress, the request accepts the server's progress stream
// (server/routes/ai-runtime-stream.mjs): progress lines while the tool loop
// runs, then the answer line. An answer given without the loop (a chip, the
// rules) comes back as plain JSON, as without onProgress.
export async function postAiRuntimeResponse(request: AiRuntimeRequestV2, signal?: AbortSignal, onProgress?: (progress: AiRuntimeProgress) => void) {
  if (!onProgress) {
    return apiJson<AiRuntimeResponseV2>("/api/ai-runtime/respond", {
      method: "POST",
      signal,
      body: JSON.stringify(request),
    });
  }
  const res = await apiFetch("/api/ai-runtime/respond", {
    method: "POST",
    signal,
    headers: { Accept: `${STREAM_TYPE}, application/json` },
    body: JSON.stringify(request),
  });
  if (!res.ok) throw await apiErrorFrom(res);
  if (!(res.headers.get("content-type") || "").includes(STREAM_TYPE) || !res.body) return res.json() as Promise<AiRuntimeResponseV2>;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    let end = buffer.indexOf("\n");
    while (end >= 0) {
      const line = buffer.slice(0, end).trim();
      buffer = buffer.slice(end + 1);
      end = buffer.indexOf("\n");
      if (!line) continue;
      const event = JSON.parse(line) as { type?: string; status?: number; body?: unknown } & AiRuntimeProgress;
      if (event.type === "progress") onProgress({ step: event.step, ...(event.sources ? { sources: event.sources } : {}) });
      else if (event.type === "answer") {
        const status = Number(event.status) || 200;
        if (status >= 400) throw new ApiError(status, (event.body || {}) as ApiErrorPayload, `API request failed: ${status}`);
        return event.body as AiRuntimeResponseV2;
      }
    }
    if (done) break;
  }
  throw new ApiError(502, { error: "The answer ended before it arrived." }, "The answer ended before it arrived.");
}

export function fetchAiRuntimeReadiness() {
  return apiJson<AiRuntimeReadinessV2>("/api/ai-runtime/readiness");
}
