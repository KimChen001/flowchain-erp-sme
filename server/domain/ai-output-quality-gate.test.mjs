import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { buildAiEvidenceReuseResponse } from './ai-evidence-reuse.mjs'
import { handleAiRoute } from '../routes/ai.routes.mjs'

function createPilotDb() {
  return {
    purchaseRequests: [
      { pr: 'PR-2026-2401', sourceSku: 'SKU-00412', sourceName: '伺服电机 750W', supplier: '深圳新元电气', requester: '张磊', buyer: '王志强', requiredDate: '2026-06-20', quantity: 20, amount: 42000, currency: 'CNY', status: '待审批' },
    ],
    rfqs: [
      { id: 'RFQ-26-0046', title: '高精度数控刀具', suppliers: 3, quoted: 1, due: '2026-06-22', status: '进行中', bestSupplier: '苏州刀具科技' },
    ],
    purchaseOrders: [
      { po: 'PO-2026-1282', supplier: '深圳新元电气', eta: '2026-05-25', owner: '王志强', amount: 82000, currency: 'CNY', items: 50, received: 20, status: '部分到货', sourceRequest: 'PR-2026-2401' },
      { po: 'PO-2026-1284', supplier: '华东精工机械', eta: '2026-05-29', owner: '李娜', amount: 60900, currency: 'CNY', items: 12, received: 3, status: '部分到货' },
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
    suppliers: [],
    forecastPlans: [],
    marketPrices: [],
    marketSignals: [],
    events: [],
    auditLog: [],
  }
}

const INTERNAL_VISIBLE_PATTERN = /documentType|entityType|inventory_item|overdue_po|action-FOLLOWUP|tool_result|response_card|repository|debug|evidence\s*·|\bpo PO-|\brfq RFQ-|\bgrn GRN-|\binvoice INV-/i
const UNSAFE_ACTION_PATTERN = /自动(?:提交|审批|发送|创建|下单|过账)|auto[- ]?(?:submit|approve|send|create|post)|创建 PO|提交 RFQ|发送邮件/i

function visibleAiText(payload) {
  const parts = [payload.content, payload.message]
  for (const card of payload.cards || []) {
    parts.push(card.title)
    for (const key of ['topIssues', 'topItems', 'topRfqs', 'topPurchaseOrders', 'topExceptions', 'priorityItems']) {
      for (const item of card.data?.[key] || []) {
        parts.push(item.title, item.reason, item.explanation, item.sourceDocument, item.status, item.dueDate)
        for (const related of item.relatedDocuments || []) parts.push(related)
        for (const evidence of item.evidence || []) parts.push(evidence.label, evidence.summary, evidence.status)
        for (const action of item.recommendedActions || []) parts.push(action.label)
      }
    }
    for (const evidence of card.evidence || []) parts.push(evidence.label, evidence.summary, evidence.status)
    for (const action of card.actions || []) parts.push(action.label)
  }
  for (const evidence of payload.evidence || []) parts.push(evidence.label, evidence.summary, evidence.status)
  return parts.filter(Boolean).join('\n')
}

function createRouteContext(body, db = createPilotDb(), helpers = {}) {
  let response = null
  let providerDispatchCount = 0
  return {
    ctx: {
      req: { method: 'POST', body, headers: {} },
      res: {},
      url: new URL('/api/ai/chat', 'http://localhost'),
      db,
      send(_res, status, payload) {
        response = { status, payload }
      },
      readBody: async (req) => req.body,
      writeDb: async () => {},
      event: () => {},
      ensurePurchaseRequests: (nextDb) => nextDb.purchaseRequests || [],
      ensureInventoryMovements: (nextDb) => nextDb.inventoryMovements || [],
      ensureRfqs: (nextDb) => nextDb.rfqs || [],
      ensureEvents: (nextDb) => nextDb.events || [],
      ensureAuditLog: (nextDb) => nextDb.auditLog || [],
      supplierPerformance: () => [],
      supplierRecommendations: () => null,
      supplierQuoteCount: 0,
      openaiDispatcher: { dispatch() { providerDispatchCount += 1; throw new Error('provider should not be reached') } },
      arkDispatcher: { dispatch() { providerDispatchCount += 1; throw new Error('provider should not be reached') } },
      aiMaxTokens: 120,
      ...helpers,
    },
    get response() {
      return response
    },
    get providerDispatchCount() {
      return providerDispatchCount
    },
  }
}

function withEnv(patch, fn) {
  const keys = Object.keys(patch)
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]))
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const key of keys) {
        if (previous[key] === undefined) delete process.env[key]
        else process.env[key] = previous[key]
      }
    })
}

test('R91 today priority output hides internal keys and keeps deterministic counts coherent', () => {
  const response = buildAiEvidenceReuseResponse(createPilotDb(), { moduleId: 'overview', message: '今天最需要处理什么？' }, { cache: {} })
  const visible = visibleAiText(response)
  const summary = response.cards.find((card) => card.type === 'procurement_followup_summary')

  assert.equal(response.intent.name, 'today_cockpit_priority_query')
  assert.match(response.content, /下方展示其中优先级最高的/)
  assert.ok(summary.data.overduePoCount > 0)
  assert.match(visible, /采购单 PO-2026-1282 已超过预计到货日/)
  assert.match(visible, /SKU-00412.*库存/)
  assert.match(visible, /询价单 RFQ-26-0046/)
  assert.doesNotMatch(visible, INTERNAL_VISIBLE_PATTERN)
  assert.doesNotMatch(visible, /supplier_boundary_notice|master_data_boundary_notice/i)
})

test('R91 suggested actions are object-linked business actions', () => {
  const response = buildAiEvidenceReuseResponse(createPilotDb(), { message: '今天最需要处理什么？' }, { cache: {} })
  const actions = response.cards.find((card) => card.type === 'recommended_actions').actions.map((item) => item.label)

  assert.ok(actions.some((label) => /打开 PO-2026-1282，查看未到货明细/.test(label)))
  assert.ok(actions.some((label) => /查看 SKU-00412 的库存覆盖/.test(label)))
  assert.ok(actions.some((label) => /打开 RFQ-26-0046，确认待回复供应商/.test(label)))
  assert.equal(actions.some((label) => /打开采购单据并确认责任人|复核证据|action-/.test(label)), false)
})

test('R91 AI evidence UI renders business labels instead of entity type keys', () => {
  const renderer = readFileSync(new URL('../../src/components/ai/AiResponseV2Renderer.tsx', import.meta.url), 'utf8')

  assert.match(renderer, /\{children \|\| item\.entityLabel \|\| item\.label \|\| item\.entityId\}/)
  assert.doesNotMatch(renderer, /\{item\.entityType\}/)
})

test('R92 AI panel preserves chat state across module and evidence navigation', () => {
  const source = readFileSync(new URL('../../src/modules/ai-assistant/Panel.tsx', import.meta.url), 'utf8')
  const renderer = readFileSync(new URL('../../src/components/ai/AiResponseV2Renderer.tsx', import.meta.url), 'utf8')

  assert.doesNotMatch(source, /module-change/)
  assert.doesNotMatch(source, /useEffect\(\(\) => \{[\s\S]*?setMessages\(\[\]\)[\s\S]*?\}, \[moduleId\]\)/)
  assert.doesNotMatch(source, /useEffect\(\(\) => \{[\s\S]*?setInput\(""\)[\s\S]*?\}, \[moduleId\]\)/)
  assert.doesNotMatch(source, /useEffect\(\(\) => \{[\s\S]*?setAsking\(false\)[\s\S]*?\}, \[moduleId\]\)/)
  assert.match(source, /function AiResponseCard/)
  assert.match(source, /minimizeAfterNavigate/)
  assert.match(renderer, /onNavigate\(link\.moduleId, focusTarget, \{ returnTo: "ai"/)
  assert.match(source, /requestInFlightRef\.current = false/)
})

test('R93 non-today deterministic prompts use business-readable labels globally', () => {
  const prompts = [
    '哪些采购单据有风险？',
    '哪些 RFQ 需要跟进？',
    '哪些库存风险最高？',
    '哪些供应商需要跟进？',
    '解释 PO-2026-1282 为什么优先',
  ]
  const visible = prompts
    .map((message) => visibleAiText(buildAiEvidenceReuseResponse(createPilotDb(), { moduleId: 'overview', message }, { cache: {} })))
    .join('\n')

  assert.doesNotMatch(visible, INTERNAL_VISIBLE_PATTERN)
  assert.match(visible, /采购单 PO-2026-1282/)
  assert.match(visible, /询价单 RFQ-26-0046/)
  assert.match(visible, /收货单 GRN-202605-0418/)
  assert.match(visible, /SKU-00412.*库存|库存.*SKU-00412/)
})

test('R94 today priority uses structured deterministic priority items', () => {
  const response = buildAiEvidenceReuseResponse(createPilotDb(), { moduleId: 'overview', message: '今天最需要处理什么？' }, { cache: {} })
  const summary = response.cards.find((card) => card.type === 'procurement_followup_summary')
  const priorityItems = summary.data.priorityItems

  assert.ok(Array.isArray(priorityItems))
  assert.ok(priorityItems.length >= 3)
  assert.deepEqual(priorityItems.map((item) => item.rank), priorityItems.map((_, index) => index + 1))
  for (const item of priorityItems.slice(0, 3)) {
    assert.ok(item.rank)
    assert.ok(item.severity)
    assert.ok(item.reason)
    assert.ok(item.explanation)
    assert.ok(item.sourceDocument)
    assert.ok(Array.isArray(item.evidence))
    assert.ok(Array.isArray(item.recommendedActions))
  }
  assert.equal(summary.data.topIssues[0].title, priorityItems[0].sourceDocument)
  assert.equal(summary.data.topIssues[0].reason, priorityItems[0].explanation)
})

test('R94 PO priority explanation is deterministic and source-backed', () => {
  const response = buildAiEvidenceReuseResponse(createPilotDb(), { moduleId: 'overview', message: '解释 PO-2026-1282 为什么优先' }, { cache: {} })
  const visible = visibleAiText(response)

  assert.equal(response.intent.name, 'priority_explanation_query')
  assert.equal(response.provider, 'local')
  assert.equal(response.providerStatus, 'deterministic')
  assert.match(response.content, /PO-2026-1282/)
  assert.match(response.content, /2026-05-25/)
  assert.match(response.content, /部分到货/)
  assert.match(response.content, /确认未到货明细|供应商剩余交期/)
  assert.doesNotMatch(visible, INTERNAL_VISIBLE_PATTERN)
})

test('R95 broad deterministic AI prompt regression harness stays product-readable', () => {
  const prompts = [
    '今天最需要处理什么？',
    '解释 PO-2026-1282 为什么优先',
    '哪些采购单据有风险？',
    '哪些 RFQ 需要跟进？',
    '哪些库存风险最高？',
    'SKU-00412 为什么风险高？',
    '哪些供应商需要跟进？',
    '有没有收货异常？',
    '待审批 PR 有哪些？',
    '待转 PO 的 PR 有哪些？',
  ]
  const responses = prompts.map((message) => buildAiEvidenceReuseResponse(createPilotDb(), { moduleId: 'overview', message }, { cache: {} }))
  const visible = responses.map(visibleAiText).join('\n')

  assert.equal(responses.every(Boolean), true)
  assert.equal(responses.every((response) => response.provider === 'local' && response.providerStatus === 'deterministic'), true)
  assert.doesNotMatch(visible, INTERNAL_VISIBLE_PATTERN)
  assert.match(visible, /采购单 PO-2026-1282/)
  assert.match(visible, /SKU-00412/)
  assert.match(visible, /询价单 RFQ-26-0046/)
  assert.match(visible, /收货单 GRN-202605-0418/)
  assert.match(visible, /打开 PO-2026-1282|查看 SKU-00412|打开 RFQ-26-0046/)
})

test('R97 priority action flow is deterministic, object-specific, and review-first', () => {
  const response = buildAiEvidenceReuseResponse(createPilotDb(), { moduleId: 'overview', message: '今天最需要处理什么？' }, { cache: {} })
  const summary = response.cards.find((card) => card.type === 'procurement_followup_summary')
  const actions = response.cards.find((card) => card.type === 'recommended_actions').actions
  const actionText = actions.map((action) => action.label).join('\n')

  assert.deepEqual(summary.data.priorityItems.map((item) => item.rank), [1, 2, 3, 4])
  assert.equal(summary.data.priorityItems.every((item, index) => item.rank === index + 1), true)
  assert.equal(actions.every((action) => ['deep_link', 'review', 'edit', 'draft_preview'].includes(action.kind)), true)
  assert.match(actionText, /打开 PO-2026-1282，查看未到货明细/)
  assert.match(actionText, /查看 SKU-00412 的库存覆盖/)
  assert.match(actionText, /打开 RFQ-26-0046，确认待回复供应商/)
  assert.match(actionText, /预览 SKU-00412 补货 PR 草稿，需人工审阅后再保存/)
  assert.doesNotMatch(actionText, /复核证据|打开单据/)
  assert.doesNotMatch(actionText, UNSAFE_ACTION_PATTERN)
  const draft = actions.find((action) => action.kind === 'draft_preview')
  assert.equal(draft.draftType, 'purchase_request_draft')
  assert.equal(draft.payload.itemIdOrSku, 'SKU-00412')
})

test('R97 AI panel wires draft preview actions to review shell without unsafe submission copy', () => {
  const source = readFileSync(new URL('../../src/modules/ai-assistant/Panel.tsx', import.meta.url), 'utf8')
  const renderer = readFileSync(new URL('../../src/components/ai/AiResponseV2Renderer.tsx', import.meta.url), 'utf8')
  const draftShell = readFileSync(new URL('../../src/modules/action-drafts/ActionDraftReviewShell.tsx', import.meta.url), 'utf8')

  assert.match(source, /onReviewActionDraft=\{onReviewActionDraft\}/)
  assert.match(renderer, /const request = reviewRequest\(action\.card\)/)
  assert.match(renderer, /onClick=\{\(\) => onReviewActionDraft\(request\)\}/)
  assert.match(draftShell, /用户确认后也只保留允许范围内的安全内部记录/)
  assert.match(draftShell, /不提交/)
  assert.match(draftShell, /不外发/)
  assert.match(draftShell, /不写库存/)
  assert.doesNotMatch(source, UNSAFE_ACTION_PATTERN)
})

test('R98 deterministic business prompts bypass provider even with provider keys', async () => {
  await withEnv({
    AI_PROVIDER_ENABLED: 'true',
    AI_PROVIDER: 'openai',
    OPENAI_API_KEY: 'fake-openai-key',
    ARK_API_KEY: 'fake-ark-key',
    DOUBAO_API_KEY: 'fake-doubao-key',
  }, async () => {
    for (const message of ['今天最需要处理什么？', '解释 PO-2026-1282 为什么优先', '哪些库存风险最高？', '哪些 RFQ 需要跟进？', '哪些供应商需要跟进？']) {
      const route = createRouteContext({ moduleId: 'overview', message })
      await handleAiRoute(route.ctx)
      assert.equal(route.response.status, 200, message)
      assert.equal(route.providerDispatchCount, 0, message)
      assert.notEqual(route.response.payload.provider, 'openai', message)
      assert.equal(/fake-openai-key|fake-ark-key|fake-doubao-key|stack|trace/i.test(JSON.stringify(route.response.payload)), false, message)
    }
  })
})

test('R98 unknown prompt fallback stays sanitized when provider is disabled', async () => {
  await withEnv({
    AI_PROVIDER_ENABLED: undefined,
    OPENAI_API_KEY: 'fake-openai-key',
    ARK_API_KEY: 'fake-ark-key',
    DOUBAO_API_KEY: 'fake-doubao-key',
  }, async () => {
    const route = createRouteContext({ moduleId: 'overview', message: '写一首采购宣言' })
    await handleAiRoute(route.ctx)
    const serialized = JSON.stringify(route.response.payload)

    assert.equal(route.response.status, 200)
    assert.equal(route.response.payload.intent.name, 'unknown_guided_fallback')
    assert.equal(route.response.payload.providerStatus, 'deterministic')
    assert.equal(route.response.payload.status, 'guided_fallback')
    assert.match(serialized, /今日优先事项|库存风险|供应商跟进/)
    assert.equal(/fake-openai-key|fake-ark-key|fake-doubao-key|stack|trace|SyntaxError|TypeError|```|tool_result|response_card/i.test(serialized), false)
  })
})

test('R99 AI assistant pilot UI keeps compact business-facing states', () => {
  const source = readFileSync(new URL('../../src/modules/ai-assistant/Panel.tsx', import.meta.url), 'utf8')

  assert.match(source, /正在查询业务数据/)
  assert.match(source, /displaySafeAssistantRecoveryMessage/)
  assert.match(source, /当前工作区数据暂时未能完整读取，仍可先从相关模块查看来源证据并进入人工复核。/)
  assert.match(source, /草稿预览 · 人工复核 · 不提交 · 不外发 · 不写库存/)
  assert.doesNotMatch(source, /```|JSON\.stringify\(.*message|raw debug|tool_result|response_card/)
})

test('R100 AI copilot readiness checkpoint keeps core pilot contract intact', async () => {
  const db = createPilotDb()
  const prompts = ['今天最需要处理什么？', '解释 PO-2026-1282 为什么优先', '哪些采购单据有风险？', '哪些库存风险最高？', '哪些供应商需要跟进？']
  const responses = prompts.map((message) => buildAiEvidenceReuseResponse(db, { moduleId: 'overview', message }, { cache: {} }))
  const visible = responses.map(visibleAiText).join('\n')
  const panel = readFileSync(new URL('../../src/modules/ai-assistant/Panel.tsx', import.meta.url), 'utf8')
  const renderer = readFileSync(new URL('../../src/components/ai/AiResponseV2Renderer.tsx', import.meta.url), 'utf8')
  const evidenceLinks = readFileSync(new URL('../../src/lib/evidenceLinks.ts', import.meta.url), 'utf8')

  assert.equal(responses.every((response) => response && response.providerStatus === 'deterministic'), true)
  assert.doesNotMatch(visible, INTERNAL_VISIBLE_PATTERN)
  assert.doesNotMatch(visible, UNSAFE_ACTION_PATTERN)
  assert.match(visible, /采购单 PO-2026-1282/)
  assert.match(visible, /SKU-00412/)
  assert.match(visible, /询价单 RFQ-26-0046/)
  assert.match(renderer, /onClick=\{\(\) => onNavigate\(route\.listRouteId, \{ entityType: type, entityId: item\.entityId, focusArea \}, \{ returnTo: "ai", entityLabel: item\.entityLabel \|\| item\.entityId, source: "ai" \}\)\}/)
  assert.doesNotMatch(panel, /useEffect\(\(\) => \{[\s\S]*?setMessages\(\[\]\)[\s\S]*?\}, \[moduleId\]\)/)
  assert.match(evidenceLinks, /navigationIntentFromApiRoute/)
})
