import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const repoRoot = path.resolve(import.meta.dirname, '..', '..')

function readSource(...parts) {
  return fs.readFileSync(path.join(repoRoot, ...parts), 'utf8')
}

test('canonical evidence helper maps business evidence to focus targets', () => {
  const source = readSource('src', 'lib', 'evidenceLinks.ts')

  assert.match(source, /export type CanonicalEvidenceLink = \{/)
  assert.match(source, /export type CanonicalNavigationIntent = \{/)
  assert.match(source, /pr: \{ entityType: "purchase_request", moduleId: "procurement:requests"/)
  assert.match(source, /po: \{ entityType: "purchase_order", moduleId: "procurement:orders"/)
  assert.match(source, /rfq: \{ entityType: "rfq", moduleId: "procurement:rfq"/)
  assert.match(source, /grn: \{ entityType: "receiving_doc", moduleId: "procurement:receiving"/)
  assert.match(source, /inventory_item: \{ moduleId: "inventory", entityType: "inventory_item"/)
  assert.match(source, /supplier_master: \{ moduleId: "srm:master", entityType: "supplier"/)
})

test('canonical evidence helper filters broken targets without raw object rendering', () => {
  const source = readSource('src', 'lib', 'evidenceLinks.ts')

  assert.match(source, /const canonicalModuleId = target\?\.moduleId \|\| \(route && !route\.startsWith\("\/"\) \? route : moduleId\)/)
  assert.match(source, /const clickable = Boolean\(entityId && canonicalModuleId && normalizedEntityType\)/)
  assert.match(source, /focusTarget: clickable \? \{ entityType: normalizedEntityType, entityId \} : undefined/)
  assert.match(source, /readableLabel\(raw: EvidenceLike/)
  assert.doesNotMatch(source, /JSON\.stringify/)
})

test('global search opens canonical focus targets where safe', () => {
  const source = readSource('src', 'app', 'FlowChainApp.tsx')

  assert.match(source, /navigationIntentFromGlobalSearchResult\(result, \{ returnTo: active \}\)/)
  assert.match(source, /routeByPath\(location\.pathname\)/)
  assert.match(source, /routePathForId\(intent\.activeId\)/)
  assert.match(source, /navigationIntentFromModule\(navigationId, \{/)
  assert.match(source, /defaultRouteForModule\(requestedRoute\.moduleId\)/)
  assert.match(source, /onNavigate=\{navigateTo\}/)
  assert.match(readSource('src', 'lib', 'evidenceLinks.ts'), /source: "globalSearch"/)
})

test('navigation intent helper preserves module view and API-route focus targets', () => {
  const source = readSource('src', 'lib', 'evidenceLinks.ts')

  assert.match(source, /export function splitNavigationId\(active = ""\)/)
  assert.match(source, /export function navigationActiveId\(moduleId = "overview", viewId\?: string\)/)
  assert.match(source, /export function navigationIntentFromEvidenceLink/)
  assert.match(source, /export function navigationIntentFromGlobalSearchResult/)
  assert.match(source, /export function navigationIntentFromInternalTarget/)
  assert.match(source, /function navigationIntentFromApiRoute/)
  assert.match(source, /parts\[1\] === "procurement" && parts\[2\] === "documents"/)
  assert.match(source, /parts\[1\] === "inventory" && parts\[2\] === "items"/)
  assert.match(source, /if \(link\.moduleId\) return link\.moduleId/)
  assert.match(source, /navigationIntentFromModule\(moduleId, \{/)
  assert.match(source, /"purchase-orders": "orders"/)
  assert.match(source, /rfqs: "rfq"/)
  assert.match(source, /\{ key: "poId", entityType: "purchase_order" \}/)
  assert.match(source, /\{ key: "itemId", entityType: "inventory_item" \}/)
})

test('AI evidence navigation supports object-specific PO SKU RFQ GRN and PR focus', () => {
  const source = readSource('src', 'lib', 'evidenceLinks.ts')
  const app = readSource('src', 'app', 'FlowChainApp.tsx')
  const ai = readSource('src', 'modules', 'ai-assistant', 'Panel.tsx')

  assert.match(source, /po: \{ entityType: "purchase_order", moduleId: "procurement:orders"/)
  assert.match(source, /rfq: \{ entityType: "rfq", moduleId: "procurement:rfq"/)
  assert.match(source, /grn: \{ entityType: "receiving_doc", moduleId: "procurement:receiving"/)
  assert.match(source, /pr: \{ entityType: "purchase_request", moduleId: "procurement:requests"/)
  assert.match(source, /inventory_item: \{ moduleId: "inventory", entityType: "inventory_item"/)
  assert.match(source, /focusTarget: \{ entityType: target\.entityType, entityId \}/)
  assert.match(source, /focusTarget: \{ entityType: "inventory_item", entityId: decodeURIComponent\(parts\[3\]\) \}/)
  assert.match(app, /setSearchFocus\(\s*intent\.focusTarget/)
  assert.doesNotMatch(ai, /onClick=\{\(\) => askAi\(intent\.activeId/)
  assert.doesNotMatch(ai, /onClick=\{\(\) => askAi\(action\.target/)
})

test('AI panel does not render evidence through raw internal hrefs', () => {
  const ai = readSource('src', 'modules', 'ai-assistant', 'Panel.tsx')

  assert.doesNotMatch(ai, /href=\{safeInternalTarget/)
})
