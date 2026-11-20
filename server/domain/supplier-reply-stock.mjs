// What a supplier reply's new dates do to stock (docs/supplier-reply-dates-design.md
// §4.6, the "Stock:" line on the card): for each SKU on the lines the reply
// moves, the first day before the new date that the SKU is out of stock, or
// below its reorder point, on the new dates while it would not be on the
// order's dates now; and, below the reorder point first, the day it then
// runs out too, so a stock-out is never hidden behind the earlier day.
//
// The projection is the one behind the assistant's stock_projection
// (ai-read-tools.mjs aiStockProjection, ai-assistant-v2-data-tools.mjs), day
// by day instead of week by week:
//   - it starts from what is available today (on hand less reserved);
//   - open purchase order lines in the item's unit arrive on their promised
//     day; another order's line past its day, or with none, is left out, as
//     no arrival date is guessed;
//   - demand is taken off on one of two bases, never added: the open sales
//     orders' unreserved demand on the day promised to the customer (one past
//     its day counts today), or the average shipped per day over the last 90
//     days (the reorder list's demand), for stock that sells without open
//     sales orders. With neither, available stock is set against the reorder
//     point alone.
// The reply's own lines are compared two ways: as the order has them now (a
// day already past counts as today: the order is due now) and on the new
// dates. A split delivery is on its last part's date, the whole line at once
// (§4.8: the safe side). The projection runs a year at most: a later new date
// is projected to the end of that year and marked so. Everything here is
// pure; the read service (supplier-reply-stock-read-service.mjs) gathers the
// inputs.

export const SUPPLIER_REPLY_STOCK_KINDS = Object.freeze(['short', 'below_reorder_point'])
export const SUPPLIER_REPLY_STOCK_BASES = Object.freeze(['open_sales_orders', 'recorded_rate'])
// The projection's reach, in days from today.
export const SUPPLIER_REPLY_STOCK_HORIZON_DAYS = 366

const text = (value) => String(value ?? '').trim()
const fold = (value) => text(value).toLowerCase()
// A real calendar day: 2027-02-31 is none.
const isDay = (value) => /^\d{4}-\d{2}-\d{2}$/.test(text(value)) && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === text(value)
const dayIndex = (day) => Math.round(Date.parse(`${day}T00:00:00Z`) / 86400000)
const dayOf = (index) => new Date(index * 86400000).toISOString().slice(0, 10)
const finite = (value) => (value === null || value === undefined || value === '' || !Number.isFinite(Number(value)) ? null : Number(value))

// What the new dates do in [start, end) that the current dates do not: the
// first day the SKU is below its reorder point on the new dates while not on
// the current ones, and the first day it is out of stock on the new dates
// while not on the current ones. Out of stock first (it is the worse news),
// else below the reorder point, with the later stock-out beside it; or null.
function worseDays({ start, end, available, current, proposed, demandOn, reorderPoint }) {
  let now = available
  let next = available
  let belowFrom = null
  let shortFrom = null
  for (let day = start; day < end; day += 1) {
    const out = demandOn(day)
    now += (current.get(day) || 0) - out
    next += (proposed.get(day) || 0) - out
    if (shortFrom === null && next < 0 && !(now < 0)) shortFrom = day
    if (belowFrom === null && reorderPoint !== null && next < reorderPoint && !(now < reorderPoint)) belowFrom = day
    if (shortFrom !== null) break
  }
  if (shortFrom !== null && (belowFrom === null || shortFrom <= belowFrom)) return { kind: 'short', from: shortFrom, outOfStockFrom: null }
  if (belowFrom !== null) return { kind: 'below_reorder_point', from: belowFrom, outOfStockFrom: shortFrom }
  return null
}
// The most severe first: out of stock from the first worse day, then below
// the reorder point with a stock-out to come, then below it alone; then the
// earlier day.
const severity = (effect) => (effect.kind === 'short' ? 0 : effect.outOfStockFrom !== null ? 1 : 2)

// today: the workspace's day. items: [{ sku, itemName, unit, available,
// reorderPoint }]. incoming: every open purchase order line, [{ lineId,
// purchaseOrderId, sku, unit, remaining, promisedDate }]. demand: the open
// sales orders' unreserved demand [{ sku, quantity, promisedDate }], or null
// when the reader may not read sales orders. rates: average shipped per day
// by SKU (a Map; a SKU without one has no rate basis). overrides: the reply's
// lines with their new dates, [{ lineId, date }], on purchaseOrderId.
// Returns the SKUs the new dates leave worse off before the new date, out of
// stock first, then the earlier day.
export function supplierReplyStockEffects({ today, purchaseOrderId, items = [], incoming = [], demand = null, rates = new Map(), overrides = [] }) {
  if (!isDay(today)) return []
  const start = dayIndex(today)
  const horizon = start + SUPPLIER_REPLY_STOCK_HORIZON_DAYS
  const itemBySku = new Map(items.map((item) => [fold(item.sku), item]))
  const sameUnit = (item, unit) => !text(unit) || !text(item.unit) || fold(unit) === fold(item.unit)
  // The reply's lines on this order, open, with a quantity left and a new day.
  const newDayById = new Map()
  for (const entry of overrides) {
    if (!isDay(entry?.date) || !text(entry?.lineId)) continue
    newDayById.set(text(entry.lineId), Math.max(start, dayIndex(entry.date)))
  }
  const replyLines = incoming.filter((line) => text(line.purchaseOrderId) === text(purchaseOrderId) && newDayById.has(text(line.lineId)) && (finite(line.remaining) || 0) > 0)
  const effects = []
  for (const sku of [...new Set(replyLines.map((line) => fold(line.sku)))]) {
    const item = itemBySku.get(sku)
    if (!item) continue
    const ownLines = replyLines.filter((line) => fold(line.sku) === sku && sameUnit(item, line.unit))
    if (!ownLines.length) continue
    // The new date: the last of this SKU's lines on the reply; projected to
    // the horizon at most.
    const newDay = Math.max(...ownLines.map((line) => newDayById.get(text(line.lineId))))
    const end = Math.min(newDay, horizon)
    if (end <= start) continue
    const current = new Map()
    const proposed = new Map()
    const add = (map, day, quantity) => map.set(day, (map.get(day) || 0) + quantity)
    for (const line of incoming.filter((entry) => fold(entry.sku) === sku && sameUnit(item, entry.unit) && (finite(entry.remaining) || 0) > 0)) {
      const quantity = finite(line.remaining)
      const own = ownLines.includes(line)
      const promised = isDay(line.promisedDate) ? dayIndex(line.promisedDate) : null
      // Another order's line past its day, or with none, is not placed.
      if (!own && (promised === null || promised < start)) continue
      // This order's line now: its day, or today when that has passed.
      const now = promised === null ? start : Math.max(start, promised)
      add(current, now, quantity)
      add(proposed, own ? newDayById.get(text(line.lineId)) : now, quantity)
    }
    const available = finite(item.available) ?? 0
    const reorderPoint = finite(item.reorderPoint) !== null && finite(item.reorderPoint) > 0 ? finite(item.reorderPoint) : null
    const project = (demandOn) => worseDays({ start, end, available, current, proposed, demandOn, reorderPoint })
    const found = []
    // Open sales orders with a day and something left to ship unreserved.
    const byDay = new Map()
    if (Array.isArray(demand)) {
      for (const entry of demand.filter((row) => fold(row.sku) === sku && (finite(row.quantity) || 0) > 0 && isDay(row.promisedDate))) {
        add(byDay, Math.max(start, dayIndex(entry.promisedDate)), finite(entry.quantity))
      }
    }
    if (byDay.size) {
      const effect = project((day) => byDay.get(day) || 0)
      if (effect) found.push({ ...effect, basis: 'open_sales_orders' })
    }
    const rate = finite(rates.get(text(item.sku)) ?? rates.get(sku))
    if (rate !== null && rate > 0) {
      const effect = project(() => rate)
      if (effect) found.push({ ...effect, basis: 'recorded_rate' })
    }
    // No demand on either basis: available stock against the reorder point.
    if (!byDay.size && !(rate > 0)) {
      const effect = project(() => 0)
      if (effect) found.push({ ...effect, basis: null })
    }
    if (!found.length) continue
    const worst = found.sort((a, b) => severity(a) - severity(b) || a.from - b.from)[0]
    effects.push({
      sku: text(item.sku), itemName: text(item.itemName) || null, unit: text(item.unit) || null,
      kind: worst.kind, from: dayOf(worst.from), outOfStockFrom: worst.outOfStockFrom === null ? null : dayOf(worst.outOfStockFrom),
      newDate: dayOf(newDay), basis: worst.basis, reorderPoint, beyondAYear: newDay > horizon,
    })
  }
  return effects.sort((a, b) => severity(a) - severity(b) || a.from.localeCompare(b.from) || a.sku.localeCompare(b.sku))
}
