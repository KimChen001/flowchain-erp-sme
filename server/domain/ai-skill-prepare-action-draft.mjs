import { aiSkillCountText, aiSkillText } from './ai-skill-copy.mjs'
import { aiSkillFormatter, aiSkillNavigation, presentAiSkillAnswer } from './ai-skill-presenter.mjs'
import { buildAiSkillSignals, rankAiSkillItems } from './ai-skill-signals.mjs'
import { matchesAiSkillFocus } from './ai-skill-today-priorities.mjs'
import { AI_SKILL_DRAFT_TYPES, aiSkillDraftCandidate, aiSkillDraftCard } from './ai-skill-drafts.mjs'

// Review-only drafts for the top signals: the best candidate of each draft
// type, then the rest by rank, at most three. The candidates and cards are
// shared with the draft each answer line offers (ai-skill-drafts.mjs).
export { AI_SKILL_DRAFT_TYPES }
const MAX_CARDS = 3

export function runPrepareActionDraft(facts, { focus = null } = {}) {
  const ranked = rankAiSkillItems(buildAiSkillSignals(facts)).filter((item) => matchesAiSkillFocus(item, focus))
  const all = ranked.map((item) => aiSkillDraftCandidate(item, facts))
  const seen = new Set()
  const drafts = []
  const take = (candidate) => { if (drafts.length < MAX_CARDS && !seen.has(candidate.key)) { seen.add(candidate.key); drafts.push(candidate) } }
  // The best candidate of each draft type first, then the rest by rank.
  for (const kind of AI_SKILL_DRAFT_TYPES) { const first = all.find((candidate) => candidate.kind === kind); if (first) take(first) }
  for (const candidate of all.filter((entry) => entry.kind !== 'link')) take(candidate)
  drafts.sort((a, b) => a.item.rank - b.item.rank)
  const canDraft = Boolean(facts.visibility?.canDraft)
  return {
    skillId: 'prepare_action_draft', focus, canDraft,
    drafts: canDraft ? drafts : [],
    links: all.filter((candidate) => candidate.kind === 'link').slice(0, 3).map((candidate) => candidate.item),
    items: [...(canDraft ? drafts : all.filter((candidate) => candidate.kind !== 'link').slice(0, MAX_CARDS)).map((candidate) => candidate.item), ...all.filter((candidate) => candidate.kind === 'link').slice(0, 2).map((candidate) => candidate.item)]
      .filter((item, index, rows) => rows.findIndex((row) => row.id === item.id) === index),
  }
}

// Narrowed to one record, the title names it.
function focusTitle(id, count, fmt, language) {
  if (!count) return aiSkillText('draft.focus_none', language, { id })
  return aiSkillText(count === 1 ? 'draft.focus_title' : 'draft.focus_title_many', language, { id, count: fmt.number(count) })
}

export function presentPrepareActionDraft(result, facts, { skill, language, query }) {
  const fmt = aiSkillFormatter(facts, language)
  const reviewCards = result.drafts.map((candidate) => aiSkillDraftCard(candidate, facts, language))
  const extraLimitations = result.canDraft ? [] : [{ code: 'draft_permission', label: aiSkillText('limitation.draft_permission.label', language), description: aiSkillText('draft.no_permission', language), severity: 'warning', missingData: [] }]
  return presentAiSkillAnswer({
    skill, facts, language, query,
    title: !result.canDraft ? aiSkillText('draft.title_blocked', language) : result.focus ? focusTitle(result.focus.entityId, reviewCards.length, fmt, language) : aiSkillCountText('draft.title', reviewCards.length, language, { count: fmt.number(reviewCards.length) }),
    summary: aiSkillText(!result.canDraft ? 'draft.no_permission' : reviewCards.length ? 'draft.summary' : 'draft.none_summary', language),
    severity: result.items[0]?.severity || 'info',
    items: result.items,
    navigation: [...result.drafts.map((candidate) => candidate.item), ...result.links].slice(0, 4).map((item) => aiSkillNavigation(item, language)),
    reviewCards,
    extraLimitations,
    followUpIds: ['today_priorities', 'highest_risk_items'],
  })
}
