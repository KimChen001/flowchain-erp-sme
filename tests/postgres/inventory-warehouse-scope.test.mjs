import assert from 'node:assert/strict'
import test from 'node:test'
import { backfillTenantAuthorization } from '../../server/auth/authorization-backfill.mjs'
import { createPrismaClient } from '../../server/persistence/prisma-client.mjs'
import { createDatabaseRepositoryRegistry } from '../../server/repositories/adapter-registry.mjs'
import { handleInventoryRoute } from '../../server/routes/inventory.routes.mjs'
import { handleInventoryMovementsRoute } from '../../server/routes/inventory-movements.routes.mjs'
import { handleReportsAnalyticsRoute } from '../../server/routes/reports-analytics.routes.mjs'

// Inventory reads follow the reader's permission and warehouse scope on every
// route, not only on the balances screen: the item list, item detail, lots,
// serials, exceptions, summary, availability, shortages, the movement list and
// the inventory report. A reader limited to one warehouse sees that
// warehouse's stock; a role without inventory.balance.read gets 403.
// Run with: node scripts/run-postgres-test-files.mjs tests/postgres/inventory-warehouse-scope.test.mjs

const tenantId = 'tenant-inventory-scope'
const users = {
  admin: { id: 'is-admin', role: 'admin' },
  east: { id: 'is-east', role: 'business-specialist' },
  finance: { id: 'is-finance', role: 'finance-specialist' },
}

test('inventory reads are limited to the reader\'s warehouses and permission', async () => {
  assert.ok(process.env.DATABASE_URL_TEST, 'An isolated test database is required')
  const env = { ...process.env, FLOWCHAIN_PERSISTENCE_MODE: 'database', NODE_ENV: 'test' }
  const prisma = await createPrismaClient(env)
  try {
    await prisma.tenant.create({ data: { id: tenantId, name: tenantId, countryCode: 'US', locale: 'en-US', currency: 'USD', timezone: 'America/New_York' } })
    for (const [code, name] of [['IS-EAST', 'East'], ['IS-WEST', 'West']]) await prisma.warehouse.create({ data: { id: code, tenantId, code, name, status: 'active' } })
    for (const user of Object.values(users)) await prisma.user.create({ data: { ...user, tenantId, email: `${user.id}@inventory-scope.invalid`, name: user.id } })
    await backfillTenantAuthorization(prisma, tenantId, { actorId: users.admin.id })
    await prisma.userWarehouseScope.create({ data: { id: 'is-east-scope', tenantId, userId: users.east.id, warehouseId: 'IS-EAST', accessLevel: 'operate' } })
    await prisma.item.create({ data: { id: 'IS-ITEM', tenantId, sku: 'IS-SKU', name: 'Valve', unit: 'EA' } })
    for (const [warehouseId, onHand] of [['IS-EAST', '150'], ['IS-WEST', '999']]) {
      await prisma.inventoryBalance.create({ data: { id: `is-balance-${warehouseId}`, tenantId, itemId: 'IS-ITEM', sku: 'IS-SKU', itemName: 'Valve', warehouseId, warehouseKey: warehouseId, location: 'A-01', locationKey: 'a-01', onHandQuantity: onHand, reservedQuantity: '0', availableQuantity: onHand, unit: 'EA', status: 'available' } })
      await prisma.inventoryMovement.create({ data: { id: `is-move-${warehouseId}`, tenantId, itemId: 'IS-ITEM', sku: 'IS-SKU', itemName: 'Valve', warehouseId, location: 'A-01', locationKey: 'a-01', movementType: 'receipt', movementDate: new Date(), occurredAt: new Date(), sourceDocument: `GRN-${warehouseId}`, quantityIn: onHand, quantityOut: '0', adjustmentQty: '0', status: 'posted', unit: 'EA' } })
    }
    const repositories = createDatabaseRepositoryRegistry({ env, prisma })
    const call = async (handler, key, path, method = 'GET') => {
      let sent
      const ctx = {
        url: new URL(`http://local${path}`), req: { method, headers: {} }, res: {}, env, repositories, inventoryPrisma: prisma,
        identity: { authenticated: true, tenantId, userId: users[key].id, role: users[key].role, source: 'signed-session' },
        send: (_res, status, payload) => { sent = { status, body: JSON.parse(JSON.stringify(payload ?? null)) } },
      }
      // The movements route returns what send returns rather than true.
      assert.notEqual(await handler(ctx), false, path)
      assert.ok(sent, path)
      return sent
    }
    const onHand = (items) => items.filter((row) => row.sku === 'IS-SKU').reduce((sum, row) => sum + Number(row.onHandQuantity ?? row.currentStock ?? row.onHand ?? 0), 0)

    // The administrator holds every warehouse.
    const adminItems = await call(handleInventoryRoute, 'admin', '/api/inventory/items')
    assert.equal(adminItems.status, 200)
    assert.equal(onHand(adminItems.body.items), 1149)
    assert.equal((await call(handleInventoryRoute, 'admin', '/api/inventory/availability/IS-SKU')).body.availability.onHand, 1149)

    // The East reader sees East only, on every route.
    const items = await call(handleInventoryRoute, 'east', '/api/inventory/items')
    assert.equal(items.status, 200)
    assert.equal(onHand(items.body.items), 150)
    assert.equal(JSON.stringify(items.body).includes('999'), false)
    const availability = await call(handleInventoryRoute, 'east', '/api/inventory/availability/IS-SKU')
    assert.equal(availability.body.availability.onHand, 150)
    const all = await call(handleInventoryRoute, 'east', '/api/inventory/availability')
    assert.ok(all.body.dataLimitations.includes('inventory_scoped_to_reader_warehouses'))
    const detail = await call(handleInventoryRoute, 'east', '/api/inventory/items/IS-SKU')
    assert.equal(detail.status, 200)
    assert.equal(JSON.stringify(detail.body).includes('IS-WEST'), false)
    const movements = await call(handleInventoryMovementsRoute, 'east', '/api/inventory-movements')
    assert.equal(movements.status, 200)
    assert.deepEqual(JSON.stringify(movements.body).includes('GRN-IS-WEST'), false)
    assert.ok(JSON.stringify(movements.body).includes('GRN-IS-EAST'))
    const report = await call(handleReportsAnalyticsRoute, 'east', '/api/reports/inventory')
    assert.equal(report.status, 200)
    assert.equal(report.body.kpis.find((kpi) => kpi.id === 'inventory_on_hand').currentValue, 150)

    // The finance specialist has no inventory.balance.read.
    for (const path of ['/api/inventory/items', '/api/inventory/items/IS-SKU', '/api/inventory/lots', '/api/inventory/serials', '/api/inventory/exceptions', '/api/inventory/summary', '/api/inventory/availability', '/api/inventory/shortages']) {
      const denied = await call(handleInventoryRoute, 'finance', path)
      assert.equal(denied.status, 403, path)
    }
    assert.equal((await call(handleInventoryMovementsRoute, 'finance', '/api/inventory-movements')).status, 403)
    const financeReport = await call(handleReportsAnalyticsRoute, 'finance', '/api/reports/inventory')
    assert.equal(financeReport.body.kpis.find((kpi) => kpi.id === 'inventory_on_hand').dataStatus, 'restricted')
    assert.equal(JSON.stringify(financeReport.body).includes('1149'), false)
  } finally {
    await prisma.$disconnect()
  }
})
