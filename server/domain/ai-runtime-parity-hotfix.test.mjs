import test from 'node:test'
import { createProductReviewScenarioDb } from './test-fixtures/product-review-scenario.mjs'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { handleAiRoute } from '../routes/ai.routes.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

function runtimeDb() {
  return createProductReviewScenarioDb()
}

function routeContext(body, db = runtimeDb()) {
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
      supplierPerformance: (database) => Array.isArray(database.suppliers) ? database.suppliers : [],
      supplierRecommendations: () => null,
      supplierQuoteCount: 0,
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

async function ask(message, extra = {}) {
  const route = routeContext({
    moduleId: 'overview',
    question: message,
    message,
    ...extra,
  })
  const before = businessSnapshot(route.ctx.db)
  await handleAiRoute(route.ctx)
  assert.equal(route.response.status, 200, message)
  assert.deepEqual(businessSnapshot(route.ctx.db), before, message)
  return route.response.payload
}

function businessSnapshot(db = {}) {
  return {
    purchaseOrders: db.purchaseOrders,
    receivingDocs: db.receivingDocs,
    products: db.products,
    suppliers: db.suppliers,
    salesForecasts: db.salesForecasts,
    marketSignals: db.marketSignals,
    marketPrices: db.marketPrices,
    forecastPlans: db.forecastPlans,
    purchaseRequests: db.purchaseRequests,
    inventoryMovements: db.inventoryMovements,
    sopCycles: db.sopCycles,
    rfqs: db.rfqs,
  }
}

function visibleText(payload = {}) {
  const evidenceText = (payload.evidence || [])
    .map((item) => [item.id, item.label, item.summary, item.status].filter(Boolean).join(' '))
    .join(' ')
  const cardText = (payload.cards || [])
    .flatMap((next) => {
      if (next.type === 'recommended_actions') return (next.actions || []).map((action) => action.label)
      if (next.type === 'evidence') return (next.evidence || []).map((item) => [item.id, item.label, item.summary, item.status].filter(Boolean).join(' '))
      return [
        next.title,
        next.data?.message,
        ...(next.data?.keyFacts || []),
        ...(next.data?.limitations || []),
        ...(next.data?.topIssues || []).map((item) => [item.title, item.reason].filter(Boolean).join(' ')),
        ...(next.data?.topSuppliers || []).map((item) => [item.supplierName, item.nextAction, item.risk].filter(Boolean).join(' ')),
        ...(next.data?.actions || []),
      ]
    })
    .filter(Boolean)
    .join(' ')
  return JSON.stringify({
    content: payload.content,
    message: payload.message,
    cards: cardText,
    evidence: evidenceText,
  })
}

function actions(payload = {}) {
  return (payload.cards || []).find((card) => card.type === 'recommended_actions')?.actions || []
}

function card(payload = {}, type = '') {
  return (payload.cards || []).find((next) => next.type === type) || null
}

function assertCleanRuntimeOutput(payload, label) {
  const text = visibleText(payload)
  assert.notEqual(payload.intent?.name, 'provider_disabled', label)
  assert.doesNotMatch(text, /provider fallback|tool_result|debug|documentType|entityType|response_card|action-FOLLOWUP|inventory_item/i, label)
  assert.doesNotMatch(text, /打开采购单据并确认责任人与截止日期|复核库存覆盖与再订货点|确认待回复供应商、最佳报价和授标依据/, label)
}

test('R121-HF runtime Today priority uses workspace data counts, evidence, and object-specific actions', async () => {
  const payload = await ask('今天最需要处理什么？')
  assert.equal(payload.intent.name, 'today_cockpit_priority_query')
  assertCleanRuntimeOutput(payload, 'today priority')

  const summary = card(payload, 'procurement_followup_summary')
  assert.ok(summary, 'today priority summary card')
  const serialized = visibleText(payload)
  assert.match(serialized, /PO-2026-1282/)
  assert.match(serialized, /SKU-00412/)
  assert.match(serialized, /RFQ-26-0046/)
  assert.ok(summary.data.overduePoCount > 0, 'overdue PO count must align with overdue PO evidence')
  assert.ok((payload.evidence || []).some((item) => item.id === 'SKU-00412' && /可用|安全|再订货|低于/.test(item.summary || item.label || '')))
  assert.ok((payload.evidence || []).some((item) => item.id === 'RFQ-26-0046' && /回复|报价|截止|供应商/.test(item.summary || item.label || '')))
  assert.ok(actions(payload).some((action) => /打开 PO-\d|查看 SKU-|打开 RFQ-/.test(action.label)))
})

test('R121-HF runtime priority and risk prompts stay deterministic and non-contradictory', async () => {
  const sessionGrounding = {
    lastPrimaryEntity: { type: 'po', id: 'PO-2026-1282', label: 'PO-2026-1282' },
    lastVisibleBusinessIds: { po: ['PO-2026-1282'], sku: ['SKU-00412'], rfq: ['RFQ-26-0046'] },
    lastEvidenceIds: ['PO-2026-1282', 'SKU-00412', 'RFQ-26-0046'],
  }
  const prompts = [
    '今天的数据我需要关注什么？',
    '今天有哪些风险需要我优先看？',
    '这个 PO 为什么优先？',
    '它和哪个 SKU 有关系？',
    'RFQ-26-0046 需要怎么跟进？',
    '刚才那个 RFQ 有几家回复了？',
  ]
  const payloads = []
  for (const message of prompts) {
    const extra = { sessionGrounding }
    if (/PO|它/.test(message)) extra.activeContext = { module: 'overview', entityType: 'purchase_order', entityId: 'PO-2026-1282' }
    if (/RFQ/.test(message)) extra.activeContext = { module: 'overview', entityType: 'rfq', entityId: 'RFQ-26-0046' }
    const payload = await ask(message, extra)
    assertCleanRuntimeOutput(payload, message)
    payloads.push(payload)
  }
  const combined = payloads.map(visibleText).join('\n')
  assert.match(combined, /PO-2026-1282/)
  assert.match(combined, /SKU-00412/)
  assert.match(combined, /RFQ-26-0046/)
  assert.match(combined, /3\s*家|已回复\s*2|报价/)
  assert.match(combined, /高|低库存|安全库存|可用库存/)
  assert.doesNotMatch(combined, /SKU-00412[^]*低风险|riskLevel["']?:["']?low/i)
})

test('R121-HF supplier overview prompts do not ask for supplier id', async () => {
  for (const message of [
    '有什么供应商我需要注意的么？',
    '供应商这边，你有什么推荐？',
    '哪些供应商需要跟进？',
  ]) {
    const payload = await ask(message)
    assertCleanRuntimeOutput(payload, message)
    assert.match(payload.intent.name, /supplier_(followup|high_risk|next_actions|operational)/)
    assert.doesNotMatch(visibleText(payload), /请提供供应商名称|请提供供应商 ID|missing_fields/)
  }
})

test('R121-HF data limitation prompts have deterministic evidence-quality answers', async () => {
  for (const message of [
    '什么数据会比较有限，我需要重点关注？',
    '现在这些判断里，哪些数据依据不够完整？',
    'AI 现在有哪些地方不确定？',
  ]) {
    const payload = await ask(message)
    assertCleanRuntimeOutput(payload, message)
    assert.equal(payload.intent.name, 'data_limitation_query')
    const text = visibleText(payload)
    assert.match(text, /供应商.*回复|RFQ|报价/)
    assert.match(text, /ETA|交期|未到货|delivery/i)
    assert.match(text, /GRN|质检|收货/)
    assert.match(text, /库存|forecast|需求预测/)
    assert.match(text, /发票|三单|match/i)
  }
})

test('R132 broad attention prompts route to deterministic business overview', async () => {
  for (const message of [
    '有什么需要我注意的？',
    '我现在要看什么？',
    '当前有什么问题？',
    '有什么风险？',
    '有没有什么异常？',
    '有什么需要跟进？',
  ]) {
    const payload = await ask(message)
    assertCleanRuntimeOutput(payload, message)
    assert.match(payload.intent.name, /attention_overview_query|today_cockpit_priority_query/)
    const text = visibleText(payload)
    assert.match(text, /PO-2026-1282/)
    assert.match(text, /SKU-00412/)
    assert.match(text, /RFQ-26-0046/)
    assert.match(text, /数据限制|ETA|GRN|质检|需求预测|三单/)
    assert.ok(actions(payload).some((action) => /打开 PO-\d|查看 SKU-|打开 RFQ-/.test(action.label)), message)
  }
})

test('R133 unknown input returns guided business fallback instead of provider-disabled wording', async () => {
  const payload = await ask('写一首采购宣言')
  const text = visibleText(payload)

  assert.equal(payload.intent.name, 'unknown_guided_fallback')
  assert.equal(payload.providerStatus, 'deterministic')
  assert.equal(payload.status, 'guided_fallback')
  assert.doesNotMatch(text, /外部 AI Provider|未启用|provider_disabled|debug|api key/i)
  assert.match(text, /今日优先事项/)
  assert.match(text, /库存风险/)
  assert.match(text, /供应商跟进/)
  assert.match(text, /RFQ 回复/)
  assert.match(text, /收货异常/)
  assert.match(text, /数据不完整项/)
})
