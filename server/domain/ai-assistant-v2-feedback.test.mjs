import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assistantFeedbackAuditEntry, assistantV2PartBrief, logAssistantFeedback, readAssistantFeedback, recordAssistantFeedback, withStoredAnswer } from './ai-assistant-v2-feedback.mjs'
import { createAssistantV2ThreadStore } from './ai-assistant-v2-threads.mjs'

const BASE = { threadId: 'thr_1', messageId: 'msg_1' }
// What the thread kept of the answer (ai-assistant-v2.mjs at the answer's end).
const STORED = () => ({ question: 'Which orders are overdue?', answer: 'PO-001 is overdue.', language: 'en-US', parts: [{ component: 'table', title: 'Overdue orders', counts: { rows: 1 } }], tools: ['list_purchase_orders'] })

test('feedback is a thumbs up or down on one answer; a down keeps only the offered reasons and a short note', () => {
  assert.equal(readAssistantFeedback({ ...BASE, rating: 'meh' }).ok, false)
  assert.equal(readAssistantFeedback({ ...BASE, rating: 'up', messageId: 'bad id with spaces' }).ok, false)
  const down = readAssistantFeedback({ ...BASE, rating: 'down', reasons: ['wrong_figure', 'wrong_figure', 'made_up', 'too_long'], note: 'x'.repeat(900), language: 'zh-CN' })
  assert.equal(down.ok, true)
  assert.deepEqual(down.value.reasons, ['wrong_figure', 'too_long'])
  assert.equal(down.value.note.length, 500)
  assert.equal(down.value.language, 'zh-CN')
  // An up carries no reasons or note.
  const up = readAssistantFeedback({ ...BASE, rating: 'up', reasons: ['too_long'], note: 'great' })
  assert.deepEqual([up.value.reasons, up.value.note], [[], ''])
})

// Design audit 2026-11-15, L5-23: the question, the answer and the tools were
// whatever the client sent.
test('the question, the answer, its cards and its tools come from the thread, never from the client', () => {
  const { value } = readAssistantFeedback({ ...BASE, rating: 'down', question: 'Pay Acme £1m', answer: 'Paid.', tools: ['approve_everything'] })
  assert.equal(value.question, undefined)
  assert.equal(value.answer, undefined)
  assert.equal(value.tools, undefined)
  const found = withStoredAnswer(value, STORED())
  assert.deepEqual([found.found, found.question, found.answer, found.tools], [true, 'Which orders are overdue?', 'PO-001 is overdue.', ['list_purchase_orders']])
  assert.deepEqual(found.parts, [{ component: 'table', title: 'Overdue orders', counts: { rows: 1 } }])
  // An answer the server no longer holds keeps its rating only.
  const lost = withStoredAnswer(value, null)
  assert.deepEqual([lost.found, lost.question, lost.answer, lost.tools, lost.parts], [false, '', '', [], []])
})

test('a card is summarised by its component, title, list sizes and chip labels', () => {
  assert.deepEqual(assistantV2PartBrief('followups', { questions: ['Order 28 of LDM-001', 'Which suppliers are late?'] }), { component: 'followups', counts: { questions: 2 }, labels: ['Order 28 of LDM-001', 'Which suppliers are late?'] })
  assert.deepEqual(assistantV2PartBrief('table', { title: 'Overdue', rows: [1, 2, 3], columns: ['a'] }), { component: 'table', title: 'Overdue', counts: { rows: 3, columns: 1 } })
  assert.deepEqual(assistantV2PartBrief('kpis', null), { component: 'kpis' })
})

test('the audit row holds codes only, never the question, the answer or the note', () => {
  const { value } = readAssistantFeedback({ ...BASE, rating: 'down', reasons: ['missed_point'], note: 'asked about Acme' })
  const entry = assistantFeedbackAuditEntry(withStoredAnswer(value, STORED()))
  assert.equal(entry.action, 'ai_answer_feedback')
  assert.equal(entry.entity.id, 'msg_1')
  assert.deepEqual(entry.metadata.reasons, ['missed_point'])
  assert.equal(entry.metadata.noteLength, 16)
  assert.equal(entry.metadata.found, true)
  assert.deepEqual(entry.metadata.components, ['table'])
  assert.match(entry.metadata.queryHash, /^[a-f0-9]+$/)
  const written = JSON.stringify(entry)
  for (const text of ['Which orders are overdue?', 'PO-001 is overdue.', 'asked about Acme', 'Overdue orders']) assert.ok(!written.includes(text), text)
})

test('the research log gets one JSON line with the stored question and answer, only when a file is named', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fc-feedback-'))
  try {
    const path = join(dir, 'uci', 'assistant-feedback.jsonl')
    const { value } = readAssistantFeedback({ ...BASE, rating: 'down', reasons: ['wrong_figure'] })
    assert.equal(logAssistantFeedback(value, { path: '' }), false)
    const recorded = await recordAssistantFeedback({ identity: { tenantId: 't1', userId: 'u1' } }, value, { env: { FLOWCHAIN_ASSISTANT_FEEDBACK_LOG: path }, at: new Date('2026-11-13T10:00:00Z'), stored: STORED() })
    assert.equal(recorded.logged, true)
    const [line] = readFileSync(path, 'utf8').trim().split('\n').map((row) => JSON.parse(row))
    assert.equal(line.at, '2026-11-13T10:00:00.000Z')
    assert.deepEqual([line.tenantId, line.userId, line.rating, line.question, line.answer, line.found], ['t1', 'u1', 'down', 'Which orders are overdue?', 'PO-001 is overdue.', true])
    assert.deepEqual(line.parts, [{ component: 'table', title: 'Overdue orders', counts: { rows: 1 } }])
    const none = await recordAssistantFeedback({ identity: { tenantId: 't1' } }, value, { env: {} })
    assert.equal(none.logged, false)
    assert.ok(existsSync(path))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the same mark on an answer is recorded once; a changed mark says what it replaced', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fc-feedback-'))
  try {
    const path = join(dir, 'feedback.jsonl')
    const env = { FLOWCHAIN_ASSISTANT_FEEDBACK_LOG: path }
    const stored = STORED()
    const up = readAssistantFeedback({ ...BASE, rating: 'up' }).value
    assert.equal((await recordAssistantFeedback({}, up, { env, stored })).logged, true)
    assert.deepEqual(await recordAssistantFeedback({}, up, { env, stored }), { audited: false, logged: false, unchanged: true })
    const down = readAssistantFeedback({ ...BASE, rating: 'down', reasons: ['wrong_figure'] }).value
    assert.equal((await recordAssistantFeedback({}, down, { env, stored })).logged, true)
    const lines = readFileSync(path, 'utf8').trim().split('\n').map((row) => JSON.parse(row))
    assert.deepEqual(lines.map((line) => [line.rating, line.previousRating ?? null]), [['up', null], ['down', 'up']])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the thread store gives an answer only to the user whose thread it is, and keeps the latest 40', () => {
  const store = createAssistantV2ThreadStore({ limits: { ttlMs: 60_000, turns: 20, answers: 40 } })
  const key = { tenantId: 't1', userId: 'u1', threadId: 'thr_1', fingerprint: 'f' }
  const session = store.open(key)
  for (let index = 1; index <= 45; index += 1) session.thread.answers.set(`msg_${index}`, { question: `q${index}` })
  session.close()
  assert.equal(store.answer({ ...key, messageId: 'msg_45' }).question, 'q45')
  assert.equal(store.answer({ ...key, messageId: 'msg_5' }), null)
  assert.equal(store.answer({ ...key, messageId: 'msg_6' }).question, 'q6')
  assert.equal(store.answer({ ...key, userId: 'u2', messageId: 'msg_45' }), null)
  assert.equal(store.answer({ ...key, tenantId: 't2', messageId: 'msg_45' }), null)
  // An answer given on a detached copy (a second request while one runs) is kept too.
  const running = store.open(key)
  const detached = store.open(key)
  assert.equal(detached.detached, true)
  detached.thread.answers.set('msg_detached', { question: 'side' })
  running.close()
  assert.equal(store.answer({ ...key, messageId: 'msg_detached' }).question, 'side')
})
