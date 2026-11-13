import test from 'node:test'
import assert from 'node:assert/strict'
import { createInventoryAuthoritativeReadService } from './inventory-authoritative-read-service.mjs'

// The movement list (/app/inventory/movements) shows one page of tens of
// thousands of movements. Its type and warehouse menus come from the server
// over every movement in the list's context, and each movement names its
// source document by number (a shipment showed "—", a filter showed UUIDs).

const TENANT = 'tenant-movements'
const identity = { authenticated: true, tenantId: TENANT, userId: 'user-1', role: 'manager' }
const user = {
  id: 'user-1', tenantId: TENANT, role: 'manager', status: 'active', rolesAssignedAt: new Date('2026-11-01T00:00:00Z'),
  warehouseScopes: [{ warehouseId: 'WH-1', accessLevel: 'read' }],
  roleAssignments: [{ status: 'active', role: { id: 'role-1', roleKey: 'viewer', name: 'Viewer', status: 'active', permissions: [{ permissionCode: 'inventory.balance.read' }] } }],
}
const SHIPMENT = '29f1f302-4f05-4336-862e-d7189ba4472d'
const ADJUSTMENT = 'd5f1c8c1-5fa5-47fa-9587-184a569fd46b'
const at = new Date('2026-11-06T21:00:00Z')
const movement = (id, fields) => ({ id, tenantId: TENANT, sku: 'SKU-1', itemName: 'Item 1', warehouseId: 'WH-1', location: 'A-01', locationKey: 'a-01', quantityIn: '0', quantityOut: '0', adjustmentQty: '0', unit: 'pcs', status: 'posted', occurredAt: at, ...fields })
const rows = [
  movement('M-1', { movementType: 'shipment_posting', sourceDocumentType: 'ShipmentDocument', sourceDocumentId: SHIPMENT, relatedSalesOrderId: 'SO-ID-1', postingBatchId: 'f8889883-3416-4d47-b026-c43c0f9d6e07', quantityOut: '2' }),
  movement('M-2', { movementType: 'receipt_posting', sourceDocumentType: 'receiving_document', sourceDocumentId: 'GRN-ID-1', relatedGrnId: 'GRN-ID-1', quantityIn: '16' }),
  movement('M-3', { movementType: 'inventory_adjustment', reason: 'opening_balance', sourceDocumentType: 'InventoryAdjustmentDocument', sourceDocumentId: ADJUSTMENT, quantityIn: '91' }),
  movement('M-4', { movementType: 'inventory_adjustment', sourceDocumentType: 'import_batch', sourceDocumentId: '0b6b0e8e-9a2d-4c1e-8f3c-6a1d2b3c4d5e', sourceDocument: 'OPENING-2026', quantityIn: '5' }),
  movement('M-5', { movementType: 'shipment_posting', sourceDocumentType: 'ShipmentDocument', sourceDocumentId: '7c9e6679-7425-40de-944b-e07fc1f90ae7', sourceDocument: '7c9e6679-7425-40de-944b-e07fc1f90ae7', quantityOut: '1' }),
]

function fakePrisma() {
  const calls = { findMany: [], groupBy: [], lookups: [] }
  const lookup = (model, records) => ({ findMany: async (args) => { calls.lookups.push([model, args]); return records.filter((record) => args.where.id.in.includes(record.id)) } })
  return {
    calls,
    user: { findFirst: async () => structuredClone(user) },
    inventoryMovement: {
      count: async () => 60688,
      findMany: async (args) => { calls.findMany.push(args); return structuredClone(rows) },
      groupBy: async (args) => {
        calls.groupBy.push(args)
        return [
          { movementType: 'shipment_posting', warehouseId: 'WH-1', _count: { _all: 54927 } },
          { movementType: 'receipt_posting', warehouseId: 'WH-1', _count: { _all: 5565 } },
          { movementType: 'inventory_adjustment', warehouseId: 'WH-1', _count: { _all: 196 } },
        ]
      },
    },
    shipmentDocument: lookup('shipmentDocument', [{ id: SHIPMENT, shipmentNumber: 'DN-202611-0006' }]),
    receivingDocument: lookup('receivingDocument', [{ id: 'GRN-ID-1', documentNumber: 'GRN-202611-0005' }]),
    inventoryAdjustmentDocument: lookup('inventoryAdjustmentDocument', [{ id: ADJUSTMENT, adjustmentNumber: 'ADJ-202511-0001' }]),
    salesOrder: lookup('salesOrder', [{ id: 'SO-ID-1', orderNumber: 'SO-202611-0006' }]),
  }
}

test('each movement names its source document and sales order by number', async () => {
  const prisma = fakePrisma()
  const result = await createInventoryAuthoritativeReadService({ prisma }).listMovements({ pageSize: '200' }, { identity })
  const byId = Object.fromEntries(result.movements.map((row) => [row.movementId, row]))
  assert.equal(byId['M-1'].sourceDocumentNumber, 'DN-202611-0006')
  assert.equal(byId['M-1'].relatedSalesOrderNumber, 'SO-202611-0006')
  assert.equal(byId['M-2'].sourceDocumentNumber, 'GRN-202611-0005')
  assert.equal(byId['M-3'].sourceDocumentNumber, 'ADJ-202511-0001')
  // No document to look up: a recorded reference that is not an internal id stays.
  assert.equal(byId['M-4'].sourceDocumentNumber, 'OPENING-2026')
  // A document that cannot be found and an internal id as the reference: none.
  assert.equal(byId['M-5'].sourceDocumentNumber, null)
  assert.equal(byId['M-2'].relatedSalesOrderNumber, null)
  // One read per document type, for the page shown, in this tenant.
  for (const [, args] of prisma.calls.lookups) assert.equal(args.where.tenantId, TENANT)
  assert.deepEqual(prisma.calls.lookups.map(([model]) => model).sort(), ['inventoryAdjustmentDocument', 'receivingDocument', 'salesOrder', 'shipmentDocument'])
})

test('the type and warehouse menus cover every movement in the context, not the page', async () => {
  const prisma = fakePrisma()
  const result = await createInventoryAuthoritativeReadService({ prisma }).listMovements({ pageSize: '200', movementType: 'receipt_posting', warehouseId: 'WH-1', q: 'SKU', relatedSalesOrderId: 'SO-ID-1' }, { identity })
  assert.equal(result.total, 60688)
  assert.deepEqual(result.facets.movementTypes, [
    { code: 'shipment_posting', count: 54927 },
    { code: 'receipt_posting', count: 5565 },
    { code: 'inventory_adjustment', count: 196 },
  ])
  assert.deepEqual(result.facets.warehouseIds, ['WH-1'])
  // The page is filtered by the person's choices; the menus only by the context the list was opened with.
  const pageWhere = JSON.stringify(prisma.calls.findMany[0].where)
  assert.match(pageWhere, /"movementType":"receipt_posting"/)
  assert.match(pageWhere, /"relatedSalesOrderId":"SO-ID-1"/)
  const facetWhere = JSON.stringify(prisma.calls.groupBy[0].where)
  assert.doesNotMatch(facetWhere, /movementType|"warehouseId":"WH-1"|insensitive/)
  assert.match(facetWhere, /"relatedSalesOrderId":"SO-ID-1"/)
  // Still only the warehouses the user may read.
  assert.match(facetWhere, /"warehouseId":\{"in":\["WH-1"\]\}/)
  assert.equal(prisma.calls.groupBy[0].where.tenantId, TENANT)
})
