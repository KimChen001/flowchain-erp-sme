import { useEffect, useMemo, useRef, useState } from "react";
import type { ECElementEvent } from "echarts/core";
import { BarChart3, Download, ImageDown, Maximize2, Table2, X } from "lucide-react";
import { toast } from "sonner";
import { A, Card } from "../../components/ui";
import type { ReportChart } from "./governedReports";
import { EChart, type EChartHandle } from "./charts/EChart";
import { chartHeight, chartIsEmpty, chartOption, type ChartContext } from "./charts/chartOptions";
import { chartTable, chartTableCsv } from "./charts/chartTable";

type VisualCardProps = {
  chart: ReportChart;
  context: ChartContext;
  className?: string;
  onDrill: (path: string) => void;
  onCrossFilter: (key: string, value: string) => void;
};

const LIMITATION_NOTES: Record<string, string> = {
  multi_currency_unconverted: "Amounts are in more than one currency, so documents are counted. Select a currency to compare amounts.",
  currency_missing_or_invalid: "Some records have no valid currency, so documents are counted. Select a currency to compare amounts.",
  amount_missing: "Some documents have no amount and are left out of the amounts.",
};

function download(name: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const fileName = (title: string, extension: string) => `${title.replace(/[\\/:*?"<>|]+/g, " ").trim() || "chart"}.${extension}`;

// The SVG the chart draws, on a white background at twice its size.
async function chartPng(svg: string, width: number, height: number) {
  const image = new Image();
  const loaded = new Promise<void>((resolve, reject) => { image.onload = () => resolve(); image.onerror = () => reject(new Error("image")); });
  image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  await loaded;
  const canvas = document.createElement("canvas");
  canvas.width = width * 2;
  canvas.height = height * 2;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("canvas");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  return new Promise<Blob>((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error("png")), "image/png"));
}

function VisualBody({ chart, context, height, mode, chartRef, onCrossFilter }: { chart: ReportChart; context: ChartContext; height: number; mode: "chart" | "table"; chartRef?: React.Ref<EChartHandle>; onCrossFilter: (key: string, value: string) => void }) {
  const { copy } = context;
  const option = useMemo(() => chartOption(chart, context), [chart, context]);
  const table = useMemo(() => chartTable(chart, context), [chart, context]);
  const title = copy(chart.title);
  if (chartIsEmpty(chart)) return <div className="flex items-center justify-center px-6 text-center text-xs" style={{ height: Math.min(height, 220), color: A.sub }}>{copy(chart.emptyState || "No records in the selected range.")}</div>;
  if (mode === "table") {
    const filterable = Boolean(chart.crossFilter) && chart.type !== "treemap";
    return <div className="overflow-auto" style={{ maxHeight: height }} data-testid="visual-data-table">
      {filterable && <p className="mb-2 text-[11px]" style={{ color: A.sub }}>{copy("Select a row to filter the dashboard.")}</p>}
      <table className="w-full text-xs">
        <thead><tr style={{ borderBottom: `1px solid ${A.border}` }}><th className="py-1.5 pr-3 text-left font-medium" style={{ color: A.gray1 }}>{table.dimension}</th>{table.columns.map(column => <th key={column.key} className="py-1.5 pl-3 text-right font-medium" style={{ color: A.gray1 }}>{column.label}</th>)}</tr></thead>
        <tbody>{table.rows.map((row, index) => <tr key={`${row.label}-${index}`} style={{ borderTop: `1px solid ${A.border}` }}>
          <td className="py-1.5 pr-3">{filterable && row.filterValue ? <button type="button" className="text-left font-medium hover:underline" style={{ color: A.blue }} onClick={() => onCrossFilter(chart.crossFilter!, row.filterValue)}>{row.label}</button> : row.label}</td>
          {row.values.map((value, column) => <td key={column} className="py-1.5 pl-3 text-right tabular-nums">{context.format(value, table.columns[column].unit, chart.currencyCode)}</td>)}
        </tr>)}</tbody>
      </table>
    </div>;
  }
  const click = (event: ECElementEvent) => {
    if (!chart.crossFilter || chart.type === "treemap") return;
    const value = String((event.data as { filterValue?: unknown } | undefined)?.filterValue ?? "");
    if (value) onCrossFilter(chart.crossFilter, value);
  };
  return <EChart ref={chartRef} option={option} height={height} language={context.language} label={title} onClick={click} />;
}

// One report visual: the chart, or its data as a table, with a focus view, PNG
// and CSV downloads and a link to the business records behind it.
export function VisualCard({ chart, context, className = "", onDrill, onCrossFilter }: VisualCardProps) {
  const { copy } = context;
  const [mode, setMode] = useState<"chart" | "table">("chart");
  const [focused, setFocused] = useState(false);
  const chartRef = useRef<EChartHandle>(null);
  const focusRef = useRef<EChartHandle>(null);
  const title = copy(chart.title);
  const notes = [...new Set((chart.limitations || []).map(code => LIMITATION_NOTES[code]).filter(Boolean))];
  const largeContext = useMemo(() => ({ ...context, large: true }), [context]);
  const height = chartHeight(chart);
  useEffect(() => {
    if (!focused) return;
    const close = (event: KeyboardEvent) => { if (event.key === "Escape") setFocused(false); };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [focused]);
  const downloadImage = async () => {
    const instance = (focused ? focusRef : chartRef).current?.instance();
    if (!instance) return;
    try {
      const svg = (instance as unknown as { renderToSVGString: () => string }).renderToSVGString();
      download(fileName(title, "png"), await chartPng(svg, instance.getWidth(), instance.getHeight()));
      toast.success(copy("Chart image downloaded"), { description: title });
    } catch { toast.error(copy("Could not download the chart")); }
  };
  const downloadCsv = () => {
    // The byte order mark lets spreadsheet tools read the file as UTF-8.
    download(fileName(title, "csv"), new Blob([String.fromCharCode(0xfeff), chartTableCsv(chartTable(chart, context))], { type: "text/csv;charset=utf-8" }));
    toast.success(copy("Chart data downloaded"), { description: title });
  };
  const empty = chartIsEmpty(chart);
  const tool = "rounded-md p-1.5 transition hover:bg-slate-100 disabled:opacity-30";
  const toolbar = (inFocus: boolean) => <div className="flex shrink-0 items-center gap-0.5">
    <button type="button" className={tool} title={copy(mode === "chart" ? "Show data" : "Show chart")} aria-label={`${copy(mode === "chart" ? "Show data" : "Show chart")}: ${title}`} aria-pressed={mode === "table"} disabled={empty} onClick={() => setMode(mode === "chart" ? "table" : "chart")}>{mode === "chart" ? <Table2 size={14} color={A.gray1} /> : <BarChart3 size={14} color={A.gray1} />}</button>
    <button type="button" className={tool} title={copy("Download image")} aria-label={`${copy("Download image")}: ${title}`} disabled={empty || mode === "table"} onClick={downloadImage}><ImageDown size={14} color={A.gray1} /></button>
    <button type="button" className={tool} title={copy("Download CSV")} aria-label={`${copy("Download CSV")}: ${title}`} disabled={empty} onClick={downloadCsv}><Download size={14} color={A.gray1} /></button>
    {inFocus
      ? <button type="button" className={tool} title={copy("Close focus mode")} aria-label={copy("Close focus mode")} onClick={() => setFocused(false)}><X size={15} color={A.gray1} /></button>
      : <button type="button" className={tool} title={copy("Focus mode")} aria-label={`${copy("Focus mode")}: ${title}`} disabled={empty} onClick={() => setFocused(true)}><Maximize2 size={14} color={A.gray1} /></button>}
  </div>;
  const header = (inFocus: boolean) => <div className="flex items-start justify-between gap-3">
    <div className="min-w-0">
      <h2 className={`${inFocus ? "text-base" : "text-sm"} font-semibold`} style={{ color: A.label }}>{title}</h2>
      {chart.description && <p className="mt-0.5 text-[11px] leading-4" style={{ color: A.gray2 }}>{copy(chart.description)}</p>}
    </div>
    {toolbar(inFocus)}
  </div>;
  const footer = <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
    <div className="space-y-0.5">{notes.map(note => <p key={note} className="text-[11px]" style={{ color: A.orange }}>{copy(note)}</p>)}{!notes.length && chart.crossFilter && chart.type !== "treemap" && <p className="text-[11px]" style={{ color: A.gray2 }}>{copy("Select the chart to filter this dashboard")}</p>}</div>
    <button type="button" onClick={() => onDrill(chart.drilldownPath)} className="text-[11px] font-medium" style={{ color: A.blue }}>{copy("View business details")}</button>
  </div>;
  return <>
    <Card className={`min-w-0 p-4 ${className}`} data-chart-title={title} data-chart-type={chart.type} data-chart-id={chart.id}>
      {header(false)}
      <div className="mt-3"><VisualBody chart={chart} context={context} height={height} mode={mode} chartRef={chartRef} onCrossFilter={onCrossFilter} /></div>
      {footer}
    </Card>
    {focused && <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/40 p-4 backdrop-blur-[2px]" onMouseDown={event => { if (event.currentTarget === event.target) setFocused(false); }}>
      <div role="dialog" aria-modal="true" aria-label={`${copy("Focus mode")}: ${title}`} className="w-full max-w-6xl rounded-2xl bg-white p-6 shadow-2xl">
        {header(true)}
        <div className="mt-4"><VisualBody chart={chart} context={largeContext} height={Math.max(420, Math.round(window.innerHeight * 0.66))} mode={mode} chartRef={focusRef} onCrossFilter={(key, value) => { setFocused(false); onCrossFilter(key, value); }} /></div>
        {footer}
      </div>
    </div>}
  </>;
}
