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

function related(type, id, label = '', number = '') {
  const canonical = normalizeProcurementDocumentType(type)
  const documentId = text(id)
  if (!canonical || !documentId) return null
  const shown = text(number)
  return { type: canonical, id: documentId, label: text(label, shown || documentId), ...(shown ? { number: shown } : {}) }
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

// The number a purchase request, RFQ or purchase order shows: its number
// (shared/document-numbering.mjs), else its id.
function numberOf(row = {}, id = '') {
  return text(row.number || row.orderNumber, id)
}

// The numbers of the requests, RFQs and orders in `data`, by id, so that a
// reference to one of them carries its number (prNumber, rfqNumber,
// poNumber). A reference whose document is not loaded keeps its own number
// when the row has one, and otherwise has none.
function numberIndex(data = {}) {
  const index = (rows, idOf) => new Map(asArray(rows).map((row, position) => {
    const id = idOf(row, position)
    return [id, numberOf(row, id)]
  }))
  return { pr: index(data.purchaseRequests, prId), rfq: index(data.rfqs, rfqId), po: index(data.purchaseOrders, poId) }
}
function referenceNumber(numbers, id, own = '') {
  return text(own) || (text(id) ? numbers.get(text(id)) || '' : '')
}
const numberField = (field, value) => (value ? { [field]: value } : {})

export function buildProcurementPurchaseRequests(data = {}) {
  const numbers = numberIndex(data)
  return asArray(data.purchaseRequests).map((request, index) => {
    const id = prId(request, index)
    const number = numberOf(request, id)
    const rfqNumber = referenceNumber(numbers.rfq, request.linkedRfq || request.rfqId, request.rfqNumber)
    const poNumber = referenceNumber(numbers.po, request.linkedPo || request.poId, request.poNumber)
    return {
      type: 'purchase_request',
      documentType: 'pr',
      id,
      number,
      label: number,
      title: `${number} ${text(request.sourceName || request.itemName || request.sourceSku || request.sku)}`.trim(),
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
      ...numberField('rfqNumber', rfqNumber),
      ...numberField('poNumber', poNumber),
      relatedDocuments: compactRelatedDocuments([
        related('rfq', request.linkedRfq || request.rfqId, '', rfqNumber),
        related('po', request.linkedPo || request.poId, '', poNumber),
      ]),
      source: text(request.source),
      reason: text(request.reason),
      evidence: evidence('pr', id, request.reason || number, { status: request.status, supplierName: request.supplier, amount: toNumber(request.amount, 0), currency: request.currency }),
    }
  })
}

export function buildProcurementRfqs(data = {}) {
  const numbers = numberIndex(data)
  return asArray(data.rfqs).map((rfq, index) => {
    const id = rfqId(rfq, index)
    const number = numberOf(rfq, id)
    const prNumber = referenceNumber(numbers.pr, rfq.sourceRequest || rfq.linkedPr, rfq.prNumber)
    const poNumber = referenceNumber(numbers.po, rfq.linkedPo, rfq.poNumber)
    const supplierCount = toNumber(rfq.suppliers ?? asArray(rfq.invitedSuppliers).length, 0)
    const respondedSupplierCount = toNumber(rfq.quoted ?? rfq.respondedSupplierCount, 0)
    return {
      type: 'rfq',
      documentType: 'rfq',
      id,
      number,
      label: number,
      title: text(rfq.title, number),
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
      ...numberField('prNumber', prNumber),
      ...numberField('poNumber', poNumber),
      relatedDocuments: compactRelatedDocuments([
        related('pr', rfq.sourceRequest || rfq.linkedPr, '', prNumber),
        related('po', rfq.linkedPo, '', poNumber),
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

  const numbers = numberIndex(data)
  return asArray(data.purchaseOrders).map((po, index) => {
    const id = poId(po, index)
    const number = numberOf(po, id)
    const prNumber = referenceNumber(numbers.pr, po.sourceRequest || po.linkedPr, po.prNumber)
    const rfqNumber = referenceNumber(numbers.rfq, po.sourceRfq || po.linkedRfq, po.rfqNumber)
    const lines = asArray(po.lines)
    const orderedQuantity = toNumber(po.totalOrderedQty ?? po.items ?? po.recommendedQty, 0)
    const receivedQuantity = toNumber(po.totalReceivedQty ?? po.received, 0)
    const linkedGrns = asArray(grnsByPo.get(id)).map((grn, grnIndex) => grnId(grn, grnIndex))
    return {
      type: 'purchase_order',
      documentType: 'po',
      id,
      number,
      orderNumber: number,
      label: number,
      title: `${number} ${text(po.sourceName || po.sourceSku || po.supplier)}`.trim(),
      status: text(po.status, '待处理'),
      supplier: text(po.supplier),
      supplierName: text(po.supplier),
      supplierId: text(po.supplierId),
      sourceRequest: text(po.sourceRequest || po.linkedPr),
      linkedRfq: text(po.sourceRfq || po.linkedRfq),
      ...numberField('prNumber', prNumber),
      ...numberField('rfqNumber', rfqNumber),
      expectedDate: text(po.eta || po.expectedDate || po.requiredDate),
      dueDate: text(po.eta || po.expectedDate || po.requiredDate),
      amount: toNumber(po.amount ?? po.totalAmount, 0),
      currency: text(po.currency),
      orderedQuantity,
      receivedQuantity,
      receivingStatus: receivedQuantity <= 0 ? '未收货' : receivedQuantity < orderedQuantity ? '部分收货' : '已收货',
      linkedGrns,
      relatedDocuments: compactRelatedDocuments([
        related('pr', po.sourceRequest || po.linkedPr, '', prNumber),
        related('rfq', po.sourceRfq || po.linkedRfq, '', rfqNumber),
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
      evidence: evidence('po', id, po.reason || `${number} ${text(po.status)}`, { status: po.status, supplierName: po.supplier, amount: toNumber(po.amount ?? po.totalAmount, 0), currency: po.currency }),
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

  const numbers = numberIndex(data)
  return asArray(data.receivingDocs).map((grn, index) => {
    const id = grnId(grn, index)
    const poNumber = referenceNumber(numbers.po, grn.po || grn.poId, grn.poNumber)
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
      title: `${id} ${poNumber || text(grn.po || grn.poId)}`.trim(),
      po: text(grn.po || grn.poId),
      poId: text(grn.po || grn.poId),
      ...numberField('poNumber', poNumber),
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
        related('po', grn.po || grn.poId, '', poNumber),
        ...asArray(invoicesByGrn.get(id)).map((invoice, invoiceIndex) => related('invoice', invoiceId(invoice, invoiceIndex))),
      ]),
      currency: text(grn.currency),
      evidence: evidence('grn', id, `${poNumber || text(grn.po)} ${text(grn.status)}`, { status: grn.status, supplierName: grn.supplier, currency: grn.currency }),
    }
  })
}

export function buildProcurementSupplierInvoices(data = {}) {
  const numbers = numberIndex(data)
  return asArray(data.supplierInvoices).map((invoice, index) => {
    const id = invoiceId(invoice, index)
    const poNumber = referenceNumber(numbers.po, invoice.relatedPo || invoice.po || invoice.poId, invoice.poNumber)
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
      ...numberField('poNumber', poNumber),
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
        related('po', invoice.relatedPo || invoice.po || invoice.poId, '', poNumber),
        related('grn', invoice.relatedGrn || invoice.grn || invoice.grnId),
        related('threeWayMatch', `MATCH-${id}`),
      ]),
      evidence: evidence('invoice', id, `${id} ${amount}`, { status: invoice.status || invoice.invoiceStatus, supplierName: invoice.supplier || invoice.supplierName, amount, currency: invoice.currency }),
    }
  })
}

// The first value that is a recorded number, or null when none is.
function firstNumber(...values) {
  for (const value of values) {
    if (value === null || value === undefined || value === '') continue
    const parsed = Number(typeof value?.toNumber === 'function' ? value.toNumber() : value)
    if (Number.isFinite(parsed)) return parsed
  }
  return null
}

function roundMoney(value) {
  return value === null ? null : Math.round((value + Number.EPSILON) * 100) / 100
}

function roundQty(value) {
  return value === null ? null : Math.round((value + Number.EPSILON) * 10000) / 10000
}

function sumOrNull(values = []) {
  return values.some((value) => value === null) ? null : values.reduce((sum, value) => sum + value, 0)
}

// Below a cent (or a ten-thousandth of a unit) a difference is rounding.
const MONEY_EPSILON = 0.005
const QTY_EPSILON = 0.00005

function recordedVariance(invoice = {}) {
  return firstNumber(invoice.varianceAmount, invoice.variance, invoice.priceVariance) !== null
}

function rawPoLineId(line = {}, index = 0, id = '') {
  return text(line.poLineId || line.lineId || line.id, `${id}-LINE-${String(index + 1).padStart(3, '0')}`)
}

// The PO line an invoice line bills: by its PO line reference, else by SKU when
// one PO line has it, else the only line of a single-line PO.
function findPoLine(poLines = [], invoiceLine = {}) {
  const ref = text(invoiceLine.poLineId || invoiceLine.poLine || invoiceLine.purchaseOrderLineId)
  const byRef = ref ? poLines.find((line) => line.poLineId === ref) : null
  if (byRef) return byRef
  const sku = text(invoiceLine.sku)
  const bySku = sku ? poLines.filter((line) => line.sku === sku) : []
  if (bySku.length === 1) return bySku[0]
  // A reference to a line the PO does not have is not guessed.
  return !ref && poLines.length === 1 ? poLines[0] : null
}

// The PO's lines with what was ordered, received (accepted) and the unit price.
// Received comes from the PO line, else from the accepted quantity on the
// receipt lines for it, else, for a single-line PO, from the PO header.
function matchPoLines(rawPo, rawGrns = []) {
  if (!rawPo) return []
  const id = poId(rawPo)
  const lines = asArray(rawPo.lines)
  const acceptedByLine = new Map()
  for (const grn of rawGrns) {
    for (const line of asArray(grn.lines)) {
      const key = text(line.poLineId || line.purchaseOrderLineId)
      if (!key) continue
      acceptedByLine.set(key, (acceptedByLine.get(key) || 0) + toNumber(line.acceptedQty ?? line.passed, 0))
    }
  }
  return lines.map((line, index) => {
    const poLineId = rawPoLineId(line, index, id)
    const orderedQty = firstNumber(line.quantityOrdered, line.orderedQuantity, line.orderedQty, line.quantity)
      ?? (lines.length === 1 ? firstNumber(rawPo.totalOrderedQty, rawPo.items) : null)
    const receivedQty = firstNumber(line.quantityReceived, line.receivedQuantity, line.receivedQty, line.received)
      ?? (acceptedByLine.has(poLineId) ? acceptedByLine.get(poLineId) : null)
      ?? (lines.length === 1 ? firstNumber(rawPo.totalReceivedQty, rawPo.received) : null)
    const lineAmount = firstNumber(line.lineAmount, line.amount)
    const unitPrice = firstNumber(line.unitPrice) ?? (lineAmount !== null && orderedQty ? lineAmount / orderedQty : null)
    return {
      poLineId,
      sku: text(line.sku || rawPo.sourceSku),
      itemName: text(line.itemName || line.name || line.itemNameSnapshot || rawPo.sourceName),
      unit: text(line.unit || rawPo.unit),
      orderedQty,
      receivedQty,
      unitPrice,
    }
  })
}

function lineStatus({ poLine, priceVariance, varianceAmount, quantityVariance }) {
  if (!poLine) return 'po_line_unavailable'
  const priced = priceVariance !== null && Math.abs(priceVariance) >= MONEY_EPSILON
  const amount = varianceAmount !== null && Math.abs(varianceAmount) >= MONEY_EPSILON
  const quantity = quantityVariance > QTY_EPSILON
  if (quantity && (priced || amount)) return 'price_and_quantity_variance'
  if (quantity) return 'quantity_variance'
  if (priced) return 'price_variance'
  if (amount) return 'amount_variance'
  return 'matched'
}

// Three-way match line by line. For each invoice line on a PO line:
//   expected amount  = invoiced quantity x PO unit price
//   price variance   = (invoice unit price - PO unit price) x invoiced quantity
//   variance amount  = invoice line amount (net of tax) - expected amount
//   quantity check   = invoiced vs received (accepted) on that PO line, across
//                      this invoice's lines in order: invoicing more than was
//                      received is a quantity variance; less is just received,
//                      not yet fully invoiced.
// What the PO ordered but has not received is a receiving gap, shown for
// information and never a match variance. Other invoices for the same PO line
// are not deducted here; the match run (operational-finance-policy) does that.
function buildThreeWayMatchLines(rawInvoice = {}, rawPo = null, rawGrns = []) {
  const poLines = matchPoLines(rawPo, rawGrns)
  const invoicedSoFar = new Map()
  return asArray(rawInvoice.lines).map((line, index) => {
    const poLine = findPoLine(poLines, line)
    const invoicedQty = firstNumber(line.quantity, line.invoicedQty, line.invoiceQty, line.qty) ?? 0
    const taxAmount = firstNumber(line.taxAmount, line.enteredTaxAmount, line.tax)
    const grossAmount = firstNumber(line.amount)
    const invoiceUnitPrice = firstNumber(line.unitPrice)
    const invoiceLineAmount = roundMoney(firstNumber(line.lineSubtotal, line.lineAmount, line.subtotal)
      ?? (grossAmount !== null ? grossAmount - (taxAmount ?? 0) : null)
      ?? (invoiceUnitPrice !== null ? invoicedQty * invoiceUnitPrice : null))
    const poUnitPrice = poLine?.unitPrice ?? null
    const expectedAmount = poUnitPrice !== null ? roundMoney(invoicedQty * poUnitPrice) : null
    const unitPrice = invoiceUnitPrice ?? (invoiceLineAmount !== null && invoicedQty ? invoiceLineAmount / invoicedQty : null)
    const priceVariance = unitPrice !== null && poUnitPrice !== null ? roundMoney((unitPrice - poUnitPrice) * invoicedQty) : null
    const varianceAmount = invoiceLineAmount !== null && expectedAmount !== null ? roundMoney(invoiceLineAmount - expectedAmount) : null
    const receivedQty = poLine ? (poLine.receivedQty ?? 0) : null
    const before = poLine ? (invoicedSoFar.get(poLine.poLineId) || 0) : 0
    if (poLine) invoicedSoFar.set(poLine.poLineId, before + invoicedQty)
    // This line's share of what is invoiced beyond the received quantity.
    const quantityVariance = poLine ? roundQty(Math.max(0, Math.min(invoicedQty, before + invoicedQty - receivedQty))) : 0
    const quantityVarianceAmount = poUnitPrice !== null ? roundMoney(quantityVariance * poUnitPrice) : null
    return {
      invoiceLineId: text(line.lineId || line.invoiceLineId || line.id, `${invoiceId(rawInvoice)}-LINE-${String(index + 1).padStart(3, '0')}`),
      poLineId: poLine?.poLineId || text(line.poLineId || line.poLine || line.purchaseOrderLineId),
      grnLineId: text(line.grnLine || line.grnLineId || line.receivingLineId),
      sku: text(line.sku || poLine?.sku),
      itemName: text(line.itemName || line.name || line.description || poLine?.itemName),
      unit: text(line.unit || poLine?.unit),
      orderedQty: poLine ? poLine.orderedQty : null,
      receivedQty,
      invoicedQty,
      receivingGapQty: poLine && poLine.orderedQty !== null ? roundQty(Math.max(0, poLine.orderedQty - (poLine.receivedQty ?? 0))) : null,
      quantityVariance,
      poUnitPrice,
      invoiceUnitPrice: unitPrice === null ? null : roundMoney(unitPrice),
      expectedAmount,
      invoiceLineAmount,
      taxAmount,
      priceVariance,
      varianceAmount,
      quantityVarianceAmount,
      status: lineStatus({ poLine, priceVariance, varianceAmount, quantityVariance }),
    }
  }).map((line, _index, lines) => {
    // Received but not yet invoiced on this PO line, after all of this invoice's lines for it.
    const invoicedOnLine = lines.filter((other) => other.poLineId && other.poLineId === line.poLineId).reduce((sum, other) => sum + other.invoicedQty, 0)
    return { ...line, uninvoicedReceivedQty: line.receivedQty === null ? null : roundQty(Math.max(0, line.receivedQty - invoicedOnLine)) }
  })
}

// Line totals for the match: expected at PO prices, invoiced net of tax, tax,
// and the net variance (invoiced net - expected). Null when a line lacks the
// facts, so a partial total is never shown as the whole.
function threeWayMatchLineTotals(lines = [], rawInvoice = {}) {
  const expectedAmount = lines.length ? roundMoney(sumOrNull(lines.map((line) => line.expectedAmount))) : null
  const invoiceNetAmount = lines.length
    ? roundMoney(sumOrNull(lines.map((line) => line.invoiceLineAmount)))
    : roundMoney(firstNumber(rawInvoice.subtotal, rawInvoice.subtotalAmount))
  const lineTaxes = lines.map((line) => line.taxAmount).filter((value) => value !== null)
  const invoiceTaxAmount = roundMoney(firstNumber(rawInvoice.tax, rawInvoice.taxAmount, rawInvoice.enteredTaxAmount)
    ?? (lineTaxes.length ? lineTaxes.reduce((sum, value) => sum + value, 0) : null))
  const lineVarianceAmount = expectedAmount !== null && invoiceNetAmount !== null && lines.length ? roundMoney(invoiceNetAmount - expectedAmount) : null
  const quantityVarianceAmount = lines.length ? roundMoney(sumOrNull(lines.map((line) => line.quantityVarianceAmount))) : null
  // Absolute line variances plus over-invoiced quantities at PO price, so lines
  // that offset each other do not hide a variance.
  const lineVarianceTotal = lines.length && lines.every((line) => line.varianceAmount !== null && line.quantityVarianceAmount !== null)
    ? roundMoney(lines.reduce((sum, line) => sum + Math.abs(line.varianceAmount) + line.quantityVarianceAmount, 0))
    : null
  const lineMatchStatus = !lines.length ? 'no_lines' : lines.every((line) => line.status === 'matched') ? 'matched' : 'variance'
  return {
    expectedAmount,
    invoiceNetAmount,
    taxAmount: invoiceTaxAmount,
    lineVarianceAmount,
    quantityVarianceAmount,
    lineVarianceTotal,
    receivingGapQty: lines.length ? roundQty(sumOrNull(lines.filter((line, index) => line.poLineId && lines.findIndex((other) => other.poLineId === line.poLineId) === index).map((line) => line.receivingGapQty))) : null,
    lineMatchStatus,
  }
}

export function buildProcurementThreeWayMatches(data = {}) {
  const pos = new Map(buildProcurementPurchaseOrders(data).map((po) => [po.id, po]))
  const grns = new Map(buildProcurementReceivingDocs(data).map((grn) => [grn.id, grn]))
  const rawPos = new Map(asArray(data.purchaseOrders).map((po, index) => [poId(po, index), po]))
  const rawGrnsByPo = new Map()
  for (const grn of asArray(data.receivingDocs)) {
    const key = text(grn.po || grn.poId)
    if (!key) continue
    if (!rawGrnsByPo.has(key)) rawGrnsByPo.set(key, [])
    rawGrnsByPo.get(key).push(grn)
  }
  const rawInvoices = asArray(data.supplierInvoices)
  return buildProcurementSupplierInvoices(data).map((invoice, index) => {
    const po = pos.get(invoice.relatedPo) || null
    const grn = grns.get(invoice.relatedGrn) || null
    const rawInvoice = rawInvoices[index] || {}
    const lines = buildThreeWayMatchLines(rawInvoice, rawPos.get(invoice.relatedPo) || null, asArray(rawGrnsByPo.get(invoice.relatedPo)))
    const lineTotals = threeWayMatchLineTotals(lines, rawInvoice)
    // The recorded variance when the invoice has one; otherwise the line-level
    // total, never the whole PO against a partial invoice.
    const varianceAmount = recordedVariance(rawInvoice) ? toNumber(invoice.varianceAmount, 0) : toNumber(lineTotals.lineVarianceTotal, 0)
    const poAmount = toNumber(po?.amount, 0)
    const invoiceAmount = toNumber(invoice.amount, 0)
    const varianceRate = poAmount > 0 ? Number((varianceAmount / poAmount).toFixed(4)) : null
    const status = invoice.matchStatus || (varianceAmount ? '存在差异' : '已匹配')
    const poNumber = text(invoice.poNumber || po?.number)
    const prNumber = text(po?.prNumber)
    const rfqNumber = text(po?.rfqNumber)
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
      ...numberField('poNumber', poNumber),
      ...numberField('prNumber', prNumber),
      ...numberField('rfqNumber', rfqNumber),
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
      // Line by line: one entry per invoice line, against its PO line.
      lines,
      ...lineTotals,
      relatedDocuments: compactRelatedDocuments([
        related('pr', po?.sourceRequest, '', prNumber),
        related('rfq', po?.linkedRfq, '', rfqNumber),
        related('po', invoice.relatedPo, '', poNumber),
        related('grn', invoice.relatedGrn),
        related('invoice', invoice.id),
      ]),
      evidence: [
        ...evidence('invoice', invoice.id, invoice.status, { status: invoice.invoiceStatus, supplierName: invoice.supplier, amount: invoiceAmount, currency: invoice.currency }),
        ...(po ? evidence('po', po.id, `${po.number} ${text(po.status)}`.trim(), { status: po.status, supplierName: po.supplier, amount: poAmount, currency: po.currency }) : []),
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
  // Labels name requests, RFQs and orders by the number they show; the ids
  // stay in sourceId and targetId.
  for (const rfq of buildProcurementRfqs(data)) {
    if (rfq.linkedPr) links.push({ sourceType: 'pr', sourceId: rfq.linkedPr, targetType: 'rfq', targetId: rfq.id, relationship: 'sourced_rfq', relation: 'sourced_rfq', label: `${rfq.prNumber || rfq.linkedPr} -> ${rfq.number}`, status: rfq.status })
    if (rfq.linkedPo) links.push({ sourceType: 'rfq', sourceId: rfq.id, targetType: 'po', targetId: rfq.linkedPo, relationship: 'awarded_po', relation: 'awarded_po', label: `${rfq.number} -> ${rfq.poNumber || rfq.linkedPo}`, status: rfq.status })
  }
  for (const po of buildProcurementPurchaseOrders(data)) {
    if (po.sourceRequest) links.push({ sourceType: 'pr', sourceId: po.sourceRequest, targetType: 'po', targetId: po.id, relationship: 'converted_po', relation: 'converted_po', label: `${po.prNumber || po.sourceRequest} -> ${po.number}`, status: po.status })
    if (po.linkedRfq) links.push({ sourceType: 'rfq', sourceId: po.linkedRfq, targetType: 'po', targetId: po.id, relationship: 'awarded_po', relation: 'awarded_po', label: `${po.rfqNumber || po.linkedRfq} -> ${po.number}`, status: po.status })
    for (const grn of po.linkedGrns) links.push({ sourceType: 'po', sourceId: po.id, targetType: 'grn', targetId: grn, relationship: 'received_by', relation: 'received_by', label: `${po.number} -> ${grn}`, status: po.receivingStatus })
  }
  for (const invoice of buildProcurementSupplierInvoices(data)) {
    if (invoice.relatedPo) links.push({ sourceType: 'po', sourceId: invoice.relatedPo, targetType: 'invoice', targetId: invoice.id, relationship: 'invoiced_by', relation: 'invoiced_by', label: `${invoice.poNumber || invoice.relatedPo} -> ${invoice.id}`, status: invoice.invoiceStatus })
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
        title: `${po.number} 已超过预计日期`,
        message: `${po.number} 预计日期 ${po.expectedDate}，当前状态 ${po.status}`,
        summary: `${po.number} 预计日期 ${po.expectedDate}，当前状态 ${po.status}`,
        status: 'open',
        dueDate: po.expectedDate,
        supplierName: po.supplierName,
        supplierId: po.supplierId,
        documentType: 'po',
        documentId: po.id,
        documentNumber: po.number,
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
        title: `${rfq.number} 待供应商回复`,
        message: `${rfq.number} 仍有 ${rfq.pendingSupplierCount} 家供应商待回复`,
        summary: `${rfq.number} 仍有 ${rfq.pendingSupplierCount} 家供应商待回复`,
        status: 'open',
        dueDate: rfq.dueDate,
        supplierName: rfq.supplierName,
        supplierId: rfq.supplierId,
        documentType: 'rfq',
        documentId: rfq.id,
        documentNumber: rfq.number,
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
    // Never added across currencies: with several currencies there is no total.
    totalOpenAmount: openAmountCurrency.currencies.length > 1 ? null : openAmountDocuments.reduce((sum, item) => sum + toNumber(item.amount, 0), 0),
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
