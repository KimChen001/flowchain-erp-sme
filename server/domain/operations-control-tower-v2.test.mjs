import assert from 'node:assert/strict'
import test from 'node:test'
import {
  FORBIDDEN_OPERATIONS_ACTION_PATTERN,
  FORBIDDEN_OPERATIONS_TECHNICAL_PATTERN,
  buildOperationsControlTowerV2,
} from './operations-control-tower-v2.mjs'
import { createAiUserScenarioDb } from './test-fixtures/ai-user-scenario.mjs'
import { buildAiResponseContractV2 } from './ai-response-contract-v2.mjs'

function visibleText(value) {
  return JSON.stringify(value, (_key, next) => {
    if (/entityType|documentType|provider|fastPath|tool_result/i.test(_key)) return undefined
    return next
  })
}

test('operations control tower v2 returns summary items and limitations', () => {
  const tower = buildOperationsControlTowerV2(createAiUserScenarioDb())
  assert.ok(tower.summary.totalOpenItems > 0)
  assert.ok(tower.summary.riskCount >= 1)
  assert.ok(tower.summary.draftAvailableCount >= 1)
  assert.ok(tower.summary.dataGapCount >= 1)
  assert.ok(tower.summary.topPriorityLabel)
  assert.ok(tower.items.length >= 8)
  assert.ok(tower.limitations.length >= 2)
  assert.equal(tower.dataScopeLabel, '当前工作区数据')
})

test('operations control tower v2 covers core action categories', () => {
  const tower = buildOperationsControlTowerV2(createAiUserScenarioDb())
  const categories = new Set(tower.items.map((item) => item.category))
  for (const category of [
    'supplier_risk',
    'po_unreceived',
    'received_not_invoiced',
    'invoice_variance',
    'three_way_match_variance',
    'inventory_risk',
    'data_quality_gap',
  ]) {
    assert.ok(categories.has(category), category)
  }
})

test('operation action items expose required business fields', () => {
  const tower = buildOperationsControlTowerV2(createAiUserScenarioDb())
  for (const item of tower.items) {
    assert.ok(item.priority)
    assert.ok(item.priorityScore >= 0)
    assert.ok(item.businessObjectLabel)
    assert.ok(item.reason)
    assert.ok(item.keyEvidence.length >= 1)
    assert.ok(item.businessImpact.length >= 1)
    assert.ok(item.navigationLinks.length >= 1)
    assert.ok(item.reviewActions.length >= 1)
    assert.ok(item.dataLimitations.length >= 1)
  }
})

test('priority score sorting is stable and explains high risk evidence', () => {
  const tower = buildOperationsControlTowerV2(createAiUserScenarioDb())
  const scores = tower.items.map((item) => item.priorityScore)
  assert.deepEqual(scores, [...scores].sort((a, b) => b - a))
  const top = tower.items[0]
  assert.match(`${top.reason} ${top.keyEvidence.map((item) => item.summary).join(' ')}`, /差异|未收|风险|ETA|库存|Invoice|GRN|PO/)
})

test('review actions and visible fields avoid forbidden wording', () => {
  const tower = buildOperationsControlTowerV2(createAiUserScenarioDb())
  const visible = visibleText(tower)
  assert.doesNotMatch(visible, FORBIDDEN_OPERATIONS_ACTION_PATTERN)
  assert.doesNotMatch(visible, FORBIDDEN_OPERATIONS_TECHNICAL_PATTERN)
  for (const item of tower.items) {
    assert.ok(item.reviewActions.every((action) => action.previewOnly && action.requiresHumanReview))
  }
})

test('missing data returns data quality gap and limitations instead of throwing', () => {
  const tower = buildOperationsControlTowerV2({ purchaseOrders: [], receivingDocs: [], supplierInvoices: [], rfqs: [], purchaseRequests: [] })
  assert.ok(tower.items.some((item) => item.category === 'data_quality_gap'))
  assert.ok(tower.limitations.length >= 1)
})

test('top operation items align with AI response contract v2 today evidence', () => {
  const db = createAiUserScenarioDb()
  const tower = buildOperationsControlTowerV2(db)
  const ai = buildAiResponseContractV2(db, { moduleId: 'overview', question: '今天有什么需要我处理？' })
  const aiEvidence = new Set(ai.cards[0].data.keyEvidence.map((item) => `${item.moduleId}:${item.entityId}`))
  assert.ok(tower.items.slice(0, 6).some((item) => item.alignsWithAiToday))
  assert.ok(tower.items.slice(0, 6).some((item) => item.keyEvidence.some((ev) => aiEvidence.has(`${ev.moduleId}:${ev.entityId}`))))
})

test('operations control tower v2 amounts use the document currency and never guess CNY', () => {
  const withCurrency = (value, currency) => {
    if (Array.isArray(value)) value.forEach((item) => withCurrency(item, currency))
    else if (value && typeof value === 'object') {
      for (const key of Object.keys(value)) {
        if (key === 'currency') { if (currency === undefined) delete value[key]; else value[key] = currency } else withCurrency(value[key], currency)
      }
    }
    return value
  }
  const unknown = JSON.stringify(buildOperationsControlTowerV2(withCurrency(createAiUserScenarioDb(), undefined)))
  assert.equal(unknown.includes('¥'), false)
  assert.equal(unknown.includes('CNY'), false)
  assert.match(unknown, /金额差异 3,200/)
  assert.match(JSON.stringify(buildOperationsControlTowerV2(withCurrency(createAiUserScenarioDb(), 'USD'))), /金额差异 USD 3,200/)
  assert.match(JSON.stringify(buildOperationsControlTowerV2(withCurrency(createAiUserScenarioDb(), 'CNY'))), /金额差异 ¥3,200/)
})
