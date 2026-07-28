import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, Boxes, ClipboardList, FileText, GitBranch, PackageSearch, ShoppingCart, Truck, Users } from "lucide-react";
import { apiJson } from "../../lib/api-client";
import { A, Card, Chip, KpiCard, SectionHeader } from "../../components/ui";
import type { InventoryAvailability } from "../inventory/api";
import {
  BusinessObjectDetailModal,
  CompactKpiStrip,
  DataLimitationsPanel,
  DetailFieldGrid,
  DetailSection,
  EvidenceSummaryPanel,
  ReviewActionPanel,
} from "../../components/business/BusinessObjectDetail";
import EvidenceGraphPanel, { type EvidenceGraphResponse, type EvidenceNavigate } from "../../components/evidence/EvidenceGraphPanel";
import DeliveryPage from "./DeliveryPage";
import ReceiptPage from "./ReceiptPage";
import SalesReturnPage from "./SalesReturnPage";
import { BusinessDocumentForm } from "../../components/business/BusinessDocumentForm";
import { Link, useLocation, useSearchParams } from "react-router";
import { ActionableMetricCard } from "../../components/cards/ActionableMetricCard";
import { EntityLink } from "../../components/business/EntityLink";
import OutboundWorkbench from "./OutboundWorkbench";

type SalesOrder = {
  salesOrderId: string;
  customerName: string;
  customerTier: string;
  sku: string;
  itemName: string;
  orderedQty: number;
  reservedQty: number;
  fulfilledQty: number;
  shortageQty: number;
  promisedDate: string;
  statusLabel: string;
  priority: string;
  deliveryRiskLevel: "blocked" | "high" | "medium" | "low";
  deliveryRiskLabel: string;
  deliveryRiskReason: string;
  linkedInventory?: { availableQuantity?: number; safetyStock?: number; status?: string } | null;
  linkedPurchaseOrders: Array<{ id: string; supplierName?: string; status?: string; expectedDate?: string }>;
  linkedSuppliers: Array<{ id: string; name: string; risk?: string; status?: string }>;
  linkedReceivingDocs: Array<{ id: string; status?: string; poId?: string }>;
  linkedExceptionCases: string[];
  evidence: Array<{ type: string; id: string; label: string; summary?: string; status?: string }>;
  dataLimitations: string[];
};

type SalesSummary = {
  totalOrders: number;
  riskOrderCount: number;
  highRiskOrderCount: number;
  shortageQty: number;
  reservedQty: number;
  affectedCustomerCount: number;
};

type FocusTarget = {
  entityType: string;
  entityId: string;
  entityLabel?: string;
} | null;

type SalesView = "orders" | "risks" | "evidence";

type SalesDemandPageProps = {
  initialView?: "risks" | "evidence" | string;
  focus?: FocusTarget;
  onNavigate?: EvidenceNavigate;
  onOpenAi?: () => void;
};

const riskColor: Record<string, string> = {
  blocked: A.red,
  high: A.red,
  medium: A.orange,
  low: A.green,
};

const riskRank: Record<SalesOrder["deliveryRiskLevel"], number> = {
  blocked: 0,
  high: 1,
  medium: 2,
  low: 3,
};

function limitationLabel(code: string) {
  return ({
    missing_inventory_allocation: "当前工作区缺少完整库存分配记录",
    missing_purchase_order_links: "当前工作区缺少完整采购订单关联",
    missing_receiving_records: "当前工作区缺少完整收货记录",
    missing_supplier_risk_records: "当前工作区缺少完整供应商风险记录",
    current_workspace_data_limited: "当前数据范围有限，需人工复核",
    record_not_found: "未找到对应记录",
    inventory_availability_not_joined: "尚未关联权威库存可用量",
    purchase_supply_not_joined: "尚未关联采购在途与供应商交付承诺",
    risk_summary_aggregates_multiple_lines: "风险数量为多明细行汇总",
  } as Record<string, string>)[code] || code;
}

function qty(value: number) {
  return Number(value || 0).toLocaleString("zh-CN");
}

function viewFromInitial(initialView?: string): SalesView {
  if (initialView === "evidence") return "evidence";
  if (initialView === "risks") return "risks";
  return "orders";
}

export default function SalesDemandPage(props: SalesDemandPageProps) {
  const location = useLocation();
  if (location.pathname === "/app/sales/orders" || location.pathname === "/app/sales/orders/new" || /^\/app\/sales\/orders\/[^/]+$/.test(location.pathname) || /^\/app\/sales\/shipments\/[^/]+$/.test(location.pathname)) return <OutboundWorkbench />;
  const documentId = decodeURIComponent(location.pathname.split("/").at(-2) || "");
  if (props.initialView === "delivery-new") return <BusinessDocumentForm documentLabel="发货单" listPath="/app/sales/deliveries" />;
  if (props.initialView === "delivery-edit") return <BusinessDocumentForm mode="edit" documentLabel="发货单" documentId={documentId} listPath="/app/sales/deliveries" />;
  if (props.initialView === "receipts-new") return <BusinessDocumentForm documentLabel="签收单" listPath="/app/sales/receipts" />;
  if (props.initialView === "returns-new") return <BusinessDocumentForm documentLabel="销售退货单" listPath="/app/sales/returns" />;
  if (props.initialView === "delivery") return <DeliveryPage />;
  if (props.initialView === "receipts") return <ReceiptPage />;
  if (props.initialView === "returns") return <SalesReturnPage />;
  return <SalesDemandCore {...props} />;
}

function SalesDemandCore({ initialView, focus, onNavigate, onOpenAi }: SalesDemandPageProps) {
  const [searchParams] = useSearchParams();
  const view = viewFromInitial(initialView);
  const [orders, setOrders] = useState<SalesOrder[]>([]);
  const [availability] = useState<InventoryAvailability[]>([]);
  const [summary, setSummary] = useState<SalesSummary | null>(null);
  const [loadingOrders, setLoadingOrders] = useState(true);
  const [ordersError, setOrdersError] = useState("");
  const [allocationWarning] = useState("库存分配尚未接入销售订单运行时仓库，当前不展示未经接入的可承诺量。");
  const [selectedOrderId, setSelectedOrderId] = useState("");
  const [detailOpen, setDetailOpen] = useState(false);

  useEffect(() => {
    let alive = true;
    setLoadingOrders(true);
    setOrdersError("");
    apiJson<{ orders: SalesOrder[]; summary: SalesSummary }>("/api/sales-demand/orders")
      .then((payload) => {
        if (!alive) return;
        setOrders(payload.orders || []);
        setSummary(payload.summary || null);
      })
      .catch(() => {
        if (!alive) return;
        setOrdersError("当前未读取到客户订单记录，请检查工作区数据或刷新后重试。");
      })
      .finally(() => { if (alive) setLoadingOrders(false); });

    return () => { alive = false; };
  }, []);

  useEffect(() => {
    if (!focus?.entityId) return;
    if (focus.entityType === "sales_order" || focus.entityType === "customer_order") {
      setSelectedOrderId(focus.entityId);
      setDetailOpen(true);
      return;
    }
    if (focus.entityType === "inventory_item" || focus.entityType === "item" || focus.entityType === "sku") {
      const related = orders.find((order) => order.sku === focus.entityId);
      if (related) setSelectedOrderId(related.salesOrderId);
    }
  }, [focus?.entityId, focus?.entityType, orders]);

  function openOrderDetail(orderId: string) {
    setSelectedOrderId(orderId);
    setDetailOpen(true);
  }

  const focusedOrder = useMemo(() => {
    if (!focus?.entityId) return null;
    return orders.find((order) => order.salesOrderId === focus.entityId) || null;
  }, [focus, orders]);
  const selectedOrder = useMemo(() => {
    return orders.find((order) => order.salesOrderId === selectedOrderId) || focusedOrder || null;
  }, [focusedOrder, orders, selectedOrderId]);
  const availabilityBySku = useMemo(() => new Map(availability.map((item) => [item.sku, item])), [availability]);
  const visibleOrders = useMemo(() => {
    const customer = searchParams.get("customer") || "";
    const status = searchParams.get("status") || "";
    const risk = searchParams.get("risk") || "";
    const filtered = orders.filter((order) => (!customer || order.customerName === customer)
      && (!status || (status === "unshipped" ? !/已完成|已交付/.test(order.statusLabel) : order.statusLabel === status))
      && (!risk || (risk === "true" ? order.deliveryRiskLevel !== "low" : order.deliveryRiskLevel === risk)));
    if (!focusedOrder) return filtered;
    return [focusedOrder, ...filtered.filter((order) => order.salesOrderId !== focusedOrder.salesOrderId)];
  }, [orders, focusedOrder, searchParams]);
  const riskOrders = useMemo(() => {
    return orders
      .filter((order) => order.deliveryRiskLevel !== "low")
      .sort((a, b) => riskRank[a.deliveryRiskLevel] - riskRank[b.deliveryRiskLevel] || b.shortageQty - a.shortageQty);
  }, [orders]);
  const evidenceOrders = useMemo(() => {
    if (selectedOrder) return [selectedOrder];
    if (focusedOrder) return [focusedOrder];
    return riskOrders.length ? riskOrders.slice(0, 3) : orders.slice(0, 3);
  }, [focusedOrder, orders, riskOrders, selectedOrder]);

  const activeSummary = summary || {
    totalOrders: orders.length,
    riskOrderCount: riskOrders.length,
    highRiskOrderCount: orders.filter((order) => order.deliveryRiskLevel === "high" || order.deliveryRiskLevel === "blocked").length,
    shortageQty: orders.reduce((sum, order) => sum + order.shortageQty, 0),
    reservedQty: orders.reduce((sum, order) => sum + order.reservedQty, 0),
    affectedCustomerCount: new Set(riskOrders.map((order) => order.customerName)).size,
  };

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <ActionableMetricCard label="客户订单" value={String(activeSummary.totalOrders)} description="查看当前工作区全部订单" to="/app/sales/orders" icon={ClipboardList} color={A.blue} />
        <ActionableMetricCard label="交付风险" value={String(activeSummary.riskOrderCount)} description={`${activeSummary.highRiskOrderCount} 个高风险订单`} to="/app/sales/orders?risk=true" icon={AlertTriangle} color={activeSummary.highRiskOrderCount ? A.red : A.orange} />
        <ActionableMetricCard label="缺口数量" value={qty(activeSummary.shortageQty)} description="查看影响交付承诺的订单" to="/app/sales/orders?risk=blocked" icon={PackageSearch} color={A.red} />
        <ActionableMetricCard label="已预留数量" value={qty(activeSummary.reservedQty)} description="查看库存分配证据" to="/app/sales/orders?status=unshipped" icon={Boxes} color={A.green} />
      </div>

      <OrderDetailModal
        order={detailOpen ? selectedOrder : null}
        allocation={selectedOrder ? availabilityBySku.get(selectedOrder.sku) : undefined}
        allocationWarning={allocationWarning}
        onClose={() => setDetailOpen(false)}
        onNavigate={onNavigate}
        onOpenAi={onOpenAi}
      />

      {ordersError && <Card className="p-4 text-sm" style={{ color: A.red }}>{ordersError}</Card>}
      {loadingOrders && <Card className="p-6 text-sm" style={{ color: A.sub }}>正在读取客户订单...</Card>}
      {!loadingOrders && !ordersError && orders.length === 0 && (
        <Card className="p-6 text-sm" style={{ color: A.sub }}>
          当前工作区暂无客户订单记录。后续可通过订单导入或业务数据接入生成客户订单视图。
        </Card>
      )}

      {!loadingOrders && !ordersError && orders.length > 0 && view === "orders" && (
        <div className="space-y-3">
          <Card>
            <div className="px-5 py-4 flex items-center justify-between" style={{ borderBottom: `1px solid ${A.border}` }}>
              <SectionHeader title="客户订单列表" />
              <span className="text-[11px]" style={{ color: A.sub }}>{visibleOrders.length} 条</span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[980px] text-xs">
                <thead>
                  <tr style={{ borderBottom: `1px solid ${A.border}` }}>
                    {["客户订单号", "客户", "SKU / 物料", "订单数量", "已预留", "缺口", "承诺日期", "风险等级", "状态", "操作"].map((header) => (
                      <th key={header} className="px-3 py-3 text-left font-semibold" style={{ color: A.gray1 }}>{header}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {visibleOrders.map((order, index) => (
                    <tr key={order.salesOrderId} data-testid={`sales-order-${order.salesOrderId}`} style={{ borderBottom: index < visibleOrders.length - 1 ? `1px solid ${A.border}` : "none", background: selectedOrder?.salesOrderId === order.salesOrderId ? "#f0f6ff" : A.white }}>
                      <td className="px-3 py-3 tabular-nums" style={{ color: A.blue }}><EntityLink kind="sales_order" id={order.salesOrderId}>{order.salesOrderId}</EntityLink></td>
                      <td className="px-3 py-3" style={{ color: A.label }}>{order.customerName}</td>
                      <td className="px-3 py-3">
                        <div className="tabular-nums" style={{ color: A.label }}><EntityLink kind="item" id={order.sku}>{order.sku}</EntityLink></div>
                        <div className="fc-caption truncate max-w-[180px]" style={{ color: A.sub }}>{order.itemName}</div>
                      </td>
                      <td className="px-3 py-3 tabular-nums" style={{ color: A.label }}>{qty(order.orderedQty)}</td>
                      <td className="px-3 py-3 tabular-nums" style={{ color: A.green }}>{qty(order.reservedQty)}</td>
                      <td className="px-3 py-3 tabular-nums font-semibold" style={{ color: order.shortageQty > 0 ? A.red : A.gray2 }}>{qty(order.shortageQty)}</td>
                      <td className="px-3 py-3" style={{ color: A.sub }}>{order.promisedDate || "待确认"}</td>
                      <td className="px-3 py-3"><Chip label={order.deliveryRiskLabel} color={riskColor[order.deliveryRiskLevel] || A.gray1} bg={`${riskColor[order.deliveryRiskLevel] || A.gray1}16`} /></td>
                      <td className="px-3 py-3" style={{ color: A.sub }}>{order.statusLabel}</td>
                      <td className="px-3 py-3">
                        <Link to={`/app/sales/orders/${encodeURIComponent(order.salesOrderId)}`} className="px-2.5 py-1.5 rounded-md font-medium" style={{ background: A.gray6, color: A.blue }}>查看详情</Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </div>
      )}

      {!loadingOrders && !ordersError && orders.length > 0 && view === "risks" && (
        <Card>
          <div className="px-5 py-4 flex items-center justify-between" style={{ borderBottom: `1px solid ${A.border}` }}>
            <SectionHeader title="交付风险队列" />
            <span className="text-[11px]" style={{ color: A.sub }}>仅显示中高风险和阻断订单</span>
          </div>
          <div className="divide-y" style={{ borderColor: A.border }}>
            {riskOrders.map((order) => (
              <div key={order.salesOrderId} className="p-4">
                <div className="grid grid-cols-[120px_1fr_180px_120px] gap-3 items-start">
                  <Chip label={order.deliveryRiskLabel} color={riskColor[order.deliveryRiskLevel] || A.gray1} bg={`${riskColor[order.deliveryRiskLevel] || A.gray1}16`} />
                  <div className="min-w-0">
                    <div className="font-semibold text-sm tabular-nums" style={{ color: A.label }}><EntityLink kind="sales_order" id={order.salesOrderId}>{order.salesOrderId}</EntityLink> · {order.customerName}</div>
                    <div className="mt-1 text-xs truncate" style={{ color: A.sub }}><EntityLink kind="item" id={order.sku}>{order.sku}</EntityLink> / {order.itemName} · 缺口 {qty(order.shortageQty)} · 承诺日期 {order.promisedDate || "待确认"}</div>
                    <div className="mt-1 text-[11px] leading-5 line-clamp-2" style={{ color: A.gray1 }}>{order.deliveryRiskReason}</div>
                    <div className="mt-1 text-[11px] leading-5" style={{ color: A.gray1 }}>
                      事实依据：订购 {qty(order.orderedQty)} · 已预留 {qty(order.reservedQty)} · 已履约 {qty(order.fulfilledQty)} · 未覆盖 {qty(order.shortageQty)}
                    </div>
                    {order.dataLimitations.length > 0 && (
                      <div className="mt-1 text-[11px] leading-5" style={{ color: A.orange }}>
                        数据限制：{order.dataLimitations.map(limitationLabel).join("；")}
                      </div>
                    )}
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {[
                        ["订单", "sales"],
                        ["库存", "inventory"],
                        ["采购", "procurement:orders"],
                        ["证据链", "sales:evidence"],
                      ].map(([label, target]) => (
                        <button key={label} onClick={() => { if (target === "sales:evidence") setSelectedOrderId(order.salesOrderId); onNavigate?.(target); }}
                          className="rounded-full px-2 py-0.5 fc-caption font-semibold"
                          style={{ background: A.gray6, color: A.blue }}>
                          {label}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="text-[11px] leading-5" style={{ color: A.orange }}>
                    建议动作：人工复核库存分配及交付条件。当前没有权威采购在途或供应商承诺关联，不能据此判断补货到达时间。
                  </div>
                  <div className="flex justify-end">
                    <Link to={`/app/sales/orders/${encodeURIComponent(order.salesOrderId)}`} className="px-3 py-1.5 rounded-md font-medium" style={{ background: "#f0f6ff", color: A.blue }}>查看详情</Link>
                  </div>
                </div>
              </div>
            ))}
            {riskOrders.length === 0 && (
              <div className="p-6 text-sm" style={{ color: A.sub }}>当前没有需要进入风险队列的客户订单。</div>
            )}
          </div>
        </Card>
      )}

      {!loadingOrders && !ordersError && orders.length > 0 && view === "evidence" && (
        <EvidenceChainView orders={evidenceOrders} allOrders={orders} selectedOrderId={selectedOrder?.salesOrderId || ""} onSelectOrder={setSelectedOrderId} onNavigate={onNavigate} />
      )}
    </div>
  );
}

function OrderDetailModal({
  order,
  allocation,
  allocationWarning,
  onClose,
  onNavigate,
  onOpenAi,
}: {
  order: SalesOrder | null;
  allocation?: InventoryAvailability;
  allocationWarning: string;
  onClose: () => void;
  onNavigate?: EvidenceNavigate;
  onOpenAi?: () => void;
}) {
  if (!order) return null;
  const allocationRiskColor = allocation?.riskLevel === "low" ? A.green : allocation?.riskLevel === "medium" ? A.orange : A.red;
  return (
    <BusinessObjectDetailModal
      open={Boolean(order)}
      onClose={onClose}
      title={`${order.salesOrderId} · ${order.customerName}`}
      subtitle={`${order.sku} / ${order.itemName}`}
      width={1120}
    >
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <Chip label={order.statusLabel} color={A.blue} bg="#f0f6ff" />
          <Chip label={order.deliveryRiskLabel} color={riskColor[order.deliveryRiskLevel] || A.gray1} bg={`${riskColor[order.deliveryRiskLevel] || A.gray1}16`} />
          <span className="text-xs" style={{ color: A.sub }}>承诺日期 {order.promisedDate || "待确认"}</span>
        </div>

        <CompactKpiStrip items={[
          { label: "订单数量", value: qty(order.orderedQty) },
          { label: "已预留", value: qty(order.reservedQty), tone: "good" },
          { label: "缺口", value: qty(order.shortageQty), tone: order.shortageQty > 0 ? "danger" : "default" },
          { label: "优先级", value: order.priority, tone: order.priority === "高" ? "warning" : "default" },
        ]} />

        <DetailSection title="基本信息">
          <DetailFieldGrid fields={[
            { label: "客户", value: order.customerName },
            { label: "客户层级", value: order.customerTier },
            { label: "SKU", value: order.sku },
            { label: "物料", value: order.itemName },
            { label: "状态", value: order.statusLabel },
            { label: "风险原因", value: order.deliveryRiskReason, tone: "warning" },
            { label: "关联供应商", value: order.linkedSuppliers.map((supplier) => supplier.name).join("；") || "待关联" },
            { label: "异常工单", value: order.linkedExceptionCases.join("；") || "暂无" },
          ]} />
        </DetailSection>

        <DetailSection title="库存影响" right={<Chip label={allocation?.riskLabel || "需人工复核"} color={allocationRiskColor} bg={allocation?.riskLevel === "low" ? "#f0faf4" : allocation?.riskLevel === "medium" ? "#fff8f0" : "#fff1f0"} />}>
          <div className="mb-2 text-[11px] font-semibold" style={{ color: A.gray1 }}>库存分配摘要</div>
          {allocation ? (
            <DetailFieldGrid fields={[
              { label: "可承诺量", value: qty(allocation.availableToPromiseQty), tone: "info" },
              { label: "可预留", value: qty(allocation.reservableQty), tone: "good" },
              { label: "在途采购", value: qty(allocation.incomingPurchaseQty), tone: "info" },
              { label: "预计可用", value: qty(allocation.projectedAvailableQty), tone: allocation.projectedAvailableQty < order.orderedQty ? "warning" : "good" },
            ]} />
          ) : (
            <div className="text-xs leading-6" style={{ color: A.orange }}>
              {allocationWarning || "当前工作区暂未读取到完整库存分配记录，因此可承诺量和预留建议需人工复核。"}
            </div>
          )}
        </DetailSection>

        <EvidenceSummaryPanel groups={[
          { label: "客户订单", value: `${order.salesOrderId} · ${order.customerName} · ${order.statusLabel}` },
          { label: "SKU库存", value: `${order.sku} · 已预留 ${qty(order.reservedQty)} · 缺口 ${qty(order.shortageQty)}`, tone: order.shortageQty > 0 ? "danger" : "good" },
          { label: "采购订单", value: order.linkedPurchaseOrders.map((po) => `${po.id} ${po.status || ""} ${po.expectedDate || ""}`).join("；") || "暂无完整采购订单关联" },
          { label: "供应商", value: order.linkedSuppliers.map((supplier) => `${supplier.name}${supplier.risk ? ` · ${supplier.risk}` : ""}`).join("；") || "暂无完整供应商记录" },
          { label: "收货单", value: order.linkedReceivingDocs.map((grn) => `${grn.id} ${grn.status || ""}`).join("；") || "暂无完整收货记录" },
          { label: "发票财务", value: "按当前采购、收货与供应商记录人工追溯" },
          { label: "异常工单", value: order.linkedExceptionCases.join("；") || "暂无关联异常工单" },
        ]} />

        <DataLimitationsPanel items={order.dataLimitations} labelFor={limitationLabel} />

        <DetailSection title="AI 辅助与跳转">
          <div className="flex flex-wrap gap-2">
            <button onClick={() => onNavigate?.("sales:evidence")} className="text-xs px-3 py-2 rounded-lg font-medium" style={{ background: "#f0f6ff", color: A.blue }}>进入证据链</button>
            <button onClick={() => onNavigate?.("sales:risks")} className="text-xs px-3 py-2 rounded-lg font-medium" style={{ background: "#fff8f0", color: A.orange }}>查看交付风险</button>
            <button onClick={onOpenAi} className="text-xs px-3 py-2 rounded-lg font-medium" style={{ background: A.white, color: A.blue }}>解释风险信号</button>
            <button className="text-xs px-3 py-2 rounded-lg font-medium" style={{ background: A.white, color: A.green }}>生成内部通知草稿预览</button>
          </div>
        </DetailSection>

        <ReviewActionPanel objectLabel={`客户订单 ${order.salesOrderId}`} />

        <DetailSection title="审计与时间线">
          <div className="grid grid-cols-3 gap-2 text-[11px] leading-5" style={{ color: A.sub }}>
            <div className="rounded-lg p-2" style={{ background: A.white }}>订单读取：已进入当前工作区视图</div>
            <div className="rounded-lg p-2" style={{ background: A.white }}>库存复核：根据可承诺量和在途采购判断</div>
            <div className="rounded-lg p-2" style={{ background: A.white }}>后续动作：负责人确认后进入业务流程</div>
          </div>
        </DetailSection>
      </div>
    </BusinessObjectDetailModal>
  );
}

function EvidenceChainView({
  orders,
  allOrders,
  selectedOrderId,
  onSelectOrder,
  onNavigate,
}: {
  orders: SalesOrder[];
  allOrders: SalesOrder[];
  selectedOrderId: string;
  onSelectOrder: (orderId: string) => void;
  onNavigate?: EvidenceNavigate;
}) {
  const hasSelectedOrder = Boolean(selectedOrderId);
  const selectedOrder = orders[0] || allOrders.find((order) => order.salesOrderId === selectedOrderId) || null;
  const [graph, setGraph] = useState<EvidenceGraphResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!selectedOrderId) {
      setGraph(null);
      setError("");
      return;
    }
    let alive = true;
    setLoading(true);
    setError("");
    apiJson<EvidenceGraphResponse>(`/api/evidence-graph/sales-order/${encodeURIComponent(selectedOrderId)}`)
      .then((payload) => {
        if (!alive) return;
        setGraph(payload);
      })
      .catch(() => {
        if (!alive) return;
        setGraph(null);
        setError("当前暂未读取到完整证据链，请返回客户订单列表或切换业务对象后重试。");
      })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [selectedOrderId]);

  const returnContext = selectedOrder ? {
    sourceModule: "sales",
    sourceRoute: "sales:evidence",
    sourceEntityType: "sales_order",
    sourceEntityId: selectedOrder.salesOrderId,
    sourceLabel: `客户订单 ${selectedOrder.salesOrderId}`,
    returnLabel: `返回客户订单 ${selectedOrder.salesOrderId}`,
    originIntent: "evidenceGraph",
  } : null;

  function retry() {
    if (!selectedOrderId) return;
    setGraph(null);
    setError("");
    setLoading(true);
    apiJson<EvidenceGraphResponse>(`/api/evidence-graph/sales-order/${encodeURIComponent(selectedOrderId)}`)
      .then(setGraph)
      .catch(() => setError("当前暂未读取到完整证据链，请返回客户订单列表或切换业务对象后重试。"))
      .finally(() => setLoading(false));
  }

  const fallbackSummary = selectedOrder ? (
    <Card className="p-4">
      <SectionHeader title="工作区关联摘要" right={<Chip label="需人工复核" color={A.orange} bg="#fff8f0" />} />
      <div className="grid grid-cols-1 gap-1.5 text-[11px] leading-5">
        <div className="flex items-center gap-1.5" style={{ color: A.gray1 }}><ClipboardList size={12} /> 客户订单：{selectedOrder.customerName} · {selectedOrder.statusLabel}</div>
        <div className="flex items-center gap-1.5" style={{ color: A.gray1 }}><PackageSearch size={12} /> SKU库存：{selectedOrder.sku} / {selectedOrder.itemName} · 已预留 {qty(selectedOrder.reservedQty)} · 缺口 {qty(selectedOrder.shortageQty)}</div>
        <div className="flex items-center gap-1.5" style={{ color: A.gray1 }}><ShoppingCart size={12} /> 采购订单：{selectedOrder.linkedPurchaseOrders.map((po) => `${po.id} ${po.status || ""}`).join("；") || "暂无完整采购订单关联"}</div>
        <div className="flex items-center gap-1.5" style={{ color: A.gray1 }}><Users size={12} /> 供应商：{selectedOrder.linkedSuppliers.map((supplier) => `${supplier.name}${supplier.risk ? ` · ${supplier.risk}` : ""}`).join("；") || "暂无完整供应商记录"}</div>
        <div className="flex items-center gap-1.5" style={{ color: A.gray1 }}><Truck size={12} /> 收货单：{selectedOrder.linkedReceivingDocs.map((grn) => `${grn.id} ${grn.status || ""}`).join("；") || "暂无完整收货记录"}</div>
        <div className="flex items-center gap-1.5" style={{ color: A.gray1 }}><FileText size={12} /> 发票财务：按当前采购和收货记录人工追溯</div>
        <div className="flex items-center gap-1.5" style={{ color: A.gray1 }}><AlertTriangle size={12} /> 异常工单：{selectedOrder.linkedExceptionCases.join("；") || "暂无关联异常工单"}</div>
      </div>
      <p className="mt-3 text-[11px] leading-5" style={{ color: A.sub }}>当前仅显示工作区内可追溯的关联摘要，需人工复核。</p>
    </Card>
  ) : null;

  return (
    <div className="space-y-4">
      <Card className="p-5">
        <SectionHeader title="主证据链" right={<Chip label="只读证据" color={A.blue} bg="#f0f6ff" />} />
        {!hasSelectedOrder && (
          <div className="mb-4 rounded-xl p-3" style={{ background: A.gray6 }}>
            <div className="text-xs font-semibold" style={{ color: A.label }}>选择客户订单</div>
            <div className="mt-2 grid grid-cols-1 gap-2">
              {allOrders.slice(0, 6).map((order) => (
                <button
                  key={order.salesOrderId}
                  type="button"
                  onClick={() => onSelectOrder(order.salesOrderId)}
                  className="rounded-lg px-3 py-2 text-left text-[11px]"
                  style={{ background: A.white, color: A.label }}
                >
                  <span className="font-semibold tabular-nums">{order.salesOrderId}</span>
                  <span style={{ color: A.sub }}> · {order.customerName} · {order.deliveryRiskLabel}</span>
                </button>
              ))}
            </div>
          </div>
        )}
        <div className="mt-4 grid grid-cols-1 gap-2 md:grid-cols-6">
          {[
            ["客户订单", ClipboardList],
            ["SKU", PackageSearch],
            ["库存可用量", Boxes],
            ["采购订单", ShoppingCart],
            ["供应商", Users],
            ["收货单", Truck],
          ].map(([label, Icon], index) => {
            const NextIcon = Icon as typeof ClipboardList;
            return (
              <div key={label as string} className="flex items-center gap-2">
                <div className="w-8 h-8 rounded-lg flex items-center justify-center" style={{ background: A.gray6, color: A.blue }}>
                  <NextIcon size={14} />
                </div>
                <div className="flex-1 rounded-lg px-3 py-2 text-xs font-semibold" style={{ background: A.white, color: A.label, boxShadow: `0 0 0 0.5px ${A.border}` }}>{label as string}</div>
                {index < 5 && <GitBranch size={14} style={{ color: A.gray2 }} />}
              </div>
            );
          })}
        </div>
        <p className="mt-4 text-[11px] leading-5" style={{ color: A.sub }}>
          客户订单 → SKU → 库存可用量 → 采购订单 → 供应商 → 收货单。展示跨单据的关联证据、相关记录和返回路径。
        </p>
      </Card>

      {hasSelectedOrder ? (
        <>
          <EvidenceGraphPanel
            graph={graph}
            loading={loading}
            error={error}
            onNavigate={onNavigate}
            onRetry={retry}
            onBack={() => onNavigate?.("sales")}
            onReturnList={() => onNavigate?.("sales")}
            onReturnSource={() => onNavigate?.("sales", { entityType: "sales_order", entityId: selectedOrderId }, { returnTo: "sales:evidence", entityLabel: `客户订单 ${selectedOrderId}`, returnContext })}
            sourceLabel={selectedOrder ? `客户订单 ${selectedOrder.salesOrderId}` : ""}
            returnContext={returnContext}
            returnTo="sales:evidence"
          />
          {error && fallbackSummary}
        </>
      ) : (
        <Card className="p-5 text-sm leading-6" style={{ color: A.sub }}>
          请选择一条客户订单读取证据链。页面会展示主证据链、相关记录、风险信号、数据限制和返回路径。
        </Card>
      )}
    </div>
  );
}
