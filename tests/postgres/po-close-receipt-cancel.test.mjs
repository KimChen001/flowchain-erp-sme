import assert from 'node:assert/strict'
import test from 'node:test'
import { backfillTenantAuthorization } from '../../server/auth/authorization-backfill.mjs'
import { isOpenPurchaseOrder } from '../../server/domain/open-purchase-order.mjs'
import { createDbProcurementCommandService } from '../../server/domain/procurement-db-command-service.mjs'
import { createReceivingDraftCommandService, RECEIVING_DRAFT_CHANNELS } from '../../server/domain/receiving-draft-command-service.mjs'
import { createReceivingPostingCommandService } from '../../server/domain/receiving-posting-command-service.mjs'
import { createPrismaClient } from '../../server/persistence/prisma-client.mjs'

// An issued PO the supplier will not finish can be closed, and a receipt that
// was started by mistake can be cancelled. A supplier ships 6 of 10 and drops
// the rest; a stray receipt draft blocks closing until it is cancelled; the
// closed PO keeps its receipt, is no longer open or receivable, and stays
// closed when its receipt is reversed.
// Run with: node scripts/run-postgres-test-files.mjs tests/postgres/po-close-receipt-cancel.test.mjs

const tenantId = 'tenant-po-close'
const expectError = async (promise, code) => {
  await assert.rejects(promise, (error) => { assert.equal(error.code, code, error.message); return true })
}

test('a short-shipped PO is closed after its stray receipt is cancelled', async () => {
  assert.ok(process.env.DATABASE_URL_TEST, 'An isolated test database is required')
  const prisma = await createPrismaClient(process.env)
  try {
    await prisma.tenant.create({ data: { id: tenantId, name: tenantId, countryCode: 'US', locale: 'en-US', currency: 'USD', timezone: 'America/New_York' } })
    await prisma.warehouse.create({ data: { id: 'PC-WH', tenantId, code: 'PC-WH', name: 'Main', status: 'active' } })
    for (const [id, role] of [['pc-admin', 'admin'], ['pc-buyer', 'buyer']]) await prisma.user.create({ data: { id, tenantId, email: `${id}@po-close.invalid`, name: id, role } })
    await backfillTenantAuthorization(prisma, tenantId, { actorId: 'pc-admin' })
    await prisma.item.create({ data: { id: 'PC-ITEM', tenantId, sku: 'PC-SKU', name: 'Valve', unit: 'EA' } })
    await prisma.purchaseOrder.create({ data: { id: 'PC-PO', tenantId, status: 'approved', supplierId: 'PC-SUP', supplierName: 'Harbor Supply', currency: 'USD', amount: '100.0000', lines: { create: { id: 'PC-POL', itemId: 'PC-ITEM', sku: 'PC-SKU', itemName: 'Valve', orderedQuantity: '10.0000', receivedQuantity: '0.0000', unit: 'EA', unitPrice: '10.0000', amount: '100.0000' } } } })
    const admin = { identity: { authenticated: true, tenantId, userId: 'pc-admin', role: 'admin', source: 'signed-session' } }
    const buyer = { identity: { authenticated: true, tenantId, userId: 'pc-buyer', role: 'buyer', source: 'signed-session' } }
    const orders = createDbProcurementCommandService({ prisma, env: process.env })
    const drafts = createReceivingDraftCommandService({ prisma })
    const posting = createReceivingPostingCommandService({ prisma })
    const version = async () => (await prisma.purchaseOrder.findUnique({ where: { id: 'PC-PO' } })).version
    const receipt = (key, quantity) => drafts.createDraft({ poId: 'PC-PO', warehouseId: 'PC-WH', idempotencyKey: key, lines: [{ purchaseOrderLineId: 'PC-POL', acceptedQuantity: quantity, location: 'A-01' }] }, admin)

    await orders.issuePurchaseOrder('PC-PO', { expectedVersion: await version(), idempotencyKey: 'pc-issue' }, admin)
    // 6 of 10 arrive and are posted.
    const first = await receipt('pc-grn-1', '6')
    const submitted = await drafts.submitDraft(first.entityId, { expectedVersion: first.receivingDocument.version, idempotencyKey: 'pc-grn-1-submit' }, admin)
    await posting.postReceiving({ receivingDocumentId: first.entityId, idempotencyKey: 'pc-grn-1-post' }, admin)
    assert.equal((await prisma.purchaseOrder.findUnique({ where: { id: 'PC-PO' } })).status, 'partially_received')
    assert.ok(submitted)

    // A receipt started by mistake blocks closing, and names the receipt.
    const stray = await receipt('pc-grn-2', '1')
    await expectError(orders.closePurchaseOrder('PC-PO', { expectedVersion: await version(), idempotencyKey: 'pc-close-early', reason: 'Supplier cancelled the rest' }, admin), 'PURCHASE_ORDER_HAS_OPEN_RECEIPTS')

    // Cancelling the stray receipt needs a reason and keeps it on record.
    await expectError(drafts.cancelDraft(stray.entityId, { expectedVersion: stray.receivingDocument.version, idempotencyKey: 'pc-grn-2-cancel-0' }, admin), 'RECEIVING_CANCEL_REASON_REQUIRED')
    await drafts.cancelDraft(stray.entityId, { expectedVersion: stray.receivingDocument.version, idempotencyKey: 'pc-grn-2-cancel', reason: 'Started by mistake' }, admin)
    const cancelled = await prisma.receivingDocument.findUnique({ where: { id: stray.entityId }, include: { lines: true } })
    assert.deepEqual([cancelled.workflowStatus, cancelled.postingStatus, cancelled.lines.length, cancelled.metadata.cancelReason], ['cancelled', 'unposted', 1, 'Started by mistake'])
    await expectError(drafts.submitDraft(stray.entityId, { expectedVersion: cancelled.version, idempotencyKey: 'pc-grn-2-submit' }, admin), 'RECEIVING_WORKFLOW_CONFLICT')
    // A posted receipt is reversed, not cancelled.
    await expectError(drafts.cancelDraft(first.entityId, { expectedVersion: (await prisma.receivingDocument.findUnique({ where: { id: first.entityId } })).version, idempotencyKey: 'pc-grn-1-cancel', reason: 'No' }, admin), 'RECEIVING_WORKFLOW_CONFLICT')

    // Closing needs a reason and the reject permission, which the buyer lacks.
    await expectError(orders.closePurchaseOrder('PC-PO', { expectedVersion: await version(), idempotencyKey: 'pc-close-noreason' }, admin), 'PO_ACTION_REASON_REQUIRED')
    await expectError(orders.closePurchaseOrder('PC-PO', { expectedVersion: await version(), idempotencyKey: 'pc-close-buyer', reason: 'x' }, buyer), 'AUTHORIZATION_PERMISSION_DENIED')
    const closed = await orders.closePurchaseOrder('PC-PO', { expectedVersion: await version(), idempotencyKey: 'pc-close', reason: 'Supplier cancelled the rest' }, admin)
    assert.equal(closed.status, 'closed')
    const row = await prisma.purchaseOrder.findUnique({ where: { id: 'PC-PO' }, include: { lines: true } })
    assert.deepEqual(row.metadata.closedOpenQuantities.map((line) => [line.purchaseOrderLineId, line.openQuantity]), [['PC-POL', '4.0000']])
    assert.equal(row.metadata.closeReason, 'Supplier cancelled the rest')
    assert.equal(row.lines[0].receivedQuantity.toString(), '6')
    assert.equal(isOpenPurchaseOrder(row), false)
    assert.equal(await prisma.auditLog.count({ where: { tenantId, action: 'purchase_order_close' } }), 1)

    // Nothing more can be received against it.
    await expectError(receipt('pc-grn-3', '1'), 'RECEIVING_PURCHASE_ORDER_NOT_RECEIVABLE')
    // Reversing its receipt keeps the PO closed.
    await posting.reverseReceiving({ receivingDocumentId: first.entityId, idempotencyKey: 'pc-grn-1-reverse', reason: 'Wrong item' }, admin)
    assert.equal((await prisma.purchaseOrder.findUnique({ where: { id: 'PC-PO' } })).status, 'closed')
    // A closed PO cannot be closed or cancelled again.
    await expectError(orders.cancelPurchaseOrder('PC-PO', { expectedVersion: await version(), idempotencyKey: 'pc-cancel', reason: 'x' }, admin), 'PURCHASE_ORDER_WORKFLOW_CONFLICT')
  } finally {
    await prisma.$disconnect()
  }
})

// Document numbers (shared/document-numbering.mjs, owner decisions
// 2026-11-04): the server numbers every new receipt GRN-YYYYMM-NNNN in the
// workspace's month, on the desktop and the mobile channel alike, and ignores
// a number the client sends.
test('a new receipt is numbered by the server in the workspace month, ignoring a sent number', async () => {
  assert.ok(process.env.DATABASE_URL_TEST, 'An isolated test database is required')
  const prisma = await createPrismaClient(process.env)
  const numbersTenant = 'tenant-receipt-numbers'
  try {
    await prisma.tenant.create({ data: { id: numbersTenant, name: numbersTenant, countryCode: 'US', locale: 'en-US', currency: 'USD', timezone: 'America/New_York' } })
    await prisma.warehouse.create({ data: { id: 'RN-WH', tenantId: numbersTenant, code: 'RN-WH', name: 'Main', status: 'active' } })
    await prisma.user.create({ data: { id: 'rn-admin', tenantId: numbersTenant, email: 'rn-admin@receipt-numbers.invalid', name: 'rn-admin', role: 'admin' } })
    await backfillTenantAuthorization(prisma, numbersTenant, { actorId: 'rn-admin' })
    await prisma.item.create({ data: { id: 'RN-ITEM', tenantId: numbersTenant, sku: 'RN-SKU', name: 'Valve', unit: 'EA' } })
    await prisma.purchaseOrder.create({ data: { id: 'RN-PO', tenantId: numbersTenant, status: 'issued', supplierId: 'RN-SUP', supplierName: 'Harbor Supply', currency: 'USD', amount: '1000.0000', lines: { create: { id: 'RN-POL', itemId: 'RN-ITEM', sku: 'RN-SKU', itemName: 'Valve', orderedQuantity: '100.0000', receivedQuantity: '0.0000', unit: 'EA', unitPrice: '10.0000', amount: '1000.0000' } } } })
    const admin = { identity: { authenticated: true, tenantId: numbersTenant, userId: 'rn-admin', role: 'admin', source: 'signed-session' } }
    // 03:30 UTC on 1 December 2026 is still 30 November in New York.
    const drafts = createReceivingDraftCommandService({ prisma, now: () => new Date('2026-12-01T03:30:00Z') })
    const receipt = (key, extra = {}, channel = RECEIVING_DRAFT_CHANNELS.desktop) => drafts.createDraft({ poId: 'RN-PO', warehouseId: 'RN-WH', idempotencyKey: key, lines: [{ purchaseOrderLineId: 'RN-POL', acceptedQuantity: '1', location: 'A-01' }], ...extra }, admin, channel)

    const typed = await receipt('rn-1', { documentNumber: 'GRN-TYPED-1' })
    const mobile = await receipt('rn-2', { documentNumber: 'GRN-TYPED-2', clientMutationId: 'rn-mobile-2' }, RECEIVING_DRAFT_CHANNELS.mobile)
    assert.deepEqual([typed.receivingDocument.documentNumber, mobile.receivingDocument.documentNumber], ['GRN-202611-0001', 'GRN-202611-0002'])
    assert.equal(await prisma.receivingDocument.count({ where: { tenantId: numbersTenant, documentNumber: { startsWith: 'GRN-TYPED' } } }), 0)
    // A retry with the same key replays the first result and uses no number.
    assert.equal((await receipt('rn-1', { documentNumber: 'GRN-TYPED-1' })).receivingDocument.documentNumber, 'GRN-202611-0001')
    // A number already in the workspace (typed in before this rule) is skipped.
    await prisma.receivingDocument.create({ data: { id: 'RN-OLD', tenantId: numbersTenant, documentNumber: 'GRN-202611-0003', warehouseId: 'RN-WH' } })
    assert.equal((await receipt('rn-3')).receivingDocument.documentNumber, 'GRN-202611-0004')
    // Receipts saved at the same time all succeed, one number each.
    const together = await Promise.all([4, 5, 6].map((index) => receipt(`rn-${index}`)))
    assert.deepEqual(together.map((row) => row.receivingDocument.documentNumber).sort(), ['GRN-202611-0005', 'GRN-202611-0006', 'GRN-202611-0007'])
    // In Shanghai the same moment is already December: a new sequence.
    await prisma.tenant.update({ where: { id: numbersTenant }, data: { timezone: 'Asia/Shanghai' } })
    assert.equal((await receipt('rn-7')).receivingDocument.documentNumber, 'GRN-202612-0001')
  } finally {
    await prisma.$disconnect()
  }
})
