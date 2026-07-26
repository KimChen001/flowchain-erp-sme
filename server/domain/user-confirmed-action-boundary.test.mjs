import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {
  BUSINESS_ACTION_EXECUTION_BASELINE,
  FORBIDDEN_CONFIRMED_ACTION_TYPES,
  SAFE_CONFIRMED_ACTION_TYPES,
  validateUserConfirmedActionRequest,
} from './user-confirmed-business-action.mjs'
import { createEmptyDataset } from './data-mode.mjs'
import { createRepositoryRegistry } from '../repositories/adapter-registry.mjs'
import { createInMemoryUserConfirmedActionRepository } from '../repositories/user-confirmed-action-repository.mjs'
import { handleUserConfirmedActionsRoute } from '../routes/user-confirmed-actions.routes.mjs'
import { createTestRepositoryRegistry } from './test-fixtures/runtime-repositories.mjs'

const root = path.resolve(import.meta.dirname, '..', '..')

function source(...parts) {
  return fs.readFileSync(path.join(root, ...parts), 'utf8')
}

function confirmedBody(overrides = {}) {
  return {
    actionType: 'create_purchase_request',
    draftId: 'BAD-PR-1',
    sourceTrigger: 'natural_language',
    sourceModule: 'inventory',
    sourceEntityType: 'sku',
    sourceEntityId: 'SKU-UCA-1',
    reviewedFields: {
      sku: 'SKU-UCA-1',
      quantity: 12,
      requiredDate: '2026-07-12',
      warehouse: 'WH-A',
      costCenter: 'OPS',
      reason: 'Reviewed shortage evidence.',
    },
    linkedRecords: [{ type: 'sku', id: 'SKU-UCA-1' }],
    evidenceReferences: [{ type: 'inventory_shortage', id: 'SKU-UCA-1' }],
    dataLimitationsAcknowledged: ['Recognized ID, but record was not validated in current data.'],
    confirm: true,
    actor: 'buyer-1',
    tenantId: 'tenant-uca',
    userId: 'user-uca',
    dataMode: 'test',
    ...overrides,
  }
}

function routeHarness({ body = confirmedBody(), method = 'POST', pathname = '/api/user-confirmed-actions', db = createEmptyDataset({ mode: 'test' }), repositories } = {}) {
  let response = null
  return {
    ctx: {
      req: { method, body, headers: {} },
      res: {},
      url: new URL(pathname, 'http://localhost'),
      db,
      dataMode: 'test',
      repositories: repositories || {
        ...createTestRepositoryRegistry(db),
        userConfirmedActions: createInMemoryUserConfirmedActionRepository({ db }),
      },
      readBody: async (req) => req.body,
      send(_res, status, payload) {
        response = { status, payload }
      },
    },
    get response() {
      return response
    },
  }
}

test('R251 baseline review documents safe execution boundary and inspected files', () => {
  assert.ok(BUSINESS_ACTION_EXECUTION_BASELINE.inspectedFiles.includes('server/domain/business-action-draft-contract.mjs'))
  assert.ok(BUSINESS_ACTION_EXECUTION_BASELINE.safeRecordTypes.includes('create_purchase_request'))
  assert.ok(BUSINESS_ACTION_EXECUTION_BASELINE.forbiddenActions.includes('issue_po'))
  assert.match(BUSINESS_ACTION_EXECUTION_BASELINE.recommendedBoundary, /userConfirmedActions/)
})

test('R252 contract requires confirmation, allows safe action, rejects forbidden and AI confirmation', () => {
  const missing = validateUserConfirmedActionRequest(confirmedBody({ confirm: false }))
  assert.equal(missing.ok, false)
  assert.ok(missing.errors.some((item) => item.code === 'missing_confirmation'))

  const allowed = validateUserConfirmedActionRequest(confirmedBody())
  assert.equal(allowed.ok, true)
  assert.equal(allowed.action.actionType, 'create_purchase_request')
  assert.deepEqual(allowed.action.dataLimitationsAcknowledged, ['Recognized ID, but record was not validated in current data.'])
  assert.equal(allowed.mutationAllowed, false)

  const forbidden = validateUserConfirmedActionRequest(confirmedBody({ actionType: 'issue_po' }))
  assert.equal(forbidden.ok, false)
  assert.ok(forbidden.errors.some((item) => item.code === 'unsupported_action_type' || item.code === 'forbidden_action_type'))

  const ai = validateUserConfirmedActionRequest(confirmedBody({ confirmedByAi: true, autonomousExecutionAllowed: true }))
  assert.equal(ai.ok, false)
  assert.ok(ai.errors.some((item) => item.code === 'ai_confirmation_forbidden'))
  assert.ok(SAFE_CONFIRMED_ACTION_TYPES.includes('save_reviewed_draft'))
  assert.ok(FORBIDDEN_CONFIRMED_ACTION_TYPES.includes('pay_invoice'))
})

test('R253 repository creates scoped non-destructive records without business side effects', async () => {
  const db = createEmptyDataset({ mode: 'test' })
  db.purchaseRequests = []
  db.rfqs = []
  db.purchaseOrders = []
  db.products = [{ sku: 'SKU-UCA-1', currentStock: 2 }]
  const beforeBusiness = JSON.stringify({ purchaseRequests: db.purchaseRequests, rfqs: db.rfqs, purchaseOrders: db.purchaseOrders, products: db.products })
  const repo = createInMemoryUserConfirmedActionRepository({ db })
  const record = await repo.executeConfirmedAction(confirmedBody())
  assert.equal(record.createdRecordType, 'purchaseRequest')
  assert.equal(record.status, 'draft')
  assert.equal(record.sideEffects.mutatesInventoryBalance, false)
  assert.equal(record.sideEffects.createsPurchaseOrder, false)
  assert.equal(record.sideEffects.submitsForApproval, false)
  assert.equal(JSON.stringify({ purchaseRequests: db.purchaseRequests, rfqs: db.rfqs, purchaseOrders: db.purchaseOrders, products: db.products }), beforeBusiness)

  const sameScope = await repo.listConfirmedActions({ tenantId: 'tenant-uca', userId: 'user-uca', dataMode: 'test' })
  const otherScope = await repo.listConfirmedActions({ tenantId: 'tenant-uca', userId: 'other-user', dataMode: 'test' })
  assert.equal(sameScope.length, 1)
  assert.equal(otherScope.length, 0)
})

test('R254-R257 route creates safe records and records audit without protected fixture data mutation', async () => {
  const db = createEmptyDataset({ mode: 'test' })
  const before = JSON.stringify(db)
  const route = routeHarness({ db })
  assert.equal(await handleUserConfirmedActionsRoute(route.ctx), true)
  assert.equal(route.response.status, 201)
  assert.equal(route.response.payload.ok, true)
  assert.equal(route.response.payload.createdRecordId.startsWith('PR-DRAFT-'), true)
  assert.equal(route.response.payload.sideEffects.issuesPo, false)
  assert.equal(route.response.payload.sideEffects.sendsExternalEmail, false)
  assert.equal(route.response.payload.sideEffects.postsInventory, false)
  assert.equal(route.response.payload.auditEventId !== null, true)
  assert.equal(JSON.stringify({ ...db, auditLog: [] }), JSON.stringify({ ...JSON.parse(before), auditLog: [] }))
  assert.equal(db.auditLog[0].action, 'user_confirmed_business_action')
  assert.equal(db.auditLog[0].metadata.userConfirmedCreation, true)
  assert.equal(db.auditLog[0].metadata.aiGeneratedDraftOnly, false)
})

test('R254-R257 supported creation/save action shapes remain review-first and internal only', async () => {
  const repo = createInMemoryUserConfirmedActionRepository({ db: createEmptyDataset({ mode: 'test' }) })
  const cases = [
    ['create_supplier_application', { supplierName: 'New Supplier', category: 'Electrical', contactPerson: 'Buyer' }, 'supplierApplication'],
    ['create_purchase_request', { sku: 'SKU-1', quantity: 3, requiredDate: '2026-07-12' }, 'purchaseRequest'],
    ['create_sourcing_event', { eventTitle: 'Motor sourcing', itemOrCategory: 'SKU-1', quantity: 3, responseDeadline: '2026-07-15' }, 'sourcingEvent'],
    ['create_rfq', { itemOrCategory: 'SKU-1', quantity: 3, responseDeadline: '2026-07-15' }, 'rfq'],
    ['save_supplier_followup_note', { supplier: 'SUP-1', messageDraft: 'Please confirm ETA.' }, 'supplierFollowupNote'],
    ['save_exception_case_note', { caseId: 'EC-1', body: 'Internal note.' }, 'exceptionCaseNote'],
    ['save_exception_resolution_note', { caseId: 'EC-1', resolutionNote: 'Resolution reviewed.' }, 'exceptionResolutionNote'],
    ['save_reviewed_draft', { title: 'Reviewed draft shell' }, 'reviewedDraft'],
  ]
  for (const [actionType, reviewedFields, expectedType] of cases) {
    const record = await repo.executeConfirmedAction(confirmedBody({ actionType, reviewedFields }))
    assert.equal(record.createdRecordType, expectedType)
    assert.equal(record.sideEffects.sendsRfqExternally, false, actionType)
    assert.equal(record.sideEffects.awardsSupplier, false, actionType)
    assert.equal(record.sideEffects.mutatesSupplierMaster, false, actionType)
    assert.equal(record.sideEffects.autoClosesCase, false, actionType)
  }
})

test('R258-R260 source guardrails expose route UI and preserve previous safety boundaries', () => {
  const route = source('server', 'routes', 'user-confirmed-actions.routes.mjs')
  const registry = source('server', 'repositories', 'adapter-registry.mjs')
  const shell = source('src', 'modules', 'action-drafts', 'ActionDraftReviewShell.tsx')
  const planPanel = source('src', 'modules', 'action-drafts', 'BusinessActionPlanPanel.tsx')
  const routes = source('src', 'app', 'routeRegistry.tsx')
  const exceptionPage = source('src', 'modules', 'exception-cases', 'Page.tsx')
  const userDataRoutes = source('server', 'routes', 'user-data.routes.mjs')
  for (const expected of ['PR 复核记录', '供应商准入复核记录', 'RFQ 复核记录', '供应商跟进复核记录', '工单复核记录', '已复核内部记录']) {
    assert.match(`${shell}\n${planPanel}`, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  }
  for (const forbidden of ['Issue PO', 'Send Email', 'Award Supplier', 'Pay', 'Post']) {
    assert.doesNotMatch(shell, new RegExp(`>${forbidden}<|label:\\s*["']${forbidden}["']`))
  }
  assert.match(route, /mutatesLinkedBusinessRecords:\s*false/)
  assert.match(registry, /userConfirmedActions/)
  assert.doesNotMatch(routes, /label:\s*["']AI Assistant["']|label:\s*["']AI Command Center["']|label:\s*["']Ask AI["']/)
  assert.doesNotMatch(exceptionPage, /sourceEntityId:\s*"SKU-00412"|SKU-00412:shortage|demoDraftEvidence/)
  assert.match(userDataRoutes, /getPreviewSnapshot/)
  assert.match(exceptionPage, /确认最终状态变更/)
  assert.doesNotMatch([route, shell, planPanel].join('\n'), /OPENAI_API_KEY|ARK_API_KEY|DOUBAO_API_KEY|sk-[A-Za-z0-9]/)
})
