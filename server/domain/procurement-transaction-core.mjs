import { buildPurchaseOrderDraft, buildRfqDraft, buildSourcingEventDraft } from './business-draft-builders.mjs'
import { normalizeProcurementStatus } from './procurement-status-model.mjs'
import { validateUserConfirmedActionRequest } from './user-confirmed-business-action.mjs'

function asArray(value) {
  return Array.isArray(value) ? value : []
}

function text(value = '') {
  return String(value ?? '').trim()
}

function number(value, fallback = 0) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function clone(value) {
  return JSON.parse(JSON.stringify(value ?? null))
}

function compact(object = {}) {
  return Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined && value !== '' && value !== null))
}

function unique(items = []) {
  return [...new Set(items.filter(Boolean))]
}

function prId(pr = {}, index = 0) {
  return text(pr.pr || pr.prId || pr.id, `PR-OP-${String(index + 1).padStart(4, '0')}`)
}

function rfqId(rfq = {}, index = 0) {
  return text(rfq.id || rfq.rfqId || rfq.rfq, `RFQ-OP-${String(index + 1).padStart(4, '0')}`)
}

function supplierName(row = {}) {
  return text(row.supplierName || row.supplier || row.name || row.supplierId)
}

export const PROCUREMENT_TRANSACTION_BASELINE = Object.freeze({
  inspectedFiles: [
    'server/domain/procurement-read-model.mjs',
    'server/domain/business-draft-builders.mjs',
    'server/domain/user-confirmed-business-action.mjs',
    'server/repositories/user-confirmed-action-repository.mjs',
    'server/routes/user-confirmed-actions.routes.mjs',
    'server/routes/purchase-requests.routes.mjs',
    'server/routes/rfqs.routes.mjs',
    'src/modules/purchase-requests/Page.tsx',
    'src/modules/rfq/Page.tsx',
    'src/domain/relationships/resolver.ts',
  ],
  chosenBoundaries: {
    purchaseRequest: 'user-confirmed action createdRecord type purchaseRequest plus procurement operational read projection',
    sourcingEvent: 'user-confirmed action create_sourcing_event or create_rfq internal draft record',
    rfq: 'internal RFQ/sourcing draft; never external send',
    supplierResponse: 'runtime internal supplier response record linked to RFQ',
    awardRecommendation: 'deterministic draft recommendation only; never award mutation',
    poDraft: 'business draft only; never issue, send, approve, post, or reserve inventory',
  },
  currentGaps: [
    'Legacy PR/RFQ pages still contain direct mutation routes for manual workspace workflows.',
    'Supplier responses and award recommendations are not first-class read records.',
    'PO preparation from award context needs a draft-only model with explicit side-effect guardrails.',
  ],
})

export const PROCUREMENT_FORBIDDEN_SIDE_EFFECTS = Object.freeze({
  submitsPr: false,
  approvesPr: false,
  sendsRfqExternally: false,
  invitesSuppliersExternally: false,
  awardsSupplier: false,
  createsIssuedPo: false,
  issuesPo: false,
  sendsSupplierNotification: false,
  approvesInvoice: false,
  paysInvoice: false,
  postsInvoice: false,
  postsInventory: false,
  mutatesInventoryBalance: false,
  mutatesSupplierMaster: false,
})

export function buildOperationalPurchaseRequestDetail(input = {}, context = {}) {
  const pr = input.createdRecord ? {
    id: input.createdRecord.id,
    status: input.createdRecord.status,
    ...input.createdRecord.fields,
    provenance: input.createdRecord.provenance,
    auditEventId: input.auditEventId,
    linkedRecords: input.createdRecord.linkedRecords,
  } : input
  const id = text(pr.pr || pr.prId || pr.id)
  const sku = text(pr.sku || pr.itemIdOrSku || pr.sourceSku || pr.itemSku)
  const quantity = number(pr.quantity || pr.suggestedQuantity)
  const missingFields = unique([
    ...asArray(pr.missingFields),
    ...(!sku ? ['sku'] : []),
    ...(quantity > 0 ? [] : ['quantity']),
    ...(!text(pr.requiredDate || pr.dueDate) ? ['requiredDate'] : []),
    ...(!text(pr.warehouse || pr.warehouseId) ? ['warehouse'] : []),
    ...(!text(pr.costCenter) ? ['costCenter'] : []),
  ])
  const linkedRfqs = asArray(context.rfqs)
    .filter((rfq) => text(rfq.sourceRequest || rfq.linkedPr || rfq.prId) === id)
    .map((rfq, index) => ({ type: 'rfq', id: rfqId(rfq, index), status: text(rfq.status), title: text(rfq.title) }))
  return {
    id,
    type: 'purchaseRequest',
    status: missingFields.length ? 'needs_info' : normalizeProcurementStatus('purchaseRequest', pr.status || 'requested'),
    requester: text(pr.requester || pr.actor || pr.provenance?.confirmedBy),
    actor: text(pr.actor || pr.provenance?.confirmedBy),
    sku,
    itemName: text(pr.itemName || pr.sourceName),
    quantity,
    requiredDate: text(pr.requiredDate || pr.dueDate),
    warehouse: text(pr.warehouse || pr.warehouseId),
    costCenter: text(pr.costCenter),
    reason: text(pr.reason),
    sourceTrigger: text(pr.sourceTrigger || pr.provenance?.sourceTrigger),
    sourceEvidence: clone(pr.evidenceReferences || pr.evidence || []),
    missingFields,
    linkedSourcingRecords: linkedRfqs,
    audit: {
      auditEventId: text(pr.auditEventId || input.auditEventId),
      createdFromAiAssistedDraft: Boolean(pr.provenance?.createdFromAiAssistedDraft || input.userConfirmedCreation),
      userConfirmedCreation: Boolean(input.userConfirmedCreation || pr.provenance?.confirmedBy),
      draftId: text(pr.provenance?.draftId || input.draftId),
    },
    provenance: clone(pr.provenance || {}),
    contextualActions: [
      { key: 'create_rfq_draft_from_pr', label: 'Create RFQ / Sourcing Event draft from this PR', reviewFirst: true },
      { key: 'explain_missing_pr_fields', label: 'Explain missing PR fields', reviewFirst: true },
      { key: 'preview_supplier_shortlist', label: 'Preview supplier shortlist', reviewFirst: true },
    ],
    sideEffects: { ...PROCUREMENT_FORBIDDEN_SIDE_EFFECTS },
  }
}

export function buildRfqDraftFromPurchaseRequest(prDetail = {}, input = {}) {
  const actionType = input.actionType || 'create_rfq'
  const reviewedFields = {
    sourcePrId: prDetail.id,
    sourcePrOrSku: prDetail.id || prDetail.sku,
    itemOrCategory: prDetail.sku || prDetail.itemName,
    sku: prDetail.sku,
    itemName: prDetail.itemName,
    quantity: prDetail.quantity,
    requiredDate: prDetail.requiredDate,
    responseDeadline: input.responseDeadline || input.dueDate,
    candidateSuppliers: input.candidateSuppliers || [],
    evaluationCriteria: input.evaluationCriteria || ['total_cost', 'lead_time', 'supplier_risk', 'data_completeness'],
    missingFields: unique([...(prDetail.missingFields || []), ...(!input.responseDeadline && !input.dueDate ? ['responseDeadline'] : [])]),
  }
  const validation = validateUserConfirmedActionRequest({
    actionType,
    confirm: input.confirm === true,
    confirmedByAi: input.confirmedByAi,
    reviewedFields,
    draftId: input.draftId || `PR-RFQ-${prDetail.id}`,
    actor: input.actor,
    sourceTrigger: input.sourceTrigger || 'purchase_request_detail',
  })
  if (!validation.ok) return { ok: false, validation, sideEffects: { ...PROCUREMENT_FORBIDDEN_SIDE_EFFECTS } }
  const draft = actionType === 'create_sourcing_event'
    ? buildSourcingEventDraft({ ...reviewedFields, eventTitle: input.eventTitle || `Sourcing for ${prDetail.id}` })
    : buildRfqDraft(reviewedFields)
  return {
    ok: true,
    draft,
    record: {
      id: input.id || `RFQ-DRAFT-${prDetail.id}`,
      type: actionType === 'create_sourcing_event' ? 'sourcingEvent' : 'rfq',
      status: reviewedFields.missingFields.length ? 'internal_review' : 'open_draft',
      sourcePrId: prDetail.id,
      fields: compact(reviewedFields),
      evidence: prDetail.sourceEvidence || [],
      provenance: { userConfirmedCreation: true, sourcePrId: prDetail.id, actor: input.actor || 'current_user' },
    },
    sideEffects: { ...PROCUREMENT_FORBIDDEN_SIDE_EFFECTS },
  }
}

export function buildSupplierResponse(input = {}) {
  const missingFields = unique([
    ...(!text(input.rfqId || input.sourcingEventId) ? ['rfqId'] : []),
    ...(!supplierName(input) ? ['supplier'] : []),
    ...(number(input.quotedPrice || input.price) > 0 ? [] : ['quotedPrice']),
    ...(number(input.leadTimeDays || input.leadTime) > 0 ? [] : ['leadTimeDays']),
  ])
  return {
    id: text(input.id || input.responseId) || `RESP-${text(input.rfqId || input.sourcingEventId || 'UNLINKED').replace(/[^A-Z0-9]+/gi, '-')}-${String(input.index || 1).padStart(3, '0')}`,
    type: 'supplierResponse',
    rfqId: text(input.rfqId || input.sourcingEventId),
    sourcingEventId: text(input.sourcingEventId || input.rfqId),
    supplierId: text(input.supplierId),
    supplierName: supplierName(input),
    quotedPrice: number(input.quotedPrice || input.price),
    quantityOffered: number(input.quantityOffered || input.quantity),
    leadTimeDays: number(input.leadTimeDays || input.leadTime),
    deliveryDate: text(input.deliveryDate),
    paymentTerms: text(input.paymentTerms),
    validityDate: text(input.validityDate),
    qualityComplianceNotes: text(input.qualityComplianceNotes || input.complianceNotes || input.notes),
    source: text(input.source, 'manual'),
    status: missingFields.length ? 'incomplete' : normalizeProcurementStatus('supplierResponse', input.status || 'received'),
    missingFields,
    createdAt: text(input.createdAt) || new Date().toISOString(),
    updatedAt: text(input.updatedAt) || text(input.createdAt) || new Date().toISOString(),
    sideEffects: { ...PROCUREMENT_FORBIDDEN_SIDE_EFFECTS },
  }
}

export function compareSupplierResponses(responses = [], context = {}) {
  const rows = asArray(responses).map((response, index) => {
    const supplier = supplierName(response)
    const riskRow = asArray(context.suppliers).find((item) => supplierName(item).toLowerCase() === supplier.toLowerCase() || text(item.code) === text(response.supplierId))
    const riskStatus = text(riskRow?.riskStatus || riskRow?.risk || response.riskStatus, 'unknown')
    const completenessPenalty = asArray(response.missingFields).length * 12
    const price = number(response.quotedPrice || response.price)
    const lead = number(response.leadTimeDays || response.leadTime)
    const coverage = number(response.quantityOffered || response.quantity)
    const riskPenalty = /高|high/i.test(riskStatus) ? 35 : /中|medium/i.test(riskStatus) ? 16 : 0
    const priceScore = price > 0 ? Math.max(0, 120 - price / 10) : 20
    const leadScore = lead > 0 ? Math.max(0, 60 - lead * 2) : 15
    const coverageScore = Math.min(40, coverage / 10)
    const score = Number((priceScore + leadScore + coverageScore - riskPenalty - completenessPenalty).toFixed(2))
    return {
      ...clone(response),
      rankInputIndex: index,
      supplierRisk: riskStatus,
      score,
      riskFlags: [
        ...(/高|high/i.test(riskStatus) ? ['high_supplier_risk'] : []),
        ...(asArray(response.missingFields).length ? ['incomplete_response'] : []),
      ],
      evidence: [
        { type: 'supplier_response', id: response.id, summary: `${supplier} price ${price}, lead ${lead}` },
        ...(riskRow ? [{ type: 'supplier', id: text(riskRow.code || riskRow.id || supplier), summary: `Risk ${riskStatus}` }] : []),
      ],
    }
  }).sort((a, b) => b.score - a.score || text(a.id).localeCompare(text(b.id)))
  return {
    rankedResponses: rows.map((item, index) => ({ ...item, rank: index + 1 })),
    comparisonSummary: rows[0] ? `${rows[0].supplierName} ranks first after price, lead time, risk, coverage, and completeness checks.` : 'No supplier responses available.',
    evidenceItems: rows.flatMap((item) => item.evidence),
    dataLimitations: unique(rows.flatMap((item) => asArray(item.missingFields).map((field) => `${item.id}:${field}`))),
    missingFields: unique(rows.flatMap((item) => asArray(item.missingFields))),
    riskFlags: unique(rows.flatMap((item) => item.riskFlags)),
    deterministic: true,
    sideEffects: { ...PROCUREMENT_FORBIDDEN_SIDE_EFFECTS },
  }
}

export function buildAwardRecommendationDraft(input = {}) {
  const comparison = input.comparison || compareSupplierResponses(input.responses || [], input.context || {})
  const top = comparison.rankedResponses?.[0] || null
  const confidence = !top || comparison.missingFields?.length ? 'low' : top.riskFlags?.includes('high_supplier_risk') ? 'medium' : 'high'
  return {
    id: input.id || `AWARD-DRAFT-${text(input.rfqId || top?.rfqId || 'RFQ')}`,
    type: 'awardRecommendation',
    rfqId: text(input.rfqId || top?.rfqId),
    sourcingEventId: text(input.sourcingEventId || top?.sourcingEventId || input.rfqId),
    recommendedSupplier: top ? { supplierId: top.supplierId, supplierName: top.supplierName, responseId: top.id } : null,
    rankedAlternatives: comparison.rankedResponses || [],
    decisionRationale: top ? `${top.supplierName} is recommended as a draft based on deterministic response comparison.` : 'Insufficient response evidence.',
    comparisonSummary: comparison.comparisonSummary,
    evidence: comparison.evidenceItems || [],
    dataLimitations: comparison.dataLimitations || [],
    missingFields: comparison.missingFields || [],
    reviewStatus: 'review_required',
    recommendation_confidence: confidence,
    auditPreview: [
      { action: 'award_recommendation_draft_prepared', summary: 'Draft Only. Requires Review. Does not award supplier. Does not create PO. Does not send supplier notification.' },
    ],
    boundary: {
      draftOnly: true,
      requiresReview: true,
      doesNotAwardSupplier: true,
      doesNotCreatePo: true,
      doesNotSendSupplierNotification: true,
    },
    sideEffects: { ...PROCUREMENT_FORBIDDEN_SIDE_EFFECTS },
  }
}

export function buildPoDraftFromAwardRecommendation(recommendation = {}, input = {}) {
  const supplier = recommendation.recommendedSupplier || {}
  const selectedResponse = recommendation.rankedAlternatives?.find((item) => item.id === supplier.responseId) || recommendation.rankedAlternatives?.[0] || {}
  const context = {
    supplier: supplier.supplierName || selectedResponse.supplierName,
    linkedRfqOrQuotation: recommendation.rfqId,
    itemLines: input.itemLines || [{ sku: input.sku || selectedResponse.sku || '', quantity: selectedResponse.quantityOffered || input.quantity, unitPrice: selectedResponse.quotedPrice || input.price }],
    price: selectedResponse.quotedPrice || input.price,
    quantity: selectedResponse.quantityOffered || input.quantity,
    deliveryDate: selectedResponse.deliveryDate || input.deliveryDate,
    paymentTerms: selectedResponse.paymentTerms || input.paymentTerms,
    taxCode: input.taxCode,
    deliveryLocation: input.deliveryLocation,
    missingApprovals: ['buyer_review', 'finance_review', 'manual_po_issue'],
  }
  const draft = buildPurchaseOrderDraft(context)
  const missingFields = unique([...(draft.missingFields || []), ...(number(context.price) > 0 ? [] : ['price'])])
  return {
    id: input.id || `PO-DRAFT-${text(recommendation.rfqId || 'AWARD')}`,
    type: 'poDraft',
    status: missingFields.length ? 'review_required' : 'draft',
    supplier: context.supplier,
    sourceRfq: recommendation.rfqId,
    sourceSourcingEvent: recommendation.sourcingEventId,
    sourcePr: input.sourcePr || input.sourcePrId || '',
    itemLines: context.itemLines,
    price: number(context.price),
    quantity: number(context.quantity),
    deliveryDate: text(context.deliveryDate),
    paymentTerms: text(context.paymentTerms),
    taxCode: text(context.taxCode),
    deliveryLocation: text(context.deliveryLocation),
    missingApprovals: context.missingApprovals,
    missingFields,
    evidence: recommendation.evidence || [],
    provenance: { awardRecommendationId: recommendation.id, draftOnly: true },
    draft,
    boundary: { reviewFirst: true, internalDraftOnly: true, notIssued: true, notSent: true, notApproved: true },
    sideEffects: { ...PROCUREMENT_FORBIDDEN_SIDE_EFFECTS },
  }
}
