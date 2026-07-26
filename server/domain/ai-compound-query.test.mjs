import test from 'node:test'
import { createProductReviewScenarioDb } from './test-fixtures/product-review-scenario.mjs'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { handleAiRoute } from '../routes/ai.routes.mjs'
import { readFileSync } from 'node:fs'
import {
  buildAiReceivingGapResponse,
  classifyCompoundBusinessQuery,
  detectCompoundBusinessQuery,
  splitCompoundBusinessQuestion,
} from './ai-compound-query.mjs'
import { classifyAiBusinessIntent } from './ai-business-intent-router.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

function runtimeDb() {
  return createProductReviewScenarioDb()
}

function routeContext(body, db = runtimeDb()) {
  let response = null
  let providerDispatchCount = 0
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
      openaiDispatcher: { dispatch() { providerDispatchCount += 1; throw new Error('external provider should not be used') } },
      arkDispatcher: { dispatch() { providerDispatchCount += 1; throw new Error('external provider should not be used') } },
      aiMaxTokens: 120,
      repositories: {},
      send(_res, status, payload) {
        response = { status, payload }
      },
    },
    get response() {
      return response
    },
    get providerDispatchCount() {
      return providerDispatchCount
    },
  }
}

function visibleText(payload = {}) {
  const cardText = (payload.cards || []).flatMap((card) => [
    card.title,
    card.data?.conclusion,
    ...(card.data?.sections || []).flatMap((section) => [section.title, section.conclusion, ...(section.keyFacts || [])]),
    ...(card.data?.keyFacts || []),
    ...(card.data?.topPurchaseOrders || []).flatMap((row) => [row.poId, row.supplier, row.status, row.remainingQuantity]),
    ...(card.actions || []).map((action) => action.label),
    ...(card.evidence || []).flatMap((item) => [item.id, item.label, item.summary, item.status]),
  ]).filter(Boolean).join(' ')
  const evidenceText = (payload.evidence || []).flatMap((item) => [item.id, item.label, item.summary, item.status]).filter(Boolean).join(' ')
  const sectionText = (payload.sections || []).flatMap((section) => [section.title, section.conclusion, ...(section.keyFacts || [])]).join(' ')
  return [payload.content, payload.message, cardText, evidenceText, sectionText].filter(Boolean).join(' ')
}

function businessSnapshot(db = {}) {
  return {
    purchaseOrders: db.purchaseOrders,
    receivingDocs: db.receivingDocs,
    suppliers: db.suppliers,
    rfqs: db.rfqs,
    purchaseRequests: db.purchaseRequests,
    inventoryMovements: db.inventoryMovements,
  }
}

test('R141 compound query utility detects multiple deterministic business intents', () => {
  const question = '今天有什么需要我做的，订单还有多少没有收货，有哪些供应商会有潜在风险？'
  const parts = splitCompoundBusinessQuestion(question)
  assert.deepEqual(parts, ['今天有什么需要我做的', '订单还有多少没有收货', '有哪些供应商会有潜在风险'])
  assert.equal(detectCompoundBusinessQuery({ question }), true)

  const compound = classifyCompoundBusinessQuery({ question })
  assert.equal(compound.isCompound, true)
  assert.equal(compound.orchestrationReason, 'multiple_business_intent_signals')
  assert.ok(compound.subQueries.some((item) => ['attention_overview_query', 'today_cockpit_priority_query'].includes(item.intent)))
  assert.ok(compound.subQueries.some((item) => item.intent === 'receiving_gap_query'))
  assert.ok(compound.subQueries.some((item) => item.intent === 'supplier_followup_query'))

  const simple = classifyCompoundBusinessQuery({ question: '有什么需要我注意的？' })
  assert.equal(simple.isCompound, false)
})

test('R142 receiving gap intent returns deterministic unreceived PO quantities', () => {
  const classification = classifyAiBusinessIntent({ question: '订单还有多少没有收货？' })
  assert.equal(classification.intent, 'receiving_gap_query')
  assert.equal(classification.modelPolicy, 'deterministic_only')

  const response = buildAiReceivingGapResponse(runtimeDb(), { question: '订单还有多少没有收货？' })
  assert.equal(response.intent.name, 'receiving_gap_query')
  assert.equal(response.providerStatus, 'deterministic')
  const text = visibleText(response)
  assert.match(text, /未完全收货|未到货/)
  assert.match(text, /PO-2026-1282/)
  assert.match(text, /已收\s*5\s*\/\s*订购\s*9|剩余\s*4/)
  assert.match(text, /GRN-202605-0419/)
  assert.match(text, /打开 PO-|查看关联 GRN|供应商交期跟进草稿/)
})

test('R143 route orchestrates compound query without provider or business mutation', async () => {
  const db = runtimeDb()
  const before = businessSnapshot(db)
  const route = routeContext({
    moduleId: 'overview',
    question: '今天有什么需要我做的，订单还有多少没有收货，有哪些供应商会有潜在风险？',
    message: '今天有什么需要我做的，订单还有多少没有收货，有哪些供应商会有潜在风险？',
  }, db)

  await handleAiRoute(route.ctx)
  assert.equal(route.response.status, 200)
  assert.equal(route.providerDispatchCount, 0)
  assert.deepEqual(businessSnapshot(db), before)

  const payload = route.response.payload
  assert.equal(payload.intent.name, 'compound_business_query')
  assert.equal(payload.providerStatus, 'deterministic')
  assert.equal(payload.aiModelRoute.usedModel, false)
  assert.deepEqual(payload.aiModelRoute.providerCallsAllowed, false)
  assert.ok(payload.subIntents.some((intent) => ['attention_overview_query', 'today_cockpit_priority_query'].includes(intent)))
  assert.ok(payload.subIntents.includes('receiving_gap_query'))
  assert.ok(payload.subIntents.includes('supplier_followup_query'))

  const text = visibleText(payload)
  assert.match(text, /今日待办|今日重点/)
  assert.match(text, /未收货订单|未完全收货|未到货/)
  assert.match(text, /供应商风险|供应商跟进/)
  assert.match(text, /PO-2026-1282/)
  assert.match(text, /已收\s*5\s*\/\s*订购\s*9|剩余\s*4/)
  assert.match(text, /GRN-202605-0419/)
  assert.match(text, /供应商|风险|跟进/)
  assert.doesNotMatch(text, /请提供供应商名称|请提供供应商 ID|供应商主数据中没有匹配记录/)
  assert.doesNotMatch(text, /provider fallback|provider_disabled|外部 AI Provider|OpenAI|Doubao|Ark|api key/i)
})

test('R144 compound response exposes structured readable cards', async () => {
  const route = routeContext({
    moduleId: 'overview',
    question: '今天有什么需要我做的，订单还有多少没有收货，有哪些供应商会有潜在风险？',
    message: '今天有什么需要我做的，订单还有多少没有收货，有哪些供应商会有潜在风险？',
  })
  await handleAiRoute(route.ctx)
  const payload = route.response.payload

  assert.equal(payload.intent.name, 'compound_business_query')
  assert.ok(payload.cards.some((card) => card.type === 'compound_summary'))
  assert.ok(payload.cards.some((card) => card.type === 'compound_section' && /今日待办|今日重点/.test(card.title)))
  assert.ok(payload.cards.some((card) => card.type === 'compound_section' && /未收货订单/.test(card.title)))
  assert.ok(payload.cards.some((card) => card.type === 'compound_section' && /供应商风险|供应商跟进/.test(card.title)))
  assert.ok(payload.cards.some((card) => card.type === 'recommended_actions'))
  assert.doesNotMatch(visibleText(payload), /documentType|entityType|response_card|tool_result|debug/i)
})

test('R145 compound response progressively discloses overlong questions', async () => {
  const route = routeContext({
    moduleId: 'overview',
    question: '今天有什么需要我做的，订单还有多少没收货，供应商风险有哪些，库存够不够，RFQ 回复怎么样，哪些数据不完整？',
    message: '今天有什么需要我做的，订单还有多少没收货，供应商风险有哪些，库存够不够，RFQ 回复怎么样，哪些数据不完整？',
  })
  await handleAiRoute(route.ctx)
  const payload = route.response.payload
  const summary = payload.cards.find((card) => card.type === 'compound_summary')
  const actions = payload.cards.find((card) => card.type === 'recommended_actions')?.actions || []

  assert.equal(payload.intent.name, 'compound_business_query')
  assert.equal(payload.sections.length, 3)
  assert.ok(payload.subIntents.length > payload.sections.length)
  assert.ok(payload.remainingTopics.length > 0)
  assert.match(payload.content, /我先汇总最影响交付的 3 类事项|其余可以继续展开/)
  assert.ok(summary.data.deferredSubIntents.length > 0)
  assert.ok(actions.some((action) => action.kind === 'prompt' && /展开|查看/.test(action.label)))
  assert.equal(route.providerDispatchCount, 0)
})

test('R144 Panel renders compound and receiving cards explicitly', () => {
  const source = readFileSync(path.join(repoRoot, 'src', 'modules', 'ai-assistant', 'Panel.tsx'), 'utf8')
  assert.match(source, /case "compound_summary"/)
  assert.match(source, /case "compound_section"/)
  assert.match(source, /case "receiving_gap_summary"/)
  assert.match(source, /未收货订单/)
})
