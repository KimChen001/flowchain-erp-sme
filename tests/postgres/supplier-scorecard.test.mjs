import assert from 'node:assert/strict'
import test from 'node:test'
import { backfillTenantAuthorization } from '../../server/auth/authorization-backfill.mjs'
import { createDbProcurementCommandService } from '../../server/domain/procurement-db-command-service.mjs'
import { createSupplierScorecardReadService } from '../../server/domain/supplier-scorecard.mjs'
import { createPrismaClient } from '../../server/persistence/prisma-client.mjs'
import { handleReportsAnalyticsRoute } from '../../server/routes/reports-analytics.routes.mjs'

// The supplier scorecard read through GET /api/reports/supplier-scorecard,
// against PostgreSQL: POs issued and revised through the PO commands, posted
// receipts, one tenant's figures never mixed with another's, and each reader
// seeing only what their permissions allow.
// Run with: node scripts/run-postgres-test-files.mjs tests/postgres/supplier-scorecard.test.mjs

const tenantA = 'tenant-scorecard-a'
const tenantB = 'tenant-scorecard-b'
const NOW = new Date('2026-09-30T16:00:00Z')
const users = {
  admin: { id: 'scorecard-admin', tenantId: tenantA, email: 'admin@scorecard.invalid', name: 'Ada Admin', role: 'admin' },
  buyer: { id: 'scorecard-buyer', tenantId: tenantA, email: 'buyer@scorecard.invalid', name: 'Blake Buyer', role: 'buyer' },
  viewer: { id: 'scorecard-viewer', tenantId: tenantA, email: 'viewer@scorecard.invalid', name: 'Vic Viewer', role: 'viewer' },
  finance: { id: 'scorecard-finance', tenantId: tenantA, email: 'finance@scorecard.invalid', name: 'Fin Finance', role: 'finance-specialist' },
  otherAdmin: { id: 'scorecard-admin-b', tenantId: tenantB, email: 'admin@scorecard-b.invalid', name: 'Other Admin', role: 'admin' },
}
const identityOf = (user) => ({ authenticated: true, tenantId: user.tenantId, userId: user.id, role: user.role })
const at = (day, time = '12:00:00') => new Date(`${day}T${time}Z`)

async function scorecard(prisma, user, query = '') {
  let sent
  const ctx = {
    identity: identityOf(user),
    repositories: { supplierScorecard: createSupplierScorecardReadService({ prisma, now: () => NOW }) },
    req: { method: 'GET', headers: {} }, res: {},
    url: new URL(`http://local/api/reports/supplier-scorecard${query}`),
    send: (_res, status, payload) => { sent = { status, payload } },
  }
  assert.equal(await handleReportsAnalyticsRoute(ctx), true)
  return sent
}

// One single-line PO: approved, issued through the PO command (which records the
// original promise), optionally revised, then received by posted receipts.
async function deliveredLine(prisma, service, { tenantId = tenantA, id, supplierId = 'SC-SUP-A', promised, revisedTo, receipts, actor = users.admin }) {
  await prisma.purchaseOrder.create({ data: { id, tenantId, status: 'approved', supplierId, supplierName: 'Scorecard Supplier', currency: 'USD', amount: 500, lines: { create: [{ id: `${id}-L1`, sku: 'SC-SKU', itemName: 'Sensor', orderedQuantity: 10, receivedQuantity: 0, unit: 'pcs', unitPrice: 50, amount: 500, metadata: { promisedDate: promised } }] } } })
  const identity = { identity: identityOf(actor) }
  await service.issuePurchaseOrder(id, { expectedVersion: 0, idempotencyKey: `${id}-issue` }, identity)
  if (revisedTo) await service.revisePromisedDates(id, { expectedVersion: 1, idempotencyKey: `${id}-revise`, lines: [{ purchaseOrderLineId: `${id}-L1`, promisedDate: revisedTo }], reason: 'Supplier moved the ship date' }, identity)
  for (const [index, [day, accepted, rejected = 0]] of receipts.entries()) {
    await prisma.receivingDocument.create({ data: { id: `${id}-GRN-${index + 1}`, tenantId, documentNumber: `${id}-GRN-${index + 1}`, poId: id, supplierId, status: 'received', workflowStatus: 'received', postingStatus: 'posted', postedAt: at(day, '15:00:00'), arrivedAt: at(day, '15:00:00'), currency: 'USD', lines: { create: [{ id: `${id}-GRNL-${index + 1}`, purchaseOrderLineId: `${id}-L1`, sku: 'SC-SKU', acceptedQty: accepted, rejectedQty: rejected, unit: 'pcs' }] } } })
  }
}

test('the supplier scorecard is measured against the original promise, per tenant, with permission checks', async (t) => {
  assert.ok(process.env.DATABASE_URL_TEST, 'An isolated test database is required')
  const prisma = await createPrismaClient(process.env)
  const service = createDbProcurementCommandService({ prisma, env: process.env })
  try {
    for (const tenantId of [tenantA, tenantB]) await prisma.tenant.create({ data: { id: tenantId, name: tenantId, countryCode: 'US', locale: 'en-US', currency: 'USD', timezone: 'America/New_York' } })
    for (const user of Object.values(users)) await prisma.user.create({ data: user })
    await backfillTenantAuthorization(prisma, tenantA, { actorId: users.admin.id })
    await backfillTenantAuthorization(prisma, tenantB, { actorId: users.otherAdmin.id })
    await prisma.supplier.create({ data: { id: 'SC-SUP-A', tenantId: tenantA, code: 'SC-A', name: 'Scorecard Supplier' } })
    await prisma.supplier.create({ data: { id: 'SC-SUP-B', tenantId: tenantB, code: 'SC-B', name: 'Other Supplier' } })

    // Six lines due in September. Two were revised later and delivered on the
    // revised date: late against the original promise, on time against the
    // current date. One lost 2 of its 10 units to rejection and is still open.
    await deliveredLine(prisma, service, { id: 'SC-PO-1', promised: '2026-09-02', receipts: [['2026-09-02', 10]] })
    await deliveredLine(prisma, service, { id: 'SC-PO-2', promised: '2026-09-05', receipts: [['2026-09-01', 10]] })
    await deliveredLine(prisma, service, { id: 'SC-PO-3', promised: '2026-09-08', revisedTo: '2026-09-12', receipts: [['2026-09-12', 10]] })
    await deliveredLine(prisma, service, { id: 'SC-PO-4', promised: '2026-09-10', revisedTo: '2026-09-16', receipts: [['2026-09-15', 10]] })
    await deliveredLine(prisma, service, { id: 'SC-PO-5', promised: '2026-09-14', receipts: [['2026-09-14', 8, 2]] })
    await deliveredLine(prisma, service, { id: 'SC-PO-6', promised: '2026-09-18', receipts: [['2026-09-18', 10]] })
    // A price variance invoice in the period.
    await prisma.supplierInvoice.create({ data: { id: 'SC-INV-1', tenantId: tenantA, invoiceNumber: 'SC-INV-1', supplierId: 'SC-SUP-A', relatedPoId: 'SC-PO-1', invoiceDate: at('2026-09-03'), currency: 'USD', status: 'exception', matchStatus: 'variance', varianceAmount: 15, metadata: { varianceType: 'price_variance' } } })
    // An issued line received before the original promise was kept: counted apart.
    await prisma.purchaseOrder.create({ data: { id: 'SC-PO-LEGACY', tenantId: tenantA, status: 'fully_received', supplierId: 'SC-SUP-A', supplierName: 'Scorecard Supplier', currency: 'USD', expectedDate: at('2026-09-09'), lines: { create: [{ id: 'SC-PO-LEGACY-L1', orderedQuantity: 5, receivedQuantity: 5, unit: 'pcs', metadata: { promisedDate: '2026-09-09' } }] } } })
    await prisma.receivingDocument.create({ data: { id: 'SC-PO-LEGACY-GRN', tenantId: tenantA, poId: 'SC-PO-LEGACY', supplierId: 'SC-SUP-A', postingStatus: 'posted', arrivedAt: at('2026-09-20'), lines: { create: [{ id: 'SC-PO-LEGACY-GRNL', purchaseOrderLineId: 'SC-PO-LEGACY-L1', acceptedQty: 5, rejectedQty: 0 }] } } })
    // Another workspace's late lines, under the same supplier id.
    for (const n of [1, 2, 3, 4, 5]) await deliveredLine(prisma, service, { tenantId: tenantB, id: `SC-B-PO-${n}`, supplierId: 'SC-SUP-A', promised: '2026-09-02', receipts: [['2026-09-25', 10]], actor: users.otherAdmin })

    await t.test('an admin sees both on-time rates, the revisions behind the gap, and the figures in USD', async () => {
      const { status, payload } = await scorecard(prisma, users.admin, '?from=2026-09-01&to=2026-09-30')
      assert.equal(status, 200)
      assert.deepEqual(payload.period, { from: '2026-09-01', to: '2026-09-30' })
      assert.equal(payload.suppliers.length, 1)
      const [supplier] = payload.suppliers
      assert.equal(supplier.supplierName, 'Scorecard Supplier')
      assert.equal(supplier.sampleSize, 6)
      assert.deepEqual([supplier.metrics.onTime.count, Math.round(supplier.metrics.onTime.rate * 1000) / 10], [4, 66.7])
      assert.deepEqual([supplier.metrics.onTimeCurrent.count, Math.round(supplier.metrics.onTimeCurrent.rate * 1000) / 10], [6, 100])
      assert.deepEqual(supplier.lines.filter((line) => line.revised).map((line) => [line.purchaseOrderId, line.originalPromisedDate, line.currentPromisedDate, line.daysLate]), [['SC-PO-3', '2026-09-08', '2026-09-12', 4], ['SC-PO-4', '2026-09-10', '2026-09-16', 5]])
      assert.equal(supplier.metrics.averageDelayDays.value, 4.5)
      // SC-PO-5 is still open 2 short: pending, outside the in-full rate.
      assert.deepEqual([supplier.metrics.early.count, supplier.metrics.inFull.count, supplier.metrics.inFull.of, supplier.inFullPendingCount], [1, 5, 5, 1])
      assert.deepEqual([supplier.metrics.otif.count, supplier.metrics.otifCurrent.count], [3, 5])
      assert.deepEqual([supplier.metrics.rejection.rejectedQuantity, supplier.metrics.rejection.receivedQuantity, supplier.metrics.rejection.unit], [2, 60, 'pcs'])
      assert.deepEqual([supplier.metrics.priceVariances.count, supplier.metrics.priceVariances.amounts], [1, [{ currency: 'USD', amount: 15 }]])
      assert.deepEqual(supplier.orderedValue, [{ currency: 'USD', amount: 3000 }])
      assert.deepEqual([supplier.originalNotRecordedCount, supplier.originalNotRecordedLines[0].purchaseOrderId], [1, 'SC-PO-LEGACY'])
      assert.ok(supplier.metrics.onTime.interval.low < supplier.metrics.onTime.rate && supplier.metrics.onTime.rate < supplier.metrics.onTime.interval.high)
    })

    await t.test('the other workspace sees only its own lines', async () => {
      const { status, payload } = await scorecard(prisma, users.otherAdmin, '?from=2026-09-01&to=2026-09-30')
      assert.equal(status, 200)
      assert.deepEqual(payload.suppliers.map((row) => [row.supplierId, row.sampleSize, row.metrics.onTime.count]), [['SC-SUP-A', 5, 0]])
      assert.ok(payload.suppliers[0].lines.every((line) => line.purchaseOrderId.startsWith('SC-B-')))
      // The supplier filter cannot reach into another workspace.
      const other = await scorecard(prisma, users.otherAdmin, '?supplierId=SC-SUP-B&from=2026-09-01&to=2026-09-30')
      assert.deepEqual(other.payload.suppliers.map((row) => row.sampleSize), [0])
    })

    await t.test('a buyer sees prices but not invoices; a viewer sees neither amounts; finance without PO access is refused', async () => {
      const buyer = (await scorecard(prisma, users.buyer, '?from=2026-09-01&to=2026-09-30')).payload
      assert.deepEqual(buyer.suppliers[0].metrics.priceVariances, { count: null, visible: false, amounts: [] })
      assert.ok(buyer.limitations.includes('price_variances_hidden_by_permission'))
      assert.equal(buyer.suppliers[0].invoices.length, 0)
      assert.deepEqual(buyer.suppliers[0].orderedValue, [{ currency: 'USD', amount: 3000 }])
      const viewer = (await scorecard(prisma, users.viewer, '?from=2026-09-01&to=2026-09-30')).payload
      assert.deepEqual(viewer.suppliers[0].orderedValue, [])
      assert.ok(viewer.suppliers[0].lines.every((line) => line.amount === null))
      assert.equal(viewer.suppliers[0].metrics.priceVariances.count, 1)
      assert.deepEqual(viewer.suppliers[0].metrics.priceVariances.amounts, [])
      assert.equal(viewer.suppliers[0].invoices[0].varianceAmount, null)
      const finance = await scorecard(prisma, users.finance, '?from=2026-09-01&to=2026-09-30')
      assert.equal(finance.status, 403)
    })

    await t.test('a period with fewer than 5 lines shows an insufficient sample and no percentages; bad input is refused', async () => {
      const { payload } = await scorecard(prisma, users.admin, '?from=2026-09-01&to=2026-09-09')
      const [supplier] = payload.suppliers
      assert.deepEqual([supplier.sampleStatus, supplier.sampleSize, supplier.metrics.onTime.rate, supplier.metrics.otif.interval], ['insufficient_sample', 3, null, null])
      assert.equal((await scorecard(prisma, users.admin, '?from=2026-09-30&to=2026-09-01')).status, 422)
      assert.equal((await scorecard(prisma, users.admin, '?graceDays=abc')).status, 422)
      // Grace days widen on time: with 5 days both revised lines are on time.
      const graced = (await scorecard(prisma, users.admin, '?from=2026-09-01&to=2026-09-30&graceDays=5')).payload
      assert.equal(graced.suppliers[0].metrics.onTime.count, 6)
    })
  } finally {
    await prisma.$disconnect()
  }
})
