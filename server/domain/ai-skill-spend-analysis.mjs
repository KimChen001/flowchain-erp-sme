
// Analysis tool 1 (owner decision 3 of 2026-10-07): committed spend by
// supplier, by item for one supplier, or by month. "Which suppliers do we
// spend the most with?", 我们从 Acme 买了什么？, "Spend trend this year".
//
// Every figure comes from the procurement dashboard's own report
// (facts.procurementReport, buildRuntimeGovernedReport with subject
// procurement): its supplier and item treemap, its monthly trend and its
// committed amount KPI, with the question's period and currency as the
// dashboard's filters. So the answer shows what the dashboard shows for the
// same filters, and nothing is computed twice:
//   - committed means approved, issued, partially or fully received, or
//     closed; an order counts in the period of its order date;
//   - amounts are never added across currencies. Asked in no currency when
//     orders are in several, the answer is in the workspace's currency (or
//     the one with the most orders) and names the others' totals, as the
//     dashboard does with its currency filter;
//   - a reader who may not see purchase prices, or orders with no valid
//     currency, get order counts, as the dashboard shows them;
//   - an order with no amount is left out of the amounts, and the answer says
//     so.
// The ABC class of a supplier follows the dashboard's Pareto: the share of
// spend before it under 80% is A, under 95% B, the rest C.

const LISTED = 5
const ITEMS_LISTED = 5
const MONTHS_LISTED = 12
const array = (value) => Array.isArray(value) ? value : []
const text = (value) => String(value ?? '').trim()
const UNSPECIFIED = 'Unspecified'

// The period a question names (aiSkillSpendSignals in ai-skill-router.mjs), as
// the dashboard's from and to days, both included, counted from the
// workspace's today. null for all dates, the dashboard's default.
export function aiSkillSpendPeriod(period, today) {
  if (!period || !/^\d{4}-\d{2}-\d{2}$/.test(text(today))) return null
  const [year, month] = today.split('-').map(Number)
  const day = (y, m, d) => new Date(Date.UTC(y, m - 1, d)).toISOString().slice(0, 10)
  const quarter = Math.floor((month - 1) / 3)
  if (period.kind === 'this_month') return { from: day(year, month, 1), to: today }
  if (period.kind === 'last_month') return { from: day(year, month - 1, 1), to: day(year, month, 0) }
  if (period.kind === 'this_quarter') return { from: day(year, quarter * 3 + 1, 1), to: today }
  if (period.kind === 'last_quarter') return { from: day(year, quarter * 3 - 2, 1), to: day(year, quarter * 3 + 1, 0) }
  if (period.kind === 'this_year') return { from: day(year, 1, 1), to: today }
  if (period.kind === 'last_year') return { from: day(year - 1, 1, 1), to: day(year - 1, 12, 31) }
  if (period.kind === 'year' && Number.isInteger(period.year)) return { from: day(period.year, 1, 1), to: period.year === year ? today : day(period.year, 12, 31) }
  if (period.kind === 'last_days' && Number.isInteger(period.days) && period.days > 0) {
    const [y, m, d] = today.split('-').map(Number)
    return { from: day(y, m, d - Math.min(period.days, 3660) + 1), to: today }
  }
  return null
}

const chart = (report, id) => array(report?.charts).find((row) => row.id === id) || null
const spendKpi = (report) => array(report?.kpis).find((row) => row.id === 'purchase_order_amount') || null
const sameName = (left, right) => text(left).toLowerCase() === text(right).toLowerCase()

// The supplier a dashboard row names: the dashboard groups by the name on the
// order, which is normally the supplier's own name.
function supplierOf(name, facts) {
  return array(facts.suppliers).find((row) => sameName(row.name, name) || (row.code && sameName(row.code, name))) || null
}

// The cumulative share of spend before each row, rounded as the dashboard
// rounds it, and the class it gives.
function withClasses(rows) {
  const total = rows.reduce((sum, row) => sum + row.value, 0)
  let running = 0
  return rows.map((row, index) => {
    const before = total ? Math.round((running / total) * 1000) / 10 : 0
    running += row.value
    return { ...row, rank: index + 1, share: total ? row.value / total : null, spendClass: before < 80 ? 'A' : before < 95 ? 'B' : 'C' }
  })
}

// The procurement report for these filters in one currency: the one asked
// for; with orders in several currencies, the workspace's (or the one with the
// most orders), as the dashboard's currency filter shows them, with the other
// currencies' totals. Shared with the supplier comparison.
export function aiSkillSpendReport(facts, filters = {}, requested = null) {
  let currency = text(requested).toUpperCase() || null
  let report = facts.procurementReport(currency ? { ...filters, currency } : filters)
  let others = []
  if (!currency && array(chart(report, 'procurement_spend_treemap')?.limitations).includes('multi_currency_unconverted')) {
    const amounts = array(spendKpi(report)?.currencyAmounts).filter((row) => row.currencyCode)
    const preferred = amounts.find((row) => row.currencyCode === text(facts.currency).toUpperCase())
      || [...amounts].sort((a, b) => b.recordCount - a.recordCount || a.currencyCode.localeCompare(b.currencyCode))[0]
    if (preferred) {
      currency = preferred.currencyCode
      others = amounts.filter((row) => row.currencyCode !== currency).map((row) => ({ currency: row.currencyCode, amount: row.amount, orders: row.recordCount }))
      report = facts.procurementReport({ ...filters, currency })
    }
  }
  const treemap = chart(report, 'procurement_spend_treemap')
  return { report, treemap, currency: treemap?.unit === 'currency' ? (currency || treemap?.currencyCode || null) : null, others }
}

export function runSpendAnalysis(facts, { route = null } = {}) {
  if (!facts?.purchaseOrders || typeof facts.procurementReport !== 'function') return { skillId: 'spend_analysis', hidden: true }
  const signals = route?.signals?.spend || {}
  const named = array(route?.entities?.suppliers)
  const supplier = named.length === 1 ? named[0] : null
  const mode = signals.mode === 'trend' ? 'trend' : supplier ? 'supplier' : 'suppliers'
  const period = aiSkillSpendPeriod(signals.period, facts.today)
  const filters = period ? { from: period.from, to: period.to } : {}
  const { report, treemap, currency, others } = aiSkillSpendReport(facts, filters, signals.currency)
  const trend = chart(report, 'procurement_spend_trend')
  const amounts = treemap?.unit === 'currency'
  const limitations = array(treemap?.limitations)
  const kpi = spendKpi(report)
  const rows = withClasses(array(treemap?.data).map((row) => ({ name: text(row.name) || UNSPECIFIED, value: Number(row.value) || 0 })))
  const sum = rows.reduce((total, row) => total + row.value, 0)
  // The dashboard's headline figure when it has one (none when an order has no
  // amount); otherwise the sum of the suppliers.
  const total = amounts ? (kpi?.currentValue ?? Math.round(sum * 100) / 100) : sum
  const base = {
    skillId: 'spend_analysis', hidden: false, mode, period, currency,
    amounts, countReason: amounts ? null : limitations.find((code) => ['amount_restricted', 'currency_missing_or_invalid', 'multi_currency_unconverted'].includes(code)) || null,
    amountMissing: limitations.includes('amount_missing'), others, total, supplierCount: rows.filter((row) => row.name !== UNSPECIFIED).length,
  }
  if (mode === 'trend') {
    const months = array(trend?.data).map((row) => ({ month: text(row.name), value: amounts ? row['Committed amount'] ?? null : row['Purchase orders'] ?? 0, orders: row['Purchase orders'] ?? 0 }))
    const dated = months.filter((row) => row.month !== 'Undated')
    const peak = dated.reduce((best, row) => (row.value !== null && (!best || row.value > best.value) ? row : best), null)
    return { ...base, months: dated.slice(-MONTHS_LISTED), monthCount: dated.length, undated: months.find((row) => row.month === 'Undated')?.orders || 0, peak, suppliers: rows.slice(0, 3).map((row) => ({ ...row, record: supplierOf(row.name, facts) })) }
  }
  if (mode === 'supplier') {
    const row = rows.find((entry) => sameName(entry.name, supplier.name) || (supplier.code && sameName(entry.name, supplier.code))) || null
    const items = row && amounts ? array(treemap?.breakdown?.[row.name]).map((item) => ({ name: text(item.name) || UNSPECIFIED, value: Number(item.value) || 0 })) : []
    return { ...base, supplier: { id: supplier.id, name: supplier.name, row, items: items.slice(0, ITEMS_LISTED), itemCount: items.length } }
  }
  return { ...base, suppliers: rows.slice(0, LISTED).map((row) => ({ ...row, record: supplierOf(row.name, facts) })), more: Math.max(0, rows.length - LISTED), classA: rows.filter((row) => row.spendClass === 'A').length }
}
