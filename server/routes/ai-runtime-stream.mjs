// The model-first answer's progress, streamed (docs/ai-model-first-design.md
// §5, step S3). A client that accepts NDJSON (the panel, for a typed
// question) gets one JSON object per line while the tool loop runs:
//
//   {"type":"progress","step":"reading","sources":["purchase_orders"]}
//   {"type":"progress","step":"writing"}
//   {"type":"progress","step":"checking"}
//   {"type":"answer","status":200,"body":{...the answer, as the JSON endpoint sends it}}
//
// The stream opens with the first progress line, so the HTTP status is 200
// and the answer line carries the real one (a 503 after the loop started is
// {"type":"answer","status":503,"body":{code,error}}). An answer given without
// the loop (a chip, a guarded question, the rules, an error before the loop)
// opens no stream: it is the usual JSON response, whatever the client
// accepts. The answer itself is not streamed word by word: it is shown only
// after the server has checked its figures. Progress lines carry codes only.
//
// Assistant v2 (docs/ai-assistant-v2-design.md §3.7) writes its protocol
// events (shared/assistant-protocol.mjs) through `event`: start, then text,
// tools, parts, flags and notices as they happen, and the answer line last,
// which ends the stream. From the first v2 event on, every line carries
// {v:2, seq}, a rules answer after an early provider failure included. A
// client that does not accept NDJSON gets no events, only the folded answer.
import { PROTOCOL_VERSION } from '../../shared/assistant-protocol.mjs'

export const AI_RUNTIME_STREAM_TYPE = 'application/x-ndjson'

export function aiRuntimeAcceptsStream(req) {
  return String(req?.headers?.accept || '').toLowerCase().includes(AI_RUNTIME_STREAM_TYPE)
}

// { send, progress, event }: `send` replaces the request's send; `progress`
// and `event` are null when the client did not ask for a stream.
export function aiRuntimeProgressStream(req, res, send) {
  if (!aiRuntimeAcceptsStream(req)) return { send, progress: null, event: null }
  let open = false
  let seq = null
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
    res.write(`${JSON.stringify(seq === null ? event : { v: PROTOCOL_VERSION, seq: seq++, ...event })}\n`)
  }
  return {
    progress: (event) => write({ type: 'progress', ...event }),
    event: (event) => {
      if (seq === null) seq = 0
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
