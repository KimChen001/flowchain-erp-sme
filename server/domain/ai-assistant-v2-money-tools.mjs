import { AI_TOOL_LIMITS, aiToolList, aiToolRef, defineAiTool } from './ai-read-tool-contract.mjs'
import { SALES_BASIS, SALES_PERIODS, salesDay, salesItem, salesRange } from './ai-read-service-tools.mjs'
import { outstandingPayableWhere } from './operational-finance-read-service.mjs'
import { itemSources, preferredSource, storedItems, unitPriceOf } from './ai-item-prices.mjs'
import { itemStockUnit } from './reorder-list.mjs'
import { procurementDocumentNumber } from '../../shared/document-numbering.mjs'
import { addCalendarDays } from '../../shared/purchase-request-prefill.mjs'

// The assistant's money tools (2026-11-14, owner: "开始做付款、现金、毛利工具").
// On the UCI question set the assistant could not say what is owed to
// suppliers, what is overdue, what was paid or received in a month, what was
// received but not invoiced, or the gross profit: it had no tool for them and
// said FlowChain does not record them. Each tool reads the records the app's
// own pages show, in the asking user's workspace, and only with the read
// permission of those pages:
//
//   supplier_payables  approved supplier invoices not paid in full (the
//                      payables page's "outstanding"), overdue once their due
//                      day is past the workspace day; invoices held at the
//                      three-way match; posted receipts no invoice covers
//   cash_movements     payments recorded against receivables (in) and
//                      payables (out), by payment date, voided ones left out
//   gross_profit       customer invoice lines (sales_summary's basis) less
//                      their units at the preferred supplier's reference price
//                      (inventory_value's price), labelled an estimate
//
// Money needs finance.amounts.read and supplier names
// finance.partner_snapshot.read, as on the finance pages; a hidden value is
// null and says so, never 0. Amounts are never added across currencies.

const text = (value) => String(value ?? '').trim()
const array = (value) => (Array.isArray(value) ? value : [])
const fold = (value) => text(value).toLowerCase()
const money = (value) => Math.round((Number(value) || 0) * 100) / 100
const percent = (part, whole) => (whole > 0 ? Math.round((part / whole) * 1000) / 10 : null)
// The parameters stay short: every request carries them (2026-11-14: the
// fixed part of a request had little room left at Sonnet 5.5 prices).
const limitParam = { type: 'integer', minimum: 1, maximum: AI_TOOL_LIMITS.maxRows }
const dayParam = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' }
const periodParams = { period: { type: 'string', enum: SALES_PERIODS }, from: dayParam, to: dayParam }
const can = (context, permission) => Boolean(context?.actor?.permissionCodes?.has?.(permission))
const day = (value) => (value instanceof Date ? value.toISOString().slice(0, 10) : text(value).slice(0, 10)) || null
const workspaceDay = (facts) => salesDay(facts?.today || facts?.asOf)
const daysBetween = (from, to) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000)
const dayStart = (value) => new Date(`${value}T00:00:00Z`)
const PAYABLES_MAX = 5000
const RECEIPTS_MAX = 5000
const PAYMENTS_MAX = 50000
const INVOICES_MAX = 20000
const COSTED_ITEMS_MAX = 500
const DUE_SOON_DAYS = 7

// Per currency, the sum of `amount` over rows and how many there are.
function tally(rows, keyOf = (row) => row.currency) {
  const totals = new Map()
  for (const row of rows) {
    const key = keyOf(row)
    const entry = totals.get(key) || { currency: row.currency, count: 0, amount: 0 }
    entry.count += 1
    entry.amount += Number(row.amount) || 0
    totals.set(key, entry)
  }
  return totals
}

// --- supplier_payables -----------------------------------------------------

const PAYABLES_BASIS = Object.freeze({
  owed: 'Approved supplier invoices not paid in full: what is still outstanding on each, whether its payment is held or not. An invoice held at the three-way match is not approved, so it is not owed yet; it is counted apart.',
  overdue: 'Owed invoices whose due date is before today (the workspace day).',
  notInvoiced: 'Posted receipts of purchase orders that no supplier invoice covers yet (none is linked to the receipt or to its lines; cancelled invoices do not count), valued at the order price.',
})

// What is owed, from the payables still outstanding (outstandingPayableWhere,
// the payables page's rule), as of `today`.
export function payablesView(rows, { today, amountsVisible = true, namesVisible = true }) {
  return array(rows).map((row) => {
    const due = day(row.dueDate)
    const invoice = row.supplierInvoice || {}
    const late = due && due < today ? daysBetween(due, today) : 0
    return {
      invoiceNumber: text(invoice.invoiceNumber) || text(row.obligationNumber),
      supplier: namesVisible ? text(invoice.supplierName) || null : null,
      invoiceDate: day(invoice.invoiceDate),
      dueDate: due,
      overdueDays: late,
      outstanding: amountsVisible ? money(row.outstandingAmount) : null,
      currency: text(row.currency) || null,
      paymentHeld: text(row.status) === 'held',
      ref: aiToolRef('supplier_invoice', invoice.id || row.supplierInvoiceId, text(invoice.invoiceNumber) || text(row.obligationNumber)),
      amount: Number(row.outstandingAmount) || 0,
    }
  })
}

const totalsOf = (rows, amountsVisible) => [...tally(rows).values()].map((entry) => ({ currency: entry.currency, invoices: entry.count, amount: amountsVisible ? money(entry.amount) : null }))
const withoutAmount = ({ amount, ...row }) => row

// Posted receipts no supplier invoice covers: none links the receipt
// (relatedGrnId) or one of its lines (receivingLineId). Valued at the order
// line's price; a line without one is left out of the value and counted.
export function receiptsNotInvoiced(receipts, { linkedReceipts, linkedLines, orderLines, orders, amountsVisible = true, namesVisible = true }) {
  const rows = []
  for (const receipt of array(receipts)) {
    if (linkedReceipts.has(text(receipt.id))) continue
    const lines = array(receipt.lines)
    if (lines.some((line) => linkedLines.has(text(line.id)))) continue
    let value = 0
    let unpriced = 0
    for (const line of lines) {
      const price = orderLines.get(text(line.purchaseOrderLineId))
      if (price === undefined || price === null) unpriced += 1
      else value += (Number(line.acceptedQty) || 0) * Number(price)
    }
    const order = orders.get(text(receipt.poId))
    rows.push({
      receipt: text(receipt.documentNumber) || text(receipt.id),
      supplier: namesVisible ? text(receipt.supplierName) || text(order?.supplierName) || null : null,
      arrived: day(receipt.arrivedAt || receipt.createdAt),
      purchaseOrder: order ? procurementDocumentNumber(order) : null,
      value: amountsVisible ? money(value) : null,
      currency: text(order?.currency) || null,
      ...(unpriced ? { linesWithoutPrice: unpriced } : {}),
      ref: aiToolRef('receiving_doc', receipt.id, text(receipt.documentNumber) || text(receipt.id)),
      amount: value,
    })
  }
  return rows.sort((a, b) => text(b.arrived).localeCompare(text(a.arrived)) || a.receipt.localeCompare(b.receipt))
}

async function readNotInvoiced(context, { amountsVisible, namesVisible }) {
  const { prisma, tenantId } = context
  const receipts = array(await prisma.receivingDocument.findMany({
    where: { tenantId, postingStatus: 'posted', poId: { not: null } },
    select: { id: true, documentNumber: true, supplierName: true, poId: true, arrivedAt: true, createdAt: true, lines: { select: { id: true, purchaseOrderLineId: true, acceptedQty: true } } },
    take: RECEIPTS_MAX,
  }))
  if (!receipts.length) return []
  const [invoices, invoiceLines] = await Promise.all([
    prisma.supplierInvoice.findMany({ where: { tenantId, status: { not: 'cancelled' }, relatedGrnId: { not: null } }, select: { relatedGrnId: true } }),
    prisma.supplierInvoiceLine.findMany({ where: { receivingLineId: { not: null }, supplierInvoice: { tenantId, status: { not: 'cancelled' } } }, select: { receivingLineId: true } }),
  ])
  const linkedReceipts = new Set(array(invoices).map((row) => text(row.relatedGrnId)))
  const linkedLines = new Set(array(invoiceLines).map((row) => text(row.receivingLineId)))
  const open = receipts.filter((receipt) => !linkedReceipts.has(text(receipt.id)) && !array(receipt.lines).some((line) => linkedLines.has(text(line.id))))
  const orderIds = [...new Set(open.map((receipt) => text(receipt.poId)).filter(Boolean))]
  const lineIds = [...new Set(open.flatMap((receipt) => array(receipt.lines).map((line) => text(line.purchaseOrderLineId))).filter(Boolean))]
  const [orders, lines] = await Promise.all([
    orderIds.length ? prisma.purchaseOrder.findMany({ where: { tenantId, id: { in: orderIds } }, select: { id: true, number: true, metadata: true, supplierName: true, currency: true } }) : [],
    lineIds.length ? prisma.purchaseOrderLine.findMany({ where: { id: { in: lineIds }, purchaseOrder: { tenantId } }, select: { id: true, unitPrice: true } }) : [],
  ])
  return receiptsNotInvoiced(open, {
    linkedReceipts, linkedLines, amountsVisible, namesVisible,
    orders: new Map(array(orders).map((row) => [text(row.id), row])),
    orderLines: new Map(array(lines).map((row) => [text(row.id), row.unitPrice === null || row.unitPrice === undefined ? null : Number(row.unitPrice)])),
  })
}

const supplierPayables = defineAiTool({
  name: 'supplier_payables',
  description: 'Accounts payable: approved supplier invoices not fully paid. view summary (default: owed, overdue, due in 7 days, held at the match, receipts not invoiced), owed or overdue (the invoices), by_supplier, or not_invoiced (posted receipts no invoice covers).',
  parameters: {
    view: { type: 'string', enum: ['summary', 'overdue', 'owed', 'by_supplier', 'not_invoiced'] },
    supplier: { type: 'string' },
    limit: limitParam,
  },
  available: (_facts, context) => Boolean(context?.actor && context.prisma) && can(context, 'finance.payable.read'),
  assistantV2Only: true,
  async run(args, { facts, context }) {
    const today = workspaceDay(facts)
    const amountsVisible = can(context, 'finance.amounts.read')
    const namesVisible = can(context, 'finance.partner_snapshot.read')
    if (args.supplier && !namesVisible) return { error: 'supplier_names_hidden' }
    const view = args.view || 'summary'
    const bySupplier = (row) => !args.supplier || fold(row.supplier).includes(fold(args.supplier))
    const hidden = { ...(amountsVisible ? {} : { amountsHidden: true }), ...(namesVisible ? {} : { supplierNamesHidden: true }) }
    if (view === 'not_invoiced') {
      if (!can(context, 'receiving.read')) return { error: 'receipts_not_readable' }
      const rows = (await readNotInvoiced(context, { amountsVisible, namesVisible })).filter(bySupplier)
      return { asOf: today, basis: PAYABLES_BASIS.notInvoiced, ...hidden, totals: totalsOf(rows, amountsVisible).map(({ invoices, ...entry }) => ({ ...entry, receipts: invoices })), ...aiToolList(rows.map(withoutAmount), args.limit) }
    }
    const found = array(await context.prisma.payableObligation.findMany({
      where: { tenantId: context.tenantId, ...outstandingPayableWhere() },
      select: { id: true, supplierInvoiceId: true, obligationNumber: true, outstandingAmount: true, currency: true, dueDate: true, status: true, supplierInvoice: { select: { id: true, invoiceNumber: true, supplierName: true, invoiceDate: true } } },
      orderBy: [{ dueDate: 'asc' }, { id: 'asc' }],
      take: PAYABLES_MAX + 1,
    }))
    const owed = payablesView(found.slice(0, PAYABLES_MAX), { today, amountsVisible, namesVisible }).filter(bySupplier)
    const overdue = owed.filter((row) => row.overdueDays > 0)
    const partial = found.length > PAYABLES_MAX ? { onlyFirstInvoices: PAYABLES_MAX } : {}
    const base = { asOf: today, ...hidden, ...partial }
    if (view === 'overdue' || view === 'owed') {
      const rows = view === 'overdue' ? overdue : owed
      return { ...base, basis: `${PAYABLES_BASIS.owed} ${view === 'overdue' ? PAYABLES_BASIS.overdue : ''}`.trim(), totals: totalsOf(rows, amountsVisible), ...aiToolList(rows.map(withoutAmount), args.limit) }
    }
    if (view === 'by_supplier') {
      const groups = new Map()
      for (const row of owed) {
        const key = `${row.supplier}\u0000${row.currency}`
        const entry = groups.get(key) || { supplier: row.supplier, currency: row.currency, invoices: 0, amount: 0, overdueInvoices: 0, overdueAmount: 0, oldestDueDate: null }
        entry.invoices += 1
        entry.amount += row.amount
        if (row.overdueDays > 0) { entry.overdueInvoices += 1; entry.overdueAmount += row.amount }
        if (row.dueDate && (!entry.oldestDueDate || row.dueDate < entry.oldestDueDate)) entry.oldestDueDate = row.dueDate
        groups.set(key, entry)
      }
      const rows = [...groups.values()].sort((a, b) => b.amount - a.amount || text(a.supplier).localeCompare(text(b.supplier)))
        .map(({ amount, overdueAmount, ...entry }) => ({ ...entry, owed: amountsVisible ? money(amount) : null, overdue: amountsVisible ? money(overdueAmount) : null }))
      return { ...base, basis: PAYABLES_BASIS.owed, totals: totalsOf(owed, amountsVisible), ...aiToolList(rows, args.limit) }
    }
    // The summary: owed, overdue, due soon; held at the match; not invoiced.
    const soon = addCalendarDays(today, DUE_SOON_DAYS)
    const dueSoon = owed.filter((row) => !(row.overdueDays > 0) && row.dueDate && row.dueDate <= soon)
    const owedBy = tally(owed)
    const overdueBy = tally(overdue)
    const soonBy = tally(dueSoon)
    const totals = [...owedBy.values()].map((entry) => ({
      currency: entry.currency,
      owedInvoices: entry.count, owed: amountsVisible ? money(entry.amount) : null,
      overdueInvoices: overdueBy.get(entry.currency)?.count || 0, overdue: amountsVisible ? money(overdueBy.get(entry.currency)?.amount || 0) : null,
      dueIn7DaysInvoices: soonBy.get(entry.currency)?.count || 0, dueIn7Days: amountsVisible ? money(soonBy.get(entry.currency)?.amount || 0) : null,
      paymentHeldInvoices: owed.filter((row) => row.currency === entry.currency && row.paymentHeld).length,
    }))
    const held = can(context, 'finance.supplier_invoice.read')
      ? array(await context.prisma.supplierInvoice.findMany({ where: { tenantId: context.tenantId, status: 'exception' }, select: { supplierName: true, totalAmount: true, amount: true, currency: true } }))
        .map((row) => ({ supplier: row.supplierName, currency: text(row.currency) || null, amount: Number(row.totalAmount ?? row.amount) || 0 }))
        .filter((row) => !args.supplier || fold(row.supplier).includes(fold(args.supplier)))
      : null
    const notInvoiced = can(context, 'receiving.read') ? (await readNotInvoiced(context, { amountsVisible, namesVisible })).filter(bySupplier) : null
    return {
      ...base,
      basis: PAYABLES_BASIS.owed,
      totals,
      // "Due within 7 days" is a figure the result gives.
      dueSoonDays: DUE_SOON_DAYS,
      heldAtMatch: held === null ? null : totalsOf(held, amountsVisible),
      receiptsNotInvoiced: notInvoiced === null ? null : totalsOf(notInvoiced, amountsVisible).map(({ invoices, ...entry }) => ({ ...entry, receipts: invoices })),
      oldestOverdue: overdue.slice(0, 5).map(withoutAmount),
    }
  },
})

// --- cash_movements ----------------------------------------------------------

const CASH_BASIS = 'Payments recorded in FlowChain by their payment date: against customer receivables (cash in) and supplier payables (cash out); voided payments are left out. FlowChain moves no money and reads no bank account, so this is what was recorded, not a bank balance.'

// Payments by month and currency: received from customers, paid to suppliers
// and the difference.
export function cashByMonth(payments) {
  const months = new Map()
  const totals = new Map()
  for (const row of array(payments)) {
    const amount = Number(row.amount) || 0
    const currency = text(row.currency) || null
    const side = row.obligationType === 'receivable' ? 'in' : 'out'
    for (const [map, key, base] of [[months, `${day(row.paymentDate).slice(0, 7)}\u0000${currency}`, { month: day(row.paymentDate).slice(0, 7) }], [totals, currency, {}]]) {
      const entry = map.get(key) || { ...base, currency, in: 0, inCount: 0, out: 0, outCount: 0 }
      entry[side] += amount
      entry[`${side}Count`] += 1
      map.set(key, entry)
    }
  }
  const shape = (entry) => {
    const { in: received, inCount, out: paid, outCount, ...rest } = entry
    return { ...rest, receivedFromCustomers: money(received), customerPayments: inCount, paidToSuppliers: money(paid), supplierPayments: outCount, net: money(received - paid) }
  }
  return {
    totals: [...totals.values()].map(shape),
    months: [...months.values()].sort((a, b) => a.month.localeCompare(b.month) || text(a.currency).localeCompare(text(b.currency))).map(shape),
  }
}

const cashMovements = defineAiTool({
  name: 'cash_movements',
  description: 'Cash received from customers and paid to suppliers, per currency and month, from recorded payments (not a bank balance). period, or from and to (a month is its first and last day); the last 12 months by default.',
  parameters: periodParams,
  available: (_facts, context) => Boolean(context?.actor && context.prisma) && (can(context, 'finance.payable.read') || can(context, 'finance.receivable.read')),
  assistantV2Only: true,
  async run(args, { facts, context }) {
    if (!can(context, 'finance.amounts.read')) return { error: 'amounts_hidden' }
    const range = salesRange(args, workspaceDay(facts))
    if (!range) return { error: 'invalid_period' }
    const sides = [can(context, 'finance.receivable.read') ? 'receivable' : null, can(context, 'finance.payable.read') ? 'payable' : null].filter(Boolean)
    const found = array(await context.prisma.paymentRecord.findMany({
      where: { tenantId: context.tenantId, status: 'recorded', obligationType: { in: sides }, paymentDate: { gte: dayStart(range.from), lt: dayStart(addCalendarDays(range.to, 1)) } },
      select: { obligationType: true, paymentDate: true, amount: true, currency: true },
      take: PAYMENTS_MAX + 1,
    }))
    const { totals, months } = cashByMonth(found.slice(0, PAYMENTS_MAX))
    return {
      period: range, basis: CASH_BASIS,
      ...(sides.length < 2 ? { notRead: sides.includes('payable') ? 'customer_payments' : 'supplier_payments' } : {}),
      ...(found.length > PAYMENTS_MAX ? { onlyFirstPayments: PAYMENTS_MAX } : {}),
      totals,
      months: months.slice(-24),
      ...(months.length > 24 ? { earlierMonths: months.length - 24 } : {}),
    }
  },
})

// --- gross_profit ------------------------------------------------------------

const PROFIT_BASIS = `Sales: ${SALES_BASIS} Cost: each invoiced unit at its item's preferred approved supplier's reference price (the price inventory_value uses), an estimate: FlowChain records no cost of the stock actually sold. Gross profit is sales less that cost; operating costs are not included, so it is not net profit. Lines whose item has no usable price (none, prices hidden, another currency, or sold in another unit) are counted apart and left out of the cost and of the margin.`

// Sales lines less their cost: unitCost(line) is the price per unit of the
// line, or null when it has none. Grouped by month, item or customer.
export function grossProfitOf(lines, { unitCost, by = 'total' }) {
  const total = { revenue: 0, costedRevenue: 0, cost: 0, lines: 0, uncosted: 0, uncostedRevenue: 0, uncostedSkus: new Set() }
  const groups = new Map()
  for (const line of array(lines)) {
    const amount = Number(line.lineAmount) || 0
    const quantity = Number(line.quantity) || 0
    const price = unitCost(line)
    const key = by === 'month' ? line.day.slice(0, 7) : by === 'item' ? fold(line.sku) : by === 'customer' ? text(line.customer) : ''
    const entry = groups.get(key) || { key, line, revenue: 0, costedRevenue: 0, cost: 0, quantity: 0, uncosted: 0 }
    for (const sum of [total, entry]) {
      sum.revenue += amount
      if (price === null) { sum.uncosted += 1; if (sum === total) { total.uncostedRevenue += amount; total.uncostedSkus.add(text(line.sku)) } continue }
      sum.costedRevenue += amount
      sum.cost += quantity * price
    }
    entry.quantity += quantity
    total.lines += 1
    groups.set(key, entry)
  }
  const figures = (sum) => ({ revenue: money(sum.revenue), cost: money(sum.cost), grossProfit: money(sum.costedRevenue - sum.cost), grossMarginPercent: percent(sum.costedRevenue - sum.cost, sum.costedRevenue) })
  const rows = by === 'total' ? [] : [...groups.values()]
    .sort(by === 'month' ? (a, b) => a.key.localeCompare(b.key) : (a, b) => (b.costedRevenue - b.cost) - (a.costedRevenue - a.cost) || a.key.localeCompare(b.key))
    .map((entry) => ({
      ...(by === 'month' ? { month: entry.key } : by === 'item' ? { sku: text(entry.line.sku), itemName: text(entry.line.itemName) || null, quantity: Math.round(entry.quantity * 10000) / 10000, unit: text(entry.line.unit) || null, ref: aiToolRef('item', entry.line.itemId || entry.line.sku, entry.line.sku) } : { customer: entry.key || null }),
      ...figures(entry),
      ...(entry.uncosted ? { linesWithoutCost: entry.uncosted } : {}),
    }))
  return {
    ...figures(total),
    ...(total.uncosted ? { costedRevenue: money(total.costedRevenue), linesWithoutCost: total.uncosted, revenueWithoutCost: money(total.uncostedRevenue), itemsWithoutCost: [...total.uncostedSkus].filter(Boolean).slice(0, 10) } : {}),
    rows,
  }
}

const grossProfit = defineAiTool({
  name: 'gross_profit',
  description: 'Gross profit and margin: customer invoice sales less the units at the preferred supplier\'s reference price (an estimate; not net profit). by total (default), month, item or customer; period, or from and to as for cash_movements.',
  parameters: {
    by: { type: 'string', enum: ['total', 'month', 'item', 'customer'] },
    ...periodParams,
    customer: { type: 'string' },
    sku: { type: 'string' },
    limit: limitParam,
  },
  available: (facts, context) => Boolean(facts?.inventory) && Boolean(context?.actor && context.prisma) && can(context, 'finance.customer_invoice.read'),
  assistantV2Only: true,
  async run(args, { facts, context }) {
    const range = salesRange(args, workspaceDay(facts))
    if (!range) return { error: 'invalid_period' }
    const item = args.sku ? salesItem(facts, args.sku) : null
    if (item?.error === 'ambiguous') return { error: 'ambiguous', candidates: item.candidates }
    const sku = item ? item.sku || text(args.sku) : null
    const found = array(await context.prisma.customerInvoice.findMany({
      where: { tenantId: context.tenantId, status: { notIn: ['draft', 'cancelled'] }, invoiceDate: { gte: dayStart(range.from), lt: dayStart(addCalendarDays(range.to, 1)) } },
      select: { id: true, customerNameSnapshot: true, invoiceDate: true, currency: true, lines: { select: { itemId: true, sku: true, itemName: true, quantity: true, unit: true, lineAmount: true } } },
      take: INVOICES_MAX + 1,
    }))
    let invoices = found.slice(0, INVOICES_MAX).filter((row) => { const dated = day(row.invoiceDate); return dated >= range.from && dated <= range.to })
    if (args.customer) invoices = invoices.filter((row) => fold(row.customerNameSnapshot).includes(fold(args.customer)))
    const amountsByCurrency = new Map()
    for (const row of invoices) amountsByCurrency.set(text(row.currency).toUpperCase(), (amountsByCurrency.get(text(row.currency).toUpperCase()) || 0) + 1)
    const workspace = text(facts.currency).toUpperCase()
    const currency = (amountsByCurrency.has(workspace) ? workspace : [...amountsByCurrency].sort((a, b) => b[1] - a[1])[0]?.[0]) || workspace || null
    const stockItems = [...array(facts.inventory?.rows), ...array(facts.inventory?.masterOnly)]
    const itemIdOf = (line) => text(line.itemId) || text(stockItems.find((row) => fold(row.sku) === fold(line.sku))?.itemId) || null
    const lines = invoices.filter((row) => text(row.currency).toUpperCase() === currency).flatMap((row) => array(row.lines)
      .filter((line) => !sku || (item?.itemId && text(line.itemId) === item.itemId) || fold(line.sku) === fold(sku))
      .map((line) => ({ ...line, itemId: itemIdOf(line), invoice: row.id, customer: text(row.customerNameSnapshot) || null, day: day(row.invoiceDate) })))
    // Each sold item's cost per stock unit, from its preferred approved source.
    const ids = [...new Set(lines.map((line) => line.itemId).filter(Boolean))].slice(0, COSTED_ITEMS_MAX)
    const stored = await storedItems(context, ids)
    const { byItem, prices } = await itemSources(context, [...stored.values()])
    const costs = new Map()
    for (const [id, stock] of stored) {
      const source = preferredSource(byItem.get(id) || [])
      const price = unitPriceOf(stock, source, prices)
      const sourceCurrency = text(source?.currency || facts.currency).toUpperCase()
      costs.set(id, price !== null && sourceCurrency === currency ? { price, unit: itemStockUnit(stock) } : null)
    }
    const unitCost = (line) => {
      const cost = line.itemId ? costs.get(line.itemId) : null
      if (!cost) return null
      return !text(line.unit) || !cost.unit || fold(line.unit) === fold(cost.unit) ? cost.price : null
    }
    const by = args.by || 'total'
    const result = grossProfitOf(lines, { unitCost, by })
    const { rows, ...figures } = result
    return {
      period: range, basis: PROFIT_BASIS, costSource: 'reference_price_of_preferred_supplier', by, currency,
      invoices: new Set(lines.map((line) => line.invoice)).size,
      ...figures,
      ...(prices ? {} : { pricesHidden: true }),
      ...(sku ? { sku } : {}),
      ...(args.customer ? { customer: args.customer } : {}),
      ...(found.length > INVOICES_MAX ? { onlyFirstInvoices: INVOICES_MAX } : {}),
      ...(by === 'total' ? {} : aiToolList(rows, args.limit)),
    }
  },
})

export const AI_ASSISTANT_V2_MONEY_TOOLS = Object.freeze([supplierPayables, cashMovements, grossProfit])
