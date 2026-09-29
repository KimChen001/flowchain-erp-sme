import {
  buildProcurementDocuments,
  buildProcurementFollowups,
  buildProcurementSupplierInvoices,
  buildProcurementThreeWayMatches,
} from './procurement-read-model.mjs'
import { buildInventoryItems as buildInventoryReadItems } from './inventory-read.mjs'
import { buildSupplierEntityIndex } from './ai-supplier-operational-query.mjs'
import { buildAiResponseContractV2 } from './ai-response-contract-v2.mjs'

export const FORBIDDEN_OPERATIONS_ACTION_PATTERN = /自动批准|自动下单|正式创建\s*PO|下发\s*PO|发送\s*PO|发布\s*RFQ|邀请供应商|发送供应商邮件|提交收货|Receive Submit|Submit Receipt|修改库存|库存过账|Post Invoice|Approve Invoice|Mark as Paid|Payment execution|Export to Accounting|会计过账|付款|修改供应商主数据|修改付款条款|更新银行账户|更新税务信息|发布风险评级|自动黑名单|自动暂停供应商|合同签署/i
export const FORBIDDEN_OPERATIONS_TECHNICAL_PATTERN = /JSON|dry-run|tenantId|userId|datasetId|writesDb|writesFiles|tool_result|provider|fallback|deterministic|mock|fake|demo|UAT|sample data|demo data|response_card|entityType|documentType|raw enum/i

function asArray(value) { return Array.isArray(value) ? value : [] }
function text(value, fallback = '') {
  const next = String(value ?? '').trim()
  return next || fallback
}
function toNumber(value, fallback = 0) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}
// Unknown currency shows a plain number; a document's own currency is never guessed.
function money(value = 0, currency = '') {
  const code = text(currency)
  const amount = toNumber(value, 0).toLocaleString('en-US')
  if (!code) return amount
  return code === 'CNY' ? `¥${amount}` : `${code} ${amount}`
}
function compact(value = '') {
  return text(value).toLowerCase().replace(/[^\w\u4e00-\u9fa5-]+/g, '')
}
function uniqueBy(items = [], keyOf = (item) => item.id) {
  const seen = new Set()
  const result = []
  for (const item of items.filter(Boolean)) {
    const key = keyOf(item)
    if (!key || seen.has(key)) continue
    seen.add(key)
    result.push(item)
  }
  return result
}
function dateMs(value = '') {
  const raw = text(value)
  const iso = raw.match(/^20\d{2}-\d{2}-\d{2}/)?.[0]
  if (iso) return new Date(`${iso}T00:00:00.000Z`).getTime()
  const zh = raw.match(/(\d{1,2})月(\d{1,2})日/)
  if (zh) return new Date(`2026-${String(zh[1]).padStart(2, '0')}-${String(zh[2]).padStart(2, '0')}T00:00:00.000Z`).getTime()
  return 0
}
function isPastDue(value = '', now = new Date()) {
  const due = dateMs(value)
  if (!due) return false
  return due < Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
}
function isClosed(status = '') {
  return /已完成|已取消|已关闭|已收货|已转PO|已授标|已付款|completed|closed|cancelled|canceled|paid/i.test(text(status))
}
function moduleFor(type = '') {
  if (type === 'pr') return 'procurement:requests'
  if (type === 'rfq') return 'procurement:rfq'
  if (type === 'po') return 'procurement:orders'
  if (type === 'grn') return 'procurement:receiving'
  if (type === 'invoice' || type === 'threeWayMatch') return 'procurement:invoices'
  if (type === 'supplier') return 'srm:master'
  if (type === 'inventory_item') return 'inventory'
  if (type === 'data_quality') return 'imports'
  return 'overview'
}
function entityTypeFor(type = '') {
  if (type === 'pr') return 'purchase_request'
  if (type === 'rfq') return 'rfq'
  if (type === 'po') return 'purchase_order'
  if (type === 'grn') return 'receiving_doc'
  if (type === 'invoice' || type === 'threeWayMatch') return 'supplier_invoice'
  if (type === 'supplier') return 'supplier'
  if (type === 'inventory_item') return 'inventory_item'
  if (type === 'data_quality') return 'data_quality_issue'
  return 'business_object'
}
function labelFor(type = '', id = '') {
  if (type === 'supplier') return text(id)
  if (type === 'inventory_item') return `SKU ${id}`.trim()
  if (type === 'data_quality') return '数据接入与质量'
  if (type === 'threeWayMatch') return `三单匹配 ${id}`.trim()
  return `${String(type || '').toUpperCase()} ${id}`.trim()
}
function navigationLink(label, type, id, reason = '') {
  return {
    label,
    moduleId: moduleFor(type),
    entityType: entityTypeFor(type),
    entityId: id || undefined,
    entityLabel: labelFor(type, id),
    returnTo: 'overview',
    source: 'operationsControlTower',
    reason,
  }
}
function evidence(type, id, summary, extra = {}) {
  return {
    id: text(extra.id, `${type}-${id || summary}`),
    label: text(extra.label, labelFor(type, id)),
    entityLabel: text(extra.entityLabel, labelFor(type, id)),
    entityType: entityTypeFor(type),
    entityId: text(id),
    moduleId: moduleFor(type),
    evidenceType: text(extra.evidenceType, '业务证据'),
    summary: text(summary),
    value: extra.value ?? null,
    status: text(extra.status),
    severity: extra.severity || 'warning',
    sourceLabel: '当前工作区数据',
    linkTarget: { moduleId: moduleFor(type), entityType: entityTypeFor(type), entityId: text(id) },
  }
}
function reviewAction(label, description, target = {}, draftType = 'po_followup_draft', payload = {}) {
  return {
    label,
    description,
    actionType: 'draft_preview',
    priority: 'medium',
    reviewRequired: true,
    previewOnly: true,
    requiresHumanReview: true,
    targetModule: target.moduleId,
    targetEntityType: target.entityType,
    targetEntityId: target.entityId,
    draftType,
    draftTitle: label,
    payload,
    boundary: '草稿预览 · 需人工复核 · 不会外发 · 不提交 · 不写入库存 · 不写入财务凭证 · 不处理资金 · 不改供应商资料',
  }
}
function limitation(label, description, consequence = '', missingData = []) {
  return { label, description, severity: 'warning', missingData, consequence }
}
function impact(area, value, severity, explanation, affectedObjects = []) {
  return { area, impact: value, severity, explanation, affectedObjects }
}
function priorityFromScore(score) {
  if (score >= 90) return 'P0'
  if (score >= 70) return 'P1'
  if (score >= 45) return 'P2'
  return 'P3'
}
function severityFromScore(score) {
  if (score >= 80) return 'risk'
  if (score >= 45) return 'warning'
  return 'info'
}
function actionItem(input = {}) {
  const priorityScore = Math.max(0, Math.round(toNumber(input.priorityScore, 0)))
  const priority = input.priority || priorityFromScore(priorityScore)
  const severity = input.severity || severityFromScore(priorityScore)
  const keyEvidence = asArray(input.keyEvidence).slice(0, 5)
  const firstEvidence = keyEvidence[0]
  const targetModule = input.moduleId || firstEvidence?.moduleId || 'overview'
  const targetEntityType = input.entityType || firstEvidence?.entityType
  const targetEntityId = input.entityId || firstEvidence?.entityId
  return {
    id: input.id,
    title: input.title,
    category: input.category,
    categoryLabel: input.categoryLabel,
    severity,
    priority,
    priorityScore,
    status: input.status || '待复核',
    owner: input.owner || '供应链协同',
    ageLabel: input.ageLabel || '今日',
    dueLabel: input.dueLabel || '今日复核',
    businessObjectType: input.businessObjectType || targetEntityType || '',
    businessObjectId: input.businessObjectId || targetEntityId || '',
    businessObjectLabel: input.businessObjectLabel || firstEvidence?.entityLabel || input.title,
    moduleId: targetModule,
    entityType: targetEntityType,
    entityId: targetEntityId,
    reason: input.reason,
    keyEvidence,
    businessImpact: asArray(input.businessImpact).slice(0, 4),
    suggestedNextStep: input.suggestedNextStep,
    navigationLinks: asArray(input.navigationLinks).slice(0, 5),
    reviewActions: asArray(input.reviewActions).slice(0, 3),
    dataLimitations: asArray(input.dataLimitations).slice(0, 4),
    blockedActions: [
      '真实审批执行',
      '正式下单或外发',
      '收货执行与库存写入',
      '财务凭证写入、资金处理或会计导出',
      '供应商主数据变更',
    ],
  }
}
function rawPoLine(po = {}) {
  const line = asArray(po.lines)[0] || {}
  return {
    id: text(line.poLineId || line.lineId || line.id, `${text(po.po || po.id || 'PO')}-LINE-1`),
    sku: text(line.sku || po.sourceSku || po.sku),
    orderedQty: toNumber(line.quantityOrdered ?? line.orderedQty ?? line.quantity ?? po.totalOrderedQty ?? po.items, 0),
    receivedQty: toNumber(line.quantityReceived ?? line.receivedQty ?? line.received ?? po.totalReceivedQty ?? po.received, 0),
    invoicedQty: toNumber(line.quantityInvoiced ?? line.invoicedQty ?? line.approvedInvoicedQty ?? po.totalInvoicedQty ?? po.invoiced, 0),
    unitPrice: toNumber(line.unitPrice ?? po.unitPrice, 0),
    currency: text(line.currency || po.currency),
    unit: text(line.unit || po.unit),
  }
}
function rawPoId(po = {}) { return text(po.po || po.poId || po.id) }
function rawGrnId(grn = {}) { return text(grn.grn || grn.grnId || grn.id) }
function rawInvoiceId(invoice = {}) { return text(invoice.invoiceNumber || invoice.invoiceId || invoice.id) }
function supplierInvoicesFor(data = {}) {
  return asArray(data.supplierInvoices).length ? asArray(data.supplierInvoices) : asArray(data.invoices || data.payables || data.supplierInvoiceRecords)
}
function rawGrnsForPo(data = {}, poId = '') {
  const key = compact(poId)
  return asArray(data.receivingDocs).filter((grn) => [grn.po, grn.poId, grn.purchaseOrderId].some((value) => compact(value) === key))
}
function rawInvoicesForPo(data = {}, poId = '') {
  const key = compact(poId)
  return supplierInvoicesFor(data).filter((invoice) => [invoice.relatedPo, invoice.po, invoice.poId, invoice.purchaseOrderId].some((value) => compact(value) === key))
}
function buildSupplierRiskItems(data, documents) {
  const index = buildSupplierEntityIndex(data)
  return uniqueBy(index.candidates, (row) => row.supplierId || row.supplierName).map((supplier) => {
    const names = [supplier.supplierId, supplier.supplierName, ...(supplier.aliases || [])].map(compact).filter(Boolean)
    const related = documents.filter((doc) => [doc.supplier, doc.supplierName, doc.supplierId, doc.awardedSupplier].some((value) => names.includes(compact(value))))
    const pos = related.filter((doc) => doc.documentType === 'po' && !isClosed(doc.status))
    const rfqs = related.filter((doc) => doc.documentType === 'rfq' && toNumber(doc.pendingSupplierCount, 0) > 0)
    const invoices = related.filter((doc) => ['invoice', 'threeWayMatch'].includes(doc.documentType) && (toNumber(doc.varianceAmount, 0) !== 0 || /差异|异常|待复核/.test(text(doc.matchStatus || doc.status))))
    const grns = related.filter((doc) => doc.documentType === 'grn' && /异常|质检|待/.test(text(doc.status)))
    const score = (/高|high/i.test(text(supplier.risk)) ? 45 : /中|medium/i.test(text(supplier.risk)) ? 20 : 0) + pos.length * 8 + rfqs.length * 7 + invoices.length * 12 + grns.length * 10
    if (score <= 0) return null
    const id = text(supplier.supplierId || supplier.supplierName)
    const ev = [
      evidence('supplier', id, `风险信号来自 ${pos.length} 个开放 PO、${rfqs.length} 个 RFQ 待回复、${grns.length} 个收货异常、${invoices.length} 个发票/匹配差异。`, { status: supplier.risk || '需复核', severity: score >= 80 ? 'risk' : 'warning' }),
      ...related.slice(0, 3).map((doc) => evidence(doc.documentType, doc.id, `${doc.id} 与供应商风险相关。`, { status: doc.status || doc.matchStatus, value: doc.amount || doc.varianceAmount })),
    ]
    return actionItem({
      id: `supplier-risk-${id}`,
      category: 'supplier_risk',
      categoryLabel: '供应商风险',
      title: `${supplier.supplierName || id} 供应商风险需复核`,
      priorityScore: Math.min(100, 50 + score),
      status: supplier.risk || '需复核',
      owner: '供应商管理',
      businessObjectLabel: supplier.supplierName || id,
      moduleId: 'srm:master',
      entityType: 'supplier',
      entityId: id,
      reason: `供应商近期存在交期、RFQ、收货或 Invoice 风险信号，可能影响供应连续性。`,
      keyEvidence: ev,
      businessImpact: [
        impact('供应连续性', '交期与收货风险', 'risk', '开放 PO 或 GRN 异常会影响生产齐套。', pos.map((po) => po.id)),
        impact('财务协同', '发票差异风险', invoices.length ? 'risk' : 'info', '发票差异需要采购、收货和财务共同复核。'),
      ],
      suggestedNextStep: '打开供应商运营档案，复核相关 PO / RFQ / GRN / Invoice。',
      navigationLinks: [navigationLink('打开供应商运营档案', 'supplier', id), ...related.slice(0, 2).map((doc) => navigationLink(`查看 ${doc.id}`, doc.documentType, doc.id))],
      reviewActions: [reviewAction('生成供应商风险说明草稿', '整理交期、收货、RFQ 与 Invoice 风险，供内部复核。', { moduleId: 'srm:master', entityType: 'supplier', entityId: id }, 'supplier_followup_draft', { supplierIdOrName: supplier.supplierName || id, reason: '供应商风险说明草稿。' })],
      dataLimitations: [limitation('供应商资料完整性', '联系人、证书和结算资料需要在供应商档案中人工确认。', '不改写供应商资料。', ['联系人', '证书'])],
    })
  }).filter(Boolean)
}
function buildPoItems(data, documents, now) {
  return asArray(data.purchaseOrders).map((po) => {
    const id = rawPoId(po)
    if (!id) return null
    const line = rawPoLine(po)
    const unreceivedQty = Math.max(0, line.orderedQty - line.receivedQty)
    const doc = documents.find((item) => item.documentType === 'po' && item.id === id)
    if (!unreceivedQty || isClosed(doc?.status || po.status)) return null
    const overdue = isPastDue(po.eta || po.expectedDate || doc?.expectedDate, now)
    const score = 42 + Math.min(25, unreceivedQty * 2) + (overdue ? 30 : 0) + Math.min(15, toNumber(po.amount, 0) / 10000)
    const grns = rawGrnsForPo(data, id)
    const ev = [
      evidence('po', id, `PO Line ${line.id} 订购 ${line.orderedQty.toLocaleString()}，已收 ${line.receivedQty.toLocaleString()}，未收数量 ${unreceivedQty.toLocaleString()}，ETA ${po.eta || po.expectedDate || doc?.expectedDate || '待确认'}。`, { status: doc?.status || po.status, value: unreceivedQty, severity: overdue ? 'risk' : 'warning' }),
      ...grns.slice(0, 2).map((grn) => evidence('grn', rawGrnId(grn), `收货记录 ${rawGrnId(grn)} 当前 ${text(grn.status, '待复核')}。`, { status: grn.status })),
    ]
    return actionItem({
      id: `po-unreceived-${id}`,
      category: 'po_unreceived',
      categoryLabel: 'PO 未收货',
      title: `${id} 未完全收货`,
      priorityScore: score,
      status: doc?.status || po.status || '未完全收货',
      owner: po.owner || po.buyer || '采购执行',
      dueLabel: `ETA ${po.eta || po.expectedDate || doc?.expectedDate || '待确认'}`,
      businessObjectLabel: `PO ${id}`,
      moduleId: 'procurement:orders',
      entityType: 'purchase_order',
      entityId: id,
      reason: overdue ? 'ETA 已过且仍有 PO Line 未收数量，可能影响生产齐套。' : 'PO Line 仍有未收数量，需要确认供应商剩余交期。',
      keyEvidence: ev,
      businessImpact: [impact('采购执行', '未收数量', overdue ? 'risk' : 'warning', '未收数量会影响库存覆盖和后续客户承诺。', [id])],
      suggestedNextStep: '查看 PO detail 与收货记录，生成内部跟进备注草稿。',
      navigationLinks: [navigationLink('打开 PO', 'po', id), ...(grns[0] ? [navigationLink('查看收货记录', 'grn', rawGrnId(grns[0]))] : [navigationLink('打开收货工作台', 'grn', '')])],
      reviewActions: [reviewAction('生成内部跟进备注草稿', '整理 PO Line 未收数量、ETA 和供应商跟进要点。', { moduleId: 'procurement:orders', entityType: 'purchase_order', entityId: id }, 'po_followup_draft', { poId: id, reason: 'PO 未完全收货跟进。' })],
      dataLimitations: [limitation('供应商 ETA', 'ETA 来自当前工作区字段，仍需供应商确认。', '不代表已经完成外部确认。')],
    })
  }).filter(Boolean)
}
function buildReceivedNotInvoicedItems(data, documents) {
  return asArray(data.purchaseOrders).map((po) => {
    const id = rawPoId(po)
    const line = rawPoLine(po)
    const invoiceQty = rawInvoicesForPo(data, id).reduce((sum, invoice) => {
      const invoiceLine = asArray(invoice.lines)[0] || {}
      return sum + toNumber(invoiceLine.quantity ?? invoiceLine.invoiceQty ?? invoice.quantity, 0)
    }, 0)
    const uninvoicedQty = Math.max(0, line.receivedQty - (line.invoicedQty || invoiceQty))
    if (!uninvoicedQty) return null
    const exposure = uninvoicedQty * line.unitPrice
    const grn = rawGrnsForPo(data, id)[0]
    const score = 48 + Math.min(35, exposure / 3000) + Math.min(12, uninvoicedQty)
    return actionItem({
      id: `received-not-invoiced-${id}`,
      category: 'received_not_invoiced',
      categoryLabel: '已收未票',
      title: `${id} 已收未票需协同可见`,
      priorityScore: score,
      status: '已收未票',
      owner: '采购 / 财务协同',
      businessObjectLabel: `PO ${id}`,
      moduleId: 'procurement:invoices',
      entityType: 'purchase_order',
      entityId: id,
      reason: `PO Line ${line.id} 已收 ${line.receivedQty.toLocaleString()}，未开票数量 ${uninvoicedQty.toLocaleString()}，已收未票金额 ${money(exposure, line.currency)}。`,
      keyEvidence: [
        evidence('po', id, `PO Line ${line.id} 已收 ${line.receivedQty.toLocaleString()}，未开票数量 ${uninvoicedQty.toLocaleString()}。`, { value: exposure }),
        ...(grn ? [evidence('grn', rawGrnId(grn), `GRN Line 作为已收证据，当前 ${text(grn.status, '待复核')}。`, { status: grn.status })] : []),
      ],
      businessImpact: [impact('财务协同', '已收未票金额', 'warning', '用于协同可见性和应付复核，不形成会计分录。', [id])],
      suggestedNextStep: '查看 PO / GRN / Invoice 记录，确认未开票数量。',
      navigationLinks: [navigationLink('打开 PO', 'po', id), ...(grn ? [navigationLink('查看 GRN', 'grn', rawGrnId(grn))] : []), navigationLink('打开发票协同', 'invoice', '')],
      reviewActions: [reviewAction('生成内部复核备注草稿', '整理已收未票数量和金额，供采购与财务复核。', { moduleId: 'procurement:invoices', entityType: 'purchase_order', entityId: id }, 'exception_note', { relatedDocumentId: id, reason: '已收未票复核。' })],
      dataLimitations: [limitation('不形成会计分录', '已收未票金额仅用于协同可见性。', '不会写入财务凭证、处理资金或导出会计。', ['完整 Invoice Line'])],
    })
  }).filter(Boolean)
}
function buildMatchItems(data, documents) {
  const invoices = buildProcurementSupplierInvoices(data)
  const matches = buildProcurementThreeWayMatches(data)
  const invoiceItems = invoices.filter((invoice) => toNumber(invoice.varianceAmount, 0) !== 0 || /差异|异常|待复核/.test(text(invoice.matchStatus)))
  const matchItems = matches.filter((match) => toNumber(match.varianceAmount, 0) !== 0 || /差异|异常|待复核/.test(text(match.matchStatus)))
  return [
    ...invoiceItems.map((invoice) => actionItem({
      id: `invoice-variance-${invoice.id}`,
      category: 'invoice_variance',
      categoryLabel: '发票差异',
      title: `${invoice.id} 发票差异需复核`,
      priorityScore: 62 + Math.min(35, Math.abs(toNumber(invoice.varianceAmount, 0)) / 1000),
      status: invoice.matchStatus || invoice.invoiceStatus,
      owner: '财务协同',
      dueLabel: invoice.dueDate || '今日复核',
      businessObjectLabel: `Invoice ${invoice.id}`,
      moduleId: 'procurement:invoices',
      entityType: 'supplier_invoice',
      entityId: invoice.id,
      reason: `Invoice Line 与 PO / GRN 存在金额差异 ${money(invoice.varianceAmount, invoice.currency)}，需人工复核。`,
      keyEvidence: [
        evidence('invoice', invoice.id, `Invoice Line 金额 ${money(invoice.amount, invoice.currency)}，金额差异 ${money(invoice.varianceAmount, invoice.currency)}。`, { status: invoice.matchStatus, value: invoice.varianceAmount, severity: 'risk' }),
        invoice.relatedPo ? evidence('po', invoice.relatedPo, '关联 PO Line 需要复核。') : null,
        invoice.relatedGrn ? evidence('grn', invoice.relatedGrn, '关联 GRN / Receipt Line 需要复核。') : null,
      ].filter(Boolean),
      businessImpact: [impact('财务协同', '结算阻断风险', 'risk', '发票差异会阻断结算和对账，需要采购、收货、财务共同确认。', [invoice.id])],
      suggestedNextStep: '生成差异说明草稿，并查看 PO / GRN / Invoice Line。',
      navigationLinks: [navigationLink('打开发票', 'invoice', invoice.id), ...(invoice.relatedPo ? [navigationLink('查看 PO', 'po', invoice.relatedPo)] : []), ...(invoice.relatedGrn ? [navigationLink('查看 GRN', 'grn', invoice.relatedGrn)] : [])],
      reviewActions: [reviewAction('生成差异说明草稿', '整理数量差异、单价差异和金额差异，供人工复核。', { moduleId: 'procurement:invoices', entityType: 'supplier_invoice', entityId: invoice.id }, 'exception_note', { relatedDocumentId: invoice.id, reason: '发票差异说明。' })],
      dataLimitations: [limitation('人工复核边界', '差异说明不代表发票审批、财务凭证写入或资金处理。', '仅生成内部说明。')],
    })),
    ...matchItems.map((match) => actionItem({
      id: `three-way-match-${match.id}`,
      category: 'three_way_match_variance',
      categoryLabel: '三单匹配差异',
      title: `${match.id} 三单匹配差异`,
      priorityScore: 64 + Math.min(30, Math.abs(toNumber(match.varianceAmount, 0)) / 1000),
      status: match.matchStatus || match.status,
      owner: '采购 / 收货 / 财务',
      businessObjectLabel: match.id,
      moduleId: 'procurement:invoices',
      entityType: 'supplier_invoice',
      entityId: match.invoiceId,
      reason: `PO Line、GRN / Receipt Line 与 Invoice Line 的金额差异为 ${money(match.varianceAmount, match.currency)}。`,
      keyEvidence: [
        match.poId ? evidence('po', match.poId, 'PO Line 是匹配基准。') : null,
        match.grnId ? evidence('grn', match.grnId, 'GRN / Receipt Line 是收货证据。') : null,
        match.invoiceId ? evidence('invoice', match.invoiceId, `Invoice Line 金额差异 ${money(match.varianceAmount, match.currency)}。`, { severity: 'risk' }) : null,
      ].filter(Boolean),
      businessImpact: [impact('三单匹配', '数量 / 单价 / 金额差异', 'risk', '匹配差异需要人工确认，发票仍停留在复核边界内。', [match.id])],
      suggestedNextStep: '打开三单匹配视图，生成差异说明草稿。',
      navigationLinks: [navigationLink('打开三单匹配', 'invoice', match.invoiceId), ...(match.poId ? [navigationLink('查看 PO', 'po', match.poId)] : []), ...(match.grnId ? [navigationLink('查看 GRN', 'grn', match.grnId)] : [])],
      reviewActions: [reviewAction('生成差异说明草稿', '整理 PO / GRN / Invoice 差异，供采购和财务共同复核。', { moduleId: 'procurement:invoices', entityType: 'supplier_invoice', entityId: match.invoiceId }, 'exception_note', { relatedDocumentId: match.invoiceId, reason: '三单匹配差异说明。' })],
      dataLimitations: [limitation('匹配证据完整性', '如果 GRN Line 或 Invoice Line 缺失，需要先补齐数据。', '不能形成最终匹配结论。', ['GRN Line', 'Invoice Line'])],
    })),
  ]
}
function buildRfqItems(data, documents) {
  return documents.filter((doc) => doc.documentType === 'rfq' && !isClosed(doc.status) && toNumber(doc.pendingSupplierCount, 0) > 0).map((rfq) => actionItem({
    id: `rfq-pending-${rfq.id}`,
    category: 'rfq_pending_response',
    categoryLabel: 'RFQ 待回复',
    title: `${rfq.id} 报价回复不足`,
    priorityScore: 45 + Math.min(25, toNumber(rfq.pendingSupplierCount, 0) * 10) + (isPastDue(rfq.dueDate) ? 20 : 0),
    status: rfq.status,
    owner: '寻源采购',
    dueLabel: rfq.dueDate ? `截止 ${rfq.dueDate}` : '截止待确认',
    businessObjectLabel: `RFQ ${rfq.id}`,
    moduleId: 'procurement:rfq',
    entityType: 'rfq',
    entityId: rfq.id,
    reason: `已邀请 ${rfq.supplierCount} 家，已回复 ${rfq.respondedSupplierCount} 家，仍有 ${rfq.pendingSupplierCount} 家待回复。`,
    keyEvidence: [evidence('rfq', rfq.id, `RFQ 回复样本不足，授标建议需要补充报价依据。`, { status: rfq.status, value: rfq.pendingSupplierCount })],
    businessImpact: [impact('寻源', '报价样本不足', 'warning', '报价不足会影响比价与授标建议完整性。', [rfq.id])],
    suggestedNextStep: '查看 RFQ detail，生成补充报价说明草稿。',
    navigationLinks: [navigationLink('打开 RFQ', 'rfq', rfq.id)],
    reviewActions: [reviewAction('生成补充报价说明草稿', '整理待回复供应商和报价截止日期，仅供内部复核。', { moduleId: 'procurement:rfq', entityType: 'rfq', entityId: rfq.id }, 'rfq_draft', { itemIdOrSku: rfq.sku || rfq.itemId, quantity: rfq.quantity, reason: 'RFQ 回复不足复核。' })],
    dataLimitations: [limitation('报价完整性', '供应商报价、交期和结算条款仍需人工确认。')],
  }))
}
function buildRequisitionItems(data, documents) {
  return documents.filter((doc) => doc.documentType === 'pr' && !isClosed(doc.status)).slice(0, 5).map((pr) => actionItem({
    id: `pr-waiting-${pr.id}`,
    category: 'requisition_waiting',
    categoryLabel: 'PR 待处理',
    title: `${pr.id} 等待转 RFQ / PO 草稿`,
    priorityScore: 40 + (/高/.test(pr.priority) ? 25 : 0) + (isPastDue(pr.requiredDate || pr.dueDate) ? 20 : 0),
    status: pr.status,
    owner: pr.buyer || pr.requester || '采购申请',
    dueLabel: pr.requiredDate ? `需求 ${pr.requiredDate}` : '需求日期待确认',
    businessObjectLabel: `PR ${pr.id}`,
    moduleId: 'procurement:requests',
    entityType: 'purchase_request',
    entityId: pr.id,
    reason: `PR ${pr.id} 当前 ${pr.status}，需要确认是否进入 RFQ 或 PO 草稿预览。`,
    keyEvidence: [evidence('pr', pr.id, `需求 ${pr.itemName || pr.sku || pr.id}，数量 ${toNumber(pr.quantity, 0).toLocaleString()}。`, { status: pr.status })],
    businessImpact: [impact('采购启动', '需求等待处理', 'warning', 'PR 未处理会影响后续寻源和采购订单形成。', [pr.id])],
    suggestedNextStep: '打开 PR detail，生成 RFQ / PO 草稿预览。',
    navigationLinks: [navigationLink('打开 PR', 'pr', pr.id)],
    reviewActions: [reviewAction('生成 RFQ 草稿预览', '基于 PR 形成 RFQ 草稿预览，需人工复核。', { moduleId: 'procurement:requests', entityType: 'purchase_request', entityId: pr.id }, 'rfq_draft', { itemIdOrSku: pr.sku || pr.itemId, quantity: pr.quantity, reason: 'PR 待处理。' })],
    dataLimitations: [limitation('需求来源', '短缺、销售需求或库存来源需沿证据链继续复核。')],
  }))
}
function buildInventoryRiskItems(data, documents) {
  return buildInventoryReadItems(data)
    .filter((item) => /低库存|缺货|不足|预警|异常/.test(text(item.status)) || /高|中/.test(text(item.riskLevel)))
    .slice(0, 6)
    .map((item) => {
      const shortage = Math.max(0, toNumber(item.reorderPoint || item.safetyStock, 0) - toNumber(item.availableQuantity, 0))
      return actionItem({
        id: `inventory-risk-${item.sku}`,
        category: 'inventory_risk',
        categoryLabel: '库存风险',
        title: `${item.sku} 库存风险`,
        priorityScore: 44 + Math.min(35, shortage * 2) + (/缺货|高/.test(`${item.status} ${item.riskLevel}`) ? 25 : 0),
        status: item.status || item.riskLevel,
        owner: '库存计划',
        businessObjectLabel: `SKU ${item.sku}`,
        moduleId: 'inventory',
        entityType: 'inventory_item',
        entityId: item.sku,
        reason: `${item.itemName || item.sku} 可用 ${toNumber(item.availableQuantity, 0).toLocaleString()}，安全库存 ${toNumber(item.safetyStock, 0).toLocaleString()}，缺口 ${shortage.toLocaleString()}。`,
        keyEvidence: [evidence('inventory_item', item.sku, `可用库存 ${toNumber(item.availableQuantity, 0).toLocaleString()}，安全库存 ${toNumber(item.safetyStock, 0).toLocaleString()}，再订货点 ${toNumber(item.reorderPoint, 0).toLocaleString()}。`, { status: item.status || item.riskLevel, value: item.availableQuantity, severity: /缺货|高/.test(`${item.status} ${item.riskLevel}`) ? 'risk' : 'warning' })],
        businessImpact: [impact('库存覆盖', '缺货或低库存', shortage ? 'risk' : 'warning', '库存风险可能影响客户交付和采购优先级。', [item.sku])],
        suggestedNextStep: '打开库存页面，查看证据链并生成补货 PR 草稿预览。',
        navigationLinks: [navigationLink('打开库存', 'inventory_item', item.sku), navigationLink('打开证据链', 'inventory_item', item.sku)],
        reviewActions: [reviewAction('生成补货 PR 草稿预览', '基于库存缺口生成补货草稿预览，需人工复核。', { moduleId: 'inventory', entityType: 'inventory_item', entityId: item.sku }, 'purchase_request_draft', { itemIdOrSku: item.sku, quantity: Math.max(1, shortage), reason: '库存风险补货。' })],
        dataLimitations: [limitation('库存口径', '库存风险基于当前可用库存、安全库存和再订货点。', '实际需求变化仍需人工确认。')],
      })
    })
}
function buildDataQualityItems(data, documents) {
  const rfqCount = documents.filter((doc) => doc.documentType === 'rfq').length
  const grnCount = documents.filter((doc) => doc.documentType === 'grn').length
  const invoiceCount = supplierInvoicesFor(data).length
  const gaps = [
    rfqCount ? null : '供应商报价',
    grnCount ? null : 'GRN',
    invoiceCount ? null : 'Invoice',
    '联系人/证书',
    '字段映射',
  ].filter(Boolean)
  return [actionItem({
    id: 'data-quality-gap-workspace',
    category: 'data_quality_gap',
    categoryLabel: '数据缺口',
    title: '数据依据完整性需复核',
    priorityScore: 54 + gaps.length * 6,
    status: '需复核',
    owner: '数据接入',
    businessObjectLabel: '数据接入与质量',
    moduleId: 'imports',
    entityType: 'data_quality_issue',
    entityId: 'data-quality-gap-workspace',
    reason: `需要复核供应商报价、GRN、Invoice、联系人/证书和字段映射；当前缺口会影响风险、已收未票和三单匹配判断。`,
    keyEvidence: [evidence('data_quality', 'data-quality-gap-workspace', `RFQ ${rfqCount} 条、GRN ${grnCount} 条、Invoice ${invoiceCount} 条；仍需复核字段映射和缺失项。`, { status: '需复核' })],
    businessImpact: [impact('数据质量', '判断依据完整性', 'warning', '缺失数据会降低行动优先级解释和证据链完整性。')],
    suggestedNextStep: '打开数据接入与质量，复核导入任务、字段映射和缺失项。',
    navigationLinks: [navigationLink('打开数据接入与质量', 'data_quality', 'data-quality-gap-workspace')],
    reviewActions: [reviewAction('标记需人工复核预览', '把缺失报价、GRN、Invoice 和字段映射问题整理成内部复核清单。', { moduleId: 'imports', entityType: 'data_quality_issue', entityId: 'data-quality-gap-workspace' }, 'exception_note', { reason: '数据依据完整性复核。' })],
    dataLimitations: [
      limitation('缺失数据', '部分报价、GRN、Invoice、联系人/证书或字段映射可能不完整。', '不完整时不能形成最终判断。', gaps),
    ],
  })]
}
function sharedAiEvidence(aiResponse) {
  const contract = aiResponse?.cards?.find((card) => card.type === 'ai_response_v2')?.data
  return new Set(asArray(contract?.keyEvidence).map((item) => `${item.moduleId}:${item.entityId}`).filter(Boolean))
}
function prioritizeWithCategoryCoverage(items = [], limit = 28) {
  const sorted = [...items].sort((a, b) => b.priorityScore - a.priorityScore || a.id.localeCompare(b.id))
  const required = [
    'supplier_risk',
    'po_unreceived',
    'received_not_invoiced',
    'invoice_variance',
    'three_way_match_variance',
    'rfq_pending_response',
    'inventory_risk',
    'data_quality_gap',
  ]
  const chosen = []
  const seen = new Set()
  for (const category of required) {
    const item = sorted.find((candidate) => candidate.category === category && !seen.has(candidate.id))
    if (!item) continue
    chosen.push(item)
    seen.add(item.id)
  }
  for (const item of sorted) {
    if (chosen.length >= limit) break
    if (seen.has(item.id)) continue
    chosen.push(item)
    seen.add(item.id)
  }
  return chosen.sort((a, b) => b.priorityScore - a.priorityScore || a.id.localeCompare(b.id))
}
export function buildOperationsControlTowerV2(data = {}, options = {}) {
  const now = options.now || new Date()
  const documents = buildProcurementDocuments(data)
  const items = uniqueBy([
    ...buildSupplierRiskItems(data, documents),
    ...buildPoItems(data, documents, now),
    ...buildReceivedNotInvoicedItems(data, documents),
    ...buildMatchItems(data, documents),
    ...buildRfqItems(data, documents),
    ...buildRequisitionItems(data, documents),
    ...buildInventoryRiskItems(data, documents),
    ...buildDataQualityItems(data, documents),
  ], (item) => item.id)
    .filter((item) => item.priorityScore > 0)
  const prioritizedItems = prioritizeWithCategoryCoverage(items)
  const aiToday = buildAiResponseContractV2(data, { moduleId: 'overview', question: '今天有什么需要我处理？' }, options)
  const shared = sharedAiEvidence(aiToday)
  const topPriorityLabel = prioritizedItems[0] ? `${prioritizedItems[0].priority} · ${prioritizedItems[0].title}` : '暂无高优先级事项'
  return {
    summary: {
      totalOpenItems: prioritizedItems.length,
      riskCount: prioritizedItems.filter((item) => item.severity === 'risk').length,
      warningCount: prioritizedItems.filter((item) => item.severity === 'warning').length,
      overdueCount: prioritizedItems.filter((item) => /已过|逾期|ETA/.test(item.reason) && item.priorityScore >= 70).length,
      draftAvailableCount: prioritizedItems.filter((item) => item.reviewActions.length).length,
      dataGapCount: prioritizedItems.filter((item) => item.category === 'data_quality_gap' || item.dataLimitations.length).length,
      topPriorityLabel,
    },
    items: prioritizedItems.map((item) => ({
      ...item,
      alignsWithAiToday: item.keyEvidence.some((ev) => shared.has(`${ev.moduleId}:${ev.entityId}`)) || item.category === 'data_quality_gap',
    })),
    generatedAt: new Date().toISOString(),
    dataScopeLabel: '当前工作区数据',
    limitations: [
      limitation('只读控制塔', 'Operations Control Tower 只读取当前业务数据，不执行审批、下单、收货、发票处理、资金处理或财务凭证写入。'),
      limitation('当前数据范围', '优先级基于当前 PR / RFQ / PO / GRN / Invoice / Supplier / Inventory 记录。', '外部确认和缺失字段仍需人工复核。'),
    ],
    aiAlignment: {
      intent: 'today_work_queue_v2',
      sharedEvidenceCount: items.reduce((sum, item) => sum + item.keyEvidence.filter((ev) => shared.has(`${ev.moduleId}:${ev.entityId}`)).length, 0),
      topCategories: prioritizedItems.slice(0, 5).map((item) => item.category),
    },
  }
}
