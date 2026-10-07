const DEFAULT_TENANT_ID = 'tenant-flowchain-sme'

function asArray(value) {
  return Array.isArray(value) ? value : []
}

function text(value, fallback = '') {
  const next = String(value ?? '').trim()
  return next || fallback
}

function clone(value) {
  return JSON.parse(JSON.stringify(value ?? null))
}

function stableKey(value, fallback) {
  const key = text(value)
    .toUpperCase()
    .replace(/\s+/g, '-')
    .replace(/[^\w\u4e00-\u9fa5-]/g, '')
  return key || fallback
}

function supplierIdFor(supplier = {}, index = 0) {
  return text(supplier.id || supplier.supplierId, `SUP-${stableKey(supplier.name || supplier.code, String(index + 1).padStart(3, '0'))}`)
}

function itemIdFor(item = {}, index = 0) {
  return text(item.id || item.itemId || item.itemCode, `ITEM-${stableKey(item.sku || item.code || item.name, String(index + 1).padStart(3, '0'))}`)
}

function warehouseIdFor(warehouse = {}, index = 0) {
  return text(warehouse.id || warehouse.warehouseId, `WH-${stableKey(warehouse.name || warehouse.code, String(index + 1).padStart(3, '0'))}`)
}

function termIdFor(term = {}) {
  return text(term.id || term.paymentTermsId || term.code, 'NET30')
}

function taxCodeIdFor(code = {}) {
  return text(code.id || code.taxCodeId || code.code, 'TAX-STD')
}

function supplierKey(supplier = {}, index = 0) {
  return supplierIdFor(supplier, index).toLowerCase()
}

function supplierReferenceMap(suppliers = []) {
  const entries = new Map()
  asArray(suppliers).forEach((supplier, index) => {
    const id = supplierIdFor(supplier, index)
    for (const key of [id, supplier.id, supplier.supplierId, supplier.code, supplier.name, supplier.supplierName]) {
      const normalized = text(key).toLowerCase()
      if (normalized) entries.set(normalized, id)
    }
  })
  return entries
}

function collectUnresolvedItemSuppliers(db = {}) {
  const supplierKeys = new Set(asArray(db.suppliers).flatMap((supplier, index) => {
    const id = supplierIdFor(supplier, index)
    return [id, supplier.name, supplier.code, supplier.supplierName].map((item) => text(item).toLowerCase()).filter(Boolean)
  }))
  return asArray(db.products)
    .map((item) => text(item.preferredSupplierId || item.supplierId || item.preferredSupplier || item.supplier || item.supplierName))
    .filter(Boolean)
    .filter((supplier) => !supplierKeys.has(supplier.toLowerCase()))
}

export function buildMasterDataSeedPlan(db = {}, options = {}) {
  const source = clone(db) || {}
  const tenantId = text(options.tenantId, DEFAULT_TENANT_ID)
  const suppliers = asArray(source.suppliers)
  const items = asArray(source.products)
  const warehouses = asArray(source.warehouses)
  const paymentTerms = asArray(source.paymentTerms)
  const taxCodes = asArray(source.taxCodes)
  const unresolvedSuppliers = [...new Set(collectUnresolvedItemSuppliers(source))]

  return {
    dryRun: options.dryRun !== false,
    tenantId,
    seedOrder: ['Tenant', 'PaymentTerm', 'TaxCode', 'Supplier', 'Warehouse', 'Item'],
    counts: {
      tenants: 1,
      paymentTerms: paymentTerms.length || 1,
      taxCodes: taxCodes.length || 1,
      suppliers: suppliers.length,
      warehouses: warehouses.length,
      items: items.length,
    },
    samples: {
      suppliers: suppliers.slice(0, 3).map((supplier, index) => ({ id: supplierIdFor(supplier, index), name: text(supplier.name || supplier.supplierName) })),
      items: items.slice(0, 3).map((item, index) => ({ id: itemIdFor(item, index), sku: text(item.sku || item.code || item.id) })),
      warehouses: warehouses.slice(0, 3).map((warehouse, index) => ({ id: warehouseIdFor(warehouse, index), name: text(warehouse.name || warehouse.label) })),
      paymentTerms: (paymentTerms.length ? paymentTerms : [{ id: 'NET30', label: 'Net 30' }]).slice(0, 3).map((term) => ({ id: termIdFor(term), label: text(term.label || term.name || term.id) })),
      taxCodes: (taxCodes.length ? taxCodes : [{ id: 'TAX-STD', label: 'Standard Tax' }]).slice(0, 3).map((code) => ({ id: taxCodeIdFor(code), label: text(code.label || code.name || code.id) })),
    },
    unresolvedReferences: {
      itemPreferredSuppliers: unresolvedSuppliers,
    },
    skippedEntityGroups: ['procurementDocuments', 'inventoryBalancesAndMovements', 'supplierInvoices', 'threeWayMatches', 'actionDrafts', 'auditHistory'],
    mutatesSource: false,
  }
}

export function buildMasterDataSeedRows(db = {}, options = {}) {
  const source = clone(db) || {}
  const tenantId = text(options.tenantId, DEFAULT_TENANT_ID)
  const suppliers = asArray(source.suppliers).map((supplier, index) => ({
    id: supplierIdFor(supplier, index),
    tenantId,
    code: text(supplier.code || supplier.supplierCode || supplier.id || supplierIdFor(supplier, index)),
    name: text(supplier.name || supplier.supplierName, supplierIdFor(supplier, index)),
    category: text(supplier.category),
    status: text(supplier.status, 'active'),
    riskLevel: text(supplier.riskLevel || supplier.risk),
    // Only a recorded score; an on-time rate is not a score.
    score: supplier.score ?? null,
    metadata: {
      defaultCurrency: text(supplier.defaultCurrency || supplier.currency, text(options.currency, 'USD')),
      paymentTermsId: text(supplier.paymentTermsId || supplier.paymentTerms, 'NET30'),
      preferred: Boolean(supplier.preferred),
      sourceKey: supplierKey(supplier, index),
    },
  }))
  const supplierRefs = supplierReferenceMap(suppliers)
  const paymentTerms = (asArray(source.paymentTerms).length ? asArray(source.paymentTerms) : [{ id: 'NET30', label: 'Net 30', days: 30 }]).map((term) => ({
    id: termIdFor(term),
    tenantId,
    code: text(term.code || term.id || term.paymentTermsId, termIdFor(term)),
    name: text(term.name || term.label || term.id, termIdFor(term)),
    days: Number.isFinite(Number(term.days)) ? Number(term.days) : 30,
    metadata: { sourceType: 'seed' },
  }))
  const taxCodes = (asArray(source.taxCodes).length ? asArray(source.taxCodes) : [{ id: 'TAX-STD', label: 'Standard Tax', rate: 0 }]).map((code) => ({
    id: taxCodeIdFor(code),
    tenantId,
    code: text(code.code || code.id || code.taxCodeId, taxCodeIdFor(code)),
    name: text(code.name || code.label || code.id, taxCodeIdFor(code)),
    rate: Number.isFinite(Number(code.rate)) ? Number(code.rate) : 0,
    taxType: text(code.taxType || code.type),
    region: text(code.region),
    metadata: { sourceType: 'seed' },
  }))
  const warehouses = asArray(source.warehouses).map((warehouse, index) => ({
    id: warehouseIdFor(warehouse, index),
    tenantId,
    code: text(warehouse.code || warehouse.id || warehouse.warehouseId, warehouseIdFor(warehouse, index)),
    name: text(warehouse.name || warehouse.label, warehouseIdFor(warehouse, index)),
    status: text(warehouse.status, 'active'),
    metadata: { type: text(warehouse.type, 'warehouse'), sourceType: 'seed' },
  }))
  const items = asArray(source.products).map((item, index) => {
    const supplierRef = text(item.preferredSupplierId || item.supplierId || item.preferredSupplier || item.supplier || item.supplierName).toLowerCase()
    return {
      id: itemIdFor(item, index),
      tenantId,
      sku: text(item.sku || item.code || item.id, itemIdFor(item, index)),
      name: text(item.name || item.itemName, itemIdFor(item, index)),
      category: text(item.category),
      unit: text(item.unit || item.uom || item.baseUom, 'pcs'),
      preferredSupplierId: supplierRefs.get(supplierRef) || null,
      status: text(item.status, 'active'),
      safetyStock: item.safetyStock ?? item.minStock ?? null,
      reorderPoint: item.reorderPoint ?? item.rop ?? null,
      metadata: {
        defaultWarehouseId: text(item.defaultWarehouseId || item.warehouseId || item.warehouse),
        leadTimeDays: item.leadTimeDays ?? item.leadTime ?? null,
        moq: item.moq ?? item.minimumOrderQuantity ?? null,
        supplierReference: supplierRef || null,
      },
    }
  })

  return {
    tenant: {
      id: tenantId,
      name: text(options.tenantName, 'FlowChain SME Workspace Tenant'),
      countryCode: text(options.countryCode, 'US'),
      locale: text(options.locale, 'en-US'),
      currency: text(options.currency, 'USD'),
      timezone: text(options.timezone, 'America/New_York'),
    },
    paymentTerms,
    taxCodes,
    suppliers,
    warehouses,
    items,
  }
}
