import test from 'node:test'
import assert from 'node:assert/strict'
import { aiSkillScenario } from './test-fixtures/ai-skill-scenario.mjs'
import { loadAiSkillContext } from './ai-skill-context.mjs'
import { readAiSkillFacts } from './ai-skill-readers.mjs'
import { answerAiSkill } from './ai-skills.mjs'
import { aiSkillAsksPartialDelivery } from './ai-skill-router.mjs'
import { aiSkillDraftBasis, aiSkillDraftOrders } from './ai-skill-drafts.mjs'

// Follow-up drafts (AI plan PR-4): narrowed to a supplier the question names,
// one message per supplier, partial delivery asked about when the question
// does, the documents the answer cited shown with the draft, and a note when
// the supplier has no email on file.
async function setup() {
  const scenario = aiSkillScenario({ seedDay: '2026-09-29' })
  const facts = await readAiSkillFacts(await loadAiSkillContext(scenario.ctx))
  const supplier = (id) => facts.suppliers.find((row) => row.id === id)
  const drafts = (route = null, language = 'en-US') => answerAiSkill({ skillId: 'prepare_action_draft', facts, language, query: 'q', actor: scenario.actor, route: route ? { skillId: 'prepare_action_draft', ...route } : null }).response
  return { facts, supplier, drafts }
}

test('a supplier the question names keeps the drafts to that supplier, and says so', async () => {
  const { supplier, drafts } = await setup()
  const acme = drafts({ entities: { suppliers: [supplier('SUP-001')] } })
  assert.ok(acme.reviewCards.length > 0)
  assert.ok(acme.reviewCards.every((card) => card.payload.supplierId === 'SUP-001'))
  assert.equal(acme.conclusion.title, `${acme.reviewCards.length} drafts for Acme Components, ready for your review`)
  // Summit Packaging's only order is approved but not issued: nothing to draft.
  const summit = drafts({ entities: { suppliers: [supplier('SUP-002')] } })
  assert.deepEqual(summit.reviewCards, [])
  assert.equal(summit.conclusion.title, 'No draft is needed for Summit Packaging right now')
  assert.equal(drafts({ entities: { suppliers: [supplier('SUP-002')] } }, 'zh-CN').conclusion.title, 'Summit Packaging 当前不需要准备草稿')
})

test('a question about partial delivery asks whether what is ready can ship first', async () => {
  for (const question of ['prepare a message asking about partial delivery', 'Can they ship what is ready?', '准备一封询问部分交货的邮件', '能否分批发货']) assert.equal(aiSkillAsksPartialDelivery(question), true, question)
  for (const question of ['Which orders are partially received?', 'prepare a follow-up for Acme', '部分到货的订单有哪些？']) assert.equal(aiSkillAsksPartialDelivery(question), question === '部分到货的订单有哪些？', question)
  const { drafts } = await setup()
  const message = (route, language) => drafts(route, language).reviewCards.find((card) => card.draftType === 'po_followup_draft').payload.message
  assert.doesNotMatch(message(null, 'en-US'), /ship what is ready/)
  assert.match(message({ signals: { partial: true } }, 'en-US'), /\n\nIf the full quantity cannot ship by then, could you ship what is ready now and tell us when the rest will follow\?\n\nThank you\.$/)
  assert.match(message({ signals: { partial: true } }, 'zh-CN'), /能否先发已备好的部分/)
})

test('the documents an answer cited are shown with its supplier messages, never in them', () => {
  const card = (draftType) => ({ draftType, payload: { message: 'Hello' } })
  const response = {
    reviewCards: [card('po_followup_draft'), card('purchase_request_draft')],
    supplementalKnowledge: { rag: { citations: [
      { id: 'c-title', title: 'purchasing-policy', heading: 'Example Purchasing Follow-up Policy' },
      { id: 'c-overdue', title: 'purchasing-policy', heading: 'Example Purchasing Follow-up Policy › Overdue goods' },
      { id: 'c-follow', title: 'purchasing-policy', heading: 'Example Purchasing Follow-up Policy › Follow-up and escalation' },
    ] } },
  }
  const withBasis = aiSkillDraftBasis(response)
  // A section within the document first, at most two.
  assert.deepEqual(withBasis.reviewCards[0].payload.basis, [{ title: 'purchasing-policy', section: 'Overdue goods', citationId: 'c-overdue' }, { title: 'purchasing-policy', section: 'Follow-up and escalation', citationId: 'c-follow' }])
  assert.equal(withBasis.reviewCards[0].payload.message, 'Hello')
  assert.equal(withBasis.reviewCards[1].payload.basis, undefined)
  // Without citations, the answer is returned as it is.
  const plain = { reviewCards: response.reviewCards }
  assert.equal(aiSkillDraftBasis(plain), plain)
})

test('a follow-up card names the orders its message covers', () => {
  assert.deepEqual(aiSkillDraftOrders({ draftType: 'po_followup_draft', payload: { poId: 'PO-1', poIds: ['PO-1', 'PO-2'] } }), ['PO-1', 'PO-2'])
  assert.deepEqual(aiSkillDraftOrders({ draftType: 'po_followup_draft', payload: { poId: 'PO-1' } }), ['PO-1'])
  assert.deepEqual(aiSkillDraftOrders({ draftType: 'supplier_followup_draft', payload: { poId: 'PO-1' } }), [])
})
