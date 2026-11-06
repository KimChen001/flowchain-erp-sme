import test from 'node:test'
import assert from 'node:assert/strict'
import {
  AI_MODEL_FORBIDDEN_DECISIONS,
  AI_MODEL_OPTIONAL_TASKS,
  AI_MODEL_POLICIES,
  AI_MODEL_POLICY_DEFINITIONS,
  maybeUseLlmForDraftPolish,
  maybeUseLlmForWording,
  maybeDecomposeCompoundQueryWithModel,
  maybeRewriteCompoundQueryWithModel,
  maybeUseSmallModelForIntent,
  modelPolicyForAiIntent,
  routeAiModelPolicy,
  validateCompoundQueryRewrite,
} from './ai-model-router.mjs'
import { classifyAiBusinessIntent } from './ai-business-intent-router.mjs'
import { handleAiRoute } from '../routes/ai.routes.mjs'

function createRouteContext(body) {
  let response = null
  let providerDispatchCount = 0
  const db = {
    products: [{ sku: 'SKU-00412', name: 'Servo Motor', availableQuantity: 34, safetyStock: 50, riskLevel: '高', status: '低库存' }],
    suppliers: [{ id: 'SUP-001', name: 'ABC Components', risk: '中' }],
    purchaseOrders: [{ po: 'PO-2026-1282', supplier: 'ABC Components', status: '部分到货', eta: '2026-05-25' }],
    purchaseRequests: [],
    rfqs: [{ id: 'RFQ-26-0046', status: '进行中', suppliers: 3, quoted: 2 }],
    receivingDocs: [],
    inventoryMovements: [],
    forecastPlans: [],
    marketPrices: [],
    marketSignals: [],
    events: [],
    auditLog: [],
  }
  return {
    ctx: {
      req: { method: 'POST', headers: {}, body },
      res: {},
      url: new URL('/api/ai/chat', 'http://localhost'),
      db,
      readBody: async (req) => req.body,
      writeDb: async () => {},
      event: () => {},
      ensureRfqs: (database) => database.rfqs || [],
      ensurePurchaseRequests: (database) => database.purchaseRequests || [],
      ensureInventoryMovements: (database) => database.inventoryMovements || [],
      ensureEvents: (database) => database.events || [],
      ensureAuditLog: (database) => database.auditLog || [],
      supplierPerformance: (database) => database.suppliers || [],
      supplierRecommendations: () => null,
      supplierQuoteCount: 0,
      openaiDispatcher: { dispatch() { providerDispatchCount += 1; throw new Error('OpenAI should not be reached') } },
      arkDispatcher: { dispatch() { providerDispatchCount += 1; throw new Error('Ark should not be reached') } },
      aiMaxTokens: 120,
      repositories: {},
      send(_res, status, payload) {
        response = { status, payload }
      },
    },
    get response() {
      return response
    },
    get providerDispatchCount() {
      return providerDispatchCount
    },
  }
}

test('R137 model policy taxonomy defines deterministic optional provider and fallback policies', () => {
  for (const policy of [
    'deterministic_only',
    'small_model_optional',
    'llm_wording_optional',
    'llm_draft_optional',
    'provider_disabled',
    'guided_fallback',
    'compound_decomposition_shadow',
    'intent_classification_shadow',
    'query_rewrite_shadow',
  ]) {
    assert.ok(AI_MODEL_POLICY_DEFINITIONS[policy], policy)
    assert.equal(AI_MODEL_POLICY_DEFINITIONS[policy].modelMayRun, false, policy)
  }
  // Business query planning, skill routing and agent planning (P2) are the
  // only opt-in model decisions, and all are off by default.
  const modelPolicies = Object.entries(AI_MODEL_POLICY_DEFINITIONS).filter(([, definition]) => definition.modelMayRun)
  assert.deepEqual(modelPolicies.map(([policy]) => policy), ['business_query_planning', 'intent_routing', 'agent_planning'])
  for (const [policy, definition] of modelPolicies) assert.equal(definition.enabledByDefault, false, policy)
})

test('R147 shadow decomposition defaults to no-op and cannot override deterministic subqueries', async () => {
  const deterministicSubQueries = [
    { text: '今天有什么需要我做的', intent: 'today_cockpit_priority_query' },
    { text: '订单还有多少没有收货', intent: 'receiving_gap_query' },
  ]
  const shadow = await maybeDecomposeCompoundQueryWithModel({
    query: '今天有什么需要我做的，订单还有多少没有收货？',
    deterministicSubQueries,
    OPENAI_API_KEY: 'fake',
  })

  assert.equal(shadow.usedModel, false)
  assert.equal(shadow.provider, 'none')
  assert.equal(shadow.modelPolicy, 'compound_decomposition_shadow')
  assert.equal(shadow.deterministicFallback, true)
  assert.deepEqual(shadow.deterministicSubQueries, deterministicSubQueries)
  assert.deepEqual(shadow.modelSubQueries, [])
  assert.equal(shadow.providerCallsAllowed, false)
})

test('R148 query rewrite shadow defaults to no-op and validates unsafe rewrites', async () => {
  const rewrite = await maybeRewriteCompoundQueryWithModel({
    query: '订单还有多少没有收货？',
    OPENAI_API_KEY: 'fake',
    ARK_API_KEY: 'fake',
  })

  assert.equal(rewrite.usedModel, false)
  assert.equal(rewrite.provider, 'none')
  assert.equal(rewrite.modelPolicy, 'query_rewrite_shadow')
  assert.equal(rewrite.originalQuery, '订单还有多少没有收货？')
  assert.equal(rewrite.rewrittenQuery, '订单还有多少没有收货？')
  assert.equal(rewrite.rewriteAccepted, false)
  assert.equal(rewrite.providerCallsAllowed, false)

  const unsafeId = validateCompoundQueryRewrite({
    originalQuery: '订单还有多少没有收货？',
    rewrite: '请查询 PO-9999 并直接发送催货邮件',
  })
  assert.equal(unsafeId.accepted, false)
  assert.deepEqual(unsafeId.introducedIds, ['PO-9999'])
  assert.equal(unsafeId.actionExecution, true)

  const unsafeNumber = validateCompoundQueryRewrite({
    originalQuery: '哪些供应商有风险？',
    rewrite: '哪些供应商有 3 个高风险订单？',
  })
  assert.equal(unsafeNumber.accepted, false)
  assert.deepEqual(unsafeNumber.introducedNumbers, ['3'])

  const safeWithSessionId = validateCompoundQueryRewrite({
    originalQuery: '刚才那个 PO 还有多少没收货？',
    rewrite: 'PO-2026-1282 还有多少没收货？',
    sessionGrounding: { lastVisibleBusinessIds: { po: ['PO-2026-1282'] } },
  })
  assert.equal(safeWithSessionId.accepted, true)
})

test('R137 business fact intents stay deterministic and forbidden facts are explicit', () => {
  for (const intent of [
    'attention_overview_query',
    'today_cockpit_priority_query',
    'priority_explanation_query',
    'procurement_exception_query',
    'inventory_status_query',
    'rfq_followup_query',
    'supplier_followup_query',
    'relationship_reasoning_query',
    'data_limitation_query',
  ]) {
    assert.equal(modelPolicyForAiIntent(intent), 'deterministic_only', intent)
  }
  for (const forbidden of ['counts', 'status', 'dates', 'amounts', 'po_overdue_status', 'sku_risk', 'rfq_reply_counts', 'supplier_performance_facts', 'action_execution']) {
    assert.ok(AI_MODEL_FORBIDDEN_DECISIONS.includes(forbidden), forbidden)
  }
})

test('R137 intent router returns modelPolicy and broad attention remains deterministic by default', () => {
  const broad = classifyAiBusinessIntent({ question: '有什么需要我注意的？' })
  const draft = classifyAiBusinessIntent({ question: '帮我预览补货 PR 草稿' })
  const unknown = classifyAiBusinessIntent({ question: '写一首采购宣言' })

  assert.equal(broad.intent, 'attention_overview_query')
  assert.equal(broad.modelPolicy, 'deterministic_only')
  assert.equal(draft.intent, 'draft_preview_query')
  assert.equal(draft.modelPolicy, 'deterministic_only')
  assert.equal(unknown.modelPolicy, 'guided_fallback')
})

test('R138 no-op model router returns disabled metadata for optional small-model and LLM policies', async () => {
  const base = routeAiModelPolicy({ intent: 'attention_overview_query' })
  const small = await maybeUseSmallModelForIntent({ query: '有什么需要我注意的？' })
  const wording = await maybeUseLlmForWording({ fallbackAnswer: '确定性解释' })
  const draft = await maybeUseLlmForDraftPolish({ fallbackDraftText: '确定性草稿' })

  assert.deepEqual(base, {
    usedModel: false,
    modelPolicy: 'deterministic_only',
    reason: 'disabled_by_default',
    deterministicFallback: true,
    providerCallsAllowed: false,
    externalProvider: 'none',
    forbiddenDecisions: AI_MODEL_FORBIDDEN_DECISIONS,
  })
  assert.equal(small.usedModel, false)
  assert.equal(small.modelPolicy, 'small_model_optional')
  assert.deepEqual(small.optionalTasks, AI_MODEL_OPTIONAL_TASKS.smallModel)
  assert.equal(wording.usedModel, false)
  assert.equal(wording.modelPolicy, 'llm_wording_optional')
  assert.equal(wording.answer, '确定性解释')
  assert.equal(draft.usedModel, false)
  assert.equal(draft.modelPolicy, 'llm_draft_optional')
  assert.equal(draft.draftText, '确定性草稿')
})

test('R138 route keeps model router no-op and does not call providers by default', async () => {
  const previous = {
    AI_PROVIDER_ENABLED: process.env.AI_PROVIDER_ENABLED,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    ARK_API_KEY: process.env.ARK_API_KEY,
    DOUBAO_API_KEY: process.env.DOUBAO_API_KEY,
  }
  process.env.AI_PROVIDER_ENABLED = ''
  process.env.OPENAI_API_KEY = 'fake-openai-key'
  process.env.ARK_API_KEY = 'fake-ark-key'
  process.env.DOUBAO_API_KEY = 'fake-doubao-key'
  try {
    const route = createRouteContext({ moduleId: 'overview', message: '写一首采购宣言' })
    await handleAiRoute(route.ctx)

    assert.equal(route.response.status, 200)
    assert.equal(route.response.payload.intent.name, 'unknown_guided_fallback')
    assert.equal(route.response.payload.aiModelRoute.usedModel, false)
    assert.equal(route.response.payload.aiModelRoute.modelPolicy, 'guided_fallback')
    assert.equal(route.response.payload.aiModelRoute.providerCallsAllowed, false)
    assert.equal(route.providerDispatchCount, 0)
    assert.equal(JSON.stringify(route.response.payload).includes('fake-openai-key'), false)
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
})
