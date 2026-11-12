import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createScmServer } from '../../server/bootstrap/scm-server.mjs'
import { readOutbox } from '../../server/mail/outbox-mailer.mjs'
import { createPrismaClient, disconnectPrismaClient } from '../../server/persistence/prisma-client.mjs'

// The follow-up email on an overdue purchase order (docs/drafted-decisions-design.md
// §4.11, DD-9), through the real server, database and local outbox: off until
// the workspace turns it on; sent only to the confirmed address, with replies
// to the sender; recorded on the order; the card becomes "chased"; a retry
// sends once; one email per order per day.
const tenantId = 'supplier-email-a'
const dayOffset = (days) => new Date(Date.now() + days * 86_400_000)

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
        resolve({ status: res.statusCode, payload })
      })
    })
    req.on('error', reject)
    req.end(raw)
  })
}

test('a follow-up is emailed only when turned on and confirmed, recorded on the order, and sent once', async () => {
  assert.ok(process.env.DATABASE_URL_TEST, 'Run with scripts/run-postgres-test-files.mjs')
  const keys = ['FLOWCHAIN_DEFAULT_TENANT_ID', 'FLOWCHAIN_MAIL_PROVIDER', 'FLOWCHAIN_MAIL_OUTBOX_PATH']
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]))
  const folder = await mkdtemp(join(tmpdir(), 'flowchain-supplier-email-'))
  const outboxPath = join(folder, 'outbox.json')
  const prisma = await createPrismaClient(process.env)
  let server
  try {
    await prisma.tenant.create({ data: { id: tenantId, name: 'Workspace E' } })
    await prisma.user.create({ data: { id: `${tenantId}-manager`, tenantId, email: 'buyer-e@example.com', name: 'Buyer E', role: 'manager' } })
    await prisma.supplier.create({ data: { id: 'SUP-E', tenantId, code: 'SUP-E', name: 'Supplier E', metadata: { email: 'orders-e@example.com', contactName: 'Pat E' } } })
    await prisma.purchaseOrder.create({ data: {
      id: 'PO-E', tenantId, supplierId: 'SUP-E', supplierName: 'Supplier E', status: 'issued', currency: 'USD', amount: '100.0000',
      expectedDate: dayOffset(-10), issuedAt: dayOffset(-20),
      lines: { create: [{ id: 'PO-E-L1', sku: 'SKU-E', itemName: 'Item E', orderedQuantity: '10.0000', receivedQuantity: '0.0000', unit: 'EA' }] },
    } })
    process.env.FLOWCHAIN_DEFAULT_TENANT_ID = tenantId
    process.env.FLOWCHAIN_MAIL_PROVIDER = 'outbox'
    process.env.FLOWCHAIN_MAIL_OUTBOX_PATH = outboxPath
    server = createScmServer()
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address()
    const login = await request(port, 'POST', '/api/auth/login', { body: { email: 'buyer-e@example.com' } })
    assert.equal(login.status, 200, JSON.stringify(login.payload))
    const headers = { Authorization: `Bearer ${login.payload.token}` }
    const key = 'purchase_order_overdue:PO-E'
    const email = { key, to: 'orders-e@example.com', confirmedTo: 'orders-e@example.com', subject: 'Purchase order PO-E: delivery overdue', body: 'Dear Pat E,\n\nPlease confirm when it ships.' }
    const send = (body = email) => request(port, 'POST', '/api/decision-items/send-follow-up', { headers, body })
    const today = async () => (await request(port, 'GET', '/api/home/overview', { headers })).payload

    // 1. Off by default: the card offers no sending, and the route refuses.
    let home = await today()
    assert.deepEqual(home.decisions.supplierEmail, { enabled: false, canSend: false, outbox: true })
    const off = await send()
    assert.equal(off.status, 409)
    assert.equal(off.payload.code, 'SUPPLIER_EMAIL_OFF')

    // 2. An administrator turns it on.
    await prisma.tenant.update({ where: { id: tenantId }, data: { operationalSettings: { review: { supplierFollowUpEmail: true } } } })
    home = await today()
    assert.deepEqual(home.decisions.supplierEmail, { enabled: true, canSend: true, outbox: true })

    // 3. The address must be the one confirmed.
    const unconfirmed = await send({ ...email, confirmedTo: 'someone@else.example' })
    assert.equal(unconfirmed.status, 422)
    assert.equal(unconfirmed.payload.code, 'SUPPLIER_EMAIL_NOT_CONFIRMED')
    assert.deepEqual(await readOutbox(outboxPath), [])

    // 4. Sent to the outbox, replies to the sender, recorded on the order.
    const sent = await send()
    assert.equal(sent.status, 200, JSON.stringify(sent.payload))
    assert.equal(sent.payload.outbox, true)
    const outbox = await readOutbox(outboxPath)
    assert.equal(outbox.length, 1)
    assert.equal(outbox[0].to, 'orders-e@example.com')
    assert.equal(outbox[0].replyTo, 'buyer-e@example.com')
    assert.equal(outbox[0].subject, email.subject)
    assert.equal(outbox[0].text, email.body)
    const audit = await prisma.auditLog.findMany({ where: { tenantId, entityType: 'purchase_order', entityId: 'PO-E', action: 'supplier_follow_up_sent' } })
    assert.equal(audit.length, 1)
    assert.equal(audit[0].metadata.to, 'orders-e@example.com')
    assert.equal(audit[0].metadata.body, email.body)

    // 5. The card is chased by email.
    home = await today()
    const aside = home.decisions.setAside.find((entry) => entry.key === key)
    assert.equal(aside.decision, 'chased')
    assert.equal(aside.note, 'email')

    // 6. A retry of the same email sends nothing new.
    const retry = await send()
    assert.equal(retry.status, 200)
    assert.equal(retry.payload.repeated, true)
    assert.equal((await readOutbox(outboxPath)).length, 1)

    // 7. After a reopen, a second email to the same order the same day is refused.
    assert.equal((await request(port, 'POST', '/api/decision-items/reopen', { headers, body: { key } })).status, 200)
    const second = await send({ ...email, body: `${email.body}\n\nSecond reminder.` })
    assert.equal(second.status, 429)
    assert.equal(second.payload.code, 'SUPPLIER_EMAIL_ORDER_LIMIT')
    assert.equal((await readOutbox(outboxPath)).length, 1)

    // 8. Nobody signed out can send.
    const anonymous = await request(port, 'POST', '/api/decision-items/send-follow-up', { body: email })
    assert.equal(anonymous.status, 401)
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve))
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await disconnectPrismaClient()
    await prisma.$disconnect()
    await rm(folder, { recursive: true, force: true })
  }
})
