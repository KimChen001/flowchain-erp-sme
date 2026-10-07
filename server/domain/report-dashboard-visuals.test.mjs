import test from 'node:test'
import assert from 'node:assert/strict'
import { buildRuntimeGovernedReport } from './runtime-report-read-model.mjs'
import { invoiceMatchOutcome } from './report-dashboard-visuals.mjs'
import { buildOpenPurchaseOrdersReport } from './open-purchase-orders-report.mjs'
import { buildSupplierScorecard, scorecardParameters } from './supplier-scorecard.mjs'

const context = (overrides = {}) => ({
  purchaseOrders: [], salesOrders: [], supplierInvoices: [], suppliers: [], customers: [], items: [],
  inventoryItems: [], purchaseRequests: [], rfqs: [], receipts: [], warehouses: [], bins: [],
  itemSupplierRelationships: [], dataLimitations: [], ...overrides,
})
const line = (sku, ordered, received, unitPrice) => ({ sku, itemName: `${sku} item`, orderedQuantity: ordered, receivedQuantity: received, unitPrice, amount: ordered * unitPrice })
const po = (id, supplierName, status, lines, extra = {}) => ({ id, supplierName, status, currency: 'USD', totalAmount: lines.reduce((sum, row) => sum + row.amount, 0), createdAt: '2026-09-02T12:00:00.000Z', expectedDate: '2026-09-20T00:00:00.000Z', lines, ...extra })
const receipt = (id, poId, supplierName, arrivedAt, rejectedQty = 0) => ({ id, poId, supplierName, status: 'received', arrivedAt, lines: [{ acceptedQty: 10, rejectedQty }] })
const invoice = (id, poId, supplierName, status, matchStatus, amount, extra = {}) => ({ id, invoiceNumber: id, poId, supplierName, status, matchStatus, totalAmount: amount, amount, currency: 'USD', invoiceDate: '2026-09-15T12:00:00.000Z', lines: [{ amount }], ...extra })
const chart = (report, id) => report.charts.find(item => item.id === id)
const kpi = (report, id) => report.kpis.find(item => item.id === id)

const procurementContext = () => context({
  purchaseOrders: [
    po('PO-1', 'Acme', 'fully_received', [line('A', 10, 10, 10)]),
    po('PO-2', 'Acme', 'partially_received', [line('A', 10, 4, 10), line('B', 5, 0, 20)]),
    po('PO-3', 'Bolt', 'issued', [line('C', 2, 0, 50)], { expectedDate: '2026-09-25T00:00:00.000Z' }),
    po('PO-DRAFT', 'Bolt', 'draft', [line('C', 100, 0, 50)]),
  ],
  receipts: [
    receipt('GRN-1', 'PO-1', 'Acme', '2026-09-18T15:00:00.000Z'),
    receipt('GRN-2', 'PO-2', 'Acme', '2026-09-22T15:00:00.000Z', 2),
  ],
  supplierInvoices: [
    invoice('INV-1', 'PO-1', 'Acme', 'matched', 'matched', 100),
    invoice('INV-DRAFT', 'PO-2', 'Acme', 'draft', 'pending', 999),
  ],
})

test('the purchase order lifecycle narrows stage by stage over committed orders only', () => {
  const report = buildRuntimeGovernedReport(procurementContext(), { subject: 'procurement' })
  assert.deepEqual(chart(report, 'procurement_lifecycle').data, [
    { name: 'Committed', value: 3 },
    { name: 'Receiving started', value: 2 },
    { name: 'Fully received', value: 1 },
    { name: 'Invoiced', value: 1 },
    { name: 'Invoice matched', value: 1 },
  ])
})

test('the value bridge steps from ordered to received to invoiced net line value', () => {
  const report = buildRuntimeGovernedReport(procurementContext(), { subject: 'procurement' })
  const bridge = chart(report, 'procurement_value_bridge')
  // Ordered 100 + 200 + 100 = 400; received 100 + 40 = 140; invoiced 100. The draft order and invoice are left out.
  assert.deepEqual(bridge.data, [
    { name: 'Ordered', value: 400 },
    { name: 'Not yet received', value: -260 },
    { name: 'Received', value: 140 },
    { name: 'Received, not invoiced', value: -40 },
    { name: 'Invoiced', value: 100 },
  ])
  assert.deepEqual(bridge.totals, ['Ordered', 'Received', 'Invoiced'])
  assert.equal(bridge.currencyCode, 'USD')
})

test('spend concentration sorts suppliers and carries the running share', () => {
  const report = buildRuntimeGovernedReport(procurementContext(), { subject: 'procurement' })
  assert.deepEqual(chart(report, 'procurement_supplier_pareto').data, [
    { name: 'Acme', value: 300, filterValue: 'Acme', 'Cumulative share': 75 },
    { name: 'Bolt', value: 100, filterValue: 'Bolt', 'Cumulative share': 100 },
  ])
  const trend = chart(report, 'procurement_spend_trend')
  assert.deepEqual(trend.data, [{ name: '2026-09', 'Committed amount': 400, 'Purchase orders': 3 }])
  assert.deepEqual(trend.measures.map(item => [item.key, item.kind, item.axis]), [['Committed amount', 'bar', 0], ['Purchase orders', 'line', 1]])
  assert.deepEqual(chart(report, 'procurement_spend_treemap').breakdown.Acme, [{ name: 'A item', value: 200 }, { name: 'B item', value: 100 }])
})

test('suppliers beyond the first twelve fold into one bar that does not filter', () => {
  const purchaseOrders = Array.from({ length: 14 }, (_, index) => po(`PO-${index}`, `Supplier ${String(index).padStart(2, '0')}`, 'issued', [line('A', 1, 0, 100 - index)]))
  const pareto = chart(buildRuntimeGovernedReport(context({ purchaseOrders }), { subject: 'procurement' }), 'procurement_supplier_pareto')
  assert.equal(pareto.data.length, 13)
  assert.deepEqual(pareto.data.at(-1), { name: 'Other suppliers', value: 88 + 87, filterValue: '', 'Cumulative share': 100 })
})

test('amounts in different currencies are counted, not added', () => {
  const mixed = procurementContext()
  mixed.purchaseOrders[2].currency = 'EUR'
  const report = buildRuntimeGovernedReport(mixed, { subject: 'procurement' })
  const trend = chart(report, 'procurement_spend_trend')
  assert.deepEqual(trend.data, [{ name: '2026-09', 'Purchase orders': 3 }])
  assert.deepEqual(trend.limitations, ['multi_currency_unconverted'])
  assert.equal(chart(report, 'procurement_supplier_pareto').unit, 'number')
  assert.deepEqual(chart(report, 'procurement_value_bridge').data, [])
  assert.equal(chart(report, 'procurement_value_bridge').emptyState, 'Select a currency to compare amounts.')
  assert.equal(kpi(report, 'purchase_order_amount').trend, null)

  const usd = buildRuntimeGovernedReport(mixed, { subject: 'procurement', filters: { currency: 'USD' } })
  assert.deepEqual(chart(usd, 'procurement_spend_trend').data, [{ name: '2026-09', 'Committed amount': 300, 'Purchase orders': 2 }])
  assert.equal(chart(usd, 'procurement_value_bridge').data[0].value, 300)
})

test('a missing line price hides the value bridge instead of counting it as zero', () => {
  const data = procurementContext()
  data.purchaseOrders[1].lines[1].unitPrice = null
  const bridge = chart(buildRuntimeGovernedReport(data, { subject: 'procurement' }), 'procurement_value_bridge')
  assert.deepEqual(bridge.data, [])
  assert.deepEqual(bridge.limitations, ['amount_missing'])
})

// Six Acme lines on one PO first promised for 09-20: four arrived on time, one
// late, and one only has an unposted receipt, so it is still undelivered past
// its promise. The scorecard counts deliveries (one PO, one promised date), so
// they are one late delivery. Bolt has two lines, one delivery. Both are below
// the five-delivery minimum sample.
const promiseLine = (id, extra = {}) => ({ id, sku: 'A', itemName: 'A item', unit: 'pcs', orderedQuantity: 10, receivedQuantity: 0, unitPrice: 10, amount: 100, originalPromisedDate: '2026-09-20', ...extra })
const postedReceipt = (id, poId, supplierName, arrivedAt, lineIds, postingStatus = 'posted') => ({ id, poId, supplierName, status: 'received', postingStatus, arrivedAt, lines: lineIds.map(lineId => ({ purchaseOrderLineId: lineId, acceptedQty: 10, rejectedQty: 0 })) })
const scorecardContext = () => context({
  purchaseOrders: [
    po('PO-A', 'Acme', 'issued', ['L1', 'L2', 'L3', 'L4', 'L5', 'L6'].map(id => promiseLine(id)), { supplierId: 'SUP-ACME', expectedDate: '2026-09-25T00:00:00.000Z' }),
    po('PO-B', 'Bolt', 'approved', ['B1', 'B2'].map(id => promiseLine(id)), { supplierId: 'SUP-BOLT' }),
    po('PO-DRAFT', 'Acme', 'draft', ['D1', 'D2', 'D3', 'D4', 'D5'].map(id => promiseLine(id)), { supplierId: 'SUP-ACME' }),
  ],
  receipts: [
    postedReceipt('GRN-1', 'PO-A', 'Acme', '2026-09-18T15:00:00.000Z', ['L1', 'L2', 'L3', 'L4']),
    postedReceipt('GRN-2', 'PO-A', 'Acme', '2026-09-22T15:00:00.000Z', ['L5']),
    postedReceipt('GRN-DRAFT', 'PO-A', 'Acme', '2026-09-18T15:00:00.000Z', ['L6'], 'unposted'),
    postedReceipt('GRN-B', 'PO-B', 'Bolt', '2026-09-19T15:00:00.000Z', ['B1', 'B2']),
  ],
})
// Six Acme deliveries first promised for 09-20, on six POs of one or two
// lines: four on time; PO-A3 late, its second line two days after the
// promise; PO-A5 only has an unposted receipt, so it is still undelivered past
// its promise. Bolt has one delivery, below the minimum sample.
const deliveriesContext = () => context({
  purchaseOrders: [
    po('PO-A1', 'Acme', 'issued', ['A1a', 'A1b'].map(id => promiseLine(id)), { supplierId: 'SUP-ACME', expectedDate: '2026-09-25T00:00:00.000Z' }),
    po('PO-A2', 'Acme', 'issued', [promiseLine('A2')], { supplierId: 'SUP-ACME' }),
    po('PO-A3', 'Acme', 'issued', ['A3a', 'A3b'].map(id => promiseLine(id)), { supplierId: 'SUP-ACME' }),
    po('PO-A4', 'Acme', 'issued', [promiseLine('A4')], { supplierId: 'SUP-ACME' }),
    po('PO-A5', 'Acme', 'issued', [promiseLine('A5')], { supplierId: 'SUP-ACME' }),
    po('PO-A6', 'Acme', 'partially_received', ['A6a', 'A6b'].map(id => promiseLine(id)), { supplierId: 'SUP-ACME' }),
    po('PO-B', 'Bolt', 'approved', ['B1', 'B2'].map(id => promiseLine(id)), { supplierId: 'SUP-BOLT' }),
    po('PO-DRAFT', 'Acme', 'draft', ['D1', 'D2', 'D3', 'D4', 'D5'].map(id => promiseLine(id)), { supplierId: 'SUP-ACME' }),
  ],
  receipts: [
    postedReceipt('GRN-A1', 'PO-A1', 'Acme', '2026-09-18T15:00:00.000Z', ['A1a', 'A1b']),
    postedReceipt('GRN-A2', 'PO-A2', 'Acme', '2026-09-18T15:00:00.000Z', ['A2']),
    postedReceipt('GRN-A3a', 'PO-A3', 'Acme', '2026-09-18T15:00:00.000Z', ['A3a']),
    postedReceipt('GRN-A3b', 'PO-A3', 'Acme', '2026-09-22T15:00:00.000Z', ['A3b']),
    postedReceipt('GRN-A4', 'PO-A4', 'Acme', '2026-09-19T15:00:00.000Z', ['A4']),
    postedReceipt('GRN-A5', 'PO-A5', 'Acme', '2026-09-18T15:00:00.000Z', ['A5'], 'unposted'),
    postedReceipt('GRN-A6', 'PO-A6', 'Acme', '2026-09-18T15:00:00.000Z', ['A6a', 'A6b']),
    postedReceipt('GRN-B', 'PO-B', 'Bolt', '2026-09-19T15:00:00.000Z', ['B1', 'B2']),
  ],
})
const asOf = { now: new Date('2026-10-05T16:00:00.000Z'), timeZone: 'America/New_York' }
// The share of a scorecard's deliveries on time, as a percentage.
const onTimeShare = deliveries => Math.round(deliveries.filter(row => row.onTime).length / deliveries.length * 1000) / 10

test('on time follows the supplier scorecard: deliveries against the original promise, posted receipts and at least five deliveries', () => {
  // The six Acme lines on PO-A are one late delivery, Bolt's two lines one on
  // time: two deliveries, below the minimum, so no rate and the reason.
  const few = buildRuntimeGovernedReport(scorecardContext(), { subject: 'procurement' }, asOf)
  assert.deepEqual(['currentValue', 'dataStatus', 'limitations'].map(key => kpi(few, 'on_time_receipt_rate')[key]), [null, 'incomplete', ['insufficient_sample']])
  const fewScorecard = buildSupplierScorecard({ purchaseOrders: scorecardContext().purchaseOrders, receipts: scorecardContext().receipts.filter(row => row.postingStatus === 'posted'), period: { from: '2026-09-01', to: '2026-09-30' }, asOfDay: '2026-10-05', timeZone: 'America/New_York' })
  assert.deepEqual(fewScorecard.suppliers.map(row => [row.supplierId, row.sampleSize, row.lineCount, row.metrics.onTime.count]), [['SUP-ACME', 1, 6, 0], ['SUP-BOLT', 1, 2, 1]])

  const report = buildRuntimeGovernedReport(deliveriesContext(), { subject: 'procurement' }, asOf)
  const onTime = kpi(report, 'on_time_receipt_rate')
  // 4 of the 6 Acme deliveries and Bolt's one: 5 of 7. The unposted receipt does not count.
  assert.equal(onTime.currentValue, 71.4)
  assert.equal(onTime.label, 'On-time deliveries (date on the PO)')
  assert.equal(onTime.unit, 'percentage')
  // The same deliveries on the supplier scorecard give the same rate.
  const data = deliveriesContext()
  const scorecard = buildSupplierScorecard({ purchaseOrders: data.purchaseOrders.filter(row => row.status !== 'draft'), receipts: data.receipts.filter(row => row.postingStatus === 'posted'), period: { from: '2026-09-01', to: '2026-09-30' }, asOfDay: '2026-10-05', timeZone: 'America/New_York' })
  assert.equal(onTime.currentValue, onTimeShare(scorecard.suppliers.flatMap(row => row.obligations)))
  assert.equal(kpi(buildRuntimeGovernedReport(data, { subject: 'procurement', filters: { supplier: 'Acme' } }, asOf), 'on_time_receipt_rate').currentValue, Math.round(scorecard.suppliers.find(row => row.supplierId === 'SUP-ACME').metrics.onTime.rate * 1000) / 10)

  // One delivery is below the minimum sample: no rate, and the reason.
  const bolt = kpi(buildRuntimeGovernedReport(deliveriesContext(), { subject: 'procurement', filters: { supplier: 'Bolt' } }, asOf), 'on_time_receipt_rate')
  assert.equal(bolt.currentValue, null)
  assert.deepEqual(bolt.limitations, ['insufficient_sample'])
  assert.equal(bolt.dataStatus, 'incomplete')
  // The date range applies to the original promise, not the order date.
  const october = kpi(buildRuntimeGovernedReport(deliveriesContext(), { subject: 'procurement', filters: { from: '2026-10-01', to: '2026-10-31' } }, asOf), 'on_time_receipt_rate')
  assert.equal(october.currentValue, null)
  assert.equal(october.dataStatus, 'no_records')
  // Receipts per arrival day still show every receipt that is not void.
  assert.deepEqual(chart(few, 'procurement_receipt_calendar').data, [{ name: '2026-09-18', value: 2 }, { name: '2026-09-19', value: 1 }, { name: '2026-09-22', value: 1 }])
})

test('a line without an original promise is not measured', () => {
  const data = scorecardContext()
  for (const line of data.purchaseOrders[0].lines) line.originalPromisedDate = null
  const report = buildRuntimeGovernedReport(data, { subject: 'procurement', filters: { supplier: 'Acme' } }, asOf)
  assert.equal(kpi(report, 'on_time_receipt_rate').currentValue, null)
  assert.equal(kpi(report, 'on_time_receipt_rate').dataStatus, 'no_records')
})

test('a delivery with a line not yet due waits on the dashboard as on the scorecard', () => {
  // Five on-time Acme deliveries promised 09-20 and a sixth promised 10-06 with
  // one line in early and one not yet due: the sixth is not judged yet.
  const data = deliveriesContext()
  data.receipts = data.receipts.map(row => row.id === 'GRN-A5' ? { ...row, postingStatus: 'posted' } : row.id === 'GRN-A3b' ? { ...row, arrivedAt: '2026-09-20T15:00:00.000Z' } : row)
  data.purchaseOrders.push(po('PO-A7', 'Acme', 'issued', ['A7a', 'A7b'].map(id => promiseLine(id, { originalPromisedDate: '2026-10-06' })), { supplierId: 'SUP-ACME' }))
  data.receipts.push(postedReceipt('GRN-A7', 'PO-A7', 'Acme', '2026-10-01T15:00:00.000Z', ['A7a']))
  const report = buildRuntimeGovernedReport(data, { subject: 'suppliers', filters: { from: '2026-09-01', to: '2026-10-31' } }, asOf)
  const scorecard = buildSupplierScorecard({ purchaseOrders: data.purchaseOrders, receipts: data.receipts.filter(row => row.postingStatus === 'posted'), period: { from: '2026-09-01', to: '2026-10-31' }, asOfDay: '2026-10-05', timeZone: 'America/New_York' })
  const acme = scorecard.suppliers.find(row => row.supplierId === 'SUP-ACME')
  assert.deepEqual([acme.sampleSize, acme.metrics.onTime.count], [6, 6])
  assert.deepEqual(chart(report, 'supplier_on_time').data, [{ name: 'Acme', value: 100, filterValue: 'Acme' }])
  assert.equal(chart(report, 'supplier_performance_matrix').data[0].Deliveries, 6)
})

// The supplier page shows the scorecard table and the dashboard together, so
// both measure the same deliveries: the same period (the scorecard's 90 days to
// today when none is chosen), grace days, purchase orders and receipts.
test('the supplier dashboard and the scorecard measure the same deliveries for the same period', () => {
  const data = deliveriesContext()
  // Approved, given its original promise at approval, then cancelled before
  // issue: the buyer called it off, so its lines are not late on either side.
  data.purchaseOrders.push(po('PO-CANCELLED', 'Acme', 'cancelled', ['C1', 'C2', 'C3', 'C4', 'C5'].map(id => promiseLine(id, { originalPromisedDate: '2026-09-10' })), { supplierId: 'SUP-ACME' }))
  const scorecardFor = (query, receipts = data.receipts) => buildSupplierScorecard({ purchaseOrders: data.purchaseOrders, receipts: receipts.filter(row => row.postingStatus === 'posted'), ...scorecardParameters(query, '2026-10-05'), asOfDay: '2026-10-05', timeZone: 'America/New_York' })
  const rateOf = (scorecard, supplierId) => Math.round(scorecard.suppliers.find(row => row.supplierId === supplierId).metrics.onTime.rate * 1000) / 10
  const overall = scorecard => onTimeShare(scorecard.suppliers.flatMap(row => row.obligations))

  const report = buildRuntimeGovernedReport(data, { subject: 'suppliers' }, asOf)
  assert.deepEqual([report.dataScope.from, report.dataScope.to], ['2026-07-08', '2026-10-05'])
  assert.deepEqual(scorecardFor({}).period, { from: '2026-07-08', to: '2026-10-05' })
  assert.equal(kpi(report, 'on_time_receipt_rate').currentValue, overall(scorecardFor({})))
  assert.equal(kpi(report, 'on_time_receipt_rate').currentValue, 71.4)
  assert.deepEqual(chart(report, 'supplier_on_time').data, [{ name: 'Acme', value: rateOf(scorecardFor({}), 'SUP-ACME'), filterValue: 'Acme' }])
  assert.equal(chart(report, 'supplier_on_time').data[0].value, 66.7)

  // Grace days from the page move both: PO-A3's second line arrived two days after its promise.
  const grace = buildRuntimeGovernedReport(data, { subject: 'suppliers', filters: { graceDays: '3' } }, asOf)
  assert.equal(chart(grace, 'supplier_on_time').data[0].value, rateOf(scorecardFor({ graceDays: '3' }), 'SUP-ACME'))
  assert.equal(chart(grace, 'supplier_on_time').data[0].value, 83.3)

  // A reader limited to one warehouse counts the receipts there, as the scorecard does.
  data.receipts = data.receipts.map(row => ({ ...row, warehouseId: row.id === 'GRN-A4' ? 'WH-2' : 'WH-1' }))
  const scoped = buildRuntimeGovernedReport(data, { subject: 'suppliers' }, { ...asOf, warehouseIds: ['WH-1'] })
  assert.equal(chart(scoped, 'supplier_on_time').data[0].value, rateOf(scorecardFor({}, data.receipts.filter(row => row.warehouseId === 'WH-1')), 'SUP-ACME'))
  assert.equal(chart(scoped, 'supplier_on_time').data[0].value, 50)

  // The scorecard has no currency filter, so a currency picked on the page
  // leaves the on-time figures alone: one more Acme delivery of five lines, in EUR, late.
  const euro = deliveriesContext()
  euro.purchaseOrders.push(po('PO-EUR', 'Acme', 'issued', ['E1', 'E2', 'E3', 'E4', 'E5'].map(id => promiseLine(id)), { supplierId: 'SUP-ACME', currency: 'EUR' }))
  euro.receipts.push(postedReceipt('GRN-EUR', 'PO-EUR', 'Acme', '2026-09-28T15:00:00.000Z', ['E1', 'E2', 'E3', 'E4', 'E5']))
  const euroScorecard = buildSupplierScorecard({ purchaseOrders: euro.purchaseOrders, receipts: euro.receipts.filter(row => row.postingStatus === 'posted'), ...scorecardParameters({}, '2026-10-05'), asOfDay: '2026-10-05', timeZone: 'America/New_York' })
  for (const currency of ['EUR', 'USD', '']) {
    const filtered = buildRuntimeGovernedReport(euro, { subject: 'suppliers', filters: { currency } }, asOf)
    assert.equal(chart(filtered, 'supplier_on_time').data.find(row => row.name === 'Acme').value, rateOf(euroScorecard, 'SUP-ACME'), currency)
    assert.equal(kpi(filtered, 'on_time_receipt_rate').currentValue, overall(euroScorecard), currency)
  }
  assert.equal(rateOf(euroScorecard, 'SUP-ACME'), 57.1)
})

// Owner decision 2026-10-06: an order approved but never sent to the supplier,
// with nothing received, is not measured on the dashboards either, so they
// keep the scorecard's figures. Bolt's approved PO-B has a posted receipt, so
// it counts.
test('the dashboards leave out an approved order never sent to the supplier, as the scorecard does', () => {
  const data = deliveriesContext()
  data.purchaseOrders.push(po('PO-UNSENT', 'Acme', 'approved', [promiseLine('U1')], { supplierId: 'SUP-ACME', metadata: { transmissionStatus: 'not_sent' } }))
  const scorecard = buildSupplierScorecard({ purchaseOrders: data.purchaseOrders, receipts: data.receipts.filter(row => row.postingStatus === 'posted'), ...scorecardParameters({}, '2026-10-05'), asOfDay: '2026-10-05', timeZone: 'America/New_York' })
  const acme = scorecard.suppliers.find(row => row.supplierId === 'SUP-ACME')
  assert.deepEqual([acme.sampleSize, acme.metrics.onTime.count, acme.notSentCount, acme.notSentPurchaseOrders[0].purchaseOrderId], [6, 4, 1, 'PO-UNSENT'])
  assert.deepEqual(scorecard.suppliers.find(row => row.supplierId === 'SUP-BOLT').sampleSize, 1)
  const report = buildRuntimeGovernedReport(data, { subject: 'suppliers' }, asOf)
  assert.equal(kpi(report, 'on_time_receipt_rate').currentValue, 71.4)
  assert.equal(chart(report, 'supplier_on_time').data[0].value, 66.7)
  assert.equal(kpi(buildRuntimeGovernedReport(data, { subject: 'procurement' }, asOf), 'on_time_receipt_rate').currentValue, 71.4)
  // Once issued it is a delivery like any other: past its promise with nothing received, late.
  data.purchaseOrders.at(-1).metadata = { transmissionStatus: 'issued_outside_flowchain', issuedAt: '2026-09-10T14:00:00.000Z' }
  const issued = buildRuntimeGovernedReport(data, { subject: 'suppliers' }, asOf)
  assert.equal(kpi(issued, 'on_time_receipt_rate').currentValue, 62.5)
  assert.equal(chart(issued, 'supplier_on_time').data[0].value, 57.1)
})

// A posted receipt in a warehouse the reader cannot see still means the
// supplier got the order, even when every unit was rejected: the order is a
// delivery for every reader, judged on the receipts each may see.
test('an approved order with a fully rejected receipt in another warehouse is measured for every reader', () => {
  const data = deliveriesContext()
  data.purchaseOrders.push(po('PO-X', 'Acme', 'approved', [promiseLine('X1')], { supplierId: 'SUP-ACME', metadata: { transmissionStatus: 'not_sent' } }))
  data.receipts.push({ ...postedReceipt('GRN-X', 'PO-X', 'Acme', '2026-09-28T15:00:00.000Z', []), warehouseId: 'WH-2', lines: [{ purchaseOrderLineId: 'X1', acceptedQty: 0, rejectedQty: 10 }] })
  for (const options of [asOf, { ...asOf, warehouseIds: ['WH-1'] }]) {
    const report = buildRuntimeGovernedReport(data, { subject: 'suppliers' }, options)
    assert.equal(kpi(report, 'on_time_receipt_rate').currentValue, 62.5, JSON.stringify(options.warehouseIds))
    assert.equal(chart(report, 'supplier_on_time').data[0].value, 57.1, JSON.stringify(options.warehouseIds))
  }
})

test('on time is not measured from receipts the reader cannot see or that were not all loaded', () => {
  const restricted = buildRuntimeGovernedReport({ ...scorecardContext(), receipts: [], restrictedSubjects: ['receipts'] }, { subject: 'suppliers' }, asOf)
  assert.equal(kpi(restricted, 'on_time_receipt_rate').dataStatus, 'restricted')
  // Without receipts every line past its promise would read as late (0%).
  for (const id of ['supplier_on_time', 'supplier_performance_matrix']) {
    assert.deepEqual(chart(restricted, id).data, [])
    assert.equal(chart(restricted, id).emptyState, 'Your role cannot view receipts.')
  }
  assert.ok(!chart(restricted, 'supplier_scorecard').seriesKeys.includes('On-time deliveries'))

  // Receipts are read newest first up to a limit: an older receipt left out
  // would make its line late, so the rate is withheld and says why.
  const truncated = buildRuntimeGovernedReport({ ...scorecardContext(), truncatedSubjects: [{ subject: 'receipts', limit: 500 }] }, { subject: 'suppliers' }, asOf)
  const onTime = kpi(truncated, 'on_time_receipt_rate')
  assert.deepEqual([onTime.currentValue, onTime.dataStatus, onTime.limitations], [null, 'incomplete', ['receipts_truncated']])
  assert.deepEqual(chart(truncated, 'supplier_on_time').data, [])
  assert.match(chart(truncated, 'supplier_on_time').emptyState, /Not every receipt could be loaded/)
})

test('the supplier dashboard does not measure on time over a range the scorecard refuses', () => {
  // 2023-01-01 to 2026-10-05 is longer than the scorecard's 731 days.
  assert.throws(() => scorecardParameters({ from: '2023-01-01', to: '2026-10-05' }, '2026-10-05'), error => error.code === 'SCORECARD_PERIOD_TOO_LONG' && error.details[0].maxDays === 731)
  const long = buildRuntimeGovernedReport(scorecardContext(), { subject: 'suppliers', filters: { from: '2023-01-01', to: '2026-10-05' } }, asOf)
  const onTime = kpi(long, 'on_time_receipt_rate')
  assert.deepEqual([onTime.currentValue, onTime.dataStatus, onTime.limitations], [null, 'incomplete', ['period_too_long']])
  for (const id of ['supplier_on_time', 'supplier_performance_matrix']) {
    assert.deepEqual(chart(long, id).data, [])
    assert.match(chart(long, id).emptyState, /longer than the supplier scorecard allows/)
  }
  // The longest range the scorecard accepts is still measured, and other
  // dashboards keep any range.
  const longest = buildRuntimeGovernedReport(deliveriesContext(), { subject: 'suppliers', filters: { from: '2024-10-05', to: '2026-10-05' } }, asOf)
  assert.equal(kpi(longest, 'on_time_receipt_rate').currentValue, 71.4)
  assert.equal(kpi(buildRuntimeGovernedReport(deliveriesContext(), { subject: 'procurement', filters: { from: '2023-01-01', to: '2026-10-05' } }, asOf), 'on_time_receipt_rate').currentValue, 71.4)
})

test('overdue open purchase orders count to the workspace calendar day', () => {
  const data = procurementContext()
  // 2026-09-21 01:00 UTC is still 2026-09-20 in New York, so PO-2 (expected 09-20) is not overdue there yet.
  const now = new Date('2026-09-21T01:00:00.000Z')
  assert.equal(kpi(buildRuntimeGovernedReport(data, { subject: 'procurement' }, { now, timeZone: 'America/New_York' }), 'overdue_open_po_count').currentValue, 0)
  assert.equal(kpi(buildRuntimeGovernedReport(data, { subject: 'procurement' }, { now, timeZone: 'UTC' }), 'overdue_open_po_count').currentValue, 1)
})

test('three-way match outcomes come from the recorded match status', () => {
  assert.equal(invoiceMatchOutcome({ status: 'matched', matchStatus: 'matched' }), 'matched')
  assert.equal(invoiceMatchOutcome({ status: 'exception', matchStatus: 'exception' }), 'exception')
  assert.equal(invoiceMatchOutcome({ status: 'exception', matchStatus: 'variance' }), 'exception')
  assert.equal(invoiceMatchOutcome({ status: 'submitted', matchStatus: 'pending' }), 'pending')
  assert.equal(invoiceMatchOutcome({ status: 'approved', matchStatus: null }), 'matched')
  assert.equal(invoiceMatchOutcome({ status: 'submitted' }), 'pending')
})

test('finance visuals cover submitted invoices only and keep match counts consistent', () => {
  const data = context({
    supplierInvoices: [
      invoice('INV-1', 'PO-1', 'Acme', 'matched', 'matched', 100),
      invoice('INV-2', 'PO-2', 'Acme', 'exception', 'exception', 50, { varianceAmount: -12.5 }),
      invoice('INV-3', 'PO-3', 'Bolt', 'submitted', 'pending', 80),
      invoice('INV-4', 'PO-3', 'Bolt', 'matched', 'matched', 20),
      invoice('INV-DRAFT', 'PO-3', 'Bolt', 'draft', 'pending', 999),
    ],
  })
  const report = buildRuntimeGovernedReport(data, { subject: 'finance' })
  assert.equal(kpi(report, 'invoice_amount').currentValue, 250)
  assert.equal(kpi(report, 'invoice_match_rate').currentValue, 50)
  assert.equal(kpi(report, 'invoices_awaiting_match').currentValue, 1)
  assert.equal(kpi(report, 'invoices_with_exception').currentValue, 1)
  const gauge = chart(report, 'finance_match_rate')
  assert.deepEqual(gauge.data, [{ name: 'Invoices matched', value: 50 }])
  assert.deepEqual(gauge.detail, { count: 2, total: 4, exception: 1, pending: 1 })
  assert.deepEqual(chart(report, 'finance_match_outcome').data, [{ name: 'Matched', value: 2 }, { name: 'Match exception', value: 1 }, { name: 'Awaiting match', value: 1 }])
  const flow = chart(report, 'finance_invoice_flow')
  assert.equal(flow.links.reduce((sum, row) => sum + row.value, 0), 4)
  assert.deepEqual(flow.links.find(row => row.source === 'Acme' && row.target === 'Match exception'), { source: 'Acme', target: 'Match exception', value: 1 })
  assert.deepEqual(chart(report, 'finance_variance_by_supplier').data, [{ name: 'Acme', value: 12.5, filterValue: 'Acme' }])
  // The invoice status chart covers every invoice in range, drafts included, so it can filter them.
  assert.equal(chart(report, 'finance_invoice_status').data.reduce((sum, row) => sum + row.value, 0), 5)
})

test('sales fulfillment leaves drafts and cancellations out and adds demand only within a SKU', () => {
  const order = (id, workflowStatus, sku, orderedQty, fulfilledQty, reservedQty = 0) => ({ id, salesOrderId: id, workflowStatus, status: workflowStatus, customerName: 'Northwind', sku, orderedQty, fulfilledQty, reservedQty, totalAmount: orderedQty * 10, currency: 'USD', orderDate: '2026-09-05' })
  const data = context({ salesOrders: [order('SO-1', 'confirmed', 'A', 10, 10), order('SO-2', 'confirmed', 'A', 10, 4), order('SO-3', 'confirmed', 'B', 5, 0, 5), order('SO-4', 'confirmed', 'B', 5, 0), order('SO-D', 'draft', 'B', 50, 0), order('SO-X', 'cancelled', 'A', 50, 0)] })
  const report = buildRuntimeGovernedReport(data, { subject: 'sales' })
  assert.deepEqual(chart(report, 'sales_fulfillment').data, [
    { name: 'Active orders', value: 4 },
    { name: 'Reserved or shipped', value: 3 },
    { name: 'Shipped', value: 2 },
    { name: 'Shipped in full', value: 1 },
  ])
  assert.deepEqual(chart(report, 'sales_open_demand').data, [{ name: 'B', value: 10 }, { name: 'A', value: 6 }])
  assert.equal(kpi(report, 'order_fulfillment_rate').currentValue, 25)
  assert.equal(kpi(report, 'sales_order_amount').currentValue, 300)
})

test('inventory visuals keep each SKU in its own unit and sort short SKUs first', () => {
  const data = context({
    items: [{ sku: 'A', safetyStock: 10 }, { sku: 'B', safetyStock: 0 }, { sku: 'C', safetyStock: 0 }],
    inventoryItems: [{ sku: 'A', onHandQuantity: 4, reservedQuantity: 0, unit: 'pcs' }, { sku: 'B', onHandQuantity: 0, reservedQuantity: 0, unit: 'pcs' }, { sku: 'C', onHandQuantity: 7, reservedQuantity: 0, unit: 'pcs' }],
    salesOrders: [{ id: 'SO-1', salesOrderId: 'SO-1', workflowStatus: 'confirmed', sku: 'B', orderedQty: 3, fulfilledQty: 0, reservedQty: 0, lines: [{ sku: 'B', orderedQuantity: 3, reservedQuantity: 0, fulfilledQuantity: 0 }] }],
  })
  const report = buildRuntimeGovernedReport(data, { subject: 'inventory' })
  assert.deepEqual(chart(report, 'inventory_on_hand_by_sku').data, [{ name: 'C', value: 7 }, { name: 'A', value: 4 }, { name: 'B', value: 0 }])
  assert.equal(chart(report, 'inventory_available_to_promise').data[0].name, 'B')
  assert.ok(chart(report, 'inventory_available_to_promise').data[0].value < 0)
  assert.equal(kpi(report, 'negative_atp_sku').currentValue, 1)
  const matrix = chart(report, 'inventory_risk_matrix')
  assert.deepEqual(matrix.data, [
    { name: 'out_of_stock', high: 1, medium: 0, low: 0 },
    { name: 'below_safety_stock', high: 0, medium: 1, low: 0 },
    { name: 'ok', high: 0, medium: 0, low: 1 },
  ])
  // A SKU whose stock is not recorded is counted as unknown, not dropped.
  const unknown = buildRuntimeGovernedReport(context({ inventoryItems: [{ sku: 'X' }] }), { subject: 'inventory' })
  assert.deepEqual(chart(unknown, 'inventory_risk_matrix').data, [{ name: 'unknown', unknown: 1 }])
})

test('the supplier matrix and scorecard use only suppliers with enough deliveries', () => {
  const report = buildRuntimeGovernedReport(deliveriesContext(), { subject: 'suppliers' }, asOf)
  const matrix = chart(report, 'supplier_performance_matrix')
  // Bolt has one delivery, below the minimum sample, so only Acme is placed.
  assert.deepEqual(matrix.data, [{ name: 'Acme', 'Committed amount': 900, 'On-time deliveries': 66.7, Deliveries: 6, filterValue: 'Acme' }])
  assert.deepEqual(matrix.guides, { x: 900, y: 66.7 })
  assert.deepEqual(chart(report, 'supplier_on_time').data, [{ name: 'Acme', value: 66.7, filterValue: 'Acme' }])
  assert.equal(kpi(report, 'active_supplier_count').currentValue, 2)
  const scorecard = chart(report, 'supplier_scorecard')
  assert.deepEqual(scorecard.seriesKeys, ['On-time deliveries', 'Lines accepted in full', 'Share of spend'])
  assert.deepEqual(scorecard.data, [{ name: 'Acme', 'On-time deliveries': 66.7, 'Lines accepted in full': 100, 'Share of spend': 81.8 }])
  // On one PO the six Acme lines are one delivery: no supplier has enough.
  const few = buildRuntimeGovernedReport(scorecardContext(), { subject: 'suppliers' }, asOf)
  assert.deepEqual(chart(few, 'supplier_performance_matrix').data, [])
  assert.equal(chart(few, 'supplier_on_time').emptyState, 'No supplier has 5 or more deliveries first promised in the selected range.')
})

test('overdue counts the earliest open line, as the open purchase orders report does', () => {
  // The header date is 10-10, an open line was due 10-01 and a received line 09-20.
  const order = po('PO-LATE', 'Acme', 'partially_received', [
    { ...line('A', 10, 0, 10), promisedDate: '2026-10-01' },
    { ...line('B', 10, 10, 10), promisedDate: '2026-09-20' },
  ], { expectedDate: '2026-10-10T00:00:00.000Z' })
  const now = new Date('2026-10-05T16:00:00.000Z')
  const report = buildRuntimeGovernedReport(context({ purchaseOrders: [order] }), { subject: 'procurement' }, { now, timeZone: 'America/New_York' })
  const page = buildOpenPurchaseOrdersReport([order], {}, now, { timeZone: 'America/New_York' })
  assert.equal(page.rows[0].dueDate, '2026-10-01')
  assert.equal(page.summary.overdue, 1)
  assert.equal(kpi(report, 'overdue_open_po_count').currentValue, page.summary.overdue)
  // The KPI drills into the page's overdue scope.
  assert.equal(kpi(report, 'overdue_open_po_count').drilldownPath, '/app/reports/procurement?scope=overdue')
})

test('KPI sparklines need two dated months and a single currency', () => {
  const data = procurementContext()
  data.purchaseOrders[0].createdAt = '2026-08-12T12:00:00.000Z'
  const report = buildRuntimeGovernedReport(data, { subject: 'procurement' })
  assert.deepEqual(kpi(report, 'purchase_order_amount').trend, [{ period: '2026-08', value: 100 }, { period: '2026-09', value: 300 }])
  assert.equal(kpi(buildRuntimeGovernedReport(procurementContext(), { subject: 'procurement' }), 'purchase_order_amount').trend, null)
})

test('the overview keeps its first three charts and adds spend and lifecycle visuals', () => {
  const report = buildRuntimeGovernedReport(procurementContext(), { subject: 'overview' })
  assert.deepEqual(report.charts.map(item => item.id), ['overview_activity', 'overview_status', 'overview_suppliers', 'overview_spend_trend', 'overview_lifecycle'])
})

test('report days follow the workspace timezone around midnight', () => {
  // PO-LATE was entered at 21:00 on Sep 30 in New York (01:00 UTC on Oct 1).
  const data = context({
    purchaseOrders: [
      po('PO-LATE', 'Acme', 'issued', [line('A', 1, 0, 100)], { createdAt: '2026-10-01T01:00:00.000Z', expectedDate: '2026-10-01T00:00:00.000Z' }),
      po('PO-OCT', 'Acme', 'issued', [line('A', 1, 0, 50)], { createdAt: '2026-10-01T04:00:00.000Z', expectedDate: '2026-10-01T00:00:00.000Z' }),
    ],
    receipts: [
      receipt('GRN-BEFORE', 'PO-LATE', 'Acme', '2026-10-01T03:59:00.000Z'),
      receipt('GRN-AFTER', 'PO-OCT', 'Acme', '2026-10-01T04:00:00.000Z'),
    ],
  })
  const newYork = buildRuntimeGovernedReport(data, { subject: 'procurement' }, { timeZone: 'America/New_York' })
  assert.deepEqual(chart(newYork, 'procurement_spend_trend').data, [{ name: '2026-09', 'Committed amount': 100, 'Purchase orders': 1 }, { name: '2026-10', 'Committed amount': 50, 'Purchase orders': 1 }])
  assert.deepEqual(kpi(newYork, 'purchase_order_amount').trend, [{ period: '2026-09', value: 100 }, { period: '2026-10', value: 50 }])
  assert.deepEqual(chart(newYork, 'procurement_receipt_calendar').data, [{ name: '2026-09-30', value: 1 }, { name: '2026-10-01', value: 1 }])
  const october = buildRuntimeGovernedReport(data, { subject: 'procurement', filters: { from: '2026-10-01', to: '2026-10-31' } }, { timeZone: 'America/New_York' })
  assert.deepEqual(october.details.map(row => row.id), ['PO-OCT'])
  // The same records in UTC put both orders and both receipts in October.
  const utc = buildRuntimeGovernedReport(data, { subject: 'procurement' }, { timeZone: 'UTC' })
  assert.deepEqual(chart(utc, 'procurement_spend_trend').data, [{ name: '2026-10', 'Committed amount': 150, 'Purchase orders': 2 }])
  assert.deepEqual(chart(utc, 'procurement_receipt_calendar').data, [{ name: '2026-10-01', value: 2 }])
})

test('open sales demand is booked per line and never added across units or SKUs', () => {
  const order = (id, lines, extra = {}) => ({ id, salesOrderId: id, workflowStatus: 'confirmed', status: 'confirmed', customerName: 'Northwind', currency: 'USD', orderDate: '2026-09-05', reservedQty: 0, lines, ...extra })
  const salesLine = (sku, unit, orderedQuantity, fulfilledQuantity, amount = 10) => ({ sku, unit, orderedQuantity, fulfilledQuantity, reservedQuantity: 0, amount })
  // The order-level sku and quantity summarise the first line and the order
  // total, as the sales repository returns them: LDM-001 with 60.
  const mixed = order('SO-1', [salesLine('LDM-001', 'pcs', 10, 0), salesLine('CAB-9', 'ft', 50, 0)], { sku: 'LDM-001', orderedQty: 60, fulfilledQty: 0 })
  const report = buildRuntimeGovernedReport(context({ salesOrders: [mixed] }), { subject: 'sales' })
  const demand = chart(report, 'sales_open_demand')
  assert.deepEqual(demand.data, [{ name: 'CAB-9 (ft)', value: 50 }, { name: 'LDM-001 (pcs)', value: 10 }])
  assert.deepEqual(demand.units, ['ft', 'pcs'])
  assert.match(demand.description, /not comparable/)
  const total = kpi(report, 'open_sales_demand')
  assert.equal(total.currentValue, null)
  assert.deepEqual(total.limitations, ['sales_demand_units_mixed'])
  assert.equal(total.dataStatus, 'incomplete')
  // The detail row names no single SKU and no quantity across units.
  assert.deepEqual([report.details[0].sku, report.details[0].quantity, report.details[0].unit], ['', null, 'mixed'])

  // One unit but two SKUs: 9 pcs of LDM-001 and 5 pcs of LDM-002 are not one
  // stock figure, so there is no total; the chart shows each SKU.
  const pieces = [order('SO-2', [salesLine('LDM-001', 'pcs', 10, 4), salesLine('LDM-002', 'pcs', 5, 0)]), order('SO-3', [salesLine('LDM-001', 'pcs', 3, 0)])]
  const skus = buildRuntimeGovernedReport(context({ salesOrders: pieces }), { subject: 'sales' })
  assert.equal(kpi(skus, 'open_sales_demand').currentValue, null)
  assert.deepEqual(kpi(skus, 'open_sales_demand').limitations, ['sales_demand_skus_mixed'])
  assert.equal(kpi(skus, 'open_sales_demand').dataStatus, 'incomplete')
  assert.deepEqual(chart(skus, 'sales_open_demand').data, [{ name: 'LDM-001 (pcs)', value: 9 }, { name: 'LDM-002 (pcs)', value: 5 }])
  assert.deepEqual(chart(skus, 'sales_open_demand').units, ['pcs'])
  const so2 = skus.details.find(row => row.id === 'SO-2')
  assert.deepEqual([so2.sku, so2.quantity, so2.unit], ['', null, 'multiple_skus'])
  assert.equal(skus.details.find(row => row.id === 'SO-3').sku, 'LDM-001')

  // One SKU in one unit across lines and orders: a total with its unit.
  const one = [order('SO-4', [salesLine('LDM-001', 'pcs', 10, 4), salesLine('LDM-001', 'pcs', 2, 0)]), order('SO-5', [salesLine('LDM-001', 'pcs', 3, 0)])]
  const single = buildRuntimeGovernedReport(context({ salesOrders: one }), { subject: 'sales' })
  assert.equal(kpi(single, 'open_sales_demand').currentValue, 11)
  assert.equal(kpi(single, 'open_sales_demand').quantityUnit, 'pcs')
  assert.deepEqual(single.details.find(row => row.id === 'SO-4').quantity, 12)
})

test('a purchase order quantity is a total only for one SKU in one unit', () => {
  const poLine = (id, sku, quantity, unit = 'pcs') => ({ id, sku, orderedQuantity: quantity, receivedQuantity: 0, unit })
  const purchaseOrders = [
    { id: 'PO-BOLTS-MOTORS', status: 'issued', currency: 'USD', totalAmount: 100, orderDate: '2026-09-01', supplierName: 'Acme', lines: [poLine('L1', 'BOLT', 10), poLine('L2', 'MOTOR', 5)] },
    { id: 'PO-BOLTS', status: 'issued', currency: 'USD', totalAmount: 50, orderDate: '2026-09-02', supplierName: 'Acme', lines: [poLine('L3', 'BOLT', 10), poLine('L4', 'BOLT', 4)] },
  ]
  const report = buildRuntimeGovernedReport(context({ purchaseOrders }), { subject: 'procurement' })
  const row = id => report.details.find(item => item.id === id)
  assert.deepEqual([row('PO-BOLTS-MOTORS').quantity, row('PO-BOLTS-MOTORS').unit], [null, 'multiple_skus'])
  assert.deepEqual([row('PO-BOLTS').quantity, row('PO-BOLTS').unit], [14, 'pcs'])
  // The open purchase orders report, which the assistant reads, agrees.
  const open = buildOpenPurchaseOrdersReport(purchaseOrders, { scope: 'all' }, new Date('2026-09-10T12:00:00Z'))
  const openRow = id => open.rows.find(item => item.id === id)
  assert.deepEqual([openRow('PO-BOLTS-MOTORS').ordered, openRow('PO-BOLTS-MOTORS').remaining, openRow('PO-BOLTS-MOTORS').unit], [null, null, 'multiple_skus'])
  assert.deepEqual([openRow('PO-BOLTS').ordered, openRow('PO-BOLTS').remaining, openRow('PO-BOLTS').unit], [14, 14, 'pcs'])
})

test('an order is shipped in full only when every line has shipped', () => {
  const order = (id, lines) => ({ id, salesOrderId: id, workflowStatus: 'confirmed', status: 'confirmed', customerName: 'Northwind', currency: 'USD', orderDate: '2026-09-05', reservedQty: 0, lines })
  // SO-1 shipped 10 of 10 pcs but none of its 50 ft: its order-level total
  // (10 of 60) hides that only one line is done. SO-2 shipped every line.
  const report = buildRuntimeGovernedReport(context({ salesOrders: [
    order('SO-1', [{ sku: 'A', unit: 'pcs', orderedQuantity: 10, fulfilledQuantity: 10 }, { sku: 'B', unit: 'ft', orderedQuantity: 50, fulfilledQuantity: 0 }]),
    order('SO-2', [{ sku: 'A', unit: 'pcs', orderedQuantity: 2, fulfilledQuantity: 2 }, { sku: 'B', unit: 'ft', orderedQuantity: 5, fulfilledQuantity: 5 }]),
  ] }), { subject: 'sales' })
  assert.equal(kpi(report, 'order_fulfillment_rate').currentValue, 50)
  assert.deepEqual(chart(report, 'sales_fulfillment').data.map(row => row.value), [2, 2, 2, 1])
})
