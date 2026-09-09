import test from 'node:test'
import assert from 'node:assert/strict'
import { Document } from '@langchain/core/documents'
import { callConfiguredEmbeddingProvider, cosineSimilarity } from './ai-embedding-provider.mjs'
import { WorkspaceKnowledgeRetriever } from './ai-knowledge-service.mjs'

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
