import test from 'node:test'
import assert from 'node:assert/strict'
import { PUBLIC_DATA_SUPPLIER_INVOICE_RULES, PUBLIC_DATA_WORKSPACE_EXTRACT_SCHEMA, buildPublicDataPlan, itemThresholds, planSupplierInvoices, publicDataDraw, publicDataPlanCounts, purchasePrice, readPublicDataExtract, simulatePurchasing, titleCase } from '../../scripts/public-data/plan.mjs'
import { UCI_SCENE } from '../../scripts/public-data/scene.mjs'
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
  // Purchases at 75% of the day's selling price [assumed], to the cent; the
  // supplier terms at the last day's. M5 has no supplier invoices.
  assert.equal(plan.assumptions.purchasePricePercent, 75)
  assert.equal(plan.purchasePriceOf(plan.items[0], 0), 1.5)
  assert.equal(plan.purchasePriceOf(plan.items[0], plan.days - 1), 1.88)
  assert.equal(plan.items[0].purchasePrice, 1.88)
  assert.equal(plan.payables, null)
  assert.equal(plan.assumptions.supplierInvoices, undefined)
})

test('a purchase price is a share of the selling price, worked in whole pence', () => {
  assert.equal(purchasePrice(2.55, 50), 1.28)
  assert.equal(purchasePrice(0.85, 50), 0.43)
  assert.equal(purchasePrice(2.55, 75), 1.91)
  assert.equal(purchasePrice(4, 50), 2)
  // A draw repeats for its key and stays in [0, 1).
  assert.equal(publicDataDraw('price|7|22|0'), publicDataDraw('price|7|22|0'))
  for (const key of ['a', 'b', 'delay|1|85|0']) assert.ok(publicDataDraw(key) >= 0 && publicDataDraw(key) < 1)
})

test('public data plan keeps every UCI invoice line and its customer', () => {
  const plan = buildPublicDataPlan(syntheticExtract(), 'uci', { seedDay: '2026-11-07', scene: false })
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
  const plan = buildPublicDataPlan(syntheticExtract(), 'uci', { seedDay: '2026-11-07', lastDays: 7, scene: false })
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
    counts: { items: 200, customers: 1023, supplierInvoices: 335, secret: 1 },
    assumptions: { leadTimeDays: 14, paymentTermsDays: 30, purchasePricePercent: 50, supplierInvoices: { delayDays: 5, unpaidPercent: 10, note: 'not sent', ratio: 0.5 } },
    source: { citation: 'Chen, D. (2012). Online Retail II.', licence: 'CC BY 4.0', url: 'https://archive.ics.uci.edu/dataset/502/online+retail+ii' },
    rules: ['not sent'],
  })
  assert.deepEqual(note, {
    dataset: 'uci', sourceWindow: { first: '2010-12-10', last: '2011-12-09' }, window: { first: '2025-11-07', last: '2026-11-06' }, shiftDays: 5446,
    counts: { items: 200, customers: 1023, supplierInvoices: 335 }, assumptions: { leadTimeDays: 14, paymentTermsDays: 30, purchasePricePercent: 50, supplierInvoices: { delayDays: 5, unpaidPercent: 10 } },
    citation: 'Chen, D. (2012). Online Retail II.', licence: 'CC BY 4.0', url: 'https://archive.ics.uci.edu/dataset/502/online+retail+ii', sceneSuppliers: [],
  })
  assert.equal(publicDataNoteSummary({ dataset: 'other' }), null)
  assert.equal(publicDataNoteSummary(null), null)
  assert.equal(publicDataNoteSummary({ dataset: 'm5', sourceWindow: { first: 'x' } }), null)
  assert.equal(publicDataNoteSummary({ dataset: 'm5', sourceWindow: { first: '2015-05-24', last: '2016-05-22' }, window: { first: '2025-11-07', last: '2026-11-06' }, shiftDays: 3820, source: { url: 'javascript:alert(1)' } }).url, null)
})

// A synthetic UCI extract with the scene's products and four more in each of
// their code families, every product bought daily in steady amounts.
function sceneExtract(days = 140) {
  const codes = ['85123A', '85099B', '85099C', '85099F', '85152', '84879', '84946', '84947', '84945', '84077', '22423', '22197']
  const first = Date.UTC(2011, 6, 23)
  const at = (index) => new Date(first + index * 86400000).toISOString().slice(0, 10)
  const invoices = Array.from({ length: days }, (_, index) => ({
    number: String(560000 + index), at: `${at(index)}T10:00`, customer: '12348', country: 'Finland',
    lines: codes.map((code, position) => [code, 6 + ((index + position) % 5) * 3, 2]),
  }))
  return {
    schema: PUBLIC_DATA_WORKSPACE_EXTRACT_SCHEMA,
    m5: { source: {}, rules: [], store: 'ST_1', window: { first: '2016-01-01', last: '2016-01-01', days: 1 }, dates: ['2016-01-01'], items: [{ id: 'D_1_001', department: 'D_1', category: 'D', daily: [1], prices: [1] }] },
    uci: {
      source: {}, rules: [], window: { first: at(0), last: at(days - 1), days },
      products: codes.map((code) => ({ code, name: `PRODUCT ${code}`, price: 2 })),
      customers: [{ id: '12348', country: 'Finland' }], invoices, cancellations: [],
    },
  }
}

test('the walkthrough scene holds: a late-covered hero, a second late supplier, one suggestion at its minimum', () => {
  const plan = buildPublicDataPlan(sceneExtract(), 'uci', { seedDay: '2026-11-10' })
  const { hero, second, reorder, approval } = plan.scene
  // Hero: below safety stock, two late Acme orders (one partly received) covering its reorder point.
  assert.ok(hero.onHand > 0 && hero.onHand < hero.safetyStock)
  assert.ok(hero.position > hero.reorderPoint)
  assert.deepEqual(hero.orders.map((order) => [order.role, order.ordered, order.received, order.created, order.promised]), [
    ['hero_partly_received', 2 * hero.minimumOrderQuantity, hero.minimumOrderQuantity, -20, -6],
    ['hero_nothing_received', 2 * hero.minimumOrderQuantity, 0, -18, -4],
  ])
  // Second supplier: one late order, nothing received, that covers the item.
  assert.equal(second.order.promised, -5)
  assert.ok(second.position > second.reorderPoint)
  // The reorder suggestion: no open order, a shortfall under the minimum, raised to it.
  assert.equal(reorder.shortfall, UCI_SCENE.reorder.shortfall)
  assert.equal(reorder.suggested, reorder.minimumOrderQuantity)
  assert.equal(approval.ordered, approval.minimumOrderQuantity)
  // Suppliers: the two fictional names on reserved domains; Acme Tier 1.
  const named = plan.suppliers.filter((supplier) => supplier.scene)
  assert.deepEqual(named.map((supplier) => [supplier.code, supplier.name, supplier.email, supplier.tier]), [
    ['GLOBEX', 'Globex Party Supplies', 'orders@globex-party.example', null],
    ['ACME', 'Acme Home Goods', 'orders@acme-homegoods.example', 1],
  ])
  for (const supplier of named) assert.match(supplier.email, /@[a-z-]+\.example$/)
  // Orders: the scene's are open and late; one waits for approval; nothing else is late.
  const n = plan.days
  const received = (order) => order.receipts.reduce((total, receipt) => total + receipt.lines.reduce((sum, line) => sum + line.quantity, 0), 0)
  const ordered = (order) => order.lines.reduce((total, line) => total + line.quantity, 0)
  const lateOpen = plan.purchasing.orders.filter((order) => order.status === 'issued' && !order.closed && order.promised < n && received(order) < ordered(order))
  assert.deepEqual(lateOpen.map((order) => order.scene).sort(), ['hero_nothing_received', 'hero_partly_received', 'second_supplier_late'])
  assert.deepEqual(plan.purchasing.orders.filter((order) => order.status === 'pending_approval').map((order) => order.scene), ['waiting_for_approval'])
  // Acme delivered some weekly orders after their promised date.
  const acme = plan.purchasing.orders.filter((order) => order.supplierKey === '85' && !order.scene && order.receipts.length)
  assert.ok(acme.some((order) => order.receipts[0].index > order.promised))
  assert.ok(acme.some((order) => order.receipts[0].index === order.promised))
  // The public sales are untouched by the scene.
  assert.equal(plan.salesOrders.length, 140)
})

test('UCI supplier invoices: one per receipt by the stated rules, the same every time', () => {
  const rules = PUBLIC_DATA_SUPPLIER_INVOICE_RULES
  const plan = buildPublicDataPlan(sceneExtract(), 'uci', { seedDay: '2026-11-10' })
  const again = buildPublicDataPlan(sceneExtract(), 'uci', { seedDay: '2026-11-10' })
  assert.deepEqual(again.payables, plan.payables, 'the same plan picks the same invoices')
  // Purchases at half the selling price [assumed].
  assert.equal(plan.assumptions.purchasePricePercent, 50)
  assert.equal(plan.items[0].purchasePrice, 1)
  assert.deepEqual(plan.assumptions.supplierInvoices, rules)
  const n = plan.days
  const { invoices, notYetInvoiced } = plan.payables
  const receipts = plan.purchasing.orders.filter((order) => order.status === 'issued').reduce((total, order) => total + order.receipts.length, 0)
  assert.equal(invoices.length + notYetInvoiced.length, receipts, 'every receipt is invoiced or waits for its invoice')
  assert.ok(invoices.length > 40)
  const count = (rule) => invoices.filter((row) => row.rule === rule).length
  assert.equal(count('short_delivery'), Math.round((invoices.length * rules.shortDeliveryPercent) / 100))
  assert.equal(count('price_above_order'), Math.round((invoices.length * rules.priceAbovePercent) / 100))
  assert.equal(count('dated_before_receipt'), Math.round((invoices.length * rules.beforeReceiptPercent) / 100))
  for (const row of invoices) {
    const order = plan.purchasing.orders[row.orderPosition]
    assert.ok(row.day < n, `${row.number} is dated before the seed day`)
    assert.equal(row.due, row.day + 30)
    assert.equal(row.totalPence, row.lines.reduce((total, line) => total + line.quantity * line.unitPricePence, 0))
    if (row.rule === 'dated_before_receipt') assert.ok(row.receiptDay - row.day >= rules.beforeReceiptFrom && row.receiptDay - row.day <= rules.beforeReceiptTo)
    else assert.ok(row.day - row.receiptDay >= 0 && row.day - row.receiptDay <= rules.delayDays)
    // Differences fall only on weekly orders, on one line, and hold the invoice at the match.
    if (row.match === 'exception') {
      assert.equal(order.scene, undefined)
      assert.equal(row.payment, 'held')
      const changed = row.lines.filter((line) => line.unitPricePence !== line.orderPricePence || line.quantity !== line.received)
      assert.deepEqual(changed, [row.lines[row.changedLine]])
    }
    if (row.rule === 'price_above_order') {
      const line = row.lines[row.changedLine]
      assert.ok(row.percent >= rules.priceAboveFrom && row.percent <= rules.priceAboveTo)
      assert.equal(line.unitPricePence, Math.ceil((line.orderPricePence * (100 + row.percent)) / 100))
    }
    // A short delivery is billed as ordered; the order closes the rest that day.
    if (row.rule === 'short_delivery') {
      const line = row.lines[row.changedLine]
      assert.equal(line.quantity - line.received, Math.max(1, Math.ceil((line.received * rules.shortByPercent) / 100)))
      assert.equal(order.lines[line.orderLine].quantity, line.quantity)
      assert.deepEqual(order.closed, { day: row.day, itemKey: line.itemKey, missing: line.quantity - line.received })
    }
    // Matched: paid on the due date before the seed day unless left overdue; later ones open.
    if (row.match === 'matched') assert.equal(row.payment, row.due >= n ? 'open' : row.paidDay === row.due ? 'paid' : 'overdue')
    if (row.payment === 'overdue') assert.ok(row.due < n && row.due >= n - rules.unpaidWithinDays)
  }
  // Numbered per supplier in date order.
  const acme = invoices.filter((row) => row.supplierKey === '85')
  assert.deepEqual(acme.map((row) => row.number), acme.map((_, index) => `INV-ACME-${String(index + 1).padStart(4, '0')}`))
  // Orders closed short are not open; the counts say how many invoices of each kind.
  const counts = publicDataPlanCounts(plan)
  assert.equal(counts.closedShortPurchaseOrders, count('short_delivery'))
  assert.equal(counts.supplierInvoices, invoices.length)
  assert.equal(counts.supplierInvoicesWithDifferences, count('short_delivery') + count('price_above_order'))
  assert.equal(counts.receiptsNotInvoiced, notYetInvoiced.length)
  // A rule's value does not lean on the draw that picked the invoice: with
  // half the invoices dated early, every number of days in the range occurs.
  const early = planSupplierInvoices({
    orders: plan.purchasing.orders, items: plan.items, suppliers: plan.suppliers, days: n, termsDays: 30, priceOf: plan.purchasePriceOf,
    rules: { ...rules, shortDeliveryPercent: 0, priceAbovePercent: 0, beforeReceiptPercent: 50 },
  }).invoices.filter((row) => row.rule === 'dated_before_receipt')
  assert.deepEqual([...new Set(early.map((row) => row.receiptDay - row.day))].sort(), [1, 2, 3])
})

test('a scene product missing from the extract stops the plan with its code', () => {
  const extract = sceneExtract()
  extract.uci.products = extract.uci.products.filter((product) => product.code !== '22423')
  extract.uci.invoices = extract.uci.invoices.map((invoice) => ({ ...invoice, lines: invoice.lines.filter(([code]) => code !== '22423') }))
  assert.throws(() => buildPublicDataPlan(extract, 'uci', { seedDay: '2026-11-10' }), /needs UCI products 22423/)
  assert.doesNotThrow(() => buildPublicDataPlan(extract, 'uci', { seedDay: '2026-11-10', scene: false }))
})

test('trimmed closing stock never leaves a day short', () => {
  const days = 50
  const daily = Array.from({ length: days }, (_, index) => 5 + (index % 4))
  const item = { key: 'A', supplierKey: 'S', daily, ...itemThresholds(6.5), targetClosing: 3 }
  const reviewIndexes = Array.from({ length: days }, (_, index) => index).filter((index) => index % 7 === 0)
  const result = simulatePurchasing({ days, items: [item], reviewIndexes, leadTimeDays: 14, delayOf: (review) => (review === 7 ? 2 : 0) })
  let onHand = result.opening.A
  for (let day = 0; day < days; day += 1) {
    for (const order of result.orders) if (order.arrival === day) onHand += order.lines[0].quantity
    assert.ok(onHand >= daily[day], `day ${day}`)
    onHand -= daily[day]
  }
  assert.equal(onHand, result.closing.A)
  assert.ok(result.closing.A >= 3)
  for (const order of result.orders) {
    assert.equal(order.arrival, order.review + 14 + (order.review === 7 ? 2 : 0))
    assert.ok(order.lines[0].quantity >= item.minimumOrderQuantity)
  }
})
