import { assertAuthorized, can } from '../auth/authorization-service.mjs'
import { resolveProvisionedActor } from './pilot-identity.mjs'
import { currentPromisedDay, promiseDay } from './purchase-order-promise-dates.mjs'

// Supplier scorecard: delivery statistics per supplier, measured against the
// date each PO line was ORIGINALLY promised. The current expected date moves
// with the shipment; an on-time rate computed against it is only an upper
// bound, so the scorecard shows both and names the gap.
//
// Business rules (docs/business rules, section 8), per supplier and period:
//   unit            a PO line whose original promised date falls in the period
//                   and that has at least one posted receipt
//   sample          fewer than 5 lines: "insufficient sample", no percentages
//   on time         the receipt that first covers the ordered quantity
//                   (accepted + rejected) arrived on or before the original
//                   promised date + grace days (default 0). A line not yet
//                   covered is late once that cutoff has passed, and not yet
//                   decided (left out of the sample) before it.
//   early           covered more than 3 days before the original promise;
//                   counted as on time, reported apart
//   in full         accepted quantity received by the original promised date
//                   >= ordered quantity
//   OTIF            on time and in full
//   rejection rate  rejected quantity / received quantity (accepted +
//                   rejected), over the sample lines
//   average delay   mean days late (arrival day - original promised day) over
//                   the late lines
//   price variances supplier invoices dated in the period with a price
//                   variance
// "On time vs current date" repeats the on-time test against each line's
// current expected date; a line not yet due against it counts as not late.
// Rates carry Wilson 95% intervals. Days are calendar days in the workspace
// timezone. Every figure lists the lines or invoices behind it. Money stays in
// its document currency and is never added across currencies.

export const SUPPLIER_SCORECARD_VERSION = 'supplier-scorecard-v1'
export const SUPPLIER_SCORECARD_RULES = Object.freeze({ graceDays: 0, earlyDays: 3, minimumSample: 5, periodDays: 90, maxPeriodDays: 731, maxGraceDays: 30 })
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

// Whether a line met a promise day. coverDay is the arrival day of the receipt
// that first covered the ordered quantity, or null when none has yet.
function deliveryAgainst(promise, { coverDay, asOfDay, graceDays, earlyDays }) {
  const cutoff = addDays(promise, graceDays)
  if (coverDay) {
    const onTime = coverDay <= cutoff
    return { decided: true, onTime, early: daysBetween(coverDay, promise) > earlyDays, daysLate: onTime ? 0 : daysBetween(promise, coverDay), open: false }
  }
  if (asOfDay > cutoff) return { decided: true, onTime: false, early: false, daysLate: daysBetween(promise, asOfDay), open: true }
  return { decided: false, onTime: null, early: false, daysLate: 0, open: true }
}

// One PO line against its original promise and its current date. receipts are
// the line's posted receipt lines: { receivingDocumentId, day, accepted, rejected }.
export function evaluatePromiseLine({ line, purchaseOrder, receipts = [], asOfDay, graceDays = SUPPLIER_SCORECARD_RULES.graceDays, earlyDays = SUPPLIER_SCORECARD_RULES.earlyDays }) {
  const originalDay = promiseDay(line.originalPromisedDate)
  const currentDay = currentPromisedDay(line, purchaseOrder) || originalDay
  const events = [...receipts].filter((entry) => entry.day).sort((a, b) => a.day.localeCompare(b.day) || text(a.receivingDocumentId).localeCompare(text(b.receivingDocumentId)))
  const ordered = quantity(line.orderedQuantity)
  let delivered = 0
  let coverDay = null
  for (const entry of events) {
    delivered += quantity(entry.accepted) + quantity(entry.rejected)
    if (!coverDay && ordered > 0 && delivered >= ordered) coverDay = entry.day
  }
  const receivedQuantity = events.reduce((sum, entry) => sum + quantity(entry.accepted) + quantity(entry.rejected), 0)
  const rejectedQuantity = events.reduce((sum, entry) => sum + quantity(entry.rejected), 0)
  const base = {
    purchaseOrderId: purchaseOrder.id,
    purchaseOrderLineId: line.id,
    sku: text(line.sku),
    itemName: text(line.itemName),
    unit: text(line.unit),
    orderedQuantity: ordered,
    receivedQuantity,
    rejectedQuantity,
    originalPromisedDate: originalDay,
    currentPromisedDate: currentDay,
    revised: Boolean(originalDay && currentDay && originalDay !== currentDay),
    firstReceiptDay: events[0]?.day || null,
    coverDay,
    receipts: events.map((entry) => ({ receivingDocumentId: entry.receivingDocumentId, day: entry.day, accepted: quantity(entry.accepted), rejected: quantity(entry.rejected) })),
  }
  if (!originalDay) return { ...base, status: events.length ? 'original_not_recorded' : 'not_received' }
  if (!events.length) return { ...base, status: 'not_received' }
  const options = { coverDay, asOfDay, graceDays, earlyDays }
  const original = deliveryAgainst(originalDay, options)
  if (!original.decided) return { ...base, status: 'pending' }
  const current = deliveryAgainst(currentDay, options)
  const acceptedByPromise = events.filter((entry) => entry.day <= originalDay).reduce((sum, entry) => sum + quantity(entry.accepted), 0)
  const inFull = ordered > 0 && acceptedByPromise >= ordered
  return {
    ...base,
    status: 'evaluated',
    onTime: original.onTime,
    early: original.early,
    daysLate: original.daysLate,
    stillOpen: original.open,
    // Not yet due against the current date counts as not late.
    onTimeCurrent: current.decided ? current.onTime : true,
    daysLateCurrent: current.decided ? current.daysLate : 0,
    acceptedByPromise,
    inFull,
    otif: original.onTime && inFull,
  }
}

function lineRate(lines, flag, sufficient) {
  const count = lines.filter((line) => line[flag]).length
  return { count, of: lines.length, rate: sufficient ? rate(count, lines.length) : null, interval: sufficient ? wilsonInterval(count, lines.length) : null }
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

// The figures for one supplier from its evaluated sample lines (see
// evaluatePromiseLine) and its price-variance invoices (null when hidden).
export function summarizeScorecardLines({ lines = [], invoices = [], lineAmounts = true, invoiceAmounts = true }) {
  const { minimumSample } = SUPPLIER_SCORECARD_RULES
  const sample = [...lines].sort((a, b) => text(a.originalPromisedDate).localeCompare(text(b.originalPromisedDate)) || text(a.purchaseOrderLineId).localeCompare(text(b.purchaseOrderLineId)))
  const sufficient = sample.length >= minimumSample
  const late = sample.filter((line) => !line.onTime)
  const units = [...new Set(sample.map((line) => line.unit || ''))]
  const receivedQuantity = sample.reduce((sum, line) => sum + quantity(line.receivedQuantity), 0)
  const rejectedQuantity = sample.reduce((sum, line) => sum + quantity(line.rejectedQuantity), 0)
  // Quantities in different units cannot be added into one rate.
  const mixedUnits = units.length > 1
  const wholeUnits = Number.isInteger(receivedQuantity) && Number.isInteger(rejectedQuantity)
  const rejectionRate = sufficient && !mixedUnits ? rate(rejectedQuantity, receivedQuantity) : null
  const variances = invoices === null ? null : [...invoices].sort((a, b) => text(a.invoiceDate).localeCompare(text(b.invoiceDate)) || text(a.supplierInvoiceId).localeCompare(text(b.supplierInvoiceId)))
  return {
    sampleSize: sample.length,
    sampleStatus: !sample.length ? 'no_lines' : sufficient ? 'ok' : 'insufficient_sample',
    revisedCount: sample.filter((line) => line.revised).length,
    metrics: {
      onTime: lineRate(sample, 'onTime', sufficient),
      onTimeCurrent: lineRate(sample, 'onTimeCurrent', sufficient),
      early: lineRate(sample, 'early', sufficient),
      inFull: lineRate(sample, 'inFull', sufficient),
      otif: lineRate(sample, 'otif', sufficient),
      rejection: {
        rejectedQuantity: round(rejectedQuantity),
        receivedQuantity: round(receivedQuantity),
        unit: mixedUnits ? null : units[0] || null,
        mixedUnits,
        rate: rejectionRate,
        // Each unit counts as one trial, so the interval is narrower than the
        // real uncertainty when rejections come in batches.
        interval: rejectionRate === null || !wholeUnits ? null : wilsonInterval(rejectedQuantity, receivedQuantity),
      },
      averageDelayDays: { value: late.length ? round(late.reduce((sum, line) => sum + line.daysLate, 0) / late.length, 1) : null, lateCount: late.length },
      priceVariances: variances === null
        ? { count: null, visible: false, amounts: [] }
        : { count: variances.length, visible: true, amounts: invoiceAmounts ? byCurrency(variances.map((row) => ({ currency: row.currency, amount: row.varianceAmount }))) : [] },
    },
    orderedValue: lineAmounts ? byCurrency(sample.map((line) => ({ currency: line.currency, amount: line.amount }))) : [],
    lines: sample,
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
  const { earlyDays, minimumSample } = SUPPLIER_SCORECARD_RULES
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
    if (!bySupplier.has(id)) bySupplier.set(id, { supplierId: id, supplierName: names.get(id) || text(name) || id, lines: [], pending: [], notRecorded: [], invoices: [] })
    return bySupplier.get(id)
  }
  if (supplierId) entry(supplierId)
  for (const purchaseOrder of purchaseOrders) {
    const id = text(purchaseOrder.supplierId)
    if (!id || (supplierId && id !== supplierId)) continue
    for (const line of purchaseOrder.lines || []) {
      const evaluated = evaluatePromiseLine({ line, purchaseOrder, receipts: receiptLines.get(line.id) || [], asOfDay, graceDays, earlyDays })
      const withMoney = { ...evaluated, currency: text(purchaseOrder.currency) || null, amount: visibility.lineAmounts ? round(quantity(line.amount), 2) : null }
      if (evaluated.status === 'evaluated' && inPeriod(evaluated.originalPromisedDate)) entry(id, purchaseOrder.supplierName).lines.push(withMoney)
      else if (evaluated.status === 'pending' && inPeriod(evaluated.originalPromisedDate)) entry(id, purchaseOrder.supplierName).pending.push(withMoney)
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
    ...summarizeScorecardLines({ lines: supplier.lines, invoices: invoices === null ? null : supplier.invoices, lineAmounts: visibility.lineAmounts, invoiceAmounts: visibility.invoiceAmounts }),
    pendingCount: supplier.pending.length,
    originalNotRecordedCount: supplier.notRecorded.length,
    pendingLines: supplier.pending,
    originalNotRecordedLines: supplier.notRecorded,
  })).sort((a, b) => b.sampleSize - a.sampleSize || a.supplierName.localeCompare(b.supplierName))

  return {
    version: SUPPLIER_SCORECARD_VERSION,
    generatedAt,
    asOf: asOfDay,
    timeZone,
    period,
    rules: { graceDays, earlyDays, minimumSample },
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
  if (daysBetween(from, to) + 1 > maxPeriodDays) throw new SupplierScorecardError('SCORECARD_PERIOD_TOO_LONG', `The period can cover at most ${maxPeriodDays} days.`, 422, [{ field: 'from' }])
  const graceText = text(query.graceDays)
  const graceDays = graceText === '' ? SUPPLIER_SCORECARD_RULES.graceDays : Number(graceText)
  if (!Number.isInteger(graceDays) || graceDays < 0 || graceDays > maxGraceDays) throw new SupplierScorecardError('SCORECARD_GRACE_DAYS_INVALID', `Grace days must be a whole number from 0 to ${maxGraceDays}.`, 422, [{ field: 'graceDays' }])
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
      const purchaseOrders = await prisma.purchaseOrder.findMany({ where: { tenantId, ...supplierWhere, status: { notIn: ['draft', 'pending_approval', 'rejected'] } }, include: { lines: true }, orderBy: [{ id: 'asc' }] })
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
