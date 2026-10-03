import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveAiSkillFollowUp } from './ai-skill-follow-up.mjs'
import { routeSkill } from './ai-skill-router.mjs'
import { handleAiRuntimeGatewayRoute } from '../routes/ai-runtime-gateway.routes.mjs'
import { aiSkillScenario } from './test-fixtures/ai-skill-scenario.mjs'

// The previous answer as the panel sends it back (Panel.tsx
// buildSafeConversationContext): its skill, its question and its records, in
// order, with the panel's record type names.
const PANEL_TYPES = { purchase_order: 'PO', item: 'SKU', supplier: 'Supplier', supplier_invoice: 'Invoice', receiving_doc: 'GRN', rfq: 'RFQ', purchase_request: 'PR' }
const contextOf = (response) => ({
  previousIntent: response.intent,
  previousQuestion: response.query,
  previousEvidenceRefs: response.keyEvidence.slice(0, 8).map((item) => ({ id: item.id, label: item.label, entityType: PANEL_TYPES[item.entityType] || 'Unknown', entityId: item.entityId, entityLabel: item.entityLabel })),
})
const risk = { previousIntent: 'highest_risk_items', previousEvidenceRefs: [{ entityType: 'PO', entityId: 'PO-020' }, { entityType: 'Invoice', entityId: 'INV-001' }, { entityType: 'SKU', entityId: 'LDM-002' }] }
const resolve = (message, conversationContext = risk) => resolveAiSkillFollowUp({ message, route: routeSkill({ message }), conversationContext })

test('a short follow-up is read with the previous answer', () => {
  for (const message of ['Why?', 'why is that?', '为什么？', '怎么回事']) {
    assert.deepEqual(resolve(message), { kind: 'why', message: 'Why does this record need attention?', skillHint: 'today_priorities', focusTarget: { entityType: 'purchase_order', entityId: 'PO-020' } }, message)
  }
  // The first record's own card; an invoice has none, so why it is listed.
  assert.deepEqual(resolve('the first one'), { kind: 'ordinal', message: 'What is the status of this record?', focusTarget: { entityType: 'purchase_order', entityId: 'PO-020' } })
  assert.deepEqual(resolve('第二个呢？').focusTarget, { entityType: 'supplier_invoice', entityId: 'INV-001' })
  assert.equal(resolve('第二个呢？').skillHint, 'today_priorities')
  assert.deepEqual(resolve('第三个').focusTarget, { entityType: 'item', entityId: 'LDM-002' })
  assert.equal(resolve('the fifth one'), null)
  // Another record or name for the previous skill.
  assert.deepEqual(resolve('What about PO-012?'), { kind: 'about', message: 'What is the risk on PO-012?' })
  assert.deepEqual(resolve('那 PO-012 呢？'), { kind: 'about', message: 'What is the risk on PO-012?' })
  assert.deepEqual(resolve('PO-012?'), { kind: 'about', message: 'What is the risk on PO-012?' })
  assert.deepEqual(resolve('And Acme Components?'), { kind: 'about', message: 'What is the risk on Acme Components?' })
  // A topic on its own asks that topic's question, unless a rule already
  // answers it ("What about RFQs?" is an RFQ question as it stands).
  assert.deepEqual(resolve('那发票呢？'), { kind: 'topic', message: 'What is the status of the supplier invoices?' })
  assert.equal(resolve('What about RFQs?'), null)
  assert.equal(routeSkill({ message: 'What about RFQs?' }).skillId, 'rfq_followups')
  assert.deepEqual(resolve('只看逾期的', { previousIntent: 'purchase_orders' }), { kind: 'overdue_only', message: 'Which purchase orders are overdue?' })
})

test('only a short question no rule answers is a follow-up', () => {
  // Answered on its own: a rule, a refusal, a greeting.
  for (const message of ['Which items have the highest risk?', '那库存呢？', 'Approve PO-012', 'test', 'What about the weather?']) assert.equal(resolve(message), null, message)
  assert.equal(resolveAiSkillFollowUp({ message: 'What about PO-012?', route: routeSkill({ message: 'What about PO-012?' }), conversationContext: null }), null)
  // No previous answer, or one with no records: "why" has nothing to explain.
  assert.equal(resolve('Why?', {}), null)
  assert.equal(resolve('Why?', { previousIntent: 'capability_overview' }), null)
  // Only real record types and id-shaped ids are taken from the panel.
  assert.equal(resolve('Why?', { previousEvidenceRefs: [{ entityType: 'Unknown', entityId: 'PO-1' }, { entityType: 'PO', entityId: 'x y' }] }), null)
  assert.equal(resolve('Why?', { previousIntent: 'drop_tables', previousEvidenceRefs: 'PO-1' }), null)
  // A long message is a question of its own.
  assert.equal(resolve(`What about ${'the supplier we talked about earlier '.repeat(3)}?`), null)
})

// A production-shaped route context, as in ai-skill-gateway.routes.test.mjs.
function harness() {
  const scenario = aiSkillScenario()
  const sent = []
  const audits = []
  const ctx = {
    ...scenario.ctx,
    req: { method: 'POST', headers: {} }, res: {}, url: new URL('http://local/api/ai-runtime/respond'),
    db: { __dataMode: 'user', purchaseOrders: [], products: [], suppliers: [] },
    env: { FLOWCHAIN_PERSISTENCE_MODE: 'database' },
    send: (_res, status, payload) => sent.push({ status, payload }),
  }
  ctx.repositories = { ...ctx.repositories, auditLog: { mode: 'database', recordAuditEntry: async (entry) => { audits.push(entry); return entry } } }
  const ask = async (body) => {
    ctx.readBody = async () => body
    assert.equal(await handleAiRuntimeGatewayRoute(ctx), true)
    return sent.at(-1).payload
  }
  return { ask, audits }
}

test('follow-ups answer through the usual skills, in the language they are asked in', async () => {
  const { ask, audits } = harness()
  const first = await ask({ message: 'Which items have the highest risk?', answerLanguage: 'en-US' })
  assert.equal(first.intent, 'highest_risk_items')
  const top = first.keyEvidence[0].entityId
  const why = await ask({ message: '为什么？', answerLanguage: 'en-US', conversationContext: contextOf(first) })
  assert.equal(why.intent, 'today_priorities')
  assert.equal(why.language, 'zh-CN')
  assert.equal(why.conclusion.title, `${top} 需要关注的原因`)
  assert.deepEqual(why.followUp, { kind: 'why' })
  assert.equal(audits.at(-1).metadata.followUp, 'why')
  // Another order for the same skill: its risk, not the page's or the list's.
  const other = await ask({ message: 'What about PO-008?', answerLanguage: 'en-US', conversationContext: contextOf(first) })
  assert.equal(other.intent, 'highest_risk_items')
  assert.match(other.conclusion.title, /^(Risk on PO-008|No risk found for PO-008)/)
  // The second record of a purchase order list: that order's card.
  const orders = await ask({ message: 'Which purchase orders are late?', answerLanguage: 'en-US' })
  const second = await ask({ message: 'the second one', answerLanguage: 'en-US', conversationContext: contextOf(orders) })
  assert.equal(second.intent, 'purchase_orders')
  assert.equal(second.keyEvidence[0].entityId, orders.keyEvidence[1].entityId)
  // Without the previous answer the same words get the help answer.
  assert.equal((await ask({ message: 'Why?', answerLanguage: 'en-US' })).intent, 'capability_overview')
})
