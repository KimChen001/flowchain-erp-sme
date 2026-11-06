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
    import { PurchaseRequestFormPart, addedFormRow, createFormRequest, draftRequestBody, initialFormLines, newSupplierLinkBody, newSupplierOption } from './src/modules/ai-assistant/v2/parts/PurchaseRequestFormPart.tsx'
    const navigate = () => {}
    export const text = (props) => renderToStaticMarkup(createElement(StreamingText, { onNavigate: navigate, ...props }))
    export const answer = (props) => renderToStaticMarkup(createElement(AnswerParts, { threadId: 'thr_7f2c', messageId: 'msg_19', onNavigate: navigate, onFollowUp: () => {}, onChoose: () => {}, ...props }))
    export const form = (props) => renderToStaticMarkup(createElement(PurchaseRequestFormPart, { partId: 'p2', threadId: 'thr_7f2c', messageId: 'msg_19', onNavigate: navigate, ...props }))
    import { SetupStepsPart } from './src/modules/ai-assistant/v2/parts/SetupStepsPart.tsx'
    import { SetupRecordsPart, createSetupRecords, initialSetupDrafts, itemBody, itemIssues, itemSupplierBody, setupCreatedRecords, supplierBody, supplierIssues } from './src/modules/ai-assistant/v2/parts/SetupRecordsPart.tsx'
    export const steps = (props) => renderToStaticMarkup(createElement(SetupStepsPart, { onNavigate: navigate, ...props }))
    export const setupCard = (props) => renderToStaticMarkup(createElement(SetupRecordsPart, { partId: 'p3', onNavigate: navigate, ...props }))
    export { addedFormRow, createFormRequest, draftRequestBody, initialFormLines, newSupplierLinkBody, newSupplierOption, createSetupRecords, initialSetupDrafts, itemBody, itemIssues, itemSupplierBody, setupCreatedRecords, supplierBody, supplierIssues }
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
  assert.deepEqual([...UI_COMPONENTS], ['table', 'records', 'chart', 'kpis', 'choices', 'pr_form', 'followups', 'citations', 'setup_steps', 'setup_form'])
  const envelope = { v: 2, seq: 3 }
  for (const event of [
    { ...envelope, type: 'flag', partId: 'p1', spans: [{ text: '600', kind: 'number', reason: 'not_in_tool_results' }] },
    // The records the text names, as the server found them in this answer's results.
    { ...envelope, type: 'flag', partId: 'p1', spans: [], refs: [{ type: 'purchase_order', id: 'PO-020', label: 'PO-020' }] },
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
    { v: 2, seq: 1, type: 'flag', partId: 'p1', spans: [], refs: [{ type: 'purchase_order', id: 'PO-020' }] },
    { v: 2, seq: 1, type: 'flag', partId: 'p1', spans: [], refs: 'PO-020' },
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
  for (const text of ['Days overdue', 'Promised', 'Remaining', '1,234', '$1,500.00', 'Oct 28, 2026', 'Show all 12', '3 days overdue', 'Waiting 1 day', 'Pending approval', 'Not available for your role', 'View in Reports', 'Which item do you mean?', 'Tick a line to create a request']) assert.ok(markup.includes(text), text)
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
  for (const label of ['逾期天数', '承诺交期', '供应商', '逾期 3 天', '已等待 1 天', '待审批', '你的角色无权查看', '在报表中心查看', '你指的是哪个物料？', '采购申请', '建议补货的物料', '全部加入', '仍要采购', '查看全部 12 条', '勾选物料后创建申请']) assert.ok(markup.includes(label), label)
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

// A longer answer may split into parts under short headings (2026-11-04).
test('a heading line is a section title, not a plain line with its hashes', async () => {
  const client = await loadClient()
  const markup = client.text({ text: '## Order now\n- LDM-002: 1,735\n\n### 下一步\nCheck the form.' })
  assert.match(markup, /<p data-testid="ai-v2-text-heading" class="pt-1 font-semibold">Order now<\/p>/)
  assert.match(markup, /<p data-testid="ai-v2-text-heading" class="pt-1 font-semibold">下一步<\/p>/)
  assert.match(markup, /<li>LDM-002: 1,735<\/li>/)
  assert.doesNotMatch(markup, />#+ /)
})

// A typed table shows as a table, not a run of pipes (2026-11-04).
test('a pipe table in the text is a table with its first row as the header', async () => {
  const client = await loadClient()
  const markup = client.text({ text: 'The plan:\n\n| SKU | Order |\n|---|---:|\n| LDM-002 | **1,677** |\n| LDM-006 | 1,114 |\n\nCheck it.' })
  assert.match(markup, /<table data-testid="ai-v2-text-table"/)
  assert.match(markup, /<th[^>]*>SKU<\/th><th[^>]*>Order<\/th>/)
  assert.match(markup, /<td[^>]*>LDM-002<\/td><td[^>]*><strong class="font-semibold">1,677<\/strong><\/td>/)
  assert.doesNotMatch(markup, /\||---/)
  assert.match(markup, /<p>Check it\.<\/p>/)
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
  // One primary button; with nothing ticked it is off and says what to do
  // first (2026-11-05). No Submit before the request exists.
  assert.equal(count(markup, /data-primary="true"/g), 1)
  assert.match(markup, /data-testid="ai-v2-pr-create" data-primary="true" disabled=""[^>]*>Tick a line to create a request</)
  // The quantity label keeps the unit in full-width parentheses in Chinese,
  // worded for the form's language (2026-11-05: "数量（pcs）"); the stored
  // code is what the request records.
  const ticked = (language, unit = 'pcs') => client.form({ props: formProps({ suggested: [], lines: [row({ item: { ...item('itm_42', 'SKU-1007', 'Corrugated box 40x30'), unit }, checked: true, suggestedQuantity: { value: 5, source: 'user_named' } })] }), language })
  assert.match(ticked('en-US'), />Quantity \(pcs\)</)
  assert.match(ticked('zh-CN'), />数量（件）</)
  assert.match(ticked('en-US', 'box'), />Quantity \(boxes\)</)
  assert.match(ticked('zh-CN', 'box'), />数量（箱）</)
  assert.match(ticked('zh-CN', 'drum'), />数量（drum）</)
  assert.match(client.form({ props: formProps(), language: 'zh-CN' }), /建议 600 件/)
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
  assert.match(draft, /data-testid="ai-v2-pr-submit" data-primary="true"[^>]*>Submit for approval</)
  assert.match(draft, /data-testid="ai-v2-pr-cancel"[^>]*>Cancel draft</)
  assert.doesNotMatch(draft, /data-testid="ai-v2-pr-create"/)
  const submitted = client.form({ props: formProps(), receipt: { id: 'PR-0231', version: 2, status: 'submitted' } })
  assert.equal(count(submitted, /data-primary="true"/g), 0)
  // The submit answer cannot tell whether an email went out (approval emails
  // may be off), so the note states the condition rather than claiming it.
  assert.match(submitted, /<p data-testid="ai-v2-pr-emailed"[^>]*>Approvers get an email when approval emails are turned on for this workspace\.</)
  assert.match(submitted, /data-testid="ai-v2-pr-withdraw"[^>]*>Withdraw</)
  assert.doesNotMatch(submitted, /Submit for approval/)
  assert.match(client.form({ props: formProps(), receipt: { id: 'PR-0231', version: 1, status: 'draft' }, language: 'zh-CN' }), />提交审批</)
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

// "Order 200 of SKU-1007 from Northstar Electronics": a supplier of the
// workspace the item has not approved yet, which Create adds (2026-11-04).
const ACME = { id: 'sup_3', name: 'Acme Packaging', preferred: true, leadTimeDays: 14, unitPrice: 0.42, currency: 'USD' }
const NORTHSTAR = { id: 'sup_9', name: 'Northstar Electronics', preferred: false, leadTimeDays: null, unitPrice: null, currency: 'USD', link: 'new' }
const newSupplierProps = (over = {}, rowOver = {}) => formProps({
  suggested: [],
  lines: [row({
    checked: true, suggestedQuantity: { value: 200, source: 'user_named' },
    supplier: { id: 'sup_9', name: 'Northstar Electronics', source: 'user_named', link: 'new' }, suppliers: [ACME, NORTHSTAR],
    needByDate: { value: '2026-11-04', source: 'today', leadTimeDays: null, shortWeekOf: null }, estimatedUnitPrice: { value: null, currency: null, source: 'missing' },
    ...rowOver,
  })],
  canLinkSuppliers: true, workspaceCurrency: 'USD',
  ...over,
})
const IDS = { threadId: 'thr_7f2c', messageId: 'msg_19', partId: 'p2' }

test('a supplier the item has not approved says Create adds it, and asks for its price and why not the preferred one', async () => {
  const client = await loadClient()
  const props = newSupplierProps()
  assert.ok(safeParsePartProps('pr_form', props).success)
  // The marker is only "new".
  assert.equal(safeParsePartProps('pr_form', newSupplierProps({}, { supplier: { id: 'sup_9', name: 'Northstar Electronics', source: 'user_named', link: 'approved' } })).success, false)
  const markup = client.form({ props })
  assert.doesNotMatch(markup, CJK)
  assert.match(markup, /data-testid="ai-v2-pr-new-supplier" data-linked="false"[^>]*>.*Northstar Electronics isn&#x27;t an approved supplier for SKU-1007 yet\. Create adds it\.</)
  assert.match(markup, /<option value="sup_9" selected="">Northstar Electronics \(not yet approved\)<\/option>/)
  assert.match(markup, /<option value="__other_supplier__">Another supplier…<\/option>/)
  // Its price, currency and lead time are the user's to give; the currency starts as the workspace's.
  assert.match(markup, /data-testid="ai-v2-pr-new-terms"/)
  assert.match(markup, /Currency<\/span><input type="text" maxLength="3"[^>]*value="USD"/)
  assert.doesNotMatch(markup, /data-testid="ai-v2-pr-price-unavailable"/)
  // SKU-1007 prefers Acme Packaging, so the reason is asked here: the full form cannot pick Northstar.
  assert.match(markup, /data-testid="ai-v2-pr-reason"[^]*Why not the preferred supplier \(Acme Packaging\)\?/)
  assert.match(markup, /data-testid="ai-v2-pr-create" data-primary="true" disabled=""/)
  assert.match(markup, /data-testid="ai-v2-pr-blocked"[^]*For each new supplier, enter a unit price and a 3-letter currency code/)
  const chinese = client.form({ props, language: 'zh-CN' })
  for (const text of ['Northstar Electronics 还不是 SKU-1007 的批准供应商。点击创建时会将其添加为批准供应商。', 'Northstar Electronics（尚未批准）', '其他供应商…', '为什么不选首选供应商（Acme Packaging）？', '币种']) assert.ok(chinese.includes(text), text)
  // A role that may not add approved suppliers is not offered another one.
  assert.doesNotMatch(client.form({ props: formProps({ suggested: [], lines: [row({ checked: true })] }) }), /Another supplier/)
  // Given in the chat, the price fills in; an item with no preferred supplier needs no reason.
  const priced = client.form({ props: newSupplierProps({}, { suppliers: [{ ...ACME, preferred: false }, { ...NORTHSTAR, unitPrice: 4.2, leadTimeDays: 9 }] }) })
  assert.match(priced, /type="number"[^>]*value="4\.2"/)
  assert.doesNotMatch(priced, /data-testid="ai-v2-pr-reason"/)
  assert.doesNotMatch(priced, /data-testid="ai-v2-pr-create" data-primary="true" disabled=""/)
})

test('Create adds the new supplier to the item first, then creates the request with its price and reason', async () => {
  const client = await loadClient()
  const props = newSupplierProps()
  const [first] = client.initialFormLines(props, 'p2')
  const ticked = [{ ...first, terms: { price: '4.2', currency: 'usd', leadTime: '9' }, override: { reasonCode: 'lead_time', note: '' } }]
  const posts = []
  const post = async (url, body) => {
    posts.push([url, body])
    return url === '/api/procurement/requests' ? { id: 'PR-0300', version: 1, status: 'draft' } : { relationship: { relationshipId: 'ISR-1' } }
  }
  const outcome = await client.createFormRequest({ ticked, props, ids: IDS, post })
  assert.deepEqual(posts.map(([url]) => url), ['/api/master-data/items/itm_42/suppliers', '/api/procurement/requests'])
  // Approved, not preferred, with what the user gave, as the setup card links an item.
  assert.deepEqual(posts[0][1], { supplierId: 'sup_9', preferred: false, approved: true, active: true, leadTimeDays: 9, referencePrice: 4.2, currency: 'USD' })
  assert.deepEqual(client.newSupplierLinkBody(ticked[0]), posts[0][1])
  // The request as the form always posts it, with the supplier, its price and the reason.
  const body = posts[1][1]
  assert.deepEqual(body, client.draftRequestBody(ticked, props, IDS))
  assert.deepEqual([body.lines[0].supplierId, body.lines[0].quantity, body.lines[0].estimatedUnitPrice, body.lines[0].estimatedAmount, body.lines[0].currency], ['sup_9', 200, 4.2, 840, 'USD'])
  assert.deepEqual(body.lines[0].supplierOverride, { reasonCode: 'lead_time', note: null })
  assert.equal(body.idempotencyKey, 'ai-form:thr_7f2c:msg_19:p2')
  // A supplier the user named is theirs, not a suggestion; the trail keeps what was suggested.
  const trail = sanitizeSuggestionTrail(body.suggestionTrail)
  assert.equal(trail.fields.some((field) => field.field === 'lines.0.supplierId' || field.field === 'lines.0.estimatedUnitPrice'), false)
  assert.deepEqual(trail.fields.find((field) => field.field === 'lines.0.needByDate'), { field: 'lines.0.needByDate', source: 'default', ref: 'toolu_01', outcome: 'accepted' })
  assert.deepEqual(outcome, { status: 'created', linked: { [first.key]: 'sup_9' }, created: { id: 'PR-0300', version: 1, status: 'draft' } })
  // A retry after a failed request does not add the supplier again.
  posts.length = 0
  await client.createFormRequest({ ticked, props, ids: IDS, post, linked: outcome.linked })
  assert.deepEqual(posts.map(([url]) => url), ['/api/procurement/requests'])
  // A link already there is fine: the request goes on.
  posts.length = 0
  const conflict = await client.createFormRequest({ ticked, props, ids: IDS, post: async (url, body) => { if (url !== '/api/procurement/requests') { posts.push([url]); throw Object.assign(new Error('linked'), { status: 409, code: 'RELATIONSHIP_EXISTS' }) } return post(url, body) } })
  assert.equal(conflict.status, 'created')
  assert.deepEqual(posts.map(([url]) => url), ['/api/master-data/items/itm_42/suppliers', '/api/procurement/requests'])
  // An approved supplier creates the request alone, as before.
  posts.length = 0
  const plainProps = formProps({ suggested: [], lines: [row({ checked: true })] })
  await client.createFormRequest({ ticked: client.initialFormLines(plainProps, 'p2'), props: plainProps, ids: IDS, post })
  assert.deepEqual(posts.map(([url]) => url), ['/api/procurement/requests'])
  assert.equal(posts[0][1].lines[0].supplierOverride, null)
})

test('a supplier picked from "Another supplier…" is added the same way, and a failed link stops the create', async () => {
  const client = await loadClient()
  const props = formProps({ suggested: [], lines: [row({ checked: true, suggestedQuantity: { value: 50, source: 'user_named' }, suppliers: [ACME] })], canLinkSuppliers: true, workspaceCurrency: 'USD' })
  // From the Suppliers list: its own currency, else the workspace's.
  const option = client.newSupplierOption({ id: 'sup_9', supplierName: 'Northstar Electronics', status: 'active', defaultCurrency: null }, 'USD')
  assert.deepEqual(option, NORTHSTAR)
  assert.equal(client.newSupplierOption({ id: 'sup_8', name: 'Rhine Parts', defaultCurrency: 'eur' }, 'USD').currency, 'EUR')
  const [first] = client.initialFormLines(props, 'p2')
  const line = { ...first, added: [option], supplierId: 'sup_9', terms: { price: '3', currency: 'USD', leadTime: '' }, override: { reasonCode: 'other', note: 'Acme is out of stock' } }
  const posts = []
  const failing = async (url, body) => {
    posts.push([url, body])
    if (url !== '/api/procurement/requests') throw Object.assign(new Error('denied'), { status: 403, code: 'PERMISSION_DENIED' })
    return { id: 'PR-0301', version: 1, status: 'draft' }
  }
  const failed = await client.createFormRequest({ ticked: [line], props, ids: IDS, post: failing })
  // Nothing is created without the link, and the line it failed on is named.
  assert.deepEqual(posts.map(([url]) => url), ['/api/master-data/items/itm_42/suppliers'])
  assert.deepEqual(posts[0][1], { supplierId: 'sup_9', preferred: false, approved: true, active: true, leadTimeDays: null, referencePrice: 3, currency: 'USD' })
  assert.deepEqual([failed.status, failed.key, failed.linked, failed.failure.code], ['link_failed', first.key, {}, 'PERMISSION_DENIED'])
  // With the link made, the request carries the supplier the user changed to, with the reason.
  posts.length = 0
  const done = await client.createFormRequest({ ticked: [line], props, ids: IDS, post: async (url, body) => { posts.push([url, body]); return url === '/api/procurement/requests' ? { id: 'PR-0301', version: 1, status: 'draft' } : {} } })
  assert.equal(done.status, 'created')
  const body = posts[1][1]
  assert.deepEqual([body.lines[0].supplierId, body.lines[0].estimatedUnitPrice, body.lines[0].supplierOverride], ['sup_9', 3, { reasonCode: 'other', note: 'Acme is out of stock' }])
  // The suggested supplier was changed: the trail says so, as for any other supplier.
  assert.equal(sanitizeSuggestionTrail(body.suggestionTrail).fields.find((field) => field.field === 'lines.0.supplierId').outcome, 'edited')
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

test('a text part chips the records the server found it names, and the follow-up chips render last, once', async () => {
  const client = await loadClient()
  const chips = (id, question) => ui(id, 'followups', { questions: [question] })
  const markup = client.answer({ parts: [
    { id: 'p1', type: 'text', text: 'PO-020 and PO-021 are overdue; PO-999 is not in your records.', refs: [ref('purchase_order', 'PO-020'), ref('purchase_order', 'PO-021')] },
    chips('p2', 'Which supplier is it?'),
    { id: 'p3', type: 'text', text: 'PO-021 is the older one.' },
    chips('p4', 'Show PO-020'),
  ] })
  assert.equal(count(markup, /data-business-id="PO-020"/g), 1)
  // One chip per record and text part: PO-021 again in the later part.
  assert.equal(count(markup, /data-business-id="PO-021"/g), 2)
  assert.doesNotMatch(markup, /data-business-id="PO-999"/)
  assert.equal(count(markup, /data-testid="ai-v2-followups"/g), 1)
  assert.doesNotMatch(markup, /Which supplier is it\?/)
  assert.ok(markup.lastIndexOf('PO-021 is the older one.') < markup.indexOf('data-testid="ai-v2-followups"'), 'the chips come after the text')
})

// The setup checklist and card, as the server builds them for a workspace
// with items and suppliers but no customers yet.
const stepsProps = {
  source: 'toolu_setup',
  steps: [
    { id: 'items', done: true, count: 3 }, { id: 'suppliers', done: true, count: 2 },
    { id: 'customers', done: false, count: 0, route: { moduleId: 'master-data:import', query: { type: 'customers' } } },
    { id: 'opening_stock', done: false, count: 0, blocked: 'unavailable' }, { id: 'teammates', done: false, count: 0, blocked: 'permission' },
  ],
  done: 2, total: 5,
  gaps: { checked: 3, unit: 1, preferredSupplier: 1, thresholds: 0 },
}
const typed = (value) => ({ value, source: 'user_typed' })
const none = { value: null, source: 'not_given' }
const supplierRow = (key, name, over = {}) => ({ key, name: typed(name), code: { value: null, source: 'generated' }, contact: none, email: none, phone: none, paymentTerms: { value: null, label: null, typed: null, source: 'not_given' }, problems: [], ...over })
const itemRow = (key, sku, name, over = {}) => ({
  key, sku: typed(sku), name: typed(name), unit: typed('box'), category: none, safetyStock: none, reorderPoint: none, referencePrice: none, leadTimeDays: none,
  currency: { value: null, source: 'not_given' }, preferredSupplier: { supplierId: null, rowKey: null, name: null, typed: null, source: 'not_given' }, problems: [], ...over,
})
const setupProps = (over = {}) => ({
  formId: 'thr_7f2c:msg_19:p3',
  suppliers: [
    supplierRow('s1', 'Northwind Metals', { email: typed('sales@northwind.example'), paymentTerms: { value: 'NET30', label: 'Net 30', typed: 'Net 30', source: 'user_typed' } }),
    supplierRow('s2', 'Acme Components', { problems: [{ field: 'name', code: 'duplicate_existing', blocking: true, ref: ref('supplier', 'SUP-001', 'Acme Components') }] }),
  ],
  items: [
    itemRow('i1', 'BOLT-M8', 'Hex bolt M8', { reorderPoint: typed(40), referencePrice: typed(12.5), leadTimeDays: typed(7), currency: typed('USD'), preferredSupplier: { supplierId: null, rowKey: 's1', name: 'Northwind Metals', typed: 'Northwind Metals', source: 'user_typed' } }),
    itemRow('i2', 'LDM-001', 'Flow Controller', { unit: none, problems: [{ field: 'sku', code: 'duplicate_existing', blocking: true, ref: ref('item', 'ITEM-001', 'LDM-001') }, { field: 'unit', code: 'required', blocking: true }] }),
    itemRow('i3', 'NUT-M8', 'Hex nut M8', { currency: { value: 'USD', source: 'default' }, preferredSupplier: { supplierId: 'SUP-001', rowKey: null, name: 'Acme Components', typed: 'Acme Components', source: 'user_typed' } }),
  ],
  codeSeed: { prefix: 'SUP-', next: 3, width: 3 },
  paymentTerms: [{ code: 'DUE', label: 'Due on receipt' }, { code: 'NET30', label: 'Net 30' }],
  supplierOptions: [{ id: 'SUP-001', name: 'Acme Components', currency: null }, { id: 'SUP-002', name: 'Summit Packaging', currency: 'EUR' }],
  workspaceCurrency: 'USD',
  canCreateSuppliers: true,
  canCreateItems: true,
  ...over,
})

test('the setup parts pass the protocol, and malformed setup props are refused', () => {
  assert.ok(safeParsePartProps('setup_steps', stepsProps).success)
  assert.ok(safeParsePartProps('setup_form', setupProps()).success)
  const bad = [
    ['setup_steps', { ...stepsProps, steps: [{ id: 'payroll', done: false, count: 0 }] }],
    ['setup_steps', { ...stepsProps, steps: [{ ...stepsProps.steps[2], route: { moduleId: 'https://example.com' } }] }],
    ['setup_form', setupProps({ suppliers: [], items: [] })],
    ['setup_form', setupProps({ suppliers: Array.from({ length: 13 }, (_, index) => supplierRow(`s${index + 1}`, 'A')), items: Array.from({ length: 13 }, (_, index) => itemRow(`i${index + 1}`, 'B', 'B')) })],
    ['setup_form', setupProps({ items: [itemRow('i1', 'X', 'Y', { preferredSupplier: { supplierId: 'SUP-001', rowKey: 's1', name: 'Z', typed: null, source: 'user_typed' } })] })],
    ['setup_form', setupProps({ codeSeed: { prefix: 'SUP-1', next: 3, width: 3 } })],
    ['setup_form', setupProps({ suppliers: [supplierRow('s1', 'A', { problems: [{ field: 'name', code: 'made_up', blocking: true }] })] })],
  ]
  for (const [component, props] of bad) assert.equal(safeParsePartProps(component, props).success, false, JSON.stringify(props).slice(0, 120))
})

test('the setup checklist lists every step in order, links an open step the user may do, and says what blocks the rest', async () => {
  const client = await loadClient()
  const markup = client.steps({ props: stepsProps })
  assert.doesNotMatch(markup, CJK)
  for (const text of ['Set up your workspace', '2 of 5 steps done', '1. Import items', 'Done (3)', '3. Import customers', 'Not started', 'Not turned on in this workspace', 'Ask an administrator', 'Of 3 items, 1 have no unit']) assert.ok(markup.includes(text), text)
  assert.equal(count(markup, /data-testid="ai-v2-setup-open"/g), 1)
  assert.match(markup, /data-testid="ai-v2-setup-open" data-route="master-data:import"[^>]*>Open import page</)
  assert.deepEqual([...markup.matchAll(/data-step="(\w+)" data-done="(\w+)"/g)].map((match) => `${match[1]}:${match[2]}`), ['items:true', 'suppliers:true', 'customers:false', 'opening_stock:false', 'teammates:false'])
  const chinese = client.steps({ props: stepsProps, language: 'zh-CN' })
  for (const text of ['设置工作区', '已完成 2/5 步', '导入客户', '打开导入页面', '请联系管理员']) assert.ok(chinese.includes(text), text)
})

test('the setup card shows every row editable, where each value came from and what blocks Create', async () => {
  const client = await loadClient()
  const markup = client.setupCard({ props: setupProps() })
  assert.doesNotMatch(markup, CJK)
  for (const text of ['New suppliers and items', 'Nothing is saved until you click Create', 'Suppliers', 'Items', 'Next free code', 'Already exists:', 'Required', 'Northwind Metals (in this card)', 'Default: USD', 'Not recorded']) assert.ok(markup.includes(text), text)
  // A supplier without a code gets the next free one; the user's values are kept as typed.
  assert.match(markup, /value="SUP-003"/)
  assert.match(markup, /value="sales@northwind.example"/)
  assert.match(markup, /data-business-id="SUP-001"/)
  assert.equal(count(markup, /data-testid="ai-v2-setup-row"/g), 5)
  // Rows with blocking problems turn Create off and say why; it is the only primary button.
  assert.match(markup, /data-testid="ai-v2-setup-blocked"/)
  assert.match(markup, /data-testid="ai-v2-setup-create" data-primary="true" disabled=""[^>]*>Create 5 records</)
  assert.equal(count(markup, /data-primary="true"/g), 1)
  const chinese = client.setupCard({ props: setupProps(), language: 'zh-CN' })
  for (const text of ['新增供应商和物料', '下一个可用编号', '已存在：', '必填', '创建 5 条记录']) assert.ok(chinese.includes(text), text)
  // A role that may not add suppliers sees them unticked, with why.
  const itemsOnly = client.setupCard({ props: setupProps({ canCreateSuppliers: false }) })
  assert.match(itemsOnly, /Your role cannot add suppliers\./)
  assert.equal(count(itemsOnly, /data-type="supplier" data-included="false"/g), 2)
})

test('the card checks rows again as the user edits them: unticking or fixing a row clears what blocked it', async () => {
  const client = await loadClient()
  const props = setupProps()
  const drafts = client.initialSetupDrafts(props)
  assert.deepEqual(drafts.suppliers.map((draft) => draft.code), ['SUP-003', 'SUP-004'])
  assert.deepEqual(drafts.items.map((draft) => draft.supplier), ['row:s1', 'none', 'id:SUP-001'])
  const supplierCodes = (draft) => client.supplierIssues(draft, props.suppliers.find((row) => row.key === draft.key), drafts.suppliers).map((issue) => issue.code)
  assert.deepEqual(supplierCodes(drafts.suppliers[1]), ['duplicate_existing'])
  assert.deepEqual(supplierCodes({ ...drafts.suppliers[1], name: 'Acme Components Ltd' }), [])
  assert.deepEqual(supplierCodes({ ...drafts.suppliers[0], email: 'not an email' }), ['email_invalid'])
  const itemCodes = (draft, items = drafts.items, suppliers = drafts.suppliers) => client.itemIssues(draft, props.items.find((row) => row.key === draft.key), items, suppliers).map((issue) => `${issue.field}:${issue.code}`)
  assert.deepEqual(itemCodes(drafts.items[1]), ['sku:duplicate_existing', 'unit:required'])
  assert.deepEqual(itemCodes({ ...drafts.items[1], sku: 'LDM-100', unit: 'pcs' }), [])
  assert.deepEqual(itemCodes({ ...drafts.items[0], reorderPoint: '-1', leadTimeDays: '1.5' }), ['reorder_point:negative', 'lead_time_days:whole_number'])
  assert.deepEqual(itemCodes({ ...drafts.items[0], supplier: 'none' }), ['reference_price:needs_supplier'])
  // An item whose card supplier is unticked cannot be linked to it.
  assert.deepEqual(itemCodes(drafts.items[0], drafts.items, drafts.suppliers.map((draft) => (draft.key === 's1' ? { ...draft, include: false } : draft))), ['preferred_supplier:supplier_excluded'])
  // The bodies are the ones the Suppliers and Items pages post.
  assert.deepEqual(client.supplierBody(drafts.suppliers[0]), { supplierCode: 'SUP-003', supplierName: 'Northwind Metals', status: 'active', contactName: '', telephone: '', email: 'sales@northwind.example', paymentTermsId: 'NET30' })
  assert.deepEqual(client.itemBody(drafts.items[0]), { sku: 'BOLT-M8', itemName: 'Hex bolt M8', baseUnit: 'box', purchaseUnit: 'box', category: '', itemType: 'material', status: 'active', purchasable: true, inventoryItem: true, reorderPoint: 40 })
  assert.deepEqual(client.itemSupplierBody(drafts.items[2], 'SUP-001', 'USD'), { supplierId: 'SUP-001', preferred: true, approved: true, active: true, leadTimeDays: null, referencePrice: null, currency: 'USD' })
})

test('Create makes the suppliers first, then each item with its supplier link; a failed row keeps its error and a retry does only what is left', async () => {
  const client = await loadClient()
  const props = setupProps()
  const drafts = client.initialSetupDrafts(props)
  // The rows with problems are unticked.
  drafts.suppliers[1].include = false
  drafts.items[1].include = false
  const posts = []
  let failNut = true
  const post = async (url, body) => {
    posts.push([url, body])
    if (url === '/api/master-data/suppliers') return { supplier: { id: 'SUP-NEW', supplierName: body.supplierName } }
    if (url === '/api/master-data/items') {
      if (body.sku === 'NUT-M8' && failNut) throw new Error('DUPLICATE_SKU')
      return { item: { itemId: `ITEM-${body.sku}`, sku: body.sku } }
    }
    return { relationship: { relationshipId: 'ISR-1' } }
  }
  const run = (results) => client.createSetupRecords({ drafts, results, props, post, errorText: (failure) => `failed: ${failure.message}`, supplierNotCreated: 'supplier not created' })
  const first = await run({})
  assert.deepEqual(posts.map(([url]) => url), ['/api/master-data/suppliers', '/api/master-data/items', '/api/master-data/items/ITEM-BOLT-M8/suppliers', '/api/master-data/items'])
  assert.deepEqual(posts[2][1], { supplierId: 'SUP-NEW', preferred: true, approved: true, active: true, leadTimeDays: 7, referencePrice: 12.5, currency: 'USD' })
  assert.deepEqual(first.s1, { status: 'created', type: 'supplier', id: 'SUP-NEW', label: 'Northwind Metals' })
  assert.deepEqual(first.i1, { status: 'created', type: 'item', id: 'ITEM-BOLT-M8', label: 'BOLT-M8', linked: true, linkError: undefined })
  assert.deepEqual(first.i3, { status: 'failed', error: 'failed: DUPLICATE_SKU' })
  assert.equal(first.s2, undefined)
  assert.deepEqual(client.setupCreatedRecords({ results: first }), [{ type: 'supplier', id: 'SUP-NEW' }, { type: 'item', id: 'ITEM-BOLT-M8' }])
  // The retry creates only the failed item and its link to the existing supplier, in its currency.
  failNut = false
  posts.length = 0
  const second = await run(first)
  assert.deepEqual(posts.map(([url]) => url), ['/api/master-data/items', '/api/master-data/items/ITEM-NUT-M8/suppliers'])
  assert.deepEqual(posts[1][1], { supplierId: 'SUP-001', preferred: true, approved: true, active: true, leadTimeDays: null, referencePrice: null, currency: 'USD' })
  assert.equal(second.i3.status, 'created')
  // An item whose supplier in the card failed is not created.
  posts.length = 0
  const broken = await client.createSetupRecords({ drafts, results: {}, props, post: async (url, body) => { posts.push(url); if (url === '/api/master-data/suppliers') throw new Error('VALIDATION_ERROR'); return post(url, body) }, errorText: (failure) => failure.message, supplierNotCreated: 'supplier not created' })
  assert.deepEqual([broken.s1.status, broken.i1], ['failed', { status: 'failed', error: 'supplier not created' }])
  assert.ok(!posts.includes('/api/master-data/items/ITEM-BOLT-M8/suppliers'))
  // The receipt shows each created row as its record chip, and a failed row its error.
  const markup = client.setupCard({ props, receipt: { results: { ...first, i3: { status: 'failed', error: 'This SKU is already in use.' } } } })
  assert.match(markup, /data-testid="ai-v2-setup-row-created"[^]*data-business-id="SUP-NEW"/)
  assert.match(markup, /data-business-id="ITEM-BOLT-M8"[^>]*>BOLT-M8</)
  assert.match(markup, /data-testid="ai-v2-setup-row-error"[^>]*>This SKU is already in use\.</)
  assert.match(markup, /data-testid="ai-v2-setup-create"[^>]*>Try again \(\d+\)</)
})

test('the answer renders the setup parts in place', async () => {
  const client = await loadClient()
  const markup = client.answer({ parts: [ui('p1', 'setup_steps', stepsProps), ui('p2', 'setup_form', setupProps(), [ref('supplier', 'SUP-001', 'Acme Components')])], language: 'en-US' })
  assert.deepEqual([...markup.matchAll(/data-part-id="(p\d)" data-component="([a-z_]+)"/g)].map((match) => `${match[1]}:${match[2]}`), ['p1:setup_steps', 'p2:setup_form'])
  assert.doesNotMatch(markup, CJK)
})

// A live run on 2026-11-05: fifteen order cards came before the answer's
// sentence, "0 days" overdue on orders not late, "1 days", the unit in a
// column of its own, signal types as codes, and "which record?" three times.
test('the answer\'s first text goes above the first table, chart or form', async () => {
  const client = await loadClient()
  const parts = [
    ui('p1', 'table', tableProps, [ref('purchase_order', 'PO-020')]),
    { id: 'p2', type: 'text', text: 'Two orders are overdue.' },
    ui('p3', 'followups', { questions: ['Which supplier is most late?'] }),
    { id: 'p4', type: 'text', text: 'PO-020 is the older one.' },
  ]
  const markup = client.answer({ parts })
  const order = ['Two orders are overdue.', 'data-testid="ai-v2-table"', 'is the older one.', 'data-testid="ai-v2-followups"'].map((marker) => markup.indexOf(marker))
  assert.ok(order.every((at, index) => at >= 0 && (!index || at > order[index - 1])), String(order))
})

test('in a narrow panel a table shows five rows until "Show all"; cells read as the cards do', async () => {
  const client = await loadClient()
  const rows = Array.from({ length: 8 }, (_, index) => ({ order: ref('purchase_order', `PO-0${20 + index}`), days_overdue: index < 2 ? index : 0, remaining_quantity: 7000, unit: 'pcs', type: { code: 'po_overdue', tone: 'neutral' }, priority: { code: 'high', tone: 'warning' } }))
  const props = { columns: [{ code: 'order', kind: 'ref' }, { code: 'days_overdue', kind: 'days' }, { code: 'remaining_quantity', kind: 'quantity' }, { code: 'type', kind: 'status' }, { code: 'priority', kind: 'status' }], rows, total: 8, more: false }
  const markup = client.answer({ parts: [ui('p1', 'table', props)] })
  assert.equal(count(markup, /data-testid="ai-v2-table-card"/g), 5)
  assert.equal(count(markup, /data-testid="ai-v2-table-row"/g), 8)
  assert.match(markup, /data-testid="ai-v2-table-expand"[^>]*>Show 3 more</)
  // A quantity carries its unit; one day is "1 day"; not late is a dash.
  assert.ok(markup.includes('7,000 pcs'))
  assert.ok(markup.includes('>1 day<'))
  assert.doesNotMatch(markup, /0 days|1 days/)
  // Types and priorities in words, never as codes.
  assert.match(markup, /data-tone="neutral"[^>]*>Overdue purchase order</)
  assert.match(markup, /data-tone="warning"[^>]*>High</)
  assert.doesNotMatch(markup, />po_overdue<|>high</)
  const zh = client.answer({ parts: [ui('p1', 'table', props)], language: 'zh-CN' })
  for (const label of ['逾期采购订单', '>高<', '1 天', '再显示 3 条']) assert.ok(zh.includes(label), label)
  // Five rows or fewer need no button.
  assert.doesNotMatch(client.answer({ parts: [ui('p1', 'table', { ...props, rows: rows.slice(0, 5), total: 5 })] }), /ai-v2-table-expand/)
})

test('with buttons to pick from, the text does not ask the question again', async () => {
  const client = await loadClient()
  const parts = [
    { id: 'p1', type: 'text', text: 'Which order do you mean? Eight orders are overdue; PO-020 is the most overdue.\n- Which one?\nTell me the number if it is not listed.' },
    ui('p2', 'choices', { promptCode: 'pick_record', options: [ref('purchase_order', 'PO-020'), ref('purchase_order', 'PO-021')] }),
  ]
  const markup = client.answer({ parts })
  assert.doesNotMatch(markup, /Which order do you mean\?|Which one\?/)
  assert.match(markup, /Eight orders are overdue/)
  assert.match(markup, /Tell me the number if it is not listed\./)
  assert.equal(count(markup, /Which record do you mean\?/g), 1)
  // Without buttons the question stays.
  assert.match(client.answer({ parts: [parts[0]] }), /Which order do you mean\?/)
  assert.equal(client.answer({ parts: [{ id: 'p1', type: 'text', text: '你说的是哪一个？目前有 8 张逾期。' }, parts[1]], language: 'zh-CN' }).includes('哪一个？'), false)
})

test('a sentence left out for reading as an action is noted under the text, apart from the prose', async () => {
  const client = await loadClient()
  const trimmed = client.answer({ parts: [{ id: 'p1', type: 'text', text: 'PO-001 is 4 days overdue.', replaced: 'unbacked_action_claim' }] })
  assert.match(trimmed, /<p>PO-001 is 4 days overdue\.<\/p>/)
  assert.match(trimmed, /data-testid="ai-v2-claim-note"[^>]*>A sentence was left out because it read as if something had been done for you\./)
  const whole = client.answer({ parts: [{ id: 'p1', type: 'text', text: '', replaced: 'unbacked_action_claim' }], language: 'zh-CN' })
  assert.match(whole, /data-testid="ai-v2-claim-note"[^>]*>这部分回答读起来像是已替你执行了操作/)
  assert.doesNotMatch(whole, /data-testid="ai-v2-text"/)
  assert.doesNotMatch(client.answer({ parts: [{ id: 'p1', type: 'text', text: 'Fine.' }] }), /ai-v2-claim-note/)
})

// A live re-check on 2026-11-05: a Chinese answer said its first sentence
// again after the table, "Show all 10" of 18, and "pick one" with the buttons.
test('a later text part leaves out the sentences an earlier one said', async () => {
  const client = await loadClient()
  const first = '上个季度已承诺的采购支出共 $17,440.00，涉及 5 家供应商。'
  const markup = client.answer({ parts: [
    { id: 'p1', type: 'text', text: first },
    ui('p2', 'table', tableProps),
    { id: 'p3', type: 'text', text: `${first}Northstar Electronics 最高。` },
  ], language: 'zh-CN' })
  assert.equal(count(markup, /涉及 5 家供应商/g), 1)
  assert.match(markup, /Northstar Electronics 最高。/)
})

test('a table cut by its tool says how many it shows of how many', async () => {
  const client = await loadClient()
  const rows = Array.from({ length: 10 }, (_, index) => ({ order: ref('purchase_order', `PO-0${10 + index}`) }))
  const markup = client.answer({ parts: [ui('p1', 'table', { columns: [{ code: 'order', kind: 'ref' }], rows, total: 18, more: true })] })
  assert.match(markup, /data-testid="ai-v2-table-count"[^>]*>Showing 10 of 18</)
  assert.match(markup, /data-testid="ai-v2-table-expand"[^>]*>Show 5 more</)
  assert.doesNotMatch(markup, /Show all 10/)
  const zh = client.answer({ parts: [ui('p1', 'table', { columns: [{ code: 'order', kind: 'ref' }], rows, total: 18, more: true })], language: 'zh-CN' })
  assert.ok(zh.includes('显示 18 条中的 10 条') && zh.includes('再显示 5 条'))
})

test('with buttons to pick from, the text tells the user to pick no more', async () => {
  const client = await loadClient()
  const choices = ui('p2', 'choices', { promptCode: 'pick_record', options: [ref('purchase_order', 'PO-020'), ref('purchase_order', 'PO-021')] })
  const en = client.answer({ parts: [{ id: 'p1', type: 'text', text: 'You have 8 overdue orders. Pick one, or give me an order number.' }, choices] })
  assert.match(en, /You have 8 overdue orders\./)
  assert.doesNotMatch(en, /Pick one/)
  const zh = client.answer({ parts: [{ id: 'p1', type: 'text', text: '你没说是哪一个订单。目前有 8 个逾期的采购订单，列出逾期最久的 6 个，请选一个。\n请点选你想了解的订单，或直接告诉我订单号。' }, choices], language: 'zh-CN' })
  assert.match(zh, /目前有 8 个逾期的采购订单，列出逾期最久的 6 个。/)
  assert.doesNotMatch(zh, /请选一个|请点选/)
  assert.equal(count(zh, /你指的是哪条记录？/g), 1)
  // A live answer (2026-11-05): "…几张采购订单，请选一张，或者告诉我订单编号。"
  const live = client.answer({ parts: [{ id: 'p1', type: 'text', text: '列出的是逾期时间最长的几张采购订单，请选一张，或者告诉我订单编号。' }, choices], language: 'zh-CN' })
  assert.match(live, /列出的是逾期时间最长的几张采购订单。/)
  assert.doesNotMatch(live, /请选一张/)
})
