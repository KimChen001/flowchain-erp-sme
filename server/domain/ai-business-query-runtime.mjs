import { getPrismaClient } from '../persistence/prisma-client.mjs'
import { resolveProvisionedActor } from './pilot-identity.mjs'
import { createSupplierActionSummaryReadService } from './supplier-action-summary-read-service.mjs'
import { executeBusinessQueryPlan } from './ai-business-query-executor.mjs'
import { buildBusinessQueryResponseV2, buildLegacyBusinessQueryChatResponse } from './ai-business-query-response.mjs'
import { isComplexBusinessQuery, planBusinessQuery } from './ai-semantic-query-planner.mjs'
import { isTechnicalProviderDiagnosticPrompt } from './ai-business-intent-router.mjs'

const text = (value) => String(value ?? '').trim()
const array = (value) => Array.isArray(value) ? value : []

function shouldUseSemanticBusinessQuery(message, body = {}) {
  const input = text(message).toLowerCase()
  if (!isComplexBusinessQuery({ message })) return false
  const hasPaymentSignal = /付款|应付|付钱|payment|payable|pay\b|paid\b/.test(input)
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

export async function runBusinessQueryRuntime(ctx, db, body, { responseMode = 'runtime' } = {}) {
  const message = text(body.message || body.question)
  if (message.length > 1200 || !message || isTechnicalProviderDiagnosticPrompt(message) || !shouldUseSemanticBusinessQuery(message, body)) return null
  const env = ctx.env || process.env
  let timezone = text(env.FLOWCHAIN_WORKSPACE_TIMEZONE || env.TZ || 'UTC')
  let actor
  let suppliers
  let summaryService
  if (ctx.repositories?.mode === 'database' || text(env.FLOWCHAIN_PERSISTENCE_MODE).toLowerCase() === 'database') {
    if (!ctx.aiBusinessQueryActor && !ctx.identity?.authenticated) return null
    const prisma = ctx.aiBusinessQueryPrisma || await getPrismaClient(env)
    actor = ctx.aiBusinessQueryActor || await resolveProvisionedActor(prisma, ctx.identity, { allowMissingTestActor: true })
    const tenant = await prisma.tenant.findUnique({ where: { id: actor.tenantId }, select: { timezone: true } })
    timezone = text(tenant?.timezone || timezone)
    suppliers = await prisma.supplier.findMany({ where: { tenantId: actor.tenantId }, select: { id: true, name: true }, orderBy: [{ id: 'asc' }] })
    summaryService = ctx.aiBusinessQuerySummaryService || createSupplierActionSummaryReadService({ prisma, env })
  } else {
    return null
  }
  const planner = await planBusinessQuery({ message, moduleId: body.activeModuleId || body.moduleId, currentContext: currentContext(body), previousResult: previousResult(body), timezone, suppliers }, { env, providerPlanner: ctx.aiSemanticProviderPlanner, fetchImpl: ctx.aiSemanticFetch })
  const pack = await executeBusinessQueryPlan(planner.plan, { summaryService, actor, identity: ctx.identity, timezone, now: new Date(), message })
  const response = buildBusinessQueryResponseV2(pack, planner, body)
  return responseMode === 'chat' ? buildLegacyBusinessQueryChatResponse(response, planner) : response
}
