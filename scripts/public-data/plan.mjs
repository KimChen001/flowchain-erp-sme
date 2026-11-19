// The public data workspaces, planned from the extract that
// scripts/public-data/extract_public_data.py writes (kept outside the
// repository). Pure: no database. scripts/public-data/seed.mjs writes a plan;
// docs/public-data-workspaces.md states every rule below for a reader.
//
// Two workspaces, one per dataset, because each keeps its own currency and
// timezone and the two businesses have nothing to do with each other:
//   m5   Walmart store CA_1 (M5): 196 items, daily unit sales and weekly prices.
//   uci  A UK online gift retailer (UCI Online Retail II): 200 products, a
//        one-in-four customer sample, their invoices and cancellations.
//
// [public data]  items, prices, customers, every sales order line and its day.
// [assumed]      suppliers and their tiers, lead times, minimum orders, stock,
//                purchase requests, purchase orders and receipts, purchase
//                prices, payment terms, (UCI) the orders still being filled,
//                and (UCI) supplier invoices, their differences, reviews and
//                payments. Reorder points, order-up-to levels and safety
//                stock come from the app's own rules over the days before
//                they are set (design audit L14, W-01).
//
// Dates move by whole weeks so weekdays match the data and the last day of
// the data is yesterday in the workspace timezone (the data's newest 0 to 6
// days that would fall on or after the seed day are left out); each
// document keeps its original date in its metadata.
import { existsSync, readFileSync } from 'node:fs'
import { priceDifferenceHeld } from '../../server/domain/operational-finance-policy.mjs'
import { DEMAND_WINDOW_DAYS, dailyDemand, reorderSizing } from '../../server/domain/reorder-list.mjs'
import { suggestReorderPoint } from '../../server/domain/reorder-point-suggestion.mjs'
import { orderUpToLevel } from '../../shared/purchase-suggestion.mjs'
import { finishScene, prepareScene } from './scene.mjs'

export const PUBLIC_DATA_WORKSPACE_EXTRACT_SCHEMA = 'flowchain.public-data-extract.v1'

export const PUBLIC_DATA_WORKSPACE_ASSUMPTIONS = Object.freeze({
  // The research rules (data/public/m5/SELECTION.md), for both datasets.
  leadTimeDays: 14,
  reviewDays: 7,
  holdingRatePercent: 25,
  shortageToHolding: 5,
  // Weekly purchasing review on Mondays (workspace calendar, which keeps the
  // data's weekdays).
  reviewWeekday: 1,
  // UCI invoices, both ways: due 30 days after the invoice (NET30). Customers
  // pay on the due date; supplier invoices follow PUBLIC_DATA_SUPPLIER_INVOICE_RULES.
  paymentTermsDays: 30,
  // The data's first days are its calibration period (design audit L14):
  // the opening stock and every review in it use the thresholds of those
  // days only, and the minimum orders come from them. From the first review
  // after it, each review's thresholds come from the days before that review
  // only, so no later demand sizes an order.
  calibrationDays: 90,
})

// Purchase prices [assumed]: neither dataset has costs, so a purchase order
// line is priced at this share of the item's public selling price (M5: the
// price of the day the order is placed), rounded to the penny or cent. The
// item's supplier terms carry the same price (M5: at the last day's price).
// The research instances (scripts/public-data-instance.mjs) keep the selling
// price as their proxy.
export const PUBLIC_DATA_PURCHASE_PRICE_PERCENT = Object.freeze({ uci: 50, m5: 75 })

// percent of a selling price, worked in whole pence so 2.55 at 50% is 1.28.
export function purchasePrice(sellingPrice, percent) {
  return Math.round((Math.round(sellingPrice * 100) * percent) / 100) / 100
}

// UCI supplier invoices and their payments [assumed] (planSupplierInvoices;
// scripts/public-data/seed.mjs records them through FlowChain's own supplier
// invoice, three-way match, exception review, approval, purchase order close
// and payment commands, so the match results, exceptions and payables come
// from the app's rules). The shares are of the invoices, each picked by a
// fixed hash of its order, so the same plan always picks the same invoices.
export const PUBLIC_DATA_SUPPLIER_INVOICE_RULES = Object.freeze({
  // One invoice per posted receipt, dated 0 to 5 days after it and due
  // paymentTermsDays after the invoice. A receipt whose invoice day is not
  // before the seed day is received and not invoiced yet.
  delayDays: 5,
  // About 5%: one line priced 2 to 5% above the order, rounded up to the
  // penny. The match holds it only when the difference is over the match
  // tolerance (priceDifferenceHeld in operational-finance-policy.mjs: by
  // default the larger of 2% of the line and 1 currency unit); a smaller one
  // matches and is paid as billed.
  priceAbovePercent: 5,
  priceAboveFrom: 2,
  priceAboveTo: 5,
  // About 3%: one line was delivered 5% short (at least one unit) and is
  // billed as ordered; the buyer closes the rest of the order on the invoice
  // day, before the match (FlowChain does not close an order while one of
  // its invoices has a difference nobody has reviewed).
  shortDeliveryPercent: 3,
  shortByPercent: 5,
  // About 2%: dated 1 to 3 days before the goods arrived, recorded against
  // the order and linked to the receipt when it is posted.
  beforeReceiptPercent: 2,
  beforeReceiptFrom: 1,
  beforeReceiptTo: 3,
  // A difference is reviewed 3 to 14 days after the match by a second
  // person, through the app's own review command (design audit L7-14): a
  // price difference is approved; a quantity difference is accepted at the
  // received quantity, because FlowChain never approves billing for goods
  // that were not received (design audit B2). The invoice is then approved
  // and its payable leaves out what was not received. A difference whose
  // review day is not before the seed day is still open, so none is older
  // than 14 days.
  resolveFrom: 3,
  resolveTo: 14,
  // An approved invoice due before the seed day is paid on its due date,
  // except 10% of those due in the 60 days before the seed day, which are
  // overdue. An invoice whose difference is still open is not approved, so
  // there is nothing to pay yet.
  unpaidPercent: 10,
  unpaidWithinDays: 60,
})

// Purchase requests [assumed] (design audit L1-33 = L7-07, W-06): two in
// each state, raised in the last 14 days for items picked by a fixed hash
// (none of the walkthrough scene's), each for the item's minimum order at
// the purchase price of its day and needed a lead time later. The buyer
// raises them through FlowChain's own request commands and a second person
// approves or rejects them; a converted request becomes a purchase order
// with the request as its source, issued the same day.
export const PUBLIC_DATA_PURCHASE_REQUEST_RULES = Object.freeze({
  states: Object.freeze(['draft', 'submitted', 'approved', 'converted', 'rejected', 'cancelled']),
  perState: 2,
  withinDays: 14,
})

// UCI sales orders still being filled [assumed] (design audit L4-34 =
// L7-24): the newest orders of the data that name no item of the
// walkthrough scene, newest first: two not reserved yet, two reserved in
// full and not shipped, and two of at least two lines reserved in full with
// the first half of their lines shipped and invoiced. M5 has none: its
// orders are a day's point-of-sale sales, filled at the till.
export const PUBLIC_DATA_OPEN_SALES_RULES = Object.freeze({ notReserved: 2, reserved: 2, partlyShipped: 2 })

// Supplier tiers [assumed] (design audit L7-37): set by the buyer 40 days
// before the seed day from each supplier's share of purchase spend over the
// year before then, largest first: the suppliers that make up the first 70%
// of spend are Tier 1 (strategic), the next ones up to 90% Tier 2 (core),
// the rest Tier 3 (transactional). The walkthrough scene's Acme keeps the
// tier its scene gives it, sole source of the hero (scene.mjs).
export const PUBLIC_DATA_TIER_RULES = Object.freeze({ daysBefore: 40, tier1Percent: 70, tier2Percent: 90 })

export const PUBLIC_DATA_WORKSPACE_DATASETS = Object.freeze({
  m5: Object.freeze({
    dataset: 'm5',
    tenantId: 'tenant-public-m5',
    workspaceName: 'Walmart store CA_1 (M5 public data)',
    currency: 'USD',
    timezone: 'America/Los_Angeles',
    locale: 'en-US',
    countryCode: 'US',
    warehouseName: 'Store CA_1 stockroom',
  }),
  uci: Object.freeze({
    dataset: 'uci',
    tenantId: 'tenant-public-uci',
    workspaceName: 'UK online gift retailer (UCI public data)',
    currency: 'GBP',
    timezone: 'Europe/London',
    // A UK business writes the day first (18 Nov 2026), design audit L11-27.
    locale: 'en-GB',
    countryCode: 'GB',
    warehouseName: 'Main warehouse',
  }),
})

// The stock unit the seed records every item in.
export const PUBLIC_DATA_STOCK_UNIT = 'pcs'

const DAY_MS = 86400000
const round2 = (value) => Math.round(value * 100) / 100
const dayNumber = (iso) => Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10))) / DAY_MS
const isoOf = (number) => new Date(number * DAY_MS).toISOString().slice(0, 10)
const minutes = (time) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5))
const clock = (total) => `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`
// A calendar for a plan built without one (tests of the simulation alone).
const plainDayOf = (index) => isoOf(dayNumber('2001-01-01') + index)

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

// The minimum order [assumed]: reviewDays days of an average daily demand,
// rounded up to a multiple of 10, at least 10. The seed takes the average
// over the calibration period, so it is the same for the whole history.
export function minimumOrderQuantity(meanDaily, reviewDays = PUBLIC_DATA_WORKSPACE_ASSUMPTIONS.reviewDays) {
  return Math.max(10, Math.ceil((reviewDays * meanDaily) / 10) * 10)
}

// An item's thresholds as of day `index` of the window, by the app's own
// rules over the days before it only (at most the reorder list's 90):
//   reorder point  the reorder list's suggestion (suggestReorderPoint in
//                  reorder-point-suggestion.mjs): enough for lead time + 7
//                  days in 5 of 6 past stretches;
//   order-up-to    the app's (s, S) default (orderUpToLevel in
//                  shared/purchase-suggestion.mjs): the reorder point plus 7
//                  days of average daily demand;
//   safety stock   reviewDays days of that average daily demand [assumed].
// demand is the reorder list's daily demand that day (dailyDemand). null
// when the app makes no suggestion (shipments on fewer than 8 of the days).
export function thresholdsAsOf({ daily, index, dayOf = plainDayOf, leadTimeDays = PUBLIC_DATA_WORKSPACE_ASSUMPTIONS.leadTimeDays, reviewDays = PUBLIC_DATA_WORKSPACE_ASSUMPTIONS.reviewDays }) {
  const today = dayOf(index)
  const lines = []
  for (let day = Math.max(0, index - DEMAND_WINDOW_DAYS); day < Math.min(index, daily.length); day += 1) {
    if (daily[day] > 0) lines.push({ unit: PUBLIC_DATA_STOCK_UNIT, quantity: daily[day], postedAt: dayOf(day) })
  }
  const demand = dailyDemand({ lines, stockUnit: PUBLIC_DATA_STOCK_UNIT, today })
  const { suggestedReorderPoint } = suggestReorderPoint({ lines, stockUnit: PUBLIC_DATA_STOCK_UNIT, leadTimeDays, today })
  if (!(suggestedReorderPoint > 0) || demand.averageDailyDemand === null) return null
  const level = orderUpToLevel({ reorderPoint: suggestedReorderPoint, averageDailyDemand: demand.averageDailyDemand })
  return {
    setOn: index,
    reorderPoint: suggestedReorderPoint,
    orderUpTo: level.level,
    safetyStock: Math.round(demand.averageDailyDemand * reviewDays),
    averageDailyDemand: demand.averageDailyDemand,
    demand,
  }
}

// The thresholds an item is reviewed with: the calibration period's
// (thresholdsAsOf its last day + 1) for the opening stock and every review
// in it; from the first review after it, each review's own, from the days
// before it (the latest ones kept when the app makes no suggestion that
// day). recorded: the latest review's, the figures the item carries on the
// seed day.
export function itemThresholdSchedule({ daily, reviewIndexes, dayOf = plainDayOf, calibrationDays, leadTimeDays, reviewDays }) {
  const calibration = thresholdsAsOf({ daily, index: calibrationDays, dayOf, leadTimeDays, reviewDays })
  const byReview = new Map()
  let current = calibration
  for (const review of [...reviewIndexes].sort((a, b) => a - b)) {
    if (review >= calibrationDays) current = thresholdsAsOf({ daily, index: review, dayOf, leadTimeDays, reviewDays }) || current
    byReview.set(review, current)
  }
  return { calibration, byReview, recorded: current }
}

// The assumed purchasing history, by the reorder list's own (s, S) rule
// (reorderSizing in reorder-list.mjs): opening stock, the day before the
// window, is the calibration period's order-up-to level; at every review
// day, an item due with the thresholds of that review (stock plus open
// orders at or below its reorder point, or above it by less than a day of
// demand) is ordered up to its order-up-to level, raised to its minimum
// order; the order is promised lead time days later and arrives that
// morning, or delayOf(review, supplierKey) days later.
// Public demand is never cut: when a day's demand is more than the stock on
// hand, the item's order at the latest review that has arrived by then is
// raised by the shortfall plus the safety stock in force, or an order of at
// least the minimum is added there; before any such review the opening
// stock is raised. Every public order line therefore ships in full on its
// day.
//
// item: { key, supplierKey, daily, minimumOrderQuantity, schedule
// (itemThresholdSchedule) }. An item may also carry, for the walkthrough
// scene (see SCENE below):
//   freezeFrom      no orders at reviews from this day on
//   extraArrivals   [{ day, quantity }] received from orders placed outside
//                   the reviews
//   targetClosing   the stock to end with: the latest received order lines
//                   (then the opening stock) are cut, never below the minimum
//                   order and never so far that a day's demand goes unmet
export function simulatePurchasing({ days, items, reviewIndexes, leadTimeDays, delayOf = () => 0, dayOf = plainDayOf }) {
  const reviews = [...reviewIndexes].sort((a, b) => a - b)
  const reviewSet = new Set(reviews)
  const lines = new Map()
  const opening = {}
  const closing = {}
  let raised = 0
  for (const item of items) {
    const { minimumOrderQuantity: moq, schedule } = item
    const freezeFrom = item.freezeFrom ?? Infinity
    const extraArrivals = item.extraArrivals || []
    const arrivalOf = (review) => review + leadTimeDays + delayOf(review, item.supplierKey)
    const newLine = (review, quantity, raisedBy) => ({ review, promised: review + leadTimeDays, arrival: arrivalOf(review), itemKey: item.key, supplierKey: item.supplierKey, quantity, raisedBy })
    let inForce = schedule.calibration
    let onHand = Math.ceil(schedule.calibration?.orderUpTo ?? 0)
    opening[item.key] = onHand
    const own = []
    for (let day = 0; day < days; day += 1) {
      for (const line of own) if (line.arrival === day) onHand += line.quantity
      for (const arrival of extraArrivals) if (arrival.day === day) onHand += arrival.quantity
      if (reviewSet.has(day)) inForce = schedule.byReview.get(day) ?? inForce
      if (reviewSet.has(day) && day < freezeFrom && inForce) {
        const onOrder = own.reduce((total, line) => total + (line.arrival > day ? line.quantity : 0), 0)
        const { sized } = reorderSizing({ item: {}, reorderPoint: inForce.reorderPoint, demand: inForce.demand, position: onHand + onOrder, stock: onHand, minimum: moq, today: dayOf(day) })
        if (sized.quantity.value > 0) {
          const line = newLine(day, sized.quantity.value, 0)
          lines.set(`${day}|${item.key}`, line)
          own.push(line)
        }
      }
      const demand = item.daily[day]
      if (demand > onHand) {
        const shortfall = demand - onHand + (inForce?.safetyStock || 0)
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

// Only the first `keep` days of a window (the newest days dropped).
function firstDaysOf(base, keep) {
  if (keep >= base.days) return base
  const kept = (rows) => rows.filter((row) => row.index < keep)
  return {
    ...base,
    days: keep,
    sourceWindow: { first: base.sourceWindow.first, last: isoOf(dayNumber(base.sourceWindow.first) + keep - 1), days: keep },
    items: base.items.map((item) => ({ ...item, daily: item.daily.slice(0, keep), ...(item.prices ? { prices: item.prices.slice(0, keep), price: item.prices[keep - 1] } : {}) })),
    salesOrders: kept(base.salesOrders),
    cancellations: kept(base.cancellations),
  }
}

// Dates move by whole weeks (design audit L14), so weekdays, the Monday
// reviews and the purchasing history are the same whatever the seed day.
// The data's last day moves to the day before the seed day when that keeps
// its weekday; otherwise the newest 1 to 6 days of the data, which would
// fall on or after the seed day, are left out.
export function wholeWeekCut(sourceLast, seedDay) {
  return (((dayNumber(sourceLast) - (dayNumber(seedDay) - 1)) % 7) + 7) % 7
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
  const full = dataset === 'm5' ? m5Plan(extract.m5) : uciPlan(extract.uci)
  const droppedDays = wholeWeekCut(full.sourceWindow.last, seedDay)
  const base = lastDaysOf(firstDaysOf(full, full.days - droppedDays), lastDays)
  const { days } = base
  const purchasePricePercent = PUBLIC_DATA_PURCHASE_PRICE_PERCENT[dataset]
  const assumptions = {
    ...PUBLIC_DATA_WORKSPACE_ASSUMPTIONS,
    purchasePricePercent,
    ...(dataset === 'uci' ? { supplierInvoices: PUBLIC_DATA_SUPPLIER_INVOICE_RULES } : {}),
  }
  const firstShifted = dayNumber(seedDay) - days
  const shiftDays = firstShifted - dayNumber(base.sourceWindow.first)
  const dayOf = (index) => isoOf(firstShifted + index)
  const reviewIndexes = []
  for (let index = 0; index < days; index += 1) {
    if (new Date((firstShifted + index) * DAY_MS).getUTCDay() === assumptions.reviewWeekday) reviewIndexes.push(index)
  }
  // Thresholds from the app's rules with only the days before they are set
  // (design audit L14, W-01): the calibration period's for the start, then
  // each review's own. The item records the latest review's.
  const calibrationDays = Math.min(assumptions.calibrationDays, days)
  const { leadTimeDays, reviewDays } = assumptions
  const items = base.items.map((item) => {
    const units = item.daily.reduce((total, quantity) => total + quantity, 0)
    const calibrationMeanDaily = item.daily.slice(0, calibrationDays).reduce((total, quantity) => total + quantity, 0) / calibrationDays
    const schedule = itemThresholdSchedule({ daily: item.daily, reviewIndexes, dayOf, calibrationDays, leadTimeDays, reviewDays })
    // The reorder list's daily demand on the seed day.
    const today = thresholdsAsOf({ daily: item.daily, index: days, dayOf, leadTimeDays, reviewDays })
    const recorded = schedule.recorded
    return {
      ...item,
      purchasePrice: purchasePrice(item.price, purchasePricePercent),
      units,
      saleDays: item.daily.filter((quantity) => quantity > 0).length,
      calibrationMeanDaily,
      minimumOrderQuantity: minimumOrderQuantity(calibrationMeanDaily, reviewDays),
      schedule,
      reorderPoint: recorded?.reorderPoint ?? null,
      safetyStock: recorded?.safetyStock ?? null,
      thresholdsSetOn: recorded?.setOn ?? null,
      demandToday: today?.demand ?? null,
      meanDaily: today?.averageDailyDemand ?? item.daily.slice(-DEMAND_WINDOW_DAYS).reduce((total, quantity) => total + quantity, 0) / DEMAND_WINDOW_DAYS,
    }
  })
  // The price a purchase order placed on day index pays for an item [assumed].
  const purchasePriceOf = (item, index) => (item.prices ? purchasePrice(item.prices[index], purchasePricePercent) : item.purchasePrice)
  const suppliers = base.suppliers.map((supplier) => ({ ...supplier }))
  const simulate = (rows, delay) => simulatePurchasing({ days, items: rows, reviewIndexes, leadTimeDays, delayOf: delay, dayOf })
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
  const sceneFacts = scene ? finishScene({ items, purchasing, days, dayOf }) : null
  const sceneKeys = new Set(sceneFacts ? ['hero', 'second', 'reorder', 'approval'].map((role) => items.find((item) => item.sku === sceneFacts[role].sku)?.key).filter(Boolean) : [])
  // UCI: the supplier invoices of the received orders and their payments.
  const payables = dataset === 'uci'
    ? planSupplierInvoices({ orders: purchasing.orders, items, suppliers, days, termsDays: assumptions.paymentTermsDays, priceOf: purchasePriceOf })
    : null
  const requests = planPurchaseRequests({ items, days, excludeKeys: sceneKeys, priceOf: purchasePriceOf, leadTimeDays })
  const openSales = dataset === 'uci' ? planOpenSales({ salesOrders: base.salesOrders, excludeKeys: sceneKeys }) : []
  const tiers = planSupplierTiers({ suppliers, orders: purchasing.orders, items, priceOf: purchasePriceOf, days })
  for (const supplier of suppliers) {
    const tier = tiers.get(supplier.key)
    supplier.spendShare = tier.share
    supplier.tierBasis = supplier.tier ? 'scene' : 'spend'
    if (!supplier.tier) supplier.tier = tier.tier
  }
  return {
    dataset,
    profile,
    assumptions,
    days,
    seedDay,
    shiftDays,
    droppedDays,
    sourceWindow: base.sourceWindow,
    window: { first: isoOf(firstShifted), last: isoOf(firstShifted + days - 1) },
    offsetOf: (index) => index - days,
    dayOf,
    calibrationDays,
    items,
    purchasePriceOf,
    suppliers,
    tierDay: days - PUBLIC_DATA_TIER_RULES.daysBefore,
    customers: base.customers,
    salesOrders: base.salesOrders,
    openSales,
    cancellations: base.cancellations,
    purchasing,
    payables,
    requests,
    reviewIndexes,
    scene: sceneFacts,
    sources: dataset === 'm5' ? extract.m5.source : extract.uci.source,
    rules: dataset === 'm5' ? extract.m5.rules : extract.uci.rules,
  }
}

// A fixed draw in [0, 1) for a key (32-bit FNV-1a), so a pick repeats from
// run to run and from machine to machine.
export function publicDataDraw(key) {
  let hash = 0x811c9dc5
  for (const character of String(key)) {
    hash ^= character.codePointAt(0)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash / 2 ** 32
}

const pence = (value) => Math.round(value * 100)
const fixed = (amountPence) => (amountPence / 100).toFixed(2)

// The UCI supplier invoices and their payments [assumed], by
// PUBLIC_DATA_SUPPLIER_INVOICE_RULES: one invoice per received delivery of
// an issued order, in date order, numbered INV-<supplier code>-0001 upwards
// per supplier. days is the seed day's index; priceOf(item, index) is the
// order price. A short-delivered line's ordered quantity is raised by what
// was not delivered (the receipt stays as received) and its order gets
// closed = { day, itemKey, missing }, the day the buyer closes the rest.
//
// An invoice: { key, orderPosition, receiptIndex, receiptDay, supplierKey,
// number, rule (as_ordered, dated_before_receipt, price_above_order,
// short_delivery), day, due, percent, changedLine, recordedAgainstOrder,
// matchDay, match (matched, exception: the app's match result),
// resolution (null, or { day, decision: approved | accept_received }: an
// exception reviewed before the seed day), approvedDay (null while held),
// payablePence (what the approved invoice's payable is for), payment (paid,
// overdue, open, held), paidDay, lines: [{ itemKey, orderLine, receiptLine,
// quantity, received, orderPricePence, unitPricePence, amountPence }],
// totalPence, total }.
export function planSupplierInvoices({ orders, items, suppliers, days, termsDays, priceOf, rules = PUBLIC_DATA_SUPPLIER_INVOICE_RULES }) {
  const itemOf = new Map(items.map((item) => [item.key, item]))
  const supplierOf = new Map(suppliers.map((supplier) => [supplier.key, supplier]))
  // Each value draws on its own salt, never the one that picked its invoice:
  // the picked invoices are the lowest draws of their salt.
  const between = (key, low, high) => low + Math.floor(publicDataDraw(key) * (high - low + 1))
  const ranked = (rows, salt) => [...rows].sort((a, b) => publicDataDraw(`${salt}|${a.key}`) - publicDataDraw(`${salt}|${b.key}`) || a.key.localeCompare(b.key))
  const share = (count, percent) => Math.round((count * percent) / 100)
  const receipts = []
  orders.forEach((order, position) => {
    if (order.status !== 'issued') return
    order.receipts.forEach((receipt, receiptIndex) => {
      const key = order.scene ? `${order.scene}|${receiptIndex}` : `${order.created}|${order.supplierKey}|${receiptIndex}`
      receipts.push({ key, order, position, receipt, receiptIndex, day: receipt.index + between(`delay|${key}`, 0, rules.delayDays) })
    })
  })
  const invoiced = receipts.filter((row) => row.day < days)
  // The differences fall on weekly orders received in one delivery; the
  // scene's orders keep their story.
  const pick = (rows, percent, salt) => new Set(ranked(rows, salt).slice(0, share(invoiced.length, percent)).map((row) => row.key))
  let candidates = invoiced.filter((row) => !row.order.scene && row.order.receipts.length === 1)
  const short = pick(candidates, rules.shortDeliveryPercent, 'short')
  candidates = candidates.filter((row) => !short.has(row.key))
  const above = pick(candidates, rules.priceAbovePercent, 'price')
  candidates = candidates.filter((row) => !above.has(row.key))
  const early = pick(candidates, rules.beforeReceiptPercent, 'before')

  const invoices = invoiced.map((row) => {
    const { order, receipt } = row
    const rule = short.has(row.key) ? 'short_delivery' : above.has(row.key) ? 'price_above_order' : early.has(row.key) ? 'dated_before_receipt' : 'as_ordered'
    const day = rule === 'dated_before_receipt' ? receipt.index - between(`days-before|${row.key}`, rules.beforeReceiptFrom, rules.beforeReceiptTo) : row.day
    const differs = rule === 'short_delivery' || rule === 'price_above_order'
    const changedLine = differs ? between(`line|${row.key}`, 0, receipt.lines.length - 1) : null
    const percent = rule === 'price_above_order' ? between(`percent|${row.key}`, rules.priceAboveFrom, rules.priceAboveTo) : null
    const lines = receipt.lines.map((received, receiptLine) => {
      const orderLine = order.lines.findIndex((line) => line.itemKey === received.itemKey)
      const orderPricePence = pence(priceOf(itemOf.get(received.itemKey), order.created))
      let quantity = received.quantity
      let unitPricePence = orderPricePence
      if (receiptLine === changedLine && rule === 'short_delivery') {
        order.lines[orderLine].quantity += Math.max(1, Math.ceil((received.quantity * rules.shortByPercent) / 100))
        quantity = order.lines[orderLine].quantity
      }
      if (receiptLine === changedLine && rule === 'price_above_order') unitPricePence = Math.ceil((orderPricePence * (100 + percent)) / 100)
      return { itemKey: received.itemKey, orderLine, receiptLine, quantity, received: received.quantity, orderPricePence, unitPricePence, amountPence: quantity * unitPricePence }
    })
    if (rule === 'short_delivery') order.closed = { day, itemKey: lines[changedLine].itemKey, missing: lines[changedLine].quantity - lines[changedLine].received }
    const totalPence = lines.reduce((total, line) => total + line.amountPence, 0)
    const recordedAgainstOrder = rule === 'short_delivery' || rule === 'dated_before_receipt'
    // The app's own match rule decides what is held: billing more than was
    // received always, a price above the order only over the tolerance.
    const changed = changedLine === null ? null : lines[changedLine]
    const held = rule === 'short_delivery'
      || (rule === 'price_above_order' && priceDifferenceHeld({ quantity: changed.quantity, orderPrice: fixed(changed.orderPricePence), invoicePrice: fixed(changed.unitPricePence) }))
    const matchDay = recordedAgainstOrder ? Math.max(day, receipt.index) : day
    const reviewDay = held ? matchDay + between(`resolve|${row.key}`, rules.resolveFrom, rules.resolveTo) : null
    const resolution = held && reviewDay < days ? { day: reviewDay, decision: rule === 'short_delivery' ? 'accept_received' : 'approved' } : null
    const approvedDay = held ? resolution?.day ?? null : matchDay
    const notReceivedPence = resolution?.decision === 'accept_received' ? (changed.quantity - changed.received) * changed.unitPricePence : 0
    return {
      key: row.key, orderPosition: row.position, receiptIndex: row.receiptIndex, receiptDay: receipt.index, supplierKey: order.supplierKey,
      rule, day, due: day + termsDays, percent, changedLine, recordedAgainstOrder, matchDay,
      match: held ? 'exception' : 'matched', resolution, approvedDay, payablePence: approvedDay === null ? null : totalPence - notReceivedPence,
      lines, totalPence, total: totalPence / 100,
    }
  })

  // Payments: approved and due before the seed day is paid on the due date,
  // apart from the overdue share of the last unpaidWithinDays days.
  const recentlyDue = invoices.filter((row) => row.approvedDay !== null && row.due < days && row.due >= days - rules.unpaidWithinDays)
  const overdue = new Set(ranked(recentlyDue, 'unpaid').slice(0, share(recentlyDue.length, rules.unpaidPercent)).map((row) => row.key))
  const sequence = new Map()
  const dated = invoices.sort((a, b) => a.day - b.day || a.key.localeCompare(b.key))
  for (const invoice of dated) {
    invoice.payment = invoice.approvedDay === null ? 'held' : invoice.due >= days ? 'open' : overdue.has(invoice.key) ? 'overdue' : 'paid'
    invoice.paidDay = invoice.payment === 'paid' ? invoice.due : null
    const next = (sequence.get(invoice.supplierKey) || 0) + 1
    sequence.set(invoice.supplierKey, next)
    invoice.number = `INV-${supplierOf.get(invoice.supplierKey).code}-${String(next).padStart(4, '0')}`
  }
  // Received, not invoiced yet: the supplier's invoice is not due to arrive
  // before the seed day.
  const notYetInvoiced = receipts.filter((row) => row.day >= days).map((row) => ({
    key: row.key, orderPosition: row.position, receiptIndex: row.receiptIndex, receiptDay: row.receipt.index, supplierKey: row.order.supplierKey,
    totalPence: row.receipt.lines.reduce((total, line) => total + line.quantity * pence(priceOf(itemOf.get(line.itemKey), row.order.created)), 0),
  }))
  return { invoices: dated, notYetInvoiced }
}

// The purchase requests [assumed] by PUBLIC_DATA_PURCHASE_REQUEST_RULES: {
// key, state, itemKey, supplierKey, quantity, unitPrice, day (raised),
// needBy (day index) }, oldest first. excludeKeys: the scene's items.
export function planPurchaseRequests({ items, days, excludeKeys = new Set(), priceOf, leadTimeDays = PUBLIC_DATA_WORKSPACE_ASSUMPTIONS.leadTimeDays, rules = PUBLIC_DATA_PURCHASE_REQUEST_RULES }) {
  const ranked = items.filter((item) => !excludeKeys.has(item.key))
    .sort((a, b) => publicDataDraw(`request|${a.key}`) - publicDataDraw(`request|${b.key}`) || a.key.localeCompare(b.key))
  // One item of each state in turn, so every state has one before any has two.
  const requests = []
  for (let n = 0; n < rules.perState; n += 1) {
    rules.states.forEach((state, stateIndex) => {
      const item = ranked[n * rules.states.length + stateIndex]
      if (!item) return
      const day = days - 1 - Math.floor(publicDataDraw(`request-day|${item.key}`) * Math.min(rules.withinDays, days))
      requests.push({ key: `${state}-${n + 1}`, state, itemKey: item.key, supplierKey: item.supplierKey, quantity: item.minimumOrderQuantity, unitPrice: priceOf(item, day), day, needBy: day + leadTimeDays })
    })
  }
  return requests.sort((a, b) => a.day - b.day || a.key.localeCompare(b.key))
}

// The UCI orders still being filled [assumed] by PUBLIC_DATA_OPEN_SALES_RULES:
// [{ position (in salesOrders), state (not_reserved, reserved,
// partly_shipped), shipLines (line indexes shipped) }], newest first.
export function planOpenSales({ salesOrders, excludeKeys = new Set(), rules = PUBLIC_DATA_OPEN_SALES_RULES }) {
  const newest = salesOrders.map((order, position) => ({ order, position }))
    .filter(({ order }) => order.lines.every((line) => !excludeKeys.has(line.itemKey)))
    .sort((a, b) => b.order.index - a.order.index || b.order.orderedAt.localeCompare(a.order.orderedAt) || b.position - a.position)
  const room = { not_reserved: rules.notReserved, reserved: rules.reserved, partly_shipped: rules.partlyShipped }
  const open = []
  for (const { order, position } of newest) {
    const state = ['not_reserved', 'reserved', 'partly_shipped'].find((name) => room[name] > 0 && (name !== 'partly_shipped' || order.lines.length >= 2))
    if (!state) {
      if (Object.values(room).every((left) => left === 0)) break
      continue
    }
    room[state] -= 1
    const shipLines = state === 'partly_shipped' ? order.lines.slice(0, Math.ceil(order.lines.length / 2)).map((_, line) => line) : []
    open.push({ position, state, shipLines })
  }
  return open
}

// Each supplier's tier by PUBLIC_DATA_TIER_RULES: Map(key -> { tier, share
// (whole percent of spend), spend }), from the purchase orders placed in the
// year before the tier day at their purchase prices.
export function planSupplierTiers({ suppliers, orders, items, priceOf, days, rules = PUBLIC_DATA_TIER_RULES }) {
  const itemOf = new Map(items.map((item) => [item.key, item]))
  const tierDay = days - rules.daysBefore
  const spend = new Map(suppliers.map((supplier) => [supplier.key, 0]))
  for (const order of orders) {
    if (order.created >= tierDay || order.created < tierDay - 365) continue
    for (const line of order.lines) spend.set(order.supplierKey, (spend.get(order.supplierKey) || 0) + line.quantity * pence(priceOf(itemOf.get(line.itemKey), order.created)))
  }
  const total = [...spend.values()].reduce((sum, value) => sum + value, 0)
  const tiers = new Map()
  let before = 0
  for (const [key, value] of [...spend.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))) {
    const shareBefore = total ? (100 * before) / total : 0
    tiers.set(key, { tier: shareBefore < rules.tier1Percent ? 1 : shareBefore < rules.tier2Percent ? 2 : 3, share: total ? Math.round((100 * value) / total) : 0, spend: value / 100 })
    before += value
  }
  return tiers
}

const orderedOf = (order) => order.lines.reduce((total, line) => total + line.quantity, 0)
const receivedOf = (order) => order.receipts.reduce((total, receipt) => total + receipt.lines.reduce((sum, line) => sum + line.quantity, 0), 0)

// What the plan holds, for the seed's report and the workspace note. An
// order closed short is not open; a converted purchase request's order is.
export function publicDataPlanCounts(plan) {
  const invoices = plan.payables?.invoices || []
  const requests = plan.requests || []
  const requestStates = Object.fromEntries((PUBLIC_DATA_PURCHASE_REQUEST_RULES.states).map((state) => [state, requests.filter((row) => row.state === state).length]))
  return {
    items: plan.items.length,
    suppliers: plan.suppliers.length,
    customers: plan.customers.length,
    salesOrders: plan.salesOrders.length,
    salesOrderLines: plan.salesOrders.reduce((total, order) => total + order.lines.length, 0),
    salesOrdersOpen: (plan.openSales || []).length,
    unitsSold: plan.items.reduce((total, item) => total + item.units, 0),
    purchaseOrders: plan.purchasing.orders.length + requestStates.converted,
    purchaseOrderLines: plan.purchasing.orders.reduce((total, order) => total + order.lines.length, 0) + requestStates.converted,
    openPurchaseOrders: plan.purchasing.orders.filter((order) => order.status === 'issued' && !order.closed && orderedOf(order) > receivedOf(order)).length + requestStates.converted,
    closedShortPurchaseOrders: plan.purchasing.orders.filter((order) => order.closed).length,
    purchaseRequests: requests.length,
    raisedForDemandSpikes: plan.purchasing.raisedDays,
    cancellations: plan.cancellations.length,
    ...(plan.payables ? {
      supplierInvoices: invoices.length,
      supplierInvoicesWithDifferences: invoices.filter((row) => row.match === 'exception').length,
      supplierInvoicesReviewed: invoices.filter((row) => row.resolution).length,
      supplierInvoicesHeld: invoices.filter((row) => row.payment === 'held').length,
      supplierInvoicesPaid: invoices.filter((row) => row.payment === 'paid').length,
      supplierInvoicesOverdue: invoices.filter((row) => row.payment === 'overdue').length,
      receiptsNotInvoiced: plan.payables.notYetInvoiced.length,
    } : {}),
  }
}
