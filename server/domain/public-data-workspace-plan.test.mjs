import test from 'node:test'
import assert from 'node:assert/strict'
import { PUBLIC_DATA_WORKSPACE_EXTRACT_SCHEMA, buildPublicDataPlan, itemThresholds, publicDataPlanCounts, readPublicDataExtract, simulatePurchasing, titleCase } from '../../scripts/public-data/plan.mjs'
import { publicDataNoteSummary } from './public-data-note.mjs'

// A tiny synthetic extract in the shape scripts/public-data/extract_public_data.py
// writes; the real one is public data kept outside the repository.
function syntheticExtract() {
  const days = 28
  const dates = Array.from({ length: days }, (_, index) => new Date(Date.UTC(2016, 3, 25 + index)).toISOString().slice(0, 10))
  const steady = Array.from({ length: days }, () => 4)
  const spiky = Array.from({ length: days }, (_, index) => (index === 20 ? 90 : index % 3 === 0 ? 1 : 0))
  return {
    schema: PUBLIC_DATA_WORKSPACE_EXTRACT_SCHEMA,
    m5: {
      source: { dataset: 'M5', citation: 'Synthetic citation.' },
      rules: ['rule'],
      store: 'ST_1',
      window: { first: dates[0], last: dates.at(-1), days },
      dates,
      events: { [dates[3]]: 'Holiday' },
      items: [
        { id: 'DEPT_A_001', department: 'DEPT_A', category: 'DEPT', daily: steady, prices: steady.map((_, index) => (index < 14 ? 2 : 2.5)) },
        { id: 'DEPT_B_002', department: 'DEPT_B', category: 'DEPT', daily: spiky, prices: spiky.map(() => 10) },
      ],
    },
    uci: {
      source: { dataset: 'UCI', citation: 'Synthetic citation.', licence: 'CC BY 4.0', url: 'https://example.org/data' },
      rules: ['rule'],
      window: { first: '2011-11-12', last: '2011-12-09', days },
      products: [
        { code: '10001', name: 'BLUE PAPER LANTERN SET/3', price: 1.25 },
        { code: '10002', name: 'RED T-LIGHT HOLDER', price: 0.85 },
        { code: '99001', name: 'WOODEN BOX', price: 4 },
      ],
      customers: [{ id: '12348', country: 'Finland' }, { id: '12352', country: 'Norway' }],
      invoices: [
        { number: '580001', at: '2011-11-12T09:15', customer: '12348', country: 'Finland', lines: [['10001', 12, 1.25], ['10002', 24, 0.85]] },
        { number: '580700', at: '2011-12-09T12:50', customer: '12352', country: 'Norway', lines: [['10001', 400, 1.1], ['99001', 2, 4]] },
      ],
      cancellations: [{ number: 'C580701', at: '2011-12-09T13:00', customer: '12352', country: 'Norway', lines: [['99001', 1, 4]] }],
    },
  }
}

test('public data plan moves the window so its last day is yesterday', () => {
  const plan = buildPublicDataPlan(syntheticExtract(), 'm5', { seedDay: '2026-11-07' })
  assert.deepEqual(plan.window, { first: '2026-10-10', last: '2026-11-06' })
  assert.equal(plan.offsetOf(plan.days - 1), -1)
  assert.equal(plan.shiftDays, (Date.UTC(2026, 9, 10) - Date.UTC(2016, 3, 25)) / 86400000)
  assert.equal(plan.profile.currency, 'USD')
  assert.equal(plan.profile.timezone, 'America/Los_Angeles')
  // Every review day is a Monday of the moved calendar.
  for (const index of plan.reviewIndexes) assert.equal(new Date(Date.UTC(2026, 9, 10 + index)).getUTCDay(), 1)
  // One order a day with what sold that day, at that week's price, and the source day kept.
  const firstDay = plan.salesOrders.find((order) => order.index === 0)
  assert.deepEqual(firstDay.lines, [{ itemKey: 'DEPT_A_001', quantity: 4, unitPrice: 2 }, { itemKey: 'DEPT_B_002', quantity: 1, unitPrice: 10 }])
  assert.equal(firstDay.source.date, '2016-04-25')
  assert.equal(plan.salesOrders.find((order) => order.index === 3).source.event, 'Holiday')
  // Names from the item id; suppliers one per department, labelled assumed.
  assert.equal(plan.items[0].name, 'Dept A item 001')
  assert.deepEqual(plan.suppliers.map((supplier) => supplier.name), ['Dept A vendor (assumed)', 'Dept B vendor (assumed)'])
  assert.equal(plan.items[0].price, 2.5)
})

test('public data plan keeps every UCI invoice line and its customer', () => {
  const plan = buildPublicDataPlan(syntheticExtract(), 'uci', { seedDay: '2026-11-07' })
  assert.equal(plan.profile.currency, 'GBP')
  assert.deepEqual(plan.customers.map((customer) => [customer.code, customer.name]), [['CUST-12348', 'Customer 12348 (Finland)'], ['CUST-12352', 'Customer 12352 (Norway)']])
  assert.deepEqual(plan.salesOrders.map((order) => [order.index, order.orderedAt, order.shippedAt, order.source.invoice]), [[0, '09:15', '10:15', '580001'], [27, '12:50', '13:50', '580700']])
  assert.equal(plan.items.find((item) => item.sku === '10001').daily[27], 400)
  assert.equal(plan.items.find((item) => item.sku === '10001').name, 'Blue Paper Lantern Set/3')
  assert.equal(plan.items.find((item) => item.sku === '10002').name, 'Red T-Light Holder')
  // Code families with fewer than five products share one supplier.
  assert.deepEqual(plan.suppliers.map((supplier) => supplier.code), ['SUP-OTHER'])
  assert.equal(plan.cancellations.length, 1)
  assert.equal(publicDataPlanCounts(plan).salesOrderLines, 4)
})

test('a shorter public data plan keeps only the last days', () => {
  const plan = buildPublicDataPlan(syntheticExtract(), 'uci', { seedDay: '2026-11-07', lastDays: 7 })
  assert.equal(plan.days, 7)
  assert.deepEqual(plan.salesOrders.map((order) => order.index), [6])
  assert.equal(plan.sourceWindow.first, '2011-12-03')
  assert.equal(plan.items[0].daily.length, 7)
})

test('assumed thresholds follow the research rules', () => {
  assert.deepEqual(itemThresholds(4), { safetyStock: 28, reorderPoint: 84, minimumOrderQuantity: 30 })
  assert.deepEqual(itemThresholds(0.2), { safetyStock: 1, reorderPoint: 4, minimumOrderQuantity: 10 })
  assert.equal(titleCase('SET OF 3 CAKE TINS PANTRY DESIGN'), 'Set Of 3 Cake Tins Pantry Design')
})

test('assumed purchasing ships every public order in full', () => {
  const days = 60
  const daily = Array.from({ length: days }, (_, index) => (index === 30 ? 500 : index % 2 ? 6 : 2))
  const item = { key: 'A', supplierKey: 'S', daily, ...itemThresholds(4) }
  const reviewIndexes = Array.from({ length: days }, (_, index) => index).filter((index) => index % 7 === 2)
  const result = simulatePurchasing({ days, items: [item], reviewIndexes, leadTimeDays: 14 })
  let onHand = result.opening.A
  for (let day = 0; day < days; day += 1) {
    for (const order of result.orders) if (order.arrival === day) onHand += order.lines[0].quantity
    assert.ok(onHand >= daily[day], `day ${day}: ${onHand} on hand for ${daily[day]}`)
    onHand -= daily[day]
  }
  assert.equal(onHand, result.closing.A)
  // The spike was met by raising an earlier order, never by cutting demand.
  assert.ok(result.raisedDays >= 1)
  assert.ok(result.orders.some((order) => order.lines.some((line) => line.raisedBy > 0)))
  for (const order of result.orders) {
    assert.ok(reviewIndexes.includes(order.review))
    assert.equal(order.arrival, order.review + 14)
    for (const line of order.lines) assert.ok(line.quantity >= item.minimumOrderQuantity)
  }
})

test('a missing public data extract says how to write one', () => {
  assert.throws(() => readPublicDataExtract('C:/no/such/extract.json'), /extract_public_data\.py --uci .* --m5 .* --out/)
})

test('the workspace note sends only its known fields', () => {
  const note = publicDataNoteSummary({
    dataset: 'uci', sourceWindow: { first: '2010-12-10', last: '2011-12-09' }, window: { first: '2025-11-07', last: '2026-11-06' }, shiftDays: 5446,
    counts: { items: 200, customers: 1023, secret: 1 }, assumptions: { leadTimeDays: 14, paymentTermsDays: 30 },
    source: { citation: 'Chen, D. (2012). Online Retail II.', licence: 'CC BY 4.0', url: 'https://archive.ics.uci.edu/dataset/502/online+retail+ii' },
    rules: ['not sent'],
  })
  assert.deepEqual(note, {
    dataset: 'uci', sourceWindow: { first: '2010-12-10', last: '2011-12-09' }, window: { first: '2025-11-07', last: '2026-11-06' }, shiftDays: 5446,
    counts: { items: 200, customers: 1023 }, assumptions: { leadTimeDays: 14, paymentTermsDays: 30 },
    citation: 'Chen, D. (2012). Online Retail II.', licence: 'CC BY 4.0', url: 'https://archive.ics.uci.edu/dataset/502/online+retail+ii',
  })
  assert.equal(publicDataNoteSummary({ dataset: 'other' }), null)
  assert.equal(publicDataNoteSummary(null), null)
  assert.equal(publicDataNoteSummary({ dataset: 'm5', sourceWindow: { first: 'x' } }), null)
  assert.equal(publicDataNoteSummary({ dataset: 'm5', sourceWindow: { first: '2015-05-24', last: '2016-05-22' }, window: { first: '2025-11-07', last: '2026-11-06' }, shiftDays: 3820, source: { url: 'javascript:alert(1)' } }).url, null)
})
