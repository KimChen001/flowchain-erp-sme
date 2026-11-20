import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { backfillTenantAuthorization } from '../../server/auth/authorization-backfill.mjs'
import { createScmServer } from '../../server/bootstrap/scm-server.mjs'
import { createPrismaClient } from '../../server/persistence/prisma-client.mjs'
import { supplierReplyStockEffects } from '../../server/domain/supplier-reply-stock.mjs'
import { readSupplierReplyStockInputs } from '../../server/services/supplier-reply-stock-inputs.mjs'
import { supplierReplyStockResponseSchema } from '../../shared/supplier-reply-stock-contract.mjs'

// The supplier reply card's stock line through the real server and database
// (shared/supplier-reply-stock-contract.mjs): a reply pasted with AI off on an
// overdue order, then the stock read with the dates the manual form would
// record. The bracket has 50 in the order's warehouse and 70 in another, under
// a reorder point of 100; 60 are overdue on the order. No model is called.
//   - a reader of every warehouse: 120 available, never below 100: no line;
//   - a reader limited to some warehouses is refused the card, as purchase
//     order read is checked without a warehouse; the narrow read for the
//     order's warehouse alone (50, which the 60 due now would lift to 110)
//     gives below the reorder point from today on a date ten days on;
//   - a reader of orders but not of inventory: no stock line at all.
// The ids carry this test's own prefix: test:db:supplier-replies runs it in
// one database with supplier-replies.test.mjs, whose ids are PO-A, SUP-A...
const tenantA = 'supplier-reply-stock-a'
const tenantB = 'supplier-reply-stock-b'
const dayOffset = (days) => new Date(Date.now() + days * 86_400_000)
const iso = (date) => date.toISOString().slice(0, 10)
const id = (tag, name) => `STK-${tag}-${name}`

async function seedTenant(prisma, tenantId, tag) {
  await prisma.tenant.create({ data: { id: tenantId, name: `Stock workspace ${tag}` } })
  await prisma.user.createMany({ data: [
    { id: id(tag, 'manager'), tenantId, email: `stock-manager-${tag.toLowerCase()}@example.com`, name: `Manager ${tag}`, role: 'manager' },
    { id: id(tag, 'buyer'), tenantId, email: `stock-buyer-${tag.toLowerCase()}@example.com`, name: `Buyer ${tag}`, role: 'buyer' },
    { id: id(tag, 'ops'), tenantId, email: `stock-ops-${tag.toLowerCase()}@example.com`, name: `Operations ${tag}`, role: 'business-specialist' },
  ] })
  await prisma.supplier.create({ data: { id: id(tag, 'SUP'), tenantId, code: id(tag, 'SUP'), name: `Acme ${tag}` } })
  for (const warehouse of ['WH1', 'WH2']) await prisma.warehouse.create({ data: { id: id(tag, warehouse), tenantId, code: id(tag, warehouse), name: `Warehouse ${tag} ${warehouse}`, status: 'active' } })
  await prisma.item.create({ data: { id: id(tag, 'ITEM'), tenantId, sku: 'SKU-1040', name: 'Bracket', unit: 'pcs', reorderPoint: '100.0000' } })
  for (const [warehouse, onHand] of [['WH1', '50.0000'], ['WH2', '70.0000']]) {
    await prisma.inventoryBalance.create({ data: {
      id: id(tag, `BAL-${warehouse}`), tenantId, itemId: id(tag, 'ITEM'), sku: 'SKU-1040', itemName: 'Bracket', warehouseId: id(tag, warehouse), warehouseKey: id(tag, warehouse), location: 'A-01', locationKey: 'a-01',
      onHandQuantity: onHand, reservedQuantity: '0.0000', availableQuantity: onHand, unit: 'pcs', status: 'active',
    } })
  }
  // Issued 30 days ago, promised 5 days ago: 60 brackets overdue, for the first warehouse.
  await prisma.purchaseOrder.create({ data: {
    id: id(tag, 'PO'), number: `PO-202611-00${tag === 'A' ? '41' : '42'}`, tenantId, supplierId: id(tag, 'SUP'), supplierName: `Acme ${tag}`, status: 'issued', currency: 'USD', amount: '150.0000',
    expectedDate: dayOffset(-5), issuedAt: dayOffset(-30), metadata: { targetWarehouseId: id(tag, 'WH1') },
    lines: { create: [
      { id: id(tag, 'PO-L1'), itemId: id(tag, 'ITEM'), sku: 'SKU-1040', itemName: 'Bracket', orderedQuantity: '60.0000', receivedQuantity: '0.0000', unit: 'pcs', unitPrice: '2.5000', amount: '150.0000', originalPromisedDate: dayOffset(-5), metadata: { promisedDate: iso(dayOffset(-5)), targetWarehouseId: id(tag, 'WH1') } },
    ] },
  } })
  await backfillTenantAuthorization(prisma, tenantId, { actorId: id(tag, 'manager') })
  // The operations reader sees the order's warehouse only.
  await prisma.userWarehouseScope.create({ data: { id: id(tag, 'ops-scope'), tenantId, userId: id(tag, 'ops'), warehouseId: id(tag, 'WH1'), accessLevel: 'operate' } })
  // A reader of purchase orders who may not read inventory: their one role
  // grants purchase order read alone. The stored role is one sign-in keeps
  // (a session whose role differs from it is stale); permissions come only
  // from the role assigned, as rolesAssignedAt says roles were set.
  await prisma.user.create({ data: { id: id(tag, 'orders'), tenantId, email: `stock-orders-${tag.toLowerCase()}@example.com`, name: `Orders ${tag}`, role: 'viewer', rolesAssignedAt: new Date() } })
  await prisma.tenantRole.create({ data: { id: id(tag, 'orders-role'), tenantId, roleKey: `stock-orders-${tag.toLowerCase()}`, name: 'Orders only' } })
  await prisma.tenantRolePermission.create({ data: { id: id(tag, 'orders-permission'), tenantId, roleId: id(tag, 'orders-role'), permissionCode: 'procurement.purchase_order.read' } })
  await prisma.userRoleAssignment.create({ data: { id: id(tag, 'orders-assignment'), tenantId, userId: id(tag, 'orders'), roleId: id(tag, 'orders-role') } })
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

test('the stock read with the manual form\'s dates follows the reader\'s warehouses and inventory permission', async () => {
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
    const asManager = await signIn('stock-manager-a@example.com')
    const asOps = await signIn('stock-ops-a@example.com')
    const asOrders = await signIn('stock-orders-a@example.com')
    process.env.FLOWCHAIN_DEFAULT_TENANT_ID = tenantB
    const asOther = await signIn('stock-buyer-b@example.com')

    // Pasted with AI off: kept, the manual form offered, nothing proposed.
    const orderPath = `/api/procurement/orders/${id('A', 'PO')}/supplier-replies`
    const pasted = await request(port, 'POST', orderPath, { headers: asBuyer, body: { text: 'The brackets ship in ten days.' } })
    assert.equal(pasted.status, 201, JSON.stringify(pasted.payload))
    const stock = `${orderPath}/${pasted.payload.reply.id}/stock`
    const newDate = iso(dayOffset(10))
    const withDate = (day) => `${stock}?dates=${encodeURIComponent(`${id('A', 'PO-L1')}:${day}`)}`

    // Nothing proposed and no dates given: nothing to project.
    const none = await request(port, 'GET', stock, { headers: asManager })
    assert.equal(none.status, 200, JSON.stringify(none.payload))
    assert.ok(supplierReplyStockResponseSchema.safeParse(none.payload).success, JSON.stringify(none.payload))
    assert.deepEqual([none.payload.available, none.payload.effects], [true, []])

    // Every warehouse: 120 available stays above the reorder point.
    const all = await request(port, 'GET', withDate(newDate), { headers: asManager })
    assert.equal(all.status, 200, JSON.stringify(all.payload))
    assert.ok(supplierReplyStockResponseSchema.safeParse(all.payload).success, JSON.stringify(all.payload))
    assert.deepEqual([all.payload.available, all.payload.effects], [true, []])

    // A reader limited to some warehouses: the card's own read refuses them
    // (purchase order read is checked without a warehouse), and the stock
    // read with it.
    const scopedList = await request(port, 'GET', orderPath, { headers: asOps })
    const scopedStock = await request(port, 'GET', withDate(newDate), { headers: asOps })
    assert.deepEqual([scopedStock.status, scopedStock.payload.code], [scopedList.status, scopedList.payload.code])
    // The narrow read itself, in the real database, for the order's warehouse
    // only: 50 there (70 elsewhere), below the reorder point from today.
    const today = all.payload.asOf
    const inWarehouse = await readSupplierReplyStockInputs({ prisma, tenantId: tenantA, today, timeZone: 'America/New_York', skus: ['SKU-1040'], warehouseIds: [id('A', 'WH1')], salesOrdersVisible: true })
    assert.deepEqual(inWarehouse.items.map((row) => [row.sku, row.available, row.reorderPoint]), [['SKU-1040', 50, 100]])
    assert.deepEqual(inWarehouse.incoming.map((row) => [row.lineId, row.remaining]), [[id('A', 'PO-L1'), 60]])
    assert.deepEqual([inWarehouse.demand, inWarehouse.rates.size], [[], 0])
    const overrides = [{ lineId: id('A', 'PO-L1'), date: newDate }]
    assert.deepEqual(supplierReplyStockEffects({ today, purchaseOrderId: id('A', 'PO'), ...inWarehouse, overrides }).map((effect) => [effect.kind, effect.from, effect.newDate, effect.basis]), [['below_reorder_point', today, newDate, null]])
    // Every warehouse: 120.
    const everywhere = await readSupplierReplyStockInputs({ prisma, tenantId: tenantA, today, timeZone: 'America/New_York', skus: ['SKU-1040'], warehouseIds: null, salesOrdersVisible: true })
    assert.deepEqual(everywhere.items.map((row) => row.available), [120])
    // A date of today changes nothing.
    assert.deepEqual((await request(port, 'GET', withDate(today), { headers: asManager })).payload.effects, [])

    // A reader of orders without inventory read: no stock line.
    const hidden = await request(port, 'GET', withDate(newDate), { headers: asOrders })
    assert.equal(hidden.status, 200, JSON.stringify(hidden.payload))
    assert.deepEqual([hidden.payload.available, hidden.payload.reason, hidden.payload.effects], [false, 'inventory_hidden', []])

    // The card's refusals: signed out, another workspace, dates out of shape or not real.
    assert.equal((await request(port, 'GET', stock)).status, 401)
    assert.equal((await request(port, 'GET', stock, { headers: asOther })).status, 404)
    const bad = await request(port, 'GET', `${stock}?dates=${id('A', 'PO-L1')}`, { headers: asBuyer })
    assert.deepEqual([bad.status, bad.payload.code], [422, 'SUPPLIER_REPLY_INVALID'])
    assert.equal((await request(port, 'GET', withDate('2027-02-31'), { headers: asBuyer })).status, 422)
    assert.equal((await request(port, 'GET', `${orderPath}/no-such-reply/stock`, { headers: asBuyer })).payload.code, 'SUPPLIER_REPLY_NOT_FOUND')
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve))
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
    await prisma.$disconnect()
  }
})
