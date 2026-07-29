import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildTodayCockpit } from './today-cockpit-read-model.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

function source(...parts) {
  return fs.readFileSync(path.join(root, ...parts), 'utf8')
}

const fixture = {
  purchaseRequests: [
    { pr: 'PR-2026-2400', sourceSku: 'SKU-00412', sourceName: '伺服电机 750W', supplier: '深圳新元电气', status: '已批准', quantity: 8, linkedPo: 'PO-2026-1287' },
  ],
  rfqs: [
    { id: 'RFQ-26-0046', title: 'SKU-00412 伺服电机询价', status: '进行中', suppliers: 3, quoted: 2, sourceRequest: 'PR-2026-2400', linkedPo: 'PO-2026-1287', bestSupplier: '深圳新元电气' },
  ],
  purchaseOrders: [
    { po: 'PO-2026-1282', supplier: '广州化工耗材', status: '部分到货', eta: '2026-05-25', items: 9, received: 5, sourceSku: 'SKU-00744', sourceName: '聚氨酯密封胶' },
    { po: 'PO-2026-1287', supplier: '深圳新元电气', status: '待审批', eta: '2026-06-02', items: 8, received: 0, sourceRequest: 'PR-2026-2400', sourceRfq: 'RFQ-26-0046', sourceSku: 'SKU-00412', sourceName: '伺服电机 750W' },
  ],
  receivingDocs: [
    { grn: 'GRN-202605-0419', po: 'PO-2026-1282', supplier: '广州化工耗材', status: '异常处理', items: 9, failed: 2 },
  ],
  supplierInvoices: [
    { invoiceNumber: 'INV-GZ-260419', supplier: '广州化工耗材', relatedPo: 'PO-2026-1282', relatedGrn: 'GRN-202605-0419', matchStatus: '差异待处理', status: '存在差异', varianceAmount: 42000, lines: [{ sku: 'SKU-00744', name: '聚氨酯密封胶' }] },
    { invoiceNumber: 'INV-SZ-260425', supplier: '深圳新元电气', relatedPo: 'PO-2026-1287', matchStatus: '未匹配', status: '待匹配', varianceAmount: 2079200, lines: [{ sku: 'SKU-00412', name: '伺服电机 750W' }] },
  ],
  products: [
    { sku: 'SKU-00412', itemName: '伺服电机 750W', availableQuantity: 34, safetyStock: 50, reorderPoint: 50, status: '不足', riskLevel: '高', riskReason: '可用库存低于安全库存' },
  ],
  inventoryMovements: [
    { movementId: 'IM-20260527-0004', sku: 'SKU-00412', relatedPo: 'PO-2026-1287', status: '已确认' },
  ],
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
  const receiving = source('src', 'modules', 'receiving', 'Page.tsx')
  const invoice = source('src', 'modules', 'procurement', 'SupplierInvoiceRegister.tsx')
  const aiReadiness = source('src', 'domain', 'contextual-ai', 'readiness.ts')
  assert.match(purchasing, /buildGrnRows/)
  assert.match(purchasing, /buildInvoiceRows/)
  assert.match(purchasing, /buildMatchRows/)
  assert.doesNotMatch(purchasing, /DocumentEvidencePanel/)
  assert.match(receiving, /relatedRecordsForEntity/)
  assert.match(invoice, /relatedRecordsForEntity/)
  assert.match(aiReadiness, /resolvePoDelayEvidence/)
  assert.match(aiReadiness, /resolveSkuShortageEvidence/)
  assert.match(aiReadiness, /resolveReceivingExceptionEvidence/)
  assert.match(aiReadiness, /resolveInvoiceMatchingEvidence/)
  assert.match(aiReadiness, /recordsFromEvidence/)
})

test('R217 Today Cockpit remains evidence/count consistent for delayed PO inventory and RFQ timing', () => {
  const cockpit = buildTodayCockpit(fixture, { now: '2026-06-29T00:00:00Z' })
  const openPoCard = cockpit.cards.find((card) => card.id === 'open-pos')
  const inventoryCard = cockpit.cards.find((card) => card.id === 'inventory-risk')
  const rfqAction = cockpit.recommendedActions.find((action) => action.id === 'action-active-rfq')
  assert.ok(openPoCard.value >= 1)
  assert.ok(openPoCard.evidence.length > 0)
  assert.equal(openPoCard.evidence.some((item) => item.id || item.label || item.summary), true)
  assert.ok(['high', 'medium', 'low'].includes(inventoryCard.severity))
  assert.ok(inventoryCard.evidence.length > 0)
  assert.doesNotMatch(String(inventoryCard.evidence?.[0]?.summary || ''), /^(高|中|低)$/)
  assert.match(rfqAction.reason, /RFQ/)
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
    source('src', 'modules', 'purchasing', 'Page.tsx'),
    source('src', 'modules', 'receiving', 'Page.tsx'),
    source('src', 'modules', 'procurement', 'SupplierInvoiceRegister.tsx'),
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
