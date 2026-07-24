import test from 'node:test'
import assert from 'node:assert/strict'
import { emptyBusinessQueryPlan } from './ai-business-query-plan.mjs'
import { executeBusinessQueryPlan } from './ai-business-query-executor.mjs'
import { assertReadOnlyGoalRegistry, goalDefinition } from './ai-business-goal-registry.mjs'

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
