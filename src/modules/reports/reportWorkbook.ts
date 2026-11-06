import type { GovernedReport } from './governedReports';
import { formatMetric } from './currencyFormatting.mjs';
import { reportStatusCopy } from './analyticsCopy.ts';
import { chartTable } from './charts/chartTable.ts';
import { metricDisplayValue } from './metricDisplay.ts';

// A report's date range in words: both ends, one end, or all dates.
export function dateRangeLabel(from: string | null | undefined, to: string | null | undefined, copy: (value: string) => string) {
  if (from && to) return `${from} — ${to}`;
  if (from) return `${copy('From')} ${from}`;
  if (to) return `${copy('Through')} ${to}`;
  return copy('All dates');
}

export function reportWorkbook(report: GovernedReport, filters: Record<string, string>, copy: (value: string) => string, limitations: string[], format: { locale?: string; language?: string } = {}) {
  const scope = report.dataScope;
  const row = (entries: Record<string, unknown>) => Object.fromEntries(Object.entries(entries).map(([key, value]) => [copy(key), value]));
  const aggregation = { single_currency: 'Single currency', filtered_currency: 'Filtered currency', multi_currency_unconverted: '多币种，未折算', currency_unknown: '币种缺失或无效', no_currency_data: '无币种数据' };
  const currencyMetadata = (code: string | null, label: string, status: keyof typeof aggregation) => row({ 'Currency code': code || '—', 'Currency name': copy(label), 'Currency aggregation': copy(aggregation[status]), 'FX converted': copy(scope.fxConverted ? 'Yes' : 'No') });
  const metadata = currencyMetadata(scope.currencyCode, scope.currencyLabel, scope.currencyAggregationStatus);
  // A money metric is described and formatted in its own currency, which can differ from the dashboard's.
  const metricCurrency = (item: GovernedReport['kpis'][number]) => item.unit === 'currency' && item.currencyAggregationStatus ? { code: item.currencyCode ?? null, label: item.currencyLabel || scope.currencyLabel, status: item.currencyAggregationStatus } : { code: scope.currencyCode, label: scope.currencyLabel, status: scope.currencyAggregationStatus };
  // The value as the dashboard shows it (unit, mixed units, too few lines),
  // except that an export names the currency mix instead of asking to pick one.
  const metricValue = (item: GovernedReport['kpis'][number], status: keyof typeof aggregation) => item.dataStatus !== 'restricted' && item.unit === 'currency' && (status === 'multi_currency_unconverted' || status === 'currency_unknown') ? aggregation[status] : metricDisplayValue(item, scope, format);
  // The same table each visual shows under "Show data", one row per value.
  const language = format.language || 'en-US';
  const category = (chart: GovernedReport['charts'][number], name: string) => chart.statusLabels || chart.id.endsWith('_status') ? reportStatusCopy(name, language) : copy(name);
  const chartRows = report.charts.flatMap(chart => {
    if (chart.series?.length) return chart.series.flatMap(series => series.data.map(point => row({ Chart: copy(chart.title), Dimension: point.period, Series: copy(series.label), Value: point.value })));
    const table = chartTable(chart, { copy, category });
    return table.rows.flatMap(entry => table.columns.map((column, index) => row({ Chart: copy(chart.title), Dimension: entry.label, Series: column.label, Value: entry.values[index] })));
  });
  // A detail value as the dashboard table shows it: statuses in words, and
  // 'mixed' or 'multiple_skus' in the unit column as why a row has no total.
  const unitReasons: Record<string, string> = { mixed: 'Mixed units', multiple_skus: 'Multiple SKUs' };
  const detailValue = (key: string, value: unknown) => key === 'status' || key === 'stockStatus' ? copy(reportStatusCopy(String(value ?? '—'), language)) : key === 'unit' && typeof value === 'string' && unitReasons[value] ? copy(unitReasons[value]) : value ?? '—';
  const sheets: Array<{ name: string; rows: Record<string, unknown>[] }> = [
    { name: copy('Metric summary'), rows: report.kpis.map(item => { const currency = metricCurrency(item); return { ...currencyMetadata(currency.code, currency.label, currency.status), ...row({ Metric: copy(item.label), 'Current value': copy(metricValue(item, currency.status)), 'Baseline value': item.comparisonValue === null ? copy('Not compared') : formatMetric(item.comparisonValue, item.unit, currency.code, format), Definition: copy(item.description), 'Data range': dateRangeLabel(scope.from, scope.to, copy) }) }; }) },
    { name: copy('Chart data'), rows: chartRows.map(item => ({ ...metadata, ...item })) },
    { name: copy('Detail data'), rows: report.exportRows.map(item => ({ ...metadata, ...Object.fromEntries(report.columnDefinitions.map(column => [copy(column.label), detailValue(column.key, item[column.key])])) })) },
    { name: copy('Filters'), rows: [{ ...metadata, ...row({ '开始日期': scope.from || '—', '结束日期': scope.to || '—', '供应商': filters.supplier || copy('全部供应商'), '客户': filters.customer || copy('全部客户'), '比较方式': copy(filters.comparison === 'year_over_year' ? '同比' : filters.comparison === 'previous_period' ? '上期' : '不比较') }) }] },
    { name: copy('指标口径'), rows: report.kpis.map(item => row({ Metric: copy(item.label), Definition: copy(item.description), Calculation: copy(item.calculationLabel), 'Date field': copy('Record date'), 'Metric version': item.version, 'Data limitations': limitations.map(copy).join('; ') || copy('None') })) },
  ];
  return sheets.map(sheet => ({ ...sheet, rows: sheet.rows.length ? sheet.rows : [row({ Definition: copy('No records in the selected range.') })] }));
}
