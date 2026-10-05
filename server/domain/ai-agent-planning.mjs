import { AI_MODEL_POLICIES } from './ai-model-router.mjs'
import { callConfiguredProvider, canCallConfiguredProvider, providerRuntimeConfig } from './ai-runtime-provider-adapter-v2.mjs'
import { toolsFor } from './ai-skill-registry.mjs'

// Agent mode P2: model tool planning (docs/ai-agent-mode-design.md sections 3
// and 6, docs/ai-assistant-plan.md section 7; policy agent_planning, approved
// by the owner on 2026-10-03, local only). One model call chooses up to three
// of the actor's read-only skills for the question; the skills then answer
// from the actor's facts with their own wording.
//
// What the model sees: the question (at most 1,200 characters) and the
// actor's skills as native tool definitions. Never business data, record
// lists, workspace names or the conversation.
//
// What the model may say: which skills, the inventory mode (overview or
// short), and which records each call is about, written as the question
// writes them. The deterministic record step (refineAiSkillRoute) resolves
// those words against the actor's own records and sets the mode, so a record
// the actor cannot see answers exactly as one that does not exist. A record
// the question does not contain, an unknown tool, an unknown argument or a
// fourth call is dropped.

export const AI_AGENT_LIMITS = Object.freeze({ maxTools: 3, maxRecords: 10, timeoutMs: 2500, maxTimeoutMs: 5000 })
// Providers whose adapter sends native tool calls (chat completions).
const TOOL_CALLING_KINDS = new Set(['deepseek_chat', 'doubao_chat', 'qwen_chat', 'parley_chat'])
const text = (value) => String(value ?? '').trim()
const array = (value) => (Array.isArray(value) ? value : [])

// Off unless FLOWCHAIN_AI_AGENT_MODE=plan and a tool-calling provider is configured.
export function aiAgentPlanningEnabled(env = {}) {
  return text(env.FLOWCHAIN_AI_AGENT_MODE).toLowerCase() === 'plan' && canCallConfiguredProvider(env) && TOOL_CALLING_KINDS.has(providerRuntimeConfig(env).kind)
}

export function aiAgentTimeout(env = {}) {
  return Math.min(AI_AGENT_LIMITS.maxTimeoutMs, Math.max(100, Number(env.FLOWCHAIN_AI_AGENT_TIMEOUT_MS) || AI_AGENT_LIMITS.timeoutMs))
}

// The modes a model may ask for. Other skill modes (single, supplier, sku,
// not_found, hidden, ambiguous) follow from the records the question names.
const REQUESTABLE_MODES = Object.freeze({ inventory_availability: Object.freeze(['overview', 'short']) })
const RECORDS = Object.freeze({
  type: 'array',
  items: { type: 'string' },
  maxItems: AI_AGENT_LIMITS.maxRecords,
  description: 'Record numbers, SKUs or supplier names this call is about, written exactly as in the question. Leave empty for the whole workspace.',
})

// The actor's skills as native tool definitions. capability_overview is the
// fallback, not a tool.
export function aiAgentTools(actor) {
  return toolsFor(actor).filter((entry) => entry.id !== 'capability_overview').map((entry) => {
    const modes = REQUESTABLE_MODES[entry.id]
    return {
      type: 'function',
      function: {
        name: entry.id,
        description: entry.description.en,
        parameters: { type: 'object', additionalProperties: false, properties: { ...(modes ? { mode: { type: 'string', enum: [...modes] } } : {}), records: RECORDS }, required: [] },
      },
    }
  })
}

// Case, width and spacing do not matter when a record is looked for in the
// question; anything else does.
const normalized = (value) => text(value).normalize('NFKC').toLowerCase().replace(/\s+/g, ' ')

function parseArguments(raw) {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw
  const value = text(raw)
  if (!value) return {}
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  } catch { return null }
}

// The calls the runtime may run, and the ones it dropped with their reasons.
export function validateAiAgentToolCalls(toolCalls, { message, tools }) {
  const known = new Map(array(tools).map((tool) => [tool.function.name, tool.function.parameters]))
  const question = normalized(message)
  const calls = []
  const dropped = []
  const seen = new Set()
  for (const call of array(toolCalls)) {
    const tool = text(call?.name)
    const drop = (reason) => dropped.push({ tool: tool || null, reason })
    const parameters = known.get(tool)
    if (!parameters) { drop('unknown_tool'); continue }
    const args = parseArguments(call.arguments)
    if (!args) { drop('invalid_arguments'); continue }
    if (Object.keys(args).some((key) => !Object.hasOwn(parameters.properties, key))) { drop('invalid_arguments'); continue }
    const mode = args.mode === undefined || args.mode === null ? null : text(args.mode)
    if (mode !== null && !array(parameters.properties.mode?.enum).includes(mode)) { drop('invalid_arguments'); continue }
    const records = args.records === undefined || args.records === null ? [] : args.records
    if (!Array.isArray(records) || records.length > AI_AGENT_LIMITS.maxRecords || records.some((record) => typeof record !== 'string')) { drop('invalid_arguments'); continue }
    const named = [...new Set(records.map(text).filter(Boolean))]
    if (named.some((record) => !question.includes(normalized(record)))) { drop('record_not_in_question'); continue }
    const key = `${tool}|${mode || ''}|${named.map(normalized).sort().join(',')}`
    if (seen.has(key)) continue
    seen.add(key)
    if (calls.length >= AI_AGENT_LIMITS.maxTools) { drop('over_limit'); continue }
    calls.push({ tool, mode, records: named })
  }
  return { calls, dropped }
}

function withTimeout(promise, ms, onTimeout) {
  let timer
  return Promise.race([promise, new Promise((resolve) => { timer = setTimeout(() => { onTimeout(); resolve({ ok: false, reason: 'timeout' }) }, ms) })]).finally(() => clearTimeout(timer))
}

// One planning call. { status: 'planned', calls, dropped } when at least one
// call may run; 'declined' when the model called no tool; 'degraded' on a
// timeout, an error or a plan with no valid call; 'disabled' when off.
export async function planAiAgentTools({ message, actor, env = {}, excluded = [], provider = callConfiguredProvider, fetchImpl = globalThis.fetch } = {}) {
  if (!aiAgentPlanningEnabled(env)) return { status: 'disabled' }
  const started = Date.now()
  // A skill a rule excluded for this question (purchase order skills for a
  // sales order question, for example) is not offered.
  const tools = aiAgentTools(actor).filter((tool) => !excluded.includes(tool.function.name))
  const base = () => ({ provider: providerRuntimeConfig(env).kind, latencyMs: Date.now() - started, toolCount: tools.length })
  if (!tools.length) return { status: 'declined', reason: 'no_tools', calls: [], dropped: [], ...base() }
  const controller = new AbortController()
  const abortable = (url, init = {}) => fetchImpl(url, { ...init, signal: init.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal })
  const input = { task: { type: 'agent_planning', question: text(message).slice(0, 1200) }, tools, modelPolicy: AI_MODEL_POLICIES.agentPlanning }
  let response
  try { response = await withTimeout(Promise.resolve(provider(input, env, abortable)), aiAgentTimeout(env), () => controller.abort()) } catch { response = { ok: false, reason: 'provider_error' } }
  const usage = response?.usage || null
  if (!response?.ok) return { status: 'degraded', reason: text(response?.reason) || 'provider_unavailable', calls: [], dropped: [], usage, ...base() }
  if (!array(response.toolCalls).length) return { status: 'declined', reason: 'no_tool_call', calls: [], dropped: [], usage, ...base() }
  const { calls, dropped } = validateAiAgentToolCalls(response.toolCalls, { message, tools })
  if (!calls.length) return { status: 'degraded', reason: 'invalid_plan', calls, dropped, usage, ...base() }
  return { status: 'planned', calls, dropped, usage, ...base() }
}

// The audit block: codes, tools, modes and counts only. Never the question,
// the records' text or the model's words (agent mode decision 9).
export function aiAgentAudit(plan, { entry, served = [] } = {}) {
  if (!plan || plan.status === 'disabled') return null
  return {
    phase: 'plan',
    entry: entry || null,
    status: plan.status,
    reason: plan.reason || null,
    provider: plan.provider || null,
    latencyMs: plan.latencyMs ?? null,
    modelCalls: 1,
    calls: array(plan.calls).map((call) => ({ tool: call.tool, mode: call.mode || null, records: call.records.length, served: served.includes(call.tool) })),
    dropped: array(plan.dropped).map((row) => ({ tool: row.tool, reason: row.reason })),
    inputTokens: plan.usage?.inputTokens ?? null,
    outputTokens: plan.usage?.outputTokens ?? null,
  }
}
