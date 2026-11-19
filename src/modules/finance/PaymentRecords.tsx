import { useRef, useState } from "react";
import { CheckCircle2, Info } from "lucide-react";
import { toast } from "sonner";
import { A, Field } from "../../components/ui";
import { FormActionBar, focusFirstInvalid } from "../../components/ui/formLayout";
import { listTableCardsRef } from "../../components/ui/workbenchTable";
import { useI18n } from "../../i18n/I18n";
import { ApiError, apiJson } from "../../lib/api-client";
import { apiErrorText } from "../../lib/apiErrorText";
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
type PlanIssue = { code?: string; message?: string; details?: { outstandingAmount?: string } };
type Plan = {
  allowed: boolean;
  blockingIssues?: PlanIssue[];
  after?: { outstandingAmount: string; status: string };
};

// Every method the server records (buildPaymentPlan). The form offers them in
// the order the document's currency makes likely: a bank transfer first
// everywhere; ACH, a US payment network, only for US dollars; a cheque after
// card and cash outside the US.
const METHODS = ["check", "ach", "wire", "card", "cash", "other"] as const;
export const paymentMethodsFor = (currency: string): string[] =>
  currency === "USD" ? ["wire", "ach", "check", "card", "cash", "other"] : ["wire", "card", "cash", "check", "other"];
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

// The payment form follows the form standard (components/ui/formLayout.tsx):
// labelled fields, "*" on the required ones, and each message under its
// field. The rules are the server's (buildPaymentPlan), said before asking it.
const PAYMENT_COPY = {
  dateRequired: ["Enter the payment date.", "请输入付款日期。"],
  dateFuture: ["The payment date cannot be in the future.", "付款日期不能晚于今天。"],
  amountRequired: ["Enter the amount.", "请输入金额。"],
  amountInvalid: ["Enter a number with at most 4 decimals.", "请输入最多 4 位小数的数字。"],
  amountZero: ["The amount must be more than zero.", "金额必须大于 0。"],
  amountTooHigh: ["More than the {amount} still outstanding.", "超过未结金额 {amount}。"],
  methodRequired: ["Choose how it was paid.", "请选择付款方式。"],
  referenceTooLong: ["Use at most 120 characters.", "最多 120 个字符。"],
  noteTooLong: ["Use at most 500 characters.", "最多 500 个字符。"],
  held: ["This supplier invoice is on hold. Release it before recording a payment.", "这笔应付款已暂停，请先解除暂停再登记付款。"],
  disputed: ["This receivable is disputed. Resolve the dispute before recording a payment.", "这笔应收款有争议，请先解决争议再登记收款。"],
  settled: ["This is already paid in full.", "已全额结清。"],
  statusInvalid: ["A payment cannot be recorded in this status.", "当前状态下不能登记付款。"],
  changed: ["This record changed after the page opened. Close the form, reload the page and try again.", "页面打开后记录已有变化，请关闭表单、刷新页面后重试。"],
  currency: ["Payments on this document are in {currency}; no currency is converted.", "该单据按 {currency} 付款，不做币种换算。"],
  checkFields: ["Check the highlighted fields.", "请检查标出的字段。"],
  recordedPaid: ["Payment of {amount} recorded", "已登记付款 {amount}"],
  recordedReceived: ["Customer payment of {amount} recorded", "已登记收款 {amount}"],
  // British spelling outside US dollars; the stored method is "check" either way.
  cheque: ["Cheque", "支票"],
} as const;
// A typed amount in 1/10000 units, as the server reads it; null when it is
// not a number with at most 4 decimals.
const amountUnits = (value: string | null | undefined): bigint | null => {
  const raw = String(value ?? "").trim();
  if (!/^\d+(\.\d+)?$/.test(raw)) return null;
  const [whole, fraction = ""] = raw.split(".");
  if (/[1-9]/.test(fraction.slice(4))) return null;
  return BigInt(whole) * 10000n + BigInt((fraction.slice(0, 4) + "0000").slice(0, 4));
};
const unitsText = (value: bigint) => `${value / 10000n}.${String(value % 10000n).padStart(4, "0")}`;
// What would be outstanding after this payment, and the status that leaves,
// while the amount typed is one the server could accept; null otherwise. The
// server works it out again when the payment is recorded.
export function paymentAfter(outstanding: string | null | undefined, typed: string): { outstandingAmount: string; status: "settled" | "partially_settled" } | null {
  const owed = amountUnits(outstanding);
  const paid = amountUnits(typed);
  if (owed === null || paid === null || paid <= 0n || paid > owed) return null;
  const left = owed - paid;
  return { outstandingAmount: unitsText(left), status: left === 0n ? "settled" : "partially_settled" };
}
type PaymentField = "date" | "amount" | "method" | "reference" | "note";
type PaymentProblems = { fields: Partial<Record<PaymentField, string>>; form: string[] };
const DECIMAL = /^\d+(\.\d{1,4})?$/;
// The amount as the currency writes it: 19.60, not 19.6. A stored amount
// with more decimals than the currency uses is kept whole, never rounded up
// past what is outstanding.
export const paymentAmountText = (amount: string | null | undefined, currency: string) => {
  if (amount === null || amount === undefined || amount === "" || !Number.isFinite(Number(amount))) return "";
  const value = Number(amount);
  let digits = 2;
  try { digits = new Intl.NumberFormat("en-US", { style: "currency", currency }).resolvedOptions().maximumFractionDigits ?? 2; } catch { digits = 2; }
  const fixed = value.toFixed(digits);
  return Number(fixed) === value ? fixed : String(value);
};

function RecordPaymentForm({ kind, obligation, onDone, onClose }: {
  kind: "payable" | "receivable"; obligation: PaymentObligation; onDone: () => void; onClose: () => void;
}) {
  const { t, locale, language } = useI18n();
  const say = (key: keyof typeof PAYMENT_COPY, variables: Record<string, string> = {}) =>
    Object.entries(variables).reduce((text, [name, value]) => text.split(`{${name}}`).join(value), PAYMENT_COPY[key][language === "en-US" ? 0 : 1] as string);
  const formRef = useRef<HTMLDivElement>(null);
  const base = `/api/finance/${kind === "payable" ? "payables" : "receivables"}/${encodeURIComponent(obligation.id)}/payments`;
  const [paymentDate, setPaymentDate] = useState(today);
  const [amount, setAmount] = useState(() => paymentAmountText(obligation.outstandingAmount, obligation.currency));
  // A bank transfer is the usual way, in any currency.
  const [method, setMethod] = useState<string>("wire");
  const [reference, setReference] = useState("");
  const [note, setNote] = useState("");
  const [plan, setPlan] = useState<Plan | null>(null);
  const [problems, setProblems] = useState<PaymentProblems>({ fields: {}, form: [] });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const body = () => ({ expectedVersion: obligation.version, paymentDate, amount: amount.trim(), currency: obligation.currency, method, reference, note });
  const edit = <T,>(setter: (value: T) => void) => (value: T) => { setter(value); setPlan(null); setProblems({ fields: {}, form: [] }); setError(""); };
  const outstandingText = money(obligation.outstandingAmount, obligation.currency, locale);
  // The server's rules for a payment, checked before it is asked.
  const check = (): PaymentProblems => {
    const fields: PaymentProblems["fields"] = {};
    if (!/^\d{4}-\d{2}-\d{2}$/.test(paymentDate)) fields.date = say("dateRequired");
    else if (paymentDate > today()) fields.date = say("dateFuture");
    const typed = amount.trim();
    if (!typed) fields.amount = say("amountRequired");
    else if (!DECIMAL.test(typed)) fields.amount = say("amountInvalid");
    else if (Number(typed) <= 0) fields.amount = say("amountZero");
    else if (obligation.outstandingAmount !== null && Number(typed) > Number(obligation.outstandingAmount)) fields.amount = say("amountTooHigh", { amount: outstandingText });
    if (!METHODS.includes(method as (typeof METHODS)[number])) fields.method = say("methodRequired");
    if (reference.length > 120) fields.reference = say("referenceTooLong");
    if (note.length > 500) fields.note = say("noteTooLong");
    return { fields, form: [] };
  };
  // The plan's refusal, under the field it names where it names one.
  const fromPlan = (issues: PlanIssue[]): PaymentProblems => {
    const found: PaymentProblems = { fields: {}, form: [] };
    const form = (text: string) => { if (!found.form.includes(text)) found.form.push(text); };
    for (const issue of issues) {
      const code = issue.code || "";
      if (code === "PAYMENT_AMOUNT_EXCEEDS_OUTSTANDING") found.fields.amount = say("amountTooHigh", { amount: money(issue.details?.outstandingAmount ?? obligation.outstandingAmount, obligation.currency, locale) });
      else if (code === "PAYMENT_AMOUNT_INVALID") found.fields.amount = Number(amount) <= 0 && DECIMAL.test(amount.trim()) ? say("amountZero") : say("amountInvalid");
      else if (code === "PAYMENT_DATE_INVALID") found.fields.date = say("dateRequired");
      else if (code === "PAYMENT_DATE_IN_FUTURE") found.fields.date = say("dateFuture");
      else if (code === "PAYMENT_METHOD_INVALID") found.fields.method = say("methodRequired");
      else if (code === "PAYMENT_REFERENCE_TOO_LONG") found.fields.reference = say("referenceTooLong");
      else if (code === "PAYMENT_NOTE_TOO_LONG") found.fields.note = say("noteTooLong");
      else if (code === "PAYMENT_OBLIGATION_HELD") form(say("held"));
      else if (code === "PAYMENT_OBLIGATION_DISPUTED") form(say("disputed"));
      else if (code === "PAYMENT_OBLIGATION_SETTLED") form(say("settled"));
      else if (code === "PAYMENT_OBLIGATION_STATUS_INVALID") form(say("statusInvalid"));
      else if (code === "FINANCE_CURRENCY_MISMATCH") form(say("currency", { currency: obligation.currency }));
      else if (code === "FINANCE_VERSION_CONFLICT") form(say("changed"));
      else form(issue.message || say("changed"));
    }
    return found;
  };
  const hasProblems = (found: PaymentProblems) => found.form.length + Object.keys(found.fields).length > 0;
  const focusFirst = () => focusFirstInvalid(formRef.current);
  // The server's preview, asked inside Record payment: the form is checked
  // first, and a refusal goes under the field it names.
  const preview = async () => {
    setError("");
    const found = check();
    setProblems(found);
    if (hasProblems(found)) { setPlan(null); focusFirst(); return null; }
    try {
      const next = await apiJson<Plan>(`${base}/preview`, { method: "POST", body: JSON.stringify(body()) });
      setPlan(next);
      if (!next.allowed) { setProblems(fromPlan(next.blockingIssues || [])); focusFirst(); }
      return next;
    } catch (reason) {
      setError(apiErrorText(reason, language, PAYMENT_FAILED));
      return null;
    }
  };
  // One step (the form standard): Record payment checks the form, asks the
  // server's preview, and records the payment only when the server allows it.
  const confirm = async () => {
    setError("");
    setBusy(true);
    try {
      const current = plan?.allowed ? plan : await preview();
      if (!current?.allowed) return;
      await apiJson(base, { method: "POST", body: JSON.stringify({ ...body(), idempotencyKey: createSecureClientMutationId("payment") }) });
      // The form closes and the page reloads: the toast says what was recorded.
      const recorded = money(amount.trim(), obligation.currency, locale);
      toast.success(kind === "payable" ? say("recordedPaid", { amount: recorded }) : say("recordedReceived", { amount: recorded }));
      onDone();
    } catch (reason) {
      setPlan(null);
      setError(apiErrorText(reason, language, PAYMENT_FAILED));
    } finally {
      setBusy(false);
    }
  };
  const fieldIssues = Object.keys(problems.fields).length > 0;
  // What the payment leaves outstanding, said while typing; the server works
  // it out again when the payment is recorded.
  const after = paymentAfter(obligation.outstandingAmount, amount);
  const methods = paymentMethodsFor(obligation.currency);
  const methodLabel = (value: string) => (value === "check" && obligation.currency !== "USD" ? say("cheque") : t(METHOD_KEYS[value]));
  // A message about the whole payment goes in the action bar, beside the
  // buttons (the form standard).
  const message = problems.form.length > 0 || fieldIssues || error ? (
    <>
      {problems.form.map((text) => <div key={text}>{text}</div>)}
      {fieldIssues && <div>{say("checkFields")}</div>}
      {error && <div>{error}</div>}
    </>
  ) : null;
  return (
    <div ref={formRef} className="space-y-3 rounded-xl border border-slate-200 p-3" data-testid="payment-record-panel">
      <div className="text-sm font-semibold">{t(kind === "payable" ? "finance.action.record_payment" : "finance.action.record_receivable_payment")}</div>
      <div className="grid gap-3 md:grid-cols-3">
        <Field label={t("finance.paymentDate")} required error={problems.fields.date}>
          <input type="date" data-testid="payment-date" className={`${field} w-full`} value={paymentDate} max={today()} onChange={(event) => edit(setPaymentDate)(event.target.value)} />
        </Field>
        <Field label={`${t("finance.amount")} (${obligation.currency})`} required error={problems.fields.amount}>
          <input inputMode="decimal" data-testid="payment-amount" className={`${field} w-full tabular-nums`} value={amount} onChange={(event) => edit(setAmount)(event.target.value)} />
        </Field>
        <Field label={t("finance.paymentMethod")} required error={problems.fields.method}>
          <select data-testid="payment-method" className={`${field} w-full`} value={method} onChange={(event) => edit(setMethod)(event.target.value)}>
            {methods.map((value) => <option key={value} value={value}>{methodLabel(value)}</option>)}
          </select>
        </Field>
        <Field label={t("finance.paymentReference")} error={problems.fields.reference}>
          <input data-testid="payment-reference" maxLength={120} className={`${field} w-full`} value={reference} placeholder={t("finance.paymentReferenceHint")} onChange={(event) => edit(setReference)(event.target.value)} />
        </Field>
        <div className="md:col-span-2">
          <Field label={t("finance.paymentNote")} error={problems.fields.note}>
            <input data-testid="payment-note" maxLength={500} className={`${field} w-full`} value={note} onChange={(event) => edit(setNote)(event.target.value)} />
          </Field>
        </div>
      </div>
      {after && (
        <div role="status" data-testid="payment-preview-result" className="flex gap-2 text-sm" style={{ color: A.sub }}>
          <CheckCircle2 className="mt-0.5 shrink-0 text-emerald-600" size={16} />
          {/* "Status: Paid"; in Chinese "状态：" takes no space before the chip. */}
          <span>{t("finance.paymentAfter", { outstanding: money(after.outstandingAmount, obligation.currency, locale) })}{language === "en-US" ? " " : ""}<StatusChip status={after.status} /></span>
        </div>
      )}
      {/* Cancel · Record payment, on the right; Record payment checks the form and asks the server first. */}
      <FormActionBar
        onCancel={onClose}
        submit={{ label: t(kind === "payable" ? "finance.action.record_payment" : "finance.action.record_receivable_payment"), onClick: () => void confirm(), busy, testId: "payment-confirm" }}
        message={message}
        messageTestId="payment-errors"
      />
    </div>
  );
}

// A failed payment request in the reader's language, never the server's own words.
const PAYMENT_FAILED = ["Could not record the payment. Check the amount and date, then try again.", "付款记录失败，请检查金额和日期后重试。"] as const;

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
        // Phones show each payment as a card (listTableCardsRef): the date first.
        <div className="overflow-x-auto" ref={listTableCardsRef}>
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
                <tr key={payment.id} data-testid="payment-row" className={`border-b border-slate-50 align-top ${payment.status === "voided" ? "text-slate-500" : ""}`}>
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
