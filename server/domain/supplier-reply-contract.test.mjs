// The supplier reply contract (shared/supplier-reply-contract.mjs): the
// shapes the server, the card and the eval share.
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  SUPPLIER_REPLY_CONTRACT_VERSION, SUPPLIER_REPLY_ROUTES, SUPPLIER_REPLY_STATES,
  supplierReplyCardSchema, supplierReplyDismissRequestSchema, supplierReplyOrderSchema, supplierReplyPasteRequestSchema,
  supplierReplyReadingSchema, supplierReplyRecordRequestSchema,
} from '../../shared/supplier-reply-contract.mjs'

const order = {
  number: 'PO-202611-0012', supplierName: 'Acme Ltd', status: 'issued',
  lines: [
    { ref: 'L1', purchaseOrderLineId: 'pol-1', sku: 'SKU-1040', supplierSku: 'ACM-5521', itemName: 'Bracket', remaining: 60, unit: 'pcs', promisedDate: '2026-11-12' },
    { ref: 'L2', purchaseOrderLineId: 'pol-2', sku: 'SKU-2210', supplierSku: null, itemName: 'Hinge', remaining: 20, unit: 'pcs', promisedDate: '2026-11-12' },
  ],
}

test('the order snapshot and the model reading parse; anything else is refused', () => {
  assert.ok(supplierReplyOrderSchema.safeParse(order).success)
  // The supplier's own code is part of a line (a reply often quotes it).
  const { supplierSku, ...withoutCode } = order.lines[0]
  assert.ok(!supplierReplyOrderSchema.safeParse({ ...order, lines: [withoutCode] }).success)
  const reading = { replyKind: 'dates', lines: [{ line: 'L1', date: '2026-11-28', quote: 'We can ship the balance on 28 November.', dateKind: 'stated' }], flags: [{ kind: 'price_change', quote: 'unit price rises 4% from December' }], reason: null }
  assert.ok(supplierReplyReadingSchema.safeParse(reading).success)
  // A vague date has no day.
  assert.ok(supplierReplyReadingSchema.safeParse({ ...reading, lines: [{ line: 'L1', date: null, quote: 'early December', dateKind: 'vague' }] }).success)
  // Strict: no extra key, no line reference outside the list's form, no other kind.
  assert.ok(!supplierReplyReadingSchema.safeParse({ ...reading, action: 'mark_received' }).success)
  assert.ok(!supplierReplyReadingSchema.safeParse({ ...reading, lines: [{ ...reading.lines[0], line: 'pol-1' }] }).success)
  assert.ok(!supplierReplyReadingSchema.safeParse({ ...reading, replyKind: 'receipt' }).success)
  assert.ok(!supplierReplyReadingSchema.safeParse({ ...reading, lines: [{ ...reading.lines[0], date: '28/11/2026' }] }).success)
})

test('the card a reader gets, and the requests the routes take', () => {
  const line = { ref: 'L1', purchaseOrderLineId: 'pol-1', outcome: 'proposed', issue: null, currentDate: '2026-11-12', proposedDate: '2026-11-28', quote: 'We can ship the balance on 28 November.', dateKind: 'stated', readAs: null, readings: null, parts: null, sku: 'SKU-1040', supplierSku: 'ACM-5521', itemName: 'Bracket', remaining: 60, unit: 'pcs', overdueDays: 5 }
  const card = {
    contractVersion: SUPPLIER_REPLY_CONTRACT_VERSION, id: 'sr-1', purchaseOrderId: 'po-12', purchaseOrderNumber: 'PO-202611-0012', orderVersion: 4, supplierName: 'Acme Ltd',
    source: 'paste', receivedOn: '2026-11-17', createdAt: '2026-11-17T10:00:00.000Z', state: 'proposed', readingStatus: 'read', replyKind: 'dates',
    text: 'We can ship the balance on 28 November.', quotedTextHidden: true, quotedText: '> Please confirm PO-202611-0012.', lines: [line], flags: [], reason: null, instructionsIgnored: false,
    formLines: [{ purchaseOrderLineId: 'pol-1', sku: 'SKU-1040', supplierSku: 'ACM-5521', itemName: 'Bracket', remaining: 60, unit: 'pcs', currentDate: '2026-11-12', overdueDays: 5 }],
    canDecide: true, notNowUntil: null, decision: null, supersededById: null,
  }
  assert.ok(supplierReplyCardSchema.safeParse(card).success, JSON.stringify(supplierReplyCardSchema.safeParse(card).error?.issues))
  assert.deepEqual(SUPPLIER_REPLY_STATES, ['proposed', 'needs_you', 'nothing_to_record', 'recorded', 'not_recorded', 'superseded'])
  assert.equal(SUPPLIER_REPLY_ROUTES.record, '/api/procurement/orders/:id/supplier-replies/:replyId/record')
  assert.ok(supplierReplyPasteRequestSchema.safeParse({ text: 'Balance ships 28 Nov.', receivedOn: '2026-11-17' }).success)
  assert.ok(!supplierReplyPasteRequestSchema.safeParse({ text: 'x'.repeat(8001) }).success)
  assert.ok(supplierReplyRecordRequestSchema.safeParse({ expectedVersion: 4 }).success)
  assert.ok(supplierReplyRecordRequestSchema.safeParse({ expectedVersion: 4, lines: [{ purchaseOrderLineId: 'pol-1', promisedDate: '2026-11-30' }] }).success)
  assert.ok(!supplierReplyRecordRequestSchema.safeParse({ lines: [] }).success)
  assert.ok(supplierReplyDismissRequestSchema.safeParse({ reason: 'wrong_reading' }).success)
  assert.ok(!supplierReplyDismissRequestSchema.safeParse({ reason: 'other' }).success, 'other needs a note')
  assert.ok(supplierReplyDismissRequestSchema.safeParse({ reason: 'other', note: 'Asked the supplier by phone.' }).success)
  assert.ok(!supplierReplyDismissRequestSchema.safeParse({ reason: 'other', note: 'x'.repeat(201) }).success)
})
