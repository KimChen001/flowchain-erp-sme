import test from 'node:test'
import assert from 'node:assert/strict'
import { invoiceExceptionDraft } from './invoice-exception-draft.mjs'

const INVOICE = { id: 'INV-1', invoiceNumber: 'BILL-202611-0007', orderId: 'PO-A', orderNumber: 'PO-202610-0022', currency: 'GBP', supplierId: 'SUP-1', supplierName: 'Acme Home Goods' }
const line = (id, fields) => ({ [id]: { sku: '85123A', unit: 'pcs', orderedQuantity: 240, receivedQuantity: 240, previouslyInvoicedQuantity: 0, invoiceQuantity: 240, poUnitPrice: 1.27, invoiceUnitPrice: 1.27, ...fields } })

test('a price above the order price that another order already carries reads as a price change to review', () => {
  const draft = invoiceExceptionDraft({
    invoice: INVOICE,
    exceptions: [
      { id: 'EX-1', matchLineId: 'L1', exceptionType: 'price', status: 'open', expectedValue: '1.27', actualValue: '1.32', varianceValue: '0.05' },
      // The amount difference on the same line follows from the price.
      { id: 'EX-2', matchLineId: 'L1', exceptionType: 'amount', status: 'open', expectedValue: '304.8', actualValue: '316.8', varianceValue: '12' },
    ],
    lines: line('L1', { invoiceUnitPrice: 1.32 }),
    orderPrices: [{ sku: '85123A', unitPrice: '1.32', orderId: 'PO-B', orderNumber: 'PO-202611-0003' }, { sku: '85123A', unitPrice: '1.27', orderId: 'PO-A', orderNumber: 'PO-202610-0022' }],
    supplier: { contactName: 'Order desk', email: 'orders@acme.example' },
  })
  assert.equal(draft.type, 'invoice_exception')
  assert.equal(draft.step, 'review_price')
  assert.equal(draft.differences.length, 1)
  assert.deepEqual(draft.differences[0], { exceptionId: 'EX-1', kind: 'price', sku: '85123A', unit: 'pcs', cause: 'price_changed', expected: 1.27, actual: 1.32, variance: 0.05, percent: 3.9, evidenceOrder: 'PO-202611-0003' })
  assert.deepEqual(draft.supplier, { id: 'SUP-1', name: 'Acme Home Goods', contactName: 'Order desk', email: 'orders@acme.example' })
})

test('a price no order shows reads as an invoice priced wrong, and the step is to ask the supplier', () => {
  const draft = invoiceExceptionDraft({
    invoice: INVOICE,
    exceptions: [{ id: 'EX-1', matchLineId: 'L1', exceptionType: 'price', status: 'open', expectedValue: '1.27', actualValue: '1.35' }],
    lines: line('L1', { invoiceUnitPrice: 1.35 }),
    orderPrices: [{ sku: '85123A', unitPrice: '1.27', orderId: 'PO-A' }],
  })
  assert.equal(draft.differences[0].cause, 'invoice_price')
  assert.equal(draft.step, 'ask_supplier')
})

test('quantity: more than ordered, billed twice, or not received yet', () => {
  const over = invoiceExceptionDraft({ invoice: INVOICE, exceptions: [{ id: 'E', matchLineId: 'L', exceptionType: 'quantity', status: 'open' }], lines: line('L', { invoiceQuantity: 250 }) })
  assert.equal(over.differences[0].cause, 'over_ordered')
  const twice = invoiceExceptionDraft({ invoice: INVOICE, exceptions: [{ id: 'E', matchLineId: 'L', exceptionType: 'quantity', status: 'open' }], lines: line('L', { previouslyInvoicedQuantity: 120, invoiceQuantity: 120, receivedQuantity: 120, orderedQuantity: 240 }) })
  assert.equal(twice.differences[0].cause, 'already_invoiced')
  const early = invoiceExceptionDraft({ invoice: INVOICE, exceptions: [{ id: 'E', matchLineId: 'L', exceptionType: 'quantity', status: 'open' }], lines: line('L', { receivedQuantity: 120, invoiceQuantity: 240 }) })
  assert.equal(early.differences[0].cause, 'not_yet_received')
  assert.equal(early.differences[0].missing, 120)
  // Every difference is goods not yet received: check the receipt, then match again.
  assert.equal(early.step, 'wait_receipt')
})

test('an amount difference alone, a reviewed exception, and a reader who cannot see prices', () => {
  const amount = invoiceExceptionDraft({ invoice: INVOICE, exceptions: [{ id: 'E', matchLineId: 'L', exceptionType: 'amount', status: 'open', expectedValue: '304.8', actualValue: '310', varianceValue: '5.2' }], lines: line('L', {}) })
  assert.equal(amount.differences[0].cause, 'line_amount')
  assert.equal(amount.step, 'ask_supplier')
  // An approved exception no longer holds the invoice.
  assert.equal(invoiceExceptionDraft({ invoice: INVOICE, exceptions: [{ id: 'E', matchLineId: 'L', exceptionType: 'amount', status: 'approved' }], lines: line('L', {}) }), null)
  const hidden = invoiceExceptionDraft({ invoice: INVOICE, amountsVisible: false, exceptions: [{ id: 'E', matchLineId: 'L', exceptionType: 'price', status: 'open', expectedValue: '1.27', actualValue: '1.32' }], lines: line('L', { invoiceUnitPrice: 1.32 }), orderPrices: [{ sku: '85123A', unitPrice: '1.32', orderId: 'PO-B' }] })
  assert.deepEqual([hidden.differences[0].expected, hidden.differences[0].actual, hidden.differences[0].cause], [null, null, null])
  assert.equal(hidden.amountsVisible, false)
})
