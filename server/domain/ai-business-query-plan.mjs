export const BUSINESS_QUERY_PLANNING_VERSION = 'business-query-plan-v1'

export const BUSINESS_QUERY_GOALS = Object.freeze([
  'supplier_payables_due',
  'supplier_payables_overdue',
  'supplier_payment_blocks',
  'supplier_payment_readiness',
  'supplier_operational_followups',
  'supplier_priority',
  'supplier_comparison',
  'supplier_invoice_exceptions',
  'supplier_receiving_exceptions',
  'supplier_overdue_purchase_orders',
  'supplier_rfq_followups',
  'supplier_missing_evidence',
  'supplier_bank_reconciliation_exceptions',
  'inventory_risks',
  'procurement_exceptions',
  'data_quality_limitations',
])

export const BUSINESS_QUERY_SCOPE_MODES = Object.freeze(['single', 'set', 'all', 'current_context', 'previous_result'])
export const BUSINESS_QUERY_TIME_WINDOWS = Object.freeze(['today', 'current_week', 'next_7_days', 'next_30_days', 'month_end', 'overdue', 'all'])

const GOALS = new Set(BUSINESS_QUERY_GOALS)
const MODES = new Set(BUSINESS_QUERY_SCOPE_MODES)
const WINDOWS = new Set(BUSINESS_QUERY_TIME_WINDOWS)
const ENTITIES = new Set(['supplier', 'inventory', 'procurement', 'workspace'])
const SOURCES = new Set(['explicit', 'global', 'current_context', 'previous_result', 'clarification'])
const DUE_STATES = new Set(['due_now', 'due_this_week', 'overdue', 'future_due', 'ready_for_payment', 'blocked', 'partially_settled', 'settled', 'disputed', 'held', 'missing_evidence'])
const RISK_LEVELS = new Set(['critical', 'high', 'medium', 'low'])
const GROUPING = new Set(['supplier', 'currency', 'priority', 'goal', 'status'])
const COMPARISON = new Set(['priority', 'payment_readiness', 'payment_blocks', 'operational_risk', 'data_quality'])
const TOP_LEVEL_KEYS = new Set(['planningVersion', 'scope', 'goals', 'filters', 'grouping', 'comparison', 'ranking', 'requestedEvidence', 'requestedActions', 'ambiguities', 'clarificationNeeded', 'clarificationQuestion', 'confidence'])
const SCOPE_KEYS = new Set(['entityType', 'mode', 'entityIds', 'entityNames', 'source'])
const FILTER_KEYS = new Set(['timeWindow', 'dueState', 'riskLevels', 'statuses', 'currencies'])
const COMPARISON_KEYS = new Set(['enabled', 'dimensions'])
const RANKING_KEYS = new Set(['enabled', 'limit'])
const FORBIDDEN_KEY = /(?:sql|queryText|prisma|model|tool|amount|count|total|conclusion|answer|write|mutation|command)/i
const FORBIDDEN_TEXT = /(?:\bselect\b.+\bfrom\b|\binsert\s+into\b|\bupdate\s+\w+\s+set\b|\bdelete\s+from\b|\bprisma\b|\$queryRaw|createPayment|approvePayment|executeBankTransfer|postSettlement)/is

const object = (value) => value && typeof value === 'object' && !Array.isArray(value)
const array = (value) => Array.isArray(value) ? value : []
const text = (value) => String(value ?? '').trim()

function extraKeys(value, allowed, path, errors) {
  if (!object(value)) return
  for (const key of Object.keys(value)) if (!allowed.has(key)) errors.push(`${path}.${key}: additional property is not allowed`)
}

function allowedArray(value, allowlist, path, errors, { min = 0, max = Infinity } = {}) {
  if (!Array.isArray(value)) return errors.push(`${path}: must be an array`)
  if (value.length < min || value.length > max) errors.push(`${path}: must contain ${min}-${max} items`)
  if (new Set(value).size !== value.length) errors.push(`${path}: duplicate items are not allowed`)
  value.forEach((item) => { if (!allowlist.has(item)) errors.push(`${path}: unsupported value ${text(item)}`) })
}

function inspectForbidden(value, path, errors) {
  if (Array.isArray(value)) return value.forEach((item, index) => inspectForbidden(item, `${path}[${index}]`, errors))
  if (object(value)) {
    for (const [key, item] of Object.entries(value)) {
      if (FORBIDDEN_KEY.test(key)) errors.push(`${path}.${key}: forbidden planning field`)
      inspectForbidden(item, `${path}.${key}`, errors)
    }
    return
  }
  if (typeof value === 'string' && FORBIDDEN_TEXT.test(value)) errors.push(`${path}: forbidden executable or internal content`)
}

export function validateBusinessQueryPlan(candidate) {
  const errors = []
  if (!object(candidate)) return { valid: false, errors: ['plan: must be an object'], plan: null }
  extraKeys(candidate, TOP_LEVEL_KEYS, 'plan', errors)
  if (candidate.planningVersion !== BUSINESS_QUERY_PLANNING_VERSION) errors.push('planningVersion: unsupported version')

  const scope = candidate.scope
  if (!object(scope)) errors.push('scope: must be an object')
  else {
    extraKeys(scope, SCOPE_KEYS, 'scope', errors)
    if (!ENTITIES.has(scope.entityType)) errors.push('scope.entityType: unsupported entity type')
    if (!MODES.has(scope.mode)) errors.push('scope.mode: unsupported scope mode')
    if (!SOURCES.has(scope.source)) errors.push('scope.source: unsupported source')
    for (const key of ['entityIds', 'entityNames']) {
      if (!Array.isArray(scope[key])) errors.push(`scope.${key}: must be an array`)
      else if (scope[key].length > 10 || scope[key].some((item) => !text(item) || text(item).length > 160)) errors.push(`scope.${key}: invalid entity list`)
    }
    if (scope.mode === 'single' && array(scope.entityIds).length + array(scope.entityNames).length !== 1) errors.push('scope: single mode requires exactly one entity reference')
    if (scope.mode === 'set' && array(scope.entityIds).length + array(scope.entityNames).length < 2) errors.push('scope: set mode requires at least two entity references')
  }

  allowedArray(candidate.goals, GOALS, 'goals', errors, { min: 1, max: 8 })
  const filters = candidate.filters
  if (!object(filters)) errors.push('filters: must be an object')
  else {
    extraKeys(filters, FILTER_KEYS, 'filters', errors)
    if (!WINDOWS.has(filters.timeWindow)) errors.push('filters.timeWindow: unsupported time window')
    allowedArray(filters.dueState, DUE_STATES, 'filters.dueState', errors, { max: 10 })
    allowedArray(filters.riskLevels, RISK_LEVELS, 'filters.riskLevels', errors, { max: 4 })
    if (!Array.isArray(filters.statuses) || filters.statuses.length > 20) errors.push('filters.statuses: invalid list')
    if (!Array.isArray(filters.currencies) || filters.currencies.length > 10 || filters.currencies.some((item) => !/^[A-Z]{3}$/.test(text(item)))) errors.push('filters.currencies: invalid currency list')
  }
  allowedArray(candidate.grouping, GROUPING, 'grouping', errors, { max: 5 })
  if (!object(candidate.comparison)) errors.push('comparison: must be an object')
  else {
    extraKeys(candidate.comparison, COMPARISON_KEYS, 'comparison', errors)
    if (typeof candidate.comparison.enabled !== 'boolean') errors.push('comparison.enabled: must be boolean')
    allowedArray(candidate.comparison.dimensions, COMPARISON, 'comparison.dimensions', errors, { max: 6 })
  }
  if (!object(candidate.ranking)) errors.push('ranking: must be an object')
  else {
    extraKeys(candidate.ranking, RANKING_KEYS, 'ranking', errors)
    if (typeof candidate.ranking.enabled !== 'boolean') errors.push('ranking.enabled: must be boolean')
    if (!Number.isInteger(candidate.ranking.limit) || candidate.ranking.limit < 1 || candidate.ranking.limit > 50) errors.push('ranking.limit: must be 1-50')
  }
  if (typeof candidate.requestedEvidence !== 'boolean') errors.push('requestedEvidence: must be boolean')
  if (!Array.isArray(candidate.requestedActions) || candidate.requestedActions.length) errors.push('requestedActions: write requests are not allowed')
  if (!Array.isArray(candidate.ambiguities) || candidate.ambiguities.length > 10) errors.push('ambiguities: invalid list')
  if (typeof candidate.clarificationNeeded !== 'boolean') errors.push('clarificationNeeded: must be boolean')
  if (candidate.clarificationQuestion !== null && typeof candidate.clarificationQuestion !== 'string') errors.push('clarificationQuestion: must be string or null')
  if (candidate.clarificationNeeded && !text(candidate.clarificationQuestion)) errors.push('clarificationQuestion: required when clarification is needed')
  if (!Number.isFinite(candidate.confidence) || candidate.confidence < 0 || candidate.confidence > 1) errors.push('confidence: must be between 0 and 1')
  inspectForbidden(candidate, 'plan', errors)
  return { valid: errors.length === 0, errors: [...new Set(errors)], plan: errors.length ? null : structuredClone(candidate) }
}

export function assertValidBusinessQueryPlan(candidate) {
  const result = validateBusinessQueryPlan(candidate)
  if (!result.valid) {
    const error = new Error('BusinessQueryPlan validation failed.')
    error.code = 'AI_BUSINESS_QUERY_PLAN_INVALID'
    error.details = result.errors
    throw error
  }
  return result.plan
}

export function emptyBusinessQueryPlan(overrides = {}) {
  const base = {
    planningVersion: BUSINESS_QUERY_PLANNING_VERSION,
    scope: { entityType: 'supplier', mode: 'all', entityIds: [], entityNames: [], source: 'global' },
    goals: ['data_quality_limitations'],
    filters: { timeWindow: 'all', dueState: [], riskLevels: [], statuses: [], currencies: [] },
    grouping: ['supplier'],
    comparison: { enabled: false, dimensions: [] },
    ranking: { enabled: false, limit: 20 },
    requestedEvidence: true,
    requestedActions: [],
    ambiguities: [],
    clarificationNeeded: false,
    clarificationQuestion: null,
    confidence: 0.5,
  }
  return {
    ...base,
    ...overrides,
    scope: { ...base.scope, ...(overrides.scope || {}) },
    filters: { ...base.filters, ...(overrides.filters || {}) },
    comparison: { ...base.comparison, ...(overrides.comparison || {}) },
    ranking: { ...base.ranking, ...(overrides.ranking || {}) },
  }
}
