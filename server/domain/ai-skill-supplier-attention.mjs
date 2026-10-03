import { aiSkillCountText, aiSkillList, aiSkillSentences, aiSkillText } from './ai-skill-copy.mjs'
import { AI_SKILL_MODULES, aiSkillFormatter, aiSkillImpact, aiSkillNavigation, aiSkillSignalReason, presentAiSkillAnswer } from './ai-skill-presenter.mjs'
import { AI_SKILL_RECENT_DAYS, aiSkillDaysBetween, buildAiSkillSignals, compareSignalsByDate } from './ai-skill-signals.mjs'

// "供应商数据给我呢", "How are our suppliers doing?": which suppliers need
// attention, and why, without a score. Each supplier's open work is its
// overdue purchase orders, orders due within 7 days, receipts with rejected
// quantities or not posted, and invoice variances. Suppliers are ordered by
// their most urgent record, by date, as today's priorities are
// (compareSignalsByDate): the longest overdue first, then the soonest due,
// then the oldest open problem; then by how many records are open; then by
// name. The first three are described with that record and its date, at most
// five are listed, and the rest are counted with a link to the supplier
// scorecard. The answer also names the suppliers the workspace dealt with in
// the last AI_SKILL_RECENT_DAYS days (new orders, receipts, invoices),
// whether or not anything is wrong. A supplier the question names (or the
// page's supplier, when the question points at it) narrows the answer to it.

const DESCRIBED = 3
const LISTED = 5
// Recent activity names at most three suppliers, the busiest first.
const RECENT_LISTED = 3
const OPEN_WORK = ['po_overdue', 'po_due_7d', 'grn_rejected_qty', 'grn_received_unposted', 'invoice_variance']
const array = (value) => Array.isArray(value) ? value : []

function recentActivity(facts, names, only) {
  const asOf = facts.asOf
  const recent = (day) => {
    if (!day || !asOf) return false
    const age = aiSkillDaysBetween(day, asOf)
    return age >= 0 && age < AI_SKILL_RECENT_DAYS
  }
  const bySupplier = new Map()
  const add = (supplierId, kind) => {
    if (!supplierId || (only.size && !only.has(supplierId))) return
    const row = bySupplier.get(supplierId) || { supplierId, name: names.get(supplierId) || supplierId, orders: 0, receipts: 0, invoices: 0 }
    row[kind] += 1
    bySupplier.set(supplierId, row)
  }
  for (const row of array(facts.purchaseOrders?.index)) if (recent(row.createdDate)) add(row.supplierId, 'orders')
  for (const row of array(facts.receipts?.recent)) add(row.supplierId, 'receipts')
  for (const row of array(facts.invoices?.recent)) add(row.supplierId, 'invoices')
  const total = (row) => row.orders + row.receipts + row.invoices
  return [...bySupplier.values()].sort((a, b) => total(b) - total(a) || a.name.localeCompare(b.name)).slice(0, RECENT_LISTED)
}

export function runSupplierAttention(facts, { route = null, focus = null } = {}) {
  const names = new Map(array(facts.suppliers).map((row) => [row.id, row.name || row.code || row.id]))
  const only = new Set([...array(route?.entities?.suppliers).map((row) => row.id), ...(focus?.entityType === 'supplier' ? [focus.entityId] : [])])
  const groups = new Map()
  for (const item of buildAiSkillSignals(facts)) {
    if (!OPEN_WORK.includes(item.type) || !item.supplierId || (only.size && !only.has(item.supplierId))) continue
    const group = groups.get(item.supplierId) || { supplierId: item.supplierId, name: names.get(item.supplierId) || item.supplier || item.supplierId, items: [], counts: {} }
    group.items.push(item)
    group.counts[item.type] = (group.counts[item.type] || 0) + 1
    groups.set(item.supplierId, group)
  }
  const suppliers = [...groups.values()]
    .map((group) => ({ ...group, items: group.items.sort(compareSignalsByDate) }))
    .sort((a, b) => compareSignalsByDate(a.items[0], b.items[0]) || b.items.length - a.items.length || a.name.localeCompare(b.name))
  const totals = Object.fromEntries(OPEN_WORK.map((type) => [type, suppliers.reduce((sum, group) => sum + (group.counts[type] || 0), 0)]))
  return {
    skillId: 'supplier_attention',
    hidden: !facts.purchaseOrders && !facts.receipts && !facts.invoices,
    named: [...only].map((id) => names.get(id) || id),
    total: suppliers.length,
    suppliers: suppliers.slice(0, LISTED),
    more: Math.max(0, suppliers.length - LISTED),
    totals,
    quiet: only.size ? 0 : Math.max(0, names.size - suppliers.length),
    recent: recentActivity(facts, names, only),
  }
}

// "18 days overdue", "due Oct 3", "open 5 days": the date the supplier is ordered by.
function leadText(item, fmt, language) {
  const when = item.when || {}
  if (when.kind === 'overdue') return aiSkillCountText('suppliers.lead.overdue', when.days, language, { days: fmt.number(when.days) })
  if (when.kind === 'due') return aiSkillText('suppliers.lead.due', language, { date: fmt.day(when.date) })
  if (when.kind === 'open') return aiSkillCountText('suppliers.lead.open', when.days, language, { days: fmt.number(when.days) })
  return aiSkillText(`signal.${item.type}.status`, language)
}

function partsText(counts, fmt, language) {
  return aiSkillList(OPEN_WORK.filter((type) => counts[type]).map((type) => aiSkillCountText(`suppliers.part.${type}`, counts[type], language, { count: fmt.number(counts[type]) })), language)
}

function activityText(row, fmt, language) {
  const parts = ['orders', 'receipts', 'invoices'].filter((kind) => row[kind]).map((kind) => aiSkillCountText(`suppliers.activity.${kind}`, row[kind], language, { count: fmt.number(row[kind]) }))
  return aiSkillText('suppliers.activity.entry', language, { supplier: row.name, parts: aiSkillList(parts, language) })
}

export function presentSupplierAttention(result, facts, { skill, language, query }) {
  const fmt = aiSkillFormatter(facts, language)
  const date = fmt.day(facts.asOf)
  const first = result.suppliers[0]
  const named = result.named.length === 1 ? result.named[0] : null
  const title = result.hidden ? aiSkillText('suppliers.title_hidden', language)
    : !first ? (named ? aiSkillText('suppliers.title_named_none', language, { supplier: named, date }) : aiSkillText('suppliers.title_none', language, { date }))
      : aiSkillCountText('suppliers.title', result.total, language, { count: fmt.number(result.total), supplier: first.name, lead: leadText(first.items[0], fmt, language) })
  const totalsText = partsText(result.totals, fmt, language)
  const summary = aiSkillSentences([
    totalsText ? aiSkillText('suppliers.totals', language, { parts: totalsText }) : '',
    result.quiet && first ? aiSkillCountText('suppliers.quiet', result.quiet, language, { count: fmt.number(result.quiet) }) : '',
    result.more ? aiSkillCountText('suppliers.more', result.more, language, { count: fmt.number(result.more) }) : '',
    result.hidden ? '' : result.recent.length
      ? aiSkillText('suppliers.recent', language, { days: fmt.number(AI_SKILL_RECENT_DAYS), list: aiSkillList(result.recent.map((row) => activityText(row, fmt, language)), language) })
      : aiSkillText('suppliers.recent_none', language, { days: fmt.number(AI_SKILL_RECENT_DAYS) }),
  ], language)
  const evidence = result.suppliers.map((group, index) => {
    const lead = group.items[0]
    const status = aiSkillText(`signal.${lead.type}.status`, language)
    const parts = aiSkillText('suppliers.issues', language, { parts: partsText(group.counts, fmt, language) })
    // The first three say which record is most urgent and why, with its date.
    const detail = index < DESCRIBED ? aiSkillText('suppliers.most_urgent', language, { id: lead.label, reason: aiSkillSignalReason(lead, facts, language) }) : ''
    return {
      id: `supplier_attention:${group.supplierId}`, label: status, entityLabel: group.name, entityType: 'supplier', entityId: group.supplierId,
      moduleId: AI_SKILL_MODULES.supplier, evidenceType: 'supplier_attention', summary: aiSkillSentences([parts, detail], language),
      value: aiSkillText('value.issues', language, { count: fmt.number(group.items.length) }), status, statusCode: lead.type,
      severity: lead.severity, rank: index + 1, sourceLabel: aiSkillText(`area.${lead.area || 'purchasing'}`, language),
      linkTarget: { moduleId: AI_SKILL_MODULES.supplier, entityType: 'supplier', entityId: group.supplierId },
    }
  })
  const navigation = [
    ...result.suppliers.slice(0, DESCRIBED).map((group) => aiSkillNavigation({ label: group.name, entityType: 'supplier', entityId: group.supplierId }, language)),
    // More than five: the scorecard lists every supplier.
    ...(result.more ? [{ label: aiSkillText('suppliers.view_all', language), moduleId: 'reports:suppliers', returnTo: 'ai-assistant', source: 'ai' }] : []),
  ]
  const followUpIds = [
    ...(result.totals.po_overdue || result.totals.po_due_7d ? ['purchase_orders'] : []),
    ...(result.totals.grn_rejected_qty || result.totals.grn_received_unposted ? ['receiving_issues'] : []),
    ...(result.totals.invoice_variance ? ['invoice_summary'] : []),
    'today_priorities',
  ]
  return presentAiSkillAnswer({
    skill, facts, language, query, title, summary,
    severity: first ? first.items[0].severity : 'success',
    evidence,
    // One impact per listed supplier: its most urgent record's.
    impacts: result.suppliers.map((group) => ({ ...aiSkillImpact(group.items[0], language), affectedObjects: [group.supplierId] })),
    navigation, followUpIds,
  })
}
