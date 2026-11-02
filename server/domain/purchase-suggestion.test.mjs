import test from 'node:test'
import assert from 'node:assert/strict'
import { openRequestQuantity, suggestNeedByDate, suggestPurchaseQuantity } from '../../shared/purchase-suggestion.mjs'

test('the suggested quantity is the gap to the highest level, less what is available, incoming and requested', () => {
  // Target 40 (reorder point over safety stock 30 and demand 35): 40 - 10 - 5 - 3 = 22.
  const plain = suggestPurchaseQuantity({ reorderPoint: 40, safetyStock: 30, openDemand: 35, available: 10, incoming: 5, openRequests: 3 })
  assert.deepEqual(plain, { target: 40, gap: 22, covered: false, minimum: null, quantity: { value: 22, source: 'reorder_gap' } })
  // Open demand above the levels sets the target; a fraction rounds up.
  assert.deepEqual(suggestPurchaseQuantity({ reorderPoint: 10, safetyStock: 5, openDemand: 60.2, available: 20 }).quantity, { value: 41, source: 'reorder_gap' })
  // Raised to the supplier's minimum order, and said so.
  const raised = suggestPurchaseQuantity({ reorderPoint: 40, available: 10, minimum: 100 })
  assert.deepEqual(raised.quantity, { value: 100, source: 'raised_to_moq' })
  assert.equal(raised.gap, 30)
  // A minimum below the gap changes nothing.
  assert.deepEqual(suggestPurchaseQuantity({ reorderPoint: 40, available: 10, minimum: 12 }).quantity, { value: 30, source: 'reorder_gap' })
})

test('a gap covered by open orders and requests suggests nothing, and says why', () => {
  const covered = suggestPurchaseQuantity({ reorderPoint: 40, available: 10, incoming: 20, openRequests: 10 })
  assert.equal(covered.covered, true)
  assert.deepEqual(covered.quantity, { value: null, source: 'covered_by_open_orders' })
  const fine = suggestPurchaseQuantity({ reorderPoint: 40, available: 50 })
  assert.equal(fine.covered, false)
  assert.deepEqual(fine.quantity, { value: null, source: 'not_needed' })
  // No levels at all: nothing to judge by, nothing suggested.
  assert.deepEqual(suggestPurchaseQuantity({}).quantity, { value: null, source: 'not_needed' })
})

test('a quantity the user typed wins over the rule', () => {
  assert.deepEqual(suggestPurchaseQuantity({ reorderPoint: 40, available: 10, minimum: 100, typed: 7 }).quantity, { value: 7, source: 'user_typed' })
  assert.deepEqual(suggestPurchaseQuantity({ reorderPoint: 40, available: 10, typed: 0 }).quantity, { value: 30, source: 'reorder_gap' })
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
