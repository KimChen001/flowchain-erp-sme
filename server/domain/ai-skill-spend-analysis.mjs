import { aiSkillCountText, aiSkillList, aiSkillSentences, aiSkillText } from './ai-skill-copy.mjs'
import { AI_SKILL_MODULES, aiSkillFormatter, aiSkillNavigation, presentAiSkillAnswer } from './ai-skill-presenter.mjs'

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

export function runSpendAnalysis(facts, { route = null } = {}) {
  if (!facts?.purchaseOrders || typeof facts.procurementReport !== 'function') return { skillId: 'spend_analysis', hidden: true }
  const signals = route?.signals?.spend || {}
  const named = array(route?.entities?.suppliers)
  const supplier = named.length === 1 ? named[0] : null
  const mode = signals.mode === 'trend' ? 'trend' : supplier ? 'supplier' : 'suppliers'
  const period = aiSkillSpendPeriod(signals.period, facts.today)
  const filters = period ? { from: period.from, to: period.to } : {}
  let currency = text(signals.currency).toUpperCase() || null
  let report = facts.procurementReport(currency ? { ...filters, currency } : filters)
  let others = []
  // Orders in several currencies: one currency at a time, as the dashboard's
  // currency filter shows them, and the others' totals named.
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
    skillId: 'spend_analysis', hidden: false, mode, period, currency: amounts ? (currency || treemap?.currencyCode || null) : null,
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

function periodText(period, fmt, language) {
  return period ? aiSkillText('spend.period.range', language, { from: fmt.day(period.from), to: fmt.day(period.to) }) : aiSkillText('spend.period.all', language)
}

const nameText = (name, language) => name === UNSPECIFIED ? aiSkillText('spend.unspecified', language) : name
const percent = (share, fmt) => share === null ? '' : `${fmt.number(Math.round(share * 1000) / 10)}%`

export function presentSpendAnalysis(result, facts, { skill, language, query }) {
  const fmt = aiSkillFormatter(facts, language)
  if (result.hidden) {
    return presentAiSkillAnswer({ skill, facts, language, query, title: aiSkillText('spend.title_hidden', language), summary: aiSkillText('spend.summary_hidden', language), severity: 'info', evidence: [], impacts: [], navigation: [], moneyLimitations: false })
  }
  const period = periodText(result.period, fmt, language)
  const value = (amount) => result.amounts ? fmt.money(amount, result.currency) : aiSkillCountText('spend.value.orders', amount, language, { count: fmt.number(amount) })
  const notes = [
    result.countReason ? aiSkillText(`spend.counts.${result.countReason}`, language) : '',
    result.amountMissing ? aiSkillText('spend.amount_missing', language) : '',
    result.others.length ? aiSkillText('spend.other_currencies', language, { amounts: aiSkillList(result.others.map((row) => row.amount === null ? aiSkillCountText('spend.value.orders_in', row.orders, language, { count: fmt.number(row.orders), currency: row.currency }) : fmt.money(row.amount, row.currency)), language) }) : '',
    aiSkillText('spend.dashboard', language),
  ]
  const supplierEvidence = (row, index) => ({
    id: `spend:${row.name}`, label: result.amounts ? aiSkillText('spend.class', language, { class: row.spendClass }) : aiSkillText('spend.label_orders', language),
    entityLabel: nameText(row.name, language), entityType: 'supplier', ...(row.record ? { entityId: row.record.id } : {}),
    moduleId: AI_SKILL_MODULES.supplier, evidenceType: 'spend',
    summary: result.amounts ? aiSkillText('spend.evidence.share', language, { rank: fmt.number(row.rank), share: percent(row.share, fmt), class: row.spendClass }) : aiSkillText('spend.evidence.rank', language, { rank: fmt.number(row.rank) }),
    value: value(row.value), status: result.amounts ? aiSkillText('spend.class', language, { class: row.spendClass }) : aiSkillText('spend.label_orders', language),
    statusCode: result.amounts ? `spend_class_${row.spendClass}` : 'spend_orders', severity: 'info', rank: index + 1, sourceLabel: aiSkillText('area.purchasing', language),
    ...(row.record ? { linkTarget: { moduleId: AI_SKILL_MODULES.supplier, entityType: 'supplier', entityId: row.record.id } } : {}),
  })
  const dashboard = { label: aiSkillText('spend.view_dashboard', language), moduleId: 'reports:procurement', returnTo: 'ai-assistant', source: 'ai' }
  // The figures it states, keyed as the evaluation's truth keys: the total as
  // committed_spend:USD (committed_spend_usd), a supplier by its id. Counts are
  // named as counts, so they never read as amounts.
  const figure = (entityId, amount) => result.amounts
    ? { key: entityId ? `supplier_spend:${entityId}` : `committed_spend:${result.currency}`, code: entityId ? 'supplier_spend' : 'committed_spend', entityId: entityId || null, value: amount, currency: result.currency }
    : { key: entityId ? `supplier_po_count:${entityId}` : 'committed_po_count', code: entityId ? 'supplier_po_count' : 'committed_po_count', entityId: entityId || null, value: amount, unit: 'orders' }
  const common = { skill, facts, language, query, severity: 'info', moneyLimitations: false }
  // One impact per evidence line: what the figure is.
  const impactsOf = (evidence) => evidence.map((item) => ({ area: aiSkillText('area.purchasing', language), impact: item.status, severity: 'info', explanation: aiSkillText(`spend.impact.${item.evidenceType}`, language), affectedObjects: [item.entityId || item.id] }))

  if (result.mode === 'trend') {
    const evidence = result.months.map((row, index) => ({
      id: `spend_month:${row.month}`, label: row.month, entityLabel: row.month, evidenceType: 'spend_month',
      summary: aiSkillCountText('spend.value.orders', row.orders, language, { count: fmt.number(row.orders) }), value: value(row.value),
      status: aiSkillText('spend.label_month', language), statusCode: 'spend_month', severity: 'info', rank: index + 1, sourceLabel: aiSkillText('area.purchasing', language),
    }))
    const title = result.monthCount
      ? aiSkillText('spend.title.trend', language, { months: fmt.number(result.monthCount), total: value(result.total), period })
      : aiSkillText('spend.title.none', language, { period })
    const summary = aiSkillSentences([
      result.peak && result.amounts ? aiSkillText('spend.trend.peak', language, { month: result.peak.month, amount: value(result.peak.value) }) : '',
      result.monthCount > MONTHS_LISTED ? aiSkillText('spend.trend.shown', language, { count: fmt.number(MONTHS_LISTED) }) : '',
      result.undated ? aiSkillCountText('spend.trend.undated', result.undated, language, { count: fmt.number(result.undated) }) : '',
      ...notes,
    ], language)
    return presentAiSkillAnswer({ ...common, title, summary, evidence, impacts: impactsOf(evidence), navigation: [dashboard], figures: [figure(null, result.total)], followUpIds: ['supplier_attention'] })
  }

  if (result.mode === 'supplier') {
    const { supplier } = result
    const row = supplier.row
    const title = !row
      ? aiSkillText('spend.title.supplier_none', language, { supplier: supplier.name, period })
      : result.amounts
        ? aiSkillText('spend.title.supplier', language, { supplier: supplier.name, amount: value(row.value), share: percent(row.share, fmt), period })
        : aiSkillText('spend.title.supplier_orders', language, { supplier: supplier.name, orders: value(row.value), period })
    const items = supplier.items.map((item, index) => ({
      id: `spend_item:${row.name}:${item.name}`, label: aiSkillText('spend.label_item', language), entityLabel: nameText(item.name, language), evidenceType: 'spend_item',
      summary: aiSkillText('spend.evidence.item', language, { supplier: supplier.name }), value: fmt.money(item.value, result.currency),
      status: aiSkillText('spend.label_item', language), statusCode: 'spend_item', severity: 'info', rank: index + 2, sourceLabel: aiSkillText('area.purchasing', language),
    }))
    const summary = aiSkillSentences([
      row && result.amounts ? aiSkillText('spend.supplier.rank', language, { rank: fmt.number(row.rank), count: fmt.number(result.supplierCount), class: row.spendClass }) : '',
      supplier.items.length ? aiSkillCountText('spend.supplier.items', supplier.itemCount, language, { count: fmt.number(supplier.itemCount), list: aiSkillList(supplier.items.slice(0, 3).map((item) => nameText(item.name, language)), language) }) : '',
      supplier.items.length ? aiSkillText('spend.items_net', language) : '',
      ...notes,
    ], language)
    const evidence = row ? [{ ...supplierEvidence(row, 0), entityId: supplier.id, linkTarget: { moduleId: AI_SKILL_MODULES.supplier, entityType: 'supplier', entityId: supplier.id } }, ...items] : []
    return presentAiSkillAnswer({
      ...common, title, summary, evidence, impacts: impactsOf(evidence),
      navigation: [aiSkillNavigation({ label: supplier.name, entityType: 'supplier', entityId: supplier.id }, language), dashboard],
      figures: row ? [figure(supplier.id, row.value)] : [],
      followUpIds: ['supplier_attention'],
    })
  }

  const first = result.suppliers[0]
  const title = !first ? aiSkillText('spend.title.none', language, { period })
    : !result.amounts ? aiSkillCountText('spend.title.counts', result.supplierCount, language, { count: fmt.number(result.supplierCount), supplier: nameText(first.name, language), orders: value(first.value), period })
      : aiSkillCountText('spend.title.suppliers', result.supplierCount, language, { count: fmt.number(result.supplierCount), total: value(result.total), supplier: nameText(first.name, language), share: percent(first.share, fmt), period })
  const summary = aiSkillSentences([
    first && result.amounts && result.supplierCount > 1 ? aiSkillCountText('spend.class_a', result.classA, language, { count: fmt.number(result.classA) }) : '',
    result.more ? aiSkillCountText('spend.more', result.more, language, { count: fmt.number(result.more) }) : '',
    ...notes,
  ], language)
  const evidence = result.suppliers.map(supplierEvidence)
  return presentAiSkillAnswer({
    ...common, title, summary, evidence, impacts: impactsOf(evidence),
    navigation: [...result.suppliers.filter((row) => row.record).slice(0, 3).map((row) => aiSkillNavigation({ label: row.record.name, entityType: 'supplier', entityId: row.record.id }, language)), dashboard],
    figures: [figure(null, result.total), ...result.suppliers.filter((row) => row.record).map((row) => figure(row.record.id, row.value))],
    followUpIds: ['supplier_attention'],
  })
}
