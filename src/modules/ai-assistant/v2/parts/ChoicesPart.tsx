import { A } from "../../../../components/ui";
import { usePartCopy } from "./partKit";
import type { ChoicesProps, PartRef } from "./types";

// When the question could mean more than one record: one button per record.
// A click sends a new turn carrying the chosen ref, which the server checks
// against the refs it gave this thread.
export function ChoicesPart({ props, language, onChoose }: { props: ChoicesProps; language?: string; onChoose?: (ref: PartRef) => void }) {
  const copy = usePartCopy(language);
  return (
    <section data-testid="ai-v2-choices" lang={copy.language} className="space-y-2">
      <p className="text-[13px] font-medium" style={{ color: A.label }}>{copy.t(`ai.v2.choices.${props.promptCode}`)}</p>
      <div className="flex flex-wrap gap-1.5">
        {props.options.map((option) => (
          <button key={`${option.type}:${option.id}`} type="button" data-testid="ai-v2-choice" data-ref-type={option.type} data-ref-id={option.id} onClick={() => onChoose?.(option)} disabled={!onChoose} className="rounded-lg px-3 py-1.5 text-[13px] font-semibold hover:bg-blue-50 disabled:opacity-50" style={{ background: A.white, color: A.blue, border: `1px solid ${A.gray4}` }}>
            {option.label}
          </button>
        ))}
      </div>
    </section>
  );
}
