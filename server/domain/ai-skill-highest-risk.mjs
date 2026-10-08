import { aiSkillSentences, aiSkillText } from './ai-skill-copy.mjs'
import { aiSkillFormatter, aiSkillMetricSentences, presentAiSkillAnswer } from './ai-skill-presenter.mjs'
import { buildAiSkillSignals, compareSignalsByPrintedDate, rankAiSkillItemsByDate } from './ai-skill-signals.mjs'
import { aiSkillFocusName, matchesAiSkillFocus } from './ai-skill-today-priorities.mjs'

const TOP = 5
// The open problems this list names: late orders, stock below its levels,
// invoice variances and rejected receipts. Ordered by the date each line
// prints, the oldest first (compareSignalsByPrintedDate): a late order by its
// promised date, an invoice variance by its invoice date, a rejected receipt
// by its arrival day; the undated stock problems last. Never by a score, an
// amount or the kind of problem, so a late order does not jump ahead of an
// older invoice variance.
const EXPOSURE_TYPES = new Set(['po_overdue', 'stock_shortage', 'stock_below_safety', 'stock_below_reorder', 'invoice_variance', 'grn_rejected_qty'])
const SUPPLIER_TYPES = new Set(['po_overdue', 'invoice_variance', 'grn_rejected_qty'])

// A supplier with two or more exposure signals (late POs, invoice variances,
// rejected receipts) is its own entry, dated by its oldest signal.
function supplierExposure(signals) {
  const bySupplier = new Map()
  for (const item of signals.filter((entry) => SUPPLIER_TYPES.has(entry.type) && entry.supplierId)) {
    bySupplier.set(item.supplierId, [...(bySupplier.get(item.supplierId) || []), item])
  }
  return [...bySupplier.entries()].filter(([, items]) => items.length > 1).map(([supplierId, items]) => {
    const first = [...items].sort(compareSignalsByPrintedDate)[0]
    return {
      id: `supplier_exposure:${supplierId}`, type: 'supplier_exposure', severity: first.severity, entityType: 'supplier', entityId: supplierId,
      label: first.supplier || supplierId, area: 'purchasing', supplierId, supplier: first.supplier, money: null, when: first.when,
      data: { count: items.length, types: [...new Set(items.map((entry) => entry.type))], ids: items.map((entry) => entry.entityId) },
    }
  })
}

export function runHighestRisk(facts, { focus = null } = {}) {
  const signals = buildAiSkillSignals(facts)
  const exposure = signals.filter((item) => EXPOSURE_TYPES.has(item.type))
  const ranked = [...rankAiSkillItemsByDate(exposure), ...supplierExposure(exposure)]
    .filter((item) => matchesAiSkillFocus(item, focus))
    .sort(compareSignalsByPrintedDate)
    .map((item, index) => ({ ...item, also: item.also || [], rank: index + 1 }))
  return { skillId: 'highest_risk_items', focus, total: ranked.length, items: ranked.slice(0, TOP) }
}

export function presentHighestRisk(result, facts, { skill, language, query }) {
  const fmt = aiSkillFormatter(facts, language)
  const first = result.items[0]
  const status = first ? aiSkillText(`signal.${first.type}.status`, language).toLowerCase() : ''
  const firstText = first ? aiSkillText('risk.first', language, { label: first.label, status }) : ''
  // Narrowed to one record, the title says so: "Open problems on PO-016",
  // never the whole workspace's.
  const id = result.focus ? aiSkillFocusName(result.focus, facts) : null
  const title = id
    ? first ? aiSkillText('risk.focus_title', language, { id, first: first.label === id ? status : firstText }) : aiSkillText('risk.focus_none', language, { id, date: fmt.day(facts.asOf) })
    : first ? aiSkillText('risk.title', language, { first: firstText }) : aiSkillText('risk.title_none', language, { date: fmt.day(facts.asOf) })
  const summary = aiSkillSentences([
    ...(result.total ? [aiSkillText('risk.summary', language, { count: fmt.number(result.total) })] : []),
    ...aiSkillMetricSentences(facts, language, { spend: false, invoices: false }),
  ], language)
  return presentAiSkillAnswer({ skill, facts, language, query, title, summary, severity: first?.severity || 'success', items: result.items, followUpIds: ['prepare_action_draft', 'today_priorities'] })
}
