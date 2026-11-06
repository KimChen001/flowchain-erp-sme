import assert from 'node:assert/strict'
import test from 'node:test'
import { backfillTenantAuthorization } from '../../server/auth/authorization-backfill.mjs'
import { createPrismaClient } from '../../server/persistence/prisma-client.mjs'
import { handleOperationalFinanceRoute } from '../../server/routes/operational-finance.routes.mjs'

// A supplier's bill often arrives before the goods (owner decision of
// 2026-10-03, docs/bills-invoices-and-accounting-handoff.md). Such a bill is
// recorded against its purchase order and waits for the receipt: it cannot be
// matched, approved or paid until the posted receipt is linked, so payment
// still needs the three-way match. Called through the finance routes as each
// role against PostgreSQL.
// Run with: node scripts/run-postgres-test-files.mjs tests/postgres/bill-before-receipt.test.mjs

const tenantId = 'tenant-bill-before-receipt'
const users = {
  admin: { id: 'bbr-admin', role: 'admin' },
  finance: { id: 'bbr-finance', role: 'finance-specialist' },
  viewer: { id: 'bbr-viewer', role: 'viewer' },
}
const env = { ...process.env, FLOWCHAIN_PERSISTENCE_MODE: 'database', FLOWCHAIN_ENABLE_DB_OPERATIONAL_FINANCE: 'true', NODE_ENV: 'test' }
const identityOf = (key) => ({ authenticated: true, tenantId, userId: users[key].id, role: users[key].role })

async function call(prisma, key, method, path, body = {}) {
  let sent
  const ctx = {
    url: new URL(`http://local${path}`), req: { method, headers: {} }, res: {}, env,
    identity: identityOf(key), operationalFinancePrisma: prisma,
    readBody: async () => body,
    send: (_res, status, payload) => { sent = { status, body: payload } },
  }
  assert.equal(await handleOperationalFinanceRoute(ctx), true)
  return sent
}

async function order(prisma, id, { status = 'approved', quantity = '10.0000' } = {}) {
  await prisma.purchaseOrder.create({ data: { id, tenantId, status, supplierId: 'BBR-SUP', supplierName: 'Harbor Supply', currency: 'USD', amount: '100.0000', lines: { create: { id: `${id}-L1`, itemId: 'BBR-ITEM', sku: 'BBR-SKU', itemName: 'Valve', orderedQuantity: quantity, receivedQuantity: '0.0000', unit: 'EA', unitPrice: '10.0000' } } } })
}

async function receipt(prisma, id, poId, accepted) {
  await prisma.receivingDocument.create({ data: { id, tenantId, documentNumber: id, poId, supplierId: 'BBR-SUP', supplierName: 'Harbor Supply', status: 'received', workflowStatus: 'posted', postingStatus: 'posted', postedAt: new Date(), postedById: users.admin.id, warehouseId: 'BBR-WH', currency: 'USD', lines: { create: { id: `${id}-L1`, purchaseOrderLineId: `${poId}-L1`, itemId: 'BBR-ITEM', sku: 'BBR-SKU', itemName: 'Valve', acceptedQty: accepted, rejectedQty: '0.0000', unit: 'EA', warehouseId: 'BBR-WH', location: 'A-01', locationKey: 'a-01' } } } })
}

// A bill against the order alone: no receiving line on any line.
const bill = (poId, number, quantity, extra = {}) => {
  const amount = (Number(quantity) * 10).toFixed(4)
  return { invoiceNumber: number, supplierId: 'BBR-SUP', currency: 'USD', invoiceDate: '2026-09-01', dueDate: '2026-10-01', totalAmount: amount, lines: [{ purchaseOrderLineId: `${poId}-L1`, receivingLineId: '', quantity, unitPrice: '10.0000', lineAmount: amount, enteredTaxAmount: '0' }], ...extra }
}

test('a bill recorded before its receipt waits for it, and only then is matched and paid', async () => {
  assert.ok(process.env.DATABASE_URL_TEST, 'An isolated test database is required')
  const prisma = await createPrismaClient(env)
  try {
    await prisma.tenant.create({ data: { id: tenantId, name: tenantId, countryCode: 'US', locale: 'en-US', currency: 'USD', timezone: 'America/New_York', operationalSettings: { review: { quantityTolerance: '0.0000', pricePercentageTolerance: '0.0000', priceAbsoluteTolerance: '0.0000', amountTolerance: '0.0000' } } } })
    for (const user of Object.values(users)) await prisma.user.create({ data: { ...user, tenantId, email: `${user.id}@bill-before-receipt.invalid`, name: user.id } })
    await backfillTenantAuthorization(prisma, tenantId, { actorId: users.admin.id })
    await prisma.supplier.create({ data: { id: 'BBR-SUP', tenantId, code: 'BBR-SUP', name: 'Harbor Supply' } })
    await prisma.item.create({ data: { id: 'BBR-ITEM', tenantId, sku: 'BBR-SKU', name: 'Valve', unit: 'EA' } })
    await prisma.warehouse.create({ data: { id: 'BBR-WH', tenantId, code: 'BBR-WH', name: 'Main' } })
    await order(prisma, 'BBR-PO-1')
    await order(prisma, 'BBR-PO-DRAFT', { status: 'draft' })
    await order(prisma, 'BBR-PO-2')

    // The order must be approved and the quantity cannot pass what was ordered.
    const draftOrder = await call(prisma, 'finance', 'POST', '/api/finance/supplier-invoices/preview', bill('BBR-PO-DRAFT', 'BBR-X', '1.0000'))
    assert.equal(draftOrder.body.allowed, false)
    assert.ok(draftOrder.body.blockingIssues.some((entry) => entry.code === 'SUPPLIER_INVOICE_PO_NOT_OPEN'))
    const tooMany = await call(prisma, 'finance', 'POST', '/api/finance/supplier-invoices/preview', bill('BBR-PO-1', 'BBR-X', '11.0000'))
    assert.ok(tooMany.body.blockingIssues.some((entry) => entry.code === 'SUPPLIER_INVOICE_QUANTITY_EXCEEDS_ORDERED'))

    // The bill for 8 of 10 is recorded and submitted without a receipt.
    const preview = await call(prisma, 'finance', 'POST', '/api/finance/supplier-invoices/preview', bill('BBR-PO-1', 'BBR-1', '8.0000'))
    assert.equal(preview.body.allowed, true, JSON.stringify(preview.body.blockingIssues))
    assert.equal(preview.body.waitingForReceipt, true)
    const created = await call(prisma, 'finance', 'POST', '/api/finance/supplier-invoices', { ...bill('BBR-PO-1', 'BBR-1', '8.0000'), idempotencyKey: 'bbr-create-1' })
    assert.equal(created.status, 201, JSON.stringify(created.body))
    const billId = created.body.entityId
    const submitted = await call(prisma, 'finance', 'POST', `/api/finance/supplier-invoices/${billId}/submit`, { expectedVersion: 0, idempotencyKey: 'bbr-submit-1' })
    assert.equal(submitted.status, 200, JSON.stringify(submitted.body))
    let detail = await call(prisma, 'finance', 'GET', `/api/finance/supplier-invoices/${billId}`)
    assert.equal(detail.body.awaitingReceipt, true)
    assert.equal(detail.body.relatedGrnId, null)
    assert.ok(detail.body.availableActions.includes('link_receipt'))
    assert.ok(!detail.body.availableActions.includes('match'))
    assert.deepEqual(detail.body.receiptCandidates, [])

    // A second bill cannot claim more than the order has left: 8 of 10 are
    // held by the submitted bill.
    const second = await call(prisma, 'finance', 'POST', '/api/finance/supplier-invoices', { ...bill('BBR-PO-1', 'BBR-2', '3.0000'), idempotencyKey: 'bbr-create-2' })
    assert.equal(second.status, 201)
    const secondSubmit = await call(prisma, 'finance', 'POST', `/api/finance/supplier-invoices/${second.body.entityId}/submit`, { expectedVersion: 0, idempotencyKey: 'bbr-submit-2' })
    assert.equal(secondSubmit.status, 409)
    assert.equal(secondSubmit.body.code, 'SUPPLIER_INVOICE_QUANTITY_EXCEEDS_ORDERED')

    // Nothing to match against yet, so no match, no approval and no payment.
    const matchPreview = await call(prisma, 'finance', 'POST', `/api/finance/supplier-invoices/${billId}/match-preview`, { expectedVersion: 1 })
    assert.equal(matchPreview.body.blockingIssues[0].code, 'SUPPLIER_INVOICE_RECEIPT_REQUIRED')
    const match = await call(prisma, 'finance', 'POST', `/api/finance/supplier-invoices/${billId}/match`, { expectedVersion: 1, idempotencyKey: 'bbr-match-early' })
    assert.equal(match.status, 409)
    assert.equal(match.body.code, 'SUPPLIER_INVOICE_RECEIPT_REQUIRED')
    const approve = await call(prisma, 'finance', 'POST', `/api/finance/supplier-invoices/${billId}/approve`, { expectedVersion: 1, idempotencyKey: 'bbr-approve-early' })
    assert.equal(approve.status, 409)
    assert.equal(await prisma.payableObligation.count({ where: { tenantId } }), 0)

    // The goods arrive short: 6 of the 8 billed. Linking is allowed and says
    // so; the three-way match then shows the difference.
    await receipt(prisma, 'BBR-GRN-OTHER', 'BBR-PO-2', '5.0000')
    await receipt(prisma, 'BBR-GRN-1', 'BBR-PO-1', '6.0000')
    const otherOrder = await call(prisma, 'finance', 'POST', `/api/finance/supplier-invoices/${billId}/link-receipt-preview`, { expectedVersion: 1, receivingDocumentId: 'BBR-GRN-OTHER' })
    assert.ok(otherOrder.body.blockingIssues.some((entry) => entry.code === 'SUPPLIER_INVOICE_RECEIPT_OTHER_PO'))
    detail = await call(prisma, 'finance', 'GET', `/api/finance/supplier-invoices/${billId}`)
    assert.deepEqual(detail.body.receiptCandidates.map((row) => row.id), ['BBR-GRN-1'])
    assert.equal((await call(prisma, 'viewer', 'POST', `/api/finance/supplier-invoices/${billId}/link-receipt`, { expectedVersion: 1, receivingDocumentId: 'BBR-GRN-1', idempotencyKey: 'bbr-link-viewer' })).status, 403)
    const linkPreview = await call(prisma, 'finance', 'POST', `/api/finance/supplier-invoices/${billId}/link-receipt-preview`, { expectedVersion: 1, receivingDocumentId: 'BBR-GRN-1' })
    assert.equal(linkPreview.body.allowed, true, JSON.stringify(linkPreview.body.blockingIssues))
    assert.equal(linkPreview.body.warnings[0].code, 'SUPPLIER_INVOICE_RECEIPT_SHORT')
    const linked = await call(prisma, 'finance', 'POST', `/api/finance/supplier-invoices/${billId}/link-receipt`, { expectedVersion: 1, receivingDocumentId: 'BBR-GRN-1', idempotencyKey: 'bbr-link-1' })
    assert.equal(linked.status, 200, JSON.stringify(linked.body))
    const lines = await prisma.supplierInvoiceLine.findMany({ where: { supplierInvoiceId: billId } })
    assert.deepEqual(lines.map((line) => line.receivingLineId), ['BBR-GRN-1-L1'])
    detail = await call(prisma, 'finance', 'GET', `/api/finance/supplier-invoices/${billId}`)
    assert.equal(detail.body.awaitingReceipt, false)
    assert.equal(detail.body.relatedGrnId, 'BBR-GRN-1')
    assert.ok(detail.body.availableActions.includes('match'))
    const relink = await call(prisma, 'finance', 'POST', `/api/finance/supplier-invoices/${billId}/link-receipt-preview`, { expectedVersion: 2, receivingDocumentId: 'BBR-GRN-1' })
    assert.ok(relink.body.blockingIssues.some((entry) => entry.code === 'SUPPLIER_INVOICE_RECEIPT_ALREADY_LINKED'))

    // The match flags 8 billed against 6 received; approval waits for review.
    const matched = await call(prisma, 'finance', 'POST', `/api/finance/supplier-invoices/${billId}/match`, { expectedVersion: 2, idempotencyKey: 'bbr-match-1' })
    assert.equal(matched.status, 200, JSON.stringify(matched.body))
    assert.equal(matched.body.invoice.status, 'exception')
    detail = await call(prisma, 'finance', 'GET', `/api/finance/supplier-invoices/${billId}`)
    assert.ok(detail.body.match.exceptions.some((entry) => entry.exceptionType === 'quantity'))
    assert.ok(!detail.body.availableActions.includes('approve'))

    // A bill for exactly what arrives goes through to payment.
    await order(prisma, 'BBR-PO-3', { quantity: '5.0000' })
    const exact = await call(prisma, 'finance', 'POST', '/api/finance/supplier-invoices', { ...bill('BBR-PO-3', 'BBR-3', '5.0000'), idempotencyKey: 'bbr-create-3' })
    assert.equal(exact.status, 201, JSON.stringify(exact.body))
    await call(prisma, 'finance', 'POST', `/api/finance/supplier-invoices/${exact.body.entityId}/submit`, { expectedVersion: 0, idempotencyKey: 'bbr-submit-3' })
    await receipt(prisma, 'BBR-GRN-3', 'BBR-PO-3', '5.0000')
    const link3 = await call(prisma, 'finance', 'POST', `/api/finance/supplier-invoices/${exact.body.entityId}/link-receipt`, { expectedVersion: 1, receivingDocumentId: 'BBR-GRN-3', idempotencyKey: 'bbr-link-3' })
    assert.equal(link3.status, 200, JSON.stringify(link3.body))
    assert.deepEqual(link3.body.warnings, [])
    const match3 = await call(prisma, 'finance', 'POST', `/api/finance/supplier-invoices/${exact.body.entityId}/match`, { expectedVersion: 2, idempotencyKey: 'bbr-match-3' })
    assert.equal(match3.body.invoice.status, 'matched')
    const approve3 = await call(prisma, 'finance', 'POST', `/api/finance/supplier-invoices/${exact.body.entityId}/approve`, { expectedVersion: 3, idempotencyKey: 'bbr-approve-3' })
    assert.equal(approve3.status, 200, JSON.stringify(approve3.body))
    const paid = await call(prisma, 'finance', 'POST', `/api/finance/payables/${approve3.body.payable.id}/payments`, { expectedVersion: 0, paymentDate: new Date().toISOString().slice(0, 10), amount: '50', method: 'ach', idempotencyKey: 'bbr-pay-3' })
    assert.equal(paid.status, 201, JSON.stringify(paid.body))
    assert.equal(paid.body.obligation.status, 'settled')

    // The link is audited.
    const audit = await prisma.auditLog.count({ where: { tenantId, action: 'supplier_invoice_receipt_linked' } })
    assert.equal(audit, 2)
  } finally {
    await prisma.$disconnect()
  }
})
