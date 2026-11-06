import { recordAiProviderCall } from './ai-usage-meter.mjs'
import { canCallConfiguredProvider, providerRuntimeConfig } from './ai-runtime-provider-adapter-v2.mjs'
import { aiProviderIdentityHeaders, anthropicMessagesHeaders, anthropicMessagesText, anthropicMessagesUsage, extractUsage } from './ai-runtime-provider-specific-adapters-v2.mjs'

// The model calls of the model-first loop (docs/ai-model-first-design.md §5):
// one request per round, with the read tools, through either
//   - Anthropic's native Messages API (anthropic_messages), the trial
//     provider: tool_choice auto only (the newest Claude models reject a
//     forced choice), the final answer as structured output, and the system
//     prompt, the tools and the conversation so far cached; or
//   - a chat completions endpoint with native tool calls (deepseek_chat,
//     parley_chat, anthropic_chat and the other chat kinds), for local runs on
//     OpenCode Go, whose OpenAI-compatible endpoint also serves Claude.
// The loop keeps the conversation in one provider-neutral form: user text,
// the assistant's turns as the provider returned them (so thinking blocks go
// back unchanged), and tool results. Every call is counted for the
// workspace's spend cap, and a failed one is noted for the answer's notice.

const CHAT_KINDS = new Set(['deepseek_chat', 'doubao_chat', 'qwen_chat', 'parley_chat', 'anthropic_chat'])
const EFFORTS = new Set(['none', 'low', 'medium', 'high'])
const text = (value) => String(value ?? '').trim()
const array = (value) => (Array.isArray(value) ? value : [])

// 'anthropic_messages', 'chat_completions', or null when the configured
// provider cannot run the loop.
export function aiModelFirstProviderFormat(env = {}) {
  if (!canCallConfiguredProvider(env)) return null
  const { kind } = providerRuntimeConfig(env)
  if (kind === 'anthropic_messages') return 'anthropic_messages'
  return CHAT_KINDS.has(kind) ? 'chat_completions' : null
}

// How much the model reasons before it answers. Claude Haiku 5.5 thinks at
// medium effort by default and used up a 700-token budget on 2026-10-28, so
// the loop asks for low effort on the native API. Through OpenCode,
// reasoning_effort "none" worked for Haiku 5.5 and for DeepSeek V4.1 Flash,
// which also rejects a required tool choice while it thinks.
export function aiModelFirstEffort(env = {}, format = aiModelFirstProviderFormat(env)) {
  const asked = text(env.FLOWCHAIN_AI_ASSISTANT_REASONING_EFFORT).toLowerCase()
  if (EFFORTS.has(asked)) return asked
  return format === 'anthropic_messages' ? 'low' : 'none'
}

// The final answer's shape, for the native structured output.
export const AI_MODEL_FIRST_ANSWER_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['title', 'answer', 'records'],
  properties: {
    title: { type: 'string' },
    answer: { type: 'string' },
    records: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['type', 'id'], properties: { type: { type: 'string' }, id: { type: 'string' } } } },
  },
})

function anthropicBody({ system, tools, transcript, toolChoice, maxTokens, effort, model }) {
  const messages = []
  for (const entry of transcript) {
    if (entry.role === 'user') messages.push({ role: 'user', content: [{ type: 'text', text: entry.text }] })
    else if (entry.role === 'assistant') messages.push({ role: 'assistant', content: entry.native })
    else if (entry.role === 'tool') {
      messages.push({
        role: 'user',
        content: [
          ...entry.results.map((result) => ({ type: 'tool_result', tool_use_id: result.id, content: result.content, ...(result.error ? { is_error: true } : {}) })),
          ...(entry.note ? [{ type: 'text', text: entry.note }] : []),
        ],
      })
    }
  }
  // The conversation so far is cached at its last block, so the next round
  // reads the earlier tool results from the cache.
  const last = messages.at(-1)?.content?.at(-1)
  if (last && last.type !== 'thinking' && last.type !== 'redacted_thinking') Object.assign(last, { cache_control: { type: 'ephemeral' } })
  return {
    model,
    max_tokens: maxTokens,
    // Tools come before the system prompt in the cached prefix, so one
    // breakpoint on the system prompt caches both.
    system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
    tools: tools.map((tool) => ({ name: tool.name, description: tool.description, input_schema: tool.input_schema })),
    tool_choice: { type: toolChoice === 'none' ? 'none' : 'auto' },
    ...(effort === 'none' ? { thinking: { type: 'disabled' } } : {}),
    output_config: { effort: effort === 'none' ? 'low' : effort, format: { type: 'json_schema', schema: AI_MODEL_FIRST_ANSWER_SCHEMA } },
    messages,
  }
}

function chatBody({ system, tools, transcript, toolChoice, maxTokens, effort, model }) {
  const messages = [{ role: 'system', content: system }]
  for (const entry of transcript) {
    if (entry.role === 'user') messages.push({ role: 'user', content: entry.text })
    else if (entry.role === 'assistant') {
      const calls = array(entry.native?.tool_calls)
      messages.push({ role: 'assistant', content: entry.native?.content ?? '', ...(calls.length ? { tool_calls: calls } : {}) })
    } else if (entry.role === 'tool') {
      for (const result of entry.results) messages.push({ role: 'tool', tool_call_id: result.id, content: result.content })
      if (entry.note) messages.push({ role: 'user', content: entry.note })
    }
  }
  return {
    model,
    messages,
    tools: tools.map((tool) => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.input_schema } })),
    tool_choice: toolChoice === 'none' ? 'none' : 'auto',
    max_tokens: maxTokens,
    reasoning_effort: effort,
  }
}

const parseArguments = (raw) => {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw
  try {
    const parsed = JSON.parse(text(raw) || '{}')
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  } catch { return null }
}

function readAnthropic(raw) {
  const content = array(raw?.content)
  const calls = content.filter((block) => block?.type === 'tool_use').map((block) => ({ id: text(block.id), name: text(block.name), args: parseArguments(block.input) }))
  const stop = raw?.stop_reason === 'tool_use' ? 'tool_use' : raw?.stop_reason === 'max_tokens' ? 'max_tokens' : raw?.stop_reason === 'refusal' ? 'refusal' : 'end'
  return { native: content, text: anthropicMessagesText(raw), calls, stop, usage: anthropicMessagesUsage(raw) }
}

function readChat(raw) {
  const choice = raw?.choices?.[0] || {}
  const message = choice.message || {}
  const native = { content: typeof message.content === 'string' ? message.content : '', tool_calls: array(message.tool_calls) }
  const calls = native.tool_calls.filter((call) => call?.function).map((call, index) => ({ id: text(call.id) || `call_${index}`, name: text(call.function.name), args: parseArguments(call.function.arguments) }))
  // A reply without ids gets them here, so its results can answer them.
  native.tool_calls = native.tool_calls.map((call, index) => ({ ...call, id: text(call.id) || `call_${index}` }))
  const stop = calls.length ? 'tool_use' : choice.finish_reason === 'length' ? 'max_tokens' : 'end'
  const reported = extractUsage(raw)
  const cached = Number(raw?.usage?.prompt_tokens_details?.cached_tokens)
  return { native, text: native.content, calls, stop, usage: reported ? { ...reported, ...(Number.isFinite(cached) && cached > 0 ? { cacheReadTokens: cached } : {}) } : null }
}

// One model call. Returns { ok: true, native, text, calls, stop, usage } or
// { ok: false, reason, budgetExceeded? }. `signal` ends the call when the
// answer's time budget runs out.
export async function callAiModelFirstModel({ env = {}, system, tools, transcript, toolChoice = 'auto', maxTokens, signal, fetchImpl = globalThis.fetch } = {}) {
  const format = aiModelFirstProviderFormat(env)
  if (!format || !fetchImpl) return { ok: false, reason: 'not_configured' }
  const config = providerRuntimeConfig(env)
  const effort = aiModelFirstEffort(env, format)
  const request = { system, tools, transcript, toolChoice, maxTokens, effort, model: config.model }
  const headers = format === 'anthropic_messages'
    ? anthropicMessagesHeaders({ apiKey: config.apiKey, identityHeaders: aiProviderIdentityHeaders(env) })
    : { 'content-type': 'application/json', authorization: `Bearer ${config.apiKey}`, ...aiProviderIdentityHeaders(env) }
  let response
  try {
    const reply = await fetchImpl(config.endpoint, { method: 'POST', headers, body: JSON.stringify(format === 'anthropic_messages' ? anthropicBody(request) : chatBody(request)), signal })
    if (!reply.ok) response = { ok: false, reason: 'non_success_status', status: reply.status, ...(reply.status === 402 ? { budgetExceeded: true } : {}) }
    else {
      const raw = await reply.json().catch(() => null)
      response = raw ? { ok: true, ...(format === 'anthropic_messages' ? readAnthropic(raw) : readChat(raw)) } : { ok: false, reason: 'malformed_output' }
    }
  } catch (error) {
    response = { ok: false, reason: error?.name === 'AbortError' || signal?.aborted ? 'timeout' : 'network_error' }
  }
  await recordAiProviderCall(response)
  return response
}
