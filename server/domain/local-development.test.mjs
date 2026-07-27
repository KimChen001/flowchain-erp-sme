import assert from 'node:assert/strict'
import test from 'node:test'
import { assertLocalDevelopment, isLocalDatabaseUrl, localDevelopmentEnabled, localPostgresTestHarnessEnabled } from './local-development-contract.mjs'
import { localCommandPlan, parseEnvFile } from '../../scripts/dev-local.mjs'
import { buildAiRuntimeResponseV2, buildAiRuntimeSafeFallbackV2 } from './ai-runtime-gateway-v2.mjs'
import { buildGovernedReport } from './report-semantic-layer.mjs'

test('local development requires explicit development mode and localhost PostgreSQL', () => {
  const env = { NODE_ENV: 'development', FLOWCHAIN_DEV_LOCAL: 'true', DATABASE_URL: 'postgresql://flowchain:secret@127.0.0.1:5432/flowchain_54b1' }
  assert.equal(isLocalDatabaseUrl(env.DATABASE_URL), true)
  assert.equal(localDevelopmentEnabled(env), true)
  assert.doesNotThrow(() => assertLocalDevelopment(env))
  assert.throws(() => assertLocalDevelopment({ ...env, DATABASE_URL: '' }), /DATABASE_URL is required/)
  assert.throws(() => assertLocalDevelopment({ ...env, NODE_ENV: 'production' }), /controlled local development/)
  assert.throws(() => assertLocalDevelopment({ ...env, DATABASE_URL: 'postgresql://flowchain:secret@db.example.com:5432/flowchain' }), /explicit localhost PostgreSQL test harness/)
  const harness = { NODE_ENV: 'test', FLOWCHAIN_REQUIRE_REAL_POSTGRES_TESTS: 'true', DATABASE_URL: env.DATABASE_URL }
  assert.equal(localPostgresTestHarnessEnabled(harness), true)
  assert.doesNotThrow(() => assertLocalDevelopment(harness, 'test harness'))
  assert.throws(() => assertLocalDevelopment({ ...harness, FLOWCHAIN_REQUIRE_REAL_POSTGRES_TESTS: 'false' }), /controlled local development/)
})

test('dev:local parses environment and scenario implies demo', () => {
  assert.deepEqual(parseEnvFile('NODE_ENV=development\n# comment\nSCM_API_PORT=8787\n'), { NODE_ENV: 'development', SCM_API_PORT: '8787' })
  assert.deepEqual(localCommandPlan(['--scenario']), { demo: true, scenario: true, setupCommands: ['db:generate', 'db:migrate:deploy', 'pilot:setup'] })
})

test('AI empty data reports zero real evidence and never high confidence', () => {
  const { body: result } = buildAiRuntimeResponseV2({}, { message: '有哪些供应商和采购订单需要关注？', activeModuleId: 'overview' })
  assert.equal(result.realEvidenceCount, 0)
  assert.equal(result.keyEvidence.length, 0)
  assert.equal(result.conclusion.confidence, 'low')
  assert.match(result.conclusion.summary, /没有可核验的供应商、SKU、采购订单/)
  assert.equal(result.reviewCards.length, 0)
})

test('AI safe fallback distinguishes system context from real evidence', () => {
  const result = buildAiRuntimeSafeFallbackV2({ message: '查看当前情况' })
  assert.equal(result.realEvidenceCount, 0)
  assert.equal(result.keyEvidence.length, 0)
  assert.ok(result.contextCardCount > 0)
  assert.equal(result.conclusion.confidence, 'low')
})

test('governed report applies supported Top N values and distinguishes no records from numeric zero', () => {
  const purchaseOrders = Array.from({ length: 25 }, (_, index) => ({
    id: `PO-${index + 1}`,
    createdAt: '2026-06-01',
    supplierName: `Supplier ${String(index + 1).padStart(2, '0')}`,
    totalAmount: 25 - index,
    currency: 'CNY',
    status: index === 0 ? 'closed' : 'open',
  }))
  for (const topN of [5, 10, 20]) {
    const report = buildGovernedReport({ purchaseOrders }, { subject: 'procurement', topN, comparison: 'none' })
    assert.equal(report.charts.find((chart) => chart.id === 'procurement_supplier_top').data.length, topN)
  }
  const empty = buildGovernedReport({}, { subject: 'procurement', comparison: 'none' })
  assert.equal(empty.kpis.find((metric) => metric.id === 'purchase_order_amount').dataStatus, 'no_records')
  const zero = buildGovernedReport({ purchaseOrders: [{ id: 'PO-ZERO', createdAt: '2026-06-01', totalAmount: 0, status: 'closed' }] }, { subject: 'procurement', comparison: 'none' })
  assert.equal(zero.kpis.find((metric) => metric.id === 'purchase_order_amount').dataStatus, 'numeric_zero')
})
