function text(value, fallback = '') {
  const next = String(value ?? '').trim()
  return next || fallback
}

export const AI_MODEL_POLICIES = Object.freeze({
  deterministicOnly: 'deterministic_only',
  smallModelOptional: 'small_model_optional',
  llmWordingOptional: 'llm_wording_optional',
  llmDraftOptional: 'llm_draft_optional',
  providerDisabled: 'provider_disabled',
  guidedFallback: 'guided_fallback',
  compoundDecompositionShadow: 'compound_decomposition_shadow',
  intentClassificationShadow: 'intent_classification_shadow',
  queryRewriteShadow: 'query_rewrite_shadow',
  businessQueryPlanning: 'business_query_planning',
  intentRouting: 'intent_routing',
  agentPlanning: 'agent_planning',
})

export const AI_MODEL_POLICY_DEFINITIONS = Object.freeze({
  [AI_MODEL_POLICIES.deterministicOnly]: {
    enabledByDefault: true,
    modelMayRun: false,
    description: 'Business facts and actions are resolved by deterministic FlowChain read models only.',
  },
  [AI_MODEL_POLICIES.smallModelOptional]: {
    enabledByDefault: false,
    modelMayRun: false,
    futureCapabilities: ['intent_classification', 'entity_extraction', 'query_rewriting', 'reranking'],
  },
  [AI_MODEL_POLICIES.llmWordingOptional]: {
    enabledByDefault: false,
    modelMayRun: false,
    futureCapabilities: ['explanation_wording_polish', 'sop_wording_polish'],
  },
  [AI_MODEL_POLICIES.llmDraftOptional]: {
    enabledByDefault: false,
    modelMayRun: false,
    futureCapabilities: ['draft_wording_polish'],
  },
  [AI_MODEL_POLICIES.providerDisabled]: {
    enabledByDefault: true,
    modelMayRun: false,
    description: 'External provider path remains blocked unless explicitly enabled elsewhere.',
  },
  [AI_MODEL_POLICIES.guidedFallback]: {
    enabledByDefault: true,
    modelMayRun: false,
    description: 'Unknown questions receive deterministic business choices instead of provider fallback.',
  },
  [AI_MODEL_POLICIES.compoundDecompositionShadow]: {
    enabledByDefault: false,
    modelMayRun: false,
    description: 'Future model suggestions for compound decomposition are metadata-only and cannot override deterministic decomposition.',
  },
  [AI_MODEL_POLICIES.intentClassificationShadow]: {
    enabledByDefault: false,
    modelMayRun: false,
    description: 'Future model intent classification runs only as shadow metadata and cannot decide routing or facts.',
  },
  [AI_MODEL_POLICIES.queryRewriteShadow]: {
    enabledByDefault: false,
    modelMayRun: false,
    description: 'Future query rewrites are shadow-only and must not add business facts, entities, dates, numbers, or actions.',
  },
  // The owner opted into this on 2026-10-02 after the planner evaluation (docs/ai-query-integration.md).
  [AI_MODEL_POLICIES.businessQueryPlanning]: {
    enabledByDefault: false,
    modelMayRun: true,
    enabledBy: 'FLOWCHAIN_ENABLE_AI_SEMANTIC_PLANNER',
    description: 'A model may plan the scope, goals and filters of supplier business queries that the deterministic gate routes to the planner. Plans are validated and executed by deterministic read models. The deterministic plan is used when the model is unavailable, returns an invalid plan, or asks for a clarification the deterministic plan does not need. The model never decides facts or actions.',
  },
  // The owner opted into this on 2026-10-02 (tests/ai-eval/README.md, "Model routing").
  [AI_MODEL_POLICIES.intentRouting]: {
    enabledByDefault: false,
    modelMayRun: true,
    enabledBy: 'FLOWCHAIN_AI_INTENT_ROUTING',
    description: 'A model may pick which workspace skill answers a question that no deterministic rule and no named record routed. It sees only the question and the skills the actor may use, and may only return one of them. The skill runs on the facts of the actor as if a rule had chosen it. The capability answer stays when the model is unavailable, slow, unsure or picks no skill. The model never decides facts, records, figures, wording or actions.',
  },
  // Agent mode P2. The owner approved it on 2026-10-03 (docs/ai-agent-mode-design.md,
  // decision 2), local only and off by default; docs/ai-assistant-plan.md section 7.
  [AI_MODEL_POLICIES.agentPlanning]: {
    enabledByDefault: false,
    modelMayRun: true,
    enabledBy: 'FLOWCHAIN_AI_AGENT_MODE',
    description: 'A model may choose up to three of the actor\'s read-only workspace skills, and their modes, for a question no rule routed or a question with several parts the rules could not answer part by part. It sees only the question and the skills the actor may use, never business data. Record ids, SKUs and supplier names are taken from the question by the deterministic record step; an argument the question does not contain is refused. The skills answer from the actor\'s facts with their own wording, composed into one answer. The rules\' answer stays when the model is unavailable, slow or returns no valid plan. The model never decides facts, records, figures, wording or actions.',
  },
})

export const AI_MODEL_FORBIDDEN_DECISIONS = Object.freeze([
  'counts',
  'status',
  'dates',
  'amounts',
  'po_overdue_status',
  'sku_risk',
  'rfq_reply_counts',
  'supplier_performance_facts',
  'action_execution',
])

export const AI_MODEL_OPTIONAL_TASKS = Object.freeze({
  smallModel: ['intent_classification', 'entity_extraction', 'query_rewriting', 'reranking'],
  llmWording: ['explanation_wording_polish', 'sop_wording_polish'],
  llmDraft: ['draft_wording_polish'],
  shadow: ['compound_decomposition_shadow', 'intent_classification_shadow', 'query_rewrite_shadow'],
})

const BUSINESS_FACT_INTENTS = new Set([
  'attention_overview_query',
  'today_cockpit_priority_query',
  'priority_explanation_query',
  'procurement_exception_query',
  'inventory_status_query',
  'rfq_followup_query',
  'supplier_followup_query',
  'receiving_exception_query',
  'pr_status_query',
  'relationship_reasoning_query',
  'data_limitation_query',
  'sop_retrieval_query',
  'entity_lookup_query',
  'compound_business_query',
  'receiving_gap_query',
])

export function normalizeAiModelPolicy(policy = '') {
  const normalized = text(policy)
  return AI_MODEL_POLICY_DEFINITIONS[normalized] ? normalized : AI_MODEL_POLICIES.deterministicOnly
}

export function modelPolicyForAiIntent(intent = '') {
  const normalized = text(intent)
  if (normalized === 'unknown_guided_fallback') return AI_MODEL_POLICIES.guidedFallback
  if (normalized === 'provider_disabled') return AI_MODEL_POLICIES.providerDisabled
  if (BUSINESS_FACT_INTENTS.has(normalized)) return AI_MODEL_POLICIES.deterministicOnly
  if (normalized === 'draft_preview_query') return AI_MODEL_POLICIES.deterministicOnly
  return AI_MODEL_POLICIES.deterministicOnly
}

export function routeAiModelPolicy(input = {}) {
  const modelPolicy = normalizeAiModelPolicy(input.modelPolicy || modelPolicyForAiIntent(input.intent))
  return {
    usedModel: false,
    modelPolicy,
    reason: 'disabled_by_default',
    deterministicFallback: true,
    providerCallsAllowed: false,
    externalProvider: 'none',
    forbiddenDecisions: AI_MODEL_FORBIDDEN_DECISIONS,
  }
}

export async function maybeUseSmallModelForIntent(input = {}) {
  return {
    ...routeAiModelPolicy({ ...input, modelPolicy: AI_MODEL_POLICIES.smallModelOptional }),
    optionalTasks: AI_MODEL_OPTIONAL_TASKS.smallModel,
  }
}

export async function maybeUseLlmForWording(input = {}) {
  return {
    ...routeAiModelPolicy({ ...input, modelPolicy: AI_MODEL_POLICIES.llmWordingOptional }),
    optionalTasks: AI_MODEL_OPTIONAL_TASKS.llmWording,
    answer: text(input.fallbackAnswer),
  }
}

export async function maybeUseLlmForDraftPolish(input = {}) {
  return {
    ...routeAiModelPolicy({ ...input, modelPolicy: AI_MODEL_POLICIES.llmDraftOptional }),
    optionalTasks: AI_MODEL_OPTIONAL_TASKS.llmDraft,
    draftText: text(input.fallbackDraftText),
  }
}

function tokens(pattern, value = '') {
  return Array.from(new Set(text(value).match(pattern) || [])).map((item) => item.toUpperCase())
}

function sessionBusinessIds(input = {}) {
  const grounding = input.sessionGrounding || {}
  const ids = [
    grounding.lastPrimaryEntity?.id,
    ...(grounding.lastEvidenceIds || []),
    ...Object.values(grounding.lastVisibleBusinessIds || {}).flatMap((value) => Array.isArray(value) ? value : []),
  ]
  return tokens(/\b(?:PO|PR|RFQ|GRN|INV|SKU)-[A-Z0-9-]+\b/gi, ids.filter(Boolean).join(' '))
}

export function validateCompoundQueryRewrite(input = {}) {
  const original = text(input.originalQuery || input.original || input.query)
  const rewrite = text(input.rewrite || input.rewrittenQuery)
  const allowedIds = new Set([...tokens(/\b(?:PO|PR|RFQ|GRN|INV|SKU)-[A-Z0-9-]+\b/gi, original), ...sessionBusinessIds(input)])
  const rewriteIds = tokens(/\b(?:PO|PR|RFQ|GRN|INV|SKU)-[A-Z0-9-]+\b/gi, rewrite)
  const introducedIds = rewriteIds.filter((id) => !allowedIds.has(id))
  const originalNumbers = new Set(tokens(/\b\d+(?:\.\d+)?\b/g, original))
  const introducedNumbers = tokens(/\b\d+(?:\.\d+)?\b/g, rewrite).filter((num) => !originalNumbers.has(num) && !rewriteIds.some((id) => id.includes(num)))
  const originalDates = new Set(tokens(/\b\d{4}[-/]\d{1,2}[-/]\d{1,2}\b/g, original))
  const introducedDates = tokens(/\b\d{4}[-/]\d{1,2}[-/]\d{1,2}\b/g, rewrite).filter((date) => !originalDates.has(date))
  const actionExecution = /(?:自动|直接).*(?:发送|提交|审批|创建|下单|过账|更新)|auto\s*(?:send|submit|approve|create|execute)/i.test(rewrite)
  const accepted = Boolean(rewrite) && !introducedIds.length && !introducedNumbers.length && !introducedDates.length && !actionExecution
  return {
    accepted,
    reason: accepted ? 'rewrite_within_deterministic_bounds' : 'unsafe_rewrite_rejected',
    introducedIds,
    introducedNumbers,
    introducedDates,
    actionExecution,
  }
}

export async function maybeDecomposeCompoundQueryWithModel(input = {}) {
  return {
    ...routeAiModelPolicy({ ...input, modelPolicy: AI_MODEL_POLICIES.compoundDecompositionShadow }),
    provider: 'none',
    optionalTasks: [AI_MODEL_POLICIES.compoundDecompositionShadow],
    deterministicSubQueries: Array.isArray(input.deterministicSubQueries) ? input.deterministicSubQueries : [],
    modelSubQueries: [],
    agreement: 'not_evaluated',
  }
}

export async function maybeRewriteCompoundQueryWithModel(input = {}) {
  return {
    ...routeAiModelPolicy({ ...input, modelPolicy: AI_MODEL_POLICIES.queryRewriteShadow }),
    provider: 'none',
    optionalTasks: [AI_MODEL_POLICIES.queryRewriteShadow],
    originalQuery: text(input.query || input.originalQuery),
    rewrittenQuery: text(input.query || input.originalQuery),
    rewriteAccepted: false,
    validation: validateCompoundQueryRewrite({
      ...input,
      originalQuery: input.query || input.originalQuery,
      rewrite: input.query || input.originalQuery,
    }),
  }
}
