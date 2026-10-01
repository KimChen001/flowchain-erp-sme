import { aiSkillCountText, aiSkillSentences, aiSkillText } from './ai-skill-copy.mjs'
import { aiSkillFormatter, aiSkillNavigation, aiSkillRecordEvidence, aiSkillRecordImpact, presentAiSkillAnswer } from './ai-skill-presenter.mjs'
import { aiSkillInvoiceMatch } from './ai-skill-readers.mjs'

// Committed supplier invoices (submitted for matching onwards, as the finance
// report counts them): the total per currency when the role may see amounts,
// the count, the three-way match results and the invoices with a variance.
// Currencies are never added together.

const array = (value) => Array.isArray(value) ? value : []
const MAX_EVIDENCE = 5
const largestFirst = (a, b) => Math.abs(b.variance ?? 0) - Math.abs(a.variance ?? 0) || String(a.id).localeCompare(String(b.id))

export function runInvoiceSummary(facts) {
  if (!facts?.invoices) return { skillId: 'invoice_summary', hidden: true }
  const invoices = facts.invoices
  return { skillId: 'invoice_summary', committed: invoices.committed, count: invoices.committedCount, matchCounts: invoices.matchCounts || { matched: 0, exception: 0, pending: 0 }, variances: [...array(invoices.variances)].sort(largestFirst) }
}

export function presentInvoiceSummary(result, facts, { skill, language, query }) {
  const base = { skill, facts, language, query, followUpIds: ['records_needing_data', 'today_priorities'] }
  if (result.hidden) return presentAiSkillAnswer({ ...base, title: aiSkillText('invoice.title_unavailable', language), summary: '', severity: 'info', items: [] })
  const fmt = aiSkillFormatter(facts, language)
  const amounts = array(result.committed?.amounts).filter((row) => row.amount !== null && row.amount !== undefined)
  const title = !result.count
    ? aiSkillText('invoice.title_none', language)
    : amounts.length
      ? aiSkillText('invoice.title', language, { amounts: fmt.moneyList(amounts), count: fmt.number(result.count) })
      : aiSkillText('invoice.title_hidden', language, { count: fmt.number(result.count) })
  const { matched, exception, pending } = result.matchCounts
  const sentences = result.count ? [
    aiSkillText('invoice.match', language, { matched: fmt.number(matched), exception: fmt.number(exception), pending: fmt.number(pending) }),
    aiSkillCountText('invoice.variances', result.variances.length, language, { count: fmt.number(result.variances.length) }),
  ] : []
  const built = result.variances.slice(0, MAX_EVIDENCE).map((row, index) => {
    const match = aiSkillText(`match.${aiSkillInvoiceMatch(row)}`, language)
    return {
      evidence: aiSkillRecordEvidence({
        evidenceType: 'invoice_variance', entityType: 'supplier_invoice', entityId: row.id, label: row.invoiceNumber || row.id, status: aiSkillText('invoice.impact', language),
        // A supplier the role may not see on invoices is "a supplier".
        summary: aiSkillText('invoice.evidence', language, { supplier: row.supplier || aiSkillText('value.a_supplier', language), match }),
        value: row.variance === null || row.variance === undefined ? null : fmt.money(row.variance, row.currency), severity: 'warning', rank: index + 1,
      }, language),
      impact: aiSkillRecordImpact({ area: 'finance', entityId: row.id, severity: 'warning', impact: aiSkillText('invoice.impact', language), explanation: aiSkillText('invoice.impact.explanation', language) }, language),
      navigation: aiSkillNavigation({ label: row.invoiceNumber || row.id, entityType: 'supplier_invoice', entityId: row.id }, language),
    }
  })
  const figures = [
    ...amounts.filter((row) => row.currency).map((row) => ({ key: `committed_invoices:${row.currency}`, code: 'committed_invoices', entityId: null, currency: row.currency, value: row.amount })),
    { key: 'committed_invoice_count', code: 'committed_invoice_count', entityId: null, value: result.count },
    { key: 'invoice_variance_count', code: 'invoice_variance_count', entityId: null, value: result.variances.length },
  ]
  return presentAiSkillAnswer({
    ...base, figures, title, summary: aiSkillSentences(sentences, language), severity: exception || result.variances.length ? 'warning' : 'info',
    evidence: built.map((entry) => entry.evidence), impacts: built.map((entry) => entry.impact), navigation: built.slice(0, 3).map((entry) => entry.navigation),
  })
}
