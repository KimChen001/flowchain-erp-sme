import type { DashboardView, GovernedReport, MetricDefinition, ReportChart } from "./governedReports";

// Plain-language findings from the figures already on a dashboard: the same
// KPIs, comparisons and visuals, restated as sentences. Nothing is computed
// here that the page does not show, and no figure is judged against an assumed
// target. Each finding carries its headline figure and the link to the records
// behind it (design §13, V4).
export type Insight = { id: string; tone: "neutral" | "attention" | "positive"; text: string; figure?: string; path?: string };

type Format = (value: number | null, unit: string, currencyCode?: string | null) => string;
type InsightOptions = { language: string; format: Format; category: (chart: ReportChart, name: string) => string; label?: (text: string) => string };

const num = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : null;
const chartById = (report: GovernedReport, id: string) => report.charts.find(chart => chart.id === id && (chart.data || []).length);
const kpiById = (report: GovernedReport, id: string) => report.kpis.find(item => item.id === id && item.dataStatus !== "no_records" && item.currentValue !== null);
const plural = (count: number, one: string, many: string) => count === 1 ? one : many;

function concentration(chart: ReportChart, zh: boolean, format: Format, subject: "supplier" | "customer"): Insight | null {
  const rows = chart.data || [];
  const top = rows[0];
  const share = num(top?.["Cumulative share"]);
  if (!top || share === null || !top.filterValue) return null;
  const leaders = rows.filter((_, index) => index === 0 || (num(rows[index - 1]?.["Cumulative share"]) ?? 100) < 80).length;
  const name = String(top.name);
  const money = chart.unit === "currency";
  const link = { figure: format(share, "percentage"), path: chart.drilldownPath };
  if (subject === "customer") {
    return { id: chart.id, tone: "neutral", ...link, text: zh ? `${name} 占${money ? "销售订单金额" : "销售订单数"}的 ${format(share, "percentage")}。` : `${name} accounts for ${format(share, "percentage")} of sales order ${money ? "value" : "count"}.` };
  }
  if (!money) return { id: chart.id, tone: "neutral", ...link, text: zh ? `${name} 占已承诺采购订单数的 ${format(share, "percentage")}。` : `${name} has ${format(share, "percentage")} of committed purchase orders.` };
  return { id: chart.id, tone: "neutral", ...link, text: zh
    ? `${name} 占已承诺采购额的 ${format(share, "percentage")}；${rows.length} 家供应商中有 ${leaders} 家贡献了约 80% 的采购额。`
    : `${name} accounts for ${format(share, "percentage")} of committed spend; ${leaders} of ${rows.length} ${plural(rows.length, "supplier", "suppliers")} make up about 80% of it.` };
}

// Each lifecycle stage counts the committed orders that reached it, whatever
// happened at the others, so every stage is read by its name.
function lifecycle(chart: ReportChart, zh: boolean, format: Format): Insight | null {
  const stage = (name: string) => num((chart.data || []).find(row => row.name === name)?.value) ?? 0;
  const committed = stage("Committed");
  if (!committed) return null;
  const started = stage("Receiving started"), full = stage("Fully received"), invoiced = stage("Invoiced"), matched = stage("Invoice matched");
  const share = format(started / committed * 100, "percentage");
  return { id: chart.id, tone: "neutral", figure: share, path: chart.drilldownPath, text: zh
    ? `已承诺采购订单中 ${share} 已开始收货，${full} 张已全部收货；${invoiced} 张已有采购发票，${matched} 张发票已匹配。`
    : `Receiving has started on ${share} of committed purchase orders and ${full} ${plural(full, "is", "are")} fully received; ${invoiced} ${plural(invoiced, "has", "have")} a supplier invoice and ${matched} a matched invoice.` };
}

// The highest and lowest on-time share among suppliers, saying when several
// tie. The ranking keeps its first rows only; when it left some out (total),
// its last bar is not the lowest, so only the highest is named.
function onTimeSpread(chart: ReportChart, zh: boolean, format: Format): Insight | null {
  const ranking = chart.data || [];
  if (ranking.length < 2) return null;
  const top = num(ranking[0].value), bottom = num(ranking[ranking.length - 1].value);
  // When every supplier has the same share there is no highest or lowest.
  if (top === null || bottom === null || top === bottom) return null;
  const whole = !chart.total || chart.total <= ranking.length;
  const atTop = ranking.filter(row => num(row.value) === top);
  const atBottom = ranking.filter(row => num(row.value) === bottom);
  // Every bar shown ties at the top and more were left out: the count is unknown.
  if (!whole && atTop.length === ranking.length) return null;
  const high = format(top, "percentage"), low = format(bottom, "percentage");
  const highest = atTop.length === 1
    ? zh ? `${atTop[0].name} 的准时交付占比最高（${high}）` : `${atTop[0].name} has the highest share of deliveries on time (${high})`
    : zh ? `${atTop.length} 家供应商并列准时交付占比最高（${high}）` : `${atTop.length} suppliers tie for the highest share of deliveries on time (${high})`;
  const lowest = !whole ? "" : atBottom.length === 1
    ? zh ? `${atBottom[0].name} 最低（${low}）` : `${atBottom[0].name} the lowest (${low})`
    : zh ? `${atBottom.length} 家并列最低（${low}）` : `${atBottom.length} suppliers tie for the lowest (${low})`;
  return { id: "spread", tone: "neutral", figure: high, path: chart.drilldownPath, text: zh ? `${highest}${lowest ? `，${lowest}` : ""}。` : `${highest}${lowest ? `; ${lowest}` : ""}.` };
}

// What changed: the first compared KPI, in the words of its change badge.
function change(item: MetricDefinition, zh: boolean, format: Format, label: (text: string) => string, currencyCode: string | null): Insight | null {
  if (item.comparisonDelta === null || item.comparisonValue === null || item.currentValue === null) return null;
  const name = label(item.label);
  const now = format(item.currentValue, item.unit, item.currencyCode ?? currencyCode);
  const before = format(item.comparisonValue, item.unit, item.currencyCode ?? currencyCode);
  const points = item.comparisonUnit === "percentage_points";
  const size = points ? `${Math.abs(item.comparisonDelta).toFixed(1)} ${zh ? "个百分点" : plural(Math.abs(item.comparisonDelta), "point", "points")}` : item.comparisonRate === null ? format(Math.abs(item.comparisonDelta), item.unit, item.currencyCode ?? currencyCode) : `${Math.abs(item.comparisonRate).toFixed(1)}%`;
  const sign = item.comparisonDelta > 0 ? "+" : item.comparisonDelta < 0 ? "−" : "";
  const text = item.comparisonDelta === 0
    ? zh ? `${name}与上期持平：${now}。` : `${name} is unchanged from the previous period: ${now}.`
    : zh ? `${name}较上期${item.comparisonDelta > 0 ? "增加" : "减少"} ${size}：本期 ${now}，上期 ${before}。` : `${name} ${item.comparisonDelta > 0 ? "rose" : "fell"} ${size} against the previous period: ${now}, against ${before}.`;
  return { id: `change_${item.id}`, tone: "neutral", figure: `${sign}${size}`, path: item.drilldownPath, text };
}

export function reportInsights(view: DashboardView, report: GovernedReport, { language, format, category, label = text => text }: InsightOptions): Insight[] {
  const zh = language === "zh-CN";
  const insights: Array<Insight | null> = [];
  const overdue = kpiById(report, "overdue_open_po_count");
  const onTime = kpiById(report, "on_time_receipt_rate");
  // Sales figures over only the latest orders read (the server could not read
  // its totals over every order) are no ground for a finding about shares or
  // changes: the orders left out could change them.
  const salesCut = (report.truncatedSubjects || []).some(entry => entry.subject === "sales_orders" && !entry.figuresComplete);
  // The largest change against the previous period leads; an unchanged figure
  // is no finding.
  const size = (item: MetricDefinition) => Math.abs(item.comparisonUnit === "percentage_points" ? item.comparisonDelta ?? 0 : item.comparisonRate ?? 0);
  const compared = report.kpis.filter(item => item.comparisonDelta !== null && item.comparisonValue !== null && item.comparisonDelta !== 0 && !(salesCut && item.subject === "sales_orders")).sort((a, b) => size(b) - size(a))[0];
  if (compared) insights.push(change(compared, zh, format, label, report.dataScope.currencyCode));

  if (view === "overview") {
    const trend = chartById(report, "overview_spend_trend");
    // The last whole month: the month to date, or a month the range cuts,
    // would read as a fall.
    const partial = new Set((trend?.partialPeriods || []).map(item => item.period));
    const last = trend?.data?.filter(row => row.name !== "Undated" && !partial.has(String(row.name))).at(-1);
    if (trend && last && trend.unit === "currency") {
      const amount = num(last["Committed amount"]);
      const count = num(last["Purchase orders"]) ?? 0;
      if (amount !== null) insights.push({ id: "overview_last_month", tone: "neutral", figure: format(amount, "currency", trend.currencyCode), path: trend.drilldownPath, text: zh ? `${last.name}：已承诺采购额 ${format(amount, "currency", trend.currencyCode)}，共 ${count} 张采购订单。` : `${last.name}: ${format(amount, "currency", trend.currencyCode)} committed across ${count} purchase ${plural(count, "order", "orders")}.` });
    }
    const flow = chartById(report, "overview_lifecycle");
    if (flow) insights.push(lifecycle(flow, zh, format));
  }

  if (view === "procurement") {
    const pareto = chartById(report, "procurement_supplier_pareto");
    if (pareto) insights.push(concentration(pareto, zh, format, "supplier"));
    const flow = chartById(report, "procurement_lifecycle");
    if (flow) insights.push(lifecycle(flow, zh, format));
  }

  if (view === "procurement" || view === "suppliers") {
    if (onTime) insights.push({ id: "on_time", tone: "neutral", figure: format(onTime.currentValue, "percentage"), path: onTime.drilldownPath, text: zh ? `按采购订单日期计，当前范围内 ${format(onTime.currentValue, "percentage")} 的交付每一行都准时到货。` : `${format(onTime.currentValue, "percentage")} of deliveries first promised in range arrived on time on every line, measured against the date on the PO.` });
  }

  if (view === "procurement" && overdue) {
    const count = overdue.currentValue ?? 0;
    insights.push(count
      ? { id: "overdue", tone: "attention", figure: String(count), path: overdue.drilldownPath, text: zh ? `${count} 张未结采购订单有未收货行已过承诺交期。` : `${count} open purchase ${plural(count, "order has", "orders have")} a line past its promised date.` }
      : { id: "overdue", tone: "positive", text: zh ? "没有未收货行已过承诺交期的未结采购订单。" : "No open purchase order has a line past its promised date." });
  }

  if (view === "finance") {
    const gauge = chartById(report, "finance_match_rate");
    if (gauge?.detail) {
      const { exception = 0, pending = 0 } = gauge.detail;
      const rate = format(num(gauge.data?.[0]?.value), "percentage");
      insights.push({ id: "match", tone: exception ? "attention" : "neutral", figure: rate, path: gauge.drilldownPath, text: zh
        ? `已提交发票中 ${rate} 通过三单匹配，${exception} 张存在异常，${pending} 张待匹配。`
        : `${rate} of submitted invoices passed three-way match; ${exception} ${plural(exception, "has an exception", "have an exception")} and ${pending} ${plural(pending, "is", "are")} awaiting match.` });
    }
    const variance = chartById(report, "finance_variance_by_supplier");
    const top = variance?.data?.[0];
    if (variance && top) insights.push({ id: "variance", tone: "attention", figure: format(num(top.value), "currency", variance.currencyCode), path: variance.drilldownPath, text: zh ? `${top.name} 的发票差异最大，为 ${format(num(top.value), "currency", variance.currencyCode)}。` : `${top.name} has the largest invoice variance, ${format(num(top.value), "currency", variance.currencyCode)}.` });
  }

  if (view === "sales") {
    const pareto = chartById(report, "sales_customer_pareto");
    if (pareto && !salesCut) insights.push(concentration(pareto, zh, format, "customer"));
    const shipped = kpiById(report, "order_fulfillment_rate");
    if (shipped) insights.push({ id: "shipped", tone: "neutral", figure: format(shipped.currentValue, "percentage"), path: shipped.drilldownPath, text: zh ? `${format(shipped.currentValue, "percentage")} 的已确认销售订单已全部发货。` : `${format(shipped.currentValue, "percentage")} of confirmed sales orders have shipped in full.` });
    // Demand in different units cannot be compared, so "most" needs one unit.
    const demandChart = chartById(report, "sales_open_demand");
    const demandUnit = demandChart?.units?.length === 1 ? demandChart.units[0] : "";
    const demand = demandUnit ? demandChart?.data?.[0] : undefined;
    if (demandChart && demand) insights.push({ id: "demand", tone: "neutral", figure: format(num(demand.value), "number"), path: demandChart.drilldownPath, text: zh ? `${demand.name} 的未履约需求最多：${format(num(demand.value), "number")} ${demandUnit}。` : `${demand.name} has the most open demand: ${format(num(demand.value), "number")} ${demandUnit}.` });
  }

  if (view === "inventory") {
    const out = kpiById(report, "out_of_stock_sku");
    if (out && out.currentValue) insights.push({ id: "out", tone: "attention", figure: String(out.currentValue), path: out.drilldownPath, text: zh ? `${out.currentValue} 个 SKU 已缺货。` : `${out.currentValue} ${plural(out.currentValue, "SKU is", "SKUs are")} out of stock.` });
    const atpChart = chartById(report, "inventory_available_to_promise");
    const atp = atpChart?.data?.[0];
    const short = num(atp?.value);
    if (atpChart && atp && short !== null && short < 0) insights.push({ id: "atp", tone: "attention", figure: format(-short, "number"), path: atpChart.drilldownPath, text: zh ? `${atp.name} 计入在途采购后仍短缺 ${format(-short, "number")}。` : `${atp.name} is short by ${format(-short, "number")} even after incoming purchase orders.` });
    const risk = kpiById(report, "inventory_risk_sku");
    if (risk && !risk.currentValue) insights.push({ id: "risk", tone: "positive", text: zh ? "当前没有存在短缺的 SKU。" : "No SKU has a shortage against open demand." });
  }

  if (view === "suppliers") {
    const onTimeChart = chartById(report, "supplier_on_time");
    if (onTimeChart) insights.push(onTimeSpread(onTimeChart, zh, format));
    const matrix = chartById(report, "supplier_performance_matrix");
    if (matrix?.guides && matrix.guides.x !== null && matrix.guides.y !== null) {
      const xKey = matrix.measures?.find(item => item.axis === "x")?.key || "";
      const watch = (matrix.data || []).filter(row => (num(row[xKey]) ?? 0) >= matrix.guides!.x! && (num(row["On-time deliveries"]) ?? 100) < matrix.guides!.y!).map(row => category(matrix, String(row.name)));
      if (watch.length) insights.push({ id: "watch", tone: "attention", figure: String(watch.length), path: matrix.drilldownPath, text: zh ? `${watch.join("、")} 的${xKey === "Committed amount" ? "采购额" : "订单数"}不低于中位数，但准时交付占比低于平均值。` : `${watch.join(", ")} ${plural(watch.length, "combines", "combine")} at least median ${xKey === "Committed amount" ? "spend" : "order count"} with a below-average share of deliveries on time.` });
    }
  }

  return insights.filter((item): item is Insight => Boolean(item)).slice(0, 4);
}
