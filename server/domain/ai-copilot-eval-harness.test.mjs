import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { buildAiEvidenceReuseResponse } from './ai-evidence-reuse.mjs'
import { getAiModelBoundaryState } from './ai-retrieval-audit-boundary.mjs'
import { validateAiRetrievalActions } from './ai-retrieval-context.mjs'
import { getAiRetrievalSandboxState } from './ai-retrieval-sandbox.mjs'
import { buildAiSessionGroundedResponse } from './ai-session-grounding.mjs'

const panelSource = readFileSync(new URL('../../src/modules/ai-assistant/Panel.tsx', import.meta.url), 'utf8')

function createPilotDb() {
  return {
    purchaseRequests: [
      { pr: 'PR-2026-2401', sourceSku: 'SKU-00412', sourceName: '伺服电机 750W', supplier: '深圳新元电气', requester: '张磊', buyer: '王志强', requiredDate: '2026-06-20', quantity: 20, amount: 42000, currency: 'CNY', status: '待审批' },
    ],
    rfqs: [
      { id: 'RFQ-26-0046', title: '高精度数控刀具', suppliers: 3, quoted: 1, due: '2026-06-22', status: '进行中', bestSupplier: '苏州刀具科技', sourceRequest: 'PR-2026-2401', linkedPo: 'PO-2026-1282', sourceSku: 'SKU-00412' },
    ],
    purchaseOrders: [
      { po: 'PO-2026-1282', supplier: '深圳新元电气', eta: '2026-05-25', owner: '王志强', amount: 82000, currency: 'CNY', items: 50, received: 20, status: '部分到货', sourceRequest: 'PR-2026-2401', sourceRfq: 'RFQ-26-0046', sourceSku: 'SKU-00412' },
    ],
    receivingDocs: [
      { grn: 'GRN-202605-0418', po: 'PO-2026-1282', supplier: '深圳新元电气', status: '待质检', items: 20, passed: 18, failed: 2, warehouse: 'WH-A' },
    ],
    supplierInvoices: [
      { invoiceNumber: 'INV-SZ-260601', supplier: '深圳新元电气', relatedPo: 'PO-2026-1282', relatedGrn: 'GRN-202605-0418', amount: 82000, currency: 'CNY', varianceAmount: 1200, matchStatus: '存在差异' },
    ],
    products: [
      { sku: 'SKU-00412', name: '伺服电机 750W', currentStock: 34, min: 50, reorderPoint: 50, unit: '台', warehouse: 'WH-A', status: '低库存', riskLevel: '高' },
    ],
    inventoryMovements: [],
    inventoryExceptions: [
      { id: 'IEX-1', sku: 'SKU-00412', itemName: '伺服电机 750W', status: '待复核', quantityImpact: -2, reason: '盘点差异' },
    ],
    suppliers: [{ id: 'SUP-SZXY', name: '深圳新元电气' }],
    forecastPlans: [],
    marketPrices: [],
    marketSignals: [],
    events: [],
    auditLog: [],
  }
}

function textOf(value) {
  return JSON.stringify(value)
}

function actionsOf(response) {
  return response.cards.find((card) => card.type === 'recommended_actions')?.actions || []
}

function assertDeterministic(response) {
  assert.equal(response.provider, 'local')
  assert.equal(response.providerStatus, 'deterministic')
  assert.ok(Array.isArray(response.cards))
  assert.doesNotMatch(textOf(response), /autoSubmit|tool_result|debug|auditContext/)
  assert.equal(validateAiRetrievalActions(actionsOf(response)).valid, true)
}

test('R119 copilot eval harness covers core scenario intents and evidence ids', () => {
  const db = createPilotDb()
  const scenarios = [
    {
      message: '今天最需要处理什么？',
      intent: 'today_cockpit_priority_query',
      ids: ['PO-2026-1282', 'SKU-00412', 'INV-SZ-260601'],
      cardTypes: ['procurement_followup_summary', 'recommended_actions'],
    },
    {
      message: '解释 PO-2026-1282 为什么优先',
      intent: 'priority_explanation_query',
      ids: ['PO-2026-1282', 'GRN-202605-0418', 'SKU-00412'],
      cardTypes: ['priority_explanation', 'evidence_workspace', 'recommended_actions'],
    },
    {
      message: 'SKU-00412 为什么风险高？',
      intent: 'inventory_status_query',
      ids: ['SKU-00412'],
      cardTypes: ['inventory_status', 'recommended_actions'],
    },
    {
      message: 'RFQ-26-0046 需要怎么跟进？',
      intent: 'rfq_followup_query',
      ids: ['RFQ-26-0046', 'PR-2026-2401', 'PO-2026-1282'],
      cardTypes: ['procurement_followup_summary', 'evidence_workspace', 'recommended_actions'],
    },
    {
      message: '供应商 深圳新元电气 有哪些风险？',
      intent: 'supplier_followup_query',
      ids: ['PO-2026-1282', 'INV-SZ-260601'],
      cardTypes: ['procurement_followup_summary', 'recommended_actions'],
    },
    {
      message: 'GRN-202605-0418 有什么异常？',
      intent: 'procurement_exception_query',
      ids: ['GRN-202605-0418', 'INV-SZ-260601'],
      cardTypes: ['procurement_exception_summary', 'recommended_actions'],
    },
    {
      message: 'PO-2026-1282 和 SKU-00412 有什么关系？',
      intent: 'relationship_reasoning_query',
      ids: ['PO-2026-1282', 'SKU-00412', 'PR-2026-2401', 'GRN-202605-0418'],
      cardTypes: ['evidence_workspace', 'recommended_actions'],
    },
    {
      message: '逾期 PO 一般怎么处理？',
      intent: 'sop_retrieval_query',
      ids: ['SOP-PO-OVERDUE'],
      cardTypes: ['evidence_workspace', 'recommended_actions'],
    },
  ]

  for (const scenario of scenarios) {
    const response = buildAiEvidenceReuseResponse(db, { moduleId: 'overview', message: scenario.message }, { cache: {} })
    const serialized = textOf(response)

    assertDeterministic(response)
    assert.equal(response.intent.name, scenario.intent, scenario.message)
    for (const cardType of scenario.cardTypes) assert.ok(response.cards.some((card) => card.type === cardType), scenario.message)
    for (const id of scenario.ids) assert.match(serialized, new RegExp(id), scenario.message)
  }
})

test('R119 eval harness enforces review-first draft previews across action families', () => {
  const db = createPilotDb()
  const prompts = [
    ['解释 PO-2026-1282 为什么优先', 'po_followup_draft'],
    ['SKU-00412 为什么风险高？', 'purchase_request_draft'],
    ['RFQ-26-0046 需要怎么跟进？', 'supplier_followup_draft'],
    ['GRN-202605-0418 有什么异常？', 'po_followup_draft'],
  ]

  for (const [message, draftType] of prompts) {
    const response = buildAiEvidenceReuseResponse(db, { moduleId: 'overview', message }, { cache: {} })
    const draft = actionsOf(response).find((action) => action.kind === 'draft_preview' && action.draftType === draftType)

    assertDeterministic(response)
    assert.ok(draft, message)
    assert.equal(draft.requiresHumanReview, true, message)
    assert.ok(Array.isArray(draft.originEvidence) && draft.originEvidence.length > 0, message)
    assert.doesNotMatch(textOf(draft), /autoSubmit|autoSend|autoSave/)
  }
})

test('R119 ambiguous follow-up eval asks for clarification instead of guessing', () => {
  const response = buildAiSessionGroundedResponse(createPilotDb(), {
    message: '这个 PO 为什么优先？',
    sessionGrounding: { lastVisibleBusinessIds: { po: ['PO-2026-1282', 'PO-2026-1284'] } },
  }, { cache: {} })

  assert.equal(response.intent.name, 'session_grounding_clarification')
  assert.equal(response.sessionGrounded, false)
  assert.match(response.content, /PO-2026-1282 还是 PO-2026-1284/)
  assert.doesNotMatch(textOf(response), /provider fallback|autoSubmit|tool_result|debug/i)
})

test('R120 readiness checkpoint keeps model boundaries disabled and UI grounding gates present', () => {
  const modelBoundary = getAiModelBoundaryState({})
  const sandbox = getAiRetrievalSandboxState({})

  assert.equal(modelBoundary.providerDefault, 'disabled')
  assert.equal(modelBoundary.vectorDatabase, false)
  assert.equal(modelBoundary.businessMutationAllowed, false)
  assert.equal(sandbox.enabled, false)
  assert.equal(sandbox.providerCallsAllowed, false)
  assert.equal(sandbox.businessMutationAllowed, false)
  assert.match(panelSource, /buildSessionGrounding\(messages, currentContext\)/)
  assert.match(panelSource, /sessionGrounding,/)
  assert.match(panelSource, /document\.addEventListener\("pointerdown", handlePointerDown\)/)
  assert.match(panelSource, /event\.key === "Escape"/)
  assert.doesNotMatch(panelSource, /messages:\s*messages|chatHistory|transcript/)
})
