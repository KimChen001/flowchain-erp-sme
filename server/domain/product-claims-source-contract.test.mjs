import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { capabilityFor } from './capability-registry.mjs'

const appSource = fs.readFileSync(path.resolve(import.meta.dirname, '..', '..', 'src', 'app', 'FlowChainApp.tsx'), 'utf8')

test('application shell has no fixed notification count or fixture notification center', () => {
  assert.doesNotMatch(appSource, /unreadCount/)
  assert.doesNotMatch(appSource, /notification(?:s|Items)\s*=\s*\[/i)
  assert.match(appSource, /disabled\s+aria-label=\{language === 'en-US' \? 'Notifications unavailable' : '通知中心尚未接入'\}/)
})

test('login product claims match current finance capability boundary', () => {
  assert.doesNotMatch(appSource, /统一支撑[^。]*结算管理/)
  assert.doesNotMatch(appSource, /会计净利润|完整财务闭环/)
  assert.match(appSource, /当前连接基础资料、采购、销售、库存、经营分析和运营财务/)
  assert.match(appSource, /付款、收款、退款、税务与总账执行尚未启用/)
  const finance = capabilityFor('finance')
  assert.equal(finance.maturity, 'beta')
  assert.equal(finance.enabled, false)
  assert.equal(finance.databaseOnly, true)
  assert.equal(finance.requiresExplicitEnable, true)
  assert.match(finance.reason, /without payment, collection, refund, FX, tax filing, or general-ledger execution/)
})
