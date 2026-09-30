import test from 'node:test'
import assert from 'node:assert/strict'
import { handleAiRoute } from '../routes/ai.routes.mjs'
import {
  aiSupplierOperationalCapabilityCatalog,
  buildAiSupplierOperationalResponse,
  buildSupplierEntityIndex,
  detectAiSupplierOperationalIntent,
  normalizeSupplierOperationalMessage,
  resolveSupplierEntities,
} from './ai-supplier-operational-query.mjs'

function createDb(overrides = {}) {
  return {
    products: [
      {
        sku: 'A100',
        name: 'Motor A100',
        supplier: 'ABC Components',
        currentStock: 4,
        safetyStock: 20,
        stockoutRisk: 'high',
      },
      {
        sku: 'D200',
        name: 'Delta Resin',
        supplier: 'Delta Plastics',
        currentStock: 80,
        safetyStock: 50,
      },
    ],
    suppliers: [
      {
        id: 'SUP-001',
        name: 'ABC Components',
        legacyName: 'ABC Co',
        category: 'Motors',
        risk: '中',
        paymentTerms: 'NET30',
        currency: 'USD',
        onTimeRate: 84,
        qualityRate: 90,
      },
      {
        id: 'SUP-002',
        name: 'Delta Plastics',
        category: 'Materials',
        risk: '低',
      },
      {
        id: 'SUP-003',
        name: 'ABC Tools',
        category: 'Tools',
      },
      {
        id: 'SUP-004',
        name: 'Echo Metals',
        category: 'Metals',
      },
    ],
    purchaseOrders: [
      {
        po: 'PO-1001',
        supplier: 'ABC Components',
        supplierId: 'SUP-001',
        eta: '2026-06-01',
        status: '已发出',
        amount: 12000,
      },
      {
        po: 'PO-1002',
        supplier: 'Delta Plastics',
        supplierId: 'SUP-002',
        eta: '2026-07-02',
        status: '已发出',
        amount: 8000,
      },
      {
        po: 'PO-DONE',
        supplier: 'ABC Components',
        supplierId: 'SUP-001',
        eta: '2026-05-20',
        status: '已完成',
        amount: 3000,
      },
    ],
    supplierInvoices: [
      {
        id: 'SI-1001',
        invoiceNumber: 'INV-1001',
        supplier: 'ABC Components',
        supplierCode: 'SUP-001',
        status: '存在差异',
        matchStatus: '差异待处理',
        varianceType: '数量差异',
        varianceAmount: 500,
      },
      {
        id: 'SI-1002',
        invoiceNumber: 'INV-1002',
        supplier: 'Delta Plastics',
        supplierCode: 'SUP-002',
        status: '已过账应付',
        matchStatus: '自动匹配',
        varianceType: '无差异',
        varianceAmount: 0,
      },
    ],
    supplierReconciliationStatements: [
      {
        id: 'REC-1001',
        supplier: 'ABC Components',
        supplierCode: 'SUP-001',
        status: '存在差异',
        settlementStatus: '未结算',
      },
    ],
    supplierCreditMemos: [
      {
        id: 'CM-1001',
        supplier: 'ABC Components',
        supplierCode: 'SUP-001',
        total: 120,
      },
    ],
    contracts: [
      {
        id: 'BPA-1001',
        supplier: 'ABC Components',
        scope: 'A100 motors',
        status: '执行中',
        start: '2026-01-01',
        end: '2026-12-31',
        consumed: 0.4,
      },
      {
        id: 'BPA-1002',
        supplier: 'Delta Plastics',
        scope: 'Resin',
        status: '即将到期',
        start: '2026-01-01',
        end: '2026-07-01',
        consumed: 0.8,
      },
    ],
    rfqs: [
      {
        id: 'RFQ-1001',
        title: 'A100 motor RFQ',
        status: '进行中',
        suppliers: 3,
        quoted: 1,
        bestSupplier: 'ABC Components',
        invitedSuppliers: ['ABC Components', 'Delta Plastics'],
      },
    ],
    purchaseRequests: [],
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
      ensureRfqs(database) {
        return Array.isArray(database.rfqs) ? database.rfqs : []
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
    purchaseOrders: db.purchaseOrders,
    supplierInvoices: db.supplierInvoices,
    supplierReconciliationStatements: db.supplierReconciliationStatements,
    supplierCreditMemos: db.supplierCreditMemos,
    contracts: db.contracts,
    rfqs: db.rfqs,
  })
}

test('supplier operational catalog documents read-only capabilities', () => {
  assert.deepEqual(
    aiSupplierOperationalCapabilityCatalog.map((item) => item.intent),
    [
      'supplier_operational_summary_query',
      'supplier_operational_comparison_query',
      'supplier_high_risk_summary_query',
      'supplier_scoring_rule_query',
      'supplier_next_actions_query',
    ],
  )
  assert.ok(aiSupplierOperationalCapabilityCatalog.every((item) => item.mode === 'read'))
})

test('supplier operational query normalizes compatible payload fields', () => {
  assert.equal(normalizeSupplierOperationalMessage({ message: 'ABC Components PO invoice' }), 'ABC Components PO invoice')
  assert.equal(normalizeSupplierOperationalMessage({ prompt: 'Compare ABC Components and Delta Plastics' }), 'Compare ABC Components and Delta Plastics')
  assert.equal(normalizeSupplierOperationalMessage({ question: '这个供应商相关的 PO 和发票' }), '这个供应商相关的 PO 和发票')
  assert.equal(normalizeSupplierOperationalMessage({ text: 'SUP-001 contract inventory' }), 'SUP-001 contract inventory')
})

test('supplier resolver resolves exact code, exact name, and legacy name', () => {
  const db = createDb()
  const byCode = resolveSupplierEntities('SUP-001 PO invoice', db)
  const byName = resolveSupplierEntities('ABC Components PO invoice', db)
  const byLegacy = resolveSupplierEntities('ABC Co PO invoice', db)

  assert.equal(byCode.suppliers[0].supplierId, 'SUP-001')
  assert.equal(byName.suppliers[0].supplierId, 'SUP-001')
  assert.equal(byLegacy.suppliers[0].supplierId, 'SUP-001')
})

test('explicit supplier in message overrides activeContext supplier', () => {
  const response = buildAiSupplierOperationalResponse(createDb(), {
    message: 'Delta Plastics PO invoice contract inventory',
    activeContext: {
      module: 'srm',
      entityType: 'supplier',
      entityId: 'SUP-001',
      entityLabel: 'ABC Components',
    },
  })

  assert.equal(response.intent.name, 'supplier_operational_summary_query')
  assert.deepEqual(response.intent.slots.supplierIds, ['SUP-002'])
  assert.equal(response.cards[0].data.supplierName, 'Delta Plastics')
  assert.equal(response.evidence.some((item) => item.type === 'active_context'), false)
})

test('activeContext supplier works when no explicit supplier is provided', () => {
  const response = buildAiSupplierOperationalResponse(createDb(), {
    message: '这个供应商相关的 PO 和发票',
    activeContext: {
      module: 'srm',
      entityType: 'supplier',
      entityId: 'SUP-001',
      entityLabel: 'ABC Components',
    },
  })

  assert.equal(response.intent.name, 'supplier_operational_summary_query')
  assert.deepEqual(response.intent.slots.supplierIds, ['SUP-001'])
  assert.ok(response.evidence.some((item) => item.type === 'active_context' && item.id === 'SUP-001'))
})

test('ambiguous supplier mention returns ambiguous card', () => {
  const response = buildAiSupplierOperationalResponse(createDb(), { message: 'ABC supplier PO invoice' })

  assert.equal(response.intent.name, 'supplier_operational_summary_query')
  assert.ok(response.cards.some((card) => card.type === 'ambiguous_match'))
})

test('missing supplier returns missing field card', () => {
  const response = buildAiSupplierOperationalResponse(createDb(), { message: 'Missing Supplier PO invoice contract inventory' })

  assert.equal(response.intent.name, 'supplier_operational_summary_query')
  assert.ok(response.cards.some((card) => card.type === 'missing_fields'))
})

test('single supplier operational summary returns section cards and does not mutate business arrays', async () => {
  const db = createDb()
  const before = businessSnapshot(db)
  const route = createRouteContext({ message: 'ABC Components PO invoice contract inventory RFQ' }, db)
  const handled = await handleAiRoute(route.ctx)

  assert.ok(handled)
  assert.equal(route.response.status, 200)
  assert.equal(route.response.payload.provider, 'local_supplier_operational_query')
  assert.equal(route.response.payload.intent.name, 'supplier_operational_summary_query')
  assert.equal(route.response.payload.cards[0].type, 'supplier_operational_summary')
  assert.equal(route.response.payload.cards[0].data.supplierId, 'SUP-001')
  assert.ok(route.response.payload.cards.some((card) => card.type === 'supplier_related_po_summary'))
  assert.ok(route.response.payload.cards.some((card) => card.type === 'supplier_invoice_summary'))
  assert.ok(route.response.payload.cards.some((card) => card.type === 'supplier_contract_summary'))
  assert.ok(route.response.payload.cards.some((card) => card.type === 'supplier_inventory_risk_summary'))
  assert.ok(route.response.payload.cards.some((card) => card.type === 'supplier_rfq_summary'))
  assert.ok(route.response.payload.cards.some((card) => card.type === 'recommended_actions'))
  assert.deepEqual(businessSnapshot(db), before)
})

test('SRM module prompts return local read-only supplier risk and scoring cards', async () => {
  const prompts = [
    ['查看高风险供应商', 'supplier_high_risk_summary_query', 'supplier_high_risk_summary'],
    ['解释评分规则', 'supplier_scoring_rule_query', 'supplier_scoring_explanation'],
    ['下一步跟进', 'supplier_next_actions_query', 'supplier_next_actions'],
    ['哪些供应商 RFQ 没回复？', 'supplier_high_risk_summary_query', 'supplier_high_risk_summary'],
    ['哪些供应商交付风险高？', 'supplier_high_risk_summary_query', 'supplier_high_risk_summary'],
  ]

  for (const [message, intentName, cardType] of prompts) {
    const db = createDb()
    const before = businessSnapshot(db)
    const route = createRouteContext({ moduleId: 'srm', question: message }, db)
    await handleAiRoute(route.ctx)

    assert.equal(route.response.status, 200, message)
    assert.equal(route.response.payload.provider, 'local_supplier_operational_query', message)
    assert.equal(route.response.payload.intent.name, intentName, message)
    assert.equal(route.response.payload.mode, 'read', message)
    assert.equal(route.response.payload.usedWeb, false, message)
    assert.equal(route.response.payload.externalMs, 0, message)
    assert.match(route.response.payload.content, /SRM|供应商|评分|跟进|风险/, message)
    assert.match(route.response.payload.content, /不创建 RFQ|不发送供应商消息|不变更评分|不执行供应商主数据审批/, message)
    assert.ok(route.response.payload.cards.some((card) => card.type === cardType), message)
    assert.ok(route.response.payload.cards.some((card) => card.type === 'supplier_boundary_notice'), message)
    assert.ok(route.response.payload.cards.some((card) => card.type === 'recommended_actions'), message)
    assert.deepEqual(businessSnapshot(db), before, message)
  }
})

test('multi-supplier comparison resolves two names and returns comparison card', async () => {
  const db = createDb()
  const before = businessSnapshot(db)
  const route = createRouteContext({ message: 'Compare ABC Components and Delta Plastics' }, db)
  await handleAiRoute(route.ctx)

  assert.equal(route.response.status, 200)
  assert.equal(route.response.payload.intent.name, 'supplier_operational_comparison_query')
  assert.equal(route.response.payload.cards[0].type, 'supplier_operational_comparison')
  assert.deepEqual(route.response.payload.cards[0].data.suppliers.map((item) => item.supplierId), ['SUP-001', 'SUP-002'])
  assert.deepEqual(businessSnapshot(db), before)
})

test('comparison limits to top three suppliers when too many are mentioned', () => {
  const response = buildAiSupplierOperationalResponse(createDb(), {
    message: 'Compare ABC Components, Delta Plastics, ABC Tools and Echo Metals',
  })

  assert.equal(response.intent.name, 'supplier_operational_comparison_query')
  assert.equal(response.cards[0].data.suppliers.length, 3)
  assert.ok(response.evidence.some((item) => item.type === 'limited_data'))
})

test('one resolved supplier in comparison wording falls back to single summary', () => {
  const response = buildAiSupplierOperationalResponse(createDb(), { message: 'Compare ABC Components' })

  assert.equal(response.intent.name, 'supplier_operational_summary_query')
  assert.equal(response.cards[0].type, 'supplier_operational_summary')
})

test('intent precedence preserves existing status and draft routes', async () => {
  const statusRoute = createRouteContext({ message: 'supplier SUP-001 status' })
  await handleAiRoute(statusRoute.ctx)
  assert.equal(statusRoute.response.payload.intent.name, 'supplier_status_query')

  const prRoute = createRouteContext({ message: '帮我生成 PR A100 300 urgent' })
  await handleAiRoute(prRoute.ctx)
  assert.equal(prRoute.response.payload.intent.name, 'prepare_purchase_request_draft')

  const rfqDraftRoute = createRouteContext({ message: 'Create RFQ for A100 qty 1000' })
  await handleAiRoute(rfqDraftRoute.ctx)
  assert.equal(rfqDraftRoute.response.payload.intent.name, 'prepare_rfq_draft')

  const rfqPendingRoute = createRouteContext({ message: 'RFQ pending' })
  await handleAiRoute(rfqPendingRoute.ctx)
  assert.equal(rfqPendingRoute.response.payload.intent.name, 'rfq_response_query')

  const poRoute = createRouteContext({ message: 'PO overdue' })
  await handleAiRoute(poRoute.ctx)
  assert.equal(poRoute.response.payload.intent.name, 'po_overdue_query')

  const inventoryRoute = createRouteContext({ message: 'A100 inventory status' })
  await handleAiRoute(inventoryRoute.ctx)
  assert.equal(inventoryRoute.response.payload.intent.name, 'inventory_status_query')
})

test('entity index includes relationship-only supplier candidates', () => {
  const index = buildSupplierEntityIndex(createDb({
    suppliers: [],
    purchaseOrders: [{ po: 'PO-REL', supplier: 'Relationship Only Supplier' }],
  }))
  const resolution = resolveSupplierEntities('Relationship Only Supplier PO invoice', {}, { supplierIndex: index })

  assert.equal(resolution.status, 'resolved')
  assert.equal(resolution.suppliers[0].supplierName, 'Relationship Only Supplier')
})

test('supplier operational intent detection avoids pure status prompt', () => {
  assert.equal(detectAiSupplierOperationalIntent('supplier SUP-001 status'), null)
  assert.equal(buildAiSupplierOperationalResponse(createDb(), { message: 'ABC Components PO invoice' }).intent.name, 'supplier_operational_summary_query')
  assert.equal(detectAiSupplierOperationalIntent('Compare ABC Components and Delta Plastics'), 'supplier_operational_comparison_query')
  assert.equal(detectAiSupplierOperationalIntent('解释评分规则', { moduleId: 'srm' }), 'supplier_scoring_rule_query')
  assert.equal(detectAiSupplierOperationalIntent('下一步跟进', { moduleId: 'srm' }), 'supplier_next_actions_query')
  assert.equal(detectAiSupplierOperationalIntent('查看高风险供应商', { moduleId: 'srm' }), 'supplier_high_risk_summary_query')
})

test('supplier invoice summary reads stable variance codes from the database repository', async () => {
  const invoiceCard = async (invoice) => {
    const db = createDb()
    db.supplierInvoices = db.supplierInvoices.map((row) => row.supplier === 'Delta Plastics' ? { ...row, status: 'submitted', ...invoice } : row)
    const route = createRouteContext({ message: 'Delta Plastics PO invoice contract inventory RFQ' }, db)
    await handleAiRoute(route.ctx)
    return route.response.payload.cards.find((card) => card.type === 'supplier_invoice_summary').data
  }
  assert.equal((await invoiceCard({ matchStatus: 'pending', varianceType: 'none', varianceAmount: 0 })).invoiceVarianceCount, 0)
  assert.equal((await invoiceCard({ matchStatus: 'variance', varianceType: 'amount_variance', varianceAmount: 60 })).invoiceVarianceCount, 1)
})
