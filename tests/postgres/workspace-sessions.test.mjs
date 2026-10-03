import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { createServer as createNetServer } from 'node:net'
import { resolve } from 'node:path'
import { createScmServer } from '../../server/bootstrap/scm-server.mjs'
import { backfillTenantAuthorization } from '../../server/auth/authorization-backfill.mjs'
import { createWorkspaceSessionStore } from '../../server/auth/workspace-sessions.mjs'
import { createPrismaClient, disconnectPrismaClient } from '../../server/persistence/prisma-client.mjs'

const root = resolve(import.meta.dirname, '..', '..')
const tenantId = `tenant-sessions-${randomUUID()}`
const secret = `workspace-sessions-${randomUUID()}-secret`
const users = {
  admin: { id: `USR-sessions-admin-${randomUUID()}`, email: 'sessions-admin@example.com', name: 'Session Admin', role: 'admin' },
  buyer: { id: `USR-sessions-buyer-${randomUUID()}`, email: 'sessions-buyer@example.com', name: 'Session Buyer', role: 'buyer' },
  viewer: { id: `USR-sessions-viewer-${randomUUID()}`, email: 'sessions-viewer@example.com', name: 'Session Viewer', role: 'viewer' },
}
let prisma

const freePort = () => new Promise((resolvePort, reject) => {
  const server = createNetServer().on('error', reject)
  server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolvePort(port)) })
})

async function call(base, method, path, { token, body } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const raw = await response.text()
  return { status: response.status, body: raw ? JSON.parse(raw) : null }
}

async function startInProcess() {
  const server = createScmServer()
  await new Promise((done) => server.listen(0, '127.0.0.1', done))
  return { base: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((done) => server.close(done)) }
}

// A deploy is a new server process: nothing in memory survives it.
async function startChildProcess() {
  const port = await freePort()
  const child = spawn(process.execPath, ['server/index.mjs'], { cwd: root, env: { ...process.env, SCM_API_PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  child.stdout.on('data', (chunk) => { output += chunk })
  child.stderr.on('data', (chunk) => { output += chunk })
  const base = `http://127.0.0.1:${port}`
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`server exited: ${output}`)
    try { if ((await fetch(`${base}/api/health`)).ok) break } catch {}
    await new Promise((done) => setTimeout(done, 100))
  }
  return { base, close: () => new Promise((done) => { child.once('exit', done); child.kill() }) }
}

// The legacy direct sign-in, available in test mode only.
const signIn = (base, email) => call(base, 'POST', '/api/auth/login', { body: { email } })

test.before(async () => {
  assert.ok(process.env.DATABASE_URL_TEST, 'Run with scripts/run-postgres-test-files.mjs')
  Object.assign(process.env, { FLOWCHAIN_DEFAULT_TENANT_ID: tenantId, FLOWCHAIN_LOCAL_SESSION_SECRET: secret })
  prisma = await createPrismaClient(process.env)
  await prisma.tenant.create({ data: { id: tenantId, name: 'Session Workspace' } })
  await prisma.user.createMany({ data: Object.values(users).map((user) => ({ ...user, tenantId, status: 'active' })) })
  await backfillTenantAuthorization(prisma, tenantId, { actorId: users.admin.id })
})

test.after(async () => {
  await prisma.auditLog.deleteMany({ where: { tenantId } })
  await prisma.tenant.delete({ where: { id: tenantId } }).catch(() => {})
  await prisma.$disconnect()
  await disconnectPrismaClient()
})

test('a session created by one server process stays valid in a fresh process on the same database', async () => {
  const first = await startInProcess()
  const login = await signIn(first.base, users.buyer.email)
  await first.close()
  assert.equal(login.status, 200)
  assert.equal(login.body.user.id, users.buyer.id)

  const rows = await prisma.workspaceSession.findMany({ where: { tenantId, userId: users.buyer.id } })
  assert.equal(rows.length, 1)
  const [payload] = login.body.token.split('.')
  const sid = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')).sid
  assert.equal(rows[0].sessionIdHash, createHash('sha256').update(sid).digest('hex'))
  assert.equal(JSON.stringify(rows).includes(sid), false, 'the raw session id is never stored')
  assert.equal(rows[0].revokedAt, null)
  assert.ok(rows[0].expiresAt > new Date())

  const second = await startChildProcess()
  try {
    const me = await call(second.base, 'GET', '/api/auth/me', { token: login.body.token })
    assert.equal(me.status, 200)
    assert.equal(me.body.id, users.buyer.id)
    assert.equal(me.body.tenantId, tenantId)
  } finally {
    await second.close()
  }
})

test('sign-out revokes the session in the database and records it', async () => {
  const server = await startInProcess()
  try {
    const login = await signIn(server.base, users.viewer.email)
    assert.equal((await call(server.base, 'GET', '/api/auth/me', { token: login.body.token })).status, 200)
    const logout = await call(server.base, 'POST', '/api/auth/logout', { token: login.body.token })
    assert.equal(logout.status, 200)
    assert.equal((await call(server.base, 'GET', '/api/auth/me', { token: login.body.token })).status, 401)
    assert.equal((await call(server.base, 'GET', '/api/workspace', { token: login.body.token })).status, 401)
    // Signing out twice, or without a session, is harmless.
    assert.equal((await call(server.base, 'POST', '/api/auth/logout', { token: login.body.token })).status, 200)
    assert.equal((await call(server.base, 'POST', '/api/auth/logout')).status, 200)

    const row = await prisma.workspaceSession.findFirst({ where: { tenantId, userId: users.viewer.id }, orderBy: { createdAt: 'desc' } })
    assert.ok(row.revokedAt)
    assert.equal(row.revokedReason, 'logout')
    const audits = await prisma.auditLog.findMany({ where: { tenantId, action: 'session_logout', entityId: row.id } })
    assert.equal(audits.length, 1)
    assert.equal(audits[0].actorId, users.viewer.id)
  } finally {
    await server.close()
  }
})

test('disabling a user or changing their role assignments ends their sessions at once', async () => {
  const server = await startInProcess()
  try {
    const admin = (await signIn(server.base, users.admin.email)).body.token
    const target = async () => (await signIn(server.base, users.viewer.email)).body.token
    const current = async () => prisma.user.findUnique({ where: { id: users.viewer.id } })

    // The user endpoint refuses a legacy role change, which would grant
    // nothing, so the session is kept.
    let token = await target()
    assert.equal((await call(server.base, 'GET', '/api/auth/me', { token })).status, 200)
    let patch = await call(server.base, 'PATCH', `/api/workspace/users/${users.viewer.id}`, { token: admin, body: { role: 'manager', status: 'active', version: (await current()).version } })
    assert.equal(patch.status, 422)
    assert.equal(patch.body.code, 'USER_ROLE_CHANGE_NOT_SUPPORTED')
    assert.equal((await current()).role, 'viewer')
    assert.equal((await call(server.base, 'GET', '/api/auth/me', { token })).status, 200)

    // Saving without a change keeps the session.
    patch = await call(server.base, 'PATCH', `/api/workspace/users/${users.viewer.id}`, { token: admin, body: { role: 'viewer', status: 'active', version: (await current()).version } })
    assert.equal(patch.status, 200)
    assert.equal((await call(server.base, 'GET', '/api/auth/me', { token })).status, 200)

    // Role assignment change through role governance.
    const roles = await prisma.tenantRole.findMany({ where: { tenantId } })
    const buyerRole = roles.find((role) => role.roleKey === 'procurement-specialist')
    assert.ok(buyerRole)
    const assign = await call(server.base, 'PUT', `/api/authorization/users/${users.viewer.id}/roles`, { token: admin, body: { roleIds: [buyerRole.id] } })
    assert.equal(assign.status, 200)
    assert.equal((await call(server.base, 'GET', '/api/auth/me', { token })).status, 401)

    // Disabling the user.
    token = await target()
    patch = await call(server.base, 'PATCH', `/api/workspace/users/${users.viewer.id}`, { token: admin, body: { status: 'disabled', version: (await current()).version } })
    assert.equal(patch.status, 200)
    assert.equal((await call(server.base, 'GET', '/api/auth/me', { token })).status, 401)
    assert.equal(await prisma.workspaceSession.count({ where: { tenantId, userId: users.viewer.id, revokedAt: null } }), 0)
    const revocations = await prisma.auditLog.findMany({ where: { tenantId, action: 'sessions_revoked', entityId: users.viewer.id }, orderBy: { createdAt: 'asc' } })
    assert.deepEqual(revocations.map((row) => row.metadata.reason), ['role_changed', 'user_disabled'])
    assert.ok(revocations.every((row) => row.actorId === users.admin.id))
    // The admin's own session is untouched.
    assert.equal((await call(server.base, 'GET', '/api/auth/me', { token: admin })).status, 200)
  } finally {
    await prisma.user.update({ where: { id: users.viewer.id }, data: { status: 'active', role: 'viewer' } })
    await server.close()
  }
})

test('a stored session is refused once it expires, its user is disabled, or its tenant no longer matches the user', async () => {
  const store = createWorkspaceSessionStore({ env: process.env, prismaFactory: async () => prisma })
  const created = await store.create({ tenantId, userId: users.buyer.id })
  const fresh = (env = process.env) => createWorkspaceSessionStore({ env, prismaFactory: async () => prisma })
  assert.equal((await fresh().resolve(created.sessionId)).userId, users.buyer.id)
  assert.equal(await fresh().resolve('not-a-session'), null)
  // The session keeps its tenant when the server default changes, but a row
  // whose tenant no longer matches its user is refused.
  assert.equal((await fresh({ ...process.env, FLOWCHAIN_DEFAULT_TENANT_ID: 'another-tenant' }).resolve(created.sessionId)).tenantId, tenantId)
  const otherTenant = `${tenantId}-other`
  await prisma.tenant.create({ data: { id: otherTenant, name: 'Other Workspace' } })
  const moved = await store.create({ tenantId, userId: users.buyer.id })
  await prisma.workspaceSession.update({ where: { id: moved.row.id }, data: { tenantId: otherTenant } })
  assert.equal(await fresh().resolve(moved.sessionId), null)
  await prisma.tenant.delete({ where: { id: otherTenant } })

  await prisma.user.update({ where: { id: users.buyer.id }, data: { status: 'disabled' } })
  assert.equal(await fresh().resolve(created.sessionId), null)
  await prisma.user.update({ where: { id: users.buyer.id }, data: { status: 'active' } })
  assert.ok(await fresh().resolve(created.sessionId))

  await prisma.workspaceSession.update({ where: { id: created.row.id }, data: { expiresAt: new Date(Date.now() - 1000) } })
  assert.equal(await fresh().resolve(created.sessionId), null)

  const revokedLater = await store.create({ tenantId, userId: users.buyer.id })
  assert.ok(await store.resolve(revokedLater.sessionId))
  await store.revoke(revokedLater.sessionId)
  assert.equal(await store.resolve(revokedLater.sessionId), null, 'the cache drops a revoked session at once')
})
