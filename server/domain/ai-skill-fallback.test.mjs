import test from 'node:test'
import assert from 'node:assert/strict'
import { aiSkillScenario } from './test-fixtures/ai-skill-scenario.mjs'
import { loadAiSkillContext } from './ai-skill-context.mjs'
import { readAiSkillFacts } from './ai-skill-readers.mjs'
import { answerAiSkill } from './ai-skills.mjs'
import { routeSkill } from './ai-skill-router.mjs'
import { runAiSkillRuntime } from './ai-skill-runtime.mjs'

// What the assistant says when no skill answers the question, from the local
// walkthrough on 2026-10-09: "我压力大" and "how about the contract data?" got
// the help card, labelled "Answered from your workspace data", every time.

async function ask(message, language = 'en-US') {
  const scenario = aiSkillScenario()
  return runAiSkillRuntime({ ...scenario.ctx, env: {} }, { message, answerLanguage: language })
}

test('a user under pressure gets the first three of today\'s priorities, not the help card', async () => {
  for (const message of ['我压力大', '我压力太大怎么办', 'i had the big pressure', "I'm so stressed", 'feeling overwhelmed today', '事情太多忙不过来']) {
    const route = routeSkill({ message })
    assert.equal(route.skillId, 'today_priorities', message)
    assert.equal(route.signals.calm, true, message)
  }
  // Pressure on prices, or a question another rule answers, is not about the user.
  assert.notEqual(routeSkill({ message: 'Are suppliers putting pressure on our prices?' })?.signals?.calm, true)
  assert.equal(routeSkill({ message: "I'm stressed about our overdue purchase orders" }).skillId, 'purchase_orders')

  const english = await ask('i had the big pressure')
  assert.equal(english.intent, 'today_priorities')
  assert.equal(english.keyEvidence.length, 3)
  assert.equal(english.conclusion.title, "That's a lot at once. Start with these 3")
  assert.equal(english.conclusion.summary, "These are the earliest of 8 open items. Take them one at a time; the rest stay on Today's priorities.")
  const chinese = await ask('我压力大', 'zh-CN')
  assert.equal(chinese.conclusion.title, '事情确实不少，先从这 3 件开始')
  assert.match(chinese.conclusion.summary, /这是 8 项待办里最早的几项/)
  // The same three records as the first three of today's priorities.
  const today = await ask("What should I handle first today?")
  assert.deepEqual(english.keyEvidence.map((item) => item.entityId), today.keyEvidence.slice(0, 3).map((item) => item.entityId))
})

test('a question about contracts says they cannot be read yet and links to Contracts', async () => {
  for (const message of ['how about the contract data?', '合同情况怎么样', 'Show me the supplier agreements']) {
    assert.deepEqual(routeSkill({ message }), { capability: true, contracts: true }, message)
  }
  const english = await ask('how about the contract data?')
  assert.equal(english.intent, 'capability_overview')
  assert.equal(english.conclusion.title, "I can't read contracts yet")
  assert.match(english.conclusion.summary, /^Contracts are in their own module for now/)
  assert.deepEqual(english.navigationLinks.map((link) => [link.label, link.moduleId]), [['Open Contracts', 'contracts:list']])
  assert.equal(english.answerSourceLabel, 'No workspace data was read for this answer')
  const chinese = await ask('合同情况怎么样', 'zh-CN')
  assert.equal(chinese.conclusion.title, '我暂时还不能读取合同')
  assert.equal(chinese.navigationLinks[0].label, '打开合同')
})

test('the help answer says no workspace data was read, and an unanswered question says so in its title', async () => {
  const unmatched = await ask('what is the meaning of the blue widget')
  assert.equal(unmatched.intent, 'capability_overview')
  assert.equal(unmatched.conclusion.title, "I can't answer that from your workspace data yet")
  assert.equal(unmatched.answerSourceLabel, 'No workspace data was read for this answer')
  // A greeting and the help chip keep the plain title.
  for (const message of ['hello']) {
    const greeting = await ask(message)
    assert.equal(greeting.conclusion.title, 'Here is what I can help with', message)
    assert.equal(greeting.answerSourceLabel, 'No workspace data was read for this answer', message)
  }
  const scenario = aiSkillScenario()
  const facts = await readAiSkillFacts(await loadAiSkillContext(scenario.ctx))
  const chip = answerAiSkill({ skillId: 'capability_overview', facts: null, language: 'zh-CN', query: '你能做什么', actor: scenario.actor, route: { capability: true } }).response
  assert.equal(chip.conclusion.title, '我可以帮你做这些')
  assert.equal(chip.answerSourceLabel, '本次回答没有读取工作区数据')
  // A data answer keeps its label.
  const today = answerAiSkill({ skillId: 'today_priorities', facts, language: 'en-US', query: 'q', actor: scenario.actor }).response
  assert.equal(today.answerSourceLabel, 'Answered from your workspace data')
})

// Questions the rules answer that the 2026-11-05 walkthrough got the help
// card for: open orders, documents waiting for approval, an item running low,
// a need with a quantity, sales orders at risk, and a thank-you.
test('answerable questions reach their skill, not the help card', () => {
  const skillOf = (message) => routeSkill({ message })?.skillId || null
  for (const message of ['What purchase orders are open?', 'Which POs are still open?', '有哪些未完成的采购订单？', '未结的采购订单有哪些？']) assert.equal(skillOf(message), 'workspace_metrics', message)
  for (const message of ['有哪些待审批的单据？', 'What approvals are pending?', 'Which documents are waiting for approval?']) assert.equal(skillOf(message), 'pending_approvals', message)
  for (const message of ['Is the LDM-002 Temperature Sensor running low?', 'Are we running low on anything?', 'LDM-002 快没货了吗？']) assert.equal(skillOf(message), 'inventory_availability', message)
  for (const message of ['Which sales orders are at risk of late delivery?', '哪些销售订单有交付风险？', 'Which customer orders are at risk?']) assert.equal(skillOf(message), 'late_order_impact', message)
  for (const [message, quantity] of [['I need 50 temperature sensors', 50], ['We need 200 more boxes of LDM-003', 200], ['我需要 50 个温度传感器', 50]]) {
    const route = routeSkill({ message })
    assert.equal(route.skillId, 'prepare_action_draft', message)
    assert.equal(route.mode, 'order', message)
    assert.equal(route.order.quantity, quantity, message)
  }
  // A need that is not an order: a time, quotes, suppliers.
  for (const message of ['I need 5 days to decide', 'We need 3 quotes for the RFQ', 'I need 2 suppliers for this item']) assert.notEqual(routeSkill({ message })?.mode, 'order', message)
  for (const message of ['Thanks!', 'thank you so much', 'Great, thanks', '谢谢', '好的，谢谢你']) assert.deepEqual(routeSkill({ message }), { capability: true, thanks: true }, message)
  // A thank-you with a question is the question.
  assert.equal(skillOf('Thanks, which purchase orders are overdue?'), 'purchase_orders')
  // The weather and its temperature are still outside the workspace; a temperature sensor is not.
  for (const message of ["What's the weather in Boston tomorrow?", "What's the temperature in Boston?"]) assert.equal(routeSkill({ message }).outOfDomain, true, message)
  assert.notEqual(routeSkill({ message: 'How many temperature sensors are on hand?' }).outOfDomain, true)
})

test('a thank-you gets a warm reply, and open sales orders are listed with customer, promised date and status', async () => {
  const english = await ask('Thanks!')
  assert.equal(english.intent, 'capability_overview')
  assert.equal(english.conclusion.title, "You're welcome. Anything else?")
  assert.equal(english.conclusion.summary, '')
  assert.ok(english.followUpSuggestions.length > 0)
  const chinese = await ask('谢谢', 'zh-CN')
  assert.equal(chinese.conclusion.title, '不客气，还有什么需要？')
  // Open sales orders: the orders the stock is set against, each with its
  // customer, promised date, status and what is not yet shipped or reserved.
  const sales = await ask('Show open sales orders')
  assert.equal(sales.intent, 'inventory_availability')
  assert.equal(sales.conclusion.title, '1 open sales order')
  assert.deepEqual(sales.keyEvidence.map((item) => [item.entityLabel, item.entityType, item.status]), [['SO-001', 'sales_order', 'Not shipped yet']])
  assert.equal(sales.keyEvidence[0].summary, 'Redwood Retail, no promised date: 35 pcs of LDM-001 not yet shipped or reserved.')
  assert.deepEqual(sales.figures.map((entry) => [entry.key, entry.value]), [['open_sales_order_count', 1]])
  assert.equal(sales.followUpSuggestions[0].label, 'Customer orders at risk')
  const zhSales = await ask('有哪些未结的销售订单？', 'zh-CN')
  assert.equal(zhSales.conclusion.title, '未结销售订单 1 张')
  assert.equal(zhSales.keyEvidence[0].summary, 'Redwood Retail，没有承诺日期：LDM-001 还有 35 件未发货或未预留。')
  // Creating a sales order, or short stock against them, is not this list.
  assert.equal(routeSkill({ message: 'Create a sales order for Redwood Retail' }).skillId, null)
  assert.notEqual(routeSkill({ message: 'Which SKUs are short against open sales orders?' }).signals?.salesOrders, true)
  // Sales orders at risk: the customer orders waiting on late purchase orders.
  const risk = await ask('Which sales orders are at risk of late delivery?')
  assert.equal(risk.intent, 'late_order_impact')
  assert.match(risk.conclusion.summary, /SO-001/)
})

test('a need with a quantity opens the item\'s purchase request; an item running low gets its stock', async () => {
  const order = await ask('I need 50 temperature sensors')
  assert.equal(order.intent, 'prepare_action_draft')
  const card = order.reviewCards.find((entry) => entry.draftType === 'purchase_request_draft')
  assert.equal(card.payload.itemIdOrSku, 'LDM-002')
  assert.equal(card.payload.quantity, 50)
  assert.equal(card.payload.unitLabel, 'pcs')
  // The reason is a whole sentence, in the request's reason field too.
  assert.equal(card.payload.reason, 'Requested 50 pcs; 150 pcs available against a target of 15 pcs.')
  // An item the catalog has no match for (the items have English names): the
  // answer says so and offers only the blank request, never another item.
  const unmatched = await ask('我需要 50 个温度传感器', 'zh-CN')
  assert.equal(unmatched.conclusion.title, '要为哪个物料建采购申请？')
  assert.equal(unmatched.conclusion.summary, '我没能在物料目录里找到你说的物料，所以不替你选。可以新建空白采购申请，在其中选择物料，或告诉我它的 SKU。')
  assert.deepEqual(unmatched.reviewCards.map((entry) => [entry.draftType, entry.payload.itemIdOrSku, entry.autoOpen]), [['purchase_request_draft', undefined, false]])
  assert.deepEqual(unmatched.keyEvidence, [])
  const zhReason = (await ask('我需要 50 个 LDM-002', 'zh-CN')).reviewCards.find((entry) => entry.draftType === 'purchase_request_draft').payload.reason
  assert.equal(zhReason, '按你的要求申请 50 件；可用 150 件，目标 15 件。')
  const low = await ask('Is the LDM-002 Temperature Sensor running low?')
  assert.equal(low.intent, 'inventory_availability')
  assert.match(low.conclusion.title, /^LDM-002: [\d,]+ pcs available to promise$/)
  // The status is said once, as a sentence of its own; the line says the quantities.
  assert.doesNotMatch(low.conclusion.summary, /Stock status:/)
  assert.match(low.keyEvidence[0].summary, /^[\d,]+ pcs available to promise; [\d,]+ pcs available now\.$/)
})
