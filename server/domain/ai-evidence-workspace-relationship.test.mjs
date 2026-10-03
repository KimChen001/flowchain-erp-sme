import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { buildAiEvidenceReuseResponse } from './ai-evidence-reuse.mjs'
import { validateAiRetrievalActions } from './ai-retrieval-context.mjs'

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
    supplierInvoices: [],
    products: [
      { sku: 'SKU-00412', name: '伺服电机 750W', currentStock: 34, min: 50, reorderPoint: 50, unit: '台', warehouse: 'WH-A', status: '低库存', riskLevel: '高' },
    ],
    inventoryMovements: [],
    inventoryExceptions: [],
    suppliers: [{ id: 'SUP-SZXY', name: '深圳新元电气' }],
    forecastPlans: [],
    marketPrices: [],
    marketSignals: [],
    events: [],
    auditLog: [],
  }
}

function visibleText(value) {
  return JSON.stringify(value)
}

test('R113 evidence workspace card uses business-readable labels and keeps evidence clickable', () => {
  const response = buildAiEvidenceReuseResponse(createPilotDb(), { moduleId: 'overview', message: '解释 PO-2026-1282 为什么优先' }, { cache: {} })
  const workspace = response.cards.find((card) => card.type === 'evidence_workspace')

  assert.ok(workspace)
  assert.equal(workspace.data.primaryObject, '采购单 PO-2026-1282')
  assert.ok(workspace.data.keyFacts.some((item) => item.includes('部分到货')))
  assert.ok(workspace.data.keyFacts.some((item) => item.includes('2026-05-25')))
  assert.ok(workspace.data.keyFacts.some((item) => item.includes('¥82,000')))
  assert.ok(workspace.data.relatedDocuments.some((item) => item.includes('采购申请 PR-2026-2401')))
  assert.ok(workspace.data.inventorySignals.some((item) => item.includes('SKU-00412')))
  assert.ok(workspace.evidence.some((item) => item.id === 'PO-2026-1282'))
  assert.doesNotMatch(visibleText(workspace), /documentType|entityType|auditContext|debug|tool_result/)
})

test('R113 Panel renders answers without raw JSON', () => {
  assert.doesNotMatch(panelSource, /JSON\.stringify\(card|JSON\.stringify\(data/)
})

test('R114 relationship reasoning explains PO SKU PR RFQ and GRN chain deterministically', () => {
  const response = buildAiEvidenceReuseResponse(createPilotDb(), { moduleId: 'overview', message: 'PO-2026-1282 和 SKU-00412 有什么关系？' }, { cache: {} })

  assert.equal(response.intent.name, 'relationship_reasoning_query')
  assert.equal(response.providerStatus, 'deterministic')
  assert.match(response.content, /PO-2026-1282/)
  assert.match(response.content, /SKU-00412/)
  assert.match(response.content, /PR-2026-2401/)
  assert.match(response.content, /GRN-202605-0418/)
  assert.ok(response.cards.some((card) => card.type === 'evidence_workspace'))
})

test('R129 relationship reasoning can ground contextual PO with explicit SKU', () => {
  const response = buildAiEvidenceReuseResponse(createPilotDb(), {
    moduleId: 'overview',
    message: '这个 PO 和 SKU-00412 有什么关系？',
    activeContext: { module: 'procurement', entityType: 'purchase_order', entityId: 'PO-2026-1282' },
    sessionGrounding: {
      lastPrimaryEntity: { type: 'po', id: 'PO-2026-1282', label: 'PO-2026-1282' },
      lastVisibleBusinessIds: { po: ['PO-2026-1282'], sku: ['SKU-00412'] },
    },
  }, { cache: {} })

  assert.equal(response.intent.name, 'relationship_reasoning_query')
  assert.match(response.content, /PO-2026-1282/)
  assert.match(response.content, /SKU-00412/)
  assert.match(response.content, /PR-2026-2401/)
  assert.match(response.content, /GRN-202605-0418/)
})

test('R114 relationship limitations do not invent missing links', () => {
  const response = buildAiEvidenceReuseResponse(createPilotDb(), { moduleId: 'overview', message: 'RFQ-26-9999 后面有没有转 PO？' }, { cache: {} })

  assert.equal(response.intent.name, 'relationship_reasoning_query')
  assert.match(response.content, /没有找到|请提供/)
  assert.doesNotMatch(response.content, /PO-2026-1282/)
})

test('R115 evidence-based follow-up draft actions stay review-first', () => {
  const po = buildAiEvidenceReuseResponse(createPilotDb(), { moduleId: 'overview', message: '解释 PO-2026-1282 为什么优先' }, { cache: {} })
  const rfq = buildAiEvidenceReuseResponse(createPilotDb(), { moduleId: 'overview', message: 'RFQ-26-0046 需要怎么跟进？' }, { cache: {} })
  const poActions = po.cards.find((card) => card.type === 'recommended_actions').actions
  const rfqActions = rfq.cards.find((card) => card.type === 'recommended_actions').actions
  const poDraft = poActions.find((action) => action.kind === 'draft_preview' && action.draftType === 'po_followup_draft')
  const rfqDraft = rfqActions.find((action) => action.kind === 'draft_preview' && action.draftType === 'supplier_followup_draft')

  assert.ok(poDraft)
  assert.match(poDraft.payload.message, /PO-2026-1282/)
  assert.ok(poDraft.originEvidence.some((item) => item.id === 'PO-2026-1282'))
  assert.ok(rfqDraft)
  assert.match(rfqDraft.payload.message, /RFQ-26-0046/)
  assert.ok(rfqDraft.originEvidence.some((item) => item.id === 'RFQ-26-0046'))
  assert.equal(validateAiRetrievalActions([...poActions, ...rfqActions]).valid, true)
  assert.equal(visibleText([...poActions, ...rfqActions]).includes('autoSubmit'), false)
})
