const array = value => Array.isArray(value) ? value : []
const text = value => String(value ?? '').trim()
const lower = value => text(value).toLowerCase()
const idOf = (row, keys) => text(keys.map(key => row?.[key]).find(Boolean))

const definitions = [
  ['item', 'items', ['itemId', 'sku', 'id'], ['itemName', 'name', 'sku'], '/app/master-data/items', 'masterData.itemRuntime'],
  ['supplier', 'suppliers', ['id', 'supplierCode', 'code'], ['supplierName', 'name', 'supplierCode'], '/app/master-data/suppliers', 'masterData.supplierRuntime'],
  ['customer', 'customers', ['id', 'code', 'customerCode'], ['name', 'customerName', 'code'], '/app/master-data/customers', 'masterData.customerRuntime'],
  ['sales_order', 'salesOrders', ['salesOrderId', 'id'], ['customerName', 'salesOrderId'], '/app/sales/orders', 'salesOrders'],
  ['purchase_request', 'purchaseRequests', ['id', 'pr'], ['title', 'id'], '/app/procurement/requests', 'procurementRuntime'],
  ['rfq', 'rfqs', ['id'], ['title', 'id'], '/app/procurement/rfq', 'procurementRuntime'],
  ['purchase_order', 'purchaseOrders', ['id', 'po'], ['supplierSnapshot.supplierName', 'id'], '/app/procurement/orders', 'procurementRuntime'],
  ['inventory_item', 'inventoryItems', ['sku', 'itemId', 'id'], ['itemName', 'name', 'sku'], '/app/inventory/items', 'inventoryRuntime'],
  ['warehouse', 'warehouses', ['id', 'warehouseId', 'code'], ['name', 'warehouseName', 'code'], '/app/master-data/warehouses', 'warehouseRuntime'],
]

function nested(row, key) { return key.split('.').reduce((value, part) => value?.[part], row) }

export function searchRuntimeBusinessContext(context, query, { limit = 15 } = {}) {
  const normalized = lower(query)
  if (!normalized) return []
  const results = []
  for (const [entityType, collection, idKeys, labelKeys, route, sourceRepository] of definitions) {
    for (const row of array(context[collection])) {
      const entityId = idOf(row, idKeys)
      if (!entityId) continue
      const label = text(labelKeys.map(key => nested(row, key)).find(Boolean)) || entityId
      const haystack = lower([entityId, label, ...Object.values(row).filter(value => typeof value !== 'object')].join(' '))
      if (!haystack.includes(normalized)) continue
      const exact = lower(entityId) === normalized || lower(label) === normalized
      const canonicalRoute = `${route}/${encodeURIComponent(entityId)}`
      results.push({
        id: `${entityType}:${entityId}`,
        type: entityType,
        entityType,
        entityId,
        entityLabel: label,
        label,
        subtitle: text(row.status || row.statusLabel || row.supplierName || row.customerName),
        status: text(row.status || row.statusLabel),
        canonicalRoute,
        deepLink: canonicalRoute,
        sourceRepository,
        score: exact ? 120 : lower(entityId).includes(normalized) ? 95 : 72,
        matchedFields: exact ? ['entityId'] : ['runtimeRecord'],
        evidence: [{ label: '来源', value: sourceRepository }],
      })
    }
  }
  return results.sort((a, b) => b.score - a.score || a.entityId.localeCompare(b.entityId)).slice(0, Math.max(1, Math.min(100, Number(limit) || 15)))
}
