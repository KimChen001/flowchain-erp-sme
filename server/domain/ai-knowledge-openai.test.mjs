import test from 'node:test'
import assert from 'node:assert/strict'
import { knowledgeProviderEnv } from './ai-knowledge-config.mjs'
import { callConfiguredEmbeddingProvider } from './ai-embedding-provider.mjs'
import { callConfiguredProvider } from './ai-runtime-provider-adapter-v2.mjs'
import { openaiResponsesAdapter } from './ai-runtime-provider-specific-adapters-v2.mjs'
import { checkKnowledgeConnection } from '../../scripts/check-knowledge-provider.mjs'

test('OpenAI preset is opt-in, scoped, and pins credentials to official endpoints', () => {
  const source = { OPENAI_API_KEY: 'test-key', FLOWCHAIN_AI_PROVIDER_ENDPOINT: 'https://unrelated.invalid', FLOWCHAIN_AI_PROVIDER_KIND: 'disabled' }
  assert.equal(knowledgeProviderEnv(source), source)
  const configured = knowledgeProviderEnv({ ...source, FLOWCHAIN_KNOWLEDGE_PROVIDER: 'openai' })
  assert.equal(configured.FLOWCHAIN_AI_PROVIDER_ENDPOINT, 'https://api.openai.com/v1/responses')
  assert.equal(configured.FLOWCHAIN_AI_EMBEDDING_ENDPOINT, 'https://api.openai.com/v1/embeddings')
  assert.equal(configured.FLOWCHAIN_AI_EMBEDDING_DIMENSIONS, '1536')
  assert.equal(source.FLOWCHAIN_AI_PROVIDER_KIND, 'disabled')
})
test('missing credentials stop before any provider request', async () => {
  const result = await checkKnowledgeConnection({ FLOWCHAIN_KNOWLEDGE_PROVIDER: 'openai' }, { embeddingProvider: async () => { throw Error('must not call') } })
  assert.equal(result.stage, 'configuration')
})
test('OpenAI RAG request uses strict JSON, bounded output, and no response storage', () => {
  const body = openaiResponsesAdapter.buildRequestBody({ task: { type: 'knowledge_rag', question: 'Warranty?' }, evidencePackage: { citations: [{ id: 'c1', sourceNumber: 2, excerpt: '18 months' }] } }, { model: 'gpt-4.1-mini' })
  assert.equal(body.store, false)
  assert.equal(body.text.format.strict, true)
  assert.equal(body.max_output_tokens, 1200)
  assert.equal(JSON.parse(body.input[1].content[0].text).evidencePackage.citations[0].sourceNumber, 2)
})
test('full connection check handles Responses message after reasoning and validates source', async () => {
  const calls = []
  const fetchImpl = async (url, options) => {
    calls.push(url)
    const body = JSON.parse(options.body)
    const data = url.endsWith('/embeddings') ? { data: body.input.map((_, index) => ({ index, embedding: Array.from({ length: 1536 }, (_, i) => i === 0 ? 1 : 0) })) } : { status: 'completed', output: [{ type: 'reasoning', summary: [] }, { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify({ answer: 'The warranty is 18 months. [1]', citationIds: ['connection-passage'] }) }] }] }
    return { ok: true, headers: new Headers({ 'content-type': 'application/json' }), json: async () => data }
  }
  const result = await checkKnowledgeConnection({ FLOWCHAIN_KNOWLEDGE_PROVIDER: 'openai', OPENAI_API_KEY: 'test-key' }, {
    embeddingProvider: (inputs, env) => callConfiguredEmbeddingProvider(inputs, env, fetchImpl),
    provider: (input, env) => callConfiguredProvider(input, env, fetchImpl),
  })
  assert.equal(result.ok, true)
  assert.equal(result.dimensions, 1536)
  assert.equal(calls.length, 3)
  assert.doesNotMatch(JSON.stringify(result), /test-key/)
})
