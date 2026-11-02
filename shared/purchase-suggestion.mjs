// How much of an item to request and by when, for the assistant's purchase
// request lines (docs/ai-assistant-v2-design.md §4.1 and §5.1, owner
// decisions V2-5 and V2-6 of 2026-11-02). One rule, so every place that
// suggests a quantity gives the same figure:
//
//   target   the highest of the reorder point, the safety stock and the open
//            sales demand;
//   gap      target - available - incoming on open purchase orders - the
//            quantity of open purchase requests (draft, submitted or
//            approved), rounded up;
//   quantity the gap, raised to the supplier's minimum order. A quantity the
//            user typed wins. No gap: nothing is suggested.
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

// { target, gap, covered, quantity: { value, source }, minimum }. covered:
// short against the target, but open orders and requests bring enough.
export function suggestPurchaseQuantity({ reorderPoint, safetyStock, openDemand, available, incoming, openRequests, minimum, typed } = {}) {
  const target = Math.max(count(reorderPoint), count(safetyStock), count(openDemand))
  const gap = Math.ceil(target - count(available) - count(incoming) - count(openRequests))
  const moq = positive(minimum)
  const covered = gap <= 0 && target > count(available)
  const base = { target, gap, covered, minimum: moq }
  const asked = positive(typed)
  if (asked !== null) return { ...base, quantity: { value: asked, source: PURCHASE_SUGGESTION_SOURCES.userTyped } }
  if (gap <= 0) return { ...base, quantity: { value: null, source: covered ? PURCHASE_SUGGESTION_SOURCES.coveredByOpenOrders : PURCHASE_SUGGESTION_SOURCES.notNeeded } }
  if (moq !== null && moq > gap) return { ...base, quantity: { value: moq, source: PURCHASE_SUGGESTION_SOURCES.raisedToMoq } }
  return { ...base, quantity: { value: gap, source: PURCHASE_SUGGESTION_SOURCES.reorderGap } }
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
