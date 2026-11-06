import { aiSkillCountText, aiSkillList, aiSkillText } from './ai-skill-copy.mjs'
import { aiSkillFormatter, aiSkillNavigation, presentAiSkillAnswer } from './ai-skill-presenter.mjs'
import { buildAiSkillSignals, rankAiSkillItemsByDate } from './ai-skill-signals.mjs'
import { aiSkillFocusName, matchesAiSkillFocus } from './ai-skill-today-priorities.mjs'
import { AI_SKILL_DRAFT_TYPES, aiSkillCombineFollowups, aiSkillDraftCandidate, aiSkillDraftCard } from './ai-skill-drafts.mjs'
import { presentStartOrder, runStartOrder } from './ai-skill-start-order.mjs'

// Review-only drafts for the signals in date order (compareSignalsByDate):
// the first candidate of each draft type, then the rest in that order, at
// most three. The candidates and cards are shared with the draft each answer line offers (ai-skill-drafts.mjs). A
// request to start an order (route mode order) is answered by
// ai-skill-start-order.mjs.
// A supplier tier the question names ("follow-ups for our Tier 1 suppliers")
// keeps the drafts and links to that tier's suppliers, in the same order: a
// follow-up on one of their orders or invoices. A shortage that none of their
// orders covers belongs to no supplier and is left out. A supplier the
// question names ("a message to Acme") narrows the drafts and links to it the
// same way (plan gap 12). Several follow-ups to one supplier become one
// message, and a question about partial delivery asks whether what is ready
// can ship first.
export { AI_SKILL_DRAFT_TYPES }
const MAX_CARDS = 3
const array = (value) => Array.isArray(value) ? value : []

const candidateSupplier = (candidate) => candidate.po?.supplierId || candidate.item.supplierId || null

export function runPrepareActionDraft(facts, { focus = null, route = null } = {}) {
  if (route?.mode === 'order') return runStartOrder(facts, { focus, route, canDraft: Boolean(facts.visibility?.canDraft) })
  // The record the drafts are for (focus), or several named ones
  // (route.focusAny): the drafts for any of them. An order or item keeps the
  // signals tied to it; a supplier keeps the drafts whose order or invoice is
  // that supplier's, as a tier does, so a shortage its order covers stays.
  const any = Array.isArray(route?.focusAny) && route.focusAny.length ? route.focusAny : null
  const records = any || (focus ? [focus] : [])
  const supplierIds = new Set(records.filter((one) => one.entityType === 'supplier').map((one) => one.entityId))
  const others = records.filter((one) => one.entityType !== 'supplier')
  const wanted = (candidate) => !records.length || others.some((one) => matchesAiSkillFocus(candidate.item, one)) || supplierIds.has(candidateSupplier(candidate))
  const ranked = rankAiSkillItemsByDate(buildAiSkillSignals(facts))
  const tier = route?.tier || null
  const tierIds = tier?.supplierIds ? new Set(tier.supplierIds) : null
  // The focus filter (wanted) and a supplier the route names are the same
  // predicate on the candidate's supplier, so applying both never filters twice.
  const named = array(route?.entities?.suppliers)
  const namedSupplierIds = named.length ? new Set(named.map((row) => row.id)) : null
  const all = aiSkillCombineFollowups(ranked.map((item) => aiSkillDraftCandidate(item, facts))
    .filter((candidate) => wanted(candidate) && (!tierIds || tierIds.has(candidateSupplier(candidate))) && (!namedSupplierIds || namedSupplierIds.has(candidateSupplier(candidate)))))
  const askPartial = Boolean(route?.signals?.partial)
  const seen = new Set()
  const drafts = []
  const take = (candidate) => { if (drafts.length < MAX_CARDS && !seen.has(candidate.key)) { seen.add(candidate.key); drafts.push(candidate) } }
  // The first candidate of each draft type, then the rest, all by date.
  for (const kind of AI_SKILL_DRAFT_TYPES) { const first = all.find((candidate) => candidate.kind === kind); if (first) take(first) }
  for (const candidate of all.filter((entry) => entry.kind !== 'link')) take(candidate)
  drafts.sort((a, b) => a.item.rank - b.item.rank)
  const canDraft = Boolean(facts.visibility?.canDraft)
  return {
    skillId: 'prepare_action_draft', focus, focusAny: any, canDraft, tier,
    supplier: named.length === 1 ? { id: named[0].id, name: named[0].name || named[0].id } : null,
    // Asked to draft for one order that is not yet issued: say so, not "no draft needed".
    focusNotSent: Boolean(focus) && !drafts.length && all.some((candidate) => candidate.kind === 'link' && candidate.notSent),
    drafts: canDraft ? drafts.map((candidate) => askPartial && candidate.kind === 'po_followup_draft' ? { ...candidate, askPartial } : candidate) : [],
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
  if (result.mode === 'order') return presentStartOrder(result, facts, { skill, language, query })
  const fmt = aiSkillFormatter(facts, language)
  const reviewCards = result.drafts.map((candidate) => aiSkillDraftCard(candidate, facts, language))
  const extraLimitations = result.canDraft ? [] : [{ code: 'draft_permission', label: aiSkillText('limitation.draft_permission.label', language), description: aiSkillText('draft.no_permission', language), severity: 'warning', missingData: [] }]
  return presentAiSkillAnswer({
    skill, facts, language, query,
    title: !result.canDraft ? aiSkillText('draft.title_blocked', language)
      : result.focusNotSent ? aiSkillText('draft.focus_not_sent', language, { id: aiSkillFocusName(result.focus, facts) })
        : result.focus ? focusTitle(aiSkillFocusName(result.focus, facts), reviewCards.length, fmt, language)
          : result.focusAny ? focusTitle(aiSkillList(result.focusAny.map((one) => aiSkillFocusName(one, facts)), language), reviewCards.length, fmt, language)
          : result.tier?.supplierIds ? aiSkillCountText('draft.tier_title', reviewCards.length, language, { count: fmt.number(reviewCards.length), group: aiSkillText(`tier.group_${result.tier.tier}`, language) })
            : result.supplier ? aiSkillCountText('draft.supplier_title', reviewCards.length, language, { count: fmt.number(reviewCards.length), supplier: result.supplier.name })
            : aiSkillCountText('draft.title', reviewCards.length, language, { count: fmt.number(reviewCards.length) }),
    summary: [aiSkillText(!result.canDraft ? 'draft.no_permission' : reviewCards.length ? 'draft.summary' : result.focusNotSent ? 'draft.not_sent_summary' : 'draft.none_summary', language), result.tier && !result.tier.supplierIds ? aiSkillText('tier.unavailable', language) : ''].filter(Boolean).join(language === 'zh-CN' ? '' : ' '),
    severity: result.items[0]?.severity || 'info',
    items: result.items,
    navigation: [...result.drafts.map((candidate) => candidate.item), ...result.links].slice(0, 4).map((item) => aiSkillNavigation(item, language)),
    reviewCards,
    extraLimitations,
    followUpIds: ['today_priorities', 'highest_risk_items'],
  })
}
