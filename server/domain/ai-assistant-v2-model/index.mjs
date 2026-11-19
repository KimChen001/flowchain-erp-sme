import { canCallConfiguredProvider, providerRuntimeConfig } from '../ai-runtime-provider-adapter-v2.mjs'
import { createAnthropicSdkModelClient } from './anthropic-sdk.mjs'
import { assertAssistantV2EndpointAllowed, createChatCompletionsModelClient } from './chat-completions.mjs'
import { createScriptedModelClient, readScriptedTurns } from './scripted.mjs'
import { withModelCallRetry } from './resilient.mjs'

export { AssistantModelError } from './model-error.mjs'

// The provider kinds served through a chat completions endpoint.
const CHAT_KINDS = new Set(['deepseek_chat', 'doubao_chat', 'qwen_chat', 'parley_chat', 'anthropic_chat'])

// 'anthropic_messages', 'chat_completions', or null when the configured
// provider cannot run the loop.
export function assistantV2ProviderFormat(env = {}) {
  if (!canCallConfiguredProvider(env)) return null
  const { kind } = providerRuntimeConfig(env)
  if (kind === 'anthropic_messages') return 'anthropic_messages'
  return CHAT_KINDS.has(kind) ? 'chat_completions' : null
}

// The assistant v2 model seam (docs/ai-assistant-v2-design.md §3.4). Every
// client has one method:
//
//   client.stream({ system, messages, tools, maxTokens, withdrawnTools? }, signal) → AsyncIterable of
//     { type: 'text_delta', text }
//     { type: 'tool_use_start', id, name }
//     { type: 'tool_input_delta', id, partialJson }
//     { type: 'tool_use_end', id, name, input }      input: the parsed object, or null
//     { type: 'message_end', stopReason, usage, content }
//
// `messages` and `content` are in the Messages API's shape whatever the
// provider; `content` is appended to the transcript unchanged, thinking blocks
// included. `usage` is the call's token counts in the Messages API's fields,
// unpriced. `tools` is the same list on every call of an answer;
// `withdrawnTools` names those the loop no longer offers (it refuses their
// calls itself), for a client to leave out where the list may change between
// calls. A stopped call throws an AbortError and a failed one an
// AssistantModelError. The client never records usage: the loop does, so no
// call is metered after the user stops an answer.
//
// Which client runs follows the environment, never the question:
//   FLOWCHAIN_AI_ASSISTANT_SCRIPTED=<file>          replays recorded turns; a file
//     keyed by question picks each turn from the request, so it holds up when
//     a client is made per answer (scripted.mjs)
//   FLOWCHAIN_AI_PROVIDER_KIND=anthropic_messages   the official SDK
//   a chat kind (deepseek_chat, parley_chat, ...)   chat completions, local only
// and is null when no provider can run the loop.
//
// A provider client is wrapped by withModelCallRetry (resilient.mjs): one more
// try for a call that fails before its first event, and a log line for every
// failed, stopped or slow call.
export function createAssistantV2ModelClient(env = {}, options = {}) {
  const scripted = String(env.FLOWCHAIN_AI_ASSISTANT_SCRIPTED ?? '').trim()
  if (scripted) return createScriptedModelClient(readScriptedTurns(scripted))
  const format = assistantV2ProviderFormat(env)
  const resilient = (client) => withModelCallRetry(client, { provider: providerRuntimeConfig(env).kind, ...(options.logger ? { logger: options.logger } : {}) })
  if (format === 'anthropic_messages') {
    assertAssistantV2EndpointAllowed(env)
    return resilient(createAnthropicSdkModelClient(env, options))
  }
  return format === 'chat_completions' ? resilient(createChatCompletionsModelClient(env)) : null
}
