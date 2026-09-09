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
    await assert.rejects(service.get(reader, secret.id), { status: 404 })
    await assert.rejects(service.get(admin, other.id), { status: 404 })
    const restartedService = createKnowledgeService(prisma)
    assert.equal((await restartedService.get(reader, doc.id)).title, doc.title)
    await service.archive(admin, doc.id)
    assert.equal((await answerKnowledgeQuery({ question: 'Zephyr warranty', actor: reader, service })).mode, 'no_results')
    await assert.rejects(service.get(reader, doc.id), { status: 404 })
  } finally { await prisma.$disconnect() }
})
