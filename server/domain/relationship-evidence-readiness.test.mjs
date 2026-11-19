import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

function source(...parts) {
  return fs.readFileSync(path.join(root, ...parts), 'utf8')
}

test('R212 relationship and evidence models expose normalized read-only contracts', () => {
  const model = source('src', 'domain', 'relationships', 'model.ts')
  for (const field of ['relationship id', 'sourceEntityType', 'targetEntityType', 'targetDisplayLabel', 'targetModule', 'confidence', 'evidenceSource', 'dataLimitation']) {
    assert.match(model, new RegExp(field.replace('relationship id', 'id')))
  }
  for (const relation of ['created_from', 'requested_item', 'sourced_by_rfq', 'awarded_to_po', 'contains_item', 'supplied_by', 'received_by', 'matched_to_invoice', 'affects_inventory', 'has_exception', 'has_audit_event', 'related_supplier']) {
    assert.match(model, new RegExp(relation))
  }
  assert.doesNotMatch(model, /POST|PATCH|DELETE|write|mutate|persist/i)
})

test('R213 relationship resolver supports key direct business graph paths and limitations', () => {
  const resolver = source('src', 'domain', 'relationships', 'resolver.ts')
  assert.match(resolver, /export function resolveEntityRelationships/)
  assert.match(resolver, /function resolveForPo/)
  assert.match(resolver, /function resolveForSku/)
  assert.match(resolver, /function resolveForSupplier/)
  assert.match(resolver, /function resolveForGrn/)
  assert.match(resolver, /function resolveForInvoice/)
  assert.match(resolver, /function resolveForRfq/)
  assert.match(resolver, /function resolveForPr/)
  for (const limitation of ['missing_source_pr', 'missing_rfq_link', 'missing_grn', 'missing_invoice_match', 'missing_inventory_balance', 'route_not_available', 'record_not_found']) {
    assert.match(resolver, new RegExp(limitation))
  }
  assert.match(resolver, /uniqueRelationships/)
  assert.doesNotMatch(resolver, /fetch\(|apiJson|localStorage|POST|PATCH|DELETE/)
})

test('R214 evidence resolver keeps risk level separate from reason and produces limitations', () => {
  const evidence = source('src', 'domain', 'relationships', 'evidence.ts')
  for (const fn of ['resolvePoDelayEvidence', 'resolveSkuShortageEvidence', 'resolveSupplierRiskEvidence', 'resolveReceivingExceptionEvidence', 'resolveInvoiceMatchingEvidence', 'resolveRfqTimingEvidence']) {
    assert.match(evidence, new RegExp(`export function ${fn}`))
  }
  assert.match(evidence, /riskLevelFromChinese/)
  assert.match(evidence, /reason\(input\.reason/)
  assert.doesNotMatch(evidence, /reason:\s*["']高["']|reason:\s*["']中["']|reason:\s*["']低["']/)
  assert.match(evidence, /dataLimitations/)
})

test('R215-R216 high-value surfaces retain authoritative evidence without a duplicate PO relationship panel', () => {
  const purchasing = source('src', 'modules', 'purchasing', 'Page.tsx')
  const aiReadiness = source('src', 'domain', 'contextual-ai', 'readiness.ts')
  assert.match(purchasing, /buildGrnRows/)
  assert.match(purchasing, /buildInvoiceRows/)
  assert.match(purchasing, /buildMatchRows/)
  assert.doesNotMatch(purchasing, /DocumentEvidencePanel/)
  assert.match(aiReadiness, /resolvePoDelayEvidence/)
  assert.match(aiReadiness, /resolveSkuShortageEvidence/)
  assert.match(aiReadiness, /resolveInvoiceMatchingEvidence/)
  assert.match(aiReadiness, /recordsFromEvidence/)
})

test('R218-R220 relationship guardrails preserve navigation safety and AI boundaries', () => {
  const routes = source('src', 'app', 'routeRegistry.tsx')
  const links = source('src', 'lib', 'businessLinks.ts')
  const nav = source('src', 'components', 'navigation', 'RelatedRecordsPanel.tsx')
  const allChanged = [
    source('src', 'domain', 'relationships', 'model.ts'),
    source('src', 'domain', 'relationships', 'resolver.ts'),
    source('src', 'domain', 'relationships', 'evidence.ts'),
    source('src', 'domain', 'contextual-ai', 'readiness.ts'),
    source('src', 'domain', 'contextual-ai', 'actions.ts'),
    source('src', 'modules', 'purchasing', 'Page.tsx'),
  ].join('\n')
  assert.match(links, /Route not available yet/)
  assert.match(nav, /record\.disabledReason/)
  assert.match(allChanged, /mutationAllowed:\s*false/)
  assert.match(allChanged, /requiresReview:\s*true/)
  assert.doesNotMatch(routes, /label:\s*["']AI Assistant["']/)
  assert.doesNotMatch(routes, /label:\s*["']AI Command Center["']/)
  assert.doesNotMatch(routes, /label:\s*["']Ask AI["']/)
  assert.doesNotMatch(allChanged, /OPENAI_API_KEY|ARK_API_KEY|DOUBAO_API_KEY|AI_PROVIDER_ENABLED/)
})
