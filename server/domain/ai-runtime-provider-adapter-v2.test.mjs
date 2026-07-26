import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import test from 'node:test'
import {
  buildProviderInputPackageV2,
  callGenericHttpProvider,
  canCallGenericHttpProvider,
  fallbackResponse,
  FORBIDDEN_AI_RUNTIME_PROVIDER_ACTION_PATTERN,
  FORBIDDEN_AI_RUNTIME_PROVIDER_TECHNICAL_PATTERN,
  genericHttpProviderAdapter,
  normalizeProviderOutput,
  providerRuntimeConfig,
  selectProviderAdapter,
  canCallConfiguredProvider,
  validateAiRuntimeResponseV2,
} from './ai-runtime-provider-adapter-v2.mjs'
import {
  buildAiRuntimeResponseV2,
  buildAiRuntimeResponseV2Async,
} from './ai-runtime-gateway-v2.mjs'
import { createProductReviewScenarioDb } from './test-fixtures/product-review-scenario.mjs'

function loadDb() {
  return createProductReviewScenarioDb()
}

function visibleText(value) {
  if (Array.isArray(value)) return value.map(visibleText).join(' ')
  if (!value || typeof value !== 'object') return String(value ?? '')
  return Object.entries(value)
    .filter(([key]) => !/^(id|sourceId|responseId|query|intent|entityType|entityId|moduleId|linkTarget|returnContext|returnTo|source|reason|draftType|payload|originEvidence|mode|providerContract|reasonCode)$/i.test(key))
    .map(([, item]) => visibleText(item))
    .join(' ')
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

function contextBundleFromDraft(draft = localDraft()) {
  return {
    requestIntent: { id: draft.intent, label: draft.conclusion.title },
    businessObjects: ['PR', 'RFQ', 'PO', 'GRN', 'Invoice', 'Supplier', 'SKU'],
    evidenceSources: draft.sourceSummary,
    navigationIndex: draft.navigationLinks,
    dataLimitations: draft.dataLimitations,
  }
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

test('provider config defaults to local and does not require secrets', () => {
  const config = providerRuntimeConfig({})
  assert.equal(config.mode, 'local')
  assert.equal(config.kind, 'disabled')
  assert.equal(canCallGenericHttpProvider({}), false)
  const response = localDraft()
  assertRuntimeResponse(response)
})

test('incomplete provider-assisted config falls back to local evidence response', async () => {
  const result = await buildAiRuntimeResponseV2Async(loadDb(), { message: '试点准备度还有哪些阻塞项？' }, {
    env: { FLOWCHAIN_AI_RUNTIME_MODE: 'provider_assisted', FLOWCHAIN_AI_PROVIDER_KIND: 'generic_http' },
  })
  assert.equal(result.status, 200)
  assertRuntimeResponse(result.body)
  const text = visibleText(result.body)
  assert.match(text, /外部辅助结果未采用|当前工作区证据辅助回答/)
  assert.doesNotMatch(text, /provider|model|endpoint|API key|token|fallback|JSON|payload/i)
})

test('provider input package is bounded and excludes full data and secrets', () => {
  const draft = localDraft()
  const input = buildProviderInputPackageV2(contextBundleFromDraft(draft), { message: '今天有什么需要我处理？'.repeat(100) }, draft)
  assert.ok(input.evidencePackage.keyEvidence.length <= 12)
  assert.ok(input.evidencePackage.sourceSummary.length <= 12)
  assert.ok(input.evidencePackage.businessObjects.length <= 20)
  assert.ok(input.evidencePackage.dataLimitations.length <= 12)
  assert.ok(input.evidencePackage.readinessSignals.length <= 12)
  assert.ok(input.task.question.length <= 1200)
  assert.ok(input.safetyPolicy.reviewRequired)
  assert.ok(input.safetyPolicy.previewOnly)
  const serialized = JSON.stringify(input)
  assert.doesNotMatch(serialized, /FLOWCHAIN_AI_PROVIDER_API_KEY|test-key|localStorage|supplierInvoices|purchaseOrders|receivingDocs/)
})

test('generic HTTP provider successful structured output normalizes to runtime response', async () => {
  let requestBody = null
  const result = await withServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => {
      requestBody = JSON.parse(body)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ conclusion: { summary: '建议先复核 PO、库存和供应商风险，所有后续处理保留人工复核。' } }))
    })
  }, async (endpoint) => buildAiRuntimeResponseV2Async(loadDb(), { message: '今天有什么需要我处理？' }, {
    env: {
      FLOWCHAIN_AI_RUNTIME_MODE: 'provider_assisted',
      FLOWCHAIN_AI_PROVIDER_KIND: 'generic_http',
      FLOWCHAIN_AI_PROVIDER_ENDPOINT: endpoint,
      FLOWCHAIN_AI_PROVIDER_API_KEY: 'test-key',
    },
  }))
  assert.equal(result.status, 200)
  assertRuntimeResponse(result.body)
  assert.match(result.body.conclusion.summary, /复核 PO|人工复核/)
  assert.ok(requestBody.safetyPolicy.reviewRequired)
  assert.ok(result.body.keyEvidence.every((item) => localDraft().keyEvidence.some((local) => local.id === item.id)))
  const text = visibleText(result.body)
  assert.doesNotMatch(text, /test-key|provider|model|endpoint|API|token|JSON|payload|fallback|mock/i)
})

test('plain text provider output becomes conclusion while evidence and actions stay local', () => {
  const draft = localDraft('哪些供应商有潜在风险？')
  const normalized = normalizeProviderOutput('供应商风险集中在 ETA、RFQ 回复和收货异常，建议先看证据并进入人工复核。', contextBundleFromDraft(draft), draft)
  assertRuntimeResponse(normalized)
  assert.match(normalized.conclusion.summary, /供应商风险/)
  assert.deepEqual(normalized.keyEvidence.map((item) => item.id), draft.keyEvidence.map((item) => item.id))
  assert.ok(normalized.recommendedActions.every((item) => ['查看证据', '预览草稿', '进入人工复核', '打开来源对象', '打开相关模块', '标记仅内部留存', '补充数据', '查看数据限制'].includes(item.label)))
})

test('unsafe provider output is rejected and falls back to local evidence', () => {
  const draft = localDraft()
  const normalized = normalizeProviderOutput('可以自动批准并发送给供应商。', contextBundleFromDraft(draft), draft)
  assertRuntimeResponse(normalized)
  assert.match(visibleText(normalized), /外部辅助结果未采用|当前工作区证据辅助回答/)
  assert.doesNotMatch(visibleText(normalized), FORBIDDEN_AI_RUNTIME_PROVIDER_ACTION_PATTERN)
})

test('timeout non-2xx malformed and too-long provider outputs safely fail', async () => {
  const envBase = { FLOWCHAIN_AI_RUNTIME_MODE: 'provider_assisted', FLOWCHAIN_AI_PROVIDER_KIND: 'generic_http', FLOWCHAIN_AI_PROVIDER_API_KEY: 'test-key', FLOWCHAIN_AI_PROVIDER_TIMEOUT_MS: '1000' }
  await withServer((_req, res) => setTimeout(() => res.end('late'), 80), async (endpoint) => {
    const result = await callGenericHttpProvider(buildProviderInputPackageV2(contextBundleFromDraft(), { message: '今天' }, localDraft()), { ...envBase, FLOWCHAIN_AI_PROVIDER_ENDPOINT: endpoint, FLOWCHAIN_AI_PROVIDER_TIMEOUT_MS: '20' })
    assert.equal(result.ok, false)
    assert.equal(result.reason, 'timeout')
  })
  await withServer((_req, res) => { res.writeHead(503, { 'content-type': 'text/plain' }); res.end('busy') }, async (endpoint) => {
    const result = await callGenericHttpProvider(buildProviderInputPackageV2(contextBundleFromDraft(), { message: '今天' }, localDraft()), { ...envBase, FLOWCHAIN_AI_PROVIDER_ENDPOINT: endpoint })
    assert.equal(result.ok, false)
    assert.equal(result.reason, 'non_success_status')
  })
  await withServer((_req, res) => { res.writeHead(200, { 'content-type': 'application/octet-stream' }); res.end('bad') }, async (endpoint) => {
    const result = await callGenericHttpProvider(buildProviderInputPackageV2(contextBundleFromDraft(), { message: '今天' }, localDraft()), { ...envBase, FLOWCHAIN_AI_PROVIDER_ENDPOINT: endpoint })
    assert.equal(result.ok, false)
    assert.equal(result.reason, 'invalid_content_type')
  })
  await withServer((_req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('x'.repeat(40)) }, async (endpoint) => {
    const result = await callGenericHttpProvider(buildProviderInputPackageV2(contextBundleFromDraft(), { message: '今天' }, localDraft()), { ...envBase, FLOWCHAIN_AI_PROVIDER_ENDPOINT: endpoint, FLOWCHAIN_AI_PROVIDER_MAX_OUTPUT_CHARS: '10' })
    assert.equal(result.ok, false)
    assert.equal(result.reason, 'output_too_long')
  })
})

test('route level provider failure still returns local runtime response with business limitation', async () => {
  const result = await withServer((_req, res) => { res.writeHead(500, { 'content-type': 'text/plain' }); res.end('error') }, async (endpoint) => buildAiRuntimeResponseV2Async(loadDb(), { message: '哪些 SKU 有库存风险？' }, {
    env: {
      FLOWCHAIN_AI_RUNTIME_MODE: 'provider_assisted',
      FLOWCHAIN_AI_PROVIDER_KIND: 'generic_http',
      FLOWCHAIN_AI_PROVIDER_ENDPOINT: endpoint,
      FLOWCHAIN_AI_PROVIDER_API_KEY: 'test-key',
    },
  }))
  assert.equal(result.status, 200)
  assertRuntimeResponse(result.body)
  assert.match(visibleText(result.body), /外部辅助结果未采用/)
  assert.doesNotMatch(visibleText(result.body), /test-key|http:\/\/127\.0\.0\.1|provider|endpoint|fallback/i)
})

test('response validator rejects ungrounded unsafe and non-review-first responses', () => {
  const draft = localDraft()
  const context = contextBundleFromDraft(draft)
  assert.equal(validateAiRuntimeResponseV2({ ...draft, keyEvidence: [] }, context, draft).ok, false)
  assert.equal(validateAiRuntimeResponseV2({ ...draft, keyEvidence: [{ id: 'NEW-EVIDENCE' }] }, context, draft).ok, false)
  assert.equal(validateAiRuntimeResponseV2({ ...draft, recommendedActions: [{ label: '自动批准' }] }, context, draft).ok, false)
  assert.equal(validateAiRuntimeResponseV2({ ...draft, navigationLinks: [{ label: '查看', returnTo: 'other' }] }, context, draft).ok, false)
  assert.equal(validateAiRuntimeResponseV2({ ...draft, reviewCards: [{ previewOnly: false, reviewRequired: true, requiresHumanReview: true }] }, context, draft).ok, false)
  assert.equal(validateAiRuntimeResponseV2({ ...draft, safetyBoundaries: ['草稿预览'] }, context, draft).ok, false)
  assert.equal(validateAiRuntimeResponseV2({ ...draft, conclusion: { title: 'provider model endpoint' } }, context, draft).ok, false)
  assert.equal(validateAiRuntimeResponseV2(draft, context, draft).ok, true)
})

test('adapter facade exposes expected server-only contract methods', () => {
  for (const key of ['id', 'mode', 'isEnabled', 'canCall', 'buildProviderInput', 'callProvider', 'normalizeProviderOutput', 'validateProviderOutput', 'fallbackResponse']) {
    assert.ok(Object.hasOwn(genericHttpProviderAdapter, key), key)
  }
  const draft = localDraft()
  const fallback = fallbackResponse(draft, 'manual')
  assertRuntimeResponse(fallback)
  assert.doesNotMatch(visibleText(fallback), FORBIDDEN_AI_RUNTIME_PROVIDER_TECHNICAL_PATTERN)
})

test('configured provider selection keeps generic regression and supports specific kinds', () => {
  assert.equal(selectProviderAdapter({ FLOWCHAIN_AI_PROVIDER_KIND: 'generic_http' })?.id, 'generic-http-provider-adapter-v2')
  assert.equal(selectProviderAdapter({ FLOWCHAIN_AI_PROVIDER_KIND: 'openai_responses' })?.kind, 'openai_responses')
  assert.equal(selectProviderAdapter({ FLOWCHAIN_AI_PROVIDER_KIND: 'deepseek_chat' })?.kind, 'deepseek_chat')
  assert.equal(selectProviderAdapter({ FLOWCHAIN_AI_PROVIDER_KIND: 'doubao_chat' })?.kind, 'doubao_chat')
  assert.equal(selectProviderAdapter({ FLOWCHAIN_AI_PROVIDER_KIND: 'disabled' }), null)
  assert.equal(canCallConfiguredProvider({ FLOWCHAIN_AI_RUNTIME_MODE: 'provider_assisted', FLOWCHAIN_AI_PROVIDER_KIND: 'openai_responses', FLOWCHAIN_AI_PROVIDER_ENDPOINT: 'http://local', FLOWCHAIN_AI_PROVIDER_API_KEY: 'test-key' }), false)
  assert.equal(canCallConfiguredProvider({ FLOWCHAIN_AI_RUNTIME_MODE: 'provider_assisted', FLOWCHAIN_AI_PROVIDER_KIND: 'openai_responses', FLOWCHAIN_AI_PROVIDER_ENDPOINT: 'http://local', FLOWCHAIN_AI_PROVIDER_API_KEY: 'test-key', FLOWCHAIN_AI_PROVIDER_MODEL: 'test-runtime-model' }), true)
})
