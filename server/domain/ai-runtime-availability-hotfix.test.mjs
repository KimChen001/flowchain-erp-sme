import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import {
  buildAiRuntimeResponseV2,
  buildAiRuntimeResponseV2Async,
  FORBIDDEN_AI_RUNTIME_ACTION_PATTERN,
  FORBIDDEN_AI_RUNTIME_TECHNICAL_PATTERN,
} from './ai-runtime-gateway-v2.mjs'
import { createProductReviewScenarioDb } from './test-fixtures/product-review-scenario.mjs'

function loadDb() {
  return createProductReviewScenarioDb()
}

function visibleText(value) {
  if (Array.isArray(value)) return value.map(visibleText).join(' ')
  if (!value || typeof value !== 'object') return String(value ?? '')
  return Object.entries(value)
    .filter(([key]) => !/^(id|sourceId|responseId|query|intent|entityType|entityId|moduleId|linkTarget|returnContext|returnTo|source|reason|draftType|payload|originEvidence|mode|providerContract)$/i.test(key))
    .map(([, item]) => visibleText(item))
    .join(' ')
}

function assertAvailableResponse(body, expectedPattern) {
  assert.equal(body.version, 'v2')
  assert.ok(body.conclusion?.title)
  assert.equal(body.realEvidenceCount, body.keyEvidence?.length || 0)
  assert.ok((body.keyEvidence?.length || 0) > 0 || body.contextCardCount > 0)
  assert.ok(body.businessImpact?.length > 0)
  assert.ok(body.recommendedActions?.length > 0)
  if (body.realEvidenceCount > 0) assert.ok(body.navigationLinks?.length > 0)
  assert.ok(body.dataLimitations)
  assert.ok(body.reviewCards?.every((card) => card.previewOnly && card.reviewRequired && card.requiresHumanReview))
  const text = visibleText(body)
  assert.match(text, /结论|证据|人工复核|当前工作区数据|复核优先/)
  assert.match(text, expectedPattern)
  assert.doesNotMatch(text, /AI 助手暂不可用|当前未能读取工作区证据|请稍后重试|stack|route error|request failed/i)
  assert.doesNotMatch(text, FORBIDDEN_AI_RUNTIME_TECHNICAL_PATTERN)
  assert.doesNotMatch(text, FORBIDDEN_AI_RUNTIME_ACTION_PATTERN)
}

test('today_attention_available', () => {
  const result = buildAiRuntimeResponseV2(loadDb(), { message: '今天最需要处理什么？', activeModuleId: 'overview' })
  assert.equal(result.status, 200)
  assertAvailableResponse(result.body, /今日行动|今日重点|采购|库存/)
})

test('receiving_exception_available', () => {
  const result = buildAiRuntimeResponseV2(loadDb(), { message: '今天有哪些收货异常？', activeModuleId: 'overview' })
  assert.equal(result.status, 200)
  assert.equal(result.body.intent, 'receiving_exception')
  assertAvailableResponse(result.body, /收货|GRN|PO|异常|待收货|质检|不写库存|人工复核/)
})

test('inventory_attention_available', () => {
  const result = buildAiRuntimeResponseV2(loadDb(), { message: '哪些库存项目需要关注？', activeModuleId: 'inventory' })
  assert.equal(result.status, 200)
  assert.equal(result.body.intent, 'inventory_risk')
  assertAvailableResponse(result.body, /库存|SKU|补货|可用量|可承诺量/)
})

test('provider_disabled_still_local', async () => {
  const result = await buildAiRuntimeResponseV2Async(loadDb(), { message: '今天有哪些收货异常？', activeModuleId: 'overview' }, {
    env: {
      OPENAI_API_KEY: 'placeholder-local-key',
      ARK_API_KEY: 'placeholder-local-key',
      DOUBAO_API_KEY: 'placeholder-local-key',
    },
  })
  assert.equal(result.status, 200)
  assertAvailableResponse(result.body, /收货|GRN|当前工作区数据/)
  assert.doesNotMatch(visibleText(result.body), /provider|model|endpoint|API|key|token|OpenAI|DeepSeek|Doubao|豆包/i)
})

test('context_builder_failure_is_contained', () => {
  const result = buildAiRuntimeResponseV2(loadDb(), { message: '今天最需要处理什么？', activeModuleId: 'overview' }, {
    contextBuilders: {
      reports: () => { throw new Error('boom') },
    },
  })
  assert.equal(result.status, 200)
  assertAvailableResponse(result.body, /今日行动|来源证据暂不完整|报表证据暂不完整/)
})

test('core_chain_failure_is_contained', () => {
  const options = {
    contextBuilders: {
      coreBusinessChain: () => { throw new Error('boom') },
    },
  }
  const today = buildAiRuntimeResponseV2(loadDb(), { message: '今天最需要处理什么？', activeModuleId: 'overview' }, options)
  assert.equal(today.status, 200)
  assertAvailableResponse(today.body, /今日行动|当前工作区数据/)

  const inventory = buildAiRuntimeResponseV2(loadDb(), { message: '哪些库存项目需要关注？', activeModuleId: 'inventory' }, options)
  assert.equal(inventory.status, 200)
  assertAvailableResponse(inventory.body, /库存|SKU/)

  const chain = buildAiRuntimeResponseV2(loadDb(), { message: '这条核心业务链有什么证据？', activeModuleId: 'overview' }, options)
  assert.equal(chain.status, 200)
  assertAvailableResponse(chain.body, /核心业务链|核心业务链证据暂不完整|数据限制/)
})
