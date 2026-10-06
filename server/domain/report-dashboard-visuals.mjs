import { isCommittedPurchaseOrder, isOpenPurchaseOrder, purchaseOrderBusinessDate, reportCalendarDay } from './open-purchase-order.mjs'
import { purchaseOrderDueDay } from './open-purchase-orders-report.mjs'
import { ALL_PURCHASE_ORDERS } from './business-overview.mjs'
import { RECEIPT_HOLDING_SUPPLIER_INVOICE_STATUSES } from './procurement-status-authority.mjs'
import { reportCurrencyCode } from './report-currency.mjs'
import { SUPPLIER_SCORECARD_RULES, evaluatePromiseLine, scorecardPurchaseOrderStanding, summarizeScorecardLines } from './supplier-scorecard.mjs'
import { instantCalendarDay } from './tenant-calendar-day.mjs'

// The analytics visuals of each report dashboard. Every visual aggregates the
// whole filtered scope, not the detail page, and reads only recorded values:
//   - a missing amount, quantity or date is left out and the visual says so; it
//     is never counted as zero;
//   - amounts are added only within one currency (the currency filter, or the
//     single currency every row is in). Otherwise a visual counts documents, or
//     asks for a currency, and names the limitation;
//   - quantities are added only within one SKU and unit, because SKUs use
//     different units;
//   - a stored instant (creation or arrival time) counts on its calendar day in
//     the workspace timezone; date-only values (expected, promised and invoice
//     dates) are read as the day they hold.
// Titles, stage names and measure names are English interface copy that the
// dashboard translates; supplier, customer and SKU names are business values
// and stay as recorded.

const array = value => Array.isArray(value) ? value : []
const text = value => String(value ?? '').trim()
const known = value => value === null || value === undefined || value === '' || !Number.isFinite(Number(value)) ? null : Number(value)
const money = value => Math.round(value * 100) / 100
const share = (part, whole) => whole ? Math.round(part / whole * 1000) / 10 : null
const monthOf = day => day ? day.slice(0, 7) : 'Undated'
const inRange = (day, query) => (!query.from || Boolean(day && day >= query.from)) && (!query.to || Boolean(day && day <= query.to))
const sumKnown = values => values.some(value => value === null) ? null : money(values.reduce((total, value) => total + value, 0))
const byValue = (a, b) => b.value - a.value || String(a.name).localeCompare(String(b.name))
const submittedInvoiceStatuses = new Set(RECEIPT_HOLDING_SUPPLIER_INVOICE_STATUSES)
const inactiveSalesStatuses = new Set(['draft', 'cancelled', 'canceled'])
const voidReceiptStatuses = new Set(['draft', 'cancelled', 'canceled', 'void', 'voided'])
const OTHER_SUPPLIERS = 'Other suppliers'
const OTHER_CUSTOMERS = 'Other customers'

const poSupplier = row => text(row?.supplierSnapshot?.supplierName || row?.supplierName || row?.supplierId)
const invoiceSupplier = row => text(row?.supplierName || row?.supplierId)

// The three-way match engine records matched or exception on the invoice;
// older records call an exception a variance. An invoice the engine has not
// decided yet is awaiting match.
export function invoiceMatchOutcome(invoice) {
  const match = text(invoice?.matchStatus).toLowerCase()
  const status = text(invoice?.status).toLowerCase()
  if (match === 'matched' || (!match && ['matched', 'approved'].includes(status))) return 'matched'
  if (['exception', 'variance'].includes(match) || (!match && status === 'exception')) return 'exception'
  return 'pending'
}

const MATCH_OUTCOME_LABELS = { matched: 'Matched', exception: 'Match exception', pending: 'Awaiting match' }

// A reader who cannot see the amounts gets counts, as for mixed currencies.
const RESTRICTED_SCOPE = Object.freeze({ ok: false, currencyCode: null, limitation: 'amount_restricted' })
const RESTRICTED_EMPTY = 'Your role cannot view amounts.'
const noAmountsState = scope => scope.limitation === 'amount_restricted' ? RESTRICTED_EMPTY : 'Select a currency to compare amounts.'

// Amounts can be totalled within one currency only.
function moneyScope(rows, query) {
  if (query.currency) return { ok: true, currencyCode: query.currency, limitation: null }
  if (!rows.length) return { ok: false, currencyCode: null, limitation: null }
  const codes = new Set(rows.map(row => row.currency))
  if (codes.has('')) return { ok: false, currencyCode: null, limitation: 'currency_missing_or_invalid' }
  if (codes.size > 1) return { ok: false, currencyCode: null, limitation: 'multi_currency_unconverted' }
  return { ok: true, currencyCode: [...codes][0], limitation: null }
}

function visual(id, title, type, data, extra = {}) {
  const unit = extra.unit || 'number'
  return { id, title, type, data, categoryKey: 'name', valueKey: 'value', legend: true, tooltip: true, crossFilter: null, emptyState: 'No records in the selected range.', limitations: [], ...extra, unit, valueFormat: extra.valueFormat || unit }
}

const moneyLimitations = (scope, rows) => [...(scope.limitation ? [scope.limitation] : []), ...(scope.ok && rows.some(row => row.amount === null) ? ['amount_missing'] : [])]

// Counts (and amounts, when they can be totalled) per business month. Records
// without a business date are grouped as Undated, after the dated months.
function monthly(rows, scope, { countKey, amountKey }) {
  const months = new Map()
  for (const row of rows) {
    const key = monthOf(row.date)
    if (!months.has(key)) months.set(key, { name: key, ...(scope.ok ? { [amountKey]: 0 } : {}), [countKey]: 0 })
    const entry = months.get(key)
    entry[countKey] += 1
    if (scope.ok && row.amount !== null) entry[amountKey] = money(entry[amountKey] + row.amount)
  }
  return [...months.values()].sort((a, b) => (a.name === 'Undated') - (b.name === 'Undated') || a.name.localeCompare(b.name))
}

function trendVisual(id, title, rows, scope, { countKey, amountKey, drilldownPath, description }) {
  const measures = [...(scope.ok ? [{ key: amountKey, kind: 'bar', unit: 'currency', axis: 0 }] : []), { key: countKey, kind: scope.ok ? 'line' : 'bar', unit: 'number', axis: scope.ok ? 1 : 0 }]
  return visual(id, title, 'combo', monthly(rows, scope, { countKey, amountKey }), { measures, seriesKeys: measures.map(item => item.key), unit: scope.ok ? 'currency' : 'number', currencyCode: scope.currencyCode, drilldownPath, crossFilter: 'period', description, limitations: moneyLimitations(scope, rows) })
}

function grouped(rows, keyOf, valueOf) {
  const groups = new Map()
  for (const row of rows) {
    const name = keyOf(row) || 'Unspecified'
    const value = valueOf(row)
    if (value === null) continue
    groups.set(name, (groups.get(name) || 0) + value)
  }
  return [...groups].map(([name, value]) => ({ name, value: money(value), filterValue: name === 'Unspecified' ? '' : name })).sort(byValue)
}

// Sorted contributions with the running share of the total, the first
// 12 named and the rest folded into one bar. A, B and C classes follow the
// 80% and 95% cumulative-share thresholds.
function paretoRows(groups, otherLabel) {
  const total = groups.reduce((sum, row) => sum + row.value, 0)
  const top = groups.slice(0, 12)
  const rest = groups.slice(12).reduce((sum, row) => sum + row.value, 0)
  const rows = rest > 0 ? [...top, { name: otherLabel, value: money(rest), filterValue: '' }] : top
  let running = 0
  return rows.map(row => {
    running += row.value
    return { ...row, 'Cumulative share': share(running, total) }
  })
}

function paretoVisual(id, title, rows, scope, keyOf, { otherLabel, drilldownPath, crossFilter, countLabel }) {
  const values = scope.ok ? grouped(rows, keyOf, row => row.amount) : grouped(rows, keyOf, () => 1)
  return visual(id, title, 'pareto', paretoRows(values, otherLabel), { unit: scope.ok ? 'currency' : 'number', currencyCode: scope.currencyCode, measures: [{ key: 'value', kind: 'bar', unit: scope.ok ? 'currency' : 'number', axis: 0, label: scope.ok ? 'Committed amount' : countLabel }, { key: 'Cumulative share', kind: 'line', unit: 'percentage', axis: 1 }], drilldownPath, crossFilter, description: scope.ok ? 'Sorted by amount. The line is the running share of the total; A, B and C classes split at 80% and 95%.' : 'Amounts need one currency, so documents are counted. The line is the running share of the total.', limitations: moneyLimitations(scope, rows) })
}

function statusVisual(id, title, rows, drilldownPath, description) {
  const counts = grouped(rows, row => row.status, () => 1)
  return visual(id, title, 'donut', counts, { drilldownPath, crossFilter: 'status', ...(description ? { description } : {}) })
}

// Committed purchase orders in scope, with their receipt and invoice progress.
function purchaseOrderFacts(context, all, receiptsByPo, invoicesByPo, timeZone) {
  const inScope = new Set(all.purchase_orders.map(row => row.id))
  return array(context.purchaseOrders).filter(row => inScope.has(text(row.id || row.po)) && isCommittedPurchaseOrder(row)).map(row => {
    const id = text(row.id || row.po)
    const lines = array(row.lines).map(line => {
      const ordered = known(line.orderedQuantity ?? line.quantity)
      const received = known(line.receivedQuantity)
      const unitPrice = known(line.unitPrice)
      const amount = known(line.amount) ?? (ordered !== null && unitPrice !== null ? ordered * unitPrice : null)
      return { item: text(line.itemName || line.itemNameSnapshot || line.sku), ordered, received, unitPrice, amount, receivedValue: received !== null && unitPrice !== null ? received * unitPrice : null }
    })
    const amount = known(row.totalAmount ?? row.amount)
    const invoices = invoicesByPo.get(id) || []
    const fullyReceived = !isOpenPurchaseOrder(row)
    return {
      id, supplier: poSupplier(row), date: purchaseOrderBusinessDate(row, timeZone), amount, currency: reportCurrencyCode(row.currency || row.lines?.[0]?.currency),
      due: purchaseOrderDueDay(row), open: !fullyReceived, lines,
      receivingStarted: fullyReceived || lines.some(line => line.received > 0) || receiptsByPo.has(id),
      fullyReceived, invoiced: invoices.length > 0,
      matched: invoices.length > 0 && invoices.every(invoice => invoiceMatchOutcome(invoice) === 'matched'),
      orderedValue: lines.length ? sumKnown(lines.map(line => line.amount)) : amount,
      receivedValue: lines.length ? sumKnown(lines.map(line => line.receivedValue)) : null,
      invoicedValue: sumKnown(invoices.map(invoice => {
        const invoiceLines = array(invoice.lines)
        return invoiceLines.length ? sumKnown(invoiceLines.map(line => known(line.amount))) : known(invoice.amount ?? invoice.totalAmount)
      })),
    }
  })
}

// Each stage counts the orders that reached it and every stage before it, so
// the stages narrow like a funnel.
function lifecycleVisual(id, pos) {
  const stages = [
    ['Committed', () => true],
    ['Receiving started', po => po.receivingStarted],
    ['Fully received', po => po.fullyReceived],
    ['Invoiced', po => po.invoiced],
    ['Invoice matched', po => po.matched],
  ]
  let reached = pos
  const data = stages.map(([name, test]) => {
    reached = reached.filter(test)
    return { name, value: reached.length }
  })
  return visual(id, 'Purchase order lifecycle', 'funnel', pos.length ? data : [], { drilldownPath: '/app/procurement/orders', description: 'Committed purchase orders in range. Each stage counts the orders that reached it and every stage before it.' })
}

// Ordered value, then what is still to be received, then what is received but
// not invoiced. Line values are net of tax: ordered and received quantities at
// the order's unit price, and the invoice lines linked to the order.
function valueBridgeVisual(id, pos, scope) {
  const base = { unit: 'currency', currencyCode: scope.currencyCode, totals: ['Ordered', 'Received', 'Invoiced'], drilldownPath: '/app/procurement/orders', description: 'Committed purchase orders in range, net of tax: ordered and received quantities at the order price, and the invoice lines linked to each order.' }
  if (!scope.ok) return visual(id, 'Ordered, received and invoiced value', 'waterfall', [], { ...base, emptyState: noAmountsState(scope), limitations: moneyLimitations(scope, pos) })
  const ordered = sumKnown(pos.map(po => po.orderedValue))
  const received = sumKnown(pos.map(po => po.receivedValue))
  const invoiced = sumKnown(pos.map(po => po.invoicedValue))
  if (!pos.length || ordered === null || received === null || invoiced === null) {
    return visual(id, 'Ordered, received and invoiced value', 'waterfall', [], { ...base, emptyState: pos.length ? 'Some order lines have no quantity or price, so the value bridge is not shown.' : 'No records in the selected range.', limitations: pos.length ? ['amount_missing'] : [] })
  }
  return visual(id, 'Ordered, received and invoiced value', 'waterfall', [
    { name: 'Ordered', value: ordered },
    { name: received <= ordered ? 'Not yet received' : 'Received above order', value: money(received - ordered) },
    { name: 'Received', value: received },
    { name: invoiced <= received ? 'Received, not invoiced' : 'Invoiced above receipts', value: money(invoiced - received) },
    { name: 'Invoiced', value: invoiced },
  ], base)
}

// Supplier, then the items ordered from it, sized by committed line value.
function spendTreemapVisual(id, pos, scope) {
  if (!scope.ok) {
    return visual(id, 'Committed spend by supplier and item', 'treemap', grouped(pos, po => po.supplier, () => 1), { title: 'Purchase orders by supplier', breakdown: {}, drilldownPath: '/app/procurement/orders', crossFilter: 'supplier', description: 'Amounts need one currency, so purchase orders are counted per supplier.', limitations: moneyLimitations(scope, pos) })
  }
  const breakdown = {}
  for (const po of pos) {
    const items = po.lines.filter(line => line.amount !== null)
    if (!items.length) continue
    const supplier = po.supplier || 'Unspecified'
    const current = new Map((breakdown[supplier] || []).map(row => [row.name, row.value]))
    for (const line of items) current.set(line.item || 'Unspecified', money((current.get(line.item || 'Unspecified') || 0) + line.amount))
    breakdown[supplier] = [...current].map(([name, value]) => ({ name, value })).sort(byValue)
  }
  return visual(id, 'Committed spend by supplier and item', 'treemap', grouped(pos, po => po.supplier, po => po.amount), { unit: 'currency', currencyCode: scope.currencyCode, breakdown, drilldownPath: '/app/procurement/orders', crossFilter: 'supplier', description: 'Sized by committed order amount. Select a supplier to see the net line value of each item ordered.', limitations: moneyLimitations(scope, pos) })
}

// Receipts whose arrival is in range. Every other filter follows the receipt's
// purchase order, so a supplier, currency or status filter narrows receipts the
// way it narrows the orders. Receipts use the arrival day in the workspace
// timezone, falling back to the posting and then the creation time.
function receiptFacts(context, query, poById, purchaseOrderIdsAnyDate, timeZone) {
  return array(context.receipts).filter(row => !voidReceiptStatuses.has(text(row.status).toLowerCase())).map(row => {
    const po = poById.get(text(row.poId))
    const day = instantCalendarDay(row.arrivedAt || row.postedAt || row.createdAt, timeZone)
    const lines = array(row.lines).map(line => ({ accepted: known(line.acceptedQty), rejected: known(line.rejectedQty) }))
    return { id: text(row.id), poId: text(row.poId), po, supplier: text(row.supplierName || row.supplierId) || poSupplier(po), date: day, lines }
  }).filter(row => inRange(row.date, query) && (row.po ? !purchaseOrderIdsAnyDate || purchaseOrderIdsAnyDate.has(row.poId) : (!query.supplier || row.supplier === query.supplier) && !query.currency && !query.status))
}

// On time is measured by the supplier scorecard's rules (supplier-scorecard.mjs),
// so a page never shows two on-time figures: the PO lines of the orders the
// scorecard measures (committed, not cancelled, and issued to the supplier or
// with a posted receipt; scorecardPurchaseOrderStanding: an approved order
// never sent is not measured) that pass every filter but the date range are
// grouped into deliveries (the
// lines of one PO with one original promised date) and judged against that
// date, plus the grace days, by each line's first POSTED receipt, in the
// workspace timezone. A delivery counts when its original promise falls in the
// date range; past its promise with a line not received, it is late. The lines
// not received and not yet due are returned too: they hold their delivery
// back. A rate needs at least SUPPLIER_SCORECARD_RULES.minimumSample (5)
// deliveries.
// warehouseIds, when the reader is limited to some warehouses, leaves out
// receipts in other warehouses, as the scorecard does. purchaseOrderIds, when
// given, are the orders measured in place of purchaseOrderIdsAnyDate.
export function promiseLineFacts(context, query, purchaseOrderIdsAnyDate, today, timeZone, { graceDays = SUPPLIER_SCORECARD_RULES.graceDays, warehouseIds = null, purchaseOrderIds = null } = {}) {
  const measured = purchaseOrderIds || purchaseOrderIdsAnyDate
  const readable = Array.isArray(warehouseIds) ? new Set(warehouseIds.map(text)) : null
  const receiptLines = new Map()
  const receivedPurchaseOrderIds = new Set()
  for (const document of array(context.receipts)) {
    if (text(document.postingStatus).toLowerCase() !== 'posted') continue
    if (readable && text(document.warehouseId) && !readable.has(text(document.warehouseId))) continue
    if (text(document.poId)) receivedPurchaseOrderIds.add(text(document.poId))
    const day = instantCalendarDay(document.arrivedAt || document.postedAt, timeZone) || null
    for (const line of array(document.lines)) {
      const lineId = text(line.purchaseOrderLineId)
      if (lineId) receiptLines.set(lineId, [...(receiptLines.get(lineId) || []), { receivingDocumentId: document.id, day, accepted: line.acceptedQty, rejected: line.rejectedQty }])
    }
  }
  const from = query.from || '0001-01-01'
  const to = query.to || '9999-12-31'
  return array(context.purchaseOrders)
    .filter(po => (!measured || measured.has(text(po.id || po.po))) && scorecardPurchaseOrderStanding({ ...po, id: text(po.id || po.po) }, { receiptLinesByLine: receiptLines, receivedPurchaseOrderIds }) === 'measured')
    .flatMap(po => array(po.lines).map(line => ({ ...evaluatePromiseLine({ line, purchaseOrder: { ...po, id: text(po.id || po.po) }, receipts: receiptLines.get(text(line.id)) || [], asOfDay: today || null, graceDays, timeZone }), supplier: poSupplier(po) })))
    .filter(line => ['evaluated', 'not_received'].includes(line.status) && line.originalPromisedDate && line.originalPromisedDate >= from && line.originalPromisedDate <= to)
}

// The on-time rate of the deliveries the lines make up, as a percentage, null
// below the minimum sample, with the number of deliveries judged.
const onTimeOf = lines => {
  const { metrics, sampleSize } = summarizeScorecardLines({ lines })
  return { percent: metrics.onTime.rate === null ? null : Math.round(metrics.onTime.rate * 1000) / 10, deliveries: sampleSize }
}

function receiptCalendarVisual(id, receipts, query) {
  const days = grouped(receipts.filter(row => row.date), row => row.date, () => 1).sort((a, b) => a.name.localeCompare(b.name)).map(({ name, value }) => ({ name, value }))
  const last = query.to || days.at(-1)?.name || ''
  const first = query.from || days[0]?.name || ''
  return visual(id, 'Receiving activity by day', 'calendar', days, { range: [first, last], drilldownPath: '/app/procurement/receiving', description: 'Receipts per arrival day.' })
}

function supplierPerformance(pos, receipts, invoices, scope, promiseLines = []) {
  const suppliers = new Map()
  const entry = name => {
    if (!suppliers.has(name)) suppliers.set(name, { name, amount: 0, amountKnown: true, orders: 0, receipts: 0, promised: [], lines: 0, accepted: 0, decided: 0, matched: 0 })
    return suppliers.get(name)
  }
  for (const line of promiseLines) entry(line.supplier || 'Unspecified').promised.push(line)
  for (const po of pos) {
    const row = entry(po.supplier || 'Unspecified')
    row.orders += 1
    if (po.amount === null) row.amountKnown = false
    else row.amount = money(row.amount + po.amount)
  }
  for (const receipt of receipts) {
    const row = entry(receipt.supplier || 'Unspecified')
    row.receipts += 1
    for (const line of receipt.lines) if (line.rejected !== null) { row.lines += 1; if (line.rejected === 0) row.accepted += 1 }
  }
  for (const invoice of invoices) {
    const outcome = invoiceMatchOutcome(invoice)
    if (outcome === 'pending') continue
    const row = entry(invoiceSupplier(invoice) || 'Unspecified')
    row.decided += 1
    if (outcome === 'matched') row.matched += 1
  }
  const totalAmount = [...suppliers.values()].reduce((sum, row) => sum + row.amount, 0)
  const totalOrders = pos.length
  return [...suppliers.values()].map(({ promised, ...row }) => {
    const onTime = onTimeOf(promised)
    return {
      ...row,
      spend: scope.ok && row.amountKnown ? row.amount : null,
      promisedDeliveries: onTime.deliveries,
      onTimeRate: onTime.percent,
      acceptedRate: share(row.accepted, row.lines),
      matchRate: share(row.matched, row.decided),
      spendShare: scope.ok ? share(row.amount, totalAmount) : share(row.orders, totalOrders),
    }
  })
}

// Suppliers placed by spend (or order count) and on-time deliveries. The guides
// are the median of the horizontal measure and the average on-time rate, so
// the quadrants come from the data, not from an assumed target.
function performanceMatrixVisual(id, performance, scope, emptyState = ON_TIME_EMPTY) {
  const xKey = scope.ok ? 'Committed amount' : 'Purchase orders'
  const rows = performance.filter(row => row.onTimeRate !== null && row.name !== 'Unspecified' && (scope.ok ? row.spend !== null : true)).map(row => ({ name: row.name, [xKey]: scope.ok ? row.spend : row.orders, 'On-time deliveries': row.onTimeRate, 'Deliveries': row.promisedDeliveries, filterValue: row.name }))
  const xs = rows.map(row => row[xKey]).sort((a, b) => a - b)
  const median = xs.length ? (xs.length % 2 ? xs[(xs.length - 1) / 2] : (xs[xs.length / 2 - 1] + xs[xs.length / 2]) / 2) : null
  const average = rows.length ? Math.round(rows.reduce((sum, row) => sum + row['On-time deliveries'], 0) / rows.length * 10) / 10 : null
  return visual(id, 'Supplier performance matrix', 'scatter', rows, { unit: scope.ok ? 'currency' : 'number', currencyCode: scope.currencyCode, measures: [{ key: xKey, unit: scope.ok ? 'currency' : 'number', axis: 'x' }, { key: 'On-time deliveries', unit: 'percentage', axis: 'y' }, { key: 'Deliveries', unit: 'number', axis: 'size' }], guides: { x: median, y: average }, seriesKeys: [xKey, 'On-time deliveries', 'Deliveries'], drilldownPath: '/app/master-data/suppliers', crossFilter: 'supplier', description: 'Deliveries on time against the date on the PO. Bubble size is the number of deliveries measured. The guides are the median spend and the average on-time rate.', emptyState, limitations: moneyLimitations(scope, []) })
}

const ON_TIME_EMPTY = 'No supplier has 5 or more deliveries first promised in the selected range.'
// On time is not measured when the reader cannot see receipts, or when not
// every receipt was loaded: a delivery whose receipt is missing would count as late.
// Nor, on the supplier page, over a range the scorecard there does not accept.
const ON_TIME_WITHHELD = { restricted: 'Your role cannot view receipts.', truncated: 'Not every receipt could be loaded, so on-time deliveries are not measured here.', period_too_long: 'The range is longer than the supplier scorecard allows, so on-time deliveries are not measured. Choose a shorter range.' }

function scorecardVisual(id, performance, scope) {
  const indicators = [['On-time deliveries', 'onTimeRate'], ['Lines accepted in full', 'acceptedRate'], ['Invoices matched', 'matchRate'], [scope.ok ? 'Share of spend' : 'Share of orders', 'spendShare']]
  const size = row => scope.ok ? row.spend ?? -1 : row.orders
  const candidates = performance.filter(row => row.name !== 'Unspecified').sort((a, b) => size(b) - size(a) || a.name.localeCompare(b.name)).slice(0, 5)
  const used = indicators.filter(([, key]) => candidates.some(row => row[key] !== null))
  const rows = candidates.filter(row => used.every(([, key]) => row[key] !== null)).map(row => ({ name: row.name, ...Object.fromEntries(used.map(([label, key]) => [label, row[key]])) }))
  return visual(id, 'Supplier scorecard', 'radar', used.length >= 3 ? rows : [], { unit: 'percentage', seriesKeys: used.map(([label]) => label), drilldownPath: '/app/master-data/suppliers', description: 'The largest suppliers by spend, on measures each of them has data for.', emptyState: 'Not enough receipt and invoice history to compare suppliers.' })
}

function rankingVisual(id, title, rows, { unit = 'number', currencyCode = null, drilldownPath, crossFilter = null, description, emptyState, limit = 10, ascending = false }) {
  const sorted = [...rows].sort((a, b) => (ascending ? a.value - b.value : b.value - a.value) || String(a.name).localeCompare(String(b.name))).slice(0, limit)
  return visual(id, title, 'horizontal_bar', sorted, { unit, currencyCode, drilldownPath, crossFilter, description, ...(emptyState ? { emptyState } : {}) })
}

// Purchase orders per supplier and month, for the ten busiest suppliers.
function activityHeatmapVisual(id, pos) {
  const months = [...new Set(pos.map(po => monthOf(po.date)))].sort((a, b) => (a === 'Undated') - (b === 'Undated') || a.localeCompare(b))
  const top = grouped(pos, po => po.supplier, () => 1).slice(0, 10).map(row => row.name)
  const rows = top.map(name => ({ name, ...Object.fromEntries(months.map(key => [key, pos.filter(po => (po.supplier || 'Unspecified') === name && monthOf(po.date) === key).length])), filterValue: name === 'Unspecified' ? '' : name }))
  return visual(id, 'Purchase orders by supplier and month', 'heatmap', rows, { seriesKeys: months, drilldownPath: '/app/procurement/orders', crossFilter: 'supplier', description: 'Committed purchase orders, by order date.' })
}

function invoiceFacts(context, all, timeZone) {
  const inScope = new Set(all.supplier_invoices.map(row => row.id))
  return array(context.supplierInvoices).filter(row => inScope.has(text(row.id || row.invoiceNumber)) && submittedInvoiceStatuses.has(text(row.status).toLowerCase())).map(row => ({ id: text(row.id || row.invoiceNumber), supplier: invoiceSupplier(row), date: reportCalendarDay(row.invoiceDate) || instantCalendarDay(row.createdAt, timeZone), amount: known(row.totalAmount ?? row.amount), variance: known(row.varianceAmount), currency: reportCurrencyCode(row.currency), outcome: invoiceMatchOutcome(row), raw: row }))
}

function matchGaugeVisual(id, invoices) {
  const matched = invoices.filter(row => row.outcome === 'matched').length
  return visual(id, 'Invoices matched', 'gauge', invoices.length ? [{ name: 'Invoices matched', value: share(matched, invoices.length) }] : [], { unit: 'percentage', detail: { count: matched, total: invoices.length, exception: invoices.filter(row => row.outcome === 'exception').length, pending: invoices.filter(row => row.outcome === 'pending').length }, drilldownPath: '/app/finance/three-way-match', description: 'Share of submitted invoices whose three-way match passed.' })
}

function matchOutcomeVisual(id, invoices) {
  const data = ['matched', 'exception', 'pending'].map(outcome => ({ name: MATCH_OUTCOME_LABELS[outcome], value: invoices.filter(row => row.outcome === outcome).length })).filter(row => row.value > 0)
  return visual(id, 'Match outcome', 'donut', data, { drilldownPath: '/app/finance/three-way-match', description: 'Submitted invoices by three-way match result.' })
}

// Supplier to match outcome, counting invoices: the eight suppliers with the
// most invoices, the rest folded into one node.
function invoiceFlowVisual(id, invoices) {
  const top = grouped(invoices, row => row.supplier, () => 1).slice(0, 8).map(row => row.name)
  const links = new Map()
  for (const invoice of invoices) {
    const source = top.includes(invoice.supplier || 'Unspecified') ? invoice.supplier || 'Unspecified' : OTHER_SUPPLIERS
    const key = `${source}\u0000${invoice.outcome}`
    links.set(key, (links.get(key) || 0) + 1)
  }
  const rows = [...links].map(([key, value]) => {
    const [source, outcome] = key.split('\u0000')
    return { source, target: MATCH_OUTCOME_LABELS[outcome], value }
  }).sort((a, b) => b.value - a.value || a.source.localeCompare(b.source))
  return visual(id, 'Invoices from supplier to match outcome', 'sankey', rows.map(row => ({ name: `${row.source} → ${row.target}`, value: row.value })), { links: rows, targets: Object.values(MATCH_OUTCOME_LABELS), drilldownPath: '/app/finance/invoices', description: 'Each band is a number of submitted invoices.' })
}

// Sales orders in scope with their shipping progress, decided per line
// (salesDemand: { orderId, ordered, fulfilled }): shipped when any line has
// shipped, shipped in full when every line has shipped its ordered quantity.
// Order-level quantities add lines in different units, so they are not used.
function salesFacts(context, all, salesDemand = []) {
  const reserved = new Map(array(context.salesOrders).map(order => [text(order.salesOrderId || order.id), known(order.reservedQty) || 0]))
  const linesByOrder = new Map()
  for (const line of salesDemand) linesByOrder.set(line.orderId, [...(linesByOrder.get(line.orderId) || []), line])
  return all.sales_orders.map(row => {
    const lines = linesByOrder.get(row.id) || []
    return {
      ...row, active: !inactiveSalesStatuses.has(row.status), reserved: reserved.get(row.id) || 0,
      shipped: lines.some(line => line.fulfilled > 0),
      shippedInFull: lines.length > 0 && lines.every(line => line.ordered > 0 && line.fulfilled !== null && line.fulfilled >= line.ordered),
    }
  })
}

// Active orders that are reserved or shipped, then shipped, then shipped in full.
function fulfillmentFunnelVisual(id, orders) {
  const active = orders.filter(row => row.active)
  const stages = [['Active orders', () => true], ['Reserved or shipped', row => row.reserved > 0 || row.shipped], ['Shipped', row => row.shipped], ['Shipped in full', row => row.shippedInFull]]
  let reached = active
  const data = stages.map(([name, test]) => { reached = reached.filter(test); return { name, value: reached.length } })
  return visual(id, 'Sales order fulfillment', 'funnel', active.length ? data : [], { drilldownPath: '/app/sales/orders', description: 'Confirmed sales orders in range, without drafts and cancellations. Each stage counts the orders that reached it.' })
}

function fulfillmentGaugeVisual(id, orders) {
  const active = orders.filter(row => row.active)
  const full = active.filter(row => row.shippedInFull).length
  return visual(id, 'Orders shipped in full', 'gauge', active.length ? [{ name: 'Orders shipped in full', value: share(full, active.length) }] : [], { unit: 'percentage', detail: { count: full, total: active.length }, drilldownPath: '/app/sales/orders', description: 'Share of confirmed sales orders whose every line has shipped its ordered quantity.' })
}

// Stock position per SKU. Quantities are never added across SKUs. "Short now"
// is the shortage the "SKUs short now" KPI counts: open demand that available
// stock does not cover, before incoming purchase orders (those are in ATP).
function stockPositionVisual(id, balances) {
  const rows = balances.filter(row => row.quantity !== null).map(row => ({ name: row.id, Available: Math.max(0, known(row.available) ?? 0), 'Reserved quantity': Math.max(0, known(row.reserved) ?? 0), 'Short now': Math.max(0, known(row.shortage) ?? 0) }))
    .sort((a, b) => b['Short now'] - a['Short now'] || (b.Available + b['Reserved quantity']) - (a.Available + a['Reserved quantity']) || a.name.localeCompare(b.name)).slice(0, 12)
  return visual(id, 'Stock position by SKU', 'stacked_bar', rows, { seriesKeys: ['Available', 'Reserved quantity', 'Short now'], colors: ['#16a34a', '#2563eb', '#dc2626'], orientation: 'horizontal', drilldownPath: '/app/inventory', description: 'Each SKU in its own unit. Shortage is open demand that available stock does not cover; incoming purchase orders are not counted.' })
}

function atpVisual(id, balances) {
  const rows = balances.filter(row => known(row.availableToPromise) !== null).map(row => ({ name: row.id, value: known(row.availableToPromise) }))
  return rankingVisual(id, 'Available to promise by SKU', rows, { drilldownPath: '/app/inventory', description: 'On hand plus incoming, less reservations and open demand, in each SKU\'s unit. Negative values cannot be promised.', ascending: true, limit: 12 })
}

const STOCK_STATUS_ORDER = ['out_of_stock', 'below_safety_stock', 'below_reorder_point', 'ok', 'unknown']
const RISK_ORDER = ['high', 'medium', 'low', 'unknown']

function riskMatrixVisual(id, balances) {
  const statuses = STOCK_STATUS_ORDER.filter(code => balances.some(row => row.stockStatus === code))
  const risks = RISK_ORDER.filter(code => balances.some(row => row.status === code))
  const rows = statuses.map(code => ({ name: code, ...Object.fromEntries(risks.map(risk => [risk, balances.filter(row => row.stockStatus === code && row.status === risk).length])) }))
  return visual(id, 'SKUs by stock status and risk', 'heatmap', rows, { seriesKeys: risks, statusLabels: true, drilldownPath: '/app/inventory', description: 'Number of SKUs in each combination.' })
}

// Builds the visuals of one dashboard. `all` holds the filtered runtime rows;
// `purchaseOrderIdsAnyDate` the purchase orders that pass every filter except
// the date range, so receipts can follow their order's filters.
// onTimeWithheld ('restricted', 'truncated' or 'period_too_long') leaves the on-time measures
// out; promiseOptions carries the grace days and the reader's warehouses.
export function buildDashboardVisuals({ subject, context, all, query, purchaseOrderIdsAnyDate, restrictedAmounts = {}, today = '', timeZone, salesDemand = [], onTimeWithheld = null, promiseOptions = {} }) {
  const poById = new Map(array(context.purchaseOrders).map(row => [text(row.id || row.po), row]))
  const receiptsByPo = new Map()
  for (const receipt of array(context.receipts)) if (text(receipt.poId)) receiptsByPo.set(text(receipt.poId), true)
  const invoicesByPo = new Map()
  for (const invoice of array(context.supplierInvoices)) {
    if (!submittedInvoiceStatuses.has(text(invoice.status).toLowerCase())) continue
    const poId = text(invoice.poId || invoice.relatedPo)
    if (poId) invoicesByPo.set(poId, [...(invoicesByPo.get(poId) || []), invoice])
  }
  const lazy = fn => { let value; return () => (value ||= fn()) }
  const pos = lazy(() => purchaseOrderFacts(context, all, receiptsByPo, invoicesByPo, timeZone))
  const poScope = lazy(() => restrictedAmounts.purchase_orders ? RESTRICTED_SCOPE : moneyScope(pos(), query))
  const receipts = lazy(() => receiptFacts(context, query, poById, purchaseOrderIdsAnyDate, timeZone))
  const invoices = lazy(() => invoiceFacts(context, all, timeZone))
  const promiseLines = lazy(() => onTimeWithheld ? [] : promiseLineFacts(context, query, purchaseOrderIdsAnyDate, today, timeZone, promiseOptions))
  const performance = lazy(() => supplierPerformance(pos(), receipts(), invoices().map(row => row.raw), poScope(), promiseLines()))

  if (subject === 'overview') return [
    trendVisual('overview_spend_trend', 'Committed spend by month', pos(), poScope(), { countKey: 'Purchase orders', amountKey: 'Committed amount', drilldownPath: '/app/reports/procurement?view=analytics', description: 'Committed purchase orders by order date. Bars are amounts, the line is the number of orders.' }),
    lifecycleVisual('overview_lifecycle', pos()),
  ]

  if (subject === 'procurement') return [
    trendVisual('procurement_spend_trend', 'Committed spend by month', pos(), poScope(), { countKey: 'Purchase orders', amountKey: 'Committed amount', drilldownPath: '/app/procurement/orders', description: 'Committed purchase orders by order date. Bars are amounts, the line is the number of orders.' }),
    lifecycleVisual('procurement_lifecycle', pos()),
    paretoVisual('procurement_supplier_pareto', 'Spend concentration by supplier', pos(), poScope(), po => po.supplier, { otherLabel: OTHER_SUPPLIERS, drilldownPath: '/app/procurement/orders', crossFilter: 'supplier', countLabel: 'Purchase orders' }),
    valueBridgeVisual('procurement_value_bridge', pos(), poScope()),
    spendTreemapVisual('procurement_spend_treemap', pos(), poScope()),
    statusVisual('procurement_po_status', 'Purchase order status', all.purchase_orders, '/app/procurement/orders', ALL_PURCHASE_ORDERS),
    receiptCalendarVisual('procurement_receipt_calendar', receipts(), query),
  ]

  if (subject === 'finance') {
    const scope = restrictedAmounts.supplier_invoices ? RESTRICTED_SCOPE : moneyScope(invoices(), query)
    const variance = scope.ok ? grouped(invoices(), row => row.supplier, row => row.variance === null ? null : Math.abs(row.variance)).filter(row => row.value > 0) : []
    return [
      trendVisual('finance_invoice_trend', 'Submitted invoices by month', invoices(), scope, { countKey: 'Invoices', amountKey: 'Invoice amount', drilldownPath: '/app/finance/invoices', description: 'Submitted supplier invoices by invoice date. Bars are amounts, the line is the number of invoices.' }),
      matchGaugeVisual('finance_match_rate', invoices()),
      matchOutcomeVisual('finance_match_outcome', invoices()),
      invoiceFlowVisual('finance_invoice_flow', invoices()),
      rankingVisual('finance_variance_by_supplier', 'Invoice variance by supplier', variance, { unit: 'currency', currencyCode: scope.currencyCode, drilldownPath: '/app/finance/invoices', crossFilter: 'supplier', description: 'Absolute variance between invoices and their orders and receipts.', emptyState: scope.ok ? 'No invoice variance in the selected range.' : noAmountsState(scope) }),
      statusVisual('finance_invoice_status', 'Invoice status', all.supplier_invoices, '/app/finance/invoices'),
    ]
  }

  if (subject === 'sales') {
    const orders = salesFacts(context, all, salesDemand)
    const active = orders.filter(row => row.active)
    const scope = restrictedAmounts.sales_orders ? RESTRICTED_SCOPE : moneyScope(active, query)
    // Open demand per SKU and unit, from the order lines: an SKU sold in two
    // units is two bars, and no bar adds quantities across units.
    const demand = new Map()
    for (const line of salesDemand) {
      if (!line.active || !line.sku || !(line.open > 0)) continue
      const key = `${line.sku}\u0000${line.unit}`
      demand.set(key, { name: line.unit ? `${line.sku} (${line.unit})` : line.sku, unit: line.unit, value: Math.round(((demand.get(key)?.value || 0) + line.open) * 10000) / 10000 })
    }
    const demandUnits = [...new Set([...demand.values()].map(row => row.unit))].sort()
    return [
      trendVisual('sales_order_trend', 'Sales orders by month', active, scope, { countKey: 'Sales orders', amountKey: 'Order amount', drilldownPath: '/app/sales/orders', description: 'Confirmed sales orders by order date. Bars are amounts, the line is the number of orders.' }),
      fulfillmentFunnelVisual('sales_fulfillment', orders),
      paretoVisual('sales_customer_pareto', 'Sales concentration by customer', active, scope, row => row.customer, { otherLabel: OTHER_CUSTOMERS, drilldownPath: '/app/sales/orders', crossFilter: 'customer', countLabel: 'Sales orders' }),
      fulfillmentGaugeVisual('sales_shipped_in_full', orders),
      { ...rankingVisual('sales_open_demand', 'Open demand by SKU', [...demand.values()].map(({ name, value }) => ({ name, value })), { drilldownPath: '/app/sales/orders', description: demandUnits.length > 1 ? 'Ordered less shipped quantity, in each SKU\'s unit. Bars in different units are not comparable.' : 'Ordered less shipped quantity, in each SKU\'s unit.', limit: 12 }), units: demandUnits },
      statusVisual('sales_order_status', 'Sales order status', all.sales_orders, '/app/sales/orders'),
    ]
  }

  if (subject === 'inventory') {
    const balances = all.inventory_balances
    return [
      rankingVisual('inventory_on_hand_by_sku', 'On hand by SKU', balances.filter(row => row.quantity !== null).map(row => ({ name: row.id, value: row.quantity })), { drilldownPath: '/app/inventory', description: 'Recorded on-hand quantity, in each SKU\'s unit.', limit: 15 }),
      stockPositionVisual('inventory_stock_position', balances),
      atpVisual('inventory_available_to_promise', balances),
      visual('inventory_stock_status', 'Stock status', 'donut', grouped(balances, row => row.stockStatus, () => 1), { drilldownPath: '/app/inventory', statusLabels: true }),
      riskMatrixVisual('inventory_risk_matrix', balances),
    ]
  }

  if (subject === 'suppliers') {
    const scope = poScope()
    const onTime = performance().filter(row => row.onTimeRate !== null && row.name !== 'Unspecified').map(row => ({ name: row.name, value: row.onTimeRate, filterValue: row.name }))
    const onTimeEmpty = ON_TIME_WITHHELD[onTimeWithheld] || ON_TIME_EMPTY
    return [
      performanceMatrixVisual('supplier_performance_matrix', performance(), scope, onTimeEmpty),
      scorecardVisual('supplier_scorecard', performance(), scope),
      rankingVisual('supplier_on_time', 'On-time deliveries by supplier', onTime, { unit: 'percentage', drilldownPath: '/app/procurement/receiving', crossFilter: 'supplier', description: 'Deliveries (the lines of one PO with one date) first promised in range whose every line had a posted receipt by the date on the PO. Orders approved but not sent to the supplier are left out. Each supplier needs at least 5 deliveries.', emptyState: onTimeEmpty }),
      spendTreemapVisual('supplier_spend_treemap', pos(), scope),
      activityHeatmapVisual('supplier_activity_heatmap', pos()),
    ]
  }

  return []
}

// Facts behind the dashboards' KPIs and summary sentences, from the same
// scope as the visuals.
export function buildDashboardFacts({ context, all, query, purchaseOrderIdsAnyDate, today, timeZone, salesDemand = [], onTimeWithheld = null, promiseOptions = {} }) {
  const poById = new Map(array(context.purchaseOrders).map(row => [text(row.id || row.po), row]))
  const onTime = onTimeOf(onTimeWithheld ? [] : promiseLineFacts(context, query, purchaseOrderIdsAnyDate, today, timeZone, promiseOptions))
  const invoices = invoiceFacts(context, all, timeZone)
  const orders = salesFacts(context, all, salesDemand).filter(row => row.active)
  const openPurchaseOrders = all.purchase_orders.filter(row => row.isOpen)
  // The open purchase orders report's rule: due on the earliest promised day of
  // the lines still to receive, overdue once that day is before today.
  const overdue = openPurchaseOrders.filter(row => {
    const due = purchaseOrderDueDay(poById.get(row.id))
    return Boolean(due && today && due < today)
  })
  return {
    onTimeReceiptRate: onTime.percent,
    onTimeDeliveries: onTime.deliveries,
    onTimeWithheld,
    overdueOpenPurchaseOrders: overdue.length,
    invoiceMatchRate: share(invoices.filter(row => row.outcome === 'matched').length, invoices.length),
    invoicesAwaitingMatch: invoices.filter(row => row.outcome === 'pending').length,
    invoicesWithException: invoices.filter(row => row.outcome === 'exception').length,
    submittedInvoices: invoices.length,
    orderFulfillmentRate: share(orders.filter(row => row.shippedInFull).length, orders.length),
    activeSuppliers: new Set(all.purchase_orders.filter(row => isCommittedPurchaseOrder(poById.get(row.id) || row)).map(row => row.supplier).filter(Boolean)).size,
  }
}
