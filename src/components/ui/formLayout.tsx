import React from "react";
import { AlertCircle, ArrowLeft, Trash2 } from "lucide-react";
import { A, Card } from "./index";
import { listButtonClass } from "./listLayout";
import { useI18n } from "../../i18n/I18n";

// The entry form standard. The purchase request, sales order and goods
// receipt forms follow it, and so should any new form that records a document.
// It builds on Field (index.tsx), the list layout's cards and buttons
// (listLayout.tsx) and FocusFirstField.
//
// 1. Sections. The form is a column of cards:
//    - FormHeader: the form's title (left out when the page's h1 already
//      says it), one line on what saving does, read-only facts about the
//      document (its source order, its number on save), any banner (a
//      prefill note) and the "* Required" note.
//    - FormSection for each group of fields ("Order details", "Lines"), with
//      a title and an optional line under it.
//    - FormActionBar last.
//    FocusFirstField goes inside the form so focus starts on its first field.
// 2. Fields. Every control sits in a Field with a visible label; the label
//    names the control. Header fields use formGridClass: one column on
//    phones, two from 768 px, four from 1024 px. A document line is a
//    FormLineCard holding its own grid, which is also one column on phones.
//    A table of lines (a receipt against an order) keeps its table and
//    scrolls sideways on phones.
// 3. Required fields. A field the save is refused without gets Field's
//    `required`: a "*" after the label (hidden from screen readers) and
//    aria-required on the control. FormHeader shows "* Required" once.
//    Optional fields carry no "(optional)"; a field that is needed only in
//    some cases (a reason when some goods are rejected) is not starred and
//    says so in its message.
// 4. Validation. The form checks its rules when Save is clicked, not while
//    typing, and never disables Save to hide a missing field. Each message
//    goes under its field (Field's `error`, or FieldError in a table cell):
//    red text tied to the control with aria-describedby, and aria-invalid on
//    the control. Focus moves to the first field with a message
//    (focusFirstInvalid). The rules are the server's own: the client adds no
//    rule the server does not have, it only says it sooner. A refusal from
//    the server that names a field goes under that field too. A message
//    about the whole form (nothing to receive, a conflict, a lost
//    connection) goes in the action bar, beside the buttons, where the
//    person just clicked; after a refusal with field messages it says
//    "Check the highlighted fields."
// 5. Actions. One FormActionBar at the end of the form, kept in view at the
//    bottom of the window and clear of the assistant button. Buttons sit on
//    the right in a fixed order: Cancel · Save draft · Submit, the primary
//    (blue) action last. A form with one save action shows Cancel · Save.
//    The clicked button says "Saving…" and the others wait.
//
// Copy is written in English with its Chinese translation; callers pass
// labels and messages already in the interface language.

const COPY = {
  required: ["Required", "必填"],
  cancel: ["Cancel", "取消"],
  saving: ["Saving…", "正在保存…"],
  checkFields: ["Check the highlighted fields.", "请检查标出的字段。"],
} as const;

export function useFormCopy() {
  const { language } = useI18n();
  return (key: keyof typeof COPY) => COPY[key][language === "en-US" ? 0 : 1];
}

// Header fields: one column on phones, two from 768 px, four from 1024 px.
export const formGridClass = "grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-4";

export const requiredMarkClass = "text-[13px] leading-5 font-semibold text-blue-600";

// The "*" after a label. Screen readers get aria-required on the control.
export function RequiredMark() {
  return <span aria-hidden="true" className={requiredMarkClass}>*</span>;
}

export function RequiredNote() {
  const say = useFormCopy();
  return (
    <p className="mt-3 text-xs" style={{ color: A.sub }} data-testid="form-required-note">
      <span className={requiredMarkClass}>*</span> {say("required")}
    </p>
  );
}

// A field's message, under it; `id` is what the control's aria-describedby names.
export function FieldError({ id, children, testId }: { id: string; children: React.ReactNode; testId?: string }) {
  return <p id={id} className="mt-1 text-[12px] leading-[18px] text-red-600" data-testid={testId}>{children}</p>;
}

// The attributes a control gets when it has a message.
export const invalidProps = (errorId: string, error?: string | null) =>
  error ? { "aria-invalid": true as const, "aria-describedby": errorId } : {};

// After a refused save: focus the first field with a message, inside `root`
// (the form) when given, and bring it to the middle of the window so the
// action bar does not cover it. Runs after React has drawn the messages.
export function focusFirstInvalid(root?: HTMLElement | null) {
  requestAnimationFrame(() => {
    const scope: ParentNode = root || document;
    const field = scope.querySelector<HTMLElement>('[aria-invalid="true"]');
    if (!field) return;
    field.focus({ preventScroll: true });
    field.scrollIntoView({ block: "center" });
  });
}

// Leave out `title` when the page's h1 already names the form ("New sales
// order"), so the title is not said twice.
export function FormHeader({ title, intro, back, aside, children, testId }: {
  title?: string;
  intro?: React.ReactNode;
  back?: { label: string; onClick: () => void };
  aside?: React.ReactNode;
  children?: React.ReactNode;
  testId?: string;
}) {
  return (
    <Card className="p-4 sm:p-5" data-testid={testId}>
      {back && (
        <button type="button" onClick={back.onClick} className="mb-3 inline-flex items-center gap-1 text-xs font-medium text-blue-600 hover:underline">
          <ArrowLeft size={13} />{back.label}
        </button>
      )}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          {title && <h2 className="mb-1 text-lg font-semibold" style={{ color: A.label }}>{title}</h2>}
          {intro && <div className="text-xs" style={{ color: A.sub }}>{intro}</div>}
        </div>
        {aside && <div className="flex flex-wrap items-center gap-2">{aside}</div>}
      </div>
      {children}
      <RequiredNote />
    </Card>
  );
}

export function FormSection({ title, description, right, children, testId }: {
  title: string;
  description?: React.ReactNode;
  right?: React.ReactNode;
  children: React.ReactNode;
  testId?: string;
}) {
  return (
    <Card className="p-4 sm:p-5" data-testid={testId}>
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="fc-section-title" style={{ color: A.label }}>{title}</h2>
          {description && <div className="mt-1 text-xs" style={{ color: A.sub }}>{description}</div>}
        </div>
        {right && <div className="ml-auto flex flex-wrap items-center gap-2">{right}</div>}
      </div>
      {children}
    </Card>
  );
}

// One document line: its number, an aside (the line amount) and Remove.
export function FormLineCard({ label, aside, remove, children, testId }: {
  label: string;
  aside?: React.ReactNode;
  remove?: { label: string; onClick: () => void; disabled?: boolean };
  children: React.ReactNode;
  testId?: string;
}) {
  return (
    <div className="rounded-lg border p-3 sm:p-4" style={{ borderColor: A.border }} data-testid={testId}>
      <div className="mb-3 flex items-center gap-3">
        <span className="inline-flex h-6 items-center rounded-full bg-blue-50 px-2.5 text-xs font-semibold text-blue-700">{label}</span>
        {aside && <span className="ml-auto text-xs tabular-nums" style={{ color: A.sub }}>{aside}</span>}
        {remove && (
          <button
            type="button"
            aria-label={remove.label}
            title={remove.label}
            onClick={remove.onClick}
            disabled={remove.disabled}
            className={`${aside ? "" : "ml-auto "}rounded-md p-1 text-red-600 hover:bg-red-50 disabled:opacity-40`}
          >
            <Trash2 size={15} />
          </button>
        )}
      </div>
      {children}
    </div>
  );
}

export type FormAction = { label: string; onClick: () => void; busy?: boolean; disabled?: boolean; testId?: string };

// Cancel · Save draft · Submit, the primary action last. `message` is about
// the whole form (see 4 above): it sits left of the buttons, so the bar stays
// one row on wide screens; `messageTestId` names it for tests.
export function FormActionBar({ onCancel, draft, submit, message, messageTestId, testId }: {
  onCancel: () => void;
  draft?: FormAction;
  submit: FormAction;
  message?: React.ReactNode;
  messageTestId?: string;
  testId?: string;
}) {
  const say = useFormCopy();
  const busy = Boolean(draft?.busy || submit.busy);
  const button = (action: FormAction, primary: boolean) => (
    <button
      type="button"
      data-testid={action.testId}
      disabled={busy || action.disabled}
      onClick={action.onClick}
      className={`${primary ? listButtonClass.primary : listButtonClass.secondary} disabled:cursor-not-allowed disabled:opacity-60`}
    >
      {action.busy ? say("saving") : action.label}
    </button>
  );
  return (
    <div className="sticky bottom-20 z-10 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border bg-white p-3 shadow-sm sm:px-4" style={{ borderColor: A.border }} data-testid={testId}>
      {message && (
        <div role="alert" className="flex min-w-0 flex-1 basis-60 items-start gap-1.5 text-xs leading-5 text-red-700" data-testid={messageTestId}>
          <AlertCircle size={14} className="mt-[3px] shrink-0" aria-hidden="true" />
          <div className="min-w-0">{message}</div>
        </div>
      )}
      <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
        <button type="button" disabled={busy} onClick={onCancel} className={`${listButtonClass.secondary} disabled:opacity-60`}>{say("cancel")}</button>
        {draft && button(draft, false)}
        {button(submit, true)}
      </div>
    </div>
  );
}
