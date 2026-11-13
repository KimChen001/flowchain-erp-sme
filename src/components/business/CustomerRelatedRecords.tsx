import { useEffect, useState } from "react";
import { Link } from "react-router";
import { AlertTriangle, Plus, Wallet } from "lucide-react";
import { apiJson } from "../../lib/api-client";
import { formatCalendarDay, formatLocaleAmount } from "../../lib/format";
import { usePermissionSet } from "../../lib/usePermissionSet";
import { useRouteAvailability } from "../../app/routeAvailability";
import { useI18n } from "../../i18n/I18n";
import { ActionableMetricCard } from "../cards/ActionableMetricCard";
import { A } from "../ui";
import { ListCard, ListStateRow, StatusChip, listButtonClass, listHeadRowStyle, listRowClass, listRowStyle, statusToneOf } from "../ui/listLayout";
import { tableBodyTextClass, tableLinkClass, tableScrollClass, tdIdClass, tdNowrapClass, tdNumericRightClass, thClass, thRightClass } from "../ui/workbenchTable";

// What a customer's page shows besides its master fields: its recent sales
// orders and customer invoices, what it still owes, and a new order for it.
// Everything is read through the lists the sales and finance pages use, with
// their own permission checks; a section the reader may not see is left out.
//   - Orders: GET /api/sales/orders?customer=<name> (sales_order.read).
//   - Invoices: GET /api/finance/customer-invoices?search=<name>
//     (finance.customer_invoice.read). Amounts arrive null without
//     finance.amounts.read and show as a dash.
//   - Balance: GET /api/finance/aging, every receivable still owed in the
//     workspace (finance.receivable.read), shown only with finance.amounts.read.
// Both lists match the name as text, so each row is kept only when its
// customer id is this customer's (or, for a row without one, its name is).
// Amounts are added per currency and never across currencies.

export type CustomerSummary = { id: string; code: string; name: string; status: string };

type OrderLine = { amount?: string | null };
type Order = {
  id: string;
  orderNumber: string;
  customerId?: string | null;
  customerName?: string | null;
  currency: string;
  workflowStatus: string;
  fulfillmentStatus: string;
  promisedDate?: string | null;
  createdAt?: string | null;
  lines?: OrderLine[];
};
type Invoice = {
  id: string;
  invoiceNumber: string;
  customerId?: string | null;
  customerName?: string | null;
  invoiceDate?: string | null;
  dueDate?: string | null;
  totalAmount?: string | null;
  currency: string;
  status: string;
  // Once issued, where its payment stands (the invoice list's paymentStatus).
  paymentStatus?: string | null;
};
type Receivable = {
  customerInvoiceId: string;
  customerId?: string | null;
  customerName?: string | null;
  outstandingAmount?: string | null;
  currency: string;
  status: string;
  overdueDays?: number;
};
type Load<T> = { state: "loading" | "ready" | "error" | "hidden"; rows: T[] };

// Recent records shown on the page; the full lists are a link away.
const RECENT = 5;
// The receivables list's overdue rule (overdueReceivableWhere): past due,
// still owed and not disputed.
const OVERDUE_STATUSES = new Set(["open", "partially_settled", "overdue"]);

const COPY = {
  orders: ["Recent sales orders", "最近的销售订单"],
  invoices: ["Recent customer invoices", "最近的销售发票"],
  allOrders: ["All orders", "全部订单"],
  allInvoices: ["All invoices", "全部发票"],
  newOrder: ["New sales order", "新建销售订单"],
  number: ["Number", "单号"],
  created: ["Created", "创建日期"],
  promised: ["Promised", "承诺交期"],
  status: ["Status", "状态"],
  amount: ["Amount", "金额"],
  invoiceDate: ["Invoice date", "开票日期"],
  dueDate: ["Due date", "到期日"],
  open: ["Still owed", "未收金额"],
  noOrders: ["No sales orders for this customer yet.", "该客户还没有销售订单。"],
  noInvoices: ["No customer invoices for this customer yet.", "该客户还没有销售发票。"],
  loadFailed: ["This list could not be loaded.", "列表加载失败。"],
  balance: ["Open balance", "未收余额"],
  overdue: ["Overdue", "逾期金额"],
  nothingOwed: ["Nothing owed", "没有未收款"],
  noneOverdue: ["None", "无"],
  notPriced: ["Not priced", "未定价"],
} satisfies Record<string, [string, string]>;

// Order statuses as one word: cancelled, draft and on hold say so; a
// confirmed order says how far it has shipped.
const ORDER_STATUS: Record<string, [string, string]> = {
  draft: ["Draft", "草稿"],
  cancelled: ["Cancelled", "已取消"],
  on_hold: ["On hold", "已暂停"],
  confirmed: ["Confirmed", "已确认"],
  partially_fulfilled: ["Partly shipped", "部分发货"],
  fully_fulfilled: ["Shipped", "已发货"],
};
const orderStatusCode = (order: Order) =>
  order.workflowStatus === "confirmed" && ["partially_fulfilled", "fully_fulfilled"].includes(order.fulfillmentStatus)
    ? order.fulfillmentStatus
    : order.workflowStatus;
// A customer invoice's own words: "issued" reads 已开具 on an invoice.
// An issued invoice shows To be paid, Partly paid or Paid; the stored status
// does not change.
const shownInvoiceStatus = (invoice: { status: string; paymentStatus?: string | null }) => (invoice.status === "issued" && invoice.paymentStatus ? invoice.paymentStatus : invoice.status);

const INVOICE_STATUS: Record<string, [string, string]> = {
  draft: ["Draft", "草稿"],
  submitted: ["Submitted", "已提交"],
  approved: ["Approved", "已批准"],
  issued: ["Issued", "已开具"],
  // An issued invoice reads where its payment stands, as on the invoice page.
  to_be_paid: ["To be paid", "待收款"],
  partially_settled: ["Partly paid", "部分付款"],
  settled: ["Paid", "已结清"],
  disputed: ["Disputed", "有争议"],
  cancelled: ["Cancelled", "已取消"],
  voided: ["Void", "已作废"],
  void: ["Void", "已作废"],
};

// Decimal strings as whole ten-thousandths, so sums stay exact.
function units(value: string | null | undefined): bigint | null {
  const match = /^(-?)(\d+)(?:\.(\d{0,4})\d*)?$/.exec(String(value ?? "").trim());
  if (!match) return null;
  const size = BigInt(match[2]) * 10000n + BigInt((match[3] || "").padEnd(4, "0") || "0");
  return match[1] ? -size : size;
}
const toNumber = (value: bigint) => Number(value) / 10000;

// Totals per currency, in the order the currencies first appear.
function byCurrency<T>(rows: T[], currency: (row: T) => string, amount: (row: T) => bigint) {
  const totals = new Map<string, bigint>();
  for (const row of rows) totals.set(currency(row), (totals.get(currency(row)) || 0n) + amount(row));
  return [...totals.entries()];
}

// "New sales order" for an active customer, for a reader who may create one.
// The link carries ?customerId=; the order form starts with this customer
// chosen once it reads that (src/modules/sales/OutboundWorkbench.tsx).
export function CustomerNewOrderAction({ customer }: { customer: CustomerSummary }) {
  const { language } = useI18n();
  const permissions = usePermissionSet();
  const canOpenRoute = useRouteAvailability();
  if (!permissions?.has("sales_order.create") || !canOpenRoute("sales:order-new") || customer.status !== "active") return null;
  return (
    <Link to={`/app/sales/orders/new?customerId=${encodeURIComponent(customer.id)}`} className={listButtonClass.primary} data-testid="customer-new-sales-order">
      <Plus size={13} />{COPY.newOrder[language === "en-US" ? 0 : 1]}
    </Link>
  );
}

export function CustomerRelatedRecords({ customer }: { customer: CustomerSummary }) {
  const { language, locale } = useI18n();
  const text = (key: keyof typeof COPY) => COPY[key][language === "en-US" ? 0 : 1];
  const say = (english: string, chinese: string) => (language === "en-US" ? english : chinese);
  const pair = (value: [string, string] | undefined, fallback: string) => (value ? value[language === "en-US" ? 0 : 1] : fallback);
  const permissions = usePermissionSet();
  const canOpenRoute = useRouteAvailability();
  const may = (code: string) => Boolean(permissions?.has(code));
  const canReadOrders = may("sales_order.read");
  const canReadInvoices = may("finance.customer_invoice.read");
  const canReadBalance = may("finance.receivable.read") && may("finance.amounts.read");
  const name = customer.name.trim();
  // A row belongs to this customer by its customer id; a row recorded with a
  // name only (older orders and imports) by the same name.
  const ours = (row: { customerId?: string | null; customerName?: string | null }) =>
    row.customerId ? row.customerId === customer.id : String(row.customerName || "").trim().toLowerCase() === name.toLowerCase();
  const [orders, setOrders] = useState<Load<Order>>({ state: "loading", rows: [] });
  const [invoices, setInvoices] = useState<Load<Invoice>>({ state: "loading", rows: [] });
  const [owed, setOwed] = useState<Load<Receivable>>({ state: "loading", rows: [] });

  useEffect(() => {
    if (!permissions) return;
    let alive = true;
    const read = <T,>(allowed: boolean, url: string, pick: (payload: any) => T[], set: (value: Load<T>) => void) => {
      if (!allowed || !name) { set({ state: "hidden", rows: [] }); return; }
      set({ state: "loading", rows: [] });
      apiJson<any>(url)
        .then((payload) => { if (alive) set({ state: "ready", rows: pick(payload) }); })
        .catch(() => { if (alive) set({ state: "error", rows: [] }); });
    };
    const query = encodeURIComponent(name);
    read<Order>(canReadOrders, `/api/sales/orders?customer=${query}&pageSize=20&sort=updatedAt&direction=desc`, (payload) => (payload.orders || []).filter(ours), setOrders);
    read<Invoice>(canReadInvoices, `/api/finance/customer-invoices?search=${query}&pageSize=20`, (payload) => (payload.items || []).filter(ours), setInvoices);
    read<Receivable>(canReadBalance, "/api/finance/aging", (payload) => (payload.items || []).filter(ours), setOwed);
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [permissions, customer.id, name]);

  const money = (value: bigint, currency: string) => formatLocaleAmount(toNumber(value), currency, locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const amounts = (totals: Array<[string, bigint]>) => totals.map(([currency, value]) => money(value, currency)).join(" · ");
  const outstanding = (row: Receivable) => units(row.outstandingAmount) ?? 0n;
  const overdueRows = owed.rows.filter((row) => (row.overdueDays || 0) > 0 && OVERDUE_STATUSES.has(row.status));
  const owedByInvoice = new Map(owed.rows.map((row) => [row.customerInvoiceId, row]));
  // An order's amount from its lines, only when every line is priced.
  const orderAmount = (order: Order) => {
    const lines = order.lines || [];
    const values = lines.map((line) => units(line.amount));
    if (!lines.length || values.some((value) => value === null)) return null;
    return values.reduce<bigint>((sum, value) => sum + (value as bigint), 0n);
  };
  const searchLink = (path: string, extra = "") => `${path}?search=${encodeURIComponent(name)}${extra}`;
  const empty = (colSpan: number, load: Load<unknown>, none: string) =>
    load.state === "loading" ? <ListStateRow colSpan={colSpan} state="loading" />
      : load.state === "error" ? <ListStateRow colSpan={colSpan} state="error" title={text("loadFailed")} />
        : load.rows.length === 0 ? <ListStateRow colSpan={colSpan} state="empty" title={none} />
          : null;

  if (!permissions) return null;
  const showBalance = owed.state !== "hidden";
  return (
    <div className="space-y-4" data-testid="customer-related-records">
      {showBalance && (
        <div className="grid grid-cols-2 gap-3" data-testid="customer-balance">
          <ActionableMetricCard
            label={text("balance")}
            value={owed.state === "ready" ? (owed.rows.length ? amounts(byCurrency(owed.rows, (row) => row.currency, outstanding)) : text("nothingOwed")) : "—"}
            description={owed.state === "ready" ? say(`${owed.rows.length} ${owed.rows.length === 1 ? "invoice" : "invoices"} not paid in full`, `${owed.rows.length} 张发票未收清`) : owed.state === "error" ? text("loadFailed") : ""}
            to={searchLink("/app/finance/receivables", "&status=outstanding")}
            icon={Wallet}
            color={A.blue}
          />
          <ActionableMetricCard
            label={text("overdue")}
            value={owed.state === "ready" ? (overdueRows.length ? amounts(byCurrency(overdueRows, (row) => row.currency, outstanding)) : text("noneOverdue")) : "—"}
            description={owed.state === "ready" ? say(`${overdueRows.length} past the due date`, `${overdueRows.length} 张已过到期日`) : ""}
            to={searchLink("/app/finance/receivables", "&status=overdue")}
            icon={AlertTriangle}
            color={overdueRows.length ? A.red : A.gray1}
          />
        </div>
      )}
      {orders.state !== "hidden" && (
        <ListCard
          title={text("orders")}
          testId="customer-orders"
          right={canOpenRoute("sales:orders") ? <Link to={searchLink("/app/sales/orders")} className="text-xs font-medium text-blue-600 hover:underline max-sm:inline-flex max-sm:min-h-9 max-sm:items-center">{text("allOrders")}</Link> : undefined}
        >
          <div className={tableScrollClass}>
            <table className={`w-full min-w-[640px] text-left ${tableBodyTextClass}`}>
              <thead>
                <tr style={listHeadRowStyle}>
                  {[text("number"), text("status"), text("created"), text("promised")].map((label) => <th key={label} className={thClass} style={{ color: A.gray1 }}>{label}</th>)}
                  <th className={thRightClass} style={{ color: A.gray1 }}>{text("amount")}</th>
                </tr>
              </thead>
              <tbody>
                {empty(5, orders, text("noOrders"))}
                {orders.rows.slice(0, RECENT).map((order, index, shown) => {
                  const amount = orderAmount(order);
                  const status = orderStatusCode(order);
                  return (
                    <tr key={order.id} className={listRowClass} style={listRowStyle(index, shown.length)} data-testid="customer-order-row">
                      <td className={tdIdClass}>
                        {canOpenRoute("sales:order-detail")
                          ? <Link to={`/app/sales/orders/${encodeURIComponent(order.id)}`} className={tableLinkClass} style={{ color: A.blue }}>{order.orderNumber}</Link>
                          : order.orderNumber}
                      </td>
                      <td className={tdNowrapClass}><StatusChip label={pair(ORDER_STATUS[status], status)} tone={statusToneOf(status)} /></td>
                      <td className={tdNowrapClass} style={{ color: A.sub }}>{formatCalendarDay(order.createdAt, locale)}</td>
                      <td className={tdNowrapClass} style={{ color: A.sub }}>{formatCalendarDay(order.promisedDate, locale)}</td>
                      <td className={tdNumericRightClass}>{amount === null ? <span style={{ color: A.gray2 }}>{text("notPriced")}</span> : money(amount, order.currency)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </ListCard>
      )}
      {invoices.state !== "hidden" && (
        <ListCard
          title={text("invoices")}
          testId="customer-invoices"
          right={canOpenRoute("sales:invoices") ? <Link to={searchLink("/app/sales/invoices")} className="text-xs font-medium text-blue-600 hover:underline max-sm:inline-flex max-sm:min-h-9 max-sm:items-center">{text("allInvoices")}</Link> : undefined}
        >
          <div className={tableScrollClass}>
            <table className={`w-full min-w-[720px] text-left ${tableBodyTextClass}`}>
              <thead>
                <tr style={listHeadRowStyle}>
                  {[text("number"), text("status"), text("invoiceDate"), text("dueDate")].map((label) => <th key={label} className={thClass} style={{ color: A.gray1 }}>{label}</th>)}
                  <th className={thRightClass} style={{ color: A.gray1 }}>{text("amount")}</th>
                  {showBalance && <th className={thRightClass} style={{ color: A.gray1 }}>{text("open")}</th>}
                </tr>
              </thead>
              <tbody>
                {empty(showBalance ? 6 : 5, invoices, text("noInvoices"))}
                {invoices.rows.slice(0, RECENT).map((invoice, index, shown) => {
                  const total = units(invoice.totalAmount);
                  const open = owedByInvoice.get(invoice.id);
                  return (
                    <tr key={invoice.id} className={listRowClass} style={listRowStyle(index, shown.length)} data-testid="customer-invoice-row">
                      <td className={tdIdClass}>
                        {canOpenRoute("sales:invoice-detail")
                          ? <Link to={`/app/sales/invoices/${encodeURIComponent(invoice.id)}`} className={tableLinkClass} style={{ color: A.blue }}>{invoice.invoiceNumber}</Link>
                          : invoice.invoiceNumber}
                      </td>
                      <td className={tdNowrapClass}><StatusChip label={pair(INVOICE_STATUS[shownInvoiceStatus(invoice)], shownInvoiceStatus(invoice))} tone={shownInvoiceStatus(invoice) === "to_be_paid" ? "info" : statusToneOf(shownInvoiceStatus(invoice))} /></td>
                      <td className={tdNowrapClass} style={{ color: A.sub }}>{formatCalendarDay(invoice.invoiceDate, locale)}</td>
                      <td className={tdNowrapClass} style={{ color: A.sub }}>{formatCalendarDay(invoice.dueDate, locale)}</td>
                      <td className={tdNumericRightClass}>{total === null ? "—" : money(total, invoice.currency)}</td>
                      {showBalance && (
                        <td className={tdNumericRightClass}>
                          {/* Owed only once issued; an issued invoice with nothing outstanding owes nothing. */}
                          {owed.state !== "ready" || invoice.status !== "issued" ? "—" : money(open ? outstanding(open) : 0n, invoice.currency)}
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </ListCard>
      )}
    </div>
  );
}
