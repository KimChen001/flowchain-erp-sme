import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { getPrismaClient } from '../persistence/prisma-client.mjs'
import { PilotIdentityError, resolveProvisionedActor } from '../domain/pilot-identity.mjs'
import { roleLabel } from '../../shared/roles.mjs'
import { assertAuthorized } from '../auth/authorization-service.mjs'
import {
  assertSupportedCurrency,
  assertSupportedLanguage,
  assertSupportedLocale,
  assertSupportedTimezone,
  effectiveLanguage,
  normalizeLanguagePreference,
  SUPPORTED_CURRENCIES,
  SUPPORTED_LANGUAGES,
  SUPPORTED_LOCALES,
  SUPPORTED_TIMEZONES,
} from '../domain/workspace-settings-contract.mjs'

const text = value => String(value ?? '').trim()
const email = value => text(value).toLowerCase()
const hashToken = token => createHash('sha256').update(token).digest('hex')
const ALLOWED_ROLES = new Set(['admin', 'manager', 'viewer', 'business-specialist', 'buyer'])

const fail = (code, message, status = 400, details) => { throw new PilotIdentityError(code, message, status, details) }
const publicUser = user => ({ id: user.id, email: user.email, name: user.name, role: user.role, roleLabel: roleLabel(user.role), jobTitle: user.jobTitle, status: user.status, languagePreference: user.languagePreference, defaultWarehouseId: user.defaultWarehouseId, profileCompletedAt: user.profileCompletedAt, version: user.version, ...(Array.isArray(user.warehouseScopes) ? { warehouseScopes: user.warehouseScopes.map(scope => ({ warehouseId: scope.warehouseId, accessLevel: scope.accessLevel })) } : {}) })
const publicInvitation = invitation => ({ id: invitation.id, email: invitation.email, role: invitation.role, roleLabel: roleLabel(invitation.role), status: invitation.status, expiresAt: invitation.expiresAt, invitedById: invitation.invitedById, acceptedById: invitation.acceptedById, createdAt: invitation.createdAt, acceptedAt: invitation.acceptedAt })
const publicWorkspace = (tenant, baseCurrencyLocked = false) => ({
  id: tenant.id,
  name: tenant.name,
  workspaceName: tenant.name,
  legalName: tenant.legalName,
  companyName: tenant.legalName || tenant.name,
  countryCode: tenant.countryCode,
  baseCurrency: tenant.currency,
  timezone: tenant.timezone,
  locale: tenant.locale,
  defaultLanguage: tenant.defaultLanguage,
  baseCurrencyLocked,
  workspaceCompletedAt: tenant.workspaceCompletedAt,
  version: tenant.version,
  options: {
    languages: SUPPORTED_LANGUAGES,
    locales: SUPPORTED_LOCALES,
    timezones: SUPPORTED_TIMEZONES,
    currencies: SUPPORTED_CURRENCIES,
  },
})

function sendError(ctx, error) {
  if (!(error instanceof PilotIdentityError) && !error?.code) throw error
  ctx.send(ctx.res, error.status || 400, { code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) })
}

const auditData = ({ actor, action, entityType, entityId, summary, before, after }) => ({
  id: randomUUID(),
  tenantId: actor.tenantId,
  source: 'workspace_settings',
  module: 'settings',
  action,
  entityType,
  entityId,
  actorId: actor.user.id,
  summary,
  metadata: {
    actor: { id: actor.user.id, name: actor.user.name, role: actor.role },
    before,
    after,
  },
})

async function hasPostedTransactions(prisma, tenantId, tenant) {
  if (tenant.openingBalanceLockedAt) return true
  const [movementCount, receivingCount, shipmentCount, returnCount] = await Promise.all([
    prisma.inventoryMovement.count({ where: { tenantId, status: 'posted' } }),
    prisma.receivingDocument.count({ where: { tenantId, postingStatus: 'posted' } }),
    prisma.shipmentDocument.count({ where: { tenantId, postingStatus: 'posted' } }),
    prisma.returnPostingDocument.count({ where: { tenantId, postingStatus: 'posted' } }),
  ])
  return movementCount + receivingCount + shipmentCount + returnCount > 0
}

async function adminActor(prisma, identity, permission) {
  const actor = await resolveProvisionedActor(prisma, identity)
  assertAuthorized({ actor, permission, tenantId: actor.tenantId })
  return actor
}

async function validateDefaultWarehouse(prisma, actor, warehouseId) {
  if (!warehouseId) return null
  const warehouse = await prisma.warehouse.findFirst({ where: { id: warehouseId, tenantId: actor.tenantId, status: 'active' } })
  if (!warehouse) fail('INVALID_DEFAULT_WAREHOUSE', 'Default warehouse must be active in this workspace.', 400)
  if (!actor.allWarehouses && !actor.readWarehouseIds.has(warehouseId)) fail('WAREHOUSE_SCOPE_DENIED', 'Default warehouse must be within the user warehouse scope.', 403)
  return warehouse.id
}

export async function handlePilotWorkspaceRoute(ctx) {
  if (!ctx.url.pathname.startsWith('/api/me/') && !ctx.url.pathname.startsWith('/api/workspace')) return false
  const prisma = await getPrismaClient(ctx.env || process.env)
  try {
    const accept = ctx.url.pathname === '/api/workspace/invitations/accept'
    if (!accept && !ctx.identity?.authenticated) fail('AUTHENTICATION_REQUIRED', 'Authentication is required.', 401)

    if (ctx.req.method === 'GET' && ctx.url.pathname === '/api/me/profile') {
      const actor = await resolveProvisionedActor(prisma, ctx.identity)
      const tenant = await prisma.tenant.findUnique({ where: { id: actor.tenantId } })
      ctx.send(ctx.res, 200, { ...publicUser(actor.user), effectiveLanguage: effectiveLanguage(actor.user, tenant), locale: tenant.locale, timezone: tenant.timezone }); return true
    }
    if (ctx.req.method === 'GET' && ctx.url.pathname === '/api/me/localization') {
      const actor = await resolveProvisionedActor(prisma, ctx.identity)
      const tenant = await prisma.tenant.findUnique({ where: { id: actor.tenantId } })
      ctx.send(ctx.res, 200, {
        languagePreference: actor.user.languagePreference,
        defaultLanguage: tenant.defaultLanguage,
        effectiveLanguage: effectiveLanguage(actor.user, tenant),
        locale: tenant.locale,
        timezone: tenant.timezone,
        workspaceName: tenant.name,
      }); return true
    }
    if (ctx.req.method === 'PATCH' && ctx.url.pathname === '/api/me/profile') {
      const actor = await resolveProvisionedActor(prisma, ctx.identity)
      const body = await ctx.readBody(ctx.req)
      await validateDefaultWarehouse(prisma, actor, text(body.defaultWarehouseId) || null)
      const languagePreference = Object.hasOwn(body, 'languagePreference') ? normalizeLanguagePreference(body.languagePreference) : actor.user.languagePreference
      const before = publicUser(actor.user)
      const result = await prisma.$transaction(async tx => {
        const updated = await tx.user.updateMany({ where: { id: actor.user.id, tenantId: actor.tenantId, version: Number(body.version) }, data: { name: text(body.name), jobTitle: text(body.jobTitle) || null, languagePreference, defaultWarehouseId: text(body.defaultWarehouseId) || null, profileCompletedAt: text(body.name) && text(body.jobTitle) ? new Date() : null, version: { increment: 1 } } })
        if (updated.count !== 1) fail('VERSION_CONFLICT', 'Profile changed concurrently.', 409)
        const user = await tx.user.findUnique({ where: { id: actor.user.id }, include: { warehouseScopes: true } })
        await tx.auditLog.create({ data: auditData({ actor, action: 'profile_settings_updated', entityType: 'User', entityId: actor.user.id, summary: 'User profile and language preference updated.', before, after: publicUser(user) }) })
        return user
      }, { isolationLevel: 'Serializable' })
      ctx.send(ctx.res, 200, publicUser(await prisma.user.findUnique({ where: { id: actor.user.id }, include: { warehouseScopes: true } }))); return true
    }
    if (ctx.req.method === 'GET' && ctx.url.pathname === '/api/workspace') {
      const actor = await resolveProvisionedActor(prisma, ctx.identity)
      const tenant = await prisma.tenant.findUnique({ where: { id: actor.tenantId } })
      ctx.send(ctx.res, 200, publicWorkspace(tenant, await hasPostedTransactions(prisma, actor.tenantId, tenant))); return true
    }
    if (ctx.req.method === 'PATCH' && ctx.url.pathname === '/api/workspace') {
      const actor = await adminActor(prisma, ctx.identity, 'settings.workspace.manage')
      const body = await ctx.readBody(ctx.req)
      const result = await prisma.$transaction(async tx => {
        const current = await tx.tenant.findUnique({ where: { id: actor.tenantId } })
        const workspaceName = text(body.workspaceName ?? body.name)
        const companyName = text(body.companyName ?? body.legalName)
        const baseCurrency = assertSupportedCurrency(body.baseCurrency || current.currency)
        const timezone = assertSupportedTimezone(body.timezone || current.timezone)
        const locale = assertSupportedLocale(body.locale || current.locale)
        const defaultLanguage = assertSupportedLanguage(body.defaultLanguage || current.defaultLanguage)
        const locked = await hasPostedTransactions(tx, actor.tenantId, current)
        if (locked && baseCurrency !== current.currency) fail('BASE_CURRENCY_LOCKED', 'Base currency cannot change after posted transactions exist.', 409)
        const updated = await tx.tenant.updateMany({ where: { id: actor.tenantId, version: Number(body.version) }, data: { name: workspaceName, legalName: companyName || null, countryCode: text(body.countryCode) || current.countryCode || 'CN', currency: baseCurrency, timezone, locale, defaultLanguage, workspaceCompletedAt: workspaceName && companyName && baseCurrency && timezone ? new Date() : null, version: { increment: 1 } } })
        if (updated.count !== 1) fail('VERSION_CONFLICT', 'Workspace changed concurrently.', 409)
        const next = await tx.tenant.findUnique({ where: { id: actor.tenantId } })
        await tx.auditLog.create({ data: auditData({ actor, action: 'workspace_settings_updated', entityType: 'Tenant', entityId: actor.tenantId, summary: 'Company, workspace, locale, language, timezone, or base currency settings updated.', before: publicWorkspace(current, locked), after: publicWorkspace(next, locked) }) })
        return { tenant: next, locked }
      }, { isolationLevel: 'Serializable' })
      ctx.send(ctx.res, 200, publicWorkspace(result.tenant, result.locked)); return true
    }
    if (ctx.req.method === 'GET' && ctx.url.pathname === '/api/workspace/users') {
      const actor = await adminActor(prisma, ctx.identity, 'settings.users.read')
      const users = await prisma.user.findMany({ where: { tenantId: actor.tenantId }, include: { warehouseScopes: true }, orderBy: { email: 'asc' } })
      ctx.send(ctx.res, 200, { users: users.map(user => ({ ...publicUser(user), warehouseScopes: user.warehouseScopes.map(scope => ({ warehouseId: scope.warehouseId, accessLevel: scope.accessLevel })) })) }); return true
    }
    const userPatch = ctx.url.pathname.match(/^\/api\/workspace\/users\/([^/]+)$/)
    if (ctx.req.method === 'PATCH' && userPatch) {
      const actor = await adminActor(prisma, ctx.identity, 'settings.users.manage')
      const userId = decodeURIComponent(userPatch[1]); const body = await ctx.readBody(ctx.req)
      const target = await prisma.user.findFirst({ where: { id: userId, tenantId: actor.tenantId } })
      if (!target) fail('USER_NOT_FOUND', 'Workspace user was not found.', 404)
      const role = text(body.role || target.role).toLowerCase(); const status = text(body.status || target.status).toLowerCase()
      if (!ALLOWED_ROLES.has(role) || !['active', 'disabled'].includes(status)) fail('USER_VALIDATION_FAILED', 'Role or status is invalid.')
      if (target.role === 'admin' && (role !== 'admin' || status !== 'active')) {
        const adminCount = await prisma.user.count({ where: { tenantId: actor.tenantId, role: 'admin', status: 'active' } })
        if (adminCount <= 1) fail('LAST_ADMIN_REQUIRED', 'The last active admin cannot be disabled or demoted.', 409)
      }
      const result = await prisma.user.updateMany({ where: { id: target.id, tenantId: actor.tenantId, version: Number(body.version) }, data: { role, status, version: { increment: 1 } } })
      if (result.count !== 1) fail('VERSION_CONFLICT', 'User changed concurrently.', 409)
      for (const [sessionId, session] of ctx.localSessions || []) if (session.userId === target.id) ctx.localSessions.delete(sessionId)
      ctx.send(ctx.res, 200, publicUser(await prisma.user.findUnique({ where: { id: target.id } }))); return true
    }
    if (ctx.req.method === 'GET' && ctx.url.pathname === '/api/workspace/warehouses') {
      const actor = await resolveProvisionedActor(prisma, ctx.identity)
      const where = actor.allWarehouses ? { tenantId: actor.tenantId } : { tenantId: actor.tenantId, id: { in: [...actor.readWarehouseIds] } }
      const warehouses = await prisma.warehouse.findMany({ where, orderBy: { code: 'asc' } })
      ctx.send(ctx.res, 200, { warehouses }); return true
    }
    const scopesPut = ctx.url.pathname.match(/^\/api\/workspace\/users\/([^/]+)\/warehouse-scopes$/)
    if (ctx.req.method === 'PUT' && scopesPut) {
      const actor = await adminActor(prisma, ctx.identity, 'settings.users.manage')
      const userId = decodeURIComponent(scopesPut[1]); const body = await ctx.readBody(ctx.req); const scopes = Array.isArray(body.scopes) ? body.scopes : []
      const target = await prisma.user.findFirst({ where: { id: userId, tenantId: actor.tenantId } })
      if (!target) fail('USER_NOT_FOUND', 'Workspace user was not found.', 404)
      if (scopes.some(scope => !['read', 'operate'].includes(scope.accessLevel))) fail('WAREHOUSE_SCOPE_VALIDATION_FAILED', 'Warehouse accessLevel must be read or operate.')
      const warehouseIds = [...new Set(scopes.map(scope => text(scope.warehouseId)).filter(Boolean))]
      const validCount = await prisma.warehouse.count({ where: { tenantId: actor.tenantId, id: { in: warehouseIds } } })
      if (validCount !== warehouseIds.length) fail('WAREHOUSE_SCOPE_VALIDATION_FAILED', 'Every warehouse must belong to the workspace.')
      await prisma.$transaction(async tx => {
        await tx.userWarehouseScope.deleteMany({ where: { tenantId: actor.tenantId, userId } })
        for (const scope of scopes) await tx.userWarehouseScope.create({ data: { id: randomUUID(), tenantId: actor.tenantId, userId, warehouseId: text(scope.warehouseId), accessLevel: scope.accessLevel } })
        if (target.defaultWarehouseId && !warehouseIds.includes(target.defaultWarehouseId)) await tx.user.update({ where: { id: target.id }, data: { defaultWarehouseId: null, version: { increment: 1 } } })
      })
      ctx.send(ctx.res, 200, { userId, scopes }); return true
    }
    if (ctx.req.method === 'GET' && ctx.url.pathname === '/api/workspace/invitations') {
      const actor = await adminActor(prisma, ctx.identity, 'settings.users.read')
      await prisma.workspaceInvitation.updateMany({ where: { tenantId: actor.tenantId, status: 'pending', expiresAt: { lte: new Date() } }, data: { status: 'expired' } })
      const invitations = await prisma.workspaceInvitation.findMany({ where: { tenantId: actor.tenantId }, orderBy: { createdAt: 'desc' } })
      ctx.send(ctx.res, 200, { invitations: invitations.map(publicInvitation), emailDeliveryConnected: false }); return true
    }
    if (ctx.req.method === 'POST' && ctx.url.pathname === '/api/workspace/invitations') {
      const actor = await adminActor(prisma, ctx.identity, 'settings.users.manage'); const body = await ctx.readBody(ctx.req)
      const targetEmail = email(body.email); const role = text(body.role).toLowerCase(); const expiryHours = Math.min(168, Math.max(1, Number(body.expiryHours || 72)))
      if (!targetEmail || !ALLOWED_ROLES.has(role)) fail('INVITATION_VALIDATION_FAILED', 'A valid email and canonical role are required.')
      const token = randomBytes(32).toString('base64url')
      let invitation
      try { invitation = await prisma.workspaceInvitation.create({ data: { id: randomUUID(), tenantId: actor.tenantId, email: targetEmail, role, tokenHash: hashToken(token), expiresAt: new Date(Date.now() + expiryHours * 3600_000), invitedById: actor.user.id } }) }
      catch (error) { if (error?.code === 'P2002') fail('INVITATION_ALREADY_PENDING', 'An active invitation already exists for this email.', 409); throw error }
      ctx.send(ctx.res, 201, { invitation: publicInvitation(invitation), invitationToken: token, invitationPath: `/accept-invitation?token=${encodeURIComponent(token)}`, emailDeliveryConnected: false }); return true
    }
    const revoke = ctx.url.pathname.match(/^\/api\/workspace\/invitations\/([^/]+)\/revoke$/)
    if (ctx.req.method === 'POST' && revoke) {
      const actor = await adminActor(prisma, ctx.identity, 'settings.users.manage')
      const result = await prisma.workspaceInvitation.updateMany({ where: { id: decodeURIComponent(revoke[1]), tenantId: actor.tenantId, status: 'pending' }, data: { status: 'revoked' } })
      if (result.count !== 1) fail('INVITATION_NOT_PENDING', 'Pending invitation was not found.', 404)
      ctx.send(ctx.res, 200, { status: 'revoked' }); return true
    }
    if (ctx.req.method === 'POST' && accept) {
      const body = await ctx.readBody(ctx.req); const tokenHash = hashToken(text(body.token)); const invitation = await prisma.workspaceInvitation.findUnique({ where: { tokenHash } })
      if (!invitation || invitation.status !== 'pending') fail('INVITATION_INVALID', 'Invitation is invalid or no longer pending.', 400)
      if (invitation.expiresAt <= new Date()) { await prisma.workspaceInvitation.update({ where: { id: invitation.id }, data: { status: 'expired' } }); fail('INVITATION_EXPIRED', 'Invitation has expired.', 410) }
      const existing = await prisma.user.findFirst({ where: { tenantId: invitation.tenantId, email: invitation.email } })
      if (existing?.status === 'disabled') fail('USER_DISABLED', 'The invited user is disabled.', 403)
      const accepted = await prisma.$transaction(async tx => {
        const user = existing || await tx.user.create({ data: { id: `USR-${randomUUID()}`, tenantId: invitation.tenantId, email: invitation.email, name: text(body.name) || invitation.email.split('@')[0], role: invitation.role, status: 'active' } })
        const updated = await tx.workspaceInvitation.updateMany({ where: { id: invitation.id, status: 'pending' }, data: { status: 'accepted', acceptedById: user.id, acceptedAt: new Date() } })
        if (updated.count !== 1) fail('INVITATION_INVALID', 'Invitation was already used.', 409)
        return user
      })
      ctx.send(ctx.res, 200, { user: publicUser(accepted), status: 'accepted' }); return true
    }
    return false
  } catch (error) { sendError(ctx, error); return true }
}
