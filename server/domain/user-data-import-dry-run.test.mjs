import test from 'node:test'
import assert from 'node:assert/strict'
import { createEmptyDataset } from './data-mode.mjs'
import {
  normalizeUserDataImportPayload,
  USER_DATA_ARRAY_KEYS,
} from './user-data-contract.mjs'
import { handleUserDataRoute } from '../routes/user-data.routes.mjs'

const DEMO_ID_PATTERN = /PO-2026-1282|SKU-00412|RFQ-26-0046|PR-2026-2401|GRN-202605-0418|INV-SZ-260601|SUP-SZXY/

function validUserPayload() {
  return {
    sourceName: 'phase-ac-user-import',
    purchaseOrders: [
      {
        poId: 'PO-IMPORT-AC-0001',
        supplierName: 'AC 用户供应商',
        eta: '2026-07-08',
        amount: '12000',
        received: '4',
        lines: [{ itemSku: 'SKU-IMPORT-AC-0001', quantity: '10' }],
      },
    ],
    purchaseRequests: [
      { prId: 'PR-IMPORT-AC-0001', itemSku: 'SKU-IMPORT-AC-0001', supplierName: 'AC 用户供应商', quantity: '10', requiredDate: '2026-07-04' },
    ],
    rfqs: [
      { rfqId: 'RFQ-IMPORT-AC-0001', prId: 'PR-IMPORT-AC-0001', suppliers: '3', quoted: '1', due: '2026-07-05' },
    ],
    products: [
      { itemSku: 'SKU-IMPORT-AC-0001', itemName: 'AC 用户物料', currentStock: '2', safetyStock: '8', reorderPoint: '12' },
    ],
    suppliers: [
      { supplierId: 'SUP-IMPORT-AC-0001', supplierName: 'AC 用户供应商', risk: '高' },
    ],
    receivingDocs: [
      { grnId: 'GRN-IMPORT-AC-0001', poId: 'PO-IMPORT-AC-0001', supplierName: 'AC 用户供应商', items: '4', status: '异常处理' },
    ],
    supplierInvoices: [
      { invoiceNumber: 'INV-IMPORT-AC-0001', poId: 'PO-IMPORT-AC-0001', grnId: 'GRN-IMPORT-AC-0001', amount: '12000' },
    ],
    inventoryMovements: [
      { movementId: 'MV-IMPORT-AC-0001', itemSku: 'SKU-IMPORT-AC-0001', grnId: 'GRN-IMPORT-AC-0001', quantity: '4' },
    ],
    inventoryExceptions: [
      { id: 'IEX-IMPORT-AC-0001', itemSku: 'SKU-IMPORT-AC-0001', quantityImpact: '-2', status: '待复核' },
    ],
  }
}

function createRouteContext(body, db = createEmptyDataset({ mode: 'user' }), readBodyOverride) {
  let response = null
  return {
    ctx: {
      req: { method: 'POST', body, headers: {} },
      res: {},
      url: new URL('/api/user-data/import/dry-run', 'http://localhost'),
      db,
      readBody: readBodyOverride || (async (req) => req.body),
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

test('R161 user data contract declares canonical optional import arrays', () => {
  assert.deepEqual(USER_DATA_ARRAY_KEYS, [
    'purchaseOrders',
    'purchaseRequests',
    'rfqs',
    'products',
    'suppliers',
    'receivingDocs',
    'supplierInvoices',
    'inventoryMovements',
    'inventoryExceptions',
  ])
  const result = normalizeUserDataImportPayload({})
  assert.equal(result.ok, true)
  assert.equal(result.recordCounts.purchaseOrders, 0)
  assert.ok(result.warnings.some((item) => item.code === 'empty_payload'))
  assert.deepEqual(result.normalizedData.products, [])
})

test('R162 normalizes aliases and numeric fields without mutating source payload', () => {
  const payload = validUserPayload()
  const before = JSON.stringify(payload)
  const result = normalizeUserDataImportPayload(payload, { importedAt: '2026-07-02T00:00:00.000Z' })
  assert.equal(result.ok, true)
  assert.equal(JSON.stringify(payload), before)
  assert.equal(result.metadata.sourceName, 'phase-ac-user-import')
  assert.equal(result.metadata.dryRun, true)
  assert.equal(result.recordCounts.purchaseOrders, 1)
  assert.equal(result.normalizedSnapshot.scope.tenantId, 'tenant-flowchain-sme')
  assert.equal(result.normalizedSnapshot.validationSummary.ok, true)
  assert.match(result.normalizedSnapshot.normalizedSnapshotHash, /^[a-f0-9]{64}$/)
  assert.equal(result.normalizedData.purchaseOrders[0].po, 'PO-IMPORT-AC-0001')
  assert.equal(result.normalizedData.purchaseOrders[0].supplier, 'AC 用户供应商')
  assert.equal(result.normalizedData.purchaseOrders[0].amount, 12000)
  assert.equal(result.normalizedData.purchaseOrders[0].lines[0].sku, 'SKU-IMPORT-AC-0001')
  assert.equal(result.normalizedData.purchaseOrders[0].lines[0].quantity, 10)
  assert.equal(result.normalizedData.products[0].sku, 'SKU-IMPORT-AC-0001')
  assert.equal(result.normalizedData.receivingDocs[0].grn, 'GRN-IMPORT-AC-0001')
  assert.doesNotMatch(JSON.stringify(result), DEMO_ID_PATTERN)
})

test('R162 validation reports invalid references quantities and dates', () => {
  const result = normalizeUserDataImportPayload({
    purchaseRequests: [{ prId: 'PR-BAD-1', quantity: 'not-a-number', requiredDate: 'July 9' }],
    rfqs: [{ rfqId: 'RFQ-BAD-1', prId: 'PR-MISSING' }],
    receivingDocs: [{ grnId: 'GRN-BAD-1', poId: 'PO-MISSING' }],
    supplierInvoices: [{ invoiceNumber: 'INV-BAD-1', poId: 'PO-MISSING', grnId: 'GRN-MISSING' }],
    products: [{ name: 'Missing SKU product' }],
  })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((item) => item.code === 'invalid_quantity'))
  assert.ok(result.errors.some((item) => item.code === 'invalid_date'))
  assert.ok(result.warnings.some((item) => item.code === 'unknown_po_reference'))
  assert.ok(result.warnings.some((item) => item.code === 'unknown_pr_reference'))
  assert.ok(result.warnings.some((item) => item.code === 'unknown_grn_reference'))
  assert.ok(result.warnings.some((item) => item.code === 'missing_sku'))
})

test('R163 dry-run route returns normalized preview without mutating runtime data', async () => {
  const db = createEmptyDataset({ mode: 'user' })
  const dbBefore = businessSnapshot(db)
  const route = createRouteContext(validUserPayload(), db)
  assert.equal(await handleUserDataRoute(route.ctx), true)

  assert.equal(route.response.status, 200)
  assert.equal(route.response.payload.ok, true)
  assert.equal(route.response.payload.dryRun, true)
  assert.equal(route.response.payload.writesFiles, false)
  assert.equal(route.response.payload.writesDb, false)
  assert.equal(route.response.payload.overwritesDemoData, false)
  assert.equal(route.response.payload.recordCounts.purchaseOrders, 1)
  assert.equal(route.response.payload.normalizedSnapshot.validationSummary.ok, true)
  assert.equal(route.response.payload.normalizedSnapshot.recordCounts.purchaseOrders, 1)
  assert.match(route.response.payload.normalizedSnapshot.normalizedSnapshotHash, /^[a-f0-9]{64}$/)
  assert.equal(route.response.payload.importPreview.purchaseOrders[0].id, 'PO-IMPORT-AC-0001')
  assert.equal(route.response.payload.normalizedData, undefined)
  assert.equal(businessSnapshot(db), dbBefore)
  assert.doesNotMatch(JSON.stringify(route.response.payload), DEMO_ID_PATTERN)
})

test('R163 dry-run route returns safe 400 for invalid JSON body', async () => {
  const route = createRouteContext({}, createEmptyDataset({ mode: 'user' }), async () => {
    throw new SyntaxError('bad json with secret')
  })
  assert.equal(await handleUserDataRoute(route.ctx), true)
  assert.equal(route.response.status, 400)
  assert.equal(route.response.payload.ok, false)
  assert.equal(route.response.payload.errors[0].code, 'invalid_json')
  assert.doesNotMatch(JSON.stringify(route.response.payload), /secret|stack/i)
})

test('R163 dry-run route returns validation status without writing on invalid import', async () => {
  const db = createEmptyDataset({ mode: 'demo' })
  const before = businessSnapshot(db)
  const route = createRouteContext({ purchaseRequests: [{ prId: 'PR-BAD-2', quantity: 'NaN' }] }, db)
  assert.equal(await handleUserDataRoute(route.ctx), true)
  assert.equal(route.response.status, 422)
  assert.equal(route.response.payload.ok, false)
  assert.ok(route.response.payload.errors.some((item) => item.code === 'invalid_quantity'))
  assert.equal(route.response.payload.writesFiles, false)
  assert.equal(route.response.payload.writesDb, false)
  assert.equal(businessSnapshot(db), before)
})
