import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createPilotImportService } from './test-fixtures/legacy-pilot-import-service.mjs'
import { cleanupReceivingScenario, expectCommandError, seedReceivingScenario, withLiveReceivingDatabase } from './receiving-posting-live-test-helpers.mjs'

test('archived Pilot import prototype remains test-only and documents prior direct writes', async t => {
  await withLiveReceivingDatabase(t, async ({ prisma }) => {
    const scenario = await seedReceivingScenario(prisma)
    const identity = { ...scenario.actor, source: 'local_signed_session' }
    await prisma.user.create({ data: { id: identity.userId, tenantId: scenario.tenantId, email: 'pilot-import@example.com', name: 'Pilot Import Manager', role: 'manager', status: 'active' } })
    await prisma.userWarehouseScope.create({ data: { id: randomUUID(), tenantId: scenario.tenantId, userId: identity.userId, warehouseId: scenario.warehouseId, accessLevel: 'operate' } })
    const service = createPilotImportService({ prisma })
    const file = type => ({ importType: type, fileName: `${type}.xlsx`, fileSize: 1024, mapping: {} })
    async function previewAndCommit(importType, rows, key) {
      const preview = await service.preview({ ...file(importType), rows }, identity)
      assert.equal(preview.status, 'ready', `${importType} preview`)
      const committed = await service.commit(preview.id, { idempotencyKey: key }, identity)
      assert.equal(committed.status, 'completed'); assert.equal(committed.committedRows, rows.length)
      return { preview, committed }
    }
    try {
      const itemPreview = await service.preview({ ...file('items'), rows: [{ sku: 'PILOT-SKU', name: 'Pilot Item', unit: 'EA', status: 'active' }] }, identity)
      assert.equal(itemPreview.status, 'ready'); assert.equal(await prisma.item.count({ where: { tenantId: scenario.tenantId, sku: 'PILOT-SKU' } }), 0)
      const itemCommit = await service.commit(itemPreview.id, { idempotencyKey: 'items-1' }, identity)
      assert.equal(itemCommit.idempotentReplay, false); assert.equal((await service.commit(itemPreview.id, { idempotencyKey: 'items-1' }, identity)).idempotentReplay, true)
      await expectCommandError(service.commit((await service.preview({ ...file('items'), rows: [{ sku: 'PILOT-SKU-2', name: 'Second', unit: 'EA' }] }, identity)).id, { idempotencyKey: 'items-1' }, identity), 'IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD')

      await previewAndCommit('suppliers', [{ code: 'PILOT-SUP', name: 'Pilot Supplier', currency: 'CNY', status: 'active' }], 'suppliers-1')
      await prisma.user.update({ where: { id: identity.userId }, data: { role: 'admin' } }); identity.role = 'admin'
      await prisma.userRoleAssignment.deleteMany({ where: { userId: identity.userId } })
      await previewAndCommit('warehouses', [{ code: 'PILOT-WH', name: 'Pilot Warehouse', status: 'active' }], 'warehouses-1')
      await prisma.user.update({ where: { id: identity.userId }, data: { role: 'manager' } }); identity.role = 'manager'
      await prisma.userRoleAssignment.deleteMany({ where: { userId: identity.userId } })
      await previewAndCommit('locations', [{ warehouseCode: (await prisma.warehouse.findUnique({ where: { id: scenario.warehouseId } })).code, code: ' B-01 ', name: 'Bin B01', status: 'active' }], 'locations-1')
      await previewAndCommit('open_purchase_orders', [{ poNumber: 'PILOT-PO-001', supplierCode: 'PILOT-SUP', sku: 'PILOT-SKU', orderedQuantity: '10', receivedQuantity: '2', unit: 'EA', currency: 'CNY', status: 'issued' }], 'po-1')

      const invalidOpening = await service.preview({ ...file('opening_inventory_balances'), rows: [{ sku: scenario.items[0].sku, warehouseCode: (await prisma.warehouse.findUnique({ where: { id: scenario.warehouseId } })).code, location: 'Z-01', quantity: '-1' }] }, identity)
      assert.equal(invalidOpening.status, 'blocked'); assert.equal(await prisma.inventoryMovement.count({ where: { tenantId: scenario.tenantId } }), 0)
      const opening = await previewAndCommit('opening_inventory_balances', [{ sku: scenario.items[0].sku, warehouseCode: (await prisma.warehouse.findUnique({ where: { id: scenario.warehouseId } })).code, location: 'Z-01', quantity: '5', unit: 'EA' }], 'opening-1')
      assert.equal(await prisma.inventoryMovement.count({ where: { tenantId: scenario.tenantId, movementType: 'opening_balance' } }), 1)
      assert.equal((await prisma.inventoryBalance.findFirst({ where: { tenantId: scenario.tenantId, sku: scenario.items[0].sku } })).onHandQuantity.toString(), '5')
      assert.ok((await prisma.tenant.findUnique({ where: { id: scenario.tenantId } })).openingBalanceLockedAt)
      assert.equal((await service.preview({ ...file('opening_inventory_balances'), rows: [{ sku: scenario.items[0].sku, warehouseCode: (await prisma.warehouse.findUnique({ where: { id: scenario.warehouseId } })).code, location: 'Z-02', quantity: '1' }] }, identity)).status, 'blocked')
      assert.equal(await prisma.auditLog.count({ where: { tenantId: scenario.tenantId, action: 'import_batch_committed' } }), 6)
      assert.equal((await service.getIssues(invalidOpening.id, identity)).issues.some(row => row.code === 'INVALID_QUANTITY'), true)
      assert.equal(opening.committed.committedRows, 1)
    } finally { await cleanupReceivingScenario(prisma, scenario) }
  })
})
