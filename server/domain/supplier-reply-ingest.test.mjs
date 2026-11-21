import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { apiAccessDenial } from '../bootstrap/api-access-gate.mjs'
import {
  INTEGRATION_TOKEN_LIMIT, INTEGRATION_TOKEN_NAMESPACE, INTEGRATION_TOKEN_USE_NAMESPACE,
  createIngestRateLimiter, formatIntegrationToken, hashIntegrationSecret, integrationSecretMatches, newIntegrationToken, parseIntegrationToken,
} from './integration-tokens.mjs'
import { handleSupplierReplyIngestRoute } from '../routes/supplier-reply-ingest.routes.mjs'
import { createSupplierReplyIngestService, orderNumbersIn, supplierReplyIngestEnabled, supplierReplyIngestPerDay } from '../services/supplier-reply-ingest.mjs'
import { supplierReplyPasteRequestSchema } from '../../shared/supplier-reply-contract.mjs'

// Supplier replies without pasting (docs/supplier-reply-ingest-api.md): a
// workspace integration token, stored as a hash, lets a forwarder post a
// reply; it then takes the paste path as the token's owner. Checked here with
// an in-memory store, a stand-in paste path and stated actors; the paste path
// itself is covered by tests/postgres/supplier-replies.test.mjs.
const read = (file) => readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8')
const TENANT = 'tenant-ingest'
const SECRET = 'A'.repeat(39) + 'wxyz'
const ID = '0b6f5c1e-8d1a-4c51-9a3e-2f7d1c0e9b42'

function store({ tenants = {}, users = [], orders = [], replies = [], publicData = [] } = {}) {
  const records = []
  const audit = []
  const key = (where) => where.tenantId_namespace_recordKey
  const found = (where) => records.find((row) => row.tenantId === key(where).tenantId && row.namespace === key(where).namespace && row.recordKey === key(where).recordKey) || null
  for (const tenantId of publicData) records.push({ id: `note-${tenantId}`, tenantId, namespace: 'workspace.public-data', recordKey: 'note', payload: { dataset: 'uci', sourceWindow: { first: '2010-12-01', last: '2011-12-09' }, window: { first: '2025-12-01', last: '2026-11-20' }, shiftDays: 5470 }, createdAt: new Date() })
  const prisma = {
    records, audit,
    tenant: { findUnique: async ({ where }) => (tenants[where.id] ? { id: where.id, operationalSettings: tenants[where.id] } : null) },
    user: {
      findFirst: async ({ where }) => users.find((user) => user.id === where.id && user.tenantId === where.tenantId) || null,
      findMany: async ({ where }) => users.filter((user) => user.tenantId === where.tenantId && where.id.in.includes(user.id)),
    },
    purchaseOrder: { findMany: async ({ where }) => orders.filter((order) => order.tenantId === where.tenantId && where.number.in.includes(order.number)) },
    supplierReply: { findFirst: async ({ where }) => replies.find((reply) => reply.tenantId === where.tenantId && reply.messageId === where.messageId) || null },
    runtimeRecord: {
      findUnique: async ({ where }) => found(where),
      findMany: async ({ where }) => records.filter((row) => row.tenantId === where.tenantId && row.namespace === where.namespace),
      create: async ({ data }) => { records.push({ ...data, createdAt: new Date() }); return data },
      update: async ({ where, data }) => Object.assign(found(where), data),
      upsert: async ({ where, create, update }) => {
        const row = found(where)
        if (row) return Object.assign(row, update)
        records.push({ ...create, createdAt: new Date() })
        return create
      },
    },
    auditLog: { create: async ({ data }) => { audit.push(data); return data } },
    $transaction: async (work) => work(prisma),
  }
  return prisma
}

const REVISE = 'procurement.purchase_order.revise'
const MANAGE = 'settings.workspace.manage'
const actors = {
  admin: { id: 'admin', permissions: [MANAGE, REVISE] },
  buyer: { id: 'buyer', permissions: [REVISE] },
  viewer: { id: 'viewer', permissions: ['procurement.purchase_order.read'] },
}
const resolveActor = async (_prisma, identity) => {
  const known = actors[identity.userId]
  return { complete: true, authenticated: true, tenantId: identity.tenantId, user: { id: identity.userId }, roleIds: [], permissionCodes: new Set(known?.permissions || []) }
}
const session = (userId) => ({ authenticated: true, tenantId: TENANT, userId, role: 'manager' })
const users = [
  { id: 'admin', tenantId: TENANT, name: 'Ada Admin', role: 'admin', status: 'active' },
  { id: 'buyer', tenantId: TENANT, name: 'Bo Buyer', role: 'buyer', status: 'active' },
  { id: 'viewer', tenantId: TENANT, name: 'Vi Viewer', role: 'viewer', status: 'active' },
  { id: 'gone', tenantId: TENANT, name: 'Gone', role: 'buyer', status: 'disabled' },
]
const orders = [
  { id: 'po-12', tenantId: TENANT, number: 'PO-202611-0012', status: 'issued' },
  { id: 'po-13', tenantId: TENANT, number: 'PO-202611-0013', status: 'partially_received' },
  { id: 'po-09', tenantId: TENANT, number: 'PO-202610-0009', status: 'closed' },
]

function pasteRecorder() {
  const calls = []
  return {
    calls,
    pasteReply: async (orderId, body, context, options) => {
      calls.push({ orderId, body, context, options })
      return { reply: { id: `reply-${calls.length}`, state: 'proposed', readingStatus: 'read', text: body.text, supplierName: 'Acme' } }
    },
  }
}

function setup({ env = {}, tenantSettings = {}, publicData = [], replies = [], limit, nowMs } = {}) {
  const prisma = store({ tenants: { [TENANT]: tenantSettings }, users, orders, replies, publicData })
  const paste = pasteRecorder()
  let clock = nowMs ?? Date.parse('2026-11-21T12:00:00Z')
  const now = () => new Date(clock)
  const service = createSupplierReplyIngestService({
    prisma, replies: paste, env, now, resolveActor,
    limiter: createIngestRateLimiter({ limit: limit ?? 60, now: () => clock }),
  })
  return { prisma, paste, service, advance: (ms) => { clock += ms } }
}

test('a token reads fcsr.<workspace>.<id>.<secret>; only the hash and a four-character hint are stored', () => {
  const made = newIntegrationToken({ tenantId: TENANT, name: 'Mail rule', ownerUserId: 'buyer', createdById: 'admin', idFactory: () => ID, secretFactory: () => SECRET })
  assert.equal(made.token, formatIntegrationToken({ tenantId: TENANT, tokenId: ID, secret: SECRET }))
  assert.match(made.token, /^fcsr\.[A-Za-z0-9_-]+\.[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/)
  assert.deepEqual(parseIntegrationToken(`Bearer ${made.token}`), { tenantId: TENANT, tokenId: ID, secret: SECRET })
  assert.equal(made.payload.hash, hashIntegrationSecret(SECRET))
  assert.equal(made.payload.hint, 'wxyz')
  assert.ok(!JSON.stringify(made.payload).includes(SECRET), 'the secret is never stored')
  assert.equal(made.payload.scope, 'supplier_replies.ingest')
  assert.ok(integrationSecretMatches(made.payload, SECRET))
  assert.ok(!integrationSecretMatches(made.payload, 'B'.repeat(43)))
  for (const bad of ['', 'Bearer', made.token.replace('fcsr.', 'fcxx.'), made.token.slice(0, -1), `${made.token}.extra`, made.token.replace(ID, 'not-an-id'), `fcsr.${Buffer.from(TENANT).toString('base64url')}=.${ID}.${SECRET}`]) {
    assert.equal(parseIntegrationToken(bad), null, bad)
  }
})

test('the rate limit counts each workspace on its own and frees up as the window passes', () => {
  let clock = 0
  const limiter = createIngestRateLimiter({ limit: 2, windowMs: 1000, now: () => clock })
  assert.ok(limiter.take('a').ok)
  assert.ok(limiter.take('a').ok)
  const refused = limiter.take('a')
  assert.deepEqual([refused.ok, refused.retryAfterSeconds], [false, 1])
  assert.ok(limiter.take('b').ok)
  clock = 1000
  assert.ok(limiter.take('a').ok)
  assert.equal(supplierReplyIngestPerDay({}), 50)
  assert.equal(supplierReplyIngestPerDay({ FLOWCHAIN_SUPPLIER_REPLY_INGEST_PER_DAY: '12' }), 12)
  assert.equal(supplierReplyIngestPerDay({ FLOWCHAIN_SUPPLIER_REPLY_INGEST_PER_DAY: '0' }), 50)
})

test('order numbers are found in the subject and text, first mention first, once each', () => {
  assert.deepEqual(orderNumbersIn('Re: po-202611-0012 delivery', 'About PO-202611-0012 and PO-202611-0013.'), ['PO-202611-0012', 'PO-202611-0013'])
  assert.deepEqual(orderNumbersIn('Your order of 12 Nov', 'Ref 2026-11-12'), [])
  assert.equal(orderNumbersIn(Array.from({ length: 30 }, (_, at) => `PO-202611-${String(at).padStart(4, '0')}`).join(' ')).length, 20)
})

async function tokenFor(service, owner = 'buyer') {
  return (await service.createToken(session('admin'), { name: 'Outlook rule', ownerUserId: owner })).secret
}

test('admins make, list and revoke tokens; the token is shown once and never its hash', async () => {
  const { prisma, service } = setup()
  const made = await service.createToken(session('admin'), { name: 'Outlook rule', ownerUserId: 'buyer' })
  assert.match(made.secret, /^fcsr\./)
  assert.deepEqual([made.token.name, made.token.owner, made.token.active, made.token.hint], ['Outlook rule', { id: 'buyer', name: 'Bo Buyer' }, true, made.secret.slice(-4)])
  const stored = prisma.records.find((row) => row.namespace === INTEGRATION_TOKEN_NAMESPACE)
  assert.ok(!JSON.stringify(stored).includes(made.secret.split('.')[3]), 'only the hash is stored')
  assert.equal(prisma.audit.at(-1).action, 'integration_token_created')
  assert.ok(!JSON.stringify(prisma.audit).includes(made.secret.split('.')[3]))

  const listed = await service.listTokens(session('admin'))
  assert.deepEqual([listed.enabled, listed.limit, listed.tokens.length], [true, INTEGRATION_TOKEN_LIMIT, 1])
  assert.ok(!('hash' in listed.tokens[0]) && !JSON.stringify(listed).includes(stored.payload.hash))

  // Only admins; the owner must be active and allowed to revise orders.
  await assert.rejects(() => service.createToken(session('buyer'), { name: 'Mine' }), { status: 403 })
  await assert.rejects(() => service.listTokens(session('viewer')), { status: 403 })
  await assert.rejects(() => service.createToken(session('admin'), { name: 'Viewer', ownerUserId: 'viewer' }), { code: 'INTEGRATION_TOKEN_OWNER_CANNOT_REVISE' })
  await assert.rejects(() => service.createToken(session('admin'), { name: 'Gone', ownerUserId: 'gone' }), { code: 'INTEGRATION_TOKEN_OWNER_INACTIVE' })
  await assert.rejects(() => service.createToken(session('admin'), { name: '' }), { code: 'SUPPLIER_REPLY_INGEST_INVALID' })

  // At most five active tokens.
  for (let at = 1; at < INTEGRATION_TOKEN_LIMIT; at += 1) await service.createToken(session('admin'), { name: `Rule ${at}` })
  await assert.rejects(() => service.createToken(session('admin'), { name: 'One too many' }), { code: 'INTEGRATION_TOKEN_LIMIT', status: 409 })

  const revoked = await service.revokeToken(session('admin'), made.token.id)
  assert.equal(revoked.token.active, false)
  assert.equal(prisma.audit.at(-1).action, 'integration_token_revoked')
  // Revoking again changes nothing; a revoked token frees its place.
  const auditRows = prisma.audit.length
  await service.revokeToken(session('admin'), made.token.id)
  assert.equal(prisma.audit.length, auditRows)
  await service.createToken(session('admin'), { name: 'Replacement' })
  await assert.rejects(() => service.revokeToken(session('admin'), 'no-such-token'), { code: 'INTEGRATION_TOKEN_NOT_FOUND', status: 404 })
})

test('a reply sent with a token takes the paste path as the token\'s owner, and only ids come back', async () => {
  const { prisma, paste, service } = setup()
  const token = await tokenFor(service)
  const result = await service.ingest({
    authorization: `Bearer ${token}`,
    body: { subject: 'RE: PO-202611-0012 delivery date', text: 'We will ship the brackets on 28 November.', from: 'orders@acme.example', messageId: '<m1@acme.example>', receivedOn: '2026-11-20', extra: 'dropped' },
  })
  assert.equal(result.status, 201)
  assert.deepEqual(result.body, { duplicate: false, replyId: 'reply-1', purchaseOrderId: 'po-12', purchaseOrderNumber: 'PO-202611-0012', state: 'proposed', readingStatus: 'read' })
  const [call] = paste.calls
  assert.equal(call.orderId, 'po-12')
  assert.deepEqual(call.body, { text: 'We will ship the brackets on 28 November.', receivedOn: '2026-11-20' })
  assert.deepEqual(call.context.identity, { authenticated: true, source: 'integration_token', tenantId: TENANT, userId: 'buyer', role: 'buyer' })
  assert.deepEqual(call.options.origin, { source: 'email', sender: 'orders@acme.example', messageId: '<m1@acme.example>', tokenId: token.split('.')[2] })
  // When it was last used, in its own record; the token record is untouched.
  const use = prisma.records.find((row) => row.namespace === INTEGRATION_TOKEN_USE_NAMESPACE)
  assert.equal(use.payload.lastUsedAt, '2026-11-21T12:00:00.000Z')
  assert.equal((await service.listTokens(session('admin'))).tokens[0].lastUsedAt, '2026-11-21T12:00:00.000Z')

  // The order named in the body wins; an open order beats a closed one.
  await service.ingest({ authorization: token, body: { text: 'Shipping Monday.', purchaseOrder: 'po-202611-0013' } })
  assert.equal(paste.calls.at(-1).orderId, 'po-13')
  await service.ingest({ authorization: token, body: { text: 'PO-202610-0009 is closed; PO-202611-0012 ships Friday.' } })
  assert.equal(paste.calls.at(-1).orderId, 'po-12')
})

test('a reply is refused when it names no order, an unknown one, or two open ones', async () => {
  const { paste, service } = setup()
  const token = await tokenFor(service)
  await assert.rejects(() => service.ingest({ authorization: token, body: { text: 'Shipping Friday.' } }), { code: 'SUPPLIER_REPLY_INGEST_NO_ORDER', status: 422 })
  await assert.rejects(() => service.ingest({ authorization: token, body: { text: 'PO-202611-9999 ships Friday.' } }), { code: 'SUPPLIER_REPLY_INGEST_ORDER_NOT_FOUND', status: 422 })
  await assert.rejects(() => service.ingest({ authorization: token, body: { text: 'PO-202611-0012 and PO-202611-0013 ship Friday.' } }), (error) => error.code === 'SUPPLIER_REPLY_INGEST_SEVERAL_ORDERS' && error.details.length === 2)
  await assert.rejects(() => service.ingest({ authorization: token, body: { subject: 'PO-202611-0012' } }), { code: 'SUPPLIER_REPLY_INGEST_INVALID' })
  assert.equal(paste.calls.length, 0)
})

test('the same message twice is kept once', async () => {
  const replies = [{ id: 'reply-earlier', tenantId: TENANT, messageId: '<same@acme.example>', purchaseOrderId: 'po-12', state: 'proposed', readingStatus: 'read' }]
  const { paste, service } = setup({ replies })
  const token = await tokenFor(service)
  const again = await service.ingest({ authorization: token, body: { text: 'PO-202611-0012 ships Friday.', messageId: '<same@acme.example>' } })
  assert.deepEqual([again.status, again.body.duplicate, again.body.replyId], [200, true, 'reply-earlier'])
  assert.equal(paste.calls.length, 0)
})

test('every unaccepted token gets the same 401: missing, malformed, unknown, wrong secret, revoked', async () => {
  const { service } = setup()
  const token = await tokenFor(service)
  const [prefix, workspace, tokenId] = token.split('.')
  const body = { text: 'PO-202611-0012 ships Friday.' }
  for (const authorization of [undefined, '', 'Bearer nope', `${prefix}.${workspace}.${tokenId}.${'B'.repeat(43)}`, `${prefix}.${workspace}.${ID}.${SECRET}`, `${prefix}.${Buffer.from('other-tenant').toString('base64url')}.${tokenId}.${token.split('.')[3]}`]) {
    await assert.rejects(() => service.ingest({ authorization, body }), { code: 'INTEGRATION_TOKEN_INVALID', status: 401 }, String(authorization))
  }
  await service.revokeToken(session('admin'), tokenId)
  await assert.rejects(() => service.ingest({ authorization: token, body }), { code: 'INTEGRATION_TOKEN_INVALID', status: 401 })
})

test('the owner must still be active, and the paste path still checks their permission', async () => {
  const { prisma, service } = setup()
  const token = await tokenFor(service)
  const record = prisma.records.find((row) => row.namespace === INTEGRATION_TOKEN_NAMESPACE)
  record.payload = { ...record.payload, ownerUserId: 'gone' }
  await assert.rejects(() => service.ingest({ authorization: token, body: { text: 'PO-202611-0012 ships Friday.' } }), { code: 'INTEGRATION_TOKEN_OWNER_INACTIVE', status: 403 })
  // The paste path refuses an owner who may no longer revise orders, as it refuses a person.
  assert.match(read('server/services/supplier-reply-service.mjs'), /const actor = await actorOf\(client, context\)\n    assertAuthorized\(\{ actor, permission: REVISE, tenantId: actor\.tenantId \}\)/)
})

test('public-data workspaces and workspaces without AI reading switched on are refused', async () => {
  const blocked = setup({ publicData: [TENANT] })
  const token = await tokenFor(setup().service)
  // A token for this workspace from another store reads as unknown here.
  await assert.rejects(() => blocked.service.ingest({ authorization: token, body: { text: 'x' } }), { code: 'INTEGRATION_TOKEN_INVALID' })
  await assert.rejects(() => blocked.service.createToken(session('admin'), { name: 'Rule' }), { code: 'SUPPLIER_REPLY_INGEST_PUBLIC_DATA', status: 403 })
  const listed = await blocked.service.listTokens(session('admin'))
  assert.deepEqual([listed.enabled, listed.refusal], [false, 'SUPPLIER_REPLY_INGEST_PUBLIC_DATA'])
  const allowed = setup({ publicData: [TENANT], env: { FLOWCHAIN_SUPPLIER_REPLY_INGEST_PUBLIC_DATA: 'on' } })
  assert.ok((await allowed.service.createToken(session('admin'), { name: 'Rule' })).secret)

  // Where the deployment requires the AI opt-in, the workspace's switch decides, as for pasting.
  const optIn = { FLOWCHAIN_AI_WORKSPACE_OPT_IN: 'required' }
  const off = setup({ env: optIn, tenantSettings: { ai: { modelAssistEnabled: false } } })
  await assert.rejects(() => off.service.createToken(session('admin'), { name: 'Rule' }), { code: 'SUPPLIER_REPLY_INGEST_AI_OFF', status: 403 })
  const on = setup({ env: optIn, tenantSettings: { ai: { modelAssistEnabled: true } } })
  const onToken = await tokenFor(on.service)
  assert.equal((await on.service.ingest({ authorization: onToken, body: { text: 'PO-202611-0012 ships Friday.' } })).status, 201)
  // Switched off after the token was made: replies are refused until it is on again.
  on.prisma.tenant.findUnique = async () => ({ id: TENANT, operationalSettings: { ai: { modelAssistEnabled: false } } })
  await assert.rejects(() => on.service.ingest({ authorization: onToken, body: { text: 'PO-202611-0012 ships Friday.' } }), { code: 'SUPPLIER_REPLY_INGEST_AI_OFF' })
})

test('each workspace may send so many replies a day', async () => {
  const { paste, service, advance } = setup({ limit: 2 })
  const token = await tokenFor(service)
  const body = { text: 'PO-202611-0012 ships Friday.' }
  await service.ingest({ authorization: token, body })
  await service.ingest({ authorization: token, body })
  await assert.rejects(() => service.ingest({ authorization: token, body }), (error) => error.code === 'SUPPLIER_REPLY_INGEST_RATE_LIMITED' && error.status === 429 && Number(error.details[0].code) > 0)
  assert.equal(paste.calls.length, 2)
  advance(24 * 60 * 60 * 1000)
  assert.equal((await service.ingest({ authorization: token, body })).status, 201)
})

function routeContext({ method, pathname, env, identity = null, headers = {}, body = {}, service }) {
  const sent = []
  const res = { headers: {}, setHeader(name, value) { this.headers[name] = value } }
  return {
    sent, res,
    ctx: {
      req: { method, headers }, res, url: new URL(`http://localhost${pathname}`), env, identity,
      readBody: async () => body,
      send: (_res, status, payload) => sent.push({ status, payload }),
      repositories: { supplierReplyIngest: service },
    },
  }
}

test('the routes answer 404 unless the server switches them on; the ingest route takes only its token', async () => {
  assert.equal(supplierReplyIngestEnabled({}), false)
  assert.equal(supplierReplyIngestEnabled({ FLOWCHAIN_SUPPLIER_REPLY_INGEST: 'on' }), true)
  const calls = []
  const service = {
    ingest: async (input) => { calls.push(input); return { status: 201, body: { replyId: 'r1' } } },
    listTokens: async (identity) => { calls.push(identity); return { tokens: [] } },
  }
  for (const [method, pathname] of [['POST', '/api/integrations/supplier-replies'], ['GET', '/api/settings/integrations/supplier-reply-tokens'], ['POST', '/api/settings/integrations/supplier-reply-tokens/abc/revoke']]) {
    const { ctx } = routeContext({ method, pathname, env: {}, service })
    assert.equal(await handleSupplierReplyIngestRoute(ctx), false, pathname)
  }
  const env = { FLOWCHAIN_SUPPLIER_REPLY_INGEST: 'on' }
  const posted = routeContext({ method: 'POST', pathname: '/api/integrations/supplier-replies', env, identity: session('admin'), headers: { authorization: 'Bearer fcsr.x' }, body: { text: 'hi' }, service })
  assert.equal(await handleSupplierReplyIngestRoute(posted.ctx), true)
  // The session is not passed on: only the Authorization header and the body.
  assert.deepEqual(calls[0], { authorization: 'Bearer fcsr.x', body: { text: 'hi' } })
  assert.deepEqual(posted.sent, [{ status: 201, payload: { replyId: 'r1' } }])
  assert.equal(await handleSupplierReplyIngestRoute(routeContext({ method: 'GET', pathname: '/api/other', env, service }).ctx), false)

  // A 429 says when to try again.
  const limited = routeContext({ method: 'POST', pathname: '/api/integrations/supplier-replies', env, service: { ingest: async () => { throw Object.assign(new Error('Too many'), { status: 429, code: 'SUPPLIER_REPLY_INGEST_RATE_LIMITED', details: [{ field: 'retryAfterSeconds', code: '120' }] }) } } })
  await handleSupplierReplyIngestRoute(limited.ctx)
  assert.equal(limited.res.headers['Retry-After'], '120')
  assert.equal(limited.sent[0].status, 429)

  // Past the session gate for this one route only; the admin routes keep it.
  assert.equal(apiAccessDenial({ method: 'POST', pathname: '/api/integrations/supplier-replies', identity: { authenticated: false } }), null)
  assert.equal(apiAccessDenial({ method: 'GET', pathname: '/api/integrations/supplier-replies', identity: { authenticated: false } }).status, 401)
  assert.equal(apiAccessDenial({ method: 'POST', pathname: '/api/settings/integrations/supplier-reply-tokens', identity: { authenticated: false } }).status, 401)
})

test('only the ingestion path marks a reply as emailed; a paste request cannot', () => {
  const service = read('server/services/supplier-reply-service.mjs')
  assert.match(service, /source: origin\?\.source === 'email' \? 'email' : 'paste'/)
  // The paste route passes no origin, and the paste body allows text and receivedOn only.
  assert.doesNotMatch(read('server/routes/supplier-replies.routes.mjs'), /origin/)
  assert.deepEqual(Object.keys(supplierReplyPasteRequestSchema.shape), ['text', 'receivedOn'])
  assert.equal(supplierReplyPasteRequestSchema.safeParse({ text: 'Ships Friday.', source: 'email' }).success, false)
})
