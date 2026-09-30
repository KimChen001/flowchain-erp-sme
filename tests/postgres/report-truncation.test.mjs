import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { createScmServer } from '../../server/bootstrap/scm-server.mjs'
import { createPrismaClient, disconnectPrismaClient } from '../../server/persistence/prisma-client.mjs'

// Reports read at most 500 documents of each kind and 200 suppliers and items.
// A workspace just over each limit must be told that its totals are partial;
// one exactly at each limit must not.
const overTenant = 'tenant-report-truncation-over'
const exactTenant = 'tenant-report-truncation-exact'
const range = (count) => Array.from({ length: count }, (_, index) => String(index + 1).padStart(4, '0'))

async function seedTenant(prisma, tenantId, { documents, masterData }) {
  await prisma.tenant.create({ data: { id: tenantId, name: tenantId } })
  await prisma.supplier.createMany({ data: range(masterData).map((n) => ({ id: `${tenantId}-SUP-${n}`, tenantId, code: `SUP-${n}`, name: `Supplier ${n}` })) })
  await prisma.item.createMany({ data: range(masterData).map((n) => ({ id: `${tenantId}-ITEM-${n}`, tenantId, sku: `SKU-${n}`, name: `Item ${n}`, unit: 'EA' })) })
  await prisma.purchaseOrder.createMany({ data: range(documents).map((n) => ({ id: `${tenantId}-PO-${n}`, tenantId, status: 'issued', currency: 'USD', amount: '10.0000' })) })
  await prisma.receivingDocument.createMany({ data: range(documents).map((n) => ({ id: `${tenantId}-GRN-${n}`, tenantId, documentNumber: `GRN-${n}`, currency: 'USD' })) })
  await prisma.supplierInvoice.createMany({ data: range(documents).map((n) => ({ id: `${tenantId}-INV-${n}`, tenantId, invoiceNumber: `INV-${n}`, amount: '10.0000', totalAmount: '10.0000', currency: 'USD' })) })
  await prisma.salesOrder.createMany({ data: range(documents).map((n) => ({ id: `${tenantId}-SO-${n}`, tenantId, orderNumber: `SO-${n}`, customerName: 'Customer', workflowStatus: 'confirmed', currency: 'USD' })) })
  await prisma.salesOrderLine.createMany({ data: range(documents).map((n) => ({ id: `${tenantId}-SO-${n}-L1`, salesOrderId: `${tenantId}-SO-${n}`, itemId: `${tenantId}-ITEM-0001`, sku: 'SKU-0001', itemName: 'Item 0001', orderedQuantity: '1.0000', unit: 'EA' })) })
}

async function request(port, method, path, { headers = {}, body } = {}) {
  const raw = body === undefined ? '' : JSON.stringify(body)
  return await new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, method, path, headers: raw ? { ...headers, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(raw) } : headers }, (res) => {
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () => resolve({ status: res.statusCode, payload: JSON.parse(Buffer.concat(chunks).toString('utf8')) }))
    })
    req.on('error', reject)
    req.end(raw)
  })
}

const bySubject = (entries = []) => [...entries].sort((a, b) => a.subject.localeCompare(b.subject))

async function withServer(run) {
  const keys = ['FLOWCHAIN_DEFAULT_TENANT_ID', 'FLOWCHAIN_ALLOW_TEST_IDENTITY_HEADERS']
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]))
  process.env.FLOWCHAIN_ALLOW_TEST_IDENTITY_HEADERS = 'true'
  const server = createScmServer()
  try {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    // The test identity takes the configured workspace at request time.
    const asTenant = async (tenantId, method, path, body) => {
      process.env.FLOWCHAIN_DEFAULT_TENANT_ID = tenantId
      return await request(server.address().port, method, path, { headers: { 'x-flowchain-user': 'report-reader', 'x-flowchain-role': 'manager' }, body })
    }
    return await run(asTenant)
  } finally {
    await new Promise((resolve) => server.close(resolve))
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

test('reports say which subjects were cut off at the read limit', async () => {
  assert.ok(process.env.DATABASE_URL_TEST, 'Run with scripts/run-postgres-test-files.mjs')
  const prisma = await createPrismaClient(process.env)
  try {
    await seedTenant(prisma, overTenant, { documents: 501, masterData: 201 })
    await seedTenant(prisma, exactTenant, { documents: 500, masterData: 200 })
    const expected = bySubject([
      { subject: 'purchase_orders', limit: 500 },
      { subject: 'receipts', limit: 500 },
      { subject: 'supplier_invoices', limit: 500 },
      { subject: 'sales_orders', limit: 500 },
      { subject: 'suppliers', limit: 200 },
      { subject: 'items', limit: 200 },
    ])

    await withServer(async (asTenant) => {
      const context = await asTenant(overTenant, 'GET', '/api/business/read-context')
      assert.equal(context.status, 200)
      assert.deepEqual(bySubject(context.payload.truncatedSubjects), expected)
      // The limits themselves are unchanged: the extra row is not returned.
      assert.equal(context.payload.purchaseOrders.length, 500)
      assert.equal(context.payload.receipts.length, 500)
      assert.equal(context.payload.supplierInvoices.length, 500)
      assert.equal(context.payload.salesOrders.length, 500)
      assert.equal(context.payload.suppliers.length, 200)
      assert.equal(context.payload.items.length, 200)

      for (const subject of ['overview', 'procurement', 'sales', 'finance', 'suppliers', 'inventory']) {
        const report = await asTenant(overTenant, 'POST', '/api/reports/query', { subject, filters: {} })
        assert.equal(report.status, 200, subject)
        assert.deepEqual(bySubject(report.payload.truncatedSubjects), expected, subject)
      }
      const dashboard = await asTenant(overTenant, 'GET', '/api/reports/procurement')
      assert.deepEqual(bySubject(dashboard.payload.truncatedSubjects), expected)

      const exactContext = await asTenant(exactTenant, 'GET', '/api/business/read-context')
      assert.deepEqual(exactContext.payload.truncatedSubjects, [])
      assert.equal(exactContext.payload.purchaseOrders.length, 500)
      assert.equal(exactContext.payload.suppliers.length, 200)
      const exactReport = await asTenant(exactTenant, 'POST', '/api/reports/query', { subject: 'overview', filters: {} })
      assert.deepEqual(exactReport.payload.truncatedSubjects, [])
    })
  } finally {
    await disconnectPrismaClient()
    await prisma.$disconnect()
  }
})
