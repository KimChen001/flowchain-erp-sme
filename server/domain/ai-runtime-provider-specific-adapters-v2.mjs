const DATA_SCOPE = '当前工作区数据'
const DEFAULT_TIMEOUT_MS = 8000
const MAX_TIMEOUT_MS = 15000
const DEFAULT_MAX_OUTPUT_CHARS = 6000
const MAX_OUTPUT_CHARS = 12000

function asArray(value) { return Array.isArray(value) ? value : [] }
function text(value, fallback = '') { return String(value ?? '').trim() || fallback }
function clampNumber(value, fallback, max) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback
  return Math.min(parsed, max)
}
function compact(value, max = 1200) {
  return text(value).slice(0, max)
}
function providerConfig(env = {}) {
  return {
    mode: text(env.FLOWCHAIN_AI_RUNTIME_MODE || 'local'),
    kind: text(env.FLOWCHAIN_AI_PROVIDER_KIND || 'disabled'),
    endpoint: text(env.FLOWCHAIN_AI_PROVIDER_ENDPOINT),
    apiKey: text(env.FLOWCHAIN_AI_PROVIDER_API_KEY),
    model: text(env.FLOWCHAIN_AI_PROVIDER_MODEL),
    timeoutMs: clampNumber(env.FLOWCHAIN_AI_PROVIDER_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS),
    maxOutputChars: clampNumber(env.FLOWCHAIN_AI_PROVIDER_MAX_OUTPUT_CHARS, DEFAULT_MAX_OUTPUT_CHARS, MAX_OUTPUT_CHARS),
  }
}
function boundedEvidencePackage(input = {}) {
  const evidencePackage = input.evidencePackage || {}
  return {
    keyEvidence: asArray(evidencePackage.keyEvidence).slice(0, 12),
    sourceSummary: asArray(evidencePackage.sourceSummary).slice(0, 12),
    supportedEntityTypes: asArray(evidencePackage.supportedEntityTypes).slice(0, 20),
    dataLimitations: asArray(evidencePackage.dataLimitations).slice(0, 12),
    readinessSignals: asArray(evidencePackage.readinessSignals).slice(0, 12),
  }
}
function safeTask(input = {}) {
  const task = input.task || {}
  return {
    question: compact(task.question, 1200),
    intentLabel: compact(task.intentLabel, 160),
    answerLanguage: compact(task.answerLanguage || 'zh-CN', 20),
    outputRequirement: compact(task.outputRequirement, 600),
  }
}
function safePolicy(input = {}) {
  const policy = input.safetyPolicy || {}
  return {
    allowedActions: asArray(policy.allowedActions).slice(0, 12),
    forbiddenActions: asArray(policy.forbiddenActions).slice(0, 12),
    reviewRequired: policy.reviewRequired === true,
    previewOnly: policy.previewOnly === true,
    dataScopeLabel: compact(policy.dataScopeLabel || DATA_SCOPE, 40),
  }
}
function safeResponseShape(input = {}) {
  const shape = input.responseShape || {}
  return {
    conclusion: compact(shape.conclusion, 80),
    keyEvidence: compact(shape.keyEvidence, 120),
    businessImpact: compact(shape.businessImpact, 80),
    recommendedActions: asArray(shape.recommendedActions).slice(0, 12),
    navigationLinks: compact(shape.navigationLinks, 120),
    dataLimitations: compact(shape.dataLimitations, 80),
    reviewCards: compact(shape.reviewCards, 100),
    safetyBoundaries: asArray(shape.safetyBoundaries).slice(0, 12),
  }
}
function safeConversationGrounding(input = {}) {
  const grounding = input.conversationGrounding || {}
  if (!grounding || typeof grounding !== 'object') return null
  return {
    previousIntent: compact(grounding.previousIntent, 80),
    resolvedFrom: compact(grounding.resolvedFrom, 40),
    intentCarryOver: compact(grounding.intentCarryOver, 80),
    confidence: compact(grounding.confidence, 20),
    entityRefs: asArray(grounding.entityRefs).slice(0, 5).map((item) => ({
      entityType: compact(item.entityType, 40),
      entityId: compact(item.entityId, 80),
      entityLabel: compact(item.entityLabel, 120),
      source: compact(item.source, 40),
      confidence: compact(item.confidence, 20),
    })),
    evidenceRefs: asArray(grounding.evidenceRefs).slice(0, 5).map((item) => ({
      id: compact(item.id, 80),
      label: compact(item.label, 120),
      entityLabel: compact(item.entityLabel, 120),
    })),
    navigationRefs: asArray(grounding.navigationRefs).slice(0, 5).map((item) => ({
      label: compact(item.label, 120),
      moduleId: compact(item.moduleId, 80),
      entityLabel: compact(item.entityLabel, 120),
      returnTo: 'ai-assistant',
    })),
  }
}
export function buildBoundedProviderRequestCore(input = {}) {
  return {
    task: safeTask(input),
    evidencePackage: boundedEvidencePackage(input),
    safetyPolicy: safePolicy(input),
    responseShape: safeResponseShape(input),
    conversationGrounding: safeConversationGrounding(input),
  }
}
function instructionText() {
  return '只基于当前工作区证据回答；保留人工复核；不得形成正式业务处理；如证据不足说明数据限制。'
}
function chatMessages(input = {}) {
  const core = buildBoundedProviderRequestCore(input)
  return [
    { role: 'system', content: instructionText() },
    { role: 'user', content: JSON.stringify(core) },
  ]
}
function jsonHeaders(config) {
  return {
    'content-type': 'application/json',
    authorization: `Bearer ${config.apiKey}`,
  }
}
function extractString(value) {
  if (typeof value === 'string') return value
  if (!value || typeof value !== 'object') return ''
  return text(
    value.output_text ||
    value.output?.text ||
    value.message?.content ||
    value.choices?.[0]?.message?.content ||
    value.output?.[0]?.content?.[0]?.text ||
    value.output?.[0]?.content?.[0]?.content ||
    value.content ||
    value.text ||
    value.answer ||
    value.conclusion?.summary,
  )
}
export function extractCandidateFromProviderResponse(rawResponse) {
  const candidate = extractString(rawResponse)
  if (!candidate) return { ok: false, reason: 'malformed_output' }
  return { ok: true, rawOutput: { conclusion: { summary: candidate } } }
}
async function parseResponse(response, config) {
  if (!response.ok) return { ok: false, reason: 'non_success_status' }
  const contentType = response.headers?.get?.('content-type') || ''
  let raw
  if (/application\/json/i.test(contentType)) raw = await response.json()
  else if (/text\/plain|text\//i.test(contentType)) raw = await response.text()
  else return { ok: false, reason: 'invalid_content_type' }
  const serialized = typeof raw === 'string' ? raw : JSON.stringify(raw)
  if (serialized.length > config.maxOutputChars) return { ok: false, reason: 'output_too_long' }
  return extractCandidateFromProviderResponse(raw)
}
async function callSpecificAdapter(adapter, providerInputPackage, env = {}, fetchImpl = globalThis.fetch) {
  const config = providerConfig(env)
  if (!fetchImpl || !adapter.canCall(config)) return { ok: false, reason: 'not_configured' }
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs)
  try {
    const response = await fetchImpl(config.endpoint, {
      method: 'POST',
      headers: adapter.buildHeaders(config),
      body: JSON.stringify(adapter.buildRequestBody(providerInputPackage, config)),
      signal: controller.signal,
    })
    return await parseResponse(response, config)
  } catch (error) {
    return { ok: false, reason: error?.name === 'AbortError' ? 'timeout' : 'network_error' }
  } finally {
    clearTimeout(timeout)
  }
}
function canCallProvider(config = {}) {
  return config.mode === 'provider_assisted' && Boolean(config.endpoint) && Boolean(config.apiKey) && Boolean(config.model)
}
function createChatAdapter(kind, label) {
  return {
    kind,
    label,
    isEnabled(config) { return config.mode === 'provider_assisted' && config.kind === kind },
    canCall: canCallProvider,
    buildRequestBody(input, config) {
      return {
        model: config.model,
        messages: chatMessages(input),
        temperature: 0.2,
      }
    },
    buildHeaders: jsonHeaders,
    extractCandidateFromResponse: extractCandidateFromProviderResponse,
    call(providerInputPackage, env, fetchImpl) { return callSpecificAdapter(this, providerInputPackage, env, fetchImpl) },
  }
}
export const openaiResponsesAdapter = {
  kind: 'openai_responses',
  label: 'server-side response adapter',
  isEnabled(config) { return config.mode === 'provider_assisted' && config.kind === this.kind },
  canCall: canCallProvider,
  buildRequestBody(input, config) {
    return {
      model: config.model,
      input: [
        { role: 'system', content: [{ type: 'input_text', text: instructionText() }] },
        { role: 'user', content: [{ type: 'input_text', text: JSON.stringify(buildBoundedProviderRequestCore(input)) }] },
      ],
    }
  },
  buildHeaders: jsonHeaders,
  extractCandidateFromResponse: extractCandidateFromProviderResponse,
  call(providerInputPackage, env, fetchImpl) { return callSpecificAdapter(this, providerInputPackage, env, fetchImpl) },
}
export const deepseekChatAdapter = createChatAdapter('deepseek_chat', 'server-side chat adapter')
export const doubaoChatAdapter = createChatAdapter('doubao_chat', 'server-side chat adapter')

export const providerSpecificAdapters = [openaiResponsesAdapter, deepseekChatAdapter, doubaoChatAdapter]

export function selectProviderSpecificAdapter(kind = '') {
  return providerSpecificAdapters.find((adapter) => adapter.kind === kind) || null
}

export function isProviderSpecificKind(kind = '') {
  return Boolean(selectProviderSpecificAdapter(kind))
}

export function callProviderSpecificAdapter(providerInputPackage, env = {}, fetchImpl = globalThis.fetch) {
  const config = providerConfig(env)
  const adapter = selectProviderSpecificAdapter(config.kind)
  if (!adapter) return { ok: false, reason: 'not_configured' }
  return adapter.call(providerInputPackage, env, fetchImpl)
}
