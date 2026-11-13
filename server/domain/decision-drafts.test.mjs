import test from 'node:test'
import assert from 'node:assert/strict'
import { buildDecisionDrafts, openRequestsByItem } from './decision-drafts.mjs'

const now = new Date('2026-11-12T15:00:00Z')
const timeZone = 'America/New_York'

test('a reorder draft is the reorder list prefill, with the open requests for the item', () => {
  const sources = { reorder: { rows: [{
    itemId: 'ITEM-1', sku: 'SKU-1', itemName: 'Box', unit: 'pcs', shortfall: 180, position: 20, reorderPoint: 200, orderByDate: '2026-11-12',
    supplier: { id: 'SUP-1', name: 'Acme', minimumOrderQuantity: 240, leadTimeDays: 14 },
    purchaseRequest: { itemId: 'ITEM-1', supplierId: 'SUP-1', quantity: 240, raisedToMinimum: true },
  }] } }
  const context = { purchaseRequests: [
    { id: 'PR-1', number: 'PR-202611-0001', status: 'draft', lines: [{ itemId: 'ITEM-1' }] },
    { id: 'PR-2', number: 'PR-202611-0002', status: 'cancelled', lines: [{ itemId: 'ITEM-1' }] },
  ] }
  const drafts = buildDecisionDrafts([{ kind: 'reorder_now', recordId: 'ITEM-1' }], { context, sources, now, timeZone })
  assert.deepEqual(drafts['reorder_now:ITEM-1'], {
    type: 'purchase_request', itemId: 'ITEM-1', sku: 'SKU-1', itemName: 'Box', unit: 'pcs', quantity: 240, raisedToMinimum: true,
    shortfall: 180, position: 20, reorderPoint: 200, orderByDate: '2026-11-12',
    supplier: { id: 'SUP-1', name: 'Acme', minimumOrderQuantity: 240, leadTimeDays: 14 },
    openRequests: [{ id: 'PR-1', number: 'PR-202611-0001', status: 'draft' }],
  })
})

test('a follow-up draft carries the order, its lines still to receive and the supplier contact on record', () => {
  const context = {
    suppliers: [{ id: 'SUP-1', name: 'Acme', contactName: 'Pat Lee', email: 'orders@acme.example' }],
    purchaseOrders: [{
      id: 'PO-1', orderNumber: 'PO-202610-0007', supplierId: 'SUP-1', supplierName: 'Acme', status: 'issued', currency: 'USD', dueDate: '2026-11-02',
      lines: [{ id: 'L1', sku: 'SKU-1', itemName: 'Box', quantity: 100, orderedQuantity: 100, receivedQuantity: 40, unit: 'pcs', promisedDate: '2026-11-02' }],
    }],
  }
  const drafts = buildDecisionDrafts([{ kind: 'purchase_order_overdue', recordId: 'PO-1' }], { context, sources: {}, now, timeZone })
  const draft = drafts['purchase_order_overdue:PO-1']
  assert.equal(draft.type, 'supplier_follow_up')
  assert.equal(draft.orderNumber, 'PO-202610-0007')
  assert.deepEqual(draft.supplier, { id: 'SUP-1', name: 'Acme', contactName: 'Pat Lee', email: 'orders@acme.example' })
  assert.equal(draft.overdueDays > 0, true)
  assert.deepEqual(draft.lines.map((line) => [line.sku, line.remaining, line.unit]), [['SKU-1', 60, 'pcs']])
})

test('a conversion draft groups lines by supplier, currency and warehouse, and names lines that lack one', () => {
  const context = {
    suppliers: [{ id: 'SUP-2', name: 'Summit' }],
    purchaseRequests: [{ id: 'PR-7', number: 'PR-202611-0007', status: 'approved', version: 3, lines: [
      { sku: 'A', supplierId: 'SUP-1', supplierSnapshot: { supplierName: 'Acme' }, currency: 'USD', targetWarehouseId: 'WH-1' },
      { sku: 'B', supplierId: 'SUP-1', supplierSnapshot: { supplierName: 'Acme' }, currency: 'USD', targetWarehouseId: 'WH-1' },
      { sku: 'C', supplierId: 'SUP-2', currency: 'USD', targetWarehouseId: 'WH-1' },
      { sku: 'D', supplierId: '', currency: 'USD', targetWarehouseId: '' },
    ] }],
  }
  const draft = buildDecisionDrafts([{ kind: 'purchase_request_to_convert', recordId: 'PR-7' }], { context, now, timeZone })['purchase_request_to_convert:PR-7']
  assert.equal(draft.version, 3)
  assert.deepEqual(draft.orders.map((order) => [order.supplierName, order.lines]), [['Acme', 2], ['Summit', 1]])
  assert.deepEqual(draft.missing, [{ line: 4, sku: 'D', fields: ['supplierId', 'targetWarehouseId'] }])
})

test('only the drafted kinds get drafts, and only open requests count', () => {
  assert.deepEqual(buildDecisionDrafts([{ kind: 'sales_order_to_ship', recordId: 'SO-1' }], { now, timeZone }), {})
  const open = openRequestsByItem([
    { id: 'PR-1', status: 'Approved', lines: [{ itemId: 'I-1' }, { itemId: 'I-1' }] },
    { id: 'PR-2', status: 'converted', lines: [{ itemId: 'I-2' }] },
  ])
  assert.deepEqual([...open.keys()], ['I-1'])
  assert.equal(open.get('I-1').length, 1)
})

test('a held supplier invoice gets its differences, their causes and the supplier contact from Today\'s source', () => {
  const sources = {
    invoiceExceptions: {
      amountsVisible: true,
      invoices: [{ id: 'INV-1', invoiceNumber: 'BILL-7', supplierId: 'SUP-1', supplierName: 'Acme Home Goods', orderId: 'PO-A', orderNumber: 'PO-202610-0022', currency: 'GBP' }],
      exceptions: [
        { id: 'EX-1', matchLineId: 'L1', supplierInvoiceId: 'INV-1', exceptionType: 'price', status: 'open', expectedValue: '1.27', actualValue: '1.32' },
        // Another invoice's difference is not this card's.
        { id: 'EX-9', matchLineId: 'L9', supplierInvoiceId: 'INV-9', exceptionType: 'quantity', status: 'open' },
      ],
      lines: { L1: { sku: '85123A', unit: 'pcs', orderedQuantity: '240', receivedQuantity: '240', previouslyInvoicedQuantity: '0', invoiceQuantity: '240', poUnitPrice: '1.27', invoiceUnitPrice: '1.32' } },
      orderPrices: [{ sku: '85123A', unitPrice: '1.32', orderId: 'PO-B', orderNumber: 'PO-202611-0003', supplierId: 'SUP-1' }, { sku: '85123A', unitPrice: '1.32', orderId: 'PO-X', orderNumber: 'PO-OTHER', supplierId: 'SUP-2' }],
    },
  }
  const context = { suppliers: [{ id: 'SUP-1', name: 'Acme Home Goods', contactName: 'Order desk', email: 'orders@acme.example' }] }
  const drafts = buildDecisionDrafts([{ kind: 'bill_exception', recordId: 'INV-1' }, { kind: 'bill_exception', recordId: 'INV-404' }], { context, sources, now, timeZone })
  const draft = drafts['bill_exception:INV-1']
  assert.equal(draft.type, 'invoice_exception')
  assert.equal(draft.step, 'review_price')
  assert.deepEqual(draft.differences.map((row) => [row.exceptionId, row.cause, row.evidenceOrder]), [['EX-1', 'price_changed', 'PO-202611-0003']])
  assert.equal(draft.supplier.email, 'orders@acme.example')
  // An invoice the source did not read has no draft; its card shows without one.
  assert.equal(drafts['bill_exception:INV-404'], undefined)
})
