import { useMemo } from "react";
import type { EChartsCoreOption } from "echarts/core";
import { EChart } from "../../../reports/charts/EChart";
import { PALETTE } from "../../../reports/charts/chartOptions";
import { usePartCopy } from "./partKit";
import type { ChartProps } from "./types";

const SUB = "#64748b";
const GRID_LINE = "#eef2f7";
const AXIS_LINE = "#e2e8f0";

// The chart itself, loaded only when an answer has one: ECharts is large and
// most answers have no chart. One currency per chart (the protocol has no
// per-series currency), so every value shares the axis's unit.
export default function ChartCanvas({ props, language, label, height }: { props: ChartProps; language?: string; label: string; height: number }) {
  const copy = usePartCopy(language);
  const option = useMemo<EChartsCoreOption>(() => {
    const format = (value: number | null) => copy.value(value, props.unit, props.currency);
    return {
      color: PALETTE,
      animationDuration: 500,
      textStyle: { fontFamily: "inherit" },
      aria: { enabled: false },
      grid: { left: 8, right: 12, top: props.series.length > 1 ? 32 : 12, bottom: 4, outerBoundsMode: "same" },
      legend: props.series.length > 1 ? { type: "scroll", top: 0, left: 0, icon: "roundRect", itemWidth: 10, itemHeight: 10, textStyle: { color: SUB, fontSize: 11 } } : undefined,
      tooltip: { trigger: "axis", confine: true, valueFormatter: format },
      xAxis: { type: "category", data: props.x.values, axisLine: { lineStyle: { color: AXIS_LINE } }, axisTick: { show: false }, axisLabel: { color: SUB, fontSize: 11, hideOverlap: true } },
      yAxis: { type: "value", axisLine: { show: false }, axisTick: { show: false }, splitLine: { lineStyle: { color: GRID_LINE } }, axisLabel: { color: SUB, fontSize: 11, formatter: format } },
      series: props.series.map((series) => ({
        // A business name is shown as recorded; a measure is worded by its code.
        name: series.name || copy.known("ai.v2.column", series.code),
        type: props.kind === "line" ? "line" : "bar",
        data: series.values,
        ...(props.kind === "stacked_bar" ? { stack: "total" } : {}),
        ...(props.kind === "line" ? { symbolSize: 6 } : { barMaxWidth: 28, itemStyle: { borderRadius: props.kind === "bar" ? [4, 4, 0, 0] : 0 } }),
      })),
    };
    // copy is rebuilt every render; the option depends only on these.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props, copy.language, copy.locale]);
  return <EChart option={option} height={height} language={copy.language} label={label} />;
}
