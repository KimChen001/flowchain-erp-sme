import {
  buildProcurementDocumentLinks,
  buildProcurementDocuments,
  buildProcurementFollowups,
  buildProcurementSummary,
  filterProcurementRows,
  getProcurementDocument,
  isProcurementDocumentType,
  normalizeProcurementDocumentType,
} from '../domain/procurement-read-model.mjs'
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

function firstLine(record = {}) {
  return asArray(record.lines)[0] || {}
}

function lineQuantity(lines = [], key, fallback = 0) {
  const total = asArray(lines).reduce((sum, line) => sum + numberFrom(line?.[key], 0), 0)
  return total || fallback
}

function tenantWhere(filters = {}) {
  return { tenantId: text(filters.tenantId, 'tenant-flowchain-sme') }
}

function safeLimit(value, fallback = 500) {
  return Math.min(500, Math.max(1, Number(value || fallback)))
}

function mapPurchaseRequest(record = {}) {
  const line = firstLine(record)
  const meta = metadata(record)
  const lines = asArray(record.lines).map((entry) => ({
    lineId: entry.id,
    id: entry.id,
    itemId: text(entry.itemId) || null,
    sku: text(entry.sku) || null,
    itemNameSnapshot: text(entry.itemName),
    itemName: text(entry.itemName),
    quantity: numberFrom(entry.quantity, 0),
    unitSnapshot: text(entry.unit) || null,
    unit: text(entry.unit),
    estimatedUnitPrice: numberFrom(entry.unitPrice, 0),
    unitPrice: numberFrom(entry.unitPrice, 0),
    estimatedAmount: numberFrom(entry.amount, 0),
    amount: numberFrom(entry.amount, 0),
    currency: text(record.currency, 'CNY'),
    metadata: metadata(entry),
  }))
  return {
    id: record.id,
    pr: record.id,
    version: numberFrom(meta.version, 0),
    requesterId: text(meta.requesterId || record.requester),
    departmentId: text(meta.departmentId),
    defaultCurrency: text(record.currency, 'CNY'),
    defaultNeedByDate: isoDate(record.requiredDate),
    totalAmount: numberFrom(record.amount, 0),
    lines,
    sourceSku: text(line.sku || meta.sku),
    sourceName: text(line.itemName || meta.itemName),
    itemId: text(line.itemId || meta.itemId),
    supplier: text(record.supplierName || meta.supplier),
    supplierId: text(record.supplierId),
    requester: text(record.requester),
    buyer: text(record.buyer),
    requiredDate: isoDate(record.requiredDate),
    quantity: numberFrom(line.quantity, numberFrom(meta.quantity, 0)),
    unit: text(line.unit || meta.unit),
    unitPrice: numberFrom(line.unitPrice, numberFrom(meta.unitPrice, 0)),
    amount: numberFrom(record.amount, numberFrom(line.amount, 0)),
    currency: text(record.currency, 'CNY'),
    status: text(record.status, 'draft'),
    priority: text(record.priority),
    linkedRfq: text(record.linkedRfqId),
    linkedPo: text(record.linkedPoId),
    source: text(record.source),
    reason: text(record.reason || meta.reason),
    createdAt: isoDate(record.createdAt),
    updatedAt: isoDate(record.updatedAt),
  }
}

function mapRfq(record = {}, quotations = []) {
  const line = firstLine(record)
  const meta = metadata(record)
  const quoteCount = quotations.filter((quote) => quote.rfqId === record.id).length
  return {
    id: record.id,
    title: text(record.title, record.id),
    category: text(record.category),
    status: text(record.status, 'active'),
    suppliers: numberFrom(record.supplierCount, quoteCount),
    quoted: numberFrom(record.respondedSupplierCount, quoteCount),
    due: isoDate(record.dueDate),
    bestPrice: numberFrom(record.bestPrice, 0),
    bestSupplier: text(record.awardedSupplier),
    supplierId: text(record.supplierId),
    sourceRequest: text(record.sourceRequestId),
    linkedPo: text(record.linkedPoId),
    sourceSku: text(line.sku || meta.sku),
    sourceName: text(line.itemName || meta.itemName),
    itemId: text(line.itemId || meta.itemId),
    quantity: numberFrom(line.quantity, numberFrom(meta.quantity, 0)),
    unit: text(line.unit || meta.unit),
    currency: text(record.currency, 'CNY'),
    createdAt: isoDate(record.createdAt),
    updatedAt: isoDate(record.updatedAt),
  }
}

function mapPurchaseOrder(record = {}) {
  const line = firstLine(record)
  const meta = metadata(record)
  const ordered = lineQuantity(record.lines, 'orderedQuantity', numberFrom(meta.orderedQuantity, 0))
  const received = lineQuantity(record.lines, 'receivedQuantity', numberFrom(meta.receivedQuantity, 0))
  return {
    id: record.id,
    po: record.id,
    orderNumber: text(meta.orderNumber, record.id),
    version: numberFrom(record.version, 0),
    supplier: text(record.supplierName || meta.supplier),
    supplierId: text(record.supplierId),
    eta: isoDate(record.expectedDate),
    owner: text(record.owner),
    amount: numberFrom(record.amount, lineQuantity(record.lines, 'amount', 0)),
    currency: text(record.currency, 'CNY'),
    items: ordered,
    received,
    totalOrderedQty: ordered,
    totalReceivedQty: received,
    status: text(record.status, 'draft'),
    priority: text(record.priority),
    sourceRequest: text(record.sourceRequestId),
    sourceRfq: text(record.sourceRfqId),
    sourceSku: text(line.sku || meta.sku),
    sourceName: text(line.itemName || meta.itemName),
    itemId: text(line.itemId || meta.itemId),
    lineCount: asArray(record.lines).length,
    lines: asArray(record.lines).map((entry) => ({
      poLineId: entry.id,
      id: entry.id,
      poId: record.id,
      itemId: text(entry.itemId),
      sku: text(entry.sku),
      itemName: text(entry.itemName),
      quantityOrdered: numberFrom(entry.orderedQuantity, 0),
      orderedQuantity: numberFrom(entry.orderedQuantity, 0),
      quantityReceived: numberFrom(entry.receivedQuantity, 0),
      receivedQuantity: numberFrom(entry.receivedQuantity, 0),
      unit: text(entry.unit),
      unitPrice: numberFrom(entry.unitPrice, 0),
      lineAmount: numberFrom(entry.amount, 0),
      amount: numberFrom(entry.amount, 0),
      currency: text(record.currency, 'CNY'),
      status: numberFrom(entry.receivedQuantity, 0) >= numberFrom(entry.orderedQuantity, 0) ? 'received' : 'open',
    })),
    createdAt: isoDate(record.createdAt),
    updatedAt: isoDate(record.updatedAt),
  }
}

function mapReceivingDocument(record = {}) {
  const meta = metadata(record)
  return {
    grn: record.id,
    po: text(record.poId),
    supplier: text(record.supplierName || meta.supplier),
    supplierId: text(record.supplierId),
    status: text(record.status, 'receiving'),
    arrived: isoDate(record.arrivedAt || record.createdAt),
    receiver: text(record.receiver),
    warehouse: text(record.warehouseId || meta.warehouse),
    items: lineQuantity(record.lines, 'acceptedQty', 0) + lineQuantity(record.lines, 'rejectedQty', 0),
    passed: lineQuantity(record.lines, 'acceptedQty', 0),
    failed: lineQuantity(record.lines, 'rejectedQty', 0),
    currency: text(record.currency, 'CNY'),
    createdAt: isoDate(record.createdAt),
    updatedAt: isoDate(record.updatedAt),
  }
}

function mapSupplierInvoice(record = {}) {
  const meta = metadata(record)
  return {
    invoiceNumber: record.id,
    supplier: text(record.supplierName || meta.supplier),
    supplierId: text(record.supplierId),
    relatedPo: text(record.relatedPoId),
    relatedGrn: text(record.relatedGrnId),
    invoiceDate: isoDate(record.invoiceDate),
    dueDate: isoDate(record.dueDate),
    amount: numberFrom(record.amount, lineQuantity(record.lines, 'amount', 0)),
    currency: text(record.currency, 'CNY'),
    status: text(record.status, 'pending'),
    matchStatus: text(record.matchStatus),
    varianceAmount: numberFrom(record.varianceAmount, 0),
    createdAt: isoDate(record.createdAt),
    updatedAt: isoDate(record.updatedAt),
  }
}

function mapDocumentLink(record = {}) {
  return {
    sourceType: normalizeProcurementDocumentType(record.sourceType),
    sourceId: text(record.sourceId),
    targetType: normalizeProcurementDocumentType(record.targetType),
    targetId: text(record.targetId),
    relationship: text(record.relationship),
    relation: text(record.relationship),
    label: text(metadata(record).label, `${text(record.sourceId)} -> ${text(record.targetId)}`),
    status: text(record.status),
  }
}

function mapFollowup(record = {}) {
  return {
    type: text(record.type),
    id: text(record.id),
    severity: text(record.severity, 'medium'),
    owner: text(record.owner),
    title: text(record.title),
    message: text(record.message),
    summary: text(record.message || record.title),
    status: text(record.status, 'open'),
    dueDate: isoDate(record.dueDate),
    supplierName: text(record.supplierName),
    supplierId: text(record.supplierId),
    documentType: normalizeProcurementDocumentType(record.documentType),
    documentId: text(record.documentId),
  }
}

async function loadProcurementSnapshot(client, filters = {}) {
  const where = tenantWhere(filters)
  const take = safeLimit(filters.limit)
  const [
    purchaseRequests,
    rfqs,
    supplierQuotations,
    purchaseOrders,
    receivingDocuments,
    supplierInvoices,
    documentLinks,
    procurementFollowups,
  ] = await Promise.all([
    client.purchaseRequest.findMany({ where, include: { lines: true }, orderBy: [{ createdAt: 'desc' }], take }),
    client.rfq.findMany({ where, include: { lines: true }, orderBy: [{ createdAt: 'desc' }], take }),
    client.supplierQuotation.findMany({ where, orderBy: [{ createdAt: 'desc' }], take }),
    client.purchaseOrder.findMany({ where, include: { lines: true }, orderBy: [{ createdAt: 'desc' }], take }),
    client.receivingDocument.findMany({ where, include: { lines: true }, orderBy: [{ createdAt: 'desc' }], take }),
    client.supplierInvoice.findMany({ where, include: { lines: true }, orderBy: [{ createdAt: 'desc' }], take }),
    client.documentLink.findMany({ where, orderBy: [{ createdAt: 'desc' }], take }),
    client.procurementFollowup.findMany({ where, orderBy: [{ createdAt: 'desc' }], take }),
  ])

  return {
    purchaseRequests: purchaseRequests.map(mapPurchaseRequest),
    rfqs: rfqs.map((rfq) => mapRfq(rfq, supplierQuotations)),
    purchaseOrders: purchaseOrders.map(mapPurchaseOrder),
    receivingDocs: receivingDocuments.map(mapReceivingDocument),
    supplierInvoices: supplierInvoices.map(mapSupplierInvoice),
    documentLinks: documentLinks.map(mapDocumentLink).filter((link) => link.sourceType && link.sourceId && link.targetType && link.targetId),
    procurementFollowups: procurementFollowups.map(mapFollowup).filter((item) => item.id && item.documentType && item.documentId),
  }
}

export function createDbProcurementReadRepository({ env = process.env, prisma } = {}) {
  return {
    mode: 'database',
    adapter: 'db-procurement-read-v1',
    snapshot: async (filters = {}) => {
      const client = await resolvePrisma({ env, prisma })
      return loadProcurementSnapshot(client, filters)
    },
    listDocuments: async (filters = {}) => {
      const client = await resolvePrisma({ env, prisma })
      const snapshot = await loadProcurementSnapshot(client, filters)
      return filterProcurementRows(buildProcurementDocuments(snapshot), filters)
    },
    getDocument: async (type, id, options = {}) => {
      const client = await resolvePrisma({ env, prisma })
      const snapshot = await loadProcurementSnapshot(client, options)
      return getProcurementDocument(snapshot, type, id)
    },
    listLinks: async (filters = {}) => {
      const client = await resolvePrisma({ env, prisma })
      const snapshot = await loadProcurementSnapshot(client, filters)
      return filterProcurementRows([
        ...buildProcurementDocumentLinks(snapshot),
        ...snapshot.documentLinks,
      ], filters)
    },
    listFollowups: async (filters = {}) => {
      const client = await resolvePrisma({ env, prisma })
      const snapshot = await loadProcurementSnapshot(client, filters)
      return filterProcurementRows([
        ...buildProcurementFollowups(snapshot),
        ...snapshot.procurementFollowups,
      ], filters)
    },
    getSummary: async (filters = {}) => {
      const client = await resolvePrisma({ env, prisma })
      const snapshot = await loadProcurementSnapshot(client, filters)
      const summary = buildProcurementSummary(snapshot)
      const explicitFollowups = snapshot.procurementFollowups.length
      return explicitFollowups ? { ...summary, followupCount: summary.followupCount + explicitFollowups } : summary
    },
    normalizeDocumentType: (type) => normalizeProcurementDocumentType(type),
    isDocumentType: (type) => isProcurementDocumentType(type),
  }
}
