import {
  buildProcurementDocuments,
  buildProcurementDocumentLinks,
  buildProcurementFollowups,
  buildProcurementSummary,
} from './procurement-read-model.mjs'
import {
  buildInventoryExceptions,
  buildInventoryItems,
  buildInventoryMovements,
  buildInventorySummary,
} from './inventory-read.mjs'
import { buildSalesDemandReadModel } from './sales-demand-read-model.mjs'
import { buildInventoryAllocationReadModel } from './inventory-allocation-read-model.mjs'

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

function rowDateValue(value = '') {
  const raw = text(value)
  if (!raw) return 0
  const iso = raw.match(/^20\d{2}-\d{2}-\d{2}/)?.[0]
  if (iso) return new Date(`${iso}T00:00:00Z`).getTime()
  const chinese = raw.match(/(\d{1,2})月(\d{1,2})日/)
  if (chinese) {
    return new Date(`2026-${String(chinese[1]).padStart(2, '0')}-${String(chinese[2]).padStart(2, '0')}T00:00:00Z`).getTime()
  }
  return 0
}

function severityRank(value = '') {
  if (['high', '高'].includes(text(value))) return 3
  if (['medium', '中'].includes(text(value))) return 2
  if (['low', '低'].includes(text(value))) return 1
  return 0
}

function isOpenStatus(status = '') {
  return !['已完成', '已取消', '已关闭', '已收货', '已转PO', '已授标'].includes(text(status))
}

function evidenceTarget(module, entityType, entityId) {
  return { module, entityType, entityId: text(entityId) }
}

function procurementRoute(type, id) {
  return type && id ? `/api/procurement/documents/${type}/${encodeURIComponent(id)}` : ''
}

function inventoryRoute(kind, id = '') {
  if (kind === 'item' && id) return `/api/inventory/items/${encodeURIComponent(id)}`
  if (kind === 'movement') return '/api/inventory/movements'
  if (kind === 'exception') return '/api/inventory/exceptions'
  return '/api/inventory/items'
}

function firstEvidence(items) {
  return asArray(items).filter(Boolean).slice(0, 3)
}

function card(id, title, value, subtitle, severity, module, target, evidence = [], extra = {}) {
  return {
    id,
    title,
    value,
    subtitle,
    severity,
    module,
    evidence: firstEvidence(evidence),
    target,
    route: target?.entityType?.startsWith('procurement') ? procurementRoute(target.documentType, target.entityId) : '',
    ...extra,
  }
}

function buildSummaryCards(summary, procurementDocuments, followups, inventoryRisks, salesRisks = [], allocationRisks = []) {
  const firstByType = (type) => procurementDocuments.find((item) => item.documentType === type && isOpenStatus(item.status || item.invoiceStatus || item.matchStatus))
  const openPr = firstByType('pr')
  const openRfq = firstByType('rfq')
  const openPo = firstByType('po')
  const openGrn = firstByType('grn')
  const matchException = procurementDocuments.find((item) =>
    ['invoice', 'threeWayMatch'].includes(item.documentType) &&
    (toNumber(item.varianceAmount) !== 0 || /差异|异常|待复核/.test(text(item.matchStatus || item.status)))
  )
  const urgent = followups.find((item) => item.severity === 'high') || followups[0]
  const inventoryRisk = inventoryRisks[0]

  return [
    card('customer-delivery-risk', '客户交付风险', summary.customerDeliveryRiskCount || 0, '客户订单缺口与承诺交付风险', summary.highRiskSalesOrderCount ? 'high' : summary.customerDeliveryRiskCount ? 'medium' : 'low', 'sales', evidenceTarget('sales', 'sales_order', salesRisks[0]?.salesOrderId), salesRisks[0]?.evidence, { route: 'sales' }),
    card('inventory-allocation-risk', '库存分配风险', summary.inventoryAllocationRiskCount || 0, '库存占用、可承诺量与预留冲突', allocationRisks[0]?.riskLevel === 'blocked' ? 'high' : summary.inventoryAllocationRiskCount ? 'medium' : 'low', 'inventory', evidenceTarget('inventory', 'inventory_item', allocationRisks[0]?.sku), allocationRisks[0]?.evidence, { route: inventoryRoute('item', allocationRisks[0]?.sku), riskType: 'inventory_allocation_risk' }),
    card('available-to-promise-risk', '可承诺量风险', summary.atpInsufficientSkuCount || 0, '客户订单占用后的可承诺量不足', summary.atpInsufficientSkuCount ? 'high' : 'low', 'inventory', evidenceTarget('inventory', 'inventory_item', allocationRisks[0]?.sku), allocationRisks[0]?.evidence, { route: inventoryRoute('item', allocationRisks[0]?.sku), riskType: 'available_to_promise_risk' }),
    card('demand-supply-gap', '供需缺口', summary.totalInventoryShortageQty || 0, '销售需求、安全库存与在途采购缺口', summary.totalInventoryShortageQty ? 'high' : 'low', 'inventory', evidenceTarget('inventory', 'inventory_item', allocationRisks[0]?.sku), allocationRisks[0]?.evidence, { route: inventoryRoute('item', allocationRisks[0]?.sku), riskType: 'demand_supply_gap' }),
    card('open-prs', '待处理采购申请', summary.openPrCount, '等待采购审批或转单', summary.openPrCount ? 'medium' : 'low', 'procurement', { ...evidenceTarget('procurement:requests', 'procurement_document', openPr?.id), documentType: 'pr' }, openPr?.evidence),
    card('active-rfqs', '进行中询价', summary.activeRfqCount, '待报价、比价或授标', summary.activeRfqCount ? 'medium' : 'low', 'procurement', { ...evidenceTarget('procurement:rfq', 'procurement_document', openRfq?.id), documentType: 'rfq' }, openRfq?.evidence),
    card('open-pos', '未关闭采购订单', summary.openPoCount, '未关闭采购订单', summary.openPoCount ? 'medium' : 'low', 'procurement', { ...evidenceTarget('procurement:orders', 'procurement_document', openPo?.id), documentType: 'po' }, openPo?.evidence),
    card('pending-receiving', '待收货复核', summary.pendingReceivingCount, '待收货或待复核 GRN', summary.pendingReceivingCount ? 'medium' : 'low', 'procurement', { ...evidenceTarget('procurement:receiving', 'procurement_document', openGrn?.id), documentType: 'grn' }, openGrn?.evidence),
    card('match-exceptions', '三单匹配异常', summary.invoiceExceptionCount + summary.threeWayMatchExceptionCount, '发票与三单匹配差异', summary.invoiceExceptionCount || summary.threeWayMatchExceptionCount ? 'high' : 'low', 'finance', { ...evidenceTarget('procurement:invoices', 'procurement_document', matchException?.id), documentType: matchException?.documentType }, matchException?.evidence),
    card('inventory-risk', '库存风险', summary.lowStockCount + summary.inventoryExceptionCount, '低库存、缺货或库存异常', summary.highRiskInventoryCount ? 'high' : summary.lowStockCount ? 'medium' : 'low', 'inventory', evidenceTarget('inventory', 'inventory_item', inventoryRisk?.sku), inventoryRisk?.evidence, { route: inventoryRisk?.route || inventoryRoute('item', inventoryRisk?.sku) }),
    card('urgent-followups', '紧急跟进事项', summary.urgentFollowupCount, '高优先级采购跟进', summary.urgentFollowupCount ? 'high' : 'low', 'procurement', { ...evidenceTarget('procurement', 'followup', urgent?.id), documentType: urgent?.documentType, entityId: urgent?.documentId }, urgent?.evidence),
    card('total-open-amount', '未结业务金额', summary.totalOpenAmount, 'PR、PO、发票开放金额', summary.totalOpenAmount ? 'medium' : 'low', 'finance', evidenceTarget('finance', 'amount', 'total-open-amount'), [], { valueKind: 'currency', currency: summary.currency || null, currencyAggregationStatus: summary.currencyAggregationStatus || 'no_currency_data' }),
  ]
}

function buildInventoryRisks(items, exceptions) {
  const itemRisks = items
    .filter((item) => ['低库存', '缺货', '不足', '预警', '异常'].includes(item.status) || ['高', '中'].includes(item.riskLevel))
    .map((item) => ({
      id: `inventory-risk-${item.sku}`,
      type: 'stock_risk',
      sku: item.sku,
      itemName: item.itemName,
      warehouse: item.defaultWarehouseId || item.location,
      availableQuantity: item.availableQuantity,
      reorderPoint: item.reorderPoint,
      safetyStock: item.safetyStock,
      unit: item.unit,
      severity: item.riskLevel === '高' || item.status === '缺货' ? 'high' : 'medium',
      status: item.status,
      nextAction: item.availableQuantity <= 0 ? '复核缺货并准备补货 PR' : '复核库存覆盖与再订货点',
      route: inventoryRoute('item', item.sku),
      target: evidenceTarget('inventory', 'inventory_item', item.sku),
      evidence: [
        { type: 'inventory_item', id: item.sku, label: item.itemName, status: item.status, route: inventoryRoute('item', item.sku), summary: item.riskReason },
      ],
    }))

  const exceptionRisks = exceptions
    .filter((item) => item.status !== '已关闭')
    .map((item) => ({
      id: `inventory-exception-${item.id}`,
      type: 'inventory_exception',
      sku: item.sku,
      itemName: item.itemName,
      warehouse: item.warehouse,
      availableQuantity: null,
      reorderPoint: null,
      safetyStock: null,
      unit: item.unit,
      severity: Math.abs(toNumber(item.quantityImpact)) > 0 ? 'medium' : 'low',
      status: item.status,
      nextAction: item.nextAction || '复核库存异常证据',
      route: inventoryRoute('exception'),
      target: evidenceTarget('inventory:exceptions', 'inventory_exception', item.id),
      evidence: [
        { type: 'inventory_exception', id: item.id, label: item.type, status: item.status, route: inventoryRoute('exception'), summary: item.reason || item.linkedDocument },
      ],
    }))

  return [...itemRisks, ...exceptionRisks]
    .sort((a, b) => severityRank(b.severity) - severityRank(a.severity) || text(a.sku).localeCompare(text(b.sku)) || text(a.id).localeCompare(text(b.id)))
    .slice(0, 8)
}

function buildRecentDocuments(documents) {
  const typeOrder = new Map([['pr', 1], ['rfq', 2], ['po', 3], ['grn', 4], ['invoice', 5], ['threeWayMatch', 6]])
  return documents
    .map((document) => {
      const date = text(document.updatedAt || document.createdAt || document.dueDate || document.expectedDate || document.requiredDate)
      return {
        type: document.documentType,
        id: document.id,
        title: document.title || document.label || document.id,
        status: document.status || document.invoiceStatus || document.matchStatus || '',
        supplier: document.supplierName || document.supplier || '',
        amount: toNumber(document.amount ?? document.invoiceAmount ?? document.poAmount, 0),
        currency: document.currency || '',
        date,
        route: procurementRoute(document.documentType, document.id),
        target: { ...evidenceTarget('procurement', 'procurement_document', document.id), documentType: document.documentType },
        evidence: firstEvidence(document.evidence),
      }
    })
    .sort((a, b) => rowDateValue(b.date) - rowDateValue(a.date) || (typeOrder.get(a.type) || 99) - (typeOrder.get(b.type) || 99) || a.id.localeCompare(b.id))
    .slice(0, 10)
}

function buildRecentMovements(movements) {
  return movements
    .map((movement) => ({
      id: movement.movementId,
      type: movement.movementType,
      label: movement.movementLabel,
      sku: movement.sku,
      itemName: movement.itemName,
      warehouse: movement.warehouse,
      sourceDocument: movement.sourceDocument,
      quantityIn: movement.quantityIn,
      quantityOut: movement.quantityOut,
      adjustmentQty: movement.adjustmentQty,
      unit: movement.unit,
      status: movement.status,
      date: movement.date,
      route: inventoryRoute('movement'),
      target: evidenceTarget('inventory:movements', 'inventory_movement', movement.movementId),
      evidence: firstEvidence([
        { type: 'inventory_movement', id: movement.movementId, label: movement.movementLabel, status: movement.status, route: inventoryRoute('movement'), summary: movement.sourceDocument },
      ]),
    }))
    .sort((a, b) => rowDateValue(b.date) - rowDateValue(a.date) || a.id.localeCompare(b.id))
    .slice(0, 8)
}

function buildRecommendedActions({ followups, inventoryRisks, summary, recentDocuments, salesRisks = [], allocationRisks = [] }) {
  const actions = []
  const salesRisk = salesRisks[0]
  if (salesRisk) {
    actions.push({
      id: `action-sales-${salesRisk.salesOrderId}`,
      priority: salesRisk.deliveryRiskLevel === 'blocked' ? 'high' : salesRisk.deliveryRiskLevel,
      title: `${salesRisk.salesOrderId} 客户交付风险`,
      reason: salesRisk.reason,
      nextAction: '先复核客户订单、库存分配、采购在途和供应商风险',
      module: 'sales',
      route: 'sales',
      target: evidenceTarget('sales', 'sales_order', salesRisk.salesOrderId),
      evidence: firstEvidence(salesRisk.evidence),
      category: salesRisk.shortageQty > 0 ? 'sales_order_shortage' : 'customer_delivery_risk',
    })
  }
  const urgent = followups.find((item) => item.severity === 'high') || followups[0]
  if (urgent) {
    actions.push({
      id: `action-${urgent.id}`,
      priority: urgent.severity,
      title: urgent.title,
      reason: urgent.summary || urgent.message,
      nextAction: urgent.type === 'invoice_variance' ? '复核 PO、GRN 与发票差异' : '打开采购单据并确认责任人与截止日期',
      module: 'procurement',
      route: procurementRoute(urgent.documentType, urgent.documentId),
      target: { ...evidenceTarget('procurement', 'followup', urgent.documentId), documentType: urgent.documentType },
      evidence: firstEvidence(urgent.evidence),
    })
  }
  const inventoryRisk = inventoryRisks[0]
  const allocationRisk = allocationRisks[0]
  if (allocationRisk) {
    actions.push({
      id: `action-allocation-${allocationRisk.sku}`,
      priority: allocationRisk.riskLevel === 'blocked' ? 'high' : allocationRisk.riskLevel,
      title: `${allocationRisk.sku} 库存分配风险`,
      reason: `${allocationRisk.riskReason} 可用量 ${allocationRisk.availableQty}，可承诺量 ${allocationRisk.availableToPromiseQty}，缺口 ${allocationRisk.shortageQty}。`,
      nextAction: '先复核客户订单、可承诺量、在途采购和预留冲突，再生成内部通知草稿预览',
      module: 'inventory',
      route: inventoryRoute('item', allocationRisk.sku),
      target: evidenceTarget('inventory', 'inventory_item', allocationRisk.sku),
      evidence: firstEvidence(allocationRisk.evidence),
      category: allocationRisk.availableToPromiseQty <= 0 ? 'available_to_promise_risk' : 'inventory_allocation_risk',
      workItemType: allocationRisk.shortageQty > 0 ? 'demand_supply_gap' : 'reservation_conflict_risk',
      affectedSalesOrders: allocationRisk.affectedSalesOrders.map((order) => order.salesOrderId),
      linkedPurchaseOrders: allocationRisk.linkedPurchaseOrders.map((po) => po.poId),
      linkedSuppliers: allocationRisk.linkedSuppliers.map((supplier) => supplier.name || supplier.id),
      dataLimitations: allocationRisk.dataLimitations,
      notificationDraftPreview: {
        label: '生成内部通知草稿',
        externalSendEnabled: false,
        reviewRequired: true,
        message: '系统仅生成内部通知草稿，不会自动发送到外部协同工具。',
      },
    })
  }
  if (inventoryRisk) {
    actions.push({
      id: `action-${inventoryRisk.id}`,
      priority: inventoryRisk.severity,
      title: `${inventoryRisk.sku || inventoryRisk.id} 库存风险复核`,
      reason: `${inventoryRisk.status || '待复核'} · 可用 ${inventoryRisk.availableQuantity ?? '—'} · 安全库存 ${inventoryRisk.safetyStock ?? '—'}`,
      nextAction: inventoryRisk.nextAction,
      module: 'inventory',
      route: inventoryRisk.route,
      target: inventoryRisk.target,
      evidence: firstEvidence(inventoryRisk.evidence),
    })
  }
  if (summary.invoiceExceptionCount || summary.threeWayMatchExceptionCount) {
    const invoice = recentDocuments.find((item) => ['invoice', 'threeWayMatch'].includes(item.type))
    actions.push({
      id: 'action-three-way-match',
      priority: 'high',
      title: '三单匹配异常复核',
      reason: `${summary.invoiceExceptionCount + summary.threeWayMatchExceptionCount} 个发票或匹配差异待处理`,
      nextAction: '按金额与差异类型复核匹配证据',
      module: 'finance',
      route: invoice?.route || '',
      target: invoice?.target || evidenceTarget('procurement:invoices', 'procurement_document', 'three-way-match'),
      evidence: firstEvidence(invoice?.evidence),
    })
  }
  if (summary.activeRfqCount) {
    const rfq = recentDocuments.find((item) => item.type === 'rfq')
    actions.push({
      id: 'action-active-rfq',
      priority: 'medium',
      title: 'RFQ 回复与授标节奏复核',
      reason: `${summary.activeRfqCount} 个 RFQ 仍在进行中`,
      nextAction: '确认待回复供应商、最佳报价和授标依据',
      module: 'procurement',
      route: rfq?.route || '',
      target: rfq?.target || evidenceTarget('procurement:rfq', 'procurement_document', ''),
      evidence: firstEvidence(rfq?.evidence),
    })
  }
  return actions.slice(0, 6)
}

function buildEvidence({ procurementDocuments, followups, inventoryRisks, recentMovements, links, salesRisks = [] }) {
  const procurementEvidence = procurementDocuments.flatMap((item) => asArray(item.evidence)).slice(0, 12)
  const followupEvidence = followups.map((item) => item.evidence).filter(Boolean).slice(0, 8)
  const inventoryEvidence = inventoryRisks.flatMap((item) => asArray(item.evidence)).slice(0, 8)
  const movementEvidence = recentMovements.flatMap((item) => asArray(item.evidence)).slice(0, 8)
  return {
    sales: salesRisks.flatMap((item) => asArray(item.evidence)).slice(0, 8),
    procurement: procurementEvidence,
    followups: followupEvidence,
    inventory: inventoryEvidence,
    movements: movementEvidence,
    links: asArray(links).slice(0, 20),
  }
}

export function buildTodayCockpit(data = {}, options = {}) {
  const procurementDocuments = buildProcurementDocuments(data)
  const procurementSummary = buildProcurementSummary(data)
  const followups = buildProcurementFollowups(data, options)
    .sort((a, b) => severityRank(b.severity) - severityRank(a.severity) || rowDateValue(a.dueDate) - rowDateValue(b.dueDate) || a.id.localeCompare(b.id))
  const inventoryItems = buildInventoryItems(data)
  const inventoryMovements = buildInventoryMovements(data)
  const inventoryExceptions = buildInventoryExceptions(data)
  const inventorySummary = buildInventorySummary(data)
  const inventoryRisks = buildInventoryRisks(inventoryItems, inventoryExceptions)
  const salesDemand = buildSalesDemandReadModel(data, options)
  const salesRisks = salesDemand.risks
  const allocationModel = buildInventoryAllocationReadModel(data, options)
  const allocationRisks = allocationModel.risks.slice(0, 5)
  const summary = {
    ...procurementSummary,
    customerDeliveryRiskCount: salesDemand.summary.riskOrderCount,
    highRiskSalesOrderCount: salesDemand.summary.highRiskOrderCount,
    salesShortageQty: salesDemand.summary.shortageQty,
    affectedSalesCustomerCount: salesDemand.summary.affectedCustomerCount,
    lowStockCount: inventorySummary.lowStockCount,
    highRiskInventoryCount: inventorySummary.highRiskCount,
    inventoryExceptionCount: inventorySummary.exceptionCount,
    movementCount: inventorySummary.movementCount,
    inventoryAllocationRiskCount: allocationRisks.length,
    atpInsufficientSkuCount: allocationModel.summary.atpInsufficientSkuCount,
    reservationConflictRiskCount: allocationRisks.filter((item) => item.reservationConflictOrders.length > 1).length,
    totalInventoryShortageQty: allocationModel.summary.totalShortageQty,
  }
  const recentDocuments = buildRecentDocuments(procurementDocuments)
  const recentMovements = buildRecentMovements(inventoryMovements)
  const cards = buildSummaryCards(summary, procurementDocuments, followups, inventoryRisks, salesRisks, allocationRisks)
  const recommendedActions = buildRecommendedActions({ followups, inventoryRisks, summary, recentDocuments, salesRisks, allocationRisks })

  return {
    summary,
    cards,
    followups: followups.slice(0, 8),
    salesRisks: salesRisks.slice(0, 5),
    allocationRisks,
    inventoryRisks,
    recentDocuments,
    recentMovements,
    recommendedActions,
    evidence: buildEvidence({
      procurementDocuments,
      followups,
      inventoryRisks,
      recentMovements,
      salesRisks,
      links: buildProcurementDocumentLinks(data),
    }),
  }
}
