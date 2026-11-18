// How much of an item to request and by when: the reorder list, the
// assistant's purchase request lines and Today's reorder drafts
// (docs/ai-assistant-v2-design.md §4.1 and §5.1, owner decisions V2-5 and
// V2-6 of 2026-11-02; design audit 2026-11-15 batch C2, owner "按建议做"). One
// rule, so every place that suggests a quantity gives the same figure:
//
//   position on hand - reserved + incoming on committed purchase orders +
//            pending purchase orders (draft or pending approval) + open
//            purchase requests (draft, submitted or approved) - backorders
//            (open sales demand no reservation covers yet). Reserved stock
//            is out of on hand once and the backorders are the demand it
//            does not cover, so no sales order counts twice; backorders are
//            counted here, in the position, and nowhere else (L3-04, L3-06);
//   trigger  the reorder point (s); without one, the safety stock; without
//            either, 0 (backorders alone still make a gap). An order is due
//            once the position is at the trigger or below it, or above it by
//            less than a day of demand (its order-by day is today);
//   level    the order-up-to level (S) of an (s, S) rule (design audit C3,
//            owner "按建议做"): the item's own when it records one above the
//            reorder point, else assumed to be the reorder point plus
//            ORDER_UP_TO_REVIEW_DAYS of average daily demand, else the
//            reorder point. The assumption is an app default only, and says
//            so where it is shown;
//   quantity once due, the level - position, rounded up, then up to a
//            multiple of the item's lot size, raised to the supplier's
//            minimum order. Ordering it brings the position to the level or
//            above, so the item is no longer due. A quantity the user typed
//            wins. Not due: nothing is suggested.
//
// The need-by date is today plus the supplier's lead time. When the stock
// projection runs short before that day, the date stays and a warning names
// the week, so a person decides (V2-6 (c)). Every value carries the code of
// where it came from, for the source chips; nothing here reads or saves.

import { addCalendarDays } from './purchase-request-prefill.mjs'

export const PURCHASE_SUGGESTION_SOURCES = Object.freeze({
  userTyped: 'user_typed',
  reorderGap: 'reorder_gap',
  raisedToMoq: 'raised_to_moq',
  // Sized to cover a period from recorded daily demand (coverDays of the
  // assistant's suggest_purchase_lines), and that raised to the minimum order.
  coverDays: 'cover_days',
  coverDaysRaisedToMoq: 'cover_days_raised_to_moq',
  coveredByOpenOrders: 'covered_by_open_orders',
  notNeeded: 'not_needed',
  leadTime: 'lead_time',
  leadTimeNotRecorded: 'lead_time_not_recorded',
  // Items the quantity rule is not run on: one that is not active cannot be
  // requested, and one with no stock row has no position to measure.
  itemInactive: 'item_inactive',
  noStockPosition: 'no_stock_position',
})
export const OPEN_PURCHASE_REQUEST_STATUSES = Object.freeze(['draft', 'submitted', 'approved'])

const text = (value) => String(value ?? '').trim()
const isDay = (value) => /^\d{4}-\d{2}-\d{2}$/.test(text(value)) && !Number.isNaN(Date.parse(`${text(value)}T00:00:00Z`))
const count = (value) => (value === null || value === undefined || value === '' || !Number.isFinite(Number(value)) ? 0 : Number(value))
const positive = (value) => (count(value) > 0 ? count(value) : null)
// Quantities are stored with four decimals; the position adds them in whole
// ten-thousandths so 0.1 + 0.2 is 0.3.
const SCALE = 10000
const units = (value) => Math.round(count(value) * SCALE)

// Whether a purchase request line counts towards an item: a line for it, in
// the item's unit (a line in another unit is never added).
export function requestLineCountsFor(line, { sku = '', itemId = '', unit = '' } = {}) {
  const same = (text(sku) && text(line?.sku) === text(sku)) || (text(itemId) && text(line?.itemId) === text(itemId))
  return Boolean(same) && (!text(line.unit) || !text(unit) || text(line.unit).toLowerCase() === text(unit).toLowerCase())
}

// The quantity of an item on open purchase requests: every line that counts
// for it on a draft, submitted or approved request. requests: { status,
// lines: [{ sku, itemId, quantity, unit }] }.
export function openRequestQuantity(requests, item = {}) {
  let total = 0
  for (const request of Array.isArray(requests) ? requests : []) {
    if (!OPEN_PURCHASE_REQUEST_STATUSES.includes(text(request?.status))) continue
    for (const line of Array.isArray(request.lines) ? request.lines : []) {
      if (requestLineCountsFor(line, item)) total += count(line.quantity)
    }
  }
  return total
}

// The days of demand the assumed order-up-to level adds to the reorder point.
export const ORDER_UP_TO_REVIEW_DAYS = 7

// { level, source }: the order-up-to level and where it comes from: recorded
// (the item's, above the reorder point), assumed (reorder point plus a week
// of average daily demand) or reorder_point (no demand to assume from).
// averageDailyDemand in the stock unit, as the reorder list reads it.
export function orderUpToLevel({ reorderPoint, recorded, averageDailyDemand } = {}) {
  const trigger = positive(reorderPoint)
  if (trigger === null) return { level: null, source: null }
  const set = positive(recorded)
  if (set !== null && units(set) > units(trigger)) return { level: set, source: 'recorded' }
  const daily = positive(averageDailyDemand)
  if (daily !== null) return { level: (units(trigger) + Math.ceil(ORDER_UP_TO_REVIEW_DAYS * units(daily))) / SCALE, source: 'assumed' }
  return { level: trigger, source: 'reorder_point' }
}

// An item's inventory position, from its parts in its stock unit. available
// (on hand less reserved) may be given instead of onHand and reserved.
// { stock, supply, position }: stock is what is on hand for new demand (after
// reservations and backorders), supply what is on order or requested.
export function inventoryPosition({ onHand = null, reserved = null, available = null, incoming = 0, pendingOrders = 0, openRequests = 0, backorders = 0 } = {}) {
  const free = available !== null && available !== undefined ? units(available) : units(onHand) - units(reserved)
  const stock = free - units(backorders)
  const supply = units(incoming) + units(pendingOrders) + units(openRequests)
  return { stock: stock / SCALE, supply: supply / SCALE, position: (stock + supply) / SCALE }
}

// { target, trigger, gap, covered, quantity: { value, source }, minimum,
// lotSize }. position and stock as inventoryPosition gives them; orderUpTo
// the level (orderUpToLevel), the trigger when none is given; dueToday:
// the order-by day is today though the position is above the trigger (the
// reorder list's orderByDay). target is the level ordered up to; gap the
// level less the position, rounded up. covered: nothing to order, though the
// stock alone is at or below the trigger: what is on order or requested
// brings enough.
export function suggestPurchaseQuantity({ reorderPoint, safetyStock, orderUpTo, lotSize, position, stock, dueToday = false, minimum, typed } = {}) {
  const trigger = positive(reorderPoint) ?? positive(safetyStock) ?? 0
  const target = Math.max(positive(orderUpTo) ?? trigger, trigger)
  const gap = Math.ceil((units(target) - units(position)) / SCALE)
  const due = units(position) <= units(trigger) || Boolean(dueToday)
  const moq = positive(minimum)
  const lot = positive(lotSize)
  const ordering = due && gap > 0
  const covered = !ordering && units(stock) <= units(trigger) && units(position) > units(stock)
  const base = { target, trigger, gap, covered, minimum: moq, lotSize: lot }
  const asked = positive(typed)
  if (asked !== null) return { ...base, quantity: { value: asked, source: PURCHASE_SUGGESTION_SOURCES.userTyped } }
  if (!ordering) return { ...base, quantity: { value: null, source: covered ? PURCHASE_SUGGESTION_SOURCES.coveredByOpenOrders : PURCHASE_SUGGESTION_SOURCES.notNeeded } }
  // Up to a whole number of lots, then to the minimum order (itself a whole
  // number of lots when one is recorded).
  const inLots = (value) => (lot === null ? value : Math.ceil(units(value) / units(lot)) * units(lot) / SCALE)
  const sized = inLots(gap)
  if (moq !== null && moq > sized) return { ...base, quantity: { value: inLots(moq), source: PURCHASE_SUGGESTION_SOURCES.raisedToMoq } }
  return { ...base, quantity: { value: sized, source: PURCHASE_SUGGESTION_SOURCES.reorderGap } }
}

// { value, source, leadTimeDays, warning }. firstShortWeek: the first day of
// the week a stock projection first runs short, or null. The warning
// ({ code: 'stock_short_before_need_by', weekOf }) is given only when that
// week starts before the need-by date, or when there is no date.
export function suggestNeedByDate({ today, leadTimeDays, typed, firstShortWeek } = {}) {
  const lead = leadTimeDays === null || leadTimeDays === undefined || leadTimeDays === '' ? null : Number(leadTimeDays)
  const knownLead = Number.isInteger(lead) && lead >= 0 ? lead : null
  let value = null
  let source = PURCHASE_SUGGESTION_SOURCES.leadTimeNotRecorded
  if (isDay(typed)) {
    value = text(typed)
    source = PURCHASE_SUGGESTION_SOURCES.userTyped
  } else if (knownLead !== null && isDay(today)) {
    value = addCalendarDays(text(today), knownLead)
    source = PURCHASE_SUGGESTION_SOURCES.leadTime
  }
  const short = isDay(firstShortWeek) && (!value || text(firstShortWeek) < value) ? text(firstShortWeek) : null
  return { value, source, leadTimeDays: knownLead, warning: short ? { code: 'stock_short_before_need_by', weekOf: short } : null }
}
