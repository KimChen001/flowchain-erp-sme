// Archived process-memory import prototype. Test-only: not a production repository.
import { createHash, randomUUID } from 'node:crypto'

const state = {
  previews: new Map(),
  batches: new Map(),
  idempotency: new Map(),
  records: new Map(),
  auditEvents: [],
  inventoryMovements: [],
}

const BUSINESS_CONFIG = Object.freeze({
  'supplier-invoice': { businessObject: 'supplier_invoice', key: 'invoiceNumber', policy: 'reject_duplicates', collection: 'supplierInvoices', required: ['invoiceNumber', 'supplierCode', 'relatedPo', 'invoiceDate', 'dueDate', 'currency', 'total'] },
  'supplier-reconciliation': { businessObject: 'supplier_reconciliation', key: 'statementNo', policy: 'reject_duplicates', collection: 'supplierReconciliations', required: ['statementNo', 'supplierCode', 'periodStart', 'periodEnd', 'currency', 'status'] },
  'purchase-request': { businessObject: 'purchase_request', key: 'pr', policy: 'reject_duplicates', collection: 'purchaseRequests', required: ['pr', 'sourceSku', 'quantity', 'unit', 'requiredDate', 'priority', 'status'] },
  'supplier-master': { businessObject: 'supplier_master', key: 'code', policy: 'upsert', collection: 'suppliers', required: ['code', 'name', 'category', 'contact', 'email', 'currency', 'status'] },
  'item-master': { businessObject: 'item_master', key: 'sku', policy: 'upsert', collection: 'products', required: ['sku', 'name', 'category', 'unit', 'defaultWarehouse', 'safetyStock', 'status'] },
  'customer-master': { businessObject: 'customer_master', key: 'code', policy: 'upsert', collection: 'customers', required: ['code', 'name', 'contact', 'email', 'currency', 'status'] },
  'inventory-balance': { businessObject: 'inventory_balance', key: (row) => `${row.warehouse}::${row.bin}::${row.sku}`, policy: 'inventory_adjustment', collection: 'inventoryBalances', required: ['sku', 'warehouse', 'bin', 'quantity', 'asOfDate', 'status'] },
})

const DURABLE_IMPORT_LIMITATIONS = Object.freeze([
  '正式业务数据已经写入 authoritative repositories。',
  '当前版本不支持自动回滚；请通过对应业务模块创建反向调整或人工修正。',
])

function clone(value) { return JSON.parse(JSON.stringify(value ?? null)) }
function text(value = '') { return String(value ?? '').trim() }
function stable(value) {
  if (Array.isArray(value)) return value.map(stable)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]))
}
function hash(value) { return createHash('sha256').update(JSON.stringify(stable(value))).digest('hex') }
function keyFor(config, row) { return typeof config.key === 'function' ? config.key(row) : text(row[config.key]) }
function collection(name) {
  if (!state.records.has(name)) state.records.set(name, [])
  return state.records.get(name)
}
function audit(action, entity, metadata, actor = '当前用户') {
  const event = {
    id: `AUD-IMP-${randomUUID().slice(0, 8)}`,
    timestamp: new Date().toISOString(),
    actor: { type: 'user', id: actor, name: actor, role: 'analyst' },
    source: 'manual', module: 'imports', action, entity,
    summary: action === 'import_batch_rolled_back' ? `导入批次 ${entity.id} 已回滚` : `导入批次 ${entity.id} 已提交`,
    metadata: clone(metadata),
  }
  state.auditEvents.unshift(event)
  return event
}

function normalizeRows(rows = []) {
  return rows.map((row) => Object.fromEntries(Object.entries(row || {}).map(([key, value]) => [key, typeof value === 'string' ? value.trim() : value])))
}
function materializeBusinessRow(schemaId, row, actor) {
  if (schemaId !== 'purchase-request') return row
  return {
    ...row,
    source: row.source || 'excel-import',
    sourceName: row.sourceName || row.sourceSku || '',
    supplier: row.supplier || row.supplierCode || '未选择供应商',
    requester: row.requester || actor || '当前用户',
    buyer: row.buyer || actor || '当前用户',
    created: row.created || new Date().toISOString().slice(0, 10),
    unitPrice: Number(row.unitPrice || 0),
    amount: Number(row.amount || 0),
    reason: row.reason || 'Excel 正式导入',
    linkedPo: row.linkedPo || '', approvedAt: row.approvedAt || '', convertedAt: row.convertedAt || '',
  }
}
function validateServerRows(config, rows, relationships = {}) {
  const errors = []; const warnings = []
  rows.forEach((row, index) => {
    const rowNumber = index + 2
    for (const field of config.required || []) if (row[field] === '' || row[field] === null || row[field] === undefined) errors.push({ code: 'required_field_missing', rowNumber, field, message: `${field} is required` })
    for (const field of ['quantity', 'safetyStock', 'subtotal', 'tax', 'total', 'totalInvoiceAmount', 'openBalance']) if (row[field] !== undefined && row[field] !== '' && (!Number.isFinite(Number(row[field])) || Number(row[field]) < 0)) errors.push({ code: 'invalid_non_negative_number', rowNumber, field, message: `${field} must be a non-negative number` })
    for (const field of ['invoiceDate', 'dueDate', 'periodStart', 'periodEnd', 'requiredDate', 'asOfDate']) if (row[field] && !/^\d{4}-\d{2}-\d{2}$/.test(String(row[field]))) errors.push({ code: 'invalid_date', rowNumber, field, message: `${field} must use YYYY-MM-DD` })
    if (row.sourceSku && relationships.skus?.length && !relationships.skus.includes(String(row.sourceSku))) errors.push({ code: 'unknown_sku', rowNumber, field: 'sourceSku', message: 'Referenced SKU does not exist' })
    if (row.sku && relationships.skus?.length && !relationships.skus.includes(String(row.sku))) errors.push({ code: 'unknown_sku', rowNumber, field: 'sku', message: 'Referenced SKU does not exist' })
    if (row.relatedPo && relationships.purchaseOrders?.length && !relationships.purchaseOrders.includes(String(row.relatedPo))) errors.push({ code: 'unknown_purchase_order', rowNumber, field: 'relatedPo', message: 'Referenced PO does not exist' })
    if (row.relatedGrn && relationships.receivingDocs?.length && !relationships.receivingDocs.includes(String(row.relatedGrn))) errors.push({ code: 'unknown_receiving_document', rowNumber, field: 'relatedGrn', message: 'Referenced GRN does not exist' })
    if (row.supplierCode && relationships.suppliers?.length && !relationships.suppliers.includes(String(row.supplierCode))) warnings.push({ code: 'supplier_reference_requires_review', rowNumber, field: 'supplierCode', message: 'Supplier code was not found in the active server master-data snapshot' })
  })
  return { errors, warnings }
}

export function createImportPreview(input = {}, options = {}) {
  const schemaId = text(input.businessObject || input.schemaId)
  const config = BUSINESS_CONFIG[schemaId]
  if (!config) return { ok: false, status: 400, error: `Unsupported business object: ${schemaId}` }
  const rows = normalizeRows(input.rows)
  const duplicateRows = []
  const seen = new Set()
  rows.forEach((row, index) => {
    const key = keyFor(config, row)
    if (!key || seen.has(key)) duplicateRows.push(index + 2)
    if (key) seen.add(key)
  })
  const serverValidation = validateServerRows(config, rows, options.relationships || {})
  const errors = [...(Array.isArray(input.validationErrors) ? input.validationErrors : []), ...serverValidation.errors]
  const warnings = [...(Array.isArray(input.validationWarnings) ? input.validationWarnings : []), ...serverValidation.warnings]
  const previewId = `PRV-${randomUUID().slice(0, 12)}`
  const snapshotHash = hash({ schemaId, rows, fieldMapping: input.fieldMapping || {}, schemaVersion: input.schemaVersion || '1' })
  const createdAt = new Date()
  const preview = {
    previewId, schemaId, businessObject: config.businessObject, normalizedRows: rows,
    fieldMapping: clone(input.fieldMapping || {}), schemaVersion: text(input.schemaVersion) || '1',
    fileMetadata: clone(input.fileMetadata || {}), sheetName: text(input.sheetName),
    validationErrors: clone(errors), validationWarnings: clone(warnings), duplicateRows,
    snapshotHash, createdAt: createdAt.toISOString(), expiresAt: new Date(createdAt.getTime() + 30 * 60_000).toISOString(),
    actor: text(options.actor) || '当前用户', relationships: clone(options.relationships || {}),
  }
  state.previews.set(previewId, preview)
  const errorRowSet = new Set(errors.map((item) => Number(item.rowNumber)).filter(Number.isFinite))
  duplicateRows.forEach((rowNumber) => errorRowSet.add(rowNumber))
  const warningRowCount = new Set(warnings.map((item) => Number(item.rowNumber)).filter(Number.isFinite)).size
  return {
    ok: errors.length === 0 && duplicateRows.length === 0,
    previewId, normalizedRows: clone(rows),
    validationSummary: { totalRows: rows.length, validRows: Math.max(0, rows.length - errorRowSet.size), warningRows: warningRowCount, errorRows: errorRowSet.size, duplicateRows: duplicateRows.length },
    validRows: Math.max(0, rows.length - errorRowSet.size), warningRows: warningRowCount,
    errorRows: errorRowSet.size, duplicateRows, relationshipWarnings: clone(warnings), snapshotHash,
    expiresAt: preview.expiresAt, writesFiles: false, writesDb: false,
  }
}

export function commitImportPreview(previewId, input = {}, options = {}) {
  const preview = state.previews.get(previewId)
  if (!preview) return { ok: false, status: 404, error: 'Import preview not found or expired.' }
  if (new Date(preview.expiresAt).getTime() < Date.now()) return { ok: false, status: 410, error: 'Import preview has expired.' }
  if (text(input.snapshotHash) !== preview.snapshotHash) return { ok: false, status: 409, error: 'Snapshot hash mismatch.' }
  if (input.userConfirmation !== true) return { ok: false, status: 422, error: 'Explicit user confirmation is required.' }
  if (preview.validationErrors.length || preview.duplicateRows.length) return { ok: false, status: 422, error: 'Preview contains blocking rows.' }
  const revalidated = validateServerRows(BUSINESS_CONFIG[preview.schemaId], preview.normalizedRows, preview.relationships)
  if (revalidated.errors.length) return { ok: false, status: 422, error: 'Server revalidation failed.', validationErrors: revalidated.errors }
  if (preview.validationWarnings.length && (!Array.isArray(input.acceptedWarningCodes) || input.acceptedWarningCodes.length === 0)) return { ok: false, status: 422, error: 'Preview warnings require explicit acknowledgement.' }
  const idempotencyKey = text(input.idempotencyKey)
  if (!idempotencyKey) return { ok: false, status: 422, error: 'idempotencyKey is required.' }
  if (state.idempotency.has(idempotencyKey)) return { ...clone(state.idempotency.get(idempotencyKey)), replayed: true }

  const config = BUSINESS_CONFIG[preview.schemaId]
  const target = collection(config.collection)
  const baseline = Array.isArray(options.baselineRecords) ? options.baselineRecords : []
  const existingKeys = new Set([...baseline, ...target].map((row) => keyFor(config, row)).filter(Boolean))
  const changes = []
  let inserted = 0; let updated = 0; let skipped = 0
  const importBatchId = `IMP-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${randomUUID().slice(0, 8)}`

  for (const sourceRow of preview.normalizedRows) {
    const row = materializeBusinessRow(preview.schemaId, sourceRow, preview.actor)
    const businessKey = keyFor(config, row)
    const index = target.findIndex((item) => keyFor(config, item) === businessKey)
    if (config.policy === 'reject_duplicates' && existingKeys.has(businessKey)) { skipped += 1; continue }
    if (config.policy === 'inventory_adjustment') {
      const prior = index >= 0 ? target[index] : null
      const previousQuantity = Number(prior?.quantity || 0)
      const importedQuantity = Number(row.quantity || 0)
      const next = { ...row, importBatchId, updatedAt: new Date().toISOString() }
      if (index >= 0) target[index] = next; else target.push(next)
      const movement = {
        movementId: `IMV-${randomUUID().slice(0, 10)}`, movementType: prior ? 'inventory_adjustment' : 'opening_balance',
        warehouse: row.warehouse, bin: row.bin, sku: row.sku, previousQuantity, importedQuantity,
        difference: importedQuantity - previousQuantity, reason: prior ? 'Excel 库存余额调整' : 'Excel 期初库存',
        importBatchId, operator: preview.actor, timestamp: new Date().toISOString(),
      }
      state.inventoryMovements.unshift(movement)
      changes.push({ kind: index >= 0 ? 'update' : 'insert', collection: config.collection, key: businessKey, before: clone(prior), after: clone(next), movementId: movement.movementId })
      if (index >= 0) updated += 1; else inserted += 1
      existingKeys.add(businessKey)
      continue
    }
    if (index >= 0 && config.policy === 'upsert') {
      const before = clone(target[index]); const next = { ...target[index], ...row, importBatchId, updatedAt: new Date().toISOString() }
      target[index] = next; changes.push({ kind: 'update', collection: config.collection, key: businessKey, before, after: clone(next) }); updated += 1
    } else if (config.policy === 'upsert' && existingKeys.has(businessKey)) {
      const before = baseline.find((item) => keyFor(config, item) === businessKey) || null
      const next = { ...(before || {}), ...row, importBatchId, updatedAt: new Date().toISOString() }
      target.push(next); changes.push({ kind: 'insert', collection: config.collection, key: businessKey, before: clone(before), after: clone(next), shadowsBaseline: true }); updated += 1
    } else if (existingKeys.has(businessKey)) {
      skipped += 1
    } else {
      const next = { ...row, importBatchId, importedAt: new Date().toISOString() }
      target.push(next); changes.push({ kind: 'insert', collection: config.collection, key: businessKey, before: null, after: clone(next) }); inserted += 1; existingKeys.add(businessKey)
    }
  }

  const batch = {
    importBatchId, previewId, businessObject: config.businessObject, schemaId: preview.schemaId,
    originalFileName: preview.fileMetadata.name || '', sheetName: preview.sheetName, schemaVersion: preview.schemaVersion,
    fieldMapping: clone(preview.fieldMapping), inserted, updated, skipped, failed: 0,
    warnings: clone(preview.validationWarnings), acceptedWarningCodes: clone(input.acceptedWarningCodes || []),
    snapshotHash: preview.snapshotHash, status: 'committed', rollbackAvailable: true,
    committedAt: new Date().toISOString(), rollbackDeadline: new Date(Date.now() + 24 * 60 * 60_000).toISOString(),
    actor: text(options.actor) || preview.actor, changes,
  }
  state.batches.set(importBatchId, batch)
  const auditEvent = audit('import_batch_committed', { type: 'importBatch', id: importBatchId }, batch, batch.actor)
  const result = { ok: true, importBatchId, businessObject: config.businessObject, inserted, updated, skipped, failed: 0, warnings: batch.warnings, auditEventId: auditEvent.id, rollbackAvailable: true, committedAt: batch.committedAt }
  state.idempotency.set(idempotencyKey, result)
  return clone(result)
}

export function validateDurableImportCommit(previewId, input = {}, options = {}) {
  const preview = state.previews.get(previewId)
  if (!preview) return { ok: false, status: 404, code: 'IMPORT_PREVIEW_NOT_FOUND', error: 'Import preview not found or expired.' }
  if (new Date(preview.expiresAt).getTime() < Date.now()) return { ok: false, status: 410, code: 'IMPORT_PREVIEW_EXPIRED', error: 'Import preview has expired.' }
  if (text(input.snapshotHash) !== preview.snapshotHash) return { ok: false, status: 409, code: 'IMPORT_SNAPSHOT_MISMATCH', error: 'Snapshot hash mismatch.' }
  if (input.userConfirmation !== true) return { ok: false, status: 422, code: 'IMPORT_CONFIRMATION_REQUIRED', error: 'Explicit user confirmation is required.' }
  if (preview.validationErrors.length || preview.duplicateRows.length) return { ok: false, status: 422, code: 'IMPORT_PREVIEW_BLOCKED', error: 'Preview contains blocking rows.' }
  const relationships = options.relationships || preview.relationships
  const revalidated = validateServerRows(BUSINESS_CONFIG[preview.schemaId], preview.normalizedRows, relationships)
  if (revalidated.errors.length) return { ok: false, status: 422, code: 'IMPORT_REVALIDATION_FAILED', error: 'Server revalidation failed.', validationErrors: revalidated.errors }
  if (preview.validationWarnings.length && (!Array.isArray(input.acceptedWarningCodes) || input.acceptedWarningCodes.length === 0)) return { ok: false, status: 422, code: 'IMPORT_WARNING_ACK_REQUIRED', error: 'Preview warnings require explicit acknowledgement.' }
  const idempotencyKey = text(input.idempotencyKey)
  if (!idempotencyKey) return { ok: false, status: 422, code: 'IDEMPOTENCY_KEY_REQUIRED', error: 'idempotencyKey is required.' }
  if (state.idempotency.has(idempotencyKey)) return { ok: true, replayed: true, result: clone(state.idempotency.get(idempotencyKey)) }
  return { ok: true, preview: clone(preview), config: BUSINESS_CONFIG[preview.schemaId], idempotencyKey }
}

export function recordDurableImportCommit(validation, changes = [], options = {}) {
  const preview = validation.preview
  const importBatchId = text(options.importBatchId) || `IMP-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${randomUUID().slice(0, 8)}`
  const inserted = changes.filter(change => change.operation === 'insert').length
  const updated = changes.filter(change => change.operation === 'update').length
  const batch = {
    importBatchId, previewId: preview.previewId, businessObject: preview.businessObject, schemaId: preview.schemaId,
    originalFileName: preview.fileMetadata.name || '', sheetName: preview.sheetName, schemaVersion: preview.schemaVersion,
    fieldMapping: clone(preview.fieldMapping), inserted, updated, skipped: 0, failed: 0,
    warnings: clone(preview.validationWarnings), snapshotHash: preview.snapshotHash, status: 'committed',
    atomic: true, rollbackAvailable: false, committedAt: new Date().toISOString(), actor: text(options.actor) || preview.actor,
    persistenceScope: 'process-memory-metadata', limitations: [...DURABLE_IMPORT_LIMITATIONS],
    targetRepositories: [...new Set(changes.map(change => change.repository))], changes: clone(changes),
  }
  state.batches.set(importBatchId, batch)
  const auditEvent = audit('import_batch_committed', { type: 'importBatch', id: importBatchId }, batch, batch.actor)
  batch.auditEventId = auditEvent.id
  const result = { ok: true, atomic: true, importBatchId, businessObject: preview.businessObject, inserted, updated, skipped: 0, failed: 0, warnings: batch.warnings, auditEventId: auditEvent.id, rollbackAvailable: false, committedAt: batch.committedAt, targetRepositories: batch.targetRepositories }
  state.idempotency.set(validation.idempotencyKey, result)
  return clone(result)
}

export function rollbackImportBatch(importBatchId, input = {}, options = {}) {
  const batch = state.batches.get(importBatchId)
  if (!batch) return { ok: false, status: 404, error: 'Import batch not found.' }
  if (!['admin', 'manager'].includes(text(options.role).toLowerCase())) return { ok: false, status: 403, error: 'Admin or manager permission is required.' }
  if (batch.persistenceScope === 'process-memory-metadata') return {
    ok: false,
    status: 409,
    code: 'DURABLE_IMPORT_ROLLBACK_NOT_SUPPORTED',
    message: '该导入批次已经写入正式业务数据，当前版本不支持自动回滚。请通过对应业务模块创建反向调整或人工修正。',
    rollbackAvailable: false,
  }
  if (batch.status !== 'committed') return { ok: false, status: 409, error: `Batch status ${batch.status} cannot be rolled back.` }
  if (new Date(batch.rollbackDeadline).getTime() < Date.now()) return { ok: false, status: 409, error: 'Rollback window has expired.' }
  if (input.hasDownstreamReferences === true) return { ok: false, status: 409, error: 'Batch has downstream business references.', dependencyReasons: ['存在后续业务引用'] }

  for (const change of [...batch.changes].reverse()) {
    const target = collection(change.collection)
    const config = BUSINESS_CONFIG[batch.schemaId]
    const index = target.findIndex((item) => keyFor(config, item) === change.key)
    if (change.kind === 'insert' && index >= 0) target.splice(index, 1)
    if (change.kind === 'update' && index >= 0) target[index] = clone(change.before)
    if (change.movementId) {
      const original = state.inventoryMovements.find((item) => item.movementId === change.movementId)
      if (original) state.inventoryMovements.unshift({ ...original, movementId: `IMV-RB-${randomUUID().slice(0, 8)}`, movementType: 'rollback_adjustment', previousQuantity: original.importedQuantity, importedQuantity: original.previousQuantity, difference: -original.difference, reason: `回滚 ${importBatchId}`, timestamp: new Date().toISOString() })
    }
  }
  batch.status = 'rolled_back'; batch.rollbackAvailable = false; batch.rolledBackAt = new Date().toISOString(); batch.rollbackReason = text(input.reason) || '用户确认回滚'
  const auditEvent = audit('import_batch_rolled_back', { type: 'importBatch', id: importBatchId }, { importBatchId, reason: batch.rollbackReason, changes: batch.changes.length }, text(options.actor) || '当前用户')
  return { ok: true, importBatchId, status: batch.status, rolledBackAt: batch.rolledBackAt, auditEventId: auditEvent.id, reversedChanges: batch.changes.length }
}

export function listImportBatches() { return clone([...state.batches.values()].sort((a, b) => b.committedAt.localeCompare(a.committedAt))) }
export function getImportBatch(id) { return clone(state.batches.get(id) || null) }
export function listImportedRecords(collectionName) { return clone(collection(collectionName)) }
export function listImportAuditEvents() { return clone(state.auditEvents) }
export function listImportedInventoryMovements() { return clone(state.inventoryMovements) }
export function importedDataOverlay() {
  return Object.fromEntries([...state.records.entries()].map(([key, value]) => [key, clone(value)]))
}

export const importBusinessConfigs = BUSINESS_CONFIG
