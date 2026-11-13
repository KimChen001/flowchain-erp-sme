import { OverviewAttention } from "./OverviewAttention";
import { StatusChip, listTableCardsRef, statusToneOf } from "../../components/ui/listLayout";
import { analyticsCopy, analyticsSentence, reportStatusCopy } from "./analyticsCopy";
import { ReportDateInput } from "./ReportDateInput";
import { ReportTruncationNotice } from "./ReportTruncationNotice";
import { dateRangeLabel, reportWorkbook } from "./reportWorkbook";
import { metricCurrency, metricDisplayValue, metricStateLabel } from "./metricDisplay";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { useDialogFocus } from "../../components/ui/useDialogFocus";
import { ArrowUpRight, BookmarkPlus, ChevronDown, ChevronUp, Download, Info, RefreshCw, RotateCcw, SlidersHorizontal, Sparkles, X } from "lucide-react";
import { useNavigate, useSearchParams } from "react-router";
import { VisualCard } from "./VisualCard";
import { PALETTE, type ChartContext } from "./charts/chartOptions";
import { reportInsights } from "./reportInsights";
import { toast } from "sonner";
import { A, Card, Chip, useConfirm } from "../../components/ui";
import { BusinessEntityLink } from "../../components/business/BusinessEntityLink";
import { exportWorkbookSheets } from "../../lib/excel/excelWorkbookService";
import { createSavedReportView, fetchGovernedReport, type DashboardView, type GovernedReport, type MetricDefinition, type ReportChart } from "./governedReports";
import { formatMetric } from "./currencyFormatting.mjs";
import { useI18n } from "../../i18n/I18n";
import { workspaceCopy } from "../../i18n/workspaceCopy";
import { formatCalendarDay } from "../../lib/format";
import { unitLabel } from "../../i18n/unitLabels";
import { apiErrorView } from "../../lib/apiErrorText";
export { formatMetric } from "./currencyFormatting.mjs";

const REPORT_ENGLISH: Record<string, string> = {
  "经营总览": "Business overview", "查看采购、销售与库存的核心数据": "Review core purchasing, sales, and inventory figures", "待处理经营事项": "Open business items",
  "采购分析": "Procurement analytics", "跟踪已承诺采购支出与未结采购订单": "Track committed purchasing spend and open purchase orders", "逾期采购订单": "Overdue purchase orders",
  "销售分析": "Sales analytics", "跟踪销售订单与未履约需求": "Track sales orders and unfulfilled demand", "风险销售订单": "Sales orders at risk",
  "库存分析": "Inventory analytics", "查看在手库存与存在短缺的 SKU": "Review on-hand inventory and SKUs with shortages", "风险库存": "Inventory at risk",
  "发票分析": "Invoice analytics", "查看已提交采购发票金额": "Review submitted supplier invoice amounts", "待处理发票": "Open invoices",
  "供应商分析": "Supplier analytics", "查看供应商记录与已承诺采购支出": "Review supplier records and committed purchasing spend", "供应商绩效": "Supplier performance",
  "调整当前视图": "Customize view", "指标口径": "Metric definitions", "导出": "Export", "保存视图": "Save view", "开始日期": "Start date", "结束日期": "End date", "公司": "Company", "比较方式": "Comparison", "不比较": "No comparison", "上期": "Previous period", "同比": "Year over year", "更多筛选": "More filters", "清除筛选": "Clear filters",
  "全部公司": "All companies", "全部仓库": "All warehouses", "全部供应商": "All suppliers", "全部客户": "All customers", "全部品类": "All categories", "全部币种": "All currencies", "仓库": "Warehouse", "供应商": "Supplier", "客户": "Customer", "品类": "Category", "币种": "Currency",
  "点击图形可筛选当前看板": "Select the chart to filter this dashboard", "受控业务数据": "Governed business data", "查看业务明细": "View business details", "当前范围暂无真实业务记录。可以调整筛选、创建业务数据，或在本地加载演示场景。": "No business records are available for this range. Adjust the filters, create business data, or load the local demo scenario.",
  "更新于": "Updated", "范围": "Range", "来源": "Source", "完整性": "Completeness", "个业务筛选": "business filters", "数据范围说明": "Data scope notes", "当前筛选没有显示图表": "No charts are visible for the current filters", "恢复默认图表": "Restore default charts", "导出五表工作簿": "Export five-sheet workbook", "条筛选后明细，与 KPI、图表和导出口径一致": "filtered records, aligned with the KPIs, charts, and export",
  "暂无业务记录": "No business records", "暂无金额数据": "No monetary data", "请选择币种": "Select a currency", "数据不足": "Insufficient data", "多币种，未折算": "Multiple currencies, not converted", "请选择币种查看金额汇总；当前未接入汇率，不会跨币种相加。": "Select a currency to view monetary totals. FX rates are not connected, so values are not added across currencies.", "当前范围暂无金额记录": "No monetary records in this range", "库存数据不完整": "Inventory data is incomplete", "未启用比较": "Comparison is off", "个百分点": "percentage points", "暂无基期": "No baseline", "点击下钻": "Select to drill down",
  "报表加载中": "Loading report", "加载指标": "Loading metric", "报表加载失败": "Could not load report", "加载失败": "Could not load", "重试": "Retry", "当前报表存在数据范围限制": "This report has data-scope limitations",
  "仓库数据尚未接入当前报表": "Warehouse data is not connected to this report", "库位数据尚未接入当前报表": "Location data is not connected to this report", "当前范围暂无收货记录": "No receiving records in this range", "当前范围暂无发票记录": "No invoice records in this range", "部分库存数量尚未接入，相关指标可能不完整": "Some inventory quantities are not connected, so related metrics may be incomplete", "当前包含多个币种，未进行汇率折算": "This range includes multiple currencies without FX conversion",
  "采购订单金额": "Purchase order amount", "库存风险 SKU": "Inventory risk SKUs", "销售订单数量": "Sales order count", "当前范围真实记录": "Records in current range", "业务编号": "Business ID", "单据号": "Document number", "业务日期": "Business date", "未结": "Open", "是": "Yes", "否": "No",
  "人民币（CNY）": "Chinese yuan (CNY)", "美元（USD）": "US dollar (USD)", "欧元（EUR）": "Euro (EUR)", "无币种数据": "No currency data",
};

const reportCopy = (label: string, language = typeof document === "undefined" ? "en-US" : document.documentElement.lang) => {
  if (language !== "en-US") return analyticsCopy(label, language);
  const days = label.match(/^([\d.]+) 天$/);
  if (days) return `${days[1]} days`;
  const loadedRecords = label.match(/^已读取 (\d+) 条真实记录$/);
  if (loadedRecords) return `${loadedRecords[1]} business records loaded`;
  return REPORT_ENGLISH[label] || analyticsCopy(workspaceCopy(label, language), language);
};

type NavigateFn = (moduleId: string, focusTarget?: { entityType: string; entityId: string } | null, options?: { returnTo?: string; entityLabel?: string; source?: string; returnContext?: unknown }) => void;
const VIEW_COPY: Record<DashboardView, { label: string; subtitle: string; detailTitle: string }> = {
  overview: { label: "经营总览", subtitle: "查看采购、销售与库存的核心数据", detailTitle: "待处理经营事项" },
  procurement: { label: "采购分析", subtitle: "跟踪已承诺采购支出与未结采购订单", detailTitle: "逾期采购订单" },
  sales: { label: "销售分析", subtitle: "跟踪销售订单与未履约需求", detailTitle: "风险销售订单" },
  inventory: { label: "库存分析", subtitle: "查看在手库存与存在短缺的 SKU", detailTitle: "风险库存" },
  finance: { label: "发票分析", subtitle: "查看已提交采购发票金额", detailTitle: "待处理发票" },
  suppliers: { label: "供应商分析", subtitle: "查看供应商记录与已承诺采购支出", detailTitle: "供应商绩效" },
};
// Filters the report service applies. An old link or saved view may still carry
// others (company, warehouse, risk); they are not shown as active filters.
const APPLIED_FILTER_KEYS = ["from", "to", "supplier", "customer", "currency", "status"];
const FILTER_LABELS: Record<string, string> = { from: "开始", to: "结束", company: "公司", warehouse: "仓库", supplier: "供应商", customer: "客户", category: "品类", currency: "币种", matchStatus: "匹配状态", status: "状态", risk: "风险", aging: "账龄", varianceType: "差异类型" };
// English counterparts for the filter chips; the Chinese maps above stay the zh copy.
const FILTER_LABELS_EN: Record<string, string> = { from: "From", to: "To", company: "Company", warehouse: "Warehouse", supplier: "Supplier", customer: "Customer", category: "Category", currency: "Currency", matchStatus: "Match status", status: "Status", risk: "Risk", aging: "Aging", varianceType: "Variance type" };
const FILTER_VALUE_LABELS_EN: Record<string, string> = { matched: "Matched", variance: "Variance found", pending: "Pending match", blocked: "Blocked", delivered: "Delivered", partial: "Partially delivered", open: "Open", "below-safety": "Below safety stock" };
const FILTER_VALUE_LABELS: Record<string, string> = { matched: "已匹配", variance: "存在差异", pending: "待匹配", blocked: "阻断", delivered: "已交付", partial: "部分交付", open: "未结", "below-safety": "低于安全库存" };
// Customer-facing wording; a code without a label gets the general note.
const LIMITATION_FALLBACK = "Some figures may be incomplete for this range.";
const LIMITATION_LABELS: Record<string, string> = {
  warehouse_runtime_not_connected: "Warehouse locations are not shown in this report.",
  bin_runtime_not_connected: "Storage bins are not shown in this report.",
  inventory_scoped_to_reader_warehouses: "Inventory figures cover the warehouses your role can see.",
  receipt_runtime_has_no_records: "当前范围暂无收货记录",
  invoice_runtime_has_no_records: "当前范围暂无发票记录",
  inventory_on_hand_incomplete: "部分库存数量尚未接入，相关指标可能不完整",
  inventory_units_mixed: "Inventory uses different units; quantities are shown by SKU without a combined stock total.",
  multi_currency_unconverted: "当前包含多个币种，未进行汇率折算",
  amount_missing: "Some committed documents have no amount, so their total is not shown.",
  currency_missing_or_invalid: "Some records have a missing or invalid currency code, so their amounts are not totaled.",
};

// Per-SKU incoming notes ("po_line_unit_mismatch:LDM-002") become one line
// each, naming the SKUs; every other code gets its label or the general note.
const SKU_LIMITATION_LABELS: Record<string, string> = {
  po_line_unit_mismatch: "Purchase order lines in another unit than the item's stock unit are not counted as incoming or in available to promise:",
  po_line_unit_not_recorded: "Purchase order lines with no unit, or for an item with no stock unit recorded, are counted as incoming as recorded:",
};
function reportLimitationLabels(codes: string[], copy: (label: string) => string) {
  const skus = new Map<string, string[]>();
  const labels: string[] = [];
  for (const code of codes) {
    const [prefix, ...rest] = code.split(":");
    if (SKU_LIMITATION_LABELS[prefix] && rest.length) skus.set(prefix, [...(skus.get(prefix) || []), rest.join(":")]);
    else labels.push(LIMITATION_LABELS[code] || LIMITATION_FALLBACK);
  }
  for (const [prefix, list] of skus) labels.push(`${copy(SKU_LIMITATION_LABELS[prefix])} ${list.join(", ")}`);
  return [...new Set(labels)];
}

const isStatusChart = (chart: ReportChart) => Boolean(chart.statusLabels) || chart.id.endsWith("_status");
// A saved view can show the classic charts as another basic type; the newer
// visuals keep their own form.
const SWITCHABLE = new Set(["bar", "line", "area", "stacked_bar", "horizontal_bar", "pie", "donut"]);
// Grid columns, of 12 on wide screens, for each visual; any other visual takes
// its type's width.
const SPAN: Record<string, number> = {
  overview_activity: 8, overview_status: 4, overview_suppliers: 12, overview_spend_trend: 8, overview_lifecycle: 4,
  procurement_spend_trend: 8, procurement_lifecycle: 4, procurement_supplier_pareto: 7, procurement_value_bridge: 5, procurement_spend_treemap: 7, procurement_po_status: 5, procurement_receipt_calendar: 12,
  finance_invoice_trend: 8, finance_match_rate: 4, finance_match_outcome: 4, finance_invoice_flow: 8, finance_variance_by_supplier: 6, finance_invoice_status: 6,
  sales_order_trend: 8, sales_fulfillment: 4, sales_customer_pareto: 7, sales_shipped_in_full: 5, sales_open_demand: 7, sales_order_status: 5,
  inventory_on_hand_by_sku: 6, inventory_stock_position: 6, inventory_available_to_promise: 7, inventory_stock_status: 5, inventory_risk_matrix: 12,
  supplier_performance_matrix: 7, supplier_scorecard: 5, supplier_on_time: 6, supplier_spend_treemap: 6, supplier_activity_heatmap: 12,
};
const TYPE_SPAN: Record<string, number> = { donut: 4, pie: 4, gauge: 4, funnel: 4, combo: 8, calendar: 12, heatmap: 12, sankey: 8 };
const SPAN_CLASS: Record<number, string> = { 4: "lg:col-span-4", 5: "lg:col-span-5", 6: "lg:col-span-6", 7: "lg:col-span-7", 8: "lg:col-span-8", 12: "lg:col-span-12" };

// Axis and label figures: compact numbers in the workspace locale, with the
// currency symbol when the visual has one currency.
function compactValue(value: number, unit: string, currencyCode: string | null | undefined, locale: string) {
  if (unit === "percentage") return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(value)}%`;
  const currency = unit === "currency" && currencyCode && /^[A-Z]{3}$/.test(currencyCode) ? { style: "currency" as const, currency: currencyCode } : {};
  try { return new Intl.NumberFormat(locale, { notation: "compact", maximumFractionDigits: 1, ...currency }).format(value); } catch { return new Intl.NumberFormat(locale, { notation: "compact", maximumFractionDigits: 1 }).format(value); }
}

function Sparkline({ points, color, label }: { points: number[]; color: string; label: string }) {
  const id = `spark-${useId().replace(/[^a-zA-Z0-9-]/g, "")}`;
  if (points.length < 2) return null;
  const width = 96;
  const height = 30;
  const min = Math.min(...points);
  const span = Math.max(...points) - min || 1;
  const coords = points.map((value, index) => [index / (points.length - 1) * width, height - 3 - (value - min) / span * (height - 6)]);
  const line = coords.map(([x, y], index) => `${index ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const [lastX, lastY] = coords[coords.length - 1];
  // On a narrow card the line wraps under the figure and never runs past the
  // card's edge.
  return <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={label} className="max-w-full shrink-0 overflow-visible">
    <defs><linearGradient id={id} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={color} stopOpacity={0.28} /><stop offset="100%" stopColor={color} stopOpacity={0} /></linearGradient></defs>
    <path d={`${line} L${width},${height} L0,${height} Z`} fill={`url(#${id})`} />
    <path d={line} fill="none" stroke={color} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" />
    <circle cx={lastX} cy={lastY} r={2.6} fill={color} />
  </svg>;
}

// Today in the workspace timezone, as YYYY-MM-DD.
function workspaceToday(timezone: string) {
  try { return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date()); } catch { return new Date().toISOString().slice(0, 10); }
}
function presetRange(preset: string, today: string): { from: string; to: string } | null {
  const [year, month] = today.split("-").map(Number);
  const day = (y: number, m: number) => new Date(Date.UTC(y, m - 1, 1)).toISOString().slice(0, 10);
  if (preset === "month") return { from: day(year, month), to: today };
  if (preset === "quarter") return { from: day(year, month - 2), to: today };
  if (preset === "ytd") return { from: day(year, 1), to: today };
  if (preset === "year") return { from: day(year, month - 11), to: today };
  return null;
}
const DATE_PRESETS = [["month", "This month"], ["quarter", "Last 3 months"], ["ytd", "Year to date"], ["year", "Last 12 months"], ["all", "All dates"]] as const;
// The supplier page shares its period with the supplier scorecard, which has
// no all-dates view: without dates both show the last 90 days.
const SUPPLIER_DATE_PRESETS = [...DATE_PRESETS.slice(0, 4), ["all", "Last 90 days"]] as const;

const NO_TOTAL_LIMITATIONS = ["inventory_units_mixed", "sales_demand_units_mixed", "inventory_skus_mixed", "sales_demand_skus_mixed"];
// The records each dashboard's table lists; with none in range the page shows
// one empty state instead of a row of empty charts.
const PRIMARY_SUBJECT: Record<DashboardView, string> = { overview: "purchase_orders", procurement: "purchase_orders", sales: "sales_orders", inventory: "inventory_balances", finance: "supplier_invoices", suppliers: "suppliers" };
const EMPTY_PAGE: Partial<Record<DashboardView, string>> = { procurement: "No purchase orders in this range.", sales: "No sales orders in this range.", finance: "No supplier invoices in this range.", inventory: "No inventory records yet.", suppliers: "No suppliers yet." };
// Charts that color suppliers: each supplier keeps one color across them, in
// the order of spend (the treemap) and then of the other charts. Suppliers
// past the palette are gray, as any seventh category is.
const SUPPLIER_CHARTS = ["supplier_spend_treemap", "procurement_spend_treemap", "supplier_performance_matrix", "supplier_scorecard"];
const OTHER_COLOR = "#64748b";
// Figures that are a state as of today rather than a total over the range;
// the server does not compare them with an earlier period.
const AS_OF_TODAY_METRICS = new Set(["open_po_count", "overdue_open_po_count", "open_sales_demand", "inventory_on_hand", "inventory_risk_sku", "out_of_stock_sku", "negative_atp_sku", "invoices_awaiting_match", "invoices_with_exception"]);

export function BiDashboard({ view, onNavigate: _onNavigate, afterInsights }: { view: DashboardView; onNavigate?: NavigateFn; afterInsights?: React.ReactNode }) {
  const { language, locale, timezone, formatDateTime } = useI18n();
  const copy = useCallback((label: string) => reportCopy(label, language), [language]);
  const confirmDialog = useConfirm();
  const navigate = useNavigate(); const [params, setParams] = useSearchParams();
  const [report, setReport] = useState<GovernedReport | null>(null); const [loading, setLoading] = useState(true); const [error, setError] = useState(""); const [errorCode, setErrorCode] = useState("");
  const [more, setMore] = useState(false); const [methodOpen, setMethodOpen] = useState(false); const [customOpen, setCustomOpen] = useState(false);
  const customDrawer = useRef<HTMLElement>(null);
  useDialogFocus(customOpen, customDrawer, () => setCustomOpen(false));
  // Only filters the report service applies are offered. Company, warehouse,
  // category and period comparison are not applied yet, so they are not shown.
  const runtimeOptions = useMemo(() => ({
    supplier: ["全部供应商", ...(report?.dataScope.filterOptions.suppliers || [])],
    customer: ["全部客户", ...(report?.dataScope.filterOptions.customers || [])],
    currency: ["全部币种", ...(report?.dataScope.filterOptions.currencies || [])],
  }), [report]);
  const filters = useMemo(() => Object.fromEntries(params.entries()), [params]);
  // Figures are set against the previous period of the same length unless the
  // link says comparison=none; an older link's year_over_year reads as previous.
  const comparison = params.get("comparison") === "none" ? "none" : "previous_period";
  const bounded = Boolean(report?.dataScope.from && report?.dataScope.to);
  const visibleFilterEntries = useMemo(() => [...params.entries()].filter(([key]) => APPLIED_FILTER_KEYS.includes(key)), [params]);
  // The dates show in their own inputs, so only the other filters get a chip.
  const filterChips = visibleFilterEntries.filter(([key]) => key !== "from" && key !== "to");
  const hiddenChartIds = useMemo(() => (params.get("hiddenCharts") || "").split(",").filter(Boolean), [params]);
  const chartOrderIds = useMemo(() => (params.get("chartOrder") || "").split(",").filter(Boolean), [params]);
  const orderedCharts = useMemo(() => {
    if (!report) return [];
    const order = chartOrderIds.length ? chartOrderIds : report.charts.map((item) => item.id);
    return [...report.charts].sort((a, b) => {
      const ai = order.indexOf(a.id); const bi = order.indexOf(b.id);
      return (ai < 0 ? Number.MAX_SAFE_INTEGER : ai) - (bi < 0 ? Number.MAX_SAFE_INTEGER : bi);
    });
  }, [report, chartOrderIds]);
  const selectedColumnKeys = useMemo(() => (params.get("columnOrder") || params.get("columns") || "").split(",").filter(Boolean), [params]);
  const displayedColumns = useMemo(() => {
    if (!report || !selectedColumnKeys.length) return report?.columnDefinitions || [];
    return selectedColumnKeys.map((key) => report.columnDefinitions.find((column) => column.key === key)).filter((column): column is NonNullable<typeof column> => Boolean(column));
  }, [report, selectedColumnKeys]);
  // The ID cell already shows the document number, so the table leaves the
  // number column to the export.
  // A quantity no row has (orders of several SKUs) and its unit column say
  // nothing on the page, so the table leaves them to the export as well.
  const shownRows = report?.details.slice(0, 15) || [];
  const noQuantity = shownRows.length > 0 && shownRows.every((row) => row.quantity === null || row.quantity === undefined || row.quantity === "");
  const tableColumns = displayedColumns.filter((column) => column.key !== "number" && !(noQuantity && (column.key === "quantity" || column.key === "unit"))).slice(0, 11);
  // The ID cell shows the record's number (a document number, a supplier
  // code), so it takes the number column's name; "业务编号" is only the export's
  // name for the stored id.
  const numberLabel = report?.columnDefinitions.find((column) => column.key === "number")?.label;
  const idHeader = (label: string) => numberLabel || (label === "业务编号" ? "单据号" : label);
  const limitationLabels = useMemo(() => reportLimitationLabels(report?.warnings || [], copy), [report, copy]);
  const visualization = params.get("visualization") || "dashboard";
  const renderedCharts = useMemo(() => orderedCharts.map((chart) => {
    if (!["bar", "line", "stacked_bar", "donut"].includes(visualization) || !SWITCHABLE.has(chart.type)) return chart;
    return { ...chart, type: visualization as ReportChart["type"] };
  }), [orderedCharts, visualization]);
  const supplierColors = useMemo(() => {
    const colors = new Map<string, string>();
    for (const id of SUPPLIER_CHARTS) for (const row of report?.charts.find((chart) => chart.id === id)?.data || []) {
      const name = String(row.name ?? "");
      if (name && name !== "Unspecified" && name !== "Other suppliers" && !colors.has(name) && colors.size < PALETTE.length) colors.set(name, PALETTE[colors.size]);
    }
    return colors;
  }, [report]);
  const chartContext = useMemo<ChartContext>(() => ({
    copy,
    entityColor: (name) => supplierColors.size ? supplierColors.get(name) ?? OTHER_COLOR : undefined,
    category: (chart, name) => isStatusChart(chart) ? reportStatusCopy(name, language) : copy(name),
    format: (value, unit, currencyCode) => value === null ? "—" : formatMetric(value, unit, currencyCode ?? report?.dataScope.currencyCode ?? null, { locale, language }),
    compact: (value, unit, currencyCode) => compactValue(value, unit, currencyCode ?? report?.dataScope.currencyCode ?? null, locale),
    ratio: (count, total) => language === "zh-CN" ? `${count} / ${total}` : `${count} of ${total}`,
    language,
  }), [copy, language, locale, report, supplierColors]);
  const insights = useMemo(() => report ? reportInsights(view, report, { language, format: chartContext.format, category: chartContext.category, label: copy }) : [], [report, view, language, chartContext, copy]);
  // A compared KPI's change: in points for a rate, in percent for an amount or
  // a count, signed either way.
  const kpiChange = (item: MetricDefinition) => {
    if (item.comparisonDelta === null || item.comparisonValue === null) return "";
    const sign = item.comparisonDelta > 0 ? "+" : item.comparisonDelta < 0 ? "−" : "";
    if (item.comparisonUnit === "percentage_points") return `${sign}${Math.abs(item.comparisonDelta).toFixed(1)} ${copy("pts")}`;
    if (item.comparisonRate !== null) return `${sign}${Math.abs(item.comparisonRate).toFixed(1)}%`;
    return `${sign}${chartContext.format(Math.abs(item.comparisonDelta), item.unit, item.currencyCode)}`;
  };
  const today = useMemo(() => workspaceToday(timezone), [timezone]);
  const count = useMemo(() => new Intl.NumberFormat(locale), [locale]);
  const detailTotal = report?.totalRecords ?? report?.details.length ?? 0;
  // No records of the dashboard's own kind in range (and the reader may read
  // them): one empty state in place of the charts and the table.
  const pageEmpty = Boolean(report) && view !== "overview" && detailTotal === 0 && !(report?.restrictedSubjects || []).includes(PRIMARY_SUBJECT[view]);
  const applyDates = (range: { from: string; to: string } | null) => { const next = new URLSearchParams(params); if (range) { next.set("from", range.from); next.set("to", range.to); } else { next.delete("from"); next.delete("to"); } setParams(next, { replace: true }); };
  const queryKey = params.toString();
  const load = () => { if (filters.from && filters.to && filters.from > filters.to) { setError(copy("Start date must not be after end date.")); setLoading(false); return; } setLoading(true); setError(""); fetchGovernedReport(view, { ...filters, comparison }).then(setReport).catch((reason) => { const failure = apiErrorView(reason, language, ["Something went wrong while loading this report. Try again.", "加载报表时出错，请重试。"]); setError(failure.message); setErrorCode(failure.code); }).finally(() => setLoading(false)); };
  useEffect(load, [view, queryKey]);
  const setFilter = (key: string, value: string, fallback?: string) => { const next = new URLSearchParams(params); if (!value || value === fallback || value.startsWith("全部")) next.delete(key); else next.set(key, value); setParams(next, { replace: true }); };
  // A status filter shows the status label; other filters show the value as recorded.
  const filterValueLabel = (key: string, value: string) => key === "status" ? reportStatusCopy(value, language) : (language === "en-US" ? FILTER_VALUE_LABELS_EN[value] : FILTER_VALUE_LABELS[value]) || value;
  const crossFilter = (key: string, value: string) => {
    if (key === "period" && /^\d{4}-\d{2}$/.test(value)) {
      const next = new URLSearchParams(params); const [year, month] = value.split("-").map(Number);
      next.set("from", `${value}-01`); next.set("to", new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10)); setParams(next, { replace: true });
    } else setFilter(key, value);
    toast.success(copy("Dashboard filtered"), { description: `${filterValueLabel(key, value)} · ${copy("Kept after refresh")}` });
  };
  const toggleChart = (id: string) => { const next = new URLSearchParams(params); const hidden = new Set(hiddenChartIds); if (hidden.has(id)) hidden.delete(id); else if (orderedCharts.length - hidden.size > 1) hidden.add(id); else { toast.error(copy("Keep at least one chart visible")); return; } if (hidden.size) next.set("hiddenCharts", [...hidden].join(",")); else next.delete("hiddenCharts"); setParams(next, { replace: true }); };
  const moveChart = (id: string, direction: -1 | 1) => { const current = orderedCharts.map((item) => item.id); const index = current.indexOf(id); const target = index + direction; if (index < 0 || target < 0 || target >= current.length) return; [current[index], current[target]] = [current[target], current[index]]; const next = new URLSearchParams(params); next.set("chartOrder", current.join(",")); setParams(next, { replace: true }); };
  const resetLayout = () => { const next = new URLSearchParams(params); for (const key of ["hiddenCharts", "chartOrder", "topN"]) next.delete(key); setParams(next, { replace: true }); };
  const drill = (path: string) => {
    const target = new URL(path, window.location.origin);
    for (const key of ['from', 'to', 'supplier', 'customer', 'currency', 'status', 'risk']) if (params.has(key) && !target.searchParams.has(key)) target.searchParams.set(key, params.get(key)!);
    target.searchParams.set('returnTo', '/app/reports/' + view + '?' + params);
    target.searchParams.set('returnLabel', copy(VIEW_COPY[view].label));
    navigate(target.pathname + target.search);
  };
  const saveView = async () => { const name = await confirmDialog.prompt({ title: language === "en-US" ? "Save this view" : "保存当前视图", description: language === "en-US" ? "Saves the filters and charts shown now as a private report." : "将当前的筛选和图表保存为私有报表。", field: { label: copy("Name this view"), defaultValue: `${copy(VIEW_COPY[view].label)} · ${new Date().toLocaleDateString(locale)}`, multiline: false, maxLength: 120 }, confirmLabel: language === "en-US" ? "Save view" : "保存视图" }); if (!name || !report) return; try { const result = await createSavedReportView({ name, description: copy(view === "overview" ? "See what changed. Focus on what needs attention." : VIEW_COPY[view].subtitle), subject: view === "overview" ? "purchase_orders" : view === "finance" ? "supplier_invoices" : view === "sales" ? "sales_orders" : view === "inventory" ? "inventory_balances" : view === "suppliers" ? "suppliers" : "purchase_orders", sourceRoute: `/app/reports/${view}`, columns: report.columnDefinitions.map((item) => item.key), columnOrder: report.columnDefinitions.map((item) => item.key), filters, measures: report.kpis.map((item) => item.id), visualization: "dashboard", comparison, hiddenCharts: hiddenChartIds, chartOrder: orderedCharts.map((item) => item.id), ...(report.rankings.length && params.get("topN") ? { topN: Number(params.get("topN")) } : {}), dateRange: { from: report.dataScope.from, to: report.dataScope.to }, visibility: "private" }); toast.success(copy("View saved"), { description: result.view.name }); } catch (reason) { toast.error(copy("Could not save view"), { description: reason instanceof Error ? reason.message : copy("Please try again") }); } };
  const exportCurrent = async () => {
    if (!report) return;
    try {
      const filename = await exportWorkbookSheets(copy(VIEW_COPY[view].label), reportWorkbook(report, filters, copy, limitationLabels, { locale, language }), timezone);
      toast.success(copy("Workbook exported"), { description: filename });
    } catch { toast.error(copy("Could not export workbook")); }
  };

  return <div className="space-y-3" data-testid="bi-dashboard" data-view={view}>{confirmDialog.element}
    <div className="flex flex-wrap items-start justify-between gap-3"><div><h1 className="text-xl font-semibold tracking-tight" style={{ color: A.label }}>{copy(VIEW_COPY[view].label)}</h1><p className="mt-1 text-xs" style={{ color: A.sub }}>{copy(view === "overview" ? "See what changed. Focus on what needs attention." : VIEW_COPY[view].subtitle)}</p></div><div className="flex flex-wrap gap-2"><button onClick={() => setCustomOpen(true)} className="h-8 px-3 rounded-lg text-xs font-medium" style={{ background: "#f0f6ff", color: A.blue }}><SlidersHorizontal size={13} className="inline mr-1" />{copy("调整当前视图")}</button><button onClick={() => setMethodOpen((value) => !value)} className="h-8 px-3 rounded-lg text-xs font-medium" style={{ background: A.gray6, color: A.gray1 }}><Info size={13} className="inline mr-1" />{copy("指标口径")}</button><button onClick={exportCurrent} className="h-8 px-3 rounded-lg text-xs font-medium" style={{ background: A.gray6, color: A.blue }}><Download size={13} className="inline mr-1" />{copy("导出")}</button><button onClick={saveView} className="h-8 px-3 rounded-lg text-xs font-medium text-white" style={{ background: A.blue }}><BookmarkPlus size={13} className="inline mr-1" />{copy("保存视图")}</button></div></div>
    {/* One filter row (design §13, V2): the date presets as a segmented
        control, the dates, the comparison, More filters; chips below it. */}
    <Card className="p-3" data-testid="bi-global-filters"><div className="flex flex-wrap items-center gap-2"><div className="inline-flex flex-wrap rounded-lg p-0.5" style={{ background: A.gray6 }} role="group" aria-label={copy("Date range")}>{(view === "suppliers" ? SUPPLIER_DATE_PRESETS : DATE_PRESETS).map(([preset, label]) => { const range = presetRange(preset, today); const active = range ? params.get("from") === range.from && params.get("to") === range.to : !params.get("from") && !params.get("to"); return <button key={preset} type="button" aria-pressed={active} onClick={() => applyDates(range)} className="h-7 rounded-md px-2.5 text-[11px] font-medium transition" style={active ? { background: "#ffffff", color: A.blue, boxShadow: "0 1px 2px rgba(15,23,42,0.1)" } : { color: A.gray1 }}>{copy(label)}</button>; })}</div><div className="flex items-center gap-1.5"><ReportDateInput className="h-8 w-[7.25rem]" label={copy("开始日期")} value={params.get("from") || ""} language={language} onChange={value => setFilter("from", value)} /><span aria-hidden="true" style={{ color: A.gray2 }}>–</span><ReportDateInput className="h-8 w-[7.25rem]" label={copy("结束日期")} value={params.get("to") || ""} language={language} onChange={value => setFilter("to", value)} /></div>{bounded && <label className="flex items-center gap-1.5 text-[11px] font-medium" style={{ color: A.gray1 }}>{copy("Compare with")}<select aria-label={copy("Compare with")} value={comparison} onChange={(event) => setFilter("comparison", event.target.value, "previous_period")} className="h-8 rounded-lg px-2 text-[11px]" style={{ background: A.gray6, color: A.label }}><option value="previous_period">{copy("Previous period")}</option><option value="none">{copy("No comparison")}</option></select></label>}<button onClick={() => setMore((value) => !value)} aria-expanded={more} className="h-8 px-3 rounded-lg text-xs font-medium" style={{ background: A.gray6, color: A.blue }}><SlidersHorizontal size={13} className="inline mr-1" />{copy("更多筛选")} {more ? <ChevronUp size={12} className="inline" /> : <ChevronDown size={12} className="inline" />}</button><button onClick={() => setParams({}, { replace: true })} className="ml-auto h-8 rounded-lg px-2 text-[11px] font-medium hover:bg-blue-50" style={{ color: A.blue }}><RotateCcw size={11} className="inline mr-1" />{copy("清除筛选")}</button></div>{more && <div className="mt-2 grid grid-cols-2 gap-2 md:grid-cols-3">{(["supplier", "customer", "currency"] as const).map((key) => <label key={key} className="text-[11px] font-medium" style={{ color: A.gray1 }}>{copy(({ supplier: "供应商", customer: "客户", currency: "币种" })[key])}<select aria-label={copy(({ supplier: "供应商", customer: "客户", currency: "币种" })[key])} value={params.get(key) || runtimeOptions[key][0]} onChange={(event) => setFilter(key, event.target.value)} className="mt-1 h-8 w-full rounded-lg px-2" style={{ background: A.gray6 }}>{runtimeOptions[key].map((option) => <option key={option} value={option}>{copy(option)}</option>)}</select></label>)}</div>}{filterChips.length > 0 && <div className="mt-2 flex flex-wrap items-center gap-1.5">{filterChips.map(([key, value]) => <Chip key={key} label={`${language === "en-US" ? FILTER_LABELS_EN[key] : FILTER_LABELS[key]}: ${filterValueLabel(key, value)} ×`} color={A.blue} bg="#f0f6ff" />)}</div>}</Card>
    {customOpen && <div className="fc-overlay-enter fixed inset-0 z-50 bg-slate-950/20" onMouseDown={(event) => { if (event.currentTarget === event.target) setCustomOpen(false); }}><aside ref={customDrawer} tabIndex={-1} role="dialog" aria-modal="true" aria-label={copy("调整当前视图")} className="fc-drawer-enter outline-none ml-auto h-full w-full max-w-md overflow-y-auto bg-white p-5 shadow-2xl" data-testid="dashboard-configuration"><div className="flex items-start justify-between"><div><h2 className="text-base font-semibold">{copy("调整当前视图")}</h2><p className="mt-1 text-xs" style={{ color: A.sub }}>{copy("调整图表显示与顺序；结果会保留在当前 URL。")}</p></div><button aria-label={copy("关闭调整当前视图")} onClick={() => setCustomOpen(false)} className="rounded-lg p-2 hover:bg-slate-100"><X size={16} /></button></div>{Boolean(report?.rankings.length) && <label className="mt-5 block text-xs font-medium">{copy("排行榜显示数量")}<select aria-label={copy("排行榜显示数量")} value={params.get("topN") || "10"} onChange={(event) => setFilter("topN", event.target.value, "10")} className="mt-1 h-9 w-full rounded-lg px-2" style={{ background: A.gray6 }}><option value="5">Top 5</option><option value="10">Top 10</option><option value="20">Top 20</option></select></label>}{report && <div className="mt-5 space-y-2" data-testid="chart-configuration"><div className="text-xs font-semibold">{copy("图表显示与顺序")}</div>{orderedCharts.map((chart, index) => <div key={chart.id} className="flex items-center rounded-lg p-2" style={{ background: A.gray6 }}><label className="flex flex-1 items-center gap-2 text-xs"><input type="checkbox" checked={!hiddenChartIds.includes(chart.id)} onChange={() => toggleChart(chart.id)} />{copy(chart.title)}<span className="text-slate-500">{copy(hiddenChartIds.includes(chart.id) ? "Hidden" : "Visible")}</span></label>{orderedCharts.length > 1 && <><button type="button" title={`${copy("Move up")} ${copy(chart.title)}`} aria-label={`${copy("Move up")} ${copy(chart.title)}`} disabled={index === 0} onClick={() => moveChart(chart.id, -1)} className="rounded-md p-1.5 hover:bg-white disabled:opacity-30"><ChevronUp size={14} /><span className="sr-only">{copy("上移")}</span></button><button type="button" title={`${copy("Move down")} ${copy(chart.title)}`} aria-label={`${copy("Move down")} ${copy(chart.title)}`} disabled={index === orderedCharts.length - 1} onClick={() => moveChart(chart.id, 1)} className="rounded-md p-1.5 hover:bg-white disabled:opacity-30"><ChevronDown size={14} /><span className="sr-only">{copy("下移")}</span></button></>}</div>)}<button type="button" onClick={resetLayout} className="mt-3 rounded-lg bg-slate-100 px-3 py-2 text-xs"><RotateCcw size={12} className="mr-1 inline" />{copy("恢复默认布局")}</button></div>}</aside></div>}
    {methodOpen && <Card className="p-4" data-testid="metric-definitions"><div className="flex items-center justify-between"><h2 className="text-sm font-semibold">{copy("指标口径")}</h2><span className="text-[11px]" style={{ color: A.sub }}>{copy("Current filtered scope")}</span></div><div className="mt-3 grid gap-2 md:grid-cols-2">{report?.kpis.map((item) => <div key={item.id} className="rounded-lg p-3" style={{ background: A.gray6 }}><div className="text-xs font-semibold">{copy(item.label)}</div><div className="mt-1 text-[11px] leading-5" style={{ color: A.sub }}>{copy(item.description)}<br />{copy("Calculation")}: {copy(item.calculationLabel)}<br />{copy("Record date")} · {copy("Version")}: {item.version}</div></div>)}</div></Card>}
    {loading && <div className="grid grid-cols-2 lg:grid-cols-4 gap-3" aria-label={copy("报表加载中")}>{[0, 1, 2, 3].map((item) => <Card key={item} className="h-24 animate-pulse" style={{ background: A.gray5 }}><span className="sr-only">{copy("加载指标")}{item + 1}</span></Card>)}</div>}
    {error && <Card className="p-6 text-center"><div className="text-sm font-semibold" style={{ color: A.red }}>{copy("报表加载失败")}</div><div className="mt-1 text-xs" style={{ color: A.sub }} title={errorCode || undefined}>{error}</div><button onClick={load} className="mt-3 px-3 py-2 rounded-lg text-xs" style={{ background: A.gray6, color: A.blue }}><RefreshCw size={12} className="inline mr-1" />{copy("重试")}</button></Card>}
    {error && afterInsights}
    {!loading && !error && report && <>
      <div className="flex flex-wrap items-center gap-2 text-[11px]" style={{ color: A.sub }}><span>{copy("更新于")} {formatDateTime(report.generatedAt)}</span><span>·</span><span>{copy("范围")}: {dateRangeLabel(report.dataScope.from, report.dataScope.to, copy, (day) => formatCalendarDay(day, locale))}</span><span>·</span>{report.dataScope.company ? <><span>{copy("公司")}: {copy(report.dataScope.company)}</span><span>·</span></> : null}<span>{copy("币种")}: {copy(report.dataScope.currencyLabel)}</span><span>·</span><span>{copy("来源")}: {copy(report.dataScope.sourceLabel)}</span><span>·</span><span>{copy("完整性")}: {copy(report.dataScope.completenessLabel)}</span><span>·</span><span>{report.dataScope.activeFilterCount} {copy("个业务筛选")}</span></div>
      <ReportTruncationNotice subjects={report.truncatedSubjects} language={language} locale={locale} />
      {report.dataScope.currencyAggregationStatus === "multi_currency_unconverted" && <Card className="p-3" data-testid="reports-multi-currency-status"><div className="text-sm font-semibold" style={{ color: A.orange }}>{copy("多币种，未折算")}</div><div className="mt-1 text-xs" style={{ color: A.sub }}>{copy("请选择币种查看金额汇总；当前未接入汇率，不会跨币种相加。")}</div><div className="mt-2 flex flex-wrap gap-2">{report.dataScope.currencyAmounts.map((item) => <Chip key={item.currencyCode || "unknown"} label={`${item.currencyCode || copy("Missing or invalid currency")} ${item.amount === null ? copy("数据不足") : new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(item.amount)}`} color={A.blue} bg="#f0f6ff" />)}</div></Card>}
      {/* KPI cards (design §13, V2/P4): the figure, a neutral change badge
          against the previous period and one line of context. A change is
          blue whichever way it goes: no target says which way is good. */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">{report.kpis.slice(0, 4).map((item) => { const stateLabel = metricStateLabel(item, report.dataScope); const currencyStatus = metricCurrency(item, report.dataScope).status; const multiCurrency = item.unit === "currency" && currencyStatus === "multi_currency_unconverted"; const noCurrencyData = item.unit === "currency" && currencyStatus === "no_currency_data"; const note = item.dataStatus === "restricted" ? copy("Your role cannot view this figure") : multiCurrency ? copy("多币种，未折算") : noCurrencyData ? copy("当前范围暂无金额记录") : item.dataStatus === "incomplete" ? copy(item.limitations?.includes("currency_missing_or_invalid") ? "Missing or invalid currency" : item.limitations?.includes("amount_missing") ? "Amount missing on some records" : item.limitations?.includes("insufficient_sample") ? "Needs at least 5 deliveries" : item.limitations?.includes("receipts_truncated") ? "Not every receipt could be loaded" : item.limitations?.includes("period_too_long") ? "Range longer than the scorecard allows" : item.limitations?.includes("sales_demand_units_mixed") || item.limitations?.includes("inventory_units_mixed") ? "Units differ, so there is no total" : item.limitations?.includes("sales_demand_skus_mixed") ? "See open demand by SKU" : item.limitations?.includes("inventory_skus_mixed") ? "See on hand by SKU" : item.subject === "sales_orders" ? "数据不足" : "库存数据不完整") : stateLabel && item.dataStatus === "no_records" ? copy(stateLabel) : ""; const quietNote = item.dataStatus === "no_records" || item.dataStatus === "restricted" || noCurrencyData; const change = kpiChange(item); const earlier = item.comparisonRange ? dateRangeLabel(item.comparisonRange.from, item.comparisonRange.to, copy, (day) => formatCalendarDay(day, locale)) : ""; const context = note || (change ? (language === "zh-CN" ? `上期 ${chartContext.format(item.comparisonValue, item.unit, item.currencyCode ?? report.dataScope.currencyCode)}` : `${chartContext.format(item.comparisonValue, item.unit, item.currencyCode ?? report.dataScope.currencyCode)} in the previous period`) : item.comparisonRange ? copy(item.comparisonLabel) : AS_OF_TODAY_METRICS.has(item.id) ? copy("As of today") : ""); return <button key={item.id} onClick={() => drill(item.drilldownPath)} className="group min-w-0 text-left" title={earlier ? `${copy("Previous period")}: ${earlier}` : undefined}><Card className="p-4 h-full min-w-0 transition hover:shadow-md" style={{ containerType: "inline-size" }} data-testid={`report-kpi-${item.id}`}><div className="flex items-center justify-between gap-2"><span className="text-[11px] font-medium" style={{ color: A.gray1 }}>{copy(item.label)}</span><ArrowUpRight size={14} className="shrink-0 text-slate-300 transition group-hover:text-blue-600" aria-hidden="true" /></div><div className="mt-2 flex min-w-0 flex-wrap items-end justify-between gap-2">{(() => { const shown = copy(metricDisplayValue(item, report.dataScope, { locale, language })); const noFigure = Boolean(stateLabel) || item.limitations?.some((code) => NO_TOTAL_LIMITATIONS.includes(code)); return <div className="min-w-0 max-w-full whitespace-nowrap font-semibold tabular-nums tracking-tight" style={{ color: noFigure ? A.gray2 : A.label, fontSize: "clamp(1rem, 11cqi, 1.5rem)", lineHeight: 1.25 }} title={noFigure ? shown : undefined} data-testid="report-kpi-value">{noFigure ? "—" : shown}</div>; })()}{item.trend && item.trend.length > 1 ? <Sparkline points={item.trend.map(point => point.value)} color={A.blue} label={`${copy(item.label)}: ${copy("Monthly trend")}`} /> : null}</div>{item.unit === "percentage" && item.currentValue !== null && item.dataStatus !== "no_records" ? <div className="mt-2 h-1.5 overflow-hidden rounded-full" style={{ background: A.gray5 }}><div className="h-full rounded-full" style={{ width: `${Math.max(0, Math.min(100, item.currentValue))}%`, background: A.blue }} /></div> : null}{(change || context) && <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px]">{change && <span className="rounded-full px-1.5 py-0.5 text-[11px] font-semibold tabular-nums" style={{ background: "#eff6ff", color: "#1d4ed8" }} data-testid="report-kpi-change">{change}</span>}{context && <span style={{ color: note && !quietNote ? A.orange : A.sub }}>{context}</span>}</div>}</Card></button>; })}</div>
      {report.kpis.length > 4 && <Card className="px-4 py-3"><div className="grid grid-cols-2 gap-3 md:grid-cols-4">{report.kpis.slice(4).map((item) => <button key={item.id} onClick={() => drill(item.drilldownPath)} className="text-left"><div className="text-[11px]" style={{ color: A.sub }}>{copy(item.label)}</div><div className="mt-1 text-sm font-semibold">{copy(metricDisplayValue(item, report.dataScope, { locale, language }))}</div></button>)}</div></Card>}
      {/* Key findings (design §13, V4): the most useful text is the most
          visible. Each finding is a figure, a sentence and the records behind
          it; every figure is one the page already shows. */}
      {/* A white card like the rest of the page (owner 11/11: the dark band
          read as black); each finding sits in a light tile with a blue edge,
          orange when it needs attention. */}
      {insights.length > 0 && <section className="rounded-xl border bg-white p-4" style={{ borderColor: A.border }} data-testid="report-insights"><div className="flex flex-wrap items-center gap-x-2 gap-y-1"><Sparkles size={15} className="text-blue-600" aria-hidden="true" /><h2 className="text-sm font-semibold" style={{ color: A.label }}>{copy("Key findings")}</h2><span className="text-[11px]" style={{ color: A.sub }}>{copy("Generated from the figures on this page.")}</span></div><ul className={`mt-3 grid gap-3 ${insights.length > 2 ? "sm:grid-cols-2 xl:grid-cols-4" : "sm:grid-cols-2"}`}>{insights.map(item => <li key={item.id} className="flex flex-col rounded-lg bg-slate-50 p-3" style={{ boxShadow: `inset 3px 0 0 ${item.tone === "attention" ? A.orange : A.blue}` }}>{item.figure && <div className="text-xl font-semibold tabular-nums tracking-tight" style={{ color: A.label }}>{item.figure}</div>}<p className="mt-1 flex-1 text-xs leading-5" style={{ color: A.sub }}>{item.text}</p>{item.path && <button type="button" onClick={() => drill(item.path!)} className="mt-2 self-start text-[11px] font-medium text-blue-600 hover:underline">{copy("Open the records")} →</button>}</li>)}</ul></section>}
      {afterInsights}
      {/* What needs attention sits with the findings, above the charts. */}
      {view === "overview" && report.attention?.length ? <OverviewAttention items={report.attention} copy={copy} onDrill={drill} /> : null}

      {pageEmpty ? <Card className="p-8 text-center" data-testid="report-empty-state"><div className="text-sm font-semibold" style={{ color: A.label }}>{copy(EMPTY_PAGE[view]!)}</div><div className="mt-1 text-xs" style={{ color: A.sub }}>{copy("Adjust the dates or filters, or add records, and the charts will appear here.")}</div></Card> : visualization !== "table" && (renderedCharts.some((chart) => !hiddenChartIds.includes(chart.id)) ? <div className="grid grid-cols-1 gap-3 lg:grid-flow-row-dense lg:grid-cols-12">{renderedCharts.filter((chart) => !hiddenChartIds.includes(chart.id)).map((chart) => <VisualCard key={chart.id} chart={chart} context={chartContext} className={SPAN_CLASS[SPAN[chart.id] || TYPE_SPAN[chart.type] || 6]} onDrill={drill} onCrossFilter={crossFilter} />)}</div> : <Card className="p-8 text-center"><div className="text-sm font-semibold">{copy("当前筛选没有显示图表")}</div><button onClick={() => setFilter("hiddenCharts", "")} className="mt-2 text-xs" style={{ color: A.blue }}>{copy("恢复默认图表")}</button></Card>)}
      {!pageEmpty && limitationLabels.length > 0 && <Card className="p-3" data-testid="reports-data-scope-limitations"><div className="text-xs font-semibold" style={{ color: A.gray1 }}>{copy("数据范围说明")}</div><ul className="mt-1 list-disc space-y-0.5 pl-4 text-[11px]" style={{ color: A.sub }}>{limitationLabels.map((label) => <li key={label}>{copy(label)}</li>)}</ul></Card>}
      {!pageEmpty && <Card><div className="px-4 py-3 flex items-center justify-between gap-2" style={{ borderBottom: `1px solid ${A.border}` }}><div className="min-w-0"><h2 className="text-sm font-semibold">{copy(({ overview: "Purchase order details", procurement: "Purchase order details", sales: "Sales order details", inventory: "Inventory details", finance: "Invoice details", suppliers: "Supplier details" })[view])}</h2><p className="mt-1 text-[11px]" style={{ color: A.sub }}>{analyticsSentence("detailCount", language, { shown: count.format(Math.min(report.details.length, 15)), total: count.format(detailTotal) }, detailTotal)}{view === "overview" || view === "procurement" ? ` · ${copy("All purchase orders in range, every status.")}` : ""}</p></div><button onClick={exportCurrent} className="text-xs" style={{ color: A.blue }}><Download size={12} className="inline mr-1" />{copy("导出五表工作簿")}</button></div>{report.details.length ? <div className="overflow-x-auto" ref={listTableCardsRef}><table className="w-full min-w-[880px] text-xs"><thead><tr>{tableColumns.map((column) => <th key={column.key} className={`px-4 py-2 font-medium ${column.type === "currency" || column.type === "number" ? "text-right" : "text-left"}`} style={{ color: A.gray1 }}>{copy(column.key === "id" ? idHeader(column.label) : column.label)}</th>)}</tr></thead><tbody>{report.details.slice(0, 15).map((row, index) => <tr key={String(row.id || index)} style={{ borderTop: `1px solid ${A.border}` }}>{tableColumns.map((column) => <td key={column.key} className={`px-4 py-2 whitespace-nowrap ${column.type === "currency" || column.type === "number" ? "text-right tabular-nums" : ""}`}>{column.key === "id" ? <BusinessEntityLink returnLabel={copy(VIEW_COPY[view].label)} entityType={view === "sales" ? "sales_order" : view === "inventory" ? "item" : view === "finance" ? "supplier_invoice" : view === "suppliers" ? "supplier" : "purchase_order"} entityId={String(row[column.key] || "")} number={typeof row.number === "string" ? row.number : undefined}>{String(row.number || row[column.key] || "—")}</BusinessEntityLink> : column.type === "currency" ? (row[column.key] === null || row[column.key] === undefined || row[column.key] === "" ? "—" : formatMetric(Number(row[column.key]), "currency", typeof row.currency === "string" ? row.currency : report.dataScope.currencyCode, { locale, language })) : column.key === "unit" && row[column.key] === "mixed" ? copy("Mixed units") : column.key === "unit" && row[column.key] === "multiple_skus" ? copy("Multiple SKUs") : column.key === "unit" && typeof row[column.key] === "string" && row[column.key] ? unitLabel(String(row[column.key]), language, 1) : column.key === "status" || column.key === "stockStatus" ? <StatusChip label={reportStatusCopy(String(row[column.key] ?? "—"), language)} tone={statusToneOf(String(row[column.key] ?? ""))} /> : column.type === "boolean" ? (typeof row[column.key] === "boolean" ? copy(row[column.key] ? "是" : "否") : "—") : column.type === "number" && Number.isFinite(Number(row[column.key])) && row[column.key] !== null && row[column.key] !== "" ? Number(row[column.key]).toLocaleString(locale, { maximumFractionDigits: 4 }) : column.type === "date" && typeof row[column.key] === "string" && row[column.key] ? formatCalendarDay(String(row[column.key]), locale) : String(row[column.key] ?? "—")}</td>)}</tr>)}</tbody></table></div> : <div className="p-8 text-center text-xs" style={{ color: A.sub }}>{copy("No business records in this range. Adjust the filters or add business data.")}</div>}</Card>}
    </>}
  </div>;
}
