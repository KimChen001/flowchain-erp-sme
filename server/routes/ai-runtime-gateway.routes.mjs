import { withAiWorkspaceAccess } from '../domain/ai-workspace-access.mjs'
import { handleKnowledgeRoute } from './ai-knowledge.routes.mjs'
import { aiSkillQuestionLanguage } from '../domain/ai-skill-copy.mjs'
import { scopeBusinessContext } from '../domain/report-read-access.mjs'
import { aiRuntimeProgressStream } from './ai-runtime-stream.mjs'
import { assistantV2Enabled, assistantV2ModelClient } from '../domain/ai-assistant-v2-controls.mjs'
import { QUESTION_LIMITS } from '../../shared/assistant-protocol.mjs'
import { answerWithAssistantV2, answerWithAssistantV2Notice, assistantV2SetupState, validateAssistantV2Question } from './ai-assistant-v2-gateway.mjs'
import { readAssistantFeedback, recordAssistantFeedback } from '../domain/ai-assistant-v2-feedback.mjs'

// Stable codes with an English message, or a Chinese one when the question
// was asked in Chinese. The client maps the codes to its own recovery text.
const ERRORS = {
  AI_REQUEST_UNREADABLE: ['The question could not be read. Please ask again.', '问题内容无法读取，请重新输入。'],
  AI_QUESTION_TOO_LONG: ['The question is too long. Please shorten it and ask again.', '问题过长，请缩短后重新提问。'],
  AI_QUESTION_TOO_SHORT: ['Enter a question.', '请输入问题。'],
  AUTHENTICATION_REQUIRED: ['Sign in to use the assistant.', '请登录后使用 AI 助手。'],
  TENANT_CONTEXT_REQUIRED: ['A workspace is required to use the assistant.', '使用 AI 助手需要选择工作区。'],
  ACTOR_NOT_PROVISIONED: ['Your user is not set up for this workspace.', '你的用户尚未在此工作区开通。'],
  USER_DISABLED: ['Your user is disabled in this workspace.', '你的用户在此工作区已停用。'],
  SESSION_STALE: ['Your access changed. Sign in again.', '你的权限已变更，请重新登录。'],
  AI_SKILL_UNAVAILABLE: ['The assistant could not read your workspace data just now. Please try again.', 'AI 助手的工作区数据加载失败，请稍后重试。'],
}
function errorBody(code, body = {}) {
  const [en, zh] = ERRORS[code] || ERRORS.AI_SKILL_UNAVAILABLE
  return { code, error: body.answerLanguage === 'zh-CN' ? zh : en }
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
// access its workspace has (ai-workspace-access.mjs). Assistant v2 answers
// every question (owner direction 2026-11-05: the deterministic rules engine
// goes). When it cannot (AI off for the workspace, no model configured, the
// month's cap used, the provider failing), the answer is a notice that says
// so in plain words; no rules answer stands in for it. A client that accepts
// NDJSON gets the answer as it is written (ai-runtime-stream.mjs).
export async function handleAiRuntimeGatewayRoute(ctx) {
  if (!ctx.url?.pathname?.startsWith('/api/ai-runtime/')) return false
  const stream = ctx.url.pathname === '/api/ai-runtime/respond' ? aiRuntimeProgressStream(ctx.req, ctx.res, ctx.send) : { send: ctx.send, event: null }
  return withAiWorkspaceAccess({ ...ctx, send: stream.send }, (scoped) => handleGatewayRequest({ ...scoped, aiStreamEvent: stream.event }))
}

// Why assistant v2 cannot answer this request, as a notice code: the month's
// cap is used, the workspace has not switched AI on, or no model is set up on
// this server (no provider, or the assistant mode is not assistant_v2).
export function assistantV2OffNotice(ctx = {}) {
  const status = ctx.aiModelAccess || ctx.aiWorkspaceAccessStatus
  if (status === 'over_cap') return 'over_cap'
  if (status === 'off') return 'ai_off'
  return 'no_provider'
}

async function handleGatewayRequest(ctx) {
  if (await handleKnowledgeRoute(ctx)) return true
  const { req, res, url, readBody, identity } = ctx
  const send = ctx.send

  if (req.method === 'GET' && url.pathname === '/api/ai-runtime/readiness') {
    // assistantV2: whether this user's questions go to assistant v2, so the
    // panel streams them; with it, setup: the first-day checklist's state, so
    // the panel's empty state offers setup starters while it is open. Without
    // it, notice: why the assistant cannot answer here.
    const assistantV2 = assistantV2Enabled(ctx)
    send(res, 200, { assistantV2, ...(assistantV2 ? { setup: await assistantV2SetupState(ctx) } : { notice: assistantV2OffNotice(ctx) }) })
    return true
  }

  // A thumbs up or down on one answer (ai-assistant-v2-feedback.mjs).
  if (req.method === 'POST' && url.pathname === '/api/ai-runtime/feedback') {
    if (!identity?.authenticated) {
      send(res, 401, errorBody('AUTHENTICATION_REQUIRED'))
      return true
    }
    if (!identity.tenantId) {
      send(res, 403, errorBody('TENANT_CONTEXT_REQUIRED'))
      return true
    }
    let body = {}
    try {
      body = await readBody(req)
    } catch {
      send(res, 400, errorBody('AI_REQUEST_UNREADABLE'))
      return true
    }
    const feedback = readAssistantFeedback(body)
    if (!feedback.ok) {
      send(res, 400, { code: 'AI_FEEDBACK_INVALID', error: feedback.error })
      return true
    }
    await recordAssistantFeedback(ctx, feedback.value, { env: ctx.env || process.env })
    send(res, 200, { ok: true })
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
    // Reject empty or oversized questions before any tenant data is read.
    // Questions may be long (QUESTION_LIMITS.assistantV2), so a user can
    // paste rows.
    const validation = validateAssistantV2Question(body)
    if (!validation.ok) {
      const tooLong = String(body.message || body.question || '').trim().length > QUESTION_LIMITS.assistantV2
      send(res, validation.status, errorBody(tooLong ? 'AI_QUESTION_TOO_LONG' : 'AI_QUESTION_TOO_SHORT', body))
      return true
    }
    try {
      if (!identity?.authenticated) {
        send(res, 401, errorBody('AUTHENTICATION_REQUIRED', body))
        return true
      }
      if (!identity.tenantId) {
        send(res, 403, errorBody('TENANT_CONTEXT_REQUIRED', body))
        return true
      }
      // Assistant v2 (docs/ai-assistant-v2-design.md §3.2): only the length
      // check and its own guards run before the model.
      const assistantV2 = assistantV2ModelClient(ctx)
      if (!assistantV2) await answerWithAssistantV2Notice(ctx, body, assistantV2OffNotice(ctx), { started })
      else await answerWithAssistantV2(ctx, body, { client: assistantV2, started })
    } catch (error) {
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
