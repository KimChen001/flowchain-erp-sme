import assert from 'node:assert/strict'
import test from 'node:test'
import { backfillTenantAuthorization } from '../../server/auth/authorization-backfill.mjs'
import { createOperationalFinanceReadService } from '../../server/domain/operational-finance-read-service.mjs'
import { createReceivingDraftCommandService } from '../../server/domain/receiving-draft-command-service.mjs'
import { createSalesOrderReadService } from '../../server/domain/sales-order-workbench-service.mjs'
import { createPrismaClient } from '../../server/persistence/prisma-client.mjs'
import { createDatabaseRepositoryRegistry } from '../../server/repositories/adapter-registry.mjs'
import { getDirectProcurementDocument } from '../../server/repositories/db-procurement-read-repository.mjs'

// Prisma passes search text to PostgreSQL as a LIKE / ILIKE pattern, so an
// unescaped "%" matched every row and "_" any one character. Searches now
// look for that text as typed.
// Run with: node scripts/run-postgres-test-files.mjs tests/postgres/search-wildcards.test.mjs

const tenantId = 'tenant-search-wildcards'
const identity = { authenticated: true, tenantId, userId: 'sw-manager', role: 'manager' }

async function seed(prisma) {
  await prisma.tenant.create({ data: { id: tenantId, name: 'Search wildcards', countryCode: 'US', locale: 'en-US', currency: 'USD', timezone: 'America/New_York' } })
  await prisma.user.create({ data: { id: identity.userId, tenantId, email: 'sw-manager@search-wildcards.invalid', name: 'Search Manager', role: 'manager' } })
  await backfillTenantAuthorization(prisma, tenantId, { actorId: identity.userId })
  await prisma.item.create({ data: { id: 'SW-ITEM', tenantId, sku: 'SW-SKU', name: 'Pump', unit: 'EA' } })
  for (const [id, customerName] of [['SW-SO-1', 'Redwood Retail'], ['SW-SO-2', 'Harbor Foods']]) {
    await prisma.salesOrder.create({ data: { id, tenantId, orderNumber: id, customerId: `${id}-CUST`, customerName, workflowStatus: 'confirmed', reservationStatus: 'not_reserved', fulfillmentStatus: 'not_fulfilled', currency: 'USD', lines: { create: { id: `${id}-L1`, itemId: 'SW-ITEM', sku: 'SW-SKU', itemName: 'Pump', orderedQuantity: '10.0000', unit: 'EA', unitPrice: '50.0000', amount: '500.0000' } } } })
  }
  await prisma.purchaseOrder.create({ data: { id: 'SW-PO-1', tenantId, supplierName: 'Northwind Parts', status: 'issued' } })
  await prisma.supplierInvoice.create({ data: { id: 'SW-INV-1', tenantId, invoiceNumber: 'SW-INV-1', supplierName: 'Northwind Parts' } })
}

test('a "%" or "_" search finds nothing, and a normal search still finds its record', async () => {
  assert.ok(process.env.DATABASE_URL_TEST, 'An isolated test database is required')
  const prisma = await createPrismaClient(process.env)
  try {
    await seed(prisma)

    // Sales orders, as the sales-demand routes and the assistant read them.
    const salesOrders = createDatabaseRepositoryRegistry({ env: process.env, prisma }).salesOrders
    const orderIds = async (filters) => (await salesOrders.listOrders({ tenantId, ...filters })).map((order) => order.id).sort()
    assert.deepEqual(await orderIds({}), ['SW-SO-1', 'SW-SO-2'])
    assert.deepEqual(await orderIds({ q: '%' }), [])
    assert.deepEqual(await orderIds({ q: '_' }), [])
    assert.deepEqual(await orderIds({ search: '%' }), [])
    assert.deepEqual(await orderIds({ q: 'redwood' }), ['SW-SO-1'])
    assert.deepEqual(await orderIds({ q: 'sw-so-2' }), ['SW-SO-2'])

    // The sales order list on the Sales page.
    const workbench = createSalesOrderReadService({ prisma })
    const workbenchIds = async (query) => (await workbench.listOrders(query, identity)).orders.map((order) => order.id).sort()
    assert.deepEqual(await workbenchIds({ search: '%' }), [])
    assert.deepEqual(await workbenchIds({ search: '_' }), [])
    assert.deepEqual(await workbenchIds({ customer: '%' }), [])
    assert.deepEqual(await workbenchIds({ search: 'Harbor' }), ['SW-SO-2'])
    assert.deepEqual(await workbenchIds({ customer: 'redwood' }), ['SW-SO-1'])

    // Supplier invoices.
    const finance = createOperationalFinanceReadService({ prisma })
    const invoiceIds = async (search) => (await finance.listSupplierInvoices({ search }, identity)).items.map((invoice) => invoice.id)
    assert.deepEqual(await invoiceIds('%'), [])
    assert.deepEqual(await invoiceIds('_'), [])
    assert.deepEqual(await invoiceIds('northwind'), ['SW-INV-1'])

    // Purchase orders open for receiving.
    const receiving = createReceivingDraftCommandService({ prisma })
    const receivableIds = async (search) => (await receiving.listReceivablePurchaseOrders({ search }, identity)).items.map((po) => po.id)
    assert.deepEqual(await receivableIds('%'), [])
    assert.deepEqual(await receivableIds('_'), [])
    assert.deepEqual(await receivableIds('sw-po'), ['SW-PO-1'])

    // A procurement document opened by id matches that id only, in any case.
    assert.equal(await getDirectProcurementDocument(prisma, 'po', '%', tenantId), null)
    assert.equal(await getDirectProcurementDocument(prisma, 'po', 'SW-PO_1', tenantId), null)
    assert.equal((await getDirectProcurementDocument(prisma, 'po', 'sw-po-1', tenantId))?.id, 'SW-PO-1')
  } finally {
    await prisma.$disconnect()
  }
})
