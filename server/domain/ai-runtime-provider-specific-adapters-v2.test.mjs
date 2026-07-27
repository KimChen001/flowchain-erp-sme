import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import test from 'node:test'
import {
  buildBoundedProviderRequestCore,
  deepseekChatAdapter,
  doubaoChatAdapter,
  extractCandidateFromProviderResponse,
  isProviderSpecificKind,
  openaiResponsesAdapter,
  providerSpecificAdapters,
  selectProviderSpecificAdapter,
} from './ai-runtime-provider-specific-adapters-v2.mjs'
import {
  buildProviderInputPackageV2,
  canCallConfiguredProvider,
  FORBIDDEN_AI_RUNTIME_PROVIDER_ACTION_PATTERN,
  FORBIDDEN_AI_RUNTIME_PROVIDER_TECHNICAL_PATTERN,
  selectProviderAdapter,
} from './ai-runtime-provider-adapter-v2.mjs'
import { buildAiRuntimeResponseV2, buildAiRuntimeResponseV2Async } from './ai-runtime-gateway-v2.mjs'
import { buildAiRuntimeEvaluationV2 } from './ai-runtime-observability-v2.mjs'

const providerKinds = ['openai_responses', 'deepseek_chat', 'doubao_chat']
import { createProductReviewScenarioDb } from './test-fixtures/product-review-scenario.mjs'

function loadDb() {
  return createProductReviewScenarioDb()
}

function visibleText(value) {
  if (Array.isArray(value)) return value.map(visibleText).join(' ')
  if (!value || typeof value !== 'object') return String(value ?? '')
  return Object.entries(value)
    .filter(([key]) => !/^(id|sourceId|responseId|query|intent|entityType|entityId|moduleId|linkTarget|returnContext|returnTo|source|reason|draftType|payload|originEvidence|mode|providerContract|reasonCode|evaluationId)$/i.test(key))
    .map(([, item]) => visibleText(item))
    .join(' ')
}

function assertCleanVisible(value) {
  const text = visibleText(value)
  assert.doesNotMatch(text, FORBIDDEN_AI_RUNTIME_PROVIDER_TECHNICAL_PATTERN)
  assert.doesNotMatch(text, FORBIDDEN_AI_RUNTIME_PROVIDER_ACTION_PATTERN)
  assert.doesNotMatch(text, /provider|model|endpoint|API|key|token|JSON|payload|fallback|mock|OpenAI|DeepSeek|Doubao|豆包/i)
}

function assertRuntimeResponse(response) {
  assert.equal(response.version, 'v2')
  assert.ok(response.conclusion?.title)
  assert.ok(response.keyEvidence?.length > 0)
  assert.ok(response.navigationLinks.every((link) => link.returnTo === 'ai-assistant'))
  assert.ok(response.reviewCards.every((card) => card.previewOnly && card.reviewRequired && card.requiresHumanReview))
  assert.equal(response.dataScopeLabel, '当前工作区数据')
}

function localDraft(question = '今天有什么需要我处理？') {
  return buildAiRuntimeResponseV2(loadDb(), { message: question, activeModuleId: 'overview' }).body
}

function providerInput(question = '今天有什么需要我处理？') {
  const draft = localDraft(question)
  return buildProviderInputPackageV2({
    requestIntent: { id: draft.intent, label: draft.conclusion.title },
    supportedEntityTypes: ['PR', 'RFQ', 'PO', 'GRN', 'Invoice', 'Supplier', 'SKU'],
    evidenceSources: draft.sourceSummary,
    navigationIndex: draft.navigationLinks,
    dataLimitations: draft.dataLimitations,
  }, { message: question.repeat(80) }, draft)
}

async function withServer(handler, run) {
  const server = http.createServer(handler)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  try {
    return await run(`http://127.0.0.1:${address.port}`)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

function envFor(kind, endpoint = 'http://127.0.0.1:1', extra = {}) {
  return {
    FLOWCHAIN_AI_RUNTIME_MODE: 'provider_assisted',
    FLOWCHAIN_AI_PROVIDER_KIND: kind,
    FLOWCHAIN_AI_PROVIDER_ENDPOINT: endpoint,
    FLOWCHAIN_AI_PROVIDER_API_KEY: 'test-key',
    FLOWCHAIN_AI_PROVIDER_MODEL: 'test-runtime-model',
    ...extra,
  }
}

function responseFor(kind, text = '建议查看来源证据、数据限制和人工复核入口。') {
  if (kind === 'openai_responses') return { output_text: text }
  if (kind === 'deepseek_chat') return { choices: [{ message: { content: text } }] }
  return { output: { text } }
}

test('provider-specific registry supports configured kinds and disables unknown kinds', () => {
  assert.deepEqual(providerSpecificAdapters.map((item) => item.kind), providerKinds)
  assert.equal(isProviderSpecificKind('openai_responses'), true)
  assert.equal(isProviderSpecificKind('deepseek_chat'), true)
  assert.equal(isProviderSpecificKind('doubao_chat'), true)
  assert.equal(isProviderSpecificKind('unknown'), false)
  assert.equal(selectProviderSpecificAdapter('missing'), null)
  assert.equal(selectProviderAdapter({ FLOWCHAIN_AI_PROVIDER_KIND: 'generic_http' })?.id, 'generic-http-provider-adapter-v2')
  assert.equal(selectProviderAdapter({ FLOWCHAIN_AI_PROVIDER_KIND: 'openai_responses' })?.kind, 'openai_responses')
  assert.equal(canCallConfiguredProvider({}), false)
  assert.equal(canCallConfiguredProvider(envFor('openai_responses', 'http://local', { FLOWCHAIN_AI_PROVIDER_MODEL: '' })), false)
})

test('provider-specific request bodies are bounded and exclude secrets full data and endpoints', () => {
  const input = providerInput()
  for (const adapter of [openaiResponsesAdapter, deepseekChatAdapter, doubaoChatAdapter]) {
    const body = adapter.buildRequestBody(input, { model: 'test-runtime-model', apiKey: 'test-key', endpoint: 'http://127.0.0.1/private' })
    const core = buildBoundedProviderRequestCore(input)
    assert.ok(core.evidencePackage.keyEvidence.length <= 12)
    assert.ok(core.evidencePackage.sourceSummary.length <= 12)
    assert.ok(core.evidencePackage.supportedEntityTypes.length <= 20)
    assert.ok(core.evidencePackage.dataLimitations.length <= 12)
    assert.ok(core.evidencePackage.readinessSignals.length <= 12)
    assert.ok(core.task.question.length <= 1200)
    assert.ok(core.safetyPolicy.reviewRequired)
    assert.ok(core.safetyPolicy.previewOnly)
    assert.ok(core.safetyPolicy.allowedActions.length > 0)
    const serialized = JSON.stringify(body)
    assert.doesNotMatch(serialized, /test-key|127\.0\.0\.1|FLOWCHAIN|localStorage|auth|credential|purchaseOrders|supplierInvoices|receivingDocs|writesDb|writesFiles|tenantId|userId|datasetId/)
  }
})

test('provider-specific output extraction supports common response shapes', () => {
  const cases = [
    { output_text: 'open text' },
    { output: [{ content: [{ text: 'content array text' }] }] },
    { choices: [{ message: { content: 'choice text' } }] },
    { output: { text: 'output text' } },
    { message: { content: 'message text' } },
    'plain text',
  ]
  for (const item of cases) {
    const extracted = extractCandidateFromProviderResponse(item)
    assert.equal(extracted.ok, true)
    assert.match(extracted.rawOutput.conclusion.summary, /text|plain/)
  }
  assert.deepEqual(extractCandidateFromProviderResponse({ nope: true }), { ok: false, reason: 'malformed_output' })
  assert.deepEqual(extractCandidateFromProviderResponse({}), { ok: false, reason: 'malformed_output' })
})

test('provider-specific adapters call fake servers and extract safe candidates', async () => {
  for (const kind of providerKinds) {
    let requestBody = null
    const result = await withServer((req, res) => {
      let body = ''
      req.on('data', (chunk) => { body += chunk })
      req.on('end', () => {
        requestBody = JSON.parse(body)
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(responseFor(kind)))
      })
    }, async (endpoint) => {
      const adapter = selectProviderSpecificAdapter(kind)
      return adapter.call(providerInput(), envFor(kind, endpoint))
    })
    assert.equal(result.ok, true, kind)
    assert.match(result.rawOutput.conclusion.summary, /来源证据/)
    assert.ok(requestBody)
    assert.doesNotMatch(JSON.stringify(requestBody), /test-key|127\.0\.0\.1|purchaseOrders|supplierInvoices/)
  }
})

test('runtime success path for provider-specific kinds remains evidence bounded and review first', async () => {
  for (const kind of providerKinds) {
    const result = await withServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(responseFor(kind, '建议先查看当前证据、数据限制和人工复核入口。')))
    }, async (endpoint) => buildAiRuntimeResponseV2Async(loadDb(), { message: '今天有什么需要我处理？' }, { env: envFor(kind, endpoint) }))
    assert.equal(result.status, 200, kind)
    assertRuntimeResponse(result.body)
    assert.match(result.body.conclusion.summary, /当前证据|人工复核/)
    assert.ok(result.body.recommendedActions.every((item) => ['查看证据', '预览草稿', '进入人工复核', '打开来源对象', '打开相关模块', '标记仅内部留存', '补充数据', '查看数据限制'].includes(item.label)))
    assertCleanVisible(result.body)
    assert.doesNotMatch(JSON.stringify(result.body), /test-key|127\.0\.0\.1|OpenAI|DeepSeek|Doubao|豆包/)
  }
})

test('unsafe provider-specific output falls back to local evidence with business limitation', async () => {
  for (const kind of providerKinds) {
    const result = await withServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(responseFor(kind, '可以自动批准并发送给供应商，也可以直接付款。')))
    }, async (endpoint) => buildAiRuntimeResponseV2Async(loadDb(), { message: '这个 PO 为什么优先？' }, { env: envFor(kind, endpoint) }))
    assert.equal(result.status, 200, kind)
    assertRuntimeResponse(result.body)
    assert.match(visibleText(result.body), /外部辅助结果未采用|当前工作区证据辅助回答/)
    assertCleanVisible(result.body)
  }
})

test('provider-specific timeout non-2xx invalid content malformed and too long all fail safely', async () => {
  const handlers = [
    (_req, res) => setTimeout(() => res.end('late'), 80),
    (_req, res) => { res.writeHead(503, { 'content-type': 'text/plain' }); res.end('busy') },
    (_req, res) => { res.writeHead(200, { 'content-type': 'application/octet-stream' }); res.end('bad') },
    (_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ nope: true })) },
    (_req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('x'.repeat(100)) },
  ]
  for (const kind of providerKinds) {
    for (const handler of handlers) {
      const result = await withServer(handler, async (endpoint) => buildAiRuntimeResponseV2Async(loadDb(), { message: '哪些 SKU 有库存风险？' }, {
        env: envFor(kind, endpoint, { FLOWCHAIN_AI_PROVIDER_TIMEOUT_MS: '20', FLOWCHAIN_AI_PROVIDER_MAX_OUTPUT_CHARS: '30' }),
      }))
      assert.equal(result.status, 200, kind)
      assertRuntimeResponse(result.body)
      assert.match(visibleText(result.body), /外部辅助结果未采用/)
      assertCleanVisible(result.body)
    }
  }
})

test('observability local-vs-assisted covers provider-specific success and unsafe fallback', async () => {
  for (const kind of providerKinds) {
    const safe = await withServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(responseFor(kind, '建议查看来源证据并进入人工复核。')))
    }, async (endpoint) => buildAiRuntimeEvaluationV2(loadDb(), { scenarioId: 'today_attention', evaluationMode: 'local_vs_assisted' }, { env: envFor(kind, endpoint) }))
    assert.equal(safe.status, 200)
    assert.equal(safe.body.assistedResponseSummary.summaryLabel, '外部辅助结果已通过安全评估')
    assert.equal(safe.body.evidenceGroundingReport.ungroundedEvidenceCount, 0)
    assertCleanVisible(safe.body)

    const unsafe = await withServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(responseFor(kind, '直接付款并更新供应商主数据。')))
    }, async (endpoint) => buildAiRuntimeEvaluationV2(loadDb(), { scenarioId: 'today_attention', evaluationMode: 'local_vs_assisted' }, { env: envFor(kind, endpoint) }))
    assert.equal(unsafe.status, 200)
    assert.equal(unsafe.body.assistedResponseSummary.summaryLabel, '外部辅助结果未采用')
    assertCleanVisible(unsafe.body)
  }
})
