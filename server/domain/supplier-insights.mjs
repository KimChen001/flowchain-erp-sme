import { can } from '../auth/authorization-service.mjs'
import { loadAiSkillContext } from './ai-skill-context.mjs'
import { readAiSkillFacts } from './ai-skill-readers.mjs'
import { buildAiSkillSignals, compareSignalsByDate } from './ai-skill-signals.mjs'
import { listItemSupplierRecords, mapItemSupplierRecord } from './master-data-commands.mjs'
import { isCommittedPurchaseOrder, purchaseOrderBusinessDate, reportCalendarDay } from './open-purchase-order.mjs'
import { buildOpenPurchaseOrdersReport, purchaseOrderDueDay, purchaseOrderReportLine } from './open-purchase-orders-report.mjs'
import { reportCurrencyCode } from './report-currency.mjs'
import { reportReadAccessFor } from './report-read-access.mjs'
import { SUPPLIER_SCORECARD_READ_PERMISSIONS, createSupplierScorecardReadService } from './supplier-scorecard.mjs'

// Supplier list metrics and tier suggestions (docs/supplier-tiers-design.md,
// T2). Every number reuses an existing rule:
//   spend        committed purchase orders (isCommittedPurchaseOrder) by their
//                business date over the last 12 months, per currency, never
//                added across currencies;
//   open/overdue the open purchase orders report;
//   on time      the supplier scorecard against the original promise, 90 days,
//                no rate under its minimum sample;
//   open issues  the assistant's signals (overdue orders, rejected or unposted
//                receipts, invoice variances), read through its masked facts.
// Each is computed with the reader's own access and is null when the reader
// may not see it. A suggestion is computed when read and never stored; it
// states facts, never a score, and delivery performance never changes it.
export const SUPPLIER_SUGGESTION_RULES = Object.freeze({ lookbackDays: 365, spendShare: 0.5, listedSkus: 5 })
export const SUPPLIER_ISSUE_TYPES = Object.freeze(['po_overdue', 'grn_rejected_qty', 'grn_received_unposted', 'invoice_variance'])
// The detail page's purchase records (design §5, T3).
export const SUPPLIER_ACTIVITY_LIMIT = 20

const text = (value) => String(value ?? '').trim()
const DAY = 86400000
const addDays = (day, days) => new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10)
const money = (value) => Math.round(value * 100) / 100
const listed = (skus) => {
  const sorted = [...skus].sort()
  return { skus: sorted.slice(0, SUPPLIER_SUGGESTION_RULES.listedSkus), more: Math.max(0, sorted.length - SUPPLIER_SUGGESTION_RULES.listedSkus) }
}

// Committed purchase orders per supplier id over a window of business days.
export function supplierPurchaseTotals(purchaseOrders = [], { from, to, timeZone }) {
  const totals = new Map()
  for (const po of purchaseOrders) {
    const supplierId = text(po?.supplierId)
    const day = purchaseOrderBusinessDate(po, timeZone)
    if (!supplierId || !isCommittedPurchaseOrder(po) || !day || day < from || day > to) continue
    const row = totals.get(supplierId) || { orders: 0, byCurrency: new Map(), amountKnown: true }
    row.orders += 1
    const amount = Number(po.totalAmount ?? po.amount)
    const currency = reportCurrencyCode(po.currency || po.lines?.[0]?.currency)
    if (po.totalAmount === null || po.amount === null || !Number.isFinite(amount) || !currency) row.amountKnown = false
    else row.byCurrency.set(currency, money((row.byCurrency.get(currency) || 0) + amount))
    totals.set(supplierId, row)
  }
  return totals
}

// Which active items each supplier is a source of. Only recorded links count
// as sources with or without alternatives; an item with no links and only a
// preferred supplier says nothing about alternatives ("sources not recorded").
export function supplierItemSources({ suppliers = [], items = [], links = [] }) {
  const activeSupplier = new Set(suppliers.filter((row) => text(row.status || 'active') === 'active').map((row) => row.id))
  const sourcesOf = new Map()
  for (const link of links) {
    if (link.active === false || link.approved === false || !activeSupplier.has(link.supplierId)) continue
    sourcesOf.set(link.itemId, [...new Set([...(sourcesOf.get(link.itemId) || []), link.supplierId])])
  }
  const by = () => new Map()
  const result = { only: by(), shared: by(), unrecorded: by() }
  const add = (map, supplierId, sku) => map.set(supplierId, [...(map.get(supplierId) || []), sku])
  for (const item of items) {
    if (text(item.status || 'active') !== 'active') continue
    const sku = text(item.sku || item.id)
    const sources = sourcesOf.get(item.id) || []
    if (sources.length === 1) add(result.only, sources[0], sku)
    else if (sources.length > 1) for (const supplierId of sources) add(result.shared, supplierId, sku)
    else if (text(item.preferredSupplierId)) add(result.unrecorded, text(item.preferredSupplierId), sku)
  }
  return result
}

// The suppliers that together make the first half of 12-month spend, largest
// first; the supplier that crosses half is included. With one currency and
// every amount readable the measure is the amount; otherwise it is the number
// of orders, as the reports dashboard does.
export function spendConcentration(suppliers = [], totals = new Map(), { amounts = false } = {}) {
  const rows = suppliers.map((supplier) => ({ supplier, total: totals.get(supplier.id) })).filter((row) => row.total?.orders)
  const currencies = new Set(rows.flatMap((row) => [...row.total.byCurrency.keys()]))
  const basis = amounts && currencies.size === 1 && rows.every((row) => row.total.amountKnown) ? 'amount' : 'orders'
  const [currency] = currencies
  const value = (row) => (basis === 'amount' ? row.total.byCurrency.get(currency) || 0 : row.total.orders)
  const sum = rows.reduce((total, row) => total + value(row), 0)
  const result = new Map()
  if (!sum) return result
  const ranked = [...rows].sort((a, b) => value(b) - value(a) || text(a.supplier.name).localeCompare(text(b.supplier.name)) || a.supplier.id.localeCompare(b.supplier.id))
  let before = 0
  ranked.forEach((row, index) => {
    if (before < sum * SUPPLIER_SUGGESTION_RULES.spendShare) {
      result.set(row.supplier.id, { share: Math.round((value(row) / sum) * 1000) / 1000, rank: index + 1, of: ranked.length, basis, ...(basis === 'amount' ? { currency } : {}) })
    }
    before += value(row)
  })
  return result
}

// One suggestion per supplier: Tier 1 for spend concentration or an item with
// no other approved source; Tier 3 for no committed order in 12 months and no
// item; Tier 2 otherwise. Without purchase order access only item sources can
// be seen, the suggestion says so, and it never claims "no orders".
export function suggestSupplierTiers({ suppliers = [], totals = new Map(), sources, visibility = {} }) {
  const concentration = visibility.orders ? spendConcentration(suppliers, totals, { amounts: visibility.amounts }) : new Map()
  const suggestions = new Map()
  for (const supplier of suppliers) {
    const reasons = []
    const share = concentration.get(supplier.id)
    const only = sources.only.get(supplier.id) || []
    const shared = sources.shared.get(supplier.id) || []
    const unrecorded = sources.unrecorded.get(supplier.id) || []
    const orders = totals.get(supplier.id)?.orders || 0
    const isSource = Boolean(only.length || shared.length || unrecorded.length)
    if (share) reasons.push({ code: 'spend_share', ...share })
    if (only.length) reasons.push({ code: 'only_source', ...listed(only) })
    let tier
    if (share || only.length) tier = 1
    else if (!visibility.orders) tier = isSource ? 2 : null
    else if (!orders && !isSource) tier = 3
    else tier = 2
    if (visibility.orders && !share) reasons.push(orders ? { code: 'orders', orders } : { code: 'no_orders' })
    if (tier !== 1 && shared.length) reasons.push({ code: 'other_sources', ...listed(shared) })
    if (unrecorded.length) reasons.push({ code: 'sources_not_recorded', ...listed(unrecorded) })
    if (tier === 3) reasons.push({ code: 'not_a_source' })
    suggestions.set(supplier.id, { tier, reasons, partial: !visibility.orders })
  }
  return suggestions
}

// One supplier's open issues in the assistant's date order: what the list's
// "Open issues" counts and the detail page's "Risks and exceptions" lists.
const isSupplierIssue = (signal, id) => Boolean(id) && text(signal.supplierId) === id && SUPPLIER_ISSUE_TYPES.includes(signal.type)
export function supplierIssueSignals(signals = [], supplierId) {
  const id = text(supplierId)
  return signals.filter((signal) => isSupplierIssue(signal, id)).sort(compareSignalsByDate)
}

// Per-supplier list metrics. A metric the reader may not see is null.
export function buildSupplierInsights({ suppliers = [], totals = new Map(), openRows = [], scorecard = null, signals = [], suggestions = new Map(), visibility = {} }) {
  const open = new Map()
  for (const row of openRows) {
    const supplierId = text(row.supplierId)
    if (!supplierId || !row.isOpen) continue
    const counts = open.get(supplierId) || { open: 0, overdue: 0 }
    counts.open += 1
    if (Number(row.overdueDays) > 0) counts.overdue += 1
    open.set(supplierId, counts)
  }
  const scored = new Map((scorecard?.suppliers || []).map((row) => [row.supplierId, row]))
  const issues = new Map()
  for (const supplier of suppliers) issues.set(supplier.id, signals.filter((signal) => isSupplierIssue(signal, text(supplier.id))).length)
  return Object.fromEntries(suppliers.map((supplier) => {
    const total = totals.get(supplier.id)
    const score = scored.get(supplier.id)
    return [supplier.id, {
      spend12m: visibility.amounts ? [...(total?.byCurrency || new Map())].map(([currency, amount]) => ({ currency, amount })).sort((a, b) => b.amount - a.amount || a.currency.localeCompare(b.currency)) : null,
      spendComplete: visibility.amounts ? (total?.amountKnown ?? true) : null,
      orders12m: visibility.orders ? total?.orders || 0 : null,
      openPos: visibility.orders ? open.get(supplier.id)?.open || 0 : null,
      overduePos: visibility.orders ? open.get(supplier.id)?.overdue || 0 : null,
      onTime: visibility.onTime ? { rate: score?.metrics?.onTime?.rate ?? null, count: score?.metrics?.onTime?.count ?? 0, of: score?.metrics?.onTime?.of ?? 0, sampleStatus: score?.sampleStatus || 'no_lines' } : null,
      openIssues: visibility.issues ? issues.get(supplier.id) || 0 : null,
      suggestion: suggestions.get(supplier.id) || null,
    }]
  }))
}

// A supplier's latest purchase orders, newest first by business date in the
// workspace timezone: the order's number, date, status, promised day, days
// overdue while open, and its amount only with price access. The promised day
// is the one the open purchase orders report counts days overdue from (the
// earliest line still to receive); once every line is received, the earliest
// line's day, else the order's expected date.
export function supplierPurchaseRecords(purchaseOrders = [], supplierId, { prices = false, openRows = [], timeZone } = {}) {
  const overdue = new Map(openRows.map((row) => [row.id, Number(row.overdueDays) || 0]))
  const mine = purchaseOrders.filter((po) => text(po.supplierId) === text(supplierId))
  const rows = mine
    .map((po) => ({ po, date: purchaseOrderBusinessDate(po, timeZone) || '' }))
    .sort((a, b) => b.date.localeCompare(a.date) || text(b.po.orderNumber || b.po.id).localeCompare(text(a.po.orderNumber || a.po.id)))
    .slice(0, SUPPLIER_ACTIVITY_LIMIT)
    .map(({ po, date }) => {
      const due = purchaseOrderDueDay(po) || (po.lines || []).map((line) => purchaseOrderReportLine(line, po).due).filter(Boolean).sort()[0] || reportCalendarDay(po.expectedDate) || null
      const amount = Number(po.totalAmount ?? po.amount)
      return {
        id: text(po.id),
        orderNumber: text(po.orderNumber || po.id),
        date: date || null,
        status: text(po.status),
        promisedDate: due,
        overdueDays: overdue.get(text(po.id)) || 0,
        amount: prices && Number.isFinite(amount) ? money(amount) : null,
        currency: reportCurrencyCode(po.currency || po.lines?.[0]?.currency) || null,
      }
    })
  return { rows, total: mine.length }
}

// What the detail page shows of one issue: the record, its date and its codes.
const issueRow = (signal) => ({
  id: signal.id,
  type: signal.type,
  entityType: signal.entityType,
  entityId: signal.entityId,
  label: signal.label,
  when: signal.when,
  data: Object.fromEntries(['days', 'rejected', 'unit', 'variance', 'currency'].filter((key) => signal.data?.[key] !== undefined).map((key) => [key, signal.data[key]])),
})

// Reads every supplier's metrics and suggestion for the signed-in reader.
// listPurchaseOrders is the procurement runtime's listForReport.
export function createSupplierInsightsReadService({ prisma, listPurchaseOrders, now = () => new Date() } = {}) {
  if (!prisma) throw new Error('prisma is required')
  return {
    async read(ctx) {
      const instant = now()
      const skillContext = await loadAiSkillContext({ ...ctx, aiSkillNow: instant.toISOString() })
      const { actor, tenantId, tenant, today } = skillContext
      const access = reportReadAccessFor(actor)
      const allowed = (permission) => can({ actor, permission, tenantId })
      const visibility = {
        orders: Boolean(access.collections.purchaseOrders),
        amounts: Boolean(access.collections.purchaseOrders && access.prices),
        onTime: SUPPLIER_SCORECARD_READ_PERMISSIONS.every(allowed),
        issues: Boolean(access.collections.purchaseOrders || access.collections.receipts || access.collections.supplierInvoices),
      }
      const window = { from: addDays(today, -(SUPPLIER_SUGGESTION_RULES.lookbackDays - 1)), to: today }
      const [suppliers, items, links, purchaseOrders] = await Promise.all([
        prisma.supplier.findMany({ where: { tenantId }, select: { id: true, name: true, status: true }, orderBy: [{ name: 'asc' }, { id: 'asc' }] }),
        prisma.item.findMany({ where: { tenantId }, select: { id: true, sku: true, status: true, preferredSupplierId: true } }),
        listItemSupplierRecords(prisma, tenantId).then((rows) => rows.map((row) => mapItemSupplierRecord(row))),
        visibility.orders && listPurchaseOrders ? listPurchaseOrders({ tenantId }) : [],
      ])
      const totals = supplierPurchaseTotals(purchaseOrders, { ...window, timeZone: tenant.timezone })
      const openRows = visibility.orders ? buildOpenPurchaseOrdersReport(purchaseOrders, { export: 'true' }, instant, { timeZone: tenant.timezone }).exportRows || [] : []
      const scorecard = visibility.onTime ? await createSupplierScorecardReadService({ prisma, now: () => instant }).read({}, { actor }) : null
      const signals = visibility.issues ? buildAiSkillSignals(await readAiSkillFacts(skillContext)) : []
      const sources = supplierItemSources({ suppliers, items, links })
      const suggestions = suggestSupplierTiers({ suppliers, totals, sources, visibility })
      return {
        asOf: today,
        lookbackDays: SUPPLIER_SUGGESTION_RULES.lookbackDays,
        onTimePeriod: scorecard?.period || null,
        visibility,
        suppliers: buildSupplierInsights({ suppliers, totals, openRows, scorecard, signals, suggestions, visibility }),
      }
    },
    // One supplier's purchase records and open issues for its detail page.
    // Each part follows the reader's access and is null when they may not see
    // it: purchase orders with purchase order access (amounts with prices);
    // supplier invoices with invoice access and the partner snapshot, since a
    // list of one supplier's invoices names the supplier (amounts with finance
    // amounts); issues with any source behind them, through the assistant's
    // masked facts, so the list matches the list's "Open issues".
    async readActivity(ctx, supplierId) {
      const instant = now()
      const skillContext = await loadAiSkillContext({ ...ctx, aiSkillNow: instant.toISOString() })
      const { actor, tenantId, tenant, today } = skillContext
      const access = reportReadAccessFor(actor)
      const supplier = await prisma.supplier.findFirst({ where: { tenantId, id: text(supplierId) }, select: { id: true } })
      if (!supplier) throw Object.assign(new Error('Supplier not found.'), { status: 404, code: 'SUPPLIER_NOT_FOUND' })
      const visibility = {
        orders: Boolean(access.collections.purchaseOrders),
        orderAmounts: Boolean(access.collections.purchaseOrders && access.prices),
        invoices: Boolean(access.collections.supplierInvoices && access.partner),
        invoiceAmounts: Boolean(access.collections.supplierInvoices && access.partner && access.amounts),
        issues: Boolean(access.collections.purchaseOrders || access.collections.receipts || access.collections.supplierInvoices),
      }
      const [purchaseOrders, invoices, signals] = await Promise.all([
        visibility.orders && listPurchaseOrders ? listPurchaseOrders({ tenantId }) : [],
        visibility.invoices
          ? prisma.supplierInvoice.findMany({ where: { tenantId, supplierId: supplier.id }, orderBy: [{ invoiceDate: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }], take: SUPPLIER_ACTIVITY_LIMIT + 1, select: { id: true, invoiceNumber: true, invoiceDate: true, dueDate: true, status: true, matchStatus: true, totalAmount: true, amount: true, currency: true, createdAt: true } })
          : [],
        visibility.issues ? readAiSkillFacts(skillContext).then(buildAiSkillSignals) : [],
      ])
      const mine = purchaseOrders.filter((po) => text(po.supplierId) === supplier.id)
      const openRows = visibility.orders ? buildOpenPurchaseOrdersReport(mine, { export: 'true' }, instant, { timeZone: tenant.timezone }).exportRows || [] : []
      const decimal = (value) => (value === null || value === undefined || !Number.isFinite(Number(value)) ? null : money(Number(value)))
      // Prisma returns dates; an invoice without its own date is dated by
      // when it was recorded, as the assistant dates it.
      const dayOf = (value) => reportCalendarDay(value instanceof Date ? value.toISOString() : value) || null
      return {
        asOf: today,
        supplierId: supplier.id,
        visibility,
        purchaseOrders: visibility.orders ? supplierPurchaseRecords(mine, supplier.id, { prices: visibility.orderAmounts, openRows, timeZone: tenant.timezone }) : null,
        invoices: visibility.invoices
          ? {
            rows: invoices.slice(0, SUPPLIER_ACTIVITY_LIMIT).map((row) => ({
              id: row.id,
              invoiceNumber: text(row.invoiceNumber || row.id),
              invoiceDate: dayOf(row.invoiceDate) || dayOf(row.createdAt),
              dueDate: dayOf(row.dueDate),
              status: text(row.status),
              matchStatus: text(row.matchStatus) || null,
              amount: visibility.invoiceAmounts ? decimal(row.totalAmount ?? row.amount) : null,
              currency: reportCurrencyCode(row.currency) || null,
            })),
            more: invoices.length > SUPPLIER_ACTIVITY_LIMIT,
          }
          : null,
        issues: visibility.issues ? supplierIssueSignals(signals, supplier.id).map(issueRow) : null,
      }
    },
  }
}
