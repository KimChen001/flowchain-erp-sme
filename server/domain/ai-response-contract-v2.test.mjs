import assert from 'node:assert/strict'
import test from 'node:test'
import {
  FORBIDDEN_AI_RESPONSE_V2_ACTION_PATTERN,
  FORBIDDEN_AI_RESPONSE_V2_TECHNICAL_PATTERN,
  buildAiResponseContractV2,
  detectAiResponseV2Intent,
} from './ai-response-contract-v2.mjs'
import { createAiUserScenarioDb } from './test-fixtures/ai-user-scenario.mjs'

function contractFor(question, db = createAiUserScenarioDb(), body = {}) {
  const response = buildAiResponseContractV2(db, { moduleId: 'overview', question, ...body })
  assert.equal(response?.cards?.[0]?.type, 'ai_response_v2')
  return response.cards[0].data
}

function visibleActionText(contract) {
  return [
    ...contract.recommendedActions.flatMap((item) => [item.label, item.description, item.disabledReason]),
    ...contract.reviewCards.flatMap((item) => [item.title, item.description, item.allowedNextStep]),
  ].filter(Boolean).join('\n')
}

test('AI response contract v2 detects required business query patterns', () => {
  const cases = [
    ['今天有什么需要我处理？', 'today_work_queue_v2'],
    ['哪些供应商有潜在风险？', 'supplier_risk_summary_v2'],
    ['哪些 PO 还没有收货？', 'po_unreceived_v2'],
    ['哪些已经收货但还没开票？', 'received_not_invoiced_v2'],
    ['为什么三单匹配失败？', 'three_way_match_failure_v2'],
    ['这个供应商最近有什么问题？', 'supplier_recent_issues_v2'],
    ['这个 SKU 和哪些单据有关？', 'sku_document_relationship_v2'],
    ['哪些数据依据不完整？', 'data_limitations_v2'],
  ]
  for (const [question, intent] of cases) {
    assert.equal(detectAiResponseV2Intent(question), intent, question)
  }
})

test('AI response contract v2 returns conclusion evidence impact actions links limitations and review cards', () => {
  const contract = contractFor('今天有什么需要我处理？')
  assert.equal(contract.version, 'v2')
  assert.equal(contract.intent, 'today_work_queue_v2')
  assert.ok(contract.conclusion.title)
  assert.ok(contract.keyEvidence.length >= 3)
  assert.ok(contract.businessImpact.length >= 3)
  assert.ok(contract.recommendedActions.length >= 3)
  assert.ok(contract.navigationLinks.length >= 3)
  assert.ok(contract.dataLimitations.length >= 2)
  assert.ok(contract.reviewCards.some((item) => item.previewOnly && item.requiresHumanReview))
})

test('AI response contract v2 keeps visible actions review-first and avoids blocked wording', () => {
  for (const question of ['今天有什么需要我处理？', '为什么三单匹配失败？', '哪些供应商有潜在风险？']) {
    const contract = contractFor(question)
    const visible = visibleActionText(contract)
    assert.doesNotMatch(visible, FORBIDDEN_AI_RESPONSE_V2_ACTION_PATTERN, question)
    assert.doesNotMatch(visible, FORBIDDEN_AI_RESPONSE_V2_TECHNICAL_PATTERN, question)
    assert.ok(contract.reviewCards.every((item) => item.previewOnly === true && item.requiresHumanReview === true))
  }
})

test('supplier risk query returns supplier evidence and linked procurement records', () => {
  const contract = contractFor('哪些供应商有潜在风险？')
  assert.equal(contract.intent, 'supplier_risk_summary_v2')
  assert.ok(contract.keyEvidence.some((item) => item.entityType === 'supplier'))
  assert.ok(contract.keyEvidence.some((item) => ['purchase_order', 'rfq', 'supplier_invoice'].includes(item.entityType)))
  assert.ok(contract.navigationLinks.some((item) => item.moduleId.startsWith('srm')))
})

test('unreceived PO query returns PO and PO Line evidence', () => {
  const contract = contractFor('哪些 PO 还没有收货？')
  assert.equal(contract.intent, 'po_unreceived_v2')
  assert.ok(contract.keyEvidence.some((item) => item.entityId === 'PO-USER-0001'))
  assert.match(JSON.stringify(contract.keyEvidence), /PO Line|未收数量|ETA/)
  assert.ok(contract.navigationLinks.some((item) => item.moduleId === 'procurement:orders'))
  assert.ok(contract.navigationLinks.some((item) => item.moduleId === 'procurement:receiving'))
})

test('three-way match query returns PO GRN and Invoice evidence', () => {
  const contract = contractFor('为什么三单匹配失败？')
  assert.equal(contract.intent, 'three_way_match_failure_v2')
  const serialized = JSON.stringify(contract)
  assert.match(serialized, /PO Line/)
  assert.match(serialized, /GRN \/ Receipt Line/)
  assert.match(serialized, /Invoice Line/)
  assert.match(serialized, /数量差异/)
  assert.match(serialized, /单价差异/)
  assert.match(serialized, /金额差异/)
  assert.ok(contract.keyEvidence.some((item) => item.entityType === 'purchase_order'))
  assert.ok(contract.keyEvidence.some((item) => item.entityType === 'receiving_doc'))
  assert.ok(contract.keyEvidence.some((item) => item.entityType === 'supplier_invoice'))
})

test('data limitation appears when invoice data is incomplete', () => {
  const db = { ...createAiUserScenarioDb(), supplierInvoices: [] }
  const contract = contractFor('哪些数据依据不完整？', db)
  assert.equal(contract.intent, 'data_limitations_v2')
  assert.ok(contract.dataLimitations.some((item) => item.label.includes('Invoice') && item.missingData?.includes('Invoice')))
  // The retired imports pages are unavailable, so the answer does not link there.
  assert.ok(!contract.navigationLinks.some((item) => item.moduleId === 'imports'))
})
