import { useState } from "react";
import { CheckCircle2, Info, RefreshCw } from "lucide-react";
import { A } from "../../components/ui";
import { useI18n } from "../../i18n/I18n";
import { ApiError, apiJson } from "../../lib/api-client";
import { createSecureClientMutationId } from "../../lib/client-id";
import { StatusChip, TwoStepAction, button, field } from "./FinanceControls";

// Payments made or received outside FlowChain, recorded on a bill to pay or a
// receivable (docs/bills-invoices-and-accounting-handoff.md, step 2). Each
// record lowers what is outstanding; a wrong one is voided with a reason.
// FlowChain never moves money.

type TranslationKey = Parameters<ReturnType<typeof useI18n>["t"]>[0];
type Payment = {
  id: string;
  paymentDate: string;
  amount: string | null;
  currency: string;
  method: string;
  reference: string | null;
  note: string | null;
  status: "recorded" | "voided";
  voidReason: string | null;
  version: number;
  availableActions: string[];
};
export type PaymentObligation = {
  id: string;
  outstandingAmount: string | null;
  paidAmount?: string | null;
  currency: string;
  status: string;
  version: number;
  availableActions?: string[];
  payments?: Payment[];
};
type Plan = {
  allowed: boolean;
  blockingIssues?: Array<{ message?: string }>;
  after?: { outstandingAmount: string; status: string };
};

const METHODS = ["check", "ach", "wire", "card", "cash", "other"] as const;
const METHOD_KEYS: Record<string, TranslationKey> = {
  check: "finance.method.check",
  ach: "finance.method.ach",
  wire: "finance.method.wire",
  card: "finance.method.card",
  cash: "finance.method.cash",
  other: "finance.method.other",
};
// Today on the user's calendar, not in UTC: in a US evening UTC is already
// tomorrow.
const today = () => {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
};
// A hidden or missing amount is null and shows as a dash, never as 0.
const money = (amount: unknown, currency: string, locale: string) => {
  if (amount === null || amount === undefined || amount === "" || !Number.isFinite(Number(amount))) return "—";
  return /^[A-Z]{3}$/.test(currency)
    ? new Intl.NumberFormat(locale, { style: "currency", currency, maximumFractionDigits: 4 }).format(Number(amount))
    : `${amount} ${currency}`;
};
const day = (value: string, locale: string) =>
  value ? new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone: "UTC" }).format(new Date(`${value.slice(0, 10)}T00:00:00Z`)) : "—";

function RecordPaymentForm({ kind, obligation, onDone, onClose }: {
  kind: "payable" | "receivable"; obligation: PaymentObligation; onDone: () => void; onClose: () => void;
}) {
  const { t, locale } = useI18n();
  const base = `/api/finance/${kind === "payable" ? "payables" : "receivables"}/${encodeURIComponent(obligation.id)}/payments`;
  const [paymentDate, setPaymentDate] = useState(today);
  const [amount, setAmount] = useState(() => (obligation.outstandingAmount ? String(Number(obligation.outstandingAmount)) : ""));
  const [method, setMethod] = useState<string>(kind === "payable" ? "ach" : "check");
  const [reference, setReference] = useState("");
  const [note, setNote] = useState("");
  const [plan, setPlan] = useState<Plan | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const body = () => ({ expectedVersion: obligation.version, paymentDate, amount, currency: obligation.currency, method, reference, note });
  const edit = <T,>(setter: (value: T) => void) => (value: T) => { setter(value); setPlan(null); };
  const preview = async () => {
    setError("");
    try { setPlan(await apiJson<Plan>(`${base}/preview`, { method: "POST", body: JSON.stringify(body()) })); } catch (reason) { setError(reason instanceof Error ? reason.message : t("finance.loadFailed")); }
  };
  const confirm = async () => {
    setError("");
    setBusy(true);
    try {
      await apiJson(base, { method: "POST", body: JSON.stringify({ ...body(), idempotencyKey: createSecureClientMutationId("payment") }) });
      onDone();
    } catch (reason) {
      setError(reason instanceof ApiError || reason instanceof Error ? reason.message : t("finance.loadFailed"));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-3 rounded-xl border border-slate-200 p-3" data-testid="payment-record-panel">
      <div className="text-sm font-semibold">{t(kind === "payable" ? "finance.action.record_payment" : "finance.action.record_receivable_payment")}</div>
      <div className="grid gap-3 md:grid-cols-3">
        <label className="text-xs">{t("finance.paymentDate")}
          <input type="date" data-testid="payment-date" className={`${field} mt-1 w-full`} value={paymentDate} max={today()} onChange={(event) => edit(setPaymentDate)(event.target.value)} />
        </label>
        <label className="text-xs">{t("finance.amount")} ({obligation.currency})
          <input inputMode="decimal" data-testid="payment-amount" className={`${field} mt-1 w-full`} value={amount} onChange={(event) => edit(setAmount)(event.target.value)} />
        </label>
        <label className="text-xs">{t("finance.paymentMethod")}
          <select data-testid="payment-method" className={`${field} mt-1 w-full`} value={method} onChange={(event) => edit(setMethod)(event.target.value)}>
            {METHODS.map((value) => <option key={value} value={value}>{t(METHOD_KEYS[value])}</option>)}
          </select>
        </label>
        <label className="text-xs">{t("finance.paymentReference")}
          <input data-testid="payment-reference" maxLength={120} className={`${field} mt-1 w-full`} value={reference} placeholder={t("finance.paymentReferenceHint")} onChange={(event) => edit(setReference)(event.target.value)} />
        </label>
        <label className="text-xs md:col-span-2">{t("finance.paymentNote")}
          <input data-testid="payment-note" maxLength={500} className={`${field} mt-1 w-full`} value={note} onChange={(event) => edit(setNote)(event.target.value)} />
        </label>
      </div>
      <div className="flex flex-wrap gap-2">
        <button type="button" data-testid="payment-preview" className={`${button} border border-slate-200`} onClick={() => void preview()}><RefreshCw size={14} />{t("finance.preview")}</button>
        <button type="button" data-testid="payment-confirm" className={`${button} text-white`} style={{ background: A.blue }} disabled={!plan?.allowed || busy} onClick={() => void confirm()}>{t("finance.confirm")}</button>
        <button type="button" className={`${button} text-slate-600`} onClick={onClose}>{t("finance.close")}</button>
      </div>
      {plan && (plan.allowed
        ? (
          <div role="status" data-testid="payment-preview-result" className="flex gap-2 rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900">
            <CheckCircle2 className="mt-0.5 shrink-0" size={16} />
            <span>{t("finance.paymentAfter", { outstanding: money(plan.after?.outstandingAmount, obligation.currency, locale) })} <StatusChip status={plan.after?.status || ""} /></span>
          </div>
        )
        : <div role="alert" className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">{(plan.blockingIssues || []).map((issue) => issue.message).join(" · ")}</div>)}
      {error && <div role="alert" className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">{error}</div>}
    </div>
  );
}

export function PaymentRecords({ kind, obligation, onDone }: {
  kind: "payable" | "receivable"; obligation: PaymentObligation; onDone: () => void;
}) {
  const { t, locale } = useI18n();
  const [open, setOpen] = useState(false);
  const payments = obligation.payments || [];
  const canRecord = (obligation.availableActions || []).includes("record_payment");
  const base = `/api/finance/${kind === "payable" ? "payables" : "receivables"}/${encodeURIComponent(obligation.id)}/payments`;
  return (
    <div className="space-y-3" data-testid="payment-records">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="text-sm font-semibold">{t(kind === "payable" ? "finance.paymentsMade" : "finance.paymentsReceived")}</h4>
        <div className="text-xs text-slate-500" data-testid="payment-totals">
          {t(kind === "payable" ? "finance.paidSoFar" : "finance.receivedSoFar")} {money(obligation.paidAmount, obligation.currency, locale)}
          {" · "}{t("finance.outstanding")} {money(obligation.outstandingAmount, obligation.currency, locale)}
        </div>
      </div>
      <div className="flex gap-2 rounded-xl border border-slate-200 bg-slate-50 p-3 text-xs text-slate-600">
        <Info className="mt-0.5 shrink-0" size={14} />
        <span>{t(kind === "payable" ? "finance.paymentNoMoney" : "finance.receiptNoMoney")}</span>
      </div>
      {payments.length ? (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[560px] text-sm">
            <thead>
              <tr className="border-b text-left text-xs text-slate-500">
                <th className="py-2">{t("finance.paymentDate")}</th>
                <th className="py-2">{t("finance.paymentMethod")}</th>
                <th className="py-2">{t("finance.paymentReference")}</th>
                <th className="py-2">{t("finance.amount")}</th>
                <th className="py-2">{t("finance.status")}</th>
                <th className="py-2" />
              </tr>
            </thead>
            <tbody>
              {payments.map((payment) => (
                <tr key={payment.id} data-testid="payment-row" className={`border-b border-slate-50 align-top ${payment.status === "voided" ? "text-slate-400" : ""}`}>
                  <td className="py-2">{day(payment.paymentDate, locale)}</td>
                  <td className="py-2">{METHOD_KEYS[payment.method] ? t(METHOD_KEYS[payment.method]) : payment.method}</td>
                  <td className="py-2">{payment.reference || "—"}{payment.note && <div className="text-xs text-slate-500">{payment.note}</div>}</td>
                  <td className={`py-2 ${payment.status === "voided" ? "line-through" : "font-medium"}`}>{money(payment.amount, payment.currency, locale)}</td>
                  <td className="py-2">
                    <StatusChip status={payment.status} />
                    {payment.voidReason && <div className="mt-1 text-xs text-slate-500">{payment.voidReason}</div>}
                  </td>
                  <td className="py-2 text-right">
                    {payment.availableActions.includes("void") && (
                      <TwoStepAction
                        label={t("finance.action.void_payment")}
                        testId={`payment-void-${payment.id}`}
                        tone="secondary"
                        previewUrl={`${base}/${encodeURIComponent(payment.id)}/void-preview`}
                        runUrl={`${base}/${encodeURIComponent(payment.id)}/void`}
                        payload={() => ({ expectedVersion: payment.version })}
                        reasonLabel={t("finance.voidReason")}
                        onDone={onDone}
                      />
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="text-xs text-slate-500" data-testid="payment-records-empty">{t(kind === "payable" ? "finance.noPaymentsMade" : "finance.noPaymentsReceived")}</p>
      )}
      {canRecord && !open && (
        <button type="button" data-testid="payment-record" className={`${button} text-white`} style={{ background: A.blue }} onClick={() => setOpen(true)}>
          {t(kind === "payable" ? "finance.action.record_payment" : "finance.action.record_receivable_payment")}
        </button>
      )}
      {canRecord && open && (
        <RecordPaymentForm kind={kind} obligation={obligation} onClose={() => setOpen(false)} onDone={() => { setOpen(false); onDone(); }} />
      )}
    </div>
  );
}
