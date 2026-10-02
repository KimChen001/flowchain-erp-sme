import test from 'node:test'
import assert from 'node:assert/strict'
import { knowledgeProviderEnv } from './ai-knowledge-config.mjs'
import { callConfiguredEmbeddingProvider } from './ai-embedding-provider.mjs'
import { callConfiguredProvider } from './ai-runtime-provider-adapter-v2.mjs'
import { parleyChatAdapter } from './ai-runtime-provider-specific-adapters-v2.mjs'
import { checkKnowledgeConnection } from '../../scripts/check-knowledge-provider.mjs'

const config = { FLOWCHAIN_KNOWLEDGE_PROVIDER: 'parley', PARLEY_API_KEY: 'parley-test-key' }
const vector = () => Array.from({ length: 1536 }, (_, index) => index === 0 ? 1 : 0)

test('Parley preset pins both endpoints and ignores OpenAI-only model settings', () => {
  const env = knowledgeProviderEnv({ ...config, OPENAI_API_KEY: 'must-not-reuse', FLOWCHAIN_KNOWLEDGE_MODEL: 'gpt-4.1-mini' })
  assert.equal(env.FLOWCHAIN_AI_PROVIDER_KIND, 'parley_chat')
  assert.equal(env.FLOWCHAIN_AI_PROVIDER_ENDPOINT, 'https://parley.api.mit.edu/v1/chat/completions')
  assert.equal(env.FLOWCHAIN_AI_EMBEDDING_ENDPOINT, 'https://parley.api.mit.edu/v1/embeddings')
  assert.equal(env.FLOWCHAIN_AI_PROVIDER_API_KEY, 'parley-test-key')
  assert.equal(env.FLOWCHAIN_AI_PROVIDER_MODEL, 'claude-haiku-4-5')
  assert.equal(env.FLOWCHAIN_AI_EMBEDDING_MODEL, 'text-embedding-3-small')
  assert.equal(env.FLOWCHAIN_AI_EMBEDDING_DIMENSIONS, '1536')
})

test('Parley reuses the assistant key only when the assistant already points at Parley', async () => {
  const elsewhere = { FLOWCHAIN_KNOWLEDGE_PROVIDER: 'parley', OPENAI_API_KEY: 'must-not-reuse', FLOWCHAIN_AI_PROVIDER_ENDPOINT: 'https://parley.api.mit.edu.evil.test/v1/chat/completions', FLOWCHAIN_AI_PROVIDER_API_KEY: 'other-provider-key' }
  assert.equal(knowledgeProviderEnv(elsewhere).FLOWCHAIN_AI_PROVIDER_API_KEY, '')
  const result = await checkKnowledgeConnection(elsewhere, { embeddingProvider: async () => { throw Error('must not call') } })
  assert.equal(result.stage, 'configuration')
  const shared = knowledgeProviderEnv({ ...elsewhere, FLOWCHAIN_AI_PROVIDER_ENDPOINT: 'https://parley.api.mit.edu/v1/chat/completions', FLOWCHAIN_AI_PROVIDER_API_KEY: 'parley-assistant-key' })
  assert.equal(shared.FLOWCHAIN_AI_EMBEDDING_API_KEY, 'parley-assistant-key')
})

test('Parley chat requests a bounded JSON reply for knowledge and planning only', () => {
  const rag = parleyChatAdapter.buildRequestBody({ task: { type: 'knowledge_rag', question: 'Warranty?' }, evidencePackage: { citations: [] } }, { model: 'claude-haiku-4-5' })
  assert.deepEqual(rag.response_format, { type: 'json_object' })
  assert.equal(rag.max_tokens, 1200)
  const plan = parleyChatAdapter.buildRequestBody({ task: { type: 'business_query_planning', message: 'Late POs?' } }, { model: 'claude-haiku-4-5' })
  assert.deepEqual(plan.response_format, { type: 'json_object' })
  const answer = parleyChatAdapter.buildRequestBody({ task: { question: 'What first?' } }, { model: 'claude-haiku-4-5' })
  assert.equal(answer.response_format, undefined)
})

test('Parley connection validates generated answer and citations through the existing RAG pipeline', async () => {
  const calls = []
  const fetchImpl = async (url, options) => {
    calls.push(url)
    assert.ok(url.startsWith('https://parley.api.mit.edu/v1/'))
    assert.equal(options.headers.authorization, 'Bearer parley-test-key')
    const body = JSON.parse(options.body)
    const data = url.endsWith('/embeddings')
      ? { data: body.input.map((_, index) => ({ index, embedding: vector() })) }
      : { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify({ answer: 'The warranty is 18 months. [1]', citationIds: ['connection-passage'] }) } }] }
    return { ok: true, headers: new Headers({ 'content-type': 'application/json' }), json: async () => data }
  }
  const result = await checkKnowledgeConnection(config, {
    embeddingProvider: (inputs, env) => callConfiguredEmbeddingProvider(inputs, env, fetchImpl),
    provider: (input, env) => callConfiguredProvider(input, env, fetchImpl),
  })
  assert.equal(result.ok, true)
  assert.equal(result.dimensions, 1536)
  assert.equal(calls.length, 3)
  assert.doesNotMatch(JSON.stringify(result), /parley-test-key/)
})
