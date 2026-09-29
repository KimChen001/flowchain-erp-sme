import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { createScmServer } from '../../server/bootstrap/scm-server.mjs'
import { createPrismaClient, disconnectPrismaClient } from '../../server/persistence/prisma-client.mjs'

// Two workspaces with the same kinds of records. Every read must return only
// the signed-in workspace's rows, whatever FLOWCHAIN_DEFAULT_TENANT_ID says.
const tenantA = 'tenant-scoped-reads-a'
const tenantB = 'tenant-scoped-reads-b'

async function seedTenant(prisma, tenantId, tag) {
  await prisma.tenant.create({ data: { id: tenantId, name: `Workspace ${tag}` } })
  await prisma.user.create({ data: { id: `${tenantId}-manager`, tenantId, email: `manager-${tag.toLowerCase()}@example.com`, name: `Manager ${tag}`, role: 'manager' } })
  await prisma.supplier.create({ data: { id: `SUP-${tag}`, tenantId, code: `SUP-${tag}`, name: `Supplier ${tag}` } })
  await prisma.item.create({ data: { id: `ITEM-${tag}`, tenantId, sku: `SKU-${tag}`, name: `Item ${tag}`, unit: 'EA' } })
  await prisma.purchaseOrder.create({ data: {
    id: `PO-${tag}`, tenantId, supplierId: `SUP-${tag}`, supplierName: `Supplier ${tag}`, status: 'issued', currency: 'USD', amount: '100.0000',
    lines: { create: [{ id: `PO-${tag}-L1`, sku: `SKU-${tag}`, itemName: `Item ${tag}`, orderedQuantity: '10.0000', receivedQuantity: '0.0000', unit: 'EA' }] },
  } })
  await prisma.receivingDocument.create({ data: { id: `GRN-${tag}`, tenantId, documentNumber: `GRN-${tag}`, poId: `PO-${tag}`, supplierId: `SUP-${tag}`, currency: 'USD' } })
  await prisma.supplierInvoice.create({ data: { id: `INV-${tag}`, tenantId, invoiceNumber: `INV-${tag}`, supplierId: `SUP-${tag}`, amount: '100.0000', totalAmount: '100.0000', currency: 'USD', relatedPoId: `PO-${tag}` } })
  await prisma.salesOrder.create({ data: {
    id: `SO-${tag}`, tenantId, orderNumber: `SO-${tag}`, customerName: `Customer ${tag}`, workflowStatus: 'confirmed', currency: 'USD',
    lines: { create: [{ id: `SO-${tag}-L1`, itemId: `ITEM-${tag}`, sku: `SKU-${tag}`, itemName: `Item ${tag}`, orderedQuantity: '3.0000', unit: 'EA' }] },
  } })
  await prisma.inventoryBalance.create({ data: { id: `BAL-${tag}`, tenantId, itemId: `ITEM-${tag}`, sku: `SKU-${tag}`, itemName: `Item ${tag}`, onHandQuantity: '5.0000', availableQuantity: '5.0000', unit: 'EA' } })
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

const ids = (rows = []) => rows.map((row) => row.id).sort()

function assertOnlyTenant(context, tag) {
  assert.deepEqual(ids(context.purchaseOrders), [`PO-${tag}`])
  assert.deepEqual(ids(context.receipts), [`GRN-${tag}`])
  assert.deepEqual(ids(context.supplierInvoices), [`INV-${tag}`])
  assert.deepEqual(ids(context.salesOrders), [`SO-${tag}`])
  assert.deepEqual(ids(context.suppliers), [`SUP-${tag}`])
  assert.deepEqual(ids(context.items), [`ITEM-${tag}`])
  assert.deepEqual(context.inventoryItems.map((row) => row.sku), [`SKU-${tag}`])
}

test('reports and the business read context return only the signed-in workspace rows', async () => {
  assert.ok(process.env.DATABASE_URL_TEST, 'Run with scripts/run-postgres-test-files.mjs')
  const keys = ['FLOWCHAIN_DEFAULT_TENANT_ID', 'FLOWCHAIN_ALLOW_TEST_IDENTITY_HEADERS']
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]))
  const prisma = await createPrismaClient(process.env)
  let server
  try {
    await seedTenant(prisma, tenantA, 'A')
    await seedTenant(prisma, tenantB, 'B')

    process.env.FLOWCHAIN_DEFAULT_TENANT_ID = tenantA
    process.env.FLOWCHAIN_ALLOW_TEST_IDENTITY_HEADERS = 'true'
    server = createScmServer()
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address()

    const login = await request(port, 'POST', '/api/auth/login', { body: { email: 'manager-a@example.com', name: 'Manager A', company: 'Workspace A' } })
    assert.equal(login.status, 200)
    assert.equal(login.payload.user.tenantId, tenantA)
    const signedInA = { Authorization: `Bearer ${login.payload.token}` }

    // The configured default now points at the other workspace. A session
    // keeps reading its own workspace; nothing falls back to the default.
    process.env.FLOWCHAIN_DEFAULT_TENANT_ID = tenantB

    const context = await request(port, 'GET', '/api/business/read-context', { headers: signedInA })
    assert.equal(context.status, 200)
    assertOnlyTenant(context.payload, 'A')

    for (const subject of ['procurement', 'sales', 'finance', 'suppliers', 'inventory']) {
      const report = await request(port, 'POST', '/api/reports/query', { headers: signedInA, body: { subject, filters: {}, limit: 50 } })
      assert.equal(report.status, 200, subject)
      const serialized = JSON.stringify(report.payload)
      assert.ok(serialized.includes('-A') || subject === 'inventory', subject)
      assert.ok(!/\b(?:PO|GRN|INV|SO|SUP|SKU|ITEM)-B\b|Supplier B|Customer B/.test(serialized), `${subject} leaked workspace B`)
    }
    const overview = await request(port, 'GET', '/api/reports/overview', { headers: signedInA })
    assert.equal(overview.status, 200)
    assert.deepEqual(overview.payload.dataScope.filterOptions.suppliers, ['Supplier A'])
    assert.deepEqual(overview.payload.dataScope.filterOptions.customers, [])
    assert.ok(!JSON.stringify(overview.payload).includes('PO-B'))

    // The test identity takes the configured workspace, now B.
    const headersB = { 'x-flowchain-user': 'manager-b', 'x-flowchain-role': 'manager' }
    const contextB = await request(port, 'GET', '/api/business/read-context', { headers: headersB })
    assert.equal(contextB.status, 200)
    assertOnlyTenant(contextB.payload, 'B')
    const procurementB = await request(port, 'POST', '/api/reports/query', { headers: headersB, body: { subject: 'procurement', filters: {} } })
    assert.deepEqual(procurementB.payload.exportRows.map((row) => row.id), ['PO-B'])

    const anonymous = await request(port, 'GET', '/api/business/read-context')
    assert.equal(anonymous.status, 401)
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
