import assert from 'node:assert/strict'
import test from 'node:test'
import { createPrismaClient } from '../../server/persistence/prisma-client.mjs'
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
    await seedLocalDemo(prisma)
    await seedLocalScenario(prisma)

    // 8 on hand, the 35 unit LOCAL-DEMO-SO-001, and LOCAL-DEMO-PO-001 partially
    // received (20 of 50): 8 + 30 - 35 = +3. The ordered quantity would give -27
    // and skipping the partially received PO gave the same -27.
    const scenario = await allocationFor(prisma)
    const ldm1 = getRuntimeSkuAvailability(scenario, 'LDM-001')
    assert.equal(ldm1.onHand, 8)
    assert.equal(ldm1.openSalesDemand, 35)
    assert.equal(ldm1.incomingApprovedPo, 30)
    assert.equal(ldm1.shortage, 27)
    assert.equal(ldm1.availableToPromise, 3)
    assert.deepEqual(ldm1.purchaseOrderIds, ['LOCAL-DEMO-PO-001'])
    const ldm2 = getRuntimeSkuAvailability(scenario, 'LDM-002')
    assert.equal(ldm2.incomingApprovedPo, 40)
    assert.equal(ldm2.availableToPromise, 100)

    // Item master thresholds (safety stock 10, reorder point 20) are read from
    // the Item columns: 8 available is below the safety stock.
    assert.equal(ldm1.safetyStock, 10)
    assert.equal(ldm1.reorderPoint, 20)
    assert.equal(ldm1.stockStatus, 'below_safety_stock')
    assert.equal(ldm1.riskLevel, 'high')
    assert.equal(ldm2.stockStatus, 'ok')
    const report = buildRuntimeGovernedReport(await readBusinessContext({ repositories: createDatabaseRepositoryRegistry({ env: process.env, prisma }), identity: { tenantId } }), { subject: 'inventory' })
    // LDM-003 to LDM-006 are in the item master with no stock: out of stock,
    // medium risk (no open demand), where they previously showed as low.
    assert.deepEqual(report.details.filter(row => row.sku.startsWith('LDM-00')).map(row => [row.sku, row.availableToPromise, row.stockStatus, row.status]).sort(), [
      ['LDM-001', 3, 'below_safety_stock', 'high'],
      ['LDM-002', 100, 'ok', 'low'],
      ...['LDM-003', 'LDM-004', 'LDM-005', 'LDM-006'].map(sku => [sku, 0, 'out_of_stock', 'medium']),
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
    assert.equal(getRuntimeSkuAvailability(multi, 'LDM-002').openSalesDemand, 10)
    assert.equal(getRuntimeSkuAvailability(multi, 'LDM-001').openSalesDemand, 80)
    assert.equal(getRuntimeSkuAvailability(multi, 'LDM-001').availableToPromise, -42)
    assert.deepEqual(getRuntimeSkuAvailability(multi, 'LDM-001').salesOrderIds.sort(), ['LOCAL-DEMO-SO-001', 'WALKTHROUGH-SO-MULTI'])
  } finally {
    await prisma.$disconnect()
  }
})
