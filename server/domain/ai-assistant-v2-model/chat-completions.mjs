import { providerRuntimeConfig } from '../ai-runtime-provider-adapter-v2.mjs'
import { aiProviderIdentityHeaders, extractUsage } from '../ai-runtime-provider-specific-adapters-v2.mjs'
import { AssistantModelError, modelAbortError } from './model-error.mjs'

// The assistant v2 model client on a chat completions endpoint with native
// tool calls, for local runs and the local eval on OpenCode Go or Parley
// (docs/ai-assistant-v2-design.md §3.4), ported from the chat path of
// ai-model-first-provider.mjs. The call is not streamed: the final text goes
// out as one delta and each tool call as a start and an end. The loop keeps
// its transcript in the Messages API's shape, so the request is translated
// here and the reply comes back in that shape too.

const EFFORTS = new Set(['none', 'low', 'medium', 'high'])
const text = (value) => String(value ?? '').trim()
const array = (value) => (Array.isArray(value) ? value : [])
const blocks = (content) => (typeof content === 'string' ? [{ type: 'text', text: content }] : array(content))
const joinText = (content) => blocks(content).filter((block) => block?.type === 'text').map((block) => block.text ?? '').join('')

// OpenCode Go and Parley are for local development only: they are not
// covered by the agreements a customer workspace runs under.
export function isLocalOnlyProviderEndpoint(endpoint) {
  let host = ''
  try { host = new URL(text(endpoint)).hostname.toLowerCase() } catch { return false }
  return host.includes('opencode') || host.includes('parley')
}

export function assertAssistantV2EndpointAllowed(env = {}, endpoint = providerRuntimeConfig(env).endpoint) {
  if (text(env.NODE_ENV).toLowerCase() === 'production' && isLocalOnlyProviderEndpoint(endpoint)) throw new AssistantModelError('local_only_provider')
}

// Through OpenCode, reasoning_effort "none" worked for Haiku 5.5 and for
// DeepSeek V4.1 Flash, which also rejects a required tool choice while it thinks.
export function assistantV2ChatEffort(env = {}) {
  const asked = text(env.FLOWCHAIN_AI_ASSISTANT_REASONING_EFFORT).toLowerCase()
  return EFFORTS.has(asked) ? asked : 'none'
}

function chatMessages(system, messages) {
  const out = [{ role: 'system', content: system }]
  for (const message of array(messages)) {
    if (message.role === 'system') {
      const note = joinText(message.content)
      if (note) out.push({ role: 'system', content: note })
    } else if (message.role === 'assistant') {
      const calls = blocks(message.content).filter((block) => block?.type === 'tool_use')
        .map((block) => ({ id: block.id, type: 'function', function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) } }))
      out.push({ role: 'assistant', content: joinText(message.content), ...(calls.length ? { tool_calls: calls } : {}) })
    } else {
      for (const block of blocks(message.content)) {
        if (block?.type === 'tool_result') out.push({ role: 'tool', tool_call_id: block.tool_use_id, content: typeof block.content === 'string' ? block.content : joinText(block.content) })
      }
      const words = joinText(message.content)
      if (words) out.push({ role: 'user', content: words })
    }
  }
  return out
}

export function buildAssistantV2ChatRequest({ system, messages, tools = [], maxTokens } = {}, { model, effort } = {}) {
  return {
    model,
    messages: chatMessages(system, messages),
    ...(tools.length ? {
      tools: tools.map((tool) => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.input_schema } })),
      tool_choice: 'auto',
    } : {}),
    max_tokens: maxTokens,
    reasoning_effort: effort,
  }
}

function parseJson(value) {
  try { return JSON.parse(value) } catch { return null }
}

// Arguments as the provider sent them (a JSON string, or an object); null
// when they do not parse, for the loop to report back to the model.
function parseArguments(raw) {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw
  try {
    const parsed = JSON.parse(text(raw) || '{}')
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  } catch { return null }
}

// The provider's token counts in the Messages API's usage fields, unpriced.
function messagesUsage(raw) {
  const usage = extractUsage(raw)
  if (!usage) return null
  const cached = Number(raw?.usage?.prompt_tokens_details?.cached_tokens)
  const read = Number.isFinite(cached) && cached > 0 ? cached : 0
  return { input_tokens: Math.max(0, (usage.inputTokens ?? 0) - read), output_tokens: usage.outputTokens ?? 0, cache_read_input_tokens: read, cache_creation_input_tokens: 0 }
}

export function createChatCompletionsModelClient(env = {}) {
  const config = providerRuntimeConfig(env)
  assertAssistantV2EndpointAllowed(env, config.endpoint)
  const effort = assistantV2ChatEffort(env)
  return {
    kind: 'chat_completions',
    model: config.model,
    async *stream(request, signal) {
      const body = buildAssistantV2ChatRequest(request, { model: config.model, effort })
      const headers = { 'content-type': 'application/json', authorization: `Bearer ${config.apiKey}`, ...aiProviderIdentityHeaders(env) }
      // The body is read inside the try, so a stop or a dropped connection
      // while it arrives is an abort or a network error, not bad output.
      let replyText
      try {
        const reply = await fetch(config.endpoint, { method: 'POST', headers, body: JSON.stringify(body), signal })
        if (!reply.ok) {
          await reply.body?.cancel()
          throw new AssistantModelError('non_success_status', { status: reply.status })
        }
        replyText = await reply.text()
      } catch (error) {
        if (signal?.aborted) throw modelAbortError()
        throw error instanceof AssistantModelError ? error : new AssistantModelError('network_error', { cause: error })
      }
      if (signal?.aborted) throw modelAbortError()
      const raw = parseJson(replyText)
      const choice = raw?.choices?.[0]
      if (!choice?.message) throw new AssistantModelError('malformed_output')
      const answer = typeof choice.message.content === 'string' ? choice.message.content : ''
      const calls = array(choice.message.tool_calls).filter((call) => call?.function)
        .map((call, index) => ({ id: text(call.id) || `call_${index}`, name: text(call.function.name), input: parseArguments(call.function.arguments) }))
      const content = [
        ...(answer ? [{ type: 'text', text: answer }] : []),
        ...calls.map((call) => ({ type: 'tool_use', id: call.id, name: call.name, input: call.input ?? {} })),
      ]
      const stopReason = calls.length ? 'tool_use' : choice.finish_reason === 'length' ? 'max_tokens' : 'end_turn'
      const events = [
        ...(answer ? [{ type: 'text_delta', text: answer }] : []),
        ...calls.flatMap((call) => [{ type: 'tool_use_start', id: call.id, name: call.name }, { type: 'tool_use_end', id: call.id, name: call.name, input: call.input }]),
        { type: 'message_end', stopReason, usage: messagesUsage(raw), content },
      ]
      // As with the other clients, nothing reaches the loop after a stop.
      for (const event of events) {
        if (signal?.aborted) throw modelAbortError()
        yield event
      }
    },
  }
}
