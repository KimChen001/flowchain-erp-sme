import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import test from 'node:test'
import {
  anthropicMessagesAdapter,
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

const providerKinds = ['openai_responses', 'deepseek_chat', 'doubao_chat', 'qwen_chat', 'parley_chat', 'anthropic_chat']
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
  // The chat-style kinds below, and Anthropic's native Messages API (tested on its own).
  assert.deepEqual(providerSpecificAdapters.map((item) => item.kind), [...providerKinds, 'anthropic_messages'])
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

test('semantic planning retains the question and server-owned schema while dropping arbitrary context', () => {
  const request = buildBoundedProviderRequestCore({ task: { type: 'business_query_planning', message: 'Which suppliers have overdue payments?', currentContext: { entityType: 'supplier', entityId: 'supplier-a', secret: 'DO_NOT_SEND' }, allowedGoals: ['executePayment'], previousResult: [] }, responseShape: { unsafe: 'DO_NOT_SEND' } });
  assert.equal(request.task.question, 'Which suppliers have overdue payments?');
  assert.equal(request.responseShape.properties.planningVersion.const, 'business-query-plan-v1');
  assert.doesNotMatch(JSON.stringify(request), /DO_NOT_SEND|executePayment/);
  assert.equal(request.safetyPolicy.readOnly, true);
});

test('usage counts every prompt token: cached ones reported apart (Parley) or inside prompt_tokens (OpenAI)', () => {
  // Parley caches Claude prompts itself: prompt_tokens is the uncached part only.
  const parley = extractCandidateFromProviderResponse({ choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 4, completion_tokens: 187, total_tokens: 2278, prompt_tokens_details: { cache_read_input_tokens: 720, cache_write_input_tokens: 1367 } } })
  assert.deepEqual(parley.usage, { inputTokens: 2091, outputTokens: 187 })
  // OpenAI style: cached tokens are already inside prompt_tokens.
  const openai = extractCandidateFromProviderResponse({ choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 1596, completion_tokens: 110, total_tokens: 1706, prompt_tokens_details: { cached_tokens: 1024 } } })
  assert.deepEqual(openai.usage, { inputTokens: 1596, outputTokens: 110 })
  // No total: the prompt count as reported.
  assert.deepEqual(extractCandidateFromProviderResponse({ choices: [{ message: { content: 'ok' } }], usage: { input_tokens: 10, output_tokens: 2 } }).usage, { inputTokens: 10, outputTokens: 2 })
})

test("Anthropic's Messages API gets a system prompt, one user message, low effort, an API key header and no sampling settings", async () => {
  const config = { model: 'claude-haiku-5-5', apiKey: 'placeholder', identityHeaders: { 'user-agent': 'FlowChain-assistant/1.0' } }
  const body = anthropicMessagesAdapter.buildRequestBody({ task: { type: 'knowledge_rag', question: 'What is the policy?' }, evidencePackage: { citations: [] } }, config)
  assert.equal(body.model, 'claude-haiku-5-5')
  assert.equal(typeof body.system, 'string')
  assert.deepEqual(body.messages.map((message) => message.role), ['user'])
  assert.deepEqual(body.output_config, { effort: 'low' })
  for (const key of ['temperature', 'top_p', 'top_k', 'response_format']) assert.equal(body[key], undefined, key)
  assert.deepEqual(anthropicMessagesAdapter.buildHeaders(config), { 'content-type': 'application/json', 'x-api-key': 'placeholder', 'anthropic-version': '2023-06-01', 'user-agent': 'FlowChain-assistant/1.0' })
  // The reply is read by block type: thinking first, then the text. Input
  // counts the cache reads and writes, which are reported apart.
  const reply = anthropicMessagesAdapter.extractCandidateFromResponse({ content: [{ type: 'thinking', thinking: '', signature: 's' }, { type: 'text', text: '{"answer":"ok","citationIds":[]}' }], usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 900, cache_creation_input_tokens: 50 } })
  assert.equal(reply.ok, true)
  assert.equal(reply.rawOutput.conclusion.summary, '{"answer":"ok","citationIds":[]}')
  assert.deepEqual(reply.usage, { inputTokens: 1050, outputTokens: 20, cacheReadTokens: 900, cacheWriteTokens: 50 })
  assert.equal(anthropicMessagesAdapter.extractCandidateFromResponse({ content: [{ type: 'thinking', thinking: '' }], stop_reason: 'max_tokens' }).ok, false)
  assert.equal(canCallConfiguredProvider({ FLOWCHAIN_AI_RUNTIME_MODE: 'provider_assisted', FLOWCHAIN_AI_PROVIDER_KIND: 'anthropic_messages', FLOWCHAIN_AI_PROVIDER_ENDPOINT: 'https://api.anthropic.com/v1/messages', FLOWCHAIN_AI_PROVIDER_API_KEY: 'placeholder', FLOWCHAIN_AI_PROVIDER_MODEL: 'claude-haiku-5-5' }), true)
})
