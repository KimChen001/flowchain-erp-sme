import test from 'node:test'
import assert from 'node:assert/strict'
import { aiSkillScenario } from '../domain/test-fixtures/ai-skill-scenario.mjs'
import { aiSkillTierOf, routeSkill } from '../domain/ai-skill-router.mjs'
import { handleAiRuntimeGatewayRoute } from './ai-runtime-gateway.routes.mjs'

// Supplier tiers in the assistant (docs/supplier-tiers-design.md §6, T3): the
// purchase orders and supplier attention answers label each tiered supplier,
// and a tier in the question filters them without changing their order
// (decision 8). End to end through /api/ai-runtime/respond on the skill test
// scenario, with Acme as Tier 1 and Summit as Tier 2.

const CJK = /[㐀-鿿]/

function harness({ roleKey = 'workspace-administrator', tiers = { 'SUP-001': 1, 'SUP-002': 2 } } = {}) {
  const scenario = aiSkillScenario({ roleKey })
  for (const supplier of scenario.data.suppliers) supplier.tier = tiers[supplier.id] ?? null
  const sent = []
  const ctx = {
    ...scenario.ctx,
    req: { method: 'POST', headers: {} }, res: {}, url: new URL('http://local/api/ai-runtime/respond'),
    db: { __dataMode: 'user', purchaseOrders: [], products: [], suppliers: [] },
    env: { FLOWCHAIN_PERSISTENCE_MODE: 'database' },
    send: (_res, status, payload) => sent.push({ status, payload }),
  }
  ctx.repositories = { ...ctx.repositories, auditLog: { mode: 'database', recordAuditEntry: async (entry) => entry } }
  const ask = async (message, answerLanguage = 'en-US') => {
    ctx.readBody = async () => ({ message, answerLanguage })
    assert.equal(await handleAiRuntimeGatewayRoute(ctx), true)
    const { status, payload } = sent.at(-1)
    assert.equal(status, 200, message)
    return payload
  }
  return { ask, scenario }
}

const figures = (payload) => Object.fromEntries((payload.figures || []).map((figure) => [figure.key, figure.value]))
const ids = (payload) => (payload.keyEvidence || []).map((item) => item.entityId)

test('a tier is read from the question, in English and Chinese, next to a supplier word', () => {
  for (const [message, tier] of [
    ['Which Tier 1 suppliers have overdue orders?', 1], ['which tier-2 suppliers need attention', 2], ['Tier three vendors?', 3],
    ['How are our strategic suppliers doing?', 1], ['Any core suppliers with problems?', 2], ['transactional vendors', 3],
    ['一级供应商有哪些逾期订单？', 1], ['二级 · 核心供应商情况怎么样', 2], ['三级供应商', 3], ['战略供应商需要关注什么？', 1],
    ['Which suppliers are not tiered yet?', 'none'], ['哪些供应商未分级？', 'none'],
    ['What are our core values?', null], ['一级库存', null], ['一般供应商', null], ['Which suppliers need attention?', null],
  ]) assert.equal(aiSkillTierOf(message), tier, message)
  // "tier-1" is a tier, not a record number, so the question still routes.
  assert.deepEqual(routeSkill({ message: 'Which tier-1 suppliers need attention?' }).ids, [])
  assert.equal(routeSkill({ message: 'Which tier-1 suppliers need attention?' }).skillId, 'supplier_attention')
})

test('tier questions route to the purchase orders and supplier answers', () => {
  for (const [message, skillId] of [
    ['Which Tier 1 suppliers have overdue orders?', 'purchase_orders'],
    ['How many Tier 2 suppliers have overdue POs?', 'purchase_orders'],
    ['一级供应商有哪些逾期订单？', 'purchase_orders'],
    ['Which strategic suppliers do we have?', 'supplier_attention'],
    ['战略供应商情况怎么样？', 'supplier_attention'],
    // Without a tier, a count of late orders is still the workspace metrics.
    ['How many purchase orders are overdue?', 'workspace_metrics'],
  ]) assert.equal(routeSkill({ message }).skillId, skillId, message)
})

test('a tier filters the overdue orders to its suppliers, in the same order, with its own count', async () => {
  const { ask } = harness()
  const all = await ask('Which purchase orders are overdue?')
  const tier1 = await ask('Which Tier 1 suppliers have overdue orders?')
  assert.equal(tier1.intent, 'purchase_orders')
  const acme = all.keyEvidence.filter((item) => item.summary.includes('Acme Components')).map((item) => item.entityId)
  assert.ok(acme.length > 0)
  assert.deepEqual(ids(tier1), acme, 'the Tier 1 list is the full list without the other suppliers, in the same order')
  assert.equal(figures(tier1)['tier_overdue_po:1'], acme.length)
  assert.equal(figures(tier1).overdue_po_count, undefined, 'the workspace count is not stated as the tier count')
  assert.match(tier1.conclusion.title, /purchase orders? from Tier 1 suppliers (is|are) overdue/)
  assert.ok(tier1.keyEvidence.every((item) => item.summary.includes('Acme Components (Tier 1)')))
  // Without a filter every tiered supplier is labelled.
  assert.ok(all.keyEvidence.every((item) => /(Acme Components \(Tier 1\)|Summit Packaging \(Tier 2\))/.test(item.summary)))
  const zh = await ask('一级供应商有哪些逾期订单？', 'zh-CN')
  assert.deepEqual(ids(zh), acme)
  assert.match(zh.conclusion.title, /一级供应商的逾期采购订单/)
  assert.ok(zh.keyEvidence.every((item) => item.summary.includes('Acme Components（一级）')))
  // A count question about one tier gets the same answer.
  assert.equal(figures(await ask('How many Tier 1 suppliers have overdue POs?'))['tier_overdue_po:1'], acme.length)
  // An English answer stays free of Chinese.
  assert.doesNotMatch(JSON.stringify(tier1), CJK)
})

test('a tier narrows the supplier answer; an empty tier says so', async () => {
  const { ask } = harness()
  const all = await ask('Which suppliers need attention?')
  const tier2 = await ask('Which Tier 2 suppliers need attention?')
  assert.equal(tier2.intent, 'supplier_attention')
  assert.deepEqual(ids(tier2), ids(all).filter((id) => id === 'SUP-002'))
  assert.ok(all.keyEvidence.some((item) => item.entityLabel === 'Acme Components (Tier 1)'))
  if (ids(tier2).length) assert.match(tier2.conclusion.title, /Tier 2 suppliers/)
  const tier3 = await ask('Which Tier 3 suppliers need attention?')
  assert.equal(tier3.conclusion.title, 'There are no Tier 3 suppliers yet')
  assert.deepEqual(ids(tier3), [])
  const zh = await ask('三级供应商需要关注什么？', 'zh-CN')
  assert.equal(zh.conclusion.title, '目前还没有三级供应商')
})

test('suppliers without a tier keep their plain names, and "not tiered" filters to them', async () => {
  const { ask } = harness({ tiers: { 'SUP-001': 1 } })
  const all = await ask('Which purchase orders are overdue?')
  assert.ok(all.keyEvidence.every((item) => !/Summit Packaging \(/.test(item.summary)))
  const untiered = await ask('Which suppliers that are not tiered yet have overdue orders?')
  assert.equal(untiered.intent, 'purchase_orders')
  assert.ok(untiered.keyEvidence.every((item) => !item.summary.includes('Acme Components')))
  assert.ok('tier_overdue_po:none' in figures(untiered))
})
