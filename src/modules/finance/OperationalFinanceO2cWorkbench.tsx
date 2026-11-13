import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { AlertTriangle, CheckCircle2, FilePlus2, FileText, MessageSquareWarning, Send, Wallet } from "lucide-react";
import { Link, useLocation, useNavigate } from "react-router";
import { toast } from "sonner";
import { ApiError, apiJson } from "../../lib/api-client";
import { apiErrorView, type ApiErrorView } from "../../lib/apiErrorText";
import { BusinessEntityLink } from "../../components/business/BusinessEntityLink";
import { StatusChip, TwoStepAction, shownCustomerInvoiceStatus, useFinanceStatusLabel } from "./FinanceControls";
import { PaymentRecords } from "./PaymentRecords";
import { useI18n } from "../../i18n/I18n";
import { unitLabel } from "../../i18n/unitLabels";
import { A, Card, Field, inputStyle, useConfirm } from "../../components/ui";
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
import { formatCalendarDay, formatDateTimeInTimeZone, formatQuantity, todayInTimeZone } from "../../lib/format";

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
  // Once issued: to_be_paid, partially_settled or settled.
  paymentStatus?: string | null;
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
type InvoiceRef = { id: string; invoiceNumber: string; status: string };
type EntryData = {
  today?: string;
  postedShipments: Array<{
    id: string;
    shipmentNumber: string;
    salesOrderId: string;
    salesOrderNumber?: string;
    customerName: string;
    customerPaymentTerm?: { code: string; name: string; days: number } | null;
    // The terms as recorded on the customer ("NET30"), matched or not.
    customerPaymentTerms?: string | null;
    currency: string;
    // Something is left to invoice; the invoices (drafts included) already on it.
    invoiceable?: boolean;
    invoices?: InvoiceRef[];
    lines: Array<{
      id: string;
      sku: string;
      itemName: string;
      postedQuantity: string;
      // On a draft or an invoice that holds the shipment, and what is left.
      invoicedQuantity?: string;
      remainingQuantity?: string;
      unit?: string | null;
      unitPrice: string | null;
    }>;
  }>;
  // The order or shipment the form was opened from.
  customerInvoiceSource?: {
    salesOrder?: { id: string; orderNumber: string } | null;
    shipment?: { id: string; shipmentNumber: string; salesOrderId: string } | null;
  };
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
// A receivable nothing has been received on reads "To be paid", in the words
// its invoice uses; past its due day, "Overdue".
const receivableChip = (row: { status: string; dueDate?: string | null }, today: string) =>
  receivablePastDue(row, today) && row.status === "open" ? "overdue" : row.status === "open" ? "to_be_paid" : row.status;
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
  // The list follows the box as you type.
  searchPlaceholder: ["Invoice number or customer", "发票编号或客户"],
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
  // The page's own title already says "Receivables aging"; the card says what it lists.
  agingByCurrency: ["By currency", "按币种"],
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
  // The list's open status, in the words the invoice uses for it.
  toBePaid: ["To be paid", "待收款"],
} as const;

// The invoice page's copy: its facts, totals, history, the next step and the
// toasts that say a step is done.
const DETAIL_COPY = {
  invoiceDate: ["Invoice date", "发票日期"],
  dueDate: ["Due date", "到期日"],
  customer: ["Customer", "客户"],
  salesOrder: ["Sales order", "销售订单"],
  shipment: ["Shipment", "发货单"],
  total: ["Total", "合计"],
  subtotal: ["Subtotal", "小计"],
  tax: ["Tax", "税额"],
  totalIn: ["Total ({currency})", "合计（{currency}）"],
  overdue: ["Overdue", "已逾期"],
  history: ["History", "处理记录"],
  created: ["Draft created", "创建草稿"],
  submitted: ["Submitted for approval", "提交审批"],
  approved: ["Approved", "批准"],
  issued: ["Issued to the customer; receivable opened", "开具给客户，生成应收款"],
  cancelled: ["Cancelled", "已取消"],
  cancelledBecause: ["Cancelled: {reason}", "已取消：{reason}"],
  paymentReceived: ["Payment received · {amount}", "收款 · {amount}"],
  paymentVoided: ["Payment voided · {amount}", "收款已作废 · {amount}"],
  nextPayment: ["Next: record the payment received", "下一步：登记收款"],
  paidInFull: ["Paid in full. Nothing else to do.", "已全额收款，无需其他操作。"],
  cancelDraft: ["Cancel draft", "取消草稿"],
  cancelInvoice: ["Cancel invoice", "取消发票"],
  cancelTitle: ["Cancel {number}?", "取消 {number}？"],
  cancelBody: ["The invoice stays on record as cancelled, with your reason. Its shipped goods can be invoiced again. Nothing is sent to the customer.", "发票会以“已取消”状态保留，并记录原因。其发货数量可以重新开票。不会通知客户。"],
  cancelReason: ["Why is it cancelled?", "取消原因"],
  keep: ["Keep it", "保留"],
  cancelFailed: ["Could not cancel the invoice. Reload the page and try again.", "无法取消发票，请刷新页面后重试。"],
  cancelNotAllowed: ["Only a draft or submitted invoice that was never issued can be cancelled.", "只有从未开具的草稿或已提交发票可以取消。"],
  toastCreated: ["Draft {number} created", "已创建草稿 {number}"],
  toastSubmitted: ["{number} submitted for approval", "{number} 已提交审批"],
  toastApproved: ["Approved {number}", "已批准 {number}"],
  toastIssued: ["Issued {number}; its receivable is open", "已开具 {number}，已生成应收款"],
  toastCancelled: ["Cancelled {number}", "已取消 {number}"],
} as const;

function useDetailCopy() {
  const { language } = useI18n();
  return (key: keyof typeof DETAIL_COPY, values: Record<string, string> = {}) =>
    DETAIL_COPY[key][language === "en-US" ? 0 : 1].replace(/\{(\w+)\}/g, (_, name) => values[name] ?? "");
}

// The new customer invoice form's copy, and the messages for what the
// server refuses, by its codes.
const FORM_COPY = {
  intro: ["Raise an invoice from a posted shipment. Saving creates a draft to submit for approval; nothing is sent to the customer.", "根据已过账的发货开具发票。保存后生成草稿，再提交审批；不会发给客户。"],
  details: ["Invoice details", "发票信息"],
  chooseShipment: ["Choose a posted shipment", "选择正式发货单"],
  noShipments: ["No posted shipment is waiting to be invoiced.", "暂无可开票的正式发货单。"],
  lines: ["Lines", "发票行"],
  linesIntro: ["Invoice up to what is shipped and not yet on an invoice. A line left empty or at 0 is not invoiced.", "开票数量不超过已发货、尚未开票的数量。数量留空或为 0 的行不开票。"],
  // Each line: what was shipped, what is already on an invoice (drafts
  // included) and what is left, which the quantity starts at.
  lineProgress: ["Shipped {shipped} · already invoiced {invoiced} · left to invoice {left}", "已发货 {shipped} · 已开票 {invoiced} · 可开票 {left}"],
  shipmentInvoiced: ["Everything shipped on {shipment} is already on an invoice:", "{shipment} 的发货数量已全部开票："],
  orderInvoiced: ["Everything shipped on {order} is already on an invoice:", "{order} 的发货数量已全部开票："],
  draftHolds: ["A draft keeps its quantity until it is submitted or cancelled.", "草稿在提交或取消前会占用其数量。"],
  // The customer's recorded terms name no payment term of the workspace: no
  // due date is made up.
  termsMissing: ["{terms} is not set up as a payment term, so the due date is not filled in.", "{terms} 未设置为付款条款，因此未自动填写到期日。"],
  termsAdd: ["Add it under Master data → Payment terms.", "请在“主数据 → 付款条款”中添加。"],
  linesEmpty: ["Choose a shipment to see its lines.", "选择发货单后显示其明细行。"],
  line: ["Line {n}", "第 {n} 行"],
  customer: ["Customer", "客户"],
  currency: ["Currency", "币种"],
  salesOrder: ["Sales order", "销售订单"],
  shipmentRequired: ["Choose the posted shipment to invoice.", "请选择要开票的正式发货单。"],
  dueRequired: ["Enter the due date.", "请填写到期日。"],
  lineRequired: ["Enter an invoice quantity on at least one line.", "请至少为一行填写开票数量。"],
  quantityInvalid: ["Enter a quantity above 0, with up to 4 decimal places.", "请填写大于 0 的数量，最多 4 位小数。"],
  quantityOver: ["More than the {left} left to invoice.", "超过可开票数量 {left}。"],
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
// do; a change goes through the router, so the list reloads and the unsaved-
// changes guard sees an ordinary navigation (a pushed state with a synthetic
// popstate made React Router warn of a blocker on a POP navigation). A change
// of filter starts at page 1.
function useSetQuery() {
  const navigate = useNavigate();
  return useCallback((updates: Record<string, string>) => {
    const next = new URLSearchParams(window.location.search);
    if (!("page" in updates)) next.delete("page");
    for (const [key, value] of Object.entries(updates)) value ? next.set(key, value) : next.delete(key);
    const query = next.toString();
    if (query === new URLSearchParams(window.location.search).toString()) return;
    navigate({ pathname: window.location.pathname, search: query ? `?${query}` : "" });
  }, [navigate]);
}

// How long typing pauses before the list follows the search box.
const SEARCH_DELAY = 350;

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
  const setQuery = useSetQuery();
  const params = new URLSearchParams(window.location.search);
  const [search, setSearch] = useState(params.get("search") || "");
  // The box follows the address when a link or Reset changes it; what is
  // being typed (a trailing space) is kept when it searches the same.
  const addressSearch = params.get("search") || "";
  useEffect(() => setSearch((typed) => (typed.trim() === addressSearch ? typed : addressSearch)), [addressSearch]);
  // The list follows the box once typing pauses, as the order and stock
  // lists do; Enter searches at once.
  useEffect(() => {
    if (search.trim() === addressSearch) return;
    const timer = window.setTimeout(() => setQuery({ search: search.trim() }), SEARCH_DELAY);
    return () => window.clearTimeout(timer);
  }, [search, addressSearch, setQuery]);
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
  const setQuery = useSetQuery();
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
  }, [data, setQuery]);
  return { data, error, load };
}

function Pager({ data, testId }: { data: ListPayload<unknown>; testId: string }) {
  const setQuery = useSetQuery();
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

// A sales order by its number, linked to it. Its id is only in the address:
// the shared entity link names a sales order by id for screen readers.
function OrderLink({ id, number }: { id?: string | null; number?: string | null }) {
  if (!id) return <>{number || "—"}</>;
  return (
    <Link to={`/app/sales/orders/${encodeURIComponent(id)}`} className="font-semibold text-blue-600 underline-offset-2 hover:underline" data-testid="sales-order-link">
      {number || id}
    </Link>
  );
}

// "Next: Approve" as a link to where the step is taken; in Chinese the
// full-width colon, with no space after it. Shown from 640 px up.
function NextHint({ to, steps }: { to: string; steps: string[] }) {
  const { language } = useI18n();
  const tr = useListCopyO2c();
  if (!steps.length) return null;
  const colon = language === "en-US" ? ": " : "：";
  return (
    <div className="mt-1 hidden text-[11px] sm:block">
      <Link to={to} className="font-medium text-blue-600 hover:underline" data-testid="list-next-step">{tr("next")}{colon}{steps.join(" · ")}</Link>
    </div>
  );
}

function InvoiceList() {
  const { t, locale, timezone } = useI18n();
  const tr = useListCopyO2c();
  const { data, error, load } = useFinanceList<Invoice>("/api/finance/customer-invoices");
  if (error) return <Notice title={error.code}>{error.message}</Notice>;
  if (!data) return <Card className="p-6">{t("common.loading")}</Card>;
  const enabled =
    data.capabilities["customer-invoice"]?.enabled && canPrepare();
  const count = (key: string) => String(data.counts?.[key] ?? 0);
  const today = todayInTimeZone(timezone);
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
        // Issued invoices also by where their payment stands: To be paid,
        // Partly paid, Paid (the server's payment states).
        statuses={["draft", "submitted", "approved", "issued", "to_be_paid", "partially_settled", "settled", "cancelled"]}
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
                const path = `/app/sales/invoices/${encodeURIComponent(row.id)}`;
                // Issued: where its payment stands, in place of "Issued".
                const shown = shownCustomerInvoiceStatus(row);
                // Still owed past its due day: the due date is red, as on the receivables list.
                const pastDue = (shown === "to_be_paid" || shown === "partially_settled") && Boolean(row.dueDate) && String(row.dueDate).slice(0, 10) < today;
                return (
                  <tr className={listRowClass} style={listRowStyle(index, data.items.length)} key={row.id} data-testid="customer-invoice-row">
                    <td className={`${tdIdClass} sticky left-0 z-10 bg-white`}>
                      <Link className={`${tableLinkClass} text-blue-600`} to={path}>{row.invoiceNumber}</Link>
                    </td>
                    <td className={`${tdNameClass} max-w-[220px] truncate`} title={row.customerName}>{row.customerName}</td>
                    <td className={tdNowrapClass} style={{ color: A.sub }}>{row.shipmentNumber || row.shipmentId}</td>
                    <td className={tdNowrapClass} style={{ color: pastDue ? PAST_DUE_COLOR : A.sub }}>{formatCalendarDay(row.dueDate, locale)}</td>
                    <td className={`${tdNumericRightClass} font-semibold`} style={{ color: A.label }}>{money(row.totalAmount, row.currency, locale)}</td>
                    <td className={tdNowrapClass}>
                      <StatusChip status={shown} />
                      <NextHint to={path} steps={next} />
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
        statusLabels={{ outstanding: tr("outstandingStatus"), open: tr("toBePaid") }}
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
                // Only a step a page offers, as a link to it: recording the
                // payment, on the invoice. Disputes and external references
                // have no screen yet, so they are not offered as a next step.
                const next = row.availableActions.filter((action) => action === "record_payment").map((action) => t(RECEIVABLE_ACTION_KEYS[action]));
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
                      {/* Each step is taken on the invoice, where the receivable's actions are. */}
                      {invoicePath && <NextHint to={invoicePath} steps={next} />}
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
      <ListCard title={tr("agingByCurrency")} testId="receivables-aging-by-currency">
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
  const statusLabel = useFinanceStatusLabel();
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
  // Everything on the shipment or order the form was opened from is already
  // on an invoice: those invoices, to open instead.
  const [onInvoices, setOnInvoices] = useState<{ text: string; invoices: InvoiceRef[] } | null>(null);
  // Opened from a sales order (?salesOrder=) or a shipment (?shipment=), the
  // server reads that order's or shipment's posted shipments, however old;
  // otherwise the recent ones with something left to invoice.
  // `keep`: the shipment already chosen, kept when the wider list leaves it out.
  const loadEntry = useCallback((filter: string, keep?: EntryData["postedShipments"][number]) => {
    void apiJson<EntryData>(`/api/finance/entry-data${filter ? `?${filter}` : ""}`)
      .then((next) => setEntry(keep && !next.postedShipments.some((row) => row.id === keep.id) ? { ...next, postedShipments: [keep, ...next.postedShipments] } : next))
      .catch((reason) => setLoadError(apiErrorView(reason, language, LOAD_FAILED)));
  }, [language]);
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const filter = new URLSearchParams();
    if (params.get("shipment")) filter.set("shipment", params.get("shipment") as string);
    else if (params.get("salesOrder")) filter.set("salesOrder", params.get("salesOrder") as string);
    loadEntry(filter.toString());
  }, []);
  // Each line starts at what is shipped and not yet on an invoice; a line
  // with nothing left starts empty and is not invoiced.
  const leftToInvoice = (row: EntryData["postedShipments"][number]) =>
    Object.fromEntries(row.lines.map((line) => {
      const left = Number(line.remainingQuantity ?? line.postedQuantity);
      return [line.id, left > 0 ? String(left) : ""];
    }));
  const invoiceable = (row: EntryData["postedShipments"][number]) => row.invoiceable !== false;
  const sourceDone = useRef(false);
  // Opened from a shipment or a sales order: choose the shipment with
  // something left to invoice. An invoice only covers shipped goods, so an
  // order without a posted shipment, or one whose shipments are all
  // invoiced, is explained, naming the order and its invoices.
  useEffect(() => {
    if (!entry || sourceDone.current) return;
    sourceDone.current = true;
    const params = new URLSearchParams(window.location.search);
    const shipmentParam = params.get("shipment");
    const orderParam = params.get("salesOrder");
    const invoicesOf = (rows: EntryData["postedShipments"]) =>
      rows.flatMap((row) => row.invoices || []).filter((invoice, index, all) => all.findIndex((other) => other.id === invoice.id) === index);
    if (shipmentParam) {
      const found = entry.postedShipments.find((row) => row.id === shipmentParam || row.shipmentNumber === shipmentParam);
      const number = found?.shipmentNumber || entry.customerInvoiceSource?.shipment?.shipmentNumber || shipmentParam;
      if (!found) { setSourceNotice(`${number}: ${t("finance.shipmentNotInvoiceable")}`); return; }
      if (!invoiceable(found)) { setOnInvoices({ text: say("shipmentInvoiced", { shipment: number }), invoices: invoicesOf([found]) }); return; }
      setShipmentId(found.id);
      setQuantities(leftToInvoice(found));
    } else if (orderParam) {
      const number = entry.customerInvoiceSource?.salesOrder?.orderNumber || entry.postedShipments.find((row) => row.salesOrderId === orderParam)?.salesOrderNumber || orderParam;
      const forOrder = entry.postedShipments.filter((row) => row.salesOrderId === orderParam);
      if (!forOrder.length) { setSourceNotice(`${number}: ${t("finance.noPostedShipment")}`); return; }
      const open = forOrder.filter(invoiceable);
      if (!open.length) { setOnInvoices({ text: say("orderInvoiced", { order: number }), invoices: invoicesOf(forOrder) }); return; }
      setOrderFilter(orderParam);
      if (open.length === 1) {
        setShipmentId(open[0].id);
        setQuantities(leftToInvoice(open[0]));
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
  // line, a positive quantity no more than shipped and not yet invoiced (the
  // check submitting makes; drafts count here too, so a second draft of the
  // same goods is not made), a tax of 0 or more.
  const validation = useMemo<InvoiceIssues>(() => {
    const issues = noIssues();
    if (!shipmentId) issues.shipment = "shipmentRequired";
    if (!dueDate) issues.due = "dueRequired";
    if (shipment && !invoicedLines.length) issues.form.push("lineRequired");
    for (const line of invoicedLines) {
      const issue: LineIssue = {};
      const quantity = decimalUnits(quantities[line.id] || "");
      const left = decimalUnits(String(line.remainingQuantity ?? line.postedQuantity));
      if (quantity === null || quantity <= 0n) issue.quantity = "quantityInvalid";
      else if (left !== null && quantity > left) issue.quantity = "quantityOver";
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
  // A quantity with its unit, in the interface language ("10 pcs", "10 件").
  const quantityText = (value: string | undefined, unit?: string | null) => {
    const shownValue = formatQuantity(value ?? "0");
    return unit ? `${shownValue} ${unitLabel(unit, language, Number(value))}` : shownValue;
  };
  // "More than the 10 pcs left to invoice": what is left on that line.
  const lineText = (lineId: string, key?: string) => {
    if (!key) return null;
    if (key === "quantityOver") {
      const line = shipment?.lines.find((row) => row.id === lineId);
      return say("quantityOver", { left: line ? quantityText(line.remainingQuantity ?? line.postedQuantity, line.unit) : "" });
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
      const result = await apiJson<{ entityId: string; invoice?: { invoiceNumber?: string } }>("/api/finance/customer-invoices", {
        method: "POST",
        body: JSON.stringify({ ...payload, idempotencyKey: createSecureClientMutationId("o2c") }),
      });
      // The page changes to the draft: the toast says it was created and its number.
      toast.success(DETAIL_COPY.toastCreated[language === "en-US" ? 0 : 1].replace("{number}", result.invoice?.invoiceNumber || ""));
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
  // Only shipments with something left to invoice (the one already chosen stays).
  const choices = entry.postedShipments.filter((row) => (invoiceable(row) || row.id === shipmentId) && (!orderFilter || row.salesOrderId === orderFilter));
  // The order the list is narrowed to, by its number.
  const filterOrderNumber = orderFilter
    ? entry.customerInvoiceSource?.salesOrder?.orderNumber || entry.postedShipments.find((row) => row.salesOrderId === orderFilter)?.salesOrderNumber || orderFilter
    : "";
  // The customer's recorded terms name no payment term of the workspace.
  const termsUnmatched = Boolean(shipment && !term && shipment.customerPaymentTerms);
  const invoiceLinks = (invoices: InvoiceRef[]) => invoices.map((invoice, index) => (
    <span key={invoice.id}>
      {index > 0 && ", "}
      <Link className="font-semibold text-blue-600 hover:underline" to={`/app/sales/invoices/${encodeURIComponent(invoice.id)}`}>{invoice.invoiceNumber}</Link>
      {" "}<span style={{ color: A.sub }}>({statusLabel(invoice.status)})</span>
    </span>
  ));
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
      {onInvoices && (
        <Notice testId="customer-invoice-already-invoiced">
          {onInvoices.text} {invoiceLinks(onInvoices.invoices)}
          {onInvoices.invoices.some((invoice) => invoice.status === "draft") && <> {say("draftHolds")}</>}
        </Notice>
      )}
      <FormHeader intro={say("intro")}>
        <div className="mt-1 text-xs" style={{ color: A.sub }} data-testid="customer-invoice-number-on-save">{tr("numberOnSave")}</div>
        {shipment && (
          <dl className="mt-4 grid gap-4 text-xs sm:grid-cols-2 lg:grid-cols-4" data-testid="customer-invoice-source">
            <div><dt style={{ color: A.sub }}>{say("customer")}</dt><dd className="mt-1 font-medium">{shipment.customerName || "—"}</dd></div>
            <div><dt style={{ color: A.sub }}>{say("salesOrder")}</dt><dd className="mt-1 font-medium"><OrderLink id={shipment.salesOrderId} number={shipment.salesOrderNumber} /></dd></div>
            <div><dt style={{ color: A.sub }}>{say("currency")}</dt><dd className="mt-1 font-medium">{shipment.currency}</dd></div>
          </dl>
        )}
      </FormHeader>

      <FormSection title={say("details")}>
        {orderFilter && (
          <div className="mb-3 flex flex-wrap items-center gap-2 text-xs text-slate-600" data-testid="customer-invoice-order-filter">
            {/* The order by its number, linked; never its id. */}
            <span>{t("finance.shipmentsForOrder")} <OrderLink id={orderFilter} number={filterOrderNumber} /></span>
            <button type="button" className="font-semibold text-blue-600" onClick={() => { setOrderFilter(""); loadEntry("", shipment); }}>{t("finance.showAllShipments")}</button>
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
                  setQuantities(next ? leftToInvoice(next) : {});
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
            {/* No due date is made up from terms the workspace does not have: the form says why it is blank and where to add them. */}
            {termsUnmatched && !dueDate && shipment?.customerPaymentTerms && (
              <span className="block text-[12px] leading-[18px] text-amber-800" data-testid="customer-invoice-terms-missing">
                {say("termsMissing", { terms: shipment.customerPaymentTerms })}{" "}
                <Link to="/app/master-data/payment-terms" className="font-semibold text-blue-600 hover:underline">{say("termsAdd")}</Link>
              </span>
            )}
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
                  {/* Shipped, already on an invoice (drafts included) and left: the quantity starts at what is left. */}
                  <div className="text-xs" style={{ color: A.sub }} data-testid="customer-invoice-line-progress">
                    {say("lineProgress", { shipped: quantityText(line.postedQuantity, line.unit), invoiced: quantityText(line.invoicedQuantity ?? "0", line.unit), left: quantityText(line.remainingQuantity ?? line.postedQuantity, line.unit) })}
                  </div>
                  <div className="text-xs" style={{ color: A.sub }}>{t("finance.soPrice")} {line.unitPrice === null ? t("finance.priceUnavailable") : money(line.unitPrice, shipment.currency, locale)}</div>
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
  const say = useDetailCopy();
  const dialog = useConfirm();
  const [actionError, setActionError] = useState("");
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
  const number = String(data.invoiceNumber || "");
  // Issued: where its payment stands (To be paid, Partly paid, Paid) in place
  // of "Issued"; the stored status does not change.
  const shownStatus = shownCustomerInvoiceStatus(data, receivable?.status);
  const receivableActions: string[] = Array.isArray(receivable?.availableActions) ? receivable.availableActions : [];
  const steps = actions.filter((action) => action !== "cancel");
  const canOpenDocument = documentStatuses.includes(data.status) && canOpenRoute("sales:invoice-document");
  // With no step of its own left, the invoice points to the receivable's:
  // recording the payment, or nothing once it is paid in full. "No action is
  // available" is said only when nothing at all is.
  const nextOnReceivable = !steps.length && receivableActions.includes("record_payment");
  const paidInFull = !steps.length && receivable?.status === "settled";
  const nothingToDo = !actions.length && !canOpenDocument && !nextOnReceivable && !paidInFull;
  // A step done says so in a toast, then the page reloads.
  const done = (key: "toastSubmitted" | "toastApproved" | "toastIssued") => () => { toast.success(say(key, { number })); load(); };
  // Cancel draft (or a submitted invoice never issued): a reason is required,
  // the server's preview is asked first, then the invoice is cancelled.
  const cancel = async () => {
    setActionError("");
    const reason = await dialog.prompt({
      title: say("cancelTitle", { number }),
      description: say("cancelBody"),
      tone: "danger",
      confirmLabel: data.status === "draft" ? say("cancelDraft") : say("cancelInvoice"),
      cancelLabel: say("keep"),
      testId: "customer-invoice-cancel-dialog",
      field: { label: say("cancelReason"), maxLength: 500 },
    });
    if (reason === null) return;
    const body = { ...version(), reason };
    try {
      const plan = await apiJson<{ allowed: boolean; blockingIssues?: Array<{ code?: string; message?: string }> }>(`${base}/cancel-preview`, { method: "POST", body: JSON.stringify(body) });
      if (!plan.allowed) {
        const code = plan.blockingIssues?.[0]?.code;
        setActionError(code === "CUSTOMER_INVOICE_STATUS_INVALID" ? say("cancelNotAllowed") : plan.blockingIssues?.[0]?.message || say("cancelFailed"));
        return;
      }
      await apiJson(`${base}/cancel`, { method: "POST", body: JSON.stringify({ ...body, idempotencyKey: createSecureClientMutationId("o2c") }) });
      toast.success(say("toastCancelled", { number }));
      load();
    } catch (reason) {
      setActionError(reason instanceof ApiError && reason.code === "CUSTOMER_INVOICE_STATUS_INVALID" ? say("cancelNotAllowed") : apiErrorView(reason, language, DETAIL_COPY.cancelFailed).message);
    }
  };
  // Up to the receivable, with the focus on recording the payment.
  const goToPayment = (event: { preventDefault: () => void }) => {
    event.preventDefault();
    const card = document.getElementById("customer-invoice-receivable");
    card?.scrollIntoView({ behavior: "smooth", block: "start" });
    card?.querySelector<HTMLElement>('[data-testid="payment-record"]')?.focus({ preventScroll: true });
  };
  // The invoice's history: each step with when it happened, then the
  // payments recorded against its receivable.
  const history = data.history || {};
  const historyEntries: Array<{ at: string; label: string; key: string }> = [
    { key: "created", at: history.createdAt, label: say("created") },
    { key: "submitted", at: history.submittedAt, label: say("submitted") },
    { key: "approved", at: history.approvedAt, label: say("approved") },
    { key: "issued", at: history.issuedAt, label: say("issued") },
    { key: "cancelled", at: history.cancelledAt, label: history.cancellationReason ? say("cancelledBecause", { reason: history.cancellationReason }) : say("cancelled") },
  ].filter((entry) => entry.at).sort((left, right) => String(left.at).localeCompare(String(right.at)));
  // Oldest first: the server lists them newest first, so the same day keeps the order they were recorded in.
  const payments: any[] = (receivable?.payments || []).slice().reverse().sort((left: any, right: any) => String(left.paymentDate).localeCompare(String(right.paymentDate)));
  const fact = "text-xs";
  return (
    <div className="space-y-4" data-testid="customer-invoice-detail">
      {error && <Notice title={error.code}>{error.message}</Notice>}
      {/* As on the order and shipment pages: the number and its status on the
          left, the actions on the right, then the facts in one row. */}
      <Card className="p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="fc-page-title" style={{ color: A.label }}>{data.invoiceNumber}</h1>
            <div className="mt-2 flex flex-wrap items-center gap-1.5" data-testid="customer-invoice-status">
              <StatusChip status={shownStatus} />
              {pastDue && <StatusChip status="overdue" />}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2 sm:justify-end" data-testid="customer-invoice-actions">
            {/* Open invoice document and Cancel are secondary; the invoice's next step is the primary button, last. */}
            {canOpenDocument && (
              <Link data-testid="customer-invoice-open-document" to={`/app/sales/invoices/${encodeURIComponent(data.id)}/document`} className={listButtonClass.secondary}>
                <FileText size={13} />{t("documents.openInvoice")}
              </Link>
            )}
            {actions.includes("cancel") && (
              <button type="button" data-testid="customer-invoice-cancel" className={`${listButtonClass.secondary} text-red-700`} onClick={() => void cancel()}>
                {data.status === "draft" ? say("cancelDraft") : say("cancelInvoice")}
              </button>
            )}
            {steps.includes("submit") && <TwoStepAction label={t("finance.action.submit")} testId="customer-invoice-submit" oneStep previewUrl={`${base}/submit-preview`} runUrl={`${base}/submit`} payload={version} onDone={done("toastSubmitted")} />}
            {steps.includes("approve") && <TwoStepAction label={t("finance.action.approve")} testId="customer-invoice-approve" oneStep previewUrl={`${base}/approve-preview`} runUrl={`${base}/approve`} payload={version} onDone={done("toastApproved")} />}
            {steps.includes("issue") && <TwoStepAction label={t("finance.action.issue")} testId="customer-invoice-issue" oneStep previewUrl={`${base}/issue-preview`} runUrl={`${base}/issue`} payload={version} onDone={done("toastIssued")} />}
            {nextOnReceivable && <a href="#customer-invoice-receivable" onClick={goToPayment} className={`${listButtonClass.primary}`} data-testid="customer-invoice-next">{say("nextPayment")}</a>}
            {paidInFull && <span className="text-xs text-slate-500" data-testid="customer-invoice-no-actions">{say("paidInFull")}</span>}
            {nothingToDo && <span className="text-xs text-slate-500" data-testid="customer-invoice-no-actions">{t("finance.noActions")}</span>}
          </div>
        </div>
        {actionError && <div className="mt-3"><Notice testId="customer-invoice-action-error">{actionError}</Notice></div>}
        <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 border-t pt-4 text-sm sm:grid-cols-3 lg:grid-cols-6" style={{ borderColor: A.border }} data-testid="customer-invoice-sources">
          <div className="min-w-0">
            <dt className={fact} style={{ color: A.sub }}>{say("customer")}</dt>
            <dd className="mt-0.5 font-medium break-words" style={{ color: A.label }}>
              {data.customerId && data.customerName
                ? <BusinessEntityLink entityType="customer" entityId={data.customerId}>{data.customerName}</BusinessEntityLink>
                : data.customerName || "—"}
            </dd>
          </div>
          <div>
            <dt className={fact} style={{ color: A.sub }}>{say("invoiceDate")}</dt>
            <dd className="mt-0.5 font-medium tabular-nums" style={{ color: A.label }} data-testid="customer-invoice-date">{formatCalendarDay(data.invoiceDate, locale)}</dd>
          </div>
          <div>
            <dt className={fact} style={{ color: A.sub }}>{say("dueDate")}</dt>
            <dd className="mt-0.5 font-medium tabular-nums" style={{ color: pastDue ? PAST_DUE_COLOR : A.label }} data-testid="customer-invoice-due-date">{formatCalendarDay(data.dueDate, locale)}</dd>
          </div>
          <div>
            <dt className={fact} style={{ color: A.sub }}>{say("total")}</dt>
            <dd className="mt-0.5 font-semibold tabular-nums" style={{ color: A.label }}>{money(data.totalAmount, data.currency, locale)}</dd>
          </div>
          <div>
            <dt className={fact} style={{ color: A.sub }}>{say("salesOrder")}</dt>
            <dd className="mt-0.5 font-medium"><OrderLink id={data.salesOrderId} number={data.salesOrderNumber} /></dd>
          </div>
          <div>
            <dt className={fact} style={{ color: A.sub }}>{say("shipment")}</dt>
            <dd className="mt-0.5 font-medium">
              {data.shipmentId
                ? <Link className="font-semibold text-blue-600 hover:underline" to={`/app/sales/shipments/${encodeURIComponent(data.shipmentId)}`}>{data.shipmentNumber || data.shipmentId}</Link>
                : "—"}
            </dd>
          </div>
        </dl>
      </Card>

      {/* The lines read as a table on wide screens and as one card per line on
          phones (listTableCardsRef): the item first, the amount next to it.
          The subtotal, tax and total follow, in the invoice's currency. */}
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
                  <td className={tdNumericRightClass}>{formatQuantity(line.quantity)}{line.unit ? ` ${unitLabel(line.unit, language, Number(line.quantity))}` : ""}</td>
                  <td className={tdNumericRightClass}>{money(line.unitPrice, data.currency, locale)}</td>
                  <td className={tdNumericRightClass}>{money(line.enteredTaxAmount, data.currency, locale)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <dl className="ml-auto mt-4 grid w-full max-w-xs grid-cols-[1fr_auto] gap-x-6 gap-y-1 text-sm" data-testid="customer-invoice-totals">
          <dt style={{ color: A.sub }}>{say("subtotal")}</dt>
          <dd className="text-right tabular-nums" data-testid="customer-invoice-subtotal">{money(data.subtotalAmount, data.currency, locale)}</dd>
          <dt style={{ color: A.sub }}>{say("tax")}</dt>
          <dd className="text-right tabular-nums" data-testid="customer-invoice-tax">{money(data.enteredTaxAmount, data.currency, locale)}</dd>
          <dt className="border-t pt-1 font-semibold" style={{ color: A.label, borderColor: A.border }}>{say("totalIn", { currency: data.currency })}</dt>
          <dd className="border-t pt-1 text-right font-semibold tabular-nums" style={{ color: A.label, borderColor: A.border }} data-testid="customer-invoice-total">{money(data.totalAmount, data.currency, locale)}</dd>
        </dl>
      </Card>

      {receivable && (
        <Card className="space-y-3 p-5" data-testid="customer-invoice-receivable" id="customer-invoice-receivable">
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

      {historyEntries.length + payments.length > 0 && <Card className="p-5" data-testid="customer-invoice-history">
        <h3 className="mb-3 font-semibold">{say("history")}</h3>
        <ol className="space-y-2 text-sm">
          {historyEntries.map((entry) => (
            <li key={entry.key} className="border-l-2 pl-3" style={{ borderColor: entry.key === "cancelled" ? "#fca5a5" : A.border }} data-testid={`customer-invoice-history-${entry.key}`}>
              <div className="font-medium" style={{ color: A.label }}>{entry.label}</div>
              <div className="text-xs" style={{ color: A.sub }}>{formatDateTimeInTimeZone(entry.at, locale, timezone)}</div>
            </li>
          ))}
          {payments.map((payment) => (
            <li key={payment.id} className="border-l-2 pl-3" style={{ borderColor: A.border }} data-testid="customer-invoice-history-payment">
              <div className="font-medium" style={{ color: payment.status === "voided" ? A.sub : A.label }}>
                {say(payment.status === "voided" ? "paymentVoided" : "paymentReceived", { amount: money(payment.amount, payment.currency, locale) })}
              </div>
              <div className="text-xs" style={{ color: A.sub }}>{formatCalendarDay(payment.paymentDate, locale)}{payment.reference ? ` · ${payment.reference}` : ""}</div>
            </li>
          ))}
        </ol>
      </Card>}
      {dialog.element}
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
