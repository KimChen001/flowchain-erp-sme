import { AI_MODEL_POLICIES } from './ai-model-router.mjs'
import { callConfiguredProvider, canCallConfiguredProvider, providerRuntimeConfig } from './ai-runtime-provider-adapter-v2.mjs'
import { AI_SKILL_IDS, AI_SKILL_MODES, toolsFor } from './ai-skill-registry.mjs'

// Optional model intent classification, in shadow only (policy
// intent_classification_shadow). It is off unless
// FLOWCHAIN_AI_INTENT_SHADOW=true and a provider is configured. When on, it
// sends the question (at most 1,200 characters) and the ids and descriptions
// of the skills this actor may use: no business data, no record ids it
// looked up and no names from the workspace. The suggestion is checked
// against the registry and written to the audit row next to the rule-based
// route, so the two can be compared on real questions. It never chooses the
// skill, the records, the facts or the language of the answer.

const text = (value) => String(value ?? '').trim()
const DEFAULT_TIMEOUT_MS = 1500
const MAX_TIMEOUT_MS = 5000

export function aiSkillIntentShadowEnabled(env = {}) {
  return text(env.FLOWCHAIN_AI_INTENT_SHADOW).toLowerCase() === 'true' && canCallConfiguredProvider(env)
}

export function aiSkillIntentShadowInput({ message, actor, policy = AI_MODEL_POLICIES.intentClassificationShadow }) {
  const skills = toolsFor(actor).map((entry) => ({ id: entry.id, description: entry.description.en, modes: [...(AI_SKILL_MODES[entry.id] || [])] }))
  return {
    task: { type: 'skill_intent_classification', question: text(message).slice(0, 1200), skills },
    modelPolicy: policy,
  }
}

// The provider adapters return the model's text as conclusion.summary or
// output_text, or the parsed JSON itself. A model may wrap the JSON in a
// fence or explain itself after it ("```json {...} ``` The question asks
// about..."); the first JSON object is read and the rest ignored. Whatever is
// read is still checked against the actor's skills.
function parse(output) {
  let candidate = output
  if (candidate?.conclusion?.summary) candidate = candidate.conclusion.summary
  if (candidate?.output_text) candidate = candidate.output_text
  if (candidate && typeof candidate === 'object') return candidate
  const raw = text(candidate)
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]
  for (const attempt of [raw, fenced, raw.match(/\{[\s\S]*?\}/)?.[0]]) {
    if (!attempt) continue
    try { return JSON.parse(attempt.trim()) } catch {}
  }
  return null
}

// Only a skill this actor may use, a mode that skill has, and a confidence
// between 0 and 1 are kept. Anything else in the reply is dropped.
export function validateAiSkillIntentSuggestion(candidate, allowedIds = AI_SKILL_IDS) {
  const value = parse(candidate)
  if (!value || typeof value !== 'object') return { valid: false, reason: 'malformed_output' }
  const skillId = text(value.skillId)
  if (!AI_SKILL_IDS.includes(skillId) || !allowedIds.includes(skillId)) return { valid: false, reason: 'unknown_skill' }
  const mode = text(value.mode)
  const modes = AI_SKILL_MODES[skillId] || []
  const confidence = Number(value.confidence)
  return {
    valid: true,
    skillId,
    mode: modes.includes(mode) ? mode : null,
    confidence: Number.isFinite(confidence) ? Math.min(1, Math.max(0, Math.round(confidence * 100) / 100)) : null,
  }
}

function withTimeout(promise, ms, onTimeout = () => {}) {
  let timer
  return Promise.race([promise, new Promise((resolve) => { timer = setTimeout(() => { onTimeout(); resolve({ ok: false, reason: 'timeout' }) }, ms) })]).finally(() => clearTimeout(timer))
}

export function aiSkillIntentTimeout(value, fallback = DEFAULT_TIMEOUT_MS) {
  return Math.min(MAX_TIMEOUT_MS, Math.max(100, Number(value) || fallback))
}

// One classification call, shared by the shadow and by routing
// (ai-skill-intent-routing.mjs): a failure, a timeout or an invalid reply is
// returned as degraded, with its reason. A request still open at the timeout
// is aborted, so it does not hold a connection to the provider.
export async function classifyAiSkillIntent({ message, actor, env = {}, provider = callConfiguredProvider, fetchImpl = globalThis.fetch, timeoutMs = DEFAULT_TIMEOUT_MS, policy } = {}) {
  const started = Date.now()
  const allowed = toolsFor(actor).map((entry) => entry.id)
  const controller = new AbortController()
  const abortable = (url, init = {}) => fetchImpl(url, { ...init, signal: init.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal })
  let response
  try { response = await withTimeout(Promise.resolve(provider(aiSkillIntentShadowInput({ message, actor, policy }), env, abortable)), timeoutMs, () => controller.abort()) } catch { response = { ok: false, reason: 'provider_error' } }
  const base = { provider: providerRuntimeConfig(env).kind, latencyMs: Date.now() - started }
  if (!response?.ok) return { status: 'degraded', reason: text(response?.reason) || 'provider_unavailable', ...base }
  const suggestion = validateAiSkillIntentSuggestion(response.rawOutput ?? response.output ?? response.plan, allowed)
  if (!suggestion.valid) return { status: 'degraded', reason: suggestion.reason, ...base }
  return { status: 'ready', skillId: suggestion.skillId, mode: suggestion.mode, confidence: suggestion.confidence, ...base }
}

// Starts the shadow classification. The result is metadata for the audit
// row and never changes the answer.
export async function classifyAiSkillIntentShadow({ message, actor, env = {}, provider = callConfiguredProvider, fetchImpl } = {}) {
  if (!aiSkillIntentShadowEnabled(env)) return { status: 'disabled' }
  return classifyAiSkillIntent({ message, actor, env, provider, fetchImpl, timeoutMs: aiSkillIntentTimeout(env.FLOWCHAIN_AI_INTENT_SHADOW_TIMEOUT_MS) })
}

// The audit metadata: the suggestion beside the skill that answered.
export function aiSkillIntentShadowAudit(shadow, answered) {
  if (!shadow || shadow.status === 'disabled') return null
  return {
    status: shadow.status,
    skillId: shadow.skillId || null,
    mode: shadow.mode || null,
    confidence: shadow.confidence ?? null,
    agrees: shadow.status === 'ready' ? shadow.skillId === answered.skillId && (!shadow.mode || !answered.mode || shadow.mode === answered.mode) : null,
    reason: shadow.reason || null,
    provider: shadow.provider || null,
    latencyMs: shadow.latencyMs ?? null,
  }
}
