import { Loader2, RotateCcw } from "lucide-react";
import { A } from "../../../components/ui";
import { isTranslationKey } from "../../../i18n/I18n";
import { aiProgressLine } from "../presentation";
import { answerPartsOf, type AssistantV2Message } from "./foldEvents";
import { AnswerParts } from "./parts/AnswerParts";
import { AnswerFooter } from "./AnswerFooter";
import { isRef, toneStyle, usePartCopy, type Navigate, type PartCopy } from "./parts/partKit";
import type { PartRef, PrReceipt, RecordActionReceipt, SetupReceipt } from "./parts/types";

// The live line while an answer is read: the tool it runs, else what it
// reads; the tool's name is shown only through its label.
function statusLine(message: AssistantV2Message, copy: PartCopy) {
  const { tool, progress } = message.toolStatus || {};
  const toolKey = tool ? `ai.v2.tool.${tool.name}` : "";
  if (tool?.state === "running" && isTranslationKey(toolKey)) return copy.t(toolKey);
  if (progress) return aiProgressLine(progress, copy.language);
  if (tool) return aiProgressLine({ step: "reading" }, copy.language);
  return copy.t("ai.v2.progress.thinking");
}

function formIdOf(props: unknown) {
  const formId = (props as { formId?: unknown; cardId?: unknown } | null)?.formId ?? (props as { cardId?: unknown } | null)?.cardId;
  return typeof formId === "string" ? formId : "";
}

// One assistant v2 answer in the panel: its parts as they stream, the live
// status line, the notices and an error with Retry. Form receipts live in the
// panel by form id, so a re-render keeps a created request's receipt.
export function AssistantV2Answer({
  message,
  threadId,
  fallbackMessageId,
  latest,
  receipts,
  onReceipt,
  setupReceipts = {},
  onSetupReceipt,
  actionReceipts = {},
  onActionReceipt,
  onNavigate,
  onFollowUp,
  onRetry,
}: {
  message: AssistantV2Message;
  threadId: string;
  fallbackMessageId: string;
  latest: boolean;
  receipts: Record<string, PrReceipt>;
  onReceipt?: (formId: string, receipt: PrReceipt) => void;
  // Setup card receipts by form id, kept by the panel like the request receipts.
  setupReceipts?: Record<string, SetupReceipt>;
  onSetupReceipt?: (formId: string, receipt: SetupReceipt) => void;
  // Record card receipts by card id, kept by the panel the same way.
  actionReceipts?: Record<string, RecordActionReceipt>;
  onActionReceipt?: (cardId: string, receipt: RecordActionReceipt) => void;
  onNavigate?: Navigate;
  onFollowUp?: (question: string) => void;
  onRetry?: () => void;
}) {
  const copy = usePartCopy(message.language);
  const parts = answerPartsOf(message);
  const formIds = Object.fromEntries(parts.flatMap((part) => part.type === "ui" && part.component === "pr_form" ? [[part.id, formIdOf(part.props)]] : []));
  const partReceipts = Object.fromEntries(Object.entries(formIds).flatMap(([partId, formId]) => receipts[formId] ? [[partId, receipts[formId]]] : []));
  const setupFormIds = Object.fromEntries(parts.flatMap((part) => part.type === "ui" && part.component === "setup_form" ? [[part.id, formIdOf(part.props)]] : []));
  const partSetupReceipts = Object.fromEntries(Object.entries(setupFormIds).flatMap(([partId, formId]) => setupReceipts[formId] ? [[partId, setupReceipts[formId]]] : []));
  const cardIds = Object.fromEntries(parts.flatMap((part) => part.type === "ui" && part.component === "record_actions" ? [[part.id, formIdOf(part.props)]] : []));
  const partActionReceipts = Object.fromEntries(Object.entries(cardIds).flatMap(([partId, cardId]) => actionReceipts[cardId] ? [[partId, actionReceipts[cardId]]] : []));
  const evidence = Array.isArray(message.body?.keyEvidence) ? (message.body.keyEvidence as unknown[]).filter(isRef) as PartRef[] : [];
  const errorKey = `ai.v2.answerError.${message.error?.code || "generic"}`;
  const showStatus = !message.done && (!parts.length || message.toolStatus?.tool?.state === "running");

  return (
    <div data-testid="ai-v2-message" data-done={message.done ? "true" : "false"} lang={copy.language} className="space-y-3">
      <AnswerParts
        parts={parts}
        refs={evidence}
        latest={latest}
        threadId={message.threadId || threadId}
        messageId={message.messageId || fallbackMessageId}
        language={copy.language}
        onNavigate={onNavigate}
        onFollowUp={onFollowUp}
        onChoose={onFollowUp ? (ref) => onFollowUp(ref.label) : undefined}
        receipts={partReceipts}
        onReceipt={onReceipt ? (partId, receipt) => { if (formIds[partId]) onReceipt(formIds[partId], receipt); } : undefined}
        setupReceipts={partSetupReceipts}
        onSetupReceipt={onSetupReceipt ? (partId, receipt) => { if (setupFormIds[partId]) onSetupReceipt(setupFormIds[partId], receipt); } : undefined}
        actionReceipts={partActionReceipts}
        onActionReceipt={onActionReceipt ? (partId, receipt) => { if (cardIds[partId]) onActionReceipt(cardIds[partId], receipt); } : undefined}
      />
      {showStatus ? (
        <div data-testid="ai-progress-line" aria-live="polite" className="flex items-center gap-2 text-[13px]" style={{ color: A.gray1 }}>
          <Loader2 size={14} className="animate-spin" aria-hidden />
          {statusLine(message, copy)}
        </div>
      ) : null}
      {message.notices.map((code) => (
        <p key={code} role="status" data-testid="ai-v2-notice" data-code={code} className="rounded-lg px-3 py-2 text-[13px]" style={{ background: A.gray6, color: A.gray1 }}>
          {copy.known("ai.v2.notice", code)}
        </p>
      ))}
      {/* What the answer read and checked, and a thumbs up or down, once it is complete. */}
      {message.done && !message.error && message.body ? <AnswerFooter message={message} threadId={message.threadId || threadId} messageId={message.messageId || fallbackMessageId} copy={copy} /> : null}
      {message.error ? (
        <div role="alert" data-testid="ai-v2-error" data-code={message.error.code} className="space-y-2">
          <p className="text-[13px]" style={{ color: toneStyle("danger").color }}>
            {copy.t(isTranslationKey(errorKey) ? errorKey : "ai.v2.answerError.generic")}
          </p>
          {latest && message.error.retryable && onRetry ? (
            <button type="button" data-testid="ai-v2-retry" onClick={onRetry} className="inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[13px] font-medium" style={{ background: A.white, color: A.blue, border: `1px solid ${A.gray4}` }}>
              <RotateCcw size={13} />
              {copy.t("ai.v2.retry")}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
