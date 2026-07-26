import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import {
  buildReviewFirstActionWorkflowV2,
  FORBIDDEN_REVIEW_WORKFLOW_ACTION_PATTERN,
  FORBIDDEN_REVIEW_WORKFLOW_TECHNICAL_PATTERN,
} from './review-first-action-workflow-v2.mjs'
import { buildDataAccessQualityV2 } from './data-access-quality-v2.mjs'
import { buildOperationsControlTowerV2 } from './operations-control-tower-v2.mjs'
import { buildReportsAnalyticsV2 } from './reports-analytics-v2.mjs'
import { createProductReviewScenarioDb } from './test-fixtures/product-review-scenario.mjs'

function loadDb() {
  return createProductReviewScenarioDb()
}

function visibleText(value) {
  if (Array.isArray(value)) return value.map(visibleText).join(' ')
  if (!value || typeof value !== 'object') return String(value ?? '')
  return Object.entries(value)
    .filter(([key]) => !/sourceCategory|draftType|entityType|targetEntityType|sourceEntityType|payload|raw|moduleId/i.test(key))
    .map(([, item]) => visibleText(item))
    .join(' ')
}

test('review first workflow returns expected top-level contract', () => {
  const workflow = buildReviewFirstActionWorkflowV2(loadDb())
  for (const key of ['summary', 'drafts', 'sourceSummary', 'lifecyclePolicy', 'dataLimitations', 'generatedAt', 'dataScopeLabel']) {
    assert.ok(Object.hasOwn(workflow, key), key)
  }
  assert.ok(workflow.summary.totalDraftCount >= 20)
  assert.ok(workflow.summary.waitingReviewCount >= 1)
  assert.ok(workflow.summary.highPriorityCount >= 1)
})

test('drafts cover required source categories', () => {
  const workflow = buildReviewFirstActionWorkflowV2(loadDb())
  const categories = new Set(workflow.drafts.map((draft) => draft.sourceCategory))
  for (const category of ['ai_response', 'control_tower', 'reports_analytics', 'data_access_quality', 'purchase_request', 'rfq_sourcing', 'po_receiving_invoice', 'supplier_profile', 'inventory_risk']) {
    assert.ok(categories.has(category), category)
  }
})

test('each draft carries source target evidence content and navigation', () => {
  const workflow = buildReviewFirstActionWorkflowV2(loadDb())
  for (const draft of workflow.drafts) {
    for (const key of ['sourceLabel', 'targetEntityLabel', 'status', 'priority', 'conclusion', 'proposedDraftContent']) {
      assert.ok(draft[key], `${draft.id} ${key}`)
    }
    assert.ok(draft.keyEvidence.length >= 1, draft.id)
    assert.ok(draft.businessImpact.length >= 1, draft.id)
    assert.ok(draft.reviewChecklist.length >= 1, draft.id)
    assert.ok(draft.navigationLinks.length >= 1, draft.id)
    assert.ok(Array.isArray(draft.dataLimitations), draft.id)
  }
})

test('lifecycle policy includes allowed transitions and reason requirements', () => {
  const workflow = buildReviewFirstActionWorkflowV2(loadDb())
  const transitions = workflow.lifecyclePolicy.allowedTransitions.map((item) => `${item.from}->${item.to}`)
  for (const transition of ['草稿预览->等待人工复核', '草稿预览->需要补充信息', '草稿预览->已取消', '等待人工复核->已退回复核', '等待人工复核->已标记人工处理']) {
    assert.ok(transitions.includes(transition), transition)
  }
  for (const status of ['需要补充信息', '已退回复核', '已取消', '已标记人工处理']) {
    assert.ok(workflow.lifecyclePolicy.reasonRequiredTransitions.includes(status), status)
  }
  assert.ok(workflow.lifecyclePolicy.allowedTransitions.some((item) => item.to === '已取消' && item.reasonRequired))
})

test('review actions are preview only and require human review', () => {
  const workflow = buildReviewFirstActionWorkflowV2(loadDb())
  const actions = workflow.drafts.flatMap((draft) => draft.reviewActions)
  assert.ok(actions.length >= 1)
  assert.ok(actions.every((action) => action.previewOnly === true))
  assert.ok(actions.every((action) => action.requiresHumanReview === true))
})

test('visible workflow text avoids forbidden execution wording', () => {
  const workflow = buildReviewFirstActionWorkflowV2(loadDb())
  assert.doesNotMatch(visibleText(workflow), FORBIDDEN_REVIEW_WORKFLOW_ACTION_PATTERN)
})

test('visible workflow text avoids forbidden technical wording', () => {
  const workflow = buildReviewFirstActionWorkflowV2(loadDb())
  assert.doesNotMatch(visibleText(workflow), FORBIDDEN_REVIEW_WORKFLOW_TECHNICAL_PATTERN)
})

test('empty data returns policy and limitations without throwing', () => {
  const workflow = buildReviewFirstActionWorkflowV2({})
  assert.ok(workflow.lifecyclePolicy.allowedTransitions.length >= 1)
  assert.ok(workflow.dataLimitations.length >= 1)
  assert.equal(workflow.dataScopeLabel, '当前工作区数据')
})

test('workflow aligns with operations reports and data access sources', () => {
  const db = loadDb()
  const workflow = buildReviewFirstActionWorkflowV2(db)
  const tower = buildOperationsControlTowerV2(db)
  const reports = buildReportsAnalyticsV2(db)
  const quality = buildDataAccessQualityV2(db)
  assert.ok(workflow.drafts.some((draft) => draft.sourceCategory === 'control_tower' && tower.items.some((item) => draft.id.includes(item.id))))
  assert.ok(workflow.drafts.some((draft) => draft.sourceCategory === 'reports_analytics' && reports.reportInsights.some((item) => draft.title.includes(item.title))))
  assert.ok(workflow.drafts.some((draft) => draft.sourceCategory === 'data_access_quality' && quality.recommendedFixes.some((item) => draft.title.includes(item.title))))
})

test('draft types include required business draft previews', () => {
  const workflow = buildReviewFirstActionWorkflowV2(loadDb())
  const labels = new Set(workflow.drafts.map((draft) => draft.draftTypeLabel))
  for (const label of ['内部复核备注', 'RFQ 草稿预览', 'PO 草稿预览', '差异说明', '收货异常说明', '供应商风险说明', '字段映射建议', '数据补齐清单', '报表复核备注', '库存风险复核']) {
    assert.ok(labels.has(label), label)
  }
})
