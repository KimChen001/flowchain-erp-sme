import test from 'node:test'
import assert from 'node:assert/strict'
import { Document } from '@langchain/core/documents'
import { callConfiguredEmbeddingProvider, cosineSimilarity } from './ai-embedding-provider.mjs'
import { WorkspaceKnowledgeRetriever } from './ai-knowledge-service.mjs'

const env = { FLOWCHAIN_AI_EMBEDDING_ENDPOINT: 'https://embedding.invalid/v1/embeddings', FLOWCHAIN_AI_EMBEDDING_API_KEY: 'test-key', FLOWCHAIN_AI_EMBEDDING_MODEL: 'embedding-v1', FLOWCHAIN_AI_EMBEDDING_DIMENSIONS: '2' }
test('large imports preserve order across bounded batches without truncation', async () => {
  const sizes = []
  const result = await callConfiguredEmbeddingProvider(Array.from({ length: 129 }, (_, i) => `passage ${i}`), env, async (_url, options) => {
    const { input } = JSON.parse(options.body); sizes.push(input.length)
    return { ok: true, json: async () => ({ data: input.map((text, index) => ({ index, embedding: [1, Number(text.split(' ')[1])] })).reverse() }) }
  })
  assert.deepEqual(sizes, [32, 32, 32, 32, 1])
  assert.deepEqual(result.vectors, Array.from({ length: 129 }, (_, i) => [1, i]))
})
test('zero vectors, duplicate indexes, wrong dimensions, and oversized input fail closed', async () => {
  for (const data of [[{ index: 0, embedding: [0, 0] }], [{ index: 1, embedding: [1, 0] }], [{ index: 0, embedding: [1, 0, 0] }], [{ index: 0, embedding: [1, 0] }, { index: 0, embedding: [0, 1] }]]) {
    assert.equal((await callConfiguredEmbeddingProvider(['guide'], env, async () => ({ ok: true, json: async () => ({ data }) }))).ok, false)
  }
  const result = await callConfiguredEmbeddingProvider(['a'.repeat(12001)], env, async () => { throw new Error('must not call') })
  assert.equal(result.reason, 'invalid_input')
})
test('transient provider failures retry; authentication failures do not', async () => {
  let calls = 0
  const result = await callConfiguredEmbeddingProvider(['guide'], env, async () => ++calls < 3 ? { ok: false, status: 429, json: async () => ({ error: { code: 'rate_limit_exceeded' } }) } : { ok: true, json: async () => ({ data: [{ index: 0, embedding: [1, 0] }] }) })
  assert.equal(result.ok, true); assert.equal(calls, 3)
  calls = 0
  assert.equal((await callConfiguredEmbeddingProvider(['guide'], env, async () => { calls++; return { ok: false, status: 401 } })).ok, false)
  assert.equal(calls, 1)
})
test('exhausted quota is not retried and upstream messages are not exposed', async () => {
  let calls = 0
  const result = await callConfiguredEmbeddingProvider(['guide'], env, async () => { calls++; return { ok: false, status: 429, json: async () => ({ error: { code: 'insufficient_quota', message: 'sensitive upstream details' } }) } })
  assert.equal(calls, 1)
  assert.deepEqual(result, { ok: false, reason: 'quota_exceeded' })
})

test('embedding provider batches inputs and validates configured dimensions', async () => {
  let request
  const result = await callConfiguredEmbeddingProvider(['motor guide', 'warranty'], {
    FLOWCHAIN_AI_EMBEDDING_ENDPOINT: 'https://embedding.invalid/v1/embeddings',
    FLOWCHAIN_AI_EMBEDDING_API_KEY: 'test-key', FLOWCHAIN_AI_EMBEDDING_MODEL: 'embedding-v1', FLOWCHAIN_AI_EMBEDDING_DIMENSIONS: '3',
  }, async (_url, options) => {
    request = JSON.parse(options.body)
    return { ok: true, json: async () => ({ data: [{ index: 1, embedding: [0, 1, 0] }, { index: 0, embedding: [1, 0, 0] }] }) }
  })
  assert.deepEqual(request, { model: 'embedding-v1', input: ['motor guide', 'warranty'], dimensions: 3 })
  assert.deepEqual(result, { ok: true, vectors: [[1, 0, 0], [0, 1, 0]], model: 'embedding-v1', dimensions: 3 })
})

test('cosine similarity rejects incompatible vectors', () => {
  assert.equal(cosineSimilarity([1, 0], [1, 0]), 1)
  assert.equal(cosineSimilarity([1], [1, 0]), null)
  assert.equal(cosineSimilarity([0, 0], [1, 0]), null)
})

test('hybrid retriever can find a semantic match and ignores another embedding model', async () => {
  const documents = [
    new Document({ pageContent: 'Unrelated wording', metadata: { id: 'semantic', embedding: [1, 0], embeddingModel: 'embedding-v1' } }),
    new Document({ pageContent: 'motor motor motor', metadata: { id: 'lexical', embedding: [0, 1], embeddingModel: 'embedding-v1' } }),
    new Document({ pageContent: 'Other model', metadata: { id: 'wrong-model', embedding: [1, 0], embeddingModel: 'embedding-v0' } }),
  ]
  const retriever = new WorkspaceKnowledgeRetriever({ loadDocuments: async () => documents, queryEmbedding: [1, 0], embeddingModel: 'embedding-v1', limit: 3 })
  assert.deepEqual((await retriever.invoke('motor')).map(item => item.metadata.id), ['semantic', 'lexical'])
})
