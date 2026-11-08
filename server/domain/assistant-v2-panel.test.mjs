import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

// The assistant v2 panel's client side (docs/ai-assistant-v2-design.md §3.7,
// §4): the stream client reads NDJSON lines, foldEvents builds the answer from
// them, and AssistantV2Answer draws it. esbuild bundles the client modules and
// react-dom/server renders them, as the browser would.

const CJK = /[㐀-鿿]/
const root = resolve(import.meta.dirname, '../..')

async function loadClient() {
  const directory = await mkdtemp(join(tmpdir(), 'flowchain-assistant-v2-panel-'))
  const entry = `
    import { createElement } from 'react'
    import { renderToStaticMarkup } from 'react-dom/server'
    import { AssistantV2Answer } from './src/modules/ai-assistant/v2/AssistantV2Answer.tsx'
    export * from './src/modules/ai-assistant/v2/foldEvents.ts'
    export * from './src/modules/ai-assistant/v2/streamClient.ts'
    export { ApiError } from './src/lib/api-client.ts'
    export const render = (props) => renderToStaticMarkup(createElement(AssistantV2Answer, { threadId: 'thr_7f2c', fallbackMessageId: 'answer-1', latest: true, receipts: {}, onNavigate: () => {}, onFollowUp: () => {}, onRetry: () => {}, onReceipt: () => {}, ...props }))
  `
  const result = await build({
    stdin: { contents: entry, resolveDir: root, loader: 'tsx', sourcefile: 'assistant-v2-panel-entry.tsx' },
    bundle: true, platform: 'node', format: 'cjs', write: false, jsx: 'automatic',
    define: { 'import.meta.env.DEV': 'false' }, logLevel: 'silent', loader: { '.css': 'empty', '.svg': 'empty', '.png': 'empty' },
  })
  const file = join(directory, 'panel.cjs')
  await writeFile(file, result.outputFiles[0].text)
  try {
    return (await import(pathToFileURL(file).href)).default
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

const client = await loadClient()

// Scenario S4 of the design, as its JSON example streams it.
const S4_LINES = [
  '{"v":2,"seq":0,"type":"start","threadId":"thr_7f2c","messageId":"msg_19","model":"claude-sonnet-5-5","language":"en-US"}',
  '{"v":2,"seq":1,"type":"tool","id":"toolu_01","name":"suggest_purchase_lines","state":"running"}',
  '{"v":2,"seq":2,"type":"progress","step":"reading","sources":["inventory"]}',
  '{"v":2,"seq":3,"type":"tool","id":"toolu_01","name":"suggest_purchase_lines","state":"done","rows":3}',
  '{"v":2,"seq":4,"type":"text_delta","partId":"p1","text":"Three items reach their reorder point before Friday. "}',
  '{"v":2,"seq":5,"type":"text_delta","partId":"p1","text":"Tick the ones you want and I will fill in a request."}',
  '{"v":2,"seq":6,"type":"ui","partId":"p2","component":"pr_form","schemaVersion":1,"props":{"formId":"msg_19:p2","source":"toolu_01","suggested":[{"item":{"id":"itm_42","sku":"SKU-1007","name":"Corrugated box 40x30","unit":"pcs"},"onHand":120,"safetyStock":200,"reorderPoint":300,"suggestedQuantity":{"value":600,"source":"reorder_gap_raised_to_moq"},"supplier":{"id":"sup_3","name":"Acme Packaging","source":"preferred"},"needByDate":{"value":"2026-11-20","source":"lead_time","leadTimeDays":14},"estimatedUnitPrice":{"value":0.42,"currency":"USD","source":"reference_price"},"covered":null,"checked":false}],"lines":[],"canCreate":true},"refs":[{"type":"item","id":"itm_42","label":"SKU-1007"}]}',
  '{"v":2,"seq":7,"type":"ui","partId":"p3","component":"followups","schemaVersion":1,"props":{"questions":["Which of these already have an open request?","Show the stock projection for SKU-1007"]},"refs":[]}',
  '{"v":2,"seq":8,"type":"flag","partId":"p1","spans":[]}',
  '{"v":2,"seq":9,"type":"answer","status":200,"body":{"answerSource":"assistant_v2","language":"en-US","conclusion":{"title":"Three items to reorder","summary":"Three items reach their reorder point before Friday. ..."},"parts":[{"id":"p1","type":"text"},{"id":"p2","type":"ui","component":"pr_form"},{"id":"p3","type":"ui","component":"followups"}],"keyEvidence":[{"type":"item","id":"itm_42","label":"SKU-1007"}],"aiModelAccess":{"status":"on"}}}',
]
const S4 = S4_LINES.map((line) => client.parseAssistantV2Line(line))
const event = (value) => ({ v: 2, seq: 0, ...value })
const fold = (events) => client.foldAssistantV2Events(events.map((value) => ('v' in value ? client.parseAssistantV2Line(JSON.stringify(value)) : value)))
const count = (markup, pattern) => (markup.match(pattern) || []).length

test('the S4 stream folds into its parts in order, with the answer last', () => {
  assert.ok(S4.every(Boolean), 'every S4 line parses')
  const message = client.foldAssistantV2Events(S4)
  assert.equal(message.threadId, 'thr_7f2c')
  assert.equal(message.messageId, 'msg_19')
  assert.equal(message.language, 'en-US')
  assert.deepEqual(message.parts.map((part) => [part.id, part.kind, part.component || null]), [['p1', 'text', null], ['p2', 'ui', 'pr_form'], ['p3', 'ui', 'followups']])
  assert.equal(message.parts[0].text, 'Three items reach their reorder point before Friday. Tick the ones you want and I will fill in a request.')
  assert.deepEqual(message.parts[0].flags, [])
  assert.deepEqual(message.parts[1].refs, [{ type: 'item', id: 'itm_42', label: 'SKU-1007' }])
  assert.equal(message.done, true)
  assert.equal(message.toolStatus, null)
  assert.equal(message.error, null)
  assert.equal(message.body.answerSource, 'assistant_v2')
  // AnswerParts reads the same parts with its own field names.
  assert.deepEqual(client.answerPartsOf(message).map((part) => part.type), ['text', 'ui', 'ui'])
  // Folding is pure: the events are not changed and a refold is equal.
  assert.deepEqual(client.foldAssistantV2Events(S4), message)

  // While it streams: the tool, then what it reads.
  const running = client.foldAssistantV2Events(S4.slice(0, 2))
  assert.deepEqual(running.toolStatus, { tool: { id: 'toolu_01', name: 'suggest_purchase_lines', state: 'running' } })
  const reading = client.foldAssistantV2Events(S4.slice(0, 4))
  assert.deepEqual(reading.toolStatus, { tool: { id: 'toolu_01', name: 'suggest_purchase_lines', state: 'done', rows: 3 }, progress: { step: 'reading', sources: ['inventory'] } })
  assert.equal(reading.done, false)

  // Nothing after the answer line changes the message.
  const late = client.foldAssistantV2Event(message, event({ type: 'text_delta', partId: 'p1', text: ' More.' }))
  assert.equal(late, message)
})

test('flags attach to their text part once; replace swaps the text and nothing is added after it', () => {
  const span = { text: '600', kind: 'number', reason: 'not_in_results' }
  const flagged = fold([
    event({ type: 'text_delta', partId: 'p1', text: 'Order 600 boxes by ' }),
    event({ type: 'text_delta', partId: 'p1', text: '2026-11-20.' }),
    event({ type: 'flag', partId: 'p1', spans: [span] }),
    event({ type: 'flag', partId: 'p1', spans: [span, { text: '2026-11-20', kind: 'date', reason: 'not_in_results' }] }),
    // A flag for a part that never streamed is dropped.
    event({ type: 'flag', partId: 'p9', spans: [span] }),
  ])
  assert.equal(flagged.parts.length, 1)
  assert.deepEqual(flagged.parts[0].flags.map((item) => item.text), ['600', '2026-11-20'])

  const replaced = fold([
    event({ type: 'text_delta', partId: 'p1', text: 'I have created PR-0231 for you.' }),
    event({ type: 'flag', partId: 'p1', spans: [{ text: 'PR-0231', kind: 'record', reason: 'not_in_results' }] }),
    event({ type: 'replace', partId: 'p1', text: 'I cannot create requests; use the form to create one.', code: 'unbacked_action_claim' }),
    event({ type: 'text_delta', partId: 'p1', text: ' PR-0231 is ready.' }),
    event({ type: 'flag', partId: 'p1', spans: [{ text: 'PR-0231', kind: 'record', reason: 'not_in_results' }] }),
  ])
  assert.deepEqual(replaced.parts, [{ id: 'p1', kind: 'text', text: 'I cannot create requests; use the form to create one.', flags: [], replaced: 'unbacked_action_claim' }])

  // A replace for a part not yet seen still shows its text.
  const fresh = fold([event({ type: 'replace', partId: 'p4', text: 'Withheld.', code: 'hidden_value' })])
  assert.deepEqual(fresh.parts, [{ id: 'p4', kind: 'text', text: 'Withheld.', flags: [], replaced: 'hidden_value' }])
})

test('ui parts keep their order, a resent part is swapped in place, notices are listed once, an error stays', () => {
  const table = (title) => ({ type: 'ui', partId: 'p2', component: 'table', schemaVersion: 1, props: { title, columns: [{ code: 'order', kind: 'text' }], rows: [], total: 0, more: false }, refs: [] })
  const message = fold([
    event({ type: 'text_delta', partId: 'p1', text: 'Here they are.' }),
    event(table('First')),
    event({ type: 'ui', partId: 'p3', component: 'followups', schemaVersion: 1, props: { questions: ['Why?'] }, refs: [] }),
    event(table('Second')),
    event({ type: 'text_delta', partId: 'p4', text: 'Done.' }),
    event({ type: 'notice', code: 'over_cap_during_answer' }),
    event({ type: 'notice', code: 'over_cap_during_answer' }),
    event({ type: 'error', code: 'provider_failed', retryable: true }),
    event({ type: 'answer', status: 200, body: { answerSource: 'assistant_v2', parts: [] } }),
  ])
  // The follow-up chips stay after every other part and the text.
  assert.deepEqual(message.parts.map((part) => part.id), ['p1', 'p2', 'p4', 'p3'])
  assert.equal(message.parts[1].props.title, 'Second')
  assert.deepEqual(message.notices, ['over_cap_during_answer'])
  assert.deepEqual(message.error, { code: 'provider_failed', retryable: true })
  assert.equal(message.done, true)

  // An answer line with an error status ends the answer as a failure.
  const failed = fold([event({ type: 'answer', status: 503, body: { code: 'AI_UNAVAILABLE' } })])
  assert.deepEqual([failed.done, failed.body, failed.error], [true, null, { code: 'unavailable', retryable: true }])
  assert.deepEqual(fold([event({ type: 'answer', status: 401, body: {} })]).error, { code: 'signed_out', retryable: false })

  // An answer that streamed no part shows its summary, unless a notice explains it.
  const summary = fold([event({ type: 'answer', status: 200, body: { parts: [], conclusion: { summary: 'Nothing is overdue.' } } })])
  assert.deepEqual(summary.parts, [{ id: 'summary', kind: 'text', text: 'Nothing is overdue.', flags: [] }])
  const refused = fold([event({ type: 'notice', code: 'injection_refused' }), event({ type: 'answer', status: 200, body: { parts: [], conclusion: { summary: 'Not answered.' } } })])
  assert.deepEqual(refused.parts, [])
  // Nor after an error: a withheld answer never shows its summary.
  const withheld = fold([event({ type: 'error', code: 'withheld', retryable: false }), event({ type: 'answer', status: 200, body: { parts: [], conclusion: { summary: 'PO-020 costs 4,200 USD.' } } })])
  assert.deepEqual([withheld.parts, withheld.error], [[], { code: 'withheld', retryable: false }])

  // Stop: the answer so far stays, with the cancelled notice.
  const partial = client.foldAssistantV2Events(S4.slice(0, 5))
  const stopped = client.finishAssistantV2Message(partial, { notice: 'cancelled' })
  assert.deepEqual([stopped.done, stopped.toolStatus, stopped.notices, stopped.parts.length], [true, null, ['cancelled'], 1])
  assert.deepEqual(client.finishAssistantV2Message(partial, { error: { code: 'timeout', retryable: true } }).error, { code: 'timeout', retryable: true })
})

test('one set of follow-up chips per answer, after every other part, and the records a flag names', () => {
  const chips = (partId, question) => event({ type: 'ui', partId, component: 'followups', schemaVersion: 1, props: { questions: [question] }, refs: [] })
  const po = (id) => ({ type: 'purchase_order', id, label: id })
  const message = fold([
    event({ type: 'text_delta', partId: 'p1', text: 'PO-020 and PO-021 are overdue.' }),
    chips('p2', 'Which supplier?'),
    event({ type: 'flag', partId: 'p1', spans: [], refs: [po('PO-020'), po('PO-021')] }),
    event({ type: 'text_delta', partId: 'p3', text: 'PO-021 is older.' }),
    // A second set, under another part id, replaces the first.
    chips('p4', 'Show PO-021'),
    event({ type: 'text_delta', partId: 'p5', text: 'Ask me more.' }),
    event({ type: 'flag', partId: 'p3', spans: [], refs: [po('PO-021')] }),
    event({ type: 'flag', partId: 'p3', spans: [], refs: [po('PO-021')] }),
  ])
  assert.deepEqual(message.parts.map((part) => part.id), ['p1', 'p3', 'p5', 'p4'])
  assert.deepEqual(message.parts.at(-1).props.questions, ['Show PO-021'])
  assert.deepEqual(message.parts[0].refs, [po('PO-020'), po('PO-021')])
  assert.deepEqual(message.parts[1].refs, [po('PO-021')], 'a ref is kept once')
  assert.equal(message.parts[2].refs, undefined)
  assert.deepEqual(client.answerPartsOf(message).map((part) => [part.id, part.refs?.length ?? 0]), [['p1', 2], ['p3', 1], ['p5', 0], ['p4', 0]])
  // A replaced part takes the refs of what it still says, never flags.
  const replaced = fold([
    event({ type: 'text_delta', partId: 'p1', text: 'PO-020 is late, and so is PO-777.' }),
    event({ type: 'replace', partId: 'p1', text: 'PO-020 is late, and so is [not shown].', code: 'foreign_record' }),
    event({ type: 'flag', partId: 'p1', spans: [{ text: '4', kind: 'number', reason: 'not_in_results' }], refs: [po('PO-020')] }),
  ])
  assert.deepEqual(replaced.parts, [{ id: 'p1', kind: 'text', text: 'PO-020 is late, and so is [not shown].', flags: [], replaced: 'foreign_record', refs: [po('PO-020')] }])
  // Rendered, the text chips the records and the chips come last.
  const markup = client.render({ message })
  assert.equal(count(markup, /data-business-id="PO-020"/g), 1)
  assert.ok(markup.indexOf('Ask me more.') < markup.indexOf('Show PO-021'))
  assert.doesNotMatch(markup, /Which supplier\?/)
})

// The conclusion sat under eight rows of orders (2026-11-04): an answer
// that showed a table before it wrote anything leads with its first text.
test('an answer that opens with a display leads with its first text; the chips stay last', () => {
  const chips = event({ type: 'ui', partId: 'p3', component: 'followups', schemaVersion: 1, props: { questions: ['Which supplier?'] }, refs: [] })
  const table = event({ type: 'ui', partId: 'p1', component: 'table', schemaVersion: 1, props: { title: 'Overdue', columns: [{ code: 'order', kind: 'text' }], rows: [], total: 0, more: false }, refs: [] })
  const message = fold([
    table,
    event({ type: 'text_delta', partId: 'p2', text: '8 purchase orders are overdue.' }),
    chips,
    event({ type: 'text_delta', partId: 'p4', text: 'Chase Acme first.' }),
  ])
  assert.deepEqual(client.answerPartsOf(message).map((part) => part.id), ['p2', 'p1', 'p4', 'p3'])
  // Text already first: nothing moves.
  const plain = fold([event({ type: 'text_delta', partId: 'p1', text: 'Two are late.' }), { ...table, partId: 'p2' }])
  assert.deepEqual(client.answerPartsOf(plain).map((part) => part.id), ['p1', 'p2'])
})

test('a stream line that cannot be read is skipped, not fatal', () => {
  for (const line of ['', '   ', 'not json', '{"v":2,"seq":1,"type":"text_delta"}', '{"v":2,"seq":1,"type":"mystery"}', '{"v":3,"seq":1,"type":"notice","code":"cancelled"}', '[1,2]', '{"type":"notice","code":"cancelled"}']) {
    assert.equal(client.parseAssistantV2Line(line), null, line)
  }
  assert.equal(client.parseAssistantV2Line('{"v":2,"seq":4,"type":"text_delta","partId":"p1","text":"Hi"}').text, 'Hi')
  // A line without the {v, seq} envelope is not read.
  assert.equal(client.parseAssistantV2Line('{"type":"progress","step":"reading","sources":["purchase_orders"]}'), null)
  assert.equal(client.parseAssistantV2Line('{"type":"answer","status":200,"body":{"version":"v2"}}'), null)

  assert.deepEqual(client.splitStreamLines('{"a":1}\n\n{"b":2}\n{"c"'), { lines: ['{"a":1}', '{"b":2}'], rest: '{"c"' })
  assert.deepEqual(client.splitStreamLines('{"c":3}', true), { lines: ['{"c":3}'], rest: '' })
})

const encoder = new TextEncoder()
function streamResponse(chunks, { close = true, contentType = 'application/x-ndjson; charset=utf-8' } = {}) {
  const body = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(typeof chunk === 'string' ? encoder.encode(chunk) : chunk)
      if (close) controller.close()
    },
  })
  return new Response(body, { status: 200, headers: { 'content-type': contentType } })
}
async function collect(iterable) {
  const out = []
  for await (const item of iterable) out.push(item)
  return out
}
const request = { threadId: 'thr_7f2c', message: 'What should I reorder this week?', activeContext: { moduleId: 'inventory', entityType: null, entityId: null }, answerLanguage: 'en-US' }

test('the stream client posts the question and yields each event, across chunk breaks and bad lines', async () => {
  const text = [...S4_LINES.slice(0, 4), 'garbage that is not JSON', ...S4_LINES.slice(4)].join('\n') + '\n'
  // Cut the stream at odd places, inside lines.
  const bytes = [text.slice(0, 37), text.slice(37, 400), text.slice(400, 401), text.slice(401)]
  let sent
  const fetcher = async (url, init) => {
    sent = { url, init }
    return streamResponse(bytes)
  }
  const events = await collect(client.streamAssistantV2({ ...request, formResults: [{ formId: 'msg_18:p2', purchaseRequestId: 'pr_231' }] }, { fetcher }))
  assert.equal(sent.url, '/api/ai-runtime/respond')
  assert.equal(sent.init.method, 'POST')
  assert.match(sent.init.headers.Accept, /^application\/x-ndjson/)
  assert.deepEqual(JSON.parse(sent.init.body), { ...request, formResults: [{ formId: 'msg_18:p2', purchaseRequestId: 'pr_231' }] })
  assert.deepEqual(events.map((item) => item.type), ['start', 'tool', 'progress', 'tool', 'text_delta', 'text_delta', 'ui', 'ui', 'flag', 'answer'])
  assert.deepEqual(client.foldAssistantV2Events(events), client.foldAssistantV2Events(S4))

  // A cut inside a multi-byte character waits for the rest of it.
  const chinese = encoder.encode(`${JSON.stringify({ v: 2, seq: 1, type: 'text_delta', partId: 'p1', text: '需要补货' })}
${S4_LINES[9]}
`)
  const cut = chinese.indexOf(encoder.encode('补')[1])
  const zh = await collect(client.streamAssistantV2(request, { fetcher: async () => streamResponse([chinese.slice(0, cut), chinese.slice(cut)]) }))
  assert.deepEqual(zh.map((item) => item.text || item.type), ['需要补货', 'answer'])

  // A plain JSON answer (the rules, before any stream opened) is one answer event.
  const plain = await collect(client.streamAssistantV2(request, { fetcher: async () => new Response(JSON.stringify({ version: 'v2', answerSource: 'workspace_rules' }), { status: 200, headers: { 'content-type': 'application/json' } }) }))
  assert.deepEqual(plain, [{ type: 'answer', status: 200, body: { version: 'v2', answerSource: 'workspace_rules' } }])
})

test('the stream client fails with a code: an HTTP error, an early end, a stall, and Stop', async () => {
  const httpError = await collect(client.streamAssistantV2(request, { fetcher: async () => new Response(JSON.stringify({ error: 'Sign in' }), { status: 401, headers: { 'content-type': 'application/json' } }) })).catch((error) => error)
  assert.ok(httpError instanceof client.ApiError)
  assert.deepEqual(client.assistantV2Failure(httpError), { code: 'signed_out', retryable: false })

  const ended = await collect(client.streamAssistantV2(request, { fetcher: async () => streamResponse(S4_LINES.slice(0, 5).map((line) => `${line}\n`)) })).catch((error) => error)
  assert.equal(ended.code, 'incomplete')
  assert.deepEqual(client.assistantV2Failure(ended), { code: 'incomplete', retryable: true })

  // An open stream that sends nothing more: the idle timer ends it.
  const stalledFetcher = async (_url, init) => {
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(`${S4_LINES[0]}\n`))
        init.signal.addEventListener('abort', () => controller.error(new DOMException('aborted', 'AbortError')))
      },
    })
    return new Response(body, { status: 200, headers: { 'content-type': 'application/x-ndjson' } })
  }
  const seen = []
  const stalled = await (async () => {
    for await (const item of client.streamAssistantV2(request, { fetcher: stalledFetcher, idleTimeoutMs: 40 })) seen.push(item.type)
  })().catch((error) => error)
  assert.deepEqual(seen, ['start'])
  assert.equal(stalled.code, 'idle_timeout')
  assert.deepEqual(client.assistantV2Failure(stalled), { code: 'timeout', retryable: true })

  // Stop aborts the caller's signal.
  const stop = new AbortController()
  const stopped = await (async () => {
    for await (const item of client.streamAssistantV2(request, { fetcher: stalledFetcher, signal: stop.signal })) if (item.type === 'start') stop.abort()
  })().catch((error) => error)
  assert.equal(stopped.code, 'stopped')

  assert.deepEqual(client.assistantV2Failure(new TypeError('Failed to fetch')), { code: 'network', retryable: true })
  assert.match(client.newThreadId(), /^thr_[A-Za-z0-9]{8,24}$/)
  assert.notEqual(client.newThreadId(), client.newThreadId())
})

test('a folded answer renders its parts in English with no Chinese, and the status line while it streams', () => {
  const done = client.render({ message: client.foldAssistantV2Events(S4) })
  assert.doesNotMatch(done, CJK)
  assert.match(done, /data-testid="ai-v2-message" data-done="true"/)
  assert.match(done, /Three items reach their reorder point before Friday\. Tick the ones you want and I will fill in a request\./)
  // Text, then the form, then the follow-up chips, in that order.
  const order = ['data-testid="ai-v2-text"', 'data-testid="ai-v2-pr-form"', 'data-testid="ai-v2-followups"'].map((marker) => done.indexOf(marker))
  assert.ok(order.every((at) => at >= 0) && order[0] < order[1] && order[1] < order[2], String(order))
  assert.equal(count(done, /data-testid="ai-follow-up-chip"/g), 2)
  assert.doesNotMatch(done, /data-testid="ai-progress-line"/)
  assert.doesNotMatch(done, /data-testid="ai-v2-error"|data-testid="ai-v2-notice"/)
  // Earlier answers keep no next questions.
  assert.doesNotMatch(client.render({ message: client.foldAssistantV2Events(S4), latest: false }), /data-testid="ai-v2-followups"/)

  const running = client.render({ message: client.foldAssistantV2Events(S4.slice(0, 2)) })
  assert.match(running, /data-testid="ai-progress-line"[^>]*>.*Working out what to reorder…/)
  assert.doesNotMatch(running, /suggest_purchase_lines/)
  const reading = client.render({ message: client.foldAssistantV2Events(S4.slice(0, 4)) })
  assert.match(reading, /Reading inventory…/)
  // Once text streams and no tool runs, the text is the progress.
  assert.doesNotMatch(client.render({ message: client.foldAssistantV2Events(S4.slice(0, 6)) }), /data-testid="ai-progress-line"/)
  assert.match(client.render({ message: client.emptyAssistantV2Message() }), /Reading your question…/)

  // A flagged figure is underlined; replaced text shows only the replacement.
  const flagged = client.render({ message: fold([event({ type: 'text_delta', partId: 'p1', text: 'Order 600 boxes.' }), event({ type: 'flag', partId: 'p1', spans: [{ text: '600', kind: 'number', reason: 'not_in_results' }] })]) })
  assert.match(flagged, /data-testid="ai-flag" data-flag-kind="number"[^>]*>600</)
})

test('notices and errors are worded by code, Retry only on the latest retryable answer, and Chinese follows the answer', () => {
  const stopped = client.finishAssistantV2Message(client.foldAssistantV2Events(S4.slice(0, 5)), { notice: 'cancelled' })
  const markup = client.render({ message: stopped })
  assert.match(markup, /data-testid="ai-v2-notice" data-code="cancelled"[^>]*>Stopped\. Nothing was changed\.</)
  assert.match(markup, /Three items reach their reorder point before Friday\./)
  assert.doesNotMatch(markup, /data-testid="ai-progress-line"/)

  const timedOut = client.finishAssistantV2Message(client.emptyAssistantV2Message(), { error: { code: 'timeout', retryable: true } })
  const failed = client.render({ message: timedOut })
  assert.match(failed, /role="alert" data-testid="ai-v2-error" data-code="timeout"/)
  assert.match(failed, /The assistant stopped responding, so this answer is incomplete\. Nothing was changed\./)
  assert.match(failed, /data-testid="ai-v2-retry"[^>]*>.*Retry/)
  assert.doesNotMatch(client.render({ message: timedOut, latest: false }), /data-testid="ai-v2-retry"/)
  // A code the panel does not know reads as the generic line, never as the code.
  const unknown = client.render({ message: client.finishAssistantV2Message(client.emptyAssistantV2Message(), { error: { code: 'provider_failed', retryable: true } }) })
  assert.match(unknown, /Something went wrong while answering\. Nothing was changed\./)
  assert.doesNotMatch(unknown, />[^<]*provider_failed/)
  const signedOut = client.render({ message: client.finishAssistantV2Message(client.emptyAssistantV2Message(), { error: { code: 'signed_out', retryable: false } }) })
  assert.doesNotMatch(signedOut, /data-testid="ai-v2-retry"/)
  for (const code of ['over_cap', 'over_cap_during_answer', 'cost_ceiling', 'unavailable', 'rate_limited', 'injection_refused', 'cancelled', 'refused', 'ai_off', 'no_provider']) {
    const notice = client.render({ message: fold([event({ type: 'notice', code })]) })
    assert.match(notice, new RegExp(`data-code="${code}"[^>]*>[A-Z][^<]+\\.<`), code)
    assert.doesNotMatch(notice, CJK, code)
  }

  // A Chinese question gets Chinese copy on the English interface.
  const chinese = fold([
    event({ type: 'start', threadId: 'thr_7f2c', messageId: 'msg_20', model: 'claude-sonnet-5-5', language: 'zh-CN' }),
    event({ type: 'tool', id: 'toolu_02', name: 'attention_list', state: 'running' }),
  ])
  assert.match(client.render({ message: chinese }), /正在查看需要处理的事项…/)
  assert.match(client.render({ message: client.finishAssistantV2Message(chinese, { notice: 'cancelled' }) }), /已停止。未修改任何数据。/)
})

test('a created request keeps its receipt by form id', () => {
  const message = client.foldAssistantV2Events(S4)
  const created = client.render({ message, receipts: { 'msg_19:p2': { id: 'PR-0231', version: 1, status: 'draft' } } })
  assert.match(created, /data-testid="ai-v2-pr-receipt" data-status="draft"/)
  assert.doesNotMatch(created, /data-testid="ai-v2-pr-form"/)
  // Another form's receipt does not land on this one.
  assert.match(client.render({ message, receipts: { 'msg_18:p2': { id: 'PR-0230', version: 1, status: 'draft' } } }), /data-testid="ai-v2-pr-form"/)

})

test('a setup card keeps what it created by form id, and the setup tool has a status line', () => {
  const props = {
    formId: 'thr_7f2c:msg_21:p1',
    suppliers: [{ key: 's1', name: { value: 'Northwind Metals', source: 'user_typed' }, code: { value: null, source: 'generated' }, contact: { value: null, source: 'not_given' }, email: { value: null, source: 'not_given' }, phone: { value: null, source: 'not_given' }, paymentTerms: { value: null, label: null, typed: null, source: 'not_given' }, problems: [] }],
    items: [],
    codeSeed: { prefix: 'SUP-', next: 1, width: 3 },
    paymentTerms: [],
    supplierOptions: [],
    workspaceCurrency: 'USD',
    canCreateSuppliers: true,
    canCreateItems: true,
  }
  const message = fold([
    event({ type: 'start', threadId: 'thr_7f2c', messageId: 'msg_21', model: 'claude-sonnet-5-5', language: 'en-US' }),
    event({ type: 'ui', partId: 'p1', component: 'setup_form', schemaVersion: 1, props, refs: [] }),
  ])
  assert.match(client.render({ message }), /data-testid="ai-v2-setup-form"[^]*value="SUP-001"/)
  const receipt = { results: { s1: { status: 'created', type: 'supplier', id: 'SUP-9', label: 'Northwind Metals' } } }
  const created = client.render({ message, setupReceipts: { 'thr_7f2c:msg_21:p1': receipt } })
  assert.match(created, /data-testid="ai-v2-setup-row-created"[^]*data-business-id="SUP-9"/)
  assert.match(created, /data-testid="ai-v2-setup-done"/)
  assert.doesNotMatch(client.render({ message, setupReceipts: { 'thr_7f2c:msg_20:p1': receipt } }), /data-testid="ai-v2-setup-row-created"/)
  const reading = fold([event({ type: 'start', threadId: 'thr_7f2c', messageId: 'msg_22', model: 'claude-sonnet-5-5', language: 'en-US' }), event({ type: 'tool', id: 'toolu_03', name: 'setup_status', state: 'running' })])
  assert.match(client.render({ message: reading }), /Checking your workspace setup…/)
})

test('a record card keeps what its clicks did by card id, and a Chinese answer words it in Chinese', () => {
  const props = {
    cardId: 'thr_7f2c:msg_23:p2',
    record: { ref: { type: 'purchase_request', id: 'PR-0231', label: 'PR-0231' }, type: 'purchase_request', status: 'submitted', version: 3, suppliers: ['Northstar Electronics'], lines: [{ sku: 'LDM-002', name: 'Temperature Sensor', quantity: 300, unit: 'pcs' }], lineCount: 1 },
    allowed: ['approve', 'reject', 'create_po'],
    actions: ['approve', 'reject'],
    path: { recommendation: 'direct_po', reasons: ['direct_po_ok'] },
  }
  const message = (language) => fold([
    event({ type: 'start', threadId: 'thr_7f2c', messageId: 'msg_23', model: 'claude-sonnet-5-5', language }),
    event({ type: 'ui', partId: 'p2', component: 'record_actions', schemaVersion: 1, props, refs: [{ type: 'purchase_request', id: 'PR-0231', label: 'PR-0231' }] }),
  ])
  const open = client.render({ message: message('en-US') })
  assert.match(open, /data-testid="ai-v2-record-actions"[^>]*data-status="submitted"[^]*data-action="approve"[^>]*>Approve</)
  assert.doesNotMatch(open, CJK)
  const receipt = { type: 'purchase_request', id: 'PR-0231', status: 'approved', version: 4, steps: [{ actionId: 'thr_7f2c:msg_23:p2:approve:v3', action: 'approve', created: [] }] }
  const approved = client.render({ message: message('en-US'), actionReceipts: { 'thr_7f2c:msg_23:p2': receipt } })
  assert.match(approved, /data-status="approved"[^]*data-testid="ai-v2-record-done" data-action="approve"[^>]*>You approved it\./)
  // Approved: the next step, ordering it, is offered in the same card.
  assert.match(approved, /data-action="create_po"[^>]*>Create purchase order</)
  assert.doesNotMatch(client.render({ message: message('en-US'), actionReceipts: { 'thr_7f2c:msg_22:p2': receipt } }), /ai-v2-record-done/)
  assert.match(client.render({ message: message('zh-CN') }), /采购申请[^]*批准[^]*驳回/)
})
