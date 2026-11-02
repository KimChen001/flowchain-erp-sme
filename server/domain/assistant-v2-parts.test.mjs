import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { PROGRESS_STEPS, STREAM_EVENT_TYPES, UI_COMPONENTS, parsePartProps, prFormRowSchema, safeParsePartProps, safeParseStreamEvent, safeParseStreamLine } from '../../shared/assistant-protocol.mjs'
import { sanitizeSuggestionTrail } from '../../shared/prefill-suggestions.mjs'

// The assistant v2 stream protocol and answer parts (docs/ai-assistant-v2-design.md
// §3.7, §4, §4.1). The parts are rendered as the browser would: esbuild bundles
// the client modules and react-dom/server renders them.

const CJK = /[㐀-鿿]/
const root = resolve(import.meta.dirname, '../..')

async function loadClient() {
  const directory = await mkdtemp(join(tmpdir(), 'flowchain-assistant-v2-parts-'))
  const entry = `
    import { createElement } from 'react'
    import { renderToStaticMarkup } from 'react-dom/server'
    import { AnswerParts } from './src/modules/ai-assistant/v2/parts/AnswerParts.tsx'
    import { StreamingText } from './src/modules/ai-assistant/v2/parts/StreamingText.tsx'
    import { PurchaseRequestFormPart, addedFormRow, draftRequestBody, initialFormLines } from './src/modules/ai-assistant/v2/parts/PurchaseRequestFormPart.tsx'
    const navigate = () => {}
    export const text = (props) => renderToStaticMarkup(createElement(StreamingText, { onNavigate: navigate, ...props }))
    export const answer = (props) => renderToStaticMarkup(createElement(AnswerParts, { threadId: 'thr_7f2c', messageId: 'msg_19', onNavigate: navigate, onFollowUp: () => {}, onChoose: () => {}, ...props }))
    export const form = (props) => renderToStaticMarkup(createElement(PurchaseRequestFormPart, { partId: 'p2', threadId: 'thr_7f2c', messageId: 'msg_19', onNavigate: navigate, ...props }))
    export { addedFormRow, draftRequestBody, initialFormLines }
  `
  const result = await build({
    stdin: { contents: entry, resolveDir: root, loader: 'tsx', sourcefile: 'assistant-v2-parts-entry.tsx' },
    bundle: true, platform: 'node', format: 'cjs', write: false, jsx: 'automatic',
    define: { 'import.meta.env.DEV': 'false' }, logLevel: 'silent', loader: { '.css': 'empty', '.svg': 'empty', '.png': 'empty' },
  })
  const file = join(directory, 'parts.cjs')
  await writeFile(file, result.outputFiles[0].text)
  try {
    return (await import(pathToFileURL(file).href)).default
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

const count = (markup, pattern) => (markup.match(pattern) || []).length

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

const ref = (type, id, label = id) => ({ type, id, label })
const item = (id, sku, name) => ({ id, sku, name, unit: 'pcs' })
const row = (over = {}) => ({
  item: item('itm_42', 'SKU-1007', 'Corrugated box 40x30'),
  onHand: 120, safetyStock: 200, reorderPoint: 300,
  suggestedQuantity: { value: 600, source: 'reorder_gap_raised_to_moq' },
  supplier: { id: 'sup_3', name: 'Acme Packaging', source: 'preferred' },
  needByDate: { value: '2026-11-20', source: 'lead_time', leadTimeDays: 14, shortWeekOf: '2026-11-16' },
  orderByDate: '2026-11-06',
  estimatedUnitPrice: { value: 0.42, currency: 'USD', source: 'reference_price' },
  warehouse: { id: 'WH-1', label: 'Main warehouse' },
  covered: null,
  checked: false,
  ...over,
})
const formProps = (over = {}) => ({
  formId: 'msg_19:p2', source: 'toolu_01', canCreate: true, lines: [],
  suggested: [
    row(),
    row({ item: item('itm_43', 'SKU-1010', 'Packing tape 48mm'), covered: { ref: ref('purchase_request', 'PR-0228') } }),
    // A suggestion the server marked ticked is still shown unticked.
    row({ item: item('itm_44', 'SKU-1022', 'Stretch film'), checked: true }),
  ],
  ...over,
})

const tableProps = {
  title: 'Overdue purchase orders',
  columns: [{ code: 'order', kind: 'ref' }, { code: 'supplier', kind: 'text' }, { code: 'promised_date', kind: 'date' }, { code: 'days_overdue', kind: 'number' }, { code: 'remaining_quantity', kind: 'quantity' }, { code: 'amount', kind: 'money' }, { code: 'status', kind: 'status' }],
  rows: [
    { order: ref('purchase_order', 'PO-020'), supplier: 'Acme Packaging', promised_date: '2026-10-28', days_overdue: 5, remaining_quantity: 1234, amount: { amount: 1500, currency: 'USD' }, status: { code: 'overdue' } },
    { order: ref('purchase_order', 'PO-021'), supplier: 'Delta Metals', promised_date: '2026-10-30', days_overdue: 3, remaining_quantity: 40, amount: { amount: null, currency: 'USD' }, status: { code: 'issued' } },
  ],
  total: 12, more: true, listRoute: { moduleId: 'procurement:orders', query: { view: 'overdue' } },
}
const recordsProps = {
  emphasis: 'overdue',
  cards: [
    { ref: ref('purchase_order', 'PO-020'), title: 'Acme Packaging', status: { code: 'overdue' }, date: { kind: 'overdue', days: 3 }, figures: [{ code: 'remaining_quantity', value: 40, unit: 'quantity', unitLabel: 'pcs' }] },
    { ref: ref('purchase_request', 'PR-0231'), status: { code: 'pending_approval' }, date: { kind: 'waiting', days: 1 } },
  ],
}
const kpisProps = { tiles: [{ code: 'open_purchase_orders', value: 14, unit: 'count' }, { code: 'spend_this_month', value: null, unit: 'money', currency: 'USD', hidden: true }] }
const chartProps = { kind: 'line', title: 'Monthly spend', x: { code: 'month', values: ['2026-09', '2026-10'] }, series: [{ code: 'spend', values: [1200, 1800] }], unit: 'money', currency: 'USD', reportRoute: { moduleId: 'reports' } }
const choicesProps = { promptCode: 'pick_item', options: [ref('item', 'itm_42', 'SKU-1007'), ref('item', 'itm_43', 'SKU-1010')] }
const ui = (id, component, props, refs = []) => ({ id, type: 'ui', component, schemaVersion: 1, props, refs })
const everyPart = () => [
  { id: 'p1', type: 'text', text: 'PO-020 is **3 days late**; see the table.' },
  ui('p2', 'table', tableProps, [ref('purchase_order', 'PO-020'), ref('purchase_order', 'PO-021')]),
  ui('p3', 'records', recordsProps),
  ui('p4', 'kpis', kpisProps),
  ui('p5', 'chart', chartProps),
  ui('p6', 'choices', choicesProps),
  ui('p7', 'pr_form', formProps(), [ref('item', 'itm_42', 'SKU-1007')]),
  ui('p8', 'followups', { questions: ['Which supplier is most late?'] }),
]

test('the protocol accepts the design example and every event type, and lists the names', () => {
  for (const line of S4_LINES) {
    const result = safeParseStreamLine(line)
    assert.ok(result.success, `${line.slice(0, 60)}: ${result.success ? '' : JSON.stringify(result.error.issues)}`)
  }
  assert.deepEqual([...STREAM_EVENT_TYPES], ['start', 'progress', 'tool', 'text_delta', 'ui', 'flag', 'replace', 'notice', 'error', 'answer'])
  assert.deepEqual([...UI_COMPONENTS], ['table', 'records', 'chart', 'kpis', 'choices', 'pr_form', 'followups', 'citations'])
  const envelope = { v: 2, seq: 3 }
  for (const event of [
    { ...envelope, type: 'flag', partId: 'p1', spans: [{ text: '600', kind: 'number', reason: 'not_in_tool_results' }] },
    { ...envelope, type: 'replace', partId: 'p1', text: 'Nothing was approved.', code: 'unbacked_action_claim' },
    { ...envelope, type: 'notice', code: 'over_cap_during_answer' },
    { ...envelope, type: 'error', code: 'withheld', retryable: false },
    { ...envelope, type: 'answer', status: 409, body: { code: 'AI_OVER_CAP', error: 'x' } },
  ]) assert.ok(safeParseStreamEvent(event).success, event.type)
  for (const [component, props] of [['table', tableProps], ['records', recordsProps], ['kpis', kpisProps], ['chart', chartProps], ['choices', choicesProps], ['pr_form', formProps()], ['citations', { passages: [{ id: 'ps_1', title: 'Supplier manual', excerpt: 'Deliveries arrive on weekdays.' }] }]]) {
    assert.ok(safeParseStreamEvent({ ...envelope, type: 'ui', partId: 'p2', component, schemaVersion: 1, props, refs: [] }).success, component)
  }
  // The old progress and answer fields are kept, so the existing NDJSON parser reads a v2 stream.
  const progress = JSON.parse(S4_LINES[2])
  assert.deepEqual([progress.type, progress.step, progress.sources], ['progress', 'reading', ['inventory']])
  assert.deepEqual([...PROGRESS_STEPS], ['reading', 'writing', 'checking'])
  const final = parsePartProps('followups', JSON.parse(S4_LINES[7]).props)
  assert.equal(final.questions.length, 2)
})

test('the protocol rejects malformed events and props', () => {
  const start = JSON.parse(S4_LINES[0])
  const form = JSON.parse(S4_LINES[6])
  const malformed = [
    { ...start, v: 1 },
    { ...start, v: undefined },
    { ...start, seq: -1 },
    { ...start, language: 'fr-FR' },
    { v: 2, seq: 1, type: 'thinking' },
    { v: 2, seq: 1, type: 'text_delta', text: 'no part id' },
    { v: 2, seq: 1, type: 'progress', step: 'guessing' },
    { v: 2, seq: 1, type: 'notice', code: 'something_else' },
    { v: 2, seq: 1, type: 'replace', partId: 'p1', text: 'x', code: 'any_reason' },
    { v: 2, seq: 1, type: 'error', code: 'withheld' },
    { ...form, component: 'iframe' },
    { ...form, schemaVersion: 2 },
    { ...form, props: { ...form.props, formId: undefined } },
    { ...form, props: { ...form.props, suggested: [{ ...form.props.suggested[0], estimatedUnitPrice: { value: -1, currency: 'USD', source: 'reference_price' } }] } },
    // A price hidden for the role, or missing, carries no value; a reference price carries one.
    { ...form, props: { ...form.props, suggested: [{ ...form.props.suggested[0], estimatedUnitPrice: { value: 0.42, currency: 'USD', source: 'masked' } }] } },
    { ...form, props: { ...form.props, suggested: [{ ...form.props.suggested[0], estimatedUnitPrice: { value: 0.42, currency: 'USD', source: 'missing' } }] } },
    { ...form, props: { ...form.props, suggested: [{ ...form.props.suggested[0], estimatedUnitPrice: { value: null, currency: null, source: 'reference_price' } }] } },
    { ...form, refs: [{ type: 'item', id: 'itm_42' }] },
  ]
  for (const event of malformed) assert.equal(safeParseStreamEvent(event).success, false, JSON.stringify(event).slice(0, 120))
  assert.equal(safeParseStreamLine('{"v":2,').success, false)
  // One currency per chart, one value per x value.
  assert.equal(safeParsePartProps('chart', { ...chartProps, currency: undefined }).success, false)
  assert.equal(safeParsePartProps('chart', { ...chartProps, unit: 'count' }).success, false)
  assert.equal(safeParsePartProps('chart', { ...chartProps, series: [{ code: 'spend', values: [1] }] }).success, false)
  assert.equal(safeParsePartProps('chart', { ...chartProps, series: [{ code: 'spend', currency: 'EUR', values: [1, 2] }] }).data?.series[0].currency, undefined, 'a series carries no currency of its own')
  assert.equal(safeParsePartProps('followups', { questions: ['x'.repeat(91)] }).success, false)
  assert.equal(safeParsePartProps('followups', { questions: ['a', 'b', 'c', 'd'] }).success, false)
  assert.equal(safeParsePartProps('kpis', { tiles: [kpisProps.tiles[0]] }).success, false)
  assert.equal(safeParsePartProps('kpis', { tiles: [kpisProps.tiles[0], { ...kpisProps.tiles[1], value: 1800 }] }).success, false, 'a hidden tile carries no value')
  assert.equal(safeParsePartProps('table', { ...tableProps, total: 1 }).success, false)
  assert.equal(safeParsePartProps('table', { ...tableProps, listRoute: { moduleId: 'https://example.com' } }).success, false)
  assert.equal(safeParsePartProps('records', { cards: [] }).success, false)
  assert.equal(safeParsePartProps('mystery', {}).success, false)
})

test('every part renders in English with no Chinese', async () => {
  const client = await loadClient()
  const markup = client.answer({ parts: everyPart(), language: 'en-US' })
  assert.doesNotMatch(markup, CJK)
  for (const testId of ['ai-v2-text', 'ai-v2-table', 'ai-v2-records', 'ai-v2-kpis', 'ai-v2-chart', 'ai-v2-choices', 'ai-v2-pr-form', 'ai-v2-followups']) assert.match(markup, new RegExp(`data-testid="${testId}"`), testId)
  // Labels by column code, figures through the workspace formatters, statuses in the palette.
  for (const text of ['Days overdue', 'Promised', 'Remaining', '1,234', '$1,500.00', 'Oct 28, 2026', 'Show all 12', '3 days overdue', 'Waiting 1 day', 'Pending approval', 'Not available for your role', 'View in Reports', 'Which item do you mean?', 'Create draft request (']) assert.ok(markup.includes(text), text)
  assert.match(markup, /data-testid="ai-v2-status" data-tone="danger"[^>]*>Overdue</)
  assert.match(markup, /data-testid="ai-v2-status" data-tone="warning"[^>]*>Pending approval</)
  // A hidden amount is a dash, never $0.
  assert.doesNotMatch(markup, /\$0\.00/)
  // The chart loads on its own; until then it holds its place.
  assert.match(markup, /data-testid="ai-v2-chart"[^]*Loading chart…/)
  assert.match(markup, /data-testid="ai-follow-up-chip"[^>]*>Which supplier is most late\?</)
})

test('a Chinese answer gets Chinese labels on the English interface', async () => {
  const client = await loadClient()
  const markup = client.answer({ parts: everyPart(), language: 'zh-CN' })
  for (const label of ['逾期天数', '承诺交期', '供应商', '逾期 3 天', '已等待 1 天', '待审批', '你的角色无权查看', '在报表中心查看', '你指的是哪个物料？', '采购申请', '建议补货的物料', '全部加入', '仍要采购', '查看全部 12 条']) assert.ok(markup.includes(label), label)
  for (const label of ['Days overdue', 'Not available for your role', 'Show all', 'Order anyway', 'Add all suggested', 'Which item do you mean?']) assert.ok(!markup.includes(label), label)
  // Numbers and amounts keep the workspace locale.
  assert.ok(markup.includes('1,234') && markup.includes('$1,500.00'))
})

test('record codes become chips once, only for the refs given, and flags are underlined', async () => {
  const client = await loadClient()
  const markup = client.text({
    text: 'PO-020 holds SKU-1007. PO-020 is late, and PO-999 is not one of yours. About 600 pcs remain.',
    refs: [ref('purchase_order', 'PO-020'), ref('item', 'itm_42', 'SKU-1007'), ref('supplier', 'sup_3', 'Acme Packaging')],
    flags: [{ text: '600', kind: 'number', reason: 'not_in_tool_results' }],
  })
  assert.equal(count(markup, /data-testid="ai-record-chip"/g), 2)
  assert.equal(count(markup, /data-business-id="PO-020"/g), 1)
  assert.equal(count(markup, /data-business-id="itm_42"[^>]*>SKU-1007</g), 1)
  assert.doesNotMatch(markup, /data-business-id="PO-999"/)
  assert.match(markup, /PO-999 is not one of yours/)
  assert.match(markup, /<span data-testid="ai-flag" data-flag-kind="number" title="Not matched to your records" class="[^"]*decoration-dotted[^"]*"[^>]*>600<\/span>/)
  // A Chinese answer's flag says so in Chinese.
  assert.match(client.text({ text: '约 600 件', flags: [{ text: '600', kind: 'number', reason: 'x' }], language: 'zh-CN' }), /title="未与记录核对"/)
})

test('the text keeps lists, bold and code, and drops images and links to other sites', async () => {
  const client = await loadClient()
  const markup = client.text({ text: 'First **check** the `PO-020` line.\n\n![chart](https://evil.example/x.png)\n- Read [the guide](https://evil.example/guide)\n- Or visit https://evil.example/raw or <http://evil.example/a>\n\n1. one\n2. two' })
  assert.doesNotMatch(markup, /<img|href=|evil\.example|https?:/)
  assert.match(markup, /<p>First <strong class="font-semibold">check<\/strong> the <code[^>]*>PO-020<\/code> line\.<\/p>/)
  assert.match(markup, /<ul class="list-disc[^"]*"><li>Read the guide<\/li><li>Or visit or<\/li><\/ul>/)
  assert.match(markup, /<ol start="1" class="list-decimal[^"]*"><li>one<\/li><li>two<\/li><\/ol>/)
  // A bold marker still open while the text streams is not shown.
  assert.doesNotMatch(client.text({ text: 'Three items are **below' }), /\*\*/)
})

test('the form ticks nothing for the user, and a covered row needs "Order anyway"', async () => {
  const client = await loadClient()
  const markup = client.form({ props: formProps() })
  assert.doesNotMatch(markup, CJK)
  assert.equal(count(markup, /data-testid="ai-v2-pr-row"/g), 3)
  assert.equal(count(markup, /data-checked="true"/g), 0)
  assert.doesNotMatch(markup, /checked=""/)
  for (const text of ['On hand 120', 'Safety stock 200', 'Suggested 600 pcs', 'Order by Nov 6, 2026', 'Add all suggested', 'Add an item']) assert.ok(markup.includes(text), text)
  const rows = markup.split('data-testid="ai-v2-pr-row"').slice(1)
  const covered = rows.find((value) => value.includes('data-covered="true"'))
  assert.match(covered, /<input type="checkbox" data-testid="ai-v2-pr-tick" disabled=""/)
  assert.match(covered, /Already requested: <button[^>]*data-business-id="PR-0228"[^>]*>PR-0228<\/button>/)
  assert.match(covered, /data-testid="ai-v2-pr-order-anyway"[^>]*>Order anyway</)
  for (const open of rows.filter((value) => value.includes('data-covered="false"'))) assert.doesNotMatch(open, /disabled=""[^>]*aria-label="Order/)
  // One primary button; with nothing ticked it is off. No Submit before the request exists.
  assert.equal(count(markup, /data-primary="true"/g), 1)
  assert.match(markup, /data-testid="ai-v2-pr-create" data-primary="true" disabled=""[^>]*>Create draft request \(0 lines\)</)
  assert.doesNotMatch(markup, /Submit for approval|data-testid="ai-v2-pr-submit"/)
})

test('a named item arrives ticked; a missing price, a masked price or an unclear supplier turn create off', async () => {
  const client = await loadClient()
  const named = (over) => formProps({ suggested: [], lines: [row({ checked: true, suggestedQuantity: { value: 5, source: 'user_named' }, ...over })] })
  const ready = client.form({ props: named({}) })
  assert.equal(count(ready, /data-checked="true"/g), 1)
  assert.match(ready, /data-testid="ai-v2-pr-create" data-primary="true"[^>]*>Create draft request \(1 line\)</)
  assert.doesNotMatch(ready, /data-testid="ai-v2-pr-create" data-primary="true" disabled=""/)
  for (const text of ['Acme Packaging (preferred)', 'Lead time 14 days', 'Stock runs short in week of Nov 16, 2026', '$0.42', 'Reference price', 'Main warehouse', 'You asked for this']) assert.ok(ready.includes(text), text)

  const missing = client.form({ props: named({ estimatedUnitPrice: { value: null, currency: null, source: 'missing' } }) })
  assert.match(missing, /data-testid="ai-v2-pr-create" data-primary="true" disabled=""/)
  assert.match(missing, /No reference price/)
  assert.match(missing, /data-testid="ai-v2-pr-blocked"[^]*no price you can use/)
  assert.match(missing, /data-testid="ai-v2-pr-open-full-form"[^>]*>Open full form</)
  assert.equal(count(missing, /data-primary="true"/g), 1)

  const masked = client.form({ props: named({ estimatedUnitPrice: { value: null, currency: null, source: 'masked' } }) })
  assert.match(masked, /Price hidden for your role/)
  assert.match(masked, /data-testid="ai-v2-pr-create" data-primary="true" disabled=""/)

  const unclear = client.form({ props: named({ supplier: null, suppliers: [{ id: 'sup_3', name: 'Acme Packaging', preferred: true }, { id: 'sup_4', name: 'Delta Packaging', preferred: true }] }) })
  assert.match(unclear, /<option value="" selected="">Choose a supplier<\/option>/)
  assert.match(unclear, /Choose a supplier for each ticked line\./)
  assert.match(unclear, /data-testid="ai-v2-pr-create" data-primary="true" disabled=""/)
})

test('every field of a ticked line says where its value came from', async () => {
  const client = await loadClient()
  const named = (over) => formProps({ suggested: [], lines: [row({ checked: true, suggestedQuantity: { value: 5, source: 'user_named' }, ...over })] })
  const fieldsOf = (markup) => markup.split('data-testid="ai-v2-pr-field"').slice(1).map((block) => [block.match(/^ data-field="(\w+)"/)[1], block.split('data-testid="ai-v2-pr-search"')[0]])
  const chip = (markup, field) => fieldsOf(markup).find(([name]) => name === field)[1].match(/data-testid="ai-v2-pr-source"[^>]*>([^<]+)</)?.[1]
  const ready = client.form({ props: named({}) })
  const fields = fieldsOf(ready)
  assert.deepEqual(fields.map(([field]) => field), ['quantity', 'supplier', 'needBy', 'price', 'warehouse'])
  for (const [field, block] of fields) assert.equal(count(block, /data-testid="ai-v2-pr-source"/g), 1, field)
  assert.deepEqual(['quantity', 'supplier', 'needBy', 'price', 'warehouse'].map((field) => chip(ready, field)), ['You asked for this', 'Preferred supplier', 'Lead time 14 days', 'Reference price', 'Item default'])
  const other = client.form({ props: named({ supplier: { id: 'sup_3', name: 'Acme Packaging', source: 'only_approved' }, needByDate: { value: '2026-11-03', source: 'today', leadTimeDays: null } }) })
  assert.deepEqual([chip(other, 'supplier'), chip(other, 'needBy')], ['Only approved supplier', 'Today (no lead time recorded)'])
  const asked = client.form({ props: named({ supplier: { id: 'sup_3', name: 'Acme Packaging', source: 'user_named' }, needByDate: { value: '2026-11-30', source: 'user_named', leadTimeDays: 14 } }) })
  assert.deepEqual([chip(asked, 'supplier'), chip(asked, 'needBy')], ['You asked for this', 'You asked for this'])
  const chinese = client.form({ props: named({}), language: 'zh-CN' })
  for (const text of ['首选供应商', '物料默认仓库', '按你的要求']) assert.ok(chinese.includes(text), text)
})

test('"Open full form" carries the line that turned create off, and says so when several are ticked', async () => {
  const client = await loadClient()
  const props = formProps({ suggested: [], lines: [
    row({ checked: true }),
    row({ item: item('itm_43', 'SKU-1010', 'Packing tape 48mm'), checked: true, estimatedUnitPrice: { value: null, currency: null, source: 'masked' } }),
  ] })
  const markup = client.form({ props })
  assert.match(markup, /data-testid="ai-v2-pr-create" data-primary="true" disabled=""/)
  assert.match(markup, /data-testid="ai-v2-pr-handoff-line"[^>]*>The full form opens with SKU-1010 only.</)
  assert.doesNotMatch(client.form({ props: formProps({ suggested: [], lines: [row({ checked: true })] }) }), /ai-v2-pr-handoff-line/)
})

test('an item added from the search reads the reference price the item suppliers read sends as a string', async () => {
  const client = await loadClient()
  const catalog = { itemId: 'itm_50', sku: 'SKU-2001', itemName: 'Pallet wrap', purchaseUnit: 'roll', defaultWarehouseId: 'WH-1' }
  const added = client.addedFormRow(catalog, [
    { id: 'sup_3', name: 'Acme Packaging', preferred: true, referencePrice: '0.42', currency: 'USD', leadTimeDays: 14 },
    { id: 'sup_4', name: 'Delta Packaging', preferred: false, referencePrice: null, currency: null, leadTimeDays: null },
  ], '2026-11-02')
  assert.deepEqual(added.estimatedUnitPrice, { value: 0.42, currency: 'USD', source: 'reference_price' })
  assert.deepEqual(added.supplier, { id: 'sup_3', name: 'Acme Packaging', source: 'preferred' })
  assert.deepEqual(added.suppliers.map((supplier) => supplier.unitPrice), [0.42, null])
  assert.deepEqual(added.needByDate, { value: '2026-11-16', source: 'lead_time', leadTimeDays: 14 })
  // The row the client builds meets the same protocol the server's rows do.
  assert.ok(prFormRowSchema.safeParse(added).success)
  const masked = client.addedFormRow(catalog, [{ id: 'sup_3', name: 'Acme Packaging', preferred: true, referencePrice: null, currency: 'USD', leadTimeDays: 14, restrictedFields: ['referencePrice'] }], '2026-11-02')
  assert.deepEqual(masked.estimatedUnitPrice, { value: null, currency: null, source: 'masked' })
  assert.ok(prFormRowSchema.safeParse(masked).success)
  const addedProps = formProps({ suggested: [], lines: [added] })
  const lines = client.initialFormLines(addedProps, 'p2')
  const body = client.draftRequestBody([{ ...lines[0], quantity: '10' }], addedProps, { threadId: 'thr_7f2c', messageId: 'msg_19', partId: 'p2' })
  assert.deepEqual([body.lines[0].estimatedUnitPrice, body.lines[0].estimatedAmount, body.lines[0].currency], [0.42, 4.2, 'USD'])
})

test('the receipt has Submit as its one primary button, and submitting says when approvers get an email', async () => {
  const client = await loadClient()
  const draft = client.form({ props: formProps(), receipt: { id: 'PR-0231', version: 1, status: 'draft' } })
  assert.match(draft, /data-testid="ai-v2-pr-receipt" data-status="draft"/)
  assert.match(draft, /data-business-id="PR-0231"[^>]*>PR-0231<\/button><span>created \(draft\)<\/span>/)
  assert.equal(count(draft, /data-primary="true"/g), 1)
  assert.match(draft, /data-testid="ai-v2-pr-submit" data-primary="true"[^>]*>Submit for approval — approvers will be emailed</)
  assert.match(draft, /data-testid="ai-v2-pr-cancel"[^>]*>Cancel draft</)
  assert.doesNotMatch(draft, /data-testid="ai-v2-pr-create"/)
  const submitted = client.form({ props: formProps(), receipt: { id: 'PR-0231', version: 2, status: 'submitted' } })
  assert.equal(count(submitted, /data-primary="true"/g), 0)
  // The submit answer cannot tell whether an email went out (approval emails
  // may be off), so the note states the condition rather than claiming it.
  assert.match(submitted, /<p data-testid="ai-v2-pr-emailed"[^>]*>Approvers get an email when approval emails are turned on for this workspace\.</)
  assert.match(submitted, /data-testid="ai-v2-pr-withdraw"[^>]*>Withdraw</)
  assert.doesNotMatch(submitted, /Submit for approval/)
  assert.match(client.form({ props: formProps(), receipt: { id: 'PR-0231', version: 1, status: 'draft' }, language: 'zh-CN' }), /提交审批（将邮件通知审批人）/)
})

test('create posts the classic form body with one key per form and an assistant suggestion trail', async () => {
  const client = await loadClient()
  const props = formProps()
  const lines = client.initialFormLines(props, 'p2')
  const ticked = [{ ...lines[0], checked: true }]
  const body = client.draftRequestBody(ticked, props, { threadId: 'thr_7f2c', messageId: 'msg_19', partId: 'p2' })
  assert.equal(body.idempotencyKey, 'ai-form:thr_7f2c:msg_19:p2')
  // The same form sends the same payload again, so a second click creates nothing new.
  assert.deepEqual(client.draftRequestBody(ticked, props, { threadId: 'thr_7f2c', messageId: 'msg_19', partId: 'p2' }), body)
  assert.deepEqual(Object.keys(body.lines[0]).sort(), ['commodityId', 'currency', 'estimatedAmount', 'estimatedUnitPrice', 'internalLineComment', 'itemId', 'itemNameSnapshot', 'lineBasis', 'lineId', 'needByDate', 'quantity', 'serviceEndDate', 'serviceStartDate', 'sku', 'sourceType', 'specificationSnapshot', 'supplierId', 'supplierOverride', 'targetWarehouseId', 'unitSnapshot'])
  assert.deepEqual({ ...body.lines[0], lineId: undefined }, {
    lineId: undefined, sourceType: 'catalog_item', lineBasis: 'quantity', itemId: 'itm_42', sku: 'SKU-1007', supplierId: 'sup_3', itemNameSnapshot: 'Corrugated box 40x30', unitSnapshot: 'pcs',
    specificationSnapshot: '', commodityId: '', quantity: 600, estimatedUnitPrice: 0.42, estimatedAmount: 252, currency: 'USD', targetWarehouseId: 'WH-1', needByDate: '2026-11-20',
    serviceStartDate: '', serviceEndDate: '', internalLineComment: '', supplierOverride: null,
  })
  assert.deepEqual([body.departmentId, body.defaultCurrency, body.defaultNeedByDate], ['operations', 'USD', '2026-11-20'])
  const trail = sanitizeSuggestionTrail(body.suggestionTrail)
  assert.equal(trail.origin, 'ai_assistant')
  assert.deepEqual(trail.fields.find((field) => field.field === 'lines.0.quantity'), { field: 'lines.0.quantity', source: 'record', ref: 'toolu_01', outcome: 'accepted' })
  const edited = client.draftRequestBody([{ ...ticked[0], quantity: '650' }], props, { threadId: 'thr_7f2c', messageId: 'msg_19', partId: 'p2' })
  assert.equal(sanitizeSuggestionTrail(edited.suggestionTrail).fields.find((field) => field.field === 'lines.0.quantity').outcome, 'edited')
  assert.deepEqual(trail.fields.find((field) => field.field === 'lines.0.supplierId'), { field: 'lines.0.supplierId', source: 'default', ref: 'toolu_01', outcome: 'accepted' })
  // A supplier the user named is theirs, not a suggestion.
  const namedProps = formProps({ suggested: [], lines: [row({ checked: true, supplier: { id: 'sup_3', name: 'Acme Packaging', source: 'user_named' } })] })
  const namedBody = client.draftRequestBody(client.initialFormLines(namedProps, 'p2'), namedProps, { threadId: 'thr_7f2c', messageId: 'msg_19', partId: 'p2' })
  assert.equal(sanitizeSuggestionTrail(namedBody.suggestionTrail).fields.some((field) => field.field === 'lines.0.supplierId'), false)
})

test('the answer renders parts in order, chips text from the parts\' refs, and ignores unknown or malformed parts', async () => {
  const client = await loadClient()
  const parts = [
    { id: 'p1', type: 'text', text: 'SKU-1007 reaches its reorder point before Friday.' },
    ui('p2', 'pr_form', formProps(), [ref('item', 'itm_42', 'SKU-1007')]),
    ui('p3', 'mystery', { anything: true }),
    ui('p4', 'table', { columns: [] }),
    ui('p5', 'citations', { passages: [{ id: 'ps_1', title: 'Supplier manual', excerpt: 'Deliveries arrive on weekdays.' }] }),
    ui('p6', 'followups', { questions: ['Which of these already have an open request?'] }),
  ]
  const markup = client.answer({ parts })
  assert.deepEqual([...markup.matchAll(/data-part-id="(p\d)" data-component="([a-z_]+)"/g)].map((match) => `${match[1]}:${match[2]}`), ['p2:pr_form', 'p6:followups'])
  assert.match(markup, /<p><span><button[^>]*data-testid="ai-record-chip"[^>]*data-business-id="itm_42"[^>]*>SKU-1007<\/button><\/span> reaches its reorder point/)
  assert.doesNotMatch(markup, /Supplier manual|anything/)
  // Next questions only under the latest answer.
  assert.doesNotMatch(client.answer({ parts, latest: false }), /data-testid="ai-v2-followups"/)
})
