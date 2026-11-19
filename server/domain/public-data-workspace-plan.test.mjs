import test from 'node:test'
import assert from 'node:assert/strict'
import {
  PUBLIC_DATA_PURCHASE_REQUEST_RULES, PUBLIC_DATA_SUPPLIER_INVOICE_RULES, PUBLIC_DATA_TIER_RULES, PUBLIC_DATA_WORKSPACE_ASSUMPTIONS, PUBLIC_DATA_WORKSPACE_EXTRACT_SCHEMA,
  buildPublicDataPlan, itemThresholdSchedule, minimumOrderQuantity, planSupplierInvoices, publicDataDraw, publicDataPlanCounts, purchasePrice, readPublicDataExtract,
  simulatePurchasing, thresholdsAsOf, titleCase, wholeWeekCut,
} from '../../scripts/public-data/plan.mjs'
import { UCI_SCENE } from '../../scripts/public-data/scene.mjs'
import { priceDifferenceHeld } from './operational-finance-policy.mjs'
import { dailyDemand, reorderSizing } from './reorder-list.mjs'
import { suggestReorderPoint } from './reorder-point-suggestion.mjs'
import { orderUpToLevel } from '../../shared/purchase-suggestion.mjs'
import { publicDataNoteSummary } from './public-data-note.mjs'

const DAY_MS = 86400000
const isoPlus = (iso, days) => new Date(Date.parse(`${iso}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10)
const weekday = (iso) => new Date(`${iso}T00:00:00Z`).getUTCDay()

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
        { number: '580600', at: '2011-12-08T12:50', customer: '12352', country: 'Norway', lines: [['10001', 400, 1.1], ['99001', 2, 4]] },
      ],
      cancellations: [{ number: 'C580601', at: '2011-12-08T13:00', customer: '12352', country: 'Norway', lines: [['99001', 1, 4]] }],
    },
  }
}

// A year of M5-shaped data for one item, its daily demand given by `daily`.
function m5Year(daily, first = '2015-05-24') {
  const days = daily.length
  const dates = Array.from({ length: days }, (_, index) => isoPlus(first, index))
  return {
    schema: PUBLIC_DATA_WORKSPACE_EXTRACT_SCHEMA,
    m5: { source: { dataset: 'M5' }, rules: [], store: 'ST_1', window: { first: dates[0], last: dates.at(-1), days }, dates, events: {}, items: [{ id: 'DEPT_A_001', department: 'DEPT_A', category: 'DEPT', daily, prices: daily.map(() => 2) }] },
    uci: { products: [{ code: '10001', name: 'X', price: 1 }] },
  }
}
const seasonal = (days) => Array.from({ length: days }, (_, index) => (index % 7 === 3 ? 0 : 3 + Math.floor(index / 40) + ((index * 7) % 5)))

test('public data plan moves the window by whole weeks so its last day is yesterday', () => {
  // The data ends on a Sunday; seeded on a Saturday, its last two days
  // (which would be Saturday and Sunday) are left out.
  const plan = buildPublicDataPlan(syntheticExtract(), 'm5', { seedDay: '2026-11-07' })
  assert.equal(plan.droppedDays, 2)
  assert.equal(plan.days, 26)
  assert.deepEqual(plan.window, { first: '2026-10-12', last: '2026-11-06' })
  assert.equal(plan.sourceWindow.last, '2016-05-20')
  assert.equal(plan.offsetOf(plan.days - 1), -1)
  assert.equal(plan.shiftDays % 7, 0)
  assert.equal(plan.shiftDays, (Date.UTC(2026, 9, 12) - Date.UTC(2016, 3, 25)) / DAY_MS)
  assert.equal(plan.profile.currency, 'USD')
  assert.equal(plan.profile.timezone, 'America/Los_Angeles')
  // Every review day is a Monday of the moved calendar, and of the data.
  for (const index of plan.reviewIndexes) {
    assert.equal(weekday(plan.dayOf(index)), 1)
    assert.equal(weekday(isoPlus(plan.sourceWindow.first, index)), 1)
  }
  // One order a day with what sold that day, at that week's price, and the source day kept.
  const firstDay = plan.salesOrders.find((order) => order.index === 0)
  assert.deepEqual(firstDay.lines, [{ itemKey: 'DEPT_A_001', quantity: 4, unitPrice: 2 }, { itemKey: 'DEPT_B_002', quantity: 1, unitPrice: 10 }])
  assert.equal(firstDay.source.date, '2016-04-25')
  assert.equal(plan.salesOrders.find((order) => order.index === 3).source.event, 'Holiday')
  assert.ok(plan.salesOrders.every((order) => order.index < plan.days))
  // Names from the item id; suppliers one per department, labelled assumed.
  assert.equal(plan.items[0].name, 'Dept A item 001')
  assert.deepEqual(plan.suppliers.map((supplier) => supplier.name), ['Dept A vendor (assumed)', 'Dept B vendor (assumed)'])
  assert.equal(plan.items[0].price, 2.5)
  // Purchases at 75% of the day's selling price [assumed], to the cent; the
  // supplier terms at the last day's. M5 has no supplier invoices and no
  // orders still being filled.
  assert.equal(plan.assumptions.purchasePricePercent, 75)
  assert.equal(plan.purchasePriceOf(plan.items[0], 0), 1.5)
  assert.equal(plan.purchasePriceOf(plan.items[0], plan.days - 1), 1.88)
  assert.equal(plan.items[0].purchasePrice, 1.88)
  assert.equal(plan.payables, null)
  assert.equal(plan.assumptions.supplierInvoices, undefined)
  assert.deepEqual(plan.openSales, [])
})

test('the date shift is a multiple of 7 on every seed day, and the history does not depend on it', () => {
  const extract = m5Year(seasonal(364))
  const plans = Array.from({ length: 7 }, (_, offset) => buildPublicDataPlan(extract, 'm5', { seedDay: isoPlus('2026-11-16', offset) }))
  for (const plan of plans) {
    assert.equal(plan.shiftDays % 7, 0, plan.seedDay)
    assert.equal(isoPlus(plan.window.last, 1), plan.seedDay)
    assert.equal(weekday(plan.window.last), weekday(plan.sourceWindow.last))
    assert.ok(plan.droppedDays >= 0 && plan.droppedDays <= 6)
    assert.equal(plan.droppedDays, wholeWeekCut(extract.m5.window.last, plan.seedDay))
    assert.equal(plan.days, 364 - plan.droppedDays)
  }
  // The same source days are reviewed and the same orders placed on the days
  // every seed keeps.
  const shortest = Math.min(...plans.map((plan) => plan.days))
  const history = (plan) => plan.purchasing.orders.filter((order) => order.created < shortest - 21).map((order) => [isoPlus(plan.sourceWindow.first, order.created), order.lines.map((line) => line.quantity).join('+')])
  for (const plan of plans) assert.deepEqual(history(plan), history(plans[0]))
})

test('thresholds come from the app\'s own rules over the days before they are set only', () => {
  const daily = seasonal(364)
  const plan = buildPublicDataPlan(m5Year(daily), 'm5', { seedDay: '2026-11-16' })
  const item = plan.items[0]
  const calibrationDays = PUBLIC_DATA_WORKSPACE_ASSUMPTIONS.calibrationDays
  assert.equal(plan.calibrationDays, calibrationDays)
  // The reorder list's suggestion (5 of 6 past stretches of lead time + 7
  // days) and the app's (s, S) default, from exactly the days before.
  const appRule = (index) => {
    const lines = []
    for (let day = Math.max(0, index - 90); day < index; day += 1) if (item.daily[day] > 0) lines.push({ unit: 'pcs', quantity: item.daily[day], postedAt: plan.dayOf(day) })
    const today = plan.dayOf(index)
    const demand = dailyDemand({ lines, stockUnit: 'pcs', today })
    const reorderPoint = suggestReorderPoint({ lines, stockUnit: 'pcs', leadTimeDays: 14, today }).suggestedReorderPoint
    return { reorderPoint, orderUpTo: orderUpToLevel({ reorderPoint, averageDailyDemand: demand.averageDailyDemand }).level, safetyStock: Math.round(demand.averageDailyDemand * 7) }
  }
  const pick = (row) => ({ reorderPoint: row.reorderPoint, orderUpTo: row.orderUpTo, safetyStock: row.safetyStock })
  assert.deepEqual(pick(item.schedule.calibration), appRule(calibrationDays))
  for (const [review, thresholds] of item.schedule.byReview) {
    assert.deepEqual(pick(thresholds), appRule(Math.max(review, calibrationDays)), `review ${review}`)
    assert.equal(thresholds.setOn, Math.max(review, calibrationDays) === calibrationDays ? calibrationDays : review)
  }
  // The item records its latest review's figures (W-01: the list's own suggestion).
  const lastReview = Math.max(...plan.reviewIndexes)
  assert.deepEqual({ reorderPoint: item.reorderPoint, safetyStock: item.safetyStock, setOn: item.thresholdsSetOn }, { reorderPoint: appRule(lastReview).reorderPoint, safetyStock: appRule(lastReview).safetyStock, setOn: lastReview })
  // The minimum order is a week of the calibration period's average.
  const calibrationMean = daily.slice(0, calibrationDays).reduce((total, value) => total + value, 0) / calibrationDays
  assert.equal(item.minimumOrderQuantity, minimumOrderQuantity(calibrationMean))
  // No later demand moves a threshold set before it: change everything from
  // a review on, and that review's and every earlier one's stay.
  const cutReview = plan.reviewIndexes.find((review) => review > calibrationDays + 60)
  const changed = daily.map((value, index) => (index >= cutReview ? value * 5 + 40 : value))
  const other = buildPublicDataPlan(m5Year(changed), 'm5', { seedDay: '2026-11-16' }).items[0]
  for (const review of plan.reviewIndexes.filter((day) => day <= cutReview)) assert.deepEqual(pick(other.schedule.byReview.get(review)), pick(item.schedule.byReview.get(review)), `review ${review}`)
  assert.equal(other.minimumOrderQuantity, item.minimumOrderQuantity)
  assert.notDeepEqual(pick(other.schedule.recorded), pick(item.schedule.recorded))
  // Nor does demand after the calibration period move the calibration figures.
  const afterCalibration = daily.map((value, index) => (index >= calibrationDays ? 0 : value))
  assert.deepEqual(pick(buildPublicDataPlan(m5Year(afterCalibration), 'm5', { seedDay: '2026-11-16' }).items[0].schedule.calibration), pick(item.schedule.calibration))
})

test('the history orders by the reorder list\'s own (s, S) rule at every review', () => {
  const daily = seasonal(364)
  const plan = buildPublicDataPlan(m5Year(daily), 'm5', { seedDay: '2026-11-16' })
  const item = plan.items[0]
  const { purchasing } = plan
  assert.equal(purchasing.opening[item.key] >= Math.ceil(item.schedule.calibration.orderUpTo), true)
  let onHand = purchasing.opening[item.key]
  const placed = new Map(purchasing.orders.map((order) => [order.review, order]))
  let checked = 0
  for (let day = 0; day < plan.days; day += 1) {
    for (const order of purchasing.orders) if (order.arrival === day) onHand += order.lines[0].quantity
    if (plan.reviewIndexes.includes(day)) {
      const thresholds = item.schedule.byReview.get(day)
      const onOrder = purchasing.orders.filter((order) => order.review < day && order.arrival > day).reduce((total, order) => total + order.lines[0].quantity, 0)
      const ordered = placed.get(day)?.lines[0]
      const { sized } = reorderSizing({ item: {}, reorderPoint: thresholds.reorderPoint, demand: thresholds.demand, position: onHand + onOrder, stock: onHand, minimum: item.minimumOrderQuantity, today: plan.dayOf(day) })
      // A raise after the fact adds to an order placed that day.
      if (sized.quantity.value) assert.equal(ordered.quantity - ordered.raisedBy, sized.quantity.value, `day ${day}`)
      else assert.ok(!ordered || ordered.raisedBy === ordered.quantity, `day ${day}`)
      checked += 1
    }
    onHand -= daily[day]
    assert.ok(onHand >= 0, `day ${day}`)
  }
  assert.ok(checked > 40)
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
  // The data ends on a Friday; seeded on a Saturday nothing is left out.
  const plan = buildPublicDataPlan(syntheticExtract(), 'uci', { seedDay: '2026-11-07', scene: false })
  assert.equal(plan.droppedDays, 0)
  assert.equal(plan.profile.currency, 'GBP')
  assert.deepEqual(plan.customers.map((customer) => [customer.code, customer.name]), [['CUST-12348', 'Customer 12348 (Finland)'], ['CUST-12352', 'Customer 12352 (Norway)']])
  assert.deepEqual(plan.salesOrders.map((order) => [order.index, order.orderedAt, order.shippedAt, order.source.invoice]), [[0, '09:15', '10:15', '580001'], [26, '12:50', '13:50', '580600']])
  assert.equal(plan.items.find((item) => item.sku === '10001').daily[26], 400)
  assert.equal(plan.items.find((item) => item.sku === '10001').name, 'Blue Paper Lantern Set/3')
  assert.equal(plan.items.find((item) => item.sku === '10002').name, 'Red T-Light Holder')
  // Code families with fewer than five products share one supplier.
  assert.deepEqual(plan.suppliers.map((supplier) => supplier.code), ['SUP-OTHER'])
  assert.equal(plan.cancellations.length, 1)
  assert.equal(publicDataPlanCounts(plan).salesOrderLines, 4)
  // Seeded on a Monday, the data's Friday is the last day kept: its
  // Saturday and Sunday would fall on the seed day or after it.
  const monday = buildPublicDataPlan(syntheticExtract(), 'uci', { seedDay: '2026-11-09', scene: false })
  assert.equal(monday.window.last, '2026-11-08')
  assert.equal(monday.sourceWindow.last, '2011-12-04')
  assert.deepEqual(monday.salesOrders.map((order) => order.source.invoice), ['580001'])
})

test('a shorter public data plan keeps only the last days', () => {
  const plan = buildPublicDataPlan(syntheticExtract(), 'uci', { seedDay: '2026-11-07', lastDays: 7, scene: false })
  assert.equal(plan.days, 7)
  assert.deepEqual(plan.salesOrders.map((order) => order.index), [5])
  assert.equal(plan.sourceWindow.first, '2011-12-03')
  assert.equal(plan.items[0].daily.length, 7)
  assert.equal(plan.calibrationDays, 7)
})

test('the minimum order is a week of demand rounded up to 10', () => {
  assert.equal(minimumOrderQuantity(4), 30)
  assert.equal(minimumOrderQuantity(0.2), 10)
  assert.equal(minimumOrderQuantity(0), 10)
  assert.equal(titleCase('SET OF 3 CAKE TINS PANTRY DESIGN'), 'Set Of 3 Cake Tins Pantry Design')
  // No thresholds before 8 shipment days: the app makes no suggestion.
  assert.equal(thresholdsAsOf({ daily: [5, 5, 5, 0, 0, 0, 0, 0, 0, 0], index: 10 }), null)
})

// One item's schedule from a steady daily demand.
function steadyItem(perDay, days, reviewIndexes, extra = {}) {
  const daily = Array.from({ length: days }, (_, index) => (typeof perDay === 'function' ? perDay(index) : perDay))
  const schedule = itemThresholdSchedule({ daily, reviewIndexes, calibrationDays: Math.min(90, days), leadTimeDays: 14, reviewDays: 7 })
  return { key: 'A', supplierKey: 'S', daily, schedule, minimumOrderQuantity: minimumOrderQuantity(4), ...extra }
}

test('assumed purchasing ships every public order in full', () => {
  const days = 160
  const reviewIndexes = Array.from({ length: days }, (_, index) => index).filter((index) => index % 7 === 2)
  const item = steadyItem((index) => (index === 120 ? 500 : index % 2 ? 6 : 2), days, reviewIndexes)
  const result = simulatePurchasing({ days, items: [item], reviewIndexes, leadTimeDays: 14 })
  let onHand = result.opening.A
  for (let day = 0; day < days; day += 1) {
    for (const order of result.orders) if (order.arrival === day) onHand += order.lines[0].quantity
    assert.ok(onHand >= item.daily[day], `day ${day}: ${onHand} on hand for ${item.daily[day]}`)
    onHand -= item.daily[day]
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
    assumptions: { leadTimeDays: 14, paymentTermsDays: 30, purchasePricePercent: 50, calibrationDays: 90, supplierInvoices: { delayDays: 5, unpaidPercent: 10, resolveFrom: 3, resolveTo: 14, note: 'not sent', ratio: 0.5 } },
    source: { citation: 'Chen, D. (2012). Online Retail II.', licence: 'CC BY 4.0', url: 'https://archive.ics.uci.edu/dataset/502/online+retail+ii' },
    rules: ['not sent'],
  })
  assert.deepEqual(note, {
    dataset: 'uci', sourceWindow: { first: '2010-12-10', last: '2011-12-09' }, window: { first: '2025-11-07', last: '2026-11-06' }, shiftDays: 5446,
    counts: { items: 200, customers: 1023, supplierInvoices: 335 }, assumptions: { leadTimeDays: 14, paymentTermsDays: 30, purchasePricePercent: 50, calibrationDays: 90, supplierInvoices: { delayDays: 5, unpaidPercent: 10, resolveFrom: 3, resolveTo: 14 } },
    citation: 'Chen, D. (2012). Online Retail II.', licence: 'CC BY 4.0', url: 'https://archive.ics.uci.edu/dataset/502/online+retail+ii', sceneSuppliers: [],
  })
  assert.equal(publicDataNoteSummary({ dataset: 'other' }), null)
  assert.equal(publicDataNoteSummary(null), null)
  assert.equal(publicDataNoteSummary({ dataset: 'm5', sourceWindow: { first: 'x' } }), null)
  assert.equal(publicDataNoteSummary({ dataset: 'm5', sourceWindow: { first: '2015-05-24', last: '2016-05-22' }, window: { first: '2025-11-07', last: '2026-11-06' }, shiftDays: 3820, source: { url: 'javascript:alert(1)' } }).url, null)
})

// A synthetic UCI extract with the scene's products and four more in each of
// their code families, every product bought daily in steady amounts; every
// sixth day a second customer buys only products outside the scene.
function sceneExtract(days = 140) {
  const codes = ['85123A', '85099B', '85099C', '85099F', '85152', '84879', '84946', '84947', '84945', '84077', '22423', '22197']
  const sceneCodes = new Set(['85123A', '85152', '84879', '22423'])
  const first = Date.UTC(2011, 6, 23)
  const at = (index) => new Date(first + index * DAY_MS).toISOString().slice(0, 10)
  const invoices = Array.from({ length: days }, (_, index) => ({
    number: String(560000 + index), at: `${at(index)}T10:00`, customer: '12348', country: 'Finland',
    lines: codes.map((code, position) => [code, 6 + ((index + position) % 5) * 3, 2]),
  }))
  for (let index = 2; index < days; index += 6) {
    invoices.push({ number: String(570000 + index), at: `${at(index)}T15:30`, customer: '12352', country: 'Norway', lines: codes.filter((code) => !sceneCodes.has(code)).slice(0, 2 + (index % 3)).map((code) => [code, 4, 2]) })
  }
  return {
    schema: PUBLIC_DATA_WORKSPACE_EXTRACT_SCHEMA,
    m5: { source: {}, rules: [], store: 'ST_1', window: { first: '2016-01-01', last: '2016-01-01', days: 1 }, dates: ['2016-01-01'], items: [{ id: 'D_1_001', department: 'D_1', category: 'D', daily: [1], prices: [1] }] },
    uci: {
      source: {}, rules: [], window: { first: at(0), last: at(days - 1), days },
      products: codes.map((code) => ({ code, name: `PRODUCT ${code}`, price: 2 })),
      customers: [{ id: '12348', country: 'Finland' }, { id: '12352', country: 'Norway' }], invoices, cancellations: [],
    },
  }
}

test('the walkthrough scene holds by the reorder list\'s own rule', () => {
  const plan = buildPublicDataPlan(sceneExtract(), 'uci', { seedDay: '2026-11-10' })
  const { hero, second, reorder, approval } = plan.scene
  const bySku = new Map(plan.items.map((item) => [item.sku, item]))
  const sizing = (sku, position, stock) => {
    const item = bySku.get(sku)
    return reorderSizing({ item: {}, reorderPoint: item.reorderPoint, demand: item.demandToday, position, stock, minimum: item.minimumOrderQuantity, today: plan.dayOf(plan.days) }).sized.quantity.value
  }
  // Hero: below safety stock, two late Acme orders of the same size (whole
  // minimum orders, at least two; one minimum received on the first) that
  // keep it off the reorder list.
  assert.ok(hero.onHand > 0 && hero.onHand < hero.safetyStock)
  assert.equal(sizing(hero.sku, hero.position, hero.onHand), null)
  const [partly, nothing] = hero.orders
  assert.deepEqual([partly.role, partly.received, partly.created, partly.promised], ['hero_partly_received', hero.minimumOrderQuantity, -20, -6])
  assert.deepEqual([nothing.role, nothing.received, nothing.created, nothing.promised], ['hero_nothing_received', 0, -18, -4])
  assert.equal(partly.ordered, nothing.ordered)
  assert.ok(partly.ordered >= 2 * hero.minimumOrderQuantity && partly.ordered % hero.minimumOrderQuantity === 0)
  // Second supplier: one late order, nothing received, that keeps it off the list.
  assert.equal(second.order.promised, -5)
  assert.equal(sizing(second.sku, second.position, second.onHand), null)
  // The reorder suggestion: no open order, at least 20 under its reorder
  // point; the list orders it up to its level.
  assert.ok(reorder.shortfall >= UCI_SCENE.reorder.shortfall)
  assert.equal(reorder.suggested, sizing(reorder.sku, reorder.onHand, reorder.onHand))
  assert.ok(reorder.suggested > 0)
  assert.equal(approval.ordered, approval.minimumOrderQuantity)
  // Suppliers: the two fictional names on reserved domains; Acme Tier 1 by
  // the scene, the others by spend.
  const named = plan.suppliers.filter((supplier) => supplier.scene)
  assert.deepEqual(named.map((supplier) => [supplier.code, supplier.name, supplier.email, supplier.tierBasis]), [
    ['GLOBEX', 'Globex Party Supplies', 'orders@globex-party.example', 'spend'],
    ['ACME', 'Acme Home Goods', 'orders@acme-homegoods.example', 'scene'],
  ])
  assert.equal(named[1].tier, 1)
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
  assert.equal(plan.salesOrders.length, sceneExtract().uci.invoices.filter((invoice) => invoice.at.slice(0, 10) <= plan.sourceWindow.last).length)
})

test('purchase requests in every state, and orders still being filled, none of the scene\'s', () => {
  const plan = buildPublicDataPlan(sceneExtract(), 'uci', { seedDay: '2026-11-10' })
  const sceneSkus = new Set([UCI_SCENE.hero.sku, UCI_SCENE.second.sku, UCI_SCENE.reorder.sku, UCI_SCENE.approval.sku])
  const itemOf = new Map(plan.items.map((item) => [item.key, item]))
  // Eight items outside the scene: one request in each state, then two more.
  assert.deepEqual([...new Set(plan.requests.map((row) => row.state))].sort(), [...PUBLIC_DATA_PURCHASE_REQUEST_RULES.states].sort())
  assert.equal(plan.requests.length, 8)
  assert.equal(new Set(plan.requests.map((row) => row.itemKey)).size, plan.requests.length)
  for (const row of plan.requests) {
    const item = itemOf.get(row.itemKey)
    assert.ok(!sceneSkus.has(item.sku))
    assert.ok(row.day < plan.days && row.day >= plan.days - PUBLIC_DATA_PURCHASE_REQUEST_RULES.withinDays)
    // Needed a lead time later, so a converted request's order is not late on the seed day.
    assert.equal(row.needBy, row.day + 14)
    assert.ok(row.needBy >= plan.days)
    assert.deepEqual([row.quantity, row.unitPrice, row.supplierKey], [item.minimumOrderQuantity, plan.purchasePriceOf(item, row.day), item.supplierKey])
  }
  // Two of each state for a workspace with enough items, the same every time.
  assert.deepEqual(buildPublicDataPlan(sceneExtract(), 'uci', { seedDay: '2026-11-10' }).requests, plan.requests)
  const counts = publicDataPlanCounts(plan)
  assert.equal(counts.purchaseRequests, 8)
  const converted = plan.requests.filter((row) => row.state === 'converted').length
  assert.equal(counts.purchaseOrders, plan.purchasing.orders.length + converted)
  // UCI orders still being filled: the newest without a scene item.
  const states = plan.openSales.map((row) => row.state)
  assert.deepEqual(states, ['not_reserved', 'not_reserved', 'reserved', 'reserved', 'partly_shipped', 'partly_shipped'])
  for (const row of plan.openSales) {
    const order = plan.salesOrders[row.position]
    assert.ok(order.lines.every((line) => !sceneSkus.has(itemOf.get(line.itemKey).sku)))
    if (row.state === 'partly_shipped') {
      assert.ok(order.lines.length >= 2)
      assert.deepEqual(row.shipLines, order.lines.slice(0, Math.ceil(order.lines.length / 2)).map((_, index) => index))
    } else assert.deepEqual(row.shipLines, [])
  }
  // Newest first, and no later order without a scene item is left shipped.
  const indexes = plan.openSales.map((row) => plan.salesOrders[row.position].index)
  assert.deepEqual(indexes, [...indexes].sort((a, b) => b - a))
  assert.equal(counts.salesOrdersOpen, 6)
})

test('supplier tiers follow spend before the tier day, and Acme keeps its scene tier', () => {
  const plan = buildPublicDataPlan(sceneExtract(), 'uci', { seedDay: '2026-11-10' })
  const tierDay = plan.days - PUBLIC_DATA_TIER_RULES.daysBefore
  assert.equal(plan.tierDay, tierDay)
  const itemOf = new Map(plan.items.map((item) => [item.key, item]))
  const spend = new Map()
  for (const order of plan.purchasing.orders) if (order.created < tierDay) for (const line of order.lines) spend.set(order.supplierKey, (spend.get(order.supplierKey) || 0) + line.quantity * Math.round(plan.purchasePriceOf(itemOf.get(line.itemKey), order.created) * 100))
  const total = [...spend.values()].reduce((sum, value) => sum + value, 0)
  let before = 0
  for (const [key, value] of [...spend.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) {
    const supplier = plan.suppliers.find((row) => row.key === key)
    const byRule = (100 * before) / total < 70 ? 1 : (100 * before) / total < 90 ? 2 : 3
    assert.equal(supplier.spendShare, Math.round((100 * value) / total))
    assert.equal(supplier.tier, supplier.tierBasis === 'scene' ? 1 : byRule, key)
    before += value
  }
  assert.ok(plan.suppliers.every((supplier) => [1, 2, 3].includes(supplier.tier)))
})

test('UCI supplier invoices: one per receipt by the stated rules, differences reviewed within 14 days', () => {
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
    const changed = row.changedLine === null ? null : row.lines[row.changedLine]
    assert.ok(row.day < n, `${row.number} is dated before the seed day`)
    assert.equal(row.due, row.day + 30)
    assert.equal(row.totalPence, row.lines.reduce((total, line) => total + line.quantity * line.unitPricePence, 0))
    if (row.rule === 'dated_before_receipt') assert.ok(row.receiptDay - row.day >= rules.beforeReceiptFrom && row.receiptDay - row.day <= rules.beforeReceiptTo)
    else assert.ok(row.day - row.receiptDay >= 0 && row.day - row.receiptDay <= rules.delayDays)
    assert.equal(row.matchDay, row.recordedAgainstOrder ? Math.max(row.day, row.receiptDay) : row.day)
    // The app's own match rule decides what is held (design audit B2): a
    // price above the order only over the tolerance, a short delivery always.
    if (row.rule === 'price_above_order') {
      assert.ok(row.percent >= rules.priceAboveFrom && row.percent <= rules.priceAboveTo)
      assert.equal(changed.unitPricePence, Math.ceil((changed.orderPricePence * (100 + row.percent)) / 100))
      const held = priceDifferenceHeld({ quantity: changed.quantity, orderPrice: (changed.orderPricePence / 100).toFixed(2), invoicePrice: (changed.unitPricePence / 100).toFixed(2) })
      assert.equal(row.match, held ? 'exception' : 'matched')
    } else assert.equal(row.match, row.rule === 'short_delivery' ? 'exception' : 'matched')
    if (row.match === 'exception') {
      assert.equal(order.scene, undefined)
      const changedLines = row.lines.filter((line) => line.unitPricePence !== line.orderPricePence || line.quantity !== line.received)
      assert.deepEqual(changedLines, [changed])
      // Reviewed 3 to 14 days after the match when that is before the seed
      // day: none waits more than 14 days (design audit L7-14).
      if (row.resolution) {
        assert.ok(row.resolution.day - row.matchDay >= rules.resolveFrom && row.resolution.day - row.matchDay <= rules.resolveTo)
        assert.ok(row.resolution.day < n)
        assert.equal(row.resolution.decision, row.rule === 'short_delivery' ? 'accept_received' : 'approved')
        assert.equal(row.approvedDay, row.resolution.day)
      } else {
        assert.equal(row.payment, 'held')
        assert.ok(n - row.matchDay <= rules.resolveTo, `${row.number} has waited ${n - row.matchDay} days`)
      }
    } else {
      assert.equal(row.resolution, null)
      assert.equal(row.approvedDay, row.matchDay)
    }
    // The payable leaves out what was not received (accepted at the received quantity).
    if (row.approvedDay !== null) assert.equal(row.payablePence, row.totalPence - (row.resolution?.decision === 'accept_received' ? (changed.quantity - changed.received) * changed.unitPricePence : 0))
    else assert.equal(row.payablePence, null)
    // A short delivery is billed as ordered; the order closes the rest on the invoice day.
    if (row.rule === 'short_delivery') {
      assert.equal(changed.quantity - changed.received, Math.max(1, Math.ceil((changed.received * rules.shortByPercent) / 100)))
      assert.equal(order.lines[changed.orderLine].quantity, changed.quantity)
      assert.deepEqual(order.closed, { day: row.day, itemKey: changed.itemKey, missing: changed.quantity - changed.received })
    }
    // Approved: paid on the due date before the seed day unless left overdue; later ones open.
    if (row.approvedDay !== null) assert.equal(row.payment, row.due >= n ? 'open' : row.paidDay === row.due ? 'paid' : 'overdue')
    if (row.payment === 'overdue') assert.ok(row.due < n && row.due >= n - rules.unpaidWithinDays)
  }
  assert.ok(invoices.some((row) => row.resolution), 'some differences were reviewed')
  // Numbered per supplier in date order.
  const acme = invoices.filter((row) => row.supplierKey === '85')
  assert.deepEqual(acme.map((row) => row.number), acme.map((_, index) => `INV-ACME-${String(index + 1).padStart(4, '0')}`))
  // Orders closed short are not open; the counts say how many invoices of each kind.
  const counts = publicDataPlanCounts(plan)
  assert.equal(counts.closedShortPurchaseOrders, count('short_delivery'))
  assert.equal(counts.supplierInvoices, invoices.length)
  assert.equal(counts.supplierInvoicesWithDifferences, invoices.filter((row) => row.match === 'exception').length)
  assert.equal(counts.supplierInvoicesReviewed + counts.supplierInvoicesHeld, counts.supplierInvoicesWithDifferences)
  assert.equal(counts.receiptsNotInvoiced, notYetInvoiced.length)
  // A rule's value does not lean on the draw that picked the invoice: with
  // half the invoices dated early, every number of days in the range occurs.
  const early = planSupplierInvoices({
    orders: plan.purchasing.orders, items: plan.items, suppliers: plan.suppliers, days: n, termsDays: 30, priceOf: plan.purchasePriceOf,
    rules: { ...rules, shortDeliveryPercent: 0, priceAbovePercent: 0, beforeReceiptPercent: 50 },
  }).invoices.filter((row) => row.rule === 'dated_before_receipt')
  assert.deepEqual([...new Set(early.map((row) => row.receiptDay - row.day))].sort(), [1, 2, 3])
})

test('the match tolerance decides which planned price differences are held', () => {
  // The default tolerance is the larger of 2% of the line and 1 currency unit.
  assert.equal(priceDifferenceHeld({ quantity: 100, orderPrice: '1.28', invoicePrice: '1.33' }), true)
  assert.equal(priceDifferenceHeld({ quantity: 100, orderPrice: '1.28', invoicePrice: '1.30' }), false)
  assert.equal(priceDifferenceHeld({ quantity: 10, orderPrice: '0.43', invoicePrice: '0.46' }), false)
  assert.equal(priceDifferenceHeld({ quantity: 10, orderPrice: '0.43', invoicePrice: '0.46', review: { pricePercentageTolerance: '0', priceAbsoluteTolerance: '0', amountTolerance: '0' } }), true)
})

test('a scene product missing from the extract stops the plan with its code', () => {
  const extract = sceneExtract()
  extract.uci.products = extract.uci.products.filter((product) => product.code !== '22423')
  extract.uci.invoices = extract.uci.invoices.map((invoice) => ({ ...invoice, lines: invoice.lines.filter(([code]) => code !== '22423') }))
  assert.throws(() => buildPublicDataPlan(extract, 'uci', { seedDay: '2026-11-10' }), /needs UCI products 22423/)
  assert.doesNotThrow(() => buildPublicDataPlan(extract, 'uci', { seedDay: '2026-11-10', scene: false }))
})

test('trimmed closing stock never leaves a day short', () => {
  const days = 140
  const reviewIndexes = Array.from({ length: days }, (_, index) => index).filter((index) => index % 7 === 0)
  const item = steadyItem((index) => 5 + (index % 4), days, reviewIndexes, { targetClosing: 3 })
  const result = simulatePurchasing({ days, items: [item], reviewIndexes, leadTimeDays: 14, delayOf: (review) => (review === 7 ? 2 : 0) })
  let onHand = result.opening.A
  for (let day = 0; day < days; day += 1) {
    for (const order of result.orders) if (order.arrival === day) onHand += order.lines[0].quantity
    assert.ok(onHand >= item.daily[day], `day ${day}`)
    onHand -= item.daily[day]
  }
  assert.equal(onHand, result.closing.A)
  assert.ok(result.closing.A >= 3)
  for (const order of result.orders) {
    assert.equal(order.arrival, order.review + 14 + (order.review === 7 ? 2 : 0))
    assert.ok(order.lines[0].quantity >= item.minimumOrderQuantity)
  }
})
