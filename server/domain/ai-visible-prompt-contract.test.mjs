import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { handleAiRoute } from '../routes/ai.routes.mjs'

const repoRoot = path.resolve(import.meta.dirname, '..', '..')

let promptModulePromise

async function loadPromptModule() {
  if (promptModulePromise) return promptModulePromise
  promptModulePromise = (async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'ai-visible-prompts-'))
    const outfile = path.join(dir, 'prompts.mjs')
    await build({
      entryPoints: ['src/modules/ai-assistant/prompts.ts'],
      outfile,
      bundle: true,
      platform: 'node',
      format: 'esm',
      logLevel: 'silent',
    })
    const mod = await import(pathToFileURL(outfile).href)
    return { mod, cleanup: () => rm(dir, { recursive: true, force: true }) }
  })()
  return promptModulePromise
}

test.after(async () => {
  if (!promptModulePromise) return
  const loaded = await promptModulePromise
  await loaded.cleanup()
})

const visiblePromptContract = Object.freeze([
  { surface: 'overview', input: { moduleId: 'overview' }, prompts: ['今天最需要处理什么？', '哪些采购单据有风险？', '哪些库存项目需要关注？'], classification: 'supported_deterministic', modules: ['overview', 'procurement', 'inventory'] },
  { surface: 'procurement', input: { moduleId: 'procurement' }, prompts: ['今天采购有什么要跟？', '哪些 PO 快逾期？', '哪些 RFQ 没回复？'], classification: 'supported_deterministic', modules: ['procurement'] },
  { surface: 'inventory', input: { moduleId: 'inventory' }, prompts: ['查看库存风险', '解释库存异常', '准备 PR 草稿'], classification: 'supported_deterministic', modules: ['inventory', 'actionDraft'] },
  { surface: 'forecast', input: { moduleId: 'forecast' }, prompts: ['今天计划模块最需要处理什么？', '哪些 SKU 有 MRP 例外？', 'MRP 计划释放有哪些需要审阅？', '这个 forecast 的 MAPE 怎么样？', '哪些补货建议需要转成草稿？', '这个 SKU 的计划参数是什么？'], classification: 'supported_deterministic', modules: ['planning'] },
  { surface: 'srm', input: { moduleId: 'srm' }, prompts: ['查看高风险供应商', '解释评分规则', '下一步跟进'], classification: 'supported_deterministic', modules: ['supplier'] },
  { surface: 'finance', input: { moduleId: 'finance' }, prompts: ['查看待结算项', '解释差异原因', '下一步跟进'], classification: 'supported_deterministic', modules: ['finance'] },
  { surface: 'master_data', input: { moduleId: 'master_data' }, prompts: ['检查主数据质量', '缺少哪些默认字段？', '下一步建议'], classification: 'supported_deterministic', modules: ['masterData'] },
  { surface: 'master-data', input: { moduleId: 'master-data' }, prompts: ['检查主数据质量', '缺少哪些默认字段？', '下一步建议'], classification: 'supported_deterministic', modules: ['masterData'] },
  { surface: 'reports', input: { moduleId: 'reports' }, prompts: ['解释当前页面', '下一步建议', '从哪里开始'], classification: 'supported_boundary_response', modules: ['reports'] },
  { surface: 'imports', input: { moduleId: 'imports' }, prompts: ['解释当前页面', '下一步建议', '从哪里开始'], classification: 'supported_boundary_response', modules: ['imports'] },
  { surface: 'active:supplier', input: { moduleId: 'srm', activeContext: { entityType: 'supplier', entityId: 'SUP-001', entityLabel: 'ABC Components' } }, prompts: ['解释这个供应商', '查看供应商风险', '查看 RFQ 参与'], classification: 'supported_deterministic', modules: ['supplier', 'rfq'] },
  { surface: 'active:item', input: { moduleId: 'inventory', activeContext: { entityType: 'item', entityId: 'A100', entityLabel: 'Motor A100' } }, prompts: ['查看库存风险', '准备 PR 草稿', '下一步建议'], classification: 'supported_deterministic', modules: ['inventory', 'actionDraft'] },
  { surface: 'active:rfq', input: { moduleId: 'procurement', activeContext: { entityType: 'rfq', entityId: 'RFQ-1001', entityLabel: 'A100 RFQ' } }, prompts: ['查看 RFQ 状态', '谁还没回复', '下一步建议'], classification: 'supported_deterministic', modules: ['rfq'] },
  { surface: 'active:purchase_request', input: { moduleId: 'procurement', activeContext: { entityType: 'purchase_request', entityId: 'PR-1001', entityLabel: 'PR-1001' } }, prompts: ['查看 PR 状态', '为什么没转 PO', '下一步建议'], classification: 'supported_deterministic', modules: ['procurement'] },
])

function promptClassification(entry, message) {
  if (entry.surface === 'master_data' || entry.surface === 'master-data') return entry.classification
  return ['解释当前页面', '下一步建议', '从哪里开始'].includes(message)
    ? 'supported_boundary_response'
    : entry.classification
}

const routePromptCases = Object.freeze([
  ...visiblePromptContract
    .filter((entry) => !entry.surface.startsWith('active:'))
    .flatMap((entry) => entry.prompts.map((message) => ({ moduleId: entry.input.moduleId, message, classification: promptClassification(entry, message), surface: entry.surface }))),
  { moduleId: 'srm', message: '解释这个供应商', activeContext: { entityType: 'supplier', entityId: 'SUP-001', entityLabel: 'ABC Components' }, classification: 'supported_deterministic', surface: 'active:supplier' },
  { moduleId: 'srm', message: '查看 RFQ 参与', activeContext: { entityType: 'supplier', entityId: 'SUP-001', entityLabel: 'ABC Components' }, classification: 'supported_deterministic', surface: 'active:supplier' },
  { moduleId: 'inventory', message: '查看库存风险', activeContext: { entityType: 'item', entityId: 'A100', entityLabel: 'Motor A100' }, classification: 'supported_deterministic', surface: 'active:item' },
  { moduleId: 'inventory', message: '准备 PR 草稿 A100 50 明天', activeContext: { entityType: 'item', entityId: 'A100', entityLabel: 'Motor A100' }, classification: 'supported_deterministic', surface: 'active:item' },
  { moduleId: 'procurement', message: '查看 RFQ 状态 RFQ-1001', activeContext: { entityType: 'rfq', entityId: 'RFQ-1001', entityLabel: 'A100 RFQ' }, classification: 'supported_deterministic', surface: 'active:rfq' },
  { moduleId: 'procurement', message: '查看 PR 状态 PR-1001', activeContext: { entityType: 'purchase_request', entityId: 'PR-1001', entityLabel: 'PR-1001' }, classification: 'supported_deterministic', surface: 'active:purchase_request' },
])

function createDb() {
  return {
    products: [
      { id: 'ITEM-A100', sku: 'A100', name: 'Motor A100', currentStock: 4, min: 20, moq: 10, reorderPoint: 15, safetyStock: 12, unit: 'pcs', baseUom: 'pcs', defaultWarehouseId: 'WH-A', preferredSupplierId: 'SUP-001', preferredSupplierSource: 'matched_supplier_master', status: '低库存', riskLevel: '高', itemName: 'Motor A100' },
    ],
    warehouses: [{ id: 'WH-A', name: 'Main Warehouse', sourceType: 'default_reference' }],
    suppliers: [{ id: 'SUP-001', supplierId: 'SUP-001', name: 'ABC Components', supplierName: 'ABC Components', status: 'active', risk: 'medium', score: 82 }],
    rfqs: [
      { id: 'RFQ-1001', rfq: 'RFQ-1001', title: 'A100 RFQ', status: '进行中', suppliers: 2, quoted: 1, due: '2026-07-03', sourceSku: 'A100', sourceRequest: 'PR-1001', responses: [{ supplierId: 'SUP-001', supplierName: 'ABC Components', responseStatus: 'pending' }] },
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
    rfqs: db.rfqs,
    purchaseRequests: db.purchaseRequests,
    purchaseOrders: db.purchaseOrders,
    receivingDocs: db.receivingDocs,
    inventoryMovements: db.inventoryMovements,
    inventoryExceptions: db.inventoryExceptions,
    forecastPlans: db.forecastPlans,
  })
}

test('R76 enumerates every visible AI quick prompt and classifies the Alpha surface', async () => {
  const { mod } = await loadPromptModule()
  for (const entry of visiblePromptContract) {
    assert.deepEqual(mod.getContextualQuickPrompts(entry.input), entry.prompts, entry.surface)
    assert.ok(['supported_deterministic', 'supported_boundary_response', 'hidden_or_not_alpha', 'blocker'].includes(entry.classification), entry.surface)
    assert.notEqual(entry.classification, 'blocker', entry.surface)
  }
})

test('R76 visible AI quick prompts do not fall through to provider_disabled on the real chat route', async () => {
  for (const prompt of routePromptCases) {
    const db = createDb()
    const before = businessSnapshot(db)
    const route = createRouteContext({
      moduleId: prompt.moduleId,
      question: prompt.message,
      ...(prompt.activeContext ? { activeContext: prompt.activeContext } : {}),
    }, db)

    const handled = await handleAiRoute(route.ctx)

    if (prompt.classification === 'supported_deterministic') {
      assert.equal(handled, true, `${prompt.surface}: ${prompt.message}`)
    }
    assert.equal(route.response?.status, 200, `${prompt.surface}: ${prompt.message}`)
    assert.notEqual(route.response.payload.intent?.name, 'provider_disabled', `${prompt.surface}: ${prompt.message}`)
    assert.notEqual(route.response.payload.providerStatus, 'blocked', `${prompt.surface}: ${prompt.message}`)
    assert.equal(route.response.payload.usedWeb, false, `${prompt.surface}: ${prompt.message}`)
    assert.equal(route.response.payload.externalMs, 0, `${prompt.surface}: ${prompt.message}`)
    assert.notEqual(route.response.payload.provider, 'openai', `${prompt.surface}: ${prompt.message}`)
    assert.notEqual(route.response.payload.provider, 'doubao', `${prompt.surface}: ${prompt.message}`)
    assert.deepEqual(businessSnapshot(db), before, `${prompt.surface}: ${prompt.message}`)

    if (prompt.classification === 'supported_deterministic') {
      assert.ok(
        route.response.payload.mode === 'read' ||
          route.response.payload.mode === 'draft_preparation' ||
          route.response.payload.fastPath === 'pre_read_context' ||
          route.response.payload.providerStatus === 'deterministic',
        `${prompt.surface}: ${prompt.message}`,
      )
    } else {
      assert.equal(route.response.payload.provider, 'local', `${prompt.surface}: ${prompt.message}`)
      assert.match(route.response.payload.content || route.response.payload.message || '', /当前模块|FlowChain|建议/, `${prompt.surface}: ${prompt.message}`)
    }
  }
})

// The cards the template chat returns never reach the panel: it asks only
// /api/ai-runtime/respond and renders each answer as one ai_response_v2 card.
test('R76 the assistant panel renders only runtime answers', () => {
  const panel = fs.readFileSync(path.join(repoRoot, 'src/modules/ai-assistant/Panel.tsx'), 'utf8')
  const gateway = fs.readFileSync(path.join(repoRoot, 'src/modules/ai-assistant/aiRuntimeGateway.ts'), 'utf8')
  assert.match(gateway, /"\/api\/ai-runtime\/respond"/)
  assert.doesNotMatch(panel + gateway, /\/api\/ai\/chat/)
  assert.deepEqual([...panel.matchAll(/\btype: "([^"]+)"/g)].map((match) => match[1]), ['ai_response_v2'])
  assert.doesNotMatch(panel, /case "/)
})
