import assert from "node:assert/strict"
import { execFile, spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { promisify } from "node:util"
import EmbeddedPostgres from "embedded-postgres"
import { createPrismaClient } from "../server/persistence/prisma-client.mjs"
import { backfillTenantAuthorization } from "../server/auth/authorization-backfill.mjs"

const execFileAsync = promisify(execFile), root = resolve(import.meta.dirname, ".."), prismaCli = join(root, "node_modules", "prisma", "build", "index.js")
const freePort = () => new Promise((resolvePort, reject) => { const server = createServer().on("error", reject); server.listen(0, "127.0.0.1", () => { const port = server.address().port; server.close(() => resolvePort(port)) }) })
const pgPort = await freePort(), apiPort = await freePort(), password = `local-${randomUUID()}`, directory = await mkdtemp(join(tmpdir(), "flowchain-auth-api-")), database = "flowchain_authorization_api_test", tenantId = "tenant-auth-api"
const url = `postgresql://flowchain_auth_api:${encodeURIComponent(password)}@127.0.0.1:${pgPort}/${database}?schema=public`
const env = { ...process.env, DATABASE_URL: url, DATABASE_URL_TEST: url, FLOWCHAIN_APPROVAL_EMAILS: process.env.FLOWCHAIN_APPROVAL_EMAILS || "off", FLOWCHAIN_PERSISTENCE_MODE: "database", FLOWCHAIN_DEFAULT_TENANT_ID: tenantId, FLOWCHAIN_ALLOW_TEST_IDENTITY_HEADERS: "true", NODE_ENV: "test", SCM_API_PORT: String(apiPort) }
const pg = new EmbeddedPostgres({ databaseDir: directory, user: "flowchain_auth_api", password, port: pgPort, persistent: false, onLog: () => {}, onError: () => {} })
let prisma, child
const request = async (path, { userId, role, method = "GET", body } = {}) => { const response = await fetch(`http://127.0.0.1:${apiPort}${path}`, { method, headers: { "content-type": "application/json", "x-flowchain-user": userId, "x-flowchain-role": role }, ...(body ? { body: JSON.stringify(body) } : {}) }); const payload = await response.json(); return { status: response.status, payload } }
try {
  await pg.initialise(); await pg.start(); await pg.createDatabase(database); await execFileAsync(process.execPath, [prismaCli, "migrate", "deploy"], { cwd: root, env, maxBuffer: 20 * 1024 * 1024 })
  prisma = await createPrismaClient(env)
  await prisma.tenant.create({ data: { id: tenantId, name: "Authorization API" } })
  await prisma.user.createMany({ data: [{ id: "api-admin", tenantId, email: "admin@api.invalid", name: "API Admin", role: "admin", status: "active" }, { id: "api-viewer", tenantId, email: "viewer@api.invalid", name: "API Viewer", role: "viewer", status: "active" }] })
  await backfillTenantAuthorization(prisma, tenantId, { actorId: "api-admin" }); await prisma.$disconnect(); prisma = null
  child = spawn(process.execPath, ["server/index.mjs"], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] }); child.stderr.on("data", (chunk) => process.stderr.write(String(chunk).replace(/postgres(?:ql)?:\/\/[^\s]+/gi, "[REDACTED_DATABASE_URL]")))
  let ready = false; const started = Date.now(); while (Date.now() - started < 20_000) { try { if ((await fetch(`http://127.0.0.1:${apiPort}/api/health`)).ok) { ready = true; break } } catch {} await new Promise((resolveWait) => setTimeout(resolveWait, 100)) } assert.equal(ready, true, "API did not become ready")
  const denied = await request("/api/authorization/roles", { userId: "api-viewer", role: "viewer", method: "POST", body: { name: "Forbidden" } }); assert.equal(denied.status, 403); assert.equal(denied.payload.code, "AUTHORIZATION_PERMISSION_DENIED")
  const created = await request("/api/authorization/roles", { userId: "api-admin", role: "admin", method: "POST", body: { name: "Return Operator", permissionCodes: ["returns.posting.read", "returns.posting.post"] } }); assert.equal(created.status, 201)
  const assigned = await request("/api/authorization/users/api-viewer/roles", { userId: "api-admin", role: "admin", method: "PUT", body: { roleIds: [created.payload.id] } }); assert.equal(assigned.status, 200)
  let context = await request("/api/authorization/context", { userId: "api-viewer", role: "viewer" }); assert.equal(context.status, 200); assert.ok(context.payload.effectivePermissions.includes("returns.posting.post")); assert.equal(context.payload.moduleVisibility["returns-quarantine"].permissionAllowed, true); assert.equal(context.payload.moduleVisibility["returns-quarantine"].capabilityAllowed, false)
  const removed = await request(`/api/authorization/roles/${created.payload.id}`, { userId: "api-admin", role: "admin", method: "PATCH", body: { permissionCodes: ["returns.posting.read"] } }); assert.equal(removed.status, 200)
  context = await request("/api/authorization/context", { userId: "api-viewer", role: "viewer" }); assert.equal(context.status, 200); assert.equal(context.payload.effectivePermissions.includes("returns.posting.post"), false)
  const unknown = await request(`/api/authorization/roles/${created.payload.id}`, { userId: "api-admin", role: "admin", method: "PATCH", body: { permissionCodes: ["tenant.custom.permission"] } }); assert.equal(unknown.status, 422)
  console.log("Authorization API gate: PASS (0 failed, 0 skipped)")
} finally {
  if (child && child.exitCode === null) { child.kill("SIGTERM"); await Promise.race([new Promise((resolveExit) => child.once("exit", resolveExit)), new Promise((resolveWait) => setTimeout(resolveWait, 3000))]); if (child.exitCode === null) child.kill("SIGKILL") }
  await prisma?.$disconnect().catch(() => {}); await pg.stop().catch(() => {}); await rm(directory, { recursive: true, force: true }).catch(() => {})
}
