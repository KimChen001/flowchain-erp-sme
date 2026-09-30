import { getPrismaClient } from '../persistence/prisma-client.mjs'
import { DEFAULT_TENANT_TIMEZONE } from './tenant-calendar-day.mjs'

// The workspace timezone that decides a route's "today". A tenant without a
// stored timezone, or a runtime without the database, uses the default.
// ctx.tenantTimezone lets a caller that already knows it skip the read.
export async function readTenantTimezone(ctx = {}) {
  if (ctx.tenantTimezone) return ctx.tenantTimezone
  const tenantId = ctx.identity?.tenantId
  if (!ctx.repositories || !tenantId) return DEFAULT_TENANT_TIMEZONE
  try {
    const prisma = await getPrismaClient(ctx.env || process.env)
    const tenant = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { timezone: true } })
    return String(tenant?.timezone || '').trim() || DEFAULT_TENANT_TIMEZONE
  } catch {
    return DEFAULT_TENANT_TIMEZONE
  }
}
