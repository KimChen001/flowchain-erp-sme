import assert from 'node:assert/strict'
import test from 'node:test'
import { backfillTenantAuthorization } from '../../server/auth/authorization-backfill.mjs'
import { createOperationalFinanceCommandService } from '../../server/domain/operational-finance-command-service.mjs'
import { createOperationalFinanceO2cCommandService } from '../../server/domain/operational-finance-o2c-command-service.mjs'
import { createPrismaClient } from '../../server/persistence/prisma-client.mjs'
import { handleOperationalFinanceRoute } from '../../server/routes/operational-finance.routes.mjs'

// Light payment records (docs/bills-invoices-and-accounting-handoff.md, step 2),
// called through the finance routes as each role against PostgreSQL. A payment
// lowers what is outstanding on a bill to pay or a receivable and never more
// than that; the status follows (partly paid, paid); a void with a reason puts
// the amount back. Held bills, disputed receivables, stale versions, future
// dates and reused idempotency keys are refused, and only roles with the
// record_payment permission may record.
// Run with: node scripts/run-postgres-test-files.mjs tests/postgres/payment-records.test.mjs

const tenantId = 'tenant-payment-records'
const users = {
  admin: { id: 'pr-admin', role: 'admin' },
  finance: { id: 'pr-finance', role: 'finance-specialist' },
  viewer: { id: 'pr-viewer', role: 'viewer' },
  specialist: { id: 'pr-specialist', role: 'business-specialist' },
}
const env = { ...process.env, FLOWCHAIN_PERSISTENCE_MODE: 'database', FLOWCHAIN_ENABLE_DB_OPERATIONAL_FINANCE: 'true', NODE_ENV: 'test' }
const identityOf = (key) => ({ authenticated: true, tenantId, userId: users[key].id, role: users[key].role })
const as = (key) => ({ identity: identityOf(key) })
const today = new Date().toISOString().slice(0, 10)

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

async function seed(prisma) {
  await prisma.tenant.create({ data: { id: tenantId, name: tenantId, countryCode: 'US', locale: 'en-US', currency: 'USD', timezone: 'America/New_York', operationalSettings: { review: { quantityTolerance: '0.0000', pricePercentageTolerance: '0.0000', priceAbsoluteTolerance: '0.0000', amountTolerance: '0.0000' } } } })
  for (const user of Object.values(users)) await prisma.user.create({ data: { ...user, tenantId, email: `${user.id}@payment-records.invalid`, name: user.id } })
  await backfillTenantAuthorization(prisma, tenantId, { actorId: users.admin.id })
  await prisma.supplier.create({ data: { id: 'PR-SUP', tenantId, code: 'PR-SUP', name: 'Harbor Supply' } })
  await prisma.item.create({ data: { id: 'PR-ITEM', tenantId, sku: 'PR-SKU', name: 'Valve', unit: 'EA' } })
  await prisma.warehouse.create({ data: { id: 'PR-WH', tenantId, code: 'PR-WH', name: 'Main' } })
}

// An approved bill for 10 x 10 plus 5 tax: a bill to pay of 105. Bills of the
// same total are dated more than 7 days apart, so the duplicate check does not
// flag them.
async function approvedBill(prisma, command, suffix, invoiceDate = '2026-09-01') {
  await prisma.purchaseOrder.create({ data: { id: `PR-PO-${suffix}`, tenantId, status: 'approved', supplierId: 'PR-SUP', supplierName: 'Harbor Supply', currency: 'USD', amount: '100.0000', lines: { create: { id: `PR-POL-${suffix}`, itemId: 'PR-ITEM', sku: 'PR-SKU', itemName: 'Valve', orderedQuantity: '10.0000', receivedQuantity: '10.0000', unit: 'EA', unitPrice: '10.0000' } } } })
  await prisma.receivingDocument.create({ data: { id: `PR-GRN-${suffix}`, tenantId, documentNumber: `PR-GRN-${suffix}`, poId: `PR-PO-${suffix}`, supplierId: 'PR-SUP', supplierName: 'Harbor Supply', status: 'received', workflowStatus: 'posted', postingStatus: 'posted', postedAt: new Date(), postedById: users.admin.id, warehouseId: 'PR-WH', currency: 'USD', lines: { create: { id: `PR-GRNL-${suffix}`, purchaseOrderLineId: `PR-POL-${suffix}`, itemId: 'PR-ITEM', sku: 'PR-SKU', itemName: 'Valve', acceptedQty: '10.0000', rejectedQty: '0.0000', unit: 'EA', warehouseId: 'PR-WH', location: 'A-01', locationKey: 'a-01' } } } })
  const admin = as('admin')
  const bill = await command.createSupplierInvoice({ invoiceNumber: `PR-BILL-${suffix}`, supplierId: 'PR-SUP', currency: 'USD', invoiceDate, dueDate: '2026-10-01', totalAmount: '105.0000', idempotencyKey: `pr-create-${suffix}`, lines: [{ purchaseOrderLineId: `PR-POL-${suffix}`, receivingLineId: `PR-GRNL-${suffix}`, quantity: '10.0000', unitPrice: '10.0000', lineAmount: '100.0000', enteredTaxAmount: '5.0000' }] }, admin)
  await command.submitSupplierInvoice(bill.entityId, { expectedVersion: 0, idempotencyKey: `pr-submit-${suffix}` }, admin)
  await command.matchSupplierInvoice(bill.entityId, { expectedVersion: 1, idempotencyKey: `pr-match-${suffix}` }, admin)
  const approved = await command.approveSupplierInvoice(bill.entityId, { expectedVersion: 2, idempotencyKey: `pr-approve-${suffix}` }, admin)
  return { billId: bill.entityId, payableId: approved.payable.id }
}

// An issued invoice for 4 x 12.50 plus 2 tax: a receivable of 52.
async function issuedInvoice(prisma, o2c, suffix) {
  await prisma.salesOrder.create({ data: { id: `PR-SO-${suffix}`, tenantId, orderNumber: `PR-SO-${suffix}`, customerId: `PR-CUS-${suffix}`, customerName: 'Bay Retail', workflowStatus: 'confirmed', reservationStatus: 'fully_reserved', fulfillmentStatus: 'fully_fulfilled', currency: 'USD', lines: { create: { id: `PR-SOL-${suffix}`, itemId: 'PR-ITEM', sku: 'PR-SKU', itemName: 'Valve', orderedQuantity: '10.0000', fulfilledQuantity: '10.0000', unit: 'EA', unitPrice: '12.5000', amount: '125.0000' } } } })
  await prisma.shipmentDocument.create({ data: { id: `PR-SHIP-${suffix}`, tenantId, shipmentNumber: `PR-SHIP-${suffix}`, salesOrderId: `PR-SO-${suffix}`, workflowStatus: 'ready', postingStatus: 'posted', postedAt: new Date('2026-09-01T12:00:00.000Z'), postedById: users.admin.id, lines: { create: { id: `PR-SHIPL-${suffix}`, salesOrderLineId: `PR-SOL-${suffix}`, itemId: 'PR-ITEM', sku: 'PR-SKU', requestedQuantity: '10.0000', postedQuantity: '10.0000', unit: 'EA' } } } })
  const admin = as('admin')
  const created = await o2c.createCustomerInvoice({ invoiceNumber: `PR-INV-${suffix}`, shipmentId: `PR-SHIP-${suffix}`, currency: 'USD', invoiceDate: '2026-09-01T00:00:00.000Z', dueDate: '2026-10-01T00:00:00.000Z', totalAmount: '52', idempotencyKey: `pr-inv-create-${suffix}`, lines: [{ shipmentLineId: `PR-SHIPL-${suffix}`, quantity: '4.0000', enteredTaxAmount: '2.0000' }] }, admin)
  await o2c.submitCustomerInvoice(created.invoice.id, { expectedVersion: 0, idempotencyKey: `pr-inv-submit-${suffix}` }, admin)
  await o2c.approveCustomerInvoice(created.invoice.id, { expectedVersion: 1, idempotencyKey: `pr-inv-approve-${suffix}` }, admin)
  const issued = await o2c.issueCustomerInvoice(created.invoice.id, { expectedVersion: 2, obligationNumber: `AR-PR-${suffix}`, idempotencyKey: `pr-inv-issue-${suffix}` }, admin)
  return { invoiceId: created.invoice.id, receivableId: issued.receivable.id }
}

test('payments lower what is owed, never below zero, and a void puts the amount back', async () => {
  assert.ok(process.env.DATABASE_URL_TEST, 'An isolated test database is required')
  const prisma = await createPrismaClient(env)
  const command = createOperationalFinanceCommandService({ prisma, env })
  const o2c = createOperationalFinanceO2cCommandService({ prisma, env })
  try {
    await seed(prisma)
    const { billId, payableId } = await approvedBill(prisma, command, 'A')
    const base = `/api/finance/payables/${payableId}/payments`
    const payment = (extra = {}) => ({ expectedVersion: 0, paymentDate: today, amount: '40', currency: 'USD', method: 'ach', reference: 'ACH-0001', ...extra })

    // The preview explains each refusal before anything is written.
    const tooMuch = await call(prisma, 'finance', 'POST', `${base}/preview`, payment({ amount: '105.0001' }))
    assert.equal(tooMuch.status, 200)
    assert.equal(tooMuch.body.allowed, false)
    assert.equal(tooMuch.body.blockingIssues[0].code, 'PAYMENT_AMOUNT_EXCEEDS_OUTSTANDING')
    const future = await call(prisma, 'finance', 'POST', `${base}/preview`, payment({ paymentDate: '2099-01-01' }))
    assert.ok(future.body.blockingIssues.some((entry) => entry.code === 'PAYMENT_DATE_IN_FUTURE'))
    const method = await call(prisma, 'finance', 'POST', `${base}/preview`, payment({ method: 'crypto' }))
    assert.ok(method.body.blockingIssues.some((entry) => entry.code === 'PAYMENT_METHOD_INVALID'))
    const currency = await call(prisma, 'finance', 'POST', `${base}/preview`, payment({ currency: 'EUR' }))
    assert.ok(currency.body.blockingIssues.some((entry) => entry.code === 'FINANCE_CURRENCY_MISMATCH'))
    const zero = await call(prisma, 'finance', 'POST', `${base}/preview`, payment({ amount: '0' }))
    assert.ok(zero.body.blockingIssues.some((entry) => entry.code === 'PAYMENT_AMOUNT_INVALID'))
    const allowed = await call(prisma, 'finance', 'POST', `${base}/preview`, payment())
    assert.equal(allowed.body.allowed, true)
    assert.deepEqual(allowed.body.after, { outstandingAmount: '65.0000', status: 'partially_settled' })
    assert.equal(allowed.body.paymentExecution, false)

    // Only roles that may record payments do; reading stays open to readers.
    assert.equal((await call(prisma, 'viewer', 'POST', base, { ...payment(), idempotencyKey: 'pr-viewer' })).status, 403)
    assert.equal((await call(prisma, 'specialist', 'POST', base, { ...payment(), idempotencyKey: 'pr-specialist' })).status, 403)

    // A partial payment: 105 owed, 40 paid, 65 left.
    const first = await call(prisma, 'finance', 'POST', base, { ...payment(), idempotencyKey: 'pr-pay-1' })
    assert.equal(first.status, 201, JSON.stringify(first.body))
    assert.equal(first.body.obligation.outstandingAmount, '65.0000')
    assert.equal(first.body.obligation.status, 'partially_settled')
    assert.equal(first.body.payment.paymentDate, today)
    const replay = await call(prisma, 'finance', 'POST', base, { ...payment(), idempotencyKey: 'pr-pay-1' })
    assert.equal(replay.body.idempotentReplay, true)
    assert.equal(replay.body.entityId, first.body.entityId)
    const reused = await call(prisma, 'finance', 'POST', base, { ...payment({ amount: '41' }), idempotencyKey: 'pr-pay-1' })
    assert.equal(reused.status, 409)
    assert.equal(reused.body.code, 'IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD')
    // The screen that showed version 0 is stale now.
    const stale = await call(prisma, 'finance', 'POST', base, { ...payment({ amount: '10' }), idempotencyKey: 'pr-pay-stale' })
    assert.equal(stale.status, 409)
    assert.equal(stale.body.code, 'FINANCE_VERSION_CONFLICT')

    // Paying the rest settles the bill to pay; nothing more can be recorded.
    const rest = await call(prisma, 'admin', 'POST', base, { ...payment({ expectedVersion: 1, amount: '65.0000', method: 'check', reference: '1042' }), idempotencyKey: 'pr-pay-2' })
    assert.equal(rest.status, 201, JSON.stringify(rest.body))
    assert.equal(rest.body.obligation.outstandingAmount, '0.0000')
    assert.equal(rest.body.obligation.status, 'settled')
    const after = await call(prisma, 'finance', 'POST', `${base}/preview`, payment({ expectedVersion: 2, amount: '1' }))
    assert.equal(after.body.blockingIssues[0].code, 'PAYMENT_OBLIGATION_SETTLED')

    // A wrong record is voided with a reason, never deleted.
    const voidBase = `${base}/${rest.body.payment.id}`
    const noReason = await call(prisma, 'finance', 'POST', `${voidBase}/void-preview`, { expectedVersion: 0 })
    assert.equal(noReason.body.blockingIssues[0].code, 'PAYMENT_VOID_REASON_REQUIRED')
    const voided = await call(prisma, 'finance', 'POST', `${voidBase}/void`, { expectedVersion: 0, reason: 'Check 1042 bounced', idempotencyKey: 'pr-void-2' })
    assert.equal(voided.status, 200, JSON.stringify(voided.body))
    assert.equal(voided.body.payment.status, 'voided')
    assert.equal(voided.body.obligation.outstandingAmount, '65.0000')
    assert.equal(voided.body.obligation.status, 'partially_settled')
    const twice = await call(prisma, 'finance', 'POST', `${voidBase}/void`, { expectedVersion: 1, reason: 'Again', idempotencyKey: 'pr-void-2b' })
    assert.equal(twice.body.code, 'PAYMENT_ALREADY_VOIDED')
    assert.equal(await prisma.paymentRecord.count({ where: { tenantId } }), 2)
    // Voiding the first payment too brings the bill to pay back to approved.
    const firstVoid = await call(prisma, 'finance', 'POST', `${base}/${first.body.payment.id}/void`, { expectedVersion: 0, reason: 'Entered on the wrong bill', idempotencyKey: 'pr-void-1' })
    assert.equal(firstVoid.body.obligation.outstandingAmount, '105.0000')
    assert.equal(firstVoid.body.obligation.status, 'approved')

    // The bill shows its payments; a reader without amounts sees no money.
    const detail = await call(prisma, 'finance', 'GET', `/api/finance/supplier-invoices/${billId}`)
    assert.equal(detail.body.payable.payments.length, 2)
    assert.deepEqual(detail.body.payable.payments.map((row) => row.status).sort(), ['voided', 'voided'])
    assert.equal(detail.body.payable.paidAmount, '0.0000')
    assert.ok(detail.body.payable.availableActions.includes('record_payment'))
    const viewerDetail = await call(prisma, 'viewer', 'GET', `/api/finance/supplier-invoices/${billId}`)
    assert.equal(viewerDetail.status, 200)
    assert.equal(viewerDetail.body.payable.payments.length, 2)
    assert.equal(viewerDetail.body.payable.payments[0].amount, null)
    assert.equal(viewerDetail.body.payable.paidAmount, null)
    assert.deepEqual(viewerDetail.body.payable.availableActions, [])
    assert.deepEqual(viewerDetail.body.payable.payments[0].availableActions, [])

    // A held bill to pay is released before it takes a payment.
    const held = await approvedBill(prisma, command, 'B', '2026-09-15')
    await command.holdPayable(held.payableId, { expectedVersion: 0, reason: 'Waiting for a credit note', idempotencyKey: 'pr-hold-b' }, as('admin'))
    const heldPreview = await call(prisma, 'finance', 'POST', `/api/finance/payables/${held.payableId}/payments/preview`, payment({ expectedVersion: 1 }))
    assert.equal(heldPreview.body.blockingIssues[0].code, 'PAYMENT_OBLIGATION_HELD')

    // Receivables: the customer pays part, then the rest.
    const { invoiceId, receivableId } = await issuedInvoice(prisma, o2c, 'C')
    const receivableBase = `/api/finance/receivables/${receivableId}/payments`
    const part = await call(prisma, 'finance', 'POST', receivableBase, { expectedVersion: 0, paymentDate: today, amount: '30', currency: 'USD', method: 'check', reference: 'CHK-77', idempotencyKey: 'pr-rcv-1' })
    assert.equal(part.status, 201, JSON.stringify(part.body))
    assert.equal(part.body.obligation.outstandingAmount, '22.0000')
    assert.equal(part.body.obligation.status, 'partially_settled')
    const invoiceDetail = await call(prisma, 'finance', 'GET', `/api/finance/customer-invoices/${invoiceId}`)
    assert.equal(invoiceDetail.body.receivable.paidAmount, '30.0000')
    assert.equal(invoiceDetail.body.receivable.payments[0].reference, 'CHK-77')
    const full = await call(prisma, 'finance', 'POST', receivableBase, { expectedVersion: 1, paymentDate: today, amount: '22', method: 'wire', idempotencyKey: 'pr-rcv-2' })
    assert.equal(full.body.obligation.status, 'settled')

    // A disputed receivable takes no payment until the dispute is resolved.
    const disputed = await issuedInvoice(prisma, o2c, 'D')
    await o2c.disputeReceivable(disputed.receivableId, { expectedVersion: 0, reason: 'Short delivery', idempotencyKey: 'pr-dispute-d' }, as('admin'))
    const disputedPreview = await call(prisma, 'finance', 'POST', `/api/finance/receivables/${disputed.receivableId}/payments/preview`, { expectedVersion: 1, paymentDate: today, amount: '10', method: 'check' })
    assert.equal(disputedPreview.body.blockingIssues[0].code, 'PAYMENT_OBLIGATION_DISPUTED')

    // Every payment and void left an audit entry, and no money moved.
    const audits = await prisma.auditLog.findMany({ where: { tenantId, source: 'payment_record_command_service' } })
    assert.equal(audits.length, 6)
    assert.ok(audits.every((row) => row.metadata.paymentExecution === false && row.metadata.ledgerMutation === false))
  } finally {
    await prisma.$disconnect()
  }
})
