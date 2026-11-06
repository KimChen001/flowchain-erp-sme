import test from 'node:test'
import assert from 'node:assert/strict'
import { aiSkillScenario, aiSkillSeedDay } from './test-fixtures/ai-skill-scenario.mjs'
import { loadAiSkillContext } from './ai-skill-context.mjs'
import { readAiSkillFacts } from './ai-skill-readers.mjs'
import { answerAiSkill } from './ai-skills.mjs'
import { aiSkillPurchaseOrderNotSent, buildAiSkillSignals } from './ai-skill-signals.mjs'
import { runPrepareActionDraft } from './ai-skill-prepare-action-draft.mjs'
import { aiSkillDraftOrders } from './ai-skill-drafts.mjs'

// Decision V5 (2026-10-04): only an order issued to its supplier is chased.
// An approved order that was never issued still counts as open, and past its
// date as overdue, as in the open purchase orders report; the assistant says
// it is not yet issued and drafts no supplier follow-up for it.

const SEED_DAY = '2026-09-29'
const { day, at } = aiSkillSeedDay(SEED_DAY)

// PO-009 (Summit Packaging) is approved but not issued; here it is 3 days past its promised date.
async function withUnissuedOverdue() {
  const scenario = aiSkillScenario({ seedDay: SEED_DAY })
  const po = scenario.data.purchaseOrders.find((row) => row.id === 'PO-009')
  po.expectedDate = at(-3)
  po.lines[0].promisedDate = day(-3)
  const facts = await readAiSkillFacts(await loadAiSkillContext(scenario.ctx))
  const answer = (skillId, language = 'en-US', focus = null, route = null) => answerAiSkill({ skillId, facts, language, query: 'q', actor: scenario.actor, focus, route }).response
  return { facts, answer }
}

test('approved means not yet issued; issued and partially received orders were sent', () => {
  assert.equal(aiSkillPurchaseOrderNotSent({ status: 'approved' }), true)
  for (const status of ['issued', 'partially_received', 'fully_received', 'pending_approval', 'draft', '', undefined]) assert.equal(aiSkillPurchaseOrderNotSent({ status }), false, String(status))
})

test('an unissued order stays overdue as in the report, but its reason says to send it first', async () => {
  const { facts, answer } = await withUnissuedOverdue()
  // The report's figures are unchanged: PO-009 counts as overdue.
  const row = facts.purchaseOrders.rows.find((entry) => entry.id === 'PO-009')
  assert.equal(row.overdueDays, 3)
  const overdue = buildAiSkillSignals(facts).filter((signal) => signal.type === 'po_overdue')
  assert.deepEqual(overdue.map((signal) => [signal.entityId, signal.data.notSent]).sort(), [['PO-001', false], ['PO-008', false], ['PO-009', true]])

  const priorities = answer('today_priorities')
  const line = priorities.keyEvidence.find((entry) => entry.entityId === 'PO-009')
  assert.match(line.summary, /not yet issued to Summit Packaging\. Send the order before asking about delivery\./)
  assert.match(answer('today_priorities', 'zh-CN').keyEvidence.find((entry) => entry.entityId === 'PO-009').summary, /尚未发给 Summit Packaging。请先发出订单，再询问交货。/)

  // The overdue list names it as not yet issued; the count matches the report.
  const list = answer('purchase_orders', 'en-US', null)
  assert.match(list.conclusion.summary, /PO-009 \(3 days, not yet issued\)/)
  assert.match(list.conclusion.summary, /PO-001 \(4 days\)/)
})

test('no supplier follow-up is drafted for an unissued order; issued orders keep theirs', async () => {
  const { answer } = await withUnissuedOverdue()
  const drafts = answer('prepare_action_draft').reviewCards
  assert.ok(drafts.length > 0)
  assert.ok(!drafts.some((card) => card.targetEntityId === 'PO-009' || aiSkillDraftOrders(card).includes('PO-009')), 'PO-009 gets no draft')
  // Acme's issued, overdue orders keep theirs: one message about both.
  assert.ok(drafts.some((card) => card.draftType === 'po_followup_draft' && aiSkillDraftOrders(card).some((id) => ['PO-001', 'PO-008'].includes(id))))
})

test('asked to draft for the unissued order, the answer says it has not been issued yet', async () => {
  const { answer } = await withUnissuedOverdue()
  const focus = { entityType: 'purchase_order', entityId: 'PO-009' }
  const english = answer('prepare_action_draft', 'en-US', focus)
  assert.deepEqual(english.reviewCards, [])
  assert.equal(english.conclusion.title, 'PO-009 has not been issued to the supplier yet')
  assert.match(english.conclusion.summary, /nothing to chase until the order is sent/)
  const chinese = answer('prepare_action_draft', 'zh-CN', focus)
  assert.equal(chinese.conclusion.title, 'PO-009 尚未发给供应商')
  // The single-order answer says the same.
  const { facts } = await withUnissuedOverdue()
  const single = { mode: 'single', entities: { purchaseOrders: [facts.purchaseOrders.index.find((row) => row.id === 'PO-009')] } }
  assert.match(answer('purchase_orders', 'en-US', null, single).conclusion.summary, /has not been issued to the supplier yet, so send it before asking about delivery/)
  assert.match(answer('purchase_orders', 'zh-CN', null, single).conclusion.summary, /订单尚未发给供应商，请先发出，再询问交货。/)
})

test('a shortage only an unissued order covers links to that order: no follow-up and no second request', () => {
  const facts = {
    asOf: day(0),
    visibility: { canDraft: true },
    purchaseOrders: { rows: [{ id: 'PO-X', orderNumber: 'PO-X', supplierId: 'S', supplier: 'Supplier', status: 'approved', dueDate: day(5), overdueDays: 0, remaining: 30, unit: 'pcs', sku: 'SKU-1', openLines: [] }] },
    inventory: { rows: [{ itemId: 'ITEM-1', sku: 'SKU-1', available: 0, openSalesDemand: 20, shortage: 20, incomingApprovedPo: 30, stockStatus: 'out_of_stock', safetyStock: 10, reorderPoint: 10, purchaseOrderIds: ['PO-X'] }] },
    purchaseRequests: { awaitingApproval: [] },
  }
  const result = runPrepareActionDraft(facts)
  assert.deepEqual(result.drafts.map((candidate) => candidate.kind), [])
  assert.ok(result.links.some((item) => item.entityId === 'ITEM-1'))
  // Issued and not late yet, it is on order: still nothing to chase (owner
  // decision, 2026-10-06), and still no second request.
  facts.purchaseOrders.rows[0].status = 'issued'
  assert.deepEqual(runPrepareActionDraft(facts).drafts, [])
  assert.ok(runPrepareActionDraft(facts).links.some((item) => item.entityId === 'ITEM-1'))
  // Once overdue, the same shortage gets the supplier follow-up.
  Object.assign(facts.purchaseOrders.rows[0], { dueDate: day(-3), overdueDays: 3 })
  assert.deepEqual(runPrepareActionDraft(facts).drafts.map((candidate) => [candidate.kind, candidate.po?.id]), [['po_followup_draft', 'PO-X']])
})

test("an answer line about an unissued order says to send it, and offers no follow-up draft", async () => {
  const { answer } = await withUnissuedOverdue()
  for (const [language, pattern] of [['en-US', /send PO-009 to the supplier; it has not been issued yet/], ['zh-CN', /把 PO-009 发给供应商，它尚未发出/]]) {
    const priorities = answer('today_priorities', language)
    const line = priorities.keyEvidence.find((entry) => entry.entityId === 'PO-009')
    assert.match(line.nextStep, pattern, language)
    assert.equal(priorities.reviewCards.some((card) => card.targetEntityId === 'PO-009'), false, language)
  }
  // Issued orders keep their line drafts.
  assert.ok(answer('today_priorities').reviewCards.some((card) => card.draftType === 'po_followup_draft' && card.targetEntityId !== 'PO-009'))
})
