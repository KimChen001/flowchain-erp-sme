import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { calculateMovementBalance, createReceivingPostingCommandService } from './receiving-posting-command-service.mjs'
import { cleanupReceivingScenario, expectCommandError, seedReceivingScenario, withLiveReceivingDatabase } from './receiving-posting-live-test-helpers.mjs'
import { createPrismaClient } from '../persistence/prisma-client.mjs'

test('inventory balance rebuild uses quantityIn - quantityOut + adjustmentQty', () => {
  assert.equal(calculateMovementBalance([
    { quantityIn: '10', quantityOut: '0', adjustmentQty: '0' },
    { quantityIn: '0', quantityOut: '3', adjustmentQty: '0' },
    { quantityIn: '0', quantityOut: '0', adjustmentQty: '-1.5' },
  ]), '5.5000')
})

test('database receiving posting is atomic, idempotent, tenant-scoped, and concurrency-safe', async (t) => {
  await withLiveReceivingDatabase(t, async ({ prisma }) => {
    await t.test('partial posting creates immutable movement, balance, PO progress, GRN state, audit, and reconciliation', async () => {
      const scenario = await seedReceivingScenario(prisma)
      try {
        const service = createReceivingPostingCommandService({ prisma })
        const result = await service.postReceiving({ receivingDocumentId: scenario.receivingDocumentId, idempotencyKey: 'post-partial' }, { identity: scenario.actor })
        assert.equal(result.receivingDocument.postingStatus, 'posted')
        assert.equal(result.purchaseOrder.status, 'partially_received')
        assert.equal(result.movements.length, 1)
        assert.equal(result.movements[0].movementType, 'receipt_posting')
        assert.equal(result.affectedBalances[0].onHandQuantity, '4.0000')
        assert.equal(await prisma.auditLog.count({ where: { tenantId: scenario.tenantId, action: 'receiving_posted' } }), 1)
        const reconciliation = await service.reconcileInventoryBalance({ tenantId: scenario.tenantId, sku: scenario.items[0].sku, warehouseId: scenario.warehouseId, location: 'A-01' })
        assert.equal(reconciliation.calculatedOnHandQuantity, '4.0000')
        assert.equal(reconciliation.matches, true)
      } finally {
        await cleanupReceivingScenario(prisma, scenario)
      }
    })

    // Design audit L1-14: a delivery rejected in full is recorded with nothing
    // accepted. It moves no stock, leaves its PO line open, keeps the rejected
    // quantity on the receipt, and reverses without moving stock either.
    await t.test('a line rejected in full posts no stock and leaves its PO line open; the receipt keeps the rejection', async () => {
      const scenario = await seedReceivingScenario(prisma, { ordered: ['10', '5'], accepted: ['4', '0'], rejected: ['0', '5'] })
      try {
        const service = createReceivingPostingCommandService({ prisma })
        const result = await service.postReceiving({ receivingDocumentId: scenario.receivingDocumentId, idempotencyKey: 'post-one-rejected' }, { identity: scenario.actor })
        assert.equal(result.receivingDocument.postingStatus, 'posted')
        // One movement, for the accepted line only.
        assert.deepEqual(result.movements.map((movement) => [movement.sku, movement.quantityIn]), [[scenario.items[0].sku, '4.0000']])
        assert.equal(await prisma.inventoryMovement.count({ where: { tenantId: scenario.tenantId, sku: scenario.items[1].sku } }), 0)
        assert.equal(await prisma.inventoryBalance.count({ where: { tenantId: scenario.tenantId, sku: scenario.items[1].sku } }), 0)
        // The rejected line's PO line is still open in full.
        const poLines = await prisma.purchaseOrderLine.findMany({ where: { purchaseOrderId: scenario.poId }, orderBy: { id: 'asc' } })
        assert.deepEqual(poLines.map((line) => [line.sku, String(line.receivedQuantity)]).sort(), [[scenario.items[0].sku, '4'], [scenario.items[1].sku, '0']].sort())
        assert.equal(result.purchaseOrder.status, 'partially_received')
        // The receipt keeps the rejected quantity.
        const rejectedLine = await prisma.receivingLine.findFirst({ where: { receivingDocumentId: scenario.receivingDocumentId, sku: scenario.items[1].sku } })
        assert.deepEqual([String(rejectedLine.acceptedQty), String(rejectedLine.rejectedQty)], ['0', '5'])
      } finally {
        await cleanupReceivingScenario(prisma, scenario)
      }
    })

    await t.test('a delivery rejected in full posts nothing to stock, leaves the order as it was, and reverses without moving stock', async () => {
      const scenario = await seedReceivingScenario(prisma, { ordered: ['5'], accepted: ['0'], rejected: ['5'] })
      try {
        const service = createReceivingPostingCommandService({ prisma })
        const result = await service.postReceiving({ receivingDocumentId: scenario.receivingDocumentId, idempotencyKey: 'post-all-rejected' }, { identity: scenario.actor })
        assert.equal(result.receivingDocument.postingStatus, 'posted')
        assert.deepEqual(result.movements, [])
        assert.equal(await prisma.inventoryMovement.count({ where: { tenantId: scenario.tenantId } }), 0)
        assert.equal(await prisma.inventoryBalance.count({ where: { tenantId: scenario.tenantId } }), 0)
        assert.equal(result.purchaseOrder.status, 'issued')
        assert.equal(String((await prisma.purchaseOrderLine.findFirst({ where: { purchaseOrderId: scenario.poId } })).receivedQuantity), '0')
        // Nothing was accepted, so no movement is missing: the reversal goes
        // through and moves nothing.
        const reversed = await service.reverseReceiving({ receivingDocumentId: scenario.receivingDocumentId, idempotencyKey: 'reverse-all-rejected', reason: 'Recorded on the wrong order' }, { identity: scenario.actor })
        assert.equal(reversed.receivingDocument.postingStatus, 'reversed')
        assert.equal(await prisma.inventoryMovement.count({ where: { tenantId: scenario.tenantId } }), 0)
      } finally {
        await cleanupReceivingScenario(prisma, scenario)
      }
    })

    await t.test('actor provisioning is fail-closed outside test/local bootstrap', async () => {
      const scenario = await seedReceivingScenario(prisma)
      try {
        const service = createReceivingPostingCommandService({ prisma, env: { NODE_ENV: 'production', FLOWCHAIN_ALLOW_LOCAL_ACTOR_BOOTSTRAP: 'false' } })
        await expectCommandError(service.postReceiving({ receivingDocumentId: scenario.receivingDocumentId, idempotencyKey: 'actor-disabled' }, { identity: scenario.actor }), 'ACTOR_NOT_PROVISIONED')
        assert.equal(await prisma.user.count({ where: { id: scenario.actor.userId } }), 0)
        assert.equal(await prisma.inventoryMovement.count({ where: { tenantId: scenario.tenantId } }), 0)
      } finally { await cleanupReceivingScenario(prisma, scenario) }
    })

    await t.test('provisioned actor works with bootstrap disabled and wrong-tenant actor is rejected', async () => {
      const scenario = await seedReceivingScenario(prisma)
      const other = await seedReceivingScenario(prisma)
      try {
        await prisma.user.create({ data: { id: scenario.actor.userId, tenantId: scenario.tenantId, email: `${scenario.actor.userId}@test.invalid`, name: 'Provisioned Actor', role: 'manager' } })
        await prisma.userWarehouseScope.create({ data: { id: randomUUID(), tenantId: scenario.tenantId, userId: scenario.actor.userId, warehouseId: scenario.warehouseId, accessLevel: 'operate' } })
        const service = createReceivingPostingCommandService({ prisma, env: { NODE_ENV: 'production' } })
        const result = await service.postReceiving({ receivingDocumentId: scenario.receivingDocumentId, idempotencyKey: 'actor-provisioned' }, { identity: scenario.actor })
        assert.equal(result.receivingDocument.postingStatus, 'posted')
        await expectCommandError(service.postReceiving({ receivingDocumentId: other.receivingDocumentId, idempotencyKey: 'actor-wrong-tenant' }, { identity: { ...other.actor, userId: scenario.actor.userId } }), 'TENANT_CONTEXT_REQUIRED')
      } finally { await cleanupReceivingScenario(prisma, scenario); await cleanupReceivingScenario(prisma, other) }
    })

    await t.test('all PO lines completed produces fully_received', async () => {
      const scenario = await seedReceivingScenario(prisma, { ordered: ['5', '7'], accepted: ['5', '7'] })
      try {
        const result = await createReceivingPostingCommandService({ prisma }).postReceiving({ receivingDocumentId: scenario.receivingDocumentId, idempotencyKey: 'post-full' }, { identity: scenario.actor })
        assert.equal(result.purchaseOrder.status, 'fully_received')
        assert.deepEqual(result.purchaseOrder.lines.map((line) => line.receivedQuantity), ['5.0000', '7.0000'])
      } finally {
        await cleanupReceivingScenario(prisma, scenario)
      }
    })

    await t.test('over-receipt fails without movement, balance, PO, GRN, audit, or successful idempotency residue', async () => {
      const scenario = await seedReceivingScenario(prisma, { ordered: ['10'], accepted: ['12'] })
      try {
        const service = createReceivingPostingCommandService({ prisma })
        await expectCommandError(service.postReceiving({ receivingDocumentId: scenario.receivingDocumentId, idempotencyKey: 'post-over' }, { identity: scenario.actor }), 'RECEIVING_OVER_RECEIPT')
        assert.equal(await prisma.inventoryMovement.count({ where: { tenantId: scenario.tenantId } }), 0)
        assert.equal(await prisma.inventoryBalance.count({ where: { tenantId: scenario.tenantId } }), 0)
        assert.equal((await prisma.purchaseOrderLine.findUnique({ where: { id: scenario.poLines[0].id } })).receivedQuantity.toString(), '0')
        assert.equal((await prisma.receivingDocument.findUnique({ where: { id: scenario.receivingDocumentId } })).postingStatus, 'unposted')
        assert.equal(await prisma.auditLog.count({ where: { tenantId: scenario.tenantId } }), 0)
        assert.equal(await prisma.businessCommandExecution.count({ where: { tenantId: scenario.tenantId } }), 0)
      } finally {
        await cleanupReceivingScenario(prisma, scenario)
      }
    })

    // Design audit L1-02 = L3-01: no conversion between units is recorded, so
    // a CASE line on an item kept in pcs is refused rather than adding 10
    // cases to the pcs balance as 10 pcs and relabelling the balance CASE.
    await t.test('a receipt in another unit than the stock unit is refused and leaves the balance and its unit alone', async () => {
      const scenario = await seedReceivingScenario(prisma, { ordered: ['10'], accepted: ['10'], itemUnit: 'pcs', lineUnit: 'CASE' })
      try {
        const balanceId = randomUUID()
        await prisma.inventoryBalance.create({ data: { id: balanceId, tenantId: scenario.tenantId, itemId: scenario.items[0].itemId, sku: scenario.items[0].sku, warehouseId: scenario.warehouseId, warehouseKey: scenario.warehouseId, location: 'A-01', locationKey: 'a-01', onHandQuantity: '40', availableQuantity: '40', reservedQuantity: '0', unit: 'pcs', version: 1 } })
        const service = createReceivingPostingCommandService({ prisma })
        const error = await expectCommandError(service.postReceiving({ receivingDocumentId: scenario.receivingDocumentId, idempotencyKey: 'post-other-unit' }, { identity: scenario.actor }), 'RECEIVING_UNIT_MISMATCH')
        assert.equal(error.status, 409)
        assert.deepEqual([error.details.unit, error.details.stockUnit], ['CASE', 'pcs'])
        const balance = await prisma.inventoryBalance.findUnique({ where: { id: balanceId } })
        assert.deepEqual([balance.onHandQuantity.toString(), balance.availableQuantity.toString(), balance.unit, balance.version], ['40', '40', 'pcs', 1])
        assert.equal(await prisma.inventoryMovement.count({ where: { tenantId: scenario.tenantId } }), 0)
        assert.equal((await prisma.purchaseOrderLine.findUnique({ where: { id: scenario.poLines[0].id } })).receivedQuantity.toString(), '0')
        assert.equal((await prisma.receivingDocument.findUnique({ where: { id: scenario.receivingDocumentId } })).postingStatus, 'unposted')
      } finally {
        await cleanupReceivingScenario(prisma, scenario)
      }
    })

    await t.test('a receipt in the stock unit is booked in the stock unit and never relabels the balance', async () => {
      const scenario = await seedReceivingScenario(prisma, { ordered: ['10'], accepted: ['10'], itemUnit: 'pcs', lineUnit: 'PCS' })
      try {
        const balanceId = randomUUID()
        // The stock record keeps its own spelling of the unit; the receipt does not overwrite it.
        await prisma.inventoryBalance.create({ data: { id: balanceId, tenantId: scenario.tenantId, itemId: scenario.items[0].itemId, sku: scenario.items[0].sku, warehouseId: scenario.warehouseId, warehouseKey: scenario.warehouseId, location: 'A-01', locationKey: 'a-01', onHandQuantity: '40', availableQuantity: '40', reservedQuantity: '0', unit: 'Pcs', version: 1 } })
        const result = await createReceivingPostingCommandService({ prisma }).postReceiving({ receivingDocumentId: scenario.receivingDocumentId, idempotencyKey: 'post-stock-unit' }, { identity: scenario.actor })
        assert.equal(result.affectedBalances[0].onHandQuantity, '50.0000')
        const balance = await prisma.inventoryBalance.findUnique({ where: { id: balanceId } })
        assert.equal(balance.unit, 'Pcs')
        const [movement] = await prisma.inventoryMovement.findMany({ where: { tenantId: scenario.tenantId } })
        assert.equal(movement.unit, 'pcs')
      } finally {
        await cleanupReceivingScenario(prisma, scenario)
      }
    })

    await t.test('injected failure rolls back the complete transaction', async () => {
      const scenario = await seedReceivingScenario(prisma)
      try {
        const service = createReceivingPostingCommandService({ prisma, faultInjector: async (point) => { if (point === 'after_movements') throw new Error('injected transaction failure') } })
        await assert.rejects(service.postReceiving({ receivingDocumentId: scenario.receivingDocumentId, idempotencyKey: 'post-fail' }, { identity: scenario.actor }), /injected transaction failure/)
        assert.equal(await prisma.inventoryMovement.count({ where: { tenantId: scenario.tenantId } }), 0)
        assert.equal(await prisma.inventoryBalance.count({ where: { tenantId: scenario.tenantId } }), 0)
        assert.equal((await prisma.purchaseOrderLine.findUnique({ where: { id: scenario.poLines[0].id } })).receivedQuantity.toString(), '0')
        assert.equal((await prisma.receivingDocument.findUnique({ where: { id: scenario.receivingDocumentId } })).postingStatus, 'unposted')
        assert.equal(await prisma.auditLog.count({ where: { tenantId: scenario.tenantId } }), 0)
        assert.equal(await prisma.businessCommandExecution.count({ where: { tenantId: scenario.tenantId } }), 0)
      } finally {
        await cleanupReceivingScenario(prisma, scenario)
      }
    })

    await t.test('same idempotency payload replays once and changed payload returns 409', async () => {
      const scenario = await seedReceivingScenario(prisma)
      try {
        const service = createReceivingPostingCommandService({ prisma })
        const first = await service.postReceiving({ receivingDocumentId: scenario.receivingDocumentId, idempotencyKey: 'post-idem', expectedVersion: 0 }, { identity: scenario.actor })
        const replay = await service.postReceiving({ receivingDocumentId: scenario.receivingDocumentId, idempotencyKey: 'post-idem', expectedVersion: 0 }, { identity: scenario.actor })
        assert.equal(first.idempotentReplay, false)
        assert.equal(replay.idempotentReplay, true)
        await expectCommandError(service.postReceiving({ receivingDocumentId: scenario.receivingDocumentId, idempotencyKey: 'post-idem', expectedVersion: 1 }, { identity: scenario.actor }), 'IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD')
        assert.equal(await prisma.inventoryMovement.count({ where: { tenantId: scenario.tenantId } }), 1)
        assert.equal((await prisma.inventoryBalance.findFirst({ where: { tenantId: scenario.tenantId } })).onHandQuantity.toString(), '4')
        assert.equal(await prisma.auditLog.count({ where: { tenantId: scenario.tenantId, action: 'receiving_posted' } }), 1)
        assert.equal(await prisma.businessCommandExecution.count({ where: { tenantId: scenario.tenantId, commandType: 'receiving.post' } }), 1)
      } finally {
        await cleanupReceivingScenario(prisma, scenario)
      }
    })

    await t.test('same idempotency key on two independent connections commits inventory at most once', async () => {
      const scenario = await seedReceivingScenario(prisma)
      const firstClient = await createPrismaClient(process.env)
      const secondClient = await createPrismaClient(process.env)
      try {
        const attempts = await Promise.allSettled([
          createReceivingPostingCommandService({ prisma: firstClient }).postReceiving({ receivingDocumentId: scenario.receivingDocumentId, idempotencyKey: 'post-concurrent-same' }, { identity: scenario.actor }),
          createReceivingPostingCommandService({ prisma: secondClient }).postReceiving({ receivingDocumentId: scenario.receivingDocumentId, idempotencyKey: 'post-concurrent-same' }, { identity: scenario.actor }),
        ])
        assert.equal(attempts.filter((attempt) => attempt.status === 'fulfilled').length >= 1, true)
        for (const rejected of attempts.filter((attempt) => attempt.status === 'rejected')) {
          assert.equal(rejected.reason?.code, 'RECEIVING_CONCURRENT_POSTING_CONFLICT')
          assert.equal(rejected.reason?.status, 409)
        }
        t.diagnostic(`same-key independent connections: fulfilled=${attempts.filter((attempt) => attempt.status === 'fulfilled').length}, rejected=${attempts.filter((attempt) => attempt.status === 'rejected').length}`)
        assert.equal(await prisma.inventoryMovement.count({ where: { tenantId: scenario.tenantId, movementType: 'receipt_posting' } }), 1)
        assert.equal((await prisma.inventoryBalance.findFirst({ where: { tenantId: scenario.tenantId } })).onHandQuantity.toString(), '4')
        assert.equal((await prisma.purchaseOrderLine.findUnique({ where: { id: scenario.poLines[0].id } })).receivedQuantity.toString(), '4')
        assert.equal(await prisma.auditLog.count({ where: { tenantId: scenario.tenantId, action: 'receiving_posted' } }), 1)
        assert.equal(await prisma.businessCommandExecution.count({ where: { tenantId: scenario.tenantId, commandType: 'receiving.post' } }), 1)
      } finally {
        await Promise.all([firstClient.$disconnect(), secondClient.$disconnect()])
        await cleanupReceivingScenario(prisma, scenario)
      }
    })

    await t.test('different idempotency keys on two independent connections cannot post the same GRN twice', async () => {
      const scenario = await seedReceivingScenario(prisma)
      const firstClient = await createPrismaClient(process.env)
      const secondClient = await createPrismaClient(process.env)
      try {
        const attempts = await Promise.allSettled([
          createReceivingPostingCommandService({ prisma: firstClient }).postReceiving({ receivingDocumentId: scenario.receivingDocumentId, idempotencyKey: 'post-concurrent-a' }, { identity: scenario.actor }),
          createReceivingPostingCommandService({ prisma: secondClient }).postReceiving({ receivingDocumentId: scenario.receivingDocumentId, idempotencyKey: 'post-concurrent-b' }, { identity: scenario.actor }),
        ])
        assert.equal(attempts.filter((attempt) => attempt.status === 'fulfilled').length, 1)
        const rejected = attempts.find((attempt) => attempt.status === 'rejected')
        assert.equal(['RECEIVING_ALREADY_POSTED', 'RECEIVING_VERSION_CONFLICT', 'RECEIVING_CONCURRENT_POSTING_CONFLICT'].includes(rejected?.reason?.code), true)
        assert.equal(rejected?.reason?.status, 409)
        t.diagnostic(`different-key independent connections: fulfilled=1, rejected=${rejected?.reason?.code}`)
        assert.equal(await prisma.inventoryMovement.count({ where: { tenantId: scenario.tenantId, movementType: 'receipt_posting' } }), 1)
        assert.equal((await prisma.inventoryBalance.findFirst({ where: { tenantId: scenario.tenantId } })).onHandQuantity.toString(), '4')
        assert.equal((await prisma.purchaseOrderLine.findUnique({ where: { id: scenario.poLines[0].id } })).receivedQuantity.toString(), '4')
      } finally {
        await Promise.all([firstClient.$disconnect(), secondClient.$disconnect()])
        await cleanupReceivingScenario(prisma, scenario)
      }
    })

    await t.test('reconciliation remains exact after multiple GRNs post to the same balance', async () => {
      const scenario = await seedReceivingScenario(prisma, { ordered: ['10'], accepted: ['4'] })
      const secondReceivingId = `grn-${randomUUID()}`
      try {
        const service = createReceivingPostingCommandService({ prisma })
        await service.postReceiving({ receivingDocumentId: scenario.receivingDocumentId, idempotencyKey: 'post-multi-first' }, { identity: scenario.actor })
        await prisma.receivingDocument.create({
          data: {
            id: secondReceivingId,
            tenantId: scenario.tenantId,
            documentNumber: `GRN-${randomUUID()}`,
            poId: scenario.poId,
            status: 'receiving',
            workflowStatus: 'approved',
            postingStatus: 'unposted',
            warehouseId: scenario.warehouseId,
            currency: 'CNY',
            lines: {
              create: [{
                id: `grn-line-${randomUUID()}`,
                purchaseOrderLineId: scenario.poLines[0].id,
                itemId: scenario.items[0].itemId,
                sku: scenario.items[0].sku,
                itemName: 'Item 0',
                acceptedQty: '3',
                rejectedQty: '0',
                unit: 'EA',
                warehouseId: scenario.warehouseId,
                location: 'A-01',
                locationKey: 'a-01',
              }],
            },
          },
        })
        await service.postReceiving({ receivingDocumentId: secondReceivingId, idempotencyKey: 'post-multi-second' }, { identity: scenario.actor })
        const reconciliation = await service.reconcileInventoryBalance({ tenantId: scenario.tenantId, sku: scenario.items[0].sku, warehouseId: scenario.warehouseId, location: 'A-01' })
        assert.equal(reconciliation.calculatedOnHandQuantity, '7.0000')
        assert.equal(reconciliation.balance.onHandQuantity, '7.0000')
        assert.equal(reconciliation.movementIds.length, 2)
        assert.equal(reconciliation.matches, true)
      } finally {
        await cleanupReceivingScenario(prisma, scenario)
      }
    })

    await t.test('tenant A cannot post tenant B receiving even with forged command payload fields', async () => {
      const scenarioA = await seedReceivingScenario(prisma)
      const scenarioB = await seedReceivingScenario(prisma)
      try {
        const service = createReceivingPostingCommandService({ prisma })
        await expectCommandError(service.postReceiving({ receivingDocumentId: scenarioB.receivingDocumentId, idempotencyKey: 'cross-tenant', tenantId: scenarioB.tenantId }, { identity: scenarioA.actor }), 'RECEIVING_NOT_FOUND')
        assert.equal(await prisma.inventoryMovement.count({ where: { tenantId: scenarioB.tenantId } }), 0)
        assert.equal((await prisma.receivingDocument.findUnique({ where: { id: scenarioB.receivingDocumentId } })).postingStatus, 'unposted')
      } finally {
        await cleanupReceivingScenario(prisma, scenarioA)
        await cleanupReceivingScenario(prisma, scenarioB)
      }
    })
  })
})
