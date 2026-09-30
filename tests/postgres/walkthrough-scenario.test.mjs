import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

// The LOCAL-DEMO master data seed reads its tenant when the module loads, so the
// tenant must be chosen before the seed scripts are imported.
const tenantId = 'tenant-walkthrough-scenario'
const timeZone = 'America/New_York'
process.env.FLOWCHAIN_DEFAULT_TENANT_ID = tenantId
const { createPrismaClient } = await import('../../server/persistence/prisma-client.mjs')
const { backfillTenantAuthorization } = await import('../../server/auth/authorization-backfill.mjs')
const { createDatabaseRepositoryRegistry } = await import('../../server/repositories/adapter-registry.mjs')
const { readBusinessContext } = await import('../../server/services/runtime-business-read-service.mjs')
const { buildRuntimeGovernedReport } = await import('../../server/domain/runtime-report-read-model.mjs')
const { seedLocalDemo } = await import('../../scripts/setup-local-demo.mjs')
const { seedLocalScenario } = await import('../../scripts/setup-local-scenario.mjs')
const { buildOpenPurchaseOrdersReport } = await import('../../server/domain/open-purchase-orders-report.mjs')
const { agingBucket, agingDays } = await import('../../server/domain/operational-finance-o2c-read-service.mjs')

// 2026-03-09 is the first weekday after US daylight saving time starts, and the
// scenario's oldest documents fall before the November change, so local dates
// and arrival times are checked across both offsets.
const AS_OF = '2026-03-09'
const DAY = 86_400_000
const asOfNoon = new Date(`${AS_OF}T12:00:00Z`)
const env = { ...process.env, FLOWCHAIN_DEFAULT_TENANT_ID: tenantId }
const prefix = { startsWith: 'LOCAL-DEMO-' }
const countedModels = [
  'purchaseRequest', 'purchaseRequestLine', 'rfq', 'rfqLine', 'rfqSupplierParticipation', 'supplierQuotation', 'supplierQuotationLine',
  'supplierQuotationRevision', 'supplierQuotationRevisionLine', 'purchaseOrder', 'purchaseOrderLine', 'receivingDocument', 'receivingLine',
  'supplierInvoice', 'supplierInvoiceLine', 'inventoryBalance', 'salesOrder', 'salesOrderLine', 'supplier', 'item',
]
const CJK = /[㐀-鿿]/
const shiftDay = (isoDay, days) => new Date(Date.parse(`${isoDay}T12:00:00Z`) + days * DAY).toISOString().slice(0, 10)
const localDay = (instant) => new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(instant)
const localTime = (instant) => new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(instant)
const cents = (value) => Math.round(Number(value) * 100)

async function rowCounts(prisma) {
  const counts = {}
  for (const model of countedModels) counts[model] = await prisma[model].count({ where: { id: prefix } })
  counts.receiptPostingMovements = await prisma.inventoryMovement.count({ where: { tenantId, sourceDocumentId: { startsWith: 'LOCAL-DEMO-GRN-' } } })
  counts.receiptPostingCommands = await prisma.businessCommandExecution.count({ where: { tenantId, commandType: 'receiving.post' } })
  return counts
}

async function scenarioRows(prisma) {
  const [purchaseOrders, receipts, invoices] = await Promise.all([
    prisma.purchaseOrder.findMany({ where: { tenantId, id: { startsWith: 'LOCAL-DEMO-PO-' } }, include: { lines: { orderBy: { id: 'asc' } } }, orderBy: { id: 'asc' } }),
    prisma.receivingDocument.findMany({ where: { tenantId, id: { startsWith: 'LOCAL-DEMO-GRN-' } }, include: { lines: { orderBy: { id: 'asc' } } }, orderBy: { id: 'asc' } }),
    prisma.supplierInvoice.findMany({ where: { tenantId, id: { startsWith: 'LOCAL-DEMO-INV-' } }, include: { lines: { orderBy: { id: 'asc' } } }, orderBy: { id: 'asc' } }),
  ])
  return { purchaseOrders, receipts, invoices }
}

// Everything the scenario decides, without the timestamps the database assigns
// on write, so two seeds for the same day can be compared field by field.
function snapshot(rows) {
  return JSON.parse(JSON.stringify(rows, (key, value) => (key === 'updatedAt' ? undefined : value)))
}

test('the walkthrough scenario gives date-driven views real, relative, idempotent data', async () => {
  // Run only with scripts/run-postgres-test-files.mjs against its disposable database.
  assert.ok(process.env.DATABASE_URL_TEST, 'An isolated test database is required')
  const prisma = await createPrismaClient(env)
  try {
    await prisma.tenant.create({ data: { id: tenantId, name: 'Walkthrough Scenario Tenant', countryCode: 'US', locale: 'en-US', currency: 'USD', timezone: timeZone, defaultLanguage: 'en-US' } })
    await prisma.user.create({ data: { id: `${tenantId}-admin`, tenantId, email: 'walkthrough-admin@example.com', name: 'Walkthrough Admin', role: 'admin' } })
    // What pilot:setup does: provision the workspace roles.
    await backfillTenantAuthorization(prisma, tenantId, { actorId: `${tenantId}-admin` })
    await seedLocalDemo(prisma, env)
    await seedLocalScenario(prisma, env, { asOf: AS_OF })

    const { purchaseOrders, receipts, invoices } = await scenarioRows(prisma)
    const suppliers = new Map((await prisma.supplier.findMany({ where: { tenantId } })).map((row) => [row.id, row]))

    // 25-40 purchase orders across every status, from 4-6 suppliers, in USD.
    assert.ok(purchaseOrders.length >= 25 && purchaseOrders.length <= 40, `expected 25-40 purchase orders, found ${purchaseOrders.length}`)
    assert.deepEqual(
      [...new Set(purchaseOrders.map((po) => po.status))].sort(),
      ['approved', 'cancelled', 'draft', 'fully_received', 'issued', 'partially_received', 'pending_approval'],
    )
    const transactingSuppliers = new Set(purchaseOrders.map((po) => po.supplierId))
    assert.ok(transactingSuppliers.size >= 4 && transactingSuppliers.size <= 6, `expected 4-6 suppliers with transactions, found ${transactingSuppliers.size}`)
    for (const po of purchaseOrders) {
      assert.equal(po.currency, 'USD', po.id)
      assert.equal(po.supplierName, suppliers.get(po.supplierId)?.name, `${po.id} supplier name comes from the LOCAL-DEMO master data`)
      assert.equal(cents(po.amount), po.lines.reduce((sum, line) => sum + cents(line.amount), 0), `${po.id} amount equals its lines`)
    }
    for (const receipt of receipts) assert.ok(transactingSuppliers.has(receipt.supplierId))
    for (const invoice of invoices) assert.ok(transactingSuppliers.has(invoice.supplierId))
    // The local-status endpoint reports the scenario as loaded by this prefix.
    assert.equal(await prisma.purchaseOrder.count({ where: { tenantId, id: { startsWith: 'LOCAL-DEMO-PO-' } } }), purchaseOrders.length)

    // Dates are relative to the seed day: nothing is years away, as the 2030 dates were.
    const dates = [
      ...purchaseOrders.flatMap((po) => [po.createdAt, po.expectedDate, ...po.lines.map((line) => new Date(`${line.metadata.promisedDate}T12:00:00Z`))]),
      ...receipts.flatMap((receipt) => [receipt.arrivedAt, receipt.createdAt]),
      ...invoices.flatMap((invoice) => [invoice.invoiceDate, invoice.dueDate, invoice.createdAt]),
    ]
    for (const date of dates) {
      assert.ok(date instanceof Date && Number.isFinite(date.getTime()), 'every scenario date is set')
      const offset = (date.getTime() - asOfNoon.getTime()) / DAY
      assert.ok(offset > -200 && offset < 60, `${date.toISOString()} is within the walkthrough window around ${AS_OF}`)
    }

    // Overdue purchase orders, by the open purchase orders report definition.
    const report = buildOpenPurchaseOrdersReport(purchaseOrders, {}, asOfNoon)
    assert.ok(report.summary.overdue > 0, 'the walkthrough shows overdue purchase orders')
    assert.ok(report.summary.open > report.summary.overdue, 'some open purchase orders are not yet due')
    const overdueIds = report.rows.filter((row) => row.isOpen && row.overdueDays > 0).map((row) => row.id)
    assert.ok(overdueIds.includes('LOCAL-DEMO-PO-001'))
    for (const po of purchaseOrders.filter((row) => ['draft', 'pending_approval', 'cancelled', 'fully_received'].includes(row.status))) {
      assert.ok(!overdueIds.includes(po.id), `${po.id} (${po.status}) is not overdue`)
    }

    // Receipts have arrival times and cover early, on-time, late and rejected deliveries.
    const poLines = new Map(purchaseOrders.flatMap((po) => po.lines.map((line) => [line.id, { po, line }])))
    const kinds = new Set()
    for (const receipt of receipts) {
      assert.ok(receipt.arrivedAt, `${receipt.id} has an arrival time`)
      assert.ok(localDay(receipt.arrivedAt) <= AS_OF, `${receipt.id} arrived on or before the seed day`)
      const time = localTime(receipt.arrivedAt)
      assert.ok(time >= '07:00' && time <= '17:00', `${receipt.id} arrived during receiving hours in ${timeZone}, not ${time}`)
      for (const line of receipt.lines) {
        const source = poLines.get(line.purchaseOrderLineId)
        assert.ok(source, `${line.id} resolves to a purchase order line`)
        assert.equal(source.po.id, receipt.poId)
        const arrived = localDay(receipt.arrivedAt)
        const promised = source.line.metadata.promisedDate
        kinds.add(arrived < promised ? 'early' : arrived === promised ? 'on_time' : 'late')
        if (Number(line.rejectedQty) > 0) {
          kinds.add('rejected')
          assert.ok(line.metadata?.rejectionReason, `${line.id} records why goods were rejected`)
        }
      }
    }
    assert.deepEqual([...kinds].sort(), ['early', 'late', 'on_time', 'rejected'])
    for (const po of purchaseOrders) {
      for (const line of po.lines) {
        const accepted = receipts.flatMap((receipt) => receipt.lines).filter((entry) => entry.purchaseOrderLineId === line.id).reduce((sum, entry) => sum + Number(entry.acceptedQty), 0)
        assert.equal(Number(line.receivedQuantity), accepted, `${line.id} received quantity equals accepted receipts`)
      }
      if (po.status === 'fully_received') assert.ok(po.lines.every((line) => Number(line.receivedQuantity) === Number(line.orderedQuantity)), po.id)
      if (po.status === 'partially_received') assert.ok(po.lines.some((line) => Number(line.receivedQuantity) > 0 && Number(line.receivedQuantity) < Number(line.orderedQuantity)), po.id)
      if (!['partially_received', 'fully_received'].includes(po.status)) assert.ok(po.lines.every((line) => Number(line.receivedQuantity) === 0), po.id)
    }

    // Receipts are posted through the receiving command service as of their
    // arrival: one receipt movement per receiving line, adding accepted
    // quantities only, and PO received quantities equal to what was posted.
    const movements = await prisma.inventoryMovement.findMany({ where: { tenantId, sourceDocumentId: { startsWith: 'LOCAL-DEMO-GRN-' } } })
    const receivingLines = receipts.flatMap((receipt) => receipt.lines.map((line) => ({ receipt, line })))
    assert.equal(movements.length, receivingLines.length)
    for (const { receipt, line } of receivingLines) {
      assert.equal(receipt.postingStatus, 'posted', `${receipt.id} is posted`)
      assert.equal(receipt.postedAt.toISOString(), receipt.arrivedAt.toISOString(), `${receipt.id} is posted as of its arrival`)
      const movement = movements.find((row) => row.sourceDocumentLineId === line.id)
      assert.equal(movement?.movementType, 'receipt_posting', `${line.id} has a receipt movement`)
      assert.equal(Number(movement.quantityIn), Number(line.acceptedQty), `${line.id} adds only the accepted quantity`)
      assert.equal(movement.occurredAt.toISOString(), receipt.arrivedAt.toISOString())
    }
    for (const po of purchaseOrders) {
      for (const line of po.lines) {
        const posted = movements.filter((row) => row.evidence?.purchaseOrderLineId === line.id).reduce((sum, row) => sum + Number(row.quantityIn), 0)
        assert.equal(Number(line.receivedQuantity), posted, `${line.id} received quantity equals posted movements`)
      }
    }
    // LDM-001: 8 opening pieces plus the 20 accepted on LOCAL-DEMO-GRN-001, still under its reorder point.
    const flowController = await prisma.inventoryBalance.findUnique({ where: { id: 'LOCAL-DEMO-BAL-001' } })
    assert.deepEqual([Number(flowController.onHandQuantity), Number(flowController.reorderPoint)], [28, 40])

    // Supplier invoice due dates fall in at least four aging buckets.
    const buckets = new Set()
    for (const invoice of invoices) {
      assert.ok(invoice.invoiceDate && invoice.dueDate, `${invoice.id} has invoice and due dates`)
      assert.ok(invoice.dueDate >= invoice.invoiceDate, `${invoice.id} is due after it is dated`)
      buckets.add(agingBucket(agingDays(invoice.dueDate, asOfNoon, timeZone)))
    }
    assert.ok(buckets.size >= 4, `expected at least four aging buckets, found ${[...buckets].join(', ')}`)

    // Each stored variance is what a match run computes: the tax-exclusive line
    // amount less the invoiced quantity at the purchase order price.
    for (const invoice of invoices) {
      const expected = invoice.lines.reduce((sum, line) => sum + cents(line.lineAmount) - Math.round(Number(line.quantity) * Number(poLines.get(line.purchaseOrderLineId).line.unitPrice) * 100), 0)
      assert.equal(cents(invoice.varianceAmount), expected, `${invoice.id} variance matches the three-way match formula`)
      assert.equal(cents(invoice.totalAmount), cents(invoice.subtotalAmount) + cents(invoice.enteredTaxAmount), `${invoice.id} total`)
      assert.equal(invoice.currency, 'USD')
    }
    const inv001 = invoices.find((invoice) => invoice.id === 'LOCAL-DEMO-INV-001')
    assert.equal(Number(inv001.varianceAmount), 200)
    assert.equal(Number(inv001.totalAmount), 2381.5)
    assert.equal(inv001.metadata.varianceType, 'price_variance')
    assert.deepEqual(inv001.lines.map((line) => [line.metadata.varianceType, line.metadata.varianceAmount]), [['price_variance', 200]])
    // Invoices are committed ones, as the reports count them: a mix of submitted,
    // matched and approved, with the price variance as the one exception.
    const committed = ['submitted', 'matching', 'exception', 'matched', 'approved', 'held']
    assert.ok(invoices.every((invoice) => committed.includes(invoice.status)), invoices.map((invoice) => invoice.status).join(', '))
    assert.deepEqual([...new Set(invoices.map((invoice) => invoice.status))].sort(), ['approved', 'exception', 'matched', 'submitted'])
    assert.deepEqual(invoices.filter((invoice) => invoice.status === 'exception').map((invoice) => invoice.id), ['LOCAL-DEMO-INV-001'])
    assert.deepEqual(invoices.filter((invoice) => Number(invoice.varianceAmount) !== 0).map((invoice) => invoice.id), ['LOCAL-DEMO-INV-001'])

    // The reports read non-zero USD purchase order spend and invoice totals.
    const context = await readBusinessContext({ repositories: createDatabaseRepositoryRegistry({ env, prisma }), identity: { tenantId } })
    for (const subject of ['overview', 'finance']) {
      const { dataScope } = buildRuntimeGovernedReport(context, { subject })
      assert.deepEqual(dataScope.currencies, ['USD'], `${subject} report currency`)
      assert.ok(dataScope.currencyAmounts[0].amount > 0, `${subject} report amount is not zero`)
    }

    // Stored business values are English codes and names, not Chinese values.
    const stored = JSON.stringify({ purchaseOrders, receipts, invoices, requests: await prisma.purchaseRequest.findMany({ where: { id: prefix }, include: { lines: true } }), salesOrders: await prisma.salesOrder.findMany({ where: { id: prefix }, include: { lines: true } }) })
    assert.doesNotMatch(stored, CJK)

    // Seeding the same day again changes nothing: same counts, same data.
    const firstCounts = await rowCounts(prisma)
    const first = snapshot(await scenarioRows(prisma))
    await seedLocalScenario(prisma, env, { asOf: AS_OF })
    assert.deepEqual(await rowCounts(prisma), firstCounts)
    assert.deepEqual(snapshot(await scenarioRows(prisma)), first)

    // Posted receipts are dated inventory history, so later seeds keep the first
    // seed day: without a day they reuse it, and another day is refused. No
    // receipt is posted twice.
    await seedLocalScenario(prisma, env)
    assert.deepEqual(await rowCounts(prisma), firstCounts)
    assert.deepEqual(snapshot(await scenarioRows(prisma)), first)
    await assert.rejects(seedLocalScenario(prisma, env, { asOf: shiftDay(AS_OF, 7) }), /cannot be re-dated/)
    assert.deepEqual(await rowCounts(prisma), firstCounts)

    // A document changed by a business command (its version moved) is kept as it is.
    await prisma.purchaseOrder.update({ where: { id: 'LOCAL-DEMO-PO-029' }, data: { status: 'cancelled', version: { increment: 1 } } })
    await seedLocalScenario(prisma, env)
    const kept = await prisma.purchaseOrder.findUnique({ where: { id: 'LOCAL-DEMO-PO-029' } })
    assert.equal(kept.status, 'cancelled')
    assert.equal(kept.expectedDate.toISOString(), first.purchaseOrders.find((po) => po.id === 'LOCAL-DEMO-PO-029').expectedDate)
    assert.deepEqual(await rowCounts(prisma), firstCounts)

    // The scenario is USD business data and refuses a workspace in another currency.
    await prisma.tenant.update({ where: { id: tenantId }, data: { currency: 'CNY' } })
    await assert.rejects(seedLocalScenario(prisma, env, { asOf: AS_OF }), /USD/)
    await prisma.tenant.update({ where: { id: tenantId }, data: { currency: 'USD' } })
    await assert.rejects(seedLocalScenario(prisma, env, { asOf: '2026-02-30' }), /as-of/i)

    // The command line accepts the same seed-day override.
    const { stdout } = await promisify(execFile)(process.execPath, ['scripts/setup-local-scenario.mjs', `--as-of=${AS_OF}`], { cwd: new URL('../..', import.meta.url), env })
    assert.match(stdout, new RegExp(`purchaseOrders=${purchaseOrders.length} .*asOf=${AS_OF} timeZone=${timeZone}`))
    assert.deepEqual(await rowCounts(prisma), firstCounts)
  } finally {
    await prisma.$disconnect()
  }
})
