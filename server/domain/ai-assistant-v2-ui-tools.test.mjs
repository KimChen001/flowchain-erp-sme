import test from 'node:test'
import assert from 'node:assert/strict'
import { aiSkillScenario } from './test-fixtures/ai-skill-scenario.mjs'
import { loadAiSkillContext } from './ai-skill-context.mjs'
import { readAiSkillFacts } from './ai-skill-readers.mjs'
import { AI_READ_TOOL_COLUMNS, runAiReadTool } from './ai-read-tool-runner.mjs'
import { AI_ASSISTANT_V2_UI_TOOLS, aiUiColumnCode, aiUiSourceHandles, aiUiToolsFor, namesAnItem } from './ai-assistant-v2-ui-tools.mjs'
import { AI_SKILL_SIGNAL_SEVERITY } from './ai-skill-signals.mjs'
import { safeParsePartProps } from '../../shared/assistant-protocol.mjs'
import { PURCHASE_SUGGESTION_SOURCES } from '../../shared/purchase-suggestion.mjs'
import { sanitizeSuggestionTrail } from '../../shared/prefill-suggestions.mjs'
import { readFileSync } from 'node:fs'
import { RECORD_ACTION_RULES, recordActionsNow } from '../../shared/assistant-record-actions.mjs'
import { PR_TRANSITIONS } from './procurement-workflow.mjs'
import { PURCHASE_ORDER_COMMANDS } from './procurement-db-command-service.mjs'
import { latestOrderPlan } from './ai-assistant-v2.mjs'

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
async function workspace({ roleKey = 'workspace-administrator', supplierLinks = [link()], change = highReorderPoint, actor = null, userNamedSkus = [], userText = '', env = null, agreeable = null, lastFormSkus = [] } = {}) {
  const scenario = aiSkillScenario({ roleKey, supplierLinks })
  change?.(scenario.data)
  if (actor) actor(scenario.ctx.aiSkillActor)
  const context = await loadAiSkillContext(env ? { ...scenario.ctx, env } : scenario.ctx)
  const facts = await readAiSkillFacts(context, { openPurchaseRequests: true })
  const results = new Map()
  const ctx = { results, facts, actor: context.actor, language: 'en-US', threadId: 'thr_7f2c', messageId: 'msg_19', partId: 'p2', userNamedSkus, userText, prisma: context.prisma, tenantId: context.tenantId, workspaceCurrency: context.tenant.currency, agreeable, lastFormSkus }
  const call = async (id, name, args = {}) => {
    const run = await runAiReadTool(name, args, { facts, context })
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
  assert.deepEqual(AI_ASSISTANT_V2_UI_TOOLS.map((entry) => entry.name), ['show_table', 'show_records', 'show_chart', 'show_kpis', 'offer_choices', 'suggest_purchase_request', 'show_setup_steps', 'suggest_setup_records', 'offer_record_actions', 'suggest_followups'])
  assert.ok(Object.isFrozen(AI_ASSISTANT_V2_UI_TOOLS))
  for (const entry of AI_ASSISTANT_V2_UI_TOOLS) {
    assert.ok(Object.isFrozen(entry))
    assert.equal(entry.kind, 'ui')
    assert.ok(entry.description.length > 20)
    assert.equal(entry.inputSchema.additionalProperties, false)
    assert.equal(typeof entry.build, 'function')
    assert.equal(typeof entry.available, 'function')
  }
})

test('the display tools are marked, and every source parameter asks for the handle a result gives', () => {
  assert.deepEqual(AI_ASSISTANT_V2_UI_TOOLS.filter((entry) => entry.display).map((entry) => entry.name), ['show_table', 'show_records', 'show_chart', 'show_kpis', 'offer_choices', 'show_setup_steps'])
  for (const entry of AI_ASSISTANT_V2_UI_TOOLS.filter((item) => item.inputSchema.properties.source)) {
    assert.match(entry.inputSchema.properties.source.description, /#1/, entry.name)
    assert.doesNotMatch(entry.inputSchema.properties.source.description, /tool_use id/, entry.name)
  }
})

test('a source is the handle a result carries, its tool\'s name for the latest result, or the tool_use id', async () => {
  const { ctx, call, build } = await workspace()
  const all = await call('toolu_po', 'list_purchase_orders')
  await call('toolu_stock', 'stock_position')
  const overdue = await call('toolu_late', 'list_purchase_orders', { status: 'overdue' })
  assert.deepEqual([...aiUiSourceHandles(ctx.results)], [['toolu_po', 'list_purchase_orders#1'], ['toolu_stock', 'stock_position#1'], ['toolu_late', 'list_purchase_orders#2']])
  const rowsOf = (reference) => assertPart(build('show_table', { source: reference, columns: ['orderNumber'] }), 'table').rows.map((row) => row.order.label)
  const first = all.rows.map((row) => row.orderNumber)
  const latest = overdue.rows.map((row) => row.orderNumber)
  assert.notDeepEqual(first, latest)
  assert.deepEqual(rowsOf('list_purchase_orders#1'), first)
  assert.deepEqual(rowsOf('functions.list_purchase_orders#1'), first)
  assert.deepEqual(rowsOf('toolu_po'), first)
  assert.deepEqual(rowsOf('list_purchase_orders#2'), latest)
  // The tool's name alone, as chat models write it, means its latest result.
  assert.deepEqual(rowsOf('list_purchase_orders'), latest)
  assert.deepEqual(rowsOf('functions.list_purchase_orders'), latest)
  // The props name the call the source resolved to, whichever way the model named it.
  assert.equal(build('show_table', { source: 'list_purchase_orders#1', columns: ['orderNumber'] }).props.source, 'toolu_po')
  assert.equal(build('show_table', { source: 'functions.list_purchase_orders', columns: ['orderNumber'] }).props.source, 'toolu_late')
  // A source no result has: the error lists the ones there are.
  const missing = build('show_table', { source: 'list_purchase_orders#3', columns: ['orderNumber'] })
  assertError(missing, 'source_missing')
  assert.equal(missing.error.message, 'No data result of this answer is called list_purchase_orders#3. Pass source exactly as a result gives it: list_purchase_orders#1, stock_position#1, list_purchase_orders#2.')
  assertError(build('show_table', { source: 'supplier_performance', columns: ['name'] }), 'source_missing')
  // Before any data result there is nothing to name.
  const empty = await workspace()
  assert.equal(empty.build('show_table', { source: 'list_purchase_orders', columns: ['orderNumber'] }).error.message, 'No data tool has returned a result in this answer yet. Call a data tool first, then pass the source its result gives.')
  // Other UI tools take the same sources.
  assertPart(build('show_records', { source: 'stock_position', refs: [{ type: 'item', id: 'ITEM-001' }] }), 'records')
})

test('the request form is not offered to a user who may not create requests', async () => {
  const admin = await workspace()
  assert.deepEqual(aiUiToolsFor(admin.ctx.actor).map((entry) => entry.name), AI_ASSISTANT_V2_UI_TOOLS.map((entry) => entry.name))
  const viewer = await workspace({ roleKey: 'read-only-viewer' })
  const offered = aiUiToolsFor(viewer.ctx.actor).map((entry) => entry.name)
  assert.ok(!offered.includes('suggest_purchase_request'))
  assert.ok(offered.includes('show_table'))
})

// Every label a part looks up, in both languages: a code with no key would
// show as humanized English in a Chinese answer.
test('every column, KPI and status code the UI tools emit has a label in English and Chinese', () => {
  const source = readFileSync(new URL('../../src/i18n/I18n.tsx', import.meta.url), 'utf8')
  const labelled = (key) => source.split(`"${key}":`).length - 1 === 2
  const missing = []
  for (const [name, tables] of Object.entries(AI_READ_TOOL_COLUMNS)) {
    for (const keys of Object.values(tables)) {
      for (const key of keys) {
        const label = `ai.v2.${name === 'workspace_summary' ? 'kpi' : 'column'}.${aiUiColumnCode(key)}`
        if (!labelled(label)) missing.push(label)
      }
    }
  }
  const statuses = [...Object.values(PURCHASE_SUGGESTION_SOURCES).filter((code) => !code.startsWith('lead_time')), ...new Set(Object.values(AI_SKILL_SIGNAL_SEVERITY)), 'overdue', 'due', 'undated', 'yes', 'no']
  for (const code of statuses) if (!labelled(`ai.v2.status.${code}`)) missing.push(`ai.v2.status.${code}`)
  assert.deepEqual(missing, [])
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
    // Days overdue only on an order that is late and open (2026-11-05).
    assert.equal(row.days_overdue, source.overdueDays > 0 && source.open !== false ? source.overdueDays : null)
    assert.deepEqual(row.open, { code: source.open ? 'yes' : 'no', tone: 'neutral' })
    // The quantity's unit goes beside its cell.
    assert.equal(row.unit, source.unit)
  }
  assert.ok(props.rows.some((row) => row.days_overdue === null) && props.rows.some((row) => row.days_overdue > 0))
  // PO-009 keeps its own currency in a table.
  assert.ok(props.rows.some((row) => row.amount.currency === 'EUR'))
  // A column of units alone is not shown next to a quantity; it stays without one.
  const units = assertPart(build('show_table', { source: 'toolu_po', columns: ['orderNumber', 'remaining', 'unit'] }), 'table')
  assert.deepEqual(units.columns.map((column) => column.code), ['order', 'remaining_quantity'])
  assert.ok(units.rows.every((row, index) => row.unit === output.rows[index].unit))
  const plain = assertPart(build('show_table', { source: 'toolu_po', columns: ['orderNumber', 'unit'] }), 'table')
  assert.deepEqual(plain.columns.map((column) => column.code), ['order', 'unit'])
})

test('show_table words types and priorities as codes the panel labels, never as text', async () => {
  const { call, build } = await workspace()
  await call('toolu_attention', 'attention_list', { kind: 'problems', limit: 5 })
  const props = assertPart(build('show_table', { source: 'toolu_attention', columns: ['label', 'type', 'severity'] }), 'table')
  assert.deepEqual(props.columns.map((column) => [column.code, column.kind]), [['label', 'ref'], ['type', 'status'], ['severity', 'status']])
  assert.ok(props.rows.every((row) => typeof row.type === 'object' && /^[a-z_]+$/.test(row.type.code) && row.type.tone === 'neutral'), JSON.stringify(props.rows))
  await call('toolu_requests', 'list_purchase_requests', { status: 'all' })
  const requests = assertPart(build('show_table', { source: 'toolu_requests', columns: ['request', 'priority'] }), 'table')
  assert.ok(requests.rows.some((row) => row.priority?.code === 'high' && row.priority.tone === 'warning'), JSON.stringify(requests.rows))
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
  const unknown = build('show_table', { source: 'toolu_po', columns: ['orderNumber', 'itemIds'] })
  assertError(unknown, 'unknown_column')
  assert.match(unknown.error.message, /no column itemIds.*orderNumber/)
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
  // Named by its handle, the form's source is still the call it came from,
  // which a saved form's suggestion trail keeps as the ref of its fields.
  const byHandle = assertPart(build('suggest_purchase_request', { source: 'suggest_purchase_lines#1', from: 'suggestions' }), 'pr_form')
  assert.equal(byHandle.source, 'toolu_lines')
  const trail = sanitizeSuggestionTrail({ origin: 'ai_assistant', fields: [{ field: 'lines.0.quantity', source: 'record', ref: byHandle.source, outcome: 'accepted' }] })
  assert.equal(trail.fields[0].ref, 'toolu_lines')
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

// The solver's decision goes into the form as the server's suggestion: the
// form shows it as the best plan's quantity, ticked once the user agrees, and
// the open orders the plan already counted do not mark it covered.
test('suggest_purchase_request carries the latest optimize_order_plan decision\'s quantity as the best plan\'s', async () => {
  const shipping = (data) => {
    data.shipmentLines = Array.from({ length: 18 }, (_, index) => ({ itemId: 'ITEM-001', unit: 'pcs', postedQuantity: 50, shipment: { postedAt: new Date(`2026-09-${String(index + 1).padStart(2, '0')}T16:00:00Z`) } }))
  }
  // The recorded reorder point (40) is covered by the open orders and PR-001.
  const agreeable = (sku) => String(sku).toLowerCase() === 'ldm-001'
  const { ctx, call, build } = await workspace({ change: shipping, actor: (actor) => { actor.allWarehouses = true }, agreeable, lastFormSkus: ['ldm-001'] })
  const plan = await call('toolu_plan', 'optimize_order_plan')
  const quantity = plan.decision.lines[0].quantity
  await call('toolu_lines', 'suggest_purchase_lines', { skus: ['LDM-001'] })
  ctx.orderPlan = latestOrderPlan(ctx.results)
  assert.deepEqual([...ctx.orderPlan], [['ldm-001', quantity]])
  const offered = assertPart(build('suggest_purchase_request', { source: 'toolu_lines', from: 'suggestions', lines: [{ sku: 'LDM-001', quantity }] }), 'pr_form')
  assert.deepEqual([offered.suggested[0].suggestedQuantity, offered.suggested[0].checked, offered.suggested[0].covered], [{ value: quantity, source: 'order_plan' }, false, null])
  const agreed = assertPart(build('suggest_purchase_request', { source: 'toolu_lines', from: 'agreed', lines: [{ sku: 'LDM-001', quantity }] }), 'pr_form')
  assert.deepEqual([agreed.lines[0].suggestedQuantity.source, agreed.lines[0].checked], ['order_plan', true])
  // Any other quantity the model passes is not the plan's: the server's suggestion stands.
  const other = assertPart(build('suggest_purchase_request', { source: 'toolu_lines', from: 'suggestions', lines: [{ sku: 'LDM-001', quantity: quantity + 1 }] }), 'pr_form')
  assert.notEqual(other.suggested[0].suggestedQuantity.source, 'order_plan')
  assert.ok(other.suggested[0].covered)
})

// "Yes, all of them" after a form (2026-11-04): the items the user agreed to
// arrive ticked; an item never named nor offered in the conversation does not.
test('suggest_purchase_request ticks the items the user agreed to, and only those the conversation offered', async () => {
  const offered = new Set(['ldm-001', 'ldm-002'])
  const agreeable = (sku) => offered.has(String(sku).toLowerCase())
  const all = await workspace({ agreeable, lastFormSkus: ['ldm-001', 'ldm-002'] })
  await all.call('toolu_lines', 'suggest_purchase_lines', { skus: ['LDM-001', 'LDM-002'] })
  // No lines: every item of the latest form, ticked, with the server's values.
  const props = assertPart(all.build('suggest_purchase_request', { source: 'toolu_lines', from: 'agreed' }), 'pr_form')
  assert.deepEqual(props.lines.map((row) => [row.item.sku, row.checked]), [['LDM-001', true], ['LDM-002', true]])
  assert.deepEqual(props.suggested, [])
  assert.equal(props.lines[0].suggestedQuantity.source, 'reorder_gap_raised_to_moq')
  // Listed lines: those only, with a quantity the user changed.
  const some = assertPart(all.build('suggest_purchase_request', { source: 'toolu_lines', from: 'agreed', lines: [{ sku: 'LDM-002', quantity: 40 }] }), 'pr_form')
  assert.deepEqual(some.lines.map((row) => [row.item.sku, row.checked, row.suggestedQuantity.value]), [['LDM-002', true, 40]])
  // An item the conversation never offered is not ticked by a claim of agreement.
  const narrow = await workspace({ agreeable: (sku) => String(sku).toLowerCase() === 'ldm-001', lastFormSkus: ['ldm-001'] })
  await narrow.call('toolu_lines', 'suggest_purchase_lines', { skus: ['LDM-001', 'LDM-002'] })
  assertError(narrow.build('suggest_purchase_request', { source: 'toolu_lines', from: 'agreed', lines: [{ sku: 'LDM-002' }] }), 'not_agreed')
  const latest = assertPart(narrow.build('suggest_purchase_request', { source: 'toolu_lines', from: 'agreed' }), 'pr_form')
  assert.deepEqual(latest.lines.map((row) => row.item.sku), ['LDM-001'])
  // No earlier form: nothing to agree to.
  const first = await workspace()
  await first.call('toolu_lines', 'suggest_purchase_lines', { skus: ['LDM-001'] })
  assertError(first.build('suggest_purchase_request', { source: 'toolu_lines', from: 'agreed' }), 'nothing_agreed')
  // The latest form's items must be in the source.
  const other = await workspace({ agreeable, lastFormSkus: ['ldm-002'] })
  await other.call('toolu_lines', 'suggest_purchase_lines', { skus: ['LDM-001'] })
  assertError(other.build('suggest_purchase_request', { source: 'toolu_lines', from: 'agreed' }), 'foreign_sku')
})

test('suggest_purchase_request keeps a covered item unticked with what covers it, even when named', async () => {
  const change = (data) => { highReorderPoint(data); data.purchaseRequests[1].lines = [{ id: 'PRL-002', sku: 'LDM-001', itemId: 'ITEM-001', quantity: 60, unit: 'pcs' }] }
  const { call, build } = await workspace({ change, userNamedSkus: ['LDM-001'] })
  const output = await call('toolu_lines', 'suggest_purchase_lines', { skus: ['LDM-001'] })
  const props = assertPart(build('suggest_purchase_request', { source: 'toolu_lines', from: 'user_named', lines: [{ sku: 'LDM-001' }] }), 'pr_form')
  const [row] = props.lines
  assert.equal(row.checked, false)
  assert.deepEqual(row.covered, { ref: output.rows[0].covered.by[0].ref })
  assert.deepEqual(row.suggestedQuantity, { value: null, source: 'none' })
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
  // A supplier not listed is looked up among the workspace's, so the answer comes later.
  assertError(await open.build('suggest_purchase_request', { source: 'toolu_lines', from: 'user_named', lines: [{ sku: 'LDM-001', supplier: 'Globex' }] }), 'supplier_not_listed')
})

// "Order 200 of LDM-001 from Northstar Electronics" (2026-11-04): Northstar is
// an active supplier of the workspace, but LDM-001 has not approved it.
const northstar = (data) => {
  highReorderPoint(data)
  data.suppliers.push(
    { id: 'SUP-003', supplierCode: 'NS-01', name: 'Northstar Electronics', supplierName: 'Northstar Electronics', status: 'active' },
    { id: 'SUP-004', supplierCode: 'NS-02', name: 'Northstar Logistics', supplierName: 'Northstar Logistics', status: 'active' },
    { id: 'SUP-005', supplierCode: 'OLD-1', name: 'Oldfield Parts', supplierName: 'Oldfield Parts', status: 'inactive' },
  )
}
const ACME_OPTION = { id: 'SUP-001', name: 'Acme Components', preferred: true, leadTimeDays: 12, unitPrice: 95, currency: 'USD' }

test('suggest_purchase_request puts a named supplier the item has not approved on the line, marked new, for a user who may add it', async () => {
  const userText = 'order 200 of LDM-001 from Northstar Electronics'
  const { ctx, call, build } = await workspace({ change: northstar, userNamedSkus: ['LDM-001'], userText })
  await call('toolu_lines', 'suggest_purchase_lines', { skus: ['LDM-001'] })
  const built = await build('suggest_purchase_request', { source: 'toolu_lines', from: 'user_named', lines: [{ sku: 'LDM-001', quantity: 200, supplier: 'Northstar Electronics' }] })
  const props = assertPart(built, 'pr_form')
  const [line] = props.lines
  assert.deepEqual(line.supplier, { id: 'SUP-003', name: 'Northstar Electronics', source: 'user_named', link: 'new' })
  assert.deepEqual(line.suppliers, [ACME_OPTION, { id: 'SUP-003', name: 'Northstar Electronics', preferred: false, leadTimeDays: null, unitPrice: null, currency: 'USD', link: 'new' }])
  // No price the user did not give; with no lead time of its own the need-by
  // date keeps the preferred supplier's (12 days), never today (2026-11-05).
  assert.deepEqual(line.estimatedUnitPrice, { value: null, currency: null, source: 'missing' })
  assert.deepEqual(line.needByDate, { value: '2026-10-11', source: 'lead_time', leadTimeDays: 12, shortWeekOf: null })
  assert.notEqual(line.needByDate.value, ctx.facts.today)
  assert.deepEqual([line.suggestedQuantity, line.checked], [{ value: 200, source: 'user_named' }, true])
  assert.deepEqual([props.canLinkSuppliers, props.workspaceCurrency], [true, 'USD'])
  assert.ok(built.refs.some((ref) => ref.type === 'supplier' && ref.id === 'SUP-003' && ref.label === 'Northstar Electronics'))
  // By its code too; an approved supplier named by a shorter name is that supplier, not a new one.
  const byCode = assertPart(await build('suggest_purchase_request', { source: 'toolu_lines', from: 'user_named', lines: [{ sku: 'LDM-001', supplier: 'ns-01' }] }), 'pr_form')
  assert.deepEqual(byCode.lines[0].supplier, { id: 'SUP-003', name: 'Northstar Electronics', source: 'user_named', link: 'new' })
  const acme = assertPart(await build('suggest_purchase_request', { source: 'toolu_lines', from: 'user_named', lines: [{ sku: 'LDM-001', supplier: 'Acme' }] }), 'pr_form')
  assert.deepEqual(acme.lines[0].supplier, { id: 'SUP-001', name: 'Acme Components', source: 'user_named' })
  assert.deepEqual(acme.lines[0].suppliers, [ACME_OPTION])
  // A shorter name two suppliers share is the user's to settle; an inactive one cannot be ordered from.
  assertError(await build('suggest_purchase_request', { source: 'toolu_lines', from: 'user_named', lines: [{ sku: 'LDM-001', supplier: 'Northstar' }] }), 'supplier_unclear')
  const inactive = await build('suggest_purchase_request', { source: 'toolu_lines', from: 'user_named', lines: [{ sku: 'LDM-001', supplier: 'Oldfield Parts' }] })
  assertError(inactive, 'supplier_not_listed')
  assert.match(inactive.error.message, /Oldfield Parts is inactive in this workspace/)
  // A supplier named in an item the user did not name is not looked up.
  const unnamed = await workspace({ change: northstar, userText })
  await unnamed.call('toolu_lines', 'suggest_purchase_lines', { skus: ['LDM-001'] })
  const plain = assertPart(unnamed.build('suggest_purchase_request', { source: 'toolu_lines', from: 'user_named', lines: [{ sku: 'LDM-001', supplier: 'Northstar Electronics' }] }), 'pr_form')
  assert.deepEqual(plain.suggested[0].supplier, { id: 'SUP-001', name: 'Acme Components', source: 'preferred' })
})

test('a new supplier carries the price, currency and lead time the user typed, and only those', async () => {
  const typed = await workspace({ change: northstar, userNamedSkus: ['LDM-001'], userText: 'Order 200 of LDM-001 from Northstar Electronics at €4.20 each, lead time 9 days' })
  await typed.call('toolu_lines', 'suggest_purchase_lines', { skus: ['LDM-001'] })
  const line = { sku: 'LDM-001', quantity: 200, supplier: 'Northstar Electronics', unitPrice: 4.2, currency: 'EUR', leadTimeDays: 9 }
  const [row] = assertPart(await typed.build('suggest_purchase_request', { source: 'toolu_lines', from: 'user_named', lines: [line] }), 'pr_form').lines
  assert.deepEqual(row.suppliers.at(-1), { id: 'SUP-003', name: 'Northstar Electronics', preferred: false, leadTimeDays: 9, unitPrice: 4.2, currency: 'EUR', link: 'new' })
  // The price is the user's to confirm in the form, not a reference price.
  assert.deepEqual(row.estimatedUnitPrice, { value: null, currency: null, source: 'missing' })
  const nineDays = new Date(Date.parse(`${typed.ctx.facts.today}T00:00:00Z`) + 9 * 86400000).toISOString().slice(0, 10)
  assert.deepEqual(row.needByDate, { value: nineDays, source: 'lead_time', leadTimeDays: 9, shortWeekOf: null })
  // A figure the user did not write goes back to the model.
  const made = await typed.build('suggest_purchase_request', { source: 'toolu_lines', from: 'user_named', lines: [{ ...line, unitPrice: 3.9, currency: 'USD' }] })
  assertError(made, 'not_typed')
  assert.match(made.error.message, /unitPrice 3\.9, currency "USD"/)
})

test('a user who may not add approved suppliers is told to ask a colleague, and an unknown supplier still lists the approved ones', async () => {
  const noLinks = await workspace({ change: northstar, userNamedSkus: ['LDM-001'], userText: 'order 200 of LDM-001 from Northstar Electronics', actor: (actor) => actor.permissionCodes.delete('master_data.item.manage') })
  await noLinks.call('toolu_lines', 'suggest_purchase_lines', { skus: ['LDM-001'] })
  const refused = await noLinks.build('suggest_purchase_request', { source: 'toolu_lines', from: 'user_named', lines: [{ sku: 'LDM-001', quantity: 200, supplier: 'Northstar Electronics' }] })
  assertError(refused, 'supplier_not_approved')
  assert.match(refused.error.message, /not an approved supplier of LDM-001 \(approved: Acme Components\)/)
  assert.match(refused.error.message, /a colleague with master data access can add Northstar Electronics as an approved supplier of LDM-001/)
  // Without that permission the form offers no other supplier.
  const props = assertPart(noLinks.build('suggest_purchase_request', { source: 'toolu_lines', from: 'user_named', lines: [{ sku: 'LDM-001', quantity: 200 }] }), 'pr_form')
  assert.deepEqual([props.canLinkSuppliers, props.workspaceCurrency], [false, undefined])
  const admin = await workspace({ change: northstar, userNamedSkus: ['LDM-001'], userText: 'order 200 of LDM-001 from Globex' })
  await admin.call('toolu_lines', 'suggest_purchase_lines', { skus: ['LDM-001'] })
  const unknown = await admin.build('suggest_purchase_request', { source: 'toolu_lines', from: 'user_named', lines: [{ sku: 'LDM-001', supplier: 'Globex' }] })
  assertError(unknown, 'supplier_not_listed')
  assert.equal(unknown.error.message, 'Globex is not among the approved suppliers the result lists for LDM-001 (Acme Components), nor a supplier of this workspace. Leave supplier out; the user can choose in the form.')
  // When the workspace's suppliers cannot be read, the approved ones are all there is.
  const offline = await tool('suggest_purchase_request').build({ source: 'toolu_lines', from: 'user_named', lines: [{ sku: 'LDM-001', supplier: 'Northstar Electronics' }] }, { ...admin.ctx, prisma: null })
  assertError(offline, 'supplier_not_listed')
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

test('show_records keeps the currency of every amount, whichever tool the record comes from', async () => {
  const { call, build } = await workspace()
  await call('toolu_po9', 'get_purchase_order', { order: 'PO-009' })
  const [order] = assertPart(build('show_records', { source: 'toolu_po9', refs: [{ type: 'purchase_order', id: 'PO-009' }] }), 'records').cards
  assert.deepEqual(order.figures, [{ code: 'remaining_quantity', value: 10, unit: 'quantity', unitLabel: 'pcs' }, { code: 'amount', value: 500, unit: 'money', currency: 'EUR' }])
  const risks = await call('toolu_risks', 'supplier_risks')
  const variance = risks.rows.find((row) => row.record === 'INV-001')
  const [invoice] = assertPart(build('show_records', { source: 'toolu_risks', refs: [variance.ref] }), 'records').cards
  assert.deepEqual(invoice.figures, [{ code: 'variance', value: variance.variance, unit: 'money', currency: variance.currency }])
  // An amount whose currency is not known is left out, never shown as a count.
  const { ctx } = await workspace()
  ctx.results.set('toolu_bare', { tool: 'supplier_risks', output: { rows: [{ supplier: 'Acme Components', type: 'invoice_variance', record: 'INV-001', variance: 200, ref: variance.ref }] } })
  const [bare] = assertPart(tool('show_records').build({ source: 'toolu_bare', refs: [variance.ref] }, ctx), 'records').cards
  assert.equal(bare.figures, undefined)
})

// An overdue list came back without its order numbers (2026-11-04): a
// table of records always leads with the column that names the record.
test('show_table puts the record column first when the model leaves it out', async () => {
  const { call, build } = await workspace()
  await call('toolu_po', 'list_purchase_orders', { status: 'overdue' })
  const props = assertPart(build('show_table', { source: 'toolu_po', columns: ['supplier', 'due_date', 'days_overdue'] }), 'table')
  assert.deepEqual(props.columns.map((column) => [column.code, column.kind]).slice(0, 2), [['order', 'ref'], ['supplier', 'text']])
  // Named by the model: nothing is added.
  const named = assertPart(build('show_table', { source: 'toolu_po', columns: ['order', 'days_overdue'] }), 'table')
  assert.deepEqual(named.columns.map((column) => column.code), ['order', 'days_overdue'])
})

test('supplier_risks rows keep their date in cards and tables', async () => {
  const { call, build } = await workspace()
  const risks = await call('toolu_risks', 'supplier_risks')
  const overdue = risks.rows.find((row) => row.record === 'PO-001')
  const open = risks.rows.find((row) => row.record === 'INV-001')
  const cards = assertPart(build('show_records', { source: 'toolu_risks', refs: [overdue.ref, open.ref] }), 'records').cards
  assert.deepEqual(cards.map((card) => card.date), [{ kind: 'overdue', days: overdue.when.days }, { kind: 'waiting', days: open.when.days }])
  const table = assertPart(build('show_table', { source: 'toolu_risks', columns: ['record', 'when'], sort: { column: 'when', direction: 'desc' } }), 'table')
  assert.deepEqual(table.columns, [{ code: 'record', kind: 'ref' }, { code: 'when', kind: 'date' }])
  const days = risks.rows.map((row) => row.when.date).sort().reverse()
  assert.deepEqual(table.rows.map((row) => row.when), days)
})

test('amounts and quantities recorded as decimal strings are shown, charted and carded as numbers', async () => {
  const { ctx } = await workspace()
  const build = (name, input) => tool(name).build(input, ctx)
  const purchase = (orderNumber, unitPrice, orderedQuantity, date) => ({ unitPrice, currency: 'USD', unit: 'pcs', orderedQuantity, date, orderNumber, supplierName: 'Acme Components', ref: { type: 'purchase_order', id: orderNumber, label: orderNumber } })
  ctx.results.set('toolu_prices', { tool: 'price_history', output: { sku: 'LDM-001', unit: 'pcs', currency: 'USD', earlier: [purchase('PO-001', '4.2000', '100.0000', '2026-08-01'), purchase('PO-002', '4.1500', '20.5000', '2026-09-01')] } })
  const table = assertPart(build('show_table', { source: 'toolu_prices', columns: ['orderNumber', 'unitPrice', 'orderedQuantity'], sort: { column: 'orderedQuantity' } }), 'table')
  assert.deepEqual(table.columns.map((column) => column.kind), ['ref', 'money', 'quantity'])
  assert.deepEqual(table.rows.map((row) => [row.order.id, row.unit_price, row.ordered_quantity]), [['PO-002', { amount: 4.15, currency: 'USD' }, 20.5], ['PO-001', { amount: 4.2, currency: 'USD' }, 100]])
  const chart = assertPart(build('show_chart', { source: 'toolu_prices', kind: 'line', x: 'date', series: ['unitPrice'] }), 'chart')
  assert.deepEqual([chart.unit, chart.currency, chart.series[0].values, chart.x.values], ['money', 'USD', [4.2, 4.15], ['2026-08-01', '2026-09-01']])
  const [card] = assertPart(build('show_records', { source: 'toolu_prices', refs: [{ type: 'purchase_order', id: 'PO-001' }] }), 'records').cards
  assert.deepEqual(card.figures, [{ code: 'unit_price', value: 4.2, unit: 'money', currency: 'USD' }])
  // Receivables aging buckets, as the finance service returns them.
  const bucket = (currency, amounts) => ({ currency, current: amounts[0], '1_30': amounts[1], '31_60': '0.00', '61_90': '0.00', '90_plus': '0.00', total: amounts[2], count: 2 })
  ctx.results.set('toolu_ar', { tool: 'list_receivables', output: { rows: [], aging: [bucket('USD', ['1200.00', '300.50', '1500.50'])] } })
  const aging = assertPart(build('show_chart', { source: 'toolu_ar', kind: 'bar', x: 'currency', series: ['current', '1_30', '31_60'], list: 'aging' }), 'chart')
  assert.deepEqual([aging.unit, aging.currency, aging.series.map((series) => series.values[0])], ['money', 'USD', [1200, 300.5, 0]])
  ctx.results.set('toolu_contracts', { tool: 'list_contracts', output: { rows: [{ number: 'CT-001', title: 'Frame agreement', totalValue: '12000.0000', currency: 'USD', ref: { type: 'contract', id: 'CT-001', label: 'CT-001' } }] } })
  const [contract] = assertPart(build('show_records', { source: 'toolu_contracts', refs: [{ type: 'contract', id: 'CT-001' }] }), 'records').cards
  assert.deepEqual(contract.figures, [{ code: 'total_value', value: 12000, unit: 'money', currency: 'USD' }])
})

test('columns of a list the result does not hold are refused with the lists it holds', async () => {
  const { ctx, call, build } = await workspace()
  // spend_analysis for one supplier holds items only; its suppliers list has the same keys.
  const spend = await call('toolu_acme', 'spend_analysis', { supplier: 'Acme' })
  assert.equal(spend.suppliers, undefined)
  const items = assertPart(build('show_table', { source: 'toolu_acme', columns: ['name', 'amount'] }), 'table')
  assert.deepEqual(items.rows.map((row) => [row.name, row.amount.amount]), spend.items.map((row) => [row.name, row.amount]))
  assert.equal(assertPart(build('show_chart', { source: 'toolu_acme', kind: 'bar', x: 'name', series: ['amount'] }), 'chart').series[0].values.length, spend.items.length)
  const named = build('show_table', { source: 'toolu_acme', columns: ['name', 'amount'], list: 'suppliers' })
  assertError(named, 'list_missing')
  assert.match(named.error.message, /no list suppliers; it holds items/)
  // A result kept in its envelope holds no list at all: never an empty table.
  ctx.results.set('toolu_wrapped', { tool: 'list_purchase_orders', output: { ok: true, result: { rows: [] } } })
  assertError(build('show_table', { source: 'toolu_wrapped', columns: ['orderNumber'] }), 'list_missing')
  assertError(build('show_chart', { source: 'toolu_wrapped', kind: 'bar', x: 'orderNumber', series: ['remaining'] }), 'list_missing')
})

test('suggest_purchase_request treats a reference price without a currency as missing', async () => {
  for (const currency of [null, 'usd']) {
    const { call, build } = await workspace()
    const output = await call('toolu_lines', 'suggest_purchase_lines')
    output.rows[0].estimatedUnitPrice.currency = currency
    for (const entry of output.rows[0].approvedSuppliers) entry.currency = currency
    const [row] = assertPart(build('suggest_purchase_request', { source: 'toolu_lines', from: 'suggestions' }), 'pr_form').suggested
    assert.deepEqual(row.estimatedUnitPrice, { value: null, currency: null, source: 'missing' })
    assert.ok(row.suppliers.every((supplier) => supplier.unitPrice === null && supplier.currency === null))
  }
})

test('suggest_purchase_request lists every approved supplier and keeps another one the user named, with its own figures', async () => {
  const second = { id: 'ITEM-001::SUP-002', payload: { itemId: 'ITEM-001', supplierId: 'SUP-002', preferred: false, active: true, approved: true, leadTimeDays: 5, referencePrice: 80, currency: 'USD' } }
  const { ctx, call, build } = await workspace({ supplierLinks: [link(), second], userNamedSkus: ['LDM-001'] })
  await call('toolu_lines', 'suggest_purchase_lines', { skus: ['LDM-001'] })
  const [plain] = assertPart(build('suggest_purchase_request', { source: 'toolu_lines', from: 'user_named', lines: [{ sku: 'LDM-001' }] }), 'pr_form').lines
  assert.deepEqual(plain.supplier, { id: 'SUP-001', name: 'Acme Components', source: 'preferred' })
  assert.deepEqual(plain.suppliers, [
    { id: 'SUP-001', name: 'Acme Components', preferred: true, leadTimeDays: 12, unitPrice: 95, currency: 'USD' },
    { id: 'SUP-002', name: 'Summit Packaging', preferred: false, leadTimeDays: 5, unitPrice: 80, currency: 'USD' },
  ])
  const [picked] = assertPart(build('suggest_purchase_request', { source: 'toolu_lines', from: 'user_named', lines: [{ sku: 'LDM-001', quantity: 120, supplier: 'Summit Packaging' }] }), 'pr_form').lines
  assert.deepEqual(picked.supplier, { id: 'SUP-002', name: 'Summit Packaging', source: 'user_named' })
  assert.deepEqual(picked.estimatedUnitPrice, { value: 80, currency: 'USD', source: 'reference_price' })
  const fiveDays = new Date(Date.parse(`${ctx.facts.today}T00:00:00Z`) + 5 * 86400000).toISOString().slice(0, 10)
  assert.deepEqual(picked.needByDate, { value: fiveDays, source: 'lead_time', leadTimeDays: 5, shortWeekOf: null })
  assert.equal(picked.checked, true)
})

test('show_setup_steps shows the checklist of a setup_status result, linking only open steps the user may do', async () => {
  const { call, build } = await workspace({ env: { FLOWCHAIN_ENABLE_DATA_IMPORT: 'true', FLOWCHAIN_PERSISTENCE_MODE: 'database' } })
  await call('toolu_setup', 'setup_status')
  const props = assertPart(build('show_setup_steps', { source: 'setup_status#1' }), 'setup_steps')
  assert.deepEqual(props.steps.map((step) => [step.id, step.done, step.count, step.route || null]), [
    ['items', true, 3, null], ['suppliers', true, 2, null], ['customers', false, 0, { moduleId: 'master-data:import', query: { type: 'customers' } }],
    ['opening_stock', true, 2, null], ['teammates', false, 0, { moduleId: 'settings:roles' }],
  ])
  assert.deepEqual([props.done, props.total, props.source], [3, 5, 'toolu_setup'])
  assert.deepEqual(props.gaps, { checked: 3, unit: 1, preferredSupplier: 1, thresholds: 1 })
  await call('toolu_po', 'list_purchase_orders')
  assertError(build('show_setup_steps', { source: 'list_purchase_orders#1' }), 'wrong_source')
  // A step the role may not do shows without a link.
  const viewer = await workspace({ roleKey: 'read-only-viewer' })
  await viewer.call('toolu_setup', 'setup_status')
  const blocked = assertPart(viewer.build('show_setup_steps', { source: 'setup_status' }), 'setup_steps')
  assert.ok(blocked.steps.every((step) => !step.route && step.blocked === 'permission'))
})

// Rows a user pasted, and the card's input for them as the model passes it.
const PASTED = [
  'Please add these suppliers:',
  'Northwind Metals, contact Dana Lee, sales@northwind.example, +1 555 0100, Net 30',
  'Acme Components',
  'Blue Fastener Co, code BF-01, terms Net 90',
  'And these items:',
  'BOLT-M8 Hex bolt M8, box, safety stock 20, reorder point 40, from Northwind Metals at 12.50 USD, lead time 7 days',
  'LDM-001 Flow Controller',
  'NUT-M8 Hex nut M8, box, from Acme Components',
  'WASHER-10 Washer, pcs, price 3',
  'PIN-4 Cotter pin, pcs, from Nobody Ltd',
].join('\n')
const SETUP_INPUT = {
  suppliers: [
    { name: 'Northwind Metals', contact: 'Dana Lee', email: 'sales@northwind.example', phone: '+1 555 0100', paymentTerms: 'Net 30' },
    { name: 'Acme Components' },
    { name: 'Blue Fastener Co', code: 'BF-01', paymentTerms: 'Net 90' },
  ],
  items: [
    { sku: 'BOLT-M8', name: 'Hex bolt M8', unit: 'box', safetyStock: 20, reorderPoint: 40, preferredSupplier: 'Northwind Metals', referencePrice: 12.5, currency: 'USD', leadTimeDays: 7 },
    { sku: 'LDM-001', name: 'Flow Controller' },
    { sku: 'NUT-M8', name: 'Hex nut M8', unit: 'box', preferredSupplier: 'Acme Components' },
    { sku: 'WASHER-10', name: 'Washer', unit: 'pcs', referencePrice: 3 },
    { sku: 'PIN-4', name: 'Cotter pin', unit: 'pcs', preferredSupplier: 'Nobody Ltd' },
  ],
}
const problemsOf = (row) => row.problems.map((entry) => `${entry.field}:${entry.code}:${entry.blocking ? 'block' : 'warn'}${entry.ref ? `:${entry.ref.id}` : ''}`)

test('suggest_setup_records shows the rows the user gave with where each value came from, and marks what is wrong with each', async () => {
  const { build } = await workspace({ userText: PASTED })
  const built = await build('suggest_setup_records', SETUP_INPUT)
  const props = assertPart(built, 'setup_form')
  assert.equal(props.formId, 'thr_7f2c:msg_19:p2')
  const [northwind, acme, blue] = props.suppliers
  assert.deepEqual([northwind.name, northwind.code, northwind.email, northwind.paymentTerms], [
    { value: 'Northwind Metals', source: 'user_typed' }, { value: null, source: 'generated' }, { value: 'sales@northwind.example', source: 'user_typed' },
    { value: 'NET30', label: 'Net 30', typed: 'Net 30', source: 'user_typed' },
  ])
  assert.deepEqual(problemsOf(northwind), [])
  // An existing supplier by name blocks its row; a payment term the workspace lacks is only a warning.
  assert.deepEqual(problemsOf(acme), ['name:duplicate_existing:block:SUP-001'])
  assert.deepEqual(blue.code, { value: 'BF-01', source: 'user_typed' })
  assert.deepEqual(problemsOf(blue), ['payment_terms:payment_terms_unknown:warn'])
  assert.deepEqual(blue.paymentTerms, { value: null, label: null, typed: 'Net 90', source: 'user_typed' })
  // The next free code comes after the workspace's SUP-001 and SUP-002.
  assert.deepEqual(props.codeSeed, { prefix: 'SUP-', next: 3, width: 3 })
  const [bolt, ldm, nut, washer, pin] = props.items
  assert.deepEqual(bolt.preferredSupplier, { supplierId: null, rowKey: 's1', name: 'Northwind Metals', typed: 'Northwind Metals', source: 'user_typed' })
  assert.deepEqual([bolt.referencePrice, bolt.leadTimeDays, bolt.currency, bolt.category], [{ value: 12.5, source: 'user_typed' }, { value: 7, source: 'user_typed' }, { value: 'USD', source: 'user_typed' }, { value: null, source: 'not_given' }])
  assert.deepEqual(problemsOf(bolt), [])
  // A SKU in use blocks; the same name only warns; a unit is asked for, never assumed.
  assert.deepEqual(problemsOf(ldm), ['sku:duplicate_existing:block:ITEM-001', 'name:duplicate_existing:warn:ITEM-001', 'unit:required:block'])
  assert.deepEqual(ldm.unit, { value: null, source: 'not_given' })
  // A supplier the card repeats is the existing one; its price would be in the workspace currency.
  assert.deepEqual(nut.preferredSupplier, { supplierId: 'SUP-001', rowKey: null, name: 'Acme Components', typed: 'Acme Components', source: 'user_typed' })
  assert.deepEqual(nut.currency, { value: 'USD', source: 'default' })
  assert.deepEqual(problemsOf(washer), ['reference_price:needs_supplier:block'])
  assert.deepEqual(problemsOf(pin), ['preferred_supplier:supplier_unknown:block'])
  assert.deepEqual(props.paymentTerms, [{ code: 'DUE', label: 'Due on receipt' }, { code: 'NET30', label: 'Net 30' }])
  assert.deepEqual(props.supplierOptions.map((option) => option.id), ['SUP-001', 'SUP-002'])
  assert.deepEqual([props.workspaceCurrency, props.canCreateSuppliers, props.canCreateItems], ['USD', true, true])
  assert.deepEqual(built.refs.map((entry) => `${entry.type}:${entry.id}`), ['supplier:SUP-001', 'item:ITEM-001'])
})

test('suggest_setup_records takes only values in the words the user wrote, at most 25 rows, and checks numbers and duplicates in the card', async () => {
  const { build } = await workspace({ userText: PASTED })
  const made = await build('suggest_setup_records', { items: [{ sku: 'BOLT-M9', name: 'Hex bolt M8', unit: 'box', reorderPoint: 45 }] })
  assertError(made, 'not_typed')
  assert.match(made.error.message, /items\[0\]\.sku "BOLT-M9", items\[0\]\.reorderPoint 45/)
  assertError(await build('suggest_setup_records', { suppliers: [{ name: 'Northwind Metals', paymentTerms: 'Net 45' }] }), 'not_typed')
  assertError(await build('suggest_setup_records', {}), 'invalid_input')
  const many = Array.from({ length: 13 }, () => ({ name: 'Northwind Metals' }))
  assertError(await build('suggest_setup_records', { suppliers: many, items: many.map(() => ({ sku: 'NUT-M8', name: 'Hex nut M8' })) }), 'too_many_rows')
  // A currency sign stands for its code.
  const signed = await workspace({ userText: 'HOSE-1 Garden hose, pcs, $4.20 from Acme Components, safety stock -5, lead time 2.5 days, and HOSE-1 again' })
  const props = assertPart(await signed.build('suggest_setup_records', { items: [
    { sku: 'HOSE-1', name: 'Garden hose', unit: 'pcs', referencePrice: 4.2, currency: 'USD', preferredSupplier: 'Acme Components', safetyStock: -5, leadTimeDays: 2.5 },
    { sku: 'hose-1', name: 'Garden hose', unit: 'pcs' },
  ] }), 'setup_form')
  assert.deepEqual(problemsOf(props.items[0]), ['safety_stock:negative:block', 'lead_time_days:whole_number:block'])
  assert.deepEqual(problemsOf(props.items[1]), ['sku:duplicate_in_card:block', 'name:duplicate_in_card:warn'])
})

test('the setup card is offered only to a role that may add suppliers or items, and only for what it may add', async () => {
  const viewer = await workspace({ roleKey: 'read-only-viewer', userText: PASTED })
  assert.ok(!aiUiToolsFor(viewer.ctx.actor).some((entry) => entry.name === 'suggest_setup_records'))
  assertError(await viewer.build('suggest_setup_records', SETUP_INPUT), 'not_allowed')
  const itemsOnly = await workspace({ userText: PASTED, actor: (actor) => actor.permissionCodes.delete('master_data.supplier.manage') })
  assert.ok(aiUiToolsFor(itemsOnly.ctx.actor).some((entry) => entry.name === 'suggest_setup_records'))
  assertError(await itemsOnly.build('suggest_setup_records', SETUP_INPUT), 'not_allowed')
  const props = assertPart(await itemsOnly.build('suggest_setup_records', { items: SETUP_INPUT.items.slice(2, 3) }), 'setup_form')
  assert.deepEqual([props.canCreateSuppliers, props.canCreateItems], [false, true])
  // Without the workspace's records nothing is shown.
  const offline = await workspace({ userText: PASTED })
  assertError(await tool('suggest_setup_records').build(SETUP_INPUT, { ...offline.ctx, prisma: null }), 'setup_unavailable')
})

// A live re-check on 2026-11-05: the model named columns by the display
// strings it read (amountText, statusLabel) and both tables failed; units read
// "300 box" in English and Chinese; a described item stayed unticked.
test('a column named by its display string or label is the value\'s own column', async () => {
  const { call, build } = await workspace()
  await call('toolu_po', 'list_purchase_orders')
  const props = assertPart(build('show_table', { source: 'toolu_po', columns: ['orderNumber', 'statusLabel', 'dueDateText', 'amountText', 'remainingText'] }), 'table')
  assert.deepEqual(props.columns.map((column) => column.code), ['order', 'status', 'due_date', 'amount', 'remaining_quantity'])
  assertError(build('show_table', { source: 'toolu_po', columns: ['orderNumber', 'priceText'] }), 'unknown_column')
})

test('a quantity\'s unit is worded in the answer\'s language and number', async () => {
  const { ctx, call, build } = await workspace()
  await call('toolu_po', 'list_purchase_orders')
  const en = assertPart(build('show_table', { source: 'toolu_po', columns: ['orderNumber', 'remaining'] }), 'table')
  assert.ok(en.rows.every((row) => row.unit === 'pcs'))
  ctx.language = 'zh-CN'
  const zh = assertPart(build('show_table', { source: 'toolu_po', columns: ['orderNumber', 'remaining'] }), 'table')
  assert.ok(zh.rows.every((row) => row.unit === '件'), JSON.stringify(zh.rows[0]))
})

test('an item the user described in their own words and the model resolved arrives ticked', async () => {
  const { ctx, call, build } = await workspace()
  await call('toolu_lines', 'suggest_purchase_lines', { skus: ['LDM-002'] })
  ctx.question = '我需要 50 个温度传感器'
  const typed = assertPart(build('suggest_purchase_request', { source: 'toolu_lines', from: 'user_named', lines: [{ sku: 'LDM-002', quantity: 50 }] }), 'pr_form')
  assert.deepEqual(typed.lines.map((row) => [row.item.sku, row.checked, row.suggestedQuantity.value, row.suggestedQuantity.source]), [['LDM-002', true, 50, 'user_named']])
  // One item described without a quantity: ticked, with the server's quantity.
  ctx.question = '帮我买温度传感器'
  const plain = assertPart(build('suggest_purchase_request', { source: 'toolu_lines', from: 'user_named', lines: [{ sku: 'LDM-002', quantity: 999 }] }), 'pr_form')
  assert.equal(plain.lines[0].checked, true)
  assert.notEqual(plain.lines[0].suggestedQuantity.value, 999)
  // From suggestions nothing is ticked.
  const suggested = assertPart(build('suggest_purchase_request', { source: 'toolu_lines', from: 'suggestions' }), 'pr_form')
  assert.equal(suggested.lines.length, 0)
})

test('an attention item\'s details are columns of their own', async () => {
  const { call, build } = await workspace()
  await call('toolu_attention', 'attention_list', { limit: 10 })
  const props = assertPart(build('show_table', { source: 'toolu_attention', columns: ['label', 'type', 'details.remaining', 'details.shortage'] }), 'table')
  assert.deepEqual(props.columns.map((column) => [column.code, column.kind]), [['label', 'ref'], ['type', 'status'], ['remaining_quantity', 'quantity'], ['shortage', 'quantity']])
  assert.ok(props.rows.some((row) => typeof row.remaining_quantity === 'number' && row.unit === 'pcs'), JSON.stringify(props.rows))
})

// ---------------------------------------------------------------- record actions

// The purchase requests and orders the record card reads as stored, behind
// the fixture's read-only client: another workspace finds none.
const TENANT = 'tenant-ai-skills'
function withStoredRecords(base, { requests = {}, orders = {}, rfqs = [] } = {}) {
  const reads = []
  const mine = (where) => where.tenantId === TENANT
  const extra = {
    purchaseRequest: { findFirst: async ({ where }) => { reads.push(['purchaseRequest', where]); return mine(where) ? structuredClone(requests[where.id] || null) : null } },
    purchaseOrder: {
      findFirst: async ({ where }) => {
        reads.push(['purchaseOrder', where])
        if (!mine(where)) return null
        if (where.sourceRequestId) return Object.values(orders).find((row) => row.sourceRequestId === where.sourceRequestId && row.status !== where.status.not) || null
        return structuredClone(orders[where.id] || null)
      },
    },
    rfq: { findFirst: async ({ where }) => (mine(where) ? rfqs.find((row) => row.sourceRequestId === where.sourceRequestId && !where.status.notIn.includes(row.status)) || null : null) },
  }
  return { reads, prisma: new Proxy({}, { get: (_target, model) => extra[model] || base[model] }) }
}

const requestLine = (over = {}) => ({
  id: 'PRL-1', sku: 'LDM-002', itemName: 'Temperature Sensor', quantity: '300', unit: 'pcs', unitPrice: '4', amount: '1200',
  metadata: { supplierId: 'SUP-005', currency: 'USD', targetWarehouseId: 'WH-1', supplierSnapshot: { supplierName: 'Northstar Electronics' } },
  ...over,
})
const storedRequest = (id, status, over = {}) => ({
  id, tenantId: TENANT, status, requester: 'procurement-specialist-user', supplierId: 'SUP-005', supplierName: 'Northstar Electronics',
  amount: '1200', currency: 'USD', metadata: { version: 3 }, lines: [requestLine()], ...over,
})
const storedOrder = (id, status, over = {}) => ({
  id, tenantId: TENANT, status, version: 4, supplierId: 'SUP-001', supplierName: 'Acme Components', amount: '12000', currency: 'USD', metadata: { orderNumber: id },
  lines: [{ id: `${id}-L1`, sku: 'LDM-001', itemName: 'Flow Controller', orderedQuantity: '120', unit: 'pcs', unitPrice: '100', amount: '12000', metadata: {} }], ...over,
})

// A workspace whose open requests include the stored ones (as `listed`, when
// the list read them in another status), the card's reads behind it, and the
// list results its refs come from.
async function recordCard({ roleKey = 'workspace-administrator', requests = {}, orders = {}, rfqs = [], actor = null } = {}) {
  const ws = await workspace({
    roleKey, actor,
    change: (data) => {
      for (const row of Object.values(requests)) {
        if (data.purchaseRequests.some((entry) => entry.id === row.id)) continue
        data.purchaseRequests.push({ id: row.id, pr: row.id, status: row.listed || row.status, priority: 'high', requiredDate: null, currency: 'USD', lines: [{ id: 'L1', sku: 'LDM-002', itemId: 'ITEM-002', quantity: 300, unit: 'pcs' }] })
      }
    },
  })
  const stored = withStoredRecords(ws.ctx.prisma, { requests, orders, rfqs })
  ws.ctx.prisma = stored.prisma
  await ws.call('tu_pr', 'list_purchase_requests', { limit: 50 })
  await ws.call('tu_po', 'list_purchase_orders', { status: 'all', limit: 50 })
  const offer = (type, id, source = type === 'purchase_order' ? 'list_purchase_orders#1' : 'list_purchase_requests#1') => tool('offer_record_actions').build({ source, ref: { type, id } }, ws.ctx)
  return { ...ws, reads: stored.reads, offer }
}

test('the record card steps follow the commands\' own status rules', () => {
  const targets = { submit: 'submitted', approve: 'approved', reject: 'rejected', create_po: 'converted' }
  for (const [step, from] of Object.entries(RECORD_ACTION_RULES.purchase_request)) {
    if (step === 'create_rfq') assert.equal(from, 'approved')
    else assert.ok(PR_TRANSITIONS[from].includes(targets[step]), `${step} from ${from}`)
  }
  for (const [step, from] of Object.entries(RECORD_ACTION_RULES.purchase_order)) assert.deepEqual(PURCHASE_ORDER_COMMANDS[step].from, [from], step)
  assert.deepEqual(recordActionsNow({ type: 'purchase_request', status: 'approved', allowed: ['create_po', 'create_rfq'], path: { recommendation: 'rfq' } }), ['create_rfq', 'create_po'])
  assert.deepEqual(recordActionsNow({ type: 'purchase_request', status: 'approved', allowed: ['create_po', 'create_rfq'], path: { recommendation: 'direct_po' } }), ['create_po'])
  assert.deepEqual(recordActionsNow({ type: 'purchase_request', status: 'approved', allowed: ['create_po', 'create_rfq'], path: { recommendation: 'direct_po' }, poBlocked: 'lines_incomplete' }), [])
})

test('the record card offers the steps this user may take now, by status and role, from the record as stored', async () => {
  const requests = {
    'PR-0231': storedRequest('PR-0231', 'submitted'),
    'PR-0232': storedRequest('PR-0232', 'draft', { requester: 'workspace-administrator-user' }),
    'PR-0233': storedRequest('PR-0233', 'draft'),
    'PR-0234': storedRequest('PR-0234', 'approved'),
  }
  const orders = { 'PO-006': storedOrder('PO-006', 'pending_approval'), 'PO-009': storedOrder('PO-009', 'approved', { supplierName: 'Summit Packaging', currency: 'EUR', amount: '500' }) }
  const admin = await recordCard({ requests, orders })
  // Submitted: the approver approves or rejects; submitting is only the requester's.
  const pending = assertPart(await admin.offer('purchase_request', 'PR-0231'), 'record_actions')
  assert.deepEqual(pending.actions, ['approve', 'reject'])
  assert.ok(!pending.allowed.includes('submit'))
  assert.equal(pending.cardId, 'thr_7f2c:msg_19:p2')
  assert.deepEqual(pending.record, {
    ref: { type: 'purchase_request', id: 'PR-0231', label: 'PR-0231' }, type: 'purchase_request', status: 'submitted', version: 3, suppliers: ['Northstar Electronics'],
    lines: [{ sku: 'LDM-002', name: 'Temperature Sensor', quantity: 300, unit: 'pcs' }], lineCount: 1, amount: { amount: 1200, currency: 'USD' },
  })
  assert.deepEqual(assertPart(await admin.offer('purchase_request', 'PR-0232'), 'record_actions').actions, ['submit'])
  const notMine = await admin.offer('purchase_request', 'PR-0233')
  assertError(notMine, 'not_allowed')
  assert.match(notMine.error.message, /its requester/)
  // Approved: the path the recommendation route gives; a purchase order directly.
  const approved = assertPart(await admin.offer('purchase_request', 'PR-0234'), 'record_actions')
  assert.deepEqual([approved.actions, approved.path], [['create_po'], { recommendation: 'direct_po', reasons: ['direct_po_ok'] }])
  // Orders: approve one waiting for approval, mark an approved one issued.
  assert.deepEqual(assertPart(await admin.offer('purchase_order', 'PO-006'), 'record_actions').actions, ['approve'])
  const issue = assertPart(await admin.offer('purchase_order', 'PO-009'), 'record_actions')
  assert.deepEqual([issue.actions, issue.record.ref.label, issue.record.amount], [['issue'], 'PO-009', { amount: 500, currency: 'EUR' }])
  assertError(await admin.offer('purchase_order', 'PO-002'), 'record_unavailable')
  // Every read is in the user's workspace.
  assert.ok(admin.reads.every(([, where]) => where.tenantId === TENANT))

  // A buyer submits their own drafts and orders approved requests, but approves nothing.
  const buyer = await recordCard({ roleKey: 'procurement-specialist', requests, orders })
  assert.deepEqual(assertPart(await buyer.offer('purchase_request', 'PR-0233'), 'record_actions').actions, ['submit'])
  const waiting = await buyer.offer('purchase_request', 'PR-0231')
  assertError(waiting, 'not_allowed')
  assert.match(waiting.error.message, /a manager or administrator whose role may approve/)
  assert.deepEqual(assertPart(await buyer.offer('purchase_request', 'PR-0234'), 'record_actions').actions, ['create_po'])
  assertError(await buyer.offer('purchase_order', 'PO-006'), 'not_allowed')
  assert.deepEqual(assertPart(await buyer.offer('purchase_order', 'PO-009'), 'record_actions').actions, ['issue'])
})

test('an approved request: quotes first when the route recommends them, no order without complete lines or once one exists', async () => {
  const requests = {
    'PR-0241': storedRequest('PR-0241', 'approved', { amount: '150000' }),
    'PR-0242': storedRequest('PR-0242', 'approved', { lines: [requestLine({ metadata: { supplierId: 'SUP-005', currency: 'USD', supplierSnapshot: { supplierName: 'Northstar Electronics' } } })] }),
    'PR-0243': storedRequest('PR-0243', 'approved', { supplierId: null, supplierName: null, lines: [requestLine({ metadata: { currency: 'USD', targetWarehouseId: 'WH-1' } })] }),
    'PR-0244': storedRequest('PR-0244', 'approved'),
    // Listed as approved, ordered since: the card goes by the record as stored.
    'PR-0245': storedRequest('PR-0245', 'converted', { listed: 'approved' }),
  }
  const orders = { 'PO-7A1B': storedOrder('PO-7A1B', 'approved', { sourceRequestId: 'PR-0244' }) }
  const card = await recordCard({ requests, orders })
  const quotes = assertPart(await card.offer('purchase_request', 'PR-0241'), 'record_actions')
  assert.deepEqual([quotes.actions, quotes.path], [['create_rfq', 'create_po'], { recommendation: 'rfq', reasons: ['amount_over_rfq_threshold'] }])
  // No delivery warehouse on a line: the route would refuse the order.
  const incomplete = await card.offer('purchase_request', 'PR-0242')
  assertError(incomplete, 'nothing_to_offer')
  assert.match(incomplete.error.message, /supplier, a currency and a delivery warehouse/)
  // No supplier chosen: quotes are recommended, and only they can be requested.
  const noSupplier = assertPart(await card.offer('purchase_request', 'PR-0243'), 'record_actions')
  assert.deepEqual([noSupplier.actions, noSupplier.path.reasons, noSupplier.poBlocked], [['create_rfq'], ['supplier_not_selected'], 'lines_incomplete'])
  assertError(await card.offer('purchase_request', 'PR-0244'), 'nothing_to_offer')
  const converted = await card.offer('purchase_request', 'PR-0245')
  assertError(converted, 'nothing_to_offer')
  assert.match(converted.error.message, /PR-0245 is converted/)
  // A role that cannot see amounts gets no amount, and no amount reason.
  const masked = await recordCard({ requests, orders, actor: (actor) => actor.permissionCodes.delete('procurement.prices.read') })
  const hidden = assertPart(await masked.offer('purchase_request', 'PR-0241'), 'record_actions')
  assert.equal(hidden.record.amount, undefined)
  assert.deepEqual(hidden.path, { recommendation: 'rfq', reasons: [] })
})

test('the record card is not offered to a viewer, and takes only a request or order ref of the named result', async () => {
  const requests = { 'PR-0231': storedRequest('PR-0231', 'submitted') }
  const viewer = await recordCard({ roleKey: 'read-only-viewer', requests })
  assert.ok(!aiUiToolsFor(viewer.ctx.actor).some((entry) => entry.name === 'offer_record_actions'))
  const refused = await viewer.offer('purchase_request', 'PR-0231')
  assertError(refused, 'not_allowed')
  assert.match(refused.error.message, /a manager approves them/)
  assert.deepEqual(viewer.reads, [])
  const admin = await recordCard({ requests })
  assert.ok(aiUiToolsFor(admin.ctx.actor).some((entry) => entry.name === 'offer_record_actions'))
  assertError(await admin.offer('purchase_request', 'PR-0999'), 'foreign_ref')
  assertError(await admin.offer('purchase_order', 'PR-0231', 'list_purchase_requests#1'), 'foreign_ref')
  assertError(await tool('offer_record_actions').build({ source: 'list_purchase_requests#1', ref: { type: 'item', id: 'ITEM-001' } }, admin.ctx), 'wrong_ref_type')
  assertError(await admin.offer('purchase_request', 'PR-0231', 'list_purchase_requests#2'), 'source_missing')
  // Without the workspace's records nothing is shown.
  assertError(await tool('offer_record_actions').build({ source: 'list_purchase_requests#1', ref: { type: 'purchase_request', id: 'PR-0231' } }, { ...admin.ctx, prisma: null }), 'record_unavailable')
})

// 2026-11-11 on Flash: for "帮我下个单" and "What should I reorder this week?"
// the item the model picked was ticked as if the user had named it.
test('a question of ordering words, the time and politeness names no item', () => {
  for (const question of ['帮我下个单', '帮我下个单吧', 'What should I reorder this week?', 'Place an order for me please', '这周需要补什么货？', 'Order something']) assert.equal(namesAnItem(question), false, question)
  for (const question of ['Order 100 cakestands', '帮我订 60 个蛋糕架', '订一些温度传感器', 'Order more 85123A', 'I need bird ornaments']) assert.equal(namesAnItem(question), true, question)
})

// 2026-11-11 on Flash: "add 150 of 84879 too" after "Order 100 cakestands"
// showed the cakestand at the suggested quantity, unticked, while the text said 100.
test('adding to a form keeps a line of the latest form at the quantity the user typed earlier', async () => {
  const { ctx, call, build } = await workspace({ userNamedSkus: ['LDM-002'], userText: 'add 30 of LDM-002 too\nOrder 100 of LDM-001', lastFormSkus: ['ldm-001'] })
  ctx.question = 'add 30 of LDM-002 too'
  await call('toolu_lines', 'suggest_purchase_lines', { skus: ['LDM-001', 'LDM-002'] })
  const form = assertPart(build('suggest_purchase_request', { source: 'toolu_lines', from: 'user_named', lines: [{ sku: 'LDM-001', quantity: 100 }, { sku: 'LDM-002', quantity: 30 }] }), 'pr_form')
  const line = (sku) => [...form.lines, ...form.suggested].find((row) => row.item.sku === sku)
  assert.deepEqual([line('LDM-001').suggestedQuantity, form.lines.some((row) => row.item.sku === 'LDM-001')], [{ value: 100, source: 'user_named' }, true])
  assert.equal(line('LDM-002').suggestedQuantity.value, 30)
  // A quantity nobody typed for an item of the latest form stays the server's suggestion.
  const other = assertPart(build('suggest_purchase_request', { source: 'toolu_lines', from: 'user_named', lines: [{ sku: 'LDM-001', quantity: 77 }, { sku: 'LDM-002', quantity: 30 }] }), 'pr_form')
  assert.notEqual([...other.lines, ...other.suggested].find((row) => row.item.sku === 'LDM-001').suggestedQuantity.value, 77)
})
