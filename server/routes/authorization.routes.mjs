import { getPrismaClient } from "../persistence/prisma-client.mjs"
import { resolveProvisionedActor } from "../domain/pilot-identity.mjs"
import { capabilityRegistryForEnvironment } from "../domain/capability-registry.mjs"
import { buildAuthorizationDecisionSet, moduleVisibilityFor } from "../auth/authorization-service.mjs"
import { createAuthorizationAdminService } from "../auth/authorization-admin-service.mjs"
import { FIELD_GROUP_PERMISSION, permissionCodes } from "../auth/permission-catalog.mjs"

export async function handleAuthorizationRoute(ctx) {
  const { req, res, url, send, readBody } = ctx
  if (!url.pathname.startsWith("/api/authorization")) return false
  try {
    const prisma = await getPrismaClient(ctx.env || process.env)
    const actor = await resolveProvisionedActor(prisma, ctx.identity)
    const service = createAuthorizationAdminService({ prisma })
    if (req.method === "GET" && url.pathname === "/api/authorization/context") {
      const capabilities = Object.fromEntries(capabilityRegistryForEnvironment(ctx.env || process.env).map((entry) => [entry.id, entry]))
      const fieldGroups = Object.keys(FIELD_GROUP_PERMISSION)
      const decisions = buildAuthorizationDecisionSet({ actor, permissions: permissionCodes, tenantId: actor.tenantId, fieldGroups })
      send(res, 200, { tenantId: actor.tenantId, userId: actor.userId, roleIds: actor.roleIds, roles: actor.roles, effectivePermissions: [...actor.permissionCodes].sort(), moduleVisibility: moduleVisibilityFor(actor, capabilities), fieldVisibility: decisions.fieldVisibility, warehouseScope: { readWarehouseIds: [...actor.readWarehouseIds], operateWarehouseIds: [...actor.operateWarehouseIds] } })
      return true
    }
    if (req.method === "GET" && url.pathname === "/api/authorization/roles") { send(res, 200, await service.list(actor)); return true }
    if (req.method === "POST" && url.pathname === "/api/authorization/roles") { send(res, 201, await service.createRole(actor, await readBody(req))); return true }
    const roleMatch = url.pathname.match(/^\/api\/authorization\/roles\/([^/]+)$/)
    if (req.method === "PATCH" && roleMatch) { send(res, 200, await service.updateRole(actor, decodeURIComponent(roleMatch[1]), await readBody(req))); return true }
    const assignmentMatch = url.pathname.match(/^\/api\/authorization\/users\/([^/]+)\/roles$/)
    if (req.method === "PUT" && assignmentMatch) { const body = await readBody(req); send(res, 200, await service.assignUserRoles(actor, decodeURIComponent(assignmentMatch[1]), body.roleIds)); return true }
    send(res, 404, { code: "AUTHORIZATION_ROUTE_NOT_FOUND", message: "Authorization route was not found." })
    return true
  } catch (error) {
    send(res, error?.status || 500, { code: error?.code || "AUTHORIZATION_INTERNAL_ERROR", message: error?.message || "Authorization request failed.", ...(error?.details ? { details: error.details } : {}) })
    return true
  }
}
