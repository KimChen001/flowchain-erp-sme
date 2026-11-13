import { useState } from "react";
import { ShieldCheck, ThumbsDown, ThumbsUp } from "lucide-react";
import { A } from "../../../components/ui";
import { apiJson } from "../../../lib/api-client";
import type { TranslationKey } from "../../../i18n/I18n";
import type { AssistantV2Message } from "./foldEvents";
import type { PartCopy } from "./parts/partKit";

// Under a finished answer (owner 2026-11-13, after SAP's generative AI
// principles: cite the data, help people check it, and learn from what they
// mark): one quiet line with what the answer read, as of which day and how
// many of its facts the server checked against the records; and a thumbs up
// or down. A down asks what was wrong (POST /api/ai-runtime/feedback).

const REASONS = ["wrong_figure", "missed_point", "too_long", "wrong_card", "other"] as const;
type Basis = { sources: string[]; asOf: string | null; figures: number; flagged: number; tools: string[] };

function basisOf(body: Record<string, unknown> | null): Basis | null {
  const basis = body?.basis as Partial<Basis> | undefined;
  if (!basis || typeof basis !== "object") return null;
  return {
    sources: Array.isArray(basis.sources) ? basis.sources.filter((value): value is string => typeof value === "string") : [],
    asOf: typeof basis.asOf === "string" ? basis.asOf : null,
    figures: Number(basis.figures) || 0,
    flagged: Number(basis.flagged) || 0,
    tools: Array.isArray(basis.tools) ? basis.tools.filter((value): value is string => typeof value === "string") : [],
  };
}

export function AnswerFooter({ message, threadId, messageId, copy }: { message: AssistantV2Message; threadId: string; messageId: string; copy: PartCopy }) {
  const basis = basisOf(message.body);
  const [rating, setRating] = useState<null | "up" | "down">(null);
  const [asking, setAsking] = useState(false);
  const [reasons, setReasons] = useState<string[]>([]);
  const [note, setNote] = useState("");
  const [status, setStatus] = useState<"idle" | "sending" | "sent" | "failed">("idle");
  const sep = copy.language === "zh-CN" ? " · " : " · ";

  const parts: string[] = [];
  if (basis?.sources.length) parts.push(copy.t("ai.v2.basis.sources", { sources: basis.sources.join(copy.language === "zh-CN" ? "、" : ", ") }));
  if (basis?.sources.length && basis.asOf) parts.push(copy.t("ai.v2.basis.asOf", { date: copy.day(basis.asOf.slice(0, 10)) }));
  if (basis && basis.figures > 0) {
    parts.push(basis.flagged > 0
      ? copy.t("ai.v2.basis.flagged", { n: basis.figures, flagged: basis.flagged })
      : copy.t(basis.figures === 1 ? "ai.v2.basis.checkedOne" : "ai.v2.basis.checked", { n: basis.figures }));
  }

  const send = async (value: "up" | "down", chosen: string[] = [], text = "") => {
    setStatus("sending");
    try {
      await apiJson("/api/ai-runtime/feedback", {
        method: "POST",
        body: JSON.stringify({
          rating: value, threadId, messageId, reasons: chosen, note: text, language: copy.language,
          question: String(message.body?.query || ""),
          answer: String((message.body?.conclusion as { summary?: unknown } | undefined)?.summary || ""),
          tools: basis?.tools || [],
        }),
      });
      setStatus("sent");
      setAsking(false);
    } catch {
      setStatus("failed");
    }
  };
  const thumb = (value: "up" | "down") => {
    if (status === "sending") return;
    setRating(value);
    if (value === "up") { setAsking(false); void send("up"); }
    else { setStatus("idle"); setAsking(true); }
  };
  const iconStyle = (value: "up" | "down") => ({ color: rating === value ? A.blue : A.gray2 });

  return (
    <div data-testid="ai-answer-footer" className="space-y-2">
      <div className="flex items-start gap-2">
        {parts.length ? (
          <p data-testid="ai-answer-basis" data-flagged={basis?.flagged || 0} className="flex min-w-0 flex-1 items-start gap-1 text-[11px] leading-4" style={{ color: A.gray1 }}>
            <ShieldCheck size={12} className="mt-0.5 shrink-0" style={{ color: basis && basis.flagged > 0 ? "#b45309" : A.gray2 }} aria-hidden />
            <span>{parts.join(sep)}</span>
          </p>
        ) : <span className="flex-1" />}
        <div className="flex shrink-0 items-center gap-0.5">
          {(["up", "down"] as const).map((value) => (
            <button
              key={value}
              type="button"
              aria-label={copy.t(value === "up" ? "ai.v2.feedback.up" : "ai.v2.feedback.down")}
              title={copy.t(value === "up" ? "ai.v2.feedback.up" : "ai.v2.feedback.down")}
              aria-pressed={rating === value}
              disabled={status === "sending"}
              onClick={() => thumb(value)}
              data-testid={`ai-feedback-${value}`}
              className="flex h-6 w-6 items-center justify-center rounded hover:bg-slate-100"
            >
              {value === "up" ? <ThumbsUp size={13} style={iconStyle("up")} aria-hidden /> : <ThumbsDown size={13} style={iconStyle("down")} aria-hidden />}
            </button>
          ))}
        </div>
      </div>
      {asking ? (
        <div data-testid="ai-feedback-form" className="space-y-2 rounded-lg p-2.5 text-xs" style={{ background: A.gray6 }}>
          <p className="font-medium" style={{ color: A.label }}>{copy.t("ai.v2.feedback.question")}</p>
          <div className="flex flex-wrap gap-1.5">
            {REASONS.map((reason) => {
              const on = reasons.includes(reason);
              return (
                <button
                  key={reason}
                  type="button"
                  aria-pressed={on}
                  onClick={() => setReasons((current) => (on ? current.filter((value) => value !== reason) : [...current, reason]))}
                  data-testid="ai-feedback-reason"
                  data-reason={reason}
                  className="rounded-full border px-2.5 py-1"
                  style={on ? { background: "#EFF4FF", borderColor: A.blue, color: A.blue } : { background: A.white, borderColor: A.gray4, color: A.gray1 }}
                >
                  {copy.t(`ai.v2.feedback.reason.${reason}` as TranslationKey)}
                </button>
              );
            })}
          </div>
          <input
            value={note}
            maxLength={500}
            onChange={(event) => setNote(event.target.value)}
            placeholder={copy.t("ai.v2.feedback.note")}
            data-testid="ai-feedback-note"
            className="w-full rounded-md border px-2 py-1"
            style={{ borderColor: A.gray4 }}
          />
          <button type="button" disabled={status === "sending" || (!reasons.length && !note.trim())} onClick={() => void send("down", reasons, note.trim())} data-testid="ai-feedback-send" className="rounded-md px-3 py-1 font-medium text-white disabled:opacity-50" style={{ background: A.blue }}>
            {copy.t("ai.v2.feedback.send")}
          </button>
        </div>
      ) : null}
      {status === "sent" ? <p role="status" data-testid="ai-feedback-thanks" className="text-[11px]" style={{ color: A.gray1 }}>{copy.t("ai.v2.feedback.thanks")}</p> : null}
      {status === "failed" ? <p role="status" className="text-[11px]" style={{ color: "#b91c1c" }}>{copy.t("ai.v2.feedback.failed")}</p> : null}
    </div>
  );
}
