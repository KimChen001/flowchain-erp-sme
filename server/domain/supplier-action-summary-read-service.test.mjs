import test from 'node:test'
import assert from 'node:assert/strict'
import { buildSupplierActionSummaries, SUPPLIER_ACTION_PRIORITY_VERSION } from './supplier-action-summary-read-service.mjs'

const allPermissions = new Set([
  'finance.payable.read', 'finance.supplier_invoice.read', 'finance.settlement.read', 'finance.cashbook.read',
  'finance.bank_reconciliation.read', 'finance.amounts.read', 'finance.partner_snapshot.read',
  'procurement.purchase_order.read', 'receiving.read',
])
const actor = { tenantId: 't1', permissionCodes: allPermissions }
const supplier = (id) => ({ tenantId: 't1', id, name: `Supplier ${id.toUpperCase()}` })
const invoice = (id, supplierId, extra = {}) => ({ tenantId: 't1', id, supplierId, invoiceNumber: `INV-${id}`, amount: 100, currency: 'CNY', status: 'approved', ...extra })
const payable = (id, supplierId, invoiceRow, extra = {}) => ({ tenantId: 't1', id, supplierId, supplierInvoiceId: invoiceRow.id, supplierInvoice: invoiceRow, currency: 'CNY', outstandingAmount: 100, dueDate: '2026-07-20T00:00:00.000Z', status: 'approved', ...extra })

test('payment readiness and block reasons use validated backend facts', () => {
  const aInvoice = invoice('a', 'a')
  const bInvoice = invoice('b', 'b', { status: 'disputed', matchStatus: 'exception' })
  const result = buildSupplierActionSummaries({
    actor,
    now: new Date('2026-07-24T00:00:00.000Z'),
    records: { suppliers: [supplier('a'), supplier('b')], invoices: [aInvoice, bInvoice], payables: [payable('pay-a', 'a', aInvoice), payable('pay-b', 'b', bInvoice)], settlements: [], purchaseOrders: [], receiving: [], rfqs: [], bankExceptions: [] },
  })
  const a = result.items.find((row) => row.supplier.id === 'a')
  const b = result.items.find((row) => row.supplier.id === 'b')
  assert.equal(a.payment.readyCount, 1)
  assert.equal(a.payment.blockedCount, 0)
  assert.equal(b.payment.readyCount, 0)
  assert.equal(b.payment.blockedCount, 1)
  assert.deepEqual(b.payment.blocks.map((row) => row.reason), ['invoice_disputed', 'three_way_match_difference'])
})

test('empty and incomplete records do not increase formal counts', () => {
  const result = buildSupplierActionSummaries({
    actor,
    records: { suppliers: [supplier('a')], payables: [{}, { tenantId: 't1', id: 'pay-gap', supplierId: 'a', currency: 'CNY', outstandingAmount: 1, status: 'approved' }], invoices: [], settlements: [], purchaseOrders: [{ tenantId: 't1', id: 'PO-0001', supplierId: 'a', status: 'open' }], receiving: [], rfqs: [], bankExceptions: [] },
  })
  assert.equal(result.items[0].payment.dueCount, 0)
  assert.equal(result.items[0].payment.state, 'incomplete')
  assert.equal(result.items[0].procurement.openPoCount, 0)
  assert.equal(result.recordValiditySummary.invalidCount, 2)
  assert.equal(result.recordValiditySummary.incompleteCount, 1)
})

test('missing permissions produce hidden sections and redactions instead of zero', () => {
  const limitedActor = { tenantId: 't1', permissionCodes: new Set(['procurement.purchase_order.read']) }
  const result = buildSupplierActionSummaries({ actor: limitedActor, records: { suppliers: [supplier('a')], payables: [payable('pay-a', 'a', invoice('a', 'a'))], invoices: [], settlements: [], purchaseOrders: [], receiving: [], rfqs: [], bankExceptions: [] } })
  assert.equal(result.items[0].payment.state, 'hidden')
  assert.equal(result.items[0].payment.dueCount, null)
  assert.equal(result.items[0].supplier.name, null)
  assert.equal(result.items[0].payment.dueAmount, null)
})

test('unavailable sources return null facts instead of fabricated zeroes', () => {
  const result = buildSupplierActionSummaries({
    actor,
    sourceAvailability: { payables: false, invoices: false, purchaseOrders: false, receiving: false, bankReconciliation: false },
    records: { suppliers: [supplier('a')], payables: [], invoices: [], settlements: [], purchaseOrders: [], receiving: [], rfqs: [], bankExceptions: [] },
  })
  const item = result.items[0]
  assert.equal(item.payment.state, 'unavailable')
  assert.equal(item.payment.dueCount, null)
  assert.equal(item.payment.dueAmount, null)
  assert.equal(item.invoice.openCount, null)
  assert.equal(item.procurement.openPoCount, null)
  assert.equal(item.receiving.exceptionCount, null)
  assert.equal(item.reconciliation.blockingExceptionCount, null)
})

test('priority ranking is deterministic and independent of input order', () => {
  const po = (id, supplierId) => ({ tenantId: 't1', id, supplierId, status: 'open', expectedDate: '2026-07-01T00:00:00.000Z', lines: [] })
  const input = { actor, now: new Date('2026-07-24T00:00:00.000Z'), records: { suppliers: [supplier('a'), supplier('b')], payables: [], invoices: [], settlements: [], purchaseOrders: [po('PO-B', 'b')], receiving: [], rfqs: [], bankExceptions: [] } }
  const first = buildSupplierActionSummaries(input)
  const second = buildSupplierActionSummaries({ ...input, records: { ...input.records, suppliers: [...input.records.suppliers].reverse(), purchaseOrders: [...input.records.purchaseOrders].reverse() } })
  assert.deepEqual(first.items.map((row) => row.supplier.id), ['b', 'a'])
  assert.deepEqual(first.items.map((row) => [row.supplier.id, row.priority.score]), second.items.map((row) => [row.supplier.id, row.priority.score]))
  assert.equal(first.items[0].priority.algorithmVersion, SUPPLIER_ACTION_PRIORITY_VERSION)
})
