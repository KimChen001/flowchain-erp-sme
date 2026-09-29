import type { GovernedReport } from './governedReports';
import { formatMetric } from './currencyFormatting.mjs';

export function reportWorkbook(report: GovernedReport, filters: Record<string, string>, copy: (value: string) => string, limitations: string[], format: { locale?: string; language?: string } = {}) {
  const scope = report.dataScope;
  const row = (entries: Record<string, unknown>) => Object.fromEntries(Object.entries(entries).map(([key, value]) => [copy(key), value]));
  const aggregation = { single_currency: 'Single currency', filtered_currency: 'Filtered currency', multi_currency_unconverted: '多币种，未折算', currency_unknown: '币种缺失或无效', no_currency_data: '无币种数据' };
  const currencyMetadata = (code: string | null, label: string, status: keyof typeof aggregation) => row({ 'Currency code': code || '—', 'Currency name': copy(label), 'Currency aggregation': copy(aggregation[status]), 'FX converted': copy(scope.fxConverted ? 'Yes' : 'No') });
  const metadata = currencyMetadata(scope.currencyCode, scope.currencyLabel, scope.currencyAggregationStatus);
  // A money metric is described and formatted in its own currency, which can differ from the dashboard's.
  const metricCurrency = (item: GovernedReport['kpis'][number]) => item.unit === 'currency' && item.currencyAggregationStatus ? { code: item.currencyCode ?? null, label: item.currencyLabel || scope.currencyLabel, status: item.currencyAggregationStatus } : { code: scope.currencyCode, label: scope.currencyLabel, status: scope.currencyAggregationStatus };
  const metricValue = (item: GovernedReport['kpis'][number], value: number | null, status: keyof typeof aggregation, code: string | null) => item.unit === 'currency' && status === 'no_currency_data' ? '暂无金额数据' : item.unit === 'currency' && (status === 'multi_currency_unconverted' || status === 'currency_unknown') ? aggregation[status] : formatMetric(value, item.unit, code, format);
  const chartRows = report.charts.flatMap(chart => chart.series?.length
    ? chart.series.flatMap(series => series.data.map(point => row({ Chart: copy(chart.title), Dimension: point.period, Series: copy(series.label), Value: point.value })))
    : (chart.data || []).flatMap(point => Object.entries(point).filter(([key]) => !['name', 'period', 'filterValue'].includes(key)).map(([key, value]) => row({ Chart: copy(chart.title), Dimension: copy(String(point.name || point.period || 'Uncategorized')), Series: copy(key === 'value' ? chart.title : key), Value: value }))));
  const sheets: Array<{ name: string; rows: Record<string, unknown>[] }> = [
    { name: copy('Metric summary'), rows: report.kpis.map(item => { const currency = metricCurrency(item); return { ...currencyMetadata(currency.code, currency.label, currency.status), ...row({ Metric: copy(item.label), 'Current value': copy(metricValue(item, item.currentValue, currency.status, currency.code)), 'Baseline value': item.comparisonValue === null ? copy('Not compared') : formatMetric(item.comparisonValue, item.unit, currency.code, format), Definition: copy(item.description), 'Data range': `${scope.from} — ${scope.to}` }) }; }) },
    { name: copy('Chart data'), rows: chartRows.map(item => ({ ...metadata, ...item })) },
    { name: copy('Detail data'), rows: report.exportRows.map(item => ({ ...metadata, ...Object.fromEntries(report.columnDefinitions.map(column => [copy(column.label), column.key === 'status' ? copy(String(item[column.key] ?? '—')) : item[column.key] ?? '—'])) })) },
    { name: copy('Filters'), rows: [{ ...metadata, ...row({ '开始日期': scope.from, '结束日期': scope.to, '公司': scope.company, '供应商': filters.supplier || copy('全部供应商'), '客户': filters.customer || copy('全部客户'), '比较方式': copy(filters.comparison === 'year_over_year' ? '同比' : filters.comparison === 'previous_period' ? '上期' : '不比较') }) }] },
    { name: copy('指标口径'), rows: report.kpis.map(item => row({ Metric: copy(item.label), Definition: copy(item.description), Calculation: copy(item.calculationLabel), 'Date field': copy('Record date'), 'Metric version': item.version, 'Data limitations': limitations.map(copy).join('; ') || copy('None') })) },
  ];
  return sheets.map(sheet => ({ ...sheet, rows: sheet.rows.length ? sheet.rows : [row({ Definition: copy('No records in the selected range.') })] }));
}
