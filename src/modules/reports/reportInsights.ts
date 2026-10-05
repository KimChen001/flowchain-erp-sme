import type { DashboardView, GovernedReport, ReportChart } from "./governedReports";

// Plain-language findings from the figures already on a dashboard: the same
// KPIs and visuals, restated as sentences. Nothing is computed here that the
// page does not show, and no figure is judged against an assumed target.
export type Insight = { id: string; tone: "neutral" | "attention" | "positive"; text: string };

type Format = (value: number | null, unit: string, currencyCode?: string | null) => string;
type InsightOptions = { language: string; format: Format; category: (chart: ReportChart, name: string) => string };

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
  if (subject === "customer") {
    return { id: chart.id, tone: "neutral", text: zh ? `${name} 占${money ? "销售订单金额" : "销售订单数"}的 ${format(share, "percentage")}。` : `${name} accounts for ${format(share, "percentage")} of sales order ${money ? "value" : "count"}.` };
  }
  if (!money) return { id: chart.id, tone: "neutral", text: zh ? `${name} 占已承诺采购订单数的 ${format(share, "percentage")}。` : `${name} has ${format(share, "percentage")} of committed purchase orders.` };
  return { id: chart.id, tone: "neutral", text: zh
    ? `${name} 占已承诺采购额的 ${format(share, "percentage")}；${rows.length} 家供应商中有 ${leaders} 家贡献了约 80% 的采购额。`
    : `${name} accounts for ${format(share, "percentage")} of committed spend; ${leaders} of ${rows.length} ${plural(rows.length, "supplier", "suppliers")} make up about 80% of it.` };
}

function lifecycle(chart: ReportChart, zh: boolean, format: Format): Insight | null {
  const [committed, , fully, , matched] = (chart.data || []).map(row => num(row.value) ?? 0);
  if (!committed) return null;
  return { id: chart.id, tone: "neutral", text: zh
    ? `已承诺采购订单中 ${format(fully / committed * 100, "percentage")} 已全部收货，其中 ${matched} 张的发票已匹配。`
    : `${format(fully / committed * 100, "percentage")} of committed purchase orders are fully received, and ${matched} of them have a matched invoice.` };
}

export function reportInsights(view: DashboardView, report: GovernedReport, { language, format, category }: InsightOptions): Insight[] {
  const zh = language === "zh-CN";
  const insights: Array<Insight | null> = [];
  const overdue = kpiById(report, "overdue_open_po_count");
  const onTime = kpiById(report, "on_time_receipt_rate");

  if (view === "overview") {
    const trend = chartById(report, "overview_spend_trend");
    const last = trend?.data?.filter(row => row.name !== "Undated").at(-1);
    if (trend && last && trend.unit === "currency") {
      const amount = num(last["Committed amount"]);
      const count = num(last["Purchase orders"]) ?? 0;
      if (amount !== null) insights.push({ id: "overview_last_month", tone: "neutral", text: zh ? `${last.name}：已承诺采购额 ${format(amount, "currency", trend.currencyCode)}，共 ${count} 张采购订单。` : `${last.name}: ${format(amount, "currency", trend.currencyCode)} committed across ${count} purchase ${plural(count, "order", "orders")}.` });
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
    if (onTime) insights.push({ id: "on_time", tone: "neutral", text: zh ? `当前范围内 ${format(onTime.currentValue, "percentage")} 的收货在预计日期当天或之前到达。` : `${format(onTime.currentValue, "percentage")} of receipts in range arrived on or before the expected date.` });
  }

  if (view === "procurement" && overdue) {
    const count = overdue.currentValue ?? 0;
    insights.push(count
      ? { id: "overdue", tone: "attention", text: zh ? `${count} 张未完成采购订单已超过预计日期。` : `${count} open purchase ${plural(count, "order is", "orders are")} past the expected date.` }
      : { id: "overdue", tone: "positive", text: zh ? "没有超过预计日期的未完成采购订单。" : "No open purchase order is past its expected date." });
  }

  if (view === "finance") {
    const gauge = chartById(report, "finance_match_rate");
    if (gauge?.detail) {
      const { exception = 0, pending = 0 } = gauge.detail;
      insights.push({ id: "match", tone: exception ? "attention" : "neutral", text: zh
        ? `已提交发票中 ${format(num(gauge.data?.[0]?.value), "percentage")} 通过三单匹配，${exception} 张存在异常，${pending} 张待匹配。`
        : `${format(num(gauge.data?.[0]?.value), "percentage")} of submitted invoices passed three-way match; ${exception} ${plural(exception, "has an exception", "have an exception")} and ${pending} ${plural(pending, "is", "are")} awaiting match.` });
    }
    const variance = chartById(report, "finance_variance_by_supplier");
    const top = variance?.data?.[0];
    if (variance && top) insights.push({ id: "variance", tone: "attention", text: zh ? `${top.name} 的发票差异最大，为 ${format(num(top.value), "currency", variance.currencyCode)}。` : `${top.name} has the largest invoice variance, ${format(num(top.value), "currency", variance.currencyCode)}.` });
  }

  if (view === "sales") {
    const pareto = chartById(report, "sales_customer_pareto");
    if (pareto) insights.push(concentration(pareto, zh, format, "customer"));
    const shipped = kpiById(report, "order_fulfillment_rate");
    if (shipped) insights.push({ id: "shipped", tone: "neutral", text: zh ? `${format(shipped.currentValue, "percentage")} 的已确认销售订单已全部发货。` : `${format(shipped.currentValue, "percentage")} of confirmed sales orders have shipped in full.` });
    // Demand in different units cannot be compared, so "most" needs one unit.
    const demandChart = chartById(report, "sales_open_demand");
    const demandUnit = demandChart?.units?.length === 1 ? demandChart.units[0] : "";
    const demand = demandUnit ? demandChart?.data?.[0] : undefined;
    if (demand) insights.push({ id: "demand", tone: "neutral", text: zh ? `${demand.name} 的未履约需求最多：${format(num(demand.value), "number")} ${demandUnit}。` : `${demand.name} has the most open demand: ${format(num(demand.value), "number")} ${demandUnit}.` });
  }

  if (view === "inventory") {
    const out = kpiById(report, "out_of_stock_sku");
    if (out && out.currentValue) insights.push({ id: "out", tone: "attention", text: zh ? `${out.currentValue} 个 SKU 已缺货。` : `${out.currentValue} ${plural(out.currentValue, "SKU is", "SKUs are")} out of stock.` });
    const atp = chartById(report, "inventory_available_to_promise")?.data?.[0];
    const short = num(atp?.value);
    if (atp && short !== null && short < 0) insights.push({ id: "atp", tone: "attention", text: zh ? `${atp.name} 相对未履约需求短缺 ${format(-short, "number")}。` : `${atp.name} is short by ${format(-short, "number")} against open demand.` });
    const risk = kpiById(report, "inventory_risk_sku");
    if (risk && !risk.currentValue) insights.push({ id: "risk", tone: "positive", text: zh ? "当前没有存在短缺的 SKU。" : "No SKU has a shortage against open demand." });
  }

  if (view === "suppliers") {
    const ranking = chartById(report, "supplier_on_time")?.data || [];
    if (ranking.length > 1) {
      const best = ranking[0];
      const worst = ranking[ranking.length - 1];
      insights.push({ id: "spread", tone: "neutral", text: zh ? `${best.name} 的准时收货率最高（${format(num(best.value), "percentage")}），${worst.name} 最低（${format(num(worst.value), "percentage")}）。` : `${best.name} has the best on-time receipts (${format(num(best.value), "percentage")}); ${worst.name} has the lowest (${format(num(worst.value), "percentage")}).` });
    }
    const matrix = chartById(report, "supplier_performance_matrix");
    if (matrix?.guides && matrix.guides.x !== null && matrix.guides.y !== null) {
      const xKey = matrix.measures?.find(item => item.axis === "x")?.key || "";
      const watch = (matrix.data || []).filter(row => (num(row[xKey]) ?? 0) >= matrix.guides!.x! && (num(row["On-time receipts"]) ?? 100) < matrix.guides!.y!).map(row => category(matrix, String(row.name)));
      if (watch.length) insights.push({ id: "watch", tone: "attention", text: zh ? `${watch.join("、")} 的${xKey === "Committed amount" ? "采购额" : "订单数"}不低于中位数，但准时收货率低于平均值。` : `${watch.join(", ")} ${plural(watch.length, "combines", "combine")} at least median ${xKey === "Committed amount" ? "spend" : "order count"} with below-average on-time receipts.` });
    }
  }

  return insights.filter((item): item is Insight => Boolean(item)).slice(0, 4);
}
