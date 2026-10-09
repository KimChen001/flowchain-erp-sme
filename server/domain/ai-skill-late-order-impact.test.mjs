import test from 'node:test'
import assert from 'node:assert/strict'
import { aiSkillScenario } from './test-fixtures/ai-skill-scenario.mjs'
import { loadAiSkillContext } from './ai-skill-context.mjs'
import { readAiSkillFacts } from './ai-skill-readers.mjs'
import { presentLateOrderImpact, runLateOrderImpact } from './ai-skill-late-order-impact.mjs'
import { routeSkill } from './ai-skill-router.mjs'
import { aiSkillById, toolsFor } from './ai-skills.mjs'
import { handleAiRuntimeGatewayRoute } from '../routes/ai-runtime-gateway.routes.mjs'

// The scenario: LDM-001 has 28 available against SO-001 (Redwood Retail, 35
// open), with 70 coming on PO-001 (30 left, 4 days late) and PO-008 (40, 2 days
// late). Either late order alone leaves it covered; both together leave it 7
// short.
async function scenarioFacts(roleKey) {
  const scenario = aiSkillScenario(roleKey ? { roleKey } : {})
  return { scenario, facts: await readAiSkillFacts(await loadAiSkillContext(scenario.ctx)) }
}
const present = (result, facts, language = 'en-US') => presentLateOrderImpact(result, facts, { skill: aiSkillById('late_order_impact'), language, query: 'q' })

function harness() {
  const scenario = aiSkillScenario()
  const sent = []
  const ctx = {
    ...scenario.ctx,
    req: { method: 'POST', headers: {} }, res: {}, url: new URL('http://local/api/ai-runtime/respond'),
    db: { __dataMode: 'user', purchaseOrders: [], products: [], suppliers: [] },
    env: { FLOWCHAIN_PERSISTENCE_MODE: 'database' },
    send: (_res, status, payload) => sent.push({ status, payload }),
  }
  ctx.repositories = { ...ctx.repositories, auditLog: { mode: 'database', recordAuditEntry: async (entry) => entry } }
  return async (body) => { ctx.readBody = async () => body; assert.equal(await handleAiRuntimeGatewayRoute(ctx), true); return sent.at(-1).payload }
}

test('a delay and its consequences route to the late order impact; the purchase order page chip too', () => {
  const route = (message, focusTarget) => routeSkill({ message, focusTarget })?.skillId || null
  for (const message of ['What will a delay of PO-001 affect?', 'If PO-001 is late, which customers are hit?', 'PO-001 延误会影响哪些客户？', 'What do the late orders put at risk?', '逾期订单会影响哪些客户？', 'how does the delay impact our customers']) {
    assert.equal(route(message), 'late_order_impact', message)
  }
  assert.equal(route('What will a delay affect?', { entityType: 'purchase_order', entityId: 'PO-001' }), 'late_order_impact')
  assert.equal(route('Which items have the highest risk?'), 'highest_risk_items')
  assert.equal(route('Which purchase orders are late?'), 'purchase_orders')
})

test('the late orders are judged together, in the inventory page\'s terms', async () => {
  const { facts } = await scenarioFacts()
  const row = facts.inventory.rows.find((entry) => entry.sku === 'LDM-001')
  const result = runLateOrderImpact(facts, { route: {} })
  assert.equal(result.mode, 'late')
  const group = result.groups.find((entry) => entry.sku === 'LDM-001')
  assert.deepEqual(group.pos.map((po) => po.orderNumber), ['PO-001', 'PO-008'])
  // Available to promise as the inventory page states it, less the two late lines.
  assert.equal(group.atp, row.availableToPromise)
  assert.equal(group.lost, 70)
  assert.equal(group.without, row.availableToPromise - 70)
  assert.equal(group.added, 7)
  assert.deepEqual(group.orders.map((order) => [order.number, order.customer, order.open]), [['SO-001', 'Redwood Retail', 35]])
  const english = present(result, facts)
  assert.equal(english.conclusion.title, 'If the 2 late purchase orders do not arrive, LDM-001 falls 7 pcs short of open sales orders')
  assert.match(english.conclusion.summary, /1 open sales order waits on LDM-001: SO-001 for Redwood Retail\. 1 customer is affected: Redwood Retail\./)
  assert.deepEqual(english.figures.map((entry) => [entry.key, entry.value]), [['late_impact_short:LDM-001', 7]])
  assert.match(present(result, facts, 'zh-CN').conclusion.title, /^如果 2 张逾期采购订单不到货，LDM-001 将比未结销售订单少 7 pcs$/)
})

test('a named order is judged on its own, and says why it is still covered', async () => {
  const ask = harness()
  const answer = await ask({ message: 'What will a delay of PO-001 affect?', answerLanguage: 'en-US' })
  assert.equal(answer.intent, 'late_order_impact')
  assert.equal(answer.conclusion.title, 'If PO-001 is late, the open sales orders are still covered')
  assert.match(answer.conclusion.summary, /Without the 30 pcs on PO-001, LDM-001 still has 33 pcs available to promise/)
  // On the order's page, its chip.
  const chip = await ask({ message: 'What will a delay affect?', answerLanguage: 'en-US', focusTarget: { entityType: 'purchase_order', entityId: 'PO-002' } })
  assert.equal(chip.intent, 'late_order_impact')
  assert.match(chip.conclusion.title, /^If PO-002 is late/)
  // The late orders together through the gateway: the sales order is cited.
  const late = await ask({ message: 'What do the late orders put at risk?', answerLanguage: 'en-US' })
  assert.ok(late.keyEvidence.some((item) => item.entityType === 'sales_order' && item.entityId === 'SO-001'))
})

test('without sales orders the customers are not named; a line in another unit changes nothing', async () => {
  const { facts } = await scenarioFacts()
  const hidden = { ...facts, salesOrders: undefined }
  const result = runLateOrderImpact(hidden, { route: {} })
  assert.equal(result.salesVisible, false)
  const answer = present(result, hidden)
  assert.match(answer.conclusion.summary, /Sales orders are not visible with your access/)
  assert.ok(!answer.keyEvidence.some((item) => item.entityType === 'sales_order'))
  // A PO line the stock figures never counted (another unit): not counted as coming.
  const po = facts.purchaseOrders.index.find((row) => row.orderNumber === 'PO-001')
  const inventory = { ...facts.inventory, rows: facts.inventory.rows.map((row) => row.sku === 'LDM-001' ? { ...row, purchaseOrderIds: row.purchaseOrderIds.filter((id) => id !== po.id) } : row) }
  const other = runLateOrderImpact({ ...facts, inventory }, { route: { entities: { purchaseOrders: [po] } } })
  assert.equal(other.groups[0].counted, false)
  assert.equal(other.groups[0].added, 0)
  assert.equal(present(other, { ...facts, inventory }).keyEvidence[0].value, 'Not counted as coming')
})

test('the impact needs purchase orders and stock', async () => {
  const has = (roleKey) => toolsFor(aiSkillScenario({ roleKey }).actor).some((entry) => entry.id === 'late_order_impact')
  assert.equal(has('workspace-administrator'), true)
  assert.equal(has('finance-specialist'), false)
  const { facts } = await scenarioFacts()
  assert.match(present(runLateOrderImpact({ ...facts, inventory: null }, { route: {} }), facts).conclusion.title, /needs purchase orders and stock/)
})
