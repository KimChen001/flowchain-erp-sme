import { randomUUID } from 'node:crypto'
import { aiSkillCountText, aiSkillLanguage, aiSkillList, aiSkillSentences, aiSkillText } from './ai-skill-copy.mjs'
import { AI_SKILL_SIGNAL_VERSION } from './ai-skill-signals.mjs'

// Turns a skill result (codes, ids, numbers) into the full AiResponseV2 the
// assistant renders. Text comes from the copy catalog in the answer language.
// Numbers, money and dates use the tenant's locale, currency codes and
// timezone, whatever the language: the language never changes a value.
// Amounts use the record's own currency; an amount without one is a plain
// number with a currency_missing limitation, never a guessed currency.

const array = (value) => Array.isArray(value) ? value : []
const ISO_CURRENCY = /^[A-Z]{3}$/

export const AI_SKILL_ANSWER_SOURCE = 'workspace_rules'

export const AI_SKILL_MODULES = Object.freeze({
  purchase_order: 'procurement:orders',
  item: 'master-data:items',
  supplier: 'master-data:suppliers',
  supplier_invoice: 'procurement:invoices',
  purchase_request: 'procurement:requests',
  rfq: 'procurement:rfq',
  receiving_doc: 'procurement:receiving',
})
const SOURCE_OF = { purchase_order: 'purchase_orders', item: 'inventory', supplier: 'purchase_orders', supplier_invoice: 'supplier_invoices', purchase_request: 'purchase_requests', rfq: 'rfqs', receiving_doc: 'receipts' }

export function aiSkillFormatter(facts, language) {
  const locale = facts.locale || 'en-US'
  const numberFormat = new Intl.NumberFormat(locale, { maximumFractionDigits: 4 })
  const number = (value) => value === null || value === undefined || !Number.isFinite(Number(value)) ? aiSkillText('value.unknown', language) : numberFormat.format(Number(value))
  const quantity = (value, unit) => unit && unit !== 'mixed' ? `${number(value)} ${unit}` : number(value)
  const money = (value, currency) => {
    if (value === null || value === undefined || !Number.isFinite(Number(value))) return aiSkillText('value.unknown', language)
    const code = String(currency || '').toUpperCase()
    if (!ISO_CURRENCY.test(code)) return number(value)
    try {
      return new Intl.NumberFormat(locale, { style: 'currency', currency: code }).format(Number(value))
    } catch {
      return number(value)
    }
  }
  // A calendar day is shown as that day, not shifted by a timezone.
  const day = (value) => {
    const text = String(value || '').slice(0, 10)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return aiSkillText('value.unknown', language)
    return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeZone: 'UTC' }).format(new Date(`${text}T12:00:00Z`))
  }
  const moneyList = (amounts) => aiSkillList(array(amounts).filter((row) => row.amount !== null && row.amount !== undefined).map((row) => money(row.amount, row.currency)), language)
  return { number, quantity, money, day, moneyList }
}

// The report figures every data answer carries, for the reader and for tests
// that compare them with the reports.
export function aiSkillReportMetrics(facts) {
  return {
    asOf: facts.asOf,
    openPurchaseOrders: facts.purchaseOrders?.open ?? null,
    overduePurchaseOrders: facts.purchaseOrders?.overdue ?? null,
    committedSpend: facts.purchaseOrders?.committedSpend ? facts.purchaseOrders.committedSpend.amounts.map(({ currency, amount }) => ({ currency, amount })) : null,
    committedInvoices: facts.invoices?.committed ? facts.invoices.committed.amounts.map(({ currency, amount }) => ({ currency, amount })) : null,
    atRiskSkus: facts.inventory ? [...facts.inventory.atRisk] : null,
    atRiskSkuCount: facts.inventory?.atRiskCount ?? null,
  }
}

// Sentences stating the report figures, in the answer language.
export function aiSkillMetricSentences(facts, language, { spend = true, invoices = true, atRisk = true } = {}) {
  const fmt = aiSkillFormatter(facts, language)
  const sentences = []
  const po = facts.purchaseOrders
  if (po) sentences.push(aiSkillText(po.overdue ? 'metrics.open_pos' : 'metrics.no_overdue', language, { open: fmt.number(po.open), overdue: fmt.number(po.overdue) }))
  if (spend && po?.committedSpend?.amounts?.length) sentences.push(aiSkillText('metrics.committed_spend', language, { amounts: fmt.moneyList(po.committedSpend.amounts) }))
  if (invoices && facts.invoices?.committed?.amounts?.length) sentences.push(aiSkillText('metrics.committed_invoices', language, { amounts: fmt.moneyList(facts.invoices.committed.amounts) }))
  if (atRisk && facts.inventory) sentences.push(aiSkillCountText('metrics.at_risk', facts.inventory.atRisk.length, language, { skus: aiSkillList(facts.inventory.atRisk, language) }))
  return sentences
}

function signalValue(item, fmt, language) {
  const data = item.data || {}
  switch (item.type) {
    case 'po_overdue': return aiSkillText('value.days_late', language, { days: fmt.number(data.days) })
    case 'po_due_7d': return aiSkillText('value.due_in', language, { days: fmt.number(data.days) })
    case 'po_partially_received': return aiSkillText('value.received_of', language, { received: fmt.number(data.received), ordered: fmt.quantity(data.ordered, data.unit) })
    case 'stock_shortage': return aiSkillText('value.short', language, { shortage: fmt.number(data.shortage) })
    case 'stock_below_safety': return aiSkillText('value.of', language, { value: fmt.number(data.available), target: fmt.number(data.safety) })
    case 'stock_below_reorder': return aiSkillText('value.of', language, { value: fmt.number(data.atp), target: fmt.number(data.reorder) })
    case 'invoice_variance': return data.variance === null ? null : fmt.money(data.variance, data.currency)
    case 'rfq_ready_to_award': return aiSkillText('value.quotes', language, { responses: fmt.number(data.responses) })
    case 'grn_rejected_qty': return fmt.quantity(data.rejected, data.unit)
    case 'supplier_exposure': return aiSkillText('value.issues', language, { count: fmt.number(data.count) })
    default: return null
  }
}

export function aiSkillSignalReason(item, facts, language) {
  const fmt = aiSkillFormatter(facts, language)
  const data = item.data || {}
  const remaining = fmt.quantity(data.remaining, data.unit)
  const values = {
    po_overdue: { days: fmt.number(data.days), remaining, supplier: data.supplier },
    po_due_7d: { date: fmt.day(data.dueDate), remaining, supplier: data.supplier },
    po_partially_received: { received: fmt.number(data.received), ordered: fmt.quantity(data.ordered, data.unit) },
    stock_shortage: { available: fmt.number(data.available), demand: fmt.number(data.demand), shortage: fmt.number(data.shortage), incoming: fmt.number(data.incoming) },
    stock_below_safety: { available: fmt.number(data.available), safety: fmt.number(data.safety), incoming: fmt.number(data.incoming) },
    stock_below_reorder: { atp: fmt.number(data.atp), reorder: fmt.number(data.reorder) },
    // A supplier name the role may not see on invoices is "a supplier".
    invoice_variance: { amount: fmt.money(data.variance, data.currency), supplier: data.supplier || aiSkillText('value.a_supplier', language) },
    pr_awaiting_approval: { priority: aiSkillText(`priority.${['high', 'medium', 'low'].includes(data.priority) ? data.priority : 'none'}`, language) },
    rfq_ready_to_award: { responses: fmt.number(data.responses) },
    grn_rejected_qty: { rejected: fmt.quantity(data.rejected, data.unit), supplier: data.supplier },
    grn_received_unposted: {},
    supplier_exposure: { count: fmt.number(data.count), supplier: item.label, issues: aiSkillList(array(data.types).map((type) => aiSkillText(`signal.${type}.status`, language).toLowerCase()), language) },
  }[item.type] || {}
  // An order not yet issued to the supplier is to be sent, not chased (decision V5).
  const reasonKey = item.type === 'invoice_variance' && data.variance === null ? 'signal.invoice_variance.reason_hidden'
    : data.notSent && SELF_DATED.has(item.type) ? `signal.${item.type}.reason_not_sent` : `signal.${item.type}.reason`
  const reason = item.type === 'po_overdue' ? aiSkillCountText(reasonKey, data.days === 1 ? 1 : 2, language, values) : aiSkillText(reasonKey, language, values)
  return aiSkillSentences([reason, aiSkillWhenText(item, facts, language), data.covered && item.type.startsWith('stock_') ? aiSkillText('signal.covered', language) : ''], language)
}

// The date a line is ordered by, as a sentence ("Open 12 days, since Sep 21."),
// so the reader can check the order. The overdue and due-soon order reasons
// already state theirs.
const SELF_DATED = new Set(['po_overdue', 'po_due_7d'])
export function aiSkillWhenText(item, facts, language) {
  const when = item.when
  if (!when || when.kind === 'undated' || when.days === null || SELF_DATED.has(item.type)) return ''
  const fmt = aiSkillFormatter(facts, language)
  const values = { days: fmt.number(when.days), date: fmt.day(when.date) }
  if (when.kind === 'overdue') return aiSkillCountText('signal.when.overdue', when.days, language, values)
  if (when.kind === 'due') return aiSkillCountText('signal.when.due', when.days, language, values)
  return aiSkillCountText('signal.when.open', when.days, language, values)
}

export function aiSkillEvidence(item, facts, language) {
  const fmt = aiSkillFormatter(facts, language)
  const moduleId = AI_SKILL_MODULES[item.entityType]
  const status = aiSkillText(`signal.${item.type}.status`, language)
  return {
    id: item.id, label: status, entityLabel: item.label, entityType: item.entityType, entityId: item.entityId, moduleId,
    evidenceType: item.type, summary: aiSkillSignalReason(item, facts, language), value: signalValue(item, fmt, language),
    status, statusCode: item.type, severity: item.severity, rank: item.rank ?? null,
    sourceLabel: aiSkillText(`source.${SOURCE_OF[item.entityType]}`, language),
    linkTarget: { moduleId, entityType: item.entityType, entityId: item.entityId },
  }
}

// Evidence for a record a record skill names itself, outside the attention
// signals: a purchase order, a SKU, an invoice or a purchase request.
export function aiSkillRecordEvidence({ evidenceType, entityType, entityId, label, status, summary, value = null, severity = 'info', rank = null }, language) {
  const moduleId = AI_SKILL_MODULES[entityType]
  return {
    id: `${evidenceType}:${entityId}`, label: status, entityLabel: label || entityId, entityType, entityId, moduleId,
    evidenceType, summary, value, status, statusCode: evidenceType, severity, rank,
    sourceLabel: aiSkillText(`source.${SOURCE_OF[entityType]}`, language),
    linkTarget: { moduleId, entityType, entityId },
  }
}

export function aiSkillRecordImpact({ area, impact, explanation, severity = 'info', entityId }, language) {
  return { area: aiSkillText(`area.${area}`, language), impact, severity, explanation, affectedObjects: [entityId] }
}

export function aiSkillImpact(item, language) {
  return {
    area: aiSkillText(`area.${item.area || 'purchasing'}`, language),
    impact: aiSkillText(`signal.${item.type}.status`, language),
    severity: item.severity,
    explanation: aiSkillText(`impact.${item.type}`, language),
    affectedObjects: [item.entityId],
  }
}

export function aiSkillNavigation(item, language) {
  return {
    label: aiSkillText('nav.open', language, { id: item.label }),
    moduleId: AI_SKILL_MODULES[item.entityType],
    entityType: item.entityType,
    entityId: item.entityId,
    returnTo: 'ai-assistant',
    source: 'ai',
    ...(item.entityType === 'purchase_order' ? { focusTarget: { entityType: 'purchase_order', entityId: item.entityId, focusArea: 'receiving-invoice-variance' } } : {}),
  }
}

function limitationEntries(facts, language, { money: includeMoney = true } = {}) {
  const fmt = aiSkillFormatter(facts, language)
  const sourceList = (sources) => aiSkillList(array(sources).map((source) => aiSkillText(`source.${source}`, language)), language)
  const entries = []
  const push = (code, values, missingData) => entries.push({ code, label: aiSkillText(`limitation.${code}.label`, language, values), description: aiSkillText(`limitation.${code}.description`, language, values), severity: 'warning', missingData })
  for (const limitation of array(facts.limitations)) {
    if (limitation.code === 'hidden_by_permission') push('hidden_by_permission', { sources: sourceList(limitation.sources) }, limitation.sources)
    else if (limitation.code === 'amounts_hidden' && includeMoney) push('amounts_hidden', { what: aiSkillText(`source.${limitation.what}`, language) }, [limitation.what])
    else if (limitation.code === 'truncated') push('truncated', { limit: fmt.number(limitation.limit), source: aiSkillText(`source.${limitation.source}`, language) }, [limitation.source])
    else if (limitation.code === 'report_day') push('report_day', { date: fmt.day(limitation.date) }, [])
  }
  const money = includeMoney ? [facts.purchaseOrders?.committedSpend, facts.invoices?.committed].filter(Boolean) : []
  if (money.some((row) => row.status === 'multi_currency_unconverted')) push('multi_currency', {}, [])
  if (money.some((row) => row.amounts.some((amount) => !amount.currency))) push('currency_missing', {}, [])
  if (money.some((row) => row.limitations.includes('amount_missing'))) push('amount_missing', {}, [])
  return entries
}

function followUps(ids, language) {
  const key = { today_priorities: 'today', highest_risk_items: 'risk', records_needing_data: 'records', prepare_action_draft: 'draft', workspace_metrics: 'metrics', purchase_orders: 'orders', pending_approvals: 'approvals', inventory_availability: 'stock', invoice_summary: 'invoices', rfq_followups: 'rfqs', receiving_issues: 'receiving', supplier_attention: 'suppliers' }
  return ids.map((id) => ({ label: aiSkillText(`followup.${key[id]}.label`, language), prompt: aiSkillText(`followup.${key[id]}.prompt`, language), intentHint: id, skillHint: id, requiresReview: id === 'prepare_action_draft' }))
}

// The full AiResponseV2. Every list is an array, so the renderer never throws.
export function presentAiSkillAnswer({ skill, facts, language: requested, query, title, summary, severity, items = [], evidence, impacts, navigation, reviewCards = [], followUpIds = [], extraLimitations = [], scopeModule = 'workspace', moneyLimitations = true, figures = [] }) {
  const language = aiSkillLanguage(requested)
  const keyEvidence = evidence || items.map((item) => aiSkillEvidence(item, facts, language))
  const businessImpact = impacts || items.map((item) => aiSkillImpact(item, language))
  const navigationLinks = navigation || items.slice(0, 3).map((item) => aiSkillNavigation(item, language))
  const dataLimitations = [...(facts ? limitationEntries(facts, language, { money: moneyLimitations }) : []), ...extraLimitations]
  const checked = array(facts?.checked)
  const answerSourceLabel = aiSkillText('answer.source', language)
  const generatedAt = facts?.generatedAt || new Date().toISOString()
  return {
    version: 'v2',
    responseId: `ai-skill-${randomUUID()}`,
    query: String(query ?? ''),
    intent: skill.id,
    language,
    answerSource: AI_SKILL_ANSWER_SOURCE,
    answerSourceLabel,
    skill: { id: skill.id, version: skill.version, asOf: facts?.asOf || null, timezone: facts?.timezone || null, signalVersion: AI_SKILL_SIGNAL_VERSION },
    checked,
    checkedLabel: checked.length ? aiSkillText('answer.checked', language, { sources: aiSkillList(checked.map((source) => aiSkillText(`source.${source}`, language)), language) }) : '',
    ...(facts ? { metrics: aiSkillReportMetrics(facts) } : {}),
    // The figures the answer states, keyed by code and record, as numbers:
    // [{ key: 'atp:LDM-001', code: 'atp', entityId: 'LDM-001', value: 63, unit: 'pcs' }].
    figures,
    scope: { module: scopeModule, timeRange: facts?.asOf || undefined, dataScopeLabel: aiSkillText('scope.label', language) },
    conclusion: { title, summary, severity: severity || (keyEvidence[0]?.severity ?? 'info'), confidence: 'high' },
    keyEvidence,
    contextCards: [],
    realEvidenceCount: keyEvidence.length,
    contextCardCount: 0,
    limitationCount: dataLimitations.length,
    businessImpact,
    recommendedActions: [],
    navigationLinks,
    dataLimitations,
    reviewCards,
    followUpQuestions: [],
    followUpSuggestions: followUps(followUpIds, language),
    contextBreadcrumbs: [],
    runtimeModeLabel: answerSourceLabel,
    safetyBoundaries: [aiSkillText('answer.review_boundary', language)],
    sourceSummary: checked.map((source) => ({ source, label: aiSkillText(`source.${source}`, language) })),
    readinessSignals: [],
    generatedAt,
    dataScopeLabel: aiSkillText('scope.label', language),
  }
}
