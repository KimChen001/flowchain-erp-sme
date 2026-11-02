import type { AnswerLanguage, AnswerPart, FlagSpan, PartRef } from "./parts/types";
import { failureOfStatus, type AssistantV2Event, type AssistantV2Failure, type AssistantV2NoticeCode, type AssistantV2Progress, type AssistantV2ReplaceCode } from "./streamClient";

// One assistant answer as its events build it (docs/ai-assistant-v2-design.md
// §3.7). Pure: the panel folds each event into the message it shows, and the
// tests fold a recorded stream the same way.

export type AssistantV2TextPart = { id: string; kind: "text"; text: string; flags: FlagSpan[]; replaced?: AssistantV2ReplaceCode };
export type AssistantV2UiPart = { id: string; kind: "ui"; component: string; props: unknown; refs: PartRef[] };
export type AssistantV2Part = AssistantV2TextPart | AssistantV2UiPart;
// What the answer is doing now: the tool it runs, and what it reads.
export type AssistantV2ToolStatus = { tool?: { id: string; name: string; state: "running" | "done" | "error"; rows?: number }; progress?: AssistantV2Progress };

export type AssistantV2Message = {
  threadId?: string;
  messageId?: string;
  language?: AnswerLanguage;
  parts: AssistantV2Part[];
  toolStatus: AssistantV2ToolStatus | null;
  notices: AssistantV2NoticeCode[];
  error: AssistantV2Failure | null;
  done: boolean;
  body: Record<string, unknown> | null;
};

export function emptyAssistantV2Message(): AssistantV2Message {
  return { parts: [], toolStatus: null, notices: [], error: null, done: false, body: null };
}

const sameSpan = (a: FlagSpan, b: FlagSpan) => a.text === b.text && a.kind === b.kind;

function withPart(parts: AssistantV2Part[], id: string, update: (part: AssistantV2Part | undefined) => AssistantV2Part | null) {
  const index = parts.findIndex((part) => part.id === id);
  const next = update(index >= 0 ? parts[index] : undefined);
  if (!next) return parts;
  return index >= 0 ? parts.map((part, at) => at === index ? next : part) : [...parts, next];
}

// The answer's own summary, for an answer that streamed no part (a refusal or
// a guard answered it in one line).
function summaryOf(body: Record<string, unknown>) {
  const conclusion = body.conclusion as { summary?: unknown } | undefined;
  return typeof conclusion?.summary === "string" ? conclusion.summary.trim() : "";
}

export function foldAssistantV2Event(message: AssistantV2Message, event: AssistantV2Event): AssistantV2Message {
  // The answer line is the last word: nothing after it changes the message.
  if (message.done) return message;
  switch (event.type) {
    case "start":
      return { ...message, threadId: event.threadId, messageId: event.messageId, language: event.language };
    case "progress":
      return { ...message, toolStatus: { ...message.toolStatus, progress: { step: event.step, ...(event.sources ? { sources: event.sources } : {}) } } };
    case "tool":
      return { ...message, toolStatus: { ...message.toolStatus, tool: { id: event.id, name: event.name, state: event.state, ...(event.rows !== undefined ? { rows: event.rows } : {}) } } };
    case "text_delta":
      return {
        ...message,
        parts: withPart(message.parts, event.partId, (part) => {
          if (!part) return { id: event.partId, kind: "text", text: event.text, flags: [] };
          // Replaced text is final: a late delta cannot add back what was withheld.
          if (part.kind !== "text" || part.replaced) return null;
          return { ...part, text: part.text + event.text };
        }),
      };
    case "ui":
      return { ...message, parts: withPart(message.parts, event.partId, () => ({ id: event.partId, kind: "ui", component: event.component, props: event.props, refs: event.refs || [] })) };
    case "flag":
      return {
        ...message,
        parts: withPart(message.parts, event.partId, (part) => {
          if (!part || part.kind !== "text" || part.replaced) return null;
          return { ...part, flags: [...part.flags, ...event.spans.filter((span) => !part.flags.some((known) => sameSpan(known, span)))] };
        }),
      };
    case "replace":
      return {
        ...message,
        parts: withPart(message.parts, event.partId, (part) => part && part.kind !== "text" ? null : { id: event.partId, kind: "text", text: event.text, flags: [], replaced: event.code }),
      };
    case "notice":
      return message.notices.includes(event.code) ? message : { ...message, notices: [...message.notices, event.code] };
    case "error":
      return { ...message, error: { code: event.code, retryable: event.retryable } };
    case "answer": {
      const finished = { ...message, done: true, toolStatus: null };
      if (event.status >= 400) return { ...finished, error: message.error || failureOfStatus(event.status) };
      const summary = summaryOf(event.body);
      // After an error (withheld, say) the summary may hold what the error stopped.
      const parts = !message.parts.length && !message.notices.length && !message.error && Array.isArray(event.body.parts) && summary
        ? [{ id: "summary", kind: "text" as const, text: summary, flags: [] }]
        : message.parts;
      return { ...finished, parts, body: event.body };
    }
    default:
      return message;
  }
}

export function foldAssistantV2Events(events: AssistantV2Event[], initial: AssistantV2Message = emptyAssistantV2Message()) {
  return events.reduce(foldAssistantV2Event, initial);
}

// An answer that ended without its answer line: stopped, stalled or broken.
export function finishAssistantV2Message(message: AssistantV2Message, end: { notice?: AssistantV2NoticeCode; error?: AssistantV2Failure }): AssistantV2Message {
  if (message.done) return message;
  return {
    ...message,
    done: true,
    toolStatus: null,
    notices: end.notice && !message.notices.includes(end.notice) ? [...message.notices, end.notice] : message.notices,
    error: end.error || message.error,
  };
}

// A rules answer (the model was off or failed before any text): it has no
// parts and is drawn as the classic answer card.
export function rulesAnswerBody(message: AssistantV2Message) {
  return message.done && message.body && !message.parts.length && !Array.isArray(message.body.parts) ? message.body : null;
}

// The parts as AnswerParts draws them.
export function answerPartsOf(message: AssistantV2Message): AnswerPart[] {
  return message.parts.map((part) => part.kind === "text"
    ? { id: part.id, type: "text", text: part.text, flags: part.flags }
    : { id: part.id, type: "ui", component: part.component, props: part.props, refs: part.refs });
}
