import test from 'node:test'
import assert from 'node:assert/strict'
import { pickRecentDocuments, RECENT_DOCUMENTS, RECENT_DOCUMENTS_PER_TYPE } from '../services/business-read-context-service.mjs'

// Today's Recent documents (round 8): a day of seeded customer invoices filled
// all ten rows. Now no type takes more than three rows while other types have
// documents, each type shows its newest, and the list stays newest first.

const at = (minute) => `2026-11-07T23:${String(minute).padStart(2, '0')}:00.000Z`
const doc = (type, id, minute) => ({ type, id, updatedAt: at(minute) })

test('one busy type does not fill the list while other types have documents', () => {
  const invoices = Array.from({ length: 12 }, (_, index) => doc('customer_invoice', `CI-${index}`, 50 + (index % 9)))
  const others = [doc('purchase_order', 'PO-1', 10), doc('purchase_order', 'PO-2', 9), doc('receipt', 'GRN-1', 8), doc('sales_order', 'SO-1', 5), doc('purchase_request', 'PR-1', 1)]
  const picked = pickRecentDocuments([...invoices, ...others])
  assert.equal(picked.length, RECENT_DOCUMENTS)
  assert.equal(picked.filter((row) => row.type === 'customer_invoice').length, RECENT_DOCUMENTS_PER_TYPE)
  assert.deepEqual(new Set(picked.map((row) => row.type)), new Set(['customer_invoice', 'purchase_order', 'receipt', 'sales_order', 'purchase_request']))
  // The invoices shown are the newest invoices, and the list is newest first.
  const newestInvoices = invoices.map((row) => Date.parse(row.updatedAt)).sort((a, b) => b - a).slice(0, RECENT_DOCUMENTS_PER_TYPE)
  assert.deepEqual(picked.filter((row) => row.type === 'customer_invoice').map((row) => Date.parse(row.updatedAt)), newestInvoices)
  const times = picked.map((row) => Date.parse(row.updatedAt))
  assert.deepEqual(times, [...times].sort((a, b) => b - a))
})

test('with too few types the list fills up from the newest of the rest', () => {
  const picked = pickRecentDocuments([...Array.from({ length: 10 }, (_, index) => doc('customer_invoice', `CI-${index}`, index)), doc('purchase_order', 'PO-1', 30)])
  assert.equal(picked.length, RECENT_DOCUMENTS)
  assert.equal(picked[0].id, 'PO-1')
  assert.deepEqual(picked.slice(1).map((row) => row.id), ['CI-9', 'CI-8', 'CI-7', 'CI-6', 'CI-5', 'CI-4', 'CI-3'])
})

test('fewer documents than the limit are all shown', () => {
  assert.deepEqual(pickRecentDocuments([doc('receipt', 'GRN-1', 1), doc('receipt', 'GRN-2', 2)]).map((row) => row.id), ['GRN-2', 'GRN-1'])
  assert.deepEqual(pickRecentDocuments([]), [])
})
