import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createReceivingPostingCommandService } from './receiving-posting-command-service.mjs'
import { createReceivingWorkbenchQueryService } from './receiving-workbench-query-service.mjs'
import { cleanupReceivingScenario, expectCommandError, seedReceivingScenario, withLiveReceivingDatabase } from './receiving-posting-live-test-helpers.mjs'

test('database receiving workbench query service is tenant-scoped, read-only, and fixed-scale', async (t) => {
  await withLiveReceivingDatabase(t, async ({ prisma }) => {
    const scenario = await seedReceivingScenario(prisma)
    const other = await seedReceivingScenario(prisma)
    try {
      const service = createReceivingWorkbenchQueryService({ prisma, capabilities: { posting: { enabled: true, maturity: 'beta' }, reversal: { enabled: true, maturity: 'beta' } } })
      const detail = await service.getReceivingDetail({ receivingDocumentId: scenario.receivingDocumentId }, { identity: scenario.actor })
      assert.equal(detail.receivingDocument.workflowStatus, 'approved')
      assert.equal(detail.receivingDocument.postingStatus, 'unposted')
      assert.equal(detail.purchaseOrder.workflowStatus, 'issued')
      assert.equal(detail.purchaseOrder.fulfillmentStatus, 'not_received')
      assert.equal(detail.lines[0].acceptedQuantity, '4.0000')
      assert.equal(detail.lines[0].documentAcceptedQuantity, '4.0000')
      assert.equal(detail.lines[0].currentlyAppliedQuantity, '0.0000')
      assert.equal(detail.lines[0].remainingReceivableQuantity, '10.0000')
      assert.equal(detail.availableActions.primaryAction, 'post')
      const deniedRole = await service.getReceivingDetail({ receivingDocumentId: scenario.receivingDocumentId }, { identity: { ...scenario.actor, role: 'viewer' } })
      assert.equal(deniedRole.availableActions.canPost, false)
      assert.equal(deniedRole.availableActions.blockingReasonCodes.includes('PERMISSION_DENIED'), true)
      const disabledService = createReceivingWorkbenchQueryService({ prisma, capabilities: { posting: { enabled: false }, reversal: { enabled: false } } })
      assert.equal((await disabledService.getReceivingDetail({ receivingDocumentId: scenario.receivingDocumentId }, { identity: scenario.actor })).availableActions.blockingReasonCodes.includes('CAPABILITY_NOT_AVAILABLE'), true)
      for (const workflowStatus of ['ready_for_receiving', 'partially_received']) {
        await prisma.receivingDocument.update({ where: { id: scenario.receivingDocumentId }, data: { workflowStatus } })
        assert.equal((await service.getReceivingDetail({ receivingDocumentId: scenario.receivingDocumentId }, { identity: scenario.actor })).availableActions.canPost, true)
      }
      await prisma.receivingDocument.update({ where: { id: scenario.receivingDocumentId }, data: { workflowStatus: 'draft' } })
      assert.equal((await service.getReceivingDetail({ receivingDocumentId: scenario.receivingDocumentId }, { identity: scenario.actor })).availableActions.canPost, false)
      await prisma.receivingDocument.update({ where: { id: scenario.receivingDocumentId }, data: { workflowStatus: 'approved' } })
      assert.equal(detail.lines[0].lotSerialCapability.postingAvailable, false)

      const before = {
        movements: await prisma.inventoryMovement.count(), balances: await prisma.inventoryBalance.count(),
        audits: await prisma.auditLog.count(), commands: await prisma.businessCommandExecution.count(),
      }
      const preview = await service.getReceivingImpactPreview({ receivingDocumentId: scenario.receivingDocumentId, operation: 'post' }, { identity: scenario.actor })
      assert.equal(preview.allowed, true)
      assert.equal(preview.inventoryImpacts[0].onHandBefore, '0.0000')
      assert.equal(preview.inventoryImpacts[0].onHandAfter, '4.0000')
      assert.equal(preview.statusImpact.poFulfillmentAfter, 'partially_received')
      assert.deepEqual({ movements: await prisma.inventoryMovement.count(), balances: await prisma.inventoryBalance.count(), audits: await prisma.auditLog.count(), commands: await prisma.businessCommandExecution.count() }, before)

      await expectCommandError(service.getReceivingDetail({ receivingDocumentId: other.receivingDocumentId }, { identity: scenario.actor }), 'RECEIVING_NOT_FOUND')
      const command = createReceivingPostingCommandService({ prisma, env: { NODE_ENV: 'test' } })
      await command.postReceiving({ receivingDocumentId: scenario.receivingDocumentId, idempotencyKey: 'query-post' }, { identity: scenario.actor })
      await prisma.userWarehouseScope.upsert({ where: { tenantId_userId_warehouseId: { tenantId: scenario.tenantId, userId: scenario.actor.userId, warehouseId: scenario.warehouseId } }, create: { id: randomUUID(), tenantId: scenario.tenantId, userId: scenario.actor.userId, warehouseId: scenario.warehouseId, accessLevel: 'operate' }, update: { accessLevel: 'operate' } })
      const links = await service.getReceivingSmartLinks({ receivingDocumentId: scenario.receivingDocumentId }, { identity: scenario.actor })
      assert.equal(links.links.find((link) => link.label === 'Movements').count, 1)
      assert.equal(links.links.find((link) => link.label === 'Movements').targetRouteId, 'inventory:movements')
      assert.equal(links.links.find((link) => link.label === 'Audit').count, 1)
      const reconciliation = await service.getReceivingReconciliation({ receivingDocumentId: scenario.receivingDocumentId }, { identity: scenario.actor })
      assert.equal(reconciliation.status, 'matched')
      assert.equal(reconciliation.entries[0].calculatedQuantity, '4.0000')
      assert.equal(reconciliation.entries[0].recordedQuantity, '4.0000')
      const evidence = await service.getReceivingEvidenceTimeline({ receivingDocumentId: scenario.receivingDocumentId }, { identity: scenario.actor })
      assert.equal(evidence.events.some((event) => event.type === 'business_fact' && event.event === 'inventory_movement_created'), true)
      assert.equal(evidence.events.some((event) => event.type === 'audit' && event.event === 'receiving_posted'), true)
      assert.equal(evidence.events.some((event) => event.event === 'purchase_order_line_received_changed'), true)
      assert.equal(evidence.events.some((event) => event.event === 'purchase_order_fulfillment_changed' && event.data.before === 'not_received' && event.data.after === 'partially_received'), true)
      assert.equal(evidence.events.some((event) => event.type === 'limitation'), true)
      // Labels name statuses and movement types in words, never the stored codes.
      assert.equal(evidence.events.find((event) => event.event === 'purchase_order_fulfillment_changed').label, 'PO fulfillment Not received → Partially received')
      assert.match(evidence.events.find((event) => event.event === 'inventory_movement_created').label, /^Receipt posting · /)
      assert.equal(evidence.events.some((event) => /[a-z]+_[a-z]+/.test(event.label)), false)

      const postedDetail = await service.getReceivingDetail({ receivingDocumentId: scenario.receivingDocumentId }, { identity: scenario.actor })
      assert.equal(postedDetail.lines[0].previouslyReceivedQuantity, '0.0000')
      assert.equal(postedDetail.lines[0].currentlyAppliedQuantity, '4.0000')
      assert.equal(postedDetail.lines[0].remainingReceivableQuantity, '6.0000')
      assert.equal(postedDetail.availableActions.primaryAction, 'reverse')

      const reverse = await service.getReceivingImpactPreview({ receivingDocumentId: scenario.receivingDocumentId, operation: 'reverse' }, { identity: scenario.actor })
      assert.equal(reverse.allowed, true)
      await prisma.inventoryMovement.create({ data: { id: randomUUID(), tenantId: scenario.tenantId, itemId: scenario.items[0].itemId, sku: scenario.items[0].sku, warehouseId: scenario.warehouseId, location: 'A-01', locationKey: 'a-01', movementType: 'outbound_posting', sourceDocumentType: 'shipment', sourceDocumentId: randomUUID(), sourceDocumentLineId: randomUUID(), quantityIn: '0', quantityOut: '1', adjustmentQty: '0', status: 'posted', occurredAt: new Date(Date.now() + 1000), movementDate: new Date(Date.now() + 1000) } })
      const unsafe = await service.getReceivingImpactPreview({ receivingDocumentId: scenario.receivingDocumentId, operation: 'reverse' }, { identity: scenario.actor })
      assert.equal(unsafe.allowed, false)
      assert.equal(unsafe.blockingIssues.some((issue) => issue.code === 'RECEIVING_REVERSAL_NOT_SAFE'), true)
      const summary = await service.getPurchaseOrderReceivingSummary({ purchaseOrderId: scenario.poId }, { identity: scenario.actor })
      assert.equal(summary.receiptsCount, 1)
      assert.equal(summary.receivedQuantitySummary, '4.0000')

      const otherCommand = createReceivingPostingCommandService({ prisma, env: { NODE_ENV: 'test' } })
      await otherCommand.postReceiving({ receivingDocumentId: other.receivingDocumentId, idempotencyKey: 'query-other-post' }, { identity: other.actor })
      await otherCommand.reverseReceiving({ receivingDocumentId: other.receivingDocumentId, idempotencyKey: 'query-other-reverse', reason: 'Detail state regression' }, { identity: other.actor })
      await prisma.userWarehouseScope.upsert({ where: { tenantId_userId_warehouseId: { tenantId: other.tenantId, userId: other.actor.userId, warehouseId: other.warehouseId } }, create: { id: randomUUID(), tenantId: other.tenantId, userId: other.actor.userId, warehouseId: other.warehouseId, accessLevel: 'operate' }, update: { accessLevel: 'operate' } })
      const reversedDetail = await service.getReceivingDetail({ receivingDocumentId: other.receivingDocumentId }, { identity: other.actor })
      assert.equal(reversedDetail.lines[0].currentlyAppliedQuantity, '0.0000')
      assert.equal(reversedDetail.lines[0].remainingReceivableQuantity, '10.0000')
      assert.equal(reversedDetail.availableActions.canViewReversal, true)
      assert.equal(reversedDetail.availableActions.primaryAction, 'view_reversal')
      const reversedEvidence = await service.getReceivingEvidenceTimeline({ receivingDocumentId: other.receivingDocumentId }, { identity: other.actor })
      assert.equal(reversedEvidence.events.some((event) => event.event === 'purchase_order_line_received_changed' && event.data.receivedBefore === '4.0000' && event.data.receivedAfter === '0.0000'), true)
      assert.equal(reversedEvidence.events.some((event) => event.event === 'purchase_order_fulfillment_changed' && event.data.before === 'partially_received' && event.data.after === 'not_received'), true)
    } finally {
      await cleanupReceivingScenario(prisma, scenario)
      await cleanupReceivingScenario(prisma, other)
    }
  })
})
