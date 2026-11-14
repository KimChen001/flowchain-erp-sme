import { listItemSupplierRecords, mapItemSupplierRecord } from './master-data-commands.mjs'
import { maskReferencePrice, masterDataReadAccessFor } from './master-data-read-access.mjs'
import { boughtInStockUnit, itemStockUnit } from './reorder-list.mjs'

// The items as stored and their approved purchasing sources with reference
// prices, for the assistant tools that price stock or what was sold
// (inventory_value, order_quantity_costs, gross_profit). Reference prices are
// masked as the master data routes mask them.

const text = (value) => String(value ?? '').trim()
const array = (value) => (Array.isArray(value) ? value : [])
const fold = (value) => text(value).toLowerCase()
const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value)

// An item's approved purchasing sources, by the rule of the item supplier
// read the purchase request form uses (approvedSuppliersForItem in
// db-master-data-repository.mjs): its active, approved supplier links, plus
// its preferred supplier when no link records it, each while the supplier is
// active, the preferred first. Ids, names and the link's figures only.
function approvedSourcesOf(item, records, suppliersById) {
  const meta = isObject(item.metadata) ? item.metadata : {}
  const relationships = records.map((record) => mapItemSupplierRecord(record))
  const sources = relationships.filter((row) => row.active && row.approved)
  if (text(item.preferredSupplierId) && !relationships.some((row) => row.supplierId === item.preferredSupplierId)) {
    const legacyPrice = meta.referencePrice ?? meta.purchasePrice ?? null
    sources.push({ supplierId: item.preferredSupplierId, preferred: true, referencePrice: legacyPrice === null || legacyPrice === '' ? null : Number(legacyPrice), currency: text(meta.purchaseCurrency), leadTimeDays: null, minimumOrderQuantity: null })
  }
  const isPreferred = (source, supplier) => Boolean(source.preferred) || supplier.id === item.preferredSupplierId
  return sources
    .map((source) => ({ source, supplier: suppliersById.get(source.supplierId) }))
    .filter(({ supplier }) => supplier && fold(supplier.status || 'active') === 'active')
    .sort((a, b) => Number(isPreferred(b.source, b.supplier)) - Number(isPreferred(a.source, a.supplier)))
    .map(({ source, supplier }) => {
      const supplierMeta = isObject(supplier.metadata) ? supplier.metadata : {}
      return {
        id: text(supplier.id), name: text(supplier.name || supplier.id), preferred: isPreferred(source, supplier),
        referencePrice: source.referencePrice === null || source.referencePrice === undefined ? null : String(source.referencePrice),
        currency: text(source.currency || supplierMeta.defaultCurrency || supplierMeta.currency) || null,
        leadTimeDays: source.leadTimeDays ?? null, minimumOrderQuantity: source.minimumOrderQuantity ?? null,
      }
    })
}

// The items as stored, by id: their status, purchase unit and default
// warehouse. One read in the user's workspace.
export async function storedItems({ prisma, tenantId }, itemIds) {
  if (!itemIds.length) return new Map()
  const items = await prisma.item.findMany({ where: { tenantId, id: { in: itemIds } }, select: { id: true, sku: true, name: true, unit: true, preferredSupplierId: true, metadata: true, status: true, reorderPoint: true } })
  return new Map(array(items).map((row) => [text(row.id), row]))
}

// The approved sources of the items returned, by item id, every read in the
// user's workspace. Only the rows returned are read (the named SKUs or up to
// the limit), so each item's links are read by its own key. Reference prices
// are masked as the master data routes mask them.
export async function itemSources(context, items) {
  const { prisma, tenantId } = context
  const [links, suppliers] = await Promise.all([
    Promise.all(items.map((item) => listItemSupplierRecords(prisma, tenantId, { itemId: text(item.id) }))),
    items.length ? prisma.supplier.findMany({ where: { tenantId }, select: { id: true, code: true, name: true, status: true, metadata: true } }) : [],
  ])
  const access = masterDataReadAccessFor(context.actor)
  const suppliersById = new Map(array(suppliers).map((row) => [text(row.id), row]))
  const byItem = new Map(items.map((item, index) => [text(item.id), approvedSourcesOf(item, array(links[index]), suppliersById).map((row) => maskReferencePrice(row, access))]))
  return { byItem, prices: access.prices }
}

// The price per stock unit from an approved source: its reference price, only
// when the item is bought in its stock unit and the user may see prices.
export const unitPriceOf = (item, source, prices) => (prices && source && boughtInStockUnit(item, itemStockUnit(item)) && source.referencePrice !== null && source.referencePrice !== undefined && Number.isFinite(Number(source.referencePrice)) ? Number(source.referencePrice) : null)
export const preferredSource = (sources) => sources.find((source) => source.preferred) || sources[0] || null
