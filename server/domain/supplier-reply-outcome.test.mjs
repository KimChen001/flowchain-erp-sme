// What became of a supplier reply (supplier-reply-outcome.mjs): edits count
// only on proposed lines, a reply with no proposal recorded by hand is manual,
// and the dates come from the reply's revisions.
import test from 'node:test'
import assert from 'node:assert/strict'
import { supplierReplyCardState, supplierReplyOutcome, supplierReplyProposedLines, supplierReplyRecordedDates } from './supplier-reply-outcome.mjs'

const line = (id, outcome, proposedDate = null, issue = null) => ({ ref: `L${id.slice(-1)}`, purchaseOrderLineId: id, outcome, issue, currentDate: '2026-11-12', proposedDate })
const TWO_PROPOSED = { state: 'proposed', lines: [line('PO-L1', 'proposed', '2026-11-27'), line('PO-L2', 'proposed', '2026-12-02'), line('PO-L3', 'needs_you', null, 'vague')] }
const recorded = (check, extra = {}) => ({ state: 'recorded', decision: 'recorded', readingStatus: 'read', check, ...extra })
const revision = (purchaseOrderLineId, newDate, createdAt = '2026-11-18T10:00:00Z') => ({ purchaseOrderLineId, newDate: new Date(`${newDate}T12:00:00Z`), createdAt: new Date(createdAt) })

test('every proposed line recorded as proposed is unchanged, even with a line the person filled in by hand', () => {
  const dates = supplierReplyRecordedDates([revision('PO-L1', '2026-11-27'), revision('PO-L2', '2026-12-02'), revision('PO-L3', '2026-12-10')])
  assert.equal(supplierReplyOutcome(recorded(TWO_PROPOSED), { recordedDates: dates }), 'recorded_unchanged')
})

test('a proposed line recorded at another date, or left out, makes it edited', () => {
  const changed = supplierReplyRecordedDates([revision('PO-L1', '2026-11-27'), revision('PO-L2', '2026-12-03')])
  assert.equal(supplierReplyOutcome(recorded(TWO_PROPOSED), { recordedDates: changed }), 'recorded_edited')
  const dropped = supplierReplyRecordedDates([revision('PO-L1', '2026-11-27')])
  assert.equal(supplierReplyOutcome(recorded(TWO_PROPOSED), { recordedDates: dropped }), 'recorded_edited')
})

test('nothing proposed and dates typed by hand is manual, whatever the service counted as edited', () => {
  // The service's editedLines is the line count here: every line differs from an empty proposal.
  const allNeedYou = { state: 'needs_you', lines: [line('PO-L1', 'needs_you', null, 'vague'), line('PO-L2', 'needs_you', null, 'date_mismatch')] }
  assert.equal(supplierReplyOutcome(recorded(allNeedYou, { editedLines: 2 }), { recordedDates: supplierReplyRecordedDates([revision('PO-L1', '2026-12-01')]) }), 'recorded_manual')
  // A reading that failed or AI off: no check at all.
  assert.equal(supplierReplyOutcome(recorded(null, { readingStatus: 'ai_off', editedLines: 1 })), 'recorded_manual')
})

test('recorded with a proposal but no revision known is plain recorded', () => {
  assert.equal(supplierReplyOutcome(recorded(TWO_PROPOSED)), 'recorded')
  assert.equal(supplierReplyOutcome(recorded(TWO_PROPOSED), { recordedDates: new Map() }), 'recorded')
})

test('dismissed replies carry their reason; open and other states stay as they are', () => {
  assert.equal(supplierReplyOutcome({ state: 'not_recorded', reasonCode: 'wrong_reading' }), 'not_recorded_wrong_reading')
  assert.equal(supplierReplyOutcome({ state: 'not_recorded', reasonCode: null }), 'not_recorded')
  for (const state of ['proposed', 'needs_you', 'nothing_to_record', 'superseded']) assert.equal(supplierReplyOutcome({ state }), state)
  assert.equal(supplierReplyOutcome({}), null)
})

test('recorded dates take the later revision of a line and accept days or dates; a plain object works too', () => {
  const dates = supplierReplyRecordedDates([revision('PO-L1', '2026-12-05', '2026-11-19T09:00:00Z'), revision('PO-L1', '2026-11-27', '2026-11-18T09:00:00Z'), { purchaseOrderLineId: 'PO-L2', newDate: '2026-12-02' }, { purchaseOrderLineId: null, newDate: '2026-12-09' }])
  assert.deepEqual([...dates.entries()].sort(), [['PO-L1', '2026-12-05'], ['PO-L2', '2026-12-02']])
  assert.equal(supplierReplyOutcome(recorded(TWO_PROPOSED), { recordedDates: { 'PO-L1': '2026-11-27', 'PO-L2': '2026-12-02' } }), 'recorded_unchanged')
  assert.deepEqual(supplierReplyProposedLines(TWO_PROPOSED).map((row) => row.purchaseOrderLineId), ['PO-L1', 'PO-L2'])
})

test('the card state before the decision is the check\'s, or needs you when the reply was not read', () => {
  assert.equal(supplierReplyCardState(recorded(TWO_PROPOSED)), 'proposed')
  assert.equal(supplierReplyCardState({ state: 'recorded', readingStatus: 'failed', check: null }), 'needs_you')
  assert.equal(supplierReplyCardState({ state: 'nothing_to_record', readingStatus: 'read', check: { state: 'nothing_to_record', lines: [] } }), 'nothing_to_record')
})
