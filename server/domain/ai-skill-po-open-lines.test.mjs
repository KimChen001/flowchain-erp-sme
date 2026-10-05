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

// A calendar day as drafts show it: the tenant locale (en-US here), medium style.
const shown = (value) => new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeZone: 'UTC' }).format(new Date(`${value}T12:00:00Z`))

test('a PO whose first line is fully received names the open line and its own quantity', async () => {
  const { row, draft } = await withPo001Lines([['LDM-001', '20', '20'], ['LDM-002', '40', '0', 'pcs', { originalPromisedDate: `${day(-9)}T00:00:00.000Z` }]])
  // The order-wide figures are unchanged: the first line's SKU and the total.
  assert.deepEqual([row.sku, row.remaining, row.unit], ['LDM-001', 40, 'pcs'])
  // The open lines, by the report's line rules: the received line is left out.
  assert.deepEqual(row.openLines, [{ lineId: 'PO-001-L2', sku: 'LDM-002', itemId: 'ITEM-002', itemName: 'LDM-002', remaining: 40, unit: 'pcs', promisedDate: day(-4), originalPromisedDate: day(-9) }])

  // The message is a letter to the supplier: one line per open line, with its
  // own quantity and promised date, and the original date when it moved.
  const english = draft('en-US')
  assert.deepEqual(english.payload.message.split('\n'), ['Hello Acme Components,', '', 'Please confirm a delivery date for the open line on PO-001:', `- LDM-002: 40 pcs still to deliver, promised ${shown(day(-4))} (originally ${shown(day(-9))})`, '', 'Thank you.'])
  assert.doesNotMatch(english.payload.message, /LDM-001/)
  assert.equal(english.payload.subject, 'PO-001: delivery date for LDM-002')
  assert.deepEqual(draft('zh-CN').payload.message.split('\n'), ['Acme Components，您好：', '', '请确认 PO-001 上以下未交货行的交货日期：', `- LDM-002：仍有 40 pcs 未交，承诺日期 ${shown(day(-4))}（原定 ${shown(day(-9))}）`, '', '谢谢。'])
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
  const english = draft('en-US')
  assert.deepEqual(english.payload.message.split('\n').slice(2, 5), ['Please confirm delivery dates for the open lines on PO-001:', `- LDM-002: 40 pcs still to deliver, promised ${shown(day(-4))}`, `- LDM-003: 10 箱 still to deliver, promised ${shown(day(-4))}`])
  assert.equal(english.payload.subject, 'PO-001: delivery dates for 2 open lines')
  assert.deepEqual(draft('zh-CN').payload.message.split('\n').slice(2, 5), ['请确认 PO-001 上以下未交货行的交货日期：', `- LDM-002：仍有 40 pcs 未交，承诺日期 ${shown(day(-4))}`, `- LDM-003：仍有 10 箱 未交，承诺日期 ${shown(day(-4))}`])
})

test('an open line with an unknown quantity or no SKU gets the generic message', async () => {
  for (const lines of [[['LDM-001', '20', '20'], ['LDM-002', '40', null]], [['LDM-001', '20', '20'], ['', '40', '0']]]) {
    const { row, draft } = await withPo001Lines(lines)
    assert.equal(row.openLines.length, 1)
    assert.equal(draft('en-US').payload.message, 'Hello Acme Components,\n\nPlease confirm a delivery date for the remaining quantity on PO-001.\n\nThank you.')
    // The subject names the SKU when the line has one.
    assert.match(draft('en-US').payload.subject, /^PO-001: delivery date( for LDM-002)?$/)
    assert.equal(draft('zh-CN').payload.message, 'Acme Components，您好：\n\n请确认 PO-001 剩余数量的交货日期。\n\n谢谢。')
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
    assert.match(answer('prepare_action_draft', 'en-US', { entityType: 'item', entityId }).reviewCards[0].payload.message, /^- LDM-002: 40 pcs still to deliver/m)
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
