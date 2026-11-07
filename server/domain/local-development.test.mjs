import assert from 'node:assert/strict'
import test from 'node:test'
import { assertLocalDevelopment, isLocalDatabaseUrl, localDevelopmentEnabled, localPostgresTestHarnessEnabled } from './local-development-contract.mjs'
import { localCommandPlan, localRuntimePorts, parseEnvFile } from '../../scripts/dev-local.mjs'
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

test('dev:local parses environment and the public data option', () => {
  assert.deepEqual(parseEnvFile('NODE_ENV=development\n# comment\nSCM_API_PORT=8787\n'), { NODE_ENV: 'development', SCM_API_PORT: '8787' })
  const setupCommands = ['db:generate', 'db:migrate:deploy', 'pilot:setup']
  assert.deepEqual(localCommandPlan([]), { publicData: null, setupCommands })
  assert.deepEqual(localCommandPlan(['--public-data']), { publicData: 'm5', setupCommands })
  assert.deepEqual(localCommandPlan(['--public-data=uci']), { publicData: 'uci', setupCommands })
  assert.throws(() => localCommandPlan(['--public-data=other']), /m5 or uci/)
  assert.deepEqual(localRuntimePorts({ SCM_API_PORT: '8791', VITE_PORT: '5174' }), {
    apiPort: 8791,
    frontendPort: 5174,
    apiProxyTarget: 'http://127.0.0.1:8791',
  })
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
