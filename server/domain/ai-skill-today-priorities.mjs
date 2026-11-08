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

// Ordered by date, not by score (compareSignalsByDate in ai-skill-signals.mjs):
// the longest overdue first, then what falls due soonest, then the oldest open
// problems, then stock below its levels.
// A user under pressure (route signal `calm`) gets the first CALM only.
// `top`: how many items to keep, TOP for the skill answer; the assistant's
// attention list (ai-assistant-v2-data-tools.mjs) keeps them all and filters.
const CALM = 3
export function runTodayPriorities(facts, { focus = null, route = null, top = TOP } = {}) {
  const signals = buildAiSkillSignals(facts)
  const ranked = rankAiSkillItemsByDate(signals).filter((item) => matchesAiSkillFocus(item, focus))
  const calm = Boolean(route?.signals?.calm) && !focus
  return { skillId: 'today_priorities', focus, calm, total: ranked.length, items: ranked.slice(0, calm ? CALM : top).map((item, index) => ({ ...item, rank: index + 1 })), counts: countAiSkillSignals(signals) }
}
