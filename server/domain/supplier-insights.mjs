import { can } from '../auth/authorization-service.mjs'
import { loadAiSkillContext } from './ai-skill-context.mjs'
import { readAiSkillFacts } from './ai-skill-readers.mjs'
import { buildAiSkillSignals, compareSignalsByDate, compareSignalsByPrintedDate } from './ai-skill-signals.mjs'
import { isCommittedPurchaseOrder, purchaseOrderBusinessDate, reportCalendarDay } from './open-purchase-order.mjs'
import { buildOpenPurchaseOrdersReport, purchaseOrderDueDay, purchaseOrderReportLine } from './open-purchase-orders-report.mjs'
import { reportCurrencyCode } from './report-currency.mjs'
import { reportReadAccessFor } from './report-read-access.mjs'
import { SUPPLIER_SCORECARD_READ_PERMISSIONS, createSupplierScorecardReadService } from './supplier-scorecard.mjs'

// Supplier list metrics (docs/supplier-tiers-design.md, T2). Every number
// reuses an existing rule:
//   spend        committed purchase orders (isCommittedPurchaseOrder) by their
//                business date over the last 12 months, per currency, never
//                added across currencies;
//   open/overdue the open purchase orders report;
//   on time      the supplier scorecard against the original promise, 90 days,
//                counted in deliveries (one PO, one promised date), no rate
//                under its minimum sample of 5 deliveries;
//   open issues  the assistant's signals (overdue orders, rejected or unposted
//                receipts, invoice variances), read through its masked facts.
// Each is computed with the reader's own access and is null when the reader
// may not see it. FlowChain never suggests a tier: tiers differ per company
// and are set by a person (owner decision 2026-10-09).
export const SUPPLIER_SPEND_LOOKBACK_DAYS = 365
export const SUPPLIER_ISSUE_TYPES = Object.freeze(['po_overdue', 'grn_rejected_qty', 'grn_received_unposted', 'invoice_variance'])
// The detail page's purchase records (design §5, T3).
export const SUPPLIER_ACTIVITY_LIMIT = 20

const text = (value) => String(value ?? '').trim()
const DAY = 86400000
const addDays = (day, days) => new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10)
const money = (value) => Math.round(value * 100) / 100

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

// One supplier's open issues in the assistant's date order: what the list's
// "Open issues" counts and the detail page's "Risks and exceptions" lists.
const isSupplierIssue = (signal, id) => Boolean(id) && text(signal.supplierId) === id && SUPPLIER_ISSUE_TYPES.includes(signal.type)
export function supplierIssueSignals(signals = [], supplierId) {
  const id = text(supplierId)
  return signals.filter((signal) => isSupplierIssue(signal, id)).sort(compareSignalsByDate)
}

// Per-supplier list metrics. A metric the reader may not see is null.
export function buildSupplierInsights({ suppliers = [], totals = new Map(), openRows = [], scorecard = null, signals = [], visibility = {} }) {
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
      onTime: visibility.onTime ? { rate: score?.metrics?.onTime?.rate ?? null, count: score?.metrics?.onTime?.count ?? 0, of: score?.metrics?.onTime?.of ?? 0, sampleStatus: score?.sampleStatus || 'no_obligations' } : null,
      openIssues: visibility.issues ? issues.get(supplier.id) || 0 : null,
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

// Every supplier's open issues on one list for Supplier risks: the same
// signals the list's "Open issues" counts and each detail page's "Risks and
// exceptions" lists, with the supplier named from the supplier master. Ordered
// by the date each row prints, the earliest first, never by a score (owner
// rule 2026-10-03). A signal of a supplier not in the master is not listed,
// as the list does not count it.
export function supplierRiskRows(signals = [], suppliers = []) {
  const byId = new Map(suppliers.map((supplier) => [text(supplier.id), supplier]))
  return signals
    .filter((signal) => SUPPLIER_ISSUE_TYPES.includes(signal.type) && byId.has(text(signal.supplierId)))
    .sort(compareSignalsByPrintedDate)
    .map((signal) => {
      const supplier = byId.get(text(signal.supplierId))
      return { ...issueRow(signal), supplierId: supplier.id, supplierCode: text(supplier.code) || supplier.id, supplierName: text(supplier.name) || supplier.id }
    })
}

// Reads every supplier's metrics for the signed-in reader.
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
      const window = { from: addDays(today, -(SUPPLIER_SPEND_LOOKBACK_DAYS - 1)), to: today }
      const [suppliers, purchaseOrders] = await Promise.all([
        prisma.supplier.findMany({ where: { tenantId }, select: { id: true, name: true, status: true }, orderBy: [{ name: 'asc' }, { id: 'asc' }] }),
        visibility.orders && listPurchaseOrders ? listPurchaseOrders({ tenantId }) : [],
      ])
      const totals = supplierPurchaseTotals(purchaseOrders, { ...window, timeZone: tenant.timezone })
      const openRows = visibility.orders ? buildOpenPurchaseOrdersReport(purchaseOrders, { export: 'true' }, instant, { timeZone: tenant.timezone }).exportRows || [] : []
      const scorecard = visibility.onTime ? await createSupplierScorecardReadService({ prisma, now: () => instant }).read({}, { actor }) : null
      const signals = visibility.issues ? buildAiSkillSignals(await readAiSkillFacts(skillContext)) : []
      return {
        asOf: today,
        lookbackDays: SUPPLIER_SPEND_LOOKBACK_DAYS,
        onTimePeriod: scorecard?.period || null,
        visibility,
        suppliers: buildSupplierInsights({ suppliers, totals, openRows, scorecard, signals, visibility }),
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
    // Every supplier's open issues for Supplier risks, with the reader's
    // access as readActivity applies it: issues with any source behind them,
    // through the assistant's masked facts; each source the reader cannot
    // read is named in visibility, so a missing kind is never read as none.
    async readRisks(ctx) {
      const instant = now()
      const skillContext = await loadAiSkillContext({ ...ctx, aiSkillNow: instant.toISOString() })
      const { actor, tenantId, today } = skillContext
      const access = reportReadAccessFor(actor)
      const visibility = {
        orders: Boolean(access.collections.purchaseOrders),
        receipts: Boolean(access.collections.receipts),
        invoices: Boolean(access.collections.supplierInvoices),
        issues: Boolean(access.collections.purchaseOrders || access.collections.receipts || access.collections.supplierInvoices),
      }
      const [suppliers, signals] = await Promise.all([
        prisma.supplier.findMany({ where: { tenantId }, select: { id: true, code: true, name: true }, orderBy: [{ name: 'asc' }, { id: 'asc' }] }),
        visibility.issues ? readAiSkillFacts(skillContext).then(buildAiSkillSignals) : [],
      ])
      return {
        asOf: today,
        visibility,
        issueTypes: SUPPLIER_ISSUE_TYPES,
        issues: visibility.issues ? supplierRiskRows(signals, suppliers) : null,
      }
    },
  }
}
