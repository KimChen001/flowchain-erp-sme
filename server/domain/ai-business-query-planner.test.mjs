import test from 'node:test'
import assert from 'node:assert/strict'
import { emptyBusinessQueryPlan, validateBusinessQueryPlan } from './ai-business-query-plan.mjs'
import { resolveBusinessTimeWindow } from './ai-business-time-window.mjs'
import { buildDeterministicBusinessQueryPlan, planBusinessQuery } from './ai-semantic-query-planner.mjs'

const suppliers = [
  { tenantId: 't1', id: 'supplier-a', name: 'Supplier A' },
  { tenantId: 't1', id: 'supplier-b', name: 'Supplier B' },
]

test('all supplier payment question produces global payment plan', () => {
  const plan = buildDeterministicBusinessQueryPlan({ message: '有哪些供应商需要付款？', suppliers })
  assert.equal(plan.scope.mode, 'all')
  assert.deepEqual(plan.goals, ['supplier_payables_due', 'supplier_payment_readiness'])
  assert.equal(plan.clarificationNeeded, false)
  assert.equal(validateBusinessQueryPlan(plan).valid, true)
})

test('comparison resolves a stable explicit supplier set', () => {
  const plan = buildDeterministicBusinessQueryPlan({ message: 'Supplier A 和 Supplier B 谁的风险更高？', suppliers })
  assert.equal(plan.scope.mode, 'set')
  assert.deepEqual(plan.scope.entityIds, ['supplier-a', 'supplier-b'])
  assert.ok(plan.goals.includes('supplier_comparison'))
  assert.equal(plan.comparison.enabled, true)
})

test('previous result scope requires safe prior references', () => {
  const missing = buildDeterministicBusinessQueryPlan({ message: '这些供应商还有什么事情没有处理？', suppliers })
  assert.equal(missing.clarificationNeeded, true)
  const grounded = buildDeterministicBusinessQueryPlan({ message: '这些供应商还有什么事情没有处理？', suppliers, previousResult: [{ supplierId: 'supplier-a' }, { supplierId: 'supplier-b' }] })
  assert.equal(grounded.scope.mode, 'previous_result')
  assert.equal(grounded.clarificationNeeded, false)
})

test('generic supplier prompt clarifies instead of selecting the first supplier', () => {
  const plan = buildDeterministicBusinessQueryPlan({ message: '帮我看看供应商', suppliers })
  assert.equal(plan.clarificationNeeded, true)
  assert.deepEqual(plan.scope.entityIds, [])
})

test('unknown English supplier before Chinese business wording remains a not-found entity', () => {
  const plan = buildDeterministicBusinessQueryPlan({ message: '为什么 Supplier Missing 暂时不能付款？', suppliers })
  assert.equal(plan.clarificationNeeded, true)
  assert.deepEqual(plan.scope.entityNames, ['Supplier Missing'])
  assert.match(plan.clarificationQuestion, /未找到 Supplier Missing/)
})

test('unknown goals, excessive goals, SQL and arbitrary tool fields are rejected', () => {
  assert.equal(validateBusinessQueryPlan(emptyBusinessQueryPlan({ goals: ['unknown_goal'] })).valid, false)
  assert.equal(validateBusinessQueryPlan(emptyBusinessQueryPlan({ goals: Array.from({ length: 9 }, (_, index) => `goal_${index}`) })).valid, false)
  assert.equal(validateBusinessQueryPlan({ ...emptyBusinessQueryPlan(), sql: 'SELECT * FROM Supplier' }).valid, false)
  assert.equal(validateBusinessQueryPlan({ ...emptyBusinessQueryPlan(), toolName: 'createPayment' }).valid, false)
})

test('invalid provider output and timeout degrade to deterministic plan', async () => {
  const env = { FLOWCHAIN_ENABLE_AI_SEMANTIC_PLANNER: 'true', FLOWCHAIN_AI_PROVIDER_MODE: 'provider_assisted', FLOWCHAIN_AI_PROVIDER_KIND: 'generic_http' }
  const invalid = await planBusinessQuery({ message: '哪些付款被阻断，为什么？', suppliers }, { env, providerPlanner: async () => ({ ok: true, rawOutput: { goals: ['hallucinated_goal'] } }) })
  assert.equal(invalid.plannerStatus, 'degraded')
  assert.ok(invalid.plan.goals.includes('supplier_payment_blocks'))
  const timeout = await planBusinessQuery({ message: '有哪些供应商需要付款？', suppliers }, { env, providerPlanner: async () => ({ ok: false, reason: 'timeout' }) })
  assert.equal(timeout.fallbackReason, 'timeout')
  assert.equal(timeout.plannerMode, 'deterministic_fallback')
})

test('provider plan cannot request writes or carry business facts', async () => {
  const candidate = { ...emptyBusinessQueryPlan(), requestedActions: ['create_payment'] }
  assert.equal(validateBusinessQueryPlan(candidate).valid, false)
  assert.equal(validateBusinessQueryPlan({ ...emptyBusinessQueryPlan(), totalAmount: 100 }).valid, false)
})

test('current week is interpreted in workspace timezone', () => {
  const result = resolveBusinessTimeWindow('current_week', { now: new Date('2026-07-24T08:00:00.000Z'), timezone: 'Asia/Shanghai' })
  assert.equal(result.timezone, 'Asia/Shanghai')
  assert.equal(result.startAt, '2026-07-19T16:00:00.000Z')
  assert.equal(result.endAt, '2026-07-26T15:59:59.999Z')
})

test('domain words after supplier or vendor are not unresolved supplier names', () => {
  for (const message of [
    'Apart from payment, what supplier work remains?',
    'Show all supplier payment readiness, delayed PO, and invoice issues.',
    '最近 vendor 付款和订单拖期一起看。',
  ]) {
    const plan = buildDeterministicBusinessQueryPlan({ message, suppliers })
    assert.equal(plan.scope.mode, 'all')
    assert.equal(plan.clarificationNeeded, false)
    assert.deepEqual(plan.scope.entityNames, [])
  }
})

test('overdue purchase orders do not turn payment goals into overdue payment goals', () => {
  for (const message of [
    'Check supplier payments, overdue POs, and invoice mismatches together.',
    'In the next 7 days show payments and overdue POs.',
    '未来 7 天谁要付款，哪些采购订单逾期？',
  ]) {
    const plan = buildDeterministicBusinessQueryPlan({ message, suppliers })
    assert.ok(plan.goals.includes('supplier_payables_due'))
    assert.ok(!plan.goals.includes('supplier_payables_overdue'))
    assert.deepEqual(plan.filters.dueState, [])
  }
})

test('payment blocking synonyms include cannot be paid and current week priority wording', () => {
  const blocked = buildDeterministicBusinessQueryPlan({ message: 'Why can’t Supplier A be paid?', suppliers })
  assert.ok(blocked.goals.includes('supplier_payment_blocks'))
  const priority = buildDeterministicBusinessQueryPlan({ message: 'current week 哪些供应商必须跟进？', suppliers })
  assert.ok(priority.goals.includes('supplier_priority'))
})
