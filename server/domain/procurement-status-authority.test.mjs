import assert from 'node:assert/strict'
import test from 'node:test'

import {
  PROCUREMENT_STATUS_TRANSITIONS,
  PROCUREMENT_STATUS_VALUES,
  PURCHASE_ORDER_STATUS,
  PURCHASE_REQUEST_STATUS,
  RFQ_SUPPLIER_PARTICIPATION_STATUS,
  RECEIVABLE_PURCHASE_ORDER_INPUTS,
  RECEIVING_POSTABLE_WORKFLOW_INPUTS,
  RFQ_STATUS,
  SUPPLIER_QUOTATION_REVISION_STATUS,
  assertProcurementAuthorityTransition,
  canTransitionProcurementAuthorityStatus,
  isProcurementAuthorityStatus,
  isPurchaseOrderReceivable,
  isReceivingWorkflowPostable,
  normalizeProcurementAuthorityStatus,
} from './procurement-status-authority.mjs'
import {
  PROCUREMENT_STATUS_GROUPS,
  assertSafeProcurementTransition,
  normalizeProcurementStatus,
} from './procurement-status-model.mjs'
import {
  PO_TRANSITIONS,
  PR_TRANSITIONS,
  RFQ_TRANSITIONS,
} from './procurement-workflow.mjs'
import {
  RECEIVABLE_PO_STATUSES,
  RECEIVABLE_WORKFLOW_STATUSES,
} from './receiving-transaction-policy.mjs'

test('formal procurement status domains expose one canonical catalog', () => {
  assert.deepEqual(PROCUREMENT_STATUS_VALUES.purchaseRequest, [
    'draft',
    'submitted',
    'approved',
    'rejected',
    'cancelled',
    'converted',
  ])
  assert.deepEqual(PROCUREMENT_STATUS_VALUES.rfq, [
    'draft',
    'open',
    'collecting_quotes',
    'closed',
    'cancelled',
  ])
  assert.deepEqual(PROCUREMENT_STATUS_VALUES.rfqSupplierParticipation, [
    'planned',
    'invited_internal',
    'response_recorded',
    'declined',
    'withdrawn',
    'closed',
  ])
  assert.deepEqual(PROCUREMENT_STATUS_VALUES.supplierQuotationRevision, [
    'draft',
    'incomplete',
    'submitted',
    'shortlisted',
    'not_selected',
    'withdrawn',
  ])
  assert.deepEqual(PROCUREMENT_STATUS_VALUES.purchaseOrder, [
    'draft',
    'pending_approval',
    'approved',
    'rejected',
    'issued',
    'partially_received',
    'fully_received',
    'cancelled',
  ])
  assert.equal(PURCHASE_REQUEST_STATUS.SUBMITTED, 'submitted')
  assert.equal(RFQ_STATUS.COLLECTING_QUOTES, 'collecting_quotes')
  assert.equal(RFQ_SUPPLIER_PARTICIPATION_STATUS.RESPONSE_RECORDED, 'response_recorded')
  assert.equal(SUPPLIER_QUOTATION_REVISION_STATUS.SUBMITTED, 'submitted')
  assert.equal(PURCHASE_ORDER_STATUS.FULLY_RECEIVED, 'fully_received')
  assert.throws(() => PROCUREMENT_STATUS_VALUES.purchaseRequest.push('other'), TypeError)
})

test('compatibility values normalize at boundaries without becoming canonical values', () => {
  assert.equal(normalizeProcurementAuthorityStatus('purchaseRequest', 'open'), 'submitted')
  assert.equal(normalizeProcurementAuthorityStatus('purchaseRequest', 'pending_review'), 'submitted')
  assert.equal(normalizeProcurementAuthorityStatus('rfq', 'active'), 'open')
  assert.equal(normalizeProcurementAuthorityStatus('rfqSupplierParticipation', 'responded'), 'response_recorded')
  assert.equal(normalizeProcurementAuthorityStatus('supplierQuotationRevision', 'received'), 'submitted')
  assert.equal(normalizeProcurementAuthorityStatus('purchaseOrder', 'open'), 'issued')
  assert.equal(normalizeProcurementAuthorityStatus('purchaseOrder', 'ready_for_receiving'), 'issued')
  assert.equal(normalizeProcurementAuthorityStatus('receivingWorkflow', 'approved'), 'ready_for_receiving')
  assert.equal(normalizeProcurementAuthorityStatus('receivingWorkflow', 'partially_received'), 'received')
  assert.throws(
    () => normalizeProcurementAuthorityStatus('purchaseRequest', 'open', { allowCompatibility: false }),
    (error) => error.code === 'invalid_status' && error.status === 422,
  )
})

test('formal and preview status domains remain deliberately separate', () => {
  assert.equal(isProcurementAuthorityStatus('purchaseRequestPreview', 'needs_info'), true)
  assert.equal(isProcurementAuthorityStatus('purchaseRequest', 'needs_info'), false)
  assert.equal(isProcurementAuthorityStatus('sourcingEventDraft', 'award_recommended'), true)
  assert.equal(isProcurementAuthorityStatus('rfq', 'award_recommended'), false)
  assert.equal(isProcurementAuthorityStatus('purchaseOrderDraft', 'ready_for_manual_issue'), true)
  assert.equal(isProcurementAuthorityStatus('purchaseOrder', 'ready_for_manual_issue'), false)
})

test('workflow and receiving transitions use distinct purchase-order authorities', () => {
  assert.equal(canTransitionProcurementAuthorityStatus('purchaseRequest', 'draft', 'submitted'), true)
  assert.equal(canTransitionProcurementAuthorityStatus('purchaseRequest', 'draft', 'approved'), false)
  assert.equal(canTransitionProcurementAuthorityStatus('rfq', 'open', 'collecting_quotes'), true)
  assert.equal(canTransitionProcurementAuthorityStatus('rfq', 'open', 'closed'), false)
  assert.equal(canTransitionProcurementAuthorityStatus('purchaseOrderWorkflow', 'approved', 'issued'), true)
  assert.equal(canTransitionProcurementAuthorityStatus('purchaseOrderWorkflow', 'issued', 'partially_received'), false)
  assert.equal(canTransitionProcurementAuthorityStatus('purchaseOrderReceiving', 'issued', 'partially_received'), true)
  assert.equal(canTransitionProcurementAuthorityStatus('purchaseOrderReceiving', 'fully_received', 'issued'), true)
  assert.equal(canTransitionProcurementAuthorityStatus('purchaseOrderReceiving', 'fully_received', 'approved'), true)
  assert.equal(assertProcurementAuthorityTransition('receivingPosting', 'unposted', 'posted'), 'posted')
  assert.throws(
    () => assertProcurementAuthorityTransition('receivingPosting', 'reversed', 'posted'),
    (error) => error.code === 'unsafe_status_transition' && error.status === 409,
  )
})

test('receiving policy accepts canonical and documented compatibility inputs only', () => {
  for (const value of ['ready_for_receiving', 'received', 'approved', 'partially_received']) {
    assert.equal(isReceivingWorkflowPostable(value), true, value)
    assert.equal(RECEIVABLE_WORKFLOW_STATUSES.has(value), true, value)
  }
  for (const value of ['approved', 'issued', 'partially_received', 'open', 'ready_for_receiving']) {
    assert.equal(isPurchaseOrderReceivable(value), true, value)
    assert.equal(RECEIVABLE_PO_STATUSES.has(value), true, value)
  }
  assert.deepEqual([...RECEIVABLE_WORKFLOW_STATUSES], [...RECEIVING_POSTABLE_WORKFLOW_INPUTS])
  assert.deepEqual([...RECEIVABLE_PO_STATUSES], [...RECEIVABLE_PURCHASE_ORDER_INPUTS])
  assert.equal(isReceivingWorkflowPostable('draft'), false)
  assert.equal(isPurchaseOrderReceivable('pending_approval'), false)
})

test('legacy status facades delegate to the new authority without changing preview behavior', () => {
  assert.strictEqual(PR_TRANSITIONS, PROCUREMENT_STATUS_TRANSITIONS.purchaseRequest)
  assert.strictEqual(PO_TRANSITIONS, PROCUREMENT_STATUS_TRANSITIONS.purchaseOrderWorkflow)
  assert.strictEqual(RFQ_TRANSITIONS, PROCUREMENT_STATUS_TRANSITIONS.rfq)
  assert.strictEqual(PROCUREMENT_STATUS_GROUPS.purchaseRequest, PROCUREMENT_STATUS_VALUES.purchaseRequestPreview)
  assert.strictEqual(PROCUREMENT_STATUS_GROUPS.sourcingEvent, PROCUREMENT_STATUS_VALUES.sourcingEventDraft)
  assert.equal(normalizeProcurementStatus('purchaseRequest', '待审批'), 'pending_review')
  assert.equal(normalizeProcurementStatus('sourcingEvent', '已授标'), 'award_recommended')
  assert.equal(assertSafeProcurementTransition('purchaseRequest', 'draft', 'requested'), 'requested')
  assert.throws(
    () => assertSafeProcurementTransition('purchaseRequest', 'draft', 'converted_to_rfq'),
    (error) => error.code === 'unsafe_status_transition',
  )
})
