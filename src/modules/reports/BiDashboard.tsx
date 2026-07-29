import { useEffect, useMemo, useState, type ReactNode } from "react";
import { BarChart3, BookmarkPlus, ChevronDown, ChevronUp, Download, Info, RefreshCw, RotateCcw, SlidersHorizontal, X } from "lucide-react";
import { useNavigate, useSearchParams } from "react-router";
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Legend, Line, LineChart, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { toast } from "sonner";
import { A, Card, Chip } from "../../components/ui";
import { BusinessEntityLink } from "../../components/business/BusinessEntityLink";
import { exportWorkbookSheets } from "../../lib/excel/excelWorkbookService";
import { createSavedReportView, fetchGovernedReport, type DashboardView, type GovernedReport, type MetricDefinition, type ReportChart } from "./governedReports";
import { formatMetric } from "./currencyFormatting.mjs";
export { formatMetric } from "./currencyFormatting.mjs";

type NavigateFn = (moduleId: string, focusTarget?: { entityType: string; entityId: string } | null, options?: { returnTo?: string; entityLabel?: string; source?: string; returnContext?: unknown }) => void;
const VIEW_COPY: Record<DashboardView, { label: string; subtitle: string; detailTitle: string }> = {
  overview: { label: "经营总览", subtitle: "查看销售、采购、库存、供应商和应付的核心经营状态", detailTitle: "待处理经营事项" },
  procurement: { label: "采购分析", subtitle: "识别采购支出、逾期订单、价格与供应商履约风险", detailTitle: "逾期采购订单" },
  sales: { label: "销售分析", subtitle: "跟踪销售增长、订单履约和受影响客户", detailTitle: "风险销售订单" },
  inventory: { label: "库存分析", subtitle: "识别短缺、积压、库龄与仓库库存风险", detailTitle: "风险库存" },
  finance: { label: "结算分析", subtitle: "跟踪应付、发票差异、三单匹配与结算状态", detailTitle: "待处理发票" },
  suppliers: { label: "供应商分析", subtitle: "比较采购集中度、OTIF、质量与发票差异风险", detailTitle: "供应商绩效" },
};
const COLORS = ["#2563eb", "#10b981", "#f59e0b", "#8b5cf6"];
const FILTER_LABELS: Record<string, string> = { from: "开始", to: "结束", company: "公司", warehouse: "仓库", supplier: "供应商", customer: "客户", category: "品类", currency: "币种", matchStatus: "匹配状态", status: "状态", risk: "风险", aging: "账龄", varianceType: "差异类型" };
const FILTER_VALUE_LABELS: Record<string, string> = { matched: "已匹配", variance: "存在差异", pending: "待匹配", blocked: "阻断", delivered: "已交付", partial: "部分交付", open: "进行中", "below-safety": "低于安全库存" };
const LIMITATION_LABELS: Record<string, string> = {
  warehouse_runtime_not_connected: "仓库数据尚未接入当前报表",
  bin_runtime_not_connected: "库位数据尚未接入当前报表",
  receipt_runtime_has_no_records: "当前范围暂无收货记录",
  invoice_runtime_has_no_records: "当前范围暂无发票记录",
  inventory_on_hand_incomplete: "部分库存数量尚未接入，相关指标可能不完整",
  multi_currency_unconverted: "当前包含多个币种，未进行汇率折算",
};

function metricDisplayValue(item: MetricDefinition, dataScope: GovernedReport["dataScope"]) {
  if (item.dataStatus === "no_records") return "暂无业务记录";
  if (item.unit === "currency" && dataScope.currencyAggregationStatus === "no_currency_data") return "暂无金额数据";
  if (item.unit === "currency" && dataScope.currencyAggregationStatus === "multi_currency_unconverted") return "请选择币种";
  if (item.dataStatus === "incomplete") return "数据不足";
  return formatMetric(item.currentValue, item.unit, dataScope.currencyCode);
}

function chartRows(chart: ReportChart) {
  if (chart.series?.length) {
    const periods = [...new Set(chart.series.flatMap((series) => series.data.map((row) => row.period)))];
    return periods.map((period) => Object.fromEntries([["name", period], ...chart.series.map((series) => [series.label, series.data.find((row) => row.period === period)?.value ?? null]) ]));
  }
  return (chart.data || []).map((row) => ({ ...row, name: row.name || row.period || "未分类" }));
}

function ChartPanel({ chart, currencyCode, onDrill, onCrossFilter }: { chart: ReportChart; currencyCode: string | null; onDrill: (path: string) => void; onCrossFilter: (key: string, value: string) => void }) {
  const sourceRows = chartRows(chart);
  const sourceKeys = chart.seriesKeys?.length ? chart.seriesKeys : Object.keys(sourceRows[0] || {}).filter((key) => !["name", "period", "filterValue"].includes(key));
  const rows = ["pie", "donut"].includes(chart.type) && sourceRows.length && !("value" in sourceRows[0])
    ? sourceRows.flatMap((row) => sourceKeys.map((key) => ({ name: key, value: Number(row[key] || 0), filterValue: key })))
    : sourceRows;
  const keys = ["pie", "donut"].includes(chart.type) ? ["value"] : sourceKeys;
  const colors = chart.colors?.length ? chart.colors : COLORS;
  const tooltipFormatter = (value: number, name: string) => [formatMetric(Number(value), chart.unit || "number", currencyCode), name];
  const select = (entry: any) => {
    if (!chart.crossFilter) return;
    const value = String(entry?.filterValue || entry?.payload?.filterValue || entry?.name || entry?.payload?.name || entry?.activeLabel || "");
    if (value) onCrossFilter(chart.crossFilter, value);
  };
  let visual: ReactNode;
  if (!rows.length) visual = <div className="flex h-full items-center justify-center text-xs text-center" style={{ color: A.sub }}>{chart.emptyState || "当前范围暂无真实业务记录。可以调整筛选、创建业务数据，或在本地加载演示场景。"}</div>;
  else if (chart.type === "line") visual = <LineChart data={rows} onClick={select}><CartesianGrid strokeDasharray="3 3" /><XAxis dataKey="name" tick={{ fontSize: 11 }} /><YAxis tick={{ fontSize: 11 }} /><Tooltip formatter={tooltipFormatter} /><Legend />{keys.map((key, index) => <Line key={key} name={key} type="monotone" dataKey={key} stroke={colors[index % colors.length]} strokeWidth={2} />)}</LineChart>;
  else if (chart.type === "area") visual = <AreaChart data={rows} onClick={select}><defs>{keys.map((key, index) => <linearGradient key={key} id={`${chart.id}-${index}`} x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor={colors[index % colors.length]} stopOpacity={.32}/><stop offset="95%" stopColor={colors[index % colors.length]} stopOpacity={.03}/></linearGradient>)}</defs><CartesianGrid strokeDasharray="3 3" /><XAxis dataKey="name" tick={{ fontSize: 11 }} /><YAxis tick={{ fontSize: 11 }} /><Tooltip formatter={tooltipFormatter} /><Legend />{keys.map((key, index) => <Area key={key} name={key === "value" ? chart.title : key} type="monotone" dataKey={key} stroke={colors[index % colors.length]} fill={`url(#${chart.id}-${index})`} />)}</AreaChart>;
  else if (chart.type === "pie" || chart.type === "donut") visual = <PieChart><Tooltip formatter={tooltipFormatter} /><Legend /><Pie data={rows} dataKey="value" nameKey="name" cx="50%" cy="48%" outerRadius={82} innerRadius={chart.type === "donut" ? 48 : 0} paddingAngle={2} onClick={select}>{rows.map((row, index) => <Cell key={String(row.name)} fill={colors[index % colors.length]} />)}</Pie></PieChart>;
  else {
    const vertical = chart.type === "horizontal_bar";
    visual = <BarChart data={rows} layout={vertical ? "vertical" : "horizontal"} onClick={select} margin={vertical ? { left: 28 } : undefined}><CartesianGrid strokeDasharray="3 3" /><XAxis type={vertical ? "number" : "category"} dataKey={vertical ? undefined : "name"} tick={{ fontSize: 11 }} /><YAxis type={vertical ? "category" : "number"} dataKey={vertical ? "name" : undefined} width={vertical ? 92 : undefined} tick={{ fontSize: 11 }} /><Tooltip formatter={tooltipFormatter} /><Legend />{keys.map((key, index) => <Bar key={key} name={key === "value" ? chart.title : key} dataKey={key} stackId={chart.type === "stacked_bar" ? "total" : undefined} fill={colors[index % colors.length]} radius={chart.type === "stacked_bar" ? 0 : 3} />)}</BarChart>;
  }
  return <Card className="min-w-0 p-4" data-chart-title={chart.title} data-chart-type={chart.type}><div className="flex items-center justify-between gap-3"><div><h2 className="text-sm font-semibold" style={{ color: A.label }}>{chart.title}</h2><div className="mt-0.5 text-[11px]" style={{ color: A.gray2 }}>{chart.crossFilter ? "点击图形可筛选当前看板" : "受控业务数据"}</div></div><button onClick={() => onDrill(chart.drilldownPath)} className="shrink-0 text-[11px] font-medium" style={{ color: A.blue }}>查看业务明细</button></div><div className="mt-3 h-64" tabIndex={0} aria-label={`${chart.title}，可筛选当前看板或查看业务明细`}><ResponsiveContainer width="100%" height="100%">{visual}</ResponsiveContainer></div></Card>;
}

export function BiDashboard({ view, onNavigate: _onNavigate }: { view: DashboardView; onNavigate?: NavigateFn }) {
  const navigate = useNavigate(); const [params, setParams] = useSearchParams();
  const [report, setReport] = useState<GovernedReport | null>(null); const [loading, setLoading] = useState(true); const [error, setError] = useState("");
  const [more, setMore] = useState(false); const [methodOpen, setMethodOpen] = useState(false); const [customOpen, setCustomOpen] = useState(false);
  const runtimeOptions = useMemo(() => ({
    company: ["全部公司", ...(report?.dataScope.filterOptions.companies || [])],
    warehouse: ["全部仓库", ...(report?.dataScope.filterOptions.warehouses || [])],
    supplier: ["全部供应商", ...(report?.dataScope.filterOptions.suppliers || [])],
    customer: ["全部客户", ...(report?.dataScope.filterOptions.customers || [])],
    category: ["全部品类", ...(report?.dataScope.filterOptions.categories || [])],
    currency: ["全部币种", ...(report?.dataScope.filterOptions.currencies || [])],
  }), [report]);
  const filters = useMemo(() => Object.fromEntries(params.entries()), [params]);
  const visibleFilterEntries = useMemo(() => [...params.entries()].filter(([key]) => Boolean(FILTER_LABELS[key])), [params]);
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
  const limitationLabels = useMemo(() => [...new Set((report?.warnings || []).map((code) => LIMITATION_LABELS[code] || "当前报表存在数据范围限制"))], [report]);
  const visualization = params.get("visualization") || "dashboard";
  const renderedCharts = useMemo(() => orderedCharts.map((chart) => {
    if (!["bar", "line", "stacked_bar", "donut"].includes(visualization)) return chart;
    return { ...chart, type: visualization as ReportChart["type"] };
  }), [orderedCharts, visualization]);
  const queryKey = params.toString();
  const load = () => { setLoading(true); setError(""); fetchGovernedReport(view, filters).then(setReport).catch((reason) => setError(reason instanceof Error ? reason.message : "加载失败")).finally(() => setLoading(false)); };
  useEffect(load, [view, queryKey]);
  const setFilter = (key: string, value: string, fallback?: string) => { const next = new URLSearchParams(params); if (!value || value === fallback || value.startsWith("全部")) next.delete(key); else next.set(key, value); setParams(next, { replace: true }); };
  const crossFilter = (key: string, value: string) => {
    if (key === "period" && /^\d{4}-\d{2}$/.test(value)) {
      const next = new URLSearchParams(params); const [year, month] = value.split("-").map(Number);
      next.set("from", `${value}-01`); next.set("to", new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10)); setParams(next, { replace: true });
    } else setFilter(key, value);
    toast.success("已筛选当前看板", { description: `${value} · 刷新页面后仍会保留` });
  };
  const toggleChart = (id: string) => { const next = new URLSearchParams(params); const hidden = new Set(hiddenChartIds); if (hidden.has(id)) hidden.delete(id); else if (orderedCharts.length - hidden.size > 1) hidden.add(id); else { toast.error("至少保留一个可见图表"); return; } if (hidden.size) next.set("hiddenCharts", [...hidden].join(",")); else next.delete("hiddenCharts"); setParams(next, { replace: true }); };
  const moveChart = (id: string, direction: -1 | 1) => { const current = orderedCharts.map((item) => item.id); const index = current.indexOf(id); const target = index + direction; if (index < 0 || target < 0 || target >= current.length) return; [current[index], current[target]] = [current[target], current[index]]; const next = new URLSearchParams(params); next.set("chartOrder", current.join(",")); setParams(next, { replace: true }); };
  const resetLayout = () => { const next = new URLSearchParams(params); for (const key of ["hiddenCharts", "chartOrder", "topN"]) next.delete(key); setParams(next, { replace: true }); };
  const drill = (path: string) => { const separator = path.includes("?") ? "&" : "?"; navigate(`${path}${separator}${params.toString()}&returnTo=${encodeURIComponent(`/app/reports/${view}?${params}`)}&returnLabel=${encodeURIComponent(VIEW_COPY[view].label)}`); };
  const saveView = async () => { const name = window.prompt("保存当前视图名称", `${VIEW_COPY[view].label} · ${new Date().toLocaleDateString("zh-CN")}`); if (!name || !report) return; try { const result = await createSavedReportView({ name, description: VIEW_COPY[view].subtitle, subject: view === "overview" ? "purchase_orders" : view === "finance" ? "supplier_invoices" : view === "sales" ? "sales_orders" : view === "inventory" ? "inventory_balances" : view === "suppliers" ? "suppliers" : "purchase_orders", sourceRoute: `/app/reports/${view}`, columns: report.columnDefinitions.map((item) => item.key), columnOrder: report.columnDefinitions.map((item) => item.key), filters, measures: report.kpis.map((item) => item.id), visualization: "dashboard", comparison: params.get("comparison") || "previous_period", hiddenCharts: hiddenChartIds, chartOrder: orderedCharts.map((item) => item.id), ...(report.rankings.length && params.get("topN") ? { topN: Number(params.get("topN")) } : {}), dateRange: { from: report.dataScope.from, to: report.dataScope.to }, visibility: "private" }); toast.success("视图已保存", { description: result.view.name }); } catch (reason) { toast.error("保存视图失败", { description: reason instanceof Error ? reason.message : "请重试" }); } };
  const exportCurrent = async () => {
    if (!report) return;
    const { currencyCode, currencyLabel, currencyAggregationStatus, fxConverted } = report.dataScope;
    const aggregationLabel = ({ single_currency: "单一币种", filtered_currency: "已筛选币种", multi_currency_unconverted: "多币种，未折算", no_currency_data: "无币种数据" } as const)[currencyAggregationStatus];
    const currencyMetadata = { 币种代码: currencyCode || "—", 币种显示名称: currencyLabel, 币种汇总状态: aggregationLabel, 是否已汇率折算: fxConverted ? "是" : "否" };
    const chartData = report.charts.flatMap((chart) => chartRows(chart).flatMap((row) => Object.entries(row).filter(([key]) => !["name", "period", "filterValue"].includes(key)).map(([series, value]) => ({ 图表名称: chart.title, 维度: String(row.name || "未分类"), 系列: series === "value" ? chart.title : series, 数值: value }))));
    const detailRows = report.exportRows.map((row) => ({ ...currencyMetadata, ...Object.fromEntries(report.columnDefinitions.map((column) => [column.label, row[column.key] ?? "—"])) }));
    const filename = await exportWorkbookSheets(VIEW_COPY[view].label, [
      { name: "指标摘要", rows: report.kpis.map((item) => ({ ...currencyMetadata, 指标名称: item.label, 当前值: formatMetric(item.currentValue, item.unit, currencyCode), 上期值: item.comparisonValue === null ? "未比较" : formatMetric(item.comparisonValue, item.unit, currencyCode), 变化: item.comparisonDelta === null ? "—" : formatMetric(item.comparisonDelta, item.comparisonUnit === "percentage_points" ? "number" : item.unit, currencyCode), 中文定义: item.description, 数据范围: `${report.dataScope.from} 至 ${report.dataScope.to}` })) },
      { name: "图表数据", rows: chartData.map((row) => ({ ...currencyMetadata, ...row })) }, { name: "明细数据", rows: detailRows },
      { name: "筛选条件", rows: [{ ...currencyMetadata, 开始日期: report.dataScope.from, 结束日期: report.dataScope.to, 公司: report.dataScope.company, 仓库: filters.warehouse || "全部仓库", 供应商: filters.supplier || "全部供应商", 客户: filters.customer || "全部客户", 品类: filters.category || "全部品类", 比较方式: filters.comparison === "year_over_year" ? "同比" : filters.comparison === "none" ? "不比较" : "上期" }] },
      { name: "指标口径", rows: report.kpis.map((item) => ({ 指标名称: item.label, 中文定义: item.description, 时间字段: "业务日期", 分子: item.unit === "percentage" ? "符合指标条件的业务记录" : "当前范围内符合条件的指标值", 分母: item.unit === "percentage" ? "当前范围内进入计算的业务记录" : "不适用", 指标版本: item.version, 数据限制: report.limitations.join("；") || "无", 来源对象: ({ sales_orders: "销售订单", deliveries: "发货记录", purchase_orders: "采购订单", rfqs: "询报价", receiving: "收货记录", inventory_balances: "库存余额", inventory_movements: "库存流水", supplier_invoices: "供应商发票", three_way_matches: "三单匹配", suppliers: "供应商" } as Record<string, string>)[item.subject] || "受控业务对象" })) },
    ]);
    toast.success("看板工作簿已导出", { description: filename });
  };

  return <div className="space-y-3" data-testid="bi-dashboard" data-view={view}>
    <div className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="text-xl font-semibold tracking-tight" style={{ color: A.label }}>{VIEW_COPY[view].label}</h2><p className="mt-1 text-xs" style={{ color: A.sub }}>{VIEW_COPY[view].subtitle}</p></div><div className="flex flex-wrap gap-2"><button onClick={() => setCustomOpen(true)} className="h-8 px-3 rounded-lg text-xs font-medium" style={{ background: "#f0f6ff", color: A.blue }}><SlidersHorizontal size={13} className="inline mr-1" />调整当前视图</button><button onClick={() => setMethodOpen((value) => !value)} className="h-8 px-3 rounded-lg text-xs font-medium" style={{ background: A.gray6, color: A.gray1 }}><Info size={13} className="inline mr-1" />指标口径</button><button onClick={exportCurrent} className="h-8 px-3 rounded-lg text-xs font-medium" style={{ background: A.gray6, color: A.blue }}><Download size={13} className="inline mr-1" />导出</button><button onClick={saveView} className="h-8 px-3 rounded-lg text-xs font-medium text-white" style={{ background: A.blue }}><BookmarkPlus size={13} className="inline mr-1" />保存视图</button></div></div>
    <Card className="p-3" data-testid="bi-global-filters"><div className="grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-[1fr_1fr_1fr_1fr_auto]"><label className="text-[11px] font-medium" style={{ color: A.gray1 }}>开始日期<input aria-label="开始日期" type="date" value={params.get("from") || ""} onChange={(event) => setFilter("from", event.target.value)} className="mt-1 h-8 w-full rounded-lg px-2" style={{ background: A.gray6 }} /></label><label className="text-[11px] font-medium" style={{ color: A.gray1 }}>结束日期<input aria-label="结束日期" type="date" value={params.get("to") || ""} onChange={(event) => setFilter("to", event.target.value)} className="mt-1 h-8 w-full rounded-lg px-2" style={{ background: A.gray6 }} /></label><label className="text-[11px] font-medium" style={{ color: A.gray1 }}>公司<select aria-label="公司" value={params.get("company") || runtimeOptions.company[0]} onChange={(event) => setFilter("company", event.target.value)} className="mt-1 h-8 w-full rounded-lg px-2" style={{ background: A.gray6 }}>{runtimeOptions.company.map((option) => <option key={option}>{option}</option>)}</select></label><label className="text-[11px] font-medium" style={{ color: A.gray1 }}>比较方式<select aria-label="比较方式" value={params.get("comparison") || "none"} onChange={(event) => setFilter("comparison", event.target.value, "none")} className="mt-1 h-8 w-full rounded-lg px-2" style={{ background: A.gray6 }}><option value="none">不比较</option><option value="previous_period">上期</option><option value="year_over_year">同比</option></select></label><button onClick={() => setMore((value) => !value)} className="mt-5 h-8 px-3 rounded-lg text-xs font-medium" style={{ background: A.gray6, color: A.blue }}><SlidersHorizontal size={13} className="inline mr-1" />更多筛选 {more ? <ChevronUp size={12} className="inline" /> : <ChevronDown size={12} className="inline" />}</button></div>{more && <div className="mt-2 grid grid-cols-2 gap-2 md:grid-cols-5">{(["warehouse", "supplier", "customer", "category", "currency"] as const).map((key) => <label key={key} className="text-[11px] font-medium" style={{ color: A.gray1 }}>{({ warehouse: "仓库", supplier: "供应商", customer: "客户", category: "品类", currency: "币种" })[key]}<select aria-label={({ warehouse: "仓库", supplier: "供应商", customer: "客户", category: "品类", currency: "币种" })[key]} value={params.get(key) || runtimeOptions[key][0]} onChange={(event) => setFilter(key, event.target.value)} className="mt-1 h-8 w-full rounded-lg px-2" style={{ background: A.gray6 }}>{runtimeOptions[key].map((option) => <option key={option}>{option}</option>)}</select></label>)}</div>}<div className="mt-2 flex flex-wrap items-center gap-1.5">{visibleFilterEntries.map(([key, value]) => <Chip key={key} label={`${FILTER_LABELS[key]}：${FILTER_VALUE_LABELS[value] || value} ×`} color={A.blue} bg="#f0f6ff" />)}<button onClick={() => setParams({}, { replace: true })} className="ml-auto text-[11px] font-medium" style={{ color: A.blue }}><RotateCcw size={11} className="inline mr-1" />清除筛选</button></div></Card>
    {customOpen && <div className="fixed inset-0 z-50 bg-slate-950/20" onMouseDown={(event) => { if (event.currentTarget === event.target) setCustomOpen(false); }}><aside role="dialog" aria-modal="true" aria-label="调整当前视图" className="ml-auto h-full w-full max-w-md overflow-y-auto bg-white p-5 shadow-2xl" data-testid="dashboard-configuration"><div className="flex items-start justify-between"><div><h2 className="text-base font-semibold">调整当前视图</h2><p className="mt-1 text-xs" style={{ color: A.sub }}>调整图表显示与顺序；结果会保留在当前 URL。</p></div><button aria-label="关闭调整当前视图" onClick={() => setCustomOpen(false)} className="rounded-lg p-2 hover:bg-slate-100"><X size={16} /></button></div>{Boolean(report?.rankings.length) && <label className="mt-5 block text-xs font-medium">排行榜显示数量<select aria-label="排行榜显示数量" value={params.get("topN") || "10"} onChange={(event) => setFilter("topN", event.target.value, "10")} className="mt-1 h-9 w-full rounded-lg px-2" style={{ background: A.gray6 }}><option value="5">Top 5</option><option value="10">Top 10</option><option value="20">Top 20</option></select></label>}{report && <div className="mt-5 space-y-2" data-testid="chart-configuration"><div className="text-xs font-semibold">图表显示与顺序</div>{orderedCharts.map((chart, index) => <div key={chart.id} className="flex items-center rounded-lg p-2" style={{ background: A.gray6 }}><label className="flex flex-1 items-center gap-2 text-xs"><input type="checkbox" checked={!hiddenChartIds.includes(chart.id)} onChange={() => toggleChart(chart.id)} />{chart.title}<span className="text-slate-500">{hiddenChartIds.includes(chart.id) ? "已隐藏" : "已显示"}</span></label>{orderedCharts.length > 1 && <><button type="button" title={`上移 ${chart.title}`} aria-label={`上移 ${chart.title}`} disabled={index === 0} onClick={() => moveChart(chart.id, -1)} className="p-1 disabled:opacity-30"><ChevronUp size={14} /><span className="sr-only">上移</span></button><button type="button" title={`下移 ${chart.title}`} aria-label={`下移 ${chart.title}`} disabled={index === orderedCharts.length - 1} onClick={() => moveChart(chart.id, 1)} className="p-1 disabled:opacity-30"><ChevronDown size={14} /><span className="sr-only">下移</span></button></>}</div>)}<button type="button" onClick={resetLayout} className="mt-3 rounded-lg bg-slate-100 px-3 py-2 text-xs"><RotateCcw size={12} className="mr-1 inline" />恢复默认布局</button></div>}</aside></div>}
    {methodOpen && <Card className="p-4" data-testid="metric-definitions"><div className="flex items-center justify-between"><h2 className="text-sm font-semibold">指标口径</h2><span className="text-[11px]" style={{ color: A.sub }}>版本 2.0 · 当前筛选范围</span></div><div className="mt-3 grid gap-2 md:grid-cols-2">{report?.kpis.map((item) => <div key={item.id} className="rounded-lg p-3" style={{ background: A.gray6 }}><div className="text-xs font-semibold">{item.label}</div><div className="mt-1 text-[11px] leading-5" style={{ color: A.sub }}>{item.description}<br />口径说明：{item.calculationLabel}<br />时间字段：业务日期 · 版本：{item.version}</div></div>)}</div></Card>}
    {loading && <div className="grid grid-cols-2 lg:grid-cols-4 gap-3" aria-label="报表加载中">{[0, 1, 2, 3].map((item) => <Card key={item} className="h-24 animate-pulse" style={{ background: A.gray5 }}><span className="sr-only">加载指标 {item + 1}</span></Card>)}</div>}
    {error && <Card className="p-6 text-center"><div className="text-sm font-semibold" style={{ color: A.red }}>报表加载失败</div><div className="mt-1 text-xs" style={{ color: A.sub }}>{error}</div><button onClick={load} className="mt-3 px-3 py-2 rounded-lg text-xs" style={{ background: A.gray6, color: A.blue }}><RefreshCw size={12} className="inline mr-1" />重试</button></Card>}
    {!loading && !error && report && <>
      <div className="flex flex-wrap items-center gap-2 text-[11px]" style={{ color: A.sub }}><span>更新于 {new Date(report.generatedAt).toLocaleString("zh-CN")}</span><span>·</span><span>范围：{report.dataScope.from} — {report.dataScope.to}</span><span>·</span><span>公司：{report.dataScope.company}</span><span>·</span><span>币种：{report.dataScope.currencyLabel}</span><span>·</span><span>来源：{report.dataScope.sourceLabel}</span><span>·</span><span>完整性：{report.dataScope.completenessLabel}</span><span>·</span><span>{report.dataScope.activeFilterCount} 个业务筛选</span></div>
      {report.dataScope.currencyAggregationStatus === "multi_currency_unconverted" && <Card className="p-3" data-testid="reports-multi-currency-status"><div className="text-sm font-semibold" style={{ color: A.orange }}>多币种，未折算</div><div className="mt-1 text-xs" style={{ color: A.sub }}>请选择币种查看金额汇总；当前未接入汇率，不会跨币种相加。</div><div className="mt-2 flex flex-wrap gap-2">{report.dataScope.currencyAmounts.map((item) => <Chip key={item.currencyCode} label={`${item.currencyCode} ${new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 1 }).format(item.amount)}`} color={A.blue} bg="#f0f6ff" />)}</div></Card>}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">{report.kpis.slice(0, 4).map((item) => { const multiCurrency = item.unit === "currency" && report.dataScope.currencyAggregationStatus === "multi_currency_unconverted"; const noCurrencyData = item.unit === "currency" && report.dataScope.currencyAggregationStatus === "no_currency_data"; return <button key={item.id} onClick={() => drill(item.drilldownPath)} className="text-left"><Card className="p-4 h-full hover:shadow-sm"><div className="flex items-center justify-between"><span className="text-[11px] font-medium" style={{ color: A.gray1 }}>{item.label}</span><BarChart3 size={14} color={A.blue} /></div><div className="mt-2 text-xl font-semibold tabular-nums" style={{ color: A.label }}>{metricDisplayValue(item, report.dataScope)}</div><div className="mt-1 text-[11px]" style={{ color: item.dataStatus === "incomplete" ? A.orange : item.comparisonDirection === "up" ? A.green : item.comparisonDirection === "down" ? A.red : A.sub }}>{multiCurrency ? "多币种，未折算" : noCurrencyData ? "当前范围暂无金额记录" : item.dataStatus === "incomplete" ? "库存数据不完整" : item.comparisonDelta === null ? "未启用比较" : item.comparisonUnit === "percentage_points" ? `${item.comparisonLabel} ${item.comparisonDelta >= 0 ? "+" : ""}${item.comparisonDelta.toFixed(1)} 个百分点` : item.comparisonRate === null ? `${item.comparisonLabel} 暂无基期` : `${item.comparisonLabel} ${item.comparisonRate >= 0 ? "+" : ""}${item.comparisonRate.toFixed(1)}%`} · 点击下钻</div></Card></button>; })}</div>
      {report.kpis.length > 4 && <Card className="px-4 py-3"><div className="grid grid-cols-2 gap-3 md:grid-cols-4">{report.kpis.slice(4).map((item) => <button key={item.id} onClick={() => drill(item.drilldownPath)} className="text-left"><div className="text-[11px]" style={{ color: A.sub }}>{item.label}</div><div className="mt-1 text-sm font-semibold">{metricDisplayValue(item, report.dataScope)}</div></button>)}</div></Card>}
      {limitationLabels.length > 0 && <Card className="p-3" data-testid="reports-data-scope-limitations"><div className="text-xs font-semibold" style={{ color: A.gray1 }}>数据范围说明</div><ul className="mt-1 list-disc space-y-0.5 pl-4 text-[11px]" style={{ color: A.sub }}>{limitationLabels.map((label) => <li key={label}>{label}</li>)}</ul></Card>}
      {visualization !== "table" && (renderedCharts.some((chart) => !hiddenChartIds.includes(chart.id)) ? <div className={`grid grid-cols-1 gap-3 ${view === "overview" ? "xl:grid-cols-12" : "xl:grid-cols-2"}`}>{renderedCharts.filter((chart) => !hiddenChartIds.includes(chart.id)).map((chart, index) => <div key={chart.id} className={view === "overview" ? index === 0 ? "xl:col-span-8" : index === 1 ? "xl:col-span-4" : "xl:col-span-4" : view === "finance" && (index === 0 || index === 4) ? "xl:col-span-2" : ""}><ChartPanel chart={chart} currencyCode={report.dataScope.currencyCode} onDrill={drill} onCrossFilter={crossFilter} /></div>)}</div> : <Card className="p-8 text-center"><div className="text-sm font-semibold">当前筛选没有显示图表</div><button onClick={() => setFilter("hiddenCharts", "")} className="mt-2 text-xs" style={{ color: A.blue }}>恢复默认图表</button></Card>)}
      <Card><div className="px-4 py-3 flex items-center justify-between" style={{ borderBottom: `1px solid ${A.border}` }}><div><h2 className="text-sm font-semibold">{VIEW_COPY[view].detailTitle}</h2><p className="mt-1 text-[11px]" style={{ color: A.sub }}>{report.details.length} 条筛选后明细，与 KPI、图表和导出口径一致</p></div><button onClick={exportCurrent} className="text-xs" style={{ color: A.blue }}><Download size={12} className="inline mr-1" />导出五表工作簿</button></div>{report.details.length ? <div className="overflow-x-auto"><table className="w-full min-w-[880px] text-xs"><thead><tr>{displayedColumns.slice(0, 11).map((column) => <th key={column.key} className="px-4 py-2 text-left" style={{ color: A.gray1 }}>{column.label}</th>)}</tr></thead><tbody>{report.details.slice(0, 15).map((row, index) => <tr key={String(row.id || index)} style={{ borderTop: `1px solid ${A.border}` }}>{displayedColumns.slice(0, 11).map((column) => <td key={column.key} className="px-4 py-2 whitespace-nowrap">{column.key === "id" ? <BusinessEntityLink entityType={view === "sales" ? "sales_order" : view === "inventory" ? "item" : view === "finance" ? "supplier_invoice" : "purchase_order"} entityId={String(row[column.key] || "")}>{String(row[column.key] || "—")}</BusinessEntityLink> : column.type === "currency" ? formatMetric(Number(row[column.key] || 0), "currency", typeof row.currency === "string" ? row.currency : report.dataScope.currencyCode) : String(row[column.key] ?? "—")}</td>)}</tr>)}</tbody></table></div> : <div className="p-8 text-center text-xs" style={{ color: A.sub }}>当前范围暂无真实业务记录。可以调整筛选、创建业务数据，或在本地加载演示场景。</div>}</Card>
    </>}
  </div>;
}
