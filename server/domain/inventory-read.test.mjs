import test from 'node:test'
import { createTestRepositoryRegistry } from './test-fixtures/runtime-repositories.mjs'
import assert from 'node:assert/strict'
import {
  buildInventoryExceptions,
  buildInventoryItems,
  buildInventoryLots,
  buildInventoryMovements,
  buildInventorySerials,
  buildInventorySummary,
  filterInventoryRows,
  getInventoryItemBySku,
} from './inventory-read.mjs'
import { handleInventoryRoute } from '../routes/inventory.routes.mjs'

function createDb() {
  return {
    products: [
      {
        sku: 'A100',
        name: 'Motor A100',
        category: 'Components',
        supplier: 'ABC Components',
        defaultWarehouseId: 'WH-01',
        location: 'A-01',
        currentStock: 12,
        onHandQuantity: 18,
        reservedQuantity: 6,
        safetyStock: 50,
        reorderPoint: 80,
        unit: 'pcs',
        stockoutRisk: '高',
      },
      {
        sku: 'B200',
        name: 'Bracket B200',
        category: 'Metal',
        currentStock: 160,
        safetyStock: 40,
        unit: 'pcs',
        stockoutRisk: '低',
      },
    ],
    inventoryLots: [
      {
        lot: 'LOT-A100-01',
        sku: 'A100',
        name: 'Motor A100',
        warehouse: 'WH-01',
        qty: 12,
        supplier: 'ABC Components',
        status: '可用',
      },
    ],
    inventorySerials: [
      {
        sn: 'SN-A100-001',
        sku: 'A100',
        warehouse: 'WH-01',
        status: '在库',
        lot: 'LOT-A100-01',
      },
    ],
    inventoryMovements: [
      {
        movementId: 'IM-001',
        movementType: 'PurchaseReceipt',
        date: '2026-06-01',
        sku: 'A100',
        itemName: 'Motor A100',
        warehouse: 'WH-01',
        location: 'A-01',
        sourceDocument: 'GRN-001',
        quantityIn: 10,
        quantityOut: 0,
        adjustmentQty: 0,
        status: '已确认',
        owner: 'Li',
        relatedPo: 'PO-001',
        relatedGrn: 'GRN-001',
      },
      {
        movementId: 'IM-002',
        movementType: 'StockAdjustment',
        date: '2026-06-02',
        sku: 'A100',
        itemName: 'Motor A100',
        warehouse: 'WH-01',
        location: 'A-01',
        sourceDocument: 'ADJ-001',
        quantityIn: 0,
        quantityOut: 0,
        adjustmentQty: -2,
        status: '待复核',
        owner: 'Chen',
      },
    ],
  }
}

function createRouteContext(method, pathname, db, repositories = createTestRepositoryRegistry(db)) {
  let response = null
  return {
    ctx: {
      req: { method, headers: {} },
      res: {},
      url: new URL(pathname, 'http://localhost'),
      db,
      repositories,
      send(_res, status, payload) {
        response = { status, payload }
      },
    },
    get response() {
      return response
    },
  }
}

test('inventory item list returns stable array', () => {
  const items = buildInventoryItems(createDb())
  assert.equal(items.length, 2)
  assert.deepEqual(items[0], {
    sku: 'A100',
    itemName: 'Motor A100',
    category: 'Components',
    supplier: 'ABC Components',
    defaultWarehouseId: 'WH-01',
    location: 'A-01',
    availableQuantity: 12,
    onHandQuantity: 18,
    reservedQuantity: 6,
    safetyStock: 50,
    reorderPoint: 80,
    status: '低库存',
    riskLevel: '高',
    riskReason: '高',
    unit: 'pcs',
    updatedAt: '',
  })
})

test('item lookup by SKU works and unknown SKU returns null', () => {
  assert.equal(getInventoryItemBySku(createDb(), 'A100').itemName, 'Motor A100')
  assert.equal(getInventoryItemBySku(createDb(), 'NOPE'), null)
})

test('lots and serials return stable records when data is available', () => {
  assert.deepEqual(buildInventoryLots(createDb())[0], {
    lotId: 'LOT-A100-01',
    sku: 'A100',
    itemName: 'Motor A100',
    warehouseId: 'WH-01',
    location: 'WH-01',
    quantity: 12,
    qaStatus: '可用',
    expiryDate: '',
    supplier: 'ABC Components',
    sourceDocument: '',
    status: '可用',
  })
  assert.deepEqual(buildInventorySerials(createDb())[0], {
    serialId: 'SN-A100-001',
    sku: 'A100',
    itemName: '',
    warehouseId: 'WH-01',
    location: 'WH-01',
    status: '在库',
    owner: '',
    sourceDocument: 'LOT-A100-01',
    updatedAt: '',
  })
})

test('movements list returns ids, sku, source document, quantities, and status', () => {
  const movements = buildInventoryMovements(createDb())
  assert.equal(movements.length, 2)
  assert.equal(movements[0].movementId, 'IM-001')
  assert.equal(movements[0].sku, 'A100')
  assert.equal(movements[0].sourceDocument, 'GRN-001')
  assert.equal(movements[0].quantityIn, 10)
  assert.equal(movements[0].status, '已确认')
})

test('exceptions list derives exception id, sku, linked document, and status', () => {
  const exceptions = buildInventoryExceptions(createDb())
  assert.equal(exceptions.length, 1)
  assert.equal(exceptions[0].id, 'IEX-READ-0001')
  assert.equal(exceptions[0].sku, 'A100')
  assert.equal(exceptions[0].linkedMovement, 'IM-002')
  assert.equal(exceptions[0].linkedDocument, 'ADJ-001')
  assert.equal(exceptions[0].status, '待复核')
})

test('summary returns counts and risk numbers', () => {
  assert.deepEqual(buildInventorySummary(createDb()), {
    itemCount: 2,
    lowStockCount: 1,
    highRiskCount: 1,
    movementCount: 2,
    exceptionCount: 1,
    lotCount: 1,
    serialCount: 1,
  })
})

test('source arrays are not mutated', () => {
  const db = createDb()
  const before = JSON.stringify(db)
  buildInventoryItems(db)
  buildInventoryLots(db)
  buildInventorySerials(db)
  buildInventoryMovements(db)
  buildInventoryExceptions(db)
  buildInventorySummary(db)
  assert.equal(JSON.stringify(db), before)
})

test('filter by q, status, warehouse, and risk works', () => {
  const items = buildInventoryItems(createDb())
  assert.equal(filterInventoryRows(items, { q: 'Motor' }).length, 1)
  assert.equal(filterInventoryRows(items, { status: '低库存' }).length, 1)
  assert.equal(filterInventoryRows(items, { warehouse: 'WH-01' }).length, 1)
  assert.equal(filterInventoryRows(items, { risk: '高' }).length, 1)
  assert.equal(filterInventoryRows(items, { q: 'A', limit: 1 }).length, 1)
})

test('GET /api/inventory/items and item detail routes return read payloads', async () => {
  const listRoute = createRouteContext('GET', '/api/inventory/items?q=A100', createDb())
  assert.equal(await handleInventoryRoute(listRoute.ctx), true)
  assert.equal(listRoute.response.status, 200)
  assert.equal(listRoute.response.payload.items.length, 1)

  const detailRoute = createRouteContext('GET', '/api/inventory/items/A100', createDb())
  assert.equal(await handleInventoryRoute(detailRoute.ctx), true)
  assert.equal(detailRoute.response.status, 200)
  assert.equal(detailRoute.response.payload.item.sku, 'A100')
})

test('GET /api/inventory/items/:sku returns 404 for missing item', async () => {
  const route = createRouteContext('GET', '/api/inventory/items/MISSING', createDb())
  assert.equal(await handleInventoryRoute(route.ctx), true)
  assert.equal(route.response.status, 404)
  assert.deepEqual(route.response.payload, { error: 'Inventory item not found' })
})

test('inventory collection routes return arrays and summary', async () => {
  for (const [path, key] of [
    ['/api/inventory/lots', 'lots'],
    ['/api/inventory/serials', 'serials'],
    ['/api/inventory/movements', 'movements'],
    ['/api/inventory/exceptions', 'exceptions'],
  ]) {
    const route = createRouteContext('GET', path, createDb())
    assert.equal(await handleInventoryRoute(route.ctx), true)
    assert.equal(route.response.status, 200)
    assert.ok(Array.isArray(route.response.payload[key]))
  }
  const summaryRoute = createRouteContext('GET', '/api/inventory/summary', createDb())
  assert.equal(await handleInventoryRoute(summaryRoute.ctx), true)
  assert.equal(summaryRoute.response.payload.summary.itemCount, 2)
})

test('inventory route supports async repository contracts for all read endpoints', async () => {
  const calls = []
  const repositories = {
    inventoryRead: {
      listItems: async (filters) => {
        calls.push(['listItems', filters])
        return [{ sku: 'ASYNC-1', itemName: 'Async Item' }]
      },
      getItem: async (idOrSku) => {
        calls.push(['getItem', idOrSku])
        return idOrSku === 'ASYNC-1' ? { sku: 'ASYNC-1', itemName: 'Async Item' } : null
      },
      listLots: async (filters) => {
        calls.push(['listLots', filters])
        return [{ lotId: 'LOT-ASYNC-1', sku: 'ASYNC-1' }]
      },
      listSerials: async (filters) => {
        calls.push(['listSerials', filters])
        return [{ serialId: 'SN-ASYNC-1', sku: 'ASYNC-1' }]
      },
      listMovements: async (filters) => {
        calls.push(['listMovements', filters])
        return [{ movementId: 'IM-ASYNC-1', sku: 'ASYNC-1' }]
      },
      listExceptions: async (filters) => {
        calls.push(['listExceptions', filters])
        return [{ id: 'IEX-ASYNC-1', sku: 'ASYNC-1' }]
      },
      getSummary: async () => {
        calls.push(['getSummary'])
        return { itemCount: 1, movementCount: 1, exceptionCount: 1 }
      },
    },
  }

  for (const [path, key] of [
    ['/api/inventory/items?q=ASYNC', 'items'],
    ['/api/inventory/lots?warehouse=WH-ASYNC', 'lots'],
    ['/api/inventory/serials', 'serials'],
    ['/api/inventory/movements', 'movements'],
    ['/api/inventory/exceptions', 'exceptions'],
  ]) {
    const route = createRouteContext('GET', path, createDb(), repositories)
    assert.equal(await handleInventoryRoute(route.ctx), true)
    assert.equal(route.response.status, 200)
    assert.ok(Array.isArray(route.response.payload[key]))
  }

  const detailRoute = createRouteContext('GET', '/api/inventory/items/ASYNC-1', createDb(), repositories)
  assert.equal(await handleInventoryRoute(detailRoute.ctx), true)
  assert.equal(detailRoute.response.status, 200)
  assert.equal(detailRoute.response.payload.item.sku, 'ASYNC-1')

  const missingRoute = createRouteContext('GET', '/api/inventory/items/MISSING', createDb(), repositories)
  assert.equal(await handleInventoryRoute(missingRoute.ctx), true)
  assert.equal(missingRoute.response.status, 404)

  const summaryRoute = createRouteContext('GET', '/api/inventory/summary', createDb(), repositories)
  assert.equal(await handleInventoryRoute(summaryRoute.ctx), true)
  assert.equal(summaryRoute.response.payload.summary.itemCount, 1)

  assert.deepEqual(calls.map(([name]) => name), [
    'listItems',
    'listLots',
    'listSerials',
    'listMovements',
    'listExceptions',
    'getItem',
    'getItem',
    'getSummary',
  ])
})
