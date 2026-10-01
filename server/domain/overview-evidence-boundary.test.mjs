import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const repoRoot = path.resolve(import.meta.dirname, '..', '..')

function readSource(...parts) {
  return fs.readFileSync(path.join(repoRoot, ...parts), 'utf8')
}

test('homepage reads one server-derived BusinessReadContext overview', () => {
  const page = readSource('src', 'modules', 'overview', 'Page.tsx')
  const service = readSource('server', 'services', 'business-read-context-service.mjs')

  assert.match(page, /\/api\/home\/overview/)
  assert.doesNotMatch(page, /\/api\/procurement\/(requests|orders|rfqs)/)
  assert.doesNotMatch(page, /risks\s*=\s*0/)
  assert.match(page, /首页数据加载失败/)
  assert.doesNotMatch(page, /demo-data|operationsControlTower|todayCockpit/)
  assert.match(service, /repositories\.procurementRuntime/)
  assert.doesNotMatch(service, /ctx\.db|scm-demo|demo-data/)
})

test('homepage composition contains only overview work status and recent documents', () => {
  const page = readSource('src', 'modules', 'overview', 'Page.tsx')

  assert.match(page, /首页概览/)
  assert.match(page, /今日需处理/)
  assert.match(page, /今日状态/)
  assert.match(page, /最近单据/)
  assert.match(page, /暂无待处理事项/)
  assert.match(page, /暂无近期单据/)
  assert.match(page, /<AiSuggestionsPage\b/)
  assert.doesNotMatch(page, /经营预警|业务概况|采购风险|供应商风险/)
})
