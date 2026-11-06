import { useCallback, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { AlertTriangle, CheckCircle2, FilePlus2, FileText, MessageSquareWarning, RefreshCw, Send, Wallet } from "lucide-react";
import { Link } from "react-router";
import { ApiError, apiJson } from "../../lib/api-client";
import { apiErrorView, type ApiErrorView } from "../../lib/apiErrorText";
import { BusinessEntityLink } from "../../components/business/BusinessEntityLink";
import { StatusChip, TwoStepAction, useFinanceStatusLabel } from "./FinanceControls";
import { PaymentRecords } from "./PaymentRecords";
import { useI18n } from "../../i18n/I18n";
import { A, Card, Field, inputStyle } from "../../components/ui";
import { ActionableMetricCard } from "../../components/cards/ActionableMetricCard";
import { ListCard, ListSearchCard, ListStateRow, RefreshButton, ResetButton, listButtonClass, listHeadRowStyle, listRowClass, listRowStyle, rowActionClass } from "../../components/ui/listLayout";
import { tableBodyTextClass, tableLinkClass, tableScrollClass, tdIdClass, tdNameClass, tdNowrapClass, tdNumericRightClass, thClass, thRightClass } from "../../components/ui/workbenchTable";
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
type ListPayload<T> = {
  dataSource: string;
  items: T[];
  total: number;
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
    customerName: string;
    customerPaymentTerm?: { code: string; name: string; days: number } | null;
    currency: string;
    lines: Array<{
      id: string;
      sku: string;
      itemName: string;
      postedQuantity: string;
      unitPrice: string | null;
    }>;
  }>;
  capabilities: Record<string, Capability>;
};
type InvoicePlan = {
  allowed: boolean;
  blockingIssues: Array<{ code: string; message: string }>;
  invoice?: { totalAmount: string; currency: string };
  source?: { shipmentNumber: string; customerName: string };
};

const field =
  "h-9 rounded-lg border border-slate-200 bg-white px-3 text-sm outline-none focus:border-blue-400";
const button =
  "inline-flex h-9 items-center justify-center gap-2 rounded-lg px-3 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-50";
const queryString = () => {
  const params = new URLSearchParams(window.location.search);
  // disputeStatus carries the landing page's "disputed receivables" link.
  const allowed = ["status", "disputeStatus", "currency", "search", "page", "pageSize"];
  const next = new URLSearchParams();
  for (const key of allowed)
    if (params.get(key)) next.set(key, params.get(key) as string);
  return next.toString();
};
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

function Notice({ children, title }: { children: ReactNode; title?: string }) {
  return (
    <div className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900" title={title || undefined}>
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
  receivableSearchSubtitle: ["What customers owe on issued invoices. Recording a payment here does not move money.", "客户在已开票发票上的欠款。在此记录收款不会发生资金划转。"],
  receivableList: ["Receivable list", "应收列表"],
  creditSearch: ["Credit note search", "贷项通知单查询"],
  creditSearchSubtitle: ["Credits raised from posted customer returns.", "由已过账的客户退货生成的贷项。"],
  creditList: ["Credit note list", "贷项通知单列表"],
  toApprove: ["To approve", "待批准"],
  toApproveNote: ["Draft or submitted invoices", "草稿或已提交的发票"],
  toIssue: ["Approved, to issue", "已批准待开具"],
  toIssueNote: ["Approved and not yet sent", "已批准但尚未开具"],
  issued: ["Issued", "已开具"],
  issuedNote: ["Sent to the customer", "已发给客户"],
  overdueInvoices: ["Past due", "已逾期"],
  overdueInvoicesNote: ["Issued invoices past their due date", "已过到期日的已开具发票"],
  openReceivables: ["Open receivables", "未结应收"],
  openReceivablesNote: ["Not yet paid in full", "尚未全额收款"],
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
  emptyReceivablesDetail: ["A receivable is recorded when a customer invoice is issued, and stays here until it is paid in full.", "销售发票开出后会生成应收款，并在全额收款前一直显示在这里。"],
  emptyAging: ["Nothing to age yet", "暂无需要统计账龄的应收款"],
  emptyAgingDetail: ["Once customer invoices are issued, open receivables are grouped here by how far past due they are.", "销售发票开出后，未结应收款会按逾期时长在这里分组。"],
  emptyCredits: ["No credit notes yet", "暂无贷项通知单"],
  emptyCreditsDetail: ["A credit note appears here once a customer return is posted and credited.", "客户退货过账并生成贷项后，会显示在这里。"],
  loadFailed: ["Could not load this finance page. Try again.", "财务页面加载失败，请重试。"],
  invoiceFailed: ["Could not prepare the invoice. Check the shipment and lines, then try again.", "无法准备发票，请检查发货单和明细后重试。"],
} as const;

// A failed request in the interface language; the server's code stays in the tooltip.
const LOAD_FAILED = LIST_COPY.loadFailed;

function useListCopyO2c() {
  const { language } = useI18n();
  return (key: keyof typeof LIST_COPY, values: Record<string, string> = {}) =>
    LIST_COPY[key][language === "en-US" ? 0 : 1].replace(/\{(\w+)\}/g, (_, name) => values[name] ?? "");
}

// The address carries the filters, as the overview cards' links do; the list
// reloads on popstate.
const setQuery = (updates: Record<string, string>) => {
  const next = new URLSearchParams(window.location.search);
  for (const [key, value] of Object.entries(updates)) value ? next.set(key, value) : next.delete(key);
  const query = next.toString();
  window.history.pushState({}, "", `${window.location.pathname}${query ? `?${query}` : ""}`);
  window.dispatchEvent(new PopStateEvent("popstate"));
};

function Filters({ title, subtitle, statuses, currencies, onRefresh, actions }: {
  title: string;
  subtitle: string;
  statuses: string[];
  currencies: string[];
  onRefresh: () => void;
  actions?: ReactNode;
}) {
  const tr = useListCopyO2c();
  const statusLabel = useFinanceStatusLabel();
  const params = new URLSearchParams(window.location.search);
  const [search, setSearch] = useState(params.get("search") || "");
  const currency = params.get("currency") || "";
  const status = params.get("status") || "";
  const shownCurrencies = [...new Set([...currencies, currency].filter(Boolean))].sort();
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
          value={search}
          placeholder={tr("searchPlaceholder")}
          onChange={(event) => setSearch(event.target.value)}
          onKeyDown={(event) => { if (event.key === "Enter") setQuery({ search }); }}
          onBlur={() => { if (search !== (params.get("search") || "")) setQuery({ search }); }}
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
          {statuses.map((code) => <option value={code} key={code}>{statusLabel(code)}</option>)}
        </select>
      </Field>
    </ListSearchCard>
  );
}

// A list read with the address's filters, plus the unfiltered list for the
// metric cards when a filter is set.
function useFinanceList<T>(endpoint: string) {
  const { language } = useI18n();
  const [data, setData] = useState<ListPayload<T> | null>(null);
  const [all, setAll] = useState<T[] | null>(null);
  const [error, setError] = useState<ApiErrorView | null>(null);
  const load = useCallback(() => {
    setError(null);
    const query = queryString();
    void apiJson<ListPayload<T>>(`${endpoint}?${query}`)
      .then((payload) => {
        setData(payload);
        if (!query) setAll(payload.items);
      })
      .catch((reason) => setError(apiErrorView(reason, language, LOAD_FAILED)));
    if (query) void apiJson<ListPayload<T>>(endpoint).then((payload) => setAll(payload.items)).catch(() => setAll(null));
  }, [endpoint]);
  useEffect(load, [load]);
  // The filters change the query string and announce it with popstate.
  useEffect(() => {
    window.addEventListener("popstate", load);
    return () => window.removeEventListener("popstate", load);
  }, [load]);
  return { data, all, error, load };
}

const headClass = (align: "left" | "right" = "left", first = false) =>
  `${align === "right" ? thRightClass : thClass} ${first ? "sticky left-0 z-20 bg-white" : ""}`;

function InvoiceList() {
  const { t, locale, timezone } = useI18n();
  const tr = useListCopyO2c();
  const { data, all, error, load } = useFinanceList<Invoice>("/api/finance/customer-invoices");
  if (error) return <Notice title={error.code}>{error.message}</Notice>;
  if (!data) return <Card className="p-6">{t("common.loading")}</Card>;
  const enabled =
    data.capabilities["customer-invoice"]?.enabled && canPrepare();
  const today = todayInTimeZone(timezone);
  const counted = all || data.items;
  const count = (test: (row: Invoice) => boolean) => String(counted.filter(test).length);
  return (
    <div className="space-y-5" data-testid="customer-invoice-workbench">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <ActionableMetricCard label={tr("toApprove")} value={count((row) => ["draft", "submitted"].includes(row.status))} description={tr("toApproveNote")} to="/app/sales/invoices?status=submitted" icon={FileText} color={A.orange} />
        <ActionableMetricCard label={tr("toIssue")} value={count((row) => row.status === "approved")} description={tr("toIssueNote")} to="/app/sales/invoices?status=approved" icon={Send} color={A.blue} />
        <ActionableMetricCard label={tr("issued")} value={count((row) => row.status === "issued")} description={tr("issuedNote")} to="/app/sales/invoices?status=issued" icon={CheckCircle2} color={A.purple} />
        <ActionableMetricCard label={tr("overdueInvoices")} value={count((row) => row.status === "issued" && Boolean(row.dueDate) && row.dueDate.slice(0, 10) < today)} description={tr("overdueInvoicesNote")} to="/app/finance/receivables?status=overdue" icon={AlertTriangle} color={A.red} />
      </div>
      <Filters
        title={tr("invoiceSearch")}
        subtitle={tr("invoiceSearchSubtitle")}
        statuses={["draft", "submitted", "approved", "issued", "voided"]}
        currencies={counted.map((row) => row.currency)}
        onRefresh={load}
        actions={(
          <a
            href="/app/sales/invoices/new"
            aria-disabled={!enabled}
            className={`${listButtonClass.primary} ${!enabled ? "pointer-events-none opacity-50" : ""}`}
          >
            <FilePlus2 size={13} />
            {t("finance.newCustomerInvoice")}
          </a>
        )}
      />
      {!enabled && <Notice>{t("finance.capabilityDisabled")}</Notice>}
      <ListCard title={tr("invoiceList")} total={counted.length} shown={data.items.length}>
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
              {!data.items.length && (queryString()
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
                      {next.length > 0 && <div className="mt-1 text-[11px]" style={{ color: A.sub }}>{tr("next")}: {next.join(" · ")}</div>}
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
  const { data, all, error, load } = useFinanceList<Receivable>("/api/finance/receivables");
  if (error) return <Notice title={error.code}>{error.message}</Notice>;
  if (!data) return <Card className="p-6">{t("common.loading")}</Card>;
  const today = todayInTimeZone(timezone);
  const counted = all || data.items;
  const open = (row: Receivable) => !["settled", "cancelled", "voided"].includes(row.status);
  const pastDue = (row: Receivable) => open(row) && Boolean(row.dueDate) && row.dueDate.slice(0, 10) < today;
  const count = (test: (row: Receivable) => boolean) => String(counted.filter(test).length);
  return (
    <div className="space-y-5" data-testid="receivables-workbench">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <ActionableMetricCard label={tr("openReceivables")} value={count(open)} description={tr("openReceivablesNote")} to="/app/finance/receivables?status=open" icon={Wallet} color={A.blue} />
        <ActionableMetricCard label={tr("overdue")} value={count(pastDue)} description={tr("overdueNote")} to="/app/finance/receivables?status=overdue" icon={AlertTriangle} color={A.red} />
        <ActionableMetricCard label={tr("disputed")} value={count((row) => row.disputeStatus === "open")} description={tr("disputedNote")} to="/app/finance/receivables?disputeStatus=open" icon={MessageSquareWarning} color={A.orange} />
        <ActionableMetricCard label={tr("settled")} value={count((row) => row.status === "settled")} description={tr("settledNote")} to="/app/finance/receivables?status=settled" icon={CheckCircle2} color={A.purple} />
      </div>
      <Filters
        title={tr("receivableSearch")}
        subtitle={tr("receivableSearchSubtitle")}
        statuses={["open", "overdue", "disputed", "partially_settled", "settled"]}
        currencies={counted.map((row) => row.currency)}
        onRefresh={load}
      />
      <Notice>{t("finance.noCollection")}</Notice>
      <ListCard title={tr("receivableList")} total={counted.length} shown={data.items.length}>
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
              {!data.items.length && (queryString()
                ? <ListStateRow colSpan={6} state="empty" title={tr("noMatch")} />
                : <ListStateRow colSpan={6} state="empty" title={tr("emptyReceivables")} detail={tr("emptyReceivablesDetail")} />)}
              {data.items.map((row, index) => {
                const next = row.availableActions.map((action) => RECEIVABLE_ACTION_KEYS[action] ? t(RECEIVABLE_ACTION_KEYS[action]) : action);
                const invoicePath = row.customerInvoiceId ? `/app/sales/invoices/${encodeURIComponent(row.customerInvoiceId)}` : "";
                return (
                  <tr className={listRowClass} style={listRowStyle(index, data.items.length)} key={row.id}>
                    <td className={`${tdIdClass} sticky left-0 z-10 bg-white`}>
                      {invoicePath
                        ? <Link className={`${tableLinkClass} text-blue-600`} to={invoicePath}>{row.customerInvoiceNumber || row.obligationNumber}</Link>
                        : row.customerInvoiceNumber || row.obligationNumber}
                      {row.customerInvoiceNumber && row.obligationNumber && <div className="text-[11px] font-normal" style={{ color: A.sub }}>{row.obligationNumber}</div>}
                    </td>
                    <td className={`${tdNameClass} max-w-[220px] truncate`} title={row.customerName}>{row.customerName || "—"}</td>
                    <td className={tdNowrapClass} style={{ color: pastDue(row) ? "#b91c1c" : A.sub }}>{formatCalendarDay(row.dueDate, locale)}</td>
                    <td className={`${tdNumericRightClass} font-semibold`} style={{ color: A.label }}>{money(row.outstandingAmount, row.currency, locale)}</td>
                    <td className={tdNowrapClass}>
                      <div className="flex flex-wrap items-center gap-1">
                        <StatusChip status={pastDue(row) && row.status === "open" ? "overdue" : row.status} />
                        {row.disputeStatus === "open" && <StatusChip status="disputed" />}
                      </div>
                      {row.externalSettlementReference && (
                        <div className="mt-1 text-[11px] text-amber-700">
                          {t("finance.externalUnverified")}
                        </div>
                      )}
                      {next.length > 0 && <div className="mt-1 text-[11px]" style={{ color: A.sub }}>{tr("next")}: {next.join(" · ")}</div>}
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
                    <td key={label} className={tdNumericRightClass} style={{ color: Number(group[key]) ? (key === "current" ? A.label : "#b91c1c") : A.gray2 }}>
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
  const { t, locale, language } = useI18n();
  const tr = useListCopyO2c();
  const statusLabel = useFinanceStatusLabel();
  const [data, setData] = useState<ListPayload<CreditNote> | null>(null);
  const [error, setError] = useState<ApiErrorView | null>(null);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const load = useCallback(() => {
    setError(null);
    void apiJson<ListPayload<CreditNote>>(
      `/api/finance/customer-credit-notes?${queryString()}`,
    )
      .then(setData)
      .catch((reason) => setError(apiErrorView(reason, language, LOAD_FAILED)));
  }, []);
  useEffect(load, [load]);
  if (error) return <Notice title={error.code}>{error.message}</Notice>;
  if (!data) return <Card className="p-6">{t("common.loading")}</Card>;
  const needle = search.trim().toLowerCase();
  const shown = data.items.filter((row) =>
    (!status || row.status === status)
    && (!needle || [row.creditNoteNumber, row.customerInvoiceNumber, row.customerName, row.returnPostingNumber].some((value) => String(value || "").toLowerCase().includes(needle))));
  return (
    <div className="space-y-5" data-testid="customer-credit-notes">
      <ListSearchCard
        title={tr("creditSearch")}
        subtitle={tr("creditSearchSubtitle")}
        actions={<>
          <ResetButton onClick={() => { setSearch(""); setStatus(""); }} />
          <RefreshButton onClick={load} />
        </>}
      >
        <Field label={tr("search")}>
          <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder={tr("searchPlaceholder")} style={inputStyle} />
        </Field>
        <Field label={tr("status")}>
          <select value={status} onChange={(event) => setStatus(event.target.value)} style={inputStyle}>
            <option value="">{tr("allStatuses")}</option>
            {[...new Set(data.items.map((row) => row.status))].map((code) => <option key={code} value={code}>{statusLabel(code)}</option>)}
          </select>
        </Field>
      </ListSearchCard>
      <Notice>{t("finance.noRefund")}</Notice>
      <ListCard title={tr("creditList")} total={data.items.length} shown={shown.length}>
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
              {!shown.length && (data.items.length
                ? <ListStateRow colSpan={6} state="empty" title={tr("noMatch")} />
                : <ListStateRow colSpan={6} state="empty" title={tr("emptyCredits")} detail={tr("emptyCreditsDetail")} />)}
              {shown.map((row, index) => (
                <tr className={listRowClass} style={listRowStyle(index, shown.length)} key={row.id}>
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
      </ListCard>
    </div>
  );
}

function NewInvoice() {
  const { t, locale, language } = useI18n();
  const tr = useListCopyO2c();
  const [entry, setEntry] = useState<EntryData | null>(null);
  const [shipmentId, setShipmentId] = useState("");
  const [dueDate, setDueDate] = useState("");
  // The due date is suggested until someone types their own. The invoice
  // number is assigned by the server when the draft is created.
  const [dueTyped, setDueTyped] = useState(false);
  const [quantities, setQuantities] = useState<Record<string, string>>({});
  const [taxes, setTaxes] = useState<Record<string, string>>({});
  const [plan, setPlan] = useState<InvoicePlan | null>(null);
  const [notice, setNotice] = useState<ApiErrorView | null>(null);
  // Set when the form was opened from a sales order: only its shipments.
  const [orderFilter, setOrderFilter] = useState("");
  const [sourceNotice, setSourceNotice] = useState("");
  useEffect(() => {
    void apiJson<EntryData>("/api/finance/entry-data")
      .then(setEntry)
      .catch((reason) => setNotice(apiErrorView(reason, language, LOAD_FAILED)));
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
  const body = () => ({
    shipmentId,
    currency: shipment?.currency || "",
    invoiceDate: entry?.today ? `${entry.today}T00:00:00.000Z` : new Date().toISOString(),
    dueDate: dueDate ? new Date(`${dueDate}T00:00:00.000Z`).toISOString() : "",
    lines:
      shipment?.lines
        .filter((line) => Number(quantities[line.id] || 0) > 0)
        .map((line) => ({
          shipmentLineId: line.id,
          quantity: quantities[line.id],
          enteredTaxAmount: taxes[line.id] || "0",
        })) || [],
  });
  const preview = async () => {
    setNotice(null);
    try {
      setPlan(
        await apiJson<InvoicePlan>("/api/finance/customer-invoices/preview", {
          method: "POST",
          body: JSON.stringify(body()),
        }),
      );
    } catch (reason) {
      setNotice(apiErrorView(reason, language, LIST_COPY.invoiceFailed));
    }
  };
  const create = async () => {
    setNotice(null);
    try {
      const result = await apiJson<{ entityId: string }>(
        "/api/finance/customer-invoices",
        {
          method: "POST",
          body: JSON.stringify({
            ...body(),
            idempotencyKey: createSecureClientMutationId("o2c"),
          }),
        },
      );
      window.location.assign(
        `/app/sales/invoices/${encodeURIComponent(result.entityId)}`,
      );
    } catch (reason) {
      setNotice(apiErrorView(reason, language, LIST_COPY.invoiceFailed));
    }
  };
  if (!entry) return notice ? <Notice title={notice.code}>{notice.message}</Notice> : <Card className="p-6">{t("common.loading")}</Card>;
  const enabled = entry.capabilities["customer-invoice"]?.enabled && canPrepare();
  return (
    <div className="space-y-4" data-testid="new-customer-invoice">
      {!enabled && <Notice>{t("finance.capabilityDisabled")}</Notice>}
      {notice && <Notice title={notice.code}>{notice.message}</Notice>}
      {sourceNotice && <Notice>{sourceNotice}</Notice>}
      <Card className="space-y-4 p-5">
        {orderFilter && (
          <div className="flex flex-wrap items-center gap-2 text-xs text-slate-600" data-testid="customer-invoice-order-filter">
            <span>{t("finance.shipmentsForOrder")} <strong>{orderFilter}</strong></span>
            <button type="button" className="font-semibold text-blue-600" onClick={() => setOrderFilter("")}>{t("finance.showAllShipments")}</button>
          </div>
        )}
        <div className="grid gap-3 md:grid-cols-3">
          <p className="self-end rounded-lg bg-slate-50 p-2 text-xs text-slate-600" data-testid="customer-invoice-number-on-save">{tr("numberOnSave")}</p>
          <label className="text-xs">{t("finance.postedShipment")}<select data-testid="customer-invoice-shipment" className={`${field} mt-1 w-full`} value={shipmentId} onChange={(event) => { const next = entry.postedShipments.find((row) => row.id === event.target.value); setShipmentId(event.target.value); setQuantities(next ? shipped(next) : {}); setPlan(null); }}><option value="">—</option>{entry.postedShipments.filter((row) => !orderFilter || row.salesOrderId === orderFilter).map((row) => <option value={row.id} key={row.id}>{row.shipmentNumber} · {row.customerName} · {row.currency}</option>)}</select></label>
          <label className="text-xs">{t("finance.dueDate")}<input type="date" data-testid="customer-invoice-due" className={`${field} mt-1 w-full`} value={dueDate} onChange={(event) => { setDueDate(event.target.value); setDueTyped(true); }} />{!dueTyped && termDue && dueDate === termDue && term && <span className="mt-1 block text-slate-500" data-testid="customer-invoice-due-terms">{t("finance.dueFromTerms", { term: term.name, days: String(term.days) })}</span>}</label>
        </div>
        {shipment?.lines.map((line) => (
          <div className="grid items-end gap-3 rounded-xl bg-slate-50 p-3 md:grid-cols-4" key={line.id} data-testid="customer-invoice-line">
            <div><div className="font-medium">{line.sku}{line.itemName ? ` · ${line.itemName}` : ""}</div><div className="text-xs text-slate-500">{t("finance.shipped")} {Number(line.postedQuantity)} · {t("finance.soPrice")} {line.unitPrice === null ? t("finance.priceUnavailable") : money(line.unitPrice, shipment.currency, locale)}</div></div>
            <label className="text-xs">{t("finance.quantity")}<input className={`${field} mt-1 w-full`} value={quantities[line.id] || ""} onChange={(event) => setQuantities({ ...quantities, [line.id]: event.target.value })} /></label>
            <label className="text-xs">{t("finance.tax")}<input className={`${field} mt-1 w-full`} value={taxes[line.id] || ""} onChange={(event) => setTaxes({ ...taxes, [line.id]: event.target.value })} /></label>
          </div>
        ))}
        <div className="flex gap-2">
          <button data-testid="customer-invoice-preview" className={`${button} border border-slate-200`} disabled={!enabled} onClick={() => void preview()}><RefreshCw size={14} />{t("finance.preview")}</button>
          <button data-testid="customer-invoice-create" className={`${button} text-white`} style={{ background: A.blue }} disabled={!enabled || !plan?.allowed} onClick={() => void create()}><FilePlus2 size={14} />{t("finance.createDraft")}</button>
        </div>
      </Card>
      {plan && <Card className="p-5"><div className="font-semibold">{plan.allowed ? money(plan.invoice?.totalAmount, plan.invoice?.currency || "", locale) : plan.blockingIssues.map((issue) => issue.message).join(" · ")}</div></Card>}
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
  const { t, locale, language } = useI18n();
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
            <p className="mt-1 text-xs text-slate-500">{t("finance.dueDate")} {formatCalendarDay(data.dueDate, locale)}</p>
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

      <Card className="overflow-x-auto p-5">
        <h3 className="mb-3 font-semibold">{t("finance.lines")}</h3>
        <table className="w-full min-w-[640px] text-sm">
          <thead><tr className="border-b text-left text-xs text-slate-500"><th className="py-2">SKU</th><th className="py-2">{t("finance.quantity")}</th><th className="py-2">{t("finance.unitPrice")}</th><th className="py-2">{t("finance.tax")}</th><th className="py-2">{t("finance.amount")}</th></tr></thead>
          <tbody>
            {(data.lines || []).map((line: any) => (
              <tr key={line.id} className="border-b border-slate-50"><td className="py-2">{line.sku} · {line.itemName}</td><td className="py-2">{Number(line.quantity)} {line.unit || ""}</td><td className="py-2">{money(line.unitPrice, data.currency, locale)}</td><td className="py-2">{money(line.enteredTaxAmount, data.currency, locale)}</td><td className="py-2">{money(line.totalAmount, data.currency, locale)}</td></tr>
            ))}
          </tbody>
        </table>
      </Card>

      {receivable && (
        <Card className="space-y-3 p-5" data-testid="customer-invoice-receivable">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="font-semibold">{t("finance.receivables")} · {receivable.obligationNumber || receivable.id}</h3>
            <div className="flex items-center gap-2"><strong>{money(receivable.outstandingAmount, receivable.currency, locale)}</strong><StatusChip status={receivable.status} /></div>
          </div>
          <div className="text-xs text-slate-500">{t("finance.dueDate")} {formatCalendarDay(receivable.dueDate, locale)}</div>
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
