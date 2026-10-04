import test from 'node:test'
import assert from 'node:assert/strict'
import { aiSkillScenario } from './test-fixtures/ai-skill-scenario.mjs'
import { loadAiSkillContext } from './ai-skill-context.mjs'
import { readAiSkillFacts } from './ai-skill-readers.mjs'
import { answerAiSkill } from './ai-skills.mjs'
import { attachAiSkillNextSteps } from './ai-skill-next-steps.mjs'

const CJK = /[㐀-鿿]/

async function setup(options = {}) {
  const scenario = aiSkillScenario(options)
  // Acme's contact, as supplier master data stores it.
  Object.assign(scenario.data.suppliers.find((row) => row.id === 'SUP-001'), { email: 'orders@acme.example', contactName: 'Dana Park' })
  const facts = await readAiSkillFacts(await loadAiSkillContext(scenario.ctx))
  const answer = (skillId, language = 'en-US', extra = {}) => answerAiSkill({ skillId, facts, language, query: 'q', actor: scenario.actor, ...extra }).response
  return { facts, answer }
}

test('each line needing attention states its next step and offers its draft there, at most three per answer', async () => {
  const { answer } = await setup()
  const today = answer('today_priorities')
  assert.ok(today.keyEvidence.length > 3)
  for (const item of today.keyEvidence) assert.match(item.nextStep, /^Next: /, item.id)
  assert.ok(today.reviewCards.length > 0 && today.reviewCards.length <= 3)
  // One card per line, in the answer's own order, each review-only.
  const order = today.keyEvidence.map((item) => item.id)
  const lines = today.reviewCards.map((card) => card.lineEvidenceId)
  assert.deepEqual(lines, [...new Set(lines)])
  assert.deepEqual(lines, [...lines].sort((a, b) => order.indexOf(a) - order.indexOf(b)))
  for (const card of today.reviewCards) {
    assert.ok(order.includes(card.lineEvidenceId))
    assert.deepEqual([card.previewOnly, card.reviewRequired, card.requiresHumanReview], [true, true, true])
  }
})

test('a purchase order follow-up is addressed to the supplier contact in master data, and says so', async () => {
  const { answer } = await setup()
  const card = answer('today_priorities').reviewCards.find((entry) => entry.draftType === 'po_followup_draft' && entry.payload.supplierId === 'SUP-001')
  assert.ok(card)
  assert.equal(card.payload.to, 'orders@acme.example')
  assert.equal(card.payload.contactName, 'Dana Park')
  assert.match(card.payload.message, /^Hello Dana Park,\n\nPlease confirm/)
  assert.match(card.payload.message, /\n\nThank you\.$/)
  assert.deepEqual(card.prefill.to, { source: 'default', ref: 'supplier:email', value: 'orders@acme.example' })
  assert.equal(card.prefill.message.source, 'template')
  assert.equal(card.prefill.message.value, card.payload.message)
})

test('in Chinese the steps and drafts are in Chinese, for the same records and values', async () => {
  const { answer } = await setup()
  const english = answer('today_priorities')
  const chinese = answer('today_priorities', 'zh-CN')
  for (const item of chinese.keyEvidence) assert.match(item.nextStep, /^下一步：/)
  assert.deepEqual(chinese.reviewCards.map((card) => [card.draftType, card.targetEntityId, card.lineEvidenceId, card.payload.to]), english.reviewCards.map((card) => [card.draftType, card.targetEntityId, card.lineEvidenceId, card.payload.to]))
  for (const card of english.reviewCards) for (const value of [card.payload.subject, card.payload.message].filter(Boolean)) assert.doesNotMatch(value.replace(/箱/g, ''), CJK)
})

test('a supplier line takes the step and draft of its most urgent record', async () => {
  const { answer } = await setup()
  const suppliers = answer('supplier_attention')
  const acme = suppliers.keyEvidence.find((item) => item.entityType === 'supplier' && item.entityId === 'SUP-001')
  assert.ok(acme?.nextStep)
  const card = suppliers.reviewCards.find((entry) => entry.lineEvidenceId === acme.id)
  if (card) assert.equal(card.payload.supplierId, 'SUP-001')
})

test('a reader who may not prepare drafts sees the next steps, but no draft and no supplier contact', async () => {
  const { facts, answer } = await setup({ roleKey: 'read-only-viewer' })
  for (const supplier of facts.suppliers || []) assert.deepEqual(Object.keys(supplier).sort(), ['code', 'id', 'name'])
  const today = answer('today_priorities')
  assert.deepEqual(today.reviewCards, [])
  assert.ok(today.keyEvidence.some((item) => item.nextStep))
  assert.doesNotMatch(JSON.stringify(today), /orders@acme\.example|Dana Park/)
})

test('a line about a record with nothing to do, and the help answer, get no step and no draft', async () => {
  const { facts, answer } = await setup()
  // PO-003 is fully received: no signal, so its line is left as it is.
  const line = { id: 'purchase_order_closed:PO-003', entityType: 'purchase_order', entityId: 'PO-003', label: 'Closed' }
  const response = attachAiSkillNextSteps({ language: 'en-US', keyEvidence: [line], reviewCards: [] }, facts)
  assert.deepEqual(response.keyEvidence, [line])
  assert.deepEqual(response.reviewCards, [])
  const help = answerAiSkill({ skillId: 'capability_overview', facts: null, language: 'en-US', query: 'q' }).response
  assert.deepEqual(help.reviewCards, [])
  assert.ok(help.keyEvidence.every((item) => !item.nextStep))
  assert.ok(answer('workspace_metrics').reviewCards.length <= 3)
})
