import test from 'node:test'
import assert from 'node:assert/strict'
import { aiSkillActor, aiSkillScenario } from './test-fixtures/ai-skill-scenario.mjs'
import { handleAiRuntimeGatewayRoute } from '../routes/ai-runtime-gateway.routes.mjs'
import { AI_AGENT_LIMITS, aiAgentPlanningEnabled, aiAgentTools, validateAiAgentToolCalls } from './ai-agent-planning.mjs'

// Placeholder provider settings: the provider is a scripted stub, so nothing
// is ever sent anywhere.
const AGENT_ENV = {
  FLOWCHAIN_PERSISTENCE_MODE: 'database',
  FLOWCHAIN_AI_AGENT_MODE: 'plan',
  FLOWCHAIN_AI_INTENT_ROUTING: 'true',
  FLOWCHAIN_AI_RUNTIME_MODE: 'provider_assisted',
  FLOWCHAIN_AI_PROVIDER_KIND: 'parley_chat',
  FLOWCHAIN_AI_PROVIDER_ENDPOINT: 'http://127.0.0.1:9/agent-test',
  FLOWCHAIN_AI_PROVIDER_API_KEY: 'placeholder',
  FLOWCHAIN_AI_PROVIDER_MODEL: 'placeholder-model',
  FLOWCHAIN_AI_AGENT_TIMEOUT_MS: '150',
}
const ACME = "Check Acme's outstanding orders, explain which need follow-up under our purchasing policy, and prepare a message asking about partial delivery."
const ACME_ZH = '查一下 Acme 的未完成订单，按我们的采购政策说明哪些需要跟进，并准备一封询问部分交货的邮件。'
const UNMATCHED = 'is there anything I should chase with the warehouse folks'

function harness({ env = AGENT_ENV, provider, roleKey } = {}) {
  const scenario = aiSkillScenario(roleKey ? { roleKey } : {})
  const audits = []
  const sent = []
  const plans = []
  const picks = []
  const ctx = {
    ...scenario.ctx,
    req: { method: 'POST', headers: {} }, res: {}, url: new URL('http://local/api/ai-runtime/respond'),
    db: { __dataMode: 'user', purchaseOrders: [], products: [], suppliers: [] },
    env,
    send: (_res, status, payload) => sent.push({ status, payload }),
    ...(provider ? { aiAgentProvider: async (input) => { plans.push(input); return provider(input) } } : {}),
    aiSkillIntentProvider: async (input) => { picks.push(input); return { ok: true, rawOutput: { conclusion: { summary: JSON.stringify({ skillId: 'receiving_issues', confidence: 0.9 }) } } } },
  }
  ctx.repositories = { ...ctx.repositories, auditLog: { mode: 'database', recordAuditEntry: async (entry) => { audits.push(entry); return entry } } }
  const ask = async (message, answerLanguage = 'en-US') => {
    ctx.readBody = async () => ({ message, answerLanguage })
    await handleAiRuntimeGatewayRoute(ctx)
    return sent.at(-1).payload
  }
  return { ask, audits, plans, picks }
}

const calls = (...list) => () => ({ ok: true, toolCalls: list.map(([name, args]) => ({ name, arguments: JSON.stringify(args) })), usage: { inputTokens: 900, outputTokens: 60 } })
const agentAudit = (run) => run.audits.at(-1).metadata.agent

test('agent planning is off unless switched on with a tool-calling provider', () => {
  assert.equal(aiAgentPlanningEnabled({}), false)
  assert.equal(aiAgentPlanningEnabled({ ...AGENT_ENV, FLOWCHAIN_AI_AGENT_MODE: 'off' }), false)
  assert.equal(aiAgentPlanningEnabled({ ...AGENT_ENV, FLOWCHAIN_AI_PROVIDER_KIND: 'generic_http' }), false)
  assert.equal(aiAgentPlanningEnabled({ ...AGENT_ENV, FLOWCHAIN_AI_RUNTIME_MODE: 'local' }), false)
  assert.equal(aiAgentPlanningEnabled(AGENT_ENV), true)
})

test("the tools are the actor's own skills, with records and only the inventory mode as arguments", () => {
  const tools = aiAgentTools(aiSkillActor())
  const names = tools.map((tool) => tool.function.name)
  assert.ok(names.includes('purchase_orders') && names.includes('prepare_action_draft'))
  assert.equal(names.includes('capability_overview'), false)
  const inventory = tools.find((tool) => tool.function.name === 'inventory_availability').function.parameters
  assert.deepEqual(inventory.properties.mode.enum, ['overview', 'short'])
  assert.equal(inventory.additionalProperties, false)
  assert.equal(tools.find((tool) => tool.function.name === 'purchase_orders').function.parameters.properties.mode, undefined)
  // A role sees only its own skills: one that reads no business data has none.
  assert.deepEqual(aiAgentTools(aiSkillActor('intake-uploader')), [])
})

test('calls are kept only with known tools, known arguments and records the question contains', () => {
  const tools = aiAgentTools(aiSkillActor())
  const message = 'Which orders from Ａｃｍｅ are late, and what about LDM-001?'
  const { calls: kept, dropped } = validateAiAgentToolCalls([
    { name: 'purchase_orders', arguments: '{"records":["acme"]}' },
    { name: 'purchase_orders', arguments: { records: ['ACME'] } },
    { name: 'inventory_availability', arguments: '{"mode":"short","records":["LDM-001"]}' },
    { name: 'delete_everything', arguments: '{}' },
    { name: 'purchase_orders', arguments: '{"records":["Summit Packaging"]}' },
    { name: 'receiving_issues', arguments: '{"supplierId":"SUP-001"}' },
    { name: 'invoice_summary', arguments: 'not json' },
    { name: 'inventory_availability', arguments: '{"mode":"everything"}' },
    { name: 'pending_approvals', arguments: '{}' },
    { name: 'workspace_metrics', arguments: '{}' },
  ], { message, tools })
  assert.deepEqual(kept, [
    { tool: 'purchase_orders', mode: null, records: ['acme'] },
    { tool: 'inventory_availability', mode: 'short', records: ['LDM-001'] },
    { tool: 'pending_approvals', mode: null, records: [] },
  ])
  assert.deepEqual(dropped.map((row) => row.reason), ['unknown_tool', 'record_not_in_question', 'invalid_arguments', 'invalid_arguments', 'invalid_arguments', 'over_limit'])
  assert.equal(kept.length, AI_AGENT_LIMITS.maxTools)
})

test('the Acme request goes to the planner and gets one answer: its orders and drafts for Acme only', async () => {
  const run = harness({ provider: calls(['purchase_orders', { records: ['Acme'] }], ['prepare_action_draft', { records: ['Acme'] }]) })
  const payload = await run.ask(ACME)
  assert.equal(run.plans.length, 1)
  assert.equal(run.picks.length, 0, 'agent planning replaces the one-skill pick')
  assert.equal(payload.intent, 'compound')
  assert.deepEqual(payload.sections.map((section) => [section.skillId, section.mode]), [['purchase_orders', 'supplier'], ['prepare_action_draft', null]])
  assert.deepEqual(payload.skillRouting, { source: 'model', modelStatus: 'planned' })
  const orders = JSON.stringify(payload.sections[0]) + JSON.stringify(payload.keyEvidence)
  assert.match(orders, /PO-001/)
  assert.match(orders, /PO-008/)
  assert.ok(payload.reviewCards.length > 0)
  assert.ok(payload.reviewCards.every((card) => card.payload?.supplierId === 'SUP-001'), 'drafts follow the supplier the question names')
  // The model saw the question and the tools, never business data.
  const seen = JSON.stringify(run.plans[0])
  assert.equal(run.plans[0].task.type, 'agent_planning')
  for (const secret of ['PO-001', 'PO-008', 'Summit', 'Acme Components', 'SUP-001', '19120']) assert.equal(seen.includes(secret), false, secret)
  // The audit row: codes and counts, never the question or the records' text.
  const agent = agentAudit(run)
  assert.deepEqual({ ...agent, latencyMs: 0 }, {
    phase: 'plan', entry: 'multi_part', status: 'planned', reason: null, provider: 'parley_chat', latencyMs: 0, modelCalls: 1,
    calls: [{ tool: 'purchase_orders', mode: null, records: 1, served: true }, { tool: 'prepare_action_draft', mode: null, records: 1, served: true }],
    dropped: [], inputTokens: 900, outputTokens: 60,
  })
  assert.equal(JSON.stringify(run.audits.at(-1)).includes('Acme'), false)
})

test('the Chinese Acme request goes to the planner too', async () => {
  const run = harness({ provider: calls(['purchase_orders', { records: ['Acme'] }], ['prepare_action_draft', { records: ['Acme'] }]) })
  const payload = await run.ask(ACME_ZH, 'zh-CN')
  assert.equal(run.plans.length, 1)
  assert.equal(payload.intent, 'compound')
  assert.equal(payload.language, 'zh-CN')
  assert.equal(agentAudit(run).entry, 'multi_part')
})

test('a planner that fails leaves the rules answer, marked as limited', async () => {
  for (const provider of [() => { throw new Error('down') }, () => new Promise(() => {}), calls(['purchase_orders', { records: ['Summit Packaging'] }])]) {
    const run = harness({ provider })
    const payload = await run.ask(ACME)
    assert.equal(payload.intent, 'prepare_action_draft', 'the rules answer stays')
    assert.deepEqual(payload.agentPlanning, { status: 'degraded', entry: 'multi_part' })
    assert.equal(payload.skillRouting.source, 'rules')
    assert.equal(agentAudit(run).status, 'degraded')
  }
  // A model that calls no tool is not a failure: the rules answer, unmarked.
  const declined = harness({ provider: () => ({ ok: true, rawOutput: { conclusion: { summary: 'I would look at the orders.' } } }) })
  const payload = await declined.ask(ACME)
  assert.equal(payload.agentPlanning, undefined)
  assert.equal(agentAudit(declined).reason, 'no_tool_call')
})

test('a question no rule matched is answered by the planned skill, without the one-skill pick', async () => {
  const run = harness({ provider: calls(['receiving_issues', {}]) })
  const payload = await run.ask(UNMATCHED)
  assert.equal(payload.intent, 'receiving_issues')
  assert.deepEqual(payload.skillRouting, { source: 'model', modelStatus: 'planned' })
  assert.equal(run.picks.length, 0)
  assert.equal(agentAudit(run).entry, 'unmatched')
})

test('rules, instructions and one-part questions never reach the planner', async () => {
  const run = harness({ provider: calls(['receiving_issues', {}]) })
  assert.equal((await run.ask('Which purchase orders are overdue?')).intent, 'purchase_orders')
  assert.equal((await run.ask('Approve PO-001 and email Acme')).intent, 'capability_overview')
  assert.equal(run.plans.length, 0)
  // Off: nothing changes and no model is asked.
  const off = harness({ env: { ...AGENT_ENV, FLOWCHAIN_AI_AGENT_MODE: 'off', FLOWCHAIN_AI_INTENT_ROUTING: 'false' }, provider: calls(['purchase_orders', { records: ['Acme'] }]) })
  const payload = await off.ask(ACME)
  assert.equal(off.plans.length, 0)
  assert.equal(payload.intent, 'prepare_action_draft')
  assert.equal(Object.hasOwn(payload, 'skillRouting'), false)
})
