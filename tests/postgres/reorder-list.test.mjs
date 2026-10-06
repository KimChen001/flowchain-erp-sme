import assert from 'node:assert/strict'
import test from 'node:test'
import { backfillTenantAuthorization } from '../../server/auth/authorization-backfill.mjs'
import { ITEM_SUPPLIER_NAMESPACE } from '../../server/domain/master-data-commands.mjs'
import { createPrismaClient } from '../../server/persistence/prisma-client.mjs'
import { createDatabaseRepositoryRegistry } from '../../server/repositories/adapter-registry.mjs'
import { handleInventoryRoute } from '../../server/routes/inventory.routes.mjs'

// The reorder list over seeded records: stock in two warehouses, a purchase
// order line in CASE on an item kept in pcs, 8 shipment days split across the
// warehouses, a reversed shipment, an item with only a safety stock, and a
// reader limited to one warehouse who cannot read purchase orders.
// Run with: node scripts/run-postgres-test-files.mjs tests/postgres/reorder-list.test.mjs

const tenantId = 'tenant-reorder-list'
const users = {
  admin: { id: 'rl-admin', role: 'admin' },
  east: { id: 'rl-east', role: 'business-specialist' },
  finance: { id: 'rl-finance', role: 'finance-specialist' },
}
// Noon in New York on Oct 5: the workspace day is 2026-10-05.
const NOW = new Date('2026-10-05T16:00:00Z')

test('the reorder list ranks items by order-by day from recorded data, in the reader\'s warehouses', async () => {
  assert.ok(process.env.DATABASE_URL_TEST, 'An isolated test database is required')
  const env = { ...process.env, FLOWCHAIN_PERSISTENCE_MODE: 'database', NODE_ENV: 'test' }
  const prisma = await createPrismaClient(env)
  try {
    await prisma.tenant.create({ data: { id: tenantId, name: tenantId, countryCode: 'US', locale: 'en-US', currency: 'USD', timezone: 'America/New_York' } })
    for (const code of ['RL-EAST', 'RL-WEST']) await prisma.warehouse.create({ data: { id: code, tenantId, code, name: code, status: 'active' } })
    for (const user of Object.values(users)) await prisma.user.create({ data: { ...user, tenantId, email: `${user.id}@reorder-list.invalid`, name: user.id } })
    await backfillTenantAuthorization(prisma, tenantId, { actorId: users.admin.id })
    await prisma.userWarehouseScope.create({ data: { id: 'rl-east-scope', tenantId, userId: users.east.id, warehouseId: 'RL-EAST', accessLevel: 'operate' } })
    await prisma.supplier.create({ data: { id: 'RL-SUP', tenantId, code: 'RLS', name: 'Reorder Supply', status: 'active' } })
    await prisma.item.createMany({ data: [
      { id: 'RL-ITEM-A', tenantId, sku: 'RL-A', name: 'Valve', unit: 'pcs', reorderPoint: 100, preferredSupplierId: 'RL-SUP' },
      // Only a safety stock: no reorder point is recorded, so it is not judged.
      { id: 'RL-ITEM-B', tenantId, sku: 'RL-B', name: 'Gasket', unit: 'pcs', safetyStock: 40 },
      { id: 'RL-ITEM-C', tenantId, sku: 'RL-C', name: 'Seal', unit: 'pcs', reorderPoint: 20 },
    ] })
    await prisma.runtimeRecord.create({ data: { id: 'rl-link-a', tenantId, namespace: ITEM_SUPPLIER_NAMESPACE, recordKey: 'RL-ITEM-A:RL-SUP', payload: { itemId: 'RL-ITEM-A', supplierId: 'RL-SUP', preferred: true, active: true, approved: true, leadTimeDays: 10 } } })
    const balance = (itemId, sku, warehouseId, onHand, reserved) => ({ id: `rl-bal-${sku}-${warehouseId}`, tenantId, itemId, sku, itemName: sku, warehouseId, warehouseKey: warehouseId, location: 'A-01', locationKey: 'a-01', onHandQuantity: onHand, reservedQuantity: reserved, availableQuantity: String(Number(onHand) - Number(reserved)), unit: 'pcs', status: 'available', safetyStock: '40', reorderPoint: '40' })
    await prisma.inventoryBalance.createMany({ data: [
      balance('RL-ITEM-A', 'RL-A', 'RL-EAST', '60', '10'),
      balance('RL-ITEM-A', 'RL-A', 'RL-WEST', '50', '0'),
      balance('RL-ITEM-B', 'RL-B', 'RL-EAST', '1', '0'),
      balance('RL-ITEM-C', 'RL-C', 'RL-EAST', '5', '0'),
    ] })
    // 30 pcs due Oct 8 count; 5 CASE are another unit and never count.
    await prisma.purchaseOrder.create({ data: { id: 'RL-PO-1', tenantId, supplierId: 'RL-SUP', supplierName: 'Reorder Supply', status: 'issued', currency: 'USD', amount: 300, expectedDate: new Date('2026-10-08T12:00:00Z'), metadata: { orderNumber: 'PO-0039' }, lines: { create: [{ id: 'RL-PO-1-L1', itemId: 'RL-ITEM-A', sku: 'RL-A', orderedQuantity: 30, receivedQuantity: 0, unit: 'pcs', unitPrice: 10, amount: 300 }] } } })
    await prisma.purchaseOrder.create({ data: { id: 'RL-PO-2', tenantId, supplierId: 'RL-SUP', supplierName: 'Reorder Supply', status: 'issued', currency: 'USD', amount: 500, expectedDate: new Date('2026-10-09T12:00:00Z'), metadata: { orderNumber: 'PO-0040' }, lines: { create: [{ id: 'RL-PO-2-L1', itemId: 'RL-ITEM-A', sku: 'RL-A', orderedQuantity: 5, receivedQuantity: 0, unit: 'CASE', unitPrice: 100, amount: 500 }] } } })

    // Posted shipments of 9 pcs of RL-A on Sep 20 to Sep 27, the first four
    // from East and the rest from West, and a reversed shipment of 500 on Sep 28.
    const ship = async (n, day, warehouseId, quantity, postingStatus = 'posted') => {
      await prisma.salesOrder.create({ data: { id: `RL-SO-${n}`, tenantId, orderNumber: `RL-SO-${n}`, customerName: 'Customer', workflowStatus: postingStatus === 'posted' ? 'confirmed' : 'cancelled', currency: 'USD', lines: { create: [{ id: `RL-SOL-${n}`, itemId: 'RL-ITEM-A', sku: 'RL-A', itemName: 'Valve', orderedQuantity: quantity, fulfilledQuantity: postingStatus === 'posted' ? quantity : 0, unit: 'pcs' }] } } })
      await prisma.inventoryReservation.create({ data: { id: `RL-RES-${n}`, tenantId, salesOrderId: `RL-SO-${n}`, salesOrderLineId: `RL-SOL-${n}`, itemId: 'RL-ITEM-A', sku: 'RL-A', warehouseId, reservedQuantity: quantity, consumedQuantity: quantity, status: 'consumed', reservedById: users.admin.id } })
      await prisma.shipmentDocument.create({ data: { id: `RL-SHIP-${n}`, tenantId, shipmentNumber: `RL-SHIP-${n}`, salesOrderId: `RL-SO-${n}`, workflowStatus: 'ready', postingStatus, postedAt: new Date(`${day}T15:00:00Z`), reversedAt: postingStatus === 'reversed' ? new Date(`${day}T18:00:00Z`) : null, lines: { create: [{ id: `RL-SHIPL-${n}`, salesOrderLineId: `RL-SOL-${n}`, itemId: 'RL-ITEM-A', sku: 'RL-A', requestedQuantity: quantity, postedQuantity: quantity, unit: 'pcs' }] } } })
      await prisma.shipmentAllocation.create({ data: { id: `RL-ALLOC-${n}`, tenantId, shipmentLineId: `RL-SHIPL-${n}`, reservationId: `RL-RES-${n}`, warehouseId, quantity, status: 'consumed' } })
    }
    for (let n = 1; n <= 8; n += 1) await ship(n, `2026-09-${String(19 + n).padStart(2, '0')}`, n <= 4 ? 'RL-EAST' : 'RL-WEST', 9)
    await ship(9, '2026-09-28', 'RL-EAST', 500, 'reversed')

    const repositories = createDatabaseRepositoryRegistry({ env, prisma })
    const call = async (key, path = '/api/inventory/reorder-list') => {
      let sent
      const ctx = {
        url: new URL(`http://local${path}`), req: { method: 'GET', headers: {} }, res: {}, env, repositories, inventoryPrisma: prisma, reorderListNow: NOW,
        identity: { authenticated: true, tenantId, userId: users[key].id, role: users[key].role, source: 'signed-session' },
        send: (_res, status, payload) => { sent = { status, body: JSON.parse(JSON.stringify(payload ?? null)) } },
      }
      assert.equal(await handleInventoryRoute(ctx), true, path)
      return sent
    }

    // The administrator: every warehouse. RL-A has 110 on hand, 10 reserved and
    // 30 incoming = 130 against 100. 72 shipped over 8 days in the 90 days
    // before Oct 5 (the reversed 500 is not demand): 0.8 a day, so
    // (130 - 100) / 0.8 = 37.5 days, order by Oct 5 + 37 = Nov 11. RL-C has 5
    // against 20 and no shipments: order now. RL-B has no reorder point.
    const admin = await call('admin')
    assert.equal(admin.status, 200)
    assert.equal(admin.body.today, '2026-10-05')
    assert.deepEqual(admin.body.scope, { kind: 'all_warehouses', warehouseCount: null })
    assert.deepEqual(admin.body.rows.map((row) => [row.sku, row.orderByDate, row.orderNow]), [['RL-C', '2026-10-05', true], ['RL-A', '2026-11-11', false]])
    const a = admin.body.rows.find((row) => row.sku === 'RL-A')
    assert.deepEqual([a.onHand, a.reserved, a.incoming, a.position, a.reorderPoint, a.shortfall], [110, 10, 30, 130, 100, 0])
    assert.deepEqual([a.demand.averageDailyDemand, a.demand.shipmentDays, a.demand.shippedQuantity], [0.8, 8, 72])
    assert.deepEqual(a.flags, [{ code: 'po_line_other_unit', orderNumber: 'PO-0040', unit: 'CASE' }])
    assert.deepEqual(a.incomingLines, [{ orderNumber: 'PO-0039', remaining: 30, dueDay: '2026-10-08', counted: true }])
    assert.deepEqual(a.supplier, { id: 'RL-SUP', code: 'RLS', name: 'Reorder Supply', leadTimeDays: 10, minimumOrderQuantity: null })
    const c = admin.body.rows.find((row) => row.sku === 'RL-C')
    assert.equal(c.demand.enough, false)
    assert.equal(c.demand.shipmentDays, 0)
    assert.deepEqual(c.purchaseRequest, { itemId: 'RL-ITEM-C', supplierId: null, quantity: 15 })
    assert.deepEqual(admin.body.noReorderPoint, { count: 1, href: '/app/master-data/items' })
    assert.ok(admin.body.dataLimitations.includes('transfers_not_considered'))
    // The balance rows' reorder point (40, as the balances fill it from safety
    // stock) is never used.
    assert.ok(!admin.body.rows.some((row) => row.sku === 'RL-B'))

    // The East reader: 60 on hand, 10 reserved, 30 incoming = 80 at or below
    // 100, order now for 20. Only 4 shipment days are East's. Purchase order
    // numbers are hidden from a reader without purchase order access.
    const east = await call('east')
    assert.equal(east.status, 200)
    assert.deepEqual(east.body.scope, { kind: 'reader_warehouses', warehouseCount: 1 })
    const eastA = east.body.rows.find((row) => row.sku === 'RL-A')
    assert.deepEqual([eastA.onHand, eastA.position, eastA.orderNow, eastA.shortfall], [60, 80, true, 20])
    assert.deepEqual([eastA.demand.shipmentDays, eastA.demand.shippedQuantity, eastA.demand.enough], [4, 36, false])
    assert.deepEqual(eastA.flags.find((flag) => flag.code === 'po_line_other_unit'), { code: 'po_line_other_unit', orderNumber: null, unit: 'CASE' })
    assert.equal(JSON.stringify(east.body).includes('PO-00'), false)
    assert.deepEqual(eastA.purchaseRequest, { itemId: 'RL-ITEM-A', supplierId: 'RL-SUP', quantity: 20 })

    // A role without inventory.balance.read gets 403.
    assert.equal((await call('finance')).status, 403)
  } finally {
    await prisma.$disconnect()
  }
})
