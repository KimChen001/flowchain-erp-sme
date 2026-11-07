import test from 'node:test'
import assert from 'node:assert/strict'
import { aiSkillScenario } from './test-fixtures/ai-skill-scenario.mjs'
import { loadAiSkillContext } from './ai-skill-context.mjs'
import { readAiSkillFacts } from './ai-skill-readers.mjs'
import { requestMinimumOf } from './reorder-list.mjs'

// The preferred supplier's minimum order, by the reorder list's own rule
// (reorder-list.mjs): a purchase request the assistant suggests asks for at
// least it, when the item is bought in its stock unit, and says so.
const link = (itemId, extra = {}) => ({ payload: { itemId, supplierId: 'SUP-001', preferred: true, active: true, approved: true, minimumOrderQuantity: 100, ...extra } })
const factsWith = async (supplierLinks, change = () => {}) => {
  const scenario = aiSkillScenario({ supplierLinks })
  change(scenario.data)
  return { scenario, facts: await readAiSkillFacts(await loadAiSkillContext(scenario.ctx)) }
}
const minimumOf = (facts, sku) => facts.inventory.rows.find((row) => row.sku === sku).orderMinimum

test('the reorder list\'s minimum rule: only in the stock unit', () => {
  assert.equal(requestMinimumOf({ unit: 'pcs' }, { minimumOrderQuantity: 100 }, 'pcs'), 100)
  assert.equal(requestMinimumOf({ unit: 'pcs', metadata: { purchaseUnit: 'PCS' } }, { minimumOrderQuantity: 100 }, 'pcs'), 100)
  assert.equal(requestMinimumOf({ unit: 'pcs', metadata: { purchaseUnit: 'case' } }, { minimumOrderQuantity: 100 }, 'pcs'), 0)
  assert.equal(requestMinimumOf({ unit: 'pcs' }, { minimumOrderQuantity: 0 }, 'pcs'), 0)
  assert.equal(requestMinimumOf({ unit: 'pcs' }, null, 'pcs'), 0)
  assert.equal(requestMinimumOf({}, { minimumOrderQuantity: 100 }, ''), 0)
})

test('each stock row carries its preferred supplier\'s minimum, read as the reorder list reads it', async () => {
  const { facts } = await factsWith([link('ITEM-001')])
  assert.deepEqual(minimumOf(facts, 'LDM-001'), { quantity: 100, supplier: 'Acme Components' })
  assert.equal(minimumOf(facts, 'LDM-002'), null)
  // Bought in cases while stocked in pcs: the minimum is in cases, so none applies.
  const cases = await factsWith([link('ITEM-001')], (data) => { data.items.find((row) => row.id === 'ITEM-001').metadata = { purchaseUnit: 'case' } })
  assert.equal(minimumOf(cases.facts, 'LDM-001'), null)
  // Not marked preferred, but the item's own preferred supplier: still its source.
  assert.deepEqual(minimumOf((await factsWith([link('ITEM-001', { preferred: false })])).facts, 'LDM-001'), { quantity: 100, supplier: 'Acme Components' })
  // Another supplier not marked preferred, or no minimum recorded: none.
  assert.equal(minimumOf((await factsWith([link('ITEM-001', { preferred: false, supplierId: 'SUP-002' })])).facts, 'LDM-001'), null)
  assert.equal(minimumOf((await factsWith([link('ITEM-001', { minimumOrderQuantity: null })])).facts, 'LDM-001'), null)
  // No links read: nothing changes.
  assert.equal(minimumOf((await factsWith([])).facts, 'LDM-001'), null)
})

