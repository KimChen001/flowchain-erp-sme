import { can } from '../auth/authorization-service.mjs'
import { loadAiSkillContext } from './ai-skill-context.mjs'
import { readAiSkillFacts } from './ai-skill-readers.mjs'
import { buildAiSkillSignals } from './ai-skill-signals.mjs'
import { listItemSupplierRecords, mapItemSupplierRecord } from './master-data-commands.mjs'
import { isCommittedPurchaseOrder, purchaseOrderBusinessDate } from './open-purchase-order.mjs'
import { buildOpenPurchaseOrdersReport } from './open-purchase-orders-report.mjs'
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

const text = (value) => String(value ?? '').trim()
const DAY = 86400000
const addDays = (day, days) => new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10)
const money = (value) => Math.round(value * 100) / 100
const listed = (skus) => {
  const sorted = [...skus].sort()
  return { skus: sorted.slice(0, SUPPLIER_SUGGESTION_RULES.listedSkus), more: Math.max(0, sorted.length - SUPPLIER_SUGGESTION_RULES.listedSkus) }
}

// Committed purchase orders per supplier id over a window of business days.
export function supplierPurchaseTotals(purchaseOrders = [], { from, to }) {
  const totals = new Map()
  for (const po of purchaseOrders) {
    const supplierId = text(po?.supplierId)
    const day = purchaseOrderBusinessDate(po)
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
  for (const signal of signals) {
    const supplierId = text(signal.supplierId)
    if (!supplierId || !SUPPLIER_ISSUE_TYPES.includes(signal.type)) continue
    issues.set(supplierId, (issues.get(supplierId) || 0) + 1)
  }
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
      const totals = supplierPurchaseTotals(purchaseOrders, window)
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
  }
}
