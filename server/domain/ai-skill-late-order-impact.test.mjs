import test from 'node:test'
import assert from 'node:assert/strict'
import { aiSkillScenario } from './test-fixtures/ai-skill-scenario.mjs'
import { loadAiSkillContext } from './ai-skill-context.mjs'
import { readAiSkillFacts } from './ai-skill-readers.mjs'
import { runLateOrderImpact } from './ai-skill-late-order-impact.mjs'

// The scenario: LDM-001 has 28 available against SO-001 (Redwood Retail, 35
// open), with 70 coming on PO-001 (30 left, 4 days late) and PO-008 (40, 2 days
// late). Either late order alone leaves it covered; both together leave it 7
// short.
async function scenarioFacts(roleKey) {
  const scenario = aiSkillScenario(roleKey ? { roleKey } : {})
  return { scenario, facts: await readAiSkillFacts(await loadAiSkillContext(scenario.ctx)) }
}


test('the late orders are judged together, in the inventory page\'s terms', async () => {
  const { facts } = await scenarioFacts()
  const row = facts.inventory.rows.find((entry) => entry.sku === 'LDM-001')
  const result = runLateOrderImpact(facts, { route: {} })
  assert.equal(result.mode, 'late')
  const group = result.groups.find((entry) => entry.sku === 'LDM-001')
  assert.deepEqual(group.pos.map((po) => po.orderNumber), ['PO-001', 'PO-008'])
  // Available to promise as the inventory page states it, less the two late lines.
  assert.equal(group.atp, row.availableToPromise)
  assert.equal(group.lost, 70)
  assert.equal(group.without, row.availableToPromise - 70)
  assert.equal(group.added, 7)
  assert.deepEqual(group.orders.map((order) => [order.number, order.customer, order.open]), [['SO-001', 'Redwood Retail', 35]])
})

test('without sales orders the customers are not named; a line in another unit changes nothing', async () => {
  const { facts } = await scenarioFacts()
  const hidden = { ...facts, salesOrders: undefined }
  const result = runLateOrderImpact(hidden, { route: {} })
  assert.equal(result.salesVisible, false)
  assert.ok(result.groups.every((group) => !group.orders?.length))
  // A PO line the stock figures never counted (another unit): not counted as coming.
  const po = facts.purchaseOrders.index.find((row) => row.orderNumber === 'PO-001')
  const inventory = { ...facts.inventory, rows: facts.inventory.rows.map((row) => row.sku === 'LDM-001' ? { ...row, purchaseOrderIds: row.purchaseOrderIds.filter((id) => id !== po.id) } : row) }
  const other = runLateOrderImpact({ ...facts, inventory }, { route: { entities: { purchaseOrders: [po] } } })
  assert.equal(other.groups[0].counted, false)
  assert.equal(other.groups[0].added, 0)
})

test('the impact needs purchase orders and stock', async () => {
  const { facts } = await scenarioFacts()
  assert.equal(runLateOrderImpact({ ...facts, inventory: null }, { route: {} }).hidden, true)
  assert.equal(runLateOrderImpact({ ...facts, purchaseOrders: null }, { route: {} }).hidden, true)
})
