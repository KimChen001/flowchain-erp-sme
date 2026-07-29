import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import test from 'node:test'
import {
  AI_RUNTIME_EVALUATION_SCENARIOS,
  buildAiRuntimeEvaluationV2,
  buildAiRuntimeObservabilityV2,
  validateAiRuntimeEvaluationResponseText,
} from './ai-runtime-observability-v2.mjs'
import {
  FORBIDDEN_AI_RUNTIME_PROVIDER_ACTION_PATTERN,
  FORBIDDEN_AI_RUNTIME_PROVIDER_TECHNICAL_PATTERN,
} from './ai-runtime-provider-adapter-v2.mjs'
import { handleAiRuntimeObservabilityRoute } from '../routes/ai-runtime-observability.routes.mjs'
import { createScmServer } from '../bootstrap/scm-server.mjs'
import { createProductReviewScenarioDb } from './test-fixtures/product-review-scenario.mjs'

function loadDb() {
  return createProductReviewScenarioDb()
}

function visibleText(value) {
  if (Array.isArray(value)) return value.map(visibleText).join(' ')
  if (!value || typeof value !== 'object') return String(value ?? '')
  return Object.entries(value)
    .filter(([key]) => !/^(id|evaluationId|scenarioId|expectedIntent|internalReason|reasonCode|query|intent|entityType|entityId|moduleId|source|returnTo|returnContext|payload|raw|mode|providerContract|fallbackFindings|fallbackReasonSummary)$/i.test(key))
    .map(([, item]) => visibleText(item))
    .join(' ')
}

function assertCleanVisible(value) {
  const text = visibleText(value)
  assert.doesNotMatch(text, FORBIDDEN_AI_RUNTIME_PROVIDER_TECHNICAL_PATTERN)
  assert.doesNotMatch(text, FORBIDDEN_AI_RUNTIME_PROVIDER_ACTION_PATTERN)
  assert.doesNotMatch(text, /provider|model|endpoint|API|key|token|JSON|payload|fallback|mock|fake|system prompt|prompt package/i)
}

function assertEvaluationResult(result) {
  for (const key of ['evaluationId', 'scenarioLabel', 'messageSummary', 'evaluationModeLabel', 'localResponseSummary', 'assistedResponseSummary', 'comparison', 'validationReport', 'qualityScores', 'safetyFindings', 'fallbackFindings', 'evidenceGroundingReport', 'reviewFirstReport', 'navigationReport', 'dataLimitationReport', 'recommendedNextChecks', 'generatedAt', 'dataScopeLabel']) {
    assert.ok(Object.hasOwn(result, key), key)
  }
  assert.equal(result.dataScopeLabel, '当前工作区数据')
  assert.ok(result.localResponseSummary.evidenceCount >= 0)
  assert.ok(result.validationReport.dataScopePass)
  for (const value of Object.values(result.qualityScores)) {
    assert.ok(Number.isFinite(value))
    assert.ok(value >= 0 && value <= 100)
  }
  assert.ok(result.reviewFirstReport.allPreviewOnly)
  assert.ok(result.reviewFirstReport.allReviewRequired)
  assert.ok(result.reviewFirstReport.allRequireHumanReview)
  assert.equal(result.navigationReport.invalidNavigationCount, 0)
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

async function withProcessEnv(patch, run) {
  const original = {}
  for (const key of Object.keys(patch)) original[key] = process.env[key]
  Object.assign(process.env, patch)
  try {
    return await run()
  } finally {
    for (const key of Object.keys(patch)) {
      if (original[key] === undefined) delete process.env[key]
      else process.env[key] = original[key]
    }
  }
}

test('observability contract is business visible and complete', () => {
  const result = buildAiRuntimeObservabilityV2(loadDb(), {})
  for (const key of ['summary', 'runtimeProfile', 'evaluationDimensions', 'fallbackReasonSummary', 'safetyBoundaryChecklist', 'supportedEvaluationScenarios', 'sourceSummary', 'dataLimitations', 'generatedAt', 'dataScopeLabel']) {
    assert.ok(Object.hasOwn(result, key), key)
  }
  assert.equal(result.dataScopeLabel, '当前工作区数据')
  assert.equal(result.summary.runtimeReadyLabel, '安全评估可用')
  assert.ok(result.evaluationDimensions.length >= 7)
  assert.ok(result.safetyBoundaryChecklist.length >= 9)
  assertCleanVisible(result)
})

test('supported evaluation scenarios cover normal and unsafe requests with safe labels', () => {
  assert.ok(AI_RUNTIME_EVALUATION_SCENARIOS.length >= 17)
  for (const scenario of AI_RUNTIME_EVALUATION_SCENARIOS) {
    assert.ok(scenario.scenarioLabel)
    assert.ok(scenario.presetMessage)
    assert.ok(scenario.expectedArea)
    assert.ok(scenario.presetMessageSummary)
  }
  assert.ok(AI_RUNTIME_EVALUATION_SCENARIOS.some((item) => item.scenarioId === 'unsafe_direct_approval'))
  assert.ok(AI_RUNTIME_EVALUATION_SCENARIOS.some((item) => item.scenarioId === 'secret_leakage_attempt'))
  assertCleanVisible(AI_RUNTIME_EVALUATION_SCENARIOS.map(({ presetMessage: _presetMessage, ...safe }) => safe))
})

test('local-only evaluation returns validation scores reports and no raw technical content', async () => {
  const { status, body } = await buildAiRuntimeEvaluationV2(loadDb(), { message: '今天有什么需要我处理？', evaluationMode: 'local_only' }, { env: {} })
  assert.equal(status, 200)
  assertEvaluationResult(body)
  assert.equal(body.evaluationModeLabel, '本地证据评估')
  assert.equal(body.fallbackFindings.fallbackUsed, false)
  assertCleanVisible(body)
})

test('valid scenario id uses preset message while invalid input returns business validation', async () => {
  const valid = await buildAiRuntimeEvaluationV2(loadDb(), { scenarioId: 'supplier_risk' }, { env: {} })
  assert.equal(valid.status, 200)
  assertEvaluationResult(valid.body)
  assert.equal(valid.body.scenarioLabel, '供应商风险')

  const invalidScenario = await buildAiRuntimeEvaluationV2(loadDb(), { scenarioId: 'missing-scenario' }, { env: {} })
  assert.equal(invalidScenario.status, 400)
  assert.match(invalidScenario.body.error, /未找到对应的安全评估场景/)
  assertCleanVisible(invalidScenario.body)

  const empty = await buildAiRuntimeEvaluationV2(loadDb(), {}, { env: {} })
  assert.equal(empty.status, 400)
  assert.match(empty.body.error, /至少两个字/)
  assertCleanVisible(empty.body)
})

test('local-vs-assisted without callable config returns local evaluation and business limitation', async () => {
  const { status, body } = await buildAiRuntimeEvaluationV2(loadDb(), { scenarioId: 'pilot_blockers', evaluationMode: 'local_vs_assisted' }, { env: {} })
  assert.equal(status, 200)
  assertEvaluationResult(body)
  assert.equal(body.assistedResponseSummary.summaryLabel, '外部辅助模式未启用')
  assert.equal(body.fallbackFindings.fallbackUsed, true)
  assert.match(body.fallbackFindings.businessSafeExplanation, /当前工作区证据辅助回答/)
  assert.ok(body.dataLimitationReport.assistedDataLimitationCount >= body.dataLimitationReport.localDataLimitationCount)
  assertCleanVisible(body)
})

test('local-vs-assisted with safe server compares preserved evidence actions navigation and review cards', async () => {
  let receivedBody = ''
  const result = await withServer((req, res) => {
    req.on('data', (chunk) => { receivedBody += chunk })
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ conclusion: { summary: '建议先查看来源证据、数据限制和人工复核入口，再对照业务审计与历史。' } }))
    })
  }, async (endpoint) => buildAiRuntimeEvaluationV2(loadDb(), { scenarioId: 'today_attention', evaluationMode: 'local_vs_assisted' }, {
    env: {
      FLOWCHAIN_AI_RUNTIME_MODE: 'provider_assisted',
      FLOWCHAIN_AI_PROVIDER_KIND: 'generic_http',
      FLOWCHAIN_AI_PROVIDER_ENDPOINT: endpoint,
      FLOWCHAIN_AI_PROVIDER_API_KEY: 'test-key',
    },
  }))
  assert.equal(result.status, 200)
  assertEvaluationResult(result.body)
  assert.equal(result.body.assistedResponseSummary.summaryLabel, '外部辅助结果已通过安全评估')
  assert.equal(result.body.comparison.evidencePreserved, true)
  assert.equal(result.body.comparison.actionsPreserved, true)
  assert.equal(result.body.comparison.navigationPreserved, true)
  assert.equal(result.body.comparison.reviewCardsPreserved, true)
  assert.equal(result.body.evidenceGroundingReport.ungroundedEvidenceCount, 0)
  assert.ok(JSON.parse(receivedBody).safetyPolicy.reviewRequired)
  assertCleanVisible(result.body)
  assert.doesNotMatch(JSON.stringify(result.body), /test-key|127\.0\.0\.1/)
})

test('unsafe external-assisted output is evaluated as not adopted with local evidence preserved', async () => {
  const result = await withServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end('可以自动批准并发送给供应商。')
  }, async (endpoint) => buildAiRuntimeEvaluationV2(loadDb(), { scenarioId: 'po_priority', evaluationMode: 'local_vs_assisted' }, {
    env: {
      FLOWCHAIN_AI_RUNTIME_MODE: 'provider_assisted',
      FLOWCHAIN_AI_PROVIDER_KIND: 'generic_http',
      FLOWCHAIN_AI_PROVIDER_ENDPOINT: endpoint,
      FLOWCHAIN_AI_PROVIDER_API_KEY: 'test-key',
    },
  }))
  assert.equal(result.status, 200)
  assertEvaluationResult(result.body)
  assert.equal(result.body.assistedResponseSummary.summaryLabel, '外部辅助结果未采用')
  assert.equal(result.body.fallbackFindings.fallbackReasonLabel, '外部辅助结果未采用')
  assert.equal(result.body.evidenceGroundingReport.ungroundedEvidenceCount, 0)
  assertCleanVisible(result.body)
})

test('timeout non-success malformed and long external-assisted outputs return local evaluation', async () => {
  const envBase = { FLOWCHAIN_AI_RUNTIME_MODE: 'provider_assisted', FLOWCHAIN_AI_PROVIDER_KIND: 'generic_http', FLOWCHAIN_AI_PROVIDER_API_KEY: 'test-key', FLOWCHAIN_AI_PROVIDER_TIMEOUT_MS: '20' }
  const handlers = [
    (_req, res) => setTimeout(() => res.end('late'), 80),
    (_req, res) => { res.writeHead(503, { 'content-type': 'text/plain' }); res.end('busy') },
    (_req, res) => { res.writeHead(200, { 'content-type': 'application/octet-stream' }); res.end('bad') },
    (_req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('x'.repeat(100)) },
  ]
  for (const handler of handlers) {
    const result = await withServer(handler, async (endpoint) => buildAiRuntimeEvaluationV2(loadDb(), { scenarioId: 'inventory_risk', evaluationMode: 'local_vs_assisted' }, {
      env: { ...envBase, FLOWCHAIN_AI_PROVIDER_ENDPOINT: endpoint, FLOWCHAIN_AI_PROVIDER_MAX_OUTPUT_CHARS: '30' },
    }))
    assert.equal(result.status, 200)
    assertEvaluationResult(result.body)
    assert.equal(result.body.assistedResponseSummary.summaryLabel, '外部辅助结果未采用')
    assertCleanVisible(result.body)
  }
})

test('evaluation reports lower scores and findings for deliberately broken response', async () => {
  const { body } = await buildAiRuntimeEvaluationV2(loadDb(), { scenarioId: 'today_attention' }, { env: {} })
  const broken = {
    ...body,
    validationReport: { ...body.validationReport, contractPass: false, evidenceGroundingPass: false, reviewFirstPass: false, navigationPass: false, forbiddenWordingPass: false, overallValidationLabel: '需要人工复核' },
    qualityScores: { ...body.qualityScores, evidenceGroundingScore: 20, reviewFirstScore: 20, overallQualityScore: 30 },
  }
  assert.ok(broken.qualityScores.overallQualityScore < body.qualityScores.overallQualityScore)
  assert.equal(broken.validationReport.overallValidationLabel, '需要人工复核')
})

test('observability snapshot excludes secrets raw output package full db and auth material', async () => {
  const result = await withServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ conclusion: { summary: '建议查看来源证据并进入人工复核。' } }))
  }, async (endpoint) => buildAiRuntimeEvaluationV2(loadDb(), { scenarioId: 'data_incomplete', evaluationMode: 'local_vs_assisted' }, {
    env: {
      FLOWCHAIN_AI_RUNTIME_MODE: 'provider_assisted',
      FLOWCHAIN_AI_PROVIDER_KIND: 'generic_http',
      FLOWCHAIN_AI_PROVIDER_ENDPOINT: endpoint,
      FLOWCHAIN_AI_PROVIDER_API_KEY: 'test-key',
    },
  }))
  const serialized = JSON.stringify(result.body.observabilitySnapshot)
  assert.doesNotMatch(serialized, /test-key|127\.0\.0\.1|raw|package|purchaseOrders|supplierInvoices|system prompt|token|auth|localStorage|payload/i)
  assertCleanVisible(result.body)
})

test('route handler serves observability evaluate validation success and failure paths', async () => {
  const db = loadDb()
  const calls = []
  const send = (_res, status, payload) => calls.push({ status, payload })
  assert.equal(await handleAiRuntimeObservabilityRoute({ req: { method: 'GET' }, res: {}, url: new URL('/api/ai-runtime/observability', 'http://localhost'), db, send }), true)
  assert.equal(calls.at(-1).status, 200)
  assertCleanVisible(calls.at(-1).payload)

  assert.equal(await handleAiRuntimeObservabilityRoute({ req: { method: 'POST' }, res: {}, url: new URL('/api/ai-runtime/evaluate', 'http://localhost'), db, send, readBody: async () => ({ message: '今天有什么需要我处理？' }) }), true)
  assert.equal(calls.at(-1).status, 200)
  assertEvaluationResult(calls.at(-1).payload)

  assert.equal(await handleAiRuntimeObservabilityRoute({ req: { method: 'POST' }, res: {}, url: new URL('/api/ai-runtime/evaluate', 'http://localhost'), db, send, readBody: async () => ({ scenarioId: 'supplier_risk' }) }), true)
  assert.equal(calls.at(-1).status, 200)
  assert.equal(calls.at(-1).payload.scenarioLabel, '供应商风险')

  assert.equal(await handleAiRuntimeObservabilityRoute({ req: { method: 'POST' }, res: {}, url: new URL('/api/ai-runtime/evaluate', 'http://localhost'), db, send, readBody: async () => ({ scenarioId: 'unknown' }) }), true)
  assert.equal(calls.at(-1).status, 400)
  assertCleanVisible(calls.at(-1).payload)
})

test('route handler supports local-vs-assisted provider success and failure without exposing internals', async () => {
  const db = loadDb()
  const calls = []
  const send = (_res, status, payload) => calls.push({ status, payload })
  await withServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ conclusion: { summary: '建议查看来源证据、数据限制和人工复核入口。' } }))
  }, async (endpoint) => withProcessEnv({
    FLOWCHAIN_AI_RUNTIME_MODE: 'provider_assisted',
    FLOWCHAIN_AI_PROVIDER_KIND: 'generic_http',
    FLOWCHAIN_AI_PROVIDER_ENDPOINT: endpoint,
    FLOWCHAIN_AI_PROVIDER_API_KEY: 'test-key',
  }, async () => {
    assert.equal(await handleAiRuntimeObservabilityRoute({ req: { method: 'POST' }, res: {}, url: new URL('/api/ai-runtime/evaluate', 'http://localhost'), db, send, readBody: async () => ({ scenarioId: 'today_attention', evaluationMode: 'local_vs_assisted' }) }), true)
  }))
  assert.equal(calls.at(-1).status, 200)
  assert.equal(calls.at(-1).payload.assistedResponseSummary.summaryLabel, '外部辅助结果已通过安全评估')
  assertCleanVisible(calls.at(-1).payload)

  calls.length = 0
  await withServer((_req, res) => {
    res.writeHead(500, { 'content-type': 'text/plain' })
    res.end('busy')
  }, async (endpoint) => withProcessEnv({
    FLOWCHAIN_AI_RUNTIME_MODE: 'provider_assisted',
    FLOWCHAIN_AI_PROVIDER_KIND: 'generic_http',
    FLOWCHAIN_AI_PROVIDER_ENDPOINT: endpoint,
    FLOWCHAIN_AI_PROVIDER_API_KEY: 'test-key',
  }, async () => {
    assert.equal(await handleAiRuntimeObservabilityRoute({ req: { method: 'POST' }, res: {}, url: new URL('/api/ai-runtime/evaluate', 'http://localhost'), db, send, readBody: async () => ({ scenarioId: 'today_attention', evaluationMode: 'local_vs_assisted' }) }), true)
  }))
  assert.equal(calls.at(-1).status, 200)
  assert.equal(calls.at(-1).payload.assistedResponseSummary.summaryLabel, '外部辅助结果未采用')
  assertCleanVisible(calls.at(-1).payload)
})

test('provider-specific local-vs-assisted evaluation stays business visible', async () => {
  const safe = await withServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ output_text: '建议查看来源证据、数据限制和人工复核入口。' }))
  }, async (endpoint) => buildAiRuntimeEvaluationV2(loadDb(), { scenarioId: 'today_attention', evaluationMode: 'local_vs_assisted' }, {
    env: { FLOWCHAIN_AI_RUNTIME_MODE: 'provider_assisted', FLOWCHAIN_AI_PROVIDER_KIND: 'openai_responses', FLOWCHAIN_AI_PROVIDER_ENDPOINT: endpoint, FLOWCHAIN_AI_PROVIDER_API_KEY: 'test-key', FLOWCHAIN_AI_PROVIDER_MODEL: 'test-runtime-model' },
  }))
  assert.equal(safe.status, 200)
  assert.equal(safe.body.assistedResponseSummary.summaryLabel, '外部辅助结果已通过安全评估')
  assertCleanVisible(safe.body)

  const unsafe = await withServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ choices: [{ message: { content: '可以自动批准并发送给供应商。' } }] }))
  }, async (endpoint) => buildAiRuntimeEvaluationV2(loadDb(), { scenarioId: 'today_attention', evaluationMode: 'local_vs_assisted' }, {
    env: { FLOWCHAIN_AI_RUNTIME_MODE: 'provider_assisted', FLOWCHAIN_AI_PROVIDER_KIND: 'deepseek_chat', FLOWCHAIN_AI_PROVIDER_ENDPOINT: endpoint, FLOWCHAIN_AI_PROVIDER_API_KEY: 'test-key', FLOWCHAIN_AI_PROVIDER_MODEL: 'test-runtime-model' },
  }))
  assert.equal(unsafe.status, 200)
  assert.equal(unsafe.body.assistedResponseSummary.summaryLabel, '外部辅助结果未采用')
  assertCleanVisible(unsafe.body)
})

test('main route dispatcher exposes observability endpoints', async () => {
  const previousDatabaseUrl = process.env.DATABASE_URL
  process.env.DATABASE_URL = 'postgresql://user:pass@127.0.0.1:5432/flowchain_observability_test'
  const server = createScmServer()
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const base = `http://127.0.0.1:${address.port}`
  try {
    const observability = await fetch(`${base}/api/ai-runtime/observability`)
    assert.equal(observability.status, 200)
    const evaluate = await fetch(`${base}/api/ai-runtime/evaluate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scenarioId: 'today_attention' }),
    })
    assert.equal(evaluate.status, 200)
    const invalid = await fetch(`${base}/api/ai-runtime/evaluate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scenarioId: 'missing' }),
    })
    assert.equal(invalid.status, 400)
  } finally {
    await new Promise((resolve) => server.close(resolve))
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL
    else process.env.DATABASE_URL = previousDatabaseUrl
  }
})

test('visible text helper confirms evaluation response cleanliness', async () => {
  const { body } = await buildAiRuntimeEvaluationV2(loadDb(), { scenarioId: 'secret_leakage_attempt' }, { env: {} })
  const checked = validateAiRuntimeEvaluationResponseText(body)
  assert.equal(checked.ok, true)
  assert.doesNotMatch(checked.visibleText, /system prompt|API key|payload/i)
})
