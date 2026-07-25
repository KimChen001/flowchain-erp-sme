import {
  normalizeConfirmedActionScope,
  validateUserConfirmedActionRequest,
} from '../domain/user-confirmed-business-action.mjs'

function clone(value) {
  return JSON.parse(JSON.stringify(value ?? null))
}

function text(value = '') {
  return String(value ?? '').trim()
}

function scopeKey(scope = {}) {
  const normalized = normalizeConfirmedActionScope(scope)
  return `${normalized.tenantId}::${normalized.userId}::${normalized.dataMode}`
}

function ensureState(db = {}) {
  if (!db.__userConfirmedActionState) {
    Object.defineProperty(db, '__userConfirmedActionState', {
      value: { recordsByScope: new Map(), counters: new Map() },
      enumerable: false,
      configurable: true,
      writable: true,
    })
  }
  return db.__userConfirmedActionState
}

function rowsFor(state, scope = {}) {
  const key = scopeKey(scope)
  if (!state.recordsByScope.has(key)) state.recordsByScope.set(key, [])
  return state.recordsByScope.get(key)
}

function nextScopedId(state, scope = {}, prefix = 'UCA') {
  const key = `${scopeKey(scope)}::${prefix}`
  const next = Number(state.counters.get(key) || 0) + 1
  state.counters.set(key, next)
  return `${prefix}-${String(next).padStart(6, '0')}`
}

function recordPrefix(actionType = '') {
  if (actionType === 'create_supplier_application') return 'SUPAPP'
  if (actionType === 'create_purchase_request') return 'PR-DRAFT'
  if (actionType === 'create_sourcing_event') return 'SRC'
  if (actionType === 'create_rfq') return 'RFQ-DRAFT'
  if (actionType === 'save_supplier_followup_note') return 'SFN'
  if (actionType === 'save_exception_case_note') return 'ECN'
  if (actionType === 'save_exception_resolution_note') return 'ECR'
  return 'RVD'
}

function statusFor(actionType = '') {
  if (actionType === 'create_supplier_application') return 'pending_review'
  if (actionType === 'create_purchase_request') return 'draft'
  if (actionType === 'create_sourcing_event') return 'internal_review'
  if (actionType === 'create_rfq') return 'open_draft'
  if (actionType.includes('note')) return 'saved_internal'
  return 'reviewed'
}

function createdTypeFor(actionType = '') {
  if (actionType === 'create_supplier_application') return 'supplierApplication'
  if (actionType === 'create_purchase_request') return 'purchaseRequest'
  if (actionType === 'create_sourcing_event') return 'sourcingEvent'
  if (actionType === 'create_rfq') return 'rfq'
  if (actionType === 'save_supplier_followup_note') return 'supplierFollowupNote'
  if (actionType === 'save_exception_case_note') return 'exceptionCaseNote'
  if (actionType === 'save_exception_resolution_note') return 'exceptionResolutionNote'
  return 'reviewedDraft'
}

function safeSideEffects(actionType = '') {
  return {
    writesRuntimeRepository: true,
    writesFiles: false,
    overwritesDemoData: false,
    mutatesLinkedBusinessRecords: false,
    submitsForApproval: false,
    approves: false,
    issuesPo: false,
    sendsExternalEmail: false,
    sendsRfqExternally: false,
    awardsSupplier: false,
    createsPurchaseOrder: false,
    paysInvoice: false,
    postsInvoice: false,
    postsInventory: false,
    mutatesInventoryBalance: false,
    mutatesSupplierMaster: false,
    autoClosesCase: false,
    actionType,
  }
}

function buildCreatedRecord(state, action = {}, idFactory) {
  const prefix = recordPrefix(action.actionType)
  const id = idFactory ? idFactory(prefix) : nextScopedId(state, action.scope, prefix)
  const fields = action.reviewedFields || {}
  return {
    id,
    type: createdTypeFor(action.actionType),
    status: statusFor(action.actionType),
    fields: clone(fields),
    linkedRecords: clone(action.linkedRecords || []),
    evidenceReferences: clone(action.evidenceReferences || []),
    dataLimitationsAcknowledged: clone(action.dataLimitationsAcknowledged || []),
    provenance: {
      createdFromAiAssistedDraft: Boolean(action.draftId || action.draftSessionId),
      draftId: action.draftId || null,
      draftSessionId: action.draftSessionId || null,
      sourceTrigger: action.sourceTrigger,
      confirmedBy: action.actor,
      confirmedAt: action.createdAt,
    },
  }
}

export function buildConfirmedActionRecord(action = {}, { idFactory } = {}) {
  const state = { counters: new Map() }
  const createdRecord = buildCreatedRecord(state, action, idFactory)
  return {
    ...action,
    createdRecordId: createdRecord.id,
    createdRecordType: createdRecord.type,
    status: createdRecord.status,
    createdRecord,
    sideEffects: safeSideEffects(action.actionType),
    auditPreview: action.auditPreview?.length ? action.auditPreview : [
      { action: 'user_confirmed_creation', summary: `${action.actionType} will create/save ${createdRecord.type} ${createdRecord.id}.` },
    ],
    aiGeneratedDraftOnly: false,
    userConfirmedCreation: true,
  }
}

export function createInMemoryUserConfirmedActionRepository({ db = {} } = {}) {
  return {
    adapter: 'in-memory-user-confirmed-action-v1',
    executeConfirmedAction: async (input = {}) => {
      const validation = validateUserConfirmedActionRequest(input)
      if (!validation.ok) {
        const error = new Error('User-confirmed action rejected by execution boundary.')
        error.status = 422
        error.code = 'USER_CONFIRMED_ACTION_REJECTED'
        error.validation = validation
        throw error
      }
      const state = ensureState(db)
      const action = validation.action
      const record = buildConfirmedActionRecord(action, {
        idFactory: (prefix) => nextScopedId(state, action.scope, prefix),
      })
      rowsFor(state, action.scope).unshift(record)
      return clone(record)
    },
    listConfirmedActions: async (scope = {}, filters = {}) => {
      const state = ensureState(db)
      return clone(rowsFor(state, scope).filter((item) =>
        (!filters.actionType || item.actionType === filters.actionType) &&
        (!filters.createdRecordType || item.createdRecordType === filters.createdRecordType)
      ))
    },
    getConfirmedAction: async (scope = {}, actionId = '') => {
      const state = ensureState(db)
      return clone(rowsFor(state, scope).find((item) => item.actionId === actionId || item.createdRecordId === actionId || text(item.createdRecord?.id) === actionId) || null)
    },
    _debugState: () => clone(Array.from(ensureState(db).recordsByScope.values()).flat()),
  }
}
