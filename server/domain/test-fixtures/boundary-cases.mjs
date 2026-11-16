// Boundary data for tests (design audit 2026-11-15, findings-13 strategy 2).
// The tests the audit read used clean data only: SKUs of letters and digits,
// one unit everywhere, orders that had been issued, invoices that matched and
// one invoice per receipt. Five P0 findings lived in the cases below. Each is
// written in the shape the pure read models on main take, and each export is
// a function, so a test gets its own copy to change.
//
// Used by boundary-cases.test.mjs. Add a case here when a finding shows data
// the tests never had, and say which finding it comes from.

// L5-01: SKUs with regex characters. A pattern built from one without
// escaping throws or matches the wrong text.
export const REGEX_SKUS = Object.freeze(['A.B12', 'X+Y1', 'P(1)'])

// L1-02 = L3-01: an item kept in pieces and a purchase order line in cases.
// No conversion between units is recorded (item-stock-unit.mjs), so the line
// must be refused, never booked as 10 pieces.
export function caseOrderedLine() {
  return {
    item: { id: 'BND-ITEM-GLOVE', sku: 'BND-GLOVE', name: 'Nitrile gloves', unit: 'pcs', recordedUnit: 'pcs', purchaseUnit: 'CASE' },
    purchaseOrderLine: { id: 'BND-POL-GLOVE', itemId: 'BND-ITEM-GLOVE', sku: 'BND-GLOVE', unit: 'CASE', orderedQuantity: '10.0000', receivedQuantity: '0' },
  }
}

// L11-01 and L9-01: a purchase order as the procurement read model gives it
// (today-work.mjs, decision-drafts.mjs, supplier-insights.mjs). By default it
// is issued, 40 of 100 received, promised on 2026-11-02.
export function purchaseOrder({ id = 'BND-PO-ISSUED', orderNumber = 'PO-202610-0101', status = 'issued', sku = 'BND-BOX', promisedDate = '2026-11-02', receivedQuantity = '40.0000' } = {}) {
  return {
    id,
    orderNumber,
    status,
    supplierId: 'BND-SUP-1',
    supplierName: 'Boundary Supply Co',
    supplierSnapshot: { id: 'BND-SUP-1', supplierName: 'Boundary Supply Co' },
    currency: 'USD',
    totalAmount: '1000.0000',
    expectedDate: promisedDate,
    createdAt: '2026-10-20T14:00:00.000Z',
    updatedAt: '2026-10-21T14:00:00.000Z',
    lines: [{ id: `${id}-L1`, sku, itemId: `ITEM-${sku}`, itemName: 'Shipping box', orderedQuantity: '100.0000', receivedQuantity, unit: 'pcs', promisedDate }],
  }
}

// L11-01: approved and never sent to the supplier. It is open and can be
// late, but the supplier does not have it: the step is to issue it.
export function approvedNotIssuedOrder(overrides = {}) {
  return purchaseOrder({ id: 'BND-PO-APPROVED', orderNumber: 'PO-202610-0102', status: 'approved', receivedQuantity: '0', ...overrides })
}

// The supplier of both orders, with an email on record.
export function orderSupplier() {
  return { id: 'BND-SUP-1', name: 'Boundary Supply Co', contactName: 'Pat Lee', email: 'orders@boundary-supply.example' }
}

// L9-01 and L11-07: a supplier invoice whose price variance was approved. The
// difference is settled, so it is no open variance, and the bill waits for
// its own approval (matchStatus variance_approved, status still exception).
export function varianceApprovedInvoice() {
  return {
    id: 'BND-INV-VA', invoiceNumber: 'BND-INV-VA', supplierId: 'BND-SUP-1', supplierName: 'Boundary Supply Co',
    status: 'exception', matchStatus: 'variance_approved', varianceAmount: '200.0000',
    poId: 'BND-PO-ISSUED', receiptId: 'BND-GRN-1', totalAmount: '1200.0000', currency: 'USD',
    invoiceDate: '2026-11-03T00:00:00.000Z', updatedAt: '2026-11-04T15:00:00.000Z',
  }
}

// L8-01: one receipt line of 10 billed on two invoices, 6 on A and 4 on B, in
// the supplierInvoice shape the credit memo plan reads
// (operational-finance-policy.mjs buildSupplierCreditMemoPlan). A return from
// that receipt line may be credited once across both invoices.
export function receiptLineOnTwoInvoices() {
  const line = (invoiceId, quantity) => ({ id: `${invoiceId}-1`, receivingLineId: 'BND-GRNL-1', itemId: 'ITEM-BND-BOX', sku: 'BND-BOX', quantity, unitPrice: '10.0000', enteredTaxAmount: '0.0000' })
  const invoice = (id, quantity) => ({ id, status: 'approved', currency: 'USD', supplierId: 'BND-SUP-1', supplierName: 'Boundary Supply Co', lines: [line(id, quantity)] })
  return {
    receivingLine: { id: 'BND-GRNL-1', itemId: 'ITEM-BND-BOX', sku: 'BND-BOX', receivedQuantity: '10.0000', unit: 'pcs' },
    invoices: [invoice('BND-BILL-A', '6.0000'), invoice('BND-BILL-B', '4.0000')],
  }
}
