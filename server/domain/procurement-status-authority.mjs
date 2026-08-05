const freezeRecord = (record) => Object.freeze({ ...record })
const valuesOf = (record) => Object.freeze(Object.values(record))
const freezeTransitions = (transitions) => Object.freeze(Object.fromEntries(
  Object.entries(transitions).map(([status, next]) => [status, Object.freeze([...next])]),
))

export const PURCHASE_REQUEST_STATUS = freezeRecord({
  DRAFT: 'draft',
  SUBMITTED: 'submitted',
  APPROVED: 'approved',
  REJECTED: 'rejected',
  CANCELLED: 'cancelled',
  CONVERTED: 'converted',
})

export const RFQ_STATUS = freezeRecord({
  DRAFT: 'draft',
  OPEN: 'open',
  COLLECTING_QUOTES: 'collecting_quotes',
  CLOSED: 'closed',
  CANCELLED: 'cancelled',
})

export const SUPPLIER_QUOTATION_STATUS = freezeRecord({
  DRAFT: 'draft',
  INCOMPLETE: 'incomplete',
  SUBMITTED: 'submitted',
  SHORTLISTED: 'shortlisted',
  NOT_SELECTED: 'not_selected',
  WITHDRAWN: 'withdrawn',
})

export const RFQ_SUPPLIER_PARTICIPATION_STATUS = freezeRecord({
  PLANNED: 'planned',
  INVITED_INTERNAL: 'invited_internal',
  RESPONSE_RECORDED: 'response_recorded',
  DECLINED: 'declined',
  WITHDRAWN: 'withdrawn',
  CLOSED: 'closed',
})

export const SUPPLIER_QUOTATION_REVISION_STATUS = freezeRecord({
  DRAFT: 'draft',
  INCOMPLETE: 'incomplete',
  SUBMITTED: 'submitted',
  SHORTLISTED: 'shortlisted',
  NOT_SELECTED: 'not_selected',
  WITHDRAWN: 'withdrawn',
})

export const PURCHASE_ORDER_STATUS = freezeRecord({
  DRAFT: 'draft',
  PENDING_APPROVAL: 'pending_approval',
  APPROVED: 'approved',
  REJECTED: 'rejected',
  ISSUED: 'issued',
  PARTIALLY_RECEIVED: 'partially_received',
  FULLY_RECEIVED: 'fully_received',
  CANCELLED: 'cancelled',
})

export const RECEIVING_WORKFLOW_STATUS = freezeRecord({
  DRAFT: 'draft',
  READY_FOR_RECEIVING: 'ready_for_receiving',
  RECEIVED: 'received',
  CANCELLED: 'cancelled',
})

export const RECEIVING_POSTING_STATUS = freezeRecord({
  UNPOSTED: 'unposted',
  POSTED: 'posted',
  REVERSED: 'reversed',
})

const PURCHASE_REQUEST_PREVIEW_STATUSES = Object.freeze([
  'draft',
  'requested',
  'pending_review',
  'needs_info',
  'converted_to_rfq',
  'cancelled',
])

const SOURCING_EVENT_DRAFT_STATUSES = Object.freeze([
  'draft',
  'internal_review',
  'open_draft',
  'collecting_responses',
  'response_review',
  'award_recommended',
  'closed',
  'cancelled',
])

const SUPPLIER_RESPONSE_DRAFT_STATUSES = Object.freeze([
  'draft',
  'received',
  'incomplete',
  'shortlisted',
  'not_selected',
])

const AWARD_RECOMMENDATION_DRAFT_STATUSES = Object.freeze([
  'draft',
  'review_required',
  'approved_for_po_draft',
  'rejected',
])

const PURCHASE_ORDER_DRAFT_STATUSES = Object.freeze([
  'draft',
  'review_required',
  'ready_for_manual_issue',
  'cancelled',
])

export const PROCUREMENT_STATUS_VALUES = Object.freeze({
  purchaseRequest: valuesOf(PURCHASE_REQUEST_STATUS),
  rfq: valuesOf(RFQ_STATUS),
  supplierQuotation: valuesOf(SUPPLIER_QUOTATION_STATUS),
  rfqSupplierParticipation: valuesOf(RFQ_SUPPLIER_PARTICIPATION_STATUS),
  supplierQuotationRevision: valuesOf(SUPPLIER_QUOTATION_REVISION_STATUS),
  purchaseOrder: valuesOf(PURCHASE_ORDER_STATUS),
  receivingWorkflow: valuesOf(RECEIVING_WORKFLOW_STATUS),
  receivingPosting: valuesOf(RECEIVING_POSTING_STATUS),
  purchaseRequestPreview: PURCHASE_REQUEST_PREVIEW_STATUSES,
  sourcingEventDraft: SOURCING_EVENT_DRAFT_STATUSES,
  supplierResponseDraft: SUPPLIER_RESPONSE_DRAFT_STATUSES,
  awardRecommendationDraft: AWARD_RECOMMENDATION_DRAFT_STATUSES,
  purchaseOrderDraft: PURCHASE_ORDER_DRAFT_STATUSES,
})

export const PROCUREMENT_STATUS_TRANSITIONS = Object.freeze({
  purchaseRequest: freezeTransitions({
    draft: ['submitted', 'cancelled'],
    submitted: ['approved', 'rejected', 'draft', 'cancelled'],
    approved: ['draft', 'cancelled', 'converted'],
    rejected: [],
    cancelled: [],
    converted: [],
  }),
  rfq: freezeTransitions({
    draft: ['open', 'cancelled'],
    open: ['collecting_quotes', 'cancelled'],
    collecting_quotes: ['closed', 'cancelled'],
    closed: [],
    cancelled: [],
  }),
  supplierQuotation: freezeTransitions({
    draft: ['incomplete', 'submitted', 'withdrawn'],
    incomplete: ['submitted', 'withdrawn'],
    submitted: ['shortlisted', 'not_selected', 'withdrawn'],
    shortlisted: ['not_selected'],
    not_selected: [],
    withdrawn: [],
  }),
  purchaseOrderWorkflow: freezeTransitions({
    draft: ['pending_approval', 'cancelled'],
    pending_approval: ['approved', 'rejected', 'draft', 'cancelled'],
    approved: ['issued', 'cancelled'],
    rejected: ['draft'],
    issued: [],
    partially_received: [],
    fully_received: [],
    cancelled: [],
  }),
  purchaseOrderReceiving: freezeTransitions({
    draft: [],
    pending_approval: [],
    approved: ['partially_received', 'fully_received'],
    rejected: [],
    issued: ['partially_received', 'fully_received'],
    partially_received: ['approved', 'issued', 'fully_received'],
    fully_received: ['approved', 'issued', 'partially_received'],
    cancelled: [],
  }),
  receivingWorkflow: freezeTransitions({
    draft: ['ready_for_receiving', 'cancelled'],
    ready_for_receiving: ['received', 'cancelled'],
    received: [],
    cancelled: [],
  }),
  receivingPosting: freezeTransitions({
    unposted: ['posted'],
    posted: ['reversed'],
    reversed: [],
  }),
  purchaseRequestPreview: freezeTransitions({
    draft: ['requested', 'needs_info', 'cancelled'],
    requested: ['pending_review', 'converted_to_rfq', 'cancelled'],
    pending_review: ['needs_info', 'converted_to_rfq', 'cancelled'],
    needs_info: ['requested', 'cancelled'],
    converted_to_rfq: [],
    cancelled: [],
  }),
  sourcingEventDraft: freezeTransitions({
    draft: ['internal_review', 'cancelled'],
    internal_review: ['open_draft', 'cancelled'],
    open_draft: ['collecting_responses', 'response_review', 'cancelled'],
    collecting_responses: ['response_review', 'cancelled'],
    response_review: ['award_recommended', 'cancelled'],
    award_recommended: ['closed', 'cancelled'],
    closed: [],
    cancelled: [],
  }),
  supplierResponseDraft: freezeTransitions({
    draft: ['received', 'incomplete'],
    incomplete: ['received', 'not_selected'],
    received: ['shortlisted', 'not_selected'],
    shortlisted: ['not_selected'],
    not_selected: [],
  }),
  awardRecommendationDraft: freezeTransitions({
    draft: ['review_required', 'rejected'],
    review_required: ['approved_for_po_draft', 'rejected'],
    approved_for_po_draft: [],
    rejected: [],
  }),
  purchaseOrderDraft: freezeTransitions({
    draft: ['review_required', 'cancelled'],
    review_required: ['ready_for_manual_issue', 'cancelled'],
    ready_for_manual_issue: ['cancelled'],
    cancelled: [],
  }),
})

const STATUS_DOMAIN_FOR_TRANSITION = Object.freeze({
  purchaseOrderWorkflow: 'purchaseOrder',
  purchaseOrderReceiving: 'purchaseOrder',
})

const PROCUREMENT_STATUS_ALIASES = Object.freeze({
  purchaseRequest: freezeRecord({
    open: 'submitted',
    requested: 'submitted',
    pending_review: 'submitted',
    草稿: 'draft',
    待审批: 'submitted',
    已批准: 'approved',
    已驳回: 'rejected',
    已取消: 'cancelled',
    converted_to_rfq: 'converted',
    已转PO: 'converted',
  }),
  rfq: freezeRecord({
    active: 'open',
    collecting_responses: 'collecting_quotes',
    草稿: 'draft',
    进行中: 'collecting_quotes',
    比价中: 'collecting_quotes',
    已关闭: 'closed',
    已取消: 'cancelled',
  }),
  supplierQuotation: freezeRecord({
    received: 'submitted',
    草稿: 'draft',
    已提交: 'submitted',
    已入围: 'shortlisted',
    未中选: 'not_selected',
    已撤回: 'withdrawn',
  }),
  rfqSupplierParticipation: freezeRecord({
    invited: 'invited_internal',
    responded: 'response_recorded',
    已计划: 'planned',
    已内部邀请: 'invited_internal',
    已记录响应: 'response_recorded',
    已拒绝: 'declined',
    已撤回: 'withdrawn',
    已关闭: 'closed',
  }),
  supplierQuotationRevision: freezeRecord({
    received: 'submitted',
    草稿: 'draft',
    已提交: 'submitted',
    已入围: 'shortlisted',
    未中选: 'not_selected',
    已撤回: 'withdrawn',
  }),
  purchaseOrder: freezeRecord({
    open: 'issued',
    ready_for_receiving: 'issued',
    received: 'fully_received',
    completed: 'fully_received',
    草稿: 'draft',
    待审批: 'pending_approval',
    已批准: 'approved',
    已驳回: 'rejected',
    已下发: 'issued',
    部分收货: 'partially_received',
    已收货: 'fully_received',
    已取消: 'cancelled',
  }),
  receivingWorkflow: freezeRecord({
    approved: 'ready_for_receiving',
    partially_received: 'received',
    草稿: 'draft',
    待收货: 'ready_for_receiving',
    已收货: 'received',
    已取消: 'cancelled',
  }),
  receivingPosting: freezeRecord({
    未过账: 'unposted',
    已过账: 'posted',
    已冲销: 'reversed',
  }),
  purchaseRequestPreview: freezeRecord({
    草稿: 'draft',
    待审批: 'pending_review',
    已批准: 'requested',
    已驳回: 'cancelled',
    已转PO: 'converted_to_rfq',
    已取消: 'cancelled',
  }),
  sourcingEventDraft: freezeRecord({
    草稿: 'draft',
    进行中: 'collecting_responses',
    比价中: 'response_review',
    已授标: 'award_recommended',
    已转PO: 'closed',
    已取消: 'cancelled',
  }),
})

export const RECEIVING_POSTABLE_WORKFLOW_INPUTS = Object.freeze([
  RECEIVING_WORKFLOW_STATUS.READY_FOR_RECEIVING,
  RECEIVING_WORKFLOW_STATUS.RECEIVED,
  'approved',
  'partially_received',
])

export const RECEIVABLE_PURCHASE_ORDER_INPUTS = Object.freeze([
  PURCHASE_ORDER_STATUS.APPROVED,
  PURCHASE_ORDER_STATUS.ISSUED,
  PURCHASE_ORDER_STATUS.PARTIALLY_RECEIVED,
  'open',
  'ready_for_receiving',
])

const text = (value) => String(value ?? '').trim()

function statusError(code, message, domain, value, status) {
  return Object.assign(new Error(message), {
    code,
    status,
    documentType: domain,
    statusValue: value,
  })
}

export function normalizeProcurementAuthorityStatus(domain = '', value = '', options = {}) {
  const requestedDomain = text(domain)
  const statusDomain = STATUS_DOMAIN_FOR_TRANSITION[requestedDomain] || requestedDomain
  const raw = text(value)
  const values = PROCUREMENT_STATUS_VALUES[statusDomain]
  if (!values) {
    throw statusError('unsupported_document_type', `Unsupported procurement status domain: ${requestedDomain}.`, requestedDomain, raw, 422)
  }
  if (values.includes(raw)) return raw
  if (options.allowCompatibility === false) {
    throw statusError('invalid_status', `Invalid ${statusDomain} status: ${raw}.`, statusDomain, raw, 422)
  }
  const alias = PROCUREMENT_STATUS_ALIASES[statusDomain]?.[raw] || PROCUREMENT_STATUS_ALIASES[statusDomain]?.[raw.toLowerCase()]
  if (!alias || !values.includes(alias)) {
    throw statusError('invalid_status', `Invalid ${statusDomain} status: ${raw}.`, statusDomain, raw, 422)
  }
  return alias
}

export function isProcurementAuthorityStatus(domain = '', value = '', options = {}) {
  try {
    normalizeProcurementAuthorityStatus(domain, value, options)
    return true
  } catch {
    return false
  }
}

export function canTransitionProcurementAuthorityStatus(domain = '', fromStatus = '', toStatus = '', options = {}) {
  const transitionDomain = text(domain)
  const transitions = PROCUREMENT_STATUS_TRANSITIONS[transitionDomain]
  if (!transitions) {
    throw statusError('unsupported_document_type', `Unsupported procurement transition domain: ${transitionDomain}.`, transitionDomain, '', 422)
  }
  const statusDomain = STATUS_DOMAIN_FOR_TRANSITION[transitionDomain] || transitionDomain
  const from = normalizeProcurementAuthorityStatus(statusDomain, fromStatus, options)
  const to = normalizeProcurementAuthorityStatus(statusDomain, toStatus, options)
  return Boolean(transitions[from]?.includes(to))
}

export function assertProcurementAuthorityTransition(domain = '', fromStatus = '', toStatus = '', options = {}) {
  if (!canTransitionProcurementAuthorityStatus(domain, fromStatus, toStatus, options)) {
    throw statusError(
      'unsafe_status_transition',
      `Unsafe ${domain} status transition: ${fromStatus} -> ${toStatus}.`,
      domain,
      `${fromStatus}->${toStatus}`,
      409,
    )
  }
  const statusDomain = STATUS_DOMAIN_FOR_TRANSITION[text(domain)] || text(domain)
  return normalizeProcurementAuthorityStatus(statusDomain, toStatus, options)
}

export function isReceivingWorkflowPostable(value = '') {
  try {
    const normalized = normalizeProcurementAuthorityStatus('receivingWorkflow', value)
    return [RECEIVING_WORKFLOW_STATUS.READY_FOR_RECEIVING, RECEIVING_WORKFLOW_STATUS.RECEIVED].includes(normalized)
  } catch {
    return false
  }
}

export function isPurchaseOrderReceivable(value = '') {
  try {
    const normalized = normalizeProcurementAuthorityStatus('purchaseOrder', value)
    return [PURCHASE_ORDER_STATUS.APPROVED, PURCHASE_ORDER_STATUS.ISSUED, PURCHASE_ORDER_STATUS.PARTIALLY_RECEIVED].includes(normalized)
  } catch {
    return false
  }
}
