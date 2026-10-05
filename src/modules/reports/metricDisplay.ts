import type { GovernedReport, MetricDefinition } from './governedReports';
import { formatMetric } from './currencyFormatting.mjs';

// How a KPI value reads, on the dashboard and in the exported workbook alike.
// The result is interface copy (or a formatted number) that the caller passes
// through its copy function.

type MetricFormat = { locale?: string; language?: string };

// A money metric carries its own currency; the data scope is only a fallback for older payloads.
export function metricCurrency(item: MetricDefinition, dataScope: GovernedReport['dataScope']) {
  return item.unit === 'currency' && item.currencyAggregationStatus ? { code: item.currencyCode ?? null, status: item.currencyAggregationStatus } : { code: dataScope.currencyCode, status: dataScope.currencyAggregationStatus };
}

export function metricDisplayValue(item: MetricDefinition, dataScope: GovernedReport['dataScope'], format: MetricFormat) {
  const currency = metricCurrency(item, dataScope);
  if (item.limitations?.includes('inventory_units_mixed') || item.limitations?.includes('sales_demand_units_mixed')) return 'Mixed units';
  if (item.limitations?.includes('sales_demand_skus_mixed') || item.limitations?.includes('inventory_skus_mixed')) return 'Multiple SKUs';
  if (item.dataStatus === 'restricted') return 'Restricted';
  if (item.limitations?.includes('insufficient_sample')) return 'Fewer than 5 lines';
  if (item.limitations?.includes('receipts_truncated') || item.limitations?.includes('period_too_long')) return 'Not measured';
  if (item.dataStatus === 'no_records') return '暂无业务记录';
  if (item.unit === 'currency' && currency.status === 'no_currency_data') return '暂无金额数据';
  if (item.unit === 'currency' && currency.status === 'multi_currency_unconverted') return '请选择币种';
  if (item.unit === 'currency' && currency.status === 'currency_unknown') return 'Missing or invalid currency';
  if (item.dataStatus === 'incomplete') return '数据不足';
  // A quantity total is of one SKU in one unit, and says which unit.
  if (item.quantityUnit && item.currentValue !== null) return `${formatMetric(item.currentValue, item.unit, currency.code, format)} ${item.quantityUnit}`;
  return formatMetric(item.currentValue, item.unit, currency.code, format);
}
