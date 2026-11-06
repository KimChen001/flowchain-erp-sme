import test from 'node:test'
import assert from 'node:assert/strict'
import * as o2cRead from './operational-finance-o2c-read-service.mjs'

const { customerPaymentTerm } = o2cRead

// Walkthrough 2026-10-07: the customer invoice number had to be typed, and the
// due date was blank although the customer was recorded as NET30. Since
// 2026-11-04 the server assigns the number when the draft is created
// (CI-YYYYMM-NNNN), so nothing suggests one.
test('no customer invoice number is suggested; the server assigns it on create', () => {
  assert.equal(o2cRead.nextInvoiceNumber, undefined)
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
