import { aiSkillDaysBetween, buildAiSkillSignals } from './ai-skill-signals.mjs'
import { buildOpenPurchaseOrdersReport, purchaseOrderDueDay, purchaseOrderReportLine } from './open-purchase-orders-report.mjs'
import { reportCalendarDay } from './open-purchase-order.mjs'
import { awaitingReceipt } from './operational-finance-policy.mjs'
import { PURCHASE_ORDER_STATUS, normalizeProcurementAuthorityStatus } from './procurement-status-authority.mjs'
import { DEFAULT_TENANT_TIMEZONE, instantCalendarDay, tenantCalendarDay } from './tenant-calendar-day.mjs'

// The work Today lists, from the rules the rest of the app already uses. No
// rule is invented here:
//
//   purchase orders   overdue, or due within 7 days, with quantity still to
//                     receive: the open purchase orders report
//                     (buildOpenPurchaseOrdersReport) read through the
//                     assistant's today signals (buildAiSkillSignals,
//                     po_overdue and po_due_7d).
//   reorder           the reorder list's "order now" rows (buildReorderList).
//                     The assistant's stock signal for the same item (below
//                     safety stock, at the reorder point) labels the row.
//   bills             the bills page's next step: submitted and waiting for
//                     the receipt or the match, matched and waiting for
//                     approval, or a match exception to review.
//   invoices          customer invoices approved and not yet issued (the
//                     finance landing's "awaiting issue").
//   receivables       money still owed after the due date (the finance
//                     landing's overdue rule, by calendar day).
//   sales orders      confirmed orders with quantity still to reserve or ship.
//   purchasing        purchase requests to approve or convert, purchase orders
//                     to approve and draft purchase orders to review.
//
// Every row carries the date that orders it and nothing else orders the list
// (owner decision 2026-10-03: by date, not by a score): the earliest date
// first, rows without a date last; a tie keeps a fixed order of kinds, then
// the record label. Due and promised dates are calendar days stored at 00:00
// or 12:00 UTC and are read as calendar days (reportCalendarDay), never in the
// workspace timezone, where they would fall a day early in the US. Today is
// the workspace day (tenantCalendarDay).
//
// Rows hold codes, ids, dates and numbers; the page writes the words. A
// collection the reader may not read is empty before it gets here, and a
// hidden amount or partner is null.

export const TODAY_WORK_KINDS = Object.freeze([
  'purchase_order_overdue',
  'receivable_overdue',
  'sales_order_to_ship',
  'sales_order_to_reserve',
  'purchase_order_due',
  'reorder_now',
  'bill_exception',
  'bill_to_approve',
  'bill_to_match',
  'bill_awaiting_receipt',
  'customer_invoice_to_issue',
  'purchase_order_to_approve',
  'purchase_request_to_approve',
  'purchase_request_to_convert',
  'draft_purchase_order',
])
const KIND_RANK = new Map(TODAY_WORK_KINDS.map((kind, index) => [kind, index]))
// How many rows the response carries; the total is always reported.
export const TODAY_WORK_LIMIT = 100

const array = (value) => (Array.isArray(value) ? value : [])
const text = (value) => String(value ?? '').trim()
const quantity = (value) => (value === null || value === undefined || value === '' || !Number.isFinite(Number(value)) ? null : Number(value))
const round = (value) => Math.round(value * 10000) / 10000
const encode = (value) => encodeURIComponent(text(value))

function purchaseOrderStatus(value) {
  try { return normalizeProcurementAuthorityStatus('purchaseOrder', value) } catch { return text(value) }
}

// A stored calendar day (due, promised, invoice, required) as YYYY-MM-DD.
// An ISO instant keeps its UTC date, which is the day it was stored for.
function calendarDay(value) {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.toISOString().slice(0, 10) : ''
  return reportCalendarDay(value)
}

function row(kind, entityType, recordId, fields) {
  return {
    id: `${kind}:${recordId}`,
    kind,
    entityType,
    recordId,
    label: fields.label || recordId,
    name: fields.name ?? null,
    href: fields.href,
    actionHref: fields.actionHref ?? null,
    date: fields.date || null,
    dateKind: fields.dateKind,
    overdueDays: fields.overdueDays ?? 0,
    detail: fields.detail || {},
  }
}

// Days past a calendar day, 0 when it is today or later.
const daysLate = (day, today) => (day && today ? Math.max(0, aiSkillDaysBetween(day, today)) : 0)

// The open purchase orders report's rows in the shape the assistant reads
// them (readAiSkillFacts): each order with its lines still to receive.
export function purchaseOrderSignalRows(purchaseOrders, now, timeZone) {
  const report = buildOpenPurchaseOrdersReport(array(purchaseOrders), { export: 'true' }, now, { timeZone })
  const byId = new Map(array(purchaseOrders).map((po) => [text(po.id), po]))
  const rows = array(report.exportRows).map((entry) => {
    const po = byId.get(entry.id) || {}
    const lines = array(po.lines)
    const openLines = lines.flatMap((line) => {
      const read = purchaseOrderReportLine(line, po)
      return read.open ? [{ sku: text(line.sku) || null, itemId: text(line.itemId) || null, remaining: read.remaining, unit: read.unit || null, promisedDate: read.due || null }] : []
    })
    return {
      id: entry.id, orderNumber: entry.orderNumber, supplierId: entry.supplierId, supplier: entry.supplier, status: entry.status,
      dueDate: entry.dueDate, overdueDays: entry.overdueDays, ordered: entry.ordered, received: entry.received, remaining: entry.remaining, unit: entry.unit,
      sku: text(lines[0]?.sku) || null, itemId: text(lines[0]?.itemId) || null, openLines,
    }
  })
  return { asOf: report.asOf, rows }
}

function purchaseOrderWork(signals, rowsById) {
  return signals
    .filter((signal) => signal.type === 'po_overdue' || signal.type === 'po_due_7d')
    .map((signal) => {
      const po = rowsById.get(signal.entityId) || {}
      const data = signal.data || {}
      const late = signal.type === 'po_overdue'
      // The order's own remaining quantity only when it is one SKU in one
      // unit; otherwise the number of lines still to receive.
      const single = quantity(data.remaining) !== null && data.unit && !['mixed', 'multiple_skus'].includes(data.unit)
      return row(late ? 'purchase_order_overdue' : 'purchase_order_due', 'purchase_order', signal.entityId, {
        label: signal.label,
        name: text(signal.supplier) || null,
        href: `/app/procurement/orders/${encode(signal.entityId)}`,
        date: data.dueDate || signal.when?.date || null,
        dateKind: 'due',
        overdueDays: late ? Number(data.days) || 0 : 0,
        detail: {
          remaining: single ? quantity(data.remaining) : null,
          unit: single ? data.unit : null,
          openLines: array(data.openLines).length,
          received: single ? quantity(po.received) : null,
          ordered: single ? quantity(po.ordered) : null,
          notIssued: Boolean(data.notSent),
          dueInDays: late ? null : Number(data.days) || 0,
        },
      })
    })
}

// The assistant's stock signal for each item it flags, the most urgent one:
// stock_shortage, then stock_below_safety, then stock_below_reorder.
function stockSignalBySku(signals) {
  const order = ['stock_shortage', 'stock_below_safety', 'stock_below_reorder']
  const bySku = new Map()
  for (const signal of signals) {
    if (!order.includes(signal.type)) continue
    const sku = text(signal.data?.sku || signal.label)
    const current = bySku.get(sku)
    if (!current || order.indexOf(signal.type) < order.indexOf(current)) bySku.set(sku, signal.type)
  }
  return bySku
}

function reorderWork(reorder, stockSignals) {
  return array(reorder?.rows)
    .filter((entry) => entry.orderNow)
    .map((entry) => row('reorder_now', 'item', text(entry.itemId), {
      label: text(entry.sku),
      name: text(entry.itemName) || null,
      href: `/app/master-data/items/${encode(entry.itemId)}`,
      actionHref: '/app/inventory/reorder',
      date: entry.orderByDate,
      dateKind: 'order_by',
      detail: {
        position: quantity(entry.position),
        reorderPoint: quantity(entry.reorderPoint),
        shortfall: quantity(entry.shortfall),
        unit: text(entry.unit) || null,
        stockSignal: stockSignals.get(text(entry.sku)) || null,
      },
    }))
}

// The next step a bill waits for, as the bills page offers it
// (operational-finance-read-service.mjs actions).
export function billNextStep(invoice) {
  const status = text(invoice?.status).toLowerCase()
  const links = { status, relatedPoId: invoice?.relatedPoId ?? invoice?.poId ?? invoice?.relatedPo ?? null, relatedGrnId: invoice?.relatedGrnId ?? invoice?.receiptId ?? invoice?.relatedGrn ?? null }
  if (status === 'submitted' && awaitingReceipt(links)) return 'bill_awaiting_receipt'
  if (status === 'submitted' || status === 'matching') return 'bill_to_match'
  if (status === 'matched') return 'bill_to_approve'
  if (status === 'exception') return 'bill_exception'
  return null
}

function billWork(supplierInvoices, timeZone) {
  return array(supplierInvoices).flatMap((invoice) => {
    const kind = billNextStep(invoice)
    if (!kind) return []
    const id = text(invoice.id)
    return [row(kind, 'supplier_invoice', id, {
      label: text(invoice.invoiceNumber) || id,
      name: text(invoice.supplierName) || null,
      href: `/app/procurement/bills/${encode(id)}`,
      date: calendarDay(invoice.invoiceDate) || instantCalendarDay(invoice.createdAt, timeZone) || null,
      dateKind: 'invoice',
      detail: { amount: quantity(invoice.totalAmount ?? invoice.amount), currency: text(invoice.currency) || null },
    })]
  })
}

function customerInvoiceWork(customerInvoices, timeZone) {
  return array(customerInvoices)
    .filter((invoice) => text(invoice.status) === 'approved')
    .map((invoice) => {
      const id = text(invoice.id)
      return row('customer_invoice_to_issue', 'customer_invoice', id, {
        label: text(invoice.invoiceNumber) || id,
        name: text(invoice.customerName) || null,
        href: `/app/sales/invoices/${encode(id)}`,
        date: calendarDay(invoice.invoiceDate) || instantCalendarDay(invoice.createdAt, timeZone) || null,
        dateKind: 'invoice',
        detail: { amount: quantity(invoice.totalAmount), currency: text(invoice.currency) || null },
      })
    })
}

// Overdue as the finance landing counts it (overdueReceivableWhere): money
// still owed on an open, partly settled or overdue receivable past its due
// date, by calendar day.
const OVERDUE_RECEIVABLE_STATUSES = new Set(['open', 'partially_settled', 'overdue'])
function receivableWork(receivables, today) {
  return array(receivables).flatMap((receivable) => {
    const due = calendarDay(receivable.dueDate)
    const outstanding = quantity(receivable.outstandingAmount)
    // A hidden amount is null; the read already asked for money still owed.
    const owed = outstanding === null ? receivable.amountHidden === true : outstanding > 0
    if (!OVERDUE_RECEIVABLE_STATUSES.has(text(receivable.status)) || !owed || !due || due >= today) return []
    const invoiceId = text(receivable.customerInvoiceId)
    return [row('receivable_overdue', 'customer_invoice', invoiceId || text(receivable.id), {
      label: text(receivable.customerInvoiceNumber) || text(receivable.obligationNumber) || text(receivable.id),
      name: text(receivable.customerName) || null,
      href: invoiceId ? `/app/sales/invoices/${encode(invoiceId)}` : '/app/finance/receivables',
      date: due,
      dateKind: 'due',
      overdueDays: daysLate(due, today),
      detail: { outstanding, currency: text(receivable.currency) || null, disputed: text(receivable.disputeStatus) === 'open' },
    })]
  })
}

// Confirmed sales orders with quantity still to reserve, else still to ship.
// Quantities are added only across lines in one unit; otherwise the row
// counts lines.
function salesOrderWork(salesOrders, today) {
  return array(salesOrders).flatMap((order) => {
    if (text(order.workflowStatus) !== 'confirmed' || text(order.fulfillmentStatus) === 'fulfilled') return []
    const lines = array(order.lines).map((line) => {
      const ordered = quantity(line.orderedQuantity) ?? 0
      const reserved = quantity(line.reservedQuantity) ?? 0
      const fulfilled = quantity(line.fulfilledQuantity) ?? 0
      return { unit: text(line.unit), toReserve: Math.max(0, round(ordered - reserved - fulfilled)), toShip: Math.max(0, round(ordered - fulfilled)) }
    })
    const reserveLines = lines.filter((line) => line.toReserve > 0)
    const shipLines = lines.filter((line) => line.toShip > 0)
    if (!shipLines.length) return []
    const kind = reserveLines.length ? 'sales_order_to_reserve' : 'sales_order_to_ship'
    const open = reserveLines.length ? reserveLines : shipLines
    const units = [...new Set(open.map((line) => line.unit))]
    const total = units.length === 1 && units[0] ? round(open.reduce((sum, line) => sum + (reserveLines.length ? line.toReserve : line.toShip), 0)) : null
    const id = text(order.id || order.salesOrderId)
    const promised = calendarDay(order.promisedDate)
    return [row(kind, 'sales_order', id, {
      label: text(order.orderNumber) || id,
      name: text(order.customerName) || null,
      href: `/app/sales/orders/${encode(id)}`,
      date: promised || null,
      dateKind: 'promised',
      overdueDays: daysLate(promised, today),
      detail: { quantity: total, unit: total === null ? null : units[0], lines: open.length },
    })]
  })
}

function purchasingWork(purchaseRequests, purchaseOrders) {
  const requestRows = array(purchaseRequests).flatMap((request) => {
    const status = text(request.status)
    const kind = status === 'submitted' ? 'purchase_request_to_approve' : status === 'approved' ? 'purchase_request_to_convert' : null
    if (!kind) return []
    const id = text(request.id)
    return [row(kind, 'purchase_request', id, {
      label: id,
      href: `/app/procurement/requests/${encode(id)}`,
      date: calendarDay(request.requiredDate || request.defaultNeedByDate) || null,
      dateKind: 'required',
      detail: kind === 'purchase_request_to_approve'
        ? { amount: quantity(request.totalAmount), currency: text(request.defaultCurrency || request.currency) || null }
        : {},
    })]
  })
  const orderRows = array(purchaseOrders).flatMap((po) => {
    const status = purchaseOrderStatus(po.status)
    const kind = status === PURCHASE_ORDER_STATUS.DRAFT ? 'draft_purchase_order' : status === PURCHASE_ORDER_STATUS.PENDING_APPROVAL ? 'purchase_order_to_approve' : null
    if (!kind) return []
    const id = text(po.id)
    return [row(kind, 'purchase_order', id, {
      label: text(po.orderNumber) || id,
      name: text(po.supplierSnapshot?.supplierName || po.supplierName || po.supplierId) || null,
      href: `/app/procurement/orders/${encode(id)}`,
      date: purchaseOrderDueDay(po) || null,
      dateKind: 'due',
      detail: {},
    })]
  })
  return [...requestRows, ...orderRows]
}

// Earliest date first, undated last; ties by kind, then label, then id.
export function compareTodayWork(a, b) {
  if (a.date !== b.date) return !a.date ? 1 : !b.date ? -1 : a.date < b.date ? -1 : 1
  return (KIND_RANK.get(a.kind) ?? 99) - (KIND_RANK.get(b.kind) ?? 99)
    || a.label.localeCompare(b.label, 'en')
    || a.recordId.localeCompare(b.recordId, 'en')
}

// sources: what the reader may read, already scoped (see buildHomeOverview).
export function buildTodayWork(sources = {}, { now = new Date(), timeZone = DEFAULT_TENANT_TIMEZONE } = {}) {
  const today = tenantCalendarDay(now, timeZone)
  const reportOrders = sources.reportPurchaseOrders ?? sources.purchaseOrders
  const { asOf, rows } = purchaseOrderSignalRows(reportOrders, now, timeZone)
  // The assistant's signals over the same facts it reads: open purchase
  // orders and stock availability.
  const signals = buildAiSkillSignals({ asOf, purchaseOrders: { rows }, inventory: { rows: array(sources.allocationRows) } })
  const items = [
    ...purchaseOrderWork(signals, new Map(rows.map((entry) => [entry.id, entry]))),
    ...reorderWork(sources.reorder, stockSignalBySku(signals)),
    ...billWork(sources.supplierInvoices, timeZone),
    ...customerInvoiceWork(sources.customerInvoices, timeZone),
    ...receivableWork(sources.receivables, today),
    ...salesOrderWork(sources.salesOrders, today),
    ...purchasingWork(sources.purchaseRequests, sources.purchaseOrders),
  ].sort(compareTodayWork)
  return {
    today,
    items: items.slice(0, TODAY_WORK_LIMIT),
    total: items.length,
    overdue: items.filter((item) => item.overdueDays > 0).length,
  }
}

// The first-day checklist: import items, suppliers, customers, opening
// stock, then invite a teammate. Each step is done by a real count, and the
// checklist is shown while any step is open. A step links to the import page
// for its record type; when import is not turned on, items, suppliers and
// customers link to their own pages and opening stock to a new inventory
// adjustment, if adjustments are turned on. Invitations are made in Users &
// Roles. A reader who may not do a step gets no link ('permission'), and a
// step this workspace has no page for gets none either ('unavailable').
export function buildFirstRunChecklist(setup, { permissions = {}, importEnabled = false, adjustmentsEnabled = false } = {}) {
  if (!setup) return null
  const count = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0)
  const importPage = (type, fallback) => (importEnabled ? `/app/master-data/import?type=${type}` : fallback)
  const steps = [
    { id: 'items', count: count(setup.items), href: importPage('items', '/app/master-data/items'), permitted: permissions.items },
    { id: 'suppliers', count: count(setup.suppliers), href: importPage('suppliers', '/app/master-data/suppliers'), permitted: permissions.suppliers },
    { id: 'customers', count: count(setup.customers), href: importPage('customers', '/app/master-data/customers'), permitted: permissions.customers },
    { id: 'opening_stock', count: count(setup.stockedItems), href: importPage('opening-stock', adjustmentsEnabled ? '/app/inventory/adjustments/new' : null), permitted: permissions.openingStock },
    // Done once someone else has joined or been invited.
    { id: 'teammates', count: Math.max(0, count(setup.activeUsers) - 1) + count(setup.pendingInvitations), href: '/app/settings/roles', permitted: permissions.teammates },
  ].map(({ permitted, href, ...step }) => ({
    ...step,
    done: step.count > 0,
    href: permitted && href ? href : null,
    blocked: !permitted ? 'permission' : !href ? 'unavailable' : null,
  }))
  const done = steps.filter((step) => step.done).length
  return done === steps.length ? null : { steps, done, total: steps.length }
}

// How many documents the reader can open were last changed on the workspace
// day. A document changed five times today counts once.
export function countDocumentsUpdatedToday(documents, { now = new Date(), timeZone = DEFAULT_TENANT_TIMEZONE } = {}) {
  const today = tenantCalendarDay(now, timeZone)
  const seen = new Set()
  for (const document of array(documents)) {
    const key = `${document.type}:${document.id}`
    if (!seen.has(key) && instantCalendarDay(document.updatedAt, timeZone) === today) seen.add(key)
  }
  return seen.size
}
