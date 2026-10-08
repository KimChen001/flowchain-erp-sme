import { workspaceCopy } from "../../i18n/workspaceCopy";
import { useI18n } from "../../i18n/I18n";
import { salesDemandEnglish } from "./salesDemandCopy";
import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, Boxes, ClipboardList, FileText, PackageSearch, ShoppingCart, Truck, Users } from "lucide-react";
import { ApiError, apiJson } from "../../lib/api-client";
import { A, Card, Chip, SectionHeader } from "../../components/ui";
import EvidenceGraphPanel, { type EvidenceGraphResponse, type EvidenceNavigate } from "../../components/evidence/EvidenceGraphPanel";
import SalesReturnPage from "./SalesReturnPage";
import { BusinessDocumentForm } from "../../components/business/BusinessDocumentForm";
import { Link, useLocation, useSearchParams } from "react-router";
import { ActionableMetricCard } from "../../components/cards/ActionableMetricCard";
import { EntityLink } from "../../components/business/EntityLink";
import {
  tableMinMdClass,
  tableBaseClass,
  tableScrollClass,
  tdActionClass,
  tdIdClass,
  tdNameClass,
  tdNowrapClass,
  tdNumericClass,
  thClass,
} from "../../components/ui/workbenchTable";
import OutboundWorkbench from "./OutboundWorkbench";

const RESTRICTED_GRAPH = "evidence.restricted";

type SalesOrder = {
  salesOrderId: string;
  customerName: string;
  customerTier: string;
  itemId: string;
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
  lines?: Array<{ sku?: string; itemName?: string }>;
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

// Display copy in the interface language: the page's own map first, then the
// workspace dictionary. Server labels (status, risk, tier) are translated here,
// when shown; the values the server sends are never changed. New copy is
// written in English with its Chinese translation through say().
function useSalesCopy() {
  const { language } = useI18n();
  return useMemo(() => {
    const english = language === "en-US";
    const copy = (label: string) => (english ? salesDemandEnglish[label] || workspaceCopy(label, language) : workspaceCopy(label, language));
    const say = (englishText: string, chineseText: string) => (english ? englishText : chineseText);
    // The read API names a customer without a recorded name "未命名客户";
    // recorded names are shown as stored.
    const customerLabel = (order: SalesOrder) => (order.customerName === "未命名客户" ? copy("未命名客户") : order.customerName);
    // An order with several lines is named after its first item; the read API
    // writes that name in Chinese, so the English one is built from the lines.
    const itemLabel = (order: SalesOrder) => {
      const lines = order.lines || [];
      if (!english || lines.length < 2) return order.itemName;
      return `${lines[0].itemName?.trim() || lines[0].sku?.trim() || order.sku} and ${lines.length - 1} more`;
    };
    return { copy, say, customerLabel, itemLabel };
  }, [language]);
}

// Quantities follow the workspace number locale.
function useQty() {
  const { formatNumber } = useI18n();
  return (value: number) => formatNumber(Number(value || 0));
}

function viewFromInitial(initialView?: string): SalesView {
  if (initialView === "evidence") return "evidence";
  if (initialView === "risks") return "risks";
  return "orders";
}

export default function SalesDemandPage(props: SalesDemandPageProps) {
  const location = useLocation();
  if (location.pathname === "/app/sales/orders" || location.pathname === "/app/sales/orders/new" || /^\/app\/sales\/orders\/[^/]+$/.test(location.pathname) || /^\/app\/sales\/shipments\/[^/]+$/.test(location.pathname)) return <OutboundWorkbench />;
  if (props.initialView === "returns-new") return <BusinessDocumentForm documentLabel="Sales return" listPath="/app/sales/returns" />;
  if (props.initialView === "returns") return <SalesReturnPage />;
  return <SalesDemandCore {...props} />;
}

function SalesDemandCore({ initialView, focus, onNavigate }: SalesDemandPageProps) {
  const { copy, customerLabel, itemLabel } = useSalesCopy();
  const qty = useQty();
  const [searchParams, setSearchParams] = useSearchParams();
  const view = viewFromInitial(initialView);
  const [orders, setOrders] = useState<SalesOrder[]>([]);
  const [summary, setSummary] = useState<SalesSummary | null>(null);
  const [loadingOrders, setLoadingOrders] = useState(true);
  const [ordersError, setOrdersError] = useState("");
  const [selectedOrderId, setSelectedOrderId] = useState(() => searchParams.get("orderId") || "");

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
    if (view !== "evidence" || focus?.entityId) return;
    const orderId = searchParams.get("orderId") || "";
    if (orderId !== selectedOrderId) setSelectedOrderId(orderId);
  }, [focus?.entityId, searchParams, selectedOrderId, view]);

  function selectEvidenceOrder(orderId: string) {
    setSelectedOrderId(orderId);
    const next = new URLSearchParams(searchParams);
    if (orderId) next.set("orderId", orderId);
    else next.delete("orderId");
    setSearchParams(next, { replace: true });
  }

  useEffect(() => {
    if (!focus?.entityId) return;
    if (focus.entityType === "sales_order" || focus.entityType === "customer_order") {
      setSelectedOrderId(focus.entityId);
      return;
    }
    if (focus.entityType === "inventory_item" || focus.entityType === "item" || focus.entityType === "sku") {
      const related = orders.find((order) => order.sku === focus.entityId);
      if (related) setSelectedOrderId(related.salesOrderId);
    }
  }, [focus?.entityId, focus?.entityType, orders]);

  const focusedOrder = useMemo(() => {
    if (!focus?.entityId) return null;
    return orders.find((order) => order.salesOrderId === focus.entityId) || null;
  }, [focus, orders]);
  const selectedOrder = useMemo(() => {
    return orders.find((order) => order.salesOrderId === selectedOrderId) || focusedOrder || null;
  }, [focusedOrder, orders, selectedOrderId]);
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
      {view === "risks" && <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <ActionableMetricCard label={copy("客户订单")} value={String(activeSummary.totalOrders)} description={copy("查看当前工作区全部订单")} to="/app/sales/orders" icon={ClipboardList} color={A.blue} />
        <ActionableMetricCard label={copy("交付风险")} value={String(activeSummary.riskOrderCount)} description={`${activeSummary.highRiskOrderCount} ${copy("个高风险订单")}`} to="/app/sales/orders?risk=true" icon={AlertTriangle} color={activeSummary.highRiskOrderCount ? A.red : A.orange} />
        <ActionableMetricCard label={copy("缺口数量")} value={qty(activeSummary.shortageQty)} description={copy("查看影响交付承诺的订单")} to="/app/sales/orders?risk=blocked" icon={PackageSearch} color={A.red} />
        <ActionableMetricCard label={copy("已预留数量")} value={qty(activeSummary.reservedQty)} description={copy("查看库存分配证据")} to="/app/sales/orders?status=unshipped" icon={Boxes} color={A.green} />
      </div>}

      {ordersError && <Card className="p-4 text-sm" style={{ color: A.red }}>{copy(ordersError)}</Card>}
      {loadingOrders && <Card className="p-6 text-sm" style={{ color: A.sub }}>{copy("正在读取客户订单...")}</Card>}
      {!loadingOrders && !ordersError && orders.length === 0 && (
        <Card className="p-6 text-sm" style={{ color: A.sub }}>{copy("当前工作区暂无客户订单记录。后续可通过订单导入或业务数据接入生成客户订单视图。")}</Card>
      )}

      {!loadingOrders && !ordersError && orders.length > 0 && view === "orders" && (
        <div className="space-y-3">
          <Card>
            <div className="px-5 py-4 flex items-center justify-between" style={{ borderBottom: `1px solid ${A.border}` }}>
              <SectionHeader title={copy("客户订单列表")} />
              <span className="text-[11px]" style={{ color: A.sub }}>{visibleOrders.length} {copy("条")}</span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[980px] text-xs">
                <thead>
                  <tr style={{ borderBottom: `1px solid ${A.border}` }}>
                    {[copy("客户订单号"), copy("客户"), copy("SKU / 物料"), copy("订单数量"), copy("已预留"), copy("缺口"), copy("承诺日期"), copy("风险等级"), copy("状态"), copy("操作")].map((header) => (
                      <th key={header} className="px-3 py-3 text-left font-semibold" style={{ color: A.gray1 }}>{header}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {visibleOrders.map((order, index) => (
                    <tr key={order.salesOrderId} data-testid={`sales-order-${order.salesOrderId}`} style={{ borderBottom: index < visibleOrders.length - 1 ? `1px solid ${A.border}` : "none", background: selectedOrder?.salesOrderId === order.salesOrderId ? "#f0f6ff" : A.white }}>
                      <td className="px-3 py-3 tabular-nums" style={{ color: A.blue }}><EntityLink kind="sales_order" id={order.salesOrderId}>{order.salesOrderId}</EntityLink></td>
                      <td className="px-3 py-3" style={{ color: A.label }}>{customerLabel(order)}</td>
                      <td className="px-3 py-3">
                        <div className="tabular-nums" style={{ color: A.label }}><EntityLink kind="item" id={order.itemId}>{order.sku}</EntityLink></div>
                        <div className="fc-caption truncate max-w-[180px]" style={{ color: A.sub }}>{itemLabel(order)}</div>
                      </td>
                      <td className="px-3 py-3 tabular-nums" style={{ color: A.label }}>{qty(order.orderedQty)}</td>
                      <td className="px-3 py-3 tabular-nums" style={{ color: A.green }}>{qty(order.reservedQty)}</td>
                      <td className="px-3 py-3 tabular-nums font-semibold" style={{ color: order.shortageQty > 0 ? A.red : A.gray2 }}>{qty(order.shortageQty)}</td>
                      <td className="px-3 py-3" style={{ color: A.sub }}>{order.promisedDate || copy("待确认")}</td>
                      <td className="px-3 py-3"><Chip label={copy(order.deliveryRiskLabel)} color={riskColor[order.deliveryRiskLevel] || A.gray1} bg={`${riskColor[order.deliveryRiskLevel] || A.gray1}16`} /></td>
                      <td className="px-3 py-3" style={{ color: A.sub }}>{copy(order.statusLabel)}</td>
                      <td className="px-3 py-3">
                        <Link to={`/app/sales/orders/${encodeURIComponent(order.salesOrderId)}`} className="px-2.5 py-1.5 rounded-md font-medium" style={{ background: A.gray6, color: A.blue }}>{copy("查看详情")}</Link>
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
            <div>
              <SectionHeader title={copy("交付风险查询")} />
              <p className="mt-1 text-xs" style={{ color: A.sub }}>{copy("逐行查看订单缺口、承诺日期、风险原因和可核验履约事实。")}</p>
            </div>
            <span className="text-xs" style={{ color: A.sub }}>{riskOrders.length} {copy("条风险订单")}</span>
          </div>
          <div className={tableScrollClass}>
            <table className={tableMinMdClass}>
              <thead>
                <tr style={{ borderBottom: `1px solid ${A.border}` }}>
                  {[copy("销售订单"), copy("客户"), copy("SKU / 物料"), copy("订购"), copy("已预留"), copy("已履约"), copy("缺口"), copy("承诺日期"), copy("风险"), copy("风险原因"), copy("操作")].map((header) => (
                    <th key={header} className={thClass}>{header}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {riskOrders.map((order) => (
                  <tr key={order.salesOrderId} style={{ borderBottom: `1px solid ${A.border}` }}>
                    <td className={tdIdClass}><EntityLink kind="sales_order" id={order.salesOrderId}>{order.salesOrderId}</EntityLink></td>
                    <td className={tdNameClass}>{customerLabel(order)}</td>
                    <td className={tdNameClass}>
                      <EntityLink kind="item" id={order.itemId}>{order.sku}</EntityLink>
                      <div className="max-w-[180px] truncate text-xs" style={{ color: A.sub }}>{itemLabel(order)}</div>
                    </td>
                    <td className={tdNumericClass}>{qty(order.orderedQty)}</td>
                    <td className={tdNumericClass}>{qty(order.reservedQty)}</td>
                    <td className={tdNumericClass}>{qty(order.fulfilledQty)}</td>
                    <td className={`${tdNumericClass} font-semibold`} style={{ color: order.shortageQty > 0 ? A.red : A.gray2 }}>{qty(order.shortageQty)}</td>
                    <td className={tdNowrapClass}>{order.promisedDate || copy("待确认")}</td>
                    <td className={tdNowrapClass}><Chip label={copy(order.deliveryRiskLabel)} color={riskColor[order.deliveryRiskLevel] || A.gray1} bg={`${riskColor[order.deliveryRiskLevel] || A.gray1}16`} /></td>
                    <td className="max-w-[320px] px-4 py-3">
                      <div className="line-clamp-2 text-xs" style={{ color: A.gray1 }}>{copy(order.deliveryRiskReason)}</div>
                      {order.dataLimitations.length > 0 && (
                        <div className="mt-1 line-clamp-2 text-[11px]" style={{ color: A.orange }}>{copy("数据限制：")}{order.dataLimitations.map(code => copy(limitationLabel(code))).join("; ")}</div>
                      )}
                    </td>
                    <td className={tdActionClass}>
                      <div className="flex gap-2">
                        <Link to={`/app/sales/orders/${encodeURIComponent(order.salesOrderId)}`} className="rounded-md bg-blue-50 px-3 py-1.5 font-medium text-blue-700">{copy("查看订单")}</Link>
                        <Link to={`/app/sales/evidence?orderId=${encodeURIComponent(order.salesOrderId)}`} className="rounded-md bg-slate-100 px-3 py-1.5 font-medium text-slate-700">{copy("查看证据")}</Link>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {riskOrders.length === 0 && (
              <div className="p-6 text-sm" style={{ color: A.sub }}>{copy("当前没有需要进入风险队列的销售订单。")}</div>
            )}
          </div>
        </Card>
      )}

      {!loadingOrders && !ordersError && orders.length > 0 && view === "evidence" && (
        <EvidenceChainView allOrders={orders} selectedOrderId={selectedOrderId} onSelectOrder={selectEvidenceOrder} onNavigate={onNavigate} />
      )}
    </div>
  );
}

function EvidenceChainView({
  allOrders,
  selectedOrderId,
  onSelectOrder,
  onNavigate,
}: {
  allOrders: SalesOrder[];
  selectedOrderId: string;
  onSelectOrder: (orderId: string) => void;
  onNavigate?: EvidenceNavigate;
}) {
  const { copy, say, customerLabel, itemLabel } = useSalesCopy();
  const qty = useQty();
  const hasSelectedOrder = Boolean(selectedOrderId);
  const selectedOrder = allOrders.find((order) => order.salesOrderId === selectedOrderId) || null;
  const [graph, setGraph] = useState<EvidenceGraphResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const { t } = useI18n();
  // A 403 means the reader's role cannot open this record's evidence chain;
  // it is translated when shown so a language change applies to it.
  const graphError = (reason: unknown) => reason instanceof ApiError && reason.status === 403
    ? RESTRICTED_GRAPH
    : "当前暂未读取到完整证据链，请返回客户订单列表或切换业务对象后重试。";

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
      .catch((reason) => {
        if (!alive) return;
        setGraph(null);
        setError(graphError(reason));
      })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [selectedOrderId]);

  const returnContext = selectedOrder ? {
    sourceModule: "sales",
    sourceRoute: "sales:evidence",
    sourceEntityType: "sales_order",
    sourceEntityId: selectedOrder.salesOrderId,
    sourceLabel: say(`Sales order ${selectedOrder.salesOrderId}`, `客户订单 ${selectedOrder.salesOrderId}`),
    returnLabel: say(`Back to sales order ${selectedOrder.salesOrderId}`, `返回客户订单 ${selectedOrder.salesOrderId}`),
    originIntent: "evidenceGraph",
  } : null;

  function retry() {
    if (!selectedOrderId) return;
    setGraph(null);
    setError("");
    setLoading(true);
    apiJson<EvidenceGraphResponse>(`/api/evidence-graph/sales-order/${encodeURIComponent(selectedOrderId)}`)
      .then(setGraph)
      .catch((reason) => setError(graphError(reason)))
      .finally(() => setLoading(false));
  }

  const fallbackSummary = selectedOrder ? (
    <Card className="p-4">
      <SectionHeader title={copy("工作区关联摘要")} right={<Chip label={copy("需人工复核")} color={A.orange} bg="#fff8f0" />} />
      <div className="grid grid-cols-1 gap-1.5 text-[11px] leading-5">
        <div className="flex items-center gap-1.5" style={{ color: A.gray1 }}><ClipboardList size={12} />{copy("客户订单：")}{customerLabel(selectedOrder)} · {copy(selectedOrder.statusLabel)}</div>
        <div className="flex items-center gap-1.5" style={{ color: A.gray1 }}><PackageSearch size={12} />{copy("SKU库存：")}{selectedOrder.sku} / {itemLabel(selectedOrder)}{copy("· 已预留")}{qty(selectedOrder.reservedQty)}{copy("· 缺口")}{qty(selectedOrder.shortageQty)}</div>
        <div className="flex items-center gap-1.5" style={{ color: A.gray1 }}><ShoppingCart size={12} />{copy("采购订单：")}{selectedOrder.linkedPurchaseOrders.map((po) => `${po.id} ${po.status || ""}`).join("; ") || copy("暂无完整采购订单关联")}</div>
        <div className="flex items-center gap-1.5" style={{ color: A.gray1 }}><Users size={12} />{copy("供应商：")}{selectedOrder.linkedSuppliers.map((supplier) => `${supplier.name}${supplier.risk ? ` · ${supplier.risk}` : ""}`).join("; ") || copy("暂无完整供应商记录")}</div>
        <div className="flex items-center gap-1.5" style={{ color: A.gray1 }}><Truck size={12} />{copy("收货单：")}{selectedOrder.linkedReceivingDocs.map((grn) => `${grn.id} ${grn.status || ""}`).join("; ") || copy("暂无完整收货记录")}</div>
        <div className="flex items-center gap-1.5" style={{ color: A.gray1 }}><FileText size={12} />{copy("发票财务：按当前采购和收货记录人工追溯")}</div>
        <div className="flex items-center gap-1.5" style={{ color: A.gray1 }}><AlertTriangle size={12} />{copy("异常工单：")}{selectedOrder.linkedExceptionCases.join("; ") || copy("暂无关联异常工单")}</div>
      </div>
      <p className="mt-3 text-[11px] leading-5" style={{ color: A.sub }}>{copy("当前仅显示工作区内可追溯的关联摘要，需人工复核。")}</p>
    </Card>
  ) : null;

  return (
    <div className="space-y-4">
      <Card>
        <div className="flex items-center justify-between px-5 py-4" style={{ borderBottom: `1px solid ${A.border}` }}>
          <div>
            <SectionHeader title={copy("订单证据查询")} />
            <p className="mt-1 text-xs" style={{ color: A.sub }}>{copy("选择销售订单后读取其真实关联记录、风险信号和数据限制。")}</p>
          </div>
          <Chip label={copy("只读证据")} color={A.blue} bg="#f0f6ff" />
        </div>
        <div className={tableScrollClass}>
          <table className={tableBaseClass}>
            <thead>
              <tr style={{ borderBottom: `1px solid ${A.border}` }}>
                {[copy("销售订单"), copy("客户"), copy("SKU / 物料"), copy("状态"), copy("交付风险"), copy("缺口"), copy("操作")].map((header) => (
                  <th key={header} className={thClass}>{header}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {allOrders.map((order) => (
                <tr key={order.salesOrderId} style={{ borderBottom: `1px solid ${A.border}`, background: selectedOrderId === order.salesOrderId ? "#f0f6ff" : A.white }}>
                  <td className={tdIdClass}><EntityLink kind="sales_order" id={order.salesOrderId}>{order.salesOrderId}</EntityLink></td>
                  <td className={tdNameClass}>{customerLabel(order)}</td>
                  <td className={tdNameClass}>
                    <EntityLink kind="item" id={order.itemId}>{order.sku}</EntityLink>
                    <div className="max-w-[200px] truncate text-xs" style={{ color: A.sub }}>{itemLabel(order)}</div>
                  </td>
                  <td className={tdNowrapClass}>{copy(order.statusLabel)}</td>
                  <td className={tdNowrapClass}><Chip label={copy(order.deliveryRiskLabel)} color={riskColor[order.deliveryRiskLevel] || A.gray1} bg={`${riskColor[order.deliveryRiskLevel] || A.gray1}16`} /></td>
                  <td className={tdNumericClass}>{qty(order.shortageQty)}</td>
                  <td className={tdActionClass}>
                    <button
                      type="button"
                      onClick={() => onSelectOrder(order.salesOrderId)}
                      disabled={selectedOrderId === order.salesOrderId}
                      className="rounded-md bg-blue-50 px-3 py-1.5 font-medium text-blue-700 hover:bg-blue-100 disabled:cursor-default disabled:bg-slate-100 disabled:text-slate-500"
                    >
                      {copy(selectedOrderId === order.salesOrderId ? "已选择" : "查看证据")}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      {hasSelectedOrder ? (
        <>
          <EvidenceGraphPanel
            graph={graph}
            loading={loading}
            error={error === RESTRICTED_GRAPH ? t("evidence.restricted") : copy(error)}
            onNavigate={onNavigate}
            onRetry={retry}
            onBack={() => onNavigate?.("sales")}
            onReturnList={() => onNavigate?.("sales")}
            onReturnSource={() => onNavigate?.("sales", { entityType: "sales_order", entityId: selectedOrderId }, { returnTo: "sales:evidence", entityLabel: say(`Sales order ${selectedOrderId}`, `客户订单 ${selectedOrderId}`), returnContext })}
            sourceLabel={selectedOrder ? say(`Sales order ${selectedOrder.salesOrderId}`, `客户订单 ${selectedOrder.salesOrderId}`) : ""}
            returnContext={returnContext}
            returnTo="sales:evidence"
            showReturnPath={false}
            showNavigationHints={false}
          />
          {error && fallbackSummary}
        </>
      ) : (
        <Card className="p-5 text-sm leading-6" style={{ color: A.sub }}>{copy("请选择一条销售订单读取证据。页面只展示当前工作区能够核验的关联记录、风险信号和数据限制。")}</Card>
      )}
    </div>
  );
}
