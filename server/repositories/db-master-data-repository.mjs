import { getPrismaClient } from '../persistence/prisma-client.mjs'
import { validateDatabasePersistenceConfig } from '../persistence/persistence-config.mjs'

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
  return { tenantId: text(filters.tenantId, 'tenant-flowchain-sme') }
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
    defaultWarehouseId: meta.defaultWarehouseId || meta.warehouseId || 'WH-MAIN',
    preferredSupplierId: record.preferredSupplierId || meta.preferredSupplierId || '',
    defaultSupplierId: record.preferredSupplierId || meta.preferredSupplierId || '',
    preferredSupplierSource: record.preferredSupplierId ? 'matched_supplier_master' : meta.preferredSupplierSource || 'missing',
    leadTimeDays: numberFrom(meta.leadTimeDays ?? meta.leadTime, 0),
    purchaseLeadTimeDays: numberFrom(meta.purchaseLeadTimeDays ?? meta.leadTimeDays ?? meta.leadTime, 0),
    moq: numberFrom(meta.moq ?? meta.minimumOrderQuantity, 1),
    minimumOrderQuantity: numberFrom(meta.minimumOrderQuantity ?? meta.moq, 1),
    batchMultiple: numberFrom(meta.batchMultiple, 1),
    safetyStock: numberFrom(meta.safetyStock, 0),
    reorderPoint: numberFrom(meta.reorderPoint, 0),
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
    currency: text(payload.currency, 'CNY'),
    contact: text(payload.contact),
    phone: text(payload.phone),
    email: text(payload.email),
    address: text(payload.address),
    paymentTerms: text(payload.paymentTerms),
    creditStatus: text(payload.creditStatus, '正常'),
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
    listItems: async (filters = {}) => {
      const client = await resolvePrisma({ env, prisma })
      const records = await client.item.findMany({
        where: {
          ...tenantWhere(filters),
          ...(text(filters.status) ? { status: text(filters.status) } : {}),
        },
        orderBy: [{ sku: 'asc' }],
        take: safeLimit(filters.limit),
      })
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
      const records = await client.supplier.findMany({
        where: {
          ...tenantWhere(filters),
          ...(text(filters.status) ? { status: text(filters.status) } : {}),
        },
        orderBy: [{ name: 'asc' }],
        take: safeLimit(filters.limit),
      })
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
      return records.map(mapCustomer).filter((customer) =>
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
