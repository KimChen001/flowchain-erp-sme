import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { AssistantModelError, createAssistantV2ModelClient } from './ai-assistant-v2-model/index.mjs'
import { createChatCompletionsModelClient } from './ai-assistant-v2-model/chat-completions.mjs'
import { transientModelError, withModelCallRetry } from './ai-assistant-v2-model/resilient.mjs'

// 2026-11-09 on Flash: 2 of 20 probe answers came back in about 1 s as
// unavailable, with nothing in the server log to say why.

const KEY = 'test-key-not-real-0000'
const FAST = { backoffMs: 5, minTimeLeftMs: 1000, slowMs: 20000 }
const END = { type: 'message_end', stopReason: 'end_turn', usage: null, content: [{ type: 'text', text: 'Hi' }] }
const request = () => ({ system: 'You are the FlowChain assistant.', messages: [{ role: 'user', content: 'Which items are short?' }], tools: [], maxTokens: 100 })
const collect = async (iterable) => { const out = []; for await (const event of iterable) out.push(event); return out }
const recorder = () => { const lines = []; return { lines, logger: { warn: (line) => lines.push(JSON.parse(line)) } } }

// A client whose calls play the given steps in turn: an error thrown before
// the first event, or a list of events (an Error inside one is thrown there).
function scriptedClient(steps) {
  let calls = 0
  return {
    kind: 'chat_completions',
    model: 'deepseek-v4.1-flash',
    get calls() { return calls },
    async *stream() {
      const step = steps[Math.min(calls, steps.length - 1)]
      calls += 1
      if (step instanceof Error) throw step
      for (const event of step) {
        if (event instanceof Error) throw event
        yield event
      }
    },
  }
}

test('which failures are tried again', () => {
  for (const status of [408, 429, 500, 502, 503, 504]) assert.equal(transientModelError(new AssistantModelError('non_success_status', { status })), true, String(status))
  for (const status of [400, 401, 402, 403, 404, 422]) assert.equal(transientModelError(new AssistantModelError('non_success_status', { status })), false, String(status))
  assert.equal(transientModelError(new AssistantModelError('network_error')), true)
  assert.equal(transientModelError(new AssistantModelError('malformed_output')), true)
  assert.equal(transientModelError(new AssistantModelError('non_success_status', { errorType: 'overloaded_error' })), true)
  assert.equal(transientModelError(new AssistantModelError('non_success_status', { errorType: 'invalid_request_error' })), false)
  assert.equal(transientModelError(new AssistantModelError('local_only_provider')), false)
  assert.equal(transientModelError(new DOMException('stopped', 'AbortError')), false)
  assert.equal(transientModelError(new TypeError('a bug')), false)
})

test('a call that fails before its first event with a passing error is tried once more, and both are logged', async () => {
  const { lines, logger } = recorder()
  const inner = scriptedClient([new AssistantModelError('non_success_status', { status: 503 }), [{ type: 'text_delta', text: 'Hi' }, END]])
  const client = withModelCallRetry(inner, { provider: 'deepseek_chat', logger, retry: FAST })
  const events = await collect(client.stream(request(), undefined, { deadline: Date.now() + 60000 }))
  assert.deepEqual(events.map((event) => event.type), ['text_delta', 'message_end'])
  assert.equal(inner.calls, 2)
  assert.equal(lines.length, 1)
  assert.deepEqual({ ...lines[0], durationMs: 0 }, { event: 'assistant_v2_model_call', provider: 'deepseek_chat', model: 'deepseek-v4.1-flash', outcome: 'retrying', attempt: 1, durationMs: 0, phase: 'before_first_event', reason: 'non_success_status', status: 503 })
  // The client keeps what the loop reads from it.
  assert.equal(client.kind, 'chat_completions')
  assert.equal(client.model, 'deepseek-v4.1-flash')
})

test('a second failure, an authentication error or a 4xx is thrown as before, logged once', async () => {
  for (const [steps, calls, outcomes] of [
    [[new AssistantModelError('network_error', { cause: Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } }) })], 2, ['retrying', 'failed']],
    [[new AssistantModelError('non_success_status', { status: 401 })], 1, ['failed']],
    [[new AssistantModelError('non_success_status', { status: 402 })], 1, ['failed']],
    [[new AssistantModelError('non_success_status', { status: 400 })], 1, ['failed']],
  ]) {
    const { lines, logger } = recorder()
    const inner = scriptedClient(steps)
    const client = withModelCallRetry(inner, { provider: 'deepseek_chat', logger, retry: FAST })
    await assert.rejects(collect(client.stream(request(), undefined, { deadline: Date.now() + 60000 })), (error) => error === steps[0])
    assert.equal(inner.calls, calls)
    assert.deepEqual(lines.map((line) => line.outcome), outcomes)
    assert.deepEqual(lines.map((line) => line.attempt), outcomes.map((_, index) => index + 1))
  }
  // A dropped connection names its code, never the message.
  const { lines, logger } = recorder()
  const error = new AssistantModelError('network_error', { cause: Object.assign(new TypeError('fetch failed http://secret.example'), { cause: { code: 'ECONNRESET' } }) })
  await assert.rejects(collect(withModelCallRetry(scriptedClient([error]), { logger, retry: FAST }).stream(request(), undefined, {})))
  assert.equal(lines[0].cause, 'ECONNRESET')
  assert.doesNotMatch(JSON.stringify(lines), /secret|fetch failed|M8|FlowChain assistant|Which items/)
})

test('no second try once an event has arrived, near the deadline, or after a stop', async () => {
  // Text already came through: the failure is the loop's to handle.
  let recorded = recorder()
  let inner = scriptedClient([[{ type: 'text_delta', text: 'Hi' }, new AssistantModelError('network_error')]])
  await assert.rejects(collect(withModelCallRetry(inner, { logger: recorded.logger, retry: FAST }).stream(request(), undefined, { deadline: Date.now() + 60000 })))
  assert.equal(inner.calls, 1)
  assert.deepEqual(recorded.lines.map((line) => [line.outcome, line.phase]), [['failed', 'streaming']])
  // Too little time left in the answer.
  recorded = recorder()
  inner = scriptedClient([new AssistantModelError('non_success_status', { status: 503 })])
  await assert.rejects(collect(withModelCallRetry(inner, { logger: recorded.logger, retry: FAST }).stream(request(), undefined, { deadline: Date.now() + 500 })))
  assert.equal(inner.calls, 1)
  assert.deepEqual(recorded.lines.map((line) => line.outcome), ['failed'])
  // The user stopped the answer during the pause.
  recorded = recorder()
  inner = scriptedClient([new AssistantModelError('non_success_status', { status: 503 }), [END]])
  const controller = new AbortController()
  const pending = collect(withModelCallRetry(inner, { logger: recorded.logger, retry: { ...FAST, backoffMs: 200 } }).stream(request(), controller.signal, {}))
  setTimeout(() => controller.abort(), 20)
  await assert.rejects(pending, (error) => error.name === 'AbortError')
  assert.equal(inner.calls, 1)
})

test('a stopped call and a slow call are logged with their times', async () => {
  let clock = 0
  const now = () => clock
  const slow = {
    model: 'm',
    async *stream() { clock += 3000; yield { type: 'text_delta', text: 'Hi' }; clock += 30000; yield END },
  }
  let recorded = recorder()
  await collect(withModelCallRetry(slow, { provider: 'deepseek_chat', logger: recorded.logger, now }).stream(request(), undefined, {}))
  assert.deepEqual(recorded.lines, [{ event: 'assistant_v2_model_call', provider: 'deepseek_chat', model: 'm', outcome: 'slow', attempt: 1, durationMs: 33000, firstEventMs: 3000 }])
  const stopped = {
    model: 'm',
    async *stream() { clock += 74000; throw new DOMException('The model call was stopped.', 'AbortError') },
  }
  recorded = recorder()
  clock = 0
  await assert.rejects(collect(withModelCallRetry(stopped, { logger: recorded.logger, now }).stream(request(), undefined, {})))
  assert.deepEqual([recorded.lines[0].outcome, recorded.lines[0].durationMs, recorded.lines[0].phase, recorded.lines[0].reason], ['stopped', 74000, 'before_first_event', 'stopped'])
})

test('the chat completions client retries a 503 from the provider, and the factory wraps provider clients', async () => {
  const replies = [{ status: 503, body: { error: { message: 'busy' } } }, { status: 200, body: { choices: [{ finish_reason: 'stop', message: { content: 'All stocked.' } }], usage: { prompt_tokens: 10, completion_tokens: 3 } } }]
  let served = 0
  const server = http.createServer(async (req, res) => {
    for await (const chunk of req) void chunk
    const { status, body } = replies[Math.min(served, replies.length - 1)]
    served += 1
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const env = { FLOWCHAIN_AI_RUNTIME_MODE: 'provider_assisted', FLOWCHAIN_AI_PROVIDER_KIND: 'deepseek_chat', FLOWCHAIN_AI_PROVIDER_ENDPOINT: `http://127.0.0.1:${server.address().port}/v1/chat/completions`, FLOWCHAIN_AI_PROVIDER_API_KEY: KEY, FLOWCHAIN_AI_PROVIDER_MODEL: 'deepseek-v4.1-flash' }
  try {
    const { lines, logger } = recorder()
    const events = await collect(withModelCallRetry(createChatCompletionsModelClient(env), { provider: 'deepseek_chat', logger, retry: FAST }).stream(request(), undefined, { deadline: Date.now() + 60000 }))
    assert.equal(events.at(-1).type, 'message_end')
    assert.equal(served, 3 - 1)
    assert.deepEqual(lines.map((line) => [line.outcome, line.status]), [['retrying', 503]])
    assert.doesNotMatch(JSON.stringify(lines), new RegExp(KEY))
    // The factory's client logs through the logger it is given.
    replies.splice(0, replies.length, { status: 401, body: { error: { message: 'no' } } })
    const factory = recorder()
    const client = createAssistantV2ModelClient(env, { logger: factory.logger })
    assert.equal(client.kind, 'chat_completions')
    await assert.rejects(collect(client.stream(request(), undefined, {})), (error) => error.status === 401)
    assert.deepEqual(factory.lines.map((line) => [line.outcome, line.status, line.provider]), [['failed', 401, 'deepseek_chat']])
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

// 2026-11-09 on Flash: one call had no first event for 74 s, and the answer
// came back empty at its 75 s limit.
test('a try with no first event in time is ended and tried once more; a second hang fails before the deadline', async () => {
  // Hangs until its signal ends it, as a provider call does.
  const hang = { kind: 'chat_completions', model: 'm', calls: 0, signals: [], async *stream(_request, signal) {
    this.calls += 1
    this.signals.push(signal)
    if (this.calls === 2 && this.thenAnswer) { yield { type: 'text_delta', text: 'Hi' }; yield END; return }
    await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }))
    throw new DOMException('The model call was stopped.', 'AbortError')
  } }
  let recorded = recorder()
  hang.thenAnswer = true
  const events = await collect(withModelCallRetry(hang, { provider: 'deepseek_chat', logger: recorded.logger, retry: { ...FAST, firstEventMs: 40 } }).stream(request(), undefined, { deadline: Date.now() + 60000 }))
  assert.deepEqual(events.map((event) => event.type), ['text_delta', 'message_end'])
  assert.equal(hang.calls, 2)
  assert.equal(hang.signals[0].aborted, true, 'the hung try was ended')
  assert.deepEqual(recorded.lines.map((line) => [line.outcome, line.reason, line.phase]), [['retrying', 'first_event_timeout', 'before_first_event']])
  // Hung twice: a model error, which the gateway answers with the notice.
  recorded = recorder()
  hang.calls = 0
  hang.thenAnswer = false
  await assert.rejects(collect(withModelCallRetry(hang, { logger: recorded.logger, retry: { ...FAST, firstEventMs: 40 } }).stream(request(), undefined, { deadline: Date.now() + 60000 })), (error) => error instanceof AssistantModelError && error.reason === 'first_event_timeout')
  assert.deepEqual(recorded.lines.map((line) => line.outcome), ['retrying', 'failed'])
  // Near the deadline the wait is cut to end before it, with no second try.
  recorded = recorder()
  hang.calls = 0
  const started = Date.now()
  await assert.rejects(collect(withModelCallRetry(hang, { logger: recorded.logger, retry: { ...FAST, firstEventMs: 20000, deadlineMarginMs: 100 } }).stream(request(), undefined, { deadline: started + 300 })), (error) => error.reason === 'first_event_timeout')
  assert.ok(Date.now() - started < 1000, `ended after ${Date.now() - started} ms`)
  assert.equal(hang.calls, 1)
  // A client that does not listen to its signal still times out.
  recorded = recorder()
  const deaf = { model: 'm', async *stream() { await new Promise((resolve) => setTimeout(resolve, 400)); yield END } }
  await assert.rejects(collect(withModelCallRetry(deaf, { logger: recorded.logger, retry: { ...FAST, firstEventMs: 30 } }).stream(request(), undefined, { deadline: Date.now() + 1500 })), (error) => error.reason === 'first_event_timeout')
  // The answer's own stop still ends a try as a stop, not a timeout.
  const controller = new AbortController()
  hang.calls = 0
  const stopping = collect(withModelCallRetry(hang, { logger: recorded.logger, retry: FAST }).stream(request(), controller.signal, {}))
  setTimeout(() => controller.abort(), 20)
  await assert.rejects(stopping, (error) => error.name === 'AbortError')
  assert.equal(hang.calls, 1)
})
