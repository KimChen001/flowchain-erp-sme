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
//            --emails=<a,b> (uci: who asks a case that names no asUser,
//            default kim@example.com,daniel@example.com) --today=<YYYY-MM-DD>
//            --setup (write the records a case needs first: on a test
//            instance only; refused on the walkthrough's ports 15231/15232
//            and 18831/18832, setup-guard.mjs)
//
// A case may say who asks (asUser, an email), and a turn may be an object
// instead of the question alone: { text, activeContext, formResults,
// interfaceLanguage } (design audit 2026-11-15, L5-18). activeContext
// { entityType: 'purchase_order', supplier, late: true } is looked up as the
// case is asked: that supplier's earliest late open order. formResults
// entries without a formId get the form the previous answer showed.
//
// A turn may name an order, { supplier, late }, looked up the same way, whose
// number replaces {order} in its text. A case may need a record first
// (setup), written through the app's own routes as the asking user, and only
// with --setup: { supplierReply: { order, text, receivedOn, match, dismiss } }
// pastes a supplier reply on that order (unless one matching `match` is
// there) and dismisses it; { noSupplierReply: order } checks the order has
// none. Without --setup a case that writes is left out, and says so.
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { readPublicDataInstances } from '../../../scripts/public-data-instance.mjs'
import { buildPublicDataPlan, readPublicDataExtract } from '../../../scripts/public-data/plan.mjs'
import { buildCases, readReference } from './cases.mjs'
import { uciFacts } from './uci-facts.mjs'
import { buildUciCases } from './uci-cases.mjs'
import { LENGTH_BUDGET, answerLength, scoreAnswer } from './score.mjs'
import { withResolvedMentions } from './resolve-mentions.mjs'
import { setupRefusal } from './setup-guard.mjs'

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
// --setup writes, so never against the walkthrough people use (setup-guard.mjs).
const refused = setupRefusal({ setup: args.setup, port: args.port })
if (refused) {
  console.error(refused)
  process.exit(2)
}
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
const chosen = built.cases.filter((row) => (!only || only.has(row.id)) && (!kinds || kinds.has(row.kind)))
// A case that writes a record first runs only with --setup.
const writes = (row) => Boolean(row.setup?.supplierReply || row.setup?.member)
const cases = args.setup ? chosen : chosen.filter((row) => !writes(row))
if (cases.length < chosen.length) console.log(`Left out ${chosen.length - cases.length} case(s) that paste a supplier reply or add a member first: ${chosen.filter(writes).map((row) => row.id).join(', ')} (pass --setup on a test instance).`)
const repeat = Math.max(1, Number(args.repeat) || 1)
if (args.list) {
  // The cases and what each expects, without asking anything.
  console.log(`${built.about}: ${cases.length} cases`)
  for (const row of cases) console.log(`${row.id.padEnd(26)} ${row.kind.padEnd(12)} ${row.language}  ${row.asUser ? `[${row.asUser}] ` : ''}${row.turns.map((turn) => (typeof turn === 'string' ? turn : turn.text)).join(' → ')}\n${' '.repeat(27)}${JSON.stringify(row.expect)}`)
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

// The open record a turn names, looked up in the workspace as the case is
// asked (a late order's id and number change with each seed).
async function orderFor(session, spec) {
  const orders = await (await fetch(`${base}/api/purchase-orders`, { headers: session.auth })).json().catch(() => [])
  const today = DAY_IN_LONDON.format(new Date())
  // The list's due day (dueDay, expectedDeliveryDate since the list pages'
  // rework; the older names kept for an older server).
  const due = (row) => String(row.dueDay || row.expectedDeliveryDate || row.expectedDate || row.dueDate || row.promisedDate || '').slice(0, 10)
  const match = (Array.isArray(orders) ? orders : [])
    .filter((row) => JSON.stringify([row.supplierName, row.supplier]).toLowerCase().includes(String(spec.supplier).toLowerCase()))
    .filter((row) => ['issued', 'partially_received', 'sent'].includes(String(row.status || '').toLowerCase()) && (!spec.late || (due(row) && due(row) < today)))
    .sort((a, b) => due(a).localeCompare(due(b)))[0]
  if (!match) throw new Error(`No ${spec.late ? 'late ' : ''}open purchase order of ${spec.supplier} to open.`)
  return match
}
const orderLabel = (row) => row.orderNumber || row.po || row.id
async function contextFor(session, spec) {
  if (!spec) return { moduleId: 'overview', entityType: null, entityId: null }
  if (spec.entityType !== 'purchase_order' || !spec.supplier) return spec
  const match = await orderFor(session, spec)
  return { moduleId: 'procurement:orders', entityType: 'purchase_order', entityId: match.id, entityLabel: orderLabel(match) }
}

// The records a case needs before it is asked (see the top of this file).
async function json(response, what) {
  const body = await response.json().catch(() => null)
  if (!response.ok) throw new Error(`${what} failed with ${response.status} ${body?.code || ''}`.trim())
  return body
}
// A member with a given role, invited by the admin and accepted with the
// invitation's token (no email is connected on a test instance). A member
// who can already sign in is left as they are; their role is checked.
async function addMember({ email, role }) {
  const signIn = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, name: 'Evaluation', company: 'FlowChain' }) })
  if (!signIn.ok) {
    if (!adminLogin) throw new Error('No admin session to invite a member with')
    const invited = await json(await fetch(`${base}/api/workspace/invitations`, { method: 'POST', headers: { ...adminLogin.auth, 'content-type': 'application/json' }, body: JSON.stringify({ email, role }) }), `Inviting ${email} as ${role}`)
    if (!invited.invitationToken) throw new Error(`The invitation for ${email} gave no token`)
    await json(await fetch(`${base}/api/workspace/invitations/accept`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: invited.invitationToken, name: 'Evaluation buyer' }) }), `Accepting the invitation for ${email}`)
  }
  const signedIn = signIn.ok ? await signIn.json() : await json(await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, name: 'Evaluation', company: 'FlowChain' }) }), `Signing in as ${email}`)
  if (signedIn.user?.role !== role) throw new Error(`${email} is a member as ${signedIn.user?.role || 'unknown'}, not ${role}`)
}

async function setUpCase(session, setup) {
  if (setup.supplierReply) {
    const spec = setup.supplierReply
    const order = await orderFor(session, spec.order)
    const path = `${base}/api/procurement/orders/${encodeURIComponent(order.id)}/supplier-replies`
    const headers = { ...session.auth, 'content-type': 'application/json' }
    const listed = await json(await fetch(path, { headers: session.auth }), 'Listing the supplier replies')
    let reply = (listed.replies || []).find((row) => row.state !== 'superseded' && String(row.text || '').includes(spec.match))
    if (!reply) reply = (await json(await fetch(path, { method: 'POST', headers, body: JSON.stringify({ text: spec.text.replaceAll('{order}', orderLabel(order)), receivedOn: spec.receivedOn }) }), 'Pasting the supplier reply')).reply
    if (spec.dismiss && ['proposed', 'needs_you'].includes(reply.state)) await json(await fetch(`${path}/${encodeURIComponent(reply.id)}/dismiss`, { method: 'POST', headers, body: JSON.stringify(spec.dismiss) }), 'Dismissing the supplier reply')
  }
  if (setup.noSupplierReply) {
    const order = await orderFor(session, setup.noSupplierReply)
    const listed = await json(await fetch(`${base}/api/procurement/orders/${encodeURIComponent(order.id)}/supplier-replies`, { headers: session.auth }), 'Listing the supplier replies')
    const found = (listed.replies || []).filter((row) => row.state !== 'superseded').length
    if (found) throw new Error(`${orderLabel(order)} already has ${found} supplier repl${found === 1 ? 'y' : 'ies'}; this case needs an order with none.`)
  }
}

async function askOnce(session, threadId, turn, language, previous = null) {
  const started = Date.now()
  const { text: written, activeContext = null, formResults = null, interfaceLanguage = null, order = null } = typeof turn === 'string' ? { text: turn } : turn
  const message = order ? written.replaceAll('{order}', orderLabel(await orderFor(session, order))) : written
  // A form result names the form the previous answer showed, unless it says which.
  const lastForm = previous?.uiParts?.filter((part) => part.component === 'pr_form').at(-1)
  const forms = Array.isArray(formResults) ? formResults.map((entry) => ({ formId: lastForm ? `${threadId}:${lastForm.id}` : `${threadId}:none`, ...entry })) : null
  const response = await fetch(`${base}/api/ai-runtime/respond`, {
    method: 'POST',
    headers: { ...session.auth, 'content-type': 'application/json', accept: 'application/x-ndjson, application/json' },
    body: JSON.stringify({ threadId, message, activeContext: await contextFor(session, activeContext), answerLanguage: interfaceLanguage || language, ...(forms ? { formResults: forms } : {}) }),
  })
  const parts = new Map()
  // tools: the tools that ran (state done); toolErrors: those that failed, so
  // a case's `calls` never passes on a call that errored (L5-16).
  const answer = { status: response.status, ms: 0, model: null, messageId: null, text: '', ui: [], uiParts: [], flags: [], errors: [], notices: [], tools: [], toolErrors: [], refs: [] }
  // The records the answer links: those its text names (flag refs) and those
  // its cards carry, as the panel chips them.
  const addRefs = (refs) => { for (const ref of refs || []) if (ref?.type && ref?.id && !answer.refs.some((known) => known.type === ref.type && known.id === ref.id)) answer.refs.push({ type: ref.type, id: ref.id, label: ref.label ?? null }) }
  const raw = await response.text()
  for (const line of raw.split('\n').filter(Boolean)) {
    let event
    try { event = JSON.parse(line) } catch { continue }
    if (event.type === 'start') { answer.model = event.model || null; answer.messageId = event.messageId || null }
    else if (event.type === 'text_delta') parts.set(event.partId, { type: 'text', text: (parts.get(event.partId)?.text || '') + event.text })
    else if (event.type === 'replace') parts.set(event.partId, { type: 'text', text: event.text })
    else if (event.type === 'ui') { parts.set(event.partId, { type: 'ui', component: event.component, props: event.props }); addRefs(event.refs) }
    else if (event.type === 'flag') { for (const span of event.spans || []) answer.flags.push(`${span.kind}:${span.text}${span.reason ? ` (${span.reason})` : ''}`); addRefs(event.refs) }
    else if (event.type === 'error') answer.errors.push(event.code)
    else if (event.type === 'notice') answer.notices.push(event.code)
    else if (event.type === 'tool' && event.state === 'done') answer.tools.push(event.name)
    else if (event.type === 'tool' && event.state === 'error') answer.toolErrors.push(event.name)
    else if (!event.type && event.code) answer.errors.push(event.code)
  }
  answer.ms = Date.now() - started
  answer.textParts = [...parts.values()].filter((part) => part.type === 'text').map((part) => part.text.trim()).filter(Boolean)
  answer.text = answer.textParts.join('\n').trim()
  answer.ui = [...parts.values()].filter((part) => part.type === 'ui').map(({ component, props }) => ({ component, props }))
  answer.uiParts = [...parts.entries()].filter(([, part]) => part.type === 'ui').map(([id, part]) => ({ id, component: part.component }))
  // This answer's own audit row, by its message id: the latest row may be
  // another answer's (L5-16). Without one, the cost is not counted.
  const audit = await (await fetch(`${base}/api/audit-log?entityType=ai_skill&limit=20`, { headers: (adminLogin || session).auth })).json().catch(() => null)
  const record = Array.isArray(audit) && answer.messageId ? audit.map((row) => row?.metadata?.assistantV2).find((row) => row?.messageId === answer.messageId) || null : null
  answer.costFound = Boolean(record)
  answer.costUsd = Number(record?.costMicros || 0) / 1e6
  answer.inputTokens = Number(record?.usage?.input || 0)
  answer.modelCalls = Number(record?.modelCalls || 0)
  return answer
}

// A question the per-user limit turned away is asked again after a minute,
// for up to ten minutes; the wait is not counted in the answer's time.
async function ask(session, threadId, message, language, previous = null) {
  for (let attempt = 0; ; attempt += 1) {
    const answer = await askOnce(session, threadId, message, language, previous)
    if (!rateLimited(answer) || attempt >= 10) return answer
    console.log(`  (question limit for ${session.email}; waiting a minute)`)
    await pause(60000)
  }
}

const results = []
// Who asks: by the case's place in the whole list, and the round, so a run
// of some cases (--only, --kind) asks each as a full run does, and repeats
// alternate users (2026-11-12: with a running count, three inserted cases
// moved 33 of 94 answers to the other user).
// A case that names its user (asUser) is asked by that user, signed in once
// (design audit 2026-11-15, L5-18: margin-en went to a role that cannot see
// margins when cases moved).
const named = new Map(sessions.map((session) => [session.email, session]))
async function sessionFor(email) {
  if (!named.has(email)) {
    const login = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, name: 'Evaluation', company: 'FlowChain' }) })
    if (!login.ok) throw new Error(`Sign-in as ${email} failed with ${login.status}`)
    named.set(email, { email, auth: { authorization: `Bearer ${(await login.json()).token}` } })
  }
  return named.get(email)
}
const turnText = (turn) => (typeof turn === 'string' ? turn : turn.text)
for (const testCase of cases) {
  const place = built.cases.indexOf(testCase)
  for (let round = 0; round < repeat; round += 1) {
    // A member the case needs and the seed lacks is invited first (--setup).
    if (testCase.setup?.member) {
      try {
        await addMember(testCase.setup.member)
      } catch (error) {
        results.push({ id: testCase.id, kind: testCase.kind, language: testCase.language, round, pass: false, checks: [{ name: 'setup', ok: false, detail: error.message }], turns: testCase.turns.map(turnText), seconds: 0, costUsd: 0, inputTokens: 0, tools: [], model: null, asked: testCase.setup.member.email, answer: { text: '' }, earlier: [] })
        console.log(`FAIL ${testCase.id.padEnd(26)} setup: ${error.message}`)
        continue
      }
    }
    const session = testCase.asUser ? await sessionFor(testCase.asUser) : sessions[(place + round) % sessions.length]
    const threadId = `thr_eval_${testCase.id.replace(/[^\w]/g, '')}_${Date.now().toString(36)}`.slice(0, 60)
    const answers = []
    if (testCase.setup) {
      try {
        await setUpCase(session, testCase.setup)
      } catch (error) {
        // The case is not asked: it fails on its setup, not on an answer.
        results.push({ id: testCase.id, kind: testCase.kind, language: testCase.language, round, pass: false, checks: [{ name: 'setup', ok: false, detail: error.message }], turns: testCase.turns.map(turnText), seconds: 0, costUsd: 0, inputTokens: 0, tools: [], model: null, asked: session.email, answer: { text: '' }, earlier: [] })
        console.log(`FAIL ${testCase.id.padEnd(26)} setup: ${error.message}`)
        continue
      }
    }
    // The panel's language goes with every turn; a case may expect another one
    // the user asked for in their words ("用中文说"). A record a turn names that
    // cannot be found fails that case, not the run.
    try {
      for (const turn of testCase.turns) answers.push(await ask(session, threadId, turn, testCase.language, answers.at(-1) || null))
    } catch (error) {
      results.push({ id: testCase.id, kind: testCase.kind, language: testCase.language, round, pass: false, checks: [{ name: 'asked', ok: false, detail: error.message }], turns: testCase.turns.map(turnText), seconds: 0, costUsd: 0, inputTokens: 0, tools: [], model: null, asked: session.email, answer: { text: '' }, earlier: [] })
      console.log(`FAIL ${testCase.id.padEnd(26)} not asked: ${error.message}`)
      continue
    }
    const last = answers.at(-1)
    // A case whose expectation the scorer cannot read fails, not the run.
    let score
    try {
      // A mention named only in the workspace (the order waiting for approval).
      const expect = testCase.expect?.mentions?.some((entry) => entry?.orderWaitingApproval)
        ? withResolvedMentions(testCase.expect, await (await fetch(`${base}/api/purchase-orders`, { headers: session.auth })).json().catch(() => []))
        : testCase.expect
      score = scoreAnswer(last, expect, { language: testCase.expect?.language || testCase.language, answers })
    } catch (error) {
      score = { pass: false, checks: [{ name: 'scored', ok: false, detail: error.message }] }
    }
    results.push({ id: testCase.id, kind: testCase.kind, language: testCase.language, round, pass: score.pass, checks: score.checks, turns: testCase.turns.map(turnText), seconds: Math.round(answers.reduce((total, row) => total + row.ms, 0) / 1000), costUsd: answers.reduce((total, row) => total + row.costUsd, 0), inputTokens: answers.reduce((total, row) => total + row.inputTokens, 0), tools: last.tools, model: last.model, asked: session.email, answer: last, earlier: answers.slice(0, -1).map((row) => ({ text: row.text, ui: row.ui.map((part) => part.component), refs: row.refs, tools: row.tools })) })
    // The results so far, after every case, so a run that stops keeps them.
    writeFileSync(join(out, 'results-so-far.json'), JSON.stringify(results, null, 2))
    const failed = score.checks.filter((check) => !check.ok).map((check) => `${check.name} (${check.detail})`).join('; ')
    console.log(`${score.pass ? 'PASS' : 'FAIL'} ${testCase.id.padEnd(26)}${repeat > 1 ? ` #${round + 1}` : ''} ${String(results.at(-1).seconds).padStart(3)}s ${failed}`)
  }
}

const quantile = (values, share) => { const sorted = [...values].sort((a, b) => a - b); return sorted.length ? sorted[Math.floor((sorted.length - 1) * share)] : 0 }
function lengthSummary(rows) {
  const of = (group) => {
    const lengths = group.map((row) => answerLength(row.answer?.text))
    const over = group.filter((row) => row.checks.some((check) => check.name === 'concise' && !check.ok)).length
    return { answers: group.length, median: quantile(lengths, 0.5), p90: quantile(lengths, 0.9), longest: Math.max(0, ...lengths), overBudget: over }
  }
  return {
    budget: LENGTH_BUDGET,
    all: of(rows),
    ...Object.fromEntries([...new Set(rows.map((row) => row.language))].map((language) => [language, of(rows.filter((row) => row.language === language))])),
    lookups: of(rows.filter((row) => row.checks.some((check) => check.name === 'concise' && /lookup/.test(check.detail)))),
  }
}
const tally = (key) => Object.fromEntries(Object.entries(results.reduce((totals, row) => { totals[row[key]] ||= [0, 0]; totals[row[key]][0] += row.pass ? 1 : 0; totals[row[key]][1] += 1; return totals }, {})).map(([name, [ok, all]]) => [name, `${ok}/${all}`]))
const passed = results.filter((row) => row.pass).length
const seconds = results.map((row) => row.seconds).sort((a, b) => a - b)
const failedChecks = Object.entries(results.flatMap((row) => row.checks.filter((check) => !check.ok && !check.soft).map((check) => check.name.replace(/:.*/, ''))).reduce((totals, name) => { totals[name] = (totals[name] || 0) + 1; return totals }, {})).sort((a, b) => b[1] - a[1])
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
  // How long the answers are (2026-11-12), by language, in answerLength terms.
  length: lengthSummary(results),
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
  `Length (a Chinese character counts twice): median ${summary.length.all.median}, 90th percentile ${summary.length.all.p90}, longest ${summary.length.all.longest}; lookups median ${summary.length.lookups.median}; over budget ${summary.length.all.overBudget} of ${summary.length.all.answers}`, '',
  ...(changes ? [`Against ${changes.against}:`, '', `- Worse: ${changes.worse.join(', ') || 'none'}`, `- Better: ${changes.better.join(', ') || 'none'}`, ...(changes.new.length ? [`- New cases: ${changes.new.join(', ')}`] : []), ''] : []),
]
for (const row of results) {
  lines.push(`## ${row.pass ? 'PASS' : 'FAIL'} ${row.id}${repeat > 1 ? ` #${row.round + 1}` : ''} (${row.kind}, ${row.language}, ${row.seconds}s)`, '', ...row.turns.map((message) => `**Q:** ${message}`), '', ...row.checks.map((check) => `- ${check.ok ? 'ok' : 'FAIL'} ${check.name}: ${check.detail}`), '', `Tools: ${row.tools.join(', ')}`, '', '> ' + (row.answer.text || '(no text)').replace(/\n/g, '\n> '), '')
}
writeFileSync(join(out, 'report.md'), lines.join('\n'))
console.log(`\n${passed}/${results.length} passed, ${JSON.stringify(summary.byKind)}, ${JSON.stringify(summary.byLanguage)}, $${summary.costUsd}, median ${summary.medianSeconds}s, length median ${summary.length.all.median} (lookups ${summary.length.lookups.median}), over budget ${summary.length.all.overBudget}/${summary.length.all.answers}, report in ${out}`)
if (changes) console.log(`Worse than before: ${changes.worse.join(', ') || 'none'}\nBetter than before: ${changes.better.join(', ') || 'none'}`)
