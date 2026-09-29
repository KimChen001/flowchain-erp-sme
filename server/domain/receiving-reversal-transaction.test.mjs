import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createReceivingPostingCommandService } from './receiving-posting-command-service.mjs'
import { createInventoryOperationsCommandService } from './inventory-operations-command-service.mjs'
import { createOperationalFinanceCommandService } from './operational-finance-command-service.mjs'
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

    // Shared setup for the ledger replay regressions. Each step goes through a
    // production service, and the caller chooses the order, because the order
    // of receipts and consumption is exactly what decides the outcome.
    async function ledgerScenario() {
      const scenario = await seedReceivingScenario(prisma, { ordered: ['10'], accepted: ['4'] })
      const suffix = randomUUID()
      const managerId = `manager-${suffix}`
      const destinationWarehouseId = `warehouse-dest-${suffix}`
      const secondReceivingDocumentId = `grn-2-${suffix}`
      const sku = scenario.items[0].sku
      const itemId = scenario.items[0].itemId
      const receiving = createReceivingPostingCommandService({ prisma })

      // Provision a real manager so the inventory operations service can
      // authorise the transfer through its normal warehouse-scope checks.
      await prisma.warehouse.create({ data: { id: destinationWarehouseId, tenantId: scenario.tenantId, code: `DEST-${suffix}`, name: 'Destination Warehouse', status: 'active' } })
      await prisma.user.create({ data: { id: managerId, tenantId: scenario.tenantId, email: `${managerId}@example.com`, name: 'Manager', role: 'manager' } })
      await prisma.userWarehouseScope.createMany({ data: [scenario.warehouseId, destinationWarehouseId].map((warehouseId) => ({ id: randomUUID(), tenantId: scenario.tenantId, userId: managerId, warehouseId, accessLevel: 'operate' })) })
      await prisma.inventoryBalance.create({ data: { id: `balance-dest-${suffix}`, tenantId: scenario.tenantId, itemId, sku, itemName: 'Item 0', warehouseId: destinationWarehouseId, warehouseKey: destinationWarehouseId, location: 'B-01', locationKey: 'b-01', onHandQuantity: '0', reservedQuantity: '0', availableQuantity: '0', unit: 'EA', status: 'available' } })
      await prisma.receivingDocument.create({
        data: {
          id: secondReceivingDocumentId, tenantId: scenario.tenantId, documentNumber: `GRN-2-${suffix}`, poId: scenario.poId,
          status: 'receiving', workflowStatus: 'approved', postingStatus: 'unposted', warehouseId: scenario.warehouseId, currency: 'CNY',
          lines: { create: [{ id: `grn-2-line-${suffix}`, purchaseOrderLineId: scenario.poLines[0].id, itemId, sku, itemName: 'Item 0', acceptedQty: '4', rejectedQty: '0', unit: 'EA', warehouseId: scenario.warehouseId, location: 'A-01', locationKey: 'a-01' }] },
        },
      })

      const inventoryOperations = createInventoryOperationsCommandService({ prisma, env: { ...process.env, FLOWCHAIN_PERSISTENCE_MODE: 'database', FLOWCHAIN_ENABLE_DB_INVENTORY_OPERATIONS: 'true' } })
      const manager = { identity: { authenticated: true, tenantId: scenario.tenantId, userId: managerId, role: 'manager', source: 'signed-session' } }

      return {
        scenario,
        postFirstReceipt: () => receiving.postReceiving({ receivingDocumentId: scenario.receivingDocumentId, idempotencyKey: `ledger-post-grn-1-${suffix}` }, { identity: scenario.actor }),
        postSecondReceipt: () => receiving.postReceiving({ receivingDocumentId: secondReceivingDocumentId, idempotencyKey: `ledger-post-grn-2-${suffix}` }, { identity: scenario.actor }),
        // A real stock transfer out of A-01, written by the production inventory
        // operations service as stock_transfer_out.
        transferOut: async (quantity) => {
          const created = await inventoryOperations.createTransfer({
            transferNumber: `TR-${suffix}`,
            idempotencyKey: `ledger-transfer-create-${suffix}`,
            lines: [{ itemId, quantity, source: { warehouseId: scenario.warehouseId, location: 'A-01' }, destination: { warehouseId: destinationWarehouseId, location: 'B-01' } }],
          }, manager)
          const ready = await inventoryOperations.readyTransfer(created.transfer.id, { expectedTransferVersion: 0, idempotencyKey: `ledger-transfer-ready-${suffix}` }, manager)
          await inventoryOperations.postTransfer(created.transfer.id, { expectedTransferVersion: ready.transfer.version, idempotencyKey: `ledger-transfer-post-${suffix}` }, manager)
          assert.ok(await prisma.inventoryMovement.findFirst({ where: { tenantId: scenario.tenantId, sku, warehouseId: scenario.warehouseId, movementType: 'stock_transfer_out' } }), 'the production service must have written a stock_transfer_out movement')
        },
        reverseFirstReceipt: () => receiving.reverseReceiving({ receivingDocumentId: scenario.receivingDocumentId, idempotencyKey: `ledger-reverse-grn-1-${suffix}`, reason: 'Ledger replay regression' }, { identity: scenario.actor }),
        sourceOnHand: async () => (await prisma.inventoryBalance.findFirst({ where: { tenantId: scenario.tenantId, sku, warehouseId: scenario.warehouseId, locationKey: 'a-01' } })).onHandQuantity.toString(),
        cleanup: async () => {
          // Lines cascade from the document and legs cascade from lines.
          await prisma.stockTransferDocument.deleteMany({ where: { tenantId: scenario.tenantId } })
          await prisma.receivingLine.deleteMany({ where: { receivingDocumentId: secondReceivingDocumentId } })
          await prisma.receivingDocument.deleteMany({ where: { id: secondReceivingDocumentId } })
          await cleanupReceivingScenario(prisma, scenario)
        },
      }
    }

    // Regression for a defect where this reversal was allowed.
    //   GRN-1 posts 4 into A-01                      A-01 on-hand 4
    //   a real stock transfer moves 3 out of A-01    A-01 on-hand 1
    //   GRN-2 posts 4 into A-01                      A-01 on-hand 5
    // The current balance of 5 covers the reversal of 4, so a current-balance
    // check alone allows it. Replaying A-01 without GRN-1, the transfer would
    // leave -3: only GRN-1 could have supplied it. The reversal must be refused.
    await t.test('a later receipt must not mask consumption of an earlier receipt', async () => {
      const ledger = await ledgerScenario()
      try {
        const firstPosting = await ledger.postFirstReceipt()
        await ledger.transferOut('3')
        await ledger.postSecondReceipt()
        assert.equal(await ledger.sourceOnHand(), '5', 'A-01 holds 4 - 3 + 4')

        await expectCommandError(ledger.reverseFirstReceipt(), 'RECEIVING_REVERSAL_NOT_SAFE')
        assert.equal(await prisma.inventoryMovement.count({ where: { tenantId: ledger.scenario.tenantId, movementType: 'receipt_reversal' } }), 0)
        assert.equal((await prisma.receivingDocument.findUnique({ where: { id: ledger.scenario.receivingDocumentId } })).postingStatus, 'posted')
        assert.equal((await prisma.inventoryMovement.findUnique({ where: { id: firstPosting.movements[0].id } })).reversedByMovementId, null)
        assert.equal(await ledger.sourceOnHand(), '5', 'a refused reversal leaves the balance untouched')
        assert.equal(await prisma.businessCommandExecution.count({ where: { tenantId: ledger.scenario.tenantId, commandType: 'receiving.reverse' } }), 0)
      } finally {
        await ledger.cleanup()
      }
    })

    // Guards against over-correcting into "refuse whenever any later outbound
    // exists". Here the consumption is fully covered by the second receipt:
    //   GRN-1 posts 4 into A-01                      A-01 on-hand 4
    //   GRN-2 posts 4 into A-01                      A-01 on-hand 8
    //   a real stock transfer moves 3 out of A-01    A-01 on-hand 5
    // Replaying A-01 without GRN-1 gives 4 then 1, never negative, so the
    // transfer did not depend on GRN-1 and the reversal must be allowed.
    await t.test('consumption covered by another receipt does not block the reversal', async () => {
      const ledger = await ledgerScenario()
      try {
        await ledger.postFirstReceipt()
        await ledger.postSecondReceipt()
        await ledger.transferOut('3')
        assert.equal(await ledger.sourceOnHand(), '5', 'A-01 holds 4 + 4 - 3')

        const reversed = await ledger.reverseFirstReceipt()
        assert.equal(reversed.receivingDocument.postingStatus, 'reversed')
        assert.equal(reversed.movements[0].movementType, 'receipt_reversal')
        assert.equal(await ledger.sourceOnHand(), '1', 'A-01 holds 5 - 4 after the reversal')
      } finally {
        await ledger.cleanup()
      }
    })

    // A receipt that a supplier invoice still holds must not be reversed.
    // Driven through the production receiving and operational finance services:
    // the receipt is really posted, and the invoice is really created and
    // submitted, so this also proves production records receivingLineId on the
    // invoice line, which the guard depends on.
    async function invoicedScenario() {
      const scenario = await seedReceivingScenario(prisma, { ordered: ['10'], accepted: ['4'] })
      const suffix = randomUUID()
      const supplierId = `supplier-${suffix}`
      const specialistId = `specialist-${suffix}`
      await prisma.supplier.create({ data: { id: supplierId, tenantId: scenario.tenantId, code: `SUP-${suffix}`, name: 'Invoice Supplier' } })
      await prisma.purchaseOrder.update({ where: { id: scenario.poId }, data: { supplierId, supplierName: 'Invoice Supplier' } })
      await prisma.purchaseOrderLine.update({ where: { id: scenario.poLines[0].id }, data: { unitPrice: '10.0000' } })
      await prisma.receivingDocument.update({ where: { id: scenario.receivingDocumentId }, data: { supplierId, supplierName: 'Invoice Supplier' } })
      await prisma.user.create({ data: { id: specialistId, tenantId: scenario.tenantId, email: `${specialistId}@example.com`, name: 'Finance Specialist', role: 'business-specialist' } })

      const receiving = createReceivingPostingCommandService({ prisma })
      const finance = createOperationalFinanceCommandService({ prisma, env: { ...process.env, FLOWCHAIN_PERSISTENCE_MODE: 'database', FLOWCHAIN_ENABLE_DB_OPERATIONAL_FINANCE: 'true' } })
      const specialist = { identity: { authenticated: true, tenantId: scenario.tenantId, userId: specialistId, role: 'business-specialist', source: 'test' } }

      return {
        scenario,
        post: () => receiving.postReceiving({ receivingDocumentId: scenario.receivingDocumentId, idempotencyKey: `invoiced-post-${suffix}` }, { identity: scenario.actor }),
        createInvoice: () => finance.createSupplierInvoice({
          invoiceNumber: `SUP-INV-${suffix}`,
          supplierId,
          currency: 'CNY',
          invoiceDate: '2026-07-17T00:00:00.000Z',
          dueDate: '2026-08-16T00:00:00.000Z',
          totalAmount: '42.0000',
          idempotencyKey: `invoiced-create-${suffix}`,
          lines: [{ purchaseOrderLineId: scenario.poLines[0].id, receivingLineId: scenario.receivingLines[0].id, quantity: '4.0000', unitPrice: '10.0000', lineAmount: '40.0000', enteredTaxAmount: '2.0000' }],
        }, specialist),
        submitInvoice: (invoiceId) => finance.submitSupplierInvoice(invoiceId, { expectedVersion: 0, idempotencyKey: `invoiced-submit-${suffix}` }, specialist),
        reverse: () => receiving.reverseReceiving({ receivingDocumentId: scenario.receivingDocumentId, idempotencyKey: `invoiced-reverse-${suffix}`, reason: 'Invoice guard regression' }, { identity: scenario.actor }),
        cleanup: async () => {
          await prisma.supplierInvoice.deleteMany({ where: { tenantId: scenario.tenantId } })
          await cleanupReceivingScenario(prisma, scenario)
        },
      }
    }

    await t.test('a receipt held by a submitted supplier invoice cannot be reversed', async () => {
      const invoiced = await invoicedScenario()
      try {
        const posting = await invoiced.post()
        const created = await invoiced.createInvoice()
        const submitted = await invoiced.submitInvoice(created.entityId)
        assert.equal(submitted.invoice.status, 'submitted')
        const invoiceLine = await prisma.supplierInvoiceLine.findFirst({ where: { supplierInvoiceId: created.entityId } })
        assert.equal(invoiceLine.receivingLineId, invoiced.scenario.receivingLines[0].id, 'production must link the invoice line to the receiving line')

        await expectCommandError(invoiced.reverse(), 'RECEIVING_REVERSAL_BLOCKED_BY_INVOICE')
        assert.equal(await prisma.inventoryMovement.count({ where: { tenantId: invoiced.scenario.tenantId, movementType: 'receipt_reversal' } }), 0)
        assert.equal((await prisma.receivingDocument.findUnique({ where: { id: invoiced.scenario.receivingDocumentId } })).postingStatus, 'posted')
        assert.equal((await prisma.inventoryMovement.findUnique({ where: { id: posting.movements[0].id } })).reversedByMovementId, null)
        assert.equal((await prisma.purchaseOrderLine.findUnique({ where: { id: invoiced.scenario.poLines[0].id } })).receivedQuantity.toString(), '4')
        assert.equal(await prisma.businessCommandExecution.count({ where: { tenantId: invoiced.scenario.tenantId, commandType: 'receiving.reverse' } }), 0)
      } finally {
        await invoiced.cleanup()
      }
    })

    await t.test('a draft supplier invoice does not hold the receipt', async () => {
      // A draft is not yet a claim against the receipt, so the reversal is
      // allowed. That is only safe because submission re-validates that the
      // receipt is still posted and not reversed. Both halves are asserted here
      // so the draft exemption cannot silently become a hole.
      const invoiced = await invoicedScenario()
      try {
        await invoiced.post()
        const created = await invoiced.createInvoice()
        const reversed = await invoiced.reverse()
        assert.equal(reversed.receivingDocument.postingStatus, 'reversed')

        await assert.rejects(invoiced.submitInvoice(created.entityId), (error) => error?.code === 'SUPPLIER_INVOICE_SOURCE_INVALID')
        const draft = await prisma.supplierInvoice.findUnique({ where: { id: created.entityId } })
        assert.equal(draft.status, 'draft', 'the draft stays a draft once its receipt is reversed')
      } finally {
        await invoiced.cleanup()
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
