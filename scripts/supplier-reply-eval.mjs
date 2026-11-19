// Runs the supplier reply set (tests/ai-eval/supplier-reply) against a real
// model, as the server reads a pasted reply: clean, one tool-less reading,
// checks in code (server/domain/supplier-reply-reading.mjs). No database and
// no app instance. Scores each case and the gate (score.mjs; #363 §7, SR-6).
//
//   node scripts/supplier-reply-eval.mjs --provider=<env file> [--only=<id,id>] [--out=<dir>]
//
// --provider  an env file outside this checkout with the assistant's model
//             settings (FLOWCHAIN_AI_PROVIDER_KIND, _ENDPOINT, _MODEL,
//             _API_KEY ...). Only FLOWCHAIN_AI_* names are read, into a local
//             object; nothing from it is printed or written but the provider
//             kind, the model and the endpoint's host. The model client is
//             the assistant's own (createAssistantV2ModelClient).
// --only      the case ids to run, comma-separated.
// --out       where the raw readings, checks and usage go, as JSON: under this
//             checkout's .local/ (git-ignored) or outside the checkout.
//             Default: .local/supplier-reply-eval/<time>-<model>/.
//
// This calls a paid model: one call per case, two when the first answer fails
// the schema. A provider error (a 402 spending limit or any other) stops the
// run for that provider; the cases not run are listed.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createAssistantV2ModelClient } from '../server/domain/ai-assistant-v2-model/index.mjs'
import { providerRuntimeConfig } from '../server/domain/ai-runtime-provider-adapter-v2.mjs'
import { anthropicMessagesUsage } from '../server/domain/ai-runtime-provider-specific-adapters-v2.mjs'
import { aiCallCostMicros, aiUsagePrices } from '../server/domain/ai-usage-meter.mjs'
import { SUPPLIER_REPLY_PROMPT_VERSION } from '../shared/supplier-reply-contract.mjs'
import { SUPPLIER_REPLY_CASES } from '../tests/ai-eval/supplier-reply/cases.mjs'
import { runSupplierReplyCase, scoreSupplierReplyCase, summarizeSupplierReplyRun } from '../tests/ai-eval/supplier-reply/score.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CALL_TIMEOUT_MS = 90000
const inside = (path, folder) => path.toLowerCase() === folder.toLowerCase() || path.toLowerCase().startsWith(`${folder.toLowerCase()}${sep}`)

// The model settings from an env file outside this checkout, as a local object.
export function readProviderEnv(file) {
  const path = resolve(file)
  if (inside(path, root)) throw new Error('--provider must point outside this checkout, so no key is ever kept in it.')
  const env = {}
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*(FLOWCHAIN_AI_[A-Z0-9_]+)\s*=\s*(.*?)\s*$/)
    if (match) env[match[1]] = match[2].replace(/^(["'])(.*)\1$/, '$2')
  }
  if (!env.FLOWCHAIN_AI_PROVIDER_KIND || !env.FLOWCHAIN_AI_PROVIDER_API_KEY) throw new Error('--provider needs FLOWCHAIN_AI_PROVIDER_KIND and FLOWCHAIN_AI_PROVIDER_API_KEY.')
  return { ...env, FLOWCHAIN_AI_ASSISTANT_MODE: 'assistant_v2' }
}

// callModel for readSupplierReply over the assistant's model client, with
// no tools; it counts calls, tokens and cost, keeps each answer's text, and
// remembers the last provider error (code and HTTP status only).
export function meteredCallModel(client, prices) {
  const meter = { calls: 0, inputTokens: 0, outputTokens: 0, costMicros: 0, answers: [], error: null }
  const callModel = async ({ system, messages, maxTokens }) => {
    meter.calls += 1
    let answer = ''
    let usage = null
    try {
      for await (const event of client.stream({ system, messages, tools: [], maxTokens }, AbortSignal.timeout(CALL_TIMEOUT_MS))) {
        if (event?.type === 'text_delta') answer += event.text || ''
        if (event?.type === 'message_end') {
          usage = anthropicMessagesUsage({ usage: event.usage })
          if (!answer) answer = (Array.isArray(event.content) ? event.content : []).filter((block) => block?.type === 'text').map((block) => block.text || '').join('')
        }
      }
    } catch (error) {
      meter.error = { reason: error?.reason || error?.name || 'error', status: error?.status || null, budgetExceeded: Boolean(error?.budgetExceeded) }
      throw error
    }
    meter.inputTokens += usage?.inputTokens || 0
    meter.outputTokens += usage?.outputTokens || 0
    meter.costMicros += aiCallCostMicros(usage, prices)
    meter.answers.push(answer)
    return { text: answer, usage }
  }
  return { callModel, meter }
}

const pad = (value, width) => String(value).padEnd(width).slice(0, Math.max(width, String(value).length))
function noteOf(score) {
  const notes = [
    ...score.hardFails.map((row) => `${row.ref} ${row.date}: ${row.reasons.join('; ')}`),
    ...score.misses.map((row) => `${row.ref} miss: want ${row.expected}, got ${row.got}`),
    ...score.held.map((row) => `${row.ref} held: ${row.got}`),
    ...(score.readingStatus !== 'read' ? [`reading ${score.readingStatus}`] : []),
    ...score.details,
  ]
  return notes.join(' | ')
}

async function main() {
  const args = Object.fromEntries(process.argv.slice(2).map((arg) => arg.replace(/^--/, '').split('=')).map(([key, ...value]) => [key, value.join('=') || true]))
  if (!args.provider || args.provider === true) throw new Error('Give --provider=<env file>.')
  const env = readProviderEnv(String(args.provider))
  const config = providerRuntimeConfig(env)
  let host = null
  try { host = new URL(config.endpoint).host } catch { /* none */ }
  const modelLog = []
  const client = createAssistantV2ModelClient(env, { logger: { warn: (line) => modelLog.push(String(line)), info: () => {}, error: (line) => modelLog.push(String(line)) } })
  if (!client) throw new Error('The provider file does not configure a model the assistant can call.')
  const prices = aiUsagePrices(env)
  const only = args.only && args.only !== true ? new Set(String(args.only).split(',').map((id) => id.trim()).filter(Boolean)) : null
  const cases = only ? SUPPLIER_REPLY_CASES.filter((kase) => only.has(kase.id)) : SUPPLIER_REPLY_CASES
  if (only && cases.length !== only.size) throw new Error(`Unknown case ids: ${[...only].filter((id) => !cases.some((kase) => kase.id === id)).join(', ')}`)
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-')
  const out = resolve(args.out && args.out !== true ? String(args.out) : join(root, '.local', 'supplier-reply-eval', `${stamp}-${config.model || config.kind}`))
  if (inside(out, root) && !inside(out, join(root, '.local'))) throw new Error('--out must be under this checkout\'s .local/ (git-ignored) or outside the checkout.')

  console.log(`[supplier-reply-eval] ${cases.length} cases · ${config.kind} · ${config.model || 'default model'} · ${host || 'no endpoint'} · prompt ${SUPPLIER_REPLY_PROMPT_VERSION}`)
  console.log(`[supplier-reply-eval] prices: $${prices.inputPerMillion} in / $${prices.outputPerMillion} out per million tokens (the app's meter)`)
  const { callModel, meter } = meteredCallModel(client, prices)
  const results = []
  let stopped = null
  for (const kase of cases) {
    const before = { calls: meter.calls, inputTokens: meter.inputTokens, outputTokens: meter.outputTokens, costMicros: meter.costMicros, answers: meter.answers.length }
    const run = await runSupplierReplyCase(kase, callModel)
    const score = scoreSupplierReplyCase(kase, run)
    results.push({
      id: kase.id,
      cleaned: { text: run.cleaned.text, quotedTextHidden: run.cleaned.quotedTextHidden, invisibleRemoved: run.cleaned.invisibleRemoved },
      readingStatus: run.read.readingStatus,
      readingIssues: run.read.issues || null,
      calls: meter.calls - before.calls,
      usage: { inputTokens: meter.inputTokens - before.inputTokens, outputTokens: meter.outputTokens - before.outputTokens, costMicros: meter.costMicros - before.costMicros },
      answers: meter.answers.slice(before.answers),
      reading: run.read.reading,
      check: run.check,
      instructionsIgnored: run.instructionsIgnored,
      score,
    })
    console.log(`${pad(kase.id, 44)} ${pad(kase.lang, 2)} ${pad(score.expectedState, 17)} ${pad(score.gotState, 17)} ${pad(score.verdict, 9)} ${noteOf(score)}`)
    if (run.read.readingStatus === 'failed' || ['ai_off', 'no_provider', 'over_cap'].includes(run.read.readingStatus)) {
      stopped = { atCase: kase.id, readingStatus: run.read.readingStatus, error: meter.error, notRun: cases.slice(cases.indexOf(kase) + 1).map((row) => row.id) }
      console.log(`[supplier-reply-eval] stopped: the provider failed on ${kase.id} (${meter.error?.reason || run.read.readingStatus}${meter.error?.status ? ` ${meter.error.status}` : ''}${meter.error?.budgetExceeded ? ', spending limit' : ''}). ${stopped.notRun.length} cases not run.`)
      break
    }
  }
  const summary = summarizeSupplierReplyRun(results.map((row) => row.score), meter)
  console.log('')
  console.log(`[supplier-reply-eval] ok ${summary.ok} · held ${summary.held} · state only ${summary.stateOnly} · misses ${summary.misses} · hard fails ${summary.hardFails} (of ${summary.cases})`)
  console.log(`[supplier-reply-eval] dated correct ${summary.datedCorrect}/${summary.dated} (${Math.round(summary.datedCorrectShare * 1000) / 10}%) · states matched ${summary.stateMatches}/${summary.cases} · nothing to record ${summary.nothingToRecord.correct}/${summary.nothingToRecord.expected} · flags ${summary.flags.found}/${summary.flags.expected} · injection marked ${summary.injection.flagged}/${summary.injection.expected} (+${summary.injection.flaggedWithout} others)`)
  console.log(`[supplier-reply-eval] reading ${JSON.stringify(summary.readingStatus)} · ${summary.calls} calls · ${summary.inputTokens} in / ${summary.outputTokens} out tokens · $${summary.costUsd.toFixed(4)}`)
  console.log(`[supplier-reply-eval] gate: ${summary.gate.pass && !stopped ? 'PASS' : 'FAIL'} (hard fails ${summary.gate.hardFails}, dated correct ${Math.round(summary.gate.datedCorrectShare * 1000) / 10}%, needs 0 and 90%)${stopped ? ' — run stopped early' : ''}`)

  mkdirSync(out, { recursive: true })
  const provider = { kind: config.kind, model: config.model || null, endpointHost: host, promptVersion: SUPPLIER_REPLY_PROMPT_VERSION, prices }
  writeFileSync(join(out, 'results.json'), `${JSON.stringify(results, null, 2)}\n`)
  writeFileSync(join(out, 'summary.json'), `${JSON.stringify({ provider, cases: cases.length, stopped, summary, gatePass: summary.gate.pass && !stopped, modelLog }, null, 2)}\n`)
  console.log(`[supplier-reply-eval] wrote ${inside(out, root) ? relative(root, out) : out}`)
  if (stopped) process.exitCode = 2
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`[supplier-reply-eval] ${error.message}`)
    process.exit(1)
  })
}

