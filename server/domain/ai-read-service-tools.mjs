import { AI_TOOL_LIMITS, aiToolList, aiToolRef, aiToolSupplier, defineAiTool } from './ai-read-tool-contract.mjs'
import { capabilityForEnvironment } from './capability-registry.mjs'
import { createContractReadService } from './contract-read-service.mjs'
import { createOperationalFinanceO2cReadService } from './operational-finance-o2c-read-service.mjs'
import { createPriceHistoryReadService } from './price-history-read-service.mjs'
import { createReorderListReadService } from './reorder-list-read-service.mjs'
import { DEMAND_WINDOW_DAYS } from './reorder-list.mjs'
import { addCalendarDays } from '../../shared/purchase-request-prefill.mjs'
import { SUPPLIER_ISSUE_TYPES, createSupplierInsightsReadService } from './supplier-insights.mjs'
import { aiSkillSpendPeriod } from './ai-skill-spend-analysis.mjs'
import { reportReadAccessFor, scopeBusinessContext } from './report-read-access.mjs'
import { searchRuntimeBusinessContext } from './runtime-business-search.mjs'
import { buildRuntimeInventoryAllocation } from './runtime-inventory-allocation-read-model.mjs'
import { readBusinessContext } from '../services/runtime-business-read-service.mjs'
import { CONTRACT_STATES } from '../../shared/contract-status.mjs'
import { answerKnowledgeQuery, createKnowledgeService } from './ai-knowledge-service.mjs'
import { knowledgeProviderEnv } from './ai-knowledge-config.mjs'

// Read tools that need more than the user's facts (docs/ai-model-first-design.md
// §4): the request's context (the actor, the database and the route context
// from loadAiSkillContext), passed to runAiReadTool as `context`. Each tool is
// offered only when the user holds its read permission, and the read service
// it wraps checks that permission again, as its own route does. Services can
// be injected through context.routeContext.aiReadServices (tests). Two
// services were found on 2026-10-28 to check no permission code of their own
// (inventory balances and the purchase order receiving summary); no tool here
// uses them.

const text = (value) => String(value ?? '').trim()
const array = (value) => (Array.isArray(value) ? value : [])
const fold = (value) => text(value).toLowerCase()
const stockRowOf = (facts, sku) => array(facts?.inventory?.rows).find((row) => fold(row.sku) === fold(sku)) || null
const limitParam = { type: 'integer', minimum: 1, maximum: AI_TOOL_LIMITS.maxRows, description: `How many rows to return, ${AI_TOOL_LIMITS.rows} by default.` }
const can = (context, permission) => Boolean(context?.actor?.permissionCodes?.has?.(permission))
const serviceOf = (context, name, create) => context?.routeContext?.aiReadServices?.[name] || create({ prisma: context.prisma, env: context.routeContext?.env || process.env, now: () => context.now })
const identityOf = (context) => ({ identity: context.routeContext?.identity })
// A row's own values (text, numbers, true or false, dates as text), without
// nested records, ids of other tables or free-text fields that could carry
// instructions.
const primitives = (row, keep) => Object.fromEntries(keep.filter((key) => row?.[key] !== undefined && (row[key] === null || typeof row[key] !== 'object')).map((key) => [key, row[key]]))
// Payment terms with their code, name and days, from the workspace's own
// terms. A contract holds a term's id or its code, as the contract commands
// accept either (contract-command-service.mjs); one the workspace does not
// hold is given as its code.
async function paymentTermsOf(context, keys) {
  const wanted = [...new Set(keys.map(text).filter(Boolean))]
  if (!wanted.length || typeof context.prisma?.paymentTerm?.findMany !== 'function') return new Map()
  const rows = await context.prisma.paymentTerm.findMany({ where: { tenantId: context.tenantId, OR: [{ id: { in: wanted } }, { code: { in: wanted } }] }, select: { id: true, code: true, name: true, days: true } })
  const terms = new Map()
  for (const row of rows) for (const key of [row.code, row.id]) terms.set(key, { code: row.code, name: row.name, days: row.days ?? null })
  return terms
}

// The user's business context, scoped as the reports scope it, read once per
// request: the record search, the reorder list and the order plan read it.
const scoped = new WeakMap()
export function scopedBusiness(context) {
  if (!scoped.has(context)) {
    scoped.set(context, (async () => {
      const access = context.routeContext?.reportReadAccess || reportReadAccessFor(context.actor)
      const readCtx = { ...context.routeContext, identity: { ...context.routeContext?.identity, tenantId: context.tenantId } }
      const allocationContext = context.routeContext?.aiSkillBusinessContext || await readBusinessContext(readCtx, { warehouseIds: access.warehouseIds })
      return { access, allocationContext, business: scopeBusinessContext(allocationContext, access) }
    })())
  }
  return scoped.get(context)
}

const searchRecords = defineAiTool({
  name: 'search_records',
  description: 'Finds records by number or name across what the user may read: items, suppliers, customers, sales orders, purchase requests, RFQs, purchase orders and warehouses. Use it to find a record the question names before reading it.',
  parameters: { query: { type: 'string', maxLength: 80, description: 'A number, code or part of a name.' }, limit: limitParam },
  required: ['query'],
  available: (_facts, context) => Boolean(context?.actor),
  async run(args, { context }) {
    const { business } = await scopedBusiness(context)
    const results = searchRuntimeBusinessContext(business, args.query, { limit: AI_TOOL_LIMITS.maxRows })
    return aiToolList(results.map((row) => ({ type: row.entityType, number: row.number || row.entityId, name: row.label, status: row.status || null, ref: aiToolRef(row.entityType, row.entityId, NAMED_RECORDS.has(row.entityType) ? row.label : row.number || row.entityId) })), args.limit)
  },
})
// Records a link names by their name: their id is internal. Documents are
// named by their number, and items by their SKU.
const NAMED_RECORDS = new Set(['supplier', 'customer', 'warehouse'])

// A row's suggested reorder point with what it rests on, in words the
// assistant can repeat; reason says why there is none.
const suggestionFacts = (suggestion) => ({
  ...primitives(suggestion, ['recordedBelow', 'coverDays', 'leadTimeDays', 'reviewDays', 'shipmentDays', 'reason']),
  basis: suggestion.suggestedReorderPoint === null
    ? 'No suggestion; reason says why.'
    : `Enough for the next ${suggestion.coverDays} days (lead time ${suggestion.leadTimeDays} + ${suggestion.reviewDays} review days) in 5 of 6 past ${suggestion.coverDays}-day stretches of the last ${suggestion.historyDays} days of shipments. A suggestion only; nothing changes until a person sets the reorder point on the item.`,
})

// The preferred supplier's lead time and minimum order come from the item's
// supplier link (preferredSupplierFor in reorder-list.mjs), so they are read
// from the row's supplier, never from the row itself.
const reorderList = defineAiTool({
  name: 'reorder_list',
  description: 'The reorder list as the inventory page shows it: the items to order now or soon, by the day they must be ordered, with the preferred supplier, its lead time and minimum order quantity, and the quantity it suggests (raised to the minimum when the shortfall is smaller). The stock position is on hand minus reserved plus every open purchase order line, whatever its due date; a line past its due date is marked late and still counts. Safety stock is judged on the stock available now (on hand less reserved), the reorder point on the stock position (adding open orders): an item can be below safety stock while its open orders cover the reorder point. safetyStock and belowSafetyStock give that judgement for each row. Flags name late lines and lines it could not count. counts gives how many rows are to order now and how many suggested quantities were raised to the supplier minimum: use them instead of counting rows. Two dates, never one for the other: orderByDate is the last day to place the order (最晚下单日); needByDate, on a row to order now, is when the goods would arrive if ordered today, today plus the lead time (需求日期); a row not due has none, so give it no need-by date. Filter by SKU or supplier. Transfers between warehouses are not considered.',
  parameters: {
    sku: { type: 'string', description: 'Only this SKU.' },
    supplier: { type: 'string', description: 'Only items whose preferred supplier is this one: a name or code.' },
    limit: limitParam,
  },
  available: (facts, context) => Boolean(facts?.inventory) && Boolean(context?.actor) && can(context, 'inventory.balance.read'),
  async run(args, { facts, context }) {
    const { access, allocationContext, business } = await scopedBusiness(context)
    const allocation = buildRuntimeInventoryAllocation(access.collections.inventoryItems ? allocationContext : business)
    const list = await serviceOf(context, 'reorderList', createReorderListReadService).read({
      tenantId: context.tenantId, warehouseIds: access.warehouseIds ?? null, today: facts.today, timeZone: facts.timezone,
      allocationRows: allocation.availability, showPurchaseOrders: Boolean(access.collections.purchaseOrders),
      truncatedSubjects: array(allocationContext.truncatedSubjects).filter((entry) => ['inventory_items', 'sales_orders', 'purchase_orders'].includes(entry?.subject)),
    })
    let listed = array(list.rows)
    if (args.sku) listed = listed.filter((row) => fold(row.sku) === fold(args.sku))
    if (args.supplier) {
      // Among the suppliers the user may read when the facts hold them;
      // otherwise among the preferred suppliers the list names.
      const named = [...new Map(listed.filter((row) => row.supplier?.id).map((row) => [row.supplier.id, row.supplier])).values()]
      const found = aiToolSupplier(Array.isArray(facts.suppliers) ? facts : { suppliers: named }, args.supplier)
      if (!found.supplier) return { error: found.error, candidates: found.candidates || [] }
      listed = listed.filter((row) => text(row.supplier?.id) === found.supplier.id)
    }
    const rows = listed.map((row) => ({
      ...primitives(row, ['sku', 'itemName', 'name', 'unit', 'orderByDate', 'orderNow', 'daysUntilOrderBy', 'onHand', 'reserved', 'incoming', 'position', 'reorderPoint', 'shortfall']),
      // One decimal as the model reads it ("7.1556 件" was copied as is).
      averageDailyDemand: row.demand?.averageDailyDemand === null || row.demand?.averageDailyDemand === undefined ? null : Math.round(Number(row.demand.averageDailyDemand) * 10) / 10,
      supplier: text(row.supplier?.name) || null,
      // availableToday is the stock that judgement uses, given so an answer
      // can say it (2026-11-09 on Flash: "48 pcs available" in a reorder
      // answer was flagged, as no result held it).
      ...(() => { const stock = stockRowOf(facts, row.sku); const safety = stock?.safetyStock ?? null; const available = Number.isFinite(Number(row.onHand)) ? Number(row.onHand) - (Number(row.reserved) || 0) : null; return { safetyStock: safety, availableToday: available, belowSafetyStock: safety !== null && available !== null ? available < safety : null } })(),
      leadTimeDays: row.supplier?.leadTimeDays ?? null,
      // When an order placed today would arrive (the request's need-by date),
      // beside orderByDate, the last day to order: on 2026-11-04 an answer
      // gave the order-by day as the need-by day.
      // Only on a row to order now: for one not due, today plus the lead time
      // fell before its order-by day plus the lead time and read as wrong.
      needByDate: row.orderNow === true && Number.isInteger(row.supplier?.leadTimeDays) && /^\d{4}-\d{2}-\d{2}$/.test(text(facts.today)) ? addCalendarDays(facts.today, row.supplier.leadTimeDays) : null,
      minimumOrderQuantity: row.supplier?.minimumOrderQuantity ?? null,
      moqUnit: row.supplier?.moqUnit ?? null,
      requestQuantity: row.purchaseRequest?.quantity ?? null,
      raisedToMinimum: Boolean(row.purchaseRequest?.raisedToMinimum),
      flags: array(row.flags).map((flag) => primitives(flag, ['code', 'orderNumber', 'unit', 'dueDay', 'count'])),
      incomingLines: array(row.incomingLines).map((line) => primitives(line, ['orderNumber', 'remaining', 'dueDay', 'late'])),
      // The suggested reorder point the page shows beside the recorded one
      // (reorder-point-suggestion.mjs). A suggestion only: the row is dated
      // by the recorded reorder point until a person changes it on the item.
      suggestedReorderPoint: row.reorderPointSuggestion?.suggestedReorderPoint ?? null,
      reorderPointSuggestion: row.reorderPointSuggestion ? suggestionFacts(row.reorderPointSuggestion) : null,
      ref: aiToolRef('item', row.itemId || row.purchaseRequest?.itemId || row.sku, row.sku),
    }))
    rows.sort((a, b) => text(a.orderByDate || '9999').localeCompare(text(b.orderByDate || '9999')) || text(a.sku).localeCompare(text(b.sku)))
    // Counts over every row, so an answer reads them instead of counting
    // (2026-11-07: "10 of the 12 were raised to the minimum" when 11 were).
    const counts = { orderNow: rows.filter((row) => row.orderNow === true).length, raisedToMinimum: rows.filter((row) => row.raisedToMinimum).length }
    return { asOf: facts.asOf, summary: list.summary && typeof list.summary === 'object' ? primitives(list.summary, Object.keys(list.summary)) : null, notJudged: array(list.notJudged).length, limitations: array(list.dataLimitations), counts, demandWindowDays: DEMAND_WINDOW_DAYS, ...aiToolList(rows, args.limit) }
  },
})

// Every page of a receivables list, up to a bound: a total by customer, or
// one customer's items, must count them all, not the first 100 (2026-11-07:
// "Which customer owes us the most?" read 100 of 542 open items).
const RECEIVABLE_PAGES_MAX = 100
async function allReceivables(service, query, context) {
  const rows = []
  let total = 0
  for (let page = 1; page <= RECEIVABLE_PAGES_MAX; page += 1) {
    const result = await service.listReceivables({ ...query, page, pageSize: 100 }, identityOf(context))
    total = result.total ?? total
    rows.push(...array(result.items))
    if (array(result.items).length < 100 || rows.length >= total) break
  }
  return { rows, total, complete: rows.length >= total }
}
const amountOf = (value) => Number(value) || 0

const listReceivables = defineAiTool({
  name: 'list_receivables',
  description: 'What customers owe: open receivables from customer invoices with the amount outstanding, the amount paid, the due date and any dispute, an aging summary by currency (current, 1-30, 31-60, 61-90 and over 90 days past due), or by_customer: what each customer owes over every open item (balance, items, overdue amount, oldest due date), largest first. Items soonest due first.',
  parameters: {
    view: { type: 'string', enum: ['items', 'aging', 'by_customer'], description: 'items (default), aging, or by_customer for "who owes us the most".' },
    status: { type: 'string', enum: ['open', 'overdue', 'disputed', 'all'], description: 'For items: open by default.' },
    customer: { type: 'string', description: 'Part of a customer name.' },
    limit: limitParam,
  },
  available: (_facts, context) => Boolean(context?.actor) && can(context, 'finance.receivable.read'),
  async run(args, { facts, context }) {
    const service = serviceOf(context, 'receivables', createOperationalFinanceO2cReadService)
    if (args.view === 'aging') {
      const aging = await service.aging({}, identityOf(context))
      return { aging: array(aging.groups || aging.items || aging.currencies).map((group) => primitives(group, ['currency', 'current', '1_30', '31_60', '61_90', '90_plus', 'total', 'count'])), asOf: aging.asOf || null }
    }
    if (args.view === 'by_customer') {
      const { rows: all, complete } = await allReceivables(service, { status: '' }, context)
      const today = text(facts?.today || facts?.asOf).slice(0, 10)
      const groups = new Map()
      for (const row of all) {
        const owed = amountOf(row.outstandingAmount)
        if (!(owed > 0)) continue
        if (args.customer && !fold(row.customerName).includes(fold(args.customer))) continue
        const key = `${text(row.customerName)}\u0000${text(row.currency)}`
        const entry = groups.get(key) || { customer: text(row.customerName) || null, currency: text(row.currency) || null, balance: 0, items: 0, overdueAmount: 0, oldestDueDate: null }
        const due = text(row.dueDate).slice(0, 10)
        entry.balance += owed
        entry.items += 1
        if (due && today && due < today) entry.overdueAmount += owed
        if (due && (!entry.oldestDueDate || due < entry.oldestDueDate)) entry.oldestDueDate = due
        groups.set(key, entry)
      }
      const customers = [...groups.values()].sort((a, b) => b.balance - a.balance || text(a.customer).localeCompare(text(b.customer))).map((entry) => ({ ...entry, balance: money2(entry.balance), overdueAmount: money2(entry.overdueAmount) }))
      const totals = new Map()
      for (const entry of customers) {
        const sum = totals.get(entry.currency) || { currency: entry.currency, balance: 0, items: 0, customers: 0 }
        sum.balance += entry.balance
        sum.items += entry.items
        sum.customers += 1
        totals.set(entry.currency, sum)
      }
      return { asOf: today || null, totals: [...totals.values()].map((sum) => ({ ...sum, balance: money2(sum.balance) })), ...(complete ? {} : { onlyFirstItems: all.length }), ...aiToolList(customers, args.limit) }
    }
    const status = args.status || 'open'
    const query = { status: status === 'all' || status === 'disputed' ? '' : status, ...(status === 'disputed' ? { disputeStatus: 'open' } : {}) }
    // One customer's items from every page; otherwise the first page.
    const page = args.customer ? await allReceivables(service, query, context) : await service.listReceivables({ ...query, pageSize: 100 }, identityOf(context)).then((result) => ({ rows: array(result.items), total: result.total }))
    let rows = page.rows
    if (args.customer) rows = rows.filter((row) => fold(row.customerName).includes(fold(args.customer)))
    return {
      total: args.customer ? rows.length : page.total,
      ...aiToolList(rows.map((row) => ({
        ...primitives(row, ['obligationNumber', 'customerInvoiceNumber', 'customerName', 'outstandingAmount', 'paidAmount', 'originalAmount', 'currency', 'dueDate', 'status', 'disputeStatus']),
        ref: aiToolRef('receivable', row.id, row.obligationNumber || row.customerInvoiceNumber),
      })), args.limit),
    }
  },
})

// Completed sales from customer invoices (2026-11-07: "上个月销售额是多少？",
// top customers and best-selling items had no tool, on two years of invoices).
// Invoices dated in the period, not drafts or cancelled, before tax; credit
// notes are not subtracted. Amounts are never added across currencies.
const SALES_PERIODS = ['this_month', 'last_month', 'this_quarter', 'last_quarter', 'this_year', 'last_year', 'last_30_days', 'last_90_days', 'last_12_months']
const SALES_DAYS = Object.freeze({ last_30_days: 30, last_90_days: 90, last_12_months: 365 })
const SALES_INVOICES_MAX = 20000
const SALES_BASIS = 'Customer invoices dated in the period, not drafts or cancelled, before tax. Credit notes are not subtracted.'
const money2 = (value) => Math.round(value * 100) / 100
const share = (part, whole) => (whole > 0 ? Math.round((part / whole) * 1000) / 10 : null)
const salesDay = (value) => (value instanceof Date ? value.toISOString() : text(value)).slice(0, 10)
function salesRange(args, today) {
  if (args.from || args.to) return args.from && args.to && args.from <= args.to ? { from: args.from, to: args.to } : null
  const period = args.period || 'last_12_months'
  return aiSkillSpendPeriod(SALES_DAYS[period] ? { kind: 'last_days', days: SALES_DAYS[period] } : { kind: period }, today)
}
const salesSummary = defineAiTool({
  name: 'sales_summary',
  description: 'Completed sales from customer invoices over a period: the total, and the largest customers or items, or each month, by invoiced amount with each one\'s share (and, for customers and items, a rank, 1 the largest, with runningAmount and runningSharePercent: the rows up to and including it together, so the top N together are the figures at rank N). Invoices dated in the period, not drafts or cancelled, before tax; credit notes are not subtracted. For "last month\'s sales", "our top customers this quarter" or "which products sold most".',
  parameters: {
    by: { type: 'string', enum: ['customer', 'item', 'month'], description: 'customer (default), item or month.' },
    period: { type: 'string', enum: SALES_PERIODS, description: 'Counted from the workspace day; last_12_months by default.' },
    from: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: 'A first day, with to, instead of period.' },
    to: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: 'The last day, included.' },
    customer: { type: 'string', description: 'Only this customer (part of its name).' },
    sku: { type: 'string', description: 'Only this item.' },
    currency: { type: 'string', pattern: '^[A-Z]{3}$', description: 'A currency code; the workspace currency by default.' },
    limit: limitParam,
  },
  available: (_facts, context) => Boolean(context?.actor && context.prisma) && can(context, 'finance.customer_invoice.read'),
  async run(args, { facts, context }) {
    const range = salesRange(args, salesDay(facts.today || facts.asOf))
    if (!range) return { error: 'invalid_period' }
    const found = array(await context.prisma.customerInvoice.findMany({
      where: { tenantId: context.tenantId, status: { notIn: ['draft', 'cancelled'] }, invoiceDate: { gte: new Date(`${range.from}T00:00:00Z`), lt: new Date(`${addCalendarDays(range.to, 1)}T00:00:00Z`) } },
      select: { id: true, customerNameSnapshot: true, invoiceDate: true, subtotalAmount: true, currency: true, lines: { select: { itemId: true, sku: true, itemName: true, quantity: true, unit: true, lineAmount: true } } },
      take: SALES_INVOICES_MAX + 1,
    }))
    let invoices = found.slice(0, SALES_INVOICES_MAX).map((row) => ({ id: text(row.id), customer: text(row.customerNameSnapshot) || null, day: salesDay(row.invoiceDate), amount: Number(row.subtotalAmount) || 0, currency: text(row.currency).toUpperCase() || null, lines: array(row.lines) }))
    if (args.customer) invoices = invoices.filter((row) => fold(row.customer).includes(fold(args.customer)))
    const currencies = new Map()
    for (const row of invoices) {
      const entry = currencies.get(row.currency) || { currency: row.currency, invoices: 0, amount: 0 }
      entry.invoices += 1
      entry.amount += row.amount
      currencies.set(row.currency, entry)
    }
    const workspace = text(facts.currency).toUpperCase()
    const currency = args.currency || (currencies.has(workspace) ? workspace : [...currencies.values()].sort((a, b) => b.amount - a.amount)[0]?.currency) || workspace || null
    // Each sale counted: the invoice, or its lines for one item.
    const sales = invoices.filter((row) => row.currency === currency).flatMap((row) => (args.sku || args.by === 'item'
      ? row.lines.filter((line) => !args.sku || fold(line.sku) === fold(args.sku)).map((line) => ({ invoice: row.id, customer: row.customer, day: row.day, amount: Number(line.lineAmount) || 0, quantity: Number(line.quantity) || 0, sku: text(line.sku), itemName: text(line.itemName) || null, unit: text(line.unit) || null, itemId: text(line.itemId) || null }))
      : [{ invoice: row.id, customer: row.customer, day: row.day, amount: row.amount }]))
    const total = sales.reduce((sum, row) => sum + row.amount, 0)
    const by = args.by || 'customer'
    const groups = new Map()
    for (const row of sales) {
      const key = by === 'item' ? fold(row.sku) : by === 'month' ? row.day.slice(0, 7) : text(row.customer)
      const entry = groups.get(key) || { key, row, invoices: new Set(), amount: 0, quantity: 0 }
      entry.invoices.add(row.invoice)
      entry.amount += row.amount
      entry.quantity += row.quantity || 0
      groups.set(key, entry)
    }
    // Customers and items, largest first, carry the share of all the rows up
    // to them (2026-11-07: "前五大客户合计" was summed by the model, written as
    // 25.4% and corrected to 29.4% in the same answer).
    let running = 0
    const rows = [...groups.values()]
      .sort(by === 'month' ? (a, b) => a.key.localeCompare(b.key) : (a, b) => b.amount - a.amount || a.key.localeCompare(b.key))
      .map((entry, index) => ({
        ...(by === 'month' ? {} : { rank: index + 1 }),
        ...(by === 'item' ? { sku: entry.row.sku, itemName: entry.row.itemName, quantity: Math.round(entry.quantity * 10000) / 10000, unit: entry.row.unit, ref: aiToolRef('item', entry.row.itemId || entry.row.sku, entry.row.sku) }
          : by === 'month' ? { month: entry.key } : { customer: entry.key || null }),
        invoices: entry.invoices.size, amount: money2(entry.amount), sharePercent: share(entry.amount, total),
        ...(by === 'month' ? {} : { runningAmount: money2((running += entry.amount)), runningSharePercent: share(running, total) }),
      }))
    return {
      period: range, basis: SALES_BASIS, by, currency,
      invoices: new Set(sales.map((row) => row.invoice)).size,
      amount: money2(total),
      ...(args.sku ? { sku: args.sku, quantity: Math.round(sales.reduce((sum, row) => sum + row.quantity, 0) * 10000) / 10000 } : {}),
      ...(args.customer ? { customer: args.customer } : {}),
      otherCurrencies: [...currencies.values()].filter((entry) => entry.currency !== currency).map((entry) => ({ currency: entry.currency, invoices: entry.invoices, amount: money2(entry.amount) })),
      ...(found.length > SALES_INVOICES_MAX ? { onlyFirstInvoices: SALES_INVOICES_MAX } : {}),
      ...aiToolList(rows, args.limit),
    }
  },
})

// A contract's money and dates as the contract service returns them: the
// total value is null, and named in restrictedFields, for a user without
// procurement.prices.read (maskContract). K1 stores no per-item prices. The
// title and their reference are short entered text, which the loop hands to
// the model as data; the notes are not passed.
const listContracts = defineAiTool({
  name: 'list_contracts',
  description: 'Signed supplier contracts: number, title, their reference, type, supplier, state, start, end and signing dates, notice period, renewal, total contract value with its currency, and payment terms, soonest key date first. Contracts hold no per-item prices; use price_history for what an item cost. The total value is null for users who may not see prices. Filter by supplier, state or words.',
  parameters: {
    supplier: { type: 'string', description: 'A supplier name or code.' },
    state: { type: 'string', enum: CONTRACT_STATES },
    search: { type: 'string', maxLength: 80 },
    limit: limitParam,
  },
  available: (_facts, context) => Boolean(context?.actor) && can(context, 'contracts.contract.read') && Boolean(capabilityForEnvironment('contracts', context.routeContext?.env || process.env)?.enabled),
  async run(args, { facts, context }) {
    let supplierId = ''
    if (args.supplier) {
      const found = aiToolSupplier(facts, args.supplier)
      if (!found.supplier) return { error: found.error, candidates: found.candidates || [] }
      supplierId = found.supplier.id
    }
    const page = await serviceOf(context, 'contracts', createContractReadService).list({ search: args.search || '', state: args.state || '', supplierId, sort: 'key_date', pageSize: 100 }, identityOf(context))
    const contracts = array(page.contracts)
    const terms = await paymentTermsOf(context, contracts.map((row) => row.paymentTermsId))
    return {
      today: page.today,
      counts: page.counts,
      pricesHidden: !page.access?.prices,
      ...aiToolList(contracts.map((row) => ({
        ...primitives(row, ['number', 'title', 'externalReference', 'type', 'status', 'state', 'startDate', 'endDate', 'signedOn', 'noticeDays', 'counterpartyType', 'totalValue', 'currency']),
        supplier: text(row.supplier?.name) || null,
        paymentTerms: row.paymentTermsId ? terms.get(row.paymentTermsId) || { code: row.paymentTermsId } : null,
        renewal: row.renewal && typeof row.renewal === 'object' ? primitives(row.renewal, ['type', 'term', 'termMonths', 'noticeDate']) : row.renewal ?? null,
        ref: aiToolRef('contract', row.id, row.number),
      })), args.limit),
    }
  },
})

const priceHistory = defineAiTool({
  name: 'price_history',
  description: 'What the workspace paid for an item on purchase orders: the latest price with its order and day, earlier prices, the quantity-weighted average, and the last order with each supplier. In one currency and the item\'s unit; prices are hidden from users who may not see them.',
  parameters: {
    sku: { type: 'string', description: 'The item\'s SKU.' },
    supplier: { type: 'string', description: 'Only this supplier\'s prices.' },
    currency: { type: 'string', pattern: '^[A-Z]{3}$', description: 'The workspace currency by default.' },
  },
  required: ['sku'],
  available: (facts, context) => Boolean(facts?.purchaseOrders) && Boolean(context?.actor) && can(context, 'procurement.purchase_order.read'),
  async run(args, { facts, context }) {
    const item = [...array(facts.inventory?.rows), ...array(facts.inventory?.masterOnly)].find((row) => fold(row.sku) === fold(args.sku))
    const itemId = text(item?.itemId)
    if (!itemId) return { error: 'not_found' }
    let supplierId = null
    if (args.supplier) {
      const found = aiToolSupplier(facts, args.supplier)
      if (!found.supplier) return { error: found.error, candidates: found.candidates || [] }
      supplierId = found.supplier.id
    }
    const service = serviceOf(context, 'priceHistory', createPriceHistoryReadService)
    const currency = args.currency || facts.currency
    const [read, last] = await Promise.all([
      service.read([`${itemId}|${text(item.unit)}|${currency}`], identityOf(context), { supplierId }),
      service.lastOrders(itemId, identityOf(context)),
    ])
    const history = array(read.histories)[0] || {}
    const fact = (row) => (row ? { ...primitives(row, ['unitPrice', 'currency', 'unit', 'orderedQuantity', 'date', 'orderNumber', 'supplierName']), ref: aiToolRef('purchase_order', row.purchaseOrderId, row.orderNumber) } : null)
    const supplierName = (id) => array(facts.suppliers).find((row) => row.id === id)?.name || null
    return {
      sku: item.sku, unit: history.unit ?? null, currency: history.currency ?? currency, status: history.status ?? null,
      latest: fact(history.latest), earlier: array(history.earlier).map(fact), average: history.average ? primitives(history.average, ['unitPrice', 'quantity', 'orderedQuantity', 'count', 'lineCount']) : null,
      otherCurrencies: array(history.otherCurrencies), otherUnits: array(history.otherUnits),
      pricesHidden: Boolean(read.restrictedFields?.length),
      lastOrderBySupplier: array(last.lastOrders).map((row) => ({ supplier: supplierName(row.supplierId), orderNumber: row.orderNumber, day: row.day, ref: aiToolRef('purchase_order', row.purchaseOrderId, row.orderNumber) })),
    }
  },
})

// The Supplier risks page (supplier-insights.mjs readRisks), read as the page
// reads it for this user: each supplier's open issues, earliest date first,
// never a score (owner rule 2026-10-03). The issues come from the kinds of
// records the user may read; the others are named in `hidden`.
const supplierRisks = defineAiTool({
  name: 'supplier_risks',
  description: 'The Supplier risks list: each supplier\'s open issues (overdue purchase orders, rejected receipt quantities, receipts received but not posted, supplier invoice variances) with a count per supplier, earliest date first. It does not score or rank suppliers. Filter by supplier or issue type. Record kinds the user may not read are named in hidden: their issues are missing, not zero.',
  parameters: {
    supplier: { type: 'string', description: 'A supplier name or code.' },
    type: { type: 'string', enum: SUPPLIER_ISSUE_TYPES },
    limit: limitParam,
  },
  available: (_facts, context) => {
    if (!context?.actor || !(context.prisma || context.routeContext?.aiReadServices?.supplierInsights)) return false
    const { collections = {} } = context.routeContext?.reportReadAccess || reportReadAccessFor(context.actor)
    return Boolean(collections.purchaseOrders || collections.receipts || collections.supplierInvoices)
  },
  async run(args, { facts, context }) {
    const read = await serviceOf(context, 'supplierInsights', createSupplierInsightsReadService).readRisks(context.routeContext)
    let rows = array(read.issues)
    if (args.supplier) {
      // Among the suppliers the user may read when the facts hold them;
      // otherwise among the suppliers the list names.
      const listed = [...new Map(rows.map((row) => [row.supplierId, { id: row.supplierId, code: row.supplierCode, name: row.supplierName }])).values()]
      const found = aiToolSupplier(Array.isArray(facts?.suppliers) ? facts : { suppliers: listed }, args.supplier)
      if (found.supplier) rows = rows.filter((row) => row.supplierId === found.supplier.id)
      else if (Array.isArray(facts?.suppliers) || found.error === 'supplier_ambiguous') return { error: found.error, candidates: found.candidates || [] }
      else rows = []
    }
    if (args.type) rows = rows.filter((row) => row.type === args.type)
    const bySupplier = new Map()
    for (const row of rows) {
      const entry = bySupplier.get(row.supplierId) || { supplier: row.supplierName, code: row.supplierCode, issues: 0, byType: {}, ref: aiToolRef('supplier', row.supplierId, row.supplierName) }
      entry.issues += 1
      entry.byType[row.type] = (entry.byType[row.type] || 0) + 1
      bySupplier.set(row.supplierId, entry)
    }
    return {
      asOf: read.asOf,
      hidden: Object.entries(read.visibility || {}).filter(([key, visible]) => key !== 'issues' && !visible).map(([key]) => key),
      suppliers: [...bySupplier.values()],
      ...aiToolList(rows.map((row) => ({ supplier: row.supplierName, type: row.type, record: row.label, when: row.when ?? null, ...row.data, ref: aiToolRef(row.entityType, row.entityId, row.label) })), args.limit),
    }
  },
})

// The workspace's own documents (policies, product guides, procedures), as
// the knowledge search for agent planning reads them (aiAgentKnowledge,
// PR-3): only the documents the user may read, passages with their document
// and section, and no model asked to write an answer. Keyword search does not
// cross languages, so a search in Chinese over documents in English comes
// back as an error naming their language, for the model to search again.
// Passages are document text: the loop hands them to the model as data.
const CJK = /[㐀-鿿]/u
const PASSAGES = 5
const knowledge = new WeakMap()
function knowledgeOf(context) {
  if (!knowledge.has(context)) {
    knowledge.set(context, (async () => {
      const env = knowledgeProviderEnv(context.routeContext?.env || process.env)
      const service = context.routeContext?.aiReadServices?.knowledge || createKnowledgeService(context.prisma, { env })
      const documents = array((await service.list(context.actor))?.items)
      return { env, service, languages: [...new Set(documents.map((row) => (row.language === 'zh-CN' ? 'zh-CN' : 'en-US')))].sort(), count: documents.length }
    })())
  }
  return knowledge.get(context)
}
const databaseMode = (context) => context?.routeContext?.repositories?.mode === 'database' || (context?.routeContext?.env || process.env).FLOWCHAIN_PERSISTENCE_MODE === 'database'

const searchDocuments = defineAiTool({
  name: 'search_documents',
  description: 'Searches the workspace\'s own documents that the user may read (policies, product guides, procedures) and returns the matching passages with their document and section. Write the search words in the documents\' language; the result names it, and a search in another language finds nothing. State only what the passages say, citing the document and section; if they do not answer the question, say the documents do not cover it.',
  parameters: { query: { type: 'string', maxLength: 200, description: 'Search words in the documents\' language, for example "urgent purchase approval".' } },
  required: ['query'],
  available: (_facts, context) => Boolean(context?.actor && (context.prisma || context.routeContext?.aiReadServices?.knowledge)) && (databaseMode(context) || Boolean(context.routeContext?.aiReadServices?.knowledge)),
  async run(args, { context }) {
    const { env, service, languages, count } = await knowledgeOf(context)
    if (!count) return { documents: 0, passages: [], note: 'This workspace has no documents the user may read.' }
    if (CJK.test(args.query) && !languages.includes('zh-CN')) return { error: 'query_language', details: [`The documents are in ${languages.join(', ')}. A search in Chinese finds nothing in them: translate the search words and search again now, in that language.`] }
    const result = await answerKnowledgeQuery({ question: args.query, retrievalQuery: args.query, generate: false, actor: context.actor, service, env })
    const citations = array(result.citations)
    return {
      documents: count,
      documentLanguages: languages,
      found: citations.length,
      passages: citations.slice(0, PASSAGES).map((row) => ({ document: row.title, section: row.heading || null, excerpt: text(row.excerpt).slice(0, 900), ref: aiToolRef('document', row.documentId, row.title) })),
    }
  },
})

export const AI_READ_SERVICE_TOOLS = Object.freeze([searchRecords, reorderList, listReceivables, salesSummary, listContracts, priceHistory, supplierRisks, searchDocuments])
