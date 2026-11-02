import test from 'node:test'
import assert from 'node:assert/strict'
import { aiSkillScenario } from './test-fixtures/ai-skill-scenario.mjs'
import { aiCallCostMicros, aiUsagePrices, runWithAiUsageScope } from './ai-usage-meter.mjs'
import { createScriptedModelClient } from './ai-assistant-v2-model/scripted.mjs'
import { AssistantModelError } from './ai-assistant-v2-model/model-error.mjs'
import { aiSkillText } from './ai-skill-copy.mjs'
import { ASSISTANT_V2_LIMITS, ASSISTANT_V2_SYSTEM, answerAssistantV2 } from './ai-assistant-v2.mjs'
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
  assert.deepEqual(ofType(events, 'text_delta').map((event) => event.text), ['PO-001 is ', '4 days overdue', ' and PO-008 is 2.'])
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
    'progress:writing', 'text_delta:p1', 'flag:p1', 'tool:show_records:running', 'ui:p2', 'tool:show_records:done',
    'progress:writing', 'text_delta:p3', 'flag:p3',
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
  assert.equal(client.requests[2].messages.at(-1).content.at(-1).text, 'No more tool calls are available for this answer. Answer now from these results.')
  assert.equal(audit.rounds, 2)
  assert.equal(audit.stopReason, 'limits')
  assert.deepEqual(ofType(events, 'error'), [{ type: 'error', code: 'limits', retryable: false }])
  assert.equal(events.at(-1).type, 'answer')
  // The refused call still has its result, so the thread stays valid.
  assert.equal(JSON.parse(thread.messages.at(-1).content[0].content).error, 'call_limit')
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

test('the cost ceiling and the monthly cap stop the loop after the model call that crosses them', async () => {
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
  // What is left of the monthly cap, from the gateway's reservation: one
  // call of USAGE costs 3,100 micros.
  const cap = await ask([OVERDUE, [...say('Never sent.'), end()]], { limits: { capRemainingMicros: 3000 } })
  assert.deepEqual(ofType(cap.events, 'notice'), [{ type: 'notice', code: 'over_cap_during_answer' }])
  assert.equal(cap.audit.stopReason, 'over_cap_during_answer')
  assert.equal(cap.client.requests.length, 1)
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

test('the wall-time deadline stops a slow model call with a retryable error', async () => {
  const slow = { model: 'scripted', async *stream(_request, signal) {
    yield { type: 'text_delta', text: 'Reading your orders. ' }
    await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }))
    throw new DOMException('stopped', 'AbortError')
  } }
  const { events, audit } = await ask([], { client: slow, limits: { timeoutMs: 30 } })
  assertProtocol(events)
  assert.deepEqual(ofType(events, 'error'), [{ type: 'error', code: 'timeout', retryable: true }])
  assert.equal(events.at(-1).type, 'answer')
  assert.equal(audit.stopReason, 'timeout')
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
  for (const claim of ['I submitted the request for LDM-001.', 'I have created a purchase order for you.', 'PO-008 was cancelled.', '我已为你提交采购申请。']) {
    const { events, body, audit } = await ask([OVERDUE, [...say(claim), end()]])
    const replace = ofType(events, 'replace')
    assert.equal(replace.length, 1, claim)
    assert.equal(replace[0].code, 'unbacked_action_claim')
    assert.equal(replace[0].text, aiSkillText('assistant_v2.replace.action_claim', 'en-US'))
    assert.equal(body.conclusion.summary, replace[0].text)
    assert.deepEqual(audit.replaces, ['unbacked_action_claim'])
  }
  // A state the record is in is its status, not a claim.
  const status = await ask([OVERDUE, [...say('PO-008 has been issued and is 2 days overdue.'), end()]])
  assert.equal(ofType(status.events, 'replace').length, 0)
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
  assert.deepEqual(named, [['LDM-001']])
  assert.equal(thread.messages.length, 12)
  // A record named in an earlier turn of this thread is no foreign record.
  const third = await ask([[...say('PO-008 was the other one.'), end()]], { thread, question: 'Which was the other?' })
  assert.equal(ofType(third.events, 'replace').length, 0)
  // After a restart the client's earlier turns are sent as context.
  const restarted = await ask([[...say('Yes.'), end()]], { body: { conversationContext: { previousTurns: [{ question: 'Which orders are late?', answer: 'PO-001 and PO-008.' }] } } })
  assert.match(restarted.client.requests[0].messages[0].content[0].text, /"earlierTurns":\[\{"question":"Which orders are late\?","answer":"PO-001 and PO-008."\}\]/)
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
