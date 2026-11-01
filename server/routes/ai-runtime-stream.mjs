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
export const AI_RUNTIME_STREAM_TYPE = 'application/x-ndjson'

export function aiRuntimeAcceptsStream(req) {
  return String(req?.headers?.accept || '').toLowerCase().includes(AI_RUNTIME_STREAM_TYPE)
}

// { send, progress }: `send` replaces the request's send; `progress` is null
// when the client did not ask for a stream.
export function aiRuntimeProgressStream(req, res, send) {
  if (!aiRuntimeAcceptsStream(req)) return { send, progress: null }
  let open = false
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
    res.write(`${JSON.stringify(event)}\n`)
  }
  return {
    progress: (event) => write({ type: 'progress', ...event }),
    send: (target, status, payload) => {
      if (!open) return send(target, status, payload)
      write({ type: 'answer', status, body: payload })
      if (!closed()) res.end()
    },
  }
}
