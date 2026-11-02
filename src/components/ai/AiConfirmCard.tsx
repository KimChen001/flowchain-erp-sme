import type { ReactNode } from "react";
import { A } from "../ui";

export type AiConfirmField = { label: string; value: ReactNode };

// The card an assistant proposal is confirmed on: what is proposed, its key
// fields, and one primary button. Nothing happens until the user presses it.
// The purchase request proposal is its first user; later confirmed actions
// reuse it.
export function AiConfirmCard({
  label,
  fields,
  primary,
  secondary,
  cancelLabel,
  onCancel,
  testId = "ai-confirm-card",
}: {
  label: string;
  fields: AiConfirmField[];
  primary: ReactNode;
  secondary?: ReactNode;
  cancelLabel?: string;
  onCancel?: () => void;
  testId?: string;
}) {
  return (
    <section data-testid={testId} className="rounded-xl bg-white p-3.5 shadow-sm" style={{ border: `1px solid ${A.gray4}` }}>
      <div data-testid="ai-confirm-label" className="text-xs font-semibold" style={{ color: A.blue }}>{label}</div>
      {fields.length ? (
        <dl className="mt-2.5 grid grid-cols-[minmax(72px,auto)_1fr] gap-x-4 gap-y-1.5 text-sm">
          {fields.map((field) => (
            <div key={field.label} className="contents">
              <dt style={{ color: A.sub }}>{field.label}</dt>
              <dd className="min-w-0 break-words font-medium" style={{ color: A.label }}>{field.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      <div className="mt-3.5 flex flex-wrap items-center gap-2">
        {primary}
        {secondary}
        {onCancel && cancelLabel ? (
          <button type="button" data-testid="ai-confirm-cancel" onClick={onCancel} className="rounded-lg px-2 py-2 text-sm font-medium hover:bg-slate-50" style={{ color: A.sub }}>
            {cancelLabel}
          </button>
        ) : null}
      </div>
    </section>
  );
}
