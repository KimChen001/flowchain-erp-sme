import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const repoRoot = path.resolve(import.meta.dirname, '..', '..')

function readSource(...parts) {
  return fs.readFileSync(path.join(repoRoot, ...parts), 'utf8')
}

test('inventory replenishment enters canonical PR form without auto-submit or legacy preview', () => {
  const app = readSource('src', 'app', 'FlowChainApp.tsx')
  const inventory = readSource('src', 'modules', 'inventory', 'Page.tsx')

  assert.match(app, /\/api\/action-drafts\/preview/)
  assert.doesNotMatch(app, /ReplenishmentRequestModal|inventoryItems|supplierRecommendation/)
  assert.match(inventory, /<EntityLink kind="item"/)
  assert.doesNotMatch(inventory, /\/api\/master-data\/items\/.*\/suppliers/)
  assert.doesNotMatch(inventory, /维护供应商关系/)
  assert.doesNotMatch(inventory, /预览 PR|预览 RFQ|demo-data|inventoryReadFallbackScopes/)
  assert.doesNotMatch(inventory, /submit|purchase_request_draft|rfq_draft/)
})

test('Today Cockpit maps reviewable actions to supported draft previews with fallback copy', () => {
  const cockpit = readSource('src', 'modules', 'overview', 'TodayCockpitPanel.tsx')

  assert.match(cockpit, /function actionDraftRequest/)
  assert.match(cockpit, /purchase_request_draft/)
  assert.match(cockpit, /rfq_draft/)
  assert.match(cockpit, /po_followup_draft/)
  assert.match(cockpit, /supplier_followup_draft/)
  assert.match(cockpit, /当前动作需要人工复核，尚未接入草稿预览。/)
  assert.doesNotMatch(cockpit, /\/api\/purchase-requests/)
  assert.doesNotMatch(cockpit, /JSON\.stringify/)
})

test('Forecast MRP release opens purchase request draft preview instead of creating purchase requests', () => {
  const app = readSource('src', 'app', 'FlowChainApp.tsx')
  const forecast = readSource('src', 'modules', 'forecast', 'Page.tsx')

  assert.match(app, /<ForecastPanel[^>]+onReviewActionDraft=\{openActionDraftReview\}/)
  assert.match(forecast, /onReviewActionDraft/)
  assert.match(forecast, /forecastDraftRequest/)
  assert.match(forecast, /mrpReleaseDraftRequest/)
  assert.match(forecast, /purchase_request_draft/)
  assert.match(forecast, /预览 PR 草稿/)
  assert.match(forecast, /mrpEvidence/)
  assert.match(forecast, /forecastBasis/)
  assert.match(forecast, /bomSourceSummary/)
  assert.doesNotMatch(forecast, /\/api\/purchase-requests/)
  assert.doesNotMatch(forecast, /apiJson<PurchaseRequest>/)
  assert.doesNotMatch(forecast, /已生成待审批采购申请/)
})

test('action draft preview route remains preview-only and does not use persistence writes', () => {
  const route = readSource('server', 'routes', 'action-drafts.routes.mjs')

  assert.match(route, /\/api\/action-drafts\/preview/)
  assert.match(route, /previewOnly: true/)
  assert.doesNotMatch(route, /writeDb/)
  assert.doesNotMatch(route, /saveDb/)
  assert.doesNotMatch(route, /createPurchaseRequest/)
})
