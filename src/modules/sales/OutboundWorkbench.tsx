import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router";
import {
  AlertTriangle,
  CheckCircle2,
  Loader2,
  PackageOpen,
  PauseCircle,
  Plus,
  RefreshCw,
  ShieldCheck,
  ShoppingCart,
  Sparkles,
  Truck,
  X,
  FilePlus2,
} from "lucide-react";
import { toast } from "sonner";
import { useDetailCrumb } from "../../components/navigation/detailCrumb";
import { useRouteAvailability } from "../../app/routeAvailability";
import { usePermissionSet } from "../../lib/usePermissionSet";
import { CustomerPicker } from "./CustomerPicker";
import { foldReservationAudits, timelineSummary, type TimelineLookup } from "./outboundTimeline";
import {
  INVOICING_STATES,
  invoicingProgressText,
  invoicingState,
  lineShortfall,
  paymentTermsLabel,
  plainQuantity,
  quantityUnits,
  quantityWithUnit,
  smallerQuantity,
  unitsToPlain,
} from "./salesOrderFacts";
import { ApiError, apiJson } from "../../lib/api-client";
import { useI18n } from "../../i18n/I18n";
import { workspaceCopy } from "../../i18n/workspaceCopy";
import { outboundEnglish } from "./outboundCopy";
import { outboundPreviewSentences, type OutboundPreviewLookup } from "./outboundPreviewText";
import { formatCalendarDay, formatLocaleAmount, formatQuantity } from "../../lib/format";
import { movementTypeLabel } from "../../i18n/statusLabels";
import { unitLabel } from "../../i18n/unitLabels";
import { createSecureClientMutationId } from "../../lib/client-id";
import { useWorkspaceCurrency } from "../../lib/useWorkspaceCurrency";
import { COMMON_CURRENCIES, orderedCurrencyCodes } from "../../lib/currencyOptions";
import { BusinessEntityLink } from "../../components/business/BusinessEntityLink";
import { useWarehouseNames } from "../../lib/useWarehouseNames";
import {
  tableBodyTextClass,
  tableLinkClass,
  tableMinSmClass,
  tableScrollClass,
  tdActionClass,
  tdIdClass,
  tdNowrapClass,
  tdNumericClass,
  tdNumericRightClass,
  thClass,
  thRightClass,
} from "../../components/ui/workbenchTable";
import { A, Field, inputStyle } from "../../components/ui";
import { FormActionBar, FormHeader, FormLineCard, FormSection, focusFirstInvalid, formGridClass, useFormCopy } from "../../components/ui/formLayout";
import { FocusFirstField } from "../../components/ui/FocusFirstField";
import { useConfirm } from "../../components/ui/ConfirmDialog";
import { ActionableMetricCard } from "../../components/cards/ActionableMetricCard";
import { ListCard, ListSearchCard, RefreshButton, ResetButton, StatusChip, listButtonClass, listHeadRowStyle, listRowClass, listRowStyle, listTableCardsRef, rowActionClass, statusToneOf } from "../../components/ui/listLayout";
import { ListPager, usePagedRows } from "../procurement/listPaging";
import { SALES_ORDER_STAGES, salesOrderStage, salesOrderStageHint } from "./salesOrderStatus";

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
  // How much of the order's shipped goods customer invoices bill; null for a
  // reader who may not read customer invoices (sales-order-workbench-service.mjs).
  invoicedQuantity?: string | null;
  // The list sends each order's lines, for its amount and unit.
  lines?: Array<Pick<Line, "orderedQuantity" | "unitPrice"> & { unit?: string | null }>;
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
  // Billed by customer invoices that hold its shipments; null without
  // customer invoice access (outbound-workbench-read-service.mjs).
  invoicedQuantity?: string | null;
  version: number;
};
// A customer invoice on the order or shipment, for a reader who may read them.
type InvoiceRef = { id: string; invoiceNumber: string; status: string; paymentStatus?: string | null; shipmentId: string };
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
  createdAt?: string | null;
};
type ReconciliationCheck = {
  status: string;
  rule: string;
  calculated: string;
  recorded: string;
  affectedEntity: { type: string; id: string };
  evidenceLinks?: Array<{ type: string; id: string }>;
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
  // Null for a reader who may not read customer invoices.
  invoices?: InvoiceRef[] | null;
  movements: Array<{
    id: string;
    movementType: string;
    sku: string;
    itemName?: string | null;
    warehouseId?: string;
    location?: string;
    quantityIn: string;
    quantityOut: string;
    // The shipment the movement posted or reversed.
    sourceDocumentId?: string | null;
    occurredAt?: string | null;
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
    checks: ReconciliationCheck[];
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
    invoicedQuantity?: string | null;
    unit: string;
  }>;
  invoices?: InvoiceRef[] | null;
  // A customer invoice holds this shipment, so it can no longer be reversed.
  reversalBlockedByInvoice?: boolean;
  allocations: Array<{
    id: string;
    reservationId: string;
    sku?: string | null;
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
  "draft": "草稿",
  "confirmed": "已确认",
  "on_hold": "暂停",
  "ready": "待过账",
  "cancelled": "已取消",
  "unposted": "未过账",
  "posted": "已过账",
  "reversed": "已冲销",
  "not_reserved": "未预留",
  "partially_reserved": "部分预留",
  "fully_reserved": "已预留",
  "not_fulfilled": "未履约",
  "partially_fulfilled": "部分履约",
  "fully_fulfilled": "已履约",
  "matched": "一致",
  "mismatch": "不一致",
  "unavailable": "不可用",
  // Reservation and shipment allocation statuses.
  "active": "有效",
  "allocated": "已分配",
  "partially_allocated": "部分分配",
  "partially_consumed": "部分消耗",
  "consumed": "已消耗",
  "released": "已释放",
  "deallocated": "已取消分配",
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
// Records are named by their document numbers (SO-…, DN-…) or by what they
// hold (SKU, warehouse); stored ids, whole or shortened, are never shown.
//
// An order can have hundreds of lines, and each line its own reservation,
// movement and checks. A list repeated per line shows its first few rows and
// a "Show all" button, so the page stays readable and every row stays one
// click away.
const FEW_ROWS = 5;
function Collapsible({
  total,
  few = FEW_ROWS,
  testId,
  children,
}: {
  total: number;
  few?: number;
  testId?: string;
  children: (count: number) => React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const count = open ? total : Math.min(total, few);
  return (
    <>
      {children(count)}
      {total > few && (
        <div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-slate-500" data-testid={testId}>
          <span>{say(`Showing ${count} of ${total}`, `显示 ${count} / ${total} 条`)}</span>
          <button type="button" aria-expanded={open} className="font-semibold text-blue-600 hover:underline" onClick={() => setOpen(!open)}>
            {open ? say("Show fewer", "收起") : say(`Show all ${total}`, `显示全部 ${total} 条`)}
          </button>
        </div>
      )}
    </>
  );
}
// An order's own lines (an order can hold 169) draw 50 at a time with the
// shared pager; on a phone each line is a card, so all of them at once made
// the page tens of thousands of pixels tall.
const LINE_PAGE_SIZE = 50;
function PagedRows<T>({ rows, resetKey, testId, children }: { rows: T[]; resetKey: string; testId?: string; children: (pageRows: T[]) => React.ReactNode }) {
  const paged = usePagedRows(rows, LINE_PAGE_SIZE, resetKey);
  return (
    <>
      {children(paged.pageRows)}
      {rows.length > LINE_PAGE_SIZE && <ListPager page={paged.page} pageSize={LINE_PAGE_SIZE} total={rows.length} onPage={paged.setPage} testId={testId} />}
    </>
  );
}
const hasQuantity = (value?: string | null) => Number(value) > 0;
// A stored four-decimal value ("12.5000") as an exact count of ten-thousandths;
// null when there is no value.
const decimalUnits = (value?: string | null) => {
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(String(value ?? "").trim());
  if (!match) return null;
  const units = BigInt(match[2]) * 10000n + BigInt(`${match[3] || ""}0000`.slice(0, 4));
  return match[1] ? -units : units;
};
const unitsText = (units: bigint) => {
  const absolute = units < 0n ? -units : units;
  return `${units < 0n ? "-" : ""}${absolute / 10000n}.${String(absolute % 10000n).padStart(4, "0")}`;
};
// The order total from its lines: ordered quantity times unit price, summed
// exactly and rounded to cents only for display. A line without a unit price
// is counted as unpriced, never as zero.
function orderTotal(lines: Array<Pick<Line, "orderedQuantity" | "unitPrice">>) {
  let total = 0n,
    priced = 0;
  for (const line of lines) {
    const price = decimalUnits(line.unitPrice),
      quantity = decimalUnits(line.orderedQuantity);
    if (price === null || quantity === null) continue;
    total += price * quantity;
    priced += 1;
  }
  // price × quantity is in 1e-8 units; 1e6 of them make a cent.
  const absolute = total < 0n ? -total : total,
    cents = (absolute + 500000n) / 1000000n;
  return { amount: (total < 0n ? -1 : 1) * (Number(cents) / 100), priced, unpriced: lines.length - priced };
}
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
  "available = onHand - reserved": "可用量 = 在手量 - 预留量",
  "reserved + fulfilled <= ordered": "预留量 + 已履约量不超过订购量",
  "reservation quantities reconcile": "预留的消耗、释放与分配不超过预留量",
  "posted quantity = posting movements - reversals": "发货过账数量与库存流水一致",
};
// What a check compared, in plain words. The server's two quantities are
// shown as they are; only the wording around them depends on the rule.
const reconciliationFacts = (check: { rule: string; calculated: string; recorded: string }) => {
  const c = formatQuantity(check.calculated),
    r = formatQuantity(check.recorded);
  switch (check.rule) {
    case "available = onHand - reserved":
      return say(`On hand minus reserved: ${c} · Recorded as available: ${r}`, `在手减预留：${c} · 记录的可用量：${r}`);
    case "reserved + fulfilled <= ordered":
      return say(`Reserved and shipped: ${c} of ${r} ordered`, `已预留和已发货：${c}，订购 ${r}`);
    case "reservation quantities reconcile":
      return say(`Used, released and allocated: ${c} of ${r} reserved`, `已消耗、已释放和已分配：${c}，预留 ${r}`);
    case "posted quantity = posting movements - reversals":
      return say(`Shipped by stock movements: ${c} · Posted on the shipment: ${r}`, `库存流水出库：${c} · 发货单过账：${r}`);
    default:
      return say(`Worked out: ${c} · Recorded: ${r}`, `计算结果：${c} · 记录：${r}`);
  }
};
const reconciliationRuleLabel = (value: string) =>
  reconciliationRuleLabels[value] ? copy(reconciliationRuleLabels[value]) : value;
// Timestamps follow the workspace locale and timezone.
function useStamp() {
  const { formatDateTime } = useI18n();
  return (value?: string | null) =>
    value && !Number.isNaN(new Date(value).getTime()) ? formatDateTime(value) : value || "—";
}
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
  if (codeMessages[error.code || ""]) return codeMessages[error.code || ""];
  if (error.status === 404 || /_NOT_FOUND$/.test(error.code || "")) return "未找到该记录，可能已被删除。";
  if (error.status === 409) return "记录已被他人修改，请刷新后重试。";
  return "操作未完成，请刷新后重试。";
}
// A preview's blocking issue in the interface language when its code is known;
// otherwise the server's message as sent.
const issueMessage = (issue: { code: string; message: string }) =>
  codeMessages[issue.code] ? copy(codeMessages[issue.code]) : issue.message;
const codeMessages: Record<string, string> = {
  "PERMISSION_DENIED": "当前角色只能查看，不能执行此操作。",
  "WAREHOUSE_SCOPE_DENIED": "当前账号没有相关仓库权限。",
  "SALES_ORDER_ON_HOLD": "销售订单当前已暂停，不能执行发货过账。请先恢复订单。",
  "OUTBOUND_CAPABILITY_NOT_AVAILABLE":
    "当前销售订单写入能力未启用，页面保持只读。",
  "SALES_ORDER_VERSION_CONFLICT": "订单已发生变化，请刷新后重新预览。",
  "SHIPMENT_VERSION_CONFLICT": "发货单已变化，请刷新后重新预览。",
  "OUTBOUND_CONCURRENT_TRANSACTION_CONFLICT":
    "库存已发生变化，请刷新后重新预览。",
  "IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD":
    "操作内容已改变，请重新开始该操作。",
  "COMMAND_EXECUTION_IN_PROGRESS": "该操作正在处理中，请稍后重试。",
  "RESERVATION_INSUFFICIENT_AVAILABLE": "可用库存不足，请调整数量。",
  "RESERVATION_OVER_ORDERED": "数量超过该订单行尚待预留的数量。",
  "SHIPMENT_RESERVATION_INSUFFICIENT": "预留数量不足，请调整数量。",
  "SHIPMENT_OVER_FULFILLMENT": "数量超过该订单行尚待发货的数量。",
  "SHIPMENT_REVERSAL_NOT_SAFE": "历史出库事实不一致，系统已阻止冲销。",
  // Shown both as a preview blocking issue and as a command error.
  "SHIPMENT_REVERSAL_BLOCKED_BY_INVOICE":
    "已有销售发票对此发货开票，不能再冲销。如需收回货物，请使用客户退货和贷项通知单。",
  "SALES_ORDER_INVALID_STATE": "当前订单状态不允许此操作。",
  "SALES_ORDER_ITEM_INVALID": "订单物料与当前工作区基础资料不一致。",
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
// One of the order's key facts in the header: a label, its value and an
// optional note under it.
const HeaderFact = ({
  label,
  children,
  note,
  tone = "default",
  testId,
}: {
  label: string;
  children: React.ReactNode;
  note?: React.ReactNode;
  tone?: "default" | "warning" | "muted";
  testId?: string;
}) => (
  <div className="min-w-0" data-testid={testId}>
    <dt className="text-xs text-slate-500">{label}</dt>
    <dd
      className={`mt-0.5 break-words text-sm tabular-nums ${
        tone === "warning" ? "font-semibold text-amber-700" : tone === "muted" ? "text-slate-500" : "font-semibold text-slate-800"
      }`}
    >
      {children}
    </dd>
    {note ? <dd className="mt-0.5 text-xs text-slate-500">{note}</dd> : null}
  </div>
);
const Badge = ({ value }: { value: string }) => (
  <StatusChip label={status(value)} tone={statusToneOf(value)} />
);
const Button = ({
  children,
  disabled,
  onClick,
  testId,
  ariaLabel,
  tone = "primary",
  dense = false,
}: {
  children: React.ReactNode;
  disabled?: boolean;
  onClick?: () => void;
  testId?: string;
  ariaLabel?: string;
  // "dangerOutline": an undo such as reversing a shipment, offered but never
  // the page's main action.
  tone?: "primary" | "secondary" | "danger" | "dangerOutline";
  dense?: boolean;
}) => (
  <button
    type="button"
    data-testid={testId}
    aria-label={ariaLabel}
    disabled={disabled}
    onClick={onClick}
    // A header button is 32 px on a wide screen and 36 px on a phone, a thumb target.
    className={dense && tone === "dangerOutline"
      ? `inline-flex h-8 items-center gap-1.5 rounded-lg border border-red-200 bg-white px-3 text-[13px] font-medium text-red-700 hover:bg-red-50 max-sm:h-9 disabled:cursor-not-allowed disabled:opacity-50`
      : dense && tone !== "danger"
      ? `${tone === "primary" ? listButtonClass.primary : listButtonClass.secondary} max-sm:h-9 disabled:cursor-not-allowed disabled:opacity-50`
      : `${tone === "primary" ? "bg-blue-600 text-white" : tone === "danger" ? "bg-red-600 text-white" : tone === "dangerOutline" ? "border border-red-200 bg-white text-red-700 hover:bg-red-50" : "bg-slate-100 text-slate-800"} min-h-9 rounded-lg px-3 py-2 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-50`}
  >
    {children}
  </button>
);
// A text link (a document number, an SKU) as a 36 px thumb target on a phone;
// wider screens keep it inline.
const phoneTapClass = "max-sm:inline-flex max-sm:min-h-9 max-sm:items-center";
// "Create customer invoice" as a page's main action: the shared entry button
// (BillingEntryActions.tsx) is a secondary one. The same permission and route
// checks decide whether it shows; the invoice form takes the source from the address.
function InvoiceButton({ shipmentId, salesOrderId, primary }: { shipmentId?: string; salesOrderId?: string; primary: boolean }) {
  const navigate = useNavigate();
  const permissions = usePermissionSet();
  const canOpenRoute = useRouteAvailability();
  const source = shipmentId ? `shipment=${encodeURIComponent(shipmentId)}` : salesOrderId ? `salesOrder=${encodeURIComponent(salesOrderId)}` : "";
  if (!source || !permissions?.has("finance.customer_invoice.create") || !canOpenRoute("sales:invoice-new")) return null;
  return (
    <button
      type="button"
      data-testid="create-invoice"
      className={`${primary ? listButtonClass.primary : listButtonClass.secondary} max-sm:h-9`}
      onClick={() => navigate(`/app/sales/invoices/new?${source}`)}
    >
      <FilePlus2 size={14} />
      {say("Create customer invoice", "开销售发票")}
    </button>
  );
}
// A customer invoice's status in a sales page. "Issued" reads 已开具 for an
// invoice (a purchase order's "issued" is 已下达).
const INVOICE_STATUS: Record<string, [string, string]> = {
  draft: ["Draft", "草稿"],
  submitted: ["Submitted", "已提交"],
  approved: ["Approved", "已批准"],
  issued: ["Issued", "已开具"],
  disputed: ["Disputed", "有争议"],
  void: ["Void", "已作废"],
  voided: ["Void", "已作废"],
  cancelled: ["Cancelled", "已取消"],
  // An issued invoice reads where its payment stands, as on the invoice page.
  to_be_paid: ["To be paid", "待收款"],
  partially_settled: ["Partly paid", "部分付款"],
  settled: ["Paid", "已结清"],
};
const invoiceStatus = (invoice: Pick<InvoiceRef, "status" | "paymentStatus">) => {
  const code = invoice.status === "issued" && invoice.paymentStatus ? invoice.paymentStatus : invoice.status;
  return INVOICE_STATUS[code] ? say(...INVOICE_STATUS[code]) : code;
};
// One customer invoice as a link: its number and status.
const InvoiceLink = ({ invoice }: { invoice: InvoiceRef }) => (
  <Link
    to={`/app/sales/invoices/${encodeURIComponent(invoice.id)}`}
    className="inline-flex min-h-9 items-center gap-1.5 rounded-lg border px-3 text-sm text-blue-700 hover:bg-blue-50 sm:min-h-8"
    data-testid={`invoice-link-${invoice.id}`}
  >
    {invoice.invoiceNumber}
    <span className="text-xs text-slate-500">{invoiceStatus(invoice)}</span>
  </Link>
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

// Fifty orders a page, as the purchase order list and the order evidence
// page show, so the same orders read the same number of pages on each.
const ORDER_LIST_PAGE_SIZE = 50;

function OrderList() {
  const workspace = useWorkspaceCurrency();
  const stamp = useStamp();
  const { locale } = useI18n();
  const [params, setParams] = useSearchParams(),
    [data, setData] = useState<{
      orders: Order[];
      total: number;
      page: number;
      pageSize: number;
      dataSource: string;
      // The currencies the workspace's orders use.
      currencies?: string[];
      capabilities: { salesOrderLifecycle: LifecycleCapability };
    } | null>(null),
    [error, setError] = useState(""),
    [counts, setCounts] = useState<Record<string, number | null>>({});
  const value = (name: string, fallback = "") => params.get(name) || fallback;
  const page = Math.max(1, Number(value("page", "1")) || 1),
    pageSize = ORDER_LIST_PAGE_SIZE;
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
        currencies?: string[];
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
  // The cards count every order on the server; the list shows one page.
  useEffect(() => {
    const read = (key: string, filter: string) =>
      apiJson<{ total: number }>(`/api/sales/orders?pageSize=1&${filter}`)
        .then((result) => [key, result.total] as const)
        .catch(() => [key, null] as const);
    void Promise.all(Object.entries(ORDER_CARDS).map(([key, card]) => read(key, card.filter)))
      .then((entries) => setCounts(Object.fromEntries(entries)));
  }, []);
  const filterNames = ["workflowStatus", "reservationStatus", "fulfillmentStatus", "currency"],
    activeFilters = filterNames.filter((name) => params.get(name)).length;
  const filtered = ["search", ...filterNames, ...Object.keys(DEMAND_FILTERS)].some((name) => params.get(name));
  // An order's amount, from its lines as read: ordered quantity × unit price.
  const amountCell = (row: Order) => {
    const lines = row.lines || [];
    if (!lines.length) return "—";
    const total = orderTotal(lines);
    if (!total.priced) return <span className="font-normal" style={{ color: A.sub }}>{say("Not priced", "未定价")}</span>;
    return (
      <>
        {formatLocaleAmount(total.amount, row.currency, locale, { maximumFractionDigits: 2 })}
        {total.unpriced > 0 && (
          <div className="text-[11px] font-normal text-amber-700">
            {say(`${total.unpriced} ${total.unpriced === 1 ? "line" : "lines"} not priced`, `${total.unpriced} 行未定价`)}
          </div>
        )}
      </>
    );
  };
  // How far the order's shipped goods are invoiced: a chip, and the counts in
  // the order's unit when its lines share one. "—" for a reader who may not
  // read customer invoices (the server sends no figure then).
  const { language } = useI18n();
  const invoicingCell = (row: Order) => {
    if (row.invoicedQuantity === null || row.invoicedQuantity === undefined) return <span style={{ color: A.sub }}>—</span>;
    const state = invoicingState(row.fulfilledQuantity, row.invoicedQuantity),
      units = [...new Set((row.lines || []).map((line) => line.unit).filter(Boolean))];
    return (
      <>
        <StatusChip label={say(...INVOICING_STATES[state].label)} tone={INVOICING_STATES[state].tone} />
        {state === "partly_invoiced" && (
          <div className="mt-1 text-[11px]" style={{ color: A.sub }}>
            {invoicingProgressText(row.fulfilledQuantity, row.invoicedQuantity, units.length === 1 ? units[0] : null, language)}
          </div>
        )}
      </>
    );
  };
  // The currencies the workspace's orders use; before the server lists them,
  // the workspace currency and the currencies on this page.
  const currencyOptions = orderedCurrencyCodes(
    workspace.currency,
    data?.currencies?.length ? data.currencies : [workspace.currency, ...(data?.orders || []).map((row) => row.currency)].filter(Boolean),
    value("currency"),
  );
  // The delivery-risk filters the Delivery risk page opens the list with,
  // each shown as a chip that removes it.
  const demandFilters = Object.entries(DEMAND_FILTERS).flatMap(([name, labels]) => {
    const label = labels[value(name)];
    return label ? [{ name, label: say(...label) }] : [];
  });
  return (
    <div className="space-y-5" data-testid="outbound-order-list">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {Object.entries(ORDER_CARDS).map(([key, card]) => (
          <ActionableMetricCard
            key={key}
            label={say(...card.label)}
            value={counts[key] === undefined || counts[key] === null ? "—" : String(counts[key])}
            description={say(...card.note)}
            to={`/app/sales/orders${card.filter ? `?${card.filter}` : ""}`}
            icon={card.icon}
            color={card.color}
          />
        ))}
      </div>
      {data && !data.capabilities.salesOrderLifecycle.enabled && (
        <div role="status" className="rounded-lg bg-slate-100 p-3 text-sm text-slate-700">
          {copy("销售订单当前为只读；订单、库存预留和履约事实来自 PostgreSQL。")}
        </div>
      )}
      {error && (
        <div role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-700">
          {copy(error)}
        </div>
      )}
      <ListSearchCard
        title={copy("销售订单查询")}
        subtitle={copy("查询订单、客户、库存预留、履约状态和承诺交期。")}
        activeFilters={activeFilters}
        actions={<>
          <ResetButton onClick={() => setParams({})} />
          <RefreshButton onClick={() => void load()} />
          {data?.capabilities.salesOrderLifecycle.enabled && (
            <Link to="/app/sales/orders/new" className={`${listButtonClass.primary} max-sm:h-9`}>
              <Plus size={13} />
              {copy("新建销售订单")}
            </Link>
          )}
        </>}
      >
        <Field label={copy("搜索")}>
          <input
            aria-label={copy("搜索销售订单")}
            value={value("search")}
            onChange={(e) => update({ search: e.target.value, page: 1 })}
            style={inputStyle}
            placeholder={copy("订单号或客户")}
          />
        </Field>
        <Filter
          label={copy("流程状态")}
          value={value("workflowStatus")}
          onChange={(v) => update({ workflowStatus: v, page: 1 })}
          values={["draft", "confirmed", "on_hold"]}
        />
        <Filter
          label={copy("预留状态")}
          value={value("reservationStatus")}
          onChange={(v) => update({ reservationStatus: v, page: 1 })}
          values={["not_reserved", "partially_reserved", "fully_reserved"]}
        />
        <Filter
          label={copy("履约状态")}
          value={value("fulfillmentStatus")}
          onChange={(v) => update({ fulfillmentStatus: v, page: 1 })}
          values={["not_fulfilled", "partially_fulfilled", "fully_fulfilled"]}
        />
        <Field label={copy("币种")}>
          <select
            aria-label={copy("币种筛选")}
            style={inputStyle}
            value={value("currency")}
            onChange={(e) => update({ currency: e.target.value, page: 1 })}
          >
            <option value="">{copy("全部")}</option>
            {currencyOptions.map((x) => (
              <option key={x}>{x}</option>
            ))}
          </select>
        </Field>
        <Field label={copy("排序")}>
          <select
            aria-label={copy("订单排序")}
            style={inputStyle}
            value={`${value("sort", "updatedAt")}:${value("direction", "desc")}`}
            onChange={(e) => {
              const [sort, direction] = e.target.value.split(":");
              update({ sort, direction, page: 1 });
            }}
          >
            <option value="updatedAt:desc">{copy("更新时间（新到旧）")}</option>
            <option value="updatedAt:asc">{copy("更新时间（旧到新）")}</option>
            <option value="promisedDate:asc">{copy("承诺交期（升序）")}</option>
            <option value="promisedDate:desc">{copy("承诺交期（降序）")}</option>
            <option value="orderNumber:asc">{copy("订单号（升序）")}</option>
            <option value="orderNumber:desc">{copy("订单号（降序）")}</option>
          </select>
        </Field>
      </ListSearchCard>
      <ListCard
        title={say("Sales order list", "销售订单列表")}
        total={data?.total}
        shown={data?.orders.length}
        right={demandFilters.length ? (
          <div className="flex flex-wrap items-center gap-2" data-testid="sales-order-demand-filters">
            <span className="text-xs" style={{ color: A.sub }}>{say("Filtered by", "筛选条件")}</span>
            {demandFilters.map((filter) => (
              <button
                type="button"
                key={filter.name}
                onClick={() => update({ [filter.name]: "", page: 1 })}
                aria-label={say(`Remove filter: ${filter.label}`, `移除筛选：${filter.label}`)}
                className="inline-flex items-center gap-1 rounded-full bg-blue-50 px-2.5 py-1 text-xs font-medium text-blue-700 hover:bg-blue-100"
              >
                {filter.label}
                <X size={12} aria-hidden />
              </button>
            ))}
          </div>
        ) : undefined}
      >
        <div className={tableScrollClass}>
          <table className={`w-full min-w-[1120px] text-left ${tableBodyTextClass}`}>
            <thead>
              <tr style={listHeadRowStyle}>
                <th className={`${thClass} sticky left-0 z-20 bg-white`} style={{ color: A.gray1 }}>{copy("订单号")}</th>
                <th className={thClass} style={{ color: A.gray1 }}>{copy("客户")}</th>
                {/* The order's one status, the first line of a phone card. */}
                <th className={thClass} style={{ color: A.gray1 }} data-card-status="">{copy("状态")}</th>
                <th className={thRightClass} style={{ color: A.gray1 }}>{copy("订单金额")}</th>
                <th className={thClass} style={{ color: A.gray1 }}>{copy("承诺交期")}</th>
                <th className={thRightClass} style={{ color: A.gray1 }}>{copy("订购 / 预留 / 履约")}</th>
                <th className={thClass} style={{ color: A.gray1 }}>{say("Invoicing", "开票")}</th>
                <th className={`${thClass} sticky right-0 z-20 bg-white`} style={{ color: A.gray1 }}>{copy("操作")}</th>
              </tr>
            </thead>
            <tbody>
              {data?.orders.map((row, index) => {
                const stage = salesOrderStage(row),
                  hint = salesOrderStageHint(row, stage);
                return (
                <tr key={row.id} className={listRowClass} style={listRowStyle(index, data.orders.length)}>
                  <td className={`${tdIdClass} sticky left-0 z-10 bg-white`}>
                    <BusinessEntityLink entityType="sales_order" entityId={row.id} className={`${tableLinkClass} ${phoneTapClass}`}>
                      {row.orderNumber}
                    </BusinessEntityLink>
                    <div className="text-[11px] font-normal" style={{ color: A.sub }}>{copy("更新时间")} {stamp(row.updatedAt)}</div>
                  </td>
                  {/* The whole name, wrapped when long, never cut off. */}
                  <td className="min-w-[180px] max-w-[300px] whitespace-normal px-4 py-3">{row.customerName}</td>
                  <td className={tdNowrapClass} data-testid={`sales-order-status-${row.id}`}>
                    <StatusChip label={say(...SALES_ORDER_STAGES[stage].label)} tone={SALES_ORDER_STAGES[stage].tone} />
                    {hint && <div className="mt-1 text-[11px]" style={{ color: A.sub }}>{say(...hint)}</div>}
                  </td>
                  <td className={`${tdNumericRightClass} font-semibold`} style={{ color: A.label }}>{amountCell(row)}</td>
                  <td className={tdNowrapClass} style={{ color: row.promisedDate ? A.label : A.sub }}>
                    {row.promisedDate ? formatCalendarDay(row.promisedDate, locale) : say("Not set", "未设置")}
                  </td>
                  <td className={tdNumericRightClass}>
                    <span className="font-semibold" style={{ color: A.label }}>{formatQuantity(row.orderedQuantity)}</span>
                    <span style={{ color: A.sub }}> / {formatQuantity(row.reservedQuantity)} / {formatQuantity(row.fulfilledQuantity)}</span>
                    <div className="text-[11px]" style={{ color: A.sub }}>
                      {say(`${row.totalLines} ${row.totalLines === 1 ? "line" : "lines"} · ${row.currency}`, `${row.totalLines} 行 · ${row.currency}`)}
                    </div>
                  </td>
                  <td className="min-w-[130px] max-w-[170px] whitespace-normal px-4 py-3" data-testid={`sales-order-invoicing-${row.id}`}>{invoicingCell(row)}</td>
                  <td className={`${tdActionClass} sticky right-0 z-10 !min-w-0 bg-white`}>
                    <Link
                      className={rowActionClass.primary}
                      to={`/app/sales/orders/${encodeURIComponent(row.id)}`}
                    >
                      {copy("查看")}
                    </Link>
                  </td>
                </tr>
                );
              })}
            </tbody>
          </table>
          {/* Outside the table body: an empty or failed read leaves no rows. */}
          {data && data.orders.length === 0 && (
            <div className="px-4 py-12 text-center text-sm" style={{ color: A.sub }}>
              {copy("暂无符合当前筛选条件的正式销售订单。")}
              {filtered && (
                <button
                  className="ml-2 font-semibold text-blue-600"
                  onClick={() => setParams({})}
                >
                  {copy("清除筛选")}
                </button>
              )}
            </div>
          )}
        </div>
        {data && (
          <ListPager page={data.page || page} pageSize={data.pageSize || pageSize} total={data.total} onPage={(next) => update({ page: next })} testId="sales-order-list-pager" />
        )}
      </ListCard>
    </div>
  );
}

// The filters the Delivery risk page's figures open the list with
// (src/modules/sales/Page.tsx), by parameter and value: the server selects
// the same orders those figures count (db-sales-order-read-repository.mjs).
const DEMAND_FILTERS: Record<string, Record<string, [string, string]>> = {
  risk: {
    "true": ["At risk of late delivery", "有交付风险"],
    "blocked": ["Blocked (on hold)", "已阻塞（已暂停）"],
    "high": ["High risk", "高风险"],
  },
  shortage: { "true": ["Short of stock", "存在缺口"] },
  reserved: { "true": ["Stock reserved", "已预留库存"] },
};

// The four counts above the list, each a filter of the list.
const ORDER_CARDS: Record<string, { label: [string, string]; note: [string, string]; filter: string; icon: React.ElementType; color: string }> = {
  all: { label: ["Sales orders", "销售订单"], note: ["Every order in this workspace", "当前工作区的全部订单"], filter: "", icon: ShoppingCart, color: A.blue },
  toFulfill: { label: ["To fulfill", "待履约"], note: ["Confirmed, nothing shipped yet", "已确认，尚未发货"], filter: "workflowStatus=confirmed&fulfillmentStatus=not_fulfilled", icon: PackageOpen, color: A.orange },
  partial: { label: ["Partly fulfilled", "部分履约"], note: ["Some lines shipped, some open", "部分已发货，部分未发"], filter: "fulfillmentStatus=partially_fulfilled", icon: Truck, color: A.purple },
  onHold: { label: ["On hold", "暂停"], note: ["Paused until released", "暂停中，待恢复"], filter: "workflowStatus=on_hold", icon: PauseCircle, color: A.red },
};

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
    <Field label={label}>
      <select
        aria-label={label}
        style={inputStyle}
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
    </Field>
  );
}

type EntryItem = { id: string; sku: string; name: string; unit?: string };
type EntryCustomer = {
  id: string;
  code: string;
  name: string;
  currency: string | null;
  paymentTerms: string | null;
  country?: string | null;
  address?: string | null;
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
  required = false,
  error,
}: {
  customers: EntryCustomer[];
  value: string;
  onChange: (customer: EntryCustomer | null) => void;
  ariaLabel: string;
  required?: boolean;
  error?: string;
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
  // Typed and searched: a workspace can hold a thousand customers
  // (CustomerPicker.tsx). Under it, the chosen customer's number, payment
  // terms in words ("Net 30 days") and currency.
  return (
    <CustomerPicker
      customers={customers}
      value={value}
      onChange={onChange}
      label={say("Customer", "客户")}
      ariaLabel={ariaLabel}
      required={required}
      error={error}
    >
      {chosen && (
        <span className="flex flex-wrap gap-x-2 text-xs text-slate-500" data-testid="sales-order-customer-facts">
          <span>{say(`Customer number ${chosen.code}`, `客户编号 ${chosen.code}`)}</span>
          {chosen.paymentTerms && (
            <span data-testid="sales-order-customer-terms">
              {say(`Payment terms: ${paymentTermsLabel(chosen.paymentTerms, "en-US")}`, `付款条款：${paymentTermsLabel(chosen.paymentTerms, "zh-CN")}`)}
            </span>
          )}
        </span>
      )}
    </CustomerPicker>
  );
}

// The stock available now for each item on the order form, summed over the
// stock balances the user can see (GET /api/inventory/balances, which applies
// the warehouse scope). Read once per item; an item whose stock cannot be read
// (no inventory access) is left out, so the form says nothing about it.
function useItemAvailability(itemIds: string[]) {
  const [available, setAvailable] = useState<Record<string, string>>({});
  const asked = useRef(new Set<string>());
  const wanted = [...new Set(itemIds.filter(Boolean))].sort().join("|");
  useEffect(() => {
    for (const itemId of wanted ? wanted.split("|") : []) {
      if (asked.current.has(itemId)) continue;
      asked.current.add(itemId);
      apiJson<{ balances?: Array<{ availableQuantity?: string | number | null }> }>(
        `/api/inventory/balances?itemId=${encodeURIComponent(itemId)}&pageSize=200`,
      )
        .then((result) => {
          const total = (result.balances || []).reduce((sum, row) => sum + (quantityUnits(String(row.availableQuantity ?? "0")) ?? 0n), 0n);
          setAvailable((current) => ({ ...current, [itemId]: unitsToPlain(total) }));
        })
        .catch(() => {});
    }
  }, [wanted]);
  return available;
}

type LineIssues = { itemId?: string; quantity?: string; unitPrice?: string };
// The order's lines: item, quantity and unit price, one card each. `issues`
// holds each line's messages, by line key, once a save was refused.
function OrderLinesField({
  items,
  lines,
  currency,
  onChange,
  issues = {},
}: {
  items: EntryItem[];
  lines: DraftLine[];
  currency: string;
  onChange: (lines: DraftLine[]) => void;
  issues?: Record<string, LineIssues>;
}) {
  const update = (lineKey: string, change: Partial<DraftLine>) =>
    onChange(lines.map((line) => (line.key === lineKey ? { ...line, ...change } : line)));
  const availability = useItemAvailability(lines.map((line) => line.itemId));
  return (
    <div className="space-y-3" data-testid="sales-order-lines">
      {lines.map((line, index) => {
        const unit = items.find((item) => item.id === line.itemId)?.unit;
        const n = String(index + 1);
        const issue = issues[line.key] || {};
        // The stock the line can draw on now, from the warehouses this user
        // can see; nothing is said when it cannot be read.
        const available = line.itemId ? availability[line.itemId] : undefined;
        const wanted = quantityUnits(line.quantity.trim()),
          have = available ? quantityUnits(available) : null;
        const shortNow = have !== null && wanted !== null && wanted > have;
        return (
          <FormLineCard
            key={line.key}
            label={say(`Line ${n}`, `第 ${n} 行`)}
            remove={{
              label: say(`Remove line ${n}`, `删除第 ${n} 行`),
              disabled: lines.length === 1,
              onClick: () => onChange(lines.filter((other) => other.key !== line.key)),
            }}
            testId={`sales-order-line-${n}`}
          >
            <div className="grid grid-cols-1 gap-3 md:grid-cols-[2fr_1fr_1fr]">
              <Field label={say("Item", "物料")} required error={issue.itemId}>
                <select
                  aria-label={say(`Item, line ${n}`, `物料（第 ${n} 行）`)}
                  style={inputStyle}
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
              </Field>
              <Field label={unit ? say(`Quantity (${unitLabel(unit, "en-US")})`, `数量（${unitLabel(unit, "zh-CN")}）`) : say("Quantity", "数量")} required error={issue.quantity}>
                <input
                  aria-label={say(`Quantity, line ${n}`, `数量（第 ${n} 行）`)}
                  inputMode="decimal"
                  style={inputStyle}
                  value={line.quantity}
                  onChange={(e) => update(line.key, { quantity: e.target.value })}
                />
              </Field>
              <Field label={currency ? say(`Unit price (${currency})`, `单价（${currency}）`) : say("Unit price", "单价")} required error={issue.unitPrice}>
                <input
                  aria-label={say(`Unit price, line ${n}`, `单价（第 ${n} 行）`)}
                  inputMode="decimal"
                  style={inputStyle}
                  value={line.unitPrice}
                  onChange={(e) => update(line.key, { unitPrice: e.target.value })}
                />
              </Field>
            </div>
            {available !== undefined && (
              <p
                className={`mt-2 text-xs ${shortNow ? "text-amber-700" : "text-slate-500"}`}
                data-testid={`sales-order-line-available-${n}`}
              >
                {shortNow
                  ? say(
                      `Only ${quantityWithUnit(available, unit, "en-US")} available now. The order can still be saved; reserve the rest when stock arrives.`,
                      `当前仅可用 ${quantityWithUnit(available, unit, "zh-CN")}。订单仍可保存，其余数量待到货后再预留。`,
                    )
                  : say(`${quantityWithUnit(available, unit, "en-US")} available now`, `当前可用 ${quantityWithUnit(available, unit, "zh-CN")}`)}
              </p>
            )}
          </FormLineCard>
        );
      })}
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" className={`${listButtonClass.secondary} max-sm:h-9`} data-testid="sales-order-add-line" onClick={() => onChange([...lines, draftLine()])}>
          <Plus size={13} />
          {say("Add line", "添加行")}
        </button>
        <span className="text-xs text-slate-500">
          {say(
            "A unit price is needed to invoice the customer. Enter 0 for free goods.",
            "开销售发票需要单价。赠品请填 0。",
          )}
        </span>
      </div>
    </div>
  );
}

// What the order is refused without, field by field: the rules of
// linesReady and the customer and currency checks, so the client refuses
// nothing it accepted before.
function entryIssues(customerId: string, currency: string, lines: DraftLine[]) {
  const header = {
    customer: customerId ? "" : say("Choose a customer.", "请选择客户。"),
    currency: currency.trim() ? "" : say("Choose a currency.", "请选择币种。"),
  };
  const byLine: Record<string, LineIssues> = {};
  for (const line of lines) {
    const issue: LineIssues = {
      ...(line.itemId ? {} : { itemId: say("Choose an item.", "请选择物料。") }),
      ...(Number(line.quantity) > 0 ? {} : { quantity: say("Enter a quantity above 0.", "请输入大于 0 的数量。") }),
      ...(line.unitPrice.trim() !== "" ? {} : { unitPrice: say("Enter a unit price. Use 0 for free goods.", "请输入单价，赠品填 0。") }),
    };
    if (Object.keys(issue).length) byLine[line.key] = issue;
  }
  return { header, byLine, any: Boolean(header.customer || header.currency || Object.keys(byLine).length || !lines.length) };
}

function OrderEntry() {
  const nav = useNavigate(),
    [entry, setEntry] = useState<EntryData | null>(null),
    [customerId, setCustomerId] = useState(""),
    [currency, setCurrency] = useState(""),
    [promised, setPromised] = useState(""),
    [lines, setLines] = useState<DraftLine[]>(() => [draftLine()]),
    [saving, setSaving] = useState(false),
    [error, setError] = useState(""),
    // A save was refused for missing fields: their messages show, and go as
    // each field is filled.
    [checked, setChecked] = useState(false);
  const intent = useRef({ fingerprint: "", idempotencyKey: "" }),
    inFlight = useRef(false),
    formRef = useRef<HTMLDivElement>(null);
  const workspace = useWorkspaceCurrency();
  const formCopy = useFormCopy();
  const issues = entryIssues(customerId, currency, lines);
  const customers = entry?.customers || [];
  // The workspace's currencies: its own, those its customers trade in and the
  // common ones, the workspace currency first (currencyOptions.ts).
  const currencyOptions = orderedCurrencyCodes(
    workspace.currency,
    [workspace.currency, ...customers.map((customer) => customer.currency || ""), ...COMMON_CURRENCIES].filter(Boolean),
    currency,
  );
  // Prefill the workspace currency; a chosen customer's recorded currency
  // replaces it, and the user can still choose another.
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
  // "New sales order" on a customer's page opens the form for that customer
  // (?customerId=…). Only an active customer this reader can see is chosen:
  // the entry data lists exactly those; any other value is ignored.
  const [searchParams] = useSearchParams();
  const presetCustomer = searchParams.get("customerId") || "";
  const presetApplied = useRef(false);
  useEffect(() => {
    if (!entry || presetApplied.current || !presetCustomer) return;
    presetApplied.current = true;
    const customer = (entry.customers || []).find((row) => row.id === presetCustomer || row.code === presetCustomer);
    if (customer) chooseCustomer(customer);
  }, [entry, presetCustomer]);
  async function save() {
    if (inFlight.current) return;
    if (issues.any) {
      setChecked(true);
      setError("");
      focusFirstInvalid(formRef.current);
      return;
    }
    // No order number: the server assigns SO-YYYYMM-NNNN when the draft is saved.
    const body = {
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
      toast.success(say(`Sales order ${result.order.orderNumber} saved as a draft`, `销售订单 ${result.order.orderNumber} 已保存为草稿`));
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
      <div className="max-w-4xl space-y-4" data-testid="sales-order-entry-readonly">
        <div role="status" className="rounded-lg bg-slate-100 p-4 text-slate-700">
          {copy("当前销售订单写入能力未启用，页面保持只读。")}
        </div>
        <Link className="text-blue-700 underline" to="/app/sales/orders">
          {copy("返回销售订单列表")}
        </Link>
      </div>
    );
  const shown = checked ? issues : { header: { customer: "", currency: "" }, byLine: {}, any: false };
  return (
    <div ref={formRef} className="space-y-5" data-testid="sales-order-entry">
      <FocusFirstField />
      {/* The page's h1 already says "New sales order". */}
      <FormHeader
        intro={say(
          "Saved as a draft. The SKU, item name and unit are taken from Items when you save.",
          "保存为草稿。保存时会从物料资料带入 SKU、物料名称和单位。",
        )}
      >
        <p className="mt-3 text-xs text-slate-600" data-testid="sales-order-number-on-save">
          {say("Order number: assigned when you save", "订单编号：保存时自动生成")}
        </p>
      </FormHeader>
      <FormSection title={say("Order details", "订单信息")}>
        <div className={formGridClass}>
          {/* Two columns wide, so the chosen customer's whole name shows. */}
          <div className="md:col-span-2">
            <CustomerField
              customers={customers}
              value={customerId}
              onChange={chooseCustomer}
              ariaLabel={say("Customer", "客户")}
              required
              error={shown.header.customer}
            />
          </div>
          <Field label={copy("币种")} required error={shown.header.currency}>
            <select
              aria-label={copy("币种")}
              style={inputStyle}
              value={currency}
              onChange={(e) => setCurrency(e.target.value)}
            >
              <option value="">{say("Choose a currency", "选择币种")}</option>
              {currencyOptions.map((code) => (
                <option key={code} value={code}>{code}</option>
              ))}
            </select>
            {workspace.status === "unavailable" && !currency && (
              <span className="block text-xs text-amber-700">
                {say("Could not load the workspace currency. Choose one.", "工作区币种加载失败，请选择币种。")}
              </span>
            )}
          </Field>
          <Field label={say("Promised date", "承诺交期")}>
            <input
              type="date"
              aria-label={say("Promised date", "承诺交期")}
              style={inputStyle}
              value={promised}
              onChange={(e) => setPromised(e.target.value)}
            />
          </Field>
        </div>
      </FormSection>
      <FormSection title={say("Lines", "订单行")}>
        <OrderLinesField items={entry.items} lines={lines} currency={currency} onChange={setLines} issues={shown.byLine} />
      </FormSection>
      <FormActionBar
        onCancel={() => nav("/app/sales/orders")}
        submit={{ label: say("Save draft", "保存草稿"), onClick: () => void save(), busy: saving, testId: "create-sales-order" }}
        message={shown.any ? formCopy("checkFields") : error ? copy(error) : null}
        messageTestId="sales-order-entry-errors"
      />
    </div>
  );
}

function OrderDetail({ id }: { id: string }) {
  const warehouseName = useWarehouseNames();
  const place = usePlace();
  const stamp = useStamp();
  const { locale, language } = useI18n();
  const dialog = useConfirm();
  const [data, setData] = useState<Workbench | null>(null),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true),
    [preview, setPreview] = useState<Preview | null>(null),
    [intent, setIntent] = useState(""),
    [intentKey, setIntentKey] = useState(""),
    [selectedLineId, setSelectedLineId] = useState(""),
    [selectedBalanceId, setSelectedBalanceId] = useState(""),
    [selectedReservationId, setSelectedReservationId] = useState(""),
    [quantity, setQuantity] = useState("1"),
    // Typed by the person, in their own words: no prefilled reason, which
    // would be taken before the interface language is known.
    [reason, setReason] = useState(""),
    // A dialog field's message, shown under it: the quantity or the reason.
    [fieldIssue, setFieldIssue] = useState<{ quantity?: string; reason?: string }>({}),
    [editCustomerId, setEditCustomerId] = useState(""),
    [editPromised, setEditPromised] = useState(""),
    [editLines, setEditLines] = useState<DraftLine[]>([]),
    [editEntry, setEditEntry] = useState<EntryData | null>(null),
    [cancelReason, setCancelReason] = useState(""),
    [cancelPreview, setCancelPreview] = useState<CancellationPreview | null>(null),
    // The number the server gave the shipment draft just saved.
    [createdShipmentNumber, setCreatedShipmentNumber] = useState(""),
    [saving, setSaving] = useState(false);
  const lifecycleIntents = useRef<Record<string, string>>({}),
    inFlight = useRef(false);
  // The breadcrumb names the order by its number, not by the id in the address.
  useDetailCrumb(data?.order.orderNumber);
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
    setCreatedShipmentNumber("");
    setIntentKey(key());
    setSelectedLineId("");
    setSelectedBalanceId("");
    setSelectedReservationId("");
    setPreview(null);
    setError("");
    setFieldIssue({});
    setReason("");
    if (next === "edit" && data) {
      setSelectedLineId(data.lines[0]?.id || "");
      setEditCustomerId(data.order.customerId || "");
      setEditPromised(promisedDay(data.order.promisedDate));
      setEditLines(data.lines.map((line) => draftLine(line.itemId, plainQuantity(line.orderedQuantity), line.unitPrice == null ? "" : plainQuantity(line.unitPrice))));
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
  // What a line can have reserved from a balance: what it still needs, but no
  // more than the balance has available. As typed, without trailing zeros.
  const reservable = (line: Line, balance?: Balance) =>
    balance
      ? smallerQuantity(hasQuantity(line.remainingToReserve) ? line.remainingToReserve : null, balance.availableQuantity)
      : hasQuantity(line.remainingToReserve)
        ? plainQuantity(line.remainingToReserve)
        : "1";
  // Choosing a line picks its only usable balance (to reserve) or its only
  // open reservation (to ship), and fills in the quantity the line still needs,
  // as far as the stock allows.
  function chooseLine(lineId: string, forIntent = intent) {
    setSelectedLineId(lineId);
    setSelectedBalanceId("");
    setSelectedReservationId("");
    setPreview(null);
    setFieldIssue({});
    setIntentKey(key());
    const line = data?.lines.find((row) => row.id === lineId);
    if (!data || !line) return;
    if (forIntent === "reserve") {
      const usable =
        data.availability
          .find((row) => row.salesOrderLineId === lineId)
          ?.balances.filter((row) => row.selectable) || [];
      if (usable.length === 1) setSelectedBalanceId(usable[0].id);
      setQuantity(reservable(line, usable.length === 1 ? usable[0] : undefined));
    } else if (forIntent === "shipment") {
      const open = data.reservations.filter(
        (row) => row.salesOrderLineId === lineId && hasQuantity(row.allocatableQuantity),
      );
      if (open.length === 1) {
        setSelectedReservationId(open[0].id);
        setQuantity(plainQuantity(open[0].allocatableQuantity));
      } else setQuantity(hasQuantity(line.remainingToFulfill) ? plainQuantity(line.remainingToFulfill) : "1");
    }
  }
  // A balance to reserve from: the quantity becomes what it can give the line.
  function chooseBalance(balanceId: string) {
    setSelectedBalanceId(balanceId);
    setPreview(null);
    setFieldIssue({});
    setIntentKey(key());
    const line = data?.lines.find((row) => row.id === selectedLineId),
      balance = data?.availability
        .find((row) => row.salesOrderLineId === selectedLineId)
        ?.balances.find((row) => row.id === balanceId);
    if (line && balance) setQuantity(reservable(line, balance));
  }
  // A reservation's quantity still free to ship or release.
  function chooseReservation(reservationId: string) {
    setSelectedReservationId(reservationId);
    setPreview(null);
    setFieldIssue({});
    setIntentKey(key());
    const reservation = data?.reservations.find((row) => row.id === reservationId);
    if (reservation && hasQuantity(reservation.allocatableQuantity))
      setQuantity(plainQuantity(reservation.allocatableQuantity));
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
      toast.success(say(`Sales order ${data.order.orderNumber} cancelled`, `销售订单 ${data.order.orderNumber} 已取消`));
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
      const number = data.order.orderNumber;
      toast.success(
        action === "confirm"
          ? say(`Sales order ${number} confirmed`, `销售订单 ${number} 已确认`)
          : action === "hold"
            ? say(`Sales order ${number} put on hold`, `销售订单 ${number} 已暂停`)
            : say(`Sales order ${number} resumed`, `销售订单 ${number} 已恢复`),
      );
      await refresh();
    } catch (e) {
      setError(message(e));
    } finally {
      inFlight.current = false;
      setSaving(false);
    }
  }
  // Putting an order on hold stops reserving and shipping, so it is confirmed
  // first, as cancelling is.
  async function holdOrder() {
    if (!data || inFlight.current) return;
    const confirmed = await dialog.confirm({
      title: say(`Put ${data.order.orderNumber} on hold?`, `暂停订单 ${data.order.orderNumber}？`),
      description: say(
        "Stock can't be reserved or shipped for this order until you resume it.",
        "恢复订单前，不能为此订单预留库存或发货。",
      ),
      confirmLabel: say("Put on hold", "暂停订单"),
      cancelLabel: say("Keep open", "不暂停"),
      tone: "danger",
      testId: "hold-order-dialog",
    });
    if (confirmed) await lifecycle("hold");
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
      toast.success(say(`Changes to ${data.order.orderNumber} saved`, `${data.order.orderNumber} 的修改已保存`));
      await refresh();
    } catch (e) {
      setError(message(e));
    } finally {
      inFlight.current = false;
      setSaving(false);
    }
  }
  // The unit of the line a dialog acts on, and a quantity in it ("44 pcs").
  const dialogLine = () =>
    selectedLine || (releasable ? data?.lines.find((line) => line.id === releasable.salesOrderLineId) : undefined);
  const inUnit = (value: string | null | undefined, lang: string) => quantityWithUnit(value, dialogLine()?.unit, lang);
  // What the server would refuse in the dialog, said under its field before
  // asking: more than the stock there, more than the line still needs, more
  // than the reservation holds, or no reason for a release. The server's own
  // rules, told sooner; it checks them again.
  function dialogIssues() {
    const issue: { quantity?: string; reason?: string } = {};
    const wanted = quantityUnits(quantity.trim());
    if (wanted === null || wanted <= 0n) issue.quantity = say("Enter a quantity above 0.", "请输入大于 0 的数量。");
    else if (intent === "reserve" && selectedLine && selectable) {
      const available = quantityUnits(selectable.availableQuantity) ?? 0n,
        open = selectedLine.remainingToReserve == null ? null : quantityUnits(selectedLine.remainingToReserve),
        where = place(selectable.warehouseId, selectable.location);
      if (wanted > available)
        issue.quantity = available > 0n
          ? say(
              `Only ${inUnit(selectable.availableQuantity, "en-US")} available at ${where}. Reserve that much or less.`,
              `${where} 仅可用 ${inUnit(selectable.availableQuantity, "zh-CN")}，请预留不超过此数量。`,
            )
          : say(`Nothing is available at ${where}.`, `${where} 没有可用库存。`);
      else if (open !== null && wanted > open)
        issue.quantity = say(
          `This line needs only ${inUnit(selectedLine.remainingToReserve, "en-US")} more reserved.`,
          `该订单行只需再预留 ${inUnit(selectedLine.remainingToReserve, "zh-CN")}。`,
        );
    } else if ((intent === "release" || intent === "shipment") && releasable && wanted > (quantityUnits(releasable.allocatableQuantity) ?? 0n)) {
      issue.quantity =
        intent === "release"
          ? say(`Only ${inUnit(releasable.allocatableQuantity, "en-US")} of this reservation can be released.`, `该预留最多可释放 ${inUnit(releasable.allocatableQuantity, "zh-CN")}。`)
          : say(`Only ${inUnit(releasable.allocatableQuantity, "en-US")} of this reservation is free to ship.`, `该预留可发货的数量为 ${inUnit(releasable.allocatableQuantity, "zh-CN")}。`);
    }
    if (intent === "release" && !reason.trim()) issue.reason = say("Enter why the stock is released.", "请输入释放原因。");
    return issue;
  }
  async function loadPreview() {
    if (!data) return;
    const issue = dialogIssues();
    setFieldIssue(issue);
    if (issue.quantity || issue.reason) {
      setPreview(null);
      return;
    }
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
        // The server assigns the shipment number (DN-YYYYMM-NNNN) on save.
        path = "shipments";
        body.lines = [
          {
            salesOrderLineId: selectedLine.id,
            allocations: [{ reservationId: releasable.id, quantity }],
          },
        ];
      } else return;
      const result = await apiJson<{ shipment?: { shipmentNumber?: string } }>(
        `/api/sales/orders/${encodeURIComponent(id)}/${path}`,
        {
          method: "POST",
          body: JSON.stringify(body),
        },
      );
      const shipmentNumber = path === "shipments" ? result?.shipment?.shipmentNumber || "" : "";
      setCreatedShipmentNumber(shipmentNumber);
      const sku = dialogLine()?.sku || "";
      toast.success(
        intent === "reserve"
          ? say(`Reserved ${inUnit(quantity, "en-US")} of ${sku}`, `已预留 ${sku} ${inUnit(quantity, "zh-CN")}`)
          : intent === "release"
            ? say(`Released ${inUnit(quantity, "en-US")} of ${sku}`, `已释放 ${sku} ${inUnit(quantity, "zh-CN")}`)
            : say(`Shipment ${shipmentNumber} created`, `已创建发货单 ${shipmentNumber}`),
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
  // A fully shipped order has nothing left to reserve, hold or ship; a
  // cancelled one neither. The page offers only what the order still needs.
  const shippedInFull = data.order.fulfillmentStatus === "fully_fulfilled",
    cancelled = data.order.workflowStatus === "cancelled",
    openToReserve = data.lines.some((line) => line.remainingToReserve == null || hasQuantity(line.remainingToReserve));
  const a: Workbench["availableActions"] = {
    ...data.availableActions,
    canReserve: Boolean(data.availableActions.canReserve) && openToReserve && !shippedInFull,
    canHold: Boolean(data.availableActions.canHold) && !shippedInFull,
  };
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
  // The timeline reads each row by its kind (outboundTimeline.ts): a
  // reservation by where it is, a movement's SKU as written, quantities with
  // their unit.
  const timelineLookup: TimelineLookup = {
    language,
    reservation: (reservationId) => {
      const reservation = reservationFacts(reservationId);
      return reservation ? { place: place(reservation.warehouseId, reservation.location), unit: reservation.unit } : undefined;
    },
    warehouse: (warehouseId) => warehouseName(warehouseId) || undefined,
    unitForSku: (sku) => data.lines.find((row) => row.sku === sku)?.unit,
  };
  const unitOf = (lineId?: string) => data.lines.find((row) => row.id === lineId)?.unit;
  const qtyIn = (value: string | null | undefined, lineId?: string) => quantityWithUnit(value, unitOf(lineId), language);
  // A dialog's options lead with the figure that decides the choice, so a
  // phone's narrow dropdown still shows it; the line under each dropdown
  // gives the chosen option's other figures.
  const lineOptionText = (x: Line) =>
    intent === "shipment"
      ? `${x.sku} · ${say("To ship", "待发货")} ${x.remainingToFulfill == null ? copy("受限") : qtyIn(x.remainingToFulfill, x.id)} · ${x.itemName}`
      : `${x.sku} · ${say("To reserve", "待预留")} ${x.remainingToReserve == null ? copy("受限") : qtyIn(x.remainingToReserve, x.id)} · ${x.itemName}`;
  const reservationOptionText = (x: Reservation) =>
    `${data.lines.length > 1 && x.sku ? `${x.sku} · ` : ""}${say("Free", "可用")} ${qtyIn(x.allocatableQuantity, x.salesOrderLineId)} · ${place(x.warehouseId, x.location)}`;
  const balanceOptionText = (x: Balance) =>
    `${say("Available", "可用")} ${qtyIn(x.availableQuantity, selectedLineId)} · ${place(x.warehouseId, x.location)}${x.selectable ? "" : ` · ${say("No access to this warehouse", "无此仓库的操作权限")}`}`;
  // The chosen option's figures, under its dropdown.
  const chosenLineFacts = selectedLine
    ? say(
        `Ordered ${qtyIn(selectedLine.orderedQuantity, selectedLine.id)} · Reserved ${formatQuantity(selectedLine.reservedQuantity)} · Shipped ${formatQuantity(selectedLine.fulfilledQuantity)} · To reserve ${selectedLine.remainingToReserve == null ? copy("受限") : formatQuantity(selectedLine.remainingToReserve)}`,
        `订购 ${qtyIn(selectedLine.orderedQuantity, selectedLine.id)} · 已预留 ${formatQuantity(selectedLine.reservedQuantity)} · 已发货 ${formatQuantity(selectedLine.fulfilledQuantity)} · 待预留 ${selectedLine.remainingToReserve == null ? copy("受限") : formatQuantity(selectedLine.remainingToReserve)}`,
      )
    : "";
  const chosenBalance = balanceOptions.find((row) => row.id === selectedBalanceId);
  const chosenBalanceFacts = chosenBalance
    ? say(
        `On hand ${formatQuantity(chosenBalance.onHandQuantity)} · Reserved ${formatQuantity(chosenBalance.reservedQuantity)} · Available ${qtyIn(chosenBalance.availableQuantity, selectedLineId)}`,
        `在手 ${formatQuantity(chosenBalance.onHandQuantity)} · 已预留 ${formatQuantity(chosenBalance.reservedQuantity)} · 可用 ${qtyIn(chosenBalance.availableQuantity, selectedLineId)}`,
      )
    : "";
  const chosenReservation = data.reservations.find((row) => row.id === selectedReservationId);
  const chosenReservationFacts = chosenReservation
    ? say(
        `Reserved ${qtyIn(chosenReservation.reservedQuantity, chosenReservation.salesOrderLineId)} · On shipments ${formatQuantity(chosenReservation.allocatedQuantity)} · Shipped ${formatQuantity(chosenReservation.consumedQuantity)} · Released ${formatQuantity(chosenReservation.releasedQuantity)} · Free ${formatQuantity(chosenReservation.allocatableQuantity)}`,
        `预留 ${qtyIn(chosenReservation.reservedQuantity, chosenReservation.salesOrderLineId)} · 已分配到发货单 ${formatQuantity(chosenReservation.allocatedQuantity)} · 已发货 ${formatQuantity(chosenReservation.consumedQuantity)} · 已释放 ${formatQuantity(chosenReservation.releasedQuantity)} · 可用 ${formatQuantity(chosenReservation.allocatableQuantity)}`,
      )
    : "";
  // Lines that need more than the stock they can draw on: the shortage the
  // order page names, with where to replenish it.
  const shortLines = cancelled || shippedInFull
    ? []
    : data.lines.flatMap((line) => {
        const available = data.availability.find((row) => row.salesOrderLineId === line.id)?.totalAvailable;
        const short = lineShortfall(line.remainingToReserve, available);
        return short ? [{ line, short }] : [];
      });
  // Customer invoices on the order, when the reader may read them; how much of
  // what was shipped they bill.
  const invoices = data.invoices ?? null,
    invoicedUnits = data.lines.reduce((sum, line) => sum + (quantityUnits(line.invoicedQuantity) ?? 0n), 0n),
    shippedUnits = data.lines.reduce((sum, line) => sum + (quantityUnits(line.fulfilledQuantity) ?? 0n), 0n),
    invoicing = invoices === null ? null : invoicingState(unitsToPlain(shippedUnits), unitsToPlain(invoicedUnits));
  // Each balance link opens the inventory page filtered to one SKU, where
  // the server sends no single filter for several balances.
  const balanceSkus = [...new Set(data.availability.filter((row) => row.balances.length).map((row) => data.lines.find((line) => line.id === row.salesOrderLineId)?.sku).filter(Boolean) as string[])];
  const closeDialog = () => {
    setIntent("");
    setPreview(null);
    setCancelPreview(null);
    setFieldIssue({});
  };
  // A refusal about quantities says how much there is (the server's
  // message names no figure).
  const availabilityIssue = (issue: { code: string }) => {
    if (issue.code === "RESERVATION_INSUFFICIENT_AVAILABLE" && selectable)
      return say(
        `Available at ${place(selectable.warehouseId, selectable.location)}: ${inUnit(selectable.availableQuantity, "en-US")}.`,
        `${place(selectable.warehouseId, selectable.location)} 可用：${inUnit(selectable.availableQuantity, "zh-CN")}。`,
      );
    if (issue.code === "RESERVATION_OVER_ORDERED" && selectedLine?.remainingToReserve != null)
      return say(`Still to reserve on this line: ${inUnit(selectedLine.remainingToReserve, "en-US")}.`, `该订单行待预留：${inUnit(selectedLine.remainingToReserve, "zh-CN")}。`);
    if ((issue.code === "SHIPMENT_RESERVATION_INSUFFICIENT" || issue.code === "SHIPMENT_OVER_FULFILLMENT") && releasable)
      return say(`Free on this reservation: ${inUnit(releasable.allocatableQuantity, "en-US")}.`, `该预留可用：${inUnit(releasable.allocatableQuantity, "zh-CN")}。`);
    return "";
  };
  // One primary action in the header: the next step for the order.
  const primaryAction = a.canConfirm
    ? "confirm"
    : a.canResume
      ? "resume"
      : a.canCreateShipment
        ? "shipment"
        : a.canReserve
          ? "reserve"
          : "";
  const toneFor = (action: string) => (action === primaryAction ? "primary" : "secondary");
  // The order total and quantities for the header, from the lines as read.
  const total = orderTotal(data.lines),
    money = (value: number) =>
      formatLocaleAmount(value, data.order.currency, locale, { maximumFractionDigits: 2 }),
    lineUnits = [...new Set(data.lines.map((line) => line.unit).filter(Boolean))],
    orderedUnits = data.lines.reduce((sum, line) => sum + (decimalUnits(line.orderedQuantity) ?? 0n), 0n),
    orderedText = formatQuantity(unitsText(orderedUnits));
  // Reservations, shipments, movements and evidence: a section with records is
  // shown in full; the empty ones share one short line where the first of them
  // would be, with the order's next step when the page knows it.
  const recordSections = [
    { id: "reservations", empty: !data.reservations.length, name: say("reservations", "预留记录") },
    { id: "shipments", empty: !data.shipments.length, name: say("shipments", "发货单") },
    { id: "movements", empty: !data.movements.length, name: say("inventory movements", "库存流水") },
    { id: "evidence", empty: !data.evidence.length, name: say("evidence events", "证据事件") },
  ];
  const emptySections = recordSections.filter((section) => section.empty),
    emptyNames = emptySections.map((section) => section.name),
    emptyList =
      emptyNames.length < 2
        ? emptyNames.join("")
        : say(
            `${emptyNames.slice(0, -1).join(", ")} or ${emptyNames[emptyNames.length - 1]}`,
            `${emptyNames.slice(0, -1).join("、")}和${emptyNames[emptyNames.length - 1]}`,
          );
  const emptyNextStep = (() => {
    const workflow = data.order.workflowStatus;
    if (!emptySections.length) return "";
    if (workflow === "cancelled") return say("The order was cancelled.", "订单已取消。");
    if (a.canConfirm) return say(`Next: ${copy("确认订单")}.`, `下一步：${copy("确认订单")}。`);
    if (workflow === "draft") return say("Stock can be reserved once the order is confirmed.", "订单确认后才能预留库存。");
    if (workflow === "on_hold")
      return say("The order is on hold. Resume it before reserving or shipping.", "订单已暂停，恢复后才能预留或发货。");
    if (!data.reservations.length) {
      if (a.canReserve) return say(`Next: ${copy("预留库存")}.`, `下一步：${copy("预留库存")}。`);
      if (((a.blockingReasonCodes as string[]) || []).includes("WAREHOUSE_SCOPE_DENIED"))
        return copy(codeMessages.WAREHOUSE_SCOPE_DENIED);
      if (data.availability.every((row) => !hasQuantity(row.totalAvailable)))
        return say("No stock is available to reserve.", "暂无可预留的库存。");
      return "";
    }
    if (!data.shipments.length && a.canCreateShipment)
      return say(`Next: ${copy("创建发货草稿")}.`, `下一步：${copy("创建发货草稿")}。`);
    if (
      !data.movements.length &&
      data.shipments.some((x) => x.workflowStatus !== "cancelled" && x.postingStatus === "unposted")
    )
      return say("Stock moves when a shipment is posted.", "发货单过账后才会产生库存流水。");
    return "";
  })();
  // A reservation's line, for its SKU; a movement's shipment, for its number.
  const lineSku = (lineId: string) => data.lines.find((line) => line.id === lineId)?.sku || "—",
    shipmentNumbers = new Map(data.shipments.map((shipment) => [shipment.id, shipment.shipmentNumber]));
  const roleViewOnly = ((a.blockingReasonCodes as string[]) || []).includes("PERMISSION_DENIED"),
    balanceRows = data.availability.flatMap((row) =>
      row.balances.map((balance) => ({ lineId: row.salesOrderLineId, sku: lineSku(row.salesOrderLineId), balance })),
    );
  // What a fulfillment check is about: an order line, a stock balance, a
  // reservation or a shipment, by SKU, place or number.
  const checkSubject = (check: ReconciliationCheck) => {
    const id = check.affectedEntity.id;
    if (check.affectedEntity.type === "SalesOrderLine") return lineSku(id);
    if (check.affectedEntity.type === "InventoryBalance") {
      const found = balanceRows.find((row) => row.balance.id === id);
      return found ? `${found.sku} · ${place(found.balance.warehouseId, found.balance.location)}` : "—";
    }
    if (check.affectedEntity.type === "InventoryReservation") {
      const reservation = data.reservations.find((row) => row.id === id);
      return reservation ? `${reservation.sku || lineSku(reservation.salesOrderLineId)} · ${place(reservation.warehouseId, reservation.location)}` : "—";
    }
    const shipmentId = check.evidenceLinks?.find((link) => link.type === "shipment")?.id;
    return (shipmentId && shipmentNumbers.get(shipmentId)) || say("Shipment line", "发货行");
  };
  const sectionBody: Record<string, () => React.ReactNode> = {
    reservations: () => (
      <Section id="reservations" title={copy("预留记录")} key="reservations">
        <Collapsible total={data.reservations.length} testId="reservations-show-all">
          {(count) => (
            <Table
              rows={data.reservations.slice(0, count).map((x) => [
                x.sku || lineSku(x.salesOrderLineId),
                warehouseName(x.warehouseId),
                x.location || copy("默认库位"),
                formatQuantity(x.reservedQuantity),
                formatQuantity(x.allocatedQuantity),
                formatQuantity(x.consumedQuantity),
                formatQuantity(x.releasedQuantity),
                formatQuantity(x.allocatableQuantity),
                status(x.status),
              ])}
              numeric={[3, 4, 5, 6, 7]}
              headers={[
                "SKU",
                copy("仓库"),
                copy("库位"),
                copy("预留量"),
                copy("已分配"),
                copy("已消耗"),
                copy("已释放"),
                copy("可释放"),
                copy("状态"),
              ]}
            />
          )}
        </Collapsible>
      </Section>
    ),
    shipments: () => (
      <Section id="shipments" title={copy("发货单")} key="shipments">
        <Collapsible total={data.shipments.length}>
          {(count) => (
            <div className="space-y-2">
              {data.shipments.slice(0, count).map((x) => {
                // The invoices that bill a posted shipment, by number, for a
                // reader who may read them (the invoices are linked below).
                const billed = (invoices || []).filter((invoice) => invoice.shipmentId === x.id);
                return (
                  <Link
                    data-testid={`shipment-${x.id}`}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-lg border p-3 text-sm text-blue-700"
                    to={`/app/sales/shipments/${encodeURIComponent(x.id)}`}
                    key={x.id}
                  >
                    <span>{x.shipmentNumber}</span>
                    <span className="flex flex-wrap items-center gap-2">
                      {invoices && x.postingStatus === "posted" && (
                        <span className="text-xs text-slate-500" data-testid={`shipment-invoices-${x.id}`}>
                          {billed.length
                            ? billed.map((invoice) => `${invoice.invoiceNumber} · ${invoiceStatus(invoice)}`).join(", ")
                            : say("Not invoiced", "未开票")}
                        </span>
                      )}
                      <span>{status(shipmentStatus(x))}</span>
                    </span>
                  </Link>
                );
              })}
            </div>
          )}
        </Collapsible>
      </Section>
    ),
    movements: () => (
      <Section id="movements" title={copy("库存流水")} key="movements">
        <Collapsible total={data.movements.length} testId="movements-show-all">
          {(count) => (
            <Table
              rows={data.movements.slice(0, count).map((x) => [
                (x.sourceDocumentId && shipmentNumbers.get(x.sourceDocumentId)) || "—",
                x.sku,
                warehouseName(x.warehouseId),
                formatQuantity(x.quantityIn),
                formatQuantity(x.quantityOut),
                movementTypeLabel(x.movementType, activeLanguage),
              ])}
              numeric={[3, 4]}
              headers={[say("Shipment", "发货单"), "SKU", copy("仓库"), copy("入"), copy("出"), copy("类型")]}
            />
          )}
        </Collapsible>
      </Section>
    ),
    evidence: () => (
      <Section id="evidence" title={copy("订单证据与时间线")} key="evidence">
        <Timeline rows={foldReservationAudits(data.evidence)} lookup={timelineLookup} />
      </Section>
    ),
  };
  return (
    <div className="space-y-4" data-testid="outbound-order-workbench">
      {error && (
        <div role="alert" className="rounded-lg bg-red-50 p-3 text-red-700">
          {copy(error)}
        </div>
      )}
      {createdShipmentNumber && (
        <div
          role="status"
          className="rounded-lg bg-green-50 p-3 text-green-800"
          data-testid="shipment-created-number"
        >
          {say(`Shipment ${createdShipmentNumber} created.`, `已创建发货单 ${createdShipmentNumber}。`)}
        </div>
      )}
      {data.scopeCoverage.status === "partial" && (
        <div
          role="status"
          className="rounded-lg bg-amber-50 p-3 text-amber-800"
        >
          {copy("当前页面仅显示你有权查看的仓库数据，部分库存或履约事实已隐藏。")}
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
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="fc-page-title">{data.order.orderNumber}</h1>
            <div className="mt-2 flex flex-wrap gap-2" data-testid="sales-order-statuses">
              <Badge value={data.order.workflowStatus} />
              {/* Shipping uses up the reservations, so a fully shipped order
                  reads "Not reserved"; its reservation status is left out.
                  A partly shipped one with nothing held for the rest says so. */}
              {!shippedInFull &&
                (data.order.reservationStatus === "not_reserved" && data.lines.some((line) => hasQuantity(line.fulfilledQuantity)) ? (
                  <StatusChip label={say("Rest not reserved", "剩余未预留")} tone="warning" />
                ) : (
                  <Badge value={data.order.reservationStatus} />
                ))}
              <Badge value={data.order.fulfillmentStatus} />
              {invoicing && invoicing !== "nothing_shipped" && (
                <span data-testid="sales-order-invoicing-chip">
                  <StatusChip label={say(...INVOICING_STATES[invoicing].label)} tone={INVOICING_STATES[invoicing].tone} />
                </span>
              )}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {a.canEditDraft && (
              <Button
                dense
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
                dense
                tone={toneFor("confirm")}
                disabled={saving}
                testId="confirm-sales-order"
                onClick={() => void lifecycle("confirm")}
              >
                {copy("确认订单")}
              </Button>
            )}
            {a.canHold && (
              <Button
                dense
                tone="secondary"
                disabled={saving}
                testId="hold-sales-order"
                onClick={() => void holdOrder()}
              >
                {copy("暂停订单")}
              </Button>
            )}
            {a.canResume && (
              <Button
                dense
                tone={toneFor("resume")}
                disabled={saving}
                onClick={() => void lifecycle("resume")}
              >
                {copy("恢复")}
              </Button>
            )}
            {a.canCancel && (
              <Button dense tone="secondary" testId="open-cancel-order" onClick={() => { start("cancel"); setCancelReason(""); setCancelPreview(null); }}>
                {say("Cancel order", "取消订单")}
              </Button>
            )}
            {a.canReserve && (
              <Button dense tone={toneFor("reserve")} testId="open-reserve" onClick={() => start("reserve")}>
                {copy("预留库存")}
              </Button>
            )}
            {a.canRelease && (
              <Button dense tone="secondary" onClick={() => start("release")}>
                {copy("释放预留")}
              </Button>
            )}
            {a.canCreateShipment && (
              <Button
                dense
                tone={toneFor("shipment")}
                testId="open-shipment-draft"
                onClick={() => start("shipment")}
              >
                {copy("创建发货草稿")}
              </Button>
            )}
            {/* An invoice covers shipped goods, so it waits for a posted
                shipment; it is the next step once nothing else is, and is
                not offered once everything shipped is invoiced. */}
            {data.shipments.some((shipment) => shipment.postingStatus === "posted") && invoicing !== "invoiced" && (
              <InvoiceButton salesOrderId={id} primary={!primaryAction} />
            )}
            <Button dense tone="secondary" onClick={() => void refresh()} ariaLabel={copy("刷新销售订单")}>
              <RefreshCw size={13} />
            </Button>
          </div>
        </div>
        {/* The order version is an internal edit counter, so it is not shown. */}
        <dl
          data-testid="sales-order-facts"
          className={`mt-4 grid grid-cols-2 gap-x-6 gap-y-3 border-t pt-4 md:grid-cols-3 ${invoicing ? "xl:grid-cols-6" : "xl:grid-cols-5"}`}
        >
          <HeaderFact label={say("Customer", "客户")}>{data.order.customerName || "—"}</HeaderFact>
          <HeaderFact
            testId="sales-order-total"
            label={say(`Order total (${data.order.currency})`, `订单总额（${data.order.currency}）`)}
            tone={data.lines.length && total.unpriced ? "warning" : "default"}
            note={
              !data.lines.length
                ? ""
                : !total.priced
                  ? say("No line has a unit price yet.", "订单行尚无单价。")
                  : total.unpriced
                    ? say(
                        `${total.unpriced} of ${data.lines.length} lines ${total.unpriced === 1 ? "has" : "have"} no unit price · Priced lines ${money(total.amount)}`,
                        `${data.lines.length} 行中有 ${total.unpriced} 行没有单价 · 已定价行 ${money(total.amount)}`,
                      )
                    : say("Ordered quantity × unit price", "订购数量 × 单价")
            }
          >
            {!data.lines.length
              ? "—"
              : !total.priced
                ? say("Not priced", "未定价")
                : total.unpriced
                  ? say("Incomplete", "不完整")
                  : money(total.amount)}
          </HeaderFact>
          <HeaderFact
            label={say("Lines", "订单行")}
            note={
              lineUnits.length === 1
                ? say(`${orderedText} ${unitLabel(lineUnits[0], language, 2)} ordered`, `订购 ${orderedText} ${unitLabel(lineUnits[0], language)}`)
                : ""
            }
          >
            {say(`${data.lines.length} ${data.lines.length === 1 ? "line" : "lines"}`, `${data.lines.length} 行`)}
          </HeaderFact>
          <HeaderFact label={say("Promised date", "承诺交期")} tone={data.order.promisedDate ? "default" : "muted"}>
            {data.order.promisedDate ? formatCalendarDay(data.order.promisedDate, locale) : say("Not set", "未设置")}
          </HeaderFact>
          <HeaderFact label={say("Last updated", "更新时间")}>{stamp(data.order.updatedAt)}</HeaderFact>
          {invoicing && (
            <HeaderFact
              testId="sales-order-invoicing"
              label={say("Invoicing", "开票")}
              tone={invoicing === "not_invoiced" ? "warning" : invoicing === "nothing_shipped" ? "muted" : "default"}
              note={
                invoicing === "nothing_shipped"
                  ? ""
                  : invoicingProgressText(unitsToPlain(shippedUnits), unitsToPlain(invoicedUnits), lineUnits.length === 1 ? lineUnits[0] : null, language)
              }
            >
              {say(...INVOICING_STATES[invoicing].label)}
            </HeaderFact>
          )}
        </dl>
      </section>
      {shortLines.length > 0 && (
        <div role="status" className="rounded-lg bg-amber-50 p-3 text-sm text-amber-800" data-testid="sales-order-shortage">
          <p className="font-semibold">
            {say(
              `${shortLines.length === 1 ? "1 line is" : `${shortLines.length} lines are`} short of stock`,
              `${shortLines.length} 行库存不足`,
            )}
          </p>
          <ul className="mt-1 space-y-1">
            {shortLines.slice(0, FEW_ROWS).map(({ line, short }) => (
              <li key={line.id} className="flex flex-wrap items-center gap-x-2">
                <span>
                  {say(
                    `${line.sku}: ${qtyIn(short, line.id)} more than is available to reserve.`,
                    `${line.sku}：比可预留数量多 ${qtyIn(short, line.id)}。`,
                  )}
                </span>
                <BusinessEntityLink entityType="item" entityId={line.itemId} className={`text-blue-700 underline ${phoneTapClass}`}>
                  {say("Open item", "查看物料")}
                </BusinessEntityLink>
                <Link to="/app/inventory/reorder" className={`text-blue-700 underline ${phoneTapClass}`}>
                  {say("Reorder list", "补货清单")}
                </Link>
              </li>
            ))}
          </ul>
          {shortLines.length > FEW_ROWS && (
            <p className="mt-1 text-xs">{say(`And ${shortLines.length - FEW_ROWS} more lines in the table below.`, `另有 ${shortLines.length - FEW_ROWS} 行，见下表。`)}</p>
          )}
        </div>
      )}
      {invoices && invoices.length > 0 && (
        <Section title={say("Customer invoices", "销售发票")}>
          <div className="flex flex-wrap gap-2" data-testid="sales-order-invoices">
            {invoices.map((invoice) => <InvoiceLink invoice={invoice} key={invoice.id} />)}
          </div>
        </Section>
      )}
      <Section title={copy("关联记录")}>
        <div className="flex flex-wrap gap-2">
          {data.smartLinks.map((link) =>
            link.enabled ? (
              <Link
                data-testid={`smart-link-${link.targetType}`}
                className="rounded-lg border px-3 py-2 text-sm text-blue-700 outline-offset-2 focus-visible:outline"
                // The audit log names the order it is filtered to by its number.
                to={smartLinkPath(link.targetRouteId === "settings:audit" ? { ...link, filter: { entityLabel: data.order.orderNumber, ...link.filter } } : link)}
                key={link.id}
              >
                {copy(link.label)} {link.count ?? ""}
              </Link>
            ) : link.targetType === "inventory_balance" && balanceSkus.length ? (
              // Several balances: the inventory page filters on one SKU, so
              // each SKU opens it filtered.
              <span
                className="inline-flex flex-wrap items-center gap-x-2 rounded-lg border px-3 py-1 text-sm text-slate-600"
                data-testid="smart-link-inventory_balance-by-sku"
                key={link.id}
              >
                {copy(link.label)} {link.count ?? ""}
                <span className="text-xs text-slate-500">{say("Open by SKU:", "按 SKU 查看：")}</span>
                {balanceSkus.map((sku) => (
                  <Link
                    key={sku}
                    to={`/app/inventory/stock?${new URLSearchParams({ sku })}`}
                    className="inline-flex min-h-9 items-center text-blue-700 underline sm:min-h-7"
                  >
                    {sku}
                  </Link>
                ))}
              </span>
            ) : (
              <span
                aria-disabled="true"
                title={link.unavailableReason ? copy(link.unavailableReason) : ""}
                className="rounded-lg border px-3 py-2 text-sm text-slate-500"
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
        {/* On a phone each line is a card: the SKU, item and unit price, then
            each quantity with its label (workbenchTable.ts). */}
        <PagedRows rows={data.lines} resetKey={data.order.id} testId="sales-order-lines-pager">{(pageLines) => (
        <div className="overflow-x-auto" ref={listTableCardsRef} data-testid="sales-order-lines-table">
          <table className={`w-full min-w-[900px] ${tableBodyTextClass}`}>
            <thead>
              <tr style={listHeadRowStyle}>
                {[
                  copy("SKU / 物料"),
                  copy("订购"),
                  copy("已预留"),
                  copy("已履约"),
                  // Invoiced: for a reader who may read customer invoices.
                  ...(invoices ? [say("Invoiced", "已开票")] : []),
                  copy("待预留"),
                  copy("待履约"),
                  copy("在手量"),
                  copy("库存预留"),
                  copy("可用量"),
                ].map((x, index) => (
                  <th className={index === 0 ? thClass : thRightClass} style={{ color: A.sub }} key={x}>
                    {x}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {pageLines.map((line, lineIndex) => {
                const av = data.availability.find(
                  (x) => x.salesOrderLineId === line.id,
                );
                const short = shortLines.find((entry) => entry.line.id === line.id)?.short;
                return (
                  <tr className={listRowClass} style={listRowStyle(lineIndex, pageLines.length)} key={line.id}>
                    <td className="px-4 py-3">
                      <BusinessEntityLink entityType="item" entityId={line.itemId} className={phoneTapClass}>
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
                          : `${say("Unit price", "单价")} ${formatLocaleAmount(Number(line.unitPrice), data.order.currency, locale, { maximumFractionDigits: 4 })}`}
                      </div>
                      {short && (
                        <div className="text-xs font-medium text-amber-700" data-testid="sales-order-line-short">
                          {say(`Short by ${qtyIn(short, line.id)}`, `缺 ${qtyIn(short, line.id)}`)}
                        </div>
                      )}
                    </td>
                    {[
                      line.orderedQuantity,
                      line.reservedQuantity,
                      line.fulfilledQuantity,
                      ...(invoices ? [line.invoicedQuantity ?? "0"] : []),
                      line.remainingToReserve ?? null,
                      line.remainingToFulfill ?? null,
                      av?.totalOnHand,
                      av?.totalReserved,
                      av?.totalAvailable,
                    ].map((v, i, all) => (
                      <td className={tdNumericRightClass} key={i}>
                        {/* The two "still to" columns read "Limited" for a reader who sees only some warehouses. */}
                        {v == null ? (i === all.length - 5 || i === all.length - 4 ? copy("受限") : "—") : formatQuantity(v)}
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        )}</PagedRows>
        {/* Each stock balance for a line: where it is, its quantities and,
            when this user may not use it, why. Only an order still to be
            reserved or shipped lists them; the table above has the totals. */}
        {!shippedInFull && !cancelled && balanceRows.length > 0 && (
          <div className="mt-4" data-testid="availability-balances">
            <h3 className="text-xs font-semibold text-slate-600">{say("Stock by location", "按库位的库存")}</h3>
            <Collapsible total={balanceRows.length} testId="availability-show-all">
              {(count) =>
                balanceRows.slice(0, count).map(({ sku, lineId, balance: b }) => (
                  <div
                    data-testid="availability-balance"
                    className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 rounded-lg bg-slate-50 px-4 py-2 text-xs md:grid-cols-[minmax(0,0.8fr)_minmax(0,1.6fr)_repeat(3,minmax(0,0.8fr))_minmax(0,2fr)]"
                    key={`${lineId}-${b.id}`}
                  >
                    <span className="font-medium text-slate-700">{sku}</span>
                    <span>{place(b.warehouseId, b.location)}</span>
                    <span className="tabular-nums">{copy("在手 {n}").replace("{n}", formatQuantity(b.onHandQuantity))}</span>
                    <span className="tabular-nums">{copy("预留 {n}").replace("{n}", formatQuantity(b.reservedQuantity))}</span>
                    <span className="tabular-nums">{copy("可用 {n}").replace("{n}", formatQuantity(b.availableQuantity))}</span>
                    <span className="text-slate-500">
                      {!b.selectable
                        ? say("View only: no access to this warehouse", "只读：无此仓库的操作权限")
                        : roleViewOnly
                          ? say("View only: your role cannot reserve or ship", "只读：当前角色不能预留或发货")
                          : ""}
                    </span>
                  </div>
                ))
              }
            </Collapsible>
          </div>
        )}
      </Section>
      {recordSections.map((section) =>
        !section.empty ? (
          sectionBody[section.id]()
        ) : section === emptySections[0] ? (
          <section
            key="empty-records"
            data-testid="sales-order-empty-records"
            className="rounded-xl border bg-white px-4 py-3 shadow-sm"
          >
            {/* The empty sections keep their anchors, so a link to one lands here. */}
            {emptySections.map((empty) => (
              <span id={empty.id} className="block scroll-mt-20" key={empty.id} />
            ))}
            <p className="text-sm text-slate-500">
              <span className="font-medium text-slate-700">
                {say(`No ${emptyList} yet.`, `暂无${emptyList}。`)}
              </span>
              {emptyNextStep ? `${englishUi() ? " " : ""}${emptyNextStep}` : ""}
            </p>
          </section>
        ) : null,
      )}
      <Section id="reconciliation" title={copy("履约一致性检查")}>
        <div className="mb-2 flex items-center gap-2">
          {data.reconciliation.status === "mismatch" ? <AlertTriangle size={17} className="text-red-600" /> : <CheckCircle2 size={17} className="text-teal-600" />}
          <Badge value={data.reconciliation.status} />
        </div>
        {data.reconciliation.reasonCode === "PARTIAL_WAREHOUSE_SCOPE" && (
          <p className="mb-2 text-sm text-amber-700">
            {copy("完整订单对账无法在当前权限范围内确认。")}
          </p>
        )}
        <ReconciliationRules checks={data.reconciliation.checks} subject={checkSubject} />
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
                  : say("Create shipment draft", "创建发货草稿")
          }
          onClose={closeDialog}
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
                  {cancelPreview.blockingIssues.map((issue) => <div className="mt-1 text-red-700" key={issue.code} title={issue.code}>{issueMessage(issue)}</div>)}
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
              <div className="mt-4 flex flex-wrap justify-end gap-2">
                <Button tone="secondary" disabled={saving} onClick={closeDialog}>
                  {say("Keep order", "不取消")}
                </Button>
                <Button testId="cancel-order-preview-button" tone="secondary" disabled={saving} onClick={() => void previewCancellation()}>
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
              <div className="mt-4 flex flex-wrap justify-end gap-2">
                <Button tone="secondary" disabled={saving} onClick={closeDialog}>
                  {say("Cancel", "取消")}
                </Button>
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
                  {chosenLineFacts && (
                    <span className="mt-1 block text-xs text-slate-500" data-testid="dialog-line-facts">{chosenLineFacts}</span>
                  )}
                </label>
              )}
              {intent === "reserve" && (
                <label className="mt-3 block text-sm">
                  {copy("仓库 / 库位")}
                  <select
                    aria-label={copy("库存余额")}
                    className="mt-1 w-full rounded-lg border p-2"
                    value={selectedBalanceId}
                    onChange={(e) => chooseBalance(e.target.value)}
                  >
                    <option value="">{copy("请选择库存余额")}</option>
                    {balanceOptions.map((x) => (
                      <option disabled={!x.selectable} value={x.id} key={x.id}>
                        {balanceOptionText(x)}
                      </option>
                    ))}
                  </select>
                  {chosenBalanceFacts && (
                    <span className="mt-1 block text-xs text-slate-500" data-testid="dialog-balance-facts">{chosenBalanceFacts}</span>
                  )}
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
                  {chosenReservationFacts && (
                    <span className="mt-1 block text-xs text-slate-500" data-testid="dialog-reservation-facts">{chosenReservationFacts}</span>
                  )}
                </label>
              )}
              <label className="mt-3 block text-sm">
                {dialogLine()?.unit ? say(`Quantity (${unitLabel(dialogLine()?.unit, "en-US")})`, `数量（${unitLabel(dialogLine()?.unit, "zh-CN")}）`) : copy("数量")}
                <input
                  aria-label={copy("交易数量")}
                  inputMode="decimal"
                  aria-invalid={fieldIssue.quantity ? true : undefined}
                  aria-describedby={fieldIssue.quantity ? "outbound-quantity-error" : undefined}
                  className="mt-1 w-full rounded-lg border p-2"
                  value={quantity}
                  onChange={(e) => {
                    setQuantity(e.target.value);
                    setPreview(null);
                    setFieldIssue({});
                    setIntentKey(key());
                  }}
                />
                {fieldIssue.quantity && (
                  <span id="outbound-quantity-error" className="mt-1 block text-xs text-red-600" data-testid="outbound-quantity-error">
                    {fieldIssue.quantity}
                  </span>
                )}
              </label>
              {intent === "shipment" && (
                <p
                  className="mt-3 rounded-lg bg-slate-50 p-2 text-sm text-slate-600"
                  data-testid="shipment-number-on-save"
                >
                  {say("Shipment number: assigned when you save", "发货单号：保存时自动生成")}
                </p>
              )}
              {intent === "release" && (
                <label className="mt-3 block text-sm">
                  {copy("原因")}
                  <input
                    aria-label={copy("释放原因")}
                    placeholder={say("For example: the customer changed the date", "例如：客户改了交期")}
                    aria-invalid={fieldIssue.reason ? true : undefined}
                    aria-describedby={fieldIssue.reason ? "outbound-reason-error" : undefined}
                    className="mt-1 w-full rounded-lg border p-2"
                    value={reason}
                    onChange={(e) => {
                      setReason(e.target.value);
                      setPreview(null);
                      setFieldIssue({});
                      setIntentKey(key());
                    }}
                  />
                  {fieldIssue.reason && (
                    <span id="outbound-reason-error" className="mt-1 block text-xs text-red-600">
                      {fieldIssue.reason}
                    </span>
                  )}
                </label>
              )}
              {preview ? (
                <PreviewView preview={preview} lookup={previewLookup} explain={availabilityIssue} />
              ) : (
                <p className="mt-3 text-xs text-slate-500">{previewHint()}</p>
              )}
              {/* Buttons on the right, the action last (formLayout.tsx). */}
              <div className="mt-4 flex flex-wrap justify-end gap-2">
                <Button tone="secondary" testId="outbound-dialog-cancel" disabled={saving} onClick={closeDialog}>
                  {say("Cancel", "取消")}
                </Button>
                <Button
                  testId="outbound-preview"
                  tone="secondary"
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
                        : say("Create shipment draft", "创建发货草稿")}
                </Button>
              </div>
            </>
          )}
        </ActionDialog>
      )}
      {dialog.element}
    </div>
  );
}

function ShipmentDetail({ id }: { id: string }) {
  const stamp = useStamp();
  const warehouseName = useWarehouseNames();
  const place = usePlace();
  const { language } = useI18n();
  const [data, setData] = useState<ShipmentWorkbench | null>(null),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true),
    [preview, setPreview] = useState<Preview | null>(null),
    [previewing, setPreviewing] = useState(false),
    [intent, setIntent] = useState(""),
    [intentKey, setIntentKey] = useState(""),
    // Typed by the person: no prefilled reason, which would be taken before
    // the interface language is known.
    [reason, setReason] = useState(""),
    [reasonIssue, setReasonIssue] = useState(""),
    [saving, setSaving] = useState(false);
  // The breadcrumb names the shipment by its number (DN-…), not "Shipment workbench".
  useDetailCrumb(data?.shipment.shipmentNumber);
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
  // Posting needs no input, so its dialog is one confirmation: the server's
  // preview is read as it opens and says what will move. Reversing and
  // cancelling ask for a reason first.
  function start(x: string) {
    setIntent(x);
    setIntentKey(key());
    setPreview(null);
    setReason("");
    setReasonIssue("");
    if (x === "post") void loadPreview("post");
  }
  function close() {
    setIntent("");
    setPreview(null);
    setReasonIssue("");
  }
  async function loadPreview(forIntent = intent) {
    if (forIntent !== "post" && !reason.trim()) {
      setReasonIssue(
        forIntent === "reverse"
          ? say("Enter why the shipment is reversed.", "请输入冲销原因。")
          : say("Enter why the draft is cancelled.", "请输入取消原因。"),
      );
      return;
    }
    setPreviewing(true);
    try {
      setPreview(
        await apiJson(
          `/api/sales/shipments/${encodeURIComponent(id)}/${forIntent}-preview`,
          {
            method: "POST",
            body: JSON.stringify(forIntent === "post" ? {} : { reason: reason.trim() }),
          },
        ),
      );
    } catch (e) {
      setError(message(e));
    } finally {
      setPreviewing(false);
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
            ...(intent === "post" ? {} : { reason: reason.trim() }),
          }),
        },
      );
      const number = data.shipment.shipmentNumber;
      toast.success(
        intent === "post"
          ? say(`Shipment ${number} posted`, `发货单 ${number} 已过账`)
          : intent === "reverse"
            ? say(`Shipment ${number} reversed`, `发货单 ${number} 已冲销`)
            : say(`Shipment draft ${number} cancelled`, `发货草稿 ${number} 已取消`),
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
  const unitForSku = (sku: string) => data.lines.find((row) => row.sku === sku)?.unit;
  const timelineLookup: TimelineLookup = {
    language,
    reservation: (reservationId) => {
      const reservation = reservationFacts(reservationId);
      return reservation ? { place: place(reservation.warehouseId, reservation.location), unit: reservation.unit } : undefined;
    },
    warehouse: (warehouseId) => warehouseName(warehouseId) || undefined,
    unitForSku,
  };
  // This shipment's own events and stock movements; the order's other
  // shipments are on their own pages.
  const movementIds = new Set(data.movements.map((row) => row.id));
  const timeline = foldReservationAudits(
    data.evidence.filter((row) => row.entityId === data.shipment.id || movementIds.has(row.entityId)),
  );
  // An allocation's stock movements by when they were recorded, not by id.
  const movementTime = (movementId?: string | null) => {
    if (!movementId) return "—";
    const movement = data.movements.find((row) => row.id === movementId);
    return movement?.occurredAt ? stamp(movement.occurredAt) : say("Recorded", "已记录");
  };
  const posted = data.shipment.postingStatus === "posted",
    reversed = data.shipment.postingStatus === "reversed";
  // The shipment's one date: when it was reversed, posted or created.
  const dateFact = reversed && data.shipment.reversedAt
    ? { label: say("Reversed", "冲销时间"), value: stamp(data.shipment.reversedAt) }
    : data.shipment.postedAt
      ? { label: say("Posted", "过账时间"), value: stamp(data.shipment.postedAt) }
      : { label: say("Created", "创建时间"), value: data.shipment.createdAt ? stamp(data.shipment.createdAt) : "—" };
  const warehouses = [...new Set(data.allocations.map((row) => place(row.warehouseId, row.location)))];
  // How much of the posted goods customer invoices bill, for a reader who
  // may read customer invoices.
  const invoices = data.invoices ?? null;
  const postedUnits = data.lines.reduce((sum, line) => sum + (quantityUnits(line.postedQuantity) ?? 0n), 0n),
    invoicedUnits = data.lines.reduce((sum, line) => sum + (quantityUnits(line.invoicedQuantity) ?? 0n), 0n);
  const invoicing = invoices === null || !posted ? null : invoicingState(unitsToPlain(postedUnits), unitsToPlain(invoicedUnits));
  // A shipment a customer invoice holds can no longer be reversed (the
  // server refuses it), so the page offers the invoice instead.
  const invoicedAlready = Boolean(data.reversalBlockedByInvoice);
  const canReverse = data.availableActions.canReverse && !invoicedAlready;
  const canInvoice = posted && (invoicing ? invoicing !== "invoiced" : !invoicedAlready);
  const lineUnits = [...new Set(data.lines.map((line) => line.unit).filter(Boolean))];
  return (
    <div className="space-y-4" data-testid="shipment-workbench">
      {error && (
        <div role="alert" className="rounded-lg bg-red-50 p-3 text-red-700">
          {copy(error)}
        </div>
      )}
      <section className="rounded-xl border bg-white p-5">
        {/* items-start: the buttons keep their own height beside a tall heading. */}
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="fc-page-title">
              {data.shipment.shipmentNumber}
            </h1>
            <div className="mt-2 flex flex-wrap gap-2" data-testid="shipment-status">
              <Badge value={shipmentStatus(data.shipment)} />
              {invoicing && (
                <span data-testid="shipment-invoicing-chip">
                  <StatusChip label={say(...INVOICING_STATES[invoicing].label)} tone={INVOICING_STATES[invoicing].tone} />
                </span>
              )}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {data.availableActions.canCancel && (
              <Button dense tone="secondary" onClick={() => start("cancel")}>
                {copy("取消草稿")}
              </Button>
            )}
            {data.availableActions.canPost && (
              <Button dense testId="open-post" onClick={() => start("post")}>
                {copy("过账发货")}
              </Button>
            )}
            {/* Once posted, invoicing the goods is the next step; reversing is
                an undo, offered beside it until an invoice bills them. */}
            {canInvoice && <InvoiceButton shipmentId={id} primary />}
            {canReverse && (
              <Button dense testId="open-reverse" tone="dangerOutline" onClick={() => start("reverse")}>
                {copy("冲销发货")}
              </Button>
            )}
          </div>
        </div>
        {/* The shipment version is an internal edit counter, so it is not shown. */}
        <dl data-testid="shipment-facts" className="mt-4 grid grid-cols-2 gap-x-6 gap-y-3 border-t pt-4 md:grid-cols-4">
          <HeaderFact label={say("Sales order", "销售订单")} testId="shipment-sales-order">
            <Link
              className={`text-blue-600 underline ${phoneTapClass}`}
              to={`/app/sales/orders/${encodeURIComponent(data.shipment.salesOrderId)}`}
            >
              {data.salesOrder.orderNumber}
            </Link>
          </HeaderFact>
          <HeaderFact label={say("Customer", "客户")} testId="shipment-customer">
            {data.salesOrder.customerName || "—"}
          </HeaderFact>
          <HeaderFact label={say("Ships from", "发货仓库")} testId="shipment-warehouse">
            {warehouses.length ? warehouses.join(", ") : "—"}
          </HeaderFact>
          <HeaderFact label={dateFact.label} testId="shipment-date">
            {dateFact.value}
          </HeaderFact>
          {invoices && invoices.length > 0 && (
            <HeaderFact label={say("Customer invoice", "销售发票")} testId="shipment-invoices">
              <span className="flex flex-wrap gap-2">
                {invoices.map((invoice) => <InvoiceLink invoice={invoice} key={invoice.id} />)}
              </span>
            </HeaderFact>
          )}
        </dl>
        {reversed && data.shipment.reversalReason && (
          <p className="mt-3 text-xs text-slate-500" data-testid="shipment-reversal-reason">
            {say(`Reversal reason: ${data.shipment.reversalReason}`, `冲销原因：${data.shipment.reversalReason}`)}
          </p>
        )}
        {posted && invoicedAlready && data.availableActions.canReverse && (
          <p className="mt-3 text-xs text-slate-500" data-testid="shipment-reverse-blocked">
            {say(
              "A customer invoice bills this shipment, so it can no longer be reversed. To take the goods back, use a customer return and credit note.",
              "已有销售发票对此发货开票，不能再冲销。如需收回货物，请使用客户退货和贷项通知单。",
            )}
          </p>
        )}
      </section>
      <Section title={copy("发货行")}>
        <Table
          headers={[copy("SKU / 物料"), copy("请求数量"), copy("已过账"), ...(invoices ? [say("Invoiced", "已开票")] : []), copy("单位")]}
          rows={data.lines.map((x) => [
            `${x.sku} · ${x.itemName}`,
            formatQuantity(x.requestedQuantity),
            formatQuantity(x.postedQuantity),
            ...(invoices ? [formatQuantity(x.invoicedQuantity ?? "0")] : []),
            unitLabel(x.unit, language, Number(x.requestedQuantity)),
          ])}
        />
        {invoicing === "partly_invoiced" && (
          <p className="mt-2 text-xs text-slate-500" data-testid="shipment-invoicing-progress">
            {invoicingProgressText(unitsToPlain(postedUnits), unitsToPlain(invoicedUnits), lineUnits.length === 1 ? lineUnits[0] : null, language)}
          </p>
        )}
      </Section>
      <Section title={copy("分配与库存流水")}>
        <Collapsible total={data.allocations.length} testId="allocations-show-all">
          {(count) => (
            <Table
              headers={[
                "SKU",
                copy("仓库"),
                copy("库位"),
                copy("数量"),
                copy("状态"),
                copy("出库流水"),
                copy("冲销流水"),
              ]}
              rows={data.allocations.slice(0, count).map((x) => [
                x.sku || onlyLine?.sku || "—",
                warehouseName(x.warehouseId),
                x.location || copy("默认库位"),
                formatQuantity(x.quantity),
                status(x.status),
                movementTime(x.movementLink),
                movementTime(x.reversalMovementLink),
              ])}
            />
          )}
        </Collapsible>
        <Collapsible total={data.movements.length} testId="shipment-movements-show-all">
          {(count) =>
            data.movements.slice(0, count).map((x) => {
              // What moved, in words: goods out on posting, back in on a reversal.
              const out = quantityUnits(x.quantityOut) ?? 0n;
              const moved = quantityWithUnit(out > 0n ? x.quantityOut : x.quantityIn, unitForSku(x.sku), language);
              return (
                <div className="mt-2 rounded-lg bg-slate-50 p-2 text-xs" data-testid="shipment-movement" key={x.id}>
                  {movementTypeLabel(x.movementType, activeLanguage)} · {x.sku} · {x.itemName} · {place(x.warehouseId, x.location)} ·{" "}
                  {out > 0n ? say(`${moved} shipped out`, `出库 ${moved}`) : say(`${moved} back in stock`, `退回库存 ${moved}`)}
                </div>
              );
            })
          }
        </Collapsible>
      </Section>
      <Section title={copy("发货证据与时间线")}>
        <Timeline rows={timeline} lookup={timelineLookup} />
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
                : say("Cancel shipment draft", "取消发货草稿")
          }
          onClose={close}
        >
          {intent !== "post" && (
            <label className="block text-sm">
              {copy("原因")}
              <input
                aria-label={copy("操作原因")}
                placeholder={
                  intent === "reverse"
                    ? say("For example: wrong items picked", "例如：拣错了货")
                    : say("For example: the customer asked to wait", "例如：客户要求暂缓发货")
                }
                aria-invalid={reasonIssue ? true : undefined}
                aria-describedby={reasonIssue ? "shipment-reason-error" : undefined}
                className="mt-1 w-full rounded-lg border p-2"
                value={reason}
                onChange={(e) => {
                  setReason(e.target.value);
                  setReasonIssue("");
                  setPreview(null);
                }}
              />
              {reasonIssue && (
                <span id="shipment-reason-error" className="mt-1 block text-xs text-red-600">
                  {reasonIssue}
                </span>
              )}
            </label>
          )}
          {preview ? (
            <PreviewView preview={preview} lookup={previewLookup} />
          ) : intent === "post" ? (
            <p className="mt-3 text-xs text-slate-500" data-testid="shipment-post-checking">
              {previewing ? say("Checking what posting will move…", "正在核对过账将变动的库存…") : ""}
            </p>
          ) : (
            <p className="mt-3 text-xs text-slate-500">{previewHint()}</p>
          )}
          {/* Buttons on the right, the action last (formLayout.tsx). */}
          <div className="mt-4 flex flex-wrap justify-end gap-2">
            <Button tone="secondary" testId="shipment-dialog-cancel" disabled={saving} onClick={close}>
              {intent === "cancel" ? say("Keep draft", "保留草稿") : say("Cancel", "取消")}
            </Button>
            {intent !== "post" && (
              <Button tone="secondary" testId="shipment-preview" disabled={saving || previewing} onClick={() => void loadPreview()}>
                {say("Preview", "预览")}
              </Button>
            )}
            <Button
              testId="confirm-shipment-action"
              tone={intent === "reverse" ? "danger" : "primary"}
              disabled={!preview?.allowed || saving}
              onClick={() => void execute()}
            >
              {saving
                ? copy("处理中…")
                : intent === "post"
                  ? say("Post shipment", "过账发货")
                  : intent === "reverse"
                    ? say("Reverse shipment", "冲销发货")
                    : say("Cancel shipment draft", "取消发货草稿")}
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
  numeric = [],
}: {
  headers: string[];
  rows: Array<Array<string | number>>;
  numeric?: number[];
}) {
  // On a phone each row is a card (workbenchTable.ts): the first column names
  // the record, a "Status" column sits beside it, the rest are labelled.
  return (
    <div className={tableScrollClass} ref={listTableCardsRef}>
      <table className={`w-full min-w-[760px] ${tableBodyTextClass}`}>
        <thead>
          <tr style={{ ...listHeadRowStyle, color: A.sub }}>
            {headers.map((x, j) => (
              <th className={numeric.includes(j) ? thRightClass : thClass} key={x}>
                {x}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr className={listRowClass} style={listRowStyle(i, rows.length)} key={i}>
              {row.map((x, j) => (
                <td className={numeric.includes(j) ? tdNumericRightClass : tdNumericClass} key={j}>
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
// The fulfillment checks run once per balance, line, reservation and shipment
// line, so a long order has hundreds. Each rule is one row saying how many of
// its checks match, with the ones that do not listed under it; a rule checked
// once shows its two figures.
function ReconciliationRules({
  checks,
  subject,
}: {
  checks: ReconciliationCheck[];
  subject: (check: ReconciliationCheck) => string;
}) {
  const rules = new Map<string, ReconciliationCheck[]>();
  for (const check of checks) rules.set(check.rule, [...(rules.get(check.rule) || []), check]);
  return (
    <>
      {[...rules].map(([rule, rows]) => {
        const mismatched = rows.filter((row) => row.status === "mismatch");
        const ruleStatus = mismatched.length ? "mismatch" : rows.every((row) => row.status === "matched") ? "matched" : rows[0].status;
        return (
          <div className="border-t py-2 text-xs" key={rule} data-testid="reconciliation-rule">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span className="font-medium text-slate-800">{reconciliationRuleLabel(rule)}</span>
              <Badge value={ruleStatus} />
              <span className="tabular-nums text-slate-500">
                {rows.length === 1
                  ? reconciliationFacts(rows[0])
                  : mismatched.length
                    ? say(`${mismatched.length} of ${rows.length} checks do not match`, `${rows.length} 项检查中 ${mismatched.length} 项不一致`)
                    : say(`${rows.length} checks, all match`, `${rows.length} 项检查全部一致`)}
              </span>
            </div>
            {rows.length > 1 && mismatched.length > 0 && (
              <Collapsible total={mismatched.length}>
                {(count) => (
                  <ul className="mt-1 space-y-0.5">
                    {mismatched.slice(0, count).map((row) => (
                      <li className="tabular-nums text-slate-600" key={`${row.affectedEntity.type}-${row.affectedEntity.id}`}>
                        {subject(row)} · {reconciliationFacts(row)}
                      </li>
                    ))}
                  </ul>
                )}
              </Collapsible>
            )}
          </div>
        );
      })}
    </>
  );
}
// The workbench API builds reservation and movement timeline titles when it is
// read (they are not stored); they are translated here like its other labels.
// Each summary is read by the kind of record it describes (outboundTimeline.ts):
// a reservation by its warehouse and location, a movement's SKU as written and
// its quantity with its unit; audit summaries are shown as recorded. Nothing
// is guessed from how a part looks, so an SKU of digits stays an SKU.
//
// One posting reserves, allocates and ships every line of an order, so a long
// order's timeline repeats each event once per line. A run of three or more
// of the same event is one row with its count and time span, opened to list
// the events one by one.
const RUN = 3;
function Timeline({
  rows,
  lookup,
}: {
  rows: Workbench["evidence"];
  lookup: TimelineLookup;
}) {
  const stamp = useStamp();
  const summary = (row: Workbench["evidence"][number]) => timelineSummary(row, lookup);
  const runs: Array<Workbench["evidence"]> = [];
  for (const row of rows) {
    const last = runs[runs.length - 1];
    if (last && last[0].eventType === row.eventType && last[0].title === row.title) last.push(row);
    else runs.push([row]);
  }
  const event = (x: Workbench["evidence"][number], key: string) => (
    <div className="border-l-2 border-blue-200 pl-3 text-sm" key={key}>
      <div className="font-semibold">{copy(x.title)}</div>
      <div className="text-xs text-slate-500">
        {stamp(x.occurredAt)}
        {x.summary && x.summary !== x.title ? ` · ${summary(x)}` : ""}
      </div>
    </div>
  );
  return (
    <div className="space-y-2" data-testid="outbound-timeline">
      {runs.flatMap((run, r) => {
        if (run.length < RUN) return run.map((x, i) => event(x, `${r}-${i}-${x.entityId}`));
        const first = stamp(run[0].occurredAt),
          last = stamp(run[run.length - 1].occurredAt);
        return [
          <details className="border-l-2 border-blue-200 pl-3 text-sm" key={`run-${r}`} data-testid="outbound-timeline-run">
            <summary className="cursor-pointer list-none">
              <span className="font-semibold">{copy(run[0].title)}</span>
              <span className="ml-2 rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600">
                {say(`${run.length} records`, `${run.length} 条记录`)}
              </span>
              <span className="block text-xs text-slate-500">
                {first === last ? first : `${first} – ${last}`} · <span className="text-blue-600">{say("Show each", "逐条查看")}</span>
              </span>
            </summary>
            <div className="mt-2 space-y-2">
              <Collapsible total={run.length} few={10}>
                {(count) => run.slice(0, count).map((x, i) => event(x, `${r}-${i}-${x.entityId}`))}
              </Collapsible>
            </div>
          </details>,
        ];
      })}
      {!rows.length && <p className="text-sm text-slate-500">{copy("暂无证据事件。")}</p>}
    </div>
  );
}
const previewHint = () =>
  say("Preview first to see what will change.", "请先预览，查看将发生的变更。");
// What the server's preview will do, in plain sentences built from the
// preview itself. Why it is blocked, when it is. The impact counts stay
// available under "Technical details".
function PreviewView({
  preview,
  lookup,
  explain,
}: {
  preview: Preview;
  lookup: OutboundPreviewLookup;
  // A sentence after a blocking issue, with the figures it is about.
  explain?: (issue: { code: string; message: string }) => string;
}) {
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
        <div className="mt-1 text-red-700" key={`${x.code}-${i}`} data-testid="outbound-preview-issue">
          {issueMessage(x)}
          {explain?.(x) ? ` ${explain(x)}` : ""}
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
        <div className="mb-4 flex items-start justify-between gap-3">
          <h2 className="font-semibold">{title}</h2>
          {/* A 36 px target, not just the glyph. */}
          <button
            type="button"
            aria-label={copy("关闭")}
            onClick={onClose}
            className="-mr-2 -mt-2 inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100"
          >
            <X size={18} aria-hidden />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
