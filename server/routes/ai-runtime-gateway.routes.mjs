import { withoutUnavailableProductLinks } from '../../shared/unavailable-product-routes.mjs'
import { handleKnowledgeRoute, runKnowledgeQuery, isKnowledgeQuestion } from './ai-knowledge.routes.mjs'
import { buildAiRuntimeReadinessV2, buildAiRuntimeResponseV2Async, validateAiRuntimeRequest } from '../domain/ai-runtime-gateway-v2.mjs'
import { runBusinessQueryRuntime } from '../domain/ai-business-query-runtime.mjs'
import { classifyQueryScope } from '../domain/ai-query-scope.mjs'
import { isLegacyAiTemplateGatewayEnabled, runAiSkillRuntime } from '../domain/ai-skill-runtime.mjs'

// Stable codes with an English message, or a Chinese one when the question
// was asked in Chinese. The client maps the codes to its own recovery text.
const ERRORS = {
  AI_REQUEST_UNREADABLE: ['The question could not be read. Please ask again.', '问题内容无法读取，请重新输入。'],
  AI_QUESTION_TOO_LONG: ['The question is too long. Please shorten it and ask again.', '问题过长，请缩短后重新提问。'],
  AI_QUESTION_TOO_SHORT: ['Enter a question of at least two characters.', '请输入至少两个字的问题。'],
  AUTHENTICATION_REQUIRED: ['Sign in to use the assistant.', '请登录后使用 AI 助手。'],
  TENANT_CONTEXT_REQUIRED: ['A workspace is required to use the assistant.', '使用 AI 助手需要选择工作区。'],
  ACTOR_NOT_PROVISIONED: ['Your user is not set up for this workspace.', '你的用户尚未在此工作区开通。'],
  USER_DISABLED: ['Your user is disabled in this workspace.', '你的用户在此工作区已停用。'],
  SESSION_STALE: ['Your access changed. Sign in again.', '你的权限已变更，请重新登录。'],
  AI_SKILL_UNAVAILABLE: ['The assistant could not read your workspace data just now. Please try again.', 'AI 助手暂时无法读取工作区数据，请稍后重试。'],
}
function errorBody(code, body = {}) {
  const [en, zh] = ERRORS[code] || ERRORS.AI_SKILL_UNAVAILABLE
  return { code, error: body.answerLanguage === 'zh-CN' ? zh : en }
}

async function addKnowledgeContext(ctx, body, response) {
  if (classifyQueryScope(body) !== 'mixed') return response
  try {
    const knowledge = await runKnowledgeQuery(ctx, body, { force: true })
    return { ...response, supplementalKnowledge: { title: knowledge.conclusion.title, summary: knowledge.conclusion.summary, rag: knowledge.rag } }
  } catch {
    const zh = body.answerLanguage === 'zh-CN'
    return { ...response, supplementalKnowledge: { title: zh ? '知识库暂时不可用' : 'Knowledge temporarily unavailable', summary: zh ? '业务查询已完成，但本次未能读取相关政策或产品资料。请稍后重试。' : 'The business query completed, but supporting policy or product documents could not be retrieved. Try again later.', rag: { mode: 'unavailable', citations: [] } } }
  }
}

export async function loadAiRuntimeFacts(repositories = {}, tenantId = '') {
  if (!tenantId) return {}
  const scope = { tenantId }
  const [procurement, products, suppliers] = await Promise.all([
    repositories.procurementRead?.snapshot?.(scope) || {},
    repositories.inventoryRead?.listItems?.(scope) || [],
    repositories.masterData?.listSuppliers?.(scope) || [],
  ])
  return {
    purchaseRequests: procurement.purchaseRequests || [],
    rfqs: procurement.rfqs || [],
    purchaseOrders: procurement.purchaseOrders || [],
    receivingDocs: procurement.receivingDocs || [],
    supplierInvoices: procurement.supplierInvoices || [],
    products,
    suppliers,
  }
}

export async function handleAiRuntimeGatewayRoute(ctx) {
  if (await handleKnowledgeRoute(ctx)) return true
  const { req, res, url, db, send, readBody, repositories, identity } = ctx

  if (req.method === 'GET' && url.pathname === '/api/ai-runtime/readiness') {
    send(res, 200, buildAiRuntimeReadinessV2(db, process.env))
    return true
  }

  if (req.method === 'POST' && url.pathname === '/api/ai-runtime/respond') {
    let body = {}
    try {
      body = await readBody(req)
    } catch {
      send(res, 400, errorBody('AI_REQUEST_UNREADABLE'))
      return true
    }
    try {
      const knowledge = await runKnowledgeQuery(ctx, body)
      if (knowledge) { send(res, 200, knowledge); return true }
      // Reject empty or oversized questions before any tenant data is read.
      const validation = validateAiRuntimeRequest(body)
      if (!validation.ok) {
        const tooLong = String(body.message || body.question || '').trim().length > 1200
        send(res, validation.status, errorBody(tooLong ? 'AI_QUESTION_TOO_LONG' : 'AI_QUESTION_TOO_SHORT', body))
        return true
      }
      const businessQuery = await runBusinessQueryRuntime(ctx, db, body, { responseMode: 'runtime' })
      if (businessQuery) {
        send(res, 200, await addKnowledgeContext(ctx, body, businessQuery))
        return true
      }
      // Rollback only: the retired Chinese template gateway, off by default.
      if (isLegacyAiTemplateGatewayEnabled(ctx.env || process.env)) {
        const facts = identity?.authenticated && identity.tenantId
          ? await loadAiRuntimeFacts(repositories, identity.tenantId)
          : {}
        const result = await buildAiRuntimeResponseV2Async({ ...db, ...facts }, body, { env: identity?.authenticated ? process.env : {} })
        send(res, result.status, await addKnowledgeContext(ctx, body, withoutUnavailableProductLinks(result.body)))
        return true
      }
      send(res, 200, await addKnowledgeContext(ctx, body, await runAiSkillRuntime(ctx, body)))
    } catch (error) {
      if (isKnowledgeQuestion(body)) {
        send(res, error.status || 503, { code: error.code || 'KNOWLEDGE_UNAVAILABLE', error: error.status ? error.message : (body.answerLanguage === 'zh-CN' ? '知识库暂时不可用，请稍后重试。' : 'Knowledge is temporarily unavailable. Please try again.') })
        return true
      }
      // Sign-in and workspace problems keep their status; anything else is a
      // retryable 503, never a made-up "no records" answer.
      if ([401, 403].includes(error.status) && ERRORS[error.code]) {
        send(res, error.status, errorBody(error.code, body))
        return true
      }
      send(res, 503, errorBody('AI_SKILL_UNAVAILABLE', body))
    }
    return true
  }

  return false
}
