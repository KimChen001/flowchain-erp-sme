import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildGlobalBusinessSearchIndex,
  normalizeSearchQuery,
  rankSearchResult,
  searchGlobalBusinessRecords,
} from './global-business-search.mjs'
import { handleSearchRoute } from '../routes/search.routes.mjs'
import { reportReadAccessFor } from './report-read-access.mjs'
import { permissionCodes } from '../auth/permission-catalog.mjs'

// A reader who may see everything.
const fullReportAccess = reportReadAccessFor({ authenticated: true, complete: true, tenantId: 'tenant-any', permissionCodes: new Set(permissionCodes) })

function createDb() {
  return {
    purchaseRequests: [
      {
        pr: 'PR-1001',
        supplier: 'ABC Components',
        sourceSku: 'A100',
        sourceName: 'Motor A100',
        amount: 128000,
        requester: 'Zhang Lei',
        buyer: 'Li Ming',
        priority: '高',
        status: '待审批',
      },
    ],
    rfqs: [
      {
        id: 'RFQ-26-0042',
        title: 'Motor A100 sourcing',
        category: 'Components',
        suppliers: 3,
        quoted: 2,
        bestSupplier: 'ABC Components',
        bestPrice: 88,
        due: '2026-06-20',
        status: '进行中',
        sourceRequest: 'PR-1001',
        sourceSku: 'A100',
      },
    ],
    purchaseOrders: [
      {
        po: 'PO-2026-001',
        supplier: 'ABC Components',
        amount: 128000,
        eta: '2026-06-20',
        status: '待审批',
        priority: '高',
        sourceRequest: 'PR-1001',
        sourceSku: 'A100',
        sourceName: 'Motor A100',
        lines: [{ sku: 'A100', itemName: 'Motor A100', warehouseId: 'WH-EXPLICIT' }],
      },
      {
        po: 'PO-2026-002',
        supplier: 'Explicit Tools',
        amount: 42000,
        eta: '2026-06-25',
        status: '已发出',
      },
    ],
    receivingDocs: [
      {
        grn: 'GRN-202606-001',
        po: 'PO-2026-001',
        supplier: 'ABC Components',
        warehouse: 'WH-EXPLICIT',
        status: '质检中',
      },
    ],
    supplierInvoices: [
      {
        invoiceNumber: 'INV-2026-001',
        supplier: 'ABC Components',
        relatedPo: 'PO-2026-001',
        relatedGrn: 'GRN-202606-001',
        amount: 128000,
        status: '存在差异',
        matchStatus: '差异待处理',
        varianceType: '价格差异',
      },
    ],
    products: [
      {
        sku: 'A100',
        name: 'Motor A100',
        category: 'Components',
        supplier: 'ABC Components',
        defaultWarehouseId: 'WH-EXPLICIT',
        currentStock: 12,
        safetyStock: 50,
        unit: 'pcs',
        stockoutRisk: '低库存',
      },
    ],
    suppliers: [
      {
        id: 'SUP-001',
        name: 'ABC Components',
        category: 'Components',
        risk: '中',
        onTimeRate: 91,
        qualityRate: 96,
      },
    ],
    warehouses: [
      { id: 'WH-EXPLICIT', name: 'Explicit Warehouse', type: 'warehouse', status: 'active' },
      { id: 'BIN-A1', name: 'Aisle A1 Bin', type: 'bin', parentId: 'WH-EXPLICIT', status: 'active' },
    ],
  }
}

test('empty query returns empty results', () => {
  assert.deepEqual(searchGlobalBusinessRecords('', createDb()), [])
  assert.equal(normalizeSearchQuery('  PO-2026   001  '), 'po-2026 001')
})

test('exact PO id ranks highly', () => {
  const [first] = searchGlobalBusinessRecords('PO-2026-001', createDb())
  assert.equal(first.type, 'purchase_order')
  assert.equal(first.entityId, 'PO-2026-001')
  assert.ok(first.score >= 100)
  assert.ok(first.matchedFields.includes('po') || first.matchedFields.includes('label'))
})

test('partial PO id matches', () => {
  const results = searchGlobalBusinessRecords('PO-2026', createDb())
  assert.ok(results.some((item) => item.entityId === 'PO-2026-001'))
})

test('exact PR id matches', () => {
  const [first] = searchGlobalBusinessRecords('PR-1001', createDb())
  assert.equal(first.type, 'purchase_request')
  assert.equal(first.entityId, 'PR-1001')
})

test('exact RFQ id matches', () => {
  const [first] = searchGlobalBusinessRecords('RFQ-26-0042', createDb())
  assert.equal(first.type, 'rfq')
  assert.equal(first.entityId, 'RFQ-26-0042')
})

test('exact core document ids stay first', () => {
  assert.equal(searchGlobalBusinessRecords('PO-2026-001', createDb())[0].type, 'purchase_order')
  assert.equal(searchGlobalBusinessRecords('PR-1001', createDb())[0].type, 'purchase_request')
  assert.equal(searchGlobalBusinessRecords('RFQ-26-0042', createDb())[0].type, 'rfq')
})

test('supplier name matches supplier and related records', () => {
  const results = searchGlobalBusinessRecords('ABC Components', createDb())
  const types = new Set(results.map((item) => item.type))
  assert.ok(types.has('supplier'))
  assert.ok(types.has('purchase_order'))
  assert.ok(types.has('supplier_invoice'))
})

test('SKU and item name match item and operational records', () => {
  const skuResults = searchGlobalBusinessRecords('A100', createDb())
  assert.ok(skuResults.some((item) => item.type === 'item'))
  assert.ok(skuResults.some((item) => item.type === 'inventory_item'))
  assert.ok(skuResults.some((item) => item.type === 'purchase_request'))
  const nameResults = searchGlobalBusinessRecords('Motor A100', createDb())
  assert.ok(nameResults.some((item) => item.entityLabel === 'Motor A100' || item.subtitle.includes('Motor A100')))
})

test('low-stock inventory query returns inventory records', () => {
  const results = searchGlobalBusinessRecords('低库存', createDb())
  const inventory = results.find((item) => item.type === 'inventory_item')
  assert.ok(inventory)
  assert.equal(inventory.entityId, 'A100')
  assert.match(inventory.subtitle, /安全库存 50pcs/)
})

test('amount subtitles use full currency formatting', () => {
  const [po] = searchGlobalBusinessRecords('PO-2026-001', createDb())
  assert.equal(po.type, 'purchase_order')
  assert.match(po.subtitle, /¥128,000/)
  assert.doesNotMatch(po.subtitle, /万/)
})

test('invoice number matches supplier invoice', () => {
  const [first] = searchGlobalBusinessRecords('INV-2026-001', createDb())
  assert.equal(first.type, 'supplier_invoice')
})

test('status keyword returns relevant records', () => {
  const results = searchGlobalBusinessRecords('待审批', createDb())
  assert.ok(results.length >= 2)
  assert.ok(results.every((item) => item.status.includes('待审批') || item.matchedFields.includes('combined')))
})

test('result cap works', () => {
  assert.equal(searchGlobalBusinessRecords('ABC', createDb(), { limit: 2 }).length, 2)
})

test('search does not mutate source arrays', () => {
  const db = createDb()
  const before = JSON.stringify(db)
  searchGlobalBusinessRecords('ABC Components', db)
  assert.equal(JSON.stringify(db), before)
})

test('unknown query returns empty results', () => {
  assert.deepEqual(searchGlobalBusinessRecords('NO-SUCH-RECORD', createDb()), [])
})

test('rankSearchResult returns matched field metadata', () => {
  const result = buildGlobalBusinessSearchIndex(createDb()).find((item) => item.type === 'purchase_order')
  const ranked = rankSearchResult(result, 'PO-2026-001')
  assert.ok(ranked.score > 0)
  assert.ok(ranked.matchedFields.length > 0)
})

test('GET /api/search returns capped payload', async () => {
  let response = null
  const ctx = {
    req: { method: 'GET', headers: {} },
    res: {},
    url: new URL('/api/search?q=ABC&limit=3', 'http://localhost'),
    db: createDb(),
    reportReadAccess: fullReportAccess,
    send(_res, status, payload) {
      response = { status, payload }
    },
  }
  assert.equal(await handleSearchRoute(ctx), true)
  assert.equal(response.status, 200)
  assert.equal(response.payload.query, 'ABC')
  assert.equal(response.payload.total, 3)
  assert.equal(response.payload.results.length, 3)
})

test('GET /api/search empty query returns empty payload', async () => {
  let response = null
  const ctx = {
    req: { method: 'GET', headers: {} },
    res: {},
    url: new URL('/api/search?q=', 'http://localhost'),
    db: createDb(),
    reportReadAccess: fullReportAccess,
    send(_res, status, payload) {
      response = { status, payload }
    },
  }
  assert.equal(await handleSearchRoute(ctx), true)
  assert.deepEqual(response.payload.results, [])
  assert.equal(response.payload.total, 0)
})
