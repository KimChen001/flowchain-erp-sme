import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { execFile } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AssistantModelError, createAssistantV2ModelClient } from './ai-assistant-v2-model/index.mjs'
import { assistantV2SdkBaseUrl, buildAssistantV2MessagesRequest, createAnthropicSdkModelClient } from './ai-assistant-v2-model/anthropic-sdk.mjs'
import { assistantV2ChatCaching, assistantV2ChatUsage, buildAssistantV2ChatRequest, createChatCompletionsModelClient, isLocalOnlyProviderEndpoint } from './ai-assistant-v2-model/chat-completions.mjs'
import { completeScriptedTurn, createScriptedModelClient, scriptedTurnFor, startScriptedMessagesServer } from './ai-assistant-v2-model/scripted.mjs'

// The assistant v2 model seam (docs/ai-assistant-v2-design.md §3.4): the SDK
// client end to end against a localhost server speaking the Messages API's
// streaming format, the chat completions client against a localhost stub,
// and the scripted client. Nothing here leaves the machine.

const KEY = 'placeholder-key'
const providerEnv = (endpoint, extra = {}) => ({
  FLOWCHAIN_AI_RUNTIME_MODE: 'provider_assisted', FLOWCHAIN_AI_PROVIDER_KIND: 'anthropic_messages', FLOWCHAIN_AI_PROVIDER_ENDPOINT: endpoint,
  FLOWCHAIN_AI_PROVIDER_API_KEY: KEY, FLOWCHAIN_AI_PROVIDER_MODEL: 'claude-sonnet-5-5', ...extra,
})
const TOOLS = [
  { name: 'stock_on_hand', description: 'Stock on hand for one item.', input_schema: { type: 'object', properties: { sku: { type: 'string' } }, required: ['sku'] } },
  { name: 'attention_list', description: 'Records that need attention.', input_schema: { type: 'object', properties: {} } },
]
const USAGE = { input_tokens: 120, output_tokens: 40, cache_read_input_tokens: 2000, cache_creation_input_tokens: 300 }
const TOOL_ROUND = [
  { type: 'message_end', stopReason: 'tool_use', usage: USAGE, content: [
    { type: 'thinking', thinking: 'Looking up the stock first.', signature: 'sig-round-1' },
    { type: 'text', text: 'Checking the stock now.' },
    { type: 'tool_use', id: 'toolu_1', name: 'stock_on_hand', input: { sku: 'BOLT-M8', note: 'say "hi"' } },
  ] },
]
const request = (extra = {}) => ({ system: 'You are the FlowChain assistant.', messages: [{ role: 'user', content: 'How many M8 bolts are left?' }], tools: TOOLS, maxTokens: 4000, ...extra })

async function collect(iterable) {
  const events = []
  for await (const event of iterable) events.push(event)
  return events
}

test('the SDK client sends the documented request and maps the stream to model events', async () => {
  const server = await startScriptedMessagesServer([TOOL_ROUND])
  try {
    const client = createAnthropicSdkModelClient(providerEnv(server.endpoint), { maxRetries: 0 })
    const events = await collect(client.stream(request(), new AbortController().signal))

    const [sent] = server.requests
    assert.equal(sent.url, '/v1/messages')
    // SDK 1.x sends the API key as a bearer token.
    assert.equal(sent.headers.authorization, `Bearer ${KEY}`)
    assert.equal(sent.headers['user-agent'], 'FlowChain-assistant/1.0')
    assert.ok(sent.headers['anthropic-version'])
    assert.equal(sent.body.model, 'claude-sonnet-5-5')
    assert.equal(sent.body.stream, true)
    assert.equal(sent.body.max_tokens, 4000)
    assert.deepEqual(sent.body.thinking, { type: 'between_tools' })
    assert.deepEqual(sent.body.output_config, { effort: 'low' })
    assert.deepEqual(sent.body.tool_choice, { type: 'auto' })
    for (const setting of ['temperature', 'top_p', 'top_k']) assert.equal(setting in sent.body, false, setting)
    assert.deepEqual(sent.body.system, [{ type: 'text', text: 'You are the FlowChain assistant.', cache_control: { type: 'ephemeral' } }])
    assert.deepEqual(sent.body.cache_control, { type: 'ephemeral' })
    // Sorted by name, with the breakpoint on the last tool only.
    assert.deepEqual(sent.body.tools.map((tool) => tool.name), ['attention_list', 'stock_on_hand'])
    assert.deepEqual(sent.body.tools.map((tool) => tool.cache_control), [undefined, { type: 'ephemeral' }])
    assert.deepEqual(sent.body.messages, request().messages)

    assert.equal(events.filter((event) => event.type === 'text_delta').map((event) => event.text).join(''), 'Checking the stock now.')
    assert.deepEqual(events.find((event) => event.type === 'tool_use_start'), { type: 'tool_use_start', id: 'toolu_1', name: 'stock_on_hand' })
    const pieces = events.filter((event) => event.type === 'tool_input_delta')
    assert.equal(pieces.length, 2)
    assert.equal(pieces.map((event) => event.partialJson).join(''), JSON.stringify(TOOL_ROUND[0].content[2].input))
    assert.deepEqual(events.find((event) => event.type === 'tool_use_end'), { type: 'tool_use_end', id: 'toolu_1', name: 'stock_on_hand', input: { sku: 'BOLT-M8', note: 'say "hi"' } })
    const end = events.at(-1)
    assert.equal(end.type, 'message_end')
    assert.equal(end.stopReason, 'tool_use')
    // Thinking blocks come back whole, signature included, for the transcript.
    assert.deepEqual(JSON.parse(JSON.stringify(end.content)), [
      { type: 'thinking', thinking: 'Looking up the stock first.', signature: 'sig-round-1' },
      { type: 'text', text: 'Checking the stock now.' },
      { type: 'tool_use', id: 'toolu_1', name: 'stock_on_hand', input: { sku: 'BOLT-M8', note: 'say "hi"' } },
    ])
    assert.equal(end.usage.input_tokens, 120)
    assert.equal(end.usage.output_tokens, 40)
    assert.equal(end.usage.cache_read_input_tokens, 2000)
    assert.equal(end.usage.cache_creation_input_tokens, 300)
  } finally {
    await server.close()
  }
})

test('the SDK client keeps Haiku 5.5 on its default thinking and honours the effort setting', async () => {
  const server = await startScriptedMessagesServer([[{ type: 'text_delta', text: 'Done.' }]])
  try {
    const client = createAnthropicSdkModelClient(providerEnv(server.endpoint, { FLOWCHAIN_AI_PROVIDER_MODEL: 'claude-haiku-5-5', FLOWCHAIN_AI_ASSISTANT_REASONING_EFFORT: 'medium' }), { maxRetries: 0 })
    const events = await collect(client.stream(request({ tools: [] }), undefined))
    const [sent] = server.requests
    assert.equal(sent.body.model, 'claude-haiku-5-5')
    assert.equal('thinking' in sent.body, false)
    assert.deepEqual(sent.body.output_config, { effort: 'medium' })
    assert.equal('tools' in sent.body, false)
    assert.equal('tool_choice' in sent.body, false)
    assert.deepEqual(events.map((event) => event.type), ['text_delta', 'message_end'])
    assert.equal(events.at(-1).stopReason, 'end_turn')
  } finally {
    await server.close()
  }
})

test('stopping the SDK client ends the stream and closes the connection', async () => {
  const long = [{ type: 'text_delta', text: Array.from({ length: 60 }, (_, index) => `word${index}`).join(' ') }]
  const server = await startScriptedMessagesServer([long], { eventDelayMs: 15 })
  try {
    const client = createAnthropicSdkModelClient(providerEnv(server.endpoint), { maxRetries: 0 })
    const controller = new AbortController()
    const seen = []
    await assert.rejects(async () => {
      for await (const event of client.stream(request(), controller.signal)) {
        seen.push(event)
        if (event.type === 'text_delta') controller.abort()
      }
    }, (error) => error.name === 'AbortError')
    assert.equal(seen.filter((event) => event.type === 'text_delta').length, 1)
    assert.equal(seen.some((event) => event.type === 'message_end'), false)
    // The server stops writing once the client has gone.
    for (let wait = 0; wait < 50 && !server.requests[0].closed; wait += 1) await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(server.requests[0].closed, true)
    assert.equal(server.requests[0].finished, false)
  } finally {
    await server.close()
  }
})

test('nothing reaches the loop after a stop, even events the SDK has already read', async () => {
  // No delay between frames, so the whole turn sits in the SDK's buffer when
  // the first text arrives.
  const turn = [{ type: 'message_end', stopReason: 'tool_use', content: [
    { type: 'text', text: Array.from({ length: 30 }, (_, index) => `word${index}`).join(' ') },
    { type: 'tool_use', id: 'toolu_9', name: 'stock_on_hand', input: { sku: 'BOLT-M8' } },
  ] }]
  const server = await startScriptedMessagesServer([turn])
  try {
    const client = createAnthropicSdkModelClient(providerEnv(server.endpoint), { maxRetries: 0 })
    const controller = new AbortController()
    const seen = []
    await assert.rejects(async () => {
      for await (const event of client.stream(request(), controller.signal)) {
        seen.push(event)
        controller.abort()
      }
    }, (error) => error.name === 'AbortError')
    assert.deepEqual(seen.map((event) => event.type), ['text_delta'])
  } finally {
    await server.close()
  }
})

test('an SDK client failure is an AssistantModelError with the reply status', async () => {
  const server = await startScriptedMessagesServer([])
  try {
    const client = createAnthropicSdkModelClient(providerEnv(server.endpoint), { maxRetries: 0 })
    await assert.rejects(collect(client.stream(request(), undefined)), (error) => error instanceof AssistantModelError && error.reason === 'non_success_status' && error.status === 500)
  } finally {
    await server.close()
  }
  // An error the API streams after a 200 is the provider failing, with its type.
  const overloaded = http.createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(`event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-sonnet-5-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } })}\n\n`)
      res.end(`event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } })}\n\n`)
    })
  })
  await new Promise((resolve) => overloaded.listen(0, '127.0.0.1', resolve))
  try {
    const client = createAnthropicSdkModelClient(providerEnv(`http://127.0.0.1:${overloaded.address().port}/v1/messages`), { maxRetries: 0 })
    await assert.rejects(collect(client.stream(request(), undefined)), (error) => error instanceof AssistantModelError && error.reason === 'non_success_status' && error.errorType === 'overloaded_error' && error.status === undefined)
  } finally {
    await new Promise((resolve) => overloaded.close(resolve))
  }
  const unreachable = createAnthropicSdkModelClient(providerEnv('http://127.0.0.1:9/v1/messages'), { maxRetries: 0 })
  await assert.rejects(collect(unreachable.stream(request(), undefined)), (error) => error instanceof AssistantModelError && error.reason === 'network_error')
})

test('the SDK base URL is the endpoint without the messages path, and output defaults to the loop limit', () => {
  assert.equal(assistantV2SdkBaseUrl('https://api.anthropic.com/v1/messages'), 'https://api.anthropic.com')
  assert.equal(assistantV2SdkBaseUrl('https://api.anthropic.com'), 'https://api.anthropic.com')
  assert.equal(assistantV2SdkBaseUrl('http://127.0.0.1:4100/v1/messages/'), 'http://127.0.0.1:4100')
  assert.equal(buildAssistantV2MessagesRequest(request(), { model: 'claude-sonnet-5-5', effort: 'low' }).max_tokens, 4000)
  assert.equal(buildAssistantV2MessagesRequest(request({ maxTokens: undefined }), { model: 'claude-sonnet-5-5', effort: 'low' }).max_tokens, 4000)
})

async function chatStub(reply) {
  const requests = []
  const server = http.createServer(async (req, res) => {
    let raw = ''
    for await (const chunk of req) raw += chunk
    requests.push({ headers: req.headers, body: JSON.parse(raw) })
    const { status = 200, body } = typeof reply === 'function' ? reply() : reply
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { endpoint: `http://127.0.0.1:${server.address().port}/v1/chat/completions`, requests, close: () => new Promise((resolve) => server.close(resolve)) }
}
const chatEnv = (endpoint, extra = {}) => providerEnv(endpoint, { FLOWCHAIN_AI_PROVIDER_KIND: 'deepseek_chat', FLOWCHAIN_AI_PROVIDER_MODEL: 'deepseek-v4.1-flash', ...extra })

test('the chat completions client translates the transcript and returns Messages-shaped events', async () => {
  const stub = await chatStub({ body: {
    choices: [{ finish_reason: 'tool_calls', message: { content: 'Let me check.', tool_calls: [
      { id: 'call_a', type: 'function', function: { name: 'stock_on_hand', arguments: '{"sku":"BOLT-M8"}' } },
      { id: 'call_b', type: 'function', function: { name: 'attention_list', arguments: '{"broken' } },
    ] } }],
    usage: { prompt_tokens: 900, completion_tokens: 30, total_tokens: 930, prompt_tokens_details: { cached_tokens: 600 } },
  } })
  try {
    const client = createChatCompletionsModelClient(chatEnv(stub.endpoint, { FLOWCHAIN_AI_PROVIDER_SESSION_HEADER: 'x-opencode-session' }))
    const transcript = [
      { role: 'user', content: 'How many M8 bolts are left?' },
      { role: 'assistant', content: [{ type: 'thinking', thinking: '', signature: 's' }, { type: 'text', text: 'Checking.' }, { type: 'tool_use', id: 'call_0', name: 'stock_on_hand', input: { sku: 'BOLT-M8' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_0', content: '{"onHand":12}' }, { type: 'text', text: 'And the washers?' }] },
      { role: 'system', content: 'The user is on the Items page.' },
    ]
    const events = await collect(client.stream(request({ messages: transcript }), new AbortController().signal))
    const [sent] = stub.requests
    assert.equal(sent.headers.authorization, `Bearer ${KEY}`)
    assert.equal(sent.body.model, 'deepseek-v4.1-flash')
    assert.equal(sent.body.reasoning_effort, 'none')
    assert.equal(sent.body.tool_choice, 'auto')
    assert.equal(sent.body.max_tokens, 4000)
    assert.deepEqual(sent.body.tools.map((tool) => tool.function.name), ['stock_on_hand', 'attention_list'])
    assert.deepEqual(sent.body.messages, [
      { role: 'system', content: 'You are the FlowChain assistant.' },
      { role: 'user', content: 'How many M8 bolts are left?' },
      { role: 'assistant', content: 'Checking.', tool_calls: [{ id: 'call_0', type: 'function', function: { name: 'stock_on_hand', arguments: '{"sku":"BOLT-M8"}' } }] },
      { role: 'tool', tool_call_id: 'call_0', content: '{"onHand":12}' },
      { role: 'user', content: 'And the washers?' },
      { role: 'system', content: 'The user is on the Items page.' },
    ])

    assert.deepEqual(events.map((event) => event.type), ['text_delta', 'tool_use_start', 'tool_use_end', 'tool_use_start', 'tool_use_end', 'message_end'])
    assert.equal(events[0].text, 'Let me check.')
    assert.deepEqual(events[2], { type: 'tool_use_end', id: 'call_a', name: 'stock_on_hand', input: { sku: 'BOLT-M8' } })
    // Arguments that do not parse reach the loop as null, never as an exception.
    assert.equal(events[4].input, null)
    const end = events.at(-1)
    assert.equal(end.stopReason, 'tool_use')
    assert.deepEqual(end.content, [
      { type: 'text', text: 'Let me check.' },
      { type: 'tool_use', id: 'call_a', name: 'stock_on_hand', input: { sku: 'BOLT-M8' } },
      { type: 'tool_use', id: 'call_b', name: 'attention_list', input: {} },
    ])
    assert.deepEqual(end.usage, { input_tokens: 300, output_tokens: 30, cache_read_input_tokens: 600, cache_creation_input_tokens: 0 })
  } finally {
    await stub.close()
  }
})

test('the chat completions client reports failures and a stop the same way as the SDK client', async () => {
  const busy = await chatStub({ status: 402, body: { error: 'over budget' } })
  try {
    await assert.rejects(collect(createChatCompletionsModelClient(chatEnv(busy.endpoint)).stream(request(), undefined)), (error) => error instanceof AssistantModelError && error.status === 402 && error.budgetExceeded === true)
  } finally {
    await busy.close()
  }
  const odd = await chatStub({ body: { nothing: true } })
  try {
    await assert.rejects(collect(createChatCompletionsModelClient(chatEnv(odd.endpoint)).stream(request(), undefined)), (error) => error.reason === 'malformed_output')
  } finally {
    await odd.close()
  }
  const finished = await chatStub({ body: { choices: [{ finish_reason: 'length', message: { content: 'Partial' } }] } })
  try {
    const stopped = new AbortController()
    stopped.abort()
    await assert.rejects(collect(createChatCompletionsModelClient(chatEnv(finished.endpoint)).stream(request(), stopped.signal)), (error) => error.name === 'AbortError')
    const events = await collect(createChatCompletionsModelClient(chatEnv(finished.endpoint)).stream(request(), undefined))
    assert.equal(events.at(-1).stopReason, 'max_tokens')
    assert.equal(events.at(-1).usage, null)
  } finally {
    await finished.close()
  }
})

test('a stop or a dropped connection while the chat reply arrives is not bad output', async () => {
  // The reply's headers and the start of its body arrive, then the rest is
  // held back, or on the /drop path the connection drops.
  const sockets = new Set()
  const slow = http.createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.write('{"choices":[')
      if (req.url.startsWith('/drop/')) setTimeout(() => res.destroy(), 50)
    })
  })
  slow.on('connection', (socket) => sockets.add(socket))
  await new Promise((resolve) => slow.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${slow.address().port}`
  try {
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 100)
    await assert.rejects(collect(createChatCompletionsModelClient(chatEnv(`${origin}/v1/chat/completions`)).stream(request(), controller.signal)), (error) => error.name === 'AbortError')
    const dropped = createChatCompletionsModelClient(chatEnv(`${origin}/drop/v1/chat/completions`))
    await assert.rejects(collect(dropped.stream(request(), new AbortController().signal)), (error) => error instanceof AssistantModelError && error.reason === 'network_error')
  } finally {
    for (const socket of sockets) socket.destroy()
    await new Promise((resolve) => slow.close(resolve))
  }

  // A stop after the first event ends the stream there.
  const stub = await chatStub({ body: { choices: [{ finish_reason: 'tool_calls', message: { content: 'Let me check.', tool_calls: [{ id: 'call_a', type: 'function', function: { name: 'attention_list', arguments: '{}' } }] } }] } })
  try {
    const controller = new AbortController()
    const seen = []
    await assert.rejects(async () => {
      for await (const event of createChatCompletionsModelClient(chatEnv(stub.endpoint)).stream(request(), controller.signal)) {
        seen.push(event)
        controller.abort()
      }
    }, (error) => error.name === 'AbortError')
    assert.deepEqual(seen.map((event) => event.type), ['text_delta'])
  } finally {
    await stub.close()
  }
})

// A localhost chat completions server that streams: reply(body, index) gives
// { status, frames } for an event stream (each frame one data line, written
// with a pause between frames), { status, body } for a whole JSON reply, or
// { drop } to write frames and then cut the connection.
async function chatStreamStub(reply) {
  const requests = []
  const sockets = new Set()
  const server = http.createServer(async (req, res) => {
    let raw = ''
    for await (const chunk of req) raw += chunk
    const record = { headers: req.headers, body: JSON.parse(raw), closed: false }
    requests.push(record)
    res.on('close', () => { record.closed = true })
    const answer = reply(record.body, requests.length - 1)
    if (answer.body !== undefined) {
      res.writeHead(answer.status || 200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(answer.body))
      return
    }
    res.writeHead(answer.status || 200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    for (const frame of answer.frames) {
      if (record.closed) return
      res.write(typeof frame === 'string' ? frame : `data: ${JSON.stringify(frame)}\n\n`)
      await new Promise((resolve) => setTimeout(resolve, answer.delayMs ?? 1))
    }
    if (answer.drop) res.destroy()
    else res.end()
  })
  server.on('connection', (socket) => sockets.add(socket))
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    endpoint: `http://127.0.0.1:${server.address().port}/v1/chat/completions`,
    requests,
    close: () => new Promise((resolve) => { for (const socket of sockets) socket.destroy(); server.close(resolve) }),
  }
}
const chunk = (delta, extra = {}) => ({ id: 'chatcmpl-1', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: null }], ...extra })
const finish = (reason) => ({ id: 'chatcmpl-1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: reason }] })
// Usage as Parley reports it for a Claude model: the cache reads and writes
// beside prompt_tokens, and all of them in total_tokens.
const PARLEY_USAGE = { prompt_tokens: 4, completion_tokens: 59, total_tokens: 2870, prompt_tokens_details: { cache_read_input_tokens: 2807, cache_write_input_tokens: 0 } }
const TOOL_STREAM = [
  chunk({ role: 'assistant', content: 'Let me ' }),
  chunk({ content: 'check.' }),
  chunk({ tool_calls: [{ index: 0, id: 'call_a', type: 'function', function: { name: 'stock_on_hand', arguments: '' } }] }),
  chunk({ tool_calls: [{ index: 0, function: { arguments: '{"sku":' } }] }),
  chunk({ tool_calls: [{ index: 0, function: { arguments: '"BOLT-M8"}' } }] }),
  chunk({ tool_calls: [{ index: 1, id: 'call_b', type: 'function', function: { name: 'attention_list', arguments: '{}' } }] }),
  finish('tool_calls'),
  { id: 'chatcmpl-1', object: 'chat.completion.chunk', choices: [], usage: PARLEY_USAGE },
  'data: [DONE]\n\n',
]

test('the chat completions client streams: text by delta, tool calls from their pieces, usage from the stream', async () => {
  const stub = await chatStreamStub(() => ({ frames: TOOL_STREAM }))
  try {
    const client = createChatCompletionsModelClient(chatEnv(stub.endpoint))
    const events = await collect(client.stream(request(), new AbortController().signal))
    const [sent] = stub.requests
    assert.equal(sent.body.stream, true)
    assert.deepEqual(sent.body.stream_options, { include_usage: true })
    assert.deepEqual(events.map((event) => event.type), [
      'text_delta', 'text_delta', 'tool_use_start', 'tool_input_delta', 'tool_input_delta', 'tool_use_start', 'tool_input_delta',
      'tool_use_end', 'tool_use_end', 'message_end',
    ])
    assert.deepEqual(events.filter((event) => event.type === 'text_delta').map((event) => event.text), ['Let me ', 'check.'])
    assert.deepEqual(events[2], { type: 'tool_use_start', id: 'call_a', name: 'stock_on_hand' })
    assert.deepEqual(events.filter((event) => event.type === 'tool_input_delta' && event.id === 'call_a').map((event) => event.partialJson), ['{"sku":', '"BOLT-M8"}'])
    assert.deepEqual(events[7], { type: 'tool_use_end', id: 'call_a', name: 'stock_on_hand', input: { sku: 'BOLT-M8' } })
    assert.deepEqual(events[8], { type: 'tool_use_end', id: 'call_b', name: 'attention_list', input: {} })
    const end = events.at(-1)
    assert.equal(end.stopReason, 'tool_use')
    assert.deepEqual(end.content, [
      { type: 'text', text: 'Let me check.' },
      { type: 'tool_use', id: 'call_a', name: 'stock_on_hand', input: { sku: 'BOLT-M8' } },
      { type: 'tool_use', id: 'call_b', name: 'attention_list', input: {} },
    ])
    assert.deepEqual(end.usage, { input_tokens: 4, output_tokens: 59, cache_read_input_tokens: 2807, cache_creation_input_tokens: 0 })

    // Text alone, cut by the output limit, and no usage in the stream.
    const short = await chatStreamStub(() => ({ frames: [chunk({ content: 'Partial' }), finish('length'), 'data: [DONE]\n\n'] }))
    try {
      const partial = await collect(createChatCompletionsModelClient(chatEnv(short.endpoint)).stream(request(), undefined))
      assert.deepEqual(partial.map((event) => event.type), ['text_delta', 'message_end'])
      assert.deepEqual([partial.at(-1).stopReason, partial.at(-1).usage, partial.at(-1).content], ['max_tokens', null, [{ type: 'text', text: 'Partial' }]])
    } finally {
      await short.close()
    }
  } finally {
    await stub.close()
  }
})

test('a provider that refuses to stream is asked again without it, and is not asked to stream again', async () => {
  const whole = { choices: [{ finish_reason: 'stop', message: { content: 'Twelve are left.' } }], usage: { prompt_tokens: 900, completion_tokens: 5, total_tokens: 905 } }
  const stub = await chatStreamStub((body) => (body.stream ? { status: 400, body: { error: { message: 'stream is not supported' } } } : { body: whole }))
  try {
    const client = createChatCompletionsModelClient(chatEnv(stub.endpoint))
    const events = await collect(client.stream(request(), undefined))
    assert.deepEqual(events.map((event) => event.type), ['text_delta', 'message_end'])
    assert.equal(events[0].text, 'Twelve are left.')
    assert.deepEqual(stub.requests.map((entry) => Boolean(entry.body.stream)), [true, false])
    assert.equal('stream_options' in stub.requests[1].body, false)
    // A later answer on the same endpoint goes straight to the whole reply.
    await collect(createChatCompletionsModelClient(chatEnv(stub.endpoint)).stream(request(), undefined))
    assert.deepEqual(stub.requests.map((entry) => Boolean(entry.body.stream)), [true, false, false])
  } finally {
    await stub.close()
  }
  // A request refused either way is the provider's error, and streaming is
  // tried again next time.
  const broken = await chatStreamStub(() => ({ status: 400, body: { error: { message: 'bad request' } } }))
  try {
    await assert.rejects(collect(createChatCompletionsModelClient(chatEnv(broken.endpoint)).stream(request(), undefined)), (error) => error instanceof AssistantModelError && error.status === 400)
    await assert.rejects(collect(createChatCompletionsModelClient(chatEnv(broken.endpoint)).stream(request(), undefined)), (error) => error.status === 400)
    assert.deepEqual(broken.requests.map((entry) => Boolean(entry.body.stream)), [true, false, true, false])
  } finally {
    await broken.close()
  }
})

test('a streamed reply that breaks off, reports an error or is stopped fails the same way as the other clients', async () => {
  // The connection drops mid-stream: a network error.
  const dropped = await chatStreamStub(() => ({ frames: [chunk({ content: 'Let me ' })], drop: true }))
  try {
    await assert.rejects(collect(createChatCompletionsModelClient(chatEnv(dropped.endpoint)).stream(request(), undefined)), (error) => error instanceof AssistantModelError && error.reason === 'network_error')
  } finally {
    await dropped.close()
  }
  // The stream ends with neither a finish reason nor [DONE]: bad output.
  const cut = await chatStreamStub(() => ({ frames: [chunk({ content: 'Let me ' })] }))
  try {
    await assert.rejects(collect(createChatCompletionsModelClient(chatEnv(cut.endpoint)).stream(request(), undefined)), (error) => error instanceof AssistantModelError && error.reason === 'malformed_output')
  } finally {
    await cut.close()
  }
  // An error the provider sends inside the stream.
  const overloaded = await chatStreamStub(() => ({ frames: [chunk({ content: 'Let me ' }), { error: { type: 'overloaded_error', message: 'Overloaded' } }] }))
  try {
    await assert.rejects(collect(createChatCompletionsModelClient(chatEnv(overloaded.endpoint)).stream(request(), undefined)), (error) => error instanceof AssistantModelError && error.reason === 'non_success_status' && error.errorType === 'overloaded_error')
  } finally {
    await overloaded.close()
  }
  // A stop after the first event: nothing more reaches the loop, and the
  // connection is closed before the rest is sent.
  const slow = await chatStreamStub(() => ({ frames: TOOL_STREAM, delayMs: 40 }))
  try {
    const controller = new AbortController()
    const seen = []
    await assert.rejects(async () => {
      for await (const event of createChatCompletionsModelClient(chatEnv(slow.endpoint)).stream(request(), controller.signal)) {
        seen.push(event)
        controller.abort()
      }
    }, (error) => error.name === 'AbortError')
    assert.deepEqual(seen.map((event) => event.type), ['text_delta'])
    await new Promise((resolve) => setTimeout(resolve, 100))
    assert.equal(slow.requests[0].closed, true)
  } finally {
    await slow.close()
  }
})

test('prompt caching on the chat path: the system message carries the marker on Parley for Claude models', () => {
  const parley = 'https://parley.api.mit.edu/v1/chat/completions'
  assert.equal(assistantV2ChatCaching({}, { endpoint: parley, model: 'claude-sonnet-5-5' }), true)
  assert.equal(assistantV2ChatCaching({}, { endpoint: parley, model: 'gpt-5.5' }), false)
  assert.equal(assistantV2ChatCaching({}, { endpoint: 'https://opencode.ai/zen/go/v1/chat/completions', model: 'claude-haiku-5-5' }), false)
  assert.equal(assistantV2ChatCaching({ FLOWCHAIN_AI_ASSISTANT_CHAT_CACHE: 'on' }, { endpoint: 'http://127.0.0.1:9/v1/chat/completions', model: 'claude-haiku-5-5' }), true)
  assert.equal(assistantV2ChatCaching({ FLOWCHAIN_AI_ASSISTANT_CHAT_CACHE: 'off' }, { endpoint: parley, model: 'claude-sonnet-5-5' }), false)
  const cached = buildAssistantV2ChatRequest(request(), { model: 'claude-sonnet-5-5', effort: 'none', cache: true })
  assert.deepEqual(cached.messages[0], { role: 'system', content: [{ type: 'text', text: 'You are the FlowChain assistant.', cache_control: { type: 'ephemeral' } }] })
  assert.deepEqual(buildAssistantV2ChatRequest(request(), { model: 'deepseek-v4.1-flash', effort: 'none' }).messages[0], { role: 'system', content: 'You are the FlowChain assistant.' })
  // Cache reads and writes in either convention, priced apart from the rest.
  assert.deepEqual(assistantV2ChatUsage({ usage: PARLEY_USAGE }), { input_tokens: 4, output_tokens: 59, cache_read_input_tokens: 2807, cache_creation_input_tokens: 0 })
  assert.deepEqual(assistantV2ChatUsage({ usage: { prompt_tokens: 4, completion_tokens: 59, total_tokens: 2870, prompt_tokens_details: { cache_read_input_tokens: 0, cache_write_input_tokens: 2807 } } }), { input_tokens: 4, output_tokens: 59, cache_read_input_tokens: 0, cache_creation_input_tokens: 2807 })
  assert.deepEqual(assistantV2ChatUsage({ usage: { prompt_tokens: 900, completion_tokens: 30, total_tokens: 930, prompt_tokens_details: { cached_tokens: 600 } } }), { input_tokens: 300, output_tokens: 30, cache_read_input_tokens: 600, cache_creation_input_tokens: 0 })
  assert.equal(assistantV2ChatUsage({}), null)
})

test('withdrawn tools are left out of a chat request and stay in a Messages request', () => {
  const chat = buildAssistantV2ChatRequest(request({ withdrawnTools: ['attention_list'] }), { model: 'deepseek-v4.1-flash', effort: 'none' })
  assert.deepEqual(chat.tools.map((tool) => tool.function.name), ['stock_on_hand'])
  const none = buildAssistantV2ChatRequest(request({ withdrawnTools: ['attention_list', 'stock_on_hand'] }), { model: 'deepseek-v4.1-flash', effort: 'none' })
  assert.equal('tools' in none, false)
  assert.equal('tool_choice' in none, false)
  const messages = buildAssistantV2MessagesRequest(request({ withdrawnTools: ['attention_list'] }), { model: 'claude-sonnet-5-5', effort: 'low' })
  assert.deepEqual(messages.tools.map((tool) => tool.name), ['attention_list', 'stock_on_hand'])
})

test('the model check script calls inside a usage scope, so a provider that routes by session gets its header', async () => {
  // OpenCode Go refuses a call without x-opencode-session (400 MissingSessionID).
  const stub = await chatStreamStub((body, index) => {
    if (!stub.requests[index].headers['x-opencode-session']) return { status: 400, body: { error: { type: 'MissingSessionID' } } }
    return body.messages.some((message) => message.role === 'tool')
      ? { frames: [chunk({ content: 'It is 2 November.' }), finish('stop'), 'data: [DONE]\n\n'] }
      : { frames: [chunk({ tool_calls: [{ index: 0, id: 'call_clock', type: 'function', function: { name: 'workspace_clock', arguments: '{}' } }] }), finish('tool_calls'), 'data: [DONE]\n\n'] }
  })
  const directory = mkdtempSync(join(tmpdir(), 'flowchain-model-check-'))
  const envFile = join(directory, 'provider.env')
  writeFileSync(envFile, [
    'FLOWCHAIN_AI_RUNTIME_MODE=provider_assisted', 'FLOWCHAIN_AI_PROVIDER_KIND=deepseek_chat', `FLOWCHAIN_AI_PROVIDER_ENDPOINT=${stub.endpoint}`,
    `FLOWCHAIN_AI_PROVIDER_API_KEY=${KEY}`, 'FLOWCHAIN_AI_PROVIDER_MODEL=claude-haiku-5-5', 'FLOWCHAIN_AI_PROVIDER_SESSION_HEADER=x-opencode-session',
  ].join('\n'))
  try {
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('FLOWCHAIN_')))
    const script = new URL('../../scripts/assistant-v2-model-check.mjs', import.meta.url)
    const output = await new Promise((resolve, reject) => execFile(process.execPath, [script.pathname.replace(/^\/([A-Za-z]:)/, '$1'), `--provider-env=${envFile}`], { env, timeout: 30000 }, (error, stdout, stderr) => (error ? reject(new Error(`${error.message}\n${stdout}\n${stderr}`)) : resolve(stdout))))
    assert.match(output, /Client: chat_completions, model claude-haiku-5-5/)
    assert.match(output, /Call 1: .*stop reason tool_use/)
    assert.match(output, /Call 2: .*stop reason end_turn/)
    assert.doesNotMatch(output, new RegExp(`${KEY}|127\\.0\\.0\\.1`), 'never the key or the endpoint')
    const sessions = stub.requests.map((entry) => entry.headers['x-opencode-session'])
    assert.equal(sessions.length, 2)
    assert.ok(sessions.every((value) => /^[0-9a-f-]{36}$/.test(value)))
    assert.equal(sessions[0], sessions[1], 'one session for the run')
  } finally {
    rmSync(directory, { recursive: true, force: true })
    await stub.close()
  }
})

test('OpenCode Go and Parley endpoints are refused in production', () => {
  assert.equal(isLocalOnlyProviderEndpoint('https://parley.api.mit.edu/v1/chat/completions'), true)
  assert.equal(isLocalOnlyProviderEndpoint('https://opencode.ai/zen/go/v1/chat/completions'), true)
  assert.equal(isLocalOnlyProviderEndpoint('https://api.anthropic.com/v1/messages'), false)
  const parley = chatEnv('https://parley.api.mit.edu/v1/chat/completions', { FLOWCHAIN_AI_PROVIDER_KIND: 'parley_chat' })
  assert.equal(createAssistantV2ModelClient(parley).kind, 'chat_completions')
  assert.throws(() => createAssistantV2ModelClient({ ...parley, NODE_ENV: 'production' }), (error) => error.reason === 'local_only_provider')
  const proxied = providerEnv('https://opencode.ai/zen/go/v1/messages', { NODE_ENV: 'production' })
  assert.throws(() => createAssistantV2ModelClient(proxied), (error) => error.reason === 'local_only_provider')
  assert.equal(createAssistantV2ModelClient(providerEnv('https://api.anthropic.com/v1/messages', { NODE_ENV: 'production' })).kind, 'anthropic_messages')
})

test('the environment chooses the client', () => {
  const dir = mkdtempSync(join(tmpdir(), 'flowchain-assistant-v2-model-'))
  try {
    const file = join(dir, 'turns.json')
    writeFileSync(file, JSON.stringify([[{ type: 'text_delta', text: 'Hello.' }]]))
    assert.equal(createAssistantV2ModelClient({ ...providerEnv('https://api.anthropic.com/v1/messages'), FLOWCHAIN_AI_ASSISTANT_SCRIPTED: file }).kind, 'scripted')
    writeFileSync(file, JSON.stringify({ turns: [] }))
    assert.throws(() => createAssistantV2ModelClient({ FLOWCHAIN_AI_ASSISTANT_SCRIPTED: file }), /list of turns/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
  const sdk = createAssistantV2ModelClient(providerEnv('https://api.anthropic.com/v1/messages'))
  assert.equal(sdk.kind, 'anthropic_messages')
  assert.equal(sdk.model, 'claude-sonnet-5-5')
  assert.equal(createAssistantV2ModelClient(chatEnv('http://127.0.0.1:9/v1/chat/completions')).kind, 'chat_completions')
  assert.equal(createAssistantV2ModelClient({}), null)
  assert.equal(createAssistantV2ModelClient(providerEnv('https://api.anthropic.com/v1/messages', { FLOWCHAIN_AI_RUNTIME_MODE: 'local' })), null)
  assert.equal(createAssistantV2ModelClient(providerEnv('https://api.anthropic.com/v1/messages', { FLOWCHAIN_AI_PROVIDER_API_KEY: '' })), null)
})

test('the scripted client replays one turn per call and records the requests', async () => {
  const client = createScriptedModelClient([
    TOOL_ROUND,
    [{ type: 'text_delta', text: 'There are ' }, { type: 'text_delta', text: '12 left.' }],
  ])
  const first = await collect(client.stream(request(), undefined))
  assert.deepEqual(first, completeScriptedTurn(TOOL_ROUND))
  assert.equal(first[0].stopReason, 'tool_use')
  // A replayed event cannot change the recording.
  first[0].content.length = 0
  assert.equal(completeScriptedTurn(TOOL_ROUND)[0].content.length, 3)

  const second = await collect(client.stream(request({ messages: [] }), undefined))
  assert.deepEqual(second.at(-1), { type: 'message_end', stopReason: 'end_turn', usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, content: [{ type: 'text', text: 'There are 12 left.' }] })
  assert.equal(client.requests.length, 2)
  assert.deepEqual(client.requests[1].messages, [])

  await assert.rejects(collect(client.stream(request(), undefined)), (error) => error instanceof AssistantModelError && error.reason === 'malformed_output')

  const stopped = new AbortController()
  const replay = createScriptedModelClient([[{ type: 'text_delta', text: 'One' }, { type: 'tool_use_start', id: 't1', name: 'attention_list' }, { type: 'tool_use_end', id: 't1', name: 'attention_list', input: {} }]])
  const seen = []
  await assert.rejects(async () => {
    for await (const event of replay.stream(request(), stopped.signal)) {
      seen.push(event)
      stopped.abort()
    }
  }, (error) => error.name === 'AbortError')
  assert.deepEqual(seen, [{ type: 'text_delta', text: 'One' }])
})

test('a script keyed by question picks each turn from the request, whatever client replays it', async () => {
  const script = {
    'How many M8 bolts are left?': [TOOL_ROUND, [{ type: 'text_delta', text: 'There are 12 left.' }]],
    'And the washers?': [[{ type: 'text_delta', text: 'No washers on hand.' }]],
  }
  const firstRound = { role: 'assistant', content: TOOL_ROUND[0].content }
  const toolResult = { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: '{"onHand":12}' }] }
  const answered = [{ role: 'user', content: 'How many M8 bolts are left?' }, firstRound, toolResult]

  // The call count plays no part: the question and the rounds after it pick
  // the turn, and the question matches whatever its case or spacing.
  assert.equal(scriptedTurnFor(script, request(), 5), TOOL_ROUND)
  assert.equal(scriptedTurnFor(script, request({ messages: answered }), 0), script['How many M8 bolts are left?'][1])
  const later = [...answered, { role: 'assistant', content: [{ type: 'text', text: 'There are 12 left.' }] }, { role: 'user', content: [{ type: 'text', text: '  and the   WASHERS? ' }] }]
  const events = await collect(createScriptedModelClient(script).stream(request({ messages: later }), undefined))
  assert.equal(events[0].text, 'No washers on hand.')
  // A question with no recording, or a round past the recording, fails as bad output.
  assert.equal(scriptedTurnFor(script, request({ messages: [{ role: 'user', content: 'Something else?' }] }), 0), undefined)
  await assert.rejects(collect(createScriptedModelClient(script).stream(request({ messages: [...answered, { role: 'assistant', content: 'Done.' }, toolResult] }), undefined)), (error) => error.reason === 'malformed_output')

  // The localhost Messages server and the environment take the same form.
  const server = await startScriptedMessagesServer(script)
  try {
    const client = createAnthropicSdkModelClient(providerEnv(server.endpoint), { maxRetries: 0 })
    const second = await collect(client.stream(request({ messages: answered }), undefined))
    assert.equal(second.filter((event) => event.type === 'text_delta').map((event) => event.text).join(''), 'There are 12 left.')
  } finally {
    await server.close()
  }
  const dir = mkdtempSync(join(tmpdir(), 'flowchain-assistant-v2-model-'))
  try {
    const file = join(dir, 'script.json')
    writeFileSync(file, JSON.stringify(script))
    const replayed = await collect(createAssistantV2ModelClient({ FLOWCHAIN_AI_ASSISTANT_SCRIPTED: file }).stream(request(), undefined))
    assert.equal(replayed.at(-1).stopReason, 'tool_use')
    writeFileSync(file, JSON.stringify({ 'How many M8 bolts are left?': [{ type: 'text_delta', text: 'Not a list of turns.' }] }))
    assert.throws(() => createAssistantV2ModelClient({ FLOWCHAIN_AI_ASSISTANT_SCRIPTED: file }), /list of turns/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a scripted pause holds the replay until its time is up or the call is stopped', async () => {
  const turn = [{ type: 'text_delta', text: 'Here is ' }, { type: 'pause', ms: 30 }, { type: 'text_delta', text: 'the rest.' }]
  const started = Date.now()
  const events = await collect(createScriptedModelClient([turn]).stream(request(), undefined))
  assert.ok(Date.now() - started >= 25)
  assert.deepEqual(events.map((event) => event.type), ['text_delta', 'text_delta', 'message_end'])
  assert.deepEqual(events.at(-1).content, [{ type: 'text', text: 'Here is the rest.' }])

  const stopped = new AbortController()
  const seen = []
  const held = Date.now()
  await assert.rejects(async () => {
    for await (const event of createScriptedModelClient([[turn[0], { type: 'pause', ms: 50000 }, turn[2]]]).stream(request(), stopped.signal)) {
      seen.push(event)
      setTimeout(() => stopped.abort(), 10)
    }
  }, (error) => error.name === 'AbortError')
  assert.ok(Date.now() - held < 5000)
  assert.deepEqual(seen, [turn[0]])
})

test('a scripted turn built from tool events ends in tool use', () => {
  const [, , end] = completeScriptedTurn([{ type: 'tool_use_start', id: 't1', name: 'attention_list' }, { type: 'tool_use_end', id: 't1', name: 'attention_list', input: null }])
  assert.deepEqual(end, { type: 'message_end', stopReason: 'tool_use', usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, content: [{ type: 'tool_use', id: 't1', name: 'attention_list', input: {} }] })
})
