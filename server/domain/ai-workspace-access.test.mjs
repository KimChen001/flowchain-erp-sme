import test from 'node:test'
import assert from 'node:assert/strict'
import { canCallConfiguredProvider, callConfiguredProvider } from './ai-runtime-provider-adapter-v2.mjs'
import { anthropicChatAdapter } from './ai-runtime-provider-specific-adapters-v2.mjs'
import { knowledgeProviderEnv } from './ai-knowledge-config.mjs'
import { AI_MONTHLY_CAP_DEFAULT_USD, aiMonthlyCapUsd, aiOptInRequired, modelFreeEnv, readAiWorkspaceAccess, withAiWorkspaceAccess } from './ai-workspace-access.mjs'
import { aiCallCostMicros, aiUsageMonth } from './ai-usage-meter.mjs'
import { aiSkillScenario } from './test-fixtures/ai-skill-scenario.mjs'
import { handleAiRuntimeGatewayRoute } from '../routes/ai-runtime-gateway.routes.mjs'

// Placeholder provider settings: every call goes to a stubbed fetch, so nothing
// is ever sent anywhere.
const PROVIDER = {
  FLOWCHAIN_AI_RUNTIME_MODE: 'provider_assisted',
  FLOWCHAIN_AI_PROVIDER_KIND: 'anthropic_chat',
  FLOWCHAIN_AI_PROVIDER_ENDPOINT: 'http://127.0.0.1:9/v1/chat/completions',
  FLOWCHAIN_AI_PROVIDER_API_KEY: 'placeholder',
  FLOWCHAIN_AI_PROVIDER_MODEL: 'claude-haiku-4-5',
}
const TENANT = 'tenant-ai-access'
const MONTH = aiUsageMonth(new Date())

// A stand-in for the two tables the access check reads and the meter writes.
function fakePrisma({ enabled = false, costMicros = 0, tenantId = TENANT } = {}) {
  const rows = new Map(costMicros ? [[`${tenantId}|${MONTH}`, { tenantId, month: MONTH, calls: 3, inputUnits: 0, outputUnits: 0, costMicros }]] : [])
  return {
    rows,
    tenant: { findUnique: async () => ({ operationalSettings: { ai: { modelAssistEnabled: enabled } } }) },
    aiUsageMonthly: {
      findUnique: async ({ where }) => rows.get(`${where.tenantId_month.tenantId}|${where.tenantId_month.month}`) || null,
      upsert: async ({ where, create, update }) => {
        const key = `${where.tenantId_month.tenantId}|${where.tenantId_month.month}`
        const row = rows.get(key)
        if (!row) { rows.set(key, { ...create }); return }
        for (const [field, change] of Object.entries(update)) row[field] += change.increment
      },
    },
  }
}
const reply = (usage) => async () => new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }], usage }), { status: 200, headers: { 'content-type': 'application/json' } })

test('a model-free environment closes every model path, whatever was configured', () => {
  const configured = { ...PROVIDER, FLOWCHAIN_KNOWLEDGE_PROVIDER: 'parley', FLOWCHAIN_AI_EMBEDDING_PROVIDER: 'openai', FLOWCHAIN_AI_AGENT_MODE: 'plan', FLOWCHAIN_AI_INTENT_ROUTING: 'true', FLOWCHAIN_ENABLE_AI_SEMANTIC_PLANNER: 'true' }
  assert.equal(canCallConfiguredProvider(configured), true)
  const closed = modelFreeEnv(configured)
  assert.equal(canCallConfiguredProvider(closed), false)
  assert.equal(canCallConfiguredProvider(knowledgeProviderEnv(closed)), false)
  assert.equal(closed.FLOWCHAIN_KNOWLEDGE_PROVIDER, undefined)
  assert.equal(closed.FLOWCHAIN_AI_EMBEDDING_PROVIDER, undefined)
  assert.deepEqual([closed.FLOWCHAIN_AI_AGENT_MODE, closed.FLOWCHAIN_AI_INTENT_ROUTING, closed.FLOWCHAIN_ENABLE_AI_SEMANTIC_PLANNER], ['off', 'false', 'false'])
})

test('the opt-in is required in production or when configured, and the cap defaults to 20 dollars', () => {
  assert.equal(aiOptInRequired({}), false)
  assert.equal(aiOptInRequired({ NODE_ENV: 'production' }), true)
  assert.equal(aiOptInRequired({ FLOWCHAIN_AI_WORKSPACE_OPT_IN: 'required' }), true)
  assert.equal(aiOptInRequired({ NODE_ENV: 'production', FLOWCHAIN_AI_WORKSPACE_OPT_IN: 'not_required' }), false)
  assert.equal(aiMonthlyCapUsd({}), AI_MONTHLY_CAP_DEFAULT_USD)
  assert.equal(aiMonthlyCapUsd({ FLOWCHAIN_AI_MONTHLY_CAP_USD: '5' }), 5)
  assert.equal(aiMonthlyCapUsd({ FLOWCHAIN_AI_MONTHLY_CAP_USD: 'lots' }), AI_MONTHLY_CAP_DEFAULT_USD)
})

test("a workspace's status: no provider, switched off, on, or over the cap", async () => {
  const required = { ...PROVIDER, FLOWCHAIN_AI_WORKSPACE_OPT_IN: 'required', FLOWCHAIN_AI_MONTHLY_CAP_USD: '20' }
  const status = async (env, prisma) => (await readAiWorkspaceAccess({ prisma, tenantId: TENANT, env })).status
  assert.equal(await status({ FLOWCHAIN_AI_WORKSPACE_OPT_IN: 'required' }, fakePrisma({ enabled: true })), 'no_provider')
  assert.equal(await status(PROVIDER, fakePrisma()), 'on', 'without the opt-in requirement (local development)')
  assert.equal(await status(required, fakePrisma()), 'off')
  assert.equal(await status(required, fakePrisma({ enabled: true, costMicros: 19_990_000 })), 'on')
  const over = await readAiWorkspaceAccess({ prisma: fakePrisma({ enabled: true, costMicros: 20_000_000 }), tenantId: TENANT, env: required })
  assert.deepEqual({ ...over, month: null }, { status: 'over_cap', providerConfigured: true, optInRequired: true, enabled: true, month: null, calls: 3, costUsd: 20, capUsd: 20 })
})

test('a switched-off workspace gets no model; a switched-on one is counted per call, with its cost', async () => {
  const env = { ...PROVIDER, FLOWCHAIN_AI_WORKSPACE_OPT_IN: 'required' }
  const ctx = (prisma) => ({ env, identity: { authenticated: true, tenantId: TENANT }, aiWorkspacePrisma: prisma })
  const off = fakePrisma()
  await withAiWorkspaceAccess(ctx(off), async (scoped) => {
    assert.equal(canCallConfiguredProvider(scoped.env), false)
    assert.equal(scoped.aiModelAccess, 'off')
  })
  const on = fakePrisma({ enabled: true })
  await withAiWorkspaceAccess(ctx(on), async (scoped) => {
    assert.equal(canCallConfiguredProvider(scoped.env), true)
    await callConfiguredProvider({ task: { type: 'skill_intent_classification', question: 'hi' } }, scoped.env, reply({ prompt_tokens: 2300, completion_tokens: 50 }))
    await callConfiguredProvider({ task: { type: 'skill_intent_classification', question: 'hi' } }, scoped.env, reply(undefined))
  })
  assert.deepEqual(on.rows.get(`${TENANT}|${MONTH}`), { tenantId: TENANT, month: MONTH, calls: 2, inputUnits: 2300, outputUnits: 50, costMicros: 2550 })
  // Outside an assistant request nothing is counted.
  await callConfiguredProvider({ task: { type: 'skill_intent_classification', question: 'hi' } }, env, reply({ prompt_tokens: 10, completion_tokens: 1 }))
  assert.equal(on.rows.get(`${TENANT}|${MONTH}`).calls, 2)
  // A request with no workspace never calls a model.
  await withAiWorkspaceAccess({ env, identity: { authenticated: false } }, async (scoped) => assert.equal(canCallConfiguredProvider(scoped.env), false))
  assert.equal(aiCallCostMicros({ inputTokens: 1_000_000, outputTokens: 1_000_000 }), 6_000_000, '$1 + $5 per million at the Haiku 4.5 defaults')
})

test("Anthropic's compatible endpoint gets a chat completion with max_tokens and a bearer key", () => {
  const config = { model: 'claude-haiku-4-5', apiKey: 'placeholder' }
  const body = anthropicChatAdapter.buildRequestBody({ task: { type: 'knowledge_rag', question: 'What is the policy?' }, evidencePackage: { citations: [] } }, config)
  assert.equal(body.model, 'claude-haiku-4-5')
  assert.equal(body.max_tokens, 1200)
  assert.equal(body.response_format, undefined, 'ignored by the endpoint, so not sent')
  assert.equal(anthropicChatAdapter.buildHeaders(config).authorization, 'Bearer placeholder')
})

test('over the cap, the assistant answers without a model and says so', async () => {
  const scenario = aiSkillScenario()
  const sent = []
  const picks = []
  const ctx = {
    ...scenario.ctx,
    req: { method: 'POST', headers: {} }, res: {}, url: new URL('http://local/api/ai-runtime/respond'),
    db: { __dataMode: 'user', purchaseOrders: [], products: [], suppliers: [] },
    env: { ...PROVIDER, FLOWCHAIN_PERSISTENCE_MODE: 'database', FLOWCHAIN_AI_WORKSPACE_OPT_IN: 'required', FLOWCHAIN_AI_INTENT_ROUTING: 'true' },
    aiWorkspacePrisma: fakePrisma({ enabled: true, costMicros: 25_000_000, tenantId: scenario.ctx.identity.tenantId }),
    aiSkillIntentProvider: async () => { picks.push(1); return { ok: false } },
    send: (_res, status, payload) => sent.push({ status, payload }),
    readBody: async () => ({ message: 'is there anything I should chase with the warehouse folks', answerLanguage: 'en-US' }),
  }
  ctx.repositories = { ...ctx.repositories, auditLog: { mode: 'database', recordAuditEntry: async (entry) => entry } }
  assert.equal(await handleAiRuntimeGatewayRoute(ctx), true)
  const { status, payload } = sent.at(-1)
  assert.equal(status, 200)
  assert.deepEqual(payload.aiModelAccess, { status: 'over_cap' })
  assert.equal(picks.length, 0, 'intent routing is off over the cap')
  // Other routes are not looked at, and pass through untouched.
  assert.equal(await handleAiRuntimeGatewayRoute({ ...ctx, url: new URL('http://local/api/reports/overview') }), false)
})
