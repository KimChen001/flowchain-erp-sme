import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'

// Supplier list metrics and tier suggestions (docs/supplier-tiers-design.md,
// T2) on the walkthrough scenario, for readers with different access.
const tenantId = 'tenant-supplier-insights'
const timeZone = 'America/New_York'
process.env.FLOWCHAIN_DEFAULT_TENANT_ID = tenantId
const { createPrismaClient, disconnectPrismaClient } = await import('../../server/persistence/prisma-client.mjs')
const { backfillTenantAuthorization } = await import('../../server/auth/authorization-backfill.mjs')
const { createDatabaseRepositoryRegistry } = await import('../../server/repositories/adapter-registry.mjs')
const { createScmServer } = await import('../../server/bootstrap/scm-server.mjs')
const { seedLocalDemo } = await import('../../scripts/setup-local-demo.mjs')
const { seedLocalScenario } = await import('../../scripts/setup-local-scenario.mjs')
const { createSupplierInsightsReadService } = await import('../../server/domain/supplier-insights.mjs')
const { buildOpenPurchaseOrdersReport } = await import('../../server/domain/open-purchase-orders-report.mjs')

const AS_OF = '2026-03-09'
const asOfNoon = new Date(`${AS_OF}T12:00:00Z`)
const env = { ...process.env, FLOWCHAIN_DEFAULT_TENANT_ID: tenantId }
const COMMITTED = new Set(['approved', 'issued', 'partially_received', 'fully_received', 'closed'])
const SUP = (n) => `LOCAL-DEMO-SUP-${String(n).padStart(3, '0')}`

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

test('supplier metrics agree with the reports and suggestions state their facts, per reader', async () => {
  assert.ok(process.env.DATABASE_URL_TEST, 'An isolated test database is required')
  const prisma = await createPrismaClient(env)
  let server
  try {
    await prisma.tenant.create({ data: { id: tenantId, name: 'Supplier Insights Tenant', countryCode: 'US', locale: 'en-US', currency: 'USD', timezone: timeZone, defaultLanguage: 'en-US' } })
    const people = { admin: 'admin', viewer: 'viewer', finance: 'finance-specialist', operations: 'business-specialist' }
    for (const [key, role] of Object.entries(people)) await prisma.user.create({ data: { id: `${tenantId}-${key}`, tenantId, email: `${key}-insights@example.com`, name: `Insights ${key}`, role } })
    await backfillTenantAuthorization(prisma, tenantId, { actorId: `${tenantId}-admin` })
    await seedLocalDemo(prisma, env)
    await seedLocalScenario(prisma, env, { asOf: AS_OF })

    const repositories = createDatabaseRepositoryRegistry({ env, prisma })
    const service = createSupplierInsightsReadService({ prisma, listPurchaseOrders: repositories.procurementRuntime.listForReport, now: () => asOfNoon })
    const read = (key) => service.read({ env, repositories, identity: { authenticated: true, tenantId, userId: `${tenantId}-${key}`, role: people[key], name: `Insights ${key}`, source: 'test-suite' } })
    const tiers = (insights) => Object.fromEntries(Object.entries(insights.suppliers).map(([id, row]) => [id, row.suggestion?.tier ?? null]))

    // The administrator sees everything.
    const admin = await read('admin')
    assert.deepEqual(admin.visibility, { orders: true, amounts: true, onTime: true, issues: true })
    assert.equal(admin.asOf, AS_OF)
    const purchaseOrders = await prisma.purchaseOrder.findMany({ where: { tenantId }, include: { lines: true } })
    const report = buildOpenPurchaseOrdersReport(purchaseOrders, { export: 'true' }, asOfNoon, { timeZone }).exportRows
    for (const [supplierId, row] of Object.entries(admin.suppliers)) {
      // Open and overdue orders are the open purchase orders report's, by supplier id.
      const open = report.filter((po) => po.supplierId === supplierId && po.isOpen)
      assert.deepEqual([row.openPos, row.overduePos], [open.length, open.filter((po) => po.overdueDays > 0).length], supplierId)
      // Spend: committed orders of the last 12 months, in USD, never other statuses.
      const usd = purchaseOrders.filter((po) => po.supplierId === supplierId && COMMITTED.has(po.status)).reduce((sum, po) => sum + Number(po.amount), 0)
      assert.deepEqual(row.spend12m, usd ? [{ currency: 'USD', amount: Math.round(usd * 100) / 100 }] : [], supplierId)
      // Overdue orders are open issues too, as in the assistant.
      assert.ok(row.openIssues >= row.overduePos, `${supplierId}: ${row.openIssues} issues, ${row.overduePos} overdue`)
    }
    // Some issues are not overdue orders: rejected or unposted receipts, invoice variances.
    assert.ok(Object.values(admin.suppliers).some((row) => row.openIssues > row.overduePos))
    // On time against the original promise, in deliveries, as the scorecard
    // reports it: PO-023, approved and due yesterday, is overdue.
    assert.deepEqual(admin.suppliers[SUP(5)].onTime, { rate: 4 / 7, count: 4, of: 7, sampleStatus: 'ok' })
    assert.equal(admin.suppliers[SUP(1)].onTime.rate, null)
    assert.equal(admin.suppliers[SUP(1)].onTime.sampleStatus, 'insufficient_sample')

    // Suggestions on the walkthrough, as docs/supplier-tiers-design.md section 7 states them.
    assert.deepEqual(tiers(admin), { [SUP(1)]: 1, [SUP(2)]: 2, [SUP(3)]: 2, [SUP(4)]: 3, [SUP(5)]: 1, [SUP(6)]: 1, [SUP(7)]: 2, [SUP(8)]: 3, [SUP(9)]: 3, [SUP(10)]: 3 })
    assert.deepEqual(admin.suppliers[SUP(1)].suggestion, {
      tier: 1,
      partial: false,
      reasons: [
        { code: 'spend_share', share: 0.24, rank: 2, of: 6, basis: 'amount', currency: 'USD' },
        { code: 'sources_not_recorded', skus: ['LDM-001', 'LDM-002', 'LDM-005'], more: 0 },
      ],
    })
    assert.deepEqual(admin.suppliers[SUP(4)].suggestion.reasons, [{ code: 'no_orders' }, { code: 'not_a_source' }])
    assert.deepEqual(admin.suppliers[SUP(7)].suggestion.reasons, [{ code: 'orders', orders: 3 }])

    // A viewer reads orders but not their prices: no spend, and the share is
    // measured in orders.
    const viewer = await read('viewer')
    assert.deepEqual(viewer.visibility, { orders: true, amounts: false, onTime: true, issues: true })
    assert.ok(Object.values(viewer.suppliers).every((row) => row.spend12m === null && row.orders12m !== null))
    const viewerShares = Object.values(viewer.suppliers).flatMap((row) => row.suggestion.reasons.filter((reason) => reason.code === 'spend_share'))
    assert.ok(viewerShares.length > 0 && viewerShares.every((reason) => reason.basis === 'orders' && !reason.currency))
    assert.equal(JSON.stringify(viewer).includes('19120'), false)

    // Finance reads no purchase orders: no order metrics, and the suggestion
    // rests on item sources alone and says so; it never claims "no orders".
    const finance = await read('finance')
    assert.deepEqual(finance.visibility, { orders: false, amounts: false, onTime: false, issues: true })
    assert.ok(Object.values(finance.suppliers).every((row) => row.openPos === null && row.overduePos === null && row.orders12m === null && row.onTime === null && row.suggestion.partial))
    assert.deepEqual(finance.suppliers[SUP(1)].suggestion, { tier: 2, partial: true, reasons: [{ code: 'sources_not_recorded', skus: ['LDM-001', 'LDM-002', 'LDM-005'], more: 0 }] })
    assert.deepEqual(finance.suppliers[SUP(4)].suggestion, { tier: null, partial: true, reasons: [] })

    // Operations reads receipts but not purchase orders.
    const operations = await read('operations')
    assert.deepEqual(operations.visibility, { orders: false, amounts: false, onTime: false, issues: true })

    // One supplier's detail page (T3): its purchase records and open issues,
    // per reader. The issues are what the list counts as "Open issues".
    const activity = (key, supplierId) => service.readActivity({ env, repositories, identity: { authenticated: true, tenantId, userId: `${tenantId}-${key}`, role: people[key], name: `Insights ${key}`, source: 'test-suite' } }, supplierId)
    const acme = await activity('admin', SUP(1))
    assert.deepEqual(acme.visibility, { orders: true, orderAmounts: true, invoices: true, invoiceAmounts: true, issues: true })
    const acmeOrders = purchaseOrders.filter((po) => po.supplierId === SUP(1))
    assert.equal(acme.purchaseOrders.total, acmeOrders.length)
    assert.equal(acme.purchaseOrders.rows.length, Math.min(20, acmeOrders.length))
    const dates = acme.purchaseOrders.rows.map((row) => row.date)
    assert.deepEqual(dates, [...dates].sort().reverse(), 'newest first')
    for (const row of acme.purchaseOrders.rows) {
      assert.equal(row.overdueDays, report.find((po) => po.id === row.id)?.overdueDays || 0, row.id)
      assert.equal(row.amount, Number(acmeOrders.find((po) => po.id === row.id).amount), row.id)
    }
    assert.ok(acme.purchaseOrders.rows.some((row) => row.overdueDays > 0))
    assert.equal(acme.invoices.rows.length, Math.min(20, await prisma.supplierInvoice.count({ where: { tenantId, supplierId: SUP(1) } })))
    for (const [supplierId, row] of Object.entries(admin.suppliers)) assert.equal((await activity('admin', supplierId)).issues.length, row.openIssues, supplierId)
    // The assistant's date order: overdue records first, longest overdue first.
    const overdue = acme.issues.filter((issue) => issue.when.kind === 'overdue')
    assert.deepEqual(acme.issues.slice(0, overdue.length), overdue)
    assert.deepEqual(overdue.map((issue) => issue.when.days), [...overdue.map((issue) => issue.when.days)].sort((a, b) => b - a))
    // A viewer: orders without amounts, and no invoices, which would name the
    // supplier without the partner snapshot.
    const viewerAcme = await activity('viewer', SUP(1))
    assert.deepEqual(viewerAcme.visibility, { orders: true, orderAmounts: false, invoices: false, invoiceAmounts: false, issues: true })
    assert.ok(viewerAcme.purchaseOrders.rows.every((row) => row.amount === null))
    assert.equal(viewerAcme.invoices, null)
    assert.equal(viewerAcme.issues.length, viewer.suppliers[SUP(1)].openIssues)
    // Finance: invoices with amounts, no orders.
    const financeAcme = await activity('finance', SUP(1))
    assert.deepEqual(financeAcme.visibility, { orders: false, orderAmounts: false, invoices: true, invoiceAmounts: true, issues: true })
    assert.equal(financeAcme.purchaseOrders, null)
    assert.ok(financeAcme.invoices.rows.length > 0 && financeAcme.invoices.rows.every((row) => typeof row.amount === 'number'))
    // Operations reads invoices but not the partner snapshot: no invoice list.
    assert.equal((await activity('operations', SUP(1))).invoices, null)
    await assert.rejects(activity('admin', 'LOCAL-DEMO-SUP-404'), (error) => error.status === 404)

    // The route serves the same read to the signed-in user.
    server = createScmServer()
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address()
    assert.equal((await request(port, 'GET', '/api/master-data/supplier-insights')).status, 401)
    const login = await request(port, 'POST', '/api/auth/login', { body: { email: 'viewer-insights@example.com', name: 'Insights viewer', company: 'Supplier Insights Tenant' } })
    assert.equal(login.status, 200, JSON.stringify(login.payload))
    const served = await request(port, 'GET', '/api/master-data/supplier-insights', { headers: { Authorization: `Bearer ${login.payload.token}` } })
    assert.equal(served.status, 200, JSON.stringify(served.payload))
    assert.deepEqual(served.payload.visibility, { orders: true, amounts: false, onTime: true, issues: true })
    assert.equal(Object.keys(served.payload.suppliers).length, 10)
    assert.equal((await request(port, 'GET', `/api/master-data/suppliers/${SUP(1)}/activity`)).status, 401)
    const detail = await request(port, 'GET', `/api/master-data/suppliers/${SUP(1)}/activity`, { headers: { Authorization: `Bearer ${login.payload.token}` } })
    assert.equal(detail.status, 200, JSON.stringify(detail.payload))
    assert.deepEqual(detail.payload.visibility, viewerAcme.visibility)
    assert.equal(detail.payload.purchaseOrders.total, acmeOrders.length)
    assert.equal((await request(port, 'GET', '/api/master-data/suppliers/LOCAL-DEMO-SUP-404/activity', { headers: { Authorization: `Bearer ${login.payload.token}` } })).status, 404)
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve))
    await disconnectPrismaClient()
    await prisma.$disconnect()
  }
})
