import test from 'node:test'
import assert from 'node:assert/strict'
import { handleAiRoute } from '../routes/ai.routes.mjs'

const alphaCriticalPrompts = Object.freeze([
  { moduleId: 'overview', question: '今天最需要处理什么？' },
  { moduleId: 'procurement', question: '今天采购有什么要跟？' },
  { moduleId: 'procurement', question: '哪些 PO 快逾期？' },
  { moduleId: 'procurement', question: '哪些 RFQ 没回复？' },
  { moduleId: 'procurement', question: '哪些采购申请还没转 PO？' },
  { moduleId: 'procurement', question: '哪些收货有异常？' },
  { moduleId: 'inventory', question: '查看库存风险' },
  { moduleId: 'inventory', question: '哪些库存项目需要关注？' },
  { moduleId: 'inventory', question: '解释库存异常' },
  { moduleId: 'inventory', question: '准备 PR 草稿' },
  { moduleId: 'forecast', question: '今天计划模块最需要处理什么？' },
  { moduleId: 'forecast', question: '哪些 SKU 有 MRP 例外？' },
  { moduleId: 'forecast', question: 'MRP 计划释放有哪些需要审阅？' },
  { moduleId: 'forecast', question: '这个 forecast 的 MAPE 怎么样？' },
  { moduleId: 'forecast', question: '这个 SKU 的计划参数是什么？' },
  { moduleId: 'finance', question: '查看待结算项' },
  { moduleId: 'finance', question: '解释差异原因' },
  { moduleId: 'finance', question: '下一步跟进' },
  { moduleId: 'srm', question: '查看高风险供应商' },
  { moduleId: 'srm', question: '解释评分规则' },
  { moduleId: 'master-data', question: '检查主数据质量' },
  { moduleId: 'master-data', question: '缺少哪些默认字段？' },
])

function createDb() {
  return {
    products: [
      { id: 'ITEM-A100', sku: 'A100', name: 'Motor A100', currentStock: 4, min: 20, moq: 10, reorderPoint: 15, safetyStock: 12, unit: 'pcs', baseUom: 'pcs', defaultWarehouseId: 'WH-A', preferredSupplierId: 'SUP-001', supplier: 'ABC Components', defaultTaxCode: 'TAX-STD', status: '低库存', riskLevel: '高', leadTimeDays: 7 },
      { id: 'ITEM-B200', sku: 'B200', name: 'Bracket B200', supplier: 'Unlisted Supplier', status: '待完善' },
    ],
    warehouses: [{ id: 'WH-A', name: 'Main Warehouse', sourceType: 'explicit_data' }],
    suppliers: [
      { id: 'SUP-001', supplierId: 'SUP-001', name: 'ABC Components', supplierName: 'ABC Components', status: 'active', risk: 'medium', score: 82, paymentTermsId: 'NET30', defaultCurrency: 'USD' },
      { id: 'SUP-002', name: 'No Score Supplier', risk: '高' },
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
    inventoryExceptions: [
      { id: 'IEX-1001', sku: 'A100', itemName: 'Motor A100', status: '待复核', quantityImpact: -6, nextAction: '复核低库存' },
    ],
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
  let wrote = false
  return {
    ctx: {
      req: { method: 'POST', headers: {}, body },
      res: {},
      url: new URL('/api/ai/chat', 'http://localhost'),
      db,
      readBody: async (req) => req.body,
      writeDb: async () => { wrote = true },
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
    get wrote() {
      return wrote
    },
  }
}

function businessSnapshot(db) {
  return structuredClone({
    products: db.products,
    suppliers: db.suppliers,
    warehouses: db.warehouses,
    paymentTerms: db.paymentTerms,
    taxCodes: db.taxCodes,
    rfqs: db.rfqs,
    purchaseRequests: db.purchaseRequests,
    purchaseOrders: db.purchaseOrders,
    receivingDocs: db.receivingDocs,
    supplierInvoices: db.supplierInvoices,
    inventoryMovements: db.inventoryMovements,
    inventoryExceptions: db.inventoryExceptions,
    forecastPlans: db.forecastPlans,
  })
}

test('R81 Alpha-critical AI prompts are localized, provider-free, and non-mutating', async () => {
  for (const prompt of alphaCriticalPrompts) {
    const db = createDb()
    const before = businessSnapshot(db)
    const route = createRouteContext(prompt, db)
    await handleAiRoute(route.ctx)

    const label = `${prompt.moduleId}: ${prompt.question}`
    const payload = route.response?.payload
    const content = String(payload?.content || payload?.message || '')

    assert.equal(route.response?.status, 200, label)
    assert.notEqual(payload.intent?.name, 'provider_disabled', label)
    assert.notEqual(payload.providerStatus, 'blocked', label)
    assert.notEqual(payload.provider, 'openai', label)
    assert.notEqual(payload.provider, 'doubao', label)
    assert.equal(payload.usedWeb, false, label)
    assert.equal(payload.externalMs, 0, label)
    assert.match(content, /[\u4e00-\u9fa5]/, label)
    assert.doesNotMatch(content, /^\s*[{[]/, label)
    assert.doesNotMatch(content, /```|"\s*(cards|type|data|intent)"\s*:/, label)
    assert.deepEqual(businessSnapshot(db), before, label)

    if (payload.mode === 'draft_preparation') {
      assert.notEqual(payload.intent?.name, 'confirm_action_draft', label)
      const draftCard = (payload.cards || []).find((card) => card.type === 'pr_draft' || card.type === 'rfq_draft')
      assert.equal(draftCard?.reviewRequired, true, label)
    }
  }
})
