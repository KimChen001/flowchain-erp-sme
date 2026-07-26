import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildRfqDraftPreview,
  buildSupplierFollowupDraftPreview,
  validateRfqDraftPayload,
  validateSupplierFollowupDraftPayload,
} from './rfq-and-supplier-followup-draft-preview.mjs'
import { handleActionDraftsRoute } from '../routes/action-drafts.routes.mjs'
import { createTestRepositoryRegistry } from './test-fixtures/runtime-repositories.mjs'

function createDb() {
  return {
    products: [
      {
        sku: 'SKU-RFQ',
        name: 'RFQ Motor',
        currentStock: 8,
        reorderPoint: 50,
        safetyStock: 20,
        unit: 'pcs',
        warehouseId: 'WH-A',
        supplier: 'ABC Components',
        riskLevel: '高',
      },
    ],
    suppliers: [
      { id: 'SUP-001', name: 'ABC Components', onTimeRate: 95, qualityRate: 98 },
      { id: 'SUP-002', name: 'Delta Plastics', onTimeRate: 88, qualityRate: 92 },
    ],
    rfqs: [],
    auditLog: [],
  }
}

function createRouteContext(body, db = createDb()) {
  let response = null
  let wrote = false
  return {
    ctx: {
      req: { method: 'POST', body },
      res: {},
      url: new URL('/api/action-drafts/preview', 'http://localhost'),
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

test('valid RFQ draft preview returns item quantity and supplier candidates', () => {
  const result = buildRfqDraftPreview({
    type: 'rfq_draft',
    source: 'ai_assistant',
    payload: { itemIdOrSku: 'SKU-RFQ', quantity: 120, requestedDeliveryDate: '2026-07-15' },
  }, { db: createDb(), now: new Date('2026-06-30T00:00:00Z') })

  assert.equal(result.ok, true)
  assert.equal(result.draft.type, 'rfq_draft')
  assert.equal(result.draft.payload.itemIdOrSku, 'SKU-RFQ')
  assert.equal(result.draft.payload.quantity, 120)
  assert.equal(result.draft.payload.supplierCandidates.length >= 2, true)
  assert.equal(result.draft.confirmationBoundary.submitted, false)
  assert.ok(result.draft.originEvidence.some((item) => item.type === 'inventory_item' && item.id === 'SKU-RFQ'))
})

test('valid supplier follow-up preview returns editable message and supplier evidence', () => {
  const result = buildSupplierFollowupDraftPreview({
    type: 'supplier_followup_draft',
    source: 'today_cockpit',
    payload: {
      supplierIdOrName: 'SUP-001',
      relatedDocumentType: 'po',
      relatedDocumentId: 'PO-1001',
      followupReason: '交期临近',
      severity: 'high',
    },
  }, { db: createDb(), now: new Date('2026-06-30T00:00:00Z') })

  assert.equal(result.ok, true)
  assert.equal(result.draft.type, 'supplier_followup_draft')
  assert.equal(result.draft.payload.supplierId, 'SUP-001')
  assert.match(result.draft.payload.messageDraft, /请协助确认/)
  assert.equal(result.draft.payload.severity, 'high')
  assert.equal(result.draft.confirmationBoundary.submitted, false)
  assert.ok(result.draft.originEvidence.some((item) => item.type === 'supplier_master' && item.id === 'SUP-001'))
})

test('missing item and supplier validations fail cleanly', () => {
  const missingItem = buildRfqDraftPreview({ type: 'rfq_draft', payload: { quantity: 10 } }, { db: createDb() })
  assert.equal(missingItem.ok, false)
  assert.deepEqual(missingItem.validation.missingFields, ['itemIdOrSku'])

  const missingSupplier = buildSupplierFollowupDraftPreview({ type: 'supplier_followup_draft', payload: { message: '跟进' } }, { db: createDb() })
  assert.equal(missingSupplier.ok, false)
  assert.deepEqual(missingSupplier.validation.missingFields, ['supplierIdOrName'])
})

test('RFQ and supplier follow-up preview routes are non-mutating', async () => {
  const db = createDb()
  const beforeBusinessData = JSON.stringify({ products: db.products, suppliers: db.suppliers, rfqs: db.rfqs })
  const rfqRoute = createRouteContext({ type: 'rfq_draft', payload: { itemIdOrSku: 'SKU-RFQ', quantity: 120 } }, db)
  await handleActionDraftsRoute(rfqRoute.ctx)
  assert.equal(rfqRoute.response.status, 200)
  assert.equal(rfqRoute.response.payload.previewOnly, true)
  assert.equal(rfqRoute.wrote, false)

  const supplierRoute = createRouteContext({ type: 'supplier_followup_draft', payload: { supplierIdOrName: 'SUP-001', message: '请确认交期。' } }, db)
  await handleActionDraftsRoute(supplierRoute.ctx)
  assert.equal(supplierRoute.response.status, 200)
  assert.equal(supplierRoute.response.payload.previewOnly, true)
  assert.equal(supplierRoute.wrote, false)
  assert.equal(JSON.stringify({ products: db.products, suppliers: db.suppliers, rfqs: db.rfqs }), beforeBusinessData)
  assert.equal(db.auditLog.length, 2)
  assert.ok(db.auditLog.every((entry) => entry.action === 'draft_previewed'))
})

test('unsupported draft type still returns clean generic failure', async () => {
  const route = createRouteContext({ type: 'payment_execution_draft', payload: {} })
  await handleActionDraftsRoute(route.ctx)
  assert.equal(route.response.status, 400)
  assert.equal(route.response.payload.status, 'unsupported_type')
  assert.equal(route.wrote, false)
})

test('draft validation helpers report required fields', () => {
  assert.deepEqual(validateRfqDraftPayload({ itemIdOrSku: 'SKU-RFQ' }).missingFields, ['quantity'])
  assert.deepEqual(validateSupplierFollowupDraftPayload({}).missingFields, ['supplierIdOrName'])
})
