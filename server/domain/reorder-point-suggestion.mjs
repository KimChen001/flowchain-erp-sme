import { addCalendarDays } from '../../shared/purchase-request-prefill.mjs'
import { DEFAULT_TENANT_TIMEZONE, instantCalendarDay } from './tenant-calendar-day.mjs'
import { DEMAND_WINDOW_DAYS, MIN_SHIPMENT_DAYS, dailyDemand } from './reorder-list.mjs'

// A suggested reorder point for an item, from its own shipment history and its
// preferred supplier's lead time. It is a suggestion only: the reorder list
// still dates every item by its recorded reorder point, and the recorded value
// changes only when a person sets it on the item (an audited item update).
//
//   history      the quantity shipped on each of the 90 workspace days before
//                today: the same posted shipment lines, stock-unit rules and
//                workspace days as the reorder list's daily demand
//                (dailyDemand in reorder-list.mjs).
//   cover days   H = lead time + 7: an order placed now has to cover the lead
//                time, plus a week until the list is looked at again.
//   stretches    the 90 sums of H consecutive days of the history, one
//                starting on each day, wrapping from the last day back to the
//                first: window j is the sum of d[(j + t) % 90] for t < H.
//   suggestion   the 75th smallest of the 90 sums (nearest rank,
//                ceil(90 × 5/6)), rounded up to a whole unit: enough for the
//                next H days in 5 of 6 past stretches.
//
// 5/6 is the newsvendor critical ratio when a unit short costs 5 times what
// holding one costs: 5 / (5 + 1). It comes from the replenishment research
// (an offline SAA model over the showcase data), which simulates this exact
// formula; change it only together with that research.
//
// No suggestion, with a reason, when the stock unit is not recorded (lines in
// different units are never added), when the item shipped on fewer than 8 of
// the 90 days (the reorder list's own minimum), or when the preferred
// supplier link records no lead time.

export const SUGGESTION_IN_STOCK_TARGET = 5 / 6
export const SUGGESTION_REVIEW_DAYS = 7

export const SUGGESTION_REASONS = Object.freeze({
  stockUnitNotRecorded: 'stock_unit_not_recorded',
  notEnoughHistory: 'not_enough_history',
  leadTimeNotRecorded: 'lead_time_not_recorded',
})

const rows = (value) => (Array.isArray(value) ? value : [])
const text = (value) => String(value ?? '').trim()
const quantity = (value) => (value === null || value === undefined || value === '' || !Number.isFinite(Number(value)) ? null : Number(value))
// Whole ten-thousandths, as the reorder list adds quantities.
const SCALE = 10000
const toUnits = (value) => Math.round(value * SCALE)

// The nearest rank of the in-stock target among n sums, 1-based: 75 of 90.
// The small tolerance keeps n × 5/6 from rounding up past a whole rank.
export const suggestionRank = (n, target = SUGGESTION_IN_STOCK_TARGET) => Math.min(n, Math.max(1, Math.ceil(n * target - 1e-9)))

// The quantity shipped on each of the 90 days before today, oldest first, in
// whole ten-thousandths of the stock unit. A line in another unit is never
// added; a line with no unit counts in the stock unit (as in dailyDemand).
export function shippedUnitsPerDay({ lines = [], stockUnit, today, timeZone = DEFAULT_TENANT_TIMEZONE }) {
  const firstDay = addCalendarDays(today, -DEMAND_WINDOW_DAYS)
  const indexOf = new Map(Array.from({ length: DEMAND_WINDOW_DAYS }, (_, index) => [addCalendarDays(firstDay, index), index]))
  const perDay = new Array(DEMAND_WINDOW_DAYS).fill(0)
  for (const line of rows(lines)) {
    const index = indexOf.get(instantCalendarDay(line.postedAt, timeZone))
    const shipped = quantity(line.quantity)
    if (index === undefined || shipped === null || shipped <= 0) continue
    const unit = text(line.unit)
    if (unit && unit.toLowerCase() !== text(stockUnit).toLowerCase()) continue
    perDay[index] += toUnits(shipped)
  }
  return perDay
}

// The sums of every `cover`-day stretch of a daily series, wrapping around
// its end: one sum per starting day.
export function circularWindowSums(perDay, cover) {
  const n = perDay.length
  return perDay.map((_, start) => {
    let sum = 0
    for (let offset = 0; offset < cover; offset += 1) sum += perDay[(start + offset) % n]
    return sum
  })
}

// lines: { unit, quantity, postedAt } of posted shipments for one item.
// leadTimeDays: the preferred supplier link's recorded lead time, or null.
export function suggestReorderPoint({ lines = [], stockUnit = '', leadTimeDays = null, today, timeZone = DEFAULT_TENANT_TIMEZONE } = {}) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text(today))) throw new Error('A workspace calendar day is required.')
  const lead = quantity(leadTimeDays)
  const recordedLead = lead !== null && lead >= 0 ? Math.ceil(lead) : null
  const coverDays = recordedLead === null ? null : recordedLead + SUGGESTION_REVIEW_DAYS
  const rank = suggestionRank(DEMAND_WINDOW_DAYS)
  const base = {
    suggestedReorderPoint: null,
    reason: null,
    coverDays,
    leadTimeDays: recordedLead,
    reviewDays: SUGGESTION_REVIEW_DAYS,
    historyDays: DEMAND_WINDOW_DAYS,
    windowCount: DEMAND_WINDOW_DAYS,
    rank,
    inStockTarget: SUGGESTION_IN_STOCK_TARGET,
    shipmentDays: 0,
    minShipmentDays: MIN_SHIPMENT_DAYS,
  }
  if (!text(stockUnit)) return { ...base, reason: SUGGESTION_REASONS.stockUnitNotRecorded }
  // The reorder list's own test for enough history.
  const demand = dailyDemand({ lines, stockUnit, today, timeZone })
  const withHistory = { ...base, shipmentDays: demand.shipmentDays }
  if (demand.shippedUnits === null) return { ...withHistory, reason: SUGGESTION_REASONS.notEnoughHistory }
  if (coverDays === null) return { ...withHistory, reason: SUGGESTION_REASONS.leadTimeNotRecorded }
  const sums = circularWindowSums(shippedUnitsPerDay({ lines, stockUnit, today, timeZone }), coverDays).sort((a, b) => a - b)
  return { ...withHistory, suggestedReorderPoint: Math.ceil(sums[rank - 1] / SCALE) }
}

// The reorder list (buildReorderList's result) with a suggestion on each row,
// from the shipment lines the list was built from ({ itemId, unit, quantity,
// postedAt }) and the row's preferred supplier lead time. recordedBelow: the
// recorded reorder point is below the suggestion. Nothing else on the row
// changes.
export function attachReorderPointSuggestions(list, shipmentLines = []) {
  const linesByItem = new Map()
  for (const line of rows(shipmentLines)) {
    const key = text(line.itemId)
    if (!linesByItem.has(key)) linesByItem.set(key, [])
    linesByItem.get(key).push(line)
  }
  return {
    ...list,
    rows: rows(list?.rows).map((row) => {
      const suggestion = suggestReorderPoint({ lines: linesByItem.get(text(row.itemId)), stockUnit: row.unit, leadTimeDays: row.supplier?.leadTimeDays ?? null, today: list.today, timeZone: list.timeZone })
      const recordedBelow = suggestion.suggestedReorderPoint !== null && Number(row.reorderPoint) < suggestion.suggestedReorderPoint
      return { ...row, reorderPointSuggestion: { ...suggestion, recordedBelow } }
    }),
  }
}
