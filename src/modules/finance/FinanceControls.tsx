import { useId, useRef, useState } from "react";
import type { ReactNode } from "react";
import { AlertTriangle, CheckCircle2, RefreshCw } from "lucide-react";
import { A } from "../../components/ui";
import { FieldError, RequiredMark, invalidProps } from "../../components/ui/formLayout";
import { StatusChip as ToneChip, statusToneOf, type StatusTone } from "../../components/ui/listLayout";
import { useI18n } from "../../i18n/I18n";
import { ApiError, apiJson } from "../../lib/api-client";
import { createSecureClientMutationId } from "../../lib/client-id";

// Controls shared by the bill, invoice and payment screens: the translated
// status chip, the warning or success notice, and the preview-then-confirm
// action that runs exactly the operation the server previewed.

type TranslationKey = Parameters<ReturnType<typeof useI18n>["t"]>[0];
type Issue = { code?: string; message?: string; details?: unknown };
type Plan = { allowed: boolean; blockingIssues?: Issue[] };

export const field = "rounded-lg border border-slate-200 px-3 py-2 text-sm";
export const button = "inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium disabled:opacity-50";
export const message = (reason: unknown, fallback: string) => (reason instanceof Error ? reason.message : fallback);
const STATUS_KEYS: Record<string, TranslationKey> = {
  draft: "finance.status.draft",
  submitted: "finance.status.submitted",
  matched: "finance.status.matched",
  exception: "finance.status.exception",
  approved: "finance.status.approved",
  held: "finance.status.held",
  export_ready: "finance.status.export_ready",
  open: "finance.status.open",
  resolved: "finance.status.resolved",
  cancelled: "finance.status.cancelled",
  issued: "finance.status.issued",
  overdue: "finance.status.overdue",
  disputed: "finance.status.disputed",
  partially_settled: "finance.status.partially_settled",
  settled: "finance.status.settled",
  recorded: "finance.status.recorded",
  voided: "finance.status.voided",
  variance_approved: "finance.status.variance_approved",
  to_pay: "finance.status.to_pay",
  to_be_paid: "finance.status.to_be_paid",
};
// Finance statuses the shared tones do not know: an approved variance is
// done; an approved invoice still to pay, or an issued one still to be paid,
// is in progress.
const STATUS_TONES: Record<string, StatusTone> = { variance_approved: "success", to_pay: "info", to_be_paid: "info" };
export const financeStatusTone = (status: string): StatusTone => STATUS_TONES[status] || statusToneOf(status);

// The status a supplier invoice shows. Once approved, where its payment
// stands (to_pay, partially_settled, settled: the server's paymentStatus);
// in exception with every difference approved, "Variance approved". The
// stored status does not change.
export const shownBillStatus = (row: { status?: unknown; matchStatus?: unknown; paymentStatus?: unknown }) => {
  const status = String(row.status || "");
  if (status === "approved" && row.paymentStatus) return String(row.paymentStatus);
  if (status === "exception" && row.matchStatus === "variance_approved") return "variance_approved";
  return status;
};

// The status a customer invoice shows. Once issued, where its payment stands
// (to_be_paid, partially_settled, settled): the server's paymentStatus, else
// read from the receivable shown with it (the invoice page); a disputed
// receivable reads "disputed". The stored status does not change.
const RECEIVABLE_PAYMENT_STATES: Record<string, string> = { open: "to_be_paid", overdue: "to_be_paid", partially_settled: "partially_settled", settled: "settled", disputed: "disputed" };
export const shownCustomerInvoiceStatus = (row: { status?: unknown; paymentStatus?: unknown }, receivableStatus?: unknown) => {
  const status = String(row.status || "");
  if (status !== "issued") return status;
  if (row.paymentStatus) return String(row.paymentStatus);
  return RECEIVABLE_PAYMENT_STATES[String(receivableStatus || "")] || status;
};

export function Notice({ children, tone = "warning" }: { children: ReactNode; tone?: "warning" | "success" }) {
  const colors = tone === "success" ? "border-emerald-200 bg-emerald-50 text-emerald-900" : "border-amber-200 bg-amber-50 text-amber-900";
  return (
    <div role={tone === "warning" ? "alert" : "status"} className={`flex gap-2 rounded-xl border p-3 text-sm ${colors}`}>
      {tone === "success" ? <CheckCircle2 className="mt-0.5 shrink-0" size={16} /> : <AlertTriangle className="mt-0.5 shrink-0" size={16} />}
      <span>{children}</span>
    </div>
  );
}

// A stored finance status code in the interface language, as the status chip
// shows it; an unknown code is shown as stored.
export function useFinanceStatusLabel() {
  const { t } = useI18n();
  return (status: string) => (STATUS_KEYS[status] ? t(STATUS_KEYS[status]) : status || "—");
}

// Coloured by the shared status tones: red overdue or disputed, teal settled.
export function StatusChip({ status }: { status: string }) {
  const label = useFinanceStatusLabel();
  return <ToneChip label={label(status)} tone={financeStatusTone(status)} />;
}

// One operation: an optional reason, a preview of the server's plan, then a
// confirm that runs exactly the previewed operation. The server words its
// issues in English; issueText gives the translated text for the codes a
// screen knows, and the server's message is kept for the rest. issueDetail
// shows what a blocking issue is about, under the notice.
// oneStep (owner decision D4): a step that only changes a document's status
// (submit, approve, issue) runs on one click. The server still previews it
// first; when the preview blocks it, the panel opens with the reason, as a
// two-step action shows it. Posting and payments keep preview and confirm.
// Confirm works without Preview: it previews first and runs only what the
// server allows; it is disabled only after a preview the server refused, until
// something changes. reasonRequired (the form standard): the reason is starred,
// and Preview or Confirm with it empty puts that message under the field
// without asking the server. note: one line on what confirming also does.
// afterRun: a follow-up after the operation succeeded, given the same body.
export function TwoStepAction({ label, testId, previewUrl, runUrl, payload, reasonLabel, reasonMaxLength, reasonRequired, note, afterRun, onDone, tone = "primary", issueText, issueDetail, oneStep = false }: {
  label: string; testId: string; previewUrl: string; runUrl: string; payload: () => Record<string, unknown>;
  reasonLabel?: string; reasonMaxLength?: number; reasonRequired?: string; note?: ReactNode;
  afterRun?: (body: Record<string, unknown>) => Promise<void>;
  onDone: () => void; tone?: "primary" | "secondary";
  issueText?: (code: string | undefined) => string | undefined;
  issueDetail?: (issue: Issue) => ReactNode;
  oneStep?: boolean;
}) {
  const { t } = useI18n();
  const reasonId = useId();
  const reasonRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [reasonError, setReasonError] = useState("");
  const [plan, setPlan] = useState<Plan | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const describe = (issue: Issue) => issueText?.(issue.code) || issue.message;
  const body = () => ({ ...payload(), ...(reasonLabel ? { reason, resolution: reason } : {}) });
  // The required reason, checked here before the server is asked.
  const reasonGiven = () => {
    if (!reasonLabel || !reasonRequired || reason.trim()) return true;
    setReasonError(reasonRequired);
    setPlan(null);
    requestAnimationFrame(() => reasonRef.current?.focus());
    return false;
  };
  const preview = async () => {
    setError("");
    if (!reasonGiven()) return null;
    try {
      const next = await apiJson<Plan>(previewUrl, { method: "POST", body: JSON.stringify(body()) });
      setPlan(next);
      return next;
    } catch (reason) {
      setError(reason instanceof ApiError ? issueText?.(reason.code) || reason.message : message(reason, t("finance.loadFailed")));
      return null;
    }
  };
  // One click: preview, then run it when the server allows it. A blocked
  // preview, or a run that fails (another change got there first, a lost
  // connection), opens the panel with the reason and Preview/Confirm to retry.
  const runAtOnce = async () => {
    setBusy(true);
    const next = await preview();
    setBusy(false);
    if (!next?.allowed || !(await confirm(next))) setOpen(true);
  };
  // `known`: the plan just previewed, before React has stored it.
  const confirm = async (known?: Plan) => {
    setError("");
    if (!reasonGiven()) return false;
    let current = known || plan;
    if (!current) {
      setBusy(true);
      current = await preview();
      setBusy(false);
    }
    if (!current?.allowed) return false;
    setBusy(true);
    try {
      const sent = body();
      await apiJson(runUrl, { method: "POST", body: JSON.stringify({ ...sent, idempotencyKey: createSecureClientMutationId("p2p") }) });
      if (afterRun) await afterRun(sent).catch(() => undefined);
      setOpen(false);
      setPlan(null);
      setReason("");
      onDone();
      return true;
    } catch (cause) {
      setError(cause instanceof ApiError ? issueText?.(cause.code) || cause.message : cause instanceof Error ? cause.message : t("finance.loadFailed"));
      // The preview no longer holds (another change got there first): preview again before confirming.
      setPlan(null);
      return false;
    } finally {
      setBusy(false);
    }
  };
  if (!open) return <button type="button" data-testid={testId} data-one-step={oneStep && !reasonLabel ? "true" : undefined} disabled={busy} className={`${button} ${tone === "primary" ? "text-white" : "border border-slate-200"} disabled:opacity-50`} style={tone === "primary" ? { background: A.blue } : undefined} onClick={() => (oneStep && !reasonLabel ? void runAtOnce() : setOpen(true))}>{busy ? t("finance.working") : label}</button>;
  const reasonErrorId = `${reasonId}-error`;
  return (
    <div className="w-full space-y-2 rounded-xl border border-slate-200 p-3" data-testid={`${testId}-panel`}>
      <div className="text-sm font-semibold">{label}</div>
      {note && <div className="text-xs text-slate-600" data-testid={`${testId}-note`}>{note}</div>}
      {reasonLabel && (
        <div className="space-y-1">
          <div className="flex items-baseline gap-0.5">
            <label htmlFor={reasonId} className="block text-xs">{reasonLabel}</label>
            {reasonRequired && <RequiredMark />}
          </div>
          <input
            ref={reasonRef}
            id={reasonId}
            data-testid={`${testId}-reason`}
            className={`${field} w-full`}
            maxLength={reasonMaxLength}
            value={reason}
            {...(reasonRequired ? { "aria-required": true } : {})}
            {...invalidProps(reasonErrorId, reasonError)}
            onChange={(event) => { setReason(event.target.value); setReasonError(""); setPlan(null); }}
          />
          {reasonError && <FieldError id={reasonErrorId} testId={`${testId}-reason-error`}>{reasonError}</FieldError>}
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        <button type="button" data-testid={`${testId}-preview`} className={`${button} border border-slate-200`} onClick={() => void preview()}><RefreshCw size={14} />{t("finance.preview")}</button>
        <button type="button" data-testid={`${testId}-confirm`} className={`${button} text-white`} style={{ background: A.blue }} disabled={busy || Boolean(plan && !plan.allowed)} onClick={() => void confirm()}>{busy ? t("finance.working") : t("finance.confirm")}</button>
        <button type="button" className={`${button} text-slate-600`} onClick={() => { setOpen(false); setPlan(null); setError(""); setReasonError(""); }}>{t("finance.close")}</button>
      </div>
      {plan && (plan.allowed ? <Notice tone="success">{t("finance.previewAllowed")}</Notice> : <Notice>{(plan.blockingIssues || []).map(describe).join(" · ")}</Notice>)}
      {plan && !plan.allowed && issueDetail && (plan.blockingIssues || []).map((issue, index) => <div key={`${issue.code}-${index}`}>{issueDetail(issue)}</div>)}
      {error && <Notice>{error}</Notice>}
    </div>
  );
}
