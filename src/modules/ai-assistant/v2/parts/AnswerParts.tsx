import type { ReactNode } from "react";
import { safeParsePartProps } from "../../../../../shared/assistant-protocol.mjs";
import { ChartPart } from "./ChartPart";
import { ChoicesPart } from "./ChoicesPart";
import { DataTablePart } from "./DataTablePart";
import { FollowupChips } from "./FollowupChips";
import { KpiTilesPart } from "./KpiTilesPart";
import type { Navigate } from "./partKit";
import { PurchaseRequestFormPart } from "./PurchaseRequestFormPart";
import { RecordCardsPart } from "./RecordCardsPart";
import { StreamingText } from "./StreamingText";
import type { AnswerPart, PartRef, PrReceipt } from "./types";

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
  // Next questions only under the latest answer.
  followups: (_part, props, context) => context.latest ? <FollowupChips props={props} language={context.language} onFollowUp={context.onFollowUp} /> : null,
};

// An answer's parts in the order they streamed, the follow-up chips last.
// Text is chipped only for the records the server named in this answer (the
// thread's refs, every UI part's refs and those it found each text names); an
// unknown or malformed part is ignored.
export function AnswerParts({ parts, refs = [], latest = true, ...context }: Omit<Context, "refs" | "latest"> & { parts: AnswerPart[]; refs?: PartRef[]; latest?: boolean }) {
  const known = [...refs, ...parts.flatMap((part) => part.refs || [])];
  const full: Context = { ...context, refs: known, latest };
  const chips = parts.filter((part) => part.type === "ui" && part.component === "followups").slice(-1);
  const ordered = [...parts.filter((part) => !(part.type === "ui" && part.component === "followups")), ...chips];
  return (
    <div data-testid="ai-v2-answer" className="space-y-3">
      {ordered.map((part) => {
        if (part.type === "text") return part.text ? <StreamingText key={part.id} text={part.text} flags={part.flags} refs={known} language={full.language} onNavigate={full.onNavigate} /> : null;
        const render = RENDERERS[part.component];
        if (!render) return null;
        const parsed = safeParsePartProps(part.component, part.props);
        if (!parsed.success) return null;
        return <div key={part.id} data-part-id={part.id} data-component={part.component}>{render(part, parsed.data as never, full)}</div>;
      })}
    </div>
  );
}
