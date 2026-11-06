import test from 'node:test'
import assert from 'node:assert/strict'
import { BUSINESS_QUERY_GOALS, emptyBusinessQueryPlan, validateBusinessQueryPlan } from './ai-business-query-plan.mjs'
import { detectBusinessTimeWindow, resolveBusinessTimeWindow } from './ai-business-time-window.mjs'
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

test('supplier bills, quotes and deliveries are not supplier names', () => {
  for (const message of ['Are any supplier bills off?', 'Have the supplier quotes come back, and which are late?', 'Is any supplier delivery stuck at the dock?']) {
    const plan = buildDeterministicBusinessQueryPlan({ message, suppliers })
    assert.deepEqual(plan.scope.entityNames, [], message)
    assert.equal(plan.ambiguities.some((ambiguity) => ambiguity.startsWith('supplier_not_found')), false, message)
  }
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

test('a provider clarification never replaces a deterministic plan that needs none', async () => {
  const env = { FLOWCHAIN_ENABLE_AI_SEMANTIC_PLANNER: 'true' }
  const asking = buildDeterministicBusinessQueryPlan({ message: '帮我看看供应商。', suppliers })
  const overridden = await planBusinessQuery({ message: 'Why is an empty record counted as one?', suppliers }, { env, providerPlanner: async () => ({ ok: true, rawOutput: asking }) })
  assert.equal(overridden.plannerMode, 'deterministic_fallback')
  assert.equal(overridden.fallbackReason, 'provider_clarification_overridden')
  assert.equal(overridden.plan.clarificationNeeded, false)
  assert.ok(overridden.plan.goals.includes('data_quality_limitations'))
  const kept = await planBusinessQuery({ message: '帮我看看供应商。', suppliers }, { env, providerPlanner: async () => ({ ok: true, rawOutput: asking }) })
  assert.equal(kept.plannerMode, 'provider')
  assert.equal(kept.plan.clarificationNeeded, true)
})

test('a provider plan keeps the goals of a deterministic plan and may add its own', async () => {
  const env = { FLOWCHAIN_ENABLE_AI_SEMANTIC_PLANNER: 'true' }
  const message = 'Check supplier payments, overdue POs, and invoice mismatches together.'
  const deterministic = buildDeterministicBusinessQueryPlan({ message, suppliers })
  const narrower = { ...deterministic, goals: ['supplier_invoice_exceptions', 'supplier_rfq_followups'] }
  const result = await planBusinessQuery({ message, suppliers }, { env, providerPlanner: async () => ({ ok: true, rawOutput: narrower }) })
  assert.equal(result.plannerMode, 'provider')
  for (const goal of deterministic.goals) assert.ok(result.plan.goals.includes(goal), goal)
  assert.ok(result.plan.goals.includes('supplier_rfq_followups'))
  const tooMany = { ...deterministic, goals: BUSINESS_QUERY_GOALS.filter((goal) => !deterministic.goals.includes(goal)).slice(0, 8) }
  const capped = await planBusinessQuery({ message, suppliers }, { env, providerPlanner: async () => ({ ok: true, rawOutput: tooMany }) })
  assert.equal(capped.plannerMode, 'deterministic_fallback')
  assert.deepEqual(capped.plan.goals, deterministic.goals)
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

test('time windows fall back to America/New_York when the workspace timezone is missing or invalid', () => {
  const now = new Date('2026-07-24T08:00:00.000Z')
  const missing = resolveBusinessTimeWindow('today', { now })
  assert.equal(missing.timezone, 'America/New_York')
  assert.equal(missing.startAt, '2026-07-24T04:00:00.000Z')
  assert.deepEqual(missing.limitations, [])
  const invalid = resolveBusinessTimeWindow('today', { now, timezone: 'Not/AZone' })
  assert.equal(invalid.timezone, 'America/New_York')
  assert.deepEqual(invalid.limitations, ['workspace_timezone_invalid:America/New_York:Not/AZone'])
})

test('recent and soon resolve to the next 7 days with a limitation code, never wording', () => {
  const now = new Date('2026-07-24T08:00:00.000Z')
  for (const [expression, code] of [['Which suppliers need payment soon?', 'time_window_soon_default'], ['哪些供应商很快需要付款？', 'time_window_soon_default'], ['Show recent supplier payments.', 'time_window_recent_default'], ['最近哪些供应商需要付款？', 'time_window_recent_default']]) {
    assert.equal(detectBusinessTimeWindow(expression), 'next_7_days', expression)
    assert.deepEqual(resolveBusinessTimeWindow('next_7_days', { now, expression }).limitations, [code], expression)
  }
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

test('a supplier code or name matches only as a whole phrase', () => {
  const coded = [
    { tenantId: 't1', id: 'supplier-ac', name: 'Acme Components', code: 'AC' },
    { tenantId: 't1', id: 'supplier-nor', name: 'Northstar Electronics', code: 'NOR' },
  ]
  const scope = (message) => buildDeterministicBusinessQueryPlan({ message, suppliers: coded }).scope
  // A two-letter code never matches inside a word, and a code is not a
  // prefix of a longer word.
  assert.notEqual(scope('Which accounts need payment?').source, 'explicit')
  assert.notEqual(scope('Which suppliers need payment normally?').source, 'explicit')
  // A name or a three-letter code as a whole phrase still matches, also
  // straight before Chinese text.
  assert.deepEqual(scope('Can we pay Acme Components this week?').entityIds, ['supplier-ac'])
  assert.deepEqual(scope('NOR 需要付款吗？').entityIds, ['supplier-nor'])
  assert.deepEqual(scope('Northstar Electronics的应付款').entityIds, ['supplier-nor'])
  // A two-character name or code counts when written in capitals.
  const short = [{ tenantId: 't1', id: 'supplier-hp', name: 'HP', code: 'HP01' }, { tenantId: 't1', id: 'supplier-in', name: 'Inland Freight', code: 'IN' }]
  const shortScope = (message) => buildDeterministicBusinessQueryPlan({ message, suppliers: short }).scope
  assert.deepEqual(shortScope('Which payments to HP are blocked?').entityIds, ['supplier-hp'])
  assert.deepEqual(shortScope('HP 的付款被阻断了吗？').entityIds, ['supplier-hp'])
  assert.notEqual(shortScope('Which supplier payments are due in March?').source, 'explicit')
})

test('time windows also give their workspace calendar days, both included', () => {
  // 22:00 on Wednesday Oct 7 in New York is already Oct 8 in UTC.
  const now = new Date('2026-10-08T02:00:00.000Z')
  const days = (kind) => { const window = resolveBusinessTimeWindow(kind, { now, timezone: 'America/New_York' }); return [window.startDay, window.endDay] }
  assert.deepEqual(days('today'), ['2026-10-07', '2026-10-07'])
  assert.deepEqual(days('current_week'), ['2026-10-05', '2026-10-11'])
  assert.deepEqual(days('next_7_days'), ['2026-10-07', '2026-10-13'])
  assert.deepEqual(days('next_30_days'), ['2026-10-07', '2026-11-05'])
  assert.deepEqual(days('month_end'), ['2026-10-07', '2026-10-31'])
  assert.deepEqual(days('overdue'), [null, '2026-10-06'])
  assert.deepEqual(days('all'), [null, null])
})
