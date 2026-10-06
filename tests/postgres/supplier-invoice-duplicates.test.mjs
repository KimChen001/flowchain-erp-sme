import assert from 'node:assert/strict'
import test from 'node:test'
import { backfillTenantAuthorization } from '../../server/auth/authorization-backfill.mjs'
import { createPrismaClient } from '../../server/persistence/prisma-client.mjs'
import { handleOperationalFinanceRoute } from '../../server/routes/operational-finance.routes.mjs'

// Duplicate supplier invoice checks (plan item C1, decision 9). A bill whose
// number matches another bill of the supplier once format is set aside is a
// likely duplicate; one with the same currency and total dated within 7 days
// is a possible one. The flags are shown on the bill and at approval; the
// approver dismisses each with a reason (audited) or cancels the bill. Nothing
// is held on its own. Called through the finance routes against PostgreSQL.
// Run with: node scripts/run-postgres-test-files.mjs tests/postgres/supplier-invoice-duplicates.test.mjs

const tenantId = 'tenant-invoice-duplicates'
const otherTenantId = 'tenant-invoice-duplicates-other'
const users = {
  admin: { id: 'dup-admin', role: 'admin', name: 'Dana Admin' },
  finance: { id: 'dup-finance', role: 'finance-specialist', name: 'Frank Finance' },
  viewer: { id: 'dup-viewer', role: 'viewer', name: 'Vera Viewer' },
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

const PO = 'DUP-PO-1'
async function receipt(prisma, id) {
  await prisma.receivingDocument.create({ data: { id, tenantId, documentNumber: id, poId: PO, supplierId: 'DUP-SUP', supplierName: 'Harbor Supply', status: 'received', workflowStatus: 'posted', postingStatus: 'posted', postedAt: new Date(), postedById: users.admin.id, warehouseId: 'DUP-WH', currency: 'USD', lines: { create: { id: `${id}-L1`, purchaseOrderLineId: `${PO}-L1`, itemId: 'DUP-ITEM', sku: 'DUP-SKU', itemName: 'Valve', acceptedQty: '5.0000', rejectedQty: '0.0000', unit: 'EA', warehouseId: 'DUP-WH', location: 'A-01', locationKey: 'a-01' } } } })
}

// A bill for part of one receipt, at 10.0000 a unit.
const bill = (grn, number, invoiceDate, quantity = '5.0000') => {
  const amount = (Number(quantity) * 10).toFixed(4)
  return { invoiceNumber: number, supplierId: 'DUP-SUP', currency: 'USD', invoiceDate, dueDate: '2026-10-30', totalAmount: amount, lines: [{ purchaseOrderLineId: `${PO}-L1`, receivingLineId: `${grn}-L1`, quantity, unitPrice: '10.0000', lineAmount: amount, enteredTaxAmount: '0' }] }
}

test('likely and possible duplicate bills are flagged, dismissed with a reason, then approved', async () => {
  assert.ok(process.env.DATABASE_URL_TEST, 'An isolated test database is required')
  const prisma = await createPrismaClient(env)
  try {
    for (const id of [tenantId, otherTenantId])
      await prisma.tenant.create({ data: { id, name: id, countryCode: 'US', locale: 'en-US', currency: 'USD', timezone: 'America/New_York', operationalSettings: { review: { quantityTolerance: '0.0000', pricePercentageTolerance: '0.0000', priceAbsoluteTolerance: '0.0000', amountTolerance: '0.0000' } } } })
    for (const user of Object.values(users)) await prisma.user.create({ data: { ...user, tenantId, email: `${user.id}@invoice-duplicates.invalid` } })
    await backfillTenantAuthorization(prisma, tenantId, { actorId: users.admin.id })
    await prisma.supplier.create({ data: { id: 'DUP-SUP', tenantId, code: 'DUP-SUP', name: 'Harbor Supply' } })
    await prisma.item.create({ data: { id: 'DUP-ITEM', tenantId, sku: 'DUP-SKU', name: 'Valve', unit: 'EA' } })
    await prisma.warehouse.create({ data: { id: 'DUP-WH', tenantId, code: 'DUP-WH', name: 'Main' } })
    await prisma.purchaseOrder.create({ data: { id: PO, tenantId, status: 'approved', supplierId: 'DUP-SUP', supplierName: 'Harbor Supply', currency: 'USD', amount: '200.0000', lines: { create: { id: `${PO}-L1`, itemId: 'DUP-ITEM', sku: 'DUP-SKU', itemName: 'Valve', orderedQuantity: '20.0000', receivedQuantity: '0.0000', unit: 'EA', unitPrice: '10.0000' } } } })
    for (const grn of ['DUP-GRN-1', 'DUP-GRN-2', 'DUP-GRN-3', 'DUP-GRN-4']) await receipt(prisma, grn)

    // Another workspace's bill with the same supplier id, number, amount and
    // date is never compared.
    await prisma.supplierInvoice.create({ data: { id: 'DUP-OTHER-TENANT', tenantId: otherTenantId, supplierId: 'DUP-SUP', invoiceNumber: 'INV-2024-001', invoiceDate: new Date('2026-09-01'), totalAmount: '50.0000', amount: '50.0000', currency: 'USD', status: 'submitted' } })

    const create = async (input, key) => {
      const created = await call(prisma, 'finance', 'POST', '/api/finance/supplier-invoices', { ...input, idempotencyKey: key })
      assert.equal(created.status, 201, JSON.stringify(created.body))
      return created.body.entityId
    }
    // A: the original. B: the same number written differently, 19 days later.
    // C: another number, the same total, 4 days after A.
    const a = await create(bill('DUP-GRN-1', 'INV-2024-001', '2026-09-01'), 'dup-create-a')
    const b = await create(bill('DUP-GRN-2', 'inv 2024/1', '2026-09-20'), 'dup-create-b')
    const c = await create(bill('DUP-GRN-3', 'C-77', '2026-09-05'), 'dup-create-c')
    // The exact same number is still refused outright by the unique index.
    const exact = await call(prisma, 'finance', 'POST', '/api/finance/supplier-invoices', { ...bill('DUP-GRN-4', 'INV-2024-001', '2026-09-02', '1.0000'), idempotencyKey: 'dup-create-exact' })
    assert.equal(exact.status, 409)
    assert.equal(exact.body.code, 'SUPPLIER_INVOICE_NUMBER_DUPLICATE')

    let detail = await call(prisma, 'finance', 'GET', `/api/finance/supplier-invoices/${a}`)
    assert.equal(detail.status, 200)
    let checks = detail.body.duplicateChecks
    assert.equal(checks.windowDays, 7)
    assert.deepEqual(checks.notChecked, [])
    assert.equal(checks.possibleHidden, false)
    assert.deepEqual(checks.flags.map((flag) => [flag.kind, flag.otherInvoiceId, flag.daysApart, flag.status]), [['likely', b, 19, 'open'], ['possible', c, 4, 'open']])
    assert.deepEqual(
      { ...checks.flags[1].otherInvoice, fieldVisibility: undefined },
      { id: c, invoiceNumber: 'C-77', invoiceDate: '2026-09-05', totalAmount: '50', currency: 'USD', status: 'draft', version: 0, fieldVisibility: undefined },
    )
    assert.ok(detail.body.availableActions.includes('dismiss_duplicate'))

    // Without finance.amounts.read the same-amount flag is left out.
    const hidden = await call(prisma, 'viewer', 'GET', `/api/finance/supplier-invoices/${a}`)
    assert.equal(hidden.status, 200)
    assert.equal(hidden.body.duplicateChecks.possibleHidden, true)
    assert.deepEqual(hidden.body.duplicateChecks.flags.map((flag) => flag.kind), ['likely'])
    assert.equal(hidden.body.duplicateChecks.flags[0].otherInvoice.totalAmount, null)
    assert.ok(!hidden.body.availableActions.includes('dismiss_duplicate'))

    // Approval asks for the review first; nothing else is held.
    for (const [step, version] of [['submit', 0], ['match', 1]]) {
      const done = await call(prisma, 'finance', 'POST', `/api/finance/supplier-invoices/${a}/${step}`, { expectedVersion: version, idempotencyKey: `dup-${step}-a` })
      assert.equal(done.status, 200, JSON.stringify(done.body))
    }
    const preview = await call(prisma, 'finance', 'POST', `/api/finance/supplier-invoices/${a}/approve-preview`, { expectedVersion: 2 })
    assert.equal(preview.body.allowed, false)
    const issue = preview.body.blockingIssues.find((entry) => entry.code === 'DUPLICATE_REVIEW_REQUIRED')
    assert.ok(issue, JSON.stringify(preview.body.blockingIssues))
    assert.deepEqual(issue.details.flags.map((flag) => flag.otherInvoiceId), [b, c])
    const early = await call(prisma, 'finance', 'POST', `/api/finance/supplier-invoices/${a}/approve`, { expectedVersion: 2, idempotencyKey: 'dup-approve-early' })
    assert.equal(early.status, 409)
    assert.equal(early.body.code, 'DUPLICATE_REVIEW_REQUIRED')
    assert.equal(await prisma.payableObligation.count({ where: { tenantId } }), 0)

    // A dismissal needs a reason, the approve permission, a flag that holds
    // and the other bill's version as it was shown (B and C are drafts at 0).
    const dismiss = (key, body, idempotencyKey) => call(prisma, key, 'POST', `/api/finance/supplier-invoices/${a}/duplicate-dismiss`, { expectedVersion: 2, otherVersion: 0, idempotencyKey, ...body })
    const blank = await dismiss('finance', { otherInvoiceId: b, kind: 'likely', reason: '  ' }, 'dup-dismiss-blank')
    assert.equal(blank.status, 422)
    assert.equal(blank.body.code, 'DUPLICATE_DISMISS_REASON_REQUIRED')
    const blankPreview = await call(prisma, 'finance', 'POST', `/api/finance/supplier-invoices/${a}/duplicate-dismiss-preview`, { expectedVersion: 2, otherInvoiceId: b, otherVersion: 0, kind: 'likely', reason: '' })
    assert.equal(blankPreview.body.allowed, false)
    assert.equal(blankPreview.body.blockingIssues[0].code, 'DUPLICATE_DISMISS_REASON_REQUIRED')
    assert.equal((await dismiss('viewer', { otherInvoiceId: b, kind: 'likely', reason: 'Not mine' }, 'dup-dismiss-viewer')).status, 403)
    const wrongKind = await dismiss('finance', { otherInvoiceId: b, kind: 'possible', reason: 'No' }, 'dup-dismiss-wrong')
    assert.equal(wrongKind.status, 409)
    assert.equal(wrongKind.body.code, 'DUPLICATE_FLAG_NOT_FOUND')
    // A dismissal is never recorded against a state of the other bill the
    // approver did not see.
    const changedPreview = await call(prisma, 'finance', 'POST', `/api/finance/supplier-invoices/${a}/duplicate-dismiss-preview`, { expectedVersion: 2, otherInvoiceId: b, otherVersion: 4, kind: 'likely', reason: 'Seen before' })
    assert.deepEqual(changedPreview.body.blockingIssues.map((entry) => entry.code), ['DUPLICATE_FLAG_CHANGED'])
    const changed = await dismiss('finance', { otherInvoiceId: b, otherVersion: 4, kind: 'likely', reason: 'Seen before' }, 'dup-dismiss-changed')
    assert.equal(changed.status, 409)
    assert.equal(changed.body.code, 'DUPLICATE_FLAG_CHANGED')
    const okPreview = await call(prisma, 'finance', 'POST', `/api/finance/supplier-invoices/${a}/duplicate-dismiss-preview`, { expectedVersion: 2, otherInvoiceId: b, otherVersion: 0, kind: 'likely', reason: 'Supplier reissued under a new number' })
    assert.equal(okPreview.body.allowed, true, JSON.stringify(okPreview.body.blockingIssues))
    assert.equal(okPreview.body.openFlagsAfter, 1)

    const first = await dismiss('finance', { otherInvoiceId: b, kind: 'likely', reason: 'Supplier reissued under a new number' }, 'dup-dismiss-b')
    assert.equal(first.status, 200, JSON.stringify(first.body))
    assert.equal(first.body.idempotentReplay, false)
    assert.equal(first.body.invoice.version, 2)
    const replay = await dismiss('finance', { otherInvoiceId: b, kind: 'likely', reason: 'Supplier reissued under a new number' }, 'dup-dismiss-b')
    assert.equal(replay.body.idempotentReplay, true)
    assert.equal(await prisma.supplierInvoiceDuplicateReview.count({ where: { tenantId } }), 1)
    const again = await dismiss('finance', { otherInvoiceId: b, kind: 'likely', reason: 'Twice' }, 'dup-dismiss-b-again')
    assert.equal(again.body.code, 'DUPLICATE_FLAG_NOT_FOUND')

    // Still one open flag, so approval still waits.
    assert.equal((await call(prisma, 'finance', 'POST', `/api/finance/supplier-invoices/${a}/approve`, { expectedVersion: 2, idempotencyKey: 'dup-approve-half' })).body.code, 'DUPLICATE_REVIEW_REQUIRED')
    const second = await dismiss('finance', { otherInvoiceId: c, kind: 'possible', reason: 'Two separate deliveries of the same size' }, 'dup-dismiss-c')
    assert.equal(second.status, 200, JSON.stringify(second.body))

    const audits = await prisma.auditLog.findMany({ where: { tenantId, action: 'supplier_invoice_duplicate_dismissed' }, orderBy: { createdAt: 'asc' } })
    assert.equal(audits.length, 2)
    assert.equal(audits[0].actorId, users.finance.id)
    assert.equal(audits[0].metadata.evidence.reason, 'Supplier reissued under a new number')
    assert.equal(audits[0].metadata.evidence.otherInvoiceId, b)
    assert.equal(audits[0].metadata.evidence.kind, 'likely')
    assert.equal(audits[0].metadata.evidence.otherVersion, 0)
    assert.equal(audits[0].metadata.evidence.numberKey, 'inv20241')
    assert.deepEqual(audits[0].metadata.evidence.basis.other.numberKeys, ['inv20241'])

    detail = await call(prisma, 'finance', 'GET', `/api/finance/supplier-invoices/${a}`)
    checks = detail.body.duplicateChecks
    assert.deepEqual(checks.flags.map((flag) => flag.status), ['dismissed', 'dismissed'])
    assert.equal(checks.flags[0].dismissal.dismissedByName, 'Frank Finance')
    assert.equal(checks.flags[0].dismissal.reason, 'Supplier reissued under a new number')
    assert.equal(checks.reviews.length, 2)
    assert.ok(checks.reviews.every((review) => review.stale === false))
    assert.ok(!detail.body.availableActions.includes('dismiss_duplicate'))

    const approved = await call(prisma, 'finance', 'POST', `/api/finance/supplier-invoices/${a}/approve`, { expectedVersion: 2, idempotencyKey: 'dup-approve-a' })
    assert.equal(approved.status, 200, JSON.stringify(approved.body))

    // The flags are symmetric: B's approver still has to look at A, and sees
    // A's dismissal beside the open flag.
    const bDetail = await call(prisma, 'finance', 'GET', `/api/finance/supplier-invoices/${b}`)
    assert.deepEqual(bDetail.body.duplicateChecks.flags.map((flag) => [flag.kind, flag.otherInvoiceId, flag.status, flag.otherInvoice.status]), [['likely', a, 'open', 'approved']])
    assert.equal(bDetail.body.duplicateChecks.flags[0].dismissal, null)
    assert.equal(bDetail.body.duplicateChecks.flags[0].otherSideDismissal.reason, 'Supplier reissued under a new number')
    assert.equal(bDetail.body.duplicateChecks.flags[0].otherSideDismissal.dismissedByName, 'Frank Finance')
    assert.deepEqual(bDetail.body.duplicateChecks.reviews, [])
    const approvedVersion = bDetail.body.duplicateChecks.flags[0].otherInvoice.version
    // On the approved bill, A, the flags are settled: dismissed, never open.
    detail = await call(prisma, 'finance', 'GET', `/api/finance/supplier-invoices/${a}`)
    assert.deepEqual(detail.body.duplicateChecks.flags.map((flag) => flag.status), ['dismissed', 'dismissed'])
    // An approved bill's flags can no longer be dismissed.
    const late = await dismiss('finance', { otherInvoiceId: b, kind: 'likely', reason: 'Late', expectedVersion: 3 }, 'dup-dismiss-late')
    assert.equal(late.body.code, 'SUPPLIER_INVOICE_STATUS_INVALID')

    // Revising a draft after its dismissal reopens the flag: C dismisses its
    // flag against A, then moves its date by a day.
    const cDismiss = await call(prisma, 'finance', 'POST', `/api/finance/supplier-invoices/${c}/duplicate-dismiss`, { expectedVersion: 0, otherInvoiceId: a, otherVersion: approvedVersion, kind: 'possible', reason: 'Separate delivery', idempotencyKey: 'dup-dismiss-c-a' })
    assert.equal(cDismiss.status, 200, JSON.stringify(cDismiss.body))
    detail = await call(prisma, 'finance', 'GET', `/api/finance/supplier-invoices/${a}`)
    assert.equal(detail.body.duplicateChecks.flags[1].otherSideDismissal.reason, 'Separate delivery')
    const revised = await call(prisma, 'finance', 'PATCH', `/api/finance/supplier-invoices/${c}`, { ...bill('DUP-GRN-3', 'C-77', '2026-09-06'), expectedVersion: 0, idempotencyKey: 'dup-revise-c' })
    assert.equal(revised.status, 200, JSON.stringify(revised.body))
    let cDetail = await call(prisma, 'finance', 'GET', `/api/finance/supplier-invoices/${c}`)
    assert.deepEqual(cDetail.body.duplicateChecks.flags.map((flag) => [flag.kind, flag.otherInvoiceId, flag.daysApart, flag.status]), [['possible', a, 5, 'open']])
    assert.equal(cDetail.body.duplicateChecks.reviews.length, 1)
    assert.equal(cDetail.body.duplicateChecks.reviews[0].stale, true)
    // A's own dismissal of C no longer applies either. A is approved, so the
    // flag is closed (shown for information), not open.
    detail = await call(prisma, 'finance', 'GET', `/api/finance/supplier-invoices/${a}`)
    assert.deepEqual(detail.body.duplicateChecks.flags.map((flag) => [flag.kind, flag.status]), [['likely', 'dismissed'], ['possible', 'closed']])
    assert.equal(detail.body.duplicateChecks.flags[1].otherSideDismissal, null)
    assert.equal(detail.body.duplicateChecks.openCount, 0)

    // Cancelling the original clears the flag of the bill that matched it.
    const d = await create(bill('DUP-GRN-4', 'C 0077', '2026-09-28', '4.0000'), 'dup-create-d')
    let dDetail = await call(prisma, 'finance', 'GET', `/api/finance/supplier-invoices/${d}`)
    assert.deepEqual(dDetail.body.duplicateChecks.flags.map((flag) => [flag.kind, flag.otherInvoiceId]), [['likely', c]])
    const cancelled = await call(prisma, 'finance', 'POST', `/api/finance/supplier-invoices/${c}/cancel`, { expectedVersion: 1, reason: 'Entered twice', idempotencyKey: 'dup-cancel-c' })
    assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body))
    dDetail = await call(prisma, 'finance', 'GET', `/api/finance/supplier-invoices/${d}`)
    assert.deepEqual(dDetail.body.duplicateChecks.flags, [])
    cDetail = await call(prisma, 'finance', 'GET', `/api/finance/supplier-invoices/${c}`)
    assert.ok(!cDetail.body.availableActions.includes('dismiss_duplicate'))
  } finally {
    await prisma.$disconnect()
  }
})
