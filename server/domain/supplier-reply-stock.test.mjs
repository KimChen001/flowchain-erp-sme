import test from 'node:test'
import assert from 'node:assert/strict'
import { supplierReplyStockEffects } from './supplier-reply-stock.mjs'

// The "Stock:" line on a supplier reply card (docs/supplier-reply-dates-design.md
// §4.6): the projection with the reply's new dates against the order's dates
// now, day by day, on open sales orders or the recorded shipping rate.

const today = '2026-11-20'
const plus = (days) => new Date(Date.parse(`${today}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10)
const item = (over = {}) => ({ sku: 'SKU-1040', itemName: 'Bracket', unit: 'pcs', available: 120, reorderPoint: 100, ...over })
// The reply's order, PO-1, with one line 5 days late.
const line = (over = {}) => ({ lineId: 'L1', purchaseOrderId: 'PO-1', sku: 'SKU-1040', unit: 'pcs', remaining: 60, promisedDate: plus(-5), ...over })
const run = (over = {}) => supplierReplyStockEffects({ today, purchaseOrderId: 'PO-1', items: [item()], incoming: [line()], demand: [], rates: new Map(), overrides: [{ lineId: 'L1', date: plus(8) }], ...over })

test('nothing changes: the stock stays above its reorder point until the new date', () => {
  assert.deepEqual(run({ items: [item({ available: 500 })], rates: new Map([['SKU-1040', 10]]) }), [])
  // Open sales orders that the stock covers either way.
  assert.deepEqual(run({ items: [item({ available: 400 })], demand: [{ sku: 'SKU-1040', quantity: 50, promisedDate: plus(3) }] }), [])
})

test('a stock-out moved earlier: at the shipped rate it runs out before the late line now arrives', () => {
  // 30 available, 10 a day: below 0 on day 3. Due now, the 60 would have covered it.
  const effects = run({ items: [item({ available: 30, reorderPoint: null })], rates: new Map([['SKU-1040', 10]]) })
  assert.deepEqual(effects, [{ sku: 'SKU-1040', itemName: 'Bracket', unit: 'pcs', kind: 'short', from: plus(3), newDate: plus(8), basis: 'recorded_rate', reorderPoint: null }])
  // A line moved from one future day to a later one: the same comparison.
  const later = run({ items: [item({ available: 30, reorderPoint: null })], rates: new Map([['SKU-1040', 10]]), incoming: [line({ promisedDate: plus(2) })] })
  assert.equal(later[0].kind, 'short')
  assert.equal(later[0].from, plus(3))
})

test('below the reorder point before the new date, from an open sales order', () => {
  // 120 available, reorder point 100, 30 promised to a customer on day 2.
  const effects = run({ demand: [{ sku: 'SKU-1040', quantity: 30, promisedDate: plus(2) }] })
  assert.deepEqual(effects.map((effect) => [effect.kind, effect.from, effect.newDate, effect.basis, effect.reorderPoint]), [['below_reorder_point', plus(2), plus(8), 'open_sales_orders', 100]])
  // A sales order already past its day counts today.
  assert.equal(run({ demand: [{ sku: 'SKU-1040', quantity: 30, promisedDate: plus(-1) }] })[0].from, today)
  // Already below the reorder point either way: nothing the reply changes.
  assert.deepEqual(run({ items: [item({ available: 120, reorderPoint: 300 })], demand: [{ sku: 'SKU-1040', quantity: 30, promisedDate: plus(2) }] }), [])
})

test('a split delivery counts whole on its last part\'s date, the safe side', () => {
  // "200 on day 2, the other 100 on day 10": the proposal carries day 10, the
  // last part, and the whole 300 arrives then. At 30 a day the 100 available
  // run out on day 3, though the first part would have come on day 2.
  const split = { incoming: [line({ remaining: 300 })], items: [item({ available: 100, reorderPoint: null })], rates: new Map([['SKU-1040', 30]]), overrides: [{ lineId: 'L1', date: plus(10) }] }
  assert.deepEqual(run(split).map((effect) => [effect.kind, effect.from, effect.newDate]), [['short', plus(3), plus(10)]])
})

test('the most severe effect is shown: running out before falling below the reorder point', () => {
  const effects = run({ items: [item({ available: 105 })], rates: new Map([['SKU-1040', 20]]) })
  // Below 100 on day 0 (85), short on day 5 (-15).
  assert.deepEqual(effects.map((effect) => [effect.kind, effect.from]), [['short', plus(5)]])
})

test('other orders\' lines: a future one counts on its day, a late or undated one is not guessed', () => {
  const rates = new Map([['SKU-1040', 10]])
  const base = { items: [item({ available: 30, reorderPoint: null })], rates }
  // Another order brings 100 on day 1: the stock never runs out.
  assert.deepEqual(run({ ...base, incoming: [line(), line({ lineId: 'X1', purchaseOrderId: 'PO-2', remaining: 100, promisedDate: plus(1) })] }), [])
  // Late or undated, it is left out, so the stock still runs out on day 3.
  assert.equal(run({ ...base, incoming: [line(), line({ lineId: 'X1', purchaseOrderId: 'PO-2', remaining: 100, promisedDate: plus(-2) })] })[0].from, plus(3))
  assert.equal(run({ ...base, incoming: [line(), line({ lineId: 'X1', purchaseOrderId: 'PO-2', remaining: 100, promisedDate: null })] })[0].from, plus(3))
})

test('nothing to show: an earlier date, a date today, another unit, a line not on the order, or no item', () => {
  const short = { items: [item({ available: 30, reorderPoint: null })], rates: new Map([['SKU-1040', 10]]) }
  assert.ok(run(short).length)
  // A future line brought forward only helps.
  assert.deepEqual(run({ ...short, incoming: [line({ promisedDate: plus(9) })], overrides: [{ lineId: 'L1', date: plus(4) }] }), [])
  assert.deepEqual(run({ ...short, overrides: [{ lineId: 'L1', date: today }] }), [])
  assert.deepEqual(run({ ...short, incoming: [line({ unit: 'box' })] }), [])
  assert.deepEqual(run({ ...short, purchaseOrderId: 'PO-2' }), [])
  assert.deepEqual(run({ ...short, overrides: [{ lineId: 'L9', date: plus(8) }] }), [])
  assert.deepEqual(run({ ...short, items: [] }), [])
  assert.deepEqual(run({ ...short, overrides: [{ lineId: 'L1', date: 'next week' }] }), [])
})

test('with no demand on either basis, available stock is judged against the reorder point', () => {
  // 80 available under a reorder point of 100: the late 60 due now would lift it.
  assert.deepEqual(run({ items: [item({ available: 80 })], demand: null }).map((effect) => [effect.kind, effect.from, effect.basis]), [['below_reorder_point', today, null]])
})

test('several SKUs: each its own effect, running out first', () => {
  const items = [item({ available: 30, reorderPoint: null }), item({ sku: 'SKU-2210', itemName: 'Hinge', available: 120 })]
  const incoming = [line(), line({ lineId: 'L2', sku: 'SKU-2210', remaining: 20 })]
  const demand = [{ sku: 'SKU-2210', quantity: 30, promisedDate: plus(1) }]
  const effects = run({ items, incoming, demand, rates: new Map([['SKU-1040', 10]]), overrides: [{ lineId: 'L1', date: plus(8) }, { lineId: 'L2', date: plus(6) }] })
  assert.deepEqual(effects.map((effect) => [effect.sku, effect.kind, effect.from, effect.newDate]), [['SKU-1040', 'short', plus(3), plus(8)], ['SKU-2210', 'below_reorder_point', plus(1), plus(6)]])
})
