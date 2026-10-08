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
  const copy = readSource('src', 'modules', 'overview', 'todayCopy.ts')
  const service = readSource('server', 'services', 'business-read-context-service.mjs')

  assert.match(page, /\/api\/home\/overview/)
  assert.doesNotMatch(page, /\/api\/procurement\/(requests|orders|rfqs)/)
  assert.doesNotMatch(page, /risks\s*=\s*0/)
  assert.match(copy, /首页数据加载失败/)
  assert.doesNotMatch(page, /demo-data|operationsControlTower|todayCockpit/)
  assert.match(service, /repositories\.procurementRuntime/)
  assert.doesNotMatch(service, /ctx\.db|scm-demo|demo-data/)
})

test('overview evidence builders preserve module targets and export fields', () => {
  const evidence = readSource('src', 'modules', 'overview', 'overviewEvidence.ts')

  for (const moduleId of [
    'procurement:requests',
    'procurement:orders',
    'inventory:movements',
    'procurement:rfq',
    'procurement:receiving',
    'procurement:bills',
    'srm:performance',
    'master-data',
  ]) {
    assert.match(evidence, new RegExp(moduleId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  }

  for (const field of ['对象', '标题', '优先级', '模块', '证据项', '证据值', '业务原因', '建议动作']) {
    assert.match(evidence, new RegExp(field))
  }
})

test('homepage composition contains only overview work, status, the first-day checklist and recent documents', () => {
  const page = readSource('src', 'modules', 'overview', 'Page.tsx')
  const copy = readSource('src', 'modules', 'overview', 'todayCopy.ts')

  assert.match(copy, /首页概览/)
  assert.match(copy, /今日需处理/)
  assert.match(copy, /今日状态/)
  assert.match(copy, /最近单据/)
  assert.match(copy, /暂无待处理事项/)
  assert.match(copy, /暂无近期单据/)
  assert.match(copy, /设置工作区/)
  assert.match(page, /<AiSuggestionsPage\b/)
  assert.match(page, /first-run-checklist/)
  assert.doesNotMatch(page + copy, /经营预警|业务概况|采购风险|供应商风险/)
  // The page writes no Chinese of its own; its copy has both languages.
  assert.doesNotMatch(page, /[\u3400-\u9fff]/)
})
