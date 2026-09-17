import test from 'node:test'
import assert from 'node:assert/strict'
import { createPrismaClient } from '../../server/persistence/prisma-client.mjs'
import { createKnowledgeService, answerKnowledgeQuery } from '../../server/domain/ai-knowledge-service.mjs'

test('knowledge ingestion, retrieval, audience isolation, and archive persist in PostgreSQL', async () => {
  const prisma = await createPrismaClient(process.env)
  const admin = { tenantId: 'rag-t1', userId: 'rag-admin', permissionCodes: new Set(['settings.workspace.manage', 'finance.payable.read']) }
  const reader = { ...admin, permissionCodes: new Set() }
  try {
    await prisma.tenant.createMany({ data: [{ id: 'rag-t1', name: 'RAG workspace' }, { id: 'rag-t2', name: 'Other workspace' }] })
    const service = createKnowledgeService(prisma, { embeddingProvider: async inputs => ({ ok: true, model: 'embedding-test-v1', dimensions: 3, vectors: inputs.map((_, index) => [1, index, 0]) }) })
    const doc = await service.add(admin, { title: 'Example Zephyr product guide', content: 'Zephyr uses a 24 volt supply. Its warranty lasts 18 months. This is fictional demonstration information.' })
    const secret = await service.add(admin, { title: 'Private finance note', content: 'Confidential Zephyr purchase discount is available only to finance reviewers.', requiredPermission: 'finance.payable.read' })
    const other = await service.add({ ...admin, tenantId: 'rag-t2' }, { title: 'Other tenant Zephyr guide', content: 'Other workspace proprietary Zephyr documentation must not be visible here.' })
    const answer = await answerKnowledgeQuery({ question: 'Zephyr warranty', actor: reader, service })
    assert.match(answer.answer, /18 months/)
    assert.deepEqual(answer.citations.map(c => c.documentId), [doc.id])
    const indexed = (await service.documents(reader)).find(row => row.metadata.documentId === doc.id)
    assert.equal(indexed.metadata.embeddingModel, 'embedding-test-v1')
    assert.equal(indexed.metadata.embeddingDimensions, 3)
    assert.match(indexed.metadata.contentHash, /^[a-f0-9]{64}$/)
    const reindexService = createKnowledgeService(prisma, { embeddingProvider: async inputs => ({ ok: true, model: 'embedding-test-v2', dimensions: 2, vectors: inputs.map(() => [0, 1]) }) })
    const reindexed = await reindexService.reindex(admin, doc.id)
    assert.equal(reindexed.embeddingModel, 'embedding-test-v2')
    const upgraded = (await reindexService.documents(reader)).find(row => row.metadata.documentId === doc.id)
    assert.equal(upgraded.metadata.embeddingModel, 'embedding-test-v2')
    assert.equal(upgraded.metadata.embeddingDimensions, 2)
    // Reuse requires the exact content hash, model, and dimension combination.
    const matchingEnv = { FLOWCHAIN_AI_EMBEDDING_MODEL: 'embedding-test-v2', FLOWCHAIN_AI_EMBEDDING_DIMENSIONS: '2' }
    const cachedService = createKnowledgeService(prisma, { env: matchingEnv, embeddingProvider: async () => { throw new Error('unchanged chunks must be reused') } })
    assert.equal((await cachedService.reindex(admin, doc.id)).reusedChunks, 1)

    const failedService = createKnowledgeService(prisma, { embeddingProvider: async () => ({ ok: false, reason: 'timeout' }) })
    await assert.rejects(failedService.reindex(admin, doc.id), { code: 'KNOWLEDGE_EMBEDDING_UNAVAILABLE' })
    const afterFailure = await prisma.aiKnowledgeDocument.findUnique({ where: { id: doc.id }, include: { chunks: true } })
    assert.equal(afterFailure.indexAttemptStatus, 'failed')
    assert.equal(afterFailure.indexAttemptError, 'KNOWLEDGE_EMBEDDING_UNAVAILABLE')
    assert.deepEqual(afterFailure.chunks[0].embedding, [0, 1])
    assert.equal(afterFailure.chunks[0].embeddingModel, 'embedding-test-v2')

    // Hold the provider while a competing request tries to claim the same document.
    let release, started
    const providerStarted = new Promise(resolve => { started = resolve })
    const heldProvider = new Promise(resolve => { release = resolve })
    const heldService = createKnowledgeService(prisma, { embeddingProvider: async () => { started(); await heldProvider; return { ok: true, model: 'embedding-test-v3', dimensions: 2, vectors: [[1, 0]] } } })
    const activeAttempt = heldService.reindex(admin, doc.id)
    await providerStarted
    try {
      await assert.rejects(service.reindex(admin, doc.id), { code: 'KNOWLEDGE_INDEX_BUSY' })
      assert.equal((await service.list(reader)).items.find(item => item.id === doc.id).indexAttemptStatus, 'processing')
    } finally { release(); await activeAttempt }

    // An actual transaction error after updating a chunk must roll back both vectors and readiness.
    const original = await prisma.aiKnowledgeChunk.findFirst({ where: { documentId: doc.id } })
    const faultPrisma = { aiKnowledgeDocument: prisma.aiKnowledgeDocument, aiKnowledgeChunk: prisma.aiKnowledgeChunk, $transaction: (callback, options) => prisma.$transaction(async tx => {
      await callback(tx)
      throw new Error('simulated commit failure')
    }, options) }
    const faultService = createKnowledgeService(faultPrisma, { embeddingProvider: async () => ({ ok: true, model: 'must-not-commit', dimensions: 2, vectors: [[0, 1]] }) })
    await assert.rejects(faultService.reindex(admin, doc.id), { code: 'KNOWLEDGE_INDEX_WRITE_FAILED' })
    const afterRollback = await prisma.aiKnowledgeChunk.findUnique({ where: { id: original.id } })
    assert.deepEqual(afterRollback.embedding, original.embedding)
    assert.equal(afterRollback.embeddingModel, original.embeddingModel)
    assert.equal((await service.list(reader)).items.find(item => item.id === doc.id).indexAttemptStatus, 'failed')

    // Abandoned attempts are visible and reclaimable after the lease expires.
    await prisma.aiKnowledgeDocument.update({ where: { id: doc.id }, data: { indexAttemptStatus: 'processing', indexAttemptStartedAt: new Date(Date.now() - 16 * 60 * 1000) } })
    assert.equal((await service.list(reader)).items.find(item => item.id === doc.id).indexAttemptError, 'interrupted')
    await reindexService.reindex(admin, doc.id)
    assert.equal((await service.list(reader)).items.find(item => item.id === doc.id).indexAttemptStatus, 'ready')

    const keywordService = createKnowledgeService(prisma, { env: {} })
    const keywordDoc = await keywordService.add(admin, { title: 'Keyword-only guide', content: 'Orion product support is available during business hours.' })
    assert.equal(keywordDoc.indexAttemptError, 'KNOWLEDGE_EMBEDDING_NOT_CONFIGURED')
    assert.equal((await keywordService.get(reader, keywordDoc.id)).chunks.length, 1)
    assert.equal((await keywordService.list(reader)).capabilities.embeddingConfigured, false)
    await keywordService.archive(admin, keywordDoc.id)
    await assert.rejects(service.get(reader, secret.id), { status: 404 })
    await assert.rejects(service.get(admin, other.id), { status: 404 })
    const restartedService = createKnowledgeService(prisma)
    assert.equal((await restartedService.get(reader, doc.id)).title, doc.title)
    await service.archive(admin, doc.id)
    assert.equal((await answerKnowledgeQuery({ question: 'Zephyr warranty', actor: reader, service })).mode, 'no_results')
    await assert.rejects(service.get(reader, doc.id), { status: 404 })
  } finally { await prisma.$disconnect() }
})
