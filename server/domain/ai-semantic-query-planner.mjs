import {
  BUSINESS_QUERY_GOALS,
  emptyBusinessQueryPlan,
  validateBusinessQueryPlan,
} from './ai-business-query-plan.mjs'
import { detectBusinessTimeWindow } from './ai-business-time-window.mjs'
import { callConfiguredProvider, providerRuntimeConfig } from './ai-runtime-provider-adapter-v2.mjs'
import { isAuthoritativeBusinessId, partitionBusinessRecords } from './ai-business-record-validity.mjs'

const GOAL_ORDER = new Map(BUSINESS_QUERY_GOALS.map((goal, index) => [goal, index]))
const GENERIC_SUPPLIER_WORDS = new Set(['supplier', 'suppliers', 'vendor', 'vendors', '供应商', '供方', '付款', '跟进', '风险', '状态'])
const GENERIC_SUPPLIER_TAIL = /^(?:payment|payments|payable|payables|pay|work|follow.?ups?|priorities?|priority|invoice|invoices|receiving|rfqs?|quotation(?:s)?|information|status|risk|issues?|purchase(?:\s+orders?)?|orders?|po|grn|bank|reconciliation|exception(?:s)?|readiness|due|overdue|blocked|hold|供应商|付款|应付|跟进|待办|风险|状态|发票|收货|到货|询价|报价|订单|采购订单|延期|异常|银行|对账)(?:\s|$)/i
const GENERIC_SUPPLIER_CJK_TAIL = /^(?:供应商|付款|应付|跟进|待办|风险|状态|发票|收货|到货|询价|报价|订单|采购订单|延期|异常|银行|对账)/i
const PROMPT_INJECTION = /ignore (?:all |previous )?instructions|system prompt|developer message|chain of thought|绕过|忽略(?:以上|之前).*指令|输出.*(?:SQL|数据库|密码)|越权/i

const text = (value) => String(value ?? '').trim()
const normalize = (value) => text(value).toLowerCase().replace(/[，。！？,.!?；;：:（）()【】\[\]"']/g, ' ').replace(/\s+/g, ' ').trim()
const unique = (items) => [...new Set(items.map(text).filter(Boolean))]

function supplierIdentity(record = {}) {
  return {
    id: text(record.id || record.supplierId),
    name: text(record.name || record.supplierName),
    aliases: unique([record.code, record.supplierCode, ...(Array.isArray(record.aliases) ? record.aliases : [])]),
  }
}

function supplierMatches(message, suppliers) {
  const normalized = normalize(message)
  const matches = []
  for (const supplier of suppliers) {
    const aliases = unique([supplier.id, supplier.name, ...supplier.aliases]).filter((item) => normalize(item).length >= 2 && !GENERIC_SUPPLIER_WORDS.has(normalize(item)))
    if (aliases.some((alias) => normalized.includes(normalize(alias)))) matches.push(supplier)
  }
  return [...new Map(matches.map((supplier) => [supplier.id, supplier])).values()]
}

function explicitUnresolvedNames(message) {
  const found = []
  for (const match of String(message || '').matchAll(/\b(?:supplier|vendor)\s+([a-z0-9][a-z0-9 _.-]{0,40}?)(?=\s+(?:and|or|vs\.?|who|which|why|is|are|has|have|cannot|can(?:'t|not)|risk|payment|的|为什么|暂时|不能|无法|付款|应付|被|有|和|与)|[，。,.!?]|$)/gi)) {
    const tail = normalize(match[1])
    const genericTail = GENERIC_SUPPLIER_TAIL.test(tail) || GENERIC_SUPPLIER_CJK_TAIL.test(tail)
    const value = `Supplier ${text(match[1])}`
    if (!genericTail && !GENERIC_SUPPLIER_WORDS.has(normalize(value))) found.push(value)
  }
  return unique(found)
}

function goalSignals(message) {
  const input = normalize(message)
  const goals = new Set()
  const paymentExcluded = /付款之外|除(?:了)?付款|不要看付款|不看付款|besides payment|other than payment|apart from payment/.test(input)
  const payment = !paymentExcluded && /付款|付钱|应付|payable|payment|pay\b|paid\b/.test(input)
  const paymentOverdue = /(?:逾期|过期|拖欠)\s*(?:的\s*)?(?:付款|应付)|(?:付款|应付)\s*(?:已|已经)?\s*(?:逾期|过期|拖欠)|overdue\s+(?:payments?|payables?)\b|(?:payments?|payables?)\s+(?:are\s+)?(?:overdue|past\s+due)\b(?!\s+(?:pos?\b|purchase\s+orders?\b|orders?\b))|past\s+due\s+(?:payments?|payables?)\b/.test(input)
  const blocked = /阻断|不能付|无法付|暂时不能|卡在|卡住|blocked|blocks?\b|cannot\s+(?:pay|be\s+paid)|can.?t\s+(?:pay|be\s+paid)|cannot\b[^.!?]{0,50}\bbe\s+paid|can.?t\b[^.!?]{0,50}\bbe\s+paid|hold|争议/.test(input)
  const invoice = /发票|invoice|三单|three.way|差异|mismatch|dispute/.test(input)
  const receiving = /收货|到货|验收|拒收|receiv|grn/.test(input)
  const purchaseOrder = /\bpos?\b|采购订单|订单拖期|延期订单|purchase orders?/.test(input)
  const rfq = /\brfqs?\b|询价|报价|quotation/.test(input)
  const bank = /银行|流水|核对|对账异常|bank|reconcil/.test(input)
  const evidence = /证据|附件|缺失|不完整|evidence|missing/.test(input)
  const followup = /跟进|处理|待办|还有什么|除此之外|另外|follow.?up|what else|other issue/.test(input)
  const compare = /比较|对比|谁(?:的)?[^，。,.!?]{0,12}更|哪个更|两家.*谁|谁应该先|\bvs\.?\b|compare|higher risk|\brank\b/.test(input)
  const priority = /优先|必须处理|先处理|风险更高|priority|priorities|urgent|attention|highest risk|\brank\b/.test(input)

  if (payment) goals.add(paymentOverdue ? 'supplier_payables_overdue' : 'supplier_payables_due')
  if (payment) goals.add('supplier_payment_readiness')
  if (blocked) goals.add('supplier_payment_blocks')
  if (invoice) goals.add('supplier_invoice_exceptions')
  if (receiving) goals.add('supplier_receiving_exceptions')
  if (purchaseOrder) goals.add('supplier_overdue_purchase_orders')
  if (rfq) goals.add('supplier_rfq_followups')
  if (bank) goals.add('supplier_bank_reconciliation_exceptions')
  if (evidence) goals.add('supplier_missing_evidence')
  if (followup || paymentExcluded) goals.add('supplier_operational_followups')
  if (/怎么样|整体情况|综合情况|how (?:is|are)|overview|overall status/.test(input) && /supplier|vendor|供应商/.test(input)) {
    goals.add('supplier_operational_followups')
    goals.add('supplier_priority')
  }
  if (compare) {
    goals.add('supplier_comparison')
    goals.add('supplier_priority')
  }
  if (priority || (/(?:本周|this week|current week)/.test(input) && /处理|付款|跟进|attention|work|risk/.test(input))) goals.add('supplier_priority')
  if (/库存|inventory|stock/.test(input)) goals.add('inventory_risks')
  if (/采购异常|procurement exception/.test(input)) goals.add('procurement_exceptions')
  if (/空对象|空记录|内容为空|为什么.*1\s*条|数据质量|不完整数据|placeholder record|empty (?:record|row|object)|data quality/.test(input)) goals.add('data_quality_limitations')
  return [...goals].sort((a, b) => GOAL_ORDER.get(a) - GOAL_ORDER.get(b)).slice(0, 8)
}

function allScopeSignal(message) {
  return /哪些|所有|全部|有哪些|谁(?:需要|要|有|的)|供应商们|\bsuppliers\b|\bvendors\b|which supplier|which payment|all supplier|all vendor|who needs|付款之外|除(?:了)?付款|不要看付款|供应商除付款|没有.*付款|同时.*供应商|供应商.*(?:付款|应付|延期|发票|收货|RFQ|询价|银行|订单|风险)|(?:supplier|vendor)\s*(?:付款|应付|跟进|风险|发票|收货|询价|报价|订单|采购订单|延期|异常|银行|对账)|supplier\s+(?:payments?|payables?|invoices?|receiving|rfqs?|work|follow-ups?|priorities)|vendor\s+(?:payments?|payables?|invoices?|receiving|rfqs?|work|follow-ups?|priorities)|(?:payments?|payables?|invoices?|purchase orders?|rfqs?|receiving issues?|bank reconciliation).*(?:blocked|due|late|exception|issue|follow-up|unreconciled)|by supplier|空对象|空记录|内容为空|显示.*\d+\s*条|empty (?:record|row|object)|placeholder record|data quality/i.test(message)
}

function previousScopeSignal(message) {
  return /这些|上述|刚才(?:的|那些)|它们|这几家|上一轮结果|those|these|previous result|them\b/i.test(message)
}

function currentScopeSignal(message) {
  return /这个供应商|该供应商|当前供应商|this supplier|current supplier/i.test(message)
}

function safeReferences(value) {
  const refs = Array.isArray(value) ? value : value?.entityRefs || value?.suppliers || []
  return refs.slice(0, 10).map((item) => typeof item === 'string' ? { id: item, name: '' } : {
    id: text(item?.id || item?.entityId || item?.supplierId),
    name: text(item?.name || item?.entityName || item?.supplierName || item?.entityLabel),
  }).filter((item) => isAuthoritativeBusinessId(item.id) || item.name)
}

function resolveScope(message, options = {}) {
  const supplierPartition = partitionBusinessRecords('supplier', options.suppliers || [])
  const suppliers = supplierPartition.validRecords.map(supplierIdentity)
  const matches = supplierMatches(message, suppliers)
  const current = options.currentContext?.entityType === 'supplier'
    ? safeReferences([{ id: options.currentContext.entityId, name: options.currentContext.entityLabel }])
    : []
  const previous = safeReferences(options.previousResult)

  if (previousScopeSignal(message)) {
    if (!previous.length) return { mode: 'previous_result', source: 'clarification', refs: [], ambiguity: 'previous_result_unavailable' }
    return { mode: 'previous_result', source: 'previous_result', refs: previous }
  }
  if (currentScopeSignal(message)) {
    if (current.length) return { mode: 'current_context', source: 'current_context', refs: current }
    if (previous.length === 1) return { mode: 'previous_result', source: 'previous_result', refs: previous }
    return { mode: 'current_context', source: 'clarification', refs: [], ambiguity: 'current_supplier_unavailable' }
  }
  if (matches.length) return { mode: matches.length === 1 ? 'single' : 'set', source: 'explicit', refs: matches }
  const unresolved = explicitUnresolvedNames(message)
  if (unresolved.length) return { mode: unresolved.length === 1 ? 'single' : 'set', source: 'clarification', refs: unresolved.map((name) => ({ id: '', name })), ambiguity: `supplier_not_found:${unresolved.join(', ')}` }
  if (allScopeSignal(message)) return { mode: 'all', source: 'global', refs: [] }
  if (current.length && /供应商|supplier|vendor/i.test(message)) return { mode: 'current_context', source: 'current_context', refs: current }
  return { mode: 'all', source: 'clarification', refs: [], ambiguity: 'supplier_scope_unspecified' }
}

function clarificationFor(reason) {
  if (reason === 'previous_result_unavailable') return '你指的是哪一轮结果中的供应商？请先选择结果或直接提供供应商名称。'
  if (reason === 'current_supplier_unavailable') return '当前页面没有绑定唯一供应商，请提供供应商名称或编号。'
  if (reason?.startsWith('supplier_not_found:')) return `未找到 ${reason.slice('supplier_not_found:'.length)}，请确认供应商名称或编号。`
  if (reason === 'prompt_injection') return '该请求包含不允许的系统或数据访问指令。请改为描述需要查询的业务事实。'
  if (reason === 'no_supported_goal') return '你想查看供应商的付款、订单、收货、发票、RFQ，还是其他风险？'
  return '请说明要查看哪一家供应商，或明确查询全部供应商。'
}

export function buildDeterministicBusinessQueryPlan(input = {}) {
  const message = text(input.message || input.question)
  const goals = goalSignals(message)
  const normalizedMessage = normalize(message)
  const paymentOverdue = /(?:逾期|过期|拖欠)\s*(?:的\s*)?(?:付款|应付)|(?:付款|应付)\s*(?:已|已经)?\s*(?:逾期|过期|拖欠)|overdue\s+(?:payments?|payables?)\b|(?:payments?|payables?)\s+(?:are\s+)?(?:overdue|past\s+due)\b(?!\s+(?:pos?\b|purchase\s+orders?\b|orders?\b))|past\s+due\s+(?:payments?|payables?)\b/.test(normalizedMessage)
  const scope = resolveScope(message, input)
  let ambiguity = scope.ambiguity || null
  if (PROMPT_INJECTION.test(message)) ambiguity = 'prompt_injection'
  if (!goals.length) ambiguity = ambiguity || 'no_supported_goal'
  const clarificationNeeded = Boolean(ambiguity)
  const timeWindow = detectBusinessTimeWindow(message)
  const refs = scope.refs || []
  const comparison = goals.includes('supplier_comparison')
  return emptyBusinessQueryPlan({
    scope: {
      entityType: 'supplier',
      mode: scope.mode,
      entityIds: refs.map((item) => item.id).filter(isAuthoritativeBusinessId),
      entityNames: refs.filter((item) => !isAuthoritativeBusinessId(item.id)).map((item) => item.name).filter(Boolean),
      source: scope.source,
    },
    goals: goals.length ? goals : ['data_quality_limitations'],
    filters: {
      timeWindow,
      dueState: /阻断|blocked|不能付|can't pay|cannot pay/i.test(message) ? ['blocked'] : paymentOverdue ? ['overdue'] : [],
      riskLevels: [], statuses: [], currencies: unique([...message.matchAll(/\b(CNY|USD|EUR|GBP|JPY|HKD)\b/gi)].map((match) => match[1].toUpperCase())),
    },
    grouping: ['supplier'],
    comparison: { enabled: comparison, dimensions: comparison ? ['priority', 'payment_blocks', 'operational_risk', 'data_quality'] : [] },
    ranking: { enabled: goals.includes('supplier_priority') || comparison, limit: 20 },
    ambiguities: ambiguity ? [ambiguity] : [],
    clarificationNeeded,
    clarificationQuestion: clarificationNeeded ? clarificationFor(ambiguity) : null,
    confidence: clarificationNeeded ? 0.35 : scope.source === 'explicit' || scope.source === 'current_context' ? 0.92 : 0.86,
  })
}

export function isComplexBusinessQuery(input = {}) {
  const message = text(input.message || input.question)
  const goals = goalSignals(message)
  return goals.length > 1 || allScopeSignal(message) || previousScopeSignal(message) || /同时|另外|顺便|比较|对比|谁更|本周|月底前|为什么不能|what else|compare|and also/i.test(message)
}

function extractProviderPlan(rawOutput) {
  let candidate = rawOutput
  if (candidate?.conclusion?.summary) candidate = candidate.conclusion.summary
  if (candidate?.output_text) candidate = candidate.output_text
  if (typeof candidate === 'string') {
    const cleaned = candidate.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
    try { return JSON.parse(cleaned) } catch { return null }
  }
  return candidate && typeof candidate === 'object' ? candidate : null
}

function providerInput(input) {
  return {
    task: {
      type: 'business_query_planning',
      message: text(input.message || input.question).slice(0, 2000),
      moduleId: text(input.moduleId).slice(0, 100),
      currentContext: input.currentContext || null,
      previousResult: safeReferences(input.previousResult),
      now: (input.now instanceof Date ? input.now : new Date(input.now || Date.now())).toISOString(),
      timezone: text(input.timezone || 'UTC'),
      allowedGoals: BUSINESS_QUERY_GOALS,
      planningVersion: 'business-query-plan-v1',
    },
    evidencePackage: [],
    safetyPolicy: {
      readOnly: true,
      output: 'strict BusinessQueryPlan JSON only',
      forbidden: ['SQL', 'Prisma models', 'tool names', 'amounts', 'counts', 'business conclusions', 'write actions'],
    },
    responseShape: { schemaId: 'flowchain://schemas/business-query-plan-v1' },
    conversationGrounding: null,
  }
}

export async function planBusinessQuery(input = {}, options = {}) {
  const startedAt = Date.now()
  const env = options.env || process.env
  const deterministicPlan = buildDeterministicBusinessQueryPlan(input)
  const enabled = String(env.FLOWCHAIN_ENABLE_AI_SEMANTIC_PLANNER || '').toLowerCase() === 'true'
  const provider = providerRuntimeConfig(env)
  if (!enabled) return { plan: deterministicPlan, plannerStatus: 'disabled', plannerMode: 'deterministic', provider: 'local', latencyMs: Date.now() - startedAt, fallbackReason: 'feature_disabled', validation: validateBusinessQueryPlan(deterministicPlan) }

  const call = options.providerPlanner
    ? () => options.providerPlanner(providerInput(input))
    : () => callConfiguredProvider(providerInput(input), env, options.fetchImpl)
  let response
  try { response = await call() } catch (error) { response = { ok: false, reason: error?.name === 'AbortError' ? 'timeout' : 'provider_error' } }
  if (!response?.ok) return { plan: deterministicPlan, plannerStatus: 'degraded', plannerMode: 'deterministic_fallback', provider: provider.kind, latencyMs: Date.now() - startedAt, fallbackReason: response?.reason || 'provider_unavailable', validation: validateBusinessQueryPlan(deterministicPlan) }
  const candidate = extractProviderPlan(response.rawOutput ?? response.plan ?? response.output)
  const validation = validateBusinessQueryPlan(candidate)
  if (!validation.valid) return { plan: deterministicPlan, plannerStatus: 'degraded', plannerMode: 'deterministic_fallback', provider: provider.kind, latencyMs: Date.now() - startedAt, fallbackReason: 'invalid_provider_plan', validation }
  return { plan: validation.plan, plannerStatus: 'ready', plannerMode: 'provider', provider: provider.kind, latencyMs: Date.now() - startedAt, fallbackReason: null, validation }
}

export function semanticPlannerAudit(result) {
  return {
    planningVersion: result?.plan?.planningVersion,
    selectedGoals: result?.plan?.goals || [],
    scope: result?.plan?.scope ? { mode: result.plan.scope.mode, entityType: result.plan.scope.entityType, entityCount: result.plan.scope.entityIds.length + result.plan.scope.entityNames.length } : null,
    filters: result?.plan?.filters || null,
    confidence: result?.plan?.confidence ?? null,
    validationOutcome: Boolean(result?.validation?.valid),
    provider: result?.provider || 'local',
    plannerMode: result?.plannerMode || 'deterministic',
    latencyMs: result?.latencyMs || 0,
    fallbackReason: result?.fallbackReason || null,
  }
}
