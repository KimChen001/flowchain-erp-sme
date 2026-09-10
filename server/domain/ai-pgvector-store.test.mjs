import test from 'node:test'
import assert from 'node:assert/strict'
import { hasPgvectorKnowledgeStore, persistPgvectorEmbeddings, pgvectorKnowledgeRanks } from './ai-pgvector-store.mjs'

test('pgvector store persists vectors, creates a model-dimension index, and scopes ranking', async () => {
  const queries = [], executions = []
  const prisma = {
    $queryRawUnsafe: async (sql, ...params) => { queries.push([sql, params]); return sql.startsWith('SELECT EXISTS') ? [{ enabled: true }] : [{ id: 'chunk-1', score: 0.91 }] },
    $executeRawUnsafe: async (sql, ...params) => { executions.push([sql, params]); return 1 },
  }
  const embedded = { ok: true, model: "embed-model'v1", dimensions: 2, vectors: [[1, 0]] }
  const stored = await persistPgvectorEmbeddings(prisma, [{ id: 'chunk-1' }], embedded)
  assert.equal(stored.enabled, true)
  assert.match(executions[0][0], /SET "embeddingVector" = \$1::vector/)
  assert.deepEqual(executions[0][1], ['[1,0]', 'chunk-1'])
  assert.match(executions[1][0], /USING hnsw/)
  assert.match(executions[1][0], /embed-model''v1/)
  const ranked = await pgvectorKnowledgeRanks(prisma, { tenantId: 'tenant-1', permissionCodes: new Set(['finance.payable.read']) }, [1, 0], embedded.model)
  assert.deepEqual(ranked, [{ id: 'chunk-1', score: 0.91 }])
  assert.deepEqual(queries.at(-1)[1], ['[1,0]', 'tenant-1', embedded.model, ['finance.payable.read']])
  assert.match(queries.at(-1)[0], /d\."tenantId" = \$2/)
})

test('pgvector capability detection fails closed', async () => {
  assert.equal(await hasPgvectorKnowledgeStore({}), false)
  assert.equal(await hasPgvectorKnowledgeStore({ $queryRawUnsafe: async () => { throw new Error('missing') } }), false)
})
