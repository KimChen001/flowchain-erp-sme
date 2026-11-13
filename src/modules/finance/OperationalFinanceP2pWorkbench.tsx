import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Link, useLocation, useSearchParams } from "react-router";
import { AlertCircle, AlertTriangle, CheckCircle2, Coins, FileMinus, FileText, Inbox, MessageSquareWarning, PauseCircle, Plus, Send, ShieldCheck, Wallet } from "lucide-react";
import { A, Card, Field, inputStyle } from "../../components/ui";
import { ActionableMetricCard } from "../../components/cards/ActionableMetricCard";
import { EntityLink } from "../../components/business/EntityLink";
import { ListCard, ListSearchCard, ListStateRow, RefreshButton, ResetButton, StatusChip, listButtonClass, listHeadRowStyle, listRowClass, listRowStyle, metricGridClass, rowActionClass, statusToneOf } from "../../components/ui/listLayout";
import { tableBodyTextClass, tableLinkClass, tableScrollClass, tdIdClass, tdNameClass, tdNowrapClass, tdNumericRightClass, thClass, thRightClass } from "../../components/ui/workbenchTable";
import { ListPager } from "../procurement/listPaging";
import { useI18n } from "../../i18n/I18n";
import { apiJson } from "../../lib/api-client";
import { apiErrorView, type ApiErrorView } from "../../lib/apiErrorText";
import { formatCalendarDay, todayInTimeZone } from "../../lib/format";
import { financeStatusTone, shownBillStatus } from "./FinanceControls";
import { matchExceptionLabel } from "../../domain/procurement/variance-types";

type Landing = {
  dataSource: string;
  cards: Record<string, number>;
  currencyLimitations: {
    currencies: string[];
    aggregationStatus: string;
    fxConverted: false;
    message: string;
  };
  settlementClaims: {
    payableMeansPaid: false;
    receivableMeansCollected: false;
  };
};
// A page of a list: `total` counts every record the filters match; `counts`
// are the metric cards over the whole workspace; `suppliers` every supplier
// name on a supplier invoice, for the supplier filter.
type ListPayload = {
  items: Array<Record<string, any>>;
  total: number;
  page?: number;
  pageSize?: number;
  counts?: Record<string, number>;
  suppliers?: string[];
  capabilities: Record<string, { enabled?: boolean }>;
};
// Lists are read 50 records at a time.
const PAGE_SIZE = 50;
const value = (row: Record<string, any>, ...keys: string[]) =>
  keys.map((key) => row[key]).find((entry) => entry !== undefined && entry !== null);
// A hidden or missing amount is null and shows as a dash, never as 0.
const money = (amount: unknown, currency: unknown, locale: string) => {
  if (amount === null || amount === undefined || amount === "") return "—";
  const code = String(currency || "");
  const numeric = Number(amount);
  if (!Number.isFinite(numeric)) return "—";
  return /^[A-Z]{3}$/.test(code)
    ? new Intl.NumberFormat(locale, {
        style: "currency",
        currency: code,
        maximumFractionDigits: 4,
      }).format(numeric)
    : `${amount} ${code}`.trim();
};
type TranslationKey = Parameters<ReturnType<typeof useI18n>["t"]>[0];
const tokenKeys: Record<string, TranslationKey> = {
  draft: "finance.status.draft",
  submitted: "finance.status.submitted",
  matched: "finance.status.matched",
  exception: "finance.status.exception",
  approved: "finance.status.approved",
  held: "finance.status.held",
  export_ready: "finance.status.export_ready",
  partially_settled: "finance.status.partially_settled",
  settled: "finance.status.settled",
  open: "finance.status.open",
  overdue: "finance.status.overdue",
  reviewed: "finance.status.reviewed",
  resolved: "finance.status.resolved",
  cancelled: "finance.status.cancelled",
  variance_approved: "finance.status.variance_approved",
  to_pay: "finance.status.to_pay",
  revise: "finance.action.revise",
  submit: "finance.action.submit",
  match: "finance.action.match",
  approve: "finance.action.approve",
  cancel: "finance.action.cancel",
  hold: "finance.action.hold",
  mark_export_ready: "finance.action.mark_export_ready",
  release: "finance.action.release",
  record_payment: "finance.action.record_payment",
  link_receipt: "finance.action.link_receipt",
};
// A payable still owed, the server's outstandingPayableWhere.
const PAYABLE_OPEN_STATUSES = ["approved", "export_ready", "held", "partially_settled"];
const PAST_DUE_COLOR = "#b91c1c";

function Warning({ children, title, testId }: { children: ReactNode; title?: string; testId?: string }) {
  return (
    <div className="flex gap-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900" title={title || undefined} data-testid={testId}>
      <AlertTriangle className="mt-0.5 shrink-0" size={16} />
      <span>{children}</span>
    </div>
  );
}

// A failed load names the problem in the interface language; the server's
// code stays in the notice's tooltip.
const LOAD_FAILED = ["Could not load this finance page. Try again.", "财务页面加载失败，请重试。"] as const;

// What each overview card counts, under its number.
const LANDING_COPY = {
  awaitingMatch: ["Submitted, waiting for the three-way match", "已提交，等待三单匹配"],
  matchExceptions: ["Price or quantity differs from the PO or receipt", "价格或数量与采购订单、收货不一致"],
  approvedPayables: ["Approved, not yet paid in full", "已批准，尚未全额付款"],
  awaitingIssue: ["Approved, not yet sent to the customer", "已批准，尚未开具给客户"],
  overdueReceivables: ["Past the due date and not paid in full", "已过到期日且未全额收款"],
  disputedReceivables: ["The customer has raised a dispute", "客户提出了争议"],
  supplierCredits: ["Raised from posted supplier returns", "由已过账的供应商退货生成"],
  customerCredits: ["Raised from posted customer returns", "由已过账的客户退货生成"],
} as const;

export function FinanceLanding() {
  const { t, language } = useI18n();
  const say = (key: keyof typeof LANDING_COPY) => LANDING_COPY[key][language === "en-US" ? 0 : 1];
  const [data, setData] = useState<Landing | null>(null);
  const [error, setError] = useState<ApiErrorView | null>(null);
  useEffect(() => {
    void apiJson<Landing>("/api/finance/landing")
      .then(setData)
      .catch((reason) => setError(apiErrorView(reason, language, LOAD_FAILED)));
  }, []);
  if (error) return <Warning title={error.code}>{error.message}</Warning>;
  if (!data) return <Card className="p-6">{t("common.loading")}</Card>;
  // Each card opens the list it counts, with the same filter.
  const cards = [
    ["supplierInvoicesAwaitingMatch", t("finance.awaitingMatch"), say("awaitingMatch"), "/app/procurement/bills?status=submitted", Inbox, A.orange],
    ["matchExceptions", t("finance.matchExceptions"), say("matchExceptions"), "/app/procurement/bills?status=exception", AlertCircle, A.red],
    ["approvedPayableObligations", t("finance.approvedPayables"), say("approvedPayables"), "/app/finance/payables?status=outstanding", Wallet, A.blue],
    ["customerInvoicesAwaitingIssue", t("finance.awaitingIssue"), say("awaitingIssue"), "/app/sales/invoices?status=approved", Send, A.blue],
    ["overdueReceivables", t("finance.overdueReceivables"), say("overdueReceivables"), "/app/finance/receivables?status=overdue", AlertTriangle, A.red],
    ["disputedReceivables", t("finance.disputedReceivables"), say("disputedReceivables"), "/app/finance/receivables?disputeStatus=open", MessageSquareWarning, A.orange],
    ["supplierCreditMemos", t("finance.supplierCredits"), say("supplierCredits"), "/app/finance/credits", FileMinus, A.purple],
    ["customerCreditNotes", t("finance.customerCredits"), say("customerCredits"), "/app/finance/customer-credit-notes", FileText, A.purple],
  ] as const;
  return (
    <div className="space-y-4" data-testid="operational-finance-landing">
      <div className={metricGridClass} data-testid="finance-overview-cards">
        {cards.map(([key, label, description, to, icon, color]) => (
          <ActionableMetricCard key={key} label={label} value={String(data.cards[key] || 0)} description={description} to={to} icon={icon} color={color} />
        ))}
      </div>
      {/* The page's one notice: nothing here pays or collects money. */}
      <Warning testId="finance-overview-notice">{t("finance.noMoneyMoved")}</Warning>
      <Card className="p-4" data-testid="finance-currency-limitation">
        <div className="font-semibold">{t("finance.currency")}</div>
        <div className="mt-1 text-sm text-slate-600">
          {data.currencyLimitations.aggregationStatus ===
          "multi_currency_unconverted"
            ? t("finance.unconverted")
            : data.currencyLimitations.aggregationStatus === "single_currency"
              ? t("finance.singleCurrency")
              : t("finance.noCurrencyData")}
        </div>
        <div className="mt-2 text-xs text-slate-500">
          {data.currencyLimitations.currencies.join(" · ") || "—"} · {t("finance.fxNotConverted")}
        </div>
      </Card>
    </div>
  );
}

const LIST_COPY = {
  invoiceTitle: ["Supplier invoice list", "采购发票列表"],
  payableTitle: ["Payables list", "应付款列表"],
  creditTitle: ["Supplier credit note list", "供应商贷项通知单列表"],
  matchTitle: ["Match exception list", "匹配异常列表"],
  awaitingMatch: ["Awaiting match", "待匹配"],
  awaitingMatchNote: ["Submitted, not yet matched to the PO and receipt", "已提交，尚未与采购订单和收货核对"],
  exceptions: ["Match exceptions", "匹配异常"],
  exceptionsNote: ["Price or quantity differs from the PO or receipt", "价格或数量与采购订单、收货不一致"],
  matched: ["Matched, to approve", "已匹配待批准"],
  matchedNote: ["Matched and waiting for approval", "已匹配，等待批准"],
  // Approved invoices by where their payment stands, from their payable
  // (the server's paymentStatus). A seeded or imported invoice approved
  // without a payable is in none of these and reads "Approved".
  toPay: ["To pay", "待付款"],
  toPayNote: ["Approved, nothing paid yet", "已批准，尚未付款"],
  partlyPaid: ["Partly paid", "部分付款"],
  partlyPaidNote: ["Approved and paid in part", "已批准，已付部分款项"],
  // The payables cards, as the receivables page has them.
  unpaid: ["To pay", "待付款"],
  unpaidNote: ["Approved, not yet paid in full", "已批准，尚未全额付款"],
  unpaidStatus: ["Not paid in full", "未全额付款"],
  overdue: ["Overdue", "已逾期"],
  overdueNote: ["Past the due date and not paid in full", "已过到期日且未全额付款"],
  held: ["Held", "已暂停"],
  heldNote: ["Held from payment until released", "暂停付款，解除前不付"],
  paid: ["Paid", "已结清"],
  paidNote: ["Paid in full", "已全额付款"],
  searchTitle: ["Supplier invoice search", "采购发票查询"],
  searchSubtitle: ["Search supplier invoices by number, supplier, purchase order, status and variance.", "按发票编号、供应商、采购订单、状态和差异查询采购发票。"],
  search: ["Search", "搜索"],
  searchPlaceholder: ["Invoice number, supplier or PO, then Enter", "发票编号、供应商或采购订单，按回车查询"],
  supplier: ["Supplier", "供应商"],
  allSuppliers: ["All suppliers", "全部供应商"],
  allStatuses: ["All statuses", "全部状态"],
  variance: ["Variance", "差异"],
  anyVariance: ["Any", "全部"],
  withVariance: ["With a variance", "有差异"],
  noVariance: ["No variance", "无差异"],
  poReceipt: ["PO / receipt", "采购订单 / 收货单"],
  invoiceDate: ["Invoice date", "发票日期"],
  due: ["Due", "到期"],
  dueDate: ["Due date", "到期日"],
  outstanding: ["Outstanding", "未付金额"],
  next: ["Next", "下一步"],
  view: ["View", "查看"],
  actions: ["Actions", "操作"],
  noMatch: ["No supplier invoices match these filters", "没有符合筛选条件的采购发票"],
  noRows: ["Nothing matches these filters", "没有符合筛选条件的记录"],
  payableSearch: ["Payable search", "应付查询"],
  payableSearchSubtitle: ["Approved supplier invoices to pay, by number, supplier and status.", "按单号、供应商和状态查询待付款的已批准采购发票。"],
  creditSearch: ["Supplier credit note search", "供应商贷项通知单查询"],
  creditSearchSubtitle: ["Credit notes raised from posted supplier returns.", "由已过账的供应商退货生成的贷项通知单。"],
  matchSearch: ["Match exception search", "匹配异常查询"],
  matchSearchSubtitle: ["Price and quantity differences found when matching invoices.", "发票匹配时发现的价格和数量差异。"],
  searchRecord: ["Number or supplier, then Enter", "单号或供应商，按回车查询"],
  payableNumber: ["Payable", "应付单"],
  creditNumber: ["Credit note", "贷项通知单"],
  exceptionNumber: ["Exception", "异常"],
  supplierOrReturn: ["Supplier / return", "供应商 / 退货"],
  nextStep: ["Next step", "下一步"],
  supplierCreditNoRefund: ["A supplier credit note does not record a refund from the supplier.", "供应商贷项通知单不代表已收到供应商退款。"],
  // What each list shows, and when its first record appears.
  emptyInvoice: ["No supplier invoices yet", "暂无采购发票"],
  emptyInvoiceDetail: ["Supplier invoices appear here once you enter one against a purchase order and its receipt.", "按采购订单和收货登记采购发票后，会显示在这里。"],
  emptyPayable: ["No payables yet", "暂无应付款"],
  emptyPayableDetail: ["A payable is recorded when a supplier invoice is approved, and stays here until it is paid in full.", "采购发票批准后会生成应付款，并在全额付款前一直显示在这里。"],
  emptyCredit: ["No supplier credit notes yet", "暂无供应商贷项通知单"],
  emptyCreditDetail: ["A credit note appears here once a supplier return is posted and credited.", "供应商退货过账并生成贷项后，会显示在这里。"],
  emptyMatch: ["No match exceptions", "暂无匹配异常"],
  emptyMatchDetail: ["Price or quantity differences found when a supplier invoice is matched to its purchase order and receipt appear here.", "采购发票与采购订单、收货核对时发现的价格或数量差异会显示在这里。"],
  // A receipt whose GRN number could not be read: named, never by its id.
  receipt: ["Receipt", "收货单"],
  toReview: ["To review", "待复核"],
  rejected: ["Rejected", "已驳回"],
  reviewOnInvoice: ["Review it on the supplier invoice", "在采购发票上复核"],
} as const;

// The statuses each list's filter offers, besides those on the page.
const STATUS_OPTIONS: Record<string, string[]> = {
  // to_pay, partially_settled and settled: approved invoices by payment state.
  invoice: ["draft", "submitted", "matched", "exception", "approved", "to_pay", "partially_settled", "settled", "cancelled"],
  payable: ["outstanding", "overdue", "approved", "export_ready", "held", "partially_settled", "settled", "cancelled"],
  credit: [],
  match: [],
};

// One page of a supplier-side list. The address holds the filters and the
// page; the server filters, pages, counts every record the filters match and
// counts the metric cards over the whole workspace.
function FinanceList({
  endpoint,
  capability,
  kind,
}: {
  endpoint: string;
  capability: string;
  kind: "invoice" | "payable" | "credit" | "match";
}) {
  const { t, locale, language, timezone, formatNumber } = useI18n();
  const tr = (key: keyof typeof LIST_COPY) => LIST_COPY[key][language === "en-US" ? 0 : 1];
  // "Next: Approve"; in Chinese the full-width colon, with no space after it.
  const colon = language === "en-US" ? ": " : "：";
  const [searchParams, setSearchParams] = useSearchParams();
  const [data, setData] = useState<ListPayload | null>(null);
  const [error, setError] = useState<ApiErrorView | null>(null);
  const invoices = kind === "invoice";
  const payables = kind === "payable";
  const status = searchParams.get("status") || "";
  const search = searchParams.get("search") || "";
  const supplier = invoices ? searchParams.get("supplier") || "" : "";
  // An address with matchStatus=variance (the purchase order cards) starts on invoices with a variance.
  const variance = invoices ? searchParams.get("variance") || (searchParams.get("matchStatus") === "variance" ? "with" : "") : "";
  const page = Math.max(1, Math.floor(Number(searchParams.get("page"))) || 1);
  const [searchText, setSearchText] = useState(search);
  useEffect(() => setSearchText(search), [search]);
  const request = useMemo(() => {
    const params = new URLSearchParams();
    if (status) params.set("status", status);
    if (search) params.set("search", search);
    if (supplier) params.set("supplier", supplier);
    if (variance) params.set("variance", variance);
    if (page > 1) params.set("page", String(page));
    params.set("pageSize", String(PAGE_SIZE));
    // Payables: overdue first, then the rest still owed, then paid.
    if (payables) params.set("sort", "attention");
    return `${endpoint}?${params.toString()}`;
  }, [endpoint, status, search, supplier, variance, page, payables]);
  const latest = useRef("");
  const load = useCallback(() => {
    setError(null);
    latest.current = request;
    void apiJson<ListPayload>(request)
      .then((payload) => { if (latest.current === request) setData(payload); })
      .catch((reason) => { if (latest.current === request) setError(apiErrorView(reason, language, LOAD_FAILED)); });
  }, [request]);
  useEffect(load, [load]);
  // A change of filter starts at page 1 and replaces the address; a new page
  // is a step that Back undoes.
  const update = (changes: Record<string, string>) => {
    const params = new URLSearchParams(searchParams);
    const paging = "page" in changes;
    if (!paging) params.delete("page");
    if ("variance" in changes) params.delete("matchStatus");
    for (const [key, entry] of Object.entries(changes)) entry ? params.set(key, entry) : params.delete(key);
    setSearchParams(params, { replace: !paging });
  };
  // A page past the end (the records changed since) goes back to the first.
  useEffect(() => {
    if (data && !data.items.length && data.total > 0 && page > 1) update({ page: "" });
  }, [data]);
  // The supplier invoice list names each receipt by its GRN number. The list
  // API gives the receipt's id only, so the receiving list is read once for
  // the numbers; a receipt it does not show (no receiving access) reads
  // "Receipt", never its id.
  const [receiptNumbers, setReceiptNumbers] = useState<Map<string, string>>(() => new Map());
  const receiptsAsked = useRef(false);
  const receiptMissing = invoices && Boolean(data?.items.some((row) => row.relatedGrnId && !receiptNumbers.has(String(row.relatedGrnId))));
  useEffect(() => {
    if (!receiptMissing || receiptsAsked.current) return;
    receiptsAsked.current = true;
    void apiJson<{ items?: Array<{ id: string; documentNumber?: string | null }> }>("/api/procurement/receiving")
      .then((payload) => setReceiptNumbers(new Map((payload.items || []).filter((row) => row.documentNumber).map((row) => [String(row.id), String(row.documentNumber)]))))
      .catch(() => undefined);
  }, [receiptMissing]);
  // A supplier invoice opened from the payables list returns to it, filters kept.
  const location = useLocation();
  const billFromPayables = (billId: string) => `/app/procurement/bills/${encodeURIComponent(billId)}?returnTo=${encodeURIComponent(`${location.pathname}${location.search}`)}`;
  if (error) return <Warning title={error.code}>{error.message}</Warning>;
  if (!data) return <Card className="p-6">{t("common.loading")}</Card>;
  const enabled = data.capabilities?.[capability]?.enabled;
  const today = todayInTimeZone(timezone);
  const statusOf = (row: Record<string, any>) => String(value(row, "status", "matchStatus") || "");
  const derivedLabels: Record<string, string> = { outstanding: tr("unpaidStatus") };
  const statusText = (code: string) => derivedLabels[code] || (tokenKeys[code] ? t(tokenKeys[code]) : code || "—");
  // Action codes, labelled; `skip` leaves codes out (Cancel is not a next step).
  const actionsOf = (row: Record<string, any>, skip: string[] = []) =>
    (value(row, "availableActions") || []).filter((action: string) => !skip.includes(action)).map((action: string) => tokenKeys[action] ? t(tokenKeys[action]) : action) as string[];
  const rows = data.items;
  const count = (key: string) => String(data.counts?.[key] ?? 0);
  const statuses = [...new Set([...STATUS_OPTIONS[kind], ...rows.map(statusOf), status].filter(Boolean))];
  const suppliers = [...new Set([...(data.suppliers || []), ...rows.map((row) => String(row.supplierName || "")), supplier].filter(Boolean))].sort();
  const anyFilter = Boolean(status || search || supplier || variance);
  const title = tr(kind === "invoice" ? "invoiceTitle" : kind === "payable" ? "payableTitle" : kind === "credit" ? "creditTitle" : "matchTitle");
  const reset = () => {
    setSearchText("");
    setSearchParams({}, { replace: true });
  };
  const empty = {
    invoice: [tr("emptyInvoice"), tr("emptyInvoiceDetail")],
    payable: [tr("emptyPayable"), tr("emptyPayableDetail")],
    credit: [tr("emptyCredit"), tr("emptyCreditDetail")],
    match: [tr("emptyMatch"), tr("emptyMatchDetail")],
  }[kind];
  const searchField = (placeholder: string) => (
    <Field label={tr("search")}>
      <input
        aria-label={tr("search")}
        type="search"
        value={searchText}
        onChange={(event) => setSearchText(event.target.value)}
        onKeyDown={(event) => { if (event.key === "Enter") update({ search: searchText.trim() }); }}
        onBlur={() => { if (searchText.trim() !== search) update({ search: searchText.trim() }); }}
        placeholder={placeholder}
        style={inputStyle}
      />
    </Field>
  );
  const statusField = (
    <Field label={t("finance.status")}>
      <select aria-label={t("finance.status")} value={status} onChange={(event) => update({ status: event.target.value })} style={inputStyle}>
        <option value="">{tr("allStatuses")}</option>
        {statuses.map((code) => <option key={code} value={code}>{statusText(code)}</option>)}
      </select>
    </Field>
  );
  const pager = (
    <ListPager
      page={data.page || page}
      pageSize={data.pageSize || PAGE_SIZE}
      total={data.total}
      onPage={(next) => update({ page: next > 1 ? String(next) : "" })}
      testId={`operational-finance-${kind}-pager`}
    />
  );
  const emptyRow = (colSpan: number) => !rows.length && (anyFilter
    ? <ListStateRow colSpan={colSpan} state="empty" title={tr(invoices ? "noMatch" : "noRows")} />
    : <ListStateRow colSpan={colSpan} state="empty" title={empty[0]} detail={empty[1]} />);
  return (
    <div className="space-y-5" data-testid={`operational-finance-${kind}-list`}>
      {invoices && (
        // Six cards: three rows of two on a phone, two rows of three wider.
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-3" data-testid="supplier-invoice-metrics">
          <ActionableMetricCard label={tr("awaitingMatch")} value={count("submitted")} description={tr("awaitingMatchNote")} to="/app/procurement/bills?status=submitted" icon={Inbox} color={A.orange} />
          <ActionableMetricCard label={tr("exceptions")} value={count("exception")} description={tr("exceptionsNote")} to="/app/procurement/bills?status=exception" icon={AlertCircle} color={A.red} />
          <ActionableMetricCard label={tr("matched")} value={count("matched")} description={tr("matchedNote")} to="/app/procurement/bills?status=matched" icon={ShieldCheck} color={A.blue} />
          <ActionableMetricCard label={tr("toPay")} value={count("to_pay")} description={tr("toPayNote")} to="/app/procurement/bills?status=to_pay" icon={Wallet} color={A.blue} />
          <ActionableMetricCard label={tr("partlyPaid")} value={count("partially_settled")} description={tr("partlyPaidNote")} to="/app/procurement/bills?status=partially_settled" icon={Coins} color={A.orange} />
          <ActionableMetricCard label={tr("paid")} value={count("settled")} description={tr("paidNote")} to="/app/procurement/bills?status=settled" icon={CheckCircle2} color={A.purple} />
        </div>
      )}
      {payables && (
        <div className={metricGridClass} data-testid="payable-metrics">
          <ActionableMetricCard label={tr("unpaid")} value={count("outstanding")} description={tr("unpaidNote")} to="/app/finance/payables?status=outstanding" icon={Wallet} color={A.blue} />
          <ActionableMetricCard label={tr("overdue")} value={count("overdue")} description={tr("overdueNote")} to="/app/finance/payables?status=overdue" icon={AlertTriangle} color={A.red} />
          <ActionableMetricCard label={tr("held")} value={count("held")} description={tr("heldNote")} to="/app/finance/payables?status=held" icon={PauseCircle} color={A.orange} />
          <ActionableMetricCard label={tr("paid")} value={count("settled")} description={tr("paidNote")} to="/app/finance/payables?status=settled" icon={CheckCircle2} color={A.purple} />
        </div>
      )}
      {invoices ? (
        <ListSearchCard
          title={tr("searchTitle")}
          subtitle={tr("searchSubtitle")}
          actions={<>
            <ResetButton onClick={reset} />
            <RefreshButton onClick={load} />
            {enabled && <Link data-testid="supplier-invoice-new" to="/app/procurement/bills/new" className={listButtonClass.primary}><Plus size={13} />{t("finance.newSupplierInvoice")}</Link>}
          </>}
        >
          {searchField(tr("searchPlaceholder"))}
          <Field label={tr("supplier")}>
            <select aria-label={tr("supplier")} value={supplier} onChange={(event) => update({ supplier: event.target.value })} style={inputStyle}>
              <option value="">{tr("allSuppliers")}</option>
              {suppliers.map((name) => <option key={name} value={name}>{name}</option>)}
            </select>
          </Field>
          {statusField}
          <Field label={tr("variance")}>
            <select aria-label={tr("variance")} value={variance} onChange={(event) => update({ variance: event.target.value })} style={inputStyle}>
              <option value="">{tr("anyVariance")}</option>
              <option value="with">{tr("withVariance")}</option>
              <option value="none">{tr("noVariance")}</option>
            </select>
          </Field>
        </ListSearchCard>
      ) : (
        <ListSearchCard
          title={tr(kind === "payable" ? "payableSearch" : kind === "credit" ? "creditSearch" : "matchSearch")}
          subtitle={tr(kind === "payable" ? "payableSearchSubtitle" : kind === "credit" ? "creditSearchSubtitle" : "matchSearchSubtitle")}
          actions={<>
            <ResetButton onClick={reset} />
            <RefreshButton onClick={load} />
          </>}
        >
          {searchField(tr("searchRecord"))}
          {statusField}
        </ListSearchCard>
      )}
      {/* Notices sit in one place on every finance list: between the search
          card and the list they explain, one per page. */}
      {!enabled && <Warning>{t("finance.capabilityDisabled")}</Warning>}
      {payables && <Warning testId="payables-notice">{t("finance.notPaid")}</Warning>}
      {kind === "credit" && <Warning>{tr("supplierCreditNoRefund")}</Warning>}
      <ListCard title={title} total={data.total} shown={rows.length}>
        <div className={tableScrollClass}>
          {invoices ? (
            <table className={`w-full min-w-[1080px] text-left ${tableBodyTextClass}`}>
              <thead>
                <tr style={listHeadRowStyle}>
                  <th className={`${thClass} sticky left-0 z-20 bg-white`} style={{ color: A.gray1 }}>{t("finance.invoiceNumber")}</th>
                  <th className={thClass} style={{ color: A.gray1 }}>{tr("supplier")}</th>
                  <th className={thClass} style={{ color: A.gray1 }}>{tr("poReceipt")}</th>
                  <th className={thClass} style={{ color: A.gray1 }}>{tr("invoiceDate")}</th>
                  <th className={thRightClass} style={{ color: A.gray1 }}>{t("finance.amount")}</th>
                  <th className={thRightClass} style={{ color: A.gray1 }}>{tr("variance")}</th>
                  <th className={thClass} style={{ color: A.gray1 }}>{t("finance.status")}</th>
                  <th className={`${thClass} sticky right-0 z-20 bg-white`} style={{ color: A.gray1 }}>{tr("actions")}</th>
                </tr>
              </thead>
              <tbody>
                {emptyRow(8)}
                {rows.map((row, index) => {
                  const id = String(row.id || "");
                  // An invoice whose every match difference was approved is no
                  // longer an open variance: it reads "Variance approved" until
                  // the invoice itself is approved. Once approved it reads where
                  // its payment stands: To pay, Partly paid or Paid.
                  const rawStatus = shownBillStatus(row);
                  const next = actionsOf(row, ["cancel"]);
                  const varianceAmount = Number(row.varianceAmount || 0);
                  return (
                    <tr className={listRowClass} style={listRowStyle(index, rows.length)} key={id}>
                      <td className={`${tdIdClass} sticky left-0 z-10 bg-white`}>
                        <EntityLink kind="supplier_invoice" id={id} className={tableLinkClass}>{String(row.invoiceNumber || id)}</EntityLink>
                      </td>
                      <td className={`${tdNameClass} max-w-[200px] truncate`} title={row.supplierName}>{row.supplierName || "—"}</td>
                      <td className={tdNowrapClass}>
                        {row.relatedPoId ? <EntityLink kind="purchase_order" id={row.relatedPoId} number={row.relatedPoNumber || row.poNumber} className="font-medium" /> : <span style={{ color: A.gray2 }}>—</span>}
                        <div className="text-[11px]" style={{ color: A.sub }} data-testid="supplier-invoice-receipt-number">{row.relatedGrnId ? <EntityLink kind="receiving_doc" id={row.relatedGrnId} className="text-[11px] font-normal">{row.relatedGrnNumber || receiptNumbers.get(String(row.relatedGrnId)) || tr("receipt")}</EntityLink> : "—"}</div>
                      </td>
                      <td className={tdNowrapClass}>
                        <div>{formatCalendarDay(row.invoiceDate, locale)}</div>
                        {row.dueDate && <div className="text-[11px]" style={{ color: A.sub }}>{tr("due")} {formatCalendarDay(row.dueDate, locale)}</div>}
                      </td>
                      <td className={`${tdNumericRightClass} font-semibold`} style={{ color: A.label }}>{money(row.totalAmount, row.currency, locale)}</td>
                      <td className={tdNumericRightClass} style={{ color: varianceAmount ? PAST_DUE_COLOR : A.sub }}>{varianceAmount ? money(row.varianceAmount, row.currency, locale) : "—"}</td>
                      <td className={tdNowrapClass}>
                        <div className="flex flex-wrap items-center gap-1">
                          <StatusChip label={statusText(rawStatus)} tone={financeStatusTone(rawStatus)} />
                          {row.awaitingReceipt && (
                            <span data-testid="bill-awaiting-receipt">
                              <StatusChip label={t("finance.awaitingReceipt")} tone="warning" />
                            </span>
                          )}
                        </div>
                        {next.length > 0 && <div className="mt-1 hidden text-[11px] sm:block" style={{ color: A.sub }}>{tr("next")}{colon}{next.join(" · ")}</div>}
                      </td>
                      <td className={`${tdNowrapClass} sticky right-0 z-10 bg-white`}>
                        <EntityLink kind="supplier_invoice" id={id} className={`${rowActionClass.primary} !no-underline`}>{tr("view")}</EntityLink>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          ) : payables ? (
            // The payables list reads like the receivables list: the payable
            // and its bill, the supplier, the due date (red once past due),
            // what is still owed, the status with the next step, and View.
            <table className={`w-full min-w-[960px] text-left ${tableBodyTextClass}`}>
              <thead>
                <tr style={listHeadRowStyle}>
                  <th className={`${thClass} sticky left-0 z-20 bg-white`} style={{ color: A.gray1 }}>{tr("payableNumber")}</th>
                  <th className={thClass} style={{ color: A.gray1 }}>{tr("supplier")}</th>
                  <th className={thClass} style={{ color: A.gray1 }}>{tr("dueDate")}</th>
                  <th className={thRightClass} style={{ color: A.gray1 }}>{tr("outstanding")}</th>
                  <th className={thClass} style={{ color: A.gray1 }}>{t("finance.status")}</th>
                  <th className={`${thClass} sticky right-0 z-20 bg-white`} style={{ color: A.gray1 }}>{tr("actions")}</th>
                </tr>
              </thead>
              <tbody>
                {emptyRow(6)}
                {rows.map((row, index) => {
                  const id = String(row.id || "");
                  const billId = String(row.supplierInvoiceId || "");
                  const rawStatus = statusOf(row);
                  const pastDue = PAYABLE_OPEN_STATUSES.includes(rawStatus) && Number(row.outstandingAmount ?? 1) !== 0 && Boolean(row.dueDate) && String(row.dueDate).slice(0, 10) < today;
                  const next = actionsOf(row);
                  return (
                    <tr className={listRowClass} style={listRowStyle(index, rows.length)} key={id} data-testid="payable-row">
                      <td className={`${tdIdClass} sticky left-0 z-10 bg-white`}>
                        {billId
                          ? <Link to={billFromPayables(billId)} className={`fc-entity-link font-semibold text-blue-600 underline-offset-2 ${tableLinkClass}`}>{String(row.obligationNumber || id)}</Link>
                          : String(row.obligationNumber || id)}
                        {row.supplierInvoiceNumber && <div className="text-[11px] font-normal" style={{ color: A.sub }}>{row.supplierInvoiceNumber}</div>}
                      </td>
                      <td className={`${tdNameClass} max-w-[220px] truncate`} title={row.supplierName || undefined}>{row.supplierName || "—"}</td>
                      <td className={tdNowrapClass} style={{ color: pastDue ? PAST_DUE_COLOR : A.sub }}>{formatCalendarDay(row.dueDate, locale)}</td>
                      <td className={`${tdNumericRightClass} font-semibold`} style={{ color: A.label }}>{money(row.outstandingAmount, row.currency, locale)}</td>
                      <td className={tdNowrapClass}>
                        <div className="flex flex-wrap items-center gap-1">
                          <StatusChip label={statusText(rawStatus)} tone={statusToneOf(rawStatus)} />
                          {pastDue && <StatusChip label={statusText("overdue")} tone="danger" />}
                        </div>
                        {next.length > 0 && <div className="mt-1 hidden text-[11px] sm:block" style={{ color: A.sub }}>{tr("next")}{colon}{next.join(" · ")}</div>}
                      </td>
                      <td className={`${tdNowrapClass} sticky right-0 z-10 bg-white`}>
                        {billId ? <Link to={billFromPayables(billId)} className={`${rowActionClass.primary} !no-underline`}>{tr("view")}</Link> : <span style={{ color: A.gray2 }}>—</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          ) : (
            <table className={`w-full min-w-[850px] text-left ${tableBodyTextClass}`}>
              <thead>
                <tr style={listHeadRowStyle}>
                  <th className={`${thClass} sticky left-0 z-20 bg-white`} style={{ color: A.gray1 }}>{tr(kind === "credit" ? "creditNumber" : "exceptionNumber")}</th>
                  <th className={thClass} style={{ color: A.gray1 }}>{kind === "credit" ? tr("supplierOrReturn") : t("finance.invoiceNumber")}</th>
                  <th className={thRightClass} style={{ color: A.gray1 }}>{t("finance.amount")}</th>
                  <th className={thClass} style={{ color: A.gray1 }}>{t("finance.status")}</th>
                  <th className={thClass} style={{ color: A.gray1 }}>{tr("nextStep")}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row, index) => {
                  const id = String(value(row, "id") || "");
                  // A match exception reads as its kind of difference, in the interface language.
                  const label = String(
                    (kind === "match"
                      ? (row.exceptionType ? matchExceptionLabel(row.exceptionType, language) : value(row, "matchNumber"))
                      : value(row, "creditMemoNumber")) || id,
                  );
                  const source = String(
                    (kind === "match"
                      ? value(row, "invoiceNumber", "supplierInvoiceId")
                      : value(
                          row,
                          "supplierName",
                          "supplierInvoiceNumber",
                          "returnPostingNumber",
                          "supplierInvoiceId",
                        )) || "—",
                  );
                  const amount = value(row, "totalAmount", "varianceValue");
                  const rawStatus = statusOf(row);
                  // A match exception is reviewed on its supplier invoice: open
                  // reads "To review", and the invoice number opens it.
                  const matchRow = kind === "match";
                  const shownStatus = matchRow && rawStatus === "open" ? tr("toReview") : matchRow && rawStatus === "rejected" ? tr("rejected") : statusText(rawStatus);
                  const tone = matchRow && rawStatus === "open" ? "warning" : statusToneOf(rawStatus);
                  return (
                    <tr className={listRowClass} style={listRowStyle(index, rows.length)} key={id}>
                      <td className={`${tdIdClass} sticky left-0 z-10 bg-white`}>{label}</td>
                      <td className={tdNameClass}>{matchRow && row.supplierInvoiceId ? <EntityLink kind="supplier_invoice" id={String(row.supplierInvoiceId)} className={tableLinkClass}>{source}</EntityLink> : source}</td>
                      <td className={`${tdNumericRightClass} font-semibold`} style={{ color: A.label }}>
                        {/* A quantity difference is a quantity, not money. */}
                        {matchRow && row.exceptionType === "quantity"
                          ? amount === null || amount === undefined || !Number.isFinite(Number(amount)) ? "—" : formatNumber(Number(amount))
                          : money(amount, value(row, "currency"), locale)}
                      </td>
                      <td className={tdNowrapClass}>
                        <StatusChip label={shownStatus} tone={tone} />
                      </td>
                      <td className={tdNowrapClass} style={{ color: A.sub }}>
                        {matchRow ? (rawStatus === "open" ? tr("reviewOnInvoice") : "—") : actionsOf(row).join(" · ") || "—"}
                      </td>
                    </tr>
                  );
                })}
                {emptyRow(5)}
              </tbody>
            </table>
          )}
        </div>
        {pager}
      </ListCard>
    </div>
  );
}

export default function OperationalFinanceP2pWorkbench({
  view,
}: {
  view: "overview" | "invoices" | "payables" | "credits" | "match";
}) {
  if (view === "overview") return <FinanceLanding />;
  if (view === "payables")
    return (
      <FinanceList
        endpoint="/api/finance/payables"
        capability="payable-obligation"
        kind="payable"
      />
    );
  if (view === "credits")
    return (
      <FinanceList
        endpoint="/api/finance/supplier-credit-memos"
        capability="supplier-credit-memo"
        kind="credit"
      />
    );
  if (view === "match")
    return (
      <FinanceList
        endpoint="/api/finance/match-exceptions"
        capability="three-way-match"
        kind="match"
      />
    );
  return (
    <FinanceList
      endpoint="/api/finance/supplier-invoices"
      capability="supplier-invoice"
      kind="invoice"
    />
  );
}
