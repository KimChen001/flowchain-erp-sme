import assert from 'node:assert/strict'
import test from 'node:test'
import { createDbSalesOrderReadRepository } from '../repositories/db-sales-order-read-repository.mjs'

const row = {
  id: 'SO-DB-1',
  tenantId: 'tenant-a',
  orderNumber: 'SO-DB-1',
  customerId: 'CUS-1',
  customerName: 'Database Customer',
  workflowStatus: 'confirmed',
  reservationStatus: 'partially_reserved',
  fulfillmentStatus: 'not_fulfilled',
  promisedDate: new Date('2030-01-20T00:00:00Z'),
  currency: 'CNY',
  lines: [{
    id: 'SOL-1',
    itemId: 'ITEM-1',
    sku: 'SKU-1',
    itemName: 'Database Item',
    orderedQuantity: 35,
    reservedQuantity: 8,
    fulfilledQuantity: 0,
    unit: 'pcs',
  }],
}

test('PostgreSQL sales demand repository is tenant scoped and derives risk from authoritative order lines', async () => {
  const calls = []
  const repository = createDbSalesOrderReadRepository({
    env: { DATABASE_URL: 'postgresql://flowchain:test@127.0.0.1:5432/flowchain_test' },
    prisma: {
      salesOrder: {
        async findMany(args) {
          calls.push(args)
          return [row]
        },
      },
    },
  })

  const orders = await repository.listOrders({ tenantId: 'tenant-a' })
  assert.equal(calls[0].where.tenantId, 'tenant-a')
  assert.equal(orders[0].salesOrderId, 'SO-DB-1')
  assert.equal(orders[0].shortageQty, 27)
  assert.equal(orders[0].deliveryRiskLevel, 'high')
  assert.equal(orders[0].linkedPurchaseOrders.length, 0)
  assert.equal(orders[0].dataLimitations.includes('purchase_supply_not_joined'), true)

  const summary = await repository.getSummary({ tenantId: 'tenant-a' })
  assert.deepEqual(summary, {
    totalOrders: 1,
    riskOrderCount: 1,
    highRiskOrderCount: 1,
    shortageQty: 27,
    reservedQty: 8,
    affectedCustomerCount: 1,
  })
})

test('PostgreSQL sales demand repository never manufactures rows for an empty workspace', async () => {
  const repository = createDbSalesOrderReadRepository({
    env: { DATABASE_URL: 'postgresql://flowchain:test@127.0.0.1:5432/flowchain_test' },
    prisma: { salesOrder: { findMany: async () => [] } },
  })
  assert.deepEqual(await repository.listOrders({ tenantId: 'tenant-empty' }), [])
  assert.equal((await repository.getSummary({ tenantId: 'tenant-empty' })).totalOrders, 0)
})
