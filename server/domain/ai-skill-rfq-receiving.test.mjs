import test from 'node:test'
import assert from 'node:assert/strict'
import { aiSkillScenario } from './test-fixtures/ai-skill-scenario.mjs'
import { loadAiSkillContext } from './ai-skill-context.mjs'
import { readAiSkillFacts } from './ai-skill-readers.mjs'
import { answerAiSkill } from './ai-skills.mjs'

const CJK = /[㐀-鿿]/

async function answers(options) {
  const scenario = aiSkillScenario(options)
  const facts = await readAiSkillFacts(await loadAiSkillContext(scenario.ctx))
  const answer = (skillId, language, extra = {}) => answerAiSkill({ skillId, facts: skillId === 'capability_overview' ? null : facts, language, query: 'q', actor: scenario.actor, ...extra }).response
  return { scenario, facts, answer }
}

test('the readers keep every open RFQ without an award, with its quotes and invitations', async () => {
  const { facts } = await answers()
  // RFQ-002 is awarded, so only RFQ-001 is open; ready to award is unchanged.
  assert.deepEqual(facts.rfqs.open.map((row) => [row.id, row.responses, row.invited, row.awarded]), [['RFQ-001', 2, 2, false]])
  assert.deepEqual(facts.rfqs.readyToAward, [{ id: 'RFQ-001', title: 'Flow Controller RFQ', responses: 2, awarded: false, due: null }])
})

test('RFQ follow-ups list the quoted RFQs first and link to the RFQ', async () => {
  const { answer } = await answers()
  const english = answer('rfq_followups', 'en-US')
  assert.equal(english.conclusion.title, '1 open RFQ without an award')
  assert.equal(english.conclusion.summary, '1 has quotes and is waiting for a supplier to be selected.')
  assert.equal(english.conclusion.severity, 'warning')
  assert.deepEqual(english.keyEvidence.map((item) => [item.entityType, item.entityId, item.statusCode]), [['rfq', 'RFQ-001', 'rfq_ready_to_award']])
  assert.equal(english.keyEvidence[0].summary, '2 of 2 suppliers quoted')
  assert.deepEqual(english.navigationLinks.map((link) => [link.moduleId, link.entityId]), [['procurement:rfq', 'RFQ-001']])
  const chinese = answer('rfq_followups', 'zh-CN')
  assert.equal(chinese.conclusion.title, '1 张询价单尚未授标')
  assert.doesNotMatch(JSON.stringify(english), CJK)
})

test('RFQ follow-ups count RFQs without quotes and those past their due date', async () => {
  const { facts, scenario } = await answers()
  const open = [
    ...facts.rfqs.open,
    { id: 'RFQ-010', title: 'Gasket RFQ', responses: 0, awarded: false, invited: 3, due: '2026-09-20' },
    { id: 'RFQ-011', title: 'Cable RFQ', responses: 0, awarded: false, invited: null, due: '2026-10-15' },
  ]
  const response = answerAiSkill({ skillId: 'rfq_followups', facts: { ...facts, rfqs: { ...facts.rfqs, open } }, language: 'en-US', query: 'q', actor: scenario.actor }).response
  assert.equal(response.conclusion.title, '3 open RFQs without an award')
  assert.equal(response.conclusion.summary, '1 has quotes and is waiting for a supplier to be selected. 2 have no quote yet. 1 is past its quote due date.')
  // Quoted first, then past due, then the nearest due date.
  assert.deepEqual(response.keyEvidence.map((item) => [item.entityId, item.statusCode]), [['RFQ-001', 'rfq_ready_to_award'], ['RFQ-010', 'rfq_waiting_for_quotes'], ['RFQ-011', 'rfq_waiting_for_quotes']])
  assert.match(response.keyEvidence[1].summary, /^0 of 3 suppliers quoted · quote due date .+ has passed$/)
  assert.match(response.keyEvidence[2].summary, /^No quote yet · quotes due /)
})

test('receiving issues list rejected quantities on open orders and unposted receipts, once per receipt', async () => {
  const { facts, answer } = await answers()
  const english = answer('receiving_issues', 'en-US')
  const expected = new Set([...facts.receipts.rejected, ...facts.receipts.unposted].map((row) => row.id))
  assert.ok(expected.size > 0)
  assert.deepEqual(new Set(english.keyEvidence.map((item) => item.entityId)), expected)
  assert.equal(english.keyEvidence.length, expected.size)
  for (const item of english.keyEvidence) assert.ok(['grn_rejected_qty', 'grn_received_unposted'].includes(item.statusCode), item.statusCode)
  assert.match(english.conclusion.title, /^\d+ receipts? needs? attention$/)
  assert.doesNotMatch(JSON.stringify(english), CJK)
  for (const link of english.navigationLinks) assert.equal(link.moduleId, 'procurement:receiving')
})

test('receiving issues say so when there is nothing to handle', async () => {
  const { facts, scenario } = await answers()
  const response = answerAiSkill({ skillId: 'receiving_issues', facts: { ...facts, receipts: { rejected: [], unposted: [] } }, language: 'en-US', query: 'q', actor: scenario.actor }).response
  assert.equal(response.conclusion.title, 'No receipt needs attention')
  assert.equal(response.keyEvidence.length, 0)
})

test('a role that cannot read the source is told so, not given zero', async () => {
  const { facts, scenario } = await answers()
  for (const [skillId, source, title] of [['rfq_followups', 'rfqs', 'RFQs are hidden for your role'], ['receiving_issues', 'receipts', 'Receipts are hidden for your role']]) {
    const response = answerAiSkill({ skillId, facts: { ...facts, [source]: null }, language: 'en-US', query: 'q', actor: scenario.actor }).response
    assert.equal(response.conclusion.title, title)
    assert.equal(response.keyEvidence.length, 0)
  }
})

test('the capability answer names the topic a question was about and offers its skills first', async () => {
  const { answer } = await answers()
  const supplier = answer('capability_overview', 'en-US', { query: 'supplier test' })
  assert.match(supplier.conclusion.summary, /^I couldn't tell what you want to know about suppliers\./)
  // A supplier topic first offers the suppliers that need attention.
  assert.equal(supplier.followUpSuggestions[0].skillHint, 'supplier_attention')
  const chinese = answer('capability_overview', 'zh-CN', { query: '供应商测试' })
  assert.match(chinese.conclusion.summary, /^我没能确定你想了解供应商的哪方面。/)
  const rfq = answer('capability_overview', 'en-US', { query: 'rfq stuff' })
  assert.equal(rfq.followUpSuggestions[0].skillHint, 'rfq_followups')
  // No topic: the general answer, as before.
  const hello = answer('capability_overview', 'en-US', { query: 'hello' })
  assert.doesNotMatch(hello.conclusion.summary, /couldn't tell/)
  assert.deepEqual(hello.followUpSuggestions.map((item) => item.skillHint), ['today_priorities', 'highest_risk_items', 'records_needing_data', 'workspace_metrics'])
  // A refusal keeps its own order and wording.
  const refusal = answer('capability_overview', 'en-US', { query: 'pay the supplier', refusal: true })
  assert.doesNotMatch(refusal.conclusion.summary, /couldn't tell/)
  assert.equal(refusal.followUpSuggestions[0].skillHint, 'prepare_action_draft')
})
