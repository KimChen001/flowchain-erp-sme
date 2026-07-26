import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import { buildReportsAnalyticsV2, FORBIDDEN_REPORTS_ACTION_PATTERN, FORBIDDEN_REPORTS_TECHNICAL_PATTERN } from './reports-analytics-v2.mjs'
import { buildOperationsControlTowerV2 } from './operations-control-tower-v2.mjs'
import { buildDataAccessQualityV2 } from './data-access-quality-v2.mjs'
import { createProductReviewScenarioDb } from './test-fixtures/product-review-scenario.mjs'

function loadDb() {
  return createProductReviewScenarioDb()
}

function visibleText(value) {
  if (Array.isArray(value)) return value.map(visibleText).join(' ')
  if (!value || typeof value !== 'object') return String(value ?? '')
  return Object.entries(value)
    .filter(([key]) => !/entityType|documentType|provider|draftType|payload|actionType|raw/i.test(key))
    .map(([, item]) => visibleText(item))
    .join(' ')
}

test('reports analytics v2 returns expected top-level contract', () => {
  const report = buildReportsAnalyticsV2(loadDb())
  for (const key of ['summary', 'p2pPipeline', 'supplierAnalytics', 'inventoryAnalytics', 'financeAnalytics', 'controlTowerAnalytics', 'dataQualityImpact', 'reportInsights', 'dataLimitations', 'generatedAt', 'dataScopeLabel']) {
    assert.ok(Object.hasOwn(report, key), key)
  }
  assert.ok(report.summary.totalPrCount >= 0)
  assert.ok(report.summary.controlTowerOpenItemCount >= 1)
  assert.ok(report.summary.dataQualityIssueCount >= 1)
})

test('p2p pipeline includes required stages', () => {
  const report = buildReportsAnalyticsV2(loadDb())
  const stages = report.p2pPipeline.map((item) => item.stage)
  for (const stage of ['PR', 'RFQ', 'PO', 'GRN', 'Invoice', 'Three-way Match']) {
    assert.ok(stages.includes(stage), stage)
  }
  assert.ok(report.p2pPipeline.every((item) => typeof item.count === 'number' && item.navigationLinks.length >= 1))
})

test('supplier analytics includes risk procurement receiving invoice and uninvoiced fields', () => {
  const report = buildReportsAnalyticsV2(loadDb())
  assert.ok(report.supplierAnalytics.length >= 3)
  const row = report.supplierAnalytics[0]
  for (const key of ['riskLevel', 'poCount', 'rfqCount', 'grnExceptionCount', 'invoiceVarianceCount', 'receivedNotInvoicedAmount']) {
    assert.ok(Object.hasOwn(row, key), key)
  }
})

test('inventory analytics includes sku stock shortage and related purchasing links', () => {
  const report = buildReportsAnalyticsV2(loadDb())
  assert.ok(report.inventoryAnalytics.length >= 3)
  const row = report.inventoryAnalytics[0]
  for (const key of ['sku', 'availableQty', 'safetyStock', 'shortageQty', 'relatedPr', 'relatedPo', 'relatedRfq']) {
    assert.ok(Object.hasOwn(row, key), key)
  }
  assert.ok(row.navigationLinks.length >= 1)
})

test('finance analytics covers invoice variance match and received not invoiced', () => {
  const report = buildReportsAnalyticsV2(loadDb())
  assert.ok(report.financeAnalytics.length >= 1)
  const text = visibleText(report.financeAnalytics)
  assert.match(text, /Invoice|发票|GRN|三单匹配|需复核/)
  assert.ok(report.financeAnalytics.some((item) => Object.hasOwn(item, 'receivedNotInvoicedAmount')))
})

test('risk workspace analytics aligns with operations categories', () => {
  const db = loadDb()
  const report = buildReportsAnalyticsV2(db)
  const tower = buildOperationsControlTowerV2(db)
  const categories = new Set(report.controlTowerAnalytics.map((item) => item.category))
  for (const category of ['supplier_risk', 'po_unreceived', 'received_not_invoiced', 'invoice_variance', 'three_way_match_variance', 'rfq_pending_response', 'inventory_risk', 'data_quality_gap']) {
    assert.ok(categories.has(category), category)
  }
  assert.equal(report.summary.controlTowerOpenItemCount, tower.items.length)
})

test('data quality impact aligns with Data Access Quality v2 issues', () => {
  const db = loadDb()
  const report = buildReportsAnalyticsV2(db)
  const quality = buildDataAccessQualityV2(db)
  assert.ok(report.dataQualityImpact.length >= 1)
  const impactCount = report.dataQualityImpact.reduce((sum, item) => sum + item.issueCount, 0)
  assert.ok(impactCount <= quality.qualityIssues.length)
  assert.ok(report.dataQualityImpact.some((item) => /AI|风险与异常|Three-way|Data Access|报表/.test(`${item.affectedModule} ${item.impactSummary}`)))
})

test('report insights are review-first and read-only', () => {
  const report = buildReportsAnalyticsV2(loadDb())
  assert.ok(report.reportInsights.length >= 3)
  assert.ok(report.reportInsights.every((item) => item.reviewOnlyAction.previewOnly === true))
  assert.ok(report.reportInsights.every((item) => item.reviewOnlyAction.requiresHumanReview === true))
  assert.ok(report.reportInsights.every((item) => item.navigationLinks.length >= 1))
})

test('visible report text avoids forbidden wording', () => {
  const report = buildReportsAnalyticsV2(loadDb())
  const text = visibleText(report)
  assert.doesNotMatch(text, FORBIDDEN_REPORTS_ACTION_PATTERN)
  assert.doesNotMatch(text, FORBIDDEN_REPORTS_TECHNICAL_PATTERN)
})

test('empty data returns limitations without throwing', () => {
  const report = buildReportsAnalyticsV2({})
  assert.ok(report.dataLimitations.length >= 1)
  assert.ok(report.p2pPipeline.length >= 6)
  assert.ok(report.reportInsights.length >= 1)
})
