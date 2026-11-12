import { buildHomeOverview, createBusinessReadContextService, todayWorkOf } from '../services/business-read-context-service.mjs'
import { syncTodayDecisions } from '../services/decision-item-service.mjs'
import { can } from '../auth/authorization-service.mjs'
import { DECISION_PERMISSION } from '../domain/decision-items.mjs'
import { SUPPLIER_EMAIL_PERMISSION, supplierEmailDelivery } from '../domain/supplier-follow-up-email.mjs'
import { supplierEmailSettingOn } from '../services/supplier-follow-up-email-service.mjs'
import { resolveProvisionedActor } from '../domain/pilot-identity.mjs'
import { readTenantTimezone } from '../domain/tenant-timezone.mjs'
import { tenantCalendarDay } from '../domain/tenant-calendar-day.mjs'
import { reportReadAccess, scopeBusinessContext, sendReadAccessError } from '../domain/report-read-access.mjs'
import { databaseClient, readTodayWorkSources, todayHiddenWork } from '../domain/today-work-read-service.mjs'

// Today for the signed-in reader: their scoped business context, Today's
// sources and every row of Today's work, by the pages' own rules, on the
// workspace day (server/domain/today-work.mjs). The decision routes read the
// same rows, so a decision is only taken on a row its reader sees.
export async function readTodayForReader(ctx) {
  const service = createBusinessReadContextService({ repositories: ctx.repositories, dataMode: ctx.dataMode })
  // Scope every read to the signed-in tenant, as readBusinessContext already
  // does. Without it each repository applies its own fallback, and those
  // fallbacks disagree, so one response could mix two tenants.
  // Each collection and amount as the signed-in reader may see it.
  const access = await reportReadAccess(ctx)
  const raw = await service.read({ tenantId: ctx.identity?.tenantId, warehouseIds: access.warehouseIds })
  const context = scopeBusinessContext(raw, access)
  const timeZone = await readTenantTimezone(ctx)
  const now = ctx.homeOverviewNow instanceof Date ? ctx.homeOverviewNow : new Date()
  const today = tenantCalendarDay(now, timeZone)
  const read = await readTodayWorkSources(ctx, { access, rawContext: raw, now, today, timeZone })
  const hidden = todayHiddenWork(access, ctx.env || process.env)
  const work = todayWorkOf(context, read.sources, { now, timeZone })
  return { access, raw, context, timeZone, now, today, read, hidden, work }
}

// The limitations that say some of Today's rows could not be read, so an
// item whose row is missing is not closed (closableAreas).
export function todayReadLimitations(reader) {
  return [
    ...(reader.context.dataLimitations || []),
    ...(reader.read.limitations || []),
    ...(reader.read.sources?.reorder?.scope?.kind === 'reader_warehouses' ? ['reorder_not_checked_for_warehouse_scope'] : []),
  ]
}

// The reader's decision items, raised and closed from this read. A failure
// leaves Today as it was before decision items ({ available: false }).
async function todayDecisions(ctx, reader) {
  try {
    const prisma = await databaseClient(ctx)
    const tenantId = String(ctx.identity?.tenantId || '').trim()
    if (!prisma?.decisionItem || !tenantId) return { available: false }
    let canDecide = false
    let canSend = false
    try {
      const actor = await resolveProvisionedActor(prisma, ctx.identity)
      canDecide = can({ actor, permission: DECISION_PERMISSION, tenantId: actor.tenantId })
      canSend = can({ actor, permission: SUPPLIER_EMAIL_PERMISSION, tenantId: actor.tenantId })
    } catch { canDecide = false }
    const decisions = await syncTodayDecisions({
      prisma, tenantId, rows: reader.work.all, today: reader.today, now: reader.now, timeZone: reader.timeZone,
      hidden: reader.hidden, limitations: todayReadLimitations(reader), context: reader.context, sources: reader.read.sources, canDecide,
    })
    // Whether the follow-up cards may email the supplier
    // (server/services/supplier-follow-up-email-service.mjs), and whether an
    // email would only reach the local outbox.
    const delivery = supplierEmailDelivery(ctx.env || process.env)
    const enabled = await supplierEmailSettingOn(prisma, tenantId).catch(() => false)
    return { ...decisions, supplierEmail: { enabled, canSend: enabled && canSend && delivery !== 'none', outbox: delivery === 'outbox' } }
  } catch (error) {
    ctx.reportError?.(error)
    return { available: false }
  }
}

export async function handleBusinessReadContextRoute(ctx) {
  const { req, res, url, send, repositories, dataMode } = ctx
  if (req.method !== 'GET') return false
  if (!['/api/business/read-context', '/api/home/overview'].includes(url.pathname)) return false
  if (url.pathname !== '/api/home/overview') {
    const service = createBusinessReadContextService({ repositories, dataMode })
    let context
    try {
      const access = await reportReadAccess(ctx)
      const raw = await service.read({ tenantId: ctx.identity?.tenantId, warehouseIds: access.warehouseIds })
      context = scopeBusinessContext(raw, access)
    } catch (error) { sendReadAccessError(ctx, error); return true }
    send(res, 200, context)
    return true
  }
  let reader
  try {
    reader = await readTodayForReader(ctx)
  } catch (error) { sendReadAccessError(ctx, error); return true }
  const decisions = await todayDecisions(ctx, reader)
  send(res, 200, buildHomeOverview(reader.context, { now: reader.now, timeZone: reader.timeZone, ...reader.read, hidden: reader.hidden, work: reader.work, decisions }))
  return true
}
