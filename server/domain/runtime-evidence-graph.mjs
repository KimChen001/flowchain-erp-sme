const array = value => Array.isArray(value) ? value : []
const text = value => String(value ?? '').trim()
const same = (a, b) => text(a).toLowerCase() === text(b).toLowerCase()

const typeAliases = { sales_order: 'sales_order', customer_order: 'sales_order', sku: 'item', inventory_availability: 'inventory_item', inventory: 'inventory_item', po: 'purchase_order', pr: 'purchase_request', grn: 'receiving_doc', receiving: 'receiving_doc', invoice: 'supplier_invoice' }
const collectionType = {
  items: 'item', suppliers: 'supplier', inventoryItems: 'inventory_item', salesOrders: 'sales_order', purchaseRequests: 'purchase_request',
  rfqs: 'rfq', purchaseOrders: 'purchase_order', receipts: 'receiving_doc', supplierInvoices: 'supplier_invoice',
}
const sourceByType = { item: 'masterData.itemRuntime', supplier: 'masterData.supplierRuntime', inventory_item: 'inventoryRuntime', sales_order: 'salesOrders', purchase_request: 'procurementRuntime', rfq: 'procurementRuntime', purchase_order: 'procurementRuntime', receiving_doc: 'procurementRuntime', supplier_invoice: 'procurementRuntime' }

function idOf(type, row) {
  if (type === 'item' || type === 'inventory_item') return text(row.sku || row.itemId || row.id)
  if (type === 'supplier') return text(row.id || row.supplierCode || row.code)
  if (type === 'sales_order') return text(row.salesOrderId || row.id)
  if (type === 'purchase_request') return text(row.id || row.pr)
  if (type === 'purchase_order') return text(row.id || row.po)
  if (type === 'receiving_doc') return text(row.id || row.grn || row.receiptId)
  if (type === 'supplier_invoice') return text(row.id || row.invoiceNumber || row.invoiceId)
  return text(row.id)
}

function routeFor(type, id) {
  const key = encodeURIComponent(id)
  return ({ item: '/app/master-data/items', supplier: '/app/master-data/suppliers', inventory_item: '/app/inventory/items', sales_order: '/app/sales/orders', purchase_request: '/app/procurement/requests', rfq: '/app/procurement/rfqs', purchase_order: '/app/procurement/orders', receiving_doc: '/app/procurement/receiving', supplier_invoice: '/app/finance/invoices' })[type] + `/${key}`
}

function labelOf(type, row, id) {
  if (type === 'sales_order') return text(row.orderNumber || row.customerName || id)
  if (type === 'item' || type === 'inventory_item') return text(row.itemName || row.name || row.sku || id)
  return text(row.name || row.supplierName || row.customerName || row.title || row.invoiceNumber || id)
}

export function buildRuntimeEvidenceGraph(context, { entityType, entityId } = {}) {
  const nodes = []
  const edges = []
  const index = new Map()
  const addNode = (type, row) => {
    const id = idOf(type, row)
    if (!id) return null
    const key = `${type}:${id.toLowerCase()}`
    if (index.has(key)) return index.get(key)
    const canonicalRoute = routeFor(type, id)
    const node = {
      entityType: type,
      entityId: id,
      label: labelOf(type, row, id),
      canonicalRoute,
      sourceRepository: sourceByType[type],
      id,
      type,
      route: canonicalRoute,
      status: text(row.status || row.statusLabel),
      riskLevel: text(row.riskLevel || row.deliveryRiskLevel),
      riskLabel: text(row.riskLabel || row.deliveryRiskLabel),
      summary: text(row.deliveryRiskReason || row.summary),
      dataLimitations: [],
    }
    nodes.push(node); index.set(key, node); return node
  }
  const addEdge = (from, to, relation) => { if (from && to && !edges.some(edge => edge.from === from.entityId && edge.to === to.entityId && edge.relation === relation)) edges.push({ id: `${relation}:${from.entityId}:${to.entityId}`, from: from.entityId, to: to.entityId, relation, relationLabel: relation, sourceRepository: 'BusinessReadContext' }) }

  for (const [collection, type] of Object.entries(collectionType)) for (const row of array(context[collection])) addNode(type, row)
  const find = (type, id) => index.get(`${type}:${text(id).toLowerCase()}`)
  const itemNode = key => find('item', key) || nodes.find(node => node.entityType === 'item' && array(context.items).some(row => same(idOf('item', row), node.entityId) && [row.itemId, row.sku, row.id].some(value => same(value, key))))

  for (const row of array(context.salesOrders)) addEdge(find('sales_order', idOf('sales_order', row)), itemNode(row.sku || row.itemId), 'references_item')
  for (const row of array(context.inventoryItems)) addEdge(find('inventory_item', idOf('inventory_item', row)), itemNode(row.sku || row.itemId), 'balance_for_item')
  for (const rel of array(context.itemSupplierRelationships)) {
    const item = itemNode(rel.itemId || rel.sku)
    const supplier = find('supplier', rel.supplierId || rel.supplierCode)
    addEdge(item, supplier, 'approved_supplier_relationship')
  }
  for (const po of array(context.purchaseOrders)) {
    const poNode = find('purchase_order', idOf('purchase_order', po))
    const prNode = find('purchase_request', po.sourcePrId || po.sourceRequest || po.purchaseRequestId)
    addEdge(prNode, poNode, 'converted_to_po'); addEdge(poNode, prNode, 'sourced_from_pr')
    for (const receipt of array(context.receipts).filter(row => same(row.poId || row.po || row.sourcePoId || row.purchaseOrderId, poNode?.entityId))) addEdge(poNode, find('receiving_doc', idOf('receiving_doc', receipt)), 'received_by')
  }
  for (const invoice of array(context.supplierInvoices)) {
    const invoiceNode = find('supplier_invoice', idOf('supplier_invoice', invoice))
    const receipt = find('receiving_doc', invoice.receiptId || invoice.grnId || invoice.relatedGrn)
    const po = find('purchase_order', invoice.poId || invoice.relatedPo || invoice.purchaseOrderId)
    addEdge(receipt, invoiceNode, 'invoiced_by'); addEdge(po, invoiceNode, 'invoiced_by')
  }

  const normalizedType = typeAliases[text(entityType).toLowerCase()] || text(entityType).toLowerCase()
  let anchor = find(normalizedType, entityId)
  if (!anchor && normalizedType === 'item') anchor = find('inventory_item', entityId)
  if (!anchor && normalizedType === 'inventory_item') anchor = find('item', entityId)
  if (!anchor) return { anchor: { entityType: normalizedType, entityId: text(entityId), type: normalizedType, id: text(entityId) }, nodes: [], edges: [], relatedRecords: {}, riskSignals: [], dataLimitations: ['record_not_found', ...array(context.dataLimitations)] }
  const connectedIds = new Set([anchor.entityId])
  edges.forEach(edge => { if (edge.from === anchor.entityId) connectedIds.add(edge.to); if (edge.to === anchor.entityId) connectedIds.add(edge.from) })
  const selectedNodes = nodes.filter(node => connectedIds.has(node.entityId))
  const selectedEdges = edges.filter(edge => connectedIds.has(edge.from) && connectedIds.has(edge.to))
  const relatedRecords = { salesOrders: [], purchaseRequests: [], rfqs: [], purchaseOrders: [], receivingDocs: [], supplierInvoices: [], suppliers: [], items: [], inventoryItems: [] }
  const bucket = { sales_order: 'salesOrders', purchase_request: 'purchaseRequests', rfq: 'rfqs', purchase_order: 'purchaseOrders', receiving_doc: 'receivingDocs', supplier_invoice: 'supplierInvoices', supplier: 'suppliers', item: 'items', inventory_item: 'inventoryItems' }
  for (const node of selectedNodes.filter(node => node !== anchor)) relatedRecords[bucket[node.entityType]]?.push({ id: node.entityId, label: node.label, entityType: node.entityType, canonicalRoute: node.canonicalRoute, sourceRepository: node.sourceRepository })
  const riskSignals = selectedNodes
    .filter(node => /blocked|high|shortage|low.stock|高风险|低库存|阻塞|异常|缺货/i.test(`${node.status} ${node.riskLevel} ${node.riskLabel}`))
    .map(node => ({ type: node.entityType, label: node.riskLabel || node.status || node.label, severity: /blocked|high|高风险|阻塞/i.test(`${node.status} ${node.riskLevel} ${node.riskLabel}`) ? 'high' : 'medium', summary: node.summary || `${node.label} 需要复核。`, affectedNodes: [node.entityId] }))
  return {
    anchor: { ...anchor, type: anchor.entityType, id: anchor.entityId },
    nodes: selectedNodes,
    edges: selectedEdges,
    relatedRecords,
    riskSignals,
    summary: { nodeCount: selectedNodes.length, edgeCount: selectedEdges.length, riskSignalCount: riskSignals.length, anchorLabel: anchor.label, topRiskLabel: riskSignals[0]?.label || '' },
    dataLimitations: [...new Set(array(context.dataLimitations))],
  }
}
