import type { ChartProps } from "./types";

// Bars for more than three categories lie on their side, so every name fits
// on its own line (2026-11-05: two of five supplier names showed). Kept apart
// from ChartCanvas, which loads ECharts only when an answer has a chart.
export const horizontalChart = (props: ChartProps) => props.kind !== "line" && props.x.values.length > 3;

// The height a chart needs: a horizontal one grows with its categories.
export const chartHeight = (props: ChartProps, base: number) => (horizontalChart(props) ? Math.max(base, props.x.values.length * 30 + (props.series.length > 1 ? 56 : 24)) : base);
