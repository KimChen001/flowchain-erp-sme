import test from 'node:test'
import { createProductReviewScenarioDb } from './test-fixtures/product-review-scenario.mjs'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { handleAiRoute } from '../routes/ai.routes.mjs'
import { classifyCompoundBusinessQuery } from './ai-compound-query.mjs'
import {
  maybeDecomposeCompoundQueryWithModel,
  maybeRewriteCompoundQueryWithModel,
  validateCompoundQueryRewrite,
} from './ai-model-router.mjs'

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
      openaiDispatcher: { dispatch() { providerDispatchCount += 1; throw new Error('provider should not be reached') } },
      arkDispatcher: { dispatch() { providerDispatchCount += 1; throw new Error('provider should not be reached') } },
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

async function ask(message, extra = {}) {
  const route = routeContext({
    moduleId: 'overview',
    question: message,
    message,
    ...extra,
  })
  await handleAiRoute(route.ctx)
  assert.equal(route.response.status, 200, message)
  assert.equal(route.providerDispatchCount, 0, message)
  return route.response.payload
}

function visibleText(payload = {}) {
  return JSON.stringify({
    content: payload.content,
    message: payload.message,
    cards: payload.cards,
    evidence: payload.evidence,
    sections: payload.sections,
  })
}

test('R149 simple prompts remain single-intent and provider-free', async () => {
  const cases = [
    ['今天最需要处理什么？', 'today_cockpit_priority_query'],
    ['有什么供应商我需要注意的么？', /supplier_(followup|high_risk|next_actions|operational)/],
    ['什么数据会比较有限，我需要重点关注？', 'data_limitation_query'],
    ['RFQ-26-0046 需要怎么跟进？', /rfq_(followup|status)_query/],
    ['SKU-00412 为什么风险高？', 'inventory_status_query'],
  ]
  for (const [message, expected] of cases) {
    assert.equal(classifyCompoundBusinessQuery({ question: message }).isCompound, false, message)
    const payload = await ask(message)
    if (expected instanceof RegExp) assert.match(payload.intent.name, expected, message)
    else assert.equal(payload.intent.name, expected, message)
    assert.notEqual(payload.intent.name, 'compound_business_query', message)
    assert.doesNotMatch(visibleText(payload), /provider_disabled|外部 AI Provider|api key|debug/i, message)
  }
})

test('R149 compound query works while detail lookup and unknown fallback remain intact', async () => {
  const compound = await ask('今天有什么需要我做的，订单还有多少没有收货，有哪些供应商会有潜在风险？')
  assert.equal(compound.intent.name, 'compound_business_query')
  assert.ok(compound.subIntents.includes('receiving_gap_query'))
  assert.match(visibleText(compound), /未收货订单|供应商风险|今日待办/)

  const supplier = await ask('深圳新元电气 这个供应商状态怎么样？')
  assert.notEqual(supplier.intent.name, 'compound_business_query')
  assert.doesNotMatch(visibleText(supplier), /请提供供应商名称|请提供供应商 ID|供应商主数据中没有匹配记录/)
  assert.match(visibleText(supplier), /深圳新元电气/)

  const unknown = await ask('写一首采购宣言')
  assert.equal(unknown.intent.name, 'unknown_guided_fallback')
  assert.equal(unknown.providerStatus, 'deterministic')
  assert.doesNotMatch(visibleText(unknown), /provider_disabled|外部 AI Provider|api key|debug/i)
})

test('R150 model shadow remains disabled and cannot change facts before real API-key testing', async () => {
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
    const deterministicSubQueries = classifyCompoundBusinessQuery({
      question: '今天有什么需要我做的，订单还有多少没有收货？',
    }).subQueries
    const shadow = await maybeDecomposeCompoundQueryWithModel({ deterministicSubQueries })
    const rewrite = await maybeRewriteCompoundQueryWithModel({ query: '订单还有多少没有收货？' })
    const unsafe = validateCompoundQueryRewrite({
      originalQuery: '订单还有多少没有收货？',
      rewrite: 'PO-9999 逾期 10 天，直接发送催货邮件',
    })

    assert.equal(shadow.usedModel, false)
    assert.equal(shadow.providerCallsAllowed, false)
    assert.deepEqual(shadow.modelSubQueries, [])
    assert.deepEqual(shadow.deterministicSubQueries, deterministicSubQueries)
    assert.equal(rewrite.usedModel, false)
    assert.equal(rewrite.providerCallsAllowed, false)
    assert.equal(unsafe.accepted, false)
    assert.deepEqual(unsafe.introducedIds, ['PO-9999'])
    assert.ok(unsafe.introducedNumbers.includes('10'))
    assert.equal(unsafe.actionExecution, true)
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
})

test('R150 readiness source review keeps provider calls and docs out of this round', () => {
  const compoundSource = fs.readFileSync(path.join(repoRoot, 'server', 'domain', 'ai-compound-query.mjs'), 'utf8')
  const modelSource = fs.readFileSync(path.join(repoRoot, 'server', 'domain', 'ai-model-router.mjs'), 'utf8')
  assert.doesNotMatch(compoundSource, /fetch\(|OPENAI_API_KEY|ARK_API_KEY|DOUBAO_API_KEY|callConfiguredAi/)
  assert.match(modelSource, /providerCallsAllowed:\s*false/)
  assert.match(modelSource, /externalProvider:\s*'none'/)
})
