import { aiSkillSentences, aiSkillText } from './ai-skill-copy.mjs'
import { aiSkillFormatter, aiSkillMetricSentences, presentAiSkillAnswer } from './ai-skill-presenter.mjs'
import { buildAiSkillSignals, compareSignals, rankAiSkillItems } from './ai-skill-signals.mjs'
import { matchesAiSkillFocus } from './ai-skill-today-priorities.mjs'

const TOP = 5
// Exposure: a signal worth 60 or more, or one that carries an amount at risk.
const EXPOSURE_SCORE = 60
const SUPPLIER_TYPES = new Set(['po_overdue', 'invoice_variance', 'grn_rejected_qty'])

// A supplier with two or more exposure signals (late POs, invoice variances,
// rejected receipts) is its own risk object, scored by its worst signal.
function supplierExposure(signals) {
  const bySupplier = new Map()
  for (const item of signals.filter((entry) => SUPPLIER_TYPES.has(entry.type) && entry.supplierId)) {
    bySupplier.set(item.supplierId, [...(bySupplier.get(item.supplierId) || []), item])
  }
  return [...bySupplier.entries()].filter(([, items]) => items.length > 1).map(([supplierId, items]) => {
    const worst = [...items].sort(compareSignals)[0]
    return {
      id: `supplier_exposure:${supplierId}`, type: 'supplier_exposure', score: worst.score, severity: worst.severity, entityType: 'supplier', entityId: supplierId,
      label: worst.supplier || supplierId, area: 'purchasing', supplierId, supplier: worst.supplier, money: null,
      data: { count: items.length, types: [...new Set(items.map((entry) => entry.type))], ids: items.map((entry) => entry.entityId) },
    }
  })
}

const moneyAtRisk = (item) => item.money?.amount ?? 0

export function runHighestRisk(facts, { focus = null } = {}) {
  const signals = buildAiSkillSignals(facts)
  const exposure = signals.filter((item) => item.score >= EXPOSURE_SCORE || item.money)
  const ranked = [...rankAiSkillItems(exposure), ...supplierExposure(exposure)]
    .filter((item) => matchesAiSkillFocus(item, focus))
    .sort((a, b) => b.score - a.score || moneyAtRisk(b) - moneyAtRisk(a) || a.entityId.localeCompare(b.entityId))
    .map((item, index) => ({ ...item, also: item.also || [], rank: index + 1 }))
  return { skillId: 'highest_risk_items', focus, total: ranked.length, items: ranked.slice(0, TOP) }
}

export function presentHighestRisk(result, facts, { skill, language, query }) {
  const fmt = aiSkillFormatter(facts, language)
  const first = result.items[0]
  const title = first
    ? aiSkillText('risk.title', language, { first: aiSkillText('risk.first', language, { label: first.label, status: aiSkillText(`signal.${first.type}.status`, language).toLowerCase() }) })
    : aiSkillText('risk.title_none', language, { date: fmt.day(facts.asOf) })
  const summary = aiSkillSentences([
    ...(result.total ? [aiSkillText('risk.summary', language, { count: fmt.number(result.total) })] : []),
    ...aiSkillMetricSentences(facts, language, { spend: false, invoices: false }),
  ], language)
  return presentAiSkillAnswer({ skill, facts, language, query, title, summary, severity: first?.severity || 'success', items: result.items, followUpIds: ['prepare_action_draft', 'today_priorities'] })
}
