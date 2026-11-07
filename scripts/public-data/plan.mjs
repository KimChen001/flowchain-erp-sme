// The public data workspaces, planned from the extract that
// scripts/public-data/extract_public_data.py writes (kept outside the
// repository). Pure: no database. scripts/public-data/seed.mjs writes a plan;
// docs/public-data-workspaces.md states every rule below for a reader.
//
// Two workspaces, one per dataset, because each keeps its own currency and
// timezone and the two businesses have nothing to do with each other:
//   m5   Walmart store CA_1 (M5): 210 items, daily unit sales and weekly prices.
//   uci  A UK online gift retailer (UCI Online Retail II): 200 products, a
//        one-in-four customer sample, their invoices and cancellations.
//
// [public data]  items, prices, customers, every sales order line and its day.
// [assumed]      suppliers, lead times, minimum orders, reorder points, stock,
//                purchase orders and receipts, purchase prices, payment terms.
//
// Dates move by whole days so the last day of the data is yesterday in the
// workspace timezone; each document keeps its original date in its metadata.
import { existsSync, readFileSync } from 'node:fs'
import { finishScene, prepareScene } from './scene.mjs'

export const PUBLIC_DATA_WORKSPACE_EXTRACT_SCHEMA = 'flowchain.public-data-extract.v1'

export const PUBLIC_DATA_WORKSPACE_ASSUMPTIONS = Object.freeze({
  // The research rules (data/public/m5/SELECTION.md), for both datasets.
  leadTimeDays: 14,
  reviewDays: 7,
  holdingRatePercent: 25,
  shortageToHolding: 5,
  // Weekly purchasing review on Mondays (workspace calendar).
  reviewWeekday: 1,
  // UCI customer invoices: due 30 days after the invoice, paid on the due date.
  paymentTermsDays: 30,
})

export const PUBLIC_DATA_WORKSPACE_DATASETS = Object.freeze({
  m5: Object.freeze({
    dataset: 'm5',
    tenantId: 'tenant-public-m5',
    workspaceName: 'Walmart store CA_1 (M5 public data)',
    currency: 'USD',
    timezone: 'America/Los_Angeles',
    countryCode: 'US',
    warehouseName: 'Store CA_1 stockroom',
  }),
  uci: Object.freeze({
    dataset: 'uci',
    tenantId: 'tenant-public-uci',
    workspaceName: 'UK online gift retailer (UCI public data)',
    currency: 'GBP',
    timezone: 'Europe/London',
    countryCode: 'GB',
    warehouseName: 'Main warehouse',
  }),
})

const DAY_MS = 86400000
const THRESHOLD_WINDOW_DAYS = 90
const round2 = (value) => Math.round(value * 100) / 100
const dayNumber = (iso) => Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10))) / DAY_MS
const isoOf = (number) => new Date(number * DAY_MS).toISOString().slice(0, 10)
const minutes = (time) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5))
const clock = (total) => `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`

export function publicDataExtractMissingMessage(path) {
  return [
    `No public data extract at ${path}.`,
    'The public data seeds from a local extract of UCI Online Retail II and M5, which is never committed. Write it with:',
    '  python -I scripts/public-data/extract_public_data.py --uci <online+retail+ii.zip> --m5 <folder with the M5 CSV files> --out <this path>',
    'See docs/public-data-workspaces.md.',
  ].join('\n')
}

export function readPublicDataExtract(path) {
  if (!path || !existsSync(path)) throw new Error(publicDataExtractMissingMessage(path))
  const extract = JSON.parse(readFileSync(path, 'utf8'))
  if (extract?.schema !== PUBLIC_DATA_WORKSPACE_EXTRACT_SCHEMA) throw new Error(`${path} is not a public data extract (${PUBLIC_DATA_WORKSPACE_EXTRACT_SCHEMA}); write it again with scripts/public-data/extract_public_data.py.`)
  if (!extract.m5?.items?.length || !extract.uci?.products?.length) throw new Error(`${path} has no M5 items or no UCI products; write it again.`)
  return extract
}

// "WHITE HANGING HEART T-LIGHT HOLDER" -> "White Hanging Heart T-Light Holder".
export function titleCase(value) {
  return String(value || '').trim().replace(/\s+/g, ' ').toLowerCase().replace(/(^|[\s\-/(&+,.])([a-z])/g, (_, before, letter) => `${before}${letter.toUpperCase()}`)
}

// FOODS_3 -> "Foods 3".
const departmentLabel = (department) => titleCase(String(department).replace(/_/g, ' '))

// Thresholds from an item's mean daily demand over the window [assumed].
export function itemThresholds(meanDaily, { leadTimeDays, reviewDays } = PUBLIC_DATA_WORKSPACE_ASSUMPTIONS) {
  return {
    safetyStock: Math.round(meanDaily * reviewDays),
    reorderPoint: Math.round(meanDaily * (leadTimeDays + reviewDays)),
    minimumOrderQuantity: Math.max(10, Math.ceil((reviewDays * meanDaily) / 10) * 10),
  }
}

// The assumed purchasing history: every review day, an item whose position
// (on hand + on order) is at or below its base stock level (reorder point plus
// safety stock: average demand over lead time and review, plus the buffer) is
// ordered up to that level plus its minimum order; the order is promised lead time days
// later and arrives that morning, or delayOf(review, supplierKey) days later.
// Public demand is never cut: when a day's demand is more than the stock on
// hand, the item's order at the latest review that has arrived by then is
// raised by the shortfall plus its safety stock (a week of average demand), or
// an order of at least the minimum is added there; before any such review the
// opening stock is raised. Every public order line therefore ships in full on
// its day.
//
// An item may also carry, for the walkthrough scene (see SCENE below):
//   freezeFrom      no orders at reviews from this day on
//   extraArrivals   [{ day, quantity }] received from orders placed outside
//                   the reviews
//   targetClosing   the stock to end with: the latest received order lines
//                   (then the opening stock) are cut, never below the minimum
//                   order and never so far that a day's demand goes unmet
export function simulatePurchasing({ days, items, reviewIndexes, leadTimeDays, delayOf = () => 0 }) {
  const reviews = [...reviewIndexes].sort((a, b) => a - b)
  const reviewSet = new Set(reviews)
  const lines = new Map()
  const opening = {}
  const closing = {}
  let raised = 0
  for (const item of items) {
    const { minimumOrderQuantity: moq } = item
    const s = item.reorderPoint + (item.safetyStock || 0)
    const freezeFrom = item.freezeFrom ?? Infinity
    const extraArrivals = item.extraArrivals || []
    const arrivalOf = (review) => review + leadTimeDays + delayOf(review, item.supplierKey)
    const newLine = (review, quantity, raisedBy) => ({ review, promised: review + leadTimeDays, arrival: arrivalOf(review), itemKey: item.key, supplierKey: item.supplierKey, quantity, raisedBy })
    let onHand = s + moq
    opening[item.key] = onHand
    const own = []
    for (let day = 0; day < days; day += 1) {
      for (const line of own) if (line.arrival === day) onHand += line.quantity
      for (const arrival of extraArrivals) if (arrival.day === day) onHand += arrival.quantity
      if (reviewSet.has(day) && day < freezeFrom) {
        const onOrder = own.reduce((total, line) => total + (line.arrival > day ? line.quantity : 0), 0)
        const position = onHand + onOrder
        if (position <= s) {
          const line = newLine(day, s + moq - position, 0)
          lines.set(`${day}|${item.key}`, line)
          own.push(line)
        }
      }
      const demand = item.daily[day]
      if (demand > onHand) {
        const shortfall = demand - onHand + (item.safetyStock || 0)
        let latest = null
        for (const review of reviews) if (review < freezeFrom && arrivalOf(review) <= day) latest = review
        if (latest === null) {
          opening[item.key] += shortfall
          onHand += shortfall
        } else {
          const key = `${latest}|${item.key}`
          let line = lines.get(key)
          let added = shortfall
          if (line) {
            line.quantity += shortfall
            line.raisedBy += shortfall
          } else {
            added = Math.max(shortfall, moq)
            line = newLine(latest, added, added)
            lines.set(key, line)
            own.push(line)
          }
          onHand += added
        }
        raised += 1
      }
      onHand -= demand
    }
    if (item.targetClosing !== undefined && item.targetClosing !== null && onHand > item.targetClosing) {
      onHand = trimClosing({ item, days, own, opening, extraArrivals, target: item.targetClosing })
    }
    closing[item.key] = onHand
  }
  const orders = new Map()
  for (const line of [...lines.values()].sort((a, b) => a.review - b.review || a.itemKey.localeCompare(b.itemKey))) {
    const key = `${line.review}|${line.supplierKey}`
    if (!orders.has(key)) orders.set(key, { review: line.review, promised: line.promised, arrival: line.arrival, supplierKey: line.supplierKey, lines: [] })
    orders.get(key).lines.push({ itemKey: line.itemKey, quantity: line.quantity, raisedBy: Math.min(line.raisedBy, line.quantity) })
  }
  return { opening, closing, raisedDays: raised, orders: [...orders.values()].sort((a, b) => a.review - b.review || a.supplierKey.localeCompare(b.supplierKey)) }
}

// Stock after each day's demand, from the opening stock, the received lines
// and the extra arrivals.
function stockAfterDemand({ item, days, own, openingStock, extraArrivals }) {
  const after = []
  let onHand = openingStock
  for (let day = 0; day < days; day += 1) {
    for (const line of own) if (line.arrival === day) onHand += line.quantity
    for (const arrival of extraArrivals) if (arrival.day === day) onHand += arrival.quantity
    onHand -= item.daily[day]
    after.push(onHand)
  }
  return after
}

// Cuts the latest received lines, then the opening stock, until the item ends
// at target (or as near as the rules allow); returns the closing stock.
function trimClosing({ item, days, own, opening, extraArrivals, target }) {
  const received = own.filter((line) => line.arrival < days).sort((a, b) => b.arrival - a.arrival || b.review - a.review)
  for (const candidate of [...received, null]) {
    const after = stockAfterDemand({ item, days, own, openingStock: opening[item.key], extraArrivals })
    const excess = after[days - 1] - target
    if (excess <= 0) break
    const from = candidate ? candidate.arrival : 0
    const slack = Math.min(...after.slice(from))
    const room = candidate ? candidate.quantity - item.minimumOrderQuantity : opening[item.key]
    const cut = Math.min(excess, slack, room)
    if (cut <= 0) continue
    if (candidate) candidate.quantity -= cut
    else opening[item.key] -= cut
  }
  return stockAfterDemand({ item, days, own, openingStock: opening[item.key], extraArrivals })[days - 1]
}

function m5Plan(m5) {
  const days = m5.window.days
  const items = m5.items.map((row) => {
    if (row.daily.length !== days || row.prices.length !== days) throw new Error(`M5 item ${row.id} does not cover the ${days}-day window.`)
    const number = row.id.split('_').at(-1)
    return {
      key: row.id,
      sku: row.id,
      name: `${departmentLabel(row.department)} item ${number}`,
      category: departmentLabel(row.department),
      supplierKey: row.department,
      daily: row.daily,
      prices: row.prices,
      price: row.prices[days - 1],
      source: { dataset: 'm5', itemId: row.id, department: row.department, category: row.category },
    }
  })
  const departments = [...new Set(items.map((item) => item.supplierKey))].sort()
  const suppliers = departments.map((department) => ({
    key: department,
    code: `SUP-${department.replace(/_/g, '-')}`,
    name: `${departmentLabel(department)} vendor (assumed)`,
    category: departmentLabel(department),
  }))
  const customers = [{ key: 'POS', code: `${m5.store.replace(/_/g, '')}-POS`, name: `Store ${m5.store} shoppers (point of sale)`, country: 'United States', source: { dataset: 'm5', store: m5.store } }]
  const salesOrders = []
  for (let index = 0; index < days; index += 1) {
    const lines = items.filter((item) => item.daily[index] > 0).map((item) => ({ itemKey: item.key, quantity: item.daily[index], unitPrice: item.prices[index] }))
    if (!lines.length) continue
    salesOrders.push({ index, orderedAt: '08:00', shippedAt: '21:00', customerKey: 'POS', source: { date: m5.dates[index], store: m5.store, ...(m5.events?.[m5.dates[index]] ? { event: m5.events[m5.dates[index]] } : {}) }, lines })
  }
  return { days, sourceWindow: m5.window, items, suppliers, customers, salesOrders, cancellations: [] }
}

function uciPlan(uci) {
  const days = uci.window.days
  const first = dayNumber(uci.window.first)
  const indexOf = (at) => {
    const index = dayNumber(at.slice(0, 10)) - first
    if (index < 0 || index >= days) throw new Error(`UCI document dated ${at} is outside the window.`)
    return index
  }
  // Suppliers [assumed]: one per StockCode family (its first two digits);
  // families with fewer than five of the selected products share one.
  const family = (code) => code.slice(0, 2)
  const familySize = new Map()
  for (const product of uci.products) familySize.set(family(product.code), (familySize.get(family(product.code)) || 0) + 1)
  const supplierKeyOf = (code) => (familySize.get(family(code)) >= 5 ? family(code) : 'other')
  const known = new Set(uci.products.map((product) => product.code))
  const daily = new Map(uci.products.map((product) => [product.code, new Array(days).fill(0)]))
  const salesOrders = uci.invoices.map((invoice) => {
    const index = indexOf(invoice.at)
    const time = invoice.at.slice(11, 16)
    const lines = invoice.lines.map(([code, quantity, price]) => {
      if (!known.has(code)) throw new Error(`UCI invoice ${invoice.number} names product ${code}, which is not selected.`)
      daily.get(code)[index] += quantity
      return { itemKey: code, quantity, unitPrice: round2(price) }
    })
    return { index, orderedAt: time, shippedAt: clock(Math.min(minutes(time) + 60, 23 * 60 + 30)), customerKey: invoice.customer, source: { invoice: invoice.number, date: invoice.at.slice(0, 10), time, country: invoice.country }, lines }
  })
  const items = uci.products.map((product) => ({
    key: product.code,
    sku: product.code,
    name: titleCase(product.name),
    category: 'Giftware',
    supplierKey: supplierKeyOf(product.code),
    daily: daily.get(product.code),
    price: round2(product.price),
    source: { dataset: 'uci', stockCode: product.code, description: product.name },
  }))
  const suppliers = [...new Set(items.map((item) => item.supplierKey))].sort().map((key) => ({
    key,
    code: `SUP-${key === 'other' ? 'OTHER' : key}`,
    name: key === 'other' ? 'Supplier of other codes (assumed)' : `Supplier of ${key}xxx codes (assumed)`,
    category: 'Giftware',
  }))
  const customers = uci.customers.map((customer) => ({ key: customer.id, code: `CUST-${customer.id}`, name: `Customer ${customer.id} (${customer.country})`, country: customer.country, source: { dataset: 'uci', customerId: customer.id } }))
  const cancellations = uci.cancellations.map((document) => ({
    index: indexOf(document.at),
    at: document.at.slice(11, 16),
    customerKey: document.customer,
    source: { invoice: document.number, date: document.at.slice(0, 10), time: document.at.slice(11, 16), country: document.country },
    lines: document.lines.map(([code, quantity, price]) => ({ itemKey: code, quantity, unitPrice: round2(price) })),
  }))
  return { days, sourceWindow: uci.window, items, suppliers, customers, salesOrders, cancellations }
}

// Only the last `lastDays` days of a window (a shorter seed for checks).
function lastDaysOf(base, lastDays) {
  if (!lastDays || lastDays >= base.days) return base
  const cut = base.days - lastDays
  const keep = (rows) => rows.filter((row) => row.index >= cut).map((row) => ({ ...row, index: row.index - cut }))
  return {
    ...base,
    days: lastDays,
    sourceWindow: { first: isoOf(dayNumber(base.sourceWindow.first) + cut), last: base.sourceWindow.last, days: lastDays },
    items: base.items.map((item) => ({ ...item, daily: item.daily.slice(cut), ...(item.prices ? { prices: item.prices.slice(cut) } : {}) })),
    salesOrders: keep(base.salesOrders),
    cancellations: keep(base.cancellations),
  }
}

// The plan for one dataset, as of the seed day (YYYY-MM-DD in the workspace
// timezone). Day index i of the window becomes offset i - days from the seed
// day, so the last day of the data is yesterday.
//
// The UCI workspace also gets the walkthrough scene (scene.mjs) unless
// scene is false.
export function buildPublicDataPlan(extract, dataset, { seedDay, lastDays = null, scene = dataset === 'uci' }) {
  const profile = PUBLIC_DATA_WORKSPACE_DATASETS[dataset]
  if (!profile) throw new Error(`Unknown public data dataset ${dataset}; use m5 or uci.`)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(seedDay))) throw new Error('buildPublicDataPlan needs seedDay as YYYY-MM-DD.')
  const base = lastDaysOf(dataset === 'm5' ? m5Plan(extract.m5) : uciPlan(extract.uci), lastDays)
  const { days } = base
  const assumptions = PUBLIC_DATA_WORKSPACE_ASSUMPTIONS
  const firstShifted = dayNumber(seedDay) - days
  const shiftDays = firstShifted - dayNumber(base.sourceWindow.first)
  // Thresholds from the average over the last 90 days, the window the reorder
  // list reads and the research instances use.
  const recent = Math.min(THRESHOLD_WINDOW_DAYS, days)
  const items = base.items.map((item) => {
    const units = item.daily.reduce((total, quantity) => total + quantity, 0)
    const meanDaily = item.daily.slice(-recent).reduce((total, quantity) => total + quantity, 0) / recent
    return { ...item, units, saleDays: item.daily.filter((quantity) => quantity > 0).length, meanDaily, ...itemThresholds(meanDaily, assumptions) }
  })
  const reviewIndexes = []
  for (let index = 0; index < days; index += 1) {
    if (new Date((firstShifted + index) * DAY_MS).getUTCDay() === assumptions.reviewWeekday) reviewIndexes.push(index)
  }
  const suppliers = base.suppliers.map((supplier) => ({ ...supplier }))
  const simulate = (rows, delay) => simulatePurchasing({ days, items: rows, reviewIndexes, leadTimeDays: assumptions.leadTimeDays, delayOf: delay })
  const delayOf = scene ? prepareScene({ items, suppliers, days, reviewIndexes, simulate }) : undefined
  const purchasing = simulate(items, delayOf)
  // Every order with its days and receipts: a weekly order is placed at 09:30
  // on its review day and received in full on its arrival day, when that is
  // before the seed day.
  purchasing.orders = purchasing.orders.map((order) => ({
    ...order,
    created: order.review,
    createdTime: '09:30',
    status: 'issued',
    receipts: order.arrival < days ? [{ index: order.arrival, lines: order.lines.map((line) => ({ itemKey: line.itemKey, quantity: line.quantity })) }] : [],
  }))
  const sceneFacts = scene ? finishScene({ items, purchasing, days }) : null
  return {
    dataset,
    profile,
    assumptions,
    days,
    seedDay,
    shiftDays,
    sourceWindow: base.sourceWindow,
    window: { first: isoOf(firstShifted), last: isoOf(firstShifted + days - 1) },
    offsetOf: (index) => index - days,
    items,
    suppliers,
    customers: base.customers,
    salesOrders: base.salesOrders,
    cancellations: base.cancellations,
    purchasing,
    reviewIndexes,
    scene: sceneFacts,
    sources: dataset === 'm5' ? extract.m5.source : extract.uci.source,
    rules: dataset === 'm5' ? extract.m5.rules : extract.uci.rules,
  }
}

const orderedOf = (order) => order.lines.reduce((total, line) => total + line.quantity, 0)
const receivedOf = (order) => order.receipts.reduce((total, receipt) => total + receipt.lines.reduce((sum, line) => sum + line.quantity, 0), 0)

// What the plan holds, for the seed's report and the workspace note.
export function publicDataPlanCounts(plan) {
  return {
    items: plan.items.length,
    suppliers: plan.suppliers.length,
    customers: plan.customers.length,
    salesOrders: plan.salesOrders.length,
    salesOrderLines: plan.salesOrders.reduce((total, order) => total + order.lines.length, 0),
    unitsSold: plan.items.reduce((total, item) => total + item.units, 0),
    purchaseOrders: plan.purchasing.orders.length,
    purchaseOrderLines: plan.purchasing.orders.reduce((total, order) => total + order.lines.length, 0),
    openPurchaseOrders: plan.purchasing.orders.filter((order) => order.status === 'issued' && orderedOf(order) > receivedOf(order)).length,
    raisedForDemandSpikes: plan.purchasing.raisedDays,
    cancellations: plan.cancellations.length,
  }
}
