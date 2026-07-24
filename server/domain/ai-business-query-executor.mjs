import { assertValidBusinessQueryPlan } from './ai-business-query-plan.mjs'
import { assertReadOnlyGoalRegistry, goalDefinition, goalsInStableOrder } from './ai-business-goal-registry.mjs'
import { resolveBusinessTimeWindow } from './ai-business-time-window.mjs'

const text = (value) => String(value ?? '').trim()
const stateOrder = ['confirmed', 'confirmed_zero', 'incomplete', 'hidden', 'unavailable']

const sectionSource = Object.freeze({ payment: 'payables', invoice: 'invoices', procurement: 'purchaseOrders', receiving: 'receiving', rfq: 'rfqs', reconciliation: 'bankReconciliation' })

function aggregateState(rows, section, sourceStatus = {}) {
  const source = sectionSource[section]
  if (source && sourceStatus.available?.[source] === false) return 'unavailable'
  if (source && sourceStatus.visible?.[source] === false) return 'hidden'
  const states = rows.map((row) => row?.[section]?.state).filter(Boolean)
  if (states.includes('confirmed')) return 'confirmed'
  if (states.includes('incomplete')) return 'incomplete'
  if (states.includes('hidden')) return 'hidden'
  if (states.includes('unavailable')) return 'unavailable'
  return 'confirmed_zero'
}

function scopeRows(items, scope) {
  if (scope.mode === 'all') return items
  const ids = new Set(scope.entityIds.map(text))
  const names = new Set(scope.entityNames.map((item) => text(item).toLowerCase()))
  return items.filter((row) => ids.has(text(row.supplier.id)) || names.has(text(row.supplier.name || row.supplier.displayName).toLowerCase()))
}

function countsFor(section, row) {
  if (!row) return {}
  if (section === 'payment') return { due: row.dueCount, overdue: row.overdueCount, ready: row.readyCount, blocked: row.blockedCount }
  if (section === 'invoice') return { open: row.openCount, mismatch: row.mismatchCount, disputed: row.disputedCount, missingEvidence: row.missingEvidenceCount }
  if (section === 'procurement') return { openPo: row.openPoCount, overduePo: row.overduePoCount, unreceivedPo: row.unreceivedPoCount }
  if (section === 'receiving') return { exceptions: row.exceptionCount, pendingEvidence: row.pendingEvidenceCount }
  if (section === 'rfq') return { awaitingResponse: row.awaitingResponseCount, expired: row.expiredCount }
  if (section === 'reconciliation') return { unreconciledPayments: row.unreconciledPaymentCount, blockingExceptions: row.blockingExceptionCount }
  if (section === 'dataQuality') return { incompleteRecords: row.incompleteRecordCount }
  return {}
}

function amountsFor(section, row) {
  if (section !== 'payment' || !row) return {}
  return { due: row.dueAmount, overdue: row.overdueAmount }
}

function sectionRows(rows, section) {
  if (section === 'comparison' || section === 'priority') return rows.map((row) => ({ supplier: row.supplier, priority: row.priority, payment: row.payment, invoice: row.invoice, procurement: row.procurement, receiving: row.receiving, reconciliation: row.reconciliation }))
  if (section === 'followups') return rows.map((row) => ({ supplier: row.supplier, recommendedActions: row.recommendedActions, priority: row.priority }))
  if (section === 'inventory') return rows.map((row) => ({ supplier: row.supplier, state: 'unavailable', limitations: ['inventory_supplier_projection_unavailable'] }))
  return rows.map((row) => ({ supplier: row.supplier, ...row[section] }))
}

function buildSection(goal, definition, rows, sourceStatus) {
  const section = definition.section
  const state = section === 'comparison' || section === 'priority' || section === 'followups'
    ? rows.length ? 'confirmed' : 'confirmed_zero'
    : section === 'inventory' ? 'unavailable' : aggregateState(rows, section, sourceStatus)
  const counts = rows.reduce((output, row) => {
    for (const [key, value] of Object.entries(countsFor(section, row[section]))) {
      if (value === null || value === undefined) output[key] = null
      else if (output[key] !== null) output[key] = (output[key] || 0) + value
    }
    return output
  }, {})
  const amounts = rows.reduce((output, row) => {
    for (const [key, value] of Object.entries(amountsFor(section, row[section]))) {
      if (value === null || value === undefined) output[key] = null
      else if (output[key] !== null) output[key] = (output[key] || 0) + value
    }
    return output
  }, {})
  const evidence = rows.flatMap((row) => row.evidence || []).slice(0, 50)
  const limitations = [...new Set(rows.flatMap((row) => row.dataQuality?.limitations || []))]
  return { goal, state, conclusionCode: `${goal}:${state}`, counts, amounts, rows: sectionRows(rows, section), evidence, limitations }
}

function scopeSummary(plan, rows) {
  const label = plan.scope.mode === 'all'
    ? '全部供应商'
    : plan.scope.mode === 'previous_result'
      ? '上一轮结果'
      : rows.length === 1 ? rows[0].supplier.displayName : `${rows.length} 家供应商`
  return { entityType: plan.scope.entityType, mode: plan.scope.mode, entityCount: rows.length, label }
}

export async function executeBusinessQueryPlan(planCandidate, context = {}) {
  const plan = assertValidBusinessQueryPlan(planCandidate)
  assertReadOnlyGoalRegistry()
  if (plan.clarificationNeeded) return {
    plan,
    scopeSummary: { entityType: plan.scope.entityType, mode: plan.scope.mode, entityCount: 0, label: '需要澄清' },
    sections: [],
    validitySummary: null,
    evidence: [],
    limitations: plan.ambiguities,
    availableFollowups: [],
    fieldVisibility: {},
    sourceStatus: {},
    clarification: { needed: true, question: plan.clarificationQuestion },
    executedTools: [],
  }
  const timeWindow = resolveBusinessTimeWindow(plan.filters.timeWindow, { now: context.now || new Date(), timezone: context.timezone || 'UTC', expression: context.message || '' })
  if (!context.summaryService || typeof context.summaryService.read !== 'function') throw new Error('summaryService.read is required')
  const summary = await context.summaryService.read({ timeWindow }, context)
  const rows = scopeRows(summary.items || [], plan.scope)
  const sections = []
  const executedTools = []
  const failures = []
  for (const goal of goalsInStableOrder(plan.goals)) {
    const definition = goalDefinition(goal)
    if (!definition) throw new Error(`Unknown goal: ${goal}`)
    try {
      sections.push(buildSection(goal, definition, rows, summary.sourceStatus))
      executedTools.push(definition.tool)
    } catch (error) {
      sections.push({ goal, state: 'unavailable', conclusionCode: `${goal}:execution_failed`, counts: {}, amounts: {}, rows: [], evidence: [], limitations: ['independent_goal_execution_failed'] })
      failures.push({ goal, reason: error?.code || 'execution_failed' })
    }
  }
  return {
    plan,
    scopeSummary: scopeSummary(plan, rows),
    sections,
    validitySummary: summary.recordValiditySummary,
    evidence: rows.flatMap((row) => row.evidence || []).slice(0, 100),
    limitations: [...new Set([...timeWindow.limitations, ...rows.flatMap((row) => row.dataQuality?.limitations || []), ...failures.map((row) => `${row.goal}:${row.reason}`)])],
    availableFollowups: ['查看付款阻断', '查看延期采购订单', '查看发票差异', '查看缺失证据'],
    fieldVisibility: summary.fieldVisibility,
    sourceStatus: summary.sourceStatus,
    timeWindow,
    clarification: { needed: false, question: null },
    executedTools: [...new Set(executedTools)],
  }
}

export function resultPackAudit(pack) {
  return {
    selectedGoals: pack.plan.goals,
    scopeMode: pack.plan.scope.mode,
    entityCount: pack.scopeSummary.entityCount,
    executedTools: pack.executedTools,
    resultStates: pack.sections.map((section) => section.state).sort((a, b) => stateOrder.indexOf(a) - stateOrder.indexOf(b)),
  }
}
