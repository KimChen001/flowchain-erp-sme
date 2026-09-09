import test from 'node:test'
import assert from 'node:assert/strict'
import { Document } from '@langchain/core/documents'
import { WorkspaceKnowledgeRetriever, answerKnowledgeQuery, createKnowledgeService } from './ai-knowledge-service.mjs'
import { buildBoundedProviderRequestCore } from './ai-runtime-provider-specific-adapters-v2.mjs'

const documents = [new Document({ pageContent: 'The Zephyr controller uses a 24 volt power supply. Its warranty is 18 months.', metadata: { id: 'chunk-a', documentId: 'doc-a', title: 'Zephyr product guide', position: 0 } }), new Document({ pageContent: 'Staff submit travel receipts to the office administrator.', metadata: { id: 'chunk-b', documentId: 'doc-b', title: 'Travel expenses', position: 0 } })]
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
