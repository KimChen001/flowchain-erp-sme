import test from 'node:test'
import assert from 'node:assert/strict'
import { buildSupplierInsights, spendConcentration, suggestSupplierTiers, supplierItemSources, supplierPurchaseRecords, supplierPurchaseTotals } from './supplier-insights.mjs'

const window = { from: '2025-10-05', to: '2026-10-04' }
const po = (supplierId, amount, extra = {}) => ({ supplierId, status: 'issued', totalAmount: amount, currency: 'USD', createdAt: '2026-09-01', lines: [], ...extra })
const suppliers = ['A', 'B', 'C', 'D'].map((id) => ({ id, name: `Supplier ${id}`, status: 'active' }))
const noSources = { only: new Map(), shared: new Map(), unrecorded: new Map() }

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

test('the suppliers that make the first half of spend are concentrated, the one crossing half included', () => {
  const totals = supplierPurchaseTotals([po('A', 40), po('B', 35), po('C', 25)], window)
  assert.deepEqual([...spendConcentration(suppliers, totals, { amounts: true })], [
    ['A', { share: 0.4, rank: 1, of: 3, basis: 'amount', currency: 'USD' }],
    ['B', { share: 0.35, rank: 2, of: 3, basis: 'amount', currency: 'USD' }],
  ])
  // Exactly half from one supplier stops there.
  assert.deepEqual([...spendConcentration(suppliers, supplierPurchaseTotals([po('A', 50), po('B', 30), po('C', 20)], window), { amounts: true }).keys()], ['A'])
  // Several currencies, or amounts the reader may not see, fall back to order counts.
  const mixed = supplierPurchaseTotals([po('A', 900), po('B', 10, { currency: 'EUR' }), po('B', 10, { currency: 'EUR' })], window)
  assert.deepEqual(spendConcentration(suppliers, mixed, { amounts: true }).get('B'), { share: 0.667, rank: 1, of: 2, basis: 'orders' })
  assert.equal(spendConcentration(suppliers, totals, { amounts: false }).get('A').basis, 'orders')
})

test('only recorded links make an only source; a preferred supplier alone is "sources not recorded"', () => {
  const items = [
    { id: 'I1', sku: 'SKU-1', status: 'active' }, { id: 'I2', sku: 'SKU-2', status: 'active' },
    { id: 'I3', sku: 'SKU-3', status: 'active', preferredSupplierId: 'C' }, { id: 'I4', sku: 'SKU-4', status: 'inactive' },
  ]
  const links = [
    { itemId: 'I1', supplierId: 'A' }, { itemId: 'I2', supplierId: 'A' }, { itemId: 'I2', supplierId: 'B' },
    { itemId: 'I4', supplierId: 'D' }, { itemId: 'I1', supplierId: 'D', approved: false },
  ]
  const sources = supplierItemSources({ suppliers, items, links })
  assert.deepEqual(Object.fromEntries(sources.only), { A: ['SKU-1'] })
  assert.deepEqual(Object.fromEntries(sources.shared), { A: ['SKU-2'], B: ['SKU-2'] })
  assert.deepEqual(Object.fromEntries(sources.unrecorded), { C: ['SKU-3'] })
  // A link to an inactive supplier is no source.
  const inactive = supplierItemSources({ suppliers: [...suppliers.slice(0, 3), { id: 'D', status: 'inactive' }], items, links: [{ itemId: 'I1', supplierId: 'D' }] })
  assert.equal(inactive.only.size, 0)
})

test('suggestions: Tier 1 by concentration or only source, Tier 3 for no orders and no items, else Tier 2', () => {
  const totals = supplierPurchaseTotals([po('A', 60), po('B', 30), po('B', 10)], window)
  const sources = { only: new Map([['C', ['SKU-1']]]), shared: new Map([['B', ['SKU-2']]]), unrecorded: new Map() }
  const full = suggestSupplierTiers({ suppliers, totals, sources, visibility: { orders: true, amounts: true } })
  assert.deepEqual(full.get('A'), { tier: 1, partial: false, reasons: [{ code: 'spend_share', share: 0.6, rank: 1, of: 2, basis: 'amount', currency: 'USD' }] })
  assert.deepEqual(full.get('B'), { tier: 2, partial: false, reasons: [{ code: 'orders', orders: 2 }, { code: 'other_sources', skus: ['SKU-2'], more: 0 }] })
  assert.deepEqual(full.get('C'), { tier: 1, partial: false, reasons: [{ code: 'only_source', skus: ['SKU-1'], more: 0 }, { code: 'no_orders' }] })
  assert.deepEqual(full.get('D'), { tier: 3, partial: false, reasons: [{ code: 'no_orders' }, { code: 'not_a_source' }] })
  // Without purchase orders only sources show, and "no orders" is never claimed.
  const partial = suggestSupplierTiers({ suppliers, totals, sources, visibility: { orders: false } })
  assert.deepEqual([...partial.values()].map((row) => [row.tier, row.partial]), [[null, true], [2, true], [1, true], [null, true]])
  assert.ok([...partial.values()].every((row) => row.reasons.every((reason) => !['orders', 'no_orders', 'spend_share', 'not_a_source'].includes(reason.code))))
})

test('metrics are null when the reader may not see them', () => {
  const totals = supplierPurchaseTotals([po('A', 100)], window)
  const openRows = [{ supplierId: 'A', isOpen: true, overdueDays: 3 }, { supplierId: 'A', isOpen: true, overdueDays: 0 }]
  const signals = [{ type: 'po_overdue', supplierId: 'A' }, { type: 'po_due_7d', supplierId: 'A' }, { type: 'invoice_variance', supplierId: 'A' }, { type: 'invoice_variance', supplierId: '' }]
  const suggestions = suggestSupplierTiers({ suppliers, totals, sources: noSources, visibility: { orders: true, amounts: true } })
  const seen = buildSupplierInsights({ suppliers, totals, openRows, signals, suggestions, visibility: { orders: true, amounts: true, onTime: false, issues: true } }).A
  assert.deepEqual([seen.spend12m, seen.openPos, seen.overduePos, seen.onTime, seen.openIssues], [[{ currency: 'USD', amount: 100 }], 2, 1, null, 2])
  const hidden = buildSupplierInsights({ suppliers, totals, openRows, signals, suggestions, visibility: { orders: false, amounts: false, onTime: false, issues: false } }).A
  assert.deepEqual([hidden.spend12m, hidden.orders12m, hidden.openPos, hidden.overduePos, hidden.onTime, hidden.openIssues], [null, null, null, null, null, null])
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
