import React, { useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, X } from "lucide-react";
import { useI18n } from "../../i18n/I18n";
import { A } from "./tokens";

// One in-app confirmation for actions that change or remove records: a title,
// what will happen, an optional text field (a required reason, or a name) and
// Confirm / Cancel. It replaces the browser's confirm() and prompt(), which
// cannot be translated, styled or checked for a minimum length.
//
//   const dialog = useConfirm();
//   if (!(await dialog.confirm({ title, description, tone: "danger" }))) return;
//   const reason = await dialog.prompt({ title, field: { label, minLength: 3 } });
//   if (reason === null) return;
//   ...
//   return <>{page}{dialog.element}</>;
//
// Test hooks: `${testId}` on the dialog (default "confirm-dialog"),
// `${testId}-field`, `${testId}-confirm` and `${testId}-cancel`.

export type ConfirmTone = "danger" | "primary";

export type ConfirmField = {
  label: string;
  placeholder?: string;
  hint?: string;
  defaultValue?: string;
  /** Trimmed length the value needs before Confirm is enabled. Default 1 when required. */
  minLength?: number;
  maxLength?: number;
  /** Default true. An optional field can be left empty. */
  required?: boolean;
  /** Default true: a textarea for a reason. False: a one-line input, e.g. a name. */
  multiline?: boolean;
};

export type ConfirmOptions = {
  title: string;
  description?: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Danger for actions that remove, cancel, reject or deactivate. Default primary. */
  tone?: ConfirmTone;
  field?: ConfirmField;
  testId?: string;
};

type ConfirmDialogProps = ConfirmOptions & {
  open: boolean;
  onConfirm: (value: string) => void;
  onCancel: () => void;
};

const COPY = {
  confirm: ["Confirm", "确认"],
  cancel: ["Cancel", "取消"],
  close: ["Close", "关闭"],
  minLength: ["Enter at least {count} characters.", "请至少输入 {count} 个字符。"],
  required: ["Fill this in to continue.", "请填写后继续。"],
} as const;

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function ConfirmDialog({ open, title, description, confirmLabel, cancelLabel, tone = "primary", field, testId = "confirm-dialog", onConfirm, onCancel }: ConfirmDialogProps) {
  const { language } = useI18n();
  const say = (key: keyof typeof COPY, count?: number) => COPY[key][language === "en-US" ? 0 : 1].replace("{count}", String(count ?? ""));
  const titleId = useId();
  const descriptionId = useId();
  const fieldId = useId();
  const panelRef = useRef<HTMLDivElement | null>(null);
  const fieldRef = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  const confirmRef = useRef<HTMLButtonElement | null>(null);
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const [value, setValue] = useState(field?.defaultValue ?? "");
  const [touched, setTouched] = useState(false);

  useEffect(() => {
    if (!open) return;
    setValue(field?.defaultValue ?? "");
    setTouched(false);
  }, [open, field?.defaultValue]);

  const required = field ? field.required !== false : false;
  const minLength = field ? Math.max(field.minLength ?? (required ? 1 : 0), 0) : 0;
  const trimmed = value.trim();
  const valid = !field || (!required && trimmed.length === 0) || trimmed.length >= minLength;
  const fieldError = field && touched && !valid ? (minLength > 1 ? say("minLength", minLength) : say("required")) : "";

  // Focus the field, else Cancel for a danger action and Confirm otherwise;
  // give focus back to whatever opened the dialog when it closes.
  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement as HTMLElement | null;
    const frame = window.requestAnimationFrame(() => {
      (field ? fieldRef.current : tone === "danger" ? cancelRef.current : confirmRef.current)?.focus();
    });
    return () => {
      window.cancelAnimationFrame(frame);
      if (opener && document.contains(opener)) opener.focus();
    };
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  // Escape cancels before any page or modal listener sees it.
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopImmediatePropagation();
      event.preventDefault();
      onCancel();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, onCancel]);

  if (!open || typeof document === "undefined") return null;

  const submit = () => {
    setTouched(true);
    if (!valid) {
      fieldRef.current?.focus();
      return;
    }
    onConfirm(field ? trimmed : "");
  };

  // Tab and Shift+Tab stay inside the dialog.
  const trapFocus = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Tab" || !panelRef.current) return;
    const items = Array.from(panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((item) => item.offsetParent !== null);
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const danger = tone === "danger";
  const fieldClass = `w-full rounded-lg border px-3 py-2 text-sm outline-none focus:ring-2 ${fieldError ? "border-red-400 focus:ring-red-100" : "border-slate-200 focus:border-blue-400 focus:ring-blue-100"}`;
  const fieldProps = {
    id: fieldId,
    ref: fieldRef,
    value,
    placeholder: field?.placeholder,
    maxLength: field?.maxLength,
    "aria-invalid": Boolean(fieldError) || undefined,
    "aria-describedby": fieldError || field?.hint ? `${fieldId}-help` : undefined,
    "aria-required": required || undefined,
    "data-testid": `${testId}-field`,
    className: fieldClass,
    onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setValue(event.target.value),
    onBlur: () => setTouched(true),
  };

  return createPortal(
    <div className="fc-overlay-enter fixed inset-0 z-[80] flex items-center justify-center p-4" style={{ background: "rgba(15,23,42,0.36)" }} onMouseDown={(event) => { if (event.target === event.currentTarget) onCancel(); }}>
      <div
        ref={panelRef}
        role={danger ? "alertdialog" : "dialog"}
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        data-testid={testId}
        data-tone={tone}
        onKeyDown={trapFocus}
        className="fc-dialog-enter w-full max-w-md rounded-2xl bg-white"
        style={{ boxShadow: "0 24px 60px rgba(15,23,42,0.24), 0 0 0 0.5px rgba(15,23,42,0.08)" }}
      >
        <form onSubmit={(event) => { event.preventDefault(); submit(); }}>
          <div className="flex items-start gap-3 px-5 pt-5">
            {danger && (
              <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full" style={{ background: "#fff1f0", color: A.red }} aria-hidden="true">
                <AlertTriangle size={16} />
              </span>
            )}
            <div className="min-w-0 flex-1">
              <h2 id={titleId} className="text-base font-semibold leading-6" style={{ color: A.label }}>{title}</h2>
              {description && <div id={descriptionId} className="mt-1 text-sm leading-6" style={{ color: A.sub }}>{description}</div>}
            </div>
            <button type="button" aria-label={say("close")} onClick={onCancel} className="-mr-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg hover:bg-slate-100 max-sm:h-9 max-sm:w-9" style={{ color: A.gray1 }}>
              <X size={15} />
            </button>
          </div>
          {field && (
            <div className="px-5 pt-4">
              <label htmlFor={fieldId} className="mb-1.5 block text-[13px] font-semibold leading-5" style={{ color: A.sub }}>
                {field.label}{required && <span aria-hidden="true" style={{ color: A.red }}> *</span>}
              </label>
              {field.multiline === false
                ? <input type="text" {...fieldProps} />
                : <textarea rows={3} {...fieldProps} />}
              {(fieldError || field.hint) && (
                <p id={`${fieldId}-help`} className={`mt-1 text-xs ${fieldError ? "text-red-600" : "text-slate-500"}`}>{fieldError || field.hint}</p>
              )}
            </div>
          )}
          <div className="mt-5 flex flex-wrap justify-end gap-2 rounded-b-2xl px-5 py-4" style={{ background: A.gray6, borderTop: "0.5px solid rgba(15,23,42,0.06)" }}>
            <button ref={cancelRef} type="button" data-testid={`${testId}-cancel`} onClick={onCancel} className="h-9 rounded-lg border border-slate-200 bg-white px-4 text-sm font-semibold text-slate-700 hover:bg-slate-50">
              {cancelLabel || say("cancel")}
            </button>
            <button ref={confirmRef} type="submit" data-testid={`${testId}-confirm`} aria-disabled={!valid || undefined} className={`h-9 rounded-lg px-4 text-sm font-semibold text-white ${danger ? "bg-red-600 hover:bg-red-700" : "bg-blue-600 hover:bg-blue-700"} ${valid ? "" : "opacity-50"}`}>
              {confirmLabel || say("confirm")}
            </button>
          </div>
        </form>
      </div>
    </div>,
    document.body,
  );
}

type Pending = { options: ConfirmOptions; resolve: (value: string | null) => void };

/**
 * Opens the confirmation dialog from an event handler. `confirm` resolves to
 * true or false; `prompt` (options with a `field`) resolves to the trimmed
 * text, or null when cancelled. Render `element` once in the component.
 */
export function useConfirm() {
  const [pending, setPending] = useState<Pending | null>(null);
  const pendingRef = useRef<Pending | null>(null);
  pendingRef.current = pending;

  // A dialog still open when the component goes away counts as cancelled.
  useEffect(() => () => pendingRef.current?.resolve(null), []);

  const open = useCallback((options: ConfirmOptions) => new Promise<string | null>((resolve) => {
    pendingRef.current?.resolve(null);
    setPending({ options, resolve });
  }), []);

  const confirm = useCallback(async (options: ConfirmOptions) => (await open(options)) !== null, [open]);
  const prompt = useCallback((options: ConfirmOptions & { field: ConfirmField }) => open(options), [open]);

  const settle = useCallback((value: string | null) => {
    const current = pendingRef.current;
    pendingRef.current = null;
    setPending(null);
    current?.resolve(value);
  }, []);
  const onCancel = useCallback(() => settle(null), [settle]);

  const element = pending
    ? <ConfirmDialog open {...pending.options} onConfirm={(value) => settle(value)} onCancel={onCancel} />
    : null;

  return { confirm, prompt, element };
}
