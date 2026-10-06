import test from 'node:test'
import assert from 'node:assert/strict'
import { aiSkillActor, aiSkillScenario } from './test-fixtures/ai-skill-scenario.mjs'
import { handleAiRuntimeGatewayRoute } from '../routes/ai-runtime-gateway.routes.mjs'
import { aiAgentTools, validateAiAgentToolCalls } from './ai-agent-planning.mjs'
import { AI_AGENT_BUSINESS_QUERY, aiAgentBusinessQueryGoals, aiAgentBusinessQueryPlan } from './ai-agent-business-query.mjs'

// The supplier business query as an agent planning tool (decision 3). The
// provider is a scripted stub and the read service a fixture: nothing is sent
// anywhere and no database is read.
const AGENT_ENV = {
  FLOWCHAIN_PERSISTENCE_MODE: 'database',
  FLOWCHAIN_AI_AGENT_MODE: 'plan',
  FLOWCHAIN_AI_RUNTIME_MODE: 'provider_assisted',
  FLOWCHAIN_AI_PROVIDER_KIND: 'parley_chat',
  FLOWCHAIN_AI_PROVIDER_ENDPOINT: 'http://127.0.0.1:9/agent-test',
  FLOWCHAIN_AI_PROVIDER_API_KEY: 'placeholder',
  FLOWCHAIN_AI_PROVIDER_MODEL: 'placeholder-model',
  FLOWCHAIN_AI_AGENT_TIMEOUT_MS: '150',
}
// Two parts; the business query path takes it whole and answers only the invoices.
const DOCK_BILLS = 'Did anything arrive damaged or short, and do the supplier invoices line up?'

const summary = {
  supplier: { id: 'SUP-001', name: 'Acme Components', displayName: 'Acme Components' },
  payment: { state: 'confirmed', dueCount: 1, dueAmount: 100, overdueCount: 0, overdueAmount: 0, readyCount: 1, blockedCount: 0, blocks: [] },
  invoice: { state: 'confirmed', openCount: 1, mismatchCount: 1, disputedCount: 0, missingEvidenceCount: 0 },
  procurement: { state: 'confirmed_zero', openPoCount: 0, overduePoCount: 0, overduePoIds: [], unreceivedPoCount: 0 },
  receiving: { state: 'confirmed_zero', exceptionCount: 0, rejectedQuantity: 0, pendingEvidenceCount: 0 },
  rfq: { state: 'confirmed_zero', awaitingResponseCount: 0, expiredCount: 0 },
  reconciliation: { state: 'hidden', unreconciledPaymentCount: null, blockingExceptionCount: null },
  dataQuality: { incompleteRecordCount: 0, limitations: [] },
  priority: { level: 'medium', score: 30, reasons: [], algorithmVersion: 'supplier-action-priority-v1' },
  recommendedActions: [],
  evidence: [{ type: 'supplier_invoice', id: 'INV-001', label: 'INV-001' }],
}

function harness({ env = AGENT_ENV, provider } = {}) {
  const scenario = aiSkillScenario()
  const audits = []
  const sent = []
  const plans = []
  const reads = []
  const ctx = {
    ...scenario.ctx,
    req: { method: 'POST', headers: {} }, res: {}, url: new URL('http://local/api/ai-runtime/respond'),
    db: { __dataMode: 'user', purchaseOrders: [], products: [], suppliers: [] },
    env,
    send: (_res, status, payload) => sent.push({ status, payload }),
    ...(provider ? { aiAgentProvider: async (input) => { plans.push(input); return provider(input) } } : {}),
    aiBusinessQueryActor: scenario.actor,
    aiBusinessQueryPrisma: { supplier: { findMany: async () => [{ id: 'SUP-001', tenantId: scenario.actor.tenantId, name: 'Acme Components', code: 'ACME' }] }, tenant: { findUnique: async () => ({ timezone: 'America/New_York' }) } },
    aiBusinessQuerySummaryService: { read: async (request) => { reads.push(request); return { items: [summary], recordValiditySummary: { validCount: 1, incompleteCount: 0, invalidCount: 0, hiddenCount: 0, unavailable: false }, fieldVisibility: { amounts: true, partner: true }, sourceStatus: {} } } },
  }
  ctx.repositories = { ...ctx.repositories, auditLog: { mode: 'database', recordAuditEntry: async (entry) => { audits.push(entry); return entry } } }
  const ask = async (message, answerLanguage = 'en-US') => {
    ctx.readBody = async () => ({ message, answerLanguage })
    await handleAiRuntimeGatewayRoute(ctx)
    return sent.at(-1)
  }
  return { ask, audits, plans, reads, actor: scenario.actor }
}

const calls = (...list) => () => ({ ok: true, toolCalls: list.map(([name, args]) => ({ name, arguments: JSON.stringify(args) })), usage: { inputTokens: 900, outputTokens: 60 } })

test('the tool offers only the supplier goals the actor may read', () => {
  const goals = aiAgentBusinessQueryGoals(aiSkillActor())
  assert.ok(goals.includes('supplier_invoice_exceptions') && goals.includes('supplier_overdue_purchase_orders'))
  assert.ok(goals.every((goal) => goal.startsWith('supplier_')))
  const tool = aiAgentTools(aiSkillActor()).find((entry) => entry.function.name === AI_AGENT_BUSINESS_QUERY)
  assert.deepEqual(tool.function.parameters.properties.goals.items.enum, goals)
  assert.deepEqual(Object.keys(tool.function.parameters.properties), ['goals', 'records'], 'filters and time windows come from the question, never the model')
  assert.equal(aiAgentTools(aiSkillActor('intake-uploader')).some((entry) => entry.function.name === AI_AGENT_BUSINESS_QUERY), false)
  // Only for a question the business query path would take.
  assert.equal(aiAgentTools(aiSkillActor(), { businessQuery: false }).some((entry) => entry.function.name === AI_AGENT_BUSINESS_QUERY), false)
})

test('its calls need known goals, and a second one joins the first', () => {
  const tools = aiAgentTools(aiSkillActor())
  const { calls: kept, dropped } = validateAiAgentToolCalls([
    { name: AI_AGENT_BUSINESS_QUERY, arguments: '{"goals":["supplier_invoice_exceptions"]}' },
    { name: AI_AGENT_BUSINESS_QUERY, arguments: '{"goals":["supplier_payables_due","supplier_invoice_exceptions"]}' },
    { name: AI_AGENT_BUSINESS_QUERY, arguments: '{}' },
    { name: AI_AGENT_BUSINESS_QUERY, arguments: '{"goals":["delete_suppliers"]}' },
    { name: AI_AGENT_BUSINESS_QUERY, arguments: '{"goals":["supplier_priority"],"suppliers":["Acme"]}' },
    { name: AI_AGENT_BUSINESS_QUERY, arguments: '{"goals":["supplier_priority"],"records":["Summit"]}' },
    { name: AI_AGENT_BUSINESS_QUERY, arguments: '{"goals":["supplier_priority"],"records":["Acme"]}' },
  ], { message: 'Which supplier invoices from Acme are off?', tools, maxTools: 2 })
  assert.deepEqual(kept, [{ tool: AI_AGENT_BUSINESS_QUERY, mode: null, records: ['Acme'], goals: ['supplier_invoice_exceptions', 'supplier_payables_due', 'supplier_priority'] }])
  assert.deepEqual(dropped.map((row) => row.reason), ['invalid_arguments', 'invalid_arguments', 'invalid_arguments', 'record_not_in_question'])
})

test("the plan is the question's own, with the model's goals", () => {
  const bq = { timezone: 'America/New_York', suppliers: [{ id: 'SUP-001', tenantId: 'T', name: 'Acme Components', code: 'ACME' }] }
  const body = { message: DOCK_BILLS }
  // Beside other calls: the model's goals only.
  const part = aiAgentBusinessQueryPlan({ body, bq, goals: ['supplier_invoice_exceptions'], alone: false })
  assert.equal(part.valid, true)
  assert.deepEqual(part.plan.goals, ['supplier_invoice_exceptions'])
  assert.equal(part.plan.scope.mode, 'all')
  // Alone: the deterministic goals stay, as with the business query planner.
  const alone = aiAgentBusinessQueryPlan({ body: { message: 'Which suppliers are late and do they have unpaid invoices?' }, bq, goals: ['supplier_overdue_purchase_orders'], alone: true })
  assert.ok(alone.plan.goals.includes('supplier_overdue_purchase_orders') && alone.plan.goals.includes('supplier_payables_due'))
  // A question that does not say which suppliers is about all of them.
  const unsaid = aiAgentBusinessQueryPlan({ body: { message: 'Have we heard back on our quotes, and are any supplier bills off?' }, bq, goals: ['supplier_invoice_exceptions'], alone: false })
  assert.deepEqual([unsaid.plan.clarificationNeeded, unsaid.plan.scope.mode, unsaid.plan.scope.source], [false, 'all', 'global'])
  // The suppliers a call names set its scope.
  const named = aiAgentBusinessQueryPlan({ body: { message: 'Is anything late, and what do we owe Acme Components?' }, bq, goals: ['supplier_payables_due'], records: ['Acme Components'], alone: false })
  assert.deepEqual([named.plan.scope.mode, named.plan.scope.source, named.plan.scope.entityIds], ['single', 'explicit', ['SUP-001']])
  // A supplier the tenant does not have stays a clarification, whatever the model asked.
  const message = 'Compare Zenith Metals and Orbit Plastics on overdue purchase orders and payments.'
  for (const records of [[], ['Zenith Metals', 'Orbit Plastics']]) {
    const unknown = aiAgentBusinessQueryPlan({ body: { message }, bq, goals: ['supplier_comparison'], records, alone: true })
    assert.equal(unknown.plan.clarificationNeeded, true, records.join(','))
    assert.match(unknown.plan.ambiguities.join(','), /supplier_not_found|supplier_scope_unspecified/)
    assert.equal(unknown.plan.scope.source, 'clarification')
  }
})

test('a two-part question the business query would take is planned first: a skill and the business query, in one answer', async () => {
  const run = harness({ provider: calls(['receiving_issues', {}], [AI_AGENT_BUSINESS_QUERY, { goals: ['supplier_invoice_exceptions'] }]) })
  const { status, payload } = await run.ask(DOCK_BILLS)
  assert.equal(status, 200)
  assert.equal(run.plans.length, 1)
  assert.equal(payload.intent, 'compound')
  assert.deepEqual(payload.sections.map((section) => section.skillId), ['receiving_issues', 'business_query_plan_v1'])
  assert.deepEqual(payload.sections.map((section) => section.question), ['Receiving issues', 'Supplier checks'])
  assert.deepEqual(payload.businessQuery.sectionCards.map((card) => card.goal), ['supplier_invoice_exceptions'])
  assert.deepEqual(payload.skillRouting, { source: 'model', modelStatus: 'planned' })
  assert.equal(run.reads.length, 1)
  const agent = run.audits.at(-1).metadata.agent
  assert.equal(agent.entry, 'multi_part')
  assert.deepEqual(agent.calls.map((call) => [call.tool, call.served]), [['receiving_issues', true], [AI_AGENT_BUSINESS_QUERY, true]])
  assert.deepEqual(agent.calls[1].goals, ['supplier_invoice_exceptions'])
  assert.equal(run.audits.length, 1)
})

test('a business query call alone answers as the business query does', async () => {
  const run = harness({ provider: calls([AI_AGENT_BUSINESS_QUERY, { goals: ['supplier_overdue_purchase_orders'] }]) })
  const { payload } = await run.ask('Which suppliers are late and do they have unpaid invoices?')
  assert.equal(payload.intent, 'business_query_plan_v1')
  assert.deepEqual(payload.skillRouting, { source: 'model', modelStatus: 'planned' })
  const goals = payload.businessQuery.sectionCards.map((card) => card.goal)
  assert.ok(goals.includes('supplier_overdue_purchase_orders') && goals.includes('supplier_payables_due'))
  assert.equal(run.audits.at(-1).metadata.answerSource, 'business_query')
})

test('when the planner fails or declines, the business query answers as before, asked once', async () => {
  for (const [provider, degraded] of [[() => { throw new Error('down') }, true], [() => new Promise(() => {}), true], [() => ({ ok: true, toolCalls: [{ name: 'no_matching_skill', arguments: '{}' }] }), false]]) {
    const run = harness({ provider })
    const { payload } = await run.ask(DOCK_BILLS)
    assert.equal(run.plans.length, 1, 'the planner is asked once')
    assert.equal(payload.intent, 'business_query_plan_v1')
    assert.deepEqual(payload.businessQuery.sectionCards.map((card) => card.goal), ['supplier_invoice_exceptions'])
    assert.deepEqual(payload.agentPlanning, degraded ? { status: 'degraded', entry: 'multi_part' } : undefined)
    assert.equal(run.audits.length, 1)
    assert.equal(run.audits[0].metadata.agent.status, degraded ? 'degraded' : 'declined')
  }
})

test('with agent planning off, the business query path is unchanged and no model is asked', async () => {
  const run = harness({ env: { ...AGENT_ENV, FLOWCHAIN_AI_AGENT_MODE: 'off' }, provider: calls(['receiving_issues', {}]) })
  const { payload } = await run.ask(DOCK_BILLS)
  assert.equal(run.plans.length, 0)
  assert.equal(payload.intent, 'business_query_plan_v1')
  assert.equal(Object.hasOwn(payload, 'skillRouting'), false)
})
