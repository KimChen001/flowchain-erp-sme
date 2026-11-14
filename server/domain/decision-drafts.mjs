import { purchaseOrderSignalRows } from './today-work.mjs'
import { invoiceExceptionDraft } from './invoice-exception-draft.mjs'

// The prepared next step for each drafted Today row
// (docs/drafted-decisions-design.md §4.3). Every value comes from rules and
// records already on the server; nothing here calls a model or writes.
//
//   reorder_now                  the purchase request the reorder list
//                                prefills (supplier, shortfall raised to the
//                                supplier's minimum), and the open requests
//                                that already ask for the item;
//   purchase_order_overdue       the facts of a follow-up to the supplier:
//                                the order, its lines still to receive and
//                                their promised dates, and the supplier's
//                                contact on record. The page writes the words
//                                in the language the person picks;
//   purchase_request_to_convert  the draft purchase orders the request would
//                                make, one per supplier, currency and
//                                delivery warehouse, and the lines that lack
//                                one of the three;
//   bill_exception               what the three-way match found different on
//                                a held supplier invoice, the likely cause of
//                                each difference and the step for the invoice
//                                (invoice-exception-draft.mjs).

const array = (value) => (Array.isArray(value) ? value : [])
const text = (value) => String(value ?? '').trim()
const quantity = (value) => (value === null || value === undefined || value === '' || !Number.isFinite(Number(value)) ? null : Number(value))

// Purchase request states that still ask for their items.
export const OPEN_REQUEST_STATUSES = Object.freeze(['draft', 'submitted', 'pending_approval', 'approved'])

// The open purchase requests per item id: [{ id, number, status }].
export function openRequestsByItem(purchaseRequests) {
  const byItem = new Map()
  for (const request of array(purchaseRequests)) {
    if (!OPEN_REQUEST_STATUSES.includes(text(request.status).toLowerCase())) continue
    for (const line of array(request.lines)) {
      const itemId = text(line.itemId)
      if (!itemId) continue
      const list = byItem.get(itemId) || []
      if (!list.some((entry) => entry.id === text(request.id))) list.push({ id: text(request.id), number: text(request.number) || text(request.id), status: text(request.status).toLowerCase() })
      byItem.set(itemId, list)
    }
  }
  return byItem
}

function reorderDraft(row, { reorderRows, openRequests }) {
  const entry = reorderRows.get(text(row.recordId))
  if (!entry) return null
  const request = entry.purchaseRequest || {}
  const supplier = entry.supplier ? { id: text(entry.supplier.id), name: text(entry.supplier.name), minimumOrderQuantity: quantity(entry.supplier.minimumOrderQuantity), leadTimeDays: quantity(entry.supplier.leadTimeDays) } : null
  return {
    type: 'purchase_request',
    itemId: text(entry.itemId),
    sku: text(entry.sku),
    itemName: text(entry.itemName) || null,
    unit: text(entry.unit) || null,
    quantity: quantity(request.quantity),
    raisedToMinimum: Boolean(request.raisedToMinimum),
    shortfall: quantity(entry.shortfall),
    position: quantity(entry.position),
    reorderPoint: quantity(entry.reorderPoint),
    orderByDate: entry.orderByDate || null,
    supplier,
    openRequests: openRequests.get(text(entry.itemId)) || [],
  }
}

function followUpDraft(row, { orderRows, suppliersById }) {
  const order = orderRows.get(text(row.recordId))
  if (!order) return null
  const supplier = suppliersById.get(text(order.supplierId)) || null
  return {
    type: 'supplier_follow_up',
    purchaseOrderId: text(order.id),
    orderNumber: text(order.orderNumber) || text(order.id),
    dueDate: order.dueDate || null,
    overdueDays: Number(order.overdueDays) || 0,
    supplier: {
      id: text(order.supplierId) || null,
      name: text(order.supplier) || text(supplier?.name) || null,
      contactName: text(supplier?.contactName) || null,
      // The address on the supplier record; the person confirms it before
      // anything is sent, and nothing is sent from Today yet.
      email: text(supplier?.email) || null,
    },
    lines: array(order.openLines).slice(0, 20).map((line) => ({ sku: line.sku || null, remaining: quantity(line.remaining), unit: line.unit || null, promisedDate: line.promisedDate || null })),
    moreLines: Math.max(0, array(order.openLines).length - 20),
  }
}

function conversionDraft(row, { requestsById, suppliersById }) {
  const request = requestsById.get(text(row.recordId))
  if (!request) return null
  const groups = new Map()
  const missing = []
  array(request.lines).forEach((line, index) => {
    const fields = ['supplierId', 'currency', 'targetWarehouseId'].filter((field) => !text(line[field]))
    if (fields.length) { missing.push({ line: index + 1, sku: text(line.sku) || null, fields }); return }
    const key = [line.supplierId, line.currency, line.targetWarehouseId].join('::')
    const group = groups.get(key) || {
      supplierId: text(line.supplierId),
      supplierName: text(line.supplierSnapshot?.supplierName) || text(suppliersById.get(text(line.supplierId))?.name) || text(line.supplierId),
      currency: text(line.currency),
      warehouseId: text(line.targetWarehouseId),
      lines: 0,
    }
    group.lines += 1
    groups.set(key, group)
  })
  return {
    type: 'purchase_orders_from_request',
    purchaseRequestId: text(request.id),
    number: text(request.number) || text(request.id),
    version: Number(request.version) || 0,
    orders: [...groups.values()],
    missing,
  }
}

function billExceptionDraft(row, { held, suppliersById }) {
  if (!held) return null
  const invoice = array(held.invoices).find((entry) => text(entry.id) === text(row.recordId))
  if (!invoice) return null
  return invoiceExceptionDraft({
    invoice,
    exceptions: array(held.exceptions).filter((entry) => text(entry.supplierInvoiceId) === text(invoice.id)),
    lines: held.lines || {},
    orderPrices: array(held.orderPrices).filter((entry) => text(entry.supplierId) === text(invoice.supplierId)),
    supplier: suppliersById.get(text(invoice.supplierId)) || null,
    amountsVisible: held.amountsVisible !== false,
  })
}

// drafts keyed like the rows (kind:recordId) for the rows given.
// context: the reader's scoped business context; sources: Today's sources.
export function buildDecisionDrafts(rows = [], { context = {}, sources = {}, now = new Date(), timeZone } = {}) {
  const wanted = array(rows)
  const reorderRows = new Map(array(sources.reorder?.rows).map((entry) => [text(entry.itemId), entry]))
  const openRequests = openRequestsByItem(context.purchaseRequests)
  const suppliersById = new Map(array(context.suppliers).map((supplier) => [text(supplier.id), supplier]))
  const requestsById = new Map(array(context.purchaseRequests).map((request) => [text(request.id), request]))
  const needOrders = wanted.some((row) => row.kind === 'purchase_order_overdue')
  const orderRows = needOrders
    ? new Map(purchaseOrderSignalRows(sources.reportPurchaseOrders ?? context.purchaseOrders, now, timeZone).rows.map((entry) => [text(entry.id), entry]))
    : new Map()
  const drafts = {}
  for (const row of wanted) {
    const key = `${row.kind}:${row.recordId}`
    const draft = row.kind === 'reorder_now' ? reorderDraft(row, { reorderRows, openRequests })
      : row.kind === 'purchase_order_overdue' ? followUpDraft(row, { orderRows, suppliersById })
        : row.kind === 'purchase_request_to_convert' ? conversionDraft(row, { requestsById, suppliersById })
          : row.kind === 'bill_exception' ? billExceptionDraft(row, { held: sources.invoiceExceptions, suppliersById })
            : null
    if (draft) drafts[key] = draft
  }
  return drafts
}
