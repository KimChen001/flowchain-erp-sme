import { Fragment, useEffect, useRef, useState } from "react";
import { RefreshCw, Search } from "lucide-react";
import { apiJson } from "../../lib/api-client";
import { A, Card, Chip, Field, inputStyle } from "../../components/ui";
import { tableBodyTextClass, tableLinkClass, tableScrollClass, tdIdClass, tdNameClass, tdNowrapClass, thClass } from "../../components/ui/workbenchTable";
import { EntityLink } from "../../components/business/EntityLink";
import { useI18n } from "../../i18n/I18n";
import { useMasterDataWriteAccess } from "../master-data/writeAccess";
import { supplierCopy } from "./supplierCopy";
import { TierChip, TierForm, type Tier } from "./SupplierTier";
import type { SupplierInsight, SupplierInsights } from "./supplierInsights";
import { sortSuppliersBy, useSupplierMetricCells, type SupplierSort } from "./supplierMetrics";

// Supplier evaluation (owner decision 2026-10-09): each supplier's indicators
// (spend over 12 months, open and overdue POs, on time over 90 days, open
// issues, from GET /api/master-data/supplier-insights) with its business
// owner and, next to them, the tier a person set. People with
// master_data.supplier.manage set or change a tier here, with a reason,
// through the tier endpoint and its audit row. FlowChain suggests no tier.

type Person = { id: string; name: string | null };
type Status = "draft" | "active" | "inactive";
type EvaluatedSupplier = {
  id: string;
  supplierCode: string;
  supplierName: string;
  status: Status;
  version: number;
  tier: Tier;
  tierReason: string | null;
  businessOwner: Person | null;
};
type Counts = { all: number; mine: number; tier1: number; tier2: number; tier3: number; untiered: number };
type TierFilter = "" | "1" | "2" | "3" | "none";

const TIER_FILTERS: Array<{ value: TierFilter; label: string; count: keyof Counts }> = [
  { value: "", label: "All tiers", count: "all" },
  { value: "1", label: "Tier 1", count: "tier1" },
  { value: "2", label: "Tier 2", count: "tier2" },
  { value: "3", label: "Tier 3", count: "tier3" },
  { value: "none", label: "Not tiered", count: "untiered" },
];
const SORTS: Array<{ value: SupplierSort; label: string }> = [
  { value: "name", label: "Name" },
  { value: "spend", label: "Spend, highest first" },
  { value: "open", label: "Open POs, most first" },
  { value: "overdue", label: "Overdue POs, most first" },
  { value: "onTime", label: "On time, lowest first" },
  { value: "issues", label: "Open issues, most first" },
];
const STATUS_LABEL: Record<Status, string> = { active: "Active", inactive: "Inactive", draft: "Draft" };
// The long metric headers wrap to two lines, as on the supplier list.
const METRIC_HEADERS = ["Spend, 12 months", "Open POs", "Overdue POs", "On time (PO date), 90 days", "Open issues"];

function normalize(value: Record<string, unknown>): EvaluatedSupplier {
  const text = (candidate: unknown) => String(candidate ?? "").trim();
  const id = text(value.id || value.supplierCode);
  const status = text(value.status) as Status;
  return {
    id,
    supplierCode: text(value.supplierCode) || id,
    supplierName: text(value.supplierName || value.name) || id,
    status: ["draft", "active", "inactive"].includes(status) ? status : "active",
    version: Number(value.version || 1),
    tier: ([1, 2, 3].includes(Number(value.tier)) ? Number(value.tier) : null) as Tier,
    tierReason: text(value.tierReason) || null,
    businessOwner: (value.businessOwner as Person | null) || null,
  };
}

export default function SupplierEvaluationPage() {
  const { language } = useI18n();
  const t = (value: string) => supplierCopy(value, language);
  const canEdit = useMasterDataWriteAccess().suppliers;
  const { count, spendCell, onTimeCell } = useSupplierMetricCells();
  const [rows, setRows] = useState<EvaluatedSupplier[]>([]);
  const [counts, setCounts] = useState<Counts | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [insights, setInsights] = useState<SupplierInsights | null>(null);
  const [insightsFailed, setInsightsFailed] = useState(false);
  const [query, setQuery] = useState("");
  const [tier, setTier] = useState<TierFilter>("");
  const [owner, setOwner] = useState("");
  const [status, setStatus] = useState("");
  const [sortBy, setSortBy] = useState<SupplierSort>("name");
  const [editing, setEditing] = useState<string | null>(null);
  // Every owner seen so far, so choosing one does not empty the filter's own options.
  const [knownOwners, setKnownOwners] = useState<Person[]>([]);
  // Only the latest request may fill the list: an older, slower one is dropped.
  const sequence = useRef(0);
  const loadedOnce = useRef(false);

  const load = async () => {
    const current = ++sequence.current;
    setLoading(true);
    setError(false);
    try {
      const params = new URLSearchParams({ query, status, tier, owner });
      const data = await apiJson<{ suppliers: Array<Record<string, unknown>>; counts?: Counts }>(`/api/master-data/suppliers?${params}`);
      if (current !== sequence.current) return;
      const next = (data.suppliers || []).map(normalize);
      setRows(next);
      setCounts(data.counts || null);
      setKnownOwners((seen) => {
        const byId = new Map(seen.map((person) => [person.id, person]));
        for (const row of next) if (row.businessOwner) byId.set(row.businessOwner.id, row.businessOwner);
        return [...byId.values()].sort((a, b) => String(a.name || a.id).localeCompare(String(b.name || b.id)));
      });
    } catch {
      if (current === sequence.current) setError(true);
    } finally {
      if (current === sequence.current) setLoading(false);
    }
  };
  // Indicators are read once per page load and on Refresh, not per search.
  const loadInsights = async () => {
    try { setInsights(await apiJson<SupplierInsights>("/api/master-data/supplier-insights")); setInsightsFailed(false); }
    catch { setInsights(null); setInsightsFailed(true); }
  };
  useEffect(() => { loadInsights(); }, []);
  // Filters apply as they change; typing waits for a short pause.
  useEffect(() => {
    const timer = setTimeout(load, loadedOnce.current ? 300 : 0);
    loadedOnce.current = true;
    return () => clearTimeout(timer);
  }, [query, status, tier, owner]);

  const insightOf = (id: string): SupplierInsight | undefined => insights?.suppliers[id];
  const shown = sortSuppliersBy(rows, sortBy, insightOf);
  const filtered = Boolean(query || status || tier || owner);
  const resetFilters = () => { setQuery(""); setStatus(""); setTier(""); setOwner(""); };
  const refresh = () => { load(); loadInsights(); };
  // The total is every supplier under the search and status; tier and owner narrow what is shown.
  const total = counts?.all ?? rows.length;
  const columns = 9 + (canEdit ? 1 : 0);

  return (
    <div className="space-y-5" data-testid="supplier-evaluation">
      <Card className="p-5">
        <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="fc-section-title" style={{ color: A.label }}>{t("Supplier search")}</h2>
            <div className="mt-1 text-xs" style={{ color: A.sub }}>{t("Filter suppliers by name, tier, owner and status, and compare their indicators.")}</div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" onClick={resetFilters} className="h-8 rounded-lg px-3 text-xs font-medium" style={{ background: A.gray6, color: A.label }}>{t("Reset")}</button>
            <button type="button" onClick={refresh} className="inline-flex h-8 items-center gap-1.5 rounded-lg px-3 text-xs font-medium" style={{ background: A.gray6, color: A.label }}>
              <RefreshCw size={13} />
              {t("Refresh")}
            </button>
          </div>
        </div>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-4">
          <Field label={t("Search")}>
            <label className="flex items-center gap-2" style={{ ...inputStyle, paddingTop: 0, paddingBottom: 0 }}>
              <Search size={14} style={{ color: A.gray2 }} />
              <input aria-label={t("Search suppliers")} value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("Code or name")} className="h-9 min-w-0 flex-1 bg-transparent outline-none" />
            </label>
          </Field>
          <Field label={t("Tier")}>
            <select aria-label={t("Tier filter")} data-testid="supplier-evaluation-tier-filter" value={tier} onChange={(event) => setTier(event.target.value as TierFilter)} style={inputStyle}>
              {TIER_FILTERS.map((option) => (
                <option key={option.value} value={option.value}>{t(option.label)}{counts ? ` (${counts[option.count]})` : ""}</option>
              ))}
            </select>
          </Field>
          <Field label={t("Business owner")}>
            <select aria-label={t("Owner filter")} value={owner} onChange={(event) => setOwner(event.target.value)} style={inputStyle}>
              <option value="">{t("All owners")}</option>
              <option value="me">{t("Managed by me")}</option>
              <option value="none">{t("No owner")}</option>
              {knownOwners.map((person) => <option key={person.id} value={person.id}>{person.name || person.id}</option>)}
            </select>
          </Field>
          <Field label={t("Status")}>
            <select aria-label={t("Status filter")} value={status} onChange={(event) => setStatus(event.target.value)} style={inputStyle}>
              <option value="">{t("All statuses")}</option>
              <option value="active">{t("Active")}</option>
              <option value="inactive">{t("Inactive")}</option>
              <option value="draft">{t("Draft")}</option>
            </select>
          </Field>
        </div>
      </Card>

      <Card>
        <div className="flex flex-wrap items-center gap-3 px-5 py-3.5" style={{ borderBottom: "0.5px solid rgba(0,0,0,0.08)" }}>
          <div className="min-w-0">
            <div className="text-sm font-semibold" style={{ color: A.label }}>{t("Supplier indicators")}</div>
            <div className="mt-0.5 text-[11px]" style={{ color: A.sub }} data-testid="supplier-evaluation-count">
              {t(total === 1 ? "1 supplier, {shown} shown" : "{total} suppliers, {shown} shown").replace("{total}", String(total)).replace("{shown}", String(shown.length))}
            </div>
          </div>
          <label className="ml-auto flex items-center gap-1.5 text-xs" style={{ color: A.sub }}>
            {t("Sort by")}
            <select aria-label={t("Sort by")} value={sortBy} onChange={(event) => setSortBy(event.target.value as SupplierSort)} style={{ ...inputStyle, width: "auto", minWidth: 160, paddingTop: 4, paddingBottom: 4 }}>
              {SORTS.map((option) => <option key={option.value} value={option.value}>{t(option.label)}</option>)}
            </select>
          </label>
        </div>
        <p className="px-5 pt-3 text-[11px]" style={{ color: A.sub }}>{t("Tiers are set by your team with a reason and kept in each supplier's history. FlowChain does not suggest tiers.")}</p>
        {insightsFailed && <p role="alert" className="px-5 pt-2 text-xs" style={{ color: A.red }}>{t("Indicators could not be loaded. Refresh to try again.")}</p>}
        {error ? (
          <div className="p-8 text-center">
            <div className="text-sm" style={{ color: A.red }}>{t("Could not load suppliers.")}</div>
            <button type="button" onClick={load} className="mt-3 text-xs text-blue-600">{t("Retry")}</button>
          </div>
        ) : loading && rows.length === 0 ? (
          <div className="p-8 text-center text-xs" style={{ color: A.sub }}>{t("Loading…")}</div>
        ) : rows.length === 0 ? (
          <div className="py-14 text-center text-sm" style={{ color: A.sub }}>
            <span className="font-semibold" style={{ color: A.label }}>{t(filtered ? "No suppliers match these filters" : "No suppliers yet")}</span>
            <br />
            <span className="text-xs">{t(filtered ? "Reset the filters to see every supplier." : "Add suppliers on the Suppliers tab, or import a file of suppliers, to evaluate them here.")}</span>
          </div>
        ) : (
          <div className={tableScrollClass}>
            <table className={`w-full min-w-[1080px] text-left ${tableBodyTextClass}`} data-testid="supplier-evaluation-table">
              <thead>
                <tr style={{ borderBottom: "0.5px solid rgba(0,0,0,0.06)" }}>
                  <th className={`${thClass} sticky left-0 z-20 bg-white align-bottom`} style={{ color: A.gray1 }}>{t("Supplier code")}</th>
                  <th className={`${thClass} align-bottom`} style={{ color: A.gray1 }}>{t("Supplier name")}</th>
                  <th className={`${thClass} align-bottom`} style={{ color: A.gray1 }}>{t("Business owner")}</th>
                  {METRIC_HEADERS.map((label) => <th key={label} className={`${thClass} align-bottom !whitespace-normal min-w-[96px] max-w-[132px]`} style={{ color: A.gray1 }}>{t(label)}</th>)}
                  <th className={`${thClass} align-bottom`} style={{ color: A.gray1 }}>{t("Tier")}</th>
                  {canEdit && <th className={`${thClass} sticky right-0 z-20 bg-white align-bottom`} style={{ color: A.gray1 }}>{t("Actions")}</th>}
                </tr>
              </thead>
              <tbody>
                {shown.map((row, index) => {
                  const insight = insightOf(row.id);
                  return (
                    <Fragment key={row.id}>
                      <tr className="transition-colors hover:bg-blue-50/40" data-testid={`supplier-evaluation-row-${row.id}`} style={{ borderBottom: index < shown.length - 1 || editing === row.id ? "0.5px solid rgba(0,0,0,0.04)" : "none" }}>
                        <td className={`${tdIdClass} sticky left-0 z-10 bg-white`}>
                          <EntityLink kind="supplier" id={row.id} className={tableLinkClass}>{row.supplierCode}</EntityLink>
                        </td>
                        <td className={`${tdNameClass} max-w-[220px]`} title={row.supplierName}>
                          <div className="truncate font-medium" style={{ color: A.label }}>{row.supplierName}</div>
                          {row.status !== "active" && <div className="mt-0.5"><Chip label={t(STATUS_LABEL[row.status])} color={A.gray1} bg={A.gray6} /></div>}
                        </td>
                        <td className={tdNowrapClass} style={{ color: A.sub }}>{row.businessOwner?.name || "—"}</td>
                        <td className={tdNowrapClass}>{spendCell(insight)}</td>
                        <td className={tdNowrapClass}>{count(insight?.openPos)}</td>
                        <td className={tdNowrapClass}>{count(insight?.overduePos)}</td>
                        <td className={tdNowrapClass}>{onTimeCell(insight)}</td>
                        <td className={tdNowrapClass}>{count(insight?.openIssues)}</td>
                        <td className={tdNowrapClass} title={row.tierReason || undefined}><TierChip tier={row.tier} short /></td>
                        {canEdit && <td className={`${tdNowrapClass} sticky right-0 z-10 bg-white`}>
                          <button type="button" data-testid="supplier-evaluation-set-tier" aria-expanded={editing === row.id} onClick={() => setEditing(editing === row.id ? null : row.id)} className="rounded-md bg-slate-100 px-2 py-1 text-[11px] font-medium">
                            {t(row.tier === null ? "Set tier" : "Change tier")}
                          </button>
                        </td>}
                      </tr>
                      {editing === row.id && (
                        <tr>
                          <td colSpan={columns} className="px-4 pb-4">
                            <div className="max-w-3xl">
                              <div className="mb-2 text-xs font-semibold" style={{ color: A.label }}>{row.supplierName}</div>
                              <TierForm supplier={row} onCancel={() => setEditing(null)} onSaved={async () => { setEditing(null); await load(); }} />
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
