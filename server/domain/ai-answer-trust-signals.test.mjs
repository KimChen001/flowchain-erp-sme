import test from 'node:test'
import assert from 'node:assert/strict'
import { handleAiRoute } from '../routes/ai.routes.mjs'

function createDb() {
  return {
    products: [
      { id: 'ITEM-A100', sku: 'A100', name: 'Motor A100', currentStock: 4, min: 20, moq: 10, reorderPoint: 15, safetyStock: 12, unit: 'pcs', baseUom: 'pcs', defaultWarehouseId: 'WH-A', preferredSupplierId: 'SUP-001', supplier: 'ABC Components', defaultTaxCode: 'TAX-STD', status: '低库存', riskLevel: '高', leadTimeDays: 7 },
      { id: 'ITEM-B200', sku: 'B200', name: 'Bracket B200', supplier: 'Unlisted Supplier', status: '待完善' },
    ],
    warehouses: [{ id: 'WH-A', name: 'Main Warehouse', sourceType: 'explicit_data' }],
    suppliers: [
      { id: 'SUP-001', supplierId: 'SUP-001', name: 'ABC Components', supplierName: 'ABC Components', status: 'active', risk: '高', score: 68, paymentTermsId: 'NET30', defaultCurrency: 'USD' },
      { id: 'SUP-002', name: 'No Score Supplier', risk: '中' },
    ],
    paymentTerms: [{ id: 'NET30', label: 'Net 30', days: 30 }],
    taxCodes: [{ id: 'TAX-STD', label: 'Standard Tax', rate: 0.1 }],
    rfqs: [
      { id: 'RFQ-1001', rfq: 'RFQ-1001', title: 'A100 RFQ', status: '进行中', suppliers: 2, quoted: 1, due: '2026-07-03', sourceSku: 'A100', sourceRequest: 'PR-1001', bestSupplier: 'ABC Components', invitedSuppliers: ['ABC Components', 'No Score Supplier'], responses: [{ supplierId: 'SUP-001', supplierName: 'ABC Components', responseStatus: 'pending' }] },
    ],
    purchaseRequests: [
      { pr: 'PR-1001', id: 'PR-1001', status: '已批准', sourceSku: 'A100', sourceName: 'Motor A100', quantity: 100, requiredDate: '2026-07-05', supplier: 'ABC Components', priority: '高' },
      { pr: 'PR-1002', id: 'PR-1002', status: '待审批', sourceSku: 'A100', quantity: 40, requiredDate: '2026-07-06', supplier: 'ABC Components', priority: '中' },
    ],
    purchaseOrders: [
      { po: 'PO-1001', id: 'PO-1001', supplier: 'ABC Components', supplierId: 'SUP-001', eta: '2026-06-20', status: '已发出', items: 100, received: 40, sourceRequest: 'PR-1001', priority: '高', lines: [{ sku: 'A100', quantity: 100 }] },
    ],
    receivingDocs: [
      { grn: 'GRN-1001', id: 'GRN-1001', po: 'PO-1001', supplier: 'ABC Components', supplierId: 'SUP-001', items: 100, passed: 35, failed: 5, status: '异常处理', warehouse: 'WH-A', lines: [{ sku: 'A100', rejectedQty: 5 }] },
    ],
    supplierInvoices: [
      { id: 'SI-1001', invoiceNumber: 'INV-1001', supplier: 'ABC Components', supplierCode: 'SUP-001', relatedPo: 'PO-1001', relatedGrn: 'GRN-1001', amount: 1000, currency: 'USD', status: '存在差异', matchStatus: '差异待处理', varianceType: '数量差异', varianceAmount: 120 },
    ],
    inventoryMovements: [
      { movementId: 'MV-1001', id: 'MV-1001', sku: 'A100', itemName: 'Motor A100', quantity: -6, status: 'posted', warehouse: 'WH-A' },
    ],
    inventoryExceptions: [{ id: 'IEX-1001', sku: 'A100', itemName: 'Motor A100', status: '待复核', quantityImpact: -6 }],
    salesForecasts: [{ sku: 'A100', period: '2026-W27', demand: 120 }],
    forecastPlans: [{ id: 'FC-1001', sku: 'A100', name: 'A100 Forecast', method: 'moving_average', metrics: { mape: 0.18, rmse: 4.2 }, procurementSuggestion: { quantity: 50, amount: 5000, supplier: 'ABC Components', priority: '高' } }],
    bom: [],
    marketPrices: [],
    marketSignals: [],
    events: [],
    auditLog: [],
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
      event: () => {},
      ensureRfqs: (database) => Array.isArray(database.rfqs) ? database.rfqs : [],
      ensurePurchaseRequests: (database) => Array.isArray(database.purchaseRequests) ? database.purchaseRequests : [],
      ensureInventoryMovements: (database) => Array.isArray(database.inventoryMovements) ? database.inventoryMovements : [],
      ensureEvents: (database) => Array.isArray(database.events) ? database.events : [],
      ensureAuditLog: (database) => Array.isArray(database.auditLog) ? database.auditLog : [],
      supplierPerformance: (database) => database.suppliers || [],
      supplierRecommendations: () => null,
      supplierQuoteCount: 1,
      openaiDispatcher: { dispatch() { throw new Error('external provider should not be used') } },
      arkDispatcher: { dispatch() { throw new Error('external provider should not be used') } },
      aiMaxTokens: 120,
      repositories: {},
      send(_res, status, payload) {
        response = { status, payload }
      },
    },
    get response() {
      return response
    },
  }
}

async function ask(body) {
  const route = createRouteContext(body)
  await handleAiRoute(route.ctx)
  assert.equal(route.response?.status, 200, body.question || body.message)
  return route.response.payload
}

function visibleText(payload) {
  return JSON.stringify({
    message: payload.message || payload.content || '',
    cards: payload.cards,
    evidence: payload.evidence,
  })
}

function actions(payload) {
  return payload.cards
    .filter((card) => card.type === 'recommended_actions')
    .flatMap((card) => card.actions || [])
}

test('R85 critical AI answers keep summary evidence action and boundary trust signals', async () => {
  const prompts = [
    { moduleId: 'procurement', question: '今天采购有什么要跟？', boundary: /采购|PR|PO|RFQ|收货/ },
    { moduleId: 'inventory', question: '查看库存风险', boundary: /库存余额风险|库存事务风险|MRP\/计划风险/ },
    { moduleId: 'finance', question: '查看待结算项', boundary: /不执行付款|过账|最终审批/ },
    { moduleId: 'srm', question: '查看高风险供应商', boundary: /不创建 RFQ|不发送供应商消息|不变更评分/ },
    { moduleId: 'master-data', question: '检查主数据质量', boundary: /不创建或修改主数据|不自动修复默认值/ },
  ]

  for (const prompt of prompts) {
    const payload = await ask(prompt)
    const label = `${prompt.moduleId}: ${prompt.question}`
    const text = visibleText(payload)

    assert.notEqual(payload.intent?.name, 'provider_disabled', label)
    assert.match(payload.message || payload.content || '', /[\u4e00-\u9fa5]/, label)
    assert.ok((payload.evidence || []).length > 0, label)
    assert.ok(payload.cards.some((card) => card.type === 'evidence'), label)
    assert.ok(actions(payload).length > 0, label)
    assert.match(text, prompt.boundary, label)
    assert.doesNotMatch(text, /I found|Please provide|No .*found|not available|read-only lookup|Open |Review /, label)
    assert.doesNotMatch(text, /已执行付款|可执行付款|将执行付款|已过账|过账已启用|将自动修复|automatic correction/i, label)
  }
  // Forecast / MRP planning is an unavailable module: its answer keeps the
  // read-only boundary but offers no action into the planning pages.
  const planning = await ask({ moduleId: 'forecast', question: '今天计划模块最需要处理什么？' })
  assert.match(visibleText(planning), /只读|不创建 PR\/PO|人工复核/)
  assert.ok(actions(planning).every((action) => !String(action.target || action.moduleId || '').startsWith('forecast')))
})

test('R85 draft preparation copy stays preview-only and localized', async () => {
  const payload = await ask({ moduleId: 'inventory', question: '准备 PR 草稿 A100 50 明天' })
  const text = visibleText(payload)
  assert.equal(payload.intent.name, 'prepare_purchase_request_draft')
  assert.ok(payload.cards.some((card) => card.type === 'pr_draft' && card.reviewRequired === true))
  assert.match(payload.message, /草稿|人工复核|可复核/)
  assert.doesNotMatch(text, /Edit supplier list|No quantity|No item master|No reliable supplier|ready to submit/i)
})
