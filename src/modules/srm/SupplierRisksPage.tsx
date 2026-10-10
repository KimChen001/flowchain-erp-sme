import { useEffect, useMemo, useState, type ElementType } from "react";
import { AlertTriangle, FileWarning, PackageX, Truck } from "lucide-react";
import { apiJson } from "../../lib/api-client";
import { A, Card, Field, KpiCard, inputStyle } from "../../components/ui";
import { tableBodyTextClass, tableLinkClass, tableScrollClass, tdNameClass, tdNowrapClass, tdNumericRightClass, thClass, thRightClass } from "../../components/ui/workbenchTable";
import { EntityLink } from "../../components/business/EntityLink";
import { useI18n } from "../../i18n/I18n";
import { supplierCopy } from "./supplierCopy";
import { useSupplierActivityFormat, useSupplierIssueText, type SupplierIssue, type SupplierIssueType } from "./supplierActivity";

// Supplier risks (owner decision 2026-10-09): every supplier's open issues on
// one list, from GET /api/master-data/supplier-risks: the same signals the
// supplier list's "Open issues" counts and each detail page's "Risks and
// exceptions" lists, with the reader's access. Earliest date first, never by
// a score (owner rule 2026-10-03).

type RiskRow = SupplierIssue & { supplierId: string; supplierCode: string; supplierName: string };
type SupplierRisks = {
  asOf: string;
  visibility: { orders: boolean; receipts: boolean; invoices: boolean; issues: boolean };
  issueTypes: SupplierIssueType[];
  issues: RiskRow[] | null;
};

// Each kind of issue, the source the reader needs to see it, and its card.
const KINDS: Array<{ type: SupplierIssueType; label: string; sub: string; source: keyof SupplierRisks["visibility"]; icon: ElementType; color: string }> = [
  { type: "po_overdue", label: "Overdue purchase orders", sub: "Past their promised date", source: "orders", icon: AlertTriangle, color: A.red },
  { type: "grn_rejected_qty", label: "Receipts with rejections", sub: "A quantity was rejected on receipt", source: "receipts", icon: PackageX, color: A.orange },
  { type: "grn_received_unposted", label: "Received, not posted", sub: "Not yet posted to inventory", source: "receipts", icon: Truck, color: A.blue },
  { type: "invoice_variance", label: "Invoice variances", sub: "Invoices that differ from the PO or receipt", source: "invoices", icon: FileWarning, color: A.purple },
];

export default function SupplierRisksPage() {
  const { language } = useI18n();
  const t = (value: string) => supplierCopy(value, language);
  const f = useSupplierActivityFormat();
  const { issueText } = useSupplierIssueText();
  const [data, setData] = useState<SupplierRisks | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [tick, setTick] = useState(0);
  const [query, setQuery] = useState("");
  const [type, setType] = useState<"" | SupplierIssueType>("");
  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(false);
    apiJson<SupplierRisks>("/api/master-data/supplier-risks")
      .then((value) => { if (alive) setData(value); })
      .catch(() => { if (alive) setError(true); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [tick]);

  const issues = data?.issues || [];
  // The server's order is kept: filtering never reorders.
  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return issues.filter((row) => (!type || row.type === type) && (!needle || `${row.supplierCode} ${row.supplierName}`.toLowerCase().includes(needle)));
  }, [issues, query, type]);
  const visible = (kind: (typeof KINDS)[number]) => Boolean(data?.visibility[kind.source]);
  const hiddenKinds = data?.issues ? KINDS.filter((kind) => !visible(kind)) : [];
  const filtered = Boolean(query || type);
  const resetFilters = () => { setQuery(""); setType(""); };
  const listSeparator = language === "en-US" ? ", " : "、";

  return (
    <div className="space-y-5" data-testid="supplier-risks-page">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {KINDS.map((kind) => (
          <KpiCard
            key={kind.type}
            label={t(kind.label)}
            value={!data || !data.issues || !visible(kind) ? "—" : String(issues.filter((row) => row.type === kind.type).length)}
            sub={data && (!data.issues || !visible(kind)) ? t("Hidden for your role") : t(kind.sub)}
            icon={kind.icon}
            color={kind.color}
          />
        ))}
      </div>

      <Card className="p-5">
        <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="fc-section-title" style={{ color: A.label }}>{t("Supplier risk search")}</h2>
            <div className="mt-1 text-xs" style={{ color: A.sub }}>{t("Search open issues by supplier and issue type.")}</div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" onClick={resetFilters} className="h-8 rounded-lg px-3 text-xs font-medium" style={{ background: A.gray6, color: A.label }}>{t("Reset")}</button>
            <button type="button" onClick={() => setTick((value) => value + 1)} className="h-8 rounded-lg px-3 text-xs font-medium" style={{ background: A.gray6, color: A.label }}>{t("Refresh")}</button>
          </div>
        </div>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-4">
          <Field label={t("Supplier")}>
            <input aria-label={t("Search suppliers")} placeholder={t("Supplier code or name")} value={query} onChange={(event) => setQuery(event.target.value)} style={inputStyle} />
          </Field>
          <Field label={t("Issue type")}>
            <select aria-label={t("Issue type filter")} value={type} onChange={(event) => setType(event.target.value as typeof type)} style={inputStyle}>
              <option value="">{t("All issue types")}</option>
              {KINDS.map((kind) => <option key={kind.type} value={kind.type}>{t(kind.label)}</option>)}
            </select>
          </Field>
        </div>
      </Card>

      <Card>
        <div className="flex items-center gap-3 px-5 py-3.5" style={{ borderBottom: "0.5px solid rgba(0,0,0,0.08)" }}>
          <div>
            <div className="text-sm font-semibold" style={{ color: A.label }}>{t("Open issues")}</div>
            <div className="mt-0.5 text-[11px]" style={{ color: A.sub }} data-testid="supplier-risks-count">
              {t(issues.length === 1 ? "1 issue, {shown} shown" : "{total} issues, {shown} shown").replace("{total}", String(issues.length)).replace("{shown}", String(shown.length))}
            </div>
          </div>
        </div>
        {data?.issues && <p className="px-5 pt-3 text-[11px]" style={{ color: A.sub }}>{t("Earliest date first: an overdue purchase order by its promised date, any other issue by the day it started. Never ordered by a score.")}</p>}
        {hiddenKinds.length > 0 && <p className="px-5 pt-1 text-[11px]" style={{ color: A.sub }} data-testid="supplier-risks-partial">
          {t("Some kinds of issue are hidden for your role: {kinds}.").replace("{kinds}", hiddenKinds.map((kind) => t(kind.label)).join(listSeparator))}
        </p>}
        {error ? (
          <div className="p-8 text-center">
            <div className="text-sm" style={{ color: A.red }}>{t("Could not load supplier risks.")}</div>
            <button type="button" onClick={() => setTick((value) => value + 1)} className="mt-3 text-xs text-blue-600">{t("Retry")}</button>
          </div>
        ) : loading && !data ? (
          <div className="p-8 text-center text-xs" style={{ color: A.sub }}>{t("Loading…")}</div>
        ) : data && !data.issues ? (
          <div className="py-14 text-center text-sm" style={{ color: A.sub }} data-testid="supplier-risks-hidden">
            {t("Hidden for your role: you cannot read the purchase orders, receipts or supplier invoices behind these issues.")}
          </div>
        ) : shown.length === 0 ? (
          <div className="py-14 text-center text-sm" style={{ color: A.sub }} data-testid="supplier-risks-empty">
            <span className="font-semibold" style={{ color: A.label }}>{t(filtered ? "No issues match these filters" : "No open supplier issues")}</span>
            <br />
            <span className="text-xs">{t(filtered ? "Reset the filters to see every open issue." : "Overdue purchase orders, rejected or unposted receipts and invoice variances are listed here when they happen. Nothing needs following up now.")}</span>
          </div>
        ) : (
          <div className={tableScrollClass}>
            <table className={`w-full min-w-[960px] text-left ${tableBodyTextClass}`} data-testid="supplier-risks-table">
              <thead>
                <tr style={{ borderBottom: "0.5px solid rgba(0,0,0,0.06)" }}>
                  {["Date", "Supplier", "Issue", "Document"].map((label) => <th key={label} className={thClass} style={{ color: A.gray1 }}>{t(label)}</th>)}
                  <th className={thRightClass} style={{ color: A.gray1 }}>{t("Days overdue")}</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((row, index) => (
                  <tr key={row.id} data-testid="supplier-risk-row" data-type={row.type} className="transition-colors hover:bg-blue-50/40" style={{ borderBottom: index < shown.length - 1 ? "0.5px solid rgba(0,0,0,0.04)" : "none" }}>
                    <td className={tdNowrapClass} title={row.when.date ? t(row.when.kind === "overdue" ? "Promised date" : "Open since") : undefined}>
                      <span className="tabular-nums" data-testid="supplier-risk-date" data-date={row.when.date || ""}>{f.day(row.when.date)}</span>
                    </td>
                    <td className={`${tdNameClass} max-w-[240px]`} title={row.supplierName}>
                      <EntityLink kind="supplier" id={row.supplierId} className={tableLinkClass}>{row.supplierName}</EntityLink>
                      <div className="text-[11px]" style={{ color: A.sub }}>{row.supplierCode}</div>
                    </td>
                    <td className={`${tdNameClass} max-w-[320px] truncate`} title={issueText(row)}>{issueText(row)}</td>
                    <td className={tdNowrapClass}>
                      <EntityLink kind={row.entityType} id={row.entityId} className={tableLinkClass}>{row.label}</EntityLink>
                    </td>
                    <td className={tdNumericRightClass}>
                      {row.when.kind === "overdue" && row.when.days !== null ? <span style={{ color: A.red }}>{row.when.days}</span> : <span style={{ color: A.gray2 }}>—</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
