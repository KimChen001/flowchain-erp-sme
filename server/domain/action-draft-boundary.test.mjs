import test from 'node:test'
import assert from 'node:assert/strict'
import {
  actionDraftSchema,
  buildActionDraftSuggestion,
  getSupportedActionDraftTypes,
  toActionDraftEvidence,
  validateActionDraftPayload,
} from './action-draft-boundary.mjs'
import { handleActionDraftsRoute } from '../routes/action-drafts.routes.mjs'
import { createTestRepositoryRegistry } from './test-fixtures/runtime-repositories.mjs'

function createRouteContext({ method = 'GET', pathname = '/api/action-drafts/schema', body = {}, db = { auditLog: [] } } = {}) {
  let response = null
  let wrote = false
  return {
    ctx: {
      req: { method, body },
      res: {},
      url: new URL(pathname, 'http://localhost'),
      db,
      repositories: createTestRepositoryRegistry(db),
      send(_res, status, payload) {
        response = { status, payload }
      },
      readBody: async (req) => req.body,
      writeDb: async () => { wrote = true },
    },
    get response() {
      return response
    },
    get wrote() {
      return wrote
    },
  }
}

test('action draft boundary exposes supported draft types', () => {
  const types = getSupportedActionDraftTypes()
  assert.deepEqual(types.map((item) => item.type), [
    'purchase_request_draft',
    'rfq_draft',
    'po_followup_draft',
    'inventory_exception_closure_draft',
    'supplier_followup_draft',
  ])
  assert.equal(types.every((item) => item.requiredPayloadFields.length > 0), true)
})

test('action draft helper returns preview-only reviewable shape', () => {
  const result = buildActionDraftSuggestion({
    type: 'purchase_request_draft',
    source: 'today_cockpit',
    createdBy: { type: 'user', id: 'USR-001', name: 'Planner' },
    originEvidence: [{ type: 'inventory_item', id: 'SKU-00287', label: '铝合金型材 6063', route: '/api/inventory/items/SKU-00287' }],
    payload: { itemIdOrSku: 'SKU-00287', quantity: 1000 },
  }, { now: new Date('2026-06-29T00:00:00Z') })

  assert.equal(result.ok, true)
  assert.equal(result.draft.type, 'purchase_request_draft')
  assert.equal(result.draft.status, 'preview')
  assert.equal(result.draft.requiresConfirmation, true)
  assert.equal(result.draft.validation.ok, true)
  assert.equal(result.draft.confirmationBoundary.previewOnly, true)
  assert.equal(result.draft.confirmationBoundary.submitted, false)
  assert.equal(result.draft.auditTrail[0].action, 'ai_draft_prepared')
  assert.equal(result.draft.originEvidence[0].route, '/api/inventory/items/SKU-00287')
})

test('action draft validation reports missing required fields and unsupported types cleanly', () => {
  const invalidPayload = validateActionDraftPayload('rfq_draft', { itemIdOrSku: 'SKU-00287' })
  assert.equal(invalidPayload.ok, false)
  assert.deepEqual(invalidPayload.missingFields, ['quantity'])
  assert.match(invalidPayload.errors[0], /quantity/)

  const unsupported = buildActionDraftSuggestion({ type: 'payment_execution_draft', payload: {} })
  assert.equal(unsupported.ok, false)
  assert.equal(unsupported.status, 'unsupported_type')
  assert.ok(unsupported.supportedTypes.includes('supplier_followup_draft'))
})

test('action draft evidence keeps compact non-secret references', () => {
  const evidence = toActionDraftEvidence({
    documentType: 'po',
    documentId: 'PO-2026-1301',
    title: 'PO followup',
    status: '已发出',
    route: '/api/procurement/documents/po/PO-2026-1301',
    secret: 'do-not-include',
  })

  assert.deepEqual(evidence, {
    type: 'po',
    id: 'PO-2026-1301',
    label: 'PO followup',
    status: '已发出',
    route: '/api/procurement/documents/po/PO-2026-1301',
  })
})

test('action draft schema documents confirmation and audit boundaries', () => {
  const schema = actionDraftSchema()
  assert.equal(schema.previewOnly, true)
  assert.equal(schema.confirmationBoundary.autonomousExecutionAllowed, false)
  assert.equal(schema.confirmationBoundary.userMustConfirm, true)
  assert.equal(schema.auditBoundary.recordAiSourceAndEvidence, true)
  assert.equal(schema.auditBoundary.storeSecrets, false)
  assert.equal(schema.recommendedActionMapping.todayCockpitInventoryRisk, 'purchase_request_draft')
})

test('action draft preview route is preview-only and does not mutate db', async () => {
  const db = { auditLog: [], purchaseRequests: [] }
  const beforeBusinessData = JSON.stringify(db.purchaseRequests)
  const route = createRouteContext({
    method: 'POST',
    pathname: '/api/action-drafts/preview',
    db,
    body: {
      type: 'supplier_followup_draft',
      payload: { supplierIdOrName: 'SUP-001', message: '确认异常收货处理计划' },
      originEvidence: [{ type: 'grn', id: 'GRN-202606-0430', status: '异常处理' }],
    },
  })

  const handled = await handleActionDraftsRoute(route.ctx)
  assert.equal(handled, true)
  assert.equal(route.response.status, 200)
  assert.equal(route.response.payload.previewOnly, true)
  assert.equal(route.response.payload.draft.type, 'supplier_followup_draft')
  assert.equal(route.wrote, false)
  assert.equal(JSON.stringify(db.purchaseRequests), beforeBusinessData)
  assert.equal(db.auditLog.length, 1)
  assert.equal(db.auditLog[0].action, 'draft_previewed')
})

test('action draft routes return schema and clean unsupported type failure', async () => {
  const schemaRoute = createRouteContext()
  assert.equal(await handleActionDraftsRoute(schemaRoute.ctx), true)
  assert.equal(schemaRoute.response.status, 200)
  assert.equal(schemaRoute.response.payload.schema.previewOnly, true)

  const invalidRoute = createRouteContext({
    method: 'POST',
    pathname: '/api/action-drafts/preview',
    body: { type: 'autonomous_payment' },
  })
  assert.equal(await handleActionDraftsRoute(invalidRoute.ctx), true)
  assert.equal(invalidRoute.response.status, 400)
  assert.equal(invalidRoute.response.payload.status, 'unsupported_type')
  assert.equal(invalidRoute.wrote, false)
})
