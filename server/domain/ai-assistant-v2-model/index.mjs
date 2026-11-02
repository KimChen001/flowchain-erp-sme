import { aiModelFirstProviderFormat } from '../ai-model-first-provider.mjs'
import { createAnthropicSdkModelClient } from './anthropic-sdk.mjs'
import { assertAssistantV2EndpointAllowed, createChatCompletionsModelClient } from './chat-completions.mjs'
import { createScriptedModelClient, readScriptedTurns } from './scripted.mjs'

export { AssistantModelError } from './model-error.mjs'

// The assistant v2 model seam (docs/ai-assistant-v2-design.md §3.4). Every
// client has one method:
//
//   client.stream({ system, messages, tools, maxTokens }, signal) → AsyncIterable of
//     { type: 'text_delta', text }
//     { type: 'tool_use_start', id, name }
//     { type: 'tool_input_delta', id, partialJson }
//     { type: 'tool_use_end', id, name, input }      input: the parsed object, or null
//     { type: 'message_end', stopReason, usage, content }
//
// `messages` and `content` are in the Messages API's shape whatever the
// provider; `content` is appended to the transcript unchanged, thinking blocks
// included. `usage` is the call's token counts in the Messages API's fields,
// unpriced. A stopped call throws an AbortError and a failed one an
// AssistantModelError. The client never records usage: the loop does, so no
// call is metered after the user stops an answer.
//
// The client follows the environment, never the question:
//   FLOWCHAIN_AI_ASSISTANT_SCRIPTED=<file>          replays recorded turns
//   FLOWCHAIN_AI_PROVIDER_KIND=anthropic_messages   the official SDK
//   a chat kind (deepseek_chat, parley_chat, ...)   chat completions, local only
// and is null when no provider can run the loop.
export function createAssistantV2ModelClient(env = {}, options = {}) {
  const scripted = String(env.FLOWCHAIN_AI_ASSISTANT_SCRIPTED ?? '').trim()
  if (scripted) return createScriptedModelClient(readScriptedTurns(scripted))
  const format = aiModelFirstProviderFormat(env)
  if (format === 'anthropic_messages') {
    assertAssistantV2EndpointAllowed(env)
    return createAnthropicSdkModelClient(env, options)
  }
  return format === 'chat_completions' ? createChatCompletionsModelClient(env) : null
}
