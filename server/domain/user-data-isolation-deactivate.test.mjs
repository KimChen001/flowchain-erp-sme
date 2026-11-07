import test from 'node:test'
import assert from 'node:assert/strict'
import { createEmptyDataset } from './data-mode.mjs'
import { normalizeUserDataImportPayload } from './user-data-contract.mjs'
import { createInMemoryUserDataRuntimeRepository } from '../repositories/user-data-runtime-repository.mjs'
import { createAuditLogRepository } from '../repositories/audit-log-repository.mjs'
import { handleUserDataRoute } from '../routes/user-data.routes.mjs'

function payload(label, scope) {
  return {
    sourceName: `phase-r179-${label}`,
    ...scope,
    purchaseOrders: [{ poId: `PO-${label}`, supplierName: `Supplier ${label}`, lines: [{ itemSku: `SKU-${label}`, quantity: '5' }] }],
    purchaseRequests: [{ prId: `PR-${label}`, itemSku: `SKU-${label}`, quantity: '5', requiredDate: '2026-07-12' }],
    products: [{ itemSku: `SKU-${label}`, itemName: `Item ${label}`, currentStock: '1', safetyStock: '4' }],
  }
}

async function persist(repository, result) {
  const batch = await repository.createImportBatch({
    scope: result.scope,
    datasetId: result.normalizedSnapshot.datasetId,
    snapshotHash: result.normalizedSnapshot.normalizedSnapshotHash,
    recordCounts: result.recordCounts,
  })
  await repository.persistNormalizedRecords({
    scope: result.scope,
    datasetId: batch.datasetId,
    importBatchId: batch.importBatchId,
    normalizedSnapshot: result.normalizedSnapshot,
  })
  return batch
}

function routeContext({ body, repository, db = createEmptyDataset({ mode: 'user' }) }) {
  let response = null
  return {
    ctx: {
      req: { method: 'POST', body, headers: {} },
      res: {},
      url: new URL('/api/user-data/import/deactivate', 'http://localhost'),
      db,
      repositories: {
        userDataRuntime: repository,
        auditLog: createAuditLogRepository(db),
      },
      readBody: async (req) => req.body,
      send(_res, status, payload) {
        response = { status, payload }
      },
    },
    get response() {
      return response
    },
  }
}

async function withDeactivateFlag(fn) {
  const previous = process.env.FLOWCHAIN_ENABLE_USER_IMPORT_COMMIT
  process.env.FLOWCHAIN_ENABLE_USER_IMPORT_COMMIT = 'true'
  try {
    await fn()
  } finally {
    if (previous === undefined) delete process.env.FLOWCHAIN_ENABLE_USER_IMPORT_COMMIT
    else process.env.FLOWCHAIN_ENABLE_USER_IMPORT_COMMIT = previous
  }
}

test('R180 deactivate requires confirmation and scoped import batch', async () => {
  await withDeactivateFlag(async () => {
    const repository = createInMemoryUserDataRuntimeRepository()
    const result = normalizeUserDataImportPayload(payload('ROLL', { tenantId: 'tenant-r180', userId: 'user-r180' }), { scope: { tenantId: 'tenant-r180', userId: 'user-r180' } })
    const batch = await persist(repository, result)

    const missingConfirmation = routeContext({
      repository,
      body: { scope: result.scope, importBatchId: batch.importBatchId },
    })
    assert.equal(await handleUserDataRoute(missingConfirmation.ctx), true)
    assert.equal(missingConfirmation.response.status, 422)
    assert.equal(missingConfirmation.response.payload.errors[0].code, 'missing_confirmation')
    assert.equal((await repository.getActiveDataset(result.scope)).active, true)

    const wrongScope = routeContext({
      repository,
      body: { scope: { tenantId: 'tenant-r180', userId: 'other-user' }, importBatchId: batch.importBatchId, confirmDeactivate: true },
    })
    assert.equal(await handleUserDataRoute(wrongScope.ctx), true)
    assert.equal(wrongScope.response.status, 404)
    assert.equal((await repository.getActiveDataset(result.scope)).active, true)
  })
})

