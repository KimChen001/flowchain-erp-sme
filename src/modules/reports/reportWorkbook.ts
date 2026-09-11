import type { GovernedReport } from './governedReports';
import { formatMetric } from './currencyFormatting.mjs';

export function reportWorkbook(report: GovernedReport, filters: Record<string, string>, copy: (value: string) => string, limitations: string[]) {
  const scope = report.dataScope;
  const row = (entries: Record<string, unknown>) => Object.fromEntries(Object.entries(entries).map(([key, value]) => [copy(key), value]));
  const metadata = row({ 'Currency code': scope.currencyCode || '—', 'Currency name': copy(scope.currencyLabel), 'Currency aggregation': copy(({ single_currency: 'Single currency', filtered_currency: 'Filtered currency', multi_currency_unconverted: '多币种，未折算', no_currency_data: '无币种数据' })[scope.currencyAggregationStatus]), 'FX converted': copy(scope.fxConverted ? 'Yes' : 'No') });
  const chartRows = report.charts.flatMap(chart => chart.series?.length
    ? chart.series.flatMap(series => series.data.map(point => row({ Chart: copy(chart.title), Dimension: point.period, Series: copy(series.label), Value: point.value })))
    : (chart.data || []).flatMap(point => Object.entries(point).filter(([key]) => !['name', 'period', 'filterValue'].includes(key)).map(([key, value]) => row({ Chart: copy(chart.title), Dimension: copy(String(point.name || point.period || 'Uncategorized')), Series: copy(key === 'value' ? chart.title : key), Value: value }))));
  const sheets: Array<{ name: string; rows: Record<string, unknown>[] }> = [
    { name: copy('Metric summary'), rows: report.kpis.map(item => ({ ...metadata, ...row({ Metric: copy(item.label), 'Current value': copy(item.unit === 'currency' && scope.currencyAggregationStatus === 'no_currency_data' ? '暂无金额数据' : formatMetric(item.currentValue, item.unit, scope.currencyCode)), 'Baseline value': item.comparisonValue === null ? copy('Not compared') : formatMetric(item.comparisonValue, item.unit, scope.currencyCode), Definition: copy(item.description), 'Data range': `${scope.from} — ${scope.to}` }) })) },
    { name: copy('Chart data'), rows: chartRows.map(item => ({ ...metadata, ...item })) },
    { name: copy('Detail data'), rows: report.exportRows.map(item => ({ ...metadata, ...Object.fromEntries(report.columnDefinitions.map(column => [copy(column.label), column.key === 'status' ? copy(String(item[column.key] ?? '—')) : item[column.key] ?? '—'])) })) },
    { name: copy('Filters'), rows: [{ ...metadata, ...row({ '开始日期': scope.from, '结束日期': scope.to, '公司': scope.company, '供应商': filters.supplier || copy('全部供应商'), '客户': filters.customer || copy('全部客户'), '比较方式': copy(filters.comparison === 'year_over_year' ? '同比' : filters.comparison === 'previous_period' ? '上期' : '不比较') }) }] },
    { name: copy('指标口径'), rows: report.kpis.map(item => row({ Metric: copy(item.label), Definition: copy(item.description), Calculation: copy(item.calculationLabel), 'Date field': copy('Record date'), 'Metric version': item.version, 'Data limitations': limitations.map(copy).join('; ') || copy('None') })) },
  ];
  return sheets.map(sheet => ({ ...sheet, rows: sheet.rows.length ? sheet.rows : [row({ Definition: copy('No records in the selected range.') })] }));
}
