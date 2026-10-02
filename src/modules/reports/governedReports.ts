import { apiJson } from "../../lib/api-client";

export type DashboardView = "overview" | "procurement" | "sales" | "inventory" | "finance" | "suppliers";
export type CurrencyAggregationStatus = "single_currency" | "filtered_currency" | "multi_currency_unconverted" | "currency_unknown" | "no_currency_data";
// currencyCode is null for the group of records whose currency is missing or invalid.
export type CurrencyAmount = { currencyCode: string | null; currencyLabel: string; amount: number | null; recordCount?: number };
// Money metrics carry their own currency, computed from their own rows.
export type MetricCurrency = { currencyCode?: string | null; currencyLabel?: string; currencies?: string[]; currencyAggregationStatus?: CurrencyAggregationStatus; currencyAmounts?: CurrencyAmount[] };
export type MetricDefinition = MetricCurrency & { id: string; label: string; description: string; subject: string; unit: string; format: string; aggregation: string; numerator: string; denominator: string | null; dateField: string; applicableFilters: string[]; drilldownPath: string; emptyValue: number; version: string; value: number | null; currentValue: number | null; dataStatus?: "complete" | "no_records" | "numeric_zero" | "incomplete" | "multi_currency_unconverted"; limitations?: string[]; comparisonValue: number | null; comparisonDelta: number | null; comparisonRate: number | null; comparisonDirection: "up" | "down" | "flat"; comparisonLabel: string; comparisonUnit: string; calculationLabel: string; trend?: Array<{ period: string; value: number }> | null };
export type ReportChartType = "line" | "bar" | "horizontal_bar" | "area" | "stacked_bar" | "pie" | "donut" | "combo" | "pareto" | "funnel" | "waterfall" | "treemap" | "gauge" | "heatmap" | "calendar" | "sankey" | "scatter" | "radar";
// A measure of a combo, Pareto or scatter visual: which value axis it uses (or
// the x, y and size of a scatter) and its unit.
export type ReportMeasure = { key: string; kind?: "bar" | "line"; unit: string; axis: number | "x" | "y" | "size"; label?: string };
export type ReportChart = {
  id: string; title: string; type: ReportChartType; data?: Array<Record<string, string | number | null | undefined>>; series?: Array<{ key: string; label: string; data: Array<{ period: string; value: number | null }> }>; categoryKey?: string; valueKey?: string; seriesKeys?: string[]; valueFormat?: string; unit?: string; stack?: boolean; orientation?: string; legend?: boolean; tooltip?: boolean; colors?: string[]; drilldownPath: string; crossFilter?: string | null; emptyState?: string;
  description?: string; currencyCode?: string | null; measures?: ReportMeasure[]; totals?: string[]; breakdown?: Record<string, Array<{ name: string; value: number }>>;
  range?: [string, string]; links?: Array<{ source: string; target: string; value: number }>; targets?: string[]; guides?: { x: number | null; y: number | null };
  detail?: { count: number; total: number; exception?: number; pending?: number }; statusLabels?: boolean; limitations?: string[];
};
export type ReportColumnDefinition = { key: string; label: string; type: string; subject: string; valueMap?: Record<string, string> };
export type GovernedReport = {
  totalRecords?: number;
  /** Subjects the server read only up to a row limit; totals over them may be low. */
  truncatedSubjects?: Array<{ subject: string; limit: number }>;
  attention?: Array<{ id: string; label: string; count: number; path: string; action: string }>;
  query: Record<string, unknown>; generatedAt: string; dataScope: { label: string; company: string; currencyCode: string | null; currencyLabel: string; currencies: string[]; currencyAggregationStatus: CurrencyAggregationStatus; currencyAmounts: CurrencyAmount[]; fxConverted: boolean; from: string; to: string; activeFilterCount: number; sourceLabel: string; completenessLabel: string; filterOptions: { companies: string[]; warehouses: string[]; suppliers: string[]; customers: string[]; categories: string[]; currencies: string[] } };
  kpis: MetricDefinition[]; charts: ReportChart[]; rankings: ReportChart[]; details: Record<string, unknown>[]; columnDefinitions: ReportColumnDefinition[]; warnings: string[]; limitations: string[];
  drilldowns: Array<{ metricId: string; path: string }>; exportRows: Record<string, unknown>[]; metricDefinitions: Omit<MetricDefinition, "value">[];
};
export type SavedReportView = { viewId: string; name: string; description: string; ownerId: string; ownerName: string; subject: string; sourceRoute: string; columns: string[]; columnOrder?: string[]; filters: Record<string, string>; sorting: unknown[]; grouping: string[]; measures: string[]; visualization: string; comparison?: string; hiddenCharts?: string[]; chartOrder?: string[]; topN?: number; dateRange?: { from: string; to: string }; visibility: "private" | "team"; isDefault: boolean; createdAt: string; updatedAt: string; lastOpenedAt: string; version: number };

export function fetchGovernedReport(view: DashboardView, filters: Record<string, string>) {
  const topN = filters.topN ? Number(filters.topN) : undefined;
  return apiJson<GovernedReport>("/api/reports/query", { method: "POST", body: JSON.stringify({ subject: view, filters, measures: (filters.measures || "").split(",").filter(Boolean), comparison: filters.comparison, ...(topN ? { topN } : {}), limit: 50 }) });
}
// The signed-in person as the saved-view API sees them. canManageTeamViews
// means they may also edit and delete team views they do not own.
export type SavedReportViewActor = { id: string; name?: string; role: string; canManageTeamViews?: boolean };
export function listSavedReportViews(visibility = "") { return apiJson<{ views: SavedReportView[]; actor: SavedReportViewActor }>(`/api/report-views${visibility ? `?visibility=${visibility}` : ""}`); }
export function createSavedReportView(input: Partial<SavedReportView>) { return apiJson<{ view: SavedReportView; auditEventId: string }>("/api/report-views", { method: "POST", body: JSON.stringify(input) }); }
// expectedVersion is the version the caller last saw and is required; a newer
// view answers 409 so a stale screen never overwrites someone else's change.
export function updateSavedReportView(id: string, input: Partial<SavedReportView> & { expectedVersion: number }) { return apiJson<{ view: SavedReportView }>(`/api/report-views/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify(input) }); }
export function cloneSavedReportView(id: string, name?: string) { return apiJson<{ view: SavedReportView }>(`/api/report-views/${encodeURIComponent(id)}/clone`, { method: "POST", body: JSON.stringify({ name }) }); }
export function deleteSavedReportView(id: string) { return apiJson<{ deleted: true }>(`/api/report-views/${encodeURIComponent(id)}`, { method: "DELETE" }); }
