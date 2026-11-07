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

