import { buildInventoryItems } from './inventory-read.mjs'
import { buildProcurementDocuments } from './procurement-read-model.mjs'
import {
  buildSalesDemandReadModel,
  getSalesOrderById,
  resolvePurchaseOrderSalesImpact,
  resolveSkuDemandImpact,
} from './sales-demand-read-model.mjs'
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
  return [...new Set(asArray(values).flat().map(text).filter(Boolean))]
}

function rowDateValue(value = '') {
  const raw = text(value)
  if (!raw) return 0
  const iso = raw.match(/^20\d{2}-\d{2}-\d{2}/)?.[0]
  if (iso) return new Date(`${iso}T00:00:00Z`).getTime()
  const chinese = raw.match(/(\d{1,2})月(\d{1,2})日/)
  if (chinese) return new Date(`2026-${String(chinese[1]).padStart(2, '0')}-${String(chinese[2]).padStart(2, '0')}T00:00:00Z`).getTime()
  return 0
}

function isOpenStatus(value = '') {
  return !/已完成|已取消|已关闭|已收货|closed|cancelled|fulfilled/i.test(text(value))
}

function poId(row = {}) {
  return text(row.id || row.po || row.poId)
}

function grnId(row = {}) {
  return text(row.id || row.grn || row.grnId)
}

function supplierId(row = {}) {
  return text(row.id || row.supplierId || row.name || row.supplierName)
}

function poMatchesSku(po = {}, sku = '') {
  const key = text(sku)
  if (!key) return false
  const fields = [po.sku, po.itemId, po.itemName, po.title, po.sourceSku, po.sourceName, po.id, po.po]
  const lines = asArray(po.lines).flatMap((line) => [line.sku, line.itemSku, line.itemName, line.name])
  return [...fields, ...lines].some((value) => text(value).includes(key))
}

function lineOpenQty(line = {}, po = {}) {
  const ordered = toNumber(line.quantityOrdered ?? line.quantity ?? line.qty ?? po.recommendedQty ?? po.items, 0)
  const received = toNumber(line.quantityReceived ?? line.receivedQty ?? line.received ?? po.received, 0)
  return Math.max(0, ordered - received)
}

function poOpenQty(po = {}, sku = '') {
  const lines = asArray(po.lines).filter((line) => !sku || text(line.sku || line.itemSku) === sku)
  if (lines.length) return lines.reduce((sum, line) => sum + lineOpenQty(line, po), 0)
  return Math.max(0, toNumber(po.orderedQuantity ?? po.recommendedQty ?? po.items ?? po.quantity, 0) - toNumber(po.receivedQuantity ?? po.received ?? po.receivedQty, 0))
}

function evidenceRoute(type = '', id = '') {
  const key = encodeURIComponent(text(id))
  if (type === 'inventory_availability' && key) return `/api/inventory/availability/${key}`
  if (type === 'sales_order' && key) return `/api/sales-demand/orders/${key}`
  if (type === 'po' && key) return `/api/procurement/documents/po/${key}`
  if (type === 'grn' && key) return `/api/procurement/documents/grn/${key}`
  if (type === 'supplier' && key) return `/api/master-data/suppliers/${key}`
  return ''
}

function evidenceItem(type, id, label, summary = '', status = '') {
  const key = text(id || label)
  if (!key) return null
  return { type, id: key, label: text(label || id), summary: text(summary), status: text(status), route: evidenceRoute(type, key) }
}

export function normalizeInventoryRecord(raw = {}, index = 0) {
  const item = buildInventoryItems({ products: [raw] })[0] || {}
  const sku = text(item.sku || raw.sku || raw.itemSku || raw.id, `SKU-ALLOC-${String(index + 1).padStart(4, '0')}`)
  return {
    sku,
    itemName: text(item.itemName || raw.itemName || raw.name, sku),
    unit: text(item.unit || raw.unit || raw.uom, '件'),
    warehouseId: text(item.defaultWarehouseId || raw.warehouseId || raw.warehouse || raw.location),
    onHandQty: toNumber(item.onHandQuantity ?? raw.onHandQty ?? raw.currentStock ?? raw.stock, 0),
    reservedQty: toNumber(item.reservedQuantity ?? raw.reservedQty ?? raw.allocatedQty, 0),
    availableQty: toNumber(item.availableQuantity ?? raw.availableQty ?? raw.available, 0),
    safetyStock: toNumber(item.safetyStock ?? raw.safetyStock, 0),
    reorderPoint: toNumber(item.reorderPoint ?? raw.reorderPoint, 0),
    supplier: text(item.supplier || raw.supplier || raw.supplierName),
    status: text(item.status || raw.status),
    riskLevel: text(item.riskLevel || raw.riskLevel),
  }
}

export function normalizeDemandAllocation(raw = {}) {
  const orderedQty = toNumber(raw.orderedQty ?? raw.quantity ?? raw.demandQty, 0)
  const fulfilledQty = toNumber(raw.fulfilledQty ?? raw.shippedQty, 0)
  const reservedQty = toNumber(raw.reservedQty ?? raw.allocatedQty ?? raw.reservedQuantity, 0)
  return {
    salesOrderId: text(raw.salesOrderId || raw.orderId || raw.so || raw.id),
    customerName: text(raw.customerName || raw.customer),
    customerTier: text(raw.customerTier || raw.tier),
    sku: text(raw.sku || raw.itemSku || raw.itemId),
    itemName: text(raw.itemName || raw.sourceName),
    orderedQty,
    fulfilledQty,
    reservedQty,
    openDemandQty: Math.max(0, orderedQty - fulfilledQty),
    shortageQty: Math.max(0, orderedQty - fulfilledQty - reservedQty),
    priority: text(raw.priority),
    deliveryRiskLevel: text(raw.deliveryRiskLevel || raw.riskLevel),
    promisedDate: text(raw.promisedDate || raw.deliveryDate || raw.eta),
    statusLabel: text(raw.statusLabel || raw.status),
  }
}

export function normalizeIncomingSupply(raw = {}, sku = '') {
  const id = poId(raw)
  return {
    poId: id,
    sku: text(sku || raw.sku || raw.sourceSku || raw.itemSku),
    supplierName: text(raw.supplierName || raw.supplier),
    status: text(raw.status),
    expectedDate: text(raw.expectedDate || raw.dueDate || raw.eta || raw.promisedDate),
    incomingQty: poOpenQty(raw, sku),
    isOverdue: false,
  }
}

function buildLinkedReceiving(procurementDocuments = [], poRows = []) {
  const poIds = new Set(poRows.map((po) => po.id))
  return procurementDocuments.filter((doc) => doc.documentType === 'grn' && (poIds.has(doc.linkedPo) || poIds.has(doc.poId) || poIds.has(doc.relatedPo)))
}

function buildSkuRows(db = {}) {
  const inventory = buildInventoryItems(db)
  const sales = buildSalesDemandReadModel(db)
  const procurementDocuments = buildProcurementDocuments(db)
  const skuSet = new Set([
    ...inventory.map((item) => text(item.sku)),
    ...sales.orders.map((order) => text(order.sku)),
    ...procurementDocuments.flatMap((doc) => [doc.sku, doc.sourceSku, ...asArray(doc.lines).map((line) => line.sku || line.itemSku)]).map(text).filter(Boolean),
  ])
  return [...skuSet]
}

function supplierMatches(name = '', supplier = {}) {
  const key = text(name).toLowerCase()
  return key && [supplier.id, supplier.name, supplier.supplierId, supplier.supplierName].some((value) => text(value).toLowerCase() === key)
}

function buildAvailabilityForSku(db = {}, sku = '', options = {}) {
  const todayValue = rowDateValue(options.today || options.now || '2026-07-03')
  const inventory = buildInventoryItems(db).find((item) => item.sku === sku) || null
  const salesModel = buildSalesDemandReadModel(db, options)
  const orders = salesModel.orders.filter((order) => order.sku === sku && !['已完成', '已取消'].includes(order.statusLabel))
  const procurementDocuments = buildProcurementDocuments(db)
  const poRows = procurementDocuments.filter((doc) => doc.documentType === 'po' && isOpenStatus(doc.status) && poMatchesSku(doc, sku))
  const receivingRows = buildLinkedReceiving(procurementDocuments, poRows)
  const suppliers = listMasterSuppliers(db)
  const supplierNames = unique([inventory?.supplier, poRows.map((po) => po.supplierName || po.supplier), orders.flatMap((order) => order.linkedSuppliers.map((supplier) => supplier.name || supplier.id))])
  const supplierRows = supplierNames.map((name) => suppliers.find((supplier) => supplierMatches(name, supplier)) || { id: name, name, risk: '' }).filter((supplier) => text(supplier.name || supplier.id))
  const demandRows = orders.map(normalizeDemandAllocation)
  const incomingRows = poRows.map((po) => {
    const row = normalizeIncomingSupply(po, sku)
    row.isOverdue = todayValue > 0 && rowDateValue(row.expectedDate) > 0 && rowDateValue(row.expectedDate) < todayValue
    return row
  })

  const onHandQty = toNumber(inventory?.onHandQuantity ?? inventory?.availableQuantity, 0)
  const reservedQty = Math.max(toNumber(inventory?.reservedQuantity, 0), demandRows.reduce((sum, order) => sum + toNumber(order.reservedQty), 0))
  const salesDemandQty = demandRows.reduce((sum, order) => sum + toNumber(order.openDemandQty), 0)
  const allocatedDemandQty = demandRows.reduce((sum, order) => sum + toNumber(order.reservedQty), 0)
  const incomingPurchaseQty = incomingRows.reduce((sum, po) => sum + toNumber(po.incomingQty), 0)
  const overdueIncomingQty = incomingRows.filter((po) => po.isOverdue).reduce((sum, po) => sum + toNumber(po.incomingQty), 0)
  const availableQty = Math.max(0, onHandQty - reservedQty)
  const openHighPriorityDemandQty = demandRows
    .filter((order) => order.priority === '高' || ['blocked', 'high'].includes(order.deliveryRiskLevel) || /重点客户/.test(order.customerTier))
    .reduce((sum, order) => sum + Math.max(0, order.openDemandQty - order.reservedQty), 0)
  const availableToPromiseQty = Math.max(0, onHandQty + incomingPurchaseQty - reservedQty - openHighPriorityDemandQty)
  const reservableQty = Math.max(0, onHandQty - reservedQty)
  const projectedAvailableQty = onHandQty + incomingPurchaseQty - salesDemandQty
  const safetyStock = toNumber(inventory?.safetyStock, 0)
  const reorderPoint = toNumber(inventory?.reorderPoint, safetyStock)
  const shortageQty = Math.max(0, salesDemandQty + safetyStock - onHandQty - incomingPurchaseQty)
  const dailyDemand = toNumber(options.dailyDemand || inventory?.dailyDemand, 0)
  const daysCover = dailyDemand > 0 ? Number((availableQty / dailyDemand).toFixed(1)) : null
  const dataLimitations = []
  if (!inventory) dataLimitations.push('missing_inventory_balance')
  if (!orders.length) dataLimitations.push('missing_sales_demand_records')
  if (!poRows.length && shortageQty > 0) dataLimitations.push('missing_purchase_order_links')
  if (poRows.length && !receivingRows.length) dataLimitations.push('missing_receiving_records')
  if (daysCover === null) dataLimitations.push('missing_daily_demand_history')
  if (!reservedQty && salesDemandQty > 0) dataLimitations.push('missing_reservation_records')
  if (salesModel.dataLimitations.includes('current_workspace_data_limited')) dataLimitations.push('current_workspace_data_limited')

  const blocked = shortageQty > 0 && demandRows.some((order) => order.priority === '高' || order.deliveryRiskLevel === 'blocked' || /重点客户/.test(order.customerTier))
  const riskLevel = blocked
    ? 'blocked'
    : shortageQty > 0 || projectedAvailableQty < 0
      ? 'high'
      : (availableQty < reorderPoint || (daysCover !== null && daysCover <= 7))
        ? 'medium'
        : 'low'
  const riskLabel = ({ blocked: '已阻塞', high: '高风险', medium: '需关注', low: '正常' })[riskLevel]
  const riskReason = riskLevel === 'blocked'
    ? '供需缺口已影响高优先级或重点销售订单。'
    : riskLevel === 'high'
      ? '当前销售需求、安全库存与在途采购计算后仍存在缺口。'
      : riskLevel === 'medium'
        ? '可用量低于再订货点或覆盖天数偏低。'
        : '当前库存、销售需求和在途采购未显示明显缺口。'
  const reservationSuggestedQty = Math.min(Math.max(0, toNumber(options.requestedQty, Math.max(0, salesDemandQty - allocatedDemandQty))), reservableQty)
  const reservationShortageQty = Math.max(0, toNumber(options.requestedQty, Math.max(0, salesDemandQty - allocatedDemandQty)) - reservationSuggestedQty)
  const conflictOrders = demandRows
    .filter((order) => order.shortageQty > 0 || order.reservedQty > 0)
    .sort((a, b) => toNumber(b.shortageQty) - toNumber(a.shortageQty))
    .slice(0, 5)

  const evidence = [
    evidenceItem('inventory_availability', sku, sku, `可用量 ${availableQty}，可承诺量 ${availableToPromiseQty}，缺口 ${shortageQty}`, riskLabel),
    ...orders.slice(0, 5).map((order) => evidenceItem('sales_order', order.salesOrderId, order.salesOrderId, `${order.customerName} 缺口 ${order.shortageQty}`, order.deliveryRiskLabel)),
    ...poRows.slice(0, 5).map((po) => evidenceItem('po', po.id, po.id, `${po.supplierName || po.supplier || ''} 在途 ${poOpenQty(po, sku)}`, po.status)),
    ...supplierRows.slice(0, 3).map((supplier) => evidenceItem('supplier', supplierId(supplier), supplier.name || supplier.id, supplier.risk || supplier.status, supplier.status)),
    ...receivingRows.slice(0, 3).map((grn) => evidenceItem('grn', grn.id, grn.id, grn.summary || grn.title, grn.status)),
  ].filter(Boolean)

  return {
    sku: text(sku),
    itemName: text(inventory?.itemName || orders[0]?.itemName || poRows[0]?.itemName, sku),
    unit: text(inventory?.unit || orders[0]?.unit, '件'),
    warehouseId: text(inventory?.defaultWarehouseId || inventory?.location),
    onHandQty,
    reservedQty,
    salesDemandQty,
    allocatedDemandQty,
    availableQty,
    availableToPromiseQty,
    reservableQty,
    reservationSuggestedQty,
    reservationShortageQty,
    reservationConflictOrders: conflictOrders,
    incomingPurchaseQty,
    overdueIncomingQty,
    projectedAvailableQty,
    shortageQty,
    safetyStock,
    reorderPoint,
    daysCover,
    riskLevel,
    riskLabel,
    riskReason,
    allocationPolicy: '人工复核优先：重点客户与高优先级订单优先分配，系统仅提供预留建议。',
    allocationExplanation: '可承诺量基于实物库存、已预留库存、销售订单需求和在途采购记录计算，不会自动锁定库存。',
    purchaseDelayImpact: overdueIncomingQty > 0 ? `已有 ${overdueIncomingQty} ${text(inventory?.unit, '件')} 在途采购逾期，需复核客户交付承诺。` : '当前未识别逾期在途采购。仍需结合供应商确认日期复核。',
    deliveryRiskPropagation: orders.length ? `影响 ${orders.length} 个销售订单，优先复核 ${orders[0].salesOrderId}。` : '当前工作区未找到关联销售订单。',
    affectedSalesOrders: orders,
    linkedPurchaseOrders: incomingRows,
    linkedSuppliers: supplierRows.map((supplier) => ({ id: supplierId(supplier), name: text(supplier.name || supplier.supplierName || supplier.id), risk: text(supplier.risk || supplier.riskStatus), status: text(supplier.status) })),
    linkedReceivingDocs: receivingRows.map((grn) => ({ id: grnId(grn), poId: text(grn.linkedPo || grn.poId || grn.relatedPo), status: text(grn.status) })),
    evidence,
    dataLimitations: unique(dataLimitations),
  }
}

export function buildInventoryAllocationReadModel(db = {}, options = {}) {
  const availability = buildSkuRows(db).map((sku) => buildAvailabilityForSku(db, sku, options))
    .sort((a, b) => ({ blocked: 4, high: 3, medium: 2, low: 1 }[b.riskLevel] || 0) - ({ blocked: 4, high: 3, medium: 2, low: 1 }[a.riskLevel] || 0) || b.shortageQty - a.shortageQty || text(a.sku).localeCompare(text(b.sku)))
  const risks = availability.filter((item) => ['blocked', 'high', 'medium'].includes(item.riskLevel))
  return {
    availability,
    allocation: availability,
    summary: buildInventoryAllocationSummaryFromRows(availability),
    risks,
    evidenceLinks: availability.flatMap((item) => item.evidence).slice(0, 40),
    dataLimitations: unique(availability.flatMap((item) => item.dataLimitations)),
  }
}

function buildInventoryAllocationSummaryFromRows(rows = []) {
  return {
    skuCount: rows.length,
    highRiskSkuCount: rows.filter((item) => ['blocked', 'high'].includes(item.riskLevel)).length,
    totalShortageQty: rows.reduce((sum, item) => sum + item.shortageQty, 0),
    reservedQty: rows.reduce((sum, item) => sum + item.reservedQty, 0),
    incomingPurchaseQty: rows.reduce((sum, item) => sum + item.incomingPurchaseQty, 0),
    atpInsufficientSkuCount: rows.filter((item) => item.availableToPromiseQty <= 0 && item.salesDemandQty > 0).length,
    projectedNegativeSkuCount: rows.filter((item) => item.projectedAvailableQty < 0).length,
  }
}

export function listSkuAvailability(db = {}, filters = {}) {
  const q = text(filters.q).toLowerCase()
  const risk = text(filters.risk)
  const limit = Math.max(0, toNumber(filters.limit, 0))
  const rows = buildInventoryAllocationReadModel(db, filters).availability.filter((row) => {
    const haystack = [row.sku, row.itemName, row.riskLabel, row.riskReason].join(' ').toLowerCase()
    return (!q || haystack.includes(q)) && (!risk || row.riskLevel === risk || row.riskLabel === risk)
  })
  return limit ? rows.slice(0, limit) : rows
}

export function getSkuAvailability(db = {}, sku = '', options = {}) {
  const key = decodeURIComponent(text(sku)).toLowerCase()
  return buildInventoryAllocationReadModel(db, options).availability.find((item) => text(item.sku).toLowerCase() === key || text(item.itemName).toLowerCase() === key) || null
}

export function buildInventoryAllocationSummary(db = {}) {
  return buildInventoryAllocationReadModel(db).summary
}

export function buildShortageRisks(db = {}, options = {}) {
  return buildInventoryAllocationReadModel(db, options).risks
}

export function resolveInventoryAllocationEvidence(db = {}, sku = '') {
  const availability = getSkuAvailability(db, sku)
  if (!availability) return { sku: text(sku), evidenceLinks: [], dataLimitations: ['record_not_found'] }
  return { sku: availability.sku, availability, evidenceLinks: availability.evidence, dataLimitations: availability.dataLimitations }
}

export function resolveDemandSupplyGap(db = {}, sku = '') {
  const availability = getSkuAvailability(db, sku)
  if (!availability) return { sku: text(sku), gap: null, evidenceLinks: [], dataLimitations: ['record_not_found'] }
  return {
    sku: availability.sku,
    gap: {
      salesDemandQty: availability.salesDemandQty,
      incomingPurchaseQty: availability.incomingPurchaseQty,
      projectedAvailableQty: availability.projectedAvailableQty,
      shortageQty: availability.shortageQty,
      riskLevel: availability.riskLevel,
      riskLabel: availability.riskLabel,
      affectedSalesOrders: availability.affectedSalesOrders,
      linkedPurchaseOrders: availability.linkedPurchaseOrders,
    },
    evidenceLinks: availability.evidence,
    dataLimitations: availability.dataLimitations,
  }
}

export function resolveAvailableToPromise(db = {}, sku = '', options = {}) {
  const availability = getSkuAvailability(db, sku, options)
  if (!availability) return { sku: text(sku), availableToPromiseQty: 0, evidenceLinks: [], dataLimitations: ['record_not_found'] }
  return {
    sku: availability.sku,
    availableToPromiseQty: availability.availableToPromiseQty,
    availableQty: availability.availableQty,
    reservableQty: availability.reservableQty,
    projectedAvailableQty: availability.projectedAvailableQty,
    explanation: availability.allocationExplanation,
    evidenceLinks: availability.evidence,
    dataLimitations: availability.dataLimitations,
  }
}

export function resolveSalesOrderAllocationImpact(db = {}, salesOrderId = '') {
  const order = getSalesOrderById(db, salesOrderId)
  if (!order) return { salesOrderId: text(salesOrderId), order: null, availability: null, evidenceLinks: [], dataLimitations: ['record_not_found'] }
  const availability = getSkuAvailability(db, order.sku, { requestedQty: order.orderedQty - order.reservedQty - order.fulfilledQty })
  return {
    salesOrderId: order.salesOrderId,
    order,
    availability,
    reservationPreview: buildReservationPreview(db, { sku: order.sku, salesOrderId: order.salesOrderId, requestedQty: order.orderedQty - order.reservedQty - order.fulfilledQty }),
    evidenceLinks: uniqueEvidence([...(order.evidence || []), ...(availability?.evidence || [])]),
    dataLimitations: unique([order.dataLimitations, availability?.dataLimitations]),
  }
}

export function resolvePurchaseOrderSupplyImpact(db = {}, poId = '') {
  const salesImpact = resolvePurchaseOrderSalesImpact(db, poId)
  const key = decodeURIComponent(text(poId)).toLowerCase()
  const model = buildInventoryAllocationReadModel(db)
  const impactedSkus = model.availability.filter((item) =>
    item.linkedPurchaseOrders.some((po) => text(po.poId).toLowerCase() === key)
  )
  return {
    poId: text(poId),
    impactedSkus,
    affectedSalesOrders: salesImpact.orders,
    evidenceLinks: uniqueEvidence([...impactedSkus.flatMap((item) => item.evidence), ...salesImpact.evidenceLinks]),
    dataLimitations: unique([impactedSkus.flatMap((item) => item.dataLimitations), salesImpact.dataLimitations, impactedSkus.length ? [] : ['missing_purchase_order_links']]),
  }
}

function uniqueEvidence(rows = []) {
  const seen = new Set()
  return asArray(rows).filter((row) => {
    const key = `${row.type}:${row.id}:${row.label}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  }).slice(0, 24)
}

export function buildReservationPreview(db = {}, { sku = '', salesOrderId = '', requestedQty = 0 } = {}) {
  const impact = salesOrderId ? resolveSkuDemandImpact(db, sku) : null
  const requested = Math.max(0, toNumber(requestedQty, 0))
  const availability = getSkuAvailability(db, sku, { requestedQty: requested })
  if (!availability) {
    return {
      sku: text(sku),
      salesOrderId: text(salesOrderId),
      requestedQty: requested,
      reservableQty: 0,
      reservationSuggestedQty: 0,
      reservationShortageQty: requested,
      reservationConflictOrders: [],
      allocationExplanation: '当前工作区缺少完整库存分配记录，因此可承诺量和预留建议需人工复核。',
      evidenceLinks: [],
      dataLimitations: ['record_not_found'],
    }
  }
  const order = salesOrderId ? availability.affectedSalesOrders.find((item) => item.salesOrderId === salesOrderId) : null
  const effectiveRequested = requested || Math.max(0, toNumber(order?.orderedQty, 0) - toNumber(order?.reservedQty, 0) - toNumber(order?.fulfilledQty, 0))
  const suggested = Math.min(effectiveRequested, availability.reservableQty)
  return {
    sku: availability.sku,
    salesOrderId: text(salesOrderId),
    requestedQty: effectiveRequested,
    reservableQty: availability.reservableQty,
    reservationSuggestedQty: suggested,
    reservationShortageQty: Math.max(0, effectiveRequested - suggested),
    reservationConflictOrders: (impact?.orders || availability.reservationConflictOrders)
      .filter((item) => !salesOrderId || item.salesOrderId !== salesOrderId)
      .slice(0, 5),
    allocationExplanation: `${availability.allocationExplanation} 仅预览，不会自动锁库。`,
    evidenceLinks: availability.evidence,
    dataLimitations: availability.dataLimitations,
  }
}
