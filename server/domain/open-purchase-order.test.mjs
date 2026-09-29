import assert from 'node:assert/strict'
import test from 'node:test'
import { isOpenPurchaseOrder, purchaseOrderLineRemaining } from './open-purchase-order.mjs'

const line = (orderedQuantity, receivedQuantity) => ({ orderedQuantity, receivedQuantity })
const po = (status, lines = [line('10', '0')]) => ({ status, lines })

test('committed purchase orders with quantity still to receive are open', () => {
  assert.equal(isOpenPurchaseOrder(po('approved')), true)
  assert.equal(isOpenPurchaseOrder(po('issued')), true)
  assert.equal(isOpenPurchaseOrder(po('partially_received', [line('10', '4')])), true)
})

test('orders not yet committed to the supplier are not open', () => {
  // Counting these was what inflated the open count and the open amount total.
  assert.equal(isOpenPurchaseOrder(po('draft')), false)
  assert.equal(isOpenPurchaseOrder(po('pending_approval')), false)
})

test('finished orders are not open', () => {
  for (const status of ['fully_received', 'rejected', 'cancelled']) {
    assert.equal(isOpenPurchaseOrder(po(status)), false, status)
  }
})

test('a committed order whose lines are all received is not open, even if its status is stale', () => {
  // The overview card had no line check, so this case could show on the card
  // but not in the open purchase orders report.
  assert.equal(isOpenPurchaseOrder(po('issued', [line('10', '10'), line('5', '5')])), false)
  assert.equal(isOpenPurchaseOrder(po('issued', [line('10', '10'), line('5', '4')])), true)
})

test('unknown quantities keep the order open so incomplete data is surfaced, not dropped', () => {
  assert.equal(isOpenPurchaseOrder(po('issued', [line(null, '0')])), true)
  assert.equal(isOpenPurchaseOrder(po('issued', [line('10', undefined)])), true)
  assert.equal(isOpenPurchaseOrder(po('issued', [])), true, 'a committed order with no lines is open')
  assert.equal(isOpenPurchaseOrder(po('draft', [])), false, 'an uncommitted order with no lines is not')
})

test('status aliases known to the status authority are honoured', () => {
  assert.equal(isOpenPurchaseOrder(po('open')), true)
  assert.equal(isOpenPurchaseOrder(po('ready_for_receiving')), true)
  assert.equal(isOpenPurchaseOrder(po('部分收货', [line('10', '4')])), true)
})

test('an unrecognised status is never assumed open', () => {
  // Deliberate fail-closed behaviour. The previous copies treated anything not
  // on a list of closed words as open, so a Chinese "completed" label counted
  // as open. Statuses the status authority does not recognise are now excluded.
  for (const status of ['已完成', '已发出', 'Issued', '', undefined, null, 'something_else']) {
    assert.equal(isOpenPurchaseOrder(po(status)), false, String(status))
  }
  assert.equal(isOpenPurchaseOrder(null), false)
  assert.equal(isOpenPurchaseOrder(undefined), false)
})

test('line remaining quantity is exact to four decimals and never negative', () => {
  assert.equal(purchaseOrderLineRemaining(line('10', '4')), 6)
  assert.equal(purchaseOrderLineRemaining(line('10.0000', '9.9999')), 0.0001)
  assert.equal(purchaseOrderLineRemaining(line('3', '5')), 0, 'over-received lines do not go negative')
  assert.equal(purchaseOrderLineRemaining({ quantity: '8', receivedQuantity: '3' }), 5, 'falls back to quantity')
  assert.equal(purchaseOrderLineRemaining(line('', '0')), null)
  assert.equal(purchaseOrderLineRemaining(line('10', 'x')), null)
})
