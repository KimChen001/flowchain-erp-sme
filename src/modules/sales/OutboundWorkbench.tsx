import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router";
import {
  AlertTriangle,
  CheckCircle2,
  Loader2,
  RefreshCw,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { ApiError, apiJson } from "../../lib/api-client";
import { createSecureClientMutationId } from "../../lib/client-id";

type Order = {
  id: string;
  orderNumber: string;
  customerName: string;
  promisedDate?: string | null;
  currency: string;
  workflowStatus: string;
  reservationStatus: string;
  fulfillmentStatus: string;
  version: number;
  updatedAt: string;
  totalLines?: number;
  orderedQuantity?: string;
  reservedQuantity?: string;
  fulfilledQuantity?: string;
};
type Line = {
  id: string;
  itemId: string;
  sku: string;
  itemName: string;
  orderedQuantity: string;
  reservedQuantity: string;
  fulfilledQuantity: string;
  remainingToReserve: string | null;
  remainingToFulfill: string | null;
  unit: string;
  version: number;
};
type Balance = {
  id: string;
  warehouseId: string;
  location: string;
  locationKey: string;
  onHandQuantity: string;
  reservedQuantity: string;
  availableQuantity: string;
  actorScope: string;
  selectable: boolean;
};
type Reservation = {
  id: string;
  salesOrderLineId: string;
  warehouseId: string;
  location: string;
  reservedQuantity: string;
  allocatedQuantity: string;
  consumedQuantity: string;
  releasedQuantity: string;
  activeReservedQuantity: string;
  allocatableQuantity: string;
  status: string;
  version: number;
};
type Shipment = {
  id: string;
  shipmentNumber: string;
  workflowStatus: string;
  postingStatus: string;
  version: number;
  postedAt?: string | null;
  reversedAt?: string | null;
  reversalReason?: string | null;
};
type LifecycleCapability = {
  enabled: boolean;
  maturity?: string;
  databaseOnly?: boolean;
};
type SmartLink = {
  id: string;
  label: string;
  count?: number | null;
  targetRouteId: string;
  targetType: string;
  targetId: string | null;
  filter: Record<string, string>;
  enabled: boolean;
  unavailableReason?: string | null;
};
type Workbench = {
  dataSource: string;
  order: Order;
  lines: Line[];
  availability: Array<{
    salesOrderLineId: string;
    totalOnHand: string;
    totalReserved: string;
    totalAvailable: string;
    balances: Balance[];
  }>;
  reservations: Reservation[];
  shipments: Shipment[];
  movements: Array<{
    id: string;
    movementType: string;
    sku: string;
    itemName?: string | null;
    warehouseId?: string;
    quantityIn: string;
    quantityOut: string;
  }>;
  scopeCoverage: {
    status: "full" | "partial";
    hiddenWarehouseFacts: boolean;
    limitationCodes: string[];
  };
  capabilities: Record<string, { enabled?: boolean }>;
  availableActions: Record<string, boolean | string | string[] | null>;
  smartLinks: SmartLink[];
  evidence: Array<{
    eventType: string;
    title: string;
    summary: string;
    occurredAt: string;
    entityType: string;
    entityId: string;
    commandExecutionId?: string | null;
    idempotencyKey?: string | null;
  }>;
  reconciliation: {
    status: string;
    reasonCode?: string;
    checks: Array<{
      status: string;
      rule: string;
      calculated: string;
      recorded: string;
      affectedEntity: { type: string; id: string };
    }>;
  };
  aiExplain: {
    conclusion: string;
    businessImpact: string;
    suggestedAction: string;
    limitations: string[];
    uncertainty: string;
  };
};
type Preview = {
  operation: string;
  allowed: boolean;
  blockingIssues: Array<{ code: string; message: string }>;
  warnings: Array<{ code: string; message: string }>;
  balanceImpacts: Array<Record<string, string>>;
  reservationImpacts: Array<Record<string, string>>;
  salesOrderLineImpacts: Array<Record<string, string>>;
  shipmentImpacts: Array<Record<string, string>>;
  factsToCreate: Record<string, unknown>;
};
type ShipmentWorkbench = {
  dataSource: string;
  shipment: Shipment & {
    salesOrderId: string;
    postedBy?: { name: string } | null;
    reversedBy?: { name: string } | null;
  };
  salesOrder: Order;
  lines: Array<{
    id: string;
    sku: string;
    itemName: string;
    requestedQuantity: string;
    postedQuantity: string;
    unit: string;
  }>;
  allocations: Array<{
    id: string;
    reservationId: string;
    warehouseId: string;
    location: string;
    quantity: string;
    status: string;
    movementLink?: string | null;
    reversalMovementLink?: string | null;
  }>;
  availableActions: {
    canCancel: boolean;
    canPost: boolean;
    canReverse: boolean;
    blockingReasonCodes: string[];
  };
  evidence: Workbench["evidence"];
  reconciliation: Workbench["reconciliation"];
  aiExplain: Workbench["aiExplain"];
  movements: Workbench["movements"];
};

const key = () =>
  createSecureClientMutationId("outbound");
const pretty: Record<string, string> = {
  draft: "草稿",
  confirmed: "已确认",
  on_hold: "暂停",
  ready: "待过账",
  cancelled: "已取消",
  unposted: "未过账",
  posted: "已过账",
  reversed: "已冲销",
  not_reserved: "未预留",
  partially_reserved: "部分预留",
  fully_reserved: "已预留",
  not_fulfilled: "未履约",
  partially_fulfilled: "部分履约",
  fully_fulfilled: "已履约",
  matched: "一致",
  mismatch: "不一致",
  unavailable: "不可用",
};
const status = (value: string) => pretty[value] || value;
const stamp = (value?: string | null) =>
  value ? new Date(value).toLocaleString("zh-CN") : "—";
function message(error: unknown) {
  if (!(error instanceof ApiError)) return "请求失败，请刷新后重试。";
  const map: Record<string, string> = {
    PERMISSION_DENIED: "当前角色只能查看，不能执行此操作。",
    WAREHOUSE_SCOPE_DENIED: "当前账号没有相关仓库权限。",
    SALES_ORDER_ON_HOLD: "销售订单当前已暂停，不能执行发货过账。请先恢复订单。",
    OUTBOUND_CAPABILITY_NOT_AVAILABLE:
      "当前 Outbound Beta 功能未由管理员启用，页面为只读状态。",
    SALES_ORDER_VERSION_CONFLICT: "订单已发生变化，请刷新后重新预览。",
    SHIPMENT_VERSION_CONFLICT: "发货单已变化，请刷新后重新预览。",
    OUTBOUND_CONCURRENT_TRANSACTION_CONFLICT:
      "库存已发生变化，请刷新后重新预览。",
    IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD:
      "操作内容已改变，请重新开始该操作。",
    COMMAND_EXECUTION_IN_PROGRESS: "该操作正在处理中，请稍后重试。",
    RESERVATION_INSUFFICIENT_AVAILABLE: "可用库存不足，请调整数量。",
    SHIPMENT_REVERSAL_NOT_SAFE: "历史出库事实不一致，系统已阻止冲销。",
    SHIPMENT_NUMBER_CONFLICT: "发货单号已存在，请更换号码。",
    SALES_ORDER_NUMBER_CONFLICT: "销售订单号已存在，请更换号码。",
    SALES_ORDER_INVALID_STATE: "当前订单状态不允许此操作。",
    SALES_ORDER_ITEM_INVALID: "订单物料与当前工作区主数据不一致。",
  };
  return map[error.code || ""] || error.message;
}
const Section = ({
  title,
  children,
  id,
}: {
  title: string;
  children: React.ReactNode;
  id?: string;
}) => (
  <section
    id={id}
    className="scroll-mt-20 rounded-xl border bg-white p-4 shadow-sm"
  >
    <h2 className="mb-3 text-sm font-semibold text-slate-800">{title}</h2>
    {children}
  </section>
);
const Badge = ({ value }: { value: string }) => (
  <span className="rounded-full bg-slate-100 px-2 py-1 text-xs font-semibold text-slate-700">
    {status(value)}
  </span>
);
const Button = ({
  children,
  disabled,
  onClick,
  testId,
  tone = "primary",
}: {
  children: React.ReactNode;
  disabled?: boolean;
  onClick?: () => void;
  testId?: string;
  tone?: "primary" | "secondary" | "danger";
}) => (
  <button
    data-testid={testId}
    disabled={disabled}
    onClick={onClick}
    className={`${tone === "primary" ? "bg-blue-600 text-white" : tone === "danger" ? "bg-red-600 text-white" : "bg-slate-100 text-slate-800"} rounded-lg px-3 py-2 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-50`}
  >
    {children}
  </button>
);
function smartLinkPath(link: SmartLink) {
  const paths: Record<string, string> = {
    "sales:order-detail": `/app/sales/orders/${encodeURIComponent(link.targetId || "")}`,
    "sales:shipment-detail": `/app/sales/shipments/${encodeURIComponent(link.targetId || "")}`,
    "inventory:stock": "/app/inventory/stock",
    "inventory:movements": "/app/inventory/movements",
    "settings:audit": "/app/settings/audit",
  };
  const params = new URLSearchParams(link.filter),
    section = params.get("section");
  params.delete("section");
  const query = params.toString(),
    hash = section ? `#${encodeURIComponent(section)}` : "";
  return `${paths[link.targetRouteId] || "/app/sales/orders"}${query ? `?${query}` : ""}${hash}`;
}

export default function OutboundWorkbench() {
  const location = useLocation();
  const shipment = location.pathname.match(
    /^\/app\/sales\/shipments\/([^/]+)$/,
  );
  const order = location.pathname.match(/^\/app\/sales\/orders\/([^/]+)$/);
  if (location.pathname === "/app/sales/orders/new") return <OrderEntry />;
  if (shipment) return <ShipmentDetail id={decodeURIComponent(shipment[1])} />;
  if (order) return <OrderDetail id={decodeURIComponent(order[1])} />;
  return <OrderList />;
}

function OrderList() {
  const [params, setParams] = useSearchParams(),
    [data, setData] = useState<{
      orders: Order[];
      total: number;
      page: number;
      pageSize: number;
      dataSource: string;
      capabilities: { salesOrderLifecycle: LifecycleCapability };
    } | null>(null),
    [error, setError] = useState("");
  const value = (name: string, fallback = "") => params.get(name) || fallback;
  const page = Math.max(1, Number(value("page", "1")) || 1),
    pageSize = 20;
  const update = (changes: Record<string, string | number>) => {
    const next = new URLSearchParams(params);
    for (const [name, raw] of Object.entries(changes)) {
      const v = String(raw);
      if (!v || v === "all") next.delete(name);
      else next.set(name, v);
    }
    setParams(next);
  };
  const load = useCallback(async () => {
    setError("");
    try {
      const query = new URLSearchParams(params);
      query.set("page", String(page));
      query.set("pageSize", String(pageSize));
      query.set("sort", value("sort", "updatedAt"));
      query.set("direction", value("direction", "desc"));
      const result = await apiJson<{
        orders: Order[];
        total: number;
        page: number;
        pageSize: number;
        dataSource: string;
        capabilities: { salesOrderLifecycle: LifecycleCapability };
      }>(`/api/sales/orders?${query}`);
      const totalPages = Math.max(1, Math.ceil(result.total / result.pageSize));
      if (page > totalPages) {
        update({ page: totalPages });
        return;
      }
      setData(result);
    } catch (e) {
      setError(message(e));
    }
  }, [params.toString(), page]);
  useEffect(() => {
    void load();
  }, [load]);
  const totalPages = Math.max(1, Math.ceil((data?.total || 0) / pageSize));
  const select = "rounded-lg border px-3 py-2 text-sm";
  return (
    <div className="space-y-4" data-testid="outbound-order-list">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">销售履约工作台</h1>
          <p className="text-sm text-slate-500">
            Authoritative PostgreSQL · 正式销售订单与出库闭环
          </p>
        </div>
        {data?.capabilities.salesOrderLifecycle.enabled && (
          <Link
            to="/app/sales/orders/new"
            className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white"
          >
            新建销售订单
          </Link>
        )}
      </div>
      {data && !data.capabilities.salesOrderLifecycle.enabled && (
        <div role="status" className="rounded-lg bg-slate-100 p-3 text-slate-700">
          当前 Outbound Beta 功能未由管理员启用，销售订单工作台为只读状态。
        </div>
      )}
      {error && (
        <div role="alert" className="rounded-lg bg-red-50 p-3 text-red-700">
          {error}
        </div>
      )}
      <Section title="销售订单">
        <div className="mb-3 grid gap-2 md:grid-cols-3 xl:grid-cols-6">
          <label className="text-xs">
            搜索
            <input
              aria-label="搜索销售订单"
              value={value("search")}
              onChange={(e) => update({ search: e.target.value, page: 1 })}
              className={`${select} mt-1 w-full`}
              placeholder="订单号或客户"
            />
          </label>
          <Filter
            label="流程状态"
            value={value("workflowStatus")}
            onChange={(v) => update({ workflowStatus: v, page: 1 })}
            values={["draft", "confirmed", "on_hold"]}
          />
          <Filter
            label="预留状态"
            value={value("reservationStatus")}
            onChange={(v) => update({ reservationStatus: v, page: 1 })}
            values={["not_reserved", "partially_reserved", "fully_reserved"]}
          />
          <Filter
            label="履约状态"
            value={value("fulfillmentStatus")}
            onChange={(v) => update({ fulfillmentStatus: v, page: 1 })}
            values={["not_fulfilled", "partially_fulfilled", "fully_fulfilled"]}
          />
          <label className="text-xs">
            币种
            <select
              aria-label="币种筛选"
              className={`${select} mt-1 w-full`}
              value={value("currency")}
              onChange={(e) => update({ currency: e.target.value, page: 1 })}
            >
              <option value="">全部</option>
              {["CNY", "USD", "EUR"].map((x) => (
                <option key={x}>{x}</option>
              ))}
            </select>
          </label>
          <label className="text-xs">
            排序
            <select
              aria-label="订单排序"
              className={`${select} mt-1 w-full`}
              value={`${value("sort", "updatedAt")}:${value("direction", "desc")}`}
              onChange={(e) => {
                const [sort, direction] = e.target.value.split(":");
                update({ sort, direction, page: 1 });
              }}
            >
              <option value="updatedAt:desc">更新时间（新到旧）</option>
              <option value="updatedAt:asc">更新时间（旧到新）</option>
              <option value="promisedDate:asc">承诺日期（升序）</option>
              <option value="promisedDate:desc">承诺日期（降序）</option>
              <option value="orderNumber:asc">订单号（升序）</option>
              <option value="orderNumber:desc">订单号（降序）</option>
            </select>
          </label>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[920px] text-sm">
            <thead>
              <tr className="border-b text-left text-xs text-slate-500">
                {[
                  "订单号",
                  "客户",
                  "流程",
                  "预留",
                  "履约",
                  "币种",
                  "行数",
                  "订购 / 预留 / 履约",
                  "更新时间",
                  "操作",
                ].map((x) => (
                  <th className="p-2" key={x}>
                    {x}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data?.orders.map((row) => (
                <tr key={row.id} className="border-b">
                  <td className="p-2 font-semibold">{row.orderNumber}</td>
                  <td className="p-2">{row.customerName}</td>
                  <td className="p-2">
                    <Badge value={row.workflowStatus} />
                  </td>
                  <td className="p-2">
                    <Badge value={row.reservationStatus} />
                  </td>
                  <td className="p-2">
                    <Badge value={row.fulfillmentStatus} />
                  </td>
                  <td className="p-2">{row.currency}</td>
                  <td className="p-2">{row.totalLines}</td>
                  <td className="p-2 tabular-nums">
                    {row.orderedQuantity} / {row.reservedQuantity} /{" "}
                    {row.fulfilledQuantity}
                  </td>
                  <td className="p-2">{stamp(row.updatedAt)}</td>
                  <td className="p-2">
                    <Link
                      className="text-blue-600 underline"
                      to={`/app/sales/orders/${encodeURIComponent(row.id)}`}
                    >
                      打开
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {data && data.orders.length === 0 && (
            <div className="p-8 text-center text-sm text-slate-500">
              暂无符合当前筛选条件的正式销售订单。
              <button
                className="ml-2 text-blue-700 underline"
                onClick={() => setParams({})}
              >
                清除筛选
              </button>
            </div>
          )}
        </div>
        <div className="mt-3 flex items-center justify-between text-sm">
          <span>
            第 {data?.page || page} / {totalPages} 页 · 共 {data?.total || 0} 条
          </span>
          <div className="flex gap-2">
            <Button
              tone="secondary"
              disabled={page <= 1}
              onClick={() => update({ page: page - 1 })}
            >
              上一页
            </Button>
            <Button
              tone="secondary"
              disabled={page >= totalPages}
              onClick={() => update({ page: page + 1 })}
            >
              下一页
            </Button>
          </div>
        </div>
      </Section>
    </div>
  );
}

function Filter({
  label,
  value,
  onChange,
  values,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  values: string[];
}) {
  return (
    <label className="text-xs">
      {label}
      <select
        aria-label={label}
        className="mt-1 w-full rounded-lg border px-3 py-2 text-sm"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="">全部</option>
        {values.map((x) => (
          <option value={x} key={x}>
            {status(x)}
          </option>
        ))}
      </select>
    </label>
  );
}

function OrderEntry() {
  const nav = useNavigate(),
    [items, setItems] = useState<
      Array<{ id: string; sku: string; name: string; unit?: string }>
    >([]),
    [orderNumber, setOrderNumber] = useState(`SO-${Date.now()}`),
    [customerName, setCustomerName] = useState(""),
    [currency, setCurrency] = useState("CNY"),
    [itemId, setItemId] = useState(""),
    [quantity, setQuantity] = useState("1.0000"),
    [capability, setCapability] = useState<LifecycleCapability | null>(null),
    [saving, setSaving] = useState(false),
    [error, setError] = useState("");
  const intent = useRef({ fingerprint: "", idempotencyKey: "" }),
    inFlight = useRef(false);
  useEffect(() => {
    apiJson<{
      items: typeof items;
      capabilities: { salesOrderLifecycle: LifecycleCapability };
    }>("/api/sales/order-entry-data")
      .then((x) => {
        setCapability(x.capabilities.salesOrderLifecycle);
        setItems(x.items);
        setItemId(x.items[0]?.id || "");
      })
      .catch((e) => setError(message(e)));
  }, []);
  async function save() {
    if (inFlight.current) return;
    const fingerprint = JSON.stringify({
      orderNumber,
      customerName,
      currency,
      itemId,
      quantity,
    });
    if (intent.current.fingerprint !== fingerprint)
      intent.current = { fingerprint, idempotencyKey: key() };
    inFlight.current = true;
    setSaving(true);
    setError("");
    try {
      const result = await apiJson<{ order: Order }>("/api/sales/orders", {
        method: "POST",
        body: JSON.stringify({
          orderNumber,
          customerName,
          currency,
          idempotencyKey: intent.current.idempotencyKey,
          lines: [{ itemId, quantity }],
        }),
      });
      intent.current = { fingerprint: "", idempotencyKey: "" };
      nav(`/app/sales/orders/${encodeURIComponent(result.order.id)}`);
    } catch (e) {
      setError(message(e));
    } finally {
      inFlight.current = false;
      setSaving(false);
    }
  }
  if (!capability)
    return (
      <div className="p-10 text-center" data-testid="sales-order-entry-loading">
        {error || "正在读取销售订单能力…"}
      </div>
    );
  if (!capability.enabled)
    return (
      <div className="mx-auto max-w-3xl space-y-4" data-testid="sales-order-entry-readonly">
        <h1 className="text-xl font-semibold">新建销售订单</h1>
        <div role="status" className="rounded-lg bg-slate-100 p-4 text-slate-700">
          当前 Outbound Beta 功能未由管理员启用，销售订单工作台为只读状态。
        </div>
        <Link className="text-blue-700 underline" to="/app/sales/orders">
          返回销售订单列表
        </Link>
      </div>
    );
  return (
    <div
      className="mx-auto max-w-3xl space-y-4"
      data-testid="sales-order-entry"
    >
      <div>
        <h1 className="text-xl font-semibold">新建销售订单草稿</h1>
        <p className="text-sm text-slate-500">
          SKU、物料名称与单位由 PostgreSQL Item 主数据快照。
        </p>
      </div>
      {error && (
        <div role="alert" className="rounded-lg bg-red-50 p-3 text-red-700">
          {error}
        </div>
      )}
      <Section title="订单信息">
        <div className="grid gap-3 md:grid-cols-2">
          <label className="text-sm">
            订单号
            <input
              aria-label="订单号"
              className="mt-1 w-full rounded-lg border p-2"
              value={orderNumber}
              onChange={(e) => setOrderNumber(e.target.value)}
            />
          </label>
          <label className="text-sm">
            客户
            <input
              aria-label="客户"
              className="mt-1 w-full rounded-lg border p-2"
              value={customerName}
              onChange={(e) => setCustomerName(e.target.value)}
            />
          </label>
          <label className="text-sm">
            币种
            <input
              aria-label="币种"
              maxLength={3}
              className="mt-1 w-full rounded-lg border p-2 uppercase"
              value={currency}
              onChange={(e) => setCurrency(e.target.value.toUpperCase())}
            />
          </label>
          <label className="text-sm">
            物料
            <select
              aria-label="物料"
              className="mt-1 w-full rounded-lg border p-2"
              value={itemId}
              onChange={(e) => setItemId(e.target.value)}
            >
              {items.map((x) => (
                <option value={x.id} key={x.id}>
                  {x.sku} · {x.name}
                </option>
              ))}
            </select>
          </label>
          <label className="text-sm">
            数量
            <input
              aria-label="数量"
              className="mt-1 w-full rounded-lg border p-2"
              value={quantity}
              onChange={(e) => setQuantity(e.target.value)}
            />
          </label>
        </div>
        <div className="mt-4 flex gap-2">
          <Button
            testId="create-sales-order"
            disabled={saving || !itemId || !customerName}
            onClick={() => void save()}
          >
            {saving ? "保存中…" : "保存草稿"}
          </Button>
          <Link
            className="rounded-lg bg-slate-100 px-3 py-2 text-sm"
            to="/app/sales/orders"
          >
            取消
          </Link>
        </div>
      </Section>
    </div>
  );
}

function OrderDetail({ id }: { id: string }) {
  const [data, setData] = useState<Workbench | null>(null),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true),
    [preview, setPreview] = useState<Preview | null>(null),
    [intent, setIntent] = useState(""),
    [intentKey, setIntentKey] = useState(""),
    [selectedLineId, setSelectedLineId] = useState(""),
    [selectedBalanceId, setSelectedBalanceId] = useState(""),
    [selectedReservationId, setSelectedReservationId] = useState(""),
    [quantity, setQuantity] = useState("1.0000"),
    [reason, setReason] = useState("业务调整"),
    [shipmentNumber, setShipmentNumber] = useState(`SHIP-${Date.now()}`),
    [editCustomer, setEditCustomer] = useState(""),
    [editQuantity, setEditQuantity] = useState("1.0000"),
    [saving, setSaving] = useState(false);
  const lifecycleIntents = useRef<Record<string, string>>({}),
    inFlight = useRef(false);
  const refresh = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      setData(
        await apiJson(`/api/sales/orders/${encodeURIComponent(id)}/workbench`),
      );
    } catch (e) {
      setError(message(e));
    } finally {
      setLoading(false);
    }
  }, [id]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  const selectedLine = data?.lines.find((row) => row.id === selectedLineId),
    selectable = data?.availability
      .find((row) => row.salesOrderLineId === selectedLineId)
      ?.balances.find((row) => row.id === selectedBalanceId && row.selectable),
    releasable = data?.reservations.find(
      (row) =>
        row.id === selectedReservationId &&
        row.allocatableQuantity !== "0.0000",
    );
  function start(next: string) {
    setIntent(next);
    setIntentKey(key());
    setSelectedLineId("");
    setSelectedBalanceId("");
    setSelectedReservationId("");
    setPreview(null);
    setError("");
    if (next === "edit" && data) {
      setSelectedLineId(data.lines[0]?.id || "");
      setEditCustomer(data.order.customerName);
      setEditQuantity(data.lines[0]?.orderedQuantity || "1.0000");
    }
  }
  async function lifecycle(action: "confirm" | "hold" | "resume") {
    if (!data || inFlight.current) return;
    const fingerprint = `${action}:${data.order.version}`;
    lifecycleIntents.current[fingerprint] ||= key();
    inFlight.current = true;
    setSaving(true);
    try {
      await apiJson(`/api/sales/orders/${encodeURIComponent(id)}/${action}`, {
        method: "POST",
        body: JSON.stringify({
          expectedOrderVersion: data.order.version,
          idempotencyKey: lifecycleIntents.current[fingerprint],
        }),
      });
      delete lifecycleIntents.current[fingerprint];
      await refresh();
    } catch (e) {
      setError(message(e));
    } finally {
      inFlight.current = false;
      setSaving(false);
    }
  }
  async function reviseDraft() {
    if (!data || !selectedLine || inFlight.current) return;
    inFlight.current = true;
    setSaving(true);
    try {
      await apiJson(`/api/sales/orders/${encodeURIComponent(id)}`, {
        method: "PATCH",
        body: JSON.stringify({
          expectedOrderVersion: data.order.version,
          idempotencyKey: intentKey,
          revisionMode: "replace_all",
          expectedLineIds: data.lines.map((line) => line.id),
          header: {
            customerName: editCustomer,
            currency: data.order.currency,
            promisedDate: data.order.promisedDate,
          },
          lines: [{ itemId: selectedLine.itemId, quantity: editQuantity }],
        }),
      });
      setIntent("");
      await refresh();
    } catch (e) {
      setError(message(e));
    } finally {
      inFlight.current = false;
      setSaving(false);
    }
  }
  async function loadPreview() {
    if (!data) return;
    let path = "",
      body: unknown = {};
    if (intent === "reserve" && selectedLine && selectable) {
      path = `reservations/preview`;
      body = {
        allocations: [
          {
            salesOrderLineId: selectedLine.id,
            warehouseId: selectable.warehouseId,
            location: selectable.location,
            quantity,
          },
        ],
      };
    } else if (intent === "release" && releasable) {
      path = `reservations/release-preview`;
      body = {
        reason,
        releases: [
          {
            reservationId: releasable.id,
            quantity,
            expectedReservationVersion: releasable.version,
          },
        ],
      };
    } else if (
      intent === "shipment" &&
      selectedLine &&
      releasable &&
      releasable.salesOrderLineId === selectedLine.id
    ) {
      path = `shipments/preview`;
      body = {
        shipmentNumber,
        lines: [
          {
            salesOrderLineId: selectedLine.id,
            allocations: [{ reservationId: releasable.id, quantity }],
          },
        ],
      };
    } else return;
    try {
      setPreview(
        await apiJson(`/api/sales/orders/${encodeURIComponent(id)}/${path}`, {
          method: "POST",
          body: JSON.stringify(body),
        }),
      );
    } catch (e) {
      setError(message(e));
    }
  }
  async function execute() {
    if (!data || !preview || inFlight.current) return;
    inFlight.current = true;
    setSaving(true);
    try {
      let path = "",
        body: Record<string, unknown> = {
          idempotencyKey: intentKey,
          expectedOrderVersion: data.order.version,
        };
      if (intent === "reserve" && selectedLine && selectable) {
        path = "reservations/reserve";
        body.allocations = [
          {
            salesOrderLineId: selectedLine.id,
            warehouseId: selectable.warehouseId,
            location: selectable.location,
            quantity,
          },
        ];
      } else if (intent === "release" && releasable) {
        path = "reservations/release";
        body.reason = reason;
        body.releases = [
          {
            reservationId: releasable.id,
            quantity,
            expectedReservationVersion: releasable.version,
          },
        ];
      } else if (intent === "shipment" && selectedLine && releasable) {
        path = "shipments";
        body.shipmentNumber = shipmentNumber;
        body.lines = [
          {
            salesOrderLineId: selectedLine.id,
            allocations: [{ reservationId: releasable.id, quantity }],
          },
        ];
      } else return;
      await apiJson(`/api/sales/orders/${encodeURIComponent(id)}/${path}`, {
        method: "POST",
        body: JSON.stringify(body),
      });
      setIntent("");
      setPreview(null);
      await refresh();
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        setPreview(null);
        await refresh();
      }
      setError(message(e));
    } finally {
      inFlight.current = false;
      setSaving(false);
    }
  }
  if (loading)
    return (
      <div className="p-10 text-center">
        <Loader2 className="mx-auto animate-spin" />
        正在读取正式订单…
      </div>
    );
  if (!data)
    return (
      <div role="alert" className="rounded-lg bg-red-50 p-5 text-red-700">
        {error}
      </div>
    );
  const a = data.availableActions;
  const lineOptions = data.lines,
    reservationOptions = data.reservations.filter(
      (row) =>
        (!selectedLineId || row.salesOrderLineId === selectedLineId) &&
        row.allocatableQuantity !== "0.0000",
    ),
    balanceOptions =
      data.availability.find((row) => row.salesOrderLineId === selectedLineId)
        ?.balances || [];
  return (
    <div className="space-y-4" data-testid="outbound-order-workbench">
      {error && (
        <div role="alert" className="rounded-lg bg-red-50 p-3 text-red-700">
          {error}
        </div>
      )}
      {data.scopeCoverage.status === "partial" && (
        <div
          role="status"
          className="rounded-lg bg-amber-50 p-3 text-amber-800"
        >
          当前页面仅显示您有权查看的仓库数据，部分库存或履约事实已隐藏。
        </div>
      )}
      {(a.blockingReasonCodes as string[] | undefined)?.includes(
        "MULTI_LINE_DRAFT_EDITOR_NOT_AVAILABLE",
      ) && (
        <div role="status" className="rounded-lg bg-amber-50 p-3 text-amber-800">
          当前订单包含多条订单行。为避免不完整覆盖，窄版界面暂不支持编辑该草稿。
        </div>
      )}
      {((a.blockingReasonCodes as string[]) || []).includes(
        "OUTBOUND_CAPABILITY_NOT_AVAILABLE",
      ) && (
        <div
          role="status"
          className="rounded-lg bg-slate-100 p-3 text-slate-700"
        >
          当前 Outbound Beta 功能未由管理员启用，页面为只读状态。
        </div>
      )}
      <section className="rounded-xl border bg-white p-5">
        <div className="flex flex-wrap justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold">{data.order.orderNumber}</h1>
            <p className="mt-1 text-sm text-slate-500">
              {data.order.customerName} · {data.order.currency} · v
              {data.order.version} · {stamp(data.order.updatedAt)}
            </p>
            <div className="mt-2 flex gap-2">
              <Badge value={data.order.workflowStatus} />
              <Badge value={data.order.reservationStatus} />
              <Badge value={data.order.fulfillmentStatus} />
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            {a.canEditDraft && (
              <Button
                tone="secondary"
                disabled={saving}
                onClick={() => start("edit")}
              >
                编辑草稿
              </Button>
            )}
            {a.canConfirm && (
              <Button
                disabled={saving}
                testId="confirm-sales-order"
                onClick={() => void lifecycle("confirm")}
              >
                确认订单
              </Button>
            )}
            {a.canHold && (
              <Button
                tone="secondary"
                disabled={saving}
                onClick={() => void lifecycle("hold")}
              >
                暂停
              </Button>
            )}
            {a.canResume && (
              <Button
                disabled={saving}
                onClick={() => void lifecycle("resume")}
              >
                恢复
              </Button>
            )}
            {a.canReserve && (
              <Button testId="open-reserve" onClick={() => start("reserve")}>
                预留库存
              </Button>
            )}
            {a.canRelease && (
              <Button tone="secondary" onClick={() => start("release")}>
                释放预留
              </Button>
            )}
            {a.canCreateShipment && (
              <Button
                testId="open-shipment-draft"
                onClick={() => start("shipment")}
              >
                创建发货草稿
              </Button>
            )}
            <Button tone="secondary" onClick={() => void refresh()}>
              <RefreshCw size={15} />
            </Button>
          </div>
        </div>
      </section>
      <Section title="Smart Links">
        <div className="flex flex-wrap gap-2">
          {data.smartLinks.map((link) =>
            link.enabled ? (
              <Link
                data-testid={`smart-link-${link.targetType}`}
                className="rounded-lg border px-3 py-2 text-sm text-blue-700 outline-offset-2 focus-visible:outline"
                to={smartLinkPath(link)}
                key={link.id}
              >
                {link.label} {link.count ?? ""}
              </Link>
            ) : (
              <span
                aria-disabled="true"
                title={link.unavailableReason || ""}
                className="rounded-lg border px-3 py-2 text-sm text-slate-400"
                key={link.id}
              >
                {link.label} {link.count ?? ""}
                <span className="ml-1 text-xs">{link.unavailableReason}</span>
              </span>
            ),
          )}
        </div>
      </Section>
      <Section title="订单行与库存可用性">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[900px] text-sm">
            <thead>
              <tr>
                {[
                  "SKU / 物料",
                  "订购",
                  "已预留",
                  "已履约",
                  "待预留",
                  "待履约",
                  "现有量",
                  "库存预留",
                  "可用量",
                ].map((x) => (
                  <th className="p-2 text-left" key={x}>
                    {x}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.lines.map((line) => {
                const av = data.availability.find(
                  (x) => x.salesOrderLineId === line.id,
                );
                return (
                  <tr className="border-t" key={line.id}>
                    <td className="p-2">
                      {line.sku}
                      <div className="text-xs text-slate-500">
                        {line.itemName}
                      </div>
                    </td>
                    {[
                      line.orderedQuantity,
                      line.reservedQuantity,
                      line.fulfilledQuantity,
                      line.remainingToReserve ?? "受限",
                      line.remainingToFulfill ?? "受限",
                      av?.totalOnHand,
                      av?.totalReserved,
                      av?.totalAvailable,
                    ].map((v, i) => (
                      <td className="p-2" key={i}>
                        {v}
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {data.availability
          .flatMap((x) => x.balances)
          .map((b) => (
            <div
              data-testid="availability-balance"
              className="mt-2 grid grid-cols-6 gap-2 rounded-lg bg-slate-50 p-2 text-xs"
              key={b.id}
            >
              <span>{b.warehouseId}</span>
              <span>{b.location || "默认库位"}</span>
              <span>现有 {b.onHandQuantity}</span>
              <span>预留 {b.reservedQuantity}</span>
              <span>可用 {b.availableQuantity}</span>
              <span>{b.selectable ? "可操作" : "只读"}</span>
            </div>
          ))}
      </Section>
      <Section id="reservations" title="预留记录">
        <Table
          rows={data.reservations.map((x) => [
            x.id,
            x.warehouseId,
            x.location,
            x.reservedQuantity,
            x.allocatedQuantity,
            x.consumedQuantity,
            x.releasedQuantity,
            x.allocatableQuantity,
            status(x.status),
          ])}
          headers={[
            "预留 ID",
            "仓库",
            "库位",
            "预留",
            "已分配",
            "已消耗",
            "已释放",
            "可释放",
            "状态",
          ]}
        />
      </Section>
      <Section id="shipments" title="发货单">
        <div className="space-y-2">
          {data.shipments.map((x) => (
            <Link
              data-testid={`shipment-${x.id}`}
              className="flex justify-between rounded-lg border p-3 text-sm text-blue-700"
              to={`/app/sales/shipments/${encodeURIComponent(x.id)}`}
              key={x.id}
            >
              <span>{x.shipmentNumber}</span>
              <span>
                {status(x.workflowStatus)} · {status(x.postingStatus)}
              </span>
            </Link>
          ))}
          {!data.shipments.length && (
            <p className="text-sm text-slate-500">暂无发货单。</p>
          )}
        </div>
      </Section>
      <Section id="movements" title="库存流水">
        <Table
          rows={data.movements.map((x) => [
            x.id,
            x.sku,
            x.warehouseId,
            x.quantityIn,
            x.quantityOut,
            status(x.movementType),
          ])}
          headers={["流水 ID", "SKU", "仓库", "入", "出", "类型"]}
        />
      </Section>
      <Section id="evidence" title="Evidence Timeline">
        <Timeline rows={data.evidence} />
      </Section>
      <Section id="reconciliation" title="Outbound Reconciliation">
        <div className="mb-2 flex items-center gap-2">
          <CheckCircle2 size={17} />
          <Badge value={data.reconciliation.status} />
        </div>
        {data.reconciliation.reasonCode === "PARTIAL_WAREHOUSE_SCOPE" && (
          <p className="mb-2 text-sm text-amber-700">
            完整订单对账无法在当前权限范围内确认。
          </p>
        )}
        {data.reconciliation.checks.map((x) => (
          <div
            className="border-t py-2 text-xs"
            key={`${x.affectedEntity.type}-${x.affectedEntity.id}`}
          >
            {x.rule} · {status(x.status)} · 计算 {x.calculated} / 记录{" "}
            {x.recorded}
          </div>
        ))}
      </Section>
      {intent && (
        <ActionDialog
          title={
            intent === "edit"
              ? "编辑销售订单草稿"
              : intent === "reserve"
                ? "预留库存"
                : intent === "release"
                  ? "释放预留"
                  : "创建发货草稿"
          }
          onClose={() => {
            setIntent("");
            setPreview(null);
          }}
        >
          {intent === "edit" ? (
            <>
              <label className="text-sm">
                客户
                <input
                  aria-label="编辑客户"
                  className="mt-1 w-full rounded-lg border p-2"
                  value={editCustomer}
                  onChange={(e) => {
                    setEditCustomer(e.target.value);
                    setIntentKey(key());
                  }}
                />
              </label>
              <label className="mt-3 block text-sm">
                订购数量
                <input
                  aria-label="编辑数量"
                  className="mt-1 w-full rounded-lg border p-2"
                  value={editQuantity}
                  onChange={(e) => {
                    setEditQuantity(e.target.value);
                    setIntentKey(key());
                  }}
                />
              </label>
              <div className="mt-4">
                <Button disabled={saving} onClick={() => void reviseDraft()}>
                  {saving ? "保存中…" : "保存修订"}
                </Button>
              </div>
            </>
          ) : (
            <>
              {(intent === "reserve" || intent === "shipment") && (
                <label className="block text-sm">
                  订单行
                  <select
                    aria-label="销售订单行"
                    className="mt-1 w-full rounded-lg border p-2"
                    value={selectedLineId}
                    onChange={(e) => {
                      setSelectedLineId(e.target.value);
                      setSelectedBalanceId("");
                      setSelectedReservationId("");
                      setPreview(null);
                      setIntentKey(key());
                    }}
                  >
                    <option value="">请选择订单行</option>
                    {lineOptions.map((x) => (
                      <option value={x.id} key={x.id}>
                        {x.sku} · {x.itemName} · 订购 {x.orderedQuantity} / 预留{" "}
                        {x.reservedQuantity} / 履约 {x.fulfilledQuantity} /
                        待预留 {x.remainingToReserve ?? "受限"}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {intent === "reserve" && (
                <label className="mt-3 block text-sm">
                  仓库 / 库位
                  <select
                    aria-label="库存余额"
                    className="mt-1 w-full rounded-lg border p-2"
                    value={selectedBalanceId}
                    onChange={(e) => {
                      setSelectedBalanceId(e.target.value);
                      setPreview(null);
                      setIntentKey(key());
                    }}
                  >
                    <option value="">请选择库存余额</option>
                    {balanceOptions.map((x) => (
                      <option disabled={!x.selectable} value={x.id} key={x.id}>
                        {x.warehouseId} · {x.location || "默认库位"} · 现有{" "}
                        {x.onHandQuantity} / 预留 {x.reservedQuantity} / 可用{" "}
                        {x.availableQuantity} ·{" "}
                        {x.selectable ? "可操作" : "只读"}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {(intent === "release" || intent === "shipment") && (
                <label className="mt-3 block text-sm">
                  预留记录
                  <select
                    aria-label="预留记录"
                    className="mt-1 w-full rounded-lg border p-2"
                    value={selectedReservationId}
                    onChange={(e) => {
                      setSelectedReservationId(e.target.value);
                      setPreview(null);
                      setIntentKey(key());
                    }}
                  >
                    <option value="">请选择预留记录</option>
                    {reservationOptions.map((x) => (
                      <option value={x.id} key={x.id}>
                        {x.id} · {x.warehouseId} / {x.location || "默认库位"} ·
                        预留 {x.reservedQuantity} / 已分配 {x.allocatedQuantity}{" "}
                        / 已消耗 {x.consumedQuantity} / 已释放{" "}
                        {x.releasedQuantity} / 可分配 {x.allocatableQuantity}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <label className="mt-3 block text-sm">
                数量
                <input
                  aria-label="交易数量"
                  className="mt-1 w-full rounded-lg border p-2"
                  value={quantity}
                  onChange={(e) => {
                    setQuantity(e.target.value);
                    setPreview(null);
                    setIntentKey(key());
                  }}
                />
              </label>
              {intent === "shipment" && (
                <label className="mt-3 block text-sm">
                  发货单号
                  <input
                    aria-label="发货单号"
                    className="mt-1 w-full rounded-lg border p-2"
                    value={shipmentNumber}
                    onChange={(e) => {
                      setShipmentNumber(e.target.value);
                      setPreview(null);
                      setIntentKey(key());
                    }}
                  />
                  <span className="mt-1 block text-xs text-slate-500">
                    当前界面每次创建一个订单行和一条预留分配；后端 API
                    支持多行和多分配。
                  </span>
                </label>
              )}
              {intent === "release" && (
                <label className="mt-3 block text-sm">
                  原因
                  <input
                    aria-label="释放原因"
                    className="mt-1 w-full rounded-lg border p-2"
                    value={reason}
                    onChange={(e) => {
                      setReason(e.target.value);
                      setPreview(null);
                      setIntentKey(key());
                    }}
                  />
                </label>
              )}
              {preview ? (
                <PreviewView preview={preview} />
              ) : (
                <p className="mt-3 text-xs text-slate-500">
                  必须先读取服务端 Preview，前端不计算权威库存。
                </p>
              )}
              <div className="mt-4 flex gap-2">
                <Button
                  testId="outbound-preview"
                  disabled={saving}
                  onClick={() => void loadPreview()}
                >
                  Preview
                </Button>
                <Button
                  testId="confirm-outbound-action"
                  disabled={!preview?.allowed || saving}
                  onClick={() => void execute()}
                >
                  {saving ? "处理中…" : "确认执行"}
                </Button>
              </div>
            </>
          )}
        </ActionDialog>
      )}
    </div>
  );
}

function ShipmentDetail({ id }: { id: string }) {
  const [data, setData] = useState<ShipmentWorkbench | null>(null),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true),
    [preview, setPreview] = useState<Preview | null>(null),
    [intent, setIntent] = useState(""),
    [intentKey, setIntentKey] = useState(""),
    [reason, setReason] = useState("业务冲销"),
    [saving, setSaving] = useState(false);
  const refresh = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      setData(
        await apiJson(
          `/api/sales/shipments/${encodeURIComponent(id)}/workbench`,
        ),
      );
    } catch (e) {
      setError(message(e));
    } finally {
      setLoading(false);
    }
  }, [id]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  function start(x: string) {
    setIntent(x);
    setIntentKey(key());
    setPreview(null);
  }
  async function loadPreview() {
    try {
      setPreview(
        await apiJson(
          `/api/sales/shipments/${encodeURIComponent(id)}/${intent}-preview`,
          {
            method: "POST",
            body: JSON.stringify(intent === "post" ? {} : { reason }),
          },
        ),
      );
    } catch (e) {
      setError(message(e));
    }
  }
  async function execute() {
    if (!data || !preview) return;
    setSaving(true);
    try {
      await apiJson(
        `/api/sales/shipments/${encodeURIComponent(id)}/${intent}`,
        {
          method: "POST",
          body: JSON.stringify({
            idempotencyKey: intentKey,
            expectedShipmentVersion: data.shipment.version,
            ...(intent === "post" ? {} : { reason }),
          }),
        },
      );
      setIntent("");
      setPreview(null);
      await refresh();
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        setPreview(null);
        await refresh();
      }
      setError(message(e));
    } finally {
      setSaving(false);
    }
  }
  if (loading)
    return (
      <div className="p-10 text-center">
        <Loader2 className="mx-auto animate-spin" />
        正在读取发货单…
      </div>
    );
  if (!data) return <div role="alert">{error}</div>;
  return (
    <div className="space-y-4" data-testid="shipment-workbench">
      {error && (
        <div role="alert" className="rounded-lg bg-red-50 p-3 text-red-700">
          {error}
        </div>
      )}
      <section className="rounded-xl border bg-white p-5">
        <div className="flex flex-wrap justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-xl font-semibold">
                {data.shipment.shipmentNumber}
              </h1>
              <span className="rounded bg-blue-50 px-2 py-1 text-xs text-blue-700">
                Authoritative PostgreSQL
              </span>
            </div>
            <p className="text-sm text-slate-500">
              销售订单{" "}
              <Link
                className="text-blue-600 underline"
                to={`/app/sales/orders/${encodeURIComponent(data.shipment.salesOrderId)}`}
              >
                {data.salesOrder.orderNumber}
              </Link>{" "}
              · v{data.shipment.version}
            </p>
            <div className="mt-2 flex gap-2">
              <Badge value={data.shipment.workflowStatus} />
              <Badge value={data.shipment.postingStatus} />
            </div>
            <p className="mt-2 text-xs text-slate-500">
              过账 {stamp(data.shipment.postedAt)} · 冲销{" "}
              {stamp(data.shipment.reversedAt)} ·{" "}
              {data.shipment.reversalReason || "无冲销原因"}
            </p>
          </div>
          <div className="flex gap-2">
            {data.availableActions.canCancel && (
              <Button tone="secondary" onClick={() => start("cancel")}>
                取消草稿
              </Button>
            )}
            {data.availableActions.canPost && (
              <Button testId="open-post" onClick={() => start("post")}>
                过账发货
              </Button>
            )}
            {data.availableActions.canReverse && (
              <Button
                testId="open-reverse"
                tone="danger"
                onClick={() => start("reverse")}
              >
                冲销发货
              </Button>
            )}
          </div>
        </div>
      </section>
      <Section title="发货行">
        <Table
          headers={["SKU / 物料", "请求数量", "已过账", "单位"]}
          rows={data.lines.map((x) => [
            `${x.sku} · ${x.itemName}`,
            x.requestedQuantity,
            x.postedQuantity,
            x.unit,
          ])}
        />
      </Section>
      <Section title="分配与库存流水">
        <Table
          headers={[
            "预留",
            "仓库",
            "库位",
            "数量",
            "状态",
            "出库流水",
            "冲销流水",
          ]}
          rows={data.allocations.map((x) => [
            x.reservationId,
            x.warehouseId,
            x.location,
            x.quantity,
            x.status,
            x.movementLink || "—",
            x.reversalMovementLink || "—",
          ])}
        />
        {data.movements.map((x) => (
          <div className="mt-2 rounded-lg bg-slate-50 p-2 text-xs" key={x.id}>
            {x.id} · {x.movementType} · {x.itemName} · 入 {x.quantityIn} / 出{" "}
            {x.quantityOut}
          </div>
        ))}
      </Section>
      <Section title="Evidence Timeline">
        <Timeline rows={data.evidence} />
      </Section>
      <Section title="Reconciliation & AI Explain">
        <div className="flex items-center gap-2">
          <ShieldCheck size={18} />
          <Badge value={data.reconciliation.status} />
          <span className="text-sm">{data.aiExplain.conclusion}</span>
        </div>
      </Section>
      {intent && (
        <ActionDialog
          title={
            intent === "post"
              ? "发货过账确认"
              : intent === "reverse"
                ? "发货冲销确认"
                : "取消发货草稿"
          }
          onClose={() => {
            setIntent("");
            setPreview(null);
          }}
        >
          {intent !== "post" && (
            <label className="text-sm">
              原因
              <input
                aria-label="操作原因"
                className="mt-1 w-full rounded-lg border p-2"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
            </label>
          )}
          <p className="mt-2 text-xs text-slate-500">
            发货时 On Hand 与 Reserved 同时下降，因此 Available
            不会再次下降。冲销没有“强制绕过”选项。
          </p>
          {preview && <PreviewView preview={preview} />}
          <div className="mt-4 flex gap-2">
            <Button
              testId="shipment-preview"
              onClick={() => void loadPreview()}
            >
              Preview
            </Button>
            <Button
              testId="confirm-shipment-action"
              disabled={!preview?.allowed || saving}
              onClick={() => void execute()}
            >
              {saving ? "处理中…" : "确认执行"}
            </Button>
          </div>
        </ActionDialog>
      )}
    </div>
  );
}

function Table({
  headers,
  rows,
}: {
  headers: string[];
  rows: Array<Array<string | number>>;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[760px] text-sm">
        <thead>
          <tr className="border-b text-left text-xs text-slate-500">
            {headers.map((x) => (
              <th className="p-2" key={x}>
                {x}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr className="border-b" key={i}>
              {row.map((x, j) => (
                <td className="p-2 tabular-nums" key={j}>
                  {x}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {!rows.length && <p className="p-4 text-sm text-slate-500">暂无记录。</p>}
    </div>
  );
}
function Timeline({ rows }: { rows: Workbench["evidence"] }) {
  return (
    <div className="space-y-2">
      {rows.map((x, i) => (
        <div
          className="border-l-2 border-blue-200 pl-3 text-sm"
          key={`${x.eventType}-${x.entityId}-${i}`}
        >
          <div className="font-semibold">{x.title}</div>
          <div className="text-xs text-slate-500">
            {stamp(x.occurredAt)} · {x.summary}
          </div>
          {x.commandExecutionId && (
            <div className="text-[11px] text-slate-400">
              Command {x.commandExecutionId} · Key {x.idempotencyKey}
            </div>
          )}
        </div>
      ))}
      {!rows.length && <p className="text-sm text-slate-500">暂无证据事件。</p>}
    </div>
  );
}
function PreviewView({ preview }: { preview: Preview }) {
  return (
    <div
      data-testid="outbound-preview-result"
      className={`mt-3 rounded-lg border p-3 text-xs ${preview.allowed ? "bg-emerald-50" : "bg-amber-50"}`}
    >
      <div className="font-semibold">
        {preview.allowed ? "Preview 允许执行" : "Preview 已阻断"}
      </div>
      {preview.blockingIssues.map((x) => (
        <div className="mt-1 text-red-700" key={x.code}>
          {x.message}
        </div>
      ))}
      <div className="mt-2">
        库存影响 {preview.balanceImpacts.length} · 预留影响{" "}
        {preview.reservationImpacts.length} · 订单行影响{" "}
        {preview.salesOrderLineImpacts.length}
      </div>
      <pre className="mt-2 max-h-36 overflow-auto whitespace-pre-wrap">
        {JSON.stringify(preview.factsToCreate, null, 2)}
      </pre>
    </div>
  );
}
function ActionDialog({
  title,
  children,
  onClose,
}: {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
}) {
  useEffect(() => {
    const close = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [onClose]);
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4"
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      <div className="max-h-[90vh] w-full max-w-xl overflow-auto rounded-xl bg-white p-5 shadow-xl">
        <div className="mb-4 flex justify-between">
          <h2 className="font-semibold">{title}</h2>
          <button aria-label="关闭" onClick={onClose}>
            ×
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
