// Runs a batch of emails about several orders (the shape of
// tests/ai-eval/supplier-reply/score-several.mjs) against a real model, as
// the paste reads one: the orders the email is read on, one reading each,
// the checks in code. No database and no app instance. Scores each case and
// the batch: no date on the wrong order, and at least 80% of the dated
// per-order parts correct (SEVERAL_ORDERS_GATE).
//
//   node scripts/supplier-reply-eval-several.mjs --provider=<env file> --cases=<cases .mjs> --export=<NAME> [--out=<dir>]
//
// --provider  as scripts/supplier-reply-eval.mjs: an env file outside this
//             checkout; nothing from it is printed but the provider kind, the
//             model and the endpoint's host.
// --cases     the cases module, e.g. the fourth or fifth held-out batch in
//             its own worktree; --export names its array.
// --out       where the readings, checks and usage go, as JSON: under this
//             checkout's .local/ (git-ignored) or outside the checkout.
//
// This calls a paid model: one reading per order read, two calls when the
// first answer fails the schema. It needs the owner's approval to run.
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createAssistantV2ModelClient } from '../server/domain/ai-assistant-v2-model/index.mjs'
import { providerRuntimeConfig } from '../server/domain/ai-runtime-provider-adapter-v2.mjs'
import { aiUsagePrices } from '../server/domain/ai-usage-meter.mjs'
import { SUPPLIER_REPLY_PROMPT_VERSION } from '../shared/supplier-reply-contract.mjs'
import { runSeveralOrdersCase, scoreSeveralOrdersCase, summarizeSeveralOrdersRun } from '../tests/ai-eval/supplier-reply/score-several.mjs'
import { meteredCallModel, readProviderEnv } from './supplier-reply-eval.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const inside = (path, folder) => path.toLowerCase() === folder.toLowerCase() || path.toLowerCase().startsWith(`${folder.toLowerCase()}${sep}`)

export function severalArgs(argv) {
  const args = Object.fromEntries(argv.map((arg) => arg.replace(/^--/, '').split('=')).map(([key, ...value]) => [key, value.join('=') || true]))
  for (const name of ['provider', 'cases', 'export']) if (!args[name] || args[name] === true) throw new Error(`Give --${name}=…`)
  return args
}

async function main() {
  const args = severalArgs(process.argv.slice(2))
  const env = readProviderEnv(String(args.provider))
  const config = providerRuntimeConfig(env)
  let host = null
  try { host = new URL(config.endpoint).host } catch { /* none */ }
  const client = createAssistantV2ModelClient(env, { logger: { warn: () => {}, info: () => {}, error: () => {} } })
  if (!client) throw new Error('The provider file does not configure a model the assistant can call.')
  const prices = aiUsagePrices(env)
  const cases = (await import(pathToFileURL(resolve(String(args.cases))).href))[String(args.export)]
  if (!Array.isArray(cases) || !cases.length) throw new Error(`${args.export} is not a list of cases in ${args.cases}.`)
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-')
  const out = resolve(args.out && args.out !== true ? String(args.out) : join(root, '.local', 'supplier-reply-eval', `${stamp}-several-${config.model || config.kind}`))
  if (inside(out, root) && !inside(out, join(root, '.local'))) throw new Error('--out must be under this checkout\'s .local/ (git-ignored) or outside the checkout.')

  console.log(`[supplier-reply-eval-several] ${cases.length} cases (${args.export}) · ${config.kind} · ${config.model || 'default model'} · ${host || 'no endpoint'} · prompt ${SUPPLIER_REPLY_PROMPT_VERSION}`)
  const { callModel, meter } = meteredCallModel(client, prices)
  const results = []
  const scores = []
  for (const kase of cases) {
    const before = { calls: meter.calls, costMicros: meter.costMicros }
    const run = await runSeveralOrdersCase(kase, callModel)
    const score = scoreSeveralOrdersCase(kase, run)
    scores.push(score)
    results.push({
      id: kase.id,
      read: run.choice.read,
      notRead: run.choice.notRead,
      byOrder: Object.fromEntries(Object.entries(run.byOrder).map(([number, one]) => [number, { readingStatus: one.read.readingStatus, reading: one.read.reading, check: one.check }])),
      calls: meter.calls - before.calls,
      costMicros: meter.costMicros - before.costMicros,
      score: { verdict: score.verdict, hardFails: score.hardFails, misses: score.misses, listed: score.listed, dated: score.dated, datedCorrect: score.datedCorrect },
    })
    console.log(`${kase.id.padEnd(46)} ${score.verdict.padEnd(9)} read ${run.choice.read.length} · dated ${score.datedCorrect}/${score.dated}${score.hardFails.length ? ` · HARD ${score.hardFails.map((row) => `${row.order} ${row.ref || ''} ${row.date || ''}`).join('; ')}` : ''}`)
    if (meter.error) { console.log(`[supplier-reply-eval-several] stopped: provider error (${meter.error.reason}${meter.error.status ? ` ${meter.error.status}` : ''})`); break }
  }
  const summary = summarizeSeveralOrdersRun(scores)
  console.log(`[supplier-reply-eval-several] ok ${summary.ok} · misses ${summary.misses} · hard fails ${summary.hardFails} of ${summary.cases} · dated ${summary.datedCorrect}/${summary.dated} · gate ${summary.gate.pass ? 'PASS' : 'FAIL'} · calls ${meter.calls} · $${(meter.costMicros / 1e6).toFixed(4)}`)
  mkdirSync(out, { recursive: true })
  writeFileSync(join(out, 'results.json'), `${JSON.stringify(results, null, 2)}\n`)
  writeFileSync(join(out, 'summary.json'), `${JSON.stringify({ provider: { kind: config.kind, model: config.model || null, endpointHost: host, promptVersion: SUPPLIER_REPLY_PROMPT_VERSION, prices }, cases: args.cases, export: args.export, summary, calls: meter.calls, costMicros: meter.costMicros }, null, 2)}\n`)
  console.log(`[supplier-reply-eval-several] wrote ${inside(out, root) ? relative(root, out) : out}`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`[supplier-reply-eval-several] ${error.message}`)
    process.exit(1)
  })
}
