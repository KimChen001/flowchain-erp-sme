function asArray(value) {
  return Array.isArray(value) ? value : []
}

function text(value, fallback = '') {
  const next = String(value ?? '').trim()
  return next || fallback
}

function toNumber(value, fallback = 0) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function lower(value) {
  return text(value).toLowerCase()
}

const DOCUMENT_TYPE_ALIASES = new Map([
  ['pr', 'pr'],
  ['purchase_request', 'pr'],
  ['purchase-request', 'pr'],
  ['purchaseRequest', 'pr'],
  ['rfq', 'rfq'],
  ['po', 'po'],
  ['purchase_order', 'po'],
  ['purchase-order', 'po'],
  ['purchaseOrder', 'po'],
  ['grn', 'grn'],
  ['receiving', 'grn'],
  ['receiving_doc', 'grn'],
  ['receiving-doc', 'grn'],
  ['receivingDoc', 'grn'],
  ['invoice', 'invoice'],
  ['supplier_invoice', 'invoice'],
  ['supplier-invoice', 'invoice'],
  ['supplierInvoice', 'invoice'],
  ['threeWayMatch', 'threeWayMatch'],
  ['three_way_match', 'threeWayMatch'],
  ['three-way-match', 'threeWayMatch'],
  ['3wm', 'threeWayMatch'],
])

const TERMINAL_STATUSES = new Set(['已完成', '已取消', '已关闭', '已收货', '已转PO', '已授标'])

export function normalizeProcurementDocumentType(value = '') {
  const raw = text(value)
  if (!raw) return ''
  return DOCUMENT_TYPE_ALIASES.get(raw) || DOCUMENT_TYPE_ALIASES.get(raw.toLowerCase()) || ''
}

export function isProcurementDocumentType(value = '') {
  return Boolean(normalizeProcurementDocumentType(value))
}

export function buildProcurementEvidenceItem(document = {}, overrides = {}) {
  const type = normalizeProcurementDocumentType(overrides.type || document.type)
  const id = text(overrides.id || document.id)
  return {
    type,
    id,
    label: text(overrides.label || document.title || document.label || id, id),
    status: text(overrides.status ?? document.status ?? document.invoiceStatus ?? document.matchStatus),
    supplierName: text(overrides.supplierName ?? document.supplierName ?? document.supplier),
    amount: overrides.amount ?? document.amount ?? document.invoiceAmount ?? document.poAmount ?? null,
    currency: text(overrides.currency ?? document.currency),
    source: text(overrides.source ?? document.source),
    route: id && type ? `/api/procurement/documents/${type}/${encodeURIComponent(id)}` : '',
  }
}

function evidence(type, id, summary = '', extra = {}) {
  const item = buildProcurementEvidenceItem({
    type,
    id,
    label: text(summary) || id,
    ...extra,
  })
  return [{ ...item, summary: text(summary) || id }]
}

function related(type, id, label = '') {
  const canonical = normalizeProcurementDocumentType(type)
  const documentId = text(id)
  if (!canonical || !documentId) return null
  return { type: canonical, id: documentId, label: text(label, documentId) }
}

function compactRelatedDocuments(values = []) {
  const seen = new Set()
  return values.filter(Boolean).filter((item) => {
    const key = `${item.type}:${item.id}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function isOpenStatus(status = '') {
  const value = text(status)
  return value ? !TERMINAL_STATUSES.has(value) : true
}

function rowDateValue(value = '') {
  const raw = text(value)
  if (!raw) return null
  const iso = raw.match(/^20\d{2}-\d{2}-\d{2}/)?.[0]
  if (iso) return new Date(`${iso}T00:00:00Z`).getTime()
  const chinese = raw.match(/(\d{1,2})月(\d{1,2})日/)
  if (chinese) {
    return new Date(`2026-${String(chinese[1]).padStart(2, '0')}-${String(chinese[2]).padStart(2, '0')}T00:00:00Z`).getTime()
  }
  return null
}

function poId(po = {}, index = 0) {
  return text(po.po || po.poId || po.id, `PO-READ-${String(index + 1).padStart(4, '0')}`)
}

function prId(pr = {}, index = 0) {
  return text(pr.pr || pr.prId || pr.id, `PR-READ-${String(index + 1).padStart(4, '0')}`)
}

function rfqId(rfq = {}, index = 0) {
  return text(rfq.id || rfq.rfq || rfq.rfqId, `RFQ-READ-${String(index + 1).padStart(4, '0')}`)
}

function grnId(grn = {}, index = 0) {
  return text(grn.grn || grn.grnId || grn.id, `GRN-READ-${String(index + 1).padStart(4, '0')}`)
}

function invoiceId(invoice = {}, index = 0) {
  return text(invoice.invoiceNumber || invoice.invoiceId || invoice.id, `INV-READ-${String(index + 1).padStart(4, '0')}`)
}

export function buildProcurementPurchaseRequests(data = {}) {
  return asArray(data.purchaseRequests).map((request, index) => {
    const id = prId(request, index)
    return {
      type: 'purchase_request',
      documentType: 'pr',
      id,
      label: id,
      title: `${id} ${text(request.sourceName || request.itemName || request.sourceSku || request.sku)}`.trim(),
      status: text(request.status, '待处理'),
      requester: text(request.requester),
      buyer: text(request.buyer),
      supplier: text(request.supplier),
      supplierName: text(request.supplier),
      supplierId: text(request.supplierId),
      sku: text(request.sourceSku || request.sku || request.itemId),
      itemId: text(request.itemId || request.sourceSku || request.sku),
      itemName: text(request.sourceName || request.itemName || request.name),
      quantity: toNumber(request.quantity || request.recommendedQty, 0),
      unit: text(request.unit),
      unitPrice: toNumber(request.unitPrice, 0),
      amount: toNumber(request.amount, 0),
      currency: text(request.currency),
      priority: text(request.priority),
      requiredDate: text(request.requiredDate || request.eta),
      dueDate: text(request.requiredDate || request.eta),
      createdAt: text(request.createdAt || request.created),
      updatedAt: text(request.updatedAt || request.convertedAt || request.approvedAt),
      linkedRfq: text(request.linkedRfq || request.rfqId),
      linkedPo: text(request.linkedPo || request.poId),
      relatedDocuments: compactRelatedDocuments([
        related('rfq', request.linkedRfq || request.rfqId),
        related('po', request.linkedPo || request.poId),
      ]),
      source: text(request.source),
      reason: text(request.reason),
      evidence: evidence('pr', id, request.reason, { status: request.status, supplierName: request.supplier, amount: toNumber(request.amount, 0), currency: request.currency }),
    }
  })
}

export function buildProcurementRfqs(data = {}) {
  return asArray(data.rfqs).map((rfq, index) => {
    const id = rfqId(rfq, index)
    const supplierCount = toNumber(rfq.suppliers ?? asArray(rfq.invitedSuppliers).length, 0)
    const respondedSupplierCount = toNumber(rfq.quoted ?? rfq.respondedSupplierCount, 0)
    return {
      type: 'rfq',
      documentType: 'rfq',
      id,
      label: id,
      title: text(rfq.title, id),
      category: text(rfq.category),
      status: text(rfq.status, '进行中'),
      supplierCount,
      respondedSupplierCount,
      pendingSupplierCount: Math.max(0, supplierCount - respondedSupplierCount),
      dueDate: text(rfq.due || rfq.dueDate),
      bestPrice: toNumber(rfq.bestPrice, 0),
      awardedSupplier: text(rfq.bestSupplier || rfq.awardedSupplier),
      linkedPr: text(rfq.sourceRequest || rfq.linkedPr),
      linkedPo: text(rfq.linkedPo),
      relatedDocuments: compactRelatedDocuments([
        related('pr', rfq.sourceRequest || rfq.linkedPr),
        related('po', rfq.linkedPo),
      ]),
      sku: text(rfq.sourceSku || rfq.sku),
      itemId: text(rfq.itemId || rfq.sourceSku || rfq.sku),
      itemName: text(rfq.sourceName || rfq.itemName),
      quantity: toNumber(rfq.quantity, 0),
      unit: text(rfq.unit),
      currency: text(rfq.currency),
      supplierName: text(rfq.bestSupplier || rfq.awardedSupplier),
      supplierId: text(rfq.supplierId),
      createdAt: text(rfq.createdAt || rfq.created),
      updatedAt: text(rfq.updatedAt),
      evidence: evidence('rfq', id, rfq.reason || rfq.title, { status: rfq.status, supplierName: rfq.bestSupplier || rfq.awardedSupplier, currency: rfq.currency }),
    }
  })
}

export function buildProcurementPurchaseOrders(data = {}) {
  const grnsByPo = new Map()
  for (const grn of asArray(data.receivingDocs)) {
    const key = text(grn.po || grn.poId)
    if (!key) continue
    if (!grnsByPo.has(key)) grnsByPo.set(key, [])
    grnsByPo.get(key).push(grn)
  }

  return asArray(data.purchaseOrders).map((po, index) => {
    const id = poId(po, index)
    const lines = asArray(po.lines)
    const orderedQuantity = toNumber(po.totalOrderedQty ?? po.items ?? po.recommendedQty, 0)
    const receivedQuantity = toNumber(po.totalReceivedQty ?? po.received, 0)
    const linkedGrns = asArray(grnsByPo.get(id)).map((grn, grnIndex) => grnId(grn, grnIndex))
    return {
      type: 'purchase_order',
      documentType: 'po',
      id,
      label: id,
      title: `${id} ${text(po.sourceName || po.sourceSku || po.supplier)}`.trim(),
      status: text(po.status, '待处理'),
      supplier: text(po.supplier),
      supplierName: text(po.supplier),
      supplierId: text(po.supplierId),
      sourceRequest: text(po.sourceRequest || po.linkedPr),
      linkedRfq: text(po.sourceRfq || po.linkedRfq),
      expectedDate: text(po.eta || po.expectedDate || po.requiredDate),
      dueDate: text(po.eta || po.expectedDate || po.requiredDate),
      amount: toNumber(po.amount ?? po.totalAmount, 0),
      currency: text(po.currency),
      orderedQuantity,
      receivedQuantity,
      receivingStatus: receivedQuantity <= 0 ? '未收货' : receivedQuantity < orderedQuantity ? '部分收货' : '已收货',
      linkedGrns,
      relatedDocuments: compactRelatedDocuments([
        related('pr', po.sourceRequest || po.linkedPr),
        related('rfq', po.sourceRfq || po.linkedRfq),
        ...linkedGrns.map((grn) => related('grn', grn)),
      ]),
      lineCount: toNumber(po.lineCount ?? lines.length, lines.length),
      owner: text(po.owner || po.buyer),
      priority: text(po.priority),
      sku: text(po.sourceSku || lines.find((line) => line?.sku)?.sku),
      itemId: text(po.itemId || po.sourceSku || lines.find((line) => line?.sku)?.sku),
      itemName: text(po.sourceName || lines.find((line) => line?.itemName)?.itemName),
      createdAt: text(po.createdAt || po.created),
      updatedAt: text(po.updatedAt),
      evidence: evidence('po', id, po.reason || `${id} ${text(po.status)}`, { status: po.status, supplierName: po.supplier, amount: toNumber(po.amount ?? po.totalAmount, 0), currency: po.currency }),
    }
  })
}

export function buildProcurementReceivingDocs(data = {}) {
  const invoicesByGrn = new Map()
  for (const invoice of asArray(data.supplierInvoices)) {
    const key = text(invoice.relatedGrn || invoice.grn || invoice.grnId)
    if (!key) continue
    if (!invoicesByGrn.has(key)) invoicesByGrn.set(key, [])
    invoicesByGrn.get(key).push(invoice)
  }

  return asArray(data.receivingDocs).map((grn, index) => {
    const id = grnId(grn, index)
    const lines = asArray(grn.lines)
    const acceptedQty = lines.length
      ? lines.reduce((sum, line) => sum + toNumber(line.acceptedQty ?? line.passed, 0), 0)
      : toNumber(grn.passed, 0)
    const rejectedQty = lines.length
      ? lines.reduce((sum, line) => sum + toNumber(line.rejectedQty ?? line.failed, 0), 0)
      : toNumber(grn.failed, 0)
    return {
      type: 'receiving_doc',
      documentType: 'grn',
      id,
      label: id,
      title: `${id} ${text(grn.po || grn.poId)}`.trim(),
      po: text(grn.po || grn.poId),
      poId: text(grn.po || grn.poId),
      supplier: text(grn.supplier),
      supplierName: text(grn.supplier),
      supplierId: text(grn.supplierId),
      status: text(grn.status, '质检中'),
      arrived: text(grn.arrived || grn.createdAt),
      createdAt: text(grn.createdAt || grn.arrived),
      updatedAt: text(grn.updatedAt || grn.postedAt),
      receiver: text(grn.receiver),
      warehouse: text(grn.warehouse || grn.warehouseId),
      receivedQuantity: toNumber(grn.items, acceptedQty + rejectedQty),
      acceptedQty,
      rejectedQty,
      linkedInvoices: asArray(invoicesByGrn.get(id)).map((invoice, invoiceIndex) => invoiceId(invoice, invoiceIndex)),
      relatedDocuments: compactRelatedDocuments([
        related('po', grn.po || grn.poId),
        ...asArray(invoicesByGrn.get(id)).map((invoice, invoiceIndex) => related('invoice', invoiceId(invoice, invoiceIndex))),
      ]),
      currency: text(grn.currency),
      evidence: evidence('grn', id, `${text(grn.po)} ${text(grn.status)}`, { status: grn.status, supplierName: grn.supplier, currency: grn.currency }),
    }
  })
}

export function buildProcurementSupplierInvoices(data = {}) {
  return asArray(data.supplierInvoices).map((invoice, index) => {
    const id = invoiceId(invoice, index)
    const amount = toNumber(invoice.amount ?? invoice.total ?? invoice.grossAmount, 0)
    const varianceAmount = toNumber(invoice.varianceAmount ?? invoice.variance ?? invoice.priceVariance, 0)
    return {
      type: 'supplier_invoice',
      documentType: 'invoice',
      id,
      label: id,
      title: `${id} ${text(invoice.supplier || invoice.supplierName)}`.trim(),
      supplier: text(invoice.supplier || invoice.supplierName),
      supplierName: text(invoice.supplier || invoice.supplierName),
      supplierId: text(invoice.supplierId),
      relatedPo: text(invoice.relatedPo || invoice.po || invoice.poId),
      relatedGrn: text(invoice.relatedGrn || invoice.grn || invoice.grnId),
      poId: text(invoice.relatedPo || invoice.po || invoice.poId),
      grnId: text(invoice.relatedGrn || invoice.grn || invoice.grnId),
      invoiceDate: text(invoice.invoiceDate || invoice.date),
      createdAt: text(invoice.createdAt || invoice.invoiceDate || invoice.date),
      updatedAt: text(invoice.updatedAt),
      dueDate: text(invoice.dueDate),
      amount,
      currency: text(invoice.currency),
      matchStatus: text(invoice.matchStatus, varianceAmount ? '存在差异' : '待匹配'),
      invoiceStatus: text(invoice.status || invoice.invoiceStatus, '待处理'),
      varianceAmount,
      relatedDocuments: compactRelatedDocuments([
        related('po', invoice.relatedPo || invoice.po || invoice.poId),
        related('grn', invoice.relatedGrn || invoice.grn || invoice.grnId),
        related('threeWayMatch', `MATCH-${id}`),
      ]),
      evidence: evidence('invoice', id, `${id} ${amount}`, { status: invoice.status || invoice.invoiceStatus, supplierName: invoice.supplier || invoice.supplierName, amount, currency: invoice.currency }),
    }
  })
}

export function buildProcurementThreeWayMatches(data = {}) {
  const pos = new Map(buildProcurementPurchaseOrders(data).map((po) => [po.id, po]))
  const grns = new Map(buildProcurementReceivingDocs(data).map((grn) => [grn.id, grn]))
  return buildProcurementSupplierInvoices(data).map((invoice) => {
    const po = pos.get(invoice.relatedPo) || null
    const grn = grns.get(invoice.relatedGrn) || null
    const varianceAmount = toNumber(invoice.varianceAmount, Math.abs(toNumber(invoice.amount) - toNumber(po?.amount)))
    const poAmount = toNumber(po?.amount, 0)
    const invoiceAmount = toNumber(invoice.amount, 0)
    const varianceRate = poAmount > 0 ? Number((varianceAmount / poAmount).toFixed(4)) : null
    const status = invoice.matchStatus || (varianceAmount ? '存在差异' : '已匹配')
    return {
      type: 'three_way_match',
      documentType: 'threeWayMatch',
      id: `MATCH-${invoice.id}`,
      label: `MATCH-${invoice.id}`,
      title: `三单匹配 ${invoice.id}`,
      po: invoice.relatedPo,
      grn: invoice.relatedGrn,
      invoice: invoice.id,
      prId: text(po?.sourceRequest),
      rfqId: text(po?.linkedRfq),
      poId: invoice.relatedPo,
      grnId: invoice.relatedGrn,
      invoiceId: invoice.id,
      supplierId: text(invoice.supplierId || po?.supplierId || grn?.supplierId),
      supplier: invoice.supplier || po?.supplier || grn?.supplier || '',
      supplierName: invoice.supplier || po?.supplier || grn?.supplier || '',
      poAmount,
      receivedAmount: null,
      receivedQuantity: grn ? toNumber(grn.acceptedQty, 0) : null,
      invoiceAmount,
      varianceAmount,
      varianceRate,
      currency: text(invoice.currency || po?.currency || grn?.currency),
      matchStatus: status,
      status,
      blockingReason: varianceAmount ? 'PO 金额与发票金额存在差异，需复核后处理。' : '',
      exceptionReason: varianceAmount ? `差异金额 ${varianceAmount}` : '',
      relatedDocuments: compactRelatedDocuments([
        related('pr', po?.sourceRequest),
        related('rfq', po?.linkedRfq),
        related('po', invoice.relatedPo),
        related('grn', invoice.relatedGrn),
        related('invoice', invoice.id),
      ]),
      evidence: [
        ...evidence('invoice', invoice.id, invoice.status, { status: invoice.invoiceStatus, supplierName: invoice.supplier, amount: invoiceAmount, currency: invoice.currency }),
        ...(po ? evidence('po', po.id, po.status, { status: po.status, supplierName: po.supplier, amount: poAmount, currency: po.currency }) : []),
        ...(grn ? evidence('grn', grn.id, grn.status, { status: grn.status, supplierName: grn.supplier, currency: grn.currency }) : []),
      ],
    }
  })
}

export function buildProcurementDocuments(data = {}) {
  return [
    ...buildProcurementPurchaseRequests(data),
    ...buildProcurementRfqs(data),
    ...buildProcurementPurchaseOrders(data),
    ...buildProcurementReceivingDocs(data),
    ...buildProcurementSupplierInvoices(data),
    ...buildProcurementThreeWayMatches(data),
  ]
}

export function getProcurementDocument(data = {}, type = '', id = '') {
  const wantedType = normalizeProcurementDocumentType(type)
  const wantedId = decodeURIComponent(text(id)).toLowerCase()
  if (!wantedType || !wantedId) return null
  return buildProcurementDocuments(data).find((document) =>
    document.documentType === wantedType && lower(document.id) === wantedId
  ) || null
}

export function buildProcurementDocumentLinks(data = {}) {
  const links = []
  for (const rfq of buildProcurementRfqs(data)) {
    if (rfq.linkedPr) links.push({ sourceType: 'pr', sourceId: rfq.linkedPr, targetType: 'rfq', targetId: rfq.id, relationship: 'sourced_rfq', relation: 'sourced_rfq', label: `${rfq.linkedPr} -> ${rfq.id}`, status: rfq.status })
    if (rfq.linkedPo) links.push({ sourceType: 'rfq', sourceId: rfq.id, targetType: 'po', targetId: rfq.linkedPo, relationship: 'awarded_po', relation: 'awarded_po', label: `${rfq.id} -> ${rfq.linkedPo}`, status: rfq.status })
  }
  for (const po of buildProcurementPurchaseOrders(data)) {
    if (po.sourceRequest) links.push({ sourceType: 'pr', sourceId: po.sourceRequest, targetType: 'po', targetId: po.id, relationship: 'converted_po', relation: 'converted_po', label: `${po.sourceRequest} -> ${po.id}`, status: po.status })
    if (po.linkedRfq) links.push({ sourceType: 'rfq', sourceId: po.linkedRfq, targetType: 'po', targetId: po.id, relationship: 'awarded_po', relation: 'awarded_po', label: `${po.linkedRfq} -> ${po.id}`, status: po.status })
    for (const grn of po.linkedGrns) links.push({ sourceType: 'po', sourceId: po.id, targetType: 'grn', targetId: grn, relationship: 'received_by', relation: 'received_by', label: `${po.id} -> ${grn}`, status: po.receivingStatus })
  }
  for (const invoice of buildProcurementSupplierInvoices(data)) {
    if (invoice.relatedPo) links.push({ sourceType: 'po', sourceId: invoice.relatedPo, targetType: 'invoice', targetId: invoice.id, relationship: 'invoiced_by', relation: 'invoiced_by', label: `${invoice.relatedPo} -> ${invoice.id}`, status: invoice.invoiceStatus })
    if (invoice.relatedGrn) links.push({ sourceType: 'grn', sourceId: invoice.relatedGrn, targetType: 'invoice', targetId: invoice.id, relationship: 'matched_invoice', relation: 'matched_invoice', label: `${invoice.relatedGrn} -> ${invoice.id}`, status: invoice.matchStatus })
    links.push({ sourceType: 'invoice', sourceId: invoice.id, targetType: 'threeWayMatch', targetId: `MATCH-${invoice.id}`, relationship: 'matched_by', relation: 'matched_by', label: `${invoice.id} -> MATCH-${invoice.id}`, status: invoice.matchStatus })
  }
  return links.filter((link) => link.sourceId && link.targetId)
}

export function buildProcurementFollowups(data = {}, options = {}) {
  const nowMs = options.now ? new Date(options.now).getTime() : Date.now()
  const items = []
  for (const po of buildProcurementPurchaseOrders(data)) {
    const dueMs = rowDateValue(po.expectedDate)
    if (dueMs && dueMs < nowMs && !['已完成', '已取消', '已收货'].includes(po.status)) {
      items.push({
        type: 'overdue_po',
        id: `FOLLOWUP-overdue_po-${po.id}`,
        severity: 'high',
        owner: po.owner,
        title: `${po.id} 已超过预计日期`,
        message: `${po.id} 预计日期 ${po.expectedDate}，当前状态 ${po.status}`,
        summary: `${po.id} 预计日期 ${po.expectedDate}，当前状态 ${po.status}`,
        status: 'open',
        dueDate: po.expectedDate,
        supplierName: po.supplierName,
        supplierId: po.supplierId,
        documentType: 'po',
        documentId: po.id,
        evidence: evidence('po', po.id, po.status, po)[0],
      })
    }
  }
  for (const rfq of buildProcurementRfqs(data)) {
    if (rfq.pendingSupplierCount > 0 && !['已授标', '已转PO', '已关闭', '已取消'].includes(rfq.status)) {
      items.push({
        type: 'pending_rfq_response',
        id: `FOLLOWUP-pending_rfq_response-${rfq.id}`,
        severity: rfq.pendingSupplierCount > 1 ? 'medium' : 'low',
        owner: '',
        title: `${rfq.id} 待供应商回复`,
        message: `${rfq.id} 仍有 ${rfq.pendingSupplierCount} 家供应商待回复`,
        summary: `${rfq.id} 仍有 ${rfq.pendingSupplierCount} 家供应商待回复`,
        status: 'open',
        dueDate: rfq.dueDate,
        supplierName: rfq.supplierName,
        supplierId: rfq.supplierId,
        documentType: 'rfq',
        documentId: rfq.id,
        evidence: evidence('rfq', rfq.id, rfq.status, rfq)[0],
      })
    }
  }
  for (const invoice of buildProcurementSupplierInvoices(data)) {
    if (Math.abs(toNumber(invoice.varianceAmount)) > 0 || /差异|异常|待复核/.test(invoice.matchStatus)) {
      items.push({
        type: 'invoice_variance',
        id: `FOLLOWUP-invoice_variance-${invoice.id}`,
        severity: 'high',
        owner: '',
        title: `${invoice.id} 三单匹配差异`,
        message: `${invoice.id} 差异金额 ${invoice.varianceAmount}`,
        summary: `${invoice.id} 差异金额 ${invoice.varianceAmount}`,
        status: 'open',
        dueDate: invoice.dueDate,
        supplierName: invoice.supplierName,
        supplierId: invoice.supplierId,
        documentType: 'invoice',
        documentId: invoice.id,
        evidence: evidence('invoice', invoice.id, invoice.matchStatus, invoice)[0],
      })
    }
  }
  return items
}

// Open amounts are summed without FX conversion, so the summary only carries a currency code
// when every contributing document shares one; otherwise the code is null and the status says why.
function summarizeOpenAmountCurrency(openDocuments = []) {
  const currencies = [...new Set(openDocuments.map((item) => text(item.currency).toUpperCase()).filter(Boolean))].sort()
  const currencyAggregationStatus = currencies.length === 0 ? 'no_currency_data' : currencies.length === 1 ? 'single_currency' : 'multi_currency_unconverted'
  return { currency: currencies.length === 1 ? currencies[0] : null, currencies, currencyAggregationStatus }
}

export function buildProcurementSummary(data = {}) {
  const documents = buildProcurementDocuments(data)
  const followups = buildProcurementFollowups(data)
  const openAmountDocuments = documents.filter((item) => ['pr', 'po', 'invoice'].includes(item.documentType) && isOpenStatus(item.status || item.invoiceStatus))
  const openAmountCurrency = summarizeOpenAmountCurrency(openAmountDocuments)
  return {
    documentCount: documents.length,
    purchaseRequestCount: documents.filter((item) => item.documentType === 'pr').length,
    rfqCount: documents.filter((item) => item.documentType === 'rfq').length,
    purchaseOrderCount: documents.filter((item) => item.documentType === 'po').length,
    receivingDocCount: documents.filter((item) => item.documentType === 'grn').length,
    supplierInvoiceCount: documents.filter((item) => item.documentType === 'invoice').length,
    threeWayMatchCount: documents.filter((item) => item.documentType === 'threeWayMatch').length,
    followupCount: followups.length,
    highSeverityFollowupCount: followups.filter((item) => item.severity === 'high').length,
    openPrCount: documents.filter((item) => item.documentType === 'pr' && isOpenStatus(item.status)).length,
    activeRfqCount: documents.filter((item) => item.documentType === 'rfq' && isOpenStatus(item.status)).length,
    openPoCount: documents.filter((item) => item.documentType === 'po' && isOpenStatus(item.status)).length,
    pendingReceivingCount: documents.filter((item) => item.documentType === 'grn' && isOpenStatus(item.status)).length,
    invoiceExceptionCount: documents.filter((item) => item.documentType === 'invoice' && (toNumber(item.varianceAmount) !== 0 || /差异|异常|待复核/.test(item.matchStatus))).length,
    threeWayMatchExceptionCount: documents.filter((item) => item.documentType === 'threeWayMatch' && toNumber(item.varianceAmount) !== 0).length,
    totalOpenAmount: openAmountDocuments.reduce((sum, item) => sum + toNumber(item.amount, 0), 0),
    currency: openAmountCurrency.currency,
    currencies: openAmountCurrency.currencies,
    currencyAggregationStatus: openAmountCurrency.currencyAggregationStatus,
    urgentFollowupCount: followups.filter((item) => item.severity === 'high').length,
  }
}

export function filterProcurementRows(rows = [], query = {}) {
  const q = lower(query.q)
  const type = normalizeProcurementDocumentType(query.type)
  const status = text(query.status)
  const supplier = lower(query.supplier)
  const limit = Math.max(0, toNumber(query.limit, 0))
  const filtered = asArray(rows).filter((row) => {
    const haystack = Object.values(row).join(' ').toLowerCase()
    return (!q || haystack.includes(q)) &&
      (!type || row.documentType === type) &&
      (!status || row.status === status || row.invoiceStatus === status || row.matchStatus === status) &&
      (!supplier || lower(row.supplier).includes(supplier))
  })
  return limit > 0 ? filtered.slice(0, limit) : filtered
}
