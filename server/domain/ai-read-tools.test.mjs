import test from 'node:test'
import assert from 'node:assert/strict'
import { aiSkillScenario } from './test-fixtures/ai-skill-scenario.mjs'
import { loadAiSkillContext } from './ai-skill-context.mjs'
import { readAiSkillFacts } from './ai-skill-readers.mjs'
import { validateAiToolArgs, aiToolList, AI_TOOL_LIMITS } from './ai-read-tool-contract.mjs'
import { AI_READ_TOOLS } from './ai-read-tools.mjs'
import { aiReadToolDefinitions, aiReadToolRefs, aiReadToolsFor, runAiReadTool } from './ai-read-tool-runner.mjs'

async function factsFor(roleKey = 'workspace-administrator') {
  const scenario = aiSkillScenario({ roleKey })
  return readAiSkillFacts(await loadAiSkillContext(scenario.ctx))
}

// Every tool the role is offered, called with no arguments (and the tools
// that need one with a record the fixture has), as one JSON string.
async function everyOutput(facts) {
  const outputs = []
  for (const tool of aiReadToolsFor(facts)) {
    const args = tool.name === 'get_purchase_order' ? { order: 'PO-001' } : tool.name === 'calculate' ? { operation: 'sum', values: [1, 2] } : {}
    outputs.push(await runAiReadTool(tool.name, args, { facts }))
  }
  for (const kind of ['rejected', 'unposted', 'recent']) if (facts.receipts) outputs.push(await runAiReadTool('list_receipts', { kind }, { facts }))
  for (const kind of ['differences', 'recent']) if (facts.invoices) outputs.push(await runAiReadTool('list_supplier_invoices', { kind }, { facts }))
  return JSON.stringify(outputs)
}

test('an administrator is offered every read tool, and each answers with capped rows and record refs', async () => {
  const facts = await factsFor()
  assert.deepEqual(aiReadToolsFor(facts).map((tool) => tool.name), AI_READ_TOOLS.map((tool) => tool.name))
  const overdue = await runAiReadTool('list_purchase_orders', { status: 'overdue' }, { facts })
  assert.equal(overdue.ok, true)
  assert.equal(overdue.result.total, facts.purchaseOrders.overdue)
  // Most overdue first: the date rule, never a score.
  const days = overdue.result.rows.map((row) => row.overdueDays)
  assert.deepEqual(days, [...days].sort((a, b) => b - a))
  assert.ok(overdue.result.rows.every((row) => row.ref.type === 'purchase_order' && row.ref.label === row.orderNumber))
  // A number's end finds the order, whatever its case.
  const order = await runAiReadTool('get_purchase_order', { order: 'po-001' }, { facts })
  assert.equal(order.result.order.orderNumber, 'PO-001')
  assert.ok(order.result.openLines.length > 0)
  assert.deepEqual(await runAiReadTool('get_purchase_order', { order: 'PO-999' }, { facts }), { ok: false, error: 'not_found' })
  // The late order impact judges a named order on its own.
  const impact = await runAiReadTool('late_order_impact', { orders: ['PO-001'] }, { facts })
  assert.equal(impact.result.judged, 'each named order on its own')
  assert.deepEqual(impact.result.orders.map((row) => row.orderNumber), ['PO-001'])
  // Spend shares are percents, as an answer would write them.
  const spend = await runAiReadTool('spend_analysis', {}, { facts })
  assert.ok(spend.result.suppliers.every((row) => row.sharePercent > 0 && row.sharePercent <= 100))
  assert.ok(aiReadToolRefs(spend.result).every((ref) => ref.type === 'supplier'))
})

test('arguments are checked against the schema before a tool runs', async () => {
  const facts = await factsFor()
  const bad = async (name, args) => (await runAiReadTool(name, args, { facts })).error
  assert.equal(await bad('list_purchase_orders', { status: 'late' }), 'invalid_arguments')
  assert.equal(await bad('list_purchase_orders', { status: 'open', extra: true }), 'invalid_arguments')
  assert.equal(await bad('list_purchase_orders', { limit: 0 }), 'invalid_arguments')
  assert.equal(await bad('list_purchase_orders', { limit: 2.5 }), 'invalid_arguments')
  assert.equal(await bad('get_purchase_order', {}), 'invalid_arguments')
  assert.equal(await bad('spend_analysis', { currency: 'dollars' }), 'invalid_arguments')
  assert.equal(await bad('calculate', { operation: 'days_between', dates: ['28/10/2026', '2026-11-01'] }), 'invalid_arguments')
  assert.equal(await bad('drop_tables', {}), 'unknown_tool')
  assert.equal((await runAiReadTool('list_purchase_orders', { supplier: 'Nobody Ltd' }, { facts })).error, 'supplier_not_found')
  assert.deepEqual(validateAiToolArgs({ properties: {}, required: [] }, null), { ok: true, args: {} })
  assert.deepEqual(aiToolList([1, 2, 3], 2), { rows: [1, 2], total: 3, more: 1 })
  assert.equal(aiToolList(Array.from({ length: 80 }, (_, index) => index), 500).rows.length, AI_TOOL_LIMITS.maxRows)
})

test('calculate does the arithmetic an answer derives', async () => {
  const facts = await factsFor()
  const calc = async (args) => (await runAiReadTool('calculate', args, { facts })).result
  assert.deepEqual(await calc({ operation: 'sum', values: [1.1, 2.2] }), { result: 3.3 })
  assert.deepEqual(await calc({ operation: 'difference', values: [10, 4] }), { result: 6 })
  assert.deepEqual(await calc({ operation: 'percent', values: [12920, 17920] }), { result: 72.0982, unit: 'percent' })
  assert.deepEqual(await calc({ operation: 'percent_change', values: [100, 125] }), { result: 25, unit: 'percent' })
  assert.deepEqual(await calc({ operation: 'days_between', dates: ['2026-10-13', '2026-10-28'] }), { result: 15, unit: 'days' })
  assert.deepEqual(await calc({ operation: 'add_days', dates: ['2026-10-28'], values: [7] }), { result: '2026-11-04' })
  assert.equal((await runAiReadTool('calculate', { operation: 'ratio', values: [1, 0] }, { facts })).error, 'division_by_zero')
})

test('a role gets only the tools and the fields it may read', async () => {
  // Finance reads supplier invoices, not purchase orders or stock.
  const finance = await factsFor('finance-specialist')
  assert.deepEqual(aiReadToolsFor(finance).map((tool) => tool.name).sort(), ['calculate', 'list_supplier_invoices', 'list_suppliers', 'workspace_summary'])
  assert.equal((await runAiReadTool('list_purchase_orders', {}, { facts: finance })).error, 'not_allowed')
  assert.doesNotMatch(await everyOutput(finance), /PO-0\d\d/, 'no purchase order number reaches a finance user')
  // Operations reads stock and receipts, not purchase orders.
  const operations = await factsFor('operations-specialist')
  assert.ok(!aiReadToolsFor(operations).some((tool) => ['list_purchase_orders', 'get_purchase_order', 'spend_analysis', 'late_order_impact'].includes(tool.name)))
  assert.doesNotMatch(await everyOutput(operations), /PO-0\d\d/, 'no purchase order number reaches operations')
  // A viewer reads records without amounts.
  const viewer = await factsFor('read-only-viewer')
  const orders = await runAiReadTool('list_purchase_orders', { status: 'all' }, { facts: viewer })
  assert.ok(orders.result.rows.length > 0)
  assert.ok(orders.result.rows.every((row) => row.amount === null))
  assert.equal(orders.result.workspace.committedSpend, null)
  // Nobody gets a contact's email address from a tool.
  for (const facts of [await factsFor(), finance, operations, viewer]) assert.doesNotMatch(await everyOutput(facts), /@/)
})

test('tool definitions are offered in both provider formats, with closed schemas', async () => {
  const facts = await factsFor('finance-specialist')
  const anthropic = aiReadToolDefinitions(facts)
  assert.ok(anthropic.every((tool) => tool.name && tool.description && tool.input_schema.type === 'object' && tool.input_schema.additionalProperties === false))
  const chat = aiReadToolDefinitions(facts, { format: 'chat_completions' })
  assert.deepEqual(chat.map((tool) => tool.function.name), anthropic.map((tool) => tool.name))
  assert.ok(chat.every((tool) => tool.type === 'function' && tool.function.parameters === anthropic.find((entry) => entry.name === tool.function.name).input_schema))
  assert.deepEqual(aiReadToolsFor(null), [])
})

test('refs are collected once each from a nested result', () => {
  const ref = (id) => ({ type: 'purchase_order', id, label: id })
  assert.deepEqual(aiReadToolRefs({ rows: [{ ref: ref('A') }, { ref: ref('B'), lines: [{ ref: ref('A') }] }], other: { ref: ref('C') } }).map((entry) => entry.id), ['A', 'B', 'C'])
})
