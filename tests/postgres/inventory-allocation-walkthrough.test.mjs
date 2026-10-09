import assert from 'node:assert/strict'
import test from 'node:test'
import { createPrismaClient } from '../../server/persistence/prisma-client.mjs'
import { backfillTenantAuthorization } from '../../server/auth/authorization-backfill.mjs'
import { createDatabaseRepositoryRegistry } from '../../server/repositories/adapter-registry.mjs'
import { readBusinessContext } from '../../server/services/runtime-business-read-service.mjs'
import { buildRuntimeInventoryAllocation, getRuntimeSkuAvailability } from '../../server/domain/runtime-inventory-allocation-read-model.mjs'
import { buildRuntimeGovernedReport } from '../../server/domain/runtime-report-read-model.mjs'
import { seedLocalDemo } from '../../scripts/setup-local-demo.mjs'
import { seedLocalScenario } from '../../scripts/setup-local-scenario.mjs'

// The walkthrough seed scripts write to this tenant.
const tenantId = process.env.FLOWCHAIN_DEFAULT_TENANT_ID || 'tenant-flowchain-local'

async function allocationFor(prisma) {
  const repositories = createDatabaseRepositoryRegistry({ env: process.env, prisma })
  const context = await readBusinessContext({ repositories, identity: { tenantId } })
  return buildRuntimeInventoryAllocation(context)
}

test('walkthrough scenario allocation: per-line demand, partially received POs at their remainder, and item master stock status', async () => {
  // Run only with scripts/run-postgres-test-files.mjs against its disposable server.
  assert.ok(process.env.DATABASE_URL_TEST, 'An isolated test database is required')
  const prisma = await createPrismaClient(process.env)
  try {
    await prisma.tenant.create({ data: { id: tenantId, name: 'Walkthrough workspace' } })
    await prisma.user.create({ data: { id: 'walkthrough-manager', tenantId, email: 'walkthrough-manager@example.com', name: 'Walkthrough Manager', role: 'manager', status: 'active' } })
    // As pilot:setup does: the workspace roles, which the scenario needs to post
    // its receipts. The seed day is pinned so the data is the same on every run.
    await backfillTenantAuthorization(prisma, tenantId, { actorId: 'walkthrough-manager' })
    await seedLocalDemo(prisma)
    await seedLocalScenario(prisma, process.env, { asOf: '2026-09-29' })

    // Stock is opening stock plus the posted walkthrough receipts, nothing reserved.
    // Demand is open sales order lines. In transit is the unreceived remainder of
    // committed POs (approved, issued, partially received); drafts, pending
    // approvals, cancelled and fully received POs are not supply.
    //
    // LDM-001: 8 opening + 20 received on LOCAL-DEMO-GRN-001 = 28 on hand. Demand
    // is the 35 unit LOCAL-DEMO-SO-001. In transit: LOCAL-DEMO-PO-001 partially
    // received, 50 - 20 = 30, plus LOCAL-DEMO-PO-015 issued, 40 = 70 (the ordered
    // quantity would give 90; PO-024 is pending approval). Shortage 35 - 28 = 7,
    // ATP 28 + 70 - 35 = 63.
    const scenario = await allocationFor(prisma)
    const ldm1 = getRuntimeSkuAvailability(scenario, 'LDM-001')
    assert.equal(ldm1.onHand, 28)
    assert.equal(ldm1.openSalesDemand, 35)
    assert.equal(ldm1.incomingApprovedPo, 70)
    assert.equal(ldm1.shortage, 7)
    assert.equal(ldm1.availableToPromise, 63)
    assert.deepEqual(ldm1.purchaseOrderIds.sort(), ['LOCAL-DEMO-PO-001', 'LOCAL-DEMO-PO-015'])
    // LDM-002: 60 opening + 60 (GRN-004) + 30 (GRN-014) = 150 on hand, no demand.
    // In transit: PO-002 issued 40 + PO-014 partially received 80 - 30 = 50 +
    // PO-021 approved 25 = 115. ATP 150 + 115 = 265.
    const ldm2 = getRuntimeSkuAvailability(scenario, 'LDM-002')
    assert.equal(ldm2.onHand, 150)
    assert.equal(ldm2.incomingApprovedPo, 115)
    assert.equal(ldm2.availableToPromise, 265)

    // Item master thresholds are read from the Item columns: LDM-001 has safety
    // stock 30 and reorder point 40, so 28 available is below the safety stock,
    // and the unmet 7 of demand makes the risk high. The other items use 10 / 20.
    assert.equal(ldm1.safetyStock, 30)
    assert.equal(ldm1.reorderPoint, 40)
    assert.equal(ldm1.stockStatus, 'below_safety_stock')
    assert.equal(ldm1.riskLevel, 'high')
    assert.equal(ldm2.safetyStock, 10)
    assert.equal(ldm2.stockStatus, 'ok')
    const report = buildRuntimeGovernedReport(await readBusinessContext({ repositories: createDatabaseRepositoryRegistry({ env: process.env, prisma }), identity: { tenantId } }), { subject: 'inventory' })
    // Every item has posted receipts and no demand except LDM-001. ATP is on hand
    // plus in transit:
    //   LDM-003  950 (400 + 250 + 300 received) + 800 (PO-011 600 - 300, PO-019 300, PO-022 200)       = 1750
    //   LDM-004  19500 (5000 + 8000 + 4000 + 2500) + 20500 (PO-012 10000 - 4000, PO-013 6000 - 2500,
    //            PO-017 4000, PO-020 7000)                                                                = 40000
    //   LDM-005  5800 (2000 + 1500 + Northstar's 1000 + 500 + 800) + 2100 (PO-018 1200, PO-023 900)     = 7900
    //   LDM-006  120 (110 + 10; the 10 rejected on GRN-005 are not stock) + 80 (PO-016)                  = 200
    assert.deepEqual(report.details.filter(row => row.id.startsWith('LDM-00')).map(row => [row.id, row.availableToPromise, row.stockStatus, row.status]).sort(), [
      ['LDM-001', 63, 'below_safety_stock', 'high'],
      ['LDM-002', 265, 'ok', 'low'],
      ['LDM-003', 1750, 'ok', 'low'],
      ['LDM-004', 40000, 'ok', 'low'],
      ['LDM-005', 7900, 'ok', 'low'],
      ['LDM-006', 200, 'ok', 'low'],
    ])

    // A two-line order: its first line is LDM-002, so the order-level summary
    // carries LDM-002 and the 55 unit order total. Each line must be booked on
    // its own SKU.
    await prisma.salesOrder.create({
      data: {
        id: 'WALKTHROUGH-SO-MULTI', tenantId, orderNumber: 'WALKTHROUGH-SO-MULTI', customerId: 'LOCAL-DEMO-CUS-001', customerName: 'Redwood Retail',
        workflowStatus: 'confirmed', reservationStatus: 'not_reserved', fulfillmentStatus: 'not_fulfilled', currency: 'USD',
        lines: { create: [
          { id: 'WALKTHROUGH-SOL-A', itemId: 'LOCAL-DEMO-ITEM-002', sku: 'LDM-002', itemName: 'Temperature Sensor', orderedQuantity: 10, unit: 'pcs', unitPrice: 50, amount: 500 },
          { id: 'WALKTHROUGH-SOL-B', itemId: 'LOCAL-DEMO-ITEM-001', sku: 'LDM-001', itemName: 'Flow Controller', orderedQuantity: 45, unit: 'pcs', unitPrice: 180, amount: 8100 },
        ] },
      },
    })
    const multi = await allocationFor(prisma)
    const orderRow = (await createDatabaseRepositoryRegistry({ env: process.env, prisma }).salesOrders.listOrders({ tenantId }))
      .find(order => order.id === 'WALKTHROUGH-SO-MULTI')
    assert.equal(orderRow.sku, 'LDM-002')
    assert.equal(orderRow.orderedQty, 55)
    // LDM-002 gets only its 10. LDM-001 demand is 35 + 45 = 80, so ATP is
    // 28 + 70 - 80 = 18, at or below the reorder point of 40 as well; booking the
    // whole 55 on LDM-002 would leave LDM-001 at 63.
    assert.equal(getRuntimeSkuAvailability(multi, 'LDM-002').openSalesDemand, 10)
    assert.equal(getRuntimeSkuAvailability(multi, 'LDM-001').openSalesDemand, 80)
    assert.equal(getRuntimeSkuAvailability(multi, 'LDM-001').availableToPromise, 18)
    assert.equal(getRuntimeSkuAvailability(multi, 'LDM-001').shortage, 52)
    assert.deepEqual(getRuntimeSkuAvailability(multi, 'LDM-001').salesOrderIds.sort(), ['LOCAL-DEMO-SO-001', 'WALKTHROUGH-SO-MULTI'])
  } finally {
    await prisma.$disconnect()
  }
})
