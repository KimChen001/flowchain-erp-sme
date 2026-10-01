import { aiSkillList, aiSkillSentences, aiSkillText } from './ai-skill-copy.mjs'
import { aiSkillFormatter, aiSkillMetricSentences, presentAiSkillAnswer } from './ai-skill-presenter.mjs'
import { buildAiSkillSignals, rankAiSkillItems } from './ai-skill-signals.mjs'
import { toolsFor } from './ai-skill-registry.mjs'

// The capability answer: what the assistant can do, as follow-up prompts for
// the skills this actor may use. It answers any question no skill matches,
// and, with the refusal, any instruction to approve, pay, send, issue, cancel
// or delete: the assistant never acts, it offers a draft for review instead.
// It reads no business data.

export function runCapabilityOverview(_facts, { refusal = false, outOfDomain = false, actor = null, route = null } = {}) {
  const unsupported = refusal ? [] : (Array.isArray(route?.unsupportedIds) ? route.unsupportedIds : []).slice(0, 3)
  return { skillId: 'capability_overview', refusal, outOfDomain: outOfDomain && !refusal, unsupported, skills: toolsFor(actor).map((entry) => entry.id).filter((id) => id !== 'capability_overview') }
}

export function presentCapabilityOverview(result, _facts, { skill, language, query }) {
  const order = result.refusal ? ['prepare_action_draft', 'today_priorities', 'highest_risk_items', 'records_needing_data', 'workspace_metrics'] : ['today_priorities', 'highest_risk_items', 'records_needing_data', 'workspace_metrics', 'prepare_action_draft']
  return presentAiSkillAnswer({
    skill, facts: null, language, query,
    title: aiSkillText(result.refusal ? 'capability.refusal.title' : 'capability.title', language),
    summary: result.refusal
      ? aiSkillSentences([aiSkillText('capability.refusal.summary', language), aiSkillText('capability.summary', language)], language)
      : aiSkillSentences([
        result.outOfDomain ? aiSkillText('capability.outside', language) : '',
        result.unsupported?.length ? aiSkillText(result.unsupported.length > 1 ? 'capability.unsupported_ids' : 'capability.unsupported_id', language, { id: aiSkillList(result.unsupported, language) }) : '',
        aiSkillText('capability.summary', language),
      ], language),
    severity: result.refusal ? 'warning' : 'info',
    items: [],
    navigation: [],
    followUpIds: order.filter((id) => result.skills.includes(id)).slice(0, 4),
  })
}

// Open and overdue purchase orders, committed spend and short SKUs, exactly as
// the reports count them, with the most overdue orders as evidence.
export function runWorkspaceMetrics(facts) {
  const overdue = rankAiSkillItems(buildAiSkillSignals(facts).filter((item) => item.type === 'po_overdue')).slice(0, 5)
  return { skillId: 'workspace_metrics', items: overdue }
}

export function presentWorkspaceMetrics(result, facts, { skill, language, query }) {
  const fmt = aiSkillFormatter(facts, language)
  const po = facts.purchaseOrders
  const title = po
    ? aiSkillText('metrics.title', language, { open: fmt.number(po.open), overdue: fmt.number(po.overdue), date: fmt.day(facts.asOf) })
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
