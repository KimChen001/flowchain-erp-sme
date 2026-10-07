import { withoutUnavailableProductLinks } from '../../shared/unavailable-product-routes.mjs'
import { withAiWorkspaceAccess } from '../domain/ai-workspace-access.mjs'
import { aiAgentKnowledge, handleKnowledgeRoute, runKnowledgeQuery, isKnowledgeQuestion } from './ai-knowledge.routes.mjs'
import { buildAiRuntimeReadinessV2, buildAiRuntimeResponseV2Async, validateAiRuntimeRequest } from '../domain/ai-runtime-gateway-v2.mjs'
import { runBusinessQueryRuntime, shouldUseSemanticBusinessQuery } from '../domain/ai-business-query-runtime.mjs'
import { aiAgentPlanningEnabled } from '../domain/ai-agent-planning.mjs'
import { splitAiCompoundQuestion } from '../domain/ai-skill-compound.mjs'
import { classifyQueryScope } from '../domain/ai-query-scope.mjs'
import { isLegacyAiTemplateGatewayEnabled, runAiSkillRuntime } from '../domain/ai-skill-runtime.mjs'
import { detectAiActionRequest } from '../domain/ai-skill-router.mjs'
import { aiSkillQuestionLanguage } from '../domain/ai-skill-copy.mjs'
import { aiKnowledgeAuditBlock, recordAiSkillAudit } from '../domain/ai-skill-audit.mjs'
import { reportReadAccess, scopeBusinessContext } from '../domain/report-read-access.mjs'

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
  // A planned answer that searched the documents itself carries its passages.
  if (response?.supplementalKnowledge || response?.intent === 'knowledge_retrieval') return response
  if (classifyQueryScope(body) !== 'mixed') return response
  try {
    const knowledge = await runKnowledgeQuery(ctx, body, { force: true })
    return { ...response, supplementalKnowledge: { title: knowledge.conclusion.title, summary: knowledge.conclusion.summary, rag: knowledge.rag } }
  } catch {
    const zh = body.answerLanguage === 'zh-CN'
    return { ...response, supplementalKnowledge: { title: zh ? '知识库暂时不可用' : 'Knowledge temporarily unavailable', summary: zh ? '业务查询已完成，但本次未能读取相关政策或产品资料。请稍后重试。' : 'The business query completed, but supporting policy or product documents could not be retrieved. Try again later.', rag: { mode: 'unavailable', citations: [] } } }
  }
}

// access, the reader's report read access, scopes the facts as the business
// read context is scoped: no collections the role cannot read, no hidden
// amounts, invoice partners or supplier bank details, and stock from the
// reader's warehouses.
export async function loadAiRuntimeFacts(repositories = {}, tenantId = '', access = null) {
  if (!tenantId) return {}
  const scope = { tenantId }
  const [procurement, products, suppliers] = await Promise.all([
    repositories.procurementRead?.snapshot?.(scope) || {},
    repositories.inventoryRead?.listItems?.(access ? { ...scope, warehouseIds: access.warehouseIds } : scope) || [],
    repositories.masterData?.listSuppliers?.(scope) || [],
  ])
  const facts = {
    purchaseRequests: procurement.purchaseRequests || [],
    rfqs: procurement.rfqs || [],
    purchaseOrders: procurement.purchaseOrders || [],
    receivingDocs: procurement.receivingDocs || [],
    supplierInvoices: procurement.supplierInvoices || [],
    products,
    suppliers,
  }
  if (!access) return facts
  const scoped = scopeBusinessContext({ ...facts, receipts: facts.receivingDocs, inventoryItems: facts.products, salesOrders: [] }, access)
  return {
    purchaseRequests: scoped.purchaseRequests,
    rfqs: scoped.rfqs,
    purchaseOrders: scoped.purchaseOrders,
    receivingDocs: scoped.receipts,
    supplierInvoices: scoped.supplierInvoices,
    products: scoped.inventoryItems,
    suppliers: scoped.suppliers,
  }
}

// Every assistant request (answers, knowledge, readiness) runs with the model
// access its workspace has (ai-workspace-access.mjs). A workspace over this
// month's cap is answered without a model, and its answers say so.
export async function handleAiRuntimeGatewayRoute(ctx) {
  if (!ctx.url?.pathname?.startsWith('/api/ai-runtime/')) return false
  return withAiWorkspaceAccess(ctx, (scoped) => handleGatewayRequest(scoped.aiModelAccess === 'over_cap' ? { ...scoped, send: overCapSend(scoped.send) } : scoped))
}

function overCapSend(send) {
  return (res, status, payload) => send(res, status, status === 200 && payload && typeof payload === 'object' && !Array.isArray(payload) && payload.version === 'v2' ? { ...payload, aiModelAccess: { status: 'over_cap' } } : payload)
}

async function handleGatewayRequest(ctx) {
  if (await handleKnowledgeRoute(ctx)) return true
  const { req, res, url, db, send, readBody, repositories, identity } = ctx

  if (req.method === 'GET' && url.pathname === '/api/ai-runtime/readiness') {
    send(res, 200, buildAiRuntimeReadinessV2(db, process.env))
    return true
  }

  if (req.method === 'POST' && url.pathname === '/api/ai-runtime/respond') {
    const started = Date.now()
    let body = {}
    try {
      body = await readBody(req)
    } catch {
      send(res, 400, errorBody('AI_REQUEST_UNREADABLE'))
      return true
    }
    // One answer language for every path (knowledge, business query, skills,
    // errors): the question's own language, else the interface language.
    if (body && typeof body === 'object' && !Array.isArray(body)) {
      body = { ...body, interfaceLanguage: body.answerLanguage, answerLanguage: aiSkillQuestionLanguage(String(body.message || body.question || '').slice(0, 1201), body.answerLanguage) }
    }
    try {
      // An instruction to approve, pay, send, cancel or delete goes straight
      // to the skill runtime's refusal: the knowledge and business query
      // paths would otherwise answer it (a payment or supplier word sends it
      // to the supplier query planner) and never refuse.
      // Only the first 1,201 characters: a longer question is rejected below.
      const actionRequest = detectAiActionRequest(String(body?.message || body?.question || '').slice(0, 1201))
      const knowledge = actionRequest ? null : await runKnowledgeQuery(ctx, body)
      if (knowledge) {
        // The same audit row as a skill answer, with the knowledge answer's mode
        // and the documents it cited (ids and counts only).
        await recordAiSkillAudit(ctx, { response: { ...knowledge, answerSource: 'knowledge', language: body.answerLanguage }, facts: null, message: String(body.message || body.question || '').trim(), latencyMs: Date.now() - started, knowledge: aiKnowledgeAuditBlock(knowledge.rag) })
        send(res, 200, knowledge)
        return true
      }
      // Reject empty or oversized questions before any tenant data is read.
      const validation = validateAiRuntimeRequest(body)
      if (!validation.ok) {
        const tooLong = String(body.message || body.question || '').trim().length > 1200
        send(res, validation.status, errorBody(tooLong ? 'AI_QUESTION_TOO_LONG' : 'AI_QUESTION_TOO_SHORT', body))
        return true
      }
      // Agent planning (P2) on: a question with several parts that the
      // business query path would take goes to the planner first, which has
      // the supplier business query among its tools. When the planner does not
      // answer it, the business query path answers as before.
      const question = String(body.message || body.question || '')
      // The actor's documents for the planner's knowledge search (PR-3), read
      // only when agent planning is on.
      const agentDocuments = !actionRequest && aiAgentPlanningEnabled(ctx.env || process.env) ? await (ctx.aiAgentKnowledge !== undefined ? ctx.aiAgentKnowledge : aiAgentKnowledge(ctx).catch(() => null)) : null
      const attempt = !actionRequest && aiAgentPlanningEnabled(ctx.env || process.env) && splitAiCompoundQuestion(question).length >= 2 && shouldUseSemanticBusinessQuery(question, body) ? {} : null
      if (attempt) {
        const planned = await runAiSkillRuntime(ctx, body, { agentFirst: attempt, knowledge: agentDocuments })
        if (planned) { send(res, 200, await addKnowledgeContext(ctx, body, planned)); return true }
      }
      const answered = actionRequest ? null : await runBusinessQueryRuntime(ctx, db, body, { responseMode: 'runtime' })
      // A planner that failed leaves this answer, with the limited-mode label.
      const businessQuery = answered && attempt?.degraded ? { ...answered, agentPlanning: { status: 'degraded', entry: 'multi_part' } } : answered
      if (businessQuery) {
        // The same audit row as a skill answer: the plan's intent, the
        // records it cited and a hash of the question, never its text.
        await recordAiSkillAudit(ctx, { response: { ...businessQuery, answerSource: businessQuery.answerSource || 'business_query', language: businessQuery.language || body.answerLanguage }, facts: null, message: String(body.message || body.question || '').trim(), latencyMs: Date.now() - started, agent: attempt?.agent || null })
        send(res, 200, await addKnowledgeContext(ctx, body, businessQuery))
        return true
      }
      // Rollback only: the retired Chinese template gateway, off by default.
      if (!actionRequest && isLegacyAiTemplateGatewayEnabled(ctx.env || process.env)) {
        // An actor that cannot be resolved gets the sign-in error below.
        const facts = identity?.authenticated && identity.tenantId
          ? await loadAiRuntimeFacts(repositories, identity.tenantId, await reportReadAccess(ctx))
          : {}
        const result = await buildAiRuntimeResponseV2Async({ ...db, ...facts }, body, { env: identity?.authenticated ? process.env : {} })
        send(res, result.status, await addKnowledgeContext(ctx, body, withoutUnavailableProductLinks(result.body)))
        return true
      }
      send(res, 200, await addKnowledgeContext(ctx, body, await runAiSkillRuntime(ctx, body, { skipAgent: Boolean(attempt), knowledge: agentDocuments })))
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
