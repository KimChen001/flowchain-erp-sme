import { maskProcurementDocuments, maskProcurementSummary, readableProcurementRows, readableProcurementSnapshot } from '../domain/procurement-read-access.mjs'
import {
  buildProcurementDocumentLinks,
  buildProcurementDocuments,
  buildProcurementFollowups,
  buildProcurementPurchaseOrders,
  buildProcurementPurchaseRequests,
  buildProcurementReceivingDocs,
  buildProcurementRfqs,
  buildProcurementSummary,
  buildProcurementSupplierInvoices,
  buildProcurementThreeWayMatches,
  filterProcurementRows,
  isProcurementDocumentType,
  normalizeProcurementDocumentType,
} from '../domain/procurement-read-model.mjs'
import { normalizeProcurementAuthorityStatus } from '../domain/procurement-status-authority.mjs'
import { exactRfqDecimalString } from '../domain/rfq-commercial-decimal.mjs'
import { escapeLikePattern } from '../persistence/like-pattern.mjs'
import { getPrismaClient } from '../persistence/prisma-client.mjs'
import { validateDatabasePersistenceConfig } from '../persistence/persistence-config.mjs'
import { requireTenantId } from './repository-read-scope.mjs'

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

function nullableNumber(value) {
  if (value === null || value === undefined || value === '') return null
  if (typeof value?.toNumber === 'function') return value.toNumber()
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function isoDate(value) {
  if (!value) return ''
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime()) ? text(value) : date.toISOString().slice(0, 10)
}

function isoDateTime(value) {
  if (!value) return ''
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime()) ? text(value) : date.toISOString()
}

function canonicalStatus(domain, value) {
  const raw = text(value)
  if (!raw) return null
  try {
    return normalizeProcurementAuthorityStatus(domain, raw)
  } catch {
    return null
  }
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
  return { tenantId: requireTenantId(filters) }
}

function safeLimit(value, fallback = 500) {
  return Math.min(500, Math.max(1, Number(value || fallback)))
}

function decodeDocumentId(value) {
  const encoded = text(value)
  if (!encoded) return ''
  try {
    return decodeURIComponent(encoded)
  } catch {
    return ''
  }
}

// Case-insensitive equals is an ILIKE in PostgreSQL, so an unescaped "%" in the
// id would open whichever document came first.
function documentWhere(tenantId, id) {
  return {
    tenantId,
    id: {
      equals: escapeLikePattern(id),
      mode: 'insensitive',
    },
  }
}

export function mapPurchaseRequest(record = {}) {
  const line = firstLine(record)
  const meta = metadata(record)
  const lines = asArray(record.lines).map((entry) => {
    const lineMeta = metadata(entry)
    return {
      lineId: entry.id,
      id: entry.id,
      sourceType: text(lineMeta.sourceType, entry.itemId ? 'catalog_item' : 'non_catalog_item'),
      lineBasis: text(lineMeta.lineBasis, 'quantity'),
      itemId: text(entry.itemId) || null,
      sku: text(entry.sku) || null,
      itemNameSnapshot: text(entry.itemName),
      itemName: text(entry.itemName),
      specificationSnapshot: text(lineMeta.specificationSnapshot),
      commodityId: text(lineMeta.commodityId),
      quantity: numberFrom(entry.quantity, 0),
      unitSnapshot: text(entry.unit) || null,
      unit: text(entry.unit),
      estimatedUnitPrice: numberFrom(entry.unitPrice, 0),
      unitPrice: numberFrom(entry.unitPrice, 0),
      estimatedAmount: numberFrom(entry.amount, 0),
      amount: numberFrom(entry.amount, 0),
      currency: text(lineMeta.currency, text(record.currency)),
      supplierId: text(lineMeta.supplierId) || null,
      supplierSnapshot: lineMeta.supplierSnapshot || null,
      targetWarehouseId: text(lineMeta.targetWarehouseId || lineMeta.warehouseId),
      needByDate: text(lineMeta.needByDate),
      serviceStartDate: text(lineMeta.serviceStartDate),
      serviceEndDate: text(lineMeta.serviceEndDate),
      internalLineComment: text(lineMeta.internalLineComment),
      // Why a supplier other than the item's preferred one was chosen, or null.
      supplierOverride: lineMeta.supplierOverride || null,
      metadata: lineMeta,
    }
  })
  return {
    id: record.id,
    pr: record.id,
    version: numberFrom(meta.version, 0),
    requesterId: text(meta.requesterId || record.requester),
    departmentId: text(meta.departmentId),
    defaultCurrency: text(record.currency),
    defaultNeedByDate: isoDate(record.requiredDate),
    // A PR whose lines use different currencies has no single total.
    totalAmount: nullableNumber(record.amount),
    procurementPath: text(meta.procurementPath, 'undecided'),
    linkedPurchaseOrderIds: asArray(meta.linkedPurchaseOrderIds),
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
    currency: text(record.currency),
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

export function mapRfq(record = {}, quotations = []) {
  const line = firstLine(record)
  const meta = metadata(record)
  const quoteCount = quotations.filter((quote) => quote.rfqId === record.id).length
  return {
    id: record.id,
    version: numberFrom(meta.version, 0),
    title: text(record.title, record.id),
    category: text(record.category),
    status: canonicalStatus('rfq', record.status) || text(record.status, 'active'),
    suppliers: numberFrom(record.supplierCount, quoteCount),
    quoted: numberFrom(record.respondedSupplierCount, quoteCount),
    due: isoDate(record.dueDate),
    bestPrice: numberFrom(record.bestPrice, 0),
    bestSupplier: text(record.awardedSupplier),
    supplierId: text(record.supplierId),
    sourceRequest: text(record.sourceRequestId),
    sourcePrId: text(record.sourceRequestId),
    linkedPo: text(record.linkedPoId),
    sourceSku: text(line.sku || meta.sku),
    sourceName: text(line.itemName || meta.itemName),
    itemId: text(line.itemId || meta.itemId),
    quantity: numberFrom(line.quantity, numberFrom(meta.quantity, 0)),
    unit: text(line.unit || meta.unit),
    currency: text(record.currency),
    createdAt: isoDate(record.createdAt),
    updatedAt: isoDate(record.updatedAt),
  }
}

function mapRfqDetail(record = {}, quotations = [], participations = []) {
  const base = buildProcurementRfqs({ rfqs: [mapRfq(record, quotations)] })[0] || null
  if (!base) return null

  const recordMeta = metadata(record)
  const lines = asArray(record.lines).map((entry) => {
    const lineMeta = metadata(entry)
    return {
      id: entry.id,
      itemId: text(entry.itemId) || null,
      sku: text(entry.sku) || null,
      itemName: text(entry.itemName) || null,
      quantity: nullableNumber(entry.quantity),
      unit: text(entry.unit) || null,
      targetUnitPrice: nullableNumber(lineMeta.targetUnitPrice ?? lineMeta.referencePrice ?? lineMeta.targetPrice),
      requiredDate: isoDate(lineMeta.requiredDate ?? lineMeta.requiredByDate),
      deliveryLocation: text(lineMeta.deliveryLocation ?? lineMeta.warehouseId ?? lineMeta.warehouseReference) || null,
    }
  })

  const quotationDetails = asArray(quotations).map((quotation) => {
    const revisions = asArray(quotation.revisions)
      .map((revision) => {
        const revisionMeta = metadata(revision)
        return {
          id: revision.id,
          revisionNumber: numberFrom(revision.revisionNumber, 0),
          status: canonicalStatus('supplierQuotationRevision', revision.status),
          statusRaw: text(revision.status) || null,
          currency: text(revision.currency, text(record.currency)),
          quotedAmount: exactRfqDecimalString(revision.quotedAmount),
          submittedAt: isoDateTime(revision.submittedAt),
          deliveryDate: isoDate(revision.deliveryDate ?? revisionMeta.deliveryDate ?? revisionMeta.promisedDate),
          paymentTerms: text(revision.paymentTerms ?? revisionMeta.paymentTerms) || null,
          validity: isoDate(revision.validUntil) || text(revisionMeta.validity ?? revisionMeta.validUntil) || null,
          source: text(revision.source),
          createdByActorId: text(revision.createdByActorId) || null,
          createdAt: isoDateTime(revision.createdAt),
          lines: asArray(revision.lines).map((line) => ({
            id: line.id,
            rfqLineId: text(line.rfqLineId) || null,
            sourceQuotationLineId: text(line.sourceQuotationLineId) || null,
            itemId: text(line.itemId) || null,
            sku: text(line.skuSnapshot) || null,
            itemName: text(line.itemNameSnapshot) || null,
            quantity: exactRfqDecimalString(line.quantity),
            unit: text(line.unit) || null,
            unitPrice: exactRfqDecimalString(line.unitPrice),
            amount: exactRfqDecimalString(line.amount),
            deliveryDate: isoDate(line.deliveryDate),
          })),
          isLatest: false,
        }
      })
      .sort((left, right) => right.revisionNumber - left.revisionNumber
        || right.createdAt.localeCompare(left.createdAt)
        || right.id.localeCompare(left.id))
    const latestRevision = revisions[0] || null
    if (latestRevision) latestRevision.isLatest = true
    return {
      id: quotation.id,
      supplierId: text(quotation.supplierId) || null,
      supplierName: text(quotation.supplierName) || null,
      authorityState: latestRevision ? 'revision_authoritative' : 'revision_missing',
      status: latestRevision?.status ?? null,
      statusRaw: latestRevision?.statusRaw ?? null,
      quotedAmount: latestRevision?.quotedAmount ?? null,
      currency: latestRevision?.currency ?? null,
      submittedAt: latestRevision?.submittedAt ?? '',
      deliveryDate: latestRevision?.deliveryDate ?? '',
      paymentTerms: latestRevision?.paymentTerms ?? null,
      validity: latestRevision?.validity ?? null,
      revisionNumber: latestRevision?.revisionNumber ?? null,
      isLatest: latestRevision ? true : null,
      lines: latestRevision?.lines ?? [],
      latestRevision,
      revisions,
      historicalRevisions: revisions.slice(1),
    }
  })

  const participantsById = new Map()
  const quotationOnlySupplierIds = new Set()
  const quotationSupplierIds = new Set(quotationDetails.map((quotation) => quotation.supplierId).filter(Boolean))
  for (const participation of asArray(participations)) {
    const supplierId = text(participation.supplierId)
    if (!supplierId) continue
    const status = canonicalStatus('rfqSupplierParticipation', participation.status)
    const hasQuotation = quotationSupplierIds.has(supplierId)
    const responseState = status === 'declined'
      ? 'declined'
      : status === 'withdrawn'
        ? 'withdrawn'
        : status === 'response_recorded' || hasQuotation
          ? 'response_recorded'
          : 'no_response'
    participantsById.set(supplierId, {
      participationId: participation.id,
      supplierId,
      supplierName: text(participation.supplier?.name) || null,
      status,
      statusRaw: text(participation.status) || null,
      participationState: status || 'unknown',
      responseState,
      invitedAt: isoDateTime(participation.invitedAt),
      respondedAt: isoDateTime(participation.respondedAt),
      withdrawnAt: isoDateTime(participation.withdrawnAt),
      authoritySource: 'participation',
      quotationIds: quotationDetails.filter((quotation) => quotation.supplierId === supplierId).map((quotation) => quotation.id),
    })
  }
  for (const quotation of quotationDetails) {
    if (!quotation.supplierId || participantsById.has(quotation.supplierId)) continue
    quotationOnlySupplierIds.add(quotation.supplierId)
    participantsById.set(quotation.supplierId, {
      participationId: null,
      supplierId: quotation.supplierId,
      supplierName: quotation.supplierName,
      status: null,
      statusRaw: null,
      participationState: 'quotation_recorded',
      responseState: 'response_recorded',
      invitedAt: '',
      respondedAt: quotation.submittedAt,
      withdrawnAt: '',
      authoritySource: 'quotation',
      quotationIds: [quotation.id],
    })
  }
  const knownParticipants = [...participantsById.values()]
  const invitedInternalCount = asArray(participations).filter((participation) => {
    const status = canonicalStatus('rfqSupplierParticipation', participation.status)
    return Boolean(isoDateTime(participation.invitedAt)) || status === 'invited_internal'
  }).length
  const responseRecordedCount = knownParticipants.filter((participant) => participant.responseState === 'response_recorded').length
  const noResponseCount = knownParticipants.filter((participant) => participant.responseState === 'no_response').length

  const relatedEvidence = [
    { type: 'rfq', id: record.id, label: text(record.title, record.id), relation: 'canonical_record' },
    ...(record.sourceRequestId ? [{ type: 'pr', id: record.sourceRequestId, label: record.sourceRequestId, relation: 'source_request' }] : []),
    ...(record.linkedPoId ? [{ type: 'po', id: record.linkedPoId, label: record.linkedPoId, relation: 'linked_po' }] : []),
    ...quotationDetails.map((quotation) => ({ type: 'supplier_quotation', id: quotation.id, label: quotation.id, relation: 'quotation' })),
  ]

  const limitations = [
    'RFQ Supplier Participation 仅表达内部采购参与事实；invited_internal 不证明邮件送达、Supplier Portal 身份或外部登录。',
    '报价 latest authority 仅由最大 revisionNumber 决定；模型不维护 isLatest 标志或 current revision 指针。',
    'Supplier Response 与 Append Revision HTTP 写入仅可通过内部授权命令内核；当前 RFQ 页面仍保持只读。',
  ]
  if (recordMeta.requesterId || recordMeta.owner) limitations.push('当前读取 contract 没有 RFQ owner/requester 的独立权限字段。')
  if (!canonicalStatus('rfq', record.status)) limitations.push('RFQ 状态不是当前状态目录的 canonical 值，已按不可用状态返回。')
  if (quotationOnlySupplierIds.size > 0) limitations.push('存在报价但缺少 RFQ Supplier Participation 的兼容记录；参与事实仍需后续内部命令补齐。')
  if (quotationDetails.some((quotation) => quotation.authorityState === 'revision_missing')) limitations.push('存在没有 Revision 的兼容报价聚合；其旧表头商业字段不是当前报价权威，已按不可用返回。')

  return {
    ...base,
    status: canonicalStatus('rfq', record.status),
    statusRaw: text(record.status) || null,
    description: text(recordMeta.description) || null,
    lines,
    suppliers: {
      participantCount: knownParticipants.length,
      responseRecordedCount,
      noResponseCount,
      invitedInternalCount,
      knownParticipants,
      participationAuthority: 'authoritative',
      invitationDeliveryAuthority: 'unavailable',
      externalSupplierIdentityAuthority: 'unavailable',
    },
    quotations: quotationDetails,
    relatedEvidence,
    revisionAuthority: {
      available: true,
      immutable: true,
      latestRule: 'maximum_revision_number',
    },
    limitations,
  }
}

export function mapPurchaseOrder(record = {}) {
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
    expectedDeliveryDate: isoDate(record.expectedDate),
    owner: text(record.owner),
    amount: numberFrom(record.amount, lineQuantity(record.lines, 'amount', 0)),
    subtotal: numberFrom(meta.subtotal, numberFrom(record.amount, lineQuantity(record.lines, 'amount', 0))),
    taxAmount: numberFrom(meta.taxAmount, 0),
    totalAmount: numberFrom(meta.totalAmount, numberFrom(record.amount, lineQuantity(record.lines, 'amount', 0))),
    currency: text(record.currency),
    items: ordered,
    received,
    totalOrderedQty: ordered,
    totalReceivedQty: received,
    status: text(record.status, 'draft'),
    transmissionStatus: text(meta.transmissionStatus, record.status === 'draft' ? 'not_sent' : 'sent'),
    // The instant the PO was issued to the supplier; null when it was not
    // recorded. Pages show it as a workspace day.
    issuedAt: record.issuedAt ? isoDateTime(record.issuedAt) : null,
    // "approved" when the PO was received without being issued in FlowChain.
    receivingBaseStatus: text(record.receivingBaseStatus) || null,
    priority: text(record.priority),
    sourceRequest: text(record.sourceRequestId),
    sourceRfq: text(record.sourceRfqId),
    sourceSku: text(line.sku || meta.sku),
    sourceName: text(line.itemName || meta.itemName),
    itemId: text(line.itemId || meta.itemId),
    lineCount: asArray(record.lines).length,
    warehouseId: text(meta.targetWarehouseId || meta.warehouseId),
    targetWarehouseId: text(meta.targetWarehouseId || meta.warehouseId),
    lines: asArray(record.lines).map((entry) => ({
      ...metadata(entry),
      poLineId: entry.id,
      id: entry.id,
      poId: record.id,
      itemId: text(entry.itemId),
      sku: text(entry.sku),
      itemName: text(entry.itemName),
      itemNameSnapshot: text(entry.itemName),
      specification: text(metadata(entry).specification),
      quantityOrdered: numberFrom(entry.orderedQuantity, 0),
      orderedQuantity: numberFrom(entry.orderedQuantity, 0),
      quantityReceived: numberFrom(entry.receivedQuantity, 0),
      receivedQuantity: numberFrom(entry.receivedQuantity, 0),
      unit: text(entry.unit),
      unitPrice: numberFrom(entry.unitPrice, 0),
      lineAmount: numberFrom(entry.amount, 0),
      amount: numberFrom(entry.amount, 0),
      currency: text(record.currency),
      warehouseId: text(metadata(entry).targetWarehouseId || metadata(entry).warehouseId),
      targetWarehouseId: text(metadata(entry).targetWarehouseId || metadata(entry).warehouseId),
      requiredDate: isoDate(metadata(entry).requestedDate || metadata(entry).requiredDate),
      requestedDate: isoDate(metadata(entry).requestedDate || metadata(entry).requiredDate),
      promisedDate: isoDate(metadata(entry).promisedDate || record.expectedDate),
      // Null when the original promise was not recorded (lines issued before it was kept).
      originalPromisedDate: entry.originalPromisedDate ? isoDate(entry.originalPromisedDate) : null,
      status: numberFrom(entry.receivedQuantity, 0) >= numberFrom(entry.orderedQuantity, 0) ? 'received' : 'open',
    })),
    created: isoDate(record.createdAt),
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
    workflowStatus: text(record.workflowStatus),
    postingStatus: text(record.postingStatus),
    arrived: isoDate(record.arrivedAt || record.createdAt),
    receiver: text(record.receiver),
    warehouse: text(record.warehouseId || meta.warehouse),
    items: lineQuantity(record.lines, 'acceptedQty', 0) + lineQuantity(record.lines, 'rejectedQty', 0),
    passed: lineQuantity(record.lines, 'acceptedQty', 0),
    failed: lineQuantity(record.lines, 'rejectedQty', 0),
    currency: text(record.currency),
    lines: asArray(record.lines).map((entry) => ({
      ...metadata(entry),
      grnLineId: entry.id,
      id: entry.id,
      poLineId: text(entry.purchaseOrderLineId),
      poId: text(record.poId),
      sku: text(entry.sku),
      itemName: text(entry.itemName),
      receivedQty: numberFrom(entry.acceptedQty, 0) + numberFrom(entry.rejectedQty, 0),
      acceptedQty: numberFrom(entry.acceptedQty, 0),
      rejectedQty: numberFrom(entry.rejectedQty, 0),
      unit: text(entry.unit),
      warehouseId: text(entry.warehouseId || record.warehouseId),
      location: text(entry.location),
      status: numberFrom(entry.rejectedQty, 0) > 0 ? 'exception' : 'received',
    })),
    postedAt: isoDate(record.postedAt),
    postedBy: text(record.postedById),
    inventoryApplied: text(record.postingStatus) === 'posted',
    createdAt: isoDate(record.createdAt),
    updatedAt: isoDate(record.updatedAt),
  }
}

function mapSupplierInvoice(record = {}) {
  const meta = metadata(record)
  const varianceAmount = numberFrom(record.varianceAmount, 0)
  // A stored variance type is returned as stored. Without one, return a stable
  // code (see INVOICE_VARIANCE_TYPES) that the client labels in either language.
  const varianceType = text(meta.varianceType, varianceAmount ? 'amount_variance' : 'none')
  const rawMatchStatus = text(record.matchStatus)
  const matchStatus = rawMatchStatus === 'variance'
    ? '差异待处理'
    : rawMatchStatus === 'matched'
      ? '自动匹配'
      : rawMatchStatus || (varianceAmount ? '差异待处理' : '未匹配')
  const rawStatus = text(record.status, 'draft')
  return {
    id: record.id,
    invoiceNumber: record.id,
    supplier: text(record.supplierName || meta.supplier),
    supplierId: text(record.supplierId),
    relatedPo: text(record.relatedPoId),
    relatedGrn: text(record.relatedGrnId),
    invoiceDate: isoDate(record.invoiceDate),
    dueDate: isoDate(record.dueDate),
    amount: numberFrom(record.amount, lineQuantity(record.lines, 'amount', 0)),
    subtotal: numberFrom(record.subtotalAmount, numberFrom(record.amount, lineQuantity(record.lines, 'amount', 0))),
    tax: numberFrom(record.enteredTaxAmount, 0),
    total: numberFrom(record.totalAmount, numberFrom(record.amount, lineQuantity(record.lines, 'amount', 0))),
    currency: text(record.currency),
    status: varianceAmount ? '存在差异' : rawStatus,
    matchStatus,
    varianceType,
    varianceAmount,
    receivedDate: isoDate(record.createdAt),
    paymentTerms: text(meta.paymentTerms),
    owner: text(meta.owner),
    apOwner: text(meta.apOwner),
    source: text(meta.source, 'manual-entry'),
    postedToAp: Boolean(record.approvedAt),
    paid: Boolean(meta.paid),
    lines: asArray(record.lines).map((entry) => {
      const lineMeta = metadata(entry)
      const quantity = numberFrom(entry.quantity, 0)
      const unitPrice = numberFrom(entry.unitPrice, 0)
      const lineSubtotal = numberFrom(entry.lineAmount, numberFrom(entry.amount, quantity * unitPrice))
      const taxAmount = numberFrom(entry.enteredTaxAmount, 0)
      const lineVarianceAmount = numberFrom(lineMeta.varianceAmount, varianceAmount)
      return {
        ...lineMeta,
        lineId: entry.id,
        sku: text(entry.sku),
        name: text(entry.itemName),
        description: text(entry.itemName),
        poLine: text(entry.purchaseOrderLineId),
        grnLine: text(entry.receivingLineId),
        quantity,
        unit: text(entry.unit),
        unitPrice,
        taxRate: numberFrom(lineMeta.taxRate, 0),
        taxAmount,
        lineSubtotal,
        lineTotal: lineSubtotal + taxAmount,
        varianceType: text(lineMeta.varianceType, lineVarianceAmount ? varianceType : 'none'),
        varianceAmount: lineVarianceAmount,
      }
    }),
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

async function readPurchaseRequestDocument(client, { id, tenantId }) {
  const record = await client.purchaseRequest.findFirst({
    where: documentWhere(tenantId, id),
    include: { lines: true },
  })
  if (!record) return null
  return buildProcurementPurchaseRequests({ purchaseRequests: [mapPurchaseRequest(record)] })[0] || null
}

async function readRfqDocument(client, { id, tenantId }) {
  const record = await client.rfq.findFirst({
    where: documentWhere(tenantId, id),
    include: { lines: true },
  })
  if (!record) return null
  const quotations = await client.supplierQuotation.findMany({
    where: { tenantId, rfqId: record.id },
    include: {
      lines: true,
      revisions: {
        include: { lines: true },
        orderBy: [{ revisionNumber: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
      },
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  })
  const participations = await client.rfqSupplierParticipation.findMany({
    where: { tenantId, rfqId: record.id },
    include: { supplier: true },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  })
  return mapRfqDetail(record, quotations, participations)
}

async function readPurchaseOrderDocument(client, { id, tenantId }) {
  const record = await client.purchaseOrder.findFirst({
    where: documentWhere(tenantId, id),
    include: { lines: true },
  })
  if (!record) return null
  const receivingDocuments = await client.receivingDocument.findMany({
    where: { tenantId, poId: record.id },
    select: { id: true, poId: true },
  })
  return buildProcurementPurchaseOrders({
    purchaseOrders: [mapPurchaseOrder(record)],
    receivingDocs: receivingDocuments.map((row) => ({ grn: row.id, po: row.poId })),
  })[0] || null
}

async function readReceivingDocument(client, { id, tenantId }) {
  const record = await client.receivingDocument.findFirst({
    where: documentWhere(tenantId, id),
    include: { lines: true },
  })
  if (!record) return null
  const supplierInvoices = await client.supplierInvoice.findMany({
    where: { tenantId, relatedGrnId: record.id },
    select: { id: true, relatedGrnId: true },
  })
  return buildProcurementReceivingDocs({
    receivingDocs: [mapReceivingDocument(record)],
    supplierInvoices: supplierInvoices.map((row) => ({ invoiceNumber: row.id, relatedGrn: row.relatedGrnId })),
  })[0] || null
}

async function readSupplierInvoiceDocument(client, { id, tenantId }) {
  const record = await client.supplierInvoice.findFirst({
    where: documentWhere(tenantId, id),
    include: { lines: true },
  })
  if (!record) return null
  return buildProcurementSupplierInvoices({ supplierInvoices: [mapSupplierInvoice(record)] })[0] || null
}

async function readThreeWayMatchDocument(client, { id, tenantId }) {
  const matchId = id.match(/^MATCH-(.+)$/i)
  if (!matchId?.[1]) return null
  const invoice = await client.supplierInvoice.findFirst({
    where: documentWhere(tenantId, matchId[1]),
    include: { lines: true },
  })
  if (!invoice) return null

  const [purchaseOrder, receivingDocument] = await Promise.all([
    invoice.relatedPoId
      ? client.purchaseOrder.findFirst({
        where: documentWhere(tenantId, invoice.relatedPoId),
        include: { lines: true },
      })
      : null,
    invoice.relatedGrnId
      ? client.receivingDocument.findFirst({
        where: documentWhere(tenantId, invoice.relatedGrnId),
        include: { lines: true },
      })
      : null,
  ])

  return buildProcurementThreeWayMatches({
    supplierInvoices: [mapSupplierInvoice(invoice)],
    purchaseOrders: purchaseOrder ? [mapPurchaseOrder(purchaseOrder)] : [],
    receivingDocs: receivingDocument ? [mapReceivingDocument(receivingDocument)] : [],
  })[0] || null
}

const directReaders = Object.freeze({
  pr: readPurchaseRequestDocument,
  rfq: readRfqDocument,
  po: readPurchaseOrderDocument,
  grn: readReceivingDocument,
  invoice: readSupplierInvoiceDocument,
  threeWayMatch: readThreeWayMatchDocument,
})

export const DIRECT_PROCUREMENT_DOCUMENT_TYPES = Object.freeze(Object.keys(directReaders))

export async function getDirectProcurementDocument(client, type, id, tenantId) {
  const canonicalType = normalizeProcurementDocumentType(type)
  const reader = directReaders[canonicalType]
  if (!reader) return null
  const requestedId = decodeDocumentId(id)
  if (!requestedId) return null
  return reader(client, { id: requestedId, tenantId })
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
    // With `access` (procurement-read-access.mjs), documents the actor may
    // not read are left out and hidden amounts are masked before any search
    // filter runs, so a search can never match a hidden value.
    listDocuments: async (filters = {}, { access = null } = {}) => {
      const client = await resolvePrisma({ env, prisma })
      const snapshot = await loadProcurementSnapshot(client, filters)
      if (!access) return filterProcurementRows(buildProcurementDocuments(snapshot), filters)
      return filterProcurementRows(maskProcurementDocuments(buildProcurementDocuments(readableProcurementSnapshot(snapshot, access)), access), filters)
    },
    getDocument: async (type, id, options = {}) => {
      const client = await resolvePrisma({ env, prisma })
      return getDirectProcurementDocument(client, type, id, tenantWhere(options).tenantId)
    },
    listLinks: async (filters = {}, { access = null } = {}) => {
      const client = await resolvePrisma({ env, prisma })
      const loaded = await loadProcurementSnapshot(client, filters)
      const snapshot = access ? readableProcurementSnapshot(loaded, access) : loaded
      const rows = [...buildProcurementDocumentLinks(snapshot), ...snapshot.documentLinks]
      return filterProcurementRows(access ? readableProcurementRows(rows, access) : rows, filters)
    },
    listFollowups: async (filters = {}, { access = null } = {}) => {
      const client = await resolvePrisma({ env, prisma })
      const loaded = await loadProcurementSnapshot(client, filters)
      const snapshot = access ? readableProcurementSnapshot(loaded, access) : loaded
      const rows = [...buildProcurementFollowups(snapshot), ...snapshot.procurementFollowups]
      return filterProcurementRows(access ? readableProcurementRows(rows, access) : rows, filters)
    },
    // Counts come from what the actor may read; the open amount is hidden
    // when any amount behind it is.
    getSummary: async (filters = {}, { access = null } = {}) => {
      const client = await resolvePrisma({ env, prisma })
      const loaded = await loadProcurementSnapshot(client, filters)
      const snapshot = access ? readableProcurementSnapshot(loaded, access) : loaded
      const built = buildProcurementSummary(snapshot)
      const explicitFollowups = snapshot.procurementFollowups.length
      const summary = explicitFollowups ? { ...built, followupCount: built.followupCount + explicitFollowups } : built
      return access ? maskProcurementSummary(summary, access) : summary
    },
    normalizeDocumentType: (type) => normalizeProcurementDocumentType(type),
    isDocumentType: (type) => isProcurementDocumentType(type),
  }
}
