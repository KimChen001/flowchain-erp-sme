import { randomUUID } from 'node:crypto'
import { aiSkillList, aiSkillText } from './ai-skill-copy.mjs'
import { aiModelFirstCitedRefs } from './ai-model-first-grounding.mjs'

// What assistant v2 sends around the model's own words: the earlier turns a
// conversation brings when the server has no thread for it, what the asking
// user's role cannot see, the progress line's sources, and the folded answer
// a client that reads no events gets (and the audit row reads). Nothing here
// writes or rewrites the model's text: the answer's summary is the text the
// panel showed, as the loop's checks left it.

const text = (value) => String(value ?? '').trim()
const array = (value) => (Array.isArray(value) ? value : [])
const clip = (value, max) => text(value).slice(0, max)

// Up to 3 earlier turns of the user's panel, as text, when the conversation
// started where the server keeps no thread (a restart, an expired thread).
const TURNS = 3
const TURN_QUESTION = 300
const TURN_ANSWER = 800
// Links to at most this many of the records an answer relied on.
const LINKS = 5

// The earlier turns of the user's panel, as text: the panel's previousTurns,
// or its previous question and headline. At most 3, the latest last.
export function assistantV2EarlierTurns(conversationContext) {
  const context = conversationContext && typeof conversationContext === 'object' ? conversationContext : {}
  const turns = array(context.previousTurns)
    .map((turn) => ({ question: clip(turn?.question, TURN_QUESTION), answer: clip(turn?.answer, TURN_ANSWER) }))
    .filter((turn) => turn.question)
  if (!turns.length && text(context.previousQuestion)) turns.push({ question: clip(context.previousQuestion, TURN_QUESTION), answer: clip(context.previousConclusionTitle, TURN_ANSWER) })
  return turns.slice(-TURNS)
}

// What the asking user's role cannot see (the facts' limitations): whole
// sources, and the amounts on sources it can see. null when nothing is hidden.
export function assistantV2Hidden(facts) {
  const limitations = array(facts?.limitations)
  const sources = [...new Set(limitations.filter((row) => row.code === 'hidden_by_permission').flatMap((row) => array(row.sources)))]
  const amountsOn = [...new Set(limitations.filter((row) => row.code === 'amounts_hidden').map((row) => text(row.what)).filter(Boolean))]
  return sources.length || amountsOn.length ? { sources, amountsOn } : null
}

// What each data tool reads, for the progress line and the answer's checked
// sources. A tool not listed reads "records".
const TOOL_SOURCES = Object.freeze({
  list_purchase_orders: 'purchase_orders', get_purchase_order: 'purchase_orders', late_order_impact: 'purchase_orders', spend_analysis: 'purchase_orders',
  stock_position: 'inventory', stock_projection: 'inventory', reorder_list: 'inventory', price_history: 'purchase_orders',
  list_sales_orders: 'sales_orders', list_receipts: 'receipts', supplier_performance: 'receipts',
  list_supplier_invoices: 'supplier_invoices', list_purchase_requests: 'purchase_requests', list_rfqs: 'rfqs', list_suppliers: 'suppliers', search_documents: 'documents',
  list_contracts: 'contracts', supplier_risks: 'supplier_risks',
})
const PROGRESS_SOURCES = Object.freeze({ search_records: 'records', calculate: 'calculation', list_receivables: 'receivables', workspace_summary: 'workspace' })
export const assistantV2ProgressSources = (names) => [...new Set(array(names).map((name) => PROGRESS_SOURCES[name] || TOOL_SOURCES[name] || 'records'))]

// The page each kind of record opens. A document has none (the knowledge
// library is a dialog), so it stays a named source without a link.
const LINK_MODULES = Object.freeze({
  purchase_order: 'procurement:orders',
  item: 'master-data:items',
  supplier: 'master-data:suppliers',
  supplier_invoice: 'procurement:invoices',
  purchase_request: 'procurement:requests',
  rfq: 'procurement:rfq',
  receiving_doc: 'procurement:receiving',
  sales_order: 'sales:orders',
  customer: 'master-data:customers',
  warehouse: 'master-data:warehouses',
  contract: 'contracts:list',
})

const firstSentence = (value) => text(value).split(/(?<=[.!?。！？])\s*/u)[0].slice(0, 80)

// The folded answer (the AiResponseV2 shape a client without events reads):
// the text as shown, its first sentence as the headline, and the records it
// relied on as evidence and links, built from the refs the tools returned.
// `summary` is the answer's text; `records` the refs the text cites; `calls`
// the loop's tool calls; `results` its data results.
export function presentAssistantV2Answer({ summary = '', records = [], refs = [], calls = [], facts = null, language, query = '', results = [] }) {
  const cited = aiModelFirstCitedRefs(records, refs)
  // A cited document names the sections this answer's searches returned from
  // it (the last part of each heading), so the reader sees where to look.
  const sections = new Map()
  for (const passage of array(results).flatMap((result) => array(result?.passages))) {
    const id = text(passage?.ref?.id)
    const section = text(passage?.section).split(' › ').at(-1)
    if (id && section) sections.set(id, [...new Set([...(sections.get(id) || []), section])])
  }
  const scopeLabel = aiSkillText('scope.label', language)
  const keyEvidence = cited.map((ref, index) => ({
    id: `v2-${index + 1}`, label: ref.label, entityLabel: ref.label, entityType: ref.type, entityId: ref.id,
    moduleId: LINK_MODULES[ref.type] || null, severity: 'info', sourceLabel: scopeLabel,
    ...(ref.type === 'document' && sections.get(ref.id)?.length ? { summary: sections.get(ref.id).join('; ') } : {}),
  }))
  const navigationLinks = cited.filter((ref) => LINK_MODULES[ref.type]).slice(0, LINKS).map((ref) => ({
    label: aiSkillText('nav.open', language, { id: ref.label }), moduleId: LINK_MODULES[ref.type], entityType: ref.type, entityId: ref.id, returnTo: 'ai-assistant', source: 'ai',
  }))
  const checked = [...new Set(array(calls).filter((call) => call.status === 'ok').map((call) => TOOL_SOURCES[call.tool]).filter(Boolean))]
  const label = aiSkillText('answer.source_assistant_v2', language)
  return {
    version: 'v2',
    responseId: `ai-assistant-v2-${randomUUID()}`,
    query: String(query ?? ''),
    intent: 'assistant_v2',
    language,
    answerSource: 'assistant_v2',
    answerSourceLabel: label,
    runtimeModeLabel: label,
    skill: { id: 'assistant_v2', asOf: facts?.asOf || null, timezone: facts?.timezone || null },
    checked,
    checkedLabel: checked.length ? aiSkillText('answer.checked', language, { sources: aiSkillList(checked.map((source) => aiSkillText(`source.${source}`, language)), language) }) : '',
    scope: { module: 'workspace', timeRange: facts?.asOf || undefined, dataScopeLabel: scopeLabel },
    conclusion: { title: firstSentence(summary), summary: text(summary), severity: 'info', confidence: 'medium' },
    keyEvidence,
    navigationLinks,
    generatedAt: facts?.generatedAt || new Date().toISOString(),
    dataScopeLabel: scopeLabel,
  }
}
