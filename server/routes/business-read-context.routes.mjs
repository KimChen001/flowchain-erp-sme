import { buildHomeOverview, createBusinessReadContextService } from '../services/business-read-context-service.mjs'
import { readTenantTimezone } from '../domain/tenant-timezone.mjs'
import { reportReadAccess, scopeBusinessContext, sendReadAccessError } from '../domain/report-read-access.mjs'

export async function handleBusinessReadContextRoute(ctx) {
  const { req, res, url, send, repositories, dataMode } = ctx
  if (req.method !== 'GET') return false
  if (!['/api/business/read-context', '/api/home/overview'].includes(url.pathname)) return false
  const service = createBusinessReadContextService({ repositories, dataMode })
  // Scope every read to the signed-in tenant, as readBusinessContext already
  // does. Without it each repository applies its own fallback, and those
  // fallbacks disagree, so one response could mix two tenants.
  // Each collection and amount as the signed-in reader may see it.
  let context
  try { context = scopeBusinessContext(await service.read({ tenantId: ctx.identity?.tenantId }), await reportReadAccess(ctx)) } catch (error) { sendReadAccessError(ctx, error); return true }
  send(res, 200, url.pathname === '/api/home/overview' ? buildHomeOverview(context, { timeZone: await readTenantTimezone(ctx) }) : context)
  return true
}
