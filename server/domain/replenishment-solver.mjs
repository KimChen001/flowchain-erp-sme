import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { Worker } from 'node:worker_threads'
import { numpyDefaultRng } from './numpy-random.mjs'
import { runHighsModel } from './replenishment-solver-highs.mjs'

// The replenishment solver: what to order now, across items, under a budget
// and the suppliers' minimum order quantities, solved exactly as a mixed-integer
// program (MILP) with HiGHS. Read-only and pure apart from the optional call
// log: no database, no network. The model is the research prototype's (research
// note v5, appendix A, saa.py), so the assistant, the scripts and a study run
// the same instances.
//
//   i       item               I_i   inventory position: on hand - reserved + open purchase order lines
//   c_i     unit price         m_i   supplier minimum order quantity (MOQ)
//   L_i     lead time, days    R     review period, days (the next chance to order)
//   h_i     holding cost per unit left at the end of the cycle = rate x c_i x (L_i + R) / 365
//   pi_i    shortage cost per unit short = multiple x h_i (or set from a service level)
//   D_ik    demand over L_i + R days in scenario k = 1..N
//   q_i     order quantity (whole units), z_i = 1 when item i is ordered, B budget
//
//   min (1/N) sum_k sum_i [ h_i (I_i + q_i - D_ik)^+ + pi_i (D_ik - I_i - q_i)^+ ]
//   s.t. m_i z_i <= q_i <= M_i z_i, z_i in {0, 1}, q_i integer, sum_i c_i q_i <= B
//
// No purchase term: stock left over carries into the next cycle, so money
// enters through the budget and the holding cost. (.)^+ is linearised with
// u, v >= 0; scenarios with the same demand for an item share one u and one v,
// weighted by how often they occur (the same objective, a smaller model).
// M_i = min(floor(B / c_i), max(max_k D_ik - I_i, m_i)): an order beyond the
// largest sampled demand only adds holding cost, so the cap removes no optimum.
//
// Scenarios: a circular block bootstrap of the daily demand history, 7-day
// blocks (keeps the weekday pattern), the same blocks for every item (keeps
// cross-item correlation), drawn with numpy's generator so seed 7 gives the
// prototype's N = 200 scenarios exactly. Every plan is then also costed on
// 20,000 fresh samples (seed 1007) of the same history: the optimum is proven
// on the N scenarios, and the fresh samples give its expected cost without the
// optimiser's in-sample bias.

export const REPLENISHMENT_INPUT_SCHEMA = 'flowchain.replenishment-solver-input.v1'
export const REPLENISHMENT_PLAN_SCHEMA = 'flowchain.replenishment-plan.v1'
export const REPLENISHMENT_SOLVER_DEFAULTS = Object.freeze({
  reviewDays: 7,
  holdingRatePercent: 25,
  shortageCostMultiple: 5,
  samples: 200,
  seed: 7,
  heldOutSamples: 20000,
  heldOutSeed: 1007,
  blockDays: 7,
  positionRule: 'all_open_lines',
  gap: 0,
  timeLimitSeconds: 30,
})
export const REPLENISHMENT_SOLVER_LIMITS = Object.freeze({ items: 60, samples: 2000, heldOutSamples: 50000, reviewDays: 90, historyDays: 730 })
export const POSITION_RULES = Object.freeze(['all_open_lines', 'due_within_cycle'])

const text = (value) => String(value ?? '').trim()
const finite = (value) => typeof value === 'number' && Number.isFinite(value)
const EPSILON = 1e-9

export class ReplenishmentInputError extends Error {
  constructor(message, details = []) {
    super(message)
    this.name = 'ReplenishmentInputError'
    this.details = details
  }
}

function fail(message, details) {
  throw new ReplenishmentInputError(message, details)
}

// The planning parameters, each with where it came from: the caller's value or
// the default (an assumed planning value). A service level sets the shortage
// cost multiple: the newsvendor's critical ratio pi / (pi + h) is the share of
// cycles that should end without running short.
export function resolveReplenishmentParameters(options = {}) {
  const D = REPLENISHMENT_SOLVER_DEFAULTS
  const given = (key) => options[key] !== undefined && options[key] !== null
  const number = (key, min, max, fallback, integer = false) => {
    if (!given(key)) return fallback
    const value = Number(options[key])
    if (!finite(value) || value < min || value > max || (integer && !Number.isInteger(value))) fail(`${key} must be ${integer ? 'a whole number' : 'a number'} from ${min} to ${max}.`)
    return value
  }
  const holdingRatePercent = number('holdingRatePercent', 0.01, 100, D.holdingRatePercent)
  let shortageCostMultiple = number('shortageCostMultiple', 0.01, 1000, D.shortageCostMultiple)
  let shortageSource = given('shortageCostMultiple') ? 'user' : 'assumed_planning_value'
  if (given('serviceLevelPercent')) {
    const level = number('serviceLevelPercent', 50, 99.9, null)
    shortageCostMultiple = level / (100 - level)
    shortageSource = 'service_level'
  }
  const budget = given('budget') ? Number(options.budget) : null
  if (budget !== null && !finite(budget)) fail('budget must be a number.')
  const positionRule = given('positionRule') ? text(options.positionRule) : D.positionRule
  if (!POSITION_RULES.includes(positionRule)) fail(`positionRule must be one of ${POSITION_RULES.join(', ')}.`)
  const L = REPLENISHMENT_SOLVER_LIMITS
  const formulation = given('formulation') ? text(options.formulation) : 'epigraph'
  if (!['epigraph', 'scenarios'].includes(formulation)) fail('formulation must be epigraph or scenarios.')
  return {
    formulation,
    budget,
    reviewDays: number('reviewDays', 1, L.reviewDays, D.reviewDays, true),
    holdingRatePercent,
    shortageCostMultiple,
    serviceLevelPercent: (100 * shortageCostMultiple) / (shortageCostMultiple + 1),
    samples: number('samples', 10, L.samples, D.samples, true),
    seed: number('seed', 0, Number.MAX_SAFE_INTEGER, D.seed, true),
    heldOutSamples: number('heldOutSamples', 0, L.heldOutSamples, D.heldOutSamples, true),
    heldOutSeed: number('heldOutSeed', 0, Number.MAX_SAFE_INTEGER, D.heldOutSeed, true),
    blockDays: number('blockDays', 1, 28, D.blockDays, true),
    positionRule,
    gap: number('gap', 0, 0.5, D.gap),
    timeLimitSeconds: number('timeLimitSeconds', 0.1, 600, D.timeLimitSeconds),
    sources: {
      holdingRate: given('holdingRatePercent') ? 'user' : 'assumed_planning_value',
      shortageCost: shortageSource,
      reviewDays: given('reviewDays') ? 'user' : 'assumed_planning_value',
      budget: budget === null ? 'none' : 'user',
    },
  }
}

// Validates and copies the items. Each: sku, unitPrice, moq, leadTimeDays,
// onHand, reserved, openLines [{ remaining, dueInDays }], dailyDemand (the
// same number of days, oldest first, for every item), and optionally name,
// unit, supplier, reorderPoint, openRequests (quantity on open purchase
// requests, counted in the position) and extraDemand (units on top of every
// scenario: a known order the history does not show).
export function normalizeReplenishmentItems(items) {
  if (!Array.isArray(items) || !items.length) fail('At least one item is required.')
  if (items.length > REPLENISHMENT_SOLVER_LIMITS.items) fail(`At most ${REPLENISHMENT_SOLVER_LIMITS.items} items can be planned at once.`)
  const days = Array.isArray(items[0]?.dailyDemand) ? items[0].dailyDemand.length : 0
  if (days < 7 || days > REPLENISHMENT_SOLVER_LIMITS.historyDays) fail(`dailyDemand must hold 7 to ${REPLENISHMENT_SOLVER_LIMITS.historyDays} days.`)
  const seen = new Set()
  return items.map((item) => {
    const sku = text(item?.sku)
    const bad = (field) => fail(`${sku || 'An item'}: ${field}.`, [sku])
    if (!sku) bad('sku is required')
    if (seen.has(sku.toLowerCase())) bad('appears twice')
    seen.add(sku.toLowerCase())
    const unitPrice = Number(item.unitPrice)
    if (!finite(unitPrice) || unitPrice <= 0) bad('unitPrice must be above 0')
    const moq = item.moq === null || item.moq === undefined ? 0 : Number(item.moq)
    if (!finite(moq) || moq < 0) bad('moq must be 0 or more')
    const leadTimeDays = Number(item.leadTimeDays)
    if (!Number.isInteger(leadTimeDays) || leadTimeDays < 0 || leadTimeDays > 365) bad('leadTimeDays must be a whole number of days from 0 to 365')
    const onHand = Number(item.onHand)
    const reserved = item.reserved === null || item.reserved === undefined ? 0 : Number(item.reserved)
    if (!finite(onHand) || !finite(reserved)) bad('onHand and reserved must be numbers')
    const openLines = (Array.isArray(item.openLines) ? item.openLines : []).map((line) => {
      const remaining = Number(line?.remaining)
      const dueInDays = line?.dueInDays === null || line?.dueInDays === undefined ? null : Number(line.dueInDays)
      if (!finite(remaining) || remaining < 0) bad('every open line needs a remaining quantity of 0 or more')
      if (dueInDays !== null && !Number.isInteger(dueInDays)) bad('dueInDays must be a whole number of days')
      return { remaining, dueInDays, ...(line.reference ? { reference: text(line.reference) } : {}) }
    })
    if (!Array.isArray(item.dailyDemand) || item.dailyDemand.length !== days) bad(`dailyDemand must hold ${days} days like the first item`)
    const dailyDemand = Float64Array.from(item.dailyDemand, Number)
    if (dailyDemand.some((value) => !finite(value) || value < 0)) bad('dailyDemand must hold numbers of 0 or more')
    const extraDemand = item.extraDemand === null || item.extraDemand === undefined ? 0 : Number(item.extraDemand)
    if (!finite(extraDemand) || extraDemand < 0) bad('extraDemand must be 0 or more')
    const reorderPoint = item.reorderPoint === null || item.reorderPoint === undefined ? null : Number(item.reorderPoint)
    const openRequests = item.openRequests === null || item.openRequests === undefined ? 0 : Number(item.openRequests)
    if (!finite(openRequests) || openRequests < 0) bad('openRequests must be 0 or more')
    return {
      sku, name: text(item.name) || null, unit: text(item.unit) || null, supplier: text(item.supplier) || null,
      unitPrice, moq, leadTimeDays, onHand, reserved, openLines, openRequests, dailyDemand, extraDemand,
      reorderPoint: finite(reorderPoint) && reorderPoint > 0 ? reorderPoint : null,
    }
  })
}

// I_i. all_open_lines: every open line, late or not, as the reorder list counts
// it since #249 (the inventory position of a reorder-point policy).
// due_within_cycle: only lines due within the item's lead time + review days
// (the prototype's single-cycle position); a line due later cannot serve this
// cycle's demand. Lines without a due day count in both. Open purchase
// requests (openRequests) count in both, as the assistant's other order tools
// count them: ordering on top of a pending request would order twice.
export function inventoryPosition(item, cycleDays, rule = 'all_open_lines') {
  let position = item.onHand - item.reserved + (item.openRequests || 0)
  const counted = []
  const dueAfterCycle = []
  for (const line of item.openLines) {
    const later = line.dueInDays !== null && line.dueInDays > cycleDays
    if (later) dueAfterCycle.push(line)
    if (rule === 'all_open_lines' || !later) {
      position += line.remaining
      counted.push(line)
    }
  }
  return { position, counted, dueAfterCycle }
}

// D (items x n): demand over each item's horizon in each scenario. Scenario k
// strings together random blocks of the history, wrapping around its end; the
// same draws serve every item. As saa.bootstrap: starts = rng.integers(0, T,
// size=(n, blocks)), day d of scenario k = (starts[k, d // block] + d % block) % T.
export function bootstrapDemand(daily, horizons, n, seed, blockDays = REPLENISHMENT_SOLVER_DEFAULTS.blockDays) {
  const T = daily[0].length
  const blocks = Math.ceil(Math.max(...horizons) / blockDays)
  const starts = n > 0 ? numpyDefaultRng(seed).integers(T, n * blocks) : []
  return daily.map((series, item) => {
    const horizon = horizons[item]
    const out = new Float64Array(n)
    for (let k = 0; k < n; k += 1) {
      let sum = 0
      for (let day = 0; day < horizon; day += 1) sum += series[(starts[k * blocks + Math.floor(day / blockDays)] + (day % blockDays)) % T]
      out[k] = sum
    }
    return out
  })
}

// The instance: items, parameters, positions, unit costs and both scenario sets.
export function buildReplenishmentInstance(input, options = {}) {
  const items = normalizeReplenishmentItems(input?.items)
  const parameters = resolveReplenishmentParameters({ ...(input?.parameters || {}), ...options })
  const cycleDays = items.map((item) => item.leadTimeDays + parameters.reviewDays)
  const positions = items.map((item, index) => inventoryPosition(item, cycleDays[index], parameters.positionRule))
  const rate = parameters.holdingRatePercent / 100
  const h = items.map((item, index) => (rate * item.unitPrice * cycleDays[index]) / 365)
  const pi = h.map((value) => parameters.shortageCostMultiple * value)
  const daily = items.map((item) => item.dailyDemand)
  const withExtra = (samples) => samples.map((row, index) => (items[index].extraDemand ? row.map((value) => value + items[index].extraDemand) : row))
  return {
    items,
    parameters,
    currency: text(input?.currency) || null,
    today: text(input?.today) || null,
    historyDays: daily[0].length,
    cycleDays,
    positions: positions.map((entry) => entry.position),
    linesCounted: positions.map((entry) => entry.counted),
    linesDueAfterCycle: positions.map((entry) => entry.dueAfterCycle),
    c: items.map((item) => item.unitPrice),
    minimum: items.map((item) => item.moq),
    h,
    pi,
    D: withExtra(bootstrapDemand(daily, cycleDays, parameters.samples, parameters.seed, parameters.blockDays)),
    heldOut: parameters.heldOutSamples > 0 ? withExtra(bootstrapDemand(daily, cycleDays, parameters.heldOutSamples, parameters.heldOutSeed, parameters.blockDays)) : null,
  }
}

// One item's expected holding and shortage over its cycle at order q, on samples.
function itemOutcome(instance, index, quantity, samples) {
  const level = instance.positions[index] + quantity
  let left = 0
  let short = 0
  let shortCount = 0
  for (const demand of samples) {
    if (level >= demand) left += level - demand
    else { short += demand - level; shortCount += 1 }
  }
  const n = samples.length || 1
  const leftover = left / n
  const shortUnits = short / n
  return {
    holding: instance.h[index] * leftover,
    shortage: instance.pi[index] * shortUnits,
    expectedLeftover: leftover,
    expectedShort: shortUnits,
    chanceShort: shortCount / n,
  }
}

// Why a plan is outside the feasible set: whole units, minimums, the budget.
export function planIssues(instance, quantities, budget = instance.parameters.budget) {
  const issues = []
  quantities.forEach((quantity, index) => {
    const sku = instance.items[index].sku
    if (quantity < 0) issues.push({ sku, code: 'negative', quantity })
    else if (Math.abs(quantity - Math.round(quantity)) > EPSILON) issues.push({ sku, code: 'not_whole_units', quantity })
    if (quantity > EPSILON && quantity < instance.minimum[index] - EPSILON) issues.push({ sku, code: 'below_minimum_order', quantity, minimum: instance.minimum[index] })
  })
  const spend = quantities.reduce((sum, quantity, index) => sum + quantity * instance.c[index], 0)
  if (budget !== null && spend > budget + 1e-6) issues.push({ code: 'over_budget', spend, budget })
  return issues
}

// A plan's spend and expected costs, in sample (the N scenarios the optimum is
// proven on) and on the fresh samples, with each item's outcome on the fresh
// samples (or the N scenarios when there are none).
export function evaluateReplenishmentPlan(instance, quantities, { budget = instance.parameters.budget } = {}) {
  const q = instance.items.map((_, index) => Number(quantities[index] ?? 0))
  const total = (samples) => {
    let holding = 0
    let shortage = 0
    const perItem = q.map((quantity, index) => {
      const outcome = itemOutcome(instance, index, quantity, samples[index])
      holding += outcome.holding
      shortage += outcome.shortage
      return outcome
    })
    return { holding, shortage, total: holding + shortage, perItem }
  }
  const inSample = total(instance.D)
  const heldOut = instance.heldOut ? total(instance.heldOut) : null
  const spend = q.reduce((sum, quantity, index) => sum + quantity * instance.c[index], 0)
  const issues = planIssues(instance, q, budget)
  return {
    quantities: q,
    spend,
    withinBudget: budget === null || spend <= budget + 1e-6,
    feasible: !issues.length,
    issues,
    inSample: { holding: inSample.holding, shortage: inSample.shortage, total: inSample.total },
    heldOut: heldOut ? { holding: heldOut.holding, shortage: heldOut.shortage, total: heldOut.total } : null,
    perItem: (heldOut || inSample).perItem.map((outcome, index) => ({ sku: instance.items[index].sku, quantity: q[index], ...outcome })),
  }
}

// Each item's unconstrained optimum on the N scenarios: the newsvendor
// quantity (no minimum, no budget), and the best order with the minimum but no
// budget. The SAA cost is convex in q, minimised where the share of scenarios
// with demand at or below I + q first reaches pi / (pi + h), so the best whole
// order is the floor or ceiling of that point, clamped to the allowed range;
// with a minimum, ordering nothing is the only other candidate.
export function unbudgetedQuantities(instance, bounds = {}) {
  const N = instance.parameters.samples
  const ratio = instance.parameters.shortageCostMultiple / (instance.parameters.shortageCostMultiple + 1)
  const rank = Math.max(0, Math.ceil(N * ratio - EPSILON) - 1)
  return instance.items.map((item, index) => {
    const lo = bounds.lo?.[index] ?? 0
    const hi = bounds.hi?.[index] ?? Infinity
    const cost = (quantity) => { const o = itemOutcome(instance, index, quantity, instance.D[index]); return o.holding + o.shortage }
    const sorted = Float64Array.from(instance.D[index]).sort()
    const point = Math.max(0, sorted[rank] - instance.positions[index])
    const best = (floor) => {
      const options = [...new Set([Math.floor(point), Math.ceil(point)].map((value) => Math.min(hi, Math.max(floor, value))))]
      return options.reduce((a, b) => (cost(b) < cost(a) - EPSILON ? b : a))
    }
    const newsvendor = best(lo)
    const floor = Math.max(lo, lo > 0 || instance.minimum[index] > 0 ? Math.ceil(instance.minimum[index] - EPSILON) : 0)
    let withMinimum = floor <= hi ? best(floor) : null
    if (lo === 0 && (withMinimum === null || cost(0) <= cost(withMinimum) + EPSILON)) withMinimum = 0
    return { sku: item.sku, newsvendor, withMinimum }
  })
}

// One HiGHS solve, in a worker thread by default (a solve of many items can
// take seconds, which must not hold up the server's other requests), or in
// this thread with inline. A worker that outlives the time limit by 15 s is
// stopped.
export async function runHighs(model, options, { inline = false } = {}) {
  if (inline) return runHighsModel(model, options)
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./replenishment-solver-worker.mjs', import.meta.url), { workerData: { model, options } })
    let settled = false
    const settle = (callback) => { if (!settled) { settled = true; clearTimeout(timer); callback() } }
    const timer = setTimeout(() => settle(() => { worker.terminate(); resolve({ name: 'worker_timeout', optimal: false, infeasible: false, columns: null }) }), (options.timeLimitSeconds + 15) * 1000)
    worker.once('message', (message) => settle(() => {
      worker.terminate()
      if (message?.ok) resolve(message.result)
      else reject(new Error(message?.message || 'The solver failed.'))
    }))
    worker.once('error', (error) => settle(() => reject(error)))
    worker.once('exit', (code) => settle(() => reject(new Error(`The solver stopped (exit code ${code}).`))))
  })
}

// Distinct demand values of each item's scenarios with their weights.
function demandSupport(samples) {
  const counts = new Map()
  for (const value of samples) counts.set(value, (counts.get(value) || 0) + 1)
  return [...counts.entries()].sort((a, b) => a[0] - b[0]).map(([value, count]) => ({ value, weight: count / samples.length }))
}

// Solves the MILP. budget: null drops the constraint. lo / hi: per-item bounds
// (lo = hi fixes an item, hi = 0 leaves it out). formulation: epigraph
// (default, small) or scenarios (the prototype's u/v form); both have the same
// objective at every q, which the tests check.
export const MILP_FORMULATIONS = Object.freeze(['epigraph', 'scenarios'])
export async function solveReplenishmentMilp(instance, { budget = instance.parameters.budget, lo = null, hi = null, gap = instance.parameters.gap, timeLimitSeconds = instance.parameters.timeLimitSeconds, formulation = instance.parameters.formulation || 'epigraph', inline = false } = {}) {
  if (!MILP_FORMULATIONS.includes(formulation)) fail(`formulation must be one of ${MILP_FORMULATIONS.join(', ')}.`)
  const n = instance.items.length
  const lower = instance.items.map((_, index) => Math.max(0, Math.ceil((lo?.[index] ?? 0) - EPSILON)))
  const upperGiven = instance.items.map((_, index) => (hi?.[index] === undefined || hi?.[index] === null ? Infinity : Math.floor(hi[index] + EPSILON)))
  if (budget !== null && budget < 0) return { status: 'infeasible', reason: 'negative_budget' }
  const supports = instance.D.map(demandSupport)
  const M = instance.items.map((_, index) => {
    const largestUseful = Math.ceil(Math.max(0, supports[index].at(-1).value - instance.positions[index], instance.minimum[index], lower[index]) - EPSILON)
    let cap = Math.min(largestUseful, upperGiven[index])
    if (budget !== null) cap = Math.min(cap, Math.floor(budget / instance.c[index] + EPSILON))
    return cap
  })
  const blocked = instance.items.map((item, index) => ({ sku: item.sku, index })).filter(({ index }) => lower[index] > M[index] || (lower[index] > 0 && lower[index] < instance.minimum[index] - EPSILON))
  if (blocked.length) {
    const reason = blocked.some(({ index }) => lower[index] > 0 && lower[index] < instance.minimum[index] - EPSILON) ? 'fixed_below_minimum_order'
      : budget !== null && blocked.some(({ index }) => lower[index] > Math.floor(budget / instance.c[index] + EPSILON)) ? 'fixed_lines_exceed_budget' : 'bounds_conflict'
    return { status: 'infeasible', reason, items: blocked.map(({ sku }) => sku) }
  }
  const fixedSpend = lower.reduce((sum, quantity, index) => sum + quantity * instance.c[index], 0)
  if (budget !== null && fixedSpend > budget + 1e-6) return { status: 'infeasible', reason: 'fixed_lines_exceed_budget', spend: fixedSpend }

  // Columns: q (n), z (n), then the cost variables of the formulation.
  const colCost = []
  const colLower = []
  const colUpper = []
  const integrality = []
  for (let i = 0; i < n; i += 1) { colCost.push(0); colLower.push(lower[i]); colUpper.push(M[i]); integrality.push(1) }
  for (let i = 0; i < n; i += 1) { colCost.push(0); colLower.push(lower[i] > 0 ? 1 : 0); colUpper.push(M[i] > 0 ? 1 : 0); integrality.push(1) }
  const rows = []
  for (let i = 0; i < n; i += 1) {
    const support = supports[i]
    const I = instance.positions[i]
    if (formulation === 'scenarios') {
      // The prototype's form: u and v per distinct demand value.
      for (const { value, weight } of support) {
        const u = colCost.length
        colCost.push(weight * instance.h[i], weight * instance.pi[i])
        colLower.push(0, 0)
        colUpper.push(Infinity, Infinity)
        integrality.push(0, 0)
        rows.push({ lower: I - value, upper: Infinity, entries: [[i, -1], [u, 1]] })      // u >= I + q - D
        rows.push({ lower: value - I, upper: Infinity, entries: [[i, 1], [u + 1, 1]] })   // v >= D - I - q
      }
      continue
    }
    // Epigraph form of the same objective: the item's SAA cost f(y) at stock
    // y = I + q is convex and piecewise linear with breakpoints at the demand
    // values, so it is the largest of its pieces: t_i >= f(d_a) + s_j (y - d_a),
    // with slope s_j = h F_j - pi (1 - F_j) right of d_j (F_j: share of
    // scenarios with demand at most d_j). Only the pieces over the range q can
    // take are needed. One variable per item instead of two per scenario.
    const h = instance.h[i]
    const pi = instance.pi[i]
    const costAt = (y) => support.reduce((sum, { value, weight }) => sum + weight * (y >= value ? h * (y - value) : pi * (value - y)), 0)
    const t = colCost.length
    colCost.push(1)
    colLower.push(0)
    colUpper.push(Infinity)
    integrality.push(0)
    const yLow = I + lower[i]
    const yHigh = I + M[i]
    let share = 0
    for (let j = 0; j <= support.length; j += 1) {
      if (j > 0) share += support[j - 1].weight
      const left = j === 0 ? -Infinity : support[j - 1].value
      const right = j === support.length ? Infinity : support[j].value
      if (left > yHigh + EPSILON || right < yLow - EPSILON) continue
      const anchor = support[Math.max(j, 1) - 1].value
      const slope = h * share - pi * (1 - share)
      rows.push({ lower: costAt(anchor) + slope * (I - anchor), upper: Infinity, entries: [[t, 1], [i, -slope]] })   // t - s q >= f(d_a) + s (I - d_a)
    }
  }
  for (let i = 0; i < n; i += 1) {
    rows.push({ lower: 0, upper: Infinity, entries: [[i, 1], [n + i, -instance.minimum[i]]] })            // q >= m z
    rows.push({ lower: -Infinity, upper: 0, entries: [[i, 1], [n + i, -M[i]]] })                          // q <= M z
  }
  if (budget !== null) rows.push({ lower: -Infinity, upper: budget, entries: instance.c.map((price, i) => [i, price]) })
  const starts = [0]
  const indices = []
  const values = []
  for (const row of rows) {
    for (const [column, value] of row.entries) if (value !== 0) { indices.push(column); values.push(value) }
    starts.push(indices.length)
  }
  const started = performance.now()
  const result = await runHighs({
    numCols: colCost.length,
    numRows: rows.length,
    colCost, colLower, colUpper,
    rowLower: rows.map((row) => row.lower),
    rowUpper: rows.map((row) => row.upper),
    matrix: { format: 'csr', numRows: rows.length, numCols: colCost.length, starts, indices, values },
    integrality,
  }, { gap, timeLimitSeconds, keep: n }, { inline })
  const seconds = (performance.now() - started) / 1000
  const solver = { name: 'HiGHS', formulation, status: result.name, mipGap: result.mipGap, dualBound: result.dualBound, objective: result.objective, nodes: result.nodes, seconds, columns: colCost.length, rows: rows.length, gapLimit: gap, timeLimitSeconds }
  if (result.infeasible) return { status: 'infeasible', reason: 'no_plan_meets_the_constraints', solver }
  if (!result.columns) return { status: 'no_solution', reason: result.name, solver }
  const quantities = result.columns.map((value) => Math.round(value) + 0)
  return { status: result.optimal ? 'optimal' : 'not_proven_optimal', quantities, solver }
}

const quantitiesFrom = (instance, plan) => {
  if (Array.isArray(plan)) return instance.items.map((_, index) => Number(plan[index] ?? 0))
  const bySku = new Map(Object.entries(plan || {}).map(([sku, quantity]) => [sku.toLowerCase(), Number(quantity)]))
  const unknown = [...bySku.keys()].filter((sku) => !instance.items.some((item) => item.sku.toLowerCase() === sku))
  if (unknown.length) fail(`Not in this plan's items: ${unknown.join(', ')}.`, unknown)
  return instance.items.map((item) => bySku.get(item.sku.toLowerCase()) ?? 0)
}

// The reorder list's quantities (buildReorderList since #249): the shortfall
// below the recorded reorder point of on hand - reserved + every open line,
// raised to the supplier's minimum; 0 at or above it. Items bought in their
// stock unit only, as the solver's items are.
export function reorderListQuantities(items) {
  return items.map((item) => {
    if (!(item.reorderPoint > 0)) return 0
    const position = item.onHand - item.reserved + item.openLines.reduce((sum, line) => sum + line.remaining, 0)
    const shortfall = Math.max(0, item.reorderPoint - position)
    return shortfall > 0 ? Math.max(shortfall, item.moq || 0) : 0
  })
}

// Why the optimum orders what it orders for each item.
function reasonFor({ optimal, unbudgeted, fixed, excluded, budgetBinds }) {
  if (excluded) return 'left_out_by_user'
  if (fixed) return 'fixed_by_user'
  if (optimal > 0) {
    if (budgetBinds && optimal < unbudgeted.withMinimum) return 'cut_by_budget'
    if (unbudgeted.newsvendor < optimal && optimal === unbudgeted.withMinimum) return 'raised_to_minimum_order'
    return 'ordered'
  }
  if (unbudgeted.newsvendor === 0) return 'covered'
  if (unbudgeted.withMinimum === 0) return 'minimum_order_costs_more_than_it_saves'
  return 'cut_by_budget'
}

// The whole answer: the optimal plan, why each item gets what it gets, which
// constraints bind, and the same costs for ordering nothing, for the reorder
// list's plan and for any candidate plans (a buyer's edit), so they compare.
//   input:   { items, currency?, today?, parameters? }
//   options: parameters (see resolveReplenishmentParameters) plus
//            candidates [{ id, label?, quantities: { sku: q } | [q] }],
//            fixed { sku: q } (re-solve the rest), exclude [sku],
//            includeReorderList (default true)
export async function planReplenishment(input, options = {}) {
  const { candidates = [], fixed = {}, exclude = [], includeReorderList = true, inline = false, ...parameterOptions } = options
  const instance = buildReplenishmentInstance(input, parameterOptions)
  const { parameters, items } = instance
  const budget = parameters.budget
  const fixedQuantities = quantitiesFrom(instance, fixed)
  const fixedSkus = new Set(Object.keys(fixed || {}).map((sku) => sku.toLowerCase()))
  const excluded = new Set((Array.isArray(exclude) ? exclude : []).map((sku) => text(sku).toLowerCase()))
  const unknownExcluded = [...excluded].filter((sku) => !items.some((item) => item.sku.toLowerCase() === sku))
  if (unknownExcluded.length) fail(`Not in this plan's items: ${unknownExcluded.join(', ')}.`, unknownExcluded)
  const lo = items.map((item, index) => (fixedSkus.has(item.sku.toLowerCase()) ? fixedQuantities[index] : 0))
  const hi = items.map((item, index) => (excluded.has(item.sku.toLowerCase()) ? 0 : fixedSkus.has(item.sku.toLowerCase()) ? fixedQuantities[index] : null))

  const solved = await solveReplenishmentMilp(instance, { budget, lo, hi, inline })
  const unbudgeted = unbudgetedQuantities(instance, { lo, hi: hi.map((value) => (value === null ? Infinity : value)) })
  const evaluate = (quantities) => evaluateReplenishmentPlan(instance, quantities, { budget })
  const plans = [{ id: 'no_order', ...evaluate(items.map(() => 0)) }]
  let optimal = null
  let binding = null
  let reasons = null
  if (solved.quantities) {
    optimal = evaluate(solved.quantities)
    plans.unshift({ id: 'optimal', ...optimal })
    const withoutBudget = unbudgeted.map((entry) => entry.withMinimum)
    const free = evaluateReplenishmentPlan(instance, withoutBudget, { budget: null })
    const budgetBinds = budget !== null && free.inSample.total < optimal.inSample.total - 1e-7
    binding = {
      budget: budget === null ? null : {
        amount: budget,
        spend: optimal.spend,
        left: budget - optimal.spend,
        binds: budgetBinds,
        ...(budgetBinds ? { withoutBudget: { quantities: withoutBudget, spend: free.spend, inSample: free.inSample, heldOut: free.heldOut } } : {}),
      },
      raisedToMinimumOrder: [],
      skippedForMinimumOrder: [],
    }
    reasons = items.map((item, index) => reasonFor({
      optimal: solved.quantities[index], unbudgeted: unbudgeted[index], budgetBinds,
      fixed: fixedSkus.has(item.sku.toLowerCase()), excluded: excluded.has(item.sku.toLowerCase()),
    }))
    reasons.forEach((reason, index) => {
      if (reason === 'raised_to_minimum_order') binding.raisedToMinimumOrder.push(items[index].sku)
      if (reason === 'minimum_order_costs_more_than_it_saves') binding.skippedForMinimumOrder.push(items[index].sku)
    })
  }
  if (includeReorderList && items.some((item) => item.reorderPoint)) plans.push({ id: 'reorder_list', ...evaluate(reorderListQuantities(items)) })
  for (const [index, candidate] of (Array.isArray(candidates) ? candidates : []).entries()) {
    const id = text(candidate?.id) || `candidate_${index + 1}`
    plans.push({ id, ...(candidate?.label ? { label: text(candidate.label) } : {}), ...evaluate(quantitiesFrom(instance, candidate?.quantities)) })
  }
  const reference = optimal ? (optimal.heldOut || optimal.inSample).total : null
  for (const plan of plans) {
    const cost = (plan.heldOut || plan.inSample).total
    plan.costAboveOptimal = reference === null ? null : cost - reference
    plan.regretInSample = optimal ? plan.inSample.total - optimal.inSample.total : null
  }
  return {
    schema: REPLENISHMENT_PLAN_SCHEMA,
    status: solved.status,
    ...(solved.reason ? { reason: solved.reason } : {}),
    ...(solved.items ? { reasonItems: solved.items } : {}),
    solver: solved.solver || null,
    parameters: { ...parameters, sources: { ...parameters.sources } },
    currency: instance.currency,
    today: instance.today,
    historyDays: instance.historyDays,
    costBasis: instance.heldOut ? 'held_out_samples' : 'in_sample',
    items: items.map((item, index) => {
      const samples = instance.D[index]
      return {
        sku: item.sku, name: item.name, unit: item.unit, supplier: item.supplier,
        unitPrice: item.unitPrice, minimumOrder: item.moq, leadTimeDays: item.leadTimeDays, cycleDays: instance.cycleDays[index],
        onHand: item.onHand, reserved: item.reserved, openRequests: item.openRequests, position: instance.positions[index],
        openLinesCounted: instance.linesCounted[index].length, openLinesDueAfterCycle: instance.linesDueAfterCycle[index].map((line) => ({ remaining: line.remaining, dueInDays: line.dueInDays, ...(line.reference ? { reference: line.reference } : {}) })),
        extraDemand: item.extraDemand,
        meanCycleDemand: samples.reduce((sum, value) => sum + value, 0) / samples.length,
        holdingCostPerUnit: instance.h[index],
        shortageCostPerUnit: instance.pi[index],
        reorderPoint: item.reorderPoint,
        newsvendorQuantity: unbudgeted[index].newsvendor,
        bestWithoutBudget: unbudgeted[index].withMinimum,
        optimalQuantity: solved.quantities ? solved.quantities[index] : null,
        reason: reasons?.[index] ?? null,
      }
    }),
    optimal: optimal ? plans.find((plan) => plan.id === 'optimal') : null,
    plans,
    binding,
  }
}

// The research log: one JSON line per call, when a path is set
// (FLOWCHAIN_REPLENISHMENT_SOLVER_LOG or the script's --log). Inputs and
// outputs in full, with a hash of the inputs so the same instance can be found
// across study arms. Never fails the call it records.
export function logReplenishmentCall(record, { path = process.env.FLOWCHAIN_REPLENISHMENT_SOLVER_LOG } = {}) {
  if (!text(path)) return false
  try {
    const inputHash = createHash('sha256').update(JSON.stringify(record.input ?? null)).digest('hex')
    appendFileSync(path, `${JSON.stringify({ at: new Date().toISOString(), inputHash, ...record })}\n`)
    return true
  } catch {
    return false
  }
}

const daysBetween = (from, to) => Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86400000)

// The solver's input from a replenishment-inputs export
// (scripts/export-replenishment-inputs.mjs, schema flowchain.replenishment-inputs.v1),
// as the prototype reads it (data.load_export): the preferred supplier's
// reference price, minimum order and lead time, stock, every open line with
// its days to due, 90 days of shipments. Items without those are listed, not
// guessed. The deployed reorder list's quantity (qRule) comes along.
export function replenishmentInputFromExport(raw) {
  if (raw?.schema !== 'flowchain.replenishment-inputs.v1') fail('Not a flowchain.replenishment-inputs.v1 export.')
  const items = []
  const skipped = []
  for (const row of raw.items || []) {
    const supplier = row.preferredSupplier || {}
    const price = supplier.referencePrice ?? row.lastPurchasePriceFromPreferredSupplier?.unitPrice ?? row.lastPurchasePrice?.unitPrice ?? null
    const missing = [
      ...(price === null ? ['unit_price'] : []),
      ...(supplier.leadTimeDays === null || supplier.leadTimeDays === undefined ? ['lead_time'] : []),
      ...(row.onHand === null || row.onHand === undefined ? ['stock'] : []),
    ]
    if (missing.length) { skipped.push({ sku: row.sku, missing }); continue }
    items.push({
      sku: row.sku, name: row.name, unit: row.unit, supplier: supplier.name || null,
      unitPrice: Number(price), moq: supplier.minimumOrderQuantity ?? 0, leadTimeDays: supplier.leadTimeDays,
      onHand: row.onHand, reserved: row.reserved ?? 0,
      openLines: (row.openPurchaseOrderLines || []).map((line) => ({ remaining: line.remaining, dueInDays: line.dueDay ? daysBetween(raw.today, line.dueDay) : null, reference: line.purchaseOrder })),
      dailyDemand: row.dailyShipped.map((day) => day.quantity),
      reorderPoint: row.reorderPoint ?? null,
    })
  }
  const deployedRule = Object.fromEntries((raw.items || []).filter((row) => row.reorderList?.qRule !== null && row.reorderList?.qRule !== undefined && items.some((item) => item.sku === row.sku)).map((row) => [row.sku, row.reorderList.qRule]))
  return { schema: REPLENISHMENT_INPUT_SCHEMA, today: raw.today, currency: raw.workspace?.currency || null, items, skipped, deployedRule }
}
