import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { promisify } from "node:util"
import EmbeddedPostgres from "embedded-postgres"
import { createPrismaClient } from "../server/persistence/prisma-client.mjs"
import { backfillTenantAuthorization } from "../server/auth/authorization-backfill.mjs"
import { createAuthorizationAdminService } from "../server/auth/authorization-admin-service.mjs"
import { can, resolveAuthorizationContext } from "../server/auth/authorization-service.mjs"
import { permissionCodes } from "../server/auth/permission-catalog.mjs"

const execFileAsync = promisify(execFile)
const root = resolve(import.meta.dirname, "..")
const prismaCli = join(root, "node_modules", "prisma", "build", "index.js")
const freePort = () => new Promise((resolvePort, reject) => { const server = createServer().on("error", reject); server.listen(0, "127.0.0.1", () => { const port = server.address().port; server.close(() => resolvePort(port)) }) })
const identity = (tenantId, userId, role) => ({ authenticated: true, tenantId, userId, role, source: "test" })
const decision = (actor, permission, warehouseIds = []) => can({ actor, permission, tenantId: actor.tenantId, warehouseIds })

const port = await freePort()
const password = `local-${randomUUID()}`
const directory = await mkdtemp(join(tmpdir(), "flowchain-auth-pg-"))
const database = "flowchain_authorization_test"
const url = `postgresql://flowchain_auth:${encodeURIComponent(password)}@127.0.0.1:${port}/${database}?schema=public`
const env = { ...process.env, DATABASE_URL: url, DATABASE_URL_TEST: url, FLOWCHAIN_PERSISTENCE_MODE: "database", FLOWCHAIN_REQUIRE_REAL_POSTGRES_TESTS: "true", NODE_ENV: "test" }
const pg = new EmbeddedPostgres({ databaseDir: directory, user: "flowchain_auth", password, port, persistent: false, onLog: () => {}, onError: () => {} })
let prisma
try {
  await pg.initialise(); await pg.start(); await pg.createDatabase(database)
  await execFileAsync(process.execPath, [prismaCli, "migrate", "deploy"], { cwd: root, env, maxBuffer: 20 * 1024 * 1024 })
  prisma = await createPrismaClient(env)
  const tenantId = "tenant-auth-a", otherTenantId = "tenant-auth-b", warehouseId = "warehouse-auth-a"
  await prisma.tenant.createMany({ data: [{ id: tenantId, name: "Authorization A" }, { id: otherTenantId, name: "Authorization B" }] })
  await prisma.warehouse.create({ data: { id: warehouseId, tenantId, code: "AUTH-A", name: "Authorization Warehouse", status: "active" } })
  const users = [
    ["user-admin", "admin"], ["user-manager", "manager"], ["user-ops", "business-specialist"], ["user-buyer", "buyer"], ["user-viewer", "viewer"], ["user-unknown", "mystery-role"],
  ]
  for (const [id, role] of users) await prisma.user.create({ data: { id, tenantId, email: `${id}@flowchain.invalid`, name: id, role, status: "active" } })
  await prisma.user.create({ data: { id: "user-other", tenantId: otherTenantId, email: "other@flowchain.invalid", name: "Other", role: "admin", status: "active" } })
  await prisma.userWarehouseScope.createMany({ data: users.filter(([id]) => id !== "user-viewer").map(([id]) => ({ id: randomUUID(), tenantId, userId: id, warehouseId, accessLevel: "operate" })) })

  const first = await backfillTenantAuthorization(prisma, tenantId, { actorId: "user-admin", requestId: "db-gate" })
  const second = await backfillTenantAuthorization(prisma, tenantId, { actorId: "user-admin", requestId: "db-gate-replay" })
  assert.equal(first.createdRoles, 8); assert.equal(second.createdRoles, 0); assert.equal(second.createdAssignments, 0)
  assert.equal(await prisma.tenantRole.count({ where: { tenantId } }), 8)
  const context = async (id, role) => resolveAuthorizationContext(identity(tenantId, id, role), { prisma, performLegacyBackfill: false })
  const admin = await context("user-admin", "admin"), manager = await context("user-manager", "manager"), ops = await context("user-ops", "business-specialist"), buyer = await context("user-buyer", "buyer"), viewer = await context("user-viewer", "viewer"), unknown = await context("user-unknown", "mystery-role")
  assert.equal(admin.permissionCodes.size, permissionCodes.length); assert.equal(decision(manager, "returns.posting.reverse", [warehouseId]), true)
  assert.equal(decision(buyer, "returns.request.submit", [warehouseId]), true); assert.equal(decision(buyer, "returns.posting.post", [warehouseId]), false); assert.equal(decision(buyer, "returns.posting.reverse", [warehouseId]), false)
  assert.equal(decision(ops, "returns.posting.post", [warehouseId]), true); assert.equal(decision(ops, "returns.posting.reverse", [warehouseId]), false)
  assert.equal(decision(viewer, "returns.posting.read"), true); assert.equal(decision(viewer, "returns.posting.post", [warehouseId]), false); assert.equal(decision(unknown, "returns.posting.post", [warehouseId]), false)

  const service = createAuthorizationAdminService({ prisma })
  const custom = await service.createRole(admin, { name: "退货执行员", permissionCodes: ["returns.posting.read", "returns.posting.prepare", "returns.posting.post", "returns.posting.reverse"] })
  await service.assignUserRoles(admin, "user-buyer", [buyer.roleIds[0], custom.id])
  let union = await context("user-buyer", "buyer"); assert.equal(decision(union, "returns.request.submit", [warehouseId]), true); assert.equal(decision(union, "returns.posting.reverse", [warehouseId]), true)
  await service.updateRole(admin, custom.id, { permissionCodes: ["returns.posting.read", "returns.posting.prepare", "returns.posting.post"] })
  union = await context("user-buyer", "buyer"); assert.equal(decision(union, "returns.posting.reverse", [warehouseId]), false)
  await service.assignUserRoles(admin, "user-buyer", [buyer.roleIds[0]])
  await service.updateRole(admin, custom.id, { status: "inactive" })
  await assert.rejects(() => service.assignUserRoles(admin, "user-buyer", [custom.id]), (error) => error.code === "AUTHORIZATION_ROLE_INACTIVE")
  await assert.rejects(() => service.assignUserRoles(admin, "user-admin", []), (error) => error.code === "AUTHORIZATION_LAST_ROLES_MANAGER")

  const otherBackfill = await backfillTenantAuthorization(prisma, otherTenantId, { actorId: "user-other" }); assert.equal(otherBackfill.createdRoles, 8)
  const otherRole = await prisma.tenantRole.findFirst({ where: { tenantId: otherTenantId } })
  await assert.rejects(() => service.assignUserRoles(admin, "user-buyer", [otherRole.id]), (error) => error.code === "AUTHORIZATION_CROSS_TENANT_ROLE_ASSIGNMENT")
  await assert.rejects(() => prisma.tenantRolePermission.create({ data: { id: randomUUID(), tenantId, roleId: custom.id, permissionCode: "tenant.custom.permission" } }))
  await assert.rejects(() => prisma.tenantRolePermission.create({ data: { id: randomUUID(), tenantId, roleId: custom.id, permissionCode: "returns.posting.read" } }))
  await assert.rejects(() => prisma.userRoleAssignment.create({ data: { id: randomUUID(), tenantId, userId: "user-viewer", roleId: viewer.roleIds[0] } }))
  assert.equal(decision(ops, "returns.posting.post", ["warehouse-outside-scope"]), false)
  assert.ok(await prisma.auditLog.count({ where: { tenantId, source: { in: ["authorization_backfill", "authorization_governance"] } } }) >= 5)
  console.log(`Authorization PostgreSQL gate: PASS (${permissionCodes.length} catalog permissions, 0 failed, 0 skipped)`)
} finally {
  await prisma?.$disconnect().catch(() => {}); await pg.stop().catch(() => {}); await rm(directory, { recursive: true, force: true }).catch(() => {})
}
