import assert from 'node:assert/strict'
import test from 'node:test'
import { backfillTenantAuthorization } from '../../server/auth/authorization-backfill.mjs'
import { ITEM_SUPPLIER_NAMESPACE } from '../../server/domain/master-data-commands.mjs'
import { createPrismaClient } from '../../server/persistence/prisma-client.mjs'
import { createDatabaseRepositoryRegistry } from '../../server/repositories/adapter-registry.mjs'
import { handleProcurementWorkflowRoute } from '../../server/routes/procurement-workflow.routes.mjs'

// GET /api/procurement/orders/:id/document against PostgreSQL, as each role.
// It answers exactly as the PO detail does: another workspace's PO is not
// found, a role without PO read is refused, and a role without prices gets a
// document marked not printable with no prices. The document never carries
// the supplier's tax or bank details, and never fills in the currency or
// payment terms the supplier master view defaults to (USD, NET30).
// Run with: node scripts/run-postgres-test-files.mjs tests/postgres/business-documents.test.mjs

const tenantId = 'tenant-po-document'
const otherTenantId = 'tenant-po-document-other'
const users = {
  admin: { id: 'pd-admin', role: 'admin' },
  viewer: { id: 'pd-viewer', role: 'viewer' },
  finance: { id: 'pd-finance', role: 'finance-specialist' },
}
const env = { ...process.env, FLOWCHAIN_PERSISTENCE_MODE: 'database', NODE_ENV: 'test' }

test('the PO document reads as the PO detail does and prints only what is recorded', async () => {
  assert.ok(process.env.DATABASE_URL_TEST, 'An isolated test database is required')
  const prisma = await createPrismaClient(env)
  try {
    await prisma.tenant.create({ data: { id: tenantId, name: 'Harbor Goods', legalName: 'Harbor Goods LLC', countryCode: 'US', locale: 'en-US', currency: 'USD', timezone: 'America/New_York', operationalSettings: { documents: { documentLanguage: 'en-US', letterhead: { addressLines: ['12 Pier Road', 'Oakland, CA 94607'] }, purchaseOrder: { termsText: 'Deliver to the dock between 8am and 4pm.' } } } } })
    await prisma.tenant.create({ data: { id: otherTenantId, name: 'Other Goods', countryCode: 'US', locale: 'en-US', currency: 'USD', timezone: 'America/New_York' } })
    for (const user of Object.values(users)) await prisma.user.create({ data: { ...user, tenantId, email: `${user.id}@po-document.invalid`, name: user.id } })
    await backfillTenantAuthorization(prisma, tenantId, { actorId: users.admin.id })
    await prisma.warehouse.create({ data: { id: 'PD-WH', tenantId, code: 'OAK', name: 'Oakland DC', status: 'active' } })
    // Contact details and tax and bank details recorded; no currency and no payment terms.
    await prisma.supplier.create({ data: { id: 'PD-SUP', tenantId, code: 'HARBOR', name: 'Harbor Supply', metadata: { contactName: 'Dana Ruiz', email: 'orders@harbor.invalid', address: '1 Wharf St', taxIdentificationNumber: 'TAX-998877', bankName: 'Coastal Bank', bankAccountName: 'Harbor Supply Inc', bankAccountNumber: '000111222333', creditCode: 'CC-4455' } } })
    await prisma.item.create({ data: { id: 'PD-ITEM', tenantId, sku: 'VAL-10', name: 'Brass valve', unit: 'EA' } })
    await prisma.runtimeRecord.create({ data: { id: 'ISR-PD-1', tenantId, namespace: ITEM_SUPPLIER_NAMESPACE, recordKey: 'PD-ITEM::PD-SUP', payload: { itemId: 'PD-ITEM', supplierId: 'PD-SUP', supplierSku: 'HS-VAL-10', active: true, approved: true, version: 1 } } })
    await prisma.purchaseOrder.create({ data: { id: 'PD-PO', tenantId, status: 'approved', supplierId: 'PD-SUP', supplierName: 'Harbor Supply', currency: 'EUR', amount: '1001.2340', expectedDate: new Date('2026-11-03T12:00:00Z'), metadata: { orderNumber: 'PO-2026-0077', targetWarehouseId: 'PD-WH' }, lines: { create: { id: 'PD-POL', itemId: 'PD-ITEM', sku: 'VAL-10', itemName: 'Brass valve', orderedQuantity: '10.0000', receivedQuantity: '0.0000', unit: 'EA', unitPrice: '100.1234', amount: '1001.2340', metadata: { requestedDate: '2026-11-01' } } } } })
    await prisma.purchaseOrder.create({ data: { id: 'PD-PO-DRAFT', tenantId, status: 'draft', supplierId: 'PD-SUP', supplierName: 'Harbor Supply', currency: 'EUR', amount: '5.0000' } })
    await prisma.purchaseOrder.create({ data: { id: 'PD-PO-OTHER', tenantId: otherTenantId, status: 'approved', supplierName: 'Elsewhere Ltd', currency: 'USD', amount: '9.0000' } })

    const repositories = createDatabaseRepositoryRegistry({ env, prisma })
    const call = async (key, path) => {
      let sent
      const ctx = {
        url: new URL(`http://local${path}`), req: { method: 'GET', headers: {} }, res: {}, env, repositories,
        identity: { authenticated: true, tenantId, userId: users[key].id, role: users[key].role, source: 'signed-session' },
        readBody: async () => ({}),
        send: (_res, status, payload) => { sent = { status, body: payload } },
      }
      assert.equal(await handleProcurementWorkflowRoute(ctx), true, path)
      return sent
    }

    const { status, body } = await call('admin', '/api/procurement/orders/PD-PO/document')
    assert.equal(status, 200)
    const document = body.document
    assert.deepEqual(document.printable, { ok: true, reason: null })
    assert.deepEqual([document.number, document.status, document.currency, document.expectedDate], ['PO-2026-0077', 'approved', 'EUR', '2026-11-03'])
    assert.deepEqual(document.buyer, { companyName: 'Harbor Goods LLC', addressLines: ['12 Pier Road', 'Oakland, CA 94607'], phone: null, email: null, taxId: null })
    assert.deepEqual(document.supplier, { name: 'Harbor Supply', code: 'HARBOR', contactName: 'Dana Ruiz', email: 'orders@harbor.invalid', telephone: null, address: '1 Wharf St', postalCode: null })
    assert.deepEqual(document.shipTo, { code: 'OAK', name: 'Oakland DC' })
    assert.deepEqual(document.lines.map((line) => [line.sku, line.supplierSku, line.quantity, line.unit, line.unitPrice, line.amount, line.requestedDate]), [['VAL-10', 'HS-VAL-10', '10.0000', 'EA', '100.1234', '1001.2340', '2026-11-01']])
    assert.deepEqual(document.totals, [{ currency: 'EUR', amount: '1001.2340' }])
    assert.equal(document.termsText, 'Deliver to the dock between 8am and 4pm.')
    const serialized = JSON.stringify(body)
    for (const value of ['TAX-998877', 'Coastal Bank', 'Harbor Supply Inc', '000111222333', 'CC-4455', 'NET30', '"USD"']) assert.equal(serialized.includes(value), false, value)

    // Not printable before approval.
    assert.deepEqual((await call('admin', '/api/procurement/orders/PD-PO-DRAFT/document')).body.document.printable, { ok: false, reason: 'status' })
    // Another workspace's PO is not found, and nothing about it comes back.
    const other = await call('admin', '/api/procurement/orders/PD-PO-OTHER/document')
    assert.deepEqual([other.status, other.body.code], [404, 'PURCHASE_ORDER_NOT_FOUND'])
    assert.equal(JSON.stringify(other.body).includes('Elsewhere'), false)
    // The read-only viewer reads POs but not prices: no prices, not printable.
    const viewer = await call('viewer', '/api/procurement/orders/PD-PO/document')
    assert.equal(viewer.status, 200)
    assert.deepEqual(viewer.body.document.printable, { ok: false, reason: 'prices_hidden' })
    assert.deepEqual(viewer.body.document.totals, [{ currency: 'EUR', amount: null }])
    assert.deepEqual(viewer.body.document.lines.map((line) => [line.unitPrice, line.amount]), [[null, null]])
    assert.equal(JSON.stringify(viewer.body).includes('1001.2340'), false)
    // The finance specialist cannot read POs at all, here or on the detail.
    for (const path of ['/api/procurement/orders/PD-PO/document', '/api/procurement/orders/PD-PO']) {
      const denied = await call('finance', path)
      assert.equal(denied.status, 403, path)
      assert.equal(JSON.stringify(denied.body).includes('Harbor'), false, path)
    }
  } finally {
    await prisma.$disconnect()
  }
})
