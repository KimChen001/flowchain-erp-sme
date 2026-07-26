import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import {
  buildChainDataLimitationsV1,
  buildChainEvidenceSummaryV1,
  buildChainNavigationLinksV1,
  buildChainReviewDraftSuggestionsV1,
  buildCoreBusinessChainV1,
  buildInventoryToProcurementLinksV1,
  buildInvoiceToFinanceLinksV1,
  buildProcurementToReceivingLinksV1,
  buildReceivingToInvoiceLinksV1,
  buildSalesDemandToInventoryLinksV1,
  findBusinessChainByEntityV1,
  sanitizeCoreBusinessChainForAiV1,
} from './core-business-chain-v1.mjs'
import { createProductReviewScenarioDb } from './test-fixtures/product-review-scenario.mjs'

function loadDb() {
  return createProductReviewScenarioDb()
}

function visibleText(value) {
  if (Array.isArray(value)) return value.map(visibleText).join(' ')
  if (!value || typeof value !== 'object') return String(value ?? '')
  return Object.entries(value)
    .filter(([key]) => !/^(id|entityType|entityId|moduleId|source|returnTo|returnContext|payload|originEvidence)$/i.test(key))
    .map(([, item]) => visibleText(item))
    .join(' ')
}

test('core business chain connects sales demand inventory procurement receiving invoice and finance evidence', () => {
  const db = loadDb()
  const chain = buildCoreBusinessChainV1(db)
  assert.equal(chain.version, 'v1')
  assert.ok(chain.summary.chainCount >= 1)
  assert.ok(chain.summary.highRiskChainCount >= 1)

  const node = findBusinessChainByEntityV1(chain, { entityType: 'customer_order', entityId: 'SO-2026-0412-A' })
  assert.ok(node)
  assert.equal(node.salesDemand.id, 'SO-2026-0412-A')
  assert.equal(node.inventory.sku, 'SKU-00412')
  assert.ok(node.procurement.purchaseOrders.some((po) => po.id === 'PO-2026-1282'))
  assert.ok(node.receiving.receivingDocs.some((grn) => grn.id === 'GRN-202605-0419'))
  assert.ok(node.finance.impacts.length >= 1)
  assert.ok(node.summary.some((item) => item.evidenceLabel === '销售需求'))
  assert.ok(node.summary.some((item) => item.evidenceLabel === '库存风险'))
  assert.ok(node.summary.some((item) => item.evidenceLabel === '采购订单'))
  assert.ok(node.summary.some((item) => item.evidenceLabel === '收货 / GRN'))
  assert.ok(node.summary.some((item) => item.evidenceLabel === '财务协同'))
})

test('link builders return bounded read-only relationships', () => {
  const db = loadDb()
  const salesLinks = buildSalesDemandToInventoryLinksV1(db)
  const inventoryLinks = buildInventoryToProcurementLinksV1(db)
  const receivingLinks = buildProcurementToReceivingLinksV1(db)
  const invoiceLinks = buildReceivingToInvoiceLinksV1(db)
  const financeLinks = buildInvoiceToFinanceLinksV1(db)
  assert.ok(salesLinks.some((item) => item.salesOrderId === 'SO-2026-0412-A' && item.sku === 'SKU-00412'))
  assert.ok(inventoryLinks.some((item) => item.sku === 'SKU-00412'))
  assert.ok(receivingLinks.some((item) => item.poId === 'PO-2026-1282'))
  assert.ok(Array.isArray(invoiceLinks))
  assert.ok(Array.isArray(financeLinks))
})

test('chain helpers expose navigation limitations and review-first draft suggestions', () => {
  const node = findBusinessChainByEntityV1(buildCoreBusinessChainV1(loadDb()), { entityId: 'PO-2026-1282' })
  const evidence = buildChainEvidenceSummaryV1(node)
  const links = buildChainNavigationLinksV1(node)
  const limitations = buildChainDataLimitationsV1(node)
  const drafts = buildChainReviewDraftSuggestionsV1(node)
  const aiView = sanitizeCoreBusinessChainForAiV1(node)

  assert.ok(evidence.length >= 5)
  assert.ok(links.some((link) => link.moduleId === 'procurement:orders'))
  assert.ok(links.every((link) => link.returnContext?.returnLabel === '返回 今日行动'))
  assert.ok(
    evidence.some((item) => /发票/.test(item.evidenceLabel)) ||
    limitations.some((item) => /发票/.test(item.label)),
  )
  assert.equal(drafts[0].previewOnly, true)
  assert.equal(drafts[0].reviewRequired, true)
  assert.equal(drafts[0].requiresHumanReview, true)
  assert.ok(aiView.summary.length <= 12)
  assert.doesNotMatch(visibleText(aiView), /JSON|payload|entityType|documentType|database|mock|fake|demo|UAT/i)
  assert.doesNotMatch(visibleText(aiView), /自动批准|自动下单|发送|付款|会计过账|库存过账/)
})

test('summary metrics remain bounded numeric and missing entity does not invent a chain', () => {
  const chain = buildCoreBusinessChainV1(loadDb())
  const expectedFields = [
    'chainCount',
    'highRiskChainCount',
    'invoiceGapCount',
    'reviewDraftCount',
    'salesDemandCount',
    'inventoryRiskCount',
    'replenishmentCandidateCount',
    'openPrCount',
    'openPoCount',
    'receivingIssueCount',
    'invoiceVarianceCount',
    'financeReviewCount',
    'dataLimitedCount',
  ]
  for (const field of expectedFields) {
    assert.equal(typeof chain.summary[field], 'number', field)
    assert.ok(chain.summary[field] >= 0, field)
  }
  assert.equal(findBusinessChainByEntityV1(chain, { entityType: 'purchase_order', entityId: 'NON-EXISTENT' }), null)
  assert.ok(chain.chains.every((item) => item.summary.length <= 12))
  assert.ok(chain.chains.every((item) => item.navigationLinks.length <= 8))
  assert.ok(chain.chains.every((item) => item.reviewDraftSuggestions.every((draft) =>
    draft.previewOnly === true && draft.reviewRequired === true && draft.requiresHumanReview === true
  )))
})
