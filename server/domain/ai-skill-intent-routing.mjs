import { AI_MODEL_POLICIES } from './ai-model-router.mjs'
import { callConfiguredProvider, canCallConfiguredProvider } from './ai-runtime-provider-adapter-v2.mjs'
import { aiSkillIntentTimeout, classifyAiSkillIntent } from './ai-skill-intent-shadow.mjs'

// Model routing for the questions no rule and no named record answered
// (policy intent_routing; the owner opted in on 2026-10-02). It is off unless
// FLOWCHAIN_AI_INTENT_ROUTING=true and a provider is configured.
//
// It sends what the shadow classifier sends: the question and the ids and
// descriptions of the skills this actor may use. No business data, no record
// ids and no workspace names. The model may only pick one of those skills;
// the skill then runs on the actor's own facts exactly as if a rule had
// chosen it, so facts, figures, records and wording never come from the
// model. A refusal, a question about the outside world or a record number the
// skills cannot look up never reaches it (the runtime checks that first).
//
// The capability answer stays when the model is slow (2 s by default, 5 s at
// most), fails, replies with something that is not one of the actor's
// skills, is less than MIN_CONFIDENCE sure, picks capability_overview, or
// picks a skill a rule excluded for this question (the router's `excluded`:
// purchase order skills for a sales order question, for example).

export const AI_SKILL_INTENT_ROUTING_MIN_CONFIDENCE = 0.6
const DEFAULT_TIMEOUT_MS = 2000
const text = (value) => String(value ?? '').trim()

export function aiSkillIntentRoutingEnabled(env = {}) {
  return text(env.FLOWCHAIN_AI_INTENT_ROUTING).toLowerCase() === 'true' && canCallConfiguredProvider(env)
}

// { status: 'routed', skillId, ... } when the model's pick may answer;
// 'declined' when it picked no skill or was unsure; 'degraded' on a timeout,
// an error or an invalid reply; 'disabled' when routing is off.
export async function routeAiSkillIntent({ message, actor, env = {}, excluded = [], provider = callConfiguredProvider, fetchImpl } = {}) {
  if (!aiSkillIntentRoutingEnabled(env)) return { status: 'disabled' }
  const result = await classifyAiSkillIntent({
    message, actor, env, provider, fetchImpl,
    timeoutMs: aiSkillIntentTimeout(env.FLOWCHAIN_AI_INTENT_ROUTING_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
    policy: AI_MODEL_POLICIES.intentRouting,
  })
  if (result.status !== 'ready') return result
  if (result.skillId === 'capability_overview') return { ...result, status: 'declined', reason: 'no_skill' }
  if (result.confidence === null || result.confidence < AI_SKILL_INTENT_ROUTING_MIN_CONFIDENCE) return { ...result, status: 'declined', reason: 'low_confidence' }
  if (excluded.includes(result.skillId)) return { ...result, status: 'declined', reason: 'excluded_by_rule' }
  return { ...result, status: 'routed' }
}

// The audit metadata of one routing call.
export function aiSkillIntentRoutingAudit(result) {
  if (!result || result.status === 'disabled') return null
  return {
    status: result.status,
    skillId: result.skillId || null,
    confidence: result.confidence ?? null,
    reason: result.reason || null,
    provider: result.provider || null,
    latencyMs: result.latencyMs ?? null,
  }
}
