import { getPrismaClient } from '../persistence/prisma-client.mjs'
import { resolveProvisionedActor } from './pilot-identity.mjs'
import { createSupplierActionSummaryReadService } from './supplier-action-summary-read-service.mjs'
import { executeBusinessQueryPlan } from './ai-business-query-executor.mjs'
import { buildBusinessQueryResponseV2, buildLegacyBusinessQueryChatResponse } from './ai-business-query-response.mjs'
import { isComplexBusinessQuery, planBusinessQuery } from './ai-semantic-query-planner.mjs'
import { isTechnicalProviderDiagnosticPrompt } from './ai-business-intent-router.mjs'
import { routeSkill } from './ai-skill-router.mjs'
import { aiSkillQuestionLanguage } from './ai-skill-copy.mjs'

const text = (value) => String(value ?? '').trim()
const array = (value) => Array.isArray(value) ? value : []

// Questions a workspace skill answers with the reports' own figures: invoice
// totals and match results, stock and availability, one named order, orders
// waiting for approval. They go to the skills unless they are about payments.
// A general question about suppliers gets the supplier list by date
// (supplier_attention) unless it is about payments.
const SKILL_FIRST = new Set(['invoice_summary', 'inventory_availability', 'pending_approvals', 'supplier_attention'])

// Whether the business query path takes this question before the skills.
export function shouldUseSemanticBusinessQuery(message, body = {}) {
  const input = text(message).toLowerCase()
  if (!isComplexBusinessQuery({ message })) return false
  const hasPaymentSignal = /付款|应付|付钱|payment|payable|pay\b|paid\b/.test(input)
  const route = routeSkill({ message })
  if (!hasPaymentSignal && (SKILL_FIRST.has(route?.skillId) || route?.ids?.length)) return false
  const hasPreviousResult = /这些|上述|刚才|上一轮|those|these|previous result|them\b/.test(input)
  const hasSupplierScope = /supplier|vendor|供应商|供方/.test(input)
  return hasPaymentSignal || hasPreviousResult || hasSupplierScope
}

function previousResult(body = {}) {
  return body.previousResult || body.conversationContext?.previousEntityRefs || body.sessionGrounding?.recentEntities || []
}

function currentContext(body = {}) {
  if (body.activeContext) return body.activeContext
  if (body.focusTarget) return { ...body.focusTarget, module: body.activeModuleId, view: body.activeViewId }
  return null
}

// The tenant's business query context: the actor, its suppliers, the read
// service and the timezone. Null outside database mode or when signed out.
export async function loadBusinessQueryContext(ctx) {
  const env = ctx.env || process.env
  if (!(ctx.repositories?.mode === 'database' || text(env.FLOWCHAIN_PERSISTENCE_MODE).toLowerCase() === 'database')) return null
  if (!ctx.aiBusinessQueryActor && !ctx.identity?.authenticated) return null
  const prisma = ctx.aiBusinessQueryPrisma || await getPrismaClient(env)
  const actor = ctx.aiBusinessQueryActor || await resolveProvisionedActor(prisma, ctx.identity, { allowMissingTestActor: true })
  const tenant = await prisma.tenant.findUnique({ where: { id: actor.tenantId }, select: { timezone: true } })
  const timezone = text(tenant?.timezone || env.FLOWCHAIN_WORKSPACE_TIMEZONE || env.TZ || 'America/New_York')
  // The planner keeps only complete supplier records, which carry their
  // tenant; without tenantId no named supplier ever resolved.
  const suppliers = await prisma.supplier.findMany({ where: { tenantId: actor.tenantId }, select: { id: true, tenantId: true, name: true, code: true }, orderBy: [{ id: 'asc' }] })
  const summaryService = ctx.aiBusinessQuerySummaryService || createSupplierActionSummaryReadService({ prisma, env })
  return { actor, suppliers, summaryService, timezone }
}

// What the planners read besides the question: the page record, the previous
// answer's records, the timezone and the tenant's suppliers.
export function businessQueryPlanInput(body, bq) {
  return { message: text(body.message || body.question), moduleId: body.activeModuleId || body.moduleId, currentContext: currentContext(body), previousResult: previousResult(body), timezone: bq.timezone, suppliers: bq.suppliers }
}

// Runs a validated plan for the actor and answers in the question's language,
// as the skills do.
export async function answerBusinessQueryPlan(ctx, body, planner, bq) {
  const message = text(body.message || body.question)
  const pack = await executeBusinessQueryPlan(planner.plan, { summaryService: bq.summaryService, actor: bq.actor, identity: ctx.identity, timezone: bq.timezone, now: new Date(), message })
  return buildBusinessQueryResponseV2(pack, planner, { ...body, answerLanguage: aiSkillQuestionLanguage(message, body.answerLanguage) })
}

export async function runBusinessQueryRuntime(ctx, db, body, { responseMode = 'runtime' } = {}) {
  const message = text(body.message || body.question)
  if (message.length > 1200 || !message || isTechnicalProviderDiagnosticPrompt(message) || !shouldUseSemanticBusinessQuery(message, body)) return null
  const bq = await loadBusinessQueryContext(ctx)
  if (!bq) return null
  const planner = await planBusinessQuery(businessQueryPlanInput(body, bq), { env: ctx.env || process.env, providerPlanner: ctx.aiSemanticProviderPlanner, fetchImpl: ctx.aiSemanticFetch })
  const response = await answerBusinessQueryPlan(ctx, body, planner, bq)
  return responseMode === 'chat' ? buildLegacyBusinessQueryChatResponse(response, planner) : response
}
