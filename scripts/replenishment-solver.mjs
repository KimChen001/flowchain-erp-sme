import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { logReplenishmentCall, planReplenishment, replenishmentInputFromExport } from '../server/domain/replenishment-solver.mjs'

// The replenishment solver outside the assistant, for studies that compare
// arms on the same instances (research note v5, appendix A):
//
//   OR alone               node scripts/replenishment-solver.mjs export.json --budget=5000
//   OR plan given to an    the same command's JSON (plans, items, binding) is what the LLM
//   LLM                    is shown; the assistant's optimize_order_plan tool returns the
//                          same figures from the live records
//   LLM-estimated          --params=llm-params.json: parameters and per-item values an LLM
//   parameters fed to OR   estimated, applied on top of the export before solving
//   a given plan           --plan=LDM-002:50,LDM-001:10 (repeat --plan for more): a textbook
//                          policy's order, an LLM's or a buyer's, costed beside the optimum
//                          and ordering nothing
//
// The study's findings come from public data (M5, Online Retail II): calibrate on a
// training window, backtest on a later one. The adapter that builds those items is not
// written yet. A FlowChain export is pipeline evidence only. Such an export also carries
// the walkthrough's own reorder suggestion: it is costed as deployed_rule, and
// --budget=rule takes its spend as the budget. Both only reproduce the prototype; neither
// is a study baseline.
//
// export.json is a replenishment-inputs export (scripts/export-replenishment-inputs.mjs).
// Options: --budget=<amount> (default: no budget; --budget=rule, see above),
// --holding-rate=25, --shortage-multiple=5 or
// --service-level=83.3, --review-days=7, --samples=200, --seed=7, --heldout=20000,
// --heldout-seed=1007, --position=all_open_lines|due_within_cycle,
// --formulation=epigraph|scenarios, --exclude=SKU,SKU, --fix=SKU:qty,
// --log=<calls.jsonl> (one JSON line per call; also FLOWCHAIN_REPLENISHMENT_SOLVER_LOG),
// --out=<file> (default stdout), --label=<arm name> (recorded in the log).
//
// --params file: { "parameters": { "budget", "holdingRatePercent", "shortageCostMultiple",
// "serviceLevelPercent", "reviewDays" }, "items": { "<SKU>": { "extraDemand", "leadTimeDays",
// "moq", "unitPrice", "onHand", "openRequests", "dailyDemand": [...] } } }. Values given on
// the command line win over the file's parameters.
//
// Same input, same output: the scenarios are drawn with fixed seeds (numpy's generator, so
// they equal the Python prototype's), and the solve stops on its gap, not on the clock.

const OPTIONS = Object.freeze({
  budget: 'budget', 'holding-rate': 'holdingRatePercent', 'shortage-multiple': 'shortageCostMultiple', 'service-level': 'serviceLevelPercent',
  'review-days': 'reviewDays', samples: 'samples', seed: 'seed', heldout: 'heldOutSamples', 'heldout-seed': 'heldOutSeed',
  position: 'positionRule', formulation: 'formulation', 'time-limit': 'timeLimitSeconds', gap: 'gap',
})
const TEXT_OPTIONS = new Set(['positionRule', 'formulation'])
const ITEM_OVERRIDES = new Set(['extraDemand', 'leadTimeDays', 'moq', 'unitPrice', 'onHand', 'reserved', 'openRequests', 'dailyDemand', 'reorderPoint'])

function parseLines(values) {
  const quantities = {}
  for (const value of values) {
    for (const entry of value.split(',').map((part) => part.trim()).filter(Boolean)) {
      const [sku, quantity] = entry.split(':')
      if (!sku || quantity === undefined || !Number.isFinite(Number(quantity))) throw new Error(`Write lines as SKU:quantity, not "${entry}".`)
      quantities[sku] = Number(quantity)
    }
  }
  return quantities
}

// Runs one study call: returns the plan (the solver's full result) with the
// arm's label, the export's identity and the options used.
export async function runReplenishmentSolver(argv, { env = process.env } = {}) {
  const flags = argv.filter((value) => value.startsWith('--'))
  const positional = argv.filter((value) => !value.startsWith('--'))
  const all = (name) => flags.filter((value) => value.startsWith(`--${name}=`)).map((value) => value.slice(name.length + 3))
  const one = (name) => all(name).at(-1)
  if (!positional[0]) throw new Error('Usage: node scripts/replenishment-solver.mjs <export.json> [--budget=5000] [--plan=SKU:qty] ...')
  const raw = JSON.parse(readFileSync(resolve(positional[0]), 'utf8'))
  const input = replenishmentInputFromExport(raw)
  const params = one('params') ? JSON.parse(readFileSync(resolve(one('params')), 'utf8')) : {}
  for (const [sku, values] of Object.entries(params.items || {})) {
    const item = input.items.find((entry) => entry.sku.toLowerCase() === sku.toLowerCase())
    if (!item) throw new Error(`--params names ${sku}, which the export does not plan.`)
    for (const [key, value] of Object.entries(values)) {
      if (!ITEM_OVERRIDES.has(key)) throw new Error(`--params cannot set ${key} on an item.`)
      item[key] = value
    }
  }
  const options = { ...(params.parameters || {}) }
  for (const [flag, key] of Object.entries(OPTIONS)) {
    const value = one(flag)
    if (value === undefined) continue
    if (flag === 'budget' && value === 'rule') {
      options.budget = input.items.reduce((sum, item) => sum + (input.deployedRule[item.sku] || 0) * item.unitPrice, 0)
      continue
    }
    options[key] = TEXT_OPTIONS.has(key) ? value : Number(value)
  }
  if (all('plan').length) options.candidates = [{ id: 'given_plan', quantities: parseLines(all('plan')) }]
  if (Object.keys(input.deployedRule).length) options.candidates = [...(options.candidates || []), { id: 'deployed_rule', quantities: input.deployedRule }]
  if (one('exclude')) options.exclude = one('exclude').split(',').map((sku) => sku.trim()).filter(Boolean)
  if (all('fix').length) options.fixed = parseLines(all('fix'))
  const plan = await planReplenishment(input, options)
  const result = { label: one('label') || null, export: { file: positional[0], generatedAt: raw.generatedAt || null, today: raw.today, skipped: input.skipped }, options, plan }
  logReplenishmentCall({ caller: 'script', label: result.label, input, options, result: plan }, { path: one('log') || env.FLOWCHAIN_REPLENISHMENT_SOLVER_LOG })
  return result
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const argv = process.argv.slice(2)
  const result = await runReplenishmentSolver(argv)
  const json = `${JSON.stringify(result, null, 2)}\n`
  const out = argv.find((value) => value.startsWith('--out='))?.slice(6)
  if (out) writeFileSync(resolve(out), json)
  else process.stdout.write(json)
}
