import assert from 'node:assert/strict'
import test, { after, before } from 'node:test'
import { backfillTenantAuthorization } from '../../server/auth/authorization-backfill.mjs'
import { createDbProcurementCommandService } from '../../server/domain/procurement-db-command-service.mjs'
import { createPrismaClient } from '../../server/persistence/prisma-client.mjs'
import { handleOperationalFinanceRoute } from '../../server/routes/operational-finance.routes.mjs'

// Three-way match and closing a purchase order (design audit B2, owner
// decision 2026-11-17), through the finance routes against PostgreSQL:
// - default tolerance per line: the larger of 2% and 1 currency unit;
//   quantity has none (L2-03 = L7-04);
// - a price difference is raised once, never also as an amount difference;
// - a quantity difference is not approved for payment: it is rejected, waits
//   for the receipt and the invoice is matched again (L2-04), or is accepted
//   at the received quantity and the payable covers what was received (L2-05);
// - a match keeps the rule it was made with: a match made before the rule
//   keeps approve on its quantity differences;
// - a PO with a supplier invoice is not cancelled, and is not closed while an
//   invoice difference waits for review (L1-10 / L7-03);
// - the server works out a line amount the form leaves out (L2-17), and the
//   bills of one PO line cannot pass what its receipts brought in (L2-07).
// Run with: node scripts/run-postgres-test-files.mjs tests/postgres/three-way-match-rules.test.mjs

const tenantId = 'tenant-three-way-match'
const admin = { id: 'twm-admin', role: 'admin' }
const env = { ...process.env, FLOWCHAIN_PERSISTENCE_MODE: 'database', FLOWCHAIN_ENABLE_DB_OPERATIONAL_FINANCE: 'true', NODE_ENV: 'test' }
const identity = { authenticated: true, tenantId, userId: admin.id, role: admin.role, source: 'signed-session' }
let prisma

async function call(method, path, body = {}) {
  let sent
  const ctx = {
    url: new URL(`http://local${path}`), req: { method, headers: {} }, res: {}, env,
    identity, operationalFinancePrisma: prisma,
    readBody: async () => body,
    send: (_res, status, payload) => { sent = { status, body: payload } },
  }
  assert.equal(await handleOperationalFinanceRoute(ctx), true)
  return sent
}

const money = (value) => Number(value).toFixed(4)
async function order(id, { quantity = '10', price = '10', status = 'approved' } = {}) {
  await prisma.purchaseOrder.create({ data: { id, tenantId, status, supplierId: 'TWM-SUP', supplierName: 'Harbor Supply', currency: 'USD', amount: money(Number(quantity) * Number(price)), lines: { create: { id: `${id}-L1`, itemId: 'TWM-ITEM', sku: 'TWM-SKU', itemName: 'Valve', orderedQuantity: quantity, receivedQuantity: '0', unit: 'EA', unitPrice: price } } } })
}
async function receipt(id, poId, accepted) {
  await prisma.receivingDocument.create({ data: { id, tenantId, documentNumber: id, poId, supplierId: 'TWM-SUP', supplierName: 'Harbor Supply', status: 'received', workflowStatus: 'posted', postingStatus: 'posted', postedAt: new Date(), postedById: admin.id, warehouseId: 'TWM-WH', currency: 'USD', lines: { create: { id: `${id}-L1`, purchaseOrderLineId: `${poId}-L1`, itemId: 'TWM-ITEM', sku: 'TWM-SKU', itemName: 'Valve', acceptedQty: accepted, rejectedQty: '0', unit: 'EA', warehouseId: 'TWM-WH', location: 'A-01', locationKey: 'a-01' } } } })
}
// A bill of one line, from a receipt (grnId) or against the order (null).
// The line amount is sent, exact for these figures. Each bill is dated ten
// days after the one before, so none looks like a duplicate of another.
let billCount = 0
const day = (offset) => new Date(Date.UTC(2026, 0, 1 + offset)).toISOString().slice(0, 10)
const bill = (poId, grnId, number, quantity, unitPrice) => {
  const amount = money(Number(quantity) * Number(unitPrice))
  billCount += 1
  return { invoiceNumber: number, supplierId: 'TWM-SUP', currency: 'USD', invoiceDate: day(10 * billCount), dueDate: day(10 * billCount + 30), totalAmount: amount, lines: [{ purchaseOrderLineId: `${poId}-L1`, receivingLineId: grnId ? `${grnId}-L1` : '', quantity, unitPrice, lineAmount: amount, enteredTaxAmount: '0' }] }
}
const versionOf = async (id) => (await prisma.supplierInvoice.findUnique({ where: { id } })).version
async function createAndSubmit(body) {
  const created = await call('POST', '/api/finance/supplier-invoices', { ...body, idempotencyKey: `${body.invoiceNumber}-create` })
  assert.equal(created.status, 201, JSON.stringify(created.body))
  const id = created.body.entityId
  const submitted = await call('POST', `/api/finance/supplier-invoices/${id}/submit`, { expectedVersion: 0, idempotencyKey: `${body.invoiceNumber}-submit` })
  assert.equal(submitted.status, 200, JSON.stringify(submitted.body))
  return id
}
async function match(id, key) {
  const result = await call('POST', `/api/finance/supplier-invoices/${id}/match`, { expectedVersion: await versionOf(id), idempotencyKey: key })
  assert.equal(result.status, 200, JSON.stringify(result.body))
  return result.body
}
const exceptionsOf = (id, where = {}) => prisma.financeMatchException.findMany({ where: { supplierInvoiceId: id, ...where }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })
const review = (exception, decision, key) => call('POST', `/api/finance/match-exceptions/${exception.id}/review`, { expectedVersion: exception.version, decision, resolution: 'Checked with the supplier', idempotencyKey: key })
const approve = async (id, key) => call('POST', `/api/finance/supplier-invoices/${id}/approve`, { expectedVersion: await versionOf(id), idempotencyKey: key })

before(async () => {
  assert.ok(process.env.DATABASE_URL_TEST, 'An isolated test database is required')
  prisma = await createPrismaClient(env)
  // No tolerances saved: the workspace uses the app defaults.
  await prisma.tenant.create({ data: { id: tenantId, name: tenantId, countryCode: 'US', locale: 'en-US', currency: 'USD', timezone: 'America/New_York' } })
  await prisma.user.create({ data: { ...admin, tenantId, email: `${admin.id}@three-way-match.invalid`, name: admin.id } })
  await backfillTenantAuthorization(prisma, tenantId, { actorId: admin.id })
  await prisma.supplier.create({ data: { id: 'TWM-SUP', tenantId, code: 'TWM-SUP', name: 'Harbor Supply' } })
  await prisma.item.create({ data: { id: 'TWM-ITEM', tenantId, sku: 'TWM-SKU', name: 'Valve', unit: 'EA' } })
  await prisma.warehouse.create({ data: { id: 'TWM-WH', tenantId, code: 'TWM-WH', name: 'Main' } })
})

after(async () => {
  await prisma?.$disconnect()
})

test('a price difference beyond the tolerance is one price exception, never also an amount exception', async () => {
  await order('TWM-PO-P1')
  await receipt('TWM-GRN-P1', 'TWM-PO-P1', '10')
  // 11.00 against 10.00 on 10 units: 10.00 over a line of 100.00.
  const id = await createAndSubmit(bill('TWM-PO-P1', 'TWM-GRN-P1', 'TWM-P1', '10', '11'))
  const result = await match(id, 'twm-p1-match')
  assert.equal(result.invoice.status, 'exception')
  const exceptions = await exceptionsOf(id)
  assert.deepEqual(exceptions.map((row) => row.exceptionType), ['price'])
  assert.equal(String(exceptions[0].varianceValue), '1')
  // The match keeps the rule and the tolerances it used.
  const run = await prisma.threeWayMatch.findFirst({ where: { invoiceId: id } })
  assert.equal(run.metadata.rule, 'per_line_2026_11')
  assert.deepEqual(run.metadata.tolerances, { quantity: '0.0000', pricePercentage: '2.0000', priceAbsolute: '0.0000', amount: '1.0000' })
})

test('the default price tolerance is the larger of 2% of the line and 1 currency unit, on both sides of each boundary', async () => {
  const cases = [
    // A line of 100.00: 2% (2.00) is the larger.
    { key: 'A', quantity: '10', price: '10', invoicePrice: '10.2', status: 'matched' },
    { key: 'B', quantity: '10', price: '10', invoicePrice: '10.21', status: 'exception' },
    { key: 'C', quantity: '10', price: '10', invoicePrice: '9.8', status: 'matched' },
    // A line of 10.00: 1 currency unit is larger than 2% (0.20).
    { key: 'D', quantity: '10', price: '1', invoicePrice: '1.1', status: 'matched' },
    { key: 'E', quantity: '10', price: '1', invoicePrice: '1.11', status: 'exception' },
    { key: 'F', quantity: '10', price: '1', invoicePrice: '0.89', status: 'exception' },
  ]
  for (const entry of cases) {
    await order(`TWM-PO-T${entry.key}`, { quantity: entry.quantity, price: entry.price })
    await receipt(`TWM-GRN-T${entry.key}`, `TWM-PO-T${entry.key}`, entry.quantity)
    const id = await createAndSubmit(bill(`TWM-PO-T${entry.key}`, `TWM-GRN-T${entry.key}`, `TWM-T${entry.key}`, entry.quantity, entry.invoicePrice))
    const result = await match(id, `twm-t${entry.key}-match`)
    assert.equal(result.invoice.status, entry.status, `case ${entry.key}`)
    assert.deepEqual((await exceptionsOf(id)).map((row) => row.exceptionType), entry.status === 'exception' ? ['price'] : [], `case ${entry.key}`)
  }
  // Quantity has no tolerance: one unit more than received is an exception.
  await order('TWM-PO-TQ')
  await receipt('TWM-GRN-TQ', 'TWM-PO-TQ', '9')
  const id = await createAndSubmit(bill('TWM-PO-TQ', null, 'TWM-TQ', '10', '10'))
  const linked = await call('POST', `/api/finance/supplier-invoices/${id}/link-receipt`, { expectedVersion: await versionOf(id), receivingDocumentId: 'TWM-GRN-TQ', idempotencyKey: 'twm-tq-link' })
  assert.equal(linked.status, 200, JSON.stringify(linked.body))
  assert.equal((await match(id, 'twm-tq-match')).invoice.status, 'exception')
  assert.deepEqual((await exceptionsOf(id)).map((row) => row.exceptionType), ['quantity'])
})

test('a quantity difference is not approved for payment; accepted at the received quantity, the payable covers what was received', async () => {
  await order('TWM-PO-Q1')
  await receipt('TWM-GRN-Q1', 'TWM-PO-Q1', '6')
  const id = await createAndSubmit(bill('TWM-PO-Q1', null, 'TWM-Q1', '10', '10'))
  await call('POST', `/api/finance/supplier-invoices/${id}/link-receipt`, { expectedVersion: await versionOf(id), receivingDocumentId: 'TWM-GRN-Q1', idempotencyKey: 'twm-q1-link' })
  await match(id, 'twm-q1-match')
  const [quantity] = await exceptionsOf(id)
  assert.equal(quantity.exceptionType, 'quantity')

  const preview = await call('POST', `/api/finance/match-exceptions/${quantity.id}/review-preview`, { expectedVersion: quantity.version, decision: 'approved', resolution: 'Pay it' })
  assert.equal(preview.body.allowed, false)
  assert.equal(preview.body.blockingIssues[0].code, 'MATCH_EXCEPTION_QUANTITY_NOT_APPROVABLE')
  const approved = await review(quantity, 'approved', 'twm-q1-approve-difference')
  assert.equal(approved.status, 409, JSON.stringify(approved.body))
  assert.equal(approved.body.code, 'MATCH_EXCEPTION_QUANTITY_NOT_APPROVABLE')
  assert.equal((await approve(id, 'twm-q1-approve-early')).status, 409)
  assert.equal(await prisma.payableObligation.count({ where: { supplierInvoiceId: id } }), 0)

  const accepted = await review(quantity, 'accept_received', 'twm-q1-accept')
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body))
  assert.equal(accepted.body.exception.status, 'approved')
  assert.equal(accepted.body.exception.acceptedAt, 'received_quantity')
  const approvePreview = await call('POST', `/api/finance/supplier-invoices/${id}/approve-preview`, { expectedVersion: await versionOf(id) })
  assert.equal(approvePreview.body.allowed, true, JSON.stringify(approvePreview.body.blockingIssues))
  assert.equal(approvePreview.body.after.originalAmount, '60.0000')
  assert.equal(approvePreview.body.after.notReceivedAmount, '40.0000')
  const approvedBill = await approve(id, 'twm-q1-approve')
  assert.equal(approvedBill.status, 200, JSON.stringify(approvedBill.body))
  const payable = await prisma.payableObligation.findUnique({ where: { supplierInvoiceId: id } })
  assert.deepEqual([String(payable.originalAmount), String(payable.outstandingAmount)], ['60', '60'])
  assert.equal(payable.metadata.receivedQuantityBasis.lines[0].payableQuantity, '6.0000')
  const detail = await call('GET', `/api/finance/supplier-invoices/${id}`)
  assert.equal(detail.body.payable.notReceivedAmount, '40.0000')
  assert.equal(detail.body.match.exceptions[0].acceptedAt, 'received_quantity')
})

test('a match made before the rule keeps it: its quantity difference can still be approved', async () => {
  await order('TWM-PO-OLD')
  await receipt('TWM-GRN-OLD', 'TWM-PO-OLD', '6')
  const id = await createAndSubmit(bill('TWM-PO-OLD', null, 'TWM-OLD', '10', '10'))
  await call('POST', `/api/finance/supplier-invoices/${id}/link-receipt`, { expectedVersion: await versionOf(id), receivingDocumentId: 'TWM-GRN-OLD', idempotencyKey: 'twm-old-link' })
  await match(id, 'twm-old-match')
  // As a match recorded before 2026-11-17 is stored: no rule on it.
  await prisma.threeWayMatch.updateMany({ where: { invoiceId: id }, data: { metadata: {} } })
  const [quantity] = await exceptionsOf(id)
  const notForOld = await review(quantity, 'accept_received', 'twm-old-accept')
  assert.equal(notForOld.status, 422, JSON.stringify(notForOld.body))
  const approved = await review(quantity, 'approved', 'twm-old-approve-difference')
  assert.equal(approved.status, 200, JSON.stringify(approved.body))
  const approvedBill = await approve(id, 'twm-old-approve')
  assert.equal(approvedBill.status, 200, JSON.stringify(approvedBill.body))
  const payable = await prisma.payableObligation.findUnique({ where: { supplierInvoiceId: id } })
  assert.equal(String(payable.originalAmount), '100')
})

test('a receipt posted after the match held the invoice lets it be matched again, and the earlier match is superseded', async () => {
  await order('TWM-PO-R1')
  await receipt('TWM-GRN-R1A', 'TWM-PO-R1', '6')
  const id = await createAndSubmit(bill('TWM-PO-R1', null, 'TWM-R1', '10', '10'))
  await call('POST', `/api/finance/supplier-invoices/${id}/link-receipt`, { expectedVersion: await versionOf(id), receivingDocumentId: 'TWM-GRN-R1A', idempotencyKey: 'twm-r1-link' })
  const first = await match(id, 'twm-r1-match-1')
  assert.equal(first.invoice.status, 'exception')
  // Matching again before the goods arrive finds the same difference.
  const early = await match(id, 'twm-r1-match-early')
  assert.equal(early.invoice.status, 'exception')
  assert.equal((await exceptionsOf(id, { status: 'open' })).length, 1)

  // The rest arrives on a second receipt.
  await receipt('TWM-GRN-R1B', 'TWM-PO-R1', '4')
  let detail = await call('GET', `/api/finance/supplier-invoices/${id}`)
  assert.ok(detail.body.availableActions.includes('match'), JSON.stringify(detail.body.availableActions))
  const again = await match(id, 'twm-r1-match-2')
  assert.equal(again.invoice.status, 'matched')
  const runs = await prisma.threeWayMatch.findMany({ where: { invoiceId: id }, orderBy: { createdAt: 'asc' } })
  assert.deepEqual(runs.map((run) => run.status), ['superseded', 'superseded', 'matched'])
  assert.deepEqual((await exceptionsOf(id)).map((row) => row.status), ['resolved', 'resolved'])
  assert.match((await exceptionsOf(id))[1].resolution, /^Superseded by match /)
  const matchLine = await prisma.threeWayMatchLine.findFirst({ where: { matchId: runs[2].id } })
  assert.equal(String(matchLine.receivedQuantity), '10')
  detail = await call('GET', `/api/finance/supplier-invoices/${id}`)
  assert.equal(detail.body.match.id, runs[2].id)
  assert.ok(detail.body.availableActions.includes('approve'))
  const approvedBill = await approve(id, 'twm-r1-approve')
  assert.equal(approvedBill.status, 200, JSON.stringify(approvedBill.body))
  assert.equal(String((await prisma.payableObligation.findUnique({ where: { supplierInvoiceId: id } })).originalAmount), '100')

  // An invoice whose every difference was accepted is approved, not matched again.
  await order('TWM-PO-R2')
  await receipt('TWM-GRN-R2', 'TWM-PO-R2', '10')
  const priced = await createAndSubmit(bill('TWM-PO-R2', 'TWM-GRN-R2', 'TWM-R2', '10', '11'))
  await match(priced, 'twm-r2-match')
  const [price] = await exceptionsOf(priced)
  assert.equal((await review(price, 'approved', 'twm-r2-approve-difference')).status, 200)
  const refused = await call('POST', `/api/finance/supplier-invoices/${priced}/match`, { expectedVersion: await versionOf(priced), idempotencyKey: 'twm-r2-match-again' })
  assert.equal(refused.status, 409)
  assert.equal(refused.body.code, 'SUPPLIER_INVOICE_MATCH_REVIEWED')
})

test('a PO with a supplier invoice is not cancelled, and is not closed while an invoice difference waits for review', async () => {
  const context = { identity }
  const orders = createDbProcurementCommandService({ prisma, env })
  const versionOfOrder = async (id) => (await prisma.purchaseOrder.findUnique({ where: { id } })).version
  const expectError = async (promise, code) => assert.rejects(promise, (error) => { assert.equal(error.code, code, error.message); return true })

  // An approved PO with a bill recorded before the goods arrive.
  await order('TWM-PO-C1')
  const waiting = await createAndSubmit(bill('TWM-PO-C1', null, 'TWM-C1', '10', '10'))
  await expectError(orders.cancelPurchaseOrder('TWM-PO-C1', { expectedVersion: await versionOfOrder('TWM-PO-C1'), idempotencyKey: 'twm-c1-cancel', reason: 'No longer needed' }, context), 'PURCHASE_ORDER_HAS_SUPPLIER_INVOICES')
  assert.equal((await prisma.purchaseOrder.findUnique({ where: { id: 'TWM-PO-C1' } })).status, 'approved')
  // Once the bill is cancelled, the order can be.
  await call('POST', `/api/finance/supplier-invoices/${waiting}/cancel`, { expectedVersion: await versionOf(waiting), reason: 'Entered by mistake', idempotencyKey: 'twm-c1-bill-cancel' })
  const cancelled = await orders.cancelPurchaseOrder('TWM-PO-C1', { expectedVersion: await versionOfOrder('TWM-PO-C1'), idempotencyKey: 'twm-c1-cancel-2', reason: 'No longer needed' }, context)
  assert.equal(cancelled.status, 'cancelled')

  // A partly received PO whose invoice the match held at a price difference.
  await order('TWM-PO-C2', { status: 'partially_received' })
  await receipt('TWM-GRN-C2', 'TWM-PO-C2', '6')
  const held = await createAndSubmit(bill('TWM-PO-C2', 'TWM-GRN-C2', 'TWM-C2', '6', '12'))
  await match(held, 'twm-c2-match')
  await expectError(orders.closePurchaseOrder('TWM-PO-C2', { expectedVersion: await versionOfOrder('TWM-PO-C2'), idempotencyKey: 'twm-c2-close', reason: 'Supplier will not send the rest' }, context), 'PURCHASE_ORDER_HAS_INVOICE_EXCEPTIONS')
  const [price] = await exceptionsOf(held)
  assert.equal((await review(price, 'rejected', 'twm-c2-reject')).status, 200)
  const closed = await orders.closePurchaseOrder('TWM-PO-C2', { expectedVersion: await versionOfOrder('TWM-PO-C2'), idempotencyKey: 'twm-c2-close-2', reason: 'Supplier will not send the rest' }, context)
  assert.equal(closed.status, 'closed')
})

test('the server works out a line amount the form leaves out, to four decimals as it rounds', async () => {
  await order('TWM-PO-L1', { quantity: '2.5', price: '1.0001' })
  await receipt('TWM-GRN-L1', 'TWM-PO-L1', '2.5')
  // 2.5 × 1.0001 = 2.50025: 2.5003 on the server (the browser's floating
  // point gave 2.5002 and the save was refused).
  const body = bill('TWM-PO-L1', 'TWM-GRN-L1', 'TWM-L1', '2.5', '1.0001')
  delete body.totalAmount
  delete body.lines[0].lineAmount
  const created = await call('POST', '/api/finance/supplier-invoices', { ...body, idempotencyKey: 'twm-l1-create' })
  assert.equal(created.status, 201, JSON.stringify(created.body))
  const line = await prisma.supplierInvoiceLine.findFirst({ where: { supplierInvoiceId: created.body.entityId } })
  assert.equal(String(line.lineAmount), '2.5003')
  assert.equal(String((await prisma.supplierInvoice.findUnique({ where: { id: created.body.entityId } })).totalAmount), '2.5003')
})

test('bills of one PO line, before and after its receipt, cannot pass what was received on the line', async () => {
  await order('TWM-PO-D1')
  // A bill for all 10 recorded before the goods, then the receipt of 10, then
  // a second bill for the same 10 from the receipt.
  await createAndSubmit(bill('TWM-PO-D1', null, 'TWM-D1', '10', '10'))
  await receipt('TWM-GRN-D1', 'TWM-PO-D1', '10')
  const created = await call('POST', '/api/finance/supplier-invoices', { ...bill('TWM-PO-D1', 'TWM-GRN-D1', 'TWM-D2', '10', '10'), idempotencyKey: 'twm-d2-create' })
  assert.equal(created.status, 201, JSON.stringify(created.body))
  const submitted = await call('POST', `/api/finance/supplier-invoices/${created.body.entityId}/submit`, { expectedVersion: 0, idempotencyKey: 'twm-d2-submit' })
  assert.equal(submitted.status, 409, JSON.stringify(submitted.body))
  assert.equal(submitted.body.code, 'SUPPLIER_INVOICE_QUANTITY_EXCEEDS_RECEIVED')
})
