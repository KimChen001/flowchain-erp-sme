import test from 'node:test'
import assert from 'node:assert/strict'
import { handleAiRoute } from '../routes/ai.routes.mjs'
import {
  aiChatStatusCapabilityCatalog,
  buildAiChatStatusResponse,
  detectAiChatStatusIntent,
  normalizeAiChatMessage,
} from './ai-chat-status.mjs'

function createDb(overrides = {}) {
  return {
    products: [
      {
        sku: 'A100',
        name: 'Motor A100',
        category: 'Components',
        supplier: 'ABC Components',
        defaultWarehouseId: 'WH-MAIN',
        moq: 100,
      },
      {
        sku: 'B200',
        name: 'Bracket B200',
        category: 'Components',
        availableQuantity: 0,
        defaultWarehouseId: 'WH-SECONDARY',
        moq: 50,
      },
    ],
    suppliers: [
      {
        id: 'SUP-001',
        name: 'ABC Components',
        category: 'Motors',
        risk: '中',
        onTimeRate: 84,
        qualityRate: 90,
        preferred: true,
      },
    ],
    warehouses: [
      { id: 'WH-MAIN', name: 'Main Warehouse' },
    ],
    purchaseOrders: [
      {
        po: 'PO-1001',
        supplier: 'ABC Components',
        supplierId: 'SUP-001',
        eta: '2026-06-01',
        status: '已发出',
        priority: '高',
        lines: [{ sku: 'A100', itemId: 'ITEM-A100' }],
      },
    ],
    purchaseRequests: [
      {
        pr: 'PR-2001',
        status: '待审批',
        priority: '中',
        sourceSku: 'A100',
      },
    ],
    rfqs: [
      {
        id: 'RFQ-3001',
        status: '进行中',
        due: '2026-06-20',
        sku: 'A100',
      },
    ],
    receivingDocs: [
      {
        grn: 'GRN-4001',
        supplier: 'ABC Components',
        status: '异常处理',
        failed: 2,
        lines: [{ sku: 'A100' }],
      },
    ],
    inventoryMovements: [
      {
        id: 'MV-5001',
        sku: 'A100',
        warehouseId: 'WH-MAIN',
        quantity: 10,
      },
    ],
    ...overrides,
  }
}

function createRouteContext(body, db = createDb(), helpers = {}) {
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
      ...helpers,
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
    purchaseRequests: db.purchaseRequests,
    rfqs: db.rfqs,
    receivingDocs: db.receivingDocs,
    inventoryMovements: db.inventoryMovements,
  })
}

test('AI chat status catalog documents read-only prompt patterns', () => {
  assert.equal(aiChatStatusCapabilityCatalog.length, 4)
  assert.ok(aiChatStatusCapabilityCatalog.every((item) => item.mode === 'read'))
  assert.deepEqual(
    aiChatStatusCapabilityCatalog.map((item) => item.intent),
    ['supplier_status_query', 'inventory_status_query', 'procurement_exception_query', 'planning_status_query'],
  )
})

test('AI chat normalizes compatible message fields', () => {
  assert.equal(normalizeAiChatMessage({ message: 'Show supplier status' }), 'Show supplier status')
  assert.equal(normalizeAiChatMessage({ prompt: '今天库存有什么风险？' }), '今天库存有什么风险？')
  assert.equal(normalizeAiChatMessage({ question: 'Which purchase orders are overdue?' }), 'Which purchase orders are overdue?')
})

test('AI chat detects supported read-only status intents', () => {
  assert.equal(detectAiChatStatusIntent('supplier SUP-001 risk'), 'supplier_status_query')
  assert.equal(detectAiChatStatusIntent('Show item A100 inventory status'), 'inventory_status_query')
  assert.equal(detectAiChatStatusIntent('Show overdue POs'), 'procurement_exception_query')
  assert.equal(detectAiChatStatusIntent('哪些 SKU 有 MRP 例外？'), 'planning_status_query')
  assert.equal(detectAiChatStatusIntent('这个 forecast 的 MAPE 怎么样？'), 'planning_status_query')
})

test('supplier status query returns supplier card, evidence, and actions', () => {
  const response = buildAiChatStatusResponse(createDb(), { message: 'Show me supplier ABC status' }, { now: new Date('2026-06-25T00:00:00.000Z') })

  assert.equal(response.intent.name, 'supplier_status_query')
  assert.equal(response.intent.slots.supplier, 'SUP-001')
  assert.equal(response.cards[0].type, 'supplier_status')
  assert.equal(response.cards[0].data.supplierId, 'SUP-001')
  assert.equal(response.cards[0].data.scoreSource, 'missing')
  assert.equal(response.cards[0].data.openPoCount, 1)
  assert.equal(response.cards[0].data.overduePoCount, 1)
  assert.ok(response.cards.some((card) => card.type === 'evidence'))
  assert.ok(response.cards.some((card) => card.type === 'recommended_actions'))
  assert.ok(response.evidence.some((item) => item.type === 'supplier_master'))
})

test('supplier id query resolves canonical supplier id', async () => {
  const db = createDb()
  const before = businessSnapshot(db)
  const route = createRouteContext({ prompt: 'supplier SUP-001 risk' }, db)
  const handled = await handleAiRoute(route.ctx)

  assert.ok(handled)
  assert.equal(route.response.status, 200)
  assert.equal(route.response.payload.intent.name, 'supplier_status_query')
  assert.equal(route.response.payload.cards[0].data.supplierId, 'SUP-001')
  assert.deepEqual(businessSnapshot(db), before)
})

test('supplier status query resolves supplier id from active context', async () => {
  const db = createDb()
  const before = businessSnapshot(db)
  const route = createRouteContext({
    message: '这个供应商最近怎么样？',
    activeContext: {
      module: 'srm',
      entityType: 'supplier',
      entityId: 'SUP-001',
      entityLabel: 'ABC Components',
    },
  }, db)
  const handled = await handleAiRoute(route.ctx)

  assert.ok(handled)
  assert.equal(route.response.status, 200)
  assert.equal(route.response.payload.intent.name, 'supplier_status_query')
  assert.equal(route.response.payload.intent.slots.supplier, 'SUP-001')
  assert.equal(route.response.payload.cards[0].type, 'supplier_status')
  assert.ok(route.response.payload.evidence.some((item) => item.type === 'active_context' && item.id === 'SUP-001'))
  assert.deepEqual(businessSnapshot(db), before)
})

test('supplier status query does not use incompatible active context', () => {
  const response = buildAiChatStatusResponse(createDb(), {
    message: '这个供应商最近怎么样？',
    activeContext: {
      entityType: 'rfq',
      entityId: 'RFQ-1001',
    },
  })

  assert.equal(response.intent.name, 'supplier_status_query')
  assert.ok(response.cards.some((card) => card.type === 'missing_fields'))
  assert.equal(response.evidence.some((item) => item.type === 'active_context'), false)
})

test('supplier query returns missing field card when supplier is not found', () => {
  const response = buildAiChatStatusResponse(createDb(), { message: 'supplier Missing Vendor status' })

  assert.equal(response.intent.name, 'supplier_status_query')
  assert.ok(response.cards.some((card) => card.type === 'missing_fields'))
  assert.ok(response.evidence.some((item) => item.type === 'supplier_master'))
})

test('supplier query returns ambiguous match card when multiple suppliers match', () => {
  const response = buildAiChatStatusResponse(createDb({
    suppliers: [
      { id: 'SUP-001', name: 'ABC Components' },
      { id: 'SUP-002', name: 'ABC Tools' },
    ],
  }), { message: 'ABC supplier status' })

  assert.equal(response.intent.name, 'supplier_status_query')
  assert.ok(response.cards.some((card) => card.type === 'ambiguous_match'))
})

test('item-specific inventory query returns missing quantity evidence when balance is unavailable', async () => {
  const db = createDb()
  const before = businessSnapshot(db)
  const route = createRouteContext({ message: 'A100 库存怎么样？' }, db)
  const handled = await handleAiRoute(route.ctx)

  assert.ok(handled)
  assert.equal(route.response.status, 200)
  assert.equal(route.response.payload.intent.name, 'inventory_status_query')
  assert.equal(route.response.payload.cards[0].type, 'inventory_status')
  assert.equal(route.response.payload.cards[0].data.sku, 'A100')
  assert.equal(route.response.payload.cards[0].data.availableQuantity, null)
  assert.equal(route.response.payload.cards[0].data.riskLevel, 'unknown')
  assert.equal(route.response.payload.cards[0].data.riskReason, '当前数据缺少可用库存余额字段，因此无法确认 SKU 级库存余额风险；但可以基于库存事务、MRP 例外和主数据完整性给出观察项。')
  assert.match(route.response.payload.message, /当前数据缺少可用库存余额字段/)
  assert.ok(route.response.payload.evidence.some((item) => item.type === 'inventory_item' && item.id === 'A100'))
  assert.ok(route.response.payload.evidence.some((item) => item.type === 'missing_quantity_evidence'))
  assert.ok(route.response.payload.cards.some((card) => card.type === 'recommended_actions'))
  const actions = route.response.payload.cards.find((card) => card.type === 'recommended_actions').actions
  assert.ok(actions.some((action) => action.target === '/inventory?sku=A100'))
  assert.ok(actions.some((action) => action.target === '/inventory?view=movements&sku=A100'))
  assert.ok(actions.every((action) => !/^https?:\/\//i.test(action.target || '')))
  assert.deepEqual(businessSnapshot(db), before)
})

test('item-specific inventory query resolves item id from active context', () => {
  const response = buildAiChatStatusResponse(createDb(), {
    message: '这个 item 库存够不够？',
    activeContext: {
      module: 'inventory',
      entityType: 'item',
      entityId: 'ITEM-A100',
      entityLabel: 'Motor A100',
    },
  })

  assert.equal(response.intent.name, 'inventory_status_query')
  assert.equal(response.intent.slots.item, 'ITEM-A100')
  assert.equal(response.cards[0].type, 'inventory_status')
  assert.equal(response.cards[0].data.itemId, 'ITEM-A100')
  assert.equal(response.cards[0].data.sku, 'A100')
  assert.ok(response.evidence.some((item) => item.type === 'active_context' && item.id === 'ITEM-A100'))
})

test('item-specific inventory query does not use incompatible active context', () => {
  const response = buildAiChatStatusResponse(createDb(), {
    message: '这个 item 库存够不够？',
    activeContext: {
      entityType: 'supplier',
      entityId: 'SUP-001',
    },
  })

  assert.equal(response.intent.name, 'inventory_status_query')
  assert.equal(response.cards[0].type, 'inventory_risk_summary')
  assert.equal(response.evidence.some((item) => item.type === 'active_context'), false)
})

test('item-specific inventory query marks zero quantity as high risk', () => {
  const response = buildAiChatStatusResponse(createDb(), { message: 'B200 inventory status' })

  assert.equal(response.intent.name, 'inventory_status_query')
  assert.equal(response.cards[0].data.sku, 'B200')
  assert.equal(response.cards[0].data.availableQuantity, 0)
  assert.equal(response.cards[0].data.riskLevel, 'high')
  assert.equal(response.cards[0].data.riskReason, '可用库存为 0 或低于 0，需要优先复核补货。')
})

test('item-specific inventory query marks quantity below MOQ as medium risk', () => {
  const response = buildAiChatStatusResponse(createDb({
    products: [{ sku: 'C300', name: 'Cap C300', availableQuantity: 20, moq: 50 }],
  }), { message: 'C300 inventory status' })

  assert.equal(response.intent.name, 'inventory_status_query')
  assert.equal(response.cards[0].data.availableQuantity, 20)
  assert.equal(response.cards[0].data.riskLevel, 'medium')
  assert.equal(response.cards[0].data.riskReason, '可用库存低于 MOQ/补货批量口径，需要关注补货节奏。')
})

test('item-specific inventory query marks quantity at or above MOQ as low risk', () => {
  const response = buildAiChatStatusResponse(createDb({
    products: [{ sku: 'D400', name: 'Disc D400', availableQuantity: 50, moq: 50 }],
  }), { message: 'D400 inventory status' })

  assert.equal(response.intent.name, 'inventory_status_query')
  assert.equal(response.cards[0].data.availableQuantity, 50)
  assert.equal(response.cards[0].data.riskLevel, 'low')
  assert.equal(response.cards[0].data.riskReason, '可用库存不低于 MOQ/补货批量口径，余额风险较低。')
})

test('general inventory risk query returns inventory risk summary', () => {
  const response = buildAiChatStatusResponse(createDb(), { prompt: '今天库存有什么风险？' })

  assert.equal(response.intent.name, 'inventory_status_query')
  assert.equal(response.cards[0].type, 'inventory_risk_summary')
  assert.equal(response.cards[0].data.riskItemCount, 1)
  assert.equal(response.cards[0].title, '库存风险摘要')
  assert.match(response.message, /库存风险信号|缺少可用库存余额字段/)
  assert.ok(response.cards.some((card) => card.type === 'evidence'))
})

test('inventory AI controlled-review prompts return localized deterministic evidence actions and stay read-only', async () => {
  const db = createDb()
  const before = businessSnapshot(db)
  const prompts = [
    ['A100 库存怎么样？', 'inventory_status'],
    ['A100 movement history', 'inventory_status'],
    ['今天库存有什么风险？', 'inventory_risk_summary', 'inventory_status'],
    ['inventory exceptions', 'inventory_risk_summary', 'inventory_status'],
    ['查看库存风险', 'inventory_risk_summary', 'inventory_status'],
    ['哪些库存项目需要关注？', 'inventory_risk_summary', 'inventory_status'],
    ['解释库存异常', 'inventory_risk_summary', 'inventory_status'],
    ['哪些 SKU 低于安全库存？', 'inventory_risk_summary', 'inventory_status'],
  ]

  for (const [message, ...cardTypes] of prompts) {
    const route = createRouteContext({ message }, db)
    await handleAiRoute(route.ctx)

    assert.equal(route.response.status, 200, message)
    assert.equal(route.response.payload.intent.name, 'inventory_status_query', message)
    assert.ok(cardTypes.includes(route.response.payload.cards[0].type), message)
    assert.equal(route.response.payload.usedWeb, false, message)
    assert.notEqual(route.response.payload.provider, 'openai', message)
    assert.notEqual(route.response.payload.provider, 'doubao', message)
    assert.doesNotMatch(route.response.payload.message || route.response.payload.content || '', /\bitems show\b|\bNo item-level\b|\bavailable quantity\b/i, message)
    assert.ok(route.response.payload.cards.some((card) => card.type === 'evidence'), message)
    assert.ok(route.response.payload.cards.some((card) => card.type === 'recommended_actions'), message)
    const actions = route.response.payload.cards.find((card) => card.type === 'recommended_actions').actions
    assert.ok(actions.every((action) => !/^https?:\/\//i.test(action.target || '')), message)
  }

  assert.deepEqual(businessSnapshot(db), before)
})

test('procurement exception query returns ranked exception summary and actions', async () => {
  const db = createDb()
  const before = businessSnapshot(db)
  const route = createRouteContext({ message: '今天有哪些采购问题需要处理？' }, db)
  const handled = await handleAiRoute(route.ctx)

  assert.ok(handled)
  assert.equal(route.response.status, 200)
  assert.equal(route.response.payload.intent.name, 'procurement_exception_query')
  assert.equal(route.response.payload.cards[0].type, 'procurement_exception_summary')
  assert.equal(route.response.payload.cards[0].data.overduePoCount, 1)
  assert.equal(route.response.payload.cards[0].data.pendingPrCount, 1)
  assert.equal(route.response.payload.cards[0].data.pendingRfqCount, 1)
  assert.equal(route.response.payload.cards[0].data.receivingIssueCount, 1)
  assert.ok(route.response.payload.cards[0].data.topIssues.some((issue) => issue.type === 'overdue_purchase_order'))
  assert.ok(route.response.payload.cards.some((card) => card.type === 'recommended_actions'))
  assert.deepEqual(businessSnapshot(db), before)
})

test('procurement exception query uses helper-provided purchase requests when available', () => {
  const db = createDb({ purchaseRequests: [] })
  const response = buildAiChatStatusResponse(db, { message: 'pending procurement issues' }, {
    ensurePurchaseRequests: () => [
      { pr: 'PR-HELPER-001', status: 'open', priority: '高', sourceSku: 'A100' },
      { pr: 'PR-HELPER-002', status: 'completed', priority: '中', sourceSku: 'B200' },
    ],
  })

  assert.equal(response.intent.name, 'procurement_exception_query')
  assert.equal(response.cards[0].data.pendingPrCount, 1)
  assert.ok(response.cards[0].data.topIssues.some((issue) => issue.id === 'PR-HELPER-001'))
  assert.ok(response.evidence.some((item) => item.type === 'purchase_request' && item.summary.includes('已检查 2 张采购申请')))
})

test('route passes helper-based purchase request access into status query', async () => {
  const db = createDb({ purchaseRequests: [] })
  const route = createRouteContext({ message: 'pending procurement issues' }, db, {
    ensurePurchaseRequests: () => [{ pr: 'PR-ROUTE-001', status: 'pending', sourceSku: 'A100' }],
  })
  const handled = await handleAiRoute(route.ctx)

  assert.ok(handled)
  assert.equal(route.response.status, 200)
  assert.equal(route.response.payload.cards[0].data.pendingPrCount, 1)
})

test('procurement terminal statuses include completed, closed, and cancelled English records', () => {
  const response = buildAiChatStatusResponse(createDb({
    purchaseOrders: [
      { po: 'PO-COMPLETE', status: 'completed', eta: '2026-06-01' },
      { po: 'PO-CLOSED', status: 'closed', eta: '2026-06-01' },
      { po: 'PO-CANCELLED', status: 'cancelled', eta: '2026-06-01' },
    ],
    purchaseRequests: [
      { pr: 'PR-COMPLETE', status: 'complete' },
      { pr: 'PR-CLOSED', status: 'closed' },
      { pr: 'PR-CANCELED', status: 'canceled' },
    ],
    rfqs: [
      { id: 'RFQ-DONE', status: 'done' },
      { id: 'RFQ-POSTED', status: 'posted' },
    ],
    receivingDocs: [],
  }), { message: 'pending procurement issues' }, { now: new Date('2026-06-25T00:00:00.000Z') })

  assert.equal(response.cards[0].data.overduePoCount, 0)
  assert.equal(response.cards[0].data.pendingPrCount, 0)
  assert.equal(response.cards[0].data.pendingRfqCount, 0)
  assert.equal(response.cards[0].data.totalIssueCount, 0)
})

test('procurement open statuses still count as pending issues', () => {
  const response = buildAiChatStatusResponse(createDb({
    purchaseOrders: [],
    purchaseRequests: [
      { pr: 'PR-OPEN', status: 'open' },
      { pr: 'PR-PENDING', status: 'pending' },
      { pr: 'PR-CN', status: '待审批' },
    ],
    rfqs: [
      { id: 'RFQ-PROGRESS', status: '进行中' },
    ],
    receivingDocs: [],
  }), { message: 'pending procurement issues' })

  assert.equal(response.cards[0].data.pendingPrCount, 3)
  assert.equal(response.cards[0].data.pendingRfqCount, 1)
  assert.equal(response.cards[0].data.totalIssueCount, 4)
})

test('overdue PO prompt is handled as procurement exception query', () => {
  const response = buildAiChatStatusResponse(createDb(), { message: 'Which purchase orders are overdue?' }, { now: new Date('2026-06-25T00:00:00.000Z') })

  assert.equal(response.intent.name, 'procurement_exception_query')
  assert.equal(response.intent.slots.documentType, 'purchase_order')
  assert.equal(response.cards[0].data.overduePoCount, 1)
})

test('procurement exception query returns empty state when no issues are available', () => {
  const response = buildAiChatStatusResponse(createDb({
    purchaseOrders: [{ po: 'PO-OK', status: '已完成', eta: '2026-06-01' }],
    purchaseRequests: [],
    rfqs: [],
    receivingDocs: [],
  }), { message: 'pending procurement issues' })

  assert.equal(response.intent.name, 'procurement_exception_query')
  assert.equal(response.cards[0].type, 'procurement_exception_summary')
  assert.equal(response.cards[0].data.totalIssueCount, 0)
  assert.ok(response.evidence.some((item) => item.type === 'empty_state'))
})

test('planning AI controlled-review prompts return deterministic Forecast/MRP evidence and stay read-only', async () => {
  const db = createDb({
    products: [
      { sku: 'SKU-FG', name: 'Finished Good', category: 'FG', currentStock: 0, allocated: 0, safetyStock: 10, moq: 50, batchMultiple: 10, leadTimePeriods: 2, unit: 'pcs', supplier: 'ABC Components', unitPrice: 10 },
      { sku: 'SKU-COMP', name: 'Component', category: 'Component', currentStock: 0, allocated: 0, safetyStock: 20, moq: 100, batchMultiple: 10, leadTimePeriods: 3, unit: 'pcs', supplier: 'ABC Components', unitPrice: 3 },
    ],
    salesForecasts: [
      { sku: 'SKU-FG', monthlyDemand: [120, 140, 160, 160, 150, 145] },
    ],
    bom: [
      { parent: 'SKU-FG', component: 'SKU-COMP', qtyPer: 2, scrapPct: 0.05, leadTimeOffset: 1 },
    ],
    forecastPlans: [
      { id: 'FC-PLAN-001', sku: 'SKU-FG', name: 'Finished Good', method: 'holt-winters', metrics: { mape: 8.4, rmse: 12.1 } },
    ],
  })
  const before = businessSnapshot(db)
  const prompts = [
    '哪些 SKU 有 MRP 例外？',
    '这个 SKU 为什么 MRP 加急？',
    'MRP 计划释放有哪些需要审阅？',
    '这个 forecast 的 MAPE 怎么样？',
    '这个 SKU 的计划参数是什么？',
  ]

  for (const message of prompts) {
    const route = createRouteContext({ message, moduleId: 'forecast' }, db)
    await handleAiRoute(route.ctx)

    assert.equal(route.response.status, 200, message)
    assert.equal(route.response.payload.intent.name, 'planning_status_query', message)
    assert.equal(route.response.payload.cards[0].type, 'planning_status_summary', message)
    assert.equal(route.response.payload.cards[0].data.reviewBoundary, 'read_only_planning_evidence_no_pr_po_created', message)
    assert.equal(route.response.payload.usedWeb, false, message)
    assert.notEqual(route.response.payload.provider, 'openai', message)
    assert.notEqual(route.response.payload.provider, 'doubao', message)
    assert.ok(route.response.payload.cards.some((card) => card.type === 'evidence'), message)
    assert.ok(route.response.payload.cards.some((card) => card.type === 'recommended_actions'), message)
    assert.ok(route.response.payload.evidence.some((item) => item.type === 'mrp_plan'), message)
    const actions = route.response.payload.cards.find((card) => card.type === 'recommended_actions').actions
    assert.ok(actions.every((action) => String(action.target).startsWith('forecast:')), message)
    assert.ok(route.response.payload.evidence.every((item) => !item.moduleId || String(item.moduleId).startsWith('forecast:')), message)
  }

  assert.deepEqual(businessSnapshot(db), before)
})

// Forecast / MRP planning is an unavailable module (owner decision): the answer
// stays, but its actions no longer route into the planning pages.
test('planning AI recommended actions offer no link into the unavailable planning pages', () => {
  const cases = [
    ['今天计划模块最需要处理什么？', 'forecast:cockpit'],
    ['这个 forecast 的 MAPE 怎么样？', 'forecast:demand'],
    ['哪些 SKU 有 MRP 例外？', 'forecast:mrp'],
    ['MRP 计划释放有哪些需要审阅？', 'forecast:replenishment'],
    ['哪些补货建议需要转成草稿？', 'forecast:replenishment'],
    ['这个 SKU 的计划参数是什么？', 'forecast:parameters'],
  ]

  for (const [message, expectedTarget] of cases) {
    const response = buildAiChatStatusResponse(createDb(), { message, moduleId: 'forecast' })
    const actions = response.cards.find((card) => card.type === 'recommended_actions').actions

    assert.equal(response.intent.name, 'planning_status_query', message)
    assert.ok(!actions.some((action) => action.target === expectedTarget), message)
    assert.ok(actions.every((action) => !String(action.target).startsWith('forecast')), message)
  }
})

test('unsupported AI chat prompts fall through deterministic status handler', () => {
  const response = buildAiChatStatusResponse(createDb(), { message: 'Explain page assumptions' })

  assert.equal(response, null)
})
