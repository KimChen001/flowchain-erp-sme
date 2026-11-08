import { workspaceCopy } from "../../i18n/workspaceCopy";
import { useI18n } from "../../i18n/I18n";
import { salesDemandEnglish } from "./salesDemandCopy";
import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Boxes, ClipboardList, FileText, PackageSearch, ShoppingCart, Truck, Users } from "lucide-react";
import { ApiError, apiJson } from "../../lib/api-client";
import { DocumentNumber } from "../../lib/documentNumbers";
import { formatCalendarDay } from "../../lib/format";
import { A, Card, Chip, Field, SectionHeader, inputStyle } from "../../components/ui";
import EvidenceGraphPanel, { type EvidenceGraphResponse, type EvidenceNavigate } from "../../components/evidence/EvidenceGraphPanel";
import SalesReturnPage from "./SalesReturnPage";
import { BusinessDocumentForm } from "../../components/business/BusinessDocumentForm";
import { Link, useLocation, useSearchParams } from "react-router";
import { ActionableMetricCard } from "../../components/cards/ActionableMetricCard";
import { EntityLink } from "../../components/business/EntityLink";
import { ListCard, ListSearchCard, ListStateRow, ResetButton, StatusChip, listButtonClass, listTableCardsRef, listHeadRowStyle, listRowClass, listRowStyle, rowActionClass, statusToneOf, type StatusTone } from "../../components/ui/listLayout";
import {
  tableBodyTextClass,
  tableLinkClass,
  tdNumericRightClass,
  thRightClass,
  tableScrollClass,
  tdIdClass,
  tdNameClass,
  tdNowrapClass,
  thClass,
} from "../../components/ui/workbenchTable";
import OutboundWorkbench from "./OutboundWorkbench";

const RESTRICTED_GRAPH = "evidence.restricted";
const LOAD_ERROR = "当前未读取到销售订单记录，请检查工作区数据或刷新后重试。";

type SalesOrder = {
  salesOrderId: string;
  // The order's document number (SO-YYYYMM-NNNN), shown in place of its id.
  orderNumber?: string;
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
  // number: the order's document number (shown in place of its id).
  linkedPurchaseOrders: Array<{ id: string; number?: string; supplierName?: string; status?: string; expectedDate?: string }>;
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

// Brand tones for the risk levels; order status labels use statusToneOf.
const RISK_TONE: Record<string, StatusTone> = { blocked: "danger", high: "danger", medium: "warning", low: "neutral" };
const EVIDENCE_PAGE_SIZE = 15;
const RISK_PAGE_SIZE = 25;

// The statuses the read API gives an order (statusLabel), by the code the
// list filter sends (orderStatus); the label is translated where it is shown.
const ORDER_STATUS_LABELS: Record<string, string> = {
  "shortage_risk": "缺货风险",
  "ready_to_ship": "可发货",
  "partially_fulfilled": "部分履约",
  "fulfilled": "已完成",
  "cancelled": "已取消",
  "draft": "草稿",
  "confirmed": "已确认",
  "on_hold": "已暂停",
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

// An order is named by its document number; its stored id is never shown.
const orderNumberOf = (order: Pick<SalesOrder, "orderNumber" | "salesOrderId">) => order.orderNumber || order.salesOrderId;

// Quantities follow the workspace number locale.
function useQty() {
  const { formatNumber } = useI18n();
  return (value: number) => formatNumber(Number(value || 0));
}

// One page of the orders the filters select, read from the server: `total`
// counts every matching order in the workspace, not only the page.
function useOrderPage(filters: Record<string, string>, page: number, pageSize: number, enabled: boolean) {
  const query = useMemo(() => {
    const params = new URLSearchParams();
    for (const [name, value] of Object.entries(filters)) if (value) params.set(name, value);
    params.set("offset", String((page - 1) * pageSize));
    params.set("limit", String(pageSize));
    return params.toString();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(filters), page, pageSize]);
  const [state, setState] = useState<{ orders: SalesOrder[]; total: number; loading: boolean; error: string }>({ orders: [], total: 0, loading: true, error: "" });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    setState((current) => ({ ...current, loading: true, error: "" }));
    apiJson<{ orders?: SalesOrder[]; total?: number }>(`/api/sales-demand/orders?${query}`)
      .then((payload) => {
        if (!alive) return;
        // A server without paging returns its whole list and no total; the
        // page is then cut from that list.
        const rows = payload.orders || [];
        const offset = (page - 1) * pageSize;
        const orders = rows.length > pageSize ? rows.slice(offset, offset + pageSize) : rows;
        setState({ orders, total: typeof payload.total === "number" ? payload.total : rows.length, loading: false, error: "" });
      })
      .catch(() => { if (alive) setState({ orders: [], total: 0, loading: false, error: LOAD_ERROR }); });
    return () => { alive = false; };
  }, [query, enabled, attempt, pageSize]);
  return { ...state, pages: Math.max(1, Math.ceil(state.total / pageSize)), retry: () => setAttempt((value) => value + 1) };
}

// A typed value, once typing pauses, so a search reads the server once.
function useSettled(value: string, delay = 300) {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return settled;
}

// The pager under a list read a page at a time, as the sales order list has.
function PageFooter({ page, pages, total, onPage }: { page: number; pages: number; total: number; onPage: (page: number) => void }) {
  const { copy, say } = useSalesCopy();
  const { formatNumber } = useI18n();
  if (total <= 0) return null;
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 px-5 py-3 text-xs" style={{ borderTop: "0.5px solid rgba(0,0,0,0.06)", color: A.sub }} data-testid="sales-demand-pager">
      <span>{say(`Page ${page} of ${pages} · ${formatNumber(total)} results`, `第 ${page} / ${pages} 页 · 共 ${formatNumber(total)} 条`)}</span>
      {pages > 1 && (
        <div className="flex gap-2">
          <button type="button" className={listButtonClass.secondary} disabled={page <= 1} onClick={() => onPage(page - 1)}>{copy("上一页")}</button>
          <button type="button" className={listButtonClass.secondary} disabled={page >= pages} onClick={() => onPage(page + 1)}>{copy("下一页")}</button>
        </div>
      )}
    </div>
  );
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
  // The order list is the sales order workbench list, read a page at a time.
  if (viewFromInitial(props.initialView) === "orders") return <OutboundWorkbench />;
  return <SalesDemandCore {...props} />;
}

function SalesDemandCore({ initialView, focus, onNavigate }: SalesDemandPageProps) {
  const view = viewFromInitial(initialView);
  const [searchParams, setSearchParams] = useSearchParams();
  const [selectedOrderId, setSelectedOrderId] = useState(() => searchParams.get("orderId") || "");

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

  // A sales order in focus is chosen; an item in focus chooses the latest
  // order for it.
  useEffect(() => {
    if (!focus?.entityId) return;
    if (focus.entityType === "sales_order" || focus.entityType === "customer_order") {
      setSelectedOrderId(focus.entityId);
      return;
    }
    if (focus.entityType === "inventory_item" || focus.entityType === "item" || focus.entityType === "sku") {
      let alive = true;
      apiJson<{ orders?: SalesOrder[] }>(`/api/sales-demand/orders?sku=${encodeURIComponent(focus.entityId)}&limit=1`)
        .then((payload) => { const related = payload.orders?.[0]; if (alive && related) setSelectedOrderId(related.salesOrderId); })
        .catch(() => {});
      return () => { alive = false; };
    }
  }, [focus?.entityId, focus?.entityType]);

  if (view === "evidence") return <EvidenceChainView selectedOrderId={selectedOrderId} onSelectOrder={selectEvidenceOrder} onNavigate={onNavigate} />;
  return <RiskView />;
}

// Delivery risk: the workspace's figures, each opening the order list
// filtered to the orders it counts, and the orders at risk a page at a time.
function RiskView() {
  const { copy, say, customerLabel, itemLabel } = useSalesCopy();
  const { locale } = useI18n();
  // A promised date as the workspace shows dates ("Nov 8, 2026"), or "to be confirmed".
  const promised = (order: SalesOrder) => (order.promisedDate ? formatCalendarDay(order.promisedDate, locale) : copy("待确认"));
  const qty = useQty();
  const [summary, setSummary] = useState<SalesSummary | null>(null);
  const [page, setPage] = useState(1);
  const risks = useOrderPage({ risk: "true", sort: "risk" }, page, RISK_PAGE_SIZE, true);

  useEffect(() => {
    let alive = true;
    apiJson<{ summary?: SalesSummary }>("/api/sales-demand/summary")
      .then((payload) => { if (alive) setSummary(payload.summary || null); })
      .catch(() => { if (alive) setSummary(null); });
    return () => { alive = false; };
  }, []);

  const figure = (value: number | undefined, format: (value: number) => string = String) => (summary && typeof value === "number" ? format(value) : "—");
  const highRisk = summary?.highRiskOrderCount ?? 0;
  const empty = !risks.loading && !risks.error && risks.total === 0;

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <ActionableMetricCard label={say("Customer order", "销售订单")} value={figure(summary?.totalOrders)} description={copy("查看当前工作区全部订单")} to="/app/sales/orders" icon={ClipboardList} color={A.blue} />
        <ActionableMetricCard label={copy("交付风险")} value={figure(summary?.riskOrderCount)} description={say(`${highRisk} high-risk ${highRisk === 1 ? "order" : "orders"}`, `${highRisk} 个高风险订单`)} to="/app/sales/orders?risk=true" icon={AlertTriangle} color={highRisk ? A.red : A.orange} />
        <ActionableMetricCard label={copy("缺口数量")} value={figure(summary?.shortageQty, qty)} description={copy("查看影响交付承诺的订单")} to="/app/sales/orders?shortage=true" icon={PackageSearch} color={A.red} />
        <ActionableMetricCard label={copy("已预留数量")} value={figure(summary?.reservedQty, qty)} description={say("Orders with stock reserved", "查看已预留库存的订单")} to="/app/sales/orders?reserved=true" icon={Boxes} color={A.green} />
      </div>

      {risks.error && <Card className="p-4 text-sm" style={{ color: A.red }}>{copy(risks.error)}</Card>}

      {!risks.error && (
        <Card>
          <div className="flex flex-wrap items-center justify-between gap-2 px-5 py-4" style={{ borderBottom: `1px solid ${A.border}` }}>
            <div>
              <SectionHeader title={copy("交付风险查询")} />
              <p className="mt-1 text-xs" style={{ color: A.sub }}>{copy("逐行查看订单缺口、承诺交期、风险原因和可核验履约事实。")}</p>
            </div>
            <span className="text-xs" style={{ color: A.sub }}>{risks.loading ? copy("正在读取销售订单…") : say(`${risks.total} ${risks.total === 1 ? "order" : "orders"} at risk`, `${risks.total} 条风险订单`)}</span>
          </div>
          <div className={tableScrollClass} ref={listTableCardsRef}>
            <table className={`w-full min-w-[1080px] text-left ${tableBodyTextClass}`}>
              <thead>
                <tr style={{ borderBottom: `1px solid ${A.border}` }}>
                  <th className={`${thClass} sticky left-0 z-20 bg-white`} style={{ color: A.gray1 }}>{say("Sales order", "销售订单")}</th>
                  <th className={thClass} style={{ color: A.gray1 }}>{copy("SKU / 物料")}</th>
                  <th className={thRightClass} style={{ color: A.gray1 }}>{copy("订购 / 预留 / 履约")}</th>
                  <th className={thRightClass} style={{ color: A.gray1 }}>{copy("缺口")}</th>
                  {[copy("承诺交期"), copy("风险"), copy("风险原因")].map((header) => (
                    <th key={header} className={thClass} style={{ color: A.gray1 }}>{header}</th>
                  ))}
                  <th className={`${thClass} sticky right-0 z-20 bg-white`} style={{ color: A.gray1 }}>{copy("操作")}</th>
                </tr>
              </thead>
              <tbody>
                {risks.orders.map((order) => (
                  <tr key={order.salesOrderId} style={{ borderBottom: `1px solid ${A.border}` }}>
                    <td className={`${tdIdClass} sticky left-0 z-10 bg-white`}>
                      <EntityLink kind="sales_order" id={order.salesOrderId} className={tableLinkClass}>{orderNumberOf(order)}</EntityLink>
                      <div className="max-w-[200px] truncate text-[11px] font-normal" style={{ color: A.sub }}>{customerLabel(order)}</div>
                    </td>
                    <td className={tdNameClass}>
                      <EntityLink kind="item" id={order.itemId}>{order.sku}</EntityLink>
                      <div className="max-w-[180px] truncate text-xs" style={{ color: A.sub }}>{itemLabel(order)}</div>
                    </td>
                    <td className={tdNumericRightClass}>
                      <span className="font-semibold" style={{ color: A.label }}>{qty(order.orderedQty)}</span>
                      <span style={{ color: A.sub }}> / {qty(order.reservedQty)} / {qty(order.fulfilledQty)}</span>
                    </td>
                    <td className={`${tdNumericRightClass} font-semibold`} style={{ color: order.shortageQty > 0 ? A.red : A.gray2 }}>{qty(order.shortageQty)}</td>
                    <td className={tdNowrapClass}>{promised(order)}</td>
                    <td className={tdNowrapClass}><Chip label={copy(order.deliveryRiskLabel)} color={riskColor[order.deliveryRiskLevel] || A.gray1} bg={`${riskColor[order.deliveryRiskLevel] || A.gray1}16`} /></td>
                    <td className="min-w-[260px] max-w-[360px] whitespace-normal px-4 py-3 align-top" data-testid={`delivery-risk-reason-${order.salesOrderId}`}>
                      <div className="text-xs leading-5" style={{ color: A.gray1 }}>{copy(order.deliveryRiskReason)}</div>
                      {order.dataLimitations.length > 0 && (
                        <div className="mt-1 text-[11px] leading-4" style={{ color: A.orange }}>{copy("数据限制：")}{order.dataLimitations.map(code => copy(limitationLabel(code))).join(say("; ", "；"))}</div>
                      )}
                    </td>
                    <td className={`${tdNowrapClass} sticky right-0 z-10 bg-white`}>
                      <div className="flex flex-col items-start gap-1">
                        <Link to={`/app/sales/orders/${encodeURIComponent(order.salesOrderId)}`} className={rowActionClass.primary}>{copy("查看订单")}</Link>
                        <Link to={`/app/sales/evidence?orderId=${encodeURIComponent(order.salesOrderId)}`} className={rowActionClass.neutral}>{copy("查看证据")}</Link>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {empty && (
              <div className="p-6 text-sm" style={{ color: A.sub }}>{copy("当前没有需要进入风险队列的销售订单。")}</div>
            )}
          </div>
          <PageFooter page={Math.min(page, risks.pages)} pages={risks.pages} total={risks.total} onPage={setPage} />
        </Card>
      )}
    </div>
  );
}

function EvidenceChainView({
  selectedOrderId,
  onSelectOrder,
  onNavigate,
}: {
  selectedOrderId: string;
  onSelectOrder: (orderId: string) => void;
  onNavigate?: EvidenceNavigate;
}) {
  const { copy, say, customerLabel, itemLabel } = useSalesCopy();
  const qty = useQty();
  const hasSelectedOrder = Boolean(selectedOrderId);
  const [graph, setGraph] = useState<EvidenceGraphResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const [risk, setRisk] = useState("");
  const [status, setStatus] = useState("");
  const [page, setPage] = useState(1);
  const evidenceRef = useRef<HTMLDivElement>(null);
  // The list is searched, filtered and read a page at a time on the server,
  // so every order in the workspace can be reached, however many there are.
  const search = useSettled(query.trim());
  const list = useOrderPage({ q: search, risk, orderStatus: status }, page, EVIDENCE_PAGE_SIZE, true);
  const current = Math.min(page, list.pages);
  // The chosen order: from the page when it is there, else read by itself.
  const [chosenOrder, setChosenOrder] = useState<SalesOrder | null>(null);
  const selectedOrder = list.orders.find((order) => order.salesOrderId === selectedOrderId) || (chosenOrder?.salesOrderId === selectedOrderId ? chosenOrder : null);
  const selectedNumber = selectedOrder ? orderNumberOf(selectedOrder) : "";
  // A 403 means the reader's role cannot open this record's evidence chain;
  // it is translated when shown so a language change applies to it.
  const graphError = (reason: unknown) => reason instanceof ApiError && reason.status === 403
    ? RESTRICTED_GRAPH
    : "当前暂未读取到完整证据链，请返回销售订单列表或切换业务对象后重试。";

  useEffect(() => {
    if (!selectedOrderId || list.orders.some((order) => order.salesOrderId === selectedOrderId)) return;
    let alive = true;
    apiJson<{ order?: SalesOrder }>(`/api/sales-demand/orders/${encodeURIComponent(selectedOrderId)}`)
      .then((payload) => { if (alive) setChosenOrder(payload.order || null); })
      .catch(() => { if (alive) setChosenOrder(null); });
    return () => { alive = false; };
  }, [selectedOrderId, list.orders]);

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
    sourceLabel: say(`Sales order ${selectedNumber}`, `销售订单 ${selectedNumber}`),
    returnLabel: say(`Back to sales order ${selectedNumber}`, `返回销售订单 ${selectedNumber}`),
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
        <div className="flex items-center gap-1.5" style={{ color: A.gray1 }}><ClipboardList size={12} />{copy("销售订单：")}{customerLabel(selectedOrder)} · {copy(selectedOrder.statusLabel)}</div>
        <div className="flex items-center gap-1.5" style={{ color: A.gray1 }}><PackageSearch size={12} />{copy("SKU库存：")}{selectedOrder.sku} / {itemLabel(selectedOrder)}{copy("· 已预留")}{qty(selectedOrder.reservedQty)}{copy("· 缺口")}{qty(selectedOrder.shortageQty)}</div>
        <div className="flex items-center gap-1.5" style={{ color: A.gray1 }}><ShoppingCart size={12} />{copy("采购订单：")}{selectedOrder.linkedPurchaseOrders.length ? selectedOrder.linkedPurchaseOrders.map((po, index) => <span key={po.id}>{index ? "; " : ""}<DocumentNumber type="purchase_order" id={po.id} number={po.number} /> {po.status || ""}</span>) : copy("暂无完整采购订单关联")}</div>
        <div className="flex items-center gap-1.5" style={{ color: A.gray1 }}><Users size={12} />{copy("供应商：")}{selectedOrder.linkedSuppliers.map((supplier) => `${supplier.name}${supplier.risk ? ` · ${supplier.risk}` : ""}`).join("; ") || copy("暂无完整供应商记录")}</div>
        <div className="flex items-center gap-1.5" style={{ color: A.gray1 }}><Truck size={12} />{copy("收货单：")}{selectedOrder.linkedReceivingDocs.map((grn) => `${grn.id} ${grn.status || ""}`).join("; ") || copy("暂无完整收货记录")}</div>
        <div className="flex items-center gap-1.5" style={{ color: A.gray1 }}><FileText size={12} />{copy("发票财务：按当前采购和收货记录人工追溯")}</div>
        <div className="flex items-center gap-1.5" style={{ color: A.gray1 }}><AlertTriangle size={12} />{copy("异常工单：")}{selectedOrder.linkedExceptionCases.join("; ") || copy("暂无关联异常工单")}</div>
      </div>
      <p className="mt-3 text-[11px] leading-5" style={{ color: A.sub }}>{copy("当前仅显示工作区内可追溯的关联摘要，需人工复核。")}</p>
    </Card>
  ) : null;

  const reset = () => { setQuery(""); setRisk(""); setStatus(""); setPage(1); };
  const choose = (orderId: string) => {
    onSelectOrder(orderId);
    requestAnimationFrame(() => evidenceRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
  };
  // A new search starts again from the first page.
  useEffect(() => { setPage(1); }, [search]);

  return (
    <div className="space-y-5">
      {hasSelectedOrder && (
        <div ref={evidenceRef} className="scroll-mt-4 space-y-3">
          <div className="flex items-center justify-between gap-3">
            <div className="text-sm font-semibold" style={{ color: A.label }}>{selectedNumber ? say(`Evidence for sales order ${selectedNumber}`, `销售订单 ${selectedNumber} 的证据`) : say("Evidence for the sales order", "销售订单的证据")}</div>
            <button type="button" onClick={() => onSelectOrder("")} className={listButtonClass.secondary}>{say("Close", "关闭")}</button>
          </div>
          <EvidenceGraphPanel
            graph={graph}
            loading={loading}
            error={error === RESTRICTED_GRAPH ? t("evidence.restricted") : copy(error)}
            onNavigate={onNavigate}
            onRetry={retry}
            onBack={() => onNavigate?.("sales")}
            onReturnList={() => onNavigate?.("sales")}
            onReturnSource={() => onNavigate?.("sales", { entityType: "sales_order", entityId: selectedOrderId }, { returnTo: "sales:evidence", entityLabel: say(`Sales order ${selectedNumber}`, `销售订单 ${selectedNumber}`), returnContext })}
            sourceLabel={selectedOrder ? say(`Sales order ${selectedNumber}`, `销售订单 ${selectedNumber}`) : ""}
            returnContext={returnContext}
            returnTo="sales:evidence"
            showReturnPath={false}
            showNavigationHints={false}
          />
          {error && fallbackSummary}
        </div>
      )}

      <ListSearchCard
        title={copy("订单证据查询")}
        subtitle={copy("选择销售订单后读取其真实关联记录、风险信号和数据限制。")}
        actions={<>
          <StatusChip label={copy("只读证据")} tone="info" />
          <ResetButton onClick={reset} />
        </>}
      >
        <Field label={say("Search", "搜索")}>
          <input aria-label={say("Search sales orders", "搜索销售订单")} value={query} onChange={(event) => setQuery(event.target.value)} placeholder={say("Order, customer or SKU", "订单、客户或 SKU")} style={inputStyle} />
        </Field>
        <Field label={say("Shipment risk", "交付风险")}>
          <select aria-label={say("Shipment risk filter", "交付风险筛选")} value={risk} onChange={(event) => { setRisk(event.target.value); setPage(1); }} style={inputStyle}>
            <option value="">{say("All risk levels", "全部风险")}</option>
            <option value="blocked">{copy("已阻塞")}</option>
            <option value="high">{copy("高风险")}</option>
            <option value="low">{copy("正常")}</option>
          </select>
        </Field>
        <Field label={say("Status", "状态")}>
          <select aria-label={say("Status filter", "状态筛选")} value={status} onChange={(event) => { setStatus(event.target.value); setPage(1); }} style={inputStyle}>
            <option value="">{say("All statuses", "全部状态")}</option>
            {Object.entries(ORDER_STATUS_LABELS).map(([code, label]) => <option key={code} value={code}>{copy(label)}</option>)}
          </select>
        </Field>
      </ListSearchCard>

      <ListCard title={say("Sales orders", "销售订单")} total={list.loading ? undefined : list.total} shown={list.orders.length}>
        <div className={tableScrollClass}>
          <table className={`w-full min-w-[960px] text-left ${tableBodyTextClass}`}>
            <thead>
              <tr style={listHeadRowStyle}>
                <th className={thClass} style={{ color: A.gray1 }}>{copy("销售订单")}</th>
                <th className={thClass} style={{ color: A.gray1 }}>{copy("客户")}</th>
                <th className={thClass} style={{ color: A.gray1 }}>{copy("SKU / 物料")}</th>
                <th className={thClass} style={{ color: A.gray1 }}>{copy("状态")}</th>
                <th className={thClass} style={{ color: A.gray1 }}>{copy("交付风险")}</th>
                <th className={thRightClass} style={{ color: A.gray1 }}>{copy("缺口")}</th>
                <th className={thClass} style={{ color: A.gray1 }}>{copy("操作")}</th>
              </tr>
            </thead>
            <tbody>
              {list.loading && list.orders.length === 0 && <ListStateRow colSpan={7} state="loading" />}
              {list.error && <ListStateRow colSpan={7} state="error" title={copy(list.error)} onRetry={list.retry} />}
              {!list.loading && !list.error && list.orders.length === 0 && <ListStateRow colSpan={7} state="empty" title={search || risk || status ? say("No sales orders match these filters", "没有符合筛选条件的销售订单") : copy("当前工作区暂无销售订单记录。后续可通过订单导入或业务数据接入生成销售订单视图。")} />}
              {list.orders.map((order, index) => {
                const chosen = selectedOrderId === order.salesOrderId;
                return (
                  <tr key={order.salesOrderId} className={listRowClass} style={{ ...listRowStyle(index, list.orders.length), background: chosen ? "#f0f6ff" : undefined }}>
                    <td className={tdIdClass}><EntityLink kind="sales_order" id={order.salesOrderId} className={tableLinkClass}>{orderNumberOf(order)}</EntityLink></td>
                    <td className={`${tdNameClass} max-w-[200px] truncate`} title={customerLabel(order)}>{customerLabel(order)}</td>
                    <td className={tdNameClass}>
                      <EntityLink kind="item" id={order.itemId} className={tableLinkClass}>{order.sku}</EntityLink>
                      <div className="max-w-[220px] truncate text-[11px]" style={{ color: A.sub }} title={itemLabel(order)}>{itemLabel(order)}</div>
                    </td>
                    <td className={tdNowrapClass}><StatusChip label={copy(order.statusLabel)} tone={statusToneOf(order.statusLabel)} /></td>
                    <td className={tdNowrapClass}><StatusChip label={copy(order.deliveryRiskLabel)} tone={RISK_TONE[order.deliveryRiskLevel] || "neutral"} /></td>
                    <td className={`${tdNumericRightClass}${order.shortageQty > 0 ? " font-semibold text-red-700" : ""}`} style={order.shortageQty > 0 ? undefined : { color: A.gray2 }}>{qty(order.shortageQty)}</td>
                    <td className={tdNowrapClass}>
                      <button
                        type="button"
                        onClick={() => choose(order.salesOrderId)}
                        disabled={chosen}
                        className={`${rowActionClass.primary} disabled:cursor-default disabled:bg-slate-100 disabled:text-slate-500`}
                      >
                        {copy(chosen ? "已选择" : "查看证据")}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <PageFooter page={current} pages={list.pages} total={list.total} onPage={setPage} />
      </ListCard>
    </div>
  );
}
