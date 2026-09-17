import test from 'node:test'
import assert from 'node:assert/strict'
import { reportWorkbook } from '../../src/modules/reports/reportWorkbook.ts'
import { analyticsCopy } from '../../src/modules/reports/analyticsCopy.ts'
import { buildRuntimeGovernedReport } from './runtime-report-read-model.mjs'
import { formatMetric } from '../../src/modules/reports/currencyFormatting.mjs'

const context = purchaseOrders => ({
  purchaseOrders,
  salesOrders: [], supplierInvoices: [], suppliers: [], customers: [], items: [],
  inventoryItems: [], purchaseRequests: [], rfqs: [], receipts: [], warehouses: [], bins: [],
  itemSupplierRelationships: [], dataLimitations: [],
})
const po = (id, amount, currency) => ({ id, totalAmount: amount, currency, status: 'issued', lines: [] })
const amountMetric = report => report.kpis.find(item => item.id === 'purchase_order_amount')

test('single CNY scope exposes an ISO code and a formattable amount', () => {
  const report = buildRuntimeGovernedReport(context([po('PO-CNY', 100, 'CNY')]), { subject: 'overview' })
  assert.equal(report.dataScope.currencyCode, 'CNY')
  assert.equal(report.dataScope.currencyAggregationStatus, 'single_currency')
  assert.equal(amountMetric(report).currentValue, 100)
  assert.match(formatMetric(amountMetric(report).currentValue, 'currency', report.dataScope.currencyCode), /100/)
})

test('unfiltered CNY and USD data is not summed across currencies', () => {
  const report = buildRuntimeGovernedReport(context([po('PO-CNY', 100, 'CNY'), po('PO-USD', 200, 'USD')]), { subject: 'overview' })
  assert.equal(report.dataScope.currencyCode, null)
  assert.deepEqual(report.dataScope.currencies, ['CNY', 'USD'])
  assert.equal(report.dataScope.currencyAggregationStatus, 'multi_currency_unconverted')
  assert.equal(amountMetric(report).currentValue, null)
  assert.equal(amountMetric(report).dataStatus, 'incomplete')
  assert.deepEqual(report.dataScope.currencyAmounts.map(item => [item.currencyCode, item.amount]), [['CNY', 100], ['USD', 200]])
})

for (const code of ['CNY', 'USD']) {
  test(`currency=${code} filters KPI, charts, details, and export rows consistently`, () => {
    const report = buildRuntimeGovernedReport(context([po('PO-CNY', 100, 'CNY'), po('PO-USD', 200, 'USD')]), { subject: 'overview', filters: { currency: code } })
    assert.equal(report.query.currency, code)
    assert.equal(report.dataScope.currencyCode, code)
    assert.equal(report.dataScope.currencyAggregationStatus, 'filtered_currency')
    assert.equal(amountMetric(report).currentValue, code === 'CNY' ? 100 : 200)
    assert.deepEqual(report.details.map(item => item.currency), [code])
    assert.deepEqual(report.exportRows.map(item => item.currency), [code])
    assert.equal(report.charts[0].data.length, 1)
  })
}

test('legacy currency=全部币种 is normalized to an empty filter', () => {
  const report = buildRuntimeGovernedReport(context([po('PO-CNY', 100, 'CNY')]), { subject: 'overview', filters: { currency: '全部币种' } })
  assert.equal(report.query.currency, '')
  assert.equal(report.dataScope.currencyCode, 'CNY')
  assert.equal(report.dataScope.currencyAggregationStatus, 'single_currency')
  assert.equal(report.dataScope.activeFilterCount, 0)
})

test('currency labels never reach Intl.NumberFormat', () => {
  assert.doesNotThrow(() => formatMetric(100, 'currency', '全部币种'))
  assert.equal(formatMetric(100, 'currency', '全部币种'), '请选择币种')
  assert.equal(formatMetric(100, 'currency', null), '请选择币种')
})

test('report exports retain currency and FX metadata in both languages', () => {
  const report = buildRuntimeGovernedReport(context([po('PO-USD', 200, 'USD')]), { subject: 'overview' })
  for (const language of ['en-US', 'zh-CN']) {
    const copy = text => analyticsCopy(text, language)
    const sheets = reportWorkbook(report, {}, copy, [])
    const first = sheets[0].rows[0]
    assert.equal(first[copy('Currency code')], 'USD')
    assert.equal(first[copy('FX converted')], copy('No'))
    assert.equal(first[copy('Currency aggregation')], copy('Single currency'))
    assert.equal(sheets[2].rows[0][copy('Currency code')], 'USD')
  }
})
