import test from 'node:test'
import assert from 'node:assert/strict'
import { buildPurchaseRequestDraftPreview, validatePurchaseRequestDraftPayload } from './purchase-request-draft-preview.mjs'
import { handleActionDraftsRoute } from '../routes/action-drafts.routes.mjs'
import { createTestRepositoryRegistry } from './test-fixtures/runtime-repositories.mjs'

function createDb() {
  return {
    products: [
      {
        sku: 'SKU-LOW',
        name: 'Low Stock Motor',
        currentStock: 12,
        reorderPoint: 80,
        safetyStock: 40,
        unit: 'pcs',
        warehouseId: 'WH-A',
        supplier: 'ABC Components',
        riskLevel: '高',
      },
      {
        sku: 'SKU-MANUAL',
        name: 'Manual Review Part',
        currentStock: 100,
        reorderPoint: 0,
        safetyStock: 0,
        unit: 'pcs',
      },
    ],
    suppliers: [{ id: 'SUP-001', name: 'ABC Components', onTimeRate: 95, qualityRate: 98 }],
    auditLog: [],
    purchaseRequests: [],
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

test('valid PR draft preview derives safe inventory payload and supplier evidence', () => {
  const result = buildPurchaseRequestDraftPreview({
    type: 'purchase_request_draft',
    source: 'today_cockpit',
    payload: { itemIdOrSku: 'SKU-LOW' },
    originEvidence: [{ type: 'inventory_item', id: 'SKU-LOW', summary: 'Low stock signal' }],
  }, { db: createDb(), now: new Date('2026-06-30T00:00:00Z') })

  assert.equal(result.ok, true)
  assert.equal(result.draft.type, 'purchase_request_draft')
  assert.equal(result.draft.status, 'preview')
  assert.equal(result.draft.payload.itemIdOrSku, 'SKU-LOW')
  assert.equal(result.draft.payload.itemName, 'Low Stock Motor')
  assert.equal(result.draft.payload.suggestedQuantity, 68)
  assert.equal(result.draft.payload.supplierSuggestion.supplierId, 'SUP-001')
  assert.equal(result.draft.requiresConfirmation, true)
  assert.equal(result.draft.confirmationBoundary.submitted, false)
  assert.ok(result.draft.originEvidence.some((item) => item.type === 'inventory_item' && item.id === 'SKU-LOW'))
})

test('missing SKU returns clean validation failure', () => {
  const result = buildPurchaseRequestDraftPreview({
    type: 'purchase_request_draft',
    payload: { quantity: 20 },
  }, { db: createDb() })

  assert.equal(result.ok, false)
  assert.equal(result.status, 'invalid')
  assert.deepEqual(result.validation.missingFields, ['itemIdOrSku'])
  assert.match(result.error, /itemIdOrSku/)
})

test('missing quantity becomes manual-review warning when no safe suggestion exists', () => {
  const result = buildPurchaseRequestDraftPreview({
    type: 'purchase_request_draft',
    payload: { itemIdOrSku: 'SKU-MANUAL' },
  }, { db: createDb() })

  assert.equal(result.ok, true)
  assert.equal(result.draft.validation.status, 'needs_review')
  assert.deepEqual(result.draft.validation.missingFields, ['quantity'])
  assert.match(result.draft.validation.warnings[0], /manual review/i)
})

test('PR draft preview route is preview-only and does not mutate workspace db', async () => {
  const db = createDb()
  const before = JSON.stringify(db)
  const route = createRouteContext({
    type: 'purchase_request_draft',
    payload: { itemIdOrSku: 'SKU-LOW' },
  }, db)

  const handled = await handleActionDraftsRoute(route.ctx)
  assert.equal(handled, true)
  assert.equal(route.response.status, 200)
  assert.equal(route.response.payload.previewOnly, true)
  assert.equal(route.response.payload.draft.payload.suggestedQuantity, 68)
  assert.equal(route.wrote, false)
  assert.equal(JSON.stringify({ ...db, auditLog: [] }), before)
  assert.equal(db.auditLog[0].action, 'draft_previewed')
})

test('PR draft validation helper separates errors from quantity warnings', () => {
  assert.equal(validatePurchaseRequestDraftPayload({ itemIdOrSku: 'SKU-LOW', suggestedQuantity: 1 }).status, 'ready_for_review')
  assert.equal(validatePurchaseRequestDraftPayload({ itemIdOrSku: 'SKU-LOW' }).status, 'needs_review')
  assert.equal(validatePurchaseRequestDraftPayload({}).status, 'invalid')
})
