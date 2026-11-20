import { createSupplierReplyExportService } from '../services/supplier-reply-export.mjs'
import { getPrismaClient } from '../persistence/prisma-client.mjs'

// GET /api/admin/supplier-reply-export?from=YYYY-MM-DD&to=YYYY-MM-DD[&language=zh-CN]
// The supplier reply outcome export (supplier-reply-export.mjs): needs
// settings.export.read and procurement.purchase_order.read; the window
// defaults to the last 90 days; language sets the About sheet's notes.
export async function handleSupplierReplyExportRoute(ctx) {
  if (ctx.req.method !== 'GET' || ctx.url.pathname !== '/api/admin/supplier-reply-export') return false
  try {
    const service = ctx.repositories?.supplierReplyExport || createSupplierReplyExportService({ prisma: await getPrismaClient(ctx.env || process.env) })
    const query = { from: ctx.url.searchParams.get('from'), to: ctx.url.searchParams.get('to'), language: ctx.url.searchParams.get('language') }
    ctx.send(ctx.res, 200, await service.exportOutcomes(query, ctx.identity))
  } catch (error) {
    if (!error?.status || !error?.code) throw error
    ctx.send(ctx.res, error.status, { code: error.code, message: error.message })
  }
  return true
}
