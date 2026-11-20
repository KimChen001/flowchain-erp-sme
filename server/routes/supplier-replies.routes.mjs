import { createSupplierReplyService } from '../services/supplier-reply-service.mjs'

// Supplier replies on a purchase order (docs/supplier-reply-dates-design.md;
// shapes and paths in shared/supplier-reply-contract.mjs):
//   GET  /api/procurement/orders/:id/supplier-replies                   list
//   POST /api/procurement/orders/:id/supplier-replies                   paste
//   POST /api/procurement/orders/:id/supplier-replies/:replyId/record   record
//   POST /api/procurement/orders/:id/supplier-replies/:replyId/dismiss  dismiss
//   POST /api/procurement/orders/:id/supplier-replies/:replyId/not-now  not now
// Permissions are checked in the service (supplier-reply-service.mjs).
const ACTIONS = Object.freeze({ record: 'recordReply', dismiss: 'dismissReply', 'not-now': 'notNowReply' })

const service = (ctx) => ctx.repositories?.supplierReplies
  || createSupplierReplyService({ procurement: ctx.repositories?.procurementAuthority, env: ctx.env || process.env })

async function bodyOf(ctx, { idempotent = false } = {}) {
  let body
  try { body = await ctx.readBody(ctx.req) } catch (error) {
    if (error instanceof SyntaxError) throw Object.assign(new Error('The request body must be a JSON object.'), { status: 400, code: 'SUPPLIER_REPLY_INVALID_BODY' })
    throw error
  }
  const object = body && typeof body === 'object' && !Array.isArray(body) ? body : {}
  const header = String(ctx.req.headers?.['idempotency-key'] || '').trim()
  return idempotent && header && !object.idempotencyKey ? { ...object, idempotencyKey: header } : object
}

// Runs one call and sends its result, or the error's status and code.
async function answer(ctx, status, run) {
  const { res, send } = ctx
  if (!ctx.identity?.authenticated || !ctx.identity.tenantId) {
    send(res, 401, { code: 'TENANT_CONTEXT_REQUIRED', message: 'An authenticated tenant context is required.', details: [] })
    return true
  }
  try {
    send(res, status, await run(service(ctx)))
  } catch (error) {
    // Serializable transactions that lose a race are safe to retry.
    if (error?.code === 'P2034') send(res, 409, { code: 'TRANSACTION_CONFLICT', message: 'Another change landed at the same time. Reload and try again.', details: [] })
    else if (!error?.status) throw error
    else {
      const conflict = error.details && typeof error.details === 'object' && !Array.isArray(error.details) ? error.details : {}
      send(res, error.status, { code: error.code || 'SUPPLIER_REPLY_FAILED', message: error.message, details: error.details || [], ...['entityId', 'currentVersion', 'expectedVersion'].reduce((out, key) => (conflict[key] === undefined ? out : { ...out, [key]: conflict[key] }), {}) })
    }
  }
  return true
}

export async function handleSupplierRepliesRoute(ctx) {
  const { req, url } = ctx
  const collection = url.pathname.match(/^\/api\/procurement\/orders\/([^/]+)\/supplier-replies$/)
  const action = url.pathname.match(/^\/api\/procurement\/orders\/([^/]+)\/supplier-replies\/([^/]+)\/(record|dismiss|not-now)$/)
  if (req.method === 'GET' && collection) return answer(ctx, 200, (replies) => replies.listReplies(decodeURIComponent(collection[1]), ctx))
  if (req.method === 'POST' && collection) {
    // The reading stops when the person goes away (the connection closes
    // before the answer is written); the reply is still kept.
    const reading = new AbortController()
    ctx.res?.once?.('close', () => { if (!ctx.res.writableFinished) reading.abort() })
    return answer(ctx, 201, async (replies) => replies.pasteReply(decodeURIComponent(collection[1]), await bodyOf(ctx), ctx, { signal: reading.signal }))
  }
  if (req.method === 'POST' && action) {
    return answer(ctx, 200, async (replies) => replies[ACTIONS[action[3]]](decodeURIComponent(action[1]), decodeURIComponent(action[2]), await bodyOf(ctx, { idempotent: action[3] === 'record' }), ctx))
  }
  return false
}
