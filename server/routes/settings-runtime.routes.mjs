import { randomUUID } from 'node:crypto'
import { getPrismaClient } from '../persistence/prisma-client.mjs'
import { resolveProvisionedActor } from '../domain/pilot-identity.mjs'
import { mergeOperationalSettings, validateOperationalSection } from '../domain/workspace-settings-contract.mjs'
import { roleLabel } from '../../shared/roles.mjs'
import { assertAuthorized, can } from '../auth/authorization-service.mjs'

const clone = value => structuredClone(value)
const roleOptions = ['admin', 'manager', 'business-specialist', 'buyer', 'viewer']

function databaseSettings(tenant, users = []) {
  const operational = mergeOperationalSettings(tenant.operationalSettings)
  return {
    company: {
      companyName: tenant.legalName || tenant.name,
      workspaceName: tenant.name,
      timezone: tenant.timezone,
      currency: tenant.currency,
      locale: tenant.locale,
      defaultLanguage: tenant.defaultLanguage,
    },
    roles: {
      users: users.map(user => ({ id: user.id, name: user.name, email: user.email, role: user.role, roleLabel: roleLabel(user.role), enabled: user.status === 'active' })),
      roleOptions,
    },
    ...operational,
  }
}

async function getDatabaseSettings(ctx) {
  const prisma = await getPrismaClient(ctx.env || process.env)
  const actor = await resolveProvisionedActor(prisma, ctx.identity)
  const [tenant, users] = await Promise.all([
    prisma.tenant.findUnique({ where: { id: actor.tenantId } }),
    can({ actor, permission: 'settings.users.read', tenantId: actor.tenantId }) ? prisma.user.findMany({ where: { tenantId: actor.tenantId }, orderBy: { email: 'asc' } }) : Promise.resolve([]),
  ])
  return { actor, prisma, settings: databaseSettings(tenant, users), tenant }
}

async function updateDatabaseSection(ctx, section, next) {
  const { actor, prisma, tenant } = await getDatabaseSettings(ctx)
  const permission = ({ company: 'settings.workspace.manage', numbering: 'settings.numbering.manage', review: 'settings.review_policy.manage', modules: 'settings.modules.manage' })[section] || 'settings.workspace.manage'
  assertAuthorized({ actor, permission, tenantId: actor.tenantId })
  const validated = validateOperationalSection(section, next)
  return prisma.$transaction(async tx => {
    const current = await tx.tenant.findUnique({ where: { id: actor.tenantId } })
    const operational = mergeOperationalSettings(current.operationalSettings)
    const before = clone(operational[section])
    const after = clone(validated)
    await tx.tenant.update({ where: { id: actor.tenantId }, data: { operationalSettings: { ...operational, [section]: after }, version: { increment: 1 } } })
    const audit = await tx.auditLog.create({
      data: {
        id: randomUUID(),
        tenantId: actor.tenantId,
        source: 'workspace_settings',
        module: 'settings',
        action: `${section}_settings_updated`,
        entityType: 'settings_section',
        entityId: section,
        actorId: actor.user.id,
        summary: `${section} settings updated.`,
        metadata: { actor: { id: actor.user.id, name: actor.user.name, role: actor.role }, before, after },
      },
    })
    return { settings: after, audit: { id: audit.id, timestamp: audit.createdAt, before, after } }
  }, { isolationLevel: 'Serializable' })
}

export async function handleSettingsRuntimeRoute(ctx) {
  const { req, res, url, send, readBody } = ctx
  if (req.method === 'GET' && url.pathname === '/api/settings-runtime') {
    try {
      send(res, 200, (await getDatabaseSettings(ctx)).settings)
    } catch (error) {
      send(res, error?.status || error?.statusCode || 500, { code: error?.code, message: error?.message || '系统设置读取失败' })
    }
    return true
  }

  const match = url.pathname.match(/^\/api\/settings-runtime\/([a-z-]+)$/)
  if (req.method === 'PATCH' && match) {
    try {
      const body = await readBody(req)
      const result = await updateDatabaseSection(ctx, match[1], body.settings)
      send(res, 200, result)
    } catch (error) {
      send(res, error?.status || error?.statusCode || 400, { code: error?.code, message: error?.message || '设置保存失败' })
    }
    return true
  }
  return false
}
