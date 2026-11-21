import { getPrismaClient } from '../persistence/prisma-client.mjs'
import { createSupplierReplyIngestService, supplierReplyIngestEnabled } from '../services/supplier-reply-ingest.mjs'
import { createSupplierReplyService } from '../services/supplier-reply-service.mjs'

// Supplier replies without pasting (docs/supplier-reply-ingest-api.md):
//   POST /api/integrations/supplier-replies                                  a forwarder, with a token
//   GET  /api/settings/integrations/supplier-reply-tokens                    admins: the tokens
//   POST /api/settings/integrations/supplier-reply-tokens                    admins: a new token
//   POST /api/settings/integrations/supplier-reply-tokens/:tokenId/revoke    admins: revoke one
// All four answer 404 unless FLOWCHAIN_SUPPLIER_REPLY_INGEST=on. The first
// is open past the session gate (api-access-gate.mjs) and takes only its
// bearer token: a browser session never counts there, and the body is read
// only once the token is accepted. The others need a session with
// settings.workspace.manage.

async function serviceOf(ctx) {
  if (ctx.repositories?.supplierReplyIngest) return ctx.repositories.supplierReplyIngest
  const env = ctx.env || process.env
  const replies = ctx.repositories?.supplierReplies || createSupplierReplyService({ procurement: ctx.repositories?.procurementAuthority, env })
  return createSupplierReplyIngestService({ prisma: await getPrismaClient(env), replies, env })
}

async function bodyOf(ctx) {
  try {
    const body = await ctx.readBody(ctx.req)
    return body && typeof body === 'object' && !Array.isArray(body) ? body : {}
  } catch (error) {
    if (error instanceof SyntaxError) throw Object.assign(new Error('The request body must be a JSON object.'), { status: 400, code: 'SUPPLIER_REPLY_INGEST_INVALID_BODY' })
    throw error
  }
}

async function answer(ctx, run) {
  try {
    const { status, body } = await run(await serviceOf(ctx))
    ctx.send(ctx.res, status, body)
  } catch (error) {
    if (error?.code === 'P2034' || error?.code === 'P2002') {
      ctx.send(ctx.res, 409, { code: 'TRANSACTION_CONFLICT', message: 'Another change landed at the same time. Try again.', details: [] })
      return true
    }
    if (!error?.status) throw error
    const retry = error.code === 'SUPPLIER_REPLY_INGEST_RATE_LIMITED' ? (error.details || []).find((detail) => detail.field === 'retryAfterSeconds')?.code : null
    if (retry) ctx.res.setHeader?.('Retry-After', retry)
    ctx.send(ctx.res, error.status, { code: error.code || 'SUPPLIER_REPLY_INGEST_FAILED', message: error.message, details: error.details || [] })
  }
  return true
}

// A path segment, or null when its % escapes are malformed.
function segment(value) {
  try { return decodeURIComponent(value) } catch { return null }
}

export async function handleSupplierReplyIngestRoute(ctx) {
  const { req, url } = ctx
  const path = url.pathname
  if (!path.startsWith('/api/integrations/') && !path.startsWith('/api/settings/integrations/')) return false
  if (!supplierReplyIngestEnabled(ctx.env || process.env)) return false
  if (req.method === 'POST' && path === '/api/integrations/supplier-replies') {
    return answer(ctx, (service) => service.ingest({ authorization: req.headers?.authorization, readBody: () => bodyOf(ctx) }))
  }
  // The admin routes: a signed-in session (the gate has checked it is bound to a workspace).
  if (req.method === 'GET' && path === '/api/settings/integrations/supplier-reply-tokens') return answer(ctx, async (service) => ({ status: 200, body: await service.listTokens(ctx.identity) }))
  if (req.method === 'POST' && path === '/api/settings/integrations/supplier-reply-tokens') return answer(ctx, async (service) => ({ status: 201, body: await service.createToken(ctx.identity, await bodyOf(ctx)) }))
  const revoke = path.match(/^\/api\/settings\/integrations\/supplier-reply-tokens\/([^/]+)\/revoke$/)
  if (req.method === 'POST' && revoke) {
    const tokenId = segment(revoke[1])
    if (tokenId === null) {
      ctx.send(ctx.res, 404, { code: 'INTEGRATION_TOKEN_NOT_FOUND', message: 'No such token in this workspace.', details: [] })
      return true
    }
    return answer(ctx, async (service) => ({ status: 200, body: await service.revokeToken(ctx.identity, tokenId) }))
  }
  return false
}
