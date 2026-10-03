import test from 'node:test'
import assert from 'node:assert/strict'
import { aiSkillScenario } from './test-fixtures/ai-skill-scenario.mjs'
import { handleAiRuntimeGatewayRoute } from '../routes/ai-runtime-gateway.routes.mjs'
import { AI_SKILL_INTENT_ROUTING_MIN_CONFIDENCE, aiSkillIntentRoutingEnabled, routeAiSkillIntent } from './ai-skill-intent-routing.mjs'
import { aiSkillActor } from './test-fixtures/ai-skill-scenario.mjs'

// Placeholder provider settings: the provider itself is a stub, so nothing
// is ever sent anywhere.
const ROUTING_ENV = {
  FLOWCHAIN_PERSISTENCE_MODE: 'database',
  FLOWCHAIN_AI_INTENT_ROUTING: 'true',
  FLOWCHAIN_AI_RUNTIME_MODE: 'provider_assisted',
  FLOWCHAIN_AI_PROVIDER_KIND: 'generic_http',
  FLOWCHAIN_AI_PROVIDER_ENDPOINT: 'http://127.0.0.1:9/routing-test',
  FLOWCHAIN_AI_PROVIDER_API_KEY: 'placeholder',
  FLOWCHAIN_AI_INTENT_ROUTING_TIMEOUT_MS: '150',
}

function harness({ env = ROUTING_ENV, provider, roleKey } = {}) {
  const scenario = aiSkillScenario(roleKey ? { roleKey } : {})
  const audits = []
  const sent = []
  const calls = []
  const ctx = {
    ...scenario.ctx,
    req: { method: 'POST', headers: {} }, res: {}, url: new URL('http://local/api/ai-runtime/respond'),
    db: { __dataMode: 'user', purchaseOrders: [], products: [], suppliers: [] },
    env,
    send: (_res, status, payload) => sent.push({ status, payload }),
    ...(provider ? { aiSkillIntentProvider: async (input) => { calls.push(input); return provider(input) } } : {}),
  }
  ctx.repositories = { ...ctx.repositories, auditLog: { mode: 'database', recordAuditEntry: async (entry) => { audits.push(entry); return entry } } }
  const ask = async (message) => {
    ctx.readBody = async () => ({ message, answerLanguage: 'en-US' })
    await handleAiRuntimeGatewayRoute(ctx)
    return sent.at(-1).payload
  }
  return { ask, audits, calls }
}

const reply = (value) => () => ({ ok: true, rawOutput: { conclusion: { summary: JSON.stringify(value) } } })
const UNMATCHED = 'is there anything I should chase with the warehouse folks'

test('routing is off unless switched on and a provider is set', async () => {
  assert.equal(aiSkillIntentRoutingEnabled({}), false)
  assert.equal(aiSkillIntentRoutingEnabled({ FLOWCHAIN_AI_INTENT_ROUTING: 'true' }), false)
  assert.equal(aiSkillIntentRoutingEnabled({ ...ROUTING_ENV, FLOWCHAIN_AI_INTENT_ROUTING: 'false' }), false)
  assert.equal(aiSkillIntentRoutingEnabled(ROUTING_ENV), true)
  const off = harness({ env: { FLOWCHAIN_PERSISTENCE_MODE: 'database' }, provider: reply({ skillId: 'receiving_issues', confidence: 0.9 }) })
  const payload = await off.ask(UNMATCHED)
  assert.equal(off.calls.length, 0)
  assert.equal(payload.intent, 'capability_overview')
  assert.equal(Object.hasOwn(payload, 'skillRouting'), false)
  assert.equal(Object.hasOwn(off.audits[0].metadata, 'intentRouting'), false)
})

test('a question no rule matched is answered by the skill the model picks, from the same facts', async () => {
  const run = harness({ provider: reply({ skillId: 'receiving_issues', mode: null, confidence: 0.86 }) })
  const payload = await run.ask(UNMATCHED)
  assert.equal(run.calls.length, 1)
  assert.equal(payload.intent, 'receiving_issues')
  assert.deepEqual(payload.skillRouting, { source: 'model', modelStatus: 'routed' })
  assert.equal(payload.answerSource, 'workspace_rules')
  // The same skill chosen by a rule gives the same answer.
  const ruled = await harness({ provider: reply({ skillId: 'today_priorities', confidence: 0.9 }) }).ask('Which receipts need attention?')
  assert.equal(ruled.intent, 'receiving_issues')
  assert.deepEqual(payload.keyEvidence.map((item) => item.entityId), ruled.keyEvidence.map((item) => item.entityId))
  assert.equal(payload.conclusion.title, ruled.conclusion.title)
  // The model saw the question and the actor's skills, nothing from the workspace.
  const sent = JSON.stringify(run.calls[0])
  assert.equal(run.calls[0].task.question, UNMATCHED)
  assert.equal(run.calls[0].modelPolicy, 'intent_routing')
  assert.doesNotMatch(sent, /GRN-00|PO-00|SUP-00|Flow Controller|tenant/i)
  const audit = run.audits[0].metadata.intentRouting
  assert.equal(audit.status, 'routed')
  assert.equal(audit.skillId, 'receiving_issues')
  assert.equal(audit.confidence, 0.86)
  assert.equal(typeof audit.latencyMs, 'number')
})

test('rules, chips, refusals, outside questions and unread record numbers never reach the model', async () => {
  const run = harness({ provider: reply({ skillId: 'receiving_issues', confidence: 0.99 }) })
  assert.equal((await run.ask('list open RFQs')).intent, 'rfq_followups')
  assert.equal((await run.ask('What should I handle first today?')).intent, 'today_priorities')
  assert.equal((await run.ask('Approve PO-001')).intent, 'capability_overview')
  assert.equal((await run.ask('What is the weather?')).intent, 'capability_overview')
  assert.equal((await run.ask('What is the status of INV-777?')).intent, 'capability_overview')
  assert.equal((await run.ask("What's the status of PO-001?")).intent, 'purchase_orders')
  assert.equal(run.calls.length, 0)
})

test('greetings and test messages get the topic answer without a model call', async () => {
  const run = harness({ provider: reply({ skillId: 'purchase_orders', confidence: 0.9 }) })
  const supplier = await run.ask('supplier test')
  assert.equal(supplier.intent, 'capability_overview')
  assert.match(supplier.conclusion.summary, /about suppliers/)
  for (const message of ['hello', 'hi there', '测试一下', '供应商测试']) assert.equal((await run.ask(message)).intent, 'capability_overview', message)
  assert.equal(run.calls.length, 0)
  // A question is not a greeting, even a short one.
  assert.equal((await run.ask('any test results?')).intent, 'purchase_orders')
  assert.equal(run.calls.length, 1)
})

test('a reply that wraps the JSON in a fence or explains itself is still read', async () => {
  const fenced = (body) => () => ({ ok: true, rawOutput: { conclusion: { summary: body } } })
  for (const body of [
    '```json\n{ "skillId": "receiving_issues", "mode": null, "confidence": 0.9 }\n```\n\nThe question is about goods at the dock.',
    'Here you go: { "skillId": "receiving_issues", "confidence": 0.9 } as asked.',
  ]) {
    const payload = await harness({ provider: fenced(body) }).ask(UNMATCHED)
    assert.equal(payload.intent, 'receiving_issues', body)
  }
  const declined = harness({ provider: fenced('```json\n{"skillId": "capability_overview", "mode": null, "confidence": 0.95}\n```\nThis is about sales, which the workspace does not cover.') })
  await declined.ask(UNMATCHED)
  assert.equal(declined.audits[0].metadata.intentRouting.reason, 'no_skill')
})

test('the capability answer stays when the model picks no skill, is unsure, fails or is slow', async () => {
  const cases = [
    [reply({ skillId: 'capability_overview', confidence: 0.95 }), 'declined', 'no_skill'],
    [reply({ skillId: 'receiving_issues', confidence: AI_SKILL_INTENT_ROUTING_MIN_CONFIDENCE - 0.01 }), 'declined', 'low_confidence'],
    [reply({ skillId: 'receiving_issues' }), 'declined', 'low_confidence'],
    [reply({ skillId: 'approve_everything', confidence: 0.99 }), 'degraded', 'unknown_skill'],
    [() => ({ ok: true, rawOutput: { conclusion: { summary: 'Sure! I think receiving.' } } }), 'degraded', 'malformed_output'],
    [() => { throw new Error('boom') }, 'degraded', 'provider_error'],
    [() => new Promise(() => {}), 'degraded', 'timeout'],
  ]
  for (const [provider, status, reason] of cases) {
    const run = harness({ provider })
    const payload = await run.ask(UNMATCHED)
    assert.equal(payload.intent, 'capability_overview', reason)
    assert.deepEqual(payload.skillRouting, { source: 'rules', modelStatus: status }, reason)
    assert.equal(run.audits[0].metadata.intentRouting.status, status, reason)
    assert.equal(run.audits[0].metadata.intentRouting.reason, reason, reason)
  }
})

test('the model may not pick a skill a rule excluded for the question', async () => {
  // Sales orders and deliveries that already arrived late are not purchase
  // order questions, whatever the model thinks.
  for (const question of ['Which sales orders are overdue?', 'Which POs were delivered late?', 'Which invoices are late?']) {
    const run = harness({ provider: reply({ skillId: 'purchase_orders', confidence: 0.95 }) })
    const payload = await run.ask(question)
    assert.equal(run.calls.length, 1, question)
    assert.equal(payload.intent, 'capability_overview', question)
    assert.equal(run.audits[0].metadata.intentRouting.reason, 'excluded_by_rule', question)
  }
  // No skill measures deliveries that already arrived late, receipts included.
  const late = harness({ provider: reply({ skillId: 'receiving_issues', confidence: 0.9 }) })
  assert.equal((await late.ask('Which POs were delivered late?')).intent, 'capability_overview')
  // A skill the rule did not exclude is still allowed.
  const allowed = harness({ provider: reply({ skillId: 'inventory_availability', confidence: 0.9 }) })
  assert.equal((await allowed.ask('Which sales orders are overdue?')).intent, 'inventory_availability')
})

test('a request still open at the timeout is aborted', async () => {
  let signal
  const provider = (_input, _env, fetchImpl) => fetchImpl('http://127.0.0.1:9/never', { method: 'POST' })
  const fetchImpl = (_url, init) => { signal = init.signal; return new Promise(() => {}) }
  const result = await routeAiSkillIntent({ message: UNMATCHED, actor: aiSkillActor(), env: ROUTING_ENV, provider, fetchImpl })
  assert.equal(result.status, 'degraded')
  assert.equal(result.reason, 'timeout')
  assert.equal(signal.aborted, true)
})

test('the model can only pick a skill the actor may use', async () => {
  const viewer = aiSkillActor('intake-uploader')
  const result = await routeAiSkillIntent({ message: UNMATCHED, actor: viewer, env: ROUTING_ENV, provider: reply({ skillId: 'receiving_issues', confidence: 0.99 }) })
  assert.equal(result.status, 'degraded')
  assert.equal(result.reason, 'unknown_skill')
})
