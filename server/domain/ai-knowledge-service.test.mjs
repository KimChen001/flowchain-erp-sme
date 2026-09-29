import test from 'node:test'
import assert from 'node:assert/strict'
import { Document } from '@langchain/core/documents'
import { WorkspaceKnowledgeRetriever, answerKnowledgeQuery, createKnowledgeService, knowledgeIndexSummary } from './ai-knowledge-service.mjs'
import { buildBoundedProviderRequestCore } from './ai-runtime-provider-specific-adapters-v2.mjs'

const documents = [new Document({ pageContent: 'The Zephyr controller uses a 24 volt power supply. Its warranty is 18 months.', metadata: { id: 'chunk-a', documentId: 'doc-a', title: 'Zephyr product guide', position: 0 } }), new Document({ pageContent: 'Staff submit travel receipts to the office administrator.', metadata: { id: 'chunk-b', documentId: 'doc-b', title: 'Travel expenses', position: 0 } })]
test('an exact SKU cannot be answered with a similar SKU document', async () => {
  const retriever = new WorkspaceKnowledgeRetriever({ loadDocuments: async () => [new Document({ pageContent: 'LDM-002 warranty is 18 months.', metadata: { id: 'b', title: 'Product guide', embeddingModel: 'v1', embedding: [1, 0] } })], queryEmbedding: [1, 0], embeddingModel: 'v1' })
  assert.deepEqual(await retriever.invoke('LDM-001 warranty'), [])
})
test('readiness checks vectors and model compatibility, not just metadata', () => {
  assert.equal(knowledgeIndexSummary([{ embeddingModel: 'v1', embeddingDimensions: 2 }]).indexStatus, 'keyword')
  assert.equal(knowledgeIndexSummary([{ embeddingModel: 'v1', embeddingDimensions: 2, embedding: [0, 0] }]).indexStatus, 'keyword')
  assert.equal(knowledgeIndexSummary([{ embeddingModel: 'v1', embeddingDimensions: 2, embedding: [1, 0] }], { model: 'v2', dimensions: 2 }).indexStatus, 'outdated')
})
test('citations do not expose vector payloads', async () => {
  const result = await answerKnowledgeQuery({ question: 'Zephyr warranty', actor: {}, service: { documents: async () => documents.map(doc => new Document({ ...doc, metadata: { ...doc.metadata, embedding: [1, 0], embeddingModel: 'private-model' } })) } })
  assert.equal(result.citations[0].sourceNumber, 1)
  assert.equal(result.citations[0].embedding, undefined)
  assert.equal(result.citations[0].embeddingModel, undefined)
})
test('LangChain retriever returns relevant passages and no unrelated fallback', async () => {
  const retriever = new WorkspaceKnowledgeRetriever({ loadDocuments: async () => documents })
  assert.deepEqual((await retriever.invoke('Zephyr warranty')).map(d => d.metadata.id), ['chunk-a'])
  assert.deepEqual(await retriever.invoke('quantum spaceflight'), [])
})
test('retrieval without a model is explicitly labelled and carries original passages', async () => {
  const result = await answerKnowledgeQuery({ question: 'Zephyr warranty', actor: {}, service: { documents: async () => documents } })
  assert.equal(result.mode, 'retrieved_excerpts')
  assert.match(result.answer, /18 months/)
  assert.equal(result.citations[0].documentId, 'doc-a')
})
test('RAG provider request is bounded and rejects invented citation IDs', async () => {
  const env = { FLOWCHAIN_AI_RUNTIME_MODE: 'provider_assisted', FLOWCHAIN_AI_PROVIDER_KIND: 'deepseek_chat', FLOWCHAIN_AI_PROVIDER_ENDPOINT: 'https://example.invalid/chat', FLOWCHAIN_AI_PROVIDER_API_KEY: 'test-only', FLOWCHAIN_AI_PROVIDER_MODEL: 'test' }
  let called = false
  const result = await answerKnowledgeQuery({ question: 'Zephyr warranty', actor: {}, service: { documents: async () => documents }, env, provider: async input => {
    called = true
    const core = buildBoundedProviderRequestCore(input)
    assert.equal(core.task.type, 'knowledge_rag')
    assert.equal(core.evidencePackage.citations.length, 1)
    assert.doesNotMatch(JSON.stringify(core), /test-only/)
    return { ok: true, rawOutput: { conclusion: { summary: JSON.stringify({ answer: 'Unsupported answer', citationIds: ['forged'] }) } } }
  } })
  assert.equal(called, true)
  assert.equal(result.mode, 'model_unavailable')
  assert.doesNotMatch(result.answer, /Unsupported answer/)
})
test('management is denied before persistence and tenant/audience scopes are applied before retrieval', async () => {
  let where
  const service = createKnowledgeService({ aiKnowledgeChunk: { findMany: async args => { where = args.where; return [] } } })
  await assert.rejects(service.add({ tenantId: 't1', permissionCodes: new Set() }, {}), { code: 'KNOWLEDGE_MANAGE_DENIED' })
  await service.documents({ tenantId: 't1', permissionCodes: new Set(['finance.payable.read']) })
  assert.equal(where.document.tenantId, 't1')
  assert.equal(where.document.status, 'active')
  assert.deepEqual(where.document.OR[1].requiredPermission.in, ['finance.payable.read'])
})

test('configured generation accepts only references retrieved for this request', async () => {
  const env = { FLOWCHAIN_AI_RUNTIME_MODE: 'provider_assisted', FLOWCHAIN_AI_PROVIDER_KIND: 'deepseek_chat', FLOWCHAIN_AI_PROVIDER_ENDPOINT: 'https://example.invalid/chat', FLOWCHAIN_AI_PROVIDER_API_KEY: 'test-only', FLOWCHAIN_AI_PROVIDER_MODEL: 'test' }
  const result = await answerKnowledgeQuery({ question: 'Zephyr warranty', actor: {}, service: { documents: async () => documents }, env, provider: async () => ({ ok: true, rawOutput: { conclusion: { summary: JSON.stringify({ answer: 'The warranty is 18 months. [1]', citationIds: ['chunk-a'] }) } } }) })
  assert.equal(result.mode, 'generated')
  assert.equal(result.citations[0].documentId, 'doc-a')
  assert.match(result.answer, /18 months/)
})

test('knowledge list reports semantic, partial, and keyword index coverage', async () => {
  const rows = [
    { id: 'semantic', chunks: [{ embedding: [1, 0, 0], embeddingModel: 'embed-v1', embeddingDimensions: 3 }], _count: { chunks: 1 } },
    { id: 'partial', chunks: [{ embedding: [1, 0, 0], embeddingModel: 'embed-v1', embeddingDimensions: 3 }, { embeddingModel: null, embeddingDimensions: null }], _count: { chunks: 2 } },
    { id: 'keyword', chunks: [{ embeddingModel: null, embeddingDimensions: null }], _count: { chunks: 1 } },
  ]
  const service = createKnowledgeService({ aiKnowledgeDocument: { findMany: async () => rows } })
  const result = await service.list({ tenantId: 't1', permissionCodes: new Set() })
  assert.deepEqual(result.items.map(item => item.indexStatus), ['semantic', 'partial', 'keyword'])
  assert.equal(result.items[0].embeddingModel, 'embed-v1')
  assert.equal(result.items[2].embeddingModel, null)
})

test('reindex replaces all chunk vectors atomically and preserves existing data on provider failure', async () => {
  const chunks = [{ id: 'c1', content: 'first passage' }, { id: 'c2', content: 'second passage' }]
  const updates = []
  const prisma = {
    aiKnowledgeDocument: { findFirst: async () => ({ id: 'doc-1', chunks }), updateMany: async () => ({ count: 1 }) },
    aiKnowledgeChunk: { update: args => { updates.push(args); return Promise.resolve(args) } },
    $transaction: async callback => callback(prisma),
  }
  const actor = { tenantId: 't1', permissionCodes: new Set(['settings.workspace.manage']) }
  const service = createKnowledgeService(prisma, { embeddingProvider: async () => ({ ok: true, model: 'embed-v2', dimensions: 2, vectors: [[1, 0], [0, 1]] }) })
  const result = await service.reindex(actor, 'doc-1')
  assert.equal(result.indexStatus, 'semantic')
  assert.equal(updates.length, 2)
  assert.equal(updates[0].data.embeddingModel, 'embed-v2')
  assert.match(updates[0].data.contentHash, /^[a-f0-9]{64}$/)

  updates.length = 0
  const unavailable = createKnowledgeService(prisma, { embeddingProvider: async () => ({ ok: false, reason: 'timeout' }) })
  await assert.rejects(unavailable.reindex(actor, 'doc-1'), { code: 'KNOWLEDGE_EMBEDDING_UNAVAILABLE', status: 503 })
  assert.equal(updates.length, 0)
})
