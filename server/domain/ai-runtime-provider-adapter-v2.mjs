import {
  callProviderSpecificAdapter,
  isProviderSpecificKind,
  selectProviderSpecificAdapter,
} from './ai-runtime-provider-specific-adapters-v2.mjs'

const DATA_SCOPE = '当前工作区数据'
const DEFAULT_TIMEOUT_MS = 8000
const MAX_TIMEOUT_MS = 15000
const DEFAULT_MAX_OUTPUT_CHARS = 6000
const MAX_OUTPUT_CHARS = 12000
const REQUIRED_BOUNDARIES = ['草稿预览', '人工复核', '不形成正式业务处理', '不外发', '不写库存', '不写财务凭证', '不处理资金', '不改主数据', '不覆盖当前工作区数据']
const ALLOWED_ACTION_LABELS = ['查看证据', '预览草稿', '进入人工复核', '打开来源对象', '打开相关模块', '标记仅内部留存', '补充数据', '查看数据限制']

export const FORBIDDEN_AI_RUNTIME_PROVIDER_ACTION_PATTERN = /自动批准|自动下单|正式创建\s*PO|下发\s*PO|发送\s*PO|发布\s*RFQ|邀请供应商|发送邮件|发送|推送|已发送|提交收货|Receive Submit|Submit Receipt|库存过账|Post Invoice|Approve Invoice|Mark as Paid|Payment execution|Export to Accounting|付款|会计过账|修改供应商主数据|更新银行账户|发布风险评级|自动黑名单|自动暂停供应商|自动修复|自动提交导入|自动覆盖数据|自动写入数据库|批量删除|清空数据|sent|delivered|dispatched|webhook|portal invite|保存配置|保存权限|保存边界|保存历史|保存准备度|修改权限|修改历史|修改准备度|删除历史|立即生效|自动应用|分配角色|创建用户|删除用户|禁用用户|创建租户|切换租户|合并租户|迁移数据|同步数据|跨租户查询|写入配置|写入日志|推送日志|导出审计报告|生成正式审计报告|发送审计报告|启用试点|开启试点|上线|部署|生成正式报告|导出正式报告|发送报告/i
export const FORBIDDEN_AI_RUNTIME_PROVIDER_TECHNICAL_PATTERN = /JSON|dry-run|tenantId|userId|datasetId|writesDb|writesFiles|DB|database|schema|environment|tool_result|provider|model|endpoint|token|API key|API|fallback|deterministic|mock|fake|demo|UAT|sample data|demo data|response_card|entityType|documentType|raw enum|payload|webhook|Coupa|RBAC|production|deploy|go-live|system prompt|prompt package/i

function asArray(value) { return Array.isArray(value) ? value : [] }
function text(value, fallback = '') { return String(value ?? '').trim() || fallback }
function clampNumber(value, fallback, max) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback
  return Math.min(parsed, max)
}
function cleanText(value, fallback = '') {
  return text(value, fallback)
    .replace(FORBIDDEN_AI_RUNTIME_PROVIDER_ACTION_PATTERN, '正式业务处理')
    .replace(FORBIDDEN_AI_RUNTIME_PROVIDER_TECHNICAL_PATTERN, DATA_SCOPE)
}
function visibleText(value) {
  if (Array.isArray(value)) return value.map(visibleText).join(' ')
  if (!value || typeof value !== 'object') return String(value ?? '')
  return Object.entries(value)
    .filter(([key]) => !/^(id|sourceId|responseId|query|intent|entityType|entityId|moduleId|linkTarget|returnContext|returnTo|source|reason|draftType|payload|originEvidence|mode|providerContract)$/i.test(key))
    .map(([, item]) => visibleText(item))
    .join(' ')
}
function compactEvidence(item = {}) {
  return {
    id: text(item.id || item.entityId || item.entityLabel).slice(0, 80),
    sourceModule: cleanText(item.sourceModule || item.sourceLabel, DATA_SCOPE).slice(0, 80),
    objectLabel: cleanText(item.objectLabel || item.entityLabel || item.label, '来源证据').slice(0, 120),
    evidenceLabel: cleanText(item.evidenceLabel || item.label, '业务证据').slice(0, 120),
    summary: cleanText(item.evidenceSummary || item.summary || item.description, '当前工作区来源证据。').slice(0, 500),
    severity: cleanText(item.severity || item.status, 'info').slice(0, 24),
  }
}
function compactLink(link = {}) {
  return {
    label: cleanText(link.label, '查看来源证据').slice(0, 80),
    moduleId: text(link.moduleId || 'overview').slice(0, 80),
    entityId: text(link.entityId || '').slice(0, 80),
    entityLabel: cleanText(link.entityLabel || link.label, '来源证据').slice(0, 120),
    returnTo: 'ai-assistant',
  }
}
function compactLimitation(item = {}) {
  return {
    label: cleanText(item.label, '当前数据范围限制').slice(0, 80),
    description: cleanText(item.description || item.consequence, '需要结合来源证据人工复核。').slice(0, 260),
    severity: cleanText(item.severity, 'warning').slice(0, 24),
    consequence: cleanText(item.consequence, '建议查看来源证据后再进入人工复核。').slice(0, 260),
  }
}
function compactReviewDraft(item = {}) {
  return {
    title: cleanText(item.title || item.draftTitle, '草稿预览').slice(0, 120),
    draftTitle: cleanText(item.draftTitle || item.title, '草稿预览').slice(0, 120),
    targetLabel: cleanText(item.targetEntityId || item.targetEntityLabel || item.title, '业务对象').slice(0, 120),
    previewOnly: true,
    reviewRequired: true,
    requiresHumanReview: true,
  }
}
function uniqueBy(items = [], keyOf = (item) => item.label || item.id) {
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
function fallbackLimitation(reason = '外部辅助结果未采用') {
  return {
    label: '外部辅助结果未采用',
    description: '已使用当前工作区证据辅助回答，并保留人工复核边界。',
    severity: 'warning',
    consequence: '建议查看来源证据后再进入人工复核。',
    reasonCode: reason,
  }
}
function safeLimitationForResponse(item = {}) {
  const { reasonCode: _reasonCode, ...visible } = item
  return visible
}
function allowedEvidenceIds(contextBundle = {}, localDraftResponse = {}) {
  return new Set([
    ...asArray(localDraftResponse.keyEvidence).map((item) => text(item.id || item.entityId || item.entityLabel)),
    ...asArray(contextBundle.evidenceSources).map((item) => text(item.sourceId || item.sourceLabel)),
  ].filter(Boolean))
}
function hasForbiddenVisibleText(value) {
  const raw = visibleText(value)
  return FORBIDDEN_AI_RUNTIME_PROVIDER_ACTION_PATTERN.test(raw) || FORBIDDEN_AI_RUNTIME_PROVIDER_TECHNICAL_PATTERN.test(raw)
}
function parseProviderRaw(rawOutput) {
  if (typeof rawOutput === 'string') return { text: rawOutput }
  if (rawOutput && typeof rawOutput === 'object') return rawOutput
  return { text: '' }
}
function providerTextCandidate(raw = {}) {
  return text(raw.conclusion?.summary || raw.conclusion || raw.answer || raw.text || raw.message || raw.content)
}

export function providerRuntimeConfig(env = {}) {
  const mode = text(env.FLOWCHAIN_AI_RUNTIME_MODE || 'local')
  const kind = text(env.FLOWCHAIN_AI_PROVIDER_KIND || 'disabled')
  const endpoint = text(env.FLOWCHAIN_AI_PROVIDER_ENDPOINT)
  const apiKey = text(env.FLOWCHAIN_AI_PROVIDER_API_KEY)
  const model = text(env.FLOWCHAIN_AI_PROVIDER_MODEL)
  const timeoutMs = clampNumber(env.FLOWCHAIN_AI_PROVIDER_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS)
  const maxOutputChars = clampNumber(env.FLOWCHAIN_AI_PROVIDER_MAX_OUTPUT_CHARS, DEFAULT_MAX_OUTPUT_CHARS, MAX_OUTPUT_CHARS)
  return { mode, kind, endpoint, apiKey, model, timeoutMs, maxOutputChars }
}

export function isProviderAssistedRequested(env = {}) {
  return providerRuntimeConfig(env).mode === 'provider_assisted'
}

export function canCallGenericHttpProvider(env = {}) {
  const config = providerRuntimeConfig(env)
  return config.mode === 'provider_assisted' && config.kind === 'generic_http' && Boolean(config.endpoint) && Boolean(config.apiKey)
}
export function canCallConfiguredProvider(env = {}) {
  const config = providerRuntimeConfig(env)
  if (config.kind === 'generic_http') return canCallGenericHttpProvider(env)
  const adapter = selectProviderSpecificAdapter(config.kind)
  return Boolean(adapter?.canCall(config))
}

export function buildProviderInputPackageV2(contextBundle = {}, request = {}, localDraftResponse = {}) {
  const keyEvidence = asArray(localDraftResponse.keyEvidence).slice(0, 12).map(compactEvidence)
  const sourceSummary = asArray(localDraftResponse.sourceSummary).slice(0, 12).map((item) => ({
    sourceLabel: cleanText(item.sourceLabel, '来源证据').slice(0, 100),
    signalCount: Number(item.signalCount) || 0,
  }))
  const supportedEntityTypes = uniqueBy([
    ...asArray(contextBundle.supportedEntityTypes).map((label) => ({ label: cleanText(label).slice(0, 80) })),
    ...keyEvidence.map((item) => ({ label: cleanText(item.objectLabel).slice(0, 80) })),
  ], (item) => item.label).slice(0, 20)
  return {
    task: {
      question: cleanText(request.message).slice(0, 1200),
      intentLabel: cleanText(contextBundle.requestIntent?.label || localDraftResponse.conclusion?.title, '业务问题').slice(0, 120),
      answerLanguage: 'zh-CN',
      outputRequirement: '基于给定证据生成业务回复；不得执行正式业务动作；如证据不足必须说明数据限制。',
    },
    evidencePackage: {
      keyEvidence,
      sourceSummary,
      supportedEntityTypes,
      reviewDraftSummary: asArray(localDraftResponse.reviewCards).slice(0, 3).map(compactReviewDraft),
      dataLimitations: asArray(localDraftResponse.dataLimitations).slice(0, 12).map(compactLimitation),
      readinessSignals: asArray(localDraftResponse.readinessSignals).slice(0, 12).map((item) => ({
        signalLabel: cleanText(item.signalLabel).slice(0, 80),
        statusLabel: cleanText(item.statusLabel).slice(0, 80),
        signalCount: Number(item.signalCount) || 0,
      })),
    },
    safetyPolicy: {
      allowedActions: ALLOWED_ACTION_LABELS,
      forbiddenActions: ['正式业务处理', '外部触达动作', '资金或凭证处理', '库存或主数据变更'],
      reviewRequired: true,
      previewOnly: true,
      dataScopeLabel: DATA_SCOPE,
    },
    responseShape: {
      conclusion: '业务结论',
      keyEvidence: '只能引用给定关键证据',
      businessImpact: '业务影响',
      recommendedActions: ALLOWED_ACTION_LABELS,
      navigationLinks: '只能使用本地安全跳转',
      dataLimitations: '数据限制',
      reviewCards: '草稿预览与人工复核',
      safetyBoundaries: REQUIRED_BOUNDARIES,
    },
    conversationGrounding: contextBundle.conversationGrounding || null,
  }
}

export async function callGenericHttpProvider(providerInput, env = {}, fetchImpl = globalThis.fetch) {
  const config = providerRuntimeConfig(env)
  if (!fetchImpl || !canCallGenericHttpProvider(env)) {
    return { ok: false, reason: 'not_configured' }
  }
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs)
  try {
    const response = await fetchImpl(config.endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(providerInput),
      signal: controller.signal,
    })
    if (!response.ok) return { ok: false, reason: 'non_success_status' }
    const contentType = response.headers?.get?.('content-type') || ''
    let rawText = ''
    if (/application\/json/i.test(contentType)) {
      const parsed = await response.json()
      rawText = JSON.stringify(parsed)
    } else if (/text\/plain|text\//i.test(contentType)) {
      rawText = await response.text()
    } else {
      return { ok: false, reason: 'invalid_content_type' }
    }
    if (rawText.length > config.maxOutputChars) return { ok: false, reason: 'output_too_long' }
    let rawOutput = rawText
    if (/application\/json/i.test(contentType)) {
      try { rawOutput = JSON.parse(rawText) } catch { return { ok: false, reason: 'malformed_output' } }
    }
    return { ok: true, rawOutput }
  } catch (error) {
    return { ok: false, reason: error?.name === 'AbortError' ? 'timeout' : 'network_error' }
  } finally {
    clearTimeout(timeout)
  }
}

export function normalizeProviderOutput(rawOutput, contextBundle = {}, localDraftResponse = {}) {
  const raw = parseProviderRaw(rawOutput)
  const candidateText = providerTextCandidate(raw)
  if (!candidateText || hasForbiddenVisibleText(raw)) {
    return fallbackResponse(localDraftResponse, 'invalid_output')
  }
  const conclusion = {
    ...localDraftResponse.conclusion,
    title: cleanText(raw.conclusion?.title || localDraftResponse.conclusion?.title, localDraftResponse.conclusion?.title),
    summary: cleanText(candidateText, localDraftResponse.conclusion?.summary).slice(0, 700),
    confidence: cleanText(raw.conclusion?.confidence || localDraftResponse.conclusion?.confidence, 'medium'),
  }
  const normalized = {
    ...localDraftResponse,
    responseId: localDraftResponse.responseId,
    conclusion,
    keyEvidence: asArray(localDraftResponse.keyEvidence).slice(0, 12),
    businessImpact: asArray(localDraftResponse.businessImpact),
    recommendedActions: asArray(localDraftResponse.recommendedActions)
      .filter((item) => ALLOWED_ACTION_LABELS.includes(text(item.label)))
      .slice(0, 5),
    navigationLinks: asArray(localDraftResponse.navigationLinks).slice(0, 7).map((link) => ({ ...link, returnTo: 'ai-assistant' })),
    dataLimitations: uniqueBy([
      ...asArray(localDraftResponse.dataLimitations),
      ...asArray(raw.dataLimitations).map(compactLimitation),
    ].map(safeLimitationForResponse), (item) => item.label).slice(0, 10),
    reviewCards: asArray(localDraftResponse.reviewCards).map((card) => ({
      ...card,
      previewOnly: true,
      reviewRequired: true,
      requiresHumanReview: true,
    })),
    safetyBoundaries: uniqueBy([...REQUIRED_BOUNDARIES, ...asArray(localDraftResponse.safetyBoundaries).map(cleanText)], (item) => item).slice(0, 12),
    dataScopeLabel: DATA_SCOPE,
  }
  const validation = validateAiRuntimeResponseV2(normalized, contextBundle, localDraftResponse)
  return validation.ok ? normalized : fallbackResponse(localDraftResponse, validation.reason)
}

export function validateAiRuntimeResponseV2(response = {}, contextBundle = {}, localDraftResponse = {}) {
  if (response.version !== 'v2') return { ok: false, reason: 'version' }
  if (!text(response.conclusion?.title || response.conclusion?.summary)) return { ok: false, reason: 'conclusion' }
  const evidence = asArray(response.keyEvidence)
  if (!evidence.length && Number(response.realEvidenceCount) !== 0) return { ok: false, reason: 'evidence' }
  const allowedIds = allowedEvidenceIds(contextBundle, localDraftResponse)
  if (allowedIds.size && !evidence.every((item) => allowedIds.has(text(item.id || item.entityId || item.entityLabel)))) {
    return { ok: false, reason: 'evidence_grounding' }
  }
  if (asArray(response.recommendedActions).some((item) => !ALLOWED_ACTION_LABELS.includes(text(item.label)) || FORBIDDEN_AI_RUNTIME_PROVIDER_ACTION_PATTERN.test(visibleText(item)))) {
    return { ok: false, reason: 'actions' }
  }
  if (!asArray(response.navigationLinks).every((link) => link.returnTo === 'ai-assistant')) {
    return { ok: false, reason: 'navigation' }
  }
  if (!asArray(response.reviewCards).every((card) => card.previewOnly === true && card.reviewRequired === true && card.requiresHumanReview === true)) {
    return { ok: false, reason: 'review_cards' }
  }
  const boundaries = asArray(response.safetyBoundaries).map(text)
  if (!REQUIRED_BOUNDARIES.every((label) => boundaries.includes(label))) {
    return { ok: false, reason: 'safety_boundaries' }
  }
  if (response.dataScopeLabel !== DATA_SCOPE) return { ok: false, reason: 'data_scope' }
  if (hasForbiddenVisibleText(response)) return { ok: false, reason: 'visible_text' }
  return { ok: true, reason: '' }
}

export function fallbackResponse(localDraftResponse = {}, reason = 'not_used') {
  return {
    ...localDraftResponse,
    dataLimitations: uniqueBy([
      fallbackLimitation(reason),
      ...asArray(localDraftResponse.dataLimitations),
    ].map(safeLimitationForResponse), (item) => item.label).slice(0, 10),
    reviewCards: asArray(localDraftResponse.reviewCards).map((card) => ({
      ...card,
      previewOnly: true,
      reviewRequired: true,
      requiresHumanReview: true,
    })),
    navigationLinks: asArray(localDraftResponse.navigationLinks).map((link) => ({ ...link, returnTo: 'ai-assistant' })),
    safetyBoundaries: uniqueBy([...REQUIRED_BOUNDARIES, ...asArray(localDraftResponse.safetyBoundaries).map(cleanText)], (item) => item),
    dataScopeLabel: DATA_SCOPE,
  }
}

export const genericHttpProviderAdapter = {
  id: 'generic-http-provider-adapter-v2',
  mode: 'provider_assisted',
  isEnabled: isProviderAssistedRequested,
  canCall: canCallGenericHttpProvider,
  buildProviderInput: buildProviderInputPackageV2,
  callProvider: callGenericHttpProvider,
  normalizeProviderOutput,
  validateProviderOutput: validateAiRuntimeResponseV2,
  fallbackResponse,
}

export function selectProviderAdapter(envOrConfig = {}) {
  const config = envOrConfig.mode ? envOrConfig : providerRuntimeConfig(envOrConfig)
  if (config.kind === 'generic_http') return genericHttpProviderAdapter
  return selectProviderSpecificAdapter(config.kind)
}

export async function callConfiguredProvider(providerInput, env = {}, fetchImpl = globalThis.fetch) {
  const config = providerRuntimeConfig(env)
  if (config.kind === 'generic_http') return callGenericHttpProvider(providerInput, env, fetchImpl)
  if (isProviderSpecificKind(config.kind)) return callProviderSpecificAdapter(providerInput, env, fetchImpl)
  return { ok: false, reason: 'not_configured' }
}
