import http from 'node:http'
import { readFileSync } from 'node:fs'
import { AssistantModelError, modelAbortError } from './model-error.mjs'

// Recorded model turns, replayed without a network (docs/ai-assistant-v2-design.md
// §3.4): for unit tests, CI, the browser specs and an offline fallback during
// a live showcase. A transcript file is a JSON list of turns, one per model
// call, and each turn is the list of events that call streams. A turn may
// leave out its message_end, or the message_end its content; both are then
// built from the turn's text and tool events.

const ZERO_USAGE = Object.freeze({ input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 })

export function readScriptedTurns(path) {
  const turns = JSON.parse(readFileSync(path, 'utf8'))
  if (!Array.isArray(turns) || !turns.every(Array.isArray)) throw new Error(`${path} must hold a JSON list of turns, each a list of model events.`)
  return turns
}

function turnContent(events) {
  const content = []
  for (const event of events) {
    const last = content.at(-1)
    if (event.type === 'text_delta' && last?.type === 'text') last.text += event.text
    else if (event.type === 'text_delta') content.push({ type: 'text', text: event.text })
    else if (event.type === 'tool_use_end') content.push({ type: 'tool_use', id: event.id, name: event.name, input: event.input ?? {} })
  }
  return content
}

// A turn's events with a complete message_end, copied so a caller cannot
// change the recording.
export function completeScriptedTurn(turn) {
  const events = structuredClone(turn).filter((event) => event.type !== 'message_end')
  const end = turn.find((event) => event.type === 'message_end') || {}
  const content = end.content ? structuredClone(end.content) : turnContent(events)
  const stopReason = end.stopReason || (content.some((block) => block.type === 'tool_use') ? 'tool_use' : 'end_turn')
  return [...events, { type: 'message_end', stopReason, usage: { ...ZERO_USAGE, ...end.usage }, content }]
}

// The scripted model client: each stream call replays the next turn and
// records the request it was given.
export function createScriptedModelClient(turns) {
  const requests = []
  return {
    kind: 'scripted',
    model: 'scripted',
    requests,
    async *stream(request, signal) {
      const turn = turns[requests.length]
      requests.push(structuredClone(request))
      if (!turn) throw new AssistantModelError('malformed_output')
      for (const event of completeScriptedTurn(turn)) {
        if (signal?.aborted) throw modelAbortError()
        yield event
      }
    },
  }
}

const sse = (type, data) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`

// One turn as the Messages API streams it: each content block of the turn's
// final message, text word by word and tool input in two pieces, so a client
// meets partial JSON.
function messagesStream(turn, model, id) {
  const end = completeScriptedTurn(turn).at(-1)
  const { output_tokens: outputTokens, ...inputUsage } = end.usage
  const frames = [sse('message_start', { message: { id, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { ...inputUsage, output_tokens: 1 } } })]
  end.content.forEach((block, index) => {
    if (block.type === 'text') {
      frames.push(sse('content_block_start', { index, content_block: { type: 'text', text: '' } }))
      for (const piece of block.text.match(/\S+\s*|\s+/g) || []) frames.push(sse('content_block_delta', { index, delta: { type: 'text_delta', text: piece } }))
    } else if (block.type === 'tool_use') {
      const json = JSON.stringify(block.input ?? {})
      const half = Math.ceil(json.length / 2)
      frames.push(sse('content_block_start', { index, content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} } }))
      for (const piece of [json.slice(0, half), json.slice(half)]) frames.push(sse('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: piece } }))
    } else if (block.type === 'thinking') {
      frames.push(sse('content_block_start', { index, content_block: { type: 'thinking', thinking: '', signature: '' } }))
      if (block.thinking) frames.push(sse('content_block_delta', { index, delta: { type: 'thinking_delta', thinking: block.thinking } }))
      frames.push(sse('content_block_delta', { index, delta: { type: 'signature_delta', signature: block.signature ?? '' } }))
    } else {
      frames.push(sse('content_block_start', { index, content_block: block }))
    }
    frames.push(sse('content_block_stop', { index }))
  })
  frames.push(sse('message_delta', { delta: { stop_reason: end.stopReason, stop_sequence: null }, usage: { ...inputUsage, output_tokens: outputTokens } }))
  frames.push(sse('message_stop', {}))
  return frames
}

// A localhost server that speaks the Messages API's streaming format and
// answers each request with the next recorded turn, so the SDK client runs
// end to end with no network (tests/ai-eval/offline-guard.mjs allows
// localhost). It records every request; `closed` turns true once its
// connection ends, and `finished` stays false when the client went away
// before the turn was sent in full. `eventDelayMs` spaces the frames out, as
// a live model does.
export async function startScriptedMessagesServer(turns, { eventDelayMs = 0 } = {}) {
  const requests = []
  const server = http.createServer(async (req, res) => {
    let raw = ''
    for await (const chunk of req) raw += chunk
    const record = { method: req.method, url: req.url, headers: req.headers, body: JSON.parse(raw || '{}'), closed: false, finished: false }
    requests.push(record)
    const turn = turns[requests.length - 1]
    if (req.method !== 'POST' || req.url !== '/v1/messages' || !turn) {
      res.writeHead(req.method === 'POST' && req.url === '/v1/messages' ? 500 : 404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'The scripted transcript has no turn for this request.' } }))
      return
    }
    res.on('close', () => { record.closed = true })
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    for (const frame of messagesStream(turn, record.body.model, `msg_scripted_${requests.length}`)) {
      if (record.closed) return
      res.write(frame)
      if (eventDelayMs) await new Promise((resolve) => setTimeout(resolve, eventDelayMs))
    }
    record.finished = !record.closed
    res.end()
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  return {
    origin,
    endpoint: `${origin}/v1/messages`,
    requests,
    close: () => new Promise((resolve) => {
      server.closeAllConnections()
      server.close(resolve)
    }),
  }
}
