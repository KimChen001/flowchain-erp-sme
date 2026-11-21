import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { apiAccessDenial } from '../bootstrap/api-access-gate.mjs'
import {
  INTEGRATION_MESSAGE_NAMESPACE, INTEGRATION_TOKEN_LIMIT, INTEGRATION_TOKEN_NAMESPACE, INTEGRATION_TOKEN_USE_NAMESPACE,
  formatIntegrationToken, hashIntegrationSecret, integrationMessageKey, integrationSecretMatches, newIntegrationToken, parseIntegrationToken, publicMailDomain, senderAddress, senderOnRecord,
} from './integration-tokens.mjs'
import { handleSupplierReplyIngestRoute } from '../routes/supplier-reply-ingest.routes.mjs'
import { INGEST_CLAIM_STALE_MS, INGEST_REFUSAL_COUNT_LIMIT, INGEST_REFUSAL_NAMESPACE, createSupplierReplyIngestService, orderNumbersIn, supplierReplyIngestEnabled, supplierReplyIngestPerDay } from '../services/supplier-reply-ingest.mjs'
import { supplierReplyCardSchema, supplierReplyPasteRequestSchema } from '../../shared/supplier-reply-contract.mjs'

// Supplier replies without pasting (docs/supplier-reply-ingest-api.md): a
// workspace integration token, stored as a hash, lets a forwarder post a
// reply; it then takes the paste path as the admin who made the token.
// Checked here with an in-memory store, a stand-in paste path and stated
// actors; the paste path itself is covered by the Postgres tests
// (tests/postgres/supplier-replies.test.mjs, supplier-reply-ingest.test.mjs).
const read = (file) => readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8')
const TENANT = 'tenant-ingest'
const SECRET = 'A'.repeat(39) + 'wxyz'
const ID = '0b6f5c1e-8d1a-4c51-9a3e-2f7d1c0e9b42'
const NOW = Date.parse('2026-11-21T12:00:00Z')
const DAY = 24 * 60 * 60 * 1000

function store({ tenants = {}, users = [], orders = [], replies = [], publicData = [] } = {}) {
  const records = []
  const audit = []
  const key = (where) => where.tenantId_namespace_recordKey
  const found = (where) => records.find((row) => row.tenantId === key(where).tenantId && row.namespace === key(where).namespace && row.recordKey === key(where).recordKey) || null
  const replyMatches = (reply, where) => reply.tenantId === where.tenantId
    && (where.id === undefined || reply.id === where.id)
    && (where.messageId === undefined || reply.messageId === where.messageId)
    && (where.source === undefined || reply.source === where.source)
    && (!where.createdAt?.gt || new Date(reply.createdAt) > where.createdAt.gt)
  for (const tenantId of publicData) records.push({ id: `note-${tenantId}`, tenantId, namespace: 'workspace.public-data', recordKey: 'note', payload: { dataset: 'uci', sourceWindow: { first: '2010-12-01', last: '2011-12-09' }, window: { first: '2025-12-01', last: '2026-11-20' }, shiftDays: 5470 }, createdAt: new Date() })
  const prisma = {
    records, audit, replies, users,
    tenant: { findUnique: async ({ where }) => (tenants[where.id] ? { id: where.id, operationalSettings: tenants[where.id] } : null) },
    user: {
      findFirst: async ({ where }) => users.find((user) => user.id === where.id && user.tenantId === where.tenantId) || null,
      findMany: async ({ where }) => users.filter((user) => user.tenantId === where.tenantId && where.id.in.includes(user.id)),
    },
    purchaseOrder: { findMany: async ({ where }) => orders.filter((order) => order.tenantId === where.tenantId && where.number.in.includes(order.number)) },
    supplierReply: {
      findFirst: async ({ where, orderBy }) => {
        const rows = replies.filter((reply) => replyMatches(reply, where))
        if (orderBy?.createdAt === 'asc') rows.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))
        return rows[0] || null
      },
      count: async ({ where }) => replies.filter((reply) => replyMatches(reply, where)).length,
    },
    runtimeRecord: {
      // Copies, as Prisma returns them.
      findUnique: async ({ where }) => { const row = found(where); return row ? structuredClone(row) : null },
      findMany: async ({ where }) => records.filter((row) => row.tenantId === where.tenantId && row.namespace === where.namespace).map((row) => structuredClone(row)),
      create: async ({ data }) => {
        if (records.some((row) => row.tenantId === data.tenantId && row.namespace === data.namespace && row.recordKey === data.recordKey)) throw Object.assign(new Error('Unique constraint failed'), { code: 'P2002' })
        const row = { ...data, createdAt: new Date(), updatedAt: new Date(Date.now() + records.length) }
        records.push(row)
        return structuredClone(row)
      },
      update: async ({ where, data }) => Object.assign(found(where), data, { updatedAt: new Date(Date.now() + records.length + 1) }),
      updateMany: async ({ where, data }) => {
        const row = records.find((entry) => entry.tenantId === where.tenantId && entry.namespace === where.namespace && entry.recordKey === where.recordKey && entry.updatedAt.getTime() === new Date(where.updatedAt).getTime())
        if (!row) return { count: 0 }
        Object.assign(row, data, { updatedAt: new Date(row.updatedAt.getTime() + 1) })
        return { count: 1 }
      },
      upsert: async ({ where, create, update }) => {
        const row = found(where)
        if (row) return Object.assign(row, update)
        records.push({ ...create, createdAt: new Date() })
        return create
      },
      delete: async ({ where }) => { const row = found(where); records.splice(records.indexOf(row), 1); return row },
      deleteMany: async ({ where }) => {
        const at = records.findIndex((entry) => entry.tenantId === where.tenantId && entry.namespace === where.namespace && entry.recordKey === where.recordKey && entry.updatedAt.getTime() === new Date(where.updatedAt).getTime())
        if (at < 0) return { count: 0 }
        records.splice(at, 1)
        return { count: 1 }
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
  admin: [MANAGE, REVISE],
  'admin-no-revise': [MANAGE],
  buyer: [REVISE],
}
const resolveActor = async (_prisma, identity) => ({ complete: true, authenticated: true, tenantId: identity.tenantId, user: { id: identity.userId }, roleIds: [], permissionCodes: new Set(actors[identity.userId] || []) })
const session = (userId) => ({ authenticated: true, tenantId: TENANT, userId, role: 'admin' })
const people = () => [
  { id: 'admin', tenantId: TENANT, name: 'Ada Admin', role: 'admin', status: 'active' },
  { id: 'admin-no-revise', tenantId: TENANT, name: 'Ari Admin', role: 'admin', status: 'active' },
  { id: 'buyer', tenantId: TENANT, name: 'Bo Buyer', role: 'buyer', status: 'active' },
]
const orders = [
  { id: 'po-12', tenantId: TENANT, number: 'PO-202611-0012', status: 'issued' },
  { id: 'po-13', tenantId: TENANT, number: 'PO-202611-0013', status: 'partially_received' },
  { id: 'po-09', tenantId: TENANT, number: 'PO-202610-0009', status: 'closed' },
]

// A stand-in paste path: records each call and keeps an emailed reply, as the
// real one does (source, message id, created now).
function pasteRecorder(prisma, clock) {
  const calls = []
  return {
    calls,
    pasteReply: async (orderId, body, context, options) => {
      calls.push({ orderId, body, context, options })
      const reply = { id: `reply-${calls.length}`, tenantId: context.identity.tenantId, purchaseOrderId: orderId, source: 'email', messageId: options.origin.messageId || null, state: 'proposed', readingStatus: 'read', createdAt: new Date(clock()) }
      prisma.replies.push(reply)
      return { reply: { ...reply, text: body.text } }
    },
  }
}

function setup({ env = {}, tenantSettings = {}, publicData = [], replies = [] } = {}) {
  const prisma = store({ tenants: { [TENANT]: tenantSettings }, users: people(), orders, replies, publicData })
  let clock = NOW
  const paste = pasteRecorder(prisma, () => clock)
  const service = createSupplierReplyIngestService({ prisma, replies: paste, env, now: () => new Date(clock), resolveActor })
  return { prisma, paste, service, advance: (ms) => { clock += ms } }
}
const send = (service, authorization, body) => service.ingest({ authorization, readBody: async () => body })

test('a token reads fcsr.<workspace>.<id>.<secret>; only the hash, a hint and its expiry are stored', () => {
  const made = newIntegrationToken({ tenantId: TENANT, name: 'Mail rule', owner: { id: 'admin', role: 'Admin' }, createdById: 'admin', now: new Date(NOW), idFactory: () => ID, secretFactory: () => SECRET })
  assert.equal(made.token, formatIntegrationToken({ tenantId: TENANT, tokenId: ID, secret: SECRET }))
  assert.match(made.token, /^fcsr\.[A-Za-z0-9_-]+\.[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/)
  assert.deepEqual(parseIntegrationToken(`Bearer ${made.token}`), { tenantId: TENANT, tokenId: ID, secret: SECRET })
  assert.deepEqual([made.payload.hash, made.payload.hint, made.payload.ownerRole, made.payload.expiresAt], [hashIntegrationSecret(SECRET), 'wxyz', 'admin', '2027-02-19T12:00:00.000Z'])
  assert.ok(!JSON.stringify(made.payload).includes(SECRET), 'the secret is never stored')
  assert.ok(integrationSecretMatches(made.payload, SECRET))
  assert.ok(!integrationSecretMatches(made.payload, 'B'.repeat(43)))
  for (const bad of ['', 'Bearer', made.token.replace('fcsr.', 'fcxx.'), made.token.slice(0, -1), `${made.token}.extra`, made.token.replace(ID, 'not-an-id'), `fcsr.${Buffer.from(TENANT).toString('base64url')}=.${ID}.${SECRET}`]) {
    assert.equal(parseIntegrationToken(bad), null, bad)
  }
})

test('a sender is on record by the same address, or the same company domain but never a public mailbox domain', () => {
  assert.equal(senderAddress('Pat Lee <Pat@Acme.example>'), 'pat@acme.example')
  assert.equal(senderAddress('not an address'), null)
  // The address is the one angle address outside quoted display names and comments.
  for (const [from, address] of [
    ['"<orders@acme.example>" <x@evil.example>', 'x@evil.example'],
    ['x@evil.example (<orders@acme.example>)', 'x@evil.example'],
    ['"Acme, Sales" <sales@acme.example>', 'sales@acme.example'],
    ['Acme (Sales) <sales@acme.example>', 'sales@acme.example'],
    ['<orders@acme.example> <x@evil.example>', null],
    ['<x@evil.example> orders@acme.example', null],
    ['orders@acme.example, x@evil.example', null],
    ['Group: orders@acme.example;', null],
    ['"unbalanced <orders@acme.example>', null],
    ['"quoted local"@acme.example', null],
  ]) assert.equal(senderAddress(from), address, from)
  assert.equal(senderOnRecord('"<orders@acme.example>" <x@evil.example>', 'orders@acme.example'), false)
  assert.equal(senderOnRecord('x@evil.example (<orders@acme.example>)', 'orders@acme.example'), false)
  for (const domain of ['gmail.com', 'yahoo.co.uk', 'hotmail.co.uk', 'live.co.uk', 'yandex.ru', 'zoho.com', 'mail.ru', 'gmx.de', 'web.de', '139.com', 'qq.com', 'wp.pl', 'seznam.cz', 'virginmedia.com', 'uol.com.br']) assert.equal(publicMailDomain(domain), true, domain)
  for (const domain of ['acme.example', 'mail.acme.example', 'acme.co.uk']) assert.equal(publicMailDomain(domain), false, domain)
  assert.equal(senderOnRecord('someone@yahoo.co.uk', 'acme@yahoo.co.uk'), false)
  assert.equal(senderOnRecord('Pat <pat@acme.example>', 'orders@acme.example'), true)
  assert.equal(senderOnRecord('orders@acme.example', 'Orders@ACME.example'), true)
  assert.equal(senderOnRecord('mallory@evil.example', 'orders@acme.example'), false)
  assert.equal(senderOnRecord('someone@gmail.com', 'acme.orders@gmail.com'), false)
  assert.equal(senderOnRecord('acme.orders@gmail.com', 'acme.orders@gmail.com'), true)
  assert.equal(senderOnRecord('pat@acme.example', null), false)
  assert.equal(senderOnRecord(null, 'orders@acme.example'), false)
})

test('order numbers are found in the subject and text, first mention first, once each', () => {
  assert.deepEqual(orderNumbersIn('Re: po-202611-0012 delivery', 'About PO-202611-0012 and PO-202611-0013.'), ['PO-202611-0012', 'PO-202611-0013'])
  assert.deepEqual(orderNumbersIn('Your order of 12 Nov', 'Ref 2026-11-12'), [])
  assert.equal(orderNumbersIn(Array.from({ length: 30 }, (_, at) => `PO-202611-${String(at).padStart(4, '0')}`).join(' ')).length, 20)
})

const tokenFor = async (service, body = { name: 'Outlook rule' }) => (await service.createToken(session('admin'), body)).secret

test('an admin makes, lists and revokes tokens that act for that admin; the token is shown once and never its hash', async () => {
  const { prisma, service } = setup()
  const made = await service.createToken(session('admin'), { name: 'Outlook rule' })
  assert.match(made.secret, /^fcsr\./)
  assert.deepEqual([made.token.name, made.token.owner, made.token.active, made.token.hint, made.token.expiresAt], ['Outlook rule', { id: 'admin', name: 'Ada Admin' }, true, made.secret.slice(-4), '2027-02-19T12:00:00.000Z'])
  const stored = prisma.records.find((row) => row.namespace === INTEGRATION_TOKEN_NAMESPACE)
  assert.ok(!JSON.stringify(stored).includes(made.secret.split('.')[3]), 'only the hash is stored')
  assert.equal(prisma.audit.at(-1).action, 'integration_token_created')
  assert.ok(!JSON.stringify(prisma.audit).includes(made.secret.split('.')[3]))
  const listed = await service.listTokens(session('admin'))
  assert.deepEqual([listed.enabled, listed.limit, listed.tokens.length], [true, INTEGRATION_TOKEN_LIMIT, 1])
  assert.ok(!JSON.stringify(listed).includes(stored.payload.hash))

  // Only admins; never on someone else's behalf; the admin must be able to revise orders.
  await assert.rejects(() => service.createToken(session('buyer'), { name: 'Mine' }), { status: 403 })
  await assert.rejects(() => service.listTokens(session('buyer')), { status: 403 })
  await assert.rejects(() => service.createToken(session('admin'), { name: 'For Bo', ownerUserId: 'buyer' }), { code: 'SUPPLIER_REPLY_INGEST_INVALID', status: 422 })
  await assert.rejects(() => service.createToken(session('admin-no-revise'), { name: 'Rule' }), { code: 'INTEGRATION_TOKEN_OWNER_CANNOT_REVISE', status: 403 })
  await assert.rejects(() => service.createToken(session('admin'), { name: '' }), { code: 'SUPPLIER_REPLY_INGEST_INVALID' })
  assert.equal((await service.createToken(session('admin'), { name: 'Short', expiresInDays: 7 })).token.expiresAt, '2026-11-28T12:00:00.000Z')
  await assert.rejects(() => service.createToken(session('admin'), { name: 'Long', expiresInDays: 400 }), { code: 'SUPPLIER_REPLY_INGEST_INVALID' })

  // At most five active tokens.
  for (let at = 2; at < INTEGRATION_TOKEN_LIMIT; at += 1) await service.createToken(session('admin'), { name: `Rule ${at}` })
  await assert.rejects(() => service.createToken(session('admin'), { name: 'One too many' }), { code: 'INTEGRATION_TOKEN_LIMIT', status: 409 })
  assert.match(read('server/services/supplier-reply-ingest.mjs'), /\}, \{ isolationLevel: 'Serializable' \}\)/)

  const revoked = await service.revokeToken(session('admin'), made.token.id)
  assert.equal(revoked.token.active, false)
  assert.equal(prisma.audit.at(-1).action, 'integration_token_revoked')
  const auditRows = prisma.audit.length
  await service.revokeToken(session('admin'), made.token.id)
  assert.equal(prisma.audit.length, auditRows)
  await service.createToken(session('admin'), { name: 'Replacement' })
  await assert.rejects(() => service.revokeToken(session('admin'), 'no-such-token'), { code: 'INTEGRATION_TOKEN_NOT_FOUND', status: 404 })
})

test('a reply sent with a token takes the paste path as the admin, after the token is checked, and only ids come back', async () => {
  const { prisma, paste, service } = setup()
  const token = await tokenFor(service)
  const result = await send(service, `Bearer ${token}`, { subject: 'RE: PO-202611-0012 delivery date', text: 'We will ship the brackets on 28 November.', from: 'orders@acme.example', messageId: '<m1@acme.example>', receivedOn: '2026-11-20', extra: 'dropped' })
  assert.equal(result.status, 201)
  assert.deepEqual(result.body, { duplicate: false, pending: false, replyId: 'reply-1', purchaseOrderId: 'po-12', purchaseOrderNumber: 'PO-202611-0012', state: 'proposed', readingStatus: 'read' })
  const [call] = paste.calls
  assert.equal(call.orderId, 'po-12')
  assert.deepEqual(call.body, { text: 'We will ship the brackets on 28 November.', receivedOn: '2026-11-20' })
  assert.deepEqual(call.context.identity, { authenticated: true, source: 'integration_token', tenantId: TENANT, userId: 'admin', role: 'admin' })
  assert.deepEqual(call.options.origin, { source: 'email', sender: 'orders@acme.example', messageId: '<m1@acme.example>', tokenId: token.split('.')[2] })
  // The message is claimed with the reply it became; last used in its own record.
  assert.equal(prisma.records.find((row) => row.namespace === INTEGRATION_MESSAGE_NAMESPACE).payload.replyId, 'reply-1')
  assert.equal(prisma.records.find((row) => row.namespace === INTEGRATION_TOKEN_USE_NAMESPACE).payload.lastUsedAt, '2026-11-21T12:00:00.000Z')
  assert.equal((await service.listTokens(session('admin'))).tokens[0].lastUsedAt, '2026-11-21T12:00:00.000Z')

  // The order named in the body wins; an open order beats a closed one.
  await send(service, token, { text: 'Shipping Monday.', purchaseOrder: 'po-202611-0013' })
  assert.equal(paste.calls.at(-1).orderId, 'po-13')
  await send(service, token, { text: 'PO-202610-0009 is closed; PO-202611-0012 ships Friday.' })
  assert.equal(paste.calls.at(-1).orderId, 'po-12')

  // The body is not read until the token is accepted.
  let bodyRead = false
  await assert.rejects(() => service.ingest({ authorization: 'Bearer nope', readBody: async () => { bodyRead = true; return {} } }), { status: 401 })
  assert.equal(bodyRead, false)
})

test('a reply is refused when it names no order, an unknown one, or two open ones, and each refusal is audited', async () => {
  const { prisma, paste, service } = setup()
  const token = await tokenFor(service)
  await assert.rejects(() => send(service, token, { text: 'Shipping Friday.' }), { code: 'SUPPLIER_REPLY_INGEST_NO_ORDER', status: 422 })
  await assert.rejects(() => send(service, token, { text: 'PO-202611-9999 ships Friday.' }), { code: 'SUPPLIER_REPLY_INGEST_ORDER_NOT_FOUND', status: 422 })
  await assert.rejects(() => send(service, token, { text: 'PO-202611-0012 and PO-202611-0013 ship Friday.' }), (error) => error.code === 'SUPPLIER_REPLY_INGEST_SEVERAL_ORDERS' && error.details.length === 2)
  await assert.rejects(() => send(service, token, { subject: 'PO-202611-0012' }), { code: 'SUPPLIER_REPLY_INGEST_INVALID' })
  // A Message-ID must be printable ASCII.
  await assert.rejects(() => send(service, token, { text: 'PO-202611-0012 ships Friday.', messageId: '<回复@acme.example>' }), { code: 'SUPPLIER_REPLY_INGEST_INVALID' })
  assert.equal(paste.calls.length, 0)
  // One audit row for the token's first refusal this hour; the hour's record counts the rest.
  const refused = prisma.audit.filter((row) => row.action === 'supplier_reply_ingest_refused')
  assert.deepEqual(refused.map((row) => [row.metadata.code, row.actorId, row.tenantId]), [['SUPPLIER_REPLY_INGEST_NO_ORDER', 'admin', TENANT]])
  const hour = prisma.records.find((row) => row.namespace === INGEST_REFUSAL_NAMESPACE)
  assert.deepEqual(hour.payload.counts, { SUPPLIER_REPLY_INGEST_NO_ORDER: 1, SUPPLIER_REPLY_INGEST_ORDER_NOT_FOUND: 1, SUPPLIER_REPLY_INGEST_SEVERAL_ORDERS: 1, SUPPLIER_REPLY_INGEST_INVALID: 2 })
  assert.ok(!JSON.stringify([refused, hour]).includes('Friday'))
})

test('the same message twice is kept once, also while the first is still being read', async () => {
  const replies = [{ id: 'reply-earlier', tenantId: TENANT, messageId: '<same@acme.example>', purchaseOrderId: 'po-12', source: 'email', state: 'proposed', readingStatus: 'read', createdAt: new Date(NOW - 1000) }]
  const { prisma, paste, service } = setup({ replies })
  const token = await tokenFor(service)
  const again = await send(service, token, { text: 'PO-202611-0012 ships Friday.', messageId: '<same@acme.example>' })
  assert.deepEqual([again.status, again.body.duplicate, again.body.replyId], [200, true, 'reply-earlier'])
  assert.equal(paste.calls.length, 0)

  // A retry while the first copy is read: the claim answers, with no second reading.
  let release
  const slow = { pasteReply: (orderId, body, context, options) => new Promise((resolve) => { release = () => resolve(paste.pasteReply(orderId, body, context, options)) }) }
  const racing = createSupplierReplyIngestService({ prisma, replies: slow, env: {}, now: () => new Date(NOW), resolveActor })
  const first = send(racing, token, { text: 'PO-202611-0012 ships Monday.', messageId: '<retry@acme.example>' })
  await new Promise((resolve) => setImmediate(resolve))
  const retry = await send(racing, token, { text: 'PO-202611-0012 ships Monday.', messageId: '<retry@acme.example>' })
  assert.deepEqual([retry.status, retry.body.duplicate, retry.body.pending], [200, true, true])
  release()
  assert.equal((await first).status, 201)
  assert.equal(paste.calls.length, 1)
  const later = await send(racing, token, { text: 'PO-202611-0012 ships Monday.', messageId: '<retry@acme.example>' })
  assert.deepEqual([later.body.duplicate, later.body.pending, later.body.replyId], [true, false, 'reply-1'])

  // A claim left by a reading that never finished is taken over once it is stale.
  const key = integrationMessageKey('<stuck@acme.example>')
  prisma.records.push({ id: 'stuck', tenantId: TENANT, namespace: INTEGRATION_MESSAGE_NAMESPACE, recordKey: key, payload: { replyId: null, tokenId: 'old', claimedAt: new Date(NOW - 60 * 1000).toISOString() }, createdAt: new Date(NOW), updatedAt: new Date(NOW - 60 * 1000) })
  const young = await send(service, token, { text: 'PO-202611-0012 ships Monday.', messageId: '<stuck@acme.example>' })
  assert.deepEqual([young.body.duplicate, young.body.pending], [true, true])
  prisma.records.find((row) => row.recordKey === key).payload.claimedAt = new Date(NOW - INGEST_CLAIM_STALE_MS - 1000).toISOString()
  const taken = await send(service, token, { text: 'PO-202611-0012 ships Monday.', messageId: '<stuck@acme.example>' })
  assert.deepEqual([taken.status, taken.body.duplicate], [201, false])
  assert.equal(prisma.records.find((row) => row.recordKey === key).payload.replyId, taken.body.replyId)

  // A reading that outlived its claim cannot free or complete the claim of the
  // retry that took it over.
  let fail
  const outlived = createSupplierReplyIngestService({ prisma, replies: { pasteReply: () => new Promise((_resolve, reject) => { fail = () => reject(Object.assign(new Error('late'), { status: 409, code: 'SUPPLIER_REPLY_CONFLICT' })) }) }, env: {}, now: () => new Date(NOW), resolveActor })
  const late = send(outlived, token, { text: 'PO-202611-0012 ships Wednesday.', messageId: '<outlived@acme.example>' })
  await new Promise((resolve) => setImmediate(resolve))
  const outlivedKey = integrationMessageKey('<outlived@acme.example>')
  prisma.records.find((row) => row.recordKey === outlivedKey).payload.claimedAt = new Date(NOW - INGEST_CLAIM_STALE_MS - 1000).toISOString()
  const takeover = await send(service, token, { text: 'PO-202611-0012 ships Wednesday.', messageId: '<outlived@acme.example>' })
  assert.equal(takeover.status, 201)
  fail()
  await assert.rejects(late, { code: 'SUPPLIER_REPLY_CONFLICT' })
  assert.equal(prisma.records.find((row) => row.recordKey === outlivedKey)?.payload.replyId, takeover.body.replyId)

  // A failed reading frees the message for a retry.
  const failing = createSupplierReplyIngestService({ prisma, replies: { pasteReply: async () => { throw Object.assign(new Error('closed'), { status: 409, code: 'SUPPLIER_REPLY_ORDER_NOT_OPEN' }) } }, env: {}, now: () => new Date(NOW), resolveActor })
  await assert.rejects(() => send(failing, token, { text: 'PO-202611-0012 ships Tuesday.', messageId: '<free@acme.example>' }), { code: 'SUPPLIER_REPLY_ORDER_NOT_OPEN' })
  assert.ok(!prisma.records.some((row) => row.namespace === INTEGRATION_MESSAGE_NAMESPACE && row.payload.tokenId && row.payload.replyId === null))
})

test('every unaccepted token gets the same 401: missing, malformed, unknown, wrong, expired, revoked, or its admin disabled or moved', async () => {
  const { prisma, service, advance } = setup()
  const token = await tokenFor(service)
  const [prefix, workspace, tokenId, secret] = token.split('.')
  const body = { text: 'PO-202611-0012 ships Friday.' }
  for (const authorization of [undefined, '', 'Bearer nope', `${prefix}.${workspace}.${tokenId}.${'B'.repeat(43)}`, `${prefix}.${workspace}.${ID}.${SECRET}`, `${prefix}.${Buffer.from('other-tenant').toString('base64url')}.${tokenId}.${secret}`]) {
    await assert.rejects(() => send(service, authorization, body), { code: 'INTEGRATION_TOKEN_INVALID', status: 401 }, String(authorization))
  }
  // A wrong secret for a real token is audited in its workspace once this
  // hour, with no actor: nobody is known before the secret is checked.
  const wrong = prisma.audit.filter((row) => row.action === 'supplier_reply_ingest_refused' && row.metadata.tokenId === tokenId)
  assert.deepEqual(wrong.map((row) => [row.metadata.code, row.actorId]), [['INTEGRATION_TOKEN_INVALID', null]])
  for (let at = 0; at < INGEST_REFUSAL_COUNT_LIMIT + 20; at += 1) await assert.rejects(() => send(service, `${prefix}.${workspace}.${tokenId}.${'C'.repeat(43)}`, body), { status: 401 })
  assert.equal(prisma.audit.filter((row) => row.action === 'supplier_reply_ingest_refused' && row.metadata.tokenId === tokenId).length, 1)
  // The hour's count stops at its limit: past it, nothing more is written.
  const counted = prisma.records.find((row) => row.namespace === INGEST_REFUSAL_NAMESPACE && row.payload.tokenId === tokenId)
  assert.equal(Object.values(counted.payload.counts).reduce((sum, count) => sum + count, 0), INGEST_REFUSAL_COUNT_LIMIT)

  // The admin's permissions now are checked on each use: losing workspace
  // management or order revision through a role assignment ends the token.
  actors.admin = [REVISE]
  await assert.rejects(() => send(service, token, body), { code: 'INTEGRATION_TOKEN_INVALID' })
  actors.admin = [MANAGE]
  await assert.rejects(() => send(service, token, body), { code: 'INTEGRATION_TOKEN_INVALID' })
  actors.admin = [MANAGE, REVISE]

  const admin = prisma.users.find((user) => user.id === 'admin')
  admin.role = 'manager'
  await assert.rejects(() => send(service, token, body), { code: 'INTEGRATION_TOKEN_INVALID' })
  admin.role = 'admin'
  admin.status = 'disabled'
  await assert.rejects(() => send(service, token, body), { code: 'INTEGRATION_TOKEN_INVALID' })
  admin.status = 'active'
  assert.equal((await send(service, token, body)).status, 201)

  advance(91 * DAY)
  await assert.rejects(() => send(service, token, body), { code: 'INTEGRATION_TOKEN_INVALID' })
  const fresh = await tokenFor(service)
  await service.revokeToken(session('admin'), fresh.split('.')[2])
  await assert.rejects(() => send(service, fresh, body), { code: 'INTEGRATION_TOKEN_INVALID' })
})

test('public-data workspaces and workspaces without AI reading switched on are refused', async () => {
  const blocked = setup({ publicData: [TENANT] })
  await assert.rejects(() => blocked.service.createToken(session('admin'), { name: 'Rule' }), { code: 'SUPPLIER_REPLY_INGEST_PUBLIC_DATA', status: 403 })
  const listed = await blocked.service.listTokens(session('admin'))
  assert.deepEqual([listed.enabled, listed.refusal], [false, 'SUPPLIER_REPLY_INGEST_PUBLIC_DATA'])
  const allowed = setup({ publicData: [TENANT], env: { FLOWCHAIN_SUPPLIER_REPLY_INGEST_PUBLIC_DATA: 'on' } })
  assert.ok(await tokenFor(allowed.service))

  // Where the deployment requires the AI opt-in, the workspace's switch decides, as for pasting.
  const optIn = { FLOWCHAIN_AI_WORKSPACE_OPT_IN: 'required' }
  const off = setup({ env: optIn, tenantSettings: { ai: { modelAssistEnabled: false } } })
  await assert.rejects(() => off.service.createToken(session('admin'), { name: 'Rule' }), { code: 'SUPPLIER_REPLY_INGEST_AI_OFF', status: 403 })
  const on = setup({ env: optIn, tenantSettings: { ai: { modelAssistEnabled: true } } })
  const onToken = await tokenFor(on.service)
  assert.equal((await send(on.service, onToken, { text: 'PO-202611-0012 ships Friday.' })).status, 201)
  // Switched off after the token was made: replies are refused until it is on again.
  on.prisma.tenant.findUnique = async () => ({ id: TENANT, operationalSettings: { ai: { modelAssistEnabled: false } } })
  await assert.rejects(() => send(on.service, onToken, { text: 'PO-202611-0012 ships Friday.' }), { code: 'SUPPLIER_REPLY_INGEST_AI_OFF' })
})

test('each workspace keeps at most so many emailed replies in 24 hours, counted from the replies kept', async () => {
  assert.equal(supplierReplyIngestPerDay({}), 50)
  assert.equal(supplierReplyIngestPerDay({ FLOWCHAIN_SUPPLIER_REPLY_INGEST_PER_DAY: '2' }), 2)
  assert.equal(supplierReplyIngestPerDay({ FLOWCHAIN_SUPPLIER_REPLY_INGEST_PER_DAY: '0' }), 50)
  const { paste, service, advance } = setup({ env: { FLOWCHAIN_SUPPLIER_REPLY_INGEST_PER_DAY: '2' } })
  const token = await tokenFor(service)
  const body = { text: 'PO-202611-0012 ships Friday.' }
  // Junk does not use up the limit: refused requests keep nothing.
  for (let at = 0; at < 5; at += 1) await assert.rejects(() => send(service, token, { text: 'no order here' }), { code: 'SUPPLIER_REPLY_INGEST_NO_ORDER' })
  await send(service, token, body)
  advance(60 * 60 * 1000)
  await send(service, token, body)
  await assert.rejects(() => send(service, token, body), (error) => error.code === 'SUPPLIER_REPLY_INGEST_RATE_LIMITED' && error.status === 429 && Number(error.details[0].code) === 23 * 60 * 60)
  assert.equal(paste.calls.length, 2)
  advance(23 * 60 * 60 * 1000)
  assert.equal((await send(service, token, body)).status, 201)
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
    ingest: async (input) => { calls.push({ authorization: input.authorization, body: await input.readBody() }); return { status: 201, body: { replyId: 'r1' } } },
    listTokens: async (identity) => { calls.push(identity); return { tokens: [] } },
    revokeToken: async (identity, tokenId) => { calls.push(tokenId); return { token: { id: tokenId } } },
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

  // A malformed % escape in the revoke path is a 404, not a server error.
  const badEscape = routeContext({ method: 'POST', pathname: '/api/settings/integrations/supplier-reply-tokens/%E0%A4%A/revoke', env, identity: session('admin'), service })
  assert.equal(await handleSupplierReplyIngestRoute(badEscape.ctx), true)
  assert.deepEqual([badEscape.sent[0].status, badEscape.sent[0].payload.code], [404, 'INTEGRATION_TOKEN_NOT_FOUND'])

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

test('an emailed reply never replaces an open card, and its card shows the sender and whether it is on record', () => {
  const service = read('server/services/supplier-reply-service.mjs')
  assert.match(service, /source: origin\?\.source === 'email' \? 'email' : 'paste'/)
  assert.match(service, /const takesOver = open && read\.readingStatus === 'read' && !emailed/)
  assert.match(service, /senderOnRecord: row\.source === 'email' \? senderOnRecord\(row\.sender, supplierEmail\) : null,/)
  // The paste route passes no origin, and the paste body allows text and receivedOn only.
  assert.doesNotMatch(read('server/routes/supplier-replies.routes.mjs'), /origin/)
  assert.deepEqual(Object.keys(supplierReplyPasteRequestSchema.shape), ['text', 'receivedOn'])
  assert.equal(supplierReplyPasteRequestSchema.safeParse({ text: 'Ships Friday.', source: 'email' }).success, false)
  assert.ok('sender' in supplierReplyCardSchema.shape && 'senderOnRecord' in supplierReplyCardSchema.shape)
  // The card: the sender in its head, and a note when the sender is not on record (English and Chinese).
  const card = read('src/modules/purchasing/supplierReply/SupplierReplyCard.tsx')
  assert.match(card, /card\.source === "email" && card\.sender \? t\("from", \{ sender: card\.sender \}\) : null/)
  assert.match(card, /card\.source === "email" && card\.senderOnRecord === false \? <p [^>]*data-testid="supplier-reply-sender-not-on-record">\{t\("senderNotOnRecord"\)\}<\/p>/)
  const copy = read('src/modules/purchasing/supplierReply/supplierReplyCopy.ts')
  assert.match(copy, /senderNotOnRecord: \["The sender is not this supplier's email on record, so this reply is not offered for recording\.[^"]*", "发件人不是该供应商记录中的邮箱，因此这封回复不能在这里记录。[^"]*"\],/)
  // Nor does a reply from a sender not on record become the order's card.
  assert.match(service, /const senderKnown = !emailed \|\| senderOnRecord\(origin\.sender, await supplierEmailOf\(client, actor\.tenantId, order\)\)/)
  assert.match(service, /active = open && senderKnown && \(takesOver \|\| !previous\.length\)/)
  assert.match(service, /sender: row\.source === 'email' \? senderAddress\(row\.sender\) \|\| text\(row\.sender\)\.slice\(0, 320\) \|\| null : null,/)
})
