import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { AlertTriangle, CheckCircle2, FilePlus2, FileText, MessageSquareWarning, Send, Wallet } from "lucide-react";
import { Link, useLocation, useNavigate } from "react-router";
import { ApiError, apiJson } from "../../lib/api-client";
import { apiErrorView, type ApiErrorView } from "../../lib/apiErrorText";
import { BusinessEntityLink } from "../../components/business/BusinessEntityLink";
import { StatusChip, TwoStepAction, useFinanceStatusLabel } from "./FinanceControls";
import { PaymentRecords } from "./PaymentRecords";
import { useI18n } from "../../i18n/I18n";
import { A, Card, Field, inputStyle } from "../../components/ui";
import { ActionableMetricCard } from "../../components/cards/ActionableMetricCard";
import { ListCard, ListSearchCard, ListStateRow, RefreshButton, ResetButton, listButtonClass, listHeadRowStyle, listRowClass, listRowStyle, listTableCardsRef, metricGridClass, rowActionClass } from "../../components/ui/listLayout";
import { tableBodyTextClass, tableLinkClass, tableScrollClass, tdIdClass, tdNameClass, tdNowrapClass, tdNumericRightClass, thClass, thRightClass } from "../../components/ui/workbenchTable";
import { FormActionBar, FormHeader, FormLineCard, FormSection, focusFirstInvalid, formGridClass, useFormCopy } from "../../components/ui/formLayout";
import { FocusFirstField } from "../../components/ui/FocusFirstField";
import { ListPager } from "../procurement/listPaging";
import { createSecureClientMutationId } from "../../lib/client-id";
import { addCalendarDays } from "../../lib/prefill";
import { useDetailCrumb } from "../../components/navigation/detailCrumb";
import { useRouteAvailability } from "../../app/routeAvailability";
import { PREVIEW_CUSTOMER_INVOICE_STATUSES, PRINTABLE_CUSTOMER_INVOICE_STATUSES } from "../../../shared/business-documents.mjs";

// The invoice statuses whose document is worth opening: issued (to send) and
// approved (to check before issuing).
const documentStatuses: readonly string[] = [...PREVIEW_CUSTOMER_INVOICE_STATUSES, ...PRINTABLE_CUSTOMER_INVOICE_STATUSES];
import { formatCalendarDay, todayInTimeZone } from "../../lib/format";

type Capability = { enabled?: boolean; maturity?: string; reason?: string };
type Invoice = {
  id: string;
  invoiceNumber: string;
  customerName: string;
  shipmentId: string;
  shipmentNumber?: string;
  dueDate: string;
  totalAmount: string;
  currency: string;
  status: string;
  version: number;
  availableActions: string[];
};
type Receivable = {
  id: string;
  obligationNumber: string;
  customerInvoiceId?: string;
  customerInvoiceNumber?: string;
  customerName?: string;
  outstandingAmount: string;
  currency: string;
  dueDate: string;
  status: string;
  disputeStatus: string;
  externalSettlementReference?: string;
  settlementVerified: false;
  availableActions: string[];
};
type CreditNote = {
  id: string;
  creditNoteNumber: string;
  customerInvoiceNumber?: string;
  returnPostingNumber?: string;
  customerName: string;
  totalAmount: string;
  currency: string;
  status: string;
  refundExecuted: false;
};
// A page of a list: `total` counts every record the filters match, `counts`
// the metric cards over the whole workspace, `currencies` every currency.
type ListPayload<T> = {
  dataSource: string;
  items: T[];
  total: number;
  page?: number;
  pageSize?: number;
  counts?: Record<string, number>;
  currencies?: string[];
  capabilities: Record<string, Capability>;
};
type AgingPayload = {
  dataSource: string;
  timezone: string;
  currencyAggregationStatus: string;
  fxConverted: false;
  groups: Array<{
    currency: string;
    count: number;
    current: string;
    "1_30": string;
    "31_60": string;
    "61_90": string;
    "90_plus": string;
    total: string;
  }>;
};
type EntryData = {
  today?: string;
  postedShipments: Array<{
    id: string;
    shipmentNumber: string;
    salesOrderId: string;
    salesOrderNumber?: string;
    customerName: string;
    customerPaymentTerm?: { code: string; name: string; days: number } | null;
    currency: string;
    lines: Array<{
      id: string;
      sku: string;
      itemName: string;
      postedQuantity: string;
      unit?: string | null;
      unitPrice: string | null;
    }>;
  }>;
  capabilities: Record<string, Capability>;
};
type Issue = { code: string; message: string; details?: Record<string, unknown> };
type InvoicePlan = {
  allowed: boolean;
  blockingIssues: Issue[];
  invoice?: { totalAmount: string; currency: string };
  source?: { shipmentNumber: string; customerName: string };
};

// Lists are read 50 records at a time.
const PAGE_SIZE = 50;
const queryString = () => {
  const params = new URLSearchParams(window.location.search);
  // disputeStatus carries the landing page's "disputed receivables" link.
  const allowed = ["status", "disputeStatus", "currency", "search", "page"];
  const next = new URLSearchParams();
  for (const key of allowed)
    if (params.get(key)) next.set(key, params.get(key) as string);
  return next.toString();
};
// A filter is set when the address narrows the list (the page number does not).
const filtered = () => ["status", "disputeStatus", "currency", "search"].some((key) => new URLSearchParams(window.location.search).get(key));
// A hidden or missing amount is null and shows as a dash, never as 0.
const money = (value: string | null | undefined, currency: string, locale: string) =>
  value === null || value === undefined || value === "" || !Number.isFinite(Number(value))
    ? "—"
    : /^[A-Z]{3}$/.test(currency)
    ? new Intl.NumberFormat(locale, {
        style: "currency",
        currency,
        maximumFractionDigits: 4,
      }).format(Number(value))
    : `${value} ${currency}`;
const canPrepare = () => {
  try {
    const role = String(
      JSON.parse(localStorage.getItem("flowchain:current-user") || "{}").role ||
        "",
    ).toLowerCase();
    return [
      "admin",
      "manager",
      "business-specialist",
      "business_specialist",
    ].includes(role);
  } catch {
    return false;
  }
};

// A receivable still owed whose due day is before the workspace's today: the
// server's overdue rule, applied to one row. The list and the invoice page
// both use it.
const receivableOpen = (row: { status: string }) => !["settled", "cancelled", "voided"].includes(row.status);
const receivablePastDue = (row: { status: string; dueDate?: string | null }, today: string) =>
  receivableOpen(row) && Boolean(row.dueDate) && String(row.dueDate).slice(0, 10) < today;
const receivableChip = (row: { status: string; dueDate?: string | null }, today: string) =>
  receivablePastDue(row, today) && row.status === "open" ? "overdue" : row.status;
const PAST_DUE_COLOR = "#b91c1c";

function Notice({ children, title, testId }: { children: ReactNode; title?: string; testId?: string }) {
  return (
    <div className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900" title={title || undefined} data-testid={testId}>
      <AlertTriangle className="mt-0.5 shrink-0" size={16} />
      <span>{children}</span>
    </div>
  );
}

const LIST_COPY = {
  search: ["Search", "搜索"],
  searchPlaceholder: ["Number or customer, then Enter", "单号或客户，按回车查询"],
  currency: ["Currency", "币种"],
  allCurrencies: ["All currencies", "全部币种"],
  status: ["Status", "状态"],
  allStatuses: ["All statuses", "全部状态"],
  invoiceSearch: ["Customer invoice search", "销售发票查询"],
  invoiceSearchSubtitle: ["Invoices raised from posted shipments, by number, customer, currency and status.", "按单号、客户、币种和状态查询由已过账发货生成的发票。"],
  invoiceList: ["Customer invoice list", "销售发票列表"],
  receivableSearch: ["Receivable search", "应收查询"],
  receivableSearchSubtitle: ["What customers owe on issued invoices, by invoice number, customer, currency and status.", "按发票编号、客户、币种和状态查询客户在已开具发票上的欠款。"],
  receivableList: ["Receivable list", "应收列表"],
  creditSearch: ["Credit note search", "贷项通知单查询"],
  creditSearchSubtitle: ["Credit notes raised from posted customer returns, by number, customer, currency and status.", "按单号、客户、币种和状态查询由已过账的客户退货生成的贷项通知单。"],
  creditList: ["Credit note list", "贷项通知单列表"],
  toApprove: ["To approve", "待批准"],
  toApproveNote: ["Draft or submitted invoices", "草稿或已提交的发票"],
  toIssue: ["Approved, to issue", "已批准待开具"],
  toIssueNote: ["Approved and not yet sent", "已批准但尚未开具"],
  issued: ["Issued", "已开具"],
  issuedNote: ["Sent to the customer", "已发给客户"],
  overdueInvoices: ["Past due", "已逾期"],
  overdueInvoicesNote: ["Issued, past the due date and not paid in full", "已开具、已过到期日且未全额收款"],
  openReceivables: ["Open receivables", "未结应收"],
  openReceivablesNote: ["Not yet paid in full", "尚未全额收款"],
  outstandingStatus: ["Not paid in full", "未全额收款"],
  overdue: ["Overdue", "已逾期"],
  overdueNote: ["Past the due date and still open", "已过到期日且仍未结清"],
  disputed: ["Disputed", "有争议"],
  disputedNote: ["The customer has raised a dispute", "客户提出了争议"],
  settled: ["Paid", "已结清"],
  settledNote: ["Paid in full", "已全额收款"],
  number: ["Invoice number", "发票编号"],
  numberOnSave: ["Invoice number: assigned when you save", "发票编号：保存时自动生成"],
  creditNumber: ["Credit note", "贷项通知单"],
  customer: ["Customer", "客户"],
  shipment: ["Shipment", "发货单"],
  dueDate: ["Due date", "到期日"],
  amount: ["Amount", "金额"],
  outstanding: ["Outstanding", "未收金额"],
  returnPosting: ["Return posting", "退货过账"],
  invoice: ["Invoice", "发票"],
  item: ["Item", "物料"],
  actions: ["Actions", "操作"],
  view: ["View", "查看"],
  next: ["Next", "下一步"],
  noMatch: ["Nothing matches these filters", "没有符合筛选条件的记录"],
  agingTitle: ["Receivables aging", "应收账龄"],
  agingCaption: ["Aged by due date in the workspace timezone ({timezone}). Each currency is aged on its own; nothing is converted.", "按到期日、以工作区时区（{timezone}）计算账龄。各币种分别统计，不做折算。"],
  agingCurrency: ["Currency", "币种"],
  agingCount: ["Receivables", "应收笔数"],
  current: ["Current", "未到期"],
  days1: ["1–30 days", "1–30 天"],
  days31: ["31–60 days", "31–60 天"],
  days61: ["61–90 days", "61–90 天"],
  days90: ["Over 90 days", "90 天以上"],
  total: ["Total", "合计"],
  // What each list shows, and when its first record appears.
  emptyInvoices: ["No customer invoices yet", "暂无销售发票"],
  emptyInvoicesDetail: ["Customer invoices appear here once you raise one from a posted shipment.", "根据已过账的发货开具销售发票后，会显示在这里。"],
  emptyReceivables: ["No receivables yet", "暂无应收款"],
  emptyReceivablesDetail: ["A receivable is recorded when a customer invoice is issued, and stays here until it is paid in full.", "销售发票开具后会生成应收款，并在全额收款前一直显示在这里。"],
  emptyAging: ["Nothing to age yet", "暂无需要统计账龄的应收款"],
  emptyAgingDetail: ["Once customer invoices are issued, open receivables are grouped here by how far past due they are.", "销售发票开具后，未结应收款会按逾期时长在这里分组。"],
  emptyCredits: ["No credit notes yet", "暂无贷项通知单"],
  emptyCreditsDetail: ["A credit note appears here once a customer return is posted and credited.", "客户退货过账并生成贷项后，会显示在这里。"],
  loadFailed: ["Could not load this finance page. Try again.", "财务页面加载失败，请重试。"],
  invoiceFailed: ["Could not create the invoice. Check the shipment and lines, then try again.", "无法创建发票，请检查发货单和明细后重试。"],
} as const;

// The new customer invoice form's copy, and the messages for what the
// server refuses, by its codes.
const FORM_COPY = {
  intro: ["Raise an invoice from a posted shipment. Saving creates a draft to submit for approval; nothing is sent to the customer.", "根据已过账的发货开具发票。保存后生成草稿，再提交审批；不会发给客户。"],
  details: ["Invoice details", "发票信息"],
  chooseShipment: ["Choose a posted shipment", "选择正式发货单"],
  noShipments: ["No posted shipment is waiting to be invoiced.", "暂无可开票的正式发货单。"],
  lines: ["Lines", "发票行"],
  linesIntro: ["Invoice up to the shipped quantity. A line left empty or at 0 is not invoiced.", "开票数量不超过已发货数量。数量留空或为 0 的行不开票。"],
  linesEmpty: ["Choose a shipment to see its lines.", "选择发货单后显示其明细行。"],
  line: ["Line {n}", "第 {n} 行"],
  customer: ["Customer", "客户"],
  currency: ["Currency", "币种"],
  salesOrder: ["Sales order", "销售订单"],
  shipmentRequired: ["Choose the posted shipment to invoice.", "请选择要开票的正式发货单。"],
  dueRequired: ["Enter the due date.", "请填写到期日。"],
  lineRequired: ["Enter an invoice quantity on at least one line.", "请至少为一行填写开票数量。"],
  quantityInvalid: ["Enter a quantity above 0, with up to 4 decimal places.", "请填写大于 0 的数量，最多 4 位小数。"],
  quantityOver: ["More than the {shipped} shipped.", "超过已发货数量 {shipped}。"],
  taxInvalid: ["Enter a tax amount of 0 or more, with up to 4 decimal places.", "请填写不小于 0 的税额，最多 4 位小数。"],
  shipmentNotPosted: ["This shipment is no longer posted (it was reversed), so it cannot be invoiced. Choose another.", "这张发货单已不是过账状态（已冲销），不能开票。请选择其他发货单。"],
  noPrice: ["This line has no sales order price, so it cannot be invoiced. Set the price on the sales order first.", "这一行没有销售订单单价，不能开票。请先在销售订单上填写单价。"],
  sourceInvalid: ["This line no longer matches its shipment and sales order. Reload the page.", "这一行与发货单和销售订单不一致，请刷新页面。"],
  currencyMismatch: ["The invoice currency must be the sales order's currency; nothing is converted.", "发票币种必须与销售订单币种一致，不做折算。"],
} as const;

// A failed request in the interface language; the server's code stays in the tooltip.
const LOAD_FAILED = LIST_COPY.loadFailed;

function useListCopyO2c() {
  const { language } = useI18n();
  return (key: keyof typeof LIST_COPY, values: Record<string, string> = {}) =>
    LIST_COPY[key][language === "en-US" ? 0 : 1].replace(/\{(\w+)\}/g, (_, name) => values[name] ?? "");
}

// The address carries the filters and the page, as the overview cards' links
// do; the router reads the change from popstate and the list reloads. A
// change of filter starts at page 1.
const setQuery = (updates: Record<string, string>) => {
  const next = new URLSearchParams(window.location.search);
  if (!("page" in updates)) next.delete("page");
  for (const [key, value] of Object.entries(updates)) value ? next.set(key, value) : next.delete(key);
  const query = next.toString();
  window.history.pushState({}, "", `${window.location.pathname}${query ? `?${query}` : ""}`);
  window.dispatchEvent(new PopStateEvent("popstate"));
};

function Filters({ title, subtitle, statuses, currencies, onRefresh, actions, statusLabels = {} }: {
  title: string;
  subtitle: string;
  statuses: string[];
  currencies: string[];
  onRefresh: () => void;
  actions?: ReactNode;
  statusLabels?: Record<string, string>;
}) {
  const tr = useListCopyO2c();
  const statusLabel = useFinanceStatusLabel();
  const params = new URLSearchParams(window.location.search);
  const [search, setSearch] = useState(params.get("search") || "");
  // The box follows the address when a link or Reset changes it.
  const addressSearch = params.get("search") || "";
  useEffect(() => setSearch(addressSearch), [addressSearch]);
  const currency = params.get("currency") || "";
  const status = params.get("status") || "";
  const shownCurrencies = [...new Set([...currencies, currency].filter(Boolean))].sort();
  const shownStatuses = [...new Set([...statuses, status].filter(Boolean))];
  return (
    <ListSearchCard
      title={title}
      subtitle={subtitle}
      actions={<>
        <ResetButton onClick={() => { setSearch(""); setQuery({ search: "", currency: "", status: "", disputeStatus: "" }); }} />
        <RefreshButton onClick={onRefresh} />
        {actions}
      </>}
    >
      <Field label={tr("search")}>
        <input
          aria-label={tr("search")}
          type="search"
          value={search}
          placeholder={tr("searchPlaceholder")}
          onChange={(event) => setSearch(event.target.value)}
          onKeyDown={(event) => { if (event.key === "Enter") setQuery({ search: search.trim() }); }}
          onBlur={() => { if (search.trim() !== (params.get("search") || "")) setQuery({ search: search.trim() }); }}
          style={inputStyle}
        />
      </Field>
      <Field label={tr("currency")}>
        <select aria-label={tr("currency")} value={currency} onChange={(event) => setQuery({ currency: event.target.value })} style={inputStyle}>
          <option value="">{tr("allCurrencies")}</option>
          {shownCurrencies.map((code) => <option key={code} value={code}>{code}</option>)}
        </select>
      </Field>
      <Field label={tr("status")}>
        <select aria-label={tr("status")} value={status} onChange={(event) => setQuery({ status: event.target.value })} style={inputStyle}>
          <option value="">{tr("allStatuses")}</option>
          {shownStatuses.map((code) => <option value={code} key={code}>{statusLabels[code] || statusLabel(code)}</option>)}
        </select>
      </Field>
    </ListSearchCard>
  );
}

// One page of a list read with the address's filters. The server pages,
// counts every record the filters match and counts the metric cards over
// the whole workspace, so nothing here is counted from the page.
function useFinanceList<T>(endpoint: string, extra = "") {
  const { language } = useI18n();
  const [data, setData] = useState<ListPayload<T> | null>(null);
  const [error, setError] = useState<ApiErrorView | null>(null);
  const latest = useRef("");
  // The address: the filters, the pager and the metric cards' links change it.
  const { search: address } = useLocation();
  const load = useCallback(() => {
    setError(null);
    const params = new URLSearchParams(queryString());
    params.set("pageSize", String(PAGE_SIZE));
    for (const [key, value] of new URLSearchParams(extra)) params.set(key, value);
    const request = `${endpoint}?${params.toString()}`;
    latest.current = request;
    void apiJson<ListPayload<T>>(request)
      .then((payload) => { if (latest.current === request) setData(payload); })
      .catch((reason) => { if (latest.current === request) setError(apiErrorView(reason, language, LOAD_FAILED)); });
  }, [endpoint, extra]);
  useEffect(load, [load, address]);
  // A page past the end (the records changed since the link was made) goes back to the first.
  useEffect(() => {
    if (data && !data.items.length && data.total > 0 && (data.page || 1) > 1) setQuery({ page: "" });
  }, [data]);
  return { data, error, load };
}

function Pager({ data, testId }: { data: ListPayload<unknown>; testId: string }) {
  return (
    <ListPager
      page={data.page || 1}
      pageSize={data.pageSize || PAGE_SIZE}
      total={data.total}
      onPage={(next) => setQuery({ page: next > 1 ? String(next) : "" })}
      testId={testId}
    />
  );
}

const headClass = (align: "left" | "right" = "left", first = false) =>
  `${align === "right" ? thRightClass : thClass} ${first ? "sticky left-0 z-20 bg-white" : ""}`;

function InvoiceList() {
  const { t, locale } = useI18n();
  const tr = useListCopyO2c();
  const { data, error, load } = useFinanceList<Invoice>("/api/finance/customer-invoices");
  if (error) return <Notice title={error.code}>{error.message}</Notice>;
  if (!data) return <Card className="p-6">{t("common.loading")}</Card>;
  const enabled =
    data.capabilities["customer-invoice"]?.enabled && canPrepare();
  const count = (key: string) => String(data.counts?.[key] ?? 0);
  return (
    <div className="space-y-5" data-testid="customer-invoice-workbench">
      <div className={metricGridClass} data-testid="customer-invoice-metrics">
        <ActionableMetricCard label={tr("toApprove")} value={count("toApprove")} description={tr("toApproveNote")} to="/app/sales/invoices?status=submitted" icon={FileText} color={A.orange} />
        <ActionableMetricCard label={tr("toIssue")} value={count("toIssue")} description={tr("toIssueNote")} to="/app/sales/invoices?status=approved" icon={Send} color={A.blue} />
        <ActionableMetricCard label={tr("issued")} value={count("issued")} description={tr("issuedNote")} to="/app/sales/invoices?status=issued" icon={CheckCircle2} color={A.purple} />
        <ActionableMetricCard label={tr("overdueInvoices")} value={count("pastDue")} description={tr("overdueInvoicesNote")} to="/app/finance/receivables?status=overdue" icon={AlertTriangle} color={A.red} />
      </div>
      <Filters
        title={tr("invoiceSearch")}
        subtitle={tr("invoiceSearchSubtitle")}
        statuses={["draft", "submitted", "approved", "issued", "voided"]}
        currencies={data.currencies || data.items.map((row) => row.currency)}
        onRefresh={load}
        actions={(
          <Link
            to="/app/sales/invoices/new"
            aria-disabled={!enabled}
            tabIndex={enabled ? undefined : -1}
            className={`${listButtonClass.primary} ${!enabled ? "pointer-events-none opacity-50" : ""}`}
          >
            <FilePlus2 size={13} />
            {t("finance.newCustomerInvoice")}
          </Link>
        )}
      />
      {!enabled && <Notice>{t("finance.capabilityDisabled")}</Notice>}
      <ListCard title={tr("invoiceList")} total={data.total} shown={data.items.length} testId="customer-invoice-list">
        <div className={tableScrollClass}>
          <table className={`w-full min-w-[980px] text-left ${tableBodyTextClass}`}>
            <thead>
              <tr style={listHeadRowStyle}>
                <th className={headClass("left", true)} style={{ color: A.gray1 }}>{tr("number")}</th>
                <th className={headClass()} style={{ color: A.gray1 }}>{tr("customer")}</th>
                <th className={headClass()} style={{ color: A.gray1 }}>{tr("shipment")}</th>
                <th className={headClass()} style={{ color: A.gray1 }}>{tr("dueDate")}</th>
                <th className={headClass("right")} style={{ color: A.gray1 }}>{tr("amount")}</th>
                <th className={headClass()} style={{ color: A.gray1 }}>{tr("status")}</th>
                <th className={`${thClass} sticky right-0 z-20 bg-white`} style={{ color: A.gray1 }}>{tr("actions")}</th>
              </tr>
            </thead>
            <tbody>
              {!data.items.length && (filtered()
                ? <ListStateRow colSpan={7} state="empty" title={tr("noMatch")} />
                : <ListStateRow colSpan={7} state="empty" title={tr("emptyInvoices")} detail={tr("emptyInvoicesDetail")} />)}
              {data.items.map((row, index) => {
                const next = row.availableActions.filter((action) => action !== "cancel").map((action) => t(`finance.action.${action}` as Parameters<typeof t>[0]));
                return (
                  <tr className={listRowClass} style={listRowStyle(index, data.items.length)} key={row.id}>
                    <td className={`${tdIdClass} sticky left-0 z-10 bg-white`}>
                      <Link className={`${tableLinkClass} text-blue-600`} to={`/app/sales/invoices/${encodeURIComponent(row.id)}`}>{row.invoiceNumber}</Link>
                    </td>
                    <td className={`${tdNameClass} max-w-[220px] truncate`} title={row.customerName}>{row.customerName}</td>
                    <td className={tdNowrapClass} style={{ color: A.sub }}>{row.shipmentNumber || row.shipmentId}</td>
                    <td className={tdNowrapClass} style={{ color: A.sub }}>{formatCalendarDay(row.dueDate, locale)}</td>
                    <td className={`${tdNumericRightClass} font-semibold`} style={{ color: A.label }}>{money(row.totalAmount, row.currency, locale)}</td>
                    <td className={tdNowrapClass}>
                      <StatusChip status={row.status} />
                      {next.length > 0 && <div className="mt-1 hidden text-[11px] sm:block" style={{ color: A.sub }}>{tr("next")}: {next.join(" · ")}</div>}
                    </td>
                    <td className={`${tdNowrapClass} sticky right-0 z-10 bg-white`}>
                      <Link className={rowActionClass.primary} to={`/app/sales/invoices/${encodeURIComponent(row.id)}`}>{tr("view")}</Link>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <Pager data={data} testId="customer-invoice-pager" />
      </ListCard>
    </div>
  );
}

type TranslationKey = Parameters<ReturnType<typeof useI18n>["t"]>[0];
const RECEIVABLE_ACTION_KEYS: Record<string, TranslationKey> = {
  record_payment: "finance.action.record_receivable_payment",
  dispute: "finance.action.dispute",
  resolve_dispute: "finance.action.resolve_dispute",
  record_external_reference: "finance.action.record_external_reference",
};

function Receivables() {
  const { t, locale, timezone } = useI18n();
  const tr = useListCopyO2c();
  // Overdue first, then the rest still owed, then paid; each newest first.
  const { data, error, load } = useFinanceList<Receivable>("/api/finance/receivables", "sort=attention");
  if (error) return <Notice title={error.code}>{error.message}</Notice>;
  if (!data) return <Card className="p-6">{t("common.loading")}</Card>;
  const today = todayInTimeZone(timezone);
  const count = (key: string) => String(data.counts?.[key] ?? 0);
  return (
    <div className="space-y-5" data-testid="receivables-workbench">
      <div className={metricGridClass} data-testid="receivable-metrics">
        <ActionableMetricCard label={tr("openReceivables")} value={count("outstanding")} description={tr("openReceivablesNote")} to="/app/finance/receivables?status=outstanding" icon={Wallet} color={A.blue} />
        <ActionableMetricCard label={tr("overdue")} value={count("overdue")} description={tr("overdueNote")} to="/app/finance/receivables?status=overdue" icon={AlertTriangle} color={A.red} />
        <ActionableMetricCard label={tr("disputed")} value={count("disputed")} description={tr("disputedNote")} to="/app/finance/receivables?disputeStatus=open" icon={MessageSquareWarning} color={A.orange} />
        <ActionableMetricCard label={tr("settled")} value={count("settled")} description={tr("settledNote")} to="/app/finance/receivables?status=settled" icon={CheckCircle2} color={A.purple} />
      </div>
      <Filters
        title={tr("receivableSearch")}
        subtitle={tr("receivableSearchSubtitle")}
        statuses={["outstanding", "open", "overdue", "disputed", "partially_settled", "settled"]}
        statusLabels={{ outstanding: tr("outstandingStatus") }}
        currencies={data.currencies || data.items.map((row) => row.currency)}
        onRefresh={load}
      />
      {/* The page's one notice: a receivable is owed, not received. */}
      <Notice testId="receivables-notice">{t("finance.noCollection")}</Notice>
      <ListCard title={tr("receivableList")} total={data.total} shown={data.items.length} testId="receivable-list">
        <div className={tableScrollClass}>
          <table className={`w-full min-w-[960px] text-left ${tableBodyTextClass}`}>
            <thead>
              <tr style={listHeadRowStyle}>
                <th className={headClass("left", true)} style={{ color: A.gray1 }}>{tr("number")}</th>
                <th className={headClass()} style={{ color: A.gray1 }}>{tr("customer")}</th>
                <th className={headClass()} style={{ color: A.gray1 }}>{tr("dueDate")}</th>
                <th className={headClass("right")} style={{ color: A.gray1 }}>{tr("outstanding")}</th>
                <th className={headClass()} style={{ color: A.gray1 }}>{tr("status")}</th>
                <th className={`${thClass} sticky right-0 z-20 bg-white`} style={{ color: A.gray1 }}>{tr("actions")}</th>
              </tr>
            </thead>
            <tbody>
              {!data.items.length && (filtered()
                ? <ListStateRow colSpan={6} state="empty" title={tr("noMatch")} />
                : <ListStateRow colSpan={6} state="empty" title={tr("emptyReceivables")} detail={tr("emptyReceivablesDetail")} />)}
              {data.items.map((row, index) => {
                const next = row.availableActions.map((action) => RECEIVABLE_ACTION_KEYS[action] ? t(RECEIVABLE_ACTION_KEYS[action]) : action);
                const invoicePath = row.customerInvoiceId ? `/app/sales/invoices/${encodeURIComponent(row.customerInvoiceId)}` : "";
                const pastDue = receivablePastDue(row, today);
                return (
                  <tr className={listRowClass} style={listRowStyle(index, data.items.length)} key={row.id} data-testid="receivable-row">
                    <td className={`${tdIdClass} sticky left-0 z-10 bg-white`}>
                      {invoicePath
                        ? <Link className={`${tableLinkClass} text-blue-600`} to={invoicePath}>{row.customerInvoiceNumber || row.obligationNumber}</Link>
                        : row.customerInvoiceNumber || row.obligationNumber}
                      {row.customerInvoiceNumber && row.obligationNumber && <div className="text-[11px] font-normal" style={{ color: A.sub }}>{row.obligationNumber}</div>}
                    </td>
                    <td className={`${tdNameClass} max-w-[220px] truncate`} title={row.customerName}>{row.customerName || "—"}</td>
                    <td className={tdNowrapClass} style={{ color: pastDue ? PAST_DUE_COLOR : A.sub }}>{formatCalendarDay(row.dueDate, locale)}</td>
                    <td className={`${tdNumericRightClass} font-semibold`} style={{ color: A.label }}>{money(row.outstandingAmount, row.currency, locale)}</td>
                    <td className={tdNowrapClass}>
                      <div className="flex flex-wrap items-center gap-1">
                        <StatusChip status={receivableChip(row, today)} />
                        {row.disputeStatus === "open" && <StatusChip status="disputed" />}
                      </div>
                      {row.externalSettlementReference && (
                        <div className="mt-1 text-[11px] text-amber-700">
                          {t("finance.externalUnverified")}
                        </div>
                      )}
                      {next.length > 0 && <div className="mt-1 hidden text-[11px] sm:block" style={{ color: A.sub }}>{tr("next")}: {next.join(" · ")}</div>}
                    </td>
                    <td className={`${tdNowrapClass} sticky right-0 z-10 bg-white`}>
                      {invoicePath ? <Link className={rowActionClass.primary} to={invoicePath}>{tr("view")}</Link> : <span style={{ color: A.gray2 }}>—</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <Pager data={data} testId="receivable-pager" />
      </ListCard>
    </div>
  );
}

function Aging() {
  const { t, locale, language } = useI18n();
  const tr = useListCopyO2c();
  const [data, setData] = useState<AgingPayload | null>(null);
  const [error, setError] = useState<ApiErrorView | null>(null);
  useEffect(() => {
    void apiJson<AgingPayload>(`/api/finance/aging?${queryString()}`)
      .then(setData)
      .catch((reason) => setError(apiErrorView(reason, language, LOAD_FAILED)));
  }, []);
  if (error) return <Notice title={error.code}>{error.message}</Notice>;
  if (!data) return <Card className="p-6">{t("common.loading")}</Card>;
  const buckets = [
    [tr("current"), "current"],
    [tr("days1"), "1_30"],
    [tr("days31"), "31_60"],
    [tr("days61"), "61_90"],
    [tr("days90"), "90_plus"],
  ] as const;
  return (
    <div className="space-y-5" data-testid="receivables-aging">
      {data.currencyAggregationStatus === "multi_currency_unconverted" && (
        <Notice>{t("finance.unconverted")}</Notice>
      )}
      <ListCard title={tr("agingTitle")}>
        <div className="px-5 pt-3 text-xs" style={{ color: A.sub }}>{tr("agingCaption", { timezone: data.timezone })}</div>
        <div className={tableScrollClass}>
          <table className={`w-full min-w-[900px] text-left ${tableBodyTextClass}`}>
            <thead>
              <tr style={listHeadRowStyle}>
                <th className={headClass("left", true)} style={{ color: A.gray1 }}>{tr("agingCurrency")}</th>
                <th className={headClass("right")} style={{ color: A.gray1 }}>{tr("agingCount")}</th>
                {buckets.map(([label]) => <th key={label} className={headClass("right")} style={{ color: A.gray1 }}>{label}</th>)}
                <th className={headClass("right")} style={{ color: A.gray1 }}>{tr("total")}</th>
              </tr>
            </thead>
            <tbody>
              {!data.groups.length && <ListStateRow colSpan={8} state="empty" title={tr("emptyAging")} detail={tr("emptyAgingDetail")} />}
              {data.groups.map((group, index) => (
                <tr className={listRowClass} style={listRowStyle(index, data.groups.length)} key={group.currency}>
                  <td className={`${tdIdClass} sticky left-0 z-10 bg-white`}>{group.currency}</td>
                  <td className={tdNumericRightClass}>{group.count}</td>
                  {buckets.map(([label, key]) => (
                    <td key={label} className={tdNumericRightClass} style={{ color: Number(group[key]) ? (key === "current" ? A.label : PAST_DUE_COLOR) : A.gray2 }}>
                      {money(group[key], group.currency, locale)}
                    </td>
                  ))}
                  <td className={`${tdNumericRightClass} font-semibold`} style={{ color: A.label }}>{money(group.total, group.currency, locale)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </ListCard>
    </div>
  );
}

function CreditNotes() {
  const { t, locale } = useI18n();
  const tr = useListCopyO2c();
  const { data, error, load } = useFinanceList<CreditNote>("/api/finance/customer-credit-notes");
  if (error) return <Notice title={error.code}>{error.message}</Notice>;
  if (!data) return <Card className="p-6">{t("common.loading")}</Card>;
  return (
    <div className="space-y-5" data-testid="customer-credit-notes">
      <Filters
        title={tr("creditSearch")}
        subtitle={tr("creditSearchSubtitle")}
        statuses={["draft", "approved", "cancelled"]}
        currencies={data.currencies || data.items.map((row) => row.currency)}
        onRefresh={load}
      />
      <Notice>{t("finance.noRefund")}</Notice>
      <ListCard title={tr("creditList")} total={data.total} shown={data.items.length}>
        <div className={tableScrollClass}>
          <table className={`w-full min-w-[900px] text-left ${tableBodyTextClass}`}>
            <thead>
              <tr style={listHeadRowStyle}>
                <th className={headClass("left", true)} style={{ color: A.gray1 }}>{tr("creditNumber")}</th>
                <th className={headClass()} style={{ color: A.gray1 }}>{tr("invoice")}</th>
                <th className={headClass()} style={{ color: A.gray1 }}>{tr("customer")}</th>
                <th className={headClass()} style={{ color: A.gray1 }}>{tr("returnPosting")}</th>
                <th className={headClass("right")} style={{ color: A.gray1 }}>{tr("amount")}</th>
                <th className={headClass()} style={{ color: A.gray1 }}>{tr("status")}</th>
              </tr>
            </thead>
            <tbody>
              {!data.items.length && (filtered()
                ? <ListStateRow colSpan={6} state="empty" title={tr("noMatch")} />
                : <ListStateRow colSpan={6} state="empty" title={tr("emptyCredits")} detail={tr("emptyCreditsDetail")} />)}
              {data.items.map((row, index) => (
                <tr className={listRowClass} style={listRowStyle(index, data.items.length)} key={row.id}>
                  <td className={`${tdIdClass} sticky left-0 z-10 bg-white`}>{row.creditNoteNumber}</td>
                  <td className={tdNowrapClass} style={{ color: A.sub }}>{row.customerInvoiceNumber || "—"}</td>
                  <td className={`${tdNameClass} max-w-[220px] truncate`} title={row.customerName}>{row.customerName}</td>
                  <td className={tdNowrapClass} style={{ color: A.sub }}>{row.returnPostingNumber || "—"}</td>
                  <td className={`${tdNumericRightClass} font-semibold`} style={{ color: A.label }}>{money(row.totalAmount, row.currency, locale)}</td>
                  <td className={tdNowrapClass}><StatusChip status={row.status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <Pager data={data} testId="customer-credit-note-pager" />
      </ListCard>
    </div>
  );
}

// Four-decimal amounts as the server reads them: digits with an optional
// fraction whose places past the fourth are zeros, compared as integers of
// 1/10000.
const DECIMAL = /^-?\d+(?:\.\d+)?$/;
const decimalUnits = (value: string): bigint | null => {
  const raw = value.trim();
  if (!DECIMAL.test(raw)) return null;
  const negative = raw.startsWith("-");
  const [whole, fraction = ""] = (negative ? raw.slice(1) : raw).split(".");
  if (/[1-9]/.test(fraction.slice(4))) return null;
  const units = BigInt(whole) * 10000n + BigInt((fraction.slice(0, 4) + "0000").slice(0, 4));
  return negative ? -units : units;
};
type FormCopyKey = keyof typeof FORM_COPY;
// An error's details when the server sent one object (a refused preview's issue).
const objectDetails = (value: unknown) => (value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined);
type LineIssue = { quantity?: string; tax?: string; line?: string };
type InvoiceIssues = { form: string[]; shipment?: string; due?: string; lines: Record<string, LineIssue> };
const noIssues = (): InvoiceIssues => ({ form: [], lines: {} });
const issueCount = (issues: InvoiceIssues) => issues.form.length + (issues.shipment ? 1 : 0) + (issues.due ? 1 : 0) + Object.keys(issues.lines).length;

// The new customer invoice, on the form standard (formLayout.tsx): Create
// draft checks the form with the server's own rules, previews the invoice
// on the server, and creates the draft when the preview allows it. Each
// refusal goes under its field when it names one, otherwise in the bar.
function NewInvoice() {
  const { t, locale, language } = useI18n();
  const tr = useListCopyO2c();
  const formCopy = useFormCopy();
  const navigate = useNavigate();
  // Cancel goes back where the form was opened from, or to the invoice list
  // when the form was the first page (location key "default").
  const { key: locationKey } = useLocation();
  const say = (key: FormCopyKey, values: Record<string, string> = {}) =>
    FORM_COPY[key][language === "en-US" ? 0 : 1].replace(/\{(\w+)\}/g, (_, name) => values[name] ?? "");
  const formRef = useRef<HTMLDivElement>(null);
  const [entry, setEntry] = useState<EntryData | null>(null);
  const [loadError, setLoadError] = useState<ApiErrorView | null>(null);
  const [shipmentId, setShipmentId] = useState("");
  const [dueDate, setDueDate] = useState("");
  // The due date is suggested until someone types their own. The invoice
  // number is assigned by the server when the draft is created.
  const [dueTyped, setDueTyped] = useState(false);
  const [quantities, setQuantities] = useState<Record<string, string>>({});
  const [taxes, setTaxes] = useState<Record<string, string>>({});
  const [checked, setChecked] = useState(false);
  const [serverIssues, setServerIssues] = useState<InvoiceIssues>(noIssues);
  const [failure, setFailure] = useState<ApiErrorView | null>(null);
  const [saving, setSaving] = useState(false);
  // Set when the form was opened from a sales order: only its shipments.
  const [orderFilter, setOrderFilter] = useState("");
  const [sourceNotice, setSourceNotice] = useState("");
  useEffect(() => {
    void apiJson<EntryData>("/api/finance/entry-data")
      .then(setEntry)
      .catch((reason) => setLoadError(apiErrorView(reason, language, LOAD_FAILED)));
  }, []);
  const shipped = (row: EntryData["postedShipments"][number]) =>
    Object.fromEntries(row.lines.map((line) => [line.id, String(Number(line.postedQuantity))]));
  // Opened from a shipment (?shipment=) or a sales order (?salesOrder=):
  // choose the shipment and offer each shipped quantity. An invoice only
  // covers shipped goods, so an order without a posted shipment is explained.
  useEffect(() => {
    if (!entry) return;
    const params = new URLSearchParams(window.location.search);
    const shipmentParam = params.get("shipment");
    const orderParam = params.get("salesOrder");
    if (shipmentParam) {
      const found = entry.postedShipments.find((row) => row.id === shipmentParam || row.shipmentNumber === shipmentParam);
      if (!found) { setSourceNotice(`${shipmentParam}: ${t("finance.shipmentNotInvoiceable")}`); return; }
      setShipmentId(found.id);
      setQuantities(shipped(found));
    } else if (orderParam) {
      const forOrder = entry.postedShipments.filter((row) => row.salesOrderId === orderParam);
      if (!forOrder.length) { setSourceNotice(`${orderParam}: ${t("finance.noPostedShipment")}`); return; }
      setOrderFilter(orderParam);
      if (forOrder.length === 1) {
        setShipmentId(forOrder[0].id);
        setQuantities(shipped(forOrder[0]));
      }
    }
  }, [entry]);
  const shipment = useMemo(
    () => entry?.postedShipments.find((row) => row.id === shipmentId),
    [entry, shipmentId],
  );
  const term = shipment?.customerPaymentTerm || null;
  const termDue = term && entry?.today ? addCalendarDays(entry.today, term.days) : "";
  useEffect(() => {
    if (!dueTyped) setDueDate(termDue);
  }, [termDue, dueTyped]);
  // A line is invoiced when its quantity is filled in and not zero; what is
  // filled in is sent as typed, so the server judges it.
  const invoicedLines = (shipment?.lines || []).filter((line) => {
    const value = (quantities[line.id] || "").trim();
    return value !== "" && decimalUnits(value) !== 0n;
  });
  const body = () => ({
    shipmentId,
    currency: shipment?.currency || "",
    invoiceDate: entry?.today ? `${entry.today}T00:00:00.000Z` : new Date().toISOString(),
    dueDate: dueDate ? new Date(`${dueDate}T00:00:00.000Z`).toISOString() : "",
    lines: invoicedLines.map((line) => ({
      shipmentLineId: line.id,
      quantity: (quantities[line.id] || "").trim(),
      enteredTaxAmount: (taxes[line.id] || "").trim() || "0",
    })),
  });
  // The server's rules, checked before anything is sent (operational-
  // finance-o2c-policy.mjs): a posted shipment, a due date, at least one
  // line, a positive quantity no more than shipped, a tax of 0 or more.
  const validation = useMemo<InvoiceIssues>(() => {
    const issues = noIssues();
    if (!shipmentId) issues.shipment = "shipmentRequired";
    if (!dueDate) issues.due = "dueRequired";
    if (shipment && !invoicedLines.length) issues.form.push("lineRequired");
    for (const line of invoicedLines) {
      const issue: LineIssue = {};
      const quantity = decimalUnits(quantities[line.id] || "");
      const posted = decimalUnits(String(line.postedQuantity));
      if (quantity === null || quantity <= 0n) issue.quantity = "quantityInvalid";
      else if (posted !== null && quantity > posted) issue.quantity = "quantityOver";
      const tax = (taxes[line.id] || "").trim();
      const taxUnits = tax ? decimalUnits(tax) : 0n;
      if (taxUnits === null || taxUnits < 0n) issue.tax = "taxInvalid";
      if (Object.keys(issue).length) issues.lines[line.id] = issue;
    }
    return issues;
  }, [shipmentId, shipment, dueDate, quantities, taxes]);
  const shown: InvoiceIssues = checked ? validation : noIssues();
  // The client's message for a field, else the server's.
  const fieldIssue = (field: "shipment" | "due") => shown[field] || serverIssues[field];
  const lineIssue = (lineId: string, field: keyof LineIssue) => shown.lines[lineId]?.[field] || serverIssues.lines[lineId]?.[field];
  const text = (key?: string) => (!key ? null : key in FORM_COPY ? say(key as FormCopyKey) : key);
  // "More than the 10 shipped": the shipped quantity of that line.
  const lineText = (lineId: string, key?: string) => {
    if (!key) return null;
    if (key === "quantityOver") {
      const line = shipment?.lines.find((row) => row.id === lineId);
      return say("quantityOver", { shipped: line ? `${Number(line.postedQuantity)}${line.unit ? ` ${line.unit}` : ""}` : "" });
    }
    return key in FORM_COPY ? say(key as FormCopyKey) : key;
  };
  // The preview's refusals placed where they belong. An issue names its line
  // by the shipment line (details) or by "Line N" of the lines sent.
  const placeIssues = (issues: Issue[], sent: ReturnType<typeof body>["lines"]): InvoiceIssues => {
    const placed = noIssues();
    const lineOf = (issue: Issue) => {
      const id = typeof issue.details?.shipmentLineId === "string" ? issue.details.shipmentLineId : "";
      if (id) return id;
      const number = /^Line (\d+)\b/.exec(issue.message || "")?.[1];
      return number ? sent[Number(number) - 1]?.shipmentLineId || "" : "";
    };
    const onLine = (lineId: string, field: keyof LineIssue, key: string) => {
      if (!lineId) return false;
      placed.lines[lineId] = { ...placed.lines[lineId], [field]: placed.lines[lineId]?.[field] || key };
      return true;
    };
    for (const issue of issues) {
      const lineId = lineOf(issue);
      switch (issue.code) {
        case "POSTED_SHIPMENT_REQUIRED":
          if (!shipmentId) placed.shipment = "shipmentRequired";
          else placed.shipment = "shipmentNotPosted";
          break;
        case "CUSTOMER_INVOICE_DATE_REQUIRED":
          placed.due = "dueRequired";
          break;
        case "CUSTOMER_INVOICE_LINES_REQUIRED":
          placed.form.push("lineRequired");
          break;
        case "CUSTOMER_INVOICE_QUANTITY_EXCEEDS_SHIPPED":
          if (!onLine(lineId, "quantity", "quantityOver")) placed.form.push(issue.message);
          break;
        case "FINANCE_DECIMAL_INVALID":
          if (!onLine(lineId, /entered tax/i.test(issue.message) ? "tax" : "quantity", /entered tax/i.test(issue.message) ? "taxInvalid" : "quantityInvalid")) placed.form.push(issue.message);
          break;
        case "SALES_PRICE_FACT_REQUIRED":
          if (!onLine(lineId, "line", "noPrice")) placed.form.push("noPrice");
          break;
        case "CUSTOMER_INVOICE_SOURCE_INVALID":
          if (!onLine(lineId, "line", "sourceInvalid")) placed.form.push("sourceInvalid");
          break;
        case "FINANCE_CURRENCY_MISMATCH":
          placed.form.push("currencyMismatch");
          break;
        default:
          placed.form.push(issue.message || issue.code);
      }
    }
    return placed;
  };
  const create = async () => {
    setChecked(true);
    setServerIssues(noIssues());
    setFailure(null);
    if (issueCount(validation)) {
      focusFirstInvalid(formRef.current);
      return;
    }
    const payload = body();
    setSaving(true);
    try {
      const plan = await apiJson<InvoicePlan>("/api/finance/customer-invoices/preview", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      if (!plan.allowed) {
        setServerIssues(placeIssues(plan.blockingIssues || [], payload.lines));
        focusFirstInvalid(formRef.current);
        return;
      }
      const result = await apiJson<{ entityId: string }>("/api/finance/customer-invoices", {
        method: "POST",
        body: JSON.stringify({ ...payload, idempotencyKey: createSecureClientMutationId("o2c") }),
      });
      navigate(`/app/sales/invoices/${encodeURIComponent(result.entityId)}`);
    } catch (reason) {
      // The create re-checks the preview; a refusal there names its issue.
      if (reason instanceof ApiError && reason.code && ["POSTED_SHIPMENT_REQUIRED", "CUSTOMER_INVOICE_DATE_REQUIRED", "CUSTOMER_INVOICE_LINES_REQUIRED", "CUSTOMER_INVOICE_QUANTITY_EXCEEDS_SHIPPED", "FINANCE_DECIMAL_INVALID", "SALES_PRICE_FACT_REQUIRED", "CUSTOMER_INVOICE_SOURCE_INVALID", "FINANCE_CURRENCY_MISMATCH"].includes(reason.code)) {
        setServerIssues(placeIssues([{ code: reason.code, message: reason.message, details: objectDetails((reason.payload as unknown as { details?: unknown }).details) }], payload.lines));
        focusFirstInvalid(formRef.current);
      } else {
        setFailure(apiErrorView(reason, language, LIST_COPY.invoiceFailed));
      }
    } finally {
      setSaving(false);
    }
  };
  if (!entry) return loadError ? <Notice title={loadError.code}>{loadError.message}</Notice> : <Card className="p-6">{t("common.loading")}</Card>;
  const enabled = entry.capabilities["customer-invoice"]?.enabled && canPrepare();
  const choices = entry.postedShipments.filter((row) => !orderFilter || row.salesOrderId === orderFilter);
  const fieldMessages = Boolean(fieldIssue("shipment") || fieldIssue("due")) || Object.keys(shown.lines).length + Object.keys(serverIssues.lines).length > 0;
  const formMessages = [...new Set([...shown.form, ...serverIssues.form])];
  const message = formMessages.length || fieldMessages || failure ? (
    <>
      {formMessages.map((key) => <div key={key}>{text(key)}</div>)}
      {fieldMessages && <div>{formCopy("checkFields")}</div>}
      {failure && <div title={failure.code}>{failure.message}</div>}
    </>
  ) : null;
  const lineLabel = (index: number) => say("line", { n: String(index + 1) });
  return (
    <div ref={formRef} className="space-y-5" data-testid="new-customer-invoice">
      <FocusFirstField />
      {!enabled && <Notice>{t("finance.capabilityDisabled")}</Notice>}
      {sourceNotice && <Notice>{sourceNotice}</Notice>}
      <FormHeader intro={say("intro")}>
        <div className="mt-1 text-xs" style={{ color: A.sub }} data-testid="customer-invoice-number-on-save">{tr("numberOnSave")}</div>
        {shipment && (
          <dl className="mt-4 grid gap-4 text-xs sm:grid-cols-2 lg:grid-cols-4" data-testid="customer-invoice-source">
            <div><dt style={{ color: A.sub }}>{say("customer")}</dt><dd className="mt-1 font-medium">{shipment.customerName || "—"}</dd></div>
            <div><dt style={{ color: A.sub }}>{say("salesOrder")}</dt><dd className="mt-1 font-medium">{shipment.salesOrderNumber || shipment.salesOrderId}</dd></div>
            <div><dt style={{ color: A.sub }}>{say("currency")}</dt><dd className="mt-1 font-medium">{shipment.currency}</dd></div>
          </dl>
        )}
      </FormHeader>

      <FormSection title={say("details")}>
        {orderFilter && (
          <div className="mb-3 flex flex-wrap items-center gap-2 text-xs text-slate-600" data-testid="customer-invoice-order-filter">
            <span>{t("finance.shipmentsForOrder")} <strong>{orderFilter}</strong></span>
            <button type="button" className="font-semibold text-blue-600" onClick={() => setOrderFilter("")}>{t("finance.showAllShipments")}</button>
          </div>
        )}
        <div className={formGridClass}>
          <div className="md:col-span-2">
            <Field label={t("finance.postedShipment")} required error={text(fieldIssue("shipment"))} hint={choices.length ? undefined : say("noShipments")}>
              <select
                data-testid="customer-invoice-shipment"
                value={shipmentId}
                onChange={(event) => {
                  const next = entry.postedShipments.find((row) => row.id === event.target.value);
                  setShipmentId(event.target.value);
                  setQuantities(next ? shipped(next) : {});
                  setTaxes({});
                  setServerIssues(noIssues());
                }}
                style={inputStyle}
              >
                <option value="">{say("chooseShipment")}</option>
                {choices.map((row) => <option value={row.id} key={row.id}>{row.shipmentNumber} · {row.customerName} · {row.currency}</option>)}
              </select>
            </Field>
          </div>
          <Field label={t("finance.dueDate")} required error={text(fieldIssue("due"))}>
            <input type="date" data-testid="customer-invoice-due" value={dueDate} onChange={(event) => { setDueDate(event.target.value); setDueTyped(true); }} style={inputStyle} />
            {!dueTyped && termDue && dueDate === termDue && term && <span className="block text-[12px] leading-[18px]" style={{ color: A.gray2 }} data-testid="customer-invoice-due-terms">{t("finance.dueFromTerms", { term: term.name, days: String(term.days) })}</span>}
          </Field>
        </div>
      </FormSection>

      <FormSection title={say("lines")} description={say("linesIntro")}>
        {!shipment && <p className="text-xs" style={{ color: A.sub }} data-testid="customer-invoice-lines-empty">{say("linesEmpty")}</p>}
        <div className="space-y-3">
          {shipment?.lines.map((line, index) => {
            const whole = lineText(line.id, lineIssue(line.id, "line"));
            return (
              <FormLineCard key={line.id} label={lineLabel(index)} testId="customer-invoice-line">
                <div className="mb-3 text-sm">
                  <div className="font-medium" style={{ color: A.label }}>{line.sku}{line.itemName ? ` · ${line.itemName}` : ""}</div>
                  <div className="text-xs" style={{ color: A.sub }}>{t("finance.shipped")} {Number(line.postedQuantity)}{line.unit ? ` ${line.unit}` : ""} · {t("finance.soPrice")} {line.unitPrice === null ? t("finance.priceUnavailable") : money(line.unitPrice, shipment.currency, locale)}</div>
                  {whole && <p className="mt-1 text-[12px] leading-[18px] text-red-600" role="alert">{whole}</p>}
                </div>
                <div className={formGridClass}>
                  <Field label={t("finance.quantity")} error={lineText(line.id, lineIssue(line.id, "quantity"))}>
                    <input aria-label={`${t("finance.quantity")} ${line.sku}`} inputMode="decimal" value={quantities[line.id] || ""} onChange={(event) => setQuantities({ ...quantities, [line.id]: event.target.value })} style={inputStyle} />
                  </Field>
                  <Field label={t("finance.tax")} error={lineText(line.id, lineIssue(line.id, "tax"))}>
                    <input aria-label={`${t("finance.tax")} ${line.sku}`} inputMode="decimal" value={taxes[line.id] || ""} placeholder="0" onChange={(event) => setTaxes({ ...taxes, [line.id]: event.target.value })} style={inputStyle} />
                  </Field>
                </div>
              </FormLineCard>
            );
          })}
        </div>
      </FormSection>

      <FormActionBar
        onCancel={() => (locationKey !== "default" ? navigate(-1) : navigate("/app/sales/invoices"))}
        submit={{ label: t("finance.createDraft"), onClick: () => void create(), busy: saving, disabled: !enabled, testId: "customer-invoice-create" }}
        message={message}
        messageTestId="customer-invoice-form-errors"
      />
    </div>
  );
}

type InvoiceReadFailure = "notFound" | "unauthenticated" | "forbidden" | "error";

function invoiceReadFailure(reason: unknown): InvoiceReadFailure {
  if (!(reason instanceof ApiError)) return "error";
  if (reason.status === 404) return "notFound";
  if (reason.status === 401) return "unauthenticated";
  if (reason.status === 403) return "forbidden";
  return "error";
}

// An invoice is drafted from a posted shipment, then submitted, approved and
// issued here. Issuing opens the receivable; nothing on this page collects
// money. Each step previews the server's plan before it runs.
function InvoiceDetail() {
  const { t, locale, language, timezone } = useI18n();
  const tr = useListCopyO2c();
  const canOpenRoute = useRouteAvailability();
  const id = decodeURIComponent(window.location.pathname.split("/").filter(Boolean).at(-1) || "");
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState<ApiErrorView | null>(null);
  const [failure, setFailure] = useState<InvoiceReadFailure | null>(null);
  const load = useCallback(() => {
    setFailure(null);
    void apiJson(`/api/finance/customer-invoices/${encodeURIComponent(id)}`)
      .then((next) => { setData(next); setError(null); })
      .catch((reason) => {
        setError(apiErrorView(reason, language, LOAD_FAILED));
        setFailure(invoiceReadFailure(reason));
      });
  }, [id]);
  useEffect(() => { load(); }, [load]);
  useDetailCrumb(data?.invoiceNumber);
  if (failure && !data) {
    const testId = { notFound: "customer-invoice-not-found", unauthenticated: "customer-invoice-unauthenticated", forbidden: "customer-invoice-forbidden", error: "customer-invoice-read-error" }[failure];
    const text = { notFound: t("finance.invoiceNotFound"), unauthenticated: t("finance.invoiceSignedOut"), forbidden: t("finance.invoiceForbidden"), error: t("finance.invoiceReadError") }[failure];
    return (
      <Card className="py-16 text-center" data-testid={testId}>
        <div className="text-sm font-semibold">{text}</div>
        <div className="mt-2 text-xs text-slate-500">{id}</div>
        {failure === "error" && <button type="button" onClick={load} className="mt-3 text-sm font-semibold text-blue-600">{t("finance.retry")}</button>}
      </Card>
    );
  }
  if (!data) return <Card className="p-6">{t("common.loading")}</Card>;
  const base = `/api/finance/customer-invoices/${encodeURIComponent(data.id)}`;
  const actions: string[] = Array.isArray(data.availableActions) ? data.availableActions : [];
  const version = () => ({ expectedVersion: data.version });
  const receivable = data.receivable;
  // The list's overdue rule: still owed and past the due day in the workspace.
  const today = todayInTimeZone(timezone);
  const pastDue = Boolean(receivable) && receivablePastDue(receivable, today);
  const lines: any[] = data.lines || [];
  return (
    <div className="space-y-4" data-testid="customer-invoice-detail">
      {error && <Notice title={error.code}>{error.message}</Notice>}
      <Card className="p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="fc-page-title" style={{ color: A.label }}>{data.invoiceNumber}</h1>
            <p className="mt-1 text-sm text-slate-500" data-testid="customer-invoice-sources">
              {data.customerName || "—"}
              {" · "}{t("finance.salesOrder")}{" "}
              <BusinessEntityLink entityType="sales_order" entityId={data.salesOrderId}>{data.salesOrderNumber || data.salesOrderId}</BusinessEntityLink>
              {" · "}{t("finance.shipment")}{" "}
              {data.shipmentId
                ? <Link className="font-semibold text-blue-600 hover:underline" to={`/app/sales/shipments/${encodeURIComponent(data.shipmentId)}`}>{data.shipmentNumber || data.shipmentId}</Link>
                : "—"}
            </p>
            <p className="mt-1 text-xs" style={{ color: pastDue ? PAST_DUE_COLOR : A.sub }} data-testid="customer-invoice-due-date">{t("finance.dueDate")} {formatCalendarDay(data.dueDate, locale)}</p>
          </div>
          <div className="text-right">
            <strong>{money(data.totalAmount, data.currency, locale)}</strong>
            <div className="mt-1"><StatusChip status={data.status} /></div>
          </div>
        </div>
        <div className="mt-4 flex flex-wrap gap-2" data-testid="customer-invoice-actions">
          {actions.includes("submit") && <TwoStepAction label={t("finance.action.submit")} testId="customer-invoice-submit" oneStep previewUrl={`${base}/submit-preview`} runUrl={`${base}/submit`} payload={version} onDone={load} />}
          {actions.includes("approve") && <TwoStepAction label={t("finance.action.approve")} testId="customer-invoice-approve" oneStep previewUrl={`${base}/approve-preview`} runUrl={`${base}/approve`} payload={version} onDone={load} />}
          {actions.includes("issue") && <TwoStepAction label={t("finance.action.issue")} testId="customer-invoice-issue" oneStep previewUrl={`${base}/issue-preview`} runUrl={`${base}/issue`} payload={version} onDone={load} />}
          {/* The invoice as a document to print or save as PDF; a person sends it. An approved invoice opens to be checked before it is issued. */}
          {documentStatuses.includes(data.status) && canOpenRoute("sales:invoice-document") && (
            <Link data-testid="customer-invoice-open-document" to={`/app/sales/invoices/${encodeURIComponent(data.id)}/document`} className="rounded-lg border px-3 py-2 text-xs font-semibold text-slate-700">
              {t("documents.openInvoice")}
            </Link>
          )}
          {!actions.length && <span className="text-xs text-slate-500">{t("finance.noActions")}</span>}
        </div>
      </Card>

      {/* The lines read as a table on wide screens and as one card per line on
          phones (listTableCardsRef): the item first, the amount next to it. */}
      <Card className="p-5" data-testid="customer-invoice-lines">
        <h3 className="mb-3 font-semibold">{t("finance.lines")}</h3>
        <div className={tableScrollClass} ref={listTableCardsRef}>
          <table className={`w-full text-left ${tableBodyTextClass}`}>
            <thead>
              <tr style={listHeadRowStyle}>
                <th className={thClass} style={{ color: A.gray1 }}>{tr("item")}</th>
                <th className={thRightClass} style={{ color: A.gray1 }}>{t("finance.amount")}</th>
                <th className={thRightClass} style={{ color: A.gray1 }}>{t("finance.quantity")}</th>
                <th className={thRightClass} style={{ color: A.gray1 }}>{t("finance.unitPrice")}</th>
                <th className={thRightClass} style={{ color: A.gray1 }}>{t("finance.tax")}</th>
              </tr>
            </thead>
            <tbody>
              {lines.map((line, index) => (
                <tr key={line.id} style={listRowStyle(index, lines.length)}>
                  <td className="px-4 py-3">
                    <span className="font-medium tabular-nums" style={{ color: A.label }}>{line.sku}</span>
                    {line.itemName && <span style={{ color: A.sub }}> · {line.itemName}</span>}
                  </td>
                  <td className={`${tdNumericRightClass} font-semibold`} style={{ color: A.label }}>{money(line.totalAmount, data.currency, locale)}</td>
                  <td className={tdNumericRightClass}>{Number(line.quantity)} {line.unit || ""}</td>
                  <td className={tdNumericRightClass}>{money(line.unitPrice, data.currency, locale)}</td>
                  <td className={tdNumericRightClass}>{money(line.enteredTaxAmount, data.currency, locale)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      {receivable && (
        <Card className="space-y-3 p-5" data-testid="customer-invoice-receivable">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="font-semibold">{t("finance.receivables")} · {receivable.obligationNumber || receivable.id}</h3>
            <div className="flex items-center gap-2">
              <strong>{money(receivable.outstandingAmount, receivable.currency, locale)}</strong>
              <span data-testid="customer-invoice-receivable-status"><StatusChip status={receivableChip(receivable, today)} /></span>
            </div>
          </div>
          <div className="text-xs" style={{ color: pastDue ? PAST_DUE_COLOR : A.sub }} data-testid="customer-invoice-receivable-due">{t("finance.dueDate")} {formatCalendarDay(receivable.dueDate, locale)}</div>
          <PaymentRecords kind="receivable" obligation={receivable} onDone={load} />
        </Card>
      )}
    </div>
  );
}

export type O2cView =
  | "customer-invoices"
  | "customer-invoice-new"
  | "customer-invoice-detail"
  | "receivables"
  | "aging"
  | "customer-credit-notes";

export default function OperationalFinanceO2cWorkbench({ view }: { view: O2cView }) {
  if (view === "customer-invoice-new") return <NewInvoice />;
  if (view === "customer-invoice-detail") return <InvoiceDetail />;
  if (view === "receivables") return <Receivables />;
  if (view === "aging") return <Aging />;
  if (view === "customer-credit-notes") return <CreditNotes />;
  return <InvoiceList />;
}
