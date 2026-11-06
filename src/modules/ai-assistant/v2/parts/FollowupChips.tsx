import { A } from "../../../../components/ui";
import { usePartCopy } from "./partKit";
import type { FollowupsProps } from "./types";

// Next questions, in the panel's chip look. A chip asks its question as
// typed; the model reads it like any other turn (no skill hint).
export function FollowupChips({ props, language, onFollowUp, disabled = false }: { props: FollowupsProps; language?: string; onFollowUp?: (question: string) => void; disabled?: boolean }) {
  const copy = usePartCopy(language);
  const off = disabled || !onFollowUp;
  return (
    <div data-testid="ai-v2-followups" role="group" aria-label={copy.t("ai.v2.followups")} lang={copy.language} className="flex flex-wrap gap-1.5">
      {props.questions.map((question) => (
        <button key={question} type="button" data-testid="ai-follow-up-chip" onClick={() => onFollowUp?.(question)} disabled={off} className="rounded-full px-3 py-1.5 text-[13px] font-medium hover:bg-blue-50 disabled:cursor-not-allowed" style={{ background: A.white, color: off ? A.gray3 : A.blue, border: `1px solid ${A.gray4}` }}>
          {question}
        </button>
      ))}
    </div>
  );
}
