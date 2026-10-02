import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import type { ECElementEvent, ECharts, EChartsCoreOption } from "echarts/core";
import { echarts } from "./echarts";

export type EChartHandle = { instance: () => ECharts | null };

type EChartProps = { option: EChartsCoreOption; height: number; language: string; label: string; onClick?: (event: ECElementEvent) => void };

// One ECharts instance per mounted chart. It follows its container's size and
// is replaced, not merged, when the option changes, so a filtered report never
// keeps series from the previous one.
export const EChart = forwardRef<EChartHandle, EChartProps>(function EChart({ option, height, language, label, onClick }, ref) {
  const host = useRef<HTMLDivElement>(null);
  const chart = useRef<ECharts | null>(null);
  const click = useRef(onClick);
  click.current = onClick;
  useImperativeHandle(ref, () => ({ instance: () => chart.current }), []);
  useEffect(() => {
    if (!host.current) return;
    const instance = echarts.init(host.current, null, { renderer: "svg", locale: language === "zh-CN" ? "ZH" : "EN" });
    chart.current = instance;
    instance.on("click", event => click.current?.(event as ECElementEvent));
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => instance.resize());
    observer?.observe(host.current);
    return () => { observer?.disconnect(); instance.dispose(); chart.current = null; };
  }, [language]);
  useEffect(() => { chart.current?.setOption(option, { notMerge: true }); }, [option, language]);
  return <div ref={host} role="img" aria-label={label} style={{ height, width: "100%" }} />;
});
