import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  invoiceVarianceState,
  isCancelledInvoice,
  nextActionText,
  nextOpenAction,
  notInvoicedOf,
  paymentAmountsText,
  paymentStateLabel,
  paymentSummary,
} from '../../src/modules/purchasing/components/purchaseOrderStory.ts'

// What a purchase order still waits on once the supplier has it (UI review
// round 7, finding 1): a variance whose exceptions were all approved is
// settled, the next action comes from what is left to receive, invoice and
// pay, and payment is a stage of its own.

const words = (language = 'en-US', symbol = '$') => ({
  language,
  quantity: (value, unit) => `${value} ${language === 'en-US' ? unit : '件'}`,
  number: (value) => String(value),
  money: (value) => `${symbol}${value.toFixed(2)}`,
})

// The English walk's PO-202611-0008: 24 pcs received in two receipts and
// invoiced in two invoices; B had an amount variance that was approved, then
// both invoices were approved; A is paid, B partly.
const invoiceA = { workflowStatus: 'approved', matchStatus: '自动匹配', hasVariance: false, matchExceptions: { count: 0, open: 0, approved: 0, rejected: 0 }, payment: { status: 'settled', amount: 19.6, openAmount: 0 } }
const invoiceB = { workflowStatus: 'approved', matchStatus: 'exception', hasVariance: true, matchExceptions: { count: 1, open: 0, approved: 1, rejected: 0 }, payment: { status: 'partially_settled', amount: 29.4, openAmount: 9.8 } }
const line = (ordered, accepted, invoiced, unit = 'pcs') => ({ ordered, accepted, invoiced, unit })

test('a variance is settled once every exception is approved, whatever the stored match status says', () => {
  assert.equal(invoiceVarianceState(invoiceA), 'none')
  assert.equal(invoiceVarianceState(invoiceB), 'approved')
  // Before the invoice itself is approved, the exceptions decide.
  const exceptionStatus = { ...invoiceB, workflowStatus: 'exception' }
  assert.equal(invoiceVarianceState(exceptionStatus), 'approved')
  assert.equal(invoiceVarianceState({ ...exceptionStatus, matchExceptions: { count: 2, open: 1, approved: 1, rejected: 0 } }), 'open')
  assert.equal(invoiceVarianceState({ ...exceptionStatus, matchExceptions: { count: 1, open: 0, approved: 0, rejected: 1 } }), 'rejected')
  // The server's own word for it (finance fixer: variance_approved) is enough on its own.
  assert.equal(invoiceVarianceState({ hasVariance: true, matchStatus: 'variance_approved' }), 'approved')
  // A variance nobody decided on yet is open.
  assert.equal(invoiceVarianceState({ hasVariance: true, matchStatus: 'exception', workflowStatus: 'exception' }), 'open')
  assert.equal(isCancelledInvoice({ workflowStatus: 'cancelled', status: '存在差异' }), true)
  assert.equal(isCancelledInvoice({ status: 'cancelled' }), true)
})

test('payment reads paid, partly paid or outstanding from the payables, with the amounts', () => {
  const both = paymentSummary([invoiceA, invoiceB])
  assert.deepEqual(both, { state: 'partly_paid', paid: 39.2, open: 9.8, owed: 49 })
  assert.equal(paymentAmountsText(both, words()), '$39.20 paid · $9.80 outstanding')
  assert.equal(paymentStateLabel(both.state, 'en-US'), 'Partly paid')
  assert.equal(paymentStateLabel(both.state, 'zh-CN'), '部分付款')
  const paid = paymentSummary([invoiceA])
  assert.equal(paid.state, 'paid')
  assert.equal(paymentAmountsText(paid, words()), '$19.60 paid')
  const owed = paymentSummary([{ ...invoiceA, payment: { status: 'approved', amount: 19.6, openAmount: 19.6 } }])
  assert.deepEqual([owed.state, paymentAmountsText(owed, words('zh-CN', '£'))], ['outstanding', '未付 £19.60'])
  // No approved invoice yet: nothing to pay; a cancelled invoice does not count.
  assert.equal(paymentSummary([{ hasVariance: false, workflowStatus: 'submitted', payment: null }]).state, 'none')
  assert.equal(paymentSummary([{ ...invoiceA, workflowStatus: 'cancelled' }]).state, 'none')
  // An approved invoice with no payable recorded is owed, its amount unknown;
  // one whose payment the read does not carry (the PO list) is unknown.
  assert.deepEqual(paymentSummary([{ hasVariance: false, workflowStatus: 'approved', payment: null }]), { state: 'outstanding', paid: null, open: null, owed: null })
  assert.equal(paymentSummary([{ hasVariance: false, workflowStatus: 'approved' }]).state, 'unknown')
  // Amounts hidden from the role: the state still reads from the payable's status.
  const hidden = paymentSummary([{ hasVariance: false, payment: { status: 'settled', amount: null, openAmount: null } }])
  assert.deepEqual(hidden, { state: 'paid', paid: null, open: null, owed: null })
  assert.equal(paymentAmountsText(hidden, words()), '')
})

test('the order reads paid only once all of it is invoiced and paid (round 7b, finding 1)', () => {
  // The Chinese walk's PO-202611-0010: 110 pcs at £0.42 (£46.20), 70 invoiced
  // and paid in full (£31.50), 40 not invoiced yet.
  const settled = { ...invoiceB, payment: { status: 'settled', amount: 31.5, openAmount: 0 } }
  const left = notInvoicedOf([line(110, 110, 70)])
  assert.deepEqual(left, { quantity: 40, unit: 'pcs', lines: 1 })
  const partly = paymentSummary([settled], { ordered: 46.2, notInvoiced: left })
  assert.equal(partly.state, 'partly_paid')
  assert.equal(paymentStateLabel(partly.state, 'en-US'), 'Partly paid')
  assert.equal(paymentStateLabel(partly.state, 'zh-CN'), '部分付款')
  assert.equal(paymentAmountsText(partly, words('en-US', '£')), '£31.50 paid of £46.20 ordered · 40 pcs not invoiced')
  assert.equal(paymentAmountsText(partly, words('zh-CN', '£')), '已付 £31.50 / 订单 £46.20 · 40 件未开票')
  // The progress steps leave the not-invoiced part to the invoice step and say the state.
  assert.equal(paymentAmountsText(partly, words('en-US', '£'), { brief: true }), 'Partly paid')
  assert.equal(paymentAmountsText(partly, words('zh-CN', '£'), { brief: true }), '部分付款')
  // Amounts hidden: the state alone.
  assert.equal(paymentAmountsText(paymentSummary([{ ...settled, payment: { status: 'settled', amount: null, openAmount: null } }], { ordered: null, notInvoiced: left }), words()), '')
  // Some of the invoices still open: what is paid, outstanding and not invoiced.
  const open = paymentSummary([invoiceA, invoiceB], { ordered: 98, notInvoiced: notInvoicedOf([line(48, 24, 24)]) })
  assert.equal(open.state, 'partly_paid')
  assert.equal(paymentAmountsText(open, words()), '$39.20 paid · $9.80 outstanding · 24 pcs not invoiced')
  // Lines in different units are counted as lines.
  assert.equal(paymentAmountsText(paymentSummary([settled], { ordered: 46.2, notInvoiced: notInvoicedOf([line(5, 5, 0, 'box'), line(3, 3, 1)]) }), words('en-US', '£')), '£31.50 paid of £46.20 ordered · 2 lines not invoiced')
  // The whole order invoiced and paid: paid.
  const whole = paymentSummary([settled], { ordered: 31.5, notInvoiced: notInvoicedOf([line(75, 75, 75)]) })
  assert.equal(whole.state, 'paid')
  assert.equal(paymentAmountsText(whole, words('en-US', '£')), '£31.50 paid')
  // A closed order counts what was received, not what was ordered.
  assert.equal(notInvoicedOf([line(110, 70, 70)], true), null)
  assert.deepEqual(notInvoicedOf([line(110, 70, 70)]), { quantity: 40, unit: 'pcs', lines: 1 })
  // Nothing approved yet: nothing to pay, whatever is not invoiced.
  assert.equal(paymentSummary([{ hasVariance: false, workflowStatus: 'submitted', payment: null }], { ordered: 46.2, notInvoiced: left }).state, 'none')
})

test('the next action follows what is left, in the order the work happens', () => {
  // Everything received and invoiced, B partly paid: awaiting payment, not human review.
  const final = nextOpenAction({ receivable: false, lines: [line(24, 24, 24)], invoices: [invoiceA, invoiceB] })
  assert.deepEqual(final, { kind: 'pay', open: 9.8 })
  assert.equal(nextActionText(final, words()), 'Awaiting payment: $9.80 outstanding')
  // The Chinese walk's PO-202611-0009: 60 received, 40 invoiced and paid in full.
  const zh = nextOpenAction({ receivable: false, lines: [line(60, 60, 40)], invoices: [{ ...invoiceB, payment: { status: 'settled', amount: 90, openAmount: 0 } }] })
  assert.equal(zh.kind, 'invoice_rest')
  assert.equal(nextActionText(zh, words()), 'Record a supplier invoice for the remaining 20 pcs')
  assert.equal(nextActionText(zh, words('zh-CN')), '为剩余 20 件录入采购发票')
  // Issued, nothing received: receive; partly received: the rest.
  assert.equal(nextActionText(nextOpenAction({ receivable: true, lines: [line(24, 0, 0)], invoices: [] }), words()), 'Receive 24 pcs when they arrive')
  assert.equal(nextActionText(nextOpenAction({ receivable: true, lines: [line(24, 10, 0)], invoices: [] }), words()), 'Receive the remaining 14 pcs')
  // Lines in different units are counted as lines.
  assert.equal(nextActionText(nextOpenAction({ receivable: true, lines: [line(5, 0, 0, 'box'), line(3, 1, 0)], invoices: [] }), words()), 'Receive the rest of 2 lines')
  // A variance to decide comes first, a rejected one asks for a corrected invoice.
  assert.equal(nextOpenAction({ receivable: true, lines: [line(24, 10, 10)], invoices: [{ ...invoiceB, workflowStatus: 'exception', matchExceptions: { count: 1, open: 1, approved: 0, rejected: 0 } }] }).kind, 'review_invoice_variance')
  assert.equal(nextOpenAction({ receivable: true, lines: [line(24, 10, 10)], invoices: [{ hasVariance: true, quantityVariance: true, workflowStatus: 'exception' }] }).kind, 'review_quantity_variance')
  assert.equal(nextOpenAction({ receivable: false, lines: [line(24, 24, 24)], invoices: [{ ...invoiceB, workflowStatus: 'exception', matchExceptions: { count: 1, open: 0, approved: 0, rejected: 1 } }] }).kind, 'variance_rejected')
  // An invoice on its way: submit, match, approve.
  const received = [line(24, 24, 24)]
  assert.equal(nextOpenAction({ receivable: false, lines: received, invoices: [{ hasVariance: false, workflowStatus: 'draft' }] }).kind, 'submit_invoice')
  assert.equal(nextOpenAction({ receivable: false, lines: received, invoices: [{ hasVariance: false, workflowStatus: 'submitted' }] }).kind, 'match_invoice')
  assert.equal(nextOpenAction({ receivable: false, lines: received, invoices: [{ ...invoiceB, workflowStatus: 'exception', payment: null }] }).kind, 'approve_invoice')
  // A cancelled invoice is not waiting on anything.
  assert.equal(nextOpenAction({ receivable: false, lines: [line(24, 24, 0)], invoices: [{ hasVariance: true, workflowStatus: 'cancelled' }] }).kind, 'invoice_rest')
  // Paid in full and nothing left: done.
  const done = nextOpenAction({ receivable: false, lines: received, invoices: [{ ...invoiceA, payment: { status: 'settled', amount: 47.04, openAmount: 0 } }] })
  assert.equal(nextActionText(done, words()), 'Nothing left to do: received, invoiced and paid')
  // The list's read has no invoice lines: nothing is said about quantities to invoice.
  assert.equal(nextOpenAction({ receivable: false, lines: [line(24, 24, 0)], invoices: [invoiceA], invoiceLinesKnown: false }).kind, 'done')
  // Nor anything about payment it did not read; an approved invoice without a payable is owed.
  const unread = nextOpenAction({ receivable: false, lines: received, invoices: [{ hasVariance: false, workflowStatus: 'approved' }] })
  assert.equal(nextActionText(unread, words()), 'Invoiced; see Payables for payment')
  assert.equal(nextActionText(nextOpenAction({ receivable: false, lines: received, invoices: [{ hasVariance: false, workflowStatus: 'approved', payment: null }] }), words()), 'Awaiting payment')
})

test('every sentence has an English source and its Chinese translation', () => {
  const source = readFileSync(new URL('../../src/modules/purchasing/components/purchaseOrderStory.ts', import.meta.url), 'utf8')
  const pairs = [...source.matchAll(/pick\(\[`?"?([^"`]+)"?`?, `?"?([^"`]+)"?`?\]\)/g)]
  assert.ok(pairs.length >= 15, `pairs found: ${pairs.length}`)
  for (const [, english, chinese] of pairs) {
    assert.doesNotMatch(english, /[㐀-鿿]/, english)
    assert.match(chinese, /[㐀-鿿]/, chinese)
  }
})
