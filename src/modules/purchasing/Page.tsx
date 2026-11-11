import { invoiceVarianceCode, invoiceVarianceLabelKey, isNoInvoiceVariance } from "../../domain/procurement/variance-types";
import { useWorkspaceCopy } from "../../i18n/useWorkspaceCopy";
import { useI18n } from "../../i18n/I18n";
import { unitLabel } from "../../i18n/unitLabels";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router";
import { toast } from "sonner";
import {
  AlertCircle,
  CheckCircle2,
  ClipboardCheck,
  FileText,
  PackageCheck,
  ShieldCheck,
  Truck,
} from "lucide-react";
import { ApiError, apiJson } from "../../lib/api-client";
import { useRouteAvailability } from "../../app/routeAvailability";
import { exportRowsToCsv } from "../../lib/data-export";
import { BusinessEntityLink } from "../../components/business/BusinessEntityLink";
import { formatCalendarDay, formatCurrencyAmount, instantDayInTimeZone, todayInTimeZone } from "../../lib/format";
import { typography } from "../../components/ui/typography";
import { usePriceHistoryCopy } from "../procurement/priceHistoryCopy";
import { PriceHistoryFacts, priceHistoryKey, usePriceHistory } from "../procurement/PriceHistoryFacts";
import { useWarehouseNames } from "../../lib/useWarehouseNames";
import { documentNumberFor, rememberDocumentNumbers, resolveDocumentNumbers, useDocumentNumber } from "../../lib/documentNumbers";
import { useDetailCrumb } from "../../components/navigation/detailCrumb";
import { SupplierOverrideFlag } from "../../components/procurement/SupplierOverrideReason";
import type { PurchaseOrder, PurchaseOrderLine, ReceivingDoc, SupplierInvoice } from "../../types/scm";
import {
  A,
  Card,
  Chip,
  DocumentHistoryPanel,
  Field,
  inputStyle,
  RecoveryActions,
  SectionHeader,
} from "../../components/ui";
import { ActionableMetricCard } from "../../components/cards/ActionableMetricCard";
import {
  DocumentShell,
  DocumentTotals,
  type TimelineStep,
} from "../../components/document/DocumentShell";
import { calculateInvoiceMatch } from "../../domain/procurement/invoice-matching";
import { poDelayedRisk } from "../../domain/contextual-ai";
import { grnLinesOf } from "../../domain/receiving/helpers";
import { lineRemaining, lineStatusLabel, poLinesOf, poTotals, toNumber } from "../../domain/purchasing/helpers";
import type { WorkflowContext } from "../../lib/workflowContext";
import type { ActiveContext } from "../ai-assistant/Panel";
import {
  defaultPurchaseOrderWorkbenchFilters,
  filterPurchaseOrdersForWorkbench,
  purchaseOrderStatusCode,
  purchaseOrderStatusFilterOptions,
  type PurchaseOrderWorkbenchFilters,
} from "./filters";
import { POStatusPill, poStatusToneOf } from "./components/POStatusPill";
import { ListPager, usePagedRows } from "../procurement/listPaging";

const PO_LIST_PAGE_SIZE = 50;
import {
  tableLinkClass,
  tableScrollClass,
  tdActionClass,
  tdIdClass,
  tdNameClass,
  tdNowrapClass,
  tdNumericRightClass,
  thClass,
  thRightClass,
  tableBodyTextClass,
  listTableCardsRef,
} from "../../components/ui/workbenchTable";
import { workspaceCopy } from "../../i18n/workspaceCopy";
import { ExportButton, ListCard, ListSearchCard, ListStateRow, RefreshButton, ResetButton, RowMenu, StatusChip, metricGridClass, listHeadRowStyle, listRowClass, listRowStyle, rowActionClass, statusToneOf, type StatusTone } from "../../components/ui/listLayout";
import { BackToListLink } from "../procurement/BackToListLink";
import { procurementErrorCode, procurementErrorText } from "../procurement/procurementErrors";
import { BILLABLE_PO_STATUSES, PurchaseOrderReceiveAction, PurchaseOrderWorkflowActions, poSecondaryButtonClass, receiveOrderPath, recordBillPath, usePurchaseOrderActionNotes, usePurchaseOrderEntryRules } from "./components/PurchaseOrderWorkflowActions";
import { RecordBillAction } from "../../components/business/BillingEntryActions";
import { PurchaseOrderPromiseDates } from "./components/PurchaseOrderPromiseDates";
import { statusCodeLabel } from "../../i18n/statusLabels";
import {
  invoiceVarianceState,
  isCancelledInvoice,
  nextActionText,
  nextOpenAction,
  paymentAmountsText,
  paymentStateLabel,
  paymentSummary,
  type NextAction,
  type StoryExceptions,
  type StoryInvoice,
  type StoryLine,
  type StoryPayment,
  type StoryWords,
  type VarianceState,
} from "./components/purchaseOrderStory";

// The words this page adds to the shared workspace copy, in English: the
// receipt, invoice and match states of an order and the next steps before it
// is issued. Each state has one name, the one the order's own status uses
// (全部收货 / Fully received, as the "fully_received" status reads).
const PAGE_ENGLISH: Record<string, string> = {
  "尚无可匹配": "Nothing to match yet",
  "无需匹配": "No match needed",
  "等待审批": "Awaiting approval",
  "提交审批": "Submit it for approval",
  "订单已驳回，修改后重新提交": "Rejected; revise it and submit again",
  "全部收货": "Fully received",
  "部分开票": "Partly invoiced",
  "差异已批准": "Variance approved",
  "差异已驳回": "Variance rejected",
  "付款": "Payment",
};
const pageCopy = (label: string, language: string) => (language === "en-US" && PAGE_ENGLISH[label]) || workspaceCopy(label, language);
function usePageCopy() {
  const { language } = useI18n();
  return (label: string) => pageCopy(label, language);
}
// Statuses a PO reaches once issued (or received), with the legacy labels older rows carry.
const ISSUED_PO_STATUSES = new Set(["issued", "partially_received", "fully_received", "closed", "已发出", "部分到货", "已完成"]);

type PurchaseOrderViewMode = "list" | "detail";
type NavigateFn = (moduleId: string, focusTarget?: { entityType: string; entityId: string } | null, options?: { returnTo?: string; entityLabel?: string; returnContext?: WorkflowContext | null; source?: string }) => void;
type PurchaseOrderWorkbenchPayload = {
  purchaseOrders: PurchaseOrder[];
  receivingDocs: ReceivingDoc[];
  supplierInvoices: SupplierInvoice[];
  documentLinks: Array<Record<string, unknown>>;
  procurementFollowups: Array<Record<string, unknown>>;
  summary?: PurchaseOrderWorkbenchSummary;
};
// One order for the detail view (GET /api/purchase-orders-workbench/:id): the
// same records as the workbench, only those of this order.
type PurchaseOrderDetailPayload = Omit<PurchaseOrderWorkbenchPayload, "purchaseOrders" | "summary"> & {
  purchaseOrder: PurchaseOrder;
};
// Header figures from the server, using the report definitions of committed
// and open purchase orders. Committed value is one total per currency.
type PurchaseOrderWorkbenchSummary = {
  committedOrderCount: number;
  // Null when the role cannot read prices.
  committedValueByCurrency: Array<{ currency: string; amount: number; orderCount: number }> | null;
  openOrderCount: number;
  openPurchaseOrderIds: string[];
};
type ProcurementRuntimeFacts = {
  receivingDocs: ReceivingDoc[];
  supplierInvoices: SupplierInvoice[];
};

type PoEvidenceRow = {
  currency?: string;
  poLineId: string;
  // The line's position on the PO, shown instead of its internal id.
  lineNumber: number;
  sourcePrLine: string;
  sourceRfqLine: string;
  sku: string;
  itemName: string;
  quantity: number;
  unit: string;
  unitPrice: number;
  lineAmount: number;
  warehouse: string;
  requiredDate: string;
  promisedDate: string;
  receivedQty: number;
  remainingQty: number;
  invoicedQty: number;
  uninvoicedQty: number;
  status: string;
  risk: string;
  supplierOverride?: PurchaseOrderLine["supplierOverride"];
};

type GrnEvidenceRow = {
  grn: string;
  // The GRN number people read (GRN-202611-0008); grn is the receipt's id.
  receiptNumber: string;
  // The receipt's state as a status code: posted, reversed, cancelled or its workflow status.
  receiptStatus: string;
  grnLineId: string;
  // The line's position on its receipt, shown instead of its id.
  grnLineNumber: number;
  po: string;
  poLineId: string;
  supplier: string;
  sku: string;
  // Accepted into stock; the rejected quantity is shown beside it.
  acceptedQty: number;
  rejectedQty: number;
  // The reason recorded on the receipt line for the rejected quantity, as entered.
  rejectionReason: string;
  unit: string;
  arrived: string;
  receiver: string;
  unitPrice: number;
  // The accepted quantity at the PO price, to the cent.
  lineAmount: number;
  status: string;
  qcStatus: string;
  // The invoice lines that name this receipt line; none when it is not invoiced yet.
  invoiceLineIds: string[];
};

type InvoiceEvidenceRow = {
  currency?: string;
  // The invoice's id (links and calls) and the number people read.
  invoiceNumber: string;
  displayNumber: string;
  invoiceLineId: string;
  // The line's position on its invoice, shown instead of its id.
  invoiceLineNumber: number;
  supplier: string;
  po: string;
  poLineId: string;
  // The receipt line the invoice line names, "" when it names none.
  grnLineId: string;
  sku: string;
  quantity: number;
  unit: string;
  unitPrice: number;
  invoiceAmount: number;
  taxAmount: number;
  totalAmount: number;
  invoiceDate: string;
  dueDate: string;
  // The invoice's match state in the page's words (已匹配, 差异已批准, 价格差异 …).
  matchState: string;
  varianceType: string;
  varianceAmount: number;
  hasVariance: boolean;
  payment: StoryPayment | null;
  risk: string;
};

// One PO line against everything invoiced on it. Amounts are net of tax.
type MatchEvidenceRow = {
  poLineId: string;
  grnLineId: string;
  invoiceLineId: string;
  // The receipts and supplier invoices on this PO line (ids), in the order read.
  receiptIds: string[];
  invoiceIds: string[];
  // Invoice lines on this PO line beyond the first.
  moreInvoiceLines: number;
  poQty: number;
  receivedQty: number;
  invoiceQty: number;
  poUnitPrice: number;
  invoiceUnitPrice: number;
  // The invoiced quantity at the PO unit price.
  expectedAmount: number;
  invoiceAmount: number;
  taxAmount: number;
  // Invoiced beyond what was received (accepted); 0 when within it.
  qtyVariance: number;
  // (Invoice unit price - PO unit price) x invoiced quantity.
  priceVariance: number;
  // Invoiced amount - expected amount.
  amountVariance: number;
  // Ordered but not received yet: shown for information, never a variance.
  receivingGap: number;
  // Received but not invoiced yet: not a variance either.
  invoiceGap: number;
  status: string;
  // What to do about it, English first with its Chinese translation.
  suggestedAction: [string, string];
};

// The receipt, invoice, match and risk states this page derives, in the brand
// tones: gray not started, blue under way, teal done, orange waiting on
// someone or at risk, red for a variance or exception.
const EVIDENCE_TONES: Record<string, StatusTone> = {
  "未收货": "neutral", "待收货": "neutral", "部分收货": "info", "部分到货": "info", "已收货": "success", "全部收货": "success", "异常处理": "danger",
  "未开票": "neutral", "部分开票": "info", "已开票": "info", "已付款": "success", "发票差异": "danger",
  "缺少发票": "neutral", "缺少收货": "warning", "已匹配": "success", "差异已批准": "success", "差异已驳回": "danger", "待匹配": "neutral",
  "需人工复核": "warning", "已收未票": "warning", "已票未收": "warning",
  "低风险": "success", "无需收货": "neutral", "通过": "success", "质检中": "info", "质检异常": "danger",
  "尚无可匹配": "neutral", "无需匹配": "neutral", "已取消": "neutral",
};

function evidenceTone(status: string): StatusTone {
  return EVIDENCE_TONES[status] ?? (/差异/.test(status) ? "danger" : /风险/.test(status) ? "warning" : statusToneOf(status));
}

// A derived state as a chip, in the interface language of this render.
function EvidenceChip({ status }: { status: string }) {
  const copy = usePageCopy();
  return <StatusChip label={copy(status)} tone={evidenceTone(status)} />;
}
function statusChip(status: string) {
  return <EvidenceChip status={status} />;
}

// Copy written on this page: English first, with its Chinese translation.
type Say = (en: string, zh: string) => string;
function useSay(): Say {
  const { language } = useI18n();
  return (en, zh) => (language === "en-US" ? en : zh);
}

// A stored calendar day ("2026-12-01", or UTC midnight) as that day in the
// workspace locale ("Dec 1, 2026"), the format the promised dates use. Other
// text, such as a "missing" label, is returned as it is.
const CALENDAR_DAY = /^\d{4}-\d{2}-\d{2}(?:T00:00:00(?:\.000)?Z)?$/;
function useCalendarDay() {
  const { locale } = useI18n();
  return (value?: string | null) => {
    const text = String(value ?? "").trim();
    return CALENDAR_DAY.test(text) ? formatCalendarDay(text, locale) : text;
  };
}

// A line's internal id (a UUID, or LOCAL-DEMO-PO-001-LINE-001) means nothing
// to a person, so a line is named by its position on its document ("Line 1");
// the id stays in the tooltip for support.
function useLineName() {
  const say = useSay();
  return (position: number) => say(`Line ${position}`, `第 ${position} 行`);
}

// The order's lines as one table, a row per line: what was ordered, received
// and invoiced, the price, the date expected and one status. A line's earlier
// prices sit under its name; its source request or RFQ only when it has one.
// Below 640 px the shared phone layout turns each row into a card.
// A second chip only when the line needs attention beyond its status: billed
// before receipt, or received and not yet billed.
const LINE_ATTENTION_RISKS = new Set(["已票未收风险", "已收未票风险"]);
function PurchaseOrderLineCards({ rows, currency, priceHistory }: { rows: PoEvidenceRow[]; currency?: string; priceHistory?: (poLineId: string) => React.ReactNode }) {
  const copy = useWorkspaceCopy();
  const say = useSay();
  const day = useCalendarDay();
  const lineName = useLineName();
  const { formatNumber, language } = useI18n();
  if (!rows.length) {
    return <Card className="p-8 text-center text-xs" style={{ color: A.gray2 }}>{copy("当前采购订单没有明细行。")}</Card>;
  }
  // The warehouse shows per line only when the lines go to different places.
  const warehouses = new Set(rows.map((line) => line.warehouse).filter(Boolean));
  const qty = (value: number, unit: string) => `${formatNumber(value)} ${unitLabel(unit, language, value)}`;
  const source = (line: PoEvidenceRow) => [
    line.sourcePrLine && line.sourcePrLine !== "无采购申请" ? `${say("From", "来自")} ${line.sourcePrLine}` : "",
    line.sourceRfqLine && line.sourceRfqLine !== "未经询价" ? `${say("Quoted in", "询价")} ${line.sourceRfqLine}` : "",
  ].filter(Boolean).join(" · ");
  const headers = [
    [say("Line", "行"), "left"], [say("Item", "物料"), "left"], [say("Ordered", "订购"), "right"], [say("Received", "已收"), "right"],
    [say("Invoiced", "已开票"), "right"], [say("Unit price", "单价"), "right"], [say("Amount", "金额"), "right"], [say("Expected", "预计到货"), "left"], [say("Status", "状态"), "left"],
  ] as const;
  return (
    <Card className="overflow-hidden p-0">
      <div className={tableScrollClass} data-testid="po-line-cards" ref={listTableCardsRef}>
        <table className={`w-full min-w-[960px] ${tableBodyTextClass}`}>
          <thead><tr>{headers.map(([label, align]) => <th key={label} className={align === "right" ? thRightClass : thClass}>{label}</th>)}</tr></thead>
          <tbody>
            {rows.map((line) => {
              const fmt = (value: number) => formatCurrencyAmount(value, line.currency || currency);
              const from = source(line);
              return (
                <tr key={line.poLineId} className="border-t border-slate-100 align-top">
                  <td className={tdNowrapClass}><span className="font-semibold tabular-nums" style={{ color: A.blue }} title={line.poLineId} data-testid="po-line-name">{lineName(line.lineNumber)}</span></td>
                  <td className="min-w-[240px] max-w-[380px] px-4 py-3">
                    <div className="font-semibold" style={{ color: A.label }}>{line.sku} · {line.itemName}</div>
                    {line.supplierOverride ? <div className="mt-1"><SupplierOverrideFlag override={line.supplierOverride} testId="po-line-supplier-override" /></div> : null}
                    {from ? <div className="mt-0.5 text-[11px]" style={{ color: A.sub }}>{from}</div> : null}
                    {warehouses.size > 1 && line.warehouse ? <div className="mt-0.5 text-[11px]" style={{ color: A.sub }}>{say("To", "送至")} {line.warehouse}</div> : null}
                    {priceHistory?.(line.poLineId)}
                  </td>
                  <td className={tdNumericRightClass}>{qty(line.quantity, line.unit)}</td>
                  <td className={tdNumericRightClass}>
                    <div>{qty(line.receivedQty, line.unit)}</div>
                    {line.remainingQty > 0 && line.receivedQty > 0 ? <div className="text-[11px]" style={{ color: A.sub }}>{say(`${formatNumber(line.remainingQty)} to come`, `还差 ${formatNumber(line.remainingQty)}`)}</div> : null}
                  </td>
                  <td className={tdNumericRightClass}>{qty(line.invoicedQty, line.unit)}</td>
                  <td className={tdNumericRightClass}>{fmt(line.unitPrice)}</td>
                  <td className={`${tdNumericRightClass} font-semibold`}>{fmt(line.lineAmount)}</td>
                  <td className={tdNowrapClass}>
                    <div>{day(line.promisedDate)}</div>
                    {line.requiredDate && line.requiredDate !== line.promisedDate ? <div className="text-[11px]" style={{ color: A.sub }}>{say("Needed", "需求")} {day(line.requiredDate)}</div> : null}
                  </td>
                  <td className={tdNowrapClass}>
                    <div className="flex flex-col items-start gap-1">
                      {statusChip(line.status)}
                      {LINE_ATTENTION_RISKS.has(line.risk) ? <StatusChip label={copy(line.risk)} tone={evidenceTone(line.risk)} /> : null}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function safeText(value: unknown, fallback = "待补齐") {
  const text = String(value ?? "").trim();
  return text || fallback;
}

// Null when the role cannot see prices or the order has no amount, so the
// page shows a dash rather than $0.00.
const amountsHidden = (record?: { restrictedFields?: string[] } | null) => Boolean(record?.restrictedFields?.includes("amounts"));
const amountOrNull = (value: unknown) => (value === null || value === undefined || value === "" ? null : Number(value));

function poAmount(po?: PurchaseOrder | null): number | null {
  if (!po || amountsHidden(po)) return null;
  const totals = poTotals(po);
  return amountOrNull(po.totalAmount || totals.totalAmount || po.amount);
}

function poLineAmount(line: { quantityOrdered?: number; unitPrice?: number }, po?: PurchaseOrder | null) {
  const direct = toNumber(line.quantityOrdered) * toNumber(line.unitPrice);
  if (direct > 0) return direct;
  const lines = poLinesOf(po);
  const totalQty = lines.reduce((sum, item) => sum + toNumber(item.quantityOrdered), 0);
  const total = poAmount(po) ?? 0;
  return totalQty ? Math.round(total * (toNumber(line.quantityOrdered) / totalQty)) : total;
}

function unitPriceForLine(line: { quantityOrdered?: number; unitPrice?: number; poLineId?: string }, po: PurchaseOrder | null | undefined, facts: ProcurementRuntimeFacts) {
  const direct = toNumber(line.unitPrice);
  if (direct > 0) return direct;
  const invoiceLine = facts.supplierInvoices.flatMap(invoiceLinesOf)
    .find((item) => item.poLine === line.poLineId);
  if (invoiceLine?.unitPrice) return toNumber(invoiceLine.unitPrice);
  const qty = toNumber(line.quantityOrdered);
  return qty ? poLineAmount(line, po) / qty : 0;
}

const invoiceLinesOf = (invoice: SupplierInvoice) => (Array.isArray(invoice.lines) ? invoice.lines : []);

// What the PO detail read adds to a supplier invoice
// (purchaseOrderInvoiceProgress in server/repositories/db-procurement-read-repository.mjs),
// with the supplier's own invoice number the read model carries.
type PoInvoice = SupplierInvoice & {
  supplierInvoiceNumber?: string;
  workflowStatus?: string;
  // The quantity invoiced on each PO line, for the list, whose read has no invoice lines.
  poLineQuantities?: Record<string, number>;
  matchExceptions?: StoryExceptions | null;
  payment?: StoryPayment | null;
};
const poInvoice = (invoice: SupplierInvoice) => invoice as PoInvoice;
// The number people read: the supplier's invoice number, else the record's id.
const invoiceNumberOf = (invoice: SupplierInvoice) => poInvoice(invoice).supplierInvoiceNumber || invoice.invoiceNumber;

// Every supplier invoice of the order, cancelled ones too (the invoice table lists them).
function invoicesForPo(poId: string | undefined, facts: ProcurementRuntimeFacts) {
  return facts.supplierInvoices.filter((invoice) => invoice.relatedPo === poId);
}

// The match statuses that say an invoice has a variance.
const VARIANCE_MATCH_STATUSES = new Set(["差异待处理", "exception", "variance"]);
function storyInvoice(invoice: SupplierInvoice): StoryInvoice {
  const extras = poInvoice(invoice);
  return {
    workflowStatus: extras.workflowStatus,
    status: String(invoice.status || ""),
    matchStatus: String(invoice.matchStatus || ""),
    hasVariance: !isNoInvoiceVariance(invoice.varianceType) || Math.abs(toNumber(invoice.varianceAmount)) >= 0.005 || VARIANCE_MATCH_STATUSES.has(String(invoice.matchStatus || "")),
    quantityVariance: invoiceVarianceCode(invoice.varianceType) === "quantity_variance" || invoiceLinesOf(invoice).some((line) => invoiceVarianceCode(line.varianceType) === "quantity_variance"),
    matchExceptions: extras.matchExceptions ?? null,
    // null: read, no payable; undefined: the read does not say (the PO list).
    payment: extras.payment,
    paid: Boolean(invoice.paid),
  };
}
const varianceStateOf = (invoice: SupplierInvoice): VarianceState => invoiceVarianceState(storyInvoice(invoice));

// The invoices that count: a cancelled one is no longer matched or owed.
function activeInvoicesForPo(poId: string | undefined, facts: ProcurementRuntimeFacts) {
  return invoicesForPo(poId, facts).filter((invoice) => !isCancelledInvoice(storyInvoice(invoice)));
}
// Whether the read says what each invoice bills on each PO line: its lines,
// or on the PO list (whose read leaves the lines out) the quantities by line.
const invoiceLinesRead = (invoices: SupplierInvoice[]) => invoices.every((invoice) => Array.isArray(invoice.lines) || Boolean(poInvoice(invoice).poLineQuantities));

// An invoice line counts on the PO line it names; one that names none counts
// on the PO line with its SKU when only one has it, else on the only line of
// a single-line PO.
function invoiceLineOnPoLine(invoiceLine: { poLine?: string; sku?: string }, line: { poLineId: string; sku?: string }, lines: Array<{ poLineId: string; sku?: string }>) {
  if (invoiceLine.poLine) return invoiceLine.poLine === line.poLineId;
  const bySku = lines.filter((candidate) => candidate.sku && candidate.sku === invoiceLine.sku);
  return bySku.length === 1 ? bySku[0].poLineId === line.poLineId : lines.length === 1;
}

// The order's lines for its story: ordered, received (accepted) and invoiced
// on its active supplier invoices.
function storyLines(po: PurchaseOrder, facts: ProcurementRuntimeFacts): StoryLine[] {
  const lines = poLinesOf(po);
  const invoices = activeInvoicesForPo(po.po, facts);
  const invoiceLines = invoices.flatMap(invoiceLinesOf);
  // On the PO list the invoices come without lines, with their quantities by PO line.
  const listQuantities = invoices.filter((invoice) => !Array.isArray(invoice.lines)).map((invoice) => poInvoice(invoice).poLineQuantities || {});
  return lines.map((line) => ({
    ordered: toNumber(line.quantityOrdered),
    accepted: toNumber(line.quantityReceived),
    invoiced: invoiceLines.filter((invoiceLine) => invoiceLineOnPoLine(invoiceLine, line, lines)).reduce((sum, invoiceLine) => sum + toNumber(invoiceLine.quantity), 0)
      + listQuantities.reduce((sum, quantities) => sum + toNumber(quantities[line.poLineId]), 0),
    unit: String(line.unit || po.unit || ""),
  }));
}

function grnsForPo(poId: string | undefined, facts: ProcurementRuntimeFacts) {
  return facts.receivingDocs.filter((doc) => doc.po === poId);
}

// One name per receipt state, as the order's own status says it: 未收货 Not
// received, 部分收货 Partially received, 全部收货 Fully received.
function receivedStatus(po: PurchaseOrder, facts: ProcurementRuntimeFacts) {
  const totals = poTotals(po);
  const grns = grnsForPo(po.po, facts);
  if (grns.some((doc) => doc.status === "异常处理")) return "异常处理";
  if (totals.totalOrderedQty > 0 && totals.totalReceivedQty >= totals.totalOrderedQty) return "全部收货";
  if (totals.totalReceivedQty > 0) return "部分收货";
  return "未收货";
}

// The supplier invoices' state: none yet, a variance still to decide, less
// invoiced than ordered (than received, once the order is closed), or all
// invoiced. Payment is a stage of its own (paymentSummary).
function invoiceStatus(po: PurchaseOrder, facts: ProcurementRuntimeFacts) {
  const invoices = activeInvoicesForPo(po.po, facts);
  if (!invoices.length) return "未开票";
  if (invoices.some((invoice) => ["open", "rejected"].includes(varianceStateOf(invoice)))) return "发票差异";
  if (invoiceLinesRead(invoices)) {
    const closed = ["closed", "cancelled"].includes(purchaseOrderStatusCode(po.status));
    if (storyLines(po, facts).some((line) => (closed ? line.accepted : line.ordered) - line.invoiced > 0.00005)) return "部分开票";
  }
  return "已开票";
}

// Match statuses that say an invoice matched without a variance.
const MATCHED_INVOICE_STATUSES = new Set(["自动匹配", "已解决", "matched", "已匹配"]);
function matchStatus(po: PurchaseOrder, facts: ProcurementRuntimeFacts) {
  if (purchaseOrderStatusCode(po.status) === "cancelled") return "无需匹配";
  const invoices = activeInvoicesForPo(po.po, facts);
  const grns = grnsForPo(po.po, facts);
  // An invoice is missing only once goods have arrived; before that (an order
  // awaiting approval, or issued and not received) there is nothing to match.
  if (!invoices.length) return grns.length || poTotals(po).totalReceivedQty > 0 ? "缺少发票" : "尚无可匹配";
  if (!grns.length || grns.some((doc) => doc.status === "待收货" || doc.status === "质检中")) return "缺少收货";
  const states = invoices.map((invoice) => ({ invoice, state: varianceStateOf(invoice) }));
  // A variance still waiting on a decision, by its type.
  const open = states.find((entry) => entry.state === "open");
  if (open) {
    const label = invoiceVarianceLabelKey(open.invoice.varianceType);
    return label && label !== "无差异" ? label : "需人工复核";
  }
  if (states.some((entry) => entry.state === "rejected")) return "差异已驳回";
  // An invoice with no variance that has not been matched yet.
  if (states.some(({ invoice, state }) => state === "none" && !MATCHED_INVOICE_STATUSES.has(String(invoice.matchStatus || "")) && !["matched", "approved"].includes(poInvoice(invoice).workflowStatus || ""))) return "待匹配";
  // Every exception approved: the match is settled, with its variance accepted.
  if (states.some((entry) => entry.state === "approved")) return "差异已批准";
  return "已匹配";
}

function paymentOf(po: PurchaseOrder, facts: ProcurementRuntimeFacts) {
  return paymentSummary(activeInvoicesForPo(po.po, facts).map(storyInvoice));
}

// The next action, from what is left. Before the supplier has the order it
// waits on its approver or on being issued; after that, see nextOpenAction.
type PoAction = NextAction | { kind: "cancelled" } | { kind: "submit" } | { kind: "awaiting_approval" } | { kind: "rejected" } | { kind: "issue" };
function nextActionForPo(po: PurchaseOrder, facts: ProcurementRuntimeFacts): PoAction {
  const code = purchaseOrderStatusCode(po.status);
  if (code === "cancelled") return { kind: "cancelled" };
  if (code === "draft") return { kind: "submit" };
  if (code === "pending_approval") return { kind: "awaiting_approval" };
  if (code === "rejected") return { kind: "rejected" };
  // Approved but not issued: the supplier does not have it yet, so nothing
  // can arrive; it is sent first (decision V5).
  if (code === "approved") return { kind: "issue" };
  const invoices = activeInvoicesForPo(po.po, facts);
  return nextOpenAction({
    // A closed or fully received order has nothing more to receive.
    receivable: !["closed", "fully_received", "completed"].includes(code),
    lines: storyLines(po, facts),
    invoices: invoices.map(storyInvoice),
    invoiceLinesKnown: invoiceLinesRead(invoices),
  });
}

function poActionText(action: PoAction, words: StoryWords) {
  const pick = (pair: [string, string]) => (words.language === "en-US" ? pair[0] : pair[1]);
  switch (action.kind) {
    case "cancelled": return pick(["Order cancelled; no receipt required", "订单已取消，无需收货"]);
    case "submit": return pick(["Submit it for approval", "提交审批"]);
    case "awaiting_approval": return pick(["Awaiting approval", "等待审批"]);
    case "rejected": return pick(["Rejected; revise it and submit again", "订单已驳回，修改后重新提交"]);
    // The words of the Mark as issued button and its note.
    case "issue": return pick(["Send the PO to the supplier, then mark it issued", "将采购订单发给供应商，然后标记为已下达"]);
    default: return nextActionText(action, words);
  }
}

// Quantities, numbers and money in the interface language, for the story's sentences.
function storyWords(language: string, formatNumber: (value: number) => string, currency?: string): StoryWords {
  return {
    language,
    quantity: (value, unit) => `${formatNumber(value)} ${unitLabel(unit, language, value)}`.trim(),
    number: formatNumber,
    money: (value) => formatCurrencyAmount(value, currency),
  };
}

const PAYMENT_TONES: Record<string, StatusTone> = { none: "neutral", unknown: "neutral", outstanding: "warning", partly_paid: "info", paid: "success" };

// The order's five stages in plain words, with exactly one marked current: the
// first stage not finished. A stage is finished only once the one before it is
// (a match or payment of part of the order is not the order's); its note still
// says how far it got. A stage with a problem (a receipt exception, a variance
// to decide) shows as a warning instead.
function poTimeline(po: PurchaseOrder, facts: ProcurementRuntimeFacts, day: (value?: string | null) => string, words: StoryWords): TimelineStep[] {
  const code = purchaseOrderStatusCode(po.status);
  const receipt = receivedStatus(po, facts);
  const invoice = invoiceStatus(po, facts);
  const match = matchStatus(po, facts);
  const payment = paymentOf(po, facts);
  const placed = !NOT_ISSUED_PO_STATUSES.has(po.status) && !NOT_ISSUED_PO_STATUSES.has(code);
  const received = receipt === "全部收货" || (code === "closed" && receipt !== "异常处理");
  const invoiced = invoice === "已开票";
  const settledMatch = ["已匹配", "差异已批准", "无需匹配"].includes(match);
  const waitingMatch = ["缺少发票", "缺少收货", "尚无可匹配", "待匹配"].includes(match);
  const paymentNote = paymentAmountsText(payment, words) || paymentStateLabel(payment.state, words.language);
  const steps: Array<{ label: string; done: boolean; warning?: boolean; helper: React.ReactNode }> = [
    { label: "下单", done: placed, helper: placed ? day(po.created) : poActionText(nextActionForPo(po, facts), words) },
    { label: "收货", done: received, warning: receipt === "异常处理", helper: receipt },
    { label: "供应商开票", done: invoiced, warning: invoice === "发票差异", helper: invoice },
    { label: "三单匹配", done: invoiced && settledMatch, warning: !settledMatch && !waitingMatch, helper: match },
    { label: "付款", done: invoiced && payment.state === "paid", helper: paymentNote },
  ];
  const current = code === "cancelled" ? -1 : steps.findIndex((step) => !step.done);
  return steps.map((step, index) => ({
    label: step.label,
    status: step.done ? "done" : step.warning ? "warning" : index === current ? "current" : "pending",
    helper: step.helper,
  }));
}

// Statuses before the order reaches the supplier: its lines wait on the order,
// not on a receipt.
const NOT_ISSUED_PO_STATUSES = new Set(["draft", "pending_approval", "approved", "rejected", "草稿", "待审批", "已审批", "已驳回"]);

// A line's receipt state from its quantities, in the words the order's status
// uses: 未收货, 部分收货, 全部收货 (a closed line says so).
function lineReceiptStatus(status: string | undefined, ordered: number, received: number) {
  if (status === "closed") return lineStatusLabel(status);
  if (ordered > 0 && received >= ordered) return "全部收货";
  if (received > 0) return "部分收货";
  return "未收货";
}

// The number people read; the id (po) stays in links and calls.
function purchaseOrderNumber(order: PurchaseOrder) {
  return documentNumberFor("purchase_order", order.po, order.number || order.orderNumber);
}

// sourceNumbers: the source request's and RFQ's document numbers, shown in place of their ids.
function buildPoLineRows(po: PurchaseOrder, facts: ProcurementRuntimeFacts, sourceNumbers: { request?: string; rfq?: string } = {}): PoEvidenceRow[] {
  const cancelled = ["cancelled", "已取消"].includes(po.status);
  const notIssued = NOT_ISSUED_PO_STATUSES.has(String(po.status));
  const lines = poLinesOf(po);
  const invoiceLines = activeInvoicesForPo(po.po, facts).flatMap(invoiceLinesOf);
  return lines.map((line, index) => {
    const invoiceQty = invoiceLines
      .filter((invoiceLine) => invoiceLineOnPoLine(invoiceLine, line, lines))
      .reduce((sum, invoiceLine) => sum + toNumber(invoiceLine.quantity), 0);
    const ordered = toNumber(line.quantityOrdered);
    const received = toNumber(line.quantityReceived);
    const remaining = lineRemaining(line);
    const unitPrice = unitPriceForLine(line, po, facts);
    return {
      poLineId: line.poLineId,
      lineNumber: index + 1,
      currency: line.currency || po.currency,
      sourcePrLine: po.sourceRequest ? sourceNumbers.request || po.sourceRequest : "无采购申请",
      sourceRfqLine: po.sourceRfq ? sourceNumbers.rfq || po.sourceRfq : "未经询价",
      sku: safeText(line.sku, po.sourceSku || "SKU 待补齐"),
      itemName: safeText(line.itemName, po.sourceName || "物料名称待补齐"),
      quantity: ordered,
      unit: safeText(line.unit, po.unit || "件"),
      unitPrice,
      lineAmount: poLineAmount(line, po),
      warehouse: safeText(line.warehouseId || po.warehouseId, "目标仓库待补齐"),
      requiredDate: safeText(line.requiredDate || po.eta, "需求日期待补齐"),
      promisedDate: safeText(line.promisedDate || po.eta, "预计到货待补齐"),
      receivedQty: received,
      remainingQty: remaining,
      invoicedQty: invoiceQty,
      uninvoicedQty: Math.max(0, ordered - invoiceQty),
      status: cancelled ? "已取消" : notIssued ? String(po.status) : lineReceiptStatus(line.status, ordered, received),
      // No receipt risk before the order is issued: nothing is due yet.
      risk: cancelled ? "无需收货" : notIssued ? "" : remaining > 0 && invoiceQty > received ? "已票未收风险" : remaining > 0 ? "未收货风险" : invoiceQty < received ? "已收未票风险" : "低风险",
      supplierOverride: line.supplierOverride || null,
    };
  });
}

// The placeholder for a receipt or invoice line that names no PO line.
const MISSING_PO_LINE = "采购订单行待补齐";

// A receipt's state as a status code the shared labels know: posted or
// reversed once it is, cancelled, else where its workflow stands.
type PoReceipt = ReceivingDoc & { workflowStatus?: string; postingStatus?: string };
function receiptStatusCode(grn: ReceivingDoc) {
  const { postingStatus, workflowStatus } = grn as PoReceipt;
  if (postingStatus === "posted" || postingStatus === "reversed") return postingStatus;
  if (workflowStatus === "cancelled") return "cancelled";
  return workflowStatus || postingStatus || String(grn.status || "");
}
// The GRN number people read; the id when the receipt has none.
const receiptNumberOf = (grn: ReceivingDoc) => grn.documentNumber || grn.grn;

const roundCents = (value: number) => Math.round(value * 100) / 100;

function buildGrnRows(po: PurchaseOrder, facts: ProcurementRuntimeFacts): GrnEvidenceRow[] {
  const poLines = poLinesOf(po);
  const invoiceLines = activeInvoicesForPo(po.po, facts).flatMap(invoiceLinesOf);
  return grnsForPo(po.po, facts).flatMap((grn) => {
    const lines = grnLinesOf(grn);
    return lines.map((line, index) => {
      const poLine = poLines.find((item) => item.poLineId === line.poLineId) || poLines[index] || poLines[0];
      const grnLineId = safeText(line.grnLineId, `${grn.grn}-L${String(index + 1).padStart(3, "0")}`);
      // An invoice line belongs to a receipt line only when it names it.
      const invoicedOn = invoiceLines.filter((invoiceLine) => invoiceLine.grnLine && invoiceLine.grnLine === line.grnLineId);
      const unitPrice = unitPriceForLine(poLine || {}, po, facts);
      const rejectedQty = toNumber(line.rejectedQty);
      // Accepted into stock: what the PO line counts as received and what is
      // invoiced against. A line recorded with neither (older rows) counts
      // what arrived.
      const acceptedQty = toNumber(line.acceptedQty) || (rejectedQty ? 0 : toNumber(line.receivedQty));
      const stored = (Array.isArray(grn.lines) ? grn.lines[index] : undefined) as Record<string, unknown> | undefined;
      return {
        grn: grn.grn,
        receiptNumber: receiptNumberOf(grn),
        receiptStatus: receiptStatusCode(grn),
        grnLineId,
        grnLineNumber: index + 1,
        po: po.po,
        poLineId: safeText(line.poLineId || poLine?.poLineId, MISSING_PO_LINE),
        supplier: grn.supplier,
        sku: safeText(line.sku || poLine?.sku, "SKU 待补齐"),
        acceptedQty,
        rejectedQty,
        rejectionReason: String(stored?.rejectionReason ?? "").trim(),
        unit: safeText(line.unit || poLine?.unit, "件"),
        arrived: grn.arrived,
        receiver: safeText(grn.receiver, "收货人待补齐"),
        unitPrice,
        lineAmount: roundCents(unitPrice * acceptedQty),
        status: grn.status,
        qcStatus: rejectedQty > 0 ? "质检异常" : grn.status === "质检中" ? "质检中" : "通过",
        invoiceLineIds: invoicedOn.map((invoiceLine) => invoiceLine.lineId),
      };
    });
  });
}

// An invoice's match state in the page's words: its variance waiting on a
// decision (by type), decided (approved or rejected), matched, or not matched yet.
function invoiceMatchState(invoice: SupplierInvoice) {
  if (isCancelledInvoice(storyInvoice(invoice))) return "已取消";
  const state = varianceStateOf(invoice);
  if (state === "open") {
    const label = invoiceVarianceLabelKey(invoice.varianceType);
    return label && label !== "无差异" ? label : "需人工复核";
  }
  if (state === "rejected") return "差异已驳回";
  if (state === "approved") return "差异已批准";
  return MATCHED_INVOICE_STATUSES.has(String(invoice.matchStatus || "")) || ["matched", "approved"].includes(poInvoice(invoice).workflowStatus || "") ? "已匹配" : "待匹配";
}

function buildInvoiceRows(po: PurchaseOrder, facts: ProcurementRuntimeFacts): InvoiceEvidenceRow[] {
  return invoicesForPo(po.po, facts).flatMap((invoice) => {
    const story = storyInvoice(invoice);
    // An invoice recorded without lines shows as one line; it names no
    // receipt line, so it is linked to none.
    const invoiceLines = invoiceLinesOf(invoice).length ? invoiceLinesOf(invoice) : [{
      lineId: `${invoice.invoiceNumber}-SUMMARY`,
      sku: po.sourceSku || "",
      name: po.sourceName || "",
      poLine: po.lines?.[0]?.poLineId,
      grnLine: "",
      quantity: po.received || 0,
      unit: po.lines?.[0]?.unit || "",
      unitPrice: po.lines?.[0]?.unitPrice || 0,
      taxRate: 0,
      taxAmount: invoice.tax || 0,
      lineSubtotal: invoice.subtotal || invoice.total || 0,
      lineTotal: invoice.total || 0,
      varianceType: invoice.varianceType,
      varianceAmount: invoice.varianceAmount,
    }];
    return invoiceLines.map((line, index) => ({
      currency: invoice.currency,
      invoiceNumber: invoice.invoiceNumber,
      displayNumber: invoiceNumberOf(invoice),
      invoiceLineId: line.lineId,
      invoiceLineNumber: index + 1,
      supplier: invoice.supplier,
      po: invoice.relatedPo,
      poLineId: safeText(line.poLine, MISSING_PO_LINE),
      grnLineId: String(line.grnLine || ""),
      sku: safeText(line.sku, "SKU 待补齐"),
      quantity: toNumber(line.quantity),
      unit: safeText(line.unit, "件"),
      unitPrice: toNumber(line.unitPrice),
      invoiceAmount: toNumber(line.lineSubtotal),
      taxAmount: toNumber(line.taxAmount),
      totalAmount: toNumber(line.lineTotal),
      invoiceDate: invoice.invoiceDate,
      dueDate: invoice.dueDate,
      matchState: invoiceMatchState(invoice),
      varianceType: invoiceVarianceLabelKey(line.varianceType || invoice.varianceType),
      varianceAmount: toNumber(line.varianceAmount ?? invoice.varianceAmount),
      hasVariance: story.hasVariance,
      payment: story.payment ?? null,
      risk: isNoInvoiceVariance(line.varianceType || invoice.varianceType) ? "低风险" : "需人工复核",
    }));
  });
}

// Below a cent (or a ten-thousandth of a unit) a difference is rounding.
const MATCH_MONEY_EPSILON = 0.005;
const MATCH_QTY_EPSILON = 0.00005;

// The match checks only what was invoiced: its price against the PO, and its
// quantity against what was received. An open receiving gap (ordered, not yet
// received) and a received quantity not yet invoiced are not variances.
function matchStatusForLine(row: Omit<MatchEvidenceRow, "status" | "suggestedAction">) {
  // "尚未收货" / "尚未开票" are the placeholders for a line with no receipt or invoice yet.
  const received = row.receivedQty > MATCH_QTY_EPSILON;
  const hasReceipt = Boolean(row.grnLineId) && !row.grnLineId.includes("待补齐") && row.grnLineId !== "尚未收货";
  const invoiced = row.invoiceQty > MATCH_QTY_EPSILON || (Boolean(row.invoiceLineId) && !row.invoiceLineId.includes("待补齐") && row.invoiceLineId !== "尚未开票");
  if (!invoiced) return received ? "已收未票" : hasReceipt ? "缺少发票" : "缺少收货";
  if (row.qtyVariance > MATCH_QTY_EPSILON) return received ? "数量差异" : "已票未收";
  if (Math.abs(row.priceVariance) >= MATCH_MONEY_EPSILON) return "价格差异";
  if (Math.abs(row.amountVariance) >= MATCH_MONEY_EPSILON) return "金额差异";
  return "已匹配";
}

const LINE_VARIANCE_STATUSES = new Set(["数量差异", "价格差异", "金额差异"]);
function suggestedActionForStatus(status: string, invoiceGap = 0): [string, string] {
  if (status === "缺少收货") return ["Record the receipt", "登记收货"];
  if (status === "缺少发票" || status === "已收未票") return ["Record the supplier invoice", "录入采购发票"];
  if (status === "已票未收" || status === "数量差异") return ["Review the receipt", "复核收货记录"];
  if (status === "价格差异" || status === "金额差异") return ["Review the supplier invoice", "复核采购发票"];
  if (status === "差异已驳回") return ["Ask the supplier for a corrected invoice", "请供应商更正发票"];
  // Matched so far; the rest of what was received is still to be invoiced.
  if (invoiceGap > MATCH_QTY_EPSILON) return ["Record the supplier invoice for the rest", "为其余数量录入采购发票"];
  return ["Nothing to do", "无需处理"];
}

function buildMatchRows(po: PurchaseOrder, facts: ProcurementRuntimeFacts): MatchEvidenceRow[] {
  const grnRows = buildGrnRows(po, facts);
  const activeIds = new Set(activeInvoicesForPo(po.po, facts).map((invoice) => invoice.invoiceNumber));
  const invoiceRows = buildInvoiceRows(po, facts).filter((row) => activeIds.has(row.invoiceNumber));
  const invoices = new Map(invoicesForPo(po.po, facts).map((invoice) => [invoice.invoiceNumber, invoice]));
  const poLines = buildPoLineRows(po, facts);
  // An invoice line without a PO line reference counts on the PO line with its
  // SKU when only one has it, else on the only line of a single-line PO.
  const onLine = (row: InvoiceEvidenceRow, line: PoEvidenceRow) => {
    if (row.poLineId !== MISSING_PO_LINE) return row.poLineId === line.poLineId;
    const bySku = poLines.filter((candidate) => candidate.sku === row.sku);
    return bySku.length === 1 ? bySku[0] === line : poLines.length === 1;
  };
  return poLines.map((line) => {
    const grnLines = grnRows.filter((row) => row.poLineId === line.poLineId);
    const invoiceLines = invoiceRows.filter((row) => onLine(row, line));
    // Received is what was accepted on the PO line; the receipt lines only
    // stand in when the PO line has none recorded.
    const receivedQty = line.receivedQty > 0 || !grnLines.length ? line.receivedQty : grnLines.reduce((sum, row) => sum + row.acceptedQty, 0);
    const invoiceQty = invoiceLines.reduce((sum, row) => sum + row.quantity, 0);
    const invoiceAmount = invoiceLines.reduce((sum, row) => sum + row.invoiceAmount, 0);
    const expectedAmount = invoiceQty * line.unitPrice;
    const invoiceIds = [...new Set(invoiceLines.map((row) => row.invoiceNumber))];
    const base = {
      poLineId: line.poLineId,
      grnLineId: grnLines[0]?.grnLineId || "尚未收货",
      invoiceLineId: invoiceLines[0]?.invoiceLineId || "尚未开票",
      receiptIds: [...new Set(grnLines.map((row) => row.grn))],
      invoiceIds,
      moreInvoiceLines: Math.max(0, invoiceLines.length - 1),
      poQty: line.quantity,
      receivedQty,
      invoiceQty,
      poUnitPrice: line.unitPrice,
      invoiceUnitPrice: invoiceLines.length === 1 ? invoiceLines[0].unitPrice : invoiceQty ? invoiceAmount / invoiceQty : 0,
      expectedAmount,
      invoiceAmount,
      taxAmount: invoiceLines.reduce((sum, row) => sum + row.taxAmount, 0),
      qtyVariance: Math.max(0, invoiceQty - receivedQty),
      priceVariance: invoiceLines.reduce((sum, row) => sum + (row.unitPrice - line.unitPrice) * row.quantity, 0),
      amountVariance: invoiceAmount - expectedAmount,
      receivingGap: Math.max(0, line.quantity - receivedQty),
      invoiceGap: Math.max(0, receivedQty - invoiceQty),
    };
    let status = matchStatusForLine(base);
    // A variance on the line is settled once each invoice that carries one
    // had its exceptions approved; rejected, it waits on a corrected invoice.
    if (LINE_VARIANCE_STATUSES.has(status)) {
      const states = invoiceIds.map((id) => invoices.get(id)).filter((invoice): invoice is SupplierInvoice => Boolean(invoice)).map(varianceStateOf).filter((state) => state !== "none");
      if (states.includes("rejected")) status = "差异已驳回";
      else if (states.length && states.every((state) => state === "approved")) status = "差异已批准";
    }
    return { ...base, status, suggestedAction: suggestedActionForStatus(status, base.invoiceGap) };
  });
}

function dataLimitations() {
  return [
    "当前仅基于工作区内 PR、询价单、PO、GRN 和发票记录判断。",
    "部分收货记录或发票记录可能尚未完整读取。",
    "当前不执行真实收货、库存过账、发票过账或付款。",
    "三单匹配结论仅用于内部复核，需业务负责人确认。",
    "应计和未开票金额仅为协同可见性，不形成会计分录。",
  ];
}

function SectionTitle({ title, right }: { title: string; right?: React.ReactNode }) {
  return <SectionHeader title={title} right={right} />;
}

// The overview facts. Values may be chips, and long values and notes wrap
// rather than being cut off.
type OverviewField = { label: string; value: React.ReactNode; helper?: React.ReactNode };
function OverviewFields({ fields }: { fields: OverviewField[] }) {
  return (
    <Card className="p-4" data-testid="po-overview">
      <dl className="grid grid-cols-2 gap-x-4 gap-y-3 lg:grid-cols-4">
        {fields.map((field) => (
          <div key={field.label} className="min-w-0">
            <dt className="fc-caption font-medium" style={{ color: A.gray2 }}>{field.label}</dt>
            <dd className="mt-1 break-words text-xs font-semibold" style={{ color: A.label }}>{field.value || "—"}</dd>
            {field.helper ? <dd className="fc-caption mt-0.5 leading-4" style={{ color: A.sub }}>{field.helper}</dd> : null}
          </div>
        ))}
      </dl>
    </Card>
  );
}

const STEP_COLORS: Record<TimelineStep["status"], string> = { done: A.green, current: A.blue, warning: A.orange, blocked: A.red, pending: A.gray3 };

// The order's progress as equal-width steps: a dot on a line, its label and
// note below, so long labels and dates wrap within their own step.
function PoProgress({ steps }: { steps: TimelineStep[] }) {
  const copy = usePageCopy();
  return (
    <Card className="p-4" data-testid="po-progress">
      {/* Five steps fit a phone: no sideways scroll, the labels wrap. */}
      <div>
        <ol className="grid" style={{ gridTemplateColumns: `repeat(${steps.length}, minmax(0, 1fr))` }}>
          {steps.map((step, index) => {
            const color = STEP_COLORS[step.status];
            const next = steps[index + 1];
            return (
              <li key={step.label} className="relative px-1 text-center sm:px-2" aria-current={step.status === "current" ? "step" : undefined}>
                {next ? <span aria-hidden className="absolute left-1/2 top-[7px] h-0.5 w-full" style={{ background: next.status === "pending" ? A.gray4 : color }} /> : null}
                <span aria-hidden className="relative mx-auto block h-4 w-4 rounded-full" style={{ background: color, boxShadow: `0 0 0 3px ${color}22` }} />
                <div className="mt-2 text-xs font-semibold leading-4" style={{ color: step.status === "pending" ? A.gray1 : A.label }}>{copy(step.label)}</div>
                {step.helper ? <div className="fc-caption mt-0.5 break-words leading-4" style={{ color: A.gray2 }}>{typeof step.helper === "string" ? copy(step.helper) : step.helper}</div> : null}
              </li>
            );
          })}
        </ol>
      </div>
    </Card>
  );
}

// Receipt, invoice and match lines: fixed columns that fit beside the sidebar
// at 1440px, headers that wrap, the first column pinned when a narrower
// window scrolls, and an empty state in its own card instead of a row spread
// across hidden columns. Below 640 px each row is a card (listTableCardsRef):
// the first column names it, the status column sits beside it, the other
// cells follow with their column names.
type EvidenceColumn<T> = { key: string; label: string; width: number; align?: "right"; render: (row: T) => React.ReactNode };
const evidenceHeadClass = `px-3 py-2.5 align-bottom ${typography.tableHeader}`;
function EvidenceTable<T>({ columns, rows, rowKey, emptyText, testId }: { columns: EvidenceColumn<T>[]; rows: T[]; rowKey: (row: T, index: number) => string; emptyText: string; testId: string }) {
  if (!rows.length) return <Card className="px-4 py-6 text-center text-xs" style={{ color: A.gray2 }} data-testid={testId}>{emptyText}</Card>;
  const minWidth = columns.reduce((sum, column) => sum + column.width, 0);
  return (
    <Card className="overflow-hidden" data-testid={testId}>
      <div className={tableScrollClass} ref={listTableCardsRef}>
        <table className={`w-full table-fixed text-left ${tableBodyTextClass}`} style={{ minWidth }}>
          <colgroup>{columns.map((column) => <col key={column.key} style={{ width: column.width }} />)}</colgroup>
          <thead>
            <tr style={listHeadRowStyle}>
              {columns.map((column, index) => (
                <th key={column.key} scope="col" className={`${evidenceHeadClass} ${column.align === "right" ? "text-right" : "text-left"} ${index === 0 ? "sticky left-0 z-10 bg-white" : ""}`} style={{ color: A.gray1 }}>{column.label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, rowIndex) => (
              <tr key={rowKey(row, rowIndex)} className={listRowClass} style={listRowStyle(rowIndex, rows.length)}>
                {columns.map((column, index) => (
                  <td key={column.key} className={`px-3 py-2.5 align-top ${column.align === "right" ? "text-right tabular-nums" : ""} ${index === 0 ? "sticky left-0 z-[1] bg-white" : ""}`} style={{ color: A.label }}>{column.render(row)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

// A second line under a cell's main value.
function Sub({ children }: { children: React.ReactNode }) {
  return <div className="mt-0.5 text-[11px] leading-4" style={{ color: A.sub }}>{children}</div>;
}

const relatedLinkClass = `inline-flex items-center ${typography.denseButton} text-blue-600 hover:underline rounded-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-200`;

// The list's filters from the address. A status the list does not offer
// (or a legacy Chinese one) is read as its code, else as All.
function filtersFromAddress(searchParams: URLSearchParams): PurchaseOrderWorkbenchFilters {
  const status = purchaseOrderStatusCode(searchParams.get("status") || "全部");
  return {
    ...defaultPurchaseOrderWorkbenchFilters,
    poNumber: searchParams.get("po") || "",
    supplier: searchParams.get("supplier") || "",
    skuOrItem: searchParams.get("item") || "",
    status: (purchaseOrderStatusFilterOptions as readonly string[]).includes(status) ? status : "全部",
    source: searchParams.get("source") || "全部",
    owner: searchParams.get("owner") || "",
    etaFrom: searchParams.get("etaFrom") || "",
    etaTo: searchParams.get("etaTo") || "",
  };
}

export default function PurchasingOrdersPage({
  focus,
  onNavigate,
  onActiveContextChange,
}: {
  focus?: { entityType: string; entityId: string; focusArea?: "exception" | "receiving" | "invoice" | "inventory" | "evidence" | "receiving-invoice-variance"; at: number } | null;
  onNavigate?: NavigateFn;
  onActiveContextChange?: (context: ActiveContext | null) => void;
}) {
  const copy = usePageCopy();
  const priceCopy = usePriceHistoryCopy();
  const { t, timezone, language, formatNumber } = useI18n();
  const say = useSay();
  const day = useCalendarDay();
  // "供应商" alone is the Suppliers module name; a column holds one supplier.
  const supplierLabel = language === "en-US" ? "Supplier" : "供应商";
  const receiptInvoiceLabel = language === "en-US" ? "Receipt / invoice" : "收货 / 发票";
  const warehouseName = useWarehouseNames();
  const canOpenRoute = useRouteAvailability();
  const location = useLocation();
  const routerNavigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const detailIdFromUrl = location.pathname.match(/^\/app\/procurement\/orders\/([^/]+)$/)?.[1];
  const canonicalDetailId = detailIdFromUrl ? decodeURIComponent(detailIdFromUrl) : "";
  const [orders, setOrders] = useState<PurchaseOrder[]>([]);
  const [receivingRecords, setReceivingRecords] = useState<ReceivingDoc[]>([]);
  const [invoiceRecords, setInvoiceRecords] = useState<SupplierInvoice[]>([]);
  const [summary, setSummary] = useState<PurchaseOrderWorkbenchSummary | null>(null);
  const [loading, setLoading] = useState(true);
  // The address the data on the page was read for: the list ("") or one
  // order's id. The list's orders carry only the line fields the list uses,
  // so the detail never draws from them, and neither view shows the other's
  // data for the moment between a navigation and its read.
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  const loadedForAddress = loadedFor === canonicalDetailId;
  // The failed read, shown as a translated sentence (its code in the tooltip).
  const [loadError, setLoadError] = useState<{ error: unknown } | null>(null);
  const filtersInAddress = useMemo(() => filtersFromAddress(searchParams), [searchParams.toString()]);
  const [filters, setFilters] = useState<PurchaseOrderWorkbenchFilters>(filtersInAddress);
  useEffect(() => {
    setFilters((current) => (JSON.stringify(current) === JSON.stringify(filtersInAddress) ? current : filtersInAddress));
  }, [filtersInAddress]);
  const [selectedId, setSelectedId] = useState(canonicalDetailId);
  const viewMode: PurchaseOrderViewMode = canonicalDetailId ? "detail" : "list";
  const [highlightedArea, setHighlightedArea] = useState("");
  const fulfillmentFocusRef = useRef<HTMLElement | null>(null);
  const facts = useMemo<ProcurementRuntimeFacts>(() => ({
    receivingDocs: receivingRecords,
    supplierInvoices: invoiceRecords,
  }), [receivingRecords, invoiceRecords]);

  const loadWorkbench = React.useCallback(() => {
    let alive = true;
    setLoading(true);
    setLoadError(null);
    // The detail reads only its order, with that order's receipts and
    // invoices; the list reads every order.
    const read: Promise<PurchaseOrderWorkbenchPayload> = canonicalDetailId
      ? apiJson<PurchaseOrderDetailPayload>(`/api/purchase-orders-workbench/${encodeURIComponent(canonicalDetailId)}`)
        .then(({ purchaseOrder, ...rest }) => ({ ...rest, purchaseOrders: purchaseOrder ? [purchaseOrder] : [] }))
      : apiJson<PurchaseOrderWorkbenchPayload>("/api/purchase-orders-workbench?view=list");
    read
      .then((data) => {
        if (!alive) return;
        rememberDocumentNumbers("purchase_order", data.purchaseOrders, (order) => [order.po, order.number || order.orderNumber]);
        setOrders(data.purchaseOrders || []);
        setReceivingRecords(data.receivingDocs || []);
        setInvoiceRecords(data.supplierInvoices || []);
        setSummary(data.summary || null);
        // The address may name the order by its number; the page keeps its id.
        setSelectedId(canonicalDetailId ? data.purchaseOrders?.[0]?.po || canonicalDetailId : "");
        setLoadedFor(canonicalDetailId);
      })
      .catch((error) => {
        if (!alive) return;
        setOrders([]);
        setReceivingRecords([]);
        setInvoiceRecords([]);
        setSummary(null);
        setLoadedFor(canonicalDetailId);
        // An order that is not there (or not in this workspace) is "not
        // found", not a failed read.
        if (canonicalDetailId && error instanceof ApiError && error.status === 404) return;
        setLoadError({ error });
      })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [canonicalDetailId]);

  useEffect(() => loadWorkbench(), [loadWorkbench]);

  useEffect(() => {
    setSelectedId(canonicalDetailId);
  }, [canonicalDetailId]);

  useEffect(() => {
    if (loading || !loadedForAddress || viewMode !== "detail" || focus?.entityType !== "purchase_order" || focus.entityId !== selectedId || !focus.focusArea) return;
    const area = focus.focusArea === "evidence" ? "receiving-invoice-variance" : focus.focusArea || "receiving-invoice-variance";
    setHighlightedArea(area);
    const target = fulfillmentFocusRef.current;
    const frame = window.requestAnimationFrame(() => target?.scrollIntoView({ behavior: "smooth", block: "start" }));
    const timer = window.setTimeout(() => setHighlightedArea(""), 5000);
    return () => {
      window.cancelAnimationFrame(frame);
      window.clearTimeout(timer);
    };
  }, [focus?.at, focus?.entityId, focus?.entityType, focus?.focusArea, loading, loadedForAddress, selectedId, viewMode]);

  // "open" is the report definition: committed and still to receive.
  const openOrderIds = useMemo(() => (summary ? new Set(summary.openPurchaseOrderIds || []) : undefined), [summary]);
  const filtered = filterPurchaseOrdersForWorkbench(orders, filters, openOrderIds).filter((order) => {
    const supplier = searchParams.get("supplier");
    const overdue = searchParams.get("overdue") === "true";
    if (supplier && order.supplier !== supplier) return false;
    // Overdue: open, with an expected arrival before today in the workspace timezone.
    if (overdue && (!(summary?.openPurchaseOrderIds || []).includes(order.po) || !order.eta || String(order.eta) >= todayInTimeZone())) return false;
    return true;
  });
  // One page of the list is drawn, as on the other long lists; search and
  // filters run over every order, and a new search starts at page 1.
  const paged = usePagedRows(filtered, PO_LIST_PAGE_SIZE, searchParams.toString());
  const selectedPO = loadedForAddress ? orders.find((order) => order.po === selectedId) ?? null : null;
  const selectedPOTotals = poTotals(selectedPO);
  // People read document numbers; the ids stay in links and calls.
  const selectedPONumber = selectedPO ? purchaseOrderNumber(selectedPO) : "";
  const sourceRequestNumber = useDocumentNumber("purchase_request", selectedPO?.sourceRequest, selectedPO?.prNumber);
  const sourceRfqNumber = useDocumentNumber("rfq", selectedPO?.sourceRfq, selectedPO?.rfqNumber);
  // The breadcrumb names the order by its number, not the id in the address.
  useDetailCrumb(viewMode === "detail" ? selectedPONumber : null);
  const lineName = useLineName();
  // The receipt, invoice and match tables name a line by its position on its
  // document, as the line cards do; a placeholder ("not received yet") is
  // translated, and an id the page cannot place is shown as it is.
  const poLineLabel = (id: string) => {
    const position = poLinesOf(selectedPO).findIndex((line) => line.poLineId === id);
    return position >= 0 ? lineName(position + 1) : copy(id);
  };
  // "GRN-202611-0008 · Line 1" for a receipt line id: the GRN number, never
  // the receipt's id; "" for a line the page cannot place.
  const receiptLineLabel = (id: string) => {
    for (const grn of receivingRecords) {
      const position = grnLinesOf(grn).findIndex((line) => line.grnLineId === id);
      if (position >= 0) return `${receiptNumberOf(grn)} · ${lineName(position + 1)}`;
    }
    return "";
  };
  // A line id for a tooltip: none for the "no receipt / invoice yet"
  // placeholders (尚未收货, 尚未开票, 待补齐), which are markers, not ids.
  const lineIdTitle = (id: string) => (!id || /尚未|待补齐/.test(id) ? undefined : id);
  // "INV-UI7-B002 · Line 1" for a supplier invoice line id: the supplier's
  // invoice number, never the record's id; "" for a line the page cannot place.
  const invoiceLineLabel = (id: string) => {
    for (const invoice of invoiceRecords) {
      const position = invoiceLinesOf(invoice).findIndex((line) => line.lineId === id);
      if (position >= 0) return `${invoiceNumberOf(invoice)} · ${lineName(position + 1)}`;
    }
    return "";
  };
  // The numbers of receipts and supplier invoices, by id.
  const receiptNumberFor = (id: string) => {
    const grn = receivingRecords.find((doc) => doc.grn === id);
    return grn ? receiptNumberOf(grn) : id;
  };
  const invoiceNumberFor = (id: string) => {
    const invoice = invoiceRecords.find((record) => record.invoiceNumber === id);
    return invoice ? invoiceNumberOf(invoice) : id;
  };
  // A status code (posted, cancelled …) in the interface language.
  const codeLabel = (code: string) => statusCodeLabel(code, language) || copy(code);
  // Quantities, numbers and money for the order's story sentences.
  const words = (currency?: string) => storyWords(language, formatNumber, currency);
  // Earlier PO prices for each line's item, unit and currency, in one
  // request. The server leaves this PO out and, once it is issued, every PO
  // dated after it. Display only.
  // Notes for the header buttons, shown on a line under them.
  const actionNotes = usePurchaseOrderActionNotes({ status: selectedPO?.status || "", version: selectedPO?.version });
  // Which rows of the list may offer Receive and Record supplier invoice.
  const entryRules = usePurchaseOrderEntryRules();
  // Open orders whose expected arrival is before today in the workspace's timezone.
  const today = todayInTimeZone(timezone);
  const daysLate = (order: PurchaseOrder) => {
    if (!order.eta || !summary?.openPurchaseOrderIds?.includes(order.po)) return 0;
    const days = Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${String(order.eta).slice(0, 10)}T00:00:00Z`)) / 86_400_000);
    return Number.isFinite(days) && days > 0 ? days : 0;
  };
  const poLineHistoryKeys = new Map((viewMode === "detail" && selectedPO?.lines ? selectedPO.lines : []).map((line) => [line.poLineId, priceHistoryKey({ itemId: line.itemId, unit: line.unit, currency: line.currency || selectedPO?.currency })]));
  const poPriceHistory = usePriceHistory([...poLineHistoryKeys.values()], { excludePurchaseOrderId: selectedPO?.po });
  const sourceOptions = Array.from(new Set(orders.map((order) => order.source || "manual"))).sort();
  const statusOptions = purchaseOrderStatusFilterOptions;
  const statusOptionLabel = (status: string) => status === "open" ? say("Open (still to receive)", "未结（仍待收货）") : copy(status);

  useEffect(() => {
    if (viewMode === "list" && selectedId) setSelectedId("");
  }, [selectedId, viewMode]);

  useEffect(() => {
    if (viewMode !== "detail" || !selectedPO) {
      onActiveContextChange?.(null);
      return;
    }
    onActiveContextChange?.({
      module: "procurement",
      entityType: "purchase_order",
      entityId: selectedPO.po,
      entityLabel: `${selectedPONumber} · ${selectedPO.supplier}`,
      view: "orders",
    });
    return () => onActiveContextChange?.(null);
  }, [viewMode, selectedPO?.po, selectedPONumber, selectedPO?.supplier, onActiveContextChange]);

  const committedValue = summary?.committedValueByCurrency || [];
  const committedHidden = Boolean(summary) && summary?.committedValueByCurrency === null;
  const invoiceExceptions = orders.filter((order) => invoiceStatus(order, facts) === "发票差异").length;
  // Orders whose match needs a person: not those matched, waiting for an
  // invoice, or with nothing to match yet.
  const matchExceptions = orders.filter((order) => !["已匹配", "差异已批准", "待匹配", "缺少发票", "尚无可匹配", "无需匹配"].includes(matchStatus(order, facts))).length;

  function updateFilter<K extends keyof PurchaseOrderWorkbenchFilters>(key: K, value: PurchaseOrderWorkbenchFilters[K]) {
    setFilters((current) => {
      const next = { ...current, [key]: value };
      const params = new URLSearchParams(searchParams);
      const queryKeys: Record<keyof PurchaseOrderWorkbenchFilters, string> = { poNumber: "po", supplier: "supplier", skuOrItem: "item", status: "status", source: "source", owner: "owner", etaFrom: "etaFrom", etaTo: "etaTo" };
      const queryKey = queryKeys[key];
      const normalized = String(value);
      if (!normalized || normalized === "全部") params.delete(queryKey); else params.set(queryKey, normalized);
      setSearchParams(params, { replace: true });
      return next;
    });
  }

  function resetFilters() {
    setFilters(defaultPurchaseOrderWorkbenchFilters);
    setSearchParams({}, { replace: true });
  }

  function openDetail(poId: string) {
    setSelectedId(poId);
    routerNavigate(`/app/procurement/orders/${encodeURIComponent(poId)}`);
  }

  function returnToList() {
    routerNavigate("/app/procurement/orders");
  }

  async function exportCsv() {
    if (filtered.length === 0) {
      toast.warning(copy("暂无可导出的数据"));
      return;
    }
    // Document numbers, not internal ids, in the file.
    const [requestNumbers, rfqNumbers] = await Promise.all([
      resolveDocumentNumbers("purchase_request", filtered.filter((order) => !order.prNumber).map((order) => order.sourceRequest)),
      resolveDocumentNumbers("rfq", filtered.filter((order) => !order.rfqNumber).map((order) => order.sourceRfq)),
    ]);
    exportRowsToCsv("purchase-order-evidence-export.csv", filtered.map((order) => ({
      PO编号: purchaseOrderNumber(order),
      来源PR: order.sourceRequest ? order.prNumber || requestNumbers.get(order.sourceRequest) || order.sourceRequest : "",
      来源询价单: order.sourceRfq ? order.rfqNumber || rfqNumbers.get(order.sourceRfq) || order.sourceRfq : "",
      供应商: order.supplier,
      状态: order.status,
      采购负责人: order.owner,
      行数: poTotals(order).lineCount,
      订单金额: poAmount(order),
      预计到货: order.eta,
      收货状态: receivedStatus(order, facts),
      发票状态: invoiceStatus(order, facts),
      三单匹配状态: matchStatus(order, facts),
      下一步: poActionText(nextActionForPo(order, facts), words(order.currency)),
    })));
    toast.success(copy("当前结果已导出"));
  }

  function navigateOrderWithReturn(order: PurchaseOrder, moduleId: string, focusTarget?: { entityType: string; entityId: string } | null, label?: string) {
    const returnContext: WorkflowContext = {
      sourceModule: "procurement",
      sourceEntityType: "purchase_order",
      sourceEntityId: order.po,
      sourceRoute: "procurement:orders",
      sourceLabel: purchaseOrderNumber(order),
      returnLabel: `返回采购订单 ${purchaseOrderNumber(order)}`,
    };
    onNavigate?.(moduleId, focusTarget || null, {
      returnTo: "procurement:orders",
      entityLabel: label || purchaseOrderNumber(order),
      returnContext,
      source: "purchaseOrderEvidence",
    });
  }

  function navigateWithReturn(moduleId: string, focusTarget?: { entityType: string; entityId: string } | null, label?: string) {
    if (!selectedPO) return;
    navigateOrderWithReturn(selectedPO, moduleId, focusTarget, label);
  }

  function focusFulfillmentEvidence() {
    setHighlightedArea("receiving-invoice-variance");
    fulfillmentFocusRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    window.setTimeout(() => setHighlightedArea(""), 5000);
  }

  // The day the PO was issued to the supplier, in the workspace timezone.
  // "Issue date not recorded" only for a PO that was issued; a PO not issued
  // yet, or received straight from approval, says so instead.
  const issueDateField = (po: PurchaseOrder) => {
    const day = instantDayInTimeZone(po.issuedAt, timezone);
    const value = day
      || (!ISSUED_PO_STATUSES.has(String(po.status)) ? priceCopy("notIssued")
        : String(po.status) !== "issued" && po.receivingBaseStatus === "approved" ? priceCopy("notIssuedInFlowChain")
          : priceCopy("issueDateNotRecorded"));
    return { label: priceCopy("issued"), value };
  };

  const detailContent = selectedPO && (() => {
    const fmt = (value: number | null) => formatCurrencyAmount(value, selectedPO.currency);
    const hideAmounts = amountsHidden(selectedPO);
    const poLines = buildPoLineRows(selectedPO, facts, { request: sourceRequestNumber, rfq: sourceRfqNumber }).map((row) => ({ ...row, warehouse: warehouseName(row.warehouse) }));
    const grnRows = buildGrnRows(selectedPO, facts);
    const invoiceRows = buildInvoiceRows(selectedPO, facts);
    const matchRows = buildMatchRows(selectedPO, facts);
    const invoices = invoicesForPo(selectedPO.po, facts);
    const grns = grnsForPo(selectedPO.po, facts);
    const delayRisk = poDelayedRisk(
      selectedPO.eta,
      selectedPO.status,
      selectedPOTotals.totalOrderedQty,
      selectedPOTotals.totalReceivedQty,
    );
    // A closed, cancelled or fully received order has nothing left to arrive.
    const delayed = delayRisk.delayed && !["cancelled", "closed", "fully_received", "已取消", "已关闭", "已完成"].includes(String(selectedPO.status));
    const delayNote = delayed
      ? say(`Was due ${day(selectedPO.eta)}; ${formatNumber(delayRisk.openQty)} still to receive.`, `应于 ${day(selectedPO.eta)} 到货，仍有 ${formatNumber(delayRisk.openQty)} 未收。`)
      : !selectedPO.eta ? say("No expected arrival date recorded.", "未记录预计到货日期。") : say("Nothing overdue to receive.", "没有逾期未收的数量。");
    const firstGrn = grns[0];
    const firstInvoice = invoices[0];
    const issued = issueDateField(selectedPO);
    const openReceipt = (grnId: string) => navigateWithReturn("procurement:receiving", { entityType: "receiving_doc", entityId: grnId }, grnId);
    const canOpenInvoice = canOpenRoute("procurement:bills");
    const openInvoice = (invoiceNumber: string) => navigateWithReturn("procurement:bills", { entityType: "supplier_invoice", entityId: invoiceNumber }, invoiceNumber);
    // Links to the records this order came from or led to; the order's own
    // actions are the buttons below them.
    const relatedLinks = [
      ...(selectedPO.sourceRequest ? [{
        key: "source-pr",
        label: `${say("Source PR", "来源采购申请")} ${sourceRequestNumber}`,
        onClick: () => navigateWithReturn("procurement:requests", { entityType: "purchase_request", entityId: selectedPO.sourceRequest }, sourceRequestNumber),
      }] : []),
      ...(selectedPO.sourceRfq ? [{
        key: "source-rfq",
        label: `${say("Source RFQ", "来源询价单")} ${sourceRfqNumber}`,
        onClick: () => navigateWithReturn("procurement:rfq", { entityType: "rfq", entityId: selectedPO.sourceRfq }, sourceRfqNumber),
      }] : []),
      ...(firstGrn ? [{ key: "receiving", label: copy("查看收货单"), onClick: () => openReceipt(firstGrn.grn) }] : []),
      ...(firstInvoice ? [{ key: "invoice", label: copy("查看采购发票"), onClick: focusFulfillmentEvidence }] : []),
      ...(firstGrn || firstInvoice ? [{ key: "match", label: copy("查看三单匹配"), onClick: focusFulfillmentEvidence }] : []),
    ];
    // The order status ("Partially received") already says what a receiving
    // status of the same words would (compared in English, where the two
    // vocabularies share their labels).
    const receiptStatusRepeatsOrder = pageCopy(receivedStatus(selectedPO, facts), "en-US") === workspaceCopy(String(selectedPO.status), "en-US");
    const orderWords = words(selectedPO.currency);
    const nextAction = poActionText(nextActionForPo(selectedPO, facts), orderWords);
    const payment = paymentOf(selectedPO, facts);
    const overviewFields: OverviewField[] = [
      { label: say("Source PR", "来源采购申请"), value: selectedPO.sourceRequest ? sourceRequestNumber : copy("未从采购申请创建") },
      // A PO need not come from a request or an RFQ: neither is a gap (owner, 2026-11-03).
      { label: copy("来源询价单"), value: selectedPO.sourceRfq ? sourceRfqNumber : copy(selectedPO.sourceRequest ? "未经询价，由采购申请创建" : "未经询价") },
      { label: supplierLabel, value: selectedPO.supplier },
      { label: copy("采购负责人"), value: selectedPO.owner },
      { label: copy("创建日期"), value: day(selectedPO.created) },
      { label: issued.label, value: day(issued.value) },
      { label: copy("预计到货"), value: day(selectedPO.eta) },
      { label: copy("目标仓库"), value: poLines[0]?.warehouse || warehouseName(selectedPO.warehouseId) || copy("目标仓库待补齐") },
      { label: copy("订单金额"), value: fmt(poAmount(selectedPO)) },
      ...(receiptStatusRepeatsOrder ? [] : [{ label: copy("收货状态"), value: statusChip(receivedStatus(selectedPO, facts)) }]),
      { label: copy("发票状态"), value: statusChip(invoiceStatus(selectedPO, facts)) },
      { label: copy("匹配状态"), value: statusChip(matchStatus(selectedPO, facts)) },
      // Paid, partly paid or outstanding on the approved supplier invoices, with the amounts.
      { label: say("Payment", "付款"), value: <StatusChip label={paymentStateLabel(payment.state, language)} tone={PAYMENT_TONES[payment.state]} testId="po-payment-status" />, helper: paymentAmountsText(payment, orderWords) || undefined },
      { label: copy("当前下一步"), value: <span data-testid="po-next-action">{nextAction}</span> },
      // Plain words: is anything late to arrive? The note says what.
      { label: say("Late deliveries", "逾期未到"), value: <StatusChip label={delayed ? say("Some lines are late", "有逾期行") : say("None", "无")} tone={delayed ? "warning" : "success"} />, helper: delayNote },
    ];
    const lineLabel = poLineLabel;
    const qty = (value: number, unit: string) => `${formatNumber(value)} ${unitLabel(unit, language, value)}`;
    // A few document numbers, each kept on one line, then how many more.
    const someNumbers = (numbers: string[]) => <>
      {numbers.slice(0, 2).map((number, index) => <React.Fragment key={number}>{index ? ", " : ""}<span className="whitespace-nowrap">{number}</span></React.Fragment>)}
      {numbers.length > 2 ? ` ${say(`+${formatNumber(numbers.length - 2)} more`, `等 ${formatNumber(numbers.length)} 张`)}` : null}
    </>;
    const grnColumns: EvidenceColumn<GrnEvidenceRow>[] = [
      { key: "grn", label: say("Receipt", "收货单"), width: 180, render: (row) => <>
        <button type="button" className={`${tableLinkClass} whitespace-nowrap text-blue-600`} onClick={() => openReceipt(row.grn)} data-testid="po-receipt-number">{row.receiptNumber}</button>
        <Sub><span className="whitespace-nowrap" title={lineIdTitle(row.grnLineId)}>{lineName(row.grnLineNumber)}</span></Sub>
      </> },
      { key: "poLine", label: say("PO line", "采购订单行"), width: 200, render: (row) => <>
        <div className="whitespace-nowrap">{lineLabel(row.poLineId)}</div>
        <Sub>{copy(row.sku)}</Sub>
      </> },
      // Accepted into stock, with what was rejected beside it.
      { key: "receivedQty", label: copy("收货数量"), width: 130, align: "right", render: (row) => <span data-testid="po-receipt-quantity">
        <span className="whitespace-nowrap">{qty(row.acceptedQty, row.unit)}</span>
        {row.rejectedQty > 0 ? <> <span className="whitespace-nowrap">{say(`(${formatNumber(row.rejectedQty)} rejected)`, `（拒收 ${formatNumber(row.rejectedQty)}）`)}</span></> : null}
      </span> },
      { key: "arrived", label: copy("收货日期"), width: 130, render: (row) => <>
        <div className="whitespace-nowrap">{day(row.arrived) || "—"}</div>
        <Sub>{copy(row.receiver)}</Sub>
      </> },
      // The accepted quantity at the PO price, to the cent.
      { key: "lineAmount", label: copy("行金额"), width: 130, align: "right", render: (row) => <>
        <div className="whitespace-nowrap" data-testid="po-receipt-amount">{fmt(hideAmounts ? null : amountOrNull(row.lineAmount))}</div>
        <Sub><span className="whitespace-nowrap">{fmt(hideAmounts ? null : amountOrNull(row.unitPrice))} / {unitLabel(row.unit, language, 1)}</span></Sub>
      </> },
      { key: "status", label: copy("收货状态"), width: 150, render: (row) => <>
        <StatusChip label={codeLabel(row.receiptStatus)} tone={statusToneOf(row.receiptStatus)} />
        <Sub>{say("QC", "质检")}: {copy(row.qcStatus)}</Sub>
        {/* The rejected quantity with the reason recorded on the receipt, and the way to it. */}
        {row.rejectedQty > 0 ? <Sub>
          <span data-testid="po-receipt-rejection">{say(`${formatNumber(row.rejectedQty)} rejected: `, `拒收 ${formatNumber(row.rejectedQty)}：`)}{row.rejectionReason || say("no reason recorded", "未记录原因")}</span>
          {" · "}<button type="button" className="text-blue-600 hover:underline" onClick={() => openReceipt(row.grn)}>{say("View receipt", "查看收货单")}</button>
        </Sub> : null}
      </> },
      // The supplier invoice lines that name this receipt line, by number.
      { key: "invoiceLine", label: say("Invoice line", "发票行"), width: 180, render: (row) => row.invoiceLineIds.length ? <>
        <div className="break-words" title={lineIdTitle(row.invoiceLineIds[0])} data-testid="po-receipt-invoice">{invoiceLineLabel(row.invoiceLineIds[0])}{row.invoiceLineIds.length > 1 ? say(` +${formatNumber(row.invoiceLineIds.length - 1)} more`, ` 等 ${formatNumber(row.invoiceLineIds.length)} 行`) : ""}</div>
        <Sub>{say("Counted in the invoice match", "已计入发票匹配")}</Sub>
      </> : <div style={{ color: A.sub }} data-testid="po-receipt-invoice">{say("Not invoiced yet", "尚未开票")}</div> },
    ];
    const invoiceColumns: EvidenceColumn<InvoiceEvidenceRow>[] = [
      { key: "invoice", label: say("Supplier invoice", "采购发票"), width: 180, render: (row) => <>
        {canOpenInvoice
          ? <button type="button" className={`${tableLinkClass} whitespace-nowrap text-blue-600`} onClick={() => openInvoice(row.invoiceNumber)} data-testid="po-invoice-number">{row.displayNumber}</button>
          : <span className="whitespace-nowrap font-medium" style={{ color: A.blue }} data-testid="po-invoice-number">{row.displayNumber}</span>}
        <Sub><span className="whitespace-nowrap" title={lineIdTitle(row.invoiceLineId)}>{lineName(row.invoiceLineNumber)}</span></Sub>
      </> },
      { key: "poLine", label: say("PO line", "采购订单行"), width: 210, render: (row) => <>
        <div className="whitespace-nowrap">{lineLabel(row.poLineId)}</div>
        <Sub>{copy(row.sku)}</Sub>
        <Sub><span className="whitespace-nowrap" title={lineIdTitle(row.grnLineId)}>{say("Receipt: ", "收货：")}{receiptLineLabel(row.grnLineId) || say("not linked", "未关联")}</span></Sub>
      </> },
      { key: "quantity", label: copy("开票数量"), width: 120, align: "right", render: (row) => <>
        <div className="whitespace-nowrap">{qty(row.quantity, row.unit)}</div>
        <Sub><span className="whitespace-nowrap">@ {formatCurrencyAmount(row.unitPrice, row.currency)}</span></Sub>
      </> },
      { key: "invoiceAmount", label: copy("发票金额"), width: 120, align: "right", render: (row) => <span className="whitespace-nowrap">{formatCurrencyAmount(row.invoiceAmount, row.currency)}</span> },
      { key: "totalAmount", label: say("Total incl. tax", "含税总额"), width: 140, align: "right", render: (row) => {
        // What is paid on this invoice, once it is approved for payment.
        const paid = paymentSummary([{ hasVariance: false, payment: row.payment }]);
        const paidText = paymentAmountsText(paid, storyWords(language, formatNumber, row.currency));
        return <>
          <div className="whitespace-nowrap font-medium">{formatCurrencyAmount(row.totalAmount, row.currency)}</div>
          <Sub><span className="whitespace-nowrap">{copy("税额")} {formatCurrencyAmount(row.taxAmount, row.currency)}</span></Sub>
          {/* "Paid", or what is paid and still open; the state alone when amounts are hidden. */}
          {paid.state !== "none" ? <Sub><span data-testid="po-invoice-payment">{paid.state === "paid" || !paidText ? paymentStateLabel(paid.state, language) : paidText}</span></Sub> : null}
        </>;
      } },
      { key: "invoiceDate", label: copy("发票日期"), width: 120, render: (row) => <>
        <div className="whitespace-nowrap">{day(row.invoiceDate) || "—"}</div>
        <Sub><span className="whitespace-nowrap">{say("Due", "到期")} {day(row.dueDate) || "—"}</span></Sub>
      </> },
      { key: "matchStatus", label: copy("匹配状态"), width: 160, render: (row) => <>
        {statusChip(row.matchState)}
        {row.hasVariance ? <Sub>{copy(row.varianceType)}{row.varianceAmount ? <> · <span className="whitespace-nowrap">{formatCurrencyAmount(row.varianceAmount, row.currency)}</span></> : null}</Sub> : null}
      </> },
    ];
    // Price and amount differences only mean something once the line is invoiced.
    const invoiced = (row: MatchEvidenceRow) => row.invoiceQty > 0 || !["尚未开票", ""].includes(row.invoiceLineId);
    const matchMoney = (value: number) => fmt(hideAmounts ? null : value);
    // A variance with its sign: +$200.00 over the PO price, -$50.00 under it.
    const signedMoney = (value: number) => (hideAmounts ? fmt(null) : `${value >= MATCH_MONEY_EPSILON ? "+" : ""}${fmt(Math.abs(value) < MATCH_MONEY_EPSILON ? 0 : value)}`);
    const matchColumns: EvidenceColumn<MatchEvidenceRow>[] = [
      // The line with every receipt and supplier invoice on it, by number.
      { key: "poLine", label: say("PO line", "采购订单行"), width: 220, render: (row) => <>
        <div className="whitespace-nowrap">{lineLabel(row.poLineId)}</div>
        <Sub><span data-testid="po-match-receipts">{row.receiptIds.length ? <>{say(row.receiptIds.length > 1 ? "Receipts: " : "Receipt: ", "收货：")}{someNumbers(row.receiptIds.map(receiptNumberFor))}</> : say("Receipt: none yet", "收货：尚无")}</span></Sub>
        <Sub><span data-testid="po-match-invoices">{row.invoiceIds.length ? <>{say(row.invoiceIds.length > 1 ? "Invoices: " : "Invoice: ", "发票：")}{someNumbers(row.invoiceIds.map(invoiceNumberFor))}</> : say("Invoice: none yet", "发票：尚无")}</span></Sub>
      </> },
      { key: "poQty", label: copy("订购数量"), width: 80, align: "right", render: (row) => formatNumber(row.poQty) },
      { key: "receivedQty", label: copy("已收数量"), width: 110, align: "right", render: (row) => <>
        {formatNumber(row.receivedQty)}
        {/* Still to receive on the order: information, not a match variance. */}
        {row.receivingGap > 0 ? <Sub>{say(`${formatNumber(row.receivingGap)} still to receive`, `仍待收货 ${formatNumber(row.receivingGap)}`)}</Sub> : null}
      </> },
      { key: "invoiceQty", label: copy("开票数量"), width: 120, align: "right", render: (row) => <>
        {formatNumber(row.invoiceQty)}
        {row.qtyVariance > 0
          ? <Sub>{say(`${formatNumber(row.qtyVariance)} more than received`, `超出已收 ${formatNumber(row.qtyVariance)}`)}</Sub>
          : row.invoiceGap > 0 && invoiced(row) ? <Sub>{say(`${formatNumber(row.invoiceGap)} received, not invoiced`, `已收未开票 ${formatNumber(row.invoiceGap)}`)}</Sub> : null}
      </> },
      { key: "unitPrice", label: copy("单价"), width: 130, align: "right", render: (row) => <>
        <div className="whitespace-nowrap">{say("PO", "订单")} {matchMoney(row.poUnitPrice)}</div>
        <Sub><span className="whitespace-nowrap">{say("Invoice", "发票")} {invoiced(row) ? matchMoney(row.invoiceUnitPrice) : "—"}</span></Sub>
      </> },
      // The invoiced quantity at the PO price against what was invoiced, net of tax.
      { key: "amount", label: say("Amount (net)", "金额（不含税）"), width: 160, align: "right", render: (row) => invoiced(row) ? <>
        <div className="whitespace-nowrap">{say("Expected", "应开")} {matchMoney(row.expectedAmount)}</div>
        <Sub><span className="whitespace-nowrap">{say("Invoiced", "发票")} {matchMoney(row.invoiceAmount)}</span></Sub>
        {row.taxAmount ? <Sub><span className="whitespace-nowrap">{copy("税额")} {matchMoney(row.taxAmount)}</span></Sub> : null}
      </> : "—" },
      { key: "amountVariance", label: copy("金额差异"), width: 140, align: "right", render: (row) => invoiced(row) ? <>
        <div className="whitespace-nowrap font-medium">{signedMoney(row.amountVariance)}</div>
        {Math.abs(row.priceVariance) >= MATCH_MONEY_EPSILON ? <Sub><span className="whitespace-nowrap">{say("Price", "价格")} {signedMoney(row.priceVariance)}</span></Sub> : null}
      </> : "—" },
      // A line with nothing received and nothing invoiced is simply waiting:
      // gray, not the orange of a receipt missing behind an invoice.
      { key: "status", label: copy("匹配状态"), width: 170, render: (row) => row.status === "缺少收货" && row.receivedQty === 0 && !invoiced(row) ? <>
        <StatusChip label={copy("未收货")} tone="neutral" />
      </> : <>
        {statusChip(row.status)}
        <Sub>{say(...row.suggestedAction)}</Sub>
      </> },
    ];

    // Nothing received and nothing invoiced: the match reads as one sentence.
    const nothingToMatch = grnRows.length === 0 && invoiceRows.length === 0;

    // The order's number is the heading, under a small "Purchase order" label;
    // its status is shown once, beside that label.
    return (
      <div className="space-y-3">
      <BackToListLink list="orders" />
      <DocumentShell
        title={selectedPONumber}
        moduleLabel={say("Purchase order", "采购订单")}
        status={selectedPO.status}
        statusTone={poStatusToneOf(selectedPO.status)}
        subtitle={selectedPO.supplier}
      >
        <div className="space-y-3" data-testid="po-header-actions">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <nav aria-label={say("Related records", "相关单据")} className="flex flex-wrap items-center gap-x-4 gap-y-1">
              {relatedLinks.map((link) => (
                <button key={link.key} type="button" onClick={link.onClick} className={relatedLinkClass}>{link.label}</button>
              ))}
            </nav>
          </div>
          {/* The step that moves the order on is the one blue button; the
              document and supplier invoice entry sit to the right. */}
          <div className="flex flex-wrap items-center gap-2">
            <PurchaseOrderReceiveAction poId={selectedPO.po} status={selectedPO.status} showNote={false} />
            <PurchaseOrderWorkflowActions poId={selectedPO.po} status={selectedPO.status} version={selectedPO.version} onChanged={loadWorkbench} showNote={false} />
            <div className="flex flex-wrap items-center gap-2 sm:ml-auto">
              {/* A bill can arrive before or after the goods. */}
              {BILLABLE_PO_STATUSES.has(selectedPO.status) && <span className="inline-flex [&_button]:h-8 [&_button]:py-0"><RecordBillAction purchaseOrderId={selectedPO.po} /></span>}
              {/* The PO as a document to print or save as PDF; the buyer sends it. */}
              {canOpenRoute("procurement:order-document") && (
                <button
                  type="button"
                  data-testid="po-open-document"
                  onClick={() => routerNavigate(`/app/procurement/orders/${encodeURIComponent(selectedPO.po)}/document`)}
                  className={poSecondaryButtonClass}
                >
                  {t("documents.openPo")}
                </button>
              )}
            </div>
          </div>
          {actionNotes.length ? <p className="text-[11px] leading-4" style={{ color: A.sub }} data-testid="po-action-notes">{actionNotes.join(" ")}</p> : null}
        </div>

        <div>
          <SectionTitle title={copy("概览")} />
          <OverviewFields fields={overviewFields} />
        </div>

        <PoProgress steps={poTimeline(selectedPO, facts, day, orderWords)} />

        <div>
          <SectionTitle title={say("PO line items", "采购订单明细行")} right={<Chip label={say(`${formatNumber(poLines.length)} ${poLines.length === 1 ? "line" : "lines"}`, `${formatNumber(poLines.length)} 行`)} color={A.blue} bg="#f0f6ff" />} />
          <PurchaseOrderLineCards
            rows={poLines}
            currency={selectedPO.currency}
            priceHistory={(poLineId) => poLineHistoryKeys.get(poLineId) ? (
              <div className="mt-1">
                <PriceHistoryFacts history={poPriceHistory.histories.get(poLineHistoryKeys.get(poLineId) || "")} state={poPriceHistory.state} testId={`po-line-price-history-${poLineId}`} excludesThisOrder compact supplierId={selectedPO.supplierId} />
              </div>
            ) : null}
          />
        </div>

        <PurchaseOrderPromiseDates poId={selectedPO.po} onChanged={loadWorkbench} />

        <section
          ref={fulfillmentFocusRef}
          data-testid="po-fulfillment-focus"
          data-focus-highlight={highlightedArea === "receiving-invoice-variance" || highlightedArea === "receiving" || highlightedArea === "invoice" || highlightedArea === "exception" ? "true" : "false"}
          className="scroll-mt-20 space-y-5 rounded-xl p-2 transition-all"
          style={highlightedArea && highlightedArea !== "evidence" ? { background: "#fff8e6", boxShadow: `0 0 0 2px ${A.orange}55` } : undefined}
        >
          {highlightedArea && highlightedArea !== "evidence" ? (
            <Card className="p-3" style={{ background: "#fffaf0", borderColor: `${A.orange}55` }}>
              <div className="text-xs font-semibold" style={{ color: A.orange }}>{copy("AI 已定位：收货、发票差异与建议下一步")}</div>
              <div className="mt-1 text-[11px] leading-5" style={{ color: A.gray1 }}>
                {copy(receivedStatus(selectedPO, facts))} · {copy(invoiceStatus(selectedPO, facts))}{copy("· 建议：")}{nextAction}
              </div>
            </Card>
          ) : null}
        <div>
          <SectionTitle title={say("Receipt lines", "收货明细行")} right={<span className="text-xs" style={{ color: A.sub }}>{copy("对照采购订单查看实收、质检和差异记录。")}</span>} />
          <EvidenceTable
            testId="po-receipt-lines"
            rows={grnRows}
            rowKey={(row) => `${row.grn}:${row.grnLineId}`}
            emptyText={say("No receipts for this PO yet.", "该采购订单暂无收货记录。")}
            columns={grnColumns}
          />
        </div>

        <div>
          <SectionTitle title={say("Supplier invoice lines", "采购发票明细行")} />
          <EvidenceTable
            testId="po-invoice-lines"
            rows={invoiceRows}
            rowKey={(row) => `${row.invoiceNumber}:${row.invoiceLineId}`}
            emptyText={copy("当前采购订单暂无发票行。")}
            columns={invoiceColumns}
          />
        </div>
        <div>
          <SectionTitle title={copy("三单匹配")} right={nothingToMatch ? null : <span className="text-xs" style={{ color: A.sub }}>{say("One row per PO line: invoiced vs PO price and received quantity", "按采购订单行核对：开票对照订单价与已收数量")}</span>} />
          {nothingToMatch && matchRows.length ? (
            <Card className="p-4 text-xs leading-5" style={{ color: A.sub }} data-testid="po-match-lines" data-match-state="nothing-yet">
              {matchRows.length === 1 ? say(
                "Nothing to match yet. The line is matched once its goods are received and the supplier invoice is recorded.",
                "尚无可匹配。该行在收货并录入供应商发票后进行匹配。",
              ) : say(
                `Nothing to match yet. Each of the ${formatNumber(matchRows.length)} lines is matched once its goods are received and the supplier invoice is recorded.`,
                `尚无可匹配。${formatNumber(matchRows.length)} 行均在收货并录入供应商发票后逐行匹配。`,
              )}
            </Card>
          ) : (
            <EvidenceTable
              testId="po-match-lines"
              rows={matchRows}
              rowKey={(row) => row.poLineId}
              emptyText={copy("当前采购订单没有明细行。")}
              columns={matchColumns}
            />
          )}
        </div>

        </section>


        <DocumentTotals
          totals={[
            { label: copy("订单金额"), value: fmt(poAmount(selectedPO)), tone: "info" },
            { label: say("PO lines", "采购订单行"), value: formatNumber(poLines.length) },
            { label: say("Receipt lines", "收货行"), value: formatNumber(grnRows.length), tone: grnRows.length ? "success" : undefined },
            { label: say("Invoice lines", "发票行"), value: formatNumber(invoiceRows.length), tone: invoiceRows.length ? "success" : undefined },
          ]}
          columns={4}
        />


        <div>
          <SectionTitle title={copy("变更记录")} />
          <DocumentHistoryPanel
            entityType="purchaseOrder"
            entityId={selectedPO.po}
            title={copy("订单变更记录")}
            emptyText="此订单暂无变更记录。收货和发票见上方。"
            refreshKey={selectedPO.lastAuditId || selectedPO.auditTrailIds?.join(",") || selectedPO.status}
          />
        </div>

      </DocumentShell>
      </div>
    );
  })();

  if (loading || !loadedForAddress) {
    return <Card className="p-12 text-center text-sm" data-testid="po-loading-state">{copy("正在加载采购订单…")}</Card>;
  }

  if (loadError) {
    return (
      <Card className="p-12 text-center" data-testid="po-error-state">
        <div className="text-sm font-semibold">{copy("采购订单加载失败")}</div>
        <div className="mt-2 text-xs" style={{ color: A.sub }} title={procurementErrorCode(loadError.error)}>{procurementErrorText(loadError.error, language, ["Try again in a moment.", "请稍后重试。"])}</div>
        <button type="button" onClick={() => loadWorkbench()} className="mt-4 rounded-lg bg-blue-600 px-4 py-2 text-xs font-semibold text-white">{copy("重试")}</button>
      </Card>
    );
  }

  if (viewMode === "detail") {
    return (
      <div className="space-y-5">
        {selectedPO ? detailContent : (
          <Card className="flex flex-wrap items-center justify-center gap-3 p-8 text-center text-xs" style={{ color: A.gray2 }}>
            {copy("未找到采购订单。")}
            <RecoveryActions actions={[{ key: "po-list", label: copy("返回采购订单"), onClick: returnToList, kind: "list" }]} />
          </Card>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className={metricGridClass}>
        <ActionableMetricCard label={copy("已承诺采购订单金额")} value={!summary ? "—" : committedHidden ? copy("受限") : committedValue.length === 0 ? formatCurrencyAmount(0, "") : committedValue.map((row) => formatCurrencyAmount(row.amount, row.currency)).join(" · ")} description={loading ? copy("加载中") : `${summary?.committedOrderCount ?? 0} ${copy("张已承诺订单（已批准、已下达或已收货）")}`} to="/app/procurement/orders" icon={FileText} color={A.blue} />
        <ActionableMetricCard label={copy("未结采购订单")} value={summary ? String(summary.openOrderCount) : "—"} description={copy("已承诺且仍有待收数量")} to="/app/procurement/orders?status=open" icon={Truck} color={A.orange} />
        <ActionableMetricCard label={copy("发票差异")} value={String(invoiceExceptions)} description={copy("采购与财务共同复核")} to="/app/procurement/bills?matchStatus=variance" icon={AlertCircle} color={A.red} />
        <ActionableMetricCard label={copy("匹配复核")} value={String(matchExceptions)} description={copy("查看三单匹配异常")} to="/app/procurement/bills?status=exception" icon={ShieldCheck} color={A.purple} />
      </div>

      <ListSearchCard
        title={copy("采购订单查询")}
        subtitle={say("Search POs, source PRs and RFQs, suppliers, receipts, invoices, and match status", "查询采购订单、来源采购申请和询价单、供应商、收货、发票和三单匹配状态")}
        actions={<>
          <ResetButton onClick={resetFilters} />
          <RefreshButton onClick={() => loadWorkbench()} />
          <ExportButton onClick={exportCsv} />
        </>}
      >
        <Field label={say("PO number", "采购订单号")}>
          <input value={filters.poNumber} onChange={(event) => updateFilter("poNumber", event.target.value)}
            placeholder="PO-202611-0001" style={inputStyle} />
        </Field>
        <Field label={supplierLabel}>
          <input value={filters.supplier} onChange={(event) => updateFilter("supplier", event.target.value)}
            placeholder={copy("供应商名称")} style={inputStyle} />
        </Field>
        <Field label={copy("物料 / SKU")}>
          <input value={filters.skuOrItem} onChange={(event) => updateFilter("skuOrItem", event.target.value)}
            placeholder={copy("SKU 或品名")} style={inputStyle} />
        </Field>
        <Field label={copy("状态")}>
          <select value={filters.status} onChange={(event) => updateFilter("status", event.target.value as PurchaseOrderWorkbenchFilters["status"])}
            style={inputStyle}>
            {statusOptions.map((status) => <option key={status} value={status}>{statusOptionLabel(status)}</option>)}
          </select>
        </Field>
        <Field label={copy("来源")}>
          <select value={filters.source} onChange={(event) => updateFilter("source", event.target.value)}
            style={inputStyle}>
            <option value="全部">{copy("全部")}</option>
            {sourceOptions.map((source) => (
              <option key={source} value={source}>{copy(source === "forecast" ? "预测" : source === "manual" ? "手工" : source)}</option>
            ))}
          </select>
        </Field>
        <Field label={copy("负责人")}>
          <input value={filters.owner} onChange={(event) => updateFilter("owner", event.target.value)}
            placeholder={copy("采购负责人")} style={inputStyle} />
        </Field>
        <Field label={say("ETA from", "预计到货起")}>
          <input type="date" value={filters.etaFrom} max={filters.etaTo || undefined} onChange={(event) => updateFilter("etaFrom", event.target.value)}
            style={inputStyle} />
        </Field>
        <Field label={say("ETA to", "预计到货止")}>
          <input type="date" value={filters.etaTo} min={filters.etaFrom || undefined} onChange={(event) => updateFilter("etaTo", event.target.value)}
            style={inputStyle} />
        </Field>
      </ListSearchCard>

      <ListCard title={copy("采购订单列表")} total={filtered.length} shown={paged.pageRows.length}>
        <div className={tableScrollClass}>
          {/* Fixed column widths that fit beside the sidebar at 1440px, so the
              pinned Actions column never covers the last data column. */}
          <table className={`w-full min-w-[1150px] table-fixed text-left ${tableBodyTextClass}`}>
            <thead>
              <tr style={listHeadRowStyle}>
                <th className={`${thClass} sticky left-0 z-20 w-[160px] bg-white`} style={{ color: A.gray1 }}>{say("PO number", "采购订单号")}</th>
                <th className={`${thClass} w-[180px]`} style={{ color: A.gray1 }}>{supplierLabel}</th>
                <th className={`${thClass} w-[130px]`} style={{ color: A.gray1 }}>{copy("状态")}</th>
                <th className={`${thClass} w-[100px]`} style={{ color: A.gray1 }}>{copy("采购负责人")}</th>
                <th className={`${thRightClass} w-[120px]`} style={{ color: A.gray1 }}>{copy("订单金额")}</th>
                <th className={`${thClass} w-[120px]`} style={{ color: A.gray1 }}>{copy("预计到货")}</th>
                <th className={`${thClass} w-[220px]`} style={{ color: A.gray1 }}>{receiptInvoiceLabel}</th>
                <th className={`${thClass} sticky right-0 z-20 w-[120px] bg-white`} style={{ color: A.gray1 }}>{copy("操作")}</th>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 && (
                <ListStateRow colSpan={8} state="empty" title={copy("当前工作区没有符合条件的采购订单。")} />
              )}
              {paged.pageRows.map((order, index) => {
                const firstGrn = grnsForPo(order.po, facts)[0];
                const firstInvoice = invoicesForPo(order.po, facts)[0];
                const late = daysLate(order);
                const menuItemClass = "w-full rounded px-2 py-1.5 text-left text-xs hover:bg-slate-50";
                return (
                  <tr key={order.po} className={listRowClass} style={listRowStyle(index, paged.pageRows.length)}>
                    <td className={`${tdIdClass} sticky left-0 z-10 truncate bg-white`}>
                      <BusinessEntityLink entityType="purchase_order" entityId={order.po} number={purchaseOrderNumber(order)} className={tableLinkClass} />
                    </td>
                    <td className={`${tdNameClass} truncate font-medium`} title={order.supplier}><BusinessEntityLink entityType="supplier" entityId={order.supplierId}>{order.supplier}</BusinessEntityLink></td>
                    <td className={tdNowrapClass}><POStatusPill status={order.status} /></td>
                    <td className={`${tdNowrapClass} truncate`} style={{ color: A.sub }} title={order.owner}>{order.owner}</td>
                    <td className={`${tdNumericRightClass} font-semibold`} style={{ color: A.label }}>{formatCurrencyAmount(poAmount(order), order.currency)}</td>
                    {/* An open order past its expected arrival reads red, with how many days late. */}
                    <td className={tdNowrapClass} style={{ color: late ? A.red : A.sub }}>
                      <div className={late ? "font-medium" : undefined}>{order.eta ? day(order.eta) : "—"}</div>
                      {late ? <div className="mt-0.5" data-testid={`po-late-${order.po}`}><StatusChip label={say(late === 1 ? "1 day late" : `${formatNumber(late)} days late`, `逾期 ${formatNumber(late)} 天`)} tone="danger" /></div> : null}
                    </td>
                    <td className={tdNowrapClass}>
                      {/* Receipt and invoice side by side; the match only when there is one to read. */}
                      <div className="flex flex-wrap items-center gap-1">
                        {statusChip(receivedStatus(order, facts))}
                        {statusChip(invoiceStatus(order, facts))}
                      </div>
                      {matchStatus(order, facts) !== "尚无可匹配" ? <div className="mt-1 truncate text-[11px] text-slate-500" title={copy(matchStatus(order, facts))}>{copy(matchStatus(order, facts))}</div> : null}
                    </td>
                    <td className={`${tdActionClass} sticky right-0 z-10 !min-w-0 bg-white`}>
                      <div className="flex items-center gap-1.5">
                        <button onClick={() => openDetail(order.po)} className={rowActionClass.primary}>{copy("查看")}</button>
                        <RowMenu label={copy("更多")} testId={`po-row-more-${order.po}`}>
                          {/* What can be done next on the order, by the detail page's rules, then where to look. */}
                          {entryRules.canReceive(order.status) && <button type="button" data-testid={`po-row-receive-${order.po}`} onClick={() => routerNavigate(receiveOrderPath(order.po))} className={`${menuItemClass} font-semibold text-blue-700`}>{say("Receive", "收货")}</button>}
                          {entryRules.canRecordBill(order.status) && <button type="button" data-testid={`po-row-record-bill-${order.po}`} onClick={() => routerNavigate(recordBillPath(order.po))} className={menuItemClass}>{say("Record supplier invoice", "录入采购发票")}</button>}
                          {firstGrn && <button type="button" onClick={() => navigateOrderWithReturn(order, "procurement:receiving", { entityType: "receiving_doc", entityId: firstGrn.grn }, receiptNumberOf(firstGrn))} className={menuItemClass}>{copy("查看收货单")}</button>}
                          {firstInvoice && canOpenRoute("procurement:bills") && <button type="button" onClick={() => navigateOrderWithReturn(order, "procurement:bills", { entityType: "supplier_invoice", entityId: firstInvoice.invoiceNumber }, invoiceNumberOf(firstInvoice))} className={menuItemClass}>{copy("查看采购发票")}</button>}
                          {canOpenRoute("procurement:match") && (firstGrn || firstInvoice) && <button type="button" onClick={() => navigateOrderWithReturn(order, "procurement:match")} className={menuItemClass}>{copy("查看三单匹配")}</button>}
                          {order.sourceRequest && <button type="button" onClick={() => navigateOrderWithReturn(order, "procurement:requests", { entityType: "purchase_request", entityId: order.sourceRequest }, documentNumberFor("purchase_request", order.sourceRequest, order.prNumber))} className={menuItemClass}>{say("View source PR", "查看来源采购申请")}</button>}
                          {order.sourceRfq && <button type="button" onClick={() => navigateOrderWithReturn(order, "procurement:rfq", { entityType: "rfq", entityId: order.sourceRfq }, documentNumberFor("rfq", order.sourceRfq, order.rfqNumber))} className={menuItemClass}>{say("View source RFQ", "查看来源询价单")}</button>}
                        </RowMenu>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <ListPager page={paged.page} pageSize={PO_LIST_PAGE_SIZE} total={filtered.length} onPage={paged.setPage} testId="po-list-pager" />
      </ListCard>

    </div>
  );
}
