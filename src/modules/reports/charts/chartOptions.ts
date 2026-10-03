import type { EChartsCoreOption } from "echarts/core";
import type { ReportChart, ReportMeasure } from "../governedReports";

// ECharts options for each report visual type. Business names (suppliers,
// customers, SKUs, months) are shown as recorded; status codes, stage names
// and measure names are interface copy and go through the context's labels.

export type ChartContext = {
  copy: (value: string) => string;
  category: (chart: ReportChart, name: string) => string;
  format: (value: number | null, unit: string, currencyCode?: string | null) => string;
  compact: (value: number, unit: string, currencyCode?: string | null) => string;
  ratio: (count: number, total: number) => string;
  language: string;
  large?: boolean;
};

type Row = Record<string, unknown> & { name?: unknown; filterValue?: unknown };
type TooltipParam = { marker?: string; seriesName?: string; name?: string; value?: unknown; data?: unknown; dataIndex: number; percent?: number; seriesIndex?: number; treePathInfo?: Array<{ name: string }> };

export const PALETTE = ["#2563eb", "#0d9488", "#f59e0b", "#8b5cf6", "#ec4899", "#0ea5e9", "#65a30d", "#ea580c", "#64748b", "#dc2626", "#14b8a6", "#a855f7"];
const INK = "#0f172a";
const SUB = "#64748b";
const GRID_LINE = "#eef2f7";
const AXIS_LINE = "#e2e8f0";

// Colors that carry meaning: green is done or healthy, red is a problem, amber
// is waiting. Anything else takes the palette.
const SEMANTIC: Record<string, string> = {
  draft: "#94a3b8", pending_approval: "#f59e0b", approved: "#0ea5e9", issued: "#2563eb", partially_received: "#8b5cf6",
  fully_received: "#16a34a", received: "#16a34a", closed: "#64748b", cancelled: "#cbd5e1", canceled: "#cbd5e1", rejected: "#dc2626",
  submitted: "#0ea5e9", matching: "#6366f1", exception: "#dc2626", matched: "#16a34a", held: "#f59e0b",
  confirmed: "#2563eb", shortage_risk: "#dc2626", fulfilled: "#16a34a", partially_fulfilled: "#8b5cf6", ready_to_ship: "#0ea5e9",
  out_of_stock: "#dc2626", below_safety_stock: "#f97316", below_reorder_point: "#f59e0b", ok: "#16a34a", unknown: "#94a3b8",
  high: "#dc2626", medium: "#f59e0b", low: "#16a34a",
  Matched: "#16a34a", "Match exception": "#dc2626", "Awaiting match": "#f59e0b",
};
const FUNNEL = ["#312e81", "#3730a3", "#4338ca", "#0f766e", "#15803d"];

const alpha = (hex: string, opacity: number) => `${hex}${Math.round(opacity * 255).toString(16).padStart(2, "0")}`;
const vertical = (color: string, from = 1, to = 0.6) => ({ type: "linear", x: 0, y: 0, x2: 0, y2: 1, colorStops: [{ offset: 0, color: alpha(color, from) }, { offset: 1, color: alpha(color, to) }] });
const horizontal = (color: string) => ({ type: "linear", x: 0, y: 0, x2: 1, y2: 0, colorStops: [{ offset: 0, color: alpha(color, 0.7) }, { offset: 1, color }] });
const rowsOf = (chart: ReportChart) => (chart.data || []) as Row[];
const num = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : value === null || value === undefined || value === "" || value === "-" ? null : Number.isFinite(Number(value)) ? Number(value) : null;
const filterValueOf = (row: Row) => String(row.filterValue ?? row.name ?? "");
const colorFor = (name: string, index: number, palette = PALETTE) => SEMANTIC[name] || palette[index % palette.length];
const escape = (value: unknown) => String(value ?? "").replace(/[&<>"]/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" })[char] || char);

function keysOf(chart: ReportChart, rows: Row[]) {
  if (chart.seriesKeys?.length) return chart.seriesKeys;
  return [...new Set(rows.flatMap(row => Object.keys(row)).filter(key => !["name", "period", "filterValue"].includes(key)))];
}

function tooltip(extra: Record<string, unknown> = {}) {
  return { confine: true, backgroundColor: "rgba(15,23,42,0.94)", borderWidth: 0, padding: [8, 12], textStyle: { color: "#f8fafc", fontSize: 12 }, extraCssText: "border-radius:10px;box-shadow:0 10px 30px rgba(15,23,42,.22);", ...extra };
}

function axisLabel(ctx: ChartContext, extra: Record<string, unknown> = {}) {
  return { color: SUB, fontSize: ctx.large ? 12 : 11, hideOverlap: true, ...extra };
}

function legend(ctx: ChartContext, extra: Record<string, unknown> = {}) {
  return { type: "scroll", top: 0, left: 0, icon: "roundRect", itemWidth: 10, itemHeight: 10, itemGap: 14, textStyle: { color: SUB, fontSize: ctx.large ? 12 : 11 }, pageIconSize: 10, ...extra };
}

// The chart container is labelled with the visual's title and the card's
// "Show data" table lists its values, so ECharts' generated description is off.
function base(chart: ReportChart): Record<string, unknown> {
  return { color: chart.colors?.length ? chart.colors : PALETTE, animationDuration: 650, animationEasing: "cubicOut", textStyle: { fontFamily: "inherit" }, aria: { enabled: false } };
}

const grid = (extra: Record<string, unknown> = {}) => ({ left: 12, right: 16, top: 36, bottom: 4, outerBoundsMode: "same", ...extra });

function valueAxis(ctx: ChartContext, unit: string, currencyCode: string | null | undefined, extra: Record<string, unknown> = {}) {
  return { type: "value", axisLine: { show: false }, axisTick: { show: false }, splitLine: { lineStyle: { color: GRID_LINE } }, axisLabel: axisLabel(ctx, { formatter: (value: number) => ctx.compact(value, unit, currencyCode) }), ...extra };
}

function categoryAxis(ctx: ChartContext, names: string[], extra: Record<string, unknown> = {}) {
  return { type: "category", data: names, axisLine: { lineStyle: { color: AXIS_LINE } }, axisTick: { show: false }, axisLabel: axisLabel(ctx, { width: 120, overflow: "truncate" }), ...extra };
}

function cartesian(chart: ReportChart, ctx: ChartContext): EChartsCoreOption {
  const rows = rowsOf(chart);
  const keys = keysOf(chart, rows);
  const sideways = chart.type === "horizontal_bar" || chart.orientation === "horizontal";
  const stacked = chart.type === "stacked_bar" || Boolean(chart.stack);
  const line = chart.type === "line" || chart.type === "area";
  const unit = chart.unit || "number";
  const palette = chart.colors?.length ? chart.colors : PALETTE;
  const single = keys.length === 1;
  const series = keys.map((key, index) => {
    const color = palette[index % palette.length];
    return {
      name: key === "value" ? ctx.copy(chart.title) : ctx.copy(key),
      type: line ? "line" : "bar",
      ...(stacked ? { stack: "total" } : {}),
      ...(line ? { smooth: 0.35, symbol: "circle", symbolSize: 7, showSymbol: rows.length <= 24, lineStyle: { width: 2.5, color }, itemStyle: { color, borderColor: "#fff", borderWidth: 2 } } : { barMaxWidth: sideways ? 18 : 36, itemStyle: { color: sideways ? horizontal(color) : vertical(color), borderRadius: stacked ? 0 : sideways ? [0, 5, 5, 0] : [5, 5, 0, 0] } }),
      ...(chart.type === "area" ? { areaStyle: { color: vertical(color, 0.3, 0.02) } } : {}),
      emphasis: { focus: "series" },
      ...(single && !line && rows.length <= 16 ? { label: { show: true, position: sideways ? "right" : "top", color: SUB, fontSize: ctx.large ? 12 : 10, formatter: (param: TooltipParam) => ctx.compact(num((param.data as Row)?.value) ?? 0, unit, chart.currencyCode) } } : {}),
      data: rows.map(row => {
        const value = num(row[key]);
        return { value, filterValue: filterValueOf(row), ...(single && value !== null && value < 0 ? { itemStyle: { color: sideways ? horizontal("#dc2626") : vertical("#dc2626"), borderRadius: sideways ? [5, 0, 0, 5] : [0, 0, 5, 5] } } : {}) };
      }),
    };
  });
  const names = rows.map(row => ctx.category(chart, String(row.name ?? "")));
  const categories = categoryAxis(ctx, names, sideways ? { inverse: true, axisLabel: axisLabel(ctx, { width: 130, overflow: "truncate", interval: 0 }) } : {});
  const values = valueAxis(ctx, unit, chart.currencyCode);
  return {
    ...base(chart),
    legend: keys.length > 1 ? legend(ctx) : { show: false },
    tooltip: tooltip({ trigger: "axis", axisPointer: { type: line ? "line" : "shadow", shadowStyle: { color: "rgba(37,99,235,0.06)" }, lineStyle: { color: AXIS_LINE } }, valueFormatter: (value: unknown) => ctx.format(num(value), unit, chart.currencyCode) }),
    grid: grid({ top: keys.length > 1 ? 36 : 12, right: sideways ? 56 : 16 }),
    xAxis: sideways ? values : categories,
    yAxis: sideways ? categories : values,
    series,
  };
}

function axisIndexOf(measure: ReportMeasure) { return measure.axis === 1 ? 1 : 0; }

function combo(chart: ReportChart, ctx: ChartContext): EChartsCoreOption {
  const rows = rowsOf(chart);
  const measures = chart.measures?.length ? chart.measures : keysOf(chart, rows).map(key => ({ key, kind: "bar", unit: chart.unit || "number", axis: 0 } as ReportMeasure));
  const axes = [0, 1].filter(axis => measures.some(measure => axisIndexOf(measure) === axis));
  const yAxis = axes.map((axis, index) => {
    const measure = measures.find(item => axisIndexOf(item) === axis)!;
    return valueAxis(ctx, measure.unit, chart.currencyCode, index ? { splitLine: { show: false } } : {});
  });
  const series = measures.map((measure, index) => {
    const color = PALETTE[index % PALETTE.length];
    const data = rows.map(row => ({ value: num(row[measure.key]), filterValue: filterValueOf(row) }));
    const yAxisIndex = Math.max(0, axes.indexOf(axisIndexOf(measure)));
    const name = ctx.copy(measure.label || measure.key);
    return measure.kind === "line"
      ? { name, type: "line", yAxisIndex, smooth: 0.35, symbol: "circle", symbolSize: 8, lineStyle: { width: 3, color: "#f59e0b" }, itemStyle: { color: "#f59e0b", borderColor: "#fff", borderWidth: 2 }, z: 3, data }
      : { name, type: "bar", yAxisIndex, barMaxWidth: 38, itemStyle: { color: vertical(color, 1, 0.55), borderRadius: [6, 6, 0, 0] }, emphasis: { focus: "series" }, data };
  });
  return {
    ...base(chart),
    legend: legend(ctx),
    tooltip: tooltip({ trigger: "axis", axisPointer: { type: "shadow", shadowStyle: { color: "rgba(37,99,235,0.06)" } }, formatter: (params: TooltipParam[]) => {
      const list = Array.isArray(params) ? params : [params];
      return [`<b>${escape(list[0]?.name)}</b>`, ...list.map(param => `${param.marker}${escape(param.seriesName)}&nbsp;&nbsp;<b>${escape(ctx.format(num((param.data as Row)?.value), measures[param.seriesIndex ?? 0]?.unit || "number", chart.currencyCode))}</b>`)].join("<br/>");
    } }),
    grid: grid(),
    xAxis: categoryAxis(ctx, rows.map(row => ctx.category(chart, String(row.name ?? "")))),
    yAxis,
    series,
  };
}

// Bars sorted by contribution, colored by ABC class from the running share of
// the bars before each one, and the running share as a line.
function pareto(chart: ReportChart, ctx: ChartContext): EChartsCoreOption {
  const rows = rowsOf(chart);
  const unit = chart.unit || "number";
  const classes = rows.map((row, index) => {
    if (!row.filterValue && index === rows.length - 1 && rows.length > 12) return "other";
    const before = index ? num(rows[index - 1]["Cumulative share"]) ?? 0 : 0;
    return before < 80 ? "A" : before < 95 ? "B" : "C";
  });
  const classColor: Record<string, string> = { A: "#2563eb", B: "#0ea5e9", C: "#94a3b8", other: "#cbd5e1" };
  const barMeasure = chart.measures?.find(item => item.key === "value");
  return {
    ...base(chart),
    legend: legend(ctx, { data: [ctx.copy(barMeasure?.label || chart.title), ctx.copy("Cumulative share")] }),
    tooltip: tooltip({ trigger: "axis", axisPointer: { type: "shadow", shadowStyle: { color: "rgba(37,99,235,0.06)" } }, formatter: (params: TooltipParam[]) => {
      const index = params[0]?.dataIndex ?? 0;
      const row = rows[index];
      const group = classes[index] === "other" ? "" : ` · ${ctx.copy(`Class ${classes[index]}`)}`;
      return `<b>${escape(ctx.category(chart, String(row?.name ?? "")))}</b>${escape(group)}<br/>${escape(ctx.copy(barMeasure?.label || chart.title))}&nbsp;&nbsp;<b>${escape(ctx.format(num(row?.value), unit, chart.currencyCode))}</b><br/>${escape(ctx.copy("Cumulative share"))}&nbsp;&nbsp;<b>${escape(ctx.format(num(row?.["Cumulative share"]), "percentage"))}</b>`;
    } }),
    grid: grid({ left: rows.length > 6 ? 36 : 12 }),
    xAxis: categoryAxis(ctx, rows.map(row => ctx.category(chart, String(row.name ?? ""))), { axisLabel: axisLabel(ctx, { width: 76, overflow: "truncate", rotate: rows.length > 6 ? 28 : 0, interval: 0 }) }),
    yAxis: [valueAxis(ctx, unit, chart.currencyCode), valueAxis(ctx, "percentage", null, { min: 0, max: 100, splitLine: { show: false }, axisLabel: axisLabel(ctx, { formatter: (value: number) => `${value}%` }) })],
    series: [
      { name: ctx.copy(barMeasure?.label || chart.title), type: "bar", barMaxWidth: 38, data: rows.map((row, index) => ({ value: num(row.value), filterValue: String(row.filterValue ?? ""), itemStyle: { color: vertical(classColor[classes[index]], 1, 0.65), borderRadius: [6, 6, 0, 0] } })), emphasis: { focus: "series" } },
      { name: ctx.copy("Cumulative share"), type: "line", yAxisIndex: 1, smooth: 0.25, symbol: "circle", symbolSize: 7, lineStyle: { width: 2.5, color: "#f59e0b" }, itemStyle: { color: "#f59e0b", borderColor: "#fff", borderWidth: 2 }, z: 3, data: rows.map(row => num(row["Cumulative share"])),
        markLine: { silent: true, symbol: "none", lineStyle: { color: "#f59e0b", type: "dashed", width: 1 }, label: { color: "#b45309", fontSize: 10, formatter: "80%", position: "insideEndTop" }, data: [{ yAxis: 80 }] } },
    ],
  };
}

function pie(chart: ReportChart, ctx: ChartContext): EChartsCoreOption {
  const rows = rowsOf(chart);
  const unit = chart.unit || "number";
  const total = rows.reduce((sum, row) => sum + (num(row.value) ?? 0), 0);
  const donut = chart.type === "donut";
  return {
    ...base(chart),
    tooltip: tooltip({ trigger: "item", formatter: (param: TooltipParam) => `${param.marker}${escape(param.name)}<br/><b>${escape(ctx.format(num(param.value), unit, chart.currencyCode))}</b>&nbsp;·&nbsp;${param.percent ?? 0}%` }),
    legend: legend(ctx, { top: "auto", bottom: 0, left: "center", textStyle: { color: SUB, fontSize: ctx.large ? 12 : 11, width: 120, overflow: "truncate" } }),
    ...(donut ? { title: { text: ctx.compact(total, unit, chart.currencyCode), subtext: ctx.copy("Total"), left: "center", top: "middle", itemGap: 2, textStyle: { fontSize: ctx.large ? 26 : 20, fontWeight: 650, color: INK }, subtextStyle: { fontSize: 11, color: SUB } } } : {}),
    series: [{
      type: "pie", radius: donut ? ["44%", "64%"] : ["0%", "64%"], center: ["50%", "50%"], padAngle: donut ? 2 : 0, avoidLabelOverlap: true,
      itemStyle: { borderRadius: donut ? 6 : 2, borderColor: "#fff", borderWidth: 2 }, label: { show: false }, labelLine: { show: false },
      emphasis: { scale: true, scaleSize: 6 },
      data: rows.map((row, index) => ({ name: ctx.category(chart, String(row.name ?? "")), value: num(row.value), filterValue: filterValueOf(row), itemStyle: { color: colorFor(String(row.name ?? ""), index, chart.colors?.length ? chart.colors : PALETTE) } })),
    }],
  };
}

function funnel(chart: ReportChart, ctx: ChartContext): EChartsCoreOption {
  const rows = rowsOf(chart);
  const first = num(rows[0]?.value) || 0;
  return {
    ...base(chart),
    tooltip: tooltip({ trigger: "item", formatter: (param: TooltipParam) => {
      const index = param.dataIndex;
      const value = num(param.value) ?? 0;
      const previous = index ? num(rows[index - 1]?.value) ?? 0 : value;
      return `<b>${escape(param.name)}</b>&nbsp;&nbsp;${escape(ctx.format(value, "number"))}<br/>${escape(ctx.copy("Share of first stage"))}&nbsp;&nbsp;<b>${escape(ctx.format(first ? value / first * 100 : null, "percentage"))}</b>${index ? `<br/>${escape(ctx.copy("From previous stage"))}&nbsp;&nbsp;<b>${escape(ctx.format(previous ? value / previous * 100 : null, "percentage"))}</b>` : ""}`;
    } }),
    series: [{
      type: "funnel", sort: "none", left: "2%", width: "52%", top: 6, bottom: 6, minSize: "18%", maxSize: "100%", gap: 4, funnelAlign: "center",
      label: { show: true, position: "right", color: INK, fontSize: ctx.large ? 13 : 11, formatter: (param: TooltipParam) => `{name|${String(param.name ?? "").replace(/[{}|]/g, "")}}\n{value|${ctx.format(num(param.value), "number")}${param.dataIndex && first ? `  ·  ${Math.round((num(param.value) ?? 0) / first * 100)}%` : ""}}`, rich: { name: { color: SUB, fontSize: ctx.large ? 12 : 11, lineHeight: 16 }, value: { color: INK, fontSize: ctx.large ? 15 : 13, fontWeight: 600, lineHeight: 18 } } },
      labelLine: { show: true, length: 10, lineStyle: { color: AXIS_LINE } }, itemStyle: { borderColor: "#fff", borderWidth: 1 },
      emphasis: { label: { fontWeight: 700 } },
      data: rows.map((row, index) => ({ name: ctx.category(chart, String(row.name ?? "")), value: num(row.value), itemStyle: { color: FUNNEL[index % FUNNEL.length] } })),
    }],
  };
}

// A stacked bar with an invisible base: totals rise from zero, steps float
// from the running total, decreases in orange and increases in green.
function waterfall(chart: ReportChart, ctx: ChartContext): EChartsCoreOption {
  const rows = rowsOf(chart);
  const totals = new Set(chart.totals || []);
  const unit = chart.unit || "number";
  const lift: Array<number | string> = [], total: Array<number | string> = [], up: Array<number | string> = [], down: Array<number | string> = [];
  let running = 0;
  for (const row of rows) {
    const value = num(row.value) ?? 0;
    if (totals.has(String(row.name))) { lift.push(0); total.push(value); up.push("-"); down.push("-"); running = value; }
    else if (value >= 0) { lift.push(running); up.push(value); total.push("-"); down.push("-"); running += value; }
    else { running += value; lift.push(running); down.push(-value); total.push("-"); up.push("-"); }
  }
  const label = (sign: string) => ({ show: true, position: "top", color: SUB, fontSize: ctx.large ? 12 : 10, formatter: (param: TooltipParam) => `${sign}${ctx.compact(num(param.value) ?? 0, unit, chart.currencyCode)}` });
  return {
    ...base(chart),
    legend: legend(ctx, { data: [ctx.copy("Total"), ctx.copy("Decrease"), ctx.copy("Increase")] }),
    tooltip: tooltip({ trigger: "axis", axisPointer: { type: "shadow", shadowStyle: { color: "rgba(37,99,235,0.06)" } }, formatter: (params: TooltipParam[]) => {
      const row = rows[params[0]?.dataIndex ?? 0];
      return `<b>${escape(ctx.category(chart, String(row?.name ?? "")))}</b><br/>${escape(ctx.format(num(row?.value), unit, chart.currencyCode))}`;
    } }),
    grid: grid(),
    xAxis: categoryAxis(ctx, rows.map(row => ctx.category(chart, String(row.name ?? ""))), { axisLabel: axisLabel(ctx, { width: 90, overflow: "break", interval: 0 }) }),
    yAxis: valueAxis(ctx, unit, chart.currencyCode),
    series: [
      { name: "lift", type: "bar", stack: "bridge", silent: true, itemStyle: { color: "transparent" }, emphasis: { disabled: true }, tooltip: { show: false }, data: lift },
      { name: ctx.copy("Total"), type: "bar", stack: "bridge", barMaxWidth: 52, itemStyle: { color: vertical("#2563eb", 1, 0.7), borderRadius: [6, 6, 0, 0] }, label: label(""), data: total },
      { name: ctx.copy("Decrease"), type: "bar", stack: "bridge", barMaxWidth: 52, itemStyle: { color: vertical("#f97316", 0.95, 0.7), borderRadius: 4 }, label: label("−"), data: down },
      { name: ctx.copy("Increase"), type: "bar", stack: "bridge", barMaxWidth: 52, itemStyle: { color: vertical("#16a34a", 0.95, 0.7), borderRadius: 4 }, label: label("+"), data: up },
    ],
  };
}

function treemap(chart: ReportChart, ctx: ChartContext): EChartsCoreOption {
  const rows = rowsOf(chart);
  const unit = chart.unit || "number";
  const total = rows.reduce((sum, row) => sum + (num(row.value) ?? 0), 0);
  return {
    ...base(chart),
    tooltip: tooltip({ trigger: "item", formatter: (param: TooltipParam) => {
      const path = (param.treePathInfo || []).slice(1).map(node => escape(node.name)).join(" › ");
      const value = num(param.value) ?? 0;
      return `<b>${path}</b><br/>${escape(ctx.format(value, unit, chart.currencyCode))}${(param.treePathInfo || []).length === 2 && total ? `&nbsp;·&nbsp;${escape(ctx.format(value / total * 100, "percentage"))}` : ""}`;
    } }),
    series: [{
      name: ctx.copy("All suppliers"), type: "treemap", roam: false, nodeClick: "zoomToNode", leafDepth: 1, top: 4, left: 4, right: 4, bottom: 30,
      breadcrumb: { show: true, left: "center", bottom: 2, height: 20, itemStyle: { color: "#f1f5f9", borderColor: "#e2e8f0", textStyle: { color: SUB, fontSize: 11 } }, emphasis: { itemStyle: { color: "#e2e8f0" } } },
      label: { show: true, formatter: (param: TooltipParam) => `{name|${String(param.name ?? "").replace(/[{}|]/g, "")}}\n{value|${ctx.compact(num(param.value) ?? 0, unit, chart.currencyCode)}}`, rich: { name: { fontSize: ctx.large ? 14 : 12, fontWeight: 600, color: "#fff" }, value: { fontSize: ctx.large ? 13 : 11, color: "rgba(255,255,255,0.86)", padding: [4, 0, 0, 0] } } },
      upperLabel: { show: false },
      itemStyle: { borderColor: "#fff", borderWidth: 2, gapWidth: 2, borderRadius: 6 },
      levels: [{ itemStyle: { borderWidth: 0, gapWidth: 3 } }, { colorSaturation: [0.35, 0.55], itemStyle: { gapWidth: 2, borderRadius: 4 } }],
      data: rows.map((row, index) => ({ name: ctx.category(chart, String(row.name ?? "")), value: num(row.value), filterValue: filterValueOf(row), itemStyle: { color: PALETTE[index % PALETTE.length] }, children: (chart.breakdown?.[String(row.name)] || []).map(item => ({ name: ctx.category(chart, item.name), value: item.value })) })),
    }],
  };
}

function gauge(chart: ReportChart, ctx: ChartContext): EChartsCoreOption {
  const row = rowsOf(chart)[0];
  const value = num(row?.value);
  const caption = chart.detail ? ctx.ratio(chart.detail.count, chart.detail.total) : "";
  return {
    ...base(chart),
    tooltip: { show: false },
    series: [{
      type: "gauge", startAngle: 210, endAngle: -30, min: 0, max: 100, radius: "96%", center: ["50%", "58%"],
      progress: { show: true, roundCap: true, width: ctx.large ? 22 : 16, itemStyle: { color: { type: "linear", x: 0, y: 0, x2: 1, y2: 0, colorStops: [{ offset: 0, color: "#0ea5e9" }, { offset: 1, color: "#2563eb" }] } } },
      axisLine: { roundCap: true, lineStyle: { width: ctx.large ? 22 : 16, color: [[1, GRID_LINE]] } },
      pointer: { show: false }, axisTick: { show: false }, splitLine: { show: false }, axisLabel: { show: false }, anchor: { show: false },
      title: { show: true, offsetCenter: [0, "34%"], color: SUB, fontSize: ctx.large ? 14 : 12 },
      detail: { valueAnimation: true, offsetCenter: [0, "-4%"], fontSize: ctx.large ? 40 : 30, fontWeight: 700, color: INK, formatter: (amount: number) => ctx.format(amount, "percentage") },
      data: [{ value: value ?? 0, name: caption }],
    }],
  };
}

function heatmap(chart: ReportChart, ctx: ChartContext): EChartsCoreOption {
  const rows = rowsOf(chart);
  const columns = chart.seriesKeys || [];
  const values = rows.flatMap(row => columns.map(key => num(row[key]) ?? 0));
  const max = Math.max(1, ...values);
  const columnLabel = (key: string) => chart.statusLabels ? ctx.category(chart, key) : key;
  return {
    ...base(chart),
    tooltip: tooltip({ trigger: "item", formatter: (param: TooltipParam) => {
      const [x, y, value] = (param.data as { value: [number, number, number] }).value;
      return `<b>${escape(ctx.category(chart, String(rows[y]?.name ?? "")))}</b> · ${escape(columnLabel(columns[x]))}<br/>${escape(ctx.format(value, chart.unit || "number"))}`;
    } }),
    grid: grid({ top: 8, bottom: 44 }),
    xAxis: categoryAxis(ctx, columns.map(columnLabel), { splitArea: { show: false }, axisLine: { show: false }, axisLabel: axisLabel(ctx, { interval: 0 }) }),
    yAxis: categoryAxis(ctx, rows.map(row => ctx.category(chart, String(row.name ?? ""))), { inverse: true, axisLine: { show: false }, axisLabel: axisLabel(ctx, { width: 130, overflow: "truncate", interval: 0 }) }),
    visualMap: { min: 0, max, calculable: false, orient: "horizontal", left: "center", bottom: 0, itemWidth: 10, itemHeight: 140, text: [ctx.copy("More"), ctx.copy("Less")], textStyle: { color: SUB, fontSize: 10 }, inRange: { color: ["#eff6ff", "#93c5fd", "#2563eb", "#1e3a8a"] } },
    series: [{
      type: "heatmap",
      itemStyle: { borderColor: "#fff", borderWidth: 3, borderRadius: 5 },
      emphasis: { itemStyle: { shadowBlur: 10, shadowColor: "rgba(15,23,42,0.25)" } },
      data: rows.flatMap((row, y) => columns.map((key, x) => {
        const value = num(row[key]) ?? 0;
        return { value: [x, y, value], filterValue: String(row.filterValue ?? ""), label: { show: true, color: value > max * 0.55 ? "#fff" : INK, fontSize: ctx.large ? 12 : 11, formatter: () => value ? ctx.compact(value, chart.unit || "number") : "" } };
      })),
    }],
  };
}

// A day grid in the style of a contribution calendar, at most a year wide.
function calendar(chart: ReportChart, ctx: ChartContext): EChartsCoreOption {
  const rows = rowsOf(chart);
  const [from, to] = chart.range || ["", ""];
  const end = to || String(rows.at(-1)?.name || "");
  const yearBefore = end ? new Date(Date.parse(`${end}T00:00:00Z`) - 364 * 86400000).toISOString().slice(0, 10) : "";
  const start = from && from > yearBefore ? from : yearBefore;
  const max = Math.max(1, ...rows.map(row => num(row.value) ?? 0));
  const zh = ctx.language === "zh-CN";
  return {
    ...base(chart),
    tooltip: tooltip({ trigger: "item", formatter: (param: TooltipParam) => {
      const [day, value] = param.value as [string, number];
      return `<b>${escape(day)}</b><br/>${escape(ctx.copy("Receipts"))}&nbsp;&nbsp;<b>${escape(ctx.format(value, "number"))}</b>`;
    } }),
    visualMap: { min: 0, max, show: true, orient: "horizontal", right: 4, bottom: 0, itemWidth: 10, itemHeight: 90, text: [ctx.copy("More"), ctx.copy("Less")], textStyle: { color: SUB, fontSize: 10 }, inRange: { color: ["#dcfce7", "#86efac", "#22c55e", "#15803d"] } },
    calendar: {
      range: [start, end], top: 26, left: 34, right: 8, bottom: 30, cellSize: ["auto", ctx.large ? 22 : 18], orient: "horizontal",
      splitLine: { show: false }, itemStyle: { color: "#f8fafc", borderColor: "#fff", borderWidth: 3 },
      yearLabel: { show: false },
      dayLabel: { firstDay: zh ? 1 : 0, nameMap: zh ? "ZH" : "EN", color: SUB, fontSize: 10 },
      monthLabel: { nameMap: zh ? "ZH" : "EN", color: SUB, fontSize: 11 },
    },
    series: [{ type: "heatmap", coordinateSystem: "calendar", itemStyle: { borderRadius: 3 }, data: rows.map(row => [String(row.name), num(row.value) ?? 0]) }],
  };
}

function sankey(chart: ReportChart, ctx: ChartContext): EChartsCoreOption {
  const links = chart.links || [];
  const sources = [...new Set(links.map(link => link.source))];
  const targets = [...new Set(links.map(link => link.target))];
  const label = (name: string) => targets.includes(name) ? ctx.copy(name) : name;
  return {
    ...base(chart),
    tooltip: tooltip({ trigger: "item", formatter: (param: TooltipParam & { dataType?: string }) => {
      const data = param.data as { source?: string; target?: string; value?: number; name?: string };
      return param.dataType === "edge" ? `${escape(data.source)} → ${escape(data.target)}<br/><b>${escape(ctx.format(num(data.value), "number"))}</b>` : `<b>${escape(param.name)}</b><br/>${escape(ctx.format(num(param.value), "number"))}`;
    } }),
    series: [{
      type: "sankey", left: 4, right: 128, top: 8, bottom: 8, nodeWidth: 14, nodeGap: 10, nodeAlign: "justify", draggable: false,
      emphasis: { focus: "adjacency" }, lineStyle: { color: "gradient", curveness: 0.5, opacity: 0.32 }, label: { color: INK, fontSize: ctx.large ? 13 : 11 },
      itemStyle: { borderWidth: 0, borderRadius: 3 },
      data: [...sources.map((name, index) => ({ name, itemStyle: { color: PALETTE[index % PALETTE.length] } })), ...targets.map((name, index) => ({ name: label(name), itemStyle: { color: SEMANTIC[name] || PALETTE[(sources.length + index) % PALETTE.length] } }))],
      links: links.map(link => ({ source: link.source, target: label(link.target), value: link.value })),
    }],
  };
}

function scatter(chart: ReportChart, ctx: ChartContext): EChartsCoreOption {
  const rows = rowsOf(chart);
  const measures = chart.measures || [];
  const x = measures.find(item => item.axis === "x");
  const y = measures.find(item => item.axis === "y");
  const size = measures.find(item => item.axis === "size");
  if (!x || !y) return {};
  const largest = Math.max(1, ...rows.map(row => num(row[size?.key || ""]) ?? 1));
  const guides = [
    ...(chart.guides?.x !== null && chart.guides?.x !== undefined ? [{ xAxis: chart.guides.x, label: { formatter: ctx.copy("Median"), position: "end", color: SUB, fontSize: 10 } }] : []),
    ...(chart.guides?.y !== null && chart.guides?.y !== undefined ? [{ yAxis: chart.guides.y, label: { formatter: ctx.copy("Average"), position: "insideEndTop", color: SUB, fontSize: 10 } }] : []),
  ];
  return {
    ...base(chart),
    tooltip: tooltip({ trigger: "item", formatter: (param: TooltipParam) => {
      const row = rows[param.dataIndex];
      return `<b>${escape(row?.name)}</b><br/>${escape(ctx.copy(x.key))}&nbsp;&nbsp;<b>${escape(ctx.format(num(row?.[x.key]), x.unit, chart.currencyCode))}</b><br/>${escape(ctx.copy(y.key))}&nbsp;&nbsp;<b>${escape(ctx.format(num(row?.[y.key]), y.unit))}</b>${size ? `<br/>${escape(ctx.copy(size.key))}&nbsp;&nbsp;<b>${escape(ctx.format(num(row?.[size.key]), size.unit))}</b>` : ""}`;
    } }),
    grid: grid({ top: 30, bottom: 30, left: 12, right: 24 }),
    xAxis: valueAxis(ctx, x.unit, chart.currencyCode, { name: ctx.copy(x.key), nameLocation: "middle", nameGap: 26, nameTextStyle: { color: SUB, fontSize: 11 }, scale: true }),
    yAxis: valueAxis(ctx, "percentage", null, { name: ctx.copy(y.key), nameLocation: "middle", nameGap: 40, nameTextStyle: { color: SUB, fontSize: 11 }, min: 0, max: 100, axisLabel: axisLabel(ctx, { formatter: (value: number) => `${value}%` }) }),
    series: [{
      type: "scatter",
      symbolSize: (value: number[]) => 12 + Math.sqrt((value[2] ?? 1) / largest) * (ctx.large ? 40 : 30),
      label: { show: true, position: "top", color: SUB, fontSize: ctx.large ? 12 : 10, formatter: (param: TooltipParam) => String(param.name ?? "") },
      labelLayout: { hideOverlap: true, moveOverlap: "shiftY" },
      itemStyle: { opacity: 0.85, borderColor: "#fff", borderWidth: 1.5, shadowBlur: 6, shadowColor: "rgba(15,23,42,0.15)" },
      emphasis: { focus: "self", scale: 1.15 },
      markLine: { silent: true, symbol: "none", lineStyle: { type: "dashed", color: "#94a3b8", width: 1 }, data: guides },
      data: rows.map((row, index) => ({ name: String(row.name ?? ""), value: [num(row[x.key]), num(row[y.key]), num(row[size?.key || ""]) ?? 1], filterValue: filterValueOf(row), itemStyle: { color: PALETTE[index % PALETTE.length] } })),
    }],
  };
}

// Radar axis names sit outside the web, so long ones break onto two lines.
function wrap(name: string, width = 14) {
  if (name.length <= width || !name.includes(" ")) return name;
  const words = name.split(" ");
  const lines = [""];
  for (const word of words) {
    const line = lines[lines.length - 1];
    if (line && `${line} ${word}`.length > width) lines.push(word);
    else lines[lines.length - 1] = line ? `${line} ${word}` : word;
  }
  return lines.join("\n");
}

function radar(chart: ReportChart, ctx: ChartContext): EChartsCoreOption {
  const rows = rowsOf(chart);
  const keys = chart.seriesKeys || [];
  return {
    ...base(chart),
    legend: legend(ctx, { top: "auto", bottom: 0, left: "center", textStyle: { color: SUB, fontSize: ctx.large ? 12 : 11, width: 110, overflow: "truncate" } }),
    tooltip: tooltip({ trigger: "item", formatter: (param: TooltipParam) => {
      const row = rows.find(item => item.name === param.name);
      return [`<b>${escape(param.name)}</b>`, ...keys.map(key => `${escape(ctx.copy(key))}&nbsp;&nbsp;<b>${escape(ctx.format(num(row?.[key]), "percentage"))}</b>`)].join("<br/>");
    } }),
    radar: { indicator: keys.map(key => ({ name: wrap(ctx.copy(key)), max: 100 })), radius: "58%", center: ["50%", "48%"], splitNumber: 4, axisName: { color: SUB, fontSize: ctx.large ? 12 : 11, lineHeight: 14 }, splitLine: { lineStyle: { color: GRID_LINE } }, splitArea: { areaStyle: { color: ["#ffffff", "#f8fafc"] } }, axisLine: { lineStyle: { color: AXIS_LINE } } },
    series: [{ type: "radar", symbol: "circle", symbolSize: 5, emphasis: { focus: "self", lineStyle: { width: 3 } }, data: rows.map((row, index) => ({ name: String(row.name ?? ""), value: keys.map(key => num(row[key]) ?? 0), lineStyle: { width: 2, color: PALETTE[index % PALETTE.length] }, itemStyle: { color: PALETTE[index % PALETTE.length] }, areaStyle: { color: PALETTE[index % PALETTE.length], opacity: 0.1 } })) }],
  };
}

export function chartOption(chart: ReportChart, ctx: ChartContext): EChartsCoreOption {
  switch (chart.type) {
    case "combo": return combo(chart, ctx);
    case "pareto": return pareto(chart, ctx);
    case "pie":
    case "donut": return pie(chart, ctx);
    case "funnel": return funnel(chart, ctx);
    case "waterfall": return waterfall(chart, ctx);
    case "treemap": return treemap(chart, ctx);
    case "gauge": return gauge(chart, ctx);
    case "heatmap": return heatmap(chart, ctx);
    case "calendar": return calendar(chart, ctx);
    case "sankey": return sankey(chart, ctx);
    case "scatter": return scatter(chart, ctx);
    case "radar": return radar(chart, ctx);
    default: return cartesian(chart, ctx);
  }
}

// Card height for a visual: bars grow with their categories; the rest use a
// height that suits the type.
export function chartHeight(chart: ReportChart) {
  const rows = (chart.data || []).length;
  if (chart.type === "horizontal_bar" || (chart.type === "stacked_bar" && chart.orientation === "horizontal")) return Math.max(260, rows * 30 + 56);
  if (chart.type === "heatmap") return Math.max(240, rows * 36 + 76);
  if (chart.type === "calendar") return 210;
  if (chart.type === "gauge") return 250;
  if (["treemap", "sankey", "scatter", "radar"].includes(chart.type)) return 330;
  return 290;
}

// The visual's empty state replaces the chart when there is nothing to draw.
export function chartIsEmpty(chart: ReportChart) {
  if (chart.type === "sankey") return !(chart.links || []).length;
  return !(chart.data || []).length;
}
