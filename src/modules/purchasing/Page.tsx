import React, { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router";
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
import { purchaseOrders, receivingDocs, SUPPLIER_INVOICES } from "../../data/empty-business-state";
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
  DocumentEvidencePanel,
  DocumentHeader,
  DocumentLinesTable,
  DocumentShell,
  DocumentStatusTimeline,
  DocumentTotals,
  statusTone,
  type TimelineStep,
} from "../../components/document/DocumentShell";
import { getPoLinkedDocuments } from "../../domain/procurement/document-links";
import { calculateInvoiceMatch } from "../../domain/procurement/invoice-matching";
import { relatedRecordsForEntity } from "../../domain/relationships";
import { poDelayedRisk } from "../../domain/contextual-ai";
import { grnLinesOf } from "../../domain/receiving/helpers";
import { lineRemaining, lineStatusLabel, poLinesOf, poTotals, toNumber } from "../../domain/purchasing/helpers";
import type { WorkflowContext } from "../../lib/workflowContext";
import type { ActiveContext } from "../ai-assistant/Panel";
import CanonicalDownstreamPanel from "../../components/procurement/CanonicalDownstreamPanel";
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

type AccrualRow = {
  po: string;
  poLineId: string;
  pr: string;
  requestedBy: string;
  item: string;
  supplier: string;
  qty: number;
  unit: string;
  unitPrice: number;
  needBy: string;
  uninvoicedQty: number;
  uninvoicedTotal: number;
  currency: string;
  grnLine: string;
  receivedQty: number;
  approvedInvoicedQty: number;
  openQty: number;
  lineAmount: number;
  approvedInvoicedAmount: number;
  accrualExposure: number;
  risk: string;
  suggestedAction: string;
};

function statusChip(status: string) {
  return <Chip label={status} color={statusTone(status) === "danger" ? A.red : statusTone(status) === "warning" ? A.orange : statusTone(status) === "success" ? A.green : A.blue} bg={statusTone(status) === "danger" ? "#fff1f0" : statusTone(status) === "warning" ? "#fff8f0" : statusTone(status) === "success" ? "#f0faf4" : "#f0f6ff"} />;
}

function safeText(value: unknown, fallback = "待补齐") {
  const text = String(value ?? "").trim();
  return text || fallback;
}

function staticPo(poId?: string) {
  return purchaseOrders.find((item) => item.po === poId);
}

function poAmount(po?: PurchaseOrder | null) {
  if (!po) return 0;
  const fallback = staticPo(po.po);
  const invoiceTotal = SUPPLIER_INVOICES.filter((invoice) => invoice.relatedPo === po.po)
    .reduce((sum, invoice) => sum + Number(invoice.subtotal || 0), 0);
  const totals = poTotals(po);
  return Number(po.totalAmount || totals.totalAmount || po.amount || fallback?.amount || invoiceTotal || 0);
}

function poLineAmount(line: { quantityOrdered?: number; unitPrice?: number }, po?: PurchaseOrder | null) {
  const direct = toNumber(line.quantityOrdered) * toNumber(line.unitPrice);
  if (direct > 0) return direct;
  const lines = poLinesOf(po);
  const totalQty = lines.reduce((sum, item) => sum + toNumber(item.quantityOrdered), 0);
  return totalQty ? Math.round(poAmount(po) * (toNumber(line.quantityOrdered) / totalQty)) : poAmount(po);
}

function unitPriceForLine(line: { quantityOrdered?: number; unitPrice?: number; poLineId?: string }, po?: PurchaseOrder | null) {
  const direct = toNumber(line.unitPrice);
  if (direct > 0) return direct;
  const invoiceLine = SUPPLIER_INVOICES.flatMap((invoice) => invoice.lines)
    .find((item) => item.poLine === line.poLineId);
  if (invoiceLine?.unitPrice) return toNumber(invoiceLine.unitPrice);
  const qty = toNumber(line.quantityOrdered);
  return qty ? poLineAmount(line, po) / qty : 0;
}

function invoicesForPo(poId?: string) {
  return SUPPLIER_INVOICES.filter((invoice) => invoice.relatedPo === poId);
}

function grnsForPo(poId?: string) {
  return receivingDocs.filter((doc) => doc.po === poId);
}

function receivedStatus(po: PurchaseOrder) {
  const totals = poTotals(po);
  const grns = grnsForPo(po.po);
  if (grns.some((doc) => doc.status === "异常处理")) return "异常处理";
  if (totals.totalOrderedQty > 0 && totals.totalReceivedQty >= totals.totalOrderedQty) return "已收货";
  if (totals.totalReceivedQty > 0) return "部分收货";
  if (grns.length > 0) return "待收货";
  return "未收货";
}

function invoiceStatus(po: PurchaseOrder) {
  const invoices = invoicesForPo(po.po);
  if (!invoices.length) return "未开票";
  if (invoices.some((invoice) => invoice.varianceType !== "无差异" || invoice.matchStatus === "差异待处理")) return "发票差异";
  if (invoices.every((invoice) => invoice.paid)) return "已付款";
  return "已开票";
}

function matchStatus(po: PurchaseOrder) {
  const invoices = invoicesForPo(po.po);
  const grns = grnsForPo(po.po);
  if (!invoices.length) return "缺少发票";
  if (!grns.length || grns.some((doc) => doc.status === "待收货" || doc.status === "质检中")) return "缺少收货";
  const variance = invoices.find((invoice) => invoice.varianceType !== "无差异" || invoice.varianceAmount > 0);
  if (variance) return variance.varianceType;
  if (invoices.every((invoice) => invoice.matchStatus === "自动匹配" || invoice.matchStatus === "已解决")) return "已匹配";
  return "需人工复核";
}

function nextStepForPo(po: PurchaseOrder) {
  const status = matchStatus(po);
  if (status === "缺少收货") return "等待收货";
  if (status === "缺少发票") return "等待发票";
  if (status === "数量差异") return "复核收货记录";
  if (status === "价格差异") return "复核供应商发票";
  if (status === "已匹配") return "财务协同复核";
  if (receivedStatus(po) === "异常处理") return "生成内部差异说明草稿";
  return "需人工复核";
}

function poTimeline(po: PurchaseOrder): TimelineStep[] {
  const receipt = receivedStatus(po);
  const invoice = invoiceStatus(po);
  const match = matchStatus(po);
  return [
    { label: "来源确认", status: po.sourceRequest || po.sourceRfq ? "done" : "warning", helper: po.sourceRequest || po.sourceRfq || "来源待补齐" },
    { label: "PO 已建立", status: "done", helper: po.created },
    { label: "收货证据", status: receipt === "未收货" ? "pending" : receipt === "异常处理" ? "warning" : "done", helper: receipt },
    { label: "发票证据", status: invoice === "未开票" ? "pending" : invoice === "发票差异" ? "warning" : "done", helper: invoice },
    { label: "三单匹配", status: match === "已匹配" ? "done" : match === "缺少发票" || match === "缺少收货" ? "pending" : "warning", helper: match },
    { label: "人工复核", status: match === "已匹配" ? "pending" : "current", helper: nextStepForPo(po) },
  ];
}

function buildPoLineRows(po: PurchaseOrder): PoEvidenceRow[] {
  return poLinesOf(po).map((line, index) => {
    const invoiceQty = SUPPLIER_INVOICES.flatMap((invoice) => invoice.lines)
      .filter((invoiceLine) => invoiceLine.poLine === line.poLineId)
      .reduce((sum, invoiceLine) => sum + toNumber(invoiceLine.quantity), 0);
    const ordered = toNumber(line.quantityOrdered);
    const received = toNumber(line.quantityReceived);
    const remaining = lineRemaining(line);
    const unitPrice = unitPriceForLine(line, po);
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

function buildGrnRows(po: PurchaseOrder): GrnEvidenceRow[] {
  const poLines = poLinesOf(po);
  return grnsForPo(po.po).flatMap((grn) => {
    const lines = grnLinesOf(grn);
    return lines.map((line, index) => {
      const poLine = poLines.find((item) => item.poLineId === line.poLineId) || poLines[index] || poLines[0];
      const relatedInvoiceLine = SUPPLIER_INVOICES.flatMap((invoice) => invoice.lines.map((invoiceLine) => ({ invoice, invoiceLine })))
        .find(({ invoice, invoiceLine }) => invoice.relatedPo === po.po && (invoiceLine.grnLine === line.grnLineId || invoiceLine.poLine === poLine?.poLineId));
      const unitPrice = unitPriceForLine(poLine || {}, po);
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

function buildInvoiceRows(po: PurchaseOrder): InvoiceEvidenceRow[] {
  return invoicesForPo(po.po).flatMap((invoice) => invoice.lines.map((line) => ({
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
  })));
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

function buildMatchRows(po: PurchaseOrder): MatchEvidenceRow[] {
  const grnRows = buildGrnRows(po);
  const invoiceRows = buildInvoiceRows(po);
  return buildPoLineRows(po).map((line) => {
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

function buildAccrualRows(po: PurchaseOrder): AccrualRow[] {
  const invoiceRows = buildInvoiceRows(po);
  const grnRows = buildGrnRows(po);
  return buildPoLineRows(po).map((line) => {
    const invoiced = invoiceRows.filter((row) => row.poLineId === line.poLineId);
    const received = grnRows.filter((row) => row.poLineId === line.poLineId);
    const approvedInvoicedQty = invoiced
      .filter((row) => !["差异待处理", "未匹配"].includes(row.matchStatus))
      .reduce((sum, row) => sum + row.quantity, 0);
    const receivedQty = received.reduce((sum, row) => sum + row.receivedQty, 0) || line.receivedQty;
    const approvedInvoicedAmount = approvedInvoicedQty * line.unitPrice;
    const receivedAmount = receivedQty * line.unitPrice;
    const openQty = Math.max(0, receivedQty - approvedInvoicedQty);
    const uninvoicedQty = Math.max(0, line.quantity - invoiced.reduce((sum, row) => sum + row.quantity, 0));
    return {
      po: po.po,
      poLineId: line.poLineId,
      pr: safeText(po.sourceRequest, "来源 PR 待补齐"),
      requestedBy: safeText(po.owner, "申请人待补齐"),
      item: `${line.sku} · ${line.itemName}`,
      supplier: po.supplier,
      qty: line.quantity,
      unit: line.unit,
      unitPrice: line.unitPrice,
      needBy: line.requiredDate,
      uninvoicedQty,
      uninvoicedTotal: Math.round(uninvoicedQty * line.unitPrice),
      currency: po.currency || "CNY",
      grnLine: received[0]?.grnLineId || "GRN Line 待补齐",
      receivedQty,
      approvedInvoicedQty,
      openQty,
      lineAmount: receivedAmount,
      approvedInvoicedAmount,
      accrualExposure: Math.round(Math.max(0, receivedAmount - approvedInvoicedAmount)),
      risk: openQty > 0 ? "已收未票风险" : uninvoicedQty > 0 ? "未开票订单" : "低风险",
      suggestedAction: openQty > 0 ? "等待供应商发票" : uninvoicedQty > 0 ? "等待发票" : "财务协同复核",
    };
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
  if (!focus) return <CanonicalDownstreamPanel kind="orders" />;
  const [searchParams, setSearchParams] = useSearchParams();
  const [orders, setOrders] = useState<PurchaseOrder[]>(purchaseOrders);
  const [loading, setLoading] = useState(true);
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
  const [selectedId, setSelectedId] = useState(purchaseOrders[0]?.po ?? "");
  const [viewMode, setViewMode] = useState<PurchaseOrderViewMode>("list");
  const [highlightedArea, setHighlightedArea] = useState("");
  const fulfillmentFocusRef = useRef<HTMLElement | null>(null);
  const evidenceFocusRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let alive = true;
    apiJson<PurchaseOrder[]>("/api/purchase-orders")
      .then((data) => {
        if (!alive) return;
        setOrders(data);
        setSelectedId((current) => data.some((order) => order.po === current) ? current : data[0]?.po ?? "");
      })
      .catch(() => toast.error("采购订单 API 未连接", { description: "当前页面保留本地工作区数据用于只读查看。" }))
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    if (focus?.entityType !== "purchase_order" || !focus.entityId) return;
    if (!orders.some((order) => order.po === focus.entityId)) return;
    setSelectedId(focus.entityId);
    setViewMode("detail");
  }, [focus?.at, focus?.entityType, focus?.entityId, orders]);

  useEffect(() => {
    if (viewMode !== "detail" || focus?.entityType !== "purchase_order" || focus.entityId !== selectedId) return;
    const area = focus.focusArea || "receiving-invoice-variance";
    setHighlightedArea(area);
    const target = area === "evidence" ? evidenceFocusRef.current : fulfillmentFocusRef.current;
    const frame = window.requestAnimationFrame(() => target?.scrollIntoView({ behavior: "smooth", block: "start" }));
    const timer = window.setTimeout(() => setHighlightedArea(""), 5000);
    return () => {
      window.cancelAnimationFrame(frame);
      window.clearTimeout(timer);
    };
  }, [focus?.at, focus?.entityId, focus?.entityType, focus?.focusArea, selectedId, viewMode]);

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
  const selectedPO = orders.find((order) => order.po === selectedId) ?? filtered[0] ?? orders[0] ?? null;
  const selectedPOTotals = poTotals(selectedPO);
  const sourceOptions = Array.from(new Set(orders.map((order) => order.source || "manual"))).sort();
  const statusOptions = ["全部", "草稿", "待审批", "已审批", "已发出", "部分到货", "已完成", "已驳回", "已取消"] as const;

  useEffect(() => {
    if (!filtered.length) {
      if (selectedId) setSelectedId("");
      return;
    }
    if (!filtered.some((order) => order.po === selectedId)) {
      setSelectedId(filtered[0].po);
    }
  }, [filtered, selectedId]);

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
  const waitingReceipt = orders.filter((order) => receivedStatus(order) !== "已收货").length;
  const invoiceExceptions = orders.filter((order) => invoiceStatus(order) === "发票差异").length;
  const matchExceptions = orders.filter((order) => !["已匹配", "缺少发票"].includes(matchStatus(order))).length;

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
    setViewMode("detail");
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
      收货状态: receivedStatus(order),
      发票状态: invoiceStatus(order),
      三单匹配状态: matchStatus(order),
      下一步: nextStepForPo(order),
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
    const poLines = buildPoLineRows(selectedPO);
    const grnRows = buildGrnRows(selectedPO);
    const invoiceRows = buildInvoiceRows(selectedPO);
    const matchRows = buildMatchRows(selectedPO);
    const accrualRows = buildAccrualRows(selectedPO);
    const invoices = invoicesForPo(selectedPO.po);
    const grns = grnsForPo(selectedPO.po);
    const delayRisk = poDelayedRisk(
      selectedPO.eta,
      selectedPO.status,
      selectedPOTotals.totalOrderedQty,
      selectedPOTotals.totalReceivedQty,
    );
    const selectedPoReturnContext: WorkflowContext = {
      sourceModule: "procurement",
      sourceEntityType: "purchase_order",
      sourceEntityId: selectedPO.po,
      sourceRoute: "procurement:orders",
      sourceLabel: selectedPO.po,
      returnLabel: `返回采购订单 ${selectedPO.po}`,
    };
    const firstGrn = grns[0];
    const firstInvoice = invoices[0];

    return (
      <DocumentShell
        title="采购订单 / PO"
        documentNo={selectedPO.po}
        moduleLabel="采购订单证据"
        status={selectedPO.status}
        subtitle={`${selectedPO.supplier} · ${receivedStatus(selectedPO)} · ${invoiceStatus(selectedPO)}`}
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
            { key: "list-short", label: "返回列表", onClick: () => setViewMode("list"), kind: "list" },
            { key: "po-list", label: "返回 PO 列表", onClick: () => setViewMode("list"), kind: "list" },
            ...(firstGrn ? [{
              key: "receiving",
              label: "查看收货单", onClick: () => navigateWithReturn("procurement:receiving", { entityType: "receiving_doc", entityId: firstGrn.grn }, firstGrn.grn), kind: "module" as const, tone: "subtle" as const,
            }] : []),
            ...(firstInvoice ? [{
              key: "invoice",
              label: "查看供应商发票", onClick: () => navigateWithReturn("procurement:invoices", { entityType: "supplier_invoice", entityId: firstInvoice.invoiceNumber }, firstInvoice.invoiceNumber), kind: "module" as const, tone: "subtle" as const,
            }] : []),
            { key: "match", label: "查看三单匹配", onClick: () => navigateWithReturn("procurement:match"), kind: "module", tone: "subtle" },
            { key: "module", label: "返回采购工作台", onClick: () => onNavigate?.("procurement"), kind: "module", tone: "subtle" },
            { key: "previous", label: "返回上一级", onClick: () => setViewMode("list"), kind: "previous" },
            { key: "evidence", label: "返回证据链", onClick: () => onNavigate?.("sales:evidence"), kind: "module", tone: "subtle" },
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
              { label: "收货状态", value: receivedStatus(selectedPO), tone: statusTone(receivedStatus(selectedPO)) },
              { label: "发票状态", value: invoiceStatus(selectedPO), tone: statusTone(invoiceStatus(selectedPO)) },
              { label: "匹配状态", value: matchStatus(selectedPO), tone: statusTone(matchStatus(selectedPO)) },
              { label: "当前下一步", value: nextStepForPo(selectedPO), tone: "warning" },
              { label: "延迟 / 未收齐风险", value: delayRisk.delayed ? "需关注" : "未触发", tone: delayRisk.delayed ? "warning" : "success", helper: delayRisk.reason },
            ]}
          />
        </div>

        <DocumentStatusTimeline steps={poTimeline(selectedPO)} />

        <div>
          <SectionTitle title="PO 明细行" right={<Chip label={`${poLines.length} 行`} color={A.blue} bg="#f0f6ff" />} />
          <DocumentLinesTable
            rows={poLines}
            columns={[
              { key: "poLineId", label: "PO Line 编号", render: (line) => <span style={{ color: A.blue }}>{String(line.poLineId)}</span> },
              { key: "sourcePrLine", label: "来源 PR Line" },
              { key: "sourceRfqLine", label: "来源 RFQ Line" },
              { key: "sku", label: "SKU" },
              { key: "itemName", label: "物料名称" },
              { key: "quantity", label: "数量", align: "right", render: (line) => Number(line.quantity).toLocaleString() },
              { key: "unit", label: "单位" },
              { key: "unitPrice", label: "单价", align: "right", render: (line) => fmt(Number(line.unitPrice || 0)) },
              { key: "lineAmount", label: "行金额", align: "right", render: (line) => fmt(Number(line.lineAmount || 0)) },
              { key: "warehouse", label: "目标仓库" },
              { key: "requiredDate", label: "需求日期" },
              { key: "promisedDate", label: "预计到货" },
              { key: "receivedQty", label: "已收数量", align: "right", render: (line) => Number(line.receivedQty).toLocaleString() },
              { key: "remainingQty", label: "未收数量", align: "right", render: (line) => Number(line.remainingQty).toLocaleString() },
              { key: "invoicedQty", label: "已开票数量", align: "right", render: (line) => Number(line.invoicedQty).toLocaleString() },
              { key: "uninvoicedQty", label: "未开票数量", align: "right", render: (line) => Number(line.uninvoicedQty).toLocaleString() },
              { key: "status", label: "行状态" },
              { key: "risk", label: "行级风险" },
            ]}
          />
        </div>
        <Card className="p-4">
          <SectionTitle title="来源 PR / RFQ" />
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-xs">
            {[
              ["来源 PR", selectedPO.sourceRequest || "来源 PR 待补齐", selectedPO.sourceRequest ? A.blue : A.orange],
              ["来源 RFQ", selectedPO.sourceRfq || "来源 RFQ 待补齐", selectedPO.sourceRfq ? A.blue : A.orange],
              ["来源说明", selectedPO.reason || "当前 PO 来源关系用于解释从申请、寻源到订单的业务链路。", A.label],
            ].map(([label, value, color]) => (
              <div key={String(label)} className="rounded-lg px-3 py-2" style={{ background: A.gray6 }}>
                <div className="fc-caption" style={{ color: A.gray2 }}>{label}</div>
                <div className="text-xs font-semibold mt-1 truncate" style={{ color: String(color) }}>{value}</div>
              </div>
            ))}
          </div>
        </Card>

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
                {receivedStatus(selectedPO)} · {invoiceStatus(selectedPO)} · 建议：{nextStepForPo(selectedPO)}
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

        <div>
          <SectionTitle title="未开票 / 已收未票" />
          <DocumentLinesTable
            rows={accrualRows}
            columns={[
              { key: "po", label: "PO 编号" }, { key: "poLineId", label: "PO 明细行" }, { key: "pr", label: "申请 / PR" },
              { key: "requestedBy", label: "申请人" }, { key: "item", label: "物料 / SKU" }, { key: "supplier", label: "供应商" },
              { key: "qty", label: "数量", align: "right", render: (line) => Number(line.qty).toLocaleString() }, { key: "unit", label: "单位" },
              { key: "unitPrice", label: "单价", align: "right", render: (line) => fmt(Number(line.unitPrice || 0)) }, { key: "needBy", label: "需求日期" },
              { key: "uninvoicedQty", label: "未开票数量", align: "right", render: (line) => Number(line.uninvoicedQty).toLocaleString() }, { key: "uninvoicedTotal", label: "未开票金额", align: "right", render: (line) => fmt(Number(line.uninvoicedTotal || 0)) },
              { key: "currency", label: "币种" }, { key: "grnLine", label: "收货明细行" }, { key: "receivedQty", label: "已收数量", align: "right", render: (line) => Number(line.receivedQty).toLocaleString() },
              { key: "approvedInvoicedQty", label: "已批准开票数量", align: "right", render: (line) => Number(line.approvedInvoicedQty).toLocaleString() }, { key: "openQty", label: "未结数量", align: "right", render: (line) => Number(line.openQty).toLocaleString() },
              { key: "lineAmount", label: "明细金额", align: "right", render: (line) => fmt(Number(line.lineAmount || 0)) }, { key: "approvedInvoicedAmount", label: "已批准开票金额", align: "right", render: (line) => fmt(Number(line.approvedInvoicedAmount || 0)) },
              { key: "accrualExposure", label: "已收未票金额", align: "right", render: (line) => fmt(Number(line.accrualExposure || 0)) }, { key: "risk", label: "风险" }, { key: "suggestedAction", label: "建议动作" },
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
            { label: "已收未票风险", value: accrualRows.filter((row) => row.accrualExposure > 0).length.toLocaleString(), tone: accrualRows.some((row) => row.accrualExposure > 0) ? "warning" : "success" },
          ]}
          columns={5}
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

        <div
          ref={evidenceFocusRef}
          data-testid="po-evidence-focus"
          data-focus-highlight={highlightedArea === "evidence" ? "true" : "false"}
          className="scroll-mt-20 rounded-xl p-2 transition-all"
          style={highlightedArea === "evidence" ? { background: "#eef5ff", boxShadow: `0 0 0 2px ${A.blue}55` } : undefined}
        >
          <SectionTitle title="证据链" />
          <DocumentEvidencePanel
            linkedDocuments={getPoLinkedDocuments(selectedPO, SUPPLIER_INVOICES, receivingDocs)}
            onNavigate={onNavigate}
            returnContext={selectedPoReturnContext}
            relatedRecords={relatedRecordsForEntity({ purchaseOrders: orders, receivingDocs, supplierInvoices: SUPPLIER_INVOICES }, "purchaseOrder", selectedPO.po)}
            provenance="工作区业务记录"
            notes={`${selectedPO.po} 证据链覆盖来源 PR / RFQ、PO Line、GRN Line、Invoice Line、三单匹配和已收未票可见性。`}
            evidence={[
              { label: "来源 PR", value: selectedPO.sourceRequest || "待补齐", tone: selectedPO.sourceRequest ? "info" : "warning" },
              { label: "来源 RFQ", value: selectedPO.sourceRfq || "待补齐", tone: selectedPO.sourceRfq ? "info" : "warning" },
              { label: "关联 GRN", value: grns.map((item) => item.grn).join(", ") || "待补齐", tone: grns.length ? "success" : "warning" },
              { label: "关联发票", value: invoices.map((item) => item.invoiceNumber).join(", ") || "待补齐", tone: invoices.length ? "success" : "warning" },
              { label: "三单匹配", value: matchStatus(selectedPO), tone: statusTone(matchStatus(selectedPO)) },
              { label: "已收未票", value: fmt(accrualRows.reduce((sum, row) => sum + row.accrualExposure, 0)), tone: accrualRows.some((row) => row.accrualExposure > 0) ? "warning" : "success" },
            ]}
          />
        </div>

      </DocumentShell>
    );
  })();

  if (viewMode === "detail") {
    return (
      <div className="space-y-5">
        {selectedPO ? detailContent : (
          <Card className="p-8 text-center text-xs" style={{ color: A.gray2 }}>
            未找到采购订单。
            <button onClick={() => setViewMode("list")} className="ml-3 px-3 py-1.5 rounded-lg font-medium" style={{ background: A.gray6, color: A.blue }}>返回 PO 列表</button>
          </Card>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <CanonicalDownstreamPanel kind="orders" />
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
              {filtered.map((order, index) => {
                const totals = poTotals(order);
                const firstGrn = grnsForPo(order.po)[0];
                const firstInvoice = invoicesForPo(order.po)[0];
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
                    <td className={tdNowrapClass}>{statusChip(receivedStatus(order))}</td>
                    <td className={tdNowrapClass}><div>{statusChip(invoiceStatus(order))}</div><div className="mt-1 text-[11px] text-slate-500">{matchStatus(order)}</div></td>
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
