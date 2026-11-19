import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { createScmServer } from '../../server/bootstrap/scm-server.mjs'
import { createPrismaClient, disconnectPrismaClient } from '../../server/persistence/prisma-client.mjs'

// Decision items on Today (docs/drafted-decisions-design.md), through the real
// server and database: Today raises an item for each drafted row, with its
// draft; a person sets one aside, a second decision is refused, a reopen
// brings it back, a row that goes away closes its item, and another
// workspace cannot decide on it.
const tenantA = 'decision-items-a'
const tenantB = 'decision-items-b'
const dayOffset = (days) => new Date(Date.now() + days * 86_400_000)

async function seedTenant(prisma, tenantId, tag) {
  await prisma.tenant.create({ data: { id: tenantId, name: `Workspace ${tag}` } })
  await prisma.user.create({ data: { id: `${tenantId}-manager`, tenantId, email: `decide-${tag.toLowerCase()}@example.com`, name: `Manager ${tag}`, role: 'manager' } })
  await prisma.supplier.create({ data: { id: `SUP-${tag}`, tenantId, code: `SUP-${tag}`, name: `Supplier ${tag}`, metadata: { email: `orders-${tag.toLowerCase()}@example.com`, contactName: `Pat ${tag}` } } })
  await prisma.item.create({ data: { id: `ITEM-${tag}`, tenantId, sku: `SKU-${tag}`, name: `Item ${tag}`, unit: 'EA' } })
  await prisma.warehouse.create({ data: { id: `WH-${tag}`, tenantId, code: `WH-${tag}`, name: `Warehouse ${tag}`, status: 'active' } })
  // Issued 30 days ago, due 20 days ago, nothing received: overdue.
  await prisma.purchaseOrder.create({ data: {
    id: `PO-${tag}`, tenantId, supplierId: `SUP-${tag}`, supplierName: `Supplier ${tag}`, status: 'issued', currency: 'USD', amount: '100.0000',
    expectedDate: dayOffset(-20), issuedAt: dayOffset(-30),
    lines: { create: [{ id: `PO-${tag}-L1`, sku: `SKU-${tag}`, itemName: `Item ${tag}`, orderedQuantity: '10.0000', receivedQuantity: '0.0000', unit: 'EA' }] },
  } })
  // Approved and ready to convert: one line with supplier, currency and warehouse.
  await prisma.purchaseRequest.create({ data: {
    id: `PR-${tag}`, tenantId, status: 'approved', supplierId: `SUP-${tag}`, supplierName: `Supplier ${tag}`, currency: 'USD', amount: '40.0000', metadata: { version: 2 },
    lines: { create: [{ id: `PR-${tag}-L1`, itemId: `ITEM-${tag}`, sku: `SKU-${tag}`, itemName: `Item ${tag}`, quantity: '4.0000', unit: 'EA', unitPrice: '10.0000', amount: '40.0000', metadata: { supplierId: `SUP-${tag}`, currency: 'USD', targetWarehouseId: `WH-${tag}` } }] },
  } })
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
        resolve({ status: res.statusCode, payload })
      })
    })
    req.on('error', reject)
    req.end(raw)
  })
}

const keys = (entries = []) => entries.map((entry) => entry.key).sort()

test('Today raises decision items with drafts, remembers decisions and closes items whose row went away', async () => {
  assert.ok(process.env.DATABASE_URL_TEST, 'Run with scripts/run-postgres-test-files.mjs')
  const envKeys = ['FLOWCHAIN_DEFAULT_TENANT_ID']
  const previous = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]))
  const prisma = await createPrismaClient(process.env)
  let server
  try {
    await seedTenant(prisma, tenantA, 'A')
    await seedTenant(prisma, tenantB, 'B')
    process.env.FLOWCHAIN_DEFAULT_TENANT_ID = tenantA
    server = createScmServer()
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address()
    const signIn = async (email) => {
      const login = await request(port, 'POST', '/api/auth/login', { body: { email } })
      assert.equal(login.status, 200, JSON.stringify(login.payload))
      return { Authorization: `Bearer ${login.payload.token}` }
    }
    const asA = await signIn('decide-a@example.com')
    process.env.FLOWCHAIN_DEFAULT_TENANT_ID = tenantB
    const asB = await signIn('decide-b@example.com')
    const today = async (headers = asA) => {
      const home = await request(port, 'GET', '/api/home/overview', { headers })
      assert.equal(home.status, 200, JSON.stringify(home.payload))
      return home.payload
    }
    const poKey = 'purchase_order_overdue:PO-A'
    const prKey = 'purchase_request_to_convert:PR-A'

    // 1. Today raises an item for each drafted row, each with its draft.
    let home = await today()
    assert.equal(home.decisions.available, true)
    assert.deepEqual(keys(home.decisions.waiting), [poKey, prKey])
    const followUp = home.decisions.waiting.find((entry) => entry.key === poKey).draft
    assert.equal(followUp.type, 'supplier_follow_up')
    assert.deepEqual(followUp.supplier, { id: 'SUP-A', name: 'Supplier A', contactName: 'Pat A', email: 'orders-a@example.com' })
    assert.deepEqual(followUp.lines.map((line) => [line.sku, line.remaining]), [['SKU-A', 10]])
    const conversion = home.decisions.waiting.find((entry) => entry.key === prKey).draft
    assert.deepEqual(conversion.orders.map((order) => [order.supplierId, order.currency, order.lines]), [['SUP-A', 'USD', 1]])
    assert.equal(conversion.version, 2)
    // Today's rows are unchanged: the page splits them.
    assert.ok(home.workItems.some((row) => row.kind === 'purchase_order_overdue' && row.recordId === 'PO-A'))
    assert.equal(await prisma.decisionItem.count({ where: { tenantId: tenantA, state: 'open' } }), 2)
    // A second read raises nothing new.
    await today()
    assert.equal(await prisma.decisionItem.count({ where: { tenantId: tenantA } }), 2)

    // 2. "Not now" sets the order aside until its day.
    const returnOn = dayOffset(5).toISOString().slice(0, 10)
    const notNow = await request(port, 'POST', '/api/decision-items/decide', { headers: asA, body: { key: poKey, option: 'not_now', returnOn } })
    assert.equal(notNow.status, 200, JSON.stringify(notNow.payload))
    home = await today()
    assert.deepEqual(keys(home.decisions.waiting), [prKey])
    const aside = home.decisions.setAside.find((entry) => entry.key === poKey)
    assert.equal(aside.decision, 'not_now')
    assert.equal(aside.returnOn, returnOn)
    assert.deepEqual(aside.decidedBy, { name: 'Manager A' })

    // 3. A second decision on the same item is refused, with who decided.
    const again = await request(port, 'POST', '/api/decision-items/decide', { headers: asA, body: { key: poKey, option: 'chased' } })
    assert.equal(again.status, 409)
    assert.equal(again.payload.code, 'DECISION_ALREADY_MADE')
    assert.equal(again.payload.decidedBy, 'Manager A')

    // 4. Checks: a reason is needed, the row must be on the reader's Today,
    // and another workspace cannot decide on it.
    const noNote = await request(port, 'POST', '/api/decision-items/decide', { headers: asA, body: { key: prKey, option: 'not_needed', reasonCode: 'other' } })
    assert.equal(noNote.status, 422)
    assert.equal(noNote.payload.code, 'DECISION_NOTE_REQUIRED')
    const unknown = await request(port, 'POST', '/api/decision-items/decide', { headers: asA, body: { key: 'purchase_order_overdue:PO-B', option: 'chased' } })
    assert.equal(unknown.status, 404)
    const fromB = await request(port, 'POST', '/api/decision-items/decide', { headers: asB, body: { key: poKey, option: 'chased' } })
    assert.equal(fromB.status, 404)
    const anonymous = await request(port, 'POST', '/api/decision-items/decide', { body: { key: poKey, option: 'chased' } })
    assert.equal(anonymous.status, 401)

    // 5. Reopen brings it back, marked as returned.
    const reopened = await request(port, 'POST', '/api/decision-items/reopen', { headers: asA, body: { key: poKey } })
    assert.equal(reopened.status, 200, JSON.stringify(reopened.payload))
    home = await today()
    assert.deepEqual(keys(home.decisions.waiting), [poKey, prKey])
    assert.equal(home.decisions.waiting.find((entry) => entry.key === poKey).returned, true)

    // 6. Chased: set aside, recorded in the audit log.
    const chased = await request(port, 'POST', '/api/decision-items/decide', { headers: asA, body: { key: poKey, option: 'chased' } })
    assert.equal(chased.status, 200)
    const audit = await prisma.auditLog.findMany({ where: { tenantId: tenantA, entityId: 'PO-A', action: { in: ['decision_item_decided', 'decision_item_reopened'] } }, orderBy: { createdAt: 'asc' } })
    assert.deepEqual(audit.map((row) => [row.action, row.metadata.decision ?? row.metadata.previousDecision]), [['decision_item_decided', 'not_now'], ['decision_item_reopened', 'not_now'], ['decision_item_decided', 'chased']])

    // 7. Converting the request takes its row off Today at once; "accepted"
    // is still taken, but only with the orders the request records it made.
    await prisma.purchaseRequest.update({ where: { id: 'PR-A' }, data: { status: 'converted', linkedPoId: 'PO-A', metadata: { version: 3, linkedPurchaseOrderIds: ['PO-A'] } } })
    const wrongOrders = await request(port, 'POST', '/api/decision-items/decide', { headers: asA, body: { key: prKey, option: 'accepted', documentType: 'purchase_order', documentIds: ['PO-B'] } })
    assert.equal(wrongOrders.status, 404)
    const accepted = await request(port, 'POST', '/api/decision-items/decide', { headers: asA, body: { key: prKey, option: 'accepted', documentType: 'purchase_order', documentIds: ['PO-A'] } })
    assert.equal(accepted.status, 200, JSON.stringify(accepted.payload))
    home = await today()
    assert.deepEqual(keys(home.decisions.waiting), [])
    const closed = await prisma.decisionItem.findFirst({ where: { tenantId: tenantA, recordId: 'PR-A' } })
    assert.equal(closed.state, 'resolved')
    assert.equal(closed.decision, 'accepted')
    assert.equal(closed.documentId, 'PO-A')
    assert.equal(closed.activeKey, null)
    assert.ok(closed.resolvedAt)

    // 8. Workspace B sees only its own items.
    const homeB = await today(asB)
    assert.deepEqual(keys(homeB.decisions.waiting), ['purchase_order_overdue:PO-B', 'purchase_request_to_convert:PR-B'])
    assert.ok(!JSON.stringify(homeB.decisions).includes('PO-A'))
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve))
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await disconnectPrismaClient()
    await prisma.$disconnect()
  }
})
