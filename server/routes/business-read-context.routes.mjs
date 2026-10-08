import { buildHomeOverview, createBusinessReadContextService } from '../services/business-read-context-service.mjs'
import { readTenantTimezone } from '../domain/tenant-timezone.mjs'
import { tenantCalendarDay } from '../domain/tenant-calendar-day.mjs'
import { reportReadAccess, scopeBusinessContext, sendReadAccessError } from '../domain/report-read-access.mjs'
import { readTodayWorkSources, todayHiddenWork } from '../domain/today-work-read-service.mjs'

export async function handleBusinessReadContextRoute(ctx) {
  const { req, res, url, send, repositories, dataMode } = ctx
  if (req.method !== 'GET') return false
  if (!['/api/business/read-context', '/api/home/overview'].includes(url.pathname)) return false
  const service = createBusinessReadContextService({ repositories, dataMode })
  // Scope every read to the signed-in tenant, as readBusinessContext already
  // does. Without it each repository applies its own fallback, and those
  // fallbacks disagree, so one response could mix two tenants.
  // Each collection and amount as the signed-in reader may see it.
  let access, raw, context
  try {
    access = await reportReadAccess(ctx)
    raw = await service.read({ tenantId: ctx.identity?.tenantId, warehouseIds: access.warehouseIds })
    context = scopeBusinessContext(raw, access)
  } catch (error) { sendReadAccessError(ctx, error); return true }
  if (url.pathname !== '/api/home/overview') {
    send(res, 200, context)
    return true
  }
  // Today: the work the reader may open, by the pages' own rules, on the
  // workspace day (server/domain/today-work.mjs).
  const timeZone = await readTenantTimezone(ctx)
  const now = ctx.homeOverviewNow instanceof Date ? ctx.homeOverviewNow : new Date()
  const read = await readTodayWorkSources(ctx, { access, rawContext: raw, now, today: tenantCalendarDay(now, timeZone), timeZone })
  send(res, 200, buildHomeOverview(context, { now, timeZone, ...read, hidden: todayHiddenWork(access) }))
  return true
}
