import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { backfillTenantAuthorization } from '../../server/auth/authorization-backfill.mjs'
import { createScmServer } from '../../server/bootstrap/scm-server.mjs'
import { createPrismaClient } from '../../server/persistence/prisma-client.mjs'
import { supplierReplyStockResponseSchema } from '../../shared/supplier-reply-stock-contract.mjs'

// The supplier reply card's stock line through the real server and database
// (shared/supplier-reply-stock-contract.mjs): a reply pasted with AI off on an
// overdue order, then the stock read with the dates the manual form would
// record. The bracket has 80 available under a reorder point of 100; the late
// 60 due now would lift it to 140, so a new date ten days on leaves it below
// its reorder point from today. No model is called.
const tenantA = 'supplier-reply-stock-a'
const tenantB = 'supplier-reply-stock-b'
const dayOffset = (days) => new Date(Date.now() + days * 86_400_000)
const iso = (date) => date.toISOString().slice(0, 10)

async function seedTenant(prisma, tenantId, tag) {
  await prisma.tenant.create({ data: { id: tenantId, name: `Workspace ${tag}` } })
  await prisma.user.createMany({ data: [
    { id: `${tenantId}-manager`, tenantId, email: `stock-manager-${tag.toLowerCase()}@example.com`, name: `Manager ${tag}`, role: 'manager' },
    { id: `${tenantId}-buyer`, tenantId, email: `stock-buyer-${tag.toLowerCase()}@example.com`, name: `Buyer ${tag}`, role: 'buyer' },
  ] })
  await prisma.supplier.create({ data: { id: `SUP-${tag}`, tenantId, code: `SUP-${tag}`, name: `Acme ${tag}` } })
  await prisma.warehouse.create({ data: { id: `WH-${tag}`, tenantId, code: `WH-${tag}`, name: `Warehouse ${tag}`, status: 'active' } })
  await prisma.item.create({ data: { id: `ITEM-${tag}-1040`, tenantId, sku: 'SKU-1040', name: 'Bracket', unit: 'pcs', reorderPoint: '100.0000' } })
  await prisma.inventoryBalance.create({ data: {
    id: `BAL-${tag}-1040`, tenantId, itemId: `ITEM-${tag}-1040`, sku: 'SKU-1040', itemName: 'Bracket', warehouseId: `WH-${tag}`, warehouseKey: `WH-${tag}`, location: 'A-01', locationKey: 'a-01',
    onHandQuantity: '80.0000', reservedQuantity: '0.0000', availableQuantity: '80.0000', reorderPoint: '100.0000', unit: 'pcs', status: 'active',
  } })
  // Issued 30 days ago, promised 5 days ago: 60 brackets overdue.
  await prisma.purchaseOrder.create({ data: {
    id: `PO-${tag}`, number: `PO-202611-00${tag === 'A' ? '21' : '22'}`, tenantId, supplierId: `SUP-${tag}`, supplierName: `Acme ${tag}`, status: 'issued', currency: 'USD', amount: '150.0000',
    expectedDate: dayOffset(-5), issuedAt: dayOffset(-30),
    lines: { create: [
      { id: `PO-${tag}-L1`, itemId: `ITEM-${tag}-1040`, sku: 'SKU-1040', itemName: 'Bracket', orderedQuantity: '60.0000', receivedQuantity: '0.0000', unit: 'pcs', unitPrice: '2.5000', amount: '150.0000', originalPromisedDate: dayOffset(-5), metadata: { promisedDate: iso(dayOffset(-5)), warehouseId: `WH-${tag}` } },
    ] },
  } })
  await backfillTenantAuthorization(prisma, tenantId, { actorId: `${tenantId}-manager` })
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

const AI_KEYS = ['FLOWCHAIN_AI_PROVIDER_KIND', 'FLOWCHAIN_AI_RUNTIME_MODE', 'FLOWCHAIN_AI_ASSISTANT_MODE', 'FLOWCHAIN_AI_ASSISTANT_SCRIPTED', 'FLOWCHAIN_KNOWLEDGE_PROVIDER', 'FLOWCHAIN_AI_PROVIDER_API_KEY', 'FLOWCHAIN_AI_PROVIDER_ENDPOINT', 'FLOWCHAIN_DEFAULT_TENANT_ID']

test('the stock read with the manual form\'s dates: below the reorder point from today, before the new date', async () => {
  assert.ok(process.env.DATABASE_URL_TEST, 'Run with scripts/run-postgres-test-files.mjs')
  const previous = Object.fromEntries(AI_KEYS.map((key) => [key, process.env[key]]))
  for (const key of AI_KEYS) delete process.env[key]
  process.env.FLOWCHAIN_AI_RUNTIME_MODE = 'local'
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
    const asBuyer = await signIn('stock-buyer-a@example.com')
    process.env.FLOWCHAIN_DEFAULT_TENANT_ID = tenantB
    const asOther = await signIn('stock-buyer-b@example.com')

    // Pasted with AI off: kept, the manual form offered, nothing proposed.
    const pasted = await request(port, 'POST', '/api/procurement/orders/PO-A/supplier-replies', { headers: asBuyer, body: { text: 'The brackets ship in ten days.' } })
    assert.equal(pasted.status, 201, JSON.stringify(pasted.payload))
    const stock = `/api/procurement/orders/PO-A/supplier-replies/${pasted.payload.reply.id}/stock`

    // Nothing proposed and no dates given: nothing to project.
    const none = await request(port, 'GET', stock, { headers: asBuyer })
    assert.equal(none.status, 200, JSON.stringify(none.payload))
    assert.ok(supplierReplyStockResponseSchema.safeParse(none.payload).success, JSON.stringify(none.payload))
    assert.deepEqual([none.payload.available, none.payload.effects], [true, []])

    // The form's date, ten days on: below the reorder point from today.
    const newDate = iso(dayOffset(10))
    const answer = await request(port, 'GET', `${stock}?dates=${encodeURIComponent(`PO-A-L1:${newDate}`)}`, { headers: asBuyer })
    assert.equal(answer.status, 200, JSON.stringify(answer.payload))
    assert.ok(supplierReplyStockResponseSchema.safeParse(answer.payload).success, JSON.stringify(answer.payload))
    assert.deepEqual(answer.payload.effects.map((effect) => [effect.sku, effect.kind, effect.from, effect.newDate, effect.reorderPoint]), [['SKU-1040', 'below_reorder_point', answer.payload.asOf, newDate, 100]])
    // A date today changes nothing.
    const now = await request(port, 'GET', `${stock}?dates=${encodeURIComponent(`PO-A-L1:${answer.payload.asOf}`)}`, { headers: asBuyer })
    assert.deepEqual(now.payload.effects, [])

    // The card's refusals: signed out, another workspace, dates out of shape.
    assert.equal((await request(port, 'GET', stock)).status, 401)
    assert.equal((await request(port, 'GET', stock, { headers: asOther })).status, 404)
    const bad = await request(port, 'GET', `${stock}?dates=PO-A-L1`, { headers: asBuyer })
    assert.deepEqual([bad.status, bad.payload.code], [422, 'SUPPLIER_REPLY_INVALID'])
    assert.equal((await request(port, 'GET', '/api/procurement/orders/PO-A/supplier-replies/no-such-reply/stock', { headers: asBuyer })).payload.code, 'SUPPLIER_REPLY_NOT_FOUND')
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve))
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
    await prisma.$disconnect()
  }
})
