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
      question: clip(input.question, 1200),
      answer: clip(input.answer, 4000),
      tools: [...new Set((Array.isArray(input.tools) ? input.tools : []).map(text).filter((tool) => TOOL.test(tool)))].slice(0, 20),
    },
  }
}

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
      queryHash: aiSkillQueryHash(feedback.question),
      language: feedback.language,
      tools: feedback.tools,
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

export async function recordAssistantFeedback(ctx, feedback, { env = process.env, at = new Date() } = {}) {
  const audit = await recordDatabaseAuditBestEffort(ctx, assistantFeedbackAuditEntry(feedback))
  const logged = logAssistantFeedback(feedback, { path: env.FLOWCHAIN_ASSISTANT_FEEDBACK_LOG, tenantId: ctx?.identity?.tenantId || null, userId: ctx?.identity?.userId || null, at })
  return { audited: audit.ok === true, logged }
}
