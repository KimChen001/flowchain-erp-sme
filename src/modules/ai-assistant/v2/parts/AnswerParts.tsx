import type { ReactNode } from "react";
import { safeParsePartProps } from "../../../../../shared/assistant-protocol.mjs";
import { ChartPart } from "./ChartPart";
import { ChoicesPart } from "./ChoicesPart";
import { DataTablePart } from "./DataTablePart";
import { FollowupChips } from "./FollowupChips";
import { KpiTilesPart } from "./KpiTilesPart";
import { A } from "../../../../components/ui";
import { usePartCopy, type Navigate } from "./partKit";
import { PurchaseRequestFormPart } from "./PurchaseRequestFormPart";
import { RecordCardsPart } from "./RecordCardsPart";
import { SetupRecordsPart } from "./SetupRecordsPart";
import { SetupStepsPart } from "./SetupStepsPart";
import { StreamingText } from "./StreamingText";
import type { AnswerPart, PartRef, PrReceipt, SetupReceipt } from "./types";

type Context = {
  threadId: string;
  messageId: string;
  language?: string;
  refs: PartRef[];
  latest: boolean;
  onNavigate?: Navigate;
  onFollowUp?: (question: string) => void;
  onChoose?: (ref: PartRef) => void;
  receipts?: Record<string, PrReceipt>;
  onReceipt?: (partId: string, receipt: PrReceipt) => void;
  // What each setup card created, by part id.
  setupReceipts?: Record<string, SetupReceipt>;
  onSetupReceipt?: (partId: string, receipt: SetupReceipt) => void;
};

// One renderer per component. Props are checked against the protocol first,
// so a part this client cannot read is left out rather than half drawn.
const RENDERERS: Record<string, (part: Extract<AnswerPart, { type: "ui" }>, props: never, context: Context) => ReactNode> = {
  table: (_part, props, context) => <DataTablePart props={props} language={context.language} onNavigate={context.onNavigate} />,
  records: (_part, props, context) => <RecordCardsPart props={props} language={context.language} onNavigate={context.onNavigate} />,
  chart: (_part, props, context) => <ChartPart props={props} language={context.language} onNavigate={context.onNavigate} />,
  kpis: (_part, props, context) => <KpiTilesPart props={props} language={context.language} onNavigate={context.onNavigate} />,
  choices: (_part, props, context) => <ChoicesPart props={props} language={context.language} onChoose={context.latest ? context.onChoose : undefined} />,
  pr_form: (part, props, context) => <PurchaseRequestFormPart props={props} partId={part.id} threadId={context.threadId} messageId={context.messageId} language={context.language} onNavigate={context.onNavigate} receipt={context.receipts?.[part.id] || null} onReceipt={context.onReceipt ? (receipt) => context.onReceipt?.(part.id, receipt) : undefined} />,
  setup_steps: (_part, props, context) => <SetupStepsPart props={props} language={context.language} onNavigate={context.onNavigate} />,
  setup_form: (part, props, context) => <SetupRecordsPart props={props} partId={part.id} language={context.language} onNavigate={context.onNavigate} receipt={context.setupReceipts?.[part.id] || null} onReceipt={context.onSetupReceipt ? (receipt) => context.onSetupReceipt?.(part.id, receipt) : undefined} />,
  // Next questions only under the latest answer.
  followups: (_part, props, context) => context.latest ? <FollowupChips props={props} language={context.language} onFollowUp={context.onFollowUp} /> : null,
};

// The parts that show records or a form. The answer's first sentence goes
// above the first of them, whenever the model wrote it (2026-11-05: fifteen
// order cards came before "The table lists all 15").
const DISPLAYS = new Set(["table", "records", "chart", "kpis", "choices", "pr_form", "setup_steps", "setup_form"]);
const isDisplay = (part: AnswerPart) => part.type === "ui" && DISPLAYS.has(part.component);

export function textFirst(parts: AnswerPart[]): AnswerPart[] {
  const display = parts.findIndex(isDisplay);
  const lead = parts.findIndex((part) => part.type === "text" && (part.text.trim() || part.replaced));
  if (display < 0 || lead < 0 || lead < display) return parts;
  const text = parts[lead];
  return [...parts.slice(0, display), text, ...parts.slice(display).filter((part) => part !== text)];
}

// A sentence ends at 。！？!? or at a full stop before a space or the line's end.
function sentences(line: string): string[] {
  const out: string[] = [];
  let start = 0;
  for (let at = 0; at < line.length; at += 1) {
    const char = line[at];
    if (!/[。！？!?]/.test(char) && !(char === "." && (at + 1 === line.length || /\s/.test(line[at + 1])))) continue;
    let end = at + 1;
    while (end < line.length && /[。！？!?"”’」』）)]/.test(line[end])) end += 1;
    while (end < line.length && /\s/.test(line[end])) end += 1;
    out.push(line.slice(start, end));
    start = end;
    at = end - 1;
  }
  if (start < line.length) out.push(line.slice(start));
  return out;
}
const LIST_MARK = /^\s*(?:[-*+•]|\d{1,3}[.)])\s+/;

// The text without some of its sentences; a line left empty goes.
function withoutSentences(text: string, drop: (sentence: string) => boolean) {
  return text.split("\n").flatMap((line) => {
    const all = sentences(line);
    const kept = all.filter((sentence) => !drop(sentence));
    if (kept.length === all.length) return [line];
    const rest = kept.join("").trimEnd();
    return rest.replace(LIST_MARK, "").trim() ? [rest] : [];
  }).join("\n").trim();
}

// A sentence that asks the user something, or tells them to pick from the
// buttons ("Pick one, or…", 请选一个, 请点选…).
const QUESTION = /[?？]["”’」』）)]*\s*$/;
const PICK = /^\s*(?:please\s+)?(?:pick|choose|select|tap|click)\b|\b(?:pick|choose|select)\s+(?:one|an?\s+(?:order|record|item|supplier))\b|请(?:点选|选择|选|从中选)|选一[个张项条家]|点选/i;

// The text without the questions it asks the user: when the answer offers
// buttons to pick from, they ask (2026-11-05: "which record?" three times).
export function withoutQuestions(text: string) {
  // A closing "，请选一张（，或者告诉我订单编号）。" goes, and the sentence it ends stays.
  const trimmed = text.replace(/[，,]\s*(?:请(?:点选|选择|选|从中选)|选一[个张项条家])[^。！？\n]*(?=[。！？]|$)/gm, "");
  return withoutSentences(trimmed, (sentence) => QUESTION.test(sentence) || PICK.test(sentence));
}

const sentenceKey = (sentence: string) => sentence.replace(/[\s*_`]+/g, "").trim();

// Text parts after the first without the sentences an earlier part already
// said (2026-11-05: a Chinese answer wrote its first sentence again after
// the table).
export function withoutRepeats(parts: AnswerPart[]): AnswerPart[] {
  const said = new Set<string>();
  return parts.map((part) => {
    if (part.type !== "text" || !part.text) return part;
    const text = said.size ? withoutSentences(part.text, (sentence) => sentenceKey(sentence).length > 8 && said.has(sentenceKey(sentence))) : part.text;
    for (const line of part.text.split("\n")) for (const sentence of sentences(line)) said.add(sentenceKey(sentence));
    return text === part.text ? part : { ...part, text };
  });
}

// An answer's parts in the order they streamed, its first text above the
// first table, chart or form, and the follow-up chips last. Text is chipped
// only for the records the server named in this answer (the thread's refs,
// every UI part's refs and those it found each text names); an unknown or
// malformed part is ignored.
export function AnswerParts({ parts, refs = [], latest = true, ...context }: Omit<Context, "refs" | "latest"> & { parts: AnswerPart[]; refs?: PartRef[]; latest?: boolean }) {
  const copy = usePartCopy(context.language);
  const known = [...refs, ...parts.flatMap((part) => part.refs || [])];
  const full: Context = { ...context, refs: known, latest };
  const chips = parts.filter((part) => part.type === "ui" && part.component === "followups").slice(-1);
  const ordered = [...withoutRepeats(textFirst(parts.filter((part) => !(part.type === "ui" && part.component === "followups")))), ...chips];
  const asking = parts.some((part) => part.type === "ui" && part.component === "choices");
  return (
    <div data-testid="ai-v2-answer" className="space-y-3">
      {ordered.map((part) => {
        if (part.type === "text") {
          const shown = asking ? withoutQuestions(part.text) : part.text;
          // A sentence (or the whole part) the server left out because it
          // read as if something had been done: a short note, apart from the prose.
          const note = part.replaced === "unbacked_action_claim" ? copy.t(shown ? "ai.v2.note.claimSentence" : "ai.v2.note.claimPart") : "";
          if (!note) return shown ? <StreamingText key={part.id} text={shown} flags={part.flags} refs={known} language={full.language} onNavigate={full.onNavigate} /> : null;
          return (
            <div key={part.id} className="space-y-1">
              {shown ? <StreamingText text={shown} flags={part.flags} refs={known} language={full.language} onNavigate={full.onNavigate} /> : null}
              {note ? <p data-testid="ai-v2-claim-note" lang={copy.language} className="text-[12px]" style={{ color: A.gray1 }}>{note}</p> : null}
            </div>
          );
        }
        const render = RENDERERS[part.component];
        if (!render) return null;
        const parsed = safeParsePartProps(part.component, part.props);
        if (!parsed.success) return null;
        return <div key={part.id} data-part-id={part.id} data-component={part.component}>{render(part, parsed.data as never, full)}</div>;
      })}
    </div>
  );
}
