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
const INVOICE_FIELDS = ['id', 'invoiceNumber', 'relatedPo', 'restrictedFields']
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
