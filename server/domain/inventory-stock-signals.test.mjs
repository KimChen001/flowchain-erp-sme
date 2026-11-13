import test from 'node:test'
import assert from 'node:assert/strict'
import { inventoryStockSignals, stockSignalCounts, stockStateOf } from '../../shared/inventory-stock-signals.mjs'

const balance = (sku, available, safetyStock, reorderPoint, extra = {}) => ({ sku, availableQuantity: String(available), onHandQuantity: String(available), safetyStock: String(safetyStock), reorderPoint: String(reorderPoint), ...extra })
const reorderRow = (sku, position, incoming, reorderPoint) => ({ sku, position, incoming, reorderPoint, orderNow: position <= reorderPoint })

test('need replenishment is the reorder list\'s order now, and below safety stock is the shelf', () => {
  // As on the public data scene: a shelf below safety stock that two late orders
  // cover, an item just under its reorder point with nothing coming, and one
  // whose stock on hand is under its reorder point but covered by an order.
  const balances = [
    balance('85123A', 48, 119, 358),
    balance('22423', 132, 51, 152),
    balance('84991', 200, 93, 278),
    balance('20725', 400, 75, 226),
  ]
  const reorderList = {
    rows: [reorderRow('85123A', 408, 360, 358), reorderRow('22423', 132, 0, 152), reorderRow('84991', 420, 220, 278), reorderRow('20725', 400, 0, 226)],
    notJudged: [],
  }
  const signals = inventoryStockSignals({ balances, reorderList })
  const hero = signals.get('85123A')
  assert.equal(hero.needsReplenishment, false)
  assert.equal(hero.belowSafetyOnHand, true)
  assert.equal(hero.coveredByOpenOrders, true)
  assert.equal(hero.warned, true)
  assert.equal(stockStateOf(hero, balances[0]), 'below_safety')
  const cakestand = signals.get('22423')
  assert.equal(cakestand.needsReplenishment, true)
  assert.equal(cakestand.belowSafetyOnHand, false)
  assert.equal(stockStateOf(cakestand, balances[1]), 'replenish')
  // On hand under the reorder point, but the position is above it: no warning.
  assert.equal(signals.get('84991').warned, false)
  assert.equal(stockStateOf(signals.get('84991'), balances[2]), 'ok')
  assert.deepEqual(stockSignalCounts(signals), { warned: 2, needsReplenishment: 1, belowSafetyOnHand: 1, coveredByOpenOrders: 1, noneAvailable: 0, positionUnknown: false })
})

test('an item is judged over every location shown, and an empty location reads out of stock', () => {
  const balances = [balance('VALVE-100', 30, 20, 40, { location: null }), balance('VALVE-100', 35, 20, 40, { location: 'A-01' }), balance('VALVE-100', 0, 20, 40, { location: 'B-02' })]
  const signals = inventoryStockSignals({ balances, reorderList: { rows: [], notJudged: [] } })
  const valve = signals.get('VALVE-100')
  assert.equal(valve.available, 65)
  assert.equal(valve.belowSafetyOnHand, false)
  // Above its reorder point, so the reorder list has no row for it: known, and nothing to order.
  assert.equal(valve.positionKnown, true)
  assert.equal(valve.needsReplenishment, false)
  assert.equal(stockStateOf(valve, balances[0]), 'ok')
  assert.equal(stockStateOf(valve, balances[2]), 'out')
})

test('without the reorder list the position is unknown and only the shelf is judged', () => {
  const balances = [balance('SEAL-400', 10, 30, 60), balance('BOLT-1', 500, 30, 60)]
  for (const reorderList of [null, { rows: [], notJudged: [{ sku: 'SEAL-400', reason: 'warehouse_scope' }, { sku: 'BOLT-1', reason: 'warehouse_scope' }] }]) {
    const signals = inventoryStockSignals({ balances, reorderList })
    const seal = signals.get('SEAL-400')
    assert.equal(seal.positionKnown, false)
    assert.equal(seal.needsReplenishment, false)
    assert.equal(seal.coveredByOpenOrders, false)
    assert.equal(seal.belowSafetyOnHand, true)
    assert.equal(stockStateOf(seal, balances[0]), 'below_safety')
    const counts = stockSignalCounts(signals)
    assert.equal(counts.positionUnknown, true)
    assert.equal(counts.belowSafetyOnHand, 1)
  }
  // No safety stock recorded: never below it.
  assert.equal(inventoryStockSignals({ balances: [balance('X', 0, 0, 0)], reorderList: null }).get('X').belowSafetyOnHand, false)
})
