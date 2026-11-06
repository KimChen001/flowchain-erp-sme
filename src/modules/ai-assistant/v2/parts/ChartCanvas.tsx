import { useMemo } from "react";
import type { EChartsCoreOption } from "echarts/core";
import { EChart } from "../../../reports/charts/EChart";
import { PALETTE } from "../../../reports/charts/chartOptions";
import { horizontalChart } from "./chartLayout";
import { usePartCopy } from "./partKit";
import type { ChartProps } from "./types";

const SUB = "#64748b";
const GRID_LINE = "#eef2f7";
const AXIS_LINE = "#e2e8f0";
// A long name beside a bar is cut short (a Chinese character counts twice);
// the tooltip gives it whole.
const shortName = (value: string) => {
  let width = 0;
  let out = "";
  for (const char of value) {
    width += /[　-鿿＀-￯]/.test(char) ? 2 : 1;
    if (width > 22) return `${out.trimEnd()}…`;
    out += char;
  }
  return value;
};

// The chart itself, loaded only when an answer has one: ECharts is large and
// most answers have no chart. One currency per chart (the protocol has no
// per-series currency), so every value shares the axis's unit. The axis
// reads compact ($21K, 2.1万); the tooltip gives the value in full.
export default function ChartCanvas({ props, language, label, height }: { props: ChartProps; language?: string; label: string; height: number }) {
  const copy = usePartCopy(language);
  const option = useMemo<EChartsCoreOption>(() => {
    const format = (value: number | null) => copy.value(value, props.unit, props.currency);
    const axisFormat = (value: number) => copy.compact(value, props.unit, props.currency);
    const horizontal = horizontalChart(props);
    const categories = { type: "category", data: props.x.values, inverse: horizontal, axisLine: { lineStyle: { color: AXIS_LINE } }, axisTick: { show: false }, axisLabel: { color: SUB, fontSize: 11, hideOverlap: !horizontal, ...(horizontal ? { interval: 0, formatter: shortName } : {}) } };
    const values = { type: "value", axisLine: { show: false }, axisTick: { show: false }, splitLine: { lineStyle: { color: GRID_LINE } }, axisLabel: { color: SUB, fontSize: 11, formatter: axisFormat, hideOverlap: true } };
    return {
      color: PALETTE,
      animationDuration: 500,
      textStyle: { fontFamily: "inherit" },
      aria: { enabled: false },
      grid: { left: horizontal ? 12 : 8, right: 16, top: props.series.length > 1 ? 32 : 12, bottom: 4, outerBoundsMode: "same" },
      legend: props.series.length > 1 ? { type: "scroll", top: 0, left: 0, icon: "roundRect", itemWidth: 10, itemHeight: 10, textStyle: { color: SUB, fontSize: 11 } } : undefined,
      tooltip: { trigger: "axis", confine: true, valueFormatter: format },
      xAxis: horizontal ? values : categories,
      yAxis: horizontal ? categories : values,
      series: props.series.map((series) => ({
        // A business name is shown as recorded; a measure is worded by its code.
        name: series.name || copy.known("ai.v2.column", series.code),
        type: props.kind === "line" ? "line" : "bar",
        data: series.values,
        ...(props.kind === "stacked_bar" ? { stack: "total" } : {}),
        ...(props.kind === "line" ? { symbolSize: 6 } : { barMaxWidth: horizontal ? 18 : 28, itemStyle: { borderRadius: props.kind === "bar" ? (horizontal ? [0, 4, 4, 0] : [4, 4, 0, 0]) : 0 } }),
      })),
    };
    // copy is rebuilt every render; the option depends only on these.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props, copy.language, copy.locale]);
  return <EChart option={option} height={height} language={copy.language} label={label} />;
}
