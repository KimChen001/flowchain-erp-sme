import { createSupplierReplyService } from '../services/supplier-reply-service.mjs'
import { createSupplierReplyStockReadService } from '../services/supplier-reply-stock-read-service.mjs'

// The supplier reply card's stock line (shared/supplier-reply-stock-contract.mjs):
//   GET /api/procurement/orders/:id/supplier-replies/:replyId/stock?dates=...
// Permissions are checked in the read service, through the reply list's read.

const stockService = (ctx) => ctx.repositories?.supplierReplyStock
  || createSupplierReplyStockReadService({ replies: ctx.repositories?.supplierReplies || createSupplierReplyService({ procurement: ctx.repositories?.procurementAuthority, env: ctx.env || process.env }) })

export async function handleSupplierReplyStockRoute(ctx) {
  const { req, url, res, send } = ctx
  const match = url.pathname.match(/^\/api\/procurement\/orders\/([^/]+)\/supplier-replies\/([^/]+)\/stock$/)
  if (!match || req.method !== 'GET') return false
  if (!ctx.identity?.authenticated || !ctx.identity.tenantId) {
    send(res, 401, { code: 'TENANT_CONTEXT_REQUIRED', message: 'An authenticated tenant context is required.', details: [] })
    return true
  }
  try {
    send(res, 200, await stockService(ctx).read(decodeURIComponent(match[1]), decodeURIComponent(match[2]), { dates: url.searchParams.get('dates') }, ctx))
  } catch (error) {
    if (!error?.status) throw error
    send(res, error.status, { code: error.code || 'SUPPLIER_REPLY_FAILED', message: error.message, details: error.details || [] })
  }
  return true
}
