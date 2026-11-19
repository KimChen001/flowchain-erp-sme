import test from 'node:test'
import assert from 'node:assert/strict'
import { analyticsCopy } from '../../src/modules/reports/analyticsCopy.ts'
import { buildRuntimeGovernedReport, REPORT_STATE_LABELS } from './runtime-report-read-model.mjs'

// Design audit L6-20: the report read model writes the state of a figure (the
// currency mix, the comparison, the data scope) as English copy keys that the
// dashboard translates (analyticsCopy, English first, with zh-CN), never as
// Chinese words the English page has to look up backwards. Currency codes
// stay codes.

const CJK = /[㐀-鿿＀-￯]/
const now = new Date('2026-11-17T12:00:00Z')
const context = (purchaseOrders = [], supplierInvoices = []) => ({
  purchaseOrders, supplierInvoices,
  salesOrders: [], suppliers: [], customers: [], items: [], inventoryItems: [],
  purchaseRequests: [], rfqs: [], receipts: [], warehouses: [], bins: [], itemSupplierRelationships: [], dataLimitations: [],
})
const po = (id, amount, currency, day = '2026-10-10') => ({ id, totalAmount: amount, currency, status: 'issued', orderDate: day, createdAt: `${day}T12:00:00.000Z`, lines: [] })
const invoice = (id, amount, currency) => ({ id, invoiceNumber: id, totalAmount: amount, currency, status: 'submitted', invoiceDate: '2026-10-12T12:00:00.000Z', lines: [] })

const SUBJECTS = ['overview', 'procurement', 'sales', 'inventory', 'finance', 'suppliers']
const CONTEXTS = {
  empty: context(),
  cny: context([po('PO-CNY', 100, 'CNY')], [invoice('INV-CNY', 100, 'CNY')]),
  mixed: context([po('PO-USD', 100, 'USD'), po('PO-EUR', 50, 'EUR')], [invoice('INV-USD', 80, 'USD'), invoice('INV-EUR', 20, 'EUR')]),
  unknown: context([po('PO-USD', 100, 'USD'), po('PO-NONE', 40, '')]),
  compared: context([po('PO-SEP', 60, 'USD', '2026-09-10'), po('PO-OCT', 90, 'USD', '2026-10-10')]),
}
const comparison = { comparison: 'previous_period', filters: { from: '2026-10-01', to: '2026-10-31' } }

// Every state word a report carries.
function stateWords(report) {
  const scope = report.dataScope
  return [
    ['dataScope.label', scope.label], ['dataScope.sourceLabel', scope.sourceLabel],
    ['dataScope.currencyLabel', scope.currencyLabel], ['dataScope.completenessLabel', scope.completenessLabel],
    ...scope.currencyAmounts.map((row, index) => [`dataScope.currencyAmounts[${index}]`, row.currencyLabel]),
    ...report.kpis.flatMap(kpi => [
      [`${kpi.id}.comparisonLabel`, kpi.comparisonLabel],
      ...(kpi.currencyLabel === undefined ? [] : [[`${kpi.id}.currencyLabel`, kpi.currencyLabel]]),
      ...(kpi.currencyAmounts || []).map((row, index) => [`${kpi.id}.currencyAmounts[${index}]`, row.currencyLabel]),
    ]),
  ]
}
const reports = () => Object.entries(CONTEXTS).flatMap(([name, value]) => SUBJECTS.map(subject => [`${name} ${subject}`, buildRuntimeGovernedReport(value, { subject, ...(name === 'compared' ? comparison : {}) }, { now })]))

test('the report read model writes its state words as English keys, never Chinese', () => {
  const seen = new Set()
  for (const [name, report] of reports()) {
    for (const [field, word] of stateWords(report)) {
      assert.equal(typeof word, 'string', `${name} ${field}`)
      assert.doesNotMatch(word, CJK, `${name} ${field}: "${word}"`)
      seen.add(word)
    }
  }
  // The cases above reach every state word.
  for (const word of Object.values(REPORT_STATE_LABELS)) assert.ok(seen.has(word), word)
  for (const word of ['Chinese yuan (CNY)', 'US dollar (USD)', 'Euro (EUR)', 'Missing or invalid currency']) assert.ok(seen.has(word), word)
})

test('the dashboard names each state word in English and Chinese', () => {
  const words = new Set([
    ...reports().flatMap(([, report]) => stateWords(report).map(([, word]) => word)),
    ...Object.values(REPORT_STATE_LABELS),
    'All currencies',
  ])
  for (const word of words) {
    // A currency code alone (GBP, USD) is shown as it is in both languages.
    if (/^[A-Z]{3}$/.test(word)) continue
    assert.equal(analyticsCopy(word, 'en-US'), word, word)
    const chinese = analyticsCopy(word, 'zh-CN')
    assert.match(chinese, CJK, `${word} has no Chinese`)
    assert.deepEqual((chinese.match(/\{\w+\}/g) || []).sort(), (word.match(/\{\w+\}/g) || []).sort(), `${word} keeps its placeholders`)
  }
  assert.equal(analyticsCopy(REPORT_STATE_LABELS.multiCurrency, 'zh-CN'), '多币种，未折算')
  assert.equal(analyticsCopy(REPORT_STATE_LABELS.recordsLoaded, 'zh-CN'), '已读取 {n} 条真实记录')
})

test('the state words follow the figures they describe', () => {
  const report = (name, subject, input = {}) => buildRuntimeGovernedReport(CONTEXTS[name], { subject, ...input }, { now })
  const amount = result => result.kpis.find(kpi => kpi.id === 'purchase_order_amount')
  const mixed = report('mixed', 'procurement')
  assert.deepEqual([mixed.dataScope.currencyAggregationStatus, mixed.dataScope.currencyLabel, amount(mixed).comparisonLabel], ['multi_currency_unconverted', 'Multiple currencies, not converted', 'Multiple currencies, not converted'])
  assert.deepEqual(mixed.dataScope.currencyAmounts.map(row => [row.currencyCode, row.currencyLabel]), [['EUR', 'Euro (EUR)'], ['USD', 'US dollar (USD)']])
  assert.equal(report('cny', 'procurement').dataScope.currencyLabel, 'Chinese yuan (CNY)')
  const empty = report('empty', 'procurement')
  assert.deepEqual([empty.dataScope.currencyLabel, empty.dataScope.completenessLabel, empty.totalRecords], ['No currency data', 'No business records in this range', 0])
  const loaded = report('cny', 'procurement')
  assert.deepEqual([loaded.dataScope.completenessLabel, loaded.totalRecords], ['Records loaded: {n}', 1])
  assert.equal(amount(report('unknown', 'procurement')).currencyLabel, 'Missing or invalid currency')
  const compared = amount(report('compared', 'procurement', comparison))
  assert.deepEqual([compared.comparisonValue, compared.comparisonLabel], [60, 'Previous period'])
  assert.equal(report('cny', 'procurement').kpis.find(kpi => kpi.id === 'open_po_count').comparisonLabel, 'Not compared')
  // The currency code is unchanged.
  assert.equal(report('cny', 'procurement').dataScope.currencyCode, 'CNY')
})
