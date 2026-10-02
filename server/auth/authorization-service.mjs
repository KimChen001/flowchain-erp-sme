import { FIELD_GROUP_PERMISSION, assertKnownPermissionCode, moduleReadPermissions, permissionCodeSet } from "./permission-catalog.mjs"
import { backfillTenantAuthorization } from "./authorization-backfill.mjs"

export const AUTHORIZATION_REASON = Object.freeze({
  denied: "AUTHORIZATION_PERMISSION_DENIED",
  tenantMismatch: "AUTHORIZATION_TENANT_MISMATCH",
  warehouseDenied: "AUTHORIZATION_WAREHOUSE_SCOPE_DENIED",
  roleInactive: "AUTHORIZATION_ROLE_INACTIVE",
  incomplete: "AUTHORIZATION_CONTEXT_INCOMPLETE",
  capabilityDisabled: "AUTHORIZATION_CAPABILITY_DISABLED",
})

export class AuthorizationError extends Error {
  constructor(decision, message = "The actor is not authorized to perform this operation.") {
    super(message)
    this.name = "AuthorizationError"
    this.code = decision.reasonCode
    this.status = 403
    this.details = decision
    this.decision = decision
  }
}

const text = (value) => String(value ?? "").trim()
const unique = (items) => [...new Set((items || []).map(text).filter(Boolean))]
const pendingTenantBackfills = new Map()

async function ensureTenantBackfilled(prisma, tenantId, actorId) {
  const existing = pendingTenantBackfills.get(tenantId)
  if (existing) return existing
  const pending = backfillTenantAuthorization(prisma, tenantId, { actorId })
  pendingTenantBackfills.set(tenantId, pending)
  try { return await pending } finally {
    if (pendingTenantBackfills.get(tenantId) === pending) pendingTenantBackfills.delete(tenantId)
  }
}

async function loadUserContext(prisma, identity) {
  const user = await prisma.user.findFirst({
    where: { id: text(identity.userId || identity.id), tenantId: text(identity.tenantId) },
    include: {
      warehouseScopes: true,
      roleAssignments: {
        include: { role: { include: { permissions: true } } },
        orderBy: { createdAt: "asc" },
      },
    },
  })
  return user ? { ...user, warehouseScopes: user.warehouseScopes || [], roleAssignments: user.roleAssignments || [] } : null
}

export async function resolveAuthorizationContext(identity, { prisma, performLegacyBackfill = true } = {}) {
  if (!prisma || !identity?.authenticated || !text(identity.tenantId) || !text(identity.userId || identity.id)) {
    return { complete: false, authenticated: Boolean(identity?.authenticated), tenantId: text(identity?.tenantId), userId: text(identity?.userId || identity?.id), permissionCodes: new Set(), roleIds: [], inactiveRoleIds: [], readWarehouseIds: new Set(), operateWarehouseIds: new Set() }
  }
  let user = await loadUserContext(prisma, identity)
  if (user && performLegacyBackfill && user.roleAssignments.length === 0 && typeof prisma.$transaction === "function") {
    await ensureTenantBackfilled(prisma, user.tenantId, user.id)
    user = await loadUserContext(prisma, identity)
  }
  if (!user || user.status !== "active") {
    return { complete: false, authenticated: true, tenantId: text(identity.tenantId), userId: text(identity.userId || identity.id), permissionCodes: new Set(), roleIds: [], inactiveRoleIds: [], readWarehouseIds: new Set(), operateWarehouseIds: new Set() }
  }
  const activeAssignments = user.roleAssignments.filter((assignment) => assignment.status === "active" && assignment.role.status === "active")
  const inactiveAssignments = user.roleAssignments.filter((assignment) => assignment.status !== "active" || assignment.role.status !== "active")
  const permissionSourceRoleIds = new Map()
  for (const assignment of activeAssignments) {
    for (const grant of assignment.role.permissions) {
      if (!permissionCodeSet.has(grant.permissionCode)) continue
      const source = permissionSourceRoleIds.get(grant.permissionCode) || []
      source.push(assignment.role.id)
      permissionSourceRoleIds.set(grant.permissionCode, source)
    }
  }
  const readWarehouseIds = new Set(user.warehouseScopes.filter((scope) => ["read", "operate"].includes(scope.accessLevel)).map((scope) => scope.warehouseId))
  const operateWarehouseIds = new Set(user.warehouseScopes.filter((scope) => scope.accessLevel === "operate").map((scope) => scope.warehouseId))
  return {
    complete: true,
    authenticated: true,
    tenantId: user.tenantId,
    userId: user.id,
    user,
    legacyRole: user.role,
    roleIds: activeAssignments.map((assignment) => assignment.role.id),
    roles: activeAssignments.map((assignment) => ({ id: assignment.role.id, roleKey: assignment.role.roleKey, name: assignment.role.name })),
    inactiveRoleIds: inactiveAssignments.map((assignment) => assignment.role.id),
    permissionCodes: new Set(permissionSourceRoleIds.keys()),
    permissionSourceRoleIds,
    readWarehouseIds,
    operateWarehouseIds,
  }
}

function fieldVisibility(actor, requestedGroups = []) {
  return Object.fromEntries(unique(requestedGroups).map((group) => {
    const permission = FIELD_GROUP_PERMISSION[group]
    const visible = Boolean(permission && actor?.permissionCodes?.has(permission))
    return [group, { visible, permission: permission || null, reasonCode: visible ? null : "FIELD_PERMISSION_DENIED", redacted: !visible }]
  }))
}

export function authorize({ actor, permission, tenantId, warehouseIds = [], resource = null, fieldGroups = [] }) {
  assertKnownPermissionCode(permission)
  const base = {
    allowed: false,
    permissionCode: permission,
    reasonCode: AUTHORIZATION_REASON.denied,
    tenantMatched: false,
    warehouseScopeMatched: false,
    roleIds: actor?.roleIds || [],
    permissionSourceRoleIds: actor?.permissionSourceRoleIds?.get(permission) || [],
    fieldVisibility: fieldVisibility(actor, fieldGroups),
    limitations: [],
  }
  if (!actor?.complete || !actor.authenticated) return { ...base, reasonCode: AUTHORIZATION_REASON.incomplete, limitations: ["AUTHORIZATION_CONTEXT_INCOMPLETE"] }
  if (!tenantId || actor.tenantId !== tenantId) return { ...base, reasonCode: AUTHORIZATION_REASON.tenantMismatch, limitations: ["TENANT_MISMATCH"] }
  base.tenantMatched = true
  if (resource?.capability && (!resource.capability.enabled || resource.capability.readReady === false && resource.scopeLevel === "read" || resource.capability.writeReady === false && resource.scopeLevel !== "read")) {
    return { ...base, reasonCode: AUTHORIZATION_REASON.capabilityDisabled, limitations: ["CAPABILITY_DISABLED"] }
  }
  if (!actor.permissionCodes.has(permission)) {
    const inactiveGranted = Boolean(resource?.inactivePermissionCodes?.includes(permission))
    return { ...base, reasonCode: inactiveGranted || actor.inactiveRoleIds?.length && resource?.permissionFoundOnlyOnInactiveRole ? AUTHORIZATION_REASON.roleInactive : AUTHORIZATION_REASON.denied, limitations: inactiveGranted ? ["INACTIVE_ROLE_GRANT_IGNORED"] : [] }
  }
  const requestedWarehouseIds = unique(warehouseIds)
  const scopeLevel = resource?.scopeLevel || (requestedWarehouseIds.length ? "operate" : null)
  const allowedWarehouses = scopeLevel === "read" ? actor.readWarehouseIds : actor.operateWarehouseIds
  const warehouseScopeMatched = !requestedWarehouseIds.length || requestedWarehouseIds.every((warehouseId) => allowedWarehouses?.has(warehouseId))
  if (!warehouseScopeMatched) return { ...base, reasonCode: AUTHORIZATION_REASON.warehouseDenied, warehouseScopeMatched: false, limitations: ["WAREHOUSE_SCOPE_REQUIRED"] }
  return { ...base, allowed: true, reasonCode: null, warehouseScopeMatched: true }
}

export function can(input) { return authorize(input).allowed }

export function assertAuthorized(input) {
  const decision = authorize(input)
  if (!decision.allowed) throw new AuthorizationError(decision)
  return decision
}

export function buildAuthorizationDecisionSet({ actor, permissions = [], tenantId = actor?.tenantId, warehouseIds = [], fieldGroups = [], resource = null }) {
  return {
    decisions: Object.fromEntries(unique(permissions).map((permission) => [permission, authorize({ actor, permission, tenantId, warehouseIds, fieldGroups, resource })])),
    fieldVisibility: fieldVisibility(actor, fieldGroups),
  }
}

export function moduleVisibilityFor(actor, capabilities = {}, workspaceEnabledModuleIds = null) {
  return Object.fromEntries(Object.entries(moduleReadPermissions).map(([moduleId, permissions]) => {
    const capabilityIds = ({ "returns-quarantine": ["return-request", "return-authorization", "return-posting", "quarantine-inventory"], receiving: ["receiving-posting"], sales: ["sales"], inventory: ["inventory", "stock-transfer", "cycle-count", "inventory-adjustment-document"], finance: ["finance"], "mobile-operations": ["mobile-operations", "mobile-sync"] })[moduleId] || [moduleId]
    const registered = capabilityIds.map((id) => capabilities[id]).filter(Boolean)
    const capabilityAllowed = registered.length === 0 || registered.some((capability) => Boolean(capability.enabled && capability.readReady))
    const preferenceAllowed = !workspaceEnabledModuleIds || workspaceEnabledModuleIds.has(moduleId)
    const permissionAllowed = permissions.some((permission) => actor?.permissionCodes?.has(permission))
    return [moduleId, { visible: capabilityAllowed && preferenceAllowed && permissionAllowed, capabilityAllowed, preferenceAllowed, permissionAllowed, readPermissions: permissions }]
  }))
}

export function redactFieldGroups(value, visibility, fieldMap) {
  const output = { ...value }
  for (const [field, group] of Object.entries(fieldMap || {})) {
    if (!visibility?.[group]?.visible && Object.prototype.hasOwnProperty.call(output, field)) output[field] = null
  }
  return { ...output, fieldVisibility: visibility }
}
