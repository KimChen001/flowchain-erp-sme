import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

function source(...parts) {
  return readFileSync(path.join(repoRoot, ...parts), 'utf8')
}

test('R170 user data backend exposes import contract preview runtime and commit boundary', () => {
  const contract = source('server', 'domain', 'user-data-contract.mjs')
  const runtime = source('server', 'domain', 'user-data-runtime.mjs')
  const routes = source('server', 'routes', 'user-data.routes.mjs')

  for (const key of [
    'purchaseOrders',
    'purchaseRequests',
    'rfqs',
    'products',
    'suppliers',
    'receivingDocs',
    'supplierInvoices',
    'inventoryMovements',
    'inventoryExceptions',
  ]) {
    assert.match(contract, new RegExp(`['"]${key}['"]`))
  }

  assert.match(contract, /export function normalizeUserDataImportPayload/)
  assert.match(runtime, /export function createUserDataRuntimeDb/)
  assert.match(runtime, /__dataMode:\s*'user'/)
  assert.match(routes, /\/api\/user-data\/import\/dry-run/)
  assert.match(routes, /\/api\/user-data\/import\/preview/)
  assert.match(routes, /\/api\/user-data\/import\/commit/)
  assert.match(routes, /user_import_commit_disabled/)
  assert.match(routes, /writesFiles:\s*false/)
  assert.match(routes, /writesDb:\s*false/)
  assert.match(routes, /overwritesDemoData:\s*false/)
})

test('R170 user data backend tests cover dry-run runtime commit and browser preview smoke', () => {
  assert.match(source('server', 'domain', 'user-data-import-dry-run.test.mjs'), /R163 dry-run route returns normalized preview/)
  assert.match(source('server', 'domain', 'user-data-runtime-ai.test.mjs'), /R165 AI answers imported user data/)
  assert.match(source('server', 'domain', 'user-data-import-commit-boundary.test.mjs'), /R167 commit boundary blocks non-authoritative preview mode and never writes runtime data/)
  assert.match(source('tests', 'browser', 'user-data-import-preview.spec.ts'), /R169 user data import preview API stays compact and non-mutating/)
})

test('R170 user data backend readiness keeps provider and protected fixture write boundaries closed', () => {
  const routes = source('server', 'routes', 'user-data.routes.mjs')
  const providerSafety = source('server', 'domain', 'ai-provider-safety.mjs')
  const runtimeAiTest = source('server', 'domain', 'user-data-runtime-ai.test.mjs')
  const browserPreview = source('tests', 'browser', 'user-data-import-preview.spec.ts')

  assert.match(providerSafety, /env\.AI_PROVIDER_ENABLED === 'true'/)
  assert.match(runtimeAiTest, /providerCalls,\s*0/)
  assert.doesNotMatch(routes, /scm-demo\.json|jsonDb\.write|writeDb\s*\(|writeFile|appendFile/)
  assert.doesNotMatch(routes, /OPENAI_API_KEY|ARK_API_KEY|DOUBAO_API_KEY|fetch\(/)
  assert.match(browserPreview, /not\.toMatch\(demoIds\)/)
})
