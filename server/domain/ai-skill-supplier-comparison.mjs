import { aiSkillSpendPeriod, aiSkillSpendReport } from './ai-skill-spend-analysis.mjs'

// Analysis tool 2 (owner decision 3 of 2026-10-07): how suppliers deliver,
// side by side. "Compare Acme and Summit", "Which supplier is most reliable?",
// 哪家供应商最准时？, "How is Acme performing?"
//
// The figures are the supplier scorecard's (supplier-scorecard.mjs), the one
// the supplier page and Reports › Supplier analytics show, for the same
// period: each delivery (the lines of one purchase order with one original
// promised date) judged against that original promise. On time, in full,
// OTIF and the rejection rate need 5 deliveries; below that the supplier is
// named with its count and no rate, as the scorecard shows it. The period is
// the question's, else the scorecard's default: the 90 days to today.
// Committed spend for the same period comes from the procurement dashboard's
// report (aiSkillSpendReport), in one currency, as the spend analysis states it.
//
// The runtime reads the scorecard before the skill answers
// (aiSkillPrepareRoute): route.scorecard, or route.scorecardError.

const LISTED = 5
const array = (value) => Array.isArray(value) ? value : []
const text = (value) => String(value ?? '').trim()

// The scorecard for a supplier comparison route, read before it answers: the
// question's period, or the scorecard's default. A read that fails (a period
// the scorecard does not accept, a permission it checks) is kept as its code.
export async function aiSkillPrepareComparison(route, facts) {
  if (route?.skillId !== 'supplier_comparison' || typeof facts?.supplierScorecard !== 'function' || route.scorecard || route.scorecardError) return route
  const period = aiSkillSpendPeriod(route.signals?.compare?.period, facts.today)
  try {
    return { ...route, scorecard: await facts.supplierScorecard(period ? { from: period.from, to: period.to } : {}) }
  } catch (error) {
    return { ...route, scorecardError: text(error?.code) || 'SCORECARD_UNAVAILABLE' }
  }
}

const rateOf = (metric) => (metric && metric.rate !== null && metric.rate !== undefined ? metric.rate : null)

function supplierRow(row) {
  const metrics = row.metrics || {}
  return {
    id: row.supplierId, name: row.supplierName || row.supplierId, deliveries: row.sampleSize, status: row.sampleStatus,
    onTime: metrics.onTime || null, inFull: metrics.inFull || null, otif: metrics.otif || null,
    rejection: metrics.rejection || null, delay: metrics.averageDelayDays || null, variances: metrics.priceVariances || null,
    overdue: row.overdueUndeliveredCount || 0,
  }
}

export function runSupplierComparison(facts, { route = null } = {}) {
  const base = { skillId: 'supplier_comparison' }
  if (route?.scorecardError) return { ...base, unavailable: route.scorecardError }
  const scorecard = route?.scorecard
  if (!scorecard) return { ...base, hidden: true }
  const mode = route?.signals?.compare?.mode === 'worst' ? 'worst' : 'best'
  const named = array(route?.entities?.suppliers)
  const all = array(scorecard.suppliers).map(supplierRow)
  // Committed spend for the same period, in one currency.
  const spend = typeof facts.procurementReport === 'function' && facts.visibility?.amounts?.purchase_order_amounts
    ? aiSkillSpendReport(facts, { from: scorecard.period.from, to: scorecard.period.to })
    : null
  const spendRows = array(spend?.treemap?.data)
  const spendTotal = spendRows.reduce((sum, row) => sum + (Number(row.value) || 0), 0)
  const spendOf = (name) => {
    if (!spend?.currency) return null
    const row = spendRows.find((entry) => text(entry.name).toLowerCase() === text(name).toLowerCase())
    return row ? { amount: Number(row.value) || 0, share: spendTotal ? (Number(row.value) || 0) / spendTotal : null } : null
  }
  const withSpend = (row) => ({ ...row, spend: spendOf(row.name) })
  const common = { ...base, period: scorecard.period, currency: spend?.currency || null, invoicesVisible: Boolean(scorecard.fieldVisibility?.invoices), limitations: array(scorecard.limitations) }
  if (named.length) {
    const rows = named.map((supplier) => withSpend(all.find((row) => row.id === supplier.id) || { id: supplier.id, name: supplier.name, deliveries: 0, status: 'no_obligations', onTime: null, inFull: null, otif: null, rejection: null, delay: null, variances: null, overdue: 0 }))
    return { ...common, mode: rows.length > 1 ? 'compare' : 'one', suppliers: rows }
  }
  // No supplier named: the suppliers with enough deliveries, best (or worst)
  // on time first, then the larger sample, then the name.
  const judged = all.filter((row) => rateOf(row.onTime) !== null)
  const order = mode === 'worst' ? 1 : -1
  judged.sort((a, b) => order * (rateOf(a.onTime) - rateOf(b.onTime)) || b.deliveries - a.deliveries || a.name.localeCompare(b.name))
  const few = all.filter((row) => rateOf(row.onTime) === null && row.deliveries > 0)
  return { ...common, mode, suppliers: judged.slice(0, LISTED).map(withSpend), more: Math.max(0, judged.length - LISTED), judgedCount: judged.length, few: few.map((row) => ({ name: row.name, deliveries: row.deliveries })) }
}
