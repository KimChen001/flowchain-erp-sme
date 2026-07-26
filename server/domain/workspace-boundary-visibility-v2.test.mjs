import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import {
  buildWorkspaceBoundaryVisibilityV2,
  FORBIDDEN_WORKSPACE_BOUNDARY_ACTION_PATTERN,
  FORBIDDEN_WORKSPACE_BOUNDARY_TECHNICAL_PATTERN,
} from './workspace-boundary-visibility-v2.mjs'
import { buildCollaborationNotificationDraftsV2 } from './collaboration-notification-drafts-v2.mjs'
import { buildDataAccessQualityV2 } from './data-access-quality-v2.mjs'
import { buildUserRolePermissionVisibilityV2 } from './user-role-permission-visibility-v2.mjs'
import { handleWorkspaceBoundaryVisibilityRoute } from '../routes/workspace-boundary-visibility.routes.mjs'
import { createProductReviewScenarioDb } from './test-fixtures/product-review-scenario.mjs'

function loadDb() {
  return createProductReviewScenarioDb()
}

function visibleText(value) {
  if (Array.isArray(value)) return value.map(visibleText).join(' ')
  if (!value || typeof value !== 'object') return String(value ?? '')
  return Object.entries(value)
    .filter(([key]) => !/id|entityType|documentType|draftType|moduleId|sourceRoute|returnTo|source|payload|provider/i.test(key))
    .map(([, item]) => visibleText(item))
    .join(' ')
}

test('workspace boundary visibility returns full top-level contract', () => {
  const result = buildWorkspaceBoundaryVisibilityV2(loadDb())
  for (const key of ['summary', 'workspaceBoundaryProfile', 'boundaryScopes', 'dataOwnershipGroups', 'moduleBoundaryMatrix', 'documentBoundaryMatrix', 'aiBoundaryAwareness', 'collaborationBoundaryPolicies', 'roleBoundaryVisibility', 'dataQualityBoundarySignals', 'boundaryReviewDrafts', 'sourceSummary', 'dataLimitations', 'generatedAt', 'dataScopeLabel']) {
    assert.ok(Object.hasOwn(result, key), key)
  }
  assert.equal(result.dataScopeLabel, '当前工作区数据')
})

test('summary counts are derived from arrays', () => {
  const result = buildWorkspaceBoundaryVisibilityV2(loadDb())
  assert.equal(result.summary.boundaryScopeCount, result.boundaryScopes.length)
  assert.equal(result.summary.dataOwnershipGroupCount, result.dataOwnershipGroups.length)
  assert.equal(result.summary.moduleBoundaryCount, result.moduleBoundaryMatrix.length)
  assert.equal(result.summary.documentBoundaryCount, result.documentBoundaryMatrix.length)
  assert.equal(result.summary.aiBoundarySignalCount, result.aiBoundaryAwareness.length)
  assert.equal(result.summary.collaborationBoundaryCount, result.collaborationBoundaryPolicies.length)
  assert.equal(result.summary.roleBoundaryCount, result.roleBoundaryVisibility.length)
  assert.equal(result.summary.dataQualityBoundaryIssueCount, result.dataQualityBoundarySignals.length)
  assert.equal(result.summary.boundaryDraftCount, result.boundaryReviewDrafts.length)
  assert.equal(result.summary.dataLimitedCount, result.dataLimitations.length)
})

test('boundary scopes cover required workspace boundaries', () => {
  const labels = buildWorkspaceBoundaryVisibilityV2(loadDb()).boundaryScopes.map((scope) => scope.scopeLabel)
  for (const expected of ['采购业务边界', '库存业务边界', '供应商业务边界', '财务协同边界', '数据接入质量边界', 'AI 建议边界', '协同通知草稿边界', '角色权限边界', '工作区配置边界']) {
    assert.ok(labels.includes(expected), expected)
  }
})

test('data ownership groups cover required ownership ranges', () => {
  const labels = buildWorkspaceBoundaryVisibilityV2(loadDb()).dataOwnershipGroups.map((group) => group.ownerLabel)
  for (const expected of ['采购数据归属', '收货与库存数据归属', '供应商数据归属', '财务复核数据归属', '数据质量归属', '配置与权限边界归属', '管理层观察范围']) {
    assert.ok(labels.includes(expected), expected)
  }
})

test('module boundary matrix covers core modules', () => {
  const labels = buildWorkspaceBoundaryVisibilityV2(loadDb()).moduleBoundaryMatrix.map((row) => row.moduleLabel)
  assert.ok(labels.length >= 12)
  for (const expected of ['今日工作台', 'AI 建议', '采购管理', '库存管理', '供应商管理', '财务协同', '报表与分析', '数据接入与质量', '行动草稿与人工复核', '协同通知草稿', '系统设置', '角色权限可见性']) {
    assert.ok(labels.includes(expected), expected)
  }
})

test('document boundary matrix covers core business objects', () => {
  const labels = buildWorkspaceBoundaryVisibilityV2(loadDb()).documentBoundaryMatrix.map((row) => row.objectLabel)
  for (const expected of ['PR', 'RFQ', 'PO', 'GRN', 'Invoice', 'Supplier Operational Profile', 'SKU / Inventory', 'AI Suggestion', 'Action Draft', 'Collaboration Draft', 'Workspace Config Draft', 'Permission Review Draft', 'Boundary Review Draft']) {
    assert.ok(labels.includes(expected), expected)
  }
})

test('AI boundary awareness covers evidence limitation draft workspace collaboration and write boundaries', () => {
  const text = visibleText(buildWorkspaceBoundaryVisibilityV2(loadDb()).aiBoundaryAwareness)
  for (const expected of ['AI 建议只基于当前工作区数据', 'AI 解释必须显示关键证据', 'AI 建议必须显示数据限制', 'AI 草稿只进入人工复核', 'AI 不形成正式业务处理', 'AI 不跨工作区推断', 'AI 不外发协同通知', 'AI 不改主数据 / 不写库存 / 不写财务凭证']) {
    assert.match(text, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  }
})

test('collaboration boundary policies come from collaboration channel policies', () => {
  const db = loadDb()
  const result = buildWorkspaceBoundaryVisibilityV2(db)
  const collaboration = buildCollaborationNotificationDraftsV2(db)
  assert.equal(result.collaborationBoundaryPolicies.length, collaboration.channelPolicies.length)
  assert.ok(result.collaborationBoundaryPolicies.every((policy) => policy.previewOnly && policy.reviewRequired))
})

test('role boundary visibility comes from role profiles', () => {
  const db = loadDb()
  const result = buildWorkspaceBoundaryVisibilityV2(db)
  const roles = buildUserRolePermissionVisibilityV2(db)
  assert.equal(result.roleBoundaryVisibility.length, roles.roleProfiles.length)
  assert.ok(result.roleBoundaryVisibility.some((role) => role.roleLabel === '采购负责人'))
})

test('data quality boundary signals come from Data Access Quality v2', () => {
  const db = loadDb()
  const result = buildWorkspaceBoundaryVisibilityV2(db)
  const data = buildDataAccessQualityV2(db)
  assert.ok(result.dataQualityBoundarySignals.length >= 3)
  assert.ok(result.dataQualityBoundarySignals.some((signal) => signal.signalLabel === '字段映射边界'))
  assert.match(visibleText(result.dataQualityBoundarySignals), new RegExp(String(data.summary.unmappedFieldCount)))
})

test('boundary review drafts are preview-only and human reviewed', () => {
  const drafts = buildWorkspaceBoundaryVisibilityV2(loadDb()).boundaryReviewDrafts
  assert.ok(drafts.length >= 6)
  assert.ok(drafts.every((draft) => draft.previewOnly === true))
  assert.ok(drafts.every((draft) => draft.reviewRequired === true))
  assert.ok(drafts.every((draft) => draft.requiresHumanReview === true))
})

test('visible text avoids forbidden technical wording and named external model terms', () => {
  const text = visibleText(buildWorkspaceBoundaryVisibilityV2(loadDb()))
  assert.doesNotMatch(text, FORBIDDEN_WORKSPACE_BOUNDARY_TECHNICAL_PATTERN)
  assert.doesNotMatch(text, /Coupa|RBAC/i)
})

test('visible text avoids forbidden execution wording', () => {
  const text = visibleText(buildWorkspaceBoundaryVisibilityV2(loadDb()))
  assert.doesNotMatch(text, FORBIDDEN_WORKSPACE_BOUNDARY_ACTION_PATTERN)
})

test('empty data returns minimum structure and limitations without throwing', () => {
  const result = buildWorkspaceBoundaryVisibilityV2({})
  assert.ok(result.summary)
  assert.ok(result.boundaryScopes.length >= 9)
  assert.ok(result.dataLimitations.length >= 1)
  assert.ok(result.boundaryReviewDrafts.every((draft) => draft.previewOnly && draft.reviewRequired && draft.requiresHumanReview))
})

test('route GET /api/workspace-boundary-visibility returns payload', async () => {
  let status = 0
  let payload = null
  const handled = await handleWorkspaceBoundaryVisibilityRoute({
    req: { method: 'GET' },
    res: {},
    url: new URL('/api/workspace-boundary-visibility', 'http://localhost'),
    db: loadDb(),
    send(_res, nextStatus, nextPayload) {
      status = nextStatus
      payload = nextPayload
    },
  })
  assert.equal(handled, true)
  assert.equal(status, 200)
  assert.ok(payload.summary)
  assert.ok(payload.boundaryScopes.length >= 9)
})
