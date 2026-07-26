import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import {
  buildWorkspaceSetupConfigV2,
  FORBIDDEN_WORKSPACE_SETUP_ACTION_PATTERN,
  FORBIDDEN_WORKSPACE_SETUP_TECHNICAL_PATTERN,
} from './workspace-setup-config-v2.mjs'
import { buildCollaborationNotificationDraftsV2 } from './collaboration-notification-drafts-v2.mjs'
import { buildDataAccessQualityV2 } from './data-access-quality-v2.mjs'
import { buildReviewFirstActionWorkflowV2 } from './review-first-action-workflow-v2.mjs'
import { handleWorkspaceSetupConfigRoute } from '../routes/workspace-setup-config.routes.mjs'
import { createProductReviewScenarioDb } from './test-fixtures/product-review-scenario.mjs'

function loadDb() {
  return createProductReviewScenarioDb()
}

function visibleText(value) {
  if (Array.isArray(value)) return value.map(visibleText).join(' ')
  if (!value || typeof value !== 'object') return String(value ?? '')
  return Object.entries(value)
    .filter(([key]) => !/entityType|documentType|objectType|draftType|channelType|sourceModule|sourceRoute|source|moduleId|returnTo|payload|provider/i.test(key))
    .map(([, item]) => visibleText(item))
    .join(' ')
}

test('workspace setup config returns full top-level contract', () => {
  const result = buildWorkspaceSetupConfigV2(loadDb())
  for (const key of ['summary', 'workspaceProfile', 'moduleSettings', 'reviewPolicies', 'numberingRules', 'dataQualitySettings', 'aiAssistanceBoundaries', 'collaborationDraftPolicies', 'setupReviewDrafts', 'sourceSummary', 'dataLimitations', 'generatedAt']) {
    assert.ok(Object.hasOwn(result, key), key)
  }
  assert.equal(result.workspaceProfile.dataScopeLabel, '当前工作区数据')
  assert.ok(result.moduleSettings.length >= 10)
})

test('summary counts are derived from current arrays', () => {
  const result = buildWorkspaceSetupConfigV2(loadDb())
  assert.equal(result.summary.enabledModuleCount, result.moduleSettings.length)
  assert.equal(result.summary.reviewFirstModuleCount, result.moduleSettings.filter((item) => /复核/.test(item.reviewModeLabel)).length)
  assert.equal(result.summary.draftOnlyPolicyCount, result.reviewPolicies.length)
  assert.equal(result.summary.dataQualityIssueCount, result.dataQualitySettings.reduce((sum, item) => sum + item.issueCount, 0))
  assert.equal(result.summary.aiBoundaryCount, result.aiAssistanceBoundaries.length)
  assert.equal(result.summary.collaborationPolicyCount, result.collaborationDraftPolicies.length)
  assert.equal(result.summary.configDraftCount, result.setupReviewDrafts.length)
})

test('module settings cover core business modules', () => {
  const labels = buildWorkspaceSetupConfigV2(loadDb()).moduleSettings.map((item) => item.moduleLabel)
  for (const expected of ['今日工作台', 'AI 建议', '采购管理', '库存管理', '供应商管理', '财务协同', '报表与分析', '数据接入与质量', '行动草稿与人工复核', '协同通知草稿', '异常处理工单', '基础资料']) {
    assert.ok(labels.includes(expected), expected)
  }
})

test('review policies align with review-first workflow boundaries', () => {
  const db = loadDb()
  const result = buildWorkspaceSetupConfigV2(db)
  const review = buildReviewFirstActionWorkflowV2(db)
  const boundaries = review.lifecyclePolicy?.boundaryLabels || []
  assert.ok(result.reviewPolicies.length >= Math.min(3, boundaries.length))
  assert.ok(result.reviewPolicies.every((item) => item.reviewRequirement === '需人工复核'))
  assert.ok(result.reviewPolicies.some((item) => item.sourceModule === '行动草稿与人工复核'))
})

test('collaboration policies are sourced from collaboration notification channel policies', () => {
  const db = loadDb()
  const result = buildWorkspaceSetupConfigV2(db)
  const collaboration = buildCollaborationNotificationDraftsV2(db)
  assert.equal(result.collaborationDraftPolicies.length, collaboration.channelPolicies.length)
  assert.ok(result.collaborationDraftPolicies.every((item) => item.previewOnly && item.reviewRequired))
  assert.ok(result.collaborationDraftPolicies.some((item) => item.policyLabel === collaboration.channelPolicies[0].label))
})

test('data quality settings align with Data Access Quality v2 summary', () => {
  const db = loadDb()
  const result = buildWorkspaceSetupConfigV2(db)
  const data = buildDataAccessQualityV2(db)
  assert.ok(result.dataQualitySettings.length >= 2)
  assert.ok(result.dataQualitySettings.some((item) => item.mappedFieldsCount === data.summary.mappedFieldCount))
  assert.ok(result.dataQualitySettings.some((item) => item.issueCount === data.summary.unmappedFieldCount))
  assert.ok(result.dataQualitySettings.every((item) => item.sourceModule === '数据接入与质量'))
})

test('AI assistance boundaries cover suggestion evidence draft and human review', () => {
  const text = visibleText(buildWorkspaceSetupConfigV2(loadDb()).aiAssistanceBoundaries)
  for (const expected of ['AI 建议', '证据整理', '草稿预览', '人工复核']) {
    assert.match(text, new RegExp(expected))
  }
})

test('setup review drafts are preview-only and human reviewed', () => {
  const result = buildWorkspaceSetupConfigV2(loadDb())
  assert.ok(result.setupReviewDrafts.length >= 3)
  assert.ok(result.setupReviewDrafts.every((draft) => draft.previewOnly === true))
  assert.ok(result.setupReviewDrafts.every((draft) => draft.reviewRequired === true))
  assert.ok(result.setupReviewDrafts.every((draft) => draft.requiresHumanReview === true))
})

test('visible workspace setup text avoids forbidden technical wording', () => {
  const text = visibleText(buildWorkspaceSetupConfigV2(loadDb()))
  assert.doesNotMatch(text, FORBIDDEN_WORKSPACE_SETUP_TECHNICAL_PATTERN)
})

test('visible workspace setup text avoids forbidden execution wording', () => {
  const text = visibleText(buildWorkspaceSetupConfigV2(loadDb()))
  assert.doesNotMatch(text, FORBIDDEN_WORKSPACE_SETUP_ACTION_PATTERN)
})

test('empty data returns minimum structure and limitations without throwing', () => {
  const result = buildWorkspaceSetupConfigV2({})
  assert.ok(result.summary)
  assert.ok(result.workspaceProfile)
  assert.ok(result.moduleSettings.length >= 10)
  assert.ok(result.dataLimitations.length >= 1)
  assert.ok(result.setupReviewDrafts.every((draft) => draft.previewOnly && draft.reviewRequired && draft.requiresHumanReview))
})

test('route GET /api/workspace-setup-config returns payload', async () => {
  let status = 0
  let payload = null
  const handled = await handleWorkspaceSetupConfigRoute({
    req: { method: 'GET' },
    res: {},
    url: new URL('/api/workspace-setup-config', 'http://localhost'),
    db: loadDb(),
    send(_res, nextStatus, nextPayload) {
      status = nextStatus
      payload = nextPayload
    },
  })
  assert.equal(handled, true)
  assert.equal(status, 200)
  assert.ok(payload.summary)
  assert.ok(payload.moduleSettings.length >= 10)
})
