import test from 'node:test'
import assert from 'node:assert/strict'
import { customerPaymentTerm, nextInvoiceNumber } from './operational-finance-o2c-read-service.mjs'

// Walkthrough 2026-10-07: the customer invoice number had to be typed, and the
// due date was blank although the customer was recorded as NET30.
test('the next customer invoice number follows the highest INV- number, starting at INV-1001', () => {
  assert.equal(nextInvoiceNumber([]), 'INV-1001')
  assert.equal(nextInvoiceNumber(['INV-1001', 'INV-1009', 'inv-1003']), 'INV-1010')
  // Numbers in another style are left alone, and never lower the suggestion.
  assert.equal(nextInvoiceNumber(['2026-0042', 'INV-ABC', 'INV-0042']), 'INV-1001')
})

test("a customer's payment terms count when they name one of the workspace's terms", () => {
  const terms = [
    { code: 'DUE', name: 'Due on receipt', days: 0 },
    { code: 'NET30', name: 'Net 30', days: 30 },
    { code: 'MONTHEND', name: 'Month end', days: null },
  ]
  assert.deepEqual(customerPaymentTerm('NET30', terms), { code: 'NET30', name: 'Net 30', days: 30 })
  assert.deepEqual(customerPaymentTerm('net 30', terms), { code: 'NET30', name: 'Net 30', days: 30 })
  assert.deepEqual(customerPaymentTerm('Due on receipt', terms), { code: 'DUE', name: 'Due on receipt', days: 0 })
  // Free text that names no term, and a term without days, leave the due date to the person.
  assert.equal(customerPaymentTerm('2/10 net 30', terms), null)
  assert.equal(customerPaymentTerm('Month end', terms), null)
  assert.equal(customerPaymentTerm('', terms), null)
})
