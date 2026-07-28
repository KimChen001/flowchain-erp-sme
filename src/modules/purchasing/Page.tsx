import React, { useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router";
import { toast } from "sonner";
import {
  AlertCircle,
  CheckCircle2,
  ClipboardCheck,
  FileSpreadsheet,
  FileText,
  Filter,
  PackageCheck,
  ShieldCheck,
  Truck,
} from "lucide-react";
import { apiJson } from "../../lib/api-client";
import { exportRowsToCsv } from "../../lib/data-export";
import { BusinessEntityLink } from "../../components/business/BusinessEntityLink";
import { fmt } from "../../lib/format";
import type { PurchaseOrder, ReceivingDoc, SupplierInvoice } from "../../types/scm";
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
  DocumentActionBar,
  DocumentHeader,
  DocumentLinesTable,
  DocumentShell,
  DocumentStatusTimeline,
  DocumentTotals,
  statusTone,
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
import { POStatusPill } from "./components/POStatusPill";
import {
  tableLinkClass,
  tableMinXlClass,
  tableScrollClass,
  tdActionClass,
  tdIdClass,
  tdNameClass,
  tdNowrapClass,
  tdNumericClass,
  thClass,
} from "../../components/ui/workbenchTable";

type PurchaseOrderViewMode = "list" | "detail";
type NavigateFn = (moduleId: string, focusTarget?: { entityType: string; entityId: string } | null, options?: { returnTo?: string; entityLabel?: string; returnContext?: WorkflowContext | null; source?: string }) => void;
type PurchaseOrderWorkbenchPayload = {
  purchaseOrders: PurchaseOrder[];
  receivingDocs: ReceivingDoc[];
  supplierInvoices: SupplierInvoice[];
  documentLinks: Array<Record<string, unknown>>;
  procurementFollowups: Array<Record<string, unknown>>;
};
type ProcurementRuntimeFacts = {
  receivingDocs: ReceivingDoc[];
  supplierInvoices: SupplierInvoice[];
};

type PoEvidenceRow = {
  poLineId: string;
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

type MatchEvidenceRow = {
  poLineId: string;
  grnLineId: string;
  invoiceLineId: string;
  poQty: number;
  receivedQty: number;
  invoiceQty: number;
  poUnitPrice: number;
  invoiceUnitPrice: number;
  poAmount: number;
  invoiceAmount: number;
  qtyVariance: number;
  priceVariance: number;
  amountVariance: number;
  receivingGap: number;
  invoiceGap: number;
  status: string;
  suggestedAction: string;
};

function statusChip(status: string) {
  return <Chip label={status} color={statusTone(status) === "danger" ? A.red : statusTone(status) === "warning" ? A.orange : statusTone(status) === "success" ? A.green : A.blue} bg={statusTone(status) === "danger" ? "#fff1f0" : statusTone(status) === "warning" ? "#fff8f0" : statusTone(status) === "success" ? "#f0faf4" : "#f0f6ff"} />;
}

function PurchaseOrderLineCards({ rows }: { rows: PoEvidenceRow[] }) {
  if (!rows.length) {
    return <Card className="p-8 text-center text-xs" style={{ color: A.gray2 }}>当前采购订单没有明细行。</Card>;
  }
  return (
    <div className="space-y-3" data-testid="po-line-cards">
      {rows.map((line) => {
        const groups = [
          {
            title: "来源",
            facts: [
              ["来源 PR Line", line.sourcePrLine],
              ["来源 RFQ Line", line.sourceRfqLine],
            ],
          },
          {
            title: "订购",
            facts: [
              ["订购数量", `${line.quantity.toLocaleString()} ${line.unit}`],
              ["单价", fmt(line.unitPrice)],
              ["行金额", fmt(line.lineAmount)],
            ],
          },
          {
            title: "履约",
            facts: [
              ["已收 / 未收", `${line.receivedQty.toLocaleString()} / ${line.remainingQty.toLocaleString()} ${line.unit}`],
              ["已开票 / 未开票", `${line.invoicedQty.toLocaleString()} / ${line.uninvoicedQty.toLocaleString()} ${line.unit}`],
            ],
          },
          {
            title: "交付",
            facts: [
              ["目标仓库", line.warehouse],
              ["需求日期", line.requiredDate],
              ["预计到货", line.promisedDate],
            ],
          },
        ];
        return (
          <article key={line.poLineId} className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0">
                <div className="text-xs font-semibold tabular-nums" style={{ color: A.blue }}>{line.poLineId}</div>
                <div className="mt-1 text-sm font-semibold" style={{ color: A.label }}>{line.sku} · {line.itemName}</div>
              </div>
              <div className="flex flex-wrap gap-2">
                {statusChip(line.status)}
                <Chip label={line.risk} color={statusTone(line.risk) === "warning" ? A.orange : A.green} bg={statusTone(line.risk) === "warning" ? "#fff8f0" : "#f0faf4"} />
              </div>
            </div>
            <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              {groups.map((group) => (
                <div key={group.title} className="rounded-lg bg-slate-50 p-3">
                  <div className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: A.gray2 }}>{group.title}</div>
                  <dl className="mt-2 space-y-2">
                    {group.facts.map(([label, value]) => (
                      <div key={label} className="flex items-start justify-between gap-3 text-xs">
                        <dt className="shrink-0" style={{ color: A.sub }}>{label}</dt>
                        <dd className="min-w-0 break-words text-right font-medium tabular-nums" style={{ color: A.label }}>{value}</dd>
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

function poAmount(po?: PurchaseOrder | null) {
  if (!po) return 0;
  const totals = poTotals(po);
  return Number(po.totalAmount || totals.totalAmount || po.amount || 0);
}

function poLineAmount(line: { quantityOrdered?: number; unitPrice?: number }, po?: PurchaseOrder | null) {
  const direct = toNumber(line.quantityOrdered) * toNumber(line.unitPrice);
  if (direct > 0) return direct;
  const lines = poLinesOf(po);
  const totalQty = lines.reduce((sum, item) => sum + toNumber(item.quantityOrdered), 0);
  return totalQty ? Math.round(poAmount(po) * (toNumber(line.quantityOrdered) / totalQty)) : poAmount(po);
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
  if (invoices.some((invoice) => invoice.varianceType !== "无差异" || invoice.matchStatus === "差异待处理")) return "发票差异";
  if (invoices.every((invoice) => invoice.paid)) return "已付款";
  return "已开票";
}

function matchStatus(po: PurchaseOrder, facts: ProcurementRuntimeFacts) {
  const invoices = invoicesForPo(po.po, facts);
  const grns = grnsForPo(po.po, facts);
  if (!invoices.length) return "缺少发票";
  if (!grns.length || grns.some((doc) => doc.status === "待收货" || doc.status === "质检中")) return "缺少收货";
  const variance = invoices.find((invoice) => invoice.varianceType !== "无差异" || invoice.varianceAmount > 0);
  if (variance) return variance.varianceType;
  if (invoices.every((invoice) => invoice.matchStatus === "自动匹配" || invoice.matchStatus === "已解决")) return "已匹配";
  return "需人工复核";
}

function nextStepForPo(po: PurchaseOrder, facts: ProcurementRuntimeFacts) {
  const status = matchStatus(po, facts);
  if (status === "缺少收货") return "等待收货";
  if (status === "缺少发票") return "等待发票";
  if (status === "数量差异") return "复核收货记录";
  if (status === "价格差异") return "复核供应商发票";
  if (status === "已匹配") return "财务协同复核";
  if (receivedStatus(po, facts) === "异常处理") return "生成内部差异说明草稿";
  return "需人工复核";
}

function poTimeline(po: PurchaseOrder, facts: ProcurementRuntimeFacts): TimelineStep[] {
  const receipt = receivedStatus(po, facts);
  const invoice = invoiceStatus(po, facts);
  const match = matchStatus(po, facts);
  return [
    { label: "来源确认", status: po.sourceRequest || po.sourceRfq ? "done" : "warning", helper: po.sourceRequest || po.sourceRfq || "来源待补齐" },
    { label: "PO 已建立", status: "done", helper: po.created },
    { label: "收货证据", status: receipt === "未收货" ? "pending" : receipt === "异常处理" ? "warning" : "done", helper: receipt },
    { label: "发票证据", status: invoice === "未开票" ? "pending" : invoice === "发票差异" ? "warning" : "done", helper: invoice },
    { label: "三单匹配", status: match === "已匹配" ? "done" : match === "缺少发票" || match === "缺少收货" ? "pending" : "warning", helper: match },
    { label: "人工复核", status: match === "已匹配" ? "pending" : "current", helper: nextStepForPo(po, facts) },
  ];
}

function buildPoLineRows(po: PurchaseOrder, facts: ProcurementRuntimeFacts): PoEvidenceRow[] {
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
      sourcePrLine: po.sourceRequest ? `${po.sourceRequest}-L${String(index + 1).padStart(3, "0")}` : "来源 PR Line 待补齐",
      sourceRfqLine: po.sourceRfq ? `${po.sourceRfq}-L${String(index + 1).padStart(3, "0")}` : "来源 RFQ Line 待补齐",
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
      status: lineStatusLabel(line.status),
      risk: remaining > 0 && invoiceQty > received ? "已票未收风险" : remaining > 0 ? "未收货风险" : invoiceQty < received ? "已收未票风险" : "低风险",
    };
  });
}

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
        receiver: safeText(grn.receiver, "Receiver 待补齐"),
        unitPrice,
        lineAmount: Math.round(unitPrice * receivedQty),
        status: grn.status,
        qcStatus: toNumber(line.rejectedQty) > 0 || grn.failed > 0 ? "质检异常" : grn.status === "质检中" ? "质检中" : "通过",
        invoiceImpact: relatedInvoiceLine ? "影响发票匹配" : "等待发票匹配",
        invoiceLine: relatedInvoiceLine?.invoiceLine.lineId || "关联 Invoice Line 待补齐",
        note: toNumber(line.rejectedQty) > 0 ? "拒收数量需要采购与财务协同复核" : "查看收货记录和匹配影响",
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
    varianceType: line.varianceType || invoice.varianceType,
    varianceAmount: toNumber(line.varianceAmount ?? invoice.varianceAmount),
    risk: (line.varianceType || invoice.varianceType) === "无差异" ? "低风险" : "需人工复核",
    }));
  });
}

function matchStatusForLine(row: Omit<MatchEvidenceRow, "status" | "suggestedAction">) {
  if (!row.grnLineId || row.grnLineId.includes("待补齐")) return "缺少收货";
  if (!row.invoiceLineId || row.invoiceLineId.includes("待补齐")) return row.receivedQty > 0 ? "已收未票" : "缺少发票";
  if (row.receivedQty < row.invoiceQty) return "已票未收";
  if (row.poQty !== row.receivedQty || row.receivedQty !== row.invoiceQty) return "数量差异";
  if (Math.abs(row.priceVariance) > 0.01) return "价格差异";
  if (Math.abs(row.amountVariance) > 1) return "金额差异";
  return "已匹配";
}

function suggestedActionForStatus(status: string) {
  if (status === "缺少收货") return "等待收货";
  if (status === "缺少发票" || status === "已收未票") return "等待发票";
  if (status === "已票未收") return "复核收货记录";
  if (status === "价格差异" || status === "金额差异") return "复核供应商发票";
  if (status === "数量差异") return "生成内部差异说明草稿";
  return "暂缓付款复核";
}

function buildMatchRows(po: PurchaseOrder, facts: ProcurementRuntimeFacts): MatchEvidenceRow[] {
  const grnRows = buildGrnRows(po, facts);
  const invoiceRows = buildInvoiceRows(po, facts);
  return buildPoLineRows(po, facts).map((line) => {
    const grn = grnRows.find((row) => row.poLineId === line.poLineId);
    const invoice = invoiceRows.find((row) => row.poLineId === line.poLineId);
    const base = {
      poLineId: line.poLineId,
      grnLineId: grn?.grnLineId || "GRN Line 待补齐",
      invoiceLineId: invoice?.invoiceLineId || "Invoice Line 待补齐",
      poQty: line.quantity,
      receivedQty: grn?.receivedQty ?? line.receivedQty,
      invoiceQty: invoice?.quantity ?? 0,
      poUnitPrice: line.unitPrice,
      invoiceUnitPrice: invoice?.unitPrice ?? 0,
      poAmount: line.lineAmount,
      invoiceAmount: invoice?.invoiceAmount ?? 0,
      qtyVariance: (invoice?.quantity ?? 0) - (grn?.receivedQty ?? line.receivedQty),
      priceVariance: (invoice?.unitPrice ?? 0) - line.unitPrice,
      amountVariance: (invoice?.invoiceAmount ?? 0) - line.lineAmount,
      receivingGap: Math.max(0, line.quantity - (grn?.receivedQty ?? line.receivedQty)),
      invoiceGap: Math.max(0, (grn?.receivedQty ?? line.receivedQty) - (invoice?.quantity ?? 0)),
    };
    const status = matchStatusForLine(base);
    return { ...base, status, suggestedAction: suggestedActionForStatus(status) };
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

export default function PurchasingOrdersPage({
  focus,
  onNavigate,
  onActiveContextChange,
}: {
  focus?: { entityType: string; entityId: string; focusArea?: "exception" | "receiving" | "invoice" | "inventory" | "evidence" | "receiving-invoice-variance"; at: number } | null;
  onNavigate?: NavigateFn;
  onActiveContextChange?: (context: ActiveContext | null) => void;
}) {
  const location = useLocation();
  const routerNavigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const detailIdFromUrl = location.pathname.match(/^\/app\/procurement\/orders\/([^/]+)$/)?.[1];
  const canonicalDetailId = detailIdFromUrl ? decodeURIComponent(detailIdFromUrl) : "";
  const [orders, setOrders] = useState<PurchaseOrder[]>([]);
  const [receivingRecords, setReceivingRecords] = useState<ReceivingDoc[]>([]);
  const [invoiceRecords, setInvoiceRecords] = useState<SupplierInvoice[]>([]);
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
        setOrders(data.purchaseOrders || []);
        setReceivingRecords(data.receivingDocs || []);
        setInvoiceRecords(data.supplierInvoices || []);
        setSelectedId(canonicalDetailId);
      })
      .catch((error) => {
        if (!alive) return;
        setOrders([]);
        setReceivingRecords([]);
        setInvoiceRecords([]);
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
    if (status === "open" && ["已完成", "已取消"].includes(order.status)) return false;
    if (overdue && (["已完成", "已取消"].includes(order.status) || String(order.eta || "") >= "2026-07-11")) return false;
    return true;
  });
  const selectedPO = orders.find((order) => order.po === selectedId) ?? null;
  const selectedPOTotals = poTotals(selectedPO);
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
      entityLabel: `${selectedPO.po} · ${selectedPO.supplier}`,
      view: "orders",
    });
    return () => onActiveContextChange?.(null);
  }, [viewMode, selectedPO?.po, selectedPO?.supplier, onActiveContextChange]);

  const totalAmount = orders.reduce((sum, order) => sum + poAmount(order), 0);
  const waitingReceipt = orders.filter((order) => receivedStatus(order, facts) !== "已收货").length;
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

  function exportCsv() {
    if (filtered.length === 0) {
      toast.warning("暂无可导出的数据");
      return;
    }
    exportRowsToCsv("purchase-order-evidence-export.csv", filtered.map((order) => ({
      PO编号: order.po,
      来源PR: order.sourceRequest || "",
      来源RFQ: order.sourceRfq || "",
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
      sourceLabel: order.po,
      returnLabel: `返回采购订单 ${order.po}`,
    };
    onNavigate?.(moduleId, focusTarget || null, {
      returnTo: "procurement:orders",
      entityLabel: label || order.po,
      returnContext,
      source: "purchaseOrderEvidence",
    });
  }

  function navigateWithReturn(moduleId: string, focusTarget?: { entityType: string; entityId: string } | null, label?: string) {
    if (!selectedPO) return;
    navigateOrderWithReturn(selectedPO, moduleId, focusTarget, label);
  }

  const detailContent = selectedPO && (() => {
    const poLines = buildPoLineRows(selectedPO, facts);
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
    const firstGrn = grns[0];
    const firstInvoice = invoices[0];

    return (
      <DocumentShell
        title="采购订单 / PO"
        documentNo={selectedPO.po}
        moduleLabel="采购订单证据"
        status={selectedPO.status}
        subtitle={`${selectedPO.supplier} · ${receivedStatus(selectedPO, facts)} · ${invoiceStatus(selectedPO, facts)}`}
      >
        <RecoveryActions
          actions={[
            ...(selectedPO.sourceRequest ? [{
              key: "source-pr",
              label: "返回来源 PR",
              onClick: () => navigateWithReturn("procurement:requests", { entityType: "purchase_request", entityId: selectedPO.sourceRequest }, selectedPO.sourceRequest), kind: "previous" as const, tone: "primary" as const,
            }] : []),
            ...(selectedPO.sourceRfq ? [{
              key: "source-rfq",
              label: "返回来源 RFQ",
              onClick: () => navigateWithReturn("procurement:rfq", { entityType: "rfq", entityId: selectedPO.sourceRfq }, selectedPO.sourceRfq), kind: "previous" as const, tone: "primary" as const,
            }] : []),
            { key: "po-list", label: "返回采购订单", onClick: returnToList, kind: "list" },
            ...(firstGrn ? [{
              key: "receiving",
              label: "查看收货单", onClick: () => navigateWithReturn("procurement:receiving", { entityType: "receiving_doc", entityId: firstGrn.grn }, firstGrn.grn), kind: "module" as const, tone: "subtle" as const,
            }] : []),
            ...(firstInvoice ? [{
              key: "invoice",
              label: "查看供应商发票", onClick: () => navigateWithReturn("procurement:invoices", { entityType: "supplier_invoice", entityId: firstInvoice.invoiceNumber }, firstInvoice.invoiceNumber), kind: "module" as const, tone: "subtle" as const,
            }] : []),
            { key: "match", label: "查看三单匹配", onClick: () => navigateWithReturn("procurement:match"), kind: "module", tone: "subtle" },
          ]}
        />

        <div>
          <SectionTitle title="概览" />
          <DocumentHeader
            fields={[
              { label: "PO 编号", value: selectedPO.po, tone: "info" },
              { label: "状态", value: selectedPO.status, tone: statusTone(selectedPO.status) },
              { label: "来源 PR", value: selectedPO.sourceRequest || "来源 PR 待补齐", tone: selectedPO.sourceRequest ? "info" : "warning" },
              { label: "来源 RFQ", value: selectedPO.sourceRfq || "来源 RFQ 待补齐", tone: selectedPO.sourceRfq ? "info" : "warning" },
              { label: "供应商", value: selectedPO.supplier },
              { label: "采购负责人", value: selectedPO.owner },
              { label: "创建日期", value: selectedPO.created },
              { label: "预计到货", value: selectedPO.eta },
              { label: "目标仓库", value: poLines[0]?.warehouse || selectedPO.warehouseId || "目标仓库待补齐" },
              { label: "订单金额", value: fmt(poAmount(selectedPO)), tone: "info" },
              { label: "收货状态", value: receivedStatus(selectedPO, facts), tone: statusTone(receivedStatus(selectedPO, facts)) },
              { label: "发票状态", value: invoiceStatus(selectedPO, facts), tone: statusTone(invoiceStatus(selectedPO, facts)) },
              { label: "匹配状态", value: matchStatus(selectedPO, facts), tone: statusTone(matchStatus(selectedPO, facts)) },
              { label: "当前下一步", value: nextStepForPo(selectedPO, facts), tone: "warning" },
              { label: "延迟 / 未收齐风险", value: delayRisk.delayed ? "需关注" : "未触发", tone: delayRisk.delayed ? "warning" : "success", helper: delayRisk.reason },
            ]}
          />
        </div>

        <DocumentStatusTimeline steps={poTimeline(selectedPO, facts)} />

        <div>
          <SectionTitle title="PO 明细行" right={<Chip label={`${poLines.length} 行`} color={A.blue} bg="#f0f6ff" />} />
          <PurchaseOrderLineCards rows={poLines} />
        </div>

        <section
          ref={fulfillmentFocusRef}
          data-testid="po-fulfillment-focus"
          data-focus-highlight={highlightedArea === "receiving-invoice-variance" || highlightedArea === "receiving" || highlightedArea === "invoice" || highlightedArea === "exception" ? "true" : "false"}
          className="scroll-mt-20 space-y-5 rounded-xl p-2 transition-all"
          style={highlightedArea && highlightedArea !== "evidence" ? { background: "#fff8e6", boxShadow: `0 0 0 2px ${A.orange}55` } : undefined}
        >
          {highlightedArea && highlightedArea !== "evidence" ? (
            <Card className="p-3" style={{ background: "#fffaf0", borderColor: `${A.orange}55` }}>
              <div className="text-xs font-semibold" style={{ color: A.orange }}>AI 已定位：收货、发票差异与建议下一步</div>
              <div className="mt-1 text-[11px] leading-5" style={{ color: A.gray1 }}>
                {receivedStatus(selectedPO, facts)} · {invoiceStatus(selectedPO, facts)} · 建议：{nextStepForPo(selectedPO, facts)}
              </div>
            </Card>
          ) : null}
        <div>
          <SectionTitle title="收货 / GRN 明细行" />
          <DocumentLinesTable
            rows={grnRows}
            emptyText="当前 PO 暂无收货记录。"
            columns={[
              { key: "grn", label: "GRN / Receipt 编号", render: (line) => <span style={{ color: A.blue }}>{String(line.grn)}</span> },
              { key: "grnLineId", label: "GRN Line 编号" },
              { key: "po", label: "PO 编号" },
              { key: "poLineId", label: "PO Line 编号" },
              { key: "supplier", label: "Supplier" },
              { key: "sku", label: "SKU" },
              { key: "receivedQty", label: "收货数量", align: "right", render: (line) => Number(line.receivedQty).toLocaleString() },
              { key: "unit", label: "单位" },
              { key: "arrived", label: "收货日期" },
              { key: "receiver", label: "Receiver" },
              { key: "unitPrice", label: "单价", align: "right", render: (line) => fmt(Number(line.unitPrice || 0)) },
              { key: "lineAmount", label: "行金额", align: "right", render: (line) => fmt(Number(line.lineAmount || 0)) },
              { key: "status", label: "收货状态" },
              { key: "qcStatus", label: "质检 / 异常状态" },
              { key: "invoiceImpact", label: "是否影响发票匹配" },
              { key: "invoiceLine", label: "关联 Invoice Line" },
              { key: "note", label: "行级备注" },
            ]}
          />
          <Card className="p-3 mt-3 text-[11px] leading-5" style={{ color: A.sub, background: "#f8fafc" }}>
            对照采购订单查看实收、质检和差异记录。
          </Card>
        </div>

        <div>
          <SectionTitle title="发票 / Invoice Line" />
          <DocumentLinesTable
            rows={invoiceRows}
            emptyText="当前 PO 尚未读取到 Invoice Line。"
            columns={[
              { key: "invoiceNumber", label: "Invoice 编号", render: (line) => <span style={{ color: A.blue }}>{String(line.invoiceNumber)}</span> },
              { key: "invoiceLineId", label: "Invoice Line 编号" },
              { key: "supplier", label: "Supplier" },
              { key: "po", label: "PO 编号" },
              { key: "poLineId", label: "PO Line 编号" },
              { key: "grnLineId", label: "GRN / Receipt Line" },
              { key: "sku", label: "SKU" },
              { key: "quantity", label: "开票数量", align: "right", render: (line) => Number(line.quantity).toLocaleString() },
              { key: "unit", label: "单位" },
              { key: "unitPrice", label: "发票单价", align: "right", render: (line) => fmt(Number(line.unitPrice || 0)) },
              { key: "invoiceAmount", label: "发票金额", align: "right", render: (line) => fmt(Number(line.invoiceAmount || 0)) },
              { key: "taxAmount", label: "税额", align: "right", render: (line) => fmt(Number(line.taxAmount || 0)) },
              { key: "totalAmount", label: "总额", align: "right", render: (line) => fmt(Number(line.totalAmount || 0)) },
              { key: "invoiceDate", label: "发票日期" },
              { key: "dueDate", label: "到期日" },
              { key: "matchStatus", label: "匹配状态" },
              { key: "varianceType", label: "差异类型" },
              { key: "varianceAmount", label: "差异金额", align: "right", render: (line) => fmt(Number(line.varianceAmount || 0)) },
              { key: "risk", label: "行级风险" },
            ]}
          />
        </div>
        <div>
          <SectionTitle title="三单匹配" right={<Chip label="行级解释" color={A.orange} bg="#fff8f0" />} />
          <DocumentLinesTable
            rows={matchRows}
            columns={[
              { key: "poLineId", label: "PO Line" },
              { key: "grnLineId", label: "GRN / Receipt Line" },
              { key: "invoiceLineId", label: "Invoice Line" },
              { key: "poQty", label: "PO 数量", align: "right", render: (line) => Number(line.poQty).toLocaleString() },
              { key: "receivedQty", label: "已收数量", align: "right", render: (line) => Number(line.receivedQty).toLocaleString() },
              { key: "invoiceQty", label: "开票数量", align: "right", render: (line) => Number(line.invoiceQty).toLocaleString() },
              { key: "poUnitPrice", label: "PO 单价", align: "right", render: (line) => fmt(Number(line.poUnitPrice || 0)) },
              { key: "invoiceUnitPrice", label: "发票单价", align: "right", render: (line) => fmt(Number(line.invoiceUnitPrice || 0)) },
              { key: "poAmount", label: "PO 金额", align: "right", render: (line) => fmt(Number(line.poAmount || 0)) },
              { key: "invoiceAmount", label: "发票金额", align: "right", render: (line) => fmt(Number(line.invoiceAmount || 0)) },
              { key: "qtyVariance", label: "数量差异", align: "right", render: (line) => Number(line.qtyVariance).toLocaleString() },
              { key: "priceVariance", label: "单价差异", align: "right", render: (line) => fmt(Number(line.priceVariance || 0)) },
              { key: "amountVariance", label: "金额差异", align: "right", render: (line) => fmt(Number(line.amountVariance || 0)) },
              { key: "receivingGap", label: "收货缺口", align: "right", render: (line) => Number(line.receivingGap).toLocaleString() },
              { key: "invoiceGap", label: "发票缺口", align: "right", render: (line) => Number(line.invoiceGap).toLocaleString() },
              { key: "status", label: "匹配状态" },
              { key: "suggestedAction", label: "建议处理" },
            ]}
          />
        </div>

        </section>


        <DocumentTotals
          totals={[
            { label: "订单金额", value: fmt(poAmount(selectedPO)), tone: "info" },
            { label: "PO Line", value: poLines.length.toLocaleString() },
            { label: "GRN Line", value: grnRows.length.toLocaleString(), tone: grnRows.length ? "success" : "warning" },
            { label: "Invoice Line", value: invoiceRows.length.toLocaleString(), tone: invoiceRows.length ? "success" : "warning" },
          ]}
          columns={4}
        />


        <div>
          <SectionTitle title="历史记录" />
          <DocumentHistoryPanel
            entityType="purchaseOrder"
            entityId={selectedPO.po}
            title="采购订单历史"
            refreshKey={selectedPO.lastAuditId || selectedPO.auditTrailIds?.join(",") || selectedPO.status}
          />
        </div>

      </DocumentShell>
    );
  })();

  if (loading) {
    return <Card className="p-12 text-center text-sm" data-testid="po-loading-state">正在读取 PostgreSQL 采购订单与履约证据…</Card>;
  }

  if (loadError) {
    return (
      <Card className="p-12 text-center" data-testid="po-error-state">
        <div className="text-sm font-semibold">采购订单加载失败</div>
        <div className="mt-2 text-xs" style={{ color: A.sub }}>{loadError}</div>
        <button type="button" onClick={() => loadWorkbench()} className="mt-4 rounded-lg bg-blue-600 px-4 py-2 text-xs font-semibold text-white">重试</button>
      </Card>
    );
  }

  if (viewMode === "detail") {
    return (
      <div className="space-y-5">
        {selectedPO ? detailContent : (
          <Card className="p-8 text-center text-xs" style={{ color: A.gray2 }}>
            未找到采购订单。
            <button onClick={returnToList} className="ml-3 px-3 py-1.5 rounded-lg font-medium" style={{ background: A.gray6, color: A.blue }}>返回 PO 列表</button>
          </Card>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-4 gap-3">
        <ActionableMetricCard label="PO 总额" value={fmt(totalAmount)} description={loading ? "加载中" : `${orders.length} 张订单`} to="/app/procurement/orders" icon={FileText} color={A.blue} />
        <ActionableMetricCard label="待收货 / 未收齐" value={String(waitingReceipt)} description="跟进未完成采购订单" to="/app/procurement/orders?status=open" icon={Truck} color={A.orange} />
        <ActionableMetricCard label="发票差异" value={String(invoiceExceptions)} description="采购与财务共同复核" to="/app/finance/invoices?matchStatus=variance" icon={AlertCircle} color={A.red} />
        <ActionableMetricCard label="匹配复核" value={String(matchExceptions)} description="查看三单匹配异常" to="/app/finance/three-way-match" icon={ShieldCheck} color={A.purple} />
      </div>

      <Card className="p-5">
        <div className="flex items-start justify-between gap-3 mb-4">
          <div>
            <SectionHeader title="采购订单查询" />
            <div className="text-xs mt-1" style={{ color: A.sub }}>
              查询 PO、来源 PR / RFQ、供应商、收货、发票和三单匹配状态
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={resetFilters}
              className="h-8 px-3 rounded-lg text-xs font-medium"
              style={{ background: A.gray6, color: A.label }}>
              重置
            </button>
            <button onClick={exportCsv}
              className="h-8 px-3 rounded-lg text-xs font-medium flex items-center gap-1.5"
              style={{ background: "#f0f6ff", color: A.blue }}>
              <FileSpreadsheet size={13} /> 导出当前结果
            </button>
          </div>
        </div>
        <div className="grid grid-cols-4 gap-3">
          <Field label="PO 编号">
            <input value={filters.poNumber} onChange={(event) => updateFilter("poNumber", event.target.value)}
              placeholder="PO-2026-1287" style={inputStyle} />
          </Field>
          <Field label="供应商">
            <input value={filters.supplier} onChange={(event) => updateFilter("supplier", event.target.value)}
              placeholder="供应商名称" style={inputStyle} />
          </Field>
          <Field label="物料 / SKU">
            <input value={filters.skuOrItem} onChange={(event) => updateFilter("skuOrItem", event.target.value)}
              placeholder="SKU 或品名" style={inputStyle} />
          </Field>
          <Field label="状态">
            <select value={filters.status} onChange={(event) => updateFilter("status", event.target.value as PurchaseOrderWorkbenchFilters["status"])}
              style={inputStyle}>
              {statusOptions.map((status) => <option key={status} value={status}>{status}</option>)}
            </select>
          </Field>
          <Field label="来源">
            <select value={filters.source} onChange={(event) => updateFilter("source", event.target.value)}
              style={inputStyle}>
              <option value="全部">全部</option>
              {sourceOptions.map((source) => (
                <option key={source} value={source}>{source === "forecast" ? "预测" : source === "manual" ? "手工" : source}</option>
              ))}
            </select>
          </Field>
          <Field label="负责人">
            <input value={filters.owner} onChange={(event) => updateFilter("owner", event.target.value)}
              placeholder="采购负责人" style={inputStyle} />
          </Field>
          <Field label="ETA 起始">
            <input value={filters.etaFrom} onChange={(event) => updateFilter("etaFrom", event.target.value)}
              placeholder="2026-06-01" style={inputStyle} />
          </Field>
          <Field label="ETA 结束">
            <input value={filters.etaTo} onChange={(event) => updateFilter("etaTo", event.target.value)}
              placeholder="2026-06-30" style={inputStyle} />
          </Field>
        </div>
      </Card>

      <Card>
        <div className="flex items-center gap-3 px-5 py-3.5" style={{ borderBottom: "0.5px solid rgba(0,0,0,0.08)" }}>
          <div>
            <div className="text-sm font-semibold" style={{ color: A.label }}>采购订单列表</div>
            <div className="text-[11px] mt-0.5" style={{ color: A.sub }}>共 {orders.length} 条，当前筛选 {filtered.length} 条</div>
          </div>
          <span className="text-xs ml-auto flex items-center gap-1.5" style={{ color: A.gray2 }}>
            <Filter size={13} /> PO / GRN / Invoice 证据
          </span>
          <Chip label="只读复核" color={A.blue} bg="#f0f6ff" />
        </div>
        <div className={tableScrollClass}>
          <table className="w-full min-w-[1200px] table-fixed text-left [&_tbody_td]:!py-0">
            <thead>
              <tr style={{ borderBottom: "0.5px solid rgba(0,0,0,0.06)" }}>
                <th className={`${thClass} sticky left-0 z-20 w-[150px] bg-slate-50`} style={{ color: A.gray1 }}>PO 编号</th>
                {["供应商", "状态", "采购负责人", "订单金额", "预计到货", "收货状态", "发票 / 匹配"].map((header) => <th key={header} className={thClass} style={{ color: A.gray1 }}>{header}</th>)}
                <th className={`${thClass} sticky right-0 z-20 w-[150px] bg-slate-50`} style={{ color: A.gray1 }}>操作</th>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 ? (
                <tr>
                  <td colSpan={9} className="p-12 text-center text-sm" style={{ color: A.sub }}>
                    当前工作区没有符合条件的采购订单。
                  </td>
                </tr>
              ) : null}
              {filtered.map((order, index) => {
                const totals = poTotals(order);
                const firstGrn = grnsForPo(order.po, facts)[0];
                const firstInvoice = invoicesForPo(order.po, facts)[0];
                return (
                  <tr key={order.po}
                    className="h-14 transition-colors hover:bg-blue-50/40"
                    style={{ borderBottom: index < filtered.length - 1 ? "0.5px solid rgba(0,0,0,0.04)" : "none" }}>
                    <td className={`${tdIdClass} sticky left-0 z-10 bg-white`}>
                      <BusinessEntityLink entityType="purchase_order" entityId={order.po} className={tableLinkClass}>{order.po}</BusinessEntityLink>
                    </td>
                    <td className={`${tdNameClass} max-w-[180px] truncate font-medium`}><BusinessEntityLink entityType="supplier" entityId={order.supplier}>{order.supplier}</BusinessEntityLink></td>
                    <td className={tdNowrapClass}><POStatusPill status={order.status} /></td>
                    <td className={tdNowrapClass} style={{ color: A.sub }}>{order.owner}</td>
                    <td className={`${tdNumericClass} font-semibold`} style={{ color: A.label }}>{fmt(poAmount(order))}</td>
                    <td className={tdNowrapClass} style={{ color: A.sub }}>{order.eta}</td>
                    <td className={tdNowrapClass}>{statusChip(receivedStatus(order, facts))}</td>
                    <td className={tdNowrapClass}><div>{statusChip(invoiceStatus(order, facts))}</div><div className="mt-1 text-[11px] text-slate-500">{matchStatus(order, facts)}</div></td>
                    <td className={`${tdActionClass} sticky right-0 z-10 bg-white`}>
                      <div className="flex items-center justify-end gap-1.5">
                        <button onClick={() => openDetail(order.po)} className="rounded-md bg-blue-50 px-2 py-1 text-[11px] font-medium text-blue-600">查看</button>
                        <details className="relative"><summary className="cursor-pointer list-none rounded-md bg-slate-100 px-2 py-1 text-[11px] font-medium">更多</summary><div className="absolute right-0 top-7 z-30 w-40 rounded-lg border border-slate-200 bg-white p-1 shadow-lg">
                          <button onClick={() => openDetail(order.po)} className="w-full rounded px-2 py-1.5 text-left text-xs hover:bg-slate-50">查看订单行与证据</button>
                          {firstGrn && <button onClick={() => navigateOrderWithReturn(order, "procurement:receiving", { entityType: "receiving_doc", entityId: firstGrn.grn }, firstGrn.grn)} className="w-full rounded px-2 py-1.5 text-left text-xs hover:bg-slate-50">打开收货记录</button>}
                          {firstInvoice && <button onClick={() => navigateOrderWithReturn(order, "finance:invoices", { entityType: "supplier_invoice", entityId: firstInvoice.invoiceNumber }, firstInvoice.invoiceNumber)} className="w-full rounded px-2 py-1.5 text-left text-xs hover:bg-slate-50">打开发票记录</button>}
                          <button onClick={() => navigateOrderWithReturn(order, "finance:three-way-match")} className="w-full rounded px-2 py-1.5 text-left text-xs hover:bg-slate-50">打开三单匹配</button>
                          {order.sourceRequest && <button onClick={() => navigateOrderWithReturn(order, "procurement:requests", { entityType: "purchase_request", entityId: order.sourceRequest }, order.sourceRequest)} className="w-full rounded px-2 py-1.5 text-left text-xs hover:bg-slate-50">打开来源 PR</button>}
                          {order.sourceRfq && <button onClick={() => navigateOrderWithReturn(order, "procurement:rfq", { entityType: "rfq", entityId: order.sourceRfq }, order.sourceRfq)} className="w-full rounded px-2 py-1.5 text-left text-xs hover:bg-slate-50">打开来源 RFQ</button>}
                        </div></details>
                      </div>
                    </td>
                  </tr>
                );
              })}
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={9} className="px-4 py-12 text-center text-xs" style={{ color: A.gray2 }}>
                    当前条件下暂无采购订单
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>

    </div>
  );
}
