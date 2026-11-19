import assert from 'node:assert/strict'
import test from 'node:test'
import { buildDecisionDrafts } from './decision-drafts.mjs'
import { sameUnit, unitOtherThanStock } from './item-stock-unit.mjs'
import { checkFollowUpContent, parseFollowUpEmail } from './supplier-follow-up-email.mjs'
import { billNextStep, buildTodayWork } from './today-work.mjs'
import {
  approvedNotIssuedOrder, caseOrderedLine, orderSupplier, purchaseOrder, receiptLineOnTwoInvoices, REGEX_SKUS, varianceApprovedInvoice,
} from './test-fixtures/boundary-cases.mjs'

// The shared boundary data (test-fixtures/boundary-cases.mjs) run through the
// code on main that handles it (design audit 2026-11-15, findings-13
// strategies 2 and 5).

const now = new Date('2026-11-12T15:00:00Z') // 10:00 in New York
const timeZone = 'America/New_York'

// Strategy 5, Today -> draft -> email: the pieces were tested apart, with
// rows written by hand between them (L11-01). Here Today's own rows feed the
// drafts and the drafts feed the email check.
test('Today, its drafts and the supplier email agree on an order approved but never issued', () => {
  const issued = purchaseOrder({ sku: REGEX_SKUS[0] })
  const approved = approvedNotIssuedOrder({ sku: REGEX_SKUS[1] })
  const work = buildTodayWork({ purchaseOrders: [issued, approved] }, { now, timeZone })
  const late = work.all.filter((item) => item.kind === 'purchase_order_overdue')
  assert.deepEqual(late.map((item) => [item.recordId, item.overdueDays, item.detail.notIssued]).sort(), [
    ['BND-PO-APPROVED', 10, true],
    ['BND-PO-ISSUED', 10, false],
  ])

  const drafts = buildDecisionDrafts(late, { context: { purchaseOrders: [issued, approved], suppliers: [orderSupplier()] }, sources: {}, now, timeZone })
  // The order the supplier never got is to be issued, not chased.
  const send = drafts['purchase_order_overdue:BND-PO-APPROVED']
  assert.equal(send.type, 'send_purchase_order')
  assert.equal('lines' in send, false)
  const followUp = drafts['purchase_order_overdue:BND-PO-ISSUED']
  assert.equal(followUp.type, 'supplier_follow_up')
  assert.deepEqual(followUp.lines.map((line) => [line.sku, line.remaining]), [['A.B12', 60]])

  const to = orderSupplier().email
  const email = (body) => parseFollowUpEmail({ to, confirmedTo: to, subject: 'Order PO-202610-0101 is 10 days late', body })
  // The SKU's own digits ("12" in A.B12) are not read as a changed figure.
  assert.deepEqual(checkFollowUpContent(email('Please confirm when the 60 pcs of A.B12 still to come will ship.'), followUp), { recipientOnRecord: true })
  assert.throws(() => checkFollowUpContent(email('Please confirm when the 70 pcs of A.B12 still to come will ship.'), followUp), { code: 'SUPPLIER_EMAIL_FIGURE_CHANGED' })
  // No follow-up can be sent for the order that was never issued.
  assert.throws(() => checkFollowUpContent(email('Please confirm the 100 pcs of X+Y1.'), send), { code: 'SUPPLIER_EMAIL_DRAFT_MISSING' })
})

test('each other boundary case is the case its rule on main recognises', () => {
  // A line in cases for an item kept in pieces names another unit.
  const { item, purchaseOrderLine } = caseOrderedLine()
  assert.equal(unitOtherThanStock(item.unit, [purchaseOrderLine.unit]), 'CASE')
  assert.equal(sameUnit(item.unit, purchaseOrderLine.unit), false)

  // A bill whose variance was approved waits for approval, not for review.
  assert.equal(billNextStep(varianceApprovedInvoice()), 'bill_to_approve')
  assert.equal(billNextStep({ ...varianceApprovedInvoice(), matchStatus: 'variance' }), 'bill_exception')

  // One receipt line billed on two invoices, in parts that add up to the receipt.
  const { receivingLine, invoices } = receiptLineOnTwoInvoices()
  const billed = invoices.flatMap((invoice) => invoice.lines).filter((line) => line.receivingLineId === receivingLine.id)
  assert.deepEqual(billed.map((line) => line.id), ['BND-BILL-A-1', 'BND-BILL-B-1'])
  assert.equal(billed.reduce((sum, line) => sum + Number(line.quantity), 0), Number(receivingLine.receivedQuantity))
})
