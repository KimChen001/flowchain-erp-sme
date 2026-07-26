import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { handleActionDraftsRoute } from '../routes/action-drafts.routes.mjs'
import { handleAiRoute } from '../routes/ai.routes.mjs'
import { handleInventoryRoute } from '../routes/inventory.routes.mjs'
import { handleProcurementReadRoute } from '../routes/procurement-read.routes.mjs'
import { handleSearchRoute } from '../routes/search.routes.mjs'
import { handleTodayCockpitRoute } from '../routes/today-cockpit.routes.mjs'
import { buildActionDraftSuggestion } from './action-draft-boundary.mjs'
import { buildTodayCockpit } from './today-cockpit-read-model.mjs'
import { createTestRepositoryRegistry } from './test-fixtures/runtime-repositories.mjs'

const repoRoot = path.resolve(import.meta.dirname, '..', '..')

function readSource(...parts) {
  return fs.readFileSync(path.join(repoRoot, ...parts), 'utf8')
}

function createDb() {
  return {
    products: [
      { sku: 'SKU-00287', name: '铝合金型材 6063', currentStock: 12, safetyStock: 50, reorderPoint: 80, unit: 'kg', warehouseId: 'WH-A', supplier: '江苏铝合金集团', riskLevel: '高', status: '低库存' },
      { sku: 'SKU-00412', name: '伺服电机', currentStock: 120, safetyStock: 40, unit: 'pcs', warehouseId: 'WH-B', supplier: '深圳新元电气', riskLevel: '低' },
    ],
    suppliers: [
      { id: 'SUP-001', name: '江苏铝合金集团', risk: '中', onTimeRate: 90, qualityRate: 96 },
      { id: 'SUP-002', name: '深圳新元电气', risk: '低', onTimeRate: 93, qualityRate: 97 },
    ],
    warehouses: [{ id: 'WH-A', name: 'A 仓', status: 'active' }],
    purchaseRequests: [
      { pr: 'PR-2026-2400', sourceSku: 'SKU-00287', sourceName: '铝合金型材 6063', supplier: '江苏铝合金集团', requester: '张磊', buyer: '王志强', requiredDate: '2026-07-05', quantity: 1000, amount: 142000, currency: 'CNY', status: '已批准', linkedPo: 'PO-2026-1301' },
    ],
    rfqs: [
      { id: 'RFQ-26-0047', title: 'SKU-00287 采购询价', suppliers: 3, quoted: 1, due: '2026-06-20', status: '进行中', sourceRequest: 'PR-2026-2400', linkedPo: 'PO-2026-1301', bestSupplier: '江苏铝合金集团' },
    ],
    purchaseOrders: [
      { po: 'PO-2026-1301', supplier: '江苏铝合金集团', eta: '2026-06-12', owner: '王志强', amount: 142000, currency: 'CNY', items: 1000, received: 400, status: '已发出', sourceRequest: 'PR-2026-2400', sourceRfq: 'RFQ-26-0047' },
    ],
    receivingDocs: [
      { grn: 'GRN-202606-0430', po: 'PO-2026-1301', supplier: '江苏铝合金集团', status: '异常处理', items: 400, passed: 390, failed: 10, warehouse: 'A 区' },
    ],
    supplierInvoices: [
      { invoiceNumber: 'INV-JS-260620', supplier: '江苏铝合金集团', relatedPo: 'PO-2026-1301', relatedGrn: 'GRN-202606-0430', amount: 142000, currency: 'CNY', varianceAmount: 8600, matchStatus: '存在差异' },
    ],
    inventoryMovements: [
      { movementId: 'IM-001', movementType: 'CycleCountVariance', sku: 'SKU-00287', itemName: '铝合金型材 6063', warehouse: 'WH-A', sourceDocument: 'GRN-202606-0430', adjustmentQty: -8, status: '异常处理', unit: 'kg' },
    ],
    inventoryExceptions: [
      { id: 'IEX-001', type: '盘点差异关闭', sku: 'SKU-00287', itemName: '铝合金型材 6063', warehouse: 'WH-A', quantityImpact: -8, unit: 'kg', status: '待复核', nextAction: '复核盘点差异' },
    ],
    events: [],
    auditLog: [],
    forecastPlans: [],
    marketPrices: [],
    marketSignals: [],
  }
}

function snapshot(db) {
  return JSON.stringify(db)
}

function routeContext(method, pathname, db = createDb(), body = {}, helpers = {}) {
  let response = null
  let wrote = false
  return {
    ctx: {
      req: { method, body, headers: {} },
      res: {},
      url: new URL(pathname, 'http://localhost'),
      db,
      repositories: createTestRepositoryRegistry(db),
      send(_res, status, payload) {
        response = { status, payload }
      },
      readBody: async (req) => req.body,
      writeDb: async () => { wrote = true },
      event(database, type, message, ref) {
        database.events = [{ type, message, ref }, ...(database.events || [])]
      },
      ensurePurchaseRequests: (nextDb) => nextDb.purchaseRequests || [],
      ensureInventoryMovements: (nextDb) => nextDb.inventoryMovements || [],
      ensureRfqs: (nextDb) => nextDb.rfqs || [],
      ensureEvents: (nextDb) => nextDb.events || [],
      ensureAuditLog: (nextDb) => nextDb.auditLog || [],
      supplierPerformance: () => [],
      supplierRecommendations: () => null,
      supplierQuoteCount: 0,
      openaiDispatcher: { dispatch() { throw new Error('provider should not be reached') } },
      arkDispatcher: { dispatch() { throw new Error('provider should not be reached') } },
      aiMaxTokens: 120,
      ...helpers,
    },
    get response() {
      return response
    },
    get wrote() {
      return wrote
    },
  }
}

function expectCleanPayload(payload) {
  const serialized = JSON.stringify(payload)
  assert.equal(/stack|trace|sk-fake|fake-openai-key|fake-ark-key|fake-doubao-key|Bearer\s+/i.test(serialized), false)
}

function expectPreviewOnly(payload) {
  assert.equal(payload.previewOnly, true)
  assert.equal(payload.draft.status, 'preview')
  assert.equal(payload.draft.requiresConfirmation, true)
  assert.equal(payload.draft.confirmationBoundary.previewOnly, true)
  assert.equal(payload.draft.confirmationBoundary.submitted, false)
}

test('system harness covers cockpit to inventory and procurement evidence paths', async () => {
  const db = createDb()
  const before = snapshot(db)
  const cockpitRoute = routeContext('GET', '/api/today-cockpit', db)
  await handleTodayCockpitRoute(cockpitRoute.ctx)

  assert.equal(cockpitRoute.response.status, 200)
  for (const key of ['summary', 'cards', 'followups', 'inventoryRisks', 'recentDocuments', 'recentMovements', 'recommendedActions', 'evidence']) {
    assert.ok(cockpitRoute.response.payload[key] !== undefined)
  }
  const inventoryRisk = cockpitRoute.response.payload.inventoryRisks.find((item) => item.sku === 'SKU-00287')
  assert.ok(inventoryRisk)
  assert.equal(inventoryRisk.target.entityType, 'inventory_item')
  assert.equal(inventoryRisk.target.entityId, 'SKU-00287')

  const procurementAction = cockpitRoute.response.payload.recommendedActions.find((item) => item.target?.documentType || item.evidence?.length)
  assert.ok(procurementAction)
  assert.ok(procurementAction.evidence.every((item) => item.type && (item.id || item.label || item.summary)))
  assert.equal(snapshot(db), before)
})

test('system harness validates global search and canonical evidence target shape', async () => {
  const db = createDb()
  const searchRoute = routeContext('GET', '/api/search?q=PO-2026-1301', db)
  await handleSearchRoute(searchRoute.ctx)

  assert.equal(searchRoute.response.status, 200)
  const result = searchRoute.response.payload.results.find((item) => item.entityId === 'PO-2026-1301')
  assert.ok(result)
  assert.equal(result.entityType, 'purchase_order')
  assert.equal(result.canonicalRoute, '/app/procurement/orders/PO-2026-1301')
  assert.equal(result.deepLink, result.canonicalRoute)
  assert.equal(result.sourceRepository, 'procurementRuntime')
  assert.ok(result.evidence.every((item) => item.label && item.value))
})

test('system harness locks draft-first preview invariants', async () => {
  const db = createDb()
  const before = snapshot(db)
  for (const body of [
    { type: 'purchase_request_draft', payload: { itemIdOrSku: 'SKU-00287' } },
    { type: 'rfq_draft', payload: { itemIdOrSku: 'SKU-00287', quantity: 120 } },
    { type: 'supplier_followup_draft', payload: { supplierIdOrName: 'SUP-001', message: '请确认交期。' } },
  ]) {
    const route = routeContext('POST', '/api/action-drafts/preview', db, body)
    await handleActionDraftsRoute(route.ctx)
    assert.equal(route.response.status, 200)
    expectPreviewOnly(route.response.payload)
    assert.equal(route.wrote, false)
  }

  const unsupported = buildActionDraftSuggestion({ type: 'real_purchase_order_create', payload: {} })
  assert.equal(unsupported.ok, false)
  assert.equal(unsupported.status, 'unsupported_type')
  assert.equal(snapshot({ ...db, auditLog: [] }), before)
  assert.equal(db.auditLog.length, 3)
  assert.ok(db.auditLog.every((entry) => entry.action === 'draft_previewed'))
})

test('system harness validates AI safety, timeout fast path, and sanitized fallback', async () => {
  const previous = {
    AI_PROVIDER_ENABLED: process.env.AI_PROVIDER_ENABLED,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    ARK_API_KEY: process.env.ARK_API_KEY,
    DOUBAO_API_KEY: process.env.DOUBAO_API_KEY,
  }
  process.env.AI_PROVIDER_ENABLED = ''
  process.env.OPENAI_API_KEY = 'fake-openai-key'
  process.env.ARK_API_KEY = 'fake-ark-key'
  process.env.DOUBAO_API_KEY = 'fake-doubao-key'
  try {
    const cockpit = routeContext('POST', '/api/ai/chat', createDb(), { moduleId: 'overview', message: '今天最需要处理什么？' })
    await handleAiRoute(cockpit.ctx)
    assert.equal(cockpit.response.status, 200)
    assert.equal(cockpit.response.payload.intent.name, 'today_cockpit_priority_query')
    assert.equal(cockpit.response.payload.providerStatus, 'deterministic')
    assert.equal(cockpit.wrote, false)
    expectCleanPayload(cockpit.response.payload)

    const fallback = routeContext('POST', '/api/ai/chat', createDb(), { message: 'write a poetic sourcing manifesto' })
    await handleAiRoute(fallback.ctx)
    assert.equal(fallback.response.status, 200)
    assert.equal(fallback.response.payload.intent.name, 'unknown_guided_fallback')
    assert.equal(fallback.response.payload.providerStatus, 'deterministic')
    assert.equal(fallback.response.payload.status, 'guided_fallback')
    expectCleanPayload(fallback.response.payload)
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
})

test('system harness covers key read API contracts without mutation', async () => {
  const db = createDb()
  const before = snapshot(db)
  for (const [handler, pathName, expectedKey, expectedStatus] of [
    [handleProcurementReadRoute, '/api/procurement/documents', 'documents', 200],
    [handleProcurementReadRoute, '/api/procurement/documents/po/PO-2026-1301', 'document', 200],
    [handleProcurementReadRoute, '/api/procurement/links', 'links', 200],
    [handleProcurementReadRoute, '/api/procurement/followups', 'followups', 200],
    [handleProcurementReadRoute, '/api/procurement/summary', 'summary', 200],
    [handleInventoryRoute, '/api/inventory/items', 'items', 200],
    [handleInventoryRoute, '/api/inventory/items/SKU-00287', 'item', 200],
    [handleInventoryRoute, '/api/inventory/movements', 'movements', 200],
    [handleInventoryRoute, '/api/inventory/exceptions', 'exceptions', 200],
    [handleInventoryRoute, '/api/inventory/summary', 'summary', 200],
    [handleActionDraftsRoute, '/api/action-drafts/schema', 'schema', 200],
  ]) {
    const route = routeContext('GET', pathName, db)
    await handler(route.ctx)
    assert.equal(route.response.status, expectedStatus)
    assert.ok(route.response.payload[expectedKey] !== undefined)
    expectCleanPayload(route.response.payload)
  }

  const invalid = routeContext('GET', '/api/procurement/documents/customer/CUST-001', db)
  await handleProcurementReadRoute(invalid.ctx)
  assert.equal(invalid.response.status, 400)
  expectCleanPayload(invalid.response.payload)
  assert.equal(snapshot(db), before)
})

test('system harness validates evidence and navigation compatibility surfaces', () => {
  const helper = readSource('src', 'lib', 'evidenceLinks.ts')
  const app = readSource('src', 'app', 'FlowChainApp.tsx')
  const aiPanel = readSource('src', 'modules', 'ai-assistant', 'Panel.tsx')
  const cockpit = buildTodayCockpit(createDb())

  assert.match(helper, /pr: \{ entityType: "purchase_request", moduleId: "procurement:requests"/)
  assert.match(helper, /threeWayMatch: \{ entityType: "supplier_invoice", moduleId: "finance:invoices"/)
  assert.match(helper, /focusTarget: clickable \? \{ entityType: normalizedEntityType, entityId \}/)
  assert.match(app, /navigationIntentFromGlobalSearchResult\(result, \{ returnTo: active \}\)/)
  assert.match(aiPanel, /normalizeEvidenceLinks\(\[raw\], \{ source: "ai" \}\)/)
  assert.match(aiPanel, /raw\.summary/)
  assert.ok(cockpit.recommendedActions.every((item) => Array.isArray(item.evidence)))
})

test('system harness records typography grep boundary for current product scope', () => {
  const typography = readSource('src', 'components', 'ui', 'typography.ts')
  const table = readSource('src', 'components', 'ui', 'workbenchTable.ts')
  const cockpitPanel = readSource('src', 'modules', 'overview', 'TodayCockpitPanel.tsx')
  const salesPage = readSource('src', 'modules', 'sales', 'Page.tsx')
  const routeRegistry = readSource('src', 'app', 'routeRegistry.tsx')

  assert.match(typography, /tableHeader/)
  assert.match(typography, /tableCell/)
  assert.match(typography, /tableLink/)
  assert.match(typography, /chip/)
  assert.match(typography, /formLabel/)
  assert.match(table, /tableLinkClass/)
  assert.doesNotMatch(cockpitPanel, /compactDisplay|notation:\s*["']compact["']|万元|14万/)
  assert.match(routeRegistry, /id: "sales:risks"[\s\S]*?label: "交付风险"/)
  assert.doesNotMatch(salesPage, /交付风险协同/)
  assert.match(salesPage, /客户订单列表/)
  assert.match(salesPage, /交付风险队列/)
  assert.match(salesPage, /主证据链/)
  assert.doesNotMatch(salesPage, /客户订单与交付风险|交付风险订单/)
})

test('Phase 0 product positioning and visible language governance stay productized', () => {
  const readme = readSource('README.md')
  const docsIndex = readSource('docs', 'README.md')
  const narrative = readSource('docs', 'product-narrative-v1.md')
  const roadmap = readSource('docs', 'roadmap-v1.md')
  const limitations = readSource('docs', 'current-development-limitations-v1.md')
  const language = readSource('docs', 'product-language-and-positioning-v1.md')
  const constants = readSource('src', 'lib', 'constants.ts')
  const forecast = readSource('src', 'modules', 'forecast', 'Page.tsx')
  const actionShell = readSource('src', 'modules', 'action-drafts', 'ActionDraftReviewShell.tsx')
  const overview = readSource('src', 'modules', 'overview', 'Page.tsx')
  const importsPage = readSource('src', 'modules', 'imports', 'Page.tsx')
  const inventoryPage = readSource('src', 'modules', 'inventory', 'Page.tsx')
  const reportsPage = readSource('src', 'modules', 'reports', 'Page.tsx')
  const aiEvidenceReuse = readSource('server', 'domain', 'ai-evidence-reuse.mjs')
  const aiSop = readSource('server', 'domain', 'ai-sop-retrieval.mjs')
  const publicDocs = [readme, docsIndex, narrative, roadmap, limitations].join('\n')
  const uiCopySources = [constants, forecast, actionShell, overview, importsPage, inventoryPage, reportsPage].join('\n')
  const aiVisibleCopySources = [aiEvidenceReuse, aiSop].join('\n')

  assert.match(readme, /FlowChain — ERP & Inventory-Purchase-Sales \(进销存\) Collaboration Platform for SMEs/)
  assert.match(readme, /FlowChain is an ERP and inventory-purchase-sales \(进销存\) collaboration platform for SMEs/)
  assert.match(readme, /Sales Demand \/ Customer Orders Lite/)
  assert.match(readme, /Inventory Allocation \/ Availability/)
  assert.match(readme, /Demand-to-Procurement Links/)
  assert.match(readme, /Phase 8 deployment and launch hardening/)
  assert.match(language, /FlowChain 是面向中小企业的 ERP 进销存协同平台/)
  assert.match(language, /SKU = 物料编码 \/ 商品编码/)
  assert.match(language, /MRP = 物料需求计划/)
  assert.match(language, /ActionDraft \| 操作草稿 \/ 待复核草稿/)
  assert.match(language, /开发环境或验收阶段标签 \| 当前版本 \/ 当前工作区/)
  assert.match(language, /数据夹具或数据集标签 \| 当前工作区数据 \/ 当前业务数据/)
  assert.match(roadmap, /Phase 1 Sales Demand Lite/)
  assert.match(roadmap, /Phase 2 Inventory Allocation/)
  assert.match(limitations, /Current Development Limitations/)
  assert.match(constants, /AI 进销存与供应链协同工作台/)
  assert.match(forecast, /计划使用边界/)
  assert.match(forecast, /当前物料需求计划基于工作区内的商品、库存、采购、销售需求与供应商记录/)
  assert.match(actionShell, /保留待复核草稿/)
  assert.match(importsPage, /旧 Pilot Imports 不再创建预览批次、提交业务表或回滚历史批次/)
  assert.match(importsPage, /Universal Intake 是唯一面向未来的数据接入权威/)
  assert.match(inventoryPage, /仅显示库存运行时仓库中的正式记录/)
  assert.match(inventoryPage, /不会用固定 SKU、批次、序列号或移动记录补足空数据/)
  assert.match(reportsPage, /API \/ 当前数据范围/)
  assert.match(aiVisibleCopySources, /待复核草稿/)
  assert.match(overview, /首页概览/)
  assert.match(overview, /今日需处理/)
  assert.match(overview, /最近单据/)

  assert.doesNotMatch(readme.split('\n')[0], /UAT|Demo|ERP\/SCM/)
  assert.doesNotMatch(publicDocs, /FlowChain ERP\/SCM UAT Demo|JSON\/demo-data-backed UAT|UAT limitations|Demo script|Demo screenshot|Fake API keys|演示数据|示例数据|样例数据|sample data|demo data|UAT data/)
  assert.doesNotMatch(uiCopySources, /规划演示边界|Forecast\/MRP|ActionDraft 壳|保存 ActionDraft|Created record|not available|Purchase Cycle|Open PR Value|Open PO Value|Inventory Turnover|Forecast Accuracy|Supplier Score/)
  assert.doesNotMatch(uiCopySources, /ActionDraft purchase_request_draft|provider fallback|tool_result|response_card|raw JSON|演示数据|示例数据|样例数据|sample data|demo data|API fallback/)
  assert.doesNotMatch(aiVisibleCopySources, /ActionDraft|演示数据|示例数据|样例数据|sample data|demo data|由于这是演示数据/)
})
