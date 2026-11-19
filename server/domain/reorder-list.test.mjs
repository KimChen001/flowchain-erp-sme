import test from 'node:test'
import assert from 'node:assert/strict'
import { NO_REORDER_POINT_LISTED, buildReorderList, dailyDemand, orderByDay, preferredSupplierFor, recordedReorderPoint } from './reorder-list.mjs'
import { buildTodayWork } from './today-work.mjs'
import { inventoryPosition, suggestPurchaseQuantity } from '../../shared/purchase-suggestion.mjs'

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
  // 0.99 of a day above the point: due today, so "order now" with a quantity
  // (design audit W-02): up to the reorder point plus 7 days of demand,
  // 20 + 28 = 48, from 23.99: 25.
  const c = rowOf(list, 'C')
  assert.equal(c.orderByDate, TODAY)
  assert.equal(c.orderNow, true)
  assert.equal(c.shortfall, 0)
  assert.deepEqual(c.orderUpTo, { level: 48, source: 'assumed', reviewDays: 7 })
  assert.equal(c.purchaseRequest.quantity, 25)
  assert.equal(a.purchaseRequest.quantity, null)
  assert.deepEqual(list.rows.map((row) => row.sku), ['C', 'B', 'A'])
})

test('at the reorder point the item is "order now", and the shortfall is reorder point minus position', () => {
  const list = build({
    items: [item('A'), item('B', { reorderPoint: 30 })],
    allocationRows: [allocation('A', { onHand: 25, reserved: 5 }), allocation('B', { onHand: 12.5, reserved: 0, incomingLines: [incoming('PO-1', 5, '2026-10-01')] })],
    shipmentLines: [...shipments('A', 8, 10), ...shipments('B', 8, 10)],
  })
  // 80 over 90 days: 0.8889 a day, so the assumed order-up-to level is the
  // reorder point plus 6.2223 (design audit C3).
  const a = rowOf(list, 'A')
  assert.equal(a.position, 20)
  assert.equal(a.orderNow, true)
  assert.equal(a.orderByDate, TODAY)
  assert.equal(a.shortfall, 0)
  assert.deepEqual(a.orderUpTo, { level: 26.2223, source: 'assumed', reviewDays: 7 })
  assert.equal(a.purchaseRequest.quantity, 7)
  const b = rowOf(list, 'B')
  assert.equal(b.position, 17.5)
  assert.equal(b.incoming, 5)
  assert.equal(b.shortfall, 12.5)
  // The request asks for the shared rule's quantity, as the assistant
  // suggests it: up to 36.2223 from 17.5, rounded up.
  assert.equal(b.purchaseRequest.quantity, 19)
  assert.equal(list.summary.orderNow, 2)
})

test('daily demand needs 8 shipment days in the 90 days before today; with 7 only items below the point are listed', () => {
  const seven = dailyDemand({ lines: shipments('A', 7, 10), stockUnit: 'pcs', today: TODAY, timeZone: TZ })
  assert.equal(seven.shipmentDays, 7)
  assert.equal(seven.averageDailyDemand, null)
  const eight = dailyDemand({ lines: shipments('A', 8, 10), stockUnit: 'pcs', today: TODAY, timeZone: TZ })
  assert.equal(eight.averageDailyDemand, 0.8889)
  assert.equal(eight.windowStart, '2026-07-07')
  assert.equal(eight.windowEnd, '2026-10-04')

  // Without daily demand the order-up-to level is the reorder point: below it
  // the item orders up to it; at it there is nothing to order, so it is not
  // listed, as above it.
  const list = build({
    items: [item('LOW'), item('AT'), item('HIGH')],
    allocationRows: [allocation('LOW', { onHand: 19 }), allocation('AT', { onHand: 20 }), allocation('HIGH', { onHand: 21 })],
    shipmentLines: [...shipments('LOW', 7, 10), ...shipments('AT', 7, 10), ...shipments('HIGH', 7, 10)],
  })
  const low = rowOf(list, 'LOW')
  assert.equal(low.orderNow, true)
  assert.equal(low.demand.enough, false)
  assert.equal(low.demand.shipmentDays, 7)
  assert.deepEqual(low.orderUpTo, { level: 20, source: 'reorder_point', reviewDays: 7 })
  assert.equal(low.purchaseRequest.quantity, 1)
  assert.equal(rowOf(list, 'AT'), undefined)
  assert.equal(rowOf(list, 'HIGH'), undefined)
  assert.equal(list.summary.aboveReorderPointWithoutHistory, 2)
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
  // Each item to set a reorder point on is named, to link to its record.
  // With the unit and lead time a suggested reorder point is sized with (L3-09).
  assert.deepEqual(list.noReorderPoint, { count: 2, href: '/app/master-data/items', items: [{ itemId: 'ITEM-NONE', sku: 'NONE', itemName: 'Item NONE', unit: 'pcs', leadTimeDays: null }, { itemId: 'ITEM-ZERO', sku: 'ZERO', itemName: 'Item ZERO', unit: 'pcs', leadTimeDays: null }] })
  const many = build({ items: Array.from({ length: NO_REORDER_POINT_LISTED + 5 }, (_, index) => item(`N-${String(index).padStart(3, '0')}`, { reorderPoint: null })) })
  assert.equal(many.noReorderPoint.count, NO_REORDER_POINT_LISTED + 5)
  assert.equal(many.noReorderPoint.items.length, NO_REORDER_POINT_LISTED)
  assert.equal(many.noReorderPoint.items[0].sku, 'N-000')
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

test('every open purchase order line counts as incoming whatever its due day; late lines and lines with no due day are flagged', () => {
  // 4 a day. Position 30 + 10 + 5 + 40 + 0.0001 = 85.0001 against 20:
  // 65.0001 / 4 = 16.25 days (Oct 21), with the line due in eight weeks counted.
  const list = build({
    items: [item('A')],
    allocationRows: [allocation('A', { onHand: 30, incomingLines: [incoming('PO-LATE', 10, '2026-10-01'), incoming('PO-TODAY', 5, TODAY), incoming('PO-FAR', 40, '2026-11-30'), incoming('PO-NODATE', 0.0001)] })],
    shipmentLines: shipments('A', 8, 45),
  })
  const a = rowOf(list, 'A')
  assert.equal(a.incoming, 55.0001)
  assert.equal(a.position, 85.0001)
  assert.equal(a.orderByDate, '2026-10-21')
  // A line due today is not late yet.
  assert.deepEqual(a.incomingLines.map((line) => [line.orderNumber, line.dueDay, line.late]), [['PO-LATE', '2026-10-01', true], ['PO-TODAY', TODAY, false], ['PO-FAR', '2026-11-30', false], ['PO-NODATE', null, false]])
  assert.deepEqual(a.flags, [{ code: 'po_line_late', orderNumber: 'PO-LATE', dueDay: '2026-10-01' }, { code: 'po_line_no_due_day', orderNumber: 'PO-NODATE' }])
  // Without daily demand the same lines count.
  const noHistory = build({ items: [item('A')], allocationRows: [allocation('A', { onHand: 0, incomingLines: [incoming('PO-FAR', 10, '2026-11-30')] })] })
  assert.equal(rowOf(noHistory, 'A').incoming, 10)
  assert.deepEqual(rowOf(noHistory, 'A').flags, [])
  // Without purchase order access a late line names no order.
  const hidden = buildReorderList({ items: [item('A')], allocationRows: [allocation('A', { onHand: 0, incomingLines: [incoming('PO-LATE', 10, '2026-10-01')] })], today: TODAY, timeZone: TZ, showPurchaseOrders: false })
  assert.deepEqual(rowOf(hidden, 'A').flags, [{ code: 'po_line_late', orderNumber: null, dueDay: '2026-10-01' }])
})

// Walkthrough 2026-11-03: 50 LDM-002 ordered from the reorder list, due after
// the supplier's lead time, were left out as due after the order-by day
// (today), so the list still said "Order now". Every open line now counts.
test('a purchase order placed today counts as incoming, so the item it covers is no longer "order now"', () => {
  const suppliers = [{ id: 'SUP-1', code: 'S1', name: 'Acme', status: 'active' }]
  const supplierLinks = [{ id: 'r1', payload: { itemId: 'ITEM-A', supplierId: 'SUP-1', preferred: true, leadTimeDays: 17, minimumOrderQuantity: 50 } }]
  const open = [incoming('PO-014', 50, '2026-09-29'), incoming('PO-002', 40, '2026-10-09'), incoming('PO-021', 25, '2026-10-19')]
  // 10 a day; 150 on hand + 115 on order = 265 against a reorder point of 270.
  // The request orders up to 270 + 70 = 340: 75, above Acme's minimum of 50.
  const read = (incomingLines) => rowOf(build({ items: [item('A', { reorderPoint: 270 })], allocationRows: [allocation('A', { onHand: 150, incomingLines })], shipmentLines: shipments('A', 9, 100), supplierLinks, suppliers }), 'A')
  const before = read(open)
  assert.deepEqual([before.position, before.orderNow, before.shortfall, before.purchaseRequest.quantity, before.purchaseRequest.raisedToMinimum], [265, true, 5, 75, false])
  // The 50 ordered today, due in 17 days: 315, so order by (315 - 270) / 10 = 4.5 days.
  const after = read([...open, incoming('PO-NEW', 50, '2026-10-22')])
  assert.deepEqual([after.position, after.orderNow, after.daysUntilOrderBy, after.shortfall, after.purchaseRequest.quantity], [315, false, 4, 0, null])
  assert.ok(after.flags.every((flag) => flag.orderNumber !== 'PO-NEW'))
})

// Acceptance (design audit C3: L3-02, V-A-01, W-02), item 22065 on the UCI
// walkthrough: 79 on hand + 112 incoming = 191 against a reorder point of
// 238; 1,018 shipped in 90 days (11.3111 a day); a minimum of 80.
test('22065: ordering the suggested quantity lifts the position to the order-up-to level and the row leaves "order now"', () => {
  const suppliers = [{ id: 'SUP-1', code: 'S1', name: 'Acme', status: 'active' }]
  const supplierLinks = [{ id: 'r1', payload: { itemId: 'ITEM-22065', supplierId: 'SUP-1', preferred: true, leadTimeDays: 14, minimumOrderQuantity: 80 } }]
  const read = (allocationExtra, itemExtra = {}) => build({ items: [item('22065', { reorderPoint: 238, ...itemExtra })], allocationRows: [allocation('22065', allocationExtra)], shipmentLines: shipments('22065', 8, 127.25), supplierLinks, suppliers })
  const before = rowOf(read({ onHand: 79, incomingLines: [incoming('PO-1', 112, '2026-10-12')] }), '22065')
  assert.deepEqual([before.position, before.orderNow, before.shortfall], [191, true, 47])
  assert.deepEqual(before.orderUpTo, { level: 317.1777, source: 'assumed', reviewDays: 7 })
  assert.equal(before.purchaseRequest.quantity, 127)
  assert.equal(before.purchaseRequest.raisedToMinimum, false)
  // The request ordered: 318, at the level or above, ordered by in 7 days.
  const after = rowOf(read({ onHand: 79, incomingLines: [incoming('PO-1', 112, '2026-10-12'), incoming('PO-NEW', 127, '2026-10-19')] }), '22065')
  assert.ok(after.position >= before.orderUpTo.level)
  assert.deepEqual([after.position, after.orderNow, after.daysUntilOrderBy, after.purchaseRequest.quantity], [318, false, 7, null])
  // A recorded level and lot size are the item's own: up to 400 in lots of 24.
  const recorded = rowOf(read({ onHand: 79, incomingLines: [incoming('PO-1', 112, '2026-10-12')] }, { orderUpToLevel: '400.0000', lotSize: '24.0000' }), '22065')
  assert.deepEqual([recorded.orderUpTo, recorded.lotSize, recorded.purchaseRequest.quantity], [{ level: 400, source: 'recorded', reviewDays: 7 }, 24, 216])
  // A recorded level at or below the reorder point is not a level: assumed.
  assert.equal(rowOf(read({ onHand: 79 }, { orderUpToLevel: 238 }), '22065').orderUpTo.source, 'assumed')
})

test('22065: a row due today always has a quantity and shows on Today', () => {
  // 245 on hand: 7 above the reorder point, less than a day of demand, so the
  // order-by day is today. It is "order now", ordering up to 317.1777: 73.
  const list = build({ items: [item('22065', { reorderPoint: 238 })], allocationRows: [allocation('22065', { onHand: 245 })], shipmentLines: shipments('22065', 8, 127.25) })
  const row = rowOf(list, '22065')
  assert.deepEqual([row.orderByDate, row.orderNow, row.daysUntilOrderBy, row.shortfall, row.purchaseRequest.quantity], [TODAY, true, 0, 0, 73])
  assert.ok(list.rows.every((entry) => entry.orderByDate !== TODAY || entry.purchaseRequest.quantity > 0))
  const today = buildTodayWork({ reorder: list }, { now: new Date(`${TODAY}T15:00:00Z`), timeZone: TZ })
  const work = today.items.find((entry) => entry.kind === 'reorder_now')
  assert.equal(work?.label, '22065')
  assert.equal(work.detail.purchaseRequest.quantity, 73)
  // A recorded level already reached the day it is due: due tomorrow, with no
  // quantity, and not on Today.
  const reached = build({ items: [item('22065', { reorderPoint: 238, orderUpToLevel: 240 })], allocationRows: [allocation('22065', { onHand: 245 })], shipmentLines: shipments('22065', 8, 127.25) })
  assert.deepEqual([rowOf(reached, '22065').orderByDate, rowOf(reached, '22065').orderNow, rowOf(reached, '22065').purchaseRequest.quantity], ['2026-10-06', false, null])
})

test('the preferred supplier shows its lead time and minimum order quantity only when recorded', () => {
  const suppliers = new Map([['SUP-1', { id: 'SUP-1', code: 'S1', name: 'Acme', status: 'active' }], ['SUP-2', { id: 'SUP-2', name: 'Beta', status: 'inactive' }], ['SUP-3', { id: 'SUP-3', name: 'Gamma', status: 'active' }]])
  const links = [
    { id: 'r1', payload: { itemId: 'ITEM-A', supplierId: 'SUP-1', preferred: true, leadTimeDays: 7 } },
    { id: 'r2', payload: { itemId: 'ITEM-B', supplierId: 'SUP-2', preferred: true, leadTimeDays: 3, minimumOrderQuantity: 50 } },
    { id: 'r3', payload: { itemId: 'ITEM-C', supplierId: 'SUP-3', approved: false, preferred: true } },
    { id: 'r4', payload: { itemId: 'ITEM-D', supplierId: 'SUP-3', minimumOrderQuantity: 24, leadTimeDays: 0 } },
  ]
  assert.deepEqual(preferredSupplierFor(item('A'), links, suppliers), { id: 'SUP-1', code: 'S1', name: 'Acme', leadTimeDays: 7, leadTimeFrom: 'supplier', minimumOrderQuantity: null, moqFrom: null, moqUnit: null })
  assert.equal(preferredSupplierFor(item('B'), links, suppliers), null, 'an inactive supplier is not a source')
  assert.equal(preferredSupplierFor(item('C'), links, suppliers), null, 'an unapproved link is not a source')
  assert.equal(preferredSupplierFor(item('D'), links, suppliers), null, 'a link that is not preferred, for an item with no preferred supplier')
  assert.deepEqual(preferredSupplierFor(item('D', { preferredSupplierId: 'SUP-3' }), links, suppliers, { moqUnit: 'CASE' }), { id: 'SUP-3', code: '', name: 'Gamma', leadTimeDays: 0, leadTimeFrom: 'supplier', minimumOrderQuantity: 24, moqFrom: 'supplier', moqUnit: 'CASE' })

  const list = build({ items: [item('A')], allocationRows: [allocation('A', { onHand: 0 })], supplierLinks: links, suppliers: [...suppliers.values()] })
  assert.equal(rowOf(list, 'A').purchaseRequest.supplierId, 'SUP-1')
  // The minimum order quantity is in the purchase unit, the stock unit when none is recorded.
  const caseItem = build({ items: [item('D', { preferredSupplierId: 'SUP-3', metadata: { purchaseUnit: 'CASE' } }), item('E', { preferredSupplierId: 'SUP-3' })], allocationRows: [allocation('D', { onHand: 0 }), allocation('E', { onHand: 0 })], supplierLinks: [...links, { id: 'r5', payload: { itemId: 'ITEM-E', supplierId: 'SUP-3', minimumOrderQuantity: 2 } }], suppliers: [...suppliers.values()] })
  assert.equal(rowOf(caseItem, 'D').supplier.moqUnit, 'CASE')
  assert.equal(rowOf(caseItem, 'E').supplier.moqUnit, 'pcs')
  assert.deepEqual(list.suppliers, [{ id: 'SUP-1', code: 'S1', name: 'Acme' }])
})

test('a reader of only some warehouses gets no position: the reorder point covers every warehouse', () => {
  assert.deepEqual(build({ scope: { totalWarehouses: 3 } }).scope, { kind: 'all_warehouses', warehouseCount: null, totalWarehouseCount: 3 })
  const list = build({
    items: [item('A'), item('B', { reorderPoint: null })],
    allocationRows: [allocation('A', { onHand: 0 })],
    scope: { warehouseIds: ['WH-1'], totalWarehouses: 2 },
  })
  assert.deepEqual(list.scope, { kind: 'reader_warehouses', warehouseCount: 1, totalWarehouseCount: 2 })
  // A at 0 against 20 would be "order now" over every warehouse; for this
  // reader it is not checked, and no quantity is shown.
  assert.deepEqual(list.rows, [])
  assert.deepEqual(list.notJudged, [{ itemId: 'ITEM-A', sku: 'A', itemName: 'Item A', reason: 'warehouse_scope' }])
  assert.equal(list.noReorderPoint.count, 1)
  assert.throws(() => buildReorderList({ today: '' }), /calendar day/)
})

test('an item with no stock unit recorded is not checked, and shipments in two units are never added', () => {
  const list = build({
    items: [item('NOUNIT', { unit: '', reorderPoint: 20 })],
    allocationRows: [allocation('NOUNIT', { onHand: 0 })],
    shipmentLines: [...shipments('NOUNIT', 8, 10, 'pcs'), ...shipments('NOUNIT', 2, 3, 'CASE')],
  })
  assert.deepEqual(list.rows, [])
  assert.deepEqual(list.notJudged.map((row) => [row.sku, row.reason]), [['NOUNIT', 'stock_unit_not_recorded']])
  // The rules alone: without a stock unit, pcs and CASE are never summed.
  const mixed = dailyDemand({ lines: [...shipments('X', 8, 10, 'pcs'), ...shipments('X', 2, 3, 'CASE')], stockUnit: '', today: TODAY, timeZone: TZ })
  assert.equal(mixed.averageDailyDemand, null)
  assert.equal(mixed.shippedQuantity, 0)
  assert.deepEqual(mixed.unitsMixed, ['pcs', 'CASE'])
  // One unit throughout is still one quantity.
  const single = dailyDemand({ lines: shipments('X', 8, 9, 'pcs'), stockUnit: '', today: TODAY, timeZone: TZ })
  assert.equal(single.averageDailyDemand, 0.8)
  assert.deepEqual(single.unitsMixed, [])
})

test('shipment lines with no unit are counted in the stock unit and flagged, one by one', () => {
  const list = build({
    items: [item('A')],
    allocationRows: [allocation('A', { onHand: 30 })],
    shipmentLines: [...shipments('A', 8, 9), { itemId: 'ITEM-A', unit: '', quantity: 18, postedAt: '2026-09-01T15:00:00Z' }],
  })
  const a = rowOf(list, 'A')
  assert.equal(a.demand.shippedQuantity, 90)
  assert.deepEqual(a.flags.filter((flag) => flag.code.startsWith('shipment_')), [{ code: 'shipment_unit_not_recorded', count: 1 }])
})

test('order-by day arithmetic runs on whole ten-thousandths', () => {
  // 0.3 above the point at 0.1 a day (9 over 90 days) is 3 days, not 2.
  assert.equal(orderByDay({ positionUnits: 203000, reorderPointUnits: 200000, shippedUnits: 90000, today: TODAY }).daysUntilOrderBy, 3)
  assert.equal(orderByDay({ positionUnits: 10, reorderPointUnits: 20, shippedUnits: null, today: TODAY }).orderNow, true)
  assert.equal(orderByDay({ positionUnits: 30, reorderPointUnits: 20, shippedUnits: null, today: TODAY }), null)
})

// Walkthrough 2026-10-07: FIT-300 was 50 short with a supplier minimum of 100,
// and "Create purchase request" asked for 50, which the supplier would refuse.
test('the purchase request asks for at least the supplier minimum, and the shortfall stays as computed', () => {
  const suppliers = [{ id: 'SUP-1', code: 'S1', name: 'Midwest Pipe Supply', status: 'active' }]
  const links = [
    { id: 'r1', payload: { itemId: 'ITEM-A', supplierId: 'SUP-1', preferred: true, minimumOrderQuantity: 100 } },
    { id: 'r2', payload: { itemId: 'ITEM-B', supplierId: 'SUP-1', preferred: true, minimumOrderQuantity: 100 } },
    { id: 'r3', payload: { itemId: 'ITEM-C', supplierId: 'SUP-1', preferred: true } },
  ]
  const items = [item('A', { reorderPoint: 200 }), item('B', { reorderPoint: 200 }), item('C', { reorderPoint: 200 })]
  const list = build({ items, allocationRows: [allocation('A', { onHand: 150 }), allocation('B', { onHand: 40 }), allocation('C', { onHand: 150 })], supplierLinks: links, suppliers })
  const request = (sku) => { const row = rowOf(list, sku); return [row.shortfall, row.purchaseRequest.quantity, row.purchaseRequest.raisedToMinimum] }
  assert.deepEqual(request('A'), [50, 100, true])
  assert.deepEqual(request('B'), [160, 160, false])
  assert.deepEqual(request('C'), [50, 50, false], 'no minimum recorded')
})

// Design audit C2 (L3-03, L3-04, L3-06, L1-11): the position counts draft and
// pending-approval purchase orders and open purchase requests, and takes
// backorders out once; the request quantity is the shared rule's.
test('the position adds pending orders and open requests and takes out backorders, each once', () => {
  const request = (number, status, quantity, extra = {}) => ({ itemId: 'ITEM-A', sku: 'A', quantity, unit: 'pcs', request: { id: number, number, status }, ...extra })
  const lines = [
    request('PR-1', 'draft', 4),
    request('PR-2', 'approved', 3),
    request('PR-3', 'converted', 50),
    request('PR-4', 'submitted', 9, { unit: 'box' }),
  ]
  const list = build({
    items: [item('A', { reorderPoint: 30 })],
    allocationRows: [allocation('A', { onHand: 40, reserved: 10, unreservedSalesDemand: 15, pendingPurchaseQty: 5, pendingLines: [{ purchaseOrderId: 'PO-9', orderNumber: 'PO-9', status: 'draft', remaining: 5 }], incomingLines: [incoming('PO-1', 2, '2026-10-01')] })],
    purchaseRequestLines: lines,
  })
  const a = rowOf(list, 'A')
  // 40 - 10 + 2 + 5 + (4 + 3) - 15 = 29: one short of the reorder point.
  assert.deepEqual([a.position, a.incoming, a.pendingOrders, a.openRequests, a.requested, a.backorders, a.shortfall, a.orderNow], [29, 2, 5, 7, 12, 15, 1, true])
  assert.deepEqual(a.requests, [{ number: 'PR-1', status: 'draft' }, { number: 'PR-2', status: 'approved' }])
  assert.deepEqual(a.pendingLines, [{ orderNumber: 'PO-9', status: 'draft', remaining: 5 }])
  assert.ok(a.flags.some((flag) => flag.code === 'request_line_other_unit' && flag.count === 1))
  // The same quantity the shared rule gives on the same parts.
  const parts = inventoryPosition({ onHand: 40, reserved: 10, incoming: 2, pendingOrders: 5, openRequests: 7, backorders: 15 })
  assert.equal(a.purchaseRequest.quantity, suggestPurchaseQuantity({ reorderPoint: 30, ...parts }).quantity.value)
  assert.equal(a.purchaseRequest.quantity, 1)
  // A reader who may not see purchase requests: counted, never named.
  const hidden = rowOf(build({ items: [item('A', { reorderPoint: 30 })], allocationRows: [allocation('A', { onHand: 40, reserved: 10, unreservedSalesDemand: 15, pendingPurchaseQty: 5 })], purchaseRequestLines: lines, showPurchaseRequests: false }), 'A')
  assert.deepEqual([hidden.openRequests, hidden.requests], [7, []])
  // Fully reserved: 100 on hand, 100 reserved, no backorder; reorder point 30.
  const full = rowOf(build({ items: [item('F', { reorderPoint: 30 })], allocationRows: [allocation('F', { onHand: 100, reserved: 100, unreservedSalesDemand: 0 })] }), 'F')
  assert.deepEqual([full.position, full.shortfall, full.purchaseRequest.quantity], [0, 30, 30])
  // Backorders not readable: the item is not checked rather than misjudged.
  assert.equal(build({ items: [item('U')], allocationRows: [allocation('U', { unreservedSalesDemand: null })] }).notJudged[0].reason, 'stock_incomplete')
})

// Design audit L3-08: the lead time and MOQ on the item form were ignored.
test("the item's own lead time and minimum order stand in when the supplier link records none", () => {
  const suppliers = [{ id: 'SUP-1', code: 'S1', name: 'Acme', status: 'active' }]
  const links = [{ id: 'r1', payload: { itemId: 'ITEM-A', supplierId: 'SUP-1', preferred: true } }]
  const own = { purchaseLeadTimeDays: 10, minimumOrderQuantity: 25 }
  const list = build({ items: [item('A', { metadata: own }), item('B', { metadata: own }), item('Z', { metadata: { purchaseLeadTimeDays: 0, minimumOrderQuantity: 0 } })], allocationRows: [allocation('A', { onHand: 0 }), allocation('B', { onHand: 0 }), allocation('Z', { onHand: 0 })], supplierLinks: links, suppliers })
  const a = rowOf(list, 'A')
  assert.deepEqual([a.supplier.leadTimeDays, a.supplier.leadTimeFrom, a.supplier.minimumOrderQuantity, a.supplier.moqFrom], [10, 'item', 25, 'item'])
  assert.deepEqual([a.leadTimeDays, a.leadTimeFrom, a.purchaseRequest.quantity, a.purchaseRequest.raisedToMinimum], [10, 'item', 25, true])
  // No supplier link: the row still plans with the item's lead time.
  const b = rowOf(list, 'B')
  assert.deepEqual([b.supplier, b.leadTimeDays, b.leadTimeFrom], [null, 10, 'item'])
  // 0 on the item is not recorded.
  const z = rowOf(list, 'Z')
  assert.deepEqual([z.leadTimeDays, z.leadTimeFrom, z.purchaseRequest.quantity], [null, null, 20])
})
