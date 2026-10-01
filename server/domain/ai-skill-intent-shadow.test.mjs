import test from 'node:test'
import assert from 'node:assert/strict'
import { aiSkillScenario } from './test-fixtures/ai-skill-scenario.mjs'
import { handleAiRuntimeGatewayRoute } from '../routes/ai-runtime-gateway.routes.mjs'
import { aiSkillIntentShadowEnabled, aiSkillIntentShadowInput, validateAiSkillIntentSuggestion } from './ai-skill-intent-shadow.mjs'
import { buildBoundedProviderRequestCore } from './ai-runtime-provider-specific-adapters-v2.mjs'
import { aiSkillActor } from './test-fixtures/ai-skill-scenario.mjs'

// Placeholder provider settings: the provider itself is a stub, so nothing
// is ever sent anywhere.
const SHADOW_ENV = {
  FLOWCHAIN_PERSISTENCE_MODE: 'database',
  FLOWCHAIN_AI_INTENT_SHADOW: 'true',
  FLOWCHAIN_AI_RUNTIME_MODE: 'provider_assisted',
  FLOWCHAIN_AI_PROVIDER_KIND: 'generic_http',
  FLOWCHAIN_AI_PROVIDER_ENDPOINT: 'http://127.0.0.1:9/shadow-test',
  FLOWCHAIN_AI_PROVIDER_API_KEY: 'placeholder',
  FLOWCHAIN_AI_INTENT_SHADOW_TIMEOUT_MS: '150',
}

function harness({ env = { FLOWCHAIN_PERSISTENCE_MODE: 'database' }, provider } = {}) {
  const scenario = aiSkillScenario()
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
const answer = (payload) => ({ intent: payload.intent, title: payload.conclusion.title, summary: payload.conclusion.summary, figures: payload.figures, evidence: payload.keyEvidence.map((item) => item.entityId) })

test('the shadow classifier is off unless switched on and a provider is set', async () => {
  assert.equal(aiSkillIntentShadowEnabled({}), false)
  assert.equal(aiSkillIntentShadowEnabled({ FLOWCHAIN_AI_INTENT_SHADOW: 'true' }), false)
  assert.equal(aiSkillIntentShadowEnabled({ ...SHADOW_ENV, FLOWCHAIN_AI_INTENT_SHADOW: 'false' }), false)
  assert.equal(aiSkillIntentShadowEnabled(SHADOW_ENV), true)
  const off = harness({ provider: reply({ skillId: 'purchase_orders' }) })
  await off.ask("What's the status of PO-001?")
  assert.equal(off.calls.length, 0)
  assert.equal(Object.hasOwn(off.audits[0].metadata, 'intentShadow'), false)
})

test('a suggestion is recorded beside the answer and never changes it', async () => {
  const baseline = answer(await harness().ask("What's the status of PO-001?"))
  const agreeing = harness({ env: SHADOW_ENV, provider: reply({ skillId: 'purchase_orders', mode: 'single', confidence: 0.92 }) })
  assert.deepEqual(answer(await agreeing.ask("What's the status of PO-001?")), baseline)
  assert.deepEqual(
    (({ status, skillId, mode, confidence, agrees }) => ({ status, skillId, mode, confidence, agrees }))(agreeing.audits[0].metadata.intentShadow),
    { status: 'ready', skillId: 'purchase_orders', mode: 'single', confidence: 0.92, agrees: true },
  )
  const disagreeing = harness({ env: SHADOW_ENV, provider: reply({ skillId: 'invoice_summary', confidence: 0.4 }) })
  assert.deepEqual(answer(await disagreeing.ask("What's the status of PO-001?")), baseline)
  assert.equal(disagreeing.audits[0].metadata.intentShadow.agrees, false)
  // A refusal stays a refusal whatever the model suggests.
  const refusal = harness({ env: SHADOW_ENV, provider: reply({ skillId: 'pending_approvals' }) })
  assert.equal((await refusal.ask('Approve PO-006 now')).intent, 'capability_overview')
})

test('the model sees the question and the skill list, no workspace data', async () => {
  const run = harness({ env: SHADOW_ENV, provider: reply({ skillId: 'purchase_orders' }) })
  await run.ask('Which purchase orders from Acme Components are open?')
  const [input] = run.calls
  assert.deepEqual(Object.keys(input.task).sort(), ['question', 'skills', 'type'])
  assert.equal(input.task.type, 'skill_intent_classification')
  const sent = JSON.stringify(input)
  // The question names Acme; nothing read from the workspace is added.
  for (const value of ['SUP-001', 'PO-001', 'LDM-001', 'Summit', '17,920', '7381', 'Flow Controller']) assert.ok(!sent.includes(value), value)
  // The bounded request core keeps the same fields, capped.
  const core = buildBoundedProviderRequestCore(aiSkillIntentShadowInput({ message: 'x'.repeat(5000), actor: aiSkillActor() }))
  assert.equal(core.task.question.length, 1200)
  assert.ok(core.task.skills.every((skill) => Object.keys(skill).sort().join() === 'description,id,modes'))
})

test('an invalid, slow or failing reply is recorded as degraded', async () => {
  const allowed = ['purchase_orders', 'inventory_availability']
  assert.deepEqual(validateAiSkillIntentSuggestion('{"skillId":"purchase_orders","mode":"teleport","confidence":7}', allowed), { valid: true, skillId: 'purchase_orders', mode: null, confidence: 1 })
  assert.equal(validateAiSkillIntentSuggestion('{"skillId":"invoice_summary"}', allowed).reason, 'unknown_skill')
  assert.equal(validateAiSkillIntentSuggestion('{"skillId":"approve_everything"}', allowed).reason, 'unknown_skill')
  assert.equal(validateAiSkillIntentSuggestion('not json', allowed).reason, 'malformed_output')
  assert.equal(validateAiSkillIntentSuggestion('```json\n{"skillId":"purchase_orders"}\n```', allowed).skillId, 'purchase_orders')
  const baseline = answer(await harness().ask('Which POs are overdue?'))
  for (const [provider, reason] of [
    [() => ({ ok: true, rawOutput: 'I think purchase orders' }), 'malformed_output'],
    [() => ({ ok: false, reason: 'non_success_status' }), 'non_success_status'],
    [() => { throw new Error('boom') }, 'provider_error'],
    [() => new Promise(() => {}), 'timeout'],
  ]) {
    const run = harness({ env: SHADOW_ENV, provider })
    const started = Date.now()
    assert.deepEqual(answer(await run.ask('Which POs are overdue?')), baseline, reason)
    assert.ok(Date.now() - started < 2000, reason)
    assert.deepEqual([run.audits[0].metadata.intentShadow.status, run.audits[0].metadata.intentShadow.reason], ['degraded', reason])
  }
})
