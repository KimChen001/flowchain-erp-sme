import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildSupplierScorecard,
  evaluatePromiseLine,
  scorecardParameters,
  summarizeScorecardLines,
  wilsonInterval,
} from './supplier-scorecard.mjs'

const pct = (value) => value === null ? null : Math.round(value * 1000) / 10
const po = (lines, extra = {}) => ({ id: 'PO-1', supplierId: 'SUP-1', supplierName: 'Summit Supply', currency: 'USD', status: 'issued', expectedDate: null, lines, ...extra })
const line = (id, original, extra = {}) => ({ id, sku: 'SKU-1', itemName: 'Sensor', unit: 'pcs', orderedQuantity: 100, receivedQuantity: 0, amount: 1000, originalPromisedDate: original ? new Date(`${original}T12:00:00Z`) : null, metadata: { promisedDate: extra.current || original }, ...extra })
const receipt = (day, accepted, rejected = 0, id = `GRN-${day}`) => ({ receivingDocumentId: id, day, accepted, rejected })
const evaluate = (lineRow, receipts, options = {}) => evaluatePromiseLine({ line: lineRow, purchaseOrder: po([lineRow]), receipts, asOfDay: '2026-09-30', ...options })

test('the business rules example: 12 lines give 75.0% on time, 83.3% in full, 66.7% OTIF, 2.5% rejected, 5 days average delay', () => {
  // Business rules section 8: 12 received lines with an original promise; 9 on
  // time and 3 late by 2, 5 and 8 days; 10 in full; 8 on time and in full;
  // 1,200 units received and 30 rejected.
  const flags = [
    ...Array.from({ length: 8 }, () => ({ onTime: true, inFull: true, daysLate: 0 })),
    { onTime: true, inFull: false, daysLate: 0 },
    { onTime: false, inFull: true, daysLate: 2 },
    { onTime: false, inFull: true, daysLate: 5 },
    { onTime: false, inFull: false, daysLate: 8 },
  ]
  const lines = flags.map((flag, index) => ({ purchaseOrderLineId: `L${String(index + 1).padStart(2, '0')}`, originalPromisedDate: '2026-08-01', unit: 'pcs', receivedQuantity: 100, rejectedQuantity: index < 3 ? 10 : 0, onTimeCurrent: true, early: false, otif: flag.onTime && flag.inFull, ...flag }))
  const summary = summarizeScorecardLines({ lines, invoices: [] })
  assert.equal(summary.sampleStatus, 'ok')
  assert.equal(summary.sampleSize, 12)
  assert.deepEqual([summary.metrics.onTime.count, pct(summary.metrics.onTime.rate)], [9, 75.0])
  assert.deepEqual([summary.metrics.inFull.count, pct(summary.metrics.inFull.rate)], [10, 83.3])
  assert.deepEqual([summary.metrics.otif.count, pct(summary.metrics.otif.rate)], [8, 66.7])
  assert.deepEqual([summary.metrics.rejection.rejectedQuantity, summary.metrics.rejection.receivedQuantity, pct(summary.metrics.rejection.rate)], [30, 1200, 2.5])
  assert.deepEqual(summary.metrics.averageDelayDays, { value: 5, lateCount: 3 })
})

test('fewer than 5 lines is an insufficient sample with counts but no percentages', () => {
  const lines = Array.from({ length: 4 }, (_, index) => ({ purchaseOrderLineId: `L${index}`, originalPromisedDate: '2026-08-01', unit: 'pcs', receivedQuantity: 10, rejectedQuantity: 1, onTime: index > 0, onTimeCurrent: true, inFull: true, otif: index > 0, early: false, daysLate: index ? 0 : 3 }))
  const summary = summarizeScorecardLines({ lines, invoices: [] })
  assert.equal(summary.sampleStatus, 'insufficient_sample')
  for (const key of ['onTime', 'onTimeCurrent', 'early', 'inFull', 'otif']) {
    assert.equal(summary.metrics[key].rate, null, key)
    assert.equal(summary.metrics[key].interval, null, key)
  }
  assert.equal(summary.metrics.onTime.count, 3)
  assert.equal(summary.metrics.rejection.rate, null)
  assert.equal(summarizeScorecardLines({ lines: [], invoices: [] }).sampleStatus, 'no_lines')
  // Five lines are enough.
  assert.equal(summarizeScorecardLines({ lines: [...lines, { ...lines[1], purchaseOrderLineId: 'L5' }], invoices: [] }).sampleStatus, 'ok')
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

test('on time: the receipt that covers the ordered quantity arrives by the original promise plus grace days', () => {
  // Covered on the promise day.
  assert.equal(evaluate(line('A', '2026-08-10'), [receipt('2026-08-10', 100)]).onTime, true)
  // Covered by the second receipt, two days late: 2 days late, not on time.
  const late = evaluate(line('B', '2026-08-10'), [receipt('2026-08-08', 60), receipt('2026-08-12', 40)])
  assert.deepEqual([late.onTime, late.daysLate, late.coverDay, late.firstReceiptDay], [false, 2, '2026-08-12', '2026-08-08'])
  // With 2 grace days the same delivery is on time; the delay counts from the promise.
  assert.equal(evaluate(line('C', '2026-08-10'), [receipt('2026-08-08', 60), receipt('2026-08-12', 40)], { graceDays: 2 }).onTime, true)
  // Rejected units still arrived: coverage counts accepted plus rejected.
  assert.equal(evaluate(line('D', '2026-08-10'), [receipt('2026-08-09', 90, 10)]).onTime, true)
})

test('early: covered more than 3 days before the promise is on time and reported as early', () => {
  const fourEarly = evaluate(line('A', '2026-08-10'), [receipt('2026-08-06', 100)])
  assert.deepEqual([fourEarly.onTime, fourEarly.early], [true, true])
  const threeEarly = evaluate(line('B', '2026-08-10'), [receipt('2026-08-07', 100)])
  assert.deepEqual([threeEarly.onTime, threeEarly.early], [true, false])
})

test('a partly received line is late once its promise has passed and undecided before', () => {
  const overdue = evaluate(line('A', '2026-09-20'), [receipt('2026-09-18', 40)])
  assert.deepEqual([overdue.status, overdue.onTime, overdue.stillOpen, overdue.daysLate], ['evaluated', false, true, 10])
  const notDue = evaluate(line('B', '2026-10-05'), [receipt('2026-09-28', 40)])
  assert.equal(notDue.status, 'pending')
  assert.equal(evaluate(line('C', '2026-08-10'), []).status, 'not_received')
})

test('in full: accepted quantity by the original promise reaches the ordered quantity', () => {
  assert.equal(evaluate(line('A', '2026-08-10'), [receipt('2026-08-10', 100)]).inFull, true)
  // 10 rejected: on time but not in full, so not OTIF.
  const rejected = evaluate(line('B', '2026-08-10'), [receipt('2026-08-10', 90, 10)])
  assert.deepEqual([rejected.onTime, rejected.inFull, rejected.otif, rejected.rejectedQuantity, rejected.receivedQuantity], [true, false, false, 10, 100])
  // A replacement after the promise does not make it in full.
  assert.equal(evaluate(line('C', '2026-08-10'), [receipt('2026-08-10', 90, 10), receipt('2026-08-14', 10)]).inFull, false)
  // Under these rules a line in full by its promise was also covered by it, so
  // in full lines are always on time (see the report to the product owner).
  const full = evaluate(line('D', '2026-08-10'), [receipt('2026-08-05', 50), receipt('2026-08-10', 50)])
  assert.deepEqual([full.onTime, full.inFull, full.otif], [true, true, true])
})

test('a revised date is visible: late against the original promise, on time against the current date', () => {
  const revised = evaluate(line('A', '2026-08-10', { current: '2026-08-15' }), [receipt('2026-08-14', 100)])
  assert.deepEqual([revised.revised, revised.onTime, revised.daysLate, revised.onTimeCurrent, revised.currentPromisedDate], [true, false, 4, true, '2026-08-15'])
  // Not yet due against a later current date counts as not late against it.
  const moved = evaluate(line('B', '2026-09-20', { current: '2026-10-15' }), [receipt('2026-09-18', 40)])
  assert.deepEqual([moved.onTime, moved.onTimeCurrent], [false, true])
  // No original promise recorded: never in the sample.
  assert.equal(evaluate(line('C', null, { metadata: { promisedDate: '2026-08-10' } }), [receipt('2026-08-10', 100)]).status, 'original_not_recorded')
})

test('mixed units give no single rejection rate; price variances and amounts stay per currency', () => {
  const lines = ['pcs', 'pcs', 'ft', 'pcs', 'pcs'].map((unit, index) => ({ purchaseOrderLineId: `L${index}`, originalPromisedDate: '2026-08-01', unit, receivedQuantity: 10, rejectedQuantity: 1, onTime: true, onTimeCurrent: true, inFull: false, otif: false, early: false, daysLate: 0, currency: index % 2 ? 'CAD' : 'USD', amount: 100 }))
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
  // Hidden invoices are unknown, not zero.
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
  assert.equal(supplier.lines[0].coverDay, '2026-08-03', 'arrival is the New York calendar day')
  // L2 revised 08-05 -> 08-09 and arrived 08-08; L5 six days late.
  assert.deepEqual([supplier.metrics.onTime.count, pct(supplier.metrics.onTime.rate)], [3, 60])
  assert.deepEqual([supplier.metrics.onTimeCurrent.count, pct(supplier.metrics.onTimeCurrent.rate)], [4, 80])
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
