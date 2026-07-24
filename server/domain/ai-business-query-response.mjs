const GOAL_LABELS = Object.freeze({
  supplier_payables_due: '需要付款', supplier_payables_overdue: '逾期付款', supplier_payment_blocks: '付款阻断', supplier_payment_readiness: '付款准备度',
  supplier_operational_followups: '其他跟进', supplier_priority: '优先级', supplier_comparison: '供应商比较', supplier_invoice_exceptions: '发票差异',
  supplier_receiving_exceptions: '收货异常', supplier_overdue_purchase_orders: '延期 PO', supplier_rfq_followups: 'RFQ 跟进', supplier_missing_evidence: '缺失证据',
  supplier_bank_reconciliation_exceptions: '银行核对异常', inventory_risks: '库存风险', procurement_exceptions: '采购异常', data_quality_limitations: '数据质量限制',
})
const STATE_LABELS = Object.freeze({ confirmed: '已确认', confirmed_zero: '确认没有', incomplete: '数据不完整', hidden: '无权限', unavailable: '数据不可用' })
const text = (value) => String(value ?? '').trim()

function severity(sections) {
  if (sections.some((section) => section.state === 'incomplete' || section.state === 'unavailable')) return 'warning'
  if (sections.some((section) => section.state === 'confirmed' && /blocks|overdue|exceptions|priority|comparison/.test(section.goal))) return 'risk'
  return 'info'
}

function evidenceItem(item, index) {
  const entityType = text(item.entityType || item.type)
  const entityId = text(item.entityId || item.id)
  const moduleId = entityType === 'purchase_order' ? 'procurement' : entityType === 'receiving_doc' ? 'procurement:receiving' : entityType === 'supplier_invoice' || entityType === 'payable_obligation' ? 'finance' : 'overview'
  return {
    id: entityId || `business-query-evidence-${index + 1}`,
    label: text(item.label || item.entityLabel || entityId || '业务证据'),
    entityLabel: text(item.entityLabel || item.label || entityId || '业务证据'),
    entityType,
    entityId,
    moduleId,
    evidenceType: entityType || 'business_record',
    summary: text(item.summary || item.status || '来自已授权确定性 Read Service。'),
    status: text(item.status),
    severity: 'info',
    sourceLabel: '确定性业务读取',
  }
}

export function buildBusinessQueryResponseV2(pack, planner = {}, request = {}) {
  const clarification = Boolean(pack.clarification?.needed)
  const sections = pack.sections || []
  const tone = clarification ? 'warning' : severity(sections)
  const confirmed = sections.filter((section) => section.state === 'confirmed').length
  const limited = sections.filter((section) => ['incomplete', 'hidden', 'unavailable'].includes(section.state)).length
  const conclusion = clarification
    ? { title: '需要补充查询范围', summary: pack.clarification.question, severity: 'warning', confidence: 'low' }
    : {
        title: `${pack.scopeSummary.label}：已完成跨模块只读检查`,
        summary: `已按 ${sections.length} 个业务目标读取授权数据；${confirmed} 个分区有已确认事项${limited ? `，${limited} 个分区存在权限、完整性或可用性限制` : ''}。`,
        severity: tone,
        confidence: planner.plan?.confidence >= 0.8 ? 'high' : planner.plan?.confidence >= 0.5 ? 'medium' : 'low',
      }
  const evidence = (pack.evidence || []).slice(0, 12).map(evidenceItem)
  const limitations = [...new Set(pack.limitations || [])].map((item) => ({ label: '查询限制', description: text(item), severity: 'warning', consequence: '该限制不会被解释为业务数量 0。' }))
  const goalLabels = (planner.plan?.goals || sections.map((section) => section.goal)).map((goal) => GOAL_LABELS[goal] || goal)
  const sectionCards = sections.map((section) => ({
    goal: section.goal,
    label: GOAL_LABELS[section.goal] || section.goal,
    state: section.state,
    stateLabel: STATE_LABELS[section.state] || section.state,
    counts: section.counts,
    amounts: section.amounts,
    rows: section.rows,
    limitations: section.limitations,
  }))
  return {
    version: 'v2',
    responseId: `AIQ-${Date.now()}-${Math.abs(text(request.message || request.question).length * 31)}`,
    query: text(request.message || request.question),
    intent: clarification ? 'business_query_clarification' : 'business_query_plan_v1',
    runtimeModeLabel: '业务事实读取 · 确定性执行 · 证据支持',
    scope: { module: text(request.activeModuleId || request.moduleId || 'overview'), entityType: 'supplier', entityId: pack.scopeSummary.entityCount === 1 ? pack.sections?.[0]?.rows?.[0]?.supplier?.id || '' : '', timeRange: pack.timeWindow?.interpretation || '', dataScopeLabel: '当前工作区授权数据' },
    conclusion,
    keyEvidence: evidence,
    businessImpact: sectionCards.map((section) => ({ area: section.label, impact: section.stateLabel, severity: section.state === 'confirmed' ? 'warning' : section.state === 'confirmed_zero' ? 'success' : 'warning', explanation: section.state === 'confirmed_zero' ? '权威数据足以确认当前没有符合条件的事项。' : section.state === 'hidden' ? '当前角色无权查看该分区，不能解释为 0。' : section.state === 'unavailable' ? '数据源或 Capability 不可用，不能解释为 0。' : section.state === 'incomplete' ? '存在不完整记录，未计入正式数量。' : '已由确定性 Read Service 确认。' })),
    recommendedActions: clarification ? [] : (pack.availableFollowups || []).slice(0, 4).map((label, index) => ({ label, description: '继续进行只读查询，不创建或执行正式业务动作。', actionType: 'follow_up_query', priority: index === 0 ? 'high' : 'medium', reviewRequired: false })),
    navigationLinks: evidence.filter((item) => item.entityId).slice(0, 7).map((item) => ({ label: `查看 ${item.entityLabel}`, moduleId: item.moduleId, entityType: item.entityType, entityId: item.entityId, returnLabel: '返回 AI 助手', returnTo: 'ai-assistant', source: 'business-query' })),
    dataLimitations: limitations,
    reviewCards: [],
    safetyBoundaries: ['只读', '不创建 ActionProposal', '不执行付款', '不修改业务数据', '业务事实来自确定性 Read Service'],
    followUpQuestions: pack.availableFollowups || [],
    followUpSuggestions: (pack.availableFollowups || []).slice(0, 4).map((label) => ({ label, prompt: label, intentHint: 'business_query_followup', requiresReview: false })),
    resolvedContext: { resolvedFrom: pack.plan?.scope?.source === 'previous_result' ? 'previousResponse' : pack.plan?.scope?.source === 'current_context' ? 'activePage' : 'currentMessage', entityRefs: [], intentCarryOver: 'business_query_plan_v1', confidence: planner.plan?.confidence >= 0.8 ? 'high' : 'medium' },
    sourceSummary: [],
    readinessSignals: [],
    generatedAt: new Date().toISOString(),
    dataScopeLabel: '当前工作区授权数据',
    businessQuery: {
      planningVersion: planner.plan?.planningVersion || 'business-query-plan-v1',
      plannerStatus: planner.plannerStatus || 'ready',
      scopeBadge: pack.scopeSummary.label,
      scopeMode: pack.scopeSummary.mode,
      goalLabels,
      sectionCards,
      clarification: pack.clarification,
      fieldVisibility: pack.fieldVisibility,
      validitySummary: pack.validitySummary,
    },
  }
}

export function buildLegacyBusinessQueryChatResponse(responseV2, planner = {}) {
  return {
    provider: planner.provider || 'local',
    providerStatus: planner.plannerStatus || 'ready',
    plannerStatus: planner.plannerStatus || 'ready',
    planningVersion: planner.plan?.planningVersion || 'business-query-plan-v1',
    mode: 'business_query_plan',
    status: responseV2.intent === 'business_query_clarification' ? 'clarification' : 'ready',
    intent: { name: responseV2.intent, confidence: planner.plan?.confidence || 0.5, slots: {} },
    message: responseV2.conclusion.summary,
    content: responseV2.conclusion.summary,
    cards: [{ type: 'ai_response_v2', title: responseV2.conclusion.title, data: responseV2 }],
    evidence: responseV2.keyEvidence,
    usedWeb: false,
  }
}
