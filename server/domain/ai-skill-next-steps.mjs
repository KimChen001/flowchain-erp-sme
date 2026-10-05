import { aiSkillDraftCandidate, aiSkillDraftCard, aiSkillNextStepText } from './ai-skill-drafts.mjs'
import { buildAiSkillSignals, compareSignalsByDate } from './ai-skill-signals.mjs'

// Every answer line that names a record needing attention says what to do
// next, and offers the review-only draft that step calls for: at most one
// per line and three per answer, in the answer's own order
// (docs/ai-prefill-autocomplete-design.md §2; owner decision 2, 2026-10-03).
// Nothing here sends or saves anything; a line with nothing to do gets
// nothing.
const MAX_DRAFTS = 3
const array = (value) => Array.isArray(value) ? value : []
const cardKey = (card) => `${card.draftType}:${card.targetEntityId || ''}`

// The signal a line is about: the line's own signal when it is one; else the
// record's most urgent signal by date; for a supplier, the most urgent signal
// among its records (the order the supplier answer uses).
function signalFor(evidence, byId, byEntity, bySupplier) {
  return byId.get(evidence.id)
    || byEntity.get(`${evidence.entityType}:${evidence.entityId}`)
    || (evidence.entityType === 'supplier' ? bySupplier.get(evidence.entityId) : undefined)
    || null
}

export function attachAiSkillNextSteps(response, facts) {
  if (!facts || !response || !array(response.keyEvidence).length) return response
  const language = response.language
  const signals = [...buildAiSkillSignals(facts)].sort(compareSignalsByDate)
  const byId = new Map(signals.map((signal) => [signal.id, signal]))
  const byEntity = new Map()
  const bySupplier = new Map()
  for (const signal of signals) {
    const entity = `${signal.entityType}:${signal.entityId}`
    if (!byEntity.has(entity)) byEntity.set(entity, signal)
    if (signal.supplierId && !bySupplier.has(signal.supplierId)) bySupplier.set(signal.supplierId, signal)
  }
  const canDraft = Boolean(facts.visibility?.canDraft)
  const reviewCards = [...array(response.reviewCards)]
  const taken = new Set(reviewCards.map(cardKey))
  const keyEvidence = response.keyEvidence.map((evidence) => {
    const signal = signalFor(evidence, byId, byEntity, bySupplier)
    if (!signal) return evidence
    const candidate = aiSkillDraftCandidate(signal, facts)
    const nextStep = evidence.nextStep || aiSkillNextStepText(candidate, facts, language)
    if (canDraft && candidate.kind !== 'link' && reviewCards.length < MAX_DRAFTS) {
      const card = aiSkillDraftCard(candidate, facts, language)
      // The card names the line it belongs to, so the answer can show it there.
      if (!taken.has(cardKey(card))) {
        taken.add(cardKey(card))
        reviewCards.push({ ...card, lineEvidenceId: evidence.id })
      }
    }
    return nextStep ? { ...evidence, nextStep } : evidence
  })
  return { ...response, keyEvidence, reviewCards }
}

