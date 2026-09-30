import { createHash } from 'node:crypto'
import { capabilityForEnvironment } from '../domain/capability-registry.mjs'
import { createReceivingDraftCommandService, RECEIVING_DRAFT_CHANNELS } from '../domain/receiving-draft-command-service.mjs'
import { createReceivingPostingCommandService, ReceivingCommandError } from '../domain/receiving-posting-command-service.mjs'
import { createReceivingWorkbenchQueryService } from '../domain/receiving-workbench-query-service.mjs'
import { getPrismaClient } from '../persistence/prisma-client.mjs'
import { PilotIdentityError } from '../domain/pilot-identity.mjs'

function sendCapabilityUnavailable(ctx, capabilityId) {
  return ctx.send(ctx.res, 409, {
    code: 'CAPABILITY_NOT_AVAILABLE',
    message: `${capabilityId} requires database persistence and explicit server enablement.`,
    capability: capabilityId,
  })
}

async function commandService(ctx) {
  if (ctx.receivingPostingService) return ctx.receivingPostingService
  const prisma = await getPrismaClient(ctx.env || process.env)
  return createReceivingPostingCommandService({ prisma, env: ctx.env || process.env })
}

async function queryService(ctx) {
  if (ctx.receivingWorkbenchQueryService) return ctx.receivingWorkbenchQueryService
  const env = ctx.env || process.env
  const prisma = await getPrismaClient(env)
  return createReceivingWorkbenchQueryService({ prisma, capabilities: {
    posting: capabilityForEnvironment('receiving-posting', env),
    reversal: capabilityForEnvironment('receiving-reversal', env),
  } })
}

function sendStructuredError(ctx, error) {
  if (!(error instanceof ReceivingCommandError) && !(error instanceof PilotIdentityError) && error?.name !== 'AuthorizationError') throw error
  ctx.send(ctx.res, error.status || 400, { code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) })
}

async function handleFormalReceivingRead(ctx) {
  if (ctx.req.method !== 'GET') return false
  const detail = ctx.url.pathname.match(/^\/api\/procurement\/receiving\/([^/]+)$/)
  const preview = ctx.url.pathname.match(/^\/api\/procurement\/receiving\/([^/]+)\/impact-preview$/)
  const evidence = ctx.url.pathname.match(/^\/api\/procurement\/receiving\/([^/]+)\/evidence$/)
  const links = ctx.url.pathname.match(/^\/api\/procurement\/receiving\/([^/]+)\/links$/)
  const reconciliation = ctx.url.pathname.match(/^\/api\/procurement\/receiving\/([^/]+)\/reconciliation$/)
  const poSummary = ctx.url.pathname.match(/^\/api\/procurement\/purchase-orders\/([^/]+)\/receiving-summary$/)
  if (!detail && !preview && !evidence && !links && !reconciliation && !poSummary) return false
  const env = ctx.env || process.env
  if (!ctx.identity?.authenticated) { ctx.send(ctx.res, 401, { code: 'AUTHENTICATION_REQUIRED', message: 'Authentication is required.' }); return true }
  if (!ctx.identity?.tenantId) { ctx.send(ctx.res, 403, { code: 'TENANT_CONTEXT_REQUIRED', message: 'A server-resolved tenant context is required.' }); return true }
  try {
    const service = await queryService(ctx)
    const identity = { identity: ctx.identity }
    let result
    if (detail) result = await service.getReceivingDetail({ receivingDocumentId: decodeURIComponent(detail[1]) }, identity)
    if (preview) {
      const operation = String(ctx.url.searchParams.get('operation') || '')
      const capabilityId = operation === 'reverse' ? 'receiving-reversal' : 'receiving-posting'
      if (!capabilityForEnvironment(capabilityId, env)?.enabled) { sendCapabilityUnavailable(ctx, capabilityId); return true }
      result = await service.getReceivingImpactPreview({ receivingDocumentId: decodeURIComponent(preview[1]), operation }, identity)
    }
    if (evidence) result = await service.getReceivingEvidenceTimeline({ receivingDocumentId: decodeURIComponent(evidence[1]) }, identity)
    if (links) result = await service.getReceivingSmartLinks({ receivingDocumentId: decodeURIComponent(links[1]) }, identity)
    if (reconciliation) result = await service.getReceivingReconciliation({ receivingDocumentId: decodeURIComponent(reconciliation[1]) }, identity)
    if (poSummary) result = await service.getPurchaseOrderReceivingSummary({ purchaseOrderId: decodeURIComponent(poSummary[1]) }, identity)
    ctx.send(ctx.res, 200, result)
  } catch (error) { sendStructuredError(ctx, error) }
  return true
}

async function handleFormalReceivingCommand(ctx) {
  const match = ctx.url.pathname.match(/^\/api\/procurement\/receiving\/([^/]+)\/(post|reverse)$/)
  if (ctx.req.method !== 'POST' || !match) return false
  const receivingDocumentId = decodeURIComponent(match[1])
  const operation = match[2]
  const capabilityId = operation === 'post' ? 'receiving-posting' : 'receiving-reversal'
  const capability = capabilityForEnvironment(capabilityId, ctx.env || process.env)
  if (!capability?.enabled) {
    sendCapabilityUnavailable(ctx, capabilityId)
    return true
  }
  const body = await ctx.readBody(ctx.req)
  const idempotencyKey = String(body.idempotencyKey || ctx.req.headers?.['idempotency-key'] || '').trim()
  try {
    const service = await commandService(ctx)
    const result = operation === 'post'
      ? await service.postReceiving({ receivingDocumentId, idempotencyKey, expectedVersion: body.expectedVersion }, { identity: ctx.identity })
      : await service.reverseReceiving({ receivingDocumentId, idempotencyKey, reason: body.reason }, { identity: ctx.identity })
    ctx.send(ctx.res, 200, result)
  } catch (error) {
    if (!(error instanceof ReceivingCommandError) && error?.name !== 'AuthorizationError') throw error
    ctx.send(ctx.res, error.status || 400, {
      code: error.code || 'RECEIVING_COMMAND_FAILED',
      message: error.message,
      ...(error.details ? { details: error.details } : {}),
    })
  }
  return true
}


// Desktop receiving: list, create, revise and submit drafts through the same
// draft core as the mobile facade, then post through the posting service.
// Drafting belongs to receiving posting, so only that capability gates it.
const DESKTOP = RECEIVING_DRAFT_CHANNELS.desktop

async function draftService(ctx) {
  if (ctx.receivingDraftService) return ctx.receivingDraftService
  return createReceivingDraftCommandService({ prisma: await getPrismaClient(ctx.env || process.env) })
}

async function handleDesktopReceiving(ctx) {
  const path = ctx.url.pathname
  const method = ctx.req.method
  const list = method === 'GET' && path === '/api/procurement/receiving'
  const receivable = method === 'GET' ? path.match(/^\/api\/procurement\/purchase-orders\/([^/]+)\/receivable-lines$/) : null
  const create = method === 'POST' && path === '/api/procurement/receiving'
  const revise = method === 'PATCH' ? path.match(/^\/api\/procurement\/receiving\/([^/]+)$/) : null
  const submit = method === 'POST' ? path.match(/^\/api\/procurement\/receiving\/([^/]+)\/submit$/) : null
  if (!list && !receivable && !create && !revise && !submit) return false
  if (!ctx.identity?.authenticated) { ctx.send(ctx.res, 401, { code: 'AUTHENTICATION_REQUIRED', message: 'Authentication is required.' }); return true }
  if (!ctx.identity?.tenantId) { ctx.send(ctx.res, 403, { code: 'TENANT_CONTEXT_REQUIRED', message: 'A server-resolved tenant context is required.' }); return true }
  if ((create || revise || submit) && !capabilityForEnvironment('receiving-posting', ctx.env || process.env)?.enabled) { sendCapabilityUnavailable(ctx, 'receiving-posting'); return true }
  try {
    const service = await draftService(ctx)
    if (list) { ctx.send(ctx.res, 200, await service.listReceivingDocuments({ purchaseOrderId: ctx.url.searchParams.get('poId') || '' }, ctx)); return true }
    if (receivable) {
      const result = await service.listReceivablePurchaseOrders({ purchaseOrderId: decodeURIComponent(receivable[1]) }, ctx, DESKTOP)
      if (!result.items.length) { ctx.send(ctx.res, 404, { code: 'PURCHASE_ORDER_NOT_FOUND', message: 'Purchase order was not found.' }); return true }
      ctx.send(ctx.res, 200, { purchaseOrder: result.items[0], warehouses: result.warehouses })
      return true
    }
    const body = (await ctx.readBody(ctx.req)) || {}
    const idempotencyKey = String(body.idempotencyKey || ctx.req.headers?.['idempotency-key'] || '').trim()
    if (create) { ctx.send(ctx.res, 201, await service.createDraft({ ...body, idempotencyKey }, ctx, DESKTOP)); return true }
    const id = decodeURIComponent((revise || submit)[1])
    // Without a key, a resend of the same change at the same version is the
    // same command.
    const change = revise ? `:${createHash('sha256').update(JSON.stringify(body)).digest('hex').slice(0, 16)}` : ''
    const input = { ...body, idempotencyKey: idempotencyKey || `desktop.${revise ? 'revise' : 'submit'}:${id}:v${body.expectedVersion}${change}` }
    ctx.send(ctx.res, 200, revise ? await service.reviseDraft(id, input, ctx, DESKTOP) : await service.submitDraft(id, input, ctx, DESKTOP))
  } catch (error) { sendStructuredError(ctx, error) }
  return true
}

export async function handleReceivingRoute(ctx) {
  const { req, res, url, send, repositories, identity } = ctx

  if (await handleFormalReceivingRead(ctx)) return true
  if (await handleFormalReceivingCommand(ctx)) return true
  if (await handleDesktopReceiving(ctx)) return true

  if (req.method === 'GET' && url.pathname === '/api/receiving-docs') {
    if (!identity?.authenticated || !identity.tenantId) return send(res, 401, { code: 'TENANT_CONTEXT_REQUIRED', message: 'An authenticated tenant context is required.' }) || true
    if (!repositories?.procurementRead?.snapshot) return send(res, 503, { code: 'FLOWCHAIN_POSTGRESQL_READ_MODEL_UNAVAILABLE', message: 'The PostgreSQL procurement read model is unavailable.' }) || true
    const snapshot = await repositories.procurementRead.snapshot({ tenantId: identity.tenantId })
    return send(res, 200, snapshot.receivingDocs) || true
  }

  // POST and PATCH /api/receiving-docs are retired and have no handler: the
  // database-mode gate refuses them as legacy mutations. Receipts are drafted,
  // submitted and posted through /api/procurement/receiving.
  return false
}
