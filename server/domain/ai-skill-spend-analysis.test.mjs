import test from 'node:test'
import assert from 'node:assert/strict'
import { aiSkillScenario } from './test-fixtures/ai-skill-scenario.mjs'
import { loadAiSkillContext } from './ai-skill-context.mjs'
import { readAiSkillFacts } from './ai-skill-readers.mjs'
import { aiSkillSpendPeriod } from './ai-skill-spend-analysis.mjs'
import { aiSkillSpendSignals, routeSkill } from './ai-skill-router.mjs'
import { toolsFor } from './ai-skill-registry.mjs'
import { handleAiRuntimeGatewayRoute } from '../routes/ai-runtime-gateway.routes.mjs'

// The procurement dashboard's report for the same scenario: what the answer
// must show.
async function dashboard(filters = {}, roleKey) {
  const scenario = aiSkillScenario(roleKey ? { roleKey } : {})
  const facts = await readAiSkillFacts(await loadAiSkillContext(scenario.ctx))
  const report = facts.procurementReport(filters)
  return { facts, report, chart: (id) => report.charts.find((row) => row.id === id), kpi: report.kpis.find((row) => row.id === 'purchase_order_amount') }
}

test('spend questions route to the spend analysis; a plain total stays with the metrics', () => {
  const route = (message) => routeSkill({ message })?.skillId || null
  for (const message of ['Which suppliers do we spend the most with?', 'Who are our top 5 suppliers?', 'How much did we spend with Acme Components?', 'What do we buy from Acme Components?', 'Spend trend by month', 'How much have we spent this year?', 'How much did we spend in EUR?', '我们在哪家供应商花得最多？', '今年采购金额多少？', '我们从 Acme Components 买了什么？', '每月采购花费趋势', '采购金额按供应商分布']) {
    assert.equal(route(message), 'spend_analysis', message)
  }
  for (const message of ['What is our total committed spend?', '现在已承诺的采购金额是多少', 'What is our total committed spend on open orders?']) assert.equal(route(message), 'workspace_metrics', message)
  for (const message of ['Which suppliers need attention?', 'Which suppliers are late on deliveries?', 'top suppliers by on-time delivery', 'How much did we pay Acme?']) assert.notEqual(route(message), 'spend_analysis', message)
  assert.deepEqual(aiSkillSpendSignals('Spend trend by month this year'), { mode: 'trend', period: { kind: 'this_year' }, currency: null })
  assert.deepEqual(aiSkillSpendSignals('What do we buy from Acme in EUR?'), { mode: 'items', period: null, currency: 'EUR' })
  assert.deepEqual(aiSkillSpendSignals('最近30天在 Acme 花了多少钱'), { mode: 'suppliers', period: { kind: 'last_days', days: 30 }, currency: null })
  assert.deepEqual(aiSkillSpendSignals('2025 年人民币采购额').period, { kind: 'year', year: 2025 })
  assert.equal(aiSkillSpendSignals('2025 年人民币采购额').currency, 'CNY')
})

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

