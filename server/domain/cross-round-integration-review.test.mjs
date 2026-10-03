import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const repoRoot = path.resolve(import.meta.dirname, '..', '..')

function readSource(...parts) {
  return fs.readFileSync(path.join(repoRoot, ...parts), 'utf8')
}

test('route audit documents preview-only action drafts separately from writes', () => {
  const routeAudit = readSource('docs', 'backend-route-audit.md')
  const draftRoutes = readSource('server', 'routes', 'action-drafts.routes.mjs')

  assert.match(routeAudit, /\/api\/action-drafts\/schema/)
  assert.match(routeAudit, /\/api\/action-drafts\/preview/)
  assert.match(routeAudit, /Preview-only Routes/)
  assert.doesNotMatch(draftRoutes, /writeDb\(/)
})

test('provider safety remains exact opt-in and evidence links remain frontend-only', () => {
  const providerSafety = readSource('server', 'domain', 'ai-provider-safety.mjs')
  const evidenceLinks = readSource('src', 'lib', 'evidenceLinks.ts')
  const aiRoutes = readSource('server', 'routes', 'ai.routes.mjs')

  assert.match(providerSafety, /env\.AI_PROVIDER_ENABLED === 'true'/)
  assert.match(evidenceLinks, /export function normalizeEvidenceLink/)
  assert.match(evidenceLinks, /const clickable = Boolean\(entityId && canonicalModuleId && normalizedEntityType\)/)
  assert.doesNotMatch(evidenceLinks, /fetch\(|apiJson|writeDb|localStorage/)
  assert.match(aiRoutes, /getAiProviderSafetyState/)
})

test('navigation evidence surfaces share canonical helper names', () => {
  const app = readSource('src', 'app', 'FlowChainApp.tsx')
  const cockpit = readSource('src', 'modules', 'overview', 'TodayCockpitPanel.tsx')

  assert.match(app, /navigationIntentFromGlobalSearchResult/)
  assert.match(app, /routePathForId\(intent\.activeId\)/)
  assert.match(cockpit, /normalizeTodayCockpitTarget/)
})

test('typography and amount display boundaries are still documented', () => {
  const typographyDoc = readSource('docs', 'ui-typography-consistency-v1.md')
  const cockpitTest = readSource('server', 'domain', 'today-cockpit-component-extraction.test.mjs')
  const table = readSource('src', 'components', 'ui', 'workbenchTable.ts')

  assert.match(typographyDoc, /PO, PR, and RFQ table ID buttons use `tableLinkClass`/)
  assert.match(table, /tableLinkClass = `\$\{typography\.tableLink\} tabular-nums hover:underline/)
  assert.match(cockpitTest, /compactDisplay/)
  assert.match(cockpitTest, /万元/)
})
