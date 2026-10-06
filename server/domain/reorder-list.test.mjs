import test from 'node:test'
import assert from 'node:assert/strict'
import { buildReorderList, dailyDemand, orderByDay, preferredSupplierFor, recordedReorderPoint } from './reorder-list.mjs'

const TODAY = '2026-10-05'
const TZ = 'America/New_York'
const item = (sku, extra = {}) => ({ id: `ITEM-${sku}`, sku, name: `Item ${sku}`, unit: 'pcs', reorderPoint: 20, metadata: {}, preferredSupplierId: null, status: 'active', ...extra })
const allocation = (sku, extra = {}) => ({ sku, itemId: `ITEM-${sku}`, onHand: 50, reserved: 0, incomingLines: [], incomingExcluded: [], dataLimitations: [], ...extra })
const incoming = (orderNumber, remaining, dueDay = '') => ({ purchaseOrderId: orderNumber, orderNumber, lineId: `${orderNumber}-L1`, remaining, dueDay })
// One posted shipment line a day at 15:00 UTC (11:00 in New York), `days`
// days back from yesterday.
const shipments = (sku, days, quantityPerDay, unit = 'pcs') => Array.from({ length: days }, (_, index) => ({
  itemId: `ITEM-${sku}`, unit, quantity: quantityPerDay, postedAt: new Date(Date.parse(`${TODAY}T15:00:00Z`) - (index + 1) * 86400000).toISOString(),
}))
const build = (input) => buildReorderList({ today: TODAY, timeZone: TZ, ...input })
const rowOf = (list, sku) => list.rows.find((row) => row.sku === sku)

test('the order-by day floors the days until the position reaches the reorder point', () => {
  // 8 shipment days of 45 = 360 over 90 days: 4 a day.
  const list = build({
    items: [item('A'), item('B'), item('C')],
    allocationRows: [allocation('A', { onHand: 47.96 }), allocation('B', { onHand: 24 }), allocation('C', { onHand: 23.99 })],
    shipmentLines: [...shipments('A', 8, 45), ...shipments('B', 8, 45), ...shipments('C', 8, 45)],
  })
  const a = rowOf(list, 'A')
  assert.equal(a.demand.averageDailyDemand, 4)
  assert.equal(a.demand.shipmentDays, 8)
  // (47.96 - 20) / 4 = 6.99 days: order by today + 6.
  assert.equal(a.daysUntilOrderBy, 6)
  assert.equal(a.orderByDate, '2026-10-11')
  assert.equal(a.orderNow, false)
  // Exactly one day of demand above the point: tomorrow.
  assert.equal(rowOf(list, 'B').orderByDate, '2026-10-06')
  // 0.99 of a day above the point: today, but not "order now".
  const c = rowOf(list, 'C')
  assert.equal(c.orderByDate, TODAY)
  assert.equal(c.orderNow, false)
  assert.equal(c.shortfall, 0)
  assert.deepEqual(list.rows.map((row) => row.sku), ['C', 'B', 'A'])
})

test('at the reorder point the item is "order now", and the shortfall is reorder point minus position', () => {
  const list = build({
    items: [item('A'), item('B', { reorderPoint: 30 })],
    allocationRows: [allocation('A', { onHand: 25, reserved: 5 }), allocation('B', { onHand: 12.5, reserved: 0, incomingLines: [incoming('PO-1', 5, '2026-10-01')] })],
    shipmentLines: [...shipments('A', 8, 10), ...shipments('B', 8, 10)],
  })
  const a = rowOf(list, 'A')
  assert.equal(a.position, 20)
  assert.equal(a.orderNow, true)
  assert.equal(a.orderByDate, TODAY)
  assert.equal(a.shortfall, 0)
  assert.equal(a.purchaseRequest.quantity, null)
  const b = rowOf(list, 'B')
  assert.equal(b.position, 17.5)
  assert.equal(b.incoming, 5)
  assert.equal(b.shortfall, 12.5)
  assert.equal(b.purchaseRequest.quantity, 12.5)
  assert.equal(list.summary.orderNow, 2)
})

test('daily demand needs 8 shipment days in the 90 days before today; with 7 only items at the point are listed', () => {
  const seven = dailyDemand({ lines: shipments('A', 7, 10), stockUnit: 'pcs', today: TODAY, timeZone: TZ })
  assert.equal(seven.shipmentDays, 7)
  assert.equal(seven.averageDailyDemand, null)
  const eight = dailyDemand({ lines: shipments('A', 8, 10), stockUnit: 'pcs', today: TODAY, timeZone: TZ })
  assert.equal(eight.averageDailyDemand, 0.8889)
  assert.equal(eight.windowStart, '2026-07-07')
  assert.equal(eight.windowEnd, '2026-10-04')

  const list = build({
    items: [item('LOW'), item('HIGH')],
    allocationRows: [allocation('LOW', { onHand: 20 }), allocation('HIGH', { onHand: 21 })],
    shipmentLines: [...shipments('LOW', 7, 10), ...shipments('HIGH', 7, 10)],
  })
  const low = rowOf(list, 'LOW')
  assert.equal(low.orderNow, true)
  assert.equal(low.demand.enough, false)
  assert.equal(low.demand.shipmentDays, 7)
  assert.equal(rowOf(list, 'HIGH'), undefined)
  assert.equal(list.summary.aboveReorderPointWithoutHistory, 1)
})

test('shipments of today and of more than 90 days ago, and several lines on one day, count as the window says', () => {
  const lines = [
    ...shipments('A', 7, 10),
    // A second line on the same day is the same shipment day.
    { itemId: 'ITEM-A', unit: 'pcs', quantity: 5, postedAt: '2026-10-04T18:00:00Z' },
    // Today is outside the window; so is 91 days ago.
    { itemId: 'ITEM-A', unit: 'pcs', quantity: 100, postedAt: '2026-10-05T14:00:00Z' },
    { itemId: 'ITEM-A', unit: 'pcs', quantity: 100, postedAt: '2026-07-06T15:00:00Z' },
  ]
  const demand = dailyDemand({ lines, stockUnit: 'pcs', today: TODAY, timeZone: TZ })
  assert.equal(demand.shipmentDays, 7)
  assert.equal(demand.shippedQuantity, 75)
})

test('a shipment at 22:00 in New York counts on that New York day, not the UTC day', () => {
  // 2026-10-05T02:00Z is 22:00 on Oct 4 in New York: inside the window, the
  // 8th shipment day. In UTC it would be today and fall outside.
  const lines = [...shipments('A', 7, 10).map((line, index) => ({ ...line, postedAt: new Date(Date.parse(`${TODAY}T15:00:00Z`) - (index + 2) * 86400000).toISOString() })), { itemId: 'ITEM-A', unit: 'pcs', quantity: 10, postedAt: '2026-10-05T02:00:00Z' }]
  assert.equal(dailyDemand({ lines, stockUnit: 'pcs', today: TODAY, timeZone: TZ }).shipmentDays, 8)
  assert.equal(dailyDemand({ lines, stockUnit: 'pcs', today: TODAY, timeZone: 'UTC' }).shipmentDays, 7)
})

test('units: shipments and purchase order lines in another unit are flagged and never counted', () => {
  const list = build({
    items: [item('A', { unit: 'pcs', metadata: { purchaseUnit: 'CASE' } })],
    allocationRows: [allocation('A', { onHand: 10, incomingLines: [incoming('PO-0039', 4, '2026-10-02')], incomingExcluded: [{ purchaseOrderId: 'PO-0040', orderNumber: 'PO-0040', lineId: 'L40', unit: 'CASE', remaining: 5 }], dataLimitations: ['po_line_unit_mismatch:A'] })],
    shipmentLines: [...shipments('A', 8, 9), { itemId: 'ITEM-A', unit: 'CASE', quantity: 3, postedAt: '2026-10-01T15:00:00Z' }],
  })
  const a = rowOf(list, 'A')
  assert.equal(a.incoming, 4)
  assert.equal(a.position, 14)
  assert.equal(a.demand.shippedQuantity, 72)
  assert.deepEqual(a.flags.filter((flag) => ['po_line_other_unit', 'shipment_other_unit', 'purchase_unit_differs'].includes(flag.code)), [
    { code: 'po_line_other_unit', orderNumber: 'PO-0040', unit: 'CASE' },
    { code: 'shipment_other_unit', unit: 'CASE', count: 1 },
    { code: 'purchase_unit_differs', unit: 'CASE' },
  ])
  // The request line would be in CASE: the person enters the quantity.
  assert.equal(a.shortfall, 6)
  assert.equal(a.purchaseRequest.quantity, null)
  // Without purchase order access the flag names no order.
  const hidden = buildReorderList({ ...{ items: [item('A')], allocationRows: [allocation('A', { onHand: 10, incomingExcluded: [{ orderNumber: 'PO-0040', unit: 'CASE', remaining: 5 }] })] }, today: TODAY, timeZone: TZ, showPurchaseOrders: false })
  assert.deepEqual(rowOf(hidden, 'A').flags.find((flag) => flag.code === 'po_line_other_unit'), { code: 'po_line_other_unit', orderNumber: null, unit: 'CASE' })
})

test('only a recorded reorder point is judged: none, 0 and safety stock alone are not', () => {
  assert.equal(recordedReorderPoint({ reorderPoint: null, metadata: { reorderPoint: 12 } }), 12)
  assert.equal(recordedReorderPoint({ reorderPoint: '0.0000' }), null)
  assert.equal(recordedReorderPoint({ reorderPoint: null, safetyStock: 30 }), null)
  const list = build({
    items: [item('NONE', { reorderPoint: null, safetyStock: 30 }), item('ZERO', { reorderPoint: 0 }), item('OFF', { status: 'inactive' }), item('SET', { reorderPoint: 25 })],
    allocationRows: [allocation('NONE', { onHand: 0 }), allocation('ZERO', { onHand: 0 }), allocation('OFF', { onHand: 0 }), allocation('SET', { onHand: 0 })],
  })
  assert.deepEqual(list.rows.map((row) => row.sku), ['SET'])
  assert.deepEqual(list.noReorderPoint, { count: 2, href: '/app/master-data/items' })
})

test('incomplete stock is not judged', () => {
  const list = build({
    items: [item('NOBAL'), item('NORES'), item('NOREM')],
    allocationRows: [allocation('NORES', { reserved: null }), allocation('NOREM', { incomingLines: [incoming('PO-1', null)] })],
  })
  assert.deepEqual(list.rows, [])
  assert.deepEqual(list.notJudged.map((row) => [row.sku, row.reason]), [['NOBAL', 'stock_incomplete'], ['NOREM', 'stock_incomplete'], ['NORES', 'stock_incomplete']])
})

test('ties on the order-by day rank by SKU, never by a score', () => {
  const list = build({
    items: [item('b-200'), item('A-100'), item('a-050')],
    allocationRows: [allocation('b-200', { onHand: 5 }), allocation('A-100', { onHand: 0 }), allocation('a-050', { onHand: 19 })],
  })
  assert.deepEqual(list.rows.map((row) => row.sku), ['a-050', 'A-100', 'b-200'])
  assert.ok(list.rows.every((row) => !('score' in row)))
})

test('incoming due after the order-by day is left out, and the day computed again until it stops moving', () => {
  // 4 a day. Position 30 + 40 + 40 = 110 against 20: (110 - 20) / 4 = 22 days
  // (Oct 27). PO-LATE is due Nov 30, after it: (70 - 20) / 4 = 12 days
  // (Oct 17). PO-MID is due Oct 20, after that: (30 - 20) / 4 = 2 days (Oct 7).
  const list = build({
    items: [item('A')],
    allocationRows: [allocation('A', { onHand: 30, incomingLines: [incoming('PO-MID', 40, '2026-10-20'), incoming('PO-LATE', 40, '2026-11-30'), incoming('PO-NODATE', 0.0001)] })],
    shipmentLines: shipments('A', 8, 45),
  })
  const a = rowOf(list, 'A')
  assert.equal(a.orderByDate, '2026-10-07')
  assert.equal(a.incoming, 0.0001)
  assert.deepEqual(a.incomingLines.map((line) => [line.orderNumber, line.counted]), [['PO-MID', false], ['PO-LATE', false], ['PO-NODATE', true]])
  assert.deepEqual(a.flags.map((flag) => flag.code), ['po_line_due_after_order_by', 'po_line_due_after_order_by', 'po_line_no_due_day'])
  // Without daily demand every line counts, and the row says so.
  const noHistory = build({ items: [item('A')], allocationRows: [allocation('A', { onHand: 0, incomingLines: [incoming('PO-LATE', 10, '2026-11-30')] })] })
  assert.equal(rowOf(noHistory, 'A').incoming, 10)
  assert.ok(rowOf(noHistory, 'A').flags.some((flag) => flag.code === 'all_incoming_counted'))
})

test('the preferred supplier shows its lead time and minimum order quantity only when recorded', () => {
  const suppliers = new Map([['SUP-1', { id: 'SUP-1', code: 'S1', name: 'Acme', status: 'active' }], ['SUP-2', { id: 'SUP-2', name: 'Beta', status: 'inactive' }], ['SUP-3', { id: 'SUP-3', name: 'Gamma', status: 'active' }]])
  const links = [
    { id: 'r1', payload: { itemId: 'ITEM-A', supplierId: 'SUP-1', preferred: true, leadTimeDays: 7 } },
    { id: 'r2', payload: { itemId: 'ITEM-B', supplierId: 'SUP-2', preferred: true, leadTimeDays: 3, minimumOrderQuantity: 50 } },
    { id: 'r3', payload: { itemId: 'ITEM-C', supplierId: 'SUP-3', approved: false, preferred: true } },
    { id: 'r4', payload: { itemId: 'ITEM-D', supplierId: 'SUP-3', minimumOrderQuantity: 24, leadTimeDays: 0 } },
  ]
  assert.deepEqual(preferredSupplierFor(item('A'), links, suppliers), { id: 'SUP-1', code: 'S1', name: 'Acme', leadTimeDays: 7, minimumOrderQuantity: null })
  assert.equal(preferredSupplierFor(item('B'), links, suppliers), null, 'an inactive supplier is not a source')
  assert.equal(preferredSupplierFor(item('C'), links, suppliers), null, 'an unapproved link is not a source')
  assert.equal(preferredSupplierFor(item('D'), links, suppliers), null, 'a link that is not preferred, for an item with no preferred supplier')
  assert.deepEqual(preferredSupplierFor(item('D', { preferredSupplierId: 'SUP-3' }), links, suppliers), { id: 'SUP-3', code: '', name: 'Gamma', leadTimeDays: 0, minimumOrderQuantity: 24 })

  const list = build({ items: [item('A')], allocationRows: [allocation('A', { onHand: 0 })], supplierLinks: links, suppliers: [...suppliers.values()] })
  assert.equal(rowOf(list, 'A').purchaseRequest.supplierId, 'SUP-1')
  assert.deepEqual(list.suppliers, [{ id: 'SUP-1', code: 'S1', name: 'Acme' }])
})

test('the scope says whose warehouses the position covers', () => {
  assert.deepEqual(build({}).scope, { kind: 'all_warehouses', warehouseCount: null })
  assert.deepEqual(build({ scope: { warehouseIds: ['WH-1', 'WH-2'] } }).scope, { kind: 'reader_warehouses', warehouseCount: 2 })
  assert.throws(() => buildReorderList({ today: '' }), /calendar day/)
})

test('order-by day arithmetic runs on whole ten-thousandths', () => {
  // 0.3 above the point at 0.1 a day (9 over 90 days) is 3 days, not 2.
  assert.equal(orderByDay({ positionUnits: 203000, reorderPointUnits: 200000, shippedUnits: 90000, today: TODAY }).daysUntilOrderBy, 3)
  assert.equal(orderByDay({ positionUnits: 10, reorderPointUnits: 20, shippedUnits: null, today: TODAY }).orderNow, true)
  assert.equal(orderByDay({ positionUnits: 30, reorderPointUnits: 20, shippedUnits: null, today: TODAY }), null)
})
