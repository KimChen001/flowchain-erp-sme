// Archived Phase 5.3 pilot prototype. Test-only: production routes must never import this module.
import { createHash, randomUUID } from 'node:crypto'
import { PilotIdentityError, assertWarehouseAccess, resolveProvisionedActor } from '../pilot-identity.mjs'
import { assertAuthorized } from '../../auth/authorization-service.mjs'
import { receivingDecimalString, receivingDecimalUnits, receivingLocationKey } from '../receiving-transaction-policy.mjs'

const TYPES = new Set(['items', 'suppliers', 'warehouses', 'locations', 'open_purchase_orders', 'opening_inventory_balances'])
const OPEN_PO_STATUSES = new Set(['approved', 'issued', 'ready_for_receiving', 'partially_received'])
const ACTIVE_STATUSES = new Set(['active', 'inactive'])
const text = value => String(value ?? '').trim()
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const fail = (code, message, status = 400, details) => { throw new PilotIdentityError(code, message, status, details) }
const issue = (rowNumber, field, code, message, rawValue) => ({ id: randomUUID(), rowNumber, field, code, message, rawValue: rawValue == null ? null : text(rawValue).slice(0, 500) })
const decimal = (value, rowNumber, field, issues, { positive = false } = {}) => {
  try { const units = receivingDecimalUnits(value); if ((positive && units <= 0n) || (!positive && units < 0n)) throw new Error(positive ? 'must be greater than zero' : 'cannot be negative'); return receivingDecimalString(units) }
  catch (error) { issues.push(issue(rowNumber, field, 'INVALID_QUANTITY', `${field} ${error.message}`, value)); return null }
}

function mappedRows(rows, mapping = {}) {
  return rows.map(row => Object.keys(mapping).length ? Object.fromEntries(Object.entries(mapping).map(([field, source]) => [field, row?.[source]])) : { ...(row || {}) })
}

export function createPilotImportService({ prisma, now = () => new Date(), idFactory = randomUUID } = {}) {
  if (!prisma) throw new Error('Prisma client is required for Pilot imports.')

  async function preview(input, identity) {
    const actor = await resolveProvisionedActor(prisma, identity)
    const importType = text(input.importType)
    if (!TYPES.has(importType)) fail('IMPORT_TYPE_UNSUPPORTED', 'Pilot import type is not supported.')
    assertAuthorized({ actor, permission: 'settings.import.manage', tenantId: actor.tenantId })
    if (importType === 'warehouses') assertAuthorized({ actor, permission: 'settings.warehouse_import.manage', tenantId: actor.tenantId })
    const fileName = text(input.fileName)
    if (!/\.(csv|xlsx)$/i.test(fileName)) fail('IMPORT_FILE_TYPE_UNSUPPORTED', 'Only CSV and XLSX files are supported.')
    if (Number(input.fileSize || 0) > 10 * 1024 * 1024) fail('IMPORT_FILE_TOO_LARGE', 'Pilot import files are limited to 10 MB.', 413)
    if (!Array.isArray(input.rows) || input.rows.length === 0 || input.rows.length > 5000) fail('IMPORT_ROW_LIMIT', 'Pilot imports require 1 to 5000 rows.')
    const rows = mappedRows(input.rows, input.mapping || {})
    const issues = []; const normalized = []; const duplicateKeys = new Set(); const seen = new Set()
    const [items, suppliers, warehouses, paymentTerms, tenant, locations, purchaseOrders] = await Promise.all([
      prisma.item.findMany({ where: { tenantId: actor.tenantId }, select: { id: true, sku: true } }),
      prisma.supplier.findMany({ where: { tenantId: actor.tenantId }, select: { id: true, code: true } }),
      prisma.warehouse.findMany({ where: { tenantId: actor.tenantId }, select: { id: true, code: true, status: true } }),
      prisma.paymentTerm.findMany({ where: { tenantId: actor.tenantId }, select: { code: true } }),
      prisma.tenant.findUnique({ where: { id: actor.tenantId } }),
      prisma.warehouseLocation.findMany({ where: { tenantId: actor.tenantId }, select: { warehouseId: true, locationKey: true } }),
      prisma.purchaseOrder.findMany({ where: { tenantId: actor.tenantId }, select: { id: true } }),
    ])
    const itemBySku = new Map(items.map(row => [row.sku, row])); const supplierByCode = new Map(suppliers.map(row => [row.code, row])); const warehouseByCode = new Map(warehouses.map(row => [row.code, row])); const paymentCodes = new Set(paymentTerms.map(row => row.code)); const locationKeys = new Set(locations.map(row => `${row.warehouseId}|${row.locationKey}`)); const poIds = new Set(purchaseOrders.map(row => row.id))
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index]; const rowNumber = index + 2; const before = issues.length; let key = ''
      if (importType === 'items') {
        const sku = text(row.sku); const name = text(row.name); const unit = text(row.unit); const status = text(row.status || 'active').toLowerCase(); key = sku
        if (!sku) issues.push(issue(rowNumber, 'sku', 'REQUIRED', 'SKU is required.')); if (!name) issues.push(issue(rowNumber, 'name', 'REQUIRED', 'Name is required.')); if (!unit) issues.push(issue(rowNumber, 'unit', 'REQUIRED', 'Unit is required.')); if (!ACTIVE_STATUSES.has(status)) issues.push(issue(rowNumber, 'status', 'INVALID_STATUS', 'Item status must be active or inactive.', row.status)); if (itemBySku.has(sku)) issues.push(issue(rowNumber, 'sku', 'DUPLICATE_SKU', 'SKU already exists in this workspace.', sku)); if (row.preferredSupplierCode && !supplierByCode.has(text(row.preferredSupplierCode))) issues.push(issue(rowNumber, 'preferredSupplierCode', 'UNKNOWN_SUPPLIER', 'Preferred supplier does not exist; it will not be auto-created.', row.preferredSupplierCode))
        if (issues.length === before) normalized.push({ rowNumber, sku, name, unit, status, preferredSupplierId: supplierByCode.get(text(row.preferredSupplierCode))?.id || null })
      } else if (importType === 'suppliers') {
        const code = text(row.code); const name = text(row.name); const currency = text(row.currency || tenant.currency).toUpperCase(); const status = text(row.status || 'active').toLowerCase(); key = code || name.toLowerCase()
        if (!code && !name) issues.push(issue(rowNumber, 'code', 'REQUIRED', 'Supplier code or stable name is required.')); if (!name) issues.push(issue(rowNumber, 'name', 'REQUIRED', 'Supplier name is required.')); if (!/^[A-Z]{3}$/.test(currency)) issues.push(issue(rowNumber, 'currency', 'INVALID_CURRENCY', 'Currency must be a three-letter code.', row.currency)); if (!ACTIVE_STATUSES.has(status)) issues.push(issue(rowNumber, 'status', 'INVALID_STATUS', 'Supplier status must be active or inactive.', row.status)); if (code && supplierByCode.has(code)) issues.push(issue(rowNumber, 'code', 'DUPLICATE_SUPPLIER', 'Supplier code already exists.', code)); if (row.paymentTermCode && !paymentCodes.has(text(row.paymentTermCode))) issues.push(issue(rowNumber, 'paymentTermCode', 'UNKNOWN_PAYMENT_TERM', 'Payment term does not exist.', row.paymentTermCode))
        if (issues.length === before) normalized.push({ rowNumber, code: code || null, name, status, currency, paymentTermCode: text(row.paymentTermCode) || null })
      } else if (importType === 'warehouses') {
        const code = text(row.code); const name = text(row.name); const status = text(row.status || 'active').toLowerCase(); key = code
        if (!code) issues.push(issue(rowNumber, 'code', 'REQUIRED', 'Warehouse code is required.')); if (!name) issues.push(issue(rowNumber, 'name', 'REQUIRED', 'Warehouse name is required.')); if (!ACTIVE_STATUSES.has(status)) issues.push(issue(rowNumber, 'status', 'INVALID_STATUS', 'Warehouse status must be active or inactive.', row.status)); if (warehouseByCode.has(code)) issues.push(issue(rowNumber, 'code', 'DUPLICATE_WAREHOUSE', 'Warehouse code already exists.', code)); if (issues.length === before) normalized.push({ rowNumber, code, name, status })
      } else if (importType === 'locations') {
        const warehouseCode = text(row.warehouseCode); const code = text(row.code); const locationKey = receivingLocationKey(code); const warehouse = warehouseByCode.get(warehouseCode); const status = text(row.status || 'active').toLowerCase(); key = `${warehouseCode}|${locationKey}`
        if (!warehouse) issues.push(issue(rowNumber, 'warehouseCode', 'UNKNOWN_WAREHOUSE', 'Warehouse must exist in this workspace.', warehouseCode)); if (!code) issues.push(issue(rowNumber, 'code', 'REQUIRED', 'Location code is required.')); if (!ACTIVE_STATUSES.has(status)) issues.push(issue(rowNumber, 'status', 'INVALID_STATUS', 'Location status must be active or inactive.', row.status)); if (warehouse && locationKeys.has(`${warehouse.id}|${locationKey}`)) issues.push(issue(rowNumber, 'code', 'DUPLICATE_LOCATION', 'Warehouse location already exists.', code)); if (warehouse && !actor.allWarehouses && !actor.readWarehouseIds.has(warehouse.id)) issues.push(issue(rowNumber, 'warehouseCode', 'WAREHOUSE_SCOPE_DENIED', 'User cannot access this warehouse.', warehouseCode)); if (issues.length === before) normalized.push({ rowNumber, warehouseId: warehouse.id, code, locationKey, name: text(row.name) || null, status })
      } else if (importType === 'open_purchase_orders') {
        const poNumber = text(row.poNumber); const supplierCode = text(row.supplierCode); const sku = text(row.sku); const status = text(row.status || 'issued').toLowerCase(); key = `${poNumber}|${sku}|${index}`; const orderedQuantity = decimal(row.orderedQuantity, rowNumber, 'orderedQuantity', issues, { positive: true }); const receivedQuantity = decimal(row.receivedQuantity || 0, rowNumber, 'receivedQuantity', issues)
        if (!poNumber) issues.push(issue(rowNumber, 'poNumber', 'REQUIRED', 'PO number is required.')); if (poIds.has(poNumber)) issues.push(issue(rowNumber, 'poNumber', 'DUPLICATE_PURCHASE_ORDER', 'Purchase order already exists.', poNumber)); if (!supplierByCode.has(supplierCode)) issues.push(issue(rowNumber, 'supplierCode', 'UNKNOWN_SUPPLIER', 'Supplier must exist.', supplierCode)); if (!itemBySku.has(sku)) issues.push(issue(rowNumber, 'sku', 'UNKNOWN_SKU', 'Item/SKU must exist.', sku)); if (!OPEN_PO_STATUSES.has(status)) issues.push(issue(rowNumber, 'status', 'INVALID_OPEN_PO_STATUS', 'PO status is not a supported open status.', status)); if (orderedQuantity && receivedQuantity && receivingDecimalUnits(receivedQuantity) > receivingDecimalUnits(orderedQuantity)) issues.push(issue(rowNumber, 'receivedQuantity', 'RECEIVED_EXCEEDS_ORDERED', 'Received quantity cannot exceed ordered quantity.', row.receivedQuantity)); if (issues.length === before) normalized.push({ rowNumber, poNumber, supplierId: supplierByCode.get(supplierCode).id, supplierCode, itemId: itemBySku.get(sku).id, sku, orderedQuantity, receivedQuantity, unit: text(row.unit), currency: text(row.currency || tenant.currency).toUpperCase(), status, expectedDate: text(row.expectedDate) || null })
      } else {
        const sku = text(row.sku); const warehouseCode = text(row.warehouseCode); const warehouse = warehouseByCode.get(warehouseCode); const location = text(row.location); const locationKey = receivingLocationKey(location); const quantity = decimal(row.quantity, rowNumber, 'quantity', issues); key = `${sku}|${warehouseCode}|${locationKey}`
        if (tenant.openingBalanceLockedAt) issues.push(issue(rowNumber, 'importType', 'OPENING_BALANCE_LOCKED', 'Opening balances are locked for this workspace.')); if (!itemBySku.has(sku)) issues.push(issue(rowNumber, 'sku', 'UNKNOWN_SKU', 'Item/SKU must exist.', sku)); if (!warehouse || warehouse.status !== 'active') issues.push(issue(rowNumber, 'warehouseCode', 'UNKNOWN_WAREHOUSE', 'Active warehouse must exist.', warehouseCode)); if (warehouse) { try { assertWarehouseAccess(actor, [warehouse.id], 'operate') } catch { issues.push(issue(rowNumber, 'warehouseCode', 'WAREHOUSE_SCOPE_DENIED', 'Operate access is required.', warehouseCode)) } }
        if (issues.length === before) normalized.push({ rowNumber, itemId: itemBySku.get(sku).id, sku, warehouseId: warehouse.id, warehouseCode, location, locationKey, quantity, unit: text(row.unit) || null })
      }
      if (key) { if (seen.has(key)) duplicateKeys.add(key); seen.add(key) }
    }
    for (const duplicate of duplicateKeys) issues.push(issue(0, null, 'DUPLICATE_IN_FILE', `Duplicate natural key in file: ${duplicate}`))
    const validRows = duplicateKeys.size ? 0 : normalized.length; const status = issues.length ? 'blocked' : 'ready'; const batchId = `pilot-${idFactory()}`; const fileHash = hash({ importType, rows, mapping: input.mapping || {} })
    await prisma.importBatch.create({ data: { id: batchId, tenantId: actor.tenantId, importType, fileName, fileHash, status, totalRows: rows.length, validRows, invalidRows: rows.length - validRows, createdById: actor.user.id, mapping: input.mapping || {}, summary: { fileSize: Number(input.fileSize || 0), fileType: fileName.split('.').pop().toLowerCase(), dryRun: true }, normalizedRows: issues.length ? [] : normalized, issues: { create: issues.map(item => ({ ...item, tenantId: actor.tenantId })) } } })
    return { id: batchId, importType, status, totalRows: rows.length, validRows, invalidRows: rows.length - validRows, issues: issues.length, fileHash, writesBusinessObjects: false, limits: { maxFileBytes: 10 * 1024 * 1024, maxRows: 5000, formats: ['csv', 'xlsx'] } }
  }

  async function getBatch(id, identity) { const actor = await resolveProvisionedActor(prisma, identity); const batch = await prisma.importBatch.findFirst({ where: { id, tenantId: actor.tenantId } }); if (!batch) fail('IMPORT_BATCH_NOT_FOUND', 'Import batch was not found.', 404); return { ...batch, normalizedRows: undefined } }
  async function getIssues(id, identity) { const actor = await resolveProvisionedActor(prisma, identity); await getBatch(id, identity); return { issues: await prisma.importIssue.findMany({ where: { tenantId: actor.tenantId, importBatchId: id }, orderBy: [{ rowNumber: 'asc' }, { field: 'asc' }] }) } }

  async function commitOpeningBalanceCommand(tx, actor, batch, rows) {
    const tenant = await tx.tenant.findUnique({ where: { id: actor.tenantId } }); if (tenant.openingBalanceLockedAt) fail('OPENING_BALANCE_LOCKED', 'Opening balances are locked for this workspace.', 409)
    for (const row of rows) {
      assertWarehouseAccess(actor, [row.warehouseId], 'operate')
      const existingMovement = await tx.inventoryMovement.findFirst({ where: { tenantId: actor.tenantId, sku: row.sku, warehouseId: row.warehouseId, locationKey: row.locationKey } })
      if (existingMovement) fail('OPENING_BALANCE_NOT_EMPTY', `Inventory history already exists for ${row.sku}.`, 409)
      await tx.inventoryMovement.create({ data: { id: idFactory(), tenantId: actor.tenantId, itemId: row.itemId, sku: row.sku, warehouseId: row.warehouseId, location: row.location || null, locationKey: row.locationKey, movementType: 'opening_balance', movementLabel: 'Pilot opening balance', sourceDocument: batch.id, sourceDocumentType: 'import_batch', sourceDocumentId: batch.id, sourceDocumentLineId: `${batch.id}:${row.rowNumber}`, quantityIn: row.quantity, quantityOut: '0', adjustmentQty: '0', status: 'posted', actorId: actor.user.id, owner: actor.user.id, unit: row.unit, occurredAt: now(), movementDate: now(), inventoryImpact: 'opening_balance_v1', evidence: { importBatchId: batch.id, rowNumber: row.rowNumber } } })
      await tx.inventoryBalance.upsert({ where: { tenantId_sku_warehouseKey_locationKey: { tenantId: actor.tenantId, sku: row.sku, warehouseKey: row.warehouseId, locationKey: row.locationKey } }, create: { id: idFactory(), tenantId: actor.tenantId, itemId: row.itemId, sku: row.sku, warehouseId: row.warehouseId, warehouseKey: row.warehouseId, location: row.location || null, locationKey: row.locationKey, onHandQuantity: row.quantity, availableQuantity: row.quantity, reservedQuantity: '0', unit: row.unit, status: 'available', version: 1 }, update: { onHandQuantity: { increment: row.quantity }, availableQuantity: { increment: row.quantity }, version: { increment: 1 } } })
    }
    await tx.tenant.update({ where: { id: actor.tenantId }, data: { openingBalanceLockedAt: now(), version: { increment: 1 } } })
  }

  async function commit(id, input, identity) {
    const actor = await resolveProvisionedActor(prisma, identity); assertAuthorized({ actor, permission: 'settings.import.manage', tenantId: actor.tenantId })
    const idempotencyKey = text(input.idempotencyKey); if (!idempotencyKey) fail('IDEMPOTENCY_KEY_REQUIRED', 'Commit requires idempotencyKey.', 422)
    const initial = await prisma.importBatch.findFirst({ where: { id, tenantId: actor.tenantId } }); if (!initial) fail('IMPORT_BATCH_NOT_FOUND', 'Import batch was not found.', 404)
    const replay = await prisma.importBatch.findFirst({ where: { tenantId: actor.tenantId, importType: initial.importType, idempotencyKey } })
    if (replay) { if (replay.id !== id) fail('IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD', 'Idempotency key was used by another import.', 409); return { id: replay.id, status: replay.status, committedRows: replay.committedRows, idempotentReplay: true } }
    try { return await prisma.$transaction(async tx => {
      await tx.$queryRawUnsafe('SELECT "id" FROM "ImportBatch" WHERE "tenantId" = $1 AND "id" = $2 FOR UPDATE', actor.tenantId, id)
      const batch = await tx.importBatch.findFirst({ where: { id, tenantId: actor.tenantId } }); if (batch.status !== 'ready') fail('IMPORT_BATCH_NOT_READY', 'Only a successful Dry Run can be committed.', 409)
      const rows = Array.isArray(batch.normalizedRows) ? batch.normalizedRows : []
      await tx.importBatch.update({ where: { id }, data: { status: 'committing', idempotencyKey } })
      if (batch.importType === 'items') for (const row of rows) await tx.item.create({ data: { id: idFactory(), tenantId: actor.tenantId, sku: row.sku, name: row.name, unit: row.unit, status: row.status, preferredSupplierId: row.preferredSupplierId } })
      if (batch.importType === 'suppliers') for (const row of rows) await tx.supplier.create({ data: { id: idFactory(), tenantId: actor.tenantId, code: row.code, name: row.name, status: row.status, metadata: { currency: row.currency, paymentTermCode: row.paymentTermCode } } })
      if (batch.importType === 'warehouses') for (const row of rows) await tx.warehouse.create({ data: { id: idFactory(), tenantId: actor.tenantId, code: row.code, name: row.name, status: row.status } })
      if (batch.importType === 'locations') for (const row of rows) await tx.warehouseLocation.create({ data: { id: idFactory(), tenantId: actor.tenantId, warehouseId: row.warehouseId, code: row.code, locationKey: row.locationKey, name: row.name, status: row.status } })
      if (batch.importType === 'open_purchase_orders') {
        const groups = new Map(); for (const row of rows) groups.set(row.poNumber, [...(groups.get(row.poNumber) || []), row])
        for (const [poNumber, lines] of groups) await tx.purchaseOrder.create({ data: { id: poNumber, tenantId: actor.tenantId, status: lines[0].status, supplierId: lines[0].supplierId, expectedDate: lines[0].expectedDate ? new Date(lines[0].expectedDate) : null, currency: lines[0].currency, lines: { create: lines.map(row => ({ id: idFactory(), itemId: row.itemId, sku: row.sku, orderedQuantity: row.orderedQuantity, receivedQuantity: row.receivedQuantity, unit: row.unit })) } } })
      }
      if (batch.importType === 'opening_inventory_balances') await commitOpeningBalanceCommand(tx, actor, batch, rows)
      const committedAt = now(); await tx.auditLog.create({ data: { id: idFactory(), tenantId: actor.tenantId, actorId: actor.user.id, source: 'pilot_import_service', module: 'imports', action: 'import_batch_committed', entityType: 'ImportBatch', entityId: batch.id, summary: `${batch.importType} import committed (${rows.length} rows).`, metadata: { importType: batch.importType, fileHash: batch.fileHash, committedRows: rows.length, idempotencyKey } } })
      await tx.importBatch.update({ where: { id }, data: { status: 'completed', committedRows: rows.length, committedAt, summary: { ...(batch.summary || {}), atomic: true, auditRecorded: true } } })
      return { id, status: 'completed', committedRows: rows.length, committedAt, idempotentReplay: false }
    }, { isolationLevel: 'Serializable' }) } catch (error) {
      if (error instanceof PilotIdentityError) throw error
      await prisma.importBatch.updateMany({ where: { id, tenantId: actor.tenantId, status: { not: 'completed' } }, data: { status: 'failed', summary: { commitErrorCode: 'IMPORT_COMMIT_FAILED', atomic: true, committedRows: 0 } } })
      if (error?.code === 'P2002') fail('IMPORT_COMMIT_CONFLICT', 'Business data changed after Dry Run; run preview again.', 409)
      fail('IMPORT_COMMIT_FAILED', 'Import commit failed atomically.', 409)
    }
  }

  async function cancel(id, identity) { const actor = await resolveProvisionedActor(prisma, identity); const result = await prisma.importBatch.updateMany({ where: { id, tenantId: actor.tenantId, status: { in: ['uploaded', 'validated', 'blocked', 'ready'] } }, data: { status: 'cancelled' } }); if (result.count !== 1) fail('IMPORT_BATCH_NOT_CANCELLABLE', 'Import batch cannot be cancelled.', 409); return { id, status: 'cancelled' } }
  return { preview, getBatch, getIssues, commit, cancel }
}
