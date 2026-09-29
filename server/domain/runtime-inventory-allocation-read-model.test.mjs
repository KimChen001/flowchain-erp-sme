import test from 'node:test'
import assert from 'node:assert/strict'
import { buildRuntimeInventoryAllocation, getRuntimeSkuAvailability } from './runtime-inventory-allocation-read-model.mjs'

// Sales orders as the PostgreSQL sales order read repository returns them: the
// order-level sku, itemId and quantities summarise the first line and the order
// total, and every line is listed under `lines`.
const salesOrder = (id, lines, extra = {}) => ({
  id,
  salesOrderId: id,
  workflowStatus: 'confirmed',
  sku: lines[0].sku,
  itemId: lines[0].itemId,
  orderedQty: lines.reduce((sum, line) => sum + line.orderedQuantity, 0),
  reservedQty: lines.reduce((sum, line) => sum + line.reservedQuantity, 0),
  fulfilledQty: lines.reduce((sum, line) => sum + line.fulfilledQuantity, 0),
  lines,
  ...extra,
})
const soLine = (sku, orderedQuantity, reservedQuantity = 0, fulfilledQuantity = 0) => ({ id: `${sku}-line`, itemId: `ITEM-${sku}`, sku, orderedQuantity, reservedQuantity, fulfilledQuantity })
const balance = (sku, onHandQuantity, extra = {}) => ({ sku, itemId: `ITEM-${sku}`, onHandQuantity, reservedQuantity: 0, ...extra })
const context = (overrides = {}) => ({ items: [], inventoryItems: [], salesOrders: [], purchaseOrders: [], dataLimitations: [], ...overrides })

test('multi-line sales order demand is booked on each line SKU, not the whole order on the first SKU', () => {
  const model = buildRuntimeInventoryAllocation(context({
    inventoryItems: [balance('SKU-A', 100), balance('SKU-B', 0)],
    salesOrders: [salesOrder('SO-MULTI', [soLine('SKU-A', 10), soLine('SKU-B', 45)])],
  }))
  const a = getRuntimeSkuAvailability(model, 'SKU-A')
  const b = getRuntimeSkuAvailability(model, 'SKU-B')
  assert.equal(a.openSalesDemand, 10)
  assert.equal(a.shortage, 0)
  assert.equal(a.availableToPromise, 90)
  assert.equal(b.openSalesDemand, 45)
  assert.equal(b.shortage, 45)
  assert.equal(b.availableToPromise, -45)
  assert.equal(b.riskLevel, 'high')
  assert.deepEqual(b.salesOrderIds, ['SO-MULTI'])
  assert.equal(model.summary.totalShortageQty, 45)
  assert.equal(model.summary.highRiskSkuCount, 1)
})

test('line demand subtracts fulfilment per line and sums lines of the same SKU across orders', () => {
  const model = buildRuntimeInventoryAllocation(context({
    inventoryItems: [balance('SKU-A', 5), balance('SKU-B', 20)],
    salesOrders: [
      // Line A is fully shipped; its fulfilment must not offset line B.
      salesOrder('SO-1', [soLine('SKU-A', 8, 0, 8), soLine('SKU-B', 12, 0, 2)]),
      salesOrder('SO-2', [soLine('SKU-B', 6), soLine('SKU-B', 4)]),
      salesOrder('SO-DRAFT', [soLine('SKU-B', 100)], { workflowStatus: 'draft' }),
    ],
  }))
  const a = getRuntimeSkuAvailability(model, 'SKU-A')
  const b = getRuntimeSkuAvailability(model, 'SKU-B')
  assert.equal(a.openSalesDemand, 0)
  assert.equal(b.openSalesDemand, 20, '10 open on SO-1 plus 6 + 4 on SO-2; the draft order is ignored')
  assert.equal(b.shortage, 0)
  assert.deepEqual(b.salesOrderIds, ['SO-1', 'SO-2'])
  assert.deepEqual(b.evidence.filter(row => row.entityType === 'sales_order').map(row => row.entityId), ['SO-1', 'SO-2'])
})

test('a line with an unknown quantity is reported for that SKU only', () => {
  const model = buildRuntimeInventoryAllocation(context({
    inventoryItems: [balance('SKU-A', 10), balance('SKU-B', 10)],
    salesOrders: [salesOrder('SO-1', [soLine('SKU-A', 4), { ...soLine('SKU-B', 0), orderedQuantity: null }])],
  }))
  assert.equal(getRuntimeSkuAvailability(model, 'SKU-A').openSalesDemand, 4)
  assert.equal(getRuntimeSkuAvailability(model, 'SKU-B').openSalesDemand, null)
  assert.ok(model.dataLimitations.includes('sales_demand_quantity_missing:SKU-B'))
  assert.ok(!model.dataLimitations.includes('sales_demand_quantity_missing:SKU-A'))
})

test('sales orders without lines keep using the order-level SKU and quantities', () => {
  const model = buildRuntimeInventoryAllocation(context({
    inventoryItems: [balance('SKU', 5)],
    salesOrders: [{ id: 'SO-FLAT', sku: 'SKU', workflowStatus: 'confirmed', orderedQty: 10, fulfilledQty: 0, reservedQty: 0 }],
  }))
  assert.equal(getRuntimeSkuAvailability(model, 'SKU').openSalesDemand, 10)
  assert.equal(getRuntimeSkuAvailability(model, 'SKU').shortage, 5)
})
