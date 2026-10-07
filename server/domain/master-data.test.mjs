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
      masterDataReadAccess: { partner: true, prices: true },
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

test('supplier registration, tax and bank details and reference prices are masked by permission', async () => {
  const supplier = { id: 'SUP-BANK', supplierName: 'Bank Supplier', creditCode: '91310000MA1K', taxIdentificationNumber: '12-3456789', bankName: 'First Bank', bankAccountName: 'Bank Supplier LLC', bankAccountNumber: '000123456789', status: 'active' }
  const relationship = { relationshipId: 'REL-1', itemId: 'ITEM-1', supplierId: 'SUP-BANK', referencePrice: 12.5 }
  const repositories = { masterData: { listSuppliers: async () => [supplier], getSupplier: async () => supplier, listItemSuppliers: async () => [relationship], approvedSuppliersForItem: async () => [{ ...relationship }] } }
  const hidden = { partner: false, prices: false }
  for (const path of ['/api/master-data/suppliers', '/api/master-data/suppliers/SUP-BANK', '/api/master-data/suppliers/select']) {
    const route = createRouteContext('GET', path, createDb(), repositories)
    route.ctx.masterDataReadAccess = hidden
    await handleMasterDataRoute(route.ctx)
    const row = route.response.payload.supplier || route.response.payload.suppliers[0]
    assert.equal(row.bankAccountNumber, '****6789', path)
    assert.equal(row.taxIdentificationNumber, '****6789', path)
    assert.equal(row.creditCode, '****MA1K', path)
    assert.equal(row.bankAccountName, '**** LLC', path)
    assert.equal(row.bankName, 'First Bank', path)
    assert.deepEqual(row.restrictedFields, ['creditCode', 'taxIdentificationNumber', 'bankAccountName', 'bankAccountNumber'], path)
    assert.equal(JSON.stringify(route.response.payload).includes('000123456789'), false, path)
  }
  const prices = createRouteContext('GET', '/api/master-data/items/ITEM-1/suppliers', createDb(), repositories)
  prices.ctx.masterDataReadAccess = hidden
  await handleMasterDataRoute(prices.ctx)
  assert.equal(prices.response.payload.relationships[0].referencePrice, null)
  assert.equal(prices.response.payload.suppliers[0].referencePrice, null)
  assert.deepEqual(prices.response.payload.suppliers[0].restrictedFields, ['referencePrice'])

  const visible = createRouteContext('GET', '/api/master-data/suppliers/SUP-BANK', createDb(), repositories)
  await handleMasterDataRoute(visible.ctx)
  assert.equal(visible.response.payload.supplier.bankAccountNumber, '000123456789')
  assert.equal(visible.response.payload.supplier.restrictedFields, undefined)
})

// Writes are authorized from Roles & permissions. Without a database the
// route takes the resolved actor from ctx.masterDataActor.
const writer = (permissions, overrides = {}) => ({ complete: true, authenticated: true, tenantId: 'tenant-a', userId: 'user-a', roleIds: ['role-a'], inactiveRoleIds: [], permissionCodes: new Set(permissions), permissionSourceRoleIds: new Map(), readWarehouseIds: new Set(), operateWarehouseIds: new Set(), ...overrides })

function writeRoute(method, pathname, { actor, role = 'manager', identity = { authenticated: true, tenantId: 'tenant-a', userId: 'user-a', role }, body = {} } = {}) {
  const calls = []
  const record = (name, result) => async (...args) => { calls.push(name); return result(...args) }
  const masterData = {
    createItem: record('createItem', (input) => ({ itemId: 'ITEM-NEW', ...input, version: 1 })),
    updateItem: record('updateItem', (id, input) => ({ itemId: id, ...input })),
    createSupplier: record('createSupplier', (input) => ({ id: 'SUP-NEW', ...input, version: 1 })),
    updateSupplier: record('updateSupplier', (id, input) => ({ id, ...input })),
    createCustomer: record('createCustomer', (input) => ({ id: 'CUST-NEW', ...input, version: 1 })),
    updateCustomer: record('updateCustomer', (id, input) => ({ id, ...input })),
    createItemSupplier: record('createItemSupplier', (itemId, input) => ({ relationshipId: 'REL-NEW', itemId, ...input })),
    updateItemSupplier: record('updateItemSupplier', (itemId, relationshipId, input) => ({ relationshipId, itemId, ...input })),
    createWarehouse: record('createWarehouse', (input) => ({ id: 'WH-NEW', ...input, version: 1 })),
    updateWarehouse: record('updateWarehouse', (id, input) => ({ id, ...input })),
    setWarehouseStatus: record('setWarehouseStatus', (id, input) => ({ warehouse: { id, status: input.status }, clearedDefaults: 0 })),
    listWarehouseBins: record('listWarehouseBins', (warehouseId) => [{ id: 'BIN-1', warehouseId, code: 'A-01' }]),
    createWarehouseBin: record('createWarehouseBin', (warehouseId, input) => ({ id: 'BIN-NEW', warehouseId, ...input })),
    updateWarehouseBin: record('updateWarehouseBin', (warehouseId, binId, input) => ({ id: binId, warehouseId, ...input })),
    setWarehouseBinStatus: record('setWarehouseBinStatus', (warehouseId, binId, input) => ({ id: binId, warehouseId, status: input.status })),
  }
  const route = createRouteContext(method, pathname, createDb(), { masterData })
  route.ctx.identity = identity
  route.ctx.masterDataActor = actor
  route.ctx.readBody = async () => body
  return { route, calls }
}

const hasChinese = (value) => /[㐀-鿿]/.test(String(value))

test('master data writes follow Roles & permissions, not the legacy role', async () => {
  // A legacy buyer with the Procurement Specialist codes maintains items and
  // suppliers, but not customers.
  const buyer = writer(['master_data.item.manage', 'master_data.supplier.manage'])
  for (const [method, path, status] of [
    ['POST', '/api/master-data/suppliers', 201],
    ['PATCH', '/api/master-data/suppliers/SUP-001', 200],
    ['POST', '/api/master-data/items', 201],
    ['PATCH', '/api/master-data/items/ITEM-A100', 200],
    ['POST', '/api/master-data/items/ITEM-A100/suppliers', 201],
    ['PATCH', '/api/master-data/items/ITEM-A100/suppliers/REL-1', 200],
  ]) {
    const { route, calls } = writeRoute(method, path, { actor: buyer, role: 'buyer', body: { name: 'Written' } })
    assert.equal(await handleMasterDataRoute(route.ctx), true)
    assert.equal(route.response.status, status, `${method} ${path} ${JSON.stringify(route.response.payload)}`)
    assert.equal(calls.length, 1, `${method} ${path}`)
  }
  const customer = writeRoute('POST', '/api/master-data/customers', { actor: buyer, role: 'buyer', body: { code: 'CUST-1', name: 'Denied' } })
  await handleMasterDataRoute(customer.route.ctx)
  assert.equal(customer.route.response.status, 403)
  assert.deepEqual(customer.calls, [])
  assert.equal(customer.route.response.payload.code, 'PERMISSION_DENIED')
  assert.equal(customer.route.response.payload.permission, 'master_data.customer.manage')
  assert.equal(customer.route.response.payload.reasonCode, 'AUTHORIZATION_PERMISSION_DENIED')
  assert.match(customer.route.response.payload.message, /Your roles do not allow changing customers/)
  assert.equal(hasChinese(customer.route.response.payload.message), false)

  // A legacy manager whose roles were narrowed to read codes changes nothing.
  const narrowed = writer(['returns.request.read', 'sales_order.read', 'inventory.balance.read'])
  for (const [method, path, permission] of [
    ['POST', '/api/master-data/items', 'master_data.item.manage'],
    ['PATCH', '/api/master-data/items/ITEM-A100', 'master_data.item.manage'],
    ['POST', '/api/master-data/items/ITEM-A100/suppliers', 'master_data.item.manage'],
    ['PATCH', '/api/master-data/items/ITEM-A100/suppliers/REL-1', 'master_data.item.manage'],
    ['POST', '/api/master-data/suppliers', 'master_data.supplier.manage'],
    ['PATCH', '/api/master-data/suppliers/SUP-001', 'master_data.supplier.manage'],
    ['POST', '/api/master-data/customers', 'master_data.customer.manage'],
    ['PATCH', '/api/master-data/customers/CUST-1', 'master_data.customer.manage'],
    ['POST', '/api/master-data/customers/CUST-1/deactivate', 'master_data.customer.manage'],
  ]) {
    const { route, calls } = writeRoute(method, path, { actor: narrowed, role: 'manager' })
    await handleMasterDataRoute(route.ctx)
    assert.deepEqual([route.response.status, route.response.payload.code, route.response.payload.permission], [403, 'PERMISSION_DENIED', permission], `${method} ${path}`)
    assert.deepEqual(calls, [], `${method} ${path}`)
  }
})

test('master data writes refuse signed-out sessions and actors from another workspace', async () => {
  const everything = ['master_data.item.manage', 'master_data.supplier.manage', 'master_data.customer.manage']
  const signedOut = writeRoute('POST', '/api/master-data/items', { actor: writer(everything), identity: { authenticated: false } })
  await handleMasterDataRoute(signedOut.route.ctx)
  assert.deepEqual([signedOut.route.response.status, signedOut.route.response.payload.code], [401, 'AUTHENTICATION_REQUIRED'])
  assert.equal(hasChinese(signedOut.route.response.payload.message), false)
  assert.deepEqual(signedOut.calls, [])

  const foreign = writeRoute('POST', '/api/master-data/suppliers', { actor: writer(everything, { tenantId: 'tenant-b' }) })
  await handleMasterDataRoute(foreign.route.ctx)
  assert.deepEqual([foreign.route.response.status, foreign.route.response.payload.reasonCode], [403, 'AUTHORIZATION_TENANT_MISMATCH'])
  assert.deepEqual(foreign.calls, [])

  const incomplete = writeRoute('POST', '/api/master-data/customers', { actor: writer(everything, { complete: false }) })
  await handleMasterDataRoute(incomplete.route.ctx)
  assert.deepEqual([incomplete.route.response.status, incomplete.route.response.payload.reasonCode], [403, 'AUTHORIZATION_CONTEXT_INCOMPLETE'])
  assert.deepEqual(incomplete.calls, [])
})

// Warehouses and bins are workspace setup: settings.workspace.manage, plus
// operate access to the warehouse for every change after it exists.
const WAREHOUSE_WRITES = [
  ['POST', '/api/master-data/warehouses', 201, 'createWarehouse'],
  ['PATCH', '/api/master-data/warehouses/WH-1', 200, 'updateWarehouse'],
  ['POST', '/api/master-data/warehouses/WH-1/deactivate', 200, 'setWarehouseStatus'],
  ['POST', '/api/master-data/warehouses/WH-1/activate', 200, 'setWarehouseStatus'],
  ['POST', '/api/master-data/warehouses/WH-1/bins', 201, 'createWarehouseBin'],
  ['PATCH', '/api/master-data/warehouses/WH-1/bins/BIN-1', 200, 'updateWarehouseBin'],
  ['POST', '/api/master-data/warehouses/WH-1/bins/BIN-1/deactivate', 200, 'setWarehouseBinStatus'],
  ['POST', '/api/master-data/warehouses/WH-1/bins/BIN-1/activate', 200, 'setWarehouseBinStatus'],
]

test('warehouse and bin writes need settings.workspace.manage and operate access to the warehouse', async () => {
  const admin = writer(['settings.workspace.manage'], { readWarehouseIds: new Set(['WH-1']), operateWarehouseIds: new Set(['WH-1']) })
  for (const [method, path, status, call] of WAREHOUSE_WRITES) {
    const { route, calls } = writeRoute(method, path, { actor: admin, role: 'admin', body: { code: 'NEW', name: 'Written', expectedVersion: 1 } })
    assert.equal(await handleMasterDataRoute(route.ctx), true)
    assert.equal(route.response.status, status, `${method} ${path} ${JSON.stringify(route.response.payload)}`)
    assert.deepEqual(calls, [call], `${method} ${path}`)
  }
  const status = writeRoute('POST', '/api/master-data/warehouses/WH-1/deactivate', { actor: admin, role: 'admin', body: { expectedVersion: 2 } })
  await handleMasterDataRoute(status.route.ctx)
  assert.deepEqual(status.route.response.payload, { warehouse: { id: 'WH-1', status: 'inactive' }, clearedDefaults: 0 })

  // Someone who maintains every kind of master data but not the workspace
  // changes no warehouse, even with operate access to it.
  const masterData = writer(['master_data.item.manage', 'master_data.supplier.manage', 'master_data.customer.manage'], { operateWarehouseIds: new Set(['WH-1']) })
  for (const [method, path] of WAREHOUSE_WRITES) {
    const { route, calls } = writeRoute(method, path, { actor: masterData, role: 'manager' })
    await handleMasterDataRoute(route.ctx)
    assert.deepEqual([route.response.status, route.response.payload.code, route.response.payload.permission], [403, 'PERMISSION_DENIED', 'settings.workspace.manage'], `${method} ${path}`)
    assert.match(route.response.payload.message, /Your roles do not allow changing warehouses and bins/)
    assert.deepEqual(calls, [], `${method} ${path}`)
  }

  // An administrator without operate access to the warehouse is refused the
  // same way whether or not it exists; read access is not enough. Creating a
  // new warehouse needs no access to an existing one.
  const readOnlyScope = writer(['settings.workspace.manage'], { readWarehouseIds: new Set(['WH-1']), operateWarehouseIds: new Set() })
  for (const [method, path] of WAREHOUSE_WRITES.slice(1)) {
    for (const target of [path, path.replace('WH-1', 'WH-MISSING')]) {
      const { route, calls } = writeRoute(method, target, { actor: readOnlyScope, role: 'admin' })
      await handleMasterDataRoute(route.ctx)
      assert.deepEqual([route.response.status, route.response.payload.code], [403, 'WAREHOUSE_SCOPE_DENIED'], `${method} ${target}`)
      assert.equal(hasChinese(route.response.payload.message), false)
      assert.deepEqual(calls, [], `${method} ${target}`)
    }
  }

  for (const [method, path] of WAREHOUSE_WRITES) {
    const { route, calls } = writeRoute(method, path, { actor: admin, identity: { authenticated: false } })
    await handleMasterDataRoute(route.ctx)
    assert.deepEqual([route.response.status, route.response.payload.code], [401, 'AUTHENTICATION_REQUIRED'], `${method} ${path}`)
    assert.deepEqual(calls, [], `${method} ${path}`)
  }
})

test('the bins of a warehouse are read with read access to it', async () => {
  const reader = writer([], { readWarehouseIds: new Set(['WH-1']) })
  const allowed = writeRoute('GET', '/api/master-data/warehouses/WH-1/bins', { actor: reader, role: 'viewer' })
  await handleMasterDataRoute(allowed.route.ctx)
  assert.equal(allowed.route.response.status, 200)
  assert.deepEqual(allowed.route.response.payload.bins.map((bin) => bin.code), ['A-01'])

  const outside = writeRoute('GET', '/api/master-data/warehouses/WH-2/bins', { actor: reader, role: 'viewer' })
  await handleMasterDataRoute(outside.route.ctx)
  assert.deepEqual([outside.route.response.status, outside.route.response.payload.code], [403, 'WAREHOUSE_SCOPE_DENIED'])
  assert.deepEqual(outside.calls, [])

  const signedOut = writeRoute('GET', '/api/master-data/warehouses/WH-1/bins', { actor: reader, identity: { authenticated: false } })
  await handleMasterDataRoute(signedOut.route.ctx)
  assert.deepEqual([signedOut.route.response.status, signedOut.route.response.payload.code], [401, 'AUTHENTICATION_REQUIRED'])
  assert.deepEqual(signedOut.calls, [])

  const foreign = writeRoute('GET', '/api/master-data/warehouses/WH-1/bins', { actor: writer([], { tenantId: 'tenant-b', readWarehouseIds: new Set(['WH-1']) }) })
  await handleMasterDataRoute(foreign.route.ctx)
  assert.deepEqual([foreign.route.response.status, foreign.route.response.payload.code], [403, 'WAREHOUSE_SCOPE_DENIED'])
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
