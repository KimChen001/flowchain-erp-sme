import test from 'node:test'
import assert from 'node:assert/strict'
import { aiSkillScenario } from './test-fixtures/ai-skill-scenario.mjs'
import { handleAiRuntimeGatewayRoute } from '../routes/ai-runtime-gateway.routes.mjs'
import { loadAiSkillContext } from './ai-skill-context.mjs'
import { readAiSkillFacts } from './ai-skill-readers.mjs'
import { routeSkill } from './ai-skill-router.mjs'
import { toolsFor } from './ai-skills.mjs'
import { validateAiSkillResponse } from './ai-skill-validator.mjs'
import { AI_COMPOUND_MAX_SECTIONS, aiCompoundAnswersEnabled, planAiCompoundAnswer, splitAiCompoundQuestion } from './ai-skill-compound.mjs'

const CJK = /[㐀-鿿]/
const TWO_PARTS = 'Which purchase orders are overdue, and what is available for LDM-001?'

function harness({ env = { FLOWCHAIN_PERSISTENCE_MODE: 'database' }, roleKey } = {}) {
  const scenario = aiSkillScenario(roleKey ? { roleKey } : {})
  const audits = []
  const sent = []
  const ctx = {
    ...scenario.ctx,
    req: { method: 'POST', headers: {} }, res: {}, url: new URL('http://local/api/ai-runtime/respond'),
    db: { __dataMode: 'user', purchaseOrders: [], products: [], suppliers: [] },
    env,
    send: (_res, status, payload) => sent.push({ status, payload }),
  }
  ctx.repositories = { ...ctx.repositories, auditLog: { mode: 'database', recordAuditEntry: async (entry) => { audits.push(entry); return entry } } }
  const ask = async (message, answerLanguage = 'en-US', extra = {}) => {
    ctx.readBody = async () => ({ message, answerLanguage, ...extra })
    await handleAiRuntimeGatewayRoute(ctx)
    return sent.at(-1).payload
  }
  return { ask, audits }
}

async function planner(roleKey) {
  const scenario = aiSkillScenario(roleKey ? { roleKey } : {})
  const facts = await readAiSkillFacts(await loadAiSkillContext(scenario.ctx))
  const allowed = new Set(toolsFor(scenario.actor).map((entry) => entry.id))
  return (message, extra = {}) => {
    const plan = planAiCompoundAnswer({ message, route: routeSkill({ message, ...extra }), facts, allowed, focusTarget: extra.focusTarget })
    return plan && { ...plan, keys: plan.sections.map((section) => `${section.route.skillId}:${section.route.mode || ''}`) }
  }
}

test('compound answers are on unless switched off', () => {
  assert.equal(aiCompoundAnswersEnabled({}), true)
  assert.equal(aiCompoundAnswersEnabled({ FLOWCHAIN_AI_COMPOUND_ANSWERS: 'true' }), true)
  assert.equal(aiCompoundAnswersEnabled({ FLOWCHAIN_AI_COMPOUND_ANSWERS: 'FALSE' }), false)
})

test('a question splits at clause ends and connectors, keeping its own words', () => {
  const parts = (message) => splitAiCompoundQuestion(message).map((part) => part.text)
  assert.deepEqual(parts(TWO_PARTS), ['Which purchase orders are overdue', 'what is available for LDM-001'])
  assert.deepEqual(parts('Which SKUs are short? Also, which invoices have variances?'), ['Which SKUs are short', 'which invoices have variances'])
  assert.deepEqual(parts('Which RFQs are open and which receipts need attention'), ['Which RFQs are open', 'which receipts need attention'])
  assert.deepEqual(parts('库存短缺的有哪些，同时待审批的采购订单有几张？'), ['库存短缺的有哪些', '待审批的采购订单有几张'])
  assert.deepEqual(parts('哪些采购订单逾期了？另外有几张发票有差异？'), ['哪些采购订单逾期了', '有几张发票有差异'])
  // No split inside a word, a decimal or an abbreviation.
  assert.deepEqual(parts('Show the brand list for Anderson Supply'), ['Show the brand list for Anderson Supply'])
  assert.deepEqual(parts('Is 1.5 pcs short, e.g. for LDM-001?'), ['Is 1.5 pcs short', 'e.g. for LDM-001'])
  assert.deepEqual(parts('Prepare a draft for jane.doe@example.com about PO-001'), ['Prepare a draft for jane.doe@example.com about PO-001'])
  assert.deepEqual(parts('LDM-001 还有多少库存？'), ['LDM-001 还有多少库存'])
  assert.deepEqual(parts('Which SKUs are short. Which RFQs are open.'), ['Which SKUs are short', 'Which RFQs are open'])
  const message = 'Which SKUs are short, and which invoices have variances?'
  for (const part of splitAiCompoundQuestion(message)) assert.equal(message.slice(part.start, part.end), part.text)
})

test('parts the rules route to different skills become sections, in the question order', async () => {
  const plan = await planner()
  assert.deepEqual(plan(TWO_PARTS).keys, ['purchase_orders:overdue', 'inventory_availability:single'])
  assert.deepEqual(plan(TWO_PARTS).sections.map((section) => section.question), ['Which purchase orders are overdue', 'what is available for LDM-001'])
  assert.deepEqual(plan('Which SKUs are short? Also, which invoices have variances?').keys, ['inventory_availability:short', 'invoice_summary:'])
  assert.deepEqual(plan('库存短缺的有哪些，同时待审批的采购订单有几张？').keys, ['inventory_availability:short', 'pending_approvals:all'])
  assert.deepEqual(plan('Which RFQs are still open and which receipts need attention?').keys, ['rfq_followups:', 'receiving_issues:'])
  // Same skill, different modes: the overdue list and one named order.
  assert.deepEqual(plan('Which purchase orders are overdue, and what is the status of PO-004?').keys, ['purchase_orders:overdue', 'purchase_orders:single'])
})

test('one-part questions, narrowing parts and parts for the same skill keep the one-skill answer', async () => {
  const plan = await planner()
  for (const message of [
    'Which purchase orders are overdue?',
    'Show open and overdue purchase orders',
    'Which POs are overdue and which are from Atlas?',
    'Which purchase orders are overdue and how much do they total?',
    'What is the status of PO-001 and PO-008?',
    'Which POs are overdue, and what is the weather?',
    'What is our committed spend, and how many POs are overdue?',
    'LDM-001 还有多少库存？',
    'Prepare an action draft for PO-001, and which SKUs are short?',
  ]) assert.equal(plan(message), null, message)
})

test('an instruction, a chip, a follow-up hint or the outside world keeps the one-skill path', async () => {
  const plan = await planner()
  assert.equal(plan('Which SKUs are short, and approve PO-001'), null)
  assert.equal(plan('Which SKUs are short? Then cancel the rest.'), null)
  assert.equal(plan(TWO_PARTS, { skillHint: 'purchase_orders' }), null)
  assert.equal(plan('What is the weather today, and what are the headlines?'), null)
})

test(`at most ${AI_COMPOUND_MAX_SECTIONS} sections; the rest are counted`, async () => {
  const plan = await planner()
  const four = plan('Which purchase orders are overdue, which SKUs are short, which invoices have variances and which RFQs are open?')
  assert.deepEqual(four.keys, ['purchase_orders:overdue', 'inventory_availability:short', 'invoice_summary:'])
  assert.equal(four.skipped, 1)
})

test('a compound answer carries a section per part, the sections\' own evidence and figures, and one audit row', async () => {
  const { ask, audits } = harness()
  const answer = await ask(TWO_PARTS)
  assert.equal(answer.intent, 'compound')
  assert.equal(answer.language, 'en-US')
  assert.equal(answer.answerSource, 'workspace_rules')
  assert.equal(answer.conclusion.title, 'Your question, answered part by part')
  assert.deepEqual(answer.sections.map((section) => [section.skillId, section.mode]), [['purchase_orders', 'overdue'], ['inventory_availability', 'single']])
  assert.equal(answer.conclusion.summary, `${answer.sections[0].title}. ${answer.sections[1].title}.`)
  assert.match(answer.sections[0].title, /^2 purchase orders are overdue/)
  assert.equal(answer.sections[1].title, 'LDM-001: 63 pcs available to promise')
  // The evidence is the sections' own, in section order, ranked again.
  const cited = answer.sections.flatMap((section) => section.evidenceIds)
  assert.deepEqual(answer.keyEvidence.map((item) => item.id), cited)
  assert.deepEqual(answer.keyEvidence.map((item) => item.rank), cited.map((_, index) => index + 1))
  assert.ok(answer.figures.some((row) => row.key === 'overdue_po_count' && row.value === 2))
  assert.ok(answer.figures.some((row) => row.key === 'atp:LDM-001' && row.value === 63))
  assert.equal(answer.metrics.overduePurchaseOrders, 2)
  assert.doesNotMatch(JSON.stringify(answer), CJK)
  assert.equal(audits.length, 1)
  assert.equal(audits[0].metadata.skillId, 'compound')
  assert.deepEqual(audits[0].metadata.agent, { phase: 'compound', status: 'served', sections: [{ skillId: 'purchase_orders', mode: 'overdue' }, { skillId: 'inventory_availability', mode: 'single' }], skippedParts: 0 })
  assert.deepEqual(audits[0].metadata.recordIds, answer.keyEvidence.map((item) => item.entityId))
  assert.doesNotMatch(JSON.stringify(audits[0]), /overdue, and what/)
})

test('a Chinese compound question gets a Chinese answer from the same skills', async () => {
  const { ask } = harness()
  const answer = await ask('库存短缺的有哪些，同时待审批的采购订单有几张？', 'en-US')
  assert.equal(answer.language, 'zh-CN')
  assert.equal(answer.conclusion.title, '按问题的各部分分别回答')
  assert.deepEqual(answer.sections.map((section) => section.skillId), ['inventory_availability', 'pending_approvals'])
  assert.equal(answer.conclusion.summary, answer.sections.map((section) => `${section.title}。`).join(''))
})

test('each part keeps its own permission answer: a hidden source is said, never counted', async () => {
  const { ask } = harness({ roleKey: 'procurement-specialist' })
  const answer = await ask('Which purchase orders are overdue, and which invoices have variances?')
  assert.deepEqual(answer.sections.map((section) => section.skillId), ['purchase_orders', 'invoice_summary'])
  assert.equal(answer.sections[1].title, 'Supplier invoices are hidden for your role')
  assert.ok(answer.dataLimitations.some((row) => row.code === 'hidden_by_permission'))
  assert.equal(answer.keyEvidence.some((item) => item.entityType === 'supplier_invoice'), false)
  assert.equal(answer.figures.some((row) => /invoice/.test(row.key)), false)
  const operations = await harness({ roleKey: 'operations-specialist' }).ask('Which purchase orders are overdue, and which invoices have variances?')
  assert.equal(operations.sections[0].title, 'Purchase orders are hidden for your role')
  assert.equal(operations.keyEvidence.some((item) => item.entityType === 'purchase_order'), false)
})

test('switched off, a compound question gets the one-skill answer as before', async () => {
  const off = await harness({ env: { FLOWCHAIN_PERSISTENCE_MODE: 'database', FLOWCHAIN_AI_COMPOUND_ANSWERS: 'false' } }).ask(TWO_PARTS)
  assert.notEqual(off.intent, 'compound')
  assert.equal(off.sections, undefined)
})

test('a compound answer passes the answer validator, which also reads the sections', async () => {
  const scenario = aiSkillScenario()
  const facts = await readAiSkillFacts(await loadAiSkillContext(scenario.ctx))
  const answer = await harness().ask(TWO_PARTS)
  assert.deepEqual(validateAiSkillResponse(answer, facts), { ok: true, errors: [] })
  const claimed = { ...answer, sections: [{ ...answer.sections[0], summary: 'I approved PO-001.' }, answer.sections[1]] }
  assert.match(validateAiSkillResponse(claimed, facts).errors.join(' '), /claims an action was taken at sections\.0\.summary/)
  const chinese = { ...answer, sections: [{ ...answer.sections[0], title: '逾期' }, answer.sections[1]] }
  assert.match(validateAiSkillResponse(chinese, facts).errors.join(' '), /Chinese text in an English answer at sections\.0\.title/)
})
