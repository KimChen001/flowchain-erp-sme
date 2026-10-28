import assert from 'node:assert/strict'
import test from 'node:test'
import { backfillTenantAuthorization } from '../../server/auth/authorization-backfill.mjs'
import { createReceivingDraftCommandService } from '../../server/domain/receiving-draft-command-service.mjs'
import { createPrismaClient } from '../../server/persistence/prisma-client.mjs'

// The receiving form defaults each line's location to where the item already
// has most stock in the receiving warehouse, and offers the warehouse's known
// locations. Without that a new workspace's first receipt lands in a second
// stock record with no location next to the opening stock at A-01.
// Run with: node scripts/run-postgres-test-files.mjs tests/postgres/receiving-locations.test.mjs

const tenantId = 'tenant-receiving-locations'

test('receivable lines carry the item stock locations and each warehouse its known locations', async () => {
  assert.ok(process.env.DATABASE_URL_TEST, 'An isolated test database is required')
  const prisma = await createPrismaClient(process.env)
  try {
    await prisma.tenant.create({ data: { id: tenantId, name: tenantId, countryCode: 'US', locale: 'en-US', currency: 'USD', timezone: 'America/New_York' } })
    for (const [id, code] of [['RL-MAIN', 'MAIN'], ['RL-EAST', 'EAST'], ['RL-WEST', 'WEST']]) await prisma.warehouse.create({ data: { id, tenantId, code, name: code, status: 'active' } })
    await prisma.user.create({ data: { id: 'rl-admin', tenantId, email: 'rl-admin@receiving-locations.invalid', name: 'Admin', role: 'admin' } })
    await prisma.user.create({ data: { id: 'rl-clerk', tenantId, email: 'rl-clerk@receiving-locations.invalid', name: 'Clerk', role: 'business-specialist' } })
    await backfillTenantAuthorization(prisma, tenantId, { actorId: 'rl-admin' })
    await prisma.item.create({ data: { id: 'RL-ITEM-1', tenantId, sku: 'VALVE-100', name: 'Ball valve', unit: 'EA' } })
    await prisma.item.create({ data: { id: 'RL-ITEM-2', tenantId, sku: 'SEAL-400', name: 'Seal tape', unit: 'ROLL' } })
    await prisma.purchaseOrder.create({ data: { id: 'RL-PO', tenantId, status: 'issued', supplierId: 'RL-SUP', supplierName: 'Acme', currency: 'USD', amount: '100.0000', lines: { create: [
      { id: 'RL-POL-1', itemId: 'RL-ITEM-1', sku: 'VALVE-100', itemName: 'Ball valve', orderedQuantity: '50.0000', receivedQuantity: '0.0000', unit: 'EA', unitPrice: '1.0000', amount: '50.0000' },
      { id: 'RL-POL-2', itemId: 'RL-ITEM-2', sku: 'SEAL-400', itemName: 'Seal tape', orderedQuantity: '50.0000', receivedQuantity: '0.0000', unit: 'ROLL', unitPrice: '1.0000', amount: '50.0000' },
    ] } } })
    const balance = (id, sku, warehouseId, location, onHand) => prisma.inventoryBalance.create({ data: {
      id, tenantId, sku, warehouseId, warehouseKey: warehouseId, location, locationKey: (location || '').toLowerCase(),
      onHandQuantity: onHand, availableQuantity: onHand, reservedQuantity: '0.0000', unit: 'EA',
    } })
    // VALVE-100: most stock at A-01, a little at a-07, some with no location, and some in EAST.
    await balance('RL-B1', 'VALVE-100', 'RL-MAIN', 'A-01', '25.0000')
    await balance('RL-B2', 'VALVE-100', 'RL-MAIN', 'A-07', '3.0000')
    await balance('RL-B3', 'VALVE-100', 'RL-MAIN', null, '30.0000')
    await balance('RL-B4', 'VALVE-100', 'RL-EAST', 'E-02', '4.0000')
    // Another item's location in MAIN, and a WEST balance the clerk may not see.
    await balance('RL-B5', 'PIPE-200', 'RL-MAIN', 'B-01', '120.0000')
    await balance('RL-B6', 'VALVE-100', 'RL-WEST', 'W-01', '99.0000')
    // A bin with no stock yet, one inactive bin, and a bin that repeats a stock location in another case.
    await prisma.warehouseLocation.create({ data: { id: 'RL-BIN-1', tenantId, warehouseId: 'RL-MAIN', code: 'DOCK', locationKey: 'dock', status: 'active' } })
    await prisma.warehouseLocation.create({ data: { id: 'RL-BIN-2', tenantId, warehouseId: 'RL-MAIN', code: 'OLD', locationKey: 'old', status: 'inactive' } })
    await prisma.warehouseLocation.create({ data: { id: 'RL-BIN-3', tenantId, warehouseId: 'RL-MAIN', code: 'a-01', locationKey: 'a-01', status: 'active' } })

    const drafts = createReceivingDraftCommandService({ prisma })
    const admin = { identity: { authenticated: true, tenantId, userId: 'rl-admin', role: 'admin', source: 'signed-session' } }
    const result = await drafts.listReceivablePurchaseOrders({ purchaseOrderId: 'RL-PO' }, admin)
    const [po] = result.items
    const valve = po.lines.find((line) => line.sku === 'VALVE-100')
    const seal = po.lines.find((line) => line.sku === 'SEAL-400')
    assert.deepEqual(valve.stockLocations, [
      { warehouseId: 'RL-WEST', location: 'W-01', onHandQuantity: '99.0000' },
      { warehouseId: 'RL-MAIN', location: 'A-01', onHandQuantity: '25.0000' },
      { warehouseId: 'RL-EAST', location: 'E-02', onHandQuantity: '4.0000' },
      { warehouseId: 'RL-MAIN', location: 'A-07', onHandQuantity: '3.0000' },
    ])
    assert.deepEqual(seal.stockLocations, [])
    const locations = Object.fromEntries(result.warehouses.map((row) => [row.code, row.locations]))
    // Bins first win the spelling when a stock location repeats them; inactive bins are left out.
    assert.deepEqual(locations.MAIN, ['a-01', 'A-07', 'B-01', 'DOCK'])
    assert.deepEqual(locations.EAST, ['E-02'])
    assert.deepEqual(locations.WEST, ['W-01'])

    // A clerk scoped to MAIN sees only MAIN's stock and locations.
    await prisma.userWarehouseScope.create({ data: { id: 'RL-SCOPE', tenantId, userId: 'rl-clerk', warehouseId: 'RL-MAIN', accessLevel: 'operate' } })
    const clerk = { identity: { authenticated: true, tenantId, userId: 'rl-clerk', role: 'business-specialist', source: 'signed-session' } }
    const scoped = await drafts.listReceivablePurchaseOrders({ purchaseOrderId: 'RL-PO' }, clerk)
    assert.deepEqual(scoped.warehouses.map((row) => row.code), ['MAIN'])
    assert.deepEqual(scoped.items[0].lines.find((line) => line.sku === 'VALVE-100').stockLocations.map((row) => row.location), ['A-01', 'A-07'])
  } finally {
    await prisma.$disconnect()
  }
})
