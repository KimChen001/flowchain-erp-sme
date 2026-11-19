import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { SALES_ORDER_STAGES, salesOrderStage, salesOrderStageHint } from '../../src/modules/sales/salesOrderStatus.ts'
import { outboundOrderStatuses } from './outbound-transaction-policy.mjs'

const read = (file) => readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8')
const order = (workflowStatus, reservationStatus, fulfillmentStatus) => ({ workflowStatus, reservationStatus, fulfillmentStatus })
const label = (statuses, language = 0) => SALES_ORDER_STAGES[salesOrderStage(statuses)].label[language]
const hint = (statuses) => salesOrderStageHint(statuses)?.[0] ?? null

test('the sales order list shows one status per order, never "Not reserved" for a shipped order', () => {
  // Shipping uses up the reservations, so a shipped order stores not_reserved.
  const shipped = order('confirmed', 'not_reserved', 'fully_fulfilled')
  assert.equal(label(shipped), 'Fulfilled')
  assert.equal(label(shipped, 1), '已履约')
  assert.equal(hint(shipped), null)

  assert.equal(label(order('draft', 'not_reserved', 'not_fulfilled')), 'Draft')
  assert.equal(label(order('confirmed', 'not_reserved', 'not_fulfilled')), 'Confirmed')
  assert.equal(label(order('confirmed', 'partially_reserved', 'not_fulfilled')), 'Partly reserved')
  assert.equal(label(order('confirmed', 'fully_reserved', 'not_fulfilled')), 'Ready to ship')
  assert.equal(label(order('cancelled', 'not_reserved', 'not_fulfilled')), 'Cancelled')
  // Part shipped: the hint says whether stock is held for the rest.
  assert.equal(label(order('confirmed', 'fully_reserved', 'partially_fulfilled')), 'Partly fulfilled')
  assert.equal(hint(order('confirmed', 'fully_reserved', 'partially_fulfilled')), 'Stock reserved')
  assert.equal(hint(order('confirmed', 'not_reserved', 'partially_fulfilled')), null)
  // On hold: the hint says how far the order had got.
  assert.equal(label(order('on_hold', 'partially_reserved', 'partially_fulfilled')), 'On hold')
  assert.equal(hint(order('on_hold', 'partially_reserved', 'partially_fulfilled')), 'Partly fulfilled')
  assert.equal(hint(order('on_hold', 'partially_reserved', 'not_fulfilled')), 'Partly reserved')
  assert.equal(hint(order('on_hold', 'not_reserved', 'not_fulfilled')), null)
})

test('every status the outbound policy can store gives one labelled status in both languages', () => {
  const shapes = [[[4, 0, 0]], [[4, 2, 0]], [[4, 4, 0]], [[4, 0, 2]], [[4, 2, 2]], [[4, 0, 4]], [[4, 0, 4], [3, 0, 0]], [[4, 4, 0], [3, 0, 0]], [[4, 0, 4], [3, 3, 0]]]
  for (const workflowStatus of ['draft', 'confirmed', 'on_hold', 'cancelled']) {
    for (const quantities of shapes) {
      const lines = quantities.map(([orderedQuantity, reservedQuantity, fulfilledQuantity]) => ({ orderedQuantity, reservedQuantity, fulfilledQuantity }))
      const statuses = { workflowStatus, ...outboundOrderStatuses(lines) }
      const stage = SALES_ORDER_STAGES[salesOrderStage(statuses)]
      assert.ok(stage, JSON.stringify(statuses))
      assert.match(stage.label[0], /^[A-Z][a-z ]+$/)
      assert.match(stage.label[1], /[㐀-鿿]/)
      if (statuses.fulfillmentStatus === 'fully_fulfilled' && workflowStatus === 'confirmed') assert.equal(stage.label[0], 'Fulfilled')
      const extra = salesOrderStageHint(statuses)
      if (extra) assert.notEqual(extra[0], stage.label[0])
    }
  }
})

test('the sales order list follows the purchase order list: one status column, amount, promised date, 50 a page', () => {
  const source = read('src/modules/sales/OutboundWorkbench.tsx')
  const list = source.slice(source.indexOf('function OrderList()'), source.indexOf('const DEMAND_FILTERS'))
  assert.match(source, /const ORDER_LIST_PAGE_SIZE = 50;/)
  assert.match(list, /pageSize = ORDER_LIST_PAGE_SIZE/)
  // One status column, marked as the phone card's status.
  assert.match(list, /data-card-status="">\{copy\("状态"\)\}<\/th>/)
  assert.doesNotMatch(list, /copy\("预留状态"\)\]|copy\("履约状态"\)\]/)
  assert.doesNotMatch(list, /<Badge value=\{row\.reservationStatus\}/)
  assert.match(list, /\{copy\("订单金额"\)\}<\/th>/)
  assert.match(list, /\{copy\("承诺交期"\)\}<\/th>/)
  assert.match(list, /<ListPager /)
  // The order detail's tables become phone cards too.
  assert.match(source, /ref=\{listTableCardsRef\} data-testid="sales-order-lines-table"/)
  assert.match(source, /<div className=\{tableScrollClass\} ref=\{listTableCardsRef\}>/)

  const sales = read('src/modules/sales/Page.tsx')
  // Order evidence pages 50 as well, so the same orders read the same pages.
  assert.match(sales, /const EVIDENCE_PAGE_SIZE = 50;/)
  // A shipped order reads "Fulfilled" / 已履约 there too, not "Completed".
  assert.match(sales, /"fulfilled": "已履约"/)
  assert.match(sales, /StatusChip label=\{copy\(orderStatusLabel\(order\)\)\}/)
  // The Shipment risks card: "3,548 / Sales orders", the list's own term.
  assert.match(sales, /label=\{say\("Sales orders", "销售订单"\)\} value=\{figure\(summary\?\.totalOrders, qty\)\}/)
  assert.doesNotMatch(sales, /"Customer order"/)
})
