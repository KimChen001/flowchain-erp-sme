import { useEffect, useMemo, useState } from "react";
import { A, Card } from "../../components/ui";
import { EntityLink } from "../../components/business/EntityLink";
import { apiJson } from "../../lib/api-client";
import { useI18n } from "../../i18n/I18n";
import { statusCodeLabel } from "../../i18n/statusLabels";

// A supplier's purchase records and open risks on its detail page
// (docs/supplier-tiers-design.md §5, T3), from
// GET /api/master-data/suppliers/:id/activity (server/domain/supplier-insights.mjs).
// Each part follows the reader's access: a part they may not see says so and
// is never shown as empty. Risks are the assistant's own signals in its date
// order, so they match the list's "Open issues".

type When = { kind: "overdue" | "due" | "open" | "undated"; days: number | null; date: string | null };
type PurchaseRecord = { id: string; orderNumber: string; date: string | null; status: string; promisedDate: string | null; overdueDays: number; amount: number | null; currency: string | null };
type InvoiceRecord = { id: string; invoiceNumber: string; invoiceDate: string | null; dueDate: string | null; status: string; matchStatus: string | null; amount: number | null; currency: string | null };
type Issue = { id: string; type: "po_overdue" | "grn_rejected_qty" | "grn_received_unposted" | "invoice_variance"; entityType: "purchase_order" | "receiving_doc" | "supplier_invoice"; entityId: string; label: string; when: When; data: { days?: number; rejected?: number; unit?: string; variance?: number | null; currency?: string } };
export type SupplierActivity = {
  asOf: string;
  supplierId: string;
  visibility: { orders: boolean; orderAmounts: boolean; invoices: boolean; invoiceAmounts: boolean; issues: boolean };
  purchaseOrders: { rows: PurchaseRecord[]; total: number } | null;
  invoices: { rows: InvoiceRecord[]; more: boolean } | null;
  issues: Issue[] | null;
};

// English source copy with its Chinese translation.
const COPY: Record<string, [string, string]> = {
  loading: ["Loading…", "正在加载…"],
  loadFailed: ["Could not load this supplier's records.", "无法加载该供应商的记录。"],
  retry: ["Retry", "重试"],
  ordersHidden: ["Purchase orders are hidden for your role.", "你的角色看不到采购订单。"],
  amountsHidden: ["Amounts are hidden for your role.", "你的角色看不到金额。"],
  latest: ["The latest {shown} of {total} purchase orders.", "显示最近 {shown} 张，共 {total} 张采购订单。"],
  po: ["Purchase order", "采购订单"], date: ["Date", "日期"], status: ["Status", "状态"], promised: ["Promised", "承诺交期"], amount: ["Amount", "金额"],
  overdueBy: ["{n} days overdue", "逾期 {n} 天"],
  invoices: ["Supplier invoices", "供应商发票"], invoice: ["Invoice", "发票"], match: ["Match", "匹配"],
  invoicesHidden: ["Supplier invoices are hidden for your role.", "你的角色看不到供应商发票。"],
  noInvoices: ["No supplier invoices yet.", "暂无供应商发票。"],
  moreInvoices: ["Showing the latest 20 invoices.", "仅显示最近 20 张发票。"],
  issuesHidden: ["Hidden for your role: you cannot read the records behind these signals.", "你的角色不可见：你无法查看这些信号对应的记录。"],
  order: ["Most overdue first, then the oldest open. The same order as the assistant.", "逾期最久的在前，其次是最早未结的，与 AI 助手的顺序一致。"],
  po_overdue: ["Purchase order {n} days overdue", "采购订单逾期 {n} 天"],
  grn_rejected_qty: ["Receipt with {qty} rejected", "收货拒收 {qty}"],
  grn_received_unposted: ["Received, not yet posted to inventory", "已收货，尚未过账入库"],
  invoice_variance: ["Invoice variance {amount}", "发票差异 {amount}"],
  invoice_variance_hidden: ["Invoice variance", "发票差异"],
  since: ["Since {date}", "自 {date} 起"],
  due: ["Due {date}", "应于 {date}"],
};

function useCopy() {
  const { language } = useI18n();
  return (key: string, values: Record<string, string | number> = {}) => {
    const entry = COPY[key];
    const template = entry ? entry[language === "en-US" ? 0 : 1] : key;
    return Object.entries(values).reduce((result, [name, value]) => result.replace(`{${name}}`, String(value)), template);
  };
}

function useFormat() {
  const { locale, language } = useI18n();
  return useMemo(() => {
    const number = new Intl.NumberFormat(locale, { maximumFractionDigits: 2 });
    const date = new Intl.DateTimeFormat(locale, { timeZone: "UTC", year: "numeric", month: "short", day: "numeric" });
    return {
      number: (value: number | null | undefined) => (value === null || value === undefined ? "—" : number.format(value)),
      day: (value: string | null) => (value ? date.format(new Date(`${value}T12:00:00Z`)) : "—"),
      // Money stays in its document currency.
      money: (amount: number | null, currency: string | null) => {
        if (amount === null) return "—";
        if (!currency || !/^[A-Z]{3}$/.test(currency)) return number.format(amount);
        return new Intl.NumberFormat(locale, { style: "currency", currency }).format(amount);
      },
      status: (code: string | null) => (code ? statusCodeLabel(code, language) || code : "—"),
    };
  }, [locale, language]);
}

function useSupplierActivity(supplierId: string) {
  const [data, setData] = useState<SupplierActivity | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError("");
    apiJson<SupplierActivity>(`/api/master-data/suppliers/${encodeURIComponent(supplierId)}/activity`)
      .then((value) => { if (alive) setData(value); })
      .catch((reason) => { if (alive) setError(reason instanceof Error ? reason.message : ""); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [supplierId, tick]);
  return { data, error, loading, reload: () => setTick((value) => value + 1) };
}

const Note = ({ children, testId }: { children: React.ReactNode; testId?: string }) => (
  <p data-testid={testId} className="mt-2 text-xs" style={{ color: A.sub }}>{children}</p>
);

// The two detail cards. Their titles and empty texts come from the page,
// which keeps its existing copy.
export function SupplierActivityCards({ supplierId, titles, empty }: { supplierId: string; titles: { orders: string; risks: string }; empty: { orders: string; risks: string } }) {
  const t = useCopy();
  const f = useFormat();
  const { data, error, loading, reload } = useSupplierActivity(supplierId);
  const status = (testId: string) => (loading && !data
    ? <Note testId={`${testId}-loading`}>{t("loading")}</Note>
    : error
      ? <div role="alert" className="mt-2 flex items-center gap-2 text-xs" style={{ color: A.red }}>{t("loadFailed")}<button type="button" className="underline" onClick={reload}>{t("retry")}</button></div>
      : null);
  const orders = data?.purchaseOrders;
  const invoices = data?.invoices;
  const issues = data?.issues;
  const issueText = (issue: Issue) => {
    if (issue.type === "po_overdue") return t("po_overdue", { n: issue.data.days ?? issue.when.days ?? 0 });
    if (issue.type === "grn_rejected_qty") return t("grn_rejected_qty", { qty: `${f.number(issue.data.rejected)}${issue.data.unit ? ` ${issue.data.unit}` : ""}` });
    if (issue.type === "invoice_variance") return issue.data.variance === null || issue.data.variance === undefined ? t("invoice_variance_hidden") : t("invoice_variance", { amount: f.money(issue.data.variance, issue.data.currency || null) });
    return t("grn_received_unposted");
  };
  const issueDate = (issue: Issue) => (issue.when.date ? t(issue.when.kind === "open" ? "since" : "due", { date: f.day(issue.when.date) }) : "");
  return (
    <>
      <Card className="p-5" data-testid="supplier-purchase-records">
        <h2 className="text-sm font-semibold">{titles.orders}</h2>
        {status("supplier-purchase-records")}
        {data && !orders ? <Note testId="supplier-orders-hidden">{t("ordersHidden")}</Note> : null}
        {orders && !orders.rows.length ? <div className="py-8 text-center text-xs" style={{ color: A.sub }}>{empty.orders}</div> : null}
        {orders && orders.rows.length ? (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-xs">
              <thead><tr className="text-left" style={{ color: A.sub }}>
                <th className="p-2 font-medium">{t("po")}</th><th className="p-2 font-medium">{t("date")}</th><th className="p-2 font-medium">{t("status")}</th><th className="p-2 font-medium">{t("promised")}</th>
                {data?.visibility.orderAmounts ? <th className="p-2 text-right font-medium">{t("amount")}</th> : null}
              </tr></thead>
              <tbody>
                {orders.rows.map((row) => (
                  <tr key={row.id} className="border-t" data-testid="supplier-purchase-record">
                    <td className="p-2"><EntityLink kind="purchase_order" id={row.id} className="text-blue-600">{row.orderNumber}</EntityLink></td>
                    <td className="p-2">{f.day(row.date)}</td>
                    <td className="p-2">{f.status(row.status)}</td>
                    <td className="p-2">{f.day(row.promisedDate)}{row.overdueDays > 0 ? <span className="ml-2" style={{ color: A.red }}>{t("overdueBy", { n: row.overdueDays })}</span> : null}</td>
                    {data?.visibility.orderAmounts ? <td className="p-2 text-right tabular-nums">{f.money(row.amount, row.currency)}</td> : null}
                  </tr>
                ))}
              </tbody>
            </table>
            {orders.total > orders.rows.length ? <Note>{t("latest", { shown: orders.rows.length, total: orders.total })}</Note> : null}
            {!data?.visibility.orderAmounts ? <Note testId="supplier-order-amounts-hidden">{t("amountsHidden")}</Note> : null}
          </div>
        ) : null}
        {data ? (
          <div className="mt-4" data-testid="supplier-invoice-records">
            <h3 className="text-xs font-semibold">{t("invoices")}</h3>
            {!invoices ? <Note testId="supplier-invoices-hidden">{t("invoicesHidden")}</Note> : !invoices.rows.length ? <Note>{t("noInvoices")}</Note> : (
              <div className="mt-2 overflow-x-auto">
                <table className="w-full text-xs">
                  <thead><tr className="text-left" style={{ color: A.sub }}>
                    <th className="p-2 font-medium">{t("invoice")}</th><th className="p-2 font-medium">{t("date")}</th><th className="p-2 font-medium">{t("status")}</th><th className="p-2 font-medium">{t("match")}</th>
                    {data.visibility.invoiceAmounts ? <th className="p-2 text-right font-medium">{t("amount")}</th> : null}
                  </tr></thead>
                  <tbody>
                    {invoices.rows.map((row) => (
                      <tr key={row.id} className="border-t" data-testid="supplier-invoice-record">
                        <td className="p-2"><EntityLink kind="supplier_invoice" id={row.id} className="text-blue-600">{row.invoiceNumber}</EntityLink></td>
                        <td className="p-2">{f.day(row.invoiceDate)}</td>
                        <td className="p-2">{f.status(row.status)}</td>
                        <td className="p-2">{f.status(row.matchStatus)}</td>
                        {data.visibility.invoiceAmounts ? <td className="p-2 text-right tabular-nums">{f.money(row.amount, row.currency)}</td> : null}
                      </tr>
                    ))}
                  </tbody>
                </table>
                {invoices.more ? <Note>{t("moreInvoices")}</Note> : null}
                {!data.visibility.invoiceAmounts ? <Note>{t("amountsHidden")}</Note> : null}
              </div>
            )}
          </div>
        ) : null}
      </Card>
      <Card className="p-5" data-testid="supplier-risks">
        <h2 className="text-sm font-semibold">{titles.risks}</h2>
        {status("supplier-risks")}
        {data && !issues ? <Note testId="supplier-risks-hidden">{t("issuesHidden")}</Note> : null}
        {issues && !issues.length ? <div className="py-8 text-center text-xs" style={{ color: A.sub }}>{empty.risks}</div> : null}
        {issues && issues.length ? (
          <>
            <ul className="mt-3 space-y-2 text-xs">
              {issues.map((issue) => (
                <li key={issue.id} className="flex flex-wrap items-baseline gap-x-2" data-testid="supplier-risk">
                  <EntityLink kind={issue.entityType} id={issue.entityId} className="font-medium text-blue-600">{issue.label}</EntityLink>
                  <span>{issueText(issue)}</span>
                  {issueDate(issue) ? <span style={{ color: A.sub }}>{issueDate(issue)}</span> : null}
                </li>
              ))}
            </ul>
            <Note>{t("order")}</Note>
          </>
        ) : null}
      </Card>
    </>
  );
}
