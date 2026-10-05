import { aiSkillCountText, aiSkillSentences, aiSkillText } from './ai-skill-copy.mjs'
import { aiSkillFormatter, presentAiSkillAnswer } from './ai-skill-presenter.mjs'
import { buildAiSkillSignals, rankAiSkillItemsByDate } from './ai-skill-signals.mjs'

// Receipts that need attention: a rejected quantity while the purchase order
// is still open (the supplier owes a return or a replacement), and goods
// received but not posted to inventory. One entry per receipt, with its
// strongest reason. The answer lists them; it never posts or returns anything.

const array = (value) => Array.isArray(value) ? value : []
const MAX_EVIDENCE = 8
const RECEIVING_SIGNALS = new Set(['grn_rejected_qty', 'grn_received_unposted'])

export function runReceivingIssues(facts) {
  if (!facts?.receipts) return { skillId: 'receiving_issues', hidden: true }
  const items = rankAiSkillItemsByDate(buildAiSkillSignals(facts).filter((item) => RECEIVING_SIGNALS.has(item.type)))
  return { skillId: 'receiving_issues', items, rejected: array(facts.receipts.rejected).length, unposted: array(facts.receipts.unposted).length }
}

export function presentReceivingIssues(result, facts, { skill, language, query }) {
  const base = { skill, facts, language, query, followUpIds: ['purchase_orders', 'today_priorities'] }
  if (result.hidden) return presentAiSkillAnswer({ ...base, title: aiSkillText('receiving.title_hidden', language), summary: aiSkillText('access.ask_admin', language), severity: 'info', items: [] })
  const fmt = aiSkillFormatter(facts, language)
  const count = (key, value) => value ? aiSkillCountText(key, value, language, { count: fmt.number(value) }) : ''
  return presentAiSkillAnswer({
    ...base,
    title: aiSkillCountText('receiving.title', result.items.length, language, { count: fmt.number(result.items.length) }),
    summary: result.items.length
      ? aiSkillSentences([count('receiving.rejected', result.rejected), count('receiving.unposted', result.unposted)], language)
      : aiSkillText('receiving.none_summary', language),
    severity: result.rejected ? 'warning' : 'info',
    items: result.items.slice(0, MAX_EVIDENCE),
  })
}
