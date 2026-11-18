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

  assert.doesNotMatch(app, /\/api\/action-drafts\/preview/)
  assert.doesNotMatch(app, /ReplenishmentRequestModal|inventoryItems|supplierRecommendation/)
  assert.match(inventory, /<EntityLink kind="item"/)
  assert.doesNotMatch(inventory, /\/api\/master-data\/items\/.*\/suppliers/)
  assert.doesNotMatch(inventory, /维护供应商关系/)
  assert.doesNotMatch(inventory, /预览 PR|预览 RFQ|demo-data|inventoryReadFallbackScopes/)
  assert.doesNotMatch(inventory, /submit|purchase_request_draft|rfq_draft/)
})

test('the action draft route only records draft use and does not use persistence writes', () => {
  const route = readSource('server', 'routes', 'action-drafts.routes.mjs')

  assert.match(route, /\/api\/action-drafts\/used/)
  assert.doesNotMatch(route, /\/api\/action-drafts\/(?:preview|save|schema)|'\/api\/action-drafts'/)
  assert.doesNotMatch(route, /writeDb/)
  assert.doesNotMatch(route, /saveDb/)
  assert.doesNotMatch(route, /createPurchaseRequest/)
})
