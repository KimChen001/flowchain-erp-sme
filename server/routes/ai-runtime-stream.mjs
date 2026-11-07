// The assistant's answer, streamed (docs/ai-assistant-v2-design.md §3.7). A
// client that accepts NDJSON (the panel) gets the protocol events
// (shared/assistant-protocol.mjs) through `event`, one JSON object per line,
// each with {v:2, seq}: start, then text, tools, parts, flags and notices as
// they happen, and the answer line last, which ends the stream. The stream
// opens with the first event, so the HTTP status is 200 and the answer line
// carries the real one (a 503 after the stream opened is
// {"type":"answer","status":503,"body":{code,error}}). A refusal before any
// event (sign-in, a question too long) opens no stream: it is the usual JSON
// response, whatever the client accepts. A client that does not accept
// NDJSON gets no events, only the folded answer.
import { PROTOCOL_VERSION } from '../../shared/assistant-protocol.mjs'

export const AI_RUNTIME_STREAM_TYPE = 'application/x-ndjson'

export function aiRuntimeAcceptsStream(req) {
  return String(req?.headers?.accept || '').toLowerCase().includes(AI_RUNTIME_STREAM_TYPE)
}

// { send, event }: `send` replaces the request's send; `event` is null when
// the client did not ask for a stream.
export function aiRuntimeProgressStream(req, res, send) {
  if (!aiRuntimeAcceptsStream(req)) return { send, event: null }
  let open = false
  let seq = 0
  const closed = () => !res || res.destroyed || res.writableEnded
  const write = (event) => {
    if (closed()) return
    if (!open) {
      open = true
      // A client that went away must not crash the server.
      res.on?.('error', () => {})
      res.writeHead(200, {
        'Content-Type': `${AI_RUNTIME_STREAM_TYPE}; charset=utf-8`,
        'Cache-Control': 'no-cache, no-transform',
        'X-Accel-Buffering': 'no',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET,POST,PATCH,OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      })
      res.socket?.setNoDelay?.(true)
    }
    res.write(`${JSON.stringify({ v: PROTOCOL_VERSION, seq: seq++, ...event })}\n`)
  }
  return {
    event: (event) => {
      write(event)
      if (event.type === 'answer' && !closed()) res.end()
    },
    send: (target, status, payload) => {
      if (!open) return send(target, status, payload)
      write({ type: 'answer', status, body: payload })
      if (!closed()) res.end()
    },
  }
}
