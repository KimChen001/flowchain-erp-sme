import { createIngestRateLimiter } from '../domain/integration-tokens.mjs'
import { getPrismaClient } from '../persistence/prisma-client.mjs'
import { createSupplierReplyIngestService, supplierReplyIngestEnabled, supplierReplyIngestPerHour } from '../services/supplier-reply-ingest.mjs'
import { createSupplierReplyService } from '../services/supplier-reply-service.mjs'

// Supplier replies without pasting (docs/supplier-reply-ingest-api.md):
//   POST /api/integrations/supplier-replies                                  a forwarder, with a token
//   GET  /api/settings/integrations/supplier-reply-tokens                    admins: the tokens
//   POST /api/settings/integrations/supplier-reply-tokens                    admins: a new token
//   POST /api/settings/integrations/supplier-reply-tokens/:tokenId/revoke    admins: revoke one
// All four answer 404 unless FLOWCHAIN_SUPPLIER_REPLY_INGEST=on. The first
// is open past the session gate (api-access-gate.mjs) and takes only its
// bearer token: a browser session never counts there. The others need a
// session with settings.workspace.manage.
const INGEST_PATH = '/api/integrations/supplier-replies'
const TOKENS_PATH = '/api/settings/integrations/supplier-reply-tokens'
const REVOKE_PATH = /^\/api\/settings\/integrations\/supplier-reply-tokens\/([^/]+)\/revoke$/

// One count per server process, so the hourly limit holds across requests.
let limiter = null
let limiterSize = null
function sharedLimiter(env) {
  const size = supplierReplyIngestPerHour(env)
  if (!limiter || limiterSize !== size) {
    limiter = createIngestRateLimiter({ limit: size })
    limiterSize = size
  }
  return limiter
}

async function serviceOf(ctx) {
  if (ctx.repositories?.supplierReplyIngest) return ctx.repositories.supplierReplyIngest
  const env = ctx.env || process.env
  const replies = ctx.repositories?.supplierReplies || createSupplierReplyService({ procurement: ctx.repositories?.procurementAuthority, env })
  return createSupplierReplyIngestService({ prisma: await getPrismaClient(env), replies, env, limiter: sharedLimiter(env) })
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

export async function handleSupplierReplyIngestRoute(ctx) {
  const { req, url } = ctx
  const revoke = url.pathname.match(REVOKE_PATH)
  if (url.pathname !== INGEST_PATH && url.pathname !== TOKENS_PATH && !revoke) return false
  if (!supplierReplyIngestEnabled(ctx.env || process.env)) return false
  if (req.method === 'POST' && url.pathname === INGEST_PATH) {
    return answer(ctx, async (service) => service.ingest({ authorization: req.headers?.authorization, body: await bodyOf(ctx) }))
  }
  // The admin routes: a signed-in session (the gate has checked it is bound to a workspace).
  if (req.method === 'GET' && url.pathname === TOKENS_PATH) return answer(ctx, async (service) => ({ status: 200, body: await service.listTokens(ctx.identity) }))
  if (req.method === 'POST' && url.pathname === TOKENS_PATH) return answer(ctx, async (service) => ({ status: 201, body: await service.createToken(ctx.identity, await bodyOf(ctx)) }))
  if (req.method === 'POST' && revoke) return answer(ctx, async (service) => ({ status: 200, body: await service.revokeToken(ctx.identity, decodeURIComponent(revoke[1])) }))
  return false
}
