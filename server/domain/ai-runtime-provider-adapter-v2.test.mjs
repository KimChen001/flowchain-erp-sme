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
  assert.equal(response.realEvidenceCount, response.keyEvidence?.length || 0)
  assert.ok((response.keyEvidence?.length || 0) > 0 || response.contextCardCount > 0)
  assert.ok(response.navigationLinks.every((link) => link.returnTo === 'ai-assistant'))
  assert.ok(response.reviewCards.every((card) => card.previewOnly && card.reviewRequired && card.requiresHumanReview))
  assert.equal(response.dataScopeLabel, '当前工作区数据')
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

test('configured provider selection keeps generic regression and supports specific kinds', () => {
  assert.equal(selectProviderAdapter({ FLOWCHAIN_AI_PROVIDER_KIND: 'generic_http' })?.id, 'generic-http-provider-adapter-v2')
  assert.equal(selectProviderAdapter({ FLOWCHAIN_AI_PROVIDER_KIND: 'openai_responses' })?.kind, 'openai_responses')
  assert.equal(selectProviderAdapter({ FLOWCHAIN_AI_PROVIDER_KIND: 'deepseek_chat' })?.kind, 'deepseek_chat')
  assert.equal(selectProviderAdapter({ FLOWCHAIN_AI_PROVIDER_KIND: 'doubao_chat' })?.kind, 'doubao_chat')
  assert.equal(selectProviderAdapter({ FLOWCHAIN_AI_PROVIDER_KIND: 'disabled' }), null)
  assert.equal(canCallConfiguredProvider({ FLOWCHAIN_AI_RUNTIME_MODE: 'provider_assisted', FLOWCHAIN_AI_PROVIDER_KIND: 'openai_responses', FLOWCHAIN_AI_PROVIDER_ENDPOINT: 'http://local', FLOWCHAIN_AI_PROVIDER_API_KEY: 'test-key' }), false)
  assert.equal(canCallConfiguredProvider({ FLOWCHAIN_AI_RUNTIME_MODE: 'provider_assisted', FLOWCHAIN_AI_PROVIDER_KIND: 'openai_responses', FLOWCHAIN_AI_PROVIDER_ENDPOINT: 'http://local', FLOWCHAIN_AI_PROVIDER_API_KEY: 'test-key', FLOWCHAIN_AI_PROVIDER_MODEL: 'test-runtime-model' }), true)
})
