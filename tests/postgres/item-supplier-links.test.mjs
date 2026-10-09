import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { createScmServer } from '../../server/bootstrap/scm-server.mjs'
import { createPrismaClient, disconnectPrismaClient } from '../../server/persistence/prisma-client.mjs'

// Supplier prices (owner decision 2026-10-09): every item-supplier link across
// items on one read-only list, narrowed by search, supplier and item and
// paged, with the reference price masked without procurement.prices.read,
// exactly as the per-item read masks it, and nothing of another workspace.
const tenant = 'tenant-item-supplier-links'
const otherTenant = 'tenant-item-supplier-links-other'

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

test('every item-supplier link is listed, narrowed, paged and price-masked per reader', async () => {
  assert.ok(process.env.DATABASE_URL_TEST, 'Run with scripts/run-postgres-test-files.mjs')
  const previousTenant = process.env.FLOWCHAIN_DEFAULT_TENANT_ID
  const prisma = await createPrismaClient(process.env)
  let server
  try {
    await prisma.tenant.createMany({ data: [{ id: tenant, name: 'Links workspace', currency: 'USD' }, { id: otherTenant, name: 'Other links workspace', currency: 'USD' }] })
    for (const [key, role] of Object.entries({ manager: 'manager', viewer: 'viewer' })) {
      await prisma.user.create({ data: { id: `${tenant}-${key}`, tenantId: tenant, email: `${key}-links@example.com`, name: `Links ${key}`, role } })
    }
    for (const [id, name] of [['SUP-L1', 'Acme Fittings'], ['SUP-L2', 'Birch Metals']]) {
      await prisma.supplier.create({ data: { id, tenantId: tenant, code: id, name, metadata: { defaultCurrency: 'USD', version: 1 } } })
    }
    for (const [id, sku, name] of [['ITEM-L1', 'VALVE-10', 'Brass valve'], ['ITEM-L2', 'BOLT-04', 'Hex bolt']]) {
      await prisma.item.create({ data: { id, tenantId: tenant, sku, name, unit: 'EA' } })
    }
    await prisma.supplier.create({ data: { id: 'SUP-OTHER', tenantId: otherTenant, code: 'SUP-OTHER', name: 'Other Supplier', metadata: { defaultCurrency: 'USD', version: 1 } } })
    await prisma.item.create({ data: { id: 'ITEM-OTHER', tenantId: otherTenant, sku: 'VALVE-10', name: 'Other valve', unit: 'EA' } })
    await prisma.runtimeRecord.create({ data: { id: 'ISR-OTHER', tenantId: otherTenant, namespace: 'master-data.item-suppliers', recordKey: 'ITEM-OTHER::SUP-OTHER', payload: { itemId: 'ITEM-OTHER', supplierId: 'SUP-OTHER', referencePrice: 99, currency: 'USD', version: 1 } } })

    process.env.FLOWCHAIN_DEFAULT_TENANT_ID = tenant
    server = createScmServer()
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address()
    const signIn = async (key) => {
      const login = await request(port, 'POST', '/api/auth/login', { body: { email: `${key}-links@example.com`, name: `Links ${key}`, company: 'Links workspace' } })
      assert.equal(login.status, 200, JSON.stringify(login.payload))
      const headers = { Authorization: `Bearer ${login.payload.token}` }
      return (method, path, body) => request(port, method, path, { headers, body })
    }
    const asManager = await signIn('manager')
    const asViewer = await signIn('viewer')

    // The links are added where they are edited today, through the item.
    for (const [itemId, supplierId, body] of [
      ['ITEM-L1', 'SUP-L1', { referencePrice: 12.5, currency: 'USD', preferred: true, supplierSku: 'AC-7731', leadTimeDays: 7, minimumOrderQuantity: 50 }],
      ['ITEM-L1', 'SUP-L2', { referencePrice: 11.75, currency: 'EUR', approved: false }],
      ['ITEM-L2', 'SUP-L2', { referencePrice: 0.4, currency: 'USD', active: false }],
    ]) {
      const created = await asManager('POST', `/api/master-data/items/${itemId}/suppliers`, { supplierId, ...body })
      assert.equal(created.status, 201, JSON.stringify(created.payload))
    }

    assert.equal((await request(port, 'GET', '/api/master-data/item-suppliers')).status, 401)
    const all = await asManager('GET', '/api/master-data/item-suppliers')
    assert.equal(all.status, 200, JSON.stringify(all.payload))
    assert.deepEqual([all.payload.total, all.payload.truncated, all.payload.visibility], [3, false, { prices: true }])
    assert.deepEqual(all.payload.rows.map((row) => `${row.item.sku}/${row.supplier.supplierCode}`), ['BOLT-04/SUP-L2', 'VALVE-10/SUP-L1', 'VALVE-10/SUP-L2'])
    const valve = all.payload.rows[1]
    assert.deepEqual(
      [valve.item.itemName, valve.supplier.supplierName, valve.supplierSku, valve.referencePrice, valve.currency, valve.minimumOrderQuantity, valve.leadTimeDays, valve.preferred, valve.approved, valve.active],
      ['Brass valve', 'Acme Fittings', 'AC-7731', 12.5, 'USD', 50, 7, true, true, true],
    )
    assert.deepEqual([all.payload.rows[2].approved, all.payload.rows[0].active], [false, false])
    assert.deepEqual(all.payload.options.suppliers.map((row) => row.id), ['SUP-L1', 'SUP-L2'])
    assert.deepEqual(all.payload.options.items.map((row) => row.sku), ['BOLT-04', 'VALVE-10'])
    // Nothing of the other workspace, though its item has the same SKU.
    assert.equal(JSON.stringify(all.payload).includes('OTHER'), false)

    // Narrowed in the database by supplier or item, searched, paged.
    const ids = (response) => response.payload.rows.map((row) => row.relationshipId)
    const bySupplier = await asManager('GET', '/api/master-data/item-suppliers?supplierId=SUP-L2')
    assert.deepEqual(bySupplier.payload.rows.map((row) => row.item.sku), ['BOLT-04', 'VALVE-10'])
    assert.equal(bySupplier.payload.options, undefined)
    const byItem = await asManager('GET', '/api/master-data/item-suppliers?itemId=ITEM-L1')
    assert.deepEqual(byItem.payload.rows.map((row) => row.supplier.supplierId), ['SUP-L1', 'SUP-L2'])
    assert.deepEqual(ids(await asManager('GET', '/api/master-data/item-suppliers?itemId=ITEM-L1&supplierId=SUP-L2')), [all.payload.rows[2].relationshipId])
    assert.deepEqual(ids(await asManager('GET', '/api/master-data/item-suppliers?query=ac-77')), [valve.relationshipId])
    assert.deepEqual(ids(await asManager('GET', '/api/master-data/item-suppliers?query=hex')), [all.payload.rows[0].relationshipId])
    const page = await asManager('GET', '/api/master-data/item-suppliers?limit=2&offset=2')
    assert.deepEqual([page.payload.total, page.payload.rows.length, page.payload.offset], [3, 1, 2])

    // A viewer may not read reference prices: null, never 0, and named, as on
    // the per-item read; the rest of each link stays readable.
    const viewed = await asViewer('GET', '/api/master-data/item-suppliers')
    assert.equal(viewed.status, 200, JSON.stringify(viewed.payload))
    assert.deepEqual(viewed.payload.visibility, { prices: false })
    assert.ok(viewed.payload.rows.every((row) => row.referencePrice === null && row.restrictedFields.includes('referencePrice')))
    assert.deepEqual(viewed.payload.rows.map((row) => row.supplierSku), all.payload.rows.map((row) => row.supplierSku))
    for (const amount of ['12.5', '11.75', '0.4']) assert.equal(JSON.stringify(viewed.payload).includes(amount), false, amount)
    const perItem = await asViewer('GET', '/api/master-data/items/ITEM-L1/suppliers')
    assert.ok(perItem.payload.relationships.every((row) => row.referencePrice === null))
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve))
    if (previousTenant === undefined) delete process.env.FLOWCHAIN_DEFAULT_TENANT_ID
    else process.env.FLOWCHAIN_DEFAULT_TENANT_ID = previousTenant
    await disconnectPrismaClient()
    await prisma.$disconnect()
  }
})
