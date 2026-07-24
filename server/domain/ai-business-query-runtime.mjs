import { defaultRoleTemplates, legacyRoleTemplateMap } from '../auth/permission-catalog.mjs'
import { getPrismaClient } from '../persistence/prisma-client.mjs'
import { resolveProvisionedActor } from './pilot-identity.mjs'
import { buildSupplierActionSummaries, createSupplierActionSummaryReadService } from './supplier-action-summary-read-service.mjs'
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
  const hasPreviousResult = Boolean(previousResult(body).length) && /这些|上述|刚才|上一轮|those|these|previous result|them\b/.test(input)
  return hasPaymentSignal || hasPreviousResult
}

function legacyActor(identity = {}, tenantId = 'tenant-local') {
  const roleKey = legacyRoleTemplateMap[text(identity.role).toLowerCase()] || 'read-only-viewer'
  return { tenantId: text(identity.tenantId || tenantId), permissionCodes: new Set(defaultRoleTemplates.find((item) => item.roleKey === roleKey)?.permissions || []) }
}

function normalizedLocalRecords(db = {}, tenantId) {
  const withTenant = (row) => ({ ...row, tenantId: text(row.tenantId || tenantId) })
  return {
    suppliers: array(db.suppliers).map(withTenant),
    payables: [], invoices: [], settlements: [], bankExceptions: [],
    purchaseOrders: array(db.purchaseOrders).map(withTenant),
    receiving: array(db.receivingDocs).map(withTenant),
    rfqs: array(db.rfqs).map(withTenant),
  }
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
  if (!message || isTechnicalProviderDiagnosticPrompt(message) || !shouldUseSemanticBusinessQuery(message, body)) return null
  const env = ctx.env || process.env
  const timezone = text(env.FLOWCHAIN_WORKSPACE_TIMEZONE || env.TZ || 'UTC')
  let actor
  let suppliers
  let summaryService
  if (ctx.repositories?.mode === 'database' || text(env.FLOWCHAIN_PERSISTENCE_MODE).toLowerCase() === 'database') {
    if (!ctx.aiBusinessQueryActor && !ctx.identity?.authenticated) return null
    const prisma = ctx.aiBusinessQueryPrisma || await getPrismaClient(env)
    actor = ctx.aiBusinessQueryActor || await resolveProvisionedActor(prisma, ctx.identity, { allowMissingTestActor: true })
    suppliers = await prisma.supplier.findMany({ where: { tenantId: actor.tenantId }, orderBy: [{ id: 'asc' }] })
    summaryService = ctx.aiBusinessQuerySummaryService || createSupplierActionSummaryReadService({ prisma, env })
  } else {
    actor = ctx.aiBusinessQueryActor || legacyActor(ctx.identity, 'tenant-local')
    const records = normalizedLocalRecords(db, actor.tenantId)
    suppliers = records.suppliers
    summaryService = ctx.aiBusinessQuerySummaryService || { read: async ({ timeWindow }) => buildSupplierActionSummaries({ records, actor, timeWindow, sourceAvailability: { payables: false, invoices: false, settlements: false, bankReconciliation: false } }) }
  }
  const planner = await planBusinessQuery({ message, moduleId: body.activeModuleId || body.moduleId, currentContext: currentContext(body), previousResult: previousResult(body), timezone, suppliers }, { env, providerPlanner: ctx.aiSemanticProviderPlanner, fetchImpl: ctx.aiSemanticFetch })
  const pack = await executeBusinessQueryPlan(planner.plan, { summaryService, actor, identity: ctx.identity, timezone, now: new Date(), message })
  const response = buildBusinessQueryResponseV2(pack, planner, body)
  return responseMode === 'chat' ? buildLegacyBusinessQueryChatResponse(response, planner) : response
}
