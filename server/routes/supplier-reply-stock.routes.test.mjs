import test from 'node:test'
import assert from 'node:assert/strict'
import { handleSupplierReplyStockRoute } from './supplier-reply-stock.routes.mjs'
import { createSupplierReplyStockReadService } from '../services/supplier-reply-stock-read-service.mjs'
import { readSupplierReplyStockInputs } from '../services/supplier-reply-stock-inputs.mjs'
import { parseSupplierReplyStockDates, supplierReplyStockDatesParam, supplierReplyStockResponseSchema } from '../../shared/supplier-reply-stock-contract.mjs'

// The supplier reply card's stock line: the route, and the read behind it
// with its permissions (the card's read, then inventory read) and its dates.

const identity = { authenticated: true, tenantId: 'tenant-s', userId: 'user-1' }
async function call(path, { service, auth = identity, method = 'GET' } = {}) {
  let response = null
  const handled = await handleSupplierReplyStockRoute({
    url: new URL(`http://local${path}`), req: { method }, identity: auth,
    repositories: { supplierReplyStock: service },
    res: {}, send: (_, status, body) => { response = { status, body } },
  })
  return { handled, ...response }
}

test('the route answers only GET on a reply\'s stock, and needs a signed-in workspace', async () => {
  const service = { read: async () => assert.fail('not read') }
  assert.equal((await call('/api/procurement/orders/PO-1/supplier-replies/sr-1/stock', { service, method: 'POST' })).handled, false)
  assert.equal((await call('/api/procurement/orders/PO-1/supplier-replies/sr-1', { service })).handled, false)
  const anonymous = await call('/api/procurement/orders/PO-1/supplier-replies/sr-1/stock', { service, auth: {} })
  assert.deepEqual([anonymous.status, anonymous.body.code], [401, 'TENANT_CONTEXT_REQUIRED'])
})

test('the route passes the order, the reply and the dates, and answers the read or its refusal', async () => {
  const seen = []
  const body = { contractVersion: 1, asOf: '2026-11-20', available: true, reason: null, effects: [] }
  const ok = await call('/api/procurement/orders/PO%201/supplier-replies/sr-1/stock?dates=L1:2026-11-28', { service: { read: async (...args) => (seen.push(args.slice(0, 3)), body) } })
  assert.deepEqual([ok.status, ok.body], [200, body])
  assert.deepEqual(seen, [['PO 1', 'sr-1', { dates: 'L1:2026-11-28' }]])
  const refused = await call('/api/procurement/orders/PO-1/supplier-replies/sr-1/stock', { service: { read: async () => { throw Object.assign(new Error('No.'), { status: 403, code: 'AUTHORIZATION_PERMISSION_DENIED' }) } } })
  assert.deepEqual([refused.status, refused.body.code], [403, 'AUTHORIZATION_PERMISSION_DENIED'])
  await assert.rejects(call('/api/procurement/orders/PO-1/supplier-replies/sr-1/stock', { service: { read: async () => { throw new Error('boom') } } }), /boom/)
})

// The read, with the card, the reader's access and the stock inputs stubbed.
const today = '2026-11-20'
const card = {
  id: 'sr-1', purchaseOrderId: 'PO-1',
  lines: [
    { purchaseOrderLineId: 'L1', sku: 'SKU-1040', outcome: 'proposed', proposedDate: '2026-11-28' },
    { purchaseOrderLineId: 'L2', sku: 'SKU-2210', outcome: 'needs_you', proposedDate: null },
  ],
  formLines: [{ purchaseOrderLineId: 'L1', sku: 'SKU-1040' }, { purchaseOrderLineId: 'L2', sku: 'SKU-2210' }],
}
// The stock of the card's SKUs, as readSupplierReplyStockInputs gives it.
const inputs = () => ({
  items: [
    { sku: 'SKU-1040', itemName: 'Bracket', unit: 'pcs', available: 30, reorderPoint: null },
    { sku: 'SKU-2210', itemName: 'Hinge', unit: 'pcs', available: 120, reorderPoint: 100 },
  ],
  incoming: [
    { lineId: 'L1', purchaseOrderId: 'PO-1', sku: 'SKU-1040', unit: null, remaining: 60, promisedDate: '2026-11-15' },
    { lineId: 'L2', purchaseOrderId: 'PO-1', sku: 'SKU-2210', unit: null, remaining: 20, promisedDate: '2026-11-15' },
    { lineId: 'X1', purchaseOrderId: 'PO-9', sku: 'SKU-1040', unit: null, remaining: 5, promisedDate: '2026-11-21' },
  ],
  demand: [{ sku: 'SKU-2210', quantity: 30, promisedDate: '2026-11-22' }],
  rates: new Map([['SKU-1040', 10]]),
})
const everything = { inventory: true, warehouseIds: null, salesOrders: true }
function service({ cards = [card], access = everything } = {}) {
  const asked = []
  const replies = { listReplies: async (orderId) => { if (orderId === 'PO-X') throw Object.assign(new Error('Not found.'), { status: 404, code: 'PURCHASE_ORDER_NOT_FOUND' }); return { replies: cards } } }
  return {
    asked,
    read: createSupplierReplyStockReadService({
      replies,
      loadContext: async () => ({ today, actor: { tenantId: 'tenant-s' }, tenantId: 'tenant-s', tenant: { timezone: 'America/New_York' }, prisma: {} }),
      accessOf: () => access,
      readInputs: async (args) => { asked.push(args); return inputs() },
    }).read,
  }
}

test('with the proposal\'s dates: the late line now due runs short before the new date at the shipped rate', async () => {
  const { read, asked } = service()
  const answer = await read('PO-1', 'sr-1', {}, {})
  assert.ok(supplierReplyStockResponseSchema.safeParse(answer).success, JSON.stringify(answer))
  // 30 available, 10 a day, 5 more on day 1: below 0 on day 3 (Nov 23).
  assert.deepEqual(answer.effects.map((effect) => [effect.sku, effect.kind, effect.from, effect.newDate, effect.basis]), [['SKU-1040', 'short', '2026-11-23', '2026-11-28', 'recorded_rate']])
  // Only the SKUs of the lines the dates move are read, in every warehouse, with sales orders.
  assert.deepEqual(asked.map((args) => [args.skus, args.warehouseIds, args.salesOrdersVisible, args.tenantId, args.today]), [[['SKU-1040'], null, true, 'tenant-s', today]])
})

test('the dates the card would record count instead, an answered line included; lines not on the card are ignored', async () => {
  const { read, asked } = service()
  const answer = await read('PO-1', 'sr-1', { dates: 'L1:2026-11-21,L2:2026-11-26,X1:2026-12-30' }, {})
  // L1 now on Nov 21: no stock-out; L2 on Nov 26: the hinge is below its
  // reorder point on Nov 22 with the sales order of 30. X1 is another order's.
  assert.deepEqual(answer.effects.map((effect) => [effect.sku, effect.kind, effect.from, effect.newDate, effect.basis]), [['SKU-2210', 'below_reorder_point', '2026-11-22', '2026-11-26', 'open_sales_orders']])
  assert.deepEqual(asked[0].skus, ['SKU-1040', 'SKU-2210'])
})

test('the reader\'s access: no inventory read, no stock line; their warehouses and sales orders are passed on', async () => {
  const hidden = service({ access: { inventory: false, warehouseIds: null, salesOrders: true } })
  assert.deepEqual(await hidden.read('PO-1', 'sr-1', {}, {}), { contractVersion: 1, asOf: today, available: false, reason: 'inventory_hidden', effects: [] })
  assert.equal(hidden.asked.length, 0)
  const scoped = service({ access: { inventory: true, warehouseIds: ['WH-1'], salesOrders: false } })
  await scoped.read('PO-1', 'sr-1', {}, {})
  assert.deepEqual([scoped.asked[0].warehouseIds, scoped.asked[0].salesOrdersVisible], [['WH-1'], false])
  // Without dates or a proposal nothing is read.
  const nothing = service({ cards: [{ ...card, lines: [card.lines[1]] }] })
  assert.deepEqual((await nothing.read('PO-1', 'sr-1', {}, {})).effects, [])
  assert.equal(nothing.asked.length, 0)
})

test('the card\'s refusals stand: an order not found, a reply not on it, dates not in shape or not real days', async () => {
  const { read } = service()
  await assert.rejects(read('PO-X', 'sr-1', {}, {}), { status: 404, code: 'PURCHASE_ORDER_NOT_FOUND' })
  await assert.rejects(read('PO-1', 'sr-9', {}, {}), { status: 404, code: 'SUPPLIER_REPLY_NOT_FOUND' })
  await assert.rejects(read('PO-1', 'sr-1', { dates: 'L1-2026-11-28' }, {}), { status: 422, code: 'SUPPLIER_REPLY_INVALID' })
  await assert.rejects(read('PO-1', 'sr-1', { dates: 'L1:next week' }, {}), { status: 422 })
  await assert.rejects(read('PO-1', 'sr-1', { dates: 'L1:2027-02-31' }, {}), { status: 422 })
  await assert.rejects(read('PO-1', 'sr-1', { dates: 'L1:2027-13-01' }, {}), { status: 422 })
})

test('the dates parameter: lineId:day pairs of real days, sorted when written', () => {
  assert.deepEqual(parseSupplierReplyStockDates('L1:2026-11-28, L2:2026-12-01'), [{ lineId: 'L1', date: '2026-11-28' }, { lineId: 'L2', date: '2026-12-01' }])
  assert.deepEqual(parseSupplierReplyStockDates(''), [])
  assert.equal(parseSupplierReplyStockDates('L1'), null)
  assert.equal(parseSupplierReplyStockDates('L1:2026-02-29'), null)
  assert.deepEqual(parseSupplierReplyStockDates('L1:2028-02-29'), [{ lineId: 'L1', date: '2028-02-29' }])
  assert.equal(parseSupplierReplyStockDates(Array.from({ length: 201 }, (_, index) => `L${index}:2026-11-28`).join(',')), null)
  assert.equal(supplierReplyStockDatesParam([{ purchaseOrderLineId: 'L2', promisedDate: '2026-12-01' }, { purchaseOrderLineId: 'L1', promisedDate: '2026-11-28' }]), 'L1:2026-11-28,L2:2026-12-01')
})

// The narrow read over a stand-in database: what it asks for, and how it sets
// the answer out through the inventory page's allocation model.
function fakePrisma({ shipments = [], warehouses = [{ id: 'WH-1' }, { id: 'WH-2' }] } = {}) {
  const calls = {}
  const record = (name, value) => async (args) => { calls[name] = args; return typeof value === 'function' ? value(args) : value }
  const prisma = {
    inventoryBalance: { findMany: record('balances', [
      { sku: 'SKU-1040', itemId: 'I-1', itemName: 'Bracket', onHandQuantity: '50.0000', availableQuantity: '50.0000', reservedQuantity: '10.0000' },
      { sku: 'SKU-1040', itemId: 'I-1', itemName: 'Bracket', onHandQuantity: null, availableQuantity: '20.0000', reservedQuantity: null },
    ]) },
    item: { findMany: record('items', [{ id: 'I-1', sku: 'SKU-1040', name: 'Bracket', unit: 'pcs', reorderPoint: '100.0000', safetyStock: null, status: 'active', metadata: null }]) },
    $queryRaw: async () => [{ status: 'issued' }, { status: 'closed' }, { status: 'pending_approval' }],
    purchaseOrder: { findMany: record('orders', [
      { id: 'PO-1', status: 'issued', expectedDate: new Date('2026-11-15T00:00:00Z'), lines: [
        { id: 'L1', sku: 'SKU-1040', itemId: 'I-1', orderedQuantity: '100.0000', receivedQuantity: '40.0000', unit: 'pcs', metadata: { promisedDate: '2026-11-15' } },
        { id: 'L2', sku: 'SKU-1040', itemId: 'I-1', orderedQuantity: '5.0000', receivedQuantity: '0.0000', unit: 'box', metadata: { promisedDate: '2026-11-25' } },
      ] },
      // A line with no promised date of its own: due on the order's expected date.
      { id: 'PO-2', status: 'issued', expectedDate: new Date('2026-11-26T00:00:00Z'), lines: [
        { id: 'M1', sku: 'SKU-1040', itemId: 'I-1', orderedQuantity: '25.0000', receivedQuantity: '0.0000', unit: 'pcs', metadata: {} },
      ] },
    ]) },
    salesOrderLine: { findMany: record('sales', [
      { sku: 'SKU-1040', orderedQuantity: '30.0000', fulfilledQuantity: '5.0000', reservedQuantity: '5.0000', salesOrder: { id: 'SO-1', promisedDate: new Date('2026-11-22T00:00:00Z') } },
    ]) },
    warehouse: { findMany: record('warehouses', warehouses) },
    shipmentLine: { findMany: record('shipments', shipments) },
  }
  return { prisma, calls }
}

test('the narrow read: the SKUs\' stock in the reader\'s warehouses, their committed lines in the stock unit, dated unreserved demand', async () => {
  const { prisma, calls } = fakePrisma()
  const read = await readSupplierReplyStockInputs({ prisma, tenantId: 'tenant-s', today, timeZone: 'America/New_York', skus: ['SKU-1040'], warehouseIds: ['WH-1', 'WH-2'], salesOrdersVisible: true })
  // Only these SKUs, only the reader's warehouses, only open sales orders.
  assert.deepEqual(calls.balances.where, { tenantId: 'tenant-s', sku: { in: ['SKU-1040'] }, warehouseId: { in: ['WH-1', 'WH-2'] } })
  assert.deepEqual(calls.items.where, { tenantId: 'tenant-s', sku: { in: ['SKU-1040'] } })
  assert.deepEqual(calls.orders.where.status, { in: ['issued', 'pending_approval'] })
  assert.deepEqual(calls.sales.where.salesOrder, { tenantId: 'tenant-s', workflowStatus: { notIn: ['draft', 'cancelled', 'canceled'] }, fulfillmentStatus: { not: 'fully_fulfilled' } })
  // On hand 50 + 20 (available where on hand is missing) less 10 reserved.
  assert.deepEqual(read.items, [{ sku: 'SKU-1040', itemName: 'Bracket', unit: 'pcs', available: 60, reorderPoint: 100 }])
  // The committed line's 60 left; the box line is in another unit and left
  // out; the line with no promised date is due on its order's expected date.
  assert.deepEqual(read.incoming, [
    { lineId: 'L1', purchaseOrderId: 'PO-1', sku: 'SKU-1040', unit: null, remaining: 60, promisedDate: '2026-11-15' },
    { lineId: 'M1', purchaseOrderId: 'PO-2', sku: 'SKU-1040', unit: null, remaining: 25, promisedDate: '2026-11-26' },
  ])
  assert.deepEqual(read.demand, [{ sku: 'SKU-1040', quantity: 20, promisedDate: '2026-11-22' }])
})

test('the narrow read: the shipped rate, unrounded, only for a reader of every warehouse; no sales orders unless readable', async () => {
  // 37 shipped on each of 10 days of the window: 370 / 90 a day.
  const shipments = Array.from({ length: 10 }, (_, index) => ({ itemId: 'I-1', unit: 'pcs', postedQuantity: '37.0000', shipment: { postedAt: new Date(Date.parse('2026-11-01T15:00:00Z') + index * 86400000) } }))
  const every = fakePrisma({ shipments })
  const all = await readSupplierReplyStockInputs({ prisma: every.prisma, tenantId: 'tenant-s', today, timeZone: 'America/New_York', skus: ['SKU-1040'], warehouseIds: ['WH-1', 'WH-2'], salesOrdersVisible: false })
  assert.equal(all.rates.get('SKU-1040'), 370 / 90)
  assert.equal(all.demand, null)
  assert.equal(every.calls.sales, undefined)
  const some = fakePrisma({ shipments })
  const part = await readSupplierReplyStockInputs({ prisma: some.prisma, tenantId: 'tenant-s', today, timeZone: 'America/New_York', skus: ['SKU-1040'], warehouseIds: ['WH-1'], salesOrdersVisible: false })
  assert.equal(part.rates.size, 0)
  assert.equal(some.calls.shipments, undefined)
})
