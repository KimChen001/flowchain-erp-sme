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

const po = (id, status, lines) => ({ id, status, lines })
const poLine = (sku, orderedQuantity, receivedQuantity) => ({ id: `${sku}-po-line`, sku, itemId: `ITEM-${sku}`, quantity: orderedQuantity, orderedQuantity, receivedQuantity })

test('walkthrough scenario: LDM-001 ATP is +3 with the partially received PO counted at its remaining quantity', () => {
  // scripts/setup-local-scenario.mjs: 8 on hand, a 35 unit sales order, and
  // LOCAL-DEMO-PO-001 partially received (20 of 50), so 30 are still in transit.
  const model = buildRuntimeInventoryAllocation(context({
    inventoryItems: [balance('LDM-001', 8), balance('LDM-002', 60)],
    salesOrders: [salesOrder('LOCAL-DEMO-SO-001', [soLine('LDM-001', 35)])],
    purchaseOrders: [
      po('LOCAL-DEMO-PO-001', 'partially_received', [poLine('LDM-001', 50, 20)]),
      po('LOCAL-DEMO-PO-002', 'issued', [poLine('LDM-002', 40, 0)]),
    ],
  }))
  const ldm1 = getRuntimeSkuAvailability(model, 'LDM-001')
  assert.equal(ldm1.incomingApprovedPo, 30)
  assert.equal(ldm1.shortage, 27)
  assert.equal(ldm1.availableToPromise, 3)
  assert.deepEqual(ldm1.purchaseOrderIds, ['LOCAL-DEMO-PO-001'])
  assert.equal(getRuntimeSkuAvailability(model, 'LDM-002').incomingApprovedPo, 40)
  assert.equal(model.summary.incomingPurchaseQty, 70)
  assert.equal(model.summary.atpInsufficientSkuCount, 0)
})

test('in transit counts the unreceived remainder of open committed purchase orders only', () => {
  const model = buildRuntimeInventoryAllocation(context({
    inventoryItems: [balance('SKU', 0)],
    purchaseOrders: [
      po('PO-APPROVED', 'approved', [poLine('SKU', 5, 0)]),
      po('PO-ISSUED', 'issued', [poLine('SKU', 10, 4)]),
      po('PO-PARTIAL', 'partially_received', [poLine('SKU', 50, 20)]),
      po('PO-ALIAS', '部分收货', [poLine('SKU', 7, 6)]),
      po('PO-OVER', 'partially_received', [poLine('SKU', 3, 5)]),
      ...['draft', 'pending_approval', 'rejected', 'fully_received', 'cancelled', 'unknown_status'].map(status => po(`PO-${status}`, status, [poLine('SKU', 100, 0)])),
    ],
  }))
  const row = getRuntimeSkuAvailability(model, 'SKU')
  assert.equal(row.incomingApprovedPo, 5 + 6 + 30 + 1 + 0)
  assert.deepEqual(row.purchaseOrderIds, ['PO-APPROVED', 'PO-ISSUED', 'PO-PARTIAL', 'PO-ALIAS'], 'a fully received line is not linked as supply')
})

test('an open purchase order line with an unknown received quantity leaves in transit and ATP unknown', () => {
  const model = buildRuntimeInventoryAllocation(context({
    inventoryItems: [balance('SKU', 10)],
    purchaseOrders: [po('PO-1', 'issued', [{ sku: 'SKU', orderedQuantity: 10 }])],
  }))
  const row = getRuntimeSkuAvailability(model, 'SKU')
  assert.equal(row.incomingApprovedPo, null)
  assert.equal(row.availableToPromise, null)
  assert.ok(row.dataLimitations.includes('open_po_remaining_quantity_missing:SKU'))
})
