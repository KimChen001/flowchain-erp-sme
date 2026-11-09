// Runs the assistant v2 evaluation on public demand data against a running
// local server, the way the panel asks: NDJSON, one thread per case. See
// README.md for starting the server. Calls the configured model, so it costs
// what the answers cost (about $0.03-0.10 an answer on Sonnet).
//
// Two suites:
//   m5   the research instance (12 M5 items, 90 days) on the browser test
//        server: --data=<research>/data/public [--reference=<json>]
//   uci  the UCI walkthrough workspace (npm run walkthrough:local), its
//        figures worked out from the seed's plan: --extract=<extract.json>
//        --as-of=<seed day> (or --walkthrough-dir=<data folder>, whose
//        seeded.json holds both)
//
//   node tests/ai-eval/v2-public/run.mjs --port=18941 --data=<research>/data/public
//   node tests/ai-eval/v2-public/run.mjs --suite=uci --port=18802 --walkthrough-dir=<folder>
//   options: --only=<ids> --kind=<kinds> --repeat=<n> --out=<folder>
//            --list (print the cases and their expected figures, ask nothing)
//            --compare=<earlier report.json> (which cases got worse or better)
//            --emails=<a,b> (uci: who asks, case by case, default
//            kim@example.com,daniel@example.com) --today=<YYYY-MM-DD>
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { readPublicDataInstances } from '../../../scripts/public-data-instance.mjs'
import { buildPublicDataPlan, readPublicDataExtract } from '../../../scripts/public-data/plan.mjs'
import { buildCases, readReference } from './cases.mjs'
import { uciFacts } from './uci-facts.mjs'
import { buildUciCases } from './uci-cases.mjs'
import { scoreAnswer } from './score.mjs'

const args = Object.fromEntries(process.argv.slice(2).map((arg) => arg.replace(/^--/, '').split('=')).map(([key, ...value]) => [key, value.join('=') || true]))
const suite = String(args.suite || 'm5')
const usage = [
  'Usage: node tests/ai-eval/v2-public/run.mjs --port=<api port> --data=<research data/public folder> [--reference=<public-instance-m5.json>]',
  '       node tests/ai-eval/v2-public/run.mjs --suite=uci --port=<api port> (--walkthrough-dir=<folder> | --extract=<extract.json> --as-of=<YYYY-MM-DD>)',
  '       [--only=<ids>] [--kind=<kinds>] [--repeat=<n>] [--out=<folder>]',
].join('\n')
if (!args.port || !['m5', 'uci'].includes(suite) || (suite === 'm5' && !args.data)) {
  console.error(usage)
  process.exit(2)
}
const base = `http://127.0.0.1:${args.port}`
const DAY_IN_LONDON = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' })

function m5Cases() {
  const instances = Object.fromEntries(readPublicDataInstances(args.data, 'm5_main,m5_intermittent').map((instance) => [instance.set, instance]))
  const referencePath = args.reference || resolve(args.data, '../../outputs/public-instance-m5.json')
  const reference = existsSync(referencePath) ? readReference(JSON.parse(readFileSync(referencePath, 'utf8'))) : null
  if (!reference) console.log(`No reference at ${referencePath}: the decision cases are left out.`)
  return { cases: buildCases(instances, reference), emails: ['admin@flowchain.local'], about: 'M5 research instance' }
}

function uciCases() {
  const seeded = args['walkthrough-dir'] ? JSON.parse(readFileSync(join(resolve(args['walkthrough-dir']), 'seeded.json'), 'utf8')) : {}
  const extractPath = resolve(String(args.extract || seeded.extract || join(homedir(), 'flowchain-data', 'public-data-extract.json')))
  const seedDay = String(args['as-of'] || seeded.asOf || '')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(seedDay)) throw new Error('The uci suite needs the seed day: --as-of=YYYY-MM-DD, or --walkthrough-dir with a seeded.json that records it (a walkthrough seeded without --as-of was seeded as of its seeding day).')
  const plan = buildPublicDataPlan(readPublicDataExtract(extractPath), 'uci', { seedDay })
  const today = String(args.today || DAY_IN_LONDON.format(new Date()))
  const facts = uciFacts(plan, { today })
  const emails = String(args.emails || 'kim@example.com,daniel@example.com').split(',').filter(Boolean)
  return { cases: buildUciCases(facts), emails, about: `UCI walkthrough seeded as of ${seedDay}, asked on ${today}` }
}

const built = suite === 'uci' ? uciCases() : m5Cases()
const only = args.only ? new Set(String(args.only).split(',')) : null
const kinds = args.kind ? new Set(String(args.kind).split(',')) : null
const cases = built.cases.filter((row) => (!only || only.has(row.id)) && (!kinds || kinds.has(row.kind)))
const repeat = Math.max(1, Number(args.repeat) || 1)
if (args.list) {
  // The cases and what each expects, without asking anything.
  console.log(`${built.about}: ${cases.length} cases`)
  for (const row of cases) console.log(`${row.id.padEnd(26)} ${row.kind.padEnd(12)} ${row.language}  ${row.turns.join(' → ')}\n${' '.repeat(27)}${JSON.stringify(row.expect)}`)
  process.exit(0)
}
const out = resolve(args.out || join(process.cwd(), `ai-eval-v2-${suite}`))
mkdirSync(out, { recursive: true })

// One signed-in session per email; cases take turns, so the per-user question
// limit (30 in 10 minutes) stretches across them.
const sessions = []
for (const email of built.emails) {
  const login = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, name: 'Evaluation', company: 'FlowChain' }) })
  if (!login.ok) throw new Error(`Sign-in as ${email} failed with ${login.status}`)
  sessions.push({ email, auth: { authorization: `Bearer ${(await login.json()).token}` } })
}
// The audit log (each answer's cost and tokens) is read as the admin, since a
// manager may not read it.
const adminLogin = sessions.find((session) => session.email === 'admin@flowchain.local') || await (async () => {
  const login = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'admin@flowchain.local', name: 'Evaluation', company: 'FlowChain' }) })
  return login.ok ? { email: 'admin@flowchain.local', auth: { authorization: `Bearer ${(await login.json()).token}` } } : null
})()
const readiness = await (await fetch(`${base}/api/ai-runtime/readiness`, { headers: sessions[0].auth })).json()
if (!readiness.assistantV2) throw new Error(`Assistant v2 is not on for this server (notice: ${readiness.notice || 'none'}).`)

const pause = (ms) => new Promise((done) => setTimeout(done, ms))
const rateLimited = (answer) => answer.status === 429 || [...answer.errors, ...answer.notices].some((code) => /rate_limit/.test(code))

async function askOnce(session, threadId, message, language) {
  const started = Date.now()
  const response = await fetch(`${base}/api/ai-runtime/respond`, {
    method: 'POST',
    headers: { ...session.auth, 'content-type': 'application/json', accept: 'application/x-ndjson, application/json' },
    body: JSON.stringify({ threadId, message, activeContext: { moduleId: 'overview', entityType: null, entityId: null }, answerLanguage: language }),
  })
  const parts = new Map()
  const answer = { status: response.status, ms: 0, model: null, text: '', ui: [], flags: [], errors: [], notices: [], tools: [] }
  const raw = await response.text()
  for (const line of raw.split('\n').filter(Boolean)) {
    let event
    try { event = JSON.parse(line) } catch { continue }
    if (event.type === 'start') answer.model = event.model || null
    else if (event.type === 'text_delta') parts.set(event.partId, { type: 'text', text: (parts.get(event.partId)?.text || '') + event.text })
    else if (event.type === 'replace') parts.set(event.partId, { type: 'text', text: event.text })
    else if (event.type === 'ui') parts.set(event.partId, { type: 'ui', component: event.component, props: event.props })
    else if (event.type === 'flag') for (const span of event.spans || []) answer.flags.push(`${span.kind}:${span.text}${span.reason ? ` (${span.reason})` : ''}`)
    else if (event.type === 'error') answer.errors.push(event.code)
    else if (event.type === 'notice') answer.notices.push(event.code)
    else if (event.type === 'tool' && event.state !== 'running') answer.tools.push(event.name)
    else if (!event.type && event.code) answer.errors.push(event.code)
  }
  answer.ms = Date.now() - started
  answer.textParts = [...parts.values()].filter((part) => part.type === 'text').map((part) => part.text.trim()).filter(Boolean)
  answer.text = answer.textParts.join('\n').trim()
  answer.ui = [...parts.values()].filter((part) => part.type === 'ui').map(({ component, props }) => ({ component, props }))
  const audit = await (await fetch(`${base}/api/audit-log?entityType=ai_skill&limit=1`, { headers: (adminLogin || session).auth })).json().catch(() => null)
  const record = Array.isArray(audit) ? audit[0]?.metadata?.assistantV2 : null
  answer.costUsd = Number(record?.costMicros || 0) / 1e6
  answer.inputTokens = Number(record?.usage?.input || 0)
  answer.modelCalls = Number(record?.modelCalls || 0)
  return answer
}

// A question the per-user limit turned away is asked again after a minute,
// for up to ten minutes; the wait is not counted in the answer's time.
async function ask(session, threadId, message, language) {
  for (let attempt = 0; ; attempt += 1) {
    const answer = await askOnce(session, threadId, message, language)
    if (!rateLimited(answer) || attempt >= 10) return answer
    console.log(`  (question limit for ${session.email}; waiting a minute)`)
    await pause(60000)
  }
}

const results = []
let turn = 0
for (const testCase of cases) {
  for (let round = 0; round < repeat; round += 1) {
    const session = sessions[turn % sessions.length]
    turn += 1
    const threadId = `thr_eval_${testCase.id.replace(/[^\w]/g, '')}_${Date.now().toString(36)}`.slice(0, 60)
    const answers = []
    for (const message of testCase.turns) answers.push(await ask(session, threadId, message, testCase.language))
    const last = answers.at(-1)
    const score = scoreAnswer(last, testCase.expect, { language: testCase.language })
    results.push({ id: testCase.id, kind: testCase.kind, language: testCase.language, round, pass: score.pass, checks: score.checks, turns: testCase.turns, seconds: Math.round(answers.reduce((total, row) => total + row.ms, 0) / 1000), costUsd: answers.reduce((total, row) => total + row.costUsd, 0), inputTokens: answers.reduce((total, row) => total + row.inputTokens, 0), tools: last.tools, model: last.model, asked: session.email, answer: last })
    const failed = score.checks.filter((check) => !check.ok).map((check) => `${check.name} (${check.detail})`).join('; ')
    console.log(`${score.pass ? 'PASS' : 'FAIL'} ${testCase.id.padEnd(26)}${repeat > 1 ? ` #${round + 1}` : ''} ${String(results.at(-1).seconds).padStart(3)}s ${failed}`)
  }
}

const tally = (key) => Object.fromEntries(Object.entries(results.reduce((totals, row) => { totals[row[key]] ||= [0, 0]; totals[row[key]][0] += row.pass ? 1 : 0; totals[row[key]][1] += 1; return totals }, {})).map(([name, [ok, all]]) => [name, `${ok}/${all}`]))
const passed = results.filter((row) => row.pass).length
const seconds = results.map((row) => row.seconds).sort((a, b) => a - b)
const failedChecks = Object.entries(results.flatMap((row) => row.checks.filter((check) => !check.ok).map((check) => check.name.replace(/:.*/, ''))).reduce((totals, name) => { totals[name] = (totals[name] || 0) + 1; return totals }, {})).sort((a, b) => b[1] - a[1])
const summary = {
  suite,
  about: built.about,
  passed,
  answers: results.length,
  cases: cases.length,
  repeat,
  byKind: tally('kind'),
  byLanguage: tally('language'),
  failedChecks: Object.fromEntries(failedChecks),
  costUsd: Math.round(results.reduce((total, row) => total + row.costUsd, 0) * 1000) / 1000,
  // Input tokens a case, the model's reading over every call of its turns.
  medianInputTokens: [...results.map((row) => row.inputTokens)].sort((a, b) => a - b)[Math.floor(results.length / 2)] ?? 0,
  seconds: seconds.reduce((total, value) => total + value, 0),
  medianSeconds: seconds[Math.floor(seconds.length / 2)] ?? 0,
  models: [...new Set(results.map((row) => row.model).filter(Boolean))],
}
// Against an earlier report (--compare=<report.json>): the cases that passed
// less or more often than before, by share of their answers that passed.
const passShare = (rows) => rows.reduce((shares, row) => { const entry = (shares[row.id] ||= { ok: 0, all: 0 }); entry.ok += row.pass ? 1 : 0; entry.all += 1; return shares }, {})
let changes = null
if (args.compare) {
  const earlier = passShare(JSON.parse(readFileSync(resolve(String(args.compare)), 'utf8')).results)
  const now = passShare(results)
  const moved = (sign) => Object.entries(now).filter(([id, entry]) => earlier[id] && Math.sign(entry.ok / entry.all - earlier[id].ok / earlier[id].all) === sign).map(([id, entry]) => `${id} (${earlier[id].ok}/${earlier[id].all} → ${entry.ok}/${entry.all})`)
  changes = { against: resolve(String(args.compare)), worse: moved(-1), better: moved(1), new: Object.keys(now).filter((id) => !earlier[id]) }
  summary.changes = changes
}
writeFileSync(join(out, 'report.json'), JSON.stringify({ summary, results }, null, 2))
const lines = [
  `# Assistant v2 evaluation: ${suite}`, '',
  `${built.about}. ${passed}/${results.length} passed · $${summary.costUsd} · median ${summary.medianSeconds}s and ${Math.round(summary.medianInputTokens / 1000)}k input tokens a case · ${summary.models.join(', ') || 'model not reported'}`, '',
  `By kind: ${Object.entries(summary.byKind).map(([kind, score]) => `${kind} ${score}`).join(' · ')}`, '',
  `By language: ${Object.entries(summary.byLanguage).map(([language, score]) => `${language} ${score}`).join(' · ')}`, '',
  `Failed checks: ${failedChecks.map(([name, count]) => `${name} ${count}`).join(' · ') || 'none'}`, '',
  ...(changes ? [`Against ${changes.against}:`, '', `- Worse: ${changes.worse.join(', ') || 'none'}`, `- Better: ${changes.better.join(', ') || 'none'}`, ...(changes.new.length ? [`- New cases: ${changes.new.join(', ')}`] : []), ''] : []),
]
for (const row of results) {
  lines.push(`## ${row.pass ? 'PASS' : 'FAIL'} ${row.id}${repeat > 1 ? ` #${row.round + 1}` : ''} (${row.kind}, ${row.language}, ${row.seconds}s)`, '', ...row.turns.map((message) => `**Q:** ${message}`), '', ...row.checks.map((check) => `- ${check.ok ? 'ok' : 'FAIL'} ${check.name}: ${check.detail}`), '', `Tools: ${row.tools.join(', ')}`, '', '> ' + (row.answer.text || '(no text)').replace(/\n/g, '\n> '), '')
}
writeFileSync(join(out, 'report.md'), lines.join('\n'))
console.log(`\n${passed}/${results.length} passed, ${JSON.stringify(summary.byKind)}, ${JSON.stringify(summary.byLanguage)}, $${summary.costUsd}, median ${summary.medianSeconds}s, report in ${out}`)
if (changes) console.log(`Worse than before: ${changes.worse.join(', ') || 'none'}\nBetter than before: ${changes.better.join(', ') || 'none'}`)
