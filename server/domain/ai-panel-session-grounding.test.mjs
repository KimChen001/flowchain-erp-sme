import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  buildAiSessionGroundedResponse,
  resolveAiSessionGrounding,
} from './ai-session-grounding.mjs'

const panelSource = readFileSync(new URL('../../src/modules/ai-assistant/Panel.tsx', import.meta.url), 'utf8')

function createPilotDb() {
  return {
    purchaseRequests: [
      { pr: 'PR-2026-2401', sourceSku: 'SKU-00412', sourceName: '伺服电机 750W', supplier: '深圳新元电气', requester: '张磊', buyer: '王志强', requiredDate: '2026-06-20', quantity: 20, amount: 42000, currency: 'CNY', status: '待审批' },
    ],
    rfqs: [
      { id: 'RFQ-26-0046', title: '高精度数控刀具', suppliers: 3, quoted: 1, due: '2026-06-22', status: '进行中', bestSupplier: '苏州刀具科技', sourceRequest: 'PR-2026-2401', linkedPo: 'PO-2026-1282' },
    ],
    purchaseOrders: [
      { po: 'PO-2026-1282', supplier: '深圳新元电气', eta: '2026-05-25', owner: '王志强', amount: 82000, currency: 'CNY', items: 50, received: 20, status: '部分到货', sourceRequest: 'PR-2026-2401', sourceRfq: 'RFQ-26-0046', sourceSku: 'SKU-00412' },
      { po: 'PO-2026-1284', supplier: '苏州刀具科技', eta: '2026-06-10', amount: 12000, currency: 'CNY', status: '已发出' },
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

test('R111 panel has explicit minimize restore outside click and cleanup behavior', () => {
  assert.match(panelSource, /const minimizeAssistant = \(\) => setOpen\(false\)/)
  assert.match(panelSource, /const restoreAssistant = \(\) => setOpen\(true\)/)
  assert.match(panelSource, /document\.addEventListener\("pointerdown", handlePointerDown\)/)
  assert.match(panelSource, /document\.removeEventListener\("pointerdown", handlePointerDown\)/)
  assert.match(panelSource, /document\.addEventListener\("keydown", handleKeyDown\)/)
  assert.match(panelSource, /event\.key === "Escape"/)
  assert.match(panelSource, /panelRef\.current\?\.contains\(target\)/)
  assert.match(panelSource, /aria-label=\{language === "zh-CN" \? "最小化 AI 助手" : "Minimize AI assistant"\}/)
  assert.match(panelSource, /aria-label=\{open \? \(language === "zh-CN" \? "最小化 AI 助手" : "Minimize AI assistant"\) : \(language === "zh-CN" \? "展开 AI 助手" : "Open AI assistant"\)\}/)
})

test('R111 minimize and navigation preserve messages input evidence and actions', () => {
  assert.match(panelSource, /const minimizeAssistant = \(\) => setOpen\(false\);/)
  assert.match(panelSource, /const minimizeAfterNavigate: AiNavigate = \(moduleId, focusTarget, options\) => \{/)
  assert.match(panelSource, /onNavigate\?\.\(moduleId, focusTarget \|\| null, \{ source: "ai", returnTo: activeContext\?\.route \|\| moduleId, \.\.\.options \}\);\s*minimizeAssistant\(\)/)
  assert.match(panelSource, /<AiResponseCards cards=\{message\.cards\} onNavigate=\{minimizeAfterNavigate\}/)
  assert.doesNotMatch(panelSource, /useEffect\(\(\) => \{[\s\S]*?setMessages\(\[\]\)[\s\S]*?\}, \[moduleId\]\)/)
})

test('R112 panel sends compact session grounding without full chat transcript', () => {
  assert.match(panelSource, /type AiSessionGrounding = \{/)
  assert.match(panelSource, /lastPrimaryEntity/)
  assert.match(panelSource, /lastEvidenceIds/)
  assert.match(panelSource, /lastVisibleBusinessIds/)
  assert.match(panelSource, /buildSessionGrounding\(messages, currentContext\)/)
  assert.match(panelSource, /sessionGrounding,/)
  assert.doesNotMatch(panelSource, /chatHistory|transcript|messages:\s*messages/)
})

test('R112 resolves unambiguous follow-up PO SKU and RFQ references from session evidence', () => {
  const db = createPilotDb()
  const grounding = {
    lastVisibleBusinessIds: {
      po: ['PO-2026-1282'],
      sku: ['SKU-00412'],
      rfq: ['RFQ-26-0046'],
    },
  }

  const po = buildAiSessionGroundedResponse(db, { moduleId: 'overview', message: '这个 PO 为什么优先？', sessionGrounding: grounding }, { cache: {} })
  const sku = buildAiSessionGroundedResponse(db, { moduleId: 'overview', message: '这个 SKU 风险高在哪里？', sessionGrounding: grounding }, { cache: {} })
  const rfq = buildAiSessionGroundedResponse(db, { moduleId: 'overview', message: '刚才那个 RFQ 需要谁回复？', sessionGrounding: grounding }, { cache: {} })

  assert.equal(po.sessionGrounded, true)
  assert.match(po.groundedQuestion, /PO-2026-1282/)
  assert.match(po.content, /PO-2026-1282/)
  assert.equal(sku.sessionGrounded, true)
  assert.match(sku.content, /SKU-00412/)
  assert.equal(rfq.sessionGrounded, true)
  assert.match(rfq.content, /RFQ-26-0046|询价/)
  assert.equal([po, sku, rfq].every((item) => item.provider === 'local' && item.providerStatus === 'deterministic'), true)
})

test('R112 ambiguous or explicit references do not silently reuse stale context', () => {
  const explicit = resolveAiSessionGrounding({
    message: '解释 PO-2026-1284 为什么优先',
    sessionGrounding: { lastVisibleBusinessIds: { po: ['PO-2026-1282'] } },
  })
  const ambiguous = buildAiSessionGroundedResponse(createPilotDb(), {
    message: '这个 PO 为什么优先？',
    sessionGrounding: { lastVisibleBusinessIds: { po: ['PO-2026-1282', 'PO-2026-1284'] } },
  }, { cache: {} })

  assert.equal(explicit, null)
  assert.equal(ambiguous.intent.name, 'session_grounding_clarification')
  assert.equal(ambiguous.sessionGrounded, false)
  assert.match(ambiguous.content, /PO-2026-1282 还是 PO-2026-1284/)
})
