import test from 'node:test'
import assert from 'node:assert/strict'
import { COMPARABLE_METRICS, buildRuntimeGovernedReport, previousPeriod } from './runtime-report-read-model.mjs'

// Period comparison (docs/report-collaboration-design.md §5.1): the previous
// period of the same length, computed by the same report builder.

const now = new Date('2026-11-08T12:00:00Z')
const po = (id, date, amount, { status = 'issued', currency = 'USD', supplierName = 'Acme' } = {}) => ({ id, purchaseOrderId: id, supplierName, status, currency, totalAmount: amount, orderDate: date, createdAt: `${date}T12:00:00Z`, lines: [] })
const so = (id, date, amount, currency = 'USD') => ({ id, salesOrderId: id, customerName: 'Corner Shop', status: 'confirmed', currency, totalAmount: amount, orderDate: date, createdAt: `${date}T12:00:00Z`, lines: [] })
const context = (purchaseOrders, salesOrders = []) => ({ purchaseOrders, salesOrders, suppliers: [{ id: 'S', supplierName: 'Acme' }], customers: [], items: [], inventoryItems: [], supplierInvoices: [], receipts: [], dataLimitations: [] })
const kpi = (report, id) => report.kpis.find(item => item.id === id)

test('the previous period has the same number of days and ends the day before', () => {
  assert.deepEqual(previousPeriod('2026-08-01', '2026-08-31'), { from: '2026-07-01', to: '2026-07-31' })
  assert.deepEqual(previousPeriod('2026-11-01', '2026-11-08'), { from: '2026-10-24', to: '2026-10-31' })
  assert.deepEqual(previousPeriod('2026-03-01', '2026-03-01'), { from: '2026-02-28', to: '2026-02-28' })
  assert.equal(previousPeriod('', '2026-01-01'), null)
  assert.equal(previousPeriod('2026-02-01', '2026-01-01'), null)
})

test('a flow figure is set against the previous period; a state as of today is not', () => {
  const report = buildRuntimeGovernedReport(context([po('A', '2026-07-10', 100), po('B', '2026-08-10', 150), po('C', '2026-08-20', 50)]), { subject: 'procurement', comparison: 'previous_period', filters: { from: '2026-08-01', to: '2026-08-31' } }, { now })
  const spend = kpi(report, 'purchase_order_amount')
  assert.equal(spend.currentValue, 200)
  assert.equal(spend.comparisonValue, 100)
  assert.equal(spend.comparisonDelta, 100)
  assert.equal(spend.comparisonRate, 100)
  assert.equal(spend.comparisonDirection, 'up')
  assert.deepEqual(spend.comparisonRange, { from: '2026-07-01', to: '2026-07-31' })
  // Open orders are a state as of today: the earlier period would read it too.
  const open = kpi(report, 'open_po_count')
  assert.equal(open.comparisonValue, null)
  assert.equal(open.comparisonRange, undefined)
  assert.ok(!COMPARABLE_METRICS.has('open_po_count'))
  // The dashboard's visuals are built once, for the range shown.
  assert.ok(report.charts.length > 0)
})

test('no comparison without a request, without a bounded range, or across currencies', () => {
  const rows = [po('A', '2026-07-10', 100), po('B', '2026-08-10', 150)]
  assert.equal(kpi(buildRuntimeGovernedReport(context(rows), { subject: 'procurement', filters: { from: '2026-08-01', to: '2026-08-31' } }, { now }), 'purchase_order_amount').comparisonValue, null)
  assert.equal(kpi(buildRuntimeGovernedReport(context(rows), { subject: 'procurement', comparison: 'previous_period', filters: {} }, { now }), 'purchase_order_amount').comparisonValue, null)
  const mixed = buildRuntimeGovernedReport(context([po('A', '2026-07-10', 100, { currency: 'EUR' }), po('B', '2026-08-10', 150)]), { subject: 'procurement', comparison: 'previous_period', filters: { from: '2026-08-01', to: '2026-08-31' } }, { now })
  const spend = kpi(mixed, 'purchase_order_amount')
  assert.equal(spend.comparisonValue, null)
  assert.equal(spend.comparisonLabel, 'No figure for the previous period')
})

test('an earlier period with no records gives no change, not a rise from zero', () => {
  const report = buildRuntimeGovernedReport(context([], [so('S2', '2026-08-10', 80)]), { subject: 'sales', comparison: 'previous_period', filters: { from: '2026-08-01', to: '2026-08-31' } }, { now })
  for (const id of ['sales_order_count', 'sales_order_amount']) {
    assert.equal(kpi(report, id).comparisonValue, null, id)
    assert.equal(kpi(report, id).comparisonLabel, 'No figure for the previous period', id)
  }
  const both = buildRuntimeGovernedReport(context([], [so('S1', '2026-07-05', 40), so('S2', '2026-08-10', 80), so('S3', '2026-08-12', 20)]), { subject: 'sales', comparison: 'previous_period', filters: { from: '2026-08-01', to: '2026-08-31' } }, { now })
  assert.equal(kpi(both, 'sales_order_count').comparisonDelta, 1)
  assert.equal(kpi(both, 'sales_order_count').comparisonRate, 100)
  assert.equal(kpi(both, 'sales_order_amount').comparisonValue, 40)
})
