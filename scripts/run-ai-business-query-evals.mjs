import assert from 'node:assert/strict'
import { businessQueryPlanCases } from '../tests/ai-evals/business-query-plans/cases.mjs'
import { buildDeterministicBusinessQueryPlan } from '../server/domain/ai-semantic-query-planner.mjs'
import { goalDefinition } from '../server/domain/ai-business-goal-registry.mjs'

const suppliers = [
  { tenantId: 'tenant-eval', id: 'supplier-a', name: 'Supplier A', code: 'A' },
  { tenantId: 'tenant-eval', id: 'supplier-b', name: 'Supplier B', code: 'B' },
]

let passed = 0
const failures = []
for (const item of businessQueryPlanCases) {
  try {
    const plan = buildDeterministicBusinessQueryPlan({ message: item.prompt, suppliers, previousResult: item.previousResult })
    assert.equal(plan.scope.mode, item.expectedScope, 'scope')
    const windows = Array.isArray(item.expectedTimeWindow) ? item.expectedTimeWindow : [item.expectedTimeWindow]
    assert.ok(windows.includes(plan.filters.timeWindow), `time window ${plan.filters.timeWindow}`)
    assert.equal(plan.clarificationNeeded, item.expectedClarification, 'clarification')
    for (const goal of item.expectedGoals) assert.ok(plan.goals.includes(goal), `missing goal ${goal}`)
    for (const goal of item.forbiddenGoals) assert.ok(!plan.goals.includes(goal), `forbidden goal ${goal}`)
    const expectedToolSet = [...new Set(item.expectedGoals.map((goal) => goalDefinition(goal)?.tool).filter(Boolean))]
    const actualToolSet = [...new Set(plan.goals.map((goal) => goalDefinition(goal)?.tool).filter(Boolean))]
    for (const tool of expectedToolSet) assert.ok(actualToolSet.includes(tool), `missing backend tool mapping ${tool}`)
    item.expectedToolSet = expectedToolSet
    passed += 1
  } catch (error) {
    failures.push({ id: item.id, prompt: item.prompt, reason: error.message })
  }
}

const rate = businessQueryPlanCases.length ? passed / businessQueryPlanCases.length : 0
console.log(JSON.stringify({ total: businessQueryPlanCases.length, passed, failed: failures.length, passRate: Number((rate * 100).toFixed(2)), failures }, null, 2))
if (failures.length) process.exitCode = 1
