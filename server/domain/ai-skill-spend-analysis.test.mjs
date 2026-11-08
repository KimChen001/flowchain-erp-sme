import test from 'node:test'
import assert from 'node:assert/strict'
import { aiSkillScenario } from './test-fixtures/ai-skill-scenario.mjs'
import { loadAiSkillContext } from './ai-skill-context.mjs'
import { readAiSkillFacts } from './ai-skill-readers.mjs'
import { aiSkillSpendPeriod } from './ai-skill-spend-analysis.mjs'

// The procurement dashboard's report for the same scenario: what the answer
// must show.
async function dashboard(filters = {}, roleKey) {
  const scenario = aiSkillScenario(roleKey ? { roleKey } : {})
  const facts = await readAiSkillFacts(await loadAiSkillContext(scenario.ctx))
  const report = facts.procurementReport(filters)
  return { facts, report, chart: (id) => report.charts.find((row) => row.id === id), kpi: report.kpis.find((row) => row.id === 'purchase_order_amount') }
}

test('periods are the dashboard\'s from and to days, counted from the workspace\'s today', () => {
  const today = '2026-09-29'
  assert.equal(aiSkillSpendPeriod(null, today), null)
  assert.deepEqual(aiSkillSpendPeriod({ kind: 'this_month' }, today), { from: '2026-09-01', to: '2026-09-29' })
  assert.deepEqual(aiSkillSpendPeriod({ kind: 'last_month' }, today), { from: '2026-08-01', to: '2026-08-31' })
  assert.deepEqual(aiSkillSpendPeriod({ kind: 'this_quarter' }, today), { from: '2026-07-01', to: '2026-09-29' })
  assert.deepEqual(aiSkillSpendPeriod({ kind: 'last_quarter' }, today), { from: '2026-04-01', to: '2026-06-30' })
  assert.deepEqual(aiSkillSpendPeriod({ kind: 'last_quarter' }, '2026-02-10'), { from: '2025-10-01', to: '2025-12-31' })
  assert.deepEqual(aiSkillSpendPeriod({ kind: 'this_year' }, today), { from: '2026-01-01', to: '2026-09-29' })
  assert.deepEqual(aiSkillSpendPeriod({ kind: 'last_year' }, today), { from: '2025-01-01', to: '2025-12-31' })
  assert.deepEqual(aiSkillSpendPeriod({ kind: 'year', year: 2026 }, today), { from: '2026-01-01', to: '2026-09-29' })
  assert.deepEqual(aiSkillSpendPeriod({ kind: 'last_days', days: 30 }, today), { from: '2026-08-31', to: '2026-09-29' })
})

