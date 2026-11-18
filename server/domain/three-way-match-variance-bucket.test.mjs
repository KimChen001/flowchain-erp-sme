import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { buildProcurementSummary, buildProcurementThreeWayMatches } from './procurement-read-model.mjs'
import { matchResultOf } from '../../src/modules/procurement/threeWayMatchResult.ts'

// The three-way match list's Variances card and ?result=variance (a follow-up
// to design audit B2, 2026-11-18). On the UCI walkthrough data the cards read
// "Matched 325 / Variances 7": six auto-matched invoices with a variance inside
// the tolerance (£0.10 to £0.98) were counted with the one held exception.
const read = (file) => readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8')

const invoice = (id, overrides) => ({
  id, invoiceNumber: id, supplier: 'Supplier', relatedPo: 'PO-1', relatedGrn: 'GRN-1',
  amount: 100, currency: 'GBP', varianceAmount: 0, workflowStatus: 'matched', ...overrides,
})
const data = {
  purchaseOrders: [{ po: 'PO-1', supplier: 'Supplier', amount: 100, currency: 'GBP' }],
  receivingDocs: [],
  supplierInvoices: [
    // Matched inside the tolerance: the database read says 自动匹配 for a stored "matched".
    invoice('INV-AUTO-1', { amount: 100.98, varianceAmount: 0.98, matchStatus: '自动匹配' }),
    invoice('INV-AUTO-2', { amount: 100.1, varianceAmount: 0.1, matchStatus: 'matched' }),
    invoice('INV-EXACT', { matchStatus: '自动匹配' }),
    // Every difference approved.
    invoice('INV-APPROVED', { amount: 104, varianceAmount: 4, matchStatus: 'variance_approved', workflowStatus: 'approved' }),
    // The held exception (INV-SUP-22-0049 on the UCI walkthrough).
    invoice('INV-HELD', { amount: 112.5, varianceAmount: 12.5, matchStatus: 'exception', workflowStatus: 'exception', matchExceptions: { count: 1, open: 1, approved: 0, rejected: 0 } }),
    // Not matched yet.
    invoice('INV-WAITING', { matchStatus: '未匹配', workflowStatus: 'submitted' }),
  ],
}

test('a match inside the tolerance counts under Matched, not Variances, and keeps its variance on the list', () => {
  const rows = buildProcurementThreeWayMatches(data)
  const result = Object.fromEntries(rows.map((row) => [row.invoiceId, matchResultOf(row)]))
  assert.deepEqual(result, {
    'INV-AUTO-1': 'matched', 'INV-AUTO-2': 'matched', 'INV-EXACT': 'matched', 'INV-APPROVED': 'matched',
    'INV-HELD': 'variance', 'INV-WAITING': 'pending',
  })
  // The cards and ?result=variance read the same rule: one held exception.
  const count = (name) => rows.filter((row) => matchResultOf(row) === name).length
  assert.deepEqual({ matched: count('matched'), pending: count('pending'), variance: count('variance') }, { matched: 4, pending: 1, variance: 1 })
  assert.deepEqual(rows.filter((row) => matchResultOf(row) === 'variance').map((row) => row.invoiceId), ['INV-HELD'])
  // The Variance column still shows the actual amount.
  assert.equal(rows.find((row) => row.invoiceId === 'INV-AUTO-1').varianceAmount, 0.98)
  assert.equal(rows.find((row) => row.invoiceId === 'INV-AUTO-2').varianceAmount, 0.1)
  // The summary the API and the assistant read counts the same one exception.
  assert.equal(buildProcurementSummary(data).threeWayMatchExceptionCount, 1)
})

test('the match list counts its cards and filters its rows with that one rule', () => {
  const page = read('src/modules/procurement/ThreeWayMatchListPage.tsx')
  assert.match(page, /import \{ matchResultOf, type MatchResult \} from "\.\/threeWayMatchResult";/)
  assert.match(page, /\(!result \|\| matchResultOf\(row\) === result\)/)
  assert.match(page, /const count = \(name: MatchResult\) => rows\.filter\(\(row\) => matchResultOf\(row\) === name\)\.length;/)
  // The variance amount no longer decides the result.
  assert.doesNotMatch(page, /Number\(row\.varianceAmount \|\| 0\) !== 0\) return "variance"/)
})
