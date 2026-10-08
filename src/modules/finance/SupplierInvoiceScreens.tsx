import { useCallback, useEffect, useMemo, useState } from "react";
import { FilePlus2, RefreshCw } from "lucide-react";
import { A, Card } from "../../components/ui";
import { BusinessEntityLink } from "../../components/business/BusinessEntityLink";
import { useI18n } from "../../i18n/I18n";
import { ApiError, apiJson } from "../../lib/api-client";
import { createSecureClientMutationId } from "../../lib/client-id";
import { Notice, StatusChip, TwoStepAction, button, field, message } from "./FinanceControls";
import { PaymentRecords } from "./PaymentRecords";
import { addCalendarDays } from "../../lib/prefill";

// The supplier invoice screens of the trial's procure-to-pay chain: enter an
// invoice against a posted receipt, then submit, match, review exceptions,
// approve or cancel it, and hold or release its payable. Every step previews
// the server's plan first and confirms exactly that operation; the server
// checks permissions, versions and the three-way rules.

type Issue = { code?: string; message?: string };
type Plan = { allowed: boolean; blockingIssues?: Issue[]; invoice?: { totalAmount?: string; currency?: string }; nextStatus?: string };
type EntryData = {
  suppliers: Array<{ id: string; code?: string | null; name: string; paymentTerm?: { code: string; name: string; days: number | null } | null }>;
  purchaseOrders: Array<{ id: string; supplierId: string; currency: string; status: string; lines: Array<{ id: string; sku: string; itemName: string; orderedQuantity: string; billedQuantity: string; unitPrice: string | null; unit: string | null }> }>;
  receivingDocuments: Array<{ id: string; documentNumber: string | null; poId: string | null; supplierId: string; supplierName: string | null; currency: string | null; lines: Array<{ id: string; purchaseOrderLineId: string | null; sku: string; itemName: string; acceptedQuantity: string; unit: string | null }> }>;
  capabilities: Record<string, { enabled?: boolean }>;
};
type Order = EntryData["purchaseOrders"][number];

// Purchase orders a bill can be recorded against before their goods arrive
// (BILL_BEFORE_RECEIPT_PO_STATUSES in operational-finance-policy.mjs).
const BILL_BEFORE_RECEIPT_PO_STATUSES = new Set(["approved", "issued", "partially_received", "fully_received", "received", "open"]);

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
// Today on the user's calendar, not in UTC.
const localToday = () => {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
};
// Each line of a receipt starts at its accepted quantity; the user can lower it.
const receivedQuantities = (receipt: EntryData["receivingDocuments"][number]) =>
  Object.fromEntries(receipt.lines.map((line) => [line.id, { quantity: String(Number(line.acceptedQuantity)) }]));
// A bill recorded before the goods arrive starts at what was ordered and not
// yet billed.
const unbilledQuantities = (order: Order) =>
  Object.fromEntries(order.lines.map((line) => [line.id, { quantity: String(Math.max(0, Number(line.orderedQuantity) - Number(line.billedQuantity || 0))) }]));

// -------------------------------------------------------------- new invoice

export function NewSupplierInvoice() {
  const { t, locale } = useI18n();
  const [entry, setEntry] = useState<EntryData | null>(null);
  const [supplierId, setSupplierId] = useState("");
  // The purchase order narrows the receipts; with no receipt chosen the bill
  // is recorded against the order and waits for its receipt.
  const [poId, setPoId] = useState("");
  const [receiptId, setReceiptId] = useState("");
  const [invoiceNumber, setInvoiceNumber] = useState("");
  const [invoiceDate, setInvoiceDate] = useState(localToday);
  const [dueDate, setDueDate] = useState("");
  // Until someone types a due date, it follows the supplier's payment term:
  // the invoice date plus the term's days.
  const [dueTyped, setDueTyped] = useState(false);
  const [lines, setLines] = useState<Record<string, { quantity?: string; unitPrice?: string; tax?: string }>>({});
  const [plan, setPlan] = useState<Plan | null>(null);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [sourceNotice, setSourceNotice] = useState("");
  useEffect(() => {
    void apiJson<EntryData>("/api/finance/entry-data")
      .then(setEntry)
      .catch((reason) => setNotice(message(reason, t("finance.loadFailed"))));
  }, []);
  // Opened from a receipt (?receipt=) or a purchase order (?po=): choose the
  // supplier, order and receipt and offer each received quantity. A purchase
  // order without a posted receipt offers what was ordered instead: the bill
  // waits for the receipt before it can be matched and paid.
  useEffect(() => {
    if (!entry) return;
    const params = new URLSearchParams(window.location.search);
    const receiptParam = params.get("receipt");
    const poParam = params.get("po");
    if (receiptParam) {
      const found = entry.receivingDocuments.find((row) => row.id === receiptParam || row.documentNumber === receiptParam);
      if (!found) { setSourceNotice(`${receiptParam}: ${t("finance.receiptNotBillable")}`); return; }
      setSupplierId(found.supplierId);
      setPoId(found.poId || "");
      setReceiptId(found.id);
      setLines(receivedQuantities(found));
    } else if (poParam) {
      const order = entry.purchaseOrders.find((row) => row.id === poParam);
      const forPo = entry.receivingDocuments.filter((row) => row.poId === poParam);
      if (!order && !forPo.length) { setSourceNotice(`${poParam}: ${t("finance.poNotBillable")}`); return; }
      setSupplierId(order?.supplierId || forPo[0].supplierId);
      setPoId(poParam);
      if (forPo.length === 1) {
        setReceiptId(forPo[0].id);
        setLines(receivedQuantities(forPo[0]));
      } else if (!forPo.length && order) setLines(unbilledQuantities(order));
    }
  }, [entry]);
  const orders = useMemo(
    () => (entry?.purchaseOrders || []).filter((row) => row.supplierId === supplierId && (BILL_BEFORE_RECEIPT_PO_STATUSES.has(row.status) || entry?.receivingDocuments.some((receipt) => receipt.poId === row.id) || row.id === poId)),
    [entry, supplierId, poId],
  );
  const receipts = useMemo(
    () => (entry?.receivingDocuments || []).filter((row) => (!supplierId || row.supplierId === supplierId) && (!poId || row.poId === poId)),
    [entry, supplierId, poId],
  );
  const receipt = receipts.find((row) => row.id === receiptId) || null;
  const order = entry?.purchaseOrders.find((row) => row.id === (receipt?.poId || poId)) || null;
  // No receipt yet: the bill is recorded against the order's lines.
  const beforeReceipt = !receipt && Boolean(order);
  const orderOpen = Boolean(order && BILL_BEFORE_RECEIPT_PO_STATUSES.has(order.status));
  const poLine = (id: string | null) => order?.lines.find((line) => line.id === id) || null;
  const currency = receipt?.currency || order?.currency || "";
  const linePrice = (lineId: string, purchaseOrderLineId: string | null) => lines[lineId]?.unitPrice ?? poLine(purchaseOrderLineId)?.unitPrice ?? "";
  const formLines = receipt
    ? receipt.lines.map((line) => ({ id: line.id, purchaseOrderLineId: line.purchaseOrderLineId, receivingLineId: line.id, sku: line.sku, itemName: line.itemName, unit: line.unit, context: `${t("finance.received")} ${line.acceptedQuantity} ${line.unit || ""}` }))
    : beforeReceipt && orderOpen && order
      ? order.lines.map((line) => ({ id: line.id, purchaseOrderLineId: line.id, receivingLineId: "", sku: line.sku, itemName: line.itemName, unit: line.unit, context: `${t("finance.ordered")} ${Number(line.orderedQuantity)} ${line.unit || ""} · ${t("finance.billed")} ${Number(line.billedQuantity || 0)}` }))
      : [];
  const body = () => {
    const chosen = formLines
      .filter((line) => Number(lines[line.id]?.quantity || 0) > 0)
      .map((line) => {
        const quantity = lines[line.id]?.quantity || "0";
        const unitPrice = linePrice(line.id, line.purchaseOrderLineId) || "0";
        const tax = lines[line.id]?.tax || "0";
        return { purchaseOrderLineId: line.purchaseOrderLineId, receivingLineId: line.receivingLineId, quantity, unitPrice, lineAmount: fixed(Number(quantity) * Number(unitPrice)), enteredTaxAmount: tax };
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
  const term = entry?.suppliers.find((row) => row.id === supplierId)?.paymentTerm || null;
  const termDue = term && term.days !== null && /^\d{4}-\d{2}-\d{2}$/.test(invoiceDate) ? addCalendarDays(invoiceDate, term.days) : "";
  useEffect(() => {
    if (!dueTyped && termDue) setDueDate(termDue);
  }, [termDue, dueTyped]);
  const chooseOrder = (id: string) => {
    const next = entry?.purchaseOrders.find((row) => row.id === id);
    const forPo = (entry?.receivingDocuments || []).filter((row) => row.poId === id);
    setPoId(id);
    setReceiptId(forPo.length === 1 ? forPo[0].id : "");
    setLines(forPo.length === 1 ? receivedQuantities(forPo[0]) : !forPo.length && next ? unbilledQuantities(next) : {});
    reset();
  };
  const chooseReceipt = (id: string) => {
    const next = receipts.find((row) => row.id === id);
    setReceiptId(id);
    setLines(next ? receivedQuantities(next) : order ? unbilledQuantities(order) : {});
    reset();
  };
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
      {sourceNotice && <Notice>{sourceNotice}</Notice>}
      <Card className="space-y-4 p-5">
        <div className="grid gap-3 md:grid-cols-3">
          <label className="text-xs">{t("finance.supplier")}
            <select data-testid="supplier-invoice-supplier" className={`${field} mt-1 w-full`} value={supplierId} onChange={(event) => { setSupplierId(event.target.value); setPoId(""); setReceiptId(""); setLines({}); reset(); }}>
              <option value="">—</option>
              {entry.suppliers.map((row) => <option key={row.id} value={row.id}>{row.name}{row.code ? ` · ${row.code}` : ""}</option>)}
            </select>
          </label>
          <label className="text-xs">{t("finance.purchaseOrder")}
            <select data-testid="supplier-invoice-po" className={`${field} mt-1 w-full`} value={poId} onChange={(event) => chooseOrder(event.target.value)}>
              <option value="">{t("finance.anyPurchaseOrder")}</option>
              {orders.map((row) => <option key={row.id} value={row.id}>{row.id} · {row.currency}</option>)}
            </select>
          </label>
          <label className="text-xs">{t("finance.postedReceipt")}
            <select data-testid="supplier-invoice-receipt" className={`${field} mt-1 w-full`} value={receiptId} onChange={(event) => chooseReceipt(event.target.value)}>
              <option value="">{poId ? t("finance.noReceiptYet") : "—"}</option>
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
            <input type="date" data-testid="supplier-invoice-due" className={`${field} mt-1 w-full`} value={dueDate} onChange={(event) => { setDueDate(event.target.value); setDueTyped(true); reset(); }} />
            {!dueTyped && termDue && dueDate === termDue && term && <span className="mt-1 block text-slate-500" data-testid="supplier-invoice-due-terms">{t("finance.dueFromTerms", { term: term.name, days: String(term.days) })}</span>}
          </label>
          <div className="text-xs">{t("finance.currency")}<div className="mt-1 rounded-lg bg-slate-50 px-3 py-2 text-sm">{currency || "—"}</div></div>
        </div>
        {beforeReceipt && orderOpen && <div data-testid="supplier-invoice-before-receipt"><Notice>{t("finance.billBeforeReceipt")}</Notice></div>}
        {beforeReceipt && !orderOpen && <Notice>{order?.id}: {t("finance.poNotBillable")}</Notice>}
        {receipt && !receipt.lines.length && <Notice>{t("finance.noReceiptLines")}</Notice>}
        {formLines.map((line) => {
          const po = poLine(line.purchaseOrderLineId);
          return (
            <div key={line.id} data-testid="supplier-invoice-line" className="grid items-end gap-3 rounded-xl bg-slate-50 p-3 md:grid-cols-5">
              <div className="md:col-span-2">
                <div className="font-medium">{line.sku} · {line.itemName}</div>
                <div className="text-xs text-slate-500">{line.context} · {t("finance.poPrice")} {po?.unitPrice === null || po?.unitPrice === undefined ? "—" : money(po.unitPrice, currency, locale)}</div>
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
          <button type="button" data-testid="supplier-invoice-preview" className={`${button} border border-slate-200`} disabled={!enabled || !formLines.length} onClick={() => void preview()}><RefreshCw size={14} />{t("finance.preview")}</button>
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

// -------------------------------------------------------------- detail

type LinkPlan = Plan & { warnings?: Issue[]; receipt?: { documentNumber?: string | null } };

// A bill recorded before the goods arrived is linked to its receipt once the
// warehouse posts it; only then can it be matched, approved and paid.
function LinkReceipt({ invoice, onDone }: { invoice: { id: string; version: number; relatedPoId: string; receiptCandidates?: Array<{ id: string; documentNumber: string | null }> }; onDone: () => void }) {
  const { t } = useI18n();
  const candidates = invoice.receiptCandidates || [];
  const [open, setOpen] = useState(false);
  const [receiptId, setReceiptId] = useState(candidates[0]?.id || "");
  const [plan, setPlan] = useState<LinkPlan | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const base = `/api/finance/supplier-invoices/${encodeURIComponent(invoice.id)}`;
  const body = () => ({ expectedVersion: invoice.version, receivingDocumentId: receiptId });
  if (!candidates.length) return <p className="text-xs text-slate-500" data-testid="link-receipt-none">{t("finance.noReceiptToLink", { po: invoice.relatedPoId })}</p>;
  if (!open) return <button type="button" data-testid="link-receipt" className={`${button} text-white`} style={{ background: A.blue }} onClick={() => setOpen(true)}>{t("finance.action.link_receipt")}</button>;
  const preview = async () => {
    setError("");
    try { setPlan(await apiJson<LinkPlan>(`${base}/link-receipt-preview`, { method: "POST", body: JSON.stringify(body()) })); } catch (reason) { setError(message(reason, t("finance.loadFailed"))); }
  };
  const confirm = async () => {
    setError("");
    setBusy(true);
    try {
      await apiJson(`${base}/link-receipt`, { method: "POST", body: JSON.stringify({ ...body(), idempotencyKey: createSecureClientMutationId("p2p") }) });
      setOpen(false);
      onDone();
    } catch (reason) {
      setError(reason instanceof ApiError || reason instanceof Error ? reason.message : t("finance.loadFailed"));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="w-full space-y-2 rounded-xl border border-slate-200 p-3" data-testid="link-receipt-panel">
      <label className="block text-xs">{t("finance.postedReceipt")}
        <select data-testid="link-receipt-select" className={`${field} mt-1 w-full`} value={receiptId} onChange={(event) => { setReceiptId(event.target.value); setPlan(null); }}>
          {candidates.map((row) => <option key={row.id} value={row.id}>{row.documentNumber || row.id}</option>)}
        </select>
      </label>
      <div className="flex flex-wrap gap-2">
        <button type="button" data-testid="link-receipt-preview" className={`${button} border border-slate-200`} onClick={() => void preview()}><RefreshCw size={14} />{t("finance.preview")}</button>
        <button type="button" data-testid="link-receipt-confirm" className={`${button} text-white`} style={{ background: A.blue }} disabled={!plan?.allowed || busy} onClick={() => void confirm()}>{t("finance.confirm")}</button>
        <button type="button" className={`${button} text-slate-600`} onClick={() => { setOpen(false); setPlan(null); setError(""); }}>{t("finance.close")}</button>
      </div>
      {plan && (plan.allowed
        ? <Notice tone="success">{t("finance.previewAllowed")}</Notice>
        : <Notice>{(plan.blockingIssues || []).map((issue) => issue.message).join(" · ")}</Notice>)}
      {plan?.allowed && Boolean(plan.warnings?.length) && <Notice>{(plan.warnings || []).map((issue) => issue.message).join(" · ")}</Notice>}
      {error && <Notice>{error}</Notice>}
    </div>
  );
}

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
              {" · "}{t("finance.receipt")} {data.relatedGrnId ? <BusinessEntityLink entityType="receiving_doc" entityId={data.relatedGrnId} /> : data.awaitingReceipt ? <span className="font-medium text-amber-700">{t("finance.awaitingReceipt")}</span> : "—"}
              {data.relatedPoId && <>{" · "}<BusinessEntityLink entityType="three_way_match" entityId={`MATCH-${data.id}`}>{t("finance.threeWayMatch")}</BusinessEntityLink></>}
            </p>
          </div>
          <div className="text-right">
            <strong>{money(data.totalAmount, data.currency, locale)}</strong>
            <div className="mt-1"><StatusChip status={data.status} /></div>
          </div>
        </div>
        {data.awaitingReceipt && (
          <div className="mt-4 space-y-2" data-testid="supplier-invoice-awaiting-receipt">
            <Notice>{t("finance.awaitingReceiptNote")}</Notice>
            {actions.includes("link_receipt") && <LinkReceipt invoice={data} onDone={load} />}
          </div>
        )}
        <div className="mt-4 flex flex-wrap gap-2" data-testid="supplier-invoice-actions">
          {actions.includes("submit") && <TwoStepAction label={t("finance.action.submit")} testId="invoice-submit" previewUrl={`${base}/submit-preview`} runUrl={`${base}/submit`} payload={() => version} onDone={load} />}
          {actions.includes("match") && <TwoStepAction label={t("finance.action.match")} testId="invoice-match" previewUrl={`${base}/match-preview`} runUrl={`${base}/match`} payload={() => version} onDone={load} />}
          {actions.includes("approve") && <TwoStepAction label={t("finance.action.approve")} testId="invoice-approve" previewUrl={`${base}/approve-preview`} runUrl={`${base}/approve`} payload={() => version} onDone={load} />}
          {actions.includes("cancel") && <TwoStepAction label={t("finance.action.cancel")} testId="invoice-cancel" tone="secondary" previewUrl={`${base}/cancel-preview`} runUrl={`${base}/cancel`} payload={() => version} reasonLabel={t("finance.cancelReason")} onDone={load} />}
          {!actions.filter((action) => action !== "link_receipt" && action !== "revise").length && <span className="text-xs text-slate-500">{t("finance.noActions")}</span>}
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
          <PaymentRecords kind="payable" obligation={payable} onDone={load} />
          <div className="flex flex-wrap gap-2">
            {payableActions.filter((action) => action !== "record_payment").map((action) => (
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
