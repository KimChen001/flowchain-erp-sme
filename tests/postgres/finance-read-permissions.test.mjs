import assert from 'node:assert/strict'
import test from 'node:test'
import { backfillTenantAuthorization } from '../../server/auth/authorization-backfill.mjs'
import { createOperationalFinanceCommandService } from '../../server/domain/operational-finance-command-service.mjs'
import { createPrismaClient } from '../../server/persistence/prisma-client.mjs'
import { handleOperationalFinanceRoute } from '../../server/routes/operational-finance.routes.mjs'

// The finance read routes, called as each role against PostgreSQL. Every read
// needs the record's own read permission (403 otherwise), and inside a readable
// record the amounts need finance.amounts.read and the supplier needs
// finance.partner_snapshot.read: on the header, on every invoice line, match
// line and match exception, and in the supplier snapshot. A hidden value is
// null, never 0. Entry data hides PO prices without procurement.prices.read.
// Run with: node scripts/run-postgres-test-files.mjs tests/postgres/finance-read-permissions.test.mjs

const tenantId = 'tenant-finance-read'
const users = {
  admin: { id: 'fr-admin', role: 'admin' },
  finance: { id: 'fr-finance', role: 'finance-specialist' },
  viewer: { id: 'fr-viewer', role: 'viewer' },
  buyer: { id: 'fr-buyer', role: 'buyer' },
  specialist: { id: 'fr-specialist', role: 'business-specialist' },
}
const env = { ...process.env, FLOWCHAIN_PERSISTENCE_MODE: 'database', FLOWCHAIN_ENABLE_DB_OPERATIONAL_FINANCE: 'true', NODE_ENV: 'test' }
const identityOf = (key) => ({ authenticated: true, tenantId, userId: users[key].id, role: users[key].role })

async function call(prisma, key, path) {
  let sent
  const ctx = {
    url: new URL(`http://local${path}`), req: { method: 'GET', headers: {} }, res: {}, env,
    identity: identityOf(key), operationalFinancePrisma: prisma,
    send: (_res, status, payload) => { sent = { status, body: payload } },
  }
  assert.equal(await handleOperationalFinanceRoute(ctx), true)
  return sent
}

test('finance reads check the read permission and hide amounts and suppliers by role', async () => {
  assert.ok(process.env.DATABASE_URL_TEST, 'An isolated test database is required')
  const prisma = await createPrismaClient(env)
  const command = createOperationalFinanceCommandService({ prisma, env })
  try {
    await prisma.tenant.create({ data: { id: tenantId, name: tenantId, countryCode: 'US', locale: 'en-US', currency: 'USD', timezone: 'America/New_York', operationalSettings: { review: { quantityTolerance: '0.0000', pricePercentageTolerance: '0.0000', priceAbsoluteTolerance: '0.0000', amountTolerance: '0.0000' } } } })
    for (const user of Object.values(users)) await prisma.user.create({ data: { ...user, tenantId, email: `${user.id}@finance-read.invalid`, name: user.id } })
    await backfillTenantAuthorization(prisma, tenantId, { actorId: users.admin.id })
    await prisma.supplier.create({ data: { id: 'FR-SUP', tenantId, code: 'FR-SUP', name: 'Harbor Supply' } })
    await prisma.item.create({ data: { id: 'FR-ITEM', tenantId, sku: 'FR-SKU', name: 'Valve', unit: 'EA' } })
    await prisma.warehouse.create({ data: { id: 'FR-WH', tenantId, code: 'FR-WH', name: 'Main' } })
    await prisma.purchaseOrder.create({ data: { id: 'FR-PO', tenantId, status: 'approved', supplierId: 'FR-SUP', supplierName: 'Harbor Supply', currency: 'USD', amount: '100.0000', lines: { create: { id: 'FR-POL', itemId: 'FR-ITEM', sku: 'FR-SKU', itemName: 'Valve', orderedQuantity: '10.0000', receivedQuantity: '10.0000', unit: 'EA', unitPrice: '10.0000' } } } })
    await prisma.receivingDocument.create({ data: { id: 'FR-GRN', tenantId, documentNumber: 'FR-GRN', poId: 'FR-PO', supplierId: 'FR-SUP', supplierName: 'Harbor Supply', status: 'received', workflowStatus: 'posted', postingStatus: 'posted', postedAt: new Date(), postedById: users.admin.id, warehouseId: 'FR-WH', currency: 'USD', lines: { create: { id: 'FR-GRNL', purchaseOrderLineId: 'FR-POL', itemId: 'FR-ITEM', sku: 'FR-SKU', itemName: 'Valve', acceptedQty: '10.0000', rejectedQty: '0.0000', unit: 'EA', warehouseId: 'FR-WH', location: 'A-01', locationKey: 'a-01' } } } })

    // An overcharged invoice: 10 x 13.50 against a PO price of 10, so the match
    // raises a price exception and an amount exception.
    const admin = { identity: identityOf('admin') }
    const invoice = await command.createSupplierInvoice({ invoiceNumber: 'FR-INV-1', supplierId: 'FR-SUP', currency: 'USD', invoiceDate: '2026-09-01', dueDate: '2026-10-01', totalAmount: '144.0000', idempotencyKey: 'fr-create', lines: [{ purchaseOrderLineId: 'FR-POL', receivingLineId: 'FR-GRNL', quantity: '10.0000', unitPrice: '13.5000', lineAmount: '135.0000', enteredTaxAmount: '9.0000' }] }, admin)
    await command.submitSupplierInvoice(invoice.entityId, { expectedVersion: 0, idempotencyKey: 'fr-submit' }, admin)
    await command.matchSupplierInvoice(invoice.entityId, { expectedVersion: 1, idempotencyKey: 'fr-match' }, admin)
    const detailPath = `/api/finance/supplier-invoices/${invoice.entityId}`

    // The finance specialist sees everything.
    const full = await call(prisma, 'finance', detailPath)
    assert.equal(full.status, 200)
    assert.equal(Number(full.body.totalAmount), 144)
    assert.equal(full.body.supplierName, 'Harbor Supply')
    assert.equal(Number(full.body.lines[0].unitPrice), 13.5)
    assert.equal(Number(full.body.match.lines[0].poUnitPrice), 10)
    assert.ok(full.body.match.exceptions.some((entry) => entry.exceptionType === 'price' && Number(entry.actualValue) === 13.5))

    // The viewer reads the invoice but no amount or supplier, at any depth.
    const viewer = await call(prisma, 'viewer', detailPath)
    assert.equal(viewer.status, 200)
    assert.equal(viewer.body.invoiceNumber, 'FR-INV-1')
    assert.equal(viewer.body.totalAmount, null)
    assert.equal(viewer.body.supplierName, null)
    assert.equal(viewer.body.supplierSnapshot, null)
    assert.equal(viewer.body.fieldVisibility.totalAmount.visible, false)
    for (const line of viewer.body.lines) for (const key of ['unitPrice', 'lineAmount', 'enteredTaxAmount', 'totalAmount']) assert.equal(line[key], null, `invoice line ${key}`)
    assert.equal(Number(viewer.body.lines[0].quantity), 10)
    for (const line of viewer.body.match.lines) for (const key of ['poUnitPrice', 'invoiceUnitPrice', 'priceVariance', 'amountVariance']) assert.equal(line[key], null, `match line ${key}`)
    for (const entry of viewer.body.match.exceptions) for (const key of ['expectedValue', 'actualValue', 'varianceValue']) assert.equal(entry[key], null, `${entry.exceptionType} exception ${key}`)
    assert.ok(!JSON.stringify(viewer.body).includes('Harbor Supply'), 'the supplier name appears nowhere in the viewer payload')
    assert.ok(!/"(13\.5|135|144|9)(\.0+)?"/.test(JSON.stringify(viewer.body)), 'no invoice amount appears in the viewer payload')

    const viewerExceptions = await call(prisma, 'viewer', '/api/finance/match-exceptions')
    assert.equal(viewerExceptions.status, 200)
    assert.ok(viewerExceptions.body.items.length >= 2)
    for (const entry of viewerExceptions.body.items) assert.equal(entry.actualValue, null)

    // The procurement specialist has no finance read permission at all.
    for (const path of ['/api/finance/supplier-invoices', detailPath, '/api/finance/match-exceptions', '/api/finance/payables', '/api/finance/supplier-credit-memos', '/api/finance/customer-invoices', '/api/finance/receivables', '/api/finance/aging', '/api/finance/customer-credit-notes', '/api/finance/landing']) {
      const denied = await call(prisma, 'buyer', path)
      assert.equal(denied.status, 403, path)
      assert.equal(denied.body.code, 'PERMISSION_DENIED', path)
    }

    // Entry data: the buyer cannot enter finance documents and gets empty
    // lists; the operations specialist can enter invoices but has no
    // procurement.prices.read, so PO prices are hidden; the admin sees them.
    const buyerEntry = await call(prisma, 'buyer', '/api/finance/entry-data')
    assert.equal(buyerEntry.status, 200)
    assert.deepEqual(buyerEntry.body.purchaseOrders, [])
    assert.deepEqual(buyerEntry.body.receivingDocuments, [])
    assert.deepEqual(buyerEntry.body.postedShipments, [])
    const specialistEntry = await call(prisma, 'specialist', '/api/finance/entry-data')
    assert.equal(specialistEntry.status, 200)
    const specialistPo = specialistEntry.body.purchaseOrders.find((row) => row.id === 'FR-PO')
    assert.equal(specialistPo.lines[0].unitPrice, null)
    assert.equal(specialistEntry.body.fieldVisibility.unitPrice.visible, false)
    assert.ok(specialistEntry.body.receivingDocuments.some((row) => row.id === 'FR-GRN'))
    const adminEntry = await call(prisma, 'admin', '/api/finance/entry-data')
    assert.equal(Number(adminEntry.body.purchaseOrders.find((row) => row.id === 'FR-PO').lines[0].unitPrice), 10)

    // The operations specialist reads invoices and matches without amounts.
    const specialist = await call(prisma, 'specialist', detailPath)
    assert.equal(specialist.status, 200)
    assert.equal(specialist.body.totalAmount, null)
    assert.equal(specialist.body.match.lines[0].poUnitPrice, null)
    const specialistList = await call(prisma, 'specialist', '/api/finance/supplier-invoices')
    assert.equal(specialistList.status, 200)
    assert.equal(specialistList.body.items[0].totalAmount, null)
  } finally {
    await prisma.$disconnect()
  }
})
