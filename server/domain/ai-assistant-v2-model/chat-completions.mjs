import { providerRuntimeConfig } from '../ai-runtime-provider-adapter-v2.mjs'
import { aiProviderIdentityHeaders, extractUsage } from '../ai-runtime-provider-specific-adapters-v2.mjs'
import { AssistantModelError, modelAbortError } from './model-error.mjs'

// The assistant v2 model client on a chat completions endpoint with native
// tool calls, for local runs and the local eval on OpenCode Go or Parley
// (docs/ai-assistant-v2-design.md §3.4), ported from the chat path of
// ai-model-first-provider.mjs. The loop keeps its transcript in the Messages
// API's shape, so the request is translated here and the reply comes back in
// that shape too.
//
// The call is streamed (stream: true, server-sent events, with the usage in
// the stream): text goes out delta by delta, and each tool call is assembled
// from its pieces, with a start when its name arrives, its argument pieces as
// they come and an end once the reply is complete. A reply that is not an
// event stream (a provider that ignores stream) is read whole. A provider
// that refuses a streamed request (400, 422, 501) is asked again without
// streaming, and when that works this process stops asking it to stream.
// Measured on Parley, Sonnet 5.5, 2026-11-02: tool calls stream in pieces and
// the usage arrives in the stream.

const EFFORTS = new Set(['none', 'low', 'medium', 'high'])
const STREAM_REFUSED = new Set([400, 422, 501])
const EPHEMERAL = Object.freeze({ type: 'ephemeral' })
const text = (value) => String(value ?? '').trim()
const array = (value) => (Array.isArray(value) ? value : [])
const blocks = (content) => (typeof content === 'string' ? [{ type: 'text', text: content }] : array(content))
const joinText = (content) => blocks(content).filter((block) => block?.type === 'text').map((block) => block.text ?? '').join('')
// Endpoints (with their model) that refused a streamed request, for this process.
const NOT_STREAMING = new Set()

// OpenCode Go and Parley were for local development only: they are not
// covered by the agreements a customer workspace runs under.
// 2026-11-04: the owner chose MIT Parley (Sonnet 5.5) for the trial servers.
// Parley may now run in production, but only where the deployment says so in
// FLOWCHAIN_AI_ALLOW_PARLEY_IN_PRODUCTION=true. OpenCode stays local only.
const isHost = (endpoint, name) => {
  try { return new URL(text(endpoint)).hostname.toLowerCase().includes(name) } catch { return false }
}

export function isLocalOnlyProviderEndpoint(endpoint) {
  return isHost(endpoint, 'opencode') || isHost(endpoint, 'parley')
}

export const parleyAllowedInProduction = (env = {}) => text(env.FLOWCHAIN_AI_ALLOW_PARLEY_IN_PRODUCTION).toLowerCase() === 'true'

export function assertAssistantV2EndpointAllowed(env = {}, endpoint = providerRuntimeConfig(env).endpoint) {
  if (text(env.NODE_ENV).toLowerCase() !== 'production' || !isLocalOnlyProviderEndpoint(endpoint)) return
  if (isHost(endpoint, 'parley') && !isHost(endpoint, 'opencode') && parleyAllowedInProduction(env)) return
  throw new AssistantModelError('local_only_provider')
}

// Through OpenCode, reasoning_effort "none" worked for Haiku 5.5 and for
// DeepSeek V4.1 Flash, which also rejects a required tool choice while it thinks.
export function assistantV2ChatEffort(env = {}) {
  const asked = text(env.FLOWCHAIN_AI_ASSISTANT_REASONING_EFFORT).toLowerCase()
  return EFFORTS.has(asked) ? asked : 'none'
}

// Prompt caching through Anthropic's cache_control marker on the system
// message, as the SDK client marks its system prompt. Parley honoured it for
// Claude models (2026-11-02: the second of two identical calls read the
// system prompt and the tools, which come before it, from the cache), so it
// is on there; FLOWCHAIN_AI_ASSISTANT_CHAT_CACHE=on or off decides elsewhere.
// Only the system breakpoint was verified, so the SDK client's breakpoint on
// the growing conversation has no counterpart here.
export function assistantV2ChatCaching(env = {}, { endpoint, model } = providerRuntimeConfig(env)) {
  const asked = text(env.FLOWCHAIN_AI_ASSISTANT_CHAT_CACHE).toLowerCase()
  if (asked === 'on' || asked === 'off') return asked === 'on'
  let host = ''
  try { host = new URL(text(endpoint)).hostname.toLowerCase() } catch { return false }
  return host.includes('parley') && /^claude-/.test(text(model))
}

function chatMessages(system, messages, cache) {
  const out = [{ role: 'system', content: cache ? [{ type: 'text', text: system, cache_control: EPHEMERAL }] : system }]
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

// `withdrawnTools`: tools the loop no longer offers in this answer. Without
// caching they are left out. With caching they stay, as in a Messages
// request: the tools come before the system prompt in the cached prefix, so a
// shorter list would write the prefix again at the cache write price, and the
// loop refuses their calls itself.
export function buildAssistantV2ChatRequest({ system, messages, tools = [], maxTokens, withdrawnTools = [] } = {}, { model, effort, stream = false, cache = false } = {}) {
  const withdrawn = new Set(cache ? [] : array(withdrawnTools))
  const offered = tools.filter((tool) => !withdrawn.has(tool.name))
  return {
    model,
    messages: chatMessages(system, messages, cache),
    ...(offered.length ? {
      tools: offered.map((tool) => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.input_schema } })),
      tool_choice: 'auto',
    } : {}),
    max_tokens: maxTokens,
    reasoning_effort: effort,
    ...(stream ? { stream: true, stream_options: { include_usage: true } } : {}),
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
// OpenAI counts cached tokens inside prompt_tokens (cached_tokens); Parley
// reports Anthropic's cache reads and writes beside them
// (cache_read_input_tokens, cache_write_input_tokens) and in total_tokens,
// which extractUsage reads.
export function assistantV2ChatUsage(raw) {
  const usage = extractUsage(raw)
  if (!usage) return null
  const details = raw?.usage?.prompt_tokens_details || {}
  const count = (...values) => {
    const found = values.map(Number).find((value) => Number.isFinite(value) && value > 0)
    return found || 0
  }
  const read = count(details.cached_tokens, details.cache_read_input_tokens, raw?.usage?.cache_read_input_tokens)
  const write = count(details.cache_write_input_tokens, details.cache_creation_input_tokens, raw?.usage?.cache_creation_input_tokens)
  const all = usage.inputTokens ?? 0
  return { input_tokens: all >= read + write ? all - read - write : all, output_tokens: usage.outputTokens ?? 0, cache_read_input_tokens: read, cache_creation_input_tokens: write }
}

const stopReasonOf = (calls, finish) => (calls.length ? 'tool_use' : finish === 'length' ? 'max_tokens' : 'end_turn')

// A whole (not streamed) reply as the client's events.
function replyEvents(raw) {
  const choice = raw?.choices?.[0]
  if (!choice?.message) throw new AssistantModelError('malformed_output')
  const answer = typeof choice.message.content === 'string' ? choice.message.content : ''
  const calls = array(choice.message.tool_calls).filter((call) => call?.function)
    .map((call, index) => ({ id: text(call.id) || `call_${index}`, name: text(call.function.name), input: parseArguments(call.function.arguments) }))
  const content = [
    ...(answer ? [{ type: 'text', text: answer }] : []),
    ...calls.map((call) => ({ type: 'tool_use', id: call.id, name: call.name, input: call.input ?? {} })),
  ]
  return [
    ...(answer ? [{ type: 'text_delta', text: answer }] : []),
    ...calls.flatMap((call) => [{ type: 'tool_use_start', id: call.id, name: call.name }, { type: 'tool_use_end', id: call.id, name: call.name, input: call.input }]),
    { type: 'message_end', stopReason: stopReasonOf(calls, choice.finish_reason), usage: assistantV2ChatUsage(raw), content },
  ]
}

// The data of each server-sent event in a body, as it arrives.
async function* sseData(body) {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let finished = false
  try {
    for (;;) {
      const { value, done } = await reader.read()
      buffer += decoder.decode(value, { stream: !done })
      for (let at = buffer.search(/\r?\n\r?\n/); at !== -1; at = buffer.search(/\r?\n\r?\n/)) {
        const frame = buffer.slice(0, at)
        buffer = buffer.slice(at).replace(/^\r?\n\r?\n/, '')
        const data = frame.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).replace(/^ /, '')).join('\n')
        if (data) yield data
      }
      if (done) {
        finished = true
        if (buffer.trim()) {
          const data = buffer.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).replace(/^ /, '')).join('\n')
          if (data) yield data
        }
        return
      }
    }
  } finally {
    if (!finished) reader.cancel().catch(() => {})
  }
}

// A streamed reply as the client's events: text as it comes, each tool call
// started when its name arrives and ended when the reply is complete.
async function* streamEvents(body, signal) {
  let answer = ''
  let finish = null
  let usage = null
  let complete = false
  const calls = new Map()
  for await (const data of sseData(body)) {
    if (signal?.aborted) throw modelAbortError()
    if (data.trim() === '[DONE]') { complete = true; break }
    const chunk = parseJson(data)
    if (!chunk || typeof chunk !== 'object') throw new AssistantModelError('malformed_output')
    // An error the provider reports inside the stream is the provider failing.
    if (chunk.error) throw new AssistantModelError('non_success_status', { errorType: text(chunk.error.type || chunk.error.code) || undefined })
    if (chunk.usage) usage = chunk.usage
    const choice = chunk.choices?.[0]
    if (!choice) continue
    const delta = choice.delta || {}
    if (typeof delta.content === 'string' && delta.content) {
      answer += delta.content
      yield { type: 'text_delta', text: delta.content }
    }
    for (const piece of array(delta.tool_calls)) {
      const index = Number.isInteger(piece?.index) ? piece.index : calls.size
      let call = calls.get(index)
      if (!call) {
        call = { id: '', name: '', json: '', started: false }
        calls.set(index, call)
      }
      if (!call.started && text(piece.id)) call.id = text(piece.id)
      if (!call.name && text(piece.function?.name)) call.name = text(piece.function.name)
      const json = piece.function?.arguments
      const added = typeof json === 'string' ? json : json && typeof json === 'object' ? JSON.stringify(json) : ''
      call.json += added
      if (!call.started && call.name) {
        call.started = true
        call.id ||= `call_${index}`
        yield { type: 'tool_use_start', id: call.id, name: call.name }
        if (call.json) yield { type: 'tool_input_delta', id: call.id, partialJson: call.json }
      } else if (call.started && added) yield { type: 'tool_input_delta', id: call.id, partialJson: added }
    }
    if (choice.finish_reason) {
      finish = choice.finish_reason
      complete = true
    }
  }
  if (signal?.aborted) throw modelAbortError()
  // A stream that ends with neither a finish reason nor [DONE] was cut short.
  if (!complete) throw new AssistantModelError('malformed_output')
  const finished = [...calls.entries()].sort(([a], [b]) => a - b).map(([index, call]) => ({ id: call.id || `call_${index}`, name: call.name, input: parseArguments(call.json), started: call.started }))
  for (const call of finished) {
    if (!call.started) yield { type: 'tool_use_start', id: call.id, name: call.name }
    yield { type: 'tool_use_end', id: call.id, name: call.name, input: call.input }
  }
  const content = [
    ...(answer ? [{ type: 'text', text: answer }] : []),
    ...finished.map((call) => ({ type: 'tool_use', id: call.id, name: call.name, input: call.input ?? {} })),
  ]
  yield { type: 'message_end', stopReason: stopReasonOf(finished, finish), usage: usage ? assistantV2ChatUsage({ usage }) : null, content }
}

export function createChatCompletionsModelClient(env = {}) {
  const config = providerRuntimeConfig(env)
  assertAssistantV2EndpointAllowed(env, config.endpoint)
  const effort = assistantV2ChatEffort(env)
  const cache = assistantV2ChatCaching(env, config)
  const streamKey = `${config.endpoint} ${config.model}`
  return {
    kind: 'chat_completions',
    model: config.model,
    async *stream(request, signal) {
      const headers = { 'content-type': 'application/json', authorization: `Bearer ${config.apiKey}`, ...aiProviderIdentityHeaders(env) }
      const post = (stream) => fetch(config.endpoint, { method: 'POST', headers, body: JSON.stringify(buildAssistantV2ChatRequest(request, { model: config.model, effort, stream, cache })), signal })
      let reply
      let replyText = null
      // The reply is read inside the try when it is whole, so a stop or a
      // dropped connection while it arrives is an abort or a network error,
      // not bad output.
      try {
        const streaming = !NOT_STREAMING.has(streamKey)
        reply = await post(streaming)
        if (streaming && STREAM_REFUSED.has(reply.status)) {
          await reply.body?.cancel()
          reply = await post(false)
          if (reply.ok) NOT_STREAMING.add(streamKey)
        }
        if (!reply.ok) {
          await reply.body?.cancel()
          throw new AssistantModelError('non_success_status', { status: reply.status })
        }
        if (!/text\/event-stream/i.test(reply.headers.get('content-type') || '') || !reply.body) replyText = await reply.text()
      } catch (error) {
        if (signal?.aborted) throw modelAbortError()
        throw error instanceof AssistantModelError ? error : new AssistantModelError('network_error', { cause: error })
      }
      if (signal?.aborted) throw modelAbortError()
      if (replyText !== null) {
        // As with the other clients, nothing reaches the loop after a stop.
        for (const event of replyEvents(parseJson(replyText))) {
          if (signal?.aborted) throw modelAbortError()
          yield event
        }
        return
      }
      // A connection that drops while the events arrive is a network error;
      // leaving early (a stop) closes the response.
      const events = streamEvents(reply.body, signal)
      try {
        for (;;) {
          let next
          try {
            next = await events.next()
          } catch (error) {
            if (signal?.aborted) throw modelAbortError()
            throw error instanceof AssistantModelError ? error : new AssistantModelError('network_error', { cause: error })
          }
          if (next.done) return
          if (signal?.aborted) throw modelAbortError()
          yield next.value
        }
      } finally {
        await events.return()
      }
    },
  }
}
