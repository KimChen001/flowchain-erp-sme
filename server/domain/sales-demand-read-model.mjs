import { buildInventoryItems } from './inventory-read.mjs'
import { buildProcurementDocuments } from './procurement-read-model.mjs'
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

function unique(values) {
  return [...new Set(asArray(values).map(text).filter(Boolean))]
}

function rowDateValue(value = '') {
  const raw = text(value)
  if (!raw) return 0
  const iso = raw.match(/^20\d{2}-\d{2}-\d{2}/)?.[0]
  return iso ? new Date(`${iso}T00:00:00Z`).getTime() : 0
}

const STATUS_LABELS = Object.freeze({
  confirmed: '已确认',
  partially_allocated: '部分分配',
  shortage_risk: '缺货风险',
  ready_to_ship: '可发货',
  partially_shipped: '部分发货',
  fulfilled: '已完成',
  cancelled: '已取消',
})

const RISK_LABELS = Object.freeze({
  high: '高风险',
  medium: '需关注',
  low: '正常',
  blocked: '已阻塞',
})

function sourceRows(db = {}) {
  const rows = asArray(db.salesOrders).length
    ? db.salesOrders
    : asArray(db.salesDemand).length
      ? db.salesDemand
      : asArray(db.customerOrders)
  return asArray(rows)
}
function normalizeStatus(value = '', shortageQty = 0, reservedQty = 0, orderedQty = 0, fulfilledQty = 0) {
  const raw = text(value).toLowerCase()
  if (STATUS_LABELS[raw]) return raw
  if (['已取消', 'cancelled'].includes(raw)) return 'cancelled'
  if (['已完成', 'fulfilled'].includes(raw) || fulfilledQty >= orderedQty && orderedQty > 0) return 'fulfilled'
  if (shortageQty > 0) return 'shortage_risk'
  if (reservedQty >= orderedQty && orderedQty > 0) return 'ready_to_ship'
  if (reservedQty > 0) return 'partially_allocated'
  return 'confirmed'
}

function riskRank(level = '') {
  return ({ blocked: 4, high: 3, medium: 2, low: 1 })[text(level)] || 0
}

function supplierHasRisk(supplier = {}) {
  const value = text(supplier.risk || supplier.riskStatus || supplier.status)
  if (/低风险|正常|低|启用|合格/.test(value)) return false
  return /高风险|中风险|高|中|需关注|待复核|异常|阻塞|暂停/.test(value)
}

function normalizeRisk(row = {}, shortageQty = 0, linkedPoRows = [], supplierRows = []) {
  const explicit = text(row.deliveryRiskLevel || row.riskLevel).toLowerCase()
  if (RISK_LABELS[explicit]) return explicit
  const delayedPo = linkedPoRows.some((po) => /逾期|延期|延迟|待确认|部分/.test(text(po.status)) || rowDateValue(po.dueDate || po.expectedDate || po.eta) > rowDateValue(row.promisedDate))
  const supplierRisk = supplierRows.some(supplierHasRisk)
  if (shortageQty > 0 && delayedPo) return 'blocked'
  if (shortageQty > 0) return 'high'
  if (delayedPo || supplierRisk) return 'medium'
  return 'low'
}

function poMatchesSku(po = {}, sku = '') {
  const key = text(sku)
  if (!key) return false
  const fields = [po.sku, po.itemId, po.itemName, po.title, po.sourceSku, po.sourceName, po.id]
  const lines = asArray(po.lines).flatMap((line) => [line.sku, line.itemSku, line.itemName, line.name])
  return [...fields, ...lines].some((value) => text(value).includes(key))
}

function linkedPurchaseOrders(row = {}, procurementDocuments = []) {
  const explicit = unique(row.linkedPurchaseOrders || row.purchaseOrders || row.poIds || row.relatedPo || row.poId)
  const byId = procurementDocuments.filter((doc) => doc.documentType === 'po' && explicit.includes(doc.id))
  const bySku = procurementDocuments.filter((doc) => doc.documentType === 'po' && poMatchesSku(doc, row.sku))
  const all = [...byId, ...bySku]
  const seen = new Set()
  return all.filter((doc) => {
    if (seen.has(doc.id)) return false
    seen.add(doc.id)
    return true
  })
}

function linkedReceivingDocs(poRows = [], procurementDocuments = []) {
  const poIds = new Set(poRows.map((po) => po.id))
  return procurementDocuments.filter((doc) => doc.documentType === 'grn' && (poIds.has(doc.linkedPo) || poIds.has(doc.poId) || poIds.has(doc.relatedPo)))
}

function supplierMatches(rowSupplier = '', supplier = {}) {
  const key = text(rowSupplier).toLowerCase()
  if (!key) return false
  return [supplier.id, supplier.name, supplier.supplierId, supplier.supplierName].some((value) => text(value).toLowerCase() === key)
}

function linkedSuppliers(row = {}, poRows = [], suppliers = []) {
  const names = unique([row.supplier, row.supplierName, row.linkedSuppliers, poRows.map((po) => po.supplierName || po.supplier)])
  return names.map((name) => suppliers.find((supplier) => supplierMatches(name, supplier)) || { id: name, name, risk: '' }).filter((supplier) => text(supplier.name || supplier.id))
}

function evidenceRoute(type = '', id = '') {
  const key = encodeURIComponent(text(id))
  if (type === 'sales_order' && key) return `/api/sales-demand/orders/${key}`
  if (type === 'inventory_item' && key) return `/api/inventory/items/${key}`
  if (type === 'po' && key) return `/api/procurement/documents/po/${key}`
  if (type === 'grn' && key) return `/api/procurement/documents/grn/${key}`
  if (type === 'supplier' && key) return `/api/master-data/suppliers/${key}`
  return ''
}

function evidenceItem(type, id, label, summary = '', status = '') {
  if (!id && !label) return null
  const evidenceId = text(id || label)
  return { type, id: evidenceId, label: text(label || id), summary: text(summary), status: text(status), route: evidenceRoute(type, evidenceId) }
}

export function normalizeSalesOrder(raw = {}, context = {}, index = 0) {
  const sku = text(raw.sku || raw.itemSku || raw.itemId, `SKU-SALES-${String(index + 1).padStart(4, '0')}`)
  const inventory = context.inventoryItems.find((item) => item.sku === sku) || null
  const orderedQty = toNumber(raw.orderedQty ?? raw.quantity ?? raw.demandQty, 0)
  const fulfilledQty = toNumber(raw.fulfilledQty ?? raw.shippedQty, 0)
  const reservedQty = toNumber(raw.reservedQty ?? raw.allocatedQty ?? raw.reservedQuantity, inventory ? Math.min(orderedQty, toNumber(inventory.availableQuantity, 0)) : 0)
  const shortageQty = Math.max(0, orderedQty - reservedQty - fulfilledQty)
  const poRows = linkedPurchaseOrders({ ...raw, sku }, context.procurementDocuments)
  const receivingRows = linkedReceivingDocs(poRows, context.procurementDocuments)
  const supplierRows = linkedSuppliers(raw, poRows, context.suppliers)
  const status = normalizeStatus(raw.status, shortageQty, reservedQty, orderedQty, fulfilledQty)
  const deliveryRiskLevel = normalizeRisk(raw, shortageQty, poRows, supplierRows)
  const dataLimitations = []
  if (!inventory) dataLimitations.push('missing_inventory_allocation')
  if (!poRows.length && shortageQty > 0) dataLimitations.push('missing_purchase_order_links')
  if (poRows.length && !receivingRows.length) dataLimitations.push('missing_receiving_records')
  if (!supplierRows.length) dataLimitations.push('missing_supplier_risk_records')
  if (!context.hasExplicitSalesRows) dataLimitations.push('current_workspace_data_limited')
  const linkedInventory = inventory ? {
    sku: inventory.sku,
    itemName: inventory.itemName,
    availableQuantity: inventory.availableQuantity,
    reservedQuantity: inventory.reservedQuantity,
    safetyStock: inventory.safetyStock,
    status: inventory.status,
    riskLevel: inventory.riskLevel,
  } : null
  const riskReason = text(raw.deliveryRiskReason) ||
    (deliveryRiskLevel === 'blocked'
      ? '库存缺口叠加采购到货风险，承诺交付需优先复核。'
      : deliveryRiskLevel === 'high'
        ? '当前客户订单数量超过已预留数量，存在交付缺口。'
        : deliveryRiskLevel === 'medium'
          ? '采购在途或供应商风险可能影响承诺交付。'
          : '当前库存与采购证据未显示明显交付风险。')
  const salesOrderId = text(raw.salesOrderId || raw.orderId || raw.so || raw.id, `SO-READ-${String(index + 1).padStart(4, '0')}`)
  const evidence = [
    evidenceItem('sales_order', salesOrderId, salesOrderId, riskReason, STATUS_LABELS[status]),
    evidenceItem('inventory_item', sku, raw.itemName || inventory?.itemName || sku, linkedInventory ? `可用 ${linkedInventory.availableQuantity}，已预留 ${reservedQty}` : '当前工作区缺少完整库存分配记录', linkedInventory?.status),
    ...poRows.slice(0, 3).map((po) => evidenceItem('po', po.id, po.id, po.summary || po.title, po.status)),
    ...supplierRows.slice(0, 2).map((supplier) => evidenceItem('supplier', supplier.id || supplier.name, supplier.name || supplier.id, supplier.risk || supplier.riskStatus || supplier.status, supplier.status)),
    ...receivingRows.slice(0, 2).map((grn) => evidenceItem('grn', grn.id, grn.id, grn.summary || grn.title, grn.status)),
  ].filter(Boolean)

  return {
    salesOrderId,
    customerName: text(raw.customerName || raw.customer || raw.accountName, '未命名客户'),
    customerTier: text(raw.customerTier || raw.tier, '常规客户'),
    sku,
    itemName: text(raw.itemName || raw.sourceName || inventory?.itemName, sku),
    orderedQty,
    reservedQty,
    fulfilledQty,
    shortageQty,
    requestedDate: text(raw.requestedDate || raw.requiredDate || raw.needByDate),
    promisedDate: text(raw.promisedDate || raw.deliveryDate || raw.eta),
    status,
    statusLabel: STATUS_LABELS[status] || STATUS_LABELS.confirmed,
    priority: text(raw.priority, deliveryRiskLevel === 'high' || deliveryRiskLevel === 'blocked' ? '高' : deliveryRiskLevel === 'medium' ? '中' : '低'),
    deliveryRiskLevel,
    deliveryRiskLabel: RISK_LABELS[deliveryRiskLevel] || RISK_LABELS.low,
    deliveryRiskReason: riskReason,
    linkedInventory,
    linkedPurchaseOrders: poRows.map((po) => ({ id: po.id, supplierName: po.supplierName || po.supplier, status: po.status, expectedDate: po.expectedDate || po.dueDate || po.eta })),
    linkedSuppliers: supplierRows.map((supplier) => ({ id: text(supplier.id || supplier.supplierId || supplier.name), name: text(supplier.name || supplier.supplierName || supplier.id), risk: text(supplier.risk || supplier.riskStatus), status: text(supplier.status) })),
    linkedReceivingDocs: receivingRows.map((grn) => ({ id: grn.id, status: grn.status, poId: grn.linkedPo || grn.poId || grn.relatedPo })),
    linkedExceptionCases: asArray(raw.linkedExceptionCases || raw.exceptionCases).map(text).filter(Boolean),
    evidence,
    dataLimitations: unique(dataLimitations),
  }
}

export function buildSalesDemandReadModel(db = {}, options = {}) {
  const hasExplicitSalesRows = asArray(db.salesOrders).length > 0 || asArray(db.salesDemand).length > 0 || asArray(db.customerOrders).length > 0
  const context = {
    inventoryItems: buildInventoryItems(db),
    procurementDocuments: buildProcurementDocuments(db),
    suppliers: listMasterSuppliers(db),
    hasExplicitSalesRows,
    today: options.today || '2026-07-03',
  }
  const orders = sourceRows(db).map((row, index) => normalizeSalesOrder(row, context, index))
    .sort((a, b) => riskRank(b.deliveryRiskLevel) - riskRank(a.deliveryRiskLevel) || rowDateValue(a.promisedDate) - rowDateValue(b.promisedDate) || a.salesOrderId.localeCompare(b.salesOrderId))
  const risks = buildCustomerDeliveryRisksFromOrders(orders)
  const summary = summaryFromOrders(orders)
  return {
    orders,
    risks,
    summary,
    evidenceLinks: orders.flatMap((order) => order.evidence).slice(0, 24),
    dataLimitations: unique(orders.flatMap((order) => order.dataLimitations)),
  }
}

function summaryFromOrders(orders = []) {
  const risky = orders.filter((order) => ['blocked', 'high', 'medium'].includes(order.deliveryRiskLevel))
  return {
    totalOrders: orders.length,
    riskOrderCount: risky.length,
    highRiskOrderCount: orders.filter((order) => ['blocked', 'high'].includes(order.deliveryRiskLevel)).length,
    shortageQty: orders.reduce((sum, order) => sum + order.shortageQty, 0),
    reservedQty: orders.reduce((sum, order) => sum + order.reservedQty, 0),
    affectedCustomerCount: new Set(risky.map((order) => order.customerName)).size,
  }
}

function buildCustomerDeliveryRisksFromOrders(orders = []) {
  return orders
    .filter((order) => ['blocked', 'high', 'medium'].includes(order.deliveryRiskLevel))
    .map((order) => ({
      id: `sales-risk-${order.salesOrderId}`,
      salesOrderId: order.salesOrderId,
      customerName: order.customerName,
      sku: order.sku,
      itemName: order.itemName,
      promisedDate: order.promisedDate,
      shortageQty: order.shortageQty,
      deliveryRiskLevel: order.deliveryRiskLevel,
      deliveryRiskLabel: order.deliveryRiskLabel,
      reason: order.deliveryRiskReason,
      target: { module: 'sales', entityType: 'sales_order', entityId: order.salesOrderId },
      evidence: order.evidence.slice(0, 5),
      dataLimitations: order.dataLimitations,
    }))
}

export function listSalesOrders(db = {}, filters = {}) {
  const model = buildSalesDemandReadModel(db)
  const q = text(filters.q).toLowerCase()
  const risk = text(filters.risk)
  const status = text(filters.status)
  const sku = text(filters.sku).toLowerCase()
  const limit = Math.max(0, toNumber(filters.limit, 0))
  const rows = model.orders.filter((order) => {
    const haystack = [order.salesOrderId, order.customerName, order.sku, order.itemName, order.deliveryRiskReason].join(' ').toLowerCase()
    return (!q || haystack.includes(q)) &&
      (!risk || order.deliveryRiskLevel === risk || order.deliveryRiskLabel === risk) &&
      (!status || order.status === status || order.statusLabel === status) &&
      (!sku || order.sku.toLowerCase() === sku)
  })
  return limit ? rows.slice(0, limit) : rows
}

export function getSalesOrderById(db = {}, id = '') {
  const key = decodeURIComponent(text(id)).toLowerCase()
  return buildSalesDemandReadModel(db).orders.find((order) => [order.salesOrderId, order.customerName].some((value) => text(value).toLowerCase() === key)) || null
}

export function buildSalesDemandSummary(db = {}) {
  return buildSalesDemandReadModel(db).summary
}

export function buildCustomerDeliveryRisks(db = {}) {
  return buildSalesDemandReadModel(db).risks
}

export function resolveSalesDemandEvidence(db = {}, salesOrderId = '') {
  const order = getSalesOrderById(db, salesOrderId)
  if (!order) return { order: null, evidenceLinks: [], dataLimitations: ['record_not_found'] }
  return { order, evidenceLinks: order.evidence, dataLimitations: order.dataLimitations }
}

export function resolveSkuDemandImpact(db = {}, sku = '') {
  const key = decodeURIComponent(text(sku)).toLowerCase()
  const orders = buildSalesDemandReadModel(db).orders.filter((order) => order.sku.toLowerCase() === key)
  return {
    sku: text(sku),
    orders,
    summary: summaryFromOrders(orders),
    evidenceLinks: orders.flatMap((order) => order.evidence).slice(0, 12),
    dataLimitations: unique(orders.flatMap((order) => order.dataLimitations).concat(orders.length ? [] : ['record_not_found'])),
  }
}

export function resolvePurchaseOrderSalesImpact(db = {}, poId = '') {
  const key = decodeURIComponent(text(poId)).toLowerCase()
  const orders = buildSalesDemandReadModel(db).orders.filter((order) =>
    order.linkedPurchaseOrders.some((po) => text(po.id).toLowerCase() === key)
  )
  return {
    poId: text(poId),
    orders,
    summary: summaryFromOrders(orders),
    evidenceLinks: orders.flatMap((order) => order.evidence).slice(0, 12),
    dataLimitations: unique(orders.flatMap((order) => order.dataLimitations).concat(orders.length ? [] : ['missing_purchase_order_links'])),
  }
}
