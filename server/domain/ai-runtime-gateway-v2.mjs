import { buildAiResponseContractV2 } from './ai-response-contract-v2.mjs'
import { buildAiSuggestionsWorkbenchV2 } from './ai-suggestions-workbench-v2.mjs'
import { buildAuditIntegrationHistoryV2 } from './audit-integration-history-v2.mjs'
import { buildCollaborationNotificationDraftsV2 } from './collaboration-notification-drafts-v2.mjs'
import {
  buildCoreBusinessChainV1,
  findBusinessChainByEntityV1,
  sanitizeCoreBusinessChainForAiV1,
} from './core-business-chain-v1.mjs'
import { buildDataAccessQualityV2 } from './data-access-quality-v2.mjs'
import { buildOperationsControlTowerV2 } from './operations-control-tower-v2.mjs'
import { buildPilotReadinessGovernanceV2 } from './pilot-readiness-governance-v2.mjs'
import { buildReportsAnalyticsV2 } from './reports-analytics-v2.mjs'
import { buildReviewFirstActionWorkflowV2 } from './review-first-action-workflow-v2.mjs'
import { buildSalesDemandReadModel } from './sales-demand-read-model.mjs'
import { buildUserRolePermissionVisibilityV2 } from './user-role-permission-visibility-v2.mjs'
import { buildWorkspaceBoundaryVisibilityV2 } from './workspace-boundary-visibility-v2.mjs'
import { buildWorkspaceSetupConfigV2 } from './workspace-setup-config-v2.mjs'
import {
  canCallConfiguredProvider,
  buildProviderInputPackageV2,
  callConfiguredProvider,
  fallbackResponse,
  isProviderAssistedRequested,
  normalizeProviderOutput as normalizeProviderOutputCompat,
  providerRuntimeConfig,
  selectProviderAdapter,
  validateAiRuntimeResponseV2,
} from './ai-runtime-provider-adapter-v2.mjs'
import {
  boundedConversationSummaryV2,
  buildContextBreadcrumbsV2,
  buildConversationGroundingV2,
  buildFollowUpSuggestionsV2,
  resolveFollowUpReferenceV2,
} from './ai-runtime-conversation-context-v2.mjs'
import { buildContextualReviewCardsV2 } from './ai-runtime-contextual-action-drafts-v2.mjs'

export const FORBIDDEN_AI_RUNTIME_ACTION_PATTERN = /自动批准|自动下单|正式创建\s*PO|下发\s*PO|发送\s*PO|发布\s*RFQ|邀请供应商|发送邮件|发送|推送|已发送|提交收货|Receive Submit|Submit Receipt|库存过账|Post Invoice|Approve Invoice|Mark as Paid|Payment execution|Export to Accounting|付款|会计过账|修改供应商主数据|更新银行账户|发布风险评级|自动黑名单|自动暂停供应商|自动修复|自动提交导入|自动覆盖数据|自动写入数据库|批量删除|清空数据|sent|delivered|dispatched|webhook|portal invite|保存配置|保存权限|保存边界|保存历史|保存准备度|修改权限|修改历史|修改准备度|删除历史|立即生效|自动应用|分配角色|创建用户|删除用户|禁用用户|创建租户|切换租户|合并租户|迁移数据|同步数据|跨租户查询|写入配置|写入日志|推送日志|导出审计报告|生成正式审计报告|发送审计报告|启用试点|开启试点|上线|部署|生成正式报告|导出正式报告|发送报告/i
export const FORBIDDEN_AI_RUNTIME_TECHNICAL_PATTERN = /JSON|dry-run|tenantId|userId|datasetId|writesDb|writesFiles|DB|database|schema|environment|tool_result|provider|model|endpoint|token|API key|API|fallback|deterministic|mock|fake|demo|UAT|sample data|demo data|response_card|entityType|documentType|raw enum|payload|webhook|Coupa|RBAC|production|deploy|go-live|system prompt|prompt package/i

const GENERATED_AT = '2026-05-25T13:00:00.000Z'
const DATA_SCOPE = '当前工作区数据'
const SAFETY_BOUNDARIES = ['草稿预览', '人工复核', '不形成正式业务处理', '不外发', '不写库存', '不写财务凭证', '不处理资金', '不改主数据', '不覆盖当前工作区数据']
const ALLOWED_ACTIONS = ['查看证据', '预览草稿', '进入人工复核', '打开来源对象', '打开相关模块', '标记仅内部留存', '补充数据', '查看数据限制']
const SAFE_CONTEXT_LIMITATIONS = Object.freeze({
  responseContract: 'AI 回复证据暂不完整',
  ai: 'AI 建议证据暂不完整',
  tower: '今日行动证据暂不完整',
  reports: '报表证据暂不完整',
  review: '人工复核证据暂不完整',
  collaboration: '协同草稿证据暂不完整',
  data: '数据质量证据暂不完整',
  workspace: '工作区配置证据暂不完整',
  roles: '角色权限证据暂不完整',
  boundary: '工作区边界证据暂不完整',
  audit: '业务历史证据暂不完整',
  pilot: '准备度证据暂不完整',
  salesDemand: '销售需求证据暂不完整',
  coreBusinessChain: '核心业务链证据暂不完整',
})

function asArray(value) { return Array.isArray(value) ? value : [] }
function number(value, fallback = 0) { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : fallback }
function text(value, fallback = '') { return sanitize(String(value ?? '').trim() || fallback) }
function sanitize(value = '') {
  const identifiers = []
  const masked = String(value ?? '').replace(/\b[A-Z0-9]+(?:[-_][A-Z0-9]+)+\b/gi, (identifier) => {
    const index = identifiers.push(identifier) - 1
    return `\uE000${index}\uE001`
  })
  return masked
    .replace(/自动批准|自动下单|正式创建\s*PO|下发\s*PO|发送\s*PO|发布\s*RFQ|邀请供应商|发送邮件|发送|推送|已发送|提交收货/ig, '正式业务处理')
    .replace(/Receive Submit|Submit Receipt|库存过账|Post Invoice|Approve Invoice|Mark as Paid|Payment execution|Export to Accounting|会计过账|付款/ig, '正式资金或凭证处理')
    .replace(/修改供应商主数据|更新银行账户|发布风险评级|自动黑名单|自动暂停供应商/ig, '供应商资料正式变更')
    .replace(/自动修复|自动提交导入|自动覆盖数据|自动写入数据库|批量删除|清空数据|保存配置|保存权限|保存边界|保存历史|保存准备度|修改权限|修改历史|修改准备度|删除历史|立即生效|自动应用|分配角色|创建用户|删除用户|禁用用户|创建租户|切换租户|合并租户|迁移数据|同步数据|跨租户查询|写入配置|写入日志|推送日志|导出审计报告|生成正式审计报告|发送审计报告|启用试点|开启试点|上线|部署|生成正式报告|导出正式报告|发送报告/ig, '正式变更')
    .replace(/sent|delivered|dispatched|webhook|portal invite/ig, '外部触达动作')
    .replace(/JSON|dry-run|tenantId|userId|datasetId|writesDb|writesFiles|tool_result|provider|model|endpoint|token|API key|API|fallback|deterministic|mock|fake|demo|UAT|sample data|demo data|response_card|entityType|documentType|raw enum|payload|webhook|database|schema|environment|Coupa|RBAC|production|deploy|go-live|system prompt|prompt package/ig, DATA_SCOPE)
    .replace(/\bDB\b/g, DATA_SCOPE)
    .replace(/\uE000(\d+)\uE001/g, (_match, index) => identifiers[Number(index)] || '')
}
function cleanList(items = [], fallback = []) {
  const values = asArray(items).map((item) => text(typeof item === 'string' ? item : item?.label || item?.title || item?.summary || item?.description)).filter(Boolean)
  return values.length ? values : fallback
}
function uniqueBy(items = [], keyOf = (item) => item.id || item.label || item.title) {
  const seen = new Set()
  const out = []
  for (const item of items.filter(Boolean)) {
    const key = keyOf(item)
    if (!key || seen.has(key)) continue
    seen.add(key)
    out.push(item)
  }
  return out
}
function cleanLimitation(item, fallbackLabel = '当前数据范围限制') {
  if (typeof item === 'string') return { label: text(item, fallbackLabel), description: text(item), severity: 'warning', consequence: '需要结合来源证据人工复核。' }
  return {
    label: text(item?.label, fallbackLabel),
    description: text(item?.description || item?.consequence || item?.impactSummary, '需要结合来源证据人工复核。'),
    severity: normalizeSeverity(item?.severity),
    missingData: cleanList(item?.missingData || item?.affectedModules || item?.affectedMetrics),
    consequence: text(item?.consequence || item?.impactSummary, '可能影响证据解释和草稿优先级。'),
  }
}
function normalizeSeverity(value = '') {
  const raw = text(value).toLowerCase()
  if (/risk|critical|high|高|阻塞|严重/.test(raw)) return 'risk'
  if (/success|ok|正常|已具备/.test(raw)) return 'success'
  if (/warning|medium|中|提醒|复核|限制/.test(raw)) return 'warning'
  return 'info'
}
function nav(label, moduleId, entityType = 'business_object', entityId = '', entityLabel = '') {
  const normalizedType = text(entityType, 'business_object')
  const normalizedId = text(entityId)
  return {
    label: text(label),
    moduleId: text(moduleId, 'overview'),
    entityType: normalizedType,
    entityId: normalizedId,
    entityLabel: text(entityLabel || label),
    returnTo: 'ai-assistant',
    source: 'aiRuntimeGateway',
    reason: '从 AI 助手查看来源证据。',
    returnContext: {
      sourceModule: 'ai-assistant',
      sourceRoute: 'ai-assistant',
      sourceLabel: 'AI 助手',
      returnLabel: '返回 AI 助手',
      originIntent: 'aiRuntimeGateway',
    },
    ...(normalizedType === 'purchase_order' && normalizedId ? {
      label: `查看并处理 ${normalizedId}`,
      focusTarget: {
        entityType: normalizedType,
        entityId: normalizedId,
        focusArea: 'receiving-invoice-variance',
      },
    } : {}),
  }
}
function linkTarget(moduleId, entityType = 'business_object', entityId = '') {
  return { moduleId, entityType, entityId }
}
function evidence(input = {}) {
  const moduleId = input.moduleId || 'overview'
  const entityType = input.entityType || 'business_object'
  const entityId = text(input.entityId)
  const entityLabel = text(input.entityLabel || input.objectLabel || input.label || input.evidenceLabel, entityId || '来源证据')
  return {
    id: text(input.id, `${moduleId}-${entityId || entityLabel}`),
    sourceModule: text(input.sourceModule || input.sourceLabel || moduleLabel(moduleId)),
    objectLabel: entityLabel,
    evidenceLabel: text(input.evidenceLabel || input.label || entityLabel),
    evidenceSummary: text(input.evidenceSummary || input.summary || input.description || input.status, '当前工作区来源证据。'),
    label: text(input.label || entityLabel),
    entityLabel,
    entityType,
    entityId,
    moduleId,
    evidenceType: text(input.evidenceType || 'navigation_context'),
    summary: text(input.summary || input.evidenceSummary || input.description, '当前工作区来源证据。'),
    value: input.value ?? null,
    status: text(input.status),
    severity: normalizeSeverity(input.severity || input.status),
    sourceLabel: text(input.sourceLabel || input.sourceModule || DATA_SCOPE),
    navigationLinks: [nav(`查看${entityLabel}`, moduleId, entityType, entityId, entityLabel)],
    linkTarget: linkTarget(moduleId, entityType, entityId),
  }
}

function classifyEvidence(items = [], ctx = {}) {
  const rows = sourceRows(ctx)
  const factIds = new Set(Object.values(rows).flatMap((records) => asArray(records).flatMap((record) => [
    record?.id, record?.po, record?.sku, record?.rfq, record?.salesOrderId,
    record?.documentNumber, record?.invoiceNumber,
  ])).map((value) => text(value)).filter(Boolean))
  return items.map((item) => {
    const isFact = Boolean(item.entityId) && factIds.has(text(item.entityId))
    return { ...item, evidenceType: isFact ? 'business_fact' : item.evidenceType === 'database_aggregate' ? 'database_aggregate' : item.evidenceType }
  })
}
function moduleLabel(moduleId = '') {
  if (moduleId === 'overview') return '今日行动'
  if (moduleId === 'overview:ai') return 'AI 建议'
  if (/procurement/.test(moduleId)) return '采购管理'
  if (/inventory/.test(moduleId)) return '库存管理'
  if (/srm/.test(moduleId)) return '供应商管理'
  if (/finance/.test(moduleId)) return '财务协同'
  if (/reports/.test(moduleId)) return '报表与分析'
  if (/imports/.test(moduleId)) return '数据接入与质量'
  if (/review-actions/.test(moduleId)) return '行动草稿与人工复核'
  if (/collaboration-drafts/.test(moduleId)) return '协同通知草稿'
  if (/settings:roles/.test(moduleId)) return '角色权限可见性'
  if (/settings:boundaries/.test(moduleId)) return '工作区边界'
  if (/settings/.test(moduleId)) return '工作区配置'
  if (/audit-history/.test(moduleId)) return '业务审计与历史'
  if (/pilot-readiness/.test(moduleId)) return '试点准备度'
  return moduleId || '当前工作区'
}
function normalizeRequest(input = {}) {
  const message = text(input.message || input.question || input.prompt || input.text)
  return {
    message: message.slice(0, 1200),
    activeModuleId: text(input.activeModuleId || input.moduleId),
    activeViewId: text(input.activeViewId || input.viewId),
    focusTarget: input.focusTarget || input.activeContext || null,
    conversationContext: input.conversationContext || {},
    sessionGrounding: input.sessionGrounding || null,
    returnTo: text(input.returnTo || 'ai-assistant'),
  }
}
export function validateAiRuntimeRequest(input = {}) {
  const rawMessage = text(input.message || input.question || input.prompt || input.text)
  const request = normalizeRequest(input)
  if (rawMessage.length > 1200) {
    return { ok: false, status: 400, request, error: '问题过长，请缩短后重新提问。' }
  }
  if (request.message.length < 2) {
    return { ok: false, status: 400, request, error: '请输入至少两个字的问题，AI 助手会基于当前工作区证据回答。' }
  }
  return { ok: true, status: 200, request }
}

const SUPPORTED_INTENTS = [
  ['receiving_exception', '收货异常', /收货异常|到货异常|GRN\s*异常|GRN issue|receiving exception|质检中|异常处理|待收货|哪些还没收货|还没收货|未收货/iu],
  ['today_attention', '今天有什么需要我处理', /今天|今日|先看|重点|处理|注意|最需要处理/],
  ['sales_delivery_risk', '客户订单交付风险', /客户订单|销售需求|销售订单|交付风险|\bSO-[A-Z0-9-]+\b/i],
  ['core_business_chain', '核心业务链证据', /主链|核心业务链|链路|销售需求.*SKU|SKU.*PR|SKU.*PO|PO.*供应商.*收货.*发票|收货异常.*发票|发票差异.*财务协同|证据不足|这条链路|人工复核草稿/],
  ['inventory_risk', 'SKU 库存风险', /SKU|库存|补货|缺货|物料|库存项目|库存需要关注|哪些库存|可用量|可承诺量/],
  ['po_priority', 'PO 优先级', /PO|采购订单|优先|为什么/],
  ['supplier_risk', '供应商风险', /供应商|供方|风险|跟进|绩效/],
  ['unreceived_orders', '未收货订单', /未收货|还没有收货|待收货|到货/],
  ['received_not_invoiced', '已收货未开票', /已收货.*发票|未开票|还没开票|没开票|未票|收货.*发票|收货.*开票|已收.*开票/],
  ['three_way_match_variance', '三单匹配差异', /三单|匹配|差异|发票差异/],
  ['data_incomplete', '数据依据不完整', /数据.*不完整|依据.*不完整|数据缺口|证据缺口|字段映射/],
  ['ai_draft_suggestions', 'AI 建议草稿', /AI 建议|草稿|建议.*生成/],
  ['collaboration_review', '协同通知草稿', /协同|通知草稿|沟通草稿/],
  ['pilot_blockers', '试点准备度阻塞项', /试点|准备度|阻塞|观察项/],
  ['role_boundary_limits', '角色权限 / 工作区边界限制', /角色|权限|边界|工作区/],
  ['audit_history_recent', '业务审计历史', /审计|历史|最近发生/],
  ['related_objects', '供应商 / SKU / PO 相关对象', /相关|关联|关系|哪些对象/],
]
function detectIntent(request) {
  const message = request.message
  const unsafe = detectUnsafeRequest(message)
  if (unsafe) return { id: 'unsafe_request', label: '安全边界请求', unsafe }
  if (/相关对象|关联对象/.test(message) || (
    /供应商/.test(message) &&
    /SKU/i.test(message) &&
    /\bPO\b|采购订单/i.test(message) &&
    !/主链|链路|核心业务链/.test(message)
  )) {
    return { id: 'related_objects', label: '供应商 / SKU / PO 相关对象' }
  }
  const groundedPoIds = asArray(request.sessionGrounding?.lastVisibleBusinessIds?.po)
  if (/这个\s*PO|该\s*PO|刚才.*PO/.test(message) && groundedPoIds.length > 1) {
    return { id: 'po_clarification', label: 'PO 选择确认', candidates: groundedPoIds.slice(0, 4) }
  }
  if (/逾期.*PO.*怎么处理|PO.*逾期.*怎么处理|PO-OVERDUE|SOP-PO-OVERDUE/i.test(message)) {
    return { id: 'po_overdue_sop', label: '逾期 PO 跟进' }
  }
  if (/RFQ-[A-Z0-9-]+/i.test(message) && /跟进|回复|供应商|报价/.test(message)) {
    return { id: 'collaboration_review', label: '协同通知草稿' }
  }
  const matched = SUPPORTED_INTENTS.find(([, , pattern]) => pattern.test(message))
  return { id: matched?.[0] || 'today_attention', label: matched?.[1] || '今天有什么需要我处理' }
}
function intentById(intentId = '') {
  const matched = SUPPORTED_INTENTS.find(([id]) => id === intentId)
  return matched ? { id: matched[0], label: matched[1] } : null
}
function hasFollowUpReference(message = '') {
  return /这个|它|刚刚那个|刚才那个|上一个|那个|这条|这张|继续看|展开证据|为什么优先|相关对象|上一层|返回刚才|this|it|that one|previous one|go back|continue|drill down|show related objects|why is it priority/i.test(message)
}
function focusTargetFromResolvedContext(resolvedContext = {}) {
  const ref = asArray(resolvedContext.entityRefs)[0]
  if (!ref?.entityId) return null
  const map = {
    PO: 'purchase_order',
    PR: 'purchase_request',
    RFQ: 'rfq',
    GRN: 'receiving_doc',
    Invoice: 'supplier_invoice',
    Supplier: 'supplier',
    SKU: 'inventory_item',
    ActionDraft: 'action_draft',
  }
  return {
    entityType: map[ref.entityType] || 'business_object',
    entityId: ref.entityId,
    entityLabel: ref.entityLabel || ref.entityId,
  }
}
function enrichRequestWithResolvedContext(request = {}, resolvedContext = {}) {
  const focusTarget = request.focusTarget || focusTargetFromResolvedContext(resolvedContext)
  return focusTarget ? { ...request, focusTarget } : request
}
function intentWithConversationCarryOver(intent, request = {}, resolvedContext = {}) {
  if (intent.id !== 'today_attention') return intent
  if (!hasFollowUpReference(request.message)) return intent
  const carried = intentById(resolvedContext.intentCarryOver)
  return carried || intent
}
function conversationLimitations(resolvedContext = {}) {
  if (!resolvedContext.limitationLabel) return []
  return [{
    label: '当前上下文需要确认',
    description: resolvedContext.limitationLabel,
    severity: 'warning',
    consequence: '请先选择具体对象或打开来源证据后再继续追问。',
  }]
}
function detectUnsafeRequest(message = '') {
  const checks = [
    ['bypass_review', /绕过|不要人工复核|忽略.*复核|直接执行|忽略.*限制/],
    ['direct_approve', /直接.*批准|批准.*PO|自动批准/],
    ['direct_order', /直接.*下单|正式创建\s*PO|下发\s*PO/],
    ['direct_payment', /直接.*付款|付款|支付|打款/],
    ['direct_external', /发给供应商|外发|发送邮件|发送|推送/],
    ['write_inventory', /写库存|库存过账|提交收货/],
    ['master_data_change', /修改供应商.*银行|改.*银行账户|改主数据|更新银行账户/],
    ['delete_data', /删除|清空|覆盖数据/],
    ['technical_secret', /system prompt|API key|token|provider|payload|JSON|模型|密钥|接口/],
  ]
  return checks.find(([, pattern]) => pattern.test(message))?.[0] || ''
}
function contextLimitation(key = 'source') {
  return {
    label: SAFE_CONTEXT_LIMITATIONS[key] || '来源证据暂不完整',
    description: '当前工作区的部分来源证据暂时无法完整读取，已保留可用证据并转入人工复核。',
    severity: 'warning',
    consequence: '建议打开来源模块核对后再继续处理。',
  }
}
function withDataLimitation(value = {}, key = '') {
  if (Array.isArray(value)) return { rows: value, dataLimitations: [contextLimitation(key)] }
  if (!value || typeof value !== 'object') return { dataLimitations: [contextLimitation(key)] }
  return {
    ...value,
    dataLimitations: [...asArray(value.dataLimitations), contextLimitation(key)],
  }
}
function safeBuildContext(key, build, emptyValue = {}) {
  try {
    return build() || emptyValue
  } catch {
    return withDataLimitation(emptyValue, key)
  }
}
function buildContextBuilders(overrides = {}) {
  return {
    responseContract: overrides.responseContract || ((db, request) => buildAiResponseContractV2(db, { message: request.message, question: request.message, moduleId: request.activeModuleId })),
    ai: overrides.ai || ((db) => buildAiSuggestionsWorkbenchV2(db)),
    tower: overrides.tower || ((db) => buildOperationsControlTowerV2(db)),
    reports: overrides.reports || ((db) => buildReportsAnalyticsV2(db)),
    review: overrides.review || ((db) => buildReviewFirstActionWorkflowV2(db)),
    collaboration: overrides.collaboration || ((db) => buildCollaborationNotificationDraftsV2(db)),
    data: overrides.data || ((db) => buildDataAccessQualityV2(db)),
    workspace: overrides.workspace || ((db) => buildWorkspaceSetupConfigV2(db)),
    roles: overrides.roles || ((db) => buildUserRolePermissionVisibilityV2(db)),
    boundary: overrides.boundary || ((db) => buildWorkspaceBoundaryVisibilityV2(db)),
    audit: overrides.audit || ((db) => buildAuditIntegrationHistoryV2(db)),
    pilot: overrides.pilot || ((db) => buildPilotReadinessGovernanceV2(db)),
    salesDemand: overrides.salesDemand || ((db) => buildSalesDemandReadModel(db)),
    coreBusinessChain: overrides.coreBusinessChain || ((db) => buildCoreBusinessChainV1(db)),
  }
}
function buildContexts(db = {}, request = {}, options = {}) {
  const builders = buildContextBuilders(options.contextBuilders || {})
  const responseContract = safeBuildContext('responseContract', () => builders.responseContract(db, request), {})
  const ai = safeBuildContext('ai', () => builders.ai(db, request), {})
  const tower = safeBuildContext('tower', () => builders.tower(db, request), {})
  const reports = safeBuildContext('reports', () => builders.reports(db, request), {})
  const review = safeBuildContext('review', () => builders.review(db, request), {})
  const collaboration = safeBuildContext('collaboration', () => builders.collaboration(db, request), {})
  const data = safeBuildContext('data', () => builders.data(db, request), {})
  const workspace = safeBuildContext('workspace', () => builders.workspace(db, request), {})
  const roles = safeBuildContext('roles', () => builders.roles(db, request), {})
  const boundary = safeBuildContext('boundary', () => builders.boundary(db, request), {})
  const audit = safeBuildContext('audit', () => builders.audit(db, request), {})
  const pilot = safeBuildContext('pilot', () => builders.pilot(db, request), {})
  const salesDemand = safeBuildContext('salesDemand', () => builders.salesDemand(db, request), {})
  const coreBusinessChain = request.coreBusinessChainRequested
    ? safeBuildContext('coreBusinessChain', () => builders.coreBusinessChain(db, request), { chains: [], summary: { chainCount: 0, invoiceGapCount: 0, reviewDraftCount: 0 } })
    : { chains: [], summary: { chainCount: 0, invoiceGapCount: 0, reviewDraftCount: 0 } }
  return { db, responseContract, ai, tower, reports, review, collaboration, data, workspace, roles, boundary, audit, pilot, salesDemand, coreBusinessChain }
}
function collectLimitations(ctx, extra = []) {
  return uniqueBy([
    ...extra,
    ...asArray(ctx.ai.dataLimitations),
    ...asArray(ctx.review.dataLimitations),
    ...asArray(ctx.collaboration.dataLimitations),
    ...asArray(ctx.data.dataLimitations),
    ...asArray(ctx.reports.dataLimitations),
    ...asArray(ctx.workspace.dataLimitations),
    ...asArray(ctx.roles.dataLimitations),
    ...asArray(ctx.boundary.dataLimitations),
    ...asArray(ctx.audit.dataLimitations),
    ...asArray(ctx.pilot.dataLimitations),
    ...asArray(ctx.coreBusinessChain?.dataLimitations),
    ...asArray(ctx.coreBusinessChain?.chains).flatMap((chain) => asArray(chain.dataLimitations)),
  ].map((item) => cleanLimitation(item)), (item) => item.label).slice(0, 8)
}
function sourceSummary(ctx) {
  return [
    ['AI Response Contract v2', 'AI 回复合同', 1, nav('打开 AI 建议', 'overview:ai')],
    ['AI Suggestions Workbench v2', 'AI 建议', number(ctx.ai.summary?.totalSuggestionCount), nav('打开 AI 建议', 'overview:ai')],
    ['Operations Control Tower v2', '今日行动', number(ctx.tower.summary?.totalOpenItems), nav('打开今日行动', 'overview')],
    ['Reports Analytics v2', '报表与分析', asArray(ctx.reports.reportInsights).length, nav('打开报表与分析', 'reports')],
    ['Review-first Action Workflow v2', '行动草稿与人工复核', number(ctx.review.summary?.totalDraftCount), nav('打开行动草稿与人工复核', 'review-actions')],
    ['Collaboration Notification Drafts v2', '协同通知草稿', number(ctx.collaboration.summary?.totalDraftCount), nav('打开协同通知草稿', 'collaboration-drafts')],
    ['Data Access Quality v2', '数据接入与质量', number(ctx.data.summary?.criticalIssueCount) + number(ctx.data.summary?.warningIssueCount), nav('打开数据接入与质量', 'imports')],
    ['Workspace Setup Config v2', '工作区配置', number(ctx.workspace.summary?.enabledModuleCount), nav('打开工作区配置', 'settings')],
    ['User Role Permission Visibility v2', '角色权限可见性', number(ctx.roles.summary?.roleCount), nav('打开角色权限可见性', 'settings:roles')],
    ['Workspace Boundary Visibility v2', '工作区边界', number(ctx.boundary.summary?.boundaryScopeCount), nav('打开工作区边界', 'settings:boundaries')],
    ['Audit Integration History v2', '业务审计与历史', number(ctx.audit.summary?.totalHistoryCount), nav('打开业务审计与历史', 'audit-history')],
    ['Pilot Readiness Governance v2', '试点准备度', number(ctx.pilot.summary?.blockedItemCount) + number(ctx.pilot.summary?.observationItemCount), nav('打开试点准备度', 'pilot-readiness')],
    ['Core Business Chain v1', '核心业务链', number(ctx.coreBusinessChain?.summary?.chainCount), nav('打开核心业务链', 'overview')],
  ].map(([sourceId, sourceLabel, signalCount, link]) => ({ sourceId, sourceLabel, signalCount, navigationLinks: [link] }))
}
function readinessSignals(ctx) {
  return [
    { signalLabel: '证据辅助回答', statusLabel: DATA_SCOPE, signalCount: sourceSummary(ctx).length },
    { signalLabel: '复核优先', statusLabel: '草稿预览和人工复核', signalCount: SAFETY_BOUNDARIES.length },
    { signalLabel: '数据限制', statusLabel: '集中展示', signalCount: collectLimitations(ctx).length },
  ]
}
function recommendedActions(links = [], unsafe = false) {
  const labels = unsafe
    ? ['预览草稿', '进入人工复核', '打开来源对象', '查看数据限制']
    : ALLOWED_ACTIONS.slice(0, 5)
  return labels.map((label, index) => ({
    label,
    description: label === '进入人工复核' ? '由业务负责人确认来源证据、数据限制和后续处理。' : '基于当前工作区证据继续查看，不形成正式业务处理。',
    actionType: `safe_review_${index + 1}`,
    priority: index === 0 ? 'high' : 'medium',
    reviewRequired: true,
    targetModule: links[index % Math.max(links.length, 1)]?.moduleId || 'review-actions',
    disabledReason: '正式业务处理保持关闭。',
  }))
}
function reviewCards(intent, links = []) {
  const firstPo = links.find((link) => link.entityType === 'purchase_order')
  const firstSku = links.find((link) => link.entityType === 'inventory_item')
  const firstRfq = links.find((link) => link.entityType === 'rfq')
  const title = intent.id === 'unsafe_request'
    ? '安全替代复核草稿'
    : intent.id === 'inventory_risk'
      ? '补货 PR 草稿'
      : intent.id === 'collaboration_review'
        ? '供应商跟进草稿'
        : firstPo?.entityId
          ? `${firstPo.entityId} ${intent.label}复核草稿`
          : `${intent.label}复核草稿`
  const draftType = intent.id === 'inventory_risk'
      ? 'purchase_request_draft'
      : intent.id === 'collaboration_review'
          ? 'supplier_followup_draft'
          : firstPo || ['po_priority', 'receiving_exception', 'unreceived_orders', 'three_way_match_variance', 'received_not_invoiced', 'today_attention', 'related_objects', 'po_overdue_sop'].includes(intent.id)
            ? 'po_followup_draft'
            : 'general_review'
  const target = draftType === 'purchase_request_draft' ? firstSku || links[0] || {} : firstPo || firstSku || firstRfq || links[0] || {}
  const payload = draftType === 'purchase_request_draft'
    ? { itemIdOrSku: firstSku?.entityId || '', quantity: 20, reason: title }
    : draftType === 'supplier_followup_draft'
      ? { supplierIdOrName: firstRfq?.entityLabel || firstPo?.entityLabel || '供应商待确认', message: '请复核当前证据并确认后续跟进计划。', reason: title }
      : draftType === 'po_followup_draft'
        ? { poId: firstPo?.entityId || '', message: '请复核到货、收货和差异证据后确认后续跟进计划。', reason: title }
        : { reason: title }
  return [{
    title,
    description: '整理结论、关键证据、业务影响和数据限制，仅供人工复核。',
    previewOnly: true,
    reviewRequired: true,
    requiresHumanReview: true,
    prohibitedActions: ['不形成正式业务处理', '不外发', '不写库存', '不写财务凭证', '不处理资金', '不改主数据'],
    allowedNextStep: '进入人工复核或打开来源模块。',
    targetModule: target.moduleId || 'review-actions',
    targetEntityType: target.entityType || 'business_object',
    targetEntityId: target.entityId || '',
    draftType,
    draftTitle: title,
    payload,
    originEvidence: [firstPo, firstSku, firstRfq].filter(Boolean).map((link) => ({
      type: link.entityType,
      id: link.entityId,
      label: link.entityLabel || link.label,
      summary: link.label,
    })),
  }]
}
function impact(area, explanation, severity = 'warning', affectedObjects = []) {
  return { area, impact: '需复核', severity, explanation: text(explanation), affectedObjects: cleanList(affectedObjects) }
}
function matchId(message = '', prefix = '') {
  const pattern = new RegExp(`\\b${prefix}-[A-Z0-9-]+\\b`, 'i')
  return text(message).match(pattern)?.[0] || ''
}
function firstById(rows = [], id = '', keys = []) {
  const wanted = text(id).toLowerCase()
  if (!wanted) return null
  return asArray(rows).find((row) => keys.some((key) => text(row?.[key]).toLowerCase() === wanted)) || null
}
function firstWithValue(rows = [], keys = [], pattern = /./) {
  return asArray(rows).find((row) => keys.some((key) => pattern.test(text(row?.[key])))) || null
}
function sourceRows(ctx) {
  const db = ctx.db || {}
  const purchaseOrders = asArray(db.purchaseOrders)
  const products = asArray(db.products)
  const rfqs = asArray(db.rfqs)
  const receivingDocs = asArray(db.receivingDocs)
  const supplierInvoices = asArray(db.supplierInvoices)
  const purchaseRequests = asArray(db.purchaseRequests)
  const suppliers = asArray(db.suppliers)
  const salesOrders = asArray(ctx.salesDemand?.orders)
  return { purchaseOrders, products, rfqs, receivingDocs, supplierInvoices, purchaseRequests, suppliers, salesOrders }
}
function importantObjects(ctx, request = {}) {
  const rows = sourceRows(ctx)
  const message = request.message || ''
  const poId = matchId(message, 'PO') || (text(request.focusTarget?.entityType).includes('purchase') ? text(request.focusTarget?.entityId) : '')
  const skuId = matchId(message, 'SKU') || (text(request.focusTarget?.entityType).includes('inventory') ? text(request.focusTarget?.entityId) : '')
  const rfqId = matchId(message, 'RFQ')
  const soId = matchId(message, 'SO') || (text(request.focusTarget?.entityType).includes('sales') ? text(request.focusTarget?.entityId) : '')
  const po = firstById(rows.purchaseOrders, poId, ['po', 'id']) ||
    firstWithValue(rows.purchaseOrders, ['status', 'priority'], /部分到货|逾期|高|待审批|已发出/) ||
    rows.purchaseOrders[0]
  const sku = firstById(rows.products, skuId, ['sku', 'id', 'itemId']) ||
    firstWithValue(rows.products, ['stockoutRisk', 'riskLevel', 'status'], /高|不足|低库存/) ||
    rows.products[0]
  const rfq = firstById(rows.rfqs, rfqId, ['id', 'rfq']) ||
    firstWithValue(rows.rfqs, ['status'], /进行中|待回复|比价/) ||
    rows.rfqs[0]
  const so = firstById(rows.salesOrders, soId, ['salesOrderId', 'id']) ||
    firstWithValue(rows.salesOrders, ['deliveryRiskLevel', 'status'], /high|risk|高|shortage/) ||
    rows.salesOrders[0]
  const grn = firstById(rows.receivingDocs, text(po?.po || po?.id), ['po', 'poId', 'relatedPo']) ||
    rows.receivingDocs[0]
  const invoice = firstById(rows.supplierInvoices, text(po?.po || po?.id), ['relatedPo', 'po', 'poId']) ||
    rows.supplierInvoices[0]
  const pr = firstById(rows.purchaseRequests, text(sku?.sku || sku?.id), ['sourceSku', 'sku', 'itemId']) ||
    rows.purchaseRequests[0]
  return { po, sku, rfq, so, grn, invoice, pr }
}
function poEvidence(po = {}, extras = {}) {
  const poId = text(po.po || po.id || extras.poId)
  if (!poId) return null
  const ordered = number(po.items || po.totalOrderedQty || po.quantityOrdered)
  const received = number(po.received || po.totalReceivedQty || po.quantityReceived)
  const remain = Math.max(ordered - received, 0)
  return evidence({
    id: poId,
    moduleId: 'procurement:orders',
    entityType: 'purchase_order',
    entityId: poId,
    entityLabel: poId,
    evidenceLabel: '采购订单证据',
    summary: `${poId} ${text(po.status, '待复核')}，供应商 ${text(po.supplier, extras.supplier || '待确认')}，ETA ${text(po.eta || po.promisedDate || po.requiredDate, '待确认')}，PO Line 订购 ${ordered}，已收 ${received}，未收数量 ${remain}。未到货明细和供应商剩余交期需人工复核。打开 ${poId} 查看来源证据。`,
    severity: /逾期|异常|部分|待审批/.test(text(po.status)) ? 'warning' : 'info',
  })
}
function skuEvidence(sku = {}, extras = {}) {
  const skuId = text(sku.sku || sku.id || sku.itemId || extras.sku)
  if (!skuId) return null
  return evidence({
    id: skuId,
    moduleId: 'inventory',
    entityType: 'inventory_item',
    entityId: skuId,
    entityLabel: skuId,
    evidenceLabel: 'SKU 库存风险',
    summary: `${skuId} ${text(sku.name || sku.itemName, '物料')}，现有 ${number(sku.currentStock ?? sku.qty ?? sku.availableQuantity)}，安全库存 ${number(sku.safetyStock ?? sku.min ?? sku.reorderPoint)}，库存风险 ${text(sku.stockoutRisk || sku.riskLevel || sku.status, '需复核')}。可承诺量 / ATP 与库存分配需结合已预留、在途采购和销售需求复核。关联客户订单 ${text(extras.salesOrderId, '待复核')}，关联采购 ${text(extras.poId, '待复核')}。`,
    severity: /高|不足|低库存/.test(text(sku.stockoutRisk || sku.riskLevel || sku.status)) ? 'risk' : 'warning',
  })
}
function rfqEvidence(rfq = {}, extras = {}) {
  const rfqId = text(rfq.id || rfq.rfq || extras.rfqId)
  if (!rfqId) return null
  return evidence({
    id: rfqId,
    moduleId: 'procurement:rfq',
    entityType: 'rfq',
    entityId: rfqId,
    entityLabel: rfqId,
    evidenceLabel: 'RFQ 回复证据',
    summary: `${rfqId} ${text(rfq.title, '询价')}，状态 ${text(rfq.status, '待复核')}，供应商 ${number(rfq.suppliers)} 家，已回复 ${number(rfq.quoted)} 家，关联 PR ${text(rfq.sourceRequest, extras.prId || '待复核')}，关联 PO ${text(rfq.linkedPo, extras.poId || '待复核')}。打开 ${rfqId} 查看来源证据。`,
    severity: number(rfq.quoted) < number(rfq.suppliers) ? 'warning' : 'info',
  })
}
function grnEvidence(grn = {}) {
  const grnId = text(grn.grn || grn.id)
  if (!grnId) return null
  return evidence({
    id: grnId,
    moduleId: 'procurement:receiving',
    entityType: 'receiving_doc',
    entityId: grnId,
    entityLabel: grnId,
    evidenceLabel: 'GRN / 收货记录',
    summary: `${grnId} 关联 ${text(grn.po || grn.poId, 'PO 待确认')}，GRN Line 已收 ${number(grn.items)}，合格 ${number(grn.passed)}，异常 ${number(grn.failed)}，状态 ${text(grn.status, '待复核')}。`,
    severity: /异常|拒收|待质检/.test(text(grn.status)) || number(grn.failed) > 0 ? 'warning' : 'info',
  })
}
function receivingIssueEvidence(row = {}) {
  const grnId = text(row.grn || row.grnId || row.id || row.receivingId)
  const poId = text(row.po || row.poId || row.relatedPo)
  const status = text(row.status || row.receivingStatus, '待复核')
  const receivedQty = number(row.items ?? row.receivedQuantity ?? row.receivedQty)
  const acceptedQty = number(row.passed ?? row.acceptedQty)
  const exceptionQty = number(row.failed ?? row.rejectedQty)
  const pendingQty = Math.max(0, number(row.expectedQty ?? row.orderedQuantity ?? row.items, receivedQty) - acceptedQty)
  return evidence({
    id: grnId || poId || 'receiving-issue',
    moduleId: 'procurement:receiving',
    entityType: 'receiving_doc',
    entityId: grnId || poId,
    entityLabel: grnId || poId || '收货事项',
    evidenceLabel: '收货异常',
    summary: `${grnId || '收货单待确认'} 关联 ${poId || 'PO 待确认'}，供应商 ${text(row.supplier || row.supplierName, '待确认')}，状态 ${status}，已收 ${receivedQty}，合格 ${acceptedQty}，异常 ${exceptionQty}，待确认 ${pendingQty}。可能影响库存可用量、PO 履约、发票匹配和财务协同。`,
    severity: /异常|质检|待收货|部分|未收/.test(status) || exceptionQty > 0 ? 'risk' : 'warning',
  })
}
function receivingIssueEvidenceRows(ctx = {}) {
  const rows = sourceRows(ctx)
  const receiving = asArray(rows.receivingDocs)
    .filter((row) => /待收货|质检|异常|部分|未收|处理中/.test(text(row.status || row.receivingStatus)) || number(row.failed ?? row.rejectedQty) > 0)
    .slice(0, 5)
    .map(receivingIssueEvidence)
    .filter(Boolean)
  const poReceiving = asArray(rows.purchaseOrders)
    .filter((row) => /未收货|部分收货|部分到货|待收货|逾期|已审批|已发出|待审批/.test(text(row.receivingStatus || row.status)))
    .slice(0, Math.max(0, 5 - receiving.length))
    .map((po) => poEvidence(po, { poId: text(po.po || po.id) }))
    .filter(Boolean)
  return uniqueBy([...receiving, ...poReceiving], (item) => `${item.entityType}:${item.entityId}`).slice(0, 5)
}
function invoiceEvidence(invoice = {}) {
  const invoiceId = text(invoice.invoiceNumber || invoice.invoiceId || invoice.id)
  if (!invoiceId) return null
  return evidence({
    id: invoiceId,
    moduleId: 'finance',
    entityType: 'supplier_invoice',
    entityId: invoiceId,
    entityLabel: invoiceId,
    evidenceLabel: 'Invoice Line / 已收未票与差异',
    summary: `${invoiceId} 已收未票：关联 ${text(invoice.relatedPo || invoice.poId, 'PO 待确认')}，GRN ${text(invoice.relatedGrn || invoice.grnId, '待确认')}，匹配状态 ${text(invoice.matchStatus || invoice.status, '待复核')}，未开票数量需人工复核，已收未票金额 ${number(invoice.varianceAmount)}，数量差异、单价差异、金额差异需生成差异说明草稿，仅人工复核。PO Line、GRN Line、Invoice Line 需人工复核，不形成会计分录。`,
    severity: number(invoice.varianceAmount) ? 'risk' : 'warning',
  })
}
function syntheticInvoiceEvidence(objects = {}) {
  const poId = text(objects.po?.po || objects.po?.id || 'PO 待确认')
  const grnId = text(objects.grn?.grn || objects.grn?.id || 'GRN 待确认')
  if (!poId && !grnId) return null
  return evidence({
    id: `RNI-${poId || grnId}`,
    moduleId: 'finance',
    entityType: 'supplier_invoice',
    entityId: `RNI-${poId || grnId}`,
    entityLabel: '已收未票',
    evidenceLabel: 'Invoice Line / 已收未票与差异',
    summary: `已收未票：PO Line ${poId} 与 GRN Line ${grnId} 已读取，Invoice Line 待补齐，未开票数量和已收未票金额需人工复核，数量差异、单价差异、金额差异需生成差异说明草稿，仅人工复核，不形成会计分录。`,
    severity: 'warning',
  })
}
function salesOrderEvidence(order = {}) {
  const soId = text(order.salesOrderId || order.id)
  if (!soId) return null
  return evidence({
    id: soId,
    moduleId: 'sales',
    entityType: 'customer_order',
    entityId: soId,
    entityLabel: soId,
    evidenceLabel: '客户订单交付风险',
    summary: `${soId} ${text(order.customerName, '客户')}，SKU ${text(order.sku, '待确认')}，订单 ${number(order.orderedQty)}，已预留 ${number(order.reservedQty)}，缺口 ${number(order.shortageQty)}，承诺日期 ${text(order.promisedDate, '待确认')}。关联采购 ${cleanList(order.linkedPurchaseOrders).join('、') || '待复核'}。`,
    severity: /high|高|risk|shortage/.test(text(order.deliveryRiskLevel || order.status)) ? 'risk' : 'warning',
  })
}
function objectEvidenceForIntent(intent, ctx, request) {
  const objects = importantObjects(ctx, request)
  if (intent.id === 'po_priority' && /哪些.*PO|PO.*跟进/.test(text(request.message))) {
    return sourceRows(ctx).purchaseOrders
      .slice(0, 3)
      .map((po) => poEvidence(po))
      .filter(Boolean)
  }
  const poId = text(objects.po?.po || objects.po?.id)
  const skuId = text(objects.sku?.sku || objects.sku?.id)
  const rfqId = text(objects.rfq?.id || objects.rfq?.rfq)
  const soId = text(objects.so?.salesOrderId || objects.so?.id || '')
  const common = [
    poEvidence(objects.po, { poId }),
    skuEvidence(objects.sku, { sku: skuId, poId, salesOrderId: soId }),
    rfqEvidence(objects.rfq, { rfqId, poId, prId: text(objects.pr?.pr || objects.pr?.id) }),
  ].filter(Boolean)
  if (['today_attention', 'po_priority', 'related_objects'].includes(intent.id)) {
    return [...common, grnEvidence(objects.grn), invoiceEvidence(objects.invoice), salesOrderEvidence(objects.so)].filter(Boolean).slice(0, 6)
  }
  if (intent.id === 'inventory_risk') return [skuEvidence(objects.sku, { sku: skuId, poId, salesOrderId: soId }), salesOrderEvidence(objects.so), poEvidence(objects.po, { poId }), grnEvidence(objects.grn)].filter(Boolean).slice(0, 5)
  if (intent.id === 'sales_delivery_risk') return [salesOrderEvidence(objects.so), skuEvidence(objects.sku, { sku: skuId, poId, salesOrderId: soId }), poEvidence(objects.po, { poId }), grnEvidence(objects.grn)].filter(Boolean).slice(0, 5)
  if (intent.id === 'supplier_risk') return [poEvidence(objects.po, { poId }), rfqEvidence(objects.rfq, { rfqId, poId }), grnEvidence(objects.grn), invoiceEvidence(objects.invoice)].filter(Boolean).slice(0, 5)
  if (intent.id === 'receiving_exception') return receivingIssueEvidenceRows(ctx)
  if (intent.id === 'unreceived_orders') return [poEvidence(objects.po, { poId }), grnEvidence(objects.grn)].filter(Boolean)
  if (['received_not_invoiced', 'three_way_match_variance'].includes(intent.id)) return [invoiceEvidence(objects.invoice) || syntheticInvoiceEvidence(objects), poEvidence(objects.po, { poId }), grnEvidence(objects.grn)].filter(Boolean)
  if (intent.id === 'collaboration_review') return [rfqEvidence(objects.rfq, { rfqId, poId }), poEvidence(objects.po, { poId })].filter(Boolean)
  return []
}
function requestedCoreChainEntity(request = {}) {
  const message = text(request.message)
  const id = matchId(message, 'SO') || matchId(message, 'SKU') || matchId(message, 'PO') || matchId(message, 'GRN') || matchId(message, 'INV') || text(request.focusTarget?.entityId)
  const entityType = /SO-/i.test(id) || /销售需求|客户订单/.test(message)
    ? 'customer_order'
    : /SKU-/i.test(id) || /SKU|库存/.test(message)
      ? 'inventory_item'
      : /GRN-/i.test(id) || /收货|GRN/.test(message)
        ? 'receiving_doc'
        : /INV-/i.test(id) || /发票/.test(message)
          ? 'supplier_invoice'
          : /PO-/i.test(id) || /PO|采购订单/.test(message)
            ? 'purchase_order'
            : text(request.focusTarget?.entityType)
  return { entityType, entityId: id }
}
function coreChainForRequest(ctx = {}, request = {}) {
  const wanted = requestedCoreChainEntity(request)
  const found = findBusinessChainByEntityV1(ctx.coreBusinessChain, wanted)
  return sanitizeCoreBusinessChainForAiV1(found || asArray(ctx.coreBusinessChain?.chains)[0] || {})
}
function coreChainEvidenceForIntent(ctx = {}, request = {}) {
  const chain = coreChainForRequest(ctx, request)
  const rows = asArray(chain.summary)
  const question = text(request.message)
  const filtered = /证据不足|哪里.*不足|数据限制/.test(question)
    ? [...rows, ...asArray(chain.dataLimitations).map((item, index) => ({
      id: `chain-limitation-${index + 1}`,
      moduleId: 'overview',
      entityType: 'business_risk',
      entityId: item.label,
      entityLabel: item.label,
      evidenceLabel: '链路证据不足',
      evidenceSummary: `${item.description} ${text(item.consequence)}`,
      severity: 'warning',
    }))]
    : /人工复核草稿|复核草稿|打开.*草稿/.test(question)
      ? [...rows, ...asArray(chain.reviewDraftSuggestions).map((item, index) => ({
        id: `chain-review-draft-${index + 1}`,
        moduleId: 'review-actions',
        entityType: item.targetEntityType || 'action_draft',
        entityId: item.targetEntityId || item.title,
        entityLabel: item.title,
        evidenceLabel: '人工复核草稿',
        evidenceSummary: item.description,
        severity: 'warning',
      }))]
      : rows
  return filtered.map((item) => evidence({
    id: item.id,
    moduleId: item.moduleId,
    entityType: item.entityType,
    entityId: item.entityId,
    entityLabel: item.entityLabel,
    evidenceLabel: item.evidenceLabel,
    summary: item.evidenceSummary,
    severity: item.severity,
  })).filter(Boolean).slice(0, 8)
}
function evidenceForIntent(intent, ctx, request) {
  const common = [
    evidence({ id: 'ai-runtime-current-scope', moduleId: request.activeModuleId || 'overview', entityLabel: DATA_SCOPE, evidenceLabel: '当前上下文', summary: `当前上下文：${moduleLabel(request.activeModuleId || 'overview')}。今日重点、未收货订单、已收未票、发票差异和供应商风险需结合来源证据复核。` }),
  ]
  if (intent.id === 'unsafe_request') {
    return [
      evidence({ id: 'safety-boundary', moduleId: 'review-actions', entityLabel: '人工复核边界', evidenceLabel: '安全边界', summary: '该请求涉及正式业务处理或技术信息，已转为安全复核建议。', severity: 'risk' }),
      evidence({ id: 'review-policy', moduleId: 'review-actions', entityLabel: '草稿预览', evidenceLabel: '复核优先', summary: SAFETY_BOUNDARIES.join('、'), severity: 'warning' }),
    ]
  }
  if (intent.id === 'po_clarification') {
    const candidates = cleanList(intent.candidates)
    return candidates.map((poId) => evidence({
      id: poId,
      moduleId: 'procurement:orders',
      entityType: 'purchase_order',
      entityId: poId,
      entityLabel: poId,
      evidenceLabel: 'PO 选择确认',
      summary: `需要确认是 ${candidates.join(' 还是 ')}。请先选择来源对象，再生成后续复核说明。`,
      severity: 'warning',
    }))
  }
  if (intent.id === 'po_overdue_sop') return [
    evidence({
      id: 'SOP-PO-OVERDUE',
      moduleId: 'procurement:orders',
      entityType: 'purchase_order',
      entityId: text(importantObjects(ctx, request).po?.po || importantObjects(ctx, request).po?.id),
      entityLabel: 'SOP-PO-OVERDUE',
      evidenceLabel: '逾期 PO 跟进',
      summary: 'SOP-PO-OVERDUE 内部处理建议：先核对 ETA、未到货明细、收货异常和供应商剩余交期；不得自动形成正式业务处理，只能进入逾期 PO 跟进复核草稿。',
      severity: 'warning',
    }),
    ...objectEvidenceForIntent({ id: 'po_priority' }, ctx, request).slice(0, 3),
  ]
  if (intent.id === 'receiving_exception') return [
    ...receivingIssueEvidenceRows(ctx),
    evidence({ id: 'receiving-impact-inventory', moduleId: 'inventory', entityLabel: '库存可用量', evidenceLabel: '库存影响', summary: '收货异常会影响可用量、可承诺量和库存风险判断，需结合 PO 与 GRN 来源证据人工复核。', severity: 'warning' }),
    evidence({ id: 'receiving-impact-finance', moduleId: 'finance', entityLabel: '发票匹配', evidenceLabel: '发票匹配影响', summary: '收货数量、质检结果或异常数量不完整时，可能影响发票匹配与财务协同，只进入复核说明。', severity: 'warning' }),
  ]
  if (intent.id === 'core_business_chain') return [
    ...coreChainEvidenceForIntent(ctx, request),
    evidence({ id: 'core-chain-summary', moduleId: 'overview', entityLabel: '核心业务链', evidenceLabel: '主链闭环', summary: `已串联 ${number(ctx.coreBusinessChain?.summary?.chainCount)} 条销售、库存、采购、收货、发票和财务协同链路，证据不足 ${number(ctx.coreBusinessChain?.summary?.invoiceGapCount)} 项。`, severity: number(ctx.coreBusinessChain?.summary?.invoiceGapCount) ? 'warning' : 'info' }),
  ]
  if (intent.id === 'supplier_risk') return [
    ...objectEvidenceForIntent(intent, ctx, request),
    ...sourceRows(ctx).suppliers.slice(0, 3).map((supplier) => evidence({
      id: text(supplier.id || supplier.code || supplier.name),
      moduleId: 'srm',
      entityType: 'supplier',
      entityId: text(supplier.id || supplier.code),
      entityLabel: text(supplier.name || supplier.code || supplier.id),
      evidenceLabel: '供应商业务记录',
      summary: `${text(supplier.name || supplier.code || supplier.id)}，状态 ${text(supplier.status, '待复核')}，风险 ${text(supplier.riskLevel || supplier.risk, '待复核')}。`,
      severity: /high|高/.test(text(supplier.riskLevel || supplier.risk)) ? 'risk' : 'warning',
    })),
    evidence({ id: 'supplier-risk', moduleId: 'srm', entityType: 'supplier', entityLabel: '供应商运营档案 / 供应商风险', evidenceLabel: '风险信号', summary: `供应商运营档案风险信号：供应商观察项 ${number(ctx.reports.summary?.supplierRiskCount)} 项，涉及 PO / RFQ / Invoice 证据，供应商沟通草稿 ${number(ctx.collaboration.summary?.supplierDraftCount)} 条。`, severity: 'warning' }),
    evidence({ id: 'supplier-drafts', moduleId: 'collaboration-drafts', entityLabel: '供应商沟通草稿', evidenceLabel: '协同草稿', summary: `协同草稿 ${number(ctx.collaboration.summary?.totalDraftCount)} 条。` }),
  ]
  if (intent.id === 'inventory_risk') return [
    ...objectEvidenceForIntent(intent, ctx, request),
    evidence({ id: 'inventory-risk', moduleId: 'inventory', entityType: 'inventory_item', entityLabel: 'SKU / Inventory', evidenceLabel: '库存风险证据', summary: `库存观察项 ${number(ctx.reports.summary?.inventoryRiskCount)} 项，库存复核说明 ${number(ctx.collaboration.summary?.inventoryDraftCount)} 条。`, severity: 'warning' }),
    evidence({ id: 'inventory-actions', moduleId: 'review-actions', entityLabel: '库存复核草稿', evidenceLabel: '行动草稿', summary: `行动草稿 ${number(ctx.review.summary?.totalDraftCount)} 条。` }),
  ]
  if (intent.id === 'sales_delivery_risk') return [
    ...objectEvidenceForIntent(intent, ctx, request),
    evidence({ id: 'sales-demand-risk', moduleId: 'sales', entityType: 'customer_order', entityLabel: '客户订单交付风险', evidenceLabel: '销售需求证据', summary: `客户订单交付风险 ${number(ctx.salesDemand.summary?.riskOrderCount)} 项，库存缺口 ${number(ctx.salesDemand.summary?.shortageQty)}。`, severity: 'risk' }),
  ]
  if (intent.id === 'pilot_blockers') return [
    evidence({ id: 'pilot-readiness', moduleId: 'pilot-readiness', entityLabel: '试点准备度', evidenceLabel: '准备度阻塞项', summary: `阻塞项 ${number(ctx.pilot.summary?.blockedItemCount)} 项，观察项 ${number(ctx.pilot.summary?.observationItemCount)} 项。`, severity: 'risk' }),
    evidence({ id: 'pilot-drafts', moduleId: 'pilot-readiness', entityLabel: '试点复核草稿', evidenceLabel: '复核草稿', summary: `试点复核草稿 ${number(ctx.pilot.summary?.pilotDraftCount)} 条。` }),
  ]
  if (intent.id === 'data_incomplete') return [
    evidence({ id: 'data-quality', moduleId: 'imports', entityLabel: '数据接入与质量 / 数据质量事项', evidenceLabel: '数据依据', summary: `数据质量事项：阻塞项 ${number(ctx.data.summary?.criticalIssueCount)} 项，需复核 ${number(ctx.data.summary?.warningIssueCount)} 项，证据缺口 ${number(ctx.data.summary?.evidenceGapCount)} 项。`, severity: 'risk' }),
    evidence({ id: 'data-boundary', moduleId: 'settings:boundaries', entityLabel: '数据边界', evidenceLabel: '工作区边界', summary: `边界信号 ${number(ctx.boundary.summary?.dataQualityBoundaryIssueCount)} 项。` }),
  ]
  if (intent.id === 'collaboration_review') return [
    ...objectEvidenceForIntent(intent, ctx, request),
    evidence({ id: 'collaboration-drafts', moduleId: 'collaboration-drafts', entityLabel: '协同通知草稿', evidenceLabel: '协同复核', summary: `协同草稿 ${number(ctx.collaboration.summary?.totalDraftCount)} 条，等待人工复核 ${number(ctx.collaboration.summary?.readyForReviewCount)} 条。`, severity: 'warning' }),
    evidence({ id: 'collaboration-policy', moduleId: 'settings', entityLabel: '协同草稿策略', evidenceLabel: '策略边界', summary: '草稿预览、人工复核、不外发。' }),
  ]
  if (intent.id === 'role_boundary_limits') return [
    evidence({ id: 'role-permission', moduleId: 'settings:roles', entityLabel: '角色权限可见性', evidenceLabel: '角色权限限制', summary: `业务角色 ${number(ctx.roles.summary?.roleCount)} 个，权限复核草稿 ${number(ctx.roles.summary?.permissionDraftCount)} 条。`, severity: 'warning' }),
    evidence({ id: 'workspace-boundary', moduleId: 'settings:boundaries', entityLabel: '工作区边界', evidenceLabel: '边界限制', summary: `边界范围 ${number(ctx.boundary.summary?.boundaryScopeCount)} 个。` }),
  ]
  if (intent.id === 'audit_history_recent') return [
    evidence({ id: 'audit-history', moduleId: 'audit-history', entityLabel: '业务审计与历史', evidenceLabel: '最近历史', summary: `历史记录 ${number(ctx.audit.summary?.totalHistoryCount)} 条，待人工复核 ${number(ctx.audit.summary?.reviewRequiredCount)} 条。` }),
    evidence({ id: 'audit-objects', moduleId: 'audit-history', entityLabel: '业务对象历史', evidenceLabel: '业务对象', summary: `业务对象历史 ${number(ctx.audit.summary?.businessObjectHistoryCount)} 项。` }),
  ]
  if (intent.id === 'ai_draft_suggestions') return [
    evidence({ id: 'ai-suggestions', moduleId: 'overview:ai', entityLabel: 'AI 建议', evidenceLabel: 'AI 建议草稿', summary: `AI 建议 ${number(ctx.ai.summary?.totalSuggestionCount)} 条，草稿预览 ${number(ctx.ai.summary?.draftAvailableCount)} 条。` }),
    evidence({ id: 'review-drafts', moduleId: 'review-actions', entityLabel: '行动草稿', evidenceLabel: '人工复核', summary: `行动草稿 ${number(ctx.review.summary?.totalDraftCount)} 条。` }),
  ]
  if (['unreceived_orders', 'received_not_invoiced', 'three_way_match_variance', 'po_priority'].includes(intent.id)) return [
    ...objectEvidenceForIntent(intent, ctx, request),
    evidence({ id: 'procurement-evidence', moduleId: 'procurement', entityLabel: '采购管理', evidenceLabel: '采购证据', summary: `PO ${number(ctx.reports.summary?.totalPoCount)} 个，GRN ${number(ctx.reports.summary?.totalGrnCount)} 个，Invoice ${number(ctx.reports.summary?.totalInvoiceCount)} 个，匹配差异 ${number(ctx.reports.summary?.matchVarianceCount)} 项。`, severity: intent.id === 'three_way_match_variance' ? 'risk' : 'warning' }),
    evidence({ id: 'reports-procurement', moduleId: 'reports', entityLabel: '报表与分析', evidenceLabel: 'P2P 证据', summary: '采购、收货、发票和三单匹配证据来自当前工作区。' }),
  ]
  if (intent.id === 'related_objects') return [
    ...objectEvidenceForIntent(intent, ctx, request),
    evidence({ id: 'related-objects', moduleId: 'audit-history', entityLabel: '相关对象', evidenceLabel: '对象关系', summary: `业务对象历史 ${number(ctx.audit.summary?.businessObjectHistoryCount)} 项，边界对象 ${number(ctx.boundary.summary?.documentBoundaryCount)} 项。` }),
    evidence({ id: 'source-module', moduleId: request.activeModuleId || 'overview', entityLabel: moduleLabel(request.activeModuleId || 'overview'), evidenceLabel: '当前对象上下文', summary: '从当前上下文和审计历史回看相关对象。' }),
  ]
  return [
    ...common,
    ...objectEvidenceForIntent(intent, ctx, request),
    evidence({ id: 'today-attention', moduleId: 'overview', entityLabel: '今日行动', evidenceLabel: '今日重点', summary: `今日开放事项 ${number(ctx.tower.summary?.totalOpenItems)} 项，草稿预览 ${number(ctx.tower.summary?.draftAvailableCount)} 项。`, severity: 'warning' }),
    evidence({ id: 'ai-suggestions-current', moduleId: 'overview:ai', entityLabel: 'AI 建议', evidenceLabel: 'AI 建议', summary: `AI 建议 ${number(ctx.ai.summary?.totalSuggestionCount)} 条，数据限制 ${number(ctx.ai.summary?.dataLimitedCount)} 项。` }),
  ]
}
function linksForEvidence(items) {
  return uniqueBy(
    items
      .filter((item) => item.entityType !== 'customer_order')
      .flatMap((item) => item.navigationLinks || [nav(`查看${item.entityLabel}`, item.moduleId, item.entityType, item.entityId, item.entityLabel)]),
    (link) => `${link.moduleId}:${link.entityId}:${link.label}`,
  ).slice(0, 7)
}
function conclusionFor(intent, realEvidence) {
  if (intent.id === 'unsafe_request') return {
    title: '无法执行该请求，已转为安全复核建议',
    summary: '该请求涉及正式业务处理、外部触达、数据变更或技术信息披露。AI 助手只基于当前工作区证据给出说明、草稿预览和人工复核入口。',
    severity: 'risk',
    confidence: realEvidence.length >= 2 ? 'high' : realEvidence.length ? 'medium' : 'low',
  }
  if (!realEvidence.length) return {
    title: `${intent.label}：当前没有可核验业务记录`,
    summary: '当前工作区没有可核验的供应商、SKU、采购订单或关联业务记录。可以创建或导入数据，或在本地显式加载演示场景。',
    severity: 'warning',
    confidence: 'low',
  }
  return {
    title: `${intent.label}：需要结合证据复核`,
    summary: `已基于 ${realEvidence.length} 组可核验业务证据组织回答，建议先查看证据、数据限制和人工复核入口。`,
    severity: realEvidence.some((item) => item.severity === 'risk') ? 'risk' : 'warning',
    confidence: realEvidence.length >= 2 ? 'high' : 'medium',
  }
}
function buildResponse({ request, intent, ctx, modeNotice = '', conversationGrounding = null, resolvedContext = null }) {
  const allEvidence = classifyEvidence(evidenceForIntent(intent, ctx, request), ctx)
  const ev = allEvidence.filter((item) => ['business_fact', 'database_aggregate'].includes(item.evidenceType))
  const contextCards = allEvidence.filter((item) => !['business_fact', 'database_aggregate'].includes(item.evidenceType))
  const links = linksForEvidence(ev)
  const draftConversationGrounding = {
    ...(conversationGrounding || {}),
    entityRefs: [
      ...asArray(conversationGrounding?.entityRefs),
      ...ev.filter((item) => item.entityId).map((item) => ({
        entityType: item.entityType,
        entityId: item.entityId,
        entityLabel: item.entityLabel,
        moduleId: item.moduleId,
        source: 'currentEvidence',
        confidence: 'high',
      })),
    ],
  }
  const extraLimitations = modeNotice ? [{ label: '外部辅助模式未启用', description: modeNotice, severity: 'warning', consequence: '已使用当前工作区证据辅助回答。' }] : []
  const contextualDraft = buildContextualReviewCardsV2({
    request,
    intent,
    contextBundle: { evidenceRefs: ev, navigationRefs: links },
    resolvedContext,
    conversationGrounding: draftConversationGrounding,
    // Information, diagnosis and navigation answers must lead to the real
    // business object. A review card is only produced for an explicit draft
    // request by the contextual draft classifier.
    baseReviewCards: [],
  })
  const limitations = collectLimitations(ctx, [...extraLimitations, ...conversationLimitations(resolvedContext || {}), ...contextualDraft.dataLimitations])
  const conclusion = conclusionFor(intent, ev)
  const responseId = `AIR-${Date.now()}-${Math.abs(request.message.length * 17)}`
  const base = {
    version: 'v2',
    responseId,
    query: request.message,
    intent: intent.id,
    runtimeModeLabel: '证据辅助回答 · 当前工作区数据 · 复核优先',
    scope: {
      module: request.activeModuleId || 'overview',
      entityType: text(request.focusTarget?.entityType),
      entityId: text(request.focusTarget?.entityId),
      dataScopeLabel: DATA_SCOPE,
    },
    conclusion,
    keyEvidence: ev,
    contextCards,
    realEvidenceCount: ev.length,
    contextCardCount: contextCards.length,
    limitationCount: limitations.length,
    businessImpact: [
      impact('采购', '影响采购优先级、到货节奏和草稿复核顺序。', conclusion.severity, ev.map((item) => item.entityLabel)),
      impact('库存', '库存风险和数据限制需要与来源证据一起复核。', 'warning'),
      impact('供应商', '供应商跟进只生成草稿预览或内部复核说明。', 'warning'),
      impact('财务', '发票、差异和资金相关事项只进入人工复核说明。', 'warning'),
      impact('数据质量', '字段映射和证据缺口会影响回答可信度。', limitations.length ? 'warning' : 'info'),
      impact('试点准备度', '准备度阻塞项和观察项可从治理中心回看。', 'info'),
    ],
    recommendedActions: recommendedActions(links, intent.id === 'unsafe_request'),
    navigationLinks: links,
    dataLimitations: limitations,
    reviewCards: contextualDraft.draftRequest.isDraftRequest
      ? (contextualDraft.selectedTarget && !contextualDraft.ambiguous ? contextualDraft.reviewCards : [])
      : [],
    safetyBoundaries: SAFETY_BOUNDARIES,
    followUpQuestions: ['查看数据限制', '进入人工复核', '打开相关模块'],
    contextBreadcrumbs: conversationGrounding ? buildContextBreadcrumbsV2(conversationGrounding, resolvedContext || {}) : [],
    followUpSuggestions: conversationGrounding ? buildFollowUpSuggestionsV2({ intent: intent.id }, conversationGrounding) : [],
    resolvedContext: resolvedContext || {
      resolvedFrom: 'currentMessage',
      entityRefs: [],
      intentCarryOver: intent.id,
      confidence: 'low',
    },
    sourceSummary: sourceSummary(ctx),
    readinessSignals: readinessSignals(ctx),
    generatedAt: GENERATED_AT,
    dataScopeLabel: DATA_SCOPE,
  }
  return base
}

export const localEvidenceResponder = {
  id: 'local-evidence-responder',
  mode: 'local',
  isEnabled() { return true },
  buildPromptPackage(contextBundle, request) { return { contextBundle, request, policy: SAFETY_BOUNDARIES } },
  generateResponse(promptPackage) {
    return buildResponse({
      request: promptPackage.request,
      intent: promptPackage.contextBundle.requestIntent,
      ctx: promptPackage.contextBundle.sources,
      conversationGrounding: promptPackage.contextBundle.conversationGrounding,
      resolvedContext: promptPackage.contextBundle.resolvedContext,
    })
  },
  normalizeResponse(rawResponse) { return rawResponse },
}

export const providerAssistedPlaceholder = {
  id: 'provider-assisted-placeholder',
  mode: 'provider_assisted',
  isEnabled(env = {}) { return env.FLOWCHAIN_AI_RUNTIME_MODE === 'provider_assisted' },
  buildPromptPackage(contextBundle, request) { return { contextBundle, request, policy: SAFETY_BOUNDARIES } },
  generateResponse(promptPackage) {
    return buildResponse({
      request: promptPackage.request,
      intent: promptPackage.contextBundle.requestIntent,
      ctx: promptPackage.contextBundle.sources,
      conversationGrounding: promptPackage.contextBundle.conversationGrounding,
      resolvedContext: promptPackage.contextBundle.resolvedContext,
      modeNotice: '外部辅助模式未启用，已使用当前工作区证据辅助回答。',
    })
  },
  normalizeResponse(rawResponse) { return rawResponse },
}

function buildContextBundle(request, ctx, intent, conversationGrounding = null, resolvedContext = null) {
  return {
    requestIntent: intent,
    activeContext: {
      activeModuleId: request.activeModuleId || 'overview',
      activeViewId: request.activeViewId || '',
      focusTarget: request.focusTarget || null,
    },
    evidenceSources: sourceSummary(ctx),
    supportedEntityTypes: cleanList(ctx.pilot.pilotScope?.includedBusinessObjects, ['PR', 'RFQ', 'PO', 'GRN', 'Invoice', 'Supplier', 'SKU']),
    riskSignals: cleanList(asArray(ctx.pilot.riskAndBlockerItems).map((item) => item.itemLabel), ['数据限制', '人工复核']),
    dataQualitySignals: cleanList(asArray(ctx.data.qualityIssues).map((item) => item.title), ['数据质量事项']),
    reviewDraftSignals: cleanList(asArray(ctx.review.drafts).map((item) => item.title), ['行动草稿']),
    collaborationDraftSignals: cleanList(asArray(ctx.collaboration.drafts).map((item) => item.title), ['协同通知草稿']),
    governanceSignals: cleanList(asArray(ctx.pilot.governanceReadiness).map((item) => item.governanceLabel), ['治理准备度']),
    auditHistorySignals: cleanList(asArray(ctx.audit.timeline).map((item) => item.title), ['业务审计与历史']),
    pilotReadinessSignals: cleanList(asArray(ctx.pilot.riskAndBlockerItems).map((item) => item.itemLabel), ['试点准备度']),
    navigationIndex: sourceSummary(ctx).flatMap((item) => item.navigationLinks || []),
    dataLimitations: collectLimitations(ctx),
    safetyPolicy: SAFETY_BOUNDARIES,
    conversationGrounding: conversationGrounding ? boundedConversationSummaryV2(conversationGrounding, resolvedContext || {}) : null,
    resolvedContext: resolvedContext || null,
    sources: ctx,
  }
}
function activeAdapter(env = {}) {
  return providerAssistedPlaceholder.isEnabled(env) ? providerAssistedPlaceholder : localEvidenceResponder
}
function localRuntimeDraft(contextBundle, request) {
  const promptPackage = localEvidenceResponder.buildPromptPackage(contextBundle, request)
  return localEvidenceResponder.normalizeResponse(buildResponse({
    request,
    intent: contextBundle.requestIntent,
    ctx: contextBundle.sources,
    conversationGrounding: contextBundle.conversationGrounding,
    resolvedContext: contextBundle.resolvedContext,
  }), contextBundle)
}
function providerModeLimitation(env = {}) {
  if (!isProviderAssistedRequested(env)) return []
  if (canCallConfiguredProvider(env)) return []
  return [{ label: '外部辅助模式未启用', description: '当前默认使用证据辅助回答。', severity: 'warning', consequence: '已使用当前工作区证据辅助回答。' }]
}

export function buildAiRuntimeSafeFallbackV2(request = {}, reasonLabel = '当前工作区证据暂不完整') {
  const safeRequest = normalizeRequest(request)
  const message = safeRequest.message || '当前问题'
  const primaryModule = safeRequest.activeModuleId || 'overview'
  const responseId = `AIR-SAFE-${Date.now()}-${Math.abs(message.length * 19)}`
  const keyEvidence = [
    evidence({
      id: 'safe-local-current-scope',
      moduleId: primaryModule,
      entityLabel: moduleLabel(primaryModule),
      evidenceLabel: '当前工作区数据',
      summary: `${moduleLabel(primaryModule)} 的部分来源证据暂时未完整读取，仍可先查看今日行动、库存管理、收货记录和人工复核入口。`,
      severity: 'warning',
    }),
    evidence({
      id: 'safe-local-review-boundary',
      moduleId: 'review-actions',
      entityLabel: '人工复核',
      evidenceLabel: '人工复核边界',
      summary: '当前回答只提供来源证据查看、草稿预览和人工复核入口，不形成正式业务处理。',
      severity: 'warning',
    }),
  ]
  const links = [
    nav('打开今日行动', 'overview'),
    nav('打开库存管理', 'inventory'),
    nav('打开收货记录', 'procurement:receiving'),
    nav('打开人工复核', 'review-actions'),
  ]
  return {
    version: 'v2',
    responseId,
    query: message,
    intent: 'safe_local_evidence',
    runtimeModeLabel: '证据辅助回答 · 当前工作区数据 · 复核优先',
    scope: {
      module: primaryModule,
      entityType: text(safeRequest.focusTarget?.entityType),
      entityId: text(safeRequest.focusTarget?.entityId),
      dataScopeLabel: DATA_SCOPE,
    },
    conclusion: {
      title: '当前没有可核验业务记录',
      summary: '当前工作区没有可核验的供应商、SKU、采购订单或关联业务记录。已保留系统说明和操作入口。',
      severity: 'warning',
      confidence: 'low',
    },
    keyEvidence: [],
    contextCards: keyEvidence,
    realEvidenceCount: 0,
    contextCardCount: keyEvidence.length,
    limitationCount: 1,
    businessImpact: [
      impact('采购', '采购优先级和到货节奏需要结合来源证据人工复核。', 'warning'),
      impact('库存', '库存可用量和可承诺量需从库存管理继续核对。', 'warning'),
      impact('财务', '发票匹配和财务协同只进入人工复核说明。', 'warning'),
      impact('数据质量', '部分来源证据暂不完整，会影响回答可信度。', 'warning'),
    ],
    recommendedActions: recommendedActions(links),
    navigationLinks: links,
    dataLimitations: [cleanLimitation({ label: reasonLabel, description: '部分来源证据暂时未完整读取，已保留可用模块入口。', severity: 'warning', consequence: '请打开来源模块核对后再继续处理。' })],
    reviewCards: [],
    safetyBoundaries: SAFETY_BOUNDARIES,
    followUpQuestions: ['查看数据限制', '进入人工复核', '打开相关模块'],
    contextBreadcrumbs: [],
    followUpSuggestions: [],
    resolvedContext: {
      resolvedFrom: 'safeLocalEvidence',
      entityRefs: [],
      intentCarryOver: 'today_attention',
      confidence: 'low',
    },
    sourceSummary: [
      { sourceId: 'safe-local-context', sourceLabel: '系统说明与操作入口', signalCount: keyEvidence.length, navigationLinks: links.slice(0, 1) },
    ],
    readinessSignals: [
      { signalLabel: '可核验业务证据', statusLabel: DATA_SCOPE, signalCount: 0 },
      { signalLabel: '复核优先', statusLabel: '草稿预览和人工复核', signalCount: SAFETY_BOUNDARIES.length },
      { signalLabel: '数据限制', statusLabel: '集中展示', signalCount: 1 },
    ],
    generatedAt: GENERATED_AT,
    dataScopeLabel: DATA_SCOPE,
  }
}

export function buildAiRuntimeReadinessV2(db = {}, env = {}) {
  const ctx = buildContexts(db, { message: 'readiness' })
  const config = providerRuntimeConfig(env)
  const requested = isProviderAssistedRequested(env)
  const callable = canCallConfiguredProvider(env)
  const dataLimitations = collectLimitations(ctx, providerModeLimitation(env))
  return {
    summary: {
      availableSourceCount: sourceSummary(ctx).length,
      evidenceDomainCount: 12,
      reviewBoundaryCount: SAFETY_BOUNDARIES.length,
      supportedIntentCount: SUPPORTED_INTENTS.length,
      runtimeReadyLabel: '证据辅助回答可用',
      providerModeLabel: requested && callable ? '外部辅助模式已启用' : '外部辅助模式未启用',
      dataLimitedCount: dataLimitations.length,
    },
    supportedIntents: SUPPORTED_INTENTS.map(([id, label]) => ({ id, intentLabel: text(label), supportedLabel: '可基于当前工作区证据回答' })),
    evidenceSources: sourceSummary(ctx),
    reviewBoundaries: SAFETY_BOUNDARIES.map((label, index) => ({ id: `review-boundary-${index + 1}`, boundaryLabel: label, visibilityLabel: '复核优先' })),
    providerContract: {
      modeLabel: requested && callable ? '外部辅助模式可用，但回答仍受当前工作区证据约束' : '当前默认使用证据辅助回答',
      externalAssistanceLabel: requested && callable ? '外部辅助模式已启用' : '外部辅助模式未启用',
      responseBoundaryLabel: '外部辅助模式即使启用，也只能生成回复和草稿预览',
      executionBoundaryLabel: '不会执行正式业务动作',
    },
    runtimeHealth: {
      adapterLabel: config.mode === 'provider_assisted' && callable ? '已使用当前工作区证据辅助回答' : '当前工作区数据',
      configHealthLabel: callable || !requested ? '证据辅助回答可用' : '外部辅助模式未启用',
    },
    dataLimitations,
    generatedAt: GENERATED_AT,
    dataScopeLabel: DATA_SCOPE,
  }
}

export function buildAiRuntimeResponseV2(db = {}, body = {}, options = {}) {
  const validation = validateAiRuntimeRequest(body)
  if (!validation.ok) return { status: validation.status, body: { error: validation.error, dataScopeLabel: DATA_SCOPE } }
  try {
    const initialRequest = validation.request
    const conversationGrounding = buildConversationGroundingV2({ request: initialRequest, previousContext: initialRequest.conversationContext, activeContext: { focusTarget: initialRequest.focusTarget } })
    const resolvedContext = resolveFollowUpReferenceV2({ message: initialRequest.message, conversationGrounding })
    const request = enrichRequestWithResolvedContext(initialRequest, resolvedContext)
    const detectedIntent = detectIntent(request)
    const ctx = buildContexts(db, { ...request, coreBusinessChainRequested: detectedIntent.id === 'core_business_chain' }, options)
    const intent = intentWithConversationCarryOver(detectedIntent, request, resolvedContext)
    const contextBundle = buildContextBundle(request, ctx, intent, conversationGrounding, resolvedContext)
    const adapter = activeAdapter(options.env || process.env || {})
    const promptPackage = adapter.buildPromptPackage(contextBundle, request)
    const raw = adapter.generateResponse(promptPackage)
    return { status: 200, body: adapter.normalizeResponse(raw, contextBundle) }
  } catch {
    return { status: 200, body: buildAiRuntimeSafeFallbackV2(validation.request, '当前工作区证据暂不完整') }
  }
}

export async function buildAiRuntimeResponseV2Async(db = {}, body = {}, options = {}) {
  const validation = validateAiRuntimeRequest(body)
  if (!validation.ok) return { status: validation.status, body: { error: validation.error, dataScopeLabel: DATA_SCOPE } }
  try {
    const initialRequest = validation.request
    const conversationGrounding = buildConversationGroundingV2({ request: initialRequest, previousContext: initialRequest.conversationContext, activeContext: { focusTarget: initialRequest.focusTarget } })
    const resolvedContext = resolveFollowUpReferenceV2({ message: initialRequest.message, conversationGrounding })
    const request = enrichRequestWithResolvedContext(initialRequest, resolvedContext)
    const detectedIntent = detectIntent(request)
    const ctx = buildContexts(db, { ...request, coreBusinessChainRequested: detectedIntent.id === 'core_business_chain' }, options)
    const intent = intentWithConversationCarryOver(detectedIntent, request, resolvedContext)
    const contextBundle = buildContextBundle(request, ctx, intent, conversationGrounding, resolvedContext)
    const env = options.env || process.env || {}
    const localDraft = localRuntimeDraft(contextBundle, request)
    const localValidation = validateAiRuntimeResponseV2(localDraft, contextBundle, localDraft)
    const safeLocalDraft = localValidation.ok ? localDraft : buildResponse({ request, intent, ctx })

    if (!isProviderAssistedRequested(env)) return { status: 200, body: safeLocalDraft }
    const providerAdapter = selectProviderAdapter(env)
    if (!providerAdapter || !canCallConfiguredProvider(env)) {
      return { status: 200, body: fallbackResponse(safeLocalDraft, 'not_configured') }
    }

    const providerInput = providerAdapter.buildProviderInput
      ? providerAdapter.buildProviderInput(contextBundle, request, safeLocalDraft)
      : buildProviderInputPackageV2(contextBundle, request, safeLocalDraft)
    const providerResult = await callConfiguredProvider(providerInput, env, options.fetchImpl || globalThis.fetch)
    if (!providerResult.ok) {
      return { status: 200, body: fallbackResponse(safeLocalDraft, providerResult.reason) }
    }
    const normalized = normalizeProviderOutputCompat(providerResult.rawOutput, contextBundle, safeLocalDraft)
    const validationResult = validateAiRuntimeResponseV2(normalized, contextBundle, safeLocalDraft)
    if (!validationResult.ok) {
      return { status: 200, body: fallbackResponse(safeLocalDraft, validationResult.reason) }
    }
    return { status: 200, body: normalized }
  } catch {
    return { status: 200, body: buildAiRuntimeSafeFallbackV2(validation.request, '当前工作区证据暂不完整') }
  }
}
