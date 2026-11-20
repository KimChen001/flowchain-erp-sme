// What a supplier reply's new dates do to stock (docs/supplier-reply-dates-design.md
// §4.6, the "Stock:" line on the card): for each SKU on the lines the reply
// moves, whether it runs out, or falls below its reorder point, before the
// new date, where the order's current dates would not have let it.
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
//     sales orders.
// The reply's own lines are compared two ways: as the order has them now (a
// day already past counts as today: the order is due now) and on the new
// dates. A split delivery is on its last part's date, the whole line at once
// (§4.8: the safe side). Everything here is pure; the read service
// (supplier-reply-stock-read-service.mjs) gathers the inputs.

export const SUPPLIER_REPLY_STOCK_KINDS = Object.freeze(['short', 'below_reorder_point'])
export const SUPPLIER_REPLY_STOCK_BASES = Object.freeze(['open_sales_orders', 'recorded_rate'])
// A reply moving a line more than this far is not projected further.
export const SUPPLIER_REPLY_STOCK_HORIZON_DAYS = 366

const text = (value) => String(value ?? '').trim()
const fold = (value) => text(value).toLowerCase()
const isDay = (value) => /^\d{4}-\d{2}-\d{2}$/.test(text(value)) && Number.isFinite(Date.parse(`${value}T00:00:00Z`))
const dayIndex = (day) => Math.round(Date.parse(`${day}T00:00:00Z`) / 86400000)
const dayOf = (index) => new Date(index * 86400000).toISOString().slice(0, 10)
const finite = (value) => (value === null || value === undefined || value === '' || !Number.isFinite(Number(value)) ? null : Number(value))

// The first day in [start, end) the balance goes below each threshold, given
// what arrives and what goes out each day.
function firstDips({ start, end, available, arrivals, demandOn, reorderPoint }) {
  let balance = available
  let shortOn = null
  let belowOn = null
  for (let day = start; day < end; day += 1) {
    balance += (arrivals.get(day) || 0) - demandOn(day)
    if (shortOn === null && balance < 0) shortOn = day
    if (belowOn === null && reorderPoint !== null && balance < reorderPoint) belowOn = day
    if (shortOn !== null && (belowOn !== null || reorderPoint === null)) break
  }
  return { shortOn, belowOn }
}

// The effect of the new dates on one SKU, on one demand basis, or null.
function effectOn({ start, end, available, baseline, proposed, demandOn, reorderPoint }) {
  const before = firstDips({ start, end, available, arrivals: baseline, demandOn, reorderPoint })
  const after = firstDips({ start, end, available, arrivals: proposed, demandOn, reorderPoint })
  const earlier = (now, was) => now !== null && (was === null || now < was)
  if (earlier(after.shortOn, before.shortOn)) return { kind: 'short', from: after.shortOn }
  if (earlier(after.belowOn, before.belowOn)) return { kind: 'below_reorder_point', from: after.belowOn }
  return null
}

// today: the workspace's day. items: [{ sku, itemName, unit, available,
// reorderPoint }]. incoming: every open purchase order line, [{ lineId,
// purchaseOrderId, sku, unit, remaining, promisedDate }]. demand: the open
// sales orders' unreserved demand [{ sku, quantity, promisedDate }], or null
// when the reader may not read sales orders. rates: average shipped per day
// by SKU (a Map; a SKU without one has no rate basis). overrides: the reply's
// lines with their new dates, [{ lineId, date }], on purchaseOrderId.
// Returns the SKUs whose stock the new dates make worse before the new date,
// the most severe basis first: running out before falling below the reorder
// point, then the earlier day.
export function supplierReplyStockEffects({ today, purchaseOrderId, items = [], incoming = [], demand = null, rates = new Map(), overrides = [] }) {
  if (!isDay(today)) return []
  const start = dayIndex(today)
  const itemBySku = new Map(items.map((item) => [fold(item.sku), item]))
  const sameUnit = (item, unit) => !text(unit) || !text(item.unit) || fold(unit) === fold(item.unit)
  // The reply's lines on this order, open, with a quantity left and a new day.
  const newDayById = new Map()
  for (const entry of overrides) {
    if (!isDay(entry?.date) || !text(entry?.lineId)) continue
    const day = Math.max(start, dayIndex(entry.date))
    if (day - start > SUPPLIER_REPLY_STOCK_HORIZON_DAYS) continue
    newDayById.set(text(entry.lineId), day)
  }
  const replyLines = incoming.filter((line) => text(line.purchaseOrderId) === text(purchaseOrderId) && newDayById.has(text(line.lineId)) && (finite(line.remaining) || 0) > 0)
  const effects = []
  for (const sku of [...new Set(replyLines.map((line) => fold(line.sku)))]) {
    const item = itemBySku.get(sku)
    if (!item) continue
    const ownLines = replyLines.filter((line) => fold(line.sku) === sku && sameUnit(item, line.unit))
    if (!ownLines.length) continue
    // The new date: the last of this SKU's lines on the reply.
    const end = Math.max(...ownLines.map((line) => newDayById.get(text(line.lineId))))
    if (end <= start) continue
    const baseline = new Map()
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
      add(baseline, now, quantity)
      add(proposed, own ? newDayById.get(text(line.lineId)) : now, quantity)
    }
    const available = finite(item.available) ?? 0
    const reorderPoint = finite(item.reorderPoint) !== null && finite(item.reorderPoint) > 0 ? finite(item.reorderPoint) : null
    const found = []
    if (Array.isArray(demand)) {
      const byDay = new Map()
      for (const entry of demand.filter((row) => fold(row.sku) === sku && (finite(row.quantity) || 0) > 0 && isDay(row.promisedDate))) {
        add(byDay, Math.max(start, dayIndex(entry.promisedDate)), finite(entry.quantity))
      }
      if (byDay.size) {
        const effect = effectOn({ start, end, available, baseline, proposed, demandOn: (day) => byDay.get(day) || 0, reorderPoint })
        if (effect) found.push({ ...effect, basis: 'open_sales_orders' })
      }
    }
    const rate = finite(rates.get(text(item.sku)) ?? rates.get(sku))
    if (rate !== null && rate > 0) {
      const effect = effectOn({ start, end, available, baseline, proposed, demandOn: () => rate, reorderPoint })
      if (effect) found.push({ ...effect, basis: 'recorded_rate' })
    }
    // No demand on either basis: available stock against the reorder point.
    if (!found.length && !(Array.isArray(demand) && demand.some((row) => fold(row.sku) === sku)) && !(rate > 0)) {
      const effect = effectOn({ start, end, available, baseline, proposed, demandOn: () => 0, reorderPoint })
      if (effect) found.push({ ...effect, basis: null })
    }
    if (!found.length) continue
    const worst = found.sort((a, b) => (a.kind === b.kind ? a.from - b.from : a.kind === 'short' ? -1 : 1))[0]
    effects.push({
      sku: text(item.sku), itemName: text(item.itemName) || null, unit: text(item.unit) || null,
      kind: worst.kind, from: dayOf(worst.from), newDate: dayOf(end), basis: worst.basis, reorderPoint,
    })
  }
  return effects.sort((a, b) => (a.kind === b.kind ? a.from.localeCompare(b.from) : a.kind === 'short' ? -1 : 1) || a.sku.localeCompare(b.sku))
}
