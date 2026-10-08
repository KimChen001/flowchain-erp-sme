import { useState } from "react";
import type { ReactNode } from "react";
import { AlertTriangle, CheckCircle2, RefreshCw } from "lucide-react";
import { A, Chip } from "../../components/ui";
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

export function StatusChip({ status }: { status: string }) {
  const { t } = useI18n();
  return <Chip label={STATUS_KEYS[status] ? t(STATUS_KEYS[status]) : status || "—"} color={A.blue} bg="#eff6ff" />;
}

// One operation: an optional reason, a preview of the server's plan, then a
// confirm that runs exactly the previewed operation. The server words its
// issues in English; issueText gives the translated text for the codes a
// screen knows, and the server's message is kept for the rest. issueDetail
// shows what a blocking issue is about, under the notice.
export function TwoStepAction({ label, testId, previewUrl, runUrl, payload, reasonLabel, reasonMaxLength, onDone, tone = "primary", issueText, issueDetail }: {
  label: string; testId: string; previewUrl: string; runUrl: string; payload: () => Record<string, unknown>;
  reasonLabel?: string; reasonMaxLength?: number; onDone: () => void; tone?: "primary" | "secondary";
  issueText?: (code: string | undefined) => string | undefined;
  issueDetail?: (issue: Issue) => ReactNode;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [plan, setPlan] = useState<Plan | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const describe = (issue: Issue) => issueText?.(issue.code) || issue.message;
  const body = () => ({ ...payload(), ...(reasonLabel ? { reason, resolution: reason } : {}) });
  const preview = async () => {
    setError("");
    try { setPlan(await apiJson<Plan>(previewUrl, { method: "POST", body: JSON.stringify(body()) })); } catch (reason) { setError(reason instanceof ApiError ? issueText?.(reason.code) || reason.message : message(reason, t("finance.loadFailed"))); }
  };
  const confirm = async () => {
    setError("");
    setBusy(true);
    try {
      await apiJson(runUrl, { method: "POST", body: JSON.stringify({ ...body(), idempotencyKey: createSecureClientMutationId("p2p") }) });
      setOpen(false);
      setPlan(null);
      setReason("");
      onDone();
    } catch (cause) {
      setError(cause instanceof ApiError ? issueText?.(cause.code) || cause.message : cause instanceof Error ? cause.message : t("finance.loadFailed"));
    } finally {
      setBusy(false);
    }
  };
  if (!open) return <button type="button" data-testid={testId} className={`${button} ${tone === "primary" ? "text-white" : "border border-slate-200"}`} style={tone === "primary" ? { background: A.blue } : undefined} onClick={() => setOpen(true)}>{label}</button>;
  return (
    <div className="w-full space-y-2 rounded-xl border border-slate-200 p-3" data-testid={`${testId}-panel`}>
      <div className="text-sm font-semibold">{label}</div>
      {reasonLabel && (
        <label className="block text-xs">{reasonLabel}
          <input data-testid={`${testId}-reason`} className={`${field} mt-1 w-full`} maxLength={reasonMaxLength} value={reason} onChange={(event) => { setReason(event.target.value); setPlan(null); }} />
        </label>
      )}
      <div className="flex flex-wrap gap-2">
        <button type="button" data-testid={`${testId}-preview`} className={`${button} border border-slate-200`} onClick={() => void preview()}><RefreshCw size={14} />{t("finance.preview")}</button>
        <button type="button" data-testid={`${testId}-confirm`} className={`${button} text-white`} style={{ background: A.blue }} disabled={!plan?.allowed || busy} onClick={() => void confirm()}>{t("finance.confirm")}</button>
        <button type="button" className={`${button} text-slate-600`} onClick={() => { setOpen(false); setPlan(null); setError(""); }}>{t("finance.close")}</button>
      </div>
      {plan && (plan.allowed ? <Notice tone="success">{t("finance.previewAllowed")}</Notice> : <Notice>{(plan.blockingIssues || []).map(describe).join(" · ")}</Notice>)}
      {plan && !plan.allowed && issueDetail && (plan.blockingIssues || []).map((issue, index) => <div key={`${issue.code}-${index}`}>{issueDetail(issue)}</div>)}
      {error && <Notice>{error}</Notice>}
    </div>
  );
}
