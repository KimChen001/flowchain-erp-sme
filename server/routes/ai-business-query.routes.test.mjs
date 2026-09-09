import test from 'node:test'
import assert from 'node:assert/strict'
import { handleAiRuntimeGatewayRoute } from './ai-runtime-gateway.routes.mjs'
import { handleAiRoute } from './ai.routes.mjs'

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
