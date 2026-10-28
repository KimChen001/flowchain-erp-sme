import { aiSkillCountText, aiSkillList, aiSkillSentences, aiSkillText } from './ai-skill-copy.mjs'
import { aiSkillFormatter, aiSkillMetricSentences, presentAiSkillAnswer } from './ai-skill-presenter.mjs'
import { buildAiSkillSignals, rankAiSkillItemsByDate } from './ai-skill-signals.mjs'
import { toolsFor } from './ai-skill-registry.mjs'

// The capability answer: what the assistant can do, as follow-up prompts for
// the skills this actor may use. It answers any question no skill matches,
// and, with the refusal, any instruction to approve, pay, send, issue, cancel
// or delete: the assistant never acts, it offers a draft for review instead.
// It reads no business data.

export function runCapabilityOverview(_facts, { refusal = false, outOfDomain = false, actor = null, route = null } = {}) {
  const unsupported = refusal ? [] : (Array.isArray(route?.unsupportedIds) ? route.unsupportedIds : []).slice(0, 3)
  const outside = outOfDomain && !refusal
  // A question about contracts, which no skill reads yet.
  const contracts = !refusal && !outside && Boolean(route?.contracts)
  // A question no rule, record or model could answer: not a greeting, the
  // help chip, an instruction or a skill the actor may not use.
  const unmatched = !refusal && !outside && !contracts && !unsupported.length && Boolean(route) && !route.capability && !route.greeting && !route.skillId
  return { skillId: 'capability_overview', refusal, outOfDomain: outside, contracts, unmatched, unsupported, skills: toolsFor(actor).map((entry) => entry.id).filter((id) => id !== 'capability_overview') }
}

// The workspace topic a question names, most specific first, and the skills
// that answer it. A question no skill matched still says what it was about
// ("supplier test"), so the follow-ups start there.
const TOPICS = [
  ['rfqs', [/\brfqs?\b|\bquot(?:e|es|ations?)\b/i, /询价|报价/], ['rfq_followups']],
  ['receiving', [/\b(?:receipts?|receiving|grns?)\b/i, /收货|入库/], ['receiving_issues']],
  ['invoices', [/\binvoices?\b|\bpayments?\b|\bpayables?\b/i, /发票|付款|应付/], ['invoice_summary']],
  ['inventory', [/\b(?:stock|inventory|skus?)\b/i, /库存|物料|sku/i], ['inventory_availability']],
  ['purchase_orders', [/\b(?:purchase orders?|pos?)\b/i, /采购订单|采购|\bpo\b/i], ['purchase_orders', 'pending_approvals', 'workspace_metrics']],
  ['suppliers', [/\b(?:suppliers?|vendors?)\b/i, /供应商|供方/], ['supplier_attention', 'purchase_orders', 'invoice_summary', 'receiving_issues']],
]

export function aiSkillQuestionTopic(query) {
  const question = String(query ?? '')
  const topic = TOPICS.find(([, patterns]) => patterns.some((pattern) => pattern.test(question)))
  return topic ? { id: topic[0], skills: topic[2] } : null
}

export function presentCapabilityOverview(result, _facts, { skill, language, query }) {
  const topic = result.refusal || result.outOfDomain ? null : aiSkillQuestionTopic(query)
  const order = result.refusal ? ['prepare_action_draft', 'today_priorities', 'highest_risk_items', 'records_needing_data', 'workspace_metrics'] : [...(topic?.skills || []), 'today_priorities', 'highest_risk_items', 'records_needing_data', 'workspace_metrics', 'prepare_action_draft']
  const answer = presentAiSkillAnswer({
    skill, facts: null, language, query,
    title: aiSkillText(result.refusal ? 'capability.refusal.title' : result.contracts ? 'capability.contracts.title' : result.unmatched ? 'capability.unmatched.title' : 'capability.title', language),
    summary: result.refusal
      ? aiSkillSentences([aiSkillText('capability.refusal.summary', language), aiSkillText('capability.summary', language)], language)
      : aiSkillSentences([
        result.contracts ? aiSkillText('capability.contracts', language) : '',
        result.outOfDomain ? aiSkillText('capability.outside', language) : '',
        result.unsupported?.length ? aiSkillText(result.unsupported.length > 1 ? 'capability.unsupported_ids' : 'capability.unsupported_id', language, { id: aiSkillList(result.unsupported, language) }) : '',
        topic && !result.contracts && !result.unsupported?.length ? aiSkillText('capability.topic', language, { topic: aiSkillText(`topic.${topic.id}`, language) }) : '',
        aiSkillText('capability.summary', language),
      ], language),
    severity: result.refusal ? 'warning' : 'info',
    items: [],
    navigation: result.contracts ? [{ label: aiSkillText('capability.contracts.open', language), moduleId: 'contracts:list', returnTo: 'ai-assistant', source: 'ai' }] : [],
    followUpIds: [...new Set(order)].filter((id) => result.skills.includes(id)).slice(0, 4),
  })
  // It reads no business data, so it does not say "Answered from your workspace data".
  const label = aiSkillText('answer.source_none', language)
  return { ...answer, answerSourceLabel: label, runtimeModeLabel: label }
}

// Open and overdue purchase orders, committed spend and short SKUs, exactly as
// the reports count them, with the most overdue orders as evidence.
export function runWorkspaceMetrics(facts) {
  const overdue = rankAiSkillItemsByDate(buildAiSkillSignals(facts).filter((item) => item.type === 'po_overdue')).slice(0, 5)
  return { skillId: 'workspace_metrics', items: overdue }
}

export function presentWorkspaceMetrics(result, facts, { skill, language, query }) {
  const fmt = aiSkillFormatter(facts, language)
  const po = facts.purchaseOrders
  const title = po
    ? aiSkillCountText('metrics.title', po.open, language, { open: fmt.number(po.open), overdue: fmt.number(po.overdue), date: fmt.day(facts.asOf) })
    : aiSkillText('skill.workspace_metrics.title', language)
  const sentences = aiSkillMetricSentences(facts, language)
  return presentAiSkillAnswer({
    skill, facts, language, query, title,
    summary: aiSkillSentences(po ? sentences.slice(1) : sentences, language) || aiSkillText('metrics.amounts_hidden', language),
    severity: po?.overdue ? 'warning' : 'info',
    items: result.items,
    followUpIds: ['today_priorities', 'prepare_action_draft'],
  })
}
