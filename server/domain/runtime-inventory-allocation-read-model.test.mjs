import test from 'node:test'
import assert from 'node:assert/strict'
import { buildRuntimeInventoryAllocation, getRuntimeSkuAvailability } from './runtime-inventory-allocation-read-model.mjs'
import { createDbMasterDataRepository } from '../repositories/db-master-data-repository.mjs'

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

const master = (sku, safetyStock, reorderPoint) => ({ id: `ITEM-${sku}`, itemId: `ITEM-${sku}`, sku, itemName: sku, safetyStock, reorderPoint })

test('stock status uses the item master safety stock and reorder point', () => {
  const model = buildRuntimeInventoryAllocation(context({
    items: [master('OUT', 10, 20), master('SAFETY', 10, 20), master('REORDER', 10, 20), master('OK', 10, 20), master('RESERVED', 10, 20)],
    inventoryItems: [balance('OUT', 0), balance('SAFETY', 8), balance('REORDER', 20), balance('OK', 21), balance('RESERVED', 12, { reservedQuantity: 12 })],
  }))
  const status = sku => getRuntimeSkuAvailability(model, sku)
  assert.equal(status('OUT').stockStatus, 'out_of_stock')
  assert.equal(status('SAFETY').stockStatus, 'below_safety_stock')
  assert.equal(status('REORDER').stockStatus, 'below_reorder_point')
  assert.equal(status('OK').stockStatus, 'ok')
  assert.equal(status('RESERVED').stockStatus, 'out_of_stock', 'fully reserved stock has nothing available')
  assert.equal(status('SAFETY').safetyStock, 10)
  assert.equal(status('SAFETY').reorderPoint, 20)
  assert.deepEqual(model.summary.stockStatusCounts, { out_of_stock: 2, below_safety_stock: 1, below_reorder_point: 1, ok: 1, unknown: 0 })
})

test('an out-of-stock or below-safety-stock SKU without open demand is medium risk, not low', () => {
  const model = buildRuntimeInventoryAllocation(context({
    items: [master('OUT', 5, 5), master('SAFETY', 10, 10), master('REORDER', 10, 20)],
    inventoryItems: [balance('OUT', 0), balance('SAFETY', 8), balance('REORDER', 15)],
  }))
  assert.equal(getRuntimeSkuAvailability(model, 'OUT').shortage, 0)
  assert.equal(getRuntimeSkuAvailability(model, 'OUT').riskLevel, 'medium')
  assert.equal(getRuntimeSkuAvailability(model, 'SAFETY').riskLevel, 'medium')
  assert.equal(getRuntimeSkuAvailability(model, 'REORDER').riskLevel, 'low')
  assert.deepEqual(model.risks.map(row => row.sku), ['OUT', 'SAFETY'])
  assert.equal(model.summary.highRiskSkuCount, 0, 'high stays reserved for unmet sales demand')
})

test('the reorder point is compared with the inventory position, so open supply already covers it', () => {
  const model = buildRuntimeInventoryAllocation(context({
    items: [master('SKU', 10, 20)],
    inventoryItems: [balance('SKU', 15)],
    purchaseOrders: [po('PO-1', 'issued', [poLine('SKU', 30, 0)])],
    salesOrders: [salesOrder('SO-1', [soLine('SKU', 5)])],
  }))
  const row = getRuntimeSkuAvailability(model, 'SKU')
  assert.equal(row.availableToPromise, 40)
  assert.equal(row.stockStatus, 'ok', '15 available + 30 in transit - 5 demand = 40, above the reorder point of 20')
})

test('without master thresholds the inventory balance values are used; unknown stock stays unknown', () => {
  const model = buildRuntimeInventoryAllocation(context({
    items: [master('BAL', 0, 0)],
    inventoryItems: [balance('BAL', 3, { safetyStock: 4, reorderPoint: 6 }), balance('NONE', 50), { sku: 'UNKNOWN' }],
  }))
  assert.equal(getRuntimeSkuAvailability(model, 'BAL').stockStatus, 'below_safety_stock')
  assert.equal(getRuntimeSkuAvailability(model, 'BAL').safetyStock, 4)
  assert.equal(getRuntimeSkuAvailability(model, 'NONE').stockStatus, 'ok')
  assert.equal(getRuntimeSkuAvailability(model, 'NONE').safetyStock, null)
  assert.equal(getRuntimeSkuAvailability(model, 'UNKNOWN').stockStatus, 'unknown')
})

test('item master safety stock and reorder point columns reach the allocation', async () => {
  // Item.safetyStock and Item.reorderPoint are columns; the walkthrough seed and
  // the master data import write them there, not into metadata.
  const decimal = value => ({ toNumber: () => value })
  const prisma = { item: { findMany: async () => [{ id: 'ITEM-LDM', tenantId: 't', sku: 'LDM', name: 'Flow Controller', unit: 'pcs', safetyStock: decimal(10), reorderPoint: decimal(20), metadata: {} }] } }
  const repository = createDbMasterDataRepository({ env: { FLOWCHAIN_PERSISTENCE_MODE: 'database', DATABASE_URL: 'postgresql://127.0.0.1:1/unused' }, prisma })
  const items = await repository.listItems({ tenantId: 't' })
  assert.equal(items[0].safetyStock, 10)
  assert.equal(items[0].reorderPoint, 20)
  const model = buildRuntimeInventoryAllocation(context({ items, inventoryItems: [balance('LDM', 8, { safetyStock: 0, reorderPoint: 0 })] }))
  assert.equal(getRuntimeSkuAvailability(model, 'LDM').stockStatus, 'below_safety_stock')
})

test('reserving stock for an order does not turn the order into a shortage', () => {
  // 120 on hand and a confirmed order for 100, before and after the order
  // reserves its 100 units, then after 40 of them ship.
  const at = (onHandQuantity, reservedQuantity, fulfilledQuantity) => getRuntimeSkuAvailability(buildRuntimeInventoryAllocation(context({
    inventoryItems: [balance('SKU-R', onHandQuantity, { reservedQuantity })],
    salesOrders: [salesOrder('SO-R', [soLine('SKU-R', 100, reservedQuantity, fulfilledQuantity)])],
  })), 'SKU-R')
  for (const [label, row] of [['before', at(120, 0, 0)], ['reserved', at(120, 100, 0)], ['part shipped', at(80, 60, 40)]]) {
    assert.equal(row.shortage, 0, label)
    assert.equal(row.availableToPromise, 20, label)
    assert.equal(row.riskLevel, 'low', label)
  }
  const reserved = at(120, 100, 0)
  assert.deepEqual([reserved.available, reserved.openSalesDemand, reserved.unreservedSalesDemand], [20, 100, 0])
})

test('another order still competes for the stock left after a reservation', () => {
  const model = buildRuntimeInventoryAllocation(context({
    inventoryItems: [balance('SKU-S', 120, { reservedQuantity: 100 })],
    salesOrders: [salesOrder('SO-S1', [soLine('SKU-S', 100, 100)]), salesOrder('SO-S2', [{ ...soLine('SKU-S', 50), id: 'SKU-S-line-2' }])],
  }))
  const row = getRuntimeSkuAvailability(model, 'SKU-S')
  assert.equal(row.available, 20)
  assert.equal(row.unreservedSalesDemand, 50)
  assert.equal(row.shortage, 30)
  assert.equal(row.availableToPromise, -30)
  assert.equal(row.riskLevel, 'high')
  assert.equal(model.summary.highRiskSkuCount, 1)
})

const unitPo = (id, lines, extra = {}) => ({ id, orderNumber: id, status: 'issued', lines, ...extra })
const unitPoLine = (id, sku, orderedQuantity, unit, extra = {}) => ({ id, sku, itemId: `ITEM-${sku}`, orderedQuantity, receivedQuantity: 0, unit, ...extra })

test('incoming counts only purchase order lines in the item stock unit; other units are listed, not added', () => {
  const model = buildRuntimeInventoryAllocation(context({
    items: [{ sku: 'SKU-A', itemId: 'ITEM-SKU-A', unit: 'pcs' }],
    inventoryItems: [balance('SKU-A', 10)],
    purchaseOrders: [
      unitPo('PO-0039', [unitPoLine('L39', 'SKU-A', 30, 'PCS', { promisedDate: '2026-10-20' })], { expectedDate: '2026-10-25T00:00:00.000Z' }),
      unitPo('PO-0040', [unitPoLine('L40', 'SKU-A', 5, 'CASE')]),
      unitPo('PO-0041', [unitPoLine('L41', 'SKU-A', 7, 'pcs')], { expectedDate: '2026-11-02T00:00:00.000Z' }),
    ],
  }))
  const a = getRuntimeSkuAvailability(model, 'SKU-A')
  // Units compare without case: PCS is pcs. The 5 CASE are never added to pieces.
  assert.equal(a.incomingApprovedPo, 37)
  assert.equal(a.availableToPromise, 47)
  assert.deepEqual(a.purchaseOrderIds, ['PO-0039', 'PO-0041'])
  assert.ok(!a.evidence.some(row => row.entityId === 'PO-0040'))
  assert.deepEqual(a.incomingExcluded, [{ purchaseOrderId: 'PO-0040', orderNumber: 'PO-0040', lineId: 'L40', unit: 'CASE', remaining: 5 }])
  // The promised date wins over the order's expected date.
  assert.deepEqual(a.incomingLines, [
    { purchaseOrderId: 'PO-0039', orderNumber: 'PO-0039', lineId: 'L39', remaining: 30, dueDay: '2026-10-20' },
    { purchaseOrderId: 'PO-0041', orderNumber: 'PO-0041', lineId: 'L41', remaining: 7, dueDay: '2026-11-02' },
  ])
  assert.deepEqual(a.dataLimitations, ['po_line_unit_mismatch:SKU-A'])
  assert.equal(model.summary.incomingPurchaseQty, 37)
})

test('a purchase order line counts when its unit or the item unit is not recorded, and says so', () => {
  const model = buildRuntimeInventoryAllocation(context({
    items: [{ sku: 'SKU-A', unit: 'pcs' }, { sku: 'SKU-B', unit: '' }],
    inventoryItems: [balance('SKU-A', 0), balance('SKU-B', 0)],
    purchaseOrders: [unitPo('PO-1', [unitPoLine('L1', 'SKU-A', 4, ''), unitPoLine('L2', 'SKU-B', 6, 'CASE')])],
  }))
  const a = getRuntimeSkuAvailability(model, 'SKU-A')
  const b = getRuntimeSkuAvailability(model, 'SKU-B')
  assert.equal(a.incomingApprovedPo, 4)
  assert.equal(b.incomingApprovedPo, 6)
  assert.deepEqual(a.incomingExcluded, [])
  assert.deepEqual(a.incomingLines.map(line => line.dueDay), [''])
  assert.ok(a.dataLimitations.includes('po_line_unit_not_recorded:SKU-A'))
  assert.ok(b.dataLimitations.includes('po_line_unit_not_recorded:SKU-B'))
})

test('the stock unit comes from the recorded units, never from a truncated item list or the pcs placeholder', () => {
  // ZZ-100 is past the item list the context read (no master); its unit comes
  // from itemUnits, so 12 CASE are not added to pieces.
  const truncated = buildRuntimeInventoryAllocation(context({
    items: [],
    itemUnits: [{ sku: 'ZZ-100', itemId: 'ITEM-ZZ-100', unit: 'pcs' }],
    inventoryItems: [balance('ZZ-100', 10)],
    purchaseOrders: [unitPo('PO-0040', [unitPoLine('L40', 'ZZ-100', 12, 'CASE')])],
  }))
  const zz = getRuntimeSkuAvailability(truncated, 'ZZ-100')
  assert.equal(zz.incomingApprovedPo, 0)
  assert.deepEqual(zz.incomingExcluded.map(line => [line.orderNumber, line.unit, line.remaining]), [['PO-0040', 'CASE', 12]])
  assert.deepEqual(zz.dataLimitations, ['po_line_unit_mismatch:ZZ-100'])

  // An item read through the master data repository with no unit recorded:
  // baseUom is the 'pcs' placeholder, recordedUnit is ''. The EA line counts,
  // with the limitation, and is never set against the placeholder.
  const unitless = buildRuntimeInventoryAllocation(context({
    items: [{ sku: 'NU-1', itemId: 'ITEM-NU-1', baseUom: 'pcs', baseUnit: 'pcs', recordedUnit: '' }],
    inventoryItems: [balance('NU-1', 0)],
    purchaseOrders: [unitPo('PO-9', [unitPoLine('L9', 'NU-1', 50, 'EA')])],
  }))
  const nu = getRuntimeSkuAvailability(unitless, 'NU-1')
  assert.equal(nu.incomingApprovedPo, 50)
  assert.deepEqual(nu.incomingExcluded, [])
  assert.ok(nu.dataLimitations.includes('po_line_unit_not_recorded:NU-1'))

  // itemUnits wins over the master, and a line keyed by item id finds it too.
  const byId = buildRuntimeInventoryAllocation(context({
    items: [{ sku: 'K-1', itemId: 'ITEM-K-1', baseUom: 'pcs', recordedUnit: 'pcs' }],
    itemUnits: [{ sku: 'K-1', itemId: 'ITEM-K-1', unit: 'kg' }],
    inventoryItems: [balance('K-1', 0)],
    purchaseOrders: [unitPo('PO-K', [unitPoLine('LK', 'K-1', 5, 'KG'), unitPoLine('LK2', 'K-1', 2, 'pcs')])],
  }))
  assert.equal(getRuntimeSkuAvailability(byId, 'K-1').incomingApprovedPo, 5)
})
