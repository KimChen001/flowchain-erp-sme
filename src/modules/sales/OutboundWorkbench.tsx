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
import { useI18n } from "../../i18n/I18n";
import { workspaceCopy } from "../../i18n/workspaceCopy";
import { outboundEnglish } from "./outboundCopy";
import { outboundPreviewSentences, type OutboundPreviewLookup } from "./outboundPreviewText";
import { formatQuantity } from "../../lib/format";
import { movementTypeLabel } from "../../i18n/statusLabels";
import { createSecureClientMutationId } from "../../lib/client-id";
import { useWorkspaceCurrency } from "../../lib/useWorkspaceCurrency";
import { orderedCurrencyCodes } from "../../lib/currencyOptions";
import { BusinessEntityLink } from "../../components/business/BusinessEntityLink";
import { useWarehouseNames } from "../../lib/useWarehouseNames";
import { CreateInvoiceAction } from "../../components/business/BillingEntryActions";
import {
  tableMinSmClass,
  tableScrollClass,
  tdActionClass,
  tdIdClass,
  tdNameClass,
  tdNowrapClass,
  tdNumericClass,
  thClass,
} from "../../components/ui/workbenchTable";

// The interface language for this render. OutboundWorkbench, the root of every
// page here, sets it from the i18n context before its children render. The
// <html lang> attribute is updated only after that render, so it is not used.
let activeLanguage = "en-US";
const copy = (label: string) =>
  activeLanguage === "en-US" ? outboundEnglish[label] || workspaceCopy(label, activeLanguage) : label;
const englishUi = () => activeLanguage === "en-US";
// New copy is written in English with its Chinese translation.
const say = (english: string, chinese: string) => (activeLanguage === "en-US" ? english : chinese);

type CancellationPreview = {
  allowed: boolean;
  blockingIssues: Array<{ code: string; message: string }>;
  shipmentImpacts: Array<{ shipmentId: string; shipmentNumber: string }>;
  reservationImpacts: Array<{ reservationId: string; sku: string; warehouseId: string; releasedQuantity: string }>;
  releasedQuantity: string;
};

type Order = {
  id: string;
  orderNumber: string;
  customerId?: string | null;
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
  unitPrice?: string | null;
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
  sku?: string;
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
    location?: string;
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
  normalizedPlan?: Record<string, unknown> | null;
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
  // Reservation and shipment allocation statuses.
  active: "有效",
  allocated: "已分配",
  partially_allocated: "部分分配",
  partially_consumed: "部分消耗",
  consumed: "已消耗",
  released: "已释放",
  deallocated: "已取消分配",
};
const status = (value: string) => copy(pretty[value] || value);
// One status for a shipment: cancelled, else posted or reversed, else where
// the unposted draft stands. Both stored statuses stay as they are.
const shipmentStatus = (shipment: { workflowStatus: string; postingStatus: string }) =>
  shipment.workflowStatus === "cancelled"
    ? "cancelled"
    : shipment.postingStatus && shipment.postingStatus !== "unposted"
      ? shipment.postingStatus
      : shipment.workflowStatus;
// A long stored id (a reservation or movement UUID) in a short form for a
// table column. The full id is never changed.
const shortId = (id?: string | null) => {
  const value = String(id || "");
  return value.length > 12 ? `${value.slice(0, 8)}…` : value || "—";
};
const hasQuantity = (value?: string | null) => Number(value) > 0;
// A warehouse by its name and its location, e.g. "Main Warehouse / A-01".
function usePlace() {
  const warehouseName = useWarehouseNames();
  return useCallback(
    (warehouseId?: string | null, location?: string | null) =>
      `${warehouseName(warehouseId) || "—"} / ${location || copy("默认库位")}`,
    [warehouseName],
  );
}
const reconciliationRuleLabels: Record<string, string> = {
  "available = onHand - reserved": "可用量 = 在库量 - 预留量",
  "reserved + fulfilled <= ordered": "预留量 + 已履约量不超过订购量",
};
const reconciliationRuleLabel = (value: string) =>
  reconciliationRuleLabels[value] ? copy(reconciliationRuleLabels[value]) : value;
// Timestamps follow the workspace locale and timezone.
function useStamp() {
  const { formatDateTime } = useI18n();
  return (value?: string | null) =>
    value && !Number.isNaN(new Date(value).getTime()) ? formatDateTime(value) : value || "—";
}
// Shown both as a preview blocking issue and as a command error.
const SHIPMENT_INVOICE_BLOCK =
  "已有客户发票对此发货开票，不能再冲销。如需收回货物，请使用客户退货和贷项通知单。";
// The message for an error, kept in its source form and translated where it
// is shown, so it follows a language change made after the error occurred.
function message(error: unknown) {
  return errorMessage(error);
}
function errorMessage(error: unknown) {
  if (!(error instanceof ApiError)) return "网络连接失败，请检查连接后重试。";
  if (error.status === 401) return "登录已失效，请重新登录后读取销售订单。";
  if (error.status === 403) return "当前账号没有读取销售订单的权限。";
  if (error.status >= 500) return "销售订单服务暂时不可用，请稍后重试。";
  return codeMessages[error.code || ""] || error.message;
}
// A preview's blocking issue in the interface language when its code is known;
// otherwise the server's message as sent.
const issueMessage = (issue: { code: string; message: string }) =>
  codeMessages[issue.code] ? copy(codeMessages[issue.code]) : issue.message;
const codeMessages: Record<string, string> = {
  PERMISSION_DENIED: "当前角色只能查看，不能执行此操作。",
  WAREHOUSE_SCOPE_DENIED: "当前账号没有相关仓库权限。",
  SALES_ORDER_ON_HOLD: "销售订单当前已暂停，不能执行发货过账。请先恢复订单。",
  OUTBOUND_CAPABILITY_NOT_AVAILABLE:
    "当前销售订单写入能力未启用，页面保持只读。",
  SALES_ORDER_VERSION_CONFLICT: "订单已发生变化，请刷新后重新预览。",
  SHIPMENT_VERSION_CONFLICT: "发货单已变化，请刷新后重新预览。",
  OUTBOUND_CONCURRENT_TRANSACTION_CONFLICT:
    "库存已发生变化，请刷新后重新预览。",
  IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD:
    "操作内容已改变，请重新开始该操作。",
  COMMAND_EXECUTION_IN_PROGRESS: "该操作正在处理中，请稍后重试。",
  RESERVATION_INSUFFICIENT_AVAILABLE: "可用库存不足，请调整数量。",
  RESERVATION_OVER_ORDERED: "数量超过该订单行尚待预留的数量。",
  SHIPMENT_RESERVATION_INSUFFICIENT: "预留数量不足，请调整数量。",
  SHIPMENT_OVER_FULFILLMENT: "数量超过该订单行尚待发货的数量。",
  SHIPMENT_REVERSAL_NOT_SAFE: "历史出库事实不一致，系统已阻止冲销。",
  SHIPMENT_REVERSAL_BLOCKED_BY_INVOICE: SHIPMENT_INVOICE_BLOCK,
  SHIPMENT_NUMBER_CONFLICT: "发货单号已存在，请更换号码。",
  SALES_ORDER_NUMBER_CONFLICT: "销售订单号已存在，请更换号码。",
  SALES_ORDER_INVALID_STATE: "当前订单状态不允许此操作。",
  SALES_ORDER_ITEM_INVALID: "订单物料与当前工作区主数据不一致。",
};
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
  ariaLabel,
  tone = "primary",
}: {
  children: React.ReactNode;
  disabled?: boolean;
  onClick?: () => void;
  testId?: string;
  ariaLabel?: string;
  tone?: "primary" | "secondary" | "danger";
}) => (
  <button
    data-testid={testId}
    aria-label={ariaLabel}
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
  const { language } = useI18n();
  activeLanguage = language;
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
  const workspace = useWorkspaceCurrency();
  const stamp = useStamp();
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
      setData(null);
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
      {data && !data.capabilities.salesOrderLifecycle.enabled && (
        <div role="status" className="rounded-lg bg-slate-100 p-3 text-slate-700">
          {copy("销售订单当前为只读；订单、库存预留和履约事实来自 PostgreSQL。")}
        </div>
      )}
      {error && (
        <div role="alert" className="rounded-lg bg-red-50 p-3 text-red-700">
          {copy(error)}
        </div>
      )}
      <Section title={copy("销售订单查询")}>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-slate-500">
            {copy("查询订单、客户、库存预留、履约状态和承诺日期。")}
          </p>
          {data?.capabilities.salesOrderLifecycle.enabled && (
            <Link
              to="/app/sales/orders/new"
              className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white"
            >
              {copy("新建销售订单")}
            </Link>
          )}
        </div>
        <div className="mb-3 grid gap-2 md:grid-cols-3 xl:grid-cols-6">
          <label className="text-xs">
            {copy("搜索")}
            <input
              aria-label={copy("搜索销售订单")}
              value={value("search")}
              onChange={(e) => update({ search: e.target.value, page: 1 })}
              className={`${select} mt-1 w-full`}
              placeholder={copy("订单号或客户")}
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
            {copy("币种")}
            <select
              aria-label={copy("币种筛选")}
              className={`${select} mt-1 w-full`}
              value={value("currency")}
              onChange={(e) => update({ currency: e.target.value, page: 1 })}
            >
              <option value="">{copy("全部")}</option>
              {orderedCurrencyCodes(workspace.currency, ["USD", "EUR", "CNY"]).map((x) => (
                <option key={x}>{x}</option>
              ))}
            </select>
          </label>
          <label className="text-xs">
            {copy("排序")}
            <select
              aria-label={copy("订单排序")}
              className={`${select} mt-1 w-full`}
              value={`${value("sort", "updatedAt")}:${value("direction", "desc")}`}
              onChange={(e) => {
                const [sort, direction] = e.target.value.split(":");
                update({ sort, direction, page: 1 });
              }}
            >
              <option value="updatedAt:desc">{copy("更新时间（新到旧）")}</option>
              <option value="updatedAt:asc">{copy("更新时间（旧到新）")}</option>
              <option value="promisedDate:asc">{copy("承诺日期（升序）")}</option>
              <option value="promisedDate:desc">{copy("承诺日期（降序）")}</option>
              <option value="orderNumber:asc">{copy("订单号（升序）")}</option>
              <option value="orderNumber:desc">{copy("订单号（降序）")}</option>
            </select>
          </label>
        </div>
        <div className={tableScrollClass}>
          <table className={tableMinSmClass}>
            <thead>
              <tr className="border-b">
                {[
                  "订单号",
                  "客户",
                  "流程",
                  "预留状态",
                  "履约状态",
                  "币种",
                  "行数",
                  "订购 / 预留 / 履约",
                  "更新时间",
                  "操作",
                ].map((x) => (
                  <th className={thClass} key={x}>
                    {copy(x)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data?.orders.map((row) => (
                <tr key={row.id} className="border-b">
                  <td className={tdIdClass}>
                    <BusinessEntityLink entityType="sales_order" entityId={row.id}>
                      {row.orderNumber}
                    </BusinessEntityLink>
                  </td>
                  <td className={tdNameClass}>{row.customerName}</td>
                  <td className={tdNowrapClass}>
                    <Badge value={row.workflowStatus} />
                  </td>
                  <td className={tdNowrapClass}>
                    <Badge value={row.reservationStatus} />
                  </td>
                  <td className={tdNowrapClass}>
                    <Badge value={row.fulfillmentStatus} />
                  </td>
                  <td className={tdNowrapClass}>{row.currency}</td>
                  <td className={tdNumericClass}>{row.totalLines}</td>
                  <td className={tdNumericClass}>
                    {row.orderedQuantity} / {row.reservedQuantity} /{" "}
                    {row.fulfilledQuantity}
                  </td>
                  <td className={tdNowrapClass}>{stamp(row.updatedAt)}</td>
                  <td className={tdActionClass}>
                    <Link
                      className="inline-flex rounded-md bg-blue-50 px-3 py-1.5 font-medium text-blue-700 hover:bg-blue-100"
                      to={`/app/sales/orders/${encodeURIComponent(row.id)}`}
                    >
                      {copy("查看")}
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {data && data.orders.length === 0 && (
            <div className="p-8 text-center text-sm text-slate-500">
              {copy("暂无符合当前筛选条件的正式销售订单。")}
              <button
                className="ml-2 text-blue-700 underline"
                onClick={() => setParams({})}
              >
                {copy("清除筛选")}
              </button>
            </div>
          )}
        </div>
        <div className="mt-3 flex items-center justify-between text-sm">
          <span>
            {englishUi() ? `Page ${data?.page || page} of ${totalPages} · ${data?.total || 0} results` : `第 ${data?.page || page} / ${totalPages} 页 · 共 ${data?.total || 0} 条`}
          </span>
          <div className="flex gap-2">
            <Button
              tone="secondary"
              disabled={page <= 1}
              onClick={() => update({ page: page - 1 })}
            >
              {copy("上一页")}
            </Button>
            <Button
              tone="secondary"
              disabled={page >= totalPages}
              onClick={() => update({ page: page + 1 })}
            >
              {copy("下一页")}
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
      {copy(label)}
      <select
        aria-label={copy(label)}
        className="mt-1 w-full rounded-lg border px-3 py-2 text-sm"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="">{copy("全部")}</option>
        {values.map((x) => (
          <option value={x} key={x}>
            {status(x)}
          </option>
        ))}
      </select>
    </label>
  );
}

type EntryItem = { id: string; sku: string; name: string; unit?: string };
type EntryCustomer = {
  id: string;
  code: string;
  name: string;
  currency: string | null;
  paymentTerms: string | null;
};
type EntryData = {
  items: EntryItem[];
  customers?: EntryCustomer[];
  capabilities: { salesOrderLifecycle: LifecycleCapability };
};
type DraftLine = { key: string; itemId: string; quantity: string; unitPrice: string };

const draftLine = (itemId = "", quantity = "1", unitPrice = ""): DraftLine => ({
  key: key(),
  itemId,
  quantity,
  unitPrice,
});
// Every line needs an item, a quantity above 0 and a unit price (0 for free
// goods), because an order without prices could never be invoiced.
const linesReady = (lines: DraftLine[]) =>
  lines.length > 0 &&
  lines.every((line) => line.itemId && Number(line.quantity) > 0 && line.unitPrice.trim() !== "");
const linesPayload = (lines: DraftLine[]) =>
  lines.map(({ itemId, quantity, unitPrice }) => ({
    itemId,
    quantity: quantity.trim(),
    unitPrice: unitPrice.trim(),
  }));
// A promised date is a calendar day. It is stored at 12:00 UTC like the other
// business dates, so it reads as the same day in every timezone.
const promisedDay = (value?: string | null) => (value ? String(value).slice(0, 10) : "");
const promisedValue = (day: string) => (day ? `${day}T12:00:00.000Z` : null);

// The customer an order is for, chosen from Customers. A new workspace with no
// customers is sent to add or import them first.
function CustomerField({
  customers,
  value,
  onChange,
  ariaLabel,
}: {
  customers: EntryCustomer[];
  value: string;
  onChange: (customer: EntryCustomer | null) => void;
  ariaLabel: string;
}) {
  const chosen = customers.find((customer) => customer.id === value);
  if (!customers.length)
    return (
      <div className="text-sm" data-testid="sales-order-no-customers">
        {say("Customer", "客户")}
        <p className="mt-1 rounded-lg bg-amber-50 p-2 text-amber-800">
          {say(
            "No customers yet. Add or import your customers, then place the order.",
            "还没有客户。请先新增或导入客户，再录入订单。",
          )}{" "}
          <Link className="underline" to="/app/master-data/customers">
            {say("Customers", "客户")}
          </Link>
          {" · "}
          <Link className="underline" to="/app/master-data/import">
            {say("Import data", "导入数据")}
          </Link>
        </p>
      </div>
    );
  return (
    <label className="text-sm">
      {say("Customer", "客户")}
      <select
        aria-label={ariaLabel}
        className="mt-1 w-full rounded-lg border p-2"
        value={value}
        onChange={(e) => onChange(customers.find((customer) => customer.id === e.target.value) || null)}
      >
        <option value="">{say("Choose a customer", "选择客户")}</option>
        {customers.map((customer) => (
          <option key={customer.id} value={customer.id}>
            {customer.name} · {customer.code}
          </option>
        ))}
      </select>
      {chosen?.paymentTerms && (
        <span className="mt-1 block text-xs text-slate-500" data-testid="sales-order-customer-terms">
          {say(`Payment terms: ${chosen.paymentTerms}`, `付款条款：${chosen.paymentTerms}`)}
        </span>
      )}
    </label>
  );
}

// The order's lines: item, quantity and unit price, one row each.
function OrderLinesField({
  items,
  lines,
  currency,
  onChange,
}: {
  items: EntryItem[];
  lines: DraftLine[];
  currency: string;
  onChange: (lines: DraftLine[]) => void;
}) {
  const update = (lineKey: string, change: Partial<DraftLine>) =>
    onChange(lines.map((line) => (line.key === lineKey ? { ...line, ...change } : line)));
  return (
    <div className="space-y-3" data-testid="sales-order-lines">
      {lines.map((line, index) => {
        const unit = items.find((item) => item.id === line.itemId)?.unit;
        const n = String(index + 1);
        return (
          <div
            key={line.key}
            className="grid gap-2 rounded-lg border p-3 md:grid-cols-[2fr_1fr_1fr_auto]"
            data-testid={`sales-order-line-${n}`}
          >
            <label className="text-sm">
              {say("Item", "物料")}
              <select
                aria-label={say(`Item, line ${n}`, `物料（第 ${n} 行）`)}
                className="mt-1 w-full rounded-lg border p-2"
                value={line.itemId}
                onChange={(e) => update(line.key, { itemId: e.target.value })}
              >
                <option value="">{say("Choose an item", "选择物料")}</option>
                {items.map((item) => (
                  <option value={item.id} key={item.id}>
                    {item.sku} · {item.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-sm">
              {unit ? say(`Quantity (${unit})`, `数量（${unit}）`) : say("Quantity", "数量")}
              <input
                aria-label={say(`Quantity, line ${n}`, `数量（第 ${n} 行）`)}
                inputMode="decimal"
                className="mt-1 w-full rounded-lg border p-2"
                value={line.quantity}
                onChange={(e) => update(line.key, { quantity: e.target.value })}
              />
            </label>
            <label className="text-sm">
              {currency ? say(`Unit price (${currency})`, `单价（${currency}）`) : say("Unit price", "单价")}
              <input
                aria-label={say(`Unit price, line ${n}`, `单价（第 ${n} 行）`)}
                inputMode="decimal"
                className="mt-1 w-full rounded-lg border p-2"
                value={line.unitPrice}
                onChange={(e) => update(line.key, { unitPrice: e.target.value })}
              />
            </label>
            <div className="flex items-end">
              <Button
                tone="secondary"
                ariaLabel={say(`Remove line ${n}`, `删除第 ${n} 行`)}
                disabled={lines.length === 1}
                onClick={() => onChange(lines.filter((other) => other.key !== line.key))}
              >
                {say("Remove", "删除")}
              </Button>
            </div>
          </div>
        );
      })}
      <div className="flex flex-wrap items-center gap-3">
        <Button tone="secondary" testId="sales-order-add-line" onClick={() => onChange([...lines, draftLine()])}>
          {say("Add line", "添加行")}
        </Button>
        <span className="text-xs text-slate-500">
          {say(
            "A unit price is needed to invoice the customer. Enter 0 for free goods.",
            "开客户发票需要单价。赠品请填 0。",
          )}
        </span>
      </div>
    </div>
  );
}

function OrderEntry() {
  const nav = useNavigate(),
    [entry, setEntry] = useState<EntryData | null>(null),
    [orderNumber, setOrderNumber] = useState(`SO-${Date.now()}`),
    [customerId, setCustomerId] = useState(""),
    [currency, setCurrency] = useState(""),
    [promised, setPromised] = useState(""),
    [lines, setLines] = useState<DraftLine[]>(() => [draftLine()]),
    [saving, setSaving] = useState(false),
    [error, setError] = useState("");
  const intent = useRef({ fingerprint: "", idempotencyKey: "" }),
    inFlight = useRef(false);
  const workspace = useWorkspaceCurrency();
  const customers = entry?.customers || [];
  // Prefill the workspace currency; a chosen customer's recorded currency
  // replaces it, and the user can still type another ISO code.
  useEffect(() => {
    if (workspace.currency) setCurrency((current) => current || workspace.currency);
  }, [workspace.currency]);
  useEffect(() => {
    apiJson<EntryData>("/api/sales/order-entry-data")
      .then((x) => setEntry(x))
      .catch((e) => setError(message(e)));
  }, []);
  function chooseCustomer(customer: EntryCustomer | null) {
    setCustomerId(customer?.id || "");
    if (customer?.currency) setCurrency(customer.currency);
  }
  async function save() {
    if (inFlight.current) return;
    const body = {
      orderNumber,
      customerId,
      currency,
      promisedDate: promisedValue(promised),
      lines: linesPayload(lines),
    };
    const fingerprint = JSON.stringify(body);
    if (intent.current.fingerprint !== fingerprint)
      intent.current = { fingerprint, idempotencyKey: key() };
    inFlight.current = true;
    setSaving(true);
    setError("");
    try {
      const result = await apiJson<{ order: Order }>("/api/sales/orders", {
        method: "POST",
        body: JSON.stringify({ ...body, idempotencyKey: intent.current.idempotencyKey }),
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
  const capability = entry?.capabilities.salesOrderLifecycle;
  if (!entry || !capability)
    return (
      <div className="p-10 text-center" data-testid="sales-order-entry-loading">
        {error ? copy(error) : say("Loading…", "正在读取…")}
      </div>
    );
  if (!capability.enabled)
    return (
      <div className="mx-auto max-w-3xl space-y-4" data-testid="sales-order-entry-readonly">
        <h1 className="text-xl font-semibold">{copy("新建销售订单")}</h1>
        <div role="status" className="rounded-lg bg-slate-100 p-4 text-slate-700">
          {copy("当前销售订单写入能力未启用，页面保持只读。")}
        </div>
        <Link className="text-blue-700 underline" to="/app/sales/orders">
          {copy("返回销售订单列表")}
        </Link>
      </div>
    );
  return (
    <div className="mx-auto max-w-3xl space-y-4" data-testid="sales-order-entry">
      <div>
        <h1 className="text-xl font-semibold">{copy("新建销售订单草稿")}</h1>
        <p className="text-sm text-slate-500">
          {copy("SKU、物料名称与单位由 PostgreSQL Item 主数据快照。")}
        </p>
      </div>
      {error && (
        <div role="alert" className="rounded-lg bg-red-50 p-3 text-red-700">
          {copy(error)}
        </div>
      )}
      <Section title={copy("订单信息")}>
        <div className="grid gap-3 md:grid-cols-2">
          <CustomerField
            customers={customers}
            value={customerId}
            onChange={chooseCustomer}
            ariaLabel={say("Customer", "客户")}
          />
          <label className="text-sm">
            {copy("订单号")}
            <input
              aria-label={copy("订单号")}
              className="mt-1 w-full rounded-lg border p-2"
              value={orderNumber}
              onChange={(e) => setOrderNumber(e.target.value)}
            />
          </label>
          <label className="text-sm">
            {copy("币种")}
            <input
              aria-label={copy("币种")}
              maxLength={3}
              className="mt-1 w-full rounded-lg border p-2 uppercase"
              value={currency}
              onChange={(e) => setCurrency(e.target.value.toUpperCase())}
            />
            {workspace.status === "unavailable" && !currency && (
              <span className="mt-1 block text-xs text-amber-700">
                {copy("无法读取工作区币种，请输入币种。")}
              </span>
            )}
          </label>
          <label className="text-sm">
            {say("Promised date (optional)", "承诺交期（可选）")}
            <input
              type="date"
              aria-label={say("Promised date", "承诺交期")}
              className="mt-1 w-full rounded-lg border p-2"
              value={promised}
              onChange={(e) => setPromised(e.target.value)}
            />
          </label>
        </div>
      </Section>
      <Section title={say("Lines", "订单行")}>
        <OrderLinesField items={entry.items} lines={lines} currency={currency} onChange={setLines} />
        <div className="mt-4 flex gap-2">
          <Button
            testId="create-sales-order"
            disabled={saving || !customerId || !currency.trim() || !linesReady(lines)}
            onClick={() => void save()}
          >
            {saving ? copy("保存中…") : copy("保存草稿")}
          </Button>
          <Link className="rounded-lg bg-slate-100 px-3 py-2 text-sm" to="/app/sales/orders">
            {copy("取消")}
          </Link>
        </div>
      </Section>
    </div>
  );
}

function OrderDetail({ id }: { id: string }) {
  const warehouseName = useWarehouseNames();
  const place = usePlace();
  const stamp = useStamp();
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
    [reason, setReason] = useState(() => copy("业务调整")),
    [shipmentNumber, setShipmentNumber] = useState(`SHIP-${Date.now()}`),
    [editCustomerId, setEditCustomerId] = useState(""),
    [editPromised, setEditPromised] = useState(""),
    [editLines, setEditLines] = useState<DraftLine[]>([]),
    [editEntry, setEditEntry] = useState<EntryData | null>(null),
    [cancelReason, setCancelReason] = useState(""),
    [cancelPreview, setCancelPreview] = useState<CancellationPreview | null>(null),
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
      setEditCustomerId(data.order.customerId || "");
      setEditPromised(promisedDay(data.order.promisedDate));
      setEditLines(data.lines.map((line) => draftLine(line.itemId, line.orderedQuantity, line.unitPrice ?? "")));
      apiJson<EntryData>("/api/sales/order-entry-data")
        .then(setEditEntry)
        .catch((e) => setError(message(e)));
    }
    // With only one order line, or one reservation to release, it is chosen.
    if ((next === "reserve" || next === "shipment") && data?.lines.length === 1)
      chooseLine(data.lines[0].id, next);
    if (next === "release" && data) {
      const open = data.reservations.filter((row) => hasQuantity(row.allocatableQuantity));
      if (open.length === 1) chooseReservation(open[0].id);
    }
  }
  // Choosing a line picks its only usable balance (to reserve) or its only
  // open reservation (to ship), and fills in the quantity the line still needs.
  function chooseLine(lineId: string, forIntent = intent) {
    setSelectedLineId(lineId);
    setSelectedBalanceId("");
    setSelectedReservationId("");
    setPreview(null);
    setIntentKey(key());
    const line = data?.lines.find((row) => row.id === lineId);
    if (!data || !line) return;
    if (forIntent === "reserve") {
      setQuantity(hasQuantity(line.remainingToReserve) ? line.remainingToReserve! : "1.0000");
      const usable =
        data.availability
          .find((row) => row.salesOrderLineId === lineId)
          ?.balances.filter((row) => row.selectable) || [];
      if (usable.length === 1) setSelectedBalanceId(usable[0].id);
    } else if (forIntent === "shipment") {
      const open = data.reservations.filter(
        (row) => row.salesOrderLineId === lineId && hasQuantity(row.allocatableQuantity),
      );
      if (open.length === 1) {
        setSelectedReservationId(open[0].id);
        setQuantity(open[0].allocatableQuantity);
      } else setQuantity(hasQuantity(line.remainingToFulfill) ? line.remainingToFulfill! : "1.0000");
    }
  }
  // A reservation's quantity still free to ship or release.
  function chooseReservation(reservationId: string) {
    setSelectedReservationId(reservationId);
    setPreview(null);
    setIntentKey(key());
    const reservation = data?.reservations.find((row) => row.id === reservationId);
    if (reservation && hasQuantity(reservation.allocatableQuantity))
      setQuantity(reservation.allocatableQuantity);
  }
  // Cancelling: the server's plan first, then the command with the same reason.
  async function previewCancellation() {
    if (!data) return;
    setError("");
    try {
      setCancelPreview(await apiJson(`/api/sales/orders/${encodeURIComponent(id)}/cancel-preview`, { method: "POST", body: JSON.stringify({}) }));
    } catch (e) {
      setError(message(e));
    }
  }
  async function cancelOrder() {
    if (!data || !cancelPreview?.allowed || !cancelReason.trim() || inFlight.current) return;
    inFlight.current = true;
    setSaving(true);
    try {
      await apiJson(`/api/sales/orders/${encodeURIComponent(id)}/cancel`, {
        method: "POST",
        body: JSON.stringify({ expectedOrderVersion: data.order.version, reason: cancelReason.trim(), idempotencyKey: intentKey }),
      });
      setIntent("");
      setCancelPreview(null);
      await refresh();
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) { setCancelPreview(null); await refresh(); }
      setError(message(e));
    } finally {
      inFlight.current = false;
      setSaving(false);
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
    if (!data || inFlight.current) return;
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
          // An order placed before customers were chosen keeps its name
          // until someone picks the customer.
          header: {
            ...(editCustomerId ? { customerId: editCustomerId } : { customerName: data.order.customerName }),
            currency: data.order.currency,
            promisedDate: promisedValue(editPromised),
          },
          lines: linesPayload(editLines),
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
        {copy("正在读取正式订单…")}
      </div>
    );
  if (!data)
    return (
      <div role="alert" className="rounded-lg bg-red-50 p-5 text-red-700">
        {copy(error)}
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
  const reservationFacts = (reservationId: string) => {
    const reservation = data.reservations.find((row) => row.id === reservationId);
    if (!reservation) return undefined;
    const line = data.lines.find((row) => row.id === reservation.salesOrderLineId);
    return {
      warehouseId: reservation.warehouseId,
      location: reservation.location,
      sku: reservation.sku || line?.sku,
      unit: line?.unit,
    };
  };
  const previewLookup: OutboundPreviewLookup = {
    place,
    reservation: reservationFacts,
    line: (lineId) => data.lines.find((row) => row.id === lineId),
    unit: (sku) => data.lines.find((row) => row.sku === sku)?.unit,
  };
  const knownWarehouses = new Set(
    [
      ...data.reservations.map((row) => row.warehouseId),
      ...data.movements.map((row) => row.warehouseId),
      ...data.availability.flatMap((row) => row.balances.map((balance) => balance.warehouseId)),
    ].filter(Boolean) as string[],
  );
  const timelinePart = (part: string) => {
    const reservation = reservationFacts(part);
    if (reservation) return place(reservation.warehouseId, reservation.location);
    return knownWarehouses.has(part) ? warehouseName(part) : undefined;
  };
  const lineOptionText = (x: Line) =>
    `${x.sku} · ${x.itemName} · ${say(
      "Ordered {o} / Reserved {r} / Shipped {f} / To reserve {p}",
      "订购 {o} / 预留 {r} / 履约 {f} / 待预留 {p}",
    )
      .replace("{o}", formatQuantity(x.orderedQuantity))
      .replace("{r}", formatQuantity(x.reservedQuantity))
      .replace("{f}", formatQuantity(x.fulfilledQuantity))
      .replace("{p}", x.remainingToReserve == null ? copy("受限") : formatQuantity(x.remainingToReserve))}`;
  const reservationOptionText = (x: Reservation) =>
    `${data.lines.length > 1 && x.sku ? `${x.sku} · ` : ""}${place(x.warehouseId, x.location)} · ${say(
      "Reserved {r} / Allocated {a} / Used {c} / Released {l} / Available {v}",
      "预留 {r} / 已分配 {a} / 已消耗 {c} / 已释放 {l} / 可分配 {v}",
    )
      .replace("{r}", formatQuantity(x.reservedQuantity))
      .replace("{a}", formatQuantity(x.allocatedQuantity))
      .replace("{c}", formatQuantity(x.consumedQuantity))
      .replace("{l}", formatQuantity(x.releasedQuantity))
      .replace("{v}", formatQuantity(x.allocatableQuantity))}`;
  return (
    <div className="space-y-4" data-testid="outbound-order-workbench">
      {error && (
        <div role="alert" className="rounded-lg bg-red-50 p-3 text-red-700">
          {copy(error)}
        </div>
      )}
      {data.scopeCoverage.status === "partial" && (
        <div
          role="status"
          className="rounded-lg bg-amber-50 p-3 text-amber-800"
        >
          {copy("当前页面仅显示您有权查看的仓库数据，部分库存或履约事实已隐藏。")}
        </div>
      )}
      {((a.blockingReasonCodes as string[]) || []).includes(
        "OUTBOUND_CAPABILITY_NOT_AVAILABLE",
      ) && (
        <div
          role="status"
          className="rounded-lg bg-slate-100 p-3 text-slate-700"
        >
          {copy("当前销售订单写入能力未启用，页面保持只读。")}
        </div>
      )}
      <section className="rounded-xl border bg-white p-5">
        <div className="flex flex-wrap justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold">{data.order.orderNumber}</h1>
            <p className="mt-1 text-sm text-slate-500">
              {/* The order version is an internal edit counter, so it is not shown. */}
              {data.order.customerName} · {data.order.currency} · {stamp(data.order.updatedAt)}
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
                testId="open-edit"
                disabled={saving}
                onClick={() => start("edit")}
              >
                {copy("编辑草稿")}
              </Button>
            )}
            {a.canConfirm && (
              <Button
                disabled={saving}
                testId="confirm-sales-order"
                onClick={() => void lifecycle("confirm")}
              >
                {copy("确认订单")}
              </Button>
            )}
            {a.canHold && (
              <Button
                tone="secondary"
                disabled={saving}
                onClick={() => void lifecycle("hold")}
              >
                {copy("暂停订单")}
              </Button>
            )}
            {a.canResume && (
              <Button
                disabled={saving}
                onClick={() => void lifecycle("resume")}
              >
                {copy("恢复")}
              </Button>
            )}
            {a.canCancel && (
              <Button tone="secondary" testId="open-cancel-order" onClick={() => { start("cancel"); setCancelReason(""); setCancelPreview(null); }}>
                {say("Cancel order", "取消订单")}
              </Button>
            )}
            {a.canReserve && (
              <Button testId="open-reserve" onClick={() => start("reserve")}>
                {copy("预留库存")}
              </Button>
            )}
            {a.canRelease && (
              <Button tone="secondary" onClick={() => start("release")}>
                {copy("释放预留")}
              </Button>
            )}
            {a.canCreateShipment && (
              <Button
                testId="open-shipment-draft"
                onClick={() => start("shipment")}
              >
                {copy("创建发货草稿")}
              </Button>
            )}
            {/* An invoice covers shipped goods, so it waits for a posted shipment. */}
            {data.shipments.some((shipment) => shipment.postingStatus === "posted") && (
              <CreateInvoiceAction salesOrderId={id} />
            )}
            <Button tone="secondary" onClick={() => void refresh()} ariaLabel="刷新销售订单">
              <RefreshCw size={15} />
            </Button>
          </div>
        </div>
      </section>
      <Section title={copy("关联记录")}>
        <div className="flex flex-wrap gap-2">
          {data.smartLinks.map((link) =>
            link.enabled ? (
              <Link
                data-testid={`smart-link-${link.targetType}`}
                className="rounded-lg border px-3 py-2 text-sm text-blue-700 outline-offset-2 focus-visible:outline"
                to={smartLinkPath(link)}
                key={link.id}
              >
                {copy(link.label)} {link.count ?? ""}
              </Link>
            ) : (
              <span
                aria-disabled="true"
                title={link.unavailableReason ? copy(link.unavailableReason) : ""}
                className="rounded-lg border px-3 py-2 text-sm text-slate-400"
                key={link.id}
              >
                {copy(link.label)} {link.count ?? ""}
                <span className="ml-1 text-xs">{link.unavailableReason ? copy(link.unavailableReason) : ""}</span>
              </span>
            ),
          )}
        </div>
      </Section>
      <Section title={copy("订单行与库存可用性")}>
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
                    {copy(x)}
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
                      <BusinessEntityLink entityType="item" entityId={line.itemId}>
                        {line.sku}
                      </BusinessEntityLink>
                      <div className="text-xs text-slate-500">
                        {line.itemName}
                      </div>
                      <div
                        className={`text-xs ${line.unitPrice == null ? "text-amber-700" : "text-slate-500"}`}
                        data-testid="sales-order-line-price"
                      >
                        {line.unitPrice == null
                          ? say("No unit price, cannot be invoiced", "未定价，无法开票")
                          : `${say("Unit price", "单价")} ${formatQuantity(line.unitPrice)} ${data.order.currency}`}
                      </div>
                    </td>
                    {[
                      line.orderedQuantity,
                      line.reservedQuantity,
                      line.fulfilledQuantity,
                      line.remainingToReserve ?? null,
                      line.remainingToFulfill ?? null,
                      av?.totalOnHand,
                      av?.totalReserved,
                      av?.totalAvailable,
                    ].map((v, i) => (
                      <td className="p-2 tabular-nums" key={i}>
                        {v == null ? (i === 3 || i === 4 ? copy("受限") : "—") : formatQuantity(v)}
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
              <span>{warehouseName(b.warehouseId)}</span>
              <span>{b.location || copy("默认库位")}</span>
              <span>{copy("现有 {n}").replace("{n}", formatQuantity(b.onHandQuantity))}</span>
              <span>{copy("预留 {n}").replace("{n}", formatQuantity(b.reservedQuantity))}</span>
              <span>{copy("可用 {n}").replace("{n}", formatQuantity(b.availableQuantity))}</span>
              <span>{copy(b.selectable ? "可操作" : "只读")}</span>
            </div>
          ))}
      </Section>
      <Section id="reservations" title={copy("预留记录")}>
        <Table
          rows={data.reservations.map((x) => [
            shortId(x.id),
            warehouseName(x.warehouseId),
            x.location || copy("默认库位"),
            formatQuantity(x.reservedQuantity),
            formatQuantity(x.allocatedQuantity),
            formatQuantity(x.consumedQuantity),
            formatQuantity(x.releasedQuantity),
            formatQuantity(x.allocatableQuantity),
            status(x.status),
          ])}
          headers={[
            "预留 ID",
            "仓库",
            "库位",
            "预留量",
            "已分配",
            "已消耗",
            "已释放",
            "可释放",
            "状态",
          ]}
        />
      </Section>
      <Section id="shipments" title={copy("发货单")}>
        <div className="space-y-2">
          {data.shipments.map((x) => (
            <Link
              data-testid={`shipment-${x.id}`}
              className="flex justify-between rounded-lg border p-3 text-sm text-blue-700"
              to={`/app/sales/shipments/${encodeURIComponent(x.id)}`}
              key={x.id}
            >
              <span>{x.shipmentNumber}</span>
              <span>{status(shipmentStatus(x))}</span>
            </Link>
          ))}
          {!data.shipments.length && (
            <p className="text-sm text-slate-500">{copy("暂无发货单。")}</p>
          )}
        </div>
      </Section>
      <Section id="movements" title={copy("库存流水")}>
        <Table
          rows={data.movements.map((x) => [
            shortId(x.id),
            x.sku,
            warehouseName(x.warehouseId),
            formatQuantity(x.quantityIn),
            formatQuantity(x.quantityOut),
            movementTypeLabel(x.movementType, activeLanguage),
          ])}
          headers={["流水 ID", "SKU", "仓库", "入", "出", "类型"]}
        />
      </Section>
      <Section id="evidence" title={copy("订单证据与时间线")}>
        <Timeline rows={data.evidence} resolve={timelinePart} />
      </Section>
      <Section id="reconciliation" title={copy("履约一致性检查")}>
        <div className="mb-2 flex items-center gap-2">
          <CheckCircle2 size={17} />
          <Badge value={data.reconciliation.status} />
        </div>
        {data.reconciliation.reasonCode === "PARTIAL_WAREHOUSE_SCOPE" && (
          <p className="mb-2 text-sm text-amber-700">
            {copy("完整订单对账无法在当前权限范围内确认。")}
          </p>
        )}
        {data.reconciliation.checks.map((x) => (
          <div
            className="border-t py-2 text-xs"
            key={`${x.affectedEntity.type}-${x.affectedEntity.id}`}
          >
            {reconciliationRuleLabel(x.rule)} · {status(x.status)} ·{" "}
            {copy("计算 {calculated} / 记录 {recorded}")
              .replace("{calculated}", formatQuantity(x.calculated))
              .replace("{recorded}", formatQuantity(x.recorded))}
          </div>
        ))}
      </Section>
      {intent && (
        <ActionDialog
          title={
            intent === "cancel"
              ? say("Cancel sales order", "取消销售订单")
              : intent === "edit"
              ? copy("编辑销售订单草稿")
              : intent === "reserve"
                ? say("Reserve inventory", "预留库存")
                : intent === "release"
                  ? say("Release reservation", "释放预留")
                  : say("Create delivery draft", "创建发货草稿")
          }
          onClose={() => {
            setIntent("");
            setPreview(null);
            setCancelPreview(null);
          }}
        >
          {intent === "cancel" ? (
            <div data-testid="cancel-order-panel">
              <p className="text-sm text-slate-600">
                {say("Cancelling releases every reservation on this order and cancels its unposted shipments. An order with goods shipped cannot be cancelled.", "取消订单会释放该订单的全部预留并取消未过账的发货单；已有发货过账的订单不能取消。")}
              </p>
              <label className="mt-3 block text-sm">
                {say("Reason", "原因")}
                <input
                  data-testid="cancel-order-reason"
                  aria-label={say("Reason for cancelling", "取消原因")}
                  className="mt-1 w-full rounded-lg border p-2"
                  value={cancelReason}
                  onChange={(e) => { setCancelReason(e.target.value); setIntentKey(key()); }}
                />
              </label>
              {cancelPreview && (
                <div data-testid="cancel-order-preview" className={`mt-3 rounded-lg border p-3 text-xs ${cancelPreview.allowed ? "bg-emerald-50" : "bg-amber-50"}`}>
                  <div className="font-semibold">{cancelPreview.allowed ? say("The order can be cancelled", "可以取消该订单") : say("The order cannot be cancelled", "该订单不能取消")}</div>
                  {cancelPreview.blockingIssues.map((issue) => <div className="mt-1 text-red-700" key={issue.code}>{issue.message}</div>)}
                  {cancelPreview.allowed && (
                    <div className="mt-2">
                      {say("Releases {q} reserved across {r} reservations; cancels {s} unposted shipments.", "释放预留 {q}（{r} 条预留），取消未过账发货单 {s} 张。")
                        .replace("{q}", formatQuantity(cancelPreview.releasedQuantity))
                        .replace("{r}", String(cancelPreview.reservationImpacts.length))
                        .replace("{s}", String(cancelPreview.shipmentImpacts.length))}
                    </div>
                  )}
                </div>
              )}
              <div className="mt-4 flex gap-2">
                <Button testId="cancel-order-preview-button" disabled={saving} onClick={() => void previewCancellation()}>
                  {say("Preview", "预览")}
                </Button>
                <Button testId="confirm-cancel-order" disabled={!cancelPreview?.allowed || !cancelReason.trim() || saving} onClick={() => void cancelOrder()}>
                  {saving ? say("Cancelling…", "正在取消…") : say("Cancel order", "取消订单")}
                </Button>
              </div>
            </div>
          ) : intent === "edit" ? (
            <>
              {!editEntry ? (
                <div className="text-sm text-slate-500">{say("Loading…", "正在读取…")}</div>
              ) : (
                <div className="space-y-3" data-testid="sales-order-edit-form">
                  <div className="grid gap-3 md:grid-cols-2">
                    <CustomerField
                      customers={editEntry.customers || []}
                      value={editCustomerId}
                      onChange={(customer) => {
                        setEditCustomerId(customer?.id || "");
                        setIntentKey(key());
                      }}
                      ariaLabel={say("Edit customer", "编辑客户")}
                    />
                    <label className="text-sm">
                      {say("Promised date (optional)", "承诺交期（可选）")}
                      <input
                        type="date"
                        aria-label={say("Edit promised date", "编辑承诺交期")}
                        className="mt-1 w-full rounded-lg border p-2"
                        value={editPromised}
                        onChange={(e) => {
                          setEditPromised(e.target.value);
                          setIntentKey(key());
                        }}
                      />
                    </label>
                  </div>
                  {!editCustomerId && (
                    <p className="text-xs text-amber-700">
                      {say(
                        `This order was entered for "${data.order.customerName}". Choose the customer from Customers to link it.`,
                        `该订单录入的客户为“${data.order.customerName}”。请从客户中选择以建立关联。`,
                      )}
                    </p>
                  )}
                  <OrderLinesField
                    items={editEntry.items}
                    lines={editLines}
                    currency={data.order.currency}
                    onChange={(next) => {
                      setEditLines(next);
                      setIntentKey(key());
                    }}
                  />
                </div>
              )}
              <div className="mt-4">
                <Button disabled={saving || !editEntry || !linesReady(editLines)} onClick={() => void reviseDraft()}>
                  {saving ? copy("保存中…") : copy("保存修订")}
                </Button>
              </div>
            </>
          ) : (
            <>
              {(intent === "reserve" || intent === "shipment") && (
                <label className="block text-sm">
                  {copy("订单行")}
                  <select
                    aria-label={copy("销售订单行")}
                    className="mt-1 w-full rounded-lg border p-2"
                    value={selectedLineId}
                    onChange={(e) => chooseLine(e.target.value)}
                  >
                    <option value="">{copy("请选择订单行")}</option>
                    {lineOptions.map((x) => (
                      <option value={x.id} key={x.id}>
                        {lineOptionText(x)}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {intent === "reserve" && (
                <label className="mt-3 block text-sm">
                  {copy("仓库 / 库位")}
                  <select
                    aria-label={copy("库存余额")}
                    className="mt-1 w-full rounded-lg border p-2"
                    value={selectedBalanceId}
                    onChange={(e) => {
                      setSelectedBalanceId(e.target.value);
                      setPreview(null);
                      setIntentKey(key());
                    }}
                  >
                    <option value="">{copy("请选择库存余额")}</option>
                    {balanceOptions.map((x) => (
                      <option disabled={!x.selectable} value={x.id} key={x.id}>
                        {place(x.warehouseId, x.location)} ·{" "}
                        {copy("现有 {n}").replace("{n}", formatQuantity(x.onHandQuantity))} /{" "}
                        {copy("预留 {n}").replace("{n}", formatQuantity(x.reservedQuantity))} /{" "}
                        {copy("可用 {n}").replace("{n}", formatQuantity(x.availableQuantity))}
                        {x.selectable ? "" : ` · ${copy("只读")}`}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {(intent === "release" || intent === "shipment") && (
                <label className="mt-3 block text-sm">
                  {copy("预留记录")}
                  <select
                    aria-label={copy("预留记录")}
                    className="mt-1 w-full rounded-lg border p-2"
                    value={selectedReservationId}
                    onChange={(e) => chooseReservation(e.target.value)}
                  >
                    <option value="">{copy("请选择预留记录")}</option>
                    {reservationOptions.map((x) => (
                      <option value={x.id} key={x.id}>
                        {reservationOptionText(x)}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <label className="mt-3 block text-sm">
                {copy("数量")}
                <input
                  aria-label={copy("交易数量")}
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
                  {copy("发货单号")}
                  <input
                    aria-label={copy("发货单号")}
                    className="mt-1 w-full rounded-lg border p-2"
                    value={shipmentNumber}
                    onChange={(e) => {
                      setShipmentNumber(e.target.value);
                      setPreview(null);
                      setIntentKey(key());
                    }}
                  />
                </label>
              )}
              {intent === "release" && (
                <label className="mt-3 block text-sm">
                  {copy("原因")}
                  <input
                    aria-label={copy("释放原因")}
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
                <PreviewView preview={preview} lookup={previewLookup} />
              ) : (
                <p className="mt-3 text-xs text-slate-500">{previewHint()}</p>
              )}
              <div className="mt-4 flex gap-2">
                <Button
                  testId="outbound-preview"
                  disabled={saving}
                  onClick={() => void loadPreview()}
                >
                  {say("Preview", "预览")}
                </Button>
                <Button
                  testId="confirm-outbound-action"
                  disabled={!preview?.allowed || saving}
                  onClick={() => void execute()}
                >
                  {saving
                    ? copy("处理中…")
                    : intent === "reserve"
                      ? say("Reserve", "确认预留")
                      : intent === "release"
                        ? say("Release", "确认释放")
                        : say("Create delivery draft", "创建发货草稿")}
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
  const stamp = useStamp();
  const warehouseName = useWarehouseNames();
  const place = usePlace();
  const [data, setData] = useState<ShipmentWorkbench | null>(null),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true),
    [preview, setPreview] = useState<Preview | null>(null),
    [intent, setIntent] = useState(""),
    [intentKey, setIntentKey] = useState(""),
    [reason, setReason] = useState(() => copy("业务冲销")),
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
        {copy("正在读取发货单…")}
      </div>
    );
  if (!data) return <div role="alert">{copy(error)}</div>;
  // A reservation on this shipment by its warehouse and location; its SKU and
  // unit are known when the shipment has one line.
  const onlyLine = data.lines.length === 1 ? data.lines[0] : undefined;
  const reservationFacts = (reservationId: string) => {
    const allocation = data.allocations.find((row) => row.reservationId === reservationId);
    return allocation
      ? { warehouseId: allocation.warehouseId, location: allocation.location, sku: onlyLine?.sku, unit: onlyLine?.unit }
      : undefined;
  };
  const previewLookup: OutboundPreviewLookup = {
    place,
    reservation: reservationFacts,
    unit: (sku) => data.lines.find((row) => row.sku === sku)?.unit,
  };
  const knownWarehouses = new Set(
    [...data.allocations.map((row) => row.warehouseId), ...data.movements.map((row) => row.warehouseId)].filter(
      Boolean,
    ) as string[],
  );
  const timelinePart = (part: string) => {
    const reservation = reservationFacts(part);
    if (reservation) return place(reservation.warehouseId, reservation.location);
    return knownWarehouses.has(part) ? warehouseName(part) : undefined;
  };
  const postedAt = data.shipment.postedAt ? stamp(data.shipment.postedAt) : "—",
    reversedAt = data.shipment.reversedAt ? stamp(data.shipment.reversedAt) : "—";
  return (
    <div className="space-y-4" data-testid="shipment-workbench">
      {error && (
        <div role="alert" className="rounded-lg bg-red-50 p-3 text-red-700">
          {copy(error)}
        </div>
      )}
      <section className="rounded-xl border bg-white p-5">
        <div className="flex flex-wrap justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold">
              {data.shipment.shipmentNumber}
            </h1>
            {/* The shipment version is an internal edit counter, so it is not shown. */}
            <p className="text-sm text-slate-500" data-testid="shipment-sales-order">
              {say("Sales order", "销售订单")}{" "}
              <Link
                className="text-blue-600 underline"
                to={`/app/sales/orders/${encodeURIComponent(data.shipment.salesOrderId)}`}
              >
                {data.salesOrder.orderNumber}
              </Link>
            </p>
            <div className="mt-2 flex gap-2" data-testid="shipment-status">
              <Badge value={shipmentStatus(data.shipment)} />
            </div>
            <p className="mt-2 text-xs text-slate-500" data-testid="shipment-posting-dates">
              {say("Posted {posted} · Reversed {reversed}", "过账 {posted} · 冲销 {reversed}")
                .replace("{posted}", postedAt)
                .replace("{reversed}", reversedAt)}
              {data.shipment.reversalReason
                ? ` · ${say("Reason: {reason}", "原因：{reason}").replace("{reason}", data.shipment.reversalReason)}`
                : ""}
            </p>
          </div>
          <div className="flex gap-2">
            {data.availableActions.canCancel && (
              <Button tone="secondary" onClick={() => start("cancel")}>
                {copy("取消草稿")}
              </Button>
            )}
            {data.availableActions.canPost && (
              <Button testId="open-post" onClick={() => start("post")}>
                {copy("过账发货")}
              </Button>
            )}
            {data.availableActions.canReverse && (
              <Button
                testId="open-reverse"
                tone="danger"
                onClick={() => start("reverse")}
              >
                {copy("冲销发货")}
              </Button>
            )}
            {data.shipment.postingStatus === "posted" && (
              <CreateInvoiceAction shipmentId={id} />
            )}
          </div>
        </div>
      </section>
      <Section title={copy("发货行")}>
        <Table
          headers={["SKU / 物料", "请求数量", "已过账", "单位"]}
          rows={data.lines.map((x) => [
            `${x.sku} · ${x.itemName}`,
            formatQuantity(x.requestedQuantity),
            formatQuantity(x.postedQuantity),
            x.unit,
          ])}
        />
      </Section>
      <Section title={copy("分配与库存流水")}>
        <Table
          headers={[
            "预留 ID",
            "仓库",
            "库位",
            "数量",
            "状态",
            "出库流水",
            "冲销流水",
          ]}
          rows={data.allocations.map((x) => [
            shortId(x.reservationId),
            warehouseName(x.warehouseId),
            x.location || copy("默认库位"),
            formatQuantity(x.quantity),
            status(x.status),
            x.movementLink ? shortId(x.movementLink) : "—",
            x.reversalMovementLink ? shortId(x.reversalMovementLink) : "—",
          ])}
        />
        {data.movements.map((x) => (
          <div className="mt-2 rounded-lg bg-slate-50 p-2 text-xs" data-testid="shipment-movement" key={x.id}>
            {shortId(x.id)} · {movementTypeLabel(x.movementType, activeLanguage)} · {x.itemName} ·{" "}
            {place(x.warehouseId, x.location)} · {copy("入")}{" "}
            {formatQuantity(x.quantityIn)} / {copy("出")} {formatQuantity(x.quantityOut)}
          </div>
        ))}
      </Section>
      <Section title={copy("发货证据与时间线")}>
        <Timeline rows={data.evidence} resolve={timelinePart} />
      </Section>
      <Section title={copy("一致性检查与辅助说明")}>
        <div className="flex items-center gap-2">
          <ShieldCheck size={18} />
          <Badge value={data.reconciliation.status} />
          <span className="text-sm">{copy(data.aiExplain.conclusion)}</span>
        </div>
      </Section>
      {intent && (
        <ActionDialog
          title={
            intent === "post"
              ? say("Post shipment", "发货过账确认")
              : intent === "reverse"
                ? say("Reverse shipment", "发货冲销确认")
                : say("Cancel delivery draft", "取消发货草稿")
          }
          onClose={() => {
            setIntent("");
            setPreview(null);
          }}
        >
          {intent !== "post" && (
            <label className="text-sm">
              {copy("原因")}
              <input
                aria-label={copy("操作原因")}
                className="mt-1 w-full rounded-lg border p-2"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
            </label>
          )}
          {preview ? (
            <PreviewView preview={preview} lookup={previewLookup} />
          ) : (
            <p className="mt-3 text-xs text-slate-500">{previewHint()}</p>
          )}
          <div className="mt-4 flex gap-2">
            <Button
              testId="shipment-preview"
              onClick={() => void loadPreview()}
            >
              {say("Preview", "预览")}
            </Button>
            <Button
              testId="confirm-shipment-action"
              disabled={!preview?.allowed || saving}
              onClick={() => void execute()}
            >
              {saving
                ? copy("处理中…")
                : intent === "post"
                  ? say("Post shipment", "过账发货")
                  : intent === "reverse"
                    ? say("Reverse shipment", "冲销发货")
                    : say("Cancel delivery draft", "取消发货草稿")}
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
                {copy(x)}
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
      {!rows.length && <p className="p-4 text-sm text-slate-500">{copy("暂无记录。")}</p>}
    </div>
  );
}
// The workbench API builds reservation and movement timeline titles when it is
// read (they are not stored); they are translated here like its other labels.
// Its summaries name a reservation or warehouse by id, so each such part is
// shown by its warehouse name and location instead. Audit summaries are shown
// as recorded.
function Timeline({
  rows,
  resolve,
}: {
  rows: Workbench["evidence"];
  resolve?: (part: string) => string | undefined;
}) {
  const stamp = useStamp();
  const summary = (value: string) =>
    String(value || "")
      .split(" · ")
      .map((part) =>
        part === "未指定仓库"
          ? say("No warehouse", "未指定仓库")
          : resolve?.(part) ?? (/^-?\d+(\.\d+)?$/.test(part) ? formatQuantity(part) : part),
      )
      .join(" · ");
  return (
    <div className="space-y-2" data-testid="outbound-timeline">
      {rows.map((x, i) => (
        <div
          className="border-l-2 border-blue-200 pl-3 text-sm"
          key={`${x.eventType}-${x.entityId}-${i}`}
        >
          <div className="font-semibold">{copy(x.title)}</div>
          <div className="text-xs text-slate-500">
            {stamp(x.occurredAt)}
            {x.summary && x.summary !== x.title ? ` · ${summary(x.summary)}` : ""}
          </div>
          {x.commandExecutionId && (
            <div className="text-[11px] text-slate-400">
              {copy("命令记录")} {x.commandExecutionId} · {copy("幂等键")} {x.idempotencyKey}
            </div>
          )}
        </div>
      ))}
      {!rows.length && <p className="text-sm text-slate-500">{copy("暂无证据事件。")}</p>}
    </div>
  );
}
const previewHint = () =>
  say("Preview first to see what will change.", "请先预览，查看将发生的变更。");
// What the server's preview will do, in plain sentences built from the
// preview itself. Why it is blocked, when it is. The impact counts stay
// available under "Technical details".
function PreviewView({ preview, lookup }: { preview: Preview; lookup: OutboundPreviewLookup }) {
  const sentences = outboundPreviewSentences(activeLanguage, preview, lookup);
  return (
    <div
      data-testid="outbound-preview-result"
      className={`mt-3 rounded-lg border p-3 text-sm ${preview.allowed ? "bg-emerald-50" : "bg-amber-50"}`}
    >
      <div className="font-semibold">
        {preview.allowed ? say("What will happen", "将发生的变更") : say("This can't be done yet", "暂时无法执行")}
      </div>
      {preview.blockingIssues.map((x, i) => (
        <div className="mt-1 text-red-700" key={`${x.code}-${i}`}>
          {issueMessage(x)}
        </div>
      ))}
      {sentences.map((sentence, i) => (
        <p className="mt-1" data-testid="outbound-preview-sentence" key={i}>
          {sentence}
        </p>
      ))}
      <details className="mt-2 text-xs text-slate-500">
        <summary className="cursor-pointer">{say("Technical details", "技术细节")}</summary>
        <div className="mt-1">
          {say(
            "Stock balances changed {b} · Reservations changed {r} · Order lines changed {l}",
            "库存余额变更 {b} · 预留变更 {r} · 订单行变更 {l}",
          )
            .replace("{b}", String(preview.balanceImpacts.length))
            .replace("{r}", String(preview.reservationImpacts.length))
            .replace("{l}", String(preview.salesOrderLineImpacts.length))}
        </div>
      </details>
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
      className="fc-overlay-enter fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4"
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      <div className="fc-dialog-enter max-h-[90vh] w-full max-w-xl overflow-auto rounded-xl bg-white p-5 shadow-xl">
        <div className="mb-4 flex justify-between">
          <h2 className="font-semibold">{title}</h2>
          <button aria-label={copy("关闭")} onClick={onClose}>
            ×
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
