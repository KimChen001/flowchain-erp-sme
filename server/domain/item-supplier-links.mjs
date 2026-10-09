// Every item-supplier link of a workspace on one list, for the Supplier
// prices page (GET /api/master-data/item-suppliers). Read only: links are
// edited where they are today. The route masks each reference price the
// reader may not see (master-data-read-access.mjs maskReferencePrice), as the
// per-item and per-supplier reads do.

export const ITEM_SUPPLIER_LINK_PAGE = Object.freeze({ limit: 200, max: 500 })
// listItemSupplierRecords reads at most this many links when not narrowed to
// one item or one supplier.
export const ITEM_SUPPLIER_LINK_READ_CAP = 2000

const text = (value) => String(value ?? '').trim()
const whole = (value, fallback) => {
  if (value === null || value === undefined || value === '') return fallback
  const number = Number(value)
  return Number.isInteger(number) && number >= 0 ? number : fallback
}

// Each link (mapItemSupplierRecord) with its item and supplier from the
// master. A link whose item or supplier is no longer there keeps its ids.
export function joinItemSupplierLinks(links = [], { items = [], suppliers = [] } = {}) {
  const itemById = new Map(items.map((item) => [text(item.id), item]))
  const supplierById = new Map(suppliers.map((supplier) => [text(supplier.id), supplier]))
  return links.map((link) => {
    const item = itemById.get(text(link.itemId))
    const supplier = supplierById.get(text(link.supplierId))
    return {
      ...link,
      item: { itemId: link.itemId, sku: text(item?.sku) || link.itemId, itemName: text(item?.name), status: text(item?.status) || null },
      supplier: { supplierId: link.supplierId, supplierCode: text(supplier?.code) || link.supplierId, supplierName: text(supplier?.name) || link.supplierId, status: text(supplier?.status) || null },
    }
  })
}

// The links a search matches, over the item SKU and name, the supplier code
// and name and the supplier SKU; ordered by item SKU, then supplier name, so
// paging is stable; then one page of them.
export function itemSupplierLinkPage(rows = [], { query = '', limit, offset } = {}) {
  const needle = text(query).toLowerCase()
  const matched = rows
    .filter((row) => !needle || [row.item.sku, row.item.itemName, row.supplier.supplierCode, row.supplier.supplierName, row.supplierSku].some((value) => text(value).toLowerCase().includes(needle)))
    .sort((a, b) => a.item.sku.localeCompare(b.item.sku) || a.supplier.supplierName.localeCompare(b.supplier.supplierName) || text(a.relationshipId).localeCompare(text(b.relationshipId)))
  const size = Math.min(ITEM_SUPPLIER_LINK_PAGE.max, Math.max(1, whole(limit, ITEM_SUPPLIER_LINK_PAGE.limit)))
  const start = whole(offset, 0)
  return { rows: matched.slice(start, start + size), total: matched.length, limit: size, offset: start }
}

// The items and suppliers that have links, for the page's filters.
export function itemSupplierLinkOptions(rows = []) {
  const items = new Map()
  const suppliers = new Map()
  for (const row of rows) {
    if (!items.has(row.item.itemId)) items.set(row.item.itemId, { id: row.item.itemId, sku: row.item.sku, itemName: row.item.itemName })
    if (!suppliers.has(row.supplier.supplierId)) suppliers.set(row.supplier.supplierId, { id: row.supplier.supplierId, supplierCode: row.supplier.supplierCode, supplierName: row.supplier.supplierName })
  }
  return {
    items: [...items.values()].sort((a, b) => a.sku.localeCompare(b.sku)),
    suppliers: [...suppliers.values()].sort((a, b) => a.supplierName.localeCompare(b.supplierName)),
  }
}
