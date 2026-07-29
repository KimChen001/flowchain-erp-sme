const DATA_SCOPE = '当前工作区数据'
const MAX_TEXT = 180
const TECHNICAL_PATTERN = /JSON|dry-run|tenantId|userId|datasetId|writesDb|writesFiles|DB|database|schema|environment|tool_result|provider|model|endpoint|token|API key|API|fallback|deterministic|mock|fake|demo|UAT|sample data|demo data|response_card|entityType|documentType|raw enum|payload|webhook|Coupa|RBAC|production|deploy|go-live|system prompt|prompt package|OpenAI|DeepSeek|Doubao|豆包/i
const ACTION_PATTERN = /自动批准|自动下单|正式创建\s*PO|下发\s*PO|发送\s*PO|发布\s*RFQ|邀请供应商|发送邮件|发送|推送|已发送|提交收货|Receive Submit|Submit Receipt|库存过账|Post Invoice|Approve Invoice|Mark as Paid|Payment execution|Export to Accounting|付款|会计过账|修改供应商主数据|更新银行账户|发布风险评级|自动黑名单|自动暂停供应商|自动修复|自动提交导入|自动覆盖数据|自动写入数据库|批量删除|清空数据|sent|delivered|dispatched|webhook|portal invite|保存配置|保存权限|保存边界|保存历史|保存准备度|修改权限|修改历史|修改准备度|删除历史|立即生效|自动应用|分配角色|创建用户|删除用户|禁用用户|创建租户|切换租户|合并租户|迁移数据|同步数据|跨租户查询|写入配置|写入日志|推送日志|导出审计报告|生成正式审计报告|发送审计报告|启用试点|开启试点|上线|部署|生成正式报告|导出正式报告|发送报告/i

const PROHIBITED_ACTIONS = [
  '不提交',
  '不外发',
  '不写库存',
  '不写财务凭证',
  '不处理资金',
  '不改主数据',
  '不覆盖当前工作区数据',
  '不形成正式业务处理',
]

function asArray(value) { return Array.isArray(value) ? value : [] }
function rawText(value, fallback = '') { return String(value ?? '').trim() || fallback }
function cleanText(value = '', fallback = '') {
  return rawText(value, fallback)
    .replace(new RegExp(ACTION_PATTERN.source, 'ig'), '正式业务处理')
    .replace(new RegExp(TECHNICAL_PATTERN.source, 'ig'), DATA_SCOPE)
    .slice(0, MAX_TEXT)
}
function confidenceRank(value = '') {
  if (value === 'high') return 3
  if (value === 'medium') return 2
  return 1
}
function normalizeConfidence(value = '') {
  return ['high', 'medium', 'low'].includes(value) ? value : 'medium'
}
function normalizeEntityType(value = '', label = '', id = '') {
  const raw = `${value} ${label} ${id}`
  if (/purchase_order|采购订单|\bPO\b|^PO-/i.test(raw)) return 'PO'
  if (/purchase_request|采购申请|\bPR\b|^PR-/i.test(raw)) return 'PR'
  if (/rfq|询价|报价|^RFQ-/i.test(raw)) return 'RFQ'
  if (/receiving|grn|收货|^GRN-/i.test(raw)) return 'GRN'
  if (/invoice|发票|三单匹配|差异|^INV-/i.test(raw)) return 'Invoice'
  if (/inventory|item|sku|物料|补货|^SKU-/i.test(raw)) return 'SKU'
  if (/supplier|供应商|供方/i.test(raw)) return 'Supplier'
  if (/risk|风险|缺口|不完整|补充/i.test(raw)) return 'Risk'
  if (/draft|草稿|review|复核/i.test(raw)) return 'ActionDraft'
  return 'Unknown'
}
function entityModule(type = '') {
  const map = {
    PO: 'procurement:orders',
    PR: 'procurement:requests',
    RFQ: 'procurement:rfq',
    GRN: 'procurement:receiving',
    Invoice: 'finance',
    Supplier: 'srm',
    SKU: 'inventory',
    Risk: 'overview',
    ActionDraft: 'review-actions',
  }
  return map[type] || 'overview'
}
function makeRef(input = {}, source = 'previousResponse') {
  const entityId = cleanText(input.entityId || input.id || input.targetEntityId)
  const entityLabel = cleanText(input.entityLabel || input.objectLabel || input.label || input.title || entityId, entityId || '业务对象')
  const entityType = normalizeEntityType(input.entityType || input.type || input.targetEntityType, entityLabel, entityId)
  return {
    entityType,
    entityId,
    entityLabel,
    moduleId: cleanText(input.moduleId || entityModule(entityType), entityModule(entityType)),
    source: cleanText(input.source || source, source),
    confidence: normalizeConfidence(input.confidence || (entityId ? 'high' : 'medium')),
  }
}
function compactEvidence(item = {}) {
  return {
    id: cleanText(item.id || item.entityId || item.label || item.entityLabel, '来源证据'),
    label: cleanText(item.label || item.entityLabel || item.summary || item.id, '来源证据'),
    type: normalizeEntityType(item.entityType || item.type, item.entityLabel || item.label, item.entityId || item.id),
    entityId: cleanText(item.entityId || item.id),
    entityLabel: cleanText(item.entityLabel || item.label || item.id, '来源证据'),
  }
}
function dedupeRefs(refs = []) {
  const seen = new Set()
  return refs
    .filter((ref) => ref?.entityLabel)
    .sort((a, b) => confidenceRank(b.confidence) - confidenceRank(a.confidence))
    .filter((ref) => {
      const key = `${ref.entityType}:${ref.entityId || ref.entityLabel}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
}
function requestedType(message = '') {
  const raw = rawText(message)
  if (/PO|采购订单/i.test(raw)) return 'PO'
  if (/供应商|supplier/i.test(raw)) return 'Supplier'
  if (/SKU|物料|item|补货|replenishment/i.test(raw)) return 'SKU'
  if (/发票|invoice|三单匹配|variance/i.test(raw)) return 'Invoice'
  if (/收货|GRN|receiving/i.test(raw)) return 'GRN'
  if (/数据|补充|不完整|incomplete/i.test(raw)) return 'Risk'
  return ''
}
function typeMatches(ref = {}, type = '') {
  if (!type) return true
  if (type === 'GRN') return ref.entityType === 'GRN' || ref.entityType === 'PO'
  if (type === 'Invoice') return ref.entityType === 'Invoice' || ref.entityType === 'PO'
  return ref.entityType === type
}
function draftIntentFromText(message = '') {
  const raw = rawText(message)
  if (/供应商|supplier|follow-up|followup|跟进/i.test(raw)) return 'supplier_follow_up'
  if (/SKU|物料|补货|replenishment|item/i.test(raw)) return 'sku_replenishment'
  if (/发票|invoice|三单匹配|差异|variance/i.test(raw)) return 'invoice_variance_review'
  if (/收货|GRN|receiving/i.test(raw)) return 'receiving_exception_review'
  if (/数据|补充|不完整|completion|incomplete/i.test(raw)) return 'data_completion_review'
  if (/PO|采购订单/i.test(raw)) return 'po_review'
  return 'generic_context_review'
}

export function detectContextualDraftRequestV2(message = '') {
  const raw = rawText(message)
  const textDraft = /(消息|邮件|备注|说明|跟进话术|供应商.*跟进|跟进.*供应商|message|email|note|memo|follow-up)/i.test(raw)
    && /(生成|起草|编辑|预览|草稿|write|draft|compose|preview)/i.test(raw)
  const structuredDraft = /(PR|采购申请|RFQ|询价|任务|补货|task|replenishment)/i.test(raw)
    && /(创建|新建|生成|预填|草稿|create|new|prefill|draft)/i.test(raw)
  const isDraftRequest = textDraft || structuredDraft
  if (!isDraftRequest) {
    return { isDraftRequest: false, draftIntent: 'generic_context_review', confidence: 'low', reasonLabel: '信息、诊断或导航请求不生成草稿' }
  }
  const draftIntent = draftIntentFromText(raw)
  const confidence = /人工复核|复核草稿|预览草稿|草稿预览|open review draft|preview draft|draft preview/i.test(raw) ? 'high' : 'medium'
  return {
    isDraftRequest: true,
    draftIntent,
    confidence,
    reasonLabel: '用户请求草稿预览与人工复核',
  }
}

export function selectDraftTargetFromResolvedContextV2(resolvedContext = {}, conversationGrounding = {}, message = '') {
  const carriedIntent = resolvedContext.intentCarryOver
    || conversationGrounding.previousIntent
    || conversationGrounding.context?.previousIntent
    || ''
  const wanted = requestedType(message)
    || (['po_priority', 'unreceived_orders', 'received_not_invoiced', 'three_way_match_variance'].includes(carriedIntent) ? 'PO' : '')
  const explicitlyResolved = dedupeRefs(asArray(resolvedContext.entityRefs).map((item) => makeRef(item, 'resolved')))
  const previousFocus = conversationGrounding.previousFocusTarget
    || conversationGrounding.context?.previousFocusTarget
    || null
  const refs = dedupeRefs([
    ...explicitlyResolved,
    conversationGrounding.activeRef ? makeRef(conversationGrounding.activeRef, 'activePage') : null,
    ...asArray(conversationGrounding.entityRefs).map((item) => makeRef(item, item.source || 'previousResponse')),
    previousFocus ? makeRef(previousFocus, 'previousResponse') : null,
    ...asArray(conversationGrounding.previousNavigationRefs).map((item) => makeRef(item, 'navigation')),
    ...asArray(conversationGrounding.previousEvidenceRefs).map((item) => makeRef(item, 'evidence')),
  ].filter(Boolean))
  const matched = refs.filter((ref) => typeMatches(ref, wanted))
  const candidates = matched.length ? matched : refs
  const target = candidates[0] || null
  const sameConfidence = target ? candidates.filter((ref) => confidenceRank(ref.confidence) === confidenceRank(target.confidence)) : []
  const ambiguous = Boolean(target && sameConfidence.length > 1 && !wanted && explicitlyResolved.length !== 1 && !previousFocus)
  return {
    target,
    candidates,
    requestedType: wanted,
    ambiguous,
    limitation: !target
      ? '当前上下文不足，需要先选择具体对象或打开来源证据。'
      : ambiguous
        ? '当前上下文包含多个相关对象，草稿预览前需要人工确认目标对象。'
        : '',
  }
}

export function inferContextualDraftTypeV2({ message = '', target = null, intent = {} } = {}) {
  const draftIntent = draftIntentFromText(message) || intent?.id
  const type = target?.entityType || requestedType(message)
  if (type === 'Supplier') {
    return { draftType: 'supplier_followup_draft', draftTitle: '供应商跟进草稿', allowedNextStep: '预览供应商跟进草稿' }
  }
  if (type === 'SKU') {
    return { draftType: 'purchase_request_draft', draftTitle: '库存补货复核草稿', allowedNextStep: '预览补货复核草稿' }
  }
  if (type === 'Invoice') {
    return { draftType: 'po_followup_draft', draftTitle: '发票差异复核草稿', allowedNextStep: '预览发票差异复核草稿' }
  }
  if (type === 'GRN') {
    return { draftType: 'po_followup_draft', draftTitle: '收货异常复核草稿', allowedNextStep: '预览收货异常复核草稿' }
  }
  if (type === 'PO') {
    return { draftType: 'po_followup_draft', draftTitle: '采购订单复核草稿', allowedNextStep: '进入人工复核' }
  }
  if (draftIntent === 'supplier_follow_up') return { draftType: 'supplier_followup_draft', draftTitle: '供应商跟进草稿', allowedNextStep: '预览供应商跟进草稿' }
  if (draftIntent === 'sku_replenishment') return { draftType: 'purchase_request_draft', draftTitle: '库存补货复核草稿', allowedNextStep: '预览补货复核草稿' }
  if (draftIntent === 'invoice_variance_review') return { draftType: 'po_followup_draft', draftTitle: '发票差异复核草稿', allowedNextStep: '预览发票差异复核草稿' }
  if (draftIntent === 'receiving_exception_review') return { draftType: 'po_followup_draft', draftTitle: '收货异常复核草稿', allowedNextStep: '预览收货异常复核草稿' }
  if (draftIntent === 'po_review') return { draftType: 'po_followup_draft', draftTitle: '采购订单复核草稿', allowedNextStep: '进入人工复核' }
  return { draftType: 'po_followup_draft', draftTitle: '业务上下文复核草稿', allowedNextStep: '选择对象后进入人工复核' }
}

export function sanitizeDraftPayloadV2(payload = {}) {
  const out = {}
  for (const [key, value] of Object.entries(payload || {})) {
    if (/full|history|response|provider|endpoint|token|key|secret|env|raw|package/i.test(key)) continue
    if (Array.isArray(value)) out[key] = value.map((item) => typeof item === 'string' ? cleanText(item) : item).slice(0, 5)
    else if (value && typeof value === 'object') out[key] = sanitizeDraftPayloadV2(value)
    else out[key] = typeof value === 'string' ? cleanText(value) : value
  }
  return out
}

function payloadForDraft({ draftType, target, draftTitle, message }) {
  const common = {
    source: 'ai_assistant',
    reviewOnly: true,
    previewOnly: true,
    requiresHumanReview: true,
    targetEntityLabel: target?.entityLabel || '',
    reason: `${draftTitle}：基于当前上下文整理证据、影响和数据限制。`,
    contextSummary: target?.entityLabel ? `当前对象：${target.entityLabel}` : '当前上下文需要先选择具体对象。',
    dataScopeLabel: DATA_SCOPE,
    blockedActions: [...PROHIBITED_ACTIONS],
  }
  if (draftType === 'supplier_followup_draft') {
    return sanitizeDraftPayloadV2({
      ...common,
      supplierIdOrName: target?.entityId || target?.entityLabel || '',
      message: '请复核供应商风险、关联单据和数据限制后，再决定后续跟进方式。',
    })
  }
  if (draftType === 'purchase_request_draft') {
    return sanitizeDraftPayloadV2({
      ...common,
      itemIdOrSku: target?.entityId || target?.entityLabel || '',
      quantity: 1,
      reason: `${draftTitle}：请人工复核库存风险、补货数量和供应来源。`,
    })
  }
  return sanitizeDraftPayloadV2({
    ...common,
    poId: target?.entityType === 'PO' ? target.entityId : '',
    relatedDocumentId: target?.entityId || '',
    message: '请复核来源证据、业务影响和数据限制后，再决定后续处理方式。',
    userText: cleanText(message),
  })
}

export function buildContextualActionDraftReviewCardV2({ message = '', intent = {}, target = null, evidenceRefs = [], navigationRefs = [] } = {}) {
  const inferred = inferContextualDraftTypeV2({ message, target, intent })
  const titlePrefix = target?.entityId ? `${target.entityId} ` : ''
  const descriptionTarget = target?.entityLabel || target?.entityId || '当前业务上下文'
  const originEvidence = asArray(evidenceRefs).map(compactEvidence).filter((item) => item.id || item.label).slice(0, 5)
  const navEvidence = originEvidence.length ? originEvidence : asArray(navigationRefs).map((item) => compactEvidence({
    id: item.entityId || item.label,
    label: item.entityLabel || item.label,
    entityType: item.entityType,
    entityId: item.entityId,
    entityLabel: item.entityLabel || item.label,
  })).slice(0, 5)
  const card = {
    title: cleanText(`${titlePrefix}${inferred.draftTitle}`, inferred.draftTitle),
    description: cleanText(`基于 ${descriptionTarget} 生成草稿预览，需人工复核，不形成正式业务处理。`),
    previewOnly: true,
    reviewRequired: true,
    requiresHumanReview: true,
    prohibitedActions: [...PROHIBITED_ACTIONS],
    allowedNextStep: inferred.allowedNextStep,
    targetModule: 'review-actions',
    targetEntityType: target?.entityType || '',
    targetEntityId: target?.entityId || '',
    draftType: inferred.draftType,
    draftTitle: inferred.draftTitle,
    payload: payloadForDraft({ draftType: inferred.draftType, target, draftTitle: inferred.draftTitle, message }),
    originEvidence: navEvidence,
  }
  return validateContextualReviewCardV2(card).ok ? card : null
}

export function buildContextualReviewCardsV2({ request = {}, intent = {}, contextBundle = {}, resolvedContext = {}, conversationGrounding = {}, baseReviewCards = [] } = {}) {
  const detection = detectContextualDraftRequestV2(request.message)
  if (!detection.isDraftRequest) return { reviewCards: asArray(baseReviewCards), dataLimitations: [], draftRequest: detection }
  const selection = selectDraftTargetFromResolvedContextV2(resolvedContext, conversationGrounding, request.message)
  const evidenceRefs = [
    ...asArray(contextBundle.evidenceRefs),
    ...asArray(conversationGrounding.evidenceRefs),
    ...asArray(conversationGrounding.previousEvidenceRefs),
  ]
  const navigationRefs = [
    ...asArray(contextBundle.navigationRefs),
    ...asArray(conversationGrounding.navigationRefs),
    ...asArray(conversationGrounding.previousNavigationRefs),
  ]
  const card = buildContextualActionDraftReviewCardV2({
    message: request.message,
    intent,
    target: selection.target,
    evidenceRefs,
    navigationRefs,
  }) || (selection.target ? buildContextualActionDraftReviewCardV2({
    message: request.message,
    intent,
    target: selection.target,
    navigationRefs: navigationRefs.slice(0, 1),
  }) : null)
  const dataLimitations = selection.limitation ? [{
    label: selection.target ? '草稿目标需人工确认' : '当前上下文不足',
    description: selection.limitation,
    severity: 'warning',
    consequence: '建议先打开来源证据或明确业务对象后再进入人工复核。',
  }] : []
  return {
    reviewCards: [card].filter(Boolean),
    dataLimitations,
    draftRequest: detection,
    selectedTarget: selection.target,
    ambiguous: selection.ambiguous,
  }
}

export function validateContextualReviewCardV2(card = {}) {
  const required = card.previewOnly === true
    && card.reviewRequired === true
    && card.requiresHumanReview === true
    && card.targetModule === 'review-actions'
    && Boolean(card.draftType)
    && Boolean(card.draftTitle)
    && Boolean(card.payload?.reviewOnly)
    && Boolean(card.payload?.previewOnly)
    && Boolean(card.payload?.requiresHumanReview)
  const evidenceBounded = asArray(card.originEvidence).length <= 5
  const visible = visibleText(card)
  const clean = !TECHNICAL_PATTERN.test(visible) && !ACTION_PATTERN.test(visible)
  return { ok: required && evidenceBounded && clean, required, evidenceBounded, clean }
}

function visibleText(value) {
  if (Array.isArray(value)) return value.map(visibleText).join(' ')
  if (!value || typeof value !== 'object') return String(value ?? '')
  return Object.entries(value)
    .filter(([key]) => !/^(id|entityId|targetEntityId|targetEntityType|source|draftType|payload|originEvidence|moduleId)$/i.test(key))
    .map(([, item]) => visibleText(item))
    .join(' ')
}

export const contextualDraftSafetyBoundariesV2 = Object.freeze([...PROHIBITED_ACTIONS])
