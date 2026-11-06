import { escapeLikePattern } from '../persistence/like-pattern.mjs'
import { getPrismaClient } from '../persistence/prisma-client.mjs'
import { validateDatabasePersistenceConfig } from '../persistence/persistence-config.mjs'
import { saveSupplierMaster } from '../domain/supplier-master-command.mjs'
import { changeSupplierOwner, changeSupplierTier } from '../domain/supplier-tier-command.mjs'
import { CUSTOMER_NAMESPACE, listItemSupplierRecords, mapItemSupplierRecord, saveCustomerMaster, saveItemMaster, saveItemSupplier } from '../domain/master-data-commands.mjs'
import { ITEM_SUPPLIER_LINK_READ_CAP, itemSupplierLinkOptions, itemSupplierLinkPage, joinItemSupplierLinks, preferredSupplierLink } from '../domain/item-supplier-links.mjs'
import { saveWarehouse, saveWarehouseBin, setWarehouseBinStatus, setWarehouseStatus, warehouseVersion } from '../domain/warehouse-master-commands.mjs'
import { findManyWithinLimit, requireTenantId } from './repository-read-scope.mjs'

function requireDatabaseConfig(env = process.env) {
  return validateDatabasePersistenceConfig(env)
}

async function resolvePrisma({ env = process.env, prisma } = {}) {
  requireDatabaseConfig(env)
  return prisma || getPrismaClient(env)
}

function text(value, fallback = '') {
  const next = String(value ?? '').trim()
  return next || fallback
}

function lower(value = '') {
  return text(value).toLowerCase()
}

function numberFrom(value, fallback = 0) {
  if (value === null || value === undefined || value === '') return fallback
  if (typeof value?.toNumber === 'function') return value.toNumber()
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function metadata(record = {}) {
  return record.metadata && typeof record.metadata === 'object' && !Array.isArray(record.metadata)
    ? record.metadata
    : {}
}

function tenantWhere(filters = {}) {
  return { tenantId: requireTenantId(filters) }
}

function safeLimit(value, fallback = 200) {
  return Math.min(500, Math.max(1, Number(value || fallback)))
}

// The unit someone recorded for the item's stock; '' when none is. mapItem's
// baseUnit falls back to 'pcs' for forms, which is not a recorded unit.
export function recordedItemUnit(record = {}) {
  const meta = metadata(record)
  return text(record.unit || meta.baseUom || meta.uom)
}

function mapItem(record = {}) {
  const meta = metadata(record)
  const itemId = text(record.id || record.sku)
  const itemName = text(record.name || record.sku)
  const baseUnit = text(recordedItemUnit(record), 'pcs')
  return {
    id: itemId,
    itemId,
    sku: text(record.sku || record.id),
    name: itemName,
    itemName,
    shortName: text(meta.shortName),
    itemType: text(meta.itemType, 'material'),
    category: record.category || meta.category || 'Uncategorized',
    brand: text(meta.brand),
    specification: text(meta.specification || meta.spec),
    baseUom: baseUnit,
    baseUnit,
    recordedUnit: recordedItemUnit(record),
    purchaseUnit: text(meta.purchaseUnit, baseUnit),
    // Only a warehouse someone set: drafts and data-quality checks rely on it.
    defaultWarehouseId: meta.defaultWarehouseId || meta.warehouseId || '',
    preferredSupplierId: record.preferredSupplierId || meta.preferredSupplierId || '',
    defaultSupplierId: record.preferredSupplierId || meta.preferredSupplierId || '',
    preferredSupplierSource: record.preferredSupplierId ? 'matched_supplier_master' : meta.preferredSupplierSource || 'missing',
    leadTimeDays: numberFrom(meta.leadTimeDays ?? meta.leadTime, 0),
    purchaseLeadTimeDays: numberFrom(meta.purchaseLeadTimeDays ?? meta.leadTimeDays ?? meta.leadTime, 0),
    moq: numberFrom(meta.moq ?? meta.minimumOrderQuantity, 1),
    minimumOrderQuantity: numberFrom(meta.minimumOrderQuantity ?? meta.moq, 1),
    batchMultiple: numberFrom(meta.batchMultiple, 1),
    // Item.safetyStock and Item.reorderPoint are columns; metadata is the legacy fallback.
    safetyStock: numberFrom(record.safetyStock ?? meta.safetyStock, 0),
    reorderPoint: numberFrom(record.reorderPoint ?? meta.reorderPoint, 0),
    taxCodeId: text(meta.taxCodeId),
    barcode: text(meta.barcode),
    manufacturerPartNumber: text(meta.manufacturerPartNumber),
    purchasable: meta.purchasable !== false,
    inventoryItem: meta.inventoryItem !== false,
    batchManaged: Boolean(meta.batchManaged),
    serialManaged: Boolean(meta.serialManaged),
    shelfLifeManaged: Boolean(meta.shelfLifeManaged),
    comments: text(meta.comments),
    status: record.status || 'active',
    version: numberFrom(record.version ?? meta.version, 1),
    createdBy: text(meta.createdBy, 'system'),
    createdAt: record.createdAt || meta.createdAt || '',
    updatedBy: text(meta.updatedBy, 'system'),
    updatedAt: record.updatedAt || meta.updatedAt || '',
  }
}

function mapSupplier(record = {}) {
  const meta = metadata(record)
  const score = record.score === null || record.score === undefined ? meta.score || '' : String(record.score)
  const id = text(record.id || record.name)
  const name = text(record.name || record.id)
  return {
    id,
    supplierCode: text(record.code || meta.supplierCode, id),
    name,
    supplierName: name,
    shortName: text(meta.shortName),
    status: record.status || 'active',
    businessType: text(meta.businessType),
    risk: record.riskLevel || meta.risk || 'medium',
    score,
    scoreSource: score ? 'explicit' : meta.scoreSource || 'missing',
    // Only recorded values: an empty currency or payment term stays null
    // ("not recorded"), never a USD or NET30 default.
    defaultCurrency: text(meta.defaultCurrency || meta.currency) || null,
    paymentTermsId: text(meta.paymentTermsId || meta.paymentTerms) || null,
    categories: Array.isArray(meta.categories) ? meta.categories : [record.category || meta.category || 'General'].filter(Boolean),
    contactName: text(meta.contactName || meta.contact),
    telephone: text(meta.telephone || meta.phone),
    email: text(meta.email),
    address: text(meta.address),
    postalCode: text(meta.postalCode),
    deliveryCycleDays: numberFrom(meta.deliveryCycleDays, 0),
    settlementMethod: text(meta.settlementMethod),
    creditCode: text(meta.creditCode),
    taxIdentificationNumber: text(meta.taxIdentificationNumber),
    bankName: text(meta.bankName),
    bankAccountName: text(meta.bankAccountName),
    bankAccountNumber: text(meta.bankAccountNumber),
    internalComment: text(meta.internalComment),
    version: numberFrom(record.version ?? meta.version, 1),
    updatedAt: record.updatedAt || meta.updatedAt || '',
    preferred: Boolean(meta.preferred),
    tier: record.tier ?? null,
    tierReason: text(record.tierReason) || null,
    tierSetAt: record.tierSetAt || null,
    tierSetBy: record.tierSetBy ? { id: record.tierSetBy.id, name: record.tierSetBy.name } : null,
    businessOwner: record.businessOwner ? { id: record.businessOwner.id, name: record.businessOwner.name } : null,
  }
}

// The names behind a supplier's tier and owner, read with the supplier.
const SUPPLIER_PEOPLE = Object.freeze({ tierSetBy: { select: { id: true, name: true } }, businessOwner: { select: { id: true, name: true } } })
const TIER_FILTERS = Object.freeze({ 1: { tier: 1 }, 2: { tier: 2 }, 3: { tier: 3 }, none: { tier: null } })

// The supplier list's filters. Search, status and category apply to every
// tab; tier and owner pick the tab. The owner "me" is the signed-in user.
function supplierWhere(filters = {}, { tab = true } = {}) {
  // Prisma's contains does not escape LIKE wildcards: "%" alone would match every supplier.
  const query = escapeLikePattern(text(filters.query))
  const category = text(filters.category)
  const owner = text(filters.owner) === 'me' ? text(filters.currentUserId) || '-' : text(filters.owner)
  return {
    ...tenantWhere(filters),
    ...(text(filters.status) ? { status: text(filters.status) } : {}),
    // Filters run in the database, so a match beyond the row limit is still found.
    AND: [
      ...(query ? [{ OR: [{ code: { contains: query, mode: 'insensitive' } }, { name: { contains: query, mode: 'insensitive' } }] }] : []),
      // The column holds a supplier's first category; metadata lists all of them.
      ...(category ? [{ OR: [{ category }, { metadata: { path: ['categories'], array_contains: [category] } }] }] : []),
      ...(tab && TIER_FILTERS[text(filters.tier)] ? [TIER_FILTERS[text(filters.tier)]] : []),
      ...(tab && owner ? [{ businessOwnerId: owner === 'none' ? null : owner }] : []),
    ],
  }
}

function mapWarehouse(record = {}) {
  const meta = metadata(record)
  return {
    id: record.id,
    code: text(record.code),
    name: record.name || record.code || record.id,
    type: meta.type || 'warehouse',
    status: record.status || 'active',
    parentId: meta.parentId ?? null,
    sourceType: meta.sourceType || 'database',
    // Warehouses keep their optimistic version in metadata (no column).
    version: warehouseVersion(record),
    updatedAt: record.updatedAt ?? null,
  }
}

// A bin: one WarehouseLocation row. Edits send updatedAt back as their version.
function mapWarehouseBin(record = {}) {
  return {
    id: record.id,
    warehouseId: record.warehouseId,
    code: text(record.code),
    locationKey: text(record.locationKey),
    name: record.name ?? null,
    status: record.status || 'active',
    updatedAt: record.updatedAt ?? null,
  }
}

function mapPaymentTerm(record = {}) {
  const meta = metadata(record)
  return {
    id: record.code || record.id,
    // The row id, which the supplier import stores as a supplier's term.
    recordId: record.id,
    label: record.name || record.code || record.id,
    days: numberFrom(record.days, 30),
    status: meta.status || 'active',
    sourceType: meta.sourceType || 'database',
  }
}

function mapTaxCode(record = {}) {
  const meta = metadata(record)
  return {
    id: record.code || record.id,
    label: record.name || record.code || record.id,
    rate: numberFrom(record.rate, 0),
    taxType: text(record.taxType || meta.taxType),
    region: text(record.region || meta.region),
    isDefault: meta.isDefault === true,
    status: meta.status || 'active',
    sourceType: meta.sourceType || 'database',
  }
}

function mapCustomer(record = {}) {
  const payload = record.payload && typeof record.payload === 'object' && !Array.isArray(record.payload) ? record.payload : {}
  return {
    id: text(payload.id, record.id),
    code: text(payload.code, record.recordKey),
    name: text(payload.name, record.recordKey),
    status: text(payload.status, 'active'),
    // Only recorded values: no currency or credit standing is assumed.
    currency: text(payload.currency),
    contact: text(payload.contact),
    phone: text(payload.phone),
    email: text(payload.email),
    address: text(payload.address),
    paymentTerms: text(payload.paymentTerms),
    creditStatus: text(payload.creditStatus),
    version: Number(payload.version || 1),
    sourceType: 'database',
  }
}

function itemMatches(record = {}, idOrSku = '') {
  const key = lower(idOrSku)
  return [record.id, record.sku, record.name].some((value) => lower(value) === key)
}

function supplierMatches(record = {}, idOrName = '') {
  const key = lower(idOrName)
  return [record.id, record.code, record.name].some((value) => lower(value) === key)
}

export function createDbMasterDataRepository({ env = process.env, prisma } = {}) {
  // A saved supplier, read again with the people behind its tier and owner.
  const withPeople = async (saved) => {
    const client = await resolvePrisma({ env, prisma })
    return (await client.supplier.findUnique({ where: { id: saved.id }, include: SUPPLIER_PEOPLE })) || saved
  }
  return {
    mode: 'database',
    adapter: 'db-master-data-v1',
    createSupplier: async (input, actorId, scope) => mapSupplier(await withPeople(await saveSupplierMaster(await resolvePrisma({ env, prisma }), null, input, actorId, scope))),
    updateSupplier: async (id, input, actorId, scope) => mapSupplier(await withPeople(await saveSupplierMaster(await resolvePrisma({ env, prisma }), id, input, actorId, scope))),
    setSupplierTier: async (id, input, actorId, scope) => mapSupplier(await withPeople(await changeSupplierTier(await resolvePrisma({ env, prisma }), decodeURIComponent(String(id || '')), input, actorId, scope))),
    setSupplierOwner: async (id, input, actorId, scope) => mapSupplier(await withPeople(await changeSupplierOwner(await resolvePrisma({ env, prisma }), decodeURIComponent(String(id || '')), input, actorId, scope))),
    // The people a supplier can be assigned to: active users of the workspace.
    listSupplierOwners: async (options = {}) => {
      const client = await resolvePrisma({ env, prisma })
      return client.user.findMany({ where: { ...tenantWhere(options), status: 'active' }, select: { id: true, name: true }, orderBy: [{ name: 'asc' }, { id: 'asc' }] })
    },
    // How many suppliers each list tab holds under the current search, status
    // and category, counted in the database.
    supplierTabCounts: async (filters = {}) => {
      const client = await resolvePrisma({ env, prisma })
      // A client without grouped counts (a test double) gets the list without tab counts.
      if (typeof client.supplier?.groupBy !== 'function') return null
      const where = supplierWhere(filters, { tab: false })
      const [groups, mine] = await Promise.all([
        client.supplier.groupBy({ by: ['tier'], where, _count: { _all: true } }),
        text(filters.currentUserId) ? client.supplier.count({ where: { ...where, AND: [...where.AND, { businessOwnerId: text(filters.currentUserId) }] } }) : 0,
      ])
      const count = (tier) => groups.find((row) => (row.tier ?? null) === tier)?._count._all || 0
      return { all: groups.reduce((sum, row) => sum + row._count._all, 0), mine, tier1: count(1), tier2: count(2), tier3: count(3), untiered: count(null) }
    },
    // The supplier's tier and owner changes, newest first, from the audit log.
    supplierTierHistory: async (id = '', options = {}) => {
      const client = await resolvePrisma({ env, prisma })
      const rows = await client.auditLog.findMany({
        where: { ...tenantWhere(options), entityType: 'supplier', entityId: text(decodeURIComponent(String(id || ''))), action: { in: ['tier_change', 'owner_change'] } },
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        take: 20,
        include: { actor: { select: { id: true, name: true } } },
      })
      const ownerIds = [...new Set(rows.flatMap((row) => [row.metadata?.fromOwnerId, row.metadata?.toOwnerId]).filter(Boolean))]
      const owners = ownerIds.length ? await client.user.findMany({ where: { ...tenantWhere(options), id: { in: ownerIds } }, select: { id: true, name: true } }) : []
      const person = (userId) => (userId ? owners.find((user) => user.id === userId) || { id: userId, name: null } : null)
      return rows.map((row) => ({
        kind: row.action === 'tier_change' ? 'tier' : 'owner',
        at: row.createdAt,
        by: row.actor ? { id: row.actor.id, name: row.actor.name } : null,
        ...(row.action === 'tier_change'
          ? { fromTier: row.metadata?.fromTier ?? null, toTier: row.metadata?.toTier ?? null, reason: row.metadata?.reason || null, acceptedSuggestion: Boolean(row.metadata?.acceptedSuggestion) }
          : { fromOwner: person(row.metadata?.fromOwnerId), toOwner: person(row.metadata?.toOwnerId) }),
      }))
    },
    createItem: async (input, actorId, scope) => mapItem(await saveItemMaster(await resolvePrisma({ env, prisma }), null, input, actorId, scope)),
    updateItem: async (id, input, actorId, scope) => mapItem(await saveItemMaster(await resolvePrisma({ env, prisma }), decodeURIComponent(String(id || '')), input, actorId, scope)),
    createCustomer: async (input, actorId, scope) => mapCustomer(await saveCustomerMaster(await resolvePrisma({ env, prisma }), null, input, actorId, scope)),
    updateCustomer: async (id, input, actorId, scope) => mapCustomer(await saveCustomerMaster(await resolvePrisma({ env, prisma }), decodeURIComponent(String(id || '')), input, actorId, scope)),
    createItemSupplier: async (itemId, input, actorId, scope) => saveItemSupplier(await resolvePrisma({ env, prisma }), itemId, null, input, actorId, scope),
    updateItemSupplier: async (itemId, relationshipId, input, actorId, scope) => saveItemSupplier(await resolvePrisma({ env, prisma }), itemId, relationshipId, input, actorId, scope),
    // The items a supplier is linked to, with each item's SKU and name.
    listSupplierItems: async (supplierId = '', options = {}) => {
      const client = await resolvePrisma({ env, prisma })
      const where = tenantWhere(options)
      const rows = await listItemSupplierRecords(client, where.tenantId, { supplierId: text(supplierId) })
      const items = rows.length ? await client.item.findMany({ where: { ...where, id: { in: rows.map((row) => text(row.payload?.itemId)) } } }) : []
      const byId = new Map(items.map((item) => [item.id, item]))
      return rows.map((row) => mapItemSupplierRecord(row, byId.get(text(row.payload?.itemId)) || null))
    },
    // Every item-supplier link with its item and supplier, for Supplier
    // prices: narrowed to one item or one supplier in the database (by the
    // record key), then searched and paged. Without either, the filters'
    // options (the items and suppliers that have links) come along, and
    // truncated says when the read reached its cap.
    listItemSupplierLinks: async (filters = {}) => {
      const client = await resolvePrisma({ env, prisma })
      const where = tenantWhere(filters)
      const itemId = text(filters.itemId)
      const supplierId = text(filters.supplierId)
      const records = await listItemSupplierRecords(client, where.tenantId, { itemId, supplierId })
      const stored = records.map((row) => mapItemSupplierRecord(row))
      // An item's preferred supplier without a stored link is listed too, as
      // the item page lists it (listItemSuppliers).
      const linked = new Set(stored.map((link) => `${link.itemId}::${link.supplierId}`))
      const preferredItems = await client.item.findMany({
        where: { ...where, ...(itemId ? { id: itemId } : {}), preferredSupplierId: supplierId || { not: null } },
        select: { id: true, preferredSupplierId: true },
        take: ITEM_SUPPLIER_LINK_READ_CAP,
      })
      const links = [
        ...stored,
        ...preferredItems
          .filter((item) => !linked.has(`${item.id}::${item.preferredSupplierId}`))
          .map((item) => preferredSupplierLink(item.id, item.preferredSupplierId)),
      ]
      const ids = (key) => [...new Set(links.map((link) => link[key]).filter(Boolean))]
      const [items, suppliers] = links.length
        ? await Promise.all([
          client.item.findMany({ where: { ...where, id: { in: ids('itemId') } }, select: { id: true, sku: true, name: true, status: true } }),
          client.supplier.findMany({ where: { ...where, id: { in: ids('supplierId') } }, select: { id: true, code: true, name: true, status: true } }),
        ])
        : [[], []]
      // As on the item page, a preferred supplier no longer in the workspace is not listed.
      const known = new Set(suppliers.map((supplier) => supplier.id))
      const rows = joinItemSupplierLinks(links.filter((link) => link.source !== 'item_preferred_supplier' || known.has(link.supplierId)), { items, suppliers })
      const narrowed = Boolean(itemId || supplierId)
      return {
        ...itemSupplierLinkPage(rows, { query: filters.query, limit: filters.limit, offset: filters.offset }),
        truncated: !narrowed && records.length >= ITEM_SUPPLIER_LINK_READ_CAP,
        ...(narrowed ? {} : { options: itemSupplierLinkOptions(rows) }),
      }
    },
    listItems: async (filters = {}) => {
      const client = await resolvePrisma({ env, prisma })
      const records = await findManyWithinLimit(client.item, {
        where: {
          ...tenantWhere(filters),
          ...(text(filters.status) ? { status: text(filters.status) } : {}),
        },
        orderBy: [{ sku: 'asc' }],
      }, { limit: safeLimit(filters.limit), subject: 'items', onTruncated: filters.onTruncated })
      return records.map(mapItem)
    },
    // The recorded stock unit of each item a list of SKUs or item ids names
    // (the purchase order lines of a read context), whatever the size of the
    // item list: { sku, itemId, unit }, unit '' when none is recorded.
    listRecordedItemUnits: async (filters = {}) => {
      const keys = [...new Set((Array.isArray(filters.keys) ? filters.keys : []).map((key) => text(key)).filter(Boolean))]
      if (!keys.length) return []
      const client = await resolvePrisma({ env, prisma })
      const records = await client.item.findMany({
        where: { ...tenantWhere(filters), OR: [{ sku: { in: keys } }, { id: { in: keys } }] },
        select: { id: true, sku: true, unit: true, metadata: true },
      })
      return records.map((record) => ({ sku: text(record.sku), itemId: text(record.id), unit: recordedItemUnit(record) }))
    },
    getItem: async (idOrSku = '', options = {}) => {
      const client = await resolvePrisma({ env, prisma })
      const key = text(decodeURIComponent(String(idOrSku || '')))
      if (!key) return null
      const records = await client.item.findMany({
        where: tenantWhere(options),
        take: safeLimit(options.limit, 500),
      })
      const record = records.find((item) => itemMatches(item, key))
      return record ? mapItem(record) : null
    },
    listSuppliers: async (filters = {}) => {
      const client = await resolvePrisma({ env, prisma })
      const records = await findManyWithinLimit(client.supplier, {
        where: supplierWhere(filters),
        include: SUPPLIER_PEOPLE,
        orderBy: [{ name: 'asc' }],
      }, { limit: safeLimit(filters.limit), subject: 'suppliers', onTruncated: filters.onTruncated })
      return records.map(mapSupplier)
    },
    listCustomers: async (filters = {}) => {
      const client = await resolvePrisma({ env, prisma })
      if (!client.runtimeRecord?.findMany) return []
      const query = lower(filters.query)
      const records = await client.runtimeRecord.findMany({
        where: { ...tenantWhere(filters), namespace: 'master-data.customers' },
        orderBy: [{ recordKey: 'asc' }],
        take: safeLimit(filters.limit),
      })
      return records.filter((record) => record.namespace === undefined || record.namespace === CUSTOMER_NAMESPACE).map(mapCustomer).filter((customer) =>
        (!query || [customer.id, customer.code, customer.name].some(value => lower(value).includes(query)))
        && (!text(filters.status) || customer.status === text(filters.status)),
      )
    },
    getCustomer: async (idOrCode = '', options = {}) => {
      const customers = await createDbMasterDataRepository({ env, prisma }).listCustomers({ ...options, limit: 500 })
      const key = lower(decodeURIComponent(String(idOrCode || '')))
      return customers.find(customer => [customer.id, customer.code, customer.name].some(value => lower(value) === key)) || null
    },
    getSupplier: async (idOrName = '', options = {}) => {
      const client = await resolvePrisma({ env, prisma })
      const key = text(decodeURIComponent(String(idOrName || '')))
      if (!key) return null
      const records = await client.supplier.findMany({
        where: tenantWhere(options),
        include: SUPPLIER_PEOPLE,
        take: safeLimit(options.limit, 500),
      })
      const record = records.find((supplier) => supplierMatches(supplier, key))
      return record ? mapSupplier(record) : null
    },
    // An item's approved purchasing sources: its active, approved
    // item-supplier relationships, plus its preferred supplier when no
    // relationship records that supplier, each only while the supplier is
    // active in the same workspace. The preferred source comes first.
    approvedSuppliersForItem: async (idOrSku = '', options = {}) => {
      const client = await resolvePrisma({ env, prisma })
      const key = text(decodeURIComponent(String(idOrSku || '')))
      if (!key) return []
      const where = tenantWhere(options)
      const items = await client.item.findMany({ where, take: safeLimit(options.limit, 500) })
      const item = items.find((row) => itemMatches(row, key))
      if (!item) return []
      const itemMeta = metadata(item)
      const relationships = (await listItemSupplierRecords(client, where.tenantId, { itemId: item.id })).map((row) => mapItemSupplierRecord(row))
      const sources = relationships.filter((row) => row.active && row.approved)
      if (item.preferredSupplierId && !relationships.some((row) => row.supplierId === item.preferredSupplierId)) {
        const legacyPrice = itemMeta.referencePrice ?? itemMeta.purchasePrice ?? null
        sources.push({ supplierId: item.preferredSupplierId, preferred: true, referencePrice: legacyPrice === null || legacyPrice === '' ? null : Number(legacyPrice), currency: text(itemMeta.purchaseCurrency) })
      }
      if (!sources.length) return []
      const suppliers = await client.supplier.findMany({ where: { ...where, id: { in: sources.map((row) => row.supplierId) } } })
      const byId = new Map(suppliers.map((row) => [row.id, row]))
      return sources
        .map((source) => ({ source, supplier: byId.get(source.supplierId) }))
        .filter(({ supplier }) => supplier && lower(supplier.status || 'active') === 'active')
        .sort((a, b) => Number(Boolean(b.source.preferred || b.supplier.id === item.preferredSupplierId)) - Number(Boolean(a.source.preferred || a.supplier.id === item.preferredSupplierId)))
        .map(({ source, supplier }) => {
          const supplierMeta = metadata(supplier)
          return {
            ...mapSupplier(supplier),
            preferred: Boolean(source.preferred) || supplier.id === item.preferredSupplierId,
            referencePrice: source.referencePrice === null || source.referencePrice === undefined ? null : String(source.referencePrice),
            // Only a currency someone recorded; never a guess.
            currency: text(source.currency || supplierMeta.defaultCurrency || supplierMeta.currency) || null,
            leadTimeDays: source.leadTimeDays ?? null,
            minimumOrderQuantity: source.minimumOrderQuantity ?? null,
          }
        })
    },
    listItemSuppliers: async (idOrSku = '', options = {}) => {
      const client = await resolvePrisma({ env, prisma })
      const where = tenantWhere(options)
      const key = text(decodeURIComponent(String(idOrSku || '')))
      const items = key ? await client.item.findMany({ where, take: safeLimit(options.limit, 500) }) : []
      const item = items.find((row) => itemMatches(row, key))
      if (!item) return []
      const rows = (await listItemSupplierRecords(client, where.tenantId, { itemId: item.id })).map((row) => mapItemSupplierRecord(row))
      const suppliers = rows.length ? await client.supplier.findMany({ where: { ...where, id: { in: rows.map((row) => row.supplierId) } } }) : []
      const names = new Map(suppliers.map((row) => [row.id, row.name]))
      const listed = rows.map((row) => ({ ...row, supplierName: names.get(row.supplierId) || '', status: row.active && row.approved ? 'approved' : 'inactive' }))
      if (item.preferredSupplierId && !rows.some((row) => row.supplierId === item.preferredSupplierId)) {
        const supplier = await client.supplier.findFirst({ where: { ...where, id: item.preferredSupplierId } })
        if (supplier) listed.unshift({ supplierId: supplier.id, supplierName: supplier.name, status: 'approved', preferred: true, source: 'item_preferred_supplier' })
      }
      return listed
    },
    listWarehouses: async (filters = {}) => {
      const client = await resolvePrisma({ env, prisma })
      const records = await client.warehouse.findMany({
        where: tenantWhere(filters),
        orderBy: [{ code: 'asc' }],
        take: safeLimit(filters.limit),
      })
      return records.map(mapWarehouse)
    },
    // Warehouse and bin writes (warehouse-master-commands.mjs). Each one is
    // checked for a tenant before the database is touched.
    createWarehouse: async (input, actorId, scope) => {
      tenantWhere(scope)
      return mapWarehouse(await saveWarehouse(await resolvePrisma({ env, prisma }), null, input, actorId, scope))
    },
    updateWarehouse: async (id, input, actorId, scope) => {
      tenantWhere(scope)
      return mapWarehouse(await saveWarehouse(await resolvePrisma({ env, prisma }), text(id), input, actorId, scope))
    },
    setWarehouseStatus: async (id, input, actorId, scope) => {
      tenantWhere(scope)
      const { warehouse, clearedDefaults } = await setWarehouseStatus(await resolvePrisma({ env, prisma }), text(id), input, actorId, scope)
      return { warehouse: mapWarehouse(warehouse), clearedDefaults }
    },
    listWarehouseBins: async (warehouseId = '', options = {}) => {
      const where = tenantWhere(options)
      const client = await resolvePrisma({ env, prisma })
      const records = await client.warehouseLocation.findMany({
        where: { ...where, warehouseId: text(warehouseId) },
        orderBy: [{ code: 'asc' }],
        take: safeLimit(options.limit, 500),
      })
      return records.map(mapWarehouseBin)
    },
    createWarehouseBin: async (warehouseId, input, actorId, scope) => {
      tenantWhere(scope)
      return mapWarehouseBin(await saveWarehouseBin(await resolvePrisma({ env, prisma }), text(warehouseId), null, input, actorId, scope))
    },
    updateWarehouseBin: async (warehouseId, binId, input, actorId, scope) => {
      tenantWhere(scope)
      return mapWarehouseBin(await saveWarehouseBin(await resolvePrisma({ env, prisma }), text(warehouseId), text(binId), input, actorId, scope))
    },
    setWarehouseBinStatus: async (warehouseId, binId, input, actorId, scope) => {
      tenantWhere(scope)
      return mapWarehouseBin(await setWarehouseBinStatus(await resolvePrisma({ env, prisma }), text(warehouseId), text(binId), input, actorId, scope))
    },
    listPaymentTerms: async (filters = {}) => {
      const client = await resolvePrisma({ env, prisma })
      const records = await client.paymentTerm.findMany({
        where: tenantWhere(filters),
        orderBy: [{ code: 'asc' }],
        take: safeLimit(filters.limit),
      })
      return records.map(mapPaymentTerm)
    },
    listTaxCodes: async (filters = {}) => {
      const client = await resolvePrisma({ env, prisma })
      const records = await client.taxCode.findMany({
        where: tenantWhere(filters),
        orderBy: [{ code: 'asc' }],
        take: safeLimit(filters.limit),
      })
      return records.map(mapTaxCode)
    },
  }
}
