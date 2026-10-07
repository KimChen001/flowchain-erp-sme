import assert from 'node:assert/strict'
import test from 'node:test'
import { backfillTenantAuthorization } from '../../server/auth/authorization-backfill.mjs'
import { ITEM_SUPPLIER_NAMESPACE, saveItemSupplier } from '../../server/domain/master-data-commands.mjs'
import { createPrismaClient } from '../../server/persistence/prisma-client.mjs'
import { createDatabaseRepositoryRegistry } from '../../server/repositories/adapter-registry.mjs'
import { handleInventoryRoute } from '../../server/routes/inventory.routes.mjs'

// The reorder list over seeded records: stock in two warehouses, a purchase
// order line in CASE on an item kept in pcs, 8 shipment days split across the
// warehouses, a reversed shipment, an item with only a safety stock, more
// items than the read context's item list holds (an item past it with a CASE
// line), a supplier link saved with blank lead time and MOQ, and a reader
// limited to one warehouse who cannot read purchase orders.
// Run with: node scripts/run-postgres-test-files.mjs tests/postgres/reorder-list.test.mjs

const tenantId = 'tenant-reorder-list'
const users = {
  admin: { id: 'rl-admin', role: 'admin' },
  east: { id: 'rl-east', role: 'business-specialist' },
  finance: { id: 'rl-finance', role: 'finance-specialist' },
}
// Noon in New York on Oct 5: the workspace day is 2026-10-05.
const NOW = new Date('2026-10-05T16:00:00Z')

test('the reorder list ranks items by order-by day from recorded data over every warehouse', async () => {
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
      // Past the first 200 items by SKU, the read context's item list: its
      // unit is still read, so the 12 CASE below never count as pieces.
      { id: 'RL-ITEM-Z', tenantId, sku: 'ZZ-100', name: 'Late SKU', unit: 'pcs', reorderPoint: 10 },
      ...Array.from({ length: 200 }, (_, index) => ({ id: `RL-ITEM-F${index}`, tenantId, sku: `RL-F-${String(index).padStart(3, '0')}`, name: 'Filler', unit: 'pcs' })),
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
    await prisma.purchaseOrder.create({ data: { id: 'RL-PO-3', tenantId, supplierId: 'RL-SUP', supplierName: 'Reorder Supply', status: 'issued', currency: 'USD', amount: 1200, expectedDate: new Date('2026-10-09T12:00:00Z'), metadata: { orderNumber: 'PO-0041' }, lines: { create: [{ id: 'RL-PO-3-L1', itemId: 'RL-ITEM-Z', sku: 'ZZ-100', orderedQuantity: 12, receivedQuantity: 0, unit: 'CASE', unitPrice: 100, amount: 1200 }] } } })
    await prisma.inventoryBalance.create({ data: balance('RL-ITEM-Z', 'ZZ-100', 'RL-EAST', '4', '0') })
    // A link saved through the item supplier command with both fields blank:
    // stored as not recorded, never 0 days and an MOQ of 1.
    await saveItemSupplier(prisma, 'RL-ITEM-C', null, { supplierId: 'RL-SUP', preferred: true, leadTimeDays: '', minimumOrderQuantity: '' }, users.admin.id, { tenantId })
    const savedLink = await prisma.runtimeRecord.findFirst({ where: { tenantId, namespace: ITEM_SUPPLIER_NAMESPACE, recordKey: 'RL-ITEM-C::RL-SUP' } })
    assert.equal(savedLink.payload.leadTimeDays, null)
    assert.equal(savedLink.payload.minimumOrderQuantity, null)
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
    // against 20 and no shipments: order now. ZZ-100 has 4 against 10 and its
    // 12 CASE are not counted: order now. RL-B has no reorder point.
    const admin = await call('admin')
    assert.equal(admin.status, 200)
    assert.equal(admin.body.today, '2026-10-05')
    assert.deepEqual(admin.body.scope, { kind: 'all_warehouses', warehouseCount: null, totalWarehouseCount: 2 })
    assert.deepEqual(admin.body.rows.map((row) => [row.sku, row.orderByDate, row.orderNow]), [['RL-C', '2026-10-05', true], ['ZZ-100', '2026-10-05', true], ['RL-A', '2026-11-11', false]])
    const z = admin.body.rows.find((row) => row.sku === 'ZZ-100')
    assert.deepEqual([z.onHand, z.incoming, z.position, z.shortfall], [4, 0, 4, 6])
    assert.deepEqual(z.flags, [{ code: 'po_line_other_unit', orderNumber: 'PO-0041', unit: 'CASE' }])
    const a = admin.body.rows.find((row) => row.sku === 'RL-A')
    assert.deepEqual([a.onHand, a.reserved, a.incoming, a.position, a.reorderPoint, a.shortfall], [110, 10, 30, 130, 100, 0])
    assert.deepEqual([a.demand.averageDailyDemand, a.demand.shipmentDays, a.demand.shippedQuantity], [0.8, 8, 72])
    assert.deepEqual(a.flags, [{ code: 'po_line_other_unit', orderNumber: 'PO-0040', unit: 'CASE' }])
    assert.deepEqual(a.incomingLines, [{ orderNumber: 'PO-0039', remaining: 30, dueDay: '2026-10-08', counted: true }])
    assert.deepEqual(a.supplier, { id: 'RL-SUP', code: 'RLS', name: 'Reorder Supply', leadTimeDays: 10, minimumOrderQuantity: null, moqUnit: 'pcs' })
    const c = admin.body.rows.find((row) => row.sku === 'RL-C')
    assert.equal(c.demand.enough, false)
    assert.equal(c.demand.shipmentDays, 0)
    assert.deepEqual(c.purchaseRequest, { itemId: 'RL-ITEM-C', supplierId: 'RL-SUP', quantity: 15 })
    assert.deepEqual([c.supplier.leadTimeDays, c.supplier.minimumOrderQuantity], [null, null])
    // 201 items without a reorder point: the first 50 by SKU are named.
    assert.equal(admin.body.noReorderPoint.count, 201)
    assert.equal(admin.body.noReorderPoint.items.length, 50)
    assert.deepEqual(admin.body.noReorderPoint.items[0], { itemId: 'RL-ITEM-B', sku: 'RL-B', itemName: 'Gasket' })
    assert.ok(admin.body.dataLimitations.includes('transfers_not_considered'))
    // The read context's item list was cut at 200; the reorder list reads its
    // own items, so that is not reported as a gap in the list.
    assert.deepEqual(admin.body.truncatedSubjects, [])
    // The balance rows' reorder point (40, as the balances fill it from safety
    // stock) is never used.
    assert.ok(!admin.body.rows.some((row) => row.sku === 'RL-B'))

    // The East reader sees one of two warehouses. The reorder point is one
    // figure for the whole item, and the 30 incoming name no warehouse: East's
    // 60 on hand, 10 reserved and every incoming line set against 100 would
    // say "order 20" for stock the company does not need. So no item is
    // checked for this reader, and no quantity or order number is shown.
    const east = await call('east')
    assert.equal(east.status, 200)
    assert.deepEqual(east.body.scope, { kind: 'reader_warehouses', warehouseCount: 1, totalWarehouseCount: 2 })
    assert.deepEqual(east.body.rows, [])
    assert.deepEqual(east.body.notJudged.map((row) => [row.sku, row.reason]), [['RL-A', 'warehouse_scope'], ['RL-C', 'warehouse_scope'], ['ZZ-100', 'warehouse_scope']])
    assert.equal(JSON.stringify(east.body).includes('PO-00'), false)
    assert.equal(JSON.stringify(east.body).includes('onHand'), false)

    // A role without inventory.balance.read gets 403.
    assert.equal((await call('finance')).status, 403)
  } finally {
    await prisma.$disconnect()
  }
})
