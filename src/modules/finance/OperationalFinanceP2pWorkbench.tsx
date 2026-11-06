import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { Link, useSearchParams } from "react-router";
import { AlertCircle, AlertTriangle, ArrowRight, CheckCircle2, Inbox, Plus, ShieldCheck } from "lucide-react";
import { A, Card, Field, inputStyle } from "../../components/ui";
import { ActionableMetricCard } from "../../components/cards/ActionableMetricCard";
import { EntityLink } from "../../components/business/EntityLink";
import { ListCard, ListSearchCard, ListStateRow, RefreshButton, ResetButton, StatusChip, listButtonClass, listHeadRowStyle, listRowClass, listRowStyle, rowActionClass, statusToneOf } from "../../components/ui/listLayout";
import { tableBodyTextClass, tableLinkClass, tableScrollClass, tdIdClass, tdNameClass, tdNowrapClass, tdNumericRightClass, thClass, thRightClass } from "../../components/ui/workbenchTable";
import { useI18n } from "../../i18n/I18n";
import { apiJson } from "../../lib/api-client";

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
type ListPayload = {
  items: Array<Record<string, any>>;
  total: number;
  capabilities: Record<string, { enabled?: boolean }>;
};
const value = (row: Record<string, any>, ...keys: string[]) =>
  keys.map((key) => row[key]).find((entry) => entry !== undefined && entry !== null);
const query = () => window.location.search.replace(/^\?/, "");
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
  reviewed: "finance.status.reviewed",
  resolved: "finance.status.resolved",
  cancelled: "finance.status.cancelled",
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

function Warning({ children }: { children: ReactNode }) {
  return (
    <div className="flex gap-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
      <AlertTriangle className="mt-0.5 shrink-0" size={16} />
      <span>{children}</span>
    </div>
  );
}

export function FinanceLanding() {
  const { t } = useI18n();
  const [data, setData] = useState<Landing | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    void apiJson<Landing>("/api/finance/landing")
      .then(setData)
      .catch((reason) =>
        setError(reason instanceof Error ? reason.message : t("finance.loadFailed")),
      );
  }, []);
  if (error) return <Warning>{error}</Warning>;
  if (!data) return <Card className="p-6">{t("common.loading")}</Card>;
  const cards = [
    ["supplierInvoicesAwaitingMatch", t("finance.awaitingMatch"), "/app/procurement/bills?status=submitted"],
    ["matchExceptions", t("finance.matchExceptions"), "/app/procurement/bills?status=exception"],
    ["approvedPayableObligations", t("finance.approvedPayables"), "/app/finance/payables?status=approved"],
    ["customerInvoicesAwaitingIssue", t("finance.awaitingIssue"), "/app/sales/invoices?status=approved"],
    ["overdueReceivables", t("finance.overdueReceivables"), "/app/finance/receivables?status=overdue"],
    ["disputedReceivables", t("finance.disputedReceivables"), "/app/finance/receivables?disputeStatus=open"],
    ["supplierCreditMemos", t("finance.supplierCredits"), "/app/finance/credits"],
    ["customerCreditNotes", t("finance.customerCredits"), "/app/finance/customer-credit-notes"],
  ] as const;
  return (
    <div className="space-y-4" data-testid="operational-finance-landing">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {cards.map(([key, label, href]) => (
          <a href={href} key={key}>
            <Card className="h-full p-4 transition hover:border-blue-200">
              <div className="text-xs text-slate-500">{label}</div>
              <div className="mt-2 flex items-end justify-between">
                <strong className="text-2xl">{data.cards[key] || 0}</strong>
                <ArrowRight size={15} color={A.blue} />
              </div>
            </Card>
          </a>
        ))}
      </div>
      <div className="grid gap-3 lg:grid-cols-2">
        <Warning>{t("finance.notPaid")}</Warning>
        <Warning>{t("finance.notCollected")}</Warning>
      </div>
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
  creditTitle: ["Supplier credit list", "供应商贷项列表"],
  matchTitle: ["Match exception list", "匹配异常列表"],
  awaitingMatch: ["Awaiting match", "待匹配"],
  awaitingMatchNote: ["Submitted, not yet matched to the PO and receipt", "已提交，尚未与采购订单和收货核对"],
  exceptions: ["Match exceptions", "匹配异常"],
  exceptionsNote: ["Price or quantity differs from the PO or receipt", "价格或数量与采购订单、收货不一致"],
  matched: ["Matched, to approve", "已匹配待批准"],
  matchedNote: ["Matched and waiting for approval", "已匹配，等待批准"],
  approved: ["Approved", "已批准"],
  approvedNote: ["Approved and handed to payables", "已批准并转入应付"],
  searchTitle: ["Supplier invoice search", "采购发票查询"],
  searchSubtitle: ["Search supplier invoices by number, supplier, purchase order, status and variance.", "按发票编号、供应商、采购订单、状态和差异查询采购发票。"],
  search: ["Search", "搜索"],
  searchPlaceholder: ["Invoice number, supplier or PO", "发票编号、供应商或采购订单"],
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
  next: ["Next", "下一步"],
  view: ["View", "查看"],
  actions: ["Actions", "操作"],
  noMatch: ["No supplier invoices match these filters", "没有符合筛选条件的采购发票"],
  noRows: ["Nothing matches these filters", "没有符合筛选条件的记录"],
  payableSearch: ["Payable search", "应付查询"],
  payableSearchSubtitle: ["Approved supplier invoices to pay, by number, supplier and status.", "按单号、供应商和状态查询待付款的已批准采购发票。"],
  creditSearch: ["Supplier credit search", "供应商贷项查询"],
  creditSearchSubtitle: ["Credit memos raised from posted supplier returns.", "由已过账的供应商退货生成的贷项。"],
  matchSearch: ["Match exception search", "匹配异常查询"],
  matchSearchSubtitle: ["Price and quantity differences found when matching invoices.", "发票匹配时发现的价格和数量差异。"],
  searchRecord: ["Number or supplier", "单号或供应商"],
  payableNumber: ["Payable", "应付单"],
  creditNumber: ["Credit memo", "贷项单"],
  exceptionNumber: ["Exception", "异常"],
  supplierOrReturn: ["Supplier / return", "供应商 / 退货"],
  nextStep: ["Next step", "下一步"],
  supplierCreditNoRefund: ["A supplier credit memo does not record a refund from the supplier.", "供应商贷项不代表已收到供应商退款。"],
} as const;

const day = (value: unknown) => String(value || "").slice(0, 10);

function FinanceList({
  endpoint,
  capability,
  kind,
}: {
  endpoint: string;
  capability: string;
  kind: "invoice" | "payable" | "credit" | "match";
}) {
  const { t, locale, language } = useI18n();
  const tr = (key: keyof typeof LIST_COPY) => LIST_COPY[key][language === "en-US" ? 0 : 1];
  const [searchParams, setSearchParams] = useSearchParams();
  const [data, setData] = useState<ListPayload | null>(null);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [supplier, setSupplier] = useState("");
  // An address with matchStatus=variance (the purchase order cards) starts on invoices with a variance.
  const [variance, setVariance] = useState(() => searchParams.get("matchStatus") === "variance" ? "with" : "");
  // Supplier invoices are filtered here, so the metric cards count every
  // invoice; the other lists keep the server's filter from the address.
  const invoices = kind === "invoice";
  const load = () => {
    setError("");
    void apiJson<ListPayload>(invoices ? endpoint : `${endpoint}?${query()}`)
      .then(setData)
      .catch((reason) =>
        setError(reason instanceof Error ? reason.message : t("finance.loadFailed")),
      );
  };
  useEffect(load, [endpoint]);
  if (error) return <Warning>{error}</Warning>;
  if (!data) return <Card className="p-6">{t("common.loading")}</Card>;
  const enabled = data.capabilities?.[capability]?.enabled;
  const statusOf = (row: Record<string, any>) => String(value(row, "status", "matchStatus") || "");
  const statusText = (status: string) => tokenKeys[status] ? t(tokenKeys[status]) : status || "—";
  // Action codes, labelled; `skip` leaves codes out (Cancel is not a next step).
  const actionsOf = (row: Record<string, any>, skip: string[] = []) =>
    (value(row, "availableActions") || []).filter((action: string) => !skip.includes(action)).map((action: string) => tokenKeys[action] ? t(tokenKeys[action]) : action) as string[];
  const status = searchParams.get("status") || "";
  const setStatus = (next: string) => {
    const params = new URLSearchParams(searchParams);
    if (next) params.set("status", next); else params.delete("status");
    setSearchParams(params, { replace: true });
  };
  const hasVariance = (row: Record<string, any>) => Number(row.varianceAmount || 0) !== 0 || row.matchStatus === "variance";
  const needle = search.trim().toLowerCase();
  const rows = !invoices ? data.items.filter((row) =>
    (!status || statusOf(row) === status)
    && (!needle || Object.values(row).some((entry) => typeof entry === "string" && entry.toLowerCase().includes(needle))))
    : data.items.filter((row) =>
    (!status || row.status === status)
    && (!supplier || row.supplierName === supplier)
    && (!variance || (variance === "with" ? hasVariance(row) : !hasVariance(row)))
    && (!needle || [row.invoiceNumber, row.id, row.supplierName, row.relatedPoId].some((entry) => String(entry || "").toLowerCase().includes(needle))));
  const count = (code: string) => data.items.filter((row) => row.status === code).length;
  const statuses = [...new Set(data.items.map(statusOf).filter(Boolean))];
  const suppliers = [...new Set(data.items.map((row) => String(row.supplierName || "")).filter(Boolean))].sort();
  const title = tr(kind === "invoice" ? "invoiceTitle" : kind === "payable" ? "payableTitle" : kind === "credit" ? "creditTitle" : "matchTitle");
  const reset = () => {
    setSearch("");
    setSupplier("");
    setVariance("");
    setSearchParams({}, { replace: true });
  };
  return (
    <div className="space-y-5" data-testid={`operational-finance-${kind}-list`}>
      {!enabled && <Warning>{t("finance.capabilityDisabled")}</Warning>}
      {kind === "payable" && <Warning>{t("finance.notPaid")}</Warning>}
      {kind === "credit" && <Warning>{tr("supplierCreditNoRefund")}</Warning>}
      {!invoices && (
        <ListSearchCard
          title={tr(kind === "payable" ? "payableSearch" : kind === "credit" ? "creditSearch" : "matchSearch")}
          subtitle={tr(kind === "payable" ? "payableSearchSubtitle" : kind === "credit" ? "creditSearchSubtitle" : "matchSearchSubtitle")}
          actions={<>
            <ResetButton onClick={reset} />
            <RefreshButton onClick={load} />
          </>}
        >
          <Field label={tr("search")}>
            <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder={tr("searchRecord")} style={inputStyle} />
          </Field>
          <Field label={t("finance.status")}>
            <select value={status} onChange={(event) => setStatus(event.target.value)} style={inputStyle}>
              <option value="">{tr("allStatuses")}</option>
              {statuses.map((code) => <option key={code} value={code}>{statusText(code)}</option>)}
            </select>
          </Field>
        </ListSearchCard>
      )}
      {invoices && (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <ActionableMetricCard label={tr("awaitingMatch")} value={String(count("submitted"))} description={tr("awaitingMatchNote")} to="/app/procurement/bills?status=submitted" icon={Inbox} color={A.orange} />
            <ActionableMetricCard label={tr("exceptions")} value={String(count("exception"))} description={tr("exceptionsNote")} to="/app/procurement/bills?status=exception" icon={AlertCircle} color={A.red} />
            <ActionableMetricCard label={tr("matched")} value={String(count("matched"))} description={tr("matchedNote")} to="/app/procurement/bills?status=matched" icon={ShieldCheck} color={A.blue} />
            <ActionableMetricCard label={tr("approved")} value={String(count("approved"))} description={tr("approvedNote")} to="/app/procurement/bills?status=approved" icon={CheckCircle2} color={A.purple} />
          </div>
          <ListSearchCard
            title={tr("searchTitle")}
            subtitle={tr("searchSubtitle")}
            actions={<>
              <ResetButton onClick={reset} />
              <RefreshButton onClick={load} />
              {enabled && <Link data-testid="supplier-invoice-new" to="/app/procurement/bills/new" className={listButtonClass.primary}><Plus size={13} />{t("finance.newSupplierInvoice")}</Link>}
            </>}
          >
            <Field label={tr("search")}>
              <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder={tr("searchPlaceholder")} style={inputStyle} />
            </Field>
            <Field label={tr("supplier")}>
              <select value={supplier} onChange={(event) => setSupplier(event.target.value)} style={inputStyle}>
                <option value="">{tr("allSuppliers")}</option>
                {suppliers.map((name) => <option key={name} value={name}>{name}</option>)}
              </select>
            </Field>
            <Field label={t("finance.status")}>
              <select value={status} onChange={(event) => setStatus(event.target.value)} style={inputStyle}>
                <option value="">{tr("allStatuses")}</option>
                {statuses.map((code) => <option key={code} value={code}>{statusText(code)}</option>)}
              </select>
            </Field>
            <Field label={tr("variance")}>
              <select value={variance} onChange={(event) => setVariance(event.target.value)} style={inputStyle}>
                <option value="">{tr("anyVariance")}</option>
                <option value="with">{tr("withVariance")}</option>
                <option value="none">{tr("noVariance")}</option>
              </select>
            </Field>
          </ListSearchCard>
        </>
      )}
      <ListCard title={title} total={data.items.length} shown={rows.length}>
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
                {rows.length === 0 && <ListStateRow colSpan={8} state="empty" title={data.items.length ? tr("noMatch") : t("common.empty")} />}
                {rows.map((row, index) => {
                  const id = String(row.id || "");
                  const rawStatus = statusOf(row);
                  const next = actionsOf(row, ["cancel"]);
                  const varianceAmount = Number(row.varianceAmount || 0);
                  return (
                    <tr className={listRowClass} style={listRowStyle(index, rows.length)} key={id}>
                      <td className={`${tdIdClass} sticky left-0 z-10 bg-white`}>
                        <EntityLink kind="supplier_invoice" id={id} className={tableLinkClass}>{String(row.invoiceNumber || id)}</EntityLink>
                      </td>
                      <td className={`${tdNameClass} max-w-[200px] truncate`} title={row.supplierName}>{row.supplierName || "—"}</td>
                      <td className={tdNowrapClass}>
                        {row.relatedPoId ? <EntityLink kind="purchase_order" id={row.relatedPoId} className="font-medium">{row.relatedPoId}</EntityLink> : <span style={{ color: A.gray2 }}>—</span>}
                        <div className="text-[11px]" style={{ color: A.sub }}>{row.relatedGrnId ? <EntityLink kind="receiving_doc" id={row.relatedGrnId} className="text-[11px] font-normal">{row.relatedGrnId}</EntityLink> : "—"}</div>
                      </td>
                      <td className={tdNowrapClass}>
                        <div>{day(row.invoiceDate) || "—"}</div>
                        {row.dueDate && <div className="text-[11px]" style={{ color: A.sub }}>{tr("due")} {day(row.dueDate)}</div>}
                      </td>
                      <td className={`${tdNumericRightClass} font-semibold`} style={{ color: A.label }}>{money(row.totalAmount, row.currency, locale)}</td>
                      <td className={tdNumericRightClass} style={{ color: varianceAmount ? "#b91c1c" : A.sub }}>{varianceAmount ? money(row.varianceAmount, row.currency, locale) : "—"}</td>
                      <td className={tdNowrapClass}>
                        <div className="flex flex-wrap items-center gap-1">
                          <StatusChip label={statusText(rawStatus)} tone={statusToneOf(rawStatus)} />
                          {row.awaitingReceipt && (
                            <span data-testid="bill-awaiting-receipt">
                              <StatusChip label={t("finance.awaitingReceipt")} tone="warning" />
                            </span>
                          )}
                        </div>
                        {next.length > 0 && <div className="mt-1 text-[11px]" style={{ color: A.sub }}>{tr("next")}: {next.join(" · ")}</div>}
                      </td>
                      <td className={`${tdNowrapClass} sticky right-0 z-10 bg-white`}>
                        <EntityLink kind="supplier_invoice" id={id} className={`${rowActionClass.primary} !no-underline`}>{tr("view")}</EntityLink>
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
                  <th className={`${thClass} sticky left-0 z-20 bg-white`} style={{ color: A.gray1 }}>{tr(kind === "payable" ? "payableNumber" : kind === "credit" ? "creditNumber" : "exceptionNumber")}</th>
                  <th className={thClass} style={{ color: A.gray1 }}>{kind === "credit" ? tr("supplierOrReturn") : kind === "payable" ? tr("supplier") : t("finance.invoiceNumber")}</th>
                  <th className={thRightClass} style={{ color: A.gray1 }}>{t("finance.amount")}</th>
                  <th className={thClass} style={{ color: A.gray1 }}>{t("finance.status")}</th>
                  <th className={thClass} style={{ color: A.gray1 }}>{tr("nextStep")}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row, index) => {
                  const id = String(value(row, "id") || "");
                  const label = String(
                    (kind === "match"
                      ? value(row, "exceptionType", "matchNumber")
                      : value(
                          row,
                          "invoiceNumber",
                          "obligationNumber",
                          "creditMemoNumber",
                        )) || id,
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
                  const amount = value(
                    row,
                    "totalAmount",
                    "outstandingAmount",
                    "varianceValue",
                  );
                  const rawStatus = statusOf(row);
                  return (
                    <tr className={listRowClass} style={listRowStyle(index, rows.length)} key={id}>
                      <td className={`${tdIdClass} sticky left-0 z-10 bg-white`}>
                        {kind === "payable" && row.supplierInvoiceId
                          ? <EntityLink kind="supplier_invoice" id={String(row.supplierInvoiceId)} className={tableLinkClass}>{label}</EntityLink>
                          : label}
                      </td>
                      <td className={tdNameClass}>{source}</td>
                      <td className={`${tdNumericRightClass} font-semibold`} style={{ color: A.label }}>
                        {money(amount, value(row, "currency"), locale)}
                      </td>
                      <td className={tdNowrapClass}>
                        <StatusChip label={statusText(rawStatus)} tone={statusToneOf(rawStatus)} />
                      </td>
                      <td className={tdNowrapClass} style={{ color: A.sub }}>
                        {actionsOf(row).join(" · ") || "—"}
                      </td>
                    </tr>
                  );
                })}
                {!rows.length && <ListStateRow colSpan={5} state="empty" title={data.items.length ? tr("noRows") : t("common.empty")} />}
              </tbody>
            </table>
          )}
        </div>
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
