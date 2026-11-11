import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MouseEvent } from "react";
import { ArrowLeft, RefreshCw } from "lucide-react";
import { Link, useNavigate } from "react-router";
import { A, Card, Field, inputStyle } from "../../components/ui";
import { FieldError, FormActionBar, FormHeader, FormSection, focusFirstInvalid, formGridClass, invalidProps, useFormCopy } from "../../components/ui/formLayout";
import { FocusFirstField } from "../../components/ui/FocusFirstField";
import { StatusChip as ToneChip, type StatusTone } from "../../components/ui/listLayout";
import { listTableCardsRef } from "../../components/ui/workbenchTable";
import { BusinessEntityLink } from "../../components/business/BusinessEntityLink";
import { useI18n } from "../../i18n/I18n";
import { unitLabel } from "../../i18n/unitLabels";
import { ApiError, apiJson } from "../../lib/api-client";
import { createSecureClientMutationId } from "../../lib/client-id";
import { formatCalendarDay, formatDateTimeInTimeZone } from "../../lib/format";
import { Notice, StatusChip, TwoStepAction, button, field, message } from "./FinanceControls";
import { PaymentRecords } from "./PaymentRecords";
import { addCalendarDays } from "../../lib/prefill";
import { useDetailCrumb } from "../../components/navigation/detailCrumb";
import { documentNumberFor, rememberDocumentNumbers, useDocumentNumber } from "../../lib/documentNumbers";
import { BackToListLink } from "../procurement/BackToListLink";
import { procurementErrorCode, procurementErrorText } from "../procurement/procurementErrors";
import { matchExceptionLabel } from "../../domain/procurement/variance-types";

// The supplier invoice screens of the trial's procure-to-pay chain: enter an
// invoice against a posted receipt, then submit, match, review exceptions,
// approve or cancel it, and hold or release its payable. Every step previews
// the server's plan first and confirms exactly that operation; the server
// checks permissions, versions and the three-way rules.

type Issue = { code?: string; message?: string; details?: unknown };
type Plan = { allowed: boolean; blockingIssues?: Issue[]; invoice?: { totalAmount?: string; currency?: string }; nextStatus?: string };
type EntryData = {
  suppliers: Array<{ id: string; code?: string | null; name: string; paymentTerm?: { code: string; name: string; days: number | null } | null }>;
  // number: the order's document number (shown); id: its internal id (values and calls).
  purchaseOrders: Array<{ id: string; number?: string; supplierId: string; currency: string; status: string; lines: Array<{ id: string; sku: string; itemName: string; orderedQuantity: string; billedQuantity: string; unitPrice: string | null; unit: string | null }> }>;
  receivingDocuments: Array<{ id: string; documentNumber: string | null; poId: string | null; poNumber?: string | null; supplierId: string; supplierName: string | null; currency: string | null; lines: Array<{ id: string; purchaseOrderLineId: string | null; sku: string; itemName: string; acceptedQuantity: string; unit: string | null }> }>;
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
// The receipt a bill opened from a purchase order starts with: its only
// receipt, or, with several, the oldest that still has goods not invoiced.
// What other bills already claim on each order line is set against the
// oldest receipts first (the server checks the exact quantities on save).
// Entry data lists receipts newest first. Null when every receipt is billed.
export const firstUnbilledReceipt = <R extends { lines: Array<{ purchaseOrderLineId: string | null; acceptedQuantity: string }> }>(
  order: { lines: Array<{ id: string; billedQuantity: string }> } | null | undefined,
  forPo: R[],
): R | null => {
  if (forPo.length <= 1) return forPo[0] || null;
  const billedLeft = new Map((order?.lines || []).map((line) => [line.id, Math.max(0, Number(line.billedQuantity || 0))]));
  for (const receipt of [...forPo].reverse()) {
    let open = false;
    for (const line of receipt.lines) {
      const accepted = Math.max(0, Number(line.acceptedQuantity || 0));
      const key = line.purchaseOrderLineId || "";
      const billed = billedLeft.get(key) || 0;
      const claimed = Math.min(accepted, billed);
      if (key) billedLeft.set(key, billed - claimed);
      if (accepted - claimed > 0) open = true;
    }
    if (open) return receipt;
  }
  return null;
};

// -------------------------------------------------------------- new invoice

// The entry form follows the form standard (components/ui/formLayout.tsx).
// English source copy with its Chinese translation.
const FORM_COPY: Record<string, [string, string]> = {
  intro: ["Record the supplier’s invoice against a posted receipt, or against an open purchase order before the goods arrive. It is saved as a draft; submit it from its page.", "按已过账的收货单录入供应商发票；货物未到时，也可以先按采购订单录入。保存为草稿后，在发票页面提交。"],
  details: ["Invoice details", "发票信息"],
  lines: ["Lines to invoice", "开票明细"],
  linesIntroReceipt: ["Each quantity starts at what was received. Clear a quantity to leave that line off this invoice.", "数量默认为已收数量。清空某行的数量，该行就不计入本张发票。"],
  linesIntroOrder: ["Each quantity starts at what was ordered and not yet invoiced. Clear a quantity to leave that line off this invoice.", "数量默认为已订购、尚未开票的数量。清空某行的数量，该行就不计入本张发票。"],
  linesNone: ["Choose a purchase order or a posted receipt to list its lines.", "选择采购订单或已过账的收货单后，这里会列出可开票的行。"],
  sku: ["SKU", "物料编码"],
  item: ["Item", "物料"],
  amount: ["Amount", "金额"],
  total: ["Total {amount}", "合计 {amount}"],
  totalWithTax: ["Total {amount}, tax {tax}", "合计 {amount}，含税额 {tax}"],
  supplierRequired: ["Choose the supplier.", "请选择供应商。"],
  sourceRequired: ["Choose the purchase order or the posted receipt this invoice is for.", "请选择本发票对应的采购订单或已过账的收货单。"],
  numberRequired: ["Enter the supplier’s invoice number.", "请输入供应商的发票编号。"],
  invoiceDateRequired: ["Enter the invoice date.", "请输入发票日期。"],
  dueDateRequired: ["Enter the due date.", "请输入到期日。"],
  lineRequired: ["Enter a quantity on at least one line.", "请至少在一行填写开票数量。"],
  numberInvalid: ["Enter a number with at most 4 decimals.", "请输入最多 4 位小数的数字。"],
  priceRequired: ["Enter the unit price; 0 is allowed.", "请输入单价，可以为 0。"],
  exceedsReceived: ["More than was received and not yet invoiced ({left} left).", "超过已收、尚未开票的数量（剩余 {left}）。"],
  exceedsOrdered: ["More than was ordered and not yet invoiced ({left} left).", "超过已订购、尚未开票的数量（剩余 {left}）。"],
  sourceChanged: ["The purchase order or receipt changed after this page opened. Reload the page and choose it again.", "页面打开后，采购订单或收货单已有变化。请刷新页面后重新选择。"],
  amountMismatch: ["A line amount or the total does not add up. Check the quantities, prices and tax.", "行金额或合计对不上，请检查数量、单价和税额。"],
  failed: ["The supplier invoice was not saved.", "供应商发票未保存。"],
  // A hint, not a rule: the match will raise the price difference for review.
  aboveOrderPrice: ["+{amount} above the PO price", "比采购单价高 {amount}"],
};
// A quantity, price or tax as the server reads it: at most four decimals.
const DECIMAL = /^\d+(\.\d{1,4})?$/;
type HeaderKey = "supplier" | "source" | "number" | "invoiceDate" | "dueDate";
type LineKey = "quantity" | "unitPrice" | "tax";
// Messages already in the interface language: `form` has no field of its own.
type Problems = { form: string[]; header: Partial<Record<HeaderKey, string>>; byLine: Record<string, Partial<Record<LineKey, string>>> };
const noProblems = (): Problems => ({ form: [], header: {}, byLine: {} });

export function NewSupplierInvoice() {
  const { t, locale, language, formatNumber } = useI18n();
  const formCopy = useFormCopy();
  const tr = (key: string, variables: Record<string, string> = {}) =>
    Object.entries(variables).reduce((text, [name, value]) => text.split(`{${name}}`).join(value), FORM_COPY[key][language === "en-US" ? 0 : 1]);
  const navigate = useNavigate();
  const formRef = useRef<HTMLDivElement>(null);
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
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [sourceNotice, setSourceNotice] = useState("");
  // Save checks the rules; after the first try, messages follow the fields.
  const [checked, setChecked] = useState(false);
  // What the server's plan refused, until the next change.
  const [refused, setRefused] = useState<Problems | null>(null);
  const [saveError, setSaveError] = useState("");
  const [saveErrorCode, setSaveErrorCode] = useState<string | undefined>();
  useEffect(() => {
    void apiJson<EntryData>("/api/finance/entry-data")
      .then((data) => {
        rememberDocumentNumbers("purchase_order", data?.purchaseOrders, (row) => [row.id, row.number]);
        setEntry(data);
      })
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
      const first = firstUnbilledReceipt(order, forPo);
      if (first) {
        setReceiptId(first.id);
        setLines(receivedQuantities(first));
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
    ? receipt.lines.map((line) => ({ id: line.id, purchaseOrderLineId: line.purchaseOrderLineId, receivingLineId: line.id, sku: line.sku, itemName: line.itemName, unit: line.unit, basis: [line.acceptedQuantity] }))
    : beforeReceipt && orderOpen && order
      ? order.lines.map((line) => ({ id: line.id, purchaseOrderLineId: line.id, receivingLineId: "", sku: line.sku, itemName: line.itemName, unit: line.unit, basis: [line.orderedQuantity, line.billedQuantity || "0"] }))
      : [];
  // The lines this invoice bills: those with a quantity above zero.
  const billed = formLines.filter((line) => DECIMAL.test((lines[line.id]?.quantity || "").trim()) && Number(lines[line.id]?.quantity) > 0);
  const body = () => {
    const chosen = billed.map((line) => {
      const quantity = (lines[line.id]?.quantity || "").trim();
      const unitPrice = String(linePrice(line.id, line.purchaseOrderLineId)).trim();
      const tax = (lines[line.id]?.tax || "").trim() || "0";
      return { purchaseOrderLineId: line.purchaseOrderLineId, receivingLineId: line.receivingLineId, quantity, unitPrice, lineAmount: fixed(Number(quantity) * Number(unitPrice)), enteredTaxAmount: tax };
    });
    const total = chosen.reduce((sum, line) => sum + Number(line.lineAmount) + Number(line.enteredTaxAmount || 0), 0);
    return {
      invoiceNumber: invoiceNumber.trim(),
      supplierId,
      currency,
      invoiceDate: invoiceDate ? new Date(`${invoiceDate}T00:00:00.000Z`).toISOString() : "",
      dueDate: dueDate ? new Date(`${dueDate}T00:00:00.000Z`).toISOString() : "",
      totalAmount: fixed(total),
      lines: chosen,
    };
  };
  // Any change makes the server's last answer stale.
  const changed = () => { setRefused(null); setSaveError(""); };
  const term = entry?.suppliers.find((row) => row.id === supplierId)?.paymentTerm || null;
  const termDue = term && term.days !== null && /^\d{4}-\d{2}-\d{2}$/.test(invoiceDate) ? addCalendarDays(invoiceDate, term.days) : "";
  useEffect(() => {
    if (!dueTyped && termDue) setDueDate(termDue);
  }, [termDue, dueTyped]);
  const chooseOrder = (id: string) => {
    const next = entry?.purchaseOrders.find((row) => row.id === id);
    const forPo = (entry?.receivingDocuments || []).filter((row) => row.poId === id);
    const first = id ? firstUnbilledReceipt(next, forPo) : null;
    setPoId(id);
    setReceiptId(first ? first.id : "");
    setLines(first ? receivedQuantities(first) : !forPo.length && next ? unbilledQuantities(next) : {});
    changed();
  };
  const chooseReceipt = (id: string) => {
    const next = receipts.find((row) => row.id === id);
    setReceiptId(id);
    setLines(next ? receivedQuantities(next) : order ? unbilledQuantities(order) : {});
    changed();
  };
  const setLine = (lineId: string, patch: { quantity?: string; unitPrice?: string; tax?: string }) => {
    setLines({ ...lines, [lineId]: { ...lines[lineId], ...patch } });
    changed();
  };

  // The server's own rules, said before the request: each message under its
  // field. Quantity left empty or 0 leaves a line off the invoice.
  const validation = useMemo(() => {
    const found = noProblems();
    if (!supplierId) found.header.supplier = tr("supplierRequired");
    if (!formLines.length) found.header.source = tr("sourceRequired");
    if (!invoiceNumber.trim()) found.header.number = tr("numberRequired");
    if (!invoiceDate) found.header.invoiceDate = tr("invoiceDateRequired");
    if (!dueDate) found.header.dueDate = tr("dueDateRequired");
    let count = 0;
    for (const line of formLines) {
      const quantity = (lines[line.id]?.quantity || "").trim();
      const issue: Partial<Record<LineKey, string>> = {};
      if (quantity && !DECIMAL.test(quantity)) issue.quantity = tr("numberInvalid");
      else if (quantity && Number(quantity) > 0) {
        count += 1;
        const price = String(linePrice(line.id, line.purchaseOrderLineId)).trim();
        if (!price) issue.unitPrice = tr("priceRequired");
        else if (!DECIMAL.test(price)) issue.unitPrice = tr("numberInvalid");
        const tax = (lines[line.id]?.tax || "").trim();
        if (tax && !DECIMAL.test(tax)) issue.tax = tr("numberInvalid");
      }
      if (Object.keys(issue).length) found.byLine[line.id] = issue;
    }
    if (formLines.length && !count && !Object.keys(found.byLine).length) found.form.push(tr("lineRequired"));
    return found;
  }, [supplierId, formLines.length, invoiceNumber, invoiceDate, dueDate, lines, receipt, order, language]);
  const hasProblems = (problems: Problems) => problems.form.length + Object.keys(problems.header).length + Object.keys(problems.byLine).length > 0;

  // The plan's refusal, put under the fields it names where it names one.
  const fromPlan = (issues: Issue[]): Problems => {
    const found = noProblems();
    const ids = billed.map((line) => line.id);
    const left = (total: unknown, before: unknown) => formatNumber(Math.max(0, Number(total || 0) - Number(before || 0)));
    const form = (text: string) => { if (!found.form.includes(text)) found.form.push(text); };
    for (const item of issues) {
      const details = (item.details || {}) as Record<string, string | undefined>;
      const decimal = /^Line (\d+) (quantity|unit price|entered tax)/.exec(item.message || "");
      if (item.code === "SUPPLIER_INVOICE_NUMBER_REQUIRED") found.header.number = tr("numberRequired");
      else if (item.code === "SUPPLIER_REQUIRED" || item.code === "SUPPLIER_NOT_FOUND") found.header.supplier = tr("supplierRequired");
      else if (item.code === "SUPPLIER_INVOICE_DATE_REQUIRED") {
        if (!invoiceDate) found.header.invoiceDate = tr("invoiceDateRequired");
        found.header.dueDate = tr("dueDateRequired");
      } else if (item.code === "SUPPLIER_INVOICE_LINES_REQUIRED") form(tr("lineRequired"));
      else if (item.code === "SUPPLIER_INVOICE_QUANTITY_EXCEEDS_RECEIVED" && details.receivingLineId)
        found.byLine[details.receivingLineId] = { ...found.byLine[details.receivingLineId], quantity: tr("exceedsReceived", { left: left(details.receivedQuantity, details.previouslyInvoicedQuantity) }) };
      else if (item.code === "SUPPLIER_INVOICE_QUANTITY_EXCEEDS_ORDERED" && details.purchaseOrderLineId)
        found.byLine[details.purchaseOrderLineId] = { ...found.byLine[details.purchaseOrderLineId], quantity: tr("exceedsOrdered", { left: left(details.orderedQuantity, details.previouslyInvoicedQuantity) }) };
      else if (item.code === "FINANCE_DECIMAL_INVALID" && decimal && ids[Number(decimal[1]) - 1]) {
        const key: LineKey = decimal[2] === "quantity" ? "quantity" : decimal[2] === "unit price" ? "unitPrice" : "tax";
        const id = ids[Number(decimal[1]) - 1];
        found.byLine[id] = { ...found.byLine[id], [key]: tr("numberInvalid") };
      } else if (item.code === "SUPPLIER_INVOICE_PO_NOT_OPEN") form(t("finance.poNotBillable"));
      else if (item.code === "SUPPLIER_INVOICE_LINE_AMOUNT_MISMATCH" || item.code === "SUPPLIER_INVOICE_TOTAL_MISMATCH" || item.code === "FINANCE_DECIMAL_INVALID") form(tr("amountMismatch"));
      else form(tr("sourceChanged"));
    }
    return found;
  };

  // Save checks the form, then asks the server's plan (the same rules the
  // create runs), then creates the draft.
  const save = async () => {
    setChecked(true);
    setRefused(null);
    setSaveError("");
    setSaveErrorCode(undefined);
    if (hasProblems(validation)) { focusFirstInvalid(formRef.current); return; }
    setBusy(true);
    try {
      const plan = await apiJson<Plan>("/api/finance/supplier-invoices/preview", { method: "POST", body: JSON.stringify(body()) });
      if (!plan.allowed) {
        setRefused(fromPlan(plan.blockingIssues || []));
        setSaveErrorCode((plan.blockingIssues || []).map((issue) => issue.code).filter(Boolean).join(" · ") || undefined);
        focusFirstInvalid(formRef.current);
        return;
      }
      const result = await apiJson<{ entityId: string }>("/api/finance/supplier-invoices", {
        method: "POST",
        body: JSON.stringify({ ...body(), idempotencyKey: createSecureClientMutationId("p2p") }),
      });
      window.location.assign(`/app/procurement/bills/${encodeURIComponent(result.entityId)}`);
    } catch (reason) {
      setSaveError(`${tr("failed")} ${procurementErrorText(reason, language, ["Try again in a moment.", "请稍后重试。"])}`);
      setSaveErrorCode(procurementErrorCode(reason));
    } finally {
      setBusy(false);
    }
  };
  if (!entry) return notice ? <Notice>{notice}</Notice> : <Card className="p-6">{t("common.loading")}</Card>;
  const enabled = Boolean(entry.capabilities?.["supplier-invoice"]?.enabled);
  const shown = checked ? validation : noProblems();
  const problems: Problems = refused
    ? { form: [...shown.form, ...refused.form], header: { ...shown.header, ...refused.header }, byLine: { ...shown.byLine, ...Object.fromEntries(Object.entries(refused.byLine).map(([id, issue]) => [id, { ...shown.byLine[id], ...issue }])) } }
    : shown;
  const fieldIssues = Object.keys(problems.header).length + Object.keys(problems.byLine).length > 0;
  const barMessage = problems.form.length || fieldIssues || saveError ? (
    <>
      {problems.form.map((text) => <div key={text}>{text}</div>)}
      {fieldIssues && <div>{formCopy("checkFields")}</div>}
      {saveError && <div>{saveError}</div>}
    </>
  ) : null;
  const amountOf = (line: (typeof formLines)[number]) => {
    const quantity = (lines[line.id]?.quantity || "").trim();
    const price = String(linePrice(line.id, line.purchaseOrderLineId)).trim();
    return DECIMAL.test(quantity) && Number(quantity) > 0 && DECIMAL.test(price) ? Number(quantity) * Number(price) : null;
  };
  const subtotal = billed.reduce((sum, line) => sum + (amountOf(line) || 0), 0);
  const tax = billed.reduce((sum, line) => sum + (DECIMAL.test((lines[line.id]?.tax || "").trim()) ? Number(lines[line.id]?.tax) : 0), 0);
  const quantityText = (value: string, unit: string | null) => `${formatNumber(Number(value))}${unit ? ` ${unitLabel(unit, language, Number(value))}` : ""}`;
  const cellInputClass = "w-24 rounded-lg border px-2 py-1.5 text-sm tabular-nums";
  const lineErrorId = (lineId: string, key: LineKey) => `supplier-invoice-${key}-${lineId}`;
  // How far a typed unit price is above the order's: a hint under the field,
  // never a refusal (the match raises the difference for review).
  const aboveOrderPrice = (line: (typeof formLines)[number]) => {
    const typed = String(linePrice(line.id, line.purchaseOrderLineId)).trim();
    const ordered = poLine(line.purchaseOrderLineId)?.unitPrice;
    if (!DECIMAL.test(typed) || ordered === null || ordered === undefined || ordered === "" || !Number.isFinite(Number(ordered))) return null;
    const difference = Math.round((Number(typed) - Number(ordered)) * 10000) / 10000;
    return difference > 0 ? difference : null;
  };
  const lineInput = (line: (typeof formLines)[number], key: LineKey, label: string, value: string) => {
    const error = problems.byLine[line.id]?.[key];
    const above = key === "unitPrice" && !error ? aboveOrderPrice(line) : null;
    const hintId = `supplier-invoice-price-hint-${line.id}`;
    return (
      <td className="px-3 py-2" data-testid={`supplier-invoice-${key}-cell`}>
        <input inputMode="decimal" aria-label={`${label} ${line.sku}`} {...invalidProps(lineErrorId(line.id, key), error)} {...(above !== null ? { "aria-describedby": hintId } : {})} className={cellInputClass} style={{ borderColor: A.border }} value={value} onChange={(event) => setLine(line.id, { [key]: event.target.value })} />
        {error && <FieldError id={lineErrorId(line.id, key)} className="max-w-48">{error}</FieldError>}
        {above !== null && <p id={hintId} className="mt-1 max-w-48 text-[12px] leading-[18px] text-amber-700" data-testid="supplier-invoice-price-above">{tr("aboveOrderPrice", { amount: money(above, currency, locale) })}</p>}
      </td>
    );
  };
  const basisHeads = receipt ? [t("finance.received")] : [t("finance.ordered"), t("finance.billed")];
  return (
    <div ref={formRef} className="space-y-5" data-testid="new-supplier-invoice">
      <FocusFirstField />
      <FormHeader intro={tr("intro")}>
        {(!enabled || notice || sourceNotice) && (
          <div className="mt-3 space-y-2">
            {!enabled && <Notice>{t("finance.capabilityDisabled")}</Notice>}
            {notice && <Notice>{notice}</Notice>}
            {sourceNotice && <Notice>{sourceNotice}</Notice>}
          </div>
        )}
      </FormHeader>

      <FormSection title={tr("details")}>
        <div className={formGridClass}>
          <Field label={t("finance.supplier")} required error={problems.header.supplier}>
            <select data-testid="supplier-invoice-supplier" style={inputStyle} value={supplierId} onChange={(event) => { setSupplierId(event.target.value); setPoId(""); setReceiptId(""); setLines({}); changed(); }}>
              <option value="">—</option>
              {entry.suppliers.map((row) => <option key={row.id} value={row.id}>{row.name}{row.code ? ` · ${row.code}` : ""}</option>)}
            </select>
          </Field>
          <Field label={t("finance.purchaseOrder")} error={problems.header.source}>
            <select data-testid="supplier-invoice-po" style={inputStyle} value={poId} onChange={(event) => chooseOrder(event.target.value)}>
              <option value="">{t("finance.anyPurchaseOrder")}</option>
              {orders.map((row) => <option key={row.id} value={row.id}>{row.number || row.id} · {row.currency}</option>)}
            </select>
          </Field>
          <Field label={t("finance.postedReceipt")}>
            <select data-testid="supplier-invoice-receipt" style={inputStyle} value={receiptId} onChange={(event) => chooseReceipt(event.target.value)}>
              {/* "No receipt yet" only when the order has none; with receipts listed, a choice. */}
              <option value="">{receipts.length ? t("finance.chooseReceipt") : poId ? t("finance.noReceiptYet") : "—"}</option>
              {receipts.map((row) => <option key={row.id} value={row.id}>{row.documentNumber || row.id} · {documentNumberFor("purchase_order", row.poId, row.poNumber) || "—"}{row.supplierName ? ` · ${row.supplierName}` : ""}</option>)}
            </select>
          </Field>
          <Field label={t("finance.currency")}>
            <input readOnly data-testid="supplier-invoice-currency" style={{ ...inputStyle, background: A.gray6 }} value={currency || "—"} />
          </Field>
          <Field label={t("finance.invoiceNumber")} required error={problems.header.number}>
            <input data-testid="supplier-invoice-number" style={inputStyle} value={invoiceNumber} onChange={(event) => { setInvoiceNumber(event.target.value); changed(); }} />
          </Field>
          <Field label={t("finance.invoiceDate")} required error={problems.header.invoiceDate}>
            <input type="date" style={inputStyle} value={invoiceDate} onChange={(event) => { setInvoiceDate(event.target.value); changed(); }} />
          </Field>
          <Field label={t("finance.dueDate")} required error={problems.header.dueDate}>
            <input type="date" data-testid="supplier-invoice-due" style={inputStyle} value={dueDate} onChange={(event) => { setDueDate(event.target.value); setDueTyped(true); changed(); }} />
            {!dueTyped && termDue && dueDate === termDue && term ? <span className="block text-[12px] leading-[18px]" style={{ color: A.sub }} data-testid="supplier-invoice-due-terms">{t("finance.dueFromTerms", { term: term.name, days: String(term.days) })}</span> : null}
          </Field>
        </div>
      </FormSection>

      <FormSection
        title={tr("lines")}
        description={formLines.length ? tr(receipt ? "linesIntroReceipt" : "linesIntroOrder") : undefined}
        right={billed.length ? <span className="text-sm font-semibold tabular-nums" style={{ color: A.label }} data-testid="supplier-invoice-total">{tax > 0 ? tr("totalWithTax", { amount: money(subtotal + tax, currency, locale), tax: money(tax, currency, locale) }) : tr("total", { amount: money(subtotal, currency, locale) })}</span> : undefined}
        testId="supplier-invoice-lines"
      >
        <div className="space-y-3">
          {beforeReceipt && orderOpen && <div data-testid="supplier-invoice-before-receipt"><Notice>{receipts.length ? t("finance.billWithoutReceipt") : t("finance.billBeforeReceipt")}</Notice></div>}
          {beforeReceipt && !orderOpen && <Notice>{order?.number || order?.id}: {t("finance.poNotBillable")}</Notice>}
          {receipt && !receipt.lines.length && <Notice>{t("finance.noReceiptLines")}</Notice>}
          {!poId && !receiptId && <p className="text-sm" style={{ color: A.sub }}>{tr("linesNone")}</p>}
          {formLines.length > 0 && (
            // Phones show each line as a card (listTableCardsRef): the item
            // first, then each figure and input with its column name.
            <div className="overflow-x-auto rounded-lg border" style={{ borderColor: A.border }} ref={listTableCardsRef}>
              <table className="w-full min-w-[860px] text-left text-sm">
                <thead className="bg-gray-50 text-xs" style={{ color: A.sub }}>
                  <tr>
                    {/* Figures read right-aligned; the inputs keep the left edge. */}
                    {[[tr("sku"), false], [tr("item"), false], ...basisHeads.map((head) => [head, true] as const), [t("finance.poPrice"), true], [t("finance.quantity"), false], [t("finance.unitPrice"), false], [t("finance.tax"), false], [tr("amount"), true]].map(([head, right]) => (
                      // The item name takes the spare width, so the input columns stay narrow.
                      <th key={String(head)} className={`whitespace-nowrap px-3 py-2 font-medium${right ? " text-right" : ""}${head === tr("item") ? " w-full" : ""}`} {...(head === tr("item") ? { "data-card-title": "" } : {})}>{head}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {formLines.map((line) => {
                    const po = poLine(line.purchaseOrderLineId);
                    const amount = amountOf(line);
                    return (
                      <tr key={line.id} data-testid="supplier-invoice-line" className="border-t align-top" style={{ borderColor: A.border }}>
                        <td className="whitespace-nowrap px-3 pb-2 pt-[15px] font-mono text-xs">{line.sku}</td>
                        <td className="min-w-40 px-3 pb-2 pt-[15px]">{line.itemName}</td>
                        {line.basis.map((value, index) => <td key={index} className="whitespace-nowrap px-3 pb-2 pt-[15px] text-right tabular-nums">{quantityText(value, line.unit)}</td>)}
                        <td className="whitespace-nowrap px-3 pb-2 pt-[15px] text-right tabular-nums">{po?.unitPrice === null || po?.unitPrice === undefined ? "—" : money(po.unitPrice, currency, locale)}</td>
                        {lineInput(line, "quantity", t("finance.quantity"), lines[line.id]?.quantity || "")}
                        {lineInput(line, "unitPrice", t("finance.unitPrice"), String(linePrice(line.id, line.purchaseOrderLineId) || ""))}
                        {lineInput(line, "tax", t("finance.tax"), lines[line.id]?.tax || "")}
                        <td className="whitespace-nowrap px-3 pb-2 pt-[15px] text-right tabular-nums">{amount === null ? "—" : money(amount, currency, locale)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </FormSection>

      <FormActionBar
        onCancel={() => (window.history.length > 1 ? navigate(-1) : navigate("/app/procurement/bills"))}
        submit={{ label: t("finance.createDraft"), onClick: () => void save(), busy, disabled: !enabled, testId: "supplier-invoice-create" }}
        message={barMessage ? <div title={saveErrorCode}>{barMessage}</div> : null}
        messageTestId="supplier-invoice-errors"
      />
    </div>
  );
}

// -------------------------------------------------------------- detail

type LinkPlan = Plan & { warnings?: Issue[]; receipt?: { documentNumber?: string | null } };

// A bill recorded before the goods arrived is linked to its receipt once the
// warehouse posts it; only then can it be matched, approved and paid.
function LinkReceipt({ invoice, onDone }: { invoice: { id: string; version: number; relatedPoId: string; relatedPoNumber?: string; poNumber?: string; receiptCandidates?: Array<{ id: string; documentNumber: string | null }> }; onDone: () => void }) {
  const { t, language } = useI18n();
  // The failed request's code, in the error's tooltip for support.
  const [errorCode, setErrorCode] = useState<string | undefined>();
  const candidates = invoice.receiptCandidates || [];
  const [open, setOpen] = useState(false);
  const [receiptId, setReceiptId] = useState(candidates[0]?.id || "");
  const [plan, setPlan] = useState<LinkPlan | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const poNumber = useDocumentNumber("purchase_order", invoice.relatedPoId, invoice.relatedPoNumber || invoice.poNumber);
  const base = `/api/finance/supplier-invoices/${encodeURIComponent(invoice.id)}`;
  const body = () => ({ expectedVersion: invoice.version, receivingDocumentId: receiptId });
  if (!candidates.length) return <p className="text-xs text-slate-500" data-testid="link-receipt-none">{t("finance.noReceiptToLink", { po: poNumber })}</p>;
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
      setError(procurementErrorText(reason, language, ["The receipt could not be linked. Try again.", "收货单关联失败，请重试。"]));
      setErrorCode(procurementErrorCode(reason));
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
      {error && <div title={errorCode}><Notice>{error}</Notice></div>}
    </div>
  );
}

// ------------------------------------------------------- duplicate checks

type DuplicateBill = { id: string; invoiceNumber: string; invoiceDate: string | null; totalAmount: string | null; currency: string; status: string; version?: number | null };
type DuplicateReview = { id: string; otherInvoiceId: string; otherInvoice: DuplicateBill | null; kind: "likely" | "possible"; reason: string; dismissedByName: string; dismissedAt: string; stale: boolean };
type DuplicateFlag = { kind: "likely" | "possible"; otherInvoiceId: string; otherInvoice: DuplicateBill | null; daysApart: number | null; windowDays: number; status: "open" | "dismissed" | "closed"; dismissal: DuplicateReview | null; otherSideDismissal?: DuplicateReview | null };
type DuplicateChecksData = { windowDays: number; notChecked: string[]; possibleHidden: boolean; openCount: number; flags: DuplicateFlag[]; reviews: DuplicateReview[] };
type DuplicateIssueFlag = Pick<DuplicateFlag, "kind" | "otherInvoiceId" | "otherInvoice" | "daysApart">;
type Translate = ReturnType<typeof useI18n>["t"];

const DUPLICATE_REASON_MAX = 500;

// A bill date is a calendar date (YYYY-MM-DD), shown as entered with no
// timezone shift.
const billDate = (value: string | null | undefined, locale: string) =>
  value && /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone: "UTC" }).format(new Date(`${value}T00:00:00.000Z`))
    : value || "—";

const duplicateFlagLabel = (flag: Pick<DuplicateFlag, "kind" | "daysApart">, t: Translate) =>
  flag.kind === "likely" ? t("finance.duplicates.likely")
    : flag.daysApart === 0 ? t("finance.duplicates.possibleSameDay")
    : flag.daysApart === 1 ? t("finance.duplicates.possibleOneDay")
    : t("finance.duplicates.possibleDays", { days: flag.daysApart ?? "—" });

// The other bill as the approver reads it: number (a link), date, amount and
// status. The amount is blank for a reader who cannot see amounts.
function DuplicateOtherBill({ other, id }: { other: DuplicateBill | null; id: string }) {
  const { locale } = useI18n();
  if (!other) return <span>{id}</span>;
  return <><a className="font-medium text-blue-600 hover:underline" href={`/app/procurement/bills/${encodeURIComponent(other.id)}`}>{other.invoiceNumber}</a>{" · "}{billDate(other.invoiceDate, locale)}{" · "}{money(other.totalAmount, other.currency, locale)}{" "}<StatusChip status={other.status} /></>;
}

// The translated text of the duplicate issues the server returns.
const duplicateIssueText = (t: Translate) => (code: string | undefined) =>
  code === "DUPLICATE_REVIEW_REQUIRED" ? t("finance.duplicates.reviewRequired")
    : code === "DUPLICATE_REVIEW_HIDDEN" ? t("finance.duplicates.reviewHidden")
    : code === "DUPLICATE_FLAG_NOT_FOUND" ? t("finance.duplicates.flagNotFound")
    : code === "DUPLICATE_FLAG_CHANGED" ? t("finance.duplicates.flagChanged")
    : code === "DUPLICATE_DISMISS_REASON_REQUIRED" ? t("finance.duplicates.reasonRequired")
    : code === "DUPLICATE_DISMISS_REASON_TOO_LONG" ? t("finance.duplicates.reasonTooLong", { max: DUPLICATE_REASON_MAX })
    : undefined;

// At the approval step: each open flag the approver can see, with the other
// bill, so they need not look for it on the page.
function DuplicateApprovalDetail({ issue }: { issue: Issue }) {
  const { t } = useI18n();
  if (issue.code !== "DUPLICATE_REVIEW_REQUIRED") return null;
  const flags = (issue.details as { flags?: DuplicateIssueFlag[] } | undefined)?.flags || [];
  if (!flags.length) return null;
  return (
    <ul className="space-y-1 text-sm" data-testid="invoice-approve-duplicates">
      {flags.map((flag) => (
        <li key={`${flag.kind}-${flag.otherInvoiceId}`} className="flex flex-wrap items-center gap-1 rounded-lg bg-amber-50 p-2" data-testid="invoice-approve-duplicate" data-kind={flag.kind}>
          <span className="font-medium">{duplicateFlagLabel(flag, t)}</span>
          {" · "}{t("finance.duplicates.otherBill")}: <DuplicateOtherBill other={flag.otherInvoice} id={flag.otherInvoiceId} />
        </li>
      ))}
    </ul>
  );
}

// Another bill of the same supplier that may be the same invoice (plan item
// C1): the same number once format is set aside, or the same amount in the
// same currency within the printed number of days. The approver dismisses a
// flag with a reason or cancels this bill; nothing is held on its own. Once
// this bill is past approval (approved, held or cancelled) its flags are
// shown for information.
function DuplicateChecks({ invoice, checks, canDismiss, onDone }: { invoice: { id: string; version: number; invoiceNumber?: string }; checks: DuplicateChecksData; canDismiss: boolean; onDone: () => void }) {
  const { t, locale } = useI18n();
  const base = `/api/finance/supplier-invoices/${encodeURIComponent(invoice.id)}`;
  const notCheckedText: Record<string, string> = {
    no_supplier: t("finance.duplicates.noSupplier"),
    no_date: t("finance.duplicates.noDate"),
    no_number: t("finance.duplicates.noNumber"),
    no_amount: t("finance.duplicates.noAmount"),
  };
  const dismissedText = (review: DuplicateReview) => t("finance.duplicates.dismissed", { name: review.dismissedByName, date: formatDateTimeInTimeZone(review.dismissedAt, locale), reason: review.reason });
  const otherSideText = (review: DuplicateReview) => t("finance.duplicates.otherSideDismissed", { name: review.dismissedByName, date: formatDateTimeInTimeZone(review.dismissedAt, locale), reason: review.reason });
  const baseIssueText = duplicateIssueText(t);
  const issueText = (code: string | undefined) =>
    code === "SUPPLIER_INVOICE_STATUS_INVALID" ? t("finance.duplicates.pastApproval")
      : code === "FINANCE_VALIDATION_FAILED" ? t("finance.duplicates.nameFlag")
      : baseIssueText(code);
  const statusText = (flag: DuplicateFlag) =>
    flag.status === "open" ? t("finance.status.open")
      : flag.status === "dismissed" ? t("finance.duplicates.statusDismissed")
      : t("finance.duplicates.statusClosed");
  // "None" is said only of the checks that were run and are shown.
  const numberChecked = !checks.notChecked.includes("no_number");
  const amountChecked = !checks.possibleHidden && !checks.notChecked.some((code) => code === "no_date" || code === "no_amount");
  const showNone = !checks.flags.length && !checks.notChecked.includes("no_supplier");
  const stale = checks.reviews.filter((review) => review.stale);
  return (
    <Card className="space-y-3 p-5" data-testid="supplier-invoice-duplicates">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="font-semibold">{t("finance.duplicates.title")}</h3>
        <span className="text-xs text-slate-500" data-testid="duplicate-window">{t("finance.duplicates.window", { days: checks.windowDays })}</span>
      </div>
      {checks.notChecked.map((code) => <p key={code} className="text-xs text-amber-700" data-testid={`duplicate-not-checked-${code}`}>{notCheckedText[code] || code}</p>)}
      {checks.possibleHidden && <p className="text-xs text-slate-500" data-testid="duplicate-amount-hidden">{t("finance.duplicates.amountHidden")}</p>}
      {showNone && numberChecked && <p className="text-sm text-slate-500" data-testid="duplicate-none-number">{t("finance.duplicates.noneNumber")}</p>}
      {showNone && amountChecked && <p className="text-sm text-slate-500" data-testid="duplicate-none-amount">{t("finance.duplicates.noneAmount", { days: checks.windowDays })}</p>}
      {checks.flags.map((flag) => (
        <div key={`${flag.kind}-${flag.otherInvoiceId}`} className={`space-y-2 rounded-xl p-3 text-sm ${flag.status === "open" ? "border border-amber-200 bg-amber-50" : "bg-slate-50"}`} data-testid="duplicate-flag" data-kind={flag.kind} data-status={flag.status}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="font-medium">{duplicateFlagLabel(flag, t)}</span>
            <span className="text-xs text-slate-600" data-testid="duplicate-flag-status">{statusText(flag)}</span>
          </div>
          {flag.kind === "likely" && invoice.invoiceNumber && <div className="text-slate-600">{t("finance.duplicates.thisBill")}: <span className="font-medium">{invoice.invoiceNumber}</span></div>}
          <div className="flex flex-wrap items-center gap-1 text-slate-600">{t("finance.duplicates.otherBill")}: <DuplicateOtherBill other={flag.otherInvoice} id={flag.otherInvoiceId} /></div>
          {flag.dismissal && <div className="text-xs text-slate-600" data-testid="duplicate-dismissal">{dismissedText(flag.dismissal)}</div>}
          {flag.otherSideDismissal && <div className="text-xs text-slate-600" data-testid="duplicate-other-side-dismissal">{otherSideText(flag.otherSideDismissal)}</div>}
          {flag.status === "open" && canDismiss && (
            <div className="flex flex-wrap gap-2">
              <TwoStepAction
                label={t("finance.duplicates.dismiss")}
                testId={`duplicate-dismiss-${flag.kind}`}
                tone="secondary"
                previewUrl={`${base}/duplicate-dismiss-preview`}
                runUrl={`${base}/duplicate-dismiss`}
                payload={() => ({ expectedVersion: invoice.version, otherInvoiceId: flag.otherInvoiceId, otherVersion: flag.otherInvoice?.version, kind: flag.kind })}
                reasonLabel={t("finance.duplicates.dismissReason")}
                reasonMaxLength={DUPLICATE_REASON_MAX}
                issueText={issueText}
                onDone={onDone}
              />
            </div>
          )}
        </div>
      ))}
      {stale.length > 0 && (
        <div className="space-y-1" data-testid="duplicate-history">
          <h4 className="text-xs font-semibold text-slate-500">{t("finance.duplicates.history")}</h4>
          {stale.map((review) => (
            <div key={review.id} className="rounded-lg bg-slate-50 p-2 text-xs text-slate-500" data-testid="duplicate-stale-review">
              <div>{review.kind === "likely" ? t("finance.duplicates.likely") : t("finance.duplicates.possible")} · <DuplicateOtherBill other={review.otherInvoice} id={review.otherInvoiceId} /></div>
              <div>{dismissedText(review)}</div>
              <div className="font-medium">{t("finance.duplicates.stale")}</div>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

// ---------------------------------------------------------- variance reason

// One line of the three-way match, as the procurement read model returns it.
// priceVariance is the price difference over the invoiced quantity.
type VarianceLine = { sku?: string; itemName?: string; unit?: string; status?: string; invoicedQty?: number | null; receivedQty?: number | null; poUnitPrice?: number | null; invoiceUnitPrice?: number | null; priceVariance?: number | null; varianceAmount?: number | null };

// A money amount with its sign: +$0.14, −$0.05.
const signedMoney = (value: number, currency: unknown, locale: string) => `${value > 0 ? "+" : value < 0 ? "−" : ""}${money(Math.abs(value), currency, locale)}`;

// Scrolls to a card of this page (an in-page link that keeps the address).
const scrollToCard = (id: string) => (event: MouseEvent) => {
  event.preventDefault();
  document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
};

// Why a bill is in exception, at the top of the page: the recorded variance
// and, when the three-way match can be read, each line that differs from the
// purchase order or the receipt: the price per unit and over the line. Each
// difference is approved or rejected under Three-way match below.
function VarianceReason({ invoice }: { invoice: { id: string; version?: number; currency?: string; varianceAmount?: string | number | null } }) {
  const { language, locale, formatNumber } = useI18n();
  const say = (english: string, chinese: string) => (language === "en-US" ? english : chinese);
  const matchId = `MATCH-${invoice.id}`;
  const [lines, setLines] = useState<VarianceLine[]>([]);
  useEffect(() => {
    let alive = true;
    apiJson<{ document?: { lines?: VarianceLine[] } }>(`/api/procurement/documents/threeWayMatch/${encodeURIComponent(matchId)}`)
      .then((payload) => { if (alive) setLines((payload.document?.lines || []).filter((line) => line.status && line.status !== "matched")); })
      // Without the match (no permission, or none recorded) the recorded variance is shown alone.
      .catch(() => { if (alive) setLines([]); });
    return () => { alive = false; };
  }, [matchId, invoice.version]);
  const amount = (value: unknown) => money(value, invoice.currency, locale);
  const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
  const quantity = (value: number | null | undefined, unit?: string) => (finite(value) ? `${formatNumber(value)}${unit ? ` ${unitLabel(unit, language, value)}` : ""}` : "—");
  const lineText = (line: VarianceLine) => {
    const item = line.sku || line.itemName || say("A line", "某行");
    const unit = line.unit ? unitLabel(line.unit, language, 1) : say("unit", "单位");
    // The difference per unit, and over the invoiced quantity.
    const perUnit = finite(line.invoiceUnitPrice) && finite(line.poUnitPrice) ? Math.round((line.invoiceUnitPrice - line.poUnitPrice) * 10000) / 10000 : null;
    const overLine = finite(line.priceVariance) ? line.priceVariance : finite(perUnit) && finite(line.invoicedQty) ? perUnit * line.invoicedQty : null;
    const perUnitText = perUnit === null ? "" : signedMoney(perUnit, invoice.currency, locale);
    const overLineText = overLine === null ? "" : signedMoney(overLine, invoice.currency, locale);
    const priceDifference = perUnit === null || perUnit === 0
      ? ""
      : overLine === null
        ? say(` (${perUnitText}/${unit})`, `（每${unit} ${perUnitText}）`)
        : say(` (${perUnitText}/${unit}, ${overLineText} in total)`, `（每${unit} ${perUnitText}，合计 ${overLineText}）`);
    const price = say(`invoice price ${amount(line.invoiceUnitPrice)}, PO price ${amount(line.poUnitPrice)}`, `发票单价 ${amount(line.invoiceUnitPrice)}，订单单价 ${amount(line.poUnitPrice)}`) + priceDifference;
    const qty = say(`invoiced ${quantity(line.invoicedQty, line.unit)}, received ${quantity(line.receivedQty, line.unit)}`, `开票 ${quantity(line.invoicedQty, line.unit)}，已收 ${quantity(line.receivedQty, line.unit)}`);
    const parts = line.status === "price_variance" ? [price] : line.status === "quantity_variance" ? [qty] : line.status === "price_and_quantity_variance" ? [price, qty] : [];
    // An amount difference with no price or quantity part: the line total.
    const difference = !parts.length && finite(line.varianceAmount) && line.varianceAmount ? say(` (${signedMoney(line.varianceAmount, invoice.currency, locale)})`, `（${signedMoney(line.varianceAmount, invoice.currency, locale)}）`) : "";
    return `${item}${say(": ", "：")}${parts.join(say("; ", "；")) || say("differs from the purchase order", "与采购订单不一致")}${difference}`;
  };
  const recorded = Number(invoice.varianceAmount || 0);
  return (
    <div className="mt-4 space-y-1 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900" data-testid="supplier-invoice-variance-reason">
      <div className="font-medium">{recorded ? say(`This invoice differs from the purchase order or receipt by ${amount(recorded)}.`, `该发票与采购订单或收货相差 ${amount(recorded)}。`) : say("This invoice differs from the purchase order or receipt.", "该发票与采购订单或收货不一致。")}</div>
      {lines.map((line, index) => <div key={index} className="text-xs" data-testid="supplier-invoice-variance-line">{lineText(line)}</div>)}
      <div className="text-xs">
        {say("Review each difference under Three-way match below: approve it with a note, or reject it.", "请在下方「三单匹配」逐条复核差异：填写说明后批准或驳回。")}{" "}
        <a href="#supplier-invoice-match" onClick={scrollToCard("supplier-invoice-match")} className="font-semibold text-blue-600 hover:underline" data-testid="supplier-invoice-variance-actions">{say("Go to the differences", "前往复核差异")}</a>
        {" · "}
        <Link to={`/app/procurement/three-way-match/${encodeURIComponent(matchId)}`} className="font-semibold text-blue-600 hover:underline" data-testid="supplier-invoice-variance-match">{say("Open the three-way match", "查看三单匹配")}</Link>
      </div>
    </div>
  );
}

// ------------------------------------------------------------ match card

type MatchLineView = { id: string; supplierInvoiceLineId?: string | null; invoiceQuantity?: string | null; priceVariance?: string | null };
type MatchExceptionView = { id: string; matchLineId?: string | null; exceptionType: string; status: string; expectedValue?: string | null; actualValue?: string | null; varianceValue?: string | null; currency?: string | null; resolution?: string | null; version: number };

// The order the differences are listed in: per line, quantity, price, amount.
const EXCEPTION_ORDER: Record<string, number> = { quantity: 0, price: 1, amount: 2 };
export const sortMatchExceptions = <E extends { exceptionType: string; matchLineId?: string | null }>(entries: E[], lineOrder: string[] = []) =>
  entries
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => {
      const line = (entry: E) => { const at = lineOrder.indexOf(String(entry.matchLineId || "")); return at < 0 ? lineOrder.length : at; };
      return line(a.entry) - line(b.entry) || (EXCEPTION_ORDER[a.entry.exceptionType] ?? 3) - (EXCEPTION_ORDER[b.entry.exceptionType] ?? 3) || a.index - b.index;
    })
    .map(({ entry }) => entry);

// An amount difference on the same line that the price difference alone
// explains: invoiced quantity × price difference, to half a cent. Approving
// the price difference approves it too, with the same note.
export const amountFollowingPrice = <E extends MatchExceptionView>(price: E, entries: E[], lines: MatchLineView[]): E | null => {
  if (price.exceptionType !== "price" || price.status !== "open" || !price.matchLineId) return null;
  const amount = entries.find((entry) => entry.exceptionType === "amount" && entry.status === "open" && entry.matchLineId === price.matchLineId);
  const line = lines.find((row) => row.id === price.matchLineId);
  if (!amount || !line) return null;
  const numbers = [line.invoiceQuantity, price.varianceValue, amount.varianceValue];
  if (numbers.some((value) => value === null || value === undefined || value === "" || !Number.isFinite(Number(value)))) return null;
  const [quantity, perUnit, overLine] = numbers.map(Number);
  return Math.abs(overLine - quantity * perUnit) < 0.005 ? amount : null;
};

// What the match card's status says: a match whose every difference was
// approved is resolved, also when it was matched before the server recorded
// that (variance_approved).
export const shownMatchStatus = (status: string, exceptions: Array<{ status: string }>) =>
  status === "exception" && exceptions.length > 0 && exceptions.every((entry) => entry.status === "approved") ? "variance_approved" : status;

const EXCEPTION_CHIPS: Record<string, { label: [string, string]; tone: StatusTone }> = {
  open: { label: ["To review", "待复核"], tone: "warning" },
  approved: { label: ["Approved", "已批准"], tone: "success" },
  rejected: { label: ["Rejected", "已驳回"], tone: "danger" },
};

// The three-way match of the bill: its status, one line on where the review
// stands (counted here, in the interface language; the server's stored
// sentence is not shown), and each line difference with its approve and
// reject actions.
function MatchCard({ invoice, onDone }: { invoice: any; onDone: () => void }) {
  const { t, language, locale, formatNumber } = useI18n();
  const say = (english: string, chinese: string) => (language === "en-US" ? english : chinese);
  const [followUpError, setFollowUpError] = useState("");
  const match = invoice.match;
  const lines: MatchLineView[] = match.lines || [];
  const invoiceLines: Array<{ id: string; sku?: string; unit?: string | null }> = invoice.lines || [];
  const exceptions = sortMatchExceptions<MatchExceptionView>(match.exceptions || [], lines.map((line) => line.id));
  const count = (status: string) => exceptions.filter((entry) => entry.status === status).length;
  const open = count("open");
  const rejected = count("rejected");
  const total = exceptions.length;
  // The server's stored sentence ("2 line-level match exception(s)") is read
  // for its count only, when the differences themselves are not listed.
  const recordedCount = Number(/^(\d+) line-level/.exec(String(match.blockingReason || ""))?.[1] || 0);
  const differences = (n: number) => (n === 1 ? "line difference" : "line differences");
  const summary = total
    ? open
      ? open === total
        ? say(`${total} ${differences(total)} to review.`, `${total} 处行差异待复核。`)
        : say(`${open} of ${total} line differences still to review.`, `${total} 处行差异中还有 ${open} 处待复核。`)
      : rejected
        ? say(`${rejected} ${differences(rejected)} rejected: this invoice cannot be approved. Cancel it, or ask the supplier for a corrected invoice.`, `${rejected} 处行差异已驳回：该发票不能批准。请取消发票，或请供应商重开发票。`)
        : say(`${total === 1 ? "The line difference is" : `All ${total} line differences are`} approved.`, `${total} 处行差异均已批准。`)
    : recordedCount
      ? say(`${recordedCount} ${differences(recordedCount)}.`, `${recordedCount} 处行差异。`)
      : "";
  const lineOf = (entry: MatchExceptionView) => {
    const matchLine = lines.find((row) => row.id === entry.matchLineId);
    return invoiceLines.find((row) => row.id === matchLine?.supplierInvoiceLineId) || null;
  };
  const value = (entry: MatchExceptionView, raw: string | null | undefined) => {
    if (raw === null || raw === undefined || raw === "" || !Number.isFinite(Number(raw))) return "—";
    if (entry.exceptionType === "quantity") {
      const unit = lineOf(entry)?.unit;
      return `${formatNumber(Number(raw))}${unit ? ` ${unitLabel(unit, language, Number(raw))}` : ""}`;
    }
    return money(raw, entry.currency || invoice.currency, locale);
  };
  const difference = (entry: MatchExceptionView) => {
    const raw = entry.varianceValue;
    if (raw === null || raw === undefined || raw === "" || !Number.isFinite(Number(raw)) || !Number(raw)) return "";
    const number = Number(raw);
    if (entry.exceptionType === "quantity") {
      const unit = lineOf(entry)?.unit;
      return `${number > 0 ? "+" : "−"}${formatNumber(Math.abs(number))}${unit ? ` ${unitLabel(unit, language, Math.abs(number))}` : ""}`;
    }
    const unit = entry.exceptionType === "price" ? lineOf(entry)?.unit : null;
    return `${signedMoney(number, entry.currency || invoice.currency, locale)}${unit ? `/${unitLabel(unit, language, 1)}` : ""}`;
  };
  // Amount differences that follow from an open price difference on their line.
  const following = new Map(exceptions.flatMap((entry) => {
    const amount = amountFollowingPrice(entry, exceptions, lines);
    return amount ? [[amount.id, entry] as const] : [];
  }));
  const reviewUrl = (entry: MatchExceptionView, step: "review" | "review-preview") => `/api/finance/match-exceptions/${encodeURIComponent(entry.id)}/${step}`;
  const reviewIssue = (code: string | undefined) =>
    code === "MATCH_EXCEPTION_RESOLUTION_REQUIRED" ? say("Enter why you accept or reject this difference.", "请填写处理说明。")
      : code === "MATCH_EXCEPTION_STATUS_INVALID" ? say("This difference was already reviewed. Reload the page.", "该差异已复核，请刷新页面。")
      : code === "FINANCE_VERSION_CONFLICT" ? say("This difference changed after the page opened. Reload the page.", "页面打开后该差异已有变化，请刷新页面。")
      : undefined;
  // After the price difference is approved: the amount difference it causes, with the same note.
  const approveFollowing = (amount: MatchExceptionView) => async (sent: Record<string, unknown>) => {
    setFollowUpError("");
    try {
      await apiJson(reviewUrl(amount, "review"), { method: "POST", body: JSON.stringify({ expectedVersion: amount.version, decision: "approved", resolution: sent.resolution, idempotencyKey: createSecureClientMutationId("p2p") }) });
    } catch (reason) {
      setFollowUpError(`${say("The amount difference was not approved; approve it below.", "金额差异未能一并批准，请在下方单独批准。")} ${procurementErrorText(reason, language, ["Try again in a moment.", "请稍后重试。"])}`);
    }
  };
  const shownStatus = shownMatchStatus(match.status, exceptions);
  return (
    <Card className="space-y-3 p-5" data-testid="supplier-invoice-match" id="supplier-invoice-match">
      <div className="flex items-center justify-between gap-2"><h3 className="font-semibold">{t("finance.threeWayMatch")}</h3><StatusChip status={shownStatus} /></div>
      {summary && <p className="text-sm text-slate-600" data-testid="supplier-invoice-match-summary">{summary}</p>}
      {followUpError && <Notice>{followUpError}</Notice>}
      {exceptions.map((entry) => {
        const chip = EXCEPTION_CHIPS[entry.status];
        const sku = invoiceLines.length > 1 ? lineOf(entry)?.sku : null;
        const amount = amountFollowingPrice(entry, exceptions, lines);
        const causedBy = following.get(entry.id) || null;
        const shownDifference = difference(entry);
        return (
          <div key={entry.id} className="space-y-2 rounded-xl bg-slate-50 p-3 text-sm" data-testid="match-exception" data-type={entry.exceptionType}>
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="font-medium">{sku ? `${sku} · ` : ""}{matchExceptionLabel(entry.exceptionType, language)}</div>
                <div className="text-xs text-slate-600 tabular-nums" data-testid="match-exception-values">
                  {say("Expected", "应为")} {value(entry, entry.expectedValue)} · {say("Invoiced", "发票")} {value(entry, entry.actualValue)}
                  {shownDifference && <> · {say("Difference", "差额")} {shownDifference}</>}
                </div>
              </div>
              {chip ? <ToneChip label={say(...chip.label)} tone={chip.tone} /> : <StatusChip status={entry.status} />}
            </div>
            {entry.resolution && <div className="text-xs text-slate-500">{entry.resolution}</div>}
            {entry.status === "open" && causedBy && (
              <div className="text-xs text-slate-600" data-testid="match-exception-follows-price">{say("Caused by the price difference above: approving the price difference accepts it too.", "由上方的价格差异造成：批准价格差异时会一并接受。")}</div>
            )}
            {entry.status === "open" && !causedBy && (
              <div className="flex flex-wrap gap-2">
                <TwoStepAction
                  label={say("Approve difference", "批准差异")}
                  testId={`exception-approve-${entry.id}`}
                  previewUrl={reviewUrl(entry, "review-preview")}
                  runUrl={reviewUrl(entry, "review")}
                  payload={() => ({ expectedVersion: entry.version, decision: "approved" })}
                  reasonLabel={say("Resolution", "处理说明")}
                  reasonRequired={say("Enter why you accept this difference.", "请填写处理说明。")}
                  note={amount ? say("Approving the price difference also accepts the amount difference it causes.", "批准价格差异，也会一并接受由它造成的金额差异。") : undefined}
                  afterRun={amount ? approveFollowing(amount) : undefined}
                  issueText={reviewIssue}
                  onDone={onDone}
                />
                <TwoStepAction
                  label={say("Reject difference", "驳回差异")}
                  testId={`exception-reject-${entry.id}`}
                  tone="secondary"
                  previewUrl={reviewUrl(entry, "review-preview")}
                  runUrl={reviewUrl(entry, "review")}
                  payload={() => ({ expectedVersion: entry.version, decision: "rejected" })}
                  reasonLabel={say("Resolution", "处理说明")}
                  reasonRequired={say("Enter why you reject this difference.", "请填写处理说明。")}
                  issueText={reviewIssue}
                  onDone={onDone}
                />
              </div>
            )}
          </div>
        );
      })}
    </Card>
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
  const { t, locale, language, formatNumber } = useI18n();
  const say = (english: string, chinese: string) => (language === "en-US" ? english : chinese);
  const id = decodeURIComponent(window.location.pathname.split("/").filter(Boolean).at(-1) || "");
  // Opened from the payables list (?returnTo=/app/finance/payables…): the
  // back link returns there, with its filters.
  const returnTo = new URLSearchParams(window.location.search).get("returnTo") || "";
  const fromPayables = /^\/app\/finance\/payables(?:[?/]|$)/.test(returnTo);
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
  useDetailCrumb(data?.invoiceNumber);
  if (failure && !data) {
    const testId = { notFound: "supplier-invoice-not-found", unauthenticated: "supplier-invoice-unauthenticated", forbidden: "supplier-invoice-forbidden", error: "supplier-invoice-read-error" }[failure];
    const text = { notFound: t("finance.billNotFound"), unauthenticated: t("finance.billSignedOut"), forbidden: t("finance.billForbidden"), error: t("finance.billReadError") }[failure];
    return (
      <div className="space-y-3">
      <BackToListLink list="bills" />
      <Card className="py-16 text-center" data-testid={testId}>
        <div className="text-sm font-semibold">{text}</div>
        <div className="mt-2 text-xs text-slate-500">{id}</div>
        {failure === "error" && <button type="button" onClick={load} className="mt-3 text-sm font-semibold text-blue-600">{t("finance.retry")}</button>}
      </Card>
      </div>
    );
  }
  if (!data) return <Card className="p-6">{t("common.loading")}</Card>;
  const base = `/api/finance/supplier-invoices/${encodeURIComponent(data.id)}`;
  const actions: string[] = Array.isArray(data.availableActions) ? data.availableActions : [];
  const version = { expectedVersion: data.version };
  const exceptions: Array<{ status: string }> = data.match?.exceptions || [];
  const payable = data.payable;
  const payableActions: string[] = Array.isArray(payable?.availableActions) ? payable.availableActions : [];
  // An invoice in exception differs from its PO or receipt: the reason is shown
  // first and Approve, which accepts the difference, is not the main button.
  // With the match readable, that is while a difference is open or rejected;
  // once every difference is approved, approving the invoice is the next step.
  const inException = data.match
    ? exceptions.some((entry) => entry.status === "open" || entry.status === "rejected")
    : data.status === "exception";
  // Paid in part or in full: said on the invoice too, not only on its payable.
  const shownStatus = payable && ["settled", "partially_settled"].includes(payable.status) ? payable.status : data.status;
  // When the invoice has no step of its own left, the payable's is the next one.
  const invoiceSteps = actions.filter((action) => !["link_receipt", "revise", "dismiss_duplicate"].includes(action)).length;
  const nextOnPayable = payableActions.includes("record_payment")
    ? say("Next: record the payment", "下一步：登记付款")
    : payableActions.includes("release")
      ? say("Next: release the hold, then record the payment", "下一步：解除暂停后登记付款")
      : payableActions.length
        ? say("Next: see the payable below", "下一步：查看下方应付款")
        : "";
  return (
    <div className="space-y-4" data-testid="supplier-invoice-detail">
      {fromPayables
        ? <Link to={returnTo} data-testid="back-to-payables" className="inline-flex items-center gap-1 text-xs font-medium text-blue-600 hover:underline"><ArrowLeft size={13} />{say("Back to payables", "返回应付款")}</Link>
        : <BackToListLink list="bills" />}
      {error && <Notice>{error}</Notice>}
      <Card className="p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="fc-page-title" style={{ color: A.label }}>{data.invoiceNumber}</h1>
            <p className="mt-1 text-sm text-slate-500" data-testid="supplier-invoice-sources">
              {data.supplierName || "—"}
              {" · "}{t("finance.purchaseOrder")} {data.relatedPoId ? <BusinessEntityLink entityType="purchase_order" entityId={data.relatedPoId} number={data.relatedPoNumber || data.poNumber} /> : "—"}
              {" · "}{t("finance.receipt")} {data.relatedGrnId ? <BusinessEntityLink entityType="receiving_doc" entityId={data.relatedGrnId}>{data.relatedGrnNumber || data.relatedGrnId}</BusinessEntityLink> : data.awaitingReceipt ? <span className="font-medium text-amber-700">{t("finance.awaitingReceipt")}</span> : "—"}
              {data.relatedPoId && <>{" · "}<BusinessEntityLink entityType="three_way_match" entityId={`MATCH-${data.id}`}>{t("finance.threeWayMatch")}</BusinessEntityLink></>}
            </p>
            <dl className="mt-3 flex flex-wrap gap-x-6 gap-y-2 text-sm" data-testid="supplier-invoice-facts">
              <div><dt className="text-xs text-slate-500">{t("finance.invoiceDate")}</dt><dd className="font-medium tabular-nums" data-testid="supplier-invoice-date">{formatCalendarDay(data.invoiceDate, locale)}</dd></div>
              <div><dt className="text-xs text-slate-500">{t("finance.dueDate")}</dt><dd className="font-medium tabular-nums" data-testid="supplier-invoice-due-date">{formatCalendarDay(data.dueDate, locale)}</dd></div>
              <div><dt className="text-xs text-slate-500">{t("finance.currency")}</dt><dd className="font-medium" data-testid="supplier-invoice-currency-fact">{data.currency || "—"}</dd></div>
            </dl>
          </div>
          <div className="text-right">
            <strong>{money(data.totalAmount, data.currency, locale)}</strong>
            <div className="mt-1" data-testid="supplier-invoice-status"><StatusChip status={shownStatus} /></div>
          </div>
        </div>
        {inException && <VarianceReason invoice={data} />}
        {data.awaitingReceipt && (
          <div className="mt-4 space-y-2" data-testid="supplier-invoice-awaiting-receipt">
            <Notice>{t("finance.awaitingReceiptNote")}</Notice>
            {actions.includes("link_receipt") && <LinkReceipt invoice={data} onDone={load} />}
          </div>
        )}
        <div className="mt-4 flex flex-wrap gap-2" data-testid="supplier-invoice-actions">
          {actions.includes("submit") && <TwoStepAction label={t("finance.action.submit")} testId="invoice-submit" oneStep previewUrl={`${base}/submit-preview`} runUrl={`${base}/submit`} payload={() => version} onDone={load} />}
          {actions.includes("match") && <TwoStepAction label={t("finance.action.match")} testId="invoice-match" oneStep previewUrl={`${base}/match-preview`} runUrl={`${base}/match`} payload={() => version} onDone={load} />}
          {actions.includes("approve") && <TwoStepAction label={t("finance.action.approve")} testId="invoice-approve" tone={inException ? "secondary" : "primary"} oneStep previewUrl={`${base}/approve-preview`} runUrl={`${base}/approve`} payload={() => version} issueText={duplicateIssueText(t)} issueDetail={(issue) => <DuplicateApprovalDetail issue={issue} />} onDone={load} />}
          {actions.includes("cancel") && <TwoStepAction label={t("finance.action.cancel")} testId="invoice-cancel" tone="secondary" previewUrl={`${base}/cancel-preview`} runUrl={`${base}/cancel`} payload={() => version} reasonLabel={t("finance.cancelReason")} onDone={load} />}
          {!invoiceSteps && (nextOnPayable
            ? <a href="#supplier-invoice-payable" onClick={scrollToCard("supplier-invoice-payable")} className="text-sm font-semibold text-blue-600 hover:underline" data-testid="supplier-invoice-next">{nextOnPayable}</a>
            : <span className="text-xs text-slate-500" data-testid="supplier-invoice-no-actions">{payable?.status === "settled" ? say("Paid in full. Nothing else to do.", "已全额付款，无需其他操作。") : t("finance.noActions")}</span>)}
        </div>
      </Card>

      {data.duplicateChecks && <DuplicateChecks invoice={data} checks={data.duplicateChecks} canDismiss={actions.includes("dismiss_duplicate")} onDone={load} />}

      <Card className="p-5">
        <h3 className="mb-3 font-semibold">{t("finance.lines")}</h3>
        {/* Phones show each line as a card (listTableCardsRef): the item first. */}
        <div className="overflow-x-auto" ref={listTableCardsRef}>
          <table className="w-full min-w-[640px] text-sm" data-testid="supplier-invoice-lines-table">
            <thead><tr className="border-b text-left text-xs text-slate-500"><th className="py-2 pr-3" data-card-title="">{say("Item", "物料")}</th><th className="py-2 pr-3">{t("finance.quantity")}</th><th className="py-2 pr-3">{t("finance.unitPrice")}</th><th className="py-2 pr-3">{t("finance.tax")}</th><th className="py-2">{t("finance.amount")}</th></tr></thead>
            <tbody>
              {(data.lines || []).map((line: any) => {
                const quantity = Number.isFinite(Number(line.quantity)) && line.quantity !== null && line.quantity !== "" ? Number(line.quantity) : null;
                return (
                  <tr key={line.id} className="border-b border-slate-50">
                    <td className="py-2 pr-3">{line.sku} · {line.itemName}</td>
                    <td className="py-2 pr-3 tabular-nums">{quantity === null ? "—" : `${formatNumber(quantity)}${line.unit ? ` ${unitLabel(line.unit, language, quantity)}` : ""}`}</td>
                    <td className="py-2 pr-3 tabular-nums">{money(line.unitPrice, data.currency, locale)}</td>
                    <td className="py-2 pr-3 tabular-nums">{money(line.enteredTaxAmount, data.currency, locale)}</td>
                    <td className="py-2 tabular-nums">{money(line.totalAmount, data.currency, locale)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>

      {data.match && <MatchCard invoice={data} onDone={load} />}

      {payable && (
        <Card className="space-y-3 p-5" data-testid="supplier-invoice-payable" id="supplier-invoice-payable">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="font-semibold">{t("finance.payables")} · {payable.obligationNumber || payable.id}</h3>
            {/* The payable's total stays here; what is paid and still owed is under it. */}
            <div className="flex items-center gap-2" data-testid="supplier-invoice-payable-total"><strong>{money(payable.originalAmount ?? data.totalAmount, payable.currency, locale)}</strong><StatusChip status={payable.status} /></div>
          </div>
          <PaymentRecords kind="payable" obligation={payable} onDone={load} />
          <div className="flex flex-wrap gap-2">
            {payableActions.filter((action) => action !== "record_payment").map((action) => (
              <TwoStepAction
                key={action}
                label={t(action === "hold" ? "finance.action.hold" : action === "release" ? "finance.action.release" : "finance.action.mark_export_ready")}
                testId={`payable-${action}`}
                // Recording the payment is the main step; releasing a hold leads to it.
                tone={action === "release" ? "primary" : "secondary"}
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
