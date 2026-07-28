import test from 'node:test'
import { createTestRepositoryRegistry } from './test-fixtures/runtime-repositories.mjs'
import assert from 'node:assert/strict'
import { handleMasterDataRoute } from '../routes/master-data.routes.mjs'
import {
  findMasterItem,
  findMasterSupplier,
  listMasterItems,
  listMasterSuppliers,
  listMasterWarehouses,
  listPaymentTerms,
  listTaxCodes,
} from './master-data.mjs'

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

function createDb() {
  return {
    products: [
      {
        sku: 'A100',
        name: 'Motor A100',
        category: 'Components',
        unit: 'pcs',
        supplier: 'ABC Components',
        leadTimeDays: 7,
        moq: 100,
        batchMultiple: 50,
      },
      {
        sku: 'B200',
        name: 'Bracket B200',
        supplier: 'Unlisted Supplier',
        defaultWarehouseId: 'WH-SECONDARY',
      },
    ],
    suppliers: [
      {
        id: 'SUP-001',
        name: 'ABC Components',
        category: 'Motors',
        risk: '中',
        onTimeRate: 91,
        qualityRate: 96,
        preferred: true,
      },
      {
        id: 'SUP-002',
        name: 'Explicit Tools',
        score: 'B+',
      },
    ],
    warehouses: [
      {
        id: 'WH-EXPLICIT',
        name: 'Explicit Warehouse',
      },
      {
        id: 'BIN-A1',
        name: 'Aisle A1 Bin',
        type: 'bin',
        parentId: 'WH-EXPLICIT',
      },
    ],
    inventoryMovements: [
      {
        warehouseId: 'WH-MOVEMENT',
      },
    ],
  }
}

test('master data helper normalizes item read models with supplier source metadata', () => {
  const items = listMasterItems(createDb())
  assert.equal(items.length, 2)
  assert.deepEqual(items[0], {
    id: 'ITEM-A100',
    sku: 'A100',
    name: 'Motor A100',
    category: 'Components',
    baseUom: 'pcs',
    defaultWarehouseId: 'WH-MAIN',
    preferredSupplierId: 'SUP-001',
    preferredSupplierSource: 'matched_supplier_master',
    leadTimeDays: 7,
    moq: 100,
    batchMultiple: 50,
    status: 'active',
  })
  assert.equal(items[1].preferredSupplierId, 'SUP-UNLISTED-SUPPLIER')
  assert.equal(items[1].preferredSupplierSource, 'derived_from_item_supplier_name')
  assert.equal(findMasterItem(createDb(), 'A100')?.id, 'ITEM-A100')
})

test('master data helper marks missing preferred supplier metadata', () => {
  const items = listMasterItems({ products: [{ sku: 'C300', name: 'Cap C300' }] })

  assert.equal(items[0].preferredSupplierId, '')
  assert.equal(items[0].preferredSupplierSource, 'missing')
})

test('master data helper normalizes supplier read models with score source metadata', () => {
  const suppliers = listMasterSuppliers(createDb())
  assert.equal(suppliers.length, 2)
  assert.deepEqual(suppliers[0], {
    id: 'SUP-001',
    name: 'ABC Components',
    status: 'active',
    risk: 'medium',
    score: 'A',
    scoreSource: 'derived_performance_fallback',
    defaultCurrency: 'USD',
    paymentTermsId: 'NET30',
    categories: ['Motors'],
    preferred: true,
  })
  assert.equal(suppliers[1].score, 'B+')
  assert.equal(suppliers[1].scoreSource, 'explicit')
  assert.equal(findMasterSupplier(createDb(), 'ABC Components')?.id, 'SUP-001')
})

test('master data helper marks missing supplier score metadata', () => {
  const suppliers = listMasterSuppliers({ suppliers: [{ id: 'SUP-003', name: 'New Supplier' }] })

  assert.equal(suppliers[0].score, '')
  assert.equal(suppliers[0].scoreSource, 'missing')
})

test('GET /api/master-data/items returns item collection', async () => {
  const route = createRouteContext('GET', '/api/master-data/items', createDb())
  const handled = await handleMasterDataRoute(route.ctx)

  assert.ok(handled)
  assert.equal(route.response.status, 200)
  assert.equal(route.response.payload.items.length, 2)
  assert.equal(route.response.payload.items[0].id, 'ITEM-A100')
  assert.equal(route.response.payload.items[0].preferredSupplierSource, 'matched_supplier_master')
})

test('GET /api/master-data/items/:id returns one item', async () => {
  const db = createDb()
  const route = createRouteContext('GET', '/api/master-data/items/ITEM-A100', db, {
    masterData: {
      getManagedItem: async () => null,
      getItem: (id) => findMasterItem(db, id),
    },
  })
  const handled = await handleMasterDataRoute(route.ctx)

  assert.ok(handled)
  assert.equal(route.response.status, 200)
  assert.equal(route.response.payload.item.sku, 'A100')
})

test('GET /api/master-data/items/:id returns 404 for missing item', async () => {
  const route = createRouteContext('GET', '/api/master-data/items/ITEM-MISSING', createDb())
  const handled = await handleMasterDataRoute(route.ctx)

  assert.ok(handled)
  assert.equal(route.response.status, 404)
  assert.deepEqual(route.response.payload, { error: 'Item not found' })
})

test('item supplier relationships fail closed when PostgreSQL read model is unavailable', async () => {
  const route = createRouteContext(
    'GET',
    '/api/master-data/items/ITEM-A100/suppliers',
    createDb(),
    { masterData: {} },
  )
  const handled = await handleMasterDataRoute(route.ctx)

  assert.ok(handled)
  assert.equal(route.response.status, 501)
  assert.equal(route.response.payload.code, 'FLOWCHAIN_CAPABILITY_NOT_IMPLEMENTED')
  assert.equal(route.response.payload.capability, 'item-supplier-relationships')
  assert.ok(route.response.payload.limitations.length)
})

test('supplier item relationships fail closed when PostgreSQL read model is unavailable', async () => {
  const route = createRouteContext(
    'GET',
    '/api/master-data/suppliers/SUP-001/items',
    createDb(),
    { masterData: {} },
  )
  const handled = await handleMasterDataRoute(route.ctx)

  assert.ok(handled)
  assert.equal(route.response.status, 501)
  assert.equal(route.response.payload.code, 'FLOWCHAIN_CAPABILITY_NOT_IMPLEMENTED')
  assert.equal(route.response.payload.capability, 'supplier-item-relationships')
})

test('GET /api/master-data/suppliers returns supplier collection', async () => {
  const rows = [{ id: 'SUP-RUNTIME', supplierCode: 'SUP-RUNTIME', supplierName: 'Runtime Supplier', status: 'active' }]
  const route = createRouteContext('GET', '/api/master-data/suppliers', createDb(), { masterData: { listSuppliers: async () => rows } })
  const handled = await handleMasterDataRoute(route.ctx)

  assert.ok(handled)
  assert.equal(route.response.status, 200)
  assert.equal(route.response.payload.suppliers.length, 1)
  assert.equal(route.response.payload.suppliers[0].id, 'SUP-RUNTIME')
  assert.equal(route.response.payload.suppliers[0].supplierName, 'Runtime Supplier')
})

test('GET /api/master-data/suppliers/:id returns one supplier', async () => {
  const supplier = { id: 'SUP-RUNTIME', supplierCode: 'SUP-RUNTIME', supplierName: 'Runtime Supplier', status: 'active' }
  const route = createRouteContext('GET', '/api/master-data/suppliers/SUP-RUNTIME', createDb(), { masterData: { getSupplier: async () => supplier } })
  const handled = await handleMasterDataRoute(route.ctx)

  assert.ok(handled)
  assert.equal(route.response.status, 200)
  assert.equal(route.response.payload.supplier.supplierName, 'Runtime Supplier')
})

test('GET /api/master-data/suppliers/:id returns 404 for missing supplier', async () => {
  const route = createRouteContext('GET', '/api/master-data/suppliers/SUP-MISSING', createDb(), { masterData: { getSupplier: async () => null } })
  const handled = await handleMasterDataRoute(route.ctx)

  assert.ok(handled)
  assert.equal(route.response.status, 404)
  assert.deepEqual(route.response.payload, { error: 'Supplier not found' })
})

test('GET /api/master-data/warehouses returns warehouse references', async () => {
  const db = createDb()
  const route = createRouteContext('GET', '/api/master-data/warehouses', db)
  const handled = await handleMasterDataRoute(route.ctx)

  assert.ok(handled)
  assert.equal(route.response.status, 200)
  assert.deepEqual(route.response.payload.warehouses, listMasterWarehouses(db))
  assert.equal(route.response.payload.warehouses[0].id, 'WH-EXPLICIT')
  assert.equal(route.response.payload.warehouses[0].type, 'warehouse')
  assert.equal(route.response.payload.warehouses[0].sourceType, 'explicit_data')
  assert.equal(route.response.payload.warehouses[1].type, 'bin')
  assert.equal(route.response.payload.warehouses.find((warehouse) => warehouse.id === 'WH-SECONDARY').sourceType, 'derived_from_items')
  assert.equal(route.response.payload.warehouses.find((warehouse) => warehouse.id === 'WH-MOVEMENT').sourceType, 'derived_from_transactions')
})

test('master data helper returns default warehouse source metadata', () => {
  const warehouses = listMasterWarehouses({})

  assert.deepEqual(warehouses, [{
    id: 'WH-MAIN',
    name: 'Main Warehouse',
    type: 'warehouse',
    status: 'active',
    parentId: null,
    sourceType: 'default_reference',
  }])
})

test('GET /api/master-data/payment-terms returns payment term references', async () => {
  const db = createDb()
  const route = createRouteContext('GET', '/api/master-data/payment-terms', db)
  const handled = await handleMasterDataRoute(route.ctx)

  assert.ok(handled)
  assert.equal(route.response.status, 200)
  assert.deepEqual(route.response.payload.paymentTerms, listPaymentTerms(db))
  assert.equal(route.response.payload.paymentTerms[0].id, 'NET30')
  assert.equal(route.response.payload.paymentTerms[0].sourceType, 'default_reference')
})

test('master data helper marks explicit payment terms source metadata', () => {
  const terms = listPaymentTerms({ paymentTerms: [{ id: 'NET45', label: 'Net 45', days: 45 }] })

  assert.deepEqual(terms[0], {
    id: 'NET45',
    label: 'Net 45',
    days: 45,
    status: 'active',
    sourceType: 'explicit_data',
  })
})

test('GET /api/master-data/tax-codes returns tax code references', async () => {
  const db = createDb()
  const route = createRouteContext('GET', '/api/master-data/tax-codes', db)
  const handled = await handleMasterDataRoute(route.ctx)

  assert.ok(handled)
  assert.equal(route.response.status, 200)
  assert.deepEqual(route.response.payload.taxCodes, listTaxCodes(db))
  assert.equal(route.response.payload.taxCodes[0].id, 'TAX-STD')
  assert.equal(route.response.payload.taxCodes[0].sourceType, 'default_reference')
})

test('master data helper marks explicit tax code source metadata', () => {
  const taxCodes = listTaxCodes({ taxCodes: [{ id: 'TAX-ZERO', label: 'Zero Tax', rate: 0 }] })

  assert.deepEqual(taxCodes[0], {
    id: 'TAX-ZERO',
    label: 'Zero Tax',
    rate: 0,
    status: 'active',
    sourceType: 'explicit_data',
  })
})
