import test from 'node:test'
import assert from 'node:assert/strict'
import { COVERING_REQUEST_STATUSES, buildDecisionDrafts, followUpSupplierLinkKeys, openRequestsByItem } from './decision-drafts.mjs'

const now = new Date('2026-11-12T15:00:00Z')
const timeZone = 'America/New_York'

test('a reorder draft is the reorder list prefill, with the open requests for the item', () => {
  const sources = { reorder: { rows: [{
    itemId: 'ITEM-1', sku: 'SKU-1', itemName: 'Box', unit: 'pcs', shortfall: 180, position: 20, reorderPoint: 200, orderUpTo: { level: 240, source: 'assumed', reviewDays: 7 }, orderByDate: '2026-11-12',
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
    shortfall: 180, position: 20, reorderPoint: 200, orderUpTo: { level: 240, source: 'assumed' }, orderByDate: '2026-11-12',
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

// Design audit L11-01: an order approved but never sent to the supplier was
// drafted a follow-up ("now N days overdue") that could be emailed. The
// supplier does not have the order, so the step is to send it.
test('an overdue order approved but never sent gets "send the order", never a follow-up to the supplier', () => {
  const context = {
    suppliers: [{ id: 'SUP-1', name: 'Acme', contactName: 'Pat Lee', email: 'orders@acme.example' }],
    purchaseOrders: [{
      id: 'PO-9', orderNumber: 'PO-202610-0009', supplierId: 'SUP-1', supplierName: 'Acme', status: 'approved', currency: 'USD', expectedDate: '2026-11-02',
      lines: [{ id: 'L1', sku: 'SKU-1', itemId: 'ITEM-1', itemName: 'Box', orderedQuantity: 100, receivedQuantity: 0, unit: 'pcs', promisedDate: '2026-11-02' }],
    }],
  }
  const draft = buildDecisionDrafts([{ kind: 'purchase_order_overdue', recordId: 'PO-9' }], { context, sources: {}, now, timeZone })['purchase_order_overdue:PO-9']
  assert.deepEqual(draft, {
    type: 'send_purchase_order', purchaseOrderId: 'PO-9', orderNumber: 'PO-202610-0009', dueDate: '2026-11-02', overdueDays: 10,
    supplier: { id: 'SUP-1', name: 'Acme' },
  })
  // No message, contact or lines to chase with.
  assert.equal('lines' in draft, false)
  // Once it is issued, the same order is followed up.
  context.purchaseOrders[0].status = 'issued'
  assert.equal(buildDecisionDrafts([{ kind: 'purchase_order_overdue', recordId: 'PO-9' }], { context, sources: {}, now, timeZone })['purchase_order_overdue:PO-9'].type, 'supplier_follow_up')
})

// Design audit L11-22: the follow-up listed every line still to receive,
// including lines not due yet, by SKU alone.
test('a follow-up lists only the lines past their promised date, with the item name and the supplier part number', () => {
  const line = (id, itemId, sku, promisedDate) => ({ id, sku, itemId, itemName: `Item ${sku}`, orderedQuantity: 10, receivedQuantity: 0, unit: 'pcs', promisedDate })
  const context = {
    suppliers: [{ id: 'SUP-1', name: 'Acme' }],
    purchaseOrders: [{
      id: 'PO-3', orderNumber: 'PO-202610-0003', supplierId: 'SUP-1', supplierName: 'Acme', status: 'issued', currency: 'USD',
      lines: [line('L1', 'ITEM-1', 'SKU-1', '2026-11-02'), line('L2', 'ITEM-2', 'SKU-2', '2026-11-12'), line('L3', 'ITEM-3', 'SKU-3', '2026-11-20'), line('L4', 'ITEM-4', 'SKU-4', '2026-11-11')],
    }],
  }
  const rows = [{ kind: 'purchase_order_overdue', recordId: 'PO-3' }]
  assert.deepEqual(followUpSupplierLinkKeys(rows, { context }), ['ITEM-1::SUP-1', 'ITEM-2::SUP-1', 'ITEM-3::SUP-1', 'ITEM-4::SUP-1'])
  const supplierSkus = new Map([['ITEM-1::SUP-1', 'AC-100'], ['ITEM-1::SUP-9', 'OTHER']])
  const draft = buildDecisionDrafts(rows, { context, sources: {}, now, timeZone, supplierSkus })['purchase_order_overdue:PO-3']
  assert.equal(draft.type, 'supplier_follow_up')
  assert.equal(draft.dueDate, '2026-11-02')
  // Due today (Nov 12 in New York) and later are not late.
  assert.deepEqual(draft.lines.map((entry) => [entry.sku, entry.itemName, entry.supplierSku, entry.promisedDate]), [
    ['SKU-1', 'Item SKU-1', 'AC-100', '2026-11-02'],
    ['SKU-4', 'Item SKU-4', null, '2026-11-11'],
  ])
  assert.equal(draft.moreLines, 0)
  // Only overdue orders need the links.
  assert.deepEqual(followUpSupplierLinkKeys([{ kind: 'reorder_now', recordId: 'PO-3' }], { context }), [])
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

// Design audit L11-02: a draft request set a reorder item aside as covered.
test('only a request past draft can cover a reorder item', () => {
  const requests = [
    { id: 'PR-1', status: 'draft', lines: [{ itemId: 'I-1' }] },
    { id: 'PR-2', status: 'submitted', lines: [{ itemId: 'I-2' }] },
    { id: 'PR-3', status: 'approved', lines: [{ itemId: 'I-3' }] },
  ]
  assert.deepEqual([...openRequestsByItem(requests).keys()], ['I-1', 'I-2', 'I-3'])
  assert.deepEqual([...openRequestsByItem(requests, { statuses: COVERING_REQUEST_STATUSES }).keys()], ['I-2', 'I-3'])
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
