import test from 'node:test'
import assert from 'node:assert/strict'
import { DATABASE_CONFIG_ERROR } from '../persistence/persistence-config.mjs'
import { createDbInventoryReadRepository } from '../repositories/db-inventory-read-repository.mjs'

const env = {
  FLOWCHAIN_PERSISTENCE_MODE: 'database',
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/flowchain',
}

function createModel(records = []) {
  return { findMany: async () => records }
}

function createPrisma() {
  return {
    item: createModel([{
      id: 'ITEM-B200',
      sku: 'B200',
      name: 'Bracket B200',
      category: 'Metal',
      unit: 'pcs',
      safetyStock: 40,
      reorderPoint: 80,
      status: 'active',
      updatedAt: new Date('2026-06-03T00:00:00.000Z'),
      metadata: { supplier: 'DEF Metals', defaultWarehouseId: 'WH-MAIN', availableQuantity: 160, onHandQuantity: 160 },
    }]),
    inventoryBalance: createModel([{
      id: 'BAL-A100-WH',
      itemId: 'ITEM-A100',
      sku: 'A100',
      itemName: 'Motor A100',
      warehouseId: 'WH-MAIN',
      location: 'A-01',
      availableQuantity: 12,
      onHandQuantity: 18,
      reservedQuantity: 6,
      safetyStock: 50,
      reorderPoint: 80,
      unit: 'pcs',
      status: '',
      riskLevel: '高',
      updatedAt: new Date('2026-06-02T00:00:00.000Z'),
      metadata: { category: 'Components', supplier: 'ABC Components' },
    }]),
    inventoryLot: createModel([{
      id: 'LOT-A100-01',
      sku: 'A100',
      itemName: 'Motor A100',
      warehouseId: 'WH-MAIN',
      location: 'A-01',
      quantity: 12,
      qaStatus: '可用',
      expiryDate: new Date('2026-12-31T00:00:00.000Z'),
      supplierName: 'ABC Components',
      sourceDocument: 'GRN-1',
      status: '可用',
      updatedAt: new Date('2026-06-02T00:00:00.000Z'),
      metadata: {},
    }]),
    inventorySerial: createModel([{
      id: 'SN-A100-001',
      sku: 'A100',
      itemName: 'Motor A100',
      warehouseId: 'WH-MAIN',
      location: 'A-01',
      status: '在库',
      owner: 'Ops',
      sourceDocument: 'LOT-A100-01',
      updatedAt: new Date('2026-06-02T00:00:00.000Z'),
    }]),
    inventoryMovement: createModel([{
      id: 'IM-DB-1',
      sku: 'A100',
      itemName: 'Motor A100',
      warehouseId: 'WH-MAIN',
      location: 'A-01',
      movementType: 'StockAdjustment',
      movementLabel: 'Adjustment',
      movementDate: new Date('2026-06-04T00:00:00.000Z'),
      sourceDocument: 'ADJ-1',
      quantityIn: 0,
      quantityOut: 0,
      adjustmentQty: -2,
      status: '待复核',
      owner: 'Chen',
      unit: 'pcs',
      reason: 'Cycle count variance',
      evidence: [{ label: 'count', value: 'cycle' }],
      timeline: [{ label: 'created', value: '2026-06-04' }],
    }]),
    inventoryException: createModel([{
      id: 'IEX-DB-1',
      type: '库存调整',
      sku: 'A100',
      itemName: 'Motor A100',
      warehouseId: 'WH-MAIN',
      location: 'A-01',
      quantityImpact: -2,
      unit: 'pcs',
      status: '待复核',
      owner: 'Chen',
      linkedMovementId: 'IM-DB-1',
      linkedDocument: 'ADJ-1',
      nextAction: '复核库存影响',
      reason: 'Cycle count variance',
    }]),
  }
}

test('database inventory repository maps mocked Prisma rows to read contract shapes', async () => {
  const repository = createDbInventoryReadRepository({ env, prisma: createPrisma() })

  const items = await repository.listItems()
  const item = await repository.getItem('A100')
  const lots = await repository.listLots()
  const serials = await repository.listSerials()
  const movements = await repository.listMovements()
  const exceptions = await repository.listExceptions()
  const summary = await repository.getSummary()

  assert.equal(items.length, 2)
  assert.equal(item.sku, 'A100')
  assert.equal(item.availableQuantity, 12)
  assert.equal(item.status, '低库存')
  assert.equal(lots[0].lotId, 'LOT-A100-01')
  assert.equal(serials[0].serialId, 'SN-A100-001')
  assert.equal(movements[0].movementId, 'IM-DB-1')
  assert.equal(exceptions[0].linkedMovement, 'IM-DB-1')
  assert.equal(summary.itemCount, 2)
  assert.equal(summary.highRiskCount, 1)
})

test('database inventory repository aliases and missing DB config stay clean', async () => {
  const repository = createDbInventoryReadRepository({ env: { FLOWCHAIN_PERSISTENCE_MODE: 'database' } })

  await assert.rejects(
    () => repository.listItems(),
    (error) => error.message === DATABASE_CONFIG_ERROR && error.code === DATABASE_CONFIG_ERROR
  )

  const working = createDbInventoryReadRepository({ env, prisma: createPrisma() })
  assert.equal((await working.listInventoryItems())[0].sku, 'A100')
  assert.equal((await working.getInventoryItem('A100')).sku, 'A100')
})
