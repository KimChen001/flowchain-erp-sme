// The answers people marked down in the assistant, as drafts for the question
// set (owner 2026-11-13: learn from real misses, not only from cases we write).
//
//   node scripts/assistant-feedback-cases.mjs [log.jsonl ...] [--all] [--out=drafts.json]
//
// Reads the research log a local walkthrough writes
// (FLOWCHAIN_ASSISTANT_FEEDBACK_LOG, by default
// <walkthrough dir>/<dataset>/assistant-feedback.jsonl). Prints one block per
// marked answer: when, the question, the reasons, the note, the tools it
// called and the start of the answer; with --out, also writes draft cases
// ({ id, question, language, reasons, note, tools, answer }) to check by hand
// and move into tests/ai-eval/v2-public. --all includes thumbs up.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const REASONS = {
  wrong_figure: 'a figure is wrong',
  missed_point: 'missed the point',
  too_long: 'too long',
  wrong_card: 'wrong card or button',
  other: 'other',
}

const args = process.argv.slice(2)
const all = args.includes('--all')
const out = args.find((arg) => arg.startsWith('--out='))?.slice(6) || null
let files = args.filter((arg) => !arg.startsWith('--'))
if (!files.length) {
  const root = process.env.FLOWCHAIN_WALKTHROUGH_DIR
  files = root ? ['uci', 'm5'].map((dataset) => join(root, dataset, 'assistant-feedback.jsonl')).filter((path) => existsSync(path)) : []
  if (process.env.FLOWCHAIN_ASSISTANT_FEEDBACK_LOG) files.push(process.env.FLOWCHAIN_ASSISTANT_FEEDBACK_LOG)
}
if (!files.length) {
  console.error('No feedback log: pass a file, or set FLOWCHAIN_WALKTHROUGH_DIR or FLOWCHAIN_ASSISTANT_FEEDBACK_LOG.')
  process.exit(1)
}

const rows = files.flatMap((path) => readFileSync(path, 'utf8').split('\n').filter(Boolean).flatMap((line) => {
  try { return [JSON.parse(line)] } catch { return [] }
}))
// The latest mark on each answer counts: a person may change their mind.
const latest = new Map()
for (const row of rows) latest.set(`${row.threadId}:${row.messageId}`, row)
const marked = [...latest.values()].filter((row) => all || row.rating === 'down').sort((a, b) => String(a.at).localeCompare(String(b.at)))

const drafts = marked.map((row, index) => ({
  id: `feedback-${String(row.at || '').slice(0, 10)}-${index + 1}`,
  question: row.question,
  language: row.language,
  rating: row.rating,
  reasons: row.reasons || [],
  note: row.note || '',
  tools: row.tools || [],
  answer: row.answer,
}))
for (const draft of drafts) {
  console.log(`\n## ${draft.id} (${draft.rating}, ${draft.language})`)
  console.log(`Q: ${draft.question}`)
  if (draft.reasons.length) console.log(`Why: ${draft.reasons.map((reason) => REASONS[reason] || reason).join('; ')}`)
  if (draft.note) console.log(`Note: ${draft.note}`)
  if (draft.tools.length) console.log(`Tools: ${draft.tools.join(', ')}`)
  console.log(`A: ${String(draft.answer || '').replace(/\s+/g, ' ').slice(0, 300)}${String(draft.answer || '').length > 300 ? '…' : ''}`)
}
console.log(`\n${drafts.length} ${all ? 'marked' : 'marked down'} of ${latest.size} answers with feedback, from ${files.length} file(s).`)
if (out) {
  writeFileSync(out, `${JSON.stringify(drafts, null, 2)}\n`, 'utf8')
  console.log(`Drafts written to ${out}.`)
}
