const defaultWarehouse = Object.freeze({
  id: 'WH-MAIN',
  name: 'Main Warehouse',
  type: 'warehouse',
  status: 'active',
  parentId: null,
  sourceType: 'default_reference',
})

const defaultPaymentTerms = Object.freeze([
  { id: 'NET30', label: 'Net 30', days: 30, status: 'active', sourceType: 'default_reference' },
])

const defaultTaxCodes = Object.freeze([
  { id: 'TAX-STD', label: 'Standard Tax', rate: 0.1, status: 'active', sourceType: 'default_reference' },
])

function asArray(value) {
  return Array.isArray(value) ? value : []
}

function toNumber(value, fallback = 0) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function stableKey(value, fallback) {
  const key = String(value || '')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, '-')
    .replace(/[^\w\u4e00-\u9fa5-]/g, '')
  return key || fallback
}

function itemIdFor(item = {}, index = 0) {
  if (item.id || item.itemId || item.itemCode) return String(item.id || item.itemId || item.itemCode)
  const sku = item.sku || item.code || item.name
  return `ITEM-${stableKey(sku, String(index + 1).padStart(3, '0'))}`
}

function supplierIdFor(supplier = {}, index = 0) {
  if (supplier.id || supplier.supplierId) return String(supplier.id || supplier.supplierId)
  return `SUP-${stableKey(supplier.name || supplier.code, String(index + 1).padStart(3, '0'))}`
}

function findSupplierReadModel(suppliers = [], value = '') {
  const key = String(value || '').trim().toLowerCase()
  if (!key) return null
  return suppliers.find((supplier) =>
    [supplier.id, supplier.name].some((candidate) => String(candidate || '').toLowerCase() === key)
  ) || null
}

function resolvePreferredSupplier(item = {}, suppliers = []) {
  const explicitId = item.preferredSupplierId || item.supplierId || ''
  const supplierName = item.preferredSupplier || item.supplier || item.supplierName || ''
  const matched = findSupplierReadModel(suppliers, explicitId) || findSupplierReadModel(suppliers, supplierName)
  if (matched) {
    return { preferredSupplierId: matched.id, preferredSupplierSource: 'matched_supplier_master' }
  }
  if (explicitId) {
    return { preferredSupplierId: String(explicitId), preferredSupplierSource: 'fallback' }
  }
  if (supplierName) {
    return {
      preferredSupplierId: `SUP-${stableKey(supplierName, 'PREFERRED')}`,
      preferredSupplierSource: 'derived_from_item_supplier_name',
    }
  }
  return { preferredSupplierId: '', preferredSupplierSource: 'missing' }
}

function normalizeRisk(value) {
  const raw = String(value || '').trim().toLowerCase()
  if (raw === '高' || raw === 'high') return 'high'
  if (raw === '低' || raw === 'low') return 'low'
  if (raw === '中' || raw === 'medium') return 'medium'
  return raw || 'medium'
}

// Only a score someone recorded on the supplier. Rates are never turned into a
// grade here (owner decision 2026-10-03); the scorecard shows them as rates.
function supplierScoreFor(supplier = {}) {
  if (supplier.score || supplier.rating || supplier.grade) {
    return { score: String(supplier.score || supplier.rating || supplier.grade), scoreSource: 'explicit' }
  }
  return { score: '', scoreSource: 'missing' }
}

export function normalizeMasterItem(item = {}, index = 0, suppliers = []) {
  const sku = String(item.sku || item.code || item.id || item.itemId || '').trim()
  const supplier = resolvePreferredSupplier(item, suppliers)
  return {
    id: itemIdFor(item, index),
    sku,
    name: item.name || item.itemName || sku || `Item ${index + 1}`,
    category: item.category || 'Uncategorized',
    baseUom: item.baseUom || item.uom || item.unit || 'pcs',
    defaultWarehouseId: item.defaultWarehouseId || item.warehouseId || defaultWarehouse.id,
    preferredSupplierId: supplier.preferredSupplierId,
    preferredSupplierSource: supplier.preferredSupplierSource,
    leadTimeDays: toNumber(item.leadTimeDays ?? item.leadTime ?? item.leadTimePeriods, 0),
    moq: toNumber(item.moq ?? item.minimumOrderQuantity, 1),
    batchMultiple: toNumber(item.batchMultiple, 1),
    status: item.status || 'active',
  }
}

export function listMasterItems(db = {}) {
  const suppliers = listMasterSuppliers(db)
  return asArray(db.products).map((item, index) => normalizeMasterItem(item, index, suppliers))
}

export function findMasterItem(db = {}, id = '') {
  const key = decodeURIComponent(String(id || '')).toLowerCase()
  return listMasterItems(db).find((item) =>
    [item.id, item.sku, item.name].some((value) => String(value || '').toLowerCase() === key)
  ) || null
}

export function normalizeMasterSupplier(supplier = {}, index = 0) {
  const category = supplier.category || supplier.type || 'General'
  const score = supplierScoreFor(supplier)
  return {
    id: supplierIdFor(supplier, index),
    name: supplier.name || supplier.supplierName || `Supplier ${index + 1}`,
    status: supplier.status || 'active',
    risk: normalizeRisk(supplier.risk),
    score: score.score,
    scoreSource: score.scoreSource,
    // Only recorded values: no USD or NET30 default.
    defaultCurrency: String(supplier.defaultCurrency || supplier.currency || '').trim() || null,
    paymentTermsId: String(supplier.paymentTermsId || supplier.paymentTerms || '').trim() || null,
    categories: Array.isArray(supplier.categories) ? supplier.categories : [category].filter(Boolean),
    preferred: Boolean(supplier.preferred),
  }
}

export function listMasterSuppliers(db = {}) {
  return asArray(db.suppliers).map(normalizeMasterSupplier)
}

export function findMasterSupplier(db = {}, id = '') {
  const key = decodeURIComponent(String(id || '')).toLowerCase()
  return listMasterSuppliers(db).find((supplier) =>
    [supplier.id, supplier.name].some((value) => String(value || '').toLowerCase() === key)
  ) || null
}

export function listMasterWarehouses(db = {}) {
  const explicit = asArray(db.warehouses).map((warehouse, index) => ({
    id: warehouse.id || warehouse.warehouseId || `WH-${stableKey(warehouse.name, String(index + 1).padStart(3, '0'))}`,
    name: warehouse.name || warehouse.label || warehouse.id || `Warehouse ${index + 1}`,
    type: warehouse.type || 'warehouse',
    status: warehouse.status || 'active',
    parentId: warehouse.parentId ?? null,
    sourceType: warehouse.sourceType || 'explicit_data',
  }))
  const knownIds = new Set(explicit.map((warehouse) => warehouse.id))
  const inferred = []
  for (const id of new Set(asArray(db.products).map((item) => item.defaultWarehouseId || item.warehouseId).filter(Boolean))) {
    if (knownIds.has(id)) continue
    knownIds.add(id)
    inferred.push({ ...defaultWarehouse, id, name: id === defaultWarehouse.id ? defaultWarehouse.name : id, sourceType: 'derived_from_items' })
  }
  for (const id of new Set(asArray(db.inventoryMovements).map((movement) => movement.warehouseId).filter(Boolean))) {
    if (knownIds.has(id)) continue
    knownIds.add(id)
    inferred.push({ ...defaultWarehouse, id, name: id === defaultWarehouse.id ? defaultWarehouse.name : id, sourceType: 'derived_from_transactions' })
  }
  const warehouses = [...explicit, ...inferred]
  return warehouses.length ? warehouses : [{ ...defaultWarehouse }]
}

export function listPaymentTerms(db = {}) {
  const terms = asArray(db.paymentTerms).map((term) => ({
    id: term.id || term.paymentTermsId || term.code || 'NET30',
    label: term.label || term.name || term.id || 'Net 30',
    days: toNumber(term.days ?? term.netDays, 30),
    status: term.status || 'active',
    sourceType: term.sourceType || 'explicit_data',
  }))
  return terms.length ? terms : defaultPaymentTerms.map((term) => ({ ...term }))
}

export function listTaxCodes(db = {}) {
  const codes = asArray(db.taxCodes).map((code) => ({
    id: code.id || code.taxCodeId || code.code || 'TAX-STD',
    label: code.label || code.name || code.id || 'Standard Tax',
    rate: toNumber(code.rate, 0),
    status: code.status || 'active',
    sourceType: code.sourceType || 'explicit_data',
  }))
  return codes.length ? codes : defaultTaxCodes.map((code) => ({ ...code }))
}
