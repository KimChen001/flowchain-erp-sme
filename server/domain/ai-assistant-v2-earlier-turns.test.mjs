import test from 'node:test'
import assert from 'node:assert/strict'
import { aiSkillScenario } from './test-fixtures/ai-skill-scenario.mjs'
import { aiCallCostMicros, aiUsagePrices } from './ai-usage-meter.mjs'
import { ASSISTANT_V2_LIMITS, answerAssistantV2 } from './ai-assistant-v2.mjs'
import { AI_ASSISTANT_V2_UI_TOOLS } from './ai-assistant-v2-ui-tools.mjs'

// How many earlier turns a thread sends (owner 2026-11-15, "按缓存价算"): with
// the fixed prompt priced in full at Sonnet 5.5 prices, the earlier turns had
// about 700 tokens. The fixed prompt is now priced as a cache read when a call
// of the conversation read the cache within promptCacheMs; the ceiling ($0.20
// an answer), the half-of-it rule for the first call and the 4,000-token
// output reserve are unchanged.

// Tokens as the loop counts them (ASCII / 3, other characters one each).
const tokensIn = (value) => { let ascii = 0; for (let at = 0; at < value.length; at += 1) if (value.charCodeAt(at) < 128) ascii += 1; return Math.ceil(ascii / 3) + (value.length - ascii) }
const fixedOf = (request) => tokensIn(request.system) + tokensIn(JSON.stringify(request.tools.map((tool) => ({ name: tool.name, description: tool.description, input_schema: tool.input_schema }))))
const promptOf = (request) => fixedOf(request) + request.messages.reduce((sum, message) => sum + tokensIn(JSON.stringify(message)), 0)

// A thread of `turns` earlier turns, each about 900 tokens (a list result of
// 2,400 characters).
function longThread(turns) {
  const rows = Array.from({ length: 160 }, (_, at) => ({ orderNumber: `PO-${String(at).padStart(4, '0')}`, supplier: 'Acme Components Limited', status: 'issued', expectedDate: '2026-10-01' }))
  const big = JSON.stringify({ source: 'list_purchase_orders#1', rows }).slice(0, 2400)
  const messages = []
  for (let turn = 0; turn < turns; turn += 1) {
    messages.push(
      { role: 'user', content: [{ type: 'text', text: 'Which orders are open?' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: `tu_${turn}`, name: 'list_purchase_orders', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: `tu_${turn}`, content: big }] },
      { role: 'assistant', content: [{ type: 'text', text: 'Here they are.' }] },
    )
  }
  return messages
}

// A model client that reports usage the way a provider would: the fixed
// prompt read from the cache when `cached` says so for that call.
function client(model, rounds) {
  const requests = []
  return {
    model,
    requests,
    async* stream(request) {
      const round = rounds[requests.length]
      requests.push(structuredClone(request))
      const prompt = promptOf(request)
      const cached = round.cached ? fixedOf(request) : 0
      for (const event of round.events) yield event
      // The call's content, as a client reports it with the usage.
      const calls = round.events.filter((event) => event.type === 'tool_use_end').map((event) => ({ type: 'tool_use', id: event.id, name: event.name, input: event.input }))
      const said = round.events.filter((event) => event.type === 'text_delta').map((event) => event.text).join('')
      yield { type: 'message_end', stopReason: calls.length ? 'tool_use' : 'end_turn', content: calls.length ? calls : [{ type: 'text', text: said }], usage: { input_tokens: prompt - cached, cache_read_input_tokens: cached, output_tokens: round.output } }
    },
  }
}
const answerOnly = { events: [{ type: 'text_delta', text: 'PO-001 is overdue.' }], output: 20 }
const lookup = { events: [{ type: 'tool_use_start', id: 'tu_now', name: 'list_purchase_orders' }, { type: 'tool_use_end', id: 'tu_now', name: 'list_purchase_orders', input: { status: 'overdue' } }], output: 300 }

async function ask({ model, thread, rounds }) {
  const scenario = aiSkillScenario({ roleKey: 'workspace-administrator' })
  const events = []
  const modelClient = client(model, rounds)
  const outcome = await answerAssistantV2({ ...scenario.ctx, env: { FLOWCHAIN_AI_PROVIDER_MODEL: model } }, { threadId: 'thr_turns', message: 'Which purchase orders are overdue?', answerLanguage: 'en-US' }, {
    emit: (event) => events.push(event), modelClient, uiTools: AI_ASSISTANT_V2_UI_TOOLS, thread,
  })
  const first = modelClient.requests[0]
  // The earlier turns sent: the first call's messages before this turn's
  // context and question.
  const earlier = first.messages.slice(0, -2).reduce((sum, message) => sum + tokensIn(JSON.stringify(message)), 0)
  return { ...outcome, events, requests: modelClient.requests, earlier, fixed: fixedOf(first), prompt: promptOf(first) }
}
const cachedThread = (turns) => ({ messages: longThread(turns), results: new Map(), promptCachedAt: Date.now() })
const coldThread = (turns) => ({ messages: longThread(turns), results: new Map() })
const notices = (events) => events.filter((event) => event.type === 'notice').map((event) => event.code)

test('at Sonnet 5.5 prices, a conversation that read the cache sends about 26,000 tokens of earlier turns; one that did not keeps main\'s room', async (t) => {
  const warm = await ask({ model: 'claude-sonnet-5-5', thread: cachedThread(100), rounds: [{ ...answerOnly, cached: true }] })
  const cold = await ask({ model: 'claude-sonnet-5-5', thread: coldThread(100), rounds: [{ ...answerOnly, cached: false }] })
  t.diagnostic(`Sonnet 5.5: fixed prompt ${warm.fixed}; earlier turns sent ${warm.earlier} with the cache read, ${cold.earlier} without`)
  assert.ok(warm.earlier >= 26000, `earlier turns sent: ${warm.earlier}`)
  assert.ok(warm.audit.turnsLeftOut > 0, 'a hundred turns do not all fit')
  // The room is what is left of half the ceiling after the output reserve
  // and the fixed prompt at a tenth of its price, less at most one turn.
  const prices = aiUsagePrices({ FLOWCHAIN_AI_PROVIDER_MODEL: 'claude-sonnet-5-5' })
  const room = (ASSISTANT_V2_LIMITS.costCeilingMicros / 2 - ASSISTANT_V2_LIMITS.outputTokens * prices.outputPerMillion - warm.fixed * 0.1 * prices.inputPerMillion) / prices.inputPerMillion
  assert.ok(warm.earlier <= room && warm.earlier > room - 1000, `${warm.earlier} of ${Math.round(room)}`)
  // Without a recent cache read the rule is main's: the fixed prompt in full.
  assert.ok(cold.earlier < 2000, `cold: ${cold.earlier}`)
  assert.ok(cold.audit.turnsLeftOut > warm.audit.turnsLeftOut)
  // A cache read longer ago than promptCacheMs counts as cold.
  const stale = await ask({ model: 'claude-sonnet-5-5', thread: { ...coldThread(100), promptCachedAt: Date.now() - ASSISTANT_V2_LIMITS.promptCacheMs - 1000 }, rounds: [{ ...answerOnly, cached: false }] })
  assert.equal(stale.earlier, cold.earlier)
})

test('on a model without listed prices (DeepSeek, priced at the defaults) the room only widens', async (t) => {
  const warm = await ask({ model: 'deepseek-v4-flash', thread: cachedThread(140), rounds: [{ ...answerOnly, cached: true }] })
  const cold = await ask({ model: 'deepseek-v4-flash', thread: coldThread(140), rounds: [{ ...answerOnly, cached: false }] })
  t.diagnostic(`DeepSeek (default prices): earlier turns sent ${warm.earlier} with the cache read, ${cold.earlier} without`)
  assert.ok(cold.earlier > 40000, `cold: ${cold.earlier}`)
  assert.ok(warm.earlier >= cold.earlier, `${warm.earlier} vs ${cold.earlier}`)
})

test('the worst case, a cache gone cold after it was read, keeps the first call within the ceiling', async (t) => {
  // The thread read the cache, so its earlier turns fill the cached room, but
  // the provider has dropped the cache: the first call is priced in full.
  const answer = await ask({ model: 'claude-sonnet-5-5', thread: cachedThread(100), rounds: [{ ...lookup, cached: false }, { ...answerOnly, cached: false }] })
  const prices = aiUsagePrices({ FLOWCHAIN_AI_PROVIDER_MODEL: 'claude-sonnet-5-5' })
  const firstAtFullOutput = aiCallCostMicros({ inputTokens: answer.prompt, outputTokens: ASSISTANT_V2_LIMITS.outputTokens }, prices)
  t.diagnostic(`worst case: first call at full output ${firstAtFullOutput / 1e6}; calls made ${answer.requests.length}; spent ${answer.audit.costMicros / 1e6}; notices ${notices(answer.events).join(',') || 'none'}; answer ${answer.body.conclusion.summary}`)
  assert.ok(firstAtFullOutput <= ASSISTANT_V2_LIMITS.costCeilingMicros, `first call at its full output: $${firstAtFullOutput / 1e6}`)
  assert.ok(firstAtFullOutput > 140000, `about $0.15: $${firstAtFullOutput / 1e6}`)
  // The answer never spends past the ceiling. Here the second call would
  // not fit, so it is not made and the answer says why: the price of
  // counting on the cache, which is why it counts only for promptCacheMs
  // after a call read it.
  assert.ok(answer.audit.costMicros <= ASSISTANT_V2_LIMITS.costCeilingMicros, String(answer.audit.costMicros))
  assert.equal(answer.requests.length, 1)
  assert.deepEqual(notices(answer.events), ['cost_ceiling'])
})

test('with the cache read, a second call still fits after a lookup', async (t) => {
  const answer = await ask({ model: 'claude-sonnet-5-5', thread: cachedThread(100), rounds: [{ ...lookup, cached: true }, { ...answerOnly, cached: true }] })
  assert.ok(answer.earlier >= 26000)
  t.diagnostic(`with the cache read: ${answer.requests.length} calls, ${answer.audit.costMicros / 1e6}`)
  assert.equal(answer.requests.length, 2)
  assert.deepEqual(notices(answer.events), [])
  assert.equal(answer.body.conclusion.summary, 'PO-001 is overdue.')
  assert.ok(answer.audit.costMicros <= ASSISTANT_V2_LIMITS.costCeilingMicros)
  // And a cold thread, at main's room, has its second call too.
  const cold = await ask({ model: 'claude-sonnet-5-5', thread: coldThread(100), rounds: [{ ...lookup, cached: false }, { ...answerOnly, cached: false }] })
  assert.equal(cold.requests.length, 2)
  assert.deepEqual(notices(cold.events), [])
})

test('a call that reads the cache marks the conversation for its next answer', async () => {
  const thread = coldThread(2)
  await ask({ model: 'claude-sonnet-5-5', thread, rounds: [{ ...answerOnly, cached: true }] })
  assert.ok(Date.now() - thread.promptCachedAt < 5000)
  const uncached = coldThread(2)
  await ask({ model: 'claude-sonnet-5-5', thread: uncached, rounds: [{ ...answerOnly, cached: false }] })
  assert.equal(uncached.promptCachedAt, undefined)
})
