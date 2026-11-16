// The Order lines page (/app/procurement/order-lines) asks the purchase order
// workbench for ?view=lines: each order line with what was received and
// invoiced against it. It reads only these fields, so the answer leaves out
// the rest of each record (line metadata, evidence and notes), which on a
// large workspace was most of a 6.9 MB response. It is built from the masked
// snapshot, so a hidden price stays null with its restrictedFields.

const ORDER_FIELDS = ['po', 'number', 'orderNumber', 'status', 'supplier', 'supplierId', 'currency', 'restrictedFields']
const ORDER_LINE_FIELDS = ['poLineId', 'sku', 'itemName', 'unit', 'quantityOrdered', 'quantityReceived', 'unitPrice', 'currency']
const RECEIPT_FIELDS = ['grn', 'documentNumber', 'po']
const RECEIPT_LINE_FIELDS = ['poLineId']
// invoiceNumber is the record id the read model keys on; supplierInvoiceNumber
// is the supplier's own number (S21-7790), which the page shows.
const INVOICE_FIELDS = ['id', 'invoiceNumber', 'supplierInvoiceNumber', 'relatedPo', 'restrictedFields']
const INVOICE_LINE_FIELDS = ['poLine', 'quantity', 'varianceAmount']

function pick(record, fields) {
  const out = {}
  for (const field of fields) if (record?.[field] !== undefined) out[field] = record[field]
  return out
}

function withLines(record, fields, lineFields) {
  return { ...pick(record, fields), lines: (Array.isArray(record?.lines) ? record.lines : []).map((line) => pick(line, lineFields)) }
}

export function purchaseOrderLinesProjection(snapshot = {}) {
  return {
    purchaseOrders: (snapshot.purchaseOrders || []).map((order) => withLines(order, ORDER_FIELDS, ORDER_LINE_FIELDS)),
    // A receipt line counts only when it names its purchase order line.
    receivingDocs: (snapshot.receivingDocs || []).map((receipt) => {
      const projected = withLines(receipt, RECEIPT_FIELDS, RECEIPT_LINE_FIELDS)
      return { ...projected, lines: projected.lines.filter((line) => line.poLineId) }
    }),
    supplierInvoices: (snapshot.supplierInvoices || []).map((invoice) => withLines(invoice, INVOICE_FIELDS, INVOICE_LINE_FIELDS)),
  }
}

// The PO list (/app/procurement/orders) asks for ?view=list. It shows each
// order's header, searches its lines by SKU, item name and line id, and adds
// up their quantities and prices; it reads only the status and variance
// fields of receipts and supplier invoices. So each order keeps every header
// field, its lines keep only those fields, and receipts and invoices come
// without their lines (on the M5 walkthrough, 7.0 MB down to 1.7 MB).
// The PO detail reads its own order from /api/purchase-orders-workbench/:id.
const LIST_ORDER_LINE_FIELDS = ['poLineId', 'sku', 'itemName', 'unit', 'quantityOrdered', 'quantityReceived', 'unitPrice', 'currency', 'status']

const withoutLines = ({ lines: _lines, ...record }) => record

export function purchaseOrderListProjection(snapshot = {}) {
  return {
    purchaseOrders: (snapshot.purchaseOrders || []).map((order) => ({
      ...order,
      lines: (Array.isArray(order?.lines) ? order.lines : []).map((line) => pick(line, LIST_ORDER_LINE_FIELDS)),
    })),
    receivingDocs: (snapshot.receivingDocs || []).map(withoutLines),
    supplierInvoices: (snapshot.supplierInvoices || []).map(withoutLines),
    documentLinks: snapshot.documentLinks || [],
    procurementFollowups: snapshot.procurementFollowups || [],
  }
}
