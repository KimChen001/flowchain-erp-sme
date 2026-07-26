import test from 'node:test'
import assert from 'node:assert/strict'
import {
  createDatabaseRepositoryRegistry,
  createRepositoryRegistry,
  JSON_PERSISTENCE_REMOVED_ERROR,
} from '../repositories/adapter-registry.mjs'
import { handleActionDraftsRoute } from '../routes/action-drafts.routes.mjs'
import { handleAuditLogRoute } from '../routes/audit-log.routes.mjs'
import { handleInventoryRoute } from '../routes/inventory.routes.mjs'
import { handleMasterDataRoute } from '../routes/master-data.routes.mjs'
import { handleProcurementReadRoute } from '../routes/procurement-read.routes.mjs'
import { databaseModeMutationBlockedPayload, isDatabaseModeWriteBlocked } from './route-classification.mjs'

const env = {
  FLOWCHAIN_PERSISTENCE_MODE: 'database',
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/flowchain',
}

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function createDb() {
  return {
    products: [{ sku: 'A100', name: 'Motor A100', currentStock: 12, safetyStock: 50, reorderPoint: 80, supplier: 'ABC Components', unit: 'pcs' }],
    suppliers: [{ id: 'SUP-1', name: 'ABC Components', category: 'Components', score: 92 }],
    purchaseRequests: [{ pr: 'PR-SMOKE-1', sourceSku: 'A100', sourceName: 'Motor A100', supplier: 'ABC Components', quantity: 10, amount: 1200, currency: 'CNY', status: 'approved', linkedPo: 'PO-SMOKE-1' }],
    rfqs: [],
    purchaseOrders: [{ po: 'PO-SMOKE-1', supplier: 'ABC Components', amount: 1200, currency: 'CNY', items: 10, received: 4, status: 'issued', sourceRequest: 'PR-SMOKE-1', sourceSku: 'A100' }],
    receivingDocs: [{ grn: 'GRN-SMOKE-1', po: 'PO-SMOKE-1', supplier: 'ABC Components', status: 'inspecting', items: 4, passed: 4, failed: 0 }],
    supplierInvoices: [{ invoiceNumber: 'INV-SMOKE-1', supplier: 'ABC Components', relatedPo: 'PO-SMOKE-1', relatedGrn: 'GRN-SMOKE-1', amount: 1200, currency: 'CNY', status: 'pending', varianceAmount: 0 }],
    inventoryMovements: [{ movementId: 'IM-SMOKE-1', movementType: 'StockAdjustment', sku: 'A100', itemName: 'Motor A100', sourceDocument: 'ADJ-SMOKE-1', adjustmentQty: -1, status: '待复核' }],
    auditLog: [],
  }
}

function model(records = []) {
  return { findMany: async () => records }
}

function createPrisma() {
  return {
    item: model([{ id: 'ITEM-A100', sku: 'A100', name: 'Motor A100', category: 'Components', unit: 'pcs', preferredSupplierId: 'SUP-1', status: 'active', safetyStock: 50, reorderPoint: 80, metadata: { supplier: 'ABC Components', defaultWarehouseId: 'WH-MAIN', availableQuantity: 12, onHandQuantity: 18, reservedQuantity: 6 } }]),
    supplier: model([{ id: 'SUP-1', code: 'ABC', name: 'ABC Components', category: 'Components', status: 'active', riskLevel: 'low', score: 92, metadata: { defaultCurrency: 'CNY', paymentTermsId: 'NET30' } }]),
    warehouse: model([{ id: 'WH-MAIN', code: 'MAIN', name: 'Main Warehouse', status: 'active', metadata: {} }]),
    paymentTerm: model([{ id: 'TERM-NET30', code: 'NET30', name: 'Net 30', days: 30, metadata: {} }]),
    taxCode: model([{ id: 'TAX-STD-ID', code: 'TAX-STD', name: 'Standard Tax', rate: 0.13, metadata: {} }]),
    inventoryBalance: model([{ id: 'BAL-A100', itemId: 'ITEM-A100', sku: 'A100', itemName: 'Motor A100', warehouseId: 'WH-MAIN', availableQuantity: 12, onHandQuantity: 18, reservedQuantity: 6, safetyStock: 50, reorderPoint: 80, unit: 'pcs', riskLevel: '高', metadata: { category: 'Components', supplier: 'ABC Components' } }]),
    inventoryLot: model([{ id: 'LOT-A100', sku: 'A100', itemName: 'Motor A100', warehouseId: 'WH-MAIN', quantity: 12, qaStatus: '可用', supplierName: 'ABC Components', status: '可用' }]),
    inventorySerial: model([{ id: 'SN-A100', sku: 'A100', itemName: 'Motor A100', warehouseId: 'WH-MAIN', status: '在库' }]),
    inventoryMovement: model([{ id: 'IM-SMOKE-1', movementType: 'StockAdjustment', sku: 'A100', itemName: 'Motor A100', sourceDocument: 'ADJ-SMOKE-1', adjustmentQty: -1, status: '待复核' }]),
    inventoryException: model([{ id: 'IEX-SMOKE-1', type: '库存调整', sku: 'A100', itemName: 'Motor A100', quantityImpact: -1, status: '待复核', linkedMovementId: 'IM-SMOKE-1', linkedDocument: 'ADJ-SMOKE-1' }]),
    purchaseRequest: model([{ id: 'PR-SMOKE-1', status: 'approved', supplierName: 'ABC Components', linkedPoId: 'PO-SMOKE-1', amount: 1200, currency: 'CNY', lines: [{ sku: 'A100', itemName: 'Motor A100', quantity: 10, unit: 'pcs', amount: 1200 }], metadata: {} }]),
    rfq: model([]),
    supplierQuotation: model([]),
    purchaseOrder: model([{ id: 'PO-SMOKE-1', status: 'issued', supplierName: 'ABC Components', sourceRequestId: 'PR-SMOKE-1', amount: 1200, currency: 'CNY', lines: [{ sku: 'A100', itemName: 'Motor A100', orderedQuantity: 10, receivedQuantity: 4, amount: 1200 }], metadata: {} }]),
    receivingDocument: model([{ id: 'GRN-SMOKE-1', poId: 'PO-SMOKE-1', supplierName: 'ABC Components', status: 'inspecting', lines: [{ sku: 'A100', acceptedQty: 4, rejectedQty: 0 }], metadata: {} }]),
    supplierInvoice: model([{ id: 'INV-SMOKE-1', supplierName: 'ABC Components', relatedPoId: 'PO-SMOKE-1', relatedGrnId: 'GRN-SMOKE-1', amount: 1200, currency: 'CNY', status: 'pending', varianceAmount: 0, lines: [{ sku: 'A100', amount: 1200 }] }]),
    documentLink: model([]),
    procurementFollowup: model([]),
    actionDraft: {
      create: async ({ data }) => ({ ...data, createdAt: new Date('2026-06-30T00:00:00.000Z'), updatedAt: new Date('2026-06-30T00:00:00.000Z'), validations: [], auditTrail: [] }),
    },
    auditLog: {
      create: async ({ data }) => ({ ...data, createdAt: data.createdAt || new Date('2026-06-30T00:00:00.000Z') }),
      findMany: async () => [{ id: 'AUD-SMOKE-1', tenantId: 'tenant-flowchain-sme', source: 'system', module: 'smoke', action: 'smoke_checked', entityType: 'system', entityId: 'R39', summary: 'Smoke checked', metadata: {}, createdAt: new Date('2026-06-30T00:00:00.000Z') }],
    },
  }
}

async function call(handler, { method = 'GET', path, db, repositories, body, identity } = {}) {
  let response = null
  const handled = await handler({
    req: { method, body, headers: {} },
    res: {},
    url: new URL(path, 'http://localhost'),
    db,
    repositories,
    identity,
    send(_res, status, payload) {
      response = { status, payload }
    },
    readBody: async (req) => req.body,
  })
  return { handled, response }
}

test('PostgreSQL-only registry fails closed without DATABASE_URL or with JSON mode', async () => {
  const db = createDb()
  const before = clone(db)
  const repositories = createRepositoryRegistry({ db, env: {} })
  assert.equal(repositories.mode, 'database')
  await assert.rejects(
    () => call(handleMasterDataRoute, { path: '/api/master-data/items', db, repositories }),
    (error) => error?.code === 'FLOWCHAIN_DATABASE_URL_REQUIRED',
  )
  assert.throws(
    () => createRepositoryRegistry({ db, env: { FLOWCHAIN_PERSISTENCE_MODE: 'json' } }),
    (error) => error?.code === JSON_PERSISTENCE_REMOVED_ERROR,
  )
  assert.deepEqual(db, before)
})

test('DB mode smoke routes use DB adapters through repository context', async () => {
  const db = createDb()
  const before = clone(db)
  const repositories = createDatabaseRepositoryRegistry({ db, env, prisma: createPrisma() })
  const identity = {
    complete: true,
    authenticated: true,
    tenantId: 'tenant-flowchain-sme',
    userId: 'user-smoke',
    role: 'admin',
    roleIds: ['role-smoke-admin'],
    permissionCodes: new Set(['audit.read', 'audit.read_sensitive']),
    permissionSourceRoleIds: new Map([
      ['audit.read', ['role-smoke-admin']],
      ['audit.read_sensitive', ['role-smoke-admin']],
    ]),
    readWarehouseIds: new Set(),
    operateWarehouseIds: new Set(),
  }

  const checks = [
    [handleMasterDataRoute, '/api/master-data/items', 'items'],
    [handleMasterDataRoute, '/api/master-data/suppliers', 'suppliers'],
    [handleProcurementReadRoute, '/api/procurement/documents?type=po', 'documents'],
    [handleProcurementReadRoute, '/api/procurement/summary', 'summary'],
    [handleInventoryRoute, '/api/inventory/items', 'items'],
    [handleInventoryRoute, '/api/inventory/summary', 'summary'],
    [handleAuditLogRoute, '/api/audit-log', null],
  ]
  for (const [handler, path, key] of checks) {
    const result = await call(handler, { path, db, repositories, identity })
    assert.equal(result.handled, true, path)
    assert.equal(result.response.status, 200, path)
    if (key) assert.equal(result.response.payload[key] !== undefined, true, path)
  }

  assert.equal(repositories.masterData.adapter, 'db-master-data-v1')
  assert.equal(repositories.procurementRead.adapter, 'db-procurement-read-v1')
  assert.equal(repositories.inventoryRead.adapter, 'db-inventory-read-v1')
  assert.equal(repositories.auditLog.adapter, 'db-audit-log-v1')
  assert.deepEqual(db, before)
})

test('DB mode action draft preview is non-mutating and legacy mutations stay blocked', async () => {
  const db = createDb()
  const before = clone(db)
  const repositories = createDatabaseRepositoryRegistry({ db, env, prisma: createPrisma() })

  const preview = await call(handleActionDraftsRoute, { method: 'POST', path: '/api/action-drafts/preview', db, repositories, body: { type: 'purchase_request_draft', payload: { itemIdOrSku: 'A100', quantity: 2 } } })

  assert.equal(preview.response.status, 200)
  assert.equal(preview.response.payload.previewOnly, true)
  assert.equal(isDatabaseModeWriteBlocked({ persistenceMode: 'database', method: 'GET', pathname: '/api/mrp-plan' }), false)
  assert.equal(isDatabaseModeWriteBlocked({ persistenceMode: 'database', method: 'POST', pathname: '/api/forecast-plans' }), true)
  assert.equal(isDatabaseModeWriteBlocked({ persistenceMode: 'database', method: 'POST', pathname: '/api/sop-cycle' }), true)
  assert.equal(isDatabaseModeWriteBlocked({ persistenceMode: 'database', method: 'POST', pathname: '/api/purchase-requests' }), true)
  assert.deepEqual(databaseModeMutationBlockedPayload(), { error: 'This mutation is not available in database persistence mode yet.' })
  assert.deepEqual(db, before)
})
