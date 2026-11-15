import test from 'node:test'
import assert from 'node:assert/strict'
import { PROCUREMENT_SNAPSHOT_ROWS, todayReadLimitations } from './today-read-service.mjs'

// Design audit 2026-11-15 (L11-04): the truncations the business context and
// the reorder list reported, and the procurement snapshot lists that filled
// their limit, never reached closableAreas.
const reader = ({ raw = {}, reorder = null, limitations = [] } = {}) => ({
  raw, context: { dataLimitations: [] }, read: { limitations, sources: reorder ? { reorder } : {} },
})
const many = (count) => Array.from({ length: count }, (_, index) => ({ id: `R-${index}` }))

test('every truncation of Today\'s reads is passed on', () => {
  assert.deepEqual(todayReadLimitations(reader()), [])
  assert.deepEqual(todayReadLimitations(reader({ raw: { truncatedSubjects: [{ subject: 'items', limit: 2000 }, { subject: 'purchase_orders', limit: 500 }] } })), ['truncated:items', 'truncated:purchase_orders'])
  // Sales orders cut where every order with open demand was read are history.
  assert.deepEqual(todayReadLimitations(reader({ raw: { truncatedSubjects: [{ subject: 'sales_orders', openDemandComplete: true }] } })), [])
  assert.deepEqual(todayReadLimitations(reader({ reorder: { dataLimitations: ['transfers_not_considered', 'truncated:shipment_lines'] } })), ['truncated:shipment_lines'])
  // A snapshot list at its limit may be cut; one below it is whole.
  assert.deepEqual(todayReadLimitations(reader({ raw: { purchaseRequests: many(PROCUREMENT_SNAPSHOT_ROWS), supplierInvoices: many(PROCUREMENT_SNAPSHOT_ROWS - 1) } })), ['truncated:purchase_requests'])
  assert.deepEqual(todayReadLimitations(reader({ raw: { supplierInvoices: many(PROCUREMENT_SNAPSHOT_ROWS) }, limitations: ['truncated:receivables'] })), ['truncated:receivables', 'truncated:supplier_invoices'])
})
