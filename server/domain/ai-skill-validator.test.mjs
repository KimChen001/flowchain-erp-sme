import test from 'node:test'
import assert from 'node:assert/strict'
import { aiSkillScenario } from './test-fixtures/ai-skill-scenario.mjs'
import { loadAiSkillContext } from './ai-skill-context.mjs'
import { readAiSkillFacts } from './ai-skill-readers.mjs'
import { answerAiSkill } from './ai-skills.mjs'
import { assertValidAiSkillResponse, validateAiSkillResponse } from './ai-skill-validator.mjs'

async function base() {
  const scenario = aiSkillScenario()
  const facts = await readAiSkillFacts(await loadAiSkillContext(scenario.ctx))
  const response = answerAiSkill({ skillId: 'prepare_action_draft', facts, language: 'en-US', query: 'q' }).response
  return { facts, response }
}
const withSummary = (response, summary) => ({ ...response, conclusion: { ...response.conclusion, summary } })

test('the validator rejects claims that the assistant acted', async () => {
  const { facts, response } = await base()
  assert.equal(validateAiSkillResponse(response, facts).ok, true)
  for (const claim of ['The PO was sent to Acme.', 'We have approved the invoice.', 'I paid the supplier.', 'The order has been placed.']) {
    assert.equal(validateAiSkillResponse(withSummary(response, claim), facts).ok, false, claim)
  }
  const chinese = { ...response, language: 'zh-CN' }
  for (const claim of ['发票已付款。', '采购订单已发送给供应商。', '已批准。', '已下单。']) {
    assert.equal(validateAiSkillResponse(withSummary(chinese, claim), facts).ok, false, claim)
  }
  // Word-bounded: ordinary business words are not claims.
  for (const phrase of ['The delivered quantity is 20.', 'Supplier feedback is pending.', 'Working capital is tied up.', 'Evaluation of the quote.', 'Check the production schedule.', 'Review each draft before you send it.']) {
    assert.equal(validateAiSkillResponse(withSummary(response, phrase), facts).ok, true, phrase)
  }
})

// The app's status words (owner's terminology, 2026-11-05) stand in an
// evidence status field, and in the label that repeats it, as a status; the
// same word in a sentence is still a claim.
test('a status word in an evidence status field is a status, in a sentence a claim', async () => {
  const { facts, response } = await base()
  const chinese = { ...response, language: 'zh-CN' }
  const item = chinese.keyEvidence[0]
  for (const status of ['已下达', '已批准，待下达', '已取消']) {
    const withStatus = { ...chinese, keyEvidence: [{ ...item, label: status, status }, ...chinese.keyEvidence.slice(1)] }
    assert.equal(validateAiSkillResponse(withStatus, facts).ok, true, status)
    assert.equal(validateAiSkillResponse(withSummary(chinese, `采购订单${status}。`), facts).ok, false, status)
  }
  const claim = { ...chinese, keyEvidence: [{ ...item, status: '我已下单' }, ...chinese.keyEvidence.slice(1)] }
  assert.equal(validateAiSkillResponse(claim, facts).ok, false)
})

test('the validator rejects ids the readers did not return and cards that are not review-only', async () => {
  const { facts, response } = await base()
  const invented = { ...response, keyEvidence: [...response.keyEvidence, { ...response.keyEvidence[0], entityId: 'PO-999' }] }
  assert.deepEqual(validateAiSkillResponse(invented, facts).errors, ['evidence id not read: PO-999'])
  const executable = { ...response, reviewCards: [{ ...response.reviewCards[0], previewOnly: false }] }
  assert.match(validateAiSkillResponse(executable, facts).errors[0], /not review-only/)
  const poDraft = { ...response, reviewCards: [{ ...response.reviewCards[0], draftType: 'purchase_order_draft' }] }
  assert.match(validateAiSkillResponse(poDraft, facts).errors[0], /unsupported draft type/)
  const away = { ...response, navigationLinks: [{ ...response.navigationLinks[0], returnTo: 'home' }] }
  assert.match(validateAiSkillResponse(away, facts).errors[0], /does not return to the assistant/)
  assert.throws(() => assertValidAiSkillResponse(invented, facts), (error) => error.code === 'AI_SKILL_ANSWER_INVALID' && error.status === 503)
})

test('an English answer may show stored Chinese names but no Chinese copy', async () => {
  const { facts, response } = await base()
  // A supplier whose stored name is Chinese.
  facts.purchaseOrders.rows[0].supplier = '深圳精密部件'
  const named = withSummary(response, 'Follow up with 深圳精密部件 on PO-001.')
  assert.equal(validateAiSkillResponse(named, facts).ok, true)
  const leaked = withSummary(response, 'Follow up with 深圳精密部件 on PO-001. 请复核。')
  assert.deepEqual(validateAiSkillResponse(leaked, facts).errors, ['Chinese text in an English answer at conclusion.summary'])
  // The same Chinese copy is fine in a Chinese answer.
  assert.equal(validateAiSkillResponse({ ...leaked, language: 'zh-CN' }, facts).ok, true)
})
