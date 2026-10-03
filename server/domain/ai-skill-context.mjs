import { getPrismaClient } from '../persistence/prisma-client.mjs'
import { resolveProvisionedActor } from './pilot-identity.mjs'
import { tenantCalendarDay } from './tenant-calendar-day.mjs'

export { tenantCalendarDay }

// Everything a workspace skill needs besides the business rows: the signed-in
// actor with their permissions, the tenant's locale, currency and timezone,
// and the clock. The actor always comes from the server-resolved identity,
// never from the request body.

const text = (value) => String(value ?? '').trim()

export class AiSkillError extends Error {
  constructor(code, message, status) {
    super(message)
    this.name = 'AiSkillError'
    this.code = code
    this.status = status
  }
}

export const AI_SKILL_TENANT_DEFAULTS = Object.freeze({ locale: 'en-US', currency: 'USD', timezone: 'America/New_York' })


async function prismaFor(ctx) {
  if (ctx.aiSkillPrisma) return ctx.aiSkillPrisma
  if (ctx.aiSkillActor) return null
  return await getPrismaClient(ctx.env || process.env)
}

export async function loadAiSkillContext(ctx = {}) {
  const identity = ctx.identity
  if (!identity?.authenticated) throw new AiSkillError('AUTHENTICATION_REQUIRED', 'Sign in to use the assistant.', 401)
  if (!text(identity.tenantId)) throw new AiSkillError('TENANT_CONTEXT_REQUIRED', 'A workspace is required to use the assistant.', 403)
  const prisma = await prismaFor(ctx)
  const actor = ctx.aiSkillActor || await resolveProvisionedActor(prisma, identity, { allowMissingTestActor: true })
  const tenantId = text(actor?.tenantId)
  if (!tenantId || tenantId !== text(identity.tenantId)) throw new AiSkillError('TENANT_CONTEXT_REQUIRED', 'A workspace is required to use the assistant.', 403)
  const stored = ctx.aiSkillTenant || (prisma ? await prisma.tenant.findUnique({ where: { id: tenantId }, select: { locale: true, currency: true, timezone: true } }) : null)
  const tenant = {
    locale: text(stored?.locale) || AI_SKILL_TENANT_DEFAULTS.locale,
    currency: text(stored?.currency) || AI_SKILL_TENANT_DEFAULTS.currency,
    timezone: text(stored?.timezone) || AI_SKILL_TENANT_DEFAULTS.timezone,
  }
  const now = ctx.aiSkillNow ? new Date(ctx.aiSkillNow) : new Date()
  if (!Number.isFinite(now.getTime())) throw new AiSkillError('AI_SKILL_CLOCK_INVALID', 'The assistant clock is not a valid date.', 500)
  return { actor, tenantId, tenant, now, today: tenantCalendarDay(now, tenant.timezone), prisma, routeContext: ctx }
}
