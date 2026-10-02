import { aiSkillCountText, aiSkillSentences, aiSkillText } from './ai-skill-copy.mjs'
import { aiSkillFormatter, aiSkillNavigation, aiSkillRecordEvidence, aiSkillRecordImpact, presentAiSkillAnswer } from './ai-skill-presenter.mjs'

// Open RFQs without an award (status open or collecting quotes): those with
// quotes that wait for a supplier to be selected, those with no quote yet,
// and those past their quote due date. The answer lists them; it never awards,
// sends or invites anything.

const array = (value) => Array.isArray(value) ? value : []
const MAX_EVIDENCE = 8

// Quoted first, then past due, then the nearest due date, then the id.
const byAttention = (a, b) => Number(b.responses > 0) - Number(a.responses > 0) || Number(b.pastDue) - Number(a.pastDue) || String(a.due || '9999-12-31').localeCompare(String(b.due || '9999-12-31')) || a.id.localeCompare(b.id)

export function runRfqFollowups(facts) {
  if (!facts?.rfqs) return { skillId: 'rfq_followups', hidden: true }
  const asOf = facts.asOf || null
  const rows = array(facts.rfqs.open).map((row) => ({ ...row, pastDue: Boolean(row.due && asOf && row.due < asOf) })).sort(byAttention)
  return {
    skillId: 'rfq_followups',
    rows,
    ready: rows.filter((row) => row.responses > 0).length,
    waiting: rows.filter((row) => row.responses === 0).length,
    pastDue: rows.filter((row) => row.pastDue).length,
  }
}

export function presentRfqFollowups(result, facts, { skill, language, query }) {
  const base = { skill, facts, language, query, followUpIds: ['purchase_orders', 'today_priorities'] }
  if (result.hidden) return presentAiSkillAnswer({ ...base, title: aiSkillText('rfq.title_hidden', language), summary: aiSkillText('access.ask_admin', language), severity: 'info', items: [] })
  const fmt = aiSkillFormatter(facts, language)
  const count = (key, value) => value ? aiSkillCountText(key, value, language, { count: fmt.number(value) }) : ''
  const built = result.rows.slice(0, MAX_EVIDENCE).map((row, index) => {
    const quoted = row.responses > 0
    const status = aiSkillText(quoted ? 'signal.rfq_ready_to_award.status' : 'rfq.waiting_status', language)
    const quotes = row.invited ? aiSkillText('rfq.row_quotes_of', language, { responses: fmt.number(row.responses), invited: fmt.number(row.invited) }) : aiSkillCountText('rfq.row_quotes', row.responses, language, { count: fmt.number(row.responses) })
    const due = row.due ? aiSkillText(row.pastDue ? 'rfq.row_past_due' : 'rfq.row_due', language, { date: fmt.day(row.due) }) : ''
    const severity = row.pastDue || quoted ? 'warning' : 'info'
    return {
      evidence: aiSkillRecordEvidence({ evidenceType: quoted ? 'rfq_ready_to_award' : 'rfq_waiting_for_quotes', entityType: 'rfq', entityId: row.id, label: row.title || row.id, status, summary: [quotes, due].filter(Boolean).join(' · '), severity, rank: index + 1 }, language),
      impact: aiSkillRecordImpact({ area: 'sourcing', entityId: row.id, severity, impact: status, explanation: aiSkillText(quoted ? 'impact.rfq_ready_to_award' : 'rfq.impact.waiting', language) }, language),
      navigation: aiSkillNavigation({ label: row.title || row.id, entityType: 'rfq', entityId: row.id }, language),
    }
  })
  return presentAiSkillAnswer({
    ...base,
    title: aiSkillCountText('rfq.title', result.rows.length, language, { count: fmt.number(result.rows.length) }),
    summary: aiSkillSentences([count('rfq.ready', result.ready), count('rfq.waiting', result.waiting), count('rfq.past_due', result.pastDue)], language),
    severity: result.pastDue || result.ready ? 'warning' : 'info',
    evidence: built.map((entry) => entry.evidence), impacts: built.map((entry) => entry.impact), navigation: built.slice(0, 3).map((entry) => entry.navigation),
  })
}
