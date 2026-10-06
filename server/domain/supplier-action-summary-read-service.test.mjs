import test from 'node:test'
import assert from 'node:assert/strict'
import { buildSupplierActionSummaries } from './supplier-action-summary-read-service.mjs'

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

test('suppliers are ordered by their oldest open reason, dated, without a score', () => {
  const line = (ordered, received, promisedDate) => ({ orderedQuantity: ordered, receivedQuantity: received, metadata: { promisedDate } })
  const po = (id, supplierId, promisedDate) => ({ tenantId: 't1', id, supplierId, status: 'issued', expectedDate: new Date(`${promisedDate}T12:00:00.000Z`), currency: 'USD', lines: [line(10, 0, promisedDate)] })
  const aInvoice = invoice('a', 'a')
  const input = {
    actor,
    now: new Date('2026-07-24T12:00:00.000Z'),
    records: {
      suppliers: [supplier('a'), supplier('b'), supplier('c'), supplier('d')],
      // a: a payable overdue since Jul 20. b: an order promised Jul 1. c and d: nothing open.
      invoices: [aInvoice], payables: [payable('pay-a', 'a', aInvoice)], settlements: [], purchaseOrders: [po('PO-B', 'b', '2026-07-01')], receiving: [], rfqs: [], bankExceptions: [],
    },
  }
  const first = buildSupplierActionSummaries(input)
  const second = buildSupplierActionSummaries({ ...input, records: { ...input.records, suppliers: [...input.records.suppliers].reverse() } })
  assert.deepEqual(first.items.map((row) => [row.supplier.id, row.priority.since]), [['b', '2026-07-01'], ['a', '2026-07-20'], ['c', null], ['d', null]])
  assert.deepEqual(second.items.map((row) => row.supplier.id), first.items.map((row) => row.supplier.id))
  assert.deepEqual(first.items[0].priority, { since: '2026-07-01', reasons: [{ code: 'purchase_order_overdue', since: '2026-07-01', count: 1 }] })
  assert.deepEqual(first.items[1].priority.reasons, [{ code: 'payment_overdue', since: '2026-07-20', count: 1 }])
  for (const row of first.items) assert.deepEqual(Object.keys(row.priority).sort(), ['reasons', 'since'])
})

test('rejected quantities are kept per SKU and unit, never added together', () => {
  const receipt = (id, lines, extra = {}) => ({ tenantId: 't1', id, supplierId: 'a', poId: 'PO-A', documentNumber: id, status: 'posted', arrivedAt: '2026-07-15T09:00:00.000Z', createdAt: '2026-07-15T10:00:00.000Z', lines, ...extra })
  const result = buildSupplierActionSummaries({
    actor,
    now: new Date('2026-07-24T12:00:00.000Z'),
    records: { suppliers: [supplier('a')], invoices: [], payables: [], settlements: [], purchaseOrders: [], rfqs: [], bankExceptions: [], receiving: [
      receipt('GRN-1', [{ sku: 'BOLT', unit: 'pcs', rejectedQty: 2 }, { sku: 'CABLE', unit: 'm', rejectedQty: 3 }]),
      receipt('GRN-2', [{ sku: 'BOLT', unit: 'pcs', rejectedQty: 1 }, { sku: 'BOLT', unit: 'box', rejectedQty: 1 }], { arrivedAt: null, createdAt: '2026-07-12T10:00:00.000Z' }),
    ] },
  })
  const item = result.items[0]
  assert.equal(item.receiving.exceptionCount, 2)
  assert.equal('rejectedQuantity' in item.receiving, false)
  assert.deepEqual(item.receiving.rejectedQuantities, [
    { sku: 'BOLT', unit: 'box', quantity: 1 },
    { sku: 'BOLT', unit: 'pcs', quantity: 3 },
    { sku: 'CABLE', unit: 'm', quantity: 3 },
  ])
  // Without an arrival time the receipt is dated by the day it was entered.
  assert.deepEqual(item.priority.reasons, [{ code: 'receiving_exception', since: '2026-07-12', count: 2 }])
})

test('date-only fields keep their own day in a US workspace timezone', () => {
  // An invoice dated Jul 1 and a payable due Jul 10 are stored at 00:00 UTC.
  // Read in New York time they would move to Jun 30 and Jul 9.
  const aInvoice = invoice('a', 'a', { matchStatus: 'exception', invoiceDate: new Date('2026-07-01T00:00:00.000Z') })
  const line = { orderedQuantity: 10, receivedQuantity: 0, metadata: { promisedDate: '2026-06-30' } }
  const result = buildSupplierActionSummaries({
    actor,
    now: new Date('2026-07-24T16:00:00.000Z'),
    timeZone: 'America/New_York',
    records: {
      suppliers: [supplier('a'), supplier('b')],
      invoices: [aInvoice], payables: [payable('pay-a', 'a', aInvoice, { dueDate: new Date('2026-07-10T00:00:00.000Z') })], settlements: [], receiving: [], rfqs: [], bankExceptions: [],
      purchaseOrders: [{ tenantId: 't1', id: 'PO-B', supplierId: 'b', status: 'issued', currency: 'CNY', expectedDate: new Date('2026-06-30T12:00:00.000Z'), lines: [line] }],
    },
  })
  const a = result.items.find((row) => row.supplier.id === 'a')
  assert.deepEqual(a.priority.reasons.map((row) => [row.code, row.since]), [['invoice_exception', '2026-07-01'], ['payment_blocked', '2026-07-01'], ['payment_overdue', '2026-07-10']])
  // B's order was promised Jun 30, before A's invoice: B comes first.
  assert.deepEqual(result.items.map((row) => [row.supplier.id, row.priority.since]), [['b', '2026-06-30'], ['a', '2026-07-01']])
})

test('a blocked payment is dated by when the block began, never by a due date still ahead', () => {
  const now = new Date('2026-10-06T12:00:00.000Z')
  const held = invoice('h', 'a')
  const disputed = invoice('d', 'b', { status: 'disputed', disputedAt: new Date('2026-09-20T15:00:00.000Z'), invoiceDate: new Date('2026-09-01T00:00:00.000Z') })
  const result = buildSupplierActionSummaries({
    actor, now,
    records: {
      suppliers: [supplier('a'), supplier('b'), supplier('c')], settlements: [], purchaseOrders: [], receiving: [], rfqs: [], bankExceptions: [],
      invoices: [held, disputed, invoice('n', 'c')],
      payables: [
        payable('pay-held', 'a', held, { status: 'held', heldAt: new Date('2026-09-28T14:00:00.000Z'), dueDate: new Date('2026-11-15T00:00:00.000Z') }),
        payable('pay-disputed', 'b', disputed, { dueDate: new Date('2026-11-01T00:00:00.000Z') }),
        // Held with no hold time or entry date recorded: the block has no date.
        { ...payable('pay-undated', 'c', invoice('n', 'c'), { status: 'held', dueDate: new Date('2026-12-01T00:00:00.000Z') }) },
      ],
    },
  })
  const since = (id) => result.items.find((row) => row.supplier.id === id).priority.reasons.find((row) => row.code === 'payment_blocked').since
  assert.equal(since('a'), '2026-09-28')
  assert.equal(since('b'), '2026-09-20')
  assert.equal(since('c'), null)
  for (const row of result.items) assert.ok(!row.priority.since || row.priority.since <= '2026-10-06', `${row.supplier.id} since ${row.priority.since}`)
})

test('rejected lines without a SKU or unit are listed one by one, never added together', () => {
  const result = buildSupplierActionSummaries({
    actor,
    now: new Date('2026-07-24T12:00:00.000Z'),
    records: { suppliers: [supplier('a')], invoices: [], payables: [], settlements: [], purchaseOrders: [], rfqs: [], bankExceptions: [], receiving: [
      { tenantId: 't1', id: 'GRN-1', supplierId: 'a', poId: 'PO-A', documentNumber: 'GRN-1', status: 'posted', arrivedAt: '2026-07-15T09:00:00.000Z', lines: [{ id: 'l1', sku: null, unit: null, rejectedQty: 2 }, { id: 'l2', rejectedQty: 3 }, { id: 'l3', sku: 'BOLT', unit: 'pcs', rejectedQty: 1 }] },
    ] },
  })
  assert.deepEqual(result.items[0].receiving.rejectedQuantities, [
    { sku: null, unit: null, quantity: 2 },
    { sku: null, unit: null, quantity: 3 },
    { sku: 'BOLT', unit: 'pcs', quantity: 1 },
  ])
})

test('mixed currencies never produce a combined payable amount', () => {
  const cny = invoice('cny', 'a')
  const usd = invoice('usd', 'a', { currency: 'USD' })
  const result = buildSupplierActionSummaries({ actor, records: { suppliers: [supplier('a')], invoices: [cny, usd], payables: [payable('cny', 'a', cny), payable('usd', 'a', usd, { currency: 'USD' })] } })
  assert.equal(result.items[0].payment.dueCount, 2)
  assert.equal(result.items[0].payment.dueAmount, null)
  assert.equal(result.items[0].payment.overdueAmount, null)
})


test('currency and blocked-payment filters apply before computing facts', () => {
  const cny = invoice('cny', 'a')
  const usd = invoice('usd', 'a', { currency: 'USD', status: 'disputed' })
  const records = { suppliers: [supplier('a')], invoices: [cny, usd], payables: [payable('cny', 'a', cny), payable('usd', 'a', usd, { currency: 'USD', outstandingAmount: 25 })] }
  const filtered = buildSupplierActionSummaries({ actor, records, filters: { currencies: ['USD'], dueState: ['blocked'] } }).items[0]
  assert.equal(filtered.payment.dueCount, 1)
  assert.equal(filtered.payment.dueAmount, 25)
  assert.deepEqual(filtered.payment.blocks.map(block => block.payableId), ['usd'])
  assert.ok(!filtered.evidence.some(item => item.id === 'cny'))
})


test('only committed purchase orders with quantity to receive count as open and overdue', () => {
  const line = (ordered, received, promisedDate) => ({ orderedQuantity: ordered, receivedQuantity: received, metadata: { promisedDate } })
  const po = (id, status, lines) => ({ tenantId: 't1', id, supplierId: 'a', status, expectedDate: new Date('2026-07-10T12:00:00.000Z'), currency: 'USD', lines })
  const result = buildSupplierActionSummaries({
    actor,
    now: new Date('2026-07-24T12:00:00.000Z'),
    records: { suppliers: [supplier('a')], invoices: [], payables: [], settlements: [], receiving: [], rfqs: [], bankExceptions: [], purchaseOrders: [
      po('PO-DRAFT', 'draft', [line(10, 0, '2026-07-10')]),
      po('PO-REJECTED', 'rejected', [line(10, 0, '2026-07-10')]),
      po('PO-RECEIVED', 'fully_received', [line(10, 10, '2026-07-10')]),
      po('PO-ISSUED-DONE', 'issued', [line(10, 10, '2026-07-10')]),
      po('PO-ISSUED', 'issued', [line(10, 4, '2026-07-10')]),
      // Due by its header date, but its open line is promised later: not overdue, as in the report.
      po('PO-LINE-LATER', 'approved', [line(5, 0, '2026-08-01')]),
    ] },
  })
  const procurement = result.items[0].procurement
  assert.equal(procurement.openPoCount, 2)
  assert.equal(procurement.overduePoCount, 1)
  assert.deepEqual(procurement.overduePoIds, ['PO-ISSUED'])
})
