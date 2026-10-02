import assert from 'node:assert/strict'
import test from 'node:test'
import { backfillTenantAuthorization } from '../../server/auth/authorization-backfill.mjs'
import { createPrismaClient } from '../../server/persistence/prisma-client.mjs'
import { handleOutboundRoute } from '../../server/routes/outbound.routes.mjs'
import { handleSalesOrderWorkbenchRoute } from '../../server/routes/sales-order-workbench.routes.mjs'

// The sales order and shipment read routes, called as each role against
// PostgreSQL. Orders need sales_order.read and shipments need shipment.read,
// so the Procurement Specialist and the Finance Specialist, whose roles hide
// the Sales menu, cannot read customer orders, prices or shipments by URL.
// Run with: node scripts/run-postgres-test-files.mjs tests/postgres/sales-read-permissions.test.mjs

const tenantId = 'tenant-sales-read'
const users = {
  manager: { id: 'sr-manager', role: 'manager' },
  viewer: { id: 'sr-viewer', role: 'viewer' },
  buyer: { id: 'sr-buyer', role: 'buyer' },
  finance: { id: 'sr-finance', role: 'finance-specialist' },
}
const env = { ...process.env, FLOWCHAIN_PERSISTENCE_MODE: 'database', FLOWCHAIN_ENABLE_DB_OUTBOUND_POSTING: 'true', NODE_ENV: 'test' }

async function call(prisma, key, method, path) {
  let sent
  const ctx = {
    url: new URL(`http://local${path}`), req: { method, headers: {} }, res: {}, env,
    identity: { authenticated: true, tenantId, userId: users[key].id, role: users[key].role },
    outboundPrisma: prisma, readBody: async () => ({}),
    send: (_res, status, payload) => { sent = { status, body: payload } },
  }
  const handled = (await handleSalesOrderWorkbenchRoute(ctx)) || (await handleOutboundRoute(ctx))
  assert.equal(handled, true, path)
  return sent
}

test('sales order and shipment reads need sales_order.read and shipment.read', async () => {
  assert.ok(process.env.DATABASE_URL_TEST, 'An isolated test database is required')
  const prisma = await createPrismaClient(env)
  try {
    await prisma.tenant.create({ data: { id: tenantId, name: tenantId, countryCode: 'US', locale: 'en-US', currency: 'USD', timezone: 'America/New_York' } })
    for (const user of Object.values(users)) await prisma.user.create({ data: { ...user, tenantId, email: `${user.id}@sales-read.invalid`, name: user.id } })
    await backfillTenantAuthorization(prisma, tenantId, { actorId: users.manager.id })
    await prisma.item.create({ data: { id: 'SR-ITEM', tenantId, sku: 'SR-SKU', name: 'Pump', unit: 'EA' } })
    await prisma.salesOrder.create({ data: { id: 'SR-SO', tenantId, orderNumber: 'SR-SO-1', customerId: 'SR-CUST', customerName: 'Redwood Retail', workflowStatus: 'confirmed', reservationStatus: 'not_reserved', fulfillmentStatus: 'partially_fulfilled', currency: 'USD', lines: { create: { id: 'SR-SO-L1', itemId: 'SR-ITEM', sku: 'SR-SKU', itemName: 'Pump', orderedQuantity: '35.0000', fulfilledQuantity: '5.0000', unit: 'EA', unitPrice: '180.0000', amount: '6300.0000' } } } })
    await prisma.shipmentDocument.create({ data: { id: 'SR-SHIP', tenantId, shipmentNumber: 'SR-SHIP-1', salesOrderId: 'SR-SO', workflowStatus: 'ready', postingStatus: 'posted', lines: { create: { id: 'SR-SHIP-L1', salesOrderLineId: 'SR-SO-L1', itemId: 'SR-ITEM', sku: 'SR-SKU', requestedQuantity: '5.0000', postedQuantity: '5.0000', unit: 'EA' } } } })

    const orderPaths = ['/api/sales/orders', '/api/sales/order-entry-data', '/api/sales/orders/SR-SO/workbench', '/api/sales/orders/SR-SO/evidence', '/api/sales/orders/SR-SO/outbound-state']
    const shipmentPaths = ['/api/sales/shipments/SR-SHIP/workbench', '/api/sales/shipments/SR-SHIP/reconciliation', '/api/sales/shipments/SR-SHIP/posting-state']

    // The manager and the viewer hold both read permissions.
    for (const key of ['manager', 'viewer']) {
      const list = await call(prisma, key, 'GET', '/api/sales/orders')
      assert.equal(list.status, 200, key)
      assert.equal(list.body.orders[0].orderNumber, 'SR-SO-1', key)
      for (const path of [...orderPaths, ...shipmentPaths]) assert.equal((await call(prisma, key, 'GET', path)).status, 200, `${key} ${path}`)
    }

    // The buyer and the finance specialist hold neither.
    for (const key of ['buyer', 'finance']) {
      for (const path of [...orderPaths, ...shipmentPaths]) {
        const denied = await call(prisma, key, 'GET', path)
        assert.equal(denied.status, 403, `${key} ${path}`)
        assert.equal(JSON.stringify(denied.body).includes('Redwood Retail'), false, `${key} ${path}`)
      }
      // The previews read the order or shipment too.
      for (const path of ['/api/sales/orders/SR-SO/reservations/preview', '/api/sales/shipments/SR-SHIP/reverse-preview']) {
        const denied = await call(prisma, key, 'POST', path)
        assert.equal(denied.status, 403, `${key} ${path}`)
        assert.equal(JSON.stringify(denied.body).includes('SR-SO-1'), false, `${key} ${path}`)
      }
    }
  } finally {
    await prisma.$disconnect()
  }
})
