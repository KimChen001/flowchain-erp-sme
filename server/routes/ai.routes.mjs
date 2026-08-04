import { fetch as undiciFetch } from 'undici'
import { buildAiDraftPreparationResponse } from '../domain/ai-draft-preparation.mjs'
import { buildAiChatStatusResponse, normalizeAiChatMessage } from '../domain/ai-chat-status.mjs'
import { buildAiProcurementOperationalResponse } from '../domain/ai-procurement-operational-query.mjs'
import { buildAiRfqOperationalResponse } from '../domain/ai-rfq-operational-query.mjs'
import { buildAiSupplierOperationalResponse } from '../domain/ai-supplier-operational-query.mjs'
import { buildAiFinanceCollaborationResponse } from '../domain/ai-finance-collaboration-query.mjs'
import { buildAiMasterDataQualityResponse } from '../domain/ai-master-data-quality-query.mjs'
import { buildAiSalesDemandResponse } from '../domain/ai-sales-demand-query.mjs'
import { buildAiInventoryAllocationResponse } from '../domain/ai-inventory-allocation-query.mjs'
import { buildAiEvidenceGraphResponse } from '../domain/ai-evidence-graph-query.mjs'
import { buildAiResponseContractV2 } from '../domain/ai-response-contract-v2.mjs'
import { buildAiCockpitFastPathResponse, buildAiDataLimitationResponse, buildAiEvidenceReuseResponse } from '../domain/ai-evidence-reuse.mjs'
import { buildAiSessionGroundedResponse } from '../domain/ai-session-grounding.mjs'
import { buildAiCompoundQueryResponse, buildAiReceivingGapResponse, detectCompoundBusinessQuery } from '../domain/ai-compound-query.mjs'
import { getAiProviderSafetyState } from '../domain/ai-provider-safety.mjs'
import { buildAiReadContext } from '../domain/ai-read-context.mjs'
import { getAiToolRegistry } from '../domain/ai-tool-registry.mjs'
import { buildUnknownGuidedFallbackResponse, classifyAiBusinessIntent, isTechnicalProviderDiagnosticPrompt } from '../domain/ai-business-intent-router.mjs'
import { businessContextToReadDb, readBusinessContext } from '../services/runtime-business-read-service.mjs'
import { createAiHandlerRegistry, aiHandlersForPhase } from './ai-handler-registry.mjs'
import { dispatchAiHandlers } from './ai-dispatcher.mjs'
import { buildMrpPlan } from './mrp.routes.mjs'
import {
  ensureMarketPrices,
  ensureMarketSignals,
  fetchExternalSignals,
  marketPriceReply,
  normalizeMarketSignal,
} from './market.routes.mjs'

function localAiReply({ moduleId, question, activeInsight }, db, ctx) {
  const { ensurePurchaseRequests } = ctx
  const priceAnswer = marketPriceReply(question, db)
  if (priceAnswer) return priceAnswer
  const evidence = activeInsight?.title
    ? `当前系统关注「${activeInsight.title}」${activeInsight.metric ? `，核心指标是 ${activeInsight.metric}` : ''}。`
    : `当前模块是 ${moduleId || 'FlowChain 工作台'}。`
  const pending = db.purchaseOrders.filter((po) => po.status === '待审批').length
  const pendingRequests = ensurePurchaseRequests(db).filter((pr) => pr.status === '待审批').length
  const stockReceipts = db.receivingDocs.filter((doc) => doc.status === '质检中' || doc.status === '异常处理').length
  const latestPlan = (db.forecastPlans || []).find((plan) => plan.procurementSuggestion?.quantity > 0)
  const planNote = latestPlan
    ? `最近预测方案 ${latestPlan.id} 识别 ${latestPlan.sku} 最大净缺口，建议向 ${latestPlan.procurementSuggestion.supplier} 采购 ${Number(latestPlan.procurementSuggestion.quantity).toLocaleString()}${latestPlan.unit || ''}，预估金额 ${Number(latestPlan.procurementSuggestion.amount || 0).toLocaleString()} 元，优先级 ${latestPlan.procurementSuggestion.priority}。`
    : '当前还没有可执行的预测补货方案。'
  return `${evidence} 当前后端数据里有 ${db.purchaseOrders.length} 张采购订单，其中 ${pending} 张待审批；有 ${ensurePurchaseRequests(db).length} 张采购申请，其中 ${pendingRequests} 张待审批；有 ${db.receivingDocs.length} 张收货单，其中 ${stockReceipts} 张需要质检或异常跟进。${planNote} 建议先处理影响交付的待审批 PR/PO 和异常 GRN，再把预测净缺口转成采购申请。`
}

function aiConfidence(body, db, result = {}, ctx) {
  const { ensurePurchaseRequests, ensureInventoryMovements, supplierPerformance, supplierQuoteCount } = ctx
  const mrp = buildMrpPlan(db)
  const products = db.products || []
  const forecastPlans = db.forecastPlans || []
  const purchaseRequests = ensurePurchaseRequests(db)
  const inventoryMovements = ensureInventoryMovements(db)
  const supplierPerf = supplierPerformance(db)
  const q = String(body.question || '')
  const moduleId = String(body.moduleId || '')
  const externalSignalCount = Number(body.externalSignals?.signals?.length || 0)
  const poCount = db.purchaseOrders?.length || 0
  const grnCount = db.receivingDocs?.length || 0
  const quoteSkuCount = Number(supplierQuoteCount || 0)
  const levelOf = (score) => score >= 85 ? '高' : score >= 70 ? '中' : '低'
  const clampScore = (score) => Math.max(35, Math.min(96, Math.round(score)))
  const dimension = (key, label, rawScore, dimensionEvidence = [], dimensionWarnings = []) => {
    const score = clampScore(rawScore)
    return {
      key,
      label,
      score,
      level: levelOf(score),
      evidence: dimensionEvidence,
      warnings: dimensionWarnings,
    }
  }

  const forecastEvidence = []
  const forecastWarnings = []
  let forecastScore = 50
  if (products.length >= 6) {
    forecastScore += 8
    forecastEvidence.push(`${products.length} 个 SKU 基础资料`)
  } else {
    forecastScore -= 6
    forecastWarnings.push('SKU 覆盖偏少')
  }
  if (forecastPlans.length > 0) {
    forecastScore += 14
    forecastEvidence.push(`${forecastPlans.length} 个保存预测方案`)
  } else {
    forecastWarnings.push('没有已保存预测方案')
  }
  if (purchaseRequests.length > 0) {
    forecastScore += 4
    forecastEvidence.push(`${purchaseRequests.length} 张 PR 可追溯预测/补货动作`)
  }
  if (/预测|forecast|需求|销量|季节|区间/.test(q)) forecastScore += 5

  const inventoryEvidence = []
  const inventoryWarnings = []
  let inventoryScore = 52
  if (products.length >= 6) {
    inventoryScore += 8
    inventoryEvidence.push(`${products.length} 个 SKU 库存口径`)
  }
  if (mrp.summary.exceptionCount > 0) {
    inventoryScore += 14
    inventoryEvidence.push(`${mrp.summary.exceptionCount} 条 MRP 例外`)
  } else {
    inventoryWarnings.push('当前 MRP 未形成例外覆盖')
  }
  if (inventoryMovements.length > 0) {
    inventoryScore += 7
    inventoryEvidence.push(`${inventoryMovements.length} 条库存事务`)
  } else {
    inventoryWarnings.push('库存事务流水较少')
  }
  if (/库存|MRP|补货|断货|缺口|安全库存|ROP|批次|仓库/.test(q) || moduleId === 'inventory') inventoryScore += 5

  const supplierEvidence = []
  const supplierWarnings = []
  let supplierScore = 50
  if (supplierPerf.length >= 5) {
    supplierScore += 15
    supplierEvidence.push(`${supplierPerf.length} 个供应商绩效`)
  } else {
    supplierScore -= 4
    supplierWarnings.push('供应商绩效覆盖偏少')
  }
  if (grnCount >= 5) {
    supplierScore += 8
    supplierEvidence.push(`${grnCount} 张 GRN/质检记录`)
  }
  if (quoteSkuCount > 0) {
    supplierScore += 7
    supplierEvidence.push(`${quoteSkuCount} 个 SKU 报价候选`)
  } else {
    supplierWarnings.push('缺少报价候选')
  }
  if (poCount >= 8) {
    supplierScore += 5
    supplierEvidence.push(`${poCount} 张 PO`)
  }
  if (/供应商|报价|RFQ|交期|质检|合同|币种|产能/.test(q) || moduleId === 'purchasing') supplierScore += 5

  const externalEvidence = []
  const externalWarnings = []
  let externalScore = 48
  if (externalSignalCount > 0) {
    externalScore += 18
    externalEvidence.push(`${externalSignalCount} 条外部信号`)
  }
  if (result.provider === 'market-data') {
    externalScore += 20
    externalEvidence.push('命中内部行情记录')
  }
  if (/外部|新闻|汇率|市场|价格|风险|铁|钢|铝|铜|美元|原油/.test(q)) {
    externalScore += 4
    if (!externalSignalCount && result.provider !== 'market-data') {
      externalScore -= 12
      externalWarnings.push('缺少可用的外部信号')
    }
  } else if (!externalSignalCount && result.provider !== 'market-data') {
    externalWarnings.push('外部市场未参与本次判断')
  }

  const dimensions = [
    dimension('forecast', '预测', forecastScore, forecastEvidence, forecastWarnings),
    dimension('inventory', '库存/MRP', inventoryScore, inventoryEvidence, inventoryWarnings),
    dimension('supplier', '供应商', supplierScore, supplierEvidence, supplierWarnings),
    dimension('external', '外部市场', externalScore, externalEvidence, externalWarnings),
  ]

  if (result.provider === 'local') {
    dimensions.forEach((item) => {
      item.score = clampScore(item.score - 5)
      item.level = levelOf(item.score)
    })
  }
  if (result.degraded) {
    dimensions.forEach((item) => {
      item.score = clampScore(item.score - 7)
      item.level = levelOf(item.score)
    })
  }

  const intentWeights = {
    forecast: (/预测|forecast|需求|销量|季节|区间/.test(q) || moduleId === 'forecast') ? 2.2 : 1,
    inventory: (/库存|MRP|补货|断货|缺口|安全库存|ROP|批次|仓库/.test(q) || moduleId === 'inventory') ? 2.2 : 1,
    supplier: (/供应商|报价|RFQ|交期|质检|合同|币种|产能/.test(q) || moduleId === 'purchasing') ? 2.2 : 1,
    external: (/外部|新闻|汇率|市场|价格|风险|铁|钢|铝|铜|美元|原油/.test(q) || result.provider === 'market-data') ? 2.2 : 0.8,
  }
  const totalWeight = dimensions.reduce((sum, item) => sum + Number(intentWeights[item.key] || 1), 0)
  const weighted = dimensions.reduce((sum, item) => sum + item.score * Number(intentWeights[item.key] || 1), 0) / totalWeight
  let score = weighted
  const evidence = Array.from(new Set(dimensions.flatMap((item) => item.evidence))).slice(0, 8)
  const warnings = Array.from(new Set(dimensions.flatMap((item) => item.warnings)))
  if (result.provider === 'local') {
    score -= 6
    warnings.push('模型服务不可用，当前使用本地规则解释')
  }
  if (result.degraded) {
    score -= 8
    warnings.push('AI 服务降级，需人工复核')
  }

  const bounded = clampScore(score)
  const weakDimensions = dimensions.filter((item) => item.score < 70).map((item) => item.label)
  return {
    score: bounded,
    level: levelOf(bounded),
    dimensions,
    evidence,
    warnings,
    recommendedValidation: weakDimensions.length
      ? `建议在审批前重点复核：${weakDimensions.join('、')}。`
      : warnings.length
        ? '建议在审批前复核主数据、预测版本、供应商报价和外部市场信号。'
      : '可作为审批说明草稿，但关键采购动作仍需人工确认。',
    method: '分维度规则校准：预测 + 库存/MRP + 供应商 + 外部市场，按问题意图加权',
  }
}

function extractResponseText(payload) {
  if (payload.output_text) return payload.output_text
  const chunks = []
  for (const item of payload.output || []) {
    for (const content of item.content || []) {
      if (content.type === 'output_text' && content.text) chunks.push(content.text)
      if (content.type === 'text' && content.text) chunks.push(content.text)
    }
  }
  return chunks.join('\n').trim()
}

function buildAiContext({ moduleId, activeInsight }, db, ctx) {
  const {
    ensurePurchaseRequests,
    ensureInventoryMovements,
    ensureEvents,
    ensureAuditLog,
    supplierRecommendations,
  } = ctx
  const mrpPlan = buildMrpPlan(db)
  const topRecommendation = mrpPlan.exceptions[0]
    ? supplierRecommendations(db, { sku: mrpPlan.exceptions[0].sku, quantity: mrpPlan.exceptions[0].quantity })
    : null
  return {
    moduleId,
    activeInsight,
    purchaseOrders: db.purchaseOrders.slice(0, 12),
    purchaseRequests: ensurePurchaseRequests(db).slice(0, 12),
    inventoryMovements: ensureInventoryMovements(db).slice(0, 12),
    receivingDocs: db.receivingDocs.slice(0, 12),
    products: (db.products || []).slice(0, 12),
    suppliers: (db.suppliers || []).slice(0, 12),
    salesForecasts: (db.salesForecasts || []).slice(0, 12),
    forecastPlans: (db.forecastPlans || []).slice(0, 8),
    mrpPlan: {
      summary: mrpPlan.summary,
      exceptions: mrpPlan.exceptions.slice(0, 8),
    },
    supplierRecommendation: topRecommendation ? {
      sku: topRecommendation.sku,
      primary: topRecommendation.primary,
      backup: topRecommendation.backup,
      needsRfq: topRecommendation.needsRfq,
      split: topRecommendation.split,
    } : null,
    marketPrices: ensureMarketPrices(db).slice(0, 12),
    marketSignals: ensureMarketSignals(db).slice(0, 8),
    recentEvents: ensureEvents(db).slice(0, 8),
    recentAuditLog: ensureAuditLog(db).slice(0, 12),
  }
}

function buildAiSystemPrompt() {
  return [
    '你是 FlowChain 采购与供应链工作台内嵌 AI 分析助手。',
    '你只能基于提供的 FlowChain 业务上下文回答；如果上下文包含外部信号，可以结合外部信号说明风险。',
    '回答要短、具体、业务化，包含数据依据和下一步建议。',
    '如果缺少关键数据，明确说需要人工确认。',
  ].join('\n')
}

function withOptionalDispatcher(options, dispatcher) {
  return dispatcher ? { ...options, dispatcher } : options
}

function shouldFetchExternalSignals(question = '') {
  return /联网|外部|新闻|汇率|关税|政策|天气|港口|航运|物流|市场|风险|国际|美元|进口/.test(question)
}

function shouldUseLocalWorkbenchReply(question = '') {
  return /解释当前页面|当前页面|这个页面|页面在看什么|下一步|下一步建议|怎么处理|从哪里开始|what next|next action|explain/i.test(question)
}

function shouldLogAiTiming() {
  return process.env.NODE_ENV !== 'production'
}

function hasRepositoryBackedAiReadContext(repositories = {}) {
  return [repositories.procurementRead, repositories.inventoryRead, repositories.masterData, repositories.auditLog].some((repository) => {
    const marker = String(repository?.adapter || repository?.mode || '')
    return marker === 'database' || marker.startsWith('db-')
  })
}

function shouldRunInventoryStatusBeforeReadContext(body = {}, statusFastPath = null) {
  if (statusFastPath?.intent?.name !== 'inventory_status_query') return false
  const moduleId = String(body.moduleId || body.activeContext?.module || '')
  const question = String(body.question || '')
  if (/\bpo\b|invoice|contract|rfq|发票|合同|询价/i.test(question)) return moduleId === 'inventory'
  return moduleId === 'inventory' ||
    moduleId === 'overview' ||
    moduleId === 'today-cockpit' ||
    /库存|缺货|断货|补货|仓库|物料|sku|item|inventory|stock|shortage/i.test(question)
}

function shouldRunInventoryBeforeProcurement(body = {}, statusFastPath = null) {
  if (!shouldRunInventoryStatusBeforeReadContext(body, statusFastPath)) return false
  const moduleId = String(body.moduleId || body.activeContext?.module || '')
  const question = String(body.question || '')
  return moduleId === 'inventory' ||
    /SKU[-\w]*|库存|缺货|断货|补货|仓库|物料|inventory|stock|shortage/i.test(question)
}

function safeAuditText(value = '', fallback = 'ai') {
  const text = String(value || fallback)
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(/sk-[A-Za-z0-9._-]+/gi, 'sk-[redacted]')
  return text.slice(0, 180)
}

async function recordAiEventBestEffort({ db, event, repositories, action, summary, entity, persist = true }) {
  const auditStartedAt = Date.now()
  const auditRepository = repositories?.auditLog
  try {
    if ((auditRepository?.mode === 'database' || auditRepository?.adapter === 'db-audit-log-v1') &&
      typeof auditRepository.recordAiEventBestEffort === 'function') {
      const result = await auditRepository.recordAiEventBestEffort({
        module: 'ai',
        action: safeAuditText(action),
        entity: { type: 'ai', id: safeAuditText(entity) },
        summary: safeAuditText(summary),
        metadata: {
          persistedVia: 'auditLogRepository',
        },
      })
      return { ...result, auditMs: Date.now() - auditStartedAt }
    }
    if (typeof event === 'function') {
      event(db, safeAuditText(action), safeAuditText(summary), safeAuditText(entity))
    }
    return { ok: true, auditMs: Date.now() - auditStartedAt }
  } catch (error) {
    if (shouldLogAiTiming()) {
      const code = error?.code || error?.name || 'audit_failed'
      console.warn(`[ai-audit] best-effort audit skipped action=${safeAuditText(action)} code=${safeAuditText(code)}`)
    }
    return { ok: false, auditMs: Date.now() - auditStartedAt }
  }
}

function logAiTiming({ startedAt, branchStartedAt, branch, body, result, auditMs = 0 }) {
  if (!shouldLogAiTiming()) return
  const intent = result?.intent?.name || result?.provider || branch
  const cards = Array.isArray(result?.cards) ? result.cards.length : 0
  const providerMarker = result?.providerStatus ? ` provider=${result.providerStatus}` : ''
  const auditMarker = auditMs ? ` auditMs=${auditMs}` : ''
  console.log(`[ai-chat] intent=${intent} module=${body.moduleId || 'unknown'} elapsedMs=${Date.now() - startedAt} branchMs=${Date.now() - branchStartedAt}${auditMarker} cards=${cards}${providerMarker}`)
}

async function callOpenAI({ moduleId, question, activeInsight }, db, ctx) {
  const { openaiDispatcher, aiMaxTokens } = ctx
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) {
    return { provider: 'local', content: localAiReply({ moduleId, question, activeInsight }, db, ctx) }
  }

  const model = process.env.OPENAI_MODEL || 'gpt-5-mini'
  const context = buildAiContext({ moduleId, activeInsight }, db, ctx)

  const response = await undiciFetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    dispatcher: openaiDispatcher,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      instructions: buildAiSystemPrompt(),
      input: [
        {
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: `用户问题：${question}\n\nFlowChain 业务上下文 JSON：${JSON.stringify(context)}`,
            },
          ],
        },
      ],
      max_output_tokens: aiMaxTokens,
    }),
  })

  if (!response.ok) {
    const text = await response.text()
    throw new Error(`OpenAI API error ${response.status}: ${text}`)
  }

  const payload = await response.json()
  return { provider: 'openai', model, content: extractResponseText(payload) || '模型没有返回文本。' }
}

async function callDoubao({ moduleId, question, activeInsight }, db, ctx) {
  const { arkDispatcher, aiMaxTokens } = ctx
  const apiKey = process.env.ARK_API_KEY || process.env.DOUBAO_API_KEY
  if (!apiKey) {
    return { provider: 'local', content: localAiReply({ moduleId, question, activeInsight }, db, ctx) }
  }

  const model = process.env.ARK_MODEL || process.env.DOUBAO_MODEL || 'doubao-seed-2-0-lite-260215'
  const baseUrl = process.env.ARK_BASE_URL || 'https://ark.cn-beijing.volces.com/api/v3'
  const context = buildAiContext({ moduleId, activeInsight }, db, ctx)
  const response = await undiciFetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, withOptionalDispatcher({
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      max_tokens: aiMaxTokens,
      messages: [
        { role: 'system', content: buildAiSystemPrompt() },
        {
          role: 'user',
          content: [
            '下面是 FlowChain 业务上下文 JSON：',
            JSON.stringify(context),
            '',
            `请直接回答这个用户问题：${question}`,
          ].join('\n'),
        },
      ],
    }),
  }, arkDispatcher))

  if (!response.ok) {
    const text = await response.text()
    throw new Error(`Doubao API error ${response.status}: ${text}`)
  }

  const payload = await response.json()
  return {
    provider: 'doubao',
    model,
    content: payload.choices?.[0]?.message?.content || '模型没有返回文本。',
  }
}

async function callConfiguredAi(body, db, ctx) {
  const provider = (process.env.AI_PROVIDER || 'openai').toLowerCase()
  const priceAnswer = marketPriceReply(body.question, db)
  if (priceAnswer) return { provider: 'market-data', content: priceAnswer }
  if (body.externalSignals) {
    db.marketSignals = [
      ...ensureMarketSignals(db),
      ...(body.externalSignals.signals || []).map(normalizeMarketSignal),
    ].slice(-12)
  }
  if (provider === 'doubao' || provider === 'ark') return callDoubao(body, db, ctx)
  return callOpenAI(body, db, ctx)
}

function providerDisabledResponse({ startedAt, branchStartedAt, body }) {
  const message = '当前工作区缺少足够业务规则或记录，暂无法形成可靠判断。请指定客户订单、SKU、采购订单或供应商后重试。'
  return {
    provider: 'local',
    providerStatus: 'blocked',
    mode: 'deterministic',
    status: 'blocked',
    intent: { name: 'provider_disabled', confidence: 1, slots: {} },
    message,
    content: message,
    cards: [],
    evidence: [],
    usedWeb: false,
    timingMs: Date.now() - startedAt,
    externalMs: 0,
    modelMs: Date.now() - branchStartedAt,
  }
}

function providerFailureResponse({ body, db, ctx }) {
  const content = localAiReply(body, db, ctx)
  return {
    provider: 'local',
    providerStatus: 'degraded',
    degraded: true,
    errorCode: 'provider_unavailable',
    message: content,
    content,
    cards: [],
    evidence: [],
  }
}

const aiHandlerRegistry = createAiHandlerRegistry({
  buildAiResponseContractV2,
  buildAiSessionGroundedResponse,
  buildAiFinanceCollaborationResponse,
  buildAiMasterDataQualityResponse,
  buildAiInventoryAllocationResponse,
  buildAiSalesDemandResponse,
  buildAiEvidenceGraphResponse,
  buildAiDataLimitationResponse,
  buildAiChatStatusResponse,
  buildAiProcurementOperationalResponse,
  buildAiEvidenceReuseResponse,
  buildAiReceivingGapResponse,
  buildAiSupplierOperationalResponse,
  buildAiRfqOperationalResponse,
  buildAiCockpitFastPathResponse,
  buildAiDraftPreparationResponse,
  buildAiCompoundQueryResponse,
  shouldRunInventoryBeforeProcurement,
  shouldRunInventoryStatusBeforeReadContext,
  shouldUseLocalWorkbenchReply,
  localAiReply,
  aiConfidence,
  marketPriceReply,
  getAiProviderSafetyState,
  isTechnicalProviderDiagnosticPrompt,
  buildUnknownGuidedFallbackResponse,
  classifyAiBusinessIntent,
  providerDisabledResponse,
  shouldFetchExternalSignals,
  fetchExternalSignals,
  callConfiguredAi,
  providerFailureResponse,
})

export async function handleAiRoute(ctx) {
  const {
    req,
    res,
    url,
    db: legacyDb,
    send,
    readBody,
    repositories,
    ensurePurchaseRequests,
    ensureInventoryMovements,
    ensureRfqs,
  } = ctx
  let db = legacyDb
  const dataMode = ctx.dataMode || db?.__dataMode || ''

  if (req.method === 'GET' && url.pathname === '/api/ai/tools') {
    send(res, 200, { tools: getAiToolRegistry() })
    return true
  }

  if (req.method !== 'POST' || url.pathname !== '/api/ai/chat') return false

  const startedAt = Date.now()
  const body = await readBody(req)
  body.question = normalizeAiChatMessage(body)
  if (!body.question) {
    send(res, 400, { error: 'question is required' })
    return true
  }

  const authoritativeRuntime =
    repositories?.procurementRuntime ||
    repositories?.inventoryRuntime ||
    repositories?.salesOrders ||
    typeof repositories?.masterData?.listManagedItems === 'function'
  let businessReadContext = null
  if (authoritativeRuntime) {
    businessReadContext = await readBusinessContext(ctx)
    db = businessContextToReadDb(businessReadContext)
  }

  const routeOptions = {
    ensurePurchaseRequests,
    ensureInventoryMovements,
    ensureRfqs,
  }
  const state = {
    ctx,
    db,
    body,
    dataMode,
    startedAt,
    branchStartedAt: startedAt,
    routeOptions,
    compoundCandidate: detectCompoundBusinessQuery(body),
    repositoryBackedReadContext: hasRepositoryBackedAiReadContext(repositories),
    fastPathModuleId: String(body.moduleId || body.activeContext?.module || '').trim().toLowerCase(),
    statusBeforeProcurement: null,
    deferredProcurementException: null,
    readModelCache: null,
    recordEvent: recordAiEventBestEffort,
    logTiming: logAiTiming,
  }

  const preReadResult = await dispatchAiHandlers({
    handlers: aiHandlersForPhase(aiHandlerRegistry, 'pre_read_context'),
    state,
  })
  if (preReadResult.handled) return true

  const aiReadContext = await buildAiReadContext(db, {
    ...ctx,
    businessReadContext,
    businessReadDb: db,
  })
  state.readModelCache = aiReadContext.cache

  const readContextResult = await dispatchAiHandlers({
    handlers: aiHandlersForPhase(aiHandlerRegistry, 'read_context'),
    state,
  })
  if (readContextResult.handled) return true

  const fallbackResult = await dispatchAiHandlers({
    handlers: aiHandlersForPhase(aiHandlerRegistry, 'fallback'),
    state,
  })
  return fallbackResult.handled
}
