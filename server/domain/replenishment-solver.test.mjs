import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { addCalendarDays } from '../../shared/purchase-request-prefill.mjs'
import {
  ReplenishmentInputError, buildReplenishmentInstance, evaluateReplenishmentPlan, inventoryPosition, logReplenishmentCall, planReplenishment,
  reorderListQuantities, replenishmentInputFromExport, solveReplenishmentMilp, unbudgetedQuantities,
} from './replenishment-solver.mjs'
import { runReplenishmentSolver } from '../../scripts/replenishment-solver.mjs'

// The post-#249 export of the local walkthrough (synthetic walkthrough data, main
// a83d07cb, reseeded 2026-11-05), in its own schema with the daily series
// written compactly; exportOf puts each day back as { day, quantity }.
const FIXTURE = JSON.parse(readFileSync(new URL('./test-fixtures/replenishment-post249-a83d07cb.json', import.meta.url), 'utf8'))
const exportOf = (fixture = FIXTURE) => ({
  ...fixture,
  items: fixture.items.map((item) => ({ ...item, dailyShipped: item.dailyShipped.map((quantity, index) => ({ day: addCalendarDays(fixture.demandWindow.firstDay, index), quantity })) })),
})
const cents = (value) => Math.round(value * 100) / 100
const heldOut = (plan) => cents(plan.heldOut.total)
const inSample = (plan) => cents(plan.inSample.total)
const byId = (result, id) => result.plans.find((plan) => plan.id === id)

// The prototype (saa.py, post_fix.py) on this export with its parameters:
// N = 200 scenarios (seed 7), R = 7 days, 25%/yr holding, shortage 5 x
// holding, B = the spend of the rule's order ($5,000), 20,000 held-out
// samples (seed 1007). The scenarios are numpy's draws, reproduced exactly,
// so every cost matches the prototype's to the cent (tolerance 0.005).
test('on the post-#249 export the solver reproduces the prototype: q* = 25 LDM-001 and its costs', async () => {
  const input = replenishmentInputFromExport(exportOf())
  assert.deepEqual(input.skipped, [])
  assert.deepEqual(input.deployedRule, { 'LDM-001': 0, 'LDM-002': 50, 'LDM-003': 0, 'LDM-004': 0, 'LDM-005': 0, 'LDM-006': 0 })
  // The reorder list after #249, worked out again from the records, is the deployed rule's order.
  assert.deepEqual(reorderListQuantities(input.items), [0, 50, 0, 0, 0, 0])
  const result = await planReplenishment(input, { budget: 5000, candidates: [{ id: 'deployed_rule', quantities: input.deployedRule }] })
  assert.equal(result.status, 'optimal')
  assert.equal(result.solver.mipGap, 0)
  assert.deepEqual(result.optimal.quantities, [25, 0, 0, 0, 0, 0])
  assert.deepEqual(result.items.map((item) => item.position), [98, 265, 1750, 40000, 7900, 200])
  // Held out (the prototype's table): no order 780.41, the rule 827.55, q* 740.50.
  assert.deepEqual([heldOut(byId(result, 'optimal')), heldOut(byId(result, 'no_order')), heldOut(byId(result, 'reorder_list')), heldOut(byId(result, 'deployed_rule'))], [740.5, 780.41, 827.55, 827.55])
  // In sample: 738.22, 776.39, 818.94; the MILP's objective is q*'s in-sample cost.
  assert.deepEqual([inSample(byId(result, 'optimal')), inSample(byId(result, 'no_order')), inSample(byId(result, 'reorder_list'))], [738.22, 776.39, 818.94])
  assert.ok(Math.abs(result.solver.objective - byId(result, 'optimal').inSample.total) < 1e-6)
  assert.equal(cents(byId(result, 'reorder_list').costAboveOptimal), 87.05)
  // Why: LDM-001's newsvendor quantity (23) is raised to its minimum of 25;
  // LDM-002's (10) is not worth a minimum order of 50; the rest are covered.
  assert.deepEqual(result.items.map((item) => [item.sku, item.newsvendorQuantity, item.bestWithoutBudget, item.reason]), [
    ['LDM-001', 23, 25, 'raised_to_minimum_order'],
    ['LDM-002', 10, 0, 'minimum_order_costs_more_than_it_saves'],
    ['LDM-003', 0, 0, 'covered'], ['LDM-004', 0, 0, 'covered'], ['LDM-005', 0, 0, 'covered'], ['LDM-006', 0, 0, 'covered'],
  ])
  assert.deepEqual(result.binding, { budget: { amount: 5000, spend: 2500, left: 2500, binds: false }, raisedToMinimumOrder: ['LDM-001'], skippedForMinimumOrder: ['LDM-002'] })
})

test('the prototype\'s scenario form and the epigraph form, and both position rules, agree on that export', async () => {
  const input = replenishmentInputFromExport(exportOf())
  const runs = await Promise.all([
    planReplenishment(input, { budget: 5000, formulation: 'scenarios', heldOutSamples: 0 }),
    planReplenishment(input, { budget: 5000, positionRule: 'due_within_cycle', heldOutSamples: 0 }),
  ])
  for (const result of runs) {
    assert.deepEqual(result.optimal.quantities, [25, 0, 0, 0, 0, 0])
    assert.equal(inSample(result.optimal), 738.22)
    assert.equal(result.costBasis, 'in_sample')
  }
  assert.ok(runs[0].solver.columns > 700 && runs[1].solver.columns < 30, 'the scenario form has u and v per demand value, the epigraph one cost per item')
})

test('same input, same output; in a worker thread or in this one', async () => {
  const input = replenishmentInputFromExport(exportOf())
  const strip = (result) => ({ ...result, solver: { ...result.solver, seconds: null } })
  const [a, b, c] = await Promise.all([planReplenishment(input, { budget: 5000 }), planReplenishment(input, { budget: 5000 }), planReplenishment(input, { budget: 5000, inline: true })])
  assert.deepEqual(strip(a), strip(b))
  assert.deepEqual(strip(a), strip(c))
})

// Small cases worked out by hand. Constant daily demand makes every scenario
// the same, so the costs are exact: h = 25% x price x cycle days / 365,
// pi = 5 h.
const steady = (sku, { price, daily, lead, onHand = 0, moq = 0, openLines = [], openRequests = 0, reorderPoint = null }) => ({
  sku, unitPrice: price, moq, leadTimeDays: lead, onHand, reserved: 0, openLines, openRequests, reorderPoint, dailyDemand: Array(90).fill(daily),
})
const holding = (price, days) => 0.25 * price * days / 365

test('a budget that binds goes first to the item that saves the most per dollar', async () => {
  // A: $10, 10 a day, 14 days' lead (21-day cycle, needs 210). B: $20, 5 a
  // day, no lead (7-day cycle, needs 35). Short a unit, A loses
  // 5 x 0.25 x 21 / 365 of its price, B 5 x 0.25 x 7 / 365: A comes first.
  const items = [steady('A', { price: 10, daily: 10, lead: 14 }), steady('B', { price: 20, daily: 5, lead: 0 })]
  const free = await planReplenishment({ items }, { heldOutSamples: 0 })
  assert.deepEqual(free.optimal.quantities, [210, 35])
  assert.equal(cents(free.optimal.inSample.total), 0)
  const tight = await planReplenishment({ items }, { budget: 2500, heldOutSamples: 0 })
  // $2,100 on A's 210, the $400 left buys 20 of B's 35: 15 short.
  assert.deepEqual(tight.optimal.quantities, [210, 20])
  assert.ok(Math.abs(tight.optimal.inSample.total - 15 * 5 * holding(20, 7)) < 1e-9)
  assert.deepEqual(tight.items.map((item) => item.reason), ['ordered', 'cut_by_budget'])
  assert.equal(tight.binding.budget.binds, true)
  assert.deepEqual(tight.binding.budget.withoutBudget.quantities, [210, 35])
  assert.equal(tight.binding.budget.left, 0)
})

test('a minimum order that costs more than it saves is skipped; a cheaper one is raised to', async () => {
  // 5 a day over a 14-day cycle is 70; 60 on hand leaves 10 short (10 x 5 h
  // = 50 h). A minimum of 100 leaves 90 over (90 h): skip. Of 50, 40 over (40 h): order it.
  const h = holding(10, 14)
  const skip = await planReplenishment({ items: [steady('C', { price: 10, daily: 5, lead: 7, onHand: 60, moq: 100 })] }, { heldOutSamples: 0 })
  assert.deepEqual([skip.optimal.quantities, skip.items[0].reason, skip.binding.skippedForMinimumOrder], [[0], 'minimum_order_costs_more_than_it_saves', ['C']])
  assert.ok(Math.abs(skip.optimal.inSample.total - 50 * h) < 1e-9)
  const raise = await planReplenishment({ items: [steady('C', { price: 10, daily: 5, lead: 7, onHand: 60, moq: 50 })] }, { heldOutSamples: 0 })
  assert.deepEqual([raise.optimal.quantities, raise.items[0].reason, raise.binding.raisedToMinimumOrder], [[50], 'raised_to_minimum_order', ['C']])
  assert.ok(Math.abs(raise.optimal.inSample.total - 40 * h) < 1e-9)
})

test('a plan no budget can pay for is infeasible, with the reason; candidate plans say what is wrong with them', async () => {
  const items = [steady('A', { price: 10, daily: 10, lead: 14 }), steady('C', { price: 10, daily: 5, lead: 7, onHand: 60, moq: 100 })]
  const over = await planReplenishment({ items }, { budget: 1000, fixed: { A: 210 }, heldOutSamples: 0 })
  assert.deepEqual([over.status, over.reason, over.optimal], ['infeasible', 'fixed_lines_exceed_budget', null])
  // Ordering nothing is still costed, so the answer can compare.
  assert.ok(byId(over, 'no_order').inSample.total > 0)
  assert.equal((await planReplenishment({ items }, { budget: -1, heldOutSamples: 0 })).reason, 'negative_budget')
  const below = await planReplenishment({ items }, { fixed: { C: 40 }, heldOutSamples: 0 })
  assert.deepEqual([below.status, below.reason, below.reasonItems], ['infeasible', 'fixed_below_minimum_order', ['C']])
  // A fixed line and a left-out item: the rest is planned around them.
  const kept = await planReplenishment({ items }, { budget: 3000, fixed: { C: 100 }, exclude: ['a'], heldOutSamples: 0 })
  assert.deepEqual([kept.optimal.quantities, kept.items.map((item) => item.reason)], [[0, 100], ['left_out_by_user', 'fixed_by_user']])
  const judged = await planReplenishment({ items }, { budget: 1000, heldOutSamples: 0, candidates: [{ id: 'yours', quantities: { A: 150.5, C: 40 } }] })
  assert.deepEqual(byId(judged, 'yours').issues.map((issue) => [issue.sku || null, issue.code]), [['A', 'not_whole_units'], ['C', 'below_minimum_order'], [null, 'over_budget']])
  assert.equal(byId(judged, 'yours').feasible, false)
  await assert.rejects(planReplenishment({ items }, { candidates: [{ quantities: { NOPE: 1 } }] }), ReplenishmentInputError)
  await assert.rejects(planReplenishment({ items: [{ ...items[0], unitPrice: 0 }] }), /unitPrice/)
})

test('the position counts every open line and open request; the single-cycle rule leaves out lines due after the cycle', () => {
  const item = { onHand: 10, reserved: 2, openRequests: 5, openLines: [{ remaining: 4, dueInDays: -3 }, { remaining: 6, dueInDays: 30 }, { remaining: 1, dueInDays: null }] }
  assert.equal(inventoryPosition(item, 14).position, 24)
  const cycle = inventoryPosition(item, 14, 'due_within_cycle')
  assert.equal(cycle.position, 18)
  assert.deepEqual(cycle.dueAfterCycle, [{ remaining: 6, dueInDays: 30 }])
  // The reorder list counts open purchase order lines only, not requests.
  assert.deepEqual(reorderListQuantities([{ ...item, moq: 25, reorderPoint: 30 }]), [25])
  const instance = buildReplenishmentInstance({ items: [steady('A', { price: 10, daily: 10, lead: 7, onHand: 50, openRequests: 30, openLines: [{ remaining: 20, dueInDays: 40 }] })] }, { heldOutSamples: 0 })
  assert.equal(instance.positions[0], 100)
  assert.equal(instance.linesDueAfterCycle[0].length, 1)
})

test('without a budget the MILP finds each item\'s own best order, the newsvendor quantity within its minimum', async () => {
  const input = replenishmentInputFromExport(exportOf())
  const instance = buildReplenishmentInstance(input, { heldOutSamples: 0, serviceLevelPercent: 95 })
  assert.ok(Math.abs(instance.parameters.shortageCostMultiple - 19) < 1e-9)
  const solved = await solveReplenishmentMilp(instance, { budget: null })
  assert.deepEqual(solved.quantities, unbudgetedQuantities(instance).map((entry) => entry.withMinimum))
  const cost = (quantities) => evaluateReplenishmentPlan(instance, quantities).inSample.total
  // Any one-unit move away from it costs more (or the same).
  solved.quantities.forEach((quantity, index) => {
    for (const step of [-1, 1]) {
      const moved = [...solved.quantities]
      moved[index] = quantity + step
      if (moved[index] >= Math.max(1, instance.minimum[index]) || moved[index] === 0) assert.ok(cost(moved) >= cost(solved.quantities) - 1e-9, `${instance.items[index].sku} ${moved[index]}`)
    }
  })
})

test('each call can be logged as one JSON line, and the study script runs the same solver on an export', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'replenishment-solver-'))
  try {
    const log = join(folder, 'calls.jsonl')
    assert.equal(logReplenishmentCall({ caller: 'test', input: { a: 1 }, result: { ok: true } }, { path: log }), true)
    assert.equal(logReplenishmentCall({ caller: 'test' }, { path: '' }), false)
    const file = join(folder, 'export.json')
    writeFileSync(file, JSON.stringify(exportOf()))
    const run = await runReplenishmentSolver([file, '--budget=rule', '--plan=LDM-002:40', '--label=or_alone', `--log=${log}`], { env: {} })
    assert.equal(run.options.budget, 5000)
    assert.deepEqual(run.plan.optimal.quantities, [25, 0, 0, 0, 0, 0])
    assert.deepEqual(byId(run.plan, 'given_plan').issues.map((issue) => issue.code), ['below_minimum_order'])
    assert.equal(heldOut(byId(run.plan, 'deployed_rule')), 827.55)
    // LLM-estimated parameters on top of the export: a known extra order of 20 LDM-001.
    const params = join(folder, 'llm.json')
    writeFileSync(params, JSON.stringify({ parameters: { holdingRatePercent: 25 }, items: { 'LDM-001': { extraDemand: 20 } } }))
    const informed = await runReplenishmentSolver([file, '--budget=5000', `--params=${params}`, `--log=${log}`], { env: {} })
    assert.ok(informed.plan.optimal.quantities[0] > 25)
    const lines = readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
    assert.deepEqual(lines.map((line) => [line.caller, line.label ?? null]), [['test', null], ['script', 'or_alone'], ['script', null]])
    assert.match(lines[1].inputHash, /^[0-9a-f]{64}$/)
    assert.notEqual(lines[1].inputHash, lines[2].inputHash)
    assert.deepEqual(lines[1].result.optimal.quantities, [25, 0, 0, 0, 0, 0])
  } finally {
    rmSync(folder, { recursive: true, force: true })
  }
})
