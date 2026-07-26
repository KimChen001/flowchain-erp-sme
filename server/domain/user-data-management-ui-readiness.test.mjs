import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createEmptyDataset } from './data-mode.mjs'
import { normalizeUserDataImportPayload } from './user-data-contract.mjs'
import { createInMemoryUserDataRuntimeRepository } from '../repositories/user-data-runtime-repository.mjs'
import { createAuditLogRepository } from '../repositories/audit-log-repository.mjs'
import { handleUserDataRoute } from '../routes/user-data.routes.mjs'

const root = process.cwd()

function payload() {
  return {
    sourceName: 'r181-r190-management-flow',
    tenantId: 'tenant-r190',
    userId: 'user-r190',
    purchaseOrders: [{ poId: 'PO-R190-1', supplierName: 'R190 Supplier', lines: [{ itemSku: 'SKU-R190-1', quantity: '5' }] }],
    purchaseRequests: [{ prId: 'PR-R190-1', itemSku: 'SKU-R190-1', quantity: '5', requiredDate: '2026-07-22' }],
    products: [{ itemSku: 'SKU-R190-1', itemName: 'R190 Item', currentStock: '1', safetyStock: '6' }],
    suppliers: [{ supplierId: 'SUP-R190-1', supplierName: 'R190 Supplier' }],
  }
}

function commitBody(overrides = {}) {
  const result = normalizeUserDataImportPayload(payload(), {
    importedAt: '2026-07-02T00:00:00.000Z',
    scope: { tenantId: 'tenant-r190', userId: 'user-r190' },
  })
  return {
    normalizedSnapshot: result.normalizedSnapshot,
    normalizedSnapshotHash: result.normalizedSnapshot.normalizedSnapshotHash,
    confirmCommit: true,
    ...overrides,
  }
}

function createRoute({ method = 'POST', pathname = '/api/user-data/import/commit', body = commitBody(), envEnabled = true, db = createEmptyDataset({ mode: 'user' }), repositories } = {}) {
  let response = null
  const previous = process.env.FLOWCHAIN_ENABLE_USER_IMPORT_COMMIT
  if (envEnabled) process.env.FLOWCHAIN_ENABLE_USER_IMPORT_COMMIT = 'true'
  else delete process.env.FLOWCHAIN_ENABLE_USER_IMPORT_COMMIT
  const repoSet = repositories || {
    userDataRuntime: createInMemoryUserDataRuntimeRepository(),
    auditLog: createAuditLogRepository(db),
  }
  return {
    ctx: {
      req: { method, body, headers: {} },
      res: {},
      url: new URL(pathname, 'http://localhost'),
      db,
      repositories: repoSet,
      readBody: async (req) => req.body,
      send(_res, status, payload) {
        response = { status, payload }
      },
    },
    repositories: repoSet,
    restore() {
      if (previous === undefined) delete process.env.FLOWCHAIN_ENABLE_USER_IMPORT_COMMIT
      else process.env.FLOWCHAIN_ENABLE_USER_IMPORT_COMMIT = previous
    },
    get response() {
      return response
    },
  }
}

test('R181-R190 active dataset route returns scoped metadata only', async () => {
  const route = createRoute()
  try {
    assert.equal(await handleUserDataRoute(route.ctx), true)
    assert.equal(route.response.status, 201)

    route.ctx.req = { method: 'GET', body: null, headers: {} }
    route.ctx.url = new URL('/api/user-data/active-dataset?tenantId=tenant-r190&userId=user-r190', 'http://localhost')
    assert.equal(await handleUserDataRoute(route.ctx), true)
    assert.equal(route.response.status, 200)
    assert.equal(route.response.payload.active, true)
    assert.equal(route.response.payload.dataset.datasetId, route.response.payload.dataset.datasetId)
    assert.equal(route.response.payload.dataset.recordCounts.purchaseOrders, 1)
    assert.equal(route.response.payload.dataset.records, undefined)
    assert.equal(route.response.payload.writesFiles, false)
    assert.equal(route.response.payload.writesDb, false)
    assert.equal(route.response.payload.overwritesDemoData, false)
  } finally {
    route.restore()
  }
})

test('R181-R190 full safe user data loop respects commit gate, scope, deactivate and inactive AI source boundary', async () => {
  const disabled = createRoute({ envEnabled: false })
  try {
    assert.equal(await handleUserDataRoute(disabled.ctx), true)
    assert.equal(disabled.response.status, 501)
    assert.equal(disabled.response.payload.commitAccepted, false)
    assert.equal(disabled.response.payload.commitFeatureEnabled, false)
    assert.equal(await disabled.repositories.userDataRuntime.getActiveDataset({ tenantId: 'tenant-r190', userId: 'user-r190' }), null)
  } finally {
    disabled.restore()
  }

  const enabled = createRoute()
  try {
    assert.equal(await handleUserDataRoute(enabled.ctx), true)
    assert.equal(enabled.response.status, 201)
    const importBatchId = enabled.response.payload.importBatchId
    assert.equal(enabled.response.payload.writesFiles, false)
    assert.equal(enabled.response.payload.writesDb, true)
    assert.equal(enabled.response.payload.overwritesDemoData, false)

    const active = await enabled.repositories.userDataRuntime.getActiveDataset({ tenantId: 'tenant-r190', userId: 'user-r190' })
    assert.equal(active.importBatchId, importBatchId)
    assert.equal((await enabled.repositories.userDataRuntime.getAIReadableContext({ tenantId: 'tenant-r190', userId: 'user-r190' })).datasetId, active.datasetId)

    enabled.ctx.req = { method: 'POST', body: { scope: { tenantId: 'tenant-r190', userId: 'user-r190' }, importBatchId, confirmDeactivate: true }, headers: {} }
    enabled.ctx.url = new URL('/api/user-data/import/deactivate', 'http://localhost')
    assert.equal(await handleUserDataRoute(enabled.ctx), true)
    assert.equal(enabled.response.status, 200)
    assert.equal(enabled.response.payload.deactivated, true)
    assert.equal(enabled.response.payload.writesFiles, false)
    assert.equal(enabled.response.payload.overwritesDemoData, false)
    assert.equal(await enabled.repositories.userDataRuntime.getActiveDataset({ tenantId: 'tenant-r190', userId: 'user-r190' }), null)
    assert.equal(await enabled.repositories.userDataRuntime.getAIReadableContext({ tenantId: 'tenant-r190', userId: 'user-r190' }), null)
  } finally {
    enabled.restore()
  }
})

test('R181-R190 source guardrails keep the retired import UI fail-closed and provider-free', () => {
  const importsPage = fs.readFileSync(path.join(root, 'src/modules/imports/Page.tsx'), 'utf8')
  const routes = fs.readFileSync(path.join(root, 'src/app/routeRegistry.tsx'), 'utf8')
  const userDataRoutes = fs.readFileSync(path.join(root, 'server/routes/user-data.routes.mjs'), 'utf8')

  assert.match(importsPage, /data-testid="legacy-import-retired-page"/)
  assert.match(importsPage, /旧 Import 直接写入已停用/)
  assert.match(importsPage, /Universal Intake 是唯一面向未来的数据接入权威/)
  assert.match(importsPage, /Phase 5\.4B/)
  assert.match(importsPage, /Phase 5\.4C/)
  assert.doesNotMatch(importsPage, /\/api\/user-data\/import\/preview/)
  assert.doesNotMatch(importsPage, /\/api\/user-data\/import\/commit/)
  assert.doesNotMatch(importsPage, /\/api\/user-data\/active-dataset/)
  assert.doesNotMatch(importsPage, /\/api\/user-data\/import\/deactivate/)
  assert.doesNotMatch(routes, /label:\s*["']AI Assistant["']/)
  assert.doesNotMatch(importsPage, /OPENAI_API_KEY|DOUBAO|ARK_API_KEY|fetch\(["']https:\/\/api\.openai/i)
  assert.doesNotMatch(userDataRoutes, /scm-demo\.json|writeFile/)
})
