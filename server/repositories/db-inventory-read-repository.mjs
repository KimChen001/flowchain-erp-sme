import {
  buildInventoryExceptions,
  buildInventoryItems,
  buildInventoryLots,
  buildInventoryMovements,
  buildInventorySerials,
  buildInventorySummary,
  filterInventoryRows,
  getInventoryItemBySku,
} from '../domain/inventory-read.mjs'
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

function asArray(value) {
  return Array.isArray(value) ? value : []
}

function numberFrom(value, fallback = 0) {
  if (value === null || value === undefined || value === '') return fallback
  if (typeof value?.toNumber === 'function') return value.toNumber()
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function isoDate(value) {
  if (!value) return ''
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime()) ? text(value) : date.toISOString().slice(0, 10)
}

function metadata(record = {}) {
  return record.metadata && typeof record.metadata === 'object' && !Array.isArray(record.metadata)
    ? record.metadata
    : {}
}

function tenantWhere(filters = {}) {
  return { tenantId: text(filters.tenantId, 'tenant-flowchain-sme') }
}

function safeLimit(value, fallback = 500) {
  return Math.min(500, Math.max(1, Number(value || fallback)))
}

function mapBalance(record = {}) {
  const meta = metadata(record)
  return {
    sku: text(record.sku),
    id: text(record.itemId || record.sku),
    itemId: text(record.itemId || record.sku),
    name: text(record.itemName || meta.itemName || record.sku),
    itemName: text(record.itemName || meta.itemName || record.sku),
    category: text(meta.category),
    supplier: text(meta.supplier || meta.supplierName || meta.preferredSupplierId),
    defaultWarehouseId: text(record.warehouseId || meta.defaultWarehouseId),
    warehouseId: text(record.warehouseId),
    location: text(record.location || meta.location),
    availableQuantity: numberFrom(record.availableQuantity, 0),
    onHandQuantity: numberFrom(record.onHandQuantity, numberFrom(record.availableQuantity, 0)),
    reservedQuantity: numberFrom(record.reservedQuantity, 0),
    safetyStock: numberFrom(record.safetyStock, 0),
    reorderPoint: numberFrom(record.reorderPoint, numberFrom(record.safetyStock, 0)),
    status: text(record.status || meta.status),
    riskLevel: text(record.riskLevel || meta.riskLevel),
    riskReason: text(meta.riskReason || record.riskLevel),
    unit: text(record.unit || meta.unit || meta.uom),
    updatedAt: isoDate(record.updatedAt),
  }
}

function mapItemWithoutBalance(record = {}) {
  const meta = metadata(record)
  return {
    sku: text(record.sku),
    id: text(record.id || record.sku),
    itemId: text(record.id || record.sku),
    name: text(record.name || record.sku),
    itemName: text(record.name || record.sku),
    category: text(record.category || meta.category),
    supplier: text(meta.supplier || meta.supplierName || record.preferredSupplierId),
    defaultWarehouseId: text(meta.defaultWarehouseId || meta.warehouseId),
    location: text(meta.location),
    availableQuantity: numberFrom(meta.availableQuantity ?? meta.currentStock, 0),
    onHandQuantity: numberFrom(meta.onHandQuantity, numberFrom(meta.availableQuantity ?? meta.currentStock, 0)),
    reservedQuantity: numberFrom(meta.reservedQuantity, 0),
    safetyStock: numberFrom(record.safetyStock ?? meta.safetyStock, 0),
    reorderPoint: numberFrom(record.reorderPoint ?? meta.reorderPoint, 0),
    status: text(record.status || meta.status),
    riskLevel: text(meta.riskLevel),
    riskReason: text(meta.riskReason),
    unit: text(record.unit || meta.unit || meta.uom),
    updatedAt: isoDate(record.updatedAt),
  }
}

function mapLot(record = {}) {
  return {
    lot: text(record.id),
    sku: text(record.sku),
    itemName: text(record.itemName),
    warehouse: text(record.warehouseId),
    location: text(record.location || record.warehouseId),
    quantity: numberFrom(record.quantity, 0),
    qaStatus: text(record.qaStatus),
    expiryDate: isoDate(record.expiryDate),
    supplier: text(record.supplierName || metadata(record).supplier),
    sourceDocument: text(record.sourceDocument),
    status: text(record.status, 'available'),
  }
}

function mapSerial(record = {}) {
  return {
    serialId: text(record.id),
    sku: text(record.sku),
    itemName: text(record.itemName),
    warehouseId: text(record.warehouseId),
    location: text(record.location || record.warehouseId),
    status: text(record.status, 'in_stock'),
    owner: text(record.owner),
    sourceDocument: text(record.sourceDocument),
    updatedAt: isoDate(record.updatedAt),
  }
}

function mapMovement(record = {}) {
  return {
    movementId: text(record.id),
    movementType: text(record.movementType),
    movementLabel: text(record.movementLabel || record.movementType),
    date: isoDate(record.movementDate || record.createdAt),
    sku: text(record.sku),
    itemName: text(record.itemName),
    warehouse: text(record.warehouseId),
    location: text(record.location || record.warehouseId),
    sourceDocument: text(record.sourceDocument),
    quantityIn: numberFrom(record.quantityIn, 0),
    quantityOut: numberFrom(record.quantityOut, 0),
    adjustmentQty: numberFrom(record.adjustmentQty, 0),
    status: text(record.status, 'registered'),
    owner: text(record.owner),
    unit: text(record.unit),
    relatedPo: text(record.relatedPoId),
    relatedGrn: text(record.relatedGrnId),
    relatedReturn: text(record.relatedReturnId),
    relatedSalesOrder: text(record.relatedSalesOrderId),
    inventoryImpact: text(record.inventoryImpact),
    reason: text(record.reason),
    evidence: asArray(record.evidence),
    timeline: asArray(record.timeline),
  }
}

function mapException(record = {}) {
  return {
    id: text(record.id),
    type: text(record.type, 'inventory_exception'),
    sku: text(record.sku),
    itemName: text(record.itemName),
    warehouse: text(record.warehouseId),
    location: text(record.location || record.warehouseId),
    quantityImpact: numberFrom(record.quantityImpact, 0),
    unit: text(record.unit),
    status: text(record.status, 'open'),
    owner: text(record.owner),
    linkedMovement: text(record.linkedMovementId),
    linkedDocument: text(record.linkedDocument),
    nextAction: text(record.nextAction),
    reason: text(record.reason),
  }
}

async function loadInventorySnapshot(client, filters = {}) {
  const where = tenantWhere(filters)
  const take = safeLimit(filters.limit)
  const [items, balances, lots, serials, movements, exceptions] = await Promise.all([
    client.item.findMany({ where, orderBy: [{ sku: 'asc' }], take }),
    client.inventoryBalance.findMany({ where, orderBy: [{ sku: 'asc' }], take }),
    client.inventoryLot.findMany({ where, orderBy: [{ updatedAt: 'desc' }], take }),
    client.inventorySerial.findMany({ where, orderBy: [{ updatedAt: 'desc' }], take }),
    client.inventoryMovement.findMany({ where, orderBy: [{ movementDate: 'desc' }, { createdAt: 'desc' }], take }),
    client.inventoryException.findMany({ where, orderBy: [{ updatedAt: 'desc' }], take }),
  ])
  const balanceSkus = new Set(balances.map((item) => text(item.sku).toLowerCase()).filter(Boolean))
  return {
    products: [
      ...balances.map(mapBalance),
      ...items.filter((item) => !balanceSkus.has(text(item.sku).toLowerCase())).map(mapItemWithoutBalance),
    ],
    inventoryLots: lots.map(mapLot),
    inventorySerials: serials.map(mapSerial),
    inventoryMovements: movements.map(mapMovement),
    inventoryExceptions: exceptions.map(mapException),
  }
}

export function createDbInventoryReadRepository({ env = process.env, prisma } = {}) {
  return {
    mode: 'database',
    adapter: 'db-inventory-read-v1',
    listItems: async (filters = {}) => {
      const client = await resolvePrisma({ env, prisma })
      const snapshot = await loadInventorySnapshot(client, filters)
      return filterInventoryRows(buildInventoryItems(snapshot), filters)
    },
    listInventoryItems: async (filters = {}) => {
      const client = await resolvePrisma({ env, prisma })
      const snapshot = await loadInventorySnapshot(client, filters)
      return filterInventoryRows(buildInventoryItems(snapshot), filters)
    },
    getItem: async (idOrSku = '', options = {}) => {
      const client = await resolvePrisma({ env, prisma })
      const snapshot = await loadInventorySnapshot(client, options)
      return getInventoryItemBySku(snapshot, idOrSku)
    },
    getInventoryItem: async (idOrSku = '', options = {}) => {
      const client = await resolvePrisma({ env, prisma })
      const snapshot = await loadInventorySnapshot(client, options)
      return getInventoryItemBySku(snapshot, idOrSku)
    },
    listLots: async (filters = {}) => {
      const client = await resolvePrisma({ env, prisma })
      const snapshot = await loadInventorySnapshot(client, filters)
      return filterInventoryRows(buildInventoryLots(snapshot), filters)
    },
    listSerials: async (filters = {}) => {
      const client = await resolvePrisma({ env, prisma })
      const snapshot = await loadInventorySnapshot(client, filters)
      return filterInventoryRows(buildInventorySerials(snapshot), filters)
    },
    listMovements: async (filters = {}) => {
      const client = await resolvePrisma({ env, prisma })
      const snapshot = await loadInventorySnapshot(client, filters)
      return filterInventoryRows(buildInventoryMovements(snapshot), filters)
    },
    listExceptions: async (filters = {}) => {
      const client = await resolvePrisma({ env, prisma })
      const snapshot = await loadInventorySnapshot(client, filters)
      return filterInventoryRows(buildInventoryExceptions(snapshot), filters)
    },
    getSummary: async (filters = {}) => {
      const client = await resolvePrisma({ env, prisma })
      const snapshot = await loadInventorySnapshot(client, filters)
      return buildInventorySummary(snapshot)
    },
  }
}
