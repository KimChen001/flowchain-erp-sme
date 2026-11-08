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
const { seedLocalDemo } = await import('../fixtures/workspace/master-data.mjs')
const { seedLocalScenario } = await import('../fixtures/workspace/scenario.mjs')
const { buildOpenPurchaseOrdersReport } = await import('../../server/domain/open-purchase-orders-report.mjs')
const { agingBucket, agingDays } = await import('../../server/domain/operational-finance-o2c-read-service.mjs')
const { createSupplierScorecardReadService } = await import('../../server/domain/supplier-scorecard.mjs')
const { buildRuntimeInventoryAllocation } = await import('../../server/domain/runtime-inventory-allocation-read-model.mjs')
const { createReorderListReadService } = await import('../../server/domain/reorder-list-read-service.mjs')
const { ITEM_SUPPLIER_NAMESPACE } = await import('../../server/domain/master-data-commands.mjs')
const { readReplenishmentInputs } = await import('../../scripts/export-replenishment-inputs.mjs')

// 2026-03-09 is the first weekday after US daylight saving time starts, and the
// scenario's oldest documents fall before the November change, so local dates
// and arrival times are checked across both offsets.
const AS_OF = '2026-03-09'
const DAY = 86_400_000
const asOfNoon = new Date(`${AS_OF}T12:00:00Z`)
// Contracts stay off until the contracts check at the end turns them on.
const env = { ...process.env, FLOWCHAIN_DEFAULT_TENANT_ID: tenantId, FLOWCHAIN_ENABLE_CONTRACTS: 'false' }
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
  counts.promiseRevisions = await prisma.purchaseOrderPromiseRevision.count({ where: { tenantId } })
  counts.shipments = await prisma.shipmentDocument.count({ where: { tenantId } })
  counts.reservations = await prisma.inventoryReservation.count({ where: { tenantId } })
  counts.movements = await prisma.inventoryMovement.count({ where: { tenantId } })
  counts.adjustments = await prisma.inventoryAdjustmentDocument.count({ where: { tenantId } })
  counts.itemSupplierLinks = await prisma.runtimeRecord.count({ where: { tenantId, namespace: ITEM_SUPPLIER_NAMESPACE } })
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
    // TST-001: 8 opening pieces plus the 20 accepted on LOCAL-DEMO-GRN-001, still under its reorder point.
    const flowController = await prisma.inventoryBalance.findUnique({ where: { id: 'LOCAL-DEMO-BAL-001' } })
    assert.deepEqual([Number(flowController.onHandQuantity), Number(flowController.reorderPoint)], [28, 40])

    // The shipment history: 60 customer orders, one on each weekday of the 12
    // weeks before the seed day, each shipped in full on its order day through
    // the outbound commands. Nothing ships before day -84, so the reorder
    // list's 90 days still hold all of it six days after seeding.
    const history = await prisma.salesOrder.findMany({ where: { tenantId, id: { startsWith: 'LOCAL-DEMO-SO-1' } }, include: { lines: true, shipments: { include: { lines: true } } }, orderBy: { id: 'asc' } })
    assert.equal(history.length, 60)
    assert.deepEqual([...new Set(history.map((order) => order.customerName))].sort(), ['Bluebird Distribution', 'Metro Service Group', 'Redwood Retail'])
    for (const order of history) {
      assert.deepEqual([order.workflowStatus, order.reservationStatus, order.fulfillmentStatus, order.currency, order.metadata.historyRandomSeed], ['confirmed', 'not_reserved', 'fully_fulfilled', 'USD', 20261103], order.id)
      assert.equal(order.shipments.length, 1, order.id)
      const [shipment] = order.shipments
      const shipped = localDay(shipment.postedAt)
      assert.equal(shipment.postingStatus, 'posted')
      assert.equal(shipped, localDay(order.createdAt), `${order.id} ships on its order day`)
      assert.ok(shipment.postedAt > order.createdAt, `${order.id} ships after it is ordered`)
      const offset = (Date.parse(`${shipped}T12:00:00Z`) - asOfNoon.getTime()) / DAY
      assert.ok(offset >= -84 && offset <= -1, `${order.id} shipped ${offset} days from the seed day`)
      assert.ok(![0, 6].includes(new Date(`${shipped}T12:00:00Z`).getUTCDay()), `${order.id} ships on a weekday`)
      for (const line of order.lines) {
        assert.equal(Number(line.fulfilledQuantity), Number(line.orderedQuantity), line.id)
        assert.equal(Number(line.reservedQuantity), 0, line.id)
      }
    }
    assert.equal(new Set(history.map((order) => localDay(order.shipments[0].postedAt))).size, 60, 'one order a weekday')
    // The open demand is still LOCAL-DEMO-SO-001 alone.
    assert.deepEqual((await prisma.salesOrder.findMany({ where: { tenantId, fulfillmentStatus: { not: 'fully_fulfilled' } }, select: { id: true } })).map((row) => row.id), ['LOCAL-DEMO-SO-001'])

    // One stock record per item, whose safety stock and reorder point are the
    // item's, in its columns and its metadata alike.
    const items = await prisma.item.findMany({ where: { tenantId }, orderBy: { sku: 'asc' } })
    const records = await prisma.inventoryBalance.findMany({ where: { tenantId }, orderBy: { sku: 'asc' } })
    assert.deepEqual(records.map((row) => [row.id, row.sku, row.locationKey]), items.map((item, index) => [`LOCAL-DEMO-BAL-00${index + 1}`, item.sku, 'a-01']))
    for (const [index, item] of items.entries()) {
      const thresholds = [Number(item.safetyStock), Number(item.reorderPoint)]
      assert.deepEqual([Number(records[index].safetyStock), Number(records[index].reorderPoint)], thresholds, item.sku)
      assert.deepEqual([item.metadata.safetyStock, item.metadata.reorderPoint], thresholds, item.sku)
    }

    // Stock starts with one opening stock entry on the day the workspace went
    // live, before every receipt and shipment. Played forward in time, each
    // item's movements never take its stock below zero and end at its stock
    // record's on-hand quantity.
    const [opening] = await prisma.inventoryAdjustmentDocument.findMany({ where: { tenantId }, include: { lines: true } })
    assert.deepEqual([opening.adjustmentNumber, opening.reasonCode, opening.workflowStatus, opening.postingStatus, opening.lines.length], ['ADJ-202509-0001', 'opening_balance', 'ready', 'posted', 6], 'the server numbers the opening stock entry in the month it was counted (160 days before the seed day)')
    const ledger = await prisma.inventoryMovement.findMany({ where: { tenantId }, orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }] })
    assert.ok(ledger[0].occurredAt < receipts.map((receipt) => receipt.arrivedAt).sort((a, b) => a - b)[0], 'opening stock comes first')
    for (const record of records) {
      let stock = 0
      for (const movement of ledger.filter((row) => row.sku === record.sku)) {
        stock += Number(movement.quantityIn) - Number(movement.quantityOut)
        assert.ok(stock >= 0, `${record.sku} is ${stock} after ${movement.movementType} ${movement.sourceDocument || movement.sourceDocumentId} on ${movement.occurredAt.toISOString()}`)
      }
      assert.equal(stock, Number(record.onHandQuantity), `${record.sku} movements add up to its on-hand quantity`)
    }

    // The reorder list as of the seed day has demand for every item: at least
    // 8 shipment days in its 90, each item's shipped quantity over the
    // window's posted shipments, and an order-by day. Every open purchase
    // order line counts, late or not. TST-002 comes first: 150 on hand plus
    // PO-014's 50 still to come (six days late), PO-002's 40 (due in 4 days)
    // and PO-021's 25 (in 14) is 265, below its reorder point of 270, so it is
    // ordered now, and the 5 short are raised to Acme's minimum of 50.
    const businessContext = await readBusinessContext({ repositories: createDatabaseRepositoryRegistry({ env, prisma }), identity: { tenantId } })
    const allocationRows = buildRuntimeInventoryAllocation(businessContext).availability
    const reorder = await createReorderListReadService({ prisma }).read({ tenantId, today: AS_OF, timeZone, allocationRows })
    assert.deepEqual(reorder.rows.map((row) => row.sku), ['TST-002', 'TST-001', 'TST-006', 'TST-005', 'TST-003', 'TST-004'])
    const shipmentLines = history.flatMap((order) => order.shipments.flatMap((shipment) => shipment.lines.map((line) => ({ ...line, day: localDay(shipment.postedAt) }))))
      .filter((line) => line.day >= shiftDay(AS_OF, -90) && line.day <= shiftDay(AS_OF, -1))
    for (const row of reorder.rows) {
      const lines = shipmentLines.filter((line) => line.sku === row.sku)
      assert.equal(row.demand.enough, true, row.sku)
      assert.ok(row.demand.shipmentDays >= 8, `${row.sku} has ${row.demand.shipmentDays} shipment days`)
      assert.equal(row.demand.shipmentDays, new Set(lines.map((line) => line.day)).size, row.sku)
      assert.equal(row.demand.shippedQuantity, lines.reduce((sum, line) => sum + Number(line.postedQuantity), 0), row.sku)
      assert.equal(row.orderNow, row.sku === 'TST-002', `${row.sku} is ordered by ${row.orderByDate}`)
    }
    const sensor = reorder.rows[0]
    assert.deepEqual([sensor.onHand, sensor.incoming, sensor.position, sensor.reorderPoint, sensor.shortfall, sensor.purchaseRequest.quantity, sensor.purchaseRequest.raisedToMinimum], [150, 115, 265, 270, 5, 50, true])
    assert.deepEqual(sensor.incomingLines.map((line) => [line.orderNumber, line.remaining, line.late]).sort(), [['LOCAL-DEMO-PO-002', 40, false], ['LOCAL-DEMO-PO-014', 50, true], ['LOCAL-DEMO-PO-021', 25, false]])
    // Late lines still count, and are flagged for the buyer to confirm with
    // the supplier: PO-014 for the sensor, Acme's PO-001 and PO-015 for the
    // Flow Controller, which stays below its safety stock on hand.
    const lateOrders = (row) => row.flags.filter((flag) => flag.code === 'po_line_late').map((flag) => flag.orderNumber).sort()
    assert.deepEqual(lateOrders(sensor), ['LOCAL-DEMO-PO-014'])
    const controller = reorder.rows[1]
    assert.deepEqual([controller.sku, controller.onHand, controller.incoming, controller.position, controller.orderNow, controller.daysUntilOrderBy], ['TST-001', 28, 70, 98, false, 11])
    assert.deepEqual(lateOrders(controller), ['LOCAL-DEMO-PO-001', 'LOCAL-DEMO-PO-015'])
    assert.ok(reorder.rows.every((row) => row.incoming === row.incomingLines.reduce((sum, line) => sum + line.remaining, 0)), 'every open line counts')
    // The walkthrough is reseeded before it is shown, and the same holds
    // while the list is read up to six days later: every shipment is still in
    // the window, and TST-002 is still ordered now, 5 short with its request
    // raised to the minimum (PO-002 is late from the fifth day, and counts).
    for (let daysLater = 1; daysLater <= 6; daysLater += 1) {
      const later = await createReorderListReadService({ prisma }).read({ tenantId, today: shiftDay(AS_OF, daysLater), timeZone, allocationRows })
      const row = later.rows.find((entry) => entry.sku === 'TST-002')
      assert.equal(later.rows[0].sku, 'TST-002', `${daysLater} days later`)
      assert.deepEqual([row.orderNow, row.position, row.shortfall, row.purchaseRequest.quantity, row.purchaseRequest.raisedToMinimum], [true, 265, 5, 50, true], `${daysLater} days later`)
      assert.deepEqual(lateOrders(row), daysLater > 4 ? ['LOCAL-DEMO-PO-002', 'LOCAL-DEMO-PO-014'] : ['LOCAL-DEMO-PO-014'], `${daysLater} days later`)
      assert.deepEqual(later.rows.map((entry) => entry.demand.shippedQuantity), later.rows.map((entry) => reorder.rows.find((first) => first.sku === entry.sku).demand.shippedQuantity), `${daysLater} days later`)
    }
    // The preferred sources' recorded terms reach the list.
    assert.deepEqual(reorder.rows.map((row) => [row.sku, row.supplier?.name, row.supplier?.leadTimeDays, row.supplier?.minimumOrderQuantity]).sort(), [
      ['TST-001', 'Acme Components', 14, 25],
      ['TST-002', 'Acme Components', 17, 50],
      ['TST-003', 'Summit Packaging', 12, 100],
      ['TST-004', 'Atlas Industrial Supply', 14, 2000],
      ['TST-005', 'Acme Components', 10, 500],
      ['TST-006', 'Summit Packaging', 10, 50],
    ])

    // The replenishment export reads the same figures, in a read-only
    // transaction: 90 daily shipped quantities that add up to the reorder
    // list's, stock, open purchase order lines, thresholds, terms and the
    // list's own request quantity, with the seed day and the random seed.
    const countsBeforeExport = await rowCounts(prisma)
    const inputs = await readReplenishmentInputs(prisma, { tenantId, asOf: AS_OF, env })
    assert.deepEqual(await rowCounts(prisma), countsBeforeExport)
    assert.equal(inputs.today, AS_OF)
    assert.deepEqual(inputs.scenario, { seedDay: AS_OF, version: 8, historyRandomSeed: 20261103 })
    assert.deepEqual(inputs.items.map((item) => item.sku), ['TST-001', 'TST-002', 'TST-003', 'TST-004', 'TST-005', 'TST-006'])
    for (const item of inputs.items) {
      const row = reorder.rows.find((entry) => entry.sku === item.sku)
      assert.equal(item.dailyShipped.length, 90)
      assert.deepEqual([item.dailyShipped[0].day, item.dailyShipped[89].day], [shiftDay(AS_OF, -90), shiftDay(AS_OF, -1)])
      assert.deepEqual([item.demand.shippedQuantity, item.demand.shipmentDays, item.demand.averageDailyDemand], [row.demand.shippedQuantity, row.demand.shipmentDays, row.demand.averageDailyDemand], item.sku)
      assert.equal(item.openPurchaseOrderQuantity, row.incomingLines.reduce((sum, line) => sum + line.remaining, 0), item.sku)
      assert.deepEqual(item.openPurchaseOrderLines.map((line) => [line.countedInPosition, line.late]), row.incomingLines.map((line) => [true, line.late]), item.sku)
      assert.ok(item.openPurchaseOrderLines.every((line) => line.unitPrice > 0 && line.dueDay), item.sku)
      assert.deepEqual([item.onHand, item.reserved, item.reorderList.orderByDate, item.preferredSupplier.minimumOrderQuantity], [row.onHand, row.reserved, row.orderByDate, row.supplier.minimumOrderQuantity], item.sku)
      assert.equal(item.reorderList.qRule, item.sku === 'TST-002' ? 50 : 0, item.sku)
      assert.ok(item.lastPurchasePrice.unitPrice > 0 && item.preferredSupplier.referencePrice > 0, item.sku)
      // The suggested reorder point: the export's is the reorder list's, and
      // both are the 75th smallest of the 90 circular sums of (lead time + 7)
      // days of the exported daily series, rounded up.
      const cover = item.preferredSupplier.leadTimeDays + 7
      const shipped = item.dailyShipped.map((day) => day.quantity)
      const sums = shipped.map((_, start) => Array.from({ length: cover }, (__, offset) => shipped[(start + offset) % 90]).reduce((sum, value) => sum + value, 0)).sort((x, y) => x - y)
      assert.deepEqual([item.suggestedReorderPoint, item.reorderPointSuggestion.coverDays, item.reorderPointSuggestion.reason], [Math.ceil(sums[74]), cover, null], item.sku)
      assert.equal(row.reorderPointSuggestion.suggestedReorderPoint, item.suggestedReorderPoint, item.sku)
    }
    assert.deepEqual(Object.fromEntries(inputs.items.map((item) => [item.sku, [item.reorderPoint, item.safetyStock]])), Object.fromEntries(items.map((item) => [item.sku, [Number(item.reorderPoint), Number(item.safetyStock)]])))
    const exportedFlowController = inputs.items[0]
    assert.deepEqual([exportedFlowController.onHand, exportedFlowController.openPurchaseOrderQuantity, exportedFlowController.reorderPoint, exportedFlowController.safetyStock, exportedFlowController.preferredSupplier.leadTimeDays], [28, 70, 40, 30, 14])
    // Demand shapes over the weekdays (average interval between shipment days,
    // squared variation of the quantities): TST-002 smooth, TST-004 lumpy,
    // TST-006 intermittent.
    const shape = (sku) => inputs.items.find((item) => item.sku === sku).demand
    assert.ok(shape('TST-002').averageIntervalWeekdays < 1.32 && shape('TST-002').squaredVariation < 0.49, JSON.stringify(shape('TST-002')))
    assert.ok(shape('TST-004').averageIntervalWeekdays >= 1.32 && shape('TST-004').squaredVariation >= 0.49, JSON.stringify(shape('TST-004')))
    assert.ok(shape('TST-006').averageIntervalWeekdays >= 1.32 && shape('TST-006').squaredVariation < 0.49, JSON.stringify(shape('TST-006')))

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

    // Committed orders (approved, issued or received) keep their first promised
    // date, as the approve and issue commands record it, and so do cancelled
    // orders that were sent first; drafts, pending approvals and orders
    // cancelled before they were sent have none. Issued orders also keep their
    // issue date, on their order day; orders never issued have none.
    for (const po of purchaseOrders) {
      const committed = ['approved', 'issued', 'partially_received', 'fully_received'].includes(po.status) || po.metadata.transmissionStatus === 'sent'
      const issued = ['issued', 'partially_received', 'fully_received'].includes(po.status) || po.metadata.transmissionStatus === 'sent'
      for (const line of po.lines) assert.equal(Boolean(line.originalPromisedDate), committed, `${line.id} original promise`)
      assert.equal(Boolean(po.issuedAt), issued, `${po.id} issue date`)
      if (issued) {
        assert.equal(po.metadata.issuedAt, po.issuedAt.toISOString(), `${po.id} issue date in metadata`)
        assert.ok(po.issuedAt > po.createdAt, `${po.id} issued after it was created`)
      }
    }
    // Two Northstar orders were re-promised after issue, with a reason, and
    // delivered on the new date. Its scorecard is late against the original
    // promise and on time against the current date. PO-023, approved and
    // promised for yesterday, was never sent to the supplier and has nothing
    // received: outside every figure, listed as not sent (owner decision
    // 2026-10-06). Six deliveries of one PO line each: on time 4 of 6 against
    // 6 of 6, OTIF 3 of 6 against 5 of 6.
    const revisions = await prisma.purchaseOrderPromiseRevision.findMany({ where: { tenantId }, orderBy: { id: 'asc' } })
    assert.deepEqual(revisions.map((row) => [row.purchaseOrderId, row.previousDate.toISOString().slice(0, 10), row.newDate.toISOString().slice(0, 10), Boolean(row.reason)]), [
      ['LOCAL-DEMO-PO-033', shiftDay(AS_OF, -45), shiftDay(AS_OF, -40), true],
      ['LOCAL-DEMO-PO-034', shiftDay(AS_OF, -34), shiftDay(AS_OF, -30), true],
    ])
    assert.equal(await prisma.auditLog.count({ where: { tenantId, action: 'purchase_order_promise_revised' } }), 2)
    const scorecard = await createSupplierScorecardReadService({ prisma, now: () => new Date(`${AS_OF}T17:00:00Z`) }).read({}, { identity: { authenticated: true, tenantId, userId: `${tenantId}-admin`, role: 'admin' } })
    const northstar = scorecard.suppliers.find((row) => row.supplierId === 'LOCAL-DEMO-SUP-005')
    assert.equal(northstar.sampleStatus, 'ok')
    assert.deepEqual([northstar.metrics.onTime.count, northstar.metrics.onTimeCurrent.count, northstar.sampleSize, northstar.lineCount], [4, 6, 6, 6])
    assert.deepEqual([northstar.metrics.otif.count, northstar.metrics.otifCurrent.count], [3, 5])
    assert.equal(northstar.overdueUndeliveredCount, 0)
    assert.ok(northstar.obligations.every((row) => row.purchaseOrderId !== 'LOCAL-DEMO-PO-023'))
    assert.deepEqual([northstar.notSentCount, northstar.notSentPurchaseOrders.map((row) => [row.purchaseOrderId, row.status])], [1, [['LOCAL-DEMO-PO-023', 'approved']]])
    assert.ok(northstar.metrics.onTime.rate < northstar.metrics.onTimeCurrent.rate)
    // The other approved orders are promised after today, outside the 90 days:
    // no supplier lists one as not sent.
    assert.deepEqual(scorecard.suppliers.filter((row) => row.notSentCount).map((row) => row.supplierId), ['LOCAL-DEMO-SUP-005'])

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
    const { stdout } = await promisify(execFile)(process.execPath, ['tests/fixtures/workspace/scenario.mjs', `--as-of=${AS_OF}`], { cwd: new URL('../..', import.meta.url), env })
    assert.match(stdout, new RegExp(`purchaseOrders=${purchaseOrders.length} .*asOf=${AS_OF} timeZone=${timeZone}`))
    assert.deepEqual(await rowCounts(prisma), firstCounts)

    // Contracts are seeded only with the contracts capability on, dated from
    // the same seed day: one ending soon, one with notice due, one in force.
    assert.equal(await prisma.contract.count({ where: { tenantId } }), 0)
    const contractsEnv = { ...env, FLOWCHAIN_ENABLE_CONTRACTS: 'true' }
    assert.equal((await seedLocalScenario(prisma, contractsEnv)).contracts, 3)
    const contracts = await prisma.contract.findMany({ where: { tenantId }, include: { supplier: true }, orderBy: { id: 'asc' } })
    assert.deepEqual(contracts.map((row) => [row.id, row.number, row.supplier.name, row.type, row.status, row.version]), [
      ['LOCAL-DEMO-CT-001', 'CT-DE000001', 'Acme Components', 'purchase_agreement', 'active', 2],
      ['LOCAL-DEMO-CT-002', 'CT-DE000002', 'Horizon Logistics', 'service_agreement', 'active', 2],
      ['LOCAL-DEMO-CT-003', 'CT-DE000003', 'Northstar Electronics', 'quality_agreement', 'active', 2],
    ])
    const { contractShownState } = await import('../../shared/contract-status.mjs')
    const shown = contracts.map((row) => contractShownState(row, { today: AS_OF }))
    assert.deepEqual(shown.map((view) => [view.state, view.daysUntilKeyDate]), [['ending', 45], ['notice_due', 20], ['active', 300]])
    assert.equal(contracts[2].endDate.toISOString().slice(0, 10), shiftDay(AS_OF, 300))
    // The owner is the supplier's business owner; Horizon has none.
    assert.deepEqual(contracts.map((row) => row.ownerId), contracts.map((row) => row.supplier.businessOwnerId))
    assert.ok(contracts[0].ownerId)
    assert.equal(contracts[1].ownerId, null)
    assert.equal(await prisma.auditLog.count({ where: { tenantId, entityType: 'Contract' } }), 6)
    assert.doesNotMatch(JSON.stringify(contracts), CJK)
    // A re-seed adds nothing and changes nothing.
    const contractRows = () => prisma.contract.findMany({ where: { tenantId }, orderBy: { id: 'asc' } })
    const before = JSON.stringify(await contractRows())
    await seedLocalScenario(prisma, contractsEnv)
    assert.equal(JSON.stringify(await contractRows()), before)
    assert.equal(await prisma.auditLog.count({ where: { tenantId, entityType: 'Contract' } }), 6)
  } finally {
    await prisma.$disconnect()
  }
})
