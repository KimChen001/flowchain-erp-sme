import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { recordDatabaseAuditBestEffort } from './audit-policy.mjs'
import { aiSkillQueryHash } from './ai-skill-audit.mjs'

// Feedback on one assistant answer (owner 2026-11-13: learn from the answers
// people mark wrong, the way Joule and Coupa collect it). A thumbs up or down,
// and for a down the reasons the panel offers and a short note.
//
// Two records, each for its own reader:
// - an audit row with codes only (rating, reasons, the answer's ids, the
//   question's hash), like every assistant audit row (ai-skill-audit.mjs: no
//   free text);
// - on a local research instance, when FLOWCHAIN_ASSISTANT_FEEDBACK_LOG names
//   a file, one JSON line with the question, the answer and the note, so a
//   marked answer can become a question-set case
//   (scripts/assistant-feedback-cases.mjs). Nothing is written there otherwise.
//
// The question, the answer, its cards and its tools come from the thread the
// server kept (ai-assistant-v2-threads.mjs), never from the client: the panel
// sends only the ids, the rating, the reasons and the note. An answer the
// server no longer holds (the thread expired, the process restarted) keeps
// its rating with no question or answer, so it never becomes a case. The same
// mark sent twice is recorded once (design audit 2026-11-15, L5-23).

export const ASSISTANT_FEEDBACK_REASONS = Object.freeze(['wrong_figure', 'missed_point', 'too_long', 'wrong_card', 'other'])

const ID = /^[A-Za-z0-9_.:-]{1,120}$/
const TOOL = /^[a-z_]{1,60}$/
const text = (value) => String(value ?? '').trim()
const clip = (value, max) => text(value).slice(0, max)

// The panel's body, read and bounded: { ok, value } or { ok: false, error }.
export function readAssistantFeedback(body) {
  const input = body && typeof body === 'object' && !Array.isArray(body) ? body : {}
  const rating = input.rating === 'up' || input.rating === 'down' ? input.rating : null
  if (!rating) return { ok: false, error: 'rating' }
  const threadId = text(input.threadId)
  const messageId = text(input.messageId)
  if (!ID.test(threadId) || !ID.test(messageId)) return { ok: false, error: 'ids' }
  const reasons = rating === 'down' ? [...new Set((Array.isArray(input.reasons) ? input.reasons : []).map(text).filter((reason) => ASSISTANT_FEEDBACK_REASONS.includes(reason)))] : []
  return {
    ok: true,
    value: {
      rating,
      threadId,
      messageId,
      reasons,
      note: rating === 'down' ? clip(input.note, 500) : '',
      language: input.language === 'zh-CN' ? 'zh-CN' : 'en-US',
    },
  }
}

// A card in a few words, for the research log: its component, its title, how
// many rows each list held and the labels of its chips or buttons.
export function assistantV2PartBrief(component, props = {}) {
  const value = props && typeof props === 'object' && !Array.isArray(props) ? props : {}
  const title = clip(value.title || value.heading, 120)
  const counts = Object.fromEntries(Object.entries(value).filter(([, entry]) => Array.isArray(entry)).slice(0, 8).map(([key, entry]) => [key, entry.length]))
  const labels = ['questions', 'chips', 'actions', 'buttons']
    .flatMap((key) => (Array.isArray(value[key]) ? value[key] : []))
    .map((entry) => clip(typeof entry === 'string' ? entry : entry?.label || entry?.text, 80))
    .filter(Boolean)
    .slice(0, 6)
  return { component: clip(component, 60) || 'unknown', ...(title ? { title } : {}), ...(Object.keys(counts).length ? { counts } : {}), ...(labels.length ? { labels } : {}) }
}

// The feedback with what the server kept of the answer (`stored`, from the
// thread store, or null).
export function withStoredAnswer(feedback, stored) {
  if (!stored) return { ...feedback, found: false, question: '', answer: '', parts: [], tools: [] }
  return {
    ...feedback,
    found: true,
    language: stored.language === 'zh-CN' ? 'zh-CN' : stored.language === 'en-US' ? 'en-US' : feedback.language,
    question: clip(stored.question, 1200),
    answer: clip(stored.answer, 4000),
    parts: (Array.isArray(stored.parts) ? stored.parts : []).slice(0, 20),
    tools: [...new Set((Array.isArray(stored.tools) ? stored.tools : []).map(text).filter((tool) => TOOL.test(tool)))].slice(0, 20),
  }
}

const markOf = (feedback) => JSON.stringify([feedback.rating, feedback.reasons, feedback.note])

export function assistantFeedbackAuditEntry(feedback) {
  return {
    source: 'ai_assisted',
    module: 'ai-assistant',
    action: 'ai_answer_feedback',
    entity: { type: 'ai_answer', id: feedback.messageId },
    summary: `Assistant answer marked ${feedback.rating === 'up' ? 'helpful' : 'not helpful'}.`,
    metadata: {
      threadId: feedback.threadId,
      messageId: feedback.messageId,
      rating: feedback.rating,
      reasons: feedback.reasons,
      noteLength: feedback.note.length,
      found: feedback.found === true,
      ...(feedback.previousRating ? { previousRating: feedback.previousRating } : {}),
      ...(feedback.question ? { queryHash: aiSkillQueryHash(feedback.question) } : {}),
      language: feedback.language,
      tools: feedback.tools || [],
      components: (feedback.parts || []).map((part) => part.component).filter((component) => TOOL.test(component || '')),
    },
  }
}

// One JSON line in the research log, when the instance names one.
export function logAssistantFeedback(feedback, { path, tenantId = null, userId = null, at = new Date() } = {}) {
  if (!text(path)) return false
  try {
    mkdirSync(dirname(path), { recursive: true })
    appendFileSync(path, `${JSON.stringify({ at: at.toISOString(), tenantId, userId, ...feedback })}\n`, 'utf8')
    return true
  } catch {
    return false
  }
}

// `stored`: the answer as the thread kept it, with its last mark (`mark`).
// The same mark again records nothing; a changed one says what it replaced.
export async function recordAssistantFeedback(ctx, input, { env = process.env, at = new Date(), stored = null } = {}) {
  const previous = stored?.feedback || null
  if (previous && previous.mark === markOf(input)) return { audited: false, logged: false, unchanged: true }
  const feedback = { ...withStoredAnswer(input, stored), ...(previous ? { previousRating: previous.rating } : {}) }
  if (stored) stored.feedback = { rating: input.rating, mark: markOf(input) }
  const audit = await recordDatabaseAuditBestEffort(ctx, assistantFeedbackAuditEntry(feedback))
  const logged = logAssistantFeedback(feedback, { path: env.FLOWCHAIN_ASSISTANT_FEEDBACK_LOG, tenantId: ctx?.identity?.tenantId || null, userId: ctx?.identity?.userId || null, at })
  return { audited: audit.ok === true, logged }
}
