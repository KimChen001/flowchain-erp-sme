import { isOpenPurchaseOrder, reportCalendarDay } from './open-purchase-order.mjs'
import { tenantCalendarDay } from './tenant-calendar-day.mjs'
import { buildOpenPurchaseOrdersReport } from './open-purchase-orders-report.mjs'
import { can } from '../auth/authorization-service.mjs'
import { resolveProvisionedActor } from './pilot-identity.mjs'
import { createBankReconciliationService } from './bank-reconciliation-service.mjs'
import { partitionBusinessRecords, resultStateForValidity, validitySummary } from './ai-business-record-validity.mjs'

export const PAYMENT_BLOCK_REASONS = Object.freeze([
  'invoice_disputed',
  'payment_hold',
  'missing_invoice',
  'missing_receiving_evidence',
  'three_way_match_difference',
  'supplier_mismatch',
  'currency_mismatch',
  'settlement_not_posted',
  'bank_reconciliation_exception',
  'data_incomplete',
])

const text = (value) => String(value ?? '').trim()
const array = (value) => Array.isArray(value) ? value : []
const decimal = (value) => {
  if (value === null || value === undefined || value === '') return null
  const parsed = typeof value?.toNumber === 'function' ? value.toNumber() : Number(value)
  return Number.isFinite(parsed) ? parsed : null
}
const serial = (value) => value?.toISOString?.() || value || null
const date = (value) => { const parsed = value instanceof Date ? value : new Date(value); return Number.isNaN(parsed.getTime()) ? null : parsed }
const unique = (items) => [...new Set(items.filter(Boolean))]
const permission = (actor, code) => Boolean(actor?.permissionCodes?.has(code))
const isDay = (value) => /^\d{4}-\d{2}-\d{2}$/.test(String(value ?? ''))
// The calendar day of an instant (an arrival, a hold, a detection, a creation
// time), in the workspace timezone when known.
function dayOf(value, timeZone) {
  if (isDay(value)) return value
  const parsed = value ? date(value) : null
  if (!parsed) return null
  if (timeZone) {
    try { return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(parsed) } catch { /* an unknown timezone falls back to UTC */ }
  }
  return parsed.toISOString().slice(0, 10)
}
// A date-only field (a payable's due date, an invoice date) is stored at 00:00
// UTC and is its own calendar day: it is never moved by the workspace
// timezone, which would put it a day earlier in US timezones (see
// tenant-calendar-day.mjs), as the open purchase orders report reads it.
const calendarDay = (value) => reportCalendarDay(serial(value)) || null
const earliestDay = (days) => days.filter(isDay).sort()[0] || null
// Dated before undated; earlier dates first.
const compareDays = (left, right) => left && right ? (left < right ? -1 : left > right ? 1 : 0) : left ? -1 : right ? 1 : 0

function sourceState(available, visible, partition, count) {
  if (!available) return 'unavailable'
  if (!visible) return 'hidden'
  return resultStateForValidity(partition.recordValiditySummary, count)
}

// A due date is a calendar day and is compared with the window's calendar
// days (resolveBusinessTimeWindow's startDay and endDay, or the days of its
// bounds in the workspace timezone), never as an instant: a bill due today,
// stored at 00:00 UTC, falls before "today" begins in New York and read as
// overdue.
function inWindow(value, window) {
  const day = calendarDay(value)
  if (!day) return false
  const startDay = window?.startDay ?? (window?.startAt ? dayOf(window.startAt, window.timezone) : null)
  const endDay = window?.endDay ?? (window?.endAt ? dayOf(window.endAt, window.timezone) : null)
  if (window?.type === 'overdue') return endDay ? day <= endDay : false
  if (startDay && day < startDay) return false
  if (endDay && day > endDay) return false
  return true
}

// A purchase order as the open purchase orders report reads it: dates as ISO
// strings and the promised date from each line's metadata.
function reportRow(row) {
  const iso = (value) => value instanceof Date ? value.toISOString() : value ?? null
  return { ...row, id: text(row.id), expectedDate: iso(row.expectedDate), orderDate: iso(row.orderDate), createdAt: iso(row.createdAt), lines: array(row.lines).map((line) => ({ ...line, promisedDate: line.promisedDate || line.metadata?.promisedDate || null })) }
}

// Overdue from the day after the due day, in the workspace's calendar
// (`today`, tenantCalendarDay), as on the open purchase orders report.
function isOverdue(value, today) {
  const due = calendarDay(value)
  return Boolean(due && due < today)
}

// `status` is the stored status code and `reasonCode` says why the record is
// evidence. Both are codes; the answer builder words them in the answer language.
function evidence(type, id, label, status, route, reasonCode) {
  if (!id) return null
  return { type, entityType: type, id, entityId: id, label, entityLabel: label, status, reasonCode, route }
}

function supplierKey(row) {
  return text(row?.supplierId || row?.id)
}

function payableSupplierId(row) {
  return text(row?.supplierId || row?.supplierInvoice?.supplierId)
}

const INVOICE_BLOCKS = new Set(['three_way_match_difference', 'supplier_mismatch', 'currency_mismatch', 'missing_receiving_evidence'])

// The day a payable's block began: a hold from when it was held, a dispute
// from when it was disputed, an invoice problem from the invoice date, any
// other block from the day the payable was entered. Never its due date, which
// may still be ahead, and never after today.
function blockedSinceFor(payable, reasons, records, timeZone, today) {
  const invoice = payable.supplierInvoice || records.invoices.find((row) => row.id === payable.supplierInvoiceId)
  const days = reasons.map((reason) => {
    const day = reason === 'payment_hold' ? earliestDay([dayOf(payable.heldAt, timeZone), dayOf(invoice?.heldAt, timeZone)])
      : reason === 'invoice_disputed' ? dayOf(invoice?.disputedAt, timeZone) || calendarDay(invoice?.invoiceDate)
        : INVOICE_BLOCKS.has(reason) ? calendarDay(invoice?.invoiceDate)
          : null
    return day || dayOf(payable.createdAt, timeZone)
  })
  const day = earliestDay(days)
  return day && today && day > today ? today : day
}

function blockReasonsForPayable(payable, records) {
  const reasons = new Set()
  const invoice = payable.supplierInvoice || records.invoices.find((row) => row.id === payable.supplierInvoiceId)
  if (!invoice) reasons.add('missing_invoice')
  const payableStatus = text(payable.status).toLowerCase()
  const invoiceStatus = text(invoice?.status).toLowerCase()
  const matchStatus = text(invoice?.matchStatus).toLowerCase()
  if (payableStatus === 'held' || payable.heldAt || invoice?.heldAt) reasons.add('payment_hold')
  if (/disput|争议/.test(`${invoiceStatus} ${matchStatus}`)) reasons.add('invoice_disputed')
  if (/exception|mismatch|variance|差异/.test(matchStatus) || decimal(invoice?.varianceAmount) !== null && decimal(invoice?.varianceAmount) !== 0) reasons.add('three_way_match_difference')
  if (invoice && text(invoice.supplierId) && payableSupplierId(payable) && text(invoice.supplierId) !== payableSupplierId(payable)) reasons.add('supplier_mismatch')
  if (invoice && text(invoice.currency) && text(payable.currency) && text(invoice.currency) !== text(payable.currency)) reasons.add('currency_mismatch')
  if (invoice?.relatedGrnId && !records.receiving.some((row) => row.id === invoice.relatedGrnId || row.documentNumber === invoice.relatedGrnId)) reasons.add('missing_receiving_evidence')
  const allocations = records.settlements.flatMap((row) => array(row.allocations).map((allocation) => ({ settlement: row, allocation }))).filter(({ allocation }) => allocation.payableObligationId === payable.id)
  if (allocations.some(({ settlement }) => !['posted', 'reversed'].includes(text(settlement.postingStatus).toLowerCase()))) reasons.add('settlement_not_posted')
  if (records.bankExceptions.some((row) => ['open', 'acknowledged'].includes(text(row.status).toLowerCase()) && text(row.severity).toLowerCase() === 'blocking' && (!row.supplierId || text(row.supplierId) === payableSupplierId(payable)))) reasons.add('bank_reconciliation_exception')
  if (!date(payable.dueDate) || decimal(payable.outstandingAmount) === null || !payableSupplierId(payable)) reasons.add('data_incomplete')
  return PAYMENT_BLOCK_REASONS.filter((reason) => reasons.has(reason))
}

// Why a supplier needs attention and since when, with no score or weight
// (owner decision 2026-10-03). Each reason is dated by its oldest open record:
//   payment_overdue                     the payable's due date
//   payment_blocked                     the day the block began (blockedSinceFor)
//   purchase_order_overdue              the date promised on the report
//   invoice_exception                   the invoice date
//   receiving_exception                 the arrival, else the day it was entered
//   bank_reconciliation_exception       the day it was detected
//   data_incomplete                     no date
// `since` is the oldest of those dates. Reasons are listed oldest first.
// dateOf returns a calendar day, or an instant read in the workspace timezone.
export function supplierAttentionFor(groups, timeZone) {
  const reasons = []
  for (const [code, rows, dateOf] of groups) {
    if (!rows?.length) continue
    reasons.push({ code, since: earliestDay(rows.map((row) => dayOf(dateOf(row), timeZone))), count: rows.length })
  }
  reasons.sort((left, right) => compareDays(left.since, right.since) || left.code.localeCompare(right.code))
  return { since: earliestDay(reasons.map((row) => row.since)), reasons }
}

// Suppliers with a dated reason first, the oldest first; then the rest. Ties
// A-Z by name, then by id.
export function compareSupplierAttention(left, right) {
  return compareDays(left.priority?.since || null, right.priority?.since || null)
    || text(left.supplier?.name).localeCompare(text(right.supplier?.name))
    || text(left.supplier?.id).localeCompare(text(right.supplier?.id))
}

function emptySourceState(state) {
  return { state, recordValiditySummary: validitySummary({ unavailable: state === 'unavailable', hiddenCount: state === 'hidden' ? 1 : 0 }) }
}

// timeZone is the workspace timezone, whose calendar day decides overdue
// purchase orders, as on the open purchase orders report.
export function buildSupplierActionSummaries({ records = {}, actor, sourceAvailability = {}, timeWindow, filters = {}, now = new Date(), timeZone } = {}) {
  const current = now instanceof Date ? now : new Date(now)
  // The workspace's calendar day, which due dates are counted against.
  const today = tenantCalendarDay(current, timeZone || timeWindow?.timezone)
  const available = {
    suppliers: sourceAvailability.suppliers !== false,
    payables: sourceAvailability.payables !== false,
    invoices: sourceAvailability.invoices !== false,
    settlements: sourceAvailability.settlements !== false,
    purchaseOrders: sourceAvailability.purchaseOrders !== false,
    receiving: sourceAvailability.receiving !== false,
    rfqs: sourceAvailability.rfqs !== false,
    bankReconciliation: sourceAvailability.bankReconciliation !== false,
  }
  const visible = {
    payables: permission(actor, 'finance.payable.read'),
    invoices: permission(actor, 'finance.supplier_invoice.read'),
    settlements: permission(actor, 'finance.settlement.read'),
    cashbook: permission(actor, 'finance.cashbook.read'),
    purchaseOrders: permission(actor, 'procurement.purchase_order.read'),
    receiving: permission(actor, 'receiving.read'),
    bankReconciliation: permission(actor, 'finance.bank_reconciliation.read'),
    amounts: permission(actor, 'finance.amounts.read'),
    partner: permission(actor, 'finance.partner_snapshot.read'),
  }
  const partitions = {
    suppliers: partitionBusinessRecords('supplier', records.suppliers, { available: available.suppliers }),
    payables: partitionBusinessRecords('payable_obligation', records.payables, { available: available.payables, visible: visible.payables }),
    invoices: partitionBusinessRecords('supplier_invoice', records.invoices, { available: available.invoices, visible: visible.invoices }),
    settlements: partitionBusinessRecords('settlement_document', records.settlements, { available: available.settlements, visible: visible.settlements }),
    purchaseOrders: partitionBusinessRecords('purchase_order', records.purchaseOrders, { available: available.purchaseOrders, visible: visible.purchaseOrders }),
    receiving: partitionBusinessRecords('receiving_document', records.receiving, { available: available.receiving, visible: visible.receiving }),
  }
  const safeRecords = {
    invoices: partitions.invoices.validRecords,
    settlements: partitions.settlements.validRecords,
    receiving: partitions.receiving.validRecords,
    bankExceptions: visible.bankReconciliation && available.bankReconciliation ? array(records.bankExceptions).filter((row) => row?.safeDto === true || row?.projection === 'bank_ai_context_safe_v1') : [],
  }

  const summaries = partitions.suppliers.validRecords.map((supplier) => {
    const id = supplierKey(supplier)
    const currencyMatches = row => !filters.currencies?.length || filters.currencies.includes(text(row.currency))
    const payables = partitions.payables.validRecords.filter((row) => payableSupplierId(row) === id && currencyMatches(row))
    const invoices = partitions.invoices.validRecords.filter((row) => text(row.supplierId) === id && currencyMatches(row))
    const purchaseOrders = partitions.purchaseOrders.validRecords.filter((row) => text(row.supplierId) === id && currencyMatches(row))
    const receiving = partitions.receiving.validRecords.filter((row) => currencyMatches(row) && (text(row.supplierId) === id || purchaseOrders.some((po) => text(row.poId) === text(po.id))))
    const rfqs = available.rfqs && visible.purchaseOrders ? array(records.rfqs).filter((row) => currencyMatches(row) && (text(row.supplierId) === id || array(row.invitedSupplierIds).map(text).includes(id))) : []
    const bankExceptions = safeRecords.bankExceptions.filter((row) => text(row.supplierId) === id)
    const activePayables = payables.filter((row) => !['settled', 'cancelled', 'voided'].includes(text(row.status).toLowerCase()) && decimal(row.outstandingAmount) > 0)
    const windowPayables = timeWindow?.type && timeWindow.type !== 'all' ? activePayables.filter((row) => inWindow(row.dueDate, timeWindow)) : activePayables
    const matchesDueState = payable => {
      if (!filters.dueState?.length) return true
      const reasons = blockReasonsForPayable(payable, safeRecords)
      return filters.dueState.some(state => state === 'overdue' ? isOverdue(payable.dueDate, today) : state === 'blocked' ? reasons.length > 0 : state === 'ready_for_payment' ? reasons.length === 0 : state === 'held' ? reasons.includes('payment_hold') : state === 'missing_evidence' ? reasons.some(reason => ['missing_invoice', 'missing_receiving_evidence'].includes(reason)) : state === 'future_due' ? calendarDay(payable.dueDate) > today : state === 'partially_settled' ? text(payable.status) === 'partially_settled' : state === 'disputed' ? reasons.includes('invoice_disputed') : state === 'due_now' ? Boolean(calendarDay(payable.dueDate)) && calendarDay(payable.dueDate) <= today : false)
    }
    const scopedPayables = windowPayables.filter(matchesDueState)
    const blocks = scopedPayables.flatMap((payable) => blockReasonsForPayable(payable, safeRecords).map((reason) => ({ payableId: payable.id, reason, supplierId: id })))
    const blockedSince = new Map(scopedPayables.map((payable) => [payable.id, blockedSinceFor(payable, blocks.filter((row) => row.payableId === payable.id).map((row) => row.reason), safeRecords, timeZone, dayOf(current, timeZone))]))
    const blockedIds = new Set(blocks.map((row) => row.payableId))
    const ready = scopedPayables.filter((row) => !blockedIds.has(row.id))
    const overdue = scopedPayables.filter((row) => isOverdue(row.dueDate, today))
    const currencies = unique(scopedPayables.map(row => text(row.currency)))
    const dueAmount = currencies.length > 1 ? null : scopedPayables.reduce((sum, row) => sum + (decimal(row.outstandingAmount) || 0), 0)
    const overdueAmount = currencies.length > 1 ? null : overdue.reduce((sum, row) => sum + (decimal(row.outstandingAmount) || 0), 0)
    const openInvoices = invoices.filter((row) => !['paid', 'cancelled', 'voided'].includes(text(row.status).toLowerCase()))
    const mismatchInvoices = invoices.filter((row) => /exception|mismatch|variance|差异/.test(text(row.matchStatus).toLowerCase()) || decimal(row.varianceAmount) !== null && decimal(row.varianceAmount) !== 0)
    const disputedInvoices = invoices.filter((row) => /disput|争议/.test(`${text(row.status)} ${text(row.matchStatus)}`.toLowerCase()))
    const missingEvidenceInvoices = invoices.filter((row) => !row.relatedPoId || row.relatedGrnId && !receiving.some((item) => item.id === row.relatedGrnId || item.documentNumber === row.relatedGrnId))
    // Open and overdue as the open purchase orders report counts them: committed
    // with quantity still to receive, and an open line past its promised date.
    // Drafts, pending approvals, rejections and fully received orders are not open.
    const openPos = purchaseOrders.filter(isOpenPurchaseOrder)
    const overdueReportRows = buildOpenPurchaseOrdersReport(openPos.map(reportRow), { export: 'true' }, current, { timeZone }).exportRows.filter((row) => row.overdueDays > 0)
    const overdueIds = new Set(overdueReportRows.map((row) => row.id))
    const overduePos = openPos.filter((row) => overdueIds.has(text(row.id)))
    const unreceivedPos = openPos.filter((row) => {
      const ordered = array(row.lines).reduce((sum, line) => sum + (decimal(line.orderedQuantity) || 0), 0)
      const receivedQty = array(row.lines).reduce((sum, line) => sum + (decimal(line.receivedQuantity) || 0), 0)
      return ordered > receivedQty
    })
    const receivingExceptions = receiving.filter((row) => /exception|reject|异常|拒收/.test(text(row.status).toLowerCase()) || array(row.lines).some((line) => (decimal(line.rejectedQty) || 0) > 0))
    // Rejected quantities per SKU and unit, never one total across them. A
    // line without its SKU or unit stays on its own: it may be another item
    // or unit than the next such line.
    const rejectedBySkuUnit = new Map()
    for (const [receiptIndex, row] of receivingExceptions.entries()) for (const [lineIndex, line] of array(row.lines).entries()) {
      const quantity = decimal(line.rejectedQty) || 0
      if (quantity <= 0) continue
      const sku = text(line.sku) || null
      const unit = text(line.unit) || null
      const key = JSON.stringify(sku && unit ? [sku, unit] : [sku, unit, text(line.id) || `${text(row.id) || receiptIndex}:${lineIndex}`])
      rejectedBySkuUnit.set(key, (rejectedBySkuUnit.get(key) || 0) + quantity)
    }
    const rejectedQuantities = [...rejectedBySkuUnit.entries()].map(([key, quantity]) => { const [sku, unit] = JSON.parse(key); return { sku, unit, quantity } })
      .sort((left, right) => text(left.sku).localeCompare(text(right.sku)) || text(left.unit).localeCompare(text(right.unit)))
    const pendingReceivingEvidence = receiving.filter((row) => ['draft', 'receiving', 'unposted'].includes(text(row.workflowStatus || row.postingStatus).toLowerCase()) && array(row.attachments).length === 0)
    const awaitingRfqs = rfqs.filter((row) => !['awarded', 'closed', 'cancelled'].includes(text(row.status).toLowerCase()) && Number(row.respondedSupplierCount ?? row.quoted ?? 0) < Number(row.supplierCount ?? row.suppliers ?? 0))
    const expiredRfqs = rfqs.filter((row) => isOverdue(row.dueDate || row.due, today) && !['awarded', 'closed', 'cancelled'].includes(text(row.status).toLowerCase()))
    const incompleteRecords = Object.values(partitions).flatMap((item) => item.incompleteRecords.filter(({ record }) => [record.supplierId, record.supplierInvoice?.supplierId].map(text).includes(id)))
    const incompleteRecordCount = incompleteRecords.length
    const limitations = []
    for (const [key, state] of Object.entries(available)) if (!state) limitations.push(`${key}_unavailable`)
    if (!visible.amounts) limitations.push('amounts_hidden')
    if (!visible.partner) limitations.push('partner_snapshot_hidden')
    const result = {
      // Without the partner snapshot permission there is no name to show; the
      // answer builder labels the supplier as restricted in the answer language.
      supplier: { id, code: text(supplier.code) || null, name: visible.partner ? text(supplier.name) : null, displayName: visible.partner ? text(supplier.name) : null, fieldVisibility: { partner: visible.partner } },
      payment: {
        currencies,
        state: sourceState(available.payables, visible.payables, partitions.payables, scopedPayables.length),
        dueCount: available.payables && visible.payables ? scopedPayables.length : null,
        dueAmount: available.payables && visible.payables && visible.amounts ? dueAmount : null,
        overdueCount: available.payables && visible.payables ? overdue.length : null,
        overdueAmount: available.payables && visible.payables && visible.amounts ? overdueAmount : null,
        readyCount: available.payables && visible.payables ? ready.length : null,
        blockedCount: available.payables && visible.payables ? new Set(blocks.map((row) => row.payableId)).size : null,
        blocks: available.payables && visible.payables ? blocks : [],
        recordValiditySummary: partitions.payables.recordValiditySummary,
      },
      invoice: {
        state: sourceState(available.invoices, visible.invoices, partitions.invoices, openInvoices.length),
        openCount: available.invoices && visible.invoices ? openInvoices.length : null,
        mismatchCount: available.invoices && visible.invoices ? mismatchInvoices.length : null,
        disputedCount: available.invoices && visible.invoices ? disputedInvoices.length : null,
        missingEvidenceCount: available.invoices && visible.invoices ? missingEvidenceInvoices.length : null,
        recordValiditySummary: partitions.invoices.recordValiditySummary,
      },
      procurement: {
        state: sourceState(available.purchaseOrders, visible.purchaseOrders, partitions.purchaseOrders, openPos.length),
        openPoCount: available.purchaseOrders && visible.purchaseOrders ? openPos.length : null,
        overduePoCount: available.purchaseOrders && visible.purchaseOrders ? overduePos.length : null,
        overduePoIds: available.purchaseOrders && visible.purchaseOrders ? overduePos.map((row) => row.id).sort() : [],
        unreceivedPoCount: available.purchaseOrders && visible.purchaseOrders ? unreceivedPos.length : null,
        recordValiditySummary: partitions.purchaseOrders.recordValiditySummary,
      },
      receiving: {
        state: sourceState(available.receiving, visible.receiving, partitions.receiving, receivingExceptions.length),
        exceptionCount: available.receiving && visible.receiving ? receivingExceptions.length : null,
        rejectedQuantities: available.receiving && visible.receiving ? rejectedQuantities : null,
        pendingEvidenceCount: available.receiving && visible.receiving ? pendingReceivingEvidence.length : null,
        recordValiditySummary: partitions.receiving.recordValiditySummary,
      },
      rfq: {
        state: !available.rfqs ? 'unavailable' : !visible.purchaseOrders ? 'hidden' : awaitingRfqs.length + expiredRfqs.length ? 'confirmed' : 'confirmed_zero',
        awaitingResponseCount: available.rfqs && visible.purchaseOrders ? awaitingRfqs.length : null,
        expiredCount: available.rfqs && visible.purchaseOrders ? expiredRfqs.length : null,
      },
      reconciliation: {
        state: !available.bankReconciliation ? 'unavailable' : !visible.bankReconciliation ? 'hidden' : bankExceptions.length ? 'confirmed' : 'confirmed_zero',
        unreconciledPaymentCount: available.bankReconciliation && visible.bankReconciliation ? bankExceptions.filter((row) => /unreconciled|not_reconciled/.test(text(row.exceptionType))).length : null,
        blockingExceptionCount: available.bankReconciliation && visible.bankReconciliation ? bankExceptions.filter((row) => ['open', 'acknowledged'].includes(text(row.status).toLowerCase()) && text(row.severity).toLowerCase() === 'blocking').length : null,
      },
      dataQuality: { incompleteRecordCount, limitations },
      priority: null,
      recommendedActions: unique([
        blocks.length ? 'review_payment_blocks' : null,
        overduePos.length ? 'follow_up_overdue_purchase_orders' : null,
        receivingExceptions.length ? 'review_receiving_exceptions' : null,
        mismatchInvoices.length ? 'review_invoice_exceptions' : null,
        bankExceptions.length ? 'review_bank_reconciliation_exceptions' : null,
      ]),
      evidence: unique([
        ...scopedPayables.map((row) => evidence('payable_obligation', row.id, row.obligationNumber || row.id, row.status, '/finance?view=payables', blockedIds.has(row.id) ? 'payable_blocked' : isOverdue(row.dueDate, today) ? 'payable_overdue' : 'payable_due')),
        ...overduePos.map((row) => evidence('purchase_order', row.id, row.id, row.status, '/procurement?view=purchase-orders', 'purchase_order_overdue')),
        ...mismatchInvoices.map((row) => evidence('supplier_invoice', row.id, row.invoiceNumber || row.id, row.status, '/finance?view=invoices', 'invoice_match_difference')),
        ...receivingExceptions.map((row) => evidence('receiving_doc', row.id, row.documentNumber || row.id, row.status, '/receiving', 'receiving_exception')),
      ].filter(Boolean).map((item) => JSON.stringify(item))).map((item) => JSON.parse(item)),
      sourceStatus: { available, visible },
    }
    const shown = (source) => available[source] && visible[source]
    const blockedPayables = scopedPayables.filter((row) => blockedIds.has(row.id))
    const invoiceExceptions = [...new Set([...mismatchInvoices, ...disputedInvoices])]
    const blockingBank = bankExceptions.filter((row) => ['open', 'acknowledged'].includes(text(row.status).toLowerCase()) && text(row.severity).toLowerCase() === 'blocking')
    result.priority = supplierAttentionFor([
      ['payment_overdue', shown('payables') ? overdue : [], (row) => calendarDay(row.dueDate)],
      ['payment_blocked', shown('payables') ? blockedPayables : [], (row) => blockedSince.get(row.id)],
      ['purchase_order_overdue', shown('purchaseOrders') ? overdueReportRows : [], (row) => calendarDay(row.dueDate)],
      ['invoice_exception', shown('invoices') ? invoiceExceptions : [], (row) => calendarDay(row.invoiceDate)],
      ['receiving_exception', shown('receiving') ? receivingExceptions : [], (row) => row.arrivedAt || row.createdAt],
      ['bank_reconciliation_exception', shown('bankReconciliation') ? blockingBank : [], (row) => row.detectedAt || row.createdAt],
      ['data_incomplete', incompleteRecords, () => null],
    ], timeZone)
    return result
  })

  summaries.sort(compareSupplierAttention)
  return {
    items: summaries,
    recordValiditySummary: validitySummary({
      validCount: partitions.suppliers.recordValiditySummary.validCount,
      incompleteCount: Object.values(partitions).reduce((sum, item) => sum + item.recordValiditySummary.incompleteCount, 0),
      invalidCount: Object.values(partitions).reduce((sum, item) => sum + item.recordValiditySummary.invalidCount, 0),
      hiddenCount: Object.values(partitions).reduce((sum, item) => sum + item.recordValiditySummary.hiddenCount, 0),
      unavailable: Object.values(partitions).some((item) => item.recordValiditySummary.unavailable),
    }),
    fieldVisibility: { amounts: visible.amounts, partner: visible.partner },
    sourceStatus: { available, visible },
  }
}

async function loadIf(allowed, loader) {
  if (!allowed) return []
  return loader()
}

export function createSupplierActionSummaryReadService({ prisma, env = process.env, now = () => new Date(), bankService } = {}) {
  if (!prisma) throw new Error('prisma is required')
  return {
    async read({ timeWindow, filters } = {}, context = {}) {
      const actor = context.actor || await resolveProvisionedActor(prisma, context.identity || context, { allowMissingTestActor: true })
      const tenantId = actor.tenantId
      const allowed = (code) => can({ actor, permission: code, tenantId })
      const warehouseIds = [...(actor.readWarehouseIds || [])]
      const warehouseFilter = actor.allWarehouses ? {} : { AND: [
        { OR: [{ warehouseId: null }, { warehouseId: { in: warehouseIds } }] },
        { lines: { every: { OR: [{ warehouseId: null }, { warehouseId: { in: warehouseIds } }] } } },
        { OR: [{ warehouseId: { in: warehouseIds } }, { lines: { some: { warehouseId: { in: warehouseIds } } } }] },
      ] }
      const [suppliers, payables, invoices, settlements, purchaseOrders, receiving, rfqs] = await Promise.all([
        prisma.supplier.findMany({ where: { tenantId }, orderBy: [{ id: 'asc' }] }),
        loadIf(allowed('finance.payable.read'), () => prisma.payableObligation.findMany({ where: { tenantId }, include: { supplierInvoice: { include: { matchRuns: { include: { exceptions: true } } } } }, orderBy: [{ dueDate: 'asc' }, { id: 'asc' }] })),
        loadIf(allowed('finance.supplier_invoice.read'), () => prisma.supplierInvoice.findMany({ where: { tenantId }, include: { matchRuns: { include: { exceptions: true } } }, orderBy: [{ id: 'asc' }] })),
        loadIf(allowed('finance.settlement.read'), () => prisma.settlementDocument.findMany({ where: { tenantId }, include: { allocations: true }, orderBy: [{ id: 'asc' }] })),
        loadIf(allowed('procurement.purchase_order.read'), () => prisma.purchaseOrder.findMany({ where: { tenantId }, include: { lines: true }, orderBy: [{ id: 'asc' }] })),
        loadIf(allowed('receiving.read'), () => prisma.receivingDocument.findMany({ where: { tenantId, ...warehouseFilter }, include: { lines: true, attachments: true }, orderBy: [{ id: 'asc' }] })),
        loadIf(allowed('procurement.purchase_order.read'), () => prisma.rfq.findMany({ where: { tenantId }, include: { lines: true }, orderBy: [{ id: 'asc' }] })),
      ])
      let bankExceptions = []
      let bankAvailable = true
      if (allowed('finance.bank_reconciliation.read')) {
        try {
          const safeService = bankService || createBankReconciliationService({ prisma, env })
          const response = await safeService.listExceptions(context)
          bankExceptions = array(response.items).map((row) => ({ ...row, safeDto: true }))
        } catch (error) {
          if (['BANK_RECONCILIATION_CAPABILITY_NOT_AVAILABLE', 'AUTHORIZATION_CAPABILITY_DISABLED'].includes(error?.code)) bankAvailable = false
          else throw error
        }
      }
      return buildSupplierActionSummaries({
        records: { suppliers, payables, invoices, settlements, purchaseOrders, receiving, rfqs, bankExceptions },
        actor,
        sourceAvailability: { bankReconciliation: bankAvailable },
        timeWindow,
        filters,
        now: now(),
        timeZone: typeof prisma.tenant?.findUnique === 'function' ? text((await prisma.tenant.findUnique({ where: { id: tenantId }, select: { timezone: true } }))?.timezone) || undefined : undefined,
      })
    },
  }
}
