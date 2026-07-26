import test from 'node:test'
import assert from 'node:assert/strict'
import { createEmptyDataset } from './data-mode.mjs'
import { normalizeUserDataImportPayload } from './user-data-contract.mjs'
import { createUserDataRuntimeDb } from './user-data-runtime.mjs'
import { handleUserDataRoute } from '../routes/user-data.routes.mjs'

const DEMO_ID_PATTERN = /PO-2026-1282|SKU-00412|RFQ-26-0046|PR-2026-2401|GRN-202605-0418|INV-SZ-260601|SUP-SZXY/

function validPayload() {
  return {
    sourceName: 'phase-ae-import',
    purchaseOrders: [
      {
        poId: 'PO-IMPORT-AE-0001',
        supplierName: 'AE Import Supplier',
        eta: '2026-07-12',
        amount: '9300',
        lines: [{ itemSku: 'SKU-IMPORT-AE-0001', quantity: '6' }],
      },
    ],
    purchaseRequests: [
      { prId: 'PR-IMPORT-AE-0001', itemSku: 'SKU-IMPORT-AE-0001', quantity: '6', requiredDate: '2026-07-08' },
    ],
    products: [
      { itemSku: 'SKU-IMPORT-AE-0001', itemName: 'AE Import Item', currentStock: '1', safetyStock: '5' },
    ],
  }
}

function createRouteContext({ body = validPayload(), db = createEmptyDataset({ mode: 'demo' }), readBody } = {}) {
  let response = null
  return {
    ctx: {
      req: { method: 'POST', body, headers: {} },
      res: {},
      url: new URL('/api/user-data/import/commit', 'http://localhost'),
      db,
      readBody: readBody || (async (req) => req.body),
      send(_res, status, payload) {
        response = { status, payload }
      },
    },
    get response() {
      return response
    },
  }
}

function businessSnapshot(db) {
  return JSON.stringify(db)
}

async function assertCommitDoesNotWrite(route) {
  const dbBefore = businessSnapshot(route.ctx.db)
  assert.equal(await handleUserDataRoute(route.ctx), true)
  assert.equal(businessSnapshot(route.ctx.db), dbBefore)
  assert.equal(route.response.payload.writesFiles, false)
  assert.equal(route.response.payload.writesDb, false)
  assert.equal(route.response.payload.overwritesDemoData, false)
}

test('R167 commit boundary blocks non-authoritative preview mode and never writes runtime data', async () => {
  const route = createRouteContext({ db: createEmptyDataset({ mode: 'demo' }) })
  await assertCommitDoesNotWrite(route)
  assert.equal(route.response.status, 501)
  assert.equal(route.response.payload.ok, false)
  assert.equal(route.response.payload.commitAccepted, false)
  assert.equal(route.response.payload.dryRunRequired, true)
  assert.equal(route.response.payload.storageReady, false)
  assert.equal(route.response.payload.dataMode, 'demo')
  assert.ok(route.response.payload.errors.some((item) => item.code === 'user_import_commit_disabled'))
  assert.doesNotMatch(JSON.stringify(route.response.payload), DEMO_ID_PATTERN)
})

test('R167 commit boundary blocks empty mode and reports no storage readiness', async () => {
  const route = createRouteContext({ db: createEmptyDataset({ mode: 'empty' }) })
  await assertCommitDoesNotWrite(route)
  assert.equal(route.response.status, 501)
  assert.equal(route.response.payload.dataMode, 'empty')
  assert.equal(route.response.payload.storageReady, false)
})

test('R168 user mode commit remains disabled until scoped storage exists', async () => {
  const db = createUserDataRuntimeDb(normalizeUserDataImportPayload(validPayload()))
  const route = createRouteContext({ db })
  await assertCommitDoesNotWrite(route)
  assert.equal(route.response.status, 501)
  assert.equal(route.response.payload.dataMode, 'user')
  assert.equal(route.response.payload.recordCounts.purchaseOrders, 1)
  assert.equal(route.response.payload.importPreview.purchaseOrders[0].id, 'PO-IMPORT-AE-0001')
  assert.ok(route.response.payload.errors.some((item) => item.code === 'user_import_commit_disabled'))
})

test('R168 invalid import cannot cross commit boundary', async () => {
  const route = createRouteContext({
    db: createUserDataRuntimeDb(normalizeUserDataImportPayload(validPayload())),
    body: { purchaseRequests: [{ prId: 'PR-IMPORT-AE-BAD', quantity: 'not-a-number' }] },
  })
  await assertCommitDoesNotWrite(route)
  assert.equal(route.response.status, 422)
  assert.equal(route.response.payload.ok, false)
  assert.ok(route.response.payload.errors.some((item) => item.code === 'invalid_quantity'))
  assert.equal(route.response.payload.commitAccepted, false)
})

test('R168 invalid JSON at commit boundary is safe and non-mutating', async () => {
  const route = createRouteContext({
    db: createEmptyDataset({ mode: 'user' }),
    readBody: async () => {
      throw new SyntaxError('secret stack detail')
    },
  })
  await assertCommitDoesNotWrite(route)
  assert.equal(route.response.status, 400)
  assert.equal(route.response.payload.ok, false)
  assert.equal(route.response.payload.errors[0].code, 'invalid_json')
  assert.doesNotMatch(JSON.stringify(route.response.payload), /secret|stack/i)
})
