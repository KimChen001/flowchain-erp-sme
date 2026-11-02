import { ApiError, apiErrorFrom, apiFetch } from "../../../lib/api-client";
import { safeParseStreamEvent, safeParseStreamLine } from "../../../../shared/assistant-protocol.mjs";
import type { AnswerLanguage, FlagSpan, PartRef } from "./parts/types";

// The assistant v2 request and its event stream (docs/ai-assistant-v2-design.md
// §3.7). The client sends only the question, its thread and the page; the
// server keeps the thread's tool results and never reads history from here.

export type AssistantV2ActiveContext = { moduleId: string; entityType: string | null; entityId: string | null };
// A request an in-chat form created, reported once with the next question;
// the server checks it before it adds a note to the thread.
export type AssistantV2FormResult = { formId: string; purchaseRequestId: string };
export type AssistantV2Request = {
  threadId: string;
  message: string;
  activeContext: AssistantV2ActiveContext;
  answerLanguage: AnswerLanguage;
  formResults?: AssistantV2FormResult[];
};

export type AssistantV2NoticeCode = "over_cap" | "over_cap_during_answer" | "cost_ceiling" | "unavailable" | "rate_limited" | "injection_refused" | "cancelled" | "refused";
export type AssistantV2ReplaceCode = "unbacked_action_claim" | "foreign_record" | "hidden_value";
export type AssistantV2Progress = { step: "reading" | "writing" | "checking"; sources?: string[] };

// The events of shared/assistant-protocol.mjs, without the {v, seq} envelope.
export type AssistantV2Event =
  | { type: "start"; threadId: string; messageId: string; model: string; language: AnswerLanguage }
  | ({ type: "progress" } & AssistantV2Progress)
  | { type: "tool"; id: string; name: string; state: "running" | "done" | "error"; rows?: number }
  | { type: "text_delta"; partId: string; text: string }
  | { type: "ui"; partId: string; component: string; schemaVersion: number; props: unknown; refs: PartRef[] }
  | { type: "flag"; partId: string; spans: FlagSpan[] }
  | { type: "replace"; partId: string; text: string; code: AssistantV2ReplaceCode }
  | { type: "notice"; code: AssistantV2NoticeCode }
  | { type: "error"; code: string; retryable: boolean }
  | { type: "answer"; status: number; body: Record<string, unknown> };

const STREAM_TYPE = "application/x-ndjson";
// No event for this long means the answer stalled; every event restarts it.
export const ASSISTANT_V2_IDLE_TIMEOUT_MS = 25000;

export function newThreadId() {
  const random = globalThis.crypto?.randomUUID?.().replace(/-/g, "") || `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
  return `thr_${random.slice(0, 24)}`;
}

// One NDJSON line as an event, or null when it cannot be read: a bad line is
// skipped, not fatal. A line of the rules fallback (server/routes/ai-runtime-stream.mjs)
// has no {v, seq} envelope; its progress and answer lines are read with one.
export function parseAssistantV2Line(line: string): AssistantV2Event | null {
  const text = line.trim();
  if (!text) return null;
  const parsed = safeParseStreamLine(text);
  if (parsed.success) return parsed.data as AssistantV2Event;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value) || "v" in value) return null;
  const legacy = safeParseStreamEvent({ ...value, v: 2, seq: 0 });
  return legacy.success && (legacy.data.type === "progress" || legacy.data.type === "answer") ? legacy.data as AssistantV2Event : null;
}

// Complete lines out of the text read so far; the unfinished tail waits for more.
export function splitStreamLines(buffer: string, final = false) {
  const lines = buffer.split("\n");
  const rest = final ? "" : lines.pop() || "";
  return { lines: lines.filter((line) => line.trim()), rest };
}

export class AssistantV2StreamError extends Error {
  code: "stopped" | "idle_timeout" | "incomplete";
  constructor(code: AssistantV2StreamError["code"]) {
    super(`Assistant stream ${code}`);
    this.name = "AssistantV2StreamError";
    this.code = code;
  }
}

type StreamOptions = { signal?: AbortSignal; idleTimeoutMs?: number; fetcher?: (url: string, init: RequestInit) => Promise<Response> };

// Yields each event until the answer line. Aborting `signal` is Stop and
// throws AssistantV2StreamError("stopped"); a stall throws "idle_timeout";
// a stream that ends without its answer throws "incomplete". An answer the
// server gave as plain JSON (the rules, before any stream opened) arrives as
// one answer event.
export async function* streamAssistantV2(request: AssistantV2Request, { signal, idleTimeoutMs = ASSISTANT_V2_IDLE_TIMEOUT_MS, fetcher = apiFetch }: StreamOptions = {}): AsyncGenerator<AssistantV2Event, void, undefined> {
  const controller = new AbortController();
  let reason: "stopped" | "idle_timeout" | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      reason = reason || "idle_timeout";
      controller.abort();
    }, idleTimeoutMs);
  };
  const stop = () => {
    reason = reason || "stopped";
    controller.abort();
  };
  if (signal?.aborted) stop();
  signal?.addEventListener("abort", stop);
  arm();
  try {
    const res = await fetcher("/api/ai-runtime/respond", {
      method: "POST",
      signal: controller.signal,
      headers: { Accept: `${STREAM_TYPE}, application/json` },
      body: JSON.stringify(request),
    });
    if (!res.ok) throw await apiErrorFrom(res);
    if (!(res.headers.get("content-type") || "").includes(STREAM_TYPE) || !res.body) {
      yield { type: "answer", status: res.status, body: await res.json() as Record<string, unknown> };
      return;
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      const { lines, rest } = splitStreamLines(buffer, done);
      buffer = rest;
      for (const line of lines) {
        const event = parseAssistantV2Line(line);
        if (!event) continue;
        arm();
        yield event;
        if (event.type === "answer") return;
      }
      if (done) break;
    }
    throw new AssistantV2StreamError("incomplete");
  } catch (error) {
    if (reason) throw new AssistantV2StreamError(reason);
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", stop);
    // Leaving early (an answer read, or the caller gone) closes the response.
    controller.abort();
  }
}

export type AssistantV2Failure = { code: string; retryable: boolean };

// Why a request failed, as a code the panel words: the server's status, a
// stall, a broken stream, or no connection.
export function assistantV2Failure(error: unknown): AssistantV2Failure {
  if (error instanceof AssistantV2StreamError) return { code: error.code === "idle_timeout" ? "timeout" : "incomplete", retryable: true };
  if (error instanceof ApiError) return failureOfStatus(error.status);
  return { code: "network", retryable: true };
}

export function failureOfStatus(status: number): AssistantV2Failure {
  if (status === 401) return { code: "signed_out", retryable: false };
  if (status === 400) return { code: "invalid_question", retryable: false };
  return { code: "unavailable", retryable: true };
}
