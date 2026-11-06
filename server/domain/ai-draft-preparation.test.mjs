import test from 'node:test'
import assert from 'node:assert/strict'
import { handleAiRoute } from '../routes/ai.routes.mjs'
import {
  aiDraftPreparationCapabilityCatalog,
  buildAiDraftPreparationResponse,
  detectAiDraftIntent,
  normalizeDraftMessage,
} from './ai-draft-preparation.mjs'

function createDb(overrides = {}) {
  return {
    products: [
      {
        sku: 'A100',
        name: 'Motor A100',
        category: 'Components',
        unit: 'pcs',
        supplier: 'ABC Components',
        defaultWarehouseId: 'WH-MAIN',
      },
      {
        sku: 'B200',
        name: 'Bracket B200',
        category: 'Components',
        unit: 'pcs',
      },
    ],
    suppliers: [
      {
        id: 'SUP-001',
        name: 'ABC Components',
        paymentTermsId: 'NET30',
        category: 'Motors',
      },
      {
        id: 'SUP-002',
        name: 'Beta Metals',
        category: 'Materials',
      },
    ],
    warehouses: [
      { id: 'WH-MAIN', name: 'Main Warehouse' },
    ],
    paymentTerms: [
      { id: 'NET30', label: 'Net 30', days: 30 },
    ],
    purchaseRequests: [],
    rfqs: [
      { id: 'RFQ-OPEN', status: '进行中' },
    ],
    purchaseOrders: [],
    receivingDocs: [],
    inventoryMovements: [],
    ...overrides,
  }
}

function createRouteContext(body, db = createDb()) {
  let response = null
  return {
    ctx: {
      req: { method: 'POST', headers: {}, body },
      res: {},
      url: new URL('/api/ai/chat', 'http://localhost'),
      db,
      readBody: async (req) => req.body,
      writeDb: async () => {},
      event(database, type, message, ref) {
        database.events = [{ type, message, ref }]
      },
      ensurePurchaseRequests(database) {
        return Array.isArray(database.purchaseRequests) ? database.purchaseRequests : []
      },
      ensureInventoryMovements(database) {
        return Array.isArray(database.inventoryMovements) ? database.inventoryMovements : []
      },
      send(_res, status, payload) {
        response = { status, payload }
      },
    },
    get response() {
      return response
    },
  }
}

function businessSnapshot(db) {
  return structuredClone({
    products: db.products,
    suppliers: db.suppliers,
    purchaseRequests: db.purchaseRequests,
    rfqs: db.rfqs,
    purchaseOrders: db.purchaseOrders,
    receivingDocs: db.receivingDocs,
    inventoryMovements: db.inventoryMovements,
  })
}

test('AI draft preparation catalog documents review-only draft capabilities', () => {
  assert.equal(aiDraftPreparationCapabilityCatalog.length, 2)
  assert.deepEqual(
    aiDraftPreparationCapabilityCatalog.map((item) => item.intent),
    ['prepare_purchase_request_draft', 'prepare_rfq_draft'],
  )
  assert.ok(aiDraftPreparationCapabilityCatalog.every((item) => item.mode === 'draft_preparation'))
})

test('AI draft preparation normalizes compatible message fields', () => {
  assert.equal(normalizeDraftMessage({ message: 'PR A100 300 urgent' }), 'PR A100 300 urgent')
  assert.equal(normalizeDraftMessage({ prompt: 'Create RFQ for A100 qty 1000' }), 'Create RFQ for A100 qty 1000')
  assert.equal(normalizeDraftMessage({ question: 'Create a purchase request for A100' }), 'Create a purchase request for A100')
  assert.equal(normalizeDraftMessage({ text: 'RFQ B200 200 pcs urgent' }), 'RFQ B200 200 pcs urgent')
})

test('AI draft preparation detects PR and RFQ draft intents without catching status prompts', () => {
  assert.equal(detectAiDraftIntent('PR A100 300 urgent'), 'prepare_purchase_request_draft')
  assert.equal(detectAiDraftIntent('Create RFQ for A100 qty 1000'), 'prepare_rfq_draft')
  assert.equal(detectAiDraftIntent('PR status'), null)
  assert.equal(detectAiDraftIntent('RFQ pending'), null)
})

test('PR prompt with SKU and quantity returns reviewable pr_draft', async () => {
  const db = createDb()
  const before = businessSnapshot(db)
  const route = createRouteContext({ message: 'PR A100 300 urgent' }, db)
  const handled = await handleAiRoute(route.ctx)

  assert.ok(handled)
  assert.equal(route.response.status, 200)
  assert.equal(route.response.payload.intent.name, 'prepare_purchase_request_draft')
  assert.equal(route.response.payload.cards[0].type, 'pr_draft')
  assert.equal(route.response.payload.cards[0].reviewRequired, true)
  assert.equal(route.response.payload.cards[0].data.documentStatus, 'draft')
  assert.equal(route.response.payload.cards[0].data.itemId, 'ITEM-A100')
  assert.equal(route.response.payload.cards[0].data.quantity, 300)
  assert.equal(route.response.payload.cards[0].data.prioritySignal, 'urgent')
  assert.equal(route.response.payload.cards[0].data.priorityId, 'P1')
  assert.equal(route.response.payload.cards[0].data.prioritySource, 'default_priority_reference')
  assert.equal(route.response.payload.cards[0].data.priorityConfidence, 'medium')
  assert.ok(route.response.payload.cards.some((card) => card.type === 'missing_fields'))
  assert.ok(route.response.payload.cards.some((card) => card.type === 'confidence_summary'))
  assert.ok(route.response.payload.cards.some((card) => card.type === 'recommended_actions'))
  assert.deepEqual(businessSnapshot(db), before)
})

test('Chinese inventory PR draft prompt remains ActionDraft preview only', async () => {
  const db = createDb()
  const before = businessSnapshot(db)
  const route = createRouteContext({ moduleId: 'inventory', message: '准备 PR 草稿 A100 50 明天' }, db)
  const handled = await handleAiRoute(route.ctx)

  assert.ok(handled)
  assert.equal(route.response.status, 200)
  assert.equal(route.response.payload.intent.name, 'prepare_purchase_request_draft')
  assert.equal(route.response.payload.mode, 'draft_preparation')
  assert.equal(route.response.payload.usedWeb, false)
  assert.equal(route.response.payload.externalMs, 0)
  assert.notEqual(route.response.payload.provider, 'openai')
  assert.notEqual(route.response.payload.provider, 'doubao')
  assert.equal(route.response.payload.cards[0].type, 'pr_draft')
  assert.equal(route.response.payload.cards[0].reviewRequired, true)
  assert.equal(route.response.payload.cards[0].data.documentStatus, 'draft')
  assert.deepEqual(businessSnapshot(db), before)
})

test('PR prompt with item keyword and quantity matches item master and infers preferred supplier', () => {
  const response = buildAiDraftPreparationResponse(
    createDb(),
    { message: '帮我生成一个 PR，买 500 个 motor，下周五前要。' },
    { now: new Date('2026-06-28T00:00:00.000Z') },
  )
  const draft = response.cards[0].data
  const confidence = response.cards.find((card) => card.type === 'confidence_summary').fields

  assert.equal(response.intent.name, 'prepare_purchase_request_draft')
  assert.equal(draft.itemId, 'ITEM-A100')
  assert.equal(draft.quantity, 500)
  assert.equal(draft.requiredDate, '2026-07-03')
  assert.equal(draft.preferredSupplierId, 'SUP-001')
  assert.equal(draft.preferredSupplierSource, 'item_preferred_supplier')
  assert.equal(confidence.preferredSupplierId, 'medium')
  assert.ok(response.evidence.some((item) => item.type === 'supplier_master'))
})

test('PR prompt without quantity returns missing quantity', () => {
  const response = buildAiDraftPreparationResponse(createDb(), { message: '帮我起一个采购申请 item A100' })
  const missing = response.cards.find((card) => card.type === 'missing_fields').fields

  assert.equal(response.cards[0].type, 'pr_draft')
  assert.ok(missing.some((field) => field.name === 'quantity'))
  assert.equal(response.cards.find((card) => card.type === 'confidence_summary').fields.quantity, 'missing')
})

test('PR prompt with unmapped priority signal does not force configured priority', () => {
  const response = buildAiDraftPreparationResponse(createDb(), { message: 'Create purchase request A100 qty 10 priority rocket' })
  const draft = response.cards[0].data
  const missing = response.cards.find((card) => card.type === 'missing_fields').fields

  assert.equal(draft.prioritySignal, 'rocket')
  assert.equal(draft.priorityId, '')
  assert.equal(draft.prioritySource, 'user_input_unmapped')
  assert.equal(draft.priorityConfidence, 'low')
  assert.ok(missing.some((field) => field.name === 'priorityId'))
})

test('PR prompt can map priority through tenant priority configuration', () => {
  const response = buildAiDraftPreparationResponse(
    createDb(),
    { message: 'Create purchase request A100 qty 10 expedite' },
    {
      priorityConfiguration: {
        priorityLevels: [{ id: 'TENANT-P0', label: 'Expedite', keywords: ['expedite'] }],
        defaultPriorityId: 'TENANT-P0',
      },
    },
  )
  const draft = response.cards[0].data

  assert.equal(draft.prioritySignal, 'expedite')
  assert.equal(draft.priorityId, 'TENANT-P0')
  assert.equal(draft.prioritySource, 'tenant_priority_mapping')
  assert.equal(draft.priorityConfidence, 'high')
})

test('PR status question remains read-only procurement query, not draft preparation', async () => {
  const route = createRouteContext({ message: 'PR status' }, createDb({
    purchaseRequests: [{ pr: 'PR-001', status: '待审批' }],
  }))
  const handled = await handleAiRoute(route.ctx)

  assert.ok(handled)
  assert.equal(route.response.status, 200)
  assert.equal(route.response.payload.intent.name, 'pr_status_query')
  assert.equal(route.response.payload.cards[0].type, 'missing_fields')
})

test('RFQ prompt with SKU and quantity returns reviewable rfq_draft', async () => {
  const db = createDb()
  const before = businessSnapshot(db)
  const route = createRouteContext({ prompt: 'Create RFQ for A100 qty 1000 urgent' }, db)
  const handled = await handleAiRoute(route.ctx)

  assert.ok(handled)
  assert.equal(route.response.status, 200)
  assert.equal(route.response.payload.intent.name, 'prepare_rfq_draft')
  assert.equal(route.response.payload.cards[0].type, 'rfq_draft')
  assert.equal(route.response.payload.cards[0].reviewRequired, true)
  assert.equal(route.response.payload.cards[0].data.documentStatus, 'draft')
  assert.equal(route.response.payload.cards[0].data.itemId, 'ITEM-A100')
  assert.equal(route.response.payload.cards[0].data.quantity, 1000)
  assert.equal(route.response.payload.cards[0].data.prioritySignal, 'urgent')
  assert.equal(route.response.payload.cards[0].data.priorityId, 'P1')
  assert.ok(route.response.payload.cards.some((card) => card.type === 'recommended_actions'))
  assert.deepEqual(businessSnapshot(db), before)
})

test('RFQ prompt with supplier name matches supplier master and payment terms', () => {
  const response = buildAiDraftPreparationResponse(createDb(), { message: '帮我做一个 quotation request 给 ABC Components，采购 300 个 A100' })
  const draft = response.cards[0].data

  assert.equal(response.intent.name, 'prepare_rfq_draft')
  assert.equal(draft.supplierCandidates.length, 1)
  assert.equal(draft.supplierCandidates[0].supplierId, 'SUP-001')
  assert.equal(draft.supplierCandidates[0].source, 'matched_supplier_master')
  assert.equal(draft.paymentTermsId, 'NET30')
  assert.equal(draft.paymentTermsSource, 'supplier_default')
})

test('RFQ for a supplier with no recorded payment term leaves the term empty, not the workspace first term', () => {
  const db = createDb()
  delete db.suppliers[0].paymentTermsId
  const response = buildAiDraftPreparationResponse(db, { message: '帮我做一个 quotation request 给 ABC Components，采购 300 个 A100' })
  const draft = response.cards[0].data

  assert.equal(draft.supplierCandidates.length, 1)
  assert.equal(draft.supplierCandidates[0].supplierId, 'SUP-001')
  assert.equal(draft.paymentTermsId, '')
  assert.equal(draft.paymentTermsSource, 'missing')
  assert.ok(!response.cards.flatMap((card) => card.evidence || []).some((item) => item.type === 'payment_terms'))
})

test('RFQ prompt without quotation deadline returns missing quotationDeadline', () => {
  const response = buildAiDraftPreparationResponse(createDb(), { text: 'RFQ B200 200 pcs urgent' })
  const missing = response.cards.find((card) => card.type === 'missing_fields').fields

  assert.equal(response.cards[0].type, 'rfq_draft')
  assert.ok(missing.some((field) => field.name === 'quotationDeadline'))
  assert.equal(response.cards.find((card) => card.type === 'confidence_summary').fields.quotationDeadline, 'missing')
})

test('RFQ prompt asking for three suppliers uses only available master data candidates', () => {
  const response = buildAiDraftPreparationResponse(createDb(), { message: '帮我给三个供应商询价，item A100，数量 1000，月底前交货。' }, { now: new Date('2026-06-28T00:00:00.000Z') })
  const draft = response.cards[0].data

  assert.equal(response.intent.name, 'prepare_rfq_draft')
  assert.equal(response.intent.slots.supplierCount, 3)
  assert.equal(draft.supplierCandidates.length, 2)
  assert.equal(draft.supplierCandidates.every((supplier) => supplier.supplierId.startsWith('SUP-')), true)
  assert.equal(draft.targetDeliveryDate, '2026-06-30')
})

test('RFQ pending question remains procurement status query, not draft preparation', async () => {
  const route = createRouteContext({ message: 'RFQ pending' })
  const handled = await handleAiRoute(route.ctx)

  assert.ok(handled)
  assert.equal(route.response.status, 200)
  assert.equal(route.response.payload.intent.name, 'rfq_response_query')
})

test('unsupported prompts fall through deterministic draft handler', () => {
  const response = buildAiDraftPreparationResponse(createDb(), { message: 'Explain forecast assumptions' })

  assert.equal(response, null)
})
