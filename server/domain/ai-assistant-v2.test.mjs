import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { aiSkillScenario } from './test-fixtures/ai-skill-scenario.mjs'
import { aiCallCostMicros, aiUsagePrices, runWithAiUsageScope } from './ai-usage-meter.mjs'
import { createScriptedModelClient } from './ai-assistant-v2-model/scripted.mjs'
import { createChatCompletionsModelClient } from './ai-assistant-v2-model/chat-completions.mjs'
import { AssistantModelError } from './ai-assistant-v2-model/model-error.mjs'
import { aiSkillText } from './ai-skill-copy.mjs'
import { ASSISTANT_V2_LIMITS, ASSISTANT_V2_SYSTEM, answerAssistantV2 } from './ai-assistant-v2.mjs'
import { AI_ASSISTANT_V2_UI_TOOLS } from './ai-assistant-v2-ui-tools.mjs'
import { safeParseStreamEvent } from '../../shared/assistant-protocol.mjs'

// The assistant v2 loop (docs/ai-assistant-v2-design.md §3.3, §3.7, §3.9,
// §3.11) against the scripted model client and the fixture workspace: each
// test lists the model's turns in call order, and the client records every
// request the loop sent.

const ENV = Object.freeze({ FLOWCHAIN_AI_PROVIDER_MODEL: 'claude-sonnet-5-5' })
const USAGE = Object.freeze({ input_tokens: 1000, output_tokens: 50, cache_read_input_tokens: 3000 })
const say = (...pieces) => pieces.map((piece) => ({ type: 'text_delta', text: piece }))
const call = (id, name, input) => [{ type: 'tool_use_start', id, name }, { type: 'tool_use_end', id, name, input }]
const end = (usage = USAGE) => ({ type: 'message_end', usage })
const OVERDUE = [...call('tu_po', 'list_purchase_orders', { status: 'overdue' }), end()]
const LAST_ROUND_NOTE = 'No more tool calls are available for this answer, display tools and suggest_followups included. Answer now from these results, in prose.'

// A UI tool as the UI tools module defines one: cards for the records the
// model picks from an earlier result of this answer, by reference.
const showRecords = Object.freeze({
  name: 'show_records',
  kind: 'ui',
  description: 'Shows a few records of an earlier result as cards.',
  inputSchema: { type: 'object', properties: { source: { type: 'string', maxLength: 120 }, refs: { type: 'array', items: { type: 'string', maxLength: 120 }, maxItems: 6 } }, required: ['source', 'refs'], additionalProperties: false },
  build(input, ctx) {
    const stored = ctx.results.get(input.source)
    if (!stored) return { error: { code: 'source_not_found', message: 'No result of this answer has that id.' } }
    const rows = stored.output.rows.filter((row) => input.refs.includes(row.ref.id))
    if (!rows.length) return { error: { code: 'refs_not_in_source', message: 'None of these refs is in that result.' } }
    return { component: 'records', props: { source: input.source, cards: rows.map((row) => ({ ref: row.ref, title: row.supplier })) }, refs: rows.map((row) => row.ref) }
  },
})

// Follow-up chips: the model's own words, as the UI tools module passes them.
const followups = Object.freeze({
  name: 'suggest_followups',
  kind: 'ui',
  description: 'Offers follow-up questions.',
  inputSchema: { type: 'object', properties: { questions: { type: 'array', items: { type: 'string', maxLength: 90 }, maxItems: 3 } }, required: ['questions'], additionalProperties: false },
  build: (input) => ({ component: 'followups', props: { questions: input.questions }, refs: [] }),
})

async function ask(turns, { roleKey = 'workspace-administrator', question = 'Which purchase orders are overdue?', thread = { messages: [], results: new Map() }, uiTools = [showRecords], limits, signal, onEvent, client, body = {} } = {}) {
  const scenario = aiSkillScenario({ roleKey })
  const modelClient = client || createScriptedModelClient(turns)
  const events = []
  const metered = []
  const outcome = await runWithAiUsageScope((usage) => { metered.push(usage) }, () => answerAssistantV2({ ...scenario.ctx, env: ENV }, { threadId: 'thr_test', message: question, answerLanguage: 'en-US', ...body }, {
    emit: (event) => { events.push(event); onEvent?.(event) }, signal, modelClient, uiTools, thread, limits,
  }))
  return { ...outcome, events, metered, client: modelClient, scenario, thread }
}

const types = (events) => events.map((event) => event.type)
const ofType = (events, type) => events.filter((event) => event.type === type)
const lastToolResults = (request) => request.messages.at(-1).content.filter((block) => block.type === 'tool_result')
// Every event is valid on the wire once the transport numbers it.
const assertProtocol = (events) => events.forEach((event, seq) => assert.ok(safeParseStreamEvent({ v: 2, seq, ...event }).success, JSON.stringify(event).slice(0, 300)))

test('text streams as deltas in order, the start comes first and the answer last', async () => {
  const { events, body, audit, client } = await ask([[...say('PO-001 is ', '4 days overdue', ' and PO-008 is 2.'), end()]], { question: 'Which purchase orders are overdue? PO-001 and PO-008?' })
  assertProtocol(events)
  assert.equal(events[0].type, 'start')
  assert.equal(events[0].threadId, 'thr_test')
  assert.equal(events[0].language, 'en-US')
  assert.equal(events[0].model, 'scripted')
  assert.equal(events.at(-1).type, 'answer')
  assert.equal(events.at(-1).status, 200)
  // Text is sent up to its last word break, so no figure leaves in pieces.
  assert.deepEqual(ofType(events, 'text_delta').map((event) => event.text), ['PO-001 is ', '4 days ', 'overdue and PO-008 is ', '2.'])
  assert.ok(ofType(events, 'text_delta').every((event) => event.partId === 'p1'))
  assert.equal(body.version, 'v2')
  assert.equal(body.intent, 'assistant_v2')
  assert.equal(body.answerSource, 'assistant_v2')
  assert.equal(body.conclusion.summary, 'PO-001 is 4 days overdue and PO-008 is 2.')
  assert.equal(body.conclusion.title, 'PO-001 is 4 days overdue and PO-008 is 2.')
  assert.deepEqual(body.parts, [{ id: 'p1', type: 'text' }])
  assert.deepEqual(body.aiModelAccess, { status: 'on' })
  assert.equal(audit.stopReason, 'end_turn')
  // The first request: the frozen system prompt, the turn's context, then the question alone.
  const [request] = client.requests
  assert.equal(request.system, ASSISTANT_V2_SYSTEM)
  assert.equal(request.maxTokens, ASSISTANT_V2_LIMITS.outputTokens)
  assert.equal(request.messages.length, 2)
  assert.match(request.messages[0].content[0].text, /"answerLanguage":"en-US","today":"2026-09-29"/)
  assert.deepEqual(request.messages[1].content, [{ type: 'text', text: 'Which purchase orders are overdue? PO-001 and PO-008?' }])
  assert.ok(!request.tools.some((tool) => /create|submit|approve|update|delete/.test(tool.name)), 'no write tool is offered')
  assert.ok(request.tools.some((tool) => tool.name === 'suggest_purchase_lines'), 'the v2 data tools are offered')
  assert.deepEqual(request.tools.find((tool) => tool.name === 'show_records').input_schema, showRecords.inputSchema)
})

test('a data tool, then a UI tool on its result: the part shows where the model called it', async () => {
  const { events, body, audit, client, thread } = await ask([
    OVERDUE,
    [...say('Two orders are overdue.'), ...call('tu_show', 'show_records', { source: 'tu_po', refs: ['PO-001', 'PO-008'] }), end()],
    [...say('PO-001 is the oldest.'), end()],
  ])
  assertProtocol(events)
  const order = events.filter((event) => ['tool', 'progress', 'text_delta', 'ui', 'flag'].includes(event.type)).map((event) => `${event.type}:${event.partId || event.name || event.step}${event.state ? `:${event.state}` : ''}`)
  assert.deepEqual(order, [
    'tool:list_purchase_orders:running', 'progress:reading', 'tool:list_purchase_orders:done',
    'progress:writing', 'text_delta:p1', 'text_delta:p1', 'flag:p1', 'tool:show_records:running', 'ui:p2', 'tool:show_records:done',
    'progress:writing', 'text_delta:p3', 'text_delta:p3', 'flag:p3',
  ])
  assert.equal(ofType(events, 'tool').find((event) => event.state === 'done').rows, 2)
  const ui = ofType(events, 'ui')[0]
  assert.equal(ui.component, 'records')
  assert.equal(ui.schemaVersion, 1)
  assert.deepEqual(ui.props.cards.map((card) => card.ref.id), ['PO-001', 'PO-008'])
  assert.deepEqual(ui.refs.map((ref) => ref.id), ['PO-001', 'PO-008'])
  assert.deepEqual(body.parts, [{ id: 'p1', type: 'text' }, { id: 'p2', type: 'ui', component: 'records' }, { id: 'p3', type: 'text' }])
  assert.equal(body.conclusion.summary, 'Two orders are overdue.\n\nPO-001 is the oldest.')
  assert.deepEqual(body.keyEvidence.map((row) => row.entityId), ['PO-001', 'PO-008'])
  assert.deepEqual(body.navigationLinks.map((row) => row.entityId), ['PO-001', 'PO-008'])
  // The transcript: each assistant message unchanged, each tool result after it.
  const third = client.requests[2].messages
  assert.deepEqual(third.slice(2).map((message) => message.role), ['assistant', 'user', 'assistant', 'user'])
  assert.equal(third[2].content[0].type, 'tool_use')
  assert.equal(JSON.parse(lastToolResults(client.requests[1])[0].content).rows.length, 2)
  assert.deepEqual(JSON.parse(lastToolResults(client.requests[2])[0].content), { shown: 'records', partId: 'p2' })
  assert.equal(thread.messages.length, 7)
  assert.deepEqual([...thread.results.keys()], ['tu_po'])
  // Codes only: no question, no figures, no key that reads like a secret.
  assert.deepEqual(audit.tools, [{ tool: 'list_purchase_orders', status: 'ok' }])
  assert.deepEqual(audit.uiTools, [{ tool: 'show_records', status: 'ok', component: 'records' }])
  assert.equal(audit.rounds, 2)
  assert.equal(audit.modelCalls, 3)
  assert.deepEqual(audit.usage, { input: 12000, output: 150, cacheRead: 9000, cacheWrite: 0 })
  assert.equal(audit.costMicros, 3 * aiCallCostMicros({ inputTokens: 4000, outputTokens: 50, cacheReadTokens: 3000 }, aiUsagePrices(ENV)))
  const keys = []
  JSON.stringify(audit, (key, value) => { keys.push(key); return value })
  assert.ok(!keys.some((key) => /token/i.test(key)))
  assert.doesNotMatch(JSON.stringify(audit), /overdue|PO-00|Acme/)
})

test('invalid tool input goes back to the model as an error result', async () => {
  const { events, audit, client } = await ask([
    [...call('tu_bad', 'list_purchase_orders', { status: 'late', colour: 'red' }), ...call('tu_none', 'show_records', { refs: ['PO-001'] }), ...call('tu_unknown', 'create_purchase_order', { sku: 'LDM-001' }), end()],
    [...say('I could not read that.'), end()],
  ])
  assertProtocol(events)
  const results = lastToolResults(client.requests[1])
  assert.deepEqual(results.map((block) => block.is_error), [true, true, true])
  assert.equal(JSON.parse(results[0].content).error, 'invalid_arguments')
  assert.deepEqual(JSON.parse(results[1].content), { error: 'invalid_arguments', details: ['missing argument source'] })
  assert.equal(JSON.parse(results[2].content).error, 'unknown_tool')
  assert.deepEqual(ofType(events, 'tool').filter((event) => event.state !== 'running').map((event) => `${event.name}:${event.state}`), ['show_records:error', 'list_purchase_orders:error', 'create_purchase_order:error'])
  assert.equal(ofType(events, 'ui').length, 0)
  assert.deepEqual(audit.tools.map((row) => row.status), ['invalid_arguments', 'unknown_tool'])
  // A UI tool whose source is not a result of this answer: the builder's code and message.
  const missing = await ask([[...call('tu_show', 'show_records', { source: 'tu_elsewhere', refs: ['PO-001'] }), end()], [...say('Sorry.'), end()]])
  assert.deepEqual(JSON.parse(lastToolResults(missing.client.requests[1])[0].content), { error: 'source_not_found', details: ['No result of this answer has that id.'] })
  // A part that breaks the protocol is never shown.
  const broken = { ...showRecords, build: () => ({ component: 'records', props: { cards: [] }, refs: [] }) }
  const invalid = await ask([OVERDUE, [...call('tu_show', 'show_records', { source: 'tu_po', refs: ['PO-001'] }), end()], [...say('Done.'), end()]], { uiTools: [broken] })
  assert.equal(JSON.parse(lastToolResults(invalid.client.requests[2])[0].content).error, 'invalid_part')
  assert.equal(ofType(invalid.events, 'ui').length, 0)
})

test('the round limit: after the last round the model must answer, and a further call stops the loop', async () => {
  const { events, audit, client, thread } = await ask([
    OVERDUE,
    [...call('tu_po2', 'list_purchase_orders', {}), end()],
    [...call('tu_po3', 'stock_position', {}), end()],
  ], { limits: { rounds: 2 } })
  assertProtocol(events)
  assert.equal(client.requests.length, 3)
  assert.equal(client.requests[2].messages.at(-1).content.at(-1).text, LAST_ROUND_NOTE)
  assert.equal(audit.rounds, 2)
  assert.equal(audit.stopReason, 'limits')
  assert.deepEqual(ofType(events, 'error'), [{ type: 'error', code: 'limits', retryable: false }])
  assert.equal(events.at(-1).type, 'answer')
  // The refused call still has its result, so the thread stays valid.
  assert.equal(JSON.parse(thread.messages.at(-1).content[0].content).error, 'call_limit')
  // Follow-up chips asked for after the last round do not spoil an answer
  // already written: it ends without an error.
  const chips = await ask([
    OVERDUE,
    [...say('PO-001 is late.'), ...call('tu_more', 'suggest_followups', { questions: ['Which supplier is it?'] }), end()],
  ], { limits: { rounds: 1 }, uiTools: [showRecords, followups] })
  assertProtocol(chips.events)
  assert.equal(ofType(chips.events, 'error').length, 0)
  assert.equal(chips.audit.stopReason, 'end_turn')
  assert.equal(chips.body.conclusion.summary, 'PO-001 is late.')
  assert.equal(chips.client.requests.length, 2)
})

test('the tool call limit: calls past it get an error result, in the order the model wrote them', async () => {
  const { client, audit } = await ask([
    [...call('tu_a', 'list_purchase_orders', {}), ...call('tu_b', 'stock_position', {}), ...call('tu_c', 'list_suppliers', {}), end()],
    [...say('Here is what I found.'), end()],
  ], { limits: { toolCalls: 2 } })
  const results = lastToolResults(client.requests[1])
  assert.deepEqual(results.map((block) => block.tool_use_id), ['tu_a', 'tu_b', 'tu_c'])
  assert.deepEqual(results.map((block) => Boolean(block.is_error)), [false, false, true])
  assert.equal(JSON.parse(results[2].content).error, 'call_limit')
  assert.deepEqual(audit.tools.map((row) => row.tool), ['list_purchase_orders', 'stock_position'])
  assert.equal(client.requests[1].messages.at(-1).content.at(-1).type, 'text', 'the last-round note follows the results')
})

test('the cost ceiling and the monthly cap stop the loop after a model call that crosses them', async () => {
  // 60,000 input and 9,000 output tokens at Sonnet 5.5 prices: 0.21 USD, over the 0.20 ceiling.
  const heavy = { input_tokens: 60000, output_tokens: 9000 }
  const ceiling = await ask([[...say('Let me check.'), ...call('tu_po', 'list_purchase_orders', {}), end(heavy)], [...say('Never sent.'), end()]])
  assertProtocol(ceiling.events)
  assert.equal(ceiling.client.requests.length, 1)
  assert.deepEqual(ofType(ceiling.events, 'notice'), [{ type: 'notice', code: 'cost_ceiling' }])
  assert.equal(ofType(ceiling.events, 'tool').filter((event) => event.state !== 'running').length, 0, 'the round\'s tools never run')
  assert.equal(ceiling.audit.stopReason, 'cost_ceiling')
  assert.equal(ceiling.audit.costMicros, 210000)
  assert.equal(ceiling.metered.length, 1)
  assert.equal(ceiling.body.conclusion.summary, 'Let me check.')
  assert.equal(ceiling.thread.messages.at(-1).content[0].is_error, true)
})

test('each call is priced before it is made: no call that could pass the ceiling or the cap, and the last call that fits answers in prose', async () => {
  // 40,000 input and 5,000 output tokens at Sonnet 5.5 prices: 0.13 USD,
  // under the 0.20 ceiling, so the round's tools run. The next call would
  // send at least those 40,000 tokens again, with up to 4,000 tokens of
  // output: about 0.12 USD more, which does not fit.
  const big = { input_tokens: 40000, output_tokens: 5000 }
  const ceiling = await ask([[...say('Let me check.'), ...call('tu_po', 'list_purchase_orders', {}), end(big)], [...say('Never sent.'), end()]])
  assertProtocol(ceiling.events)
  assert.equal(ceiling.client.requests.length, 1)
  assert.deepEqual(ofType(ceiling.events, 'tool').filter((event) => event.state === 'done').map((event) => event.name), ['list_purchase_orders'])
  assert.deepEqual(ofType(ceiling.events, 'notice'), [{ type: 'notice', code: 'cost_ceiling' }])
  assert.equal(ceiling.audit.stopReason, 'cost_ceiling')
  assert.equal(ceiling.audit.costMicros, 130000)
  assert.ok(ceiling.audit.costMicros <= ASSISTANT_V2_LIMITS.costCeilingMicros)
  assert.equal(ceiling.body.conclusion.summary, 'Let me check.')
  // The same answer with less left of the monthly cap than of the ceiling.
  const cap = await ask([[...say('Let me check.'), ...call('tu_po', 'list_purchase_orders', {}), end(big)], [...say('Never sent.'), end()]], { limits: { capRemainingMicros: 150000 } })
  assert.deepEqual(ofType(cap.events, 'notice'), [{ type: 'notice', code: 'over_cap_during_answer' }])
  assert.equal(cap.audit.stopReason, 'over_cap_during_answer')
  assert.equal(cap.client.requests.length, 1)
  // Not even the first call fits: nothing is called.
  const none = await ask([[...say('Never sent.'), end()]], { limits: { capRemainingMicros: 3000 } })
  assert.equal(none.client.requests.length, 0)
  assert.deepEqual(ofType(none.events, 'notice'), [{ type: 'notice', code: 'over_cap_during_answer' }])
  assert.equal(none.events.at(-1).type, 'answer')
  // 25,000 input and 1,000 output tokens: 0.06 USD. One more call fits, but
  // not a call after it, so the next call is the last and answers in prose.
  const mid = { input_tokens: 25000, output_tokens: 1000 }
  const last = await ask([[...call('tu_po', 'list_purchase_orders', {}), end(mid)], [...say('PO-001 is the most overdue.'), ...call('tu_more', 'stock_position', {}), end()]])
  assertProtocol(last.events)
  assert.equal(last.client.requests.length, 2)
  assert.equal(last.client.requests[1].messages.at(-1).content.at(-1).text, LAST_ROUND_NOTE)
  assert.equal(last.audit.lastRoundForCost, true)
  assert.equal(ofType(last.events, 'notice').length, 0)
  assert.equal(JSON.parse(last.thread.messages.at(-1).content[0].content).error, 'call_limit', 'a call after the last round is refused')
  assert.equal(last.body.conclusion.summary, 'PO-001 is the most overdue.')
  // Cheap calls leave the answer its rounds.
  const cheap = await ask([OVERDUE, [...say('PO-001 is late.'), end()]])
  assert.equal(cheap.audit.lastRoundForCost, false)
  assert.equal(cheap.client.requests[1].messages.at(-1).content.at(-1).type, 'tool_result')
})

test('the estimate prices as cached only what the provider cached of the last prompt', async () => {
  // Usage as Parley reports a Claude call on the chat path, where only the
  // tools and the system prompt are cached: 12,000 tokens read, 60,000 not
  // (0.125 USD). The next call sends those 60,000 again at the full price,
  // with up to 4,000 tokens of output: it does not fit.
  const chat = await ask([
    [...call('tu_po', 'list_purchase_orders', { status: 'overdue' }), end({ input_tokens: 60000, cache_read_input_tokens: 12000, output_tokens: 300 })],
    [...say('Never sent.'), end({ input_tokens: 61000, cache_read_input_tokens: 12000, output_tokens: 2500 })],
  ])
  assertProtocol(chat.events)
  assert.equal(chat.client.requests.length, 1)
  assert.deepEqual(ofType(chat.events, 'notice'), [{ type: 'notice', code: 'cost_ceiling' }])
  assert.equal(chat.audit.costMicros, 125400)
  // A later question of a thread on the chat path, 40,000 tokens a call with
  // a quarter of them cached: one more call fits, not two, so the next call
  // is the last and answers in prose, within the ceiling.
  const later = await ask([
    [...call('tu_po', 'list_purchase_orders', { status: 'overdue' }), end({ input_tokens: 30000, cache_read_input_tokens: 10000, output_tokens: 300 })],
    [...say('PO-001 is the most overdue.'), end({ input_tokens: 31000, cache_read_input_tokens: 10000, output_tokens: 1500 })],
  ])
  assert.equal(later.client.requests.length, 2)
  assert.equal(later.audit.lastRoundForCost, true)
  assert.equal(later.client.requests[1].messages.at(-1).content.at(-1).text, LAST_ROUND_NOTE)
  assert.ok(later.audit.costMicros <= ASSISTANT_V2_LIMITS.costCeilingMicros)
  // The same prompt cached whole, as the SDK client caches the conversation,
  // leaves the answer its rounds.
  const sdk = await ask([
    [...call('tu_po', 'list_purchase_orders', { status: 'overdue' }), end({ input_tokens: 500, cache_read_input_tokens: 30000, cache_creation_input_tokens: 9500, output_tokens: 300 })],
    [...say('PO-001 is the most overdue.'), end()],
  ])
  assert.equal(sdk.audit.lastRoundForCost, false)
  assert.equal(sdk.client.requests[1].messages.at(-1).content.at(-1).type, 'tool_result')
})

test('a call the provider reports no usage for is metered by estimate, so the ceiling still holds', async () => {
  // Scripted: every call ends without usage, as a stream without its usage chunk.
  const none = { type: 'message_end', usage: null }
  const scripted = await ask([[...call('tu_po', 'list_purchase_orders', { status: 'overdue' }), none], [...say('PO-001 is late.'), none]])
  assert.equal(scripted.audit.usageEstimated, 2)
  assert.ok(scripted.audit.costMicros > 0)
  assert.equal(scripted.metered.length, 2)
  assert.ok(scripted.metered.every((usage) => usage.inputTokens > 1000 && usage.outputTokens > 0))
  assert.ok(scripted.metered[1].inputTokens > scripted.metered[0].inputTokens, 'the second call sends the first call\'s result too')

  // The chat completions client against a localhost stub that streams tool
  // calls with no usage chunk, until the last-round note asks for prose.
  const requests = []
  const server = http.createServer(async (req, res) => {
    let raw = ''
    for await (const chunk of req) raw += chunk
    const body = JSON.parse(raw)
    requests.push(body)
    const last = body.messages.at(-1)
    const delta = last.role === 'user' && /No more tool calls/.test(last.content)
      ? { content: 'PO-001 is the most overdue.' }
      : { tool_calls: [{ index: 0, id: `call_${requests.length}`, type: 'function', function: { name: 'list_purchase_orders', arguments: '{}' } }] }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`)
    res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: delta.content ? 'stop' : 'tool_calls' }] })}\n\n`)
    res.end('data: [DONE]\n\n')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const client = createChatCompletionsModelClient({
      FLOWCHAIN_AI_RUNTIME_MODE: 'provider_assisted', FLOWCHAIN_AI_PROVIDER_KIND: 'deepseek_chat', FLOWCHAIN_AI_PROVIDER_ENDPOINT: `http://127.0.0.1:${server.address().port}/v1/chat/completions`,
      FLOWCHAIN_AI_PROVIDER_API_KEY: 'placeholder-key', FLOWCHAIN_AI_PROVIDER_MODEL: 'claude-sonnet-5-5',
    })
    const ceiling = 100000
    const chat = await ask(null, { client, limits: { costCeilingMicros: ceiling } })
    assertProtocol(chat.events)
    assert.ok(requests.length < ASSISTANT_V2_LIMITS.rounds, 'the cost stopped the answer, not the round limit')
    assert.equal(chat.audit.usageEstimated, requests.length)
    assert.ok(chat.audit.costMicros > 0 && chat.audit.costMicros <= ceiling, String(chat.audit.costMicros))
    assert.equal(chat.audit.lastRoundForCost, true)
    assert.ok(chat.metered.every((usage) => usage.inputTokens > 0))
    assert.equal(chat.body.conclusion.summary, 'PO-001 is the most overdue.')
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

test('a long thread is sent its latest turns only, as many as leave room for two calls', async () => {
  // Ten earlier turns, each with a list result of 24,000 characters.
  const rows = Array.from({ length: 160 }, (_, at) => ({ orderNumber: `PO-${String(at).padStart(4, '0')}`, supplier: 'Acme Components Limited', status: 'issued', expectedDate: '2026-10-01' }))
  const big = JSON.stringify({ source: 'list_purchase_orders#1', rows }).slice(0, 24000)
  const messages = []
  for (let turn = 0; turn < 10; turn += 1) {
    messages.push(
      { role: 'user', content: [{ type: 'text', text: 'Which orders are open?' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: `tu_${turn}`, name: 'list_purchase_orders', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: `tu_${turn}`, content: big }] },
      { role: 'assistant', content: [{ type: 'text', text: 'Here they are.' }] },
    )
  }
  const { client, events, audit, body, thread } = await ask([[...say('PO-001 is overdue.'), end()]], { thread: { messages, results: new Map() } })
  assertProtocol(events)
  assert.equal(client.requests.length, 1)
  assert.equal(ofType(events, 'notice').length, 0)
  assert.equal(body.conclusion.summary, 'PO-001 is overdue.')
  const sent = client.requests[0].messages
  assert.ok(audit.turnsLeftOut > 0 && audit.turnsLeftOut < 10, String(audit.turnsLeftOut))
  assert.equal(sent.length, (10 - audit.turnsLeftOut) * 4 + 2)
  assert.deepEqual(sent[0].content, [{ type: 'text', text: 'Which orders are open?' }], 'the transcript starts at a turn')
  assert.equal(sent.at(-1).content[0].text, 'Which purchase orders are overdue?')
  // The thread keeps every turn; only what is sent is shorter.
  assert.equal(thread.messages.length, 40 + 3)
  // A short thread is sent whole.
  const short = await ask([[...say('PO-001 is overdue.'), end()]], { thread: { messages: messages.slice(0, 4), results: new Map() } })
  assert.equal(short.audit.turnsLeftOut, 0)
  assert.equal(short.client.requests[0].messages.length, 6)
})

test('each data result the model reads starts with its source and gives status words; the stored result keeps its codes', async () => {
  const { client, thread, events } = await ask([
    [...call('tu_po', 'list_purchase_orders', { status: 'overdue' }), ...call('tu_stock', 'stock_position', {}), ...call('tu_po_all', 'list_purchase_orders', {}), end()],
    [...call('tu_table', 'show_table', { source: 'list_purchase_orders#1', columns: ['orderNumber', 'status'] }), ...call('tu_latest', 'show_table', { source: 'functions.list_purchase_orders', columns: ['orderNumber'] }), ...call('tu_id', 'show_records', { source: 'tu_stock', refs: [{ type: 'item', id: 'ITEM-001' }] }), end()],
    [...say('PO-001 is partially received.'), end()],
  ], { uiTools: AI_ASSISTANT_V2_UI_TOOLS })
  assertProtocol(events)
  const [overdue, stock, all] = lastToolResults(client.requests[1]).map((block) => JSON.parse(block.content))
  assert.equal(overdue.source, 'list_purchase_orders#1')
  assert.equal(stock.source, 'stock_position#1')
  assert.equal(all.source, 'list_purchase_orders#2')
  assert.equal(Object.keys(overdue)[0], 'source', 'the source comes first')
  assert.deepEqual(overdue.rows.map((row) => [row.status, row.statusLabel]), [['partially_received', 'Partially received'], ['issued', 'Issued to the supplier']])
  assert.equal(stock.rows[0].statusLabel, 'Below safety stock')
  assert.ok(thread.results.get('tu_po').output.rows.every((row) => !('statusLabel' in row) && !('source' in thread.results.get('tu_po').output)))
  // The handle, the tool's name (its latest result) and the tool_use id all find their result.
  const tables = ofType(events, 'ui')
  assert.deepEqual(tables.map((event) => event.component), ['table', 'table', 'records'])
  assert.equal(tables[0].props.rows.length, 2)
  assert.equal(tables[1].props.total, all.total)
  assert.deepEqual(tables[2].props.cards.map((card) => card.ref.label), ['LDM-001'])
  // A Chinese answer gets the words in Chinese.
  const zh = await ask([OVERDUE, [...say('PO-001 部分收货。'), end()]], { question: '哪些采购订单逾期了？', body: { answerLanguage: 'zh-CN' } })
  assert.deepEqual(JSON.parse(lastToolResults(zh.client.requests[1])[0].content).rows.map((row) => row.statusLabel), ['部分收货', '已发给供应商'])
})

test('a failed display says how to fix it; a second failure withdraws the display tools for the rest of the answer', async () => {
  const { client, events, audit, body } = await ask([
    OVERDUE,
    [...call('tu_bad', 'show_table', { source: 'tu_po_missing', columns: ['orderNumber'] }), end()],
    [...call('tu_bad2', 'show_table', { source: 'list_purchase_orders#1', columns: ['price'] }), end()],
    [...say('PO-001 and PO-008 are overdue.'), ...call('tu_bad3', 'show_records', { source: 'list_purchase_orders#1', refs: [{ type: 'purchase_order', id: 'PO-001' }] }), end()],
    [...say('PO-001 is the older of the two.'), end()],
  ], { uiTools: AI_ASSISTANT_V2_UI_TOOLS })
  assertProtocol(events)
  assert.equal(client.requests.length, 5)
  const first = JSON.parse(lastToolResults(client.requests[2])[0].content)
  assert.equal(first.error, 'source_missing')
  assert.deepEqual(first.details, [
    'No data result of this answer is called tu_po_missing. Pass source exactly as a result gives it: list_purchase_orders#1.',
    'Correct this call once, or answer in prose. After another failed display no display tool is available for this answer.',
  ])
  const second = JSON.parse(lastToolResults(client.requests[3])[0].content)
  assert.equal(second.error, 'unknown_column')
  assert.equal(second.details.at(-1), 'No display tool is available for the rest of this answer.')
  assert.match(client.requests[3].messages.at(-1).content.at(-1).text, /^No display tool \(show_table, show_records, show_chart, show_kpis, offer_choices, show_setup_steps\) is available for the rest of this answer\. Answer in prose/)
  // The tool list the model was first sent stays (the cached prefix); the
  // withdrawn tools are named beside it.
  assert.deepEqual(client.requests[3].tools, client.requests[0].tools)
  assert.equal(client.requests[2].withdrawnTools, undefined)
  assert.deepEqual(client.requests[3].withdrawnTools, ['show_table', 'show_records', 'show_chart', 'show_kpis', 'offer_choices', 'show_setup_steps'])
  // A display called after that is refused, not counted, and the model gets
  // the refusal and one more call, its last, to answer in prose.
  assert.deepEqual(JSON.parse(lastToolResults(client.requests[4])[0].content), { error: 'display_off', details: ['No display tool is available for the rest of this answer.'] })
  assert.equal(client.requests[4].messages.at(-1).content.at(-1).text, LAST_ROUND_NOTE)
  assert.deepEqual(audit.uiTools.map((row) => row.status), ['source_missing', 'unknown_column', 'display_off'])
  assert.equal(audit.displayFailures, 2)
  assert.equal(audit.stopReason, 'end_turn')
  assert.equal(ofType(events, 'ui').length, 0)
  assert.equal(ofType(events, 'error').length, 0)
  assert.equal(body.conclusion.summary, 'PO-001 and PO-008 are overdue.\n\nPO-001 is the older of the two.')

  // The model retries a display after the withdrawal with no text written
  // yet: the round of refused displays still gets its last call, and the
  // prose is the answer, with no error.
  const retried = [
    OVERDUE,
    [...call('tu_bad', 'show_table', { source: 'nope', columns: ['orderNumber'] }), end()],
    [...call('tu_bad2', 'show_table', { source: 'list_purchase_orders#1', columns: ['price'] }), end()],
    [...call('tu_bad3', 'show_table', { source: 'list_purchase_orders#1', columns: ['orderNumber'] }), end()],
  ]
  const silent = await ask([...retried, [...say('PO-001 and PO-008 are overdue.'), end()]], { uiTools: AI_ASSISTANT_V2_UI_TOOLS })
  assertProtocol(silent.events)
  assert.equal(silent.client.requests.length, 5)
  assert.equal(silent.client.requests[4].messages.at(-1).content.at(-1).text, LAST_ROUND_NOTE)
  assert.equal(silent.audit.stopReason, 'end_turn')
  assert.equal(ofType(silent.events, 'error').length, 0)
  assert.equal(silent.body.conclusion.summary, 'PO-001 and PO-008 are overdue.')
  // A call after that last call still ends the answer with the limits error.
  const stubborn = await ask([...retried, [...call('tu_bad4', 'show_table', { source: 'list_purchase_orders#1', columns: ['orderNumber'] }), end()]], { uiTools: AI_ASSISTANT_V2_UI_TOOLS })
  assert.equal(stubborn.client.requests.length, 5)
  assert.equal(JSON.parse(stubborn.thread.messages.at(-1).content[0].content).error, 'call_limit')
  assert.deepEqual(ofType(stubborn.events, 'error'), [{ type: 'error', code: 'limits', retryable: false }])
})

test('one set of follow-up chips per answer: a later call replaces the earlier, the chips come after every other part, and chips after text end the answer', async () => {
  const { events, body, client } = await ask([
    [...say('Checking the orders.'), ...call('tu_chips', 'suggest_followups', { questions: ['Which supplier is late?'] }), ...call('tu_po', 'list_purchase_orders', { status: 'overdue' }), end()],
    [...say('PO-001 is the most overdue.'), ...call('tu_chips2', 'suggest_followups', { questions: ['Show PO-001'] }), end()],
    [...say('Ask me about either order.'), end()],
  ], { uiTools: [followups] })
  assertProtocol(events)
  const chips = ofType(events, 'ui')
  assert.deepEqual(chips.map((event) => [event.partId, event.props.questions[0]]), [['p2', 'Which supplier is late?'], ['p2', 'Show PO-001']])
  // The second round was text and the chips only: the answer ends there, and
  // the third turn is never asked for.
  assert.deepEqual(body.parts, [{ id: 'p1', type: 'text' }, { id: 'p3', type: 'text' }, { id: 'p2', type: 'ui', component: 'followups' }])
  assert.equal(client.requests.length, 2)
  assert.deepEqual(JSON.parse(lastToolResults(client.requests[1]).find((block) => block.tool_use_id === 'tu_chips').content), { shown: 'followups', partId: 'p2' })
})

test('the records a text names come with its flag, from this answer\'s results only', async () => {
  const { events } = await ask([OVERDUE, [...say('PO-001 and PO-008 are overdue; PO-002 is due soon. Acme Components supplies both.'), end()]])
  assertProtocol(events)
  const [flag] = ofType(events, 'flag')
  assert.deepEqual(flag.refs, [{ type: 'purchase_order', id: 'PO-001', label: 'PO-001' }, { type: 'purchase_order', id: 'PO-008', label: 'PO-008' }])
  assert.deepEqual(flag.spans, [{ text: 'PO-002', kind: 'record', reason: 'not_in_results' }])
  // A text that names no record of the results has no refs.
  const plain = await ask([OVERDUE, [...say('Two orders are overdue.'), end()]])
  assert.equal('refs' in ofType(plain.events, 'flag')[0], false)
  // A part with a record withheld still names the others.
  const withheld = await ask([OVERDUE, [...say('PO-001 is late, and so is PO-777 of Tenant B.'), end()]])
  assert.deepEqual(ofType(withheld.events, 'flag')[0].refs.map((ref) => ref.id), ['PO-001'])
  // A part replaced for a claim names none.
  const claim = await ask([OVERDUE, [...say('I submitted PO-001 for you.'), end()]])
  assert.equal(ofType(claim.events, 'replace')[0].code, 'unbacked_action_claim')
  assert.equal('refs' in ofType(claim.events, 'flag')[0], false)
  // Chinese text written against the number still names it, as the panel
  // matches it; a longer number is not the shorter one.
  const zh = { question: '哪些采购订单逾期了？', body: { answerLanguage: 'zh-CN' } }
  for (const [answer, named] of [['PO-001已逾期4天，PO-008也逾期了。', ['PO-001', 'PO-008']], ['采购订单PO-001部分收货。', ['PO-001']], ['PO-001 已逾期。', ['PO-001']]]) {
    const { events } = await ask([OVERDUE, [...say(answer), end()]], zh)
    assert.deepEqual(ofType(events, 'flag')[0].refs.map((ref) => ref.id), named, answer)
  }
  const longer = await ask([OVERDUE, [...say('PO-0011不在逾期列表中。'), end()]], { ...zh, question: '哪些采购订单逾期了？PO-0011呢？' })
  assert.equal(ofType(longer.events, 'replace').length, 0)
  assert.equal('refs' in ofType(longer.events, 'flag')[0], false)
  // A number written before its result arrives gets its chip once the result
  // is in: a further flag of that part, with those refs alone.
  const early = await ask([[...say('Let me look up PO-001.'), ...call('tu_one', 'get_purchase_order', { order: 'PO-001' }), end()], [...say('It is partially received.'), end()]], { question: 'What is the status of PO-001?' })
  assertProtocol(early.events)
  assert.deepEqual(ofType(early.events, 'flag').filter((event) => event.partId === 'p1').map((event) => [event.spans.length, (event.refs || []).map((ref) => ref.id)]), [[0, []], [0, ['PO-001']]])
  const order = early.events.map((event) => `${event.type}:${event.partId || event.name || event.step || ''}`)
  assert.ok(order.indexOf('flag:p1', order.indexOf('tool:get_purchase_order')) < order.indexOf('text_delta:p2'), 'the late flag comes before the next text')
})

test('the system prompt asks for the source handle, status words, one set of chips and no talk of tools', () => {
  assert.match(ASSISTANT_V2_SYSTEM, /starts with its source, such as "list_purchase_orders#1": pass that as source/)
  assert.match(ASSISTANT_V2_SYSTEM, /Never mention tools, displays, sources, ids, errors or retries to the user/)
  assert.match(ASSISTANT_V2_SYSTEM, /never as its code: where a result gives a label beside the code \(statusLabel/)
  assert.match(ASSISTANT_V2_SYSTEM, /suggest_followups, called once/)
  // Chips only when there is a next step (2026-11-04), never beside a question to the user.
  assert.match(ASSISTANT_V2_SYSTEM, /When the answer has a clear next step, end it with suggest_followups/)
  assert.match(ASSISTANT_V2_SYSTEM, /Leave the chips out when the answer itself asks the user something/)
  assert.doesNotMatch(ASSISTANT_V2_SYSTEM, /End every answer with suggest_followups/)
  assert.doesNotMatch(ASSISTANT_V2_SYSTEM, /tool_use id/)
})

test('stopping mid-stream ends the answer at once: no more events, calls or metering', async () => {
  const controller = new AbortController()
  let deltas = 0
  const { events, audit, metered, client, thread } = await ask([
    OVERDUE,
    [...say('PO-001 ', 'is ', 'late.'), ...call('tu_more', 'stock_position', {}), end()],
    [...say('Never sent.'), end()],
  ], { signal: controller.signal, onEvent: (event) => { if (event.type === 'text_delta' && ++deltas === 1) controller.abort() } })
  assert.equal(events.at(-1).type, 'text_delta')
  assert.equal(ofType(events, 'text_delta').length, 1)
  assert.equal(ofType(events, 'answer').length, 0)
  assert.equal(client.requests.length, 2)
  assert.equal(metered.length, 1, 'only the completed first call is metered')
  assert.equal(audit.aborted, true)
  assert.equal(audit.stopReason, 'aborted')
  assert.equal(audit.modelCalls, 1)
  // The stopped reply is not in the thread; the first round is.
  assert.equal(thread.messages.at(-1).role, 'user')
  assert.equal(thread.messages.length, 4)
  // Stopped before it starts: nothing is called.
  const early = new AbortController()
  early.abort()
  const none = await ask([[...say('Never sent.'), end()]], { signal: early.signal })
  assert.equal(none.events.length, 0)
  assert.equal(none.client.requests.length, 0)
})

// A long plan ran into the time limit mid-answer (2026-11-04): when two more
// calls as long as the last would not fit, the next call is the last.
test('the call before the wall-time limit is told it is the last, so the answer ends in prose', async () => {
  const turns = createScriptedModelClient([
    [...call('tu_po', 'list_purchase_orders', { status: 'overdue' }), end()],
    [...call('tu_po2', 'list_purchase_orders', { status: 'open' }), end()],
    [...say('PO-001 is 4 days overdue.'), end()],
  ])
  // Each call takes 200 ms: after the first, 200 + 2 × 200 fits in 700; after
  // the second, 400 + 2 × 200 does not, and the third ends by about 600.
  const paced = { model: 'scripted', requests: turns.requests, async *stream(request, signal) {
    await new Promise((resolve) => setTimeout(resolve, 200))
    yield* turns.stream(request, signal)
  } }
  const { events, audit } = await ask([], { client: paced, limits: { timeoutMs: 700 } })
  assert.equal(ofType(events, 'error').length, 0)
  assert.equal(turns.requests.length, 3)
  assert.ok(JSON.stringify(turns.requests[2].messages.at(-1)).includes(LAST_ROUND_NOTE))
  assert.equal(audit.lastRoundForUsage, true)
  assert.match(ofType(events, 'text_delta').map((event) => event.text).join(''), /PO-001 is 4 days overdue/)
})

test('the wall-time deadline stops a slow model call with a retryable error', async () => {
  const slow = { model: 'scripted', async *stream(_request, signal) {
    yield { type: 'text_delta', text: 'Reading your orders. ' }
    await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }))
    throw new DOMException('stopped', 'AbortError')
  } }
  const { events, audit, metered } = await ask([], { client: slow, limits: { timeoutMs: 30 } })
  assertProtocol(events)
  assert.deepEqual(ofType(events, 'error'), [{ type: 'error', code: 'timeout', retryable: true }])
  assert.equal(events.at(-1).type, 'answer')
  assert.equal(audit.stopReason, 'timeout')
  // The provider ran the stopped call, so the meter counts it.
  assert.deepEqual(metered, [null])
})

test('a provider failure before anything is shown leaves the answer to the rules; after text it ends with an error', async () => {
  const failing = (afterText) => ({ model: 'scripted', async *stream() {
    if (afterText) yield { type: 'text_delta', text: 'PO-001 is late. ' }
    throw new AssistantModelError('non_success_status', { status: 529 })
  } })
  const thread = { messages: [], results: new Map() }
  await assert.rejects(ask([], { client: failing(false), thread }), (error) => error instanceof AssistantModelError && error.audit.stopReason === 'provider_error')
  assert.deepEqual(thread.messages, [], 'the thread is left as it was')
  const late = await ask([], { client: failing(true) })
  assertProtocol(late.events)
  assert.deepEqual(ofType(late.events, 'error'), [{ type: 'error', code: 'non_success_status', retryable: true }])
  assert.equal(late.events.at(-1).type, 'answer')
  assert.equal(late.body.conclusion.summary, 'PO-001 is late.')
  // A failure in the second round after a round of tools only: the round's
  // results leave the thread with its messages, and the gateway is told that
  // status events already went out.
  const firstRound = createScriptedModelClient([OVERDUE])
  const rounds = { model: 'scripted', calls: 0, async *stream(request, signal) {
    this.calls += 1
    if (this.calls === 1) { yield* firstRound.stream(request, signal); return }
    throw new AssistantModelError('network_error')
  } }
  const second = { messages: [], results: new Map() }
  await assert.rejects(ask([], { client: rounds, thread: second }), (error) => error instanceof AssistantModelError && error.emitted === true)
  assert.deepEqual(second.messages, [])
  assert.deepEqual([...second.results.keys()], [])
  // A stream that ends without its message is a provider failure too.
  await assert.rejects(ask([], { client: { model: 'scripted', async *stream() { yield { type: 'tool_use_start', id: 'tu_x', name: 'list_purchase_orders' } } } }), (error) => error instanceof AssistantModelError && error.reason === 'malformed_output')
  // A failure of the loop itself is not the provider's: not metered, no fallback audit.
  const metered = []
  const broken = { model: 'scripted', async *stream() { yield { type: 'text_delta', text: 'PO-001 ' }; throw new TypeError('loop bug') } }
  await assert.rejects(runWithAiUsageScope((usage) => { metered.push(usage) }, () => answerAssistantV2({ ...aiSkillScenario({}).ctx, env: ENV }, { message: 'Which orders are late?' }, { modelClient: broken })), (error) => error instanceof TypeError && !error.audit)
  assert.deepEqual(metered, [])
})

// The 2026-11-04 new-user test: 5 of 23 answers flagged a correct figure the
// user had already seen in an earlier answer, or had typed themselves.
test('a figure from an earlier result or an earlier question of the conversation is not flagged', async () => {
  const thread = { messages: [], results: new Map() }
  await ask([OVERDUE, [...say('PO-001 is 4 days overdue.'), end()]], { thread, question: 'Which purchase orders are overdue? We sell about 12 a day.' })
  const { events } = await ask([[...say('PO-001 is still 4 days overdue, and at 12 a day that matters; 37 is a guess.'), end()]], { thread, question: 'What does that mean for me?' })
  const spans = ofType(events, 'flag').flatMap((flag) => flag.spans)
  assert.deepEqual(spans, [{ text: '37', kind: 'number', reason: 'not_in_results' }])
  // Without the earlier turn the same words are flagged.
  const fresh = await ask([[...say('PO-001 is still 4 days overdue, and at 12 a day that matters.'), end()]], { question: 'What does that mean for me?' })
  assert.deepEqual(ofType(fresh.events, 'flag').flatMap((flag) => flag.spans.filter((span) => span.kind === 'number').map((span) => span.text)).sort(), ['12', '4 days'].sort())
})

// The same answer twice (2026-11-04, 2 of 23 answers): text, then the chips,
// then another call that wrote the text again.
test('the follow-up chips after the text end the answer without another model call', async () => {
  const { events, client, audit } = await ask([
    [...say('PO-001 is 4 days overdue.'), ...call('tu_chips', 'suggest_followups', { questions: ['Which supplier is it?'] }), end()],
    [...say('PO-001 is 4 days overdue.'), end()],
  ], { uiTools: [followups] })
  assert.equal(client.requests.length, 1)
  assert.equal(ofType(events, 'text_delta').map((event) => event.text).join(''), 'PO-001 is 4 days overdue.')
  assert.equal(ofType(events, 'ui').filter((event) => event.component === 'followups').length, 1)
  assert.equal(audit.stopReason, 'end_turn')
  // Chips before any text do not end it: the answer is still to come.
  const early = await ask([
    [...call('tu_chips', 'suggest_followups', { questions: ['Which supplier is it?'] }), end()],
    [...say('PO-001 is overdue.'), end()],
  ], { uiTools: [followups] })
  assert.equal(early.client.requests.length, 2)
  assert.match(ofType(early.events, 'text_delta').map((event) => event.text).join(''), /PO-001 is overdue/)
})

// A month's plan written out twice (2026-11-04): text, then a round of parts
// with the chips, then another call that wrote the plan again.
test('a round of shown parts with the chips, after the text, ends the answer', async () => {
  const { client, body } = await ask([
    OVERDUE,
    [...say('PO-001 and PO-008 are overdue.'), ...call('tu_cards', 'show_records', { source: 'tu_po', refs: ['PO-001'] }), ...call('tu_chips', 'suggest_followups', { questions: ['Which supplier is it?'] }), end()],
    [...say('PO-001 and PO-008 are overdue.'), end()],
  ], { uiTools: [showRecords, followups] })
  assert.equal(client.requests.length, 2)
  assert.deepEqual(body.parts.map((part) => part.type), ['text', 'ui', 'ui'])
  // A part that failed keeps the answer going, so the model can correct it.
  const failed = await ask([
    OVERDUE,
    [...say('PO-001 is overdue.'), ...call('tu_cards', 'show_records', { source: 'tu_none', refs: ['PO-001'] }), ...call('tu_chips', 'suggest_followups', { questions: ['Which supplier is it?'] }), end()],
    [...call('tu_cards2', 'show_records', { source: 'tu_po', refs: ['PO-001'] }), end()],
    [...say('Here it is.'), end()],
  ], { uiTools: [showRecords, followups] })
  assert.ok(failed.client.requests.length >= 3)
})

// One sentence that read as an action took the whole part (2026-11-04): only
// that sentence goes now, and wording that describes a condition or what has
// not happened is no claim.
test('an unbacked claim takes only its own sentence; a condition or a negation is no claim', async () => {
  const { events, audit } = await ask([OVERDUE, [...say('PO-001 is 4 days overdue. I have approved PO-008. Chase Acme Components today.'), end()]])
  const [replace] = ofType(events, 'replace')
  assert.equal(replace.code, 'unbacked_action_claim')
  // The sentence goes without a note in the prose: the panel says under the
  // text that a sentence was left out (2026-11-05).
  assert.equal(replace.text, 'PO-001 is 4 days overdue. Chase Acme Components today.')
  assert.deepEqual(audit.replaces, ['unbacked_action_claim'])
  // The records the rest names still get their chips.
  assert.ok(ofType(events, 'flag').some((flag) => (flag.refs || []).some((ref) => ref.id === 'PO-001')))
  for (const sentence of ['Once the request has been approved, a buyer orders PO-001 again.', 'Nothing has been submitted yet for PO-001.', 'PO-001 has not been sent to the supplier.']) {
    const plain = await ask([OVERDUE, [...say(sentence), end()]])
    assert.equal(ofType(plain.events, 'replace').length, 0, sentence)
  }
  // Chinese keeps its punctuation; a list item left empty goes with its line.
  const zhAsk = { question: '哪些采购订单逾期了？', body: { answerLanguage: 'zh-CN' } }
  const zh = await ask([OVERDUE, [...say('PO-001 已逾期 4 天。我已经帮你提交了采购申请。请今天催 Acme Components。'), end()]], zhAsk)
  assert.equal(ofType(zh.events, 'replace')[0].text, 'PO-001 已逾期 4 天。请今天催 Acme Components。')
  const list = await ask([OVERDUE, [...say('Next:\n- Chase PO-001.\n- The new request was approved yesterday.'), end()]])
  assert.equal(ofType(list.events, 'replace')[0].text, 'Next:\n- Chase PO-001.')
  // In Chinese only the assistant acting is a claim: a state word that
  // describes records stays (2026-11-05: 已批准的采购订单 took its sentence).
  for (const sentence of ['已批准的采购订单还有 2 张没有发给供应商。', 'PO-001 部分收货，已下达且逾期的订单共 2 张。', '订单已取消的不计入逾期。']) {
    const plain = await ask([OVERDUE, [...say(sentence), end()]], zhAsk)
    assert.equal(ofType(plain.events, 'replace').length, 0, sentence)
  }
  for (const claim of ['PO-001 已逾期。我已为你付款。', 'PO-001 已逾期。已为你下单。', 'PO-001 已逾期。我帮你把订单取消了。']) {
    const { events } = await ask([OVERDUE, [...say(claim), end()]], zhAsk)
    assert.equal(ofType(events, 'replace')[0]?.text, 'PO-001 已逾期。', claim)
  }
  // A part that is nothing but a claim is sent empty, which the panel shows
  // as a short note; the folded answer keeps the fixed text.
  const whole = await ask([OVERDUE, [...say('I have approved PO-008.'), end()]])
  assert.equal(ofType(whole.events, 'replace')[0].text, '')
  assert.match(whole.body.conclusion.summary, /^This part of the answer is not shown/)
})

// A month's plan reached 103k of the 120k tokens with a call to go, most of it
// input read from the cache (2026-11-04).
test('cached input weighs a tenth toward the token cap, and the call before the cap is the last', async () => {
  const big = { input_tokens: 1000, output_tokens: 50, cache_read_input_tokens: 9000 }
  const turns = [
    [...call('tu_po', 'list_purchase_orders', { status: 'overdue' }), end(big)],
    [...call('tu_po2', 'list_purchase_orders', { status: 'open' }), end(big)],
    [...say('PO-001 is 4 days overdue.'), end(big)],
  ]
  // Counted whole, 10,050 tokens a call would end the answer with an error at
  // the third call; weighted, each call is about 1,950, and the third is told
  // it is the last.
  const { events, client, audit } = await ask(turns, { limits: { tokens: 7000 } })
  assert.equal(ofType(events, 'error').length, 0)
  assert.equal(client.requests.length, 3)
  assert.ok(lastToolResults(client.requests[2]) && JSON.stringify(client.requests[2].messages.at(-1)).includes(LAST_ROUND_NOTE))
  assert.equal(audit.lastRoundForUsage, true)
  assert.match(ofType(events, 'text_delta').map((event) => event.text).join(''), /PO-001 is 4 days overdue/)
  // Past the cap the answer still stops, with the error.
  const over = await ask(turns, { limits: { tokens: 1500 } })
  assert.deepEqual(ofType(over.events, 'error').map((event) => event.code), ['usage_limit'])
})

test('a figure the results do not hold is flagged, not dropped', async () => {
  const { events, body, audit } = await ask([OVERDUE, [...say('PO-001 is 4 days overdue; 37 orders are open, the oldest from Globex Supply.'), end()]])
  const flag = ofType(events, 'flag')[0]
  assert.equal(flag.partId, 'p1')
  assert.deepEqual(flag.spans, [{ text: '37', kind: 'number', reason: 'not_in_results' }])
  assert.equal(ofType(events, 'replace').length, 0)
  assert.match(body.conclusion.summary, /37 orders/)
  assert.equal(audit.flags, 1)
  assert.equal(types(events).indexOf('flag') < types(events).indexOf('answer'), true)
})

test('a claim that something was done is replaced with the fixed text', async () => {
  for (const claim of [
    'I submitted the request for LDM-001.', 'I have created a purchase order for you.', 'PO-008 was cancelled.', '我已为你提交采购申请。',
    'I created the request.', 'Your purchase request has been created.', 'I\'ve gone ahead and submitted it for approval.', 'I created the draft for LDM-001.',
  ]) {
    const { events, body, audit } = await ask([OVERDUE, [...say(claim), end()]])
    const replace = ofType(events, 'replace')
    assert.equal(replace.length, 1, claim)
    assert.equal(replace[0].code, 'unbacked_action_claim')
    assert.equal(replace[0].text, '')
    assert.equal(body.conclusion.summary, aiSkillText('assistant_v2.replace.action_claim', 'en-US'))
    assert.deepEqual(audit.replaces, ['unbacked_action_claim'])
  }
  // A state the record is in is its status, not a claim.
  const status = await ask([OVERDUE, [...say('PO-008 has been issued and is 2 days overdue.'), end()]])
  assert.equal(ofType(status.events, 'replace').length, 0)
  const REQUESTS = [...call('tu_prs', 'list_purchase_requests', { status: 'all' }), end()]
  const submitted = await ask([REQUESTS, [...say('PR-001 has been submitted.'), end()]], { question: 'Which requests are open?' })
  assert.equal(ofType(submitted.events, 'replace').length, 0)
  const draft = await ask([REQUESTS, [...say('PR-002 has been submitted.'), end()]], { question: 'Which requests are open?' })
  assert.equal(ofType(draft.events, 'replace')[0].code, 'unbacked_action_claim')
  // A follow-up chip that claims an action is refused; a question about a state is not.
  const chip = (question) => ask([OVERDUE, [...say('PO-001 is late.'), ...call('tu_chips', 'suggest_followups', { questions: [question] }), end()], [...say('Ask me more.'), end()]], { uiTools: [followups] })
  const claimChip = await chip('I\'ve submitted PO-001, want to see it?')
  assert.equal(JSON.parse(lastToolResults(claimChip.client.requests[2])[0].content).error, 'invalid_part')
  const stateChip = await chip('Which orders were approved last week?')
  assert.deepEqual(ofType(stateChip.events, 'ui').map((event) => event.props.questions), [['Which orders were approved last week?']])
  // Describing the form the answer opened is no claim.
  for (const form of [
    'I\'ve opened a purchase request form below for you to review.', 'I have opened a request form with LDM-001 ticked.',
    'I\'ve created a request form with LDM-001 for you to check.', '我已为你创建了一张采购申请表单，请核对后提交。', '我已为你创建了一份采购申请表单，请核对后提交。',
  ]) {
    const { events, body } = await ask([OVERDUE, [...say(form), end()]], { question: 'What should I reorder?' })
    assert.equal(ofType(events, 'replace').length, 0, form)
    assert.equal(body.conclusion.summary, form)
  }
})

test('a record no result of this workspace holds is withheld', async () => {
  const { events, body } = await ask([OVERDUE, [...say('PO-001 is late, and so is PO-777 of Tenant B.'), end()]])
  const [replace] = ofType(events, 'replace')
  assert.equal(replace.code, 'foreign_record')
  assert.equal(replace.text, 'PO-001 is late, and so is [not shown] of Tenant B.')
  assert.equal(body.conclusion.summary, replace.text)
  // A record of the workspace not read in this answer is only flagged.
  const flagged = await ask([OVERDUE, [...say('PO-002 is due soon.'), end()]])
  assert.equal(ofType(flagged.events, 'replace').length, 0)
  assert.deepEqual(ofType(flagged.events, 'flag')[0].spans, [{ text: 'PO-002', kind: 'record', reason: 'not_in_results' }])
  // A general term shaped like a record number is no record of this workspace.
  const general = 'Spend in Q3-2026 is up; a three-way match is common ISO-9001 practice.'
  const term = await ask([OVERDUE, [...say(general), end()]])
  assert.equal(ofType(term.events, 'replace').length, 0)
  assert.equal(term.body.conclusion.summary, general)
  assert.equal(term.audit.replaces.length, 0)
  // Written in fullwidth, the record is still withheld where it is written.
  const wide = await ask([OVERDUE, [...say('ＰＯ-777 is late.'), end()]])
  assert.equal(ofType(wide.events, 'replace')[0].text, '[not shown] is late.')
  // Withheld in one turn, it is not given in the next.
  const thread = { messages: [], results: new Map() }
  await ask([OVERDUE, [...say('PO-001 is late, and so is PO-777.'), end()]], { thread })
  const next = await ask([[...say('PO-777 is the second one.'), end()]], { thread, question: 'Which is the second?' })
  assert.equal(ofType(next.events, 'replace')[0].code, 'foreign_record')
  assert.equal(next.body.conclusion.summary, '[not shown] is the second one.')
  assert.ok(!ofType(next.events, 'text_delta').some((event) => event.text.includes('777')), 'the id never goes out in a delta')
})

test('a viewer gets no prices: the tools hide them, and an amount in the text is withheld', async () => {
  const { events, client, thread, body } = await ask([OVERDUE, [...say('PO-001 is worth $5,000 and 4 days overdue.'), end()]], { roleKey: 'read-only-viewer' })
  assertProtocol(events)
  const sent = JSON.parse(lastToolResults(client.requests[1])[0].content)
  assert.ok(sent.rows.every((row) => row.amount === null))
  assert.equal(sent.workspace.committedSpend, null)
  assert.ok(thread.results.get('tu_po').output.rows.every((row) => row.amount === null))
  assert.match(client.requests[0].messages[0].content[0].text, /"hiddenForRole":\{"sources":\[\],"amountsOn":\["purchase_orders","supplier_invoices"\]\}/)
  const [replace] = ofType(events, 'replace')
  assert.equal(replace.code, 'hidden_value')
  assert.equal(replace.text, 'PO-001 is worth [not shown] and 4 days overdue.')
  assert.doesNotMatch(body.conclusion.summary, /5,000/)
  assert.ok(!ofType(events, 'text_delta').some((event) => /5,000/.test(event.text)), 'the amount never goes out in a delta')
  // As a Chinese answer writes it: the fullwidth yen sign and fullwidth digits.
  for (const [written, shown] of [['PO-001 的金额为￥5,000。', 'PO-001 的金额为[不显示]。'], ['PO-001 金额 ５０００ 元，已逾期。', 'PO-001 金额 [不显示]，已逾期。']]) {
    const zh = await ask([OVERDUE, [...say(written), end()]], { roleKey: 'read-only-viewer', question: '哪些采购订单逾期了？', body: { answerLanguage: 'zh-CN' } })
    const [withheld] = ofType(zh.events, 'replace')
    assert.equal(withheld.code, 'hidden_value', written)
    assert.equal(withheld.text, shown)
    assert.equal(zh.body.conclusion.summary, shown)
    assert.ok(!ofType(zh.events, 'text_delta').some((event) => /5,000|５０００/.test(event.text)))
  }
  // Follow-up chips get the same scans before they are shown.
  const chips = await ask([OVERDUE, [...say('PO-001 is late.'), ...call('tu_chips', 'suggest_followups', { questions: ['Shall I chase PO-001 about the $5,000?'] }), end()], [...say('Ask me more.'), end()]], { roleKey: 'read-only-viewer', uiTools: [followups] })
  assert.equal(JSON.parse(lastToolResults(chips.client.requests[2])[0].content).error, 'invalid_part')
  assert.equal(ofType(chips.events, 'ui').length, 0)
  // The form is not offered to a role that cannot create purchase requests.
  const form = { ...followups, name: 'suggest_purchase_request' }
  const viewer = await ask([[...say('Ask a buyer.'), end()]], { roleKey: 'read-only-viewer', uiTools: [form] })
  assert.ok(!viewer.client.requests[0].tools.some((tool) => tool.name === 'suggest_purchase_request'))
  const buyer = await ask([[...say('Here it is.'), end()]], { uiTools: [form] })
  assert.ok(buyer.client.requests[0].tools.some((tool) => tool.name === 'suggest_purchase_request'))
  // An administrator's invented amount is only flagged.
  const admin = await ask([OVERDUE, [...say('PO-001 is worth $6,000.'), end()]])
  assert.equal(ofType(admin.events, 'replace').length, 0)
  assert.deepEqual(ofType(admin.events, 'flag')[0].spans.map((span) => span.kind), ['number'])
})

test('the thread carries to the next turn: the transcript, the results and the items the user named', async () => {
  const thread = { messages: [], results: new Map() }
  const named = []
  const recordNamed = { ...showRecords, build: (input, ctx) => { named.push(ctx.userNamedSkus); return showRecords.build(input, ctx) } }
  await ask([OVERDUE, [...say('PO-001 and PO-008 are overdue.'), end()]], { thread, question: 'Which orders for LDM-001 are overdue?' })
  assert.equal(thread.messages.length, 5)
  const second = await ask([
    [...call('tu_po_again', 'list_purchase_orders', { status: 'overdue' }), end()],
    [...call('tu_show', 'show_records', { source: 'tu_po_again', refs: ['PO-001'] }), end()],
    [...say('PO-001 is the oldest.'), end()],
  ], { thread, question: 'And the oldest one?', uiTools: [recordNamed] })
  const [request] = second.client.requests
  assert.equal(request.messages.length, 7)
  assert.deepEqual(request.messages.slice(0, 5), thread.messages.slice(0, 5))
  assert.deepEqual(request.messages[6].content, [{ type: 'text', text: 'And the oldest one?' }])
  assert.doesNotMatch(request.messages[5].content[0].text, /earlierTurns/)
  assert.deepEqual([...thread.results.keys()], ['tu_po', 'tu_po_again'])
  // An item named in an earlier turn is not ticked later; one named in the question is.
  assert.deepEqual(named, [[]])
  await ask([OVERDUE, [...call('tu_show_named', 'show_records', { source: 'tu_po', refs: ['PO-001'] }), end()], [...say('Here.'), end()]], { question: 'Reorder LDM-001', uiTools: [recordNamed] })
  assert.deepEqual(named, [[], ['LDM-001']])
  assert.equal(thread.messages.length, 12)
  // A record named in an earlier turn of this thread is no foreign record.
  const third = await ask([[...say('PO-008 was the other one.'), end()]], { thread, question: 'Which was the other?' })
  assert.equal(ofType(third.events, 'replace').length, 0)
  // After a restart the client's earlier turns are sent as context.
  const restarted = await ask([[...say('Yes.'), end()]], { body: { conversationContext: { previousTurns: [{ question: 'Which orders are late?', answer: 'PO-001 and PO-008.' }] } } })
  assert.match(restarted.client.requests[0].messages[0].content[0].text, /"earlierTurns":\[\{"question":"Which orders are late\?","answer":"PO-001 and PO-008."\}\]/)
})

// The 2026-11-04 new-user test: "Yes, go ahead with all of them" after a form
// left every line unticked. The items of the latest form are now agreed to;
// a SKU written next to Chinese characters counts as named.
test('a yes to the latest form ticks its items on the next form; a SKU next to CJK is named', async () => {
  const thread = { messages: [], results: new Map() }
  const form = (events) => ofType(events, 'ui').find((event) => event.component === 'pr_form')?.props
  const first = await ask([
    [...call('tu_lines', 'suggest_purchase_lines', { skus: ['LDM-001', 'LDM-002'] }), end()],
    [...call('tu_form', 'suggest_purchase_request', { source: 'tu_lines', from: 'suggestions' }), end()],
    [...say("I've filled in a request form for you to review."), end()],
  ], { thread, question: 'What should I reorder?', uiTools: AI_ASSISTANT_V2_UI_TOOLS })
  const offered = form(first.events)
  assert.ok(offered, JSON.stringify(types(first.events)))
  assert.deepEqual(offered.lines, [])
  assert.ok(offered.suggested.every((row) => row.checked === false))
  assert.deepEqual(thread.lastFormSkus, offered.suggested.map((row) => row.item.sku.toLowerCase()))
  const second = await ask([
    [...call('tu_lines2', 'suggest_purchase_lines', { skus: ['LDM-001', 'LDM-002'] }), end()],
    [...call('tu_form2', 'suggest_purchase_request', { source: 'tu_lines2', from: 'agreed' }), end()],
    [...say('Check the lines and click Create draft to save it.'), end()],
  ], { thread, question: 'Yes, go ahead with all of them.', uiTools: AI_ASSISTANT_V2_UI_TOOLS })
  const agreed = form(second.events)
  assert.ok(agreed, JSON.stringify(types(second.events)))
  assert.deepEqual(agreed.lines.map((row) => row.item.sku), offered.suggested.map((row) => row.item.sku))
  assert.ok(agreed.lines.every((row) => row.checked === !row.covered))
  // A claim of agreement to an item this conversation never offered or named fails.
  const stranger = await ask([
    [...call('tu_lines3', 'suggest_purchase_lines', { skus: ['LDM-001'] }), end()],
    [...call('tu_form3', 'suggest_purchase_request', { source: 'tu_lines3', from: 'agreed', lines: [{ sku: 'LDM-001' }] }), end()],
    [...say('Here.'), end()],
  ], { question: 'Yes please.', uiTools: AI_ASSISTANT_V2_UI_TOOLS })
  assert.equal(form(stranger.events), undefined)
  assert.ok(stranger.audit.uiTools.some((row) => row.tool === 'suggest_purchase_request' && row.status !== 'ok'), JSON.stringify(stranger.audit.uiTools))
  const chinese = await ask([
    [...call('tu_lines4', 'suggest_purchase_lines', { skus: ['LDM-001'] }), end()],
    [...call('tu_form4', 'suggest_purchase_request', { source: 'tu_lines4', from: 'user_named', lines: [{ sku: 'LDM-001', quantity: 50 }] }), end()],
    [...say('好的。'), end()],
  ], { question: '给LDM-001下单50个', body: { answerLanguage: 'zh-CN' }, uiTools: AI_ASSISTANT_V2_UI_TOOLS })
  assert.deepEqual(form(chinese.events).lines.map((row) => [row.item.sku, row.suggestedQuantity.value]), [['LDM-001', 50]])
})

// "Order 200 of LDM-001 from Northstar Electronics" (2026-11-04): the fixture's
// Summit Packaging is an active supplier that LDM-001 has not approved.
test('a supplier the item has not approved goes on the form for Create to add, and the answer says so', async () => {
  const { events, audit, body, scenario } = await ask([
    [...call('tu_lines', 'suggest_purchase_lines', { skus: ['LDM-001'] }), end()],
    [...call('tu_form', 'suggest_purchase_request', { source: 'tu_lines', from: 'user_named', lines: [{ sku: 'LDM-001', quantity: 200, supplier: 'Summit Packaging' }] }), end()],
    [...say("I've filled in a request form for you to review. Summit Packaging isn't an approved supplier for LDM-001 yet; clicking Create adds it. Enter its price in the form."), end()],
  ], { question: 'Order 200 of LDM-001 from Summit Packaging', uiTools: AI_ASSISTANT_V2_UI_TOOLS })
  assertProtocol(events)
  const form = ofType(events, 'ui').find((event) => event.component === 'pr_form')
  assert.ok(form, JSON.stringify(audit.uiTools))
  assert.deepEqual(form.props.lines[0].supplier, { id: 'SUP-002', name: 'Summit Packaging', source: 'user_named', link: 'new' })
  assert.deepEqual([form.props.lines[0].suggestedQuantity.value, form.props.canLinkSuppliers], [200, true])
  assert.ok(form.refs.some((ref) => ref.type === 'supplier' && ref.id === 'SUP-002'))
  // Saying what Create will do is no claim, and nothing is written while answering.
  assert.equal(ofType(events, 'replace').length, 0)
  assert.match(body.conclusion.summary, /clicking Create adds it/)
  assert.ok(scenario.calls.prisma.every(([, method]) => !/^(create|update|upsert|delete)/.test(method)))
  assert.match(ASSISTANT_V2_SYSTEM, /when the user clicks Create the form adds it as an approved supplier of the item, then creates the request/)
  assert.match(ASSISTANT_V2_SYSTEM, /a colleague with master data access can add the supplier/)
})

test('answering writes no business record: every read goes through the read-only stand-ins', async () => {
  const { scenario, audit } = await ask([
    [...call('tu_lines', 'suggest_purchase_lines', {}), ...call('tu_prs', 'list_purchase_requests', { status: 'all' }), ...call('tu_po', 'list_purchase_orders', {}), end()],
    [...say('Here are the lines I suggest.'), end()],
  ], { question: 'What should I reorder?' })
  assert.ok(audit.tools.every((row) => row.status === 'ok'), JSON.stringify(audit.tools))
  const writes = /^(create|update|upsert|delete|\$execute|\$transaction)/
  assert.ok(scenario.calls.prisma.every(([, method]) => !writes.test(method)))
  assert.ok(scenario.calls.repositories.every(([name]) => /\.(list|snapshot)/.test(name)), JSON.stringify(scenario.calls.repositories))
})

test('pasted rows reach the model whole, and the setup card is built from them in the loop for a role that may add records', async () => {
  const rows = Array.from({ length: 40 }, (_, index) => `PART-${100 + index} Bracket ${index + 1}, pcs, reorder point ${10 + index}`)
  const question = `Add these items:\n${rows.join('\n')}`
  assert.ok(question.length > 1200 && question.length <= ASSISTANT_V2_LIMITS.question)
  assert.equal(ASSISTANT_V2_LIMITS.question, 8000)
  const items = [0, 1, 2].map((index) => ({ sku: `PART-${100 + index}`, name: `Bracket ${index + 1}`, unit: 'pcs', reorderPoint: 10 + index }))
  const { events, client, audit } = await ask([
    [...say('I\'ve put your first items in a card for you to check and create.'), ...call('tu_card', 'suggest_setup_records', { items }), end()],
    [...say('Create them when they look right.'), end()],
  ], { question, uiTools: AI_ASSISTANT_V2_UI_TOOLS })
  assertProtocol(events)
  assert.equal(client.requests[0].messages[1].content[0].text, question)
  const [card] = ofType(events, 'ui')
  assert.equal(card.component, 'setup_form')
  assert.deepEqual(card.props.items.map((row) => [row.sku.value, row.reorderPoint.value, row.problems.length]), [['PART-100', 10, 0], ['PART-101', 11, 0], ['PART-102', 12, 0]])
  assert.equal(card.props.formId.split(':')[0], 'thr_test')
  assert.equal(ofType(events, 'replace').length, 0)
  assert.deepEqual(audit.uiTools, [{ tool: 'suggest_setup_records', status: 'ok', component: 'setup_form' }])
  const offered = (request) => request.tools.map((entry) => entry.name)
  for (const name of ['setup_status', 'show_setup_steps', 'suggest_setup_records']) assert.ok(offered(client.requests[0]).includes(name), name)
  // A value the user did not write goes back to the model to correct.
  const made = await ask([
    [...call('tu_card', 'suggest_setup_records', { items: [{ sku: 'PART-999', name: 'Bracket', unit: 'pcs' }] }), end()],
    [...say('Which items should I add?'), end()],
  ], { question, uiTools: AI_ASSISTANT_V2_UI_TOOLS })
  assert.equal(JSON.parse(lastToolResults(made.client.requests[1])[0].content).error, 'not_typed')
  // A role that may add neither suppliers nor items is not offered the card.
  const viewer = await ask([[...say('Someone with master data access can add them.'), end()]], { roleKey: 'read-only-viewer', question, uiTools: AI_ASSISTANT_V2_UI_TOOLS })
  assert.ok(!offered(viewer.client.requests[0]).includes('suggest_setup_records'))
  assert.ok(offered(viewer.client.requests[0]).includes('setup_status'))
})

test('saying a supplier or item was created is replaced; putting rows in a card for the user is no claim', async () => {
  for (const claim of ['I added your 3 suppliers.', 'I have created the items BOLT-M8 and NUT-M8 for you.', 'We\'ve set up your suppliers.', '我已为你添加了供应商。', '我已创建物料 BOLT-M8。']) {
    const { events } = await ask([[...say(claim), end()]], { question: 'Add supplier Northwind Metals and item BOLT-M8 and NUT-M8' })
    assert.deepEqual(ofType(events, 'replace').map((event) => event.code), ['unbacked_action_claim'], claim)
  }
  for (const card of ['I\'ve added your suppliers to a card for you to check.', 'I\'ve put your 3 suppliers in a card for you to check and create.', '我已把你的供应商放进卡片，请核对后创建。', '我已为你添加了供应商到卡片中，请核对。']) {
    const { events, body } = await ask([[...say(card), end()]], { question: 'Add supplier Northwind Metals' })
    assert.equal(ofType(events, 'replace').length, 0, card)
    assert.equal(body.conclusion.summary, card)
  }
})

test('the system prompt sets the setup rules apart, after the purchase request rule', () => {
  const setup = ASSISTANT_V2_SYSTEM.indexOf('Setting up the workspace:')
  assert.ok(setup > ASSISTANT_V2_SYSTEM.indexOf('call suggest_purchase_lines, then suggest_purchase_request'))
  assert.ok(setup < ASSISTANT_V2_SYSTEM.indexOf('The answer:'))
  for (const rule of [/call setup_status, then show_setup_steps/, /FlowChain has an import: never say you cannot tell whether it has one/, /call suggest_setup_records with them\. Pass only values the user wrote/, /Never say a supplier or item was created, added or saved/, /up to 8,000 characters/]) assert.match(ASSISTANT_V2_SYSTEM, rule)
})

// A live run on 2026-11-05: prose dates, amounts and quantities did not match
// the cards, Chinese answers had ASCII punctuation and English narration, and
// the answer sentence came after the table.
test('the text is written as the app shows it: workspace dates and amounts, full-width punctuation in Chinese', async () => {
  const zhAsk = { question: '哪些采购订单逾期了？', body: { answerLanguage: 'zh-CN' } }
  const { events, body } = await ask([OVERDUE, [...say('PO-001 的承诺日期是 2026-10-30(已逾期),差异 200 ', 'USD,还剩 1200 pcs 未收!'), end()]], zhAsk)
  assertProtocol(events)
  const shown = ofType(events, 'text_delta').map((event) => event.text).join('')
  assert.equal(shown, 'PO-001 的承诺日期是 Oct 30, 2026（已逾期），差异 $200.00，还剩 1,200 pcs 未收！')
  assert.equal(body.conclusion.summary, shown)
  // No piece leaves a figure parted from its currency.
  assert.ok(ofType(events, 'text_delta').every((event) => !/\d\s$/.test(event.text)), JSON.stringify(ofType(events, 'text_delta')))
  // English keeps its punctuation; its dates and amounts are rewritten too.
  const en = await ask([OVERDUE, [...say('PO-001 was due 2026-10-30 (Amount: 5,000 USD).'), end()]])
  assert.equal(ofType(en.events, 'text_delta').map((event) => event.text).join(''), 'PO-001 was due Oct 30, 2026 (Amount: $5,000.00).')
  // The follow-up questions read the same way.
  const chips = await ask([OVERDUE, [...say('PO-001 已逾期。'), ...call('tu_chips', 'suggest_followups', { questions: ['PO-001 会影响哪些销售订单?'] }), end()]], { ...zhAsk, uiTools: [followups] })
  assert.deepEqual(ofType(chips.events, 'ui')[0].props.questions, ['PO-001 会影响哪些销售订单？'])
})

test('a Chinese answer leaves out English narration before a tool call', async () => {
  const { events, body } = await ask([
    [...say('The item is LDM-002 Temperature Sensor. I will fill in the form.'), ...call('tu_po', 'list_purchase_orders', { status: 'overdue' }), end()],
    [...say('PO-001 已逾期 4 天。'), end()],
  ], { question: '哪些采购订单逾期了？', body: { answerLanguage: 'zh-CN' } })
  assertProtocol(events)
  assert.ok(ofType(events, 'text_delta').every((event) => /[㐀-鿿]/.test(event.text) || !/[A-Za-z]{3,} [A-Za-z]{3,}/.test(event.text)), JSON.stringify(ofType(events, 'text_delta')))
  assert.doesNotMatch(body.conclusion.summary, /fill in the form/)
  assert.deepEqual(body.parts.map((part) => part.type), ['text'])
  // English narration in an English answer still shows; text with Chinese in it too.
  const en = await ask([[...say('Let me check the orders.'), ...call('tu_po', 'list_purchase_orders', { status: 'overdue' }), end()], [...say('PO-001 is late.'), end()]])
  assert.match(ofType(en.events, 'text_delta').map((event) => event.text).join(''), /^Let me check the orders\./)
})

test('a date the user typed is not flagged as unmatched', async () => {
  const { events } = await ask([OVERDUE, [...say('PO-001 is late; you need it by 2026-11-20, and Nov 20 is 3 weeks away.'), end()]], { question: 'Which orders are late? We need them by Nov 20.' })
  const spans = ofType(events, 'flag').flatMap((flag) => flag.spans)
  assert.ok(!spans.some((span) => span.kind === 'date'), JSON.stringify(spans))
  // A date the user did not type still is.
  const other = await ask([OVERDUE, [...say('PO-001 arrives 2026-12-24.'), end()]], { question: 'When does PO-001 arrive?' })
  assert.ok(ofType(other.events, 'flag').flatMap((flag) => flag.spans).some((span) => span.kind === 'date'))
})

test('the model reads display strings and the words for codes; a chart of a table\'s rows is not drawn again', async () => {
  const { client, events, audit } = await ask([
    OVERDUE,
    [...say('Two orders are overdue.'), ...call('tu_table', 'show_table', { source: 'list_purchase_orders#1', columns: ['orderNumber', 'amount'] }), ...call('tu_chart', 'show_chart', { source: 'list_purchase_orders#1', kind: 'bar', x: 'orderNumber', series: ['amount'] }), end()],
    [...say('PO-001 is the older one.'), end()],
  ], { uiTools: AI_ASSISTANT_V2_UI_TOOLS })
  assertProtocol(events)
  const [read] = lastToolResults(client.requests[1]).map((block) => JSON.parse(block.content))
  const row = read.rows[0]
  assert.match(row.dueDateText, /^[A-Z][a-z]{2} \d{1,2}, \d{4}$/)
  assert.match(row.amountText, /^\$[\d,]+\.\d{2}$/)
  assert.deepEqual(ofType(events, 'ui').map((event) => event.component), ['table'])
  assert.deepEqual(audit.uiTools.map((entry) => entry.status), ['ok', 'skipped'])
  assert.equal(audit.displayFailures, 0)
  assert.equal(JSON.parse(lastToolResults(client.requests[2]).find((block) => block.tool_use_id === 'tu_chart').content).shown, null)
})

test('an item the user names by its name is ticked on the form', async () => {
  const { events } = await ask([
    [...call('tu_lines', 'suggest_purchase_lines', { skus: ['LDM-002'] }), end()],
    [...say('I\'ve filled in a request form for you to review.'), ...call('tu_form', 'suggest_purchase_request', { source: 'tu_lines', from: 'user_named', lines: [{ sku: 'LDM-002', quantity: 50 }] }), end()],
    [...say('Check the line, then click Create draft request.'), end()],
  ], { question: 'I need 50 temperature sensors', uiTools: AI_ASSISTANT_V2_UI_TOOLS })
  const form = ofType(events, 'ui').find((event) => event.component === 'pr_form')?.props
  assert.deepEqual(form.lines.map((row) => [row.item.sku, row.checked, row.suggestedQuantity.value]), [['LDM-002', true, 50]])
})

test('the system prompt asks for the answer first, display strings, whole record numbers and the app\'s terms', () => {
  for (const rule of [
    /write its one-sentence answer as text before any show_\* or suggest_purchase_request call/,
    /copy that string as it is, in any answer language/,
    /never write a code such as po_overdue/,
    /whole \(LOCAL-DEMO-PO-014, never PO-014\)/,
    /Do not add codes the user did not ask for/,
    /Do not narrate what you are about to look up/,
    /with offer_choices the buttons ask it, so do not ask it again in the text/,
    /Headings and labels in sentence case/,
    /采购订单、采购申请、收货单、物料、询价单、采购发票、销售发票/,
    /full-width punctuation/,
    /with nothing ticked, "tick the items you want, then click Create draft request"/,
  ]) assert.match(ASSISTANT_V2_SYSTEM, rule)
  assert.doesNotMatch(ASSISTANT_V2_SYSTEM, /Copy figures as the tools give them/)
})
