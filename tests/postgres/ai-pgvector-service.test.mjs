import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createPrismaClient } from '../../server/persistence/prisma-client.mjs'
import { createKnowledgeService } from '../../server/domain/ai-knowledge-service.mjs'
import { hasPgvectorKnowledgeStore } from '../../server/domain/ai-pgvector-store.mjs'

test('configured PostgreSQL service persists and ranks knowledge through pgvector', async () => {
  const prisma = await createPrismaClient(process.env)
  const tenantId = `pgvector-${randomUUID()}`
  const actor = { tenantId, userId: 'pgvector-admin', permissionCodes: new Set(['settings.workspace.manage']) }
  try {
    assert.equal(await hasPgvectorKnowledgeStore(prisma), true)
    await prisma.tenant.create({ data: { id: tenantId, name: 'pgvector verification' } })
    const service = createKnowledgeService(prisma, { embeddingProvider: async inputs => ({ ok: true, model: 'pgvector-ci-v1', dimensions: 3, vectors: inputs.map(() => [1, 0, 0]) }) })
    const document = await service.add(actor, { title: 'Vector indexed motor guide', content: 'The industrial motor requires a scheduled bearing inspection every six months.' })
    const ranks = await service.semanticRanks(actor, [1, 0, 0], 'pgvector-ci-v1')
    assert.equal(ranks[0].id, (await service.documents(actor))[0].metadata.id)
    const indexes = await prisma.$queryRawUnsafe(`SELECT indexname FROM pg_indexes WHERE tablename = 'AiKnowledgeChunk' AND indexname LIKE 'AiKnowledgeChunk_embedding_hnsw_%'`)
    assert.ok(indexes.length >= 1)
    await prisma.aiKnowledgeDocument.delete({ where: { id: document.id } })
  } finally {
    await prisma.tenant.deleteMany({ where: { id: tenantId } }).catch(() => {})
    await prisma.$disconnect()
  }
})
