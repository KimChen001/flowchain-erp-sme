import test from 'node:test'
import assert from 'node:assert/strict'
import { handleSearchRoute } from './search.routes.mjs'
import { reportReadAccessFor } from '../domain/report-read-access.mjs'
import { defaultRoleTemplates, permissionCodes } from '../auth/permission-catalog.mjs'

// Search reads the business read context as the reader may see it: no
// records from collections their role cannot read, no hidden amounts or
// supplier bank details to match on, and stock from their warehouses only.

const roleAccess = (roleKey, warehouseIds = null) => ({
  ...reportReadAccessFor({ authenticated: true, complete: true, tenantId: 'tenant-s', permissionCodes: new Set(roleKey === '*' ? permissionCodes : defaultRoleTemplates.find(role => role.roleKey === roleKey).permissions) }),
  warehouseIds,
})

const purchaseOrder = { id: 'PO-1', status: 'approved', supplierId: 'SUP-1', supplierSnapshot: { supplierName: 'Harbor Supply' }, currency: 'USD', totalAmount: 48125, lines: [{ sku: 'SKU-1', quantity: 10, unitPrice: 4812.5, amount: 48125 }] }
const invoice = { id: 'INV-1', invoiceNumber: 'INV-1', status: 'submitted', supplierName: 'Harbor Supply', poId: 'PO-1', currency: 'USD', totalAmount: 37950 }
const salesOrder = { id: 'SO-1', salesOrderId: 'SO-1', customerName: 'Redwood Retail', sku: 'SKU-1', orderedQty: 4, status: 'confirmed', totalAmount: 720, currency: 'USD' }
const balances = [
  { sku: 'SKU-1', itemName: 'Valve', warehouseId: 'WH-EAST', onHandQuantity: 150 },
  { sku: 'SKU-2', itemName: 'Gasket', warehouseId: 'WH-WEST', onHandQuantity: 999 },
]

// The production read path: repositories behind the business read context
// service. The inventory repository honours the warehouse ids it is given.
function repositories(seen) {
  return {
    masterData: {
      listItems: async () => [{ id: 'SKU-1', sku: 'SKU-1', name: 'Valve' }, { id: 'SKU-2', sku: 'SKU-2', name: 'Gasket' }],
      listSuppliers: async () => [{ id: 'SUP-1', name: 'Harbor Supply', bankAccountNumber: '000123456789', taxIdentificationNumber: '12-3456789' }],
      listCustomers: async () => [],
      listAllItemSupplierRelationships: async () => [],
    },
    inventoryRuntime: { listItems: async (scope) => { seen.warehouseIds = scope?.warehouseIds ?? null; return scope?.warehouseIds ? balances.filter(row => scope.warehouseIds.includes(row.warehouseId)) : balances } },
    salesOrders: { listOrders: async () => [salesOrder] },
    procurementRuntime: { snapshot: async () => ({ purchaseRequests: [], rfqs: [], purchaseOrders: [purchaseOrder], receipts: [], supplierInvoices: [invoice] }) },
  }
}

async function search(query, access) {
  let response
  const seen = {}
  const handled = await handleSearchRoute({
    req: { method: 'GET' }, res: {}, url: new URL(`http://local/api/search?q=${encodeURIComponent(query)}&limit=50`),
    repositories: repositories(seen), dataMode: 'user', identity: { authenticated: true, tenantId: 'tenant-s' }, reportReadAccess: access,
    send: (_res, status, payload) => { response = { status, payload: JSON.parse(JSON.stringify(payload)) } },
  })
  assert.equal(handled, true)
  return { ...response, seen }
}
const types = (payload) => payload.results.map(row => row.type)

test('a reader with every permission finds records by amount, partner details and any warehouse', async () => {
  const all = roleAccess('*')
  assert.deepEqual(types((await search('48125', all)).payload), ['purchase_order'])
  assert.deepEqual(types((await search('000123456789', all)).payload), ['supplier'])
  assert.ok(types((await search('SO-1', all)).payload).includes('sales_order'))
  assert.ok(types((await search('SKU-2', all)).payload).includes('inventory_item'))
})

test('the read-only viewer gets no purchase order or invoice amounts from search', async () => {
  const viewer = roleAccess('read-only-viewer')
  for (const amount of ['48125', '4812.5', '37950']) {
    const { status, payload } = await search(amount, viewer)
    assert.equal(status, 200)
    assert.deepEqual(payload.results, [], `${amount} is still searchable`)
  }
  // The viewer still finds the order itself, without its amount.
  const order = await search('PO-1', viewer)
  assert.deepEqual(types(order.payload), ['purchase_order'])
  assert.equal(JSON.stringify(order.payload).includes('48125'), false)
  // Supplier bank and tax details need finance.partner_snapshot.read.
  assert.deepEqual((await search('000123456789', viewer)).payload.results, [])
  assert.deepEqual((await search('12-3456789', viewer)).payload.results, [])
})

test('the procurement specialist gets no supplier invoices or sales orders from search', async () => {
  const buyer = roleAccess('procurement-specialist')
  for (const query of ['SO-1', 'Redwood', 'INV-1', '37950']) {
    const { status, payload } = await search(query, buyer)
    assert.equal(status, 200)
    assert.ok(!types(payload).includes('sales_order'), query)
    assert.ok(!types(payload).includes('supplier_invoice'), query)
    assert.equal(JSON.stringify(payload.results).includes('Redwood'), false, query)
  }
  const { payload } = await search('SO-1', buyer)
  assert.ok(payload.restrictedSubjects.includes('sales_orders'))
  assert.ok(payload.restrictedSubjects.includes('supplier_invoices'))
  // The buyer may read prices, so purchase orders stay searchable by amount.
  assert.deepEqual(types((await search('48125', buyer)).payload), ['purchase_order'])
})

test('search reads inventory from the reader\'s warehouses only', async () => {
  const east = await search('SKU-2', roleAccess('operations-specialist', ['WH-EAST']))
  assert.deepEqual(east.seen.warehouseIds, ['WH-EAST'])
  assert.ok(!types(east.payload).includes('inventory_item'))
  assert.ok(types((await search('SKU-1', roleAccess('operations-specialist', ['WH-EAST']))).payload).includes('inventory_item'))
})
