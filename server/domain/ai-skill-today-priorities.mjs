import { aiSkillCountText, aiSkillSentences, aiSkillText } from './ai-skill-copy.mjs'
import { aiSkillFormatter, aiSkillMetricSentences, presentAiSkillAnswer } from './ai-skill-presenter.mjs'
import { buildAiSkillSignals, countAiSkillSignals, rankAiSkillItems } from './ai-skill-signals.mjs'

const TOP = 5
const array = (value) => Array.isArray(value) ? value : []

// Whether a ranked record belongs to the page focus: the record itself, or a
// record tied to it (an invoice or receipt of the focused PO, a PO or request
// for the focused SKU).
export function matchesAiSkillFocus(item, focus) {
  if (!focus) return true
  const id = focus.entityId
  if (item.entityType === focus.entityType && (item.entityId === id || item.label === id)) return true
  const data = item.data || {}
  if (focus.entityType === 'purchase_order') return data.poId === id || array(data.purchaseOrderIds).includes(id)
  if (focus.entityType === 'item') return data.itemId === id || data.sku === id
  if (focus.entityType === 'supplier') return item.supplierId === id
  return false
}

export function runTodayPriorities(facts, { focus = null } = {}) {
  const signals = buildAiSkillSignals(facts)
  const ranked = rankAiSkillItems(signals).filter((item) => matchesAiSkillFocus(item, focus))
  return { skillId: 'today_priorities', focus, total: ranked.length, items: ranked.slice(0, TOP).map((item, index) => ({ ...item, rank: index + 1 })), counts: countAiSkillSignals(signals) }
}

export function presentTodayPriorities(result, facts, { skill, language, query }) {
  const fmt = aiSkillFormatter(facts, language)
  const date = fmt.day(facts.asOf)
  const title = result.focus
    ? aiSkillText(result.items.length ? 'today.focus_title' : 'today.focus_none', language, { id: result.focus.entityId })
    : aiSkillCountText('today.title', result.total, language, { count: fmt.number(result.total), date })
  return presentAiSkillAnswer({
    skill, facts, language, query, title,
    summary: aiSkillSentences(aiSkillMetricSentences(facts, language), language),
    severity: result.items[0]?.severity || 'success',
    items: result.items,
    followUpIds: ['prepare_action_draft', 'records_needing_data'],
  })
}
