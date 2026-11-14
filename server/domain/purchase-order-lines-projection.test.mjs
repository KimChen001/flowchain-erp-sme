import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { purchaseOrderLinesProjection } from './purchase-order-lines-projection.mjs'

// Round 9 sweep: the Order lines page showed a supplier invoice by its record
// id (a17a66b1-…) because the lines view dropped the supplier's own number.
test('the order lines view keeps the supplier invoice number the page shows', () => {
  const snapshot = {
    supplierInvoices: [{ id: 'a17a66b1-996b-4ed3-a461-9b517be308c6', invoiceNumber: 'a17a66b1-996b-4ed3-a461-9b517be308c6', supplierInvoiceNumber: 'S21-7790', relatedPo: 'PO-1', notes: 'left out', lines: [{ poLine: 'L1', quantity: 70, varianceAmount: 2.1, memo: 'left out' }] }],
  }
  const [invoice] = purchaseOrderLinesProjection(snapshot).supplierInvoices
  assert.equal(invoice.supplierInvoiceNumber, 'S21-7790')
  assert.equal(invoice.notes, undefined)
  assert.deepEqual(invoice.lines, [{ poLine: 'L1', quantity: 70, varianceAmount: 2.1 }])
})

test('the order lines page names an invoice by the supplier number, never its id', async () => {
  const page = await readFile(new URL('../../src/modules/procurement/OrderFulfillmentLinesPage.tsx', import.meta.url), 'utf8')
  assert.match(page, /entry\.invoice\.supplierInvoiceNumber \|\| entry\.invoice\.invoiceNumber/)
  assert.match(page, /receiptNumbers\.get\(id\) \|\| id : invoiceNumbers\.get\(id\) \|\| id/)
})
