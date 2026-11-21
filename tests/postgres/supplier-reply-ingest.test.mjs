import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { backfillTenantAuthorization } from '../../server/auth/authorization-backfill.mjs'
import { createScmServer } from '../../server/bootstrap/scm-server.mjs'
import { INTEGRATION_TOKEN_NAMESPACE } from '../../server/domain/integration-tokens.mjs'
import { createPrismaClient } from '../../server/persistence/prisma-client.mjs'
import { supplierReplyCardSchema } from '../../shared/supplier-reply-contract.mjs'

// Supplier replies without pasting (docs/supplier-reply-ingest-api.md), through
// the real server and database: an admin makes a token, a forwarder posts a
// reply with it, and the reply lands on the order as an emailed reply that a
// person records as usual. A reply from an address that is not the
// supplier's is kept but flagged, and does not replace the open card. No
// model is set up, so the reading is "no provider" and the card offers the
// manual form; no model is called.
const tenantE = 'supplier-reply-ingest-e'
const tenantF = 'supplier-reply-ingest-f'
const dayOffset = (days) => new Date(Date.now() + days * 86_400_000)

async function seedTenant(prisma, tenantId, tag, { publicData = false } = {}) {
  await prisma.tenant.create({ data: { id: tenantId, name: `Workspace ${tag}`, operationalSettings: { ai: { modelAssistEnabled: true } } } })
  await prisma.user.createMany({ data: [
    { id: `${tenantId}-admin`, tenantId, email: `ingest-admin-${tag.toLowerCase()}@example.com`, name: `Admin ${tag}`, role: 'admin' },
    { id: `${tenantId}-buyer`, tenantId, email: `ingest-buyer-${tag.toLowerCase()}@example.com`, name: `Buyer ${tag}`, role: 'buyer' },
  ] })
  await prisma.supplier.create({ data: { id: `SUP-${tag}`, tenantId, code: `SUP-${tag}`, name: `Acme ${tag}`, metadata: { email: `orders@acme-${tag.toLowerCase()}.example` } } })
  await prisma.purchaseOrder.create({ data: {
    id: `PO-${tag}`, number: `PO-202611-00${tag === 'E' ? '21' : '22'}`, tenantId, supplierId: `SUP-${tag}`, supplierName: `Acme ${tag}`, status: 'issued', currency: 'USD', amount: '250.0000',
    expectedDate: dayOffset(-3), issuedAt: dayOffset(-20),
    lines: { create: [
      { id: `PO-${tag}-L1`, sku: 'SKU-1040', itemName: 'Bracket', orderedQuantity: '100.0000', receivedQuantity: '0.0000', unit: 'pcs', unitPrice: '2.5000', amount: '250.0000', originalPromisedDate: dayOffset(-3), promisedDate: dayOffset(-3) },
    ] },
  } })
  if (publicData) {
    await prisma.runtimeRecord.create({ data: { id: `NOTE-${tag}`, tenantId, namespace: 'workspace.public-data', recordKey: 'note', payload: { dataset: 'uci', sourceWindow: { first: '2010-12-01', last: '2011-12-09' }, window: { first: '2025-12-01', last: '2026-11-20' }, shiftDays: 5470 } } })
  }
  await backfillTenantAuthorization(prisma, tenantId, { actorId: `${tenantId}-admin` })
}

async function request(port, method, path, { headers = {}, body } = {}) {
  const raw = body === undefined ? '' : JSON.stringify(body)
  return await new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, method, path, headers: raw ? { ...headers, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(raw) } : headers }, (res) => {
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        let payload = text
        try { payload = JSON.parse(text) } catch { /* keep text */ }
        resolve({ status: res.statusCode, payload, headers: res.headers })
      })
    })
    req.on('error', reject)
    req.end(raw)
  })
}

const KEYS = ['FLOWCHAIN_AI_PROVIDER_KIND', 'FLOWCHAIN_AI_RUNTIME_MODE', 'FLOWCHAIN_AI_ASSISTANT_MODE', 'FLOWCHAIN_AI_ASSISTANT_SCRIPTED', 'FLOWCHAIN_KNOWLEDGE_PROVIDER', 'FLOWCHAIN_AI_PROVIDER_API_KEY', 'FLOWCHAIN_AI_PROVIDER_ENDPOINT', 'FLOWCHAIN_DEFAULT_TENANT_ID', 'FLOWCHAIN_SUPPLIER_REPLY_INGEST', 'FLOWCHAIN_SUPPLIER_REPLY_INGEST_PUBLIC_DATA', 'FLOWCHAIN_SUPPLIER_REPLY_INGEST_PER_DAY']

test('a token made by an admin brings a supplier reply onto its order as an emailed reply, for a person to record', async () => {
  assert.ok(process.env.DATABASE_URL_TEST, 'Run with scripts/run-postgres-test-files.mjs')
  const previous = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]))
  for (const key of KEYS) delete process.env[key]
  process.env.FLOWCHAIN_AI_RUNTIME_MODE = 'local'
  const prisma = await createPrismaClient(process.env)
  let server
  try {
    await seedTenant(prisma, tenantE, 'E')
    await seedTenant(prisma, tenantF, 'F', { publicData: true })
    server = createScmServer()
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address()
    const signIn = async (tenantId, email) => {
      process.env.FLOWCHAIN_DEFAULT_TENANT_ID = tenantId
      const login = await request(port, 'POST', '/api/auth/login', { body: { email } })
      assert.equal(login.status, 200, JSON.stringify(login.payload))
      return { Authorization: `Bearer ${login.payload.token}` }
    }
    const asAdmin = await signIn(tenantE, 'ingest-admin-e@example.com')
    const asBuyer = await signIn(tenantE, 'ingest-buyer-e@example.com')
    const asAdminF = await signIn(tenantF, 'ingest-admin-f@example.com')
    const tokens = '/api/settings/integrations/supplier-reply-tokens'
    const ingest = '/api/integrations/supplier-replies'
    const reply = { subject: 'RE: PO-202611-0021 delivery', text: 'Hello, the brackets ship on 28 November.', from: 'Pat <pat@acme-e.example>', messageId: '<reply-1@acme-e.example>' }

    // Off unless the server switches it on: the routes are not there.
    assert.equal((await request(port, 'GET', tokens, { headers: asAdmin })).status, 404)
    assert.equal((await request(port, 'POST', ingest, { body: reply })).status, 404)
    process.env.FLOWCHAIN_SUPPLIER_REPLY_INGEST = 'on'

    // Only an admin makes a token, and it acts for that admin.
    assert.equal((await request(port, 'POST', tokens, { headers: asBuyer, body: { name: 'Mine' } })).status, 403)
    const made = await request(port, 'POST', tokens, { headers: asAdmin, body: { name: 'Outlook rule' } })
    assert.equal(made.status, 201, JSON.stringify(made.payload))
    const secret = made.payload.secret
    assert.match(secret, /^fcsr\./)
    assert.equal(made.payload.token.owner.id, `${tenantE}-admin`)
    const stored = await prisma.runtimeRecord.findFirst({ where: { tenantId: tenantE, namespace: INTEGRATION_TOKEN_NAMESPACE } })
    assert.ok(!JSON.stringify(stored.payload).includes(secret.split('.')[3]), 'only the hash is stored')

    // No token, or a session token: refused.
    assert.equal((await request(port, 'POST', ingest, { body: reply })).status, 401)
    assert.equal((await request(port, 'POST', ingest, { headers: asBuyer, body: reply })).status, 401)

    // The forwarder posts the reply; it lands on PO-E as the order's card.
    const withToken = { Authorization: `Bearer ${secret}` }
    const sent = await request(port, 'POST', ingest, { headers: withToken, body: reply })
    assert.equal(sent.status, 201, JSON.stringify(sent.payload))
    assert.deepEqual([sent.payload.purchaseOrderNumber, sent.payload.state, sent.payload.readingStatus], ['PO-202611-0021', 'needs_you', 'no_provider'])
    assert.ok(!JSON.stringify(sent.payload).includes('brackets'), 'only ids and codes come back')
    const row = await prisma.supplierReply.findFirst({ where: { tenantId: tenantE, id: sent.payload.replyId } })
    assert.deepEqual([row.source, row.sender, row.messageId, row.createdById, row.purchaseOrderId, row.activeKey], ['email', 'Pat <pat@acme-e.example>', '<reply-1@acme-e.example>', `${tenantE}-admin`, 'PO-E', 'PO-E'])
    const audit = await prisma.auditLog.findFirst({ where: { tenantId: tenantE, action: 'supplier_reply_pasted', entityId: 'PO-E' } })
    assert.deepEqual([audit.metadata.source, audit.metadata.tokenId], ['email', made.payload.token.id])

    // The same message again is kept once.
    const again = await request(port, 'POST', ingest, { headers: withToken, body: reply })
    assert.deepEqual([again.status, again.payload.duplicate, again.payload.replyId], [200, true, sent.payload.replyId])

    // A reply from an address that is not the supplier's: kept, flagged, and it
    // does not replace the open card.
    const forged = await request(port, 'POST', ingest, { headers: withToken, body: { ...reply, from: 'mallory@evil.example', messageId: '<forged@evil.example>', text: 'PO-202611-0021 ships on 30 December.' } })
    assert.equal(forged.status, 201, JSON.stringify(forged.payload))
    const listed = await request(port, 'GET', '/api/procurement/orders/PO-E/supplier-replies', { headers: asBuyer })
    const cards = new Map(listed.payload.replies.map((card) => [card.id, card]))
    for (const card of cards.values()) assert.ok(supplierReplyCardSchema.safeParse(card).success)
    const genuine = cards.get(sent.payload.replyId)
    const impostor = cards.get(forged.payload.replyId)
    assert.deepEqual([genuine.source, genuine.sender, genuine.senderOnRecord, genuine.canDecide], ['email', 'Pat <pat@acme-e.example>', true, true])
    assert.deepEqual([impostor.sender, impostor.senderOnRecord, impostor.canDecide], ['mallory@evil.example', false, false])
    assert.equal((await prisma.supplierReply.findFirst({ where: { tenantId: tenantE, id: sent.payload.replyId } })).activeKey, 'PO-E')

    // The admin sees when it was last used; once revoked, it is refused, and the refusal is audited.
    const list = await request(port, 'GET', tokens, { headers: asAdmin })
    assert.ok(list.payload.tokens[0].lastUsedAt)
    assert.equal((await request(port, 'POST', `${tokens}/${made.payload.token.id}/revoke`, { headers: asAdmin })).status, 200)
    assert.equal((await request(port, 'POST', ingest, { headers: withToken, body: { ...reply, messageId: '<reply-2@acme-e.example>' } })).status, 401)
    assert.ok(await prisma.auditLog.findFirst({ where: { tenantId: tenantE, action: 'supplier_reply_ingest_refused', entityId: made.payload.token.id } }))

    // A public-data workspace cannot make one unless the server allows it.
    const refused = await request(port, 'POST', tokens, { headers: asAdminF, body: { name: 'Rule' } })
    assert.deepEqual([refused.status, refused.payload.code], [403, 'SUPPLIER_REPLY_INGEST_PUBLIC_DATA'])
    assert.equal(await prisma.supplierReply.count({ where: { tenantId: tenantF } }), 0)
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve))
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
    await prisma.$disconnect()
  }
})
