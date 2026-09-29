import {
  buildProcurementDocuments,
  buildProcurementSupplierInvoices,
  buildProcurementThreeWayMatches,
} from './procurement-read-model.mjs'
import { buildInventoryItems } from './inventory-read.mjs'
import { isOpenPurchaseOrder } from './open-purchase-order.mjs'
import { buildSupplierEntityIndex } from './ai-supplier-operational-query.mjs'
import { buildOperationsControlTowerV2 } from './operations-control-tower-v2.mjs'
import { buildDataAccessQualityV2 } from './data-access-quality-v2.mjs'

export const FORBIDDEN_REPORTS_ACTION_PATTERN = /自动发送报表|创建报表订阅|外发邮件|导出正式财务报表|生成审计报告|自动批准|自动下单|发送\s*PO|发布\s*RFQ|提交收货|库存过账|发票过账|付款|会计过账|修改供应商主数据|自动修复数据|自动提交导入|自动覆盖数据|Post Invoice|Approve Invoice|Mark as Paid|Payment execution|Export to Accounting/i
export const FORBIDDEN_REPORTS_TECHNICAL_PATTERN = /JSON|dry-run|tenantId|userId|datasetId|writesDb|writesFiles|DB|tool_result|provider|fallback|deterministic|mock|fake|demo|UAT|sample data|demo data|response_card|entityType|documentType|raw enum/i

function asArray(value) { return Array.isArray(value) ? value : [] }
function text(value, fallback = '') {
  const next = String(value ?? '').trim()
  return next || fallback
}
function number(value, fallback = 0) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}
function money(value = 0, currency = 'CNY') {
  return `${currency === 'CNY' ? '¥' : `${currency} `}${number(value, 0).toLocaleString()}`
}
function compact(value = '') {
  return text(value).toLowerCase().replace(/[^\w\u4e00-\u9fa5-]+/g, '')
}
function unique(items = []) {
  return [...new Set(items.filter(Boolean))]
}
function severityRank(value = '') {
  if (/P0|high|高|critical|阻断/i.test(text(value))) return 3
  if (/P1|warning|中|需复核|提醒/i.test(text(value))) return 2
  return 1
}
function moduleFor(type = '') {
  if (type === 'pr') return 'procurement:requests'
  if (type === 'rfq') return 'procurement:rfq'
  if (type === 'po') return 'procurement:orders'
  if (type === 'grn') return 'procurement:receiving'
  if (type === 'invoice' || type === 'match') return 'procurement:invoices'
  if (type === 'supplier') return 'srm:master'
  if (type === 'inventory') return 'inventory'
  if (type === 'operations') return 'overview:risks'
  if (type === 'data_quality') return 'imports'
  return 'reports'
}
function entityTypeFor(type = '') {
  if (type === 'pr') return 'purchase_request'
  if (type === 'rfq') return 'rfq'
  if (type === 'po') return 'purchase_order'
  if (type === 'grn') return 'receiving_doc'
  if (type === 'invoice' || type === 'match') return 'supplier_invoice'
  if (type === 'supplier') return 'supplier'
  if (type === 'inventory') return 'inventory_item'
  if (type === 'operations') return 'operations_control_tower'
  if (type === 'data_quality') return 'data_quality_issue'
  return 'report_metric'
}
function objectLabel(type = '', id = '') {
  if (type === 'pr') return `PR ${id}`.trim()
  if (type === 'rfq') return `RFQ ${id}`.trim()
  if (type === 'po') return `PO ${id}`.trim()
  if (type === 'grn') return `GRN ${id}`.trim()
  if (type === 'invoice') return `Invoice ${id}`.trim()
  if (type === 'match') return `三单匹配 ${id}`.trim()
  if (type === 'supplier') return `供应商 ${id}`.trim()
  if (type === 'inventory') return `SKU ${id}`.trim()
  if (type === 'operations') return '风险与异常'
  if (type === 'data_quality') return 'Data Access & Quality'
  return 'Reports & Analytics'
}
function nav(label, type, id, reason = '') {
  return {
    label,
    moduleId: moduleFor(type),
    entityType: entityTypeFor(type),
    entityId: id || undefined,
    entityLabel: objectLabel(type, id),
    returnTo: 'reports',
    source: 'reportsAnalytics',
    reason,
  }
}
function limitation(label, description, affectedMetrics = []) {
  return { label, description, severity: 'warning', affectedMetrics }
}
function insight(input) {
  return {
    title: input.title,
    insightType: input.insightType,
    severity: input.severity || 'warning',
    conclusion: input.conclusion,
    keyEvidence: input.keyEvidence || [],
    businessImpact: input.businessImpact,
    suggestedAction: input.suggestedAction,
    reviewOnlyAction: {
      label: input.reviewOnlyAction || '生成内部复核备注草稿预览',
      previewOnly: true,
      requiresHumanReview: true,
      boundary: '仅内部复核 · 草稿预览 · 不形成正式财务报表 · 不形成审计报告 · 不外发',
    },
    navigationLinks: input.navigationLinks || [],
    dataLimitations: input.dataLimitations || [],
  }
}
function stage(input) {
  return {
    stage: input.stage,
    label: input.label,
    count: input.count,
    riskCount: input.riskCount || 0,
    blockedCount: input.blockedCount || 0,
    amount: input.amount || 0,
    averageAgeLabel: input.averageAgeLabel || '当前周期',
    topIssue: input.topIssue || '当前无明显瓶颈',
    navigationLinks: input.navigationLinks || [],
    dataLimitations: input.dataLimitations || [],
  }
}

function supplierKey(value = '') {
  return compact(value)
}
function countBySupplier(items = [], key = 'supplier') {
  const map = new Map()
  for (const item of items) {
    const supplier = text(item[key] || item.supplierName || item.bestSupplier)
    if (!supplier) continue
    const id = supplierKey(supplier)
    if (!map.has(id)) map.set(id, { name: supplier, count: 0, items: [] })
    const row = map.get(id)
    row.count += 1
    row.items.push(item)
  }
  return map
}

function buildP2pPipeline({ docs, purchaseOrders, receivingDocs, invoices, matches, rfqs, dataQuality }) {
  const prs = docs.filter((doc) => doc.type === 'purchase_request')
  const poAmount = purchaseOrders.reduce((sum, po) => sum + number(po.amount || po.totalAmount, 0), 0)
  const invoiceCount = Math.max(invoices.length, dataQuality.qualityIssues.filter((issue) => issue.category === 'missing_invoice_line').length)
  const matchVarianceCount = Math.max(matches.filter((item) => severityRank(item.severity || item.status) >= 2).length, dataQuality.qualityIssues.filter((issue) => /invoice|grn|match/i.test(issue.category)).length)
  return [
    stage({ stage: 'PR', label: 'PR', count: prs.length, riskCount: prs.filter((doc) => /高|urgent|high/i.test(text(doc.priority))).length, amount: prs.reduce((sum, doc) => sum + number(doc.amount, 0), 0), topIssue: prs.some((doc) => !doc.linkedRfq && !doc.linkedPo) ? 'PR → RFQ / PO 关系需复核' : 'PR 链路可追踪', navigationLinks: [nav('打开 PR 列表', 'pr', '')] }),
    stage({ stage: 'RFQ', label: 'RFQ', count: rfqs.length, riskCount: rfqs.filter((rfq) => number(rfq.quoted, 0) < number(rfq.suppliers, 0)).length, amount: rfqs.reduce((sum, rfq) => sum + number(rfq.bestPrice, 0) * number(rfq.quantity, 0), 0), topIssue: '供应商回复完整性影响比价', navigationLinks: [nav('打开 RFQ', 'rfq', rfqs[0]?.id)] }),
    stage({ stage: 'PO', label: 'PO', count: purchaseOrders.length, riskCount: purchaseOrders.filter((po) => /待审批|高|open/i.test(`${po.status} ${po.priority} ${po.erpStatus}`)).length, amount: poAmount, topIssue: '部分 PO 未完成收货或缺少来源关系', navigationLinks: [nav('打开 PO', 'po', purchaseOrders[0]?.po)] }),
    stage({ stage: 'GRN', label: 'GRN', count: receivingDocs.length, riskCount: receivingDocs.filter((grn) => /异常|拒收|hold|待检|rejected/i.test(`${grn.status} ${JSON.stringify(grn.lines || [])}`)).length, amount: 0, topIssue: 'GRN Line 完整性影响三单匹配', navigationLinks: [nav('打开 GRN', 'grn', receivingDocs[0]?.grn)] }),
    stage({ stage: 'Invoice', label: 'Invoice', count: invoiceCount, riskCount: invoiceCount, amount: invoices.reduce((sum, invoice) => sum + number(invoice.amount || invoice.totalAmount, 0), 0), topIssue: 'Invoice Line 覆盖不足影响财务协同', navigationLinks: [nav('打开发票', 'invoice', purchaseOrders[0]?.po)], dataLimitations: ['当前工作区发票行覆盖不足'] }),
    stage({ stage: 'Three-way Match', label: 'Three-way Match / 三单匹配', count: Math.max(matches.length, receivingDocs.length), riskCount: matchVarianceCount, blockedCount: matchVarianceCount, amount: 0, topIssue: 'PO / GRN / Invoice 三方证据需闭合', navigationLinks: [nav('打开三单匹配', 'match', purchaseOrders[0]?.po)], dataLimitations: ['三方证据不完整时仅展示限制说明'] }),
  ]
}

function buildSupplierAnalytics({ suppliers, purchaseOrders, rfqs, receivingDocs, dataQuality }) {
  const supplierRows = Array.isArray(suppliers) ? suppliers : asArray(suppliers?.candidates)
  const poBySupplier = countBySupplier(purchaseOrders, 'supplier')
  const rfqBySupplier = countBySupplier(rfqs, 'bestSupplier')
  return supplierRows.slice(0, 6).map((supplier) => {
    const name = text(supplier.name || supplier.supplierName)
    const key = supplierKey(name)
    const pos = poBySupplier.get(key)?.items || []
    const supplierRfqs = rfqBySupplier.get(key)?.items || []
    const grns = receivingDocs.filter((grn) => text(grn.supplier) === name)
    const grnExceptionCount = grns.filter((grn) => /异常|拒收|hold|rejected/i.test(`${grn.status} ${JSON.stringify(grn.lines || [])}`)).length
    const invoiceVarianceCount = dataQuality.qualityIssues.filter((issue) => issue.category === 'missing_invoice_line' && pos.some((po) => po.po === issue.businessObjectId)).length
    const receivedNotInvoicedAmount = grns.reduce((sum, grn) => sum + number(grn.items || grn.totalReceivedQty, 0), 0)
    const riskLevel = /高|high/i.test(text(supplier.risk || supplier.riskLevel || supplier.riskStatus)) || grnExceptionCount || invoiceVarianceCount ? '高' : /中|medium/i.test(text(supplier.risk || supplier.riskLevel || supplier.riskStatus)) ? '中' : '低'
    return {
      supplierId: text(supplier.id || supplier.code || supplier.supplierId || name),
      supplierName: name,
      category: text(supplier.category, '未分类'),
      poCount: pos.length,
      openPoCount: pos.filter((po) => isOpenPurchaseOrder(po)).length,
      rfqCount: supplierRfqs.length,
      grnExceptionCount,
      invoiceVarianceCount,
      receivedNotInvoicedAmount,
      riskLevel,
      topEvidence: grnExceptionCount ? '存在收货异常证据' : invoiceVarianceCount ? '发票行证据需补齐' : '交易证据可用于复核',
      suggestedReview: '打开供应商运营档案，复核 RFQ / PO / GRN / Invoice 证据。',
      navigationLinks: [nav('跳转供应商运营档案', 'supplier', name)],
    }
  }).sort((a, b) => severityRank(b.riskLevel) - severityRank(a.riskLevel) || b.openPoCount - a.openPoCount)
}

function buildInventoryAnalytics({ inventoryItems, docs, purchaseOrders, rfqs }) {
  return inventoryItems
    .map((item) => {
      const sku = text(item.sku)
      const relatedPr = docs.find((doc) => text(doc.sku) === sku)
      const relatedPo = purchaseOrders.find((po) => text(po.sourceSku) === sku || asArray(po.lines).some((line) => text(line.sku) === sku))
      const relatedRfq = rfqs.find((rfq) => text(rfq.sourceSku) === sku)
      const shortageQty = Math.max(0, number(item.safetyStock || item.reorderPoint, 0) - number(item.availableQuantity ?? item.onHandQuantity, 0))
      return {
        sku,
        itemName: text(item.itemName || item.name),
        warehouse: text(item.defaultWarehouseId || item.warehouse || item.location, '待复核'),
        availableQty: number(item.availableQuantity ?? item.currentStock, 0),
        safetyStock: number(item.safetyStock, 0),
        shortageQty,
        relatedPr: relatedPr?.id || '',
        relatedPo: relatedPo?.po || '',
        relatedRfq: relatedRfq?.id || '',
        riskLevel: shortageQty > 0 ? text(item.riskLevel, '高') : '低',
        suggestedReview: shortageQty > 0 ? '复核库存风险、采购申请和补货证据。' : '维持周期复核。',
        navigationLinks: [
          nav('打开 Inventory', 'inventory', sku),
          relatedPr ? nav('打开 PR', 'pr', relatedPr.id) : null,
          relatedPo ? nav('打开 PO', 'po', relatedPo.po) : null,
        ].filter(Boolean),
      }
    })
    .sort((a, b) => b.shortageQty - a.shortageQty)
    .slice(0, 6)
}

function buildFinanceAnalytics({ purchaseOrders, receivingDocs, invoices, dataQuality }) {
  const rows = []
  for (const issue of dataQuality.qualityIssues.filter((item) => ['missing_invoice_line', 'missing_grn_evidence'].includes(item.category)).slice(0, 5)) {
    const po = purchaseOrders.find((item) => item.po === issue.businessObjectId) || purchaseOrders.find((item) => receivingDocs.some((grn) => grn.po === item.po))
    const grn = receivingDocs.find((item) => item.po === po?.po)
    rows.push({
      invoiceId: invoices[0]?.id || 'Invoice 待接入',
      supplier: text(po?.supplier || grn?.supplier, '待复核'),
      relatedPo: text(po?.po || issue.businessObjectId),
      relatedGrn: text(grn?.grn, '待关联'),
      varianceType: issue.category === 'missing_invoice_line' ? 'Invoice Line 缺口' : 'GRN Line 缺口',
      varianceAmount: number(po?.amount || po?.totalAmount, 0),
      receivedNotInvoicedAmount: number(grn?.items || grn?.totalReceivedQty, 0),
      matchStatus: '需复核',
      suggestedReview: issue.suggestedFix,
      navigationLinks: [nav('打开发票 / 三单匹配', 'invoice', po?.po || issue.businessObjectId), nav('打开 PO', 'po', po?.po || issue.businessObjectId), grn ? nav('打开 GRN', 'grn', grn.grn) : null].filter(Boolean),
    })
  }
  if (!rows.length) {
    rows.push({ invoiceId: 'Invoice 当前无差异', supplier: '当前工作区', relatedPo: '', relatedGrn: '', varianceType: '无明显差异', varianceAmount: 0, receivedNotInvoicedAmount: 0, matchStatus: '当前可用', suggestedReview: '继续按周期复核。', navigationLinks: [nav('打开发票 / 三单匹配', 'invoice', '')] })
  }
  return rows
}

function buildControlTowerAnalytics(tower) {
  const labels = {
    supplier_risk: '供应商风险',
    po_unreceived: 'PO 未收货',
    received_not_invoiced: '已收未票',
    invoice_variance: '发票差异',
    three_way_match_variance: '三单匹配差异',
    rfq_pending_response: 'RFQ 待回复',
    inventory_risk: '库存风险',
    data_quality_gap: '数据缺口',
  }
  return Object.entries(labels).map(([category, categoryLabel]) => {
    const items = tower.items.filter((item) => item.category === category)
    const top = items[0]
    return {
      category,
      categoryLabel,
      count: items.length,
      highRiskCount: items.filter((item) => /P0|P1|high|高/i.test(`${item.priority} ${item.severity}`)).length,
      draftAvailableCount: items.filter((item) => asArray(item.reviewActions).some((action) => action.previewOnly)).length,
      topPriorityItem: top?.title || '当前无开放事项',
      businessImpact: top?.businessImpact?.[0]?.explanation || '用于聚合 Action Inbox 风险分布。',
      navigationLinks: [nav('打开风险与异常', 'operations', top?.entityId || 'data-quality-gap-workspace')],
    }
  })
}

function buildDataQualityImpact(dataQuality) {
  const grouped = new Map()
  for (const issue of dataQuality.qualityIssues) {
    const key = `${issue.category}:${issue.affectedModule}`
    if (!grouped.has(key)) grouped.set(key, { issueCategory: issue.category, issueCount: 0, affectedModule: issue.affectedModule, affectedMetric: issue.affectedControlTowerCategories?.[0] || '报表可信度', impactSummary: issue.businessImpact, navigationLinks: issue.navigationLinks || [] })
    grouped.get(key).issueCount += 1
  }
  return [...grouped.values()].slice(0, 8).map((row) => ({
    ...row,
    issueCategory: ({
      missing_supplier_response: '缺失 supplier response',
      missing_grn_evidence: '缺失 GRN Line',
      missing_invoice_line: '缺失 Invoice Line',
      missing_supplier_profile_evidence: '供应商资料缺口',
      unmapped_field: '未映射字段',
      inventory_procurement_evidence_gap: '库存 / 采购证据缺口',
      data_quality_gap: '数据缺口',
    })[row.issueCategory] || row.issueCategory,
    navigationLinks: [nav('打开 Data Access & Quality', 'data_quality', 'data-quality-gap-workspace'), ...(row.navigationLinks || [])],
  }))
}

export function buildReportsAnalyticsV2(data = {}, options = {}) {
  const generatedAt = options.generatedAt || new Date('2026-07-05T00:00:00.000Z').toISOString()
  const docs = buildProcurementDocuments(data)
  const prs = docs.filter((doc) => doc.type === 'purchase_request')
  const rfqs = asArray(data.rfqs)
  const purchaseOrders = asArray(data.purchaseOrders)
  const receivingDocs = asArray(data.receivingDocs)
  const invoices = buildProcurementSupplierInvoices(data)
  const matches = buildProcurementThreeWayMatches(data)
  const inventoryItems = buildInventoryItems(data)
  const suppliers = buildSupplierEntityIndex(data)
  const tower = buildOperationsControlTowerV2(data, { generatedAt })
  const dataQuality = buildDataAccessQualityV2(data, { generatedAt })
  const p2pPipeline = buildP2pPipeline({ docs, purchaseOrders, receivingDocs, invoices, matches, rfqs, dataQuality })
  const supplierAnalytics = buildSupplierAnalytics({ suppliers, purchaseOrders, rfqs, receivingDocs, dataQuality })
  const inventoryAnalytics = buildInventoryAnalytics({ inventoryItems, docs, purchaseOrders, rfqs })
  const financeAnalytics = buildFinanceAnalytics({ purchaseOrders, receivingDocs, invoices, dataQuality })
  const controlTowerAnalytics = buildControlTowerAnalytics(tower)
  const dataQualityImpact = buildDataQualityImpact(dataQuality)
  const dataLimitations = [
    limitation('Invoice Line 覆盖不足', '财务协同分析中的发票差异和三单匹配指标需要结合数据限制理解。', ['Invoice', 'Three-way Match']),
    limitation('供应商资料证据限制', '供应商风险分析受联系人、证书和交易证据完整性影响。', ['Supplier Risk Analytics']),
    limitation('字段映射限制', '未映射字段会影响 Data Quality Impact 和 AI 指标解释。', ['Data Quality Impact', 'AI Response Contract v2']),
  ]
  const reportInsights = [
    insight({
      title: 'P2P 链路瓶颈集中在收货与发票证据',
      insightType: 'pipeline',
      severity: 'high',
      conclusion: 'PO → GRN → Invoice 证据不完整会放大已收未票和三单匹配风险。',
      keyEvidence: p2pPipeline.map((item) => `${item.label}: ${item.count} 条 / 风险 ${item.riskCount}`).slice(1, 5),
      businessImpact: '采购、收货和财务协同无法形成闭环解释。',
      suggestedAction: '优先复核缺少 GRN Line 和 Invoice Line 的 PO。',
      navigationLinks: [nav('打开 PO', 'po', purchaseOrders[0]?.po), nav('打开 Data Access & Quality', 'data_quality', 'data-quality-gap-workspace')],
      dataLimitations: [dataLimitations[0]],
    }),
    insight({
      title: '供应商风险需要结合交易证据复核',
      insightType: 'supplier',
      severity: supplierAnalytics.some((item) => item.riskLevel === '高') ? 'high' : 'warning',
      conclusion: '高风险供应商通常同时关联开放 PO、收货异常或资料证据缺口。',
      keyEvidence: supplierAnalytics.slice(0, 3).map((item) => `${item.supplierName}: Open PO ${item.openPoCount} / 风险 ${item.riskLevel}`),
      businessImpact: '会影响交付承诺、替代供应商策略和 Action Inbox 优先级。',
      suggestedAction: '打开供应商运营档案复核 RFQ / PO / GRN / Invoice 证据。',
      navigationLinks: [supplierAnalytics[0] ? nav('跳转供应商运营档案', 'supplier', supplierAnalytics[0].supplierName) : nav('打开供应商管理', 'supplier', '')],
      dataLimitations: [dataLimitations[1]],
    }),
    insight({
      title: '库存风险需要采购证据补强',
      insightType: 'inventory',
      severity: inventoryAnalytics.some((item) => item.shortageQty > 0) ? 'high' : 'info',
      conclusion: '低于安全库存的 SKU 需要关联 PR / PO / RFQ 才能解释补货路径。',
      keyEvidence: inventoryAnalytics.slice(0, 3).map((item) => `${item.sku}: 缺口 ${item.shortageQty}`),
      businessImpact: '会影响补货草稿、MRP 判断和风险与异常中的库存风险。',
      suggestedAction: '打开库存页面并复核相关 PR / PO。',
      navigationLinks: [inventoryAnalytics[0] ? nav('打开 Inventory', 'inventory', inventoryAnalytics[0].sku) : nav('打开 Inventory', 'inventory', '')],
      dataLimitations: [],
    }),
    insight({
      title: '数据质量问题影响报表可信度',
      insightType: 'data_quality',
      severity: dataQuality.summary.criticalIssueCount > 0 ? 'high' : 'warning',
      conclusion: 'Data Access & Quality 中的质量问题会直接影响 AI、风险与异常和报表指标解释。',
      keyEvidence: dataQualityImpact.slice(0, 3).map((item) => `${item.issueCategory}: ${item.issueCount}`),
      businessImpact: '报表结论需要伴随数据限制和复核建议展示。',
      suggestedAction: '打开 Data Access & Quality 逐项复核。',
      navigationLinks: [nav('打开 Data Access & Quality', 'data_quality', 'data-quality-gap-workspace'), nav('打开风险与异常', 'operations', 'data-quality-gap-workspace')],
      dataLimitations: [dataLimitations[2]],
    }),
  ]

  const matchVarianceCount = controlTowerAnalytics.find((item) => item.category === 'three_way_match_variance')?.count || financeAnalytics.filter((item) => item.matchStatus === '需复核').length
  const supplierRiskCount = supplierAnalytics.filter((item) => severityRank(item.riskLevel) >= 2).length
  const inventoryRiskCount = inventoryAnalytics.filter((item) => item.shortageQty > 0).length
  const dataQualityIssueCount = dataQuality.qualityIssues.length
  const riskTotal = matchVarianceCount + supplierRiskCount + inventoryRiskCount + dataQualityIssueCount

  return {
    summary: {
      totalPrCount: prs.length,
      totalRfqCount: rfqs.length,
      totalPoCount: purchaseOrders.length,
      totalGrnCount: receivingDocs.length,
      totalInvoiceCount: Math.max(invoices.length, financeAnalytics.length),
      matchVarianceCount,
      supplierRiskCount,
      inventoryRiskCount,
      controlTowerOpenItemCount: tower.items.length,
      dataQualityIssueCount,
      overallHealthLabel: riskTotal > 12 ? '需优先复核' : riskTotal > 0 ? '存在运营风险' : '当前可用',
    },
    p2pPipeline,
    supplierAnalytics,
    inventoryAnalytics,
    financeAnalytics,
    controlTowerAnalytics,
    dataQualityImpact,
    reportInsights,
    navigationLinks: [
      nav('打开风险与异常', 'operations', 'data-quality-gap-workspace'),
      nav('打开 Data Access & Quality', 'data_quality', 'data-quality-gap-workspace'),
      nav('打开 AI Assistant', 'ai', 'reports-analytics'),
    ],
    dataLimitations,
    generatedAt,
    dataScopeLabel: '当前工作区数据',
  }
}
