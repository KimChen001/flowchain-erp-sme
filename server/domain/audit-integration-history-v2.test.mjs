import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import {
  buildAuditIntegrationHistoryV2,
  FORBIDDEN_AUDIT_HISTORY_ACTION_PATTERN,
  FORBIDDEN_AUDIT_HISTORY_TECHNICAL_PATTERN,
} from './audit-integration-history-v2.mjs'
import { handleAuditIntegrationHistoryRoute } from '../routes/audit-integration-history.routes.mjs'
import { createProductReviewScenarioDb } from './test-fixtures/product-review-scenario.mjs'

function loadDb() {
  return createProductReviewScenarioDb()
}

function visibleText(value) {
  if (Array.isArray(value)) return value.map(visibleText).join(' ')
  if (!value || typeof value !== 'object') return String(value ?? '')
  return Object.entries(value)
    .filter(([key]) => !/^(id|entityType|documentType|draftType|moduleId|sourceRoute|returnContext|returnTo|source|payload|provider)$/i.test(key))
    .map(([, item]) => visibleText(item))
    .join(' ')
}

test('audit integration history returns full top-level contract', () => {
  const result = buildAuditIntegrationHistoryV2(loadDb())
  for (const key of ['summary', 'historyProfile', 'timeline', 'aiSuggestionHistory', 'reviewDraftHistory', 'collaborationDraftHistory', 'dataAccessHistory', 'settingsGovernanceHistory', 'rolePermissionHistory', 'boundaryReviewHistory', 'businessObjectHistory', 'sourceSummary', 'dataLimitations', 'generatedAt', 'dataScopeLabel']) {
    assert.ok(Object.hasOwn(result, key), key)
  }
  assert.equal(result.dataScopeLabel, '当前工作区数据')
})

test('summary counts are derived from arrays', () => {
  const result = buildAuditIntegrationHistoryV2(loadDb())
  assert.equal(result.summary.totalHistoryCount, result.timeline.length)
  assert.equal(result.summary.aiHistoryCount, result.aiSuggestionHistory.length)
  assert.equal(result.summary.collaborationHistoryCount, result.collaborationDraftHistory.length)
  assert.equal(result.summary.dataQualityHistoryCount, result.dataAccessHistory.length)
  assert.equal(result.summary.setupGovernanceHistoryCount, result.settingsGovernanceHistory.length)
  assert.equal(result.summary.rolePermissionHistoryCount, result.rolePermissionHistory.length)
  assert.equal(result.summary.boundaryHistoryCount, result.boundaryReviewHistory.length)
  assert.equal(result.summary.businessObjectHistoryCount, result.businessObjectHistory.length)
  assert.equal(result.summary.reviewRequiredCount, result.timeline.filter((item) => item.reviewRequired).length)
})

test('timeline covers required history categories', () => {
  const labels = new Set(buildAuditIntegrationHistoryV2(loadDb()).timeline.map((item) => item.categoryLabel))
  for (const expected of ['AI 建议历史', '行动草稿历史', '协同草稿历史', '数据质量历史', '工作区配置历史', '角色权限历史', '工作区边界历史', '采购对象历史']) {
    assert.ok(labels.has(expected), expected)
  }
})

test('AI suggestion history comes from AI Suggestions Workbench', () => {
  const result = buildAuditIntegrationHistoryV2(loadDb())
  assert.ok(result.aiSuggestionHistory.length > 0)
  assert.match(visibleText(result.aiSuggestionHistory), /AI 建议|关键证据|业务影响|进入人工复核/)
})

test('review draft history covers action setup permission and boundary drafts', () => {
  const text = visibleText(buildAuditIntegrationHistoryV2(loadDb()).reviewDraftHistory)
  for (const expected of ['行动草稿', '配置复核草稿', '权限复核草稿', '边界复核草稿']) {
    assert.match(text, new RegExp(expected))
  }
})

test('collaboration draft history comes from Collaboration Notification Drafts', () => {
  const text = visibleText(buildAuditIntegrationHistoryV2(loadDb()).collaborationDraftHistory)
  for (const expected of ['内部协同备注', '供应商沟通草稿', '报表洞察复核说明', '数据质量说明']) {
    assert.match(text, new RegExp(expected))
  }
})

test('data access history covers field quality completion evidence and downstream impact', () => {
  const text = visibleText(buildAuditIntegrationHistoryV2(loadDb()).dataAccessHistory)
  for (const expected of ['字段映射历史', '数据质量事项历史', '数据补齐', '证据缺口', 'AI 建议', '报表与分析', '草稿']) {
    assert.match(text, new RegExp(expected))
  }
})

test('settings governance history comes from Workspace Setup', () => {
  const text = visibleText(buildAuditIntegrationHistoryV2(loadDb()).settingsGovernanceHistory)
  for (const expected of ['模块启用状态历史', '复核策略历史', '编号规则历史', 'AI 边界历史', '协同草稿策略历史', '数据质量设置历史', '配置复核草稿历史']) {
    assert.match(text, new RegExp(expected))
  }
})

test('role permission history comes from User Role Permission Visibility', () => {
  const text = visibleText(buildAuditIntegrationHistoryV2(loadDb()).rolePermissionHistory)
  for (const expected of ['业务角色历史', '职责包历史', '单据权限矩阵历史', '数据范围分组历史', '权限复核草稿历史']) {
    assert.match(text, new RegExp(expected))
  }
})

test('boundary review history comes from Workspace Boundary Visibility', () => {
  const text = visibleText(buildAuditIntegrationHistoryV2(loadDb()).boundaryReviewHistory)
  for (const expected of ['工作区边界范围历史', '数据归属历史', '模块边界历史', '业务对象边界历史', 'AI 边界意识历史', '协同边界策略历史', '角色边界可见性历史', '数据质量边界信号历史', '边界复核草稿历史']) {
    assert.match(text, new RegExp(expected))
  }
})

test('business object history covers required objects', () => {
  const labels = buildAuditIntegrationHistoryV2(loadDb()).businessObjectHistory.map((item) => item.objectLabel)
  for (const expected of ['PR', 'RFQ', 'PO', 'GRN', 'Invoice', 'Supplier Operational Profile', 'SKU / Inventory', 'AI Suggestion', 'Action Draft', 'Collaboration Draft', 'Workspace Config Draft']) {
    assert.ok(labels.includes(expected), expected)
  }
})

test('all draft history items are preview-only and human reviewed', () => {
  const drafts = buildAuditIntegrationHistoryV2(loadDb()).reviewDraftHistory
  assert.ok(drafts.length > 0)
  assert.ok(drafts.every((draft) => draft.previewOnly === true))
  assert.ok(drafts.every((draft) => draft.reviewRequired === true))
  assert.ok(drafts.every((draft) => draft.requiresHumanReview === true))
})

test('visible text avoids forbidden technical wording and external model terms', () => {
  const text = visibleText(buildAuditIntegrationHistoryV2(loadDb()))
  assert.doesNotMatch(text, FORBIDDEN_AUDIT_HISTORY_TECHNICAL_PATTERN)
  assert.doesNotMatch(text, /Coupa|RBAC/i)
})

test('visible text avoids forbidden execution wording', () => {
  const text = visibleText(buildAuditIntegrationHistoryV2(loadDb()))
  assert.doesNotMatch(text, FORBIDDEN_AUDIT_HISTORY_ACTION_PATTERN)
})

test('empty data returns minimum structure and limitations without throwing', () => {
  const result = buildAuditIntegrationHistoryV2({})
  assert.ok(result.summary)
  assert.ok(Array.isArray(result.timeline))
  assert.ok(result.dataLimitations.length >= 1)
  assert.ok(result.reviewDraftHistory.every((draft) => draft.previewOnly && draft.reviewRequired && draft.requiresHumanReview))
})

test('route GET /api/audit-integration-history returns payload', async () => {
  let status = 0
  let payload = null
  const handled = await handleAuditIntegrationHistoryRoute({
    req: { method: 'GET' },
    res: {},
    url: new URL('/api/audit-integration-history', 'http://localhost'),
    db: loadDb(),
    send(_res, nextStatus, nextPayload) {
      status = nextStatus
      payload = nextPayload
    },
  })
  assert.equal(handled, true)
  assert.equal(status, 200)
  assert.ok(payload.summary)
  assert.ok(payload.timeline.length > 0)
})
