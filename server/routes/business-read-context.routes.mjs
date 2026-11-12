import { createBusinessReadContextService } from '../services/business-read-context-service.mjs'
import { readHomeOverview } from '../services/today-read-service.mjs'
import { reportReadAccess, scopeBusinessContext, sendReadAccessError } from '../domain/report-read-access.mjs'

// GET /api/business/read-context: the reader's scoped business context.
// GET /api/home/overview: Today (server/services/today-read-service.mjs).
export async function handleBusinessReadContextRoute(ctx) {
  const { req, res, url, send, repositories, dataMode } = ctx
  if (req.method !== 'GET') return false
  if (!['/api/business/read-context', '/api/home/overview'].includes(url.pathname)) return false
  if (url.pathname !== '/api/home/overview') {
    const service = createBusinessReadContextService({ repositories, dataMode })
    let context
    try {
      // Scope every read to the signed-in tenant: without it each repository
      // applies its own fallback, and one response could mix two tenants.
      const access = await reportReadAccess(ctx)
      const raw = await service.read({ tenantId: ctx.identity?.tenantId, warehouseIds: access.warehouseIds })
      context = scopeBusinessContext(raw, access)
    } catch (error) { sendReadAccessError(ctx, error); return true }
    send(res, 200, context)
    return true
  }
  let overview
  try {
    overview = await readHomeOverview(ctx)
  } catch (error) { sendReadAccessError(ctx, error); return true }
  send(res, 200, overview)
  return true
}
