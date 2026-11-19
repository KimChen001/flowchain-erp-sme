import test from 'node:test'
import assert from 'node:assert/strict'
import { ORDER_UP_TO_REVIEW_DAYS, inventoryPosition, openRequestQuantity, orderUpToLevel, suggestNeedByDate, suggestPurchaseQuantity } from '../../shared/purchase-suggestion.mjs'

// The one position the reorder list and the assistant set the target against
// (design audit C2).
const at = (parts, extra = {}) => ({ ...inventoryPosition(parts), ...extra })

test('the position is on hand less reserved, plus what is on order or requested, less backorders, each counted once', () => {
  assert.deepEqual(inventoryPosition({ onHand: 100, reserved: 20, incoming: 15, pendingOrders: 5, openRequests: 3, backorders: 8 }), { stock: 72, supply: 23, position: 95 })
  // available may stand for on hand less reserved; tenths add up exactly.
  assert.deepEqual(inventoryPosition({ available: 0.1, incoming: 0.2 }), { stock: 0.1, supply: 0.2, position: 0.3 })
})

// Acceptance (design audit C2, L3-04): 100 on hand, a sales order of 100
// reserved in full, reorder point 30. The reservation is out of on hand
// once, and the order has no backorder left: the suggestion is 30, not 100.
test('with every open order reserved, the suggestion is the reorder point less the position: 30, not 100', () => {
  const full = suggestPurchaseQuantity(at({ onHand: 100, reserved: 100, backorders: 0 }, { reorderPoint: 30 }))
  assert.deepEqual(full, { target: 30, trigger: 30, gap: 30, covered: false, minimum: null, lotSize: null, quantity: { value: 30, source: 'reorder_gap' } })
  // A backorder no reservation covers is out of the position, and raises the
  // gap by itself: reorder point 50, nothing on hand, 40 backordered, 90.
  assert.deepEqual(suggestPurchaseQuantity(at({ onHand: 0, reserved: 0, backorders: 40 }, { reorderPoint: 50 })).quantity, { value: 90, source: 'reorder_gap' })
  // Without a reorder point the safety stock is the target; without either,
  // backorders alone still need covering.
  assert.deepEqual(suggestPurchaseQuantity(at({ onHand: 10, reserved: 0 }, { safetyStock: 30 })).quantity, { value: 20, source: 'reorder_gap' })
  assert.deepEqual(suggestPurchaseQuantity(at({ onHand: 5, reserved: 0, backorders: 12.2 })).quantity, { value: 8, source: 'reorder_gap' })
})

test('the suggested quantity is the gap to the reorder point, raised to the minimum order', () => {
  // 40 - (10 + 5 + 3) = 22.
  const plain = suggestPurchaseQuantity(at({ available: 10, incoming: 5, openRequests: 3 }, { reorderPoint: 40, safetyStock: 30 }))
  assert.deepEqual(plain, { target: 40, trigger: 40, gap: 22, covered: false, minimum: null, lotSize: null, quantity: { value: 22, source: 'reorder_gap' } })
  const raised = suggestPurchaseQuantity(at({ available: 10 }, { reorderPoint: 40, minimum: 100 }))
  assert.deepEqual(raised.quantity, { value: 100, source: 'raised_to_moq' })
  assert.equal(raised.gap, 30)
  // A minimum below the gap changes nothing; a fraction rounds up.
  assert.deepEqual(suggestPurchaseQuantity(at({ available: 10 }, { reorderPoint: 40, minimum: 12 })).quantity, { value: 30, source: 'reorder_gap' })
  assert.deepEqual(suggestPurchaseQuantity(at({ available: 10.5 }, { reorderPoint: 40 })).quantity, { value: 30, source: 'reorder_gap' })
})

test('a gap covered by open orders and requests suggests nothing, and says why', () => {
  const covered = suggestPurchaseQuantity(at({ available: 10, incoming: 20, pendingOrders: 5, openRequests: 5 }, { reorderPoint: 40 }))
  assert.equal(covered.covered, true)
  assert.deepEqual(covered.quantity, { value: null, source: 'covered_by_open_orders' })
  const fine = suggestPurchaseQuantity(at({ available: 50 }, { reorderPoint: 40 }))
  assert.equal(fine.covered, false)
  assert.deepEqual(fine.quantity, { value: null, source: 'not_needed' })
  // No levels and nothing backordered: nothing suggested.
  assert.deepEqual(suggestPurchaseQuantity({}).quantity, { value: null, source: 'not_needed' })
})

test('a quantity the user typed wins over the rule', () => {
  assert.deepEqual(suggestPurchaseQuantity(at({ available: 10 }, { reorderPoint: 40, minimum: 100, typed: 7 })).quantity, { value: 7, source: 'user_typed' })
  assert.deepEqual(suggestPurchaseQuantity(at({ available: 10 }, { reorderPoint: 40, typed: 0 })).quantity, { value: 30, source: 'reorder_gap' })
})

// Design audit C3 (owner "按建议做"): an (s, S) rule. The order-up-to level is
// the item's own, else assumed to be the reorder point plus a week of demand.
test("the order-up-to level is the item's own above the reorder point, else assumed from a week of demand", () => {
  assert.equal(ORDER_UP_TO_REVIEW_DAYS, 7)
  assert.deepEqual(orderUpToLevel({ reorderPoint: 238, recorded: 400, averageDailyDemand: 11.3111 }), { level: 400, source: 'recorded' })
  // 238 + 7 x 11.3111 = 317.1777.
  assert.deepEqual(orderUpToLevel({ reorderPoint: 238, averageDailyDemand: 11.3111 }), { level: 317.1777, source: 'assumed' })
  // A recorded level at or below the reorder point is not one.
  assert.deepEqual(orderUpToLevel({ reorderPoint: 238, recorded: 238, averageDailyDemand: 11.3111 }).source, 'assumed')
  assert.deepEqual(orderUpToLevel({ reorderPoint: 50 }), { level: 50, source: 'reorder_point' })
  assert.deepEqual(orderUpToLevel({}), { level: null, source: null })
})

// Acceptance (design audit C3, V-A-01), item 22065 on the UCI walkthrough:
// 79 on hand + 112 incoming = 191 against a reorder point of 238, 1,018
// shipped in 90 days, a minimum of 80. Ordering up to the level, not to the
// reorder point, leaves the position at the level or above.
test('once due, the quantity orders up to the level, rounded to the lot and raised to the minimum', () => {
  const level = orderUpToLevel({ reorderPoint: 238, averageDailyDemand: 11.3111 }).level
  const sized = suggestPurchaseQuantity({ reorderPoint: 238, orderUpTo: level, minimum: 80, ...inventoryPosition({ onHand: 79, reserved: 0, incoming: 112 }) })
  assert.deepEqual([sized.target, sized.gap, sized.quantity], [317.1777, 127, { value: 127, source: 'reorder_gap' }])
  assert.ok(191 + sized.quantity.value >= level)
  // Rounded up to whole lots of 24, and the minimum to whole lots too.
  assert.deepEqual(suggestPurchaseQuantity({ reorderPoint: 238, orderUpTo: level, lotSize: 24, ...inventoryPosition({ onHand: 79, incoming: 112 }) }).quantity, { value: 144, source: 'reorder_gap' })
  assert.deepEqual(suggestPurchaseQuantity({ reorderPoint: 40, orderUpTo: 45, lotSize: 12, minimum: 30, ...inventoryPosition({ onHand: 38 }) }).quantity, { value: 36, source: 'raised_to_moq' })
  // Above the reorder point nothing is due, though the position is below the level.
  assert.deepEqual(suggestPurchaseQuantity({ reorderPoint: 238, orderUpTo: level, ...inventoryPosition({ onHand: 250 }) }).quantity, { value: null, source: 'not_needed' })
  // Unless the order-by day is today (less than a day of demand above it, W-02).
  assert.deepEqual(suggestPurchaseQuantity({ reorderPoint: 238, orderUpTo: level, dueToday: true, ...inventoryPosition({ onHand: 245 }) }).quantity, { value: 73, source: 'reorder_gap' })
  // Ordered up to the level: no longer due.
  assert.equal(suggestPurchaseQuantity({ reorderPoint: 238, orderUpTo: level, ...inventoryPosition({ onHand: 79, incoming: 112 + 127 }) }).quantity.value, null)
})

test('open requests count in draft, submitted and approved, in the item\'s unit only', () => {
  const requests = [
    { status: 'draft', lines: [{ sku: 'A', quantity: 5, unit: 'pcs' }, { sku: 'B', quantity: 100, unit: 'pcs' }] },
    { status: 'submitted', lines: [{ sku: 'A', quantity: 3, unit: 'PCS' }] },
    { status: 'approved', lines: [{ itemId: 'ITEM-A', quantity: 2 }] },
    { status: 'approved', lines: [{ sku: 'A', quantity: 9, unit: 'box' }] },
    { status: 'converted', lines: [{ sku: 'A', quantity: 50, unit: 'pcs' }] },
    { status: 'cancelled', lines: [{ sku: 'A', quantity: 50, unit: 'pcs' }] },
  ]
  assert.equal(openRequestQuantity(requests, { sku: 'A', itemId: 'ITEM-A', unit: 'pcs' }), 10)
  assert.equal(openRequestQuantity(null, { sku: 'A' }), 0)
})

test('the need-by date is today plus the lead time, with a warning when stock runs short sooner', () => {
  assert.deepEqual(suggestNeedByDate({ today: '2026-09-29', leadTimeDays: 12 }), { value: '2026-10-11', source: 'lead_time', leadTimeDays: 12, warning: null })
  // A short week before the date keeps the date and warns (decision V2-6 (c)).
  assert.deepEqual(suggestNeedByDate({ today: '2026-09-29', leadTimeDays: 12, firstShortWeek: '2026-10-06' }).warning, { code: 'stock_short_before_need_by', weekOf: '2026-10-06' })
  assert.equal(suggestNeedByDate({ today: '2026-09-29', leadTimeDays: 12, firstShortWeek: '2026-10-13' }).warning, null)
  // No lead time recorded: no date, and any short week is a warning.
  assert.deepEqual(suggestNeedByDate({ today: '2026-09-29', leadTimeDays: null, firstShortWeek: '2026-09-29' }), { value: null, source: 'lead_time_not_recorded', leadTimeDays: null, warning: { code: 'stock_short_before_need_by', weekOf: '2026-09-29' } })
  // A lead time of 0 days is today; a date the user typed wins.
  assert.equal(suggestNeedByDate({ today: '2026-09-29', leadTimeDays: 0 }).value, '2026-09-29')
  assert.deepEqual(suggestNeedByDate({ today: '2026-09-29', leadTimeDays: 12, typed: '2026-12-01' }), { value: '2026-12-01', source: 'user_typed', leadTimeDays: 12, warning: null })
})
