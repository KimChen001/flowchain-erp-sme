import { buildInventoryExceptions } from './inventory-read.mjs'
import { buildInventoryAllocationReadModel, getSkuAvailability, resolvePurchaseOrderSupplyImpact, resolveSalesOrderAllocationImpact } from './inventory-allocation-read-model.mjs'
import { buildProcurementDocuments } from './procurement-read-model.mjs'
import { buildSalesDemandReadModel, getSalesOrderById, resolvePurchaseOrderSalesImpact, resolveSkuDemandImpact } from './sales-demand-read-model.mjs'
import { listMasterSuppliers } from './master-data.mjs'

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

function unique(values = []) {
  return [...new Set(asArray(values).flat().map(text).filter(Boolean))]
}

function lower(value = '') {
  return text(value).toLowerCase()
}

const TYPE_LABELS = Object.freeze({
  customer_order: '客户订单',
  inventory_availability: '库存可用量',
  sku: 'SKU',
  purchase_request: '采购申请',
  rfq: 'RFQ',
  purchase_order: '采购订单',
  receiving_doc: '收货单',
  supplier: '供应商',
  supplier_invoice: '供应商发票',
  exception_case: '异常工单',
  today_work_item: '今日风险事项',
})

const MODULE_BY_TYPE = Object.freeze({
  customer_order: 'sales',
  inventory_availability: 'inventory',
  sku: 'inventory',
  purchase_request: 'procurement',
  rfq: 'procurement',
  purchase_order: 'procurement',
  receiving_doc: 'procurement',
  supplier: 'supplier',
  supplier_invoice: 'finance',
  exception_case: 'operations',
  today_work_item: 'overview',
})

const PROCUREMENT_TYPE_MAP = Object.freeze({
  pr: 'purchase_request',
  rfq: 'rfq',
  po: 'purchase_order',
  grn: 'receiving_doc',
  invoice: 'supplier_invoice',
  threeWayMatch: 'supplier_invoice',
})

function normalizeEntityType(value = '') {
  const key = lower(value).replace(/[-\s]/g, '_')
  if (['sales_order', 'customer_order', 'order'].includes(key)) return 'customer_order'
  if (['sku', 'inventory_item', 'item', 'inventory_availability', 'available_to_promise'].includes(key)) return 'inventory_availability'
  if (['po', 'purchase_order'].includes(key)) return 'purchase_order'
  if (['pr', 'purchase_request'].includes(key)) return 'purchase_request'
  if (['rfq'].includes(key)) return 'rfq'
  if (['grn', 'receiving', 'receiving_doc', 'receiving_document'].includes(key)) return 'receiving_doc'
  if (['supplier', 'vendor'].includes(key)) return 'supplier'
  if (['invoice', 'supplier_invoice'].includes(key)) return 'supplier_invoice'
  if (['exception_case', 'case'].includes(key)) return 'exception_case'
  return key || 'unknown'
}

function routeFor(type = '', id = '') {
  const key = encodeURIComponent(text(id))
  if (!key) return ''
  if (type === 'customer_order') return `/api/sales-demand/orders/${key}`
  if (type === 'inventory_availability' || type === 'sku') return `/api/inventory/availability/${key}`
  if (type === 'purchase_request') return `/api/procurement/documents/pr/${key}`
  if (type === 'rfq') return `/api/procurement/documents/rfq/${key}`
  if (type === 'purchase_order') return `/api/procurement/documents/po/${key}`
  if (type === 'receiving_doc') return `/api/procurement/documents/grn/${key}`
  if (type === 'supplier') return `/api/master-data/suppliers/${key}`
  if (type === 'supplier_invoice') return `/api/procurement/documents/invoice/${key}`
  if (type === 'exception_case') return `/api/exception-cases/${key}`
  return ''
}

function riskRank(value = '') {
  return ({ blocked: 4, high: 3, medium: 2, low: 1, 高: 3, 中: 2, 低: 1 })[text(value)] || 0
}

function riskLabel(value = '') {
  if (value === 'blocked') return '已阻塞'
  if (value === 'high' || value === '高') return '高风险'
  if (value === 'medium' || value === '中') return '需关注'
  if (value === 'low' || value === '低') return '正常'
  return text(value)
}

function docId(row = {}) {
  return text(row.id || row.po || row.pr || row.rfq || row.grn || row.invoiceNumber || row.invoiceId || row.caseId)
}

function supplierId(row = {}) {
  return text(row.id || row.supplierId || row.name || row.supplierName)
}

function supplierMatches(row = {}, value = '') {
  const key = lower(value)
  return Boolean(key) && [row.id, row.name, row.supplierId, row.supplierName].some((candidate) => lower(candidate) === key)
}

function poMatchesSku(po = {}, sku = '') {
  const key = text(sku)
  if (!key) return false
  const values = [po.id, po.sku, po.itemId, po.itemName, po.title, po.sourceSku, po.sourceName, ...asArray(po.lines).flatMap((line) => [line.sku, line.itemSku, line.itemName, line.name])]
  return values.some((value) => text(value).includes(key))
}

function buildContext(db = {}) {
  const procurementDocuments = buildProcurementDocuments(db)
  const salesModel = buildSalesDemandReadModel(db)
  const allocationModel = buildInventoryAllocationReadModel(db)
  const suppliers = listMasterSuppliers(db)
  const exceptionCases = [
    ...asArray(db.exceptionCases),
    ...buildInventoryExceptions(db).map((item) => ({
      caseId: item.id,
      sourceEntityId: item.sku || item.linkedDocument,
      status: item.status,
      severity: Math.abs(toNumber(item.quantityImpact, 0)) > 0 ? 'medium' : 'low',
      summary: item.reason || item.nextAction || item.type,
    })),
  ]
  return { db, procurementDocuments, salesModel, allocationModel, suppliers, exceptionCases }
}

function graphBuilder() {
  const nodes = []
  const edges = []
  const nodeKeys = new Set()
  const edgeKeys = new Set()

  function addNode(input = {}) {
    const type = normalizeEntityType(input.type)
    const id = text(input.id)
    if (!id) return null
    const key = `${type}:${lower(id)}`
    const existing = nodes.find((node) => node._key === key)
    if (existing) return existing
    const label = text(input.label, `${TYPE_LABELS[type] || type} ${id}`)
    const node = {
      _key: key,
      id,
      type,
      label,
      moduleId: text(input.moduleId, MODULE_BY_TYPE[type] || ''),
      status: text(input.status),
      riskLevel: text(input.riskLevel),
      riskLabel: text(input.riskLabel || riskLabel(input.riskLevel)),
      summary: text(input.summary),
      route: text(input.route, routeFor(type, id)),
      dataLimitations: unique(input.dataLimitations),
    }
    nodes.push(node)
    nodeKeys.add(key)
    return node
  }

  function addEdge(from, to, relation, relationLabel, summary = '', options = {}) {
    if (!from || !to) return null
    const fromKey = from._key || `${normalizeEntityType(from.type)}:${lower(from.id)}`
    const toKey = to._key || `${normalizeEntityType(to.type)}:${lower(to.id)}`
    if (!nodeKeys.has(fromKey) || !nodeKeys.has(toKey)) return null
    const key = `${fromKey}:${relation}:${toKey}`
    if (edgeKeys.has(key)) return null
    edgeKeys.add(key)
    const edge = {
      id: `${relation}:${from.id}:${to.id}`,
      from: from.id,
      to: to.id,
      relation,
      relationLabel,
      summary: text(summary),
      strength: options.strength || 'strong',
      dataLimitations: unique(options.dataLimitations),
    }
    edges.push(edge)
    return edge
  }

  function outputNodes() {
    return nodes.map(({ _key, ...node }) => node)
  }

  return { addNode, addEdge, outputNodes, edges }
}

function nodeFromOrder(addNode, order = {}) {
  return addNode({
    type: 'customer_order',
    id: order.salesOrderId,
    label: `${order.customerName || '客户订单'} · ${order.salesOrderId}`,
    status: order.statusLabel,
    riskLevel: order.deliveryRiskLevel,
    riskLabel: order.deliveryRiskLabel,
    summary: order.deliveryRiskReason,
    dataLimitations: order.dataLimitations,
  })
}

function nodeFromAvailability(addNode, item = {}) {
  return addNode({
    type: 'inventory_availability',
    id: item.sku,
    label: `${item.sku} · ${item.itemName || '库存可用量'}`,
    status: item.riskLabel,
    riskLevel: item.riskLevel,
    riskLabel: item.riskLabel,
    summary: `可用量 ${item.availableQty ?? item.availableQuantity ?? 0}，可承诺量 ${item.availableToPromiseQty ?? 0}，缺口 ${item.shortageQty ?? 0}`,
    dataLimitations: item.dataLimitations,
  })
}

function nodeFromProcurement(addNode, doc = {}) {
  const mappedType = PROCUREMENT_TYPE_MAP[doc.documentType] || normalizeEntityType(doc.documentType)
  return addNode({
    type: mappedType,
    id: docId(doc),
    // Requests, RFQs and orders are named by the number they show.
    label: `${TYPE_LABELS[mappedType] || mappedType} ${doc.number || docId(doc)}`.trim(),
    status: doc.status || doc.matchStatus || doc.invoiceStatus,
    riskLevel: doc.riskLevel || doc.severity,
    riskLabel: riskLabel(doc.riskLevel || doc.severity),
    summary: doc.summary || doc.title || doc.reason,
    route: doc.route,
    dataLimitations: doc.dataLimitations,
  })
}

function nodeFromSupplier(addNode, supplier = {}) {
  const id = supplierId(supplier)
  return addNode({
    type: 'supplier',
    id,
    label: supplier.name || supplier.supplierName || id,
    status: supplier.status,
    riskLevel: supplier.risk === 'high' ? 'high' : supplier.risk === 'medium' ? 'medium' : '',
    riskLabel: riskLabel(supplier.risk),
    summary: supplier.score ? `供应商评分 ${supplier.score}` : supplier.risk || supplier.status,
  })
}

function nodeFromException(addNode, item = {}) {
  const id = text(item.caseId || item.id)
  return addNode({
    type: 'exception_case',
    id,
    label: `异常工单 ${id}`,
    status: item.status,
    riskLevel: item.severity || item.priority,
    riskLabel: riskLabel(item.severity || item.priority),
    summary: item.summary || item.reason || item.title,
  })
}

function supplierRowsFor(context, names = []) {
  return unique(names).map((name) =>
    context.suppliers.find((supplier) => supplierMatches(supplier, name)) || { id: name, name, status: '', risk: '' }
  ).filter((supplier) => text(supplier.name || supplier.id))
}

function procurementByType(context, type) {
  return context.procurementDocuments.filter((doc) => doc.documentType === type)
}

function relatedReceivingDocs(context, poIds = []) {
  const ids = new Set(unique(poIds).map(lower))
  return procurementByType(context, 'grn').filter((doc) => ids.has(lower(doc.linkedPo || doc.poId || doc.relatedPo || doc.po)))
}

function relatedInvoices(context, grnIds = [], poIds = []) {
  const grns = new Set(unique(grnIds).map(lower))
  const pos = new Set(unique(poIds).map(lower))
  return context.procurementDocuments.filter((doc) =>
    doc.documentType === 'invoice' &&
    (grns.has(lower(doc.relatedGrn || doc.grn || doc.grnId)) || pos.has(lower(doc.relatedPo || doc.poId || doc.po)))
  )
}

function exceptionCasesFor(context, ids = []) {
  const keys = new Set(unique(ids).map(lower))
  return context.exceptionCases.filter((item) =>
    [item.caseId, item.id, item.sourceEntityId, item.sourceId, item.linkedDocument, item.sku].some((value) => keys.has(lower(value)))
  )
}

function addSalesOrderChain(builder, context, order) {
  const orderNode = nodeFromOrder(builder.addNode, order)
  const availability = getSkuAvailability(context.db, order.sku)
  const skuNode = availability
    ? nodeFromAvailability(builder.addNode, availability)
    : builder.addNode({ type: 'inventory_availability', id: order.sku, label: `${order.sku} · 库存可用量`, dataLimitations: ['missing_inventory_allocation'] })
  builder.addEdge(orderNode, skuNode, 'consumes_inventory', '占用库存', `${order.salesOrderId} 占用 ${order.sku}`)

  const poRows = order.linkedPurchaseOrders?.length
    ? order.linkedPurchaseOrders.map((po) => context.procurementDocuments.find((doc) => doc.documentType === 'po' && lower(doc.id) === lower(po.id || po.poId || po))).filter(Boolean)
    : procurementByType(context, 'po').filter((po) => poMatchesSku(po, order.sku))
  addPurchaseOrderChains(builder, context, poRows, skuNode, orderNode)

  for (const supplier of supplierRowsFor(context, order.linkedSuppliers?.map((item) => item.name || item.id))) {
    const supplierNode = nodeFromSupplier(builder.addNode, supplier)
    builder.addEdge(skuNode, supplierNode, 'placed_with_supplier', '下达给供应商', `${order.sku} 关联供应商 ${supplier.name || supplier.id}`, { strength: 'medium' })
  }
  addExceptionCases(builder, context, [order.salesOrderId, order.sku])
  return orderNode
}

function addPurchaseOrderChains(builder, context, poRows = [], skuNode = null, orderNode = null) {
  for (const po of poRows.filter(Boolean)) {
    const poNode = nodeFromProcurement(builder.addNode, po)
    if (skuNode) builder.addEdge(skuNode, poNode, 'supplied_by_po', '由采购订单补给', `${skuNode.id} 由 ${po.number || po.id} 补给`)
    if (orderNode) builder.addEdge(poNode, orderNode, 'impacts_delivery', '影响客户交付', `${po.number || po.id} 影响 ${orderNode.id} 交付`, { strength: 'medium' })

    const pr = context.procurementDocuments.find((doc) => doc.documentType === 'pr' && lower(doc.id) === lower(po.sourceRequest || po.linkedPr || po.prId))
    if (pr) {
      const prNode = nodeFromProcurement(builder.addNode, pr)
      builder.addEdge(poNode, prNode, 'sourced_from_pr', '来源于采购申请', `${po.number || po.id} 来源于 ${pr.number || pr.id}`)
    }
    const rfq = context.procurementDocuments.find((doc) => doc.documentType === 'rfq' && lower(doc.id) === lower(po.sourceRfq || po.linkedRfq || po.rfqId))
    if (rfq) {
      const rfqNode = nodeFromProcurement(builder.addNode, rfq)
      builder.addEdge(poNode, rfqNode, 'quoted_by_rfq', '经过询价', `${po.number || po.id} 关联 ${rfq.number || rfq.id}`)
    }
    for (const supplier of supplierRowsFor(context, [po.supplierName || po.supplier])) {
      const supplierNode = nodeFromSupplier(builder.addNode, supplier)
      builder.addEdge(poNode, supplierNode, 'placed_with_supplier', '下达给供应商', `${po.number || po.id} 下达给 ${supplier.name || supplier.id}`)
      if (/逾期|延期|延迟|部分|待确认/.test(text(po.status))) {
        builder.addEdge(poNode, supplierNode, 'delayed_by_supplier', '受供应商延期影响', `${po.number || po.id} 需要复核供应商交付`, { strength: 'medium' })
      }
    }
    const grns = relatedReceivingDocs(context, [po.id])
    for (const grn of grns) {
      const grnNode = nodeFromProcurement(builder.addNode, grn)
      builder.addEdge(poNode, grnNode, 'received_by_grn', '由收货单确认', `${po.number || po.id} 关联 ${grn.id}`)
    }
    const invoices = relatedInvoices(context, grns.map((item) => item.id), [po.id])
    for (const invoice of invoices) {
      const invoiceNode = nodeFromProcurement(builder.addNode, invoice)
      const anchor = grns[0] ? builder.addNode({ type: 'receiving_doc', id: grns[0].id }) : poNode
      builder.addEdge(anchor, invoiceNode, 'matched_to_invoice', '关联发票', `${invoice.id} 关联采购与收货证据`)
    }
    addExceptionCases(builder, context, [po.id, po.sourceSku, po.sourceRequest, po.sourceRfq])
  }
}

function addExceptionCases(builder, context, ids = []) {
  for (const item of exceptionCasesFor(context, ids)) {
    nodeFromException(builder.addNode, item)
  }
}

function addSkuChain(builder, context, sku = '') {
  const availability = getSkuAvailability(context.db, sku)
  const skuNode = availability
    ? nodeFromAvailability(builder.addNode, availability)
    : builder.addNode({ type: 'inventory_availability', id: sku, label: `${sku} · 库存可用量`, dataLimitations: ['record_not_found'] })
  const demandImpact = resolveSkuDemandImpact(context.db, sku)
  for (const order of demandImpact.orders) {
    const orderNode = nodeFromOrder(builder.addNode, order)
    builder.addEdge(orderNode, skuNode, 'consumes_inventory', '占用库存', `${order.salesOrderId} 占用 ${sku}`)
  }
  const poRows = procurementByType(context, 'po').filter((po) => poMatchesSku(po, sku))
  addPurchaseOrderChains(builder, context, poRows, skuNode)
  addExceptionCases(builder, context, [sku])
  return skuNode
}

function addSupplierChain(builder, context, supplierIdOrName = '') {
  const supplier = context.suppliers.find((item) => supplierMatches(item, supplierIdOrName)) || { id: supplierIdOrName, name: supplierIdOrName, dataLimitations: ['missing_supplier_records'] }
  const supplierNode = nodeFromSupplier(builder.addNode, supplier)
  const poRows = procurementByType(context, 'po').filter((po) => supplierMatches(supplier, po.supplierName || po.supplier))
  for (const po of poRows) {
    const poNode = nodeFromProcurement(builder.addNode, po)
    builder.addEdge(poNode, supplierNode, 'placed_with_supplier', '下达给供应商', `${po.number || po.id} 下达给 ${supplier.name || supplier.id}`)
    const impact = resolvePurchaseOrderSalesImpact(context.db, po.id)
    for (const order of impact.orders) {
      const orderNode = nodeFromOrder(builder.addNode, order)
      builder.addEdge(poNode, orderNode, 'impacts_delivery', '影响客户交付', `${po.number || po.id} 影响 ${order.salesOrderId}`)
    }
    addPurchaseOrderChains(builder, context, [po])
  }
  addExceptionCases(builder, context, [supplier.id, supplier.name])
  return supplierNode
}

function addProcurementAnchorChain(builder, context, type = '', id = '') {
  const docType = ({ purchase_order: 'po', purchase_request: 'pr', receiving_doc: 'grn', supplier_invoice: 'invoice' })[type] || type
  const document = context.procurementDocuments.find((doc) => doc.documentType === docType && lower(doc.id) === lower(id))
  if (!document) return builder.addNode({ type, id, label: `${TYPE_LABELS[type] || type} ${id}`, dataLimitations: ['record_not_found'] })
  const node = nodeFromProcurement(builder.addNode, document)
  if (type === 'purchase_order') {
    const impact = resolvePurchaseOrderSupplyImpact(context.db, id)
    for (const item of impact.impactedSkus) {
      const skuNode = nodeFromAvailability(builder.addNode, item)
      builder.addEdge(skuNode, node, 'supplied_by_po', '由采购订单补给', `${item.sku} 由 ${id} 补给`)
    }
    for (const order of impact.affectedSalesOrders) {
      const orderNode = nodeFromOrder(builder.addNode, order)
      builder.addEdge(node, orderNode, 'impacts_delivery', '影响客户交付', `${id} 影响 ${order.salesOrderId}`)
    }
  }
  if (type === 'purchase_request') {
    for (const rfq of context.procurementDocuments.filter((doc) => doc.documentType === 'rfq' && lower(doc.sourceRequest) === lower(id))) {
      const rfqNode = nodeFromProcurement(builder.addNode, rfq)
      builder.addEdge(node, rfqNode, 'quoted_by_rfq', '经过询价', `${id} 关联 ${rfq.number || rfq.id}`)
    }
  }
  if (type === 'rfq') {
    for (const po of context.procurementDocuments.filter((doc) => doc.documentType === 'po' && lower(doc.sourceRfq || doc.linkedRfq) === lower(id))) {
      const poNode = nodeFromProcurement(builder.addNode, po)
      builder.addEdge(poNode, node, 'quoted_by_rfq', '经过询价', `${po.number || po.id} 关联 ${id}`)
    }
  }
  if (type === 'receiving_doc') {
    const po = context.procurementDocuments.find((doc) => doc.documentType === 'po' && lower(doc.id) === lower(document.relatedPo || document.poId || document.po || document.linkedPo))
    if (po) {
      const poNode = nodeFromProcurement(builder.addNode, po)
      builder.addEdge(poNode, node, 'received_by_grn', '由收货单确认', `${po.number || po.id} 关联 ${id}`)
    }
  }
  if (type === 'supplier_invoice') {
    const grn = context.procurementDocuments.find((doc) => doc.documentType === 'grn' && lower(doc.id) === lower(document.relatedGrn || document.grnId))
    if (grn) {
      const grnNode = nodeFromProcurement(builder.addNode, grn)
      builder.addEdge(grnNode, node, 'matched_to_invoice', '关联发票', `${id} 关联 ${grn.id}`)
    }
  }
  addPurchaseOrderChains(builder, context, type === 'purchase_order' ? [document] : [])
  addExceptionCases(builder, context, [id, document.sourceSku, document.sourceRequest, document.sourceRfq, document.relatedPo, document.relatedGrn])
  return node
}

export function resolveEvidenceGraphAnchor(db = {}, { entityType = '', entityId = '' } = {}) {
  const context = buildContext(db)
  const type = normalizeEntityType(entityType)
  const id = decodeURIComponent(text(entityId))
  if (!id) return { anchor: null, dataLimitations: ['record_not_found'] }
  if (type === 'customer_order') {
    const order = getSalesOrderById(db, id)
    return order ? { anchor: { id: order.salesOrderId, type, label: `${order.customerName} · ${order.salesOrderId}`, moduleId: 'sales', status: order.statusLabel, riskLevel: order.deliveryRiskLevel, riskLabel: order.deliveryRiskLabel }, dataLimitations: order.dataLimitations } : { anchor: null, dataLimitations: ['record_not_found'] }
  }
  if (type === 'inventory_availability') {
    const item = getSkuAvailability(db, id)
    return item ? { anchor: { id: item.sku, type, label: `${item.sku} · ${item.itemName}`, moduleId: 'inventory', status: item.riskLabel, riskLevel: item.riskLevel, riskLabel: item.riskLabel }, dataLimitations: item.dataLimitations } : { anchor: null, dataLimitations: ['record_not_found'] }
  }
  if (type === 'supplier') {
    const supplier = context.suppliers.find((item) => supplierMatches(item, id))
    return supplier ? { anchor: { id: supplier.id, type, label: supplier.name, moduleId: 'supplier', status: supplier.status, riskLevel: supplier.risk, riskLabel: riskLabel(supplier.risk) }, dataLimitations: [] } : { anchor: null, dataLimitations: ['record_not_found'] }
  }
  if (['purchase_order', 'purchase_request', 'rfq', 'receiving_doc', 'supplier_invoice'].includes(type)) {
    const docType = ({ purchase_order: 'po', purchase_request: 'pr', receiving_doc: 'grn', supplier_invoice: 'invoice' })[type] || type
    const doc = context.procurementDocuments.find((item) => item.documentType === docType && lower(item.id) === lower(id))
    return doc ? { anchor: { id: doc.id, type, label: `${TYPE_LABELS[type]} ${doc.id}`, moduleId: MODULE_BY_TYPE[type], status: doc.status || doc.matchStatus || doc.invoiceStatus, riskLevel: doc.riskLevel || doc.severity, riskLabel: riskLabel(doc.riskLevel || doc.severity) }, dataLimitations: [] } : { anchor: null, dataLimitations: ['record_not_found'] }
  }
  return { anchor: null, dataLimitations: ['record_not_found'] }
}

function relatedRecordsFromNodes(nodes = []) {
  const byType = (type) => nodes.filter((node) => node.type === type).map(({ id, label, status, riskLevel, riskLabel, route }) => ({ id, label, status, riskLevel, riskLabel, route }))
  return {
    salesOrders: byType('customer_order'),
    inventoryAvailability: byType('inventory_availability'),
    purchaseRequests: byType('purchase_request'),
    rfqs: byType('rfq'),
    purchaseOrders: byType('purchase_order'),
    receivingDocs: byType('receiving_doc'),
    suppliers: byType('supplier'),
    invoices: byType('supplier_invoice'),
    exceptionCases: byType('exception_case'),
  }
}

function buildRiskSignals(nodes = [], edges = []) {
  const signals = []
  const risky = nodes.filter((node) => riskRank(node.riskLevel) >= 2 || /缺口|风险|异常|差异|延期|逾期|阻塞/.test(`${node.riskLabel} ${node.summary} ${node.status}`))
  for (const node of risky.slice(0, 8)) {
    const type = node.type === 'customer_order'
      ? 'customer_delivery_risk'
      : node.type === 'inventory_availability'
        ? (/可承诺量 0/.test(node.summary) ? 'available_to_promise_risk' : 'inventory_allocation_risk')
        : node.type === 'purchase_order'
          ? 'purchase_order_delay'
          : node.type === 'supplier'
            ? 'supplier_risk'
            : node.type === 'receiving_doc'
              ? 'receiving_exception'
              : node.type === 'supplier_invoice'
                ? 'invoice_match_exception'
                : 'data_incomplete'
    signals.push({ type, label: node.riskLabel || node.status || '需复核', severity: riskRank(node.riskLevel) >= 3 ? 'high' : 'medium', summary: node.summary || node.label, affectedNodes: [node.id] })
  }
  if (edges.some((edge) => edge.dataLimitations.length)) {
    signals.push({ type: 'data_incomplete', label: '数据限制', severity: 'medium', summary: '当前工作区存在需要人工复核的关联记录。', affectedNodes: [] })
  }
  return signals
}

function buildNavigationHints(nodes = []) {
  return nodes
    .filter((node) => node.route)
    .slice(0, 8)
    .map((node) => ({ label: node.label, moduleId: node.moduleId, entityId: node.id, entityType: node.type, route: node.route }))
}

export function buildPrimaryEvidencePath(db = {}, anchor = {}) {
  const graph = buildEvidenceGraph(db, anchor)
  const order = ['customer_order', 'inventory_availability', 'purchase_order', 'supplier', 'receiving_doc', 'supplier_invoice', 'exception_case']
  return order
    .map((type) => graph.nodes.find((node) => node.type === type))
    .filter(Boolean)
    .map((node) => ({ nodeId: node.id, label: node.label, moduleId: node.moduleId, route: node.route }))
}

export function buildEvidenceGraphSummary(graph = {}) {
  const nodes = asArray(graph.nodes)
  const edges = asArray(graph.edges)
  const riskSignals = asArray(graph.riskSignals)
  return {
    nodeCount: nodes.length,
    edgeCount: edges.length,
    riskSignalCount: riskSignals.length,
    anchorLabel: graph.anchor?.label || '',
    topRiskLabel: riskSignals[0]?.label || '',
    dataLimitations: unique(graph.dataLimitations),
  }
}

export function buildEvidenceGraph(db = {}, { entityType = '', entityId = '', depth = 2 } = {}) {
  const context = buildContext(db)
  const type = normalizeEntityType(entityType)
  const id = decodeURIComponent(text(entityId))
  const resolved = resolveEvidenceGraphAnchor(db, { entityType: type, entityId: id })
  const builder = graphBuilder()
  let anchorNode = null

  if (!resolved.anchor) {
    anchorNode = builder.addNode({ type, id: id || 'unknown', label: id || '未找到记录', dataLimitations: resolved.dataLimitations })
  } else if (type === 'customer_order') {
    anchorNode = addSalesOrderChain(builder, context, getSalesOrderById(db, id))
  } else if (type === 'inventory_availability') {
    anchorNode = addSkuChain(builder, context, id)
  } else if (type === 'supplier') {
    anchorNode = addSupplierChain(builder, context, id)
  } else {
    anchorNode = addProcurementAnchorChain(builder, context, type, id)
  }

  const nodes = builder.outputNodes()
  const edges = builder.edges
  const dataLimitations = unique([resolved.dataLimitations, nodes.flatMap((node) => node.dataLimitations), nodes.length <= 1 ? ['current_workspace_data_limited'] : []])
  const primaryPath = buildPrimaryPathFromNodes(nodes, anchorNode)
  const graph = {
    anchor: resolved.anchor || {
      id: anchorNode?.id || id,
      type,
      label: anchorNode?.label || id,
      moduleId: anchorNode?.moduleId || MODULE_BY_TYPE[type] || '',
      status: anchorNode?.status || '',
      riskLevel: anchorNode?.riskLevel || '',
      riskLabel: anchorNode?.riskLabel || '',
    },
    nodes,
    edges,
    primaryPath,
    relatedRecords: relatedRecordsFromNodes(nodes),
    riskSignals: buildRiskSignals(nodes, edges),
    navigationHints: buildNavigationHints(nodes),
    dataLimitations,
    depth: Math.max(1, Math.min(3, toNumber(depth, 2))),
  }
  return { ...graph, summary: buildEvidenceGraphSummary(graph) }
}

function buildPrimaryPathFromNodes(nodes = [], anchorNode = null) {
  const preferred = ['customer_order', 'inventory_availability', 'purchase_order', 'supplier', 'receiving_doc', 'supplier_invoice', 'exception_case']
  const ordered = [
    anchorNode,
    ...preferred.map((type) => nodes.find((node) => node.type === type && node.id !== anchorNode?.id)),
  ].filter(Boolean)
  const seen = new Set()
  return ordered
    .filter((node) => {
      const key = `${node.type}:${node.id}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    .slice(0, 7)
    .map((node) => ({ nodeId: node.id, label: node.label, moduleId: node.moduleId, route: node.route }))
}

export function resolveRelatedRecords(db = {}, { entityType = '', entityId = '', depth = 2 } = {}) {
  const graph = buildEvidenceGraph(db, { entityType, entityId, depth })
  return {
    anchor: graph.anchor,
    relatedRecords: graph.relatedRecords,
    nodes: graph.nodes,
    edges: graph.edges,
    dataLimitations: graph.dataLimitations,
  }
}

export function traceSalesOrderEvidence(db = {}, salesOrderId = '') {
  return buildEvidenceGraph(db, { entityType: 'customer_order', entityId: salesOrderId })
}

export function traceSkuSupplyDemandEvidence(db = {}, sku = '') {
  return buildEvidenceGraph(db, { entityType: 'inventory_availability', entityId: sku })
}

export function tracePurchaseOrderDeliveryImpact(db = {}, poId = '') {
  return buildEvidenceGraph(db, { entityType: 'purchase_order', entityId: poId })
}

export function traceSupplierOperationalEvidence(db = {}, supplierIdOrName = '') {
  return buildEvidenceGraph(db, { entityType: 'supplier', entityId: supplierIdOrName })
}

export function traceReceivingEvidence(db = {}, grnId = '') {
  return buildEvidenceGraph(db, { entityType: 'receiving_doc', entityId: grnId })
}

export function traceInvoiceEvidence(db = {}, invoiceId = '') {
  return buildEvidenceGraph(db, { entityType: 'supplier_invoice', entityId: invoiceId })
}
