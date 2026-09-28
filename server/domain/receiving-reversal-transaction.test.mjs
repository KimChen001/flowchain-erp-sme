import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createReceivingPostingCommandService } from './receiving-posting-command-service.mjs'
import { createInventoryOperationsCommandService } from './inventory-operations-command-service.mjs'
import { cleanupReceivingScenario, expectCommandError, seedReceivingScenario, withLiveReceivingDatabase } from './receiving-posting-live-test-helpers.mjs'

test('database receiving reversal preserves history, restores state, and fails closed on unsafe use', async (t) => {
  await withLiveReceivingDatabase(t, async ({ prisma }) => {
    await t.test('reversal creates a linked reverse movement and restores balance and PO progress', async () => {
      const scenario = await seedReceivingScenario(prisma)
      try {
        const service = createReceivingPostingCommandService({ prisma })
        const posted = await service.postReceiving({ receivingDocumentId: scenario.receivingDocumentId, idempotencyKey: 'post-before-reverse' }, { identity: scenario.actor })
        const originalMovementId = posted.movements[0].id
        const reversed = await service.reverseReceiving({ receivingDocumentId: scenario.receivingDocumentId, idempotencyKey: 'reverse-safe', reason: 'Incorrect receiving quantity' }, { identity: scenario.actor })
        assert.equal(reversed.receivingDocument.postingStatus, 'reversed')
        assert.equal(reversed.purchaseOrder.status, 'issued')
        assert.equal(reversed.movements[0].movementType, 'receipt_reversal')
        assert.equal(reversed.movements[0].reversalOfMovementId, originalMovementId)
        const original = await prisma.inventoryMovement.findUnique({ where: { id: originalMovementId } })
        assert.equal(original.quantityIn.toString(), '4')
        assert.equal(original.reversedByMovementId, reversed.movements[0].id)
        const reversalMovement = await prisma.inventoryMovement.findUnique({ where: { id: reversed.movements[0].id } })
        assert.equal(reversalMovement.reason, 'Incorrect receiving quantity')
        const balance = await prisma.inventoryBalance.findFirst({ where: { tenantId: scenario.tenantId } })
        assert.equal(balance.onHandQuantity.toString(), '0')
        assert.equal(balance.availableQuantity.toString(), '0')
        const reconciliation = await service.reconcileInventoryBalance({ tenantId: scenario.tenantId, sku: scenario.items[0].sku, warehouseId: scenario.warehouseId, location: 'A-01' })
        assert.equal(reconciliation.calculatedOnHandQuantity, '0.0000')
        assert.equal(reconciliation.matches, true)
        assert.equal(await prisma.auditLog.count({ where: { tenantId: scenario.tenantId, entityType: 'ReceivingDocument' } }), 2)
        await expectCommandError(service.reverseReceiving({ receivingDocumentId: scenario.receivingDocumentId, idempotencyKey: 'reverse-twice', reason: 'Duplicate reversal' }, { identity: scenario.actor }), 'RECEIVING_ALREADY_REVERSED')
        assert.equal(await prisma.inventoryMovement.count({ where: { tenantId: scenario.tenantId, movementType: 'receipt_reversal' } }), 1)
        assert.equal(await prisma.auditLog.count({ where: { tenantId: scenario.tenantId, entityType: 'ReceivingDocument' } }), 2)
      } finally {
        await cleanupReceivingScenario(prisma, scenario)
      }
    })

    await t.test('explicit downstream outbound movement blocks reversal without partial writes', async () => {
      const scenario = await seedReceivingScenario(prisma)
      try {
        const service = createReceivingPostingCommandService({ prisma })
        const posted = await service.postReceiving({ receivingDocumentId: scenario.receivingDocumentId, idempotencyKey: 'post-before-unsafe-reverse' }, { identity: scenario.actor })
        await prisma.inventoryMovement.create({
          data: {
            id: randomUUID(), tenantId: scenario.tenantId, itemId: scenario.items[0].itemId, sku: scenario.items[0].sku,
            warehouseId: scenario.warehouseId, location: 'A-01', locationKey: 'a-01', movementType: 'outbound_posting',
            sourceDocumentType: 'shipment', sourceDocumentId: `shipment-${randomUUID()}`, sourceDocumentLineId: `shipment-line-${randomUUID()}`,
            quantityIn: '0', quantityOut: '1', adjustmentQty: '0', status: 'posted', actorId: scenario.actor.userId,
            occurredAt: new Date(Date.now() + 1_000), movementDate: new Date(Date.now() + 1_000), postingBatchId: randomUUID(),
          },
        })
        await expectCommandError(service.reverseReceiving({ receivingDocumentId: scenario.receivingDocumentId, idempotencyKey: 'reverse-unsafe', reason: 'Should be blocked' }, { identity: scenario.actor }), 'RECEIVING_REVERSAL_NOT_SAFE')
        assert.equal(await prisma.inventoryMovement.count({ where: { tenantId: scenario.tenantId, movementType: 'receipt_reversal' } }), 0)
        assert.equal((await prisma.receivingDocument.findUnique({ where: { id: scenario.receivingDocumentId } })).postingStatus, 'posted')
        assert.equal((await prisma.inventoryMovement.findUnique({ where: { id: posted.movements[0].id } })).quantityIn.toString(), '4')
        assert.equal((await prisma.inventoryBalance.findFirst({ where: { tenantId: scenario.tenantId } })).onHandQuantity.toString(), '4')
        assert.equal((await prisma.purchaseOrderLine.findUnique({ where: { id: scenario.poLines[0].id } })).receivedQuantity.toString(), '4')
        assert.equal(await prisma.auditLog.count({ where: { tenantId: scenario.tenantId, entityType: 'ReceivingDocument' } }), 1)
        assert.equal(await prisma.businessCommandExecution.count({ where: { tenantId: scenario.tenantId, commandType: 'receiving.reverse' } }), 0)
      } finally {
        await cleanupReceivingScenario(prisma, scenario)
      }
    })

    // KNOWN DEFECT REPRODUCTION, driven entirely through production services.
    //
    // Business rule under test. In this model an outbound movement records no
    // link to the receipt whose units it consumed: InventoryMovement has
    // relatedGrnId only on the receipt side, and no FIFO or allocation layer
    // ties a shipment or transfer back to a GRN. For pooled stock, "this
    // receipt was consumed" is therefore not directly observable. What is
    // observable is the per-location ledger. Reversing receipt R of quantity Q
    // is historically sound only if, replaying every posted movement at that
    // location after R with R removed, the running on-hand never drops below
    // zero. If it would, some later outbound drew on R's units and the reversal
    // would rewrite history into an impossible state.
    //
    // Why the current guards miss it. The downstream check in
    // buildReceivingReversalPlan matches a hardcoded list of movement types that
    // production never writes (the real outbound types are shipment_posting and
    // stock_transfer_out, not outbound_posting or transfer_out), so it never
    // fires. The remaining check compares only the CURRENT balance, which a
    // later receipt can replenish.
    //
    // Scenario, all real services:
    //   GRN-1 posts 4 into A-01                      A-01 on-hand 4
    //   a real stock transfer moves 3 out of A-01    A-01 on-hand 1
    //   GRN-2 posts 4 into A-01                      A-01 on-hand 5
    //   reverse GRN-1: current balance 5 >= 4, so it is allowed today.
    // Replaying A-01 without GRN-1, the transfer would leave -3, so the transfer
    // could only have been supplied by GRN-1. The reversal must be refused.
    await t.test('a later receipt must not mask consumption of an earlier receipt', { todo: 'Known defect: reversal is currently allowed. Fixed by the ledger replay guard.' }, async () => {
      const scenario = await seedReceivingScenario(prisma, { ordered: ['10'], accepted: ['4'] })
      const suffix = randomUUID()
      const managerId = `manager-${suffix}`
      const destinationWarehouseId = `warehouse-dest-${suffix}`
      const secondReceivingDocumentId = `grn-2-${suffix}`
      try {
        const receiving = createReceivingPostingCommandService({ prisma })
        const sku = scenario.items[0].sku
        const itemId = scenario.items[0].itemId

        // Provision a real manager so the inventory operations service can
        // authorise the transfer through its normal warehouse-scope checks.
        await prisma.warehouse.create({ data: { id: destinationWarehouseId, tenantId: scenario.tenantId, code: `DEST-${suffix}`, name: 'Destination Warehouse', status: 'active' } })
        await prisma.user.create({ data: { id: managerId, tenantId: scenario.tenantId, email: `${managerId}@example.com`, name: 'Manager', role: 'manager' } })
        await prisma.userWarehouseScope.createMany({ data: [scenario.warehouseId, destinationWarehouseId].map((warehouseId) => ({ id: randomUUID(), tenantId: scenario.tenantId, userId: managerId, warehouseId, accessLevel: 'operate' })) })
        await prisma.inventoryBalance.create({ data: { id: `balance-dest-${suffix}`, tenantId: scenario.tenantId, itemId, sku, itemName: 'Item 0', warehouseId: destinationWarehouseId, warehouseKey: destinationWarehouseId, location: 'B-01', locationKey: 'b-01', onHandQuantity: '0', reservedQuantity: '0', availableQuantity: '0', unit: 'EA', status: 'available' } })

        // 1. GRN-1 posts 4 into A-01.
        const firstPosting = await receiving.postReceiving({ receivingDocumentId: scenario.receivingDocumentId, idempotencyKey: 'mask-post-grn-1' }, { identity: scenario.actor })

        // 2. A real stock transfer moves 3 out of A-01, written by the production
        //    inventory operations service as stock_transfer_out.
        const inventoryOperations = createInventoryOperationsCommandService({ prisma, env: { ...process.env, FLOWCHAIN_PERSISTENCE_MODE: 'database', FLOWCHAIN_ENABLE_DB_INVENTORY_OPERATIONS: 'true' } })
        const manager = { identity: { authenticated: true, tenantId: scenario.tenantId, userId: managerId, role: 'manager', source: 'signed-session' } }
        const created = await inventoryOperations.createTransfer({
          transferNumber: `TR-${suffix}`,
          idempotencyKey: 'mask-transfer-create',
          lines: [{ itemId, quantity: '3', source: { warehouseId: scenario.warehouseId, location: 'A-01' }, destination: { warehouseId: destinationWarehouseId, location: 'B-01' } }],
        }, manager)
        const ready = await inventoryOperations.readyTransfer(created.transfer.id, { expectedTransferVersion: 0, idempotencyKey: 'mask-transfer-ready' }, manager)
        await inventoryOperations.postTransfer(created.transfer.id, { expectedTransferVersion: ready.transfer.version, idempotencyKey: 'mask-transfer-post' }, manager)
        const transferOut = await prisma.inventoryMovement.findFirst({ where: { tenantId: scenario.tenantId, sku, warehouseId: scenario.warehouseId, movementType: 'stock_transfer_out' } })
        assert.ok(transferOut, 'the production service must have written a stock_transfer_out movement')

        // 3. GRN-2 on the same PO line posts another 4 into A-01.
        await prisma.receivingDocument.create({
          data: {
            id: secondReceivingDocumentId, tenantId: scenario.tenantId, documentNumber: `GRN-2-${suffix}`, poId: scenario.poId,
            status: 'receiving', workflowStatus: 'approved', postingStatus: 'unposted', warehouseId: scenario.warehouseId, currency: 'CNY',
            lines: { create: [{ id: `grn-2-line-${suffix}`, purchaseOrderLineId: scenario.poLines[0].id, itemId, sku, itemName: 'Item 0', acceptedQty: '4', rejectedQty: '0', unit: 'EA', warehouseId: scenario.warehouseId, location: 'A-01', locationKey: 'a-01' }] },
          },
        })
        await receiving.postReceiving({ receivingDocumentId: secondReceivingDocumentId, idempotencyKey: 'mask-post-grn-2' }, { identity: scenario.actor })
        const sourceBalance = await prisma.inventoryBalance.findFirst({ where: { tenantId: scenario.tenantId, sku, warehouseId: scenario.warehouseId, locationKey: 'a-01' } })
        assert.equal(sourceBalance.onHandQuantity.toString(), '5', 'A-01 holds 4 - 3 + 4')

        // 4. Reversing GRN-1 must be refused: the transfer drew on its units.
        await expectCommandError(receiving.reverseReceiving({ receivingDocumentId: scenario.receivingDocumentId, idempotencyKey: 'mask-reverse-grn-1', reason: 'Masked consumption' }, { identity: scenario.actor }), 'RECEIVING_REVERSAL_NOT_SAFE')
        assert.equal(await prisma.inventoryMovement.count({ where: { tenantId: scenario.tenantId, movementType: 'receipt_reversal' } }), 0)
        assert.equal((await prisma.receivingDocument.findUnique({ where: { id: scenario.receivingDocumentId } })).postingStatus, 'posted')
        assert.equal((await prisma.inventoryMovement.findUnique({ where: { id: firstPosting.movements[0].id } })).reversedByMovementId, null)
      } finally {
        // Lines cascade from the document and legs cascade from lines.
        await prisma.stockTransferDocument.deleteMany({ where: { tenantId: scenario.tenantId } })
        await prisma.receivingLine.deleteMany({ where: { receivingDocumentId: secondReceivingDocumentId } })
        await prisma.receivingDocument.deleteMany({ where: { id: secondReceivingDocumentId } })
        await cleanupReceivingScenario(prisma, scenario)
      }
    })

    for (const kind of ['lot', 'serial']) {
      await t.test(`consumed ${kind} evidence blocks reversal`, async () => {
        const scenario = await seedReceivingScenario(prisma)
        try {
          const service = createReceivingPostingCommandService({ prisma })
          await service.postReceiving({ receivingDocumentId: scenario.receivingDocumentId, idempotencyKey: `post-before-consumed-${kind}` }, { identity: scenario.actor })
          const shared = { id: `${kind}-${randomUUID()}`, tenantId: scenario.tenantId, itemId: scenario.items[0].itemId, sku: scenario.items[0].sku, warehouseId: scenario.warehouseId, location: 'A-01', sourceDocument: scenario.receivingDocumentId }
          if (kind === 'lot') await prisma.inventoryLot.create({ data: { ...shared, quantity: '4', status: 'consumed' } })
          else await prisma.inventorySerial.create({ data: { ...shared, status: 'consumed' } })
          await expectCommandError(service.reverseReceiving({ receivingDocumentId: scenario.receivingDocumentId, idempotencyKey: `reverse-consumed-${kind}`, reason: 'Must fail closed' }, { identity: scenario.actor }), 'RECEIVING_REVERSAL_NOT_SAFE')
          assert.equal(await prisma.inventoryMovement.count({ where: { tenantId: scenario.tenantId, movementType: 'receipt_reversal' } }), 0)
        } finally {
          await prisma.inventoryLot.deleteMany({ where: { tenantId: scenario.tenantId } })
          await prisma.inventorySerial.deleteMany({ where: { tenantId: scenario.tenantId } })
          await cleanupReceivingScenario(prisma, scenario)
        }
      })
    }

    await t.test('tenant A cannot reverse tenant B receiving', async () => {
      const scenarioA = await seedReceivingScenario(prisma)
      const scenarioB = await seedReceivingScenario(prisma)
      try {
        const service = createReceivingPostingCommandService({ prisma })
        await service.postReceiving({ receivingDocumentId: scenarioB.receivingDocumentId, idempotencyKey: 'post-tenant-b' }, { identity: scenarioB.actor })
        await expectCommandError(service.reverseReceiving({ receivingDocumentId: scenarioB.receivingDocumentId, idempotencyKey: 'reverse-cross-tenant', reason: 'Forged tenant attempt', tenantId: scenarioB.tenantId }, { identity: scenarioA.actor }), 'RECEIVING_NOT_FOUND')
        assert.equal(await prisma.inventoryMovement.count({ where: { tenantId: scenarioB.tenantId, movementType: 'receipt_reversal' } }), 0)
        assert.equal((await prisma.receivingDocument.findUnique({ where: { id: scenarioB.receivingDocumentId } })).postingStatus, 'posted')
        assert.equal((await prisma.inventoryBalance.findFirst({ where: { tenantId: scenarioB.tenantId } })).onHandQuantity.toString(), '4')
      } finally {
        await cleanupReceivingScenario(prisma, scenarioA)
        await cleanupReceivingScenario(prisma, scenarioB)
      }
    })
  })
})
