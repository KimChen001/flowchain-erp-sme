export const SAFE_CONFIRMED_ACTION_TYPES = Object.freeze([
  'create_supplier_application',
  'create_purchase_request',
  'create_sourcing_event',
  'create_rfq',
  'save_supplier_followup_note',
  'save_exception_case_note',
  'save_exception_resolution_note',
  'save_reviewed_draft',
])

export const FORBIDDEN_CONFIRMED_ACTION_TYPES = Object.freeze([
  'submit_pr',
  'approve_pr',
  'issue_po',
  'send_rfq',
  'send_email',
  'award_supplier',
  'create_po_from_award',
  'approve_invoice',
  'pay_invoice',
  'post_invoice',
  'post_inventory_movement',
  'mutate_supplier_master',
  'auto_close_case',
])

export const BUSINESS_ACTION_EXECUTION_BASELINE = Object.freeze({
  inspectedFiles: [
    'server/domain/business-action-draft-contract.mjs',
    'server/domain/business-draft-builders.mjs',
    'server/domain/business-action-intake.mjs',
    'src/modules/action-drafts/ActionDraftReviewShell.tsx',
    'server/routes/purchase-requests.routes.mjs',
    'server/routes/rfqs.routes.mjs',
    'server/routes/exception-cases.routes.mjs',
    'server/domain/audit-policy.mjs',
    'server/repositories/adapter-registry.mjs',
  ],
  recommendedBoundary: 'Create only scoped, user-confirmed safe records through userConfirmedActions; never reuse legacy PR/RFQ mutation routes for AI-assisted execution.',
  safeRecordTypes: [...SAFE_CONFIRMED_ACTION_TYPES],
  forbiddenActions: [...FORBIDDEN_CONFIRMED_ACTION_TYPES],
})

let actionCounter = 0

function text(value = '') {
  return String(value ?? '').trim()
}

function clone(value) {
  return JSON.parse(JSON.stringify(value ?? null))
}

function nextActionId(type = 'action') {
  actionCounter += 1
  return `UCA-${text(type).replace(/[^A-Z0-9]+/gi, '-').toUpperCase().slice(0, 24)}-${String(actionCounter).padStart(6, '0')}`
}

export function normalizeConfirmedActionScope(input = {}) {
  const scope = input.scope || {}
  return {
    tenantId: text(scope.tenantId || input.tenantId) || 'tenant-flowchain-sme',
    userId: text(scope.userId || input.userId || input.actor) || 'user-local',
    dataMode: text(scope.dataMode || input.dataMode || input.mode) || 'json',
  }
}

export function normalizeUserConfirmedActionRequest(input = {}) {
  const draft = input.draft || input.reviewedDraft || {}
  const reviewedFields = input.reviewedFields || input.fields || draft.extractedFields || draft.payload || {}
  const sourceContext = input.sourceContext || draft.sourceContext || {}
  const actionType = text(input.actionType || actionTypeForDraft(draft.draftType || draft.type))
  return {
    actionId: text(input.actionId) || nextActionId(actionType),
    draftId: text(input.draftId || draft.draftId || draft.id),
    draftSessionId: text(input.draftSessionId || input.sessionId || draft.sessionId),
    actionType,
    sourceTrigger: text(input.sourceTrigger || draft.sourceTrigger || sourceContext.sourceTrigger) || 'natural_language',
    sourceModule: text(input.sourceModule || sourceContext.sourceModule || sourceContext.module),
    sourceEntityType: text(input.sourceEntityType || sourceContext.sourceEntityType || sourceContext.entityType),
    sourceEntityId: text(input.sourceEntityId || sourceContext.sourceEntityId || sourceContext.entityId),
    reviewedFields: clone(reviewedFields) || {},
    linkedRecords: clone(input.linkedRecords || draft.linkedRecords || draft.originEvidence || []) || [],
    evidenceReferences: clone(input.evidenceReferences || input.evidence || draft.evidence || draft.originEvidence || []) || [],
    dataLimitationsAcknowledged: clone(input.dataLimitationsAcknowledged || input.dataLimitations || draft.dataLimitations || []) || [],
    explicitUserConfirmation: input.explicitUserConfirmation === true || input.confirm === true || input.confirmedByUser === true,
    confirmedByAi: input.confirmedByAi === true || input.autonomousExecutionAllowed === true || input.sourceTrigger === 'ai_autonomous',
    actor: text(input.actor || input.user || input.confirmedBy) || 'current_user',
    scope: normalizeConfirmedActionScope(input),
    auditPreview: clone(input.auditPreview || draft.auditPreview || []),
    createdAt: input.createdAt || new Date().toISOString(),
  }
}

export function validateUserConfirmedActionRequest(input = {}) {
  const action = normalizeUserConfirmedActionRequest(input)
  const errors = []
  if (!SAFE_CONFIRMED_ACTION_TYPES.includes(action.actionType)) errors.push(code('unsupported_action_type', `Unsupported confirmed action type: ${action.actionType}.`, 'actionType'))
  if (FORBIDDEN_CONFIRMED_ACTION_TYPES.includes(action.actionType)) errors.push(code('forbidden_action_type', `${action.actionType} remains forbidden and out of scope.`, 'actionType'))
  if (!action.explicitUserConfirmation) errors.push(code('missing_confirmation', 'Explicit user confirmation is required.', 'confirm'))
  if (action.confirmedByAi) errors.push(code('ai_confirmation_forbidden', 'AI/autonomous execution cannot provide confirmation.', 'confirmedByAi'))
  errors.push(...requiredFieldErrors(action))
  return {
    ok: errors.length === 0,
    action,
    errors,
    forbiddenActions: [...FORBIDDEN_CONFIRMED_ACTION_TYPES],
    safeActionTypes: [...SAFE_CONFIRMED_ACTION_TYPES],
    mutationAllowed: false,
    autonomousExecutionAllowed: false,
  }
}

export function buildUserConfirmedActionAuditEntry(record = {}) {
  return {
    source: 'user_confirmed',
    module: 'user-confirmed-actions',
    action: 'user_confirmed_business_action',
    entity: { type: record.actionType || 'userConfirmedAction', id: record.createdRecordId || record.actionId },
    summary: `User confirmed ${record.actionType} from reviewed draft ${record.draftId || 'without draft id'}.`,
    tenantId: record.scope?.tenantId,
    metadata: {
      actionId: record.actionId,
      actionType: record.actionType,
      draftId: record.draftId,
      draftSessionId: record.draftSessionId,
      createdRecordId: record.createdRecordId,
      createdRecordStatus: record.status,
      sourceTrigger: record.sourceTrigger,
      linkedRecords: record.linkedRecords,
      evidenceReferenceCount: (record.evidenceReferences || []).length,
      dataLimitationsAcknowledged: record.dataLimitationsAcknowledged,
      userConfirmedCreation: true,
      aiGeneratedDraftOnly: false,
    },
  }
}

function actionTypeForDraft(draftType = '') {
  const map = {
    supplier_application: 'create_supplier_application',
    purchase_request: 'create_purchase_request',
    sourcing_event: 'create_sourcing_event',
    rfq: 'create_rfq',
    supplier_followup: 'save_supplier_followup_note',
    exception_note: 'save_exception_case_note',
    purchase_request_draft: 'create_purchase_request',
    rfq_draft: 'create_rfq',
    supplier_followup_draft: 'save_supplier_followup_note',
  }
  return map[text(draftType)] || ''
}

function code(codeValue, message, path) {
  return { code: codeValue, message, path, severity: 'error' }
}

function has(value) {
  return text(value) !== ''
}

function requiredFieldErrors(action = {}) {
  const f = action.reviewedFields || {}
  const errors = []
  if (action.actionType === 'create_supplier_application') {
    if (!has(f.supplierName || f.supplier || f.name)) errors.push(code('missing_supplier_name', 'Supplier application requires supplierName.', 'reviewedFields.supplierName'))
    if (!has(f.category || f.reasonForOnboarding || f.onboardingReason)) errors.push(code('missing_supplier_category_or_reason', 'Supplier application requires category or onboarding reason.', 'reviewedFields.category'))
  }
  if (action.actionType === 'create_purchase_request') {
    if (!has(f.sku || f.itemIdOrSku || f.sourceSku)) errors.push(code('missing_sku', 'Purchase Request requires SKU/item.', 'reviewedFields.sku'))
    if (!(Number(f.quantity || f.suggestedQuantity) > 0)) errors.push(code('missing_quantity', 'Purchase Request requires positive quantity.', 'reviewedFields.quantity'))
  }
  if (action.actionType === 'create_sourcing_event') {
    if (!has(f.eventTitle || f.title)) errors.push(code('missing_event_title', 'Sourcing event requires title.', 'reviewedFields.eventTitle'))
    if (!has(f.itemOrCategory || f.sku || f.itemIdOrSku)) errors.push(code('missing_item_or_category', 'Sourcing event requires item or category.', 'reviewedFields.itemOrCategory'))
  }
  if (action.actionType === 'create_rfq') {
    if (!has(f.itemOrCategory || f.itemIdOrSku || f.sku || f.sourcePrOrSku)) errors.push(code('missing_item_or_category', 'RFQ requires item, SKU, category, or source PR.', 'reviewedFields.itemOrCategory'))
  }
  if (['save_supplier_followup_note', 'save_exception_case_note', 'save_exception_resolution_note'].includes(action.actionType)) {
    if (!has(f.messageDraft || f.message || f.body || f.note || f.resolutionNote)) errors.push(code('missing_note_body', 'Confirmed note save requires note content.', 'reviewedFields.body'))
  }
  return errors
}
