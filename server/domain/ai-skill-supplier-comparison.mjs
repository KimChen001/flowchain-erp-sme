import { aiSkillCountText, aiSkillList, aiSkillSentences, aiSkillText } from './ai-skill-copy.mjs'
import { AI_SKILL_MODULES, aiSkillFormatter, aiSkillNavigation, presentAiSkillAnswer } from './ai-skill-presenter.mjs'
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

const percent = (value, fmt) => (value === null || value === undefined ? null : `${fmt.number(Math.round(value * 1000) / 10)}%`)

// "on time 80% (8 of 10)", or the count when the sample is too small.
function onTimeText(row, fmt, language) {
  const rate = rateOf(row.onTime)
  if (rate !== null) return aiSkillText('compare.on_time', language, { rate: percent(rate, fmt), count: fmt.number(row.onTime.count), of: fmt.number(row.onTime.of) })
  return row.deliveries ? aiSkillCountText('compare.too_few', row.deliveries, language, { count: fmt.number(row.deliveries) }) : aiSkillText('compare.no_deliveries', language)
}

function detailText(row, result, fmt, language) {
  const parts = []
  if (rateOf(row.inFull) !== null) parts.push(aiSkillText('compare.in_full', language, { rate: percent(rateOf(row.inFull), fmt) }))
  if (rateOf(row.otif) !== null) parts.push(aiSkillText('compare.otif', language, { rate: percent(rateOf(row.otif), fmt) }))
  if (rateOf(row.rejection) !== null) parts.push(aiSkillText('compare.rejection', language, { rate: percent(rateOf(row.rejection), fmt) }))
  if (row.delay?.value !== null && row.delay?.value !== undefined && row.delay.lateCount) parts.push(aiSkillCountText('compare.delay', row.delay.lateCount, language, { days: fmt.number(row.delay.value), count: fmt.number(row.delay.lateCount) }))
  if (row.variances?.visible && row.variances.count) parts.push(aiSkillCountText('compare.variances', row.variances.count, language, { count: fmt.number(row.variances.count) }))
  if (row.spend && result.currency) parts.push(aiSkillText('compare.spend', language, { amount: fmt.money(row.spend.amount, result.currency), share: percent(row.spend.share, fmt) }))
  return parts.length ? aiSkillText('compare.detail', language, { parts: aiSkillList(parts, language) }) : ''
}

export function presentSupplierComparison(result, facts, { skill, language, query }) {
  const fmt = aiSkillFormatter(facts, language)
  const empty = { skill, facts, language, query, severity: 'info', evidence: [], impacts: [], navigation: [], moneyLimitations: false }
  if (result.hidden) return presentAiSkillAnswer({ ...empty, title: aiSkillText('compare.title_hidden', language), summary: aiSkillText('compare.summary_hidden', language) })
  if (result.unavailable) return presentAiSkillAnswer({ ...empty, title: aiSkillText('compare.title_unavailable', language), summary: aiSkillText(result.unavailable === 'SCORECARD_PERIOD_TOO_LONG' ? 'compare.period_too_long' : 'compare.summary_unavailable', language) })
  const period = aiSkillText('spend.period.range', language, { from: fmt.day(result.period.from), to: fmt.day(result.period.to) })
  const evidence = result.suppliers.map((row, index) => {
    const status = rateOf(row.onTime) !== null ? aiSkillText('compare.status_on_time', language, { rate: percent(rateOf(row.onTime), fmt) }) : aiSkillText('compare.status_too_few', language)
    return {
      id: `compare:${row.id}`, label: status, entityLabel: row.name, entityType: 'supplier', entityId: row.id, moduleId: AI_SKILL_MODULES.supplier, evidenceType: 'supplier_performance',
      summary: detailText(row, result, fmt, language) || onTimeText(row, fmt, language), value: onTimeText(row, fmt, language),
      status, statusCode: rateOf(row.onTime) !== null ? 'scorecard_ok' : 'scorecard_sample_too_small', severity: 'info', rank: index + 1, sourceLabel: aiSkillText('area.purchasing', language),
      linkTarget: { moduleId: AI_SKILL_MODULES.supplier, entityType: 'supplier', entityId: row.id },
    }
  })
  const first = result.suppliers[0]
  let title
  if (result.mode === 'compare') {
    title = aiSkillText('compare.title_compare', language, { list: aiSkillList(result.suppliers.map((row) => `${row.name} ${rateOf(row.onTime) !== null ? percent(rateOf(row.onTime), fmt) : aiSkillText('compare.n_a', language)}`), language), period })
  } else if (result.mode === 'one') {
    title = aiSkillText('compare.title_one', language, { supplier: first.name, value: onTimeText(first, fmt, language), period })
  } else if (!first) {
    title = aiSkillText('compare.title_none', language, { period })
  } else {
    title = aiSkillText(result.mode === 'worst' ? 'compare.title_worst' : 'compare.title_best', language, { supplier: first.name, value: onTimeText(first, fmt, language), period })
  }
  const summary = aiSkillSentences([
    result.mode === 'best' || result.mode === 'worst' ? (result.more ? aiSkillCountText('compare.more', result.more, language, { count: fmt.number(result.more) }) : '') : '',
    (result.mode === 'best' || result.mode === 'worst') && result.few?.length ? aiSkillCountText('compare.few', result.few.length, language, { count: fmt.number(result.few.length), list: aiSkillList(result.few.slice(0, 3).map((row) => row.name), language) }) : '',
    result.suppliers.some((row) => rateOf(row.onTime) === null) && (result.mode === 'compare' || result.mode === 'one') ? aiSkillText('compare.minimum', language) : '',
    !result.invoicesVisible ? aiSkillText('compare.variances_hidden', language) : '',
    result.limitations.includes('receipts_limited_to_your_warehouses') ? aiSkillText('compare.warehouses', language) : '',
    aiSkillText('compare.basis', language),
  ], language)
  const figures = result.suppliers.filter((row) => rateOf(row.onTime) !== null).map((row) => ({ key: `supplier_on_time_rate:${row.id}`, code: 'supplier_on_time_rate', entityId: row.id, value: rateOf(row.onTime), unit: 'ratio' }))
  return presentAiSkillAnswer({
    ...empty, title, summary, evidence,
    impacts: evidence.map((item) => ({ area: aiSkillText('area.purchasing', language), impact: item.status, severity: 'info', explanation: aiSkillText('compare.impact', language), affectedObjects: [item.entityId] })),
    navigation: [...result.suppliers.slice(0, 3).map((row) => aiSkillNavigation({ label: row.name, entityType: 'supplier', entityId: row.id }, language)), { label: aiSkillText('compare.view_analytics', language), moduleId: 'reports:suppliers', returnTo: 'ai-assistant', source: 'ai' }],
    figures,
    followUpIds: ['supplier_attention'],
  })
}
