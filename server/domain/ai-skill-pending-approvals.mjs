import { aiSkillCountText, aiSkillSentences, aiSkillText } from './ai-skill-copy.mjs'
import { aiSkillFormatter, aiSkillNavigation, aiSkillRecordEvidence, aiSkillRecordImpact, presentAiSkillAnswer } from './ai-skill-presenter.mjs'

// Purchase orders waiting for approval (status pending_approval after alias
// normalisation, from every order the report reads) and purchase requests
// submitted for approval. The answer lists them; it never approves anything.

const array = (value) => Array.isArray(value) ? value : []
const MAX_EVIDENCE = 8
const oldestFirst = (a, b) => String(a.createdDate || a.requiredDate || '').localeCompare(String(b.createdDate || b.requiredDate || '')) || String(a.id).localeCompare(String(b.id))

export function runPendingApprovals(facts) {
  return {
    skillId: 'pending_approvals',
    orders: facts?.purchaseOrders ? [...array(facts.purchaseOrders.pendingApproval)].sort(oldestFirst) : null,
    requests: facts?.purchaseRequests ? [...array(facts.purchaseRequests.awaitingApproval)].sort(oldestFirst) : null,
  }
}

export function presentPendingApprovals(result, facts, { skill, language, query }) {
  const base = { skill, facts, language, query, followUpIds: ['purchase_orders', 'today_priorities'] }
  if (!result.orders) return presentAiSkillAnswer({ ...base, title: aiSkillText('po.title_hidden', language), summary: '', severity: 'info', items: [] })
  const fmt = aiSkillFormatter(facts, language)
  const status = aiSkillText('approval.status', language)
  const sentences = []
  if (result.requests) sentences.push(aiSkillCountText('approval.requests', result.requests.length, language, { count: fmt.number(result.requests.length) }))
  // Money stays in its own currency, and only when the role may see it.
  if (facts.visibility?.amounts?.purchase_order_amounts) {
    const totals = new Map()
    for (const row of result.orders) if (row.amount !== null && row.amount !== undefined && row.currency) totals.set(row.currency, (totals.get(row.currency) || 0) + row.amount)
    if (totals.size) sentences.push(aiSkillText('approval.amounts', language, { amounts: fmt.moneyList([...totals].map(([currency, amount]) => ({ currency, amount: Math.round(amount * 100) / 100 }))) }))
  }
  const built = [
    ...result.orders.map((row) => ({ row, type: 'purchase_order', label: row.orderNumber || row.id, summary: aiSkillText('approval.po_summary', language, { supplier: row.supplier, date: fmt.day(row.createdDate) }) })),
    ...array(result.requests).map((row) => ({ row, type: 'purchase_request', label: row.id, summary: aiSkillText('approval.pr_summary', language, { date: fmt.day(row.requiredDate) }) })),
  ].slice(0, MAX_EVIDENCE).map(({ row, type, label, summary }, index) => ({
    evidence: aiSkillRecordEvidence({ evidenceType: `${type}_awaiting_approval`, entityType: type, entityId: row.id, label, status, summary, severity: 'warning', rank: index + 1 }, language),
    impact: aiSkillRecordImpact({ area: 'purchasing', entityId: row.id, severity: 'warning', impact: status, explanation: aiSkillText('approval.impact.explanation', language) }, language),
    navigation: aiSkillNavigation({ label, entityType: type, entityId: row.id }, language),
  }))
  return presentAiSkillAnswer({
    ...base,
    title: aiSkillCountText('approval.title', result.orders.length, language, { count: fmt.number(result.orders.length) }),
    summary: aiSkillSentences(sentences, language),
    severity: result.orders.length ? 'warning' : 'info',
    evidence: built.map((entry) => entry.evidence), impacts: built.map((entry) => entry.impact), navigation: built.slice(0, 3).map((entry) => entry.navigation),
  })
}
