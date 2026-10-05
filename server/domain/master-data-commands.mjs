import { randomUUID } from 'node:crypto'

// Writes for the item, customer and item-supplier master data, in the shape
// of saveSupplierMaster: tenant-scoped, one serializable transaction,
// optimistic versions, field-level validation and one audit row per write.
//
//   Item           the Item table; the version lives in metadata.version.
//                  The SKU is unique in the workspace and cannot change once
//                  the item exists, because orders and stock refer to it.
//   Customer       a RuntimeRecord in master-data.customers keyed by code;
//                  the code cannot change once the customer exists.
//   Item supplier  a RuntimeRecord in master-data.item-suppliers keyed by
//                  item and supplier. The preferred supplier is also written
//                  to Item.preferredSupplierId, which purchasing reads.

export const CUSTOMER_NAMESPACE = 'master-data.customers'
export const ITEM_SUPPLIER_NAMESPACE = 'master-data.item-suppliers'

const fail = (status, code, message, details = []) => Object.assign(new Error(message), { status, code, details })
const text = (value) => String(value ?? '').trim()
const has = (input, key) => Object.hasOwn(input || {}, key)
const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
const meta = (record) => (isObject(record?.metadata) ? record.metadata : {})
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const STATUSES = ['active', 'inactive', 'draft']
const currencies = new Set(Intl.supportedValuesOf('currency'))

function requireScope(actorId, scope) {
  if (!scope?.tenantId || !actorId) throw fail(403, 'TENANT_REQUIRED', 'An authenticated workspace is required.')
}

function validationError(issues) {
  if (issues.length) throw fail(422, 'VALIDATION_ERROR', 'Check the highlighted fields.', issues)
}

// A quantity or amount field: empty means "not recorded", anything else must
// be a finite number in range.
function numberField(input, key, issues, { min = 0, integer = false, positive = false, label }) {
  if (!has(input, key)) return undefined
  const raw = input[key]
  if (raw === null || raw === undefined || raw === '') return null
  const value = Number(raw)
  if (!Number.isFinite(value) || value < min || (positive && value <= 0) || (integer && !Number.isInteger(value))) {
    const code = integer ? 'WHOLE_NUMBER_REQUIRED' : positive ? 'POSITIVE_NUMBER_REQUIRED' : 'NUMBER_INVALID'
    issues.push({ field: key, code, message: `${label} must be ${integer ? 'a whole number' : 'a number'}${positive ? ' greater than zero' : ', zero or greater'}.` })
    return undefined
  }
  return value
}

async function writeAudit(tx, { scope, actorId, module, action, entityType, entityId, summary, version }) {
  await tx.auditLog.create({ data: { id: randomUUID(), tenantId: scope.tenantId, source: 'master-data', module, action, entityType, entityId, actorId, summary, metadata: { version } } })
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

// ---------------------------------------------------------------- items

const ITEM_TEXT_FIELDS = ['shortName', 'itemType', 'brand', 'specification', 'purchaseUnit', 'taxCodeId', 'barcode', 'manufacturerPartNumber', 'comments']
const ITEM_FLAGS = ['purchasable', 'inventoryItem', 'batchManaged', 'serialManaged', 'shelfLifeManaged']

// The field checks of an item write that need no database, in the order the
// form shows them. old is the stored item when editing, otherwise null.
export function itemInputIssues(input = {}, old = null) {
  const issues = []
  const issue = (field, code, message) => issues.push({ field, code, message })
  const sku = old ? old.sku : text(input.sku)
  if (old && has(input, 'sku') && text(input.sku) && text(input.sku) !== old.sku) issue('sku', 'SKU_LOCKED', 'The SKU cannot be changed once the item exists.')
  if (!sku) issue('sku', 'SKU_REQUIRED', 'Enter a SKU.')
  else if (sku.length > 64 || /\s/.test(sku)) issue('sku', 'SKU_INVALID', 'A SKU has at most 64 characters and no spaces.')
  const name = has(input, 'itemName') || has(input, 'name') ? text(input.itemName ?? input.name) : text(old?.name)
  if (!name) issue('itemName', 'NAME_REQUIRED', 'Enter an item name.')
  else if (name.length > 200) issue('itemName', 'NAME_TOO_LONG', 'An item name has at most 200 characters.')
  const status = has(input, 'status') ? text(input.status) : text(old?.status) || 'active'
  if (!STATUSES.includes(status)) issue('status', 'STATUS_INVALID', 'Choose a valid status.')
  const unit = has(input, 'baseUnit') || has(input, 'unit') ? text(input.baseUnit ?? input.unit) : text(old?.unit) || 'pcs'
  if (!unit) issue('baseUnit', 'UNIT_REQUIRED', 'Enter a unit.')
  const category = has(input, 'category') ? text(input.category) || null : old?.category ?? null
  const safetyStock = numberField(input, 'safetyStock', issues, { label: 'Safety stock' })
  const reorderPoint = numberField(input, 'reorderPoint', issues, { label: 'Reorder point' })
  const minimumOrderQuantity = numberField(input, 'minimumOrderQuantity', issues, { positive: true, label: 'Minimum order quantity' })
  const leadTimeDays = numberField(input, 'purchaseLeadTimeDays', issues, { integer: true, label: 'Lead time' })
  return { issues, values: { sku, name, status, unit, category, safetyStock, reorderPoint, minimumOrderQuantity, leadTimeDays } }
}

export async function saveItemMaster(prisma, id, input = {}, actorId, scope) {
  requireScope(actorId, scope)
  return runSerializable(prisma, async (tx) => {
    const old = id ? await tx.item.findFirst({ where: { tenantId: scope.tenantId, OR: [{ id: text(id) }, { sku: text(id) }] } }) : null
    if (id && !old) throw fail(404, 'NOT_FOUND', 'Item not found.')
    const previous = meta(old)
    const currentVersion = Number(previous.version || 1)
    if (old && Number(input.expectedVersion) !== currentVersion) throw fail(409, 'VERSION_CONFLICT', 'This item changed. Reopen it and try again.')
    const { issues, values } = itemInputIssues(input, old)
    const { sku, name, status, unit, category, safetyStock, reorderPoint, minimumOrderQuantity: moq, leadTimeDays: leadTime } = values
    const issue = (field, code, message) => issues.push({ field, code, message })

    const next = { ...previous }
    for (const key of ITEM_TEXT_FIELDS) if (has(input, key)) next[key] = text(input[key])
    for (const key of ITEM_FLAGS) if (has(input, key)) next[key] = Boolean(input[key])
    if (moq !== undefined) { next.minimumOrderQuantity = moq; next.moq = moq }
    if (leadTime !== undefined) { next.purchaseLeadTimeDays = leadTime; next.leadTimeDays = leadTime }
    next.baseUom = unit

    let preferredSupplierId = old?.preferredSupplierId ?? null
    if (has(input, 'defaultSupplierId') || has(input, 'preferredSupplierId')) {
      const supplierId = text(input.defaultSupplierId ?? input.preferredSupplierId)
      if (!supplierId) preferredSupplierId = null
      else {
        const supplier = await tx.supplier.findFirst({ where: { tenantId: scope.tenantId, id: supplierId } })
        if (!supplier) issue('defaultSupplierId', 'SUPPLIER_NOT_FOUND', 'Choose a supplier of this workspace.')
        else if (text(supplier.status || 'active') !== 'active') issue('defaultSupplierId', 'SUPPLIER_INACTIVE', 'Choose an active supplier.')
        else preferredSupplierId = supplier.id
      }
    }
    if (has(input, 'defaultWarehouseId')) {
      const warehouseId = text(input.defaultWarehouseId)
      if (warehouseId && !(await tx.warehouse.findFirst({ where: { tenantId: scope.tenantId, id: warehouseId } }))) issue('defaultWarehouseId', 'WAREHOUSE_NOT_FOUND', 'Choose a warehouse of this workspace.')
      else next.defaultWarehouseId = warehouseId
    }
    validationError(issues)

    next.version = old ? currentVersion + 1 : 1
    next.updatedBy = actorId
    if (!old) next.createdBy = actorId
    const data = {
      name, status, unit, category, preferredSupplierId, metadata: next,
      ...(safetyStock !== undefined ? { safetyStock: safetyStock === null ? null : String(safetyStock) } : {}),
      ...(reorderPoint !== undefined ? { reorderPoint: reorderPoint === null ? null : String(reorderPoint) } : {}),
    }
    const saved = old
      ? await tx.item.update({ where: { id: old.id }, data })
      : await tx.item.create({ data: { ...data, id: `ITEM-${randomUUID()}`, tenantId: scope.tenantId, sku } })
    await writeAudit(tx, { scope, actorId, module: 'master-data', action: old ? 'update' : 'create', entityType: 'item', entityId: saved.id, summary: old ? `Item ${sku} updated` : `Item ${sku} created`, version: next.version })
    return saved
  }, fail(409, 'DUPLICATE_SKU', 'This SKU is already in use.', [{ field: 'sku', message: 'This SKU is already in use.' }]))
}

// ---------------------------------------------------------------- customers

const CUSTOMER_TEXT_FIELDS = ['contact', 'phone', 'email', 'address', 'paymentTerms', 'creditStatus']

async function findCustomerRecord(tx, tenantId, idOrCode) {
  const key = text(idOrCode)
  if (!key) return null
  const byCode = await tx.runtimeRecord.findFirst({ where: { tenantId, namespace: CUSTOMER_NAMESPACE, recordKey: key } })
  if (byCode) return byCode
  const rows = await tx.runtimeRecord.findMany({ where: { tenantId, namespace: CUSTOMER_NAMESPACE }, take: 2000 })
  return rows.find((row) => text(row.payload?.id) === key || row.id === key) || null
}

// The field checks of a customer write; customers need no lookups, so these
// are all of them. old is the stored RuntimeRecord when editing.
export function customerInputIssues(input = {}, old = null) {
  const previous = isObject(old?.payload) ? old.payload : {}
  const issues = []
  const issue = (field, code, message) => issues.push({ field, code, message })
  const code = old ? old.recordKey : text(input.code)
  if (old && has(input, 'code') && text(input.code) && text(input.code) !== old.recordKey) issue('code', 'CODE_LOCKED', 'The customer code cannot be changed once the customer exists.')
  if (!code) issue('code', 'CODE_REQUIRED', 'Enter a customer code.')
  else if (code.length > 64) issue('code', 'CODE_TOO_LONG', 'A customer code has at most 64 characters.')
  const name = has(input, 'name') ? text(input.name) : text(previous.name)
  if (!name) issue('name', 'NAME_REQUIRED', 'Enter a customer name.')
  const status = has(input, 'status') ? text(input.status) : text(previous.status) || 'active'
  if (!STATUSES.includes(status)) issue('status', 'STATUS_INVALID', 'Choose a valid status.')
  const textValues = {}
  for (const key of CUSTOMER_TEXT_FIELDS) if (has(input, key)) textValues[key] = text(input[key])
  const email = has(textValues, 'email') ? textValues.email : previous.email
  if (email && !EMAIL.test(email)) issue('email', 'EMAIL_INVALID', 'Enter a valid email address.')
  let currency
  if (has(input, 'currency')) {
    currency = text(input.currency).toUpperCase()
    // Only a recorded currency: an empty one stays empty, never guessed.
    if (currency && !currencies.has(currency)) issue('currency', 'CURRENCY_INVALID', 'Choose a valid currency.')
  }
  return { issues, values: { code, name, status, text: textValues, currency } }
}

export async function saveCustomerMaster(prisma, id, input = {}, actorId, scope) {
  requireScope(actorId, scope)
  return runSerializable(prisma, async (tx) => {
    const old = id ? await findCustomerRecord(tx, scope.tenantId, id) : null
    if (id && !old) throw fail(404, 'NOT_FOUND', 'Customer not found.')
    const previous = isObject(old?.payload) ? old.payload : {}
    const currentVersion = Number(previous.version || 1)
    if (old && Number(input.expectedVersion) !== currentVersion) throw fail(409, 'VERSION_CONFLICT', 'This customer changed. Reopen it and try again.')
    const { issues, values } = customerInputIssues(input, old)
    const { code, name, status } = values
    const next = { ...previous, ...values.text }
    if (values.currency !== undefined) next.currency = values.currency
    validationError(issues)
    next.id = previous.id || `CUST-${randomUUID()}`
    next.code = code
    next.name = name
    next.status = status
    next.version = old ? currentVersion + 1 : 1
    next.updatedBy = actorId
    const saved = old
      ? await tx.runtimeRecord.update({ where: { id: old.id }, data: { payload: next } })
      : await tx.runtimeRecord.create({ data: { id: randomUUID(), tenantId: scope.tenantId, namespace: CUSTOMER_NAMESPACE, recordKey: code, payload: next } })
    await writeAudit(tx, { scope, actorId, module: 'master-data', action: old ? 'update' : 'create', entityType: 'customer', entityId: next.id, summary: old ? `Customer ${code} updated` : `Customer ${code} created`, version: next.version })
    return saved
  }, fail(409, 'DUPLICATE_CODE', 'This customer code is already in use.', [{ field: 'code', message: 'This customer code is already in use.' }]))
}

// ---------------------------------------------------------------- item suppliers

export function mapItemSupplierRecord(record = {}, item = null) {
  const payload = isObject(record.payload) ? record.payload : {}
  return {
    relationshipId: record.id,
    itemId: text(payload.itemId),
    supplierId: text(payload.supplierId),
    supplierSku: text(payload.supplierSku),
    active: payload.active !== false,
    approved: payload.approved !== false,
    preferred: Boolean(payload.preferred),
    leadTimeDays: Number(payload.leadTimeDays || 0),
    minimumOrderQuantity: Number(payload.minimumOrderQuantity || 1),
    // Null when no price was recorded, never 0.
    referencePrice: payload.referencePrice === null || payload.referencePrice === undefined || payload.referencePrice === '' ? null : Number(payload.referencePrice),
    currency: text(payload.currency),
    version: Number(payload.version || 1),
    source: 'item_supplier_relationship',
    ...(item ? { item: { itemId: item.id, sku: item.sku, itemName: item.name, status: item.status } } : {}),
  }
}

// The record key is "<itemId>::<supplierId>", so one item's or one
// supplier's links are found in the database, however many the workspace
// holds; only the unfiltered list is capped.
export async function listItemSupplierRecords(prisma, tenantId, { itemId = '', supplierId = '' } = {}) {
  const recordKey = itemId && supplierId ? `${itemId}::${supplierId}` : itemId ? { startsWith: `${itemId}::` } : supplierId ? { endsWith: `::${supplierId}` } : undefined
  const rows = await prisma.runtimeRecord.findMany({
    where: { tenantId, namespace: ITEM_SUPPLIER_NAMESPACE, ...(recordKey ? { recordKey } : {}) },
    orderBy: [{ recordKey: 'asc' }],
    ...(recordKey ? {} : { take: 2000 }),
  })
  return rows.filter((row) => (!itemId || text(row.payload?.itemId) === itemId) && (!supplierId || text(row.payload?.supplierId) === supplierId))
}

// The field checks of an item-supplier write. The caller looks the supplier
// up in the workspace (null when it is not there); old is the stored
// relationship when editing.
export function itemSupplierInputIssues(input = {}, { old = null, supplier = null } = {}) {
  const issues = []
  const issue = (field, code, message) => issues.push({ field, code, message })
  if (!supplier) issue('supplierId', 'SUPPLIER_NOT_FOUND', 'Choose a supplier of this workspace.')
  else if (!old && text(supplier.status || 'active') !== 'active') issue('supplierId', 'SUPPLIER_INACTIVE', 'Choose an active supplier.')
  const leadTimeDays = numberField(input, 'leadTimeDays', issues, { integer: true, label: 'Lead time' })
  const minimumOrderQuantity = numberField(input, 'minimumOrderQuantity', issues, { positive: true, label: 'Minimum order quantity' })
  const price = numberField(input, 'referencePrice', issues, { label: 'Reference price' })
  // The form sends 0 for an empty price field: a zero reference price is
  // "not recorded", never a price of $0.
  const referencePrice = price === undefined ? undefined : price === 0 ? null : price
  let currency
  if (has(input, 'currency') || !old) {
    // An empty currency is the supplier's default currency, as on the form.
    currency = text(input.currency || meta(supplier).defaultCurrency).toUpperCase()
    if (currency && !currencies.has(currency)) issue('currency', 'CURRENCY_INVALID', 'Choose a valid currency.')
  }
  return { issues, values: { leadTimeDays, minimumOrderQuantity, referencePrice, currency } }
}

// Creates (relationshipId null) or updates one item-supplier relationship.
export async function saveItemSupplier(prisma, itemIdOrSku, relationshipId, input = {}, actorId, scope) {
  requireScope(actorId, scope)
  return runSerializable(prisma, async (tx) => {
    const item = await tx.item.findFirst({ where: { tenantId: scope.tenantId, OR: [{ id: text(itemIdOrSku) }, { sku: text(itemIdOrSku) }] } })
    if (!item) throw fail(404, 'NOT_FOUND', 'Item not found.')
    const old = relationshipId ? await tx.runtimeRecord.findFirst({ where: { tenantId: scope.tenantId, namespace: ITEM_SUPPLIER_NAMESPACE, id: text(relationshipId) } }) : null
    if (relationshipId && (!old || text(old.payload?.itemId) !== item.id)) throw fail(404, 'NOT_FOUND', 'Item supplier relationship not found.')
    const previous = isObject(old?.payload) ? old.payload : {}
    const currentVersion = Number(previous.version || 1)
    if (old && Number(input.expectedVersion) !== currentVersion) throw fail(409, 'VERSION_CONFLICT', 'This relationship changed. Reopen it and try again.')
    const supplierId = old ? text(previous.supplierId) : text(input.supplierId)
    const supplier = supplierId ? await tx.supplier.findFirst({ where: { tenantId: scope.tenantId, id: supplierId } }) : null
    const { issues, values } = itemSupplierInputIssues(input, { old, supplier })
    const next = { ...previous, itemId: item.id, supplierId }
    if (has(input, 'supplierSku')) next.supplierSku = text(input.supplierSku)
    for (const key of ['active', 'approved', 'preferred']) if (has(input, key)) next[key] = Boolean(input[key])
    if (!old) { next.active = next.active !== false; next.approved = next.approved !== false; next.preferred = Boolean(next.preferred) }
    if (values.leadTimeDays !== undefined) next.leadTimeDays = values.leadTimeDays ?? 0
    if (values.minimumOrderQuantity !== undefined) next.minimumOrderQuantity = values.minimumOrderQuantity ?? 1
    if (values.referencePrice !== undefined) next.referencePrice = values.referencePrice
    if (values.currency !== undefined) next.currency = values.currency
    // Only an active, approved source can be the preferred one.
    if (next.preferred && (!next.active || !next.approved)) next.preferred = false
    validationError(issues)
    next.version = old ? currentVersion + 1 : 1
    next.updatedBy = actorId
    const saved = old
      ? await tx.runtimeRecord.update({ where: { id: old.id }, data: { payload: next } })
      : await tx.runtimeRecord.create({ data: { id: `ISR-${randomUUID()}`, tenantId: scope.tenantId, namespace: ITEM_SUPPLIER_NAMESPACE, recordKey: `${item.id}::${supplierId}`, payload: next } })
    // One preferred supplier per item, mirrored on the item for purchasing.
    if (next.preferred) {
      const siblings = await listItemSupplierRecords(tx, scope.tenantId, { itemId: item.id })
      for (const row of siblings) if (row.id !== saved.id && row.payload?.preferred) await tx.runtimeRecord.update({ where: { id: row.id }, data: { payload: { ...row.payload, preferred: false, version: Number(row.payload.version || 1) + 1 } } })
      if (item.preferredSupplierId !== supplierId) await tx.item.update({ where: { id: item.id }, data: { preferredSupplierId: supplierId } })
    } else if (item.preferredSupplierId === supplierId) {
      await tx.item.update({ where: { id: item.id }, data: { preferredSupplierId: null } })
    }
    await writeAudit(tx, { scope, actorId, module: 'master-data', action: old ? 'update' : 'create', entityType: 'item_supplier', entityId: saved.id, summary: `${old ? 'Updated' : 'Added'} supplier ${supplierId} for item ${item.sku}`, version: next.version })
    return mapItemSupplierRecord(saved, item)
  }, fail(409, 'RELATIONSHIP_EXISTS', 'This supplier is already linked to the item.', [{ field: 'supplierId', message: 'This supplier is already linked to the item.' }]))
}
