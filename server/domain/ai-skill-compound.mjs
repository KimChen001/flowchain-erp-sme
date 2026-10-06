import { randomUUID } from 'node:crypto'
import { aiSkillLanguage, aiSkillList, aiSkillSentences, aiSkillText } from './ai-skill-copy.mjs'
import { refineAiSkillRoute } from './ai-skill-entities.mjs'
import { routeSkill } from './ai-skill-router.mjs'
import { AI_SKILL_SIGNAL_VERSION } from './ai-skill-signals.mjs'

// Compound answers (agent mode P1, docs/ai-agent-mode-design.md): a question
// that asks two or three things ("Which purchase orders are overdue, and what
// is available for LDM-001?") gets one answer with a section per part, each
// written by the skill the rules route that part to. No model is called: the
// parts, the skills, the records, the figures and the wording all come from
// the same rules and skills as a one-part question.
//
// A part counts only when a rule routes it or it names a record number. A
// part that does neither ("which are from Atlas", "and by how much") narrows
// the part before it and is read together with it. Parts that come to the
// same skill and mode are read together, so "PO-013 and PO-020" stays one
// answer about both orders. Fewer than two sections, an instruction in any
// part, a draft request, a chip or a follow-up hint, or a question about the
// outside world keeps the one-skill answer.

const text = (value) => String(value ?? '').trim()
const array = (value) => Array.isArray(value) ? value : []

export const AI_COMPOUND_MAX_SECTIONS = 3

// On unless FLOWCHAIN_AI_COMPOUND_ANSWERS=false. The owner approved it on
// 2026-10-03, on by default once the evaluation gate passed, which it did the
// same day (tests/ai-eval/README.md, "Compound answers").
export function aiCompoundAnswersEnabled(env = {}) {
  return text(env.FLOWCHAIN_AI_COMPOUND_ANSWERS).toLowerCase() !== 'false'
}

// Clause ends: sentence punctuation, a comma, a semicolon or a line break. A
// full stop ends a clause only before a space or the end, and not after a
// single letter, so 1.5, jane.doe@example.com and "e.g." never split.
const CLAUSE_END = /(?<!\b[a-z])\.(?=\s|$)|[!?;,，。！？；\n]/giu
// Connectors that join two questions. English ones need spaces on both sides,
// so "brand" or "Anderson" never split. 还有 joins only at the start of a
// clause ("还有，…"): inside one it asks what is left ("LDM-001 还有多少库存？").
const CONNECTOR = /\s+(?:and also|as well as|and|also|plus)\s+|(?:以及|同时|另外|顺便|并且|此外)/giu
// A connector or filler left at the start of a part.
const LEADING = /^(?:(?:and|also|plus|then|but|so|ok(?:ay)?)\b[\s,]*|(?:还有|以及|同时|另外|顺便|并且|此外|那么|那|再)[\s，,]*)+/iu
const MIN_PART_LENGTH = 3

// Splits at clause ends, then at connectors. Each part keeps its place in the
// question, so parts read together are the question's own words.
export function splitAiCompoundQuestion(message) {
  const raw = String(message ?? '')
  const pieces = []
  const cut = (start, end, pattern) => {
    let from = start
    for (const match of raw.slice(start, end).matchAll(new RegExp(pattern.source, pattern.flags))) {
      pieces.push([from, start + match.index])
      from = start + match.index + match[0].length
    }
    pieces.push([from, end])
  }
  const clauses = []
  let from = 0
  for (const match of raw.matchAll(CLAUSE_END)) {
    clauses.push([from, match.index])
    from = match.index + match[0].length
  }
  clauses.push([from, raw.length])
  for (const [start, end] of clauses) cut(start, end, CONNECTOR)
  return pieces.map(([start, end]) => {
    const slice = raw.slice(start, end)
    const lead = slice.match(/^\s*/)[0].length
    const body = slice.trimStart()
    const skip = body.match(LEADING)?.[0].length || 0
    const offset = start + lead + skip
    const value = raw.slice(offset, end).trimEnd()
    return { text: value, start: offset, end: offset + value.length }
  }).filter((part) => part.text.length >= MIN_PART_LENGTH)
}

const keyOf = (route) => `${route.skillId}:${route.mode || ''}`

// A part that asks a question of its own ("are any supplier bills off",
// 库存有没有不够的) rather than narrowing the part before it ("which are from
// Atlas", "and by how many days", 其中哪些…). Only agent planning reads it, to
// find a part the rules read with the one before but cannot answer.
const OWN_QUESTION = [
  /^(?:are|is|do|does|did|have|has|can|could|will|any|anything|how much)\b(?![^?]*\b(?:them|those|these|they|it|its|that)\b)/iu,
  /^(?!其中|哪些|这些|那些|它们)[^？?。]{0,12}(?:有没有|是否|有多少)/u,
]

// The parts the rules route and their sections. `dropped` counts the parts no
// section answers: a part no rule routes that narrows nothing (a first part,
// read alone, or a question of its own read with the part before), or one the
// actor's skills cannot answer.
function compoundSections({ raw, parts, facts, allowed, focusTarget }) {
  const routed = parts.map((part) => ({ ...part, route: routeSkill({ message: part.text, focusTarget }) }))
  // An instruction anywhere keeps the question on the one-skill path, whose
  // refusal rules read the whole question.
  if (routed.some((part) => part.route?.refusal)) return null
  // A part counts when a rule routes it or it names a record number; any
  // other part narrows the part before it.
  const groups = []
  let missed = 0
  for (const part of routed) {
    const counts = Boolean(part.route && !part.route.capability && (part.route.skillId || array(part.route.ids).length))
    if (counts || !groups.length) { groups.push({ start: part.start, end: part.end, route: counts ? part.route : null, parts: 1 }); continue }
    Object.assign(groups.at(-1), { end: part.end, parts: groups.at(-1).parts + 1 })
    // Read with the part before, but a question of its own that names no
    // record: no section answers it.
    if (OWN_QUESTION.some((pattern) => pattern.test(part.text)) && !refineAiSkillRoute(part.route || {}, part.text, facts)?.skillId) missed += 1
  }
  const refine = (group) => {
    const question = raw.slice(group.start, group.end)
    const partRoute = group.parts > 1 || !group.route ? routeSkill({ message: question, focusTarget }) : group.route
    if (!partRoute || partRoute.capability || partRoute.refusal) return null
    const refined = refineAiSkillRoute(partRoute, question, facts)
    if (!refined || refined.capability || !refined.skillId || refined.skillId === 'capability_overview' || !allowed?.has?.(refined.skillId)) return null
    return { question, start: group.start, end: group.end, route: refined }
  }
  const sections = []
  let dropped = missed
  for (const group of groups) {
    const section = refine(group)
    if (!section) { dropped += group.parts; continue }
    const same = sections.find((entry) => keyOf(entry.route) === keyOf(section.route))
    if (!same) { sections.push(section); continue }
    // Two parts for the same skill and mode are one question about both.
    const both = refine({ start: same.start, end: section.end, route: null, parts: 2 })
    if (both && keyOf(both.route) === keyOf(same.route)) sections.splice(sections.indexOf(same), 1, both)
  }
  return { sections, dropped }
}

// The sections of a compound answer, or null for a one-skill answer.
// `allowed` is the set of skill ids the actor may use.
export function planAiCompoundAnswer({ message, route, facts, allowed, focusTarget } = {}) {
  if (!route || route.capability || route.refusal || route.explicit || route.greeting || !facts) return null
  // A draft is about one record or one follow-up, however it is worded.
  if (route.skillId === 'prepare_action_draft') return null
  const raw = String(message ?? '')
  const parts = splitAiCompoundQuestion(raw)
  if (parts.length < 2) return null
  const planned = compoundSections({ raw, parts, facts, allowed, focusTarget })
  if (!planned || planned.sections.length < 2) return null
  const { sections } = planned
  return { sections: sections.slice(0, AI_COMPOUND_MAX_SECTIONS), skipped: Math.max(0, sections.length - AI_COMPOUND_MAX_SECTIONS) }
}

// What the compound rules could not answer part by part, for agent planning
// (P2): a draft request among several parts, which keeps the one-skill path
// here, or parts no section answers. A question whose parts the rules merged
// on purpose (the same skill twice, a part narrowing the one before) has no
// gap. `parts` is how many parts the question has.
export function aiCompoundGaps({ message, route, facts, allowed, focusTarget } = {}) {
  const raw = String(message ?? '')
  const parts = splitAiCompoundQuestion(raw)
  const none = { parts: parts.length, draft: false, dropped: 0 }
  if (!route || route.capability || route.refusal || route.explicit || route.greeting || !facts || parts.length < 2) return none
  const planned = compoundSections({ raw, parts, facts, allowed, focusTarget })
  if (!planned) return none
  if (route.skillId === 'prepare_action_draft') return { ...none, draft: planned.sections.some((section) => section.route.skillId !== 'prepare_action_draft') || planned.dropped > 0 }
  return { ...none, dropped: planned.dropped }
}

const SEVERITY_ORDER = ['success', 'info', 'warning', 'risk']
const unique = (rows, key) => {
  const seen = new Set()
  return rows.filter((row) => {
    const value = key(row)
    if (seen.has(value)) return false
    seen.add(value)
    return true
  })
}
// A section title read as a sentence in the summary.
const asSentence = (value, language) => {
  const title = text(value)
  if (!title || /[.!?。！？]$/u.test(title)) return title
  return `${title}${aiSkillLanguage(language) === 'zh-CN' ? '。' : '.'}`
}

// One AiResponseV2 from the sections' own validated answers. Evidence,
// figures, links, limitations and review cards are the sections' own,
// without repeats; the conclusion lists the section titles. Each section
// keeps its title, summary and the evidence it cited.
export function composeAiCompoundAnswer({ sections, facts, language: requested, query, skipped = 0 }) {
  const language = aiSkillLanguage(requested)
  const answers = sections.map((section) => section.response)
  const first = answers[0]
  const checked = unique(answers.flatMap((answer) => array(answer.checked)), (source) => source)
  const keyEvidence = unique(answers.flatMap((answer) => array(answer.keyEvidence)), (item) => item.id || `${item.evidenceType}:${item.entityId}`)
    .map((item, index) => ({ ...item, rank: index + 1 }))
  const figures = unique(answers.flatMap((answer) => array(answer.figures)), (row) => `${row.key}|${row.entityId || ''}`)
  const extra = skipped ? [{ code: 'compound_parts_limited', label: aiSkillText('limitation.compound_parts_limited.label', language), description: aiSkillText('limitation.compound_parts_limited.description', language, { count: AI_COMPOUND_MAX_SECTIONS }), severity: 'warning', missingData: [] }] : []
  const dataLimitations = unique([...answers.flatMap((answer) => array(answer.dataLimitations)), ...extra], (row) => `${row.code || ''}|${row.label}`)
  const severity = answers.map((answer) => answer.conclusion?.severity || 'info').reduce((worst, value) => SEVERITY_ORDER.indexOf(value) > SEVERITY_ORDER.indexOf(worst) ? value : worst, 'success')
  return {
    version: 'v2',
    responseId: `ai-skill-${randomUUID()}`,
    query: String(query ?? ''),
    intent: 'compound',
    language,
    answerSource: first.answerSource,
    answerSourceLabel: first.answerSourceLabel,
    skill: { id: 'compound', version: '1', asOf: facts?.asOf || null, timezone: facts?.timezone || null, signalVersion: AI_SKILL_SIGNAL_VERSION },
    checked,
    checkedLabel: checked.length ? aiSkillText('answer.checked', language, { sources: aiSkillList(checked.map((source) => aiSkillText(`source.${source}`, language)), language) }) : '',
    ...(first.metrics ? { metrics: first.metrics } : {}),
    figures,
    scope: first.scope,
    conclusion: {
      title: aiSkillText('compound.title', language),
      summary: aiSkillSentences(answers.map((answer) => asSentence(answer.conclusion?.title, language)), language),
      severity,
      confidence: 'high',
    },
    sections: sections.map((section, index) => ({
      id: `section-${index + 1}`,
      skillId: section.response.intent,
      mode: section.route?.mode || null,
      question: section.question,
      title: section.response.conclusion?.title || '',
      summary: section.response.conclusion?.summary || '',
      severity: section.response.conclusion?.severity || 'info',
      evidenceIds: array(section.response.keyEvidence).map((item) => item.id).filter(Boolean),
      figureKeys: array(section.response.figures).map((row) => row.key),
    })),
    keyEvidence,
    contextCards: [],
    realEvidenceCount: keyEvidence.length,
    contextCardCount: 0,
    limitationCount: dataLimitations.length,
    businessImpact: unique(answers.flatMap((answer) => array(answer.businessImpact)), (row) => `${row.area}|${row.impact}|${array(row.affectedObjects).join(',')}`),
    recommendedActions: [],
    navigationLinks: unique(answers.flatMap((answer) => array(answer.navigationLinks)), (link) => `${link.moduleId}|${link.entityId || ''}|${link.label}`).slice(0, 6),
    dataLimitations,
    reviewCards: unique(answers.flatMap((answer) => array(answer.reviewCards)), (card) => `${card.draftType}|${card.targetEntityId || ''}|${card.title}`),
    followUpQuestions: [],
    followUpSuggestions: unique(answers.flatMap((answer) => array(answer.followUpSuggestions)), (item) => item.prompt).slice(0, 3),
    contextBreadcrumbs: [],
    runtimeModeLabel: first.runtimeModeLabel,
    safetyBoundaries: first.safetyBoundaries,
    sourceSummary: checked.map((source) => ({ source, label: aiSkillText(`source.${source}`, language) })),
    readinessSignals: [],
    generatedAt: first.generatedAt,
    dataScopeLabel: first.dataScopeLabel,
  }
}

// The audit metadata of a compound answer: which skills answered, in which
// modes, never the parts' text.
export function aiCompoundAudit(plan) {
  return {
    phase: 'compound',
    status: 'served',
    sections: plan.sections.map((section) => ({ skillId: section.route.skillId, mode: section.route.mode || null })),
    skippedParts: plan.skipped,
  }
}
