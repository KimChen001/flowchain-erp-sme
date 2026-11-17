import assert from 'node:assert/strict'
import test from 'node:test'
import { backfillTenantAuthorization } from '../../server/auth/authorization-backfill.mjs'
import { createPrismaClient } from '../../server/persistence/prisma-client.mjs'
import { createDatabaseRepositoryRegistry } from '../../server/repositories/adapter-registry.mjs'
import { handleInventoryRoute } from '../../server/routes/inventory.routes.mjs'
import { handleReportsAnalyticsRoute } from '../../server/routes/reports-analytics.routes.mjs'

// Design audit 2026-11-15, L15 "fails first": the allocation model and the
// reorder list read stock, demand and incoming from SQL aggregates over every
// record, not from the read context's first 500 balance rows and latest 500
// purchase orders. Past 500 an item lost its stock (listed as stock_incomplete,
// or read as 0 when its balance row was cut) and an older open purchase order
// dropped out of incoming.
// Run with: node scripts/run-postgres-test-files.mjs tests/postgres/allocation-aggregated-inputs.test.mjs

// Noon in New York on Oct 5: the workspace day is 2026-10-05.
const NOW = new Date('2026-10-05T16:00:00Z')
const pad = (n) => String(n).padStart(4, '0')
const range = (count) => Array.from({ length: count }, (_, index) => index + 1)

async function seedTenant(prisma, tenantId, warehouses = ['WH-1']) {
  await prisma.tenant.create({ data: { id: tenantId, name: tenantId, countryCode: 'US', locale: 'en-US', currency: 'USD', timezone: 'America/New_York' } })
  for (const code of warehouses) await prisma.warehouse.create({ data: { id: `${tenantId}-${code}`, tenantId, code, name: code, status: 'active' } })
  const admin = { id: `${tenantId}-admin`, role: 'admin' }
  await prisma.user.create({ data: { ...admin, tenantId, email: `${admin.id}@allocation-inputs.invalid`, name: admin.id } })
  await backfillTenantAuthorization(prisma, tenantId, { actorId: admin.id })
  return admin
}

function caller(prisma, tenantId, user, handler = handleInventoryRoute) {
  const env = { ...process.env, FLOWCHAIN_PERSISTENCE_MODE: 'database', NODE_ENV: 'test' }
  const repositories = createDatabaseRepositoryRegistry({ env, prisma })
  return async (path) => {
    let sent
    const ctx = {
      url: new URL(`http://local${path}`), req: { method: 'GET', headers: {} }, res: {}, env, repositories, inventoryPrisma: prisma, reorderListNow: NOW, reportNow: NOW,
      identity: { authenticated: true, tenantId, userId: user.id, role: user.role, source: 'signed-session' },
      send: (_res, status, payload) => { sent = { status, body: JSON.parse(JSON.stringify(payload ?? null)) } },
    }
    assert.equal(await handler(ctx), true, path)
    assert.equal(sent.status, 200, path)
    return sent.body
  }
}

const balance = (tenantId, sku, itemId, warehouse, onHand) => ({
  id: `${tenantId}-bal-${sku}-${warehouse}`, tenantId, itemId, sku, itemName: sku, warehouseId: `${tenantId}-${warehouse}`, warehouseKey: `${tenantId}-${warehouse}`,
  location: 'A-01', locationKey: 'a-01', onHandQuantity: String(onHand), reservedQuantity: '0', availableQuantity: String(onHand), unit: 'pcs', status: 'available',
})

test('with 501 balance rows no item is stock_incomplete and every balance is counted', async () => {
  assert.ok(process.env.DATABASE_URL_TEST, 'An isolated test database is required')
  const prisma = await createPrismaClient(process.env)
  try {
    // 501 items, one balance row each. Odd items hold 3 against a reorder
    // point of 5 (order now), even items 9 (above it, no shipments).
    const tenantId = 'tenant-allocation-501-balances'
    const admin = await seedTenant(prisma, tenantId)
    const onHandOf = (n) => (n % 2 ? 3 : 9)
    await prisma.item.createMany({ data: range(501).map((n) => ({ id: `${tenantId}-ITEM-${pad(n)}`, tenantId, sku: `A-${pad(n)}`, name: `Item ${pad(n)}`, unit: 'pcs', reorderPoint: 5 })) })
    await prisma.inventoryBalance.createMany({ data: range(501).map((n) => balance(tenantId, `A-${pad(n)}`, `${tenantId}-ITEM-${pad(n)}`, 'WH-1', onHandOf(n))) })
    const call = caller(prisma, tenantId, admin)

    const list = await call('/api/inventory/reorder-list')
    assert.deepEqual(list.notJudged.filter((row) => row.reason === 'stock_incomplete').map((row) => row.sku), [])
    assert.deepEqual([list.summary.listed, list.summary.orderNow, list.summary.aboveReorderPointWithoutHistory, list.summary.notJudged], [251, 251, 250, 0])
    assert.ok(list.rows.some((row) => row.sku === 'A-0501' && row.onHand === 3 && row.orderNow))
    assert.deepEqual(list.truncatedSubjects, [])

    const allocation = await call('/api/inventory/availability')
    const onHand = new Map(allocation.availability.map((row) => [row.sku, row.onHand]))
    assert.equal(onHand.size, 501)
    for (const n of range(501)) assert.equal(onHand.get(`A-${pad(n)}`), onHandOf(n), `A-${pad(n)}`)
    assert.equal(allocation.availability.reduce((sum, row) => sum + row.onHand, 0), range(501).reduce((sum, n) => sum + onHandOf(n), 0))
    assert.equal(allocation.summary.stockStatusCounts.unknown, 0)

    // Stock in two warehouses: B-0001 in one (1 row), B-0002 to B-0250 in
    // both (498 rows), and B-0251 in both: its rows are the 500th and 501st by
    // SKU. B-0251 holds 25 + 15 = 40 against a reorder point of 30; with
    // either row left out it would be listed to order now.
    const tenantB = 'tenant-allocation-501-two-warehouses'
    const adminB = await seedTenant(prisma, tenantB, ['WH-1', 'WH-2'])
    await prisma.item.createMany({ data: range(251).map((n) => ({ id: `${tenantB}-ITEM-${pad(n)}`, tenantId: tenantB, sku: `B-${pad(n)}`, name: `Item ${pad(n)}`, unit: 'pcs', reorderPoint: n === 251 ? 30 : 10 })) })
    const rowB = (n, warehouse, onHand) => balance(tenantB, `B-${pad(n)}`, `${tenantB}-ITEM-${pad(n)}`, warehouse, onHand)
    await prisma.inventoryBalance.createMany({ data: [
      rowB(1, 'WH-1', 13),
      ...range(250).slice(1).flatMap((n) => [rowB(n, 'WH-1', 7), rowB(n, 'WH-2', 6)]),
      rowB(251, 'WH-1', 25),
      rowB(251, 'WH-2', 15),
    ] })
    assert.equal(await prisma.inventoryBalance.count({ where: { tenantId: tenantB } }), 501)
    const callB = caller(prisma, tenantB, adminB)
    const listB = await callB('/api/inventory/reorder-list')
    assert.deepEqual(listB.notJudged, [])
    assert.deepEqual(listB.rows, [], 'every item holds more than its reorder point')
    const allocationB = await callB('/api/inventory/availability')
    const onHandB = new Map(allocationB.availability.map((row) => [row.sku, row.onHand]))
    assert.equal(onHandB.get('B-0251'), 40)
    for (const n of range(250)) assert.equal(onHandB.get(`B-${pad(n)}`), 13, `B-${pad(n)}`)
    assert.equal(allocationB.availability.reduce((sum, row) => sum + row.onHand, 0), 250 * 13 + 40)
  } finally {
    await prisma.$disconnect()
  }
})

test('the 501st open purchase order counts toward incoming, and a late one is flagged', async () => {
  assert.ok(process.env.DATABASE_URL_TEST, 'An isolated test database is required')
  const prisma = await createPrismaClient(process.env)
  try {
    // One item with nothing on hand and 501 issued purchase orders of 1 pcs
    // each. The oldest change is PO 0001, due Sep 1: past its due day, it
    // still counts (#249) and is flagged late. The rest are due Dec 1.
    const tenantId = 'tenant-allocation-501-open-pos'
    const admin = await seedTenant(prisma, tenantId)
    const itemId = `${tenantId}-ITEM`
    await prisma.item.create({ data: { id: itemId, tenantId, sku: 'C-1', name: 'Bearing', unit: 'pcs', reorderPoint: 600 } })
    await prisma.inventoryBalance.create({ data: balance(tenantId, 'C-1', itemId, 'WH-1', 0) })
    const day = (n) => new Date(Date.UTC(2026, 7, 1, 0, n))
    await prisma.purchaseOrder.createMany({ data: range(501).map((n) => ({
      id: `${tenantId}-PO-${pad(n)}`, tenantId, number: `PO-202608-${pad(n)}`, status: 'issued', currency: 'USD',
      expectedDate: new Date(n === 1 ? '2026-09-01T12:00:00Z' : '2026-12-01T12:00:00Z'), createdAt: day(n), updatedAt: day(n),
    })) })
    await prisma.purchaseOrderLine.createMany({ data: range(501).map((n) => ({ id: `${tenantId}-PO-${pad(n)}-L1`, purchaseOrderId: `${tenantId}-PO-${pad(n)}`, itemId, sku: 'C-1', itemName: 'Bearing', orderedQuantity: 1, receivedQuantity: 0, unit: 'pcs' })) })
    const call = caller(prisma, tenantId, admin)

    const allocation = await call('/api/inventory/availability/C-1')
    assert.equal(allocation.availability.incomingApprovedPo, 501)
    assert.equal(allocation.availability.incomingLines.length, 501)
    assert.ok(allocation.availability.purchaseOrderIds.includes(`${tenantId}-PO-0001`))

    const list = await call('/api/inventory/reorder-list')
    const row = list.rows.find((entry) => entry.sku === 'C-1')
    assert.deepEqual([row.onHand, row.incoming, row.position, row.reorderPoint, row.shortfall, row.orderNow], [0, 501, 501, 600, 99, true])
    assert.deepEqual(row.flags, [{ code: 'po_line_late', orderNumber: 'PO-202608-0001', dueDay: '2026-09-01' }])
    assert.deepEqual(list.truncatedSubjects, [])

    // The inventory report counts the same 501 orders in transit and, like the
    // reorder list, names no cut: its stock figures read every order, not the
    // latest 500. The overview still names purchase orders at 500: its order
    // amount, open orders card and table count the orders read.
    const report = caller(prisma, tenantId, admin, handleReportsAnalyticsRoute)
    const inventory = await report('/api/reports/inventory')
    assert.equal(inventory.details.find((entry) => entry.id === 'C-1').availableToPromise, 501)
    assert.deepEqual(inventory.truncatedSubjects, [])
    const overview = await report('/api/reports/overview')
    assert.deepEqual(overview.truncatedSubjects, [{ subject: 'purchase_orders', limit: 500 }])
  } finally {
    await prisma.$disconnect()
  }
})
