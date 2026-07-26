import {
  buildProcurementDocuments,
  buildProcurementFollowups,
  buildProcurementSummary,
  buildProcurementSupplierInvoices,
  buildProcurementThreeWayMatches,
} from './procurement-read-model.mjs'
import {
  buildInventoryExceptions,
  buildInventoryItems,
  buildInventoryMovements,
  buildInventorySummary,
} from './inventory-read.mjs'
import { buildSupplierEntityIndex } from './ai-supplier-operational-query.mjs'

export const FORBIDDEN_AI_RESPONSE_V2_ACTION_PATTERN = /自动批准|自动下单|正式创建\s*PO|下发\s*PO|发送\s*PO|发布\s*RFQ|邀请供应商|发送供应商邮件|提交收货|Receive Submit|Submit Receipt|修改库存|库存过账|Post Invoice|Approve Invoice|Mark as Paid|Payment execution|Export to Accounting|会计过账|付款|修改供应商主数据|修改付款条款|更新银行账户|更新税务信息|发布风险评级|自动黑名单|自动暂停供应商|合同签署/i
export const FORBIDDEN_AI_RESPONSE_V2_TECHNICAL_PATTERN = /JSON|dry-run|tenantId|userId|datasetId|writesDb|writesFiles|tool_result|provider|fallback|deterministic|mock|fake|demo|UAT|sample data|demo data|response_card|entityType|documentType|raw enum/i

function asArray(value) {
  return Array.isArray(value) ? value : []
}

function text(value, fallback = '') {
  const next = String(value ?? '').trim()
  return next || fallback
}

function compact(value = '') {
  return text(value).toLowerCase().replace(/[^\w\u4e00-\u9fa5-]+/g, '')
}

function toNumber(value, fallback = 0) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function money(value = 0, currency = 'CNY') {
  const prefix = currency === 'CNY' ? '¥' : `${currency} `
  return `${prefix}${toNumber(value, 0).toLocaleString()}`
}

function uniqueBy(items = [], keyOf = (item) => item) {
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

function normalizeMessage(body = {}) {
  return text(body.question || body.message || body.prompt || body.text)
}

function supplierInvoicesFor(db = {}) {
  return asArray(db.supplierInvoices).length
    ? asArray(db.supplierInvoices)
    : asArray(db.invoices || db.payables || db.supplierInvoiceRecords)
}

function modelInput(db = {}) {
  return { ...db, supplierInvoices: supplierInvoicesFor(db) }
}

function readModels(db = {}, options = {}) {
  const data = modelInput(db)
  return {
    data,
    procurementDocuments: buildProcurementDocuments(data),
    procurementFollowups: buildProcurementFollowups(data, options),
    procurementSummary: buildProcurementSummary(data),
    supplierInvoices: buildProcurementSupplierInvoices(data),
    threeWayMatches: buildProcurementThreeWayMatches(data),
    inventoryItems: buildInventoryItems(data),
    inventoryMovements: typeof options.ensureInventoryMovements === 'function'
      ? asArray(options.ensureInventoryMovements(data))
      : buildInventoryMovements(data),
    inventoryExceptions: buildInventoryExceptions(data),
    inventorySummary: buildInventorySummary(data),
  }
}

function isTerminalStatus(status = '') {
  return ['已完成', '已取消', '已关闭', '已收货', '已转PO', '已授标', '已付款', 'completed', 'closed', 'cancelled', 'canceled', 'paid'].includes(text(status).toLowerCase())
}

function dateMs(value = '') {
  const raw = text(value)
  if (!raw) return 0
  const iso = raw.match(/^20\d{2}-\d{2}-\d{2}/)?.[0]
  if (iso) return new Date(`${iso}T00:00:00.000Z`).getTime()
  const zh = raw.match(/(\d{1,2})月(\d{1,2})日/)
  if (zh) return new Date(`2026-${String(zh[1]).padStart(2, '0')}-${String(zh[2]).padStart(2, '0')}T00:00:00.000Z`).getTime()
  return 0
}

function isPastDue(value = '', now = new Date()) {
  const due = dateMs(value)
  if (!due) return false
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  return due < today
}

function docTypeFromId(id = '') {
  const value = text(id)
  if (/^PR-/i.test(value)) return 'pr'
  if (/^RFQ-/i.test(value)) return 'rfq'
  if (/^PO-/i.test(value)) return 'po'
  if (/^GRN-/i.test(value)) return 'grn'
  if (/^INV-/i.test(value)) return 'invoice'
  if (/^MATCH-/i.test(value)) return 'threeWayMatch'
  if (/^SKU-/i.test(value)) return 'inventory_item'
  if (/^SUP-/i.test(value)) return 'supplier'
  return ''
}

function moduleForType(type = '') {
  const normalized = text(type)
  if (normalized === 'pr') return 'procurement:requests'
  if (normalized === 'rfq') return 'procurement:rfq'
  if (normalized === 'po') return 'procurement:orders'
  if (normalized === 'grn') return 'procurement:receiving'
  if (normalized === 'invoice' || normalized === 'threeWayMatch') return 'procurement:invoices'
  if (normalized === 'inventory_item' || normalized === 'sku') return 'inventory'
  if (normalized === 'supplier') return 'srm:master'
  if (normalized === 'data_quality') return 'imports'
  return 'overview'
}

function entityTypeForType(type = '') {
  const normalized = text(type)
  if (normalized === 'pr') return 'purchase_request'
  if (normalized === 'rfq') return 'rfq'
  if (normalized === 'po') return 'purchase_order'
  if (normalized === 'grn') return 'receiving_doc'
  if (normalized === 'invoice') return 'supplier_invoice'
  if (normalized === 'threeWayMatch') return 'supplier_invoice'
  if (normalized === 'inventory_item' || normalized === 'sku') return 'inventory_item'
  if (normalized === 'supplier') return 'supplier'
  if (normalized === 'data_quality') return 'data_quality_issue'
  return 'business_object'
}

function docLabel(type = '', id = '') {
  const normalized = text(type || docTypeFromId(id))
  const nextId = text(id)
  if (normalized === 'pr') return `PR ${nextId}`.trim()
  if (normalized === 'rfq') return `RFQ ${nextId}`.trim()
  if (normalized === 'po') return `PO ${nextId}`.trim()
  if (normalized === 'grn') return `GRN ${nextId}`.trim()
  if (normalized === 'invoice') return `Invoice ${nextId}`.trim()
  if (normalized === 'threeWayMatch') return `三单匹配 ${nextId}`.trim()
  if (normalized === 'inventory_item' || normalized === 'sku') return `SKU ${nextId}`.trim()
  if (normalized === 'supplier') return `供应商 ${nextId}`.trim()
  if (normalized === 'data_quality') return '数据接入与质量'
  return nextId
}

function severityForStatus(status = '', fallback = 'info') {
  const value = text(status)
  if (/高|逾期|异常|差异|缺货|拒|失败|风险|未匹配|待贷项/.test(value)) return 'risk'
  if (/中|待|进行中|部分|低库存|预警|人工复核|未收|未票/.test(value)) return 'warning'
  if (/已匹配|已完成|已收货|正常|低/.test(value)) return 'success'
  return fallback
}

function documentById(models, id = '') {
  const needle = text(id).toLowerCase()
  return asArray(models.procurementDocuments).find((doc) => text(doc.id).toLowerCase() === needle) || null
}

function rawPoById(data = {}, poId = '') {
  const needle = text(poId).toLowerCase()
  return asArray(data.purchaseOrders).find((po) => text(po.po || po.poId || po.id).toLowerCase() === needle) || null
}

function rawGrnsForPo(data = {}, poId = '') {
  const needle = text(poId).toLowerCase()
  return asArray(data.receivingDocs).filter((grn) => [grn.po, grn.poId, grn.purchaseOrder, grn.purchaseOrderId].some((value) => text(value).toLowerCase() === needle))
}

function rawInvoicesForPo(data = {}, poId = '') {
  const needle = text(poId).toLowerCase()
  return supplierInvoicesFor(data).filter((invoice) => [invoice.relatedPo, invoice.po, invoice.poId, invoice.purchaseOrderId].some((value) => text(value).toLowerCase() === needle))
}

function rawInvoicesForGrn(data = {}, grnId = '') {
  const needle = text(grnId).toLowerCase()
  return supplierInvoicesFor(data).filter((invoice) => [invoice.relatedGrn, invoice.grn, invoice.grnId, invoice.receivingId].some((value) => text(value).toLowerCase() === needle))
}

function lineQuantity(line = {}, keys = []) {
  for (const key of keys) {
    if (line[key] !== undefined && line[key] !== null && line[key] !== '') return toNumber(line[key], 0)
  }
  return 0
}

function primaryPoLine(po = {}) {
  const line = asArray(po.lines)[0] || {}
  return {
    poLineId: text(line.poLineId || line.lineId || line.id, `${text(po.po || po.id || 'PO')}-LINE-1`),
    sku: text(line.sku || po.sourceSku || po.sku),
    itemName: text(line.itemName || line.name || po.sourceName),
    orderedQty: lineQuantity(line, ['quantityOrdered', 'orderedQty', 'quantity']) || toNumber(po.totalOrderedQty ?? po.items ?? po.quantity, 0),
    receivedQty: lineQuantity(line, ['quantityReceived', 'receivedQty', 'received']) || toNumber(po.totalReceivedQty ?? po.received, 0),
    invoicedQty: lineQuantity(line, ['quantityInvoiced', 'invoicedQty', 'approvedInvoicedQty', 'invoiced']) || toNumber(po.totalInvoicedQty ?? po.invoiced, 0),
    unit: text(line.unit || po.unit),
    unitPrice: toNumber(line.unitPrice ?? po.unitPrice, 0),
    currency: text(line.currency || po.currency, 'CNY'),
  }
}

function primaryGrnLine(grn = {}) {
  const line = asArray(grn.lines)[0] || {}
  return {
    grnLineId: text(line.grnLineId || line.lineId || line.id, `${text(grn.grn || grn.id || 'GRN')}-LINE-1`),
    poLineId: text(line.poLineId),
    receivedQty: lineQuantity(line, ['receivedQty', 'quantityReceived', 'received']) || toNumber(grn.items, 0),
    acceptedQty: lineQuantity(line, ['acceptedQty', 'passed', 'quantityAccepted']) || toNumber(grn.passed, 0),
    rejectedQty: lineQuantity(line, ['rejectedQty', 'failed', 'quantityRejected']) || toNumber(grn.failed, 0),
    unit: text(line.unit || grn.unit),
  }
}

function primaryInvoiceLine(invoice = {}) {
  const line = asArray(invoice.lines)[0] || {}
  const id = text(invoice.invoiceNumber || invoice.invoiceId || invoice.id || 'Invoice')
  return {
    invoiceLineId: text(line.lineId || line.invoiceLineId || line.id, `${id}-LINE-1`),
    grnLineId: text(line.grnLineId || line.receiptLineId),
    quantity: lineQuantity(line, ['quantity', 'invoiceQty', 'invoicedQty', 'qty']) || toNumber(invoice.quantity, 0),
    unitPrice: toNumber(line.unitPrice ?? invoice.unitPrice, 0),
    amount: toNumber(line.amount ?? invoice.amount ?? invoice.total ?? invoice.grossAmount, 0),
  }
}

function evidenceItem(input = {}) {
  const type = input.type || docTypeFromId(input.entityId)
  const moduleId = input.moduleId || moduleForType(type)
  const entityType = input.entityType || entityTypeForType(type)
  const entityId = text(input.entityId || input.id)
  const entityLabel = text(input.entityLabel || input.label || docLabel(type, entityId))
  return {
    id: text(input.id, `${type || 'evidence'}-${entityId || entityLabel}`),
    label: text(input.label, entityLabel),
    entityLabel,
    entityType,
    entityId,
    moduleId,
    evidenceType: text(input.evidenceType || input.typeLabel || '业务证据'),
    summary: text(input.summary),
    value: input.value ?? null,
    status: text(input.status),
    severity: input.severity || severityForStatus(input.status),
    sourceLabel: text(input.sourceLabel, '当前工作区数据'),
    linkTarget: input.linkTarget || (moduleId ? { moduleId, entityType, entityId } : undefined),
  }
}

function evidenceFromDocument(doc = {}, overrides = {}) {
  const type = overrides.type || doc.documentType || docTypeFromId(doc.id)
  const id = text(overrides.entityId || doc.id)
  return evidenceItem({
    type,
    id: `${type}-${id}`,
    entityId: id,
    entityLabel: docLabel(type, id),
    status: overrides.status ?? doc.status ?? doc.invoiceStatus ?? doc.matchStatus,
    value: overrides.value ?? doc.amount,
    summary: overrides.summary || doc.blockingReason || doc.exceptionReason || doc.reason || `${docLabel(type, id)} ${text(doc.status || doc.matchStatus || '需要复核')}`,
    severity: overrides.severity,
  })
}

function evidenceFromInventory(item = {}, overrides = {}) {
  const sku = text(overrides.entityId || item.sku || item.id)
  return evidenceItem({
    type: 'inventory_item',
    id: `sku-${sku}`,
    entityId: sku,
    entityLabel: `SKU ${sku}`,
    status: overrides.status || item.status || item.riskLevel,
    value: overrides.value ?? item.availableQuantity,
    summary: overrides.summary || `${item.itemName || sku} 可用 ${toNumber(item.availableQuantity, 0).toLocaleString()}，安全库存 ${toNumber(item.safetyStock, 0).toLocaleString()}。`,
    severity: overrides.severity || severityForStatus(item.riskLevel || item.status),
  })
}

function evidenceFromSupplier(row = {}, overrides = {}) {
  return evidenceItem({
    type: 'supplier',
    id: `supplier-${row.supplierId || row.supplierName}`,
    entityId: text(row.supplierId || row.supplierName),
    entityLabel: text(row.supplierName || row.supplierId),
    status: overrides.status || row.risk,
    value: overrides.value ?? row.score,
    summary: overrides.summary || `风险信号：PO ${row.openPoCount || 0}，RFQ ${row.pendingRfqResponseCount || 0}，Invoice 差异 ${row.invoiceIssueCount || 0}。`,
    severity: overrides.severity || (row.risk === '高' || row.signalScore > 3 ? 'risk' : 'warning'),
  })
}

function evidenceFromDataQuality(summary = '') {
  return evidenceItem({
    type: 'data_quality',
    id: 'data-quality-ai-v2',
    entityId: 'data-quality-ai-v2',
    entityLabel: '数据接入与质量',
    status: '需复核',
    summary,
    severity: 'warning',
  })
}

function navLink(label, moduleId, entityType = '', entityId = '', reason = '') {
  return {
    label,
    moduleId,
    entityType: entityType || undefined,
    entityId: entityId || undefined,
    returnLabel: '返回 AI 结果',
    reason,
  }
}

function navFromEvidence(item, label = '') {
  return navLink(label || `查看 ${item.entityLabel}`, item.moduleId, item.entityType, item.entityId, item.summary)
}

function action(label, description, priority = 'medium', target = {}) {
  return {
    label,
    description,
    actionType: 'review_navigation',
    priority,
    reviewRequired: true,
    targetModule: target.moduleId,
    targetEntityType: target.entityType,
    targetEntityId: target.entityId,
  }
}

const prohibitedActions = Object.freeze([
  '审批执行',
  '采购单发出',
  '外部消息外发',
  '库存写入',
  '财务凭证写入',
  '资金处理',
  '供应商资料变更',
])

function originEvidence(items = []) {
  return asArray(items).map((item) => ({
    type: item.entityType,
    id: item.entityId,
    label: item.entityLabel,
    summary: item.summary,
  }))
}

function reviewCard(title, description, target = {}, extra = {}) {
  return {
    title,
    description,
    previewOnly: true,
    requiresHumanReview: true,
    prohibitedActions: [...prohibitedActions],
    allowedNextStep: extra.allowedNextStep || '先形成内部可审阅草稿，再由业务用户决定下一步。',
    targetModule: target.moduleId,
    targetEntityType: target.entityType,
    targetEntityId: target.entityId,
    draftType: extra.draftType,
    draftTitle: extra.draftTitle || title,
    payload: extra.payload || {},
    originEvidence: extra.originEvidence || [],
  }
}

function limitation(label, description, severity = 'warning', consequence = '', missingData = []) {
  return {
    label,
    description,
    severity,
    missingData,
    consequence,
  }
}

function impact(area, impactLabel, severity, explanation, affectedObjects = []) {
  return {
    area,
    impact: impactLabel,
    severity,
    explanation,
    affectedObjects,
  }
}

function baseContract({ query, intent, scope = {}, conclusion, keyEvidence, businessImpact, recommendedActions, navigationLinks, dataLimitations, reviewCards, followUpQuestions = [] }) {
  return {
    version: 'v2',
    query,
    intent,
    scope: {
      module: scope.module,
      entityType: scope.entityType,
      entityId: scope.entityId,
      timeRange: scope.timeRange,
      dataScopeLabel: scope.dataScopeLabel || '当前工作区数据',
    },
    conclusion,
    keyEvidence: uniqueBy(keyEvidence, (item) => `${item.moduleId}:${item.entityId}:${item.summary}`).slice(0, 8),
    businessImpact: businessImpact.slice(0, 6),
    recommendedActions: recommendedActions.slice(0, 6),
    navigationLinks: uniqueBy(navigationLinks, (item) => `${item.moduleId}:${item.entityId || item.label}`).slice(0, 8),
    dataLimitations: dataLimitations.slice(0, 6),
    reviewCards: reviewCards.slice(0, 5),
    followUpQuestions,
  }
}

function wrapResponse(contract, startedAt = Date.now()) {
  const evidence = contract.keyEvidence.map((item) => ({
    type: item.entityType,
    id: item.entityId,
    label: item.entityLabel,
    status: item.status,
    summary: item.summary,
    route: item.linkTarget?.moduleId || item.moduleId,
  }))
  return {
    provider: 'local_ai_response_contract_v2',
    mode: 'read',
    content: contract.conclusion.summary,
    message: contract.conclusion.summary,
    intent: { name: contract.intent, confidence: 0.91, slots: {} },
    cards: [{ type: 'ai_response_v2', title: contract.conclusion.title, data: contract }],
    evidence,
    usedWeb: false,
    timingMs: Date.now() - startedAt,
    externalMs: 0,
    modelMs: 0,
  }
}

function supplierMatchesRecord(record = {}, row = {}) {
  const keys = [row.supplierId, row.supplierName, ...(row.aliases || [])].map(compact).filter(Boolean)
  const values = [
    record.supplier,
    record.supplierName,
    record.supplierId,
    record.vendor,
    record.bestSupplier,
    record.awardedSupplier,
  ].map(compact)
  return values.some((value) => value && keys.includes(value))
}

function supplierRiskRows(db = {}, models = {}) {
  const index = buildSupplierEntityIndex(db)
  return uniqueBy(index.candidates, (row) => row.supplierId || row.supplierName).map((supplier) => {
    const docs = asArray(models.procurementDocuments).filter((doc) => supplierMatchesRecord(doc, supplier))
    const pos = docs.filter((doc) => doc.documentType === 'po')
    const rfqs = docs.filter((doc) => doc.documentType === 'rfq')
    const invoices = docs.filter((doc) => doc.documentType === 'invoice' || doc.documentType === 'threeWayMatch')
    const grns = docs.filter((doc) => doc.documentType === 'grn')
    const score = toNumber(supplier.score ?? supplier.rating ?? supplier.grade, null)
    const explicitRisk = text(supplier.risk || supplier.riskStatus)
    const overduePoCount = pos.filter((po) => isPastDue(po.expectedDate || po.dueDate) && !isTerminalStatus(po.status)).length
    const pendingRfqResponseCount = rfqs.reduce((sum, rfq) => sum + toNumber(rfq.pendingSupplierCount, 0), 0)
    const invoiceIssueCount = invoices.filter((invoice) => toNumber(invoice.varianceAmount, 0) !== 0 || /差异|异常|待复核|未匹配/.test(text(invoice.matchStatus || invoice.status))).length
    const receivingIssueCount = grns.filter((grn) => /异常|差异|待|质检/.test(text(grn.status))).length
    const signalScore =
      (/高|high/i.test(explicitRisk) ? 5 : /中|medium/i.test(explicitRisk) ? 2 : 0) +
      overduePoCount * 2 +
      pendingRfqResponseCount +
      invoiceIssueCount * 2 +
      receivingIssueCount
    return {
      ...supplier,
      risk: /高|high/i.test(explicitRisk) || signalScore >= 4 || (score !== null && score < 75) ? '高' : /中|medium/i.test(explicitRisk) || signalScore > 0 ? '中' : '低',
      score,
      openPoCount: pos.filter((po) => !isTerminalStatus(po.status)).length,
      overduePoCount,
      pendingRfqResponseCount,
      invoiceIssueCount,
      receivingIssueCount,
      signalScore,
      documents: docs,
    }
  }).sort((a, b) => b.signalScore - a.signalScore || (a.score ?? 100) - (b.score ?? 100) || text(a.supplierName).localeCompare(text(b.supplierName)))
}

function unreceivedPoRows(db = {}, models = {}, now = new Date()) {
  return asArray(models.procurementDocuments)
    .filter((doc) => doc.documentType === 'po' && !isTerminalStatus(doc.status) && toNumber(doc.orderedQuantity, 0) > toNumber(doc.receivedQuantity, 0))
    .map((po) => {
      const raw = rawPoById(db, po.id) || {}
      const line = primaryPoLine(raw)
      const remaining = Math.max(0, toNumber(po.orderedQuantity, line.orderedQty) - toNumber(po.receivedQuantity, line.receivedQty))
      return {
        po,
        raw,
        line,
        remaining,
        eta: po.expectedDate || po.dueDate || raw.eta || raw.expectedDate,
        overdue: isPastDue(po.expectedDate || po.dueDate || raw.eta, now),
        grns: rawGrnsForPo(db, po.id),
      }
    })
    .sort((a, b) => Number(b.overdue) - Number(a.overdue) || b.remaining - a.remaining || text(a.eta || '9999-12-31').localeCompare(text(b.eta || '9999-12-31')))
}

function receivedNotInvoicedRows(db = {}, models = {}) {
  return asArray(models.procurementDocuments)
    .filter((doc) => doc.documentType === 'po')
    .map((po) => {
      const raw = rawPoById(db, po.id) || {}
      const line = primaryPoLine(raw)
      const grn = rawGrnsForPo(db, po.id)[0] || {}
      const grnLine = primaryGrnLine(grn)
      const invoices = rawInvoicesForPo(db, po.id)
      const invoiceQty = invoices.reduce((sum, invoice) => {
        const invoiceLine = primaryInvoiceLine(invoice)
        return sum + (invoiceLine.quantity || toNumber(invoice.invoicedQty ?? invoice.quantity, 0))
      }, 0)
      const receivedQty = line.receivedQty || toNumber(po.receivedQuantity, 0)
      const uninvoicedQty = Math.max(0, receivedQty - (line.invoicedQty || invoiceQty))
      const unitPrice = line.unitPrice || (toNumber(po.amount, 0) && line.orderedQty ? toNumber(po.amount, 0) / line.orderedQty : 0)
      return {
        po,
        line,
        grn,
        grnLine,
        invoices,
        receivedQty,
        invoicedQty: line.invoicedQty || invoiceQty,
        uninvoicedQty,
        exposure: uninvoicedQty * unitPrice,
        currency: line.currency || po.currency || 'CNY',
      }
    })
    .filter((row) => row.uninvoicedQty > 0)
    .sort((a, b) => b.exposure - a.exposure || b.uninvoicedQty - a.uninvoicedQty)
}

function matchRows(db = {}, models = {}) {
  const existing = asArray(models.threeWayMatches)
    .filter((match) => toNumber(match.varianceAmount, 0) !== 0 || /差异|异常|未匹配|待复核/.test(text(match.matchStatus || match.status)))
    .map((match) => {
      const rawPo = rawPoById(db, match.poId || match.po) || {}
      const rawGrn = rawGrnsForPo(db, match.poId || match.po).find((grn) => text(grn.grn || grn.id) === text(match.grnId || match.grn)) || {}
      const invoice = supplierInvoicesFor(db).find((item) => text(item.invoiceNumber || item.invoiceId || item.id) === text(match.invoiceId || match.invoice)) || {}
      return { match, poLine: primaryPoLine(rawPo), grnLine: primaryGrnLine(rawGrn), invoiceLine: primaryInvoiceLine(invoice), invoice, rawPo, rawGrn }
    })
  if (existing.length) return existing
  return receivedNotInvoicedRows(db, models).slice(0, 3).map((row) => ({
    match: {
      id: `MATCH-PENDING-${row.po.id}`,
      po: row.po.id,
      poId: row.po.id,
      grn: text(row.grn.grn || row.grn.id),
      grnId: text(row.grn.grn || row.grn.id),
      invoice: 'Invoice Line 待补齐',
      invoiceId: '',
      supplier: row.po.supplierName,
      status: 'Invoice Line 待补齐',
      matchStatus: '待人工复核',
      varianceAmount: row.exposure,
      currency: row.currency,
      blockingReason: '当前已读取到 PO / GRN，但尚未读取到完整 Invoice Line。',
    },
    poLine: row.line,
    grnLine: row.grnLine,
    invoiceLine: { invoiceLineId: 'Invoice Line 待补齐', quantity: 0, unitPrice: 0, amount: 0 },
    invoice: null,
    rawPo: rawPoById(db, row.po.id) || {},
    rawGrn: row.grn,
  }))
}

function inventoryRiskRows(models = {}) {
  return asArray(models.inventoryItems)
    .filter((item) => ['低库存', '缺货', '不足', '预警', '异常'].includes(item.status) || ['高', '中'].includes(item.riskLevel))
    .sort((a, b) => (b.riskLevel === '高' ? 1 : 0) - (a.riskLevel === '高' ? 1 : 0) || toNumber(a.availableQuantity, 0) - toNumber(b.availableQuantity, 0))
}

function preferredTodayEvidence(models = {}, suppliers = []) {
  const preferred = []
  const purchaseOrder = asArray(models.procurementDocuments).find((item) => item.type === 'purchaseOrder')
  const inventoryItem = inventoryRiskRows(models)[0]
  const rfq = asArray(models.procurementDocuments).find((item) => item.type === 'rfq')
  if (purchaseOrder) preferred.push(evidenceFromDocument(purchaseOrder, { summary: `${purchaseOrder.id} 仍需确认未收数量和供应商剩余交期。`, severity: 'risk' }))
  if (inventoryItem) preferred.push(evidenceFromInventory(inventoryItem, { summary: `${inventoryItem.sku} 当前库存风险需和采购在途一起复核。`, severity: 'risk' }))
  if (rfq) preferred.push(evidenceFromDocument(rfq, { summary: `${rfq.id} 仍需确认供应商回复和授标依据。`, severity: 'warning' }))
  const supplier = suppliers.find((row) => row.risk === '高') || suppliers[0]
  if (supplier) preferred.push(evidenceFromSupplier(supplier))
  return preferred
}

function buildTodayContract(query, db, models, options) {
  const suppliers = supplierRiskRows(db, models)
  const unreceived = unreceivedPoRows(db, models, options.now || new Date())
  const rni = receivedNotInvoicedRows(db, models)
  const matches = matchRows(db, models)
  const inventory = inventoryRiskRows(models)
  const evidence = uniqueBy([
    ...preferredTodayEvidence(models, suppliers),
    ...unreceived.slice(0, 2).map((row) => evidenceFromDocument(row.po, { summary: `${row.po.id} PO Line ${row.line.poLineId} 未收数量 ${row.remaining.toLocaleString()}，ETA ${row.eta || '待确认'}。`, severity: row.overdue ? 'risk' : 'warning' })),
    ...matches.slice(0, 1).map((row) => evidenceFromDocument(documentById(models, row.match.invoiceId) || row.match, { type: row.match.invoiceId ? 'invoice' : 'threeWayMatch', entityId: row.match.invoiceId || row.match.id, summary: row.match.blockingReason || '三单匹配需人工复核。', severity: 'risk' })),
    ...inventory.slice(0, 1).map((item) => evidenceFromInventory(item)),
    evidenceFromDataQuality('供应商报价、GRN、Invoice、联系人/证书和字段映射需要持续复核。'),
  ], (item) => `${item.moduleId}:${item.entityId}`)
  const links = evidence.slice(0, 5).map((item) => navFromEvidence(item))
  links.push(navLink('打开数据接入与质量', 'imports', undefined, undefined, '复核缺失字段、导入映射和质量问题。'))
  return baseContract({
    query,
    intent: 'today_work_queue_v2',
    scope: { module: 'overview', timeRange: 'today' },
    conclusion: {
      title: '今天优先处理跨模块风险',
      summary: `今天建议先看供应商风险、PO 未收货、三单匹配/Invoice 差异、已收未票、库存风险和数据不完整事项；当前识别 ${unreceived.length} 张未完全收货 PO、${suppliers.filter((row) => row.risk !== '低').length} 个供应商风险信号、${inventory.length} 个库存风险。`,
      severity: unreceived.length || inventory.length ? 'risk' : 'info',
      confidence: 'high',
    },
    keyEvidence: evidence,
    businessImpact: [
      impact('采购执行', 'PO 未收货', unreceived.length ? 'risk' : 'info', `仍有 ${unreceived.length} 张 PO 未完全收货，可能影响供应承诺。`, unreceived.slice(0, 3).map((row) => row.po.id)),
      impact('供应商协同', '潜在供应风险', suppliers.some((row) => row.risk !== '低') ? 'risk' : 'info', '风险信号来自交期、RFQ 回复、收货异常和 Invoice 差异的组合。', suppliers.slice(0, 3).map((row) => row.supplierName)),
      impact('财务协同', '已收未票与匹配差异', rni.length || matches.length ? 'warning' : 'info', '已收未票只用于协同可见性，不形成会计分录。', rni.slice(0, 3).map((row) => row.po.id)),
      impact('数据质量', '依据不完整', 'warning', '部分判断依赖当前工作区数据，导入映射、供应商资料和 Invoice Line 需要复核。'),
    ],
    recommendedActions: [
      action('查看 PO 未收货', '先打开未完全收货 PO，确认 PO Line、未收数量和 ETA。', 'high', evidence.find((item) => item.entityId.startsWith('PO-'))?.linkTarget),
      action('查看供应商运营档案', '复核供应商风险信号、相关 PO / RFQ / Invoice 和近期异常。', 'high', evidence.find((item) => item.entityType === 'supplier')?.linkTarget),
      action('查看三单匹配与已收未票', '复核 PO、GRN、Invoice Line 是否齐全，再形成内部差异说明。', 'medium', evidence.find((item) => item.entityId.startsWith('INV-') || item.entityId.startsWith('MATCH-'))?.linkTarget),
      action('复核数据接入与质量', '确认缺失字段、字段映射和导入记录是否影响 AI 判断。', 'medium', { moduleId: 'imports' }),
    ],
    navigationLinks: links,
    dataLimitations: [
      limitation('当前数据范围', '仅基于当前工作区可读取的 PR / RFQ / PO / GRN / Invoice / Supplier / Inventory 记录。', 'warning', '缺失外部确认时，需要人工复核交期、报价和发票证据。'),
      limitation('Invoice Line 完整性', supplierInvoicesFor(db).length ? '已读取到部分 Invoice 记录，但仍需人工复核三单匹配差异。' : '当前后端工作区没有完整 Invoice Line。', 'warning', '已收未票仅作协同可见性，不形成会计分录。', supplierInvoicesFor(db).length ? [] : ['Invoice Line']),
      limitation('供应商资料完整性', '联系人、证书、付款条款和银行资料不在本次 AI 自动变更范围内。', 'warning', '供应商资料只展示和复核，不自动改写。'),
    ],
    reviewCards: [
      reviewCard('生成内部复核备注草稿', '汇总今天的 PO 未收货、库存风险和数据缺口，供内部复核。', { moduleId: 'overview' }, { draftType: 'po_followup_draft', originEvidence: originEvidence(evidence) }),
      reviewCard('生成供应商风险说明草稿', '把供应商交期、RFQ、收货和 Invoice 风险整理成内部说明。', evidence.find((item) => item.entityType === 'supplier')?.linkTarget || {}, { draftType: 'supplier_followup_draft', originEvidence: originEvidence(evidence), payload: { supplierIdOrName: suppliers[0]?.supplierName || suppliers[0]?.supplierId || '', message: '请复核供应商风险信号和相关单据。' } }),
      reviewCard('生成差异说明草稿', '整理 PO / GRN / Invoice 差异，供采购和财务共同复核。', evidence.find((item) => item.entityId.startsWith('INV-') || item.entityId.startsWith('MATCH-'))?.linkTarget || {}, { draftType: 'po_followup_draft', originEvidence: originEvidence(evidence) }),
    ],
    followUpQuestions: ['哪些 PO 还没有收货？', '哪些已经收货但还没开票？', '哪些数据依据不完整？'],
  })
}

function buildSupplierRiskContract(query, db, models, singleSupplier = false) {
  const rows = supplierRiskRows(db, models)
  const target = singleSupplier ? rows[0] : null
  const selectedRows = target ? [target] : rows.filter((row) => row.risk !== '低' || row.signalScore > 0).slice(0, 5)
  const fallbackRows = selectedRows.length ? selectedRows : rows.slice(0, 3)
  const relatedDocs = uniqueBy(fallbackRows.flatMap((row) => row.documents || []), (doc) => `${doc.documentType}:${doc.id}`).slice(0, 5)
  const evidence = [
    ...fallbackRows.map((row) => evidenceFromSupplier(row, { summary: `风险信号：逾期 PO ${row.overduePoCount}、RFQ 待回复 ${row.pendingRfqResponseCount}、收货异常 ${row.receivingIssueCount}、Invoice 差异 ${row.invoiceIssueCount}。` })),
    ...relatedDocs.map((doc) => evidenceFromDocument(doc, { summary: `${docLabel(doc.documentType, doc.id)} 与供应商风险信号相关。` })),
  ]
  const primary = fallbackRows[0]
  return baseContract({
    query,
    intent: singleSupplier ? 'supplier_recent_issues_v2' : 'supplier_risk_summary_v2',
    scope: { module: 'srm', entityType: primary ? 'supplier' : undefined, entityId: primary?.supplierId || primary?.supplierName },
    conclusion: {
      title: singleSupplier ? '供应商近期问题' : '供应商潜在风险',
      summary: fallbackRows.length
        ? `当前重点供应商是 ${fallbackRows.map((row) => row.supplierName).slice(0, 3).join('、')}；风险信号来自相关 PO / RFQ / GRN / Invoice 和供应商运营档案。`
        : '当前没有识别出明显供应商风险，但仍建议保留周期性复核。',
      severity: fallbackRows.some((row) => row.risk === '高') ? 'risk' : 'warning',
      confidence: fallbackRows.length ? 'high' : 'medium',
    },
    keyEvidence: evidence,
    businessImpact: [
      impact('供应连续性', '交期与收货风险', fallbackRows.some((row) => row.overduePoCount || row.receivingIssueCount) ? 'risk' : 'warning', '逾期 PO 或 GRN 异常会影响后续生产和客户交付。', relatedDocs.filter((doc) => doc.documentType === 'po' || doc.documentType === 'grn').map((doc) => doc.id)),
      impact('寻源协同', 'RFQ 回复风险', fallbackRows.some((row) => row.pendingRfqResponseCount) ? 'warning' : 'info', 'RFQ 未及时回复会影响报价比较和授标建议。'),
      impact('财务协同', 'Invoice 差异风险', fallbackRows.some((row) => row.invoiceIssueCount) ? 'risk' : 'info', '发票差异需要采购、收货和财务共同复核。'),
    ],
    recommendedActions: [
      action('查看供应商运营档案', '打开供应商档案，复核风险信号和关联单据。', 'high', evidence.find((item) => item.entityType === 'supplier')?.linkTarget),
      action('查看相关 PO / RFQ / Invoice', '沿证据链检查交期、报价回复和发票差异。', 'high', evidence.find((item) => item.entityId.startsWith('PO-') || item.entityId.startsWith('RFQ-') || item.entityId.startsWith('INV-'))?.linkTarget),
      action('生成内部风险说明草稿', '先形成内部说明，再由业务用户决定是否沟通供应商。', 'medium', evidence.find((item) => item.entityType === 'supplier')?.linkTarget),
    ],
    navigationLinks: [
      ...(evidence.find((item) => item.entityType === 'supplier') ? [navFromEvidence(evidence.find((item) => item.entityType === 'supplier'), '供应商运营档案')] : []),
      ...evidence.filter((item) => item.entityId.startsWith('PO-') || item.entityId.startsWith('RFQ-') || item.entityId.startsWith('INV-')).slice(0, 4).map((item) => navFromEvidence(item)),
    ],
    dataLimitations: [
      limitation('风险信号来源', '供应商风险基于当前 PO、RFQ、GRN、Invoice 和供应商资料，不替代正式评级。', 'warning', '最终风险等级需要人工确认。'),
      limitation('资料完整性', '联系人、证书和付款资料可能不完整，本次仅提示需复核。', 'warning', '不会改写供应商资料。', ['联系人', '证书']),
    ],
    reviewCards: [
      reviewCard('生成供应商风险说明草稿', '整理交期、收货、RFQ 和 Invoice 风险，作为内部复核材料。', evidence.find((item) => item.entityType === 'supplier')?.linkTarget || {}, { draftType: 'supplier_followup_draft', originEvidence: originEvidence(evidence), payload: { supplierIdOrName: primary?.supplierName || primary?.supplierId || '', message: '请复核供应商近期风险信号。' } }),
    ],
    followUpQuestions: ['这个供应商最近有什么问题？', '哪些 PO 还没有收货？'],
  })
}

function buildUnreceivedPoContract(query, db, models, options) {
  const rows = unreceivedPoRows(db, models, options.now || new Date()).slice(0, 6)
  const evidence = rows.map((row) => evidenceFromDocument(row.po, {
    summary: `${row.po.id} · PO Line ${row.line.poLineId} · 未收数量 ${row.remaining.toLocaleString()}${row.line.unit ? ` ${row.line.unit}` : ''} · ETA ${row.eta || '待确认'} · 供应商 ${row.po.supplierName || '待确认'}。`,
    severity: row.overdue ? 'risk' : 'warning',
  }))
  return baseContract({
    query,
    intent: 'po_unreceived_v2',
    scope: { module: 'procurement:orders' },
    conclusion: {
      title: 'PO 未收货清单',
      summary: rows.length ? `当前有 ${rows.length} 张 PO 未完全收货，优先复核 PO Line、未收数量、ETA 和供应商交期。` : '当前没有识别到未完全收货的开放 PO。',
      severity: rows.length ? 'risk' : 'success',
      confidence: 'high',
    },
    keyEvidence: evidence,
    businessImpact: [
      impact('采购执行', '未收货风险', rows.length ? 'risk' : 'success', '未收数量可能影响生产排程和客户交付承诺。', rows.slice(0, 3).map((row) => row.po.id)),
      impact('供应商协同', 'ETA 需要确认', rows.some((row) => row.overdue) ? 'risk' : 'warning', '逾期或临近 ETA 的 PO 需要供应商确认剩余交期。'),
    ],
    recommendedActions: [
      action('查看 PO', '打开采购订单，查看 PO Line、已收数量和未收数量。', 'high', evidence[0]?.linkTarget),
      action('查看收货记录', '对照 GRN / Receipt Line，确认是否存在收货延迟或质检异常。', 'high', { moduleId: 'procurement:receiving', entityType: 'receiving_doc', entityId: rows[0]?.grns?.[0]?.grn || rows[0]?.grns?.[0]?.id }),
      action('生成内部跟进备注草稿', '形成内部复核备注，业务用户确认后再跟进供应商。', 'medium', evidence[0]?.linkTarget),
    ],
    navigationLinks: [
      ...evidence.slice(0, 4).map((item) => navFromEvidence(item, `查看 ${item.entityLabel}`)),
      navLink('查看收货记录', 'procurement:receiving', 'receiving_doc', rows[0]?.grns?.[0]?.grn || rows[0]?.grns?.[0]?.id || '', '复核关联 GRN / Receipt Line。'),
    ],
    dataLimitations: [
      limitation('收货记录完整性', '如果某个 PO 没有 GRN，当前只能判断为未读取到收货记录。', 'warning', '需要人工确认是否存在尚未导入的收货单。', ['GRN / Receipt Line']),
    ],
    reviewCards: [
      reviewCard('生成内部复核备注草稿', '整理 PO Line、未收数量、ETA 和供应商信息，供内部复核。', evidence[0]?.linkTarget || {}, { draftType: 'po_followup_draft', originEvidence: originEvidence(evidence), payload: { poId: rows[0]?.po?.id || '', message: '请复核未收货 PO 和供应商 ETA。' } }),
    ],
    followUpQuestions: ['哪些已经收货但还没开票？', '这个 PO 为什么优先？'],
  })
}

function buildReceivedNotInvoicedContract(query, db, models) {
  const rows = receivedNotInvoicedRows(db, models).slice(0, 6)
  const evidence = rows.map((row) => evidenceFromDocument(row.po, {
    summary: `${row.po.id} · PO Line ${row.line.poLineId} · GRN Line ${row.grnLine.grnLineId || '待补齐'} · 已收数量 ${row.receivedQty.toLocaleString()} · 未开票数量 ${row.uninvoicedQty.toLocaleString()} · 已收未票金额 ${money(row.exposure, row.currency)}。`,
    status: '已收未票',
    severity: 'warning',
  }))
  return baseContract({
    query,
    intent: 'received_not_invoiced_v2',
    scope: { module: 'procurement:invoices' },
    conclusion: {
      title: '已收未票可见性',
      summary: rows.length ? `当前识别 ${rows.length} 条已收未票线索，需复核 PO Line、GRN Line、未开票数量和已收未票金额；该视图不形成会计分录。` : '当前没有识别到已收未票线索。',
      severity: rows.length ? 'warning' : 'success',
      confidence: 'medium',
    },
    keyEvidence: evidence,
    businessImpact: [
      impact('采购与财务协同', '已收未票', rows.length ? 'warning' : 'success', '收货已发生但 Invoice Line 未完整读取时，需要先做协同可见性复核，不形成会计分录。', rows.slice(0, 3).map((row) => row.po.id)),
      impact('数据质量', 'Invoice Line 缺口', rows.some((row) => !row.invoices.length) ? 'warning' : 'info', '缺少发票行会影响应付确认和三单匹配判断。'),
    ],
    recommendedActions: [
      action('查看 PO Line', '打开采购订单，确认已收数量、未开票数量和单价。', 'high', evidence[0]?.linkTarget),
      action('查看 GRN Line', '打开收货记录，对照收货数量和质检状态。', 'high', { moduleId: 'procurement:receiving', entityType: 'receiving_doc', entityId: rows[0]?.grn?.grn || rows[0]?.grn?.id }),
      action('查看发票协同', '复核 Invoice Line 是否已导入或仍待补齐。', 'medium', { moduleId: 'procurement:invoices' }),
    ],
    navigationLinks: [
      ...evidence.slice(0, 4).map((item) => navFromEvidence(item)),
      navLink('查看收货记录', 'procurement:receiving', 'receiving_doc', rows[0]?.grn?.grn || rows[0]?.grn?.id || ''),
      navLink('查看发票协同', 'procurement:invoices'),
    ],
    dataLimitations: [
      limitation('不形成会计分录', '已收未票仅展示采购和财务协同可见性，不形成会计分录。', 'warning', '后续仍需人工确认发票、税额和凭证口径。'),
      limitation('Invoice Line 完整性', supplierInvoicesFor(db).length ? '当前读取到部分 Invoice Line，但仍需复核是否覆盖全部 GRN。' : '当前未读取到完整 Invoice Line。', 'warning', '未开票数量和金额是基于 PO / GRN 的协同估算。', supplierInvoicesFor(db).length ? [] : ['Invoice Line']),
    ],
    reviewCards: [
      reviewCard('生成内部复核备注草稿', '整理已收未票 PO Line、GRN Line 和金额估算，供采购/财务复核。', evidence[0]?.linkTarget || {}, { draftType: 'po_followup_draft', originEvidence: originEvidence(evidence), payload: { poId: rows[0]?.po?.id || '', message: '请复核已收未票线索。' } }),
    ],
    followUpQuestions: ['为什么三单匹配失败？', '哪些数据依据不完整？'],
  })
}

function buildThreeWayMatchContract(query, db, models) {
  const rows = matchRows(db, models).slice(0, 5)
  const evidence = rows.flatMap((row) => [
    row.match.poId ? evidenceFromDocument(documentById(models, row.match.poId) || { documentType: 'po', id: row.match.poId, status: row.match.status }, { summary: `PO Line ${row.poLine.poLineId} · PO 数量 ${row.poLine.orderedQty.toLocaleString()} · PO 单价 ${row.poLine.unitPrice ? money(row.poLine.unitPrice, row.poLine.currency) : '待补齐'}。`, severity: 'warning' }) : null,
    row.match.grnId ? evidenceFromDocument(documentById(models, row.match.grnId) || { documentType: 'grn', id: row.match.grnId, status: row.match.status }, { summary: `GRN / Receipt Line ${row.grnLine.grnLineId} · 收货数量 ${row.grnLine.receivedQty.toLocaleString()} · 拒收数量 ${row.grnLine.rejectedQty.toLocaleString()}。`, severity: row.grnLine.rejectedQty ? 'risk' : 'warning' }) : null,
    row.match.invoiceId ? evidenceFromDocument(documentById(models, row.match.invoiceId) || { documentType: 'invoice', id: row.match.invoiceId, status: row.match.status }, { summary: `Invoice Line ${row.invoiceLine.invoiceLineId} · Invoice 金额 ${money(row.invoiceLine.amount || row.match.invoiceAmount || 0, row.match.currency)} · 金额差异 ${money(row.match.varianceAmount, row.match.currency)}。`, severity: toNumber(row.match.varianceAmount, 0) ? 'risk' : 'warning' }) : evidenceItem({ type: 'invoice', id: `invoice-missing-${row.match.poId}`, entityId: '', entityLabel: 'Invoice Line 待补齐', moduleId: 'procurement:invoices', entityType: 'supplier_invoice', status: '待补齐', summary: '当前未读取到完整 Invoice Line，无法完成三单匹配结论。', severity: 'warning' }),
  ].filter(Boolean))
  const first = rows[0]
  const quantityDiff = first ? Math.max(0, toNumber(first.poLine.orderedQty, 0) - toNumber(first.grnLine.acceptedQty || first.grnLine.receivedQty, 0)) : 0
  const priceDiffText = first?.invoiceLine?.unitPrice && first?.poLine?.unitPrice
    ? money(Math.abs(first.invoiceLine.unitPrice - first.poLine.unitPrice), first.match.currency || first.poLine.currency)
    : '待补齐'
  return baseContract({
    query,
    intent: 'three_way_match_failure_v2',
    scope: { module: 'procurement:match' },
    conclusion: {
      title: '三单匹配失败原因',
      summary: rows.length ? `匹配失败主要来自 PO Line、GRN / Receipt Line 与 Invoice Line 的数量差异、单价差异或金额差异；首要差异为数量差异 ${quantityDiff.toLocaleString()}，单价差异 ${priceDiffText}，金额差异 ${money(first?.match?.varianceAmount || 0, first?.match?.currency || 'CNY')}。` : '当前没有读取到三单匹配差异记录。',
      severity: rows.length ? 'risk' : 'info',
      confidence: supplierInvoicesFor(db).length ? 'high' : 'medium',
    },
    keyEvidence: evidence,
    businessImpact: [
      impact('三单匹配', '数量差异 / 单价差异 / 金额差异', rows.length ? 'risk' : 'info', '需要逐行对齐 PO Line、GRN / Receipt Line 和 Invoice Line 后再决定处理方式。', rows.slice(0, 3).map((row) => row.match.invoiceId || row.match.poId)),
      impact('财务协同', '人工复核', rows.length ? 'warning' : 'info', '差异说明只能作为内部复核材料，不触发财务凭证写入。'),
    ],
    recommendedActions: [
      action('查看三单匹配', '打开匹配视图，按 PO Line、GRN Line、Invoice Line 复核数量、单价和金额差异。', 'high', { moduleId: 'procurement:match' }),
      action('生成差异说明草稿', '整理数量差异、单价差异和金额差异，供人工复核。', 'high', evidence[0]?.linkTarget),
      action('人工复核', '由采购、收货和财务共同确认差异原因。', 'high', evidence[0]?.linkTarget),
    ],
    navigationLinks: [
      navLink('查看三单匹配', 'procurement:match'),
      ...evidence.filter((item) => item.entityId).slice(0, 5).map((item) => navFromEvidence(item)),
    ],
    dataLimitations: [
      limitation('Invoice Line 完整性', supplierInvoicesFor(db).length ? '当前读取到 Invoice Line，可继续人工复核差异。' : '当前未读取到完整 Invoice Line。', 'warning', '缺失发票行时，只能定位 PO / GRN 缺口，不能确认最终匹配结论。', supplierInvoicesFor(db).length ? [] : ['Invoice Line']),
    ],
    reviewCards: [
      reviewCard('生成差异说明草稿', '生成数量差异、单价差异、金额差异的内部说明，供人工复核。', evidence[0]?.linkTarget || {}, { draftType: 'po_followup_draft', originEvidence: originEvidence(evidence), payload: { poId: first?.match?.poId || first?.match?.po || '', message: '请复核三单匹配差异。' } }),
    ],
    followUpQuestions: ['哪些已经收货但还没开票？', '哪些数据依据不完整？'],
  })
}

function skuFromMessage(message = '', body = {}) {
  const explicit = text(message).match(/\bSKU-[A-Z0-9-]+\b/i)?.[0]
  if (explicit) return explicit.toUpperCase()
  const candidates = [
    body.activeContext,
    body.sessionGrounding?.activeContext,
    body.sessionGrounding?.lastPrimaryEntity,
    ...(asArray(body.sessionGrounding?.lastVisibleBusinessIds?.sku).map((id) => ({ id, type: 'inventory_item' }))),
  ]
  for (const candidate of candidates) {
    const id = text(candidate?.entityId || candidate?.id)
    if (/^SKU-/i.test(id) || text(candidate?.entityType || candidate?.type) === 'inventory_item') return id.toUpperCase()
  }
  return ''
}

function docsRelatedToSku(db = {}, models = {}, sku = '') {
  const key = compact(sku)
  if (!key) return []
  const rawPoIds = asArray(db.purchaseOrders).filter((po) =>
    compact(po.sourceSku || po.sku || po.itemId).includes(key) ||
    asArray(po.lines).some((line) => compact(line.sku || line.itemId).includes(key))
  ).map((po) => text(po.po || po.poId || po.id))
  return asArray(models.procurementDocuments).filter((doc) =>
    compact(doc.sku || doc.itemId || doc.itemName).includes(key) ||
    rawPoIds.includes(doc.id) ||
    rawPoIds.includes(doc.relatedPo) ||
    rawPoIds.includes(doc.poId) ||
    rawPoIds.includes(doc.sourceRequest) ||
    rawPoIds.includes(doc.linkedPo)
  )
}

function buildSkuRelationshipContract(query, db, models, body) {
  const sku = skuFromMessage(query, body) || inventoryRiskRows(models)[0]?.sku || asArray(models.inventoryItems)[0]?.sku || ''
  const item = asArray(models.inventoryItems).find((row) => compact(row.sku) === compact(sku)) || null
  const docs = uniqueBy(docsRelatedToSku(db, models, sku), (doc) => `${doc.documentType}:${doc.id}`)
  const evidence = [
    ...(item ? [evidenceFromInventory(item)] : []),
    ...docs.map((doc) => evidenceFromDocument(doc, { summary: `${docLabel(doc.documentType, doc.id)} 与 ${sku} 的采购/收货/Invoice 证据相关。` })),
  ]
  return baseContract({
    query,
    intent: 'sku_document_relationship_v2',
    scope: { module: 'inventory', entityType: 'inventory_item', entityId: sku },
    conclusion: {
      title: 'SKU 跨模块证据链',
      summary: sku ? `${sku} 关联的业务单据包括 PR、RFQ、PO、GRN、Invoice 和库存记录；请沿证据链复核采购来源、收货状态和发票可见性。` : '请提供 SKU 编号后继续查询跨模块证据链。',
      severity: evidence.length ? 'warning' : 'info',
      confidence: evidence.length ? 'high' : 'low',
    },
    keyEvidence: evidence,
    businessImpact: [
      impact('库存与采购联动', 'SKU 证据链', evidence.length ? 'warning' : 'info', 'SKU 风险需要结合 PR / RFQ / PO / GRN / Invoice 一起判断。', evidence.map((item) => item.entityId).filter(Boolean).slice(0, 5)),
      impact('数据质量', '链路完整性', docs.some((doc) => doc.documentType === 'invoice') ? 'info' : 'warning', '缺少 Invoice 时，只能确认采购和收货链路，不能完成发票匹配判断。'),
    ],
    recommendedActions: [
      action('查看 SKU', '打开库存页面，复核可用库存、安全库存和在途采购。', 'high', evidence[0]?.linkTarget),
      action('查看相关单据', '沿 PR / RFQ / PO / GRN / Invoice 检查业务链路。', 'high', evidence.find((item) => item.entityId.startsWith('PO-'))?.linkTarget),
      action('查看证据链', '从关键对象跳转后可返回 AI 结果继续复核。', 'medium', evidence[0]?.linkTarget),
    ],
    navigationLinks: evidence.slice(0, 6).map((item) => navFromEvidence(item)),
    dataLimitations: [
      limitation('关联规则', 'SKU 关联基于当前工作区的 SKU、PO Line、GRN Line 和 Invoice Line 字段。', 'warning', '字段缺失时可能漏掉部分单据。', ['PO Line SKU', 'Invoice Line SKU']),
    ],
    reviewCards: [
      reviewCard('生成内部复核备注草稿', '汇总 SKU、PR、RFQ、PO、GRN 和 Invoice 关系，供内部复核。', evidence[0]?.linkTarget || {}, { draftType: 'purchase_request_draft', originEvidence: originEvidence(evidence), payload: { itemIdOrSku: sku, quantity: item ? Math.max(1, toNumber(item.reorderPoint, 1) - toNumber(item.availableQuantity, 0)) : 1, reason: '请复核 SKU 跨模块证据链。' } }),
    ],
    followUpQuestions: ['哪些 PO 还没有收货？', '哪些数据依据不完整？'],
  })
}

function buildInventoryRiskContract(query, _db, models) {
  const rows = inventoryRiskRows(models).slice(0, 6)
  const evidence = rows.map((item) => evidenceFromInventory(item))
  return baseContract({
    query,
    intent: 'inventory_risk_v2',
    scope: { module: 'inventory' },
    conclusion: {
      title: 'SKU 库存风险',
      summary: rows.length ? `当前识别 ${rows.length} 个库存风险 SKU，优先复核可用库存、安全库存、再订货点和关联采购单据。` : '当前没有识别到库存风险 SKU。',
      severity: rows.length ? 'risk' : 'success',
      confidence: 'high',
    },
    keyEvidence: evidence,
    businessImpact: [
      impact('库存覆盖', '低库存或缺货', rows.length ? 'risk' : 'success', '库存风险可能影响客户交付和采购优先级。', rows.map((row) => row.sku).slice(0, 4)),
    ],
    recommendedActions: [
      action('查看 SKU', '打开库存页面，复核库存覆盖和补货阈值。', 'high', evidence[0]?.linkTarget),
      action('生成 PR 草稿预览', '先生成可审阅的补货草稿，再由业务用户确认。', 'medium', evidence[0]?.linkTarget),
    ],
    navigationLinks: evidence.slice(0, 5).map((item) => navFromEvidence(item)),
    dataLimitations: [
      limitation('库存口径', '库存风险基于当前可用库存、安全库存和再订货点，实际需求变化仍需人工确认。', 'warning'),
    ],
    reviewCards: [
      reviewCard('生成 PR 草稿预览', '基于 SKU 风险生成补货草稿预览，需人工复核。', evidence[0]?.linkTarget || {}, { draftType: 'purchase_request_draft', originEvidence: originEvidence(evidence), payload: { itemIdOrSku: rows[0]?.sku || '', quantity: Math.max(1, toNumber(rows[0]?.reorderPoint, 1) - toNumber(rows[0]?.availableQuantity, 0)), reason: '库存风险复核。' } }),
    ],
    followUpQuestions: ['这个 SKU 和哪些单据有关？'],
  })
}

function poIdFromQuestion(message = '', body = {}) {
  const explicit = text(message).match(/\bPO-[A-Z0-9-]+\b/i)?.[0]
  if (explicit) return explicit.toUpperCase()
  const candidates = [
    body.activeContext,
    body.sessionGrounding?.activeContext,
    body.sessionGrounding?.lastPrimaryEntity,
    ...(asArray(body.sessionGrounding?.lastVisibleBusinessIds?.po).map((id) => ({ id, type: 'po' }))),
  ]
  for (const candidate of candidates) {
    const id = text(candidate?.entityId || candidate?.id)
    const type = text(candidate?.entityType || candidate?.type)
    if (/^PO-/i.test(id) || type === 'po' || type === 'purchase_order') return id.toUpperCase()
  }
  return ''
}

function buildPoPriorityContract(query, db, models, body) {
  const explicitPo = text(query).match(/\bPO-[A-Z0-9-]+\b/i)?.[0]
  const activeCandidates = [
    body.activeContext,
    body.sessionGrounding?.activeContext,
    body.sessionGrounding?.lastPrimaryEntity,
  ]
  const hasActivePo = activeCandidates.some((candidate) => {
    const id = text(candidate?.entityId || candidate?.id)
    const type = text(candidate?.entityType || candidate?.type)
    return /^PO-/i.test(id) || type === 'po' || type === 'purchase_order'
  })
  const visiblePoIds = asArray(body.sessionGrounding?.lastVisibleBusinessIds?.po).filter(Boolean)
  if (!explicitPo && !hasActivePo && visiblePoIds.length > 1) return null

  const poId = poIdFromQuestion(query, body)
  const po = documentById(models, poId) || asArray(models.procurementDocuments).find((doc) => doc.documentType === 'po')
  if (!po) return null
  const raw = rawPoById(db, po.id) || {}
  const line = primaryPoLine(raw)
  const grns = rawGrnsForPo(db, po.id)
  const docs = uniqueBy([
    po,
    po.sourceRequest ? documentById(models, po.sourceRequest) : null,
    po.linkedRfq ? documentById(models, po.linkedRfq) : null,
    ...grns.map((grn) => documentById(models, text(grn.grn || grn.id))).filter(Boolean),
  ], (doc) => `${doc.documentType}:${doc.id}`)
  const sku = line.sku ? asArray(models.inventoryItems).find((item) => compact(item.sku) === compact(line.sku)) : inventoryRiskRows(models)[0]
  const evidence = [
    evidenceFromDocument(po, { summary: `${po.id} 当前 ${po.status}，ETA ${po.expectedDate || '待确认'}，PO Line ${line.poLineId} 已收 ${line.receivedQty.toLocaleString()} / 订购 ${line.orderedQty.toLocaleString()}。`, severity: isPastDue(po.expectedDate || po.dueDate) ? 'risk' : 'warning' }),
    ...docs.filter((doc) => doc.id !== po.id).map((doc) => evidenceFromDocument(doc, { summary: `${docLabel(doc.documentType, doc.id)} 是 ${po.id} 的关联证据。` })),
    ...(sku ? [evidenceFromInventory(sku, { summary: `${sku.sku} 库存风险会放大 ${po.id} 的处理优先级。` })] : []),
  ]
  return baseContract({
    query,
    intent: 'po_priority_v2',
    scope: { module: 'procurement:orders', entityType: 'purchase_order', entityId: po.id },
    conclusion: {
      title: `${po.id} 优先级说明`,
      summary: `${po.id} 优先，是因为 ETA ${po.expectedDate || '待确认'}、状态 ${po.status || '待复核'}、PO Line 未收数量 ${Math.max(0, line.orderedQty - line.receivedQty).toLocaleString()}；未到货明细和供应商剩余交期需要人工确认。`,
      severity: isPastDue(po.expectedDate || po.dueDate) ? 'risk' : 'warning',
      confidence: 'high',
    },
    keyEvidence: evidence,
    businessImpact: [
      impact('交付承诺', 'PO 优先处理', 'risk', 'PO 剩余未收数量和 ETA 会影响后续供应承诺。', [po.id]),
      impact('库存风险', '关联 SKU 覆盖', sku ? 'warning' : 'info', sku ? `${sku.sku} 当前存在库存风险，需要和 PO 剩余交期一起判断。` : '当前没有读取到明确 SKU 风险。'),
    ],
    recommendedActions: [
      action('查看 PO', '打开 PO 明细，复核 PO Line、GRN 和未收数量。', 'high', evidence[0]?.linkTarget),
      action('查看收货记录', '确认 GRN / Receipt Line 是否存在异常。', 'high', { moduleId: 'procurement:receiving', entityType: 'receiving_doc', entityId: grns[0]?.grn || grns[0]?.id }),
      action('生成供应商跟进草稿预览', '先形成内部可审阅草稿，再由业务用户确认。', 'medium', evidence[0]?.linkTarget),
    ],
    navigationLinks: evidence.slice(0, 6).map((item) => navFromEvidence(item)),
    dataLimitations: [
      limitation('供应商 ETA', 'ETA 来自当前工作区字段，仍需供应商确认。', 'warning', '优先级说明不代表已经完成供应商确认。'),
    ],
    reviewCards: [
      reviewCard('生成供应商跟进草稿预览', '整理 PO 未收数量、ETA 和收货异常，供人工复核。', evidence[0]?.linkTarget || {}, { draftType: 'po_followup_draft', originEvidence: originEvidence(evidence), payload: { poId: po.id, message: `请确认 ${po.id} 剩余未到货部分的预计交期。` } }),
    ],
    followUpQuestions: ['哪些 PO 还没有收货？', '为什么三单匹配失败？'],
  })
}

function buildDataLimitationContract(query, db, models) {
  const invoiceCount = supplierInvoicesFor(db).length
  const rfqCount = asArray(models.procurementDocuments).filter((doc) => doc.documentType === 'rfq').length
  const grnCount = asArray(models.procurementDocuments).filter((doc) => doc.documentType === 'grn').length
  const evidence = [
    evidenceFromDataQuality(`供应商报价/RFQ ${rfqCount} 条、GRN ${grnCount} 条、Invoice ${invoiceCount} 条；需复核字段映射和缺失项。`),
    ...asArray(models.procurementDocuments).filter((doc) => ['rfq', 'grn', 'po'].includes(doc.documentType)).slice(0, 3).map((doc) => evidenceFromDocument(doc, { summary: `${docLabel(doc.documentType, doc.id)} 可作为数据完整性复核入口。` })),
  ]
  return baseContract({
    query,
    intent: 'data_limitations_v2',
    scope: { module: 'imports' },
    conclusion: {
      title: '数据依据不完整项',
      summary: '当前需要重点复核供应商报价、GRN、Invoice、联系人/证书和字段映射/导入质量；这些限制会影响 AI 对风险、已收未票和三单匹配的判断。',
      severity: 'warning',
      confidence: 'high',
    },
    keyEvidence: evidence,
    businessImpact: [
      impact('寻源', '缺失供应商报价', rfqCount ? 'warning' : 'risk', '报价回复不完整会影响比价和授标建议。'),
      impact('收货', '缺失 GRN', grnCount ? 'warning' : 'risk', 'GRN 不完整会影响未收货、已收未票和三单匹配判断。'),
      impact('发票', '缺失 Invoice', invoiceCount ? 'warning' : 'risk', 'Invoice Line 不完整会影响金额差异和应付协同可见性。'),
      impact('主数据', '联系人/证书待复核', 'warning', '供应商联系人、证书和关键资料需要人工确认。'),
    ],
    recommendedActions: [
      action('打开数据接入与质量', '复核导入任务、字段映射、缺失项和质量检查。', 'high', { moduleId: 'imports' }),
      action('查看相关采购单据', '沿 PO / GRN / Invoice 证据确认缺失影响。', 'medium', evidence.find((item) => item.entityId.startsWith('PO-') || item.entityId.startsWith('GRN-'))?.linkTarget),
    ],
    navigationLinks: [
      navLink('打开数据接入与质量', 'imports'),
      ...evidence.filter((item) => item.entityId).slice(1, 4).map((item) => navFromEvidence(item)),
    ],
    dataLimitations: [
      limitation('缺失供应商报价', '部分 RFQ 可能缺少完整供应商回复或授标依据。', 'warning', '授标建议需要人工复核。', ['供应商报价']),
      limitation('缺失 GRN', '收货记录不完整会影响未收货和已收未票判断。', 'warning', '需要确认是否存在未导入收货单。', ['GRN']),
      limitation('缺失 Invoice', invoiceCount ? '已读取部分 Invoice，但仍需核对是否覆盖全部收货。' : '当前未读取到完整 Invoice。', 'warning', '不完整时不能形成最终三单匹配结论。', invoiceCount ? [] : ['Invoice']),
      limitation('字段映射/导入质量', '导入字段、联系人、证书、税务资料和付款资料可能需要业务复核。', 'warning', 'AI 只提示缺口，不更新业务资料。', ['字段映射', '联系人', '证书']),
    ],
    reviewCards: [
      reviewCard('标记需人工复核预览', '把缺失报价、GRN、Invoice 和字段映射问题整理成内部复核清单。', { moduleId: 'imports' }, { originEvidence: originEvidence(evidence) }),
    ],
    followUpQuestions: ['哪些 PO 还没有收货？', '哪些已经收货但还没开票？'],
  })
}

function buildRfqRiskContract(query, db, models) {
  const rfqs = asArray(models.procurementDocuments).filter((doc) => doc.documentType === 'rfq' && !isTerminalStatus(doc.status)).slice(0, 5)
  const evidence = rfqs.map((rfq) => evidenceFromDocument(rfq, { summary: `${rfq.id} 已邀请 ${toNumber(rfq.supplierCount, 0)} 家，已回复 ${toNumber(rfq.respondedSupplierCount, 0)} 家，待回复 ${toNumber(rfq.pendingSupplierCount, 0)} 家。`, severity: rfq.pendingSupplierCount ? 'warning' : 'info' }))
  return baseContract({
    query,
    intent: 'rfq_award_risk_v2',
    scope: { module: 'procurement:rfq' },
    conclusion: {
      title: 'RFQ 回复与授标风险',
      summary: rfqs.length ? `当前有 ${rfqs.length} 个 RFQ 需要复核供应商回复、报价比较和授标依据。` : '当前没有识别到开放 RFQ 风险。',
      severity: rfqs.some((rfq) => rfq.pendingSupplierCount) ? 'warning' : 'info',
      confidence: 'high',
    },
    keyEvidence: evidence,
    businessImpact: [
      impact('寻源', '回复完整性', rfqs.some((rfq) => rfq.pendingSupplierCount) ? 'warning' : 'info', '供应商回复不完整会影响报价比较和授标建议。'),
    ],
    recommendedActions: [
      action('查看 RFQ', '打开 RFQ，确认待回复供应商和授标依据。', 'high', evidence[0]?.linkTarget),
      action('生成 RFQ 草稿预览', '仅生成内部可审阅草稿，不发出邀请。', 'medium', evidence[0]?.linkTarget),
    ],
    navigationLinks: evidence.slice(0, 5).map((item) => navFromEvidence(item)),
    dataLimitations: [
      limitation('供应商回复完整性', '报价回复、替代料、交期和付款条款仍需人工确认。', 'warning'),
    ],
    reviewCards: [
      reviewCard('生成 RFQ 草稿预览', '整理物料、数量、候选供应商和回复截止日期，供内部复核。', evidence[0]?.linkTarget || {}, { draftType: 'rfq_draft', originEvidence: originEvidence(evidence), payload: { itemIdOrSku: rfqs[0]?.sku || rfqs[0]?.itemId || '', quantity: rfqs[0]?.quantity || 1, reason: 'RFQ 风险复核。' } }),
    ],
  })
}

export function detectAiResponseV2Intent(message = '', body = {}) {
  const raw = text(message || normalizeMessage(body))
  if (!raw) return null
  const normalized = compact(raw)
  if (/^(哪些)?数据依据(不完整|不够完整)|^哪些数据依据不完整/.test(normalized) || /^whichdata.*incomplete/i.test(raw)) return 'data_limitations_v2'
  if (/为什么三单匹配失败|为什么.*三单.*失败|three.?way.*match.*fail/i.test(raw)) return 'three_way_match_failure_v2'
  if (/哪些(已经|已)收货但(还)?没开票|哪些(已经|已)收货但(还)?未开票|已收未票|received.*not.*invoiced/i.test(raw)) return 'received_not_invoiced_v2'
  if (/哪些\s*PO\s*(还)?(没有|没|未)收货|unreceived.*po/i.test(raw)) return 'po_unreceived_v2'
  if (/这个\s*PO\s*为什么优先|why.*po.*priority/i.test(raw)) return 'po_priority_v2'
  if (/这个\s*SKU\s*和哪些单据有关|这个\s*SKU\s*和.*关联|sku.*(?:document|relationship|related)/i.test(raw)) return 'sku_document_relationship_v2'
  if (/哪些\s*SKU\s*有库存风险|哪些\s*SKU.*库存风险|inventory.*risk/i.test(raw)) return 'inventory_risk_v2'
  if (/RFQ\s*回复和授标建议有什么风险|报价.*授标建议.*风险|award.*risk/i.test(raw)) return 'rfq_award_risk_v2'
  if (/这个供应商最近有什么问题|supplier.*recent.*issue/i.test(raw)) return 'supplier_recent_issues_v2'
  if (/哪些供应商有潜在风险|供应商.*潜在风险|supplier.*potential.*risk/i.test(raw)) return 'supplier_risk_summary_v2'
  if (/今天有什么需要我处理|what.*today.*handle/i.test(raw)) return 'today_work_queue_v2'
  return null
}

export function buildAiResponseContractV2(db = {}, body = {}, options = {}) {
  const startedAt = Date.now()
  const query = normalizeMessage(body)
  const intent = detectAiResponseV2Intent(query, body)
  if (!intent) return null
  const models = readModels(db, options)
  const contract = intent === 'today_work_queue_v2'
    ? buildTodayContract(query, db, models, options)
    : intent === 'supplier_risk_summary_v2'
      ? buildSupplierRiskContract(query, db, models, false)
      : intent === 'supplier_recent_issues_v2'
        ? buildSupplierRiskContract(query, db, models, true)
        : intent === 'po_priority_v2'
          ? buildPoPriorityContract(query, db, models, body)
          : intent === 'po_unreceived_v2'
            ? buildUnreceivedPoContract(query, db, models, options)
            : intent === 'received_not_invoiced_v2'
              ? buildReceivedNotInvoicedContract(query, db, models)
              : intent === 'three_way_match_failure_v2'
                ? buildThreeWayMatchContract(query, db, models)
                : intent === 'sku_document_relationship_v2'
                  ? buildSkuRelationshipContract(query, db, models, body)
                  : intent === 'inventory_risk_v2'
                    ? buildInventoryRiskContract(query, db, models)
                    : intent === 'rfq_award_risk_v2'
                      ? buildRfqRiskContract(query, db, models)
                      : buildDataLimitationContract(query, db, models)
  return contract ? wrapResponse(contract, startedAt) : null
}
