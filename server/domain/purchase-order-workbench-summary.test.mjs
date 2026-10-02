import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { purchaseOrderWorkbenchSummary } from './purchase-order-workbench-summary.mjs'

const po = (id, status, totalAmount, currency = 'USD', lines = [{ orderedQuantity: 10, receivedQuantity: 0 }]) => ({ po: id, id, status, totalAmount, currency, lines })

test('the purchase orders header totals committed orders per currency, not every order', () => {
  const summary = purchaseOrderWorkbenchSummary([
    po('PO-DRAFT', 'draft', 100000),
    po('PO-PENDING', 'pending_approval', 20000),
    po('PO-CANCELLED', 'cancelled', 10000),
    po('PO-REJECTED', 'rejected', 5000),
    po('PO-APPROVED', 'approved', 1000.25),
    po('PO-ISSUED', 'issued', 2000.5),
    po('PO-PARTIAL', 'partially_received', 300, 'USD', [{ orderedQuantity: 10, receivedQuantity: 4 }]),
    po('PO-DONE', 'fully_received', 400, 'USD', [{ orderedQuantity: 10, receivedQuantity: 10 }]),
    po('PO-EUR', 'issued', 50, 'EUR'),
  ])
  assert.equal(summary.committedOrderCount, 5)
  assert.deepEqual(summary.committedValueByCurrency, [
    { currency: 'USD', amount: 3700.75, orderCount: 4 },
    { currency: 'EUR', amount: 50, orderCount: 1 },
  ])
  // Open orders are committed orders still to receive: the fully received one is done.
  assert.deepEqual(summary.openPurchaseOrderIds, ['PO-APPROVED', 'PO-ISSUED', 'PO-PARTIAL', 'PO-EUR'])
  assert.equal(summary.openOrderCount, 4)
})

test('an order without a currency is totalled on its own, not added to another currency', () => {
  const summary = purchaseOrderWorkbenchSummary([po('A', 'issued', 10, 'USD'), po('B', 'issued', 5, '')])
  assert.deepEqual(summary.committedValueByCurrency.map((row) => row.currency).sort(), ['', 'USD'])
})

test('the purchase orders page shows the server summary instead of adding every order', async () => {
  const route = await readFile(new URL('../routes/purchase-orders.routes.mjs', import.meta.url), 'utf8')
  assert.match(route, /summary: purchaseOrderWorkbenchSummary\(snapshot\.purchaseOrders\)/)
  const page = await readFile(new URL('../../src/modules/purchasing/Page.tsx', import.meta.url), 'utf8')
  assert.doesNotMatch(page, /orders\.reduce\(\(sum, order\) => sum \+ poAmount\(order\)/)
  assert.match(page, /Committed PO value|已承诺采购订单金额/)
})
