import { escapeLikePattern } from '../persistence/like-pattern.mjs'
import { getPrismaClient } from '../persistence/prisma-client.mjs'
import { validateDatabasePersistenceConfig } from '../persistence/persistence-config.mjs'
import { saveSupplierMaster } from '../domain/supplier-master-command.mjs'
import { CUSTOMER_NAMESPACE, listItemSupplierRecords, mapItemSupplierRecord, saveCustomerMaster, saveItemMaster, saveItemSupplier } from '../domain/master-data-commands.mjs'
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

function mapItem(record = {}) {
  const meta = metadata(record)
  const itemId = text(record.id || record.sku)
  const itemName = text(record.name || record.sku)
  const baseUnit = text(record.unit || meta.baseUom || meta.uom, 'pcs')
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
    defaultCurrency: meta.defaultCurrency || meta.currency || 'USD',
    paymentTermsId: meta.paymentTermsId || meta.paymentTerms || 'NET30',
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
  }
}

function mapWarehouse(record = {}) {
  const meta = metadata(record)
  return {
    id: record.id,
    name: record.name || record.code || record.id,
    type: meta.type || 'warehouse',
    status: record.status || 'active',
    parentId: meta.parentId ?? null,
    sourceType: meta.sourceType || 'database',
  }
}

function mapPaymentTerm(record = {}) {
  const meta = metadata(record)
  return {
    id: record.code || record.id,
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
  return {
    mode: 'database',
    adapter: 'db-master-data-v1',
    createSupplier: async (input, actorId, scope) => mapSupplier(await saveSupplierMaster(await resolvePrisma({ env, prisma }), null, input, actorId, scope)),
    updateSupplier: async (id, input, actorId, scope) => mapSupplier(await saveSupplierMaster(await resolvePrisma({ env, prisma }), id, input, actorId, scope)),
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
      // Prisma's contains does not escape LIKE wildcards: "%" alone would match every supplier.
      const query = escapeLikePattern(text(filters.query))
      const category = text(filters.category)
      const records = await findManyWithinLimit(client.supplier, {
        where: {
          ...tenantWhere(filters),
          ...(text(filters.status) ? { status: text(filters.status) } : {}),
          // Filters run in the database, so a match beyond the row limit is still found.
          AND: [
            ...(query ? [{ OR: [{ code: { contains: query, mode: 'insensitive' } }, { name: { contains: query, mode: 'insensitive' } }] }] : []),
            // The column holds a supplier's first category; metadata lists all of them.
            ...(category ? [{ OR: [{ category }, { metadata: { path: ['categories'], array_contains: [category] } }] }] : []),
          ],
        },
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
