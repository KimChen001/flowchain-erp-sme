import test from 'node:test'
import assert from 'node:assert/strict'
import { aiSkillScenario, aiSkillSeedDay } from './test-fixtures/ai-skill-scenario.mjs'
import { loadAiSkillContext } from './ai-skill-context.mjs'
import { readAiSkillFacts } from './ai-skill-readers.mjs'
import { answerAiSkill } from './ai-skills.mjs'

const SEED_DAY = '2026-09-29'
const { day } = aiSkillSeedDay(SEED_DAY)
const LINE_KEYS = ['itemId', 'itemName', 'lineId', 'originalPromisedDate', 'promisedDate', 'remaining', 'sku', 'unit']

// PO-001 (Acme Components, 4 days late) with the given lines in place of its
// one line, and PR-001 (LDM-001, awaiting approval) with any further lines.
async function withPo001Lines(lines, { requestLines = [], ...options } = {}) {
  const scenario = aiSkillScenario({ seedDay: SEED_DAY, ...options })
  const po = scenario.data.purchaseOrders.find((row) => row.id === 'PO-001')
  po.lines = lines.map(([sku, ordered, received, unit = 'pcs', extra = {}], index) => ({
    id: `PO-001-L${index + 1}`, sku, itemId: `ITEM-${sku.slice(-3)}`, itemName: sku, quantity: ordered, orderedQuantity: ordered, receivedQuantity: received,
    unit, unitPrice: '100', amount: '1000', promisedDate: day(-4), ...extra,
  }))
  scenario.data.purchaseRequests.find((row) => row.id === 'PR-001').lines.push(...requestLines)
  const facts = await readAiSkillFacts(await loadAiSkillContext(scenario.ctx))
  const answer = (skillId, language, focus = null) => answerAiSkill({ skillId, facts, language, query: 'q', actor: scenario.actor, focus }).response
  const draft = (language) => answer('prepare_action_draft', language).reviewCards.find((card) => card.targetEntityId === 'PO-001')
  return { facts, row: facts.purchaseOrders.rows.find((row) => row.id === 'PO-001'), draft, answer }
}

test('a PO whose first line is fully received names the open line and its own quantity', async () => {
  const { row, draft } = await withPo001Lines([['LDM-001', '20', '20'], ['LDM-002', '40', '0', 'pcs', { originalPromisedDate: `${day(-9)}T00:00:00.000Z` }]])
  // The order-wide figures are unchanged: the first line's SKU and the total.
  assert.deepEqual([row.sku, row.remaining, row.unit], ['LDM-001', 40, 'pcs'])
  // The open lines, by the report's line rules: the received line is left out.
  assert.deepEqual(row.openLines, [{ lineId: 'PO-001-L2', sku: 'LDM-002', itemId: 'ITEM-002', itemName: 'LDM-002', remaining: 40, unit: 'pcs', promisedDate: day(-4), originalPromisedDate: day(-9) }])

  const english = draft('en-US')
  assert.equal(english.payload.message, 'Please confirm a delivery date for the remaining 40 pcs of LDM-002 on PO-001.')
  assert.doesNotMatch(english.payload.message, /LDM-001/)
  assert.equal(draft('zh-CN').payload.message, '请确认 PO-001 上 LDM-002 剩余 40 pcs 的交货日期。')
  // The card carries the open lines next to the message, and stays review-only.
  assert.deepEqual(english.payload.lines, row.openLines)
  assert.deepEqual([english.previewOnly, english.reviewRequired, english.requiresHumanReview], [true, true, true])
})

test('several open lines are each named with their own remaining quantity and unit', async () => {
  const { row, draft } = await withPo001Lines([['LDM-001', '20', '20'], ['LDM-002', '40', '0'], ['LDM-003', '12', '2', '箱']])
  // Mixed units: no order-wide total.
  assert.deepEqual([row.remaining, row.unit], [null, 'mixed'])
  assert.deepEqual(row.openLines.map((line) => [line.sku, line.remaining, line.unit]), [['LDM-002', 40, 'pcs'], ['LDM-003', 10, '箱']])
  // A stored unit in Chinese is a stored value, allowed in an English answer.
  assert.equal(draft('en-US').payload.message, 'Please confirm delivery dates for the remaining quantities on PO-001: 40 pcs of LDM-002 and 10 箱 of LDM-003.')
  assert.equal(draft('zh-CN').payload.message, '请确认 PO-001 上以下剩余数量的交货日期：LDM-002 剩余 40 pcs和 LDM-003 剩余 10 箱。')
})

test('an open line with an unknown quantity or no SKU gets the generic message', async () => {
  for (const lines of [[['LDM-001', '20', '20'], ['LDM-002', '40', null]], [['LDM-001', '20', '20'], ['', '40', '0']]]) {
    const { row, draft } = await withPo001Lines(lines)
    assert.equal(row.openLines.length, 1)
    assert.equal(draft('en-US').payload.message, 'Please confirm a delivery date for the remaining quantity on PO-001.')
    assert.equal(draft('zh-CN').payload.message, '请确认 PO-001 剩余数量的交货日期。')
  }
})

test('open lines carry quantities and dates only, for every reader of purchase orders', async () => {
  const { facts } = await withPo001Lines([['LDM-001', '20', '20'], ['LDM-002', '40', '0']], { roleKey: 'read-only-viewer' })
  // The viewer may not read prices: amounts stay hidden, and no line carries one.
  assert.equal(facts.purchaseOrders.rows.find((row) => row.id === 'PO-001').amount, null)
  for (const row of [...facts.purchaseOrders.rows, ...facts.purchaseOrders.index]) for (const line of row.openLines) assert.deepEqual(Object.keys(line).sort(), LINE_KEYS)
  // A fully received order has no open lines.
  assert.deepEqual(facts.purchaseOrders.index.find((row) => row.id === 'PO-003').openLines, [])
})

test('an item focus finds a PO by its open lines and a request by any line, not by the first line', async () => {
  // PO-001's first line, LDM-001, is fully received; LDM-002 is still to come.
  // PR-001 asks for LDM-001 and, on a second line, LDM-003.
  const { answer } = await withPo001Lines([['LDM-001', '20', '20'], ['LDM-002', '40', '0']], { requestLines: [{ id: 'PRL-002', sku: 'LDM-003', itemId: 'ITEM-003', quantity: 5, unit: 'pcs' }] })
  const focused = (skillId, entityId) => {
    const response = answer(skillId, 'en-US', { entityType: 'item', entityId })
    return skillId === 'prepare_action_draft' ? response.reviewCards.map((card) => card.targetEntityId) : response.keyEvidence.map((item) => item.entityId)
  }
  // The item page focuses by item id; a question names the SKU.
  for (const entityId of ['ITEM-002', 'LDM-002']) {
    assert.deepEqual(focused('today_priorities', entityId), ['PO-001', 'PO-002'], entityId)
    assert.deepEqual(focused('highest_risk_items', entityId), ['PO-001'], entityId)
    assert.deepEqual(focused('prepare_action_draft', entityId), ['PO-001', 'PO-002'], entityId)
    assert.equal(answer('prepare_action_draft', 'en-US', { entityType: 'item', entityId }).reviewCards[0].payload.message, 'Please confirm a delivery date for the remaining 40 pcs of LDM-002 on PO-001.')
  }
  // Nothing of LDM-001 is left to receive on PO-001. PR-001 is found by its
  // item id as well as its SKU.
  for (const entityId of ['ITEM-001', 'LDM-001']) {
    assert.deepEqual(focused('today_priorities', entityId), ['PO-008', 'ITEM-001', 'PR-001'], entityId)
    for (const skillId of ['highest_risk_items', 'prepare_action_draft']) assert.ok(!focused(skillId, entityId).includes('PO-001'), `${skillId} ${entityId}`)
  }
  assert.deepEqual(focused('today_priorities', 'ITEM-003'), ['PR-001'])
  assert.deepEqual(focused('today_priorities', 'LDM-003'), ['PR-001'])
})
