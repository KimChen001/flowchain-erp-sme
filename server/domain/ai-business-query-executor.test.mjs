import test from 'node:test'
import assert from 'node:assert/strict'
import { emptyBusinessQueryPlan } from './ai-business-query-plan.mjs'
import { executeBusinessQueryPlan } from './ai-business-query-executor.mjs'
import { assertReadOnlyGoalRegistry, goalDefinition } from './ai-business-goal-registry.mjs'
import { buildBusinessQueryResponseV2 } from './ai-business-query-response.mjs'
import { buildSupplierActionSummaries } from './supplier-action-summary-read-service.mjs'

const summary = {
  supplier: { id: 's1', name: 'Supplier One', displayName: 'Supplier One' },
  payment: { state: 'confirmed', dueCount: 1, dueAmount: 100, overdueCount: 1, overdueAmount: 100, readyCount: 0, blockedCount: 1, blocks: [{ payableId: 'p1', reason: 'invoice_disputed' }] },
  invoice: { state: 'confirmed', openCount: 1, mismatchCount: 1, disputedCount: 1, missingEvidenceCount: 0 },
  procurement: { state: 'confirmed_zero', openPoCount: 0, overduePoCount: 0, overduePoIds: [], unreceivedPoCount: 0 },
  receiving: { state: 'confirmed_zero', exceptionCount: 0, rejectedQuantity: 0, pendingEvidenceCount: 0 },
  rfq: { state: 'confirmed_zero', awaitingResponseCount: 0, expiredCount: 0 },
  reconciliation: { state: 'hidden', unreconciledPaymentCount: null, blockingExceptionCount: null },
  dataQuality: { incompleteRecordCount: 0, limitations: ['bank_reconciliation_hidden'] },
  priority: { level: 'high', score: 50, reasons: [], algorithmVersion: 'supplier-action-priority-v1' },
  recommendedActions: ['review_payment_blocks'],
  evidence: [{ type: 'payable_obligation', id: 'p1', label: 'PAY-1' }],
}

const summaryService = { read: async () => ({ items: [summary], recordValiditySummary: { validCount: 1, incompleteCount: 0, invalidCount: 0, hiddenCount: 1, unavailable: false }, fieldVisibility: { amounts: true, partner: true }, sourceStatus: {} }) }

test('executor uses closed read-only registry and stable goal order', async () => {
  assert.equal(assertReadOnlyGoalRegistry(), true)
  const plan = emptyBusinessQueryPlan({
    scope: { mode: 'all' },
    goals: ['supplier_invoice_exceptions', 'supplier_payment_blocks', 'supplier_payables_due'],
  })
  const pack = await executeBusinessQueryPlan(plan, { summaryService, timezone: 'Asia/Shanghai' })
  assert.deepEqual(pack.sections.map((section) => section.goal), ['supplier_payables_due', 'supplier_payment_blocks', 'supplier_invoice_exceptions'])
  assert.deepEqual(pack.sections[0].counts, { due: 1, overdue: 1, ready: 0, blocked: 1 })
  assert.equal(pack.sections[1].rows[0].blocks[0].reason, 'invoice_disputed')
  assert.deepEqual(pack.executedTools, ['getSupplierPaymentSummary', 'getSupplierPaymentBlocks', 'getSupplierInvoiceExceptions'])
})

test('hidden state remains hidden and amount redaction is retained', async () => {
  const hiddenSummary = structuredClone(summary)
  hiddenSummary.payment = { ...hiddenSummary.payment, state: 'hidden', dueCount: null, dueAmount: null, overdueCount: null, overdueAmount: null, readyCount: null, blockedCount: null, blocks: [] }
  const service = { read: async () => ({ items: [hiddenSummary], fieldVisibility: { amounts: false, partner: true }, sourceStatus: {} }) }
  const pack = await executeBusinessQueryPlan(emptyBusinessQueryPlan({ goals: ['supplier_payables_due'] }), { summaryService: service })
  assert.equal(pack.sections[0].state, 'hidden')
  assert.equal(pack.sections[0].counts.due, null)
  assert.equal(pack.sections[0].amounts.due, null)
})

test('clarification plans do not execute read tools', async () => {
  let called = false
  const plan = emptyBusinessQueryPlan({ clarificationNeeded: true, clarificationQuestion: '哪一家供应商？', ambiguities: ['supplier_scope_unspecified'] })
  const pack = await executeBusinessQueryPlan(plan, { summaryService: { read: async () => { called = true; return { items: [] } } } })
  assert.equal(called, false)
  assert.deepEqual(pack.executedTools, [])
  assert.equal(pack.clarification.needed, true)
})

test('registry contains no write tools', () => {
  for (const goal of ['supplier_payables_due', 'supplier_payment_blocks', 'supplier_priority', 'supplier_bank_reconciliation_exceptions']) {
    const definition = goalDefinition(goal)
    assert.equal(definition.mode, 'read')
    assert.equal(definition.writesBusinessData, false)
    assert.doesNotMatch(definition.tool, /create|post|approve|execute|modify/i)
  }
})

test('unavailable source is not aggregated as confirmed zero when scope has no rows', async () => {
  const plan = emptyBusinessQueryPlan({ goals: ['supplier_payables_due'] })
  const pack = await executeBusinessQueryPlan(plan, {
    summaryService: { read: async () => ({
      items: [],
      recordValiditySummary: { validCount: 0, incompleteCount: 0, invalidCount: 0, hiddenCount: 0, unavailable: true },
      fieldVisibility: {},
      sourceStatus: { available: { payables: false }, visible: { payables: true } },
    }) },
  })
  assert.equal(pack.sections[0].state, 'unavailable')
  assert.deepEqual(pack.sections[0].counts, {})
})


test('unsupported filters ask for clarification without executing a broader query', async () => {
  let reads = 0
  const pack = await executeBusinessQueryPlan(emptyBusinessQueryPlan({ filters: { statuses: ['draft'] } }), { summaryService: { read: async () => { reads++; return { items: [] } } } })
  assert.equal(reads, 0)
  assert.equal(pack.clarification.needed, true)
  assert.match(pack.clarification.questionEn, /not supported/)
})

test('priority ranking applies a stable limit and hides unrelated zero-result suppliers', async () => {
  const lower = { ...structuredClone(summary), supplier: { id: 's2' }, priority: { score: 1, level: 'low' } }
  const pack = await executeBusinessQueryPlan(emptyBusinessQueryPlan({ goals: ['supplier_priority'], ranking: { enabled: true, limit: 1 } }), { summaryService: { read: async () => ({ items: [lower, summary] }) } })
  assert.deepEqual(pack.sections[0].rows.map(row => row.supplier.id), ['s1'])
})


test('healthy invoices do not appear as exceptions or leak into follow-up evidence', async () => {
  const healthy = structuredClone(summary)
  healthy.invoice = { state: 'confirmed', openCount: 1, mismatchCount: 0, disputedCount: 0, missingEvidenceCount: 0 }
  const pack = await executeBusinessQueryPlan(emptyBusinessQueryPlan({ goals: ['supplier_invoice_exceptions'] }), { summaryService: { read: async () => ({ items: [healthy] }) } })
  assert.equal(pack.sections[0].state, 'confirmed_zero')
  assert.deepEqual(pack.sections[0].rows, [])
  assert.deepEqual(pack.evidence, [])
})


test('a typed name never selects a restricted supplier, while its id still does', async () => {
  const restricted = { ...structuredClone(summary), supplier: { id: 's9', code: 'SUP-9', name: null, displayName: null, fieldVisibility: { partner: false } } }
  // A summary that still carries a placeholder name is matched the same way.
  const placeholder = { ...structuredClone(summary), supplier: { id: 's8', name: null, displayName: '受限供应商', fieldVisibility: { partner: false } } }
  const service = { read: async () => ({ items: [summary, restricted, placeholder] }) }
  const scoped = (scope) => executeBusinessQueryPlan(emptyBusinessQueryPlan({ goals: ['supplier_payables_due'], scope: { source: 'explicit', ...scope } }), { summaryService: service })
  for (const name of ['Restricted supplier', 'restricted supplier', '受限供应商']) {
    assert.equal((await scoped({ mode: 'single', entityNames: [name] })).scopeSummary.entityCount, 0, name)
  }
  assert.deepEqual((await scoped({ mode: 'single', entityIds: ['s9'] })).sections[0].rows.map((row) => row.supplier.id), ['s9'])
  assert.deepEqual((await scoped({ mode: 'single', entityNames: ['supplier one'] })).sections[0].rows.map((row) => row.supplier.id), ['s1'])
})

// A role without finance.partner_snapshot.read, reading one supplier whose
// payable, purchase orders, invoice and receipt are all evidence.
const restrictedActor = { tenantId: 't1', permissionCodes: new Set(['finance.payable.read', 'finance.supplier_invoice.read', 'finance.settlement.read', 'finance.amounts.read', 'procurement.purchase_order.read', 'receiving.read']) }
const mismatchInvoice = { tenantId: 't1', id: 'inv-a', supplierId: 'a', invoiceNumber: 'INV-A', amount: 100, currency: 'USD', status: 'exception', matchStatus: 'mismatch', relatedPoId: 'PO-A' }
const evidenceRecords = {
  suppliers: [{ tenantId: 't1', id: 'a', code: 'SUP-A', name: 'Supplier A' }],
  invoices: [mismatchInvoice],
  payables: [{ tenantId: 't1', id: 'pay-a', supplierId: 'a', supplierInvoiceId: 'inv-a', supplierInvoice: mismatchInvoice, obligationNumber: 'AP-A', currency: 'USD', outstandingAmount: 100, dueDate: '2026-07-20T00:00:00.000Z', status: 'partially_settled' }],
  purchaseOrders: [
    { tenantId: 't1', id: 'PO-A', supplierId: 'a', status: 'partially_received', expectedDate: '2026-07-01T00:00:00.000Z', lines: [] },
    // An older purchase order that stores the Chinese status.
    { tenantId: 't1', id: 'PO-B', supplierId: 'a', status: '已下发', expectedDate: '2026-07-01T00:00:00.000Z', lines: [] },
  ],
  receiving: [{ tenantId: 't1', id: 'GRN-A', documentNumber: 'GRN-A', supplierId: 'a', poId: 'PO-A', status: 'exception', lines: [{ rejectedQty: 2 }] }],
  settlements: [], rfqs: [], bankExceptions: [],
}
const restrictedService = { read: async ({ timeWindow, filters }) => buildSupplierActionSummaries({ records: evidenceRecords, actor: restrictedActor, timeWindow, filters, now: new Date('2026-07-24T00:00:00.000Z') }) }
const rawStatus = /partially_settled|partially_received|已下发|^exception$/

// The strings the assistant panel shows for this answer.
function answerStrings(response) {
  return [
    response.conclusion.title, response.conclusion.summary,
    ...response.keyEvidence.flatMap((item) => [item.label, item.entityLabel, item.summary, item.status, item.sourceLabel]),
    ...response.navigationLinks.map((link) => link.label),
    response.businessQuery.scopeBadge, ...response.businessQuery.goalLabels,
    ...response.businessQuery.sectionCards.flatMap((card) => [card.label, card.stateLabel, ...card.rows.map((row) => row.supplier?.displayName)]),
    ...response.resolvedContext.entityRefs.map((ref) => ref.entityLabel),
  ].filter(Boolean)
}

test('evidence statuses and a restricted supplier are labelled in the answer language, with the codes kept', async () => {
  const plan = emptyBusinessQueryPlan({ goals: ['supplier_payment_blocks', 'supplier_overdue_purchase_orders', 'supplier_invoice_exceptions', 'supplier_receiving_exceptions'], scope: { mode: 'single', entityIds: ['a'], source: 'explicit' } })
  const pack = await executeBusinessQueryPlan(plan, { summaryService: restrictedService })
  assert.equal(pack.scopeSummary.supplier.fieldVisibility.partner, false)
  const expected = {
    'en-US': { restricted: 'Restricted supplier', status: { 'pay-a': 'Partially settled', 'PO-A': 'Partially received', 'PO-B': 'Issued', 'inv-a': 'Exception', 'GRN-A': 'Exception' }, blocked: 'Payment is blocked; see the block reasons.' },
    'zh-CN': { restricted: '受限供应商', status: { 'pay-a': '部分结算', 'PO-A': '部分收货', 'PO-B': '已下达', 'inv-a': '异常', 'GRN-A': '异常' }, blocked: '付款被阻断，请查看阻断原因。' },
  }
  for (const [answerLanguage, copy] of Object.entries(expected)) {
    const response = buildBusinessQueryResponseV2(pack, { plan }, { answerLanguage, message: 'Supplier A?' })
    const evidence = Object.fromEntries(response.keyEvidence.map((item) => [item.entityId, item]))
    assert.deepEqual(Object.fromEntries(Object.entries(evidence).map(([id, item]) => [id, item.status])), copy.status, answerLanguage)
    assert.deepEqual(Object.fromEntries(Object.entries(evidence).map(([id, item]) => [id, item.statusCode])), { 'pay-a': 'partially_settled', 'PO-A': 'partially_received', 'PO-B': '已下发', 'inv-a': 'exception', 'GRN-A': 'exception' })
    assert.equal(evidence['pay-a'].summary, copy.blocked)
    assert.deepEqual(response.keyEvidence.map((item) => item.rank), response.keyEvidence.map((_, index) => index))
    assert.equal(response.businessQuery.scopeBadge, copy.restricted)
    assert.deepEqual(response.resolvedContext.entityRefs, [{ entityType: 'supplier', entityId: 'a', entityLabel: copy.restricted }])
    const rows = response.businessQuery.sectionCards.flatMap((card) => card.rows)
    assert.ok(rows.length > 0)
    assert.ok(rows.every((row) => row.supplier.displayName === copy.restricted && row.supplier.name === null))
    const strings = answerStrings(response)
    assert.deepEqual(strings.filter((value) => rawStatus.test(value)), [], answerLanguage)
    if (answerLanguage === 'en-US') assert.deepEqual(strings.filter((value) => /[\u4e00-\u9fff]/.test(value)), [])
    else assert.ok(!strings.includes('Restricted supplier'))
  }
})

test('an unlisted status code is shown as words, never as the code', async () => {
  const unlisted = { ...structuredClone(summary), evidence: [{ type: 'payable_obligation', id: 'p1', label: 'PAY-1', status: 'awaiting_bank_file' }, { type: 'receiving_doc', id: 'g1', label: 'GRN-1', status: '待质检' }] }
  const pack = await executeBusinessQueryPlan(emptyBusinessQueryPlan({ goals: ['supplier_payables_due'] }), { summaryService: { read: async () => ({ items: [unlisted] }) } })
  const statuses = (answerLanguage) => buildBusinessQueryResponseV2(pack, {}, { answerLanguage }).keyEvidence.map((item) => [item.statusCode, item.status])
  assert.deepEqual(statuses('en-US'), [['awaiting_bank_file', 'Awaiting bank file'], ['待质检', 'Other status']])
  assert.deepEqual(statuses('zh-CN'), [['awaiting_bank_file', '其他状态'], ['待质检', '待质检']])
})
