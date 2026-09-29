import test from 'node:test'
import assert from 'node:assert/strict'
import { knowledgeProviderEnv } from './ai-knowledge-config.mjs'
import { callConfiguredEmbeddingProvider } from './ai-embedding-provider.mjs'
import { callConfiguredProvider } from './ai-runtime-provider-adapter-v2.mjs'
import { checkKnowledgeConnection } from '../../scripts/check-knowledge-provider.mjs'

const config = { FLOWCHAIN_KNOWLEDGE_PROVIDER: 'qwen', FLOWCHAIN_QWEN_REGION: 'ap-southeast-1', FLOWCHAIN_QWEN_WORKSPACE_ID: 'test-workspace', DASHSCOPE_API_KEY: 'qwen-test-key' }
const vector = () => Array.from({ length: 1024 }, (_, index) => index === 0 ? 1 : 0)

test('Qwen requires its own credentials and validated regional workspace', async () => {
  for (const override of [{ DASHSCOPE_API_KEY: '', OPENAI_API_KEY: 'must-not-reuse' }, { FLOWCHAIN_QWEN_REGION: 'us-east-1' }, { FLOWCHAIN_QWEN_WORKSPACE_ID: 'evil.test/path' }]) {
    const result = await checkKnowledgeConnection({ ...config, ...override }, { embeddingProvider: async () => { throw Error('must not call') } })
    assert.equal(result.stage, 'configuration')
  }
  const env = knowledgeProviderEnv({ ...config, FLOWCHAIN_KNOWLEDGE_MODEL: 'gpt-4.1-mini', FLOWCHAIN_KNOWLEDGE_EMBEDDING_MODEL: 'text-embedding-3-small' })
  assert.equal(env.FLOWCHAIN_AI_PROVIDER_MODEL, 'qwen-flash')
  assert.equal(env.FLOWCHAIN_AI_EMBEDDING_MODEL, 'text-embedding-v4')
})

test('Qwen embedding batches respect the ten-input limit', async () => {
  const batches = []
  const result = await callConfiguredEmbeddingProvider(Array.from({ length: 11 }, (_, i) => `Passage ${i}`), knowledgeProviderEnv(config), async (_, options) => {
    const body = JSON.parse(options.body)
    batches.push(body.input.length)
    return { ok: true, json: async () => ({ data: body.input.map((_, index) => ({ index, embedding: vector() })) }) }
  })
  assert.equal(result.ok, true)
  assert.deepEqual(batches, [10, 1])
  assert.equal(result.vectors.length, 11)
})

test('Qwen connection validates generated answer and citations through the existing RAG pipeline', async () => {
  const calls = []
  const fetchImpl = async (url, options) => {
    calls.push(url)
    assert.ok(url.startsWith('https://test-workspace.ap-southeast-1.maas.aliyuncs.com/'))
    const body = JSON.parse(options.body)
    let data
    if (url.endsWith('/embeddings')) data = { data: body.input.map((_, index) => ({ index, embedding: vector() })) }
    else {
      assert.equal(body.enable_thinking, false)
      assert.equal(body.response_format.type, 'json_object')
      assert.equal(body.max_tokens, 1200)
      data = { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify({ answer: 'The warranty is 18 months. [1]', citationIds: ['connection-passage'] }) } }] }
    }
    return { ok: true, headers: new Headers({ 'content-type': 'application/json' }), json: async () => data }
  }
  const result = await checkKnowledgeConnection(config, {
    embeddingProvider: (inputs, env) => callConfiguredEmbeddingProvider(inputs, env, fetchImpl),
    provider: (input, env) => callConfiguredProvider(input, env, fetchImpl),
  })
  assert.equal(result.ok, true)
  assert.equal(result.dimensions, 1024)
  assert.equal(calls.length, 3)
  assert.doesNotMatch(JSON.stringify(result), /qwen-test-key/)
})
