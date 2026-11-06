import { createHash } from 'node:crypto'
import { USER_DATA_ARRAY_KEYS, normalizeUserDataImportPayload } from '../domain/user-data-contract.mjs'

const ENABLE_USER_IMPORT_COMMIT_FLAG = 'FLOWCHAIN_ENABLE_USER_IMPORT_COMMIT'

function invalidJsonPayload() {
  return {
    ok: false,
    errors: [{ code: 'invalid_json', message: 'Request body must be valid JSON.', path: 'body', severity: 'error' }],
    warnings: [],
    recordCounts: {},
    writesFiles: false,
    writesDb: false,
    overwritesDemoData: false,
  }
}

function compactPreviewPayload(result) {
  return {
    ok: result.ok,
    dryRun: true,
    recordCounts: result.recordCounts,
    warnings: result.warnings,
    errors: result.errors,
    metadata: result.metadata,
    normalizedSnapshot: {
      version: result.normalizedSnapshot.version,
      previewId: result.normalizedSnapshot.previewId,
      datasetId: result.normalizedSnapshot.datasetId,
      scope: result.normalizedSnapshot.scope,
      normalizedSnapshotHash: result.normalizedSnapshot.normalizedSnapshotHash,
      validationSummary: result.normalizedSnapshot.validationSummary,
      source: result.normalizedSnapshot.source,
      recordCounts: result.normalizedSnapshot.recordCounts,
    },
    auditPreview: {
      action: 'user_import_previewed',
      module: 'user-data',
      entity: { type: 'userDataPreview', id: result.normalizedSnapshot.previewId },
      metadata: {
        scope: result.normalizedSnapshot.scope,
        recordCounts: result.recordCounts,
        validationSummary: result.normalizedSnapshot.validationSummary,
      },
    },
    normalizedPreviewCounts: result.recordCounts,
    importPreview: result.importPreview,
    writesFiles: false,
    writesDb: false,
    overwritesDemoData: false,
  }
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]))
}

function stableStringify(value) {
  return JSON.stringify(stableValue(value))
}

function snapshotHash(snapshot = {}) {
  const body = {
    version: snapshot.version,
    scope: snapshot.scope,
    datasetId: snapshot.datasetId,
    recordCounts: snapshot.recordCounts,
    normalizedRecords: snapshot.normalizedRecords,
  }
  return createHash('sha256').update(stableStringify(body)).digest('hex')
}

function scopeFromCommitBody(body = {}) {
  return body.scope || body.normalizedSnapshot?.scope || {
    tenantId: text(body.tenantId),
    userId: text(body.userId),
  }
}

async function resolveCommitSnapshot(body = {}, repositories = {}) {
  const previewId = text(body.previewId || body.normalizedSnapshot?.previewId)
  const scope = scopeFromCommitBody(body)
  if (previewId && repositories.userDataRuntime?.getPreviewSnapshot) {
    const preview = await repositories.userDataRuntime.getPreviewSnapshot({ scope, previewId })
    if (preview?.normalizedSnapshot) return preview.normalizedSnapshot
  }
  return body.normalizedSnapshot || null
}

function commitFeatureEnabled() {
  return process.env[ENABLE_USER_IMPORT_COMMIT_FLAG] === 'true'
}

function text(value = '') {
  return String(value ?? '').trim()
}

function idOf(recordType, row = {}) {
  if (recordType === 'purchaseOrders') return text(row.po || row.poId || row.id)
  if (recordType === 'purchaseRequests') return text(row.pr || row.prId || row.id)
  if (recordType === 'rfqs') return text(row.id || row.rfqId)
  if (recordType === 'products') return text(row.sku || row.itemSku || row.id)
  if (recordType === 'suppliers') return text(row.id || row.supplierId || row.name)
  if (recordType === 'receivingDocs') return text(row.grn || row.grnId || row.id)
  if (recordType === 'supplierInvoices') return text(row.invoiceNumber || row.invoiceId || row.id)
  if (recordType === 'inventoryMovements') return text(row.movementId || row.id || row.sourceDocument)
  if (recordType === 'inventoryExceptions') return text(row.id || row.exceptionId || row.sku)
  return text(row.id)
}

function addCommitIssue(issues, code, message, path) {
  issues.push({ code, message, path, severity: 'error' })
}

function validateCommitSnapshot(snapshot = {}) {
  const issues = []
  const records = snapshot.normalizedRecords || {}
  const unknownTypes = Object.keys(records).filter((key) => !USER_DATA_ARRAY_KEYS.includes(key))
  unknownTypes.forEach((key) => addCommitIssue(issues, 'unsupported_record_type', `Unsupported record type ${key}.`, `normalizedSnapshot.normalizedRecords.${key}`))

  for (const recordType of USER_DATA_ARRAY_KEYS) {
    const rows = Array.isArray(records[recordType]) ? records[recordType] : []
    const seen = new Set()
    rows.forEach((row, index) => {
      const id = idOf(recordType, row)
      if (!id) addCommitIssue(issues, 'missing_required_item_id', `${recordType} record is missing required identifier.`, `${recordType}[${index}]`)
      if (id && seen.has(id)) addCommitIssue(issues, 'duplicate_record_id', `${recordType} contains duplicate record id ${id}.`, `${recordType}[${index}]`)
      if (id) seen.add(id)
      if (recordType === 'products' && !text(row.sku || row.itemSku)) addCommitIssue(issues, 'missing_required_item_id', 'Product is missing SKU.', `${recordType}[${index}].sku`)
      if (recordType === 'purchaseRequests' && !text(row.sourceSku || row.sku || row.itemSku)) addCommitIssue(issues, 'missing_required_item_id', 'Purchase request is missing SKU.', `${recordType}[${index}].sourceSku`)
      if (recordType === 'purchaseOrders') {
        if (!text(row.supplier || row.supplierName)) addCommitIssue(issues, 'missing_supplier_reference', 'Purchase order is missing supplier reference.', `${recordType}[${index}].supplier`)
        ;(Array.isArray(row.lines) ? row.lines : []).forEach((line, lineIndex) => {
          if (!text(line.sku || line.itemSku)) addCommitIssue(issues, 'invalid_po_line_item_reference', 'PO line is missing item reference.', `${recordType}[${index}].lines[${lineIndex}].sku`)
          if (line.quantity !== undefined && typeof line.quantity !== 'number') addCommitIssue(issues, 'invalid_quantity', 'PO line quantity must be numeric.', `${recordType}[${index}].lines[${lineIndex}].quantity`)
        })
      }
    })
  }

  return issues
}

async function recordAuditBestEffort(repositories = {}, entry = {}) {
  try {
    if (repositories.auditLog?.recordAuditEntry) return await repositories.auditLog.recordAuditEntry(entry)
  } catch {}
  return null
}

function commitDisabledPayload(result, db) {
  return {
    ...blockedCommitPayload(result, db),
    featureFlag: ENABLE_USER_IMPORT_COMMIT_FLAG,
    commitFeatureEnabled: false,
  }
}

function inactiveRejectedPayload(errors = []) {
  return {
    ok: false,
    deactivated: false,
    errors,
    writesFiles: false,
    writesDb: false,
    overwritesDemoData: false,
  }
}

function compactActiveDatasetPayload(scope = {}, dataset = null) {
  const normalizedScope = {
    tenantId: text(scope.tenantId) || 'tenant-flowchain-sme',
    userId: text(scope.userId) || 'user-local',
  }
  return {
    ok: true,
    active: Boolean(dataset?.active),
    scope: normalizedScope,
    dataset: dataset
      ? {
          active: Boolean(dataset.active),
          datasetId: dataset.datasetId,
          importBatchId: dataset.importBatchId,
          recordCounts: dataset.recordCounts || {},
          validationSummary: dataset.validationSummary || {},
          snapshotHash: dataset.snapshotHash || null,
          createdAt: dataset.createdAt || null,
        }
      : null,
    message: dataset ? 'Active user dataset found.' : 'No active user dataset',
    writesFiles: false,
    writesDb: false,
    overwritesDemoData: false,
  }
}

function compactRecords(result, limit = 5) {
  const data = result.normalizedData || {}
  return {
    purchaseOrders: (data.purchaseOrders || []).slice(0, limit).map((row) => ({
      po: row.po,
      supplier: row.supplier,
      status: row.status,
      eta: row.eta,
      amount: row.amount,
    })),
    products: (data.products || []).slice(0, limit).map((row) => ({
      sku: row.sku,
      name: row.name,
      currentStock: row.currentStock,
      safetyStock: row.safetyStock,
      reorderPoint: row.reorderPoint,
      riskLevel: row.riskLevel,
    })),
    suppliers: (data.suppliers || []).slice(0, limit).map((row) => ({
      id: row.id,
      name: row.name,
      risk: row.risk,
      riskStatus: row.riskStatus,
    })),
    rfqs: (data.rfqs || []).slice(0, limit).map((row) => ({
      id: row.id,
      sourceRequest: row.sourceRequest,
      suppliers: row.suppliers,
      quoted: row.quoted,
      status: row.status,
    })),
    receivingDocs: (data.receivingDocs || []).slice(0, limit).map((row) => ({
      grn: row.grn,
      po: row.po,
      supplier: row.supplier,
      status: row.status,
      items: row.items,
    })),
  }
}

function blockedCommitPayload(result, db) {
  const dataMode = db?.__dataMode || 'demo'
  return {
    ok: false,
    commitAccepted: false,
    dryRunRequired: true,
    storageReady: false,
    dataMode,
    recordCounts: result.recordCounts,
    warnings: result.warnings,
    errors: result.ok
      ? [{ code: 'user_import_commit_disabled', message: 'User data import commit is disabled until scoped durable user storage is available.', path: 'commit', severity: 'error' }]
      : result.errors,
    metadata: result.metadata,
    normalizedPreviewCounts: result.recordCounts,
    importPreview: result.importPreview,
    writesFiles: false,
    writesDb: false,
    overwritesDemoData: false,
  }
}

// These 500s guard an invariant rather than catch an error; the report
// carries the guard's code so the alert says which one tripped.
function boundaryViolation(code) {
  return Object.assign(new Error('User data route mutated runtime data.'), { name: 'BoundaryViolation', code })
}

export async function handleUserDataRoute(ctx) {
  const { req, res, url, send, readBody, db, repositories = {} } = ctx

  if (req.method === 'GET' && url.pathname === '/api/user-data/active-dataset') {
    const scope = {
      tenantId: text(url.searchParams.get('tenantId')),
      userId: text(url.searchParams.get('userId')),
    }
    const dataset = await repositories.userDataRuntime?.getActiveDataset?.(scope)
    send(res, 200, compactActiveDatasetPayload(scope, dataset))
    return true
  }

  if (req.method === 'POST' && url.pathname === '/api/user-data/import/deactivate') {
    let body
    try {
      body = await readBody(req)
    } catch {
      send(res, 400, invalidJsonPayload())
      return true
    }

    const errors = []
    const scope = {
      tenantId: text(body?.scope?.tenantId || body?.tenantId),
      userId: text(body?.scope?.userId || body?.userId),
    }
    const importBatchId = text(body?.importBatchId)
    if (!commitFeatureEnabled()) addCommitIssue(errors, 'user_import_deactivate_disabled', `Deactivate requires ${ENABLE_USER_IMPORT_COMMIT_FLAG}=true.`, ENABLE_USER_IMPORT_COMMIT_FLAG)
    if (!scope.tenantId || !scope.userId) addCommitIssue(errors, 'missing_scope', 'Deactivate requires tenantId and userId scope.', 'scope')
    if (!importBatchId) addCommitIssue(errors, 'missing_import_batch_id', 'Deactivate requires importBatchId.', 'importBatchId')
    if (body?.confirmDeactivate !== true) addCommitIssue(errors, 'missing_confirmation', 'Deactivate requires confirmDeactivate=true.', 'confirmDeactivate')
    if (errors.length) {
      send(res, 422, inactiveRejectedPayload(errors))
      return true
    }

    const before = JSON.stringify(db)
    const deactivated = await repositories.userDataRuntime?.markImportBatchInactive?.(scope, importBatchId)
    if (JSON.stringify(db) !== before) {
      ctx.reportError?.(boundaryViolation('deactivate_boundary_mutation_detected'))
      send(res, 500, inactiveRejectedPayload([{ code: 'deactivate_boundary_mutation_detected', message: 'Deactivate mutated runtime business data.', path: 'db', severity: 'error' }]))
      return true
    }
    if (!deactivated) {
      await recordAuditBestEffort(repositories, {
        source: 'system',
        module: 'user-data',
        action: 'user_import_deactivate_rejected',
        entity: { type: 'userDataImportBatch', id: importBatchId },
        summary: 'User data import deactivate rejected by scoped lookup.',
        tenantId: scope.tenantId,
        metadata: { scope, importBatchId, featureFlag: ENABLE_USER_IMPORT_COMMIT_FLAG },
      })
      send(res, 404, inactiveRejectedPayload([{ code: 'import_batch_not_found', message: 'No active import batch was found for this tenant/user scope.', path: 'importBatchId', severity: 'error' }]))
      return true
    }

    const auditEvent = await recordAuditBestEffort(repositories, {
      source: 'system',
      module: 'user-data',
      action: 'user_import_deactivated',
      entity: { type: 'userDataImportBatch', id: importBatchId },
      summary: 'User imported dataset marked inactive.',
      tenantId: scope.tenantId,
      metadata: {
        scope,
        importBatchId,
        datasetId: deactivated.datasetId,
        recordCounts: deactivated.recordCounts,
        featureFlag: ENABLE_USER_IMPORT_COMMIT_FLAG,
      },
    })
    send(res, 200, {
      ok: true,
      deactivated: true,
      status: 'inactive',
      datasetId: deactivated.datasetId,
      importBatchId,
      affectedRecordCounts: deactivated.recordCounts,
      auditEventId: auditEvent?.id || null,
      writesFiles: false,
      writesDb: true,
      overwritesDemoData: false,
    })
    return true
  }

  if (req.method === 'POST' && url.pathname === '/api/user-data/import/commit') {
    let body
    try {
      body = await readBody(req)
    } catch {
      send(res, 400, invalidJsonPayload())
      return true
    }

    const before = JSON.stringify(db)
    const snapshot = await resolveCommitSnapshot(body, repositories)
    const result = snapshot
      ? {
          ok: snapshot.validationSummary?.ok !== false,
          recordCounts: snapshot.recordCounts || {},
          warnings: [],
          errors: [],
          metadata: {
            sourceName: snapshot.source?.sourceName || 'user-import',
            previewId: snapshot.previewId,
            datasetId: snapshot.datasetId,
            normalizedSnapshotHash: snapshot.normalizedSnapshotHash,
            scope: snapshot.scope,
          },
          normalizedSnapshot: snapshot,
          importPreview: {},
        }
      : normalizeUserDataImportPayload(body, { importedAt: new Date().toISOString() })
    if (JSON.stringify(db) !== before) {
      ctx.reportError?.(boundaryViolation('commit_boundary_mutation_detected'))
      send(res, 500, {
        ok: false,
        errors: [{ code: 'commit_boundary_mutation_detected', message: 'Import commit boundary attempted to mutate runtime data.', path: 'db', severity: 'error' }],
        warnings: [],
        recordCounts: {},
        writesFiles: false,
        writesDb: false,
        overwritesDemoData: false,
      })
      return true
    }

    if (!commitFeatureEnabled()) {
      send(res, result.ok ? 501 : 422, commitDisabledPayload(result, db))
      return true
    }

    const errors = []
    if (!snapshot) addCommitIssue(errors, 'missing_preview_snapshot', 'Commit requires previewId and a stored normalized preview snapshot.', 'previewId')
    if (body?.confirmCommit !== true) addCommitIssue(errors, 'missing_confirmation', 'Commit requires confirmCommit=true after user review.', 'confirmCommit')
    const providedHash = text(body?.normalizedSnapshotHash || snapshot?.normalizedSnapshotHash)
    const computedHash = snapshot ? snapshotHash(snapshot) : ''
    if (snapshot && (!providedHash || providedHash !== computedHash)) addCommitIssue(errors, 'snapshot_hash_mismatch', 'Normalized snapshot hash does not match preview snapshot.', 'normalizedSnapshotHash')
    if (snapshot?.validationSummary?.ok === false) addCommitIssue(errors, 'validation_failed', 'Commit rejected because preview validation failed.', 'normalizedSnapshot.validationSummary')
    if (snapshot?.validationSummary?.warningCount > 0 && body?.acceptWarnings !== true) addCommitIssue(errors, 'warnings_require_acknowledgement', 'Commit with warnings requires acceptWarnings=true.', 'acceptWarnings')
    if (snapshot) errors.push(...validateCommitSnapshot(snapshot))

    if (errors.length) {
      await recordAuditBestEffort(repositories, {
        source: 'system',
        module: 'user-data',
        action: 'user_import_commit_rejected',
        entity: { type: 'userDataPreview', id: snapshot?.previewId || 'missing-preview' },
        summary: 'User data import commit rejected by validation boundary.',
        tenantId: snapshot?.scope?.tenantId,
        metadata: {
          scope: snapshot?.scope || null,
          previewId: snapshot?.previewId || null,
          datasetId: snapshot?.datasetId || null,
          recordCounts: snapshot?.recordCounts || {},
          validationSummary: snapshot?.validationSummary || {},
          featureFlag: ENABLE_USER_IMPORT_COMMIT_FLAG,
          commitFeatureEnabled: true,
          errors,
        },
      })
      send(res, 422, {
        ok: false,
        commitAccepted: false,
        errors,
        warnings: [],
        recordCounts: snapshot?.recordCounts || {},
        writesFiles: false,
        writesDb: false,
        overwritesDemoData: false,
      })
      return true
    }

    const repository = repositories.userDataRuntime
    const importBatch = await repository.createImportBatch({
      scope: snapshot.scope,
      datasetId: snapshot.datasetId,
      snapshotHash: snapshot.normalizedSnapshotHash,
      recordCounts: snapshot.recordCounts,
      validationSummary: snapshot.validationSummary,
      status: 'committed',
    })
    const persisted = await repository.persistNormalizedRecords({
      scope: snapshot.scope,
      datasetId: importBatch.datasetId,
      importBatchId: importBatch.importBatchId,
      normalizedSnapshot: snapshot,
      snapshotHash: snapshot.normalizedSnapshotHash,
      validationSummary: snapshot.validationSummary,
    })
    const auditEvent = await recordAuditBestEffort(repositories, {
      source: 'system',
      module: 'user-data',
      action: 'user_import_committed',
      entity: { type: 'userDataImportBatch', id: importBatch.importBatchId },
      summary: 'User data import committed into scoped runtime repository.',
      tenantId: snapshot.scope.tenantId,
      metadata: {
        scope: snapshot.scope,
        importBatchId: importBatch.importBatchId,
        datasetId: importBatch.datasetId,
        recordCounts: snapshot.recordCounts,
        validationSummary: snapshot.validationSummary,
        featureFlag: ENABLE_USER_IMPORT_COMMIT_FLAG,
        commitFeatureEnabled: true,
      },
    })

    send(res, 201, {
      ok: true,
      commitAccepted: true,
      importBatchId: importBatch.importBatchId,
      datasetId: importBatch.datasetId,
      recordCounts: persisted.recordCounts,
      validationSummary: snapshot.validationSummary,
      auditEventId: auditEvent?.id || null,
      writesFiles: false,
      writesDb: true,
      overwritesDemoData: false,
    })
    return true
  }

  if (req.method === 'POST' && (url.pathname === '/api/user-data/import/dry-run' || url.pathname === '/api/user-data/import/preview')) {
    let body
    try {
      body = await readBody(req)
    } catch {
      send(res, 400, invalidJsonPayload())
      return true
    }

    const before = JSON.stringify(db)
    const result = normalizeUserDataImportPayload(body, { importedAt: new Date().toISOString() })
    if (JSON.stringify(db) !== before) {
      ctx.reportError?.(boundaryViolation('dry_run_mutation_detected'))
      send(res, 500, {
        ok: false,
        errors: [{ code: 'dry_run_mutation_detected', message: 'Import dry-run attempted to mutate runtime data.', path: 'db', severity: 'error' }],
        warnings: [],
        recordCounts: {},
      })
      return true
    }

    const payload = compactPreviewPayload(result)
    await repositories.userDataRuntime?.savePreviewSnapshot?.({
      scope: result.normalizedSnapshot.scope,
      previewId: result.normalizedSnapshot.previewId,
      datasetId: result.normalizedSnapshot.datasetId,
      normalizedSnapshotHash: result.normalizedSnapshot.normalizedSnapshotHash,
      normalizedSnapshot: result.normalizedSnapshot,
      recordCounts: result.recordCounts,
      validationSummary: result.normalizedSnapshot.validationSummary,
    })
    if (url.pathname.endsWith('/preview')) {
      payload.normalizedRecords = compactRecords(result, 5)
      payload.previewLimit = 5
    }
    send(res, result.ok ? 200 : 422, payload)
    return true
  }

  return false
}
