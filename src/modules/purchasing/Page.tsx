import { invoiceVarianceLabelKey, isNoInvoiceVariance } from "../../domain/procurement/variance-types";
import { useWorkspaceCopy } from "../../i18n/useWorkspaceCopy";
import { useI18n } from "../../i18n/I18n";
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
import { apiJson } from "../../lib/api-client";
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
  type PurchaseOrderWorkbenchFilters,
} from "./filters";
import { POStatusPill, poStatusToneOf } from "./components/POStatusPill";
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
} from "../../components/ui/workbenchTable";
import { workspaceCopy } from "../../i18n/workspaceCopy";
import { ExportButton, ListCard, ListSearchCard, ListStateRow, ResetButton, StatusChip, listButtonClass, metricGridClass, listHeadRowStyle, listRowClass, listRowStyle, rowActionClass, statusToneOf, type StatusTone } from "../../components/ui/listLayout";
import { PurchaseOrderReceiveAction, PurchaseOrderWorkflowActions, poSecondaryButtonClass, usePurchaseOrderActionNotes } from "./components/PurchaseOrderWorkflowActions";
import { RecordBillAction } from "../../components/business/BillingEntryActions";
import { PurchaseOrderPromiseDates } from "./components/PurchaseOrderPromiseDates";

const copy = (label: string) => workspaceCopy(label, typeof document === "undefined" ? "en-US" : document.documentElement.lang);
// Statuses in which a bill can be recorded: a supplier's bill can arrive
// before the goods (it then waits for the receipt) or after them.
const BILLABLE_PO_STATUSES = new Set(["approved", "issued", "partially_received", "received", "fully_received", "closed"]);
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
  grnLineId: string;
  po: string;
  poLineId: string;
  supplier: string;
  sku: string;
  receivedQty: number;
  unit: string;
  arrived: string;
  receiver: string;
  unitPrice: number;
  lineAmount: number;
  status: string;
  qcStatus: string;
  invoiceImpact: string;
  invoiceLine: string;
  note: string;
};

type InvoiceEvidenceRow = {
  currency?: string;
  invoiceNumber: string;
  invoiceLineId: string;
  supplier: string;
  po: string;
  poLineId: string;
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
  matchStatus: string;
  varianceType: string;
  varianceAmount: number;
  risk: string;
};

// One PO line against everything invoiced on it. Amounts are net of tax.
type MatchEvidenceRow = {
  poLineId: string;
  grnLineId: string;
  invoiceLineId: string;
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
  suggestedAction: string;
};

// The receipt, invoice, match and risk states this page derives, in the brand
// tones: gray not started, blue under way, teal done, orange waiting on
// someone or at risk, red for a variance or exception.
const EVIDENCE_TONES: Record<string, StatusTone> = {
  "未收货": "neutral", "待收货": "neutral", "部分收货": "info", "部分到货": "info", "已收货": "success", "异常处理": "danger",
  "未开票": "neutral", "已开票": "info", "已付款": "success", "发票差异": "danger",
  "缺少发票": "neutral", "缺少收货": "warning", "已匹配": "success", "需人工复核": "warning", "已收未票": "warning", "已票未收": "warning",
  "低风险": "success", "无需收货": "neutral", "通过": "success", "质检中": "info", "质检异常": "danger",
};

function evidenceTone(status: string): StatusTone {
  return EVIDENCE_TONES[status] ?? (/差异/.test(status) ? "danger" : /风险/.test(status) ? "warning" : statusToneOf(status));
}

function statusChip(status: string) {
  return <StatusChip label={copy(status)} tone={evidenceTone(status)} />;
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

// A line made in the app has a random internal id (a UUID), which means
// nothing to a person, so its card is headed by its position instead; a
// readable line number (LOCAL-DEMO-PO-001-LINE-001) is shown as it is.
const INTERNAL_LINE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function PurchaseOrderLineCards({ rows, currency, priceHistory }: { rows: PoEvidenceRow[]; currency?: string; priceHistory?: (poLineId: string) => React.ReactNode }) {
  const copy = useWorkspaceCopy();
  const say = useSay();
  const day = useCalendarDay();
  const { formatNumber } = useI18n();
  if (!rows.length) {
    return <Card className="p-8 text-center text-xs" style={{ color: A.gray2 }}>{copy("当前采购订单没有明细行。")}</Card>;
  }
  return (
    <div className="space-y-3" data-testid="po-line-cards">
      {rows.map((line) => {
        const fmt = (value: number) => formatCurrencyAmount(value, line.currency || currency);
        const groups = [
          {
            title: "来源",
            facts: [
              [say("Source PR line", "来源采购申请行"), line.sourcePrLine],
              [say("Source RFQ line", "来源询价行"), line.sourceRfqLine],
            ],
          },
          {
            title: "订购",
            facts: [
              ["订购数量", `${formatNumber(line.quantity)} ${line.unit}`],
              ["单价", fmt(line.unitPrice)],
              ["行金额", fmt(line.lineAmount)],
            ],
          },
          {
            title: "履约",
            facts: [
              ["已收 / 未收", `${formatNumber(line.receivedQty)} / ${formatNumber(line.remainingQty)} ${line.unit}`],
              ["已开票 / 未开票", `${formatNumber(line.invoicedQty)} / ${formatNumber(line.uninvoicedQty)} ${line.unit}`],
            ],
          },
          {
            title: "交付",
            facts: [
              ["目标仓库", line.warehouse],
              ["需求日期", day(line.requiredDate)],
              ["预计到货", day(line.promisedDate)],
            ],
          },
        ];
        return (
          <article key={line.poLineId} className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0">
                <div className="text-xs font-semibold tabular-nums" style={{ color: A.blue }}>{INTERNAL_LINE_ID.test(line.poLineId) ? `${copy("采购行")} ${line.lineNumber}` : line.poLineId}</div>
                <div className="mt-1 text-sm font-semibold" style={{ color: A.label }}>{line.sku} · {line.itemName}</div>
                {line.supplierOverride ? <div className="mt-1"><SupplierOverrideFlag override={line.supplierOverride} testId="po-line-supplier-override" /></div> : null}
              </div>
              <div className="flex flex-wrap gap-2">
                {statusChip(line.status)}
                {line.risk ? <StatusChip label={copy(line.risk)} tone={evidenceTone(line.risk)} /> : null}
              </div>
            </div>
            {priceHistory?.(line.poLineId)}
            <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              {groups.map((group) => (
                <div key={group.title} className="rounded-lg bg-slate-50 p-3">
                  <div className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: A.gray2 }}>{copy(group.title)}</div>
                  <dl className="mt-2 space-y-2">
                    {group.facts.map(([label, value]) => (
                      <div key={label} className="flex items-start justify-between gap-3 text-xs">
                        <dt className="shrink-0" style={{ color: A.sub }}>{copy(label)}</dt>
                        <dd className="min-w-0 break-words text-right font-medium tabular-nums" style={{ color: A.label }}>{copy(value)}</dd>
                      </div>
                    ))}
                  </dl>
                </div>
              ))}
            </div>
          </article>
        );
      })}
    </div>
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
  const invoiceLine = facts.supplierInvoices.flatMap((invoice) => invoice.lines)
    .find((item) => item.poLine === line.poLineId);
  if (invoiceLine?.unitPrice) return toNumber(invoiceLine.unitPrice);
  const qty = toNumber(line.quantityOrdered);
  return qty ? poLineAmount(line, po) / qty : 0;
}

function invoicesForPo(poId: string | undefined, facts: ProcurementRuntimeFacts) {
  return facts.supplierInvoices.filter((invoice) => invoice.relatedPo === poId);
}

function grnsForPo(poId: string | undefined, facts: ProcurementRuntimeFacts) {
  return facts.receivingDocs.filter((doc) => doc.po === poId);
}

function receivedStatus(po: PurchaseOrder, facts: ProcurementRuntimeFacts) {
  const totals = poTotals(po);
  const grns = grnsForPo(po.po, facts);
  if (grns.some((doc) => doc.status === "异常处理")) return "异常处理";
  if (totals.totalOrderedQty > 0 && totals.totalReceivedQty >= totals.totalOrderedQty) return "已收货";
  if (totals.totalReceivedQty > 0) return "部分收货";
  if (grns.length > 0) return "待收货";
  return "未收货";
}

function invoiceStatus(po: PurchaseOrder, facts: ProcurementRuntimeFacts) {
  const invoices = invoicesForPo(po.po, facts);
  if (!invoices.length) return "未开票";
  if (invoices.some((invoice) => !isNoInvoiceVariance(invoice.varianceType) || invoice.matchStatus === "差异待处理")) return "发票差异";
  if (invoices.every((invoice) => invoice.paid)) return "已付款";
  return "已开票";
}

function matchStatus(po: PurchaseOrder, facts: ProcurementRuntimeFacts) {
  const invoices = invoicesForPo(po.po, facts);
  const grns = grnsForPo(po.po, facts);
  if (!invoices.length) return "缺少发票";
  if (!grns.length || grns.some((doc) => doc.status === "待收货" || doc.status === "质检中")) return "缺少收货";
  const variance = invoices.find((invoice) => !isNoInvoiceVariance(invoice.varianceType) || invoice.varianceAmount > 0);
  if (variance) return invoiceVarianceLabelKey(variance.varianceType);
  if (invoices.every((invoice) => invoice.matchStatus === "自动匹配" || invoice.matchStatus === "已解决")) return "已匹配";
  return "需人工复核";
}

function nextStepForPo(po: PurchaseOrder, facts: ProcurementRuntimeFacts) {
  if (["cancelled", "已取消"].includes(po.status)) return "订单已取消，无需收货";
  // Approved but not issued: the supplier does not have it yet, so nothing
  // can arrive; it is sent first (decision V5).
  if (String(po.status) === "approved") return "发给供应商并标记为下达";
  if (receivedStatus(po, facts) === "未收货") return "等待收货";
  const status = matchStatus(po, facts);
  if (status === "缺少收货") return "等待收货";
  if (status === "缺少发票") return "等待发票";
  if (status === "数量差异") return "复核收货记录";
  if (status === "价格差异") return "复核供应商发票";
  if (status === "已匹配") return "财务协同复核";
  if (receivedStatus(po, facts) === "异常处理") return "生成内部差异说明草稿";
  return "需人工复核";
}

function poTimeline(po: PurchaseOrder, facts: ProcurementRuntimeFacts, day: (value?: string | null) => string): TimelineStep[] {
  const receipt = receivedStatus(po, facts);
  const invoice = invoiceStatus(po, facts);
  const match = matchStatus(po, facts);
  return [
    { label: "来源确认", status: "done", helper: po.sourceRequest || po.sourceRfq || "直接创建（无采购申请或询价）" },
    { label: "PO 已建立", status: "done", helper: day(po.created) },
    { label: "收货证据", status: receipt === "未收货" ? "pending" : receipt === "异常处理" ? "warning" : "done", helper: receipt },
    { label: "发票证据", status: invoice === "未开票" ? "pending" : invoice === "发票差异" ? "warning" : "done", helper: invoice },
    { label: "三单匹配", status: match === "已匹配" ? "done" : match === "缺少发票" || match === "缺少收货" ? "pending" : "warning", helper: match },
    { label: "人工复核", status: match === "已匹配" ? "pending" : "current", helper: nextStepForPo(po, facts) },
  ];
}

// Statuses before the order reaches the supplier: its lines wait on the order,
// not on a receipt.
const NOT_ISSUED_PO_STATUSES = new Set(["draft", "pending_approval", "approved", "rejected", "草稿", "待审批", "已审批", "已驳回"]);

// A line's receipt state from its quantities when they say more than its
// stored status: a line still "open" with goods received is partly received.
function lineReceiptStatus(status: string | undefined, ordered: number, received: number) {
  if (status === "closed") return lineStatusLabel(status);
  if (ordered > 0 && received >= ordered) return "已收货";
  if (received > 0) return "部分到货";
  return lineStatusLabel(status);
}

// The number people read; the id (po) stays in links and calls.
function purchaseOrderNumber(order: PurchaseOrder) {
  return documentNumberFor("purchase_order", order.po, order.number || order.orderNumber);
}

// sourceNumbers: the source request's and RFQ's document numbers, shown in place of their ids.
function buildPoLineRows(po: PurchaseOrder, facts: ProcurementRuntimeFacts, sourceNumbers: { request?: string; rfq?: string } = {}): PoEvidenceRow[] {
  const cancelled = ["cancelled", "已取消"].includes(po.status);
  const notIssued = NOT_ISSUED_PO_STATUSES.has(String(po.status));
  return poLinesOf(po).map((line, index) => {
    const invoiceQty = facts.supplierInvoices.flatMap((invoice) => invoice.lines)
      .filter((invoiceLine) => invoiceLine.poLine === line.poLineId)
      .reduce((sum, invoiceLine) => sum + toNumber(invoiceLine.quantity), 0);
    const ordered = toNumber(line.quantityOrdered);
    const received = toNumber(line.quantityReceived);
    const remaining = lineRemaining(line);
    const unitPrice = unitPriceForLine(line, po, facts);
    return {
      poLineId: line.poLineId,
      lineNumber: index + 1,
      currency: line.currency || po.currency,
      sourcePrLine: po.sourceRequest ? `${sourceNumbers.request || po.sourceRequest}-L${String(index + 1).padStart(3, "0")}` : "无采购申请",
      sourceRfqLine: po.sourceRfq ? `${sourceNumbers.rfq || po.sourceRfq}-L${String(index + 1).padStart(3, "0")}` : "未经询价",
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

const REJECTED_RECEIPT_NOTE = "拒收数量需要采购与财务协同复核";

function buildGrnRows(po: PurchaseOrder, facts: ProcurementRuntimeFacts): GrnEvidenceRow[] {
  const poLines = poLinesOf(po);
  return grnsForPo(po.po, facts).flatMap((grn) => {
    const lines = grnLinesOf(grn);
    return lines.map((line, index) => {
      const poLine = poLines.find((item) => item.poLineId === line.poLineId) || poLines[index] || poLines[0];
      const relatedInvoiceLine = facts.supplierInvoices.flatMap((invoice) => invoice.lines.map((invoiceLine) => ({ invoice, invoiceLine })))
        .find(({ invoice, invoiceLine }) => invoice.relatedPo === po.po && (invoiceLine.grnLine === line.grnLineId || invoiceLine.poLine === poLine?.poLineId));
      const unitPrice = unitPriceForLine(poLine || {}, po, facts);
      const receivedQty = toNumber(line.receivedQty);
      return {
        grn: grn.grn,
        grnLineId: safeText(line.grnLineId, `${grn.grn}-L${String(index + 1).padStart(3, "0")}`),
        po: po.po,
        poLineId: safeText(line.poLineId || poLine?.poLineId, "PO Line 待补齐"),
        supplier: grn.supplier,
        sku: safeText(line.sku || poLine?.sku, "SKU 待补齐"),
        receivedQty,
        unit: safeText(line.unit || poLine?.unit, "件"),
        arrived: grn.arrived,
        receiver: safeText(grn.receiver, "收货人待补齐"),
        unitPrice,
        lineAmount: Math.round(unitPrice * receivedQty),
        status: grn.status,
        qcStatus: toNumber(line.rejectedQty) > 0 || grn.failed > 0 ? "质检异常" : grn.status === "质检中" ? "质检中" : "通过",
        invoiceImpact: relatedInvoiceLine ? "影响发票匹配" : "等待发票匹配",
        invoiceLine: relatedInvoiceLine?.invoiceLine.lineId || "尚未开票",
        note: toNumber(line.rejectedQty) > 0 ? REJECTED_RECEIPT_NOTE : "查看收货记录和匹配影响",
      };
    });
  });
}

function buildInvoiceRows(po: PurchaseOrder, facts: ProcurementRuntimeFacts): InvoiceEvidenceRow[] {
  return invoicesForPo(po.po, facts).flatMap((invoice) => {
    const invoiceLines = invoice.lines.length ? invoice.lines : [{
      lineId: `${invoice.invoiceNumber}-SUMMARY`,
      sku: po.sourceSku || "",
      name: po.sourceName || "",
      poLine: po.lines?.[0]?.poLineId,
      grnLine: grnsForPo(po.po, facts)[0]?.lines?.[0]?.grnLineId,
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
    return invoiceLines.map((line) => ({
    currency: invoice.currency,
    invoiceNumber: invoice.invoiceNumber,
    invoiceLineId: line.lineId,
    supplier: invoice.supplier,
    po: invoice.relatedPo,
    poLineId: safeText(line.poLine, "PO Line 待补齐"),
    grnLineId: safeText(line.grnLine, "GRN / Receipt Line 待补齐"),
    sku: safeText(line.sku, "SKU 待补齐"),
    quantity: toNumber(line.quantity),
    unit: safeText(line.unit, "件"),
    unitPrice: toNumber(line.unitPrice),
    invoiceAmount: toNumber(line.lineSubtotal),
    taxAmount: toNumber(line.taxAmount),
    totalAmount: toNumber(line.lineTotal),
    invoiceDate: invoice.invoiceDate,
    dueDate: invoice.dueDate,
    matchStatus: invoice.matchStatus,
    varianceType: invoiceVarianceLabelKey(line.varianceType || invoice.varianceType),
    varianceAmount: toNumber(line.varianceAmount ?? invoice.varianceAmount),
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

function suggestedActionForStatus(status: string, invoiceGap = 0) {
  if (status === "缺少收货") return "等待收货";
  if (status === "缺少发票" || status === "已收未票") return "等待发票";
  if (status === "已票未收" || status === "数量差异") return "复核收货记录";
  if (status === "价格差异" || status === "金额差异") return "复核供应商发票";
  // Matched so far; the rest of what was received is still to be invoiced.
  if (status === "已匹配" && invoiceGap > MATCH_QTY_EPSILON) return "等待发票";
  return "财务协同复核";
}

const MISSING_PO_LINE = "PO Line 待补齐";

function buildMatchRows(po: PurchaseOrder, facts: ProcurementRuntimeFacts): MatchEvidenceRow[] {
  const grnRows = buildGrnRows(po, facts);
  const invoiceRows = buildInvoiceRows(po, facts);
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
    const receivedQty = line.receivedQty > 0 || !grnLines.length ? line.receivedQty : grnLines.reduce((sum, row) => sum + row.receivedQty, 0);
    const invoiceQty = invoiceLines.reduce((sum, row) => sum + row.quantity, 0);
    const invoiceAmount = invoiceLines.reduce((sum, row) => sum + row.invoiceAmount, 0);
    const expectedAmount = invoiceQty * line.unitPrice;
    const base = {
      poLineId: line.poLineId,
      grnLineId: grnLines[0]?.grnLineId || "尚未收货",
      invoiceLineId: invoiceLines[0]?.invoiceLineId || "尚未开票",
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
    const status = matchStatusForLine(base);
    return { ...base, status, suggestedAction: suggestedActionForStatus(status, base.invoiceGap) };
  });
}

function dataLimitations() {
  return [
    "当前仅基于工作区内 PR、RFQ、PO、GRN 和发票记录判断。",
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
      <dl className="grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-2 lg:grid-cols-4">
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
  const copy = useWorkspaceCopy();
  return (
    <Card className="p-4" data-testid="po-progress">
      <div className={tableScrollClass}>
        <ol className="grid min-w-[640px]" style={{ gridTemplateColumns: `repeat(${steps.length}, minmax(0, 1fr))` }}>
          {steps.map((step, index) => {
            const color = STEP_COLORS[step.status];
            const next = steps[index + 1];
            return (
              <li key={step.label} className="relative px-2 text-center" aria-current={step.status === "current" ? "step" : undefined}>
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
// across hidden columns.
type EvidenceColumn<T> = { key: string; label: string; width: number; align?: "right"; render: (row: T) => React.ReactNode };
const evidenceHeadClass = `px-3 py-2.5 align-bottom ${typography.tableHeader}`;
function EvidenceTable<T>({ columns, rows, rowKey, emptyText, testId }: { columns: EvidenceColumn<T>[]; rows: T[]; rowKey: (row: T, index: number) => string; emptyText: string; testId: string }) {
  if (!rows.length) return <Card className="px-4 py-6 text-center text-xs" style={{ color: A.gray2 }} data-testid={testId}>{emptyText}</Card>;
  const minWidth = columns.reduce((sum, column) => sum + column.width, 0);
  return (
    <Card className="overflow-hidden" data-testid={testId}>
      <div className={tableScrollClass}>
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

export default function PurchasingOrdersPage({
  focus,
  onNavigate,
  onActiveContextChange,
}: {
  focus?: { entityType: string; entityId: string; focusArea?: "exception" | "receiving" | "invoice" | "inventory" | "evidence" | "receiving-invoice-variance"; at: number } | null;
  onNavigate?: NavigateFn;
  onActiveContextChange?: (context: ActiveContext | null) => void;
}) {
  const copy = useWorkspaceCopy();
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
  const [loadError, setLoadError] = useState("");
  const [filters, setFilters] = useState<PurchaseOrderWorkbenchFilters>(() => ({
    ...defaultPurchaseOrderWorkbenchFilters,
    poNumber: searchParams.get("po") || "",
    supplier: searchParams.get("supplier") || "",
    skuOrItem: searchParams.get("item") || "",
    status: (searchParams.get("status") || "全部") as PurchaseOrderWorkbenchFilters["status"],
    source: searchParams.get("source") || "全部",
    owner: searchParams.get("owner") || "",
    etaFrom: searchParams.get("etaFrom") || "",
    etaTo: searchParams.get("etaTo") || "",
  }));
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
    setLoadError("");
    apiJson<PurchaseOrderWorkbenchPayload>("/api/purchase-orders-workbench")
      .then((data) => {
        if (!alive) return;
        rememberDocumentNumbers("purchase_order", data.purchaseOrders, (order) => [order.po, order.number || order.orderNumber]);
        setOrders(data.purchaseOrders || []);
        setReceivingRecords(data.receivingDocs || []);
        setInvoiceRecords(data.supplierInvoices || []);
        setSummary(data.summary || null);
        setSelectedId(canonicalDetailId);
      })
      .catch((error) => {
        if (!alive) return;
        setOrders([]);
        setReceivingRecords([]);
        setInvoiceRecords([]);
        setSummary(null);
        setLoadError(error instanceof Error ? error.message : "采购订单加载失败");
      })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [canonicalDetailId]);

  useEffect(() => loadWorkbench(), [loadWorkbench]);

  useEffect(() => {
    setSelectedId(canonicalDetailId);
  }, [canonicalDetailId]);

  useEffect(() => {
    if (loading || viewMode !== "detail" || focus?.entityType !== "purchase_order" || focus.entityId !== selectedId || !focus.focusArea) return;
    const area = focus.focusArea === "evidence" ? "receiving-invoice-variance" : focus.focusArea || "receiving-invoice-variance";
    setHighlightedArea(area);
    const target = fulfillmentFocusRef.current;
    const frame = window.requestAnimationFrame(() => target?.scrollIntoView({ behavior: "smooth", block: "start" }));
    const timer = window.setTimeout(() => setHighlightedArea(""), 5000);
    return () => {
      window.cancelAnimationFrame(frame);
      window.clearTimeout(timer);
    };
  }, [focus?.at, focus?.entityId, focus?.entityType, focus?.focusArea, loading, selectedId, viewMode]);

  const filtered = filterPurchaseOrdersForWorkbench(orders, filters).filter((order) => {
    const supplier = searchParams.get("supplier");
    const status = searchParams.get("status");
    const overdue = searchParams.get("overdue") === "true";
    if (supplier && order.supplier !== supplier) return false;
    if (status && status !== "open" && order.status !== status) return false;
    // "open" is the report definition: committed and still to receive.
    if (status === "open" && !(summary?.openPurchaseOrderIds || []).includes(order.po)) return false;
    // Overdue: open, with an expected arrival before today in the workspace timezone.
    if (overdue && (!(summary?.openPurchaseOrderIds || []).includes(order.po) || !order.eta || String(order.eta) >= todayInTimeZone())) return false;
    return true;
  });
  const selectedPO = orders.find((order) => order.po === selectedId) ?? null;
  const selectedPOTotals = poTotals(selectedPO);
  // People read document numbers; the ids stay in links and calls.
  const selectedPONumber = selectedPO ? purchaseOrderNumber(selectedPO) : "";
  const sourceRequestNumber = useDocumentNumber("purchase_request", selectedPO?.sourceRequest, selectedPO?.prNumber);
  const sourceRfqNumber = useDocumentNumber("rfq", selectedPO?.sourceRfq, selectedPO?.rfqNumber);
  // The breadcrumb names the order by its number, not the id in the address.
  useDetailCrumb(viewMode === "detail" ? selectedPONumber : null);
  // Earlier PO prices for each line's item, unit and currency, in one
  // request. The server leaves this PO out and, once it is issued, every PO
  // dated after it. Display only.
  // The receipt and match tables name an app-made line by its position, as its card does.
  const poLineLabel = (id: string) => {
    if (!INTERNAL_LINE_ID.test(id)) return id;
    const position = poLinesOf(selectedPO).findIndex((line) => line.poLineId === id);
    return position >= 0 ? `${copy("采购行")} ${position + 1}` : copy("采购行");
  };
  // Notes for the header buttons, shown on a line under them.
  const actionNotes = usePurchaseOrderActionNotes({ status: selectedPO?.status || "", version: selectedPO?.version, billable: BILLABLE_PO_STATUSES.has(selectedPO?.status || "") });
  const poLineHistoryKeys = new Map((viewMode === "detail" && selectedPO?.lines ? selectedPO.lines : []).map((line) => [line.poLineId, priceHistoryKey({ itemId: line.itemId, unit: line.unit, currency: line.currency || selectedPO?.currency })]));
  const poPriceHistory = usePriceHistory([...poLineHistoryKeys.values()], { excludePurchaseOrderId: selectedPO?.po });
  const sourceOptions = Array.from(new Set(orders.map((order) => order.source || "manual"))).sort();
  const statusOptions = ["全部", "草稿", "待审批", "已审批", "已发出", "部分到货", "已完成", "已驳回", "已取消"] as const;

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
  const matchExceptions = orders.filter((order) => !["已匹配", "缺少发票"].includes(matchStatus(order, facts))).length;

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
      toast.warning("暂无可导出的数据");
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
      来源RFQ: order.sourceRfq ? order.rfqNumber || rfqNumbers.get(order.sourceRfq) || order.sourceRfq : "",
      供应商: order.supplier,
      状态: order.status,
      采购负责人: order.owner,
      行数: poTotals(order).lineCount,
      订单金额: poAmount(order),
      预计到货: order.eta,
      收货状态: receivedStatus(order, facts),
      发票状态: invoiceStatus(order, facts),
      三单匹配状态: matchStatus(order, facts),
      下一步: nextStepForPo(order, facts),
    })));
    toast.success("当前结果已导出");
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
        label: `${say("Source RFQ", "来源询价")} ${sourceRfqNumber}`,
        onClick: () => navigateWithReturn("procurement:rfq", { entityType: "rfq", entityId: selectedPO.sourceRfq }, sourceRfqNumber),
      }] : []),
      ...(firstGrn ? [{ key: "receiving", label: copy("查看收货单"), onClick: () => openReceipt(firstGrn.grn) }] : []),
      ...(firstInvoice ? [{ key: "invoice", label: copy("查看采购发票"), onClick: focusFulfillmentEvidence }] : []),
      { key: "match", label: copy("查看三单匹配"), onClick: focusFulfillmentEvidence },
    ];
    const overviewFields: OverviewField[] = [
      { label: copy("PO 编号"), value: selectedPONumber },
      { label: copy("状态"), value: <POStatusPill status={selectedPO.status} /> },
      { label: copy("来源 PR"), value: selectedPO.sourceRequest ? sourceRequestNumber : copy("未从采购申请创建") },
      // A PO need not come from a request or an RFQ: neither is a gap (owner, 2026-11-03).
      { label: copy("来源 RFQ"), value: selectedPO.sourceRfq ? sourceRfqNumber : copy(selectedPO.sourceRequest ? "未经询价，由采购申请创建" : "未经询价") },
      { label: supplierLabel, value: selectedPO.supplier },
      { label: copy("采购负责人"), value: selectedPO.owner },
      { label: copy("创建日期"), value: day(selectedPO.created) },
      { label: issued.label, value: day(issued.value) },
      { label: copy("预计到货"), value: day(selectedPO.eta) },
      { label: copy("目标仓库"), value: poLines[0]?.warehouse || warehouseName(selectedPO.warehouseId) || copy("目标仓库待补齐") },
      { label: copy("订单金额"), value: fmt(poAmount(selectedPO)) },
      { label: copy("收货状态"), value: statusChip(receivedStatus(selectedPO, facts)) },
      { label: copy("发票状态"), value: statusChip(invoiceStatus(selectedPO, facts)) },
      { label: copy("匹配状态"), value: statusChip(matchStatus(selectedPO, facts)) },
      { label: copy("当前下一步"), value: copy(nextStepForPo(selectedPO, facts)) },
      { label: copy("延迟 / 未收齐风险"), value: <StatusChip label={copy(delayed ? "需关注" : "未触发")} tone={delayed ? "warning" : "success"} />, helper: delayNote },
    ];
    const lineLabel = (id: string) => copy(poLineLabel(id));
    const grnColumns: EvidenceColumn<GrnEvidenceRow>[] = [
      { key: "grn", label: say("Receipt", "收货单"), width: 180, render: (row) => <>
        <button type="button" className={`${tableLinkClass} whitespace-nowrap text-blue-600`} onClick={() => openReceipt(row.grn)}>{row.grn}</button>
        <Sub><span className="whitespace-nowrap">{row.grnLineId}</span></Sub>
      </> },
      { key: "poLine", label: say("PO line", "采购订单行"), width: 230, render: (row) => <>
        <div className="whitespace-nowrap">{lineLabel(row.poLineId)}</div>
        <Sub>{copy(row.sku)}</Sub>
      </> },
      { key: "receivedQty", label: copy("收货数量"), width: 100, align: "right", render: (row) => <span className="whitespace-nowrap">{formatNumber(row.receivedQty)} {copy(row.unit)}</span> },
      { key: "arrived", label: copy("收货日期"), width: 130, render: (row) => <>
        <div className="whitespace-nowrap">{day(row.arrived) || "—"}</div>
        <Sub>{copy(row.receiver)}</Sub>
      </> },
      { key: "lineAmount", label: copy("行金额"), width: 130, align: "right", render: (row) => <>
        <div className="whitespace-nowrap">{fmt(hideAmounts ? null : amountOrNull(row.lineAmount))}</div>
        <Sub><span className="whitespace-nowrap">{fmt(hideAmounts ? null : amountOrNull(row.unitPrice))} / {copy(row.unit)}</span></Sub>
      </> },
      { key: "status", label: copy("收货状态"), width: 150, render: (row) => <>
        {statusChip(row.status === "partial" ? "部分收货" : row.status)}
        <Sub>{say("QC", "质检")}: {copy(row.qcStatus)}</Sub>
        {row.note === REJECTED_RECEIPT_NOTE ? <Sub>{copy(row.note)}</Sub> : null}
      </> },
      { key: "invoiceLine", label: say("Invoice line", "发票行"), width: 180, render: (row) => <>
        <div className="whitespace-nowrap">{copy(row.invoiceLine)}</div>
        <Sub>{row.invoiceImpact === "影响发票匹配" ? say("Counted in the invoice match", "已计入发票匹配") : copy(row.invoiceImpact)}</Sub>
      </> },
    ];
    const invoiceColumns: EvidenceColumn<InvoiceEvidenceRow>[] = [
      { key: "invoice", label: say("Supplier invoice", "采购发票"), width: 180, render: (row) => <>
        {canOpenInvoice
          ? <button type="button" className={`${tableLinkClass} whitespace-nowrap text-blue-600`} onClick={() => openInvoice(row.invoiceNumber)}>{row.invoiceNumber}</button>
          : <span className="whitespace-nowrap font-medium" style={{ color: A.blue }}>{row.invoiceNumber}</span>}
        <Sub><span className="whitespace-nowrap">{row.invoiceLineId}</span></Sub>
      </> },
      { key: "poLine", label: say("PO line", "采购订单行"), width: 230, render: (row) => <>
        <div className="whitespace-nowrap">{lineLabel(row.poLineId)}</div>
        <Sub>{copy(row.sku)}</Sub>
        <Sub><span className="whitespace-nowrap">{say("Receipt: ", "收货：")}{copy(row.grnLineId)}</span></Sub>
      </> },
      { key: "quantity", label: copy("开票数量"), width: 120, align: "right", render: (row) => <>
        <div className="whitespace-nowrap">{formatNumber(row.quantity)} {copy(row.unit)}</div>
        <Sub><span className="whitespace-nowrap">@ {formatCurrencyAmount(row.unitPrice, row.currency)}</span></Sub>
      </> },
      { key: "invoiceAmount", label: copy("发票金额"), width: 120, align: "right", render: (row) => <span className="whitespace-nowrap">{formatCurrencyAmount(row.invoiceAmount, row.currency)}</span> },
      { key: "totalAmount", label: say("Total incl. tax", "含税总额"), width: 130, align: "right", render: (row) => <>
        <div className="whitespace-nowrap font-medium">{formatCurrencyAmount(row.totalAmount, row.currency)}</div>
        <Sub><span className="whitespace-nowrap">{copy("税额")} {formatCurrencyAmount(row.taxAmount, row.currency)}</span></Sub>
      </> },
      { key: "invoiceDate", label: copy("发票日期"), width: 120, render: (row) => <>
        <div className="whitespace-nowrap">{day(row.invoiceDate) || "—"}</div>
        <Sub><span className="whitespace-nowrap">{say("Due", "到期")} {day(row.dueDate) || "—"}</span></Sub>
      </> },
      { key: "matchStatus", label: copy("匹配状态"), width: 160, render: (row) => <>
        {statusChip(row.matchStatus)}
        <Sub>{copy(row.varianceType)}{row.varianceAmount ? <> · <span className="whitespace-nowrap">{formatCurrencyAmount(row.varianceAmount, row.currency)}</span></> : null}</Sub>
      </> },
    ];
    // Price and amount differences only mean something once the line is invoiced.
    const invoiced = (row: MatchEvidenceRow) => row.invoiceQty > 0 || !["尚未开票", ""].includes(row.invoiceLineId);
    const matchMoney = (value: number) => fmt(hideAmounts ? null : value);
    // A variance with its sign: +$200.00 over the PO price, -$50.00 under it.
    const signedMoney = (value: number) => (hideAmounts ? fmt(null) : `${value >= MATCH_MONEY_EPSILON ? "+" : ""}${fmt(Math.abs(value) < MATCH_MONEY_EPSILON ? 0 : value)}`);
    const matchColumns: EvidenceColumn<MatchEvidenceRow>[] = [
      { key: "poLine", label: say("PO line", "采购订单行"), width: 220, render: (row) => <>
        <div className="whitespace-nowrap">{lineLabel(row.poLineId)}</div>
        <Sub><span className="whitespace-nowrap">{say("Receipt: ", "收货：")}{copy(row.grnLineId)}</span></Sub>
        <Sub><span className="whitespace-nowrap">{say("Invoice: ", "发票：")}{copy(row.invoiceLineId)}{row.moreInvoiceLines ? say(` +${formatNumber(row.moreInvoiceLines)} more`, ` 等 ${formatNumber(row.moreInvoiceLines + 1)} 行`) : ""}</span></Sub>
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
      { key: "status", label: copy("匹配状态"), width: 170, render: (row) => <>
        {statusChip(row.status)}
        <Sub>{copy(row.suggestedAction)}</Sub>
      </> },
    ];

    return (
      <DocumentShell
        title={copy("采购订单 / PO")}
        documentNo={selectedPONumber}
        moduleLabel="采购订单证据"
        status={selectedPO.status}
        statusTone={poStatusToneOf(selectedPO.status)}
        subtitle={`${selectedPO.supplier} · ${copy(receivedStatus(selectedPO, facts))} · ${copy(invoiceStatus(selectedPO, facts))}`}
      >
        <div className="space-y-3" data-testid="po-header-actions">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <RecoveryActions actions={[{ key: "po-list", label: copy("返回采购订单"), onClick: returnToList, kind: "list" }]} />
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
          {actionNotes.length ? <p className="text-[11px] leading-4 text-slate-500" data-testid="po-action-notes">{actionNotes.join(" ")}</p> : null}
        </div>

        <div>
          <SectionTitle title={copy("概览")} />
          <OverviewFields fields={overviewFields} />
        </div>

        <PoProgress steps={poTimeline(selectedPO, facts, day)} />

        <div>
          <SectionTitle title={copy("PO 明细行")} right={<Chip label={`${poLines.length} ${copy(poLines.length === 1 ? "单行" : "行")}`} color={A.blue} bg="#f0f6ff" />} />
          <PurchaseOrderLineCards
            rows={poLines}
            currency={selectedPO.currency}
            priceHistory={(poLineId) => poLineHistoryKeys.get(poLineId) ? (
              <div className="mt-2">
                <PriceHistoryFacts history={poPriceHistory.histories.get(poLineHistoryKeys.get(poLineId) || "")} state={poPriceHistory.state} testId={`po-line-price-history-${poLineId}`} />
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
                {copy(receivedStatus(selectedPO, facts))} · {copy(invoiceStatus(selectedPO, facts))}{copy("· 建议：")}{copy(nextStepForPo(selectedPO, facts))}
              </div>
            </Card>
          ) : null}
        <div>
          <SectionTitle title={say("Receipt lines", "收货明细行")} />
          <EvidenceTable
            testId="po-receipt-lines"
            rows={grnRows}
            rowKey={(row) => `${row.grn}:${row.grnLineId}`}
            emptyText={copy("当前 PO 暂无收货记录。")}
            columns={grnColumns}
          />
          <Card className="p-3 mt-3 text-[11px] leading-5" style={{ color: A.sub, background: "#f8fafc" }}>
            {copy("对照采购订单查看实收、质检和差异记录。")}
          </Card>
        </div>

        <div>
          <SectionTitle title={say("Supplier invoice lines", "采购发票明细行")} />
          <EvidenceTable
            testId="po-invoice-lines"
            rows={invoiceRows}
            rowKey={(row) => `${row.invoiceNumber}:${row.invoiceLineId}`}
            emptyText={copy("当前 PO 尚未读取到 Invoice Line。")}
            columns={invoiceColumns}
          />
        </div>
        <div>
          <SectionTitle title={copy("三单匹配")} right={<span className="text-xs" style={{ color: A.sub }}>{say("One row per PO line: invoiced vs PO price and received quantity", "按采购订单行核对：开票对照订单价与已收数量")}</span>} />
          <EvidenceTable
            testId="po-match-lines"
            rows={matchRows}
            rowKey={(row) => row.poLineId}
            emptyText={copy("当前采购订单没有明细行。")}
            columns={matchColumns}
          />
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
          <SectionTitle title={copy("历史记录")} />
          <DocumentHistoryPanel
            entityType="purchaseOrder"
            entityId={selectedPO.po}
            title={copy("采购订单历史")}
            refreshKey={selectedPO.lastAuditId || selectedPO.auditTrailIds?.join(",") || selectedPO.status}
          />
        </div>

      </DocumentShell>
    );
  })();

  if (loading) {
    return <Card className="p-12 text-center text-sm" data-testid="po-loading-state">{copy("正在读取 PostgreSQL 采购订单与履约证据…")}</Card>;
  }

  if (loadError) {
    return (
      <Card className="p-12 text-center" data-testid="po-error-state">
        <div className="text-sm font-semibold">{copy("采购订单加载失败")}</div>
        <div className="mt-2 text-xs" style={{ color: A.sub }}>{loadError}</div>
        <button type="button" onClick={() => loadWorkbench()} className="mt-4 rounded-lg bg-blue-600 px-4 py-2 text-xs font-semibold text-white">{copy("重试")}</button>
      </Card>
    );
  }

  if (viewMode === "detail") {
    return (
      <div className="space-y-5">
        {selectedPO ? detailContent : (
          <Card className="p-8 text-center text-xs" style={{ color: A.gray2 }}>
            {copy("未找到采购订单。")}
            <button onClick={returnToList} className="ml-3 px-3 py-1.5 rounded-lg font-medium" style={{ background: A.gray6, color: A.blue }}>{copy("返回 PO 列表")}</button>
          </Card>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className={metricGridClass}>
        <ActionableMetricCard label={copy("已承诺采购订单金额")} value={!summary ? "—" : committedHidden ? copy("受限") : committedValue.length === 0 ? formatCurrencyAmount(0, "") : committedValue.map((row) => formatCurrencyAmount(row.amount, row.currency)).join(" · ")} description={loading ? copy("加载中") : `${summary?.committedOrderCount ?? 0} ${copy("张已承诺订单（已批准、已下达或已收货）")}`} to="/app/procurement/orders" icon={FileText} color={A.blue} />
        <ActionableMetricCard label={copy("未完成采购订单")} value={summary ? String(summary.openOrderCount) : "—"} description={copy("已承诺且仍有待收数量")} to="/app/procurement/orders?status=open" icon={Truck} color={A.orange} />
        <ActionableMetricCard label={copy("发票差异")} value={String(invoiceExceptions)} description={copy("采购与财务共同复核")} to="/app/procurement/bills?matchStatus=variance" icon={AlertCircle} color={A.red} />
        <ActionableMetricCard label={copy("匹配复核")} value={String(matchExceptions)} description={copy("查看三单匹配异常")} to="/app/procurement/bills?status=exception" icon={ShieldCheck} color={A.purple} />
      </div>

      <ListSearchCard
        title={copy("采购订单查询")}
        subtitle={copy("查询 PO、来源 PR / RFQ、供应商、收货、发票和三单匹配状态")}
        actions={<>
          <ResetButton onClick={resetFilters} />
          <ExportButton onClick={exportCsv} />
        </>}
      >
        <Field label={copy("PO 编号")}>
          <input value={filters.poNumber} onChange={(event) => updateFilter("poNumber", event.target.value)}
            placeholder="PO-2026-1287" style={inputStyle} />
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
            {statusOptions.map((status) => <option key={status} value={status}>{copy(status)}</option>)}
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
        <Field label={copy("ETA 起始")}>
          <input value={filters.etaFrom} onChange={(event) => updateFilter("etaFrom", event.target.value)}
            placeholder="2026-06-01" style={inputStyle} />
        </Field>
        <Field label={copy("ETA 结束")}>
          <input value={filters.etaTo} onChange={(event) => updateFilter("etaTo", event.target.value)}
            placeholder="2026-06-30" style={inputStyle} />
        </Field>
      </ListSearchCard>

      <ListCard title={copy("采购订单列表")} total={orders.length} shown={filtered.length}>
        <div className={tableScrollClass}>
          {/* Fixed column widths that fit beside the sidebar at 1440px, so the
              pinned Actions column never covers the last data column. */}
          <table className={`w-full min-w-[1150px] table-fixed text-left ${tableBodyTextClass}`}>
            <thead>
              <tr style={listHeadRowStyle}>
                <th className={`${thClass} sticky left-0 z-20 w-[190px] bg-white`} style={{ color: A.gray1 }}>{copy("PO 编号")}</th>
                <th className={`${thClass} w-[180px]`} style={{ color: A.gray1 }}>{supplierLabel}</th>
                <th className={`${thClass} w-[140px]`} style={{ color: A.gray1 }}>{copy("状态")}</th>
                <th className={`${thClass} w-[120px]`} style={{ color: A.gray1 }}>{copy("采购负责人")}</th>
                <th className={`${thRightClass} w-[130px]`} style={{ color: A.gray1 }}>{copy("订单金额")}</th>
                <th className={`${thClass} w-[120px]`} style={{ color: A.gray1 }}>{copy("预计到货")}</th>
                <th className={`${thClass} w-[160px]`} style={{ color: A.gray1 }}>{receiptInvoiceLabel}</th>
                <th className={`${thClass} sticky right-0 z-20 w-[110px] bg-white`} style={{ color: A.gray1 }}>{copy("操作")}</th>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 && (
                <ListStateRow colSpan={8} state="empty" title={copy("当前工作区没有符合条件的采购订单。")} />
              )}
              {filtered.map((order, index) => {
                const firstGrn = grnsForPo(order.po, facts)[0];
                const firstInvoice = invoicesForPo(order.po, facts)[0];
                return (
                  <tr key={order.po} className={listRowClass} style={listRowStyle(index, filtered.length)}>
                    <td className={`${tdIdClass} sticky left-0 z-10 truncate bg-white`}>
                      <BusinessEntityLink entityType="purchase_order" entityId={order.po} number={purchaseOrderNumber(order)} className={tableLinkClass} />
                    </td>
                    <td className={`${tdNameClass} truncate font-medium`} title={order.supplier}><BusinessEntityLink entityType="supplier" entityId={order.supplier}>{order.supplier}</BusinessEntityLink></td>
                    <td className={tdNowrapClass}><POStatusPill status={order.status} /></td>
                    <td className={`${tdNowrapClass} truncate`} style={{ color: A.sub }}>{order.owner}</td>
                    <td className={`${tdNumericRightClass} font-semibold`} style={{ color: A.label }}>{formatCurrencyAmount(poAmount(order), order.currency)}</td>
                    <td className={tdNowrapClass} style={{ color: A.sub }}>{order.eta}</td>
                    <td className={tdNowrapClass}>
                      <div className="flex flex-col items-start gap-1">
                        {statusChip(receivedStatus(order, facts))}
                        {statusChip(invoiceStatus(order, facts))}
                      </div>
                      <div className="mt-1 truncate text-[11px] text-slate-500" title={copy(matchStatus(order, facts))}>{copy(matchStatus(order, facts))}</div>
                    </td>
                    <td className={`${tdActionClass} sticky right-0 z-10 !min-w-0 bg-white`}>
                      <div className="flex items-center gap-1.5">
                        <button onClick={() => openDetail(order.po)} className={rowActionClass.primary}>{copy("查看")}</button>
                        <details className="relative"><summary className={`cursor-pointer list-none ${rowActionClass.neutral}`}>{copy("更多")}</summary><div className="absolute right-0 top-7 z-30 w-40 rounded-lg border border-slate-200 bg-white p-1 shadow-lg">
                          <button onClick={() => openDetail(order.po)} className="w-full rounded px-2 py-1.5 text-left text-xs hover:bg-slate-50">{copy("查看订单行与证据")}</button>
                          {firstGrn && <button onClick={() => navigateOrderWithReturn(order, "procurement:receiving", { entityType: "receiving_doc", entityId: firstGrn.grn }, firstGrn.grn)} className="w-full rounded px-2 py-1.5 text-left text-xs hover:bg-slate-50">{copy("打开收货记录")}</button>}
                          {firstInvoice && canOpenRoute("procurement:bills") && <button onClick={() => navigateOrderWithReturn(order, "procurement:bills", { entityType: "supplier_invoice", entityId: firstInvoice.invoiceNumber }, firstInvoice.invoiceNumber)} className="w-full rounded px-2 py-1.5 text-left text-xs hover:bg-slate-50">{copy("打开采购发票")}</button>}
                          {canOpenRoute("procurement:match") && <button onClick={() => navigateOrderWithReturn(order, "procurement:match")} className="w-full rounded px-2 py-1.5 text-left text-xs hover:bg-slate-50">{copy("打开三单匹配")}</button>}
                          {order.sourceRequest && <button onClick={() => navigateOrderWithReturn(order, "procurement:requests", { entityType: "purchase_request", entityId: order.sourceRequest }, documentNumberFor("purchase_request", order.sourceRequest, order.prNumber))} className="w-full rounded px-2 py-1.5 text-left text-xs hover:bg-slate-50">{copy("打开来源 PR")}</button>}
                          {order.sourceRfq && <button onClick={() => navigateOrderWithReturn(order, "procurement:rfq", { entityType: "rfq", entityId: order.sourceRfq }, documentNumberFor("rfq", order.sourceRfq, order.rfqNumber))} className="w-full rounded px-2 py-1.5 text-left text-xs hover:bg-slate-50">{copy("打开来源 RFQ")}</button>}
                        </div></details>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </ListCard>

    </div>
  );
}
