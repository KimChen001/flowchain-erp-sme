import test from 'node:test'
import assert from 'node:assert/strict'
import { aiSkillScenario } from './test-fixtures/ai-skill-scenario.mjs'
import { loadAiSkillContext } from './ai-skill-context.mjs'
import { readAiSkillFacts } from './ai-skill-readers.mjs'
import { AI_READ_TOOL_COLUMNS, runAiReadTool } from './ai-read-tool-runner.mjs'
import { AI_ASSISTANT_V2_UI_TOOLS, aiUiColumnCode } from './ai-assistant-v2-ui-tools.mjs'
import { safeParsePartProps } from '../../shared/assistant-protocol.mjs'

// LDM-001's link to its preferred supplier: 12 days' lead time, a minimum
// order of 100 and a reference price of 95 USD. With a reorder point of 200
// the fixture suggests 100 (the gap of 52 raised to the minimum).
const link = (extra = {}) => ({ id: 'ITEM-001::SUP-001', payload: { itemId: 'ITEM-001', supplierId: 'SUP-001', preferred: true, active: true, approved: true, leadTimeDays: 12, minimumOrderQuantity: 100, referencePrice: 95, currency: 'USD', ...extra } })
const highReorderPoint = (data) => {
  data.items[0].reorderPoint = 200
  data.balances[0].reorderPoint = 200
}
const tool = (name) => AI_ASSISTANT_V2_UI_TOOLS.find((entry) => entry.name === name)
const at = (value, path) => path.split('.').reduce((entry, key) => (entry === null || entry === undefined ? undefined : entry[key]), value)

// The fixture workspace as assistant v2 reads it, and a UI tool context whose
// results are real data tool outputs: call(id, name, args) runs one and keeps it.
async function workspace({ roleKey = 'workspace-administrator', supplierLinks = [link()], change = highReorderPoint, actor = null, userNamedSkus = [] } = {}) {
  const scenario = aiSkillScenario({ roleKey, supplierLinks })
  change?.(scenario.data)
  if (actor) actor(scenario.ctx.aiSkillActor)
  const context = await loadAiSkillContext(scenario.ctx)
  const facts = await readAiSkillFacts(context, { openPurchaseRequests: true })
  const results = new Map()
  const ctx = { results, facts, actor: context.actor, language: 'en-US', threadId: 'thr_7f2c', messageId: 'msg_19', partId: 'p2', userNamedSkus }
  const call = async (id, name, args = {}) => {
    const run = await runAiReadTool(name, args, { facts, context, assistantV2: true })
    assert.ok(run.ok, `${name}: ${run.error}`)
    results.set(id, { tool: name, output: run.result })
    return run.result
  }
  const build = (name, input) => tool(name).build(input, ctx)
  return { ctx, call, build }
}

// A built part: the protocol accepts its props exactly.
function assertPart(built, component) {
  assert.ok(!built.error, `${component}: ${JSON.stringify(built.error)}`)
  assert.equal(built.component, component)
  const parsed = safeParsePartProps(component, built.props)
  assert.ok(parsed.success, parsed.error?.message)
  assert.deepEqual(parsed.data, built.props)
  return built.props
}
const assertError = (built, code) => assert.equal(built.error?.code, code, JSON.stringify(built))

test('every UI tool follows the contract: kind ui, a closed input schema, frozen', () => {
  assert.deepEqual(AI_ASSISTANT_V2_UI_TOOLS.map((entry) => entry.name), ['show_table', 'show_records', 'show_chart', 'show_kpis', 'offer_choices', 'suggest_purchase_request', 'suggest_followups'])
  assert.ok(Object.isFrozen(AI_ASSISTANT_V2_UI_TOOLS))
  for (const entry of AI_ASSISTANT_V2_UI_TOOLS) {
    assert.ok(Object.isFrozen(entry))
    assert.equal(entry.kind, 'ui')
    assert.ok(entry.description.length > 20)
    assert.equal(entry.inputSchema.additionalProperties, false)
    assert.equal(typeof entry.build, 'function')
  }
})

test('every declared column has a part code the protocol accepts, one per column of a list', () => {
  for (const [name, tables] of Object.entries(AI_READ_TOOL_COLUMNS)) {
    for (const [path, keys] of Object.entries(tables)) {
      const codes = keys.map(aiUiColumnCode)
      for (const code of codes) assert.match(code, /^[a-z][a-z0-9_]{0,63}$/, `${name} ${path}`)
      assert.equal(new Set(codes).size, codes.length, `${name} ${path}: ${codes}`)
    }
  }
  assert.equal(aiUiColumnCode('onTime.percent'), 'on_time_rate')
  assert.equal(aiUiColumnCode('openSalesDemand'), 'open_sales_demand')
})

test('show_table fills every cell from the source rows: refs, amounts with their currency, statuses, days', async () => {
  const { call, build } = await workspace()
  const output = await call('toolu_po', 'list_purchase_orders')
  const props = assertPart(build('show_table', { source: 'toolu_po', columns: ['orderNumber', 'supplier', 'status', 'dueDate', 'amount', 'remaining', 'overdue_days', 'open'], title: 'Open orders' }), 'table')
  assert.deepEqual(props.columns, [
    { code: 'order', kind: 'ref' }, { code: 'supplier', kind: 'text' }, { code: 'status', kind: 'status' }, { code: 'due_date', kind: 'date' },
    { code: 'amount', kind: 'money' }, { code: 'remaining_quantity', kind: 'quantity' }, { code: 'days_overdue', kind: 'days' }, { code: 'open', kind: 'status' },
  ])
  assert.equal(props.rows.length, output.rows.length)
  assert.deepEqual([props.total, props.more, props.title, props.source], [output.total, false, 'Open orders', 'toolu_po'])
  // Every value is the source row's, in the cell shape of its column.
  for (const [index, row] of props.rows.entries()) {
    const source = output.rows[index]
    assert.deepEqual(row.order, source.ref)
    assert.equal(row.supplier, source.supplier)
    assert.deepEqual(row.status, { code: source.status })
    assert.equal(row.due_date, source.dueDate)
    assert.deepEqual(row.amount, { amount: source.amount, currency: source.currency })
    assert.equal(row.remaining_quantity, source.remaining)
    assert.equal(row.days_overdue, source.overdueDays)
    assert.deepEqual(row.open, { code: source.open ? 'yes' : 'no', tone: 'neutral' })
  }
  // PO-009 keeps its own currency in a table.
  assert.ok(props.rows.some((row) => row.amount.currency === 'EUR'))
})

test('show_table sorts and limits as asked and counts what it left out', async () => {
  const { call, build } = await workspace()
  const output = await call('toolu_po', 'list_purchase_orders')
  const props = assertPart(build('show_table', { source: 'toolu_po', columns: ['orderNumber', 'remaining'], sort: { column: 'overdueDays', direction: 'desc' }, limit: 2 }), 'table')
  const expected = [...output.rows].sort((a, b) => b.overdueDays - a.overdueDays).slice(0, 2)
  assert.deepEqual(props.rows.map((row) => row.order.label), expected.map((row) => row.orderNumber))
  assert.deepEqual([props.total, props.more], [output.rows.length, true])
})

test('show_table picks the list of a result that holds the columns, or the one named', async () => {
  const { call, build } = await workspace()
  const spend = await call('toolu_spend', 'spend_analysis', { view: 'trend' })
  const months = assertPart(build('show_table', { source: 'toolu_spend', columns: ['month', 'value', 'orders'] }), 'table')
  assert.deepEqual(months.rows.map((row) => [row.month, row.value.amount, row.value.currency, row.orders]), spend.months.map((row) => [row.month, row.value, spend.currency, row.orders]))
  assertError(build('show_table', { source: 'toolu_spend', columns: ['name'], list: 'nowhere' }), 'unknown_list')
})

test('show_table refuses unknown columns, a missing or failed source and a UI result as source', async () => {
  const { ctx, call, build } = await workspace()
  await call('toolu_po', 'list_purchase_orders')
  const unknown = build('show_table', { source: 'toolu_po', columns: ['orderNumber', 'skus'] })
  assertError(unknown, 'unknown_column')
  assert.match(unknown.error.message, /no column skus.*orderNumber/)
  // A key in the rows that the tool does not declare is not a column either.
  assertError(build('show_table', { source: 'toolu_po', columns: ['ref'] }), 'unknown_column')
  assertError(build('show_table', { source: 'toolu_nope', columns: ['orderNumber'] }), 'source_missing')
  ctx.results.set('toolu_ui', { tool: 'show_table', output: { rows: [] } })
  assertError(build('show_table', { source: 'toolu_ui', columns: ['orderNumber'] }), 'source_not_data')
  ctx.results.set('toolu_failed', { tool: 'list_purchase_orders', output: { error: 'not_allowed' } })
  assertError(build('show_table', { source: 'toolu_failed', columns: ['orderNumber'] }), 'source_failed')
  assertError(build('show_table', { source: 'toolu_po', columns: [] }), 'invalid_input')
  assertError(build('show_table', { source: 'toolu_po', columns: ['orderNumber'], limit: 51 }), 'invalid_input')
  assertError(build('show_table', { source: 'toolu_po', columns: ['orderNumber'], rows: [{ orderNumber: 'PO-999' }] }), 'invalid_input')
})

test('show_records builds cards from the rows of the refs named, and refuses a ref the result does not hold', async () => {
  const { call, build } = await workspace()
  const output = await call('toolu_po', 'list_purchase_orders')
  await call('toolu_lines', 'suggest_purchase_lines')
  const po = output.rows.find((row) => row.orderNumber === 'PO-001')
  const props = assertPart(build('show_records', { source: 'toolu_po', refs: [{ type: 'purchase_order', id: 'PO-001', label: 'anything' }], emphasis: 'overdue' }), 'records')
  assert.deepEqual(props.cards, [{
    ref: po.ref,
    title: po.supplier,
    status: { code: po.status },
    date: { kind: 'overdue', days: po.overdueDays },
    figures: [{ code: 'remaining_quantity', value: po.remaining, unit: 'quantity', unitLabel: po.unit }, { code: 'amount', value: po.amount, unit: 'money', currency: po.currency }],
  }])
  assert.equal(props.emphasis, 'overdue')
  // LDM-001 is in the suggestions, not in the purchase orders.
  const foreign = build('show_records', { source: 'toolu_po', refs: [{ type: 'item', id: 'ITEM-001' }] })
  assertError(foreign, 'foreign_ref')
  assertError(build('show_records', { source: 'toolu_po', refs: [{ type: 'purchase_order', id: 'PO-404' }] }), 'foreign_ref')
  assertError(build('show_records', { source: 'toolu_missing', refs: [{ type: 'purchase_order', id: 'PO-001' }] }), 'source_missing')
  assertError(build('show_records', { source: 'toolu_po', refs: [{ type: 'purchase_order', id: 'PO-001' }], emphasis: 'urgent' }), 'invalid_input')
})

test('show_records says how long an attention row has waited or how soon it is due', async () => {
  const { call, build } = await workspace()
  const output = await call('toolu_att', 'attention_list', { limit: 10 })
  const props = assertPart(build('show_records', { source: 'toolu_att', refs: output.rows.slice(0, 6).map((row) => row.ref) }), 'records')
  for (const [index, card] of props.cards.entries()) {
    const row = output.rows[index]
    assert.deepEqual(card.ref, row.ref)
    if (row.whenKind === 'overdue' || row.whenKind === 'due') assert.deepEqual(card.date, { kind: row.whenKind, days: row.days })
  }
})

test('show_chart draws one list in one unit and refuses amounts in two currencies', async () => {
  const { call, build } = await workspace()
  const projection = await call('toolu_projection', 'stock_projection', { sku: 'LDM-001' })
  const props = assertPart(build('show_chart', { source: 'toolu_projection', kind: 'line', x: 'from', series: ['endAvailable', 'incoming'], title: 'LDM-001 by week' }), 'chart')
  assert.deepEqual(props.x, { code: 'from', values: projection.weeks.map((week) => week.from) })
  assert.deepEqual(props.series, [{ code: 'end_available', values: projection.weeks.map((week) => week.endAvailable) }, { code: 'incoming', values: projection.weeks.map((week) => week.incoming) }])
  assert.equal(props.unit, 'quantity')
  assert.equal(props.currency, undefined)
  const spend = await call('toolu_spend', 'spend_analysis', { view: 'trend' })
  const money = assertPart(build('show_chart', { source: 'toolu_spend', kind: 'bar', x: 'month', series: ['value'] }), 'chart')
  assert.deepEqual([money.unit, money.currency, money.series[0].values], ['money', spend.currency, spend.months.map((row) => row.value)])
  // The open orders are in USD and EUR (PO-009).
  await call('toolu_po', 'list_purchase_orders')
  const mixed = build('show_chart', { source: 'toolu_po', kind: 'bar', x: 'orderNumber', series: ['amount'] })
  assertError(mixed, 'mixed_currencies')
  assert.match(mixed.error.message, /EUR and USD/)
  assertError(build('show_chart', { source: 'toolu_po', kind: 'bar', x: 'orderNumber', series: ['amount', 'remaining'] }), 'mixed_units')
  assertError(build('show_chart', { source: 'toolu_po', kind: 'bar', x: 'orderNumber', series: ['supplier'] }), 'not_numeric')
  assertError(build('show_chart', { source: 'toolu_po', kind: 'bar', x: 'orderNumber', series: ['price'] }), 'unknown_column')
  assertError(build('show_chart', { source: 'toolu_po', kind: 'pie', x: 'orderNumber', series: ['remaining'] }), 'invalid_input')
  assertError(build('show_chart', { source: 'toolu_gone', kind: 'bar', x: 'month', series: ['value'] }), 'source_missing')
})

test('show_kpis takes workspace_summary keys and shows a hidden figure without a value', async () => {
  const admin = await workspace()
  const summary = await admin.call('toolu_ws', 'workspace_summary')
  const props = assertPart(admin.build('show_kpis', { source: 'toolu_ws', keys: ['purchaseOrders.open', 'purchaseOrders.overdue', 'inventory.atRisk'] }), 'kpis')
  assert.deepEqual(props.tiles, [
    { code: 'open_purchase_orders', value: summary.purchaseOrders.open, unit: 'count' },
    { code: 'overdue_purchase_orders', value: summary.purchaseOrders.overdue, unit: 'count' },
    { code: 'inventory_at_risk', value: summary.inventory.atRisk, unit: 'count' },
  ])
  assertError(admin.build('show_kpis', { source: 'toolu_ws', keys: ['purchaseOrders.open', 'purchaseOrders.committedSpend'] }), 'unknown_column')
  assertError(admin.build('show_kpis', { source: 'toolu_ws', keys: ['purchaseOrders.open'] }), 'invalid_input')
  await admin.call('toolu_po', 'list_purchase_orders')
  assertError(admin.build('show_kpis', { source: 'toolu_po', keys: ['orderNumber', 'remaining'] }), 'wrong_source')
  assertError(admin.build('show_kpis', { source: 'toolu_none', keys: ['purchaseOrders.open', 'rfqs.open'] }), 'source_missing')
  // Operations may not read purchase orders: the tile says so and carries no number.
  const operations = await workspace({ roleKey: 'operations-specialist' })
  const hidden = await operations.call('toolu_ws', 'workspace_summary')
  assert.equal(hidden.purchaseOrders, null)
  const tiles = assertPart(operations.build('show_kpis', { source: 'toolu_ws', keys: ['purchaseOrders.open', 'inventory.skus'] }), 'kpis').tiles
  assert.deepEqual(tiles, [{ code: 'open_purchase_orders', value: null, unit: 'count', hidden: true }, { code: 'inventory_skus', value: hidden.inventory.skus, unit: 'count' }])
})

test('offer_choices offers refs of the result only, of the type the prompt asks for', async () => {
  const { call, build } = await workspace()
  const output = await call('toolu_po', 'list_purchase_orders')
  const [first, second] = output.rows
  const props = assertPart(build('offer_choices', { source: 'toolu_po', refs: [first.ref, second.ref], promptCode: 'pick_record' }), 'choices')
  assert.deepEqual(props, { source: 'toolu_po', promptCode: 'pick_record', options: [first.ref, second.ref] })
  assertError(build('offer_choices', { source: 'toolu_po', refs: [first.ref, second.ref], promptCode: 'pick_supplier' }), 'wrong_ref_type')
  assertError(build('offer_choices', { source: 'toolu_po', refs: [first.ref, { type: 'purchase_order', id: 'PO-777' }], promptCode: 'pick_record' }), 'foreign_ref')
  assertError(build('offer_choices', { source: 'toolu_po', refs: [first.ref], promptCode: 'pick_record' }), 'invalid_input')
  assertError(build('offer_choices', { source: 'toolu_x', refs: [first.ref, second.ref], promptCode: 'pick_record' }), 'source_missing')
})

test('suggest_purchase_request maps the server suggestion into the form and ticks nothing the user did not name', async () => {
  const { call, build } = await workspace()
  const output = await call('toolu_lines', 'suggest_purchase_lines')
  const props = assertPart(build('suggest_purchase_request', { source: 'toolu_lines', from: 'suggestions', lines: [] }), 'pr_form')
  const [row] = output.rows
  assert.equal(props.formId, 'thr_7f2c:msg_19:p2')
  assert.deepEqual([props.lines, props.canCreate, props.source], [[], true, 'toolu_lines'])
  assert.deepEqual(props.suggested, [{
    item: row.item,
    onHand: row.onHand,
    safetyStock: row.safetyStock,
    reorderPoint: row.reorderPoint,
    suggestedQuantity: { value: 100, source: 'reorder_gap_raised_to_moq', minimum: 100 },
    supplier: { id: 'SUP-001', name: 'Acme Components', source: 'preferred' },
    suppliers: [{ id: 'SUP-001', name: 'Acme Components', preferred: true, leadTimeDays: 12, unitPrice: 95, currency: 'USD' }],
    needByDate: { value: row.needByDate.value, source: 'lead_time', leadTimeDays: 12, shortWeekOf: null },
    estimatedUnitPrice: { value: 95, currency: 'USD', source: 'reference_price' },
    warehouse: null,
    covered: null,
    checked: false,
  }])
})

test('suggest_purchase_request ticks a named item and keeps the user\'s own values for it only', async () => {
  const named = await workspace({ userNamedSkus: ['ldm-001'] })
  await named.call('toolu_lines', 'suggest_purchase_lines', { skus: ['LDM-001', 'LDM-002'] })
  const lines = [{ sku: 'LDM-001', quantity: 150, supplier: 'acme components', needByDate: '2026-10-20' }, { sku: 'LDM-002', quantity: 999, needByDate: '2026-12-01' }]
  const props = assertPart(named.build('suggest_purchase_request', { source: 'toolu_lines', from: 'user_named', lines }), 'pr_form')
  const [ldm1] = props.lines
  assert.deepEqual([ldm1.item.sku, ldm1.checked], ['LDM-001', true])
  assert.deepEqual(ldm1.suggestedQuantity, { value: 150, source: 'user_named' })
  assert.deepEqual(ldm1.supplier, { id: 'SUP-001', name: 'Acme Components', source: 'user_named' })
  assert.deepEqual(ldm1.needByDate, { value: '2026-10-20', source: 'user_named', leadTimeDays: 12, shortWeekOf: null })
  assert.equal(ldm1.estimatedUnitPrice.value, 95)
  // LDM-002 was not named by the user: unticked, and the model's values are not used.
  const [ldm2] = props.suggested
  assert.equal(ldm2.item.sku, 'LDM-002')
  assert.equal(ldm2.checked, false)
  assert.notEqual(ldm2.suggestedQuantity.value, 999)
  assert.notEqual(ldm2.needByDate.value, '2026-12-01')
  // Not named: a claim of user_named does not tick it.
  const unnamed = await workspace()
  await unnamed.call('toolu_lines', 'suggest_purchase_lines', { skus: ['LDM-001'] })
  const plain = assertPart(unnamed.build('suggest_purchase_request', { source: 'toolu_lines', from: 'user_named', lines: [{ sku: 'LDM-001', quantity: 150 }] }), 'pr_form')
  assert.deepEqual([plain.lines.length, plain.suggested[0].checked, plain.suggested[0].suggestedQuantity.value], [0, false, 100])
})

test('suggest_purchase_request keeps a covered item unticked with what covers it, even when named', async () => {
  const change = (data) => { highReorderPoint(data); data.purchaseRequests[1].lines = [{ id: 'PRL-002', sku: 'LDM-001', itemId: 'ITEM-001', quantity: 60, unit: 'pcs' }] }
  const { call, build } = await workspace({ change, userNamedSkus: ['LDM-001'] })
  const output = await call('toolu_lines', 'suggest_purchase_lines', { skus: ['LDM-001'] })
  const props = assertPart(build('suggest_purchase_request', { source: 'toolu_lines', from: 'user_named', lines: [{ sku: 'LDM-001' }] }), 'pr_form')
  const [row] = props.lines
  assert.equal(row.checked, false)
  assert.deepEqual(row.covered, { ref: output.rows[0].covered.by[0].ref })
  assert.deepEqual(row.suggestedQuantity, { value: null, source: 'user_named' })
  const built = build('suggest_purchase_request', { source: 'toolu_lines', from: 'user_named', lines: [{ sku: 'LDM-001' }] })
  for (const entry of output.rows[0].covered.by) assert.ok(built.refs.some((ref) => ref.id === entry.ref.id))
})

test('suggest_purchase_request sends no price when it is masked or missing, and only approved suppliers', async () => {
  const masked = await workspace({ actor: (actor) => actor.permissionCodes.delete('procurement.prices.read') })
  const output = await masked.call('toolu_lines', 'suggest_purchase_lines')
  assert.equal(output.pricesHidden, true)
  const [row] = assertPart(masked.build('suggest_purchase_request', { source: 'toolu_lines', from: 'suggestions' }), 'pr_form').suggested
  assert.deepEqual(row.estimatedUnitPrice, { value: null, currency: null, source: 'masked' })
  assert.ok(row.suppliers.every((supplier) => supplier.unitPrice === null))
  assert.doesNotMatch(JSON.stringify(row), /95/)
  // Two approved suppliers and none preferred: no default, no price, both listed.
  const links = [link({ preferred: false }), { id: 'ITEM-001::SUP-002', payload: { itemId: 'ITEM-001', supplierId: 'SUP-002', preferred: false, active: true, approved: true, leadTimeDays: 5 } }]
  const open = await workspace({ supplierLinks: links, change: (data) => { highReorderPoint(data); data.items[0].preferredSupplierId = null }, userNamedSkus: ['LDM-001'] })
  await open.call('toolu_lines', 'suggest_purchase_lines', { skus: ['LDM-001'] })
  const [choice] = assertPart(open.build('suggest_purchase_request', { source: 'toolu_lines', from: 'user_named', lines: [{ sku: 'LDM-001' }] }), 'pr_form').lines
  assert.equal(choice.supplier, null)
  assert.deepEqual(choice.suppliers.map((supplier) => supplier.id).sort(), ['SUP-001', 'SUP-002'])
  assert.deepEqual(choice.estimatedUnitPrice, { value: null, currency: null, source: 'missing' })
  assert.deepEqual(choice.needByDate, { value: open.ctx.facts.today, source: 'today', leadTimeDays: null, shortWeekOf: null })
  // The user may pick one of them by name; a supplier not listed is refused.
  const picked = assertPart(open.build('suggest_purchase_request', { source: 'toolu_lines', from: 'user_named', lines: [{ sku: 'LDM-001', supplier: 'Summit Packaging' }] }), 'pr_form').lines[0]
  assert.deepEqual(picked.supplier, { id: 'SUP-002', name: 'Summit Packaging', source: 'user_named' })
  assert.equal(picked.estimatedUnitPrice.value, null)
  assertError(open.build('suggest_purchase_request', { source: 'toolu_lines', from: 'user_named', lines: [{ sku: 'LDM-001', supplier: 'Globex' }] }), 'supplier_not_listed')
})

test('suggest_purchase_request carries the short-week warning on the need-by date', async () => {
  const { call, build } = await workspace({ change: (data) => { highReorderPoint(data); data.salesOrders[0].promisedDate = '2026-10-01' } })
  await call('toolu_lines', 'suggest_purchase_lines')
  const [row] = assertPart(build('suggest_purchase_request', { source: 'toolu_lines', from: 'suggestions' }), 'pr_form').suggested
  assert.deepEqual(row.needByDate, { value: '2026-10-11', source: 'lead_time', leadTimeDays: 12, shortWeekOf: '2026-09-29' })
})

test('suggest_purchase_request refuses a foreign SKU, another tool\'s result, an inactive item and a user who may not draft', async () => {
  const { ctx, call, build } = await workspace({ userNamedSkus: ['LDM-001'] })
  await call('toolu_lines', 'suggest_purchase_lines')
  await call('toolu_po', 'list_purchase_orders')
  assertError(build('suggest_purchase_request', { source: 'toolu_lines', from: 'user_named', lines: [{ sku: 'LDM-002' }] }), 'foreign_sku')
  assertError(build('suggest_purchase_request', { source: 'toolu_po', from: 'suggestions' }), 'wrong_source')
  assertError(build('suggest_purchase_request', { source: 'toolu_none', from: 'suggestions' }), 'source_missing')
  assertError(build('suggest_purchase_request', { source: 'toolu_lines', from: 'user_named', lines: [] }), 'invalid_input')
  assertError(build('suggest_purchase_request', { source: 'toolu_lines', from: 'user_named', lines: [{ sku: 'LDM-001', needByDate: '2026-02-30' }] }), 'invalid_input')
  assertError(build('suggest_purchase_request', { source: 'toolu_lines', from: 'user_named', lines: [{ sku: 'LDM-001', quantity: 0 }] }), 'invalid_input')
  assert.equal(ctx.userNamedSkus.length, 1)
  const inactive = await workspace({ change: (data) => { highReorderPoint(data); data.items[0].status = 'inactive' }, userNamedSkus: ['LDM-001'] })
  await inactive.call('toolu_lines', 'suggest_purchase_lines', { skus: ['LDM-001'] })
  assertError(inactive.build('suggest_purchase_request', { source: 'toolu_lines', from: 'user_named', lines: [{ sku: 'LDM-001' }] }), 'nothing_to_request')
  const viewer = await workspace({ roleKey: 'read-only-viewer' })
  await viewer.call('toolu_lines', 'suggest_purchase_lines')
  assertError(viewer.build('suggest_purchase_request', { source: 'toolu_lines', from: 'suggestions' }), 'not_allowed')
})

test('suggest_followups keeps 1 to 3 questions of at most 90 characters', async () => {
  const { build } = await workspace()
  const ninety = `Which orders are late${'?'.repeat(69)}`
  assert.equal(ninety.length, 90)
  const props = assertPart(build('suggest_followups', { questions: ['  Which of these already\nhave an open request? ', ninety, ninety] }), 'followups')
  assert.deepEqual(props.questions, ['Which of these already have an open request?', ninety])
  const long = build('suggest_followups', { questions: [`${ninety}!`] })
  assertError(long, 'too_long')
  assert.match(long.error.message, /91/)
  assertError(build('suggest_followups', { questions: [] }), 'invalid_input')
  assertError(build('suggest_followups', { questions: ['   '] }), 'invalid_input')
  assertError(build('suggest_followups', { questions: ['a', 'b', 'c', 'd'] }), 'invalid_input')
})

test('every value a part shows is in its source result', async () => {
  const { ctx, call, build } = await workspace()
  await call('toolu_stock', 'stock_position')
  const built = build('show_table', { source: 'toolu_stock', columns: ['sku', 'itemName', 'onHand', 'available', 'safetyStock', 'reorderPoint', 'status', 'unit'] })
  const props = assertPart(built, 'table')
  const source = ctx.results.get('toolu_stock').output.rows
  const keys = { sku: 'sku', item: 'itemName', on_hand: 'onHand', available: 'available', safety_stock: 'safetyStock', reorder_point: 'reorderPoint', status: 'status', unit: 'unit' }
  for (const [index, row] of props.rows.entries()) {
    for (const [code, cell] of Object.entries(row)) {
      const value = at(source[index], keys[code])
      const shown = cell && typeof cell === 'object' ? cell.label ?? cell.code : cell
      assert.equal(shown, value, `${code} of row ${index}`)
    }
  }
  assert.deepEqual(built.refs, source.map((row) => row.ref))
})
