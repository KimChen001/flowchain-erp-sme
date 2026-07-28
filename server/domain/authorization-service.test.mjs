import test from "node:test"
import assert from "node:assert/strict"
import { authorize, buildAuthorizationDecisionSet, moduleVisibilityFor, redactFieldGroups } from "../auth/authorization-service.mjs"
import { defaultRoleTemplates, legacyRoleTemplateMap, permissionCatalog, permissionCodeSet } from "../auth/permission-catalog.mjs"

const actor = (permissions = [], overrides = {}) => ({ complete: true, authenticated: true, tenantId: "tenant-a", userId: "user-a", roleIds: ["role-a"], inactiveRoleIds: [], permissionCodes: new Set(permissions), permissionSourceRoleIds: new Map(permissions.map((code) => [code, ["role-a"]])), readWarehouseIds: new Set(["warehouse-a"]), operateWarehouseIds: new Set(["warehouse-a"]), ...overrides })

test("permission catalog codes are stable, unique, system-defined records", () => {
  assert.equal(permissionCatalog.length, permissionCodeSet.size)
  assert.ok(permissionCatalog.length >= 90)
  for (const permission of permissionCatalog) for (const field of ["code", "module", "resource", "action", "labelKey", "descriptionKey", "riskLevel", "fieldVisibility", "deprecated", "replacementCode"]) assert.ok(Object.hasOwn(permission, field), `${permission.code}.${field}`)
})

test("default templates preserve legacy mappings and return separation", () => {
  assert.equal(defaultRoleTemplates.length, 8)
  assert.equal(legacyRoleTemplateMap.admin, "workspace-administrator")
  assert.equal(legacyRoleTemplateMap.business_specialist, "operations-specialist")
  const procurement = defaultRoleTemplates.find((role) => role.roleKey === "procurement-specialist")
  const operations = defaultRoleTemplates.find((role) => role.roleKey === "operations-specialist")
  assert.ok(procurement.permissions.includes("returns.request.submit")); assert.ok(!procurement.permissions.includes("returns.posting.post")); assert.ok(!procurement.permissions.includes("returns.posting.reverse"))
  assert.ok(operations.permissions.includes("returns.posting.post")); assert.ok(!operations.permissions.includes("returns.authorization.approve")); assert.ok(!operations.permissions.includes("returns.posting.reverse"))
})

test("intake uploader, reviewer, and administrator duties remain separated", () => {
  const uploader = defaultRoleTemplates.find((role) => role.roleKey === "intake-uploader")
  const reviewer = defaultRoleTemplates.find((role) => role.roleKey === "intake-reviewer")
  const administrator = defaultRoleTemplates.find((role) => role.roleKey === "workspace-administrator")
  assert.ok(uploader.permissions.includes("intake.artifact.create"))
  assert.ok(!uploader.permissions.includes("intake.mapping.manage"))
  assert.ok(!uploader.permissions.includes("intake.review"))
  assert.ok(!uploader.permissions.includes("intake.commit"))
  assert.ok(reviewer.permissions.includes("intake.mapping.manage"))
  assert.ok(reviewer.permissions.includes("intake.review"))
  assert.ok(!reviewer.permissions.includes("intake.artifact.create"))
  assert.ok(!reviewer.permissions.includes("intake.commit"))
  assert.ok(administrator.permissions.includes("intake.commit"))
})

test("operations manager can review sensitive approval evidence without settlement posting authority", () => {
  const manager = defaultRoleTemplates.find((role) => role.roleKey === "operations-manager")
  for (const permission of ["procurement.prices.read", "finance.amounts.read", "finance.partner_snapshot.read", "procurement.purchase_order.approve", "finance.settlement.approve"]) assert.ok(manager.permissions.includes(permission), permission)
  assert.ok(!manager.permissions.includes("finance.settlement.post"))
  assert.ok(!manager.permissions.includes("finance.settlement.reverse"))
})

test("authorization defaults deny and composes tenant, permission, and warehouse scope", () => {
  const current = actor(["returns.posting.post"])
  assert.equal(authorize({ actor: current, permission: "returns.posting.post", tenantId: "tenant-a", warehouseIds: ["warehouse-a"] }).allowed, true)
  assert.equal(authorize({ actor: current, permission: "returns.posting.reverse", tenantId: "tenant-a" }).reasonCode, "AUTHORIZATION_PERMISSION_DENIED")
  assert.equal(authorize({ actor: current, permission: "returns.posting.post", tenantId: "tenant-b" }).reasonCode, "AUTHORIZATION_TENANT_MISMATCH")
  assert.equal(authorize({ actor: current, permission: "returns.posting.post", tenantId: "tenant-a", warehouseIds: ["warehouse-b"] }).reasonCode, "AUTHORIZATION_WAREHOUSE_SCOPE_DENIED")
  assert.equal(authorize({ actor: current, permission: "returns.posting.post", tenantId: "tenant-a", resource: { capability: { enabled: false } } }).reasonCode, "AUTHORIZATION_CAPABILITY_DISABLED")
})

test("field visibility redacts on the server with null rather than substituted values", () => {
  const denied = buildAuthorizationDecisionSet({ actor: actor([]), permissions: ["finance.overview.read"], fieldGroups: ["finance_amounts"] })
  const value = redactFieldGroups({ totalAmount: "125.00", currency: "CNY" }, denied.fieldVisibility, { totalAmount: "finance_amounts" })
  assert.equal(value.totalAmount, null); assert.equal(value.currency, "CNY"); assert.equal(value.fieldVisibility.finance_amounts.reasonCode, "FIELD_PERMISSION_DENIED")
})

test("sales read navigation remains visible when write lifecycle capabilities are disabled", () => {
  const visibility = moduleVisibilityFor(
    actor(["sales_order.read"]),
    {
      sales: { enabled: true, readReady: true },
      "sales-order-lifecycle": { enabled: false, readReady: true },
      "sales-shipment-posting": { enabled: false, readReady: true },
    },
  )
  assert.equal(visibility.sales.permissionAllowed, true)
  assert.equal(visibility.sales.capabilityAllowed, true)
  assert.equal(visibility.sales.visible, true)
})
