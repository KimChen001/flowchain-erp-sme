import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { buildCurrentContext, permissionsForUser } from './context.mjs'
import {
  ROUTE_CLASSES,
  classifyRoute,
  isDatabaseModeWriteBlocked,
} from './route-classification.mjs'

const actionDraftShell = readFileSync(new URL('../../src/modules/action-drafts/ActionDraftReviewShell.tsx', import.meta.url), 'utf8')
const forecastPage = readFileSync(new URL('../../src/modules/forecast/Page.tsx', import.meta.url), 'utf8')

test('Alpha role context exposes lightweight boundaries without production RBAC claims', () => {
  const roles = [
    ['viewer', { canPrepareDrafts: false, canReviewActionDrafts: false, canSaveActionDraftShells: false, canApproveDocuments: false }],
    ['planner', { canPrepareDrafts: true, canReviewActionDrafts: true, canSaveActionDraftShells: true, canApproveDocuments: false }],
    ['buyer', { canPrepareDrafts: true, canReviewActionDrafts: true, canSaveActionDraftShells: true, canApproveDocuments: false }],
    ['approver', { canPrepareDrafts: true, canReviewActionDrafts: true, canSaveActionDraftShells: true, canApproveDocuments: true }],
    ['admin', { canPrepareDrafts: true, canReviewActionDrafts: true, canSaveActionDraftShells: true, canApproveDocuments: true }],
  ]

  for (const [role, expected] of roles) {
    const permissions = permissionsForUser({ role })

    assert.equal(permissions.role, role)
    assert.equal(permissions.alphaBoundary, 'read_preview_draft_save_only_no_final_business_confirmation')
    assert.equal(permissions.canViewReadModels, true)
    assert.equal(permissions.canSubmitDocuments, false, role)
    assert.equal(permissions.canSubmitBusinessDocuments, false, role)
    assert.equal(permissions.canPrepareDrafts, expected.canPrepareDrafts, role)
    assert.equal(permissions.canReviewActionDrafts, expected.canReviewActionDrafts, role)
    assert.equal(permissions.canSaveActionDraftShells, expected.canSaveActionDraftShells, role)
    assert.equal(permissions.canApproveDocuments, expected.canApproveDocuments, role)
  }
})

test('current context strips bearer token and maps manager to approver boundary', () => {
  const context = buildCurrentContext({
    users: [{
      id: 'USR-MGR',
      token: 'secret-token',
      name: 'Morgan Manager',
      email: 'morgan@example.com',
      role: 'manager',
    }],
  }, 'Bearer secret-token')

  assert.equal(context.user.id, 'USR-MGR')
  assert.equal(context.user.token, undefined)
  assert.equal(context.permissionsContext.role, 'approver')
  assert.equal(context.permissionsContext.canApproveDocuments, true)
  assert.equal(context.permissionsContext.canSubmitBusinessDocuments, false)
})

test('Alpha permission gate keeps legacy mutations blocked and preview routes distinct', () => {
  const legacyMutations = [
    ['POST', '/api/purchase-requests'],
    ['PATCH', '/api/purchase-requests/PR-1/status'],
    ['POST', '/api/purchase-requests/PR-1/convert-to-po'],
    ['POST', '/api/rfqs'],
    ['PATCH', '/api/rfqs/RFQ-1/status'],
    ['POST', '/api/purchase-orders'],
    ['PATCH', '/api/purchase-orders/PO-1/status'],
    ['POST', '/api/receiving-docs'],
    ['PATCH', '/api/receiving-docs/GRN-1'],
  ]

  for (const [method, pathname] of legacyMutations) {
    assert.equal(classifyRoute(method, pathname).classification, ROUTE_CLASSES.legacyMutation, pathname)
    assert.equal(isDatabaseModeWriteBlocked({ persistenceMode: 'database', method, pathname }), true, pathname)
  }

  for (const [method, pathname] of [['GET', '/api/mrp-plan'], ['POST', '/api/forecast-plans'], ['POST', '/api/sop-cycle']]) {
    assert.equal(classifyRoute(method, pathname).classification, ROUTE_CLASSES.capabilityDisabled, pathname)
    assert.equal(isDatabaseModeWriteBlocked({ persistenceMode: 'database', method, pathname }), false, pathname)
  }

  assert.equal(classifyRoute('POST', '/api/action-drafts/preview').classification, ROUTE_CLASSES.previewOnly)
  assert.equal(classifyRoute('POST', '/api/action-drafts/save').classification, ROUTE_CLASSES.controlledPersistence)
  assert.equal(classifyRoute('POST', '/api/action-drafts/save').databaseMode, 'allowed-db-persistence')
  assert.equal(classifyRoute('GET', '/api/mrp-plan').classification, ROUTE_CLASSES.capabilityDisabled)
})

test('ActionDraft and Forecast/MRP UI copy keeps final confirmation and release boundaries explicit', () => {
  assert.match(actionDraftShell, /文本草稿编辑器：仅用于供应商消息或内部备注，不替代正式业务页面/)
  assert.doesNotMatch(actionDraftShell, /confirmed-action-boundary|记录复核结果/)
  assert.match(actionDraftShell, /不提交/)
  assert.match(actionDraftShell, /不外发/)
  assert.match(actionDraftShell, /不写库存/)
  assert.match(actionDraftShell, /不写财务凭证/)
  assert.match(actionDraftShell, /不处理资金/)

  assert.match(forecastPage, /系统只会生成采购申请草稿/)
  assert.match(forecastPage, /需人工复核后才能继续处理/)
  assert.match(forecastPage, /不会自动创建采购订单/)
  assert.doesNotMatch(forecastPage, /确认释放|自动释放|提交 PR/)
})
