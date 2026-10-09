import test from 'node:test'
import assert from 'node:assert/strict'
import * as insights from './supplier-insights.mjs'
import { buildSupplierInsights, supplierPurchaseRecords, supplierPurchaseTotals } from './supplier-insights.mjs'

const window = { from: '2025-10-05', to: '2026-10-04' }
const po = (supplierId, amount, extra = {}) => ({ supplierId, status: 'issued', totalAmount: amount, currency: 'USD', createdAt: '2026-09-01', lines: [], ...extra })
const suppliers = ['A', 'B', 'C', 'D'].map((id) => ({ id, name: `Supplier ${id}`, status: 'active' }))

test('12-month totals count committed orders by business date, per currency', () => {
  const totals = supplierPurchaseTotals([
    po('A', 100), po('A', 50, { currency: 'EUR' }), po('A', 70, { status: 'draft' }), po('A', 80, { status: 'cancelled' }),
    po('A', 90, { createdAt: '2024-01-01' }), po('B', null), po('', 10),
  ], window)
  assert.deepEqual(Object.fromEntries(totals.get('A').byCurrency), { USD: 100, EUR: 50 })
  assert.equal(totals.get('A').orders, 2)
  assert.equal(totals.get('B').amountKnown, false)
  assert.equal(totals.has(''), false)
})

test('metrics are null when the reader may not see them', () => {
  const totals = supplierPurchaseTotals([po('A', 100)], window)
  const openRows = [{ supplierId: 'A', isOpen: true, overdueDays: 3 }, { supplierId: 'A', isOpen: true, overdueDays: 0 }]
  const signals = [{ type: 'po_overdue', supplierId: 'A' }, { type: 'po_due_7d', supplierId: 'A' }, { type: 'invoice_variance', supplierId: 'A' }, { type: 'invoice_variance', supplierId: '' }]
  const seen = buildSupplierInsights({ suppliers, totals, openRows, signals, visibility: { orders: true, amounts: true, onTime: false, issues: true } }).A
  assert.deepEqual([seen.spend12m, seen.openPos, seen.overduePos, seen.onTime, seen.openIssues], [[{ currency: 'USD', amount: 100 }], 2, 1, null, 2])
  const hidden = buildSupplierInsights({ suppliers, totals, openRows, signals, visibility: { orders: false, amounts: false, onTime: false, issues: false } }).A
  assert.deepEqual([hidden.spend12m, hidden.orders12m, hidden.openPos, hidden.overduePos, hidden.onTime, hidden.openIssues], [null, null, null, null, null, null])
})

test('FlowChain suggests no tier: tiers are set by a person (owner decision 2026-10-09)', () => {
  const row = buildSupplierInsights({ suppliers, totals: supplierPurchaseTotals([po('A', 100)], window), visibility: { orders: true, amounts: true, onTime: true, issues: true } }).A
  assert.equal('suggestion' in row, false)
  assert.equal(Object.keys(insights).some((name) => /suggest|concentration|itemSources/i.test(name)), false)
})

test('purchase records use the workspace day and the due day the open purchase orders report counts from', () => {
  // Entered at 21:00 New York time on Sep 30, which is already Oct 1 in UTC.
  const late = po('A', 100, { id: 'PO-EVENING', createdAt: '2026-10-01T01:00:00.000Z' })
  // The earlier line is received; the open line is due Sep 20.
  const split = po('A', 100, { id: 'PO-SPLIT', createdAt: '2026-09-01T12:00:00.000Z', lines: [
    { orderedQuantity: 5, receivedQuantity: 5, unit: 'pcs', metadata: { promisedDate: '2026-09-10' } },
    { orderedQuantity: 5, receivedQuantity: 0, unit: 'pcs', metadata: { promisedDate: '2026-09-20' } },
  ] })
  const rows = supplierPurchaseRecords([late, split], 'A', { timeZone: 'America/New_York' }).rows
  assert.equal(rows.find((row) => row.id === 'PO-EVENING').date, '2026-09-30')
  assert.equal(rows.find((row) => row.id === 'PO-SPLIT').promisedDate, '2026-09-20')
  assert.equal(supplierPurchaseRecords([late], 'A', { timeZone: 'Asia/Shanghai' }).rows[0].date, '2026-10-01')
})
