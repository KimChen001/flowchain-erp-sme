import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createReceivingPostingCommandService } from './receiving-posting-command-service.mjs'
import { createReceivingWorkbenchQueryService } from './receiving-workbench-query-service.mjs'
import { cleanupReceivingScenario, expectCommandError, seedReceivingScenario, withLiveReceivingDatabase } from './receiving-posting-live-test-helpers.mjs'

const capabilities = { posting: { enabled: true, maturity: 'beta' }, reversal: { enabled: true, maturity: 'beta' } }

test('preview and command share the authoritative receiving transaction policy', async (t) => {
  await withLiveReceivingDatabase(t, async ({ prisma }) => {
    async function assertBlocked(scenario, expectedCode, key) {
      const query = createReceivingWorkbenchQueryService({ prisma, capabilities })
      const preview = await query.getReceivingImpactPreview({ receivingDocumentId: scenario.receivingDocumentId, operation: 'post' }, { identity: scenario.actor })
      assert.equal(preview.allowed, false)
      assert.equal(preview.blockingIssues.some((issue) => issue.code === expectedCode), true)
      await expectCommandError(createReceivingPostingCommandService({ prisma }).postReceiving({ receivingDocumentId: scenario.receivingDocumentId, idempotencyKey: key }, { identity: scenario.actor }), expectedCode)
      assert.equal(await prisma.inventoryMovement.count({ where: { tenantId: scenario.tenantId } }), 0)
    }

    await t.test('accepted quantities are cumulative across lines referencing the same PO line', async () => {
      const scenario = await seedReceivingScenario(prisma, { ordered: ['10'], accepted: ['4'] })
      try {
        await prisma.receivingLine.create({ data: { id: `line-${randomUUID()}`, receivingDocumentId: scenario.receivingDocumentId, purchaseOrderLineId: scenario.poLines[0].id, itemId: scenario.items[0].itemId, sku: scenario.items[0].sku, acceptedQty: '7', rejectedQty: '0', warehouseId: scenario.warehouseId, location: 'A-01', locationKey: 'a-01' } })
        await assertBlocked(scenario, 'RECEIVING_OVER_RECEIPT', 'policy-cumulative')
      } finally { await cleanupReceivingScenario(prisma, scenario) }
    })

    const cases = [
      ['inactive warehouse', async (prismaClient, scenario) => prismaClient.warehouse.update({ where: { id: scenario.warehouseId }, data: { status: 'inactive' } })],
      ['mismatched item and SKU', async (prismaClient, scenario) => prismaClient.receivingLine.update({ where: { id: scenario.receivingLines[0].id }, data: { sku: `wrong-${randomUUID()}` } })],
      ['negative rejected quantity', async (prismaClient, scenario) => prismaClient.receivingLine.update({ where: { id: scenario.receivingLines[0].id }, data: { rejectedQty: '-1' } })],
      // Nothing accepted is allowed only with a rejected quantity (L1-14).
      ['neither accepted nor rejected', async (prismaClient, scenario) => prismaClient.receivingLine.update({ where: { id: scenario.receivingLines[0].id }, data: { acceptedQty: '0', rejectedQty: '0' } })],
      ['negative accepted quantity', async (prismaClient, scenario) => prismaClient.receivingLine.update({ where: { id: scenario.receivingLines[0].id }, data: { acceptedQty: '-1', rejectedQty: '2' } })],
      ['missing PO line reference', async (prismaClient, scenario) => prismaClient.receivingLine.update({ where: { id: scenario.receivingLines[0].id }, data: { purchaseOrderLineId: null } })],
    ]
    for (const [name, mutate] of cases) {
      await t.test(name, async () => {
        const scenario = await seedReceivingScenario(prisma)
        try { await mutate(prisma, scenario); await assertBlocked(scenario, 'RECEIVING_VALIDATION_FAILED', `policy-${name}`) }
        finally { await cleanupReceivingScenario(prisma, scenario) }
      })
    }

    await t.test('item and warehouse records from another tenant are rejected', async () => {
      const scenario = await seedReceivingScenario(prisma)
      const other = await seedReceivingScenario(prisma)
      try {
        await prisma.purchaseOrderLine.update({ where: { id: scenario.poLines[0].id }, data: { itemId: other.items[0].itemId, sku: other.items[0].sku } })
        await prisma.receivingLine.update({ where: { id: scenario.receivingLines[0].id }, data: { itemId: other.items[0].itemId, sku: other.items[0].sku, warehouseId: other.warehouseId } })
        await assertBlocked(scenario, 'RECEIVING_VALIDATION_FAILED', 'policy-cross-tenant-master')
      } finally { await cleanupReceivingScenario(prisma, scenario); await cleanupReceivingScenario(prisma, other) }
    })
  })
})
