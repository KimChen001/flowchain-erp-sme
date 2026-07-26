import { capabilityForEnvironment } from '../domain/capability-registry.mjs'
import { createOutboundPostingCommandService, OutboundCommandError } from '../domain/outbound-posting-command-service.mjs'
import { createOutboundQueryService, OutboundQueryError } from '../domain/outbound-query-service.mjs'
import { PilotIdentityError } from '../domain/pilot-identity.mjs'
import { getPrismaClient } from '../persistence/prisma-client.mjs'

const capabilityIds = ['sales-reservation', 'sales-shipment-draft', 'sales-shipment-posting', 'sales-shipment-reversal']
const envCapabilities = (env) => Object.fromEntries(capabilityIds.map((id) => [id, capabilityForEnvironment(id, env)]))

function unavailable(ctx, capabilityId) {
  ctx.send(ctx.res, 409, { code: 'OUTBOUND_CAPABILITY_NOT_AVAILABLE', message: `${capabilityId} requires database persistence and explicit server enablement.`, details: { capability: capabilityId } })
}

function structuredError(ctx, error) {
  if (!(error instanceof OutboundCommandError) && !(error instanceof OutboundQueryError) && !(error instanceof PilotIdentityError) && error?.name !== 'AuthorizationError') throw error
  ctx.send(ctx.res, error.status || 400, { code: error.code || 'OUTBOUND_COMMAND_FAILED', message: error.message, ...(error.details ? { details: error.details } : {}) })
}

async function services(ctx, { needQuery, needCommand }) {
  const env = ctx.env || process.env
  const needsPrisma = (needQuery && !ctx.outboundQueryService) || (needCommand && !ctx.outboundCommandService)
  const prisma = needsPrisma ? (ctx.outboundPrisma || await getPrismaClient(env)) : ctx.outboundPrisma
  return {
    query: needQuery ? (ctx.outboundQueryService || createOutboundQueryService({ prisma, capabilities: envCapabilities(env) })) : null,
    command: needCommand ? (ctx.outboundCommandService || createOutboundPostingCommandService({ prisma, env })) : null,
  }
}

function ensureDatabaseMode(ctx) {
  return true
}

function ensureIdentity(ctx) {
  if (ctx.identity?.authenticated) return true
  ctx.send(ctx.res, 401, { code: 'AUTHENTICATION_REQUIRED', message: 'Authentication is required.' })
  return false
}

export async function handleOutboundRoute(ctx) {
  const path = ctx.url.pathname
  const orderState = path.match(/^\/api\/sales\/orders\/([^/]+)\/outbound-state$/)
  const shipmentState = path.match(/^\/api\/sales\/shipments\/([^/]+)\/posting-state$/)
  const reservePreview = path.match(/^\/api\/sales\/orders\/([^/]+)\/reservations\/preview$/)
  const reserve = path.match(/^\/api\/sales\/orders\/([^/]+)\/reservations\/reserve$/)
  const releasePreview = path.match(/^\/api\/sales\/orders\/([^/]+)\/reservations\/release-preview$/)
  const release = path.match(/^\/api\/sales\/orders\/([^/]+)\/reservations\/release$/)
  const draftPreview = path.match(/^\/api\/sales\/orders\/([^/]+)\/shipments\/preview$/)
  const draft = path.match(/^\/api\/sales\/orders\/([^/]+)\/shipments$/)
  const cancelPreview = path.match(/^\/api\/sales\/shipments\/([^/]+)\/cancel-preview$/)
  const cancel = path.match(/^\/api\/sales\/shipments\/([^/]+)\/cancel$/)
  const postPreview = path.match(/^\/api\/sales\/shipments\/([^/]+)\/post-preview$/)
  const post = path.match(/^\/api\/sales\/shipments\/([^/]+)\/post$/)
  const reversePreview = path.match(/^\/api\/sales\/shipments\/([^/]+)\/reverse-preview$/)
  const reverse = path.match(/^\/api\/sales\/shipments\/([^/]+)\/reverse$/)
  const matched = orderState || shipmentState || reservePreview || reserve || releasePreview || release || draftPreview || draft || cancelPreview || cancel || postPreview || post || reversePreview || reverse
  if (!matched) return false
  if ((orderState || shipmentState) ? ctx.req.method !== 'GET' : ctx.req.method !== 'POST') return false
  if (!ensureDatabaseMode(ctx) || !ensureIdentity(ctx)) return true

  const env = ctx.env || process.env
  const previewCapability = reservePreview || releasePreview ? 'sales-reservation' : draftPreview || cancelPreview ? 'sales-shipment-draft' : postPreview ? 'sales-shipment-posting' : reversePreview ? 'sales-shipment-reversal' : null
  if (previewCapability && !capabilityForEnvironment(previewCapability, env)?.enabled) { unavailable(ctx, previewCapability); return true }
  const commandCapability = reserve || release ? 'sales-reservation' : draft || cancel ? 'sales-shipment-draft' : post ? 'sales-shipment-posting' : reverse ? 'sales-shipment-reversal' : null
  if (commandCapability && !capabilityForEnvironment(commandCapability, env)?.enabled) { unavailable(ctx, commandCapability); return true }
  try {
    const needQuery = Boolean(orderState || shipmentState || previewCapability)
    const needCommand = Boolean(commandCapability)
    const { query, command } = await services(ctx, { needQuery, needCommand })
    const context = { identity: ctx.identity }
    if (orderState) { ctx.send(ctx.res, 200, await query.getSalesOrderOutboundState({ salesOrderId: decodeURIComponent(orderState[1]) }, context)); return true }
    if (shipmentState) { ctx.send(ctx.res, 200, await query.getShipmentPostingState({ shipmentId: decodeURIComponent(shipmentState[1]) }, context)); return true }
    const body = await ctx.readBody(ctx.req)
    if (reservePreview) ctx.send(ctx.res, 200, await query.previewSalesOrderReservation({ salesOrderId: decodeURIComponent(reservePreview[1]), allocations: body.allocations || [] }, context))
    else if (releasePreview) ctx.send(ctx.res, 200, await query.previewReservationRelease({ salesOrderId: decodeURIComponent(releasePreview[1]), reason: body.reason, releases: body.releases || [] }, context))
    else if (draftPreview) ctx.send(ctx.res, 200, await query.previewShipmentDraft({ salesOrderId: decodeURIComponent(draftPreview[1]), shipmentNumber: body.shipmentNumber, lines: body.lines || [] }, context))
    else if (cancelPreview) ctx.send(ctx.res, 200, await query.previewShipmentCancellation({ shipmentId: decodeURIComponent(cancelPreview[1]), reason: body.reason }, context))
    else if (postPreview) ctx.send(ctx.res, 200, await query.previewShipmentPosting({ shipmentId: decodeURIComponent(postPreview[1]) }, context))
    else if (reversePreview) ctx.send(ctx.res, 200, await query.previewShipmentReversal({ shipmentId: decodeURIComponent(reversePreview[1]), reason: body.reason }, context))
    else {
      const idempotencyKey = String(body.idempotencyKey || ctx.req.headers?.['idempotency-key'] || '').trim()
      if (reserve) ctx.send(ctx.res, 200, await command.reserveSalesOrderInventory({ salesOrderId: decodeURIComponent(reserve[1]), expectedOrderVersion: body.expectedOrderVersion, allocations: body.allocations || [], idempotencyKey }, { identity: ctx.identity }))
      else if (release) ctx.send(ctx.res, 200, await command.releaseSalesOrderReservation({ salesOrderId: decodeURIComponent(release[1]), expectedOrderVersion: body.expectedOrderVersion, releases: body.releases || [], reason: body.reason, idempotencyKey }, { identity: ctx.identity }))
      else if (draft) ctx.send(ctx.res, 201, await command.createShipmentDraft({ salesOrderId: decodeURIComponent(draft[1]), shipmentNumber: body.shipmentNumber, expectedOrderVersion: body.expectedOrderVersion, lines: body.lines || [], idempotencyKey }, { identity: ctx.identity }))
      else if (cancel) ctx.send(ctx.res, 200, await command.cancelShipmentDraft({ shipmentId: decodeURIComponent(cancel[1]), expectedShipmentVersion: body.expectedShipmentVersion, reason: body.reason, idempotencyKey }, { identity: ctx.identity }))
      else if (post) ctx.send(ctx.res, 200, await command.postShipment({ shipmentId: decodeURIComponent(post[1]), expectedShipmentVersion: body.expectedShipmentVersion, idempotencyKey }, { identity: ctx.identity }))
      else if (reverse) ctx.send(ctx.res, 200, await command.reverseShipment({ shipmentId: decodeURIComponent(reverse[1]), expectedShipmentVersion: body.expectedShipmentVersion, reason: body.reason, idempotencyKey }, { identity: ctx.identity }))
    }
  } catch (error) { structuredError(ctx, error) }
  return true
}
