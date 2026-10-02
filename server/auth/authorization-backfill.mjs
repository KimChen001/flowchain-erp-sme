import { createHash, randomUUID } from "node:crypto"
import { defaultRoleTemplates, legacyRoleTemplateMap } from "./permission-catalog.mjs"
import { isTransactionConflict } from "../persistence/transaction-conflict.mjs"

const stableId = (...parts) => `AUTH-${createHash("sha256").update(parts.join(":"), "utf8").digest("hex").slice(0, 28)}`
const normalizedLegacyRole = (value) => String(value || "").trim().toLowerCase()

// The audit action the governance service records whenever an administrator
// sets a user's roles in Roles & permissions. It is the only trace an emptied
// assignment list leaves, so the backfill reads it to tell "an administrator
// removed every role" apart from "never had a role".
export const ROLE_ASSIGNMENT_DECISION_ACTION = "user_role_assignments_changed"

// The users among userIds whose roles an administrator has set at least once.
export async function usersWithRoleAssignmentDecision(prisma, tenantId, userIds) {
  if (!userIds.length) return new Set()
  const rows = await prisma.auditLog.findMany({
    where: { tenantId, source: "authorization_governance", action: ROLE_ASSIGNMENT_DECISION_ACTION, entityType: "User", entityId: { in: userIds } },
    select: { entityId: true },
    distinct: ["entityId"],
  })
  return new Set(rows.map((row) => row.entityId))
}

export async function backfillTenantAuthorization(prisma, tenantId, { actorId = null, requestId = null, idFactory = randomUUID } = {}) {
  if (!prisma || !tenantId) throw new Error("prisma and tenantId are required")
  const work = async (tx) => {
    const tenant = await tx.tenant.findUnique({ where: { id: tenantId }, select: { id: true } })
    if (!tenant) return { tenantId, createdRoles: 0, createdGrants: 0, createdAssignments: 0, unknownLegacyRoles: [] }

    let createdRoles = 0
    let createdGrants = 0
    let createdAssignments = 0
    const roles = new Map()
    for (const template of defaultRoleTemplates) {
      const id = stableId(tenantId, "role", template.roleKey)
      const existing = await tx.tenantRole.findUnique({ where: { tenantId_roleKey: { tenantId, roleKey: template.roleKey } } })
      const role = await tx.tenantRole.upsert({
        where: { tenantId_roleKey: { tenantId, roleKey: template.roleKey } },
        create: { id, tenantId, roleKey: template.roleKey, name: template.name, description: `FlowChain default role template: ${template.name}`, status: "active", isDefaultTemplate: true, createdById: actorId, updatedById: actorId },
        update: {},
      })
      if (!existing) createdRoles += 1
      roles.set(template.roleKey, role)
      // Template grants are filled in only until an administrator first saves
      // the role (updateRole bumps its version). After that the role is
      // theirs, and a code they removed stays removed when a later sign-in
      // runs this backfill again. Codes added to a template afterwards reach
      // saved roles through a migration, as 20261002030000_master_data_permissions does.
      if (!role.isDefaultTemplate || role.version !== 0) continue
      const granted = new Set((await tx.tenantRolePermission.findMany({ where: { roleId: role.id }, select: { permissionCode: true } })).map((grant) => grant.permissionCode))
      for (const permissionCode of template.permissions) {
        if (granted.has(permissionCode)) continue
        const grantId = stableId(tenantId, "grant", role.id, permissionCode)
        await tx.tenantRolePermission.upsert({ where: { roleId_permissionCode: { roleId: role.id, permissionCode } }, create: { id: grantId, tenantId, roleId: role.id, permissionCode, createdById: actorId }, update: {} })
        createdGrants += 1
      }
    }

    const users = await tx.user.findMany({ where: { tenantId }, select: { id: true, role: true, _count: { select: { roleAssignments: true } } } })
    const warehouses = await tx.warehouse.findMany({ where: { tenantId }, select: { id: true } })
    const unassigned = users.filter((user) => user._count.roleAssignments === 0).map((user) => user.id)
    const decided = await usersWithRoleAssignmentDecision(tx, tenantId, unassigned)
    const unknownLegacyRoles = []
    for (const user of users) {
      const legacyRole = normalizedLegacyRole(user.role)
      const roleKey = legacyRoleTemplateMap[legacyRole] || "read-only-viewer"
      // Only a user who has never had a role, such as someone who has just
      // accepted an invitation, gets the template of their legacy role. Anyone
      // else's roles are an administrator's decision, even an empty list, and
      // stay as the administrator left them when someone else's first sign-in
      // runs this backfill again.
      if (user._count.roleAssignments === 0 && !decided.has(user.id)) {
        if (!legacyRoleTemplateMap[legacyRole]) unknownLegacyRoles.push({ userId: user.id, legacyRole })
        const role = roles.get(roleKey)
        await tx.userRoleAssignment.upsert({ where: { userId_roleId: { userId: user.id, roleId: role.id } }, create: { id: stableId(tenantId, "assignment", user.id, role.id), tenantId, userId: user.id, roleId: role.id, status: "active", createdById: actorId }, update: {} })
        createdAssignments += 1
      }
      // Legacy admins previously bypassed warehouse scopes. Materialize the same
      // access as explicit UserWarehouseScope rows so role names are no longer a scope authority.
      if (roleKey === "workspace-administrator") {
        for (const warehouse of warehouses) {
          await tx.userWarehouseScope.upsert({
            where: { tenantId_userId_warehouseId: { tenantId, userId: user.id, warehouseId: warehouse.id } },
            create: { id: stableId(tenantId, "warehouse-scope", user.id, warehouse.id), tenantId, userId: user.id, warehouseId: warehouse.id, accessLevel: "operate" },
            update: {},
          })
        }
      }
    }

    if (createdRoles || createdGrants || createdAssignments) {
      await tx.auditLog.create({ data: {
        id: idFactory(), tenantId, actorId, source: "authorization_backfill", module: "settings",
        action: "authorization_legacy_role_backfilled", entityType: "Tenant", entityId: tenantId,
        summary: `Backfilled ${createdAssignments} legacy user role assignments.`,
        metadata: { before: { authority: "User.role" }, after: { authority: "TenantRolePermission" }, actor: actorId, permissionCodes: [], createdRoles, createdGrants, createdAssignments, unknownLegacyRoles, requestId, timestamp: new Date().toISOString() },
      } })
    }
    return { tenantId, createdRoles, createdGrants, createdAssignments, unknownLegacyRoles }
  }

  // Command services can resolve authorization from an existing Prisma
  // transaction. Reuse that transaction instead of attempting to nest one.
  if (typeof prisma.$transaction !== "function") return work(prisma)

  // Concurrent first requests can race while creating the same deterministic
  // templates. Serializable retries keep lazy provisioning transparent.
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      return await prisma.$transaction(work, { isolationLevel: "Serializable", maxWait: 10_000, timeout: 30_000 })
    } catch (error) {
      if (!isTransactionConflict(error) || attempt === 4) throw error
      await new Promise(resolve => setTimeout(resolve, attempt * 25))
    }
  }
  throw new Error("Authorization backfill retry budget exhausted")
}

export async function backfillAllTenantAuthorization(prisma, options = {}) {
  const tenants = await prisma.tenant.findMany({ select: { id: true }, orderBy: { id: "asc" } })
  const results = []
  for (const tenant of tenants) results.push(await backfillTenantAuthorization(prisma, tenant.id, options))
  return results
}
