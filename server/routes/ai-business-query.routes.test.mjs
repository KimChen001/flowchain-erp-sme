import test from 'node:test'
import assert from 'node:assert/strict'
import { handleAiRuntimeGatewayRoute } from './ai-runtime-gateway.routes.mjs'
import { handleAiRoute } from './ai.routes.mjs'
import { buildSupplierActionSummaries } from '../domain/supplier-action-summary-read-service.mjs'

const permissions = new Set(['finance.payable.read', 'finance.supplier_invoice.read', 'finance.settlement.read', 'finance.cashbook.read', 'finance.bank_reconciliation.read', 'finance.amounts.read', 'finance.partner_snapshot.read', 'procurement.purchase_order.read', 'receiving.read'])
const actor = { tenantId: 'tenant-test', permissionCodes: permissions }
const db = { suppliers: [{ id: 'supplier-a', name: 'Supplier A' }, { id: 'supplier-b', name: 'Supplier B' }], purchaseOrders: [], receivingDocs: [], rfqs: [], products: [], purchaseRequests: [], supplierInvoices: [], forecastPlans: [], events: [], auditLog: [] }
const item = (id, dueCount = 1) => ({
  supplier: { id, name: `Supplier ${id.slice(-1).toUpperCase()}`, displayName: `Supplier ${id.slice(-1).toUpperCase()}` },
  payment: { state: dueCount ? 'confirmed' : 'confirmed_zero', dueCount, dueAmount: dueCount ? 100 : 0, overdueCount: 0, overdueAmount: 0, readyCount: dueCount, blockedCount: 0, blocks: [] },
  invoice: { state: 'confirmed_zero', openCount: 0, mismatchCount: 0, disputedCount: 0, missingEvidenceCount: 0 },
  procurement: { state: 'confirmed_zero', openPoCount: 0, overduePoCount: 0, overduePoIds: [], unreceivedPoCount: 0 },
  receiving: { state: 'confirmed_zero', exceptionCount: 0, rejectedQuantity: 0, pendingEvidenceCount: 0 },
  rfq: { state: 'confirmed_zero', awaitingResponseCount: 0, expiredCount: 0 },
  reconciliation: { state: 'confirmed_zero', unreconciledPaymentCount: 0, blockingExceptionCount: 0 },
  dataQuality: { incompleteRecordCount: 0, limitations: [] },
  priority: { level: 'low', score: 1, reasons: [], algorithmVersion: 'supplier-action-priority-v1' },
  recommendedActions: [], evidence: [],
})
const summaryService = { read: async () => ({ items: [item('supplier-a'), item('supplier-b', 0)], recordValiditySummary: { validCount: 2, incompleteCount: 0, invalidCount: 0, hiddenCount: 0, unavailable: false }, fieldVisibility: { amounts: true, partner: true }, sourceStatus: {} }) }

function baseContext(pathname, body) {
  let payload
  return {
    ctx: {
      req: { method: 'POST', headers: {} }, res: {}, url: { pathname }, db: structuredClone(db), repositories: { mode: 'database' }, identity: { authenticated: true, tenantId: 'tenant-test', userId: 'user-test', role: 'manager' }, env: { FLOWCHAIN_WORKSPACE_TIMEZONE: 'Asia/Shanghai' },
      aiBusinessQueryPrisma: { supplier: { findMany: async () => db.suppliers }, tenant: { findUnique: async () => ({ timezone: "Asia/Shanghai" }) } }, aiBusinessQueryActor: actor, aiBusinessQuerySummaryService: summaryService,
      readBody: async () => ({ answerLanguage: "zh-CN", ...structuredClone(body) }), send: (_res, status, next) => { payload = { status, payload: next } },
      ensurePurchaseRequests: (next) => next.purchaseRequests || [], ensureInventoryMovements: () => [], ensureRfqs: (next) => next.rfqs || [], writeDb: async () => {}, event: () => {},
    },
    result: () => payload,
  }
}

test('runtime endpoint returns scoped multi-section V2 without raw plan or tool leakage', async () => {
  const harness = baseContext('/api/ai-runtime/respond', { message: '帮我同时看看供应商付款、延期 PO 和发票差异。', activeModuleId: 'srm' })
  assert.equal(await handleAiRuntimeGatewayRoute(harness.ctx), true)
  const { status, payload } = harness.result()
  assert.equal(status, 200)
  assert.equal(payload.version, 'v2')
  assert.equal(payload.businessQuery.scopeMode, 'all')
  assert.deepEqual(payload.businessQuery.goalLabels, ['需要付款', '付款准备度', '发票差异', '延期 PO'])
  const serialized = JSON.stringify(payload)
  assert.doesNotMatch(serialized, /executedTools|toolName|SELECT\s|Prisma|chain.?of.?thought|requestedActions/gi)
  assert.doesNotMatch(serialized, /getSupplierPaymentSummary|getSupplierInvoiceExceptions/)
})

test('legacy chat endpoint remains compatible and performs no business mutation', async () => {
  const harness = baseContext('/api/ai/chat', { question: '有哪些供应商需要付款？', moduleId: 'srm' })
  const before = structuredClone(harness.ctx.db)
  await handleAiRoute(harness.ctx)
  const { status, payload } = harness.result()
  assert.equal(status, 200)
  assert.equal(payload.intent.name, 'business_query_plan_v1')
  assert.equal(payload.cards[0].type, 'ai_response_v2')
  assert.deepEqual(harness.ctx.db, before)
})

test('previous result scope and planner timeout fallback are safe', async () => {
  const harness = baseContext('/api/ai-runtime/respond', {
    message: '这些供应商还有什么事情没有处理？',
    conversationContext: { previousEntityRefs: [{ entityType: 'supplier', entityId: 'supplier-a', entityLabel: 'Supplier A' }] },
  })
  harness.ctx.env = { ...harness.ctx.env, FLOWCHAIN_ENABLE_AI_SEMANTIC_PLANNER: 'true', FLOWCHAIN_AI_PROVIDER_MODE: 'provider_assisted', FLOWCHAIN_AI_PROVIDER_KIND: 'generic_http' }
  harness.ctx.aiSemanticProviderPlanner = async () => ({ ok: false, reason: 'timeout' })
  await handleAiRuntimeGatewayRoute(harness.ctx)
  const payload = harness.result().payload
  assert.equal(payload.businessQuery.scopeMode, 'previous_result')
  assert.equal(payload.businessQuery.scopeBadge, '上一轮结果')
  assert.equal(payload.businessQuery.plannerStatus, 'degraded')
})

test('unknown supplier returns clarification without executing summary service', async () => {
  let called = false
  const harness = baseContext('/api/ai-runtime/respond', { message: '为什么 Supplier Missing 暂时不能付款？' })
  harness.ctx.aiBusinessQuerySummaryService = { read: async () => { called = true; return { items: [] } } }
  await handleAiRuntimeGatewayRoute(harness.ctx)
  assert.equal(called, false)
  assert.equal(harness.result().payload.businessQuery.clarification.needed, true)
})


test('English query results preserve authorized supplier references for follow-up', async () => {
  const harness = baseContext('/api/ai-runtime/respond', { message: 'Which suppliers need payment?', answerLanguage: 'en-US' });
  await handleAiRuntimeGatewayRoute(harness.ctx);
  const response = harness.result().payload;
  assert.equal(response.businessQuery.scopeBadge, 'All suppliers');
  assert.ok(response.businessQuery.goalLabels.includes('Payments due'));
  assert.deepEqual(response.resolvedContext.entityRefs.map(ref => ref.entityId), ['supplier-a']);
  assert.doesNotMatch(response.conclusion.title + response.conclusion.summary, /[\u4e00-\u9fff]/);
});


test('follow-up uses only suppliers returned by the previous payment query', async () => {
  const first = baseContext('/api/ai-runtime/respond', { message: 'Which suppliers need payment?', answerLanguage: 'en-US' })
  await handleAiRuntimeGatewayRoute(first.ctx)
  const refs = first.result().payload.resolvedContext.entityRefs
  const second = baseContext('/api/ai-runtime/respond', { message: 'What else should I follow up on for these suppliers?', answerLanguage: 'en-US', conversationContext: { previousEntityRefs: refs } })
  await handleAiRuntimeGatewayRoute(second.ctx)
  assert.equal(second.result().payload.businessQuery.scopeMode, 'previous_result')
  assert.deepEqual(second.result().payload.resolvedContext.entityRefs.map(ref => ref.entityId), ['supplier-a'])
})

// A role without finance.partner_snapshot.read, answered from the real supplier
// summary: a blocked payable, an overdue purchase order, a mismatched invoice
// and a receiving exception, each with a stored status code.
const restrictedActor = { tenantId: 'tenant-test', permissionCodes: new Set([...permissions].filter((code) => code !== 'finance.partner_snapshot.read')) }
const restrictedInvoice = { tenantId: 'tenant-test', id: 'inv-a', supplierId: 'supplier-a', invoiceNumber: 'INV-A', amount: 100, currency: 'USD', status: 'exception', matchStatus: 'mismatch', relatedPoId: 'PO-A' }
const restrictedRecords = {
  suppliers: [{ tenantId: 'tenant-test', id: 'supplier-a', code: 'SUP-A', name: 'Supplier A' }],
  invoices: [restrictedInvoice],
  payables: [{ tenantId: 'tenant-test', id: 'pay-a', supplierId: 'supplier-a', supplierInvoiceId: 'inv-a', supplierInvoice: restrictedInvoice, obligationNumber: 'AP-A', currency: 'USD', outstandingAmount: 100, dueDate: '2026-07-20T00:00:00.000Z', status: 'partially_settled' }],
  purchaseOrders: [{ tenantId: 'tenant-test', id: 'PO-A', supplierId: 'supplier-a', status: 'partially_received', expectedDate: '2026-07-01T00:00:00.000Z', lines: [] }],
  receiving: [{ tenantId: 'tenant-test', id: 'GRN-A', documentNumber: 'GRN-A', supplierId: 'supplier-a', poId: 'PO-A', status: 'exception', lines: [{ rejectedQty: 2 }] }],
  settlements: [], rfqs: [], bankExceptions: [],
}
const restrictedSummaryService = { read: async ({ timeWindow, filters }) => buildSupplierActionSummaries({ records: restrictedRecords, actor: restrictedActor, timeWindow, filters, now: new Date('2026-07-24T00:00:00.000Z') }) }

// The strings the assistant panel shows for a business query answer.
const answerStrings = (response) => [
  response.conclusion.title, response.conclusion.summary,
  ...response.keyEvidence.flatMap((item) => [item.label, item.entityLabel, item.summary, item.status, item.sourceLabel]),
  ...response.navigationLinks.map((link) => link.label),
  ...response.dataLimitations.flatMap((item) => [item.label, item.description, item.consequence]),
  ...response.businessImpact.flatMap((item) => [item.area, item.impact, item.explanation]),
  response.businessQuery.scopeBadge, ...response.businessQuery.goalLabels,
  ...response.businessQuery.sectionCards.flatMap((card) => [card.label, card.stateLabel, ...card.rows.map((row) => row.supplier?.displayName)]),
  ...response.resolvedContext.entityRefs.map((ref) => ref.entityLabel),
].filter(Boolean)

test('a restricted role sees evidence statuses and the supplier label in the answer language', async () => {
  // The answer follows the question's language, so each language asks in its own.
  const expected = {
    'en-US': { message: 'Check supplier payments, overdue POs, and invoice mismatches together.', restricted: 'Restricted supplier', status: { 'pay-a': 'Partially settled', 'PO-A': 'Partially received', 'inv-a': 'Exception', 'GRN-A': 'Exception' } },
    'zh-CN': { message: '帮我同时看看供应商付款、延期 PO 和发票差异。', restricted: '受限供应商', status: { 'pay-a': '部分结算', 'PO-A': '部分收货', 'inv-a': '异常', 'GRN-A': '异常' } },
  }
  for (const [answerLanguage, copy] of Object.entries(expected)) {
    const harness = baseContext('/api/ai-runtime/respond', { message: copy.message, answerLanguage, activeModuleId: 'srm' })
    harness.ctx.aiBusinessQueryActor = restrictedActor
    harness.ctx.aiBusinessQuerySummaryService = restrictedSummaryService
    await handleAiRuntimeGatewayRoute(harness.ctx)
    const response = harness.result().payload
    assert.equal(response.intent, 'business_query_plan_v1', answerLanguage)
    const evidence = response.keyEvidence.filter((item) => copy.status[item.entityId])
    assert.deepEqual(Object.fromEntries(evidence.map((item) => [item.entityId, item.status])), copy.status, answerLanguage)
    assert.deepEqual(Object.fromEntries(evidence.map((item) => [item.entityId, item.statusCode])), { 'pay-a': 'partially_settled', 'PO-A': 'partially_received', 'inv-a': 'exception', 'GRN-A': 'exception' })
    assert.ok(evidence.every((item) => item.summary && item.summary !== item.statusCode && item.summary !== item.status))
    assert.deepEqual(response.resolvedContext.entityRefs.map((ref) => ref.entityLabel), [copy.restricted])
    assert.ok(response.businessQuery.sectionCards.some((card) => card.rows.length))
    assert.ok(response.businessQuery.sectionCards.every((card) => card.rows.every((row) => row.supplier.displayName === copy.restricted)))
    const strings = answerStrings(response)
    assert.deepEqual(strings.filter((value) => /partially_settled|partially_received|^exception$/.test(value)), [], answerLanguage)
    if (answerLanguage === 'en-US') assert.deepEqual(strings.filter((value) => /[\u4e00-\u9fff]/.test(value)), [])
    else assert.ok(!strings.includes('Restricted supplier'))
  }
})

test('a follow-up with a restricted supplier label still scopes by id, not by the label', async () => {
  const first = baseContext('/api/ai-runtime/respond', { message: 'Check supplier payments, overdue POs, and invoice mismatches together.', answerLanguage: 'en-US', activeModuleId: 'srm' })
  first.ctx.aiBusinessQueryActor = restrictedActor
  first.ctx.aiBusinessQuerySummaryService = restrictedSummaryService
  await handleAiRuntimeGatewayRoute(first.ctx)
  const refs = first.result().payload.resolvedContext.entityRefs
  assert.deepEqual(refs, [{ entityType: 'supplier', entityId: 'supplier-a', entityLabel: 'Restricted supplier' }])
  // A restricted label without an id names no supplier, in either language.
  for (const previousEntityRefs of [refs, [{ entityType: 'supplier', entityLabel: 'Restricted supplier' }], [{ entityType: 'supplier', entityLabel: '受限供应商' }]]) {
    const next = baseContext('/api/ai-runtime/respond', { message: 'What else should I follow up on for these suppliers?', answerLanguage: 'en-US', conversationContext: { previousEntityRefs } })
    next.ctx.aiBusinessQueryActor = restrictedActor
    next.ctx.aiBusinessQuerySummaryService = restrictedSummaryService
    await handleAiRuntimeGatewayRoute(next.ctx)
    const ids = next.result().payload.resolvedContext.entityRefs.map((ref) => ref.entityId)
    assert.deepEqual(ids, previousEntityRefs[0].entityId ? ['supplier-a'] : [])
  }
})

test('a recent or soon business query words the 7-day default in the answer language', async () => {
  const cases = [
    { message: 'Which suppliers need payment soon?', code: 'time_window_soon_default', description: '"Soon" means the next 7 days by default; give a date for a narrower window.' },
    { message: 'Which suppliers have recent payments due?', code: 'time_window_recent_default', description: '"Recent" means the next 7 days by default.' },
    { message: '哪些供应商很快需要付款？', code: 'time_window_soon_default', description: '“很快”按产品默认的未来 7 天窗口解释；可指定更精确日期。' },
    { message: '最近哪些供应商需要付款？', code: 'time_window_recent_default', description: '“最近”按产品默认的未来 7 天窗口解释。' },
  ]
  for (const { message, code, description } of cases) {
    const english = !/[\u4e00-\u9fff]/.test(message)
    const harness = baseContext('/api/ai-runtime/respond', { message, answerLanguage: english ? 'en-US' : 'zh-CN', activeModuleId: 'srm' })
    await handleAiRuntimeGatewayRoute(harness.ctx)
    const response = harness.result().payload
    assert.equal(response.intent, 'business_query_plan_v1', message)
    assert.equal(response.language, english ? 'en-US' : 'zh-CN', message)
    assert.deepEqual(response.dataLimitations.map((item) => [item.code, item.description]), [[code, description]], message)
    const strings = answerStrings(response)
    if (english) assert.deepEqual(strings.filter((value) => /[\u4e00-\u9fff]/.test(value)), [], message)
    else assert.ok(strings.includes(description) && strings.includes('查询限制'), message)
  }
})
