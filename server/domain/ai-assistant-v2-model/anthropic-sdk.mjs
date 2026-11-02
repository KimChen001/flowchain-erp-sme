import Anthropic from '@anthropic-ai/sdk'
import { providerRuntimeConfig } from '../ai-runtime-provider-adapter-v2.mjs'
import { aiProviderIdentityHeaders } from '../ai-runtime-provider-specific-adapters-v2.mjs'
import { AssistantModelError, modelAbortError } from './model-error.mjs'

// The assistant v2 model client on Anthropic's Messages API, through the
// official SDK (docs/ai-assistant-v2-design.md §3.4). It uses the stable
// messages.stream, not the beta tool runner, so the loop keeps its own rounds,
// limits and cost checks.

export const ASSISTANT_V2_DEFAULT_MODEL = 'claude-sonnet-5-5'
export const ASSISTANT_V2_DEFAULT_MAX_TOKENS = 4000
// between_tools, Sonnet 5.5's lowest thinking setting, is a 400 above high.
const EFFORTS = new Set(['low', 'medium', 'high'])
const EPHEMERAL = Object.freeze({ type: 'ephemeral' })
const text = (value) => String(value ?? '').trim()

// Sonnet 5.5 rejects disabled thinking; between_tools is its lowest setting,
// and the short notes it writes between tool calls come back as thinking
// blocks. No other model accepts between_tools, so the Haiku 5.5 fallback
// keeps its default adaptive thinking and is held down by effort alone.
export function assistantV2ModelSettings(model, env = {}) {
  const asked = text(env.FLOWCHAIN_AI_ASSISTANT_REASONING_EFFORT).toLowerCase()
  return {
    effort: EFFORTS.has(asked) ? asked : 'low',
    ...(model === 'claude-sonnet-5-5' ? { thinking: { type: 'between_tools' } } : {}),
  }
}

// The SDK adds /v1/messages itself, so its base URL is the endpoint without it.
export function assistantV2SdkBaseUrl(endpoint) {
  const url = new URL(text(endpoint))
  return /\/v1\/messages\/?$/.test(url.pathname) ? `${url.origin}${url.pathname.replace(/\/v1\/messages\/?$/, '')}` : url.origin
}

// Tools come first in the cached prefix, then the system prompt; both carry a
// breakpoint, and the top-level one caches the growing conversation, so each
// round reads the earlier rounds from the cache. The tools are sorted by name
// so a role's tool list always renders the same bytes. No sampling setting is
// sent: current models reject them.
export function buildAssistantV2MessagesRequest({ system, messages, tools = [], maxTokens } = {}, { model, effort, thinking } = {}) {
  const sorted = [...tools].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  return {
    model,
    max_tokens: maxTokens || ASSISTANT_V2_DEFAULT_MAX_TOKENS,
    system: [{ type: 'text', text: system, cache_control: EPHEMERAL }],
    ...(sorted.length ? {
      tools: sorted.map((tool, index) => ({ name: tool.name, description: tool.description, input_schema: tool.input_schema, ...(index === sorted.length - 1 ? { cache_control: EPHEMERAL } : {}) })),
      // Forced tool choice is a 400 on Sonnet 5.5.
      tool_choice: { type: 'auto' },
    } : {}),
    ...(thinking ? { thinking } : {}),
    output_config: { effort },
    cache_control: EPHEMERAL,
    messages,
  }
}

// A tool input as the loop sees it: the parsed object, or null when the JSON
// does not parse. The loop validates it against the tool's schema.
function parseToolInput(json) {
  try {
    const parsed = JSON.parse(json || '{}')
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  } catch { return null }
}

function modelError(error, signal) {
  if (signal?.aborted || error instanceof Anthropic.APIUserAbortError) return modelAbortError()
  if (error instanceof Anthropic.APIConnectionError) return new AssistantModelError('network_error', { cause: error })
  // An error event inside a 200 stream, such as an overload, has a type but no
  // status; it is the provider failing, not the model's output.
  if (error instanceof Anthropic.APIError && (error.status || error.type)) return new AssistantModelError('non_success_status', { status: error.status, errorType: error.type, cause: error })
  return new AssistantModelError('malformed_output', { cause: error })
}

export function createAnthropicSdkModelClient(env = {}, { maxRetries } = {}) {
  const config = providerRuntimeConfig(env)
  const model = config.model || ASSISTANT_V2_DEFAULT_MODEL
  const settings = assistantV2ModelSettings(model, env)
  const client = new Anthropic({ apiKey: config.apiKey, baseURL: assistantV2SdkBaseUrl(config.endpoint), ...(maxRetries === undefined ? {} : { maxRetries }) })
  return {
    kind: 'anthropic_messages',
    model,
    async *stream(request, signal) {
      if (signal?.aborted) throw modelAbortError()
      const body = buildAssistantV2MessagesRequest(request, { model, ...settings })
      const stream = client.messages.stream(body, { signal, headers: aiProviderIdentityHeaders(env) })
      const final = stream.finalMessage()
      // Read below; until then a failure is reported through the iteration.
      final.catch(() => {})
      const toolBlocks = new Map()
      try {
        // The SDK hands out the events it has already read before it reports
        // an abort, so the signal is checked before each one goes to the loop.
        for await (const event of stream) {
          if (signal?.aborted) throw modelAbortError()
          if (event.type === 'content_block_start' && event.content_block.type === 'tool_use') {
            const block = { id: event.content_block.id, name: event.content_block.name, json: '' }
            toolBlocks.set(event.index, block)
            yield { type: 'tool_use_start', id: block.id, name: block.name }
          } else if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
            yield { type: 'text_delta', text: event.delta.text }
          } else if (event.type === 'content_block_delta' && event.delta.type === 'input_json_delta') {
            const block = toolBlocks.get(event.index)
            if (!block) continue
            block.json += event.delta.partial_json
            yield { type: 'tool_input_delta', id: block.id, partialJson: event.delta.partial_json }
          } else if (event.type === 'content_block_stop' && toolBlocks.has(event.index)) {
            const block = toolBlocks.get(event.index)
            yield { type: 'tool_use_end', id: block.id, name: block.name, input: parseToolInput(block.json) }
          }
        }
        const message = await final
        if (signal?.aborted) throw modelAbortError()
        // The content goes back into the transcript as it came, thinking blocks
        // included: Sonnet 5.5 checks them against the conversation that made them.
        yield { type: 'message_end', stopReason: message.stop_reason, usage: message.usage, content: message.content }
      } catch (error) {
        throw modelError(error, signal)
      }
    },
  }
}
