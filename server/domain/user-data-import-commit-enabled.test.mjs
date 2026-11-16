import test from 'node:test'
import assert from 'node:assert/strict'
import { createEmptyDataset } from './data-mode.mjs'
import { normalizeUserDataImportPayload } from './user-data-contract.mjs'
import { createInMemoryUserDataRuntimeRepository } from '../repositories/user-data-runtime-repository.mjs'
import { createAuditLogRepository } from '../repositories/audit-log-repository.mjs'
import { handleUserDataRoute } from '../routes/user-data.routes.mjs'

function payload() {
  return {
    sourceName: 'phase-r174-import',
    tenantId: 'tenant-r174',
    userId: 'user-r174',
    purchaseOrders: [{ poId: 'PO-R174-1', supplierName: 'R174 Supplier', lines: [{ itemSku: 'SKU-R174-1', quantity: '8' }] }],
    purchaseRequests: [{ prId: 'PR-R174-1', itemSku: 'SKU-R174-1', quantity: '8', requiredDate: '2026-07-12' }],
    products: [{ itemSku: 'SKU-R174-1', itemName: 'R174 Item', currentStock: '2', safetyStock: '6' }],
    suppliers: [{ supplierId: 'SUP-R174-1', supplierName: 'R174 Supplier' }],
  }
}

function createRoute({ body, envEnabled = true, db = createEmptyDataset({ mode: 'user' }), repositories, identity = { authenticated: true, tenantId: 'tenant-r174', userId: 'user-r174' } } = {}) {
  let response = null
  const previous = process.env.FLOWCHAIN_ENABLE_USER_IMPORT_COMMIT
  if (envEnabled) process.env.FLOWCHAIN_ENABLE_USER_IMPORT_COMMIT = 'true'
  else delete process.env.FLOWCHAIN_ENABLE_USER_IMPORT_COMMIT
  const routeRepositories = repositories || {
    userDataRuntime: createInMemoryUserDataRuntimeRepository(),
    auditLog: createAuditLogRepository(db),
  }
  return {
    ctx: {
      req: { method: 'POST', body, headers: {} },
      res: {},
      url: new URL('/api/user-data/import/commit', 'http://localhost'),
      identity,
      db,
      repositories: routeRepositories,
      readBody: async (req) => req.body,
      send(_res, status, payload) {
        response = { status, payload }
      },
    },
    repositories: routeRepositories,
    restore() {
      if (previous === undefined) delete process.env.FLOWCHAIN_ENABLE_USER_IMPORT_COMMIT
      else process.env.FLOWCHAIN_ENABLE_USER_IMPORT_COMMIT = previous
    },
    get response() {
      return response
    },
  }
}

function commitBody(overrides = {}) {
  const result = normalizeUserDataImportPayload(payload(), {
    importedAt: '2026-07-02T00:00:00.000Z',
    scope: { tenantId: 'tenant-r174', userId: 'user-r174' },
  })
  return {
    normalizedSnapshot: result.normalizedSnapshot,
    normalizedSnapshotHash: result.normalizedSnapshot.normalizedSnapshotHash,
    confirmCommit: true,
    ...overrides,
  }
}

test('R174 import commit remains disabled by default', async () => {
  const route = createRoute({ body: commitBody(), envEnabled: false })
  try {
    assert.equal(await handleUserDataRoute(route.ctx), true)
    assert.equal(route.response.status, 501)
    assert.equal(route.response.payload.commitAccepted, false)
    assert.equal(route.response.payload.featureFlag, 'FLOWCHAIN_ENABLE_USER_IMPORT_COMMIT')
    assert.equal(route.response.payload.commitFeatureEnabled, false)
    assert.equal(await route.repositories.userDataRuntime.getActiveDataset({ tenantId: 'tenant-r174', userId: 'user-r174' }), null)
  } finally {
    route.restore()
  }
})

test('R174 enabled commit persists a scoped preview snapshot and records audit event', async () => {
  const db = createEmptyDataset({ mode: 'user' })
  const route = createRoute({ body: commitBody(), db })
  try {
    const before = JSON.stringify({ ...db, auditLog: [] })
    assert.equal(await handleUserDataRoute(route.ctx), true)
    assert.equal(route.response.status, 201)
    assert.equal(route.response.payload.ok, true)
    assert.equal(route.response.payload.writesFiles, false)
    assert.equal(route.response.payload.writesDb, true)
    assert.equal(route.response.payload.overwritesDemoData, false)
    assert.equal(route.response.payload.recordCounts.purchaseOrders, 1)
    assert.equal(JSON.stringify({ ...db, auditLog: [] }), before)

    const active = await route.repositories.userDataRuntime.getActiveDataset({ tenantId: 'tenant-r174', userId: 'user-r174' })
    assert.equal(active.datasetId, route.response.payload.datasetId)
    assert.equal(active.records.purchaseOrders[0].po, 'PO-R174-1')
    assert.equal(db.auditLog[0].action, 'user_import_committed')
    assert.equal(db.auditLog[0].metadata.scope.tenantId, 'tenant-r174')
    assert.equal(db.auditLog[0].metadata.recordCounts.purchaseOrders, 1)
  } finally {
    route.restore()
  }
})

test('R174 commit rejects missing confirmation and mismatched snapshot hash', async () => {
  for (const body of [
    commitBody({ confirmCommit: false }),
    commitBody({ normalizedSnapshotHash: 'bad-hash' }),
  ]) {
    const route = createRoute({ body })
    try {
      assert.equal(await handleUserDataRoute(route.ctx), true)
      assert.equal(route.response.status, 422)
      assert.equal(route.response.payload.commitAccepted, false)
      assert.equal(route.response.payload.writesDb, false)
      assert.equal(await route.repositories.userDataRuntime.getActiveDataset({ tenantId: 'tenant-r174', userId: 'user-r174' }), null)
      assert.match(route.response.payload.errors.map((item) => item.code).join(','), /missing_confirmation|snapshot_hash_mismatch/)
    } finally {
      route.restore()
    }
  }
})

test('R175 commit validation rejects critical failures without partial persistence', async () => {
  const body = commitBody()
  body.normalizedSnapshot.normalizedRecords.products.push({ name: 'Missing SKU' })
  body.normalizedSnapshot.normalizedRecords.purchaseOrders.push({ po: 'PO-R174-1', supplier: '', lines: [{ quantity: 'bad' }] })
  body.normalizedSnapshot.normalizedSnapshotHash = body.normalizedSnapshotHash
  const route = createRoute({ body })
  try {
    assert.equal(await handleUserDataRoute(route.ctx), true)
    assert.equal(route.response.status, 422)
    const codes = route.response.payload.errors.map((item) => item.code)
    assert.ok(codes.includes('missing_required_item_id'))
    assert.ok(codes.includes('duplicate_record_id'))
    assert.ok(codes.includes('missing_supplier_reference'))
    assert.ok(codes.includes('invalid_po_line_item_reference'))
    assert.ok(codes.includes('invalid_quantity'))
    assert.equal(await route.repositories.userDataRuntime.getActiveDataset({ tenantId: 'tenant-r174', userId: 'user-r174' }), null)
    assert.equal(route.ctx.db.auditLog[0].action, 'user_import_commit_rejected')
  } finally {
    route.restore()
  }
})

test('R176 preview exposes audit preview without writing audit log', async () => {
  const db = createEmptyDataset({ mode: 'user' })
  const route = createRoute({
    body: payload(),
    db,
  })
  route.ctx.url = new URL('/api/user-data/import/preview', 'http://localhost')
  try {
    assert.equal(await handleUserDataRoute(route.ctx), true)
    assert.equal(route.response.status, 200)
    assert.equal(route.response.payload.auditPreview.action, 'user_import_previewed')
    assert.equal(route.response.payload.auditPreview.metadata.recordCounts.purchaseOrders, 1)
    assert.deepEqual(db.auditLog, [])
  } finally {
    route.restore()
  }
})

test('R250 preview stores full snapshot and compact commit succeeds with preview id and hash', async () => {
  const db = createEmptyDataset({ mode: 'user' })
  const repositories = {
    userDataRuntime: createInMemoryUserDataRuntimeRepository(),
    auditLog: createAuditLogRepository(db),
  }
  const preview = createRoute({ body: payload(), db, repositories })
  preview.ctx.url = new URL('/api/user-data/import/preview', 'http://localhost')
  try {
    assert.equal(await handleUserDataRoute(preview.ctx), true)
    assert.equal(preview.response.status, 200)
    assert.equal(preview.response.payload.normalizedSnapshot.normalizedRecords, undefined)
    assert.equal(preview.response.payload.normalizedRecords.purchaseOrders[0].po, 'PO-R174-1')

    const compactSnapshot = preview.response.payload.normalizedSnapshot
    const commit = createRoute({
      body: {
        previewId: compactSnapshot.previewId,
        scope: compactSnapshot.scope,
        normalizedSnapshotHash: compactSnapshot.normalizedSnapshotHash,
        confirmCommit: true,
      },
      db,
      repositories,
    })
    assert.equal(await handleUserDataRoute(commit.ctx), true)
    assert.equal(commit.response.status, 201)
    assert.equal(commit.response.payload.commitAccepted, true)
    assert.equal(commit.response.payload.recordCounts.purchaseOrders, 1)
    const active = await repositories.userDataRuntime.getActiveDataset(compactSnapshot.scope)
    assert.equal(active.records.purchaseOrders[0].po, 'PO-R174-1')
  } finally {
    preview.restore()
  }
})

// Design audit L4-32: the workspace and user come from the session. A payload
// naming tenant-r174 is previewed under the signed-in user's own scope, and a
// snapshot made for tenant-r174 cannot be committed from another workspace.
test('L4-32 preview and commit use the session scope, never the payload scope', async () => {
  const db = createEmptyDataset({ mode: 'user' })
  const repositories = {
    userDataRuntime: createInMemoryUserDataRuntimeRepository(),
    auditLog: createAuditLogRepository(db),
  }
  const intruder = { authenticated: true, tenantId: 'tenant-other', userId: 'user-other' }
  const preview = createRoute({ body: { ...payload(), scope: { tenantId: 'tenant-r174', userId: 'user-r174' } }, db, repositories, identity: intruder })
  preview.ctx.url = new URL('/api/user-data/import/preview', 'http://localhost')
  try {
    assert.equal(await handleUserDataRoute(preview.ctx), true)
    assert.equal(preview.response.status, 200)
    assert.deepEqual(preview.response.payload.normalizedSnapshot.scope, { tenantId: 'tenant-other', userId: 'user-other' })

    const foreign = createRoute({ body: commitBody(), db, repositories, identity: intruder })
    assert.equal(await handleUserDataRoute(foreign.ctx), true)
    assert.equal(foreign.response.status, 403)
    assert.equal(foreign.response.payload.errors[0].code, 'scope_mismatch')
    assert.equal(foreign.response.payload.commitAccepted, false)
    assert.equal(await repositories.userDataRuntime.getActiveDataset({ tenantId: 'tenant-r174', userId: 'user-r174' }), null)
    assert.equal(await repositories.userDataRuntime.getActiveDataset({ tenantId: 'tenant-other', userId: 'user-other' }), null)
  } finally {
    preview.restore()
  }
})
