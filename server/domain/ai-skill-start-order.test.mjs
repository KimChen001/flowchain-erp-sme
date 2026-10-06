import test from 'node:test'
import assert from 'node:assert/strict'
import { aiSkillScenario } from './test-fixtures/ai-skill-scenario.mjs'
import { loadAiSkillContext } from './ai-skill-context.mjs'
import { readAiSkillFacts } from './ai-skill-readers.mjs'
import { answerAiSkill } from './ai-skills.mjs'
import { runAiSkillRuntime } from './ai-skill-runtime.mjs'
import { validateAiSkillResponse } from './ai-skill-validator.mjs'

// In the scenario LDM-001 is short 7 against SO-001 (28 available, target 40),
// and PO-001 (4 days late) and PO-008 bring 70 pcs, with 50 more in PR-001,
// which awaits approval.
const ask = async (message, options) => runAiSkillRuntime(aiSkillScenario(options).ctx, { message })
const cards = (response) => response.reviewCards.map((card) => [card.draftType, card.targetEntityId ?? null, card.payload.quantity ?? null, card.autoOpen ?? null])

async function facts(options) {
  const scenario = aiSkillScenario(options)
  return readAiSkillFacts(await loadAiSkillContext(scenario.ctx))
}
const order = (facts, language = 'en-US', request = {}, focus = null) => answerAiSkill({ skillId: 'prepare_action_draft', facts, language, query: 'q', focus, route: { skillId: 'prepare_action_draft', mode: 'order', order: { advice: false, anyway: false, quantity: null, ...request } } }).response
// Nothing on order for LDM-001: no open PO and no pending request.
function uncovered(facts) {
  Object.assign(facts.inventory.rows.find((row) => row.sku === 'LDM-001'), { incomingApprovedPo: 0, purchaseOrderIds: [] })
  facts.purchaseRequests.awaitingApproval = []
  facts.purchaseOrders.rows = []
  return facts
}

test('asked for the order, a shortage open orders cover is explained, open orders first, and nothing is opened', async () => {
  const response = await ask('can you help me generate the order?')
  assert.equal(response.intent, 'prepare_action_draft')
  // What is already on order comes first, in the title and the first sentence.
  assert.equal(response.conclusion.title, 'LDM-001 already has open orders on the way')
  assert.equal(response.conclusion.summary, 'Open orders PO-001 and PO-008 already bring 70 pcs. 50 pcs more is in requests awaiting approval. PO-001 is 4 days past its promised date. That covers the shortage, so I did not open a new request: another one could order the same stock twice. 28 available against a target of 40. Chase PO-001 first, or open a request anyway.')
  // Chasing the late order first, then a request one click away.
  assert.deepEqual(cards(response), [['po_followup_draft', 'PO-001', null, null], ['purchase_request_draft', 'ITEM-001', 12, false]])
  assert.deepEqual(response.reviewCards.map((card) => card.allowedNextStep), ['Draft a follow-up on PO-001', 'Open a request for LDM-001 anyway'])
  // The follow-up is the drafts' own: greeting, each open line, and the lines for the review form.
  const followUp = response.reviewCards[0].payload
  assert.match(followUp.message, /^Hello Acme Components,\n\nPlease confirm a delivery date for the open line on PO-001:\n- LDM-001: 30 pcs still to deliver/)
  assert.deepEqual(followUp.lines.map((line) => [line.sku, line.remaining]), [['LDM-001', 30]])
  const chinese = await ask('帮我下单')
  assert.equal(chinese.conclusion.title, 'LDM-001 已有在途订单')
  assert.match(chinese.conclusion.summary, /^在途订单 PO-001和 PO-008 共 70 pcs。/)
  assert.deepEqual(cards(chinese), cards(response))
})

test('a named SKU, or "anyway", opens its request on top of what is on order, and says what is on order first', async () => {
  for (const message of ['Create a purchase order for LDM-001', 'Place an order anyway', '仍然帮我下单']) {
    const response = await ask(message)
    // The request opens; the LDM-001 line still offers its own next step,
    // chasing the late PO (owner decision 2), which never opens by itself.
    assert.deepEqual(cards(response), [['purchase_request_draft', 'ITEM-001', 12, true], ['po_followup_draft', 'PO-001', null, null]], message)
    assert.equal(response.reviewCards[0].payload.itemIdOrSku, 'LDM-001', message)
  }
  const english = await ask('Create a purchase order for LDM-001')
  assert.equal(english.conclusion.title, 'LDM-001 is already on order. Opening a request for 12 pcs more')
  assert.match(english.conclusion.summary, /^Open orders PO-001 and PO-008 already bring 70 pcs\. 50 pcs more is in requests awaiting approval\. PO-001 is 4 days past its promised date\. 28 available against a target of 40; this is on top of what is already on order\./)
  assert.match(english.conclusion.summary, /nothing is saved or submitted until you do/)
  // The reason is the request line's note.
  assert.equal(english.reviewCards[0].payload.reason, '28 available against a target of 40; this is on top of what is already on order.')
  assert.equal(english.reviewCards[0].allowedNextStep, 'Open request: 12 pcs of LDM-001')
  const chinese = await ask('仍然帮我下单')
  assert.equal(chinese.conclusion.title, 'LDM-001 已有在途订单，仍为你打开追加 12 pcs 的采购申请')
  assert.equal(chinese.reviewCards[0].payload.reason, '可用 28，目标 40；本数量在已在途数量之外追加。')
})

test('a quantity the question names wins, and a SKU without stock levels opens without one', async () => {
  const fifty = await ask('order 50 more LDM-002')
  assert.deepEqual(cards(fifty), [['purchase_request_draft', 'ITEM-002', 50, true]])
  assert.equal(fifty.reviewCards[0].payload.reason, 'The quantity you asked for. 150 available against a target of 15.')
  const gasket = await ask('Reorder LDM-009')
  assert.deepEqual(cards(gasket), [['purchase_request_draft', 'ITEM-009', null, true]])
  assert.equal(gasket.conclusion.title, 'Opening a purchase request for LDM-009')
  assert.equal(gasket.keyEvidence[0].statusCode, 'stock_level')
})

test('asking whether or what to order gets the request without opening it', async () => {
  const response = await ask('Should I reorder LDM-001?')
  assert.equal(response.conclusion.title, 'LDM-001 is covered by what is already on order')
  assert.deepEqual(cards(response), [['purchase_request_draft', 'ITEM-001', 12, false], ['po_followup_draft', 'PO-001', null, null]])
  const yes = order(uncovered(await facts()), 'en-US', { advice: true })
  assert.equal(yes.conclusion.title, 'LDM-001 needs ordering: 12 pcs')
  assert.deepEqual(cards(yes), [['purchase_request_draft', 'ITEM-001', 12, false]])
})

test('the one SKU that needs ordering is opened with its gap', async () => {
  const response = order(uncovered(await facts()))
  assert.equal(response.conclusion.title, 'Opening a purchase request for 12 pcs of LDM-001')
  assert.deepEqual(cards(response), [['purchase_request_draft', 'ITEM-001', 12, true]])
  assert.equal(response.reviewCards[0].payload.reason, '28 available against a target of 40; nothing incoming covers it.')
})

test('open purchase order lines in another unit are named first, and the request is not opened', async () => {
  // 12 CASE of LDM-001 on PO-0040: not counted as incoming (LDM-001 is kept
  // in pcs), but on order, so the answer says so and opens nothing.
  const data = uncovered(await facts())
  data.inventory.rows.find((row) => row.sku === 'LDM-001').incomingOtherUnit = [{ purchaseOrderId: 'PO-0040', orderNumber: 'PO-0040', unit: 'CASE', remaining: 12 }]
  const response = order(data)
  assert.equal(response.conclusion.title, 'LDM-001 needs ordering: 12 pcs')
  assert.match(response.conclusion.summary, /^LDM-001 is also on open purchase order lines in another unit, not counted above: PO-0040 \(12 CASE\)\. Check them before you order more\./)
  assert.deepEqual(cards(response), [['purchase_request_draft', 'ITEM-001', 12, false]])
  assert.deepEqual(validateAiSkillResponse(response, data), { ok: true, errors: [] })
  const chinese = order(data, 'zh-CN')
  assert.match(chinese.conclusion.summary, /^LDM-001 还有以其他单位记录的未结采购订单行，上面未计入：PO-0040 \(12 CASE\)。/)
  assert.deepEqual(cards(chinese), cards(response))
  // A reader who cannot read purchase orders hears the quantity, not the order.
  data.inventory.rows.find((row) => row.sku === 'LDM-001').incomingOtherUnit = [{ purchaseOrderId: null, orderNumber: null, unit: 'CASE', remaining: 12 }]
  assert.match(order(data).conclusion.summary, /not counted above: 12 CASE\./)
  // The stock answer names the line too.
  const row = data.inventory.rows.find((entry) => entry.sku === 'LDM-001')
  const stock = answerAiSkill({ skillId: 'inventory_availability', facts: data, language: 'en-US', query: 'How much LDM-001 can I promise?', route: { skillId: 'inventory_availability', mode: 'single', entities: { skus: [row] } } }).response
  assert.match(stock.conclusion.summary, /Not counted as incoming because the line is in another unit than the stock: 12 CASE\./)
})

test('several SKUs that need ordering are offered by name, and none is opened', async () => {
  const data = uncovered(await facts())
  Object.assign(data.inventory.rows.find((row) => row.sku === 'LDM-002'), { available: 5, availableToPromise: 5, incomingApprovedPo: 0, purchaseOrderIds: [], stockStatus: 'below_safety_stock' })
  const response = order(data)
  assert.equal(response.conclusion.title, '2 SKUs need ordering')
  assert.deepEqual(cards(response), [['purchase_request_draft', 'ITEM-001', 12, false], ['purchase_request_draft', 'ITEM-002', 10, false]])
  assert.deepEqual(response.reviewCards.map((card) => card.allowedNextStep), ['Open request: 12 pcs of LDM-001', 'Open request: 10 pcs of LDM-002'])
  assert.deepEqual(cards(order(data, 'zh-CN')), cards(response))
})

test('with nothing to order, a blank request is offered, not opened', async () => {
  const data = await facts()
  Object.assign(data.inventory.rows.find((row) => row.sku === 'LDM-001'), { available: 100, availableToPromise: 100, shortage: 0, stockStatus: 'normal' })
  const response = order(data)
  assert.equal(response.conclusion.title, 'Nothing needs ordering right now')
  assert.deepEqual(cards(response), [['purchase_request_draft', null, null, false]])
  assert.equal(response.reviewCards[0].allowedNextStep, 'Open a blank purchase request')
})

test('a role that cannot prepare purchase requests gets no card', async () => {
  const response = await ask('can you help me generate the order?', { roleKey: 'read-only-viewer' })
  assert.deepEqual(response.reviewCards, [])
  assert.ok(response.dataLimitations.some((item) => item.code === 'draft_permission'))
})

test('the order cards stay review-only and never claim the order was placed', async () => {
  for (const message of ['can you help me generate the order?', 'Create a purchase order for LDM-001', '帮我下单', '仍然帮我下单']) {
    const response = await ask(message)
    for (const card of response.reviewCards) {
      assert.equal(card.previewOnly, true)
      assert.equal(card.requiresHumanReview, true)
      assert.ok(card.prohibitedActions.includes('issue'))
    }
    assert.doesNotMatch(`${response.conclusion.title} ${response.conclusion.summary}`, /\bplaced\b|已下单|已下达/)
  }
})
