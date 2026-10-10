import { aiSkillCountText, aiSkillSentences, aiSkillText } from './ai-skill-copy.mjs'
import { aiSkillFormatter, aiSkillMetricSentences, presentAiSkillAnswer } from './ai-skill-presenter.mjs'
import { buildAiSkillSignals, countAiSkillSignals, rankAiSkillItemsByDate } from './ai-skill-signals.mjs'

const TOP = 5
const array = (value) => Array.isArray(value) ? value : []

// Whether a ranked record belongs to the page focus: the record itself, or a
// record tied to it (an invoice or receipt of the focused PO, a PO or request
// for the focused SKU). The focused item is its id or its SKU. A PO is for an
// item while a line of it for the item is still to receive, and a request by
// any of its lines: never by the first line alone, which may be another item
// or, on a PO, fully received.
export function matchesAiSkillFocus(item, focus) {
  if (!focus) return true
  const id = focus.entityId
  if (item.entityType === focus.entityType && (item.entityId === id || item.label === id)) return true
  const data = item.data || {}
  if (focus.entityType === 'purchase_order') return data.poId === id || array(data.purchaseOrderIds).includes(id)
  if (focus.entityType === 'item') {
    if (Array.isArray(data.openLines)) return data.openLines.some((line) => line.itemId === id || line.sku === id)
    return data.itemId === id || data.sku === id || array(data.itemIds).includes(id) || array(data.skus).includes(id)
  }
  if (focus.entityType === 'supplier') return item.supplierId === id
  return false
}

// How a title names the focused record: an order by its number, an item by
// its SKU, a supplier by its name, anything else by its id.
export function aiSkillFocusName(focus, facts) {
  const id = focus?.entityId
  if (focus?.entityType === 'purchase_order') return array(facts?.purchaseOrders?.index).find((row) => row.id === id)?.orderNumber || id
  if (focus?.entityType === 'item') return [...array(facts?.inventory?.rows), ...array(facts?.inventory?.masterOnly)].find((row) => row.itemId === id)?.sku || id
  if (focus?.entityType === 'supplier') return array(facts?.suppliers).find((row) => row.id === id)?.name || id
  return id
}

// Ordered by date, not by score (compareSignalsByDate in ai-skill-signals.mjs):
// the longest overdue first, then what falls due soonest, then the oldest open
// problems, then stock below its levels.
// A user under pressure (route signal `calm`) gets the first CALM only.
const CALM = 3
export function runTodayPriorities(facts, { focus = null, route = null } = {}) {
  const signals = buildAiSkillSignals(facts)
  const ranked = rankAiSkillItemsByDate(signals).filter((item) => matchesAiSkillFocus(item, focus))
  const calm = Boolean(route?.signals?.calm) && !focus
  return { skillId: 'today_priorities', focus, calm, total: ranked.length, items: ranked.slice(0, calm ? CALM : TOP).map((item, index) => ({ ...item, rank: index + 1 })), counts: countAiSkillSignals(signals) }
}

// When the answer lists fewer records than its title counts, it says so.
export function showingSentence(result, fmt, language, key) {
  return result.total > result.items.length ? aiSkillText(key, language, { shown: fmt.number(result.items.length), total: fmt.number(result.total) }) : ''
}

export function presentTodayPriorities(result, facts, { skill, language, query }) {
  const fmt = aiSkillFormatter(facts, language)
  const date = fmt.day(facts.asOf)
  const calm = result.calm && result.items.length > 0
  const title = result.focus
    ? aiSkillText(result.items.length ? 'today.focus_title' : 'today.focus_none', language, { id: aiSkillFocusName(result.focus, facts) })
    : calm ? aiSkillCountText('today.calm_title', result.items.length, language, { count: fmt.number(result.items.length) })
      : aiSkillCountText('today.title', result.total, language, { count: fmt.number(result.total), date })
  return presentAiSkillAnswer({
    skill, facts, language, query, title,
    // The answer lists what needs doing; supplier invoices already submitted
    // are not part of it (the paid ones would read as still owed).
    // Under pressure: what is left, not the report figures.
    summary: calm
      ? aiSkillText(result.total > result.items.length ? 'today.calm_more' : 'today.calm_all', language, { total: fmt.number(result.total) })
      : aiSkillSentences([showingSentence(result, fmt, language, 'answer.showing'), ...aiSkillMetricSentences(facts, language, { invoices: false })], language),
    severity: result.items[0]?.severity || 'success',
    items: result.items,
    // The whole list's count, which the answer shows the first of.
    figures: [{ key: 'attention_item_count', code: 'attention_item_count', entityId: null, value: result.total }],
    followUpIds: ['prepare_action_draft', 'records_needing_data'],
  })
}
