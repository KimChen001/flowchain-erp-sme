import {
  buildProcurementDocuments,
  buildProcurementSupplierInvoices,
  buildProcurementThreeWayMatches,
} from './procurement-read-model.mjs'
import { buildInventoryItems } from './inventory-read.mjs'
import { buildSupplierEntityIndex } from './ai-supplier-operational-query.mjs'
import { buildOperationsControlTowerV2 } from './operations-control-tower-v2.mjs'

export const FORBIDDEN_DATA_ACCESS_ACTION_PATTERN = /自动修复|自动提交导入|自动覆盖数据|自动写入数据库|自动创建正式单据|自动补收货|自动过账库存|自动批准发票|自动付款|自动会计过账|自动修改供应商|自动发送邮件|自动同步外部系统|批量删除|清空数据|Post Invoice|Approve Invoice|Mark as Paid|Payment execution|Export to Accounting/i
export const FORBIDDEN_DATA_ACCESS_TECHNICAL_PATTERN = /JSON|dry-run|tenantId|userId|datasetId|writesDb|writesFiles|tool_result|provider|fallback|deterministic|mock|fake|demo|UAT|sample data|demo data|response_card|entityType|documentType|raw enum/i

function asArray(value) { return Array.isArray(value) ? value : [] }
function text(value, fallback = '') {
  const next = String(value ?? '').trim()
  return next || fallback
}
function number(value, fallback = 0) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
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
function hasValue(value) {
  return text(value) !== '' && value !== null && value !== undefined
}
function severityRank(value = '') {
  if (/critical|high|高|阻断/i.test(text(value))) return 3
  if (/warning|medium|中|需复核|提醒/i.test(text(value))) return 2
  return 1
}
function moduleFor(type = '') {
  if (type === 'pr') return 'procurement:requests'
  if (type === 'rfq') return 'procurement:rfq'
  if (type === 'po') return 'procurement:orders'
  if (type === 'grn') return 'procurement:receiving'
  if (type === 'invoice' || type === 'three_way_match') return 'procurement:invoices'
  if (type === 'supplier') return 'srm:master'
  if (type === 'inventory') return 'inventory'
  if (type === 'operations') return 'overview:risks'
  if (type === 'ai') return 'overview'
  return 'imports'
}
function entityTypeFor(type = '') {
  if (type === 'pr') return 'purchase_request'
  if (type === 'rfq') return 'rfq'
  if (type === 'po') return 'purchase_order'
  if (type === 'grn') return 'receiving_doc'
  if (type === 'invoice' || type === 'three_way_match') return 'supplier_invoice'
  if (type === 'supplier') return 'supplier'
  if (type === 'inventory') return 'inventory_item'
  if (type === 'operations') return 'operations_control_tower'
  if (type === 'ai') return 'ai_question'
  return 'data_quality_issue'
}
function objectLabel(type = '', id = '') {
  if (type === 'pr') return `PR ${id}`.trim()
  if (type === 'rfq') return `RFQ ${id}`.trim()
  if (type === 'po') return `PO ${id}`.trim()
  if (type === 'grn') return `GRN ${id}`.trim()
  if (type === 'invoice') return `发票 ${id}`.trim()
  if (type === 'three_way_match') return `三单匹配 ${id}`.trim()
  if (type === 'supplier') return `供应商 ${id}`.trim()
  if (type === 'inventory') return `SKU ${id}`.trim()
  if (type === 'operations') return '风险与异常'
  if (type === 'ai') return 'AI Response Contract v2'
  return '数据接入与质量'
}
function nav(label, type, id, reason = '') {
  return {
    label,
    moduleId: moduleFor(type),
    entityType: entityTypeFor(type),
    entityId: id || undefined,
    entityLabel: objectLabel(type, id),
    returnTo: 'imports',
    source: 'dataAccessQuality',
    reason,
  }
}
function limitation(label, description, affectedModules = []) {
  return { label, description, severity: 'warning', affectedModules }
}
function reviewAction(label, description, draftType, payload = {}) {
  return {
    label,
    description,
    actionType: 'draft_preview',
    previewOnly: true,
    requiresHumanReview: true,
    draftType,
    payload,
    allowedNextStep: '生成内部复核草稿预览，由业务负责人确认后再处理。',
    prohibitedActions: [
      '不会提交导入',
      '不会覆盖当前业务数据',
      '不会创建正式业务单据',
      '不会写入库存或财务凭证',
      '不会处理资金',
      '不会变更供应商资料',
      '不会外发通知',
    ],
  }
}
function issue(input) {
  return {
    id: input.id,
    title: input.title,
    severity: input.severity || 'warning',
    category: input.category,
    businessObjectType: input.businessObjectType,
    businessObjectId: input.businessObjectId,
    businessObjectLabel: input.businessObjectLabel || objectLabel(input.businessObjectType, input.businessObjectId),
    fieldLabel: input.fieldLabel || '',
    issueType: input.issueType,
    explanation: input.explanation,
    businessImpact: input.businessImpact,
    suggestedFix: input.suggestedFix,
    affectedModule: input.affectedModule,
    affectedControlTowerCategories: input.affectedControlTowerCategories || [],
    navigationLinks: input.navigationLinks || [],
    reviewActions: input.reviewActions || [reviewAction('生成复核清单草稿预览', '把该质量问题整理成内部复核清单。', 'data_quality_fix_preview', { issueId: input.id })],
    blockedActions: [
      '正式数据改写',
      '正式业务单据创建',
      '库存或财务凭证写入',
      '资金处理',
      '供应商资料变更',
      '外部通知发送',
    ],
    dataLimitations: input.dataLimitations || [],
  }
}
function relationshipGap(input) {
  return {
    id: input.id,
    title: input.title,
    severity: input.severity || 'warning',
    fromObject: input.fromObject,
    toObject: input.toObject,
    missingRelationship: input.missingRelationship,
    explanation: input.explanation,
    affectedModule: input.affectedModule,
    affectedAiQuestion: input.affectedAiQuestion,
    suggestedFix: input.suggestedFix,
    navigationLinks: input.navigationLinks || [],
  }
}
function evidenceGap(input) {
  return {
    id: input.id,
    title: input.title,
    severity: input.severity || 'warning',
    evidenceType: input.evidenceType,
    affectedObject: input.affectedObject,
    missingEvidence: input.missingEvidence,
    consequence: input.consequence,
    suggestedNextStep: input.suggestedNextStep,
    navigationLinks: input.navigationLinks || [],
  }
}
function downstreamImpact(input) {
  return {
    id: input.id,
    target: input.target,
    targetType: input.targetType,
    affectedQuestion: input.affectedQuestion,
    affectedModule: input.affectedModule,
    impactSummary: input.impactSummary,
    dataLimitationLabel: input.dataLimitationLabel,
    relatedIssueIds: input.relatedIssueIds || [],
  }
}
function fixPreview(input) {
  return {
    title: input.title,
    description: input.description,
    previewOnly: true,
    requiresHumanReview: true,
    draftType: input.draftType,
    targetObject: input.targetObject,
    allowedNextStep: input.allowedNextStep || '生成草稿预览并交由业务负责人复核。',
    prohibitedActions: [
      '不提交导入',
      '不覆盖数据',
      '不创建正式 PR / PO / Invoice',
      '不补 GRN',
      '不更新库存',
      '不写入财务凭证',
      '不处理资金',
      '不变更供应商资料',
      '不外发通知',
    ],
    payload: input.payload || {},
  }
}

function collectSources({ docs, rfqs, purchaseOrders, receivingDocs, invoices, suppliers, inventoryItems, products }) {
  const configs = [
    ['source-pr', '采购申请数据', 'Procurement / PR', docs.filter((doc) => doc.type === 'purchase_request').length, ['requester', 'requiredDate', 'lines', 'source demand'], ['AI Response Contract v2', '风险与异常', '采购申请详情']],
    ['source-rfq', 'RFQ / 寻源数据', 'RFQ / Sourcing', rfqs.length, ['source PR', 'supplier response', 'quote line'], ['RFQ 比价', 'Award draft', '风险与异常']],
    ['source-po', '采购订单数据', 'PO', purchaseOrders.length, ['source PR', 'source RFQ', 'warehouse', 'ETA'], ['PO 证据链', '未收货优先级', '供应商档案']],
    ['source-grn', '收货 / GRN 数据', 'Receiving / GRN', receivingDocs.length, ['PO Line', 'received qty', 'quality status'], ['三单匹配', '已收未票', '库存风险']],
    ['source-invoice', '发票 / 三单匹配数据', 'Invoice / Three-way Match', invoices.length, ['Invoice Line', 'GRN Line', 'tax amount'], ['三单匹配', '已收未票', 'AI 发票解释']],
    ['source-supplier', '供应商资料', 'Supplier', suppliers.length, ['contact', 'certificate', 'owner'], ['供应商运营档案', '供应商风险', 'AI 供应商问答']],
    ['source-inventory', '库存余额与物料', 'Inventory', inventoryItems.length || products.length, ['warehouse', 'default supplier', 'lead time'], ['库存风险', '补货草稿预览', 'MRP']],
    ['source-master', '基础资料字段映射', 'Master Data', suppliers.length + products.length, ['tax code', 'payment terms', 'default warehouse'], ['Data Access page itself', 'AI 数据限制']],
  ]
  return configs.map(([id, label, businessArea, recordCount, missingObjects, downstreamUsage]) => ({
    id,
    label,
    businessArea,
    status: recordCount > 0 ? '已接入' : '需补齐',
    recordCount,
    lastUpdated: '当前工作区数据',
    coverageLabel: recordCount > 0 ? '可用于业务复核' : '缺少当前业务记录',
    missingObjects,
    downstreamUsage,
  }))
}

function collectFieldMappings() {
  return [
    ['source-pr', '采购申请数据', '申请人', 'requester', '采购申请', '已映射', 0.96, '', '影响 PR 审批责任归属', '申请人', false],
    ['source-pr', '采购申请数据', '需求日期', 'requiredDate', '采购申请', '需复核', 0.72, '存在中文日期和相对日期，需要统一业务口径。', '影响 PR 优先级和到货计划判断', '需求日期', true],
    ['source-rfq', 'RFQ / 寻源数据', '报价回复数', 'respondedSupplierCount', 'RFQ', '已映射', 0.92, '', '影响 RFQ 回复不足判断', '已回复供应商数', false],
    ['source-rfq', 'RFQ / 寻源数据', '供应商回复明细', 'supplierResponse', 'RFQ 报价', '需补齐', 0.48, '部分 RFQ 只有回复数量，没有逐供应商报价明细。', '影响比价完整性和授标草稿依据', '供应商回复明细', true],
    ['source-po', '采购订单数据', 'PO Line 仓库', 'warehouseId', 'PO Line', '需复核', 0.54, '部分 PO Line 缺少收货仓库。', '影响 GRN 和库存可用量证据链', '收货仓库', true],
    ['source-grn', '收货 / GRN 数据', 'GRN Line', 'grnLineId', 'GRN', '已映射', 0.88, '', '影响收货证据和三单匹配', 'GRN 行号', false],
    ['source-invoice', '发票 / 三单匹配数据', 'Invoice Line', 'invoiceLineId', '发票', '需补齐', 0.42, '当前工作区缺少结构化发票行。', '影响已收未票金额和三单匹配判断', '发票行号', true],
    ['source-supplier', '供应商资料', '联系人 / 证书', 'supplierProfileEvidence', '供应商', '需复核', 0.5, '部分供应商缺少联系人、地址或证书证据。', '影响供应商运营档案和风险解释', '联系人与证书状态', true],
    ['source-inventory', '库存余额与物料', '默认仓库', 'defaultWarehouseId', 'SKU', '需复核', 0.56, '部分 SKU 缺少默认仓库。', '影响库存风险和补货建议证据', '默认仓库', true],
    ['source-master', '基础资料字段映射', '税码 / 结算条款', 'commercialTerms', '基础资料', '未映射', 0.35, '部分外部字段尚未确认标准业务字段。', '影响发票税额和供应商协同可见性', '税码 / 结算条款', true],
  ].map(([sourceId, sourceLabel, fieldLabel, canonicalField, businessObject, status, confidence, issue, downstreamImpact, suggestedMapping, reviewRequired]) => ({
    sourceId,
    sourceLabel,
    fieldLabel,
    canonicalField,
    businessObject,
    status,
    confidence,
    issue,
    downstreamImpact,
    suggestedMapping,
    reviewRequired,
  }))
}

function collectQuality({ docs, rfqs, purchaseOrders, receivingDocs, invoices, suppliers, inventoryItems, tower }) {
  const issues = []
  const rfqMissingResponse = rfqs.find((rfq) => number(rfq.quoted ?? rfq.respondedSupplierCount, 0) < number(rfq.suppliers ?? rfq.supplierCount, 0))
  if (rfqMissingResponse) {
    issues.push(issue({
      id: `missing-supplier-response-${rfqMissingResponse.id}`,
      title: '缺失 supplier response 明细',
      severity: 'high',
      category: 'missing_supplier_response',
      businessObjectType: 'rfq',
      businessObjectId: rfqMissingResponse.id,
      fieldLabel: '供应商报价回复',
      issueType: '缺失报价回复',
      explanation: `${rfqMissingResponse.id} 已邀请 ${number(rfqMissingResponse.suppliers, 0)} 家，当前回复 ${number(rfqMissingResponse.quoted, 0)} 家。`,
      businessImpact: 'RFQ 比价完整性不足，会影响授标草稿依据和 AI 对报价风险的解释。',
      suggestedFix: '补齐供应商回复明细或标记未回复原因。',
      affectedModule: 'RFQ / Sourcing',
      affectedControlTowerCategories: ['rfq_pending_response', 'supplier_risk'],
      navigationLinks: [nav('打开 RFQ', 'rfq', rfqMissingResponse.id), nav('打开风险与异常', 'operations', 'data-quality-gap-workspace')],
    }))
  }

  const poMissingGrn = purchaseOrders.find((po) => !receivingDocs.some((grn) => text(grn.po) === text(po.po)))
  if (poMissingGrn) {
    issues.push(issue({
      id: `missing-grn-line-${poMissingGrn.po}`,
      title: '缺失 GRN Line 收货证据',
      severity: 'high',
      category: 'missing_grn_evidence',
      businessObjectType: 'po',
      businessObjectId: poMissingGrn.po,
      fieldLabel: 'GRN Line',
      issueType: '缺失收货行',
      explanation: `${poMissingGrn.po} 当前没有可关联的 GRN Line。`,
      businessImpact: '会影响 PO 收货状态、已收未票判断、三单匹配和风险与异常中的 PO 未收货优先级。',
      suggestedFix: '复核收货记录，确认是否存在未关联 GRN Line。',
      affectedModule: 'PO / GRN / Invoice Evidence',
      affectedControlTowerCategories: ['po_unreceived', 'received_not_invoiced', 'three_way_match_variance'],
      navigationLinks: [nav('打开 PO', 'po', poMissingGrn.po), nav('打开收货页面', 'grn', '')],
    }))
  }

  const invoiceTarget = purchaseOrders.find((po) => receivingDocs.some((grn) => text(grn.po) === text(po.po)))
  if (!invoices.length && invoiceTarget) {
    issues.push(issue({
      id: `missing-invoice-line-${invoiceTarget.po}`,
      title: '缺失 Invoice Line 发票证据',
      severity: 'high',
      category: 'missing_invoice_line',
      businessObjectType: 'po',
      businessObjectId: invoiceTarget.po,
      fieldLabel: 'Invoice Line',
      issueType: '缺失发票行',
      explanation: '当前工作区没有结构化发票行可用于 PO / GRN / Invoice 三方比对。',
      businessImpact: '已收未票金额、发票差异和三单匹配结论只能以限制说明展示。',
      suggestedFix: '补齐发票行、PO Line 和 GRN Line 的关联字段。',
      affectedModule: 'Three-way Match',
      affectedControlTowerCategories: ['received_not_invoiced', 'invoice_variance', 'three_way_match_variance'],
      navigationLinks: [nav('打开发票 / 三单匹配', 'invoice', invoiceTarget.po), nav('打开 PO', 'po', invoiceTarget.po)],
    }))
  }

  const supplierMissingProfile = suppliers.find((supplier) => !hasValue(supplier.contact) || !hasValue(supplier.certificationStatus))
  if (supplierMissingProfile) {
    issues.push(issue({
      id: `missing-supplier-profile-${compact(supplierMissingProfile.name)}`,
      title: '缺失 supplier contact / certificate',
      severity: 'warning',
      category: 'missing_supplier_profile_evidence',
      businessObjectType: 'supplier',
      businessObjectId: supplierMissingProfile.name,
      fieldLabel: '联系人 / 证书',
      issueType: '供应商资料缺口',
      explanation: `${supplierMissingProfile.name} 缺少联系人或证书状态字段。`,
      businessImpact: '供应商运营档案和风险信号解释需要显示资料完整性限制。',
      suggestedFix: '生成供应商资料补齐清单草稿预览，并由供应商管理负责人复核。',
      affectedModule: 'Supplier Operational Profile',
      affectedControlTowerCategories: ['supplier_risk'],
      navigationLinks: [nav('打开 Supplier Operational Profile', 'supplier', supplierMissingProfile.name)],
    }))
  }

  const unmapped = collectFieldMappings().find((row) => row.status === '未映射')
  if (unmapped) {
    issues.push(issue({
      id: 'unmapped-commercial-terms',
      title: '未映射字段影响财务协同可见性',
      severity: 'warning',
      category: 'unmapped_field',
      businessObjectType: 'data_quality',
      businessObjectId: 'field-mapping-commercial-terms',
      fieldLabel: unmapped.fieldLabel,
      issueType: '未映射字段',
      explanation: `${unmapped.fieldLabel} 尚未确认标准业务字段。`,
      businessImpact: '会影响发票税额、结算条款和供应商协同可见性。',
      suggestedFix: '生成字段映射建议草稿预览，人工确认后再进入后续处理。',
      affectedModule: 'Data Access page itself',
      affectedControlTowerCategories: ['data_quality_gap'],
      navigationLinks: [nav('打开字段映射', 'data_quality', 'field-mapping-commercial-terms')],
      reviewActions: [reviewAction('生成字段映射建议草稿预览', '把来源字段、候选标准字段和下游影响整理成待复核草稿。', 'field_mapping_suggestion', { sourceId: unmapped.sourceId, fieldLabel: unmapped.fieldLabel })],
    }))
  }

  const inventoryMissing = inventoryItems.find((item) => !hasValue(item.defaultWarehouseId) || !hasValue(item.supplier))
  if (inventoryMissing) {
    issues.push(issue({
      id: `sku-evidence-gap-${inventoryMissing.sku}`,
      title: 'SKU 缺少库存或采购证据',
      severity: severityRank(inventoryMissing.riskLevel) >= 3 ? 'high' : 'warning',
      category: 'inventory_procurement_evidence_gap',
      businessObjectType: 'inventory',
      businessObjectId: inventoryMissing.sku,
      fieldLabel: '默认仓库 / 默认供应商',
      issueType: '证据缺口',
      explanation: `${inventoryMissing.sku} 有库存风险，但默认仓库或采购证据不完整。`,
      businessImpact: '会影响 Inventory Risk、补货建议和风险与异常中的库存风险解释。',
      suggestedFix: '复核 SKU 的默认仓库、默认供应商和补货证据。',
      affectedModule: 'Inventory Risk',
      affectedControlTowerCategories: ['inventory_risk'],
      navigationLinks: [nav('打开 Inventory', 'inventory', inventoryMissing.sku)],
    }))
  }

  if (tower.items.some((item) => item.category === 'data_quality_gap')) {
    issues.push(issue({
      id: 'control-tower-data-quality-gap-workspace',
      title: '风险与异常数据缺口需对应复核',
      severity: 'warning',
      category: 'data_quality_gap',
      businessObjectType: 'data_quality',
      businessObjectId: 'data-quality-gap-workspace',
      fieldLabel: '证据链完整性',
      issueType: '关系断链',
      explanation: '风险与异常已生成数据缺口事项，Data Access 需展示对应问题来源。',
      businessImpact: '会影响行动优先级解释、AI 数据限制和跨模块证据链可信度。',
      suggestedFix: '按 RFQ、GRN、Invoice、供应商资料和字段映射分组复核。',
      affectedModule: '风险与异常',
      affectedControlTowerCategories: ['data_quality_gap', 'supplier_risk', 'po_unreceived', 'received_not_invoiced', 'invoice_variance', 'three_way_match_variance', 'rfq_pending_response', 'inventory_risk'],
      navigationLinks: [nav('打开风险与异常', 'operations', 'data-quality-gap-workspace')],
    }))
  }

  return uniqueBy(issues, (item) => item.id)
}

function collectRelationshipGaps({ docs, rfqs, purchaseOrders, receivingDocs, invoices, suppliers, inventoryItems }) {
  const prWithoutLink = docs.find((doc) => doc.type === 'purchase_request' && !doc.linkedRfq && !doc.linkedPo)
  const rfqWithoutPr = rfqs.find((rfq) => !hasValue(rfq.sourceRequest))
  const poWithoutGrn = purchaseOrders.find((po) => !receivingDocs.some((grn) => text(grn.po) === text(po.po)))
  const grnWithoutInvoice = receivingDocs.find((grn) => !invoices.some((invoice) => text(invoice.grnId || invoice.grn) === text(grn.grn) || text(invoice.poId || invoice.po) === text(grn.po)))
  const supplierWithoutEvidence = suppliers.find((supplier) => !purchaseOrders.some((po) => text(po.supplier) === text(supplier.name)) && !rfqs.some((rfq) => text(rfq.bestSupplier) === text(supplier.name)))
  const skuWithoutEvidence = inventoryItems.find((item) => !docs.some((doc) => text(doc.sku) === text(item.sku)) && !purchaseOrders.some((po) => text(po.sourceSku) === text(item.sku)))
  return [
    prWithoutLink && relationshipGap({
      id: `gap-pr-rfq-po-${prWithoutLink.id}`,
      title: 'PR 未关联 RFQ / PO',
      severity: 'warning',
      fromObject: objectLabel('pr', prWithoutLink.id),
      toObject: 'RFQ / PO',
      missingRelationship: 'PR → RFQ / PO',
      explanation: '采购申请尚未形成可追踪的 RFQ 或 PO 关系。',
      affectedModule: '采购申请详情',
      affectedAiQuestion: '这个 PR 下一步应该进入 RFQ 还是 PO 草稿？',
      suggestedFix: '复核 PR 状态和后续寻源记录。',
      navigationLinks: [nav('打开 PR', 'pr', prWithoutLink.id)],
    }),
    rfqWithoutPr && relationshipGap({
      id: `gap-rfq-pr-${rfqWithoutPr.id}`,
      title: 'RFQ 未关联 PR',
      severity: 'warning',
      fromObject: objectLabel('rfq', rfqWithoutPr.id),
      toObject: 'PR',
      missingRelationship: 'RFQ → PR',
      explanation: 'RFQ 缺少来源采购申请，无法完整解释寻源来源。',
      affectedModule: 'RFQ / Sourcing',
      affectedAiQuestion: '这个 RFQ 来自哪个需求？',
      suggestedFix: '补齐 RFQ 来源 PR 或注明独立寻源原因。',
      navigationLinks: [nav('打开 RFQ', 'rfq', rfqWithoutPr.id)],
    }),
    poWithoutGrn && relationshipGap({
      id: `gap-po-grn-${poWithoutGrn.po}`,
      title: 'PO 未关联 GRN',
      severity: 'high',
      fromObject: objectLabel('po', poWithoutGrn.po),
      toObject: 'GRN',
      missingRelationship: 'PO → GRN',
      explanation: '采购订单缺少收货行证据。',
      affectedModule: 'PO / GRN / Invoice Evidence',
      affectedAiQuestion: '这个 PO 为什么显示未收货？',
      suggestedFix: '查看 PO 与收货页面，确认是否缺少关联收货记录。',
      navigationLinks: [nav('打开 PO', 'po', poWithoutGrn.po), nav('打开 GRN', 'grn', '')],
    }),
    grnWithoutInvoice && relationshipGap({
      id: `gap-grn-invoice-${grnWithoutInvoice.grn}`,
      title: 'GRN 未关联 Invoice',
      severity: 'high',
      fromObject: objectLabel('grn', grnWithoutInvoice.grn),
      toObject: 'Invoice',
      missingRelationship: 'GRN → Invoice',
      explanation: '收货记录缺少发票行关联。',
      affectedModule: 'Three-way Match',
      affectedAiQuestion: '为什么已收未票或三单匹配不完整？',
      suggestedFix: '复核发票行是否已接入并关联 GRN Line。',
      navigationLinks: [nav('打开 GRN', 'grn', grnWithoutInvoice.grn), nav('打开发票 / 三单匹配', 'invoice', grnWithoutInvoice.po)],
    }),
    supplierWithoutEvidence && relationshipGap({
      id: `gap-supplier-transaction-${compact(supplierWithoutEvidence.name)}`,
      title: 'Supplier 缺少 Transaction Evidence',
      severity: 'warning',
      fromObject: objectLabel('supplier', supplierWithoutEvidence.name),
      toObject: 'Transaction Evidence',
      missingRelationship: 'Supplier → Transaction Evidence',
      explanation: '供应商档案缺少可关联的 RFQ、PO、GRN 或发票证据。',
      affectedModule: 'Supplier Operational Profile',
      affectedAiQuestion: '这个供应商最近有什么业务风险？',
      suggestedFix: '复核供应商编码、名称和交易记录关联。',
      navigationLinks: [nav('打开 Supplier Operational Profile', 'supplier', supplierWithoutEvidence.name)],
    }),
    skuWithoutEvidence && relationshipGap({
      id: `gap-sku-inventory-procurement-${skuWithoutEvidence.sku}`,
      title: 'SKU 缺少 Inventory / Procurement Evidence',
      severity: 'warning',
      fromObject: objectLabel('inventory', skuWithoutEvidence.sku),
      toObject: 'Inventory / Procurement Evidence',
      missingRelationship: 'SKU → Inventory / Procurement Evidence',
      explanation: 'SKU 的库存风险缺少采购申请、PO 或 RFQ 证据补强。',
      affectedModule: 'Inventory Risk',
      affectedAiQuestion: '这个 SKU 的库存风险依据是什么？',
      suggestedFix: '复核 SKU 默认供应商、采购记录和库存余额。',
      navigationLinks: [nav('打开 Inventory', 'inventory', skuWithoutEvidence.sku)],
    }),
  ].filter(Boolean)
}

function collectEvidenceGaps(qualityIssues, relationshipGaps) {
  return [
    evidenceGap({
      id: 'evidence-rfq-supplier-response',
      title: 'RFQ 缺少供应商回复证据',
      severity: 'high',
      evidenceType: '供应商报价回复',
      affectedObject: 'RFQ / Award Recommendation',
      missingEvidence: '供应商回复明细、报价行、交期和 MOQ',
      consequence: '比价和授标草稿只能提示依据不足。',
      suggestedNextStep: '打开 RFQ 并补齐回复明细复核清单。',
      navigationLinks: qualityIssues.find((item) => item.category === 'missing_supplier_response')?.navigationLinks || [nav('打开 RFQ', 'rfq', '')],
    }),
    evidenceGap({
      id: 'evidence-po-grn-line',
      title: 'PO 缺少 GRN Line 证据',
      severity: 'high',
      evidenceType: '收货行',
      affectedObject: 'PO / GRN / Invoice Evidence',
      missingEvidence: 'PO Line 对应的 GRN Line',
      consequence: '未收数量、已收未票和三单匹配判断受限。',
      suggestedNextStep: '打开 PO 或收货页面核对收货行。',
      navigationLinks: relationshipGaps.find((item) => item.missingRelationship === 'PO → GRN')?.navigationLinks || [nav('打开 PO', 'po', '')],
    }),
    evidenceGap({
      id: 'evidence-grn-invoice-line',
      title: 'GRN 缺少 Invoice Line 证据',
      severity: 'high',
      evidenceType: '发票行',
      affectedObject: 'GRN / Three-way Match',
      missingEvidence: 'Invoice Line 与 GRN Line 的关联',
      consequence: '发票差异和三单匹配无法形成完整证据链。',
      suggestedNextStep: '打开发票 / 三单匹配并复核发票行接入。',
      navigationLinks: relationshipGaps.find((item) => item.missingRelationship === 'GRN → Invoice')?.navigationLinks || [nav('打开发票 / 三单匹配', 'invoice', '')],
    }),
    evidenceGap({
      id: 'evidence-supplier-profile',
      title: '供应商档案缺少资料证据',
      severity: 'warning',
      evidenceType: '联系人 / 证书',
      affectedObject: 'Supplier Operational Profile',
      missingEvidence: '联系人、地址、证书或资料负责人',
      consequence: '供应商风险解释需要展示资料完整性限制。',
      suggestedNextStep: '打开供应商运营档案并生成资料补齐清单草稿预览。',
      navigationLinks: qualityIssues.find((item) => item.category === 'missing_supplier_profile_evidence')?.navigationLinks || [nav('打开 Supplier Operational Profile', 'supplier', '')],
    }),
    evidenceGap({
      id: 'evidence-control-tower-data-quality',
      title: '风险与异常数据缺口证据需汇总',
      severity: 'warning',
      evidenceType: '行动优先级依据',
      affectedObject: '风险与异常',
      missingEvidence: 'RFQ、GRN、Invoice、供应商资料和字段映射缺口的统一说明',
      consequence: '异常清单的数据缺口事项需要在 Data Access 找到对应来源。',
      suggestedNextStep: '打开风险与异常核对 data quality gap。',
      navigationLinks: [nav('打开风险与异常', 'operations', 'data-quality-gap-workspace')],
    }),
  ]
}

function collectDownstreamImpacts(issues) {
  const ids = (category) => issues.filter((item) => item.category === category).map((item) => item.id)
  return [
    downstreamImpact({
      id: 'impact-ai-response-contract',
      target: 'AI Response Contract v2',
      targetType: 'AI',
      affectedQuestion: '哪些数据依据不完整？',
      affectedModule: 'AI Response Contract v2',
      impactSummary: 'AI 的 data limitations 需要引用 RFQ 回复、GRN、Invoice、供应商资料和字段映射缺口。',
      dataLimitationLabel: 'AI 数据依据不完整',
      relatedIssueIds: issues.map((item) => item.id).slice(0, 6),
    }),
    downstreamImpact({
      id: 'impact-operations-control-tower',
      target: '风险与异常',
      targetType: '风险工作台',
      affectedQuestion: '哪些异常清单事项受数据缺口影响？',
      affectedModule: '风险与异常',
      impactSummary: 'supplier_risk、po_unreceived、received_not_invoiced、invoice_variance、three_way_match_variance、rfq_pending_response、inventory_risk 均需要显示数据限制。',
      dataLimitationLabel: '风险与异常行动依据限制',
      relatedIssueIds: issues.filter((item) => item.affectedControlTowerCategories?.length).map((item) => item.id),
    }),
    downstreamImpact({
      id: 'impact-supplier-operational-profile',
      target: 'Supplier Operational Profile',
      targetType: 'Business Module',
      affectedQuestion: '供应商最近有什么风险？',
      affectedModule: '供应商管理',
      impactSummary: '联系人、证书和交易证据缺口会影响供应商风险解释。',
      dataLimitationLabel: '供应商档案证据限制',
      relatedIssueIds: ids('missing_supplier_profile_evidence'),
    }),
    downstreamImpact({
      id: 'impact-three-way-match',
      target: 'Three-way Match',
      targetType: 'Business Module',
      affectedQuestion: '为什么三单匹配失败或不完整？',
      affectedModule: '采购 / 财务协同',
      impactSummary: '缺少 GRN Line 或 Invoice Line 时，三方证据链无法完整闭合。',
      dataLimitationLabel: '三单匹配证据限制',
      relatedIssueIds: [...ids('missing_grn_evidence'), ...ids('missing_invoice_line')],
    }),
    downstreamImpact({
      id: 'impact-inventory-risk',
      target: 'Inventory Risk',
      targetType: 'Business Module',
      affectedQuestion: '这个 SKU 为什么是库存风险？',
      affectedModule: '库存管理',
      impactSummary: '默认仓库、默认供应商和采购证据缺失会影响补货建议可信度。',
      dataLimitationLabel: '库存风险证据限制',
      relatedIssueIds: ids('inventory_procurement_evidence_gap'),
    }),
    downstreamImpact({
      id: 'impact-data-access',
      target: 'Data Access page itself',
      targetType: 'Data Quality',
      affectedQuestion: '当前数据范围和限制是什么？',
      affectedModule: '数据接入与质量',
      impactSummary: '质量问题、关系断链和证据缺口会决定本页优先处理顺序。',
      dataLimitationLabel: '当前数据范围限制',
      relatedIssueIds: issues.map((item) => item.id),
    }),
  ]
}

export function buildDataAccessQualityV2(data = {}, options = {}) {
  const generatedAt = options.generatedAt || new Date('2026-07-05T00:00:00.000Z').toISOString()
  const docs = buildProcurementDocuments(data)
  const rfqs = asArray(data.rfqs)
  const purchaseOrders = asArray(data.purchaseOrders)
  const receivingDocs = asArray(data.receivingDocs)
  const invoices = buildProcurementSupplierInvoices(data)
  const matches = buildProcurementThreeWayMatches(data)
  const suppliers = asArray(data.suppliers)
  const inventoryItems = buildInventoryItems(data)
  const products = asArray(data.products)
  const supplierIndex = buildSupplierEntityIndex(data)
  const tower = buildOperationsControlTowerV2(data, { generatedAt, now: options.now, timeZone: options.timeZone })

  const sources = collectSources({ docs, rfqs, purchaseOrders, receivingDocs, invoices, suppliers, inventoryItems, products })
  const fieldMappings = collectFieldMappings()
  const qualityIssues = collectQuality({ docs, rfqs, purchaseOrders, receivingDocs, invoices, suppliers: supplierIndex.length ? supplierIndex : suppliers, inventoryItems, matches, tower })
  const relationshipGaps = collectRelationshipGaps({ docs, rfqs, purchaseOrders, receivingDocs, invoices, suppliers: supplierIndex.length ? supplierIndex : suppliers, inventoryItems })
  const evidenceGaps = collectEvidenceGaps(qualityIssues, relationshipGaps)
  const downstreamImpacts = collectDownstreamImpacts(qualityIssues)
  const recommendedFixes = [
    fixPreview({ title: '生成字段映射建议草稿预览', description: '整理未映射字段、候选标准业务字段和下游影响。', draftType: 'field_mapping_suggestion', targetObject: '字段映射', payload: { issueIds: qualityIssues.filter((item) => item.category === 'unmapped_field').map((item) => item.id) } }),
    fixPreview({ title: '生成数据补齐清单草稿预览', description: '按 RFQ、GRN、Invoice、供应商资料和 SKU 证据缺口生成复核清单。', draftType: 'data_completion_checklist', targetObject: '数据补齐清单', payload: { issueIds: qualityIssues.map((item) => item.id) } }),
    fixPreview({ title: '生成异常行复核备注草稿预览', description: '把关系断链和证据缺口整理成内部复核备注。', draftType: 'exception_note', targetObject: '质量问题', payload: { relationshipGapIds: relationshipGaps.map((item) => item.id), evidenceGapIds: evidenceGaps.map((item) => item.id) } }),
  ]
  const dataLimitations = [
    limitation('Invoice Line 覆盖不足', '当前工作区缺少结构化发票行，已收未票和三单匹配判断需要显示限制。', ['AI Response Contract v2', '风险与异常', 'Three-way Match']),
    limitation('供应商资料证据不足', '部分供应商联系人、证书或交易证据需要人工复核。', ['Supplier Operational Profile', 'supplier_risk']),
    limitation('字段映射待复核', '部分外部字段尚未确认标准业务字段，会影响财务协同和 AI 解释。', ['Data Access page itself', 'AI Response Contract v2']),
  ]

  const criticalIssueCount = qualityIssues.filter((item) => severityRank(item.severity) >= 3).length
  const warningIssueCount = qualityIssues.length - criticalIssueCount
  const unmappedFieldCount = fieldMappings.filter((item) => item.status !== '已映射').length
  const mappedFieldCount = fieldMappings.length - unmappedFieldCount

  return {
    summary: {
      sourceCount: sources.length,
      connectedSourceCount: sources.filter((item) => item.status === '已接入').length,
      mappedFieldCount,
      unmappedFieldCount,
      criticalIssueCount,
      warningIssueCount,
      relationshipGapCount: relationshipGaps.length,
      evidenceGapCount: evidenceGaps.length,
      affectedAiInsightCount: downstreamImpacts.filter((item) => /AI/i.test(item.targetType) || /AI/i.test(item.target)).length,
      affectedControlTowerItemCount: tower.summary?.dataGapCount || tower.items.filter((item) => item.category === 'data_quality_gap' || item.dataLimitations?.length).length,
      overallQualityLabel: criticalIssueCount > 0 ? '需优先复核' : warningIssueCount > 0 ? '存在提醒' : '当前可用',
    },
    sources,
    fieldMappings,
    qualityIssues,
    relationshipGaps,
    evidenceGaps,
    downstreamImpacts,
    recommendedFixes,
    dataLimitations,
    generatedAt,
    dataScopeLabel: '当前工作区数据',
  }
}
