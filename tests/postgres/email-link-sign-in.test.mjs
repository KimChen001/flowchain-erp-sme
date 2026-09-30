import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createScmServer } from '../../server/bootstrap/scm-server.mjs'
import { readOutbox } from '../../server/mail/outbox-mailer.mjs'
import { createPrismaClient, disconnectPrismaClient } from '../../server/persistence/prisma-client.mjs'

const tenantId = `tenant-email-link-${randomUUID()}`
const users = {
  active: { id: `USR-link-active-${randomUUID()}`, email: 'link-active@example.com', name: 'Active Buyer', role: 'buyer', status: 'active', languagePreference: null },
  chinese: { id: `USR-link-zh-${randomUUID()}`, email: 'link-zh@example.com', name: 'Chinese Buyer', role: 'buyer', status: 'active', languagePreference: 'zh-CN' },
  disabled: { id: `USR-link-disabled-${randomUUID()}`, email: 'link-disabled@example.com', name: 'Disabled Buyer', role: 'buyer', status: 'disabled', languagePreference: null },
}
let prisma
let directory
let outboxPath
let server
let base
const warnings = []
const logger = { warn: (line) => warnings.push(line), error: (line) => warnings.push(line), info: () => {} }

const sha256 = (value) => createHash('sha256').update(value).digest('hex')
let ipCounter = 0
const nextIp = () => `198.51.100.${(ipCounter += 1)}`

async function call(method, path, { body, rawBody, token, ip = nextIp(), headers = {} } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'EmailLinkTest/1.0', 'X-Forwarded-For': `203.0.113.250, ${ip}`, ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    body: rawBody ?? (body === undefined ? undefined : JSON.stringify(body)),
  })
  const raw = await response.text()
  return { status: response.status, body: raw ? JSON.parse(raw) : null, headers: response.headers }
}

async function startServer() {
  server = createScmServer({ errorLogger: logger })
  await new Promise((done) => server.listen(0, '127.0.0.1', done))
  base = `http://127.0.0.1:${server.address().port}`
}
const stopServer = () => new Promise((done) => server.close(done))

const messagesTo = async (email) => (await readOutbox(outboxPath)).filter((message) => message.to === email)
async function waitForMessages(email, count) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const messages = await messagesTo(email)
    if (messages.length >= count) return messages
    await new Promise((done) => setTimeout(done, 50))
  }
  throw new Error(`expected ${count} messages to ${email}, got ${(await messagesTo(email)).length}`)
}
const tokenFrom = (message) => new URL(message.text.match(/https?:\/\/\S+\/sign-in\/confirm\?token=\S+/)[0]).searchParams.get('token')
const requestLink = (email, options = {}) => call('POST', '/api/auth/email-link', { body: { email }, ...options })

test.before(async () => {
  assert.ok(process.env.DATABASE_URL_TEST, 'Run with scripts/run-postgres-test-files.mjs')
  directory = await mkdtemp(join(tmpdir(), 'flowchain-email-link-test-'))
  outboxPath = join(directory, 'outbox.json')
  Object.assign(process.env, {
    FLOWCHAIN_DEFAULT_TENANT_ID: tenantId,
    FLOWCHAIN_LOCAL_SESSION_SECRET: `email-link-${randomUUID()}-secret`,
    FLOWCHAIN_MAIL_PROVIDER: 'outbox',
    FLOWCHAIN_MAIL_OUTBOX_PATH: outboxPath,
    FLOWCHAIN_PUBLIC_BASE_URL: 'https://flowchain.test',
    FLOWCHAIN_TRUST_PROXY: 'true',
  })
  prisma = await createPrismaClient(process.env)
  await prisma.tenant.create({ data: { id: tenantId, name: 'Acme Supply Workspace' } })
  await prisma.user.createMany({ data: Object.values(users).map((user) => ({ ...user, tenantId })) })
  await startServer()
})

test.beforeEach(async () => {
  await prisma.signInRateLimitEvent.deleteMany({})
})

test.after(async () => {
  await stopServer()
  await prisma.auditLog.deleteMany({ where: { tenantId } })
  await prisma.tenant.delete({ where: { id: tenantId } }).catch(() => {})
  await prisma.$disconnect()
  await disconnectPrismaClient()
  await rm(directory, { recursive: true, force: true })
})

test('a link request gets the same 202 for active, disabled, unknown and malformed emails, and only an active user gets mail', async () => {
  const responses = [
    await requestLink(users.active.email.toUpperCase()),
    await requestLink(users.disabled.email),
    await requestLink('nobody@example.com'),
    await requestLink(''),
    await call('POST', '/api/auth/email-link', { body: {} }),
    await call('POST', '/api/auth/email-link', { rawBody: '{not json' }),
  ]
  for (const response of responses) {
    assert.equal(response.status, 202)
    assert.deepEqual(response.body, responses[0].body)
  }
  assert.equal(responses[0].body.status, 'accepted')

  const [message] = await waitForMessages(users.active.email, 1)
  await new Promise((done) => setTimeout(done, 200))
  assert.deepEqual((await readOutbox(outboxPath)).map((entry) => entry.to), [users.active.email])
  assert.equal(message.subject, 'Your FlowChain sign-in link')
  assert.match(message.text, /Acme Supply Workspace/)
  assert.equal(message.tag, 'sign-in-link')

  const token = tokenFrom(message)
  assert.match(token, /^[A-Za-z0-9_-]{43,}$/, '32 random bytes, base64url')
  assert.ok(message.text.includes(`https://flowchain.test/sign-in/confirm?token=${token}`))
  const links = await prisma.workspaceSignInLink.findMany({ where: { tenantId } })
  assert.equal(links.length, 1)
  assert.equal(links[0].userId, users.active.id)
  assert.equal(links[0].tokenHash, sha256(token))
  assert.equal(JSON.stringify(links).includes(token), false, 'only the hash is stored')
  assert.equal(links[0].consumedAt, null)
  const ttl = links[0].expiresAt.getTime() - links[0].createdAt.getTime()
  assert.equal(ttl, 15 * 60_000)
  assert.equal(links[0].requestIp, '198.51.100.0', 'the gateway-appended address, truncated')
  assert.equal(links[0].requestUserAgent, 'EmailLinkTest/1.0')

  const audits = await prisma.auditLog.findMany({ where: { tenantId, action: 'sign_in_link_requested' } })
  assert.equal(audits.length, 1)
  assert.equal(audits[0].actorId, users.active.id)
  assert.equal(audits[0].entityId, links[0].id)
  assert.equal(JSON.stringify(audits).includes(users.active.email), false, 'the audit row names the user by id, not email')
  await prisma.workspaceSignInLink.deleteMany({ where: { tenantId } })
})

test('a Chinese language preference gets the Chinese email', async () => {
  await requestLink(users.chinese.email)
  const [message] = await waitForMessages(users.chinese.email, 1)
  assert.equal(message.subject, '你的 FlowChain 登录链接')
  assert.ok(tokenFrom(message))
})

test('a link signs in once; replayed, superseded, expired, unknown and malformed links get one generic error', async () => {
  const before = (await messagesTo(users.active.email)).length
  await requestLink(users.active.email)
  await requestLink(users.active.email)
  const messages = await waitForMessages(users.active.email, before + 2)
  const superseded = tokenFrom(messages.at(-2))
  const token = tokenFrom(messages.at(-1))

  // Inspecting shows the workspace but uses nothing.
  const inspected = await call('POST', '/api/auth/email-link/inspect', { body: { token } })
  assert.equal(inspected.status, 200)
  assert.deepEqual(inspected.body, { workspaceName: 'Acme Supply Workspace' })

  const confirmed = await call('POST', '/api/auth/email-link/confirm', { body: { token } })
  assert.equal(confirmed.status, 200)
  assert.equal(confirmed.body.user.id, users.active.id)
  assert.equal(confirmed.body.user.tenantId, tenantId)
  const me = await call('GET', '/api/auth/me', { token: confirmed.body.token })
  assert.equal(me.status, 200)
  assert.equal(me.body.id, users.active.id)

  const generic = { code: 'SIGN_IN_LINK_INVALID', message: 'This sign-in link is invalid or has expired. Request a new one.' }
  const replay = await call('POST', '/api/auth/email-link/confirm', { body: { token } })
  assert.equal(replay.status, 400)
  assert.deepEqual(replay.body, generic)
  assert.deepEqual((await call('POST', '/api/auth/email-link/confirm', { body: { token: superseded } })).body, generic)
  assert.deepEqual((await call('POST', '/api/auth/email-link/confirm', { body: { token: randomBytes(32).toString('base64url') } })).body, generic)
  assert.deepEqual((await call('POST', '/api/auth/email-link/confirm', { body: { token: 'short' } })).body, generic)
  assert.deepEqual((await call('POST', '/api/auth/email-link/confirm', { body: {} })).body, generic)
  assert.deepEqual((await call('POST', '/api/auth/email-link/inspect', { body: { token } })).body, generic)

  await requestLink(users.active.email)
  const expired = tokenFrom((await waitForMessages(users.active.email, before + 3)).at(-1))
  await prisma.workspaceSignInLink.update({ where: { tokenHash: sha256(expired) }, data: { expiresAt: new Date(Date.now() - 1000) } })
  const expiredResponse = await call('POST', '/api/auth/email-link/confirm', { body: { token: expired } })
  assert.equal(expiredResponse.status, 400)
  assert.deepEqual(expiredResponse.body, generic)

  // A link issued before the user was disabled does not sign them in.
  await requestLink(users.active.email)
  const beforeDisable = tokenFrom((await waitForMessages(users.active.email, before + 4)).at(-1))
  await prisma.user.update({ where: { id: users.active.id }, data: { status: 'disabled' } })
  assert.deepEqual((await call('POST', '/api/auth/email-link/confirm', { body: { token: beforeDisable } })).body, generic)
  await prisma.user.update({ where: { id: users.active.id }, data: { status: 'active' } })

  const session = await prisma.workspaceSession.findFirst({ where: { tenantId, userId: users.active.id }, orderBy: { createdAt: 'desc' } })
  assert.equal(session.userAgent, 'EmailLinkTest/1.0')
  assert.match(session.ipAddress, /^198\.51\.100\.0$/)
  const consumed = await prisma.auditLog.findMany({ where: { tenantId, action: 'sign_in_link_consumed' } })
  const created = await prisma.auditLog.findMany({ where: { tenantId, action: 'session_created' } })
  assert.equal(consumed.length, 1)
  assert.equal(created.length, 1)
  assert.equal(created[0].entityId, session.id)
  assert.equal(created[0].actorId, users.active.id)
})

test('concurrent confirms of one link create exactly one session', async () => {
  const before = (await messagesTo(users.active.email)).length
  await requestLink(users.active.email)
  const token = tokenFrom((await waitForMessages(users.active.email, before + 1)).at(-1))
  const sessionsBefore = await prisma.workspaceSession.count({ where: { tenantId, userId: users.active.id } })
  const results = await Promise.all(Array.from({ length: 8 }, () => call('POST', '/api/auth/email-link/confirm', { body: { token } })))
  assert.deepEqual(results.map((result) => result.status).sort(), [200, 400, 400, 400, 400, 400, 400, 400])
  assert.equal(await prisma.workspaceSession.count({ where: { tenantId, userId: users.active.id } }), sessionsBefore + 1)
})

test('at most 5 links per email and 20 requests per IP an hour; over the limit still answers 202, sends nothing, logs, and survives a restart', async () => {
  const email = users.chinese.email
  const before = (await messagesTo(email)).length
  warnings.length = 0
  const accepted = []
  for (let index = 0; index < 5; index += 1) accepted.push(await requestLink(email))
  await waitForMessages(email, before + 5)
  const limited = await requestLink(email)
  assert.equal(limited.status, 202)
  assert.deepEqual(limited.body, accepted[0].body)

  // A deploy does not reset the count.
  await stopServer()
  await startServer()
  const afterRestart = await requestLink(email)
  assert.equal(afterRestart.status, 202)
  await new Promise((done) => setTimeout(done, 300))
  assert.equal((await messagesTo(email)).length, before + 5)
  const limitWarnings = warnings.filter((line) => line.includes('sign_in_link_rate_limited'))
  assert.equal(limitWarnings.length, 2)
  assert.ok(limitWarnings.every((line) => JSON.parse(line).limit === 'email'))
  assert.equal(warnings.some((line) => line.includes(email)), false, 'logs never contain the email address')

  // Per IP: 20 requests from one address, then an active user's request from
  // that address sends nothing, while another address still works.
  await prisma.signInRateLimitEvent.deleteMany({})
  const ip = '192.0.2.77'
  for (let index = 0; index < 20; index += 1) assert.equal((await requestLink(`unknown-${index}@example.com`, { ip })).status, 202)
  const activeBefore = (await messagesTo(users.active.email)).length
  assert.equal((await requestLink(users.active.email, { ip })).status, 202)
  await new Promise((done) => setTimeout(done, 300))
  assert.equal((await messagesTo(users.active.email)).length, activeBefore)
  assert.ok(warnings.some((line) => line.includes('sign_in_link_rate_limited') && JSON.parse(line).limit === 'ip'))
  await requestLink(users.active.email, { ip: '192.0.2.78' })
  await waitForMessages(users.active.email, activeBefore + 1)
})
