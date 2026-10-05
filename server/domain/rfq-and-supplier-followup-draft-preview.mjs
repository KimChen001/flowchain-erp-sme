import { buildInventoryItems } from './inventory-read.mjs'
import { sanitizePrefillMap } from '../../shared/prefill-suggestions.mjs'
import { findMasterItem, findMasterSupplier, listMasterSuppliers } from './master-data.mjs'
import { toActionDraftEvidence } from './action-draft-boundary.mjs'

function text(value, fallback = '') {
  const next = String(value ?? '').trim()
  return next || fallback
}

function asArray(value) {
  return Array.isArray(value) ? value : []
}

function toNumberOrNull(value) {
  if (value === '' || value === undefined || value === null) return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function cleanObject(value = {}) {
  return Object.fromEntries(Object.entries(value || {}).filter(([, item]) => item !== undefined && item !== ''))
}

function draftId(type, now = new Date()) {
  const stamp = now.toISOString().slice(0, 10).replace(/-/g, '')
  return `DRAFT-${type.toUpperCase().replace(/[^A-Z0-9]+/g, '-')}-${stamp}-${String(now.getTime()).slice(-6)}`
}

function findInventoryItem(db = {}, rawSku = '') {
  const key = text(rawSku).toLowerCase()
  if (!key) return null
  return buildInventoryItems(db).find((item) =>
    [item.sku, item.itemName].some((value) => text(value).toLowerCase() === key)
  ) || null
}

function supplierCandidateRows(db = {}, item = {}, explicit = []) {
  const candidates = []
  for (const row of asArray(explicit)) {
    const supplierId = text(row.supplierId || row.id || row.supplierIdOrName)
    const supplierName = text(row.supplierName || row.name || row.supplier)
    if (supplierId || supplierName) candidates.push({ supplierId, supplierName: supplierName || supplierId, source: text(row.source, 'explicit_payload') })
  }

  const masterItem = findMasterItem(db, item.sku)
  const preferred = findMasterSupplier(db, masterItem?.preferredSupplierId) || findMasterSupplier(db, item.supplier)
  if (preferred) candidates.push({ supplierId: preferred.id, supplierName: preferred.name, source: masterItem?.preferredSupplierSource || 'matched_supplier_master' })

  for (const supplier of listMasterSuppliers(db)) {
    candidates.push({ supplierId: supplier.id, supplierName: supplier.name, source: 'master_supplier' })
  }

  const seen = new Set()
  return candidates.filter((candidate) => {
    const key = text(candidate.supplierId || candidate.supplierName).toLowerCase()
    if (!key || seen.has(key)) return false
    seen.add(key)
    return true
  }).slice(0, 5)
}

function validation({ type, itemIdOrSku, quantity, supplierIdOrName, itemMissing = false, supplierMissing = false }) {
  const errors = []
  const warnings = []
  const missingFields = []
  if (type === 'rfq_draft') {
    if (!text(itemIdOrSku)) {
      errors.push('Missing required field: itemIdOrSku')
      missingFields.push('itemIdOrSku')
    }
    if (!quantity) {
      errors.push('Missing required field: quantity')
      missingFields.push('quantity')
    }
    if (itemMissing) errors.push(`No inventory item matched ${text(itemIdOrSku, 'requested item')}.`)
  }
  if (type === 'supplier_followup_draft') {
    if (!text(supplierIdOrName)) {
      errors.push('Missing required field: supplierIdOrName')
      missingFields.push('supplierIdOrName')
    }
    if (supplierMissing) errors.push(`No supplier matched ${text(supplierIdOrName, 'requested supplier')}.`)
  }
  return {
    ok: errors.length === 0 && warnings.length === 0,
    status: errors.length ? 'invalid' : warnings.length ? 'needs_review' : 'ready_for_review',
    errors,
    warnings,
    missingFields,
  }
}

export function validateRfqDraftPayload(payload = {}, options = {}) {
  return validation({
    type: 'rfq_draft',
    itemIdOrSku: payload.itemIdOrSku || payload.sku,
    quantity: payload.quantity,
    itemMissing: options.itemMissing,
  })
}

export function validateSupplierFollowupDraftPayload(payload = {}, options = {}) {
  return validation({
    type: 'supplier_followup_draft',
    supplierIdOrName: payload.supplierIdOrName || payload.supplierId || payload.supplierName,
    supplierMissing: options.supplierMissing,
  })
}

export function buildRfqDraftPreview(input = {}, options = {}) {
  const db = options.db || {}
  const now = options.now instanceof Date ? options.now : new Date()
  const payloadInput = input.payload || {}
  const sku = text(payloadInput.itemIdOrSku || payloadInput.sku)
  const quantity = toNumberOrNull(payloadInput.quantity)
  if (!sku || !quantity) {
    return {
      ok: false,
      status: 'invalid',
      error: 'RFQ draft requires itemIdOrSku and quantity.',
      validation: validateRfqDraftPayload({ itemIdOrSku: sku, quantity }),
    }
  }
  const item = findInventoryItem(db, sku)
  if (!item) {
    return {
      ok: false,
      status: 'not_found',
      error: `No inventory item matched ${sku}.`,
      validation: validateRfqDraftPayload({ itemIdOrSku: sku, quantity }, { itemMissing: true }),
    }
  }
  const supplierCandidates = supplierCandidateRows(db, item, payloadInput.supplierCandidates)
  const draftPayload = cleanObject({
    itemIdOrSku: item.sku,
    itemName: item.itemName,
    quantity,
    unit: text(payloadInput.unit || item.unit),
    supplierCandidates,
    requestedDeliveryDate: text(payloadInput.requestedDeliveryDate || payloadInput.targetDeliveryDate || payloadInput.requiredDate),
    reason: text(payloadInput.reason || input.reason || item.riskReason || 'RFQ draft preview prepared from operational context.'),
    requiresConfirmation: true,
  })
  const originEvidence = [
    ...asArray(input.originEvidence),
    { type: 'inventory_item', id: item.sku, label: item.itemName, status: item.status, summary: item.riskReason, route: `/api/inventory/items/${encodeURIComponent(item.sku)}` },
    ...supplierCandidates.slice(0, 2).map((supplier) => ({ type: 'supplier_master', id: supplier.supplierId, label: supplier.supplierName, summary: `RFQ candidate source: ${supplier.source}` })),
  ].map(toActionDraftEvidence).filter((entry) => entry.id || entry.label || entry.summary).slice(0, 6)

  return {
    ok: true,
    draft: {
      id: text(input.id, draftId('rfq_draft', now)),
      type: 'rfq_draft',
      title: text(input.title, `RFQ Draft · ${item.sku}`),
      status: 'preview',
      source: text(input.source, 'ai_assistant'),
      createdBy: cleanObject(input.createdBy || { type: 'system', id: 'flowchain', name: 'FlowChain' }),
      createdAt: input.createdAt || now.toISOString(),
      requiresConfirmation: true,
      originEvidence,
      payload: draftPayload,
      validation: validateRfqDraftPayload(draftPayload),
      auditTrail: [{ action: 'rfq_draft_previewed', source: 'draft_preview', timestamp: input.createdAt || now.toISOString(), summary: 'RFQ draft preview prepared. No RFQ record was created.' }],
      confirmationBoundary: { previewOnly: true, submitted: false, requiresUserReview: true, futureConfirmation: 'create_rfq' },
    },
  }
}

function defaultFollowupMessage({ supplierName, relatedDocumentType, relatedDocumentId, reason }) {
  return [
    `您好，${supplierName || '供应商'}：`,
    `请协助确认${relatedDocumentType || '相关单据'} ${relatedDocumentId || ''} 的当前处理进展。`,
    reason ? `关注点：${reason}。` : '请反馈预计完成时间和需要我们配合的事项。',
  ].filter(Boolean).join(' ')
}

export function buildSupplierFollowupDraftPreview(input = {}, options = {}) {
  const db = options.db || {}
  const now = options.now instanceof Date ? options.now : new Date()
  const payloadInput = input.payload || {}
  const supplierKey = text(payloadInput.supplierIdOrName || payloadInput.supplierId || payloadInput.supplierName)
  if (!supplierKey) {
    return {
      ok: false,
      status: 'invalid',
      error: 'Supplier follow-up draft requires supplierIdOrName.',
      validation: validateSupplierFollowupDraftPayload({ supplierIdOrName: '' }),
    }
  }
  const supplier = findMasterSupplier(db, supplierKey) || { id: supplierKey, name: supplierKey, status: '', source: 'payload_fallback' }
  // An invoice variance query is about the invoice, not its purchase order.
  const relatedDocumentType = text(payloadInput.relatedDocumentType || payloadInput.documentType || (payloadInput.invoiceId ? 'supplier_invoice' : ''))
  const relatedDocumentId = text(payloadInput.relatedDocumentId || payloadInput.documentId || payloadInput.invoiceId || payloadInput.poId || payloadInput.rfqId)
  const reason = text(payloadInput.followupReason || payloadInput.reason)
  const messageDraft = text(payloadInput.message || payloadInput.messageDraft, defaultFollowupMessage({
    supplierName: supplier.name,
    relatedDocumentType,
    relatedDocumentId,
    reason,
  }))
  const draftPayload = cleanObject({
    supplierId: supplier.id,
    supplierName: supplier.name,
    // Recipient and subject when the request carries them (supplier master
    // data, prefilled by the assistant); the user can change both.
    to: text(payloadInput.to),
    contactName: text(payloadInput.contactName),
    subject: text(payloadInput.subject),
    relatedDocumentType,
    relatedDocumentId,
    followupReason: reason,
    messageDraft,
    ...(Array.isArray(payloadInput.lines) && payloadInput.lines.length ? { lines: payloadInput.lines.slice(0, 50) } : {}),
    // The purchase order stays named when the related document is another one.
    poId: text(payloadInput.poId) !== relatedDocumentId ? text(payloadInput.poId) : '',
    severity: text(payloadInput.severity, 'medium'),
    dueDate: text(payloadInput.dueDate),
    requiresConfirmation: true,
  })
  const originEvidence = [
    ...asArray(input.originEvidence),
    { type: 'supplier_master', id: supplier.id, label: supplier.name, status: supplier.status, summary: 'Matched supplier for follow-up draft.' },
    ...(relatedDocumentId ? [{ type: relatedDocumentType || 'procurement_document', id: relatedDocumentId, summary: reason || messageDraft }] : []),
  ].map(toActionDraftEvidence).filter((entry) => entry.id || entry.label || entry.summary).slice(0, 6)

  // The message is stored as messageDraft here, so its suggestion is too.
  const suggested = sanitizePrefillMap(input.prefill)
  const prefill = suggested && Object.fromEntries(Object.entries(suggested).map(([field, entry]) => [field === 'message' ? 'messageDraft' : field, entry]))
  return {
    ok: true,
    draft: {
      id: text(input.id, draftId('supplier_followup_draft', now)),
      type: 'supplier_followup_draft',
      title: text(input.title, `Supplier Follow-up Draft · ${supplier.id}`),
      status: 'preview',
      source: text(input.source, 'today_cockpit'),
      createdBy: cleanObject(input.createdBy || { type: 'system', id: 'flowchain', name: 'FlowChain' }),
      createdAt: input.createdAt || now.toISOString(),
      requiresConfirmation: true,
      originEvidence,
      payload: draftPayload,
      ...(prefill ? { prefill } : {}),
      validation: validateSupplierFollowupDraftPayload(draftPayload),
      auditTrail: [{ action: 'supplier_followup_draft_previewed', source: 'draft_preview', timestamp: input.createdAt || now.toISOString(), summary: 'Supplier follow-up draft preview prepared. No message was sent.' }],
      confirmationBoundary: { previewOnly: true, submitted: false, requiresUserReview: true, futureConfirmation: 'send_or_record_supplier_followup' },
    },
  }
}
