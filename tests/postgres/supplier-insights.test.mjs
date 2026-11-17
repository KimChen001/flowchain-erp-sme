import { billPaymentStatus } from '../../server/domain/operational-finance-read-service.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'

// Supplier list metrics (docs/supplier-tiers-design.md, T2) on the walkthrough
// scenario, for readers with different access. FlowChain suggests no tier.
const tenantId = 'tenant-supplier-insights'
const timeZone = 'America/New_York'
process.env.FLOWCHAIN_DEFAULT_TENANT_ID = tenantId
const { createPrismaClient, disconnectPrismaClient } = await import('../../server/persistence/prisma-client.mjs')
const { backfillTenantAuthorization } = await import('../../server/auth/authorization-backfill.mjs')
const { createDatabaseRepositoryRegistry } = await import('../../server/repositories/adapter-registry.mjs')
const { createScmServer } = await import('../../server/bootstrap/scm-server.mjs')
const { seedLocalDemo } = await import('../fixtures/workspace/master-data.mjs')
const { seedLocalScenario } = await import('../fixtures/workspace/scenario.mjs')
const { createSupplierInsightsReadService } = await import('../../server/domain/supplier-insights.mjs')
const { buildOpenPurchaseOrdersReport } = await import('../../server/domain/open-purchase-orders-report.mjs')
const { readAiSkillFacts } = await import('../../server/domain/ai-skill-readers.mjs')
const { buildAiSkillSignals } = await import('../../server/domain/ai-skill-signals.mjs')

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

test('supplier metrics agree with the reports, per reader', async () => {
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

    // The administrator sees everything.
    const admin = await read('admin')
    assert.deepEqual(admin.visibility, { orders: true, amounts: true, onTime: true, issues: true })
    assert.equal(admin.asOf, AS_OF)
    const purchaseOrders = await prisma.purchaseOrder.findMany({ where: { tenantId }, include: { lines: true } })
    const report = buildOpenPurchaseOrdersReport(purchaseOrders, { export: 'true' }, asOfNoon, { timeZone }).exportRows
    for (const [supplierId, row] of Object.entries(admin.suppliers)) {
      // Open and overdue orders are the open purchase orders report's, by
      // supplier id; an order approved but not sent to the supplier is open,
      // never overdue against the supplier (design audit V-C-04).
      const open = report.filter((po) => po.supplierId === supplierId && po.isOpen)
      const sent = open.filter((po) => po.status !== 'approved')
      assert.deepEqual([row.openPos, row.overduePos, row.notSentPos], [open.length, sent.filter((po) => po.overdueDays > 0).length, open.length - sent.length], supplierId)
      // Spend: committed orders of the last 12 months, in USD, never other statuses.
      const usd = purchaseOrders.filter((po) => po.supplierId === supplierId && COMMITTED.has(po.status)).reduce((sum, po) => sum + Number(po.amount), 0)
      assert.deepEqual(row.spend12m, usd ? [{ currency: 'USD', amount: Math.round(usd * 100) / 100 }] : [], supplierId)
    }
    // "Open issues" leaves out overdue orders, which "Overdue POs" counts
    // (design audit L9-14): rejected receipts and invoice variances remain.
    assert.ok(Object.values(admin.suppliers).some((row) => row.openIssues > 0))
    // On time against the original promise, in deliveries, as the scorecard
    // reports it: PO-023, approved and due yesterday but never sent to the
    // supplier, is not measured (owner decision 2026-10-06).
    assert.deepEqual(admin.suppliers[SUP(5)].onTime, { rate: 4 / 6, count: 4, of: 6, sampleStatus: 'ok', withheld: 0 })
    // OTIF beside it, from the same scorecard (design audit L9-03).
    assert.equal(admin.suppliers[SUP(5)].otif.sampleStatus, 'ok')
    assert.ok(admin.suppliers[SUP(5)].otif.count <= admin.suppliers[SUP(5)].onTime.count)
    // The report counts PO-023 overdue (decision V5); the supplier pages do
    // not hold it against Northstar, as Today says it was never sent.
    const po23 = report.find((po) => po.id === 'LOCAL-DEMO-PO-023')
    assert.deepEqual([po23.status, po23.isOpen, po23.overdueDays > 0], ['approved', true, true])
    assert.equal(admin.suppliers[SUP(5)].notSentPos, 1)
    assert.equal(admin.suppliers[SUP(1)].onTime.rate, null)
    assert.equal(admin.suppliers[SUP(1)].onTime.sampleStatus, 'insufficient_sample')

    // No tier is suggested to anyone (owner decision 2026-10-09).
    assert.ok(Object.values(admin.suppliers).every((row) => !('suggestion' in row)))

    // A viewer reads orders but not their prices: no spend.
    const viewer = await read('viewer')
    assert.deepEqual(viewer.visibility, { orders: true, amounts: false, onTime: true, issues: true })
    assert.ok(Object.values(viewer.suppliers).every((row) => row.spend12m === null && row.orders12m !== null))
    assert.equal(JSON.stringify(viewer).includes('19120'), false)

    // Finance reads no purchase orders: no order metrics.
    const finance = await read('finance')
    assert.deepEqual(finance.visibility, { orders: false, amounts: false, onTime: false, issues: true })
    assert.ok(Object.values(finance.suppliers).every((row) => row.openPos === null && row.overduePos === null && row.orders12m === null && row.onTime === null))

    // Operations reads receipts but not purchase orders.
    const operations = await read('operations')
    assert.deepEqual(operations.visibility, { orders: false, amounts: false, onTime: false, issues: true })

    // One supplier's detail page (T3): its purchase records and open issues,
    // per reader. The issues are what the list counts in "Open issues", plus
    // the overdue orders it counts in "Overdue POs".
    const listed = (issues) => issues.filter((issue) => issue.type !== 'po_overdue')
    const overdueOrders = (issues) => issues.filter((issue) => issue.type === 'po_overdue')
    const activity = (key, supplierId) => service.readActivity({ env, repositories, identity: { authenticated: true, tenantId, userId: `${tenantId}-${key}`, role: people[key], name: `Insights ${key}`, source: 'test-suite' } }, supplierId)
    const acme = await activity('admin', SUP(1))
    assert.deepEqual(acme.visibility, { orders: true, orderAmounts: true, invoices: true, invoiceAmounts: true, issues: true })
    const acmeOrders = purchaseOrders.filter((po) => po.supplierId === SUP(1))
    assert.equal(acme.purchaseOrders.total, acmeOrders.length)
    assert.equal(acme.purchaseOrders.rows.length, Math.min(20, acmeOrders.length))
    const dates = acme.purchaseOrders.rows.map((row) => row.date)
    assert.deepEqual(dates, [...dates].sort().reverse(), 'newest first')
    for (const row of acme.purchaseOrders.rows) {
      const reported = report.find((po) => po.id === row.id)
      assert.equal(row.notSent, reported?.status === 'approved', row.id)
      assert.equal(row.overdueDays, row.notSent ? 0 : reported?.overdueDays || 0, row.id)
      assert.equal(row.amount, Number(acmeOrders.find((po) => po.id === row.id).amount), row.id)
    }
    assert.ok(acme.purchaseOrders.rows.some((row) => row.overdueDays > 0))
    assert.equal(acme.invoices.rows.length, Math.min(20, await prisma.supplierInvoice.count({ where: { tenantId, supplierId: SUP(1) } })))
    // An approved invoice says where its payment stands, as the invoice list
    // does (design audit U-22): one invoice, approved with a part-paid
    // payable for this check, then put back as it was.
    const approvedInvoice = acme.invoices.rows[0]
    const before = await prisma.supplierInvoice.findUnique({ where: { id: approvedInvoice.id }, select: { status: true, payableObligation: { select: { id: true, status: true } } } })
    await prisma.supplierInvoice.update({ where: { id: approvedInvoice.id }, data: { status: 'approved' } })
    if (before.payableObligation) await prisma.payableObligation.update({ where: { id: before.payableObligation.id }, data: { status: 'partially_settled' } })
    else await prisma.payableObligation.create({ data: { id: `${approvedInvoice.id}-u22`, tenantId, supplierInvoiceId: approvedInvoice.id, obligationNumber: `AP-U22-${approvedInvoice.id}`, originalAmount: '10', outstandingAmount: '5', currency: 'USD', dueDate: new Date('2026-12-01'), status: 'partially_settled' } })
    const paid = await activity('admin', SUP(1))
    assert.equal(paid.invoices.rows.find((row) => row.id === approvedInvoice.id).paymentStatus, 'partially_settled')
    const stored = new Map((await prisma.supplierInvoice.findMany({ where: { tenantId, supplierId: SUP(1) }, select: { id: true, status: true, payableObligation: { select: { status: true } } } })).map((row) => [row.id, billPaymentStatus(row.status, row.payableObligation?.status)]))
    for (const row of paid.invoices.rows) assert.equal(row.paymentStatus, stored.get(row.id), row.id)
    if (before.payableObligation) await prisma.payableObligation.update({ where: { id: before.payableObligation.id }, data: { status: before.payableObligation.status } })
    else await prisma.payableObligation.delete({ where: { id: `${approvedInvoice.id}-u22` } })
    await prisma.supplierInvoice.update({ where: { id: approvedInvoice.id }, data: { status: before.status } })
    for (const [supplierId, row] of Object.entries(admin.suppliers)) {
      const { issues } = await activity('admin', supplierId)
      assert.deepEqual([listed(issues).length, overdueOrders(issues).length], [row.openIssues, row.overduePos], supplierId)
      assert.ok(issues.every((issue) => issue.type !== 'grn_received_unposted'), supplierId)
    }
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
    assert.equal(listed(viewerAcme.issues).length, viewer.suppliers[SUP(1)].openIssues)
    // Finance: invoices with amounts, no orders.
    const financeAcme = await activity('finance', SUP(1))
    assert.deepEqual(financeAcme.visibility, { orders: false, orderAmounts: false, invoices: true, invoiceAmounts: true, issues: true })
    assert.equal(financeAcme.purchaseOrders, null)
    assert.ok(financeAcme.invoices.rows.length > 0 && financeAcme.invoices.rows.every((row) => typeof row.amount === 'number'))
    // Operations reads invoices but not the partner snapshot: no invoice list.
    assert.equal((await activity('operations', SUP(1))).invoices, null)
    await assert.rejects(activity('admin', 'LOCAL-DEMO-SUP-404'), (error) => error.status === 404)

    // Supplier risks: every supplier's open issues on one list, the earliest
    // date first, never by a score; the same issues the list counts, per reader.
    const risks = (key) => service.readRisks({ env, repositories, identity: { authenticated: true, tenantId, userId: `${tenantId}-${key}`, role: people[key], name: `Insights ${key}`, source: 'test-suite' } })
    const totalIssues = (insights) => Object.values(insights.suppliers).reduce((sum, row) => sum + (row.openIssues || 0) + (row.overduePos || 0), 0)
    const adminRisks = await risks('admin')
    assert.deepEqual(adminRisks.visibility, { orders: true, receipts: true, invoices: true, issues: true })
    assert.equal(adminRisks.asOf, AS_OF)
    assert.ok(adminRisks.issues.length > 0)
    assert.equal(adminRisks.issues.length, totalIssues(admin))
    for (const [supplierId, row] of Object.entries(admin.suppliers)) assert.equal(listed(adminRisks.issues.filter((issue) => issue.supplierId === supplierId)).length, row.openIssues, supplierId)
    const dated = adminRisks.issues.filter((issue) => issue.when.date).map((issue) => issue.when.date)
    assert.deepEqual(dated, [...dated].sort(), 'earliest date first')
    assert.ok(adminRisks.issues.slice(dated.length).every((issue) => !issue.when.date), 'undated issues last')
    assert.ok(new Set(adminRisks.issues.map((issue) => issue.type)).size > 1)
    assert.ok(adminRisks.issues.every((issue) => issue.supplierName && issue.supplierCode && issue.label && !('severity' in issue) && !('score' in issue)))
    assert.equal(adminRisks.issues.some((issue) => issue.entityId === 'LOCAL-DEMO-PO-023'), false, 'never sent, so not overdue against the supplier')
    const northstar = await activity('admin', SUP(5))
    assert.equal(northstar.issues.some((issue) => issue.entityId === 'LOCAL-DEMO-PO-023'), false)
    assert.deepEqual(northstar.purchaseOrders.rows.filter((row) => row.id === 'LOCAL-DEMO-PO-023').map((row) => [row.overdueDays, row.notSent]), [[0, true]])
    const overdueRow = adminRisks.issues.find((issue) => issue.type === 'po_overdue')
    assert.equal(overdueRow.when.kind, 'overdue')
    assert.equal(overdueRow.when.days, report.find((po) => po.id === overdueRow.entityId).overdueDays)
    // A viewer sees what their own counts show.
    const viewerRisks = await risks('viewer')
    assert.equal(viewerRisks.issues.length, totalIssues(viewer))
    // Finance reads no purchase orders: no overdue order is listed, and the
    // page is told so rather than showing none.
    const financeRisks = await risks('finance')
    assert.equal(financeRisks.visibility.orders, false)
    assert.ok(financeRisks.issues.every((issue) => issue.type !== 'po_overdue'))
    assert.equal(financeRisks.issues.length, totalIssues(finance))

    // The issues are read from the purchase orders, receipts and supplier
    // invoices alone (readAiSkillSupplierIssueFacts). Read as before
    // 2026-11-08, over the assistant's full facts with every sales order and
    // stock row, every page is the same for every reader and supplier.
    const fullFacts = createSupplierInsightsReadService({ prisma, listPurchaseOrders: repositories.procurementRuntime.listForReport, now: () => asOfNoon, readIssueSignals: (skillContext) => readAiSkillFacts(skillContext).then(buildAiSkillSignals) })
    const supplierIds = (await prisma.supplier.findMany({ where: { tenantId }, select: { id: true } })).map((row) => row.id)
    for (const key of Object.keys(people)) {
      const ctx = { env, repositories, identity: { authenticated: true, tenantId, userId: `${tenantId}-${key}`, role: people[key], name: `Insights ${key}`, source: 'test-suite' } }
      assert.deepEqual(await service.read(ctx), await fullFacts.read(ctx), key)
      assert.deepEqual(await service.readRisks(ctx), await fullFacts.readRisks(ctx), key)
      for (const supplierId of supplierIds) assert.deepEqual(await service.readActivity(ctx, supplierId), await fullFacts.readActivity(ctx, supplierId), `${key} ${supplierId}`)
    }

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
    assert.equal((await request(port, 'GET', '/api/master-data/supplier-risks')).status, 401)
    const servedRisks = await request(port, 'GET', '/api/master-data/supplier-risks', { headers: { Authorization: `Bearer ${login.payload.token}` } })
    assert.equal(servedRisks.status, 200, JSON.stringify(servedRisks.payload))
    // The route reads as of today, not the scenario day: its access, not its rows, is compared.
    assert.deepEqual(servedRisks.payload.visibility, viewerRisks.visibility)
    assert.ok(Array.isArray(servedRisks.payload.issues))
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve))
    await disconnectPrismaClient()
    await prisma.$disconnect()
  }
})
