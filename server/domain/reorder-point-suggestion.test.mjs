import test from 'node:test'
import assert from 'node:assert/strict'
import { addCalendarDays } from '../../shared/purchase-request-prefill.mjs'
import { buildReorderList, dailyDemand } from './reorder-list.mjs'
import {
  SUGGESTION_IN_STOCK_TARGET,
  attachReorderPointSuggestions,
  SUGGESTION_REVIEW_DAYS,
  circularWindowSums,
  shippedUnitsPerDay,
  suggestReorderPoint,
  suggestionRank,
} from './reorder-point-suggestion.mjs'

// server/domain/reorder-point-suggestion.mjs: the 75th smallest of the 90
// circular sums of (lead time + 7) days of shipments.
const today = '2026-11-04'
const timeZone = 'America/New_York'
// Day i of the history (0 = 90 days before today, 89 = yesterday), at noon in New York.
const dayOf = (index) => addCalendarDays(today, -90 + index)
const shippedOn = (index, quantity, unit = 'pcs') => ({ unit, quantity, postedAt: `${dayOf(index)}T16:00:00Z` })

// The formula as the research note writes it, on a plain array of 90 numbers.
function byTheNote(perDay, leadTimeDays) {
  const cover = leadTimeDays + 7
  const sums = perDay.map((_, j) => Array.from({ length: cover }, (__, t) => perDay[(j + t) % 90]).reduce((a, b) => a + b, 0))
  return Math.ceil(sums.sort((a, b) => a - b)[Math.ceil((90 * 5) / 6) - 1])
}

test('the target is 5 of 6 past stretches: rank 75 of 90, with a 7-day review period', () => {
  assert.equal(SUGGESTION_IN_STOCK_TARGET, 5 / 6)
  assert.equal(SUGGESTION_REVIEW_DAYS, 7)
  assert.equal(suggestionRank(90), 75)
  assert.equal(suggestionRank(6), 5)
  assert.equal(suggestionRank(12), 10)
})

test('stretches wrap from the last day back to the first', () => {
  assert.deepEqual(circularWindowSums([1, 2, 3, 4], 3), [6, 9, 8, 7])
  assert.deepEqual(circularWindowSums([1, 2, 3, 4], 1), [1, 2, 3, 4])
})

test('steady demand of 10 a day with a 14-day lead time suggests 21 days of it', () => {
  const lines = Array.from({ length: 90 }, (_, index) => shippedOn(index, 10))
  const result = suggestReorderPoint({ lines, stockUnit: 'pcs', leadTimeDays: 14, today, timeZone })
  assert.deepEqual(result, {
    suggestedReorderPoint: 210,
    reason: null,
    coverDays: 21,
    leadTimeDays: 14,
    reviewDays: 7,
    historyDays: 90,
    windowCount: 90,
    rank: 75,
    inStockTarget: 5 / 6,
    shipmentDays: 90,
    minShipmentDays: 8,
  })
})

test('uneven weekday demand gives the 75th smallest circular sum, as the research note computes it', () => {
  // Weekday shipments of 1 to 13, a deterministic pattern, and a spike that
  // straddles the end and the start of the history.
  const perDay = Array.from({ length: 90 }, (_, index) => ([0, 6].includes(new Date(`${dayOf(index)}T12:00:00Z`).getUTCDay()) ? 0 : ((index * 7) % 13) + 1))
  perDay[88] += 40
  perDay[1] += 30
  const lines = perDay.flatMap((quantity, index) => (quantity ? [shippedOn(index, quantity)] : []))
  for (const lead of [0, 3, 14, 17, 30]) {
    const result = suggestReorderPoint({ lines, stockUnit: 'pcs', leadTimeDays: lead, today, timeZone })
    assert.equal(result.suggestedReorderPoint, byTheNote(perDay, lead), `lead time ${lead}`)
    assert.equal(result.coverDays, lead + 7)
  }
})

test('the history is the reorder list\'s: workspace days, the stock unit, posted quantities in the 90 days', () => {
  const lines = [
    // 01:30 UTC on Nov 3 is still Nov 2 in New York (day 88); nothing ships yesterday.
    { unit: 'pcs', quantity: 4, postedAt: '2026-11-03T01:30:00Z' },
    { unit: 'PCS', quantity: 6, postedAt: '2026-11-02T18:00:00Z' },
    // No unit recorded: counted in the stock unit, as the reorder list does.
    { unit: '', quantity: 2, postedAt: '2026-10-15T15:00:00Z' },
    // Another unit, today, before the window, zero or not a number: never added.
    { unit: 'box', quantity: 3, postedAt: '2026-10-15T15:00:00Z' },
    { unit: 'pcs', quantity: 9, postedAt: '2026-11-04T15:00:00Z' },
    { unit: 'pcs', quantity: 9, postedAt: '2026-08-05T15:00:00Z' },
    { unit: 'pcs', quantity: 0, postedAt: '2026-10-16T15:00:00Z' },
    { unit: 'pcs', quantity: 'x', postedAt: '2026-10-17T15:00:00Z' },
    // The first day of the window, 90 days before today.
    { unit: 'pcs', quantity: 1.25, postedAt: '2026-08-06T15:00:00Z' },
  ]
  const perDay = shippedUnitsPerDay({ lines, stockUnit: 'pcs', today, timeZone })
  assert.equal(perDay.length, 90)
  assert.equal(perDay[88], 100000)
  assert.equal(perDay[89], 0)
  assert.equal(perDay[0], 12500)
  assert.equal(perDay[90 - 20], 20000)
  const demand = dailyDemand({ lines, stockUnit: 'pcs', today, timeZone })
  assert.equal(perDay.reduce((a, b) => a + b, 0) / 10000, demand.shippedQuantity)
  assert.equal(perDay.filter((value) => value > 0).length, demand.shipmentDays)
})

test('the suggestion is rounded up to a whole unit', () => {
  // 0.35 a day on every day: 21 days is 7.35, so 8.
  const lines = Array.from({ length: 90 }, (_, index) => shippedOn(index, 0.35))
  assert.equal(suggestReorderPoint({ lines, stockUnit: 'pcs', leadTimeDays: 14, today, timeZone }).suggestedReorderPoint, 8)
})

test('no suggestion without a stock unit, enough shipment days or a recorded lead time', () => {
  const eight = Array.from({ length: 8 }, (_, index) => shippedOn(80 + index, 5))
  const seven = eight.slice(1)
  const suggest = (input) => suggestReorderPoint({ today, timeZone, stockUnit: 'pcs', leadTimeDays: 14, ...input })
  assert.deepEqual(pick(suggest({ lines: eight, stockUnit: '' })), [null, 'stock_unit_not_recorded', 0])
  assert.deepEqual(pick(suggest({ lines: seven })), [null, 'not_enough_history', 7])
  assert.deepEqual(pick(suggest({ lines: eight, leadTimeDays: null })), [null, 'lead_time_not_recorded', 8])
  assert.deepEqual(pick(suggest({ lines: eight, leadTimeDays: -1 })), [null, 'lead_time_not_recorded', 8])
  // Lines in another unit are not shipment days of this item.
  assert.deepEqual(pick(suggest({ lines: eight.map((line) => ({ ...line, unit: 'box' })) })), [null, 'not_enough_history', 0])
  // A lead time of 0 still covers the 7-day review period.
  const zero = suggest({ lines: eight, leadTimeDays: 0 })
  assert.equal(zero.coverDays, 7)
  assert.equal(zero.suggestedReorderPoint, byTheNote(Array.from({ length: 90 }, (_, index) => (index >= 80 && index < 88 ? 5 : 0)), 0))
  assert.throws(() => suggestReorderPoint({ lines: eight, stockUnit: 'pcs', leadTimeDays: 14 }), /calendar day/)
})

test('each reorder list row gets a suggestion, and the rule row is left as it was', () => {
  const items = [
    { id: 'ITEM-A', sku: 'A', name: 'Valve', unit: 'pcs', reorderPoint: 40, status: 'active' },
    { id: 'ITEM-B', sku: 'B', name: 'Seal', unit: 'pcs', reorderPoint: 250, status: 'active' },
    { id: 'ITEM-C', sku: 'C', name: 'Gasket', unit: 'pcs', reorderPoint: 20, status: 'active' },
  ]
  const supplierLinks = ['ITEM-A', 'ITEM-B'].map((itemId) => ({ id: `${itemId}::SUP`, payload: { itemId, supplierId: 'SUP', preferred: true, active: true, approved: true, leadTimeDays: 14 } }))
  const suppliers = [{ id: 'SUP', code: 'S', name: 'Supplier', status: 'active' }]
  const allocationRows = [
    { sku: 'A', onHand: 300, reserved: 0, incomingLines: [] },
    { sku: 'B', onHand: 300, reserved: 0, incomingLines: [] },
    { sku: 'C', onHand: 5, reserved: 0, incomingLines: [] },
  ]
  // A and B ship 10 every day; C shipped on 3 days only and has no supplier.
  const shipmentLines = [
    ...Array.from({ length: 90 }, (_, index) => ({ itemId: 'ITEM-A', ...shippedOn(index, 10) })),
    ...Array.from({ length: 90 }, (_, index) => ({ itemId: 'ITEM-B', ...shippedOn(index, 10) })),
    ...[10, 40, 70].map((index) => ({ itemId: 'ITEM-C', ...shippedOn(index, 2) })),
  ]
  const list = buildReorderList({ allocationRows, items, shipmentLines, supplierLinks, suppliers, today, timeZone })
  const before = JSON.parse(JSON.stringify(list))
  const withSuggestions = attachReorderPointSuggestions(list, shipmentLines)
  // The list itself is not changed, and each row is the rule's row plus the suggestion.
  assert.deepEqual(list, before)
  assert.deepEqual(withSuggestions.rows.map(({ reorderPointSuggestion, ...row }) => row), before.rows)
  assert.deepEqual({ ...withSuggestions, rows: [] }, { ...before, rows: [] })
  const bySku = Object.fromEntries(withSuggestions.rows.map((row) => [row.sku, row.reorderPointSuggestion]))
  assert.deepEqual(Object.keys(bySku).sort(), ['A', 'B', 'C'])
  // 21 days of 10: 210, above A's recorded 40 and below B's 250.
  assert.deepEqual([bySku.A.suggestedReorderPoint, bySku.A.coverDays, bySku.A.recordedBelow], [210, 21, true])
  assert.deepEqual([bySku.B.suggestedReorderPoint, bySku.B.recordedBelow], [210, false])
  assert.deepEqual([bySku.C.suggestedReorderPoint, bySku.C.reason, bySku.C.recordedBelow, bySku.C.coverDays], [null, 'not_enough_history', false, null])
})

const pick = (result) => [result.suggestedReorderPoint, result.reason, result.shipmentDays]
