import { useCallback, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { AlertTriangle, CheckCircle2, FilePlus2, RefreshCw } from "lucide-react";
import { A, Card, Chip } from "../../components/ui";
import { BusinessEntityLink } from "../../components/business/BusinessEntityLink";
import { useI18n } from "../../i18n/I18n";
import { ApiError, apiJson } from "../../lib/api-client";
import { createSecureClientMutationId } from "../../lib/client-id";

// The supplier invoice screens of the trial's procure-to-pay chain: enter an
// invoice against a posted receipt, then submit, match, review exceptions,
// approve or cancel it, and hold or release its payable. Every step previews
// the server's plan first and confirms exactly that operation; the server
// checks permissions, versions and the three-way rules.

type TranslationKey = Parameters<ReturnType<typeof useI18n>["t"]>[0];
type Issue = { code?: string; message?: string };
type Plan = { allowed: boolean; blockingIssues?: Issue[]; invoice?: { totalAmount?: string; currency?: string }; nextStatus?: string };
type EntryData = {
  suppliers: Array<{ id: string; code?: string | null; name: string }>;
  purchaseOrders: Array<{ id: string; supplierId: string; currency: string; lines: Array<{ id: string; sku: string; itemName: string; unitPrice: string | null; unit: string | null }> }>;
  receivingDocuments: Array<{ id: string; documentNumber: string | null; poId: string | null; supplierId: string; supplierName: string | null; currency: string | null; lines: Array<{ id: string; purchaseOrderLineId: string | null; sku: string; itemName: string; acceptedQuantity: string; unit: string | null }> }>;
  capabilities: Record<string, { enabled?: boolean }>;
};

const field = "rounded-lg border border-slate-200 px-3 py-2 text-sm";
const button = "inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium disabled:opacity-50";
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
};

const money = (amount: unknown, currency: unknown, locale: string) => {
  if (amount === null || amount === undefined || amount === "") return "—";
  const code = String(currency || "");
  const numeric = Number(amount);
  if (!Number.isFinite(numeric)) return "—";
  return /^[A-Z]{3}$/.test(code)
    ? new Intl.NumberFormat(locale, { style: "currency", currency: code, maximumFractionDigits: 4 }).format(numeric)
    : `${amount} ${code}`.trim();
};
const fixed = (value: number) => (Number.isFinite(value) ? value.toFixed(4) : "0.0000");
const message = (reason: unknown, fallback: string) => (reason instanceof Error ? reason.message : fallback);

function Notice({ children, tone = "warning" }: { children: ReactNode; tone?: "warning" | "success" }) {
  const colors = tone === "success" ? "border-emerald-200 bg-emerald-50 text-emerald-900" : "border-amber-200 bg-amber-50 text-amber-900";
  return (
    <div role={tone === "warning" ? "alert" : "status"} className={`flex gap-2 rounded-xl border p-3 text-sm ${colors}`}>
      {tone === "success" ? <CheckCircle2 className="mt-0.5 shrink-0" size={16} /> : <AlertTriangle className="mt-0.5 shrink-0" size={16} />}
      <span>{children}</span>
    </div>
  );
}

function StatusChip({ status }: { status: string }) {
  const { t } = useI18n();
  return <Chip label={STATUS_KEYS[status] ? t(STATUS_KEYS[status]) : status || "—"} color={A.blue} bg="#eff6ff" />;
}

// -------------------------------------------------------------- new invoice

export function NewSupplierInvoice() {
  const { t, locale } = useI18n();
  const [entry, setEntry] = useState<EntryData | null>(null);
  const [supplierId, setSupplierId] = useState("");
  const [receiptId, setReceiptId] = useState("");
  const [invoiceNumber, setInvoiceNumber] = useState("");
  const [invoiceDate, setInvoiceDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [dueDate, setDueDate] = useState("");
  const [lines, setLines] = useState<Record<string, { quantity?: string; unitPrice?: string; tax?: string }>>({});
  const [plan, setPlan] = useState<Plan | null>(null);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void apiJson<EntryData>("/api/finance/entry-data")
      .then(setEntry)
      .catch((reason) => setNotice(message(reason, t("finance.loadFailed"))));
  }, []);
  const receipts = useMemo(() => (entry?.receivingDocuments || []).filter((row) => !supplierId || row.supplierId === supplierId), [entry, supplierId]);
  const receipt = receipts.find((row) => row.id === receiptId) || null;
  const order = entry?.purchaseOrders.find((row) => row.id === receipt?.poId) || null;
  const poLine = (id: string | null) => order?.lines.find((line) => line.id === id) || null;
  const currency = receipt?.currency || order?.currency || "";
  const linePrice = (lineId: string, purchaseOrderLineId: string | null) => lines[lineId]?.unitPrice ?? poLine(purchaseOrderLineId)?.unitPrice ?? "";
  const body = () => {
    const chosen = (receipt?.lines || [])
      .filter((line) => Number(lines[line.id]?.quantity || 0) > 0)
      .map((line) => {
        const quantity = lines[line.id]?.quantity || "0";
        const unitPrice = linePrice(line.id, line.purchaseOrderLineId) || "0";
        const tax = lines[line.id]?.tax || "0";
        return { purchaseOrderLineId: line.purchaseOrderLineId, receivingLineId: line.id, quantity, unitPrice, lineAmount: fixed(Number(quantity) * Number(unitPrice)), enteredTaxAmount: tax };
      });
    const total = chosen.reduce((sum, line) => sum + Number(line.lineAmount) + Number(line.enteredTaxAmount || 0), 0);
    return {
      invoiceNumber,
      supplierId,
      currency,
      invoiceDate: invoiceDate ? new Date(`${invoiceDate}T00:00:00.000Z`).toISOString() : "",
      dueDate: dueDate ? new Date(`${dueDate}T00:00:00.000Z`).toISOString() : "",
      totalAmount: fixed(total),
      lines: chosen,
    };
  };
  const reset = () => setPlan(null);
  const preview = async () => {
    setNotice("");
    try {
      setPlan(await apiJson<Plan>("/api/finance/supplier-invoices/preview", { method: "POST", body: JSON.stringify(body()) }));
    } catch (reason) {
      setNotice(message(reason, t("finance.loadFailed")));
    }
  };
  const create = async () => {
    setNotice("");
    setBusy(true);
    try {
      const result = await apiJson<{ entityId: string }>("/api/finance/supplier-invoices", {
        method: "POST",
        body: JSON.stringify({ ...body(), idempotencyKey: createSecureClientMutationId("p2p") }),
      });
      window.location.assign(`/app/procurement/bills/${encodeURIComponent(result.entityId)}`);
    } catch (reason) {
      setNotice(message(reason, t("finance.loadFailed")));
    } finally {
      setBusy(false);
    }
  };
  if (!entry) return notice ? <Notice>{notice}</Notice> : <Card className="p-6">{t("common.loading")}</Card>;
  const enabled = Boolean(entry.capabilities?.["supplier-invoice"]?.enabled);
  return (
    <div className="space-y-4" data-testid="new-supplier-invoice">
      {!enabled && <Notice>{t("finance.capabilityDisabled")}</Notice>}
      {notice && <Notice>{notice}</Notice>}
      <Card className="space-y-4 p-5">
        <div className="grid gap-3 md:grid-cols-3">
          <label className="text-xs">{t("finance.supplier")}
            <select data-testid="supplier-invoice-supplier" className={`${field} mt-1 w-full`} value={supplierId} onChange={(event) => { setSupplierId(event.target.value); setReceiptId(""); setLines({}); reset(); }}>
              <option value="">—</option>
              {entry.suppliers.map((row) => <option key={row.id} value={row.id}>{row.name}{row.code ? ` · ${row.code}` : ""}</option>)}
            </select>
          </label>
          <label className="text-xs">{t("finance.postedReceipt")}
            <select data-testid="supplier-invoice-receipt" className={`${field} mt-1 w-full`} value={receiptId} onChange={(event) => { setReceiptId(event.target.value); setLines({}); reset(); }}>
              <option value="">—</option>
              {receipts.map((row) => <option key={row.id} value={row.id}>{row.documentNumber || row.id} · {row.poId || "—"}{row.supplierName ? ` · ${row.supplierName}` : ""}</option>)}
            </select>
          </label>
          <label className="text-xs">{t("finance.invoiceNumber")}
            <input data-testid="supplier-invoice-number" className={`${field} mt-1 w-full`} value={invoiceNumber} onChange={(event) => { setInvoiceNumber(event.target.value); reset(); }} />
          </label>
          <label className="text-xs">{t("finance.invoiceDate")}
            <input type="date" className={`${field} mt-1 w-full`} value={invoiceDate} onChange={(event) => { setInvoiceDate(event.target.value); reset(); }} />
          </label>
          <label className="text-xs">{t("finance.dueDate")}
            <input type="date" data-testid="supplier-invoice-due" className={`${field} mt-1 w-full`} value={dueDate} onChange={(event) => { setDueDate(event.target.value); reset(); }} />
          </label>
          <div className="text-xs">{t("finance.currency")}<div className="mt-1 rounded-lg bg-slate-50 px-3 py-2 text-sm">{currency || "—"}</div></div>
        </div>
        {receipt && !receipt.lines.length && <Notice>{t("finance.noReceiptLines")}</Notice>}
        {receipt?.lines.map((line) => {
          const po = poLine(line.purchaseOrderLineId);
          return (
            <div key={line.id} data-testid="supplier-invoice-line" className="grid items-end gap-3 rounded-xl bg-slate-50 p-3 md:grid-cols-5">
              <div className="md:col-span-2">
                <div className="font-medium">{line.sku} · {line.itemName}</div>
                <div className="text-xs text-slate-500">{t("finance.received")} {line.acceptedQuantity} {line.unit || ""} · {t("finance.poPrice")} {po?.unitPrice === null || po?.unitPrice === undefined ? "—" : money(po.unitPrice, currency, locale)}</div>
              </div>
              <label className="text-xs">{t("finance.quantity")}
                <input inputMode="decimal" aria-label={`${t("finance.quantity")} ${line.sku}`} className={`${field} mt-1 w-full`} value={lines[line.id]?.quantity || ""} onChange={(event) => { setLines({ ...lines, [line.id]: { ...lines[line.id], quantity: event.target.value } }); reset(); }} />
              </label>
              <label className="text-xs">{t("finance.unitPrice")}
                <input inputMode="decimal" aria-label={`${t("finance.unitPrice")} ${line.sku}`} className={`${field} mt-1 w-full`} value={linePrice(line.id, line.purchaseOrderLineId) || ""} onChange={(event) => { setLines({ ...lines, [line.id]: { ...lines[line.id], unitPrice: event.target.value } }); reset(); }} />
              </label>
              <label className="text-xs">{t("finance.tax")}
                <input inputMode="decimal" aria-label={`${t("finance.tax")} ${line.sku}`} className={`${field} mt-1 w-full`} value={lines[line.id]?.tax || ""} onChange={(event) => { setLines({ ...lines, [line.id]: { ...lines[line.id], tax: event.target.value } }); reset(); }} />
              </label>
            </div>
          );
        })}
        <div className="flex flex-wrap gap-2">
          <button type="button" data-testid="supplier-invoice-preview" className={`${button} border border-slate-200`} disabled={!enabled || !receipt} onClick={() => void preview()}><RefreshCw size={14} />{t("finance.preview")}</button>
          <button type="button" data-testid="supplier-invoice-create" className={`${button} text-white`} style={{ background: A.blue }} disabled={!enabled || !plan?.allowed || busy} onClick={() => void create()}><FilePlus2 size={14} />{t("finance.createDraft")}</button>
        </div>
        {plan && (
          plan.allowed
            ? <Notice tone="success">{t("finance.previewAllowed")} · {money(plan.invoice?.totalAmount, plan.invoice?.currency || currency, locale)}</Notice>
            : <Notice>{(plan.blockingIssues || []).map((issue) => issue.message).join(" · ")}</Notice>
        )}
      </Card>
    </div>
  );
}

// -------------------------------------------------------------- actions

// One operation: an optional reason, a preview of the server's plan, then a
// confirm that runs exactly the previewed operation.
function TwoStepAction({ label, testId, previewUrl, runUrl, payload, reasonLabel, onDone, tone = "primary" }: {
  label: string; testId: string; previewUrl: string; runUrl: string; payload: () => Record<string, unknown>;
  reasonLabel?: string; onDone: () => void; tone?: "primary" | "secondary";
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [plan, setPlan] = useState<Plan | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const body = () => ({ ...payload(), ...(reasonLabel ? { reason, resolution: reason } : {}) });
  const preview = async () => {
    setError("");
    try { setPlan(await apiJson<Plan>(previewUrl, { method: "POST", body: JSON.stringify(body()) })); } catch (reason) { setError(message(reason, t("finance.loadFailed"))); }
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
      setError(cause instanceof ApiError || cause instanceof Error ? cause.message : t("finance.loadFailed"));
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
          <input data-testid={`${testId}-reason`} className={`${field} mt-1 w-full`} value={reason} onChange={(event) => { setReason(event.target.value); setPlan(null); }} />
        </label>
      )}
      <div className="flex flex-wrap gap-2">
        <button type="button" data-testid={`${testId}-preview`} className={`${button} border border-slate-200`} onClick={() => void preview()}><RefreshCw size={14} />{t("finance.preview")}</button>
        <button type="button" data-testid={`${testId}-confirm`} className={`${button} text-white`} style={{ background: A.blue }} disabled={!plan?.allowed || busy} onClick={() => void confirm()}>{t("finance.confirm")}</button>
        <button type="button" className={`${button} text-slate-600`} onClick={() => { setOpen(false); setPlan(null); setError(""); }}>{t("finance.close")}</button>
      </div>
      {plan && (plan.allowed ? <Notice tone="success">{t("finance.previewAllowed")}</Notice> : <Notice>{(plan.blockingIssues || []).map((issue) => issue.message).join(" · ")}</Notice>)}
      {error && <Notice>{error}</Notice>}
    </div>
  );
}

// -------------------------------------------------------------- detail

type BillReadFailure = "notFound" | "unauthenticated" | "forbidden" | "error";

function billReadFailure(reason: unknown): BillReadFailure {
  if (!(reason instanceof ApiError)) return "error";
  if (reason.status === 404) return "notFound";
  if (reason.status === 401) return "unauthenticated";
  if (reason.status === 403) return "forbidden";
  return "error";
}

export function SupplierInvoiceDetail() {
  const { t, locale } = useI18n();
  const id = decodeURIComponent(window.location.pathname.split("/").filter(Boolean).at(-1) || "");
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState("");
  // Why the first read failed; a failed reload after an action keeps the bill
  // on screen and shows the error above it instead.
  const [failure, setFailure] = useState<BillReadFailure | null>(null);
  const load = useCallback(() => {
    setFailure(null);
    void apiJson(`/api/finance/supplier-invoices/${encodeURIComponent(id)}`)
      .then((next) => { setData(next); setError(""); })
      .catch((reason) => {
        setError(message(reason, t("finance.loadFailed")));
        setFailure(billReadFailure(reason));
      });
  }, [id]);
  useEffect(() => { load(); }, [load]);
  if (failure && !data) {
    const testId = { notFound: "supplier-invoice-not-found", unauthenticated: "supplier-invoice-unauthenticated", forbidden: "supplier-invoice-forbidden", error: "supplier-invoice-read-error" }[failure];
    const text = { notFound: t("finance.billNotFound"), unauthenticated: t("finance.billSignedOut"), forbidden: t("finance.billForbidden"), error: t("finance.billReadError") }[failure];
    return (
      <Card className="py-16 text-center" data-testid={testId}>
        <div className="text-sm font-semibold">{text}</div>
        <div className="mt-2 text-xs text-slate-500">{id}</div>
        {failure === "error" && <button type="button" onClick={load} className="mt-3 text-sm font-semibold text-blue-600">{t("finance.retry")}</button>}
      </Card>
    );
  }
  if (!data) return <Card className="p-6">{t("common.loading")}</Card>;
  const base = `/api/finance/supplier-invoices/${encodeURIComponent(data.id)}`;
  const actions: string[] = Array.isArray(data.availableActions) ? data.availableActions : [];
  const version = { expectedVersion: data.version };
  const exceptions: any[] = data.match?.exceptions || [];
  const payable = data.payable;
  const payableActions: string[] = Array.isArray(payable?.availableActions) ? payable.availableActions : [];
  return (
    <div className="space-y-4" data-testid="supplier-invoice-detail">
      {error && <Notice>{error}</Notice>}
      <Card className="p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="font-semibold">{data.invoiceNumber}</h2>
            <p className="mt-1 text-sm text-slate-500" data-testid="supplier-invoice-sources">
              {data.supplierName || "—"}
              {" · "}{t("finance.purchaseOrder")} {data.relatedPoId ? <BusinessEntityLink entityType="purchase_order" entityId={data.relatedPoId} /> : "—"}
              {" · "}{t("finance.receipt")} {data.relatedGrnId ? <BusinessEntityLink entityType="receiving_doc" entityId={data.relatedGrnId} /> : "—"}
              {data.relatedPoId && <>{" · "}<BusinessEntityLink entityType="three_way_match" entityId={`MATCH-${data.id}`}>{t("finance.threeWayMatch")}</BusinessEntityLink></>}
            </p>
          </div>
          <div className="text-right">
            <strong>{money(data.totalAmount, data.currency, locale)}</strong>
            <div className="mt-1"><StatusChip status={data.status} /></div>
          </div>
        </div>
        <div className="mt-4 flex flex-wrap gap-2" data-testid="supplier-invoice-actions">
          {actions.includes("submit") && <TwoStepAction label={t("finance.action.submit")} testId="invoice-submit" previewUrl={`${base}/submit-preview`} runUrl={`${base}/submit`} payload={() => version} onDone={load} />}
          {actions.includes("match") && <TwoStepAction label={t("finance.action.match")} testId="invoice-match" previewUrl={`${base}/match-preview`} runUrl={`${base}/match`} payload={() => version} onDone={load} />}
          {actions.includes("approve") && <TwoStepAction label={t("finance.action.approve")} testId="invoice-approve" previewUrl={`${base}/approve-preview`} runUrl={`${base}/approve`} payload={() => version} onDone={load} />}
          {actions.includes("cancel") && <TwoStepAction label={t("finance.action.cancel")} testId="invoice-cancel" tone="secondary" previewUrl={`${base}/cancel-preview`} runUrl={`${base}/cancel`} payload={() => version} reasonLabel={t("finance.cancelReason")} onDone={load} />}
          {!actions.length && <span className="text-xs text-slate-500">{t("finance.noActions")}</span>}
        </div>
      </Card>

      <Card className="overflow-x-auto p-5">
        <h3 className="mb-3 font-semibold">{t("finance.lines")}</h3>
        <table className="w-full min-w-[640px] text-sm">
          <thead><tr className="border-b text-left text-xs text-slate-500"><th className="py-2">SKU</th><th className="py-2">{t("finance.quantity")}</th><th className="py-2">{t("finance.unitPrice")}</th><th className="py-2">{t("finance.tax")}</th><th className="py-2">{t("finance.amount")}</th></tr></thead>
          <tbody>
            {(data.lines || []).map((line: any) => (
              <tr key={line.id} className="border-b border-slate-50"><td className="py-2">{line.sku} · {line.itemName}</td><td className="py-2">{line.quantity} {line.unit || ""}</td><td className="py-2">{money(line.unitPrice, data.currency, locale)}</td><td className="py-2">{money(line.enteredTaxAmount, data.currency, locale)}</td><td className="py-2">{money(line.totalAmount, data.currency, locale)}</td></tr>
            ))}
          </tbody>
        </table>
      </Card>

      {data.match && (
        <Card className="space-y-3 p-5" data-testid="supplier-invoice-match">
          <div className="flex items-center justify-between"><h3 className="font-semibold">{t("finance.threeWayMatch")}</h3><StatusChip status={data.match.status} /></div>
          {data.match.blockingReason && <p className="text-sm text-slate-600">{data.match.blockingReason}</p>}
          {exceptions.map((entry) => (
            <div key={entry.id} className="space-y-2 rounded-xl bg-slate-50 p-3 text-sm" data-testid="match-exception">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div><span className="font-medium">{entry.exceptionType}</span> · {t("finance.expected")} {entry.expectedValue ?? "—"} · {t("finance.actual")} {entry.actualValue ?? "—"}</div>
                <StatusChip status={entry.status} />
              </div>
              {entry.resolution && <div className="text-xs text-slate-500">{entry.resolution}</div>}
              {entry.status === "open" && (
                <div className="flex flex-wrap gap-2">
                  <TwoStepAction label={t("finance.approveException")} testId={`exception-approve-${entry.id}`} previewUrl={`/api/finance/match-exceptions/${encodeURIComponent(entry.id)}/review-preview`} runUrl={`/api/finance/match-exceptions/${encodeURIComponent(entry.id)}/review`} payload={() => ({ expectedVersion: entry.version, decision: "approved" })} reasonLabel={t("finance.resolution")} onDone={load} />
                  <TwoStepAction label={t("finance.rejectException")} testId={`exception-reject-${entry.id}`} tone="secondary" previewUrl={`/api/finance/match-exceptions/${encodeURIComponent(entry.id)}/review-preview`} runUrl={`/api/finance/match-exceptions/${encodeURIComponent(entry.id)}/review`} payload={() => ({ expectedVersion: entry.version, decision: "rejected" })} reasonLabel={t("finance.resolution")} onDone={load} />
                </div>
              )}
            </div>
          ))}
        </Card>
      )}

      {payable && (
        <Card className="space-y-3 p-5" data-testid="supplier-invoice-payable">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="font-semibold">{t("finance.payables")} · {payable.obligationNumber || payable.id}</h3>
            <div className="flex items-center gap-2"><strong>{money(payable.outstandingAmount, payable.currency, locale)}</strong><StatusChip status={payable.status} /></div>
          </div>
          <Notice>{t("finance.notPaid")}</Notice>
          <div className="flex flex-wrap gap-2">
            {payableActions.map((action) => (
              <TwoStepAction
                key={action}
                label={t(action === "hold" ? "finance.action.hold" : action === "release" ? "finance.action.release" : "finance.action.mark_export_ready")}
                testId={`payable-${action}`}
                tone={action === "hold" ? "secondary" : "primary"}
                previewUrl={`/api/finance/payables/${encodeURIComponent(payable.id)}/${action === "mark_export_ready" ? "mark-export-ready" : action}-preview`}
                runUrl={`/api/finance/payables/${encodeURIComponent(payable.id)}/${action === "mark_export_ready" ? "mark-export-ready" : action}`}
                payload={() => ({ expectedVersion: payable.version })}
                reasonLabel={action === "mark_export_ready" ? undefined : t("finance.reason")}
                onDone={load}
              />
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}
