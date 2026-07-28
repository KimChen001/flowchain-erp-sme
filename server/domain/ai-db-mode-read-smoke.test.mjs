import test from 'node:test'
import assert from 'node:assert/strict'
import { createDatabaseRepositoryRegistry } from '../repositories/adapter-registry.mjs'
import { handleAiRoute } from '../routes/ai.routes.mjs'
import { buildAiReadContext } from './ai-read-context.mjs'

const env = {
  FLOWCHAIN_PERSISTENCE_MODE: 'database',
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/flowchain',
}

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function staleJsonDb() {
  return {
    products: [{ sku: 'JSON-100', name: 'Stale JSON Item', currentStock: 99, safetyStock: 1, unit: 'pcs' }],
    suppliers: [{ id: 'SUP-JSON', name: 'Stale JSON Supplier' }],
    purchaseRequests: [{ pr: 'PR-JSON-STALE', status: '待审批', sourceSku: 'JSON-100', supplier: 'Stale JSON Supplier' }],
    rfqs: [],
    purchaseOrders: [{ po: 'PO-JSON-STALE', status: '待审批', supplier: 'Stale JSON Supplier', sourceSku: 'JSON-100' }],
    receivingDocs: [],
    supplierInvoices: [],
    inventoryMovements: [],
    forecastPlans: [],
    marketPrices: [],
    marketSignals: [],
    events: [],
    auditLog: [],
  }
}

function model(records = []) {
  return { findMany: async () => records }
}

function createPrisma({ auditWrites = [] } = {}) {
  return {
    item: model([{ id: 'ITEM-DB-A100', sku: 'DB-A100', name: 'DB Motor A100', category: 'Components', unit: 'pcs', preferredSupplierId: 'SUP-DB', status: 'active', safetyStock: 40, reorderPoint: 60, metadata: { supplier: 'DB Components', defaultWarehouseId: 'WH-DB', availableQuantity: 4, onHandQuantity: 10, reservedQuantity: 6 } }]),
    supplier: model([{ id: 'SUP-DB', code: 'DBSUP', name: 'DB Components', category: 'Components', status: 'active', riskLevel: 'medium', score: 88, metadata: { defaultCurrency: 'CNY', paymentTermsId: 'NET30' } }]),
    warehouse: model([{ id: 'WH-DB', code: 'WHDB', name: 'DB Warehouse', status: 'active', metadata: {} }]),
    paymentTerm: model([{ id: 'TERM-NET30', code: 'NET30', name: 'Net 30', days: 30, metadata: {} }]),
    taxCode: model([{ id: 'TAX-STD-ID', code: 'TAX-STD', name: 'Standard Tax', rate: 0.13, metadata: {} }]),
    inventoryBalance: model([{ id: 'BAL-DB-A100', itemId: 'ITEM-DB-A100', sku: 'DB-A100', itemName: 'DB Motor A100', warehouseId: 'WH-DB', availableQuantity: 4, onHandQuantity: 10, reservedQuantity: 6, safetyStock: 40, reorderPoint: 60, unit: 'pcs', riskLevel: '高', metadata: { category: 'Components', supplier: 'DB Components' } }]),
    inventoryLot: model([]),
    inventorySerial: model([]),
    inventoryMovement: model([{ id: 'IM-DB-1', movementType: 'StockAdjustment', sku: 'DB-A100', itemName: 'DB Motor A100', sourceDocument: 'ADJ-DB-1', adjustmentQty: -6, status: '待复核' }]),
    inventoryException: model([{ id: 'IEX-DB-1', type: '库存调整', sku: 'DB-A100', itemName: 'DB Motor A100', quantityImpact: -6, status: '待复核', linkedMovementId: 'IM-DB-1', linkedDocument: 'ADJ-DB-1' }]),
    purchaseRequest: model([{ id: 'PR-DB-1', status: 'approved', supplierName: 'DB Components', linkedPoId: 'PO-DB-1', amount: 1500, currency: 'CNY', lines: [{ sku: 'DB-A100', itemName: 'DB Motor A100', quantity: 10, unit: 'pcs', amount: 1500 }], metadata: {} }]),
    rfq: model([]),
    supplierQuotation: model([]),
    purchaseOrder: model([{ id: 'PO-DB-1', status: 'issued', supplierName: 'DB Components', sourceRequestId: 'PR-DB-1', amount: 1500, currency: 'CNY', lines: [{ sku: 'DB-A100', itemName: 'DB Motor A100', orderedQuantity: 10, receivedQuantity: 2, amount: 1500 }], metadata: {} }]),
    receivingDocument: model([{ id: 'GRN-DB-1', poId: 'PO-DB-1', supplierName: 'DB Components', status: 'inspecting', lines: [{ sku: 'DB-A100', acceptedQty: 2, rejectedQty: 0 }], metadata: {} }]),
    supplierInvoice: model([{ id: 'INV-DB-1', supplierName: 'DB Components', relatedPoId: 'PO-DB-1', relatedGrnId: 'GRN-DB-1', amount: 1800, currency: 'CNY', status: 'pending', varianceAmount: 300, lines: [{ sku: 'DB-A100', amount: 1800 }] }]),
    salesOrder: model([]),
    documentLink: model([]),
    procurementFollowup: model([{ id: 'FOLLOWUP-DB-1', type: 'invoice_variance', title: 'Review DB invoice variance', documentType: 'invoice', documentId: 'INV-DB-1', supplierName: 'DB Components', severity: 'high', status: 'open', nextAction: 'Review DB variance', evidence: [{ type: 'invoice', id: 'INV-DB-1', label: 'INV-DB-1' }] }]),
    actionDraft: {
      create: async ({ data }) => ({ ...data, createdAt: new Date('2026-06-30T00:00:00.000Z'), updatedAt: new Date('2026-06-30T00:00:00.000Z'), validations: [], auditTrail: [] }),
    },
    auditLog: {
      create: async ({ data }) => {
        auditWrites.push(data)
        return { ...data, createdAt: data.createdAt || new Date('2026-06-30T00:00:00.000Z') }
      },
      findMany: async () => [],
    },
  }
}

function createRoute({ message, db = staleJsonDb(), repositories }) {
  let response = null
  return {
    ctx: {
      req: { method: 'POST', body: { message }, headers: {} },
      res: {},
      url: new URL('/api/ai/chat', 'http://localhost'),
      db,
      repositories,
      send(_res, status, payload) {
        response = { status, payload }
      },
      readBody: async (req) => req.body,
      writeDb: async () => {
        throw new Error('DB mode AI smoke must not write JSON data')
      },
      event: () => {
        throw new Error('DB mode AI smoke must not append JSON audit events')
      },
      ensurePurchaseRequests: (database) => database.purchaseRequests || [],
      ensureInventoryMovements: (database) => database.inventoryMovements || [],
      ensureRfqs: (database) => database.rfqs || [],
      supplierPerformance: () => [],
      supplierRecommendations: () => null,
      supplierQuoteCount: 0,
      openaiDispatcher: { dispatch() { throw new Error('provider should not be reached') } },
      arkDispatcher: { dispatch() { throw new Error('ark should not be reached') } },
      aiMaxTokens: 120,
    },
    get response() {
      return response
    },
  }
}

async function flushBestEffortAudit() {
  await new Promise((resolve) => setImmediate(resolve))
}

test('DB mode AI procurement and supplier evidence reads repository data instead of stale JSON', async () => {
  const auditWrites = []
  const db = staleJsonDb()
  const before = clone(db)
  const repositories = createDatabaseRepositoryRegistry({ db, env, prisma: createPrisma({ auditWrites }) })

  const procurement = createRoute({ message: '哪些采购单据有风险？', db, repositories })
  await handleAiRoute(procurement.ctx)
  const supplier = createRoute({ message: '哪些供应商需要跟进？', db, repositories })
  await handleAiRoute(supplier.ctx)
  await flushBestEffortAudit()

  assert.equal(repositories.procurementRead.adapter, 'db-procurement-read-v1')
  assert.equal(procurement.response.status, 200)
  assert.equal(procurement.response.payload.intent.name, 'procurement_exception_query')
  assert.equal(JSON.stringify(procurement.response.payload).includes('INV-DB-1'), true)
  assert.equal(JSON.stringify(procurement.response.payload).includes('PO-JSON-STALE'), false)
  assert.equal(supplier.response.payload.intent.name, 'supplier_followup_query')
  assert.equal(JSON.stringify(supplier.response.payload).includes('DB Components'), true)
  assert.equal(JSON.stringify(supplier.response.payload).includes('Stale JSON Supplier'), false)
  assert.equal(auditWrites.length >= 1, true)
  assert.deepEqual(db, before)
})

test('DB mode AI inventory evidence reads inventory repository data instead of stale JSON', async () => {
  const db = staleJsonDb()
  const before = clone(db)
  const repositories = createDatabaseRepositoryRegistry({ db, env, prisma: createPrisma() })
  const route = createRoute({ message: 'DB-A100 库存风险为什么？', db, repositories })

  await handleAiRoute(route.ctx)

  assert.equal(repositories.inventoryRead.adapter, 'db-inventory-read-v1')
  assert.equal(route.response.status, 200)
  assert.equal(route.response.payload.intent.name, 'inventory_status_query')
  assert.equal(JSON.stringify(route.response.payload).includes('DB-A100'), true)
  assert.equal(JSON.stringify(route.response.payload).includes('JSON-100'), false)
  assert.deepEqual(db, before)
})

test('DB mode AI read context exposes master data repository while route evidence uses read-model cache', async () => {
  const db = staleJsonDb()
  const repositories = createDatabaseRepositoryRegistry({ db, env, prisma: createPrisma() })
  const context = await buildAiReadContext(db, { repositories })

  assert.equal(repositories.masterData.adapter, 'db-master-data-v1')
  assert.equal(context.repositoryBacked.masterData, true)
  assert.equal(context.masterData.items[0].sku, 'DB-A100')
  assert.equal(context.masterData.suppliers[0].name, 'DB Components')
  assert.equal(JSON.stringify(context.cache.aiEvidenceReuse.inventoryItems).includes('JSON-100'), false)
  assert.equal(JSON.stringify(context.cache.aiEvidenceReuse.procurementDocuments).includes('PO-JSON-STALE'), false)
})

test('DB mode AI draft preparation stays preview-only and does not trust stale JSON master data', async () => {
  const db = staleJsonDb()
  const before = clone(db)
  const repositories = createDatabaseRepositoryRegistry({ db, env, prisma: createPrisma() })
  const route = createRoute({ message: 'PR JSON-100 3 urgent', db, repositories })

  await handleAiRoute(route.ctx)

  assert.equal(route.response.status, 200)
  assert.equal(route.response.payload.intent.name, 'prepare_purchase_request_draft')
  assert.equal(route.response.payload.cards[0].type, 'pr_draft')
  assert.equal(route.response.payload.cards[0].reviewRequired, true)
  assert.equal(route.response.payload.cards[0].data.documentStatus, 'draft')
  assert.equal(repositories.procurementRuntime.adapter, 'durable-procurement-runtime-v2')
  assert.equal(route.response.payload.cards[0].data.itemId, '')
  assert.ok(route.response.payload.cards.find((card) => card.type === 'missing_fields').fields.some((field) => field.name === 'item'))
  assert.equal(JSON.stringify(route.response.payload).includes('ITEM-JSON-100'), false)
  assert.equal(JSON.stringify(route.response.payload).includes('DB-A100'), false)
  assert.deepEqual(db, before)
})
