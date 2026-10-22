import { sanitizePrefillMap } from '../../shared/prefill-suggestions.mjs'

export const supportedActionDraftTypes = Object.freeze([
  {
    type: 'purchase_request_draft',
    label: 'Purchase Request Draft',
    sourceModules: ['ai_assistant', 'today_cockpit', 'inventory'],
    requiredPayloadFields: ['itemIdOrSku', 'quantity'],
    futureConfirmation: 'create_purchase_request',
  },
  {
    type: 'rfq_draft',
    label: 'RFQ Draft',
    sourceModules: ['ai_assistant', 'today_cockpit', 'procurement'],
    requiredPayloadFields: ['itemIdOrSku', 'quantity'],
    futureConfirmation: 'create_rfq',
  },
  {
    type: 'po_followup_draft',
    label: 'PO Follow-up Draft',
    sourceModules: ['ai_assistant', 'today_cockpit', 'procurement'],
    requiredPayloadFields: ['poId', 'message'],
    futureConfirmation: 'send_or_record_po_followup',
  },
  {
    type: 'inventory_exception_closure_draft',
    label: 'Inventory Exception Closure Draft',
    sourceModules: ['ai_assistant', 'today_cockpit', 'inventory'],
    requiredPayloadFields: ['exceptionId', 'resolution'],
    futureConfirmation: 'close_inventory_exception',
  },
  {
    type: 'supplier_followup_draft',
    label: 'Supplier Follow-up Draft',
    sourceModules: ['ai_assistant', 'today_cockpit', 'srm'],
    requiredPayloadFields: ['supplierIdOrName', 'message'],
    futureConfirmation: 'send_or_record_supplier_followup',
  },
])

const typeById = new Map(supportedActionDraftTypes.map((item) => [item.type, item]))

function text(value, fallback = '') {
  const next = String(value ?? '').trim()
  return next || fallback
}

function asArray(value) {
  return Array.isArray(value) ? value : []
}

function cleanObject(value = {}) {
  return Object.fromEntries(Object.entries(value || {}).filter(([, item]) => item !== undefined && item !== ''))
}

function draftId(type, now = new Date()) {
  const stamp = now.toISOString().slice(0, 10).replace(/-/g, '')
  return `DRAFT-${type.toUpperCase().replace(/[^A-Z0-9]+/g, '-')}-${stamp}-${String(now.getTime()).slice(-6)}`
}

export function getSupportedActionDraftTypes() {
  return supportedActionDraftTypes.map((item) => ({
    ...item,
    requiredPayloadFields: [...item.requiredPayloadFields],
    sourceModules: [...item.sourceModules],
  }))
}

export function validateActionDraftPayload(type = '', payload = {}) {
  const definition = typeById.get(type)
  if (!definition) {
    return {
      ok: false,
      status: 'unsupported_type',
      errors: [`Unsupported draft type: ${text(type, 'missing')}`],
      missingFields: [],
    }
  }
  const missingFields = definition.requiredPayloadFields.filter((field) => {
    const value = payload[field]
    return value === undefined || value === null || value === ''
  })
  return {
    ok: missingFields.length === 0,
    status: missingFields.length ? 'needs_review' : 'ready_for_review',
    errors: missingFields.map((field) => `Missing required field: ${field}`),
    missingFields,
  }
}

export function toActionDraftEvidence(item = {}) {
  return cleanObject({
    type: text(item.type || item.documentType || item.entityType, 'evidence'),
    id: text(item.id || item.documentId || item.entityId || item.sku),
    label: text(item.label || item.title || item.summary),
    status: text(item.status || item.matchStatus),
    route: text(item.route || item.path),
    summary: text(item.summary || item.reason || item.nextAction),
  })
}

export function buildActionDraftSuggestion(input = {}, options = {}) {
  const now = options.now instanceof Date ? options.now : new Date()
  const type = text(input.type)
  const definition = typeById.get(type)
  if (!definition) {
    return {
      ok: false,
      status: 'unsupported_type',
      error: `Unsupported draft type: ${text(type, 'missing')}`,
      supportedTypes: getSupportedActionDraftTypes().map((item) => item.type),
    }
  }

  const payload = cleanObject(input.payload || {})
  const validation = validateActionDraftPayload(type, payload)
  const prefill = sanitizePrefillMap(input.prefill)
  const draft = {
    id: text(input.id, draftId(type, now)),
    type,
    title: text(input.title, definition.label),
    status: 'preview',
    source: text(input.source, 'ai_assistant'),
    createdBy: cleanObject(input.createdBy || {
      type: 'system',
      id: 'ai-assistant',
      name: 'AI Assistant',
    }),
    createdAt: input.createdAt || now.toISOString(),
    requiresConfirmation: true,
    originEvidence: asArray(input.originEvidence).map(toActionDraftEvidence).filter((item) => item.id || item.label || item.summary).slice(0, 6),
    payload,
    ...(prefill ? { prefill } : {}),
    validation,
    auditTrail: [
      {
        action: 'ai_draft_prepared',
        source: 'ai_assisted',
        timestamp: input.createdAt || now.toISOString(),
        summary: '草稿预览已生成；未创建或提交业务记录。',
      },
    ],
    confirmationBoundary: {
      previewOnly: true,
      submitted: false,
      requiresUserReview: true,
      futureConfirmation: definition.futureConfirmation,
    },
  }

  return { ok: true, draft }
}

export function actionDraftSchema() {
  return {
    previewOnly: true,
    statusValues: ['preview'],
    commonFields: [
      'id',
      'type',
      'title',
      'status',
      'source',
      'createdBy',
      'createdAt',
      'requiresConfirmation',
      'originEvidence',
      'payload',
      'validation',
      'auditTrail',
    ],
    supportedTypes: getSupportedActionDraftTypes(),
    confirmationBoundary: {
      draftIsNotSubmitted: true,
      userMustReview: true,
      userMustConfirm: true,
      writeBehaviorFutureWork: true,
      autonomousExecutionAllowed: false,
    },
    auditBoundary: {
      futureConfirmedActionsShouldRecordAudit: true,
      recordAiSourceAndEvidence: true,
      storeSecrets: false,
      storeRawPromptByDefault: false,
    },
    recommendedActionMapping: {
      todayCockpitInventoryRisk: 'purchase_request_draft',
      todayCockpitProcurementFollowup: 'supplier_followup_draft',
      threeWayMatchException: 'po_followup_draft',
      inventoryException: 'inventory_exception_closure_draft',
      aiPrPrompt: 'purchase_request_draft',
      aiRfqPrompt: 'rfq_draft',
    },
  }
}
