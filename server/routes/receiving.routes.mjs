import { capabilityForEnvironment } from '../domain/capability-registry.mjs'
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

export async function handleReceivingRoute(ctx) {
  const {
    req, res, url, db, send, readBody, event, todayLabel,
    normalizePurchaseOrders, postedReceivingStatuses, normalizeGrnLines,
    nextSequenceId, workflowDefinitions, applyReceivingToPoAndInventory,
    recordWorkflowCreation, actorFromBody, applyWorkflowTransition,
    normalizePurchaseOrder, recordValidationBlocked,
    postedGrnProtectedChangeError, warehouseIdFor, toNumber,
  } = ctx

  if (await handleFormalReceivingRead(ctx)) return true
  if (await handleFormalReceivingCommand(ctx)) return true

  if (req.method === 'GET' && url.pathname === '/api/receiving-docs') {
    normalizePurchaseOrders(db)
    return send(res, 200, (db.receivingDocs || []).map((grn) => {
      const po = db.purchaseOrders.find((item) => item.po === grn.po)
      if (po) normalizeGrnLines(grn, po, { assumeApplied: postedReceivingStatuses.has(grn.status) })
      return grn
    }))
  }

  if (req.method === 'POST' && url.pathname === '/api/receiving-docs') {
    const body = await readBody(req)
    const po = db.purchaseOrders.find((item) => item.po === body.po)
    if (!body.po || !po) return send(res, 400, { error: 'valid PO is required for receiving' })
    normalizePurchaseOrder(po)
    const grn = {
      grn: body.grn || nextSequenceId(db.receivingDocs, 'grn', 'GRN-202606-', 430),
      po: body.po,
      supplier: body.supplier || po?.supplier || '—',
      arrived: body.arrived || `${todayLabel()} ${new Date().getHours().toString().padStart(2, '0')}:${new Date().getMinutes().toString().padStart(2, '0')}`,
      dock: body.dock || '月台-02',
      receiver: body.receiver || '刘建华',
      items: Number(body.items || po?.items || 1),
      passed: Number(body.passed || 0),
      failed: Number(body.failed || 0),
      status: body.status || '质检中',
      warehouse: body.warehouse || '—',
      lines: Array.isArray(body.lines) ? body.lines : [],
      postedAt: '',
      postedBy: '',
      inventoryApplied: false,
      inventoryMovementIds: [],
    }
    if (!workflowDefinitions.receivingDoc.statuses.has(grn.status)) {
      return send(res, 400, { error: `invalid receiving status: ${grn.status}` })
    }
    normalizeGrnLines(grn, po, { assumeApplied: false })
    if (postedReceivingStatuses.has(grn.status)) {
      try {
        applyReceivingToPoAndInventory(db, grn, po, {
          allowOverReceipt: Boolean(body.allowOverReceipt),
          postedBy: body.postedBy || body.receiver,
        })
      } catch (error) {
        return send(res, error.status || 400, { error: error.message })
      }
    }
    try {
      recordWorkflowCreation(db, 'receivingDoc', grn, {
        actor: actorFromBody(body, grn.receiver || 'system'),
        source: 'receiving',
        reason: `Receiving document created for ${grn.po}`,
        metadata: { poId: grn.po, lineCount: grn.lines.length, inventoryApplied: grn.inventoryApplied },
      })
      if (po && po.status === '已发出') {
        applyWorkflowTransition(db, 'purchaseOrder', po, '部分到货', {
          action: 'purchase_order_receiving_started',
          actor: grn.receiver || 'system',
          source: 'receiving',
          reason: `GRN ${grn.grn} created`,
          metadata: { grnId: grn.grn, poId: po.po },
        })
      }
    } catch (error) {
      return send(res, error.status || 400, { error: error.message })
    }
    db.receivingDocs.unshift(grn)
    event(db, 'receiving_created', `收货单 ${grn.grn} 已创建`, grn.grn)
    throw Object.assign(new Error('Legacy receiving mutation was removed.'), { code: 'FLOWCHAIN_LEGACY_MUTATION_REMOVED', status: 501 })
    return send(res, 201, grn)
  }

  const grnMatch = url.pathname.match(/^\/api\/receiving-docs\/([^/]+)$/)
  if (req.method === 'PATCH' && grnMatch) {
    const grnId = decodeURIComponent(grnMatch[1])
    const body = await readBody(req)
    const grn = db.receivingDocs.find((item) => item.grn === grnId)
    if (!grn) return send(res, 404, { error: 'GRN not found' })
    const nextPassed = body.passed !== undefined ? Number(body.passed) : Number(grn.passed || 0)
    const nextFailed = body.failed !== undefined ? Number(body.failed) : Number(grn.failed || 0)
    const nextItems = body.items !== undefined ? Number(body.items) : Number(grn.items || 0)
    if (nextItems <= 0 || nextPassed < 0 || nextFailed < 0 || nextPassed + nextFailed > nextItems) {
      return send(res, 400, { error: 'receiving inspection quantities are invalid' })
    }
    const previousStatus = grn.status
    const requestedStatus = body.status || grn.status
    const po = db.purchaseOrders.find((item) => item.po === grn.po)
    if (!po) return send(res, 400, { error: 'valid PO is required for receiving update' })
    normalizePurchaseOrder(po)
    const wasPosted = postedReceivingStatuses.has(previousStatus)
    if (wasPosted && body.status !== undefined) {
      const message = `GRN ${grn.grn} is already posted; duplicate posting is blocked`
      recordValidationBlocked(db, 'receivingDoc', grn, 'post_grn', message, {
        actor: actorFromBody(body, grn.receiver || 'system'),
        source: 'receiving',
        requestedStatus,
      })
      throw Object.assign(new Error('Legacy receiving mutation was removed.'), { code: 'FLOWCHAIN_LEGACY_MUTATION_REMOVED', status: 501 })
      return send(res, 409, { error: message })
    }
    const protectedChangeError = postedGrnProtectedChangeError(grn, body, po)
    if (protectedChangeError) {
      recordValidationBlocked(db, 'receivingDoc', grn, 'edit_posted_grn', protectedChangeError, {
        actor: actorFromBody(body, grn.receiver || 'system'),
        source: 'receiving',
      })
      throw Object.assign(new Error('Legacy receiving mutation was removed.'), { code: 'FLOWCHAIN_LEGACY_MUTATION_REMOVED', status: 501 })
      return send(res, 400, { error: protectedChangeError })
    }
    const aggregatePatch = !Array.isArray(body.lines) && (
      body.passed !== undefined ||
      body.failed !== undefined ||
      body.items !== undefined ||
      body.sku !== undefined ||
      body.warehouse !== undefined
    )
    const patch = { ...body }
    delete patch.status
    Object.assign(grn, patch)
    grn.items = nextItems
    grn.passed = nextPassed
    grn.failed = nextFailed
    if (aggregatePatch) {
      grn.lines = [{
        poLineId: body.poLineId || grn.poLineId || '',
        sku: body.sku || grn.sku || po.sourceSku || '',
        itemName: body.sourceName || grn.sourceName || po.sourceName || '',
        receivedQty: postedReceivingStatuses.has(requestedStatus) ? nextPassed + nextFailed : nextItems,
        acceptedQty: nextPassed,
        rejectedQty: nextFailed,
        unit: grn.unit || po.unit || '',
        warehouseId: warehouseIdFor(grn.warehouse || body.warehouse || ''),
        appliedReceivedQty: wasPosted ? toNumber(grn.lines?.[0]?.appliedReceivedQty || 0) : 0,
        appliedAcceptedQty: wasPosted ? toNumber(grn.lines?.[0]?.appliedAcceptedQty || 0) : 0,
        appliedRejectedQty: wasPosted ? toNumber(grn.lines?.[0]?.appliedRejectedQty || 0) : 0,
      }]
    }
    try {
      applyWorkflowTransition(db, 'receivingDoc', grn, requestedStatus, {
        action: postedReceivingStatuses.has(requestedStatus) ? 'receiving_posted' : 'receiving_status_changed',
        actor: actorFromBody(body, grn.receiver || 'system'),
        source: 'receiving',
        reason: body.reason || '',
        metadata: { poId: grn.po, lineCount: Array.isArray(grn.lines) ? grn.lines.length : 0 },
      })
    } catch (error) {
      return send(res, error.status || 400, { error: error.message })
    }
    normalizeGrnLines(grn, po, { assumeApplied: wasPosted && !Array.isArray(grn.lines) })
    if (postedReceivingStatuses.has(grn.status)) {
      try {
        applyReceivingToPoAndInventory(db, grn, po, {
          allowOverReceipt: Boolean(body.allowOverReceipt),
          postedBy: body.postedBy || body.receiver,
        })
      } catch (error) {
        return send(res, error.status || 400, { error: error.message })
      }
    }
    event(db, 'receiving_status', `${grn.grn} 状态更新为 ${grn.status}`, grn.grn)
    throw Object.assign(new Error('Legacy receiving mutation was removed.'), { code: 'FLOWCHAIN_LEGACY_MUTATION_REMOVED', status: 501 })
    return send(res, 200, grn)
  }

  return false
}
