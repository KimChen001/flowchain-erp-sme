import { A } from "../../components/ui";
import { useI18n } from "../../i18n/I18n";
import { useWorkspaceCurrency } from "../../lib/useWorkspaceCurrency";
import { formatLocaleAmount } from "../../lib/format";
import { supplierCopy } from "./supplierCopy";
import type { SupplierInsight, SupplierRate } from "./supplierInsights";

// Spend with the workspace currency first, then the other currencies in the
// server's order. Amounts in different currencies are never compared (design
// audit L9-16).
export function spendInOrder(spend: Array<{ currency: string; amount: number }>, workspaceCurrency?: string | null) {
  const own = spend.filter((row) => workspaceCurrency && row.currency === workspaceCurrency);
  return [...own, ...spend.filter((row) => !own.includes(row))];
}

// The supplier metric cells and their sorts, shared by the supplier list and
// Supplier evaluation. A metric the reader may not see shows "—" with a
// tooltip, never 0. Money stays in its own currency and is never added
// across currencies.
export function useSupplierMetricCells() {
  const { language, locale } = useI18n();
  const { currency: workspaceCurrency } = useWorkspaceCurrency();
  const t = (value: string) => supplierCopy(value, language);
  const hiddenCell = <span title={t("Hidden for your role")} style={{ color: A.sub }}>—</span>;
  const count = (value: number | null | undefined) => (value === null || value === undefined ? hiddenCell : <span className="tabular-nums">{value}</span>);
  // The app's money format, with the currency's decimals ("$19,120.00").
  const moneyText = (amount: number, currency: string) => formatLocaleAmount(amount, currency, locale);
  const incompleteTip = t("Some orders in the last 12 months have no amount on record, so this total leaves them out.");
  const spendCell = (insight?: SupplierInsight) => {
    if (!insight || insight.spend12m === null) return hiddenCell;
    // Amounts missing: never a total that reads as complete (design audit L9-17).
    const incomplete = insight.spendComplete === false;
    if (!insight.spend12m.length) {
      if (incomplete) return <span title={incompleteTip} style={{ color: A.sub }} data-testid="supplier-spend-incomplete">—</span>;
      // No committed spend: zero in the workspace currency, styled as the amounts beside it.
      return <span className="tabular-nums" title={t("No spend in the last 12 months")}>{workspaceCurrency ? moneyText(0, workspaceCurrency) : "0"}</span>;
    }
    const [first, ...others] = spendInOrder(insight.spend12m, workspaceCurrency);
    const amounts = spendInOrder(insight.spend12m, workspaceCurrency).map((row) => moneyText(row.amount, row.currency)).join(" · ");
    return <span className="tabular-nums" title={incomplete ? `${amounts}. ${incompleteTip}` : amounts}>
      {moneyText(first.amount, first.currency)}{others.length ? <span style={{ color: A.sub }}> +{others.length} {t("currencies")}</span> : null}
      {incomplete ? <span style={{ color: A.sub }} data-testid="supplier-spend-incomplete"> {t("incomplete")}</span> : null}
    </span>;
  };
  // A scorecard rate as a percentage, or, below the minimum sample, the
  // counts behind it ("3/3"), never a bare "—" for a supplier that delivered
  // (design audit L9-13). Deliveries received in a warehouse the reader
  // cannot see are left out and named in the tooltip (design audit L9-06).
  const rateCell = (rate: SupplierRate | null | undefined, kind: "onTime" | "otif") => {
    if (!rate) return hiddenCell;
    const withheld = rate.withheld ? ` ${t("{n} deliveries received in warehouses you cannot see are left out.").replace("{n}", String(rate.withheld))}` : "";
    if (!rate.of) return <span title={`${t("No deliveries judged in the last 90 days.")}${withheld}`} style={{ color: A.sub }}>—</span>;
    // Deliveries measured against the date on the PO, which may be the buyer's need date.
    const detail = t(kind === "otif"
      ? "{count} of {of} deliveries on time and in full against the date on the PO, which may be the buyer's need date"
      : "{count} of {of} deliveries on time against the date on the PO, which may be the buyer's need date").replace("{count}", String(rate.count)).replace("{of}", String(rate.of));
    if (rate.rate === null) return <span className="tabular-nums" data-testid="supplier-rate-counts" title={`${detail}. ${t("A percentage needs 5 deliveries.")}${withheld}`} style={{ color: A.sub }}>{rate.count}/{rate.of}</span>;
    return <span className="tabular-nums" title={`${detail}.${withheld}`}>{new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 0 }).format(rate.rate)}</span>;
  };
  const onTimeCell = (insight?: SupplierInsight) => rateCell(insight?.onTime, "onTime");
  const otifCell = (insight?: SupplierInsight) => rateCell(insight?.otif, "otif");
  return { count, spendCell, onTimeCell, otifCell, workspaceCurrency };
}

export const ON_TIME_HEADER_TIP = "Share of deliveries received by the date on the PO, over the last 90 days. That date may be the buyer's need date.";
export const OTIF_HEADER_TIP = "Share of deliveries received in full by the date on the PO, over the last 90 days. A delivery still short before that date is not counted yet.";
// The headers whose measure needs saying, with what each counts (design audit
// L9-14, L9-18: "overdue" and "issues" mean one thing each here).
export const METRIC_HEADER_TIPS: Readonly<Record<string, string>> = {
  "Overdue POs": "Open purchase orders sent to the supplier and past their promised date today.",
  "On time, 90 days": ON_TIME_HEADER_TIP,
  "OTIF, 90 days": OTIF_HEADER_TIP,
  "Open issues": "Receipts with rejections and invoice variances still open. Overdue orders are counted under Overdue POs.",
};

export type SupplierSort = "name" | "spend" | "open" | "overdue" | "onTime" | "otif" | "issues";

// The reader chooses the order; it never comes from a hidden weight. Name is
// the order the server returns. Spend sorts the suppliers with spend in the
// workspace currency first, highest first, then the others by currency and
// amount, and never compares across currencies; counts sort the most first;
// on time and OTIF the lowest rate first. A value the reader may not see, or
// a supplier with no rate or no spend, sorts last. Ties go by name.
export function sortSuppliersBy<T extends { id: string; supplierName: string }>(rows: T[], sortBy: SupplierSort, insightOf: (id: string) => SupplierInsight | undefined, workspaceCurrency?: string | null): T[] {
  if (sortBy === "name") return rows;
  const byName = (a: T, b: T) => a.supplierName.localeCompare(b.supplierName);
  const lastWhenMissing = (a: number | null, b: number | null) => (a === null ? 1 : 0) - (b === null ? 1 : 0);
  if (sortBy === "onTime" || sortBy === "otif") {
    const rate = (row: T) => insightOf(row.id)?.[sortBy]?.rate ?? null;
    return [...rows].sort((a, b) => lastWhenMissing(rate(a), rate(b)) || (rate(a) ?? 0) - (rate(b) ?? 0) || byName(a, b));
  }
  if (sortBy === "spend") {
    const first = (row: T) => spendInOrder(insightOf(row.id)?.spend12m || [], workspaceCurrency)[0] || null;
    const foreign = (row: { currency: string } | null) => (row && workspaceCurrency && row.currency === workspaceCurrency ? 0 : 1);
    return [...rows].sort((a, b) => {
      const x = first(a), y = first(b);
      return lastWhenMissing(x ? x.amount : null, y ? y.amount : null) || (x && y ? foreign(x) - foreign(y) || x.currency.localeCompare(y.currency) || y.amount - x.amount : 0) || byName(a, b);
    });
  }
  const value = (row: T) => {
    const insight = insightOf(row.id);
    const metric = sortBy === "open" ? insight?.openPos : sortBy === "overdue" ? insight?.overduePos : insight?.openIssues;
    return metric ?? null;
  };
  return [...rows].sort((a, b) => lastWhenMissing(value(a), value(b)) || (value(b) ?? 0) - (value(a) ?? 0) || byName(a, b));
}
