import test from 'node:test'
import assert from 'node:assert/strict'
import { createPrismaClient } from '../../server/persistence/prisma-client.mjs'
import { MASTER_DATA_LIST_LIMIT, createDbMasterDataRepository } from '../../server/repositories/db-master-data-repository.mjs'
import { backfillTenantAuthorization } from '../../server/auth/authorization-backfill.mjs'
import { createInventoryAuthoritativeReadService } from '../../server/domain/inventory-authoritative-read-service.mjs'

// A workspace with more records than one list read used to return: 520 items
// and 520 customers. Every one can be opened by its key and found by a search,
// and the master data pages list them all.
const tenantId = 'every-record-t1'
const pad = (n) => String(n).padStart(4, '0')
const COUNT = 520

test('master data lookups and lists reach every record, and movements are searched on the server', async () => {
  const prisma = await createPrismaClient(process.env)
  try {
    await prisma.tenant.create({ data: { id: tenantId, name: 'Every record workspace' } })
    await prisma.item.createMany({ data: Array.from({ length: COUNT }, (_, index) => ({ id: `ER-ITEM-${pad(index + 1)}`, tenantId, sku: `ER-${pad(index + 1)}`, name: `Every record item ${pad(index + 1)}`, unit: 'pcs' })) })
    await prisma.supplier.create({ data: { id: 'ER-SUP-1', tenantId, code: 'ER-S1', name: 'Every Record Supplies' } })
    await prisma.runtimeRecord.createMany({
      data: Array.from({ length: COUNT }, (_, index) => {
        const code = `CUST-${pad(index + 1)}`
        return { id: `ER-CUS-${pad(index + 1)}`, tenantId, namespace: 'master-data.customers', recordKey: code, payload: { id: `ER-CUS-${pad(index + 1)}`, code, name: `Customer ${pad(index + 1)}`, status: 'active' } }
      }),
    })
    const repository = createDbMasterDataRepository({ prisma, env: process.env })
    const scope = { tenantId }

    // Lookups by id, SKU or code, or name, ignoring case, past the 500th record.
    assert.equal((await repository.getItem('er-0510', scope))?.sku, 'ER-0510')
    assert.equal((await repository.getItem('ER-ITEM-0519', scope))?.sku, 'ER-0519')
    assert.equal((await repository.getItem('every record item 0515', scope))?.sku, 'ER-0515')
    assert.equal(await repository.getItem('ER-9999', scope), null)
    assert.equal((await repository.getSupplier('er-s1', scope))?.name, 'Every Record Supplies')
    assert.equal((await repository.getCustomer('cust-0510', scope))?.code, 'CUST-0510')
    assert.equal((await repository.getCustomer('ER-CUS-0517', scope))?.code, 'CUST-0517')
    assert.equal((await repository.getCustomer('customer 0512', scope))?.code, 'CUST-0512')
    assert.equal(await repository.getCustomer('CUST-9999', scope), null)
    // A key is matched as typed: _ is not a wildcard.
    assert.equal(await repository.getItem('ER-05_0', scope), null)
    assert.equal(await repository.getSupplier('ER-S_', scope), null)
    assert.equal(await repository.getCustomer('CUST-05_0', scope), null)
    // Another workspace's records are never found.
    assert.equal(await repository.getItem('ER-0510', { tenantId: 'every-record-other' }), null)

    // A read without a limit keeps 200 and says it was cut; the pages ask for every record.
    const cut = []
    assert.equal((await repository.listCustomers({ ...scope, onTruncated: (entry) => cut.push(entry.subject) })).length, 200)
    assert.deepEqual(cut, ['customers'])
    assert.equal((await repository.listCustomers({ ...scope, limit: MASTER_DATA_LIST_LIMIT })).length, COUNT)
    assert.equal((await repository.listItems({ ...scope, limit: MASTER_DATA_LIST_LIMIT })).length, COUNT)
    // A search looks at every customer, not the first 200.
    assert.deepEqual((await repository.listCustomers({ ...scope, query: '0515' })).map((row) => row.code), ['CUST-0515'])

    // Movements: the search runs in the database, so the page's one page of
    // results holds every match.
    const warehouse = await prisma.warehouse.create({ data: { id: 'ER-WH-1', tenantId, code: 'ER-WH', name: 'Every record warehouse' } })
    const admin = await prisma.user.create({ data: { id: 'ER-ADMIN', tenantId, email: 'admin@every-record.invalid', name: 'Admin', role: 'admin', status: 'active', defaultWarehouseId: warehouse.id } })
    await backfillTenantAuthorization(prisma, tenantId, { actorId: admin.id })
    await prisma.inventoryMovement.createMany({
      data: Array.from({ length: 60 }, (_, index) => ({
        id: `ER-MOV-${pad(index + 1)}`, tenantId, itemId: `ER-ITEM-${pad(index + 1)}`, sku: `ER-${pad(index + 1)}`, itemName: `Every record item ${pad(index + 1)}`,
        warehouseId: warehouse.id, location: 'A-01', locationKey: 'a-01', movementType: 'shipment_posting', movementLabel: 'Shipment posting',
        sourceDocumentType: 'ShipmentDocument', sourceDocumentId: `ER-DN-${pad(index + 1)}`, quantityIn: '0', quantityOut: '1', adjustmentQty: '-1', status: 'posted', unit: 'pcs',
      })),
    })
    const inventory = createInventoryAuthoritativeReadService({ prisma })
    const identity = { identity: { authenticated: true, tenantId, userId: admin.id, role: 'admin', name: 'Admin' } }
    const firstPage = await inventory.listMovements({}, identity)
    assert.equal(firstPage.total, 60)
    assert.equal(firstPage.movements.length, 50)
    const searched = await inventory.listMovements({ q: 'er-0007' }, identity)
    assert.deepEqual(searched.movements.map((row) => row.sku), ['ER-0007'])
    assert.equal(searched.total, 1)
    assert.equal((await inventory.listMovements({ q: 'every record item 005' }, identity)).total, 10)
    assert.equal((await inventory.listMovements({ q: 'er-dn-0060' }, identity)).total, 1)
    assert.equal((await inventory.listMovements({ q: '%' }, identity)).total, 0)
    assert.equal((await inventory.listMovements({ q: 'ER-00_1' }, identity)).total, 0)
  } finally {
    await prisma.$disconnect()
  }
})
