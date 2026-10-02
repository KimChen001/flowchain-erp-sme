import { randomUUID } from "node:crypto"
import { assertAuthorized } from "./authorization-service.mjs"
import { revokeUserSessions } from "./workspace-sessions.mjs"
import { assertKnownPermissionCode, defaultRoleTemplates, permissionCatalog } from "./permission-catalog.mjs"

export class AuthorizationGovernanceError extends Error {
  constructor(code, message, status = 400, details) { super(message); this.name = "AuthorizationGovernanceError"; this.code = code; this.status = status; this.details = details }
}
const fail = (code, message, status = 400, details) => { throw new AuthorizationGovernanceError(code, message, status, details) }
const text = (value) => String(value ?? "").trim()
const unique = (items) => [...new Set((items || []).map(text).filter(Boolean))]
const roleKey = (value) => text(value).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60)

function audit(actor, action, entityType, entityId, summary, metadata, idFactory) {
  return { id: idFactory(), tenantId: actor.tenantId, actorId: actor.userId, source: "authorization_governance", module: "settings", action, entityType, entityId, summary, metadata: { actor: { id: actor.userId }, timestamp: new Date().toISOString(), ...metadata } }
}

// The active users who can still manage roles: settings.roles.manage through an
// active assignment to an active role. Role governance, disabling a member in
// Settings and the readiness diagnostics all use this one rule. With userId it
// says whether that one user is such a manager.
export function countActiveRoleManagers(db, tenantId, { userId } = {}) {
  return db.user.count({ where: {
    tenantId, status: "active", ...(userId ? { id: userId } : {}),
    roleAssignments: { some: { tenantId, status: "active", role: { status: "active", permissions: { some: { permissionCode: "settings.roles.manage" } } } } },
  } })
}

export async function tenantHasRoleManager(tx, tenantId) {
  return (await countActiveRoleManagers(tx, tenantId)) > 0
}

function publicRole(role) {
  return {
    id: role.id, roleKey: role.roleKey, name: role.name, description: role.description, status: role.status,
    isDefaultTemplate: role.isDefaultTemplate, version: role.version, updatedAt: role.updatedAt,
    updatedBy: role.updatedBy ? { id: role.updatedBy.id, name: role.updatedBy.name } : null,
    permissionCodes: role.permissions.map((grant) => grant.permissionCode).sort(),
    permissionCount: role.permissions.length,
    userCount: role.assignments.filter((assignment) => assignment.status === "active").length,
    members: role.assignments.filter((assignment) => assignment.status === "active").map((assignment) => ({ id: assignment.user.id, name: assignment.user.name, email: assignment.user.email })),
  }
}

export function createAuthorizationAdminService({ prisma, idFactory = randomUUID } = {}) {
  if (!prisma) throw new Error("prisma is required")
  async function list(actor) {
    assertAuthorized({ actor, permission: "settings.roles.read", tenantId: actor.tenantId })
    const [roles, users] = await Promise.all([
      prisma.tenantRole.findMany({ where: { tenantId: actor.tenantId }, include: { permissions: true, updatedBy: { select: { id: true, name: true } }, assignments: { include: { user: { select: { id: true, name: true, email: true } } } } }, orderBy: [{ status: "asc" }, { name: "asc" }] }),
      prisma.user.findMany({ where: { tenantId: actor.tenantId }, include: { warehouseScopes: true, roleAssignments: { where: { status: "active" }, include: { role: { select: { id: true, roleKey: true, name: true, status: true } } } } }, orderBy: { email: "asc" } }),
    ])
    return { permissionCatalog, defaultRoleTemplates: defaultRoleTemplates.map(({ roleKey, name }) => ({ roleKey, name })), roles: roles.map(publicRole), users: users.map((user) => ({ id: user.id, name: user.name, email: user.email, status: user.status, legacyRole: user.role, roleIds: user.roleAssignments.filter((assignment) => assignment.role.status === "active").map((assignment) => assignment.roleId), roles: user.roleAssignments.map((assignment) => assignment.role), warehouseScopes: user.warehouseScopes.map(({ warehouseId, accessLevel }) => ({ warehouseId, accessLevel })) })) }
  }

  async function createRole(actor, input = {}) {
    assertAuthorized({ actor, permission: "settings.roles.manage", tenantId: actor.tenantId })
    const name = text(input.name); if (!name) fail("AUTHORIZATION_ROLE_NAME_REQUIRED", "Role name is required.", 422)
    const key = roleKey(input.roleKey || name) || `custom-${idFactory().slice(0, 8)}`
    const permissions = unique(input.permissionCodes); permissions.forEach(assertKnownPermissionCode)
    return prisma.$transaction(async (tx) => {
      const source = input.copyFromRoleId ? await tx.tenantRole.findFirst({ where: { id: input.copyFromRoleId, tenantId: actor.tenantId }, include: { permissions: true } }) : null
      if (input.copyFromRoleId && !source) fail("AUTHORIZATION_ROLE_NOT_FOUND", "Template role was not found.", 404)
      const codes = permissions.length ? permissions : source?.permissions.map((grant) => grant.permissionCode) || []
      const created = await tx.tenantRole.create({ data: { id: idFactory(), tenantId: actor.tenantId, roleKey: key, name, description: text(input.description) || null, status: "active", isDefaultTemplate: false, createdById: actor.userId, updatedById: actor.userId } })
      for (const permissionCode of codes) await tx.tenantRolePermission.create({ data: { id: idFactory(), tenantId: actor.tenantId, roleId: created.id, permissionCode, createdById: actor.userId } })
      const role = await tx.tenantRole.findUnique({ where: { id: created.id }, include: { permissions: true, assignments: { include: { user: true } }, updatedBy: true } })
      await tx.auditLog.create({ data: audit(actor, "role_created", "TenantRole", role.id, `Role ${role.name} created.`, { before: null, after: { name: role.name, description: role.description, permissionCodes: codes }, role: { id: role.id, name: role.name }, permissionCodes: codes }, idFactory) })
      return publicRole(role)
    }, { isolationLevel: "Serializable" })
  }

  async function updateRole(actor, id, input = {}) {
    assertAuthorized({ actor, permission: "settings.roles.manage", tenantId: actor.tenantId })
    const permissionCodes = input.permissionCodes === undefined ? null : unique(input.permissionCodes); permissionCodes?.forEach(assertKnownPermissionCode)
    return prisma.$transaction(async (tx) => {
      const current = await tx.tenantRole.findFirst({ where: { id, tenantId: actor.tenantId }, include: { permissions: true, assignments: true } })
      if (!current) fail("AUTHORIZATION_ROLE_NOT_FOUND", "Role was not found.", 404)
      const status = input.status === undefined ? current.status : text(input.status)
      if (!["active", "inactive"].includes(status)) fail("AUTHORIZATION_ROLE_STATUS_INVALID", "Role status must be active or inactive.", 422)
      if (status === "inactive" && current.assignments.some((assignment) => assignment.status === "active")) fail("AUTHORIZATION_ROLE_HAS_MEMBERS", "Remove active role assignments before deactivation.", 409)
      if (permissionCodes) {
        await tx.tenantRolePermission.deleteMany({ where: { roleId: id, permissionCode: { notIn: permissionCodes } } })
        for (const permissionCode of permissionCodes) await tx.tenantRolePermission.upsert({ where: { roleId_permissionCode: { roleId: id, permissionCode } }, create: { id: idFactory(), tenantId: actor.tenantId, roleId: id, permissionCode, createdById: actor.userId }, update: {} })
      }
      const updated = await tx.tenantRole.update({ where: { id }, data: { name: input.name === undefined ? current.name : text(input.name), description: input.description === undefined ? current.description : text(input.description) || null, status, updatedById: actor.userId, version: { increment: 1 } }, include: { permissions: true, assignments: { include: { user: true } }, updatedBy: true } })
      if (!(await tenantHasRoleManager(tx, actor.tenantId))) fail("AUTHORIZATION_LAST_ROLES_MANAGER", "The tenant must retain at least one active user with Manage Roles permission.", 409)
      const beforeCodes = current.permissions.map((grant) => grant.permissionCode).sort(); const afterCodes = updated.permissions.map((grant) => grant.permissionCode).sort()
      await tx.auditLog.create({ data: audit(actor, status !== current.status ? "role_deactivated" : "role_updated", "TenantRole", id, `Role ${updated.name} updated.`, { before: { name: current.name, description: current.description, status: current.status, permissionCodes: beforeCodes }, after: { name: updated.name, description: updated.description, status: updated.status, permissionCodes: afterCodes }, role: { id, name: updated.name }, permissionCodes: afterCodes }, idFactory) })
      return publicRole(updated)
    }, { isolationLevel: "Serializable" })
  }

  async function assignUserRoles(actor, userId, roleIds = []) {
    assertAuthorized({ actor, permission: "settings.roles.assign", tenantId: actor.tenantId })
    const nextRoleIds = unique(roleIds)
    return prisma.$transaction(async (tx) => {
      const target = await tx.user.findFirst({ where: { id: userId, tenantId: actor.tenantId } }); if (!target) fail("AUTHORIZATION_USER_NOT_FOUND", "User was not found.", 404)
      const roles = await tx.tenantRole.findMany({ where: { id: { in: nextRoleIds }, tenantId: actor.tenantId } })
      if (roles.length !== nextRoleIds.length) fail("AUTHORIZATION_CROSS_TENANT_ROLE_ASSIGNMENT", "Every assigned role must belong to the user's tenant.", 403)
      if (roles.some((role) => role.status !== "active")) fail("AUTHORIZATION_ROLE_INACTIVE", "Inactive roles cannot be assigned.", 409)
      const before = await tx.userRoleAssignment.findMany({ where: { tenantId: actor.tenantId, userId, status: "active" }, select: { roleId: true } })
      await tx.userRoleAssignment.deleteMany({ where: { tenantId: actor.tenantId, userId, roleId: { notIn: nextRoleIds } } })
      for (const roleId of nextRoleIds) await tx.userRoleAssignment.upsert({ where: { userId_roleId: { userId, roleId } }, create: { id: idFactory(), tenantId: actor.tenantId, userId, roleId, status: "active", createdById: actor.userId }, update: { status: "active" } })
      // From now on these assignments, even none, are the user's roles; the
      // legacy User.role never grants a template again.
      if (!target.rolesAssignedAt) await tx.user.update({ where: { id: userId }, data: { rolesAssignedAt: new Date() } })
      if (!(await tenantHasRoleManager(tx, actor.tenantId))) fail("AUTHORIZATION_LAST_ROLES_MANAGER", "This change would leave the tenant without a role administrator.", 409)
      await tx.auditLog.create({ data: audit(actor, "user_role_assignments_changed", "User", userId, `Role assignments changed for ${target.email}.`, { before: { roleIds: before.map((row) => row.roleId) }, after: { roleIds: nextRoleIds }, targetUser: { id: target.id, email: target.email }, role: null, permissionCodes: [] }, idFactory) })
      // A role change ends the user's sessions in the same transaction.
      const beforeIds = before.map((row) => row.roleId).sort()
      if (beforeIds.join(",") !== [...nextRoleIds].sort().join(",")) await revokeUserSessions(tx, { tenantId: actor.tenantId, userId, reason: "role_changed", actorId: actor.userId })
      return { userId, roleIds: nextRoleIds }
    }, { isolationLevel: "Serializable" })
  }

  return { list, createRole, updateRole, assignUserRoles }
}
