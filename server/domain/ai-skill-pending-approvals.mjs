import { aiSkillCountText, aiSkillList, aiSkillSentences, aiSkillText } from './ai-skill-copy.mjs'
import { aiSkillFormatter, aiSkillNavigation, aiSkillRecordEvidence, aiSkillRecordImpact, presentAiSkillAnswer } from './ai-skill-presenter.mjs'

// Purchase orders waiting for approval (status pending_approval after alias
// normalisation, from every order the report reads) and purchase requests
// submitted for approval. The answer lists them; it never approves anything.

const array = (value) => Array.isArray(value) ? value : []
const MAX_EVIDENCE = 8
const oldestFirst = (a, b) => String(a.createdDate || a.requiredDate || '').localeCompare(String(b.createdDate || b.requiredDate || '')) || String(a.id).localeCompare(String(b.id))

// A supplier or SKU the question names narrows the list.
export function runPendingApprovals(facts, { route = null } = {}) {
  const suppliers = new Set(array(route?.entities?.suppliers).map((row) => row.id))
  const skus = new Set(array(route?.entities?.skus).map((row) => row.sku))
  const order = (row) => (!suppliers.size || suppliers.has(row.supplierId)) && (!skus.size || array(row.skus).some((sku) => skus.has(sku)))
  const request = (row) => !suppliers.size && (!skus.size || array(row.skus).some((sku) => skus.has(sku)))
  if (route?.mode === 'not_found') {
    const entities = route.entities || {}
    return { skillId: 'pending_approvals', notFound: [...array(entities.absent), ...array(entities.truncated)].map((entry) => entry.id) }
  }
  return {
    skillId: 'pending_approvals',
    filtered: Boolean(suppliers.size || skus.size),
    names: [...array(route?.entities?.suppliers).map((row) => row.name || row.code || row.id), ...array(route?.entities?.skus).map((row) => row.sku)],
    bySupplier: Boolean(suppliers.size),
    orders: facts?.purchaseOrders ? array(facts.purchaseOrders.pendingApproval).filter(order).sort(oldestFirst) : null,
    requests: facts?.purchaseRequests ? array(facts.purchaseRequests.awaitingApproval).filter(request).sort(oldestFirst) : null,
  }
}

export function presentPendingApprovals(result, facts, { skill, language, query }) {
  const base = { skill, facts, language, query, followUpIds: ['purchase_orders', 'today_priorities'] }
  if (result.notFound) return presentAiSkillAnswer({ ...base, title: aiSkillText('lookup.not_found_title', language, { id: aiSkillList(result.notFound, language) }), summary: aiSkillText('lookup.not_found_summary', language), severity: 'info', items: [], navigation: [] })
  if (!result.orders) return presentAiSkillAnswer({ ...base, title: aiSkillText('po.title_hidden', language), summary: aiSkillText('access.ask_admin', language), severity: 'info', items: [] })
  const fmt = aiSkillFormatter(facts, language)
  const status = aiSkillText('approval.status', language)
  const sentences = []
  if (result.filtered) sentences.push(aiSkillText('approval.filtered_summary', language, { name: aiSkillList(result.names, language) }))
  if (result.requests && !result.bySupplier) sentences.push(aiSkillCountText('approval.requests', result.requests.length, language, { count: fmt.number(result.requests.length) }))
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
    figures: result.filtered ? [] : [{ key: 'pending_approval_po_count', code: 'pending_approval_po_count', entityId: null, value: result.orders.length }, ...(result.requests ? [{ key: 'pending_approval_pr_count', code: 'pending_approval_pr_count', entityId: null, value: result.requests.length }] : [])],
    title: result.filtered
      ? aiSkillCountText('approval.filtered_title', result.orders.length, language, { count: fmt.number(result.orders.length), name: aiSkillList(result.names, language) })
      : aiSkillCountText('approval.title', result.orders.length, language, { count: fmt.number(result.orders.length) }),
    summary: aiSkillSentences(sentences, language),
    severity: result.orders.length ? 'warning' : 'info',
    evidence: built.map((entry) => entry.evidence), impacts: built.map((entry) => entry.impact), navigation: built.slice(0, 3).map((entry) => entry.navigation),
  })
}
