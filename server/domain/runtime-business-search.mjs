const array = value => Array.isArray(value) ? value : []
const text = value => String(value ?? '').trim()
const lower = value => text(value).toLowerCase()
const idOf = (row, keys) => text(keys.map(key => row?.[key]).find(Boolean))

// Purchase requests, RFQs and purchase orders are found by the number they
// show (PR-202611-0001) as well as by their id; a result names its number. A
// sales order names its number when it has one.
const NUMBERED = new Set(['purchase_request', 'rfq', 'purchase_order'])
const numberOf = row => text(row?.number || row?.orderNumber || row?.documentNumber)
// The code a person knows a master record by (SKU, supplier or customer code),
// shown under the name; the id stays in the link.
const CODE_KEYS = { item: ['sku'], supplier: ['supplierCode', 'code'], customer: ['code', 'customerCode'], inventory_item: ['sku'], warehouse: ['code'] }

const definitions = [
  ['item', 'items', ['itemId', 'sku', 'id'], ['itemName', 'name', 'sku'], '/app/master-data/items', 'masterData.itemRuntime'],
  ['supplier', 'suppliers', ['id', 'supplierCode', 'code'], ['supplierName', 'name', 'supplierCode'], '/app/master-data/suppliers', 'masterData.supplierRuntime'],
  ['customer', 'customers', ['id', 'code', 'customerCode'], ['name', 'customerName', 'code'], '/app/master-data/customers', 'masterData.customerRuntime'],
  ['sales_order', 'salesOrders', ['salesOrderId', 'id'], ['customerName', 'salesOrderId'], '/app/sales/orders', 'salesOrders'],
  ['purchase_request', 'purchaseRequests', ['id', 'pr'], ['title', 'number', 'id'], '/app/procurement/requests', 'procurementRuntime'],
  ['rfq', 'rfqs', ['id'], ['title', 'number', 'id'], '/app/procurement/rfq', 'procurementRuntime'],
  ['purchase_order', 'purchaseOrders', ['id', 'po'], ['supplierSnapshot.supplierName', 'orderNumber', 'id'], '/app/procurement/orders', 'procurementRuntime'],
  // Stock has no page of its own: a stock row opens the stock list filtered to its SKU.
  ['inventory_item', 'inventoryItems', ['sku', 'itemId', 'id'], ['itemName', 'name', 'sku'], '/app/inventory/stock?sku=', 'inventoryRuntime'],
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
      const number = NUMBERED.has(entityType) ? numberOf(row) || entityId : entityType === 'sales_order' ? numberOf(row) : ''
      const code = text((CODE_KEYS[entityType] || []).map(key => row?.[key]).find(Boolean))
      const haystack = lower([entityId, number, label, ...Object.values(row).filter(value => typeof value !== 'object')].join(' '))
      if (!haystack.includes(normalized)) continue
      const exact = lower(entityId) === normalized || lower(label) === normalized || (number && lower(number) === normalized)
      const canonicalRoute = route.endsWith('=') ? `${route}${encodeURIComponent(entityId)}` : `${route}/${encodeURIComponent(entityId)}`
      results.push({
        id: `${entityType}:${entityId}`,
        type: entityType,
        entityType,
        entityId,
        entityLabel: label,
        label,
        ...(number ? { number } : {}),
        ...(code && code !== label ? { code } : {}),
        subtitle: text(row.status || row.statusLabel || row.supplierName || row.customerName),
        status: text(row.status || row.statusLabel),
        canonicalRoute,
        deepLink: canonicalRoute,
        sourceRepository,
        score: exact ? 120 : lower(entityId).includes(normalized) || lower(number).includes(normalized) ? 95 : 72,
        matchedFields: exact ? [number && lower(number) === normalized ? 'number' : 'entityId'] : ['runtimeRecord'],
        // sourceRepository names the internal repository the row came from; it is
        // for diagnostics and never shown, so the result carries no evidence row.
        evidence: [],
      })
    }
  }
  return results.sort((a, b) => b.score - a.score || a.entityId.localeCompare(b.entityId)).slice(0, Math.max(1, Math.min(100, Number(limit) || 15)))
}
