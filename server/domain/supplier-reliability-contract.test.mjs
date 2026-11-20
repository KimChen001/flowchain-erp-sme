import test from 'node:test'
import assert from 'node:assert/strict'
import {
  SUPPLIER_RELIABILITY_CONTRACT_VERSION, SUPPLIER_RELIABILITY_ROUTE, SUPPLIER_RELIABILITY_RULES,
  supplierReliabilityErrorSchema, supplierReliabilityResponseSchema,
} from '../../shared/supplier-reliability-contract.mjs'
import { SUPPLIER_SCORECARD_RULES } from './supplier-scorecard.mjs'

const outcomes = { recordedUnchanged: 2, recordedEdited: 1, recordedManual: 0, notRecorded: { wrong_reading: 1, supplier_will_confirm: 0, other: 0 }, needsYou: 1, proposed: 0, nothingToRecord: 1 }
const response = {
  contractVersion: SUPPLIER_RELIABILITY_CONTRACT_VERSION,
  asOf: '2026-11-20',
  window: { from: '2026-08-23', to: '2026-11-20', days: 90 },
  minimumSample: 5,
  visibility: { revisions: true, replies: true },
  suppliers: {
    'sup-acme': {
      revisions: { orders: 8, revisedOrders: 3, revisions: 5, perOrder: 0.625, averageDaysMoved: 4.2, movedLater: { count: 4, of: 5, share: 0.8 } },
      replies: { received: 6, read: 5, withStatedDate: { count: 4, of: 5, share: 0.8 }, outcomes, recorded: 3, medianHoursToRecord: null },
    },
    'sup-hidden': { revisions: null, replies: null },
  },
}

test('the reliability response parses, with null parts for what the reader may not read', () => {
  assert.equal(supplierReliabilityResponseSchema.parse(response).suppliers['sup-acme'].revisions.revisions, 5)
  assert.equal(supplierReliabilityResponseSchema.parse(response).suppliers['sup-hidden'].replies, null)
})

test('a share under the minimum sample is null, never left out', () => {
  const small = structuredClone(response)
  small.suppliers['sup-acme'].revisions = { orders: 2, revisedOrders: 1, revisions: 2, perOrder: null, averageDaysMoved: null, movedLater: { count: 1, of: 2, share: null } }
  assert.ok(supplierReliabilityResponseSchema.safeParse(small).success)
  delete small.suppliers['sup-acme'].revisions.movedLater.share
  assert.equal(supplierReliabilityResponseSchema.safeParse(small).success, false)
})

test('unknown fields and outcome codes are refused', () => {
  const extra = structuredClone(response)
  extra.suppliers['sup-acme'].replies.outcomes.recordedLate = 1
  assert.equal(supplierReliabilityResponseSchema.safeParse(extra).success, false)
  const reason = structuredClone(response)
  reason.suppliers['sup-acme'].replies.outcomes.notRecorded.duplicate = 1
  assert.equal(supplierReliabilityResponseSchema.safeParse(reason).success, false)
})

// The totals the page relies on are checked, so a server that drifts shows
// the page's alert instead of figures that do not add up (#399 review).
test('outcomes that do not add up, a stated-date share of other replies, or moves of other revisions are refused', () => {
  const mismatched = (change) => { const copy = structuredClone(response); change(copy.suppliers['sup-acme']); return supplierReliabilityResponseSchema.safeParse(copy) }
  const outcomes = mismatched((row) => { row.replies.outcomes.needsYou += 1 })
  assert.equal(outcomes.success, false)
  assert.deepEqual(outcomes.error.issues.map((issue) => issue.path.slice(-2)), [['replies', 'outcomes']])
  const stated = mismatched((row) => { row.replies.withStatedDate = { count: 4, of: 6, share: 0.667 } })
  assert.deepEqual(stated.error.issues.map((issue) => issue.path.slice(-2)), [['withStatedDate', 'of']])
  const moved = mismatched((row) => { row.revisions.movedLater = { count: 4, of: 6, share: 0.667 } })
  assert.deepEqual(moved.error.issues.map((issue) => issue.path.slice(-2)), [['movedLater', 'of']])
  // And recorded is the recorded outcomes, read never exceeds received.
  assert.equal(mismatched((row) => { row.replies.recorded = 4 }).success, false)
  assert.equal(mismatched((row) => { row.replies.read = 7; row.replies.withStatedDate.of = 7 }).success, false)
  assert.ok(mismatched(() => {}).success)
})

test('the window and minimum sample are the scorecard\'s, so the page shows one rule', () => {
  assert.equal(SUPPLIER_RELIABILITY_RULES.windowDays, SUPPLIER_SCORECARD_RULES.periodDays)
  assert.equal(SUPPLIER_RELIABILITY_RULES.minimumSample, SUPPLIER_SCORECARD_RULES.minimumSample)
  assert.equal(SUPPLIER_RELIABILITY_ROUTE, '/api/master-data/supplier-reliability')
})

test('errors use the flat code and message body', () => {
  assert.ok(supplierReliabilityErrorSchema.safeParse({ code: 'SUPPLIER_RELIABILITY_UNAVAILABLE', message: 'Try again.' }).success)
  assert.equal(supplierReliabilityErrorSchema.safeParse({ code: 'SOMETHING_ELSE', message: 'x' }).success, false)
})
