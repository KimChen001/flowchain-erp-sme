import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assistantFeedbackAuditEntry, logAssistantFeedback, readAssistantFeedback, recordAssistantFeedback } from './ai-assistant-v2-feedback.mjs'

const BASE = { threadId: 'thr_1', messageId: 'msg_1', question: 'Which orders are overdue?', answer: 'PO-001 is overdue.', tools: ['list_purchase_orders'] }

test('feedback is a thumbs up or down on one answer; a down keeps only the offered reasons and a short note', () => {
  assert.equal(readAssistantFeedback({ ...BASE, rating: 'meh' }).ok, false)
  assert.equal(readAssistantFeedback({ ...BASE, rating: 'up', messageId: 'bad id with spaces' }).ok, false)
  const down = readAssistantFeedback({ ...BASE, rating: 'down', reasons: ['wrong_figure', 'wrong_figure', 'made_up', 'too_long'], note: 'x'.repeat(900), language: 'zh-CN', tools: ['list_purchase_orders', 'DROP TABLE'] })
  assert.equal(down.ok, true)
  assert.deepEqual(down.value.reasons, ['wrong_figure', 'too_long'])
  assert.equal(down.value.note.length, 500)
  assert.equal(down.value.language, 'zh-CN')
  assert.deepEqual(down.value.tools, ['list_purchase_orders'])
  // An up carries no reasons or note.
  const up = readAssistantFeedback({ ...BASE, rating: 'up', reasons: ['too_long'], note: 'great' })
  assert.deepEqual([up.value.reasons, up.value.note], [[], ''])
})

test('the audit row holds codes only, never the question, the answer or the note', () => {
  const { value } = readAssistantFeedback({ ...BASE, rating: 'down', reasons: ['missed_point'], note: 'asked about Acme' })
  const entry = assistantFeedbackAuditEntry(value)
  assert.equal(entry.action, 'ai_answer_feedback')
  assert.equal(entry.entity.id, 'msg_1')
  assert.deepEqual(entry.metadata.reasons, ['missed_point'])
  assert.equal(entry.metadata.noteLength, 16)
  const written = JSON.stringify(entry)
  for (const text of ['Which orders are overdue?', 'PO-001 is overdue.', 'asked about Acme']) assert.ok(!written.includes(text), text)
})

test('the research log gets one JSON line with the question and answer, only when a file is named', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fc-feedback-'))
  try {
    const path = join(dir, 'uci', 'assistant-feedback.jsonl')
    const { value } = readAssistantFeedback({ ...BASE, rating: 'down', reasons: ['wrong_figure'] })
    assert.equal(logAssistantFeedback(value, { path: '' }), false)
    const recorded = await recordAssistantFeedback({ identity: { tenantId: 't1', userId: 'u1' } }, value, { env: { FLOWCHAIN_ASSISTANT_FEEDBACK_LOG: path }, at: new Date('2026-11-13T10:00:00Z') })
    assert.equal(recorded.logged, true)
    const [line] = readFileSync(path, 'utf8').trim().split('\n').map((row) => JSON.parse(row))
    assert.equal(line.at, '2026-11-13T10:00:00.000Z')
    assert.deepEqual([line.tenantId, line.userId, line.rating, line.question, line.answer], ['t1', 'u1', 'down', 'Which orders are overdue?', 'PO-001 is overdue.'])
    const none = await recordAssistantFeedback({ identity: { tenantId: 't1' } }, value, { env: {} })
    assert.equal(none.logged, false)
    assert.ok(existsSync(path))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
