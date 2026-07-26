import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import {
  buildUserRolePermissionVisibilityV2,
  FORBIDDEN_ROLE_PERMISSION_ACTION_PATTERN,
  FORBIDDEN_ROLE_PERMISSION_TECHNICAL_PATTERN,
} from './user-role-permission-visibility-v2.mjs'
import { buildWorkspaceSetupConfigV2 } from './workspace-setup-config-v2.mjs'
import { buildReviewFirstActionWorkflowV2 } from './review-first-action-workflow-v2.mjs'
import { handleUserRolePermissionVisibilityRoute } from '../routes/user-role-permission-visibility.routes.mjs'
import { createProductReviewScenarioDb } from './test-fixtures/product-review-scenario.mjs'

function loadDb() {
  return createProductReviewScenarioDb()
}

function visibleText(value) {
  if (Array.isArray(value)) return value.map(visibleText).join(' ')
  if (!value || typeof value !== 'object') return String(value ?? '')
  return Object.entries(value)
    .filter(([key]) => !/roleCode|documentType|draftType|entityType|moduleId|sourceRoute|returnTo|source|payload|provider|id/i.test(key))
    .map(([, item]) => visibleText(item))
    .join(' ')
}

test('role permission visibility returns full top-level contract', () => {
  const result = buildUserRolePermissionVisibilityV2(loadDb())
  for (const key of ['summary', 'roleProfiles', 'permissionBundles', 'documentPermissionMatrix', 'reviewChainVisibility', 'dataScopeGroups', 'moduleVisibilityMatrix', 'reviewPermissionPolicies', 'restrictedActionPolicies', 'permissionReviewDrafts', 'sourceSummary', 'dataLimitations', 'generatedAt', 'dataScopeLabel']) {
    assert.ok(Object.hasOwn(result, key), key)
  }
  assert.equal(result.dataScopeLabel, '当前工作区数据')
  assert.ok(result.roleProfiles.length >= 10)
})

test('summary counts are derived from arrays', () => {
  const result = buildUserRolePermissionVisibilityV2(loadDb())
  assert.equal(result.summary.roleCount, result.roleProfiles.length)
  assert.equal(result.summary.activeUserPreviewCount, result.roleProfiles.reduce((sum, role) => sum + role.userPreviewCount, 0))
  assert.equal(result.summary.permissionBundleCount, result.permissionBundles.length)
  assert.equal(result.summary.documentPermissionCount, result.documentPermissionMatrix.length)
  assert.equal(result.summary.reviewChainCount, result.reviewChainVisibility.length)
  assert.equal(result.summary.dataScopeGroupCount, result.dataScopeGroups.length)
  assert.equal(result.summary.moduleVisibilityCount, result.moduleVisibilityMatrix.length)
  assert.equal(result.summary.reviewPermissionCount, result.reviewPermissionPolicies.length)
  assert.equal(result.summary.restrictedActionCount, result.restrictedActionPolicies.length)
  assert.equal(result.summary.permissionDraftCount, result.permissionReviewDrafts.length)
  assert.equal(result.summary.dataLimitedCount, result.dataLimitations.length)
})

test('role profiles cover procurement collaboration business roles', () => {
  const labels = buildUserRolePermissionVisibilityV2(loadDb()).roleProfiles.map((role) => role.roleLabel)
  for (const expected of ['需求提交人', '采购专员', '寻源负责人', '采购负责人', '收货协同负责人', '库存与计划负责人', '供应商管理负责人', '财务复核负责人', '数据负责人', '系统配置复核人', '管理层只读观察者']) {
    assert.ok(labels.includes(expected), expected)
  }
})

test('role profiles avoid generic role naming', () => {
  const result = buildUserRolePermissionVisibilityV2(loadDb())
  const roleNames = result.roleProfiles.map((role) => `${role.roleCode} ${role.roleLabel}`).join(' ')
  assert.doesNotMatch(roleNames, /\badmin\b|\buser\b|\bviewer\b/i)
})

test('permission bundles cover required duty packages', () => {
  const labels = buildUserRolePermissionVisibilityV2(loadDb()).permissionBundles.map((bundle) => bundle.bundleLabel)
  assert.ok(labels.length >= 8)
  for (const expected of ['需求提交职责包', '采购执行职责包', '寻源复核职责包', '收货协同职责包', '库存计划职责包', '供应商管理职责包', '财务复核职责包', '数据治理职责包', '系统配置复核职责包', '管理层只读职责包']) {
    assert.ok(labels.includes(expected), expected)
  }
})

test('document permission matrix covers core business objects', () => {
  const labels = buildUserRolePermissionVisibilityV2(loadDb()).documentPermissionMatrix.map((row) => row.documentLabel)
  for (const expected of ['PR', 'RFQ', 'PO', 'GRN', 'Invoice', 'Supplier Operational Profile', 'SKU / Inventory', 'AI Suggestion', 'Action Draft', 'Collaboration Draft', 'Workspace Config Draft']) {
    assert.ok(labels.includes(expected), expected)
  }
})

test('review chain visibility covers procurement receiving invoice supplier data and config chains', () => {
  const text = visibleText(buildUserRolePermissionVisibilityV2(loadDb()).reviewChainVisibility)
  for (const expected of ['RFQ 授标建议复核', 'PO 到货异常复核', 'Invoice 差异复核', 'Supplier 风险复核', 'Data Quality 补齐复核', 'Workspace Config 变更复核']) {
    assert.match(text, new RegExp(expected))
  }
})

test('data scope groups cover required business data ranges', () => {
  const labels = buildUserRolePermissionVisibilityV2(loadDb()).dataScopeGroups.map((scope) => scope.scopeLabel)
  for (const expected of ['采购数据范围', '库存数据范围', '供应商数据范围', '财务协同数据范围', '数据接入质量范围', '管理层汇总范围']) {
    assert.ok(labels.includes(expected), expected)
  }
})

test('module visibility matrix covers at least ten modules', () => {
  const labels = buildUserRolePermissionVisibilityV2(loadDb()).moduleVisibilityMatrix.map((row) => row.moduleLabel)
  assert.ok(labels.length >= 10)
  for (const expected of ['今日工作台', 'AI 建议', '采购管理', '库存管理', '供应商管理', '财务协同', '报表与分析', '数据接入与质量', '行动草稿与人工复核', '协同通知草稿', '系统设置']) {
    assert.ok(labels.includes(expected), expected)
  }
})

test('review permission policies align with workspace setup and review workflow', () => {
  const db = loadDb()
  const result = buildUserRolePermissionVisibilityV2(db)
  const workspace = buildWorkspaceSetupConfigV2(db)
  const review = buildReviewFirstActionWorkflowV2(db)
  assert.ok(result.reviewPermissionPolicies.length >= Math.min(4, workspace.reviewPolicies.length))
  assert.ok(result.reviewPermissionPolicies.some((policy) => policy.sourceModule === '工作区配置'))
  assert.ok(result.reviewPermissionPolicies.some((policy) => policy.sourceModule === '行动草稿与人工复核'))
  assert.ok(review.lifecyclePolicy)
})

test('restricted action policies cover key business boundaries', () => {
  const text = visibleText(buildUserRolePermissionVisibilityV2(loadDb()).restrictedActionPolicies)
  for (const expected of ['采购正式处理边界', '库存处理边界', '财务处理边界', '供应商资料边界', '数据覆盖边界', '协同草稿边界', '配置与权限边界', 'AI 建议边界']) {
    assert.match(text, new RegExp(expected))
  }
})

test('permission review drafts are preview-only and human reviewed', () => {
  const drafts = buildUserRolePermissionVisibilityV2(loadDb()).permissionReviewDrafts
  assert.ok(drafts.length >= 5)
  assert.ok(drafts.every((draft) => draft.previewOnly === true))
  assert.ok(drafts.every((draft) => draft.reviewRequired === true))
  assert.ok(drafts.every((draft) => draft.requiresHumanReview === true))
})

test('visible text avoids forbidden technical wording and named external model terms', () => {
  const text = visibleText(buildUserRolePermissionVisibilityV2(loadDb()))
  assert.doesNotMatch(text, FORBIDDEN_ROLE_PERMISSION_TECHNICAL_PATTERN)
  assert.doesNotMatch(text, /Coupa|RBAC/i)
})

test('visible text avoids forbidden execution wording', () => {
  const text = visibleText(buildUserRolePermissionVisibilityV2(loadDb()))
  assert.doesNotMatch(text, FORBIDDEN_ROLE_PERMISSION_ACTION_PATTERN)
})

test('empty data returns minimum structure and limitations without throwing', () => {
  const result = buildUserRolePermissionVisibilityV2({})
  assert.ok(result.summary)
  assert.ok(result.roleProfiles.length >= 10)
  assert.ok(result.permissionReviewDrafts.every((draft) => draft.previewOnly && draft.reviewRequired && draft.requiresHumanReview))
  assert.ok(result.dataLimitations.length >= 1)
})

test('route GET /api/user-role-permission-visibility returns payload', async () => {
  let status = 0
  let payload = null
  const handled = await handleUserRolePermissionVisibilityRoute({
    req: { method: 'GET' },
    res: {},
    url: new URL('/api/user-role-permission-visibility', 'http://localhost'),
    db: loadDb(),
    send(_res, nextStatus, nextPayload) {
      status = nextStatus
      payload = nextPayload
    },
  })
  assert.equal(handled, true)
  assert.equal(status, 200)
  assert.ok(payload.summary)
  assert.ok(payload.roleProfiles.length >= 10)
})
