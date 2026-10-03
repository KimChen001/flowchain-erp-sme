import type { ReportChart } from "../governedReports";

// The table behind a visual: what "Show data", the CSV download and the
// workbook's chart sheet list. One row per category, one column per measure.
export type ChartTableColumn = { key: string; label: string; unit: string };
export type ChartTableRow = { label: string; filterValue: string; values: Array<number | null> };
export type ChartTable = { dimension: string; columns: ChartTableColumn[]; rows: ChartTableRow[] };

type Labels = { copy: (value: string) => string; category: (chart: ReportChart, name: string) => string };

const numeric = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : value === null || value === undefined ? null : Number.isFinite(Number(value)) ? Number(value) : null;
const ignored = new Set(["name", "period", "filterValue"]);

function measureKeys(chart: ReportChart, rows: Array<Record<string, unknown>>) {
  if (chart.measures?.length && !["scatter"].includes(chart.type)) return chart.measures.map(item => item.key);
  if (chart.seriesKeys?.length) return chart.seriesKeys;
  return [...new Set(rows.flatMap(row => Object.keys(row)).filter(key => !ignored.has(key) && rows.some(row => numeric(row[key]) !== null)))];
}

export function chartTable(chart: ReportChart, { copy, category }: Labels): ChartTable {
  const rows = (chart.data || []) as Array<Record<string, unknown>>;
  const unitOf = (key: string) => chart.measures?.find(item => item.key === key)?.unit || (key === "Cumulative share" ? "percentage" : chart.unit || "number");
  const columnLabel = (key: string) => {
    const measure = chart.measures?.find(item => item.key === key);
    return copy(key === "value" ? measure?.label || chart.title : chart.statusLabels && chart.type === "heatmap" ? category(chart, key) : key);
  };
  const dimension = copy(chart.type === "calendar" ? "Date" : chart.type === "funnel" || chart.type === "waterfall" ? "Stage" : chart.type === "sankey" ? "Flow" : "Category");
  if (chart.type === "sankey") {
    return { dimension, columns: [{ key: "value", label: copy("Invoices"), unit: "number" }], rows: (chart.links || []).map(link => ({ label: `${link.source} → ${copy(link.target)}`, filterValue: "", values: [link.value] })) };
  }
  if (chart.type === "funnel") {
    const first = numeric(rows[0]?.value) || 0;
    return { dimension, columns: [{ key: "value", label: copy("Count"), unit: "number" }, { key: "share", label: copy("Share of first stage"), unit: "percentage" }], rows: rows.map(row => ({ label: category(chart, String(row.name)), filterValue: "", values: [numeric(row.value), first ? Math.round((numeric(row.value) || 0) / first * 1000) / 10 : null] })) };
  }
  if (chart.type === "gauge") {
    return { dimension, columns: [{ key: "value", label: copy("Share"), unit: "percentage" }, { key: "count", label: copy("Count"), unit: "number" }, { key: "total", label: copy("Total"), unit: "number" }], rows: rows.map(row => ({ label: category(chart, String(row.name)), filterValue: "", values: [numeric(row.value), chart.detail?.count ?? null, chart.detail?.total ?? null] })) };
  }
  if (chart.type === "treemap") {
    const unit = chart.unit || "number";
    return { dimension, columns: [{ key: "value", label: copy(unit === "currency" ? "Committed amount" : "Purchase orders"), unit }], rows: rows.flatMap(row => [
      { label: category(chart, String(row.name)), filterValue: String(row.filterValue ?? ""), values: [numeric(row.value)] },
      ...(chart.breakdown?.[String(row.name)] || []).map(item => ({ label: `${category(chart, String(row.name))} › ${category(chart, item.name)}`, filterValue: "", values: [numeric(item.value)] })),
    ]) };
  }
  const keys = chart.type === "scatter" ? (chart.measures || []).map(item => item.key) : measureKeys(chart, rows);
  return {
    dimension,
    columns: keys.map(key => ({ key, label: columnLabel(key), unit: unitOf(key) })),
    // A row filters by its recorded value, or by its name when the visual filters
    // and the row has none; a folded "other" row carries an empty value.
    rows: rows.map(row => ({ label: category(chart, String(row.name ?? row.period ?? "Uncategorized")), filterValue: String(row.filterValue ?? (chart.crossFilter && !["Undated", "Unspecified"].includes(String(row.name)) ? row.name ?? "" : "")), values: keys.map(key => numeric(row[key])) })),
  };
}

// CSV with a header row and plain numbers, quoted where a value needs it, so a
// spreadsheet reads the values as numbers. A missing value is an empty cell.
export function chartTableCsv(table: ChartTable) {
  const cell = (value: string) => /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
  const header = [table.dimension, ...table.columns.map(column => column.label)];
  const lines = table.rows.map(row => [row.label, ...row.values.map(value => value === null ? "" : String(value))]);
  return [header, ...lines].map(line => line.map(cell).join(",")).join("\r\n");
}
