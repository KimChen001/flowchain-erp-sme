// Draft cases from replies dismissed as "wrong reading"
// (wrong-reading-drafts.mjs), on a fixture of stored rows. No database, no
// model.
import test from 'node:test'
import assert from 'node:assert/strict'
import { SUPPLIER_REPLY_CASES, WRITTEN_BY } from './cases.mjs'
import { supplierReplyWrongReadingDrafts } from './wrong-reading-drafts.mjs'

const reading = { replyKind: 'dates', lines: [{ line: 'L2', date: '2026-12-03', quote: 'Week 49 at the earliest for the bird ornaments.', dateKind: 'stated' }], flags: [], reason: null }
const checkLine = (ref, purchaseOrderLineId, fields) => ({ ref, purchaseOrderLineId, outcome: 'needs_you', issue: null, currentDate: null, proposedDate: null, quote: null, dateKind: null, readAs: null, readings: null, parts: null, ...fields })
const REPLIES = [
  {
    id: '7f3a9c21-0000-4000-8000-000000000001', purchaseOrderId: 'UCI-PO-00330', receivedOn: '2026-11-18', createdAt: new Date('2026-11-18T23:40:00Z'),
    text: 'Hi Daniel,\n\nWeek 49 at the earliest for the bird ornaments.\n\nRegards,\nPriya', quotedText: 'On 16 Nov 2026, Daniel wrote:\n> Our purchase order PO-202610-0029 was due on 13 Nov 2026', quotedTextHidden: true,
    state: 'not_recorded', reasonCode: 'wrong_reading', note: 'Week 49 is not a day', decidedAt: new Date('2026-11-19T08:00:00Z'),
    readingStatus: 'read', provider: 'gateway', model: 'model-a', promptVersion: 'supplier-reply-read-2', reading,
    check: { state: 'proposed', replyKind: 'dates', lines: [checkLine('L2', 'UCI-PO-00330-L002', { outcome: 'proposed', currentDate: '2026-11-13', proposedDate: '2026-12-03', quote: reading.lines[0].quote, dateKind: 'stated' })], flags: [], reason: null, dropped: 0 },
  },
  {
    id: '9b1c0d44-0000-4000-8000-000000000002', purchaseOrderId: 'UCI-PO-00331', receivedOn: '2026-11-17', createdAt: new Date('2026-11-17T10:00:00Z'),
    text: '您好，这批货下周五发出。', quotedText: null, quotedTextHidden: false,
    state: 'not_recorded', reasonCode: 'wrong_reading', note: null, decidedAt: new Date('2026-11-17T10:03:00Z'),
    readingStatus: 'read', provider: 'gateway', model: 'model-a', promptVersion: 'supplier-reply-read-2', reading: { replyKind: 'dates', lines: [], flags: [], reason: null },
    check: { state: 'needs_you', replyKind: 'dates', lines: [checkLine('L1', 'UCI-PO-00331-L001', { issue: 'relative_unreadable', currentDate: '2026-11-14' })], flags: [], reason: null, dropped: 0 },
  },
  // Not drafts: dismissed for another reason, and recorded.
  { id: 'other-reason', purchaseOrderId: 'UCI-PO-00331', receivedOn: '2026-11-16', createdAt: new Date('2026-11-16T10:00:00Z'), text: 'We will confirm on Monday.', state: 'not_recorded', reasonCode: 'supplier_will_confirm', readingStatus: 'read', check: null },
  { id: 'recorded', purchaseOrderId: 'UCI-PO-00331', receivedOn: '2026-11-16', createdAt: new Date('2026-11-16T10:00:00Z'), text: 'Shipping 27 November.', state: 'recorded', reasonCode: null, readingStatus: 'read', check: null },
]
const ORDERS = new Map([
  ['UCI-PO-00330', {
    id: 'UCI-PO-00330', number: 'PO-202610-0029', supplierName: 'Globex Party Supplies', status: 'issued', expectedDay: '2026-11-13',
    // Out of id order, as a query may give them; the snapshot sorts by id.
    lines: [
      { id: 'UCI-PO-00330-L002', sku: '84879', itemName: 'Assorted Colour Bird Ornament', unit: 'pcs', orderedQuantity: '360.0000', receivedQuantity: '0.0000', metadata: { promisedDate: '2026-12-01' } },
      { id: 'UCI-PO-00330-L001', sku: '22423', itemName: 'Regency Cakestand 3 Tier', unit: 'pcs', orderedQuantity: '48', receivedQuantity: '48', metadata: null },
    ],
  }],
  ['UCI-PO-00331', {
    id: 'UCI-PO-00331', number: 'PO-202610-0030', supplierName: 'Acme Home Goods', status: 'issued', expectedDay: '2026-11-14',
    lines: [{ id: 'UCI-PO-00331-L001', sku: '85123A', itemName: 'White Hanging Heart T-Light Holder', unit: 'pcs', orderedQuantity: '330', receivedQuantity: null, metadata: null }],
  }],
])

test('each reply dismissed as a wrong reading becomes a draft case, with the expected outcome left empty', () => {
  const drafts = supplierReplyWrongReadingDrafts({ replies: REPLIES, orders: ORDERS, dataset: 'uci', timeZone: 'Europe/London' })
  assert.deepEqual(drafts.map((draft) => draft.id), ['draft-uci-PO-202610-0030-9b1c0d44', 'draft-uci-PO-202610-0029-7f3a9c21'])
  const [chinese, english] = drafts
  // The case keys of cases.mjs, plus the draft's own record of the reading.
  assert.deepEqual(Object.keys(english), [...Object.keys(SUPPLIER_REPLY_CASES[0]), 'draft'])
  assert.deepEqual(
    [english.lang, english.workspace, english.writtenBy, english.about, english.covers, english.replyDate, english.today, english.heldOut, english.expected],
    ['en', 'uci', WRITTEN_BY, '', [], '2026-11-18', '2026-11-18', false, null],
  )
  assert.equal(chinese.lang, 'zh')
  // The quote cleaning hid goes back after the reply, so the case cleans the same text.
  assert.equal(english.replyText, `${REPLIES[0].text}\n\n${REPLIES[0].quotedText}`)
  assert.equal(chinese.replyText, REPLIES[1].text)
})

test('the order is every line by id with refs L1, L2, ...; the promised date the reading was given comes from the check', () => {
  const [, english] = supplierReplyWrongReadingDrafts({ replies: REPLIES, orders: ORDERS, dataset: 'uci', timeZone: 'Europe/London' })
  assert.deepEqual(english.order, {
    id: 'UCI-PO-00330', number: 'PO-202610-0029', supplierName: 'Globex Party Supplies', status: 'issued',
    lines: [
      { ref: 'L1', purchaseOrderLineId: 'UCI-PO-00330-L001', sku: '22423', supplierSku: null, itemName: 'Regency Cakestand 3 Tier', remaining: 0, unit: 'pcs', promisedDate: '2026-11-13' },
      // The line's date is 1 Dec now; the reading was given 13 Nov.
      { ref: 'L2', purchaseOrderLineId: 'UCI-PO-00330-L002', sku: '84879', supplierSku: null, itemName: 'Assorted Colour Bird Ornament', remaining: 360, unit: 'pcs', promisedDate: '2026-11-13' },
    ],
  })
  assert.deepEqual(
    [english.draft.replyId, english.draft.note, english.draft.decidedAt, english.draft.promptVersion, english.draft.reading, english.draft.check.lines[0].proposedDate],
    [REPLIES[0].id, 'Week 49 is not a day', '2026-11-19T08:00:00.000Z', 'supplier-reply-read-2', reading, '2026-12-03'],
  )
  assert.ok(english.draft.notes.some((note) => /as the order stands now/.test(note)))
})

test('a check that named a line differently is noted, and a reply whose order is gone is skipped', () => {
  const renamed = { ...REPLIES[1], check: { ...REPLIES[1].check, lines: [{ ...REPLIES[1].check.lines[0], ref: 'L3' }] } }
  const [draft] = supplierReplyWrongReadingDrafts({ replies: [renamed], orders: ORDERS, dataset: 'm5' })
  assert.ok(draft.draft.notes.includes('The check called line UCI-PO-00331-L001 L3; it is L1 here.'))
  assert.equal(draft.workspace, 'm5')
  assert.deepEqual(supplierReplyWrongReadingDrafts({ replies: [{ ...REPLIES[0], purchaseOrderId: 'missing' }], orders: ORDERS, dataset: 'uci' }), [])
})

test('drafts come from public-data workspaces only (DD-7)', () => {
  assert.throws(() => supplierReplyWrongReadingDrafts({ replies: REPLIES, orders: ORDERS, dataset: null }), /public-data workspaces/)
  assert.throws(() => supplierReplyWrongReadingDrafts({ replies: REPLIES, orders: ORDERS, dataset: 'pilot' }), /public-data workspaces/)
})
