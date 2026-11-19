import { appendAuditEvent, ensureAuditLog } from '../domain/audit-foundation.mjs'

// The entity type matches whatever its case (purchaseOrder, PurchaseOrder).
const sameType = (value, wanted) => String(value || '').toLowerCase() === wanted

function matchesFilter(entry = {}, filters = {}) {
  const entityType = String(filters.entityType || '').toLowerCase()
  const entityId = filters.entityId || ''
  return (!entityType || sameType(entry.entityType, entityType) || sameType(entry.entity?.type, entityType)) &&
    (!entityId || entry.entityId === entityId || entry.entity?.id === entityId)
}

export function listAuditEvents(db = {}) {
  return ensureAuditLog(db)
}

export function recordAuditEvent(db = {}, entry = {}, options = {}) {
  return appendAuditEvent(db, entry, options)
}

export function listAuditEntries(db = {}, filters = {}) {
  const limit = Math.min(200, Math.max(1, Number(filters.limit || 100)))
  return listAuditEvents(db).filter((entry) => matchesFilter(entry, filters)).slice(0, limit)
}

export function recordAuditEntry(db = {}, entry = {}, options = {}) {
  return recordAuditEvent(db, entry, options)
}

export function recordAiEventBestEffort(db = {}, entry = {}, options = {}) {
  try {
    return { ok: true, entry: recordAuditEntry(db, { ...entry, source: 'ai_assisted' }, options) }
  } catch (error) {
    return { ok: false, errorCode: error?.code || error?.name || 'audit_failed' }
  }
}

export function createAuditLogRepository(db = {}) {
  return {
    listAuditEntries: (filters = {}) => listAuditEntries(db, filters),
    recordAuditEntry: (entry = {}, options = {}) => recordAuditEntry(db, entry, options),
    recordAiEventBestEffort: (entry = {}, options = {}) => recordAiEventBestEffort(db, entry, options),
    listAuditEvents: () => listAuditEvents(db),
    recordAuditEvent: (entry = {}, options = {}) => recordAuditEvent(db, entry, options),
  }
}
