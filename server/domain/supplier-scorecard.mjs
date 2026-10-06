import { assertAuthorized, can } from '../auth/authorization-service.mjs'
import { resolveProvisionedActor } from './pilot-identity.mjs'
import { isCommittedPurchaseOrder } from './open-purchase-order.mjs'
import { currentPromisedDay, promiseDay } from './purchase-order-promise-dates.mjs'

// Supplier scorecard: delivery statistics per supplier, measured against the
// date each delivery was ORIGINALLY promised. The current expected date moves
// with the shipment; an on-time rate computed against it is only an upper
// bound, so the scorecard shows both and names the gap.
//
// The unit is the DELIVERY OBLIGATION: the lines of one purchase order that
// share one original promised date. A 12-line order promised for one day is
// one delivery, not twelve, so a large order cannot outweigh many small ones.
// Until suppliers confirm dates in FlowChain, the original promise is the date
// on the PO when it was approved, which may be the buyer's need date
// (rules.promiseBasis 'po_date').
//
// Definitions, per supplier and period (the standard OTIF decomposition, so the
// three measures are distinct):
//   delivery        the lines of one measured PO with the same original
//                   promised date, when that date falls in the period. A line
//                   ordered at zero, or closed with nothing received, is left
//                   out of its delivery (it was called off), unless it was
//                   closed after the promise plus grace days: then it was
//                   already late and stays in as late and not in full
//   judged          once every line has a posted receipt, or once today is past
//                   the promise plus grace days; until then the delivery waits
//   sample          fewer than 5 deliveries: "insufficient sample", no
//                   percentages; each rate also needs 5 deliveries in its own
//                   denominator
//   on time         every line's FIRST receipt arrived on or before the
//                   original promised date + grace days (default 0); a partial
//                   first receipt counts. Past that day with a line still
//                   unreceived the delivery is overdue: late and not OTIF
//   early           the last line's first receipt arrived more than 3 days
//                   before the original promise; still on time, reported apart
//   in full         every line's accepted quantity EVENTUALLY reached its
//                   ordered quantity. A delivery with a line still open with a
//                   shortfall is "not in full yet": reported as pending and left
//                   out of the in-full denominator until each line is fully
//                   received or closed (its PO is fully received or cancelled,
//                   or the line is closed short)
//   OTIF            every line's accepted quantity reached its ordered quantity
//                   by the original promised date + grace days
//   rejection rate  rejected quantity / received quantity (accepted +
//                   rejected) over the lines of the sample deliveries; none when
//                   the lines are for more than one SKU or use different units,
//                   whose quantities cannot be added
//   average delay   mean, over the late deliveries, of the days from the
//                   original promise to the last line's first receipt (for a
//                   line with none, today, or the day it was closed)
//   price variances supplier invoices dated in the period with a price
//                   variance
// In full and OTIF are three-valued over the lines: false when any line is
// false, true when all are true, otherwise undecided.
// "vs current date" repeats on time and OTIF against each line's current
// expected date, with the same grace days. A line not yet due against its
// current date counts as on time (and OTIF) against it, unless it was closed
// with nothing received; so the current-date rates are upper bounds; the gap to the original-promise rates shows what the
// revisions hide.
// Rates carry Wilson 95% intervals over deliveries. Days are calendar days in
// the workspace timezone. Every figure lists the deliveries, lines or invoices
// behind it. Money stays in its document currency and is never added across
// currencies.

export const SUPPLIER_SCORECARD_VERSION = 'supplier-scorecard-v3'
export const SUPPLIER_SCORECARD_RULES = Object.freeze({ graceDays: 0, earlyDays: 3, minimumSample: 5, promiseBasis: 'po_date', periodDays: 90, maxPeriodDays: 731, maxGraceDays: 30 })
export const SUPPLIER_SCORECARD_READ_PERMISSIONS = Object.freeze(['procurement.purchase_order.read', 'receiving.read'])
const COMMITTED_INVOICE_STATUSES_EXCLUDED = ['draft', 'cancelled', 'rejected']
const WILSON_Z = 1.959964

export class SupplierScorecardError extends Error {
  constructor(code, message, status = 422, details) {
    super(message)
    this.name = 'SupplierScorecardError'
    this.code = code
    this.status = status
    this.details = details
  }
}

const text = (value) => String(value ?? '').trim()
const quantity = (value) => {
  if (value === null || value === undefined || value === '') return 0
  const parsed = typeof value?.toNumber === 'function' ? value.toNumber() : Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}
const round = (value, places = 4) => value === null || value === undefined ? null : Math.round(value * 10 ** places) / 10 ** places
const DAY_MS = 86_400_000
const dayNumber = (day) => Date.parse(`${day}T00:00:00Z`) / DAY_MS
export const addDays = (day, days) => new Date(Date.parse(`${day}T12:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10)
export const daysBetween = (from, to) => dayNumber(to) - dayNumber(from)

export function localDay(instant, timeZone = 'America/New_York') {
  const date = instant instanceof Date ? instant : new Date(instant)
  if (!Number.isFinite(date.getTime())) return null
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date)
}

export function rate(successes, trials) {
  return trials > 0 ? successes / trials : null
}

// Wilson score interval for a binomial proportion, 95% by default.
export function wilsonInterval(successes, trials, z = WILSON_Z) {
  if (!(trials > 0)) return null
  const p = successes / trials
  const z2 = z * z
  const denominator = 1 + z2 / trials
  const center = (p + z2 / (2 * trials)) / denominator
  const half = (z * Math.sqrt((p * (1 - p)) / trials + z2 / (4 * trials * trials))) / denominator
  return { low: Math.max(0, center - half), high: Math.min(1, center + half) }
}

// The purchase orders whose lines are measured against their promise, here and
// on the report dashboards: committed orders (approved, issued or received).
// Drafts, pending approvals and rejections were never promised; a cancelled
// order was called off by the buyer, so its undelivered lines are not late.
// An approved order can still be cancelled, and approval records the original
// promise, so cancelled orders are left out explicitly.
export const isPromiseMeasuredPurchaseOrder = (purchaseOrder) => isCommittedPurchaseOrder(purchaseOrder)
const PROMISE_UNMEASURED_PO_STATUSES = ['draft', 'pending_approval', 'rejected', 'cancelled']

// A line is closed when nothing more will be received against it: its PO is
// fully received or cancelled, or the buyer closed the line short
// (metadata.closedAt; closing a remainder is decision D5, not built yet).
const CLOSED_PO_STATUSES = ['fully_received', 'closed', 'cancelled']
export function isLineClosed(line, purchaseOrder) {
  return CLOSED_PO_STATUSES.includes(text(purchaseOrder?.status)) || Boolean(text(line?.metadata?.closedAt))
}

// The day a closed line was closed, in the workspace timezone: the line's own
// closedAt, else the close of its PO. null when no closing time is recorded.
function closedDayOf(line, purchaseOrder, timeZone) {
  const closedAt = text(line?.metadata?.closedAt) || (text(purchaseOrder?.status) === 'closed' ? text(purchaseOrder?.metadata?.closedAt) : '')
  if (!closedAt) return null
  return /^\d{4}-\d{2}-\d{2}$/.test(closedAt) ? promiseDay(closedAt) : localDay(closedAt, timeZone)
}

// The day the accepted quantity first reached the ordered quantity, or null.
function fullDayOf(events, ordered) {
  let accepted = 0
  for (const entry of events) {
    accepted += quantity(entry.accepted)
    if (ordered > 0 && accepted >= ordered) return entry.day
  }
  return null
}

// One PO line against its original promise and its current date. receipts are
// the line's posted receipt lines: { receivingDocumentId, day, accepted, rejected }.
// A line is judged with the other lines of its delivery (groupDeliveryObligations).
export function evaluatePromiseLine({ line, purchaseOrder, receipts = [], asOfDay, graceDays = SUPPLIER_SCORECARD_RULES.graceDays, earlyDays = SUPPLIER_SCORECARD_RULES.earlyDays, timeZone = 'America/New_York' }) {
  const originalDay = promiseDay(line.originalPromisedDate)
  const currentDay = currentPromisedDay(line, purchaseOrder) || originalDay
  const events = [...receipts].filter((entry) => entry.day).sort((a, b) => a.day.localeCompare(b.day) || text(a.receivingDocumentId).localeCompare(text(b.receivingDocumentId)))
  const ordered = quantity(line.orderedQuantity)
  const receivedQuantity = events.reduce((sum, entry) => sum + quantity(entry.accepted) + quantity(entry.rejected), 0)
  const acceptedQuantity = events.reduce((sum, entry) => sum + quantity(entry.accepted), 0)
  const rejectedQuantity = events.reduce((sum, entry) => sum + quantity(entry.rejected), 0)
  const firstReceiptDay = events[0]?.day || null
  const fullDay = fullDayOf(events, ordered)
  const base = {
    purchaseOrderId: purchaseOrder.id,
    purchaseOrderLineId: line.id,
    sku: text(line.sku),
    itemName: text(line.itemName),
    unit: text(line.unit),
    orderedQuantity: ordered,
    receivedQuantity,
    acceptedQuantity,
    rejectedQuantity,
    originalPromisedDate: originalDay,
    currentPromisedDate: currentDay,
    revised: Boolean(originalDay && currentDay && originalDay !== currentDay),
    firstReceiptDay,
    fullDay,
    closed: isLineClosed(line, purchaseOrder),
    closedDay: isLineClosed(line, purchaseOrder) ? closedDayOf(line, purchaseOrder, timeZone) : null,
    receipts: events.map((entry) => ({ receivingDocumentId: entry.receivingDocumentId, day: entry.day, accepted: quantity(entry.accepted), rejected: quantity(entry.rejected) })),
  }
  if (!originalDay) return { ...base, status: events.length ? 'original_not_recorded' : 'not_received' }
  const cutoff = addDays(originalDay, graceDays)
  base.cutoffDay = cutoff
  const currentCutoff = addDays(currentDay, graceDays)
  if (!events.length) {
    // Not delivered and not due yet: nothing to judge.
    if (!asOfDay || asOfDay <= cutoff) return { ...base, status: 'not_received' }
    // Past the original promise plus the grace days with nothing received:
    // late and not OTIF, as the standard definition counts it. In full stays
    // pending while the line is open, as for a partial delivery. A line
    // closed since stopped being awaited on its closing day, so its delay runs
    // to that day; it never arrived, so it is late against the current date too.
    const stoppedDay = base.closed && base.closedDay && base.closedDay < asOfDay ? base.closedDay : asOfDay
    const currentOk = base.closed ? false : asOfDay <= currentCutoff
    return {
      ...base,
      status: 'evaluated',
      overdueUndelivered: true,
      onTime: false,
      early: false,
      daysLate: daysBetween(originalDay, stoppedDay),
      onTimeCurrent: currentOk,
      inFull: base.closed ? false : null,
      inFullPending: !base.closed,
      otif: false,
      otifCurrent: currentOk,
    }
  }
  const onTime = firstReceiptDay <= cutoff
  // In full is decided once the line is fully received or closed.
  const inFullPending = !fullDay && !base.closed
  return {
    ...base,
    status: 'evaluated',
    onTime,
    early: daysBetween(firstReceiptDay, originalDay) > earlyDays,
    daysLate: onTime ? 0 : daysBetween(originalDay, firstReceiptDay),
    onTimeCurrent: firstReceiptDay <= currentCutoff,
    inFull: inFullPending ? null : Boolean(fullDay),
    inFullPending,
    overdueUndelivered: false,
    // Not yet full but still inside the original promise plus the grace days:
    // OTIF is undecided, as in full is, and left out of its rate.
    otif: fullDay ? fullDay <= cutoff : asOfDay && asOfDay <= cutoff ? null : false,
    // Not yet due against the current date counts as OTIF against it.
    otifCurrent: fullDay ? fullDay <= currentCutoff : asOfDay <= currentCutoff,
  }
}

// A line called off before it was due is left out of its delivery: ordered at
// zero, or closed with nothing received. A line closed only after its promise
// plus the grace days was already late when it was closed, so it stays in, late
// and not in full. A closed line with no recorded closing day is left out.
function calledOff(line) {
  if (quantity(line.orderedQuantity) <= 0) return true
  if (!line.closed || line.firstReceiptDay) return false
  return !(line.closedDay && line.cutoffDay && line.closedDay > line.cutoffDay)
}

// Three-valued AND: false when any value is false, true when all are true,
// otherwise undecided (null).
const allOf = (values) => values.some((value) => value === false) ? false : values.every((value) => value === true) ? true : null
const latest = (days) => days.every(Boolean) && days.length ? [...days].sort().at(-1) : null

// Delivery obligations from evaluated lines (see evaluatePromiseLine): the
// lines of one PO with one original promised date. A delivery with a line not
// yet received and not yet due waits (status 'not_due'); the others are
// judged (status 'evaluated'). Lines without an original promise are not
// grouped.
export function groupDeliveryObligations(lines = []) {
  const groups = new Map()
  for (const line of lines) {
    if (!line.originalPromisedDate || calledOff(line)) continue
    const key = `${text(line.purchaseOrderId)}:${line.originalPromisedDate}`
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(line)
  }
  return [...groups].map(([obligationId, members]) => {
    const rows = [...members].sort((a, b) => text(a.purchaseOrderLineId).localeCompare(text(b.purchaseOrderLineId)))
    const waiting = rows.some((line) => line.status === 'not_received')
    const onTime = !waiting && rows.every((line) => line.onTime === true)
    const inFull = waiting ? null : allOf(rows.map((line) => line.inFull))
    return {
      obligationId,
      purchaseOrderId: rows[0].purchaseOrderId,
      originalPromisedDate: rows[0].originalPromisedDate,
      status: waiting ? 'not_due' : 'evaluated',
      lines: rows,
      onTime,
      onTimeCurrent: !waiting && rows.every((line) => line.onTimeCurrent === true),
      // The last line's first receipt was more than the early days ahead.
      early: !waiting && rows.every((line) => line.early === true),
      inFull,
      inFullPending: !waiting && inFull === null,
      otif: waiting ? null : allOf(rows.map((line) => line.otif)),
      otifCurrent: !waiting && rows.every((line) => line.otifCurrent === true),
      // From the promise to the last line's first receipt, or, for a line with
      // none, to today or the day it was closed.
      daysLate: onTime || waiting ? 0 : Math.max(0, ...rows.map((line) => line.daysLate || 0)),
      overdueUndelivered: rows.some((line) => line.overdueUndelivered === true),
      revised: rows.some((line) => line.revised),
      lastFirstReceiptDay: latest(rows.map((line) => line.firstReceiptDay)),
      fullDay: latest(rows.map((line) => line.fullDay)),
    }
  }).sort((a, b) => text(a.originalPromisedDate).localeCompare(text(b.originalPromisedDate)) || a.obligationId.localeCompare(b.obligationId))
}

// count of deliveries with the flag set, over the deliveries where it is decided.
function sampleRate(obligations, flag, { minimumSample = SUPPLIER_SCORECARD_RULES.minimumSample, decided = () => true } = {}) {
  const pool = obligations.filter(decided)
  const count = pool.filter((obligation) => obligation[flag] === true).length
  const sufficient = pool.length >= minimumSample
  return { count, of: pool.length, rate: sufficient ? rate(count, pool.length) : null, interval: sufficient ? wilsonInterval(count, pool.length) : null }
}

function hasPriceVariance(invoice) {
  if (text(invoice.metadata?.varianceType) === 'price_variance') return true
  if ((invoice.lines || []).some((line) => text(line.metadata?.varianceType) === 'price_variance')) return true
  return (invoice.matchRuns || []).some((run) => (run.exceptions || []).some((exception) => text(exception.exceptionType) === 'price'))
}

const byCurrency = (rows) => {
  const totals = new Map()
  for (const { currency, amount } of rows) {
    if (amount === null || amount === undefined) continue
    const code = text(currency) || null
    totals.set(code, (totals.get(code) || 0) + amount)
  }
  return [...totals.entries()].sort(([a], [b]) => text(a).localeCompare(text(b))).map(([currency, amount]) => ({ currency, amount: round(amount, 2) }))
}

// The figures for one supplier from its lines (see evaluatePromiseLine: those
// judged, and those not received and not yet due, which hold their delivery
// back) and its price-variance invoices (null when hidden). Lines are grouped
// into deliveries (groupDeliveryObligations); the rates count deliveries.
export function summarizeScorecardLines({ lines = [], invoices = [], lineAmounts = true, invoiceAmounts = true }) {
  const { minimumSample } = SUPPLIER_SCORECARD_RULES
  const obligations = groupDeliveryObligations(lines)
  const sample = obligations.filter((obligation) => obligation.status === 'evaluated')
  const sampleLines = sample.flatMap((obligation) => obligation.lines)
  const sufficient = sample.length >= minimumSample
  const late = sample.filter((obligation) => !obligation.onTime)
  const units = [...new Set(sampleLines.map((line) => line.unit || ''))]
  const skus = [...new Set(sampleLines.map((line) => text(line.sku)))]
  const receivedQuantity = sampleLines.reduce((sum, line) => sum + quantity(line.receivedQuantity), 0)
  const rejectedQuantity = sampleLines.reduce((sum, line) => sum + quantity(line.rejectedQuantity), 0)
  // Quantities of different SKUs, or in different units, cannot be added into
  // one rate or one total.
  const mixedUnits = units.length > 1
  const multipleSkus = skus.length > 1
  const addable = !mixedUnits && !multipleSkus
  const wholeUnits = Number.isInteger(receivedQuantity) && Number.isInteger(rejectedQuantity)
  const rejectionRate = sufficient && addable ? rate(rejectedQuantity, receivedQuantity) : null
  const variances = invoices === null ? null : [...invoices].sort((a, b) => text(a.invoiceDate).localeCompare(text(b.invoiceDate)) || text(a.supplierInvoiceId).localeCompare(text(b.supplierInvoiceId)))
  const pending = sample.filter((obligation) => obligation.inFullPending)
  const overdue = sample.filter((obligation) => obligation.overdueUndelivered)
  return {
    sampleSize: sample.length,
    lineCount: sampleLines.length,
    sampleStatus: !sample.length ? 'no_obligations' : sufficient ? 'ok' : 'insufficient_sample',
    // Deliveries in the period with a line not received and not yet due: not
    // judged yet, so outside every figure.
    waitingCount: obligations.length - sample.length,
    // Lines whose promised date was revised after issue.
    revisedCount: sampleLines.filter((line) => line.revised).length,
    // Deliveries with a line still open with a shortfall: in the sample, not
    // yet in the in-full rate.
    inFullPendingCount: pending.length,
    pendingObligations: pending,
    // Deliveries past their promise plus the grace days with a line not received.
    overdueUndeliveredCount: overdue.length,
    metrics: {
      onTime: sampleRate(sample, 'onTime'),
      onTimeCurrent: sampleRate(sample, 'onTimeCurrent'),
      early: sampleRate(sample, 'early'),
      inFull: sampleRate(sample, 'inFull', { decided: (obligation) => !obligation.inFullPending }),
      otif: sampleRate(sample, 'otif', { decided: (obligation) => obligation.otif !== null }),
      otifCurrent: sampleRate(sample, 'otifCurrent'),
      rejection: {
        rejectedQuantity: addable ? round(rejectedQuantity) : null,
        receivedQuantity: addable ? round(receivedQuantity) : null,
        unit: addable ? units[0] || null : null,
        mixedUnits,
        multipleSkus,
        rate: rejectionRate,
        // Each unit counts as one trial, so the interval is narrower than the
        // real uncertainty when rejections come in batches.
        interval: rejectionRate === null || !wholeUnits ? null : wilsonInterval(rejectedQuantity, receivedQuantity),
      },
      averageDelayDays: { value: late.length ? round(late.reduce((sum, obligation) => sum + obligation.daysLate, 0) / late.length, 1) : null, lateCount: late.length },
      priceVariances: variances === null
        ? { count: null, visible: false, amounts: [] }
        : { count: variances.length, visible: true, amounts: invoiceAmounts ? byCurrency(variances.map((row) => ({ currency: row.currency, amount: row.varianceAmount }))) : [] },
    },
    orderedValue: lineAmounts ? byCurrency(sampleLines.map((line) => ({ currency: line.currency, amount: line.amount }))) : [],
    obligations: sample,
    lines: sampleLines,
    invoices: variances || [],
  }
}

// Builds the scorecard from rows already read for one tenant.
//   purchaseOrders  with lines
//   receipts        posted receiving documents with lines
//   invoices        supplier invoices with lines and matchRuns.exceptions, or
//                   null when the reader may not see invoices
//   visibility      { lineAmounts, invoiceAmounts }
export function buildSupplierScorecard({
  purchaseOrders = [],
  receipts = [],
  invoices = null,
  suppliers = [],
  period,
  asOfDay,
  timeZone = 'America/New_York',
  graceDays = SUPPLIER_SCORECARD_RULES.graceDays,
  supplierId = null,
  visibility = { lineAmounts: true, invoiceAmounts: true },
  generatedAt = new Date().toISOString(),
  limitations = [],
}) {
  const { earlyDays, minimumSample, promiseBasis } = SUPPLIER_SCORECARD_RULES
  const inPeriod = (day) => Boolean(day) && day >= period.from && day <= period.to
  const receiptLines = new Map()
  for (const document of receipts) {
    const day = localDay(document.arrivedAt || document.postedAt, timeZone)
    for (const line of document.lines || []) {
      if (!line.purchaseOrderLineId) continue
      if (!receiptLines.has(line.purchaseOrderLineId)) receiptLines.set(line.purchaseOrderLineId, [])
      receiptLines.get(line.purchaseOrderLineId).push({ receivingDocumentId: document.id, day, accepted: line.acceptedQty, rejected: line.rejectedQty })
    }
  }
  const names = new Map(suppliers.map((row) => [row.id, text(row.name)]))
  const bySupplier = new Map()
  const entry = (id, name) => {
    if (!bySupplier.has(id)) bySupplier.set(id, { supplierId: id, supplierName: names.get(id) || text(name) || id, lines: [], notRecorded: [], invoices: [] })
    return bySupplier.get(id)
  }
  if (supplierId) entry(supplierId)
  // Lines not received and not yet due hold their delivery back. They do not
  // put a supplier on the scorecard by themselves.
  const notDue = new Map()
  for (const purchaseOrder of purchaseOrders) {
    const id = text(purchaseOrder.supplierId)
    if (!id || (supplierId && id !== supplierId) || !isPromiseMeasuredPurchaseOrder(purchaseOrder)) continue
    for (const line of purchaseOrder.lines || []) {
      const evaluated = evaluatePromiseLine({ line, purchaseOrder, receipts: receiptLines.get(line.id) || [], asOfDay, graceDays, earlyDays, timeZone })
      const withMoney = { ...evaluated, currency: text(purchaseOrder.currency) || null, amount: visibility.lineAmounts ? round(quantity(line.amount), 2) : null }
      if (evaluated.status === 'evaluated' && inPeriod(evaluated.originalPromisedDate)) entry(id, purchaseOrder.supplierName).lines.push(withMoney)
      else if (evaluated.status === 'not_received' && inPeriod(evaluated.originalPromisedDate)) notDue.set(id, [...(notDue.get(id) || []), withMoney])
      else if (evaluated.status === 'original_not_recorded' && inPeriod(evaluated.currentPromisedDate)) entry(id, purchaseOrder.supplierName).notRecorded.push(withMoney)
    }
  }
  for (const invoice of invoices || []) {
    const id = text(invoice.supplierId)
    if (!id || (supplierId && id !== supplierId) || COMMITTED_INVOICE_STATUSES_EXCLUDED.includes(text(invoice.status))) continue
    const day = localDay(invoice.invoiceDate || invoice.submittedAt || invoice.createdAt, timeZone)
    if (!inPeriod(day) || !hasPriceVariance(invoice)) continue
    entry(id, invoice.supplierName).invoices.push({
      supplierInvoiceId: invoice.id,
      invoiceNumber: text(invoice.invoiceNumber) || invoice.id,
      invoiceDate: day,
      purchaseOrderId: text(invoice.relatedPoId) || null,
      currency: text(invoice.currency) || null,
      varianceAmount: visibility.invoiceAmounts && invoice.varianceAmount !== null && invoice.varianceAmount !== undefined ? round(quantity(invoice.varianceAmount), 2) : null,
    })
  }

  const rows = [...bySupplier.values()].map((supplier) => ({
    supplierId: supplier.supplierId,
    supplierName: supplier.supplierName,
    ...summarizeScorecardLines({ lines: [...supplier.lines, ...(notDue.get(supplier.supplierId) || [])], invoices: invoices === null ? null : supplier.invoices, lineAmounts: visibility.lineAmounts, invoiceAmounts: visibility.invoiceAmounts }),
    originalNotRecordedCount: supplier.notRecorded.length,
    originalNotRecordedLines: supplier.notRecorded,
  })).sort((a, b) => b.sampleSize - a.sampleSize || a.supplierName.localeCompare(b.supplierName))

  return {
    version: SUPPLIER_SCORECARD_VERSION,
    generatedAt,
    asOf: asOfDay,
    timeZone,
    period,
    rules: { graceDays, earlyDays, minimumSample, promiseBasis },
    fieldVisibility: { lineAmounts: Boolean(visibility.lineAmounts), invoices: invoices !== null, invoiceAmounts: invoices !== null && Boolean(visibility.invoiceAmounts) },
    limitations,
    suppliers: rows,
  }
}

const isDay = (value) => /^\d{4}-\d{2}-\d{2}$/.test(value) && promiseDay(value) === value

// Period and grace days from query parameters; the period defaults to the 90
// days ending today in the workspace timezone.
export function scorecardParameters(query = {}, asOfDay) {
  const { periodDays, maxPeriodDays, maxGraceDays } = SUPPLIER_SCORECARD_RULES
  const to = text(query.to) || asOfDay
  const from = text(query.from) || addDays(to, -(periodDays - 1))
  if (!isDay(from) || !isDay(to)) throw new SupplierScorecardError('SCORECARD_PERIOD_INVALID', 'Enter the period as calendar dates (YYYY-MM-DD).', 422, [{ field: isDay(from) ? 'to' : 'from' }])
  if (from > to) throw new SupplierScorecardError('SCORECARD_PERIOD_INVALID', 'The period must start on or before its end.', 422, [{ field: 'from' }])
  if (daysBetween(from, to) + 1 > maxPeriodDays) throw new SupplierScorecardError('SCORECARD_PERIOD_TOO_LONG', `The period can cover at most ${maxPeriodDays} days.`, 422, [{ field: 'from', maxDays: maxPeriodDays }])
  const graceText = text(query.graceDays)
  const graceDays = graceText === '' ? SUPPLIER_SCORECARD_RULES.graceDays : Number(graceText)
  if (!Number.isInteger(graceDays) || graceDays < 0 || graceDays > maxGraceDays) throw new SupplierScorecardError('SCORECARD_GRACE_DAYS_INVALID', `Grace days must be a whole number from 0 to ${maxGraceDays}.`, 422, [{ field: 'graceDays', maxDays: maxGraceDays }])
  return { period: { from, to }, graceDays, supplierId: text(query.supplierId) || null }
}

export function createSupplierScorecardReadService({ prisma, now = () => new Date() } = {}) {
  if (!prisma) throw new Error('prisma is required')
  return {
    async read(query = {}, context = {}) {
      const actor = context.actor || await resolveProvisionedActor(prisma, context.identity || context)
      const tenantId = actor.tenantId
      for (const permission of SUPPLIER_SCORECARD_READ_PERMISSIONS) assertAuthorized({ actor, permission, tenantId })
      const tenant = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { timezone: true } })
      const timeZone = text(tenant?.timezone) || 'America/New_York'
      const instant = now()
      const asOfDay = localDay(instant, timeZone)
      const { period, graceDays, supplierId } = scorecardParameters(query, asOfDay)
      const allowed = (permission) => can({ actor, permission, tenantId })
      const supplierWhere = supplierId ? { supplierId } : { supplierId: { not: null } }
      const purchaseOrders = await prisma.purchaseOrder.findMany({ where: { tenantId, ...supplierWhere, status: { notIn: PROMISE_UNMEASURED_PO_STATUSES } }, include: { lines: true }, orderBy: [{ id: 'asc' }] })
      // Receipts outside the reader's warehouses are left out, as elsewhere.
      const warehouseFilter = actor.allWarehouses ? {} : { OR: [{ warehouseId: null }, { warehouseId: { in: [...(actor.readWarehouseIds || [])] } }] }
      const receipts = purchaseOrders.length
        ? await prisma.receivingDocument.findMany({ where: { tenantId, poId: { in: purchaseOrders.map((row) => row.id) }, postingStatus: 'posted', ...warehouseFilter }, include: { lines: true }, orderBy: [{ id: 'asc' }] })
        : []
      const invoices = allowed('finance.supplier_invoice.read')
        ? await prisma.supplierInvoice.findMany({ where: { tenantId, ...supplierWhere }, include: { lines: true, matchRuns: { include: { exceptions: true } } }, orderBy: [{ id: 'asc' }] })
        : null
      const suppliers = await prisma.supplier.findMany({ where: { tenantId, ...(supplierId ? { id: supplierId } : {}) }, select: { id: true, name: true } })
      if (supplierId && !suppliers.length && !purchaseOrders.length) throw new SupplierScorecardError('SUPPLIER_NOT_FOUND', 'Supplier was not found.', 404)
      const limitations = []
      if (invoices === null) limitations.push('price_variances_hidden_by_permission')
      if (!actor.allWarehouses) limitations.push('receipts_limited_to_your_warehouses')
      return buildSupplierScorecard({
        purchaseOrders, receipts, invoices, suppliers, period, asOfDay, timeZone, graceDays, supplierId,
        visibility: { lineAmounts: allowed('procurement.prices.read'), invoiceAmounts: allowed('finance.amounts.read') },
        generatedAt: instant.toISOString(),
        limitations,
      })
    },
  }
}
