import { AI_MODEL_POLICIES } from './ai-model-router.mjs'
import { callConfiguredProvider, canCallConfiguredProvider, providerRuntimeConfig } from './ai-runtime-provider-adapter-v2.mjs'
import { toolsFor } from './ai-skill-registry.mjs'
import { aiSkillTierOf } from './ai-skill-router.mjs'
import { AI_SKILL_TIER_SKILLS } from './ai-skill-entities.mjs'
import { aiAgentBusinessQueryTool } from './ai-agent-business-query.mjs'
import { aiMemoryNames } from './ai-conversation-memory.mjs'

// Agent mode P2: model tool planning (docs/ai-agent-mode-design.md sections 3
// and 6, docs/ai-assistant-plan.md section 7; policy agent_planning, approved
// by the owner on 2026-10-03, local only). One model call chooses up to three
// of the actor's read-only skills for the question; the skills then answer
// from the actor's facts with their own wording.
//
// What the model sees: the question (at most 1,200 characters) and the
// actor's skills as native tool definitions. For a question that refers to
// the previous answer ("compare these two", 这家供应商), also the previous
// question and the names of the records that answer showed, as the actor's
// own facts name them (conversation memory, owner decision 2 of 2026-10-07,
// ai-conversation-memory.mjs). Never other business data, record lists or
// workspace names.
//
// What the model may say: which skills, the inventory mode (overview or
// short), which records each call is about, written as the question writes
// them or as the remembered records are named, the goals of a supplier
// business query (ai-agent-business-query.mjs),
// and the words to search the actor's own documents with (knowledge_search,
// PR-3): a few search words, never shown or stored, in the documents' language,
// so a Chinese question finds an English policy. The passages found are shown
// with their sources; no model writes an answer from them here.
// The business query's suppliers and filters come from the question. The deterministic record step (refineAiSkillRoute) resolves
// those words against the actor's own records and sets the mode, so a record
// the actor cannot see answers exactly as one that does not exist. A record
// neither the question nor the memory contains, an unknown tool, an unknown
// argument or a fourth call is dropped.

export const AI_AGENT_LIMITS = Object.freeze({ maxTools: 3, maxRecords: 10, timeoutMs: 2500, maxTimeoutMs: 5000 })
// Providers whose adapter sends native tool calls (chat completions).
// anthropic_chat is Anthropic's OpenAI-compatible endpoint, the trial provider
// (direction decision 2). It takes `tools` and returns `tool_calls`; it is
// asked with tool_choice "auto" until a real call confirms "required"
// (docs/ai-workspace-access.md).
const TOOL_CALLING_KINDS = new Set(['deepseek_chat', 'doubao_chat', 'qwen_chat', 'parley_chat', 'anthropic_chat'])
// Providers asked for a tool call and no text (tool_choice "required"):
// verified on Parley through both kinds on 2026-10-05, and documented by
// DeepSeek. With it the model declines by calling AI_AGENT_NO_SKILL alone: a
// written refusal took 2.1 to 3.0 s to generate and was thrown away.
const REQUIRED_TOOL_CHOICE_KINDS = new Set(['deepseek_chat', 'parley_chat'])
export const AI_AGENT_NO_SKILL = 'no_matching_skill'
export const AI_AGENT_KNOWLEDGE = 'knowledge_search'
const LANGUAGE_NAMES = Object.freeze({ 'en-US': 'English', 'zh-CN': 'Chinese' })
const QUERY_LENGTH = Object.freeze({ min: 2, max: 200 })
// The languages each knowledge search tool was offered with.
const SEARCH_LANGUAGES = new WeakMap()
const noSkillTool = Object.freeze({
  type: 'function',
  function: Object.freeze({
    name: AI_AGENT_NO_SKILL,
    description: 'Call this alone when no other tool answers any part of the question, or the question is not about this workspace.',
    parameters: Object.freeze({ type: 'object', additionalProperties: false, properties: Object.freeze({}), required: Object.freeze([]) }),
  }),
})
const text = (value) => String(value ?? '').trim()
const array = (value) => (Array.isArray(value) ? value : [])

// Off unless FLOWCHAIN_AI_AGENT_MODE is plan (P2) or compose (P2 and P3
// wording, ai-answer-compose.mjs) and a tool-calling provider is configured.
export function aiAgentPlanningEnabled(env = {}) {
  return ['plan', 'compose'].includes(text(env.FLOWCHAIN_AI_AGENT_MODE).toLowerCase()) && canCallConfiguredProvider(env) && TOOL_CALLING_KINDS.has(providerRuntimeConfig(env).kind)
}

export function aiAgentTimeout(env = {}) {
  return Math.min(AI_AGENT_LIMITS.maxTimeoutMs, Math.max(100, Number(env.FLOWCHAIN_AI_AGENT_TIMEOUT_MS) || AI_AGENT_LIMITS.timeoutMs))
}

// The supplier tier the purchase orders, supplier and draft answers can be
// narrowed to (docs/supplier-tiers-design.md §6): "1", "2", "3", or "none"
// for suppliers not yet tiered. The same skills as a rule-routed tier question
// (ai-skill-entities.mjs). Like a record, it must be written in the question
// (aiSkillTierOf reads the same tier), so the model never adds a filter.
const TIER_SKILLS = AI_SKILL_TIER_SKILLS
const TIER = Object.freeze({
  type: 'string',
  enum: ['1', '2', '3', 'none'],
  description: 'Only suppliers of this tier, when the question names one: Tier 1 or strategic suppliers (1), Tier 2 or core (2), Tier 3 or transactional (3), suppliers not yet tiered (none).',
})

// The modes a model may ask for. Other skill modes (single, supplier, sku,
// not_found, hidden, ambiguous) follow from the records the question names.
const REQUESTABLE_MODES = Object.freeze({ inventory_availability: Object.freeze(['overview', 'short']), spend_analysis: Object.freeze(['suppliers', 'items', 'trend']) })
const RECORDS = Object.freeze({
  type: 'array',
  items: { type: 'string' },
  maxItems: AI_AGENT_LIMITS.maxRecords,
  description: 'Record numbers, SKUs or supplier names this call is about, written exactly as in the question, or as conversation.records names them when the question refers to the previous answer. Leave empty for the whole workspace.',
})

// The actor's skills as native tool definitions, plus the supplier business
// query for a question the business query path would take, when the actor may
// read one of its goals, and the knowledge search when the actor may read at
// least one document (`knowledge`: those documents' languages).
// capability_overview is the fallback, not a tool.
export function aiAgentTools(actor, { businessQuery = true, knowledge = null } = {}) {
  const query = businessQuery ? aiAgentBusinessQueryTool(actor) : null
  return [...aiAgentSkillTools(actor), ...(query ? [query] : []), ...(array(knowledge).length ? [aiAgentKnowledgeTool(knowledge)] : [])]
}

function aiAgentKnowledgeTool(languages) {
  const codes = array(languages)
  const written = codes.map((code) => LANGUAGE_NAMES[code] || code).join(' and ')
  // English documents only: a Chinese question's terms must be translated, or
  // keyword search finds nothing (seen on Parley, 2026-10-06).
  const translate = !codes.includes('zh-CN') ? ' Write the query in English even when the question is in Chinese, translating its terms (采购政策 → purchasing policy, 逾期 → overdue, 跟进 → follow-up).' : ''
  const definition = {
    type: 'function',
    function: {
      name: AI_AGENT_KNOWLEDGE,
      description: `Search this workspace's own documents (policies, procedures, product guides) for the part of the question about what the rules or the documents say. The documents are written in ${written}.${translate}`,
      parameters: { type: 'object', additionalProperties: false, properties: { query: { type: 'string', minLength: QUERY_LENGTH.min, maxLength: QUERY_LENGTH.max, description: `${written} search words for that part, as the documents would word it: a few words, not a sentence and not record numbers.` } }, required: ['query'] },
    },
  }
  SEARCH_LANGUAGES.set(definition.function, codes)
  return definition
}

function aiAgentSkillTools(actor) {
  return toolsFor(actor).filter((entry) => entry.id !== 'capability_overview').map((entry) => {
    const modes = REQUESTABLE_MODES[entry.id]
    return {
      type: 'function',
      function: {
        name: entry.id,
        description: entry.description.en,
        parameters: { type: 'object', additionalProperties: false, properties: { ...(modes ? { mode: { type: 'string', enum: [...modes] } } : {}), records: RECORDS, ...(TIER_SKILLS.has(entry.id) ? { tier: TIER } : {}) }, required: [] },
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
// `maxTools` counts the calls that answer parts of the question; one
// knowledge search may come on top of them, three calls in all.
// `remembered`: the names of the records the previous answer showed
// (aiMemoryNames), which a call may name besides the question's own words.
export function validateAiAgentToolCalls(toolCalls, { message, tools, maxTools = AI_AGENT_LIMITS.maxTools, remembered = [] }) {
  const known = new Map(array(tools).map((tool) => [tool.function.name, tool.function.parameters]))
  const searchLanguages = new Map(array(tools).map((tool) => [tool.function.name, SEARCH_LANGUAGES.get(tool.function)]))
  const question = normalized(message)
  const memory = new Set(array(remembered).map(normalized).filter(Boolean))
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
    const inQuestion = (record) => question.includes(normalized(record))
    if (named.some((record) => !inQuestion(record) && !memory.has(normalized(record)))) { drop('record_not_in_question'); continue }
    const fromMemory = named.filter((record) => !inQuestion(record)).length
    // A tier: one of the tool's values (a number is read as its digit), and
    // the tier the question itself names.
    const asked = args.tier === undefined || args.tier === null || args.tier === '' ? null : text(args.tier).toLowerCase()
    if (asked !== null && !array(parameters.properties.tier?.enum).includes(asked)) { drop('invalid_arguments'); continue }
    const tier = asked === null ? null : asked === 'none' ? 'none' : Number(asked)
    if (tier !== null && aiSkillTierOf(message) !== tier) { drop('tier_not_in_question'); continue }
    // Search words: the knowledge search's one required argument. One search
    // per answer; a second is left out.
    const querySchema = parameters.properties.query
    const query = querySchema ? (typeof args.query === 'string' ? args.query.replace(/\s+/g, ' ').trim() : null) : undefined
    if (querySchema && (!query || query.length < QUERY_LENGTH.min || query.length > QUERY_LENGTH.max)) { drop('invalid_arguments'); continue }
    if (querySchema && calls.some((entry) => entry.tool === tool)) continue
    // Words in a language none of the documents is written in find nothing.
    if (querySchema && /[\u3400-\u9fff]/u.test(query) && !array(searchLanguages.get(tool)).includes('zh-CN')) { drop('query_language'); continue }
    // Goals: a required list of the tool's own values (the business query).
    const goalSchema = parameters.properties.goals
    const goals = goalSchema ? args.goals : undefined
    if (goalSchema && (!Array.isArray(goals) || !goals.length || goals.length > goalSchema.maxItems || new Set(goals).size !== goals.length || goals.some((goal) => !goalSchema.items.enum.includes(goal)))) { drop('invalid_arguments'); continue }
    // One business query per answer: a second one's goals join the first.
    const joined = goalSchema ? calls.find((entry) => entry.tool === tool) : null
    if (joined) { joined.goals = [...new Set([...joined.goals, ...goals])].slice(0, 8); joined.records = [...new Set([...joined.records, ...named])].slice(0, AI_AGENT_LIMITS.maxRecords); if (fromMemory) joined.remembered = (joined.remembered || 0) + fromMemory; continue }
    const key = `${tool}|${mode || ''}|${tier ?? ''}|${named.map(normalized).sort().join(',')}`
    if (seen.has(key)) continue
    seen.add(key)
    const answering = calls.filter((entry) => entry.query === undefined).length
    if (querySchema ? calls.length >= AI_AGENT_LIMITS.maxTools : answering >= maxTools || calls.length >= AI_AGENT_LIMITS.maxTools) { drop('over_limit'); continue }
    calls.push({ tool, mode, records: named, ...(fromMemory ? { remembered: fromMemory } : {}), ...(tier !== null ? { tier } : {}), ...(goalSchema ? { goals: [...goals] } : {}), ...(querySchema ? { query } : {}) })
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
// `parts` is how many parts the question has (splitAiCompoundQuestion): the
// model may call at most one skill per part, and three in all.
// `businessQuery`: offer the supplier business query (a question the business
// query path would take, sent here first by the gateway). `knowledge`: the
// languages of the documents the actor may read, to offer the knowledge
// search; a search may come on top of one call per part, three calls in all.
// `memory`: the previous question and the remembered records' names
// (aiMemoryForModels), for a question that refers to the previous answer.
export async function planAiAgentTools({ message, actor, env = {}, parts = 1, businessQuery = false, knowledge = null, excluded = [], memory = null, provider = callConfiguredProvider, fetchImpl = globalThis.fetch } = {}) {
  if (!aiAgentPlanningEnabled(env)) return { status: 'disabled' }
  const started = Date.now()
  // A skill a rule excluded for this question (purchase order skills for a
  // sales order question, for example) is not offered.
  const tools = aiAgentTools(actor, { businessQuery, knowledge }).filter((tool) => !excluded.includes(tool.function.name))
  const base = () => ({ provider: providerRuntimeConfig(env).kind, latencyMs: Date.now() - started, toolCount: tools.length })
  if (!tools.length) return { status: 'declined', reason: 'no_tools', calls: [], dropped: [], ...base() }
  const controller = new AbortController()
  const abortable = (url, init = {}) => fetchImpl(url, { ...init, signal: init.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal })
  const maxTools = Math.min(AI_AGENT_LIMITS.maxTools, Math.max(1, Number(parts) || 1))
  const required = REQUIRED_TOOL_CHOICE_KINDS.has(providerRuntimeConfig(env).kind)
  const input = { task: { type: 'agent_planning', question: text(message).slice(0, 1200), parts: maxTools, ...(memory ? { conversation: memory } : {}) }, tools: required ? [...tools, noSkillTool] : tools, ...(required ? { toolChoice: 'required' } : {}), modelPolicy: AI_MODEL_POLICIES.agentPlanning }
  let response
  try { response = await withTimeout(Promise.resolve(provider(input, env, abortable)), aiAgentTimeout(env), () => controller.abort()) } catch { response = { ok: false, reason: 'provider_error' } }
  const usage = response?.usage || null
  if (!response?.ok) return { status: 'degraded', reason: text(response?.reason) || 'provider_unavailable', calls: [], dropped: [], usage, ...base() }
  // The no-skill tool is a way to decline, never a lookup.
  const skillCalls = array(response.toolCalls).filter((call) => text(call?.name) !== AI_AGENT_NO_SKILL)
  if (!skillCalls.length) return { status: 'declined', reason: 'no_tool_call', calls: [], dropped: [], usage, ...base() }
  const { calls, dropped } = validateAiAgentToolCalls(skillCalls, { message, tools, maxTools, remembered: aiMemoryNames(memory) })
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
    calls: array(plan.calls).map((call) => ({ tool: call.tool, mode: call.mode || null, records: call.records.length, ...(call.remembered ? { remembered: call.remembered } : {}), ...(call.tier !== undefined ? { tier: call.tier } : {}), ...(call.goals ? { goals: call.goals } : {}), ...(call.query !== undefined ? { queryLength: call.query.length } : {}), served: served.includes(call.tool) })),
    dropped: array(plan.dropped).map((row) => ({ tool: row.tool, reason: row.reason })),
    // Key names without "token": the audit store redacts those as secrets.
    usage: { input: plan.usage?.inputTokens ?? null, output: plan.usage?.outputTokens ?? null },
  }
}
