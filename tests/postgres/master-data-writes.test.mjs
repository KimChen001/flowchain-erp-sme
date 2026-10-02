import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { createScmServer } from '../../server/bootstrap/scm-server.mjs'
import { createPrismaClient, disconnectPrismaClient } from '../../server/persistence/prisma-client.mjs'

// A fresh workspace can build its own master data: items, customers and the
// suppliers each item is bought from, with versions, validation, unique
// codes, audit rows and no reach into another workspace.
const tenantA = 'tenant-master-writes-a'
const tenantB = 'tenant-master-writes-b'

async function seedTenant(prisma, tenantId, tag) {
  await prisma.tenant.create({ data: { id: tenantId, name: `Workspace ${tag}`, currency: 'USD' } })
  await prisma.user.create({ data: { id: `${tenantId}-manager`, tenantId, email: `writer-${tag.toLowerCase()}@example.com`, name: `Manager ${tag}`, role: 'manager' } })
  await prisma.supplier.create({ data: { id: `SUP-${tag}`, tenantId, code: `SUP-${tag}`, name: `Supplier ${tag}`, metadata: { defaultCurrency: 'USD', version: 1 } } })
  await prisma.supplier.create({ data: { id: `SUP-${tag}2`, tenantId, code: `SUP-${tag}2`, name: `Second Supplier ${tag}`, metadata: { defaultCurrency: 'EUR', version: 1 } } })
  await prisma.warehouse.create({ data: { id: `WH-${tag}`, tenantId, code: `WH-${tag}`, name: `Warehouse ${tag}` } })
  await prisma.item.create({ data: { id: `ITEM-${tag}`, tenantId, sku: `SKU-${tag}`, name: `Item ${tag}`, unit: 'EA' } })
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

test('items, customers and item suppliers can be created and edited in PostgreSQL', async () => {
  assert.ok(process.env.DATABASE_URL_TEST, 'Run with scripts/run-postgres-test-files.mjs')
  const previousTenant = process.env.FLOWCHAIN_DEFAULT_TENANT_ID
  const prisma = await createPrismaClient(process.env)
  let server
  try {
    await seedTenant(prisma, tenantA, 'A')
    await seedTenant(prisma, tenantB, 'B')
    // Sign-in resolves the configured workspace; the session keeps it.
    process.env.FLOWCHAIN_DEFAULT_TENANT_ID = tenantA
    server = createScmServer()
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address()
    const login = await request(port, 'POST', '/api/auth/login', { body: { email: 'writer-a@example.com', name: 'Manager A', company: 'Workspace A' } })
    assert.equal(login.status, 200)
    assert.equal(login.payload.user.tenantId, tenantA)
    const headers = { Authorization: `Bearer ${login.payload.token}` }
    const call = (method, path, body) => request(port, method, path, { headers, body })

    // Items: create, read back, edit with the version, and the guards.
    const created = await call('POST', '/api/master-data/items', { sku: 'NEW-100', itemName: 'Flow Valve', baseUnit: 'EA', category: 'Valves', safetyStock: 5, reorderPoint: 8, minimumOrderQuantity: 10, purchaseLeadTimeDays: 7, defaultSupplierId: 'SUP-A', defaultWarehouseId: 'WH-A', status: 'active' })
    assert.equal(created.status, 201, JSON.stringify(created.payload))
    const item = created.payload.item
    assert.deepEqual([item.sku, item.itemName, item.baseUnit, item.safetyStock, item.reorderPoint, item.minimumOrderQuantity, item.purchaseLeadTimeDays, item.preferredSupplierId, item.version], ['NEW-100', 'Flow Valve', 'EA', 5, 8, 10, 7, 'SUP-A', 1])
    const stored = await prisma.item.findFirst({ where: { tenantId: tenantA, sku: 'NEW-100' } })
    assert.equal(stored.tenantId, tenantA)
    const listed = await call('GET', '/api/master-data/items')
    assert.ok(listed.payload.items.some((row) => row.sku === 'NEW-100'))
    const edited = await call('PATCH', `/api/master-data/items/${item.itemId}`, { itemName: 'Flow Valve 2in', expectedVersion: 1 })
    assert.equal(edited.status, 200, JSON.stringify(edited.payload))
    assert.deepEqual([edited.payload.item.itemName, edited.payload.item.version, edited.payload.item.sku], ['Flow Valve 2in', 2, 'NEW-100'])
    const stale = await call('PATCH', `/api/master-data/items/${item.itemId}`, { itemName: 'Lost update', expectedVersion: 1 })
    assert.deepEqual([stale.status, stale.payload.code], [409, 'VERSION_CONFLICT'])
    const duplicate = await call('POST', '/api/master-data/items', { sku: 'NEW-100', itemName: 'Twin', baseUnit: 'EA' })
    assert.deepEqual([duplicate.status, duplicate.payload.code], [409, 'DUPLICATE_SKU'])
    const renamedSku = await call('PATCH', `/api/master-data/items/${item.itemId}`, { sku: 'OTHER-1', expectedVersion: 2 })
    assert.deepEqual([renamedSku.status, renamedSku.payload.details.map((row) => row.field)], [422, ['sku']])
    const invalid = await call('POST', '/api/master-data/items', { sku: 'BAD 1', itemName: '', baseUnit: 'EA', safetyStock: -1, defaultSupplierId: 'SUP-B' })
    assert.equal(invalid.status, 422)
    assert.deepEqual(invalid.payload.details.map((row) => row.field).sort(), ['defaultSupplierId', 'itemName', 'safetyStock', 'sku'])
    // Another workspace's item and supplier are out of reach.
    const foreign = await call('PATCH', '/api/master-data/items/ITEM-B', { itemName: 'Taken over', expectedVersion: 1 })
    assert.equal(foreign.status, 404)
    assert.equal((await prisma.item.findFirst({ where: { id: 'ITEM-B' } })).name, 'Item B')

    // Customers: create, edit, deactivate, duplicates and validation.
    const customer = await call('POST', '/api/master-data/customers', { code: 'CUST-RED', name: 'Redwood Retail', currency: 'usd', email: 'buyer@redwood.example', paymentTerms: 'NET30' })
    assert.equal(customer.status, 201, JSON.stringify(customer.payload))
    assert.deepEqual([customer.payload.customer.code, customer.payload.customer.currency, customer.payload.customer.version, customer.payload.customer.status], ['CUST-RED', 'USD', 1, 'active'])
    const customerId = customer.payload.customer.id
    const renamed = await call('PATCH', `/api/master-data/customers/${customerId}`, { name: 'Redwood Retail Co.', expectedVersion: 1 })
    assert.deepEqual([renamed.status, renamed.payload.customer.name, renamed.payload.customer.version], [200, 'Redwood Retail Co.', 2])
    const deactivated = await call('POST', `/api/master-data/customers/${customerId}/deactivate`, { expectedVersion: 2 })
    assert.deepEqual([deactivated.status, deactivated.payload.customer.status], [200, 'inactive'])
    const twin = await call('POST', '/api/master-data/customers', { code: 'CUST-RED', name: 'Twin' })
    assert.deepEqual([twin.status, twin.payload.code], [409, 'DUPLICATE_CODE'])
    const badEmail = await call('POST', '/api/master-data/customers', { code: 'CUST-X', name: 'X', email: 'not-an-email', currency: 'ZZZ' })
    assert.deepEqual(badEmail.payload.details.map((row) => row.field).sort(), ['currency', 'email'])
    const customers = await call('GET', '/api/master-data/customers')
    assert.deepEqual(customers.payload.customers.map((row) => row.code), ['CUST-RED'])

    // Item suppliers: link two suppliers, move the preferred one, and the
    // item and its approved sources follow.
    const first = await call('POST', `/api/master-data/items/${item.itemId}/suppliers`, { supplierId: 'SUP-A', preferred: true, leadTimeDays: 5, minimumOrderQuantity: 20, referencePrice: 12.5 })
    assert.equal(first.status, 201, JSON.stringify(first.payload))
    assert.deepEqual([first.payload.relationship.preferred, first.payload.relationship.currency, first.payload.relationship.referencePrice], [true, 'USD', 12.5])
    const second = await call('POST', `/api/master-data/items/${item.itemId}/suppliers`, { supplierId: 'SUP-A2', leadTimeDays: 9, minimumOrderQuantity: 1, referencePrice: 0 })
    assert.equal(second.status, 201)
    assert.deepEqual([second.payload.relationship.currency, second.payload.relationship.referencePrice], ['EUR', null])
    const again = await call('POST', `/api/master-data/items/${item.itemId}/suppliers`, { supplierId: 'SUP-A' })
    assert.deepEqual([again.status, again.payload.code], [409, 'RELATIONSHIP_EXISTS'])
    const foreignSupplier = await call('POST', `/api/master-data/items/${item.itemId}/suppliers`, { supplierId: 'SUP-B' })
    assert.equal(foreignSupplier.status, 422)
    const moved = await call('PATCH', `/api/master-data/items/${item.itemId}/suppliers/${second.payload.relationship.relationshipId}`, { preferred: true, expectedVersion: 1 })
    assert.deepEqual([moved.status, moved.payload.relationship.preferred], [200, true])
    assert.equal((await prisma.item.findFirst({ where: { id: item.itemId } })).preferredSupplierId, 'SUP-A2')
    const sources = await call('GET', `/api/master-data/items/${item.itemId}/suppliers`)
    assert.equal(sources.status, 200)
    assert.deepEqual(sources.payload.suppliers.map((row) => [row.id, row.preferred]), [['SUP-A2', true], ['SUP-A', false]])
    const deactivatedLink = await call('PATCH', `/api/master-data/items/${item.itemId}/suppliers/${second.payload.relationship.relationshipId}`, { active: false, expectedVersion: 2 })
    assert.deepEqual([deactivatedLink.payload.relationship.active, deactivatedLink.payload.relationship.preferred], [false, false])
    assert.equal((await prisma.item.findFirst({ where: { id: item.itemId } })).preferredSupplierId, null)
    const supplierItems = await call('GET', '/api/master-data/suppliers/SUP-A/items')
    assert.equal(supplierItems.status, 200)
    assert.deepEqual(supplierItems.payload.relationships.map((row) => [row.itemId, row.item?.sku]), [[item.itemId, 'NEW-100']])

    // Every write left an audit row in its own workspace.
    const audits = await prisma.auditLog.findMany({ where: { tenantId: tenantA, source: 'master-data' } })
    assert.ok(audits.length >= 7, String(audits.length))
    assert.equal(await prisma.auditLog.count({ where: { tenantId: tenantB, source: 'master-data' } }), 0)
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve))
    if (previousTenant === undefined) delete process.env.FLOWCHAIN_DEFAULT_TENANT_ID
    else process.env.FLOWCHAIN_DEFAULT_TENANT_ID = previousTenant
    await disconnectPrismaClient()
    await prisma.$disconnect()
  }
})
