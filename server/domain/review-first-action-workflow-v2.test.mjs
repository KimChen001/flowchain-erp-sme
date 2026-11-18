import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import {
  buildReviewFirstActionWorkflowV2,
  FORBIDDEN_REVIEW_WORKFLOW_ACTION_PATTERN,
  FORBIDDEN_REVIEW_WORKFLOW_TECHNICAL_PATTERN,
  REVIEW_DRAFT_STATUSES,
} from './review-first-action-workflow-v2.mjs'
import { REVIEW_STATUS_LABELS, REVIEW_TRANSITION_LABELS, reviewStatusLabel, reviewTransitionLabel } from '../../src/components/actions/reviewQueueCopy.ts'
import { buildDataAccessQualityV2 } from './data-access-quality-v2.mjs'
import { buildOperationsControlTowerV2 } from './operations-control-tower-v2.mjs'
import { buildReportsAnalyticsV2 } from './reports-analytics-v2.mjs'
import { createProductReviewScenarioDb } from './test-fixtures/product-review-scenario.mjs'

const CJK = /[㐀-鿿＀-￯]/

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
  for (const transition of ['draft_preview->awaiting_review', 'draft_preview->needs_information', 'draft_preview->cancelled', 'awaiting_review->returned', 'awaiting_review->handled_manually']) {
    assert.ok(transitions.includes(transition), transition)
  }
  for (const status of ['needs_information', 'returned', 'cancelled', 'handled_manually']) {
    assert.ok(workflow.lifecyclePolicy.reasonRequiredTransitions.includes(status), status)
  }
  assert.ok(workflow.lifecyclePolicy.allowedTransitions.some((item) => item.to === 'cancelled' && item.reasonRequired))
})

// Design audit L6-20: a draft's status is a code the page names in the
// interface language, never a Chinese status word kept as the value.
test('draft statuses are codes the page names in English and Chinese', () => {
  const workflow = buildReviewFirstActionWorkflowV2(loadDb())
  const codes = new Set(Object.values(REVIEW_DRAFT_STATUSES))
  const used = [
    ...workflow.drafts.flatMap((draft) => [draft.status, ...draft.allowedTransitions.flatMap((item) => [item.from, item.to]), ...draft.reviewActions.map((action) => action.transitionTo)]),
    ...workflow.lifecyclePolicy.statuses.map((item) => item.status),
    ...workflow.lifecyclePolicy.allowedTransitions.flatMap((item) => [item.from, item.to]),
    ...workflow.lifecyclePolicy.reasonRequiredTransitions,
    workflow.summary.overallStatus,
    buildReviewFirstActionWorkflowV2({}).summary.overallStatus,
  ]
  for (const status of used) {
    assert.ok(codes.has(status), `${status} is a status code`)
    assert.doesNotMatch(status, CJK)
  }
  assert.ok(workflow.drafts.some((draft) => draft.status === 'awaiting_review'))
  assert.ok(workflow.drafts.flatMap((draft) => draft.reviewActions).every((action) => !Object.hasOwn(action, 'label')))
  // Every code has an English and a Chinese name, as a status and as the
  // button that moves a draft to it; the map has no codes the server lacks.
  assert.deepEqual(Object.keys(REVIEW_STATUS_LABELS).sort(), [...codes].sort())
  assert.deepEqual(Object.keys(REVIEW_TRANSITION_LABELS).sort(), [...codes].sort())
  for (const code of codes) {
    for (const name of [reviewStatusLabel(code, 'en-US'), reviewTransitionLabel(code, 'en-US')]) assert.ok(name && name !== code && !CJK.test(name), `${code}: ${name}`)
    for (const name of [reviewStatusLabel(code, 'zh-CN'), reviewTransitionLabel(code, 'zh-CN')]) assert.match(name, CJK, code)
  }
  assert.equal(reviewStatusLabel('awaiting_review', 'en-US'), 'Awaiting human review')
  assert.equal(reviewStatusLabel('awaiting_review', 'zh-CN'), '等待人工复核')
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
