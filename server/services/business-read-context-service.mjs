import { DEFAULT_TENANT_TIMEZONE } from '../domain/tenant-calendar-day.mjs'
import { orderHasOpenDemand } from '../repositories/db-sales-order-read-repository.mjs'
import { buildFirstRunChecklist, buildTodayWork, countDocumentsUpdatedToday } from '../domain/today-work.mjs'
import { billPaymentStatus } from '../domain/operational-finance-read-service.mjs'
import { customerInvoicePaymentStatus } from '../domain/operational-finance-o2c-read-service.mjs'

const clone = value => structuredClone(value)
const array = value => Array.isArray(value) ? value : []

async function call(repository, method, fallback = [], ...args) {
  if (!repository || typeof repository[method] !== 'function') return clone(fallback)
  return await repository[method](...args)
}

export function createBusinessReadContextService({ repositories = {}, dataMode = 'user' } = {}) {
  return {
    async read(options = {}) {
      const masterData = repositories.masterData
      // Repositories read a bounded number of rows and report each subject
      // that had more, so reports can say their totals may be incomplete.
      const truncated = new Map()
      const onTruncated = ({ subject, limit }) => { if (subject) truncated.set(subject, { subject, limit }) }
      const scope = { tenantId: options.tenantId, onTruncated }
      // Inventory follows the reader's warehouse scope when one is given.
      const warehouseScoped = Array.isArray(options.warehouseIds)
      const inventoryScope = warehouseScoped ? { ...scope, warehouseIds: options.warehouseIds } : scope
      const itemMethod = typeof masterData?.listManagedItems === 'function' ? 'listManagedItems' : 'listItems'
      const [items, suppliers, customers, itemSupplierRelationships, inventoryItems, salesOrders, procurement] = await Promise.all([
        call(masterData, itemMethod, [], scope),
        call(masterData, 'listSuppliers', [], scope),
        call(masterData, 'listCustomers', [], scope),
        call(masterData, 'listAllItemSupplierRelationships', [], scope),
        call(repositories.inventoryRuntime, 'listItems', [], inventoryScope),
        call(repositories.salesOrders, 'listOrders', [], scope),
        call(repositories.procurementRuntime, 'snapshot', {}, scope),
      ])
      // The recorded stock unit of every item a purchase order line names, read
      // apart from the bounded item list, so incoming never adds a line in
      // another unit because the item fell outside that list.
      const lineKeys = [...new Set(array(procurement.purchaseOrders).flatMap(po => array(po.lines).flatMap(line => [line.sku, line.itemId])).map(key => String(key ?? '').trim()).filter(Boolean))]
      const itemUnits = lineKeys.length ? await call(masterData, 'listRecordedItemUnits', [], { ...scope, keys: lineKeys }) : []
      // Only the most recent sales orders are read. When every order that can
      // still need stock is among them, the orders left out are history: the
      // truncation stays reported, marked so stock views need not warn.
      const salesTruncation = truncated.get('sales_orders')
      if (salesTruncation && typeof repositories.salesOrders?.countOrdersWithOpenDemand === 'function') {
        const openTotal = Number(await repositories.salesOrders.countOrdersWithOpenDemand(scope))
        const openRead = array(salesOrders).filter(orderHasOpenDemand).length
        if (Number.isFinite(openTotal) && openTotal <= openRead) salesTruncation.openDemandComplete = true
      }
      const dataLimitations = []
      if (!repositories.procurementRuntime) dataLimitations.push('procurement_runtime_unavailable')
      if (!repositories.inventoryRuntime) dataLimitations.push('inventory_runtime_unavailable')
      if (!repositories.salesOrders) dataLimitations.push('sales_runtime_unavailable')
      dataLimitations.push('warehouse_runtime_not_connected', 'bin_runtime_not_connected')
      if (warehouseScoped) dataLimitations.push('inventory_scoped_to_reader_warehouses')
      if (array(procurement.receipts).length === 0) dataLimitations.push('receipt_runtime_has_no_records')
      if (array(procurement.supplierInvoices).length === 0) dataLimitations.push('invoice_runtime_has_no_records')

      return {
        dataMode,
        items: array(items),
        suppliers: array(suppliers),
        customers: array(customers),
        warehouses: [],
        bins: [],
        inventoryItems: array(inventoryItems),
        salesOrders: array(salesOrders),
        purchaseRequests: array(procurement.purchaseRequests),
        rfqs: array(procurement.rfqs),
        purchaseOrders: array(procurement.purchaseOrders),
        receipts: array(procurement.receipts),
        supplierInvoices: array(procurement.supplierInvoices),
        itemSupplierRelationships: array(itemSupplierRelationships),
        itemUnits: array(itemUnits),
        dataLimitations: [...new Set(dataLimitations)],
        truncatedSubjects: [...truncated.values()],
        runtimeAdapters: {
          items: masterData?.itemRuntime?.adapter || 'unavailable',
          suppliers: masterData?.supplierRuntime?.adapter || 'unavailable',
          customers: masterData?.customerRuntime?.adapter || 'unavailable',
          inventory: repositories.inventoryRuntime?.adapter || 'unavailable',
          salesOrders: repositories.salesOrders?.adapter || 'unavailable',
          procurement: repositories.procurementRuntime?.adapter || 'unavailable',
          warehouses: 'unavailable',
          bins: 'unavailable',
        },
        generatedAt: new Date().toISOString(),
      }
    },
  }
}

// The last change of a document as an instant. Purchase requests and RFQs
// also carry their update day for older readers; the instant is used here.
const updatedAt = record => String(record.updatedAtInstant || record.updatedAt || record.createdAt || '')
// The currency the document records. Never a guess: '' when none is stored.
const documentCurrency = record => String(record.defaultCurrency || record.currency || record.lines?.find(line => line?.currency)?.currency || '').trim().toUpperCase()
const amountOf = value => value === null || value === undefined || value === '' || !Number.isFinite(Number(value)) ? null : Number(value)
const route = (path, id) => `${path}/${encodeURIComponent(id)}`

// Every document the reader can open, newest change first: purchase requests,
// RFQs, purchase orders, receipts, bills, sales orders and customer invoices.
// Types and statuses are codes; the page labels them. Only a recorded name is
// shown as the partner, never an id.
// The sales order read model names an order without a recorded customer
// "未命名客户"; that placeholder is not a recorded name, so the row shows none.
const UNNAMED_CUSTOMER = '未命名客户'
const recordedCustomer = name => name && name !== UNNAMED_CUSTOMER ? name : null
// An approved supplier invoice shows where its payment stands (to_pay,
// partially_settled, settled), as the supplier invoice list shows it, when
// its payable's status was read (payableStatuses: invoice id to status).
const billStatus = (row, payableStatuses) => billPaymentStatus(row.status, payableStatuses?.[row.id]) || row.status
// An issued customer invoice shows where its payment stands (to_be_paid,
// partially_settled, settled), as the customer invoice list shows it, when its
// receivable's status was read: on the row (receivableStatus) or in
// receivableStatuses (invoice id to status).
const customerInvoiceStatus = (row, receivableStatuses) =>
  customerInvoicePaymentStatus(row.status, row.receivableStatus ?? receivableStatuses?.[row.id]) || row.status
function homeDocuments(context, customerInvoices = [], payableStatuses = {}, receivableStatuses = {}) {
  const rows = value => Array.isArray(value) ? value : []
  return [
    ...rows(context.purchaseRequests).map(row => ({ type: 'purchase_request', id: row.id, number: row.number || row.id, status: row.status, partner: row.lines?.[0]?.supplierSnapshot?.supplierName || null, amount: amountOf(row.totalAmount), currency: documentCurrency(row), updatedAt: updatedAt(row), canonicalRoute: route('/app/procurement/requests', row.id) })),
    ...rows(context.rfqs).map(row => ({ type: 'rfq', id: row.id, number: row.number || row.id, status: row.status, partner: null, amount: amountOf(row.totalAmount), currency: documentCurrency(row), updatedAt: updatedAt(row), canonicalRoute: route('/app/procurement/rfq', row.id) })),
    ...rows(context.purchaseOrders).map(row => ({ type: 'purchase_order', id: row.id, number: row.number || row.orderNumber || row.id, status: row.status, partner: row.supplierSnapshot?.supplierName || row.supplierName || null, amount: amountOf(row.totalAmount), currency: documentCurrency(row), updatedAt: updatedAt(row), canonicalRoute: route('/app/procurement/orders', row.id) })),
    ...rows(context.receipts).map(row => ({ type: 'receipt', id: row.id, number: row.documentNumber || row.id, status: row.postingStatus || row.status, partner: row.supplierName || null, amount: null, currency: '', updatedAt: updatedAt(row), canonicalRoute: route('/app/procurement/receiving', row.id) })),
    ...rows(context.supplierInvoices).map(row => ({ type: 'supplier_invoice', id: row.id, number: row.invoiceNumber || row.id, status: billStatus(row, payableStatuses), partner: row.supplierName || null, amount: amountOf(row.totalAmount ?? row.amount), currency: documentCurrency(row), updatedAt: updatedAt(row), canonicalRoute: route('/app/procurement/bills', row.id) })),
    ...rows(context.salesOrders).map(row => ({ type: 'sales_order', id: row.id || row.salesOrderId, number: row.orderNumber || row.id, status: salesOrderHomeStatus(row), partner: recordedCustomer(row.customerName), amount: amountOf(row.totalAmount), currency: documentCurrency(row), updatedAt: updatedAt(row), canonicalRoute: route('/app/sales/orders', row.id || row.salesOrderId) })),
    ...rows(customerInvoices).map(row => ({ type: 'customer_invoice', id: row.id, number: row.invoiceNumber || row.id, status: customerInvoiceStatus(row, receivableStatuses), partner: recordedCustomer(row.customerName), amount: amountOf(row.totalAmount), currency: documentCurrency(row), updatedAt: updatedAt(row), canonicalRoute: route('/app/sales/invoices', row.id) })),
  ].filter(row => row.id)
}

// A sales order shows the status the sales report shows once it has shipped:
// fulfilled or partially fulfilled (as fulfillment status codes, which Today
// labels "Fulfilled" and "Partially fulfilled"). Before it ships, and when it
// is a draft or cancelled, it shows its workflow status.
function salesOrderHomeStatus(row) {
  const workflow = String(row.workflowStatus || '').trim()
  if (['draft', 'cancelled', 'canceled'].includes(workflow)) return workflow
  if (row.status === 'fulfilled' || row.fulfillmentStatus === 'fully_fulfilled') return 'fully_fulfilled'
  if (row.status === 'partially_fulfilled' || row.fulfillmentStatus === 'partially_fulfilled') return 'partially_fulfilled'
  return workflow || row.status
}

const instant = value => { const parsed = Date.parse(value); return Number.isFinite(parsed) ? parsed : 0 }
export const RECENT_DOCUMENTS = 8
// At most this many rows of one document type while other types have recent
// documents too, so a day of seeded invoices does not fill the whole list.
export const RECENT_DOCUMENTS_PER_TYPE = 3

// The latest changed documents, newest first, with no type taking more than
// RECENT_DOCUMENTS_PER_TYPE rows while another type has rows to show; rows of
// a type are always its newest. Fewer types than that fill up from the rest.
export function pickRecentDocuments(documents, { limit = RECENT_DOCUMENTS, perType = RECENT_DOCUMENTS_PER_TYPE } = {}) {
  const order = (a, b) => instant(b.updatedAt) - instant(a.updatedAt) || a.type.localeCompare(b.type) || String(a.id).localeCompare(String(b.id))
  const sorted = [...documents].sort(order)
  const picked = []
  const skipped = []
  const perTypeCount = new Map()
  for (const row of sorted) {
    if (picked.length >= limit) break
    const count = perTypeCount.get(row.type) || 0
    if (count < perType) { picked.push(row); perTypeCount.set(row.type, count + 1) } else skipped.push(row)
  }
  for (const row of skipped) { if (picked.length >= limit) break; picked.push(row) }
  return picked.sort(order)
}

// The home page (GET /api/home/overview) from the reader's scoped context and
// the sources the route reads for it (server/domain/today-work-read-service.mjs):
//
//   workItems        what needs doing, earliest date first
//                    (server/domain/today-work.mjs), with the total and how
//                    many are past their date;
//   todayChanges     how many documents the reader can open were last changed
//                    on the workspace day; the audit log is not counted (see
//                    countDocumentsUpdatedToday);
//   recentDocuments  the latest changed documents of every type (no more than
//                    three of one type while others have some), with the
//                    instant of the change;
//   firstRun         the first-day checklist while any step is open.
export function buildHomeOverview(context, { now = new Date(), timeZone = DEFAULT_TENANT_TIMEZONE, sources = {}, setup = null, setupOptions = {}, hidden = [], limitations = [] } = {}) {
  const work = buildTodayWork({
    purchaseOrders: context.purchaseOrders,
    reportPurchaseOrders: sources.reportPurchaseOrders,
    purchaseRequests: context.purchaseRequests,
    supplierInvoices: context.supplierInvoices,
    salesOrders: context.salesOrders,
    allocationRows: sources.allocationRows,
    reorder: sources.reorder,
    customerInvoices: sources.customerInvoices,
    receivables: sources.receivables,
    contracts: sources.contracts,
  }, { now, timeZone })
  const documents = homeDocuments(context, sources.recentCustomerInvoices, sources.billPayableStatuses, sources.customerInvoiceReceivableStatuses)
  const todayChanges = countDocumentsUpdatedToday(documents, { now, timeZone })
  const recentDocuments = pickRecentDocuments(documents)
  // A reader of only some warehouses gets the reorder list's items as not
  // checked, so Today names that instead of showing no stock to reorder.
  const reorderScoped = sources.reorder?.scope?.kind === 'reader_warehouses'
  return {
    today: work.today,
    timeZone,
    workItems: work.items,
    workTotal: work.total,
    overdue: work.overdue,
    todayChanges,
    recentDocuments,
    firstRun: buildFirstRunChecklist(setup, setupOptions),
    hidden: [...new Set(hidden)],
    counts: { workItems: work.total, overdue: work.overdue, todayChanges, recentDocuments: recentDocuments.length },
    limitations: [...new Set([...(context.dataLimitations || []), ...limitations, ...(reorderScoped ? ['reorder_not_checked_for_warehouse_scope'] : [])])],
    generatedAt: now.toISOString(),
  }
}
