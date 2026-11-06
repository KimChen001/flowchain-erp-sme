import businessQueryPlanSchema from './ai-business-query-plan.schema.json' with { type: 'json' }
import { can } from '../auth/authorization-service.mjs'
import { BUSINESS_QUERY_GOALS, validateBusinessQueryPlan } from './ai-business-query-plan.mjs'
import { goalDefinition, goalsInStableOrder } from './ai-business-goal-registry.mjs'
import { buildDeterministicBusinessQueryPlan } from './ai-semantic-query-planner.mjs'
import { answerBusinessQueryPlan, businessQueryPlanInput, loadBusinessQueryContext } from './ai-business-query-runtime.mjs'

// The supplier business query as an agent planning tool (agent mode decision
// 3, docs/ai-agent-mode-design.md §3.2): the model writes the plan's goals and
// the suppliers it is about, so no second planner call is made. The suppliers
// must be written in the question (the planner checks every call's records)
// and resolve through the deterministic plan's own supplier step; everything
// else (the time window, the filters, a clarification) is the deterministic
// plan of the question. The same guards apply: validateBusinessQueryPlan, the
// read-only goal registry and the read service's field visibility.

export const AI_AGENT_BUSINESS_QUERY = 'supplier_business_query'
// The section's question in a compound answer, in the answer language.
export const AI_AGENT_BUSINESS_QUERY_TITLE = Object.freeze({ en: 'Supplier checks', zh: '供应商核查' })
const MAX_GOALS = 4
const text = (value) => String(value ?? '').trim()

function allowed(actor, permission) {
  return Boolean(actor?.tenantId && permission) && can({ actor, permission, tenantId: actor.tenantId })
}

// The per-supplier goals whose read permission the actor has.
export function aiAgentBusinessQueryGoals(actor) {
  return BUSINESS_QUERY_GOALS.filter((goal) => goal.startsWith('supplier_') && allowed(actor, goalDefinition(goal)?.requiredPermission))
}

// The tool, or null for an actor who may read none of its goals.
export function aiAgentBusinessQueryTool(actor) {
  const goals = aiAgentBusinessQueryGoals(actor)
  if (!goals.length) return null
  return {
    type: 'function',
    function: {
      name: AI_AGENT_BUSINESS_QUERY,
      description: 'Checks suppliers one by one across payments, invoices, receiving, purchase orders and RFQs, joined per supplier. Only for a part that names suppliers, compares suppliers, or asks what is owed or paid to suppliers; any other part goes to the other tools.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          goals: { type: 'array', items: { type: 'string', enum: goals }, minItems: 1, maxItems: MAX_GOALS, description: businessQueryPlanSchema.properties.goals.description },
          records: { type: 'array', items: { type: 'string' }, maxItems: 10, description: 'Supplier names or codes this call is about, written exactly as in the question. Leave empty for all suppliers.' },
        },
        required: ['goals'],
      },
    },
  }
}

// Ambiguities about which suppliers are meant, as opposed to the question itself.
const SCOPE_AMBIGUITY = /^(?:supplier_not_found:|supplier_scope_unspecified$|previous_result_unavailable$|current_supplier_unavailable$)/
const ALL_SUPPLIERS = Object.freeze({ entityType: 'supplier', mode: 'all', entityIds: [], entityNames: [], source: 'global' })

// The plan for one call: the deterministic plan of the question with the
// model's goals. The suppliers the call names set the scope, resolved by the
// same step as the question's (an unknown one asks which supplier is meant);
// without any, the scope is the question's, and a question that does not say
// which suppliers it means is about all of them, since the model named none;
// a comparison still needs its suppliers named. Alone, the call answers the whole
// question, so the deterministic goals stay, as with the business query
// planner (a model may add goals, not drop them); beside other calls it
// answers its own part. The model supplying goals settles "no supported goal";
// any other clarification (an unknown supplier, an instruction) stays.
export function aiAgentBusinessQueryPlan({ body, bq, goals, records = [], alone }) {
  const input = businessQueryPlanInput(body, bq)
  const deterministic = buildDeterministicBusinessQueryPlan(input)
  const named = records.length ? buildDeterministicBusinessQueryPlan({ ...input, message: records.join(', ') }) : deterministic
  const unspecified = !records.length && !goals.includes('supplier_comparison') && named.ambiguities.includes('supplier_scope_unspecified')
  const scoped = unspecified ? { ...named, scope: ALL_SUPPLIERS, ambiguities: named.ambiguities.filter((ambiguity) => ambiguity !== 'supplier_scope_unspecified') } : named
  const ambiguities = [
    ...deterministic.ambiguities.filter((ambiguity) => ambiguity !== 'no_supported_goal' && !SCOPE_AMBIGUITY.test(ambiguity)),
    ...scoped.ambiguities.filter((ambiguity) => SCOPE_AMBIGUITY.test(ambiguity)),
  ]
  const settled = ambiguities.length === 0
  const kept = alone && !deterministic.clarificationNeeded ? deterministic.goals : []
  const planGoals = goalsInStableOrder([...goals, ...kept])
  const comparison = planGoals.includes('supplier_comparison')
  const plan = {
    ...deterministic,
    scope: scoped.scope,
    goals: planGoals,
    comparison: { enabled: comparison, dimensions: comparison ? ['priority', 'payment_blocks', 'operational_risk', 'data_quality'] : [] },
    ranking: { ...deterministic.ranking, enabled: comparison || planGoals.includes('supplier_priority') },
    ambiguities,
    clarificationNeeded: !settled,
    clarificationQuestion: settled ? null : ambiguities.includes('prompt_injection') ? deterministic.clarificationQuestion : scoped.clarificationQuestion || deterministic.clarificationQuestion,
    confidence: settled ? Math.max(deterministic.confidence, 0.86) : Math.min(deterministic.confidence, scoped.confidence),
  }
  return validateBusinessQueryPlan(plan)
}

// Answers one supplier_business_query call: the business query answer and the
// ids its read service returned, or null when there is no business query
// context (outside database mode) or the plan is invalid.
export async function answerAiAgentBusinessQuery(ctx, body, { goals, records = [], alone }) {
  const bq = await loadBusinessQueryContext(ctx)
  if (!bq) return null
  const validation = aiAgentBusinessQueryPlan({ body, bq, goals, records, alone })
  if (!validation.valid) return null
  const planner = { plan: validation.plan, plannerStatus: 'ready', plannerMode: 'agent', provider: 'agent_planning', latencyMs: 0, fallbackReason: null, validation }
  const response = await answerBusinessQueryPlan(ctx, body, planner, bq)
  // Records the read service returned, and the tenant's supplier names, which
  // may be stored in any language.
  const readIds = [...new Set([...response.keyEvidence.map((item) => item.entityId), ...response.navigationLinks.map((link) => link.entityId)].map(text).filter(Boolean))]
  const stored = [...new Set(bq.suppliers.flatMap((supplier) => [supplier.name, supplier.code]).map(text).filter(Boolean))]
  return { response, readIds, stored }
}
