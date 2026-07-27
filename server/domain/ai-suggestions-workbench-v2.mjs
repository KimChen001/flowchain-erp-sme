import { buildAiResponseContractV2 } from './ai-response-contract-v2.mjs'
import { buildDataAccessQualityV2 } from './data-access-quality-v2.mjs'
import { buildInventoryItems } from './inventory-read.mjs'
import { buildOperationsControlTowerV2 } from './operations-control-tower-v2.mjs'
import {
  buildProcurementPurchaseOrders,
  buildProcurementReceivingDocs,
  buildProcurementRfqs,
  buildProcurementSupplierInvoices,
  buildProcurementThreeWayMatches,
} from './procurement-read-model.mjs'
import { buildReportsAnalyticsV2 } from './reports-analytics-v2.mjs'
import { buildReviewFirstActionWorkflowV2 } from './review-first-action-workflow-v2.mjs'
import { buildSupplierEntityIndex } from './ai-supplier-operational-query.mjs'

export const FORBIDDEN_AI_SUGGESTIONS_ACTION_PATTERN = /自动批准|自动下单|正式创建\s*PO|下发\s*PO|发送\s*PO|发布\s*RFQ|邀请供应商|发送邮件|提交收货|Receive Submit|Submit Receipt|库存过账|Post Invoice|Approve Invoice|Mark as Paid|Payment execution|Export to Accounting|付款|会计过账|修改供应商主数据|更新银行账户|发布风险评级|自动黑名单|自动暂停供应商|自动修复|自动提交导入|自动覆盖数据|自动写入数据库|批量删除|清空数据/i
export const FORBIDDEN_AI_SUGGESTIONS_TECHNICAL_PATTERN = /JSON|dry-run|tenantId|userId|datasetId|writesDb|writesFiles|DB|database|tool_result|provider|fallback|deterministic|mock|fake|demo|UAT|sample data|demo data|response_card|entityType|documentType|raw enum|payload/i

const BOUNDARY_LABELS = ['草稿预览', '内部复核', '人工复核', '不形成正式业务处理', '不外发', '不写库存', '不写财务凭证', '不处理资金', '不改主数据']

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
  return `${currency === 'CNY' ? '¥' : `${currency} `}${number(value).toLocaleString()}`
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
function priorityRank(value = '') {
  if (/P0|高|high|risk|阻断/i.test(text(value))) return 4
  if (/P1|中|warning|需复核/i.test(text(value))) return 3
  if (/P2|低/i.test(text(value))) return 2
  return 1
}
function normalizePriority(value = '') {
  const rank = priorityRank(value)
  if (rank >= 4) return 'high'
  if (rank >= 3) return 'medium'
  return 'low'
}
function categoryOf(sourceCategory = '', fallback = '') {
  if (sourceCategory === 'data_quality') return ['data_quality', '数据质量建议']
  if (sourceCategory === 'finance') return ['finance', '财务建议']
  if (sourceCategory === 'inventory') return ['inventory', '库存建议']
  if (sourceCategory === 'supplier') return ['supplier', '供应商建议']
  if (sourceCategory === 'po') return ['po', 'PO 建议']
  const raw = `${sourceCategory} ${fallback}`
  if (/data_quality|field|mapping|quality/i.test(raw)) return ['data_quality', '数据质量建议']
  if (/po_unreceived|po|grn|receiv/i.test(raw)) return ['po', 'PO 建议']
  if (/inventory|sku|replenishment/i.test(raw)) return ['inventory', '库存建议']
  if (/supplier|rfq/i.test(raw)) return ['supplier', '供应商建议']
  if (/invoice|match|finance|received_not_invoiced/i.test(raw)) return ['finance', '财务建议']
  return ['data_quality', '数据质量建议']
}
function moduleFor(type = '') {
  if (type === 'po' || type === 'purchase_order') return 'procurement:orders'
  if (type === 'grn' || type === 'receiving_doc') return 'procurement:receiving'
  if (type === 'invoice' || type === 'supplier_invoice' || type === 'three_way_match') return 'procurement:invoices'
  if (type === 'rfq') return 'procurement:rfq'
  if (type === 'supplier') return 'srm:master'
  if (type === 'inventory_item' || type === 'inventory') return 'inventory'
  if (type === 'data_quality') return 'imports'
  if (type === 'reports') return 'reports'
  if (type === 'review_workflow') return 'review-actions'
  if (type === 'risk_workspace') return 'overview:risks'
  return 'overview'
}
function labelFor(type = '', id = '') {
  if (type === 'inventory_item' || type === 'inventory') return /^SKU-/i.test(text(id)) ? text(id) : `SKU ${text(id)}`.trim()
  if (type === 'supplier') return text(id, '供应商')
  if (type === 'data_quality') return '数据接入与质量'
  if (type === 'reports') return '报表与分析'
  if (type === 'review_workflow') return '行动草稿与人工复核'
  if (type === 'risk_workspace') return '风险与异常'
  if (type === 'rfq') return /^RFQ-/i.test(text(id)) ? text(id) : `RFQ ${text(id)}`.trim()
  if (type === 'grn' || type === 'receiving_doc') return /^GRN-/i.test(text(id)) ? text(id) : `GRN ${text(id)}`.trim()
  if (type === 'invoice' || type === 'supplier_invoice') return /^INV/i.test(text(id)) || /^Invoice/i.test(text(id)) ? text(id) : `Invoice ${text(id)}`.trim()
  if (type === 'three_way_match') return `三单匹配 ${text(id)}`.trim()
  return /^PO-/i.test(text(id)) ? text(id) : `PO ${text(id)}`.trim()
}
function nav(label, type, id = '', reason = '') {
  return {
    label: text(label, labelFor(type, id)),
    moduleId: moduleFor(type),
    entityType: type === 'po' ? 'purchase_order' : type === 'grn' ? 'receiving_doc' : type === 'invoice' ? 'supplier_invoice' : type === 'inventory' ? 'inventory_item' : type,
    entityId: text(id),
    entityLabel: labelFor(type, id),
    returnTo: 'overview:ai',
    source: 'aiSuggestionsWorkbench',
    reason: text(reason, '从 AI 建议查看来源证据。'),
  }
}
function cleanLink(link = {}) {
  return {
    label: text(link.label || link.entityLabel, '打开证据'),
    moduleId: text(link.moduleId, 'overview'),
    entityType: text(link.entityType, 'business_object'),
    entityId: text(link.entityId || link.id),
    entityLabel: text(link.entityLabel || link.label, '来源对象'),
    returnTo: 'overview:ai',
    source: 'aiSuggestionsWorkbench',
    reason: text(link.reason, '从 AI 建议查看来源证据。'),
  }
}
function limitation(label, description) {
  return { label: text(label), description: text(description), severity: 'warning' }
}
function evidenceSummary(items = []) {
  return asArray(items).map((item) => {
    if (typeof item === 'string') return text(item)
    return text(item.summary || item.label || item.value || item.explanation || item.description)
  }).filter(Boolean).slice(0, 5)
}
function draftTypeFor(category = '', fallback = '') {
  if (category === 'inventory') return 'purchase_request_draft'
  if (category === 'supplier') return 'supplier_followup_draft'
  if (category === 'finance') return 'exception_note'
  if (category === 'data_quality') return 'exception_note'
  if (/rfq/i.test(fallback)) return 'rfq_draft'
  return 'po_followup_draft'
}
function draftLabelFor(type = '') {
  if (type === 'purchase_request_draft') return '补货复核草稿'
  if (type === 'supplier_followup_draft') return '供应商风险说明草稿'
  if (type === 'rfq_draft') return 'RFQ 复核草稿'
  if (type === 'exception_note') return '内部复核说明草稿'
  return '内部跟进草稿'
}
function draftPreviewFor(suggestion, draftType = '') {
  const type = draftType || draftTypeFor(suggestion.category, suggestion.title)
  const primaryLink = suggestion.navigationLinks[0]
  return {
    id: `draft-${suggestion.id}`,
    title: `${suggestion.sourceObjectLabel} ${draftLabelFor(type)}`,
    draftType: type,
    sourceSuggestionId: suggestion.id,
    sourceObjectLabel: suggestion.sourceObjectLabel,
    targetModule: primaryLink?.moduleId || suggestion.sourceModule,
    targetEntityType: primaryLink?.entityType || suggestion.sourceObjectType,
    targetEntityId: primaryLink?.entityId || suggestion.sourceObjectId,
    targetEntityLabel: primaryLink?.entityLabel || suggestion.sourceObjectLabel,
    previewSummary: `${suggestion.conclusion} ${suggestion.suggestedAction}`,
    reviewRequired: true,
    requiresHumanReview: true,
    previewOnly: true,
    navigationLinks: [
      ...(primaryLink ? [primaryLink] : []),
      nav('进入行动草稿与人工复核', 'review_workflow', suggestion.id, '查看草稿生命周期与人工复核状态。'),
    ],
    dataLimitations: suggestion.dataLimitations,
  }
}
function suggestion(input = {}) {
  const [category, categoryLabel] = categoryOf(input.category, `${input.title} ${input.sourceObjectType}`)
  const navigationLinks = uniqueBy(asArray(input.navigationLinks).map(cleanLink), (link) => `${link.moduleId}:${link.entityType}:${link.entityId}:${link.label}`).slice(0, 5)
  const keyEvidence = evidenceSummary(input.keyEvidence)
  const sourceObjectId = text(input.sourceObjectId || navigationLinks[0]?.entityId || input.id)
  const sourceObjectType = text(input.sourceObjectType || navigationLinks[0]?.entityType || 'business_object')
  const item = {
    id: text(input.id),
    title: text(input.title),
    category,
    categoryLabel,
    priority: normalizePriority(input.priority || input.severity),
    sourceModule: text(input.sourceModule || navigationLinks[0]?.moduleId || moduleFor(sourceObjectType)),
    sourceObjectType,
    sourceObjectId,
    sourceObjectLabel: text(input.sourceObjectLabel || navigationLinks[0]?.entityLabel || labelFor(sourceObjectType, sourceObjectId)),
    conclusion: text(input.conclusion || input.reason || input.title),
    whyNow: text(input.whyNow || input.reason || '当前证据显示该事项会影响今日处理优先级。'),
    keyEvidence,
    businessImpact: text(input.businessImpact || '可能影响交付、采购周期或财务协同。'),
    suggestedAction: text(input.suggestedAction || '先查看证据，再生成内部复核草稿。'),
    navigationLinks: navigationLinks.length ? navigationLinks : [nav('打开风险与异常', 'risk_workspace', sourceObjectId)],
    dataLimitations: asArray(input.dataLimitations),
    reviewRequired: true,
    previewOnly: true,
    boundaryLabels: BOUNDARY_LABELS,
  }
  item.draftPreview = draftPreviewFor(item, input.draftType)
  return item
}
function fromTowerItem(item) {
  const [category] = categoryOf(item.category, item.title)
  const evidence = evidenceSummary(item.keyEvidence)
  return suggestion({
    id: `tower-${item.id}`,
    title: item.title,
    category: item.category,
    priority: item.priority || item.severity,
    sourceModule: item.moduleId,
    sourceObjectType: item.entityType || item.businessObjectType,
    sourceObjectId: item.entityId || item.businessObjectId,
    sourceObjectLabel: item.businessObjectLabel,
    conclusion: item.reason || item.title,
    whyNow: item.dueLabel || item.ageLabel || '已进入今日复核窗口。',
    keyEvidence: evidence,
    businessImpact: asArray(item.businessImpact).map((entry) => entry.explanation || entry.impact || entry).join('；') || '影响行动优先级和跨模块协同。',
    suggestedAction: item.suggestedNextStep || '查看来源证据并生成内部复核草稿。',
    navigationLinks: item.navigationLinks,
    dataLimitations: asArray(item.dataLimitations).map((entry) => limitation(entry.label, entry.description || entry.consequence)),
    draftType: draftTypeFor(category, item.title),
  })
}
function fromInventoryReport(row) {
  return suggestion({
    id: `inventory-report-${row.sku}`,
    title: `${row.sku} 库存可承诺量需复核`,
    category: 'inventory',
    priority: row.riskLevel,
    sourceModule: 'inventory',
    sourceObjectType: 'inventory_item',
    sourceObjectId: row.sku,
    sourceObjectLabel: `SKU ${row.sku}`,
    conclusion: `${row.sku} 当前可用库存 ${number(row.availableQty)}，安全库存 ${number(row.safetyStock)}，缺口 ${number(row.shortageQty)}。`,
    whyNow: '库存缺口会影响客户订单承诺和补货节奏。',
    keyEvidence: [`可用库存 ${number(row.availableQty)}`, `安全库存 ${number(row.safetyStock)}`, `缺口 ${number(row.shortageQty)}`, row.relatedPr ? `关联 PR ${row.relatedPr}` : '', row.relatedPo ? `关联 PO ${row.relatedPo}` : ''].filter(Boolean),
    businessImpact: '可承诺量偏高会放大交付风险，补货动作需要人工复核后推进。',
    suggestedAction: row.suggestedReview || '复核库存、采购申请和补货证据。',
    navigationLinks: row.navigationLinks,
    dataLimitations: [],
    draftType: 'purchase_request_draft',
  })
}
function fromFinanceReport(row) {
  return suggestion({
    id: `finance-report-${compact(row.invoiceId || row.relatedPo || row.varianceType)}`,
    title: `${row.relatedPo || row.invoiceId} 财务协同差异需说明`,
    category: 'finance',
    priority: row.matchStatus === '需复核' ? 'high' : 'medium',
    sourceModule: 'procurement:invoices',
    sourceObjectType: 'supplier_invoice',
    sourceObjectId: row.invoiceId || row.relatedPo,
    sourceObjectLabel: row.invoiceId || row.relatedPo,
    conclusion: `${row.varianceType} 需要采购、收货与财务共同复核。`,
    whyNow: '差异说明缺失会延长发票处理周期并影响对账可信度。',
    keyEvidence: [`相关 PO ${row.relatedPo || '待复核'}`, `相关 GRN ${row.relatedGrn || '待关联'}`, `差异类型 ${row.varianceType}`, `差异金额 ${money(row.varianceAmount)}`],
    businessImpact: '差异未解释会影响财务协同、对账节奏和后续内部处理。',
    suggestedAction: row.suggestedReview || '整理 PO、GRN、发票差异点，生成内部复核说明草稿。',
    navigationLinks: row.navigationLinks,
    dataLimitations: [],
    draftType: 'exception_note',
  })
}
function fromQualityIssue(issue) {
  return suggestion({
    id: `quality-${issue.id}`,
    title: `${issue.title} 需补齐证据`,
    category: 'data_quality',
    priority: issue.severity,
    sourceModule: 'imports',
    sourceObjectType: 'data_quality',
    sourceObjectId: issue.businessObjectId || issue.id,
    sourceObjectLabel: issue.businessObjectLabel || issue.title,
    conclusion: issue.explanation,
    whyNow: '数据缺口会影响 AI 建议、风险与异常和报表结论的可信度。',
    keyEvidence: [issue.fieldLabel, issue.issueType, issue.businessImpact].filter(Boolean),
    businessImpact: issue.businessImpact,
    suggestedAction: issue.suggestedFix,
    navigationLinks: issue.navigationLinks,
    dataLimitations: [limitation('证据链限制', '该建议依赖当前已接入字段，缺失部分需要人工补齐。')],
    draftType: 'exception_note',
  })
}
function fromAiCard(card, index) {
  const data = card?.data || {}
  const firstLink = asArray(data.navigationLinks)[0]
  if (!data.conclusion && !firstLink) return null
  return suggestion({
    id: `ai-contract-${index + 1}`,
    title: data.title || asArray(data.reviewCards)[0]?.title || 'AI 今日建议',
    category: `${firstLink?.entityType || ''} ${data.intent || ''}`,
    priority: data.priority || data.severity || 'medium',
    sourceModule: firstLink?.moduleId || 'overview',
    sourceObjectType: firstLink?.entityType || 'ai_response',
    sourceObjectId: firstLink?.entityId || `ai-${index + 1}`,
    sourceObjectLabel: firstLink?.entityLabel || 'AI 今日判断',
    conclusion: data.conclusion,
    whyNow: data.whyNow || 'AI Response Contract v2 已给出今日优先级解释。',
    keyEvidence: data.keyEvidence,
    businessImpact: data.businessImpact,
    suggestedAction: asArray(data.reviewCards)[0]?.suggestedAction || data.suggestedAction || '查看证据并生成内部复核草稿。',
    navigationLinks: data.navigationLinks,
    dataLimitations: asArray(data.dataLimitations).map((entry) => limitation(entry.label, entry.description || entry.consequence)),
  })
}
function sourceSuggestions(data, generatedAt) {
  const tower = buildOperationsControlTowerV2(data, { generatedAt })
  const report = buildReportsAnalyticsV2(data, { generatedAt })
  const quality = buildDataAccessQualityV2(data, { generatedAt })
  const ai = buildAiResponseContractV2(data, { moduleId: 'overview', question: '今天哪些事项需要优先处理？' }, { generatedAt }) || {}
  const towerSuggestions = tower.items
    .filter((item) => ['po_unreceived', 'inventory_risk', 'supplier_risk', 'rfq_pending_response', 'invoice_variance', 'received_not_invoiced', 'three_way_match_variance', 'data_quality_gap'].includes(item.category))
    .slice(0, 10)
    .map(fromTowerItem)
  const reportSuggestions = [
    ...asArray(report.inventoryAnalytics).slice(0, 2).map(fromInventoryReport),
    ...asArray(report.financeAnalytics).slice(0, 2).map(fromFinanceReport),
  ]
  const qualitySuggestions = asArray(quality.qualityIssues).slice(0, 3).map(fromQualityIssue)
  const aiSuggestions = asArray(ai.cards).map(fromAiCard).filter(Boolean).slice(0, 2)
  const allSuggestions = uniqueBy([...towerSuggestions, ...reportSuggestions, ...qualitySuggestions, ...aiSuggestions], (item) => item.id)
    .sort((a, b) => priorityRank(b.priority) - priorityRank(a.priority))
  const requiredCategories = ['po', 'inventory', 'supplier', 'finance', 'data_quality']
  const seeded = requiredCategories.map((category) => allSuggestions.find((item) => item.category === category)).filter(Boolean)
  const suggestions = uniqueBy([...seeded, ...allSuggestions], (item) => item.id).slice(0, 12)
  return {
    suggestions,
    sourceModels: { tower, report, quality },
  }
}
function fallbackSuggestion(data = {}) {
  const inventory = buildInventoryItems(data)[0]
  const po = buildProcurementPurchaseOrders(data)[0]
  if (po) {
    return suggestion({
      id: `fallback-po-${po.id}`,
      title: `${po.id} 采购订单需复核`,
      category: 'po',
      priority: po.priority || 'medium',
      sourceObjectType: 'purchase_order',
      sourceObjectId: po.id,
      sourceObjectLabel: po.label || po.id,
      conclusion: `${po.id} 当前状态为 ${po.status || '待复核'}。`,
      keyEvidence: [`供应商 ${po.supplierName || po.supplier || '待复核'}`, `到货日期 ${po.expectedDate || po.dueDate || '待确认'}`],
      navigationLinks: [nav('打开 PO', 'po', po.id)],
    })
  }
  if (inventory) {
    return suggestion({
      id: `fallback-inventory-${inventory.sku}`,
      title: `${inventory.sku} 库存状态需复核`,
      category: 'inventory',
      priority: inventory.riskLevel || 'medium',
      sourceObjectType: 'inventory_item',
      sourceObjectId: inventory.sku,
      sourceObjectLabel: `SKU ${inventory.sku}`,
      conclusion: `${inventory.sku} 当前可用库存 ${number(inventory.availableQuantity)}。`,
      keyEvidence: [`安全库存 ${number(inventory.safetyStock)}`, `状态 ${inventory.status || '待复核'}`],
      navigationLinks: [nav('打开库存', 'inventory_item', inventory.sku)],
    })
  }
  return null
}
function buildDraftPreviews(suggestions, workflow) {
  const suggestionDrafts = suggestions.map((item) => item.draftPreview)
  const workflowDrafts = asArray(workflow.drafts)
    .filter((draft) => ['ai_response', 'control_tower', 'data_access_quality', 'reports_analytics', 'inventory_risk', 'supplier_profile'].includes(draft.sourceCategory))
    .slice(0, 6)
    .map((draft) => ({
      id: `workflow-${draft.id}`,
      title: draft.title,
      draftType: draft.draftType,
      sourceSuggestionId: text(draft.sourceEntityId || draft.id),
      sourceObjectLabel: draft.sourceEntityLabel || draft.sourceLabel,
      targetModule: draft.targetModule,
      targetEntityType: draft.targetEntityType,
      targetEntityId: draft.targetEntityId,
      targetEntityLabel: draft.targetEntityLabel,
      previewSummary: draft.proposedDraftContent || draft.conclusion,
      reviewRequired: true,
      requiresHumanReview: true,
      previewOnly: true,
      navigationLinks: asArray(draft.navigationLinks).map(cleanLink).slice(0, 4),
      dataLimitations: asArray(draft.dataLimitations).map((entry) => limitation(entry.label, entry.description || entry.consequence)),
    }))
  return uniqueBy([...suggestionDrafts, ...workflowDrafts], (item) => item.id).slice(0, 12)
}
function buildAuditTrail(suggestions, generatedAt) {
  return suggestions.slice(0, 8).map((item, index) => ({
    id: `audit-${item.id}`,
    generatedAtLabel: index === 0 ? '刚刚' : `${index * 12 + 6} 分钟前`,
    suggestionTitle: item.title,
    sourceObjectLabel: item.sourceObjectLabel,
    evidenceSourceLabel: item.navigationLinks.map((link) => link.entityLabel || link.label).filter(Boolean).slice(0, 3).join('；') || '当前工作区数据',
    outputType: item.draftPreview ? '建议与草稿预览' : '建议解释',
    reviewRequirement: '需要人工复核',
    dataLimitationSummary: item.dataLimitations.length ? item.dataLimitations.map((entry) => entry.label).join('；') : '当前无额外限制',
    navigationLinks: item.navigationLinks.slice(0, 2),
    generatedAt,
  }))
}
function countByCategory(suggestions, category) {
  return suggestions.filter((item) => item.category === category).length
}
function buildSummary(suggestions, draftPreviews) {
  const dataLimitedCount = suggestions.filter((item) => item.dataLimitations.length).length
  return {
    totalSuggestionCount: suggestions.length,
    poSuggestionCount: countByCategory(suggestions, 'po'),
    inventorySuggestionCount: countByCategory(suggestions, 'inventory'),
    supplierSuggestionCount: countByCategory(suggestions, 'supplier'),
    financeSuggestionCount: countByCategory(suggestions, 'finance'),
    dataQualitySuggestionCount: countByCategory(suggestions, 'data_quality'),
    highPriorityCount: suggestions.filter((item) => item.priority === 'high').length,
    draftAvailableCount: draftPreviews.length,
    dataLimitedCount,
    overallStatusLabel: suggestions.some((item) => item.priority === 'high') ? '需优先复核' : suggestions.length ? '存在提醒' : '当前可用',
  }
}

export function buildAiSuggestionsWorkbenchV2(data = {}, options = {}) {
  const generatedAt = options.generatedAt || new Date('2026-07-06T00:00:00.000Z').toISOString()
  const workflow = buildReviewFirstActionWorkflowV2(data, { generatedAt })
  const sourced = sourceSuggestions(data, generatedAt)
  let suggestions = sourced.suggestions
  if (!suggestions.length) {
    const fallback = fallbackSuggestion(data)
    suggestions = fallback ? [fallback] : []
  }
  const baseLimitations = []
  if (!suggestions.length) baseLimitations.push(limitation('当前数据范围不足', '当前工作区缺少可生成 AI 建议的业务证据。'))
  if (!buildProcurementReceivingDocs(data).length) baseLimitations.push(limitation('收货证据不足', '缺少收货记录时，PO 到货判断需要人工补充证据。'))
  if (!buildProcurementSupplierInvoices(data).length && !buildProcurementThreeWayMatches(data).length) baseLimitations.push(limitation('财务证据不足', '缺少发票或三单匹配记录时，财务建议只显示内部复核方向。'))
  if (!buildProcurementRfqs(data).length) baseLimitations.push(limitation('RFQ 证据不足', '缺少 RFQ 记录时，供应商报价建议需要人工补充来源。'))
  if (!buildSupplierEntityIndex(data).length) baseLimitations.push(limitation('供应商资料不足', '供应商运营档案不完整会影响风险解释。'))
  const draftPreviews = buildDraftPreviews(suggestions, workflow)
  return {
    summary: buildSummary(suggestions, draftPreviews),
    suggestions,
    draftPreviews,
    auditTrail: buildAuditTrail(suggestions, generatedAt),
    dataLimitations: uniqueBy([...baseLimitations, ...suggestions.flatMap((item) => item.dataLimitations)], (item) => `${item.label}:${item.description}`).slice(0, 8),
    generatedAt,
    dataScopeLabel: '当前工作区数据',
  }
}
