import assert from 'node:assert/strict'
import test from 'node:test'
import { backfillTenantAuthorization } from '../../server/auth/authorization-backfill.mjs'
import { CUSTOMER_NAMESPACE } from '../../server/domain/master-data-commands.mjs'
import { createPrismaClient } from '../../server/persistence/prisma-client.mjs'
import { handleOperationalFinanceRoute } from '../../server/routes/operational-finance.routes.mjs'
import { handleSalesOrderWorkbenchRoute } from '../../server/routes/sales-order-workbench.routes.mjs'

// Design audit batch A4: the entry forms reached only the first rows of a list.
// - L4-01: the sales order form listed the first 200 active items; the 201st
//   could not be ordered. It now searches items on the server.
// - L2-12: the supplier invoice form saw the newest 100 orders; an older one
//   could not be billed from its page (?po=).
// - V-B-03 / L4-19: the customer invoice form read the first 2,000 customer
//   rows, unordered, so a customer past them had no payment terms.
// Run with: node scripts/run-postgres-test-files.mjs tests/postgres/entry-picker-reach.test.mjs

const tenantId = 'tenant-entry-reach'
const admin = { id: 'er-admin', role: 'admin' }
const env = { ...process.env, FLOWCHAIN_PERSISTENCE_MODE: 'database', FLOWCHAIN_ENABLE_DB_OUTBOUND_POSTING: 'true', FLOWCHAIN_ENABLE_DB_OPERATIONAL_FINANCE: 'true', NODE_ENV: 'test' }
const identity = { authenticated: true, tenantId, userId: admin.id, role: admin.role }

async function call(prisma, path) {
  let sent
  const ctx = {
    url: new URL(`http://local${path}`), req: { method: 'GET', headers: {} }, res: {}, env, identity,
    outboundPrisma: prisma, operationalFinancePrisma: prisma, readBody: async () => ({}),
    send: (_res, status, payload) => { sent = { status, body: payload } },
  }
  const handled = (await handleSalesOrderWorkbenchRoute(ctx)) || (await handleOperationalFinanceRoute(ctx))
  assert.equal(handled, true, path)
  return sent
}

const pad = (n) => String(n).padStart(4, '0')

test('the entry forms reach the 201st item, the 101st order and the 2,001st customer', async () => {
  assert.ok(process.env.DATABASE_URL_TEST, 'An isolated test database is required')
  const prisma = await createPrismaClient(env)
  try {
    await prisma.tenant.create({ data: { id: tenantId, name: tenantId, countryCode: 'US', locale: 'en-US', currency: 'USD', timezone: 'America/New_York' } })
    await prisma.user.create({ data: { ...admin, tenantId, email: `${admin.id}@entry-reach.invalid`, name: admin.id } })
    await backfillTenantAuthorization(prisma, tenantId, { actorId: admin.id })

    // L4-01: 201 active items; the 201st by SKU is past the old 200.
    await prisma.item.createMany({ data: Array.from({ length: 201 }, (_, index) => ({ id: `ER-ITEM-${pad(index + 1)}`, tenantId, sku: `ER-${pad(index + 1)}`, name: `Widget ${pad(index + 1)}`, unit: 'EA', status: 'active' })) })
    const first = await call(prisma, '/api/sales/order-entry-data')
    assert.equal(first.status, 200)
    assert.equal(first.body.itemsMore, true)
    assert.ok(!first.body.items.some((item) => item.sku === 'ER-0201'), 'the first page stops short')
    const found = await call(prisma, '/api/sales/order-entry-data?view=items&itemQuery=er-0201')
    assert.deepEqual(found.body.items.map((item) => item.sku), ['ER-0201'])
    assert.equal(found.body.customers, undefined, 'the item search leaves customers out')
    const byName = await call(prisma, '/api/sales/order-entry-data?view=items&itemQuery=Widget%200201')
    assert.deepEqual(byName.body.items.map((item) => item.id), ['ER-ITEM-0201'])
    // A draft's own item comes with the entry data, whatever its place.
    const draft = await call(prisma, '/api/sales/order-entry-data?itemIds=ER-ITEM-0201')
    assert.ok(draft.body.items.some((item) => item.id === 'ER-ITEM-0201'))

    // L2-12: 101 orders of one supplier; the oldest is past the newest 100.
    await prisma.supplier.create({ data: { id: 'ER-SUP', tenantId, code: 'ER-SUP', name: 'Harbor Supply', status: 'active' } })
    const day = (n) => new Date(Date.UTC(2026, 0, 1) + n * 3_600_000)
    for (let index = 1; index <= 101; index += 1) {
      await prisma.purchaseOrder.create({ data: { id: `ER-PO-${pad(index)}`, tenantId, number: `PO-ER-${pad(index)}`, status: 'approved', supplierId: 'ER-SUP', supplierName: 'Harbor Supply', currency: 'USD', amount: '10.0000', createdAt: day(index), lines: { create: { id: `ER-POL-${pad(index)}`, itemId: 'ER-ITEM-0001', sku: 'ER-0001', itemName: 'Widget 0001', orderedQuantity: '1.0000', receivedQuantity: '0.0000', unit: 'EA', unitPrice: '10.0000' } } } })
    }
    const newest = await call(prisma, '/api/finance/entry-data')
    assert.ok(!newest.body.purchaseOrders.some((order) => order.id === 'ER-PO-0001'), 'the newest 100 leave the oldest out')
    for (const po of ['ER-PO-0001', 'PO-ER-0001']) {
      const opened = await call(prisma, `/api/finance/entry-data?po=${po}`)
      assert.equal(opened.status, 200)
      assert.ok(opened.body.purchaseOrders.some((order) => order.id === 'ER-PO-0001'), `?po=${po}`)
      assert.ok(opened.body.suppliers.some((supplier) => supplier.id === 'ER-SUP'))
    }
    const bySupplier = await call(prisma, '/api/finance/entry-data?supplier=ER-SUP')
    assert.equal(bySupplier.body.purchaseOrders.length, 100)
    assert.ok(bySupplier.body.purchaseOrders.every((order) => order.supplierId === 'ER-SUP'))

    // V-B-03: 2,001 customers on NET 30; the invoice for the 2,001st has its terms.
    await prisma.paymentTerm.create({ data: { id: 'ER-NET30', tenantId, code: 'NET30', name: 'Net 30', days: 30 } })
    await prisma.runtimeRecord.createMany({ data: Array.from({ length: 2001 }, (_, index) => ({ id: `ER-CUST-ROW-${pad(index + 1)}`, tenantId, namespace: CUSTOMER_NAMESPACE, recordKey: `CUST-${pad(index + 1)}`, payload: { id: `ER-CUST-${pad(index + 1)}`, code: `CUST-${pad(index + 1)}`, name: `Customer ${pad(index + 1)}`, status: 'active', paymentTerms: 'NET30' } })) })
    const last = 'ER-CUST-2001'
    await prisma.salesOrder.create({ data: { id: 'ER-SO', tenantId, orderNumber: 'SO-ER-1', customerId: last, customerName: 'Customer 2001', workflowStatus: 'confirmed', reservationStatus: 'not_reserved', fulfillmentStatus: 'partially_fulfilled', currency: 'USD', lines: { create: { id: 'ER-SO-L1', itemId: 'ER-ITEM-0001', sku: 'ER-0001', itemName: 'Widget 0001', orderedQuantity: '3.0000', fulfilledQuantity: '2.0000', unit: 'EA', unitPrice: '5.0000', amount: '15.0000' } } } })
    await prisma.shipmentDocument.create({ data: { id: 'ER-SHIP', tenantId, shipmentNumber: 'DN-ER-1', salesOrderId: 'ER-SO', workflowStatus: 'ready', postingStatus: 'posted', postedAt: new Date(), lines: { create: { id: 'ER-SHIP-L1', salesOrderLineId: 'ER-SO-L1', itemId: 'ER-ITEM-0001', sku: 'ER-0001', requestedQuantity: '2.0000', postedQuantity: '2.0000', unit: 'EA' } } } })
    const invoiceEntry = await call(prisma, '/api/finance/entry-data?salesOrder=ER-SO')
    assert.equal(invoiceEntry.status, 200)
    const [shipment] = invoiceEntry.body.postedShipments
    assert.equal(shipment?.id, 'ER-SHIP')
    assert.deepEqual(shipment.customerPaymentTerm, { code: 'NET30', name: 'Net 30', days: 30 })
  } finally {
    await prisma.$disconnect()
  }
})
