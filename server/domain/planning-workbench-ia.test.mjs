import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { classifyRoute, ROUTE_CLASSES, isDatabaseModeWriteBlocked } from './route-classification.mjs'

const repoRoot = path.resolve(import.meta.dirname, '..', '..')

function readSource(...parts) {
  return fs.readFileSync(path.join(repoRoot, ...parts), 'utf8')
}

test('Planning workbench exposes five distinct canonical subviews', () => {
  const routes = readSource('src', 'app', 'routeRegistry.tsx')
  const forecast = readSource('src', 'modules', 'forecast', 'Page.tsx')
  const app = readSource('src', 'app', 'FlowChainApp.tsx')

  for (const routeId of ['forecast:cockpit', 'forecast:demand', 'forecast:mrp', 'forecast:replenishment', 'forecast:parameters']) {
    assert.match(routes, new RegExp(routeId))
    assert.match(forecast, new RegExp(routeId))
  }

  for (const component of ['PlanningCockpitView', 'DemandForecastView', 'MrpPlanView', 'ReplenishmentWorkbenchView', 'PlanningParametersView']) {
    assert.match(forecast, new RegExp(component))
  }

  assert.match(app, /<ForecastPanel\s+initialView=\{activeView as any\}\s+onNavigate=\{navigateTo\}\s+onReviewActionDraft=\{openActionDraftReview\}/)
  assert.match(forecast, /data-planning-view=\{activePlanningView\}/)
})

test('Planning Cockpit CTAs use internal navigation clickthroughs', () => {
  const forecast = readSource('src', 'modules', 'forecast', 'Page.tsx')
  const cockpitSection = forecast.slice(forecast.indexOf('const PlanningCockpitView'), forecast.indexOf('if (activePlanningView === "demand")'))

  assert.match(cockpitSection, /target: "forecast:demand"/)
  assert.match(cockpitSection, /target: "forecast:mrp"/)
  assert.match(cockpitSection, /target: "forecast:replenishment"/)
  assert.match(cockpitSection, /onClick=\{\(\) => onNavigate\?\.\(item\.target\)\}/)
  assert.doesNotMatch(cockpitSection, /href=/)
})

test('AI Planning actions accept canonical view ids instead of raw forecast hrefs', () => {
  const panel = readSource('src', 'modules', 'ai-assistant', 'Panel.tsx')
  const status = readSource('server', 'domain', 'ai-chat-status.mjs')

  assert.match(panel, /navigationIntentFromInternalTarget\(action\.target, \{ source: "aiAction" \}\) \|\| navigationIntentFromModule\(action\.target \|\| "overview", \{ source: "aiAction" \}\)/)
  for (const routeId of ['forecast:cockpit', 'forecast:demand', 'forecast:mrp', 'forecast:replenishment', 'forecast:parameters']) {
    assert.match(status, new RegExp(routeId))
  }
  assert.doesNotMatch(status, /target: `\/forecast/)
  assert.doesNotMatch(status, /target: '\/forecast/)
})

test('Demand Forecast stays focused on forecast quality rather than release CTA', () => {
  const forecast = readSource('src', 'modules', 'forecast', 'Page.tsx')
  const demandSection = forecast.slice(forecast.indexOf('const DemandForecastView'), forecast.indexOf('const ReconciliationTable'))

  assert.match(demandSection, /历史需求输入/)
  assert.match(demandSection, /模型对比 \(Champion \/ Challenger\)/)
  assert.match(demandSection, /需求 - 供给对账 \(S&OP\)/)
  assert.doesNotMatch(demandSection, /releaseMrpAsPr/)
  assert.doesNotMatch(demandSection, /预览 PR 草稿/)
})

test('MRP Plan view makes MRP schedule, exceptions, and BOM evidence primary', () => {
  const forecast = readSource('src', 'modules', 'forecast', 'Page.tsx')
  const mrpSection = forecast.slice(forecast.indexOf('const MrpPlanView'), forecast.indexOf('const ReplenishmentWorkbenchView'))

  assert.match(mrpSection, /MRP 例外消息/)
  assert.match(mrpSection, /MRP 净需求计划/)
  assert.match(mrpSection, /BOM 和需求来源证据/)
  assert.match(mrpSection, /计划释放只表示审阅节奏/)
  assert.match(mrpSection, /releaseMrpAsPr/)
})

test('Replenishment Workbench uses ActionDraft preview and never direct purchase request POST', () => {
  const forecast = readSource('src', 'modules', 'forecast', 'Page.tsx')
  const replenishmentSection = forecast.slice(forecast.indexOf('const ReplenishmentWorkbenchView'), forecast.indexOf('const PlanningParametersView'))

  assert.match(replenishmentSection, /仅预览动作草稿/)
  assert.match(replenishmentSection, /createRequestFromForecast/)
  assert.match(forecast, /purchase_request_draft/)
  assert.match(forecast, /onReviewActionDraft/)
  assert.doesNotMatch(forecast, /apiJson<PurchaseRequest>/)
  assert.doesNotMatch(forecast, /\/api\/purchase-requests/)
})

test('Planning Parameters exposes read-only planning assumptions', () => {
  const forecast = readSource('src', 'modules', 'forecast', 'Page.tsx')
  const paramsSection = forecast.slice(forecast.indexOf('const PlanningParametersView'), forecast.indexOf('const PlanningCockpitView'))

  for (const label of ['采购提前期', 'MOQ', '批量倍数', '安全库存', '再订货点', '优先供应商', '采购负责人', '单位成本']) {
    assert.match(paramsSection, new RegExp(label))
  }

  assert.match(paramsSection, /只读计划假设/)
})

test('Phase U.1 planning visible copy remains localized', () => {
  const forecast = readSource('src', 'modules', 'forecast', 'Page.tsx')
  const visibleForbidden = [
    'planning-priority-cockpit',
    'material-requirements-planning',
    'action-draft-replenishment-review',
    'read-only-planning-assumptions',
    'Planning risk summary',
    'Top MRP exceptions',
    'Forecast quality',
    'MRP exception',
    '查看 Demand Forecast',
    '查看 MRP Plan',
    '打开 Replenishment',
    'Lead time',
    'Batch multiple',
    'Safety stock',
    'Reorder point',
    'Preferred supplier',
    'Buyer',
    'Unit cost',
    'MRP 静态 profile',
    'forecast UI',
    'fixture/static assumptions',
  ]
  for (const text of visibleForbidden) {
    assert.doesNotMatch(forecast, new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  }
  for (const text of ['计划优先级驾驶舱', '需求预测质量', '物料需求计划', '补货草稿复核', '只读计划参数', '计划风险摘要', '重点 MRP 例外', '查看需求预测', '查看 MRP 计划', '打开补货工作台']) {
    assert.match(forecast, new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  }
})

test('Planning routes fail closed behind capability gates', () => {
  assert.equal(classifyRoute('GET', '/api/mrp-plan').classification, ROUTE_CLASSES.capabilityDisabled)
  assert.equal(classifyRoute('GET', '/api/mrp-plan').writesJson, false)

  for (const [method, pathname] of [
    ['POST', '/api/forecast-plans'],
    ['POST', '/api/sop-cycle'],
  ]) {
    assert.equal(classifyRoute(method, pathname).classification, ROUTE_CLASSES.capabilityDisabled, pathname)
    assert.equal(isDatabaseModeWriteBlocked({ persistenceMode: 'database', method, pathname }), false, pathname)
  }
  assert.equal(classifyRoute('POST', '/api/purchase-requests').classification, ROUTE_CLASSES.legacyMutation)
  assert.equal(isDatabaseModeWriteBlocked({ persistenceMode: 'database', method: 'POST', pathname: '/api/purchase-requests' }), true)
})
