import test from 'node:test'
import assert from 'node:assert/strict'

// A walkthrough seed that stops part way, and history a person changes after
// seeding. The LOCAL-DEMO master data seed reads its tenant when the module
// loads, so the tenant must be chosen before the seed scripts are imported.
const tenantId = 'tenant-walkthrough-scenario-resume'
process.env.FLOWCHAIN_DEFAULT_TENANT_ID = tenantId
const { createPrismaClient } = await import('../../server/persistence/prisma-client.mjs')
const { backfillTenantAuthorization } = await import('../../server/auth/authorization-backfill.mjs')
const { seedLocalDemo } = await import('../fixtures/workspace/master-data.mjs')
const { seedLocalScenario } = await import('../fixtures/workspace/scenario.mjs')
const { createOutboundPostingCommandService } = await import('../../server/domain/outbound-posting-command-service.mjs')

const AS_OF = '2026-10-20'
const env = { ...process.env, FLOWCHAIN_DEFAULT_TENANT_ID: tenantId, FLOWCHAIN_ENABLE_CONTRACTS: 'false' }
const admin = { authenticated: true, tenantId, userId: `${tenantId}-admin`, role: 'admin', source: 'walkthrough_scenario_resume_test' }

test('a stopped walkthrough seed resumes on its first day, and history a person changed is kept', async () => {
  // Run only with scripts/run-postgres-test-files.mjs against its disposable database.
  assert.ok(process.env.DATABASE_URL_TEST, 'An isolated test database is required')
  const prisma = await createPrismaClient(env)
  try {
    await prisma.tenant.create({ data: { id: tenantId, name: 'Walkthrough Resume Tenant', countryCode: 'US', locale: 'en-US', currency: 'USD', timezone: 'America/New_York', defaultLanguage: 'en-US' } })
    await prisma.user.create({ data: { id: admin.userId, tenantId, email: 'walkthrough-resume-admin@example.com', name: 'Walkthrough Resume Admin', role: 'admin' } })
    await backfillTenantAuthorization(prisma, tenantId, { actorId: admin.userId })
    await seedLocalDemo(prisma, env)

    // The first run stops at its first receipt posting, after the opening
    // stock is posted: every receipt update fails.
    const stopping = prisma.$extends({ query: { receivingDocument: { async updateMany() { throw new Error('stopped before the first receipt') } } } })
    await assert.rejects(seedLocalScenario(stopping, env, { asOf: AS_OF }), /stopped before the first receipt/)
    const opening = await prisma.inventoryAdjustmentDocument.findFirst({ where: { tenantId } })
    assert.equal(opening.postingStatus, 'posted')
    assert.equal(await prisma.receivingDocument.count({ where: { tenantId, postingStatus: { not: 'unposted' } } }), 0)
    assert.equal(await prisma.shipmentDocument.count({ where: { tenantId } }), 0)

    // The opening stock is dated history, so the seed day cannot move any more.
    await assert.rejects(seedLocalScenario(prisma, env, { asOf: '2026-09-01' }), /seeded for 2026-10-20 .*cannot be re-dated/)

    // Run again without a day, the seed finishes on its first day: every
    // receipt and history shipment is posted once, and stock ends where a seed
    // that never stopped leaves it.
    const resumed = await seedLocalScenario(prisma, env)
    assert.deepEqual([resumed.asOf, resumed.shipmentHistory, resumed.postedReceipts, resumed.postedShipments], [AS_OF, 'kept', 17, 60])
    assert.equal(await prisma.inventoryAdjustmentDocument.count({ where: { tenantId } }), 1)
    assert.equal(Number((await prisma.inventoryBalance.findUnique({ where: { id: 'LOCAL-DEMO-BAL-001' } })).onHandQuantity), 28)
    const ledger = await prisma.inventoryMovement.findMany({ where: { tenantId }, orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }] })
    for (const sku of ['TST-001', 'TST-002', 'TST-003', 'TST-004', 'TST-005', 'TST-006']) {
      let stock = 0
      for (const movement of ledger.filter((row) => row.sku === sku)) {
        stock += Number(movement.quantityIn) - Number(movement.quantityOut)
        assert.ok(stock >= 0, `${sku} is ${stock} after ${movement.movementType} on ${movement.occurredAt.toISOString()}`)
      }
    }

    // A person reverses a history shipment. The next seed leaves it reversed
    // and posts nothing again.
    const shipment = await prisma.shipmentDocument.findFirst({ where: { tenantId, salesOrderId: 'LOCAL-DEMO-SO-130' } })
    // History shipments are numbered by the server, DN-YYYYMM-NNNN in the month they shipped.
    assert.match(shipment.shipmentNumber, /^DN-\d{6}-\d{4,}$/)
    await createOutboundPostingCommandService({ prisma, env: { ...env, FLOWCHAIN_ENABLE_DB_OUTBOUND_POSTING: 'true' } })
      .reverseShipment({ shipmentId: shipment.id, expectedShipmentVersion: shipment.version, reason: 'Customer refused the delivery', idempotencyKey: 'walkthrough-resume-test:reverse' }, { identity: admin })
    const counts = async () => ({
      shipments: await prisma.shipmentDocument.count({ where: { tenantId } }),
      movements: await prisma.inventoryMovement.count({ where: { tenantId } }),
      reservations: await prisma.inventoryReservation.count({ where: { tenantId } }),
      commands: await prisma.businessCommandExecution.count({ where: { tenantId } }),
    })
    const before = await counts()
    const again = await seedLocalScenario(prisma, env)
    assert.deepEqual([again.postedReceipts, again.postedShipments], [0, 0])
    assert.deepEqual(await counts(), before)
    assert.equal((await prisma.shipmentDocument.findUnique({ where: { id: shipment.id } })).postingStatus, 'reversed')
  } finally {
    await prisma.$disconnect()
  }
})
