import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import {
  buildPilotReadinessGovernanceV2,
  FORBIDDEN_PILOT_READINESS_ACTION_PATTERN,
  FORBIDDEN_PILOT_READINESS_TECHNICAL_PATTERN,
} from './pilot-readiness-governance-v2.mjs'
import { handlePilotReadinessGovernanceRoute } from '../routes/pilot-readiness-governance.routes.mjs'
import { createProductReviewScenarioDb } from './test-fixtures/product-review-scenario.mjs'

function loadDb() {
  return createProductReviewScenarioDb()
}

function visibleText(value) {
  if (Array.isArray(value)) return value.map(visibleText).join(' ')
  if (!value || typeof value !== 'object') return String(value ?? '')
  return Object.entries(value)
    .filter(([key]) => !/^(id|moduleId|entityType|entityId|sourceRoute|returnContext|returnTo|source|draftType|payload|provider)$/i.test(key))
    .map(([, item]) => visibleText(item))
    .join(' ')
}

test('pilot readiness governance returns full top-level contract', () => {
  const result = buildPilotReadinessGovernanceV2(loadDb())
  for (const key of ['summary', 'readinessProfile', 'pilotScope', 'moduleReadinessMatrix', 'dataReadinessAssessment', 'aiReadinessAssessment', 'reviewWorkflowReadiness', 'collaborationReadiness', 'governanceReadiness', 'auditHistoryReadiness', 'riskAndBlockerItems', 'pilotReviewChecklist', 'pilotReviewDrafts', 'sourceSummary', 'dataLimitations', 'generatedAt', 'dataScopeLabel']) {
    assert.ok(Object.hasOwn(result, key), key)
  }
  assert.equal(result.dataScopeLabel, '当前工作区数据')
})

test('summary numbers and scores are derived from arrays', () => {
  const result = buildPilotReadinessGovernanceV2(loadDb())
  const avg = (items) => Math.round(items.reduce((sum, item) => sum + item.readinessScore, 0) / items.length)
  assert.equal(result.summary.readyModuleCount, result.moduleReadinessMatrix.filter((item) => item.readinessStatus === '可进入试点观察').length)
  assert.equal(result.summary.reviewNeededModuleCount, result.moduleReadinessMatrix.length - result.summary.readyModuleCount)
  assert.equal(result.summary.blockedItemCount, result.riskAndBlockerItems.filter((item) => item.severity === '阻塞项').length)
  assert.equal(result.summary.observationItemCount, result.riskAndBlockerItems.filter((item) => item.severity === '观察项').length)
  assert.equal(result.summary.dataReadinessScore, avg(result.dataReadinessAssessment))
  assert.equal(result.summary.aiReadinessScore, avg(result.aiReadinessAssessment))
  assert.equal(result.summary.pilotDraftCount, result.pilotReviewDrafts.length)
  assert.equal(result.summary.dataLimitedCount, result.dataLimitations.length)
})

test('pilot scope covers core modules business objects and excluded activities', () => {
  const scope = buildPilotReadinessGovernanceV2(loadDb()).pilotScope
  for (const expected of ['今日工作台', 'AI 建议', '采购管理', '库存管理', '供应商管理', '财务协同', '报表与分析', '数据接入与质量', '行动草稿与人工复核', '协同通知草稿', '系统设置', '角色权限可见性', '工作区边界', '业务审计与历史']) {
    assert.ok(scope.includedModules.includes(expected), expected)
  }
  for (const expected of ['PR', 'RFQ', 'PO', 'GRN', 'Invoice', 'Three-way Match', 'Supplier Operational Profile', 'SKU / Inventory', 'AI Suggestion', 'Action Draft', 'Collaboration Draft', 'Workspace Config Draft', 'Permission Review Draft', 'Boundary Review Draft']) {
    assert.ok(scope.includedBusinessObjects.includes(expected), expected)
  }
  for (const expected of ['不形成正式业务处理', '不外发', '不写库存', '不写财务凭证', '不处理资金', '不改主数据', '不覆盖当前工作区数据']) {
    assert.ok(scope.excludedActivities.includes(expected), expected)
  }
})

test('module readiness matrix covers required modules with business statuses', () => {
  const rows = buildPilotReadinessGovernanceV2(loadDb()).moduleReadinessMatrix
  assert.ok(rows.length >= 12)
  const labels = rows.map((item) => item.moduleLabel)
  for (const expected of ['今日工作台', 'AI 建议', '采购管理', '库存管理', '供应商管理', '财务协同', '报表与分析', '数据接入与质量', '行动草稿与人工复核', '协同通知草稿', '系统设置', '角色权限可见性', '工作区边界', '业务审计与历史']) {
    assert.ok(labels.includes(expected), expected)
  }
  assert.ok(rows.every((item) => ['可进入试点观察', '需人工复核', '需补充数据', '需治理确认'].includes(item.readinessStatus)))
})

test('data readiness comes from Data Access Boundary and Audit', () => {
  const text = visibleText(buildPilotReadinessGovernanceV2(loadDb()).dataReadinessAssessment)
  for (const expected of ['字段映射准备度', '数据质量事项准备度', '采购证据准备度', '收货 / 发票关联准备度', '供应商资料准备度', 'AI / 报表 / 草稿数据限制准备度', '数据接入与质量', '工作区边界', '业务审计与历史']) {
    assert.match(text, new RegExp(expected))
  }
})

test('AI readiness comes from AI Suggestions Audit and Review-first', () => {
  const text = visibleText(buildPilotReadinessGovernanceV2(loadDb()).aiReadinessAssessment)
  for (const expected of ['今日事项解释', '供应商风险解释', '库存风险解释', 'PO / GRN / Invoice 证据解释', '数据限制解释', '草稿预览生成', '人工复核跳转', 'AI 只解释、组织证据、生成草稿预览']) {
    assert.match(text, new RegExp(expected))
  }
})

test('review workflow readiness comes from Review-first Workspace Setup and Audit', () => {
  const text = visibleText(buildPilotReadinessGovernanceV2(loadDb()).reviewWorkflowReadiness)
  for (const expected of ['行动草稿复核', '配置复核草稿', '权限复核草稿', '边界复核草稿', '协同通知草稿复核']) {
    assert.match(text, new RegExp(expected))
  }
})

test('collaboration readiness comes from Collaboration Drafts and Audit', () => {
  const text = visibleText(buildPilotReadinessGovernanceV2(loadDb()).collaborationReadiness)
  for (const expected of ['内部协同备注', '供应商沟通草稿', '财务复核说明', '数据质量说明', '收货异常说明', '库存复核说明', '报表洞察复核说明']) {
    assert.match(text, new RegExp(expected))
  }
})

test('governance readiness comes from Workspace Setup Role Permission and Boundary', () => {
  const text = visibleText(buildPilotReadinessGovernanceV2(loadDb()).governanceReadiness)
  for (const expected of ['工作区配置准备度', '角色权限可见性准备度', '工作区边界准备度', '编号规则准备度', 'AI 边界准备度', '协同草稿策略准备度', '数据质量设置准备度']) {
    assert.match(text, new RegExp(expected))
  }
})

test('audit history readiness comes from Audit Integration History', () => {
  const text = visibleText(buildPilotReadinessGovernanceV2(loadDb()).auditHistoryReadiness)
  for (const expected of ['AI 建议历史', '草稿复核历史', '协同草稿历史', '数据接入历史', '设置与权限历史', '工作区边界历史', '业务对象历史']) {
    assert.match(text, new RegExp(expected))
  }
})

test('risk and blocker items cover required areas', () => {
  const text = visibleText(buildPilotReadinessGovernanceV2(loadDb()).riskAndBlockerItems)
  for (const expected of ['数据质量阻塞项', 'AI 数据限制复核项', '行动草稿待复核项', '协同草稿边界复核项', '角色权限复核项', '工作区边界复核项', '审计历史覆盖观察项', '供应商风险观察项', '财务差异观察项']) {
    assert.match(text, new RegExp(expected))
  }
  for (const expected of ['阻塞项', '需复核', '观察项']) assert.match(text, new RegExp(expected))
})

test('checklist and review drafts are review-first', () => {
  const result = buildPilotReadinessGovernanceV2(loadDb())
  assert.ok(result.pilotReviewChecklist.length >= 10)
  const checklistText = visibleText(result.pilotReviewChecklist)
  for (const expected of ['今日工作台范围确认', 'AI 建议边界确认', '数据质量确认', '行动草稿复核链路确认', '协同通知草稿边界确认', '角色权限可见性确认', '工作区边界确认', '业务审计与历史确认', '采购对象证据确认', '供应商运营档案确认', '财务协同证据确认']) {
    assert.match(checklistText, new RegExp(expected))
  }
  assert.ok(result.pilotReviewDrafts.length >= 7)
  assert.ok(result.pilotReviewDrafts.every((draft) => draft.previewOnly === true))
  assert.ok(result.pilotReviewDrafts.every((draft) => draft.reviewRequired === true))
  assert.ok(result.pilotReviewDrafts.every((draft) => draft.requiresHumanReview === true))
})

test('visible text avoids forbidden wording', () => {
  const text = visibleText(buildPilotReadinessGovernanceV2(loadDb()))
  assert.doesNotMatch(text, FORBIDDEN_PILOT_READINESS_TECHNICAL_PATTERN)
  assert.doesNotMatch(text, FORBIDDEN_PILOT_READINESS_ACTION_PATTERN)
  assert.doesNotMatch(text, /Coupa|RBAC|production|deploy|go-live/i)
})

test('empty data returns minimum structure and limitations without throwing', () => {
  const result = buildPilotReadinessGovernanceV2({})
  assert.ok(result.summary)
  assert.ok(result.readinessProfile)
  assert.ok(result.moduleReadinessMatrix.length >= 12)
  assert.ok(result.dataLimitations.length >= 1)
  assert.ok(result.pilotReviewDrafts.every((draft) => draft.previewOnly && draft.reviewRequired && draft.requiresHumanReview))
})

test('route GET /api/pilot-readiness-governance returns payload', async () => {
  let status = 0
  let payload = null
  const handled = await handlePilotReadinessGovernanceRoute({
    req: { method: 'GET' },
    res: {},
    url: new URL('/api/pilot-readiness-governance', 'http://localhost'),
    db: loadDb(),
    send(_res, nextStatus, nextPayload) {
      status = nextStatus
      payload = nextPayload
    },
  })
  assert.equal(handled, true)
  assert.equal(status, 200)
  assert.ok(payload.summary)
  assert.ok(payload.pilotReviewDrafts.length > 0)
})
