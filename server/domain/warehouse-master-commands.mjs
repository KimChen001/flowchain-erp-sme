import { randomUUID } from 'node:crypto'
import { RECEIVABLE_PURCHASE_ORDER_INPUTS } from './procurement-status-authority.mjs'
import { receivingLocationKey } from './receiving-transaction-policy.mjs'

// Writes for warehouses and their bins, in the shape of the other master-data
// commands (master-data-commands.mjs): tenant-scoped, one serializable
// transaction, field-level validation and one audit row per write.
//
//   Warehouse  the Warehouse table; the version lives in metadata.version
//              because the table has no version column. The code is unique in
//              the workspace and cannot change once the warehouse exists,
//              because stock, documents and access refer to the warehouse.
//   Bin        a WarehouseLocation row. Stock rows name their location as
//              free text plus locationKey = receivingLocationKey(text), so a
//              bin's locationKey is built the same way from its code. The
//              table has no version column either: an edit sends the
//              updatedAt it read.
//
// Nothing here is deleted: a warehouse or bin is set inactive, and only when
// no stock, reservation or open document still depends on it.

export const WAREHOUSE_CODE_PATTERN = /^[A-Z0-9][A-Z0-9_-]{0,31}$/
export const WAREHOUSE_NAME_MAX = 120
export const BIN_CODE_MAX = 64
export const BIN_NAME_MAX = 120
const STATUSES = ['active', 'inactive']

const fail = (status, code, message, details = []) => Object.assign(new Error(message), { status, code, details })
const text = (value) => String(value ?? '').trim()
const has = (input, key) => Object.hasOwn(input || {}, key)
const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
const meta = (record) => (isObject(record?.metadata) ? record.metadata : {})

function requireScope(actorId, scope) {
  if (!scope?.tenantId || !actorId) throw fail(403, 'TENANT_REQUIRED', 'An authenticated workspace is required.')
}

function validationError(issues) {
  if (issues.length) throw fail(422, 'VALIDATION_ERROR', 'Check the highlighted fields.', issues)
}

async function writeAudit(tx, { scope, actorId, action, entityType, entityId, summary, metadata }) {
  await tx.auditLog.create({ data: { id: randomUUID(), tenantId: scope.tenantId, source: 'master-data', module: 'master-data', action, entityType, entityId, actorId, summary, metadata } })
}

async function runSerializable(prisma, work, duplicate) {
  try {
    return await prisma.$transaction(work, { isolationLevel: 'Serializable' })
  } catch (error) {
    if (error.code === 'P2002') throw duplicate
    if (error.code === 'P2034') throw fail(409, 'VERSION_CONFLICT', 'This record changed. Reopen it and try again.')
    throw error
  }
}

export function warehouseVersion(record) {
  return Number(meta(record).version || 1)
}

function statusOf(input) {
  const status = text(input?.status).toLowerCase()
  if (!STATUSES.includes(status)) throw fail(422, 'VALIDATION_ERROR', 'Check the highlighted fields.', [{ field: 'status', code: 'STATUS_INVALID', message: 'Choose active or inactive.' }])
  return status
}

// ---------------------------------------------------------------- warehouses

// Creates (id null) or renames one warehouse. A new warehouse gives its
// creator operate access in the same transaction, so the administrator who
// made it can use and maintain it; everyone else gets access in Warehouse
// access, as before.
export async function saveWarehouse(prisma, id, input = {}, actorId, scope) {
  requireScope(actorId, scope)
  return runSerializable(prisma, async (tx) => {
    const old = id ? await tx.warehouse.findFirst({ where: { tenantId: scope.tenantId, id: text(id) } }) : null
    if (id && !old) throw fail(404, 'NOT_FOUND', 'Warehouse not found.')
    const currentVersion = warehouseVersion(old)
    if (old && Number(input.expectedVersion) !== currentVersion) throw fail(409, 'VERSION_CONFLICT', 'This warehouse changed. Reopen it and try again.')
    const issues = []
    const issue = (field, code, message) => issues.push({ field, code, message })
    const code = old ? old.code : text(input.code).toUpperCase()
    if (old && has(input, 'code') && text(input.code) && text(input.code).toUpperCase() !== old.code) issue('code', 'CODE_IMMUTABLE', 'The warehouse code cannot be changed once the warehouse exists.')
    else if (!code) issue('code', 'CODE_REQUIRED', 'Enter a warehouse code.')
    else if (!old && !WAREHOUSE_CODE_PATTERN.test(code)) issue('code', 'CODE_INVALID', 'A warehouse code has up to 32 letters, digits, hyphens or underscores and starts with a letter or digit.')
    const name = old && !has(input, 'name') ? old.name : text(input.name)
    if (!name) issue('name', 'NAME_REQUIRED', 'Enter a warehouse name.')
    else if (name.length > WAREHOUSE_NAME_MAX) issue('name', 'NAME_TOO_LONG', `A warehouse name has at most ${WAREHOUSE_NAME_MAX} characters.`)
    validationError(issues)

    const version = old ? currentVersion + 1 : 1
    const metadata = { ...meta(old), version, updatedBy: actorId, ...(old ? {} : { createdBy: actorId }) }
    let saved
    if (old) {
      saved = await tx.warehouse.update({ where: { id: old.id }, data: { name, metadata } })
    } else {
      saved = await tx.warehouse.create({ data: { id: `WH-${randomUUID()}`, tenantId: scope.tenantId, code, name, status: 'active', metadata } })
      await tx.userWarehouseScope.create({ data: { id: randomUUID(), tenantId: scope.tenantId, userId: actorId, warehouseId: saved.id, accessLevel: 'operate' } })
    }
    await writeAudit(tx, { scope, actorId, action: old ? 'update' : 'create', entityType: 'warehouse', entityId: saved.id, summary: old ? `Warehouse ${code} updated` : `Warehouse ${code} created`, metadata: { version, code, ...(old && old.name !== name ? { before: { name: old.name }, after: { name } } : {}) } })
    return saved
  }, fail(409, 'DUPLICATE_CODE', 'This warehouse code is already in use.', [{ field: 'code', code: 'DUPLICATE_CODE', message: 'This warehouse code is already in use.' }]))
}

// What still depends on a warehouse, counted from the recorded rows. Each
// reason with a count above zero blocks setting it inactive.
// Posting a transfer, adjustment or return does not check the warehouse's
// status again, so an unposted one would put stock into an inactive warehouse.
export async function warehouseUsage(tx, tenantId, warehouseId) {
  const unposted = { postingStatus: 'unposted', workflowStatus: { not: 'cancelled' } }
  const [onHand, quarantine, reservations, counts, receiving, transfers, adjustments, returns, purchaseOrders] = await Promise.all([
    // Stock rows carry the warehouse id in warehouseKey (and usually warehouseId).
    tx.inventoryBalance.count({ where: { tenantId, OR: [{ warehouseId }, { warehouseKey: warehouseId }], onHandQuantity: { not: 0 } } }),
    tx.quarantineInventoryBalance.count({ where: { tenantId, warehouseId, onHandQuantity: { not: 0 } } }),
    // A reservation stays open until it is fully consumed or released.
    tx.inventoryReservation.count({ where: { tenantId, warehouseId, status: { notIn: ['consumed', 'released'] } } }),
    tx.cycleCountSession.count({ where: { tenantId, warehouseId, workflowStatus: { notIn: ['posted', 'cancelled'] } } }),
    tx.receivingDocument.count({ where: { tenantId, ...unposted, OR: [{ warehouseId }, { lines: { some: { warehouseId } } }] } }),
    // Either leg of a transfer: moving stock out of or into the warehouse.
    tx.stockTransferDocument.count({ where: { tenantId, ...unposted, lines: { some: { legs: { some: { warehouseId } } } } } }),
    tx.inventoryAdjustmentDocument.count({ where: { tenantId, ...unposted, lines: { some: { warehouseId } } } }),
    tx.returnPostingDocument.count({ where: { tenantId, ...unposted, warehouseId } }),
    // A purchase order still open for receiving whose goods are to arrive
    // here; receiving opens on its target warehouse.
    tx.purchaseOrder.count({ where: { tenantId, status: { in: [...RECEIVABLE_PURCHASE_ORDER_INPUTS] }, metadata: { path: ['targetWarehouseId'], equals: warehouseId } } }),
  ])
  return [
    { code: 'INVENTORY_ON_HAND', count: onHand },
    { code: 'QUARANTINE_ON_HAND', count: quarantine },
    { code: 'ACTIVE_RESERVATIONS', count: reservations },
    { code: 'OPEN_COUNTS', count: counts },
    { code: 'UNPOSTED_RECEIVING', count: receiving },
    { code: 'UNPOSTED_TRANSFERS', count: transfers },
    { code: 'UNPOSTED_ADJUSTMENTS', count: adjustments },
    { code: 'UNPOSTED_RETURNS', count: returns },
    { code: 'OPEN_PURCHASE_ORDERS', count: purchaseOrders },
  ].filter((reason) => reason.count > 0)
}

// Sets a warehouse active or inactive. Setting it inactive is refused while
// anything still depends on it or when it is the workspace's last active
// warehouse; otherwise it also clears it as anyone's default warehouse, so
// nobody's forms open on a warehouse they can no longer pick.
export async function setWarehouseStatus(prisma, id, input = {}, actorId, scope) {
  requireScope(actorId, scope)
  const status = statusOf(input)
  return runSerializable(prisma, async (tx) => {
    const old = await tx.warehouse.findFirst({ where: { tenantId: scope.tenantId, id: text(id) } })
    if (!old) throw fail(404, 'NOT_FOUND', 'Warehouse not found.')
    const currentVersion = warehouseVersion(old)
    if (Number(input.expectedVersion) !== currentVersion) throw fail(409, 'VERSION_CONFLICT', 'This warehouse changed. Reopen it and try again.')
    if (text(old.status || 'active') === status) return { warehouse: old, clearedDefaults: 0 }
    if (status === 'inactive') {
      const reasons = await warehouseUsage(tx, scope.tenantId, old.id)
      if (reasons.length) throw fail(409, 'WAREHOUSE_IN_USE', 'This warehouse still holds stock or open work. Clear it before setting it inactive.', reasons)
      const otherActive = await tx.warehouse.count({ where: { tenantId: scope.tenantId, status: 'active', id: { not: old.id } } })
      if (otherActive === 0) throw fail(409, 'LAST_ACTIVE_WAREHOUSE', 'This is the only active warehouse in the workspace. Add or activate another one first.')
    }
    const version = currentVersion + 1
    const saved = await tx.warehouse.update({ where: { id: old.id }, data: { status, metadata: { ...meta(old), version, updatedBy: actorId } } })
    let clearedDefaults = 0
    if (status === 'inactive') {
      const cleared = await tx.user.updateMany({ where: { tenantId: scope.tenantId, defaultWarehouseId: old.id }, data: { defaultWarehouseId: null, version: { increment: 1 } } })
      clearedDefaults = Number(cleared?.count || 0)
    }
    await writeAudit(tx, { scope, actorId, action: status === 'active' ? 'activate' : 'deactivate', entityType: 'warehouse', entityId: old.id, summary: `Warehouse ${old.code} set ${status}`, metadata: { version, code: old.code, before: { status: old.status }, after: { status }, clearedDefaults } })
    return { warehouse: saved, clearedDefaults }
  }, fail(409, 'VERSION_CONFLICT', 'This warehouse changed. Reopen it and try again.'))
}

// ---------------------------------------------------------------- bins

function sameInstant(expected, actual) {
  const left = new Date(expected ?? '').getTime()
  return Number.isFinite(left) && left === new Date(actual).getTime()
}

async function findWarehouse(tx, tenantId, warehouseId) {
  const warehouse = await tx.warehouse.findFirst({ where: { tenantId, id: text(warehouseId) } })
  if (!warehouse) throw fail(404, 'NOT_FOUND', 'Warehouse not found.')
  return warehouse
}

async function findBin(tx, tenantId, warehouse, binId) {
  const bin = await tx.warehouseLocation.findFirst({ where: { tenantId, warehouseId: warehouse.id, id: text(binId) } })
  if (!bin) throw fail(404, 'NOT_FOUND', 'Bin not found.')
  return bin
}

const warehouseInactive = () => fail(409, 'WAREHOUSE_INACTIVE', 'This warehouse is inactive. Set it active before changing its bins.')

// Creates (binId null) or renames one bin of a warehouse.
export async function saveWarehouseBin(prisma, warehouseId, binId, input = {}, actorId, scope) {
  requireScope(actorId, scope)
  return runSerializable(prisma, async (tx) => {
    const warehouse = await findWarehouse(tx, scope.tenantId, warehouseId)
    const old = binId ? await findBin(tx, scope.tenantId, warehouse, binId) : null
    if (old && !sameInstant(input.expectedUpdatedAt, old.updatedAt)) throw fail(409, 'VERSION_CONFLICT', 'This bin changed. Reopen it and try again.')
    if (!old && text(warehouse.status || 'active') !== 'active') throw warehouseInactive()
    const issues = []
    const issue = (field, code, message) => issues.push({ field, code, message })
    const code = old ? old.code : text(input.code)
    if (old && has(input, 'code') && text(input.code) && text(input.code) !== old.code) issue('code', 'CODE_IMMUTABLE', 'The bin code cannot be changed once the bin exists.')
    else if (!code) issue('code', 'CODE_REQUIRED', 'Enter a bin code.')
    else if (code.length > BIN_CODE_MAX) issue('code', 'CODE_TOO_LONG', `A bin code has at most ${BIN_CODE_MAX} characters.`)
    const name = old && !has(input, 'name') ? old.name : text(input.name) || null
    if (name && name.length > BIN_NAME_MAX) issue('name', 'NAME_TOO_LONG', `A bin name has at most ${BIN_NAME_MAX} characters.`)
    validationError(issues)

    const saved = old
      ? await tx.warehouseLocation.update({ where: { id: old.id }, data: { name } })
      : await tx.warehouseLocation.create({ data: { id: `BIN-${randomUUID()}`, tenantId: scope.tenantId, warehouseId: warehouse.id, code, locationKey: receivingLocationKey(code), name, status: 'active' } })
    await writeAudit(tx, { scope, actorId, action: old ? 'update' : 'create', entityType: 'warehouse_bin', entityId: saved.id, summary: old ? `Bin ${code} in warehouse ${warehouse.code} updated` : `Bin ${code} added to warehouse ${warehouse.code}`, metadata: { warehouseId: warehouse.id, code, ...(old && old.name !== name ? { before: { name: old.name }, after: { name } } : {}) } })
    return saved
  }, fail(409, 'DUPLICATE_BIN', 'This bin code is already in use in this warehouse.', [{ field: 'code', code: 'DUPLICATE_BIN', message: 'This bin code is already in use in this warehouse.' }]))
}

// What still sits in one bin: stock, quarantined stock and open reservations
// recorded against its location key.
export async function binUsage(tx, tenantId, warehouseId, locationKey) {
  const [onHand, quarantine, reservations] = await Promise.all([
    tx.inventoryBalance.count({ where: { tenantId, OR: [{ warehouseId }, { warehouseKey: warehouseId }], locationKey, onHandQuantity: { not: 0 } } }),
    tx.quarantineInventoryBalance.count({ where: { tenantId, warehouseId, locationKey, onHandQuantity: { not: 0 } } }),
    tx.inventoryReservation.count({ where: { tenantId, warehouseId, locationKey, status: { notIn: ['consumed', 'released'] } } }),
  ])
  return [
    { code: 'INVENTORY_ON_HAND', count: onHand },
    { code: 'QUARANTINE_ON_HAND', count: quarantine },
    { code: 'ACTIVE_RESERVATIONS', count: reservations },
  ].filter((reason) => reason.count > 0)
}

export async function setWarehouseBinStatus(prisma, warehouseId, binId, input = {}, actorId, scope) {
  requireScope(actorId, scope)
  const status = statusOf(input)
  return runSerializable(prisma, async (tx) => {
    const warehouse = await findWarehouse(tx, scope.tenantId, warehouseId)
    const old = await findBin(tx, scope.tenantId, warehouse, binId)
    if (!sameInstant(input.expectedUpdatedAt, old.updatedAt)) throw fail(409, 'VERSION_CONFLICT', 'This bin changed. Reopen it and try again.')
    if (text(old.status || 'active') === status) return old
    if (status === 'active' && text(warehouse.status || 'active') !== 'active') throw warehouseInactive()
    if (status === 'inactive') {
      const reasons = await binUsage(tx, scope.tenantId, warehouse.id, old.locationKey)
      if (reasons.length) throw fail(409, 'BIN_IN_USE', 'This bin still holds stock or open reservations. Clear it before setting it inactive.', reasons)
    }
    const saved = await tx.warehouseLocation.update({ where: { id: old.id }, data: { status } })
    await writeAudit(tx, { scope, actorId, action: status === 'active' ? 'activate' : 'deactivate', entityType: 'warehouse_bin', entityId: old.id, summary: `Bin ${old.code} in warehouse ${warehouse.code} set ${status}`, metadata: { warehouseId: warehouse.id, code: old.code, before: { status: old.status }, after: { status } } })
    return saved
  }, fail(409, 'VERSION_CONFLICT', 'This bin changed. Reopen it and try again.'))
}
