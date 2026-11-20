import test from 'node:test'
import assert from 'node:assert/strict'
import { handleSupplierReplyStockRoute } from './supplier-reply-stock.routes.mjs'
import { createSupplierReplyStockReadService } from '../services/supplier-reply-stock-read-service.mjs'
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

// The read, with the card, the facts and the rates stubbed.
const today = '2026-11-20'
const card = {
  id: 'sr-1', purchaseOrderId: 'PO-1',
  lines: [
    { purchaseOrderLineId: 'L1', outcome: 'proposed', proposedDate: '2026-11-28' },
    { purchaseOrderLineId: 'L2', outcome: 'needs_you', proposedDate: null },
  ],
  formLines: [{ purchaseOrderLineId: 'L1' }, { purchaseOrderLineId: 'L2' }],
}
const facts = (over = {}) => ({
  asOf: today,
  inventory: { rows: [
    { sku: 'SKU-1040', itemName: 'Bracket', unit: 'pcs', available: 30, reorderPoint: null },
    { sku: 'SKU-2210', itemName: 'Hinge', unit: 'pcs', available: 120, reorderPoint: 100 },
  ] },
  purchaseOrders: { index: [
    { id: 'PO-1', isOpen: true, openLines: [
      { lineId: 'L1', sku: 'SKU-1040', unit: 'pcs', remaining: 60, promisedDate: '2026-11-15' },
      { lineId: 'L2', sku: 'SKU-2210', unit: 'pcs', remaining: 20, promisedDate: '2026-11-15' },
    ] },
    { id: 'PO-9', isOpen: true, openLines: [{ lineId: 'X1', sku: 'SKU-1040', unit: 'pcs', remaining: 5, promisedDate: '2026-11-21' }] },
  ] },
  salesOrders: [{ promisedDate: '2026-11-22', lines: [{ sku: 'SKU-2210', open: 30 }] }],
  ...over,
})
function service({ cards = [card], read = facts(), rates = new Map([['SKU-1040', 10]]) } = {}) {
  const calls = { facts: 0 }
  const replies = { listReplies: async (orderId) => { if (orderId === 'PO-X') throw Object.assign(new Error('Not found.'), { status: 404, code: 'PURCHASE_ORDER_NOT_FOUND' }); return { replies: cards } } }
  return {
    calls,
    read: createSupplierReplyStockReadService({
      replies,
      loadContext: async () => ({ today }),
      readFacts: async () => { calls.facts += 1; return read },
      readRates: async () => rates,
    }).read,
  }
}

test('with the proposal\'s dates: the late line now due runs short before the new date at the shipped rate', async () => {
  const { read } = service()
  const answer = await read('PO-1', 'sr-1', {}, {})
  assert.ok(supplierReplyStockResponseSchema.safeParse(answer).success, JSON.stringify(answer))
  // 30 available, 10 a day, 5 more on day 1: below 0 on day 3 (Nov 23).
  assert.deepEqual(answer.effects.map((effect) => [effect.sku, effect.kind, effect.from, effect.newDate, effect.basis]), [['SKU-1040', 'short', '2026-11-23', '2026-11-28', 'recorded_rate']])
})

test('the dates the card would record count instead, an answered line included; lines not on the card are ignored', async () => {
  const { read } = service()
  const answer = await read('PO-1', 'sr-1', { dates: 'L1:2026-11-21,L2:2026-11-26,X1:2026-12-30' }, {})
  // L1 now on Nov 21: no stock-out; L2 on Nov 26: the hinge falls below its
  // reorder point on Nov 22 with the sales order of 30. X1 is another order's.
  assert.deepEqual(answer.effects.map((effect) => [effect.sku, effect.kind, effect.from, effect.newDate, effect.basis]), [['SKU-2210', 'below_reorder_point', '2026-11-22', '2026-11-26', 'open_sales_orders']])
})

test('without inventory read the answer has no stock line; without dates nothing is read', async () => {
  const hidden = service({ read: facts({ inventory: null }) })
  assert.deepEqual(await hidden.read('PO-1', 'sr-1', {}, {}), { contractVersion: 1, asOf: today, available: false, reason: 'inventory_hidden', effects: [] })
  const nothing = service({ cards: [{ ...card, lines: [{ purchaseOrderLineId: 'L2', outcome: 'needs_you', proposedDate: null }] }] })
  assert.deepEqual((await nothing.read('PO-1', 'sr-1', {}, {})).effects, [])
  assert.equal(nothing.calls.facts, 0)
})

test('the card\'s refusals stand: an order not found, a reply not on it, dates not in shape', async () => {
  const { read } = service()
  await assert.rejects(read('PO-X', 'sr-1', {}, {}), { status: 404, code: 'PURCHASE_ORDER_NOT_FOUND' })
  await assert.rejects(read('PO-1', 'sr-9', {}, {}), { status: 404, code: 'SUPPLIER_REPLY_NOT_FOUND' })
  await assert.rejects(read('PO-1', 'sr-1', { dates: 'L1-2026-11-28' }, {}), { status: 422, code: 'SUPPLIER_REPLY_INVALID' })
  await assert.rejects(read('PO-1', 'sr-1', { dates: 'L1:next week' }, {}), { status: 422 })
})

test('the dates parameter: lineId:day pairs, sorted when written', () => {
  assert.deepEqual(parseSupplierReplyStockDates('L1:2026-11-28, L2:2026-12-01'), [{ lineId: 'L1', date: '2026-11-28' }, { lineId: 'L2', date: '2026-12-01' }])
  assert.deepEqual(parseSupplierReplyStockDates(''), [])
  assert.equal(parseSupplierReplyStockDates('L1'), null)
  assert.equal(parseSupplierReplyStockDates(Array.from({ length: 201 }, (_, index) => `L${index}:2026-11-28`).join(',')), null)
  assert.equal(supplierReplyStockDatesParam([{ purchaseOrderLineId: 'L2', promisedDate: '2026-12-01' }, { purchaseOrderLineId: 'L1', promisedDate: '2026-11-28' }]), 'L1:2026-11-28,L2:2026-12-01')
})
