import { A } from "../../components/ui";
import { useI18n } from "../../i18n/I18n";
import { supplierCopy } from "./supplierCopy";
import type { SupplierInsight } from "./supplierInsights";

// The supplier metric cells and their sorts, shared by the supplier list and
// Supplier evaluation. A metric the reader may not see shows "—" with a
// tooltip, never 0. Money stays in its own currency and is never added
// across currencies.
export function useSupplierMetricCells() {
  const { language, locale } = useI18n();
  const t = (value: string) => supplierCopy(value, language);
  const hiddenCell = <span title={t("Hidden for your role")} style={{ color: A.sub }}>—</span>;
  const count = (value: number | null | undefined) => (value === null || value === undefined ? hiddenCell : <span className="tabular-nums">{value}</span>);
  const moneyText = (amount: number, currency: string) => {
    try { return new Intl.NumberFormat(locale, { style: "currency", currency, maximumFractionDigits: 0 }).format(amount); }
    catch { return `${currency} ${amount}`; }
  };
  const spendCell = (insight?: SupplierInsight) => {
    if (!insight || insight.spend12m === null) return hiddenCell;
    if (!insight.spend12m.length) return <span className="tabular-nums">0</span>;
    const [first, ...others] = insight.spend12m;
    return <span className="tabular-nums" title={insight.spend12m.map((row) => moneyText(row.amount, row.currency)).join(" · ")}>
      {moneyText(first.amount, first.currency)}{others.length ? <span style={{ color: A.sub }}> +{others.length} {t("currencies")}</span> : null}
    </span>;
  };
  const onTimeCell = (insight?: SupplierInsight) => {
    if (!insight || insight.onTime === null) return hiddenCell;
    if (insight.onTime.rate === null) return <span title={t("Fewer than 5 deliveries in 90 days")} style={{ color: A.sub }}>—</span>;
    // Deliveries measured against the date on the PO, which may be the buyer's need date.
    const detail = t("{count} of {of} deliveries on time against the date on the PO, which may be the buyer's need date").replace("{count}", String(insight.onTime.count)).replace("{of}", String(insight.onTime.of));
    return <span className="tabular-nums" title={detail}>{new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 0 }).format(insight.onTime.rate)}</span>;
  };
  return { count, spendCell, onTimeCell };
}

export type SupplierSort = "name" | "spend" | "open" | "overdue" | "onTime" | "issues";

// The reader chooses the order; it never comes from a hidden weight. Name is
// the order the server returns. Spend sorts by currency, then amount, and
// never compares across currencies; counts sort the most first; on time the
// lowest rate first. A value the reader may not see, or a supplier with no
// rate or no spend, sorts last. Ties go by name.
export function sortSuppliersBy<T extends { id: string; supplierName: string }>(rows: T[], sortBy: SupplierSort, insightOf: (id: string) => SupplierInsight | undefined): T[] {
  if (sortBy === "name") return rows;
  const byName = (a: T, b: T) => a.supplierName.localeCompare(b.supplierName);
  const lastWhenMissing = (a: number | null, b: number | null) => (a === null ? 1 : 0) - (b === null ? 1 : 0);
  if (sortBy === "onTime") {
    const rate = (row: T) => insightOf(row.id)?.onTime?.rate ?? null;
    return [...rows].sort((a, b) => lastWhenMissing(rate(a), rate(b)) || (rate(a) ?? 0) - (rate(b) ?? 0) || byName(a, b));
  }
  if (sortBy === "spend") {
    const first = (row: T) => insightOf(row.id)?.spend12m?.[0] || null;
    return [...rows].sort((a, b) => {
      const x = first(a), y = first(b);
      return lastWhenMissing(x ? x.amount : null, y ? y.amount : null) || (x && y ? x.currency.localeCompare(y.currency) || y.amount - x.amount : 0) || byName(a, b);
    });
  }
  const value = (row: T) => {
    const insight = insightOf(row.id);
    const metric = sortBy === "open" ? insight?.openPos : sortBy === "overdue" ? insight?.overduePos : insight?.openIssues;
    return metric ?? null;
  };
  return [...rows].sort((a, b) => lastWhenMissing(value(a), value(b)) || (value(b) ?? 0) - (value(a) ?? 0) || byName(a, b));
}
