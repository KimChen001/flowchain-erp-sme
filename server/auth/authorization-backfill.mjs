import { createHash, randomUUID } from "node:crypto"
import { defaultRoleTemplates, legacyRoleTemplateMap } from "./permission-catalog.mjs"
import { isTransactionConflict } from "../persistence/transaction-conflict.mjs"

const stableId = (...parts) => `AUTH-${createHash("sha256").update(parts.join(":"), "utf8").digest("hex").slice(0, 28)}`
const normalizedLegacyRole = (value) => String(value || "").trim().toLowerCase()

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
      for (const permissionCode of template.permissions) {
        const grantId = stableId(tenantId, "grant", role.id, permissionCode)
        const existingGrant = await tx.tenantRolePermission.findUnique({ where: { roleId_permissionCode: { roleId: role.id, permissionCode } } })
        await tx.tenantRolePermission.upsert({ where: { roleId_permissionCode: { roleId: role.id, permissionCode } }, create: { id: grantId, tenantId, roleId: role.id, permissionCode, createdById: actorId }, update: {} })
        if (!existingGrant) createdGrants += 1
      }
    }

    const users = await tx.user.findMany({ where: { tenantId }, select: { id: true, role: true } })
    const warehouses = await tx.warehouse.findMany({ where: { tenantId }, select: { id: true } })
    const unknownLegacyRoles = []
    for (const user of users) {
      const legacyRole = normalizedLegacyRole(user.role)
      const roleKey = legacyRoleTemplateMap[legacyRole] || "read-only-viewer"
      if (!legacyRoleTemplateMap[legacyRole]) unknownLegacyRoles.push({ userId: user.id, legacyRole })
      const role = roles.get(roleKey)
      const existing = await tx.userRoleAssignment.findUnique({ where: { userId_roleId: { userId: user.id, roleId: role.id } } })
      await tx.userRoleAssignment.upsert({ where: { userId_roleId: { userId: user.id, roleId: role.id } }, create: { id: stableId(tenantId, "assignment", user.id, role.id), tenantId, userId: user.id, roleId: role.id, status: "active", createdById: actorId }, update: {} })
      if (!existing) createdAssignments += 1
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
