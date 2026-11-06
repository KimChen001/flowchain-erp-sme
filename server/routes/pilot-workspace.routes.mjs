import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { getPrismaClient } from '../persistence/prisma-client.mjs'
import { PilotIdentityError, resolveProvisionedActor } from '../domain/pilot-identity.mjs'
import { roleLabel } from '../../shared/roles.mjs'
import { assertAuthorized, can } from '../auth/authorization-service.mjs'
import { countActiveRoleManagers, tenantHasRoleManager } from '../auth/authorization-admin-service.mjs'
import { revokeUserSessions } from '../auth/workspace-sessions.mjs'
import { backfillTenantAuthorization } from '../auth/authorization-backfill.mjs'
import { normalizeSignInEmail } from '../auth/email-link-sign-in.mjs'
import { isTransactionConflict } from '../persistence/transaction-conflict.mjs'
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
// Each maps to a default role template (legacyRoleTemplateMap).
const ALLOWED_ROLES = new Set(['admin', 'manager', 'viewer', 'business-specialist', 'buyer', 'finance-specialist'])

const fail = (code, message, status = 400, details) => { throw new PilotIdentityError(code, message, status, details) }
const publicUser = user => ({ id: user.id, email: user.email, name: user.name, role: user.role, roleLabel: roleLabel(user.role), jobTitle: user.jobTitle, status: user.status, languagePreference: user.languagePreference, approvalEmailsEnabled: user.approvalEmailsEnabled, defaultWarehouseId: user.defaultWarehouseId, profileCompletedAt: user.profileCompletedAt, version: user.version, ...(Array.isArray(user.warehouseScopes) ? { warehouseScopes: user.warehouseScopes.map(scope => ({ warehouseId: scope.warehouseId, accessLevel: scope.accessLevel })) } : {}) })
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

// Serializable transactions in one workspace can abort each other even when
// their changes do not overlap. An aborted attempt wrote nothing, so it is run
// again; if it keeps colliding the caller gets a 409 to retry, not a 500.
const CONFLICT_ATTEMPTS = 5
async function changeUserWithRetry(prisma, work) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await prisma.$transaction(work, { isolationLevel: 'Serializable' })
    } catch (error) {
      if (!isTransactionConflict(error)) throw error
      if (attempt === CONFLICT_ATTEMPTS) fail('USER_CHANGE_CONFLICT', 'The user was changed by another request at the same time. Try again.', 409)
      // Jittered, so two requests that collided do not collide again in step.
      await new Promise(resolve => setTimeout(resolve, attempt * 20 + Math.random() * 20))
    }
  }
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
    const inspect = ctx.url.pathname === '/api/workspace/invitations/inspect'
    if (!accept && !inspect && !ctx.identity?.authenticated) fail('AUTHENTICATION_REQUIRED', 'Authentication is required.', 401)

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
      // Approval emails: changed only when the request says true or false;
      // a request without the field keeps the current choice.
      const approvalEmails = Object.hasOwn(body, 'approvalEmailsEnabled')
      if (approvalEmails && typeof body.approvalEmailsEnabled !== 'boolean') fail('INVALID_PREFERENCE', 'approvalEmailsEnabled must be true or false.', 400)
      const before = publicUser(actor.user)
      const result = await prisma.$transaction(async tx => {
        const updated = await tx.user.updateMany({ where: { id: actor.user.id, tenantId: actor.tenantId, version: Number(body.version) }, data: { name: text(body.name), jobTitle: text(body.jobTitle) || null, languagePreference, ...(approvalEmails ? { approvalEmailsEnabled: body.approvalEmailsEnabled } : {}), defaultWarehouseId: text(body.defaultWarehouseId) || null, profileCompletedAt: text(body.name) && text(body.jobTitle) ? new Date() : null, version: { increment: 1 } } })
        if (updated.count !== 1) fail('VERSION_CONFLICT', 'Profile changed concurrently.', 409)
        const user = await tx.user.findUnique({ where: { id: actor.user.id }, include: { warehouseScopes: true } })
        await tx.auditLog.create({ data: auditData({ actor, action: 'profile_settings_updated', entityType: 'User', entityId: actor.user.id, summary: 'User profile and language preference updated.', before, after: publicUser(user) }) })
        return user
      }, { isolationLevel: 'Serializable' })
      ctx.send(ctx.res, 200, publicUser(await prisma.user.findUnique({ where: { id: actor.user.id }, include: { warehouseScopes: true } }))); return true
    }
    if (ctx.req.method === 'GET' && ctx.url.pathname === '/api/workspace') {
      // Any member reads the workspace name, base currency, locale and timezone
      // their screens use. Changing them needs settings.workspace.manage.
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
        const updated = await tx.tenant.updateMany({ where: { id: actor.tenantId, version: Number(body.version) }, data: { name: workspaceName, legalName: companyName || null, countryCode: text(body.countryCode) || current.countryCode || 'US', currency: baseCurrency, timezone, locale, defaultLanguage, workspaceCompletedAt: workspaceName && companyName && baseCurrency && timezone ? new Date() : null, version: { increment: 1 } } })
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
      // Permissions come from role assignments. The legacy User.role grants
      // nothing a permission check reads, so changing it here would look like a
      // role change while access stayed the same. Repeating the current value
      // is harmless.
      const requestedRole = text(body.role).toLowerCase()
      if (requestedRole && requestedRole !== text(target.role).toLowerCase()) fail('USER_ROLE_CHANGE_NOT_SUPPORTED', 'Roles are changed in Roles & permissions under Settings > Users & Roles. This request can only change the user status.', 422, [{ field: 'role' }])
      const status = text(body.status || target.status).toLowerCase()
      if (!['active', 'disabled'].includes(status)) fail('USER_VALIDATION_FAILED', 'Status must be active or disabled.')
      // An administrator cannot lock themselves out.
      if (target.id === actor.user.id && status !== 'active') fail('CANNOT_DISABLE_SELF', 'You cannot disable your own account.', 409)
      // A status change ends the user's sessions in the same transaction, so no
      // request runs as a disabled user afterwards.
      const statusChanged = status !== text(target.status).toLowerCase()
      await changeUserWithRetry(prisma, async tx => {
        // Only disabling someone who can manage roles can leave the workspace
        // without one, so disabling anyone else skips the tenant-wide count.
        const disablesRoleManager = statusChanged && status === 'disabled' && (await countActiveRoleManagers(tx, actor.tenantId, { userId: target.id })) > 0
        const result = await tx.user.updateMany({ where: { id: target.id, tenantId: actor.tenantId, version: Number(body.version) }, data: { status, version: { increment: 1 } } })
        if (result.count !== 1) fail('VERSION_CONFLICT', 'User changed concurrently.', 409)
        // Checked after the update and under Serializable isolation, like the
        // role changes in Roles & permissions, so two concurrent disables (or a
        // disable and a role change) cannot each leave the other as the last
        // manager: one of them is aborted and, on its retry, sees the other.
        if (disablesRoleManager && !(await tenantHasRoleManager(tx, actor.tenantId))) fail('AUTHORIZATION_LAST_ROLES_MANAGER', 'Disabling this user would leave the workspace without an active user who can manage roles.', 409)
        if (statusChanged) await revokeUserSessions(tx, { tenantId: actor.tenantId, userId: target.id, reason: status === 'disabled' ? 'user_disabled' : 'user_enabled', actorId: actor.user.id })
      })
      if (statusChanged) ctx.sessionStore?.forgetUser(target.id)
      ctx.send(ctx.res, 200, publicUser(await prisma.user.findUnique({ where: { id: target.id } }))); return true
    }
    if (ctx.req.method === 'GET' && ctx.url.pathname === '/api/workspace/warehouses') {
      const actor = await resolveProvisionedActor(prisma, ctx.identity)
      // Whoever may read or grant members' warehouse access sees every
      // warehouse, so a member's access shows in full and not only where it
      // overlaps the reader's own scope; /api/workspace/users already lists
      // those warehouse ids to the same people. Everyone else sees the
      // warehouses in their own scope.
      const allWarehouses = actor.allWarehouses || ['settings.users.read', 'settings.users.manage'].some(permission => can({ actor, permission, tenantId: actor.tenantId }))
      const where = allWarehouses ? { tenantId: actor.tenantId } : { tenantId: actor.tenantId, id: { in: [...actor.readWarehouseIds] } }
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
      // Accepting assigns the invited role template, so inviting is assigning a
      // role: without this, settings.users.manage alone could invite a second
      // address as Workspace Administrator.
      assertAuthorized({ actor, permission: 'settings.roles.assign', tenantId: actor.tenantId })
      // The same address rule as sign-in, so every invitation can sign in.
      const targetEmail = normalizeSignInEmail(body.email); const role = text(body.role).toLowerCase(); const expiryHours = Math.min(168, Math.max(1, Number(body.expiryHours || 72)))
      if (!targetEmail) fail('INVITATION_EMAIL_INVALID', 'Enter a valid email address.', 422, [{ field: 'email' }])
      if (!ALLOWED_ROLES.has(role)) fail('INVITATION_VALIDATION_FAILED', 'Choose a role for the invitation.', 422, [{ field: 'role' }])
      const member = await prisma.user.findFirst({ where: { tenantId: actor.tenantId, email: targetEmail } })
      if (member) fail('INVITATION_ALREADY_MEMBER', member.status === 'active' ? 'This person is already a member of the workspace.' : 'This person is a disabled member. Enable them instead of inviting them again.', 409)
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
    // What an invitation link is for, shown before it is accepted. The token
    // is the secret, so its holder may see the invited email.
    if (ctx.req.method === 'POST' && inspect) {
      const body = await ctx.readBody(ctx.req); const invitation = await prisma.workspaceInvitation.findUnique({ where: { tokenHash: hashToken(text(body.token)) }, include: { tenant: true } })
      if (!invitation || invitation.status !== 'pending' || invitation.expiresAt <= new Date()) fail('INVITATION_INVALID', 'Invitation is invalid or no longer pending.', 400)
      ctx.send(ctx.res, 200, { email: invitation.email, role: invitation.role, roleLabel: roleLabel(invitation.role), workspaceName: invitation.tenant.name, expiresAt: invitation.expiresAt }); return true
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
      // The new member gets the invitation's role template now, not on a
      // later request.
      if (!existing) await backfillTenantAuthorization(prisma, invitation.tenantId, { actorId: invitation.invitedById })
      ctx.send(ctx.res, 200, { user: publicUser(accepted), email: accepted.email, status: 'accepted' }); return true
    }
    return false
  } catch (error) { sendError(ctx, error); return true }
}
