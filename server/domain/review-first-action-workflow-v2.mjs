import { buildAiResponseContractV2 } from './ai-response-contract-v2.mjs'
import { buildDataAccessQualityV2 } from './data-access-quality-v2.mjs'
import { buildInventoryItems } from './inventory-read.mjs'
import { buildOperationsControlTowerV2 } from './operations-control-tower-v2.mjs'
import {
  buildProcurementDocuments,
  buildProcurementPurchaseOrders,
  buildProcurementReceivingDocs,
  buildProcurementRfqs,
  buildProcurementSupplierInvoices,
  buildProcurementThreeWayMatches,
} from './procurement-read-model.mjs'
import { buildReportsAnalyticsV2 } from './reports-analytics-v2.mjs'
import { buildSupplierEntityIndex } from './ai-supplier-operational-query.mjs'

export const FORBIDDEN_REVIEW_WORKFLOW_ACTION_PATTERN = /自动批准|自动下单|正式创建\s*PO|下发\s*PO|发送\s*PO|发布\s*RFQ|邀请供应商|发送邮件|提交收货|Receive Submit|Submit Receipt|库存过账|Post Invoice|Approve Invoice|Mark as Paid|Payment execution|Export to Accounting|付款|会计过账|修改供应商主数据|更新银行账户|发布风险评级|自动黑名单|自动暂停供应商|自动修复|自动提交导入|自动覆盖数据|自动写入数据库|批量删除|清空数据/i
export const FORBIDDEN_REVIEW_WORKFLOW_TECHNICAL_PATTERN = /JSON|dry-run|tenantId|userId|datasetId|writesDb|writesFiles|DB|tool_result|provider|fallback|deterministic|mock|fake|demo|UAT|sample data|demo data|response_card|entityType|documentType|raw enum/i

// A draft's status is a stable code; the page shows it in the interface
// language (src/components/actions/reviewQueueCopy.ts, design audit L6-20).
export const REVIEW_DRAFT_STATUSES = Object.freeze({
  preview: 'draft_preview',
  waiting: 'awaiting_review',
  info: 'needs_information',
  returned: 'returned',
  cancelled: 'cancelled',
  handled: 'handled_manually',
})
const STATUS = REVIEW_DRAFT_STATUSES

const DRAFT_TYPE_LABELS = {
  internal_review_note: '内部复核备注',
  rfq_draft_preview: 'RFQ 草稿预览',
  po_draft_preview: 'PO 草稿预览',
  variance_explanation: '差异说明',
  receiving_exception_note: '收货异常说明',
  supplier_risk_note: '供应商风险说明',
  supplier_communication_draft: '供应商沟通草稿',
  field_mapping_suggestion: '字段映射建议',
  data_completion_checklist: '数据补齐清单',
  report_review_note: '报表复核备注',
  inventory_replenishment_preview: '补货 PR 草稿预览',
  inventory_risk_note: '库存风险复核',
}

const SOURCE_LABELS = {
  ai_response: 'AI Response',
  control_tower: '风险与异常',
  reports_analytics: 'Reports & Analytics',
  data_access_quality: 'Data Access & Quality',
  purchase_request: 'PR / RFQ / PO / GRN / Invoice',
  rfq_sourcing: 'PR / RFQ / PO / GRN / Invoice',
  po_receiving_invoice: 'PR / RFQ / PO / GRN / Invoice',
  supplier_profile: 'Supplier Operational Profile',
  inventory_risk: 'Inventory Risk',
}

const SOURCE_ORDER = [
  'ai_response',
  'control_tower',
  'reports_analytics',
  'data_access_quality',
  'purchase_request',
  'rfq_sourcing',
  'po_receiving_invoice',
  'supplier_profile',
  'inventory_risk',
]

function asArray(value) { return Array.isArray(value) ? value : [] }
function text(value, fallback = '') {
  if (value && typeof value === 'object') {
    const candidate = value.summary || value.label || value.title || value.description || value.suggestedAction || value.allowedNextStep || value.action || value.conclusion || value.businessImpact
    if (candidate && candidate !== value) return text(candidate, fallback)
    if (Array.isArray(value)) return sanitizeText(value.map((item) => text(item)).filter(Boolean).join('；') || fallback)
    return sanitizeText(fallback)
  }
  const raw = String(value ?? '').trim() || fallback
  return sanitizeText(raw)
}
function number(value, fallback = 0) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}
function compact(value = '') {
  return String(value ?? '').trim().toLowerCase().replace(/[^\w\u4e00-\u9fa5-]+/g, '')
}
function sanitizeText(value = '') {
  return String(value ?? '')
    .replace(/自动批准|审批通过|approve|approved/ig, '人工复核确认')
    .replace(/自动下单|正式创建\s*PO|下发\s*PO|发送\s*PO|发布\s*RFQ|邀请供应商|发送邮件|提交收货/ig, '形成正式业务处理')
    .replace(/Receive Submit|Submit Receipt|库存过账|Post Invoice|Approve Invoice|Mark as Paid|Payment execution|Export to Accounting|会计过账|付款/ig, '正式资金或凭证处理')
    .replace(/修改供应商主数据|更新银行账户|发布风险评级|自动黑名单|自动暂停供应商/ig, '供应商资料正式变更')
    .replace(/自动修复|自动提交导入|自动覆盖数据|自动写入数据库|批量删除|清空数据/ig, '覆盖当前工作区数据')
    .replace(/JSON|dry-run|tenantId|userId|datasetId|writesDb|writesFiles|tool_result|provider|fallback|deterministic|mock|fake|demo|UAT|sample data|demo data|response_card|entityType|documentType|raw enum/ig, '当前工作区数据')
    .replace(/\bDB\b/g, '当前工作区数据')
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
function priorityRank(priority = '') {
  if (/P0|高|high|risk/i.test(priority)) return 4
  if (/P1|中|medium|warning/i.test(priority)) return 3
  if (/P2/.test(priority)) return 2
  return 1
}
function moduleForType(type = '') {
  if (type === 'pr' || type === 'purchase_request') return 'procurement:requests'
  if (type === 'rfq') return 'procurement:rfq'
  if (type === 'po' || type === 'purchase_order') return 'procurement:orders'
  if (type === 'grn' || type === 'receiving_doc') return 'procurement:receiving'
  if (type === 'invoice' || type === 'supplier_invoice' || type === 'match') return 'procurement:invoices'
  if (type === 'supplier') return 'srm:master'
  if (type === 'inventory' || type === 'inventory_item') return 'inventory'
  if (type === 'data_quality') return 'imports'
  if (type === 'reports') return 'reports'
  if (type === 'ai') return 'overview'
  return 'overview'
}
function entityTypeFor(type = '') {
  if (type === 'pr') return 'purchase_request'
  if (type === 'po') return 'purchase_order'
  if (type === 'grn') return 'receiving_doc'
  if (type === 'invoice' || type === 'match') return 'supplier_invoice'
  if (type === 'inventory') return 'inventory_item'
  if (type === 'data_quality') return 'data_quality_issue'
  return type || 'business_object'
}
function objectLabel(type = '', id = '') {
  if (type === 'supplier') return text(id, '供应商')
  if (type === 'inventory' || type === 'inventory_item') return `SKU ${text(id)}`.trim()
  if (type === 'data_quality') return '数据接入与质量'
  if (type === 'reports') return 'Reports & Analytics'
  if (type === 'ai') return 'AI Assistant'
  const upper = type === 'po' ? 'PO' : type === 'grn' ? 'GRN' : type === 'pr' ? 'PR' : type === 'rfq' ? 'RFQ' : type === 'invoice' ? 'Invoice' : text(type)
  return `${upper} ${text(id)}`.trim()
}
function nav(label, type, id = '', extra = {}) {
  return {
    label: text(label),
    moduleId: extra.moduleId || moduleForType(type),
    entityType: extra.entityType || entityTypeFor(type),
    entityId: text(id),
    entityLabel: text(extra.entityLabel, objectLabel(type, id)),
    returnTo: 'review-actions',
    source: 'reviewFirstActionWorkflow',
    reason: text(extra.reason, '从行动草稿回看证据。'),
  }
}
function cleanLimitation(item, fallbackLabel = '当前数据范围限制') {
  if (typeof item === 'string') return { label: text(item, fallbackLabel), description: text(item), severity: 'warning' }
  return {
    label: text(item?.label, fallbackLabel),
    description: text(item?.description || item?.consequence || item?.impactSummary, '需要业务负责人结合证据链复核。'),
    severity: text(item?.severity, 'warning'),
    affectedModules: asArray(item?.affectedModules || item?.affectedMetrics || item?.missingData).map((value) => text(value)).filter(Boolean),
  }
}
function normalizeLink(link = {}) {
  const entityType = link.entityType || link.type || 'business_object'
  const moduleId = link.moduleId || moduleForType(entityType)
  return {
    label: text(link.label, link.entityLabel || '打开证据'),
    moduleId,
    entityType: text(entityType),
    entityId: text(link.entityId || link.id),
    entityLabel: text(link.entityLabel, objectLabel(entityType, link.entityId || link.id)),
    returnTo: 'review-actions',
    source: 'reviewFirstActionWorkflow',
    reason: text(link.reason, '查看来源证据。'),
  }
}
function normalizeEvidence(items = [], fallback = '') {
  return asArray(items).map((item) => {
    if (typeof item === 'string') return text(item)
    return text(item.summary || item.label || item.explanation || item.value, fallback)
  }).filter(Boolean).slice(0, 5)
}
function reviewActionsFor(status = STATUS.preview) {
  const transitions = allowedTransitionsFor(status)
  return transitions.map((transition) => ({
    transitionTo: transition.to,
    reasonRequired: transition.reasonRequired,
    previewOnly: true,
    requiresHumanReview: true,
    boundary: '仅更新草稿复核状态，不形成正式业务处理。',
  }))
}
function allowedTransitionsFor(status = STATUS.preview) {
  const rows = {
    [STATUS.preview]: [STATUS.waiting, STATUS.info, STATUS.cancelled],
    [STATUS.waiting]: [STATUS.info, STATUS.returned, STATUS.handled],
    [STATUS.info]: [STATUS.preview],
    [STATUS.returned]: [STATUS.preview],
    [STATUS.cancelled]: [],
    [STATUS.handled]: [],
  }
  return asArray(rows[status]).map((to) => ({
    from: status,
    to,
    reasonRequired: [STATUS.info, STATUS.returned, STATUS.cancelled, STATUS.handled].includes(to),
  }))
}
function lifecyclePolicy() {
  return {
    statuses: [
      { status: STATUS.preview, description: '系统根据证据生成草稿预览，未写入正式业务对象。' },
      { status: STATUS.waiting, description: '用户确认草稿可以进入人工复核，仍不执行正式业务动作。' },
      { status: STATUS.info, description: '复核人要求补充证据或字段，必须填写原因。' },
      { status: STATUS.returned, description: '复核人退回草稿，必须填写原因。' },
      { status: STATUS.cancelled, description: '用户取消草稿，必须填写原因。' },
      { status: STATUS.handled, description: '表示业务人员已线下处理或进入人工流程，必须填写说明。' },
    ],
    allowedTransitions: [
      ...allowedTransitionsFor(STATUS.preview),
      ...allowedTransitionsFor(STATUS.waiting),
      ...allowedTransitionsFor(STATUS.info),
      ...allowedTransitionsFor(STATUS.returned),
    ],
    reasonRequiredTransitions: [STATUS.info, STATUS.returned, STATUS.cancelled, STATUS.handled],
    boundaryLabels: [
      '草稿预览',
      '人工复核',
      '不形成正式业务处理',
      '不外发',
      '不写库存',
      '不写财务凭证',
      '不处理资金',
      '不改主数据',
      '不覆盖当前工作区数据',
    ],
  }
}
function draftTypeFromAction(action = {}, category = '') {
  const raw = String(action.draftType || '').trim()
  if (/field_mapping/.test(raw)) return 'field_mapping_suggestion'
  if (/data_completion/.test(raw)) return 'data_completion_checklist'
  if (/rfq/.test(raw)) return 'rfq_draft_preview'
  if (/purchase_request|replenishment/.test(raw)) return 'inventory_replenishment_preview'
  if (/po/.test(raw) || /purchase_order/.test(raw)) return 'po_draft_preview'
  if (/supplier_followup/.test(raw) || category === 'supplier_risk') return 'supplier_risk_note'
  if (/variance|invoice|match/.test(category)) return 'variance_explanation'
  if (/receiving|grn/.test(category)) return 'receiving_exception_note'
  if (/inventory/.test(category)) return 'inventory_risk_note'
  return 'internal_review_note'
}
function makeDraft(input = {}) {
  const draftType = input.draftType || 'internal_review_note'
  const status = input.status || STATUS.preview
  const id = text(input.id)
  const limitations = asArray(input.dataLimitations).map((item) => cleanLimitation(item))
  return {
    id,
    draftNo: input.draftNo || `RFW-${String(input.index || 1).padStart(4, '0')}`,
    title: text(input.title, DRAFT_TYPE_LABELS[draftType]),
    draftType,
    draftTypeLabel: DRAFT_TYPE_LABELS[draftType] || '内部复核备注',
    sourceModule: input.sourceModule || SOURCE_LABELS[input.sourceCategory] || '当前工作区数据',
    sourceLabel: input.sourceLabel || SOURCE_LABELS[input.sourceCategory] || '当前工作区数据',
    sourceCategory: input.sourceCategory,
    sourceEntityType: input.sourceEntityType || 'business_object',
    sourceEntityId: text(input.sourceEntityId),
    sourceEntityLabel: text(input.sourceEntityLabel, input.title),
    targetModule: input.targetModule || moduleForType(input.targetEntityType),
    targetEntityType: input.targetEntityType || input.sourceEntityType || 'business_object',
    targetEntityId: text(input.targetEntityId || input.sourceEntityId),
    targetEntityLabel: text(input.targetEntityLabel || input.sourceEntityLabel || input.title),
    status,
    priority: text(input.priority, '中'),
    owner: text(input.owner, '业务负责人'),
    createdAtLabel: text(input.createdAtLabel, '今日生成'),
    dueLabel: text(input.dueLabel, '今日复核'),
    conclusion: text(input.conclusion, '该事项建议先形成草稿预览并交由人工复核。'),
    keyEvidence: normalizeEvidence(input.keyEvidence, input.conclusion),
    businessImpact: (asArray(input.businessImpact).map((item) => text(item?.explanation || item?.impact || item)).filter(Boolean).length
      ? asArray(input.businessImpact).map((item) => text(item?.explanation || item?.impact || item)).filter(Boolean).slice(0, 4)
      : ['帮助业务负责人判断下一步复核优先级。']),
    proposedDraftContent: text(input.proposedDraftContent, `${DRAFT_TYPE_LABELS[draftType]}：整理证据、影响、缺失信息和建议下一步，供内部复核。`),
    reviewChecklist: asArray(input.reviewChecklist).map((item) => text(item)).filter(Boolean).slice(0, 6),
    missingInformation: asArray(input.missingInformation).map((item) => text(item)).filter(Boolean).slice(0, 6),
    navigationLinks: uniqueBy(asArray(input.navigationLinks).map(normalizeLink), (link) => `${link.moduleId}:${link.entityType}:${link.entityId}:${link.label}`).slice(0, 8),
    allowedTransitions: allowedTransitionsFor(status),
    reviewActions: reviewActionsFor(status),
    boundaryLabels: lifecyclePolicy().boundaryLabels,
    dataLimitations: limitations,
    auditTrailPreview: [
      text(input.auditTrailPreview, '已生成行动草稿预览；仅记录来源证据、复核状态和人工处理说明。'),
      '状态流转需要保留原因，不改变 PR / RFQ / PO / GRN / Invoice / Supplier / Inventory 正式记录。',
    ],
  }
}
function draftsFromControlTower(tower) {
  return asArray(tower.items).flatMap((item) => asArray(item.reviewActions).map((action) => makeDraft({
    id: `control-${item.id}-${action.draftType || 'review'}`,
    title: action.draftTitle || action.label || item.title,
    draftType: draftTypeFromAction(action, item.category),
    sourceCategory: 'control_tower',
    sourceModule: '风险与异常',
    sourceLabel: '风险与异常',
    sourceEntityType: item.entityType,
    sourceEntityId: item.entityId || item.businessObjectId || item.id,
    sourceEntityLabel: item.businessObjectLabel || item.title,
    targetModule: action.targetModule || item.moduleId,
    targetEntityType: action.targetEntityType || item.entityType,
    targetEntityId: action.targetEntityId || item.entityId || item.businessObjectId,
    targetEntityLabel: item.businessObjectLabel || item.title,
    status: priorityRank(item.priority) >= 4 ? STATUS.waiting : STATUS.preview,
    priority: item.priority,
    owner: item.owner,
    dueLabel: item.dueLabel || item.ageLabel,
    conclusion: item.reason || item.title,
    keyEvidence: item.keyEvidence,
    businessImpact: item.businessImpact,
    proposedDraftContent: `${action.label || item.title}：${action.description || item.suggestedNextStep || item.reason}`,
    reviewChecklist: ['核对来源业务对象', '确认关键证据是否完整', '确认缺失信息后再进入人工处理'],
    missingInformation: asArray(item.dataLimitations).flatMap((limitation) => asArray(limitation.missingData || limitation.affectedModules)).slice(0, 4),
    navigationLinks: item.navigationLinks,
    dataLimitations: item.dataLimitations,
  })))
}
function draftsFromReports(report) {
  return asArray(report.reportInsights).map((insight, index) => makeDraft({
    id: `reports-${index + 1}-${compact(insight.insightType || insight.title)}`,
    title: `${insight.title}复核备注草稿`,
    draftType: /supplier/i.test(insight.insightType || insight.title) ? 'supplier_risk_note' : /invoice|match|finance/i.test(insight.insightType || insight.title) ? 'variance_explanation' : 'report_review_note',
    sourceCategory: 'reports_analytics',
    sourceModule: 'Reports & Analytics',
    sourceLabel: 'Reports & Analytics',
    sourceEntityType: 'report_insight',
    sourceEntityId: insight.insightType || `report-${index + 1}`,
    sourceEntityLabel: insight.title,
    targetModule: asArray(insight.navigationLinks)[0]?.moduleId || 'reports',
    targetEntityType: asArray(insight.navigationLinks)[0]?.entityType || 'report_insight',
    targetEntityId: asArray(insight.navigationLinks)[0]?.entityId || insight.insightType,
    targetEntityLabel: asArray(insight.navigationLinks)[0]?.entityLabel || insight.title,
    status: index === 0 ? STATUS.waiting : STATUS.preview,
    priority: /high|高|risk/i.test(insight.severity) ? '高' : '中',
    owner: '运营分析',
    conclusion: insight.conclusion,
    keyEvidence: insight.keyEvidence,
    businessImpact: [insight.businessImpact],
    proposedDraftContent: insight.suggestedAction || insight.reviewOnlyAction?.label,
    reviewChecklist: ['复核指标口径', '核对关联业务对象', '确认数据限制是否已说明'],
    missingInformation: asArray(insight.dataLimitations).map((item) => item.label),
    navigationLinks: insight.navigationLinks,
    dataLimitations: insight.dataLimitations,
  }))
}
function draftsFromDataAccess(quality) {
  const fixes = asArray(quality.recommendedFixes).map((fix, index) => makeDraft({
    id: `data-access-fix-${index + 1}-${compact(fix.draftType || fix.title)}`,
    title: fix.title,
    draftType: fix.draftType === 'field_mapping_suggestion' ? 'field_mapping_suggestion' : fix.draftType === 'data_completion_checklist' ? 'data_completion_checklist' : 'internal_review_note',
    sourceCategory: 'data_access_quality',
    sourceModule: 'Data Access & Quality',
    sourceLabel: 'Data Access & Quality',
    sourceEntityType: 'data_quality_issue',
    sourceEntityId: fix.targetObject || `fix-${index + 1}`,
    sourceEntityLabel: fix.targetObject || fix.title,
    targetModule: 'imports',
    targetEntityType: 'data_quality_issue',
    targetEntityId: fix.targetObject || `fix-${index + 1}`,
    targetEntityLabel: fix.targetObject || fix.title,
    status: index === 1 ? STATUS.info : STATUS.preview,
    priority: index === 1 ? '高' : '中',
    owner: '数据接入',
    conclusion: fix.description,
    keyEvidence: [fix.description],
    businessImpact: ['影响 AI、风险与异常、三单匹配和报表可信度。'],
    proposedDraftContent: `${fix.title}：${fix.description}`,
    reviewChecklist: ['核对字段含义', '确认来源业务对象', '补齐缺失证据'],
    missingInformation: asArray(fix.payload?.issueIds || fix.payload?.relationshipGapIds || fix.payload?.evidenceGapIds),
    navigationLinks: [nav('打开 Data Access & Quality', 'data_quality', fix.targetObject || 'data-quality-gap-workspace')],
    dataLimitations: quality.dataLimitations,
  }))
  const issueDrafts = asArray(quality.qualityIssues).slice(0, 3).map((issue, index) => makeDraft({
    id: `data-access-issue-${issue.id}`,
    title: `${issue.title}复核备注草稿`,
    draftType: issue.category === 'unmapped_field' ? 'field_mapping_suggestion' : issue.category === 'missing_supplier_profile_evidence' ? 'data_completion_checklist' : 'internal_review_note',
    sourceCategory: 'data_access_quality',
    sourceModule: 'Data Access & Quality',
    sourceLabel: 'Data Access & Quality',
    sourceEntityType: issue.businessObjectType,
    sourceEntityId: issue.businessObjectId,
    sourceEntityLabel: issue.businessObjectLabel || issue.title,
    targetModule: asArray(issue.navigationLinks)[0]?.moduleId || 'imports',
    targetEntityType: issue.businessObjectType,
    targetEntityId: issue.businessObjectId,
    targetEntityLabel: issue.businessObjectLabel || issue.title,
    status: index === 0 ? STATUS.waiting : STATUS.preview,
    priority: issue.severity === 'high' ? '高' : '中',
    owner: '数据接入',
    conclusion: issue.explanation,
    keyEvidence: [issue.explanation, issue.suggestedFix],
    businessImpact: [issue.businessImpact],
    proposedDraftContent: issue.suggestedFix,
    reviewChecklist: ['确认问题是否仍存在', '核对下游影响', '补充负责人说明'],
    missingInformation: [issue.fieldLabel, issue.issueType],
    navigationLinks: issue.navigationLinks,
    dataLimitations: issue.dataLimitations,
  }))
  return [...fixes, ...issueDrafts]
}
function draftsFromAi(data, options) {
  const questions = [
    ['today', '今天有什么需要我处理？'],
    ['supplier-risk', '哪些供应商风险需要复核？'],
    ['inventory-risk', '哪些库存风险需要补货复核？'],
  ]
  return questions.flatMap(([key, question]) => {
    const contract = buildAiResponseContractV2(data, { moduleId: 'overview', question }, options) || {}
    return asArray(contract.cards).flatMap((card) => {
      const response = card?.data || {}
      return asArray(response.reviewCards).map((reviewCard, index) => makeDraft({
        id: `ai-${key}-${index + 1}`,
        title: `${reviewCard.title || response.conclusion || 'AI 建议'}复核草稿`,
        draftType: /supplier/i.test(`${reviewCard.title} ${response.intent}`) ? 'supplier_risk_note' : /inventory|库存/.test(`${reviewCard.title} ${response.intent}`) ? 'inventory_risk_note' : 'internal_review_note',
        sourceCategory: 'ai_response',
        sourceModule: 'AI Response',
        sourceLabel: 'AI Response',
        sourceEntityType: 'ai_response',
        sourceEntityId: key,
        sourceEntityLabel: question,
        targetModule: asArray(response.navigationLinks)[0]?.moduleId || 'overview',
        targetEntityType: asArray(response.navigationLinks)[0]?.entityType || 'ai_response',
        targetEntityId: asArray(response.navigationLinks)[0]?.entityId || key,
        targetEntityLabel: asArray(response.navigationLinks)[0]?.entityLabel || question,
        status: STATUS.preview,
        priority: index === 0 ? '高' : '中',
        owner: '业务负责人',
        conclusion: response.conclusion || reviewCard.summary,
        keyEvidence: response.keyEvidence,
        businessImpact: [response.businessImpact],
        proposedDraftContent: reviewCard.suggestedAction || reviewCard.summary || response.conclusion,
        reviewChecklist: ['核对 AI 结论依据', '查看关联证据', '确认是否需要补充信息'],
        missingInformation: asArray(response.dataLimitations).map((item) => item.label),
        navigationLinks: [nav('打开 AI Assistant', 'ai', key, { moduleId: 'overview' }), ...asArray(response.navigationLinks)],
        dataLimitations: response.dataLimitations,
      }))
    })
  })
}
function draftsFromProcurement({ documents, rfqs, purchaseOrders, receivingDocs, invoices, matches }) {
  const pr = documents.find((doc) => doc.documentType === 'pr' || doc.type === 'purchase_request')
  const rfq = rfqs.find((item) => number(item.quoted ?? item.respondedSupplierCount, 0) < number(item.suppliers ?? item.supplierCount, 0)) || rfqs[0]
  const po = purchaseOrders.find((item) => number(item.items || item.totalOrderedQty, 0) > number(item.received || item.totalReceivedQty, 0)) || purchaseOrders[0]
  const grn = receivingDocs.find((item) => /异常|待检|拒收|质检/.test(text(item.status))) || receivingDocs[0]
  const invoice = invoices.find((item) => number(item.varianceAmount, 0) !== 0) || invoices[0]
  const match = matches.find((item) => number(item.varianceAmount, 0) !== 0) || matches[0]
  return [
    pr && makeDraft({
      id: `p2p-pr-rfq-${pr.id}`,
      title: `${pr.id} RFQ 草稿预览`,
      draftType: 'rfq_draft_preview',
      sourceCategory: 'purchase_request',
      sourceModule: 'PR / RFQ / PO / GRN / Invoice',
      sourceLabel: 'PR / RFQ / PO / GRN / Invoice',
      sourceEntityType: 'purchase_request',
      sourceEntityId: pr.id,
      sourceEntityLabel: objectLabel('pr', pr.id),
      targetModule: 'procurement:rfq',
      targetEntityType: 'rfq',
      targetEntityId: pr.linkedRfq || pr.id,
      targetEntityLabel: 'RFQ 草稿预览',
      priority: pr.priority || '中',
      owner: pr.buyer || pr.requester || '采购申请',
      conclusion: `${pr.id} 可先整理为 RFQ 草稿预览，等待人工复核。`,
      keyEvidence: [pr.summary || pr.itemName || pr.sku || pr.id],
      businessImpact: ['PR 未进入后续寻源会影响采购启动。'],
      proposedDraftContent: 'RFQ 草稿预览：整理需求、数量、期望日期和供应商候选范围。',
      reviewChecklist: ['确认需求数量', '确认供应商候选范围', '确认交付日期'],
      missingInformation: ['供应商回复明细', '期望交期确认'],
      navigationLinks: [nav('打开 PR', 'pr', pr.id), nav('打开 RFQ', 'rfq', pr.linkedRfq || '')],
    }),
    rfq && makeDraft({
      id: `p2p-rfq-award-${rfq.id}`,
      title: `${rfq.id} 授标建议草稿`,
      draftType: 'internal_review_note',
      sourceCategory: 'rfq_sourcing',
      sourceModule: 'PR / RFQ / PO / GRN / Invoice',
      sourceLabel: 'PR / RFQ / PO / GRN / Invoice',
      sourceEntityType: 'rfq',
      sourceEntityId: rfq.id,
      sourceEntityLabel: objectLabel('rfq', rfq.id),
      targetModule: 'procurement:rfq',
      targetEntityType: 'rfq',
      targetEntityId: rfq.id,
      targetEntityLabel: objectLabel('rfq', rfq.id),
      priority: '中',
      owner: '寻源采购',
      conclusion: `${rfq.id} 需要复核报价回复完整性后再形成建议。`,
      keyEvidence: [`已回复 ${number(rfq.quoted ?? rfq.respondedSupplierCount, 0)} / ${number(rfq.suppliers ?? rfq.supplierCount, 0)} 家`],
      businessImpact: ['报价样本不足会影响比价完整性。'],
      proposedDraftContent: '授标建议草稿：整理候选、价格、交期、风险和待补证据。',
      reviewChecklist: ['核对报价回复', '核对交期与价格', '确认是否需要补充供应商'],
      missingInformation: ['未回复原因', '报价行明细'],
      navigationLinks: [nav('打开 RFQ', 'rfq', rfq.id)],
    }),
    rfq && makeDraft({
      id: `p2p-rfq-po-${rfq.id}`,
      title: `${rfq.id} PO 草稿预览`,
      draftType: 'po_draft_preview',
      sourceCategory: 'rfq_sourcing',
      sourceModule: 'PR / RFQ / PO / GRN / Invoice',
      sourceLabel: 'PR / RFQ / PO / GRN / Invoice',
      sourceEntityType: 'rfq',
      sourceEntityId: rfq.id,
      sourceEntityLabel: objectLabel('rfq', rfq.id),
      targetModule: 'procurement:orders',
      targetEntityType: 'purchase_order',
      targetEntityId: rfq.linkedPo || '',
      targetEntityLabel: 'PO 草稿预览',
      priority: '中',
      owner: '采购执行',
      conclusion: 'RFQ 结论可形成 PO 草稿预览，但必须人工复核。',
      keyEvidence: [`候选供应商 ${rfq.bestSupplier || '待确认'}`, `截止 ${rfq.due || rfq.dueDate || '待确认'}`],
      businessImpact: ['采购订单形成前需要确认供应商、数量、价格和交付条件。'],
      proposedDraftContent: 'PO 草稿预览：整理供应商、物料、数量、价格、交期和限制说明。',
      reviewChecklist: ['确认供应商', '确认价格与币种', '确认交付地址'],
      missingInformation: ['最终数量', '交付条件'],
      navigationLinks: [nav('打开 RFQ', 'rfq', rfq.id), nav('打开 PO', 'po', rfq.linkedPo || '')],
    }),
    po && makeDraft({
      id: `p2p-po-receiving-${po.po || po.id}`,
      title: `${po.po || po.id} 收货异常说明草稿`,
      draftType: 'receiving_exception_note',
      sourceCategory: 'po_receiving_invoice',
      sourceModule: 'PR / RFQ / PO / GRN / Invoice',
      sourceLabel: 'PR / RFQ / PO / GRN / Invoice',
      sourceEntityType: 'purchase_order',
      sourceEntityId: po.po || po.id,
      sourceEntityLabel: objectLabel('po', po.po || po.id),
      targetModule: 'procurement:receiving',
      targetEntityType: 'receiving_doc',
      targetEntityId: grn?.grn || '',
      targetEntityLabel: grn ? objectLabel('grn', grn.grn) : '收货协同',
      priority: '高',
      owner: po.buyer || '采购执行',
      conclusion: 'PO 收货进度或质量状态需要形成内部说明。',
      keyEvidence: [`订购 ${number(po.items || po.totalOrderedQty, 0)}，已收 ${number(po.received || po.totalReceivedQty, 0)}`],
      businessImpact: ['收货异常会影响库存覆盖和后续发票复核。'],
      proposedDraftContent: '收货异常说明草稿：记录未收数量、质检状态、ETA 和待确认事项。',
      reviewChecklist: ['核对 PO Line', '核对 GRN Line', '确认异常原因'],
      missingInformation: ['供应商确认 ETA'],
      navigationLinks: [nav('打开 PO', 'po', po.po || po.id), nav('打开 GRN / Receiving', 'grn', grn?.grn || '')],
    }),
    (invoice || match) && makeDraft({
      id: `p2p-invoice-variance-${invoice?.id || match?.id}`,
      title: `${invoice?.id || match?.id} 差异说明草稿`,
      draftType: 'variance_explanation',
      sourceCategory: 'po_receiving_invoice',
      sourceModule: 'PR / RFQ / PO / GRN / Invoice',
      sourceLabel: 'PR / RFQ / PO / GRN / Invoice',
      sourceEntityType: 'supplier_invoice',
      sourceEntityId: invoice?.id || match?.invoiceId || match?.id,
      sourceEntityLabel: objectLabel('invoice', invoice?.id || match?.invoiceId || match?.id),
      targetModule: 'procurement:invoices',
      targetEntityType: 'supplier_invoice',
      targetEntityId: invoice?.id || match?.invoiceId || match?.id,
      targetEntityLabel: objectLabel('invoice', invoice?.id || match?.invoiceId || match?.id),
      priority: '高',
      owner: '采购 / 财务协同',
      conclusion: 'PO / GRN / Invoice 差异需要人工复核并形成说明。',
      keyEvidence: [`差异金额 ${number(invoice?.varianceAmount || match?.varianceAmount, 0).toLocaleString()}`],
      businessImpact: ['差异会影响采购、收货与财务协同可见性。'],
      proposedDraftContent: '差异说明草稿：列出数量、单价、金额差异和需要补充的证据。',
      reviewChecklist: ['核对 PO', '核对 GRN', '核对 Invoice'],
      missingInformation: ['发票行或收货行明细'],
      navigationLinks: [nav('打开发票 / Three-way Match', 'invoice', invoice?.id || match?.invoiceId || ''), nav('打开 PO', 'po', invoice?.relatedPo || match?.poId || '')],
    }),
  ].filter(Boolean)
}
function draftsFromSuppliers(data, suppliers) {
  return asArray(suppliers?.candidates || suppliers).slice(0, 2).map((supplier, index) => {
    const name = text(supplier.supplierName || supplier.name || supplier.supplierId, `供应商 ${index + 1}`)
    return makeDraft({
      id: `supplier-profile-note-${compact(name)}`,
      title: `${name} 供应商风险说明草稿`,
      draftType: index === 0 ? 'supplier_communication_draft' : 'supplier_risk_note',
      sourceCategory: 'supplier_profile',
      sourceModule: 'Supplier Operational Profile',
      sourceLabel: 'Supplier Operational Profile',
      sourceEntityType: 'supplier',
      sourceEntityId: supplier.supplierId || name,
      sourceEntityLabel: name,
      targetModule: 'srm:master',
      targetEntityType: 'supplier',
      targetEntityId: supplier.supplierId || name,
      targetEntityLabel: name,
      priority: /高|high/i.test(supplier.risk) ? '高' : '中',
      owner: '供应商管理',
      conclusion: `${name} 的交期、质量或资料完整性需要内部复核。`,
      keyEvidence: [`风险等级 ${supplier.risk || '待复核'}`, `资料完整性 ${supplier.profileCompleteness || '待确认'}`],
      businessImpact: ['供应商风险会影响采购连续性和异常处理优先级。'],
      proposedDraftContent: index === 0 ? '供应商沟通草稿预览：整理内部关注点，明确不会外发。' : '供应商风险说明草稿：整理风险证据、影响和待补资料。',
      reviewChecklist: ['核对供应商档案', '核对交易证据', '确认是否需要业务负责人跟进'],
      missingInformation: ['联系人或证书资料', '近期交易证据'],
      navigationLinks: [nav('打开 Supplier Operational Profile', 'supplier', supplier.supplierId || name)],
      dataLimitations: [{ label: '供应商资料完整性', description: '联系人、证书和交易证据需人工确认。' }],
    })
  })
}
function draftsFromInventory(items) {
  return asArray(items).filter((item) => /低库存|缺货|不足|预警|高|中/.test(`${item.status} ${item.riskLevel}`)).slice(0, 3).flatMap((item, index) => ([
    makeDraft({
      id: `inventory-replenishment-${item.sku}`,
      title: `${item.sku} 补货 PR 草稿预览`,
      draftType: 'inventory_replenishment_preview',
      sourceCategory: 'inventory_risk',
      sourceModule: 'Inventory Risk',
      sourceLabel: 'Inventory Risk',
      sourceEntityType: 'inventory_item',
      sourceEntityId: item.sku,
      sourceEntityLabel: objectLabel('inventory', item.sku),
      targetModule: 'procurement:requests',
      targetEntityType: 'purchase_request',
      targetEntityId: item.sku,
      targetEntityLabel: '补货 PR 草稿预览',
      priority: index === 0 ? '高' : '中',
      owner: '库存计划',
      conclusion: `${item.sku} 库存风险建议形成补货草稿预览。`,
      keyEvidence: [`可用库存 ${number(item.availableQuantity, 0).toLocaleString()}`, `安全库存 ${number(item.safetyStock, 0).toLocaleString()}`],
      businessImpact: ['库存风险可能影响客户交付和生产齐套。'],
      proposedDraftContent: '补货 PR 草稿预览：整理 SKU、缺口、建议数量、仓库和需要人工确认的依据。',
      reviewChecklist: ['核对库存口径', '核对需求来源', '确认补货数量'],
      missingInformation: ['需求来源确认', '默认供应商确认'],
      navigationLinks: [nav('打开 Inventory', 'inventory', item.sku), nav('打开 PR', 'pr', '')],
      dataLimitations: [{ label: '库存口径', description: '库存风险基于当前工作区可用库存、安全库存和再订货点。' }],
    }),
    makeDraft({
      id: `inventory-risk-note-${item.sku}`,
      title: `${item.sku} 库存风险复核备注草稿`,
      draftType: 'inventory_risk_note',
      sourceCategory: 'inventory_risk',
      sourceModule: 'Inventory Risk',
      sourceLabel: 'Inventory Risk',
      sourceEntityType: 'inventory_item',
      sourceEntityId: item.sku,
      sourceEntityLabel: objectLabel('inventory', item.sku),
      targetModule: 'inventory',
      targetEntityType: 'inventory_item',
      targetEntityId: item.sku,
      targetEntityLabel: objectLabel('inventory', item.sku),
      priority: '中',
      owner: '库存计划',
      conclusion: '库存风险需要形成内部复核说明。',
      keyEvidence: [`状态 ${item.status || item.riskLevel || '需复核'}`],
      businessImpact: ['库存复核备注用于协同可见性。'],
      proposedDraftContent: '库存风险复核备注：说明缺口、影响对象、补货建议和缺失依据。',
      reviewChecklist: ['核对仓库', '核对安全库存', '确认是否已有采购动作'],
      missingInformation: ['关联 PR / PO'],
      navigationLinks: [nav('打开 Inventory', 'inventory', item.sku)],
    }),
  ]))
}
function buildSourceSummary(drafts) {
  return SOURCE_ORDER.map((category) => {
    const rows = drafts.filter((draft) => draft.sourceCategory === category || (category === 'purchase_request' && ['purchase_request', 'rfq_sourcing', 'po_receiving_invoice'].includes(draft.sourceCategory)))
    const top = [...rows].sort((a, b) => priorityRank(b.priority) - priorityRank(a.priority))[0]
    return {
      sourceCategory: category,
      sourceLabel: SOURCE_LABELS[category],
      draftCount: rows.length,
      highPriorityCount: rows.filter((draft) => priorityRank(draft.priority) >= 4).length,
      dataLimitationCount: rows.filter((draft) => draft.dataLimitations.length).length,
      topDraft: top?.title || '暂无行动草稿',
      navigationLinks: [sourceNavigation(category)],
    }
  })
}
function sourceNavigation(category) {
  if (category === 'ai_response') return nav('打开 AI Assistant', 'ai', 'review-first-actions', { moduleId: 'overview' })
  if (category === 'control_tower') return nav('打开风险与异常', 'data_quality', 'action-inbox', { moduleId: 'overview:risks', entityType: 'operations_control_tower', entityLabel: '风险与异常' })
  if (category === 'reports_analytics') return nav('打开 Reports & Analytics', 'reports', 'reports-analytics', { moduleId: 'reports', entityType: 'report_workspace' })
  if (category === 'data_access_quality') return nav('打开 Data Access & Quality', 'data_quality', 'data-quality-gap-workspace')
  if (category === 'supplier_profile') return nav('打开 Supplier Operational Profile', 'supplier', '')
  if (category === 'inventory_risk') return nav('打开 Inventory', 'inventory', '')
  return nav('打开 PR / RFQ / PO / GRN / Invoice', 'po', '', { moduleId: 'procurement' })
}

export function buildReviewFirstActionWorkflowV2(data = {}, options = {}) {
  const tower = buildOperationsControlTowerV2(data, options)
  const reports = buildReportsAnalyticsV2(data, options)
  const quality = buildDataAccessQualityV2(data, options)
  const documents = buildProcurementDocuments(data)
  const rfqs = buildProcurementRfqs(data)
  const purchaseOrders = buildProcurementPurchaseOrders(data)
  const receivingDocs = buildProcurementReceivingDocs(data)
  const invoices = buildProcurementSupplierInvoices(data)
  const matches = buildProcurementThreeWayMatches(data)
  const inventoryItems = buildInventoryItems(data)
  const suppliers = buildSupplierEntityIndex(data)

  const rawDrafts = [
    ...draftsFromAi(data, options),
    ...draftsFromControlTower(tower),
    ...draftsFromReports(reports),
    ...draftsFromDataAccess(quality),
    ...draftsFromProcurement({ documents, rfqs, purchaseOrders, receivingDocs, invoices, matches }),
    ...draftsFromSuppliers(data, suppliers),
    ...draftsFromInventory(inventoryItems),
  ]
  const drafts = uniqueBy(rawDrafts, (draft) => draft.id)
    .map((draft, index) => ({ ...draft, draftNo: `RFW-${String(index + 1).padStart(4, '0')}` }))
    .sort((a, b) => priorityRank(b.priority) - priorityRank(a.priority) || a.draftNo.localeCompare(b.draftNo))

  const policy = lifecyclePolicy()
  const dataLimitations = uniqueBy([
    ...asArray(tower.limitations),
    ...asArray(reports.dataLimitations),
    ...asArray(quality.dataLimitations),
    ...drafts.flatMap((draft) => draft.dataLimitations),
    ...(drafts.length ? [] : [{ label: '当前数据范围', description: '当前工作区缺少可生成行动草稿的业务证据。' }]),
  ].map((item) => cleanLimitation(item)), (item) => `${item.label}:${item.description}`).slice(0, 10)

  return {
    summary: {
      totalDraftCount: drafts.length,
      waitingReviewCount: drafts.filter((draft) => draft.status === STATUS.waiting).length,
      changesRequestedCount: drafts.filter((draft) => draft.status === STATUS.info || draft.status === STATUS.returned).length,
      cancelledCount: drafts.filter((draft) => draft.status === STATUS.cancelled).length,
      manuallyHandledCount: drafts.filter((draft) => draft.status === STATUS.handled).length,
      highPriorityCount: drafts.filter((draft) => priorityRank(draft.priority) >= 4).length,
      dataLimitedCount: drafts.filter((draft) => draft.dataLimitations.length).length,
      sourceCount: buildSourceSummary(drafts).filter((source) => source.draftCount > 0).length,
      overallStatus: drafts.some((draft) => draft.status === STATUS.waiting) ? STATUS.waiting : drafts.length ? STATUS.preview : STATUS.info,
    },
    drafts,
    sourceSummary: buildSourceSummary(drafts),
    lifecyclePolicy: policy,
    dataLimitations,
    generatedAt: options.generatedAt || new Date().toISOString(),
    dataScopeLabel: '当前工作区数据',
  }
}
