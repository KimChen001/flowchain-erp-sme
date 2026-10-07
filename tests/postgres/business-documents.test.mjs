import assert from 'node:assert/strict'
import test from 'node:test'
import { backfillTenantAuthorization } from '../../server/auth/authorization-backfill.mjs'
import { ITEM_SUPPLIER_NAMESPACE } from '../../server/domain/master-data-commands.mjs'
import { createPrismaClient } from '../../server/persistence/prisma-client.mjs'
import { createDatabaseRepositoryRegistry } from '../../server/repositories/adapter-registry.mjs'
import { handleProcurementWorkflowRoute } from '../../server/routes/procurement-workflow.routes.mjs'
import { handleOperationalFinanceRoute } from '../../server/routes/operational-finance.routes.mjs'

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
    await prisma.purchaseOrder.create({ data: { id: 'PD-PO', tenantId, status: 'approved', supplierId: 'PD-SUP', supplierName: 'Harbor Supply', currency: 'EUR', amount: '1001.2340', expectedDate: new Date('2026-11-03T12:00:00Z'), metadata: { orderNumber: 'PO-2026-0077', targetWarehouseId: 'PD-WH', approvalTimeline: [{ action: 'submit', actorId: 'pd-admin', at: '2026-10-01T15:00:00.000Z', reason: null }, { action: 'approve', actorId: 'pd-admin', at: '2026-10-02T16:30:00.000Z', reason: null }] }, lines: { create: { id: 'PD-POL', itemId: 'PD-ITEM', sku: 'VAL-10', itemName: 'Brass valve', orderedQuantity: '10.0000', receivedQuantity: '0.0000', unit: 'EA', unitPrice: '100.1234', amount: '1001.2340', metadata: { requestedDate: '2026-11-01' } } } } })
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
    // Sent before it is marked issued: the recorded approval date, no issue date.
    assert.deepEqual([document.approvedAt, document.issuedAt], ['2026-10-02T16:30:00.000Z', null])
    // A line converted from a purchase request records only the requested
    // date: no promised date is printed, though the PO has an expected date.
    assert.deepEqual(document.lines.map((line) => [line.requestedDate, line.promisedDate]), [['2026-11-01', null]])
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

// GET /api/finance/customer-invoices/:id/document against PostgreSQL, as each
// role. It answers exactly as the invoice detail does: another workspace's
// invoice is not found, a role without invoice read is refused, a role that
// cannot see amounts or the customer gets a document marked not printable
// with no amounts and no customer details (the customer master is not used),
// and the payment summary needs the receivable read permission.
const invoiceTenantId = 'tenant-invoice-document'
const otherInvoiceTenantId = 'tenant-invoice-document-other'
const invoiceUsers = {
  admin: { id: 'id-admin', role: 'admin' },
  viewer: { id: 'id-viewer', role: 'viewer' },
  buyer: { id: 'id-buyer', role: 'buyer' },
}
const financeEnv = { ...env, FLOWCHAIN_ENABLE_DB_OPERATIONAL_FINANCE: 'true' }

async function customActor(prisma, suffix, permissions) {
  const userId = `id-${suffix}`
  const roleId = `id-${suffix}-role`
  await prisma.user.create({ data: { id: userId, tenantId: invoiceTenantId, email: `${suffix}@invoice-document.invalid`, name: suffix, role: 'custom' } })
  await prisma.tenantRole.create({ data: { id: roleId, tenantId: invoiceTenantId, roleKey: `invoice-document-${suffix}`, name: suffix } })
  await prisma.tenantRolePermission.createMany({ data: permissions.map((permissionCode, index) => ({ id: `${roleId}-permission-${index}`, tenantId: invoiceTenantId, roleId, permissionCode })) })
  await prisma.userRoleAssignment.create({ data: { id: `${roleId}-assignment`, tenantId: invoiceTenantId, userId, roleId } })
  return { authenticated: true, tenantId: invoiceTenantId, userId, role: 'custom' }
}

async function seedSale(prisma, tenant, suffix) {
  await prisma.salesOrder.create({ data: { id: `ID-SO-${suffix}`, tenantId: tenant, orderNumber: `SO-1791349366771-${suffix}`, customerName: 'Bayside Retail', customerId: 'CUST-BAYSIDE', currency: 'EUR', workflowStatus: 'confirmed', lines: { create: { id: `ID-SOL-${suffix}`, itemId: `ID-ITEM-${suffix}`, sku: 'VAL-10', itemName: 'Brass valve', orderedQuantity: '10.0000', unit: 'EA', unitPrice: '12.5000', amount: '125.0000' } } } })
  await prisma.shipmentDocument.create({ data: { id: `ID-SHIP-${suffix}`, tenantId: tenant, shipmentNumber: `SHIP-${suffix}`, salesOrderId: `ID-SO-${suffix}`, workflowStatus: 'ready', postingStatus: 'posted', postedAt: new Date(), lines: { create: { id: `ID-SHIPL-${suffix}`, salesOrderLineId: `ID-SOL-${suffix}`, itemId: `ID-ITEM-${suffix}`, sku: 'VAL-10', requestedQuantity: '10.0000', postedQuantity: '10.0000', unit: 'EA' } } } })
}

test('the invoice document reads as the invoice detail does and prints only what is recorded', async () => {
  assert.ok(process.env.DATABASE_URL_TEST, 'An isolated test database is required')
  const prisma = await createPrismaClient(financeEnv)
  try {
    await prisma.tenant.create({ data: { id: invoiceTenantId, name: 'Harbor Goods', legalName: 'Harbor Goods LLC', countryCode: 'US', locale: 'en-US', currency: 'USD', timezone: 'America/New_York', operationalSettings: { documents: { letterhead: { addressLines: ['12 Pier Road'] }, customerInvoice: { paymentInstructions: 'Pay by ACH to the account on your vendor form.' } } } } })
    await prisma.tenant.create({ data: { id: otherInvoiceTenantId, name: 'Other Goods', countryCode: 'US', locale: 'en-US', currency: 'USD', timezone: 'America/New_York' } })
    for (const user of Object.values(invoiceUsers)) await prisma.user.create({ data: { ...user, tenantId: invoiceTenantId, email: `${user.id}@invoice-document.invalid`, name: user.id } })
    await backfillTenantAuthorization(prisma, invoiceTenantId, { actorId: invoiceUsers.admin.id })
    const amountsOnly = await customActor(prisma, 'amounts-only', ['finance.customer_invoice.read', 'finance.amounts.read', 'finance.receivable.read'])
    const noReceivable = await customActor(prisma, 'no-receivable', ['finance.customer_invoice.read', 'finance.amounts.read', 'finance.partner_snapshot.read'])
    await prisma.item.create({ data: { id: 'ID-ITEM-A', tenantId: invoiceTenantId, sku: 'VAL-10', name: 'Brass valve', unit: 'EA' } })
    await prisma.item.create({ data: { id: 'ID-ITEM-OTHER', tenantId: otherInvoiceTenantId, sku: 'VAL-10', name: 'Brass valve', unit: 'EA' } })
    await seedSale(prisma, invoiceTenantId, 'A')
    // The customer as recorded in master data: contact and terms, and a
    // currency and credit standing a document never prints.
    await prisma.runtimeRecord.create({ data: { id: 'rr-bayside', tenantId: invoiceTenantId, namespace: 'master-data.customers', recordKey: 'BAYSIDE', payload: { id: 'CUST-BAYSIDE', code: 'BAYSIDE', name: 'Bayside Retail', status: 'active', contact: 'Lee Park', email: 'ap@bayside.invalid', address: '9 Market St, Oakland', paymentTerms: 'NET45', currency: 'GBP', creditStatus: 'on_hold', version: 1 } } })
    await prisma.paymentTerm.create({ data: { id: 'ID-PT-45', tenantId: invoiceTenantId, code: 'NET45', name: 'Net 45 days', days: 45 } })
    // A customer whose recorded terms only another workspace's payment term names.
    await prisma.runtimeRecord.create({ data: { id: 'rr-hill', tenantId: invoiceTenantId, namespace: 'master-data.customers', recordKey: 'HILL', payload: { id: 'CUST-HILL', code: 'HILL', name: 'Hill Stores', status: 'active', paymentTerms: 'NET60', version: 1 } } })
    await prisma.paymentTerm.create({ data: { id: 'ID-PT-OTHER-60', tenantId: otherInvoiceTenantId, code: 'NET60', name: 'Other workspace net 60', days: 60 } })
    await prisma.customerInvoice.create({ data: { id: 'ID-INV', tenantId: invoiceTenantId, invoiceNumber: 'INV-1001', salesOrderId: 'ID-SO-A', shipmentId: 'ID-SHIP-A', customerId: 'CUST-BAYSIDE', customerNameSnapshot: 'Bayside Retail', invoiceDate: new Date('2026-10-05T00:00:00.000Z'), dueDate: new Date('2026-10-15T00:00:00.000Z'), subtotalAmount: '125.0000', enteredTaxAmount: '10.0000', totalAmount: '135.0000', currency: 'EUR', status: 'issued', lines: { create: { id: 'ID-INVL', lineNumber: 1, shipmentLineId: 'ID-SHIPL-A', salesOrderLineId: 'ID-SOL-A', itemId: 'ID-ITEM-A', sku: 'VAL-10', itemName: 'Brass valve', quantity: '10.0000', unit: 'EA', unitPrice: '12.5000', lineAmount: '125.0000', enteredTaxAmount: '10.0000', totalAmount: '135.0000' } } } })
    await prisma.receivableObligation.create({ data: { id: 'ID-AR', tenantId: invoiceTenantId, customerInvoiceId: 'ID-INV', obligationNumber: 'AR-INV-1001', originalAmount: '135.0000', outstandingAmount: '85.0000', approvedCreditAmount: '10.0000', currency: 'EUR', dueDate: new Date('2026-10-15T00:00:00.000Z'), status: 'partially_settled' } })
    await prisma.customerInvoice.create({ data: { id: 'ID-INV-APPROVED', tenantId: invoiceTenantId, invoiceNumber: 'INV-1002', salesOrderId: 'ID-SO-A', shipmentId: 'ID-SHIP-A', customerId: 'CUST-BAYSIDE', customerNameSnapshot: 'Bayside Retail', invoiceDate: new Date('2026-10-06T00:00:00.000Z'), dueDate: new Date('2026-11-05T00:00:00.000Z'), subtotalAmount: '5.0000', totalAmount: '5.0000', currency: 'EUR', status: 'approved' } })
    await prisma.customerInvoice.create({ data: { id: 'ID-INV-DRAFT', tenantId: invoiceTenantId, invoiceNumber: 'INV-1003', salesOrderId: 'ID-SO-A', shipmentId: 'ID-SHIP-A', customerNameSnapshot: 'Bayside Retail', invoiceDate: new Date('2026-10-06T00:00:00.000Z'), dueDate: new Date('2026-11-05T00:00:00.000Z'), subtotalAmount: '5.0000', totalAmount: '5.0000', currency: 'EUR', status: 'draft' } })
    await prisma.customerInvoice.create({ data: { id: 'ID-INV-HILL', tenantId: invoiceTenantId, invoiceNumber: 'INV-1004', salesOrderId: 'ID-SO-A', shipmentId: 'ID-SHIP-A', customerId: 'CUST-HILL', customerNameSnapshot: 'Hill Stores', invoiceDate: new Date('2026-10-08T00:30:00.000Z'), dueDate: new Date('2026-11-07T00:00:00.000Z'), subtotalAmount: '7.0000', totalAmount: '7.0000', currency: 'EUR', status: 'issued' } })
    await seedSale(prisma, otherInvoiceTenantId, 'OTHER')
    await prisma.customerInvoice.create({ data: { id: 'ID-INV-OTHER', tenantId: otherInvoiceTenantId, invoiceNumber: 'INV-OTHER', salesOrderId: 'ID-SO-OTHER', shipmentId: 'ID-SHIP-OTHER', customerNameSnapshot: 'Elsewhere Ltd', invoiceDate: new Date('2026-10-06T00:00:00.000Z'), dueDate: new Date('2026-11-05T00:00:00.000Z'), subtotalAmount: '9.0000', totalAmount: '9.0000', currency: 'USD', status: 'issued' } })

    const call = async (identity, path) => {
      let sent
      const ctx = {
        url: new URL(`http://local${path}`), req: { method: 'GET', headers: {} }, res: {}, env: financeEnv, identity, operationalFinancePrisma: prisma,
        readBody: async () => ({}),
        send: (_res, status, payload) => { sent = { status, body: payload } },
      }
      assert.equal(await handleOperationalFinanceRoute(ctx), true, path)
      return sent
    }
    const as = (key) => ({ authenticated: true, tenantId: invoiceTenantId, userId: invoiceUsers[key].id, role: invoiceUsers[key].role, source: 'signed-session' })

    const { status, body } = await call(as('admin'), '/api/finance/customer-invoices/ID-INV/document')
    assert.equal(status, 200)
    const document = body.document
    assert.deepEqual(document.printable, { ok: true, reason: null })
    assert.deepEqual([document.number, document.status, document.currency, document.invoiceDate, document.dueDate], ['INV-1001', 'issued', 'EUR', { day: '2026-10-05', instant: null }, '2026-10-15'])
    // Linked numbers print as stored.
    assert.deepEqual([document.salesOrderNumber, document.shipmentNumber], ['SO-1791349366771-A', 'SHIP-A'])
    assert.deepEqual(document.seller, { companyName: 'Harbor Goods LLC', addressLines: ['12 Pier Road'], phone: null, email: null, taxId: null })
    assert.deepEqual(document.billTo, { name: 'Bayside Retail', code: 'BAYSIDE', contactName: 'Lee Park', email: 'ap@bayside.invalid', telephone: null, address: '9 Market St, Oakland' })
    assert.equal(document.paymentTerms, 'Net 45 days', 'the recorded name of the recorded term')
    assert.deepEqual(document.lines.map((line) => [line.sku, line.unit].concat([line.quantity, line.unitPrice, line.amount, line.tax, line.total].map(Number))), [['VAL-10', 'EA', 10, 12.5, 125, 10, 135]])
    assert.deepEqual(document.totals.map((total) => [total.currency, Number(total.subtotal), Number(total.tax), Number(total.total)]), [['EUR', 125, 10, 135]])
    assert.deepEqual([document.paymentSummary.currency, Number(document.paymentSummary.amountPaid), Number(document.paymentSummary.creditsApplied), Number(document.paymentSummary.balanceDue)], ['EUR', 40, 10, 85])
    assert.equal(document.paymentInstructions, 'Pay by ACH to the account on your vendor form.')
    const serialized = JSON.stringify(body)
    for (const value of ['GBP', 'on_hold', 'creditStatus', 'NET30', '"USD"']) assert.equal(serialized.includes(value), false, value)

    // Another workspace's payment term never names this workspace's recorded
    // terms: the code prints as stored. The invoice date stored as a moment
    // comes back as that moment, for the page to print in the workspace timezone.
    const hill = (await call(as('admin'), '/api/finance/customer-invoices/ID-INV-HILL/document')).body.document
    assert.equal(hill.paymentTerms, 'NET60')
    assert.equal(JSON.stringify(hill).includes('Other workspace'), false)
    assert.deepEqual([hill.invoiceDate, hill.dueDate], [{ day: null, instant: '2026-10-08T00:30:00.000Z' }, '2026-11-07'])

    // Approved: shown, not printable. Draft: not a document yet.
    assert.deepEqual((await call(as('admin'), '/api/finance/customer-invoices/ID-INV-APPROVED/document')).body.document.printable, { ok: false, reason: 'not_issued' })
    assert.deepEqual((await call(as('admin'), '/api/finance/customer-invoices/ID-INV-DRAFT/document')).body.document.printable, { ok: false, reason: 'status' })
    // Another workspace's invoice is not found, and nothing about it comes back.
    const other = await call(as('admin'), '/api/finance/customer-invoices/ID-INV-OTHER/document')
    assert.deepEqual([other.status, other.body.code], [404, 'CUSTOMER_INVOICE_NOT_FOUND'])
    assert.equal(JSON.stringify(other.body).includes('Elsewhere'), false)
    // The buyer cannot read invoices at all, here or on the detail.
    for (const path of ['/api/finance/customer-invoices/ID-INV/document', '/api/finance/customer-invoices/ID-INV']) {
      const denied = await call(as('buyer'), path)
      assert.equal(denied.status, 403, path)
      assert.equal(JSON.stringify(denied.body).includes('Bayside'), false, path)
    }
    // The read-only viewer reads invoices but no amounts and no customer:
    // not printable, nothing to send.
    const viewer = await call(as('viewer'), '/api/finance/customer-invoices/ID-INV/document')
    assert.equal(viewer.status, 200)
    assert.deepEqual(viewer.body.document.printable, { ok: false, reason: 'amounts_hidden' })
    assert.deepEqual(viewer.body.document.totals, [{ currency: 'EUR', subtotal: null, tax: null, total: null }])
    assert.deepEqual(viewer.body.document.lines.map((line) => [line.unitPrice, line.amount, line.tax, line.total]), [[null, null, null, null]])
    for (const value of ['135', '12.5', 'Bayside', 'BAYSIDE', 'Lee Park', 'Market St', 'Net 45']) assert.equal(JSON.stringify(viewer.body.document).includes(value), false, value)
    // Amounts but not the customer: still not printable, and the customer
    // master is not used.
    const noPartner = await call(amountsOnly, '/api/finance/customer-invoices/ID-INV/document')
    assert.deepEqual(noPartner.body.document.printable, { ok: false, reason: 'amounts_hidden' })
    assert.equal(Number(noPartner.body.document.totals[0].total), 135)
    assert.equal(noPartner.body.document.paymentTerms, null)
    for (const value of ['Bayside', 'BAYSIDE', 'Lee Park', 'Market St']) assert.equal(JSON.stringify(noPartner.body).includes(value), false, value)
    // Everything but the receivable: printable, without a payment summary.
    const withoutReceivable = await call(noReceivable, '/api/finance/customer-invoices/ID-INV/document')
    assert.deepEqual(withoutReceivable.body.document.printable, { ok: true, reason: null })
    assert.equal(withoutReceivable.body.document.paymentSummary, null)
  } finally {
    await prisma.$disconnect()
  }
})
