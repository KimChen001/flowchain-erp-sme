import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildSupplierScorecard,
  evaluatePromiseLine,
  groupDeliveryObligations,
  scorecardParameters,
  summarizeScorecardLines,
  wilsonInterval,
} from './supplier-scorecard.mjs'
import { WORKED_EXAMPLE_AS_OF, workedExampleRows } from './test-fixtures/supplier-scorecard-worked-example.mjs'

const pct = (value) => value === null ? null : Math.round(value * 1000) / 10
const po = (lines, extra = {}) => ({ id: 'PO-1', supplierId: 'SUP-1', supplierName: 'Summit Supply', currency: 'USD', status: 'partially_received', expectedDate: null, lines, ...extra })
const line = (id, original, extra = {}) => ({ id, sku: 'SKU-1', itemName: 'Sensor', unit: 'pcs', orderedQuantity: 100, amount: 1000, originalPromisedDate: original ? new Date(`${original}T12:00:00Z`) : null, ...extra, metadata: { promisedDate: extra.current || original, ...(extra.metadata || {}) } })
const receipt = (day, accepted, rejected = 0, id = `GRN-${day}`) => ({ receivingDocumentId: id, day, accepted, rejected })
const evaluate = (lineRow, receipts, options = {}) => evaluatePromiseLine({ line: lineRow, purchaseOrder: po([lineRow], options.purchaseOrder), receipts, asOfDay: '2026-09-30', ...options })
// An evaluated line moved to a PO of its own, so it is its own delivery.
const ownOrder = (row) => ({ ...row, purchaseOrderId: `PO-${row.purchaseOrderLineId}` })

test('the business rules worked example on one PO is one delivery: late, not in full, not OTIF, too few for a rate', () => {
  const result = buildSupplierScorecard({ ...workedExampleRows(), invoices: [], period: { from: '2026-07-01', to: '2026-09-30' }, asOfDay: WORKED_EXAMPLE_AS_OF, timeZone: 'America/New_York' })
  assert.equal(result.version, 'supplier-scorecard-v3')
  assert.equal(result.rules.promiseBasis, 'po_date')
  const [supplier] = result.suppliers
  assert.deepEqual([supplier.sampleStatus, supplier.sampleSize, supplier.lineCount], ['insufficient_sample', 1, 12])
  const [delivery] = supplier.obligations
  assert.deepEqual([delivery.obligationId, delivery.originalPromisedDate, delivery.lines.length], ['EXAMPLE-PO:2026-08-10', '2026-08-10', 12])
  // L10, L11 and L12 arrived late; L11 and L12 were closed short; L9 was topped up after the promise.
  assert.deepEqual([delivery.onTime, delivery.inFull, delivery.otif, delivery.daysLate, delivery.lastFirstReceiptDay], [false, false, false, 8, '2026-08-18'])
  assert.deepEqual([supplier.metrics.onTime.count, supplier.metrics.onTime.of, supplier.metrics.onTime.rate], [0, 1, null])
  assert.deepEqual([supplier.metrics.inFull.count, supplier.metrics.inFull.of, supplier.metrics.otif.count, supplier.metrics.otif.of], [0, 1, 0, 1])
  // The quantities are still counted, but no rate is shown below 5 deliveries.
  assert.deepEqual([supplier.metrics.rejection.rejectedQuantity, supplier.metrics.rejection.receivedQuantity, supplier.metrics.rejection.rate], [30, 1200, null])
  assert.deepEqual(supplier.metrics.averageDelayDays, { value: 8, lateCount: 1 })
  // Each line keeps its own result in the drilldown.
  assert.deepEqual(supplier.lines.filter((row) => !row.onTime).map((row) => [row.purchaseOrderLineId, row.daysLate]), [['EXAMPLE-L10', 2], ['EXAMPLE-L11', 5], ['EXAMPLE-L12', 8]])
  const l9 = supplier.lines.find((row) => row.purchaseOrderLineId === 'EXAMPLE-L09')
  const l10 = supplier.lines.find((row) => row.purchaseOrderLineId === 'EXAMPLE-L10')
  assert.deepEqual([l9.onTime, l9.inFull, l9.otif], [true, true, false])
  assert.deepEqual([l10.onTime, l10.inFull, l10.otif], [false, true, false])
})

test('the business rules worked example with one PO per line: 75.0%, 83.3%, 66.7%, 2.5%, 5 days', () => {
  // One line per PO makes each line its own delivery, so v3 gives the v2 figures.
  const result = buildSupplierScorecard({ ...workedExampleRows({ onePurchaseOrderPerLine: true }), invoices: [], period: { from: '2026-07-01', to: '2026-09-30' }, asOfDay: WORKED_EXAMPLE_AS_OF, timeZone: 'America/New_York' })
  const [supplier] = result.suppliers
  assert.equal(supplier.sampleStatus, 'ok')
  assert.deepEqual([supplier.sampleSize, supplier.lineCount], [12, 12])
  assert.deepEqual([supplier.metrics.onTime.count, supplier.metrics.onTime.of, pct(supplier.metrics.onTime.rate)], [9, 12, 75.0])
  assert.deepEqual([supplier.metrics.inFull.count, supplier.metrics.inFull.of, pct(supplier.metrics.inFull.rate)], [10, 12, 83.3])
  assert.deepEqual([supplier.metrics.otif.count, supplier.metrics.otif.of, pct(supplier.metrics.otif.rate)], [8, 12, 66.7])
  assert.deepEqual([supplier.metrics.rejection.rejectedQuantity, supplier.metrics.rejection.receivedQuantity, pct(supplier.metrics.rejection.rate)], [30, 1200, 2.5])
  assert.deepEqual(supplier.metrics.averageDelayDays, { value: 5, lateCount: 3 })
  assert.deepEqual(supplier.obligations.filter((row) => !row.onTime).map((row) => [row.lines[0].purchaseOrderLineId, row.daysLate]), [['EXAMPLE-L10', 2], ['EXAMPLE-L11', 5], ['EXAMPLE-L12', 8]])
  // Nothing was revised, so the current-date figures equal the original ones.
  assert.equal(supplier.metrics.onTimeCurrent.count, 9)
  assert.equal(supplier.metrics.otifCurrent.count, 8)
})

test('fewer than 5 deliveries is an insufficient sample with counts but no percentages', () => {
  const lines = Array.from({ length: 4 }, (_, index) => ({ purchaseOrderId: `PO-${index}`, purchaseOrderLineId: `L${index}`, originalPromisedDate: '2026-08-01', unit: 'pcs', orderedQuantity: 10, receivedQuantity: 10, rejectedQuantity: 1, onTime: index > 0, onTimeCurrent: true, inFull: true, inFullPending: false, otif: index > 0, otifCurrent: true, early: false, daysLate: index ? 0 : 3 }))
  const summary = summarizeScorecardLines({ lines, invoices: [] })
  assert.equal(summary.sampleStatus, 'insufficient_sample')
  for (const key of ['onTime', 'onTimeCurrent', 'early', 'inFull', 'otif', 'otifCurrent']) {
    assert.equal(summary.metrics[key].rate, null, key)
    assert.equal(summary.metrics[key].interval, null, key)
  }
  assert.equal(summary.metrics.onTime.count, 3)
  assert.equal(summary.metrics.rejection.rate, null)
  assert.equal(summarizeScorecardLines({ lines: [], invoices: [] }).sampleStatus, 'no_obligations')
  assert.equal(summarizeScorecardLines({ lines: [...lines, { ...lines[1], purchaseOrderId: 'PO-5', purchaseOrderLineId: 'L5' }], invoices: [] }).sampleStatus, 'ok')
})

test('Wilson 95% interval: 9 of 12 is 46.8% to 91.1%; the edges stay inside 0 and 1', () => {
  const interval = wilsonInterval(9, 12)
  assert.deepEqual([pct(interval.low), pct(interval.high)], [46.8, 91.1])
  const none = wilsonInterval(0, 10)
  assert.equal(none.low, 0)
  assert.equal(pct(none.high), 27.8)
  assert.equal(pct(wilsonInterval(10, 10).low), 72.2)
  assert.equal(wilsonInterval(0, 0), null)
})

test('on time: the first receipt arrives by the original promise plus grace days', () => {
  assert.equal(evaluate(line('A', '2026-08-10'), [receipt('2026-08-10', 100)]).onTime, true)
  // A partial first receipt on time makes the line on time, whatever follows.
  const partial = evaluate(line('B', '2026-08-10'), [receipt('2026-08-08', 60), receipt('2026-08-12', 40)])
  assert.deepEqual([partial.onTime, partial.daysLate, partial.firstReceiptDay], [true, 0, '2026-08-08'])
  const late = evaluate(line('C', '2026-08-10'), [receipt('2026-08-12', 100)])
  assert.deepEqual([late.onTime, late.daysLate], [false, 2])
  // 2 grace days make the same arrival on time; delay still counts from the promise.
  assert.equal(evaluate(line('D', '2026-08-10'), [receipt('2026-08-12', 100)], { graceDays: 2 }).onTime, true)
})

test('early: a first receipt more than 3 days ahead is on time and reported as early', () => {
  const fourEarly = evaluate(line('A', '2026-08-10'), [receipt('2026-08-06', 100)])
  assert.deepEqual([fourEarly.onTime, fourEarly.early], [true, true])
  const threeEarly = evaluate(line('B', '2026-08-10'), [receipt('2026-08-07', 100)])
  assert.deepEqual([threeEarly.onTime, threeEarly.early], [true, false])
})

test('in full: accepted quantity eventually reaches the ordered quantity; an open shortfall is pending', () => {
  // Replaced after the promise: in full, not OTIF.
  const replaced = evaluate(line('A', '2026-08-10'), [receipt('2026-08-10', 90, 10), receipt('2026-08-14', 10)])
  assert.deepEqual([replaced.inFull, replaced.inFullPending, replaced.otif, replaced.fullDay], [true, false, false, '2026-08-14'])
  // Still open with a shortfall: not in full yet, left out of the in-full rate.
  const open = evaluate(line('B', '2026-08-10'), [receipt('2026-08-10', 90, 10)])
  assert.deepEqual([open.inFull, open.inFullPending, open.otif], [null, true, false])
  // Closed short by the buyer, or on a cancelled PO: not in full.
  assert.deepEqual([evaluate(line('C', '2026-08-10', { metadata: { closedAt: '2026-08-20' } }), [receipt('2026-08-10', 90, 10)]).inFull], [false])
  assert.equal(evaluate(line('D', '2026-08-10'), [receipt('2026-08-10', 90)], { purchaseOrder: { status: 'cancelled' } }).inFull, false)
  // Each line on its own PO is its own delivery.
  const lines = [replaced, open, ...['E', 'F', 'G', 'H', 'I'].map((id) => evaluate(line(id, '2026-08-10'), [receipt('2026-08-10', 100)]))].map(ownOrder)
  const summary = summarizeScorecardLines({ lines, invoices: [] })
  assert.deepEqual([summary.metrics.inFull.count, summary.metrics.inFull.of, summary.inFullPendingCount, summary.sampleSize], [6, 6, 1, 7])
  assert.deepEqual(summary.pendingObligations.map((row) => row.lines.map((entry) => entry.purchaseOrderLineId)), [['B']])
  // On one PO the seven lines are one delivery, not in full yet while B is open.
  const together = summarizeScorecardLines({ lines: lines.map((row) => ({ ...row, purchaseOrderId: 'PO-1' })), invoices: [] })
  assert.deepEqual([together.sampleSize, together.lineCount, together.inFullPendingCount, together.metrics.inFull.of, together.obligations[0].inFull], [1, 7, 1, 0, null])
})

test('OTIF: accepted quantity reached the ordered quantity by the original promise plus grace days', () => {
  assert.equal(evaluate(line('A', '2026-08-10'), [receipt('2026-08-05', 50), receipt('2026-08-10', 50)]).otif, true)
  assert.equal(evaluate(line('B', '2026-08-10'), [receipt('2026-08-10', 90, 10)]).otif, false)
  assert.equal(evaluate(line('C', '2026-08-10'), [receipt('2026-08-10', 90, 10), receipt('2026-08-11', 10)], { graceDays: 1 }).otif, true)
})

test('a revised date is visible: late against the original promise, on time against the current date', () => {
  const revised = evaluate(line('A', '2026-08-10', { current: '2026-08-15' }), [receipt('2026-08-14', 100)])
  assert.deepEqual([revised.revised, revised.onTime, revised.daysLate, revised.onTimeCurrent, revised.otif, revised.otifCurrent, revised.currentPromisedDate], [true, false, 4, true, false, true, '2026-08-15'])
  // Not yet due against a later current date: OTIF so far against it.
  const moved = evaluate(line('B', '2026-09-20', { current: '2026-10-15' }), [receipt('2026-09-18', 40)])
  assert.deepEqual([moved.onTime, moved.otif, moved.otifCurrent], [true, false, true])
  // No original promise recorded: never in the sample.
  assert.equal(evaluate(line('C', null, { metadata: { promisedDate: '2026-08-10' } }), [receipt('2026-08-10', 100)]).status, 'original_not_recorded')
})

test('mixed units give no single rejection rate; price variances and amounts stay per currency', () => {
  const lines = ['pcs', 'pcs', 'ft', 'pcs', 'pcs'].map((unit, index) => ({ purchaseOrderId: `PO-${index}`, purchaseOrderLineId: `L${index}`, originalPromisedDate: '2026-08-01', unit, orderedQuantity: 10, receivedQuantity: 10, rejectedQuantity: 1, onTime: true, onTimeCurrent: true, inFull: false, inFullPending: false, otif: false, otifCurrent: false, early: false, daysLate: 0, currency: index % 2 ? 'CAD' : 'USD', amount: 100 }))
  const invoices = [
    { supplierInvoiceId: 'INV-1', invoiceDate: '2026-08-02', currency: 'USD', varianceAmount: 20 },
    { supplierInvoiceId: 'INV-2', invoiceDate: '2026-08-03', currency: 'CAD', varianceAmount: 5 },
    { supplierInvoiceId: 'INV-3', invoiceDate: '2026-08-04', currency: 'USD', varianceAmount: 7.5 },
  ]
  const summary = summarizeScorecardLines({ lines, invoices })
  assert.deepEqual([summary.metrics.rejection.mixedUnits, summary.metrics.rejection.rate, summary.metrics.rejection.unit], [true, null, null])
  assert.equal(summary.metrics.priceVariances.count, 3)
  assert.deepEqual(summary.metrics.priceVariances.amounts, [{ currency: 'CAD', amount: 5 }, { currency: 'USD', amount: 27.5 }])
  assert.deepEqual(summary.orderedValue, [{ currency: 'CAD', amount: 200 }, { currency: 'USD', amount: 300 }])
  assert.deepEqual(summarizeScorecardLines({ lines, invoices: null }).metrics.priceVariances, { count: null, visible: false, amounts: [] })
})

test('the scorecard counts lines by original promise in the period, dates receipts in the workspace timezone, and drills down', () => {
  const lines = [
    line('L1', '2026-08-03'), line('L2', '2026-08-05', { current: '2026-08-09' }), line('L3', '2026-08-10'), line('L4', '2026-08-12'), line('L5', '2026-08-20'),
    line('L6', '2026-07-01'), // before the period
    line('L7', null, { metadata: { promisedDate: '2026-08-15' } }), // original not recorded
  ]
  // L1 arrives at 23:30 New York time on its promise day, 03:30 UTC the next day.
  const documents = [
    { id: 'GRN-1', arrivedAt: new Date('2026-08-04T03:30:00Z'), lines: [{ purchaseOrderLineId: 'L1', acceptedQty: 100, rejectedQty: 0 }] },
    { id: 'GRN-2', arrivedAt: new Date('2026-08-08T14:00:00Z'), lines: [{ purchaseOrderLineId: 'L2', acceptedQty: 100, rejectedQty: 0 }] },
    { id: 'GRN-3', arrivedAt: new Date('2026-08-10T14:00:00Z'), lines: [{ purchaseOrderLineId: 'L3', acceptedQty: 95, rejectedQty: 5 }] },
    { id: 'GRN-4', arrivedAt: new Date('2026-08-12T14:00:00Z'), lines: [{ purchaseOrderLineId: 'L4', acceptedQty: 100, rejectedQty: 0 }] },
    { id: 'GRN-5', arrivedAt: new Date('2026-08-26T14:00:00Z'), lines: [{ purchaseOrderLineId: 'L5', acceptedQty: 100, rejectedQty: 0 }] },
    { id: 'GRN-6', arrivedAt: new Date('2026-07-01T14:00:00Z'), lines: [{ purchaseOrderLineId: 'L6', acceptedQty: 100, rejectedQty: 0 }] },
    { id: 'GRN-7', arrivedAt: new Date('2026-08-15T14:00:00Z'), lines: [{ purchaseOrderLineId: 'L7', acceptedQty: 100, rejectedQty: 0 }] },
  ]
  const invoices = [
    { id: 'INV-A', supplierId: 'SUP-1', status: 'exception', invoiceDate: new Date('2026-08-11T12:00:00Z'), currency: 'USD', varianceAmount: 12, metadata: { varianceType: 'price_variance' }, lines: [] },
    { id: 'INV-B', supplierId: 'SUP-1', status: 'draft', invoiceDate: new Date('2026-08-11T12:00:00Z'), currency: 'USD', varianceAmount: 9, metadata: { varianceType: 'price_variance' }, lines: [] },
    { id: 'INV-C', supplierId: 'SUP-1', status: 'matched', invoiceDate: new Date('2026-08-12T12:00:00Z'), currency: 'USD', varianceAmount: 3, metadata: {}, lines: [], matchRuns: [{ exceptions: [{ exceptionType: 'price' }] }] },
    { id: 'INV-D', supplierId: 'SUP-1', status: 'matched', invoiceDate: new Date('2026-08-12T12:00:00Z'), currency: 'USD', varianceAmount: 0, metadata: {}, lines: [], matchRuns: [{ exceptions: [{ exceptionType: 'quantity' }] }] },
  ]
  const result = buildSupplierScorecard({
    purchaseOrders: [po(lines)], receipts: documents, invoices, suppliers: [{ id: 'SUP-1', name: 'Summit Supply' }],
    period: { from: '2026-08-01', to: '2026-08-31' }, asOfDay: '2026-09-30', timeZone: 'America/New_York',
  })
  const [supplier] = result.suppliers
  assert.equal(supplier.supplierName, 'Summit Supply')
  assert.deepEqual(supplier.lines.map((row) => row.purchaseOrderLineId), ['L1', 'L2', 'L3', 'L4', 'L5'])
  assert.equal(supplier.lines[0].firstReceiptDay, '2026-08-03', 'arrival is the New York calendar day')
  // L2 revised 08-05 -> 08-09 and arrived 08-08; L5 six days late; L3 is an open shortfall.
  assert.deepEqual([supplier.metrics.onTime.count, pct(supplier.metrics.onTime.rate)], [3, 60])
  assert.deepEqual([supplier.metrics.onTimeCurrent.count, pct(supplier.metrics.onTimeCurrent.rate)], [4, 80])
  assert.deepEqual([supplier.metrics.inFull.count, supplier.metrics.inFull.of, supplier.inFullPendingCount], [4, 4, 1])
  assert.deepEqual([supplier.metrics.otif.count, supplier.metrics.otifCurrent.count], [2, 3])
  assert.deepEqual(supplier.lines.filter((row) => !row.onTime).map((row) => [row.purchaseOrderLineId, row.daysLate]), [['L2', 3], ['L5', 6]])
  assert.equal(supplier.metrics.averageDelayDays.value, 4.5)
  assert.equal(supplier.revisedCount, 1)
  assert.equal(pct(supplier.metrics.rejection.rate), 1)
  assert.deepEqual(supplier.invoices.map((row) => row.supplierInvoiceId), ['INV-A', 'INV-C'])
  assert.equal(supplier.metrics.priceVariances.count, 2)
  assert.deepEqual([supplier.originalNotRecordedCount, supplier.originalNotRecordedLines[0].purchaseOrderLineId], [1, 'L7'])
  assert.deepEqual(supplier.lines[1].receipts, [{ receivingDocumentId: 'GRN-2', day: '2026-08-08', accepted: 100, rejected: 0 }])
})

test('period and grace days are validated; the default period is the 90 days ending today', () => {
  assert.deepEqual(scorecardParameters({}, '2026-09-30'), { period: { from: '2026-07-03', to: '2026-09-30' }, graceDays: 0, supplierId: null })
  assert.equal(scorecardParameters({ graceDays: '2' }, '2026-09-30').graceDays, 2)
  for (const query of [{ from: '2026-02-30' }, { from: '2026-09-10', to: '2026-09-01' }, { from: '2020-01-01', to: '2026-01-01' }, { graceDays: '1.5' }, { graceDays: '-1' }, { graceDays: '31' }]) {
    assert.throws(() => scorecardParameters(query, '2026-09-30'), (error) => error.status === 422 && /^SCORECARD_/.test(error.code), JSON.stringify(query))
  }
})

test('a delivery past its promise with nothing received is late and not OTIF, so missed deliveries lower the rates', () => {
  // 5 lines delivered on time and in full, 20 lines promised on 08-15 never
  // delivered, as of 09-30. On one PO that is two deliveries, one on time and
  // one overdue: counts, but too few for a rate.
  const delivered = Array.from({ length: 5 }, (_, index) => line(`D${index}`, '2026-08-10'))
  const missed = Array.from({ length: 20 }, (_, index) => line(`M${index}`, '2026-08-15'))
  const receipts = delivered.map((row) => ({ id: `GRN-${row.id}`, postedAt: new Date('2026-08-10T15:00:00Z'), lines: [{ purchaseOrderLineId: row.id, acceptedQty: 100, rejectedQty: 0 }] }))
  const period = { from: '2026-08-01', to: '2026-09-30' }
  const result = buildSupplierScorecard({ purchaseOrders: [po([...delivered, ...missed])], receipts, invoices: [], period, asOfDay: '2026-09-30', timeZone: 'America/New_York' })
  const [supplier] = result.suppliers
  assert.deepEqual([supplier.sampleSize, supplier.lineCount, supplier.sampleStatus], [2, 25, 'insufficient_sample'])
  assert.equal(supplier.overdueUndeliveredCount, 1)
  assert.deepEqual([supplier.metrics.onTime.count, supplier.metrics.onTime.of, supplier.metrics.onTime.rate], [1, 2, null])
  assert.deepEqual([supplier.metrics.otif.count, supplier.metrics.otif.of], [1, 2])
  // In full is pending for open lines, as for a partial delivery.
  assert.deepEqual([supplier.metrics.inFull.count, supplier.metrics.inFull.of, supplier.inFullPendingCount], [1, 1, 1])
  const overdue = supplier.lines.find((row) => row.purchaseOrderLineId === 'M0')
  assert.deepEqual([overdue.status, overdue.onTime, overdue.otif, overdue.daysLate, overdue.firstReceiptDay], ['evaluated', false, false, 46, null])
  assert.deepEqual(supplier.metrics.averageDelayDays, { value: 46, lateCount: 1 })

  // With each line on its own PO there are 25 deliveries, and the 20 missed
  // ones bring on time to 20%. Before, the sample was the 5 delivered: 100%.
  const separate = buildSupplierScorecard({ purchaseOrders: [...delivered, ...missed].map((row) => po([row], { id: `PO-${row.id}` })), receipts: receipts.map((row) => ({ ...row, poId: `PO-${row.lines[0].purchaseOrderLineId}` })), invoices: [], period, asOfDay: '2026-09-30', timeZone: 'America/New_York' }).suppliers[0]
  assert.deepEqual([separate.sampleSize, separate.overdueUndeliveredCount], [25, 20])
  assert.deepEqual([separate.metrics.onTime.count, separate.metrics.onTime.of, pct(separate.metrics.onTime.rate)], [5, 25, 20])
  assert.deepEqual([separate.metrics.otif.count, separate.metrics.otif.of, pct(separate.metrics.otif.rate)], [5, 25, 20])
  assert.deepEqual([separate.metrics.inFull.count, separate.metrics.inFull.of, separate.inFullPendingCount], [5, 5, 20])
  assert.deepEqual(separate.metrics.averageDelayDays, { value: 46, lateCount: 20 })
})

test('a line with nothing received that is not due yet is left out', () => {
  // Promised 09-28 with 5 grace days: due by 10-03.
  const grace = { graceDays: 5 }
  assert.equal(evaluate(line('L1', '2026-09-28'), [], grace).status, 'not_received')
  // A day past the grace window it counts.
  const late = evaluate(line('L1', '2026-09-24'), [], grace)
  assert.deepEqual([late.status, late.onTime, late.otif, late.overdueUndelivered], ['evaluated', false, false, true])
  // Revised to 10-10, it is still on time against the current date.
  const revised = evaluate(line('L1', '2026-09-20', { current: '2026-10-10' }), [], grace)
  assert.deepEqual([revised.onTime, revised.onTimeCurrent, revised.otifCurrent], [false, true, true])
})

test('a partial delivery inside its window is undecided for OTIF, as for in full', () => {
  // Promised 09-28, 4 of 100 on 09-27, as of 09-30: the supplier has until 10-03.
  const grace = { graceDays: 5 }
  const pending = evaluate(line('L1', '2026-09-28'), [receipt('2026-09-27', 4)], grace)
  assert.deepEqual([pending.onTime, pending.inFullPending, pending.otif, pending.otifCurrent], [true, true, null, true])
  const summary = summarizeScorecardLines({ lines: [pending, evaluate(line('L2', '2026-09-01'), [receipt('2026-09-01', 100)], grace)] })
  assert.deepEqual([summary.metrics.otif.count, summary.metrics.otif.of], [1, 1])
  // Past the window and still short, it is not OTIF.
  const short = evaluate(line('L1', '2026-09-20'), [receipt('2026-09-19', 4)], grace)
  assert.equal(short.otif, false)
})

// Posted receipt documents for lines, arriving at 11:00 New York time.
const grn = (id, day, lineIds, accepted = 100, rejected = 0) => ({ id, arrivedAt: new Date(`${day}T15:00:00Z`), lines: lineIds.map((purchaseOrderLineId) => ({ purchaseOrderLineId, acceptedQty: accepted, rejectedQty: rejected })) })
const suppliersOf = (purchaseOrders, receipts, extra = {}) => buildSupplierScorecard({ purchaseOrders, receipts, invoices: [], period: { from: '2026-08-01', to: '2026-10-31' }, asOfDay: '2026-09-30', timeZone: 'America/New_York', ...extra }).suppliers

test('a delivery is the lines of one PO with one promised date: one late line makes it late', () => {
  const [supplier] = suppliersOf([po([line('A', '2026-08-10'), line('B', '2026-08-10'), line('C', '2026-08-10')])], [grn('GRN-1', '2026-08-09', ['A', 'B']), grn('GRN-2', '2026-08-13', ['C'])])
  assert.deepEqual([supplier.sampleSize, supplier.lineCount], [1, 3])
  const [delivery] = supplier.obligations
  assert.deepEqual([delivery.obligationId, delivery.onTime, delivery.daysLate, delivery.lastFirstReceiptDay, delivery.inFull, delivery.otif, delivery.early], ['PO-1:2026-08-10', false, 3, '2026-08-13', true, false, false])
  assert.deepEqual(delivery.lines.map((row) => [row.purchaseOrderLineId, row.onTime]), [['A', true], ['B', true], ['C', false]])
  assert.deepEqual(supplier.metrics.averageDelayDays, { value: 3, lateCount: 1 })
  // Early only when the last line's first receipt is more than 3 days ahead.
  const [early] = suppliersOf([po([line('A', '2026-08-10'), line('B', '2026-08-10')])], [grn('GRN-1', '2026-08-05', ['A']), grn('GRN-2', '2026-08-06', ['B'])])
  const [notEarly] = suppliersOf([po([line('A', '2026-08-10'), line('B', '2026-08-10')])], [grn('GRN-1', '2026-08-05', ['A']), grn('GRN-2', '2026-08-08', ['B'])])
  assert.deepEqual([early.obligations[0].early, notEarly.obligations[0].early, notEarly.obligations[0].onTime], [true, false, true])
})

test('a partial first receipt counts for on time; the delivery is in full only when every line is', () => {
  // B's first receipt brings 60 of 100 on the promise day, then B is closed short.
  const closedShort = [line('A', '2026-08-10'), line('B', '2026-08-10', { metadata: { closedAt: '2026-08-20' } })]
  const receipts = [grn('GRN-1', '2026-08-10', ['A']), grn('GRN-2', '2026-08-10', ['B'], 60)]
  const [closed] = suppliersOf([po(closedShort)], receipts)
  assert.deepEqual(['onTime', 'inFull', 'inFullPending', 'otif'].map((key) => closed.obligations[0][key]), [true, false, false, false])
  // Still open with its shortfall: not in full yet, and left out of the in-full rate.
  const [open] = suppliersOf([po([line('A', '2026-08-10'), line('B', '2026-08-10')])], receipts)
  assert.deepEqual(['onTime', 'inFull', 'inFullPending', 'otif'].map((key) => open.obligations[0][key]), [true, null, true, false])
  assert.deepEqual([open.inFullPendingCount, open.metrics.inFull.of, open.pendingObligations[0].obligationId], [1, 0, 'PO-1:2026-08-10'])
})

test('grace days apply to the whole delivery', () => {
  const lines = [line('A', '2026-08-10'), line('B', '2026-08-10')]
  const receipts = [grn('GRN-1', '2026-08-10', ['A']), grn('GRN-2', '2026-08-12', ['B'])]
  const [strict] = suppliersOf([po(lines)], receipts)
  assert.deepEqual([strict.obligations[0].onTime, strict.obligations[0].otif, strict.obligations[0].daysLate], [false, false, 2])
  const [grace] = suppliersOf([po(lines)], receipts, { graceDays: 2 })
  assert.deepEqual([grace.obligations[0].onTime, grace.obligations[0].otif, grace.obligations[0].daysLate], [true, true, 0])
})

test('lines called off before they were due leave their delivery; a line closed after it was due stays in as late', () => {
  const orders = [
    // Z was ordered at zero and X closed before its promise with nothing received: A alone is the delivery.
    po([line('A', '2026-08-10'), line('Z', '2026-08-10', { orderedQuantity: 0 }), line('X', '2026-08-10', { metadata: { closedAt: '2026-08-05' } })]),
    // Y was closed on 08-25, after its 08-10 promise, with nothing received.
    po([line('W', '2026-08-10'), line('Y', '2026-08-10', { metadata: { closedAt: '2026-08-25' } })], { id: 'PO-2' }),
    // A closed PO without a recorded closing time: its unreceived line is left out, and so is the delivery.
    po([line('V', '2026-08-10')], { id: 'PO-3', status: 'closed' }),
    // A PO closed on 08-20 (New York time), after the promise: late, not in full.
    po([line('U', '2026-08-10')], { id: 'PO-4', status: 'closed', metadata: { closedAt: '2026-08-20T14:00:00.000Z' } }),
  ]
  const [supplier] = suppliersOf(orders, [grn('GRN-1', '2026-08-10', ['A', 'W'])])
  assert.deepEqual(supplier.obligations.map((row) => [row.obligationId, row.lines.map((entry) => entry.purchaseOrderLineId), row.onTime, row.inFull, row.otif]), [
    ['PO-1:2026-08-10', ['A'], true, true, true],
    ['PO-2:2026-08-10', ['W', 'Y'], false, false, false],
    ['PO-4:2026-08-10', ['U'], false, false, false],
  ])
  // Days late run to the closing day, not to today.
  assert.deepEqual(supplier.obligations.slice(1).map((row) => [row.overdueUndelivered, row.daysLate]), [[true, 15], [true, 10]])
})

test('a delivery waits until every line is received or the promise plus grace days has passed', () => {
  // A arrived 09-27, B has nothing yet; with 5 grace days both are due by 10-03.
  const lines = [line('A', '2026-09-28'), line('B', '2026-09-28')]
  const receipts = [grn('GRN-1', '2026-09-27', ['A'])]
  const [waiting] = suppliersOf([po(lines)], receipts, { graceDays: 5 })
  assert.deepEqual([waiting.sampleStatus, waiting.sampleSize, waiting.lines.length], ['no_obligations', 0, 0])
  const [due] = suppliersOf([po(lines)], receipts, { graceDays: 5, asOfDay: '2026-10-04' })
  assert.deepEqual([due.sampleSize, due.obligations[0].onTime, due.obligations[0].overdueUndelivered, due.obligations[0].daysLate, due.overdueUndeliveredCount], [1, false, true, 6, 1])
  const [delivered] = suppliersOf([po(lines)], [...receipts, grn('GRN-2', '2026-10-02', ['B'])], { graceDays: 5, asOfDay: '2026-10-04' })
  assert.deepEqual([delivered.obligations[0].onTime, delivered.obligations[0].otif], [true, true])
  // The waiting delivery is counted apart, so the panel can say it is waiting.
  assert.equal(waiting.waitingCount, 1)
  assert.equal(due.waitingCount, 0)
  // A supplier whose only lines are not due yet is not on the scorecard.
  assert.deepEqual(suppliersOf([po(lines)], [], { graceDays: 5 }), [])
})

test('rates need 5 deliveries, however many lines they hold', () => {
  // 4 POs of 5 lines each, all on time: 20 lines, 4 deliveries, no rate.
  const orders = Array.from({ length: 4 }, (_, order) => po(Array.from({ length: 5 }, (_, index) => line(`P${order}L${index}`, '2026-08-10')), { id: `PO-${order}` }))
  const receipts = orders.map((order) => grn(`GRN-${order.id}`, '2026-08-10', order.lines.map((row) => row.id)))
  const [four] = suppliersOf(orders, receipts)
  assert.deepEqual([four.sampleStatus, four.sampleSize, four.lineCount, four.metrics.onTime.count, four.metrics.onTime.rate, four.metrics.rejection.rate], ['insufficient_sample', 4, 20, 4, null, null])
  const [five] = suppliersOf([...orders, po([line('P4L0', '2026-08-10')], { id: 'PO-4' })], [...receipts, grn('GRN-PO-4', '2026-08-10', ['P4L0'])])
  assert.deepEqual([five.sampleStatus, five.sampleSize, five.lineCount, five.metrics.onTime.rate], ['ok', 5, 21, 1])
  assert.deepEqual([pct(five.metrics.onTime.interval.low), pct(five.metrics.onTime.interval.high)], [56.6, 100])
})

test('two promised dates on one PO are two deliveries', () => {
  const lines = [line('A', '2026-08-10'), line('B', '2026-08-10'), line('C', '2026-08-20')]
  const evaluated = lines.map((row) => evaluatePromiseLine({ line: row, purchaseOrder: po(lines), receipts: row.id === 'C' ? [receipt('2026-08-22', 100)] : [receipt('2026-08-10', 100)], asOfDay: '2026-09-30' }))
  assert.deepEqual(groupDeliveryObligations(evaluated).map((row) => [row.obligationId, row.lines.length, row.onTime, row.daysLate]), [
    ['PO-1:2026-08-10', 2, true, 0],
    ['PO-1:2026-08-20', 1, false, 2],
  ])
})

test('a line revised later and then closed with nothing received is late against the current date too', () => {
  // Promised 09-01, revised to 09-20, closed short on 09-10 with nothing received; read on 09-30.
  const row = line('A', '2026-09-01', { current: '2026-09-20', metadata: { closedAt: '2026-09-10' } })
  const evaluated = evaluate(row, [])
  assert.deepEqual(['onTime', 'onTimeCurrent', 'inFull', 'otif', 'otifCurrent', 'daysLate'].map((key) => evaluated[key]), [false, false, false, false, false, 9])
  const [supplier] = suppliersOf([po([row])], [], { period: { from: '2026-08-01', to: '2026-09-30' } })
  assert.deepEqual(['onTime', 'onTimeCurrent', 'otif', 'otifCurrent'].map((key) => supplier.obligations[0][key]), [false, false, false, false])
  assert.deepEqual([supplier.metrics.onTimeCurrent.count, supplier.metrics.otifCurrent.count], [0, 0])
  // Still open and not yet due against its revised date: on time against it, as before.
  const open = evaluate(line('B', '2026-09-01', { current: '2026-10-05' }), [])
  assert.deepEqual([open.onTime, open.onTimeCurrent, open.otifCurrent], [false, true, true])
})

test('the rejection rate never adds quantities across SKUs', () => {
  // 5 one-line deliveries in pcs: 4 of bolts (2,500 received each, none rejected) and 1 of motors (10 received, 5 rejected).
  const orders = Array.from({ length: 5 }, (_, index) => po([line(`L${index}`, '2026-08-10', { sku: index === 4 ? 'MOTOR' : 'BOLT', orderedQuantity: index === 4 ? 10 : 2500 })], { id: `PO-${index}` }))
  const receipts = [...orders.slice(0, 4).map((order) => grn(`GRN-${order.id}`, '2026-08-10', [order.lines[0].id], 2500, 0)), grn('GRN-PO-4', '2026-08-10', ['L4'], 5, 5)]
  const [supplier] = suppliersOf(orders, receipts)
  assert.equal(supplier.sampleStatus, 'ok')
  assert.deepEqual(supplier.metrics.rejection, { rejectedQuantity: null, receivedQuantity: null, unit: null, mixedUnits: false, multipleSkus: true, rate: null, interval: null })
  // Each line keeps its own quantities for the drilldown.
  assert.deepEqual(supplier.lines.filter((row) => row.rejectedQuantity).map((row) => [row.sku, row.rejectedQuantity, row.receivedQuantity]), [['MOTOR', 5, 10]])
  // One SKU in one unit: a single rate with its quantities.
  const [single] = suppliersOf(orders.slice(0, 4).concat(po([line('L5', '2026-08-10', { sku: 'BOLT', orderedQuantity: 2500 })], { id: 'PO-5' })), [...receipts.slice(0, 4), grn('GRN-PO-5', '2026-08-10', ['L5'], 2495, 5)])
  assert.deepEqual([single.metrics.rejection.multipleSkus, single.metrics.rejection.rejectedQuantity, single.metrics.rejection.receivedQuantity, single.metrics.rejection.unit, pct(single.metrics.rejection.rate)], [false, 5, 12500, 'pcs', 0])
})

test('with 5 or more deliveries, a rate can still lack 5 settled deliveries of its own', () => {
  // 7 one-line deliveries arrived on time; 3 are still open short, so in full has 4 settled.
  const orders = Array.from({ length: 7 }, (_, index) => po([line(`L${index}`, '2026-08-10')], { id: `PO-${index}` }))
  const receipts = orders.map((order, index) => grn(`GRN-${order.id}`, '2026-08-10', [order.lines[0].id], index < 3 ? 60 : 100))
  const [supplier] = suppliersOf(orders, receipts)
  assert.deepEqual([supplier.sampleStatus, supplier.sampleSize, supplier.inFullPendingCount], ['ok', 7, 3])
  assert.deepEqual([supplier.metrics.inFull.count, supplier.metrics.inFull.of, supplier.metrics.inFull.rate], [4, 4, null])
  assert.equal(supplier.metrics.onTime.rate, 1)
})
