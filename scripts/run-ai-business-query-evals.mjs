import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { businessQueryPlanCases } from '../tests/ai-evals/business-query-plans/cases.mjs'
import { loadEnv } from '../server/config/env.mjs'
import { buildDeterministicBusinessQueryPlan, planBusinessQuery } from '../server/domain/ai-semantic-query-planner.mjs'
import { goalDefinition } from '../server/domain/ai-business-goal-registry.mjs'
import { hasUnsupportedPlanFilters } from '../server/domain/ai-business-query-executor.mjs'

// Default: score the deterministic planner offline. With --provider, score the
// configured model planner on the same cases; that mode makes one real provider
// request per case and never prints credentials, prompts sent, or raw replies.
const providerMode = process.argv.includes('--provider')

const suppliers = [
  { tenantId: 'tenant-eval', id: 'supplier-a', name: 'Supplier A', code: 'A' },
  { tenantId: 'tenant-eval', id: 'supplier-b', name: 'Supplier B', code: 'B' },
]

function assertPlanMatches(plan, item) {
  assert.equal(plan.scope.mode, item.expectedScope, `scope ${plan.scope.mode}`)
  const windows = Array.isArray(item.expectedTimeWindow) ? item.expectedTimeWindow : [item.expectedTimeWindow]
  assert.ok(windows.includes(plan.filters.timeWindow), `time window ${plan.filters.timeWindow}`)
  // The executor also answers with a clarification when a plan asks for filters it cannot apply.
  assert.equal(plan.clarificationNeeded || hasUnsupportedPlanFilters(plan), item.expectedClarification, 'clarification')
  for (const goal of item.expectedGoals) assert.ok(plan.goals.includes(goal), `missing goal ${goal}`)
  for (const goal of item.forbiddenGoals) assert.ok(!plan.goals.includes(goal), `forbidden goal ${goal}`)
  const expectedToolSet = [...new Set(item.expectedGoals.map((goal) => goalDefinition(goal)?.tool).filter(Boolean))]
  const actualToolSet = [...new Set(plan.goals.map((goal) => goalDefinition(goal)?.tool).filter(Boolean))]
  for (const tool of expectedToolSet) assert.ok(actualToolSet.includes(tool), `missing backend tool mapping ${tool}`)
  item.expectedToolSet = expectedToolSet
}

function check(plan, item) {
  try { assertPlanMatches(plan, item); return null } catch (error) { return error.message }
}

if (!providerMode) {
  let passed = 0
  const failures = []
  for (const item of businessQueryPlanCases) {
    const reason = check(buildDeterministicBusinessQueryPlan({ message: item.prompt, suppliers, previousResult: item.previousResult }), item)
    if (reason) failures.push({ id: item.id, prompt: item.prompt, reason })
    else passed += 1
  }
  const rate = businessQueryPlanCases.length ? passed / businessQueryPlanCases.length : 0
  console.log(JSON.stringify({ total: businessQueryPlanCases.length, passed, failed: failures.length, passRate: Number((rate * 100).toFixed(2)), failures }, null, 2))
  if (failures.length) process.exitCode = 1
} else {
  // Only this explicit mode loads the ignored local provider file.
  const previous = process.env.FLOWCHAIN_DEV_LOCAL
  process.env.FLOWCHAIN_DEV_LOCAL = 'true'
  await loadEnv(resolve(import.meta.dirname, '..'))
  if (previous === undefined) delete process.env.FLOWCHAIN_DEV_LOCAL
  else process.env.FLOWCHAIN_DEV_LOCAL = previous
  const env = { ...process.env, FLOWCHAIN_ENABLE_AI_SEMANTIC_PLANNER: 'true' }

  const results = new Array(businessQueryPlanCases.length)
  let next = 0
  async function worker() {
    while (next < businessQueryPlanCases.length) {
      const index = next++
      const item = businessQueryPlanCases[index]
      const planned = await planBusinessQuery({ message: item.prompt, suppliers, previousResult: item.previousResult }, { env })
      const usedModel = planned.plannerMode === 'provider'
      results[index] = {
        id: item.id, prompt: item.prompt, usedModel, latencyMs: planned.latencyMs,
        fallbackReason: planned.fallbackReason,
        validationErrors: usedModel ? [] : (planned.validation?.errors || []).slice(0, 3),
        // What a user would get: the model plan when valid, otherwise the deterministic one.
        servedFailure: check(planned.plan, item),
      }
    }
  }
  await Promise.all(Array.from({ length: 4 }, worker))

  const modelPlanned = results.filter((item) => item.usedModel)
  const modelPassed = modelPlanned.filter((item) => !item.servedFailure)
  const fallbackReasons = {}
  for (const item of results.filter((entry) => !entry.usedModel)) fallbackReasons[item.fallbackReason] = (fallbackReasons[item.fallbackReason] || 0) + 1
  const latencies = modelPlanned.map((item) => item.latencyMs).sort((a, b) => a - b)
  const percent = (part, whole) => whole ? Number((part / whole * 100).toFixed(2)) : 0
  console.log(JSON.stringify({
    total: results.length,
    modelPlanned: modelPlanned.length,
    modelPassed: modelPassed.length,
    modelPassRate: percent(modelPassed.length, results.length),
    fallbacks: results.length - modelPlanned.length,
    fallbackReasons,
    servedPassed: results.filter((item) => !item.servedFailure).length,
    medianModelLatencyMs: latencies[Math.floor(latencies.length / 2)] ?? null,
    modelFailures: modelPlanned.filter((item) => item.servedFailure).map(({ id, prompt, servedFailure }) => ({ id, prompt, reason: servedFailure })),
    fallbackSamples: results.filter((item) => !item.usedModel).slice(0, 5).map(({ id, fallbackReason, validationErrors }) => ({ id, fallbackReason, validationErrors })),
  }, null, 2))
  if (modelPassed.length !== results.length) process.exitCode = 1
}
