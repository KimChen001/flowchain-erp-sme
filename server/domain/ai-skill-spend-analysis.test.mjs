import test from 'node:test'
import assert from 'node:assert/strict'
import { aiSkillScenario } from './test-fixtures/ai-skill-scenario.mjs'
import { loadAiSkillContext } from './ai-skill-context.mjs'
import { readAiSkillFacts } from './ai-skill-readers.mjs'
import { aiSkillSpendPeriod } from './ai-skill-spend-analysis.mjs'
import { aiSkillSpendSignals, routeSkill } from './ai-skill-router.mjs'
import { toolsFor } from './ai-skills.mjs'
import { handleAiRuntimeGatewayRoute } from '../routes/ai-runtime-gateway.routes.mjs'

// A production-shaped route context, as in ai-skill-follow-up.test.mjs.
function harness({ roleKey, env = { FLOWCHAIN_PERSISTENCE_MODE: 'database' }, provider = null } = {}) {
  const scenario = aiSkillScenario(roleKey ? { roleKey } : {})
  const sent = []
  const audits = []
  const plans = []
  const ctx = {
    ...scenario.ctx,
    req: { method: 'POST', headers: {} }, res: {}, url: new URL('http://local/api/ai-runtime/respond'),
    db: { __dataMode: 'user', purchaseOrders: [], products: [], suppliers: [] },
    env,
    send: (_res, status, payload) => sent.push({ status, payload }),
    ...(provider ? { aiAgentProvider: async (input) => { plans.push(input); return provider(input) } } : {}),
    aiAgentKnowledge: null,
  }
  ctx.repositories = { ...ctx.repositories, auditLog: { mode: 'database', recordAuditEntry: async (entry) => { audits.push(entry); return entry } } }
  const ask = async (message, answerLanguage = 'en-US') => {
    ctx.readBody = async () => ({ message, answerLanguage })
    assert.equal(await handleAiRuntimeGatewayRoute(ctx), true)
    return sent.at(-1).payload
  }
  return { ask, audits, plans, scenario }
}

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

test('top suppliers show the dashboard\'s figures, one currency at a time', async () => {
  const { ask } = harness()
  const answer = await ask('Which suppliers do we spend the most with?')
  assert.equal(answer.intent, 'spend_analysis')
  // Orders are in USD and EUR: the dashboard counts them unless a currency is
  // chosen, so the answer is in the workspace's USD, as the USD filter shows.
  const all = await dashboard()
  assert.deepEqual(all.chart('procurement_spend_treemap').limitations, ['multi_currency_unconverted'])
  const usd = await dashboard({ currency: 'USD' })
  const rows = usd.chart('procurement_spend_treemap').data
  const money = (value) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(value)
  assert.deepEqual(answer.keyEvidence.map((item) => [item.entityLabel, item.value]), rows.map((row) => [row.name, money(row.value)]))
  assert.ok(answer.conclusion.title.startsWith(`${money(usd.kpi.currentValue)} of committed spend across 2 suppliers`), answer.conclusion.title)
  assert.match(answer.conclusion.summary, /not added in: €500\.00/)
  // The figures it states, by supplier id.
  assert.deepEqual(answer.figures.map((row) => [row.code, row.entityId, row.value, row.unit]), [['spend_total', null, usd.kpi.currentValue, 'USD'], ['spend', 'SUP-001', rows[0].value, 'USD'], ['spend', 'SUP-002', rows[1].value, 'USD']])
  assert.ok(answer.navigationLinks.some((link) => link.moduleId === 'reports:procurement'))
  // Asked in EUR: the EUR filter's figures.
  const eur = await ask('How much did we spend in EUR?')
  const eurRows = (await dashboard({ currency: 'EUR' })).chart('procurement_spend_treemap').data
  assert.deepEqual(eur.keyEvidence.map((item) => item.entityLabel), eurRows.map((row) => row.name))
  assert.match(eur.conclusion.title, /€500\.00/)
})

test('what we buy from a supplier is the dashboard\'s item breakdown for it', async () => {
  const { ask } = harness()
  const answer = await ask('What do we buy from Acme Components?')
  const usd = await dashboard({ currency: 'USD' })
  const items = usd.chart('procurement_spend_treemap').breakdown['Acme Components']
  assert.equal(answer.keyEvidence[0].entityId, 'SUP-001')
  assert.deepEqual(answer.keyEvidence.slice(1).map((item) => item.entityLabel), items.map((row) => row.name))
  assert.match(answer.conclusion.summary, /net line values/)
  const zh = await ask('我们从 Acme Components 买了什么？', 'zh-CN')
  assert.equal(zh.language, 'zh-CN')
  assert.match(zh.conclusion.title, /^Acme Components：已承诺采购/)
})

test('the monthly trend is the dashboard\'s, and a period narrows it as the dashboard\'s dates do', async () => {
  const { ask } = harness()
  const trend = await ask('Spend trend by month')
  const months = (await dashboard({ currency: 'USD' })).chart('procurement_spend_trend').data.filter((row) => row.name !== 'Undated')
  assert.deepEqual(trend.keyEvidence.map((item) => item.entityLabel), months.map((row) => row.name))
  const month = await ask('How much have we spent this month?')
  const september = await dashboard({ from: '2026-09-01', to: '2026-09-29', currency: 'USD' })
  assert.deepEqual(month.keyEvidence.map((item) => item.entityLabel), september.chart('procurement_spend_treemap').data.map((row) => row.name))
  assert.match(month.conclusion.title, /Sep 1, 2026 – Sep 29, 2026/)
})

test('without access to prices the answer counts orders, as the dashboard does', async () => {
  const { ask } = harness({ roleKey: 'read-only-viewer' })
  const answer = await ask('Which suppliers do we spend the most with?')
  assert.equal(answer.intent, 'spend_analysis')
  const counted = (await dashboard({}, 'read-only-viewer')).chart('procurement_spend_treemap')
  assert.deepEqual(counted.limitations, ['amount_restricted'])
  assert.deepEqual(answer.keyEvidence.map((item) => item.value), counted.data.map((row) => `${row.value} purchase orders`))
  assert.match(answer.conclusion.summary, /does not show purchase prices/)
  assert.doesNotMatch(JSON.stringify(answer), /\$|€|12,920|17,920/)
})

test('a role that cannot read purchase orders is not offered the spend analysis', async () => {
  assert.ok(!toolsFor(aiSkillScenario({ roleKey: 'finance-specialist' }).actor).some((entry) => entry.id === 'spend_analysis'))
  const { ask } = harness({ roleKey: 'finance-specialist' })
  const answer = await ask('Which suppliers do we spend the most with?')
  assert.notEqual(answer.intent, 'spend_analysis')
  assert.doesNotMatch(JSON.stringify(answer.keyEvidence || []), /12,920|17,920/)
})

test('the planner may call the spend analysis with a view; the period comes from the question', async () => {
  const env = {
    FLOWCHAIN_PERSISTENCE_MODE: 'database', FLOWCHAIN_AI_AGENT_MODE: 'plan', FLOWCHAIN_AI_RUNTIME_MODE: 'provider_assisted', FLOWCHAIN_AI_PROVIDER_KIND: 'parley_chat',
    FLOWCHAIN_AI_PROVIDER_ENDPOINT: 'http://127.0.0.1:9/spend-test', FLOWCHAIN_AI_PROVIDER_API_KEY: 'placeholder', FLOWCHAIN_AI_PROVIDER_MODEL: 'placeholder-model', FLOWCHAIN_AI_AGENT_TIMEOUT_MS: '150',
  }
  const provider = () => ({ ok: true, toolCalls: [{ name: 'spend_analysis', arguments: JSON.stringify({ mode: 'trend' }) }] })
  const run = harness({ env, provider })
  const answer = await run.ask('show me where our purchasing money went over time this year')
  assert.equal(run.plans.length, 1)
  assert.ok(run.plans[0].tools.some((tool) => tool.function.name === 'spend_analysis' && tool.function.parameters.properties.mode.enum.includes('trend')))
  assert.equal(answer.intent, 'spend_analysis')
  assert.match(answer.conclusion.title, /^Committed spend by month/)
  assert.match(answer.conclusion.title, /Jan 1, 2026 – Sep 29, 2026/)
})
