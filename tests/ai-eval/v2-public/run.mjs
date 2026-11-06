// Runs the assistant v2 evaluation on public demand data against a running
// local server, the way the panel asks: NDJSON, one thread per case. See
// README.md for starting the server. Calls the configured model, so it costs
// what the answers cost (about $0.03-0.10 an answer on Sonnet).
//
//   node tests/ai-eval/v2-public/run.mjs --port=18941 \
//     --data=<research>/data/public [--reference=<research>/outputs/public-instance-m5.json] \
//     [--only=eoq,avg-demand-en] [--out=<folder>]
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { readPublicDataInstances } from '../../../scripts/public-data-instance.mjs'
import { buildCases, readReference } from './cases.mjs'
import { scoreAnswer } from './score.mjs'

const args = Object.fromEntries(process.argv.slice(2).map((arg) => arg.replace(/^--/, '').split('=')).map(([key, ...value]) => [key, value.join('=') || true]))
if (!args.port || !args.data) {
  console.error('Usage: node tests/ai-eval/v2-public/run.mjs --port=<api port> --data=<research data/public folder> [--reference=<public-instance-m5.json>] [--only=<ids>] [--out=<folder>]')
  process.exit(2)
}
const base = `http://127.0.0.1:${args.port}`
const instances = Object.fromEntries(readPublicDataInstances(args.data, 'm5_main,m5_intermittent').map((instance) => [instance.set, instance]))
const referencePath = args.reference || resolve(args.data, '../../outputs/public-instance-m5.json')
const reference = existsSync(referencePath) ? readReference(JSON.parse(readFileSync(referencePath, 'utf8'))) : null
if (!reference) console.log(`No reference at ${referencePath}: the decision cases are left out.`)
const only = args.only ? new Set(String(args.only).split(',')) : null
const cases = buildCases(instances, reference).filter((row) => !only || only.has(row.id))
const out = resolve(args.out || join(process.cwd(), 'ai-eval-v2-public'))
mkdirSync(out, { recursive: true })

const login = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'admin@flowchain.local', name: 'Evaluation', company: 'FlowChain' }) })
if (!login.ok) throw new Error(`Sign-in failed with ${login.status}`)
const auth = { authorization: `Bearer ${(await login.json()).token}` }
const readiness = await (await fetch(`${base}/api/ai-runtime/readiness`, { headers: auth })).json()
if (!readiness.assistantV2) throw new Error(`Assistant v2 is not on for this server (notice: ${readiness.notice || 'none'}).`)

async function ask(threadId, message, language) {
  const started = Date.now()
  const response = await fetch(`${base}/api/ai-runtime/respond`, {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json', accept: 'application/x-ndjson, application/json' },
    body: JSON.stringify({ threadId, message, activeContext: { moduleId: 'overview', entityType: null, entityId: null }, answerLanguage: language }),
  })
  const parts = new Map()
  const answer = { status: response.status, ms: 0, text: '', ui: [], flags: [], errors: [], notices: [], tools: [] }
  for (const line of (await response.text()).split('\n').filter(Boolean)) {
    let event
    try { event = JSON.parse(line) } catch { continue }
    if (event.type === 'text_delta') parts.set(event.partId, { type: 'text', text: (parts.get(event.partId)?.text || '') + event.text })
    else if (event.type === 'replace') parts.set(event.partId, { type: 'text', text: event.text })
    else if (event.type === 'ui') parts.set(event.partId, { type: 'ui', component: event.component, props: event.props })
    else if (event.type === 'flag') for (const span of event.spans || []) answer.flags.push(`${span.kind}:${span.text}`)
    else if (event.type === 'error') answer.errors.push(event.code)
    else if (event.type === 'notice') answer.notices.push(event.code)
    else if (event.type === 'tool' && event.state !== 'running') answer.tools.push(event.name)
  }
  answer.ms = Date.now() - started
  answer.text = [...parts.values()].filter((part) => part.type === 'text').map((part) => part.text).join('\n').trim()
  answer.ui = [...parts.values()].filter((part) => part.type === 'ui').map(({ component, props }) => ({ component, props }))
  const audit = await (await fetch(`${base}/api/audit-log?entityType=ai_skill&limit=1`, { headers: auth })).json().catch(() => null)
  answer.costUsd = Number(audit?.[0]?.metadata?.assistantV2?.costMicros || 0) / 1e6
  return answer
}

const results = []
for (const testCase of cases) {
  const threadId = `thr_eval_${testCase.id.replace(/[^\w]/g, '')}_${Date.now().toString(36)}`
  const answers = []
  for (const message of testCase.turns) answers.push(await ask(threadId, message, testCase.language))
  const last = answers.at(-1)
  const score = scoreAnswer(last, testCase.expect, { language: testCase.language })
  results.push({ id: testCase.id, kind: testCase.kind, pass: score.pass, checks: score.checks, seconds: Math.round(answers.reduce((total, row) => total + row.ms, 0) / 1000), costUsd: answers.reduce((total, row) => total + row.costUsd, 0), tools: last.tools, answer: last })
  console.log(`${score.pass ? 'PASS' : 'FAIL'} ${testCase.id.padEnd(26)} ${String(results.at(-1).seconds).padStart(3)}s ${score.checks.filter((check) => !check.ok).map((check) => `${check.name} (${check.detail})`).join('; ')}`)
}

const passed = results.filter((row) => row.pass).length
const byKind = Object.entries(results.reduce((totals, row) => { totals[row.kind] ||= [0, 0]; totals[row.kind][0] += row.pass ? 1 : 0; totals[row.kind][1] += 1; return totals }, {}))
const summary = { passed, cases: results.length, byKind: Object.fromEntries(byKind.map(([kind, [ok, all]]) => [kind, `${ok}/${all}`])), costUsd: Math.round(results.reduce((total, row) => total + row.costUsd, 0) * 1000) / 1000, seconds: results.reduce((total, row) => total + row.seconds, 0) }
writeFileSync(join(out, 'report.json'), JSON.stringify({ summary, results }, null, 2))
const lines = ['# Assistant v2 evaluation on public data', '', `${passed}/${results.length} passed · ${byKind.map(([kind, [ok, all]]) => `${kind} ${ok}/${all}`).join(' · ')} · $${summary.costUsd} · ${summary.seconds}s`, '']
for (const row of results) {
  lines.push(`## ${row.pass ? 'PASS' : 'FAIL'} ${row.id} (${row.kind})`, '', ...row.checks.map((check) => `- ${check.ok ? 'ok' : 'FAIL'} ${check.name}: ${check.detail}`), '', `Tools: ${row.tools.join(', ')}`, '', '> ' + (row.answer.text || '(no text)').replace(/\n/g, '\n> '), '')
}
writeFileSync(join(out, 'report.md'), lines.join('\n'))
console.log(`\n${passed}/${results.length} passed, ${JSON.stringify(summary.byKind)}, $${summary.costUsd}, report in ${out}`)
