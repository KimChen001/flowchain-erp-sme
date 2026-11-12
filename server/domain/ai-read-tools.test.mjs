import test from 'node:test'
import assert from 'node:assert/strict'
import { aiSkillScenario } from './test-fixtures/ai-skill-scenario.mjs'
import { loadAiSkillContext } from './ai-skill-context.mjs'
import { readAiSkillFacts } from './ai-skill-readers.mjs'
import { validateAiToolArgs, aiToolList, AI_TOOL_LIMITS } from './ai-read-tool-contract.mjs'
import { AI_READ_TOOLS } from './ai-read-tools.mjs'
import { AI_READ_SERVICE_TOOLS } from './ai-read-service-tools.mjs'
import { aiReadToolDefinitions, aiReadToolRefs, aiReadToolsFor, runAiReadTool } from './ai-read-tool-runner.mjs'
import { createSupplierInsightsReadService } from './supplier-insights.mjs'

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
  // Without the request's context only the tools over the facts are offered;
  // the service tools (tests/postgres/ai-read-tools.test.mjs) need it.
  const service = new Set(AI_READ_SERVICE_TOOLS.map((tool) => tool.name))
  const offered = aiReadToolsFor(facts).map((tool) => tool.name)
  for (const name of AI_READ_TOOLS.map((tool) => tool.name).filter((entry) => !service.has(entry))) assert.ok(offered.includes(name), name)
  assert.ok(!offered.some((name) => service.has(name)))
  assert.equal((await runAiReadTool('search_records', { query: 'Acme' }, { facts })).error, 'not_allowed')
  const scenario = aiSkillScenario()
  const context = await loadAiSkillContext(scenario.ctx)
  assert.ok(aiReadToolsFor(facts, context).some((tool) => tool.name === 'search_records'))
  const found = (await runAiReadTool('search_records', { query: 'Acme' }, { facts, context })).result.rows
  assert.equal(found[0].ref.id.startsWith('PO-'), true)
  // A document's link reads its number; a supplier's reads its name.
  assert.equal(found[0].ref.label, found[0].number)
  assert.equal(found.find((row) => row.type === 'supplier')?.ref.label, 'Acme Components')
  const overdue = await runAiReadTool('list_purchase_orders', { status: 'overdue' }, { facts })
  assert.equal(overdue.ok, true)
  assert.equal(overdue.result.total, facts.purchaseOrders.overdue)
  // Most overdue first: the date rule, never a score.
  const days = overdue.result.rows.map((row) => row.overdueDays)
  assert.deepEqual(days, [...days].sort((a, b) => b - a))
  assert.ok(overdue.result.rows.every((row) => row.ref.type === 'purchase_order' && row.ref.label === row.orderNumber))
  // Counts per supplier are the tool's own, over every matching order.
  assert.equal(overdue.result.bySupplier.reduce((sum, row) => sum + row.orders, 0), overdue.result.total)
  assert.ok(overdue.result.bySupplier.every((row) => row.ref.type === 'supplier'))
  // A supplier tier's orders, with their own total: "which Tier 1 suppliers
  // have overdue orders" needs a count no other field holds.
  const first = facts.purchaseOrders.index.find((row) => row.isOpen && row.overdueDays > 0)
  const tiered = { ...facts, suppliers: facts.suppliers.map((row) => ({ ...row, tier: row.id === first.supplierId ? 1 : 3 })) }
  const tierOne = (await runAiReadTool('list_purchase_orders', { status: 'overdue', tier: 1 }, { facts: tiered })).result
  const own = facts.purchaseOrders.index.filter((row) => row.isOpen && row.overdueDays > 0 && row.supplierId === first.supplierId)
  assert.equal(tierOne.total, own.length)
  assert.deepEqual(tierOne.rows.map((row) => row.orderNumber).sort(), own.map((row) => row.orderNumber).sort())
  assert.deepEqual(tierOne.bySupplier.map((row) => [row.supplier, row.orders]), [[first.supplier, own.length]])
  const tierTwo = (await runAiReadTool('list_purchase_orders', { status: 'overdue', tier: 2 }, { facts: tiered })).result
  assert.deepEqual([tierTwo.total, tierTwo.rows, tierTwo.bySupplier], [0, [], []])
  assert.equal((await runAiReadTool('list_purchase_orders', { tier: 1 }, { facts: { ...facts, suppliers: null } })).error, 'tiers_not_readable')
  // A number's end finds the order, whatever its case.
  const order = await runAiReadTool('get_purchase_order', { order: 'po-001' }, { facts })
  assert.equal(order.result.order.orderNumber, 'PO-001')
  assert.ok(order.result.openLines.length > 0)
  // As people type it: without zero padding or separators.
  for (const typed of ['PO-1', 'po 1', 'PO1']) assert.equal((await runAiReadTool('get_purchase_order', { order: typed }, { facts })).result?.order.orderNumber, 'PO-001', typed)
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
  assert.equal(await bad('list_purchase_orders', { tier: 4 }), 'invalid_arguments')
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

// A plan's costs are quantity times price, and a longer answer needs several
// figures: one call carries them (2026-11-04).
test('calculate multiplies, and takes several calculations in one call', async () => {
  const facts = await factsFor()
  const calc = async (args) => runAiReadTool('calculate', args, { facts })
  assert.deepEqual((await calc({ operation: 'product', values: [1677, 18.75] })).result, { result: 31443.75 })
  const batch = (await calc({ calculations: [
    { label: 'LDM-002 cost', operation: 'product', values: [1677, 18.75] },
    { label: 'Total', operation: 'sum', values: [31443.75, 946.9] },
    { label: 'Need-by', operation: 'add_days', dates: ['2026-11-04'], values: [14] },
    { label: 'Bad', operation: 'ratio', values: [1, 0] },
    { label: 'Wrong', operation: 'multiply', values: [1, 2] },
    { label: 'Strings', operation: 'sum', values: ['1', 2] },
  ] })).result
  assert.deepEqual(batch.results, [
    { label: 'LDM-002 cost', operation: 'product', result: 31443.75 },
    { label: 'Total', operation: 'sum', result: 32390.65 },
    { label: 'Need-by', operation: 'add_days', result: '2026-11-18' },
    { label: 'Bad', operation: 'ratio', error: 'division_by_zero' },
    { label: 'Wrong', operation: null, error: 'invalid_arguments', details: ['operation must be one of sum, difference, product, ratio, percent, percent_change, average, days_between, add_days'] },
    { label: 'Strings', operation: 'sum', error: 'invalid_arguments', details: ['values must be up to 50 numbers'] },
  ])
  // Neither one calculation nor a list: an error the model can correct.
  assert.equal((await calc({})).error, 'invalid_arguments')
})

test('a role gets only the tools and the fields it may read', async () => {
  // Finance reads supplier invoices, not purchase orders or stock.
  const finance = await factsFor('finance-specialist')
  assert.deepEqual(aiReadToolsFor(finance).map((tool) => tool.name).sort(), ['attention_list', 'calculate', 'list_supplier_invoices', 'list_suppliers', 'records_missing_data', 'workspace_summary'])
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
  // An order's unit price only for a role that sees prices (2026-11-07: an answer divided the amount itself).
  assert.ok((await runAiReadTool('get_purchase_order', { order: 'PO-001' }, { facts: viewer })).result.openLines.every((line) => !('unitPrice' in line)))
  assert.deepEqual((await runAiReadTool('get_purchase_order', { order: 'PO-001' }, { facts: await factsFor() })).result.openLines.map((line) => [line.unitPrice, line.currency]), [[100, 'USD']])
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

test('the stock projection places only dated lines in a week and lists the rest apart', async () => {
  const facts = await factsFor()
  const projection = (await runAiReadTool('stock_projection', { sku: 'LDM-001', weeks: 3 }, { facts })).result
  assert.equal(projection.weeks.length, 3)
  assert.equal(projection.weeks[0].from, facts.asOf)
  // Each week ends with the week before's balance plus what arrives less what is due.
  let balance = projection.availableToday
  for (const week of projection.weeks) {
    balance += week.incoming - week.demand
    assert.equal(week.endAvailable, balance)
    assert.equal(week.belowSafetyStock, balance < projection.safetyStock)
  }
  // An order past its promised day is never placed in a week: no arrival date is guessed.
  const placed = new Set(projection.weeks.flatMap((week) => week.purchaseOrders))
  for (const entry of projection.notPlacedInAWeek.incomingPastPromisedDate) assert.ok(!placed.has(entry.orderNumber))
  assert.ok(projection.notPlacedInAWeek.incomingPastPromisedDate.some((entry) => entry.orderNumber === 'PO-001'), 'PO-001 is overdue')
  assert.deepEqual(await runAiReadTool('stock_projection', { sku: 'NOPE-1' }, { facts }), { ok: false, error: 'not_found' })
})

test('at risk covers short, out of stock, below safety stock and below the reorder point, as the parameter says', async () => {
  const facts = await factsFor()
  const all = facts.inventory.rows
  // As on the public data: below safety stock with no open sales demand short.
  const calm = all.find((row) => !facts.inventory.atRisk.includes(row.sku) && row.stockStatus !== 'below_safety_stock')
  calm.stockStatus = 'below_safety_stock'
  const risky = (row) => facts.inventory.atRisk.includes(row.sku) || ['out_of_stock', 'below_safety_stock', 'below_reorder_point'].includes(row.stockStatus)
  const result = (await runAiReadTool('stock_position', { only: 'at_risk', limit: 50 }, { facts })).result
  assert.deepEqual(result.rows.map((row) => row.sku), all.filter(risky).map((row) => row.sku).sort())
  assert.ok(result.rows.some((row) => row.status === 'below_safety_stock' && !(row.shortage > 0)), 'an item below safety stock with no shortage is at risk')
  assert.deepEqual(result.counts, {
    atRisk: all.filter(risky).length,
    shortAgainstSalesOrders: all.filter((row) => facts.inventory.atRisk.includes(row.sku)).length,
    outOfStock: all.filter((row) => row.stockStatus === 'out_of_stock').length,
    belowSafetyStock: all.filter((row) => row.stockStatus === 'below_safety_stock').length,
    belowReorderPoint: all.filter((row) => row.stockStatus === 'below_reorder_point').length,
  })
})

test('a stock row gives each incoming order\'s promised date and days overdue, as the order list does', async () => {
  const facts = await factsFor()
  const row = (await runAiReadTool('stock_position', { sku: 'LDM-001' }, { facts })).result.rows[0]
  assert.ok(row.purchaseOrders.length > 0)
  assert.deepEqual(row.purchaseOrderDates.map((entry) => entry.orderNumber), row.purchaseOrders)
  const listed = (await runAiReadTool('list_purchase_orders', { status: 'all', limit: 50 }, { facts })).result.rows
  for (const entry of row.purchaseOrderDates) {
    const order = listed.find((candidate) => candidate.orderNumber === entry.orderNumber)
    assert.deepEqual({ dueDate: entry.dueDate, overdueDays: entry.overdueDays }, { dueDate: order.dueDate, overdueDays: order.overdueDays })
  }
  assert.ok(row.purchaseOrderDates.some((entry) => entry.orderNumber === 'PO-001' && entry.overdueDays > 0), 'PO-001 is overdue')
})

// No read tool gives an email address (tests/postgres/ai-read-tools.test.mjs
// holds every output to it): a draft leaves the To: line for the user.
test('list_suppliers gives no contact email, though the facts hold one for drafting roles', async () => {
  const facts = await factsFor()
  assert.ok(facts.suppliers.some((row) => 'email' in row))
  const rows = (await runAiReadTool('list_suppliers', {}, { facts })).result.rows
  assert.ok(rows.length > 0)
  for (const row of rows) assert.ok(!('email' in row) && !('contactName' in row), row.name)
})

// 2026-11-09 on Flash: "Acme 是几级供应商？为什么？" got "the records do not say
// why", though the buyer wrote a reason when setting the tier.
test('list_suppliers gives a tier\'s written reason, when it was set and by whom; an untiered supplier none', async () => {
  const facts = await factsFor()
  const tiered = { ...facts.suppliers[0], tier: 1, tierReason: 'Sole source of our best seller; 6% of purchase spend.', tierSetOn: '2026-10-12', tierSetBy: 'Daniel' }
  const plain = { ...facts.suppliers[1], tier: null }
  const rows = (await runAiReadTool('list_suppliers', {}, { facts: { ...facts, suppliers: [tiered, plain] } })).result.rows
  const one = rows.find((row) => row.name === tiered.name)
  assert.deepEqual([one.tier, one.tierReason, one.tierSetOn, one.tierSetBy], [1, 'Sole source of our best seller; 6% of purchase spend.', '2026-10-12', 'Daniel'])
  assert.ok(!('tierReason' in rows.find((row) => row.name === plain.name)))
})

// 2026-11-09 on Flash: "When did we last receive 85123A?" had no receipt
// lines to read.
test('list_receipts with a SKU gives that item\'s latest receipts, newest first', async () => {
  const facts = await factsFor()
  const one = (await runAiReadTool('list_receipts', { sku: 'ldm-001' }, { facts })).result
  assert.equal(one.sku, 'LDM-001')
  assert.deepEqual(one.rows.map((row) => [row.documentNumber, row.accepted, row.rejected, row.unit, row.purchaseOrder, row.postingStatus]), [['GRN-001', 20, 0, 'pcs', 'PO-001', 'posted']])
  assert.match(one.rows[0].arrived, /^\d{4}-\d{2}-\d{2}$/)
  assert.deepEqual(one.rows[0].ref, { type: 'receiving_doc', id: 'GRN-001', label: 'GRN-001' })
  const none = (await runAiReadTool('list_receipts', { sku: 'NOPE-1' }, { facts })).result
  assert.deepEqual(none.rows, [])
  assert.match(none.note, /No receipt of this item among the \d+ newest receipts read/)
  // Without a SKU the kinds are as before.
  assert.ok(Array.isArray((await runAiReadTool('list_receipts', { kind: 'unposted' }, { facts })).result.rows))
})

// 2026-11-09 on Flash: told the period was "all", the model said the
// scorecard had no 90-day view and gave the quarter.
test('supplier_performance reads the last 90 days by default, or the calendar period asked for', async () => {
  const facts = await factsFor()
  const asked = []
  const scorecard = async (query) => { asked.push(query); return { period: query.from ? query : { from: '2026-08-12', to: '2026-11-09' }, suppliers: [], fieldVisibility: {} } }
  const tool = AI_READ_TOOLS.find((entry) => entry.name === 'supplier_performance')
  assert.equal(tool.schema.properties.period.enum[0], 'last_90_days')
  assert.ok(!tool.schema.properties.period.enum.includes('all'))
  await runAiReadTool('supplier_performance', {}, { facts: { ...facts, supplierScorecard: scorecard } })
  await runAiReadTool('supplier_performance', { period: 'last_90_days' }, { facts: { ...facts, supplierScorecard: scorecard } })
  await runAiReadTool('supplier_performance', { period: 'last_quarter' }, { facts: { ...facts, supplierScorecard: scorecard } })
  assert.deepEqual(asked.slice(0, 2), [{}, {}])
  assert.ok(asked[2].from && asked[2].to)
})

test('an order row names its items as the stock rows do, so a draft can name them', async () => {
  const facts = await factsFor()
  const names = new Map(facts.inventory.rows.map((row) => [row.sku, row.itemName]))
  const rows = (await runAiReadTool('list_purchase_orders', { status: 'all', limit: 50 }, { facts })).result.rows
  const withItems = rows.filter((row) => row.skus.length)
  assert.ok(withItems.length > 0)
  for (const row of withItems) assert.deepEqual(row.itemNames, row.skus.map((sku) => names.get(sku)).filter(Boolean), row.orderNumber)
  const one = await runAiReadTool('get_purchase_order', { order: withItems[0].orderNumber }, { facts })
  assert.deepEqual(one.result.order.itemNames, withItems[0].itemNames)
})

test('supplier_risks lists the Supplier risks page\'s issues, counted per supplier and never scored', async () => {
  const scenario = aiSkillScenario()
  const context = await loadAiSkillContext(scenario.ctx)
  const facts = await readAiSkillFacts(context)
  assert.ok(aiReadToolsFor(facts, context).some((tool) => tool.name === 'supplier_risks'))
  const risks = (await runAiReadTool('supplier_risks', {}, { facts, context })).result
  // The page's own rows, in its order: earliest date first.
  const page = await createSupplierInsightsReadService({ prisma: context.prisma, now: () => context.now }).readRisks(scenario.ctx)
  assert.ok(page.issues.length > 0)
  assert.equal(risks.total, page.issues.length)
  assert.deepEqual(risks.rows.map((row) => row.ref.id), page.issues.slice(0, risks.rows.length).map((row) => row.entityId))
  assert.equal(risks.suppliers.reduce((sum, row) => sum + row.issues, 0), page.issues.length)
  assert.ok(risks.suppliers.every((row) => row.ref.type === 'supplier' && !('score' in row)))
  assert.deepEqual(risks.hidden, [])
  const acme = (await runAiReadTool('supplier_risks', { supplier: 'acme' }, { facts, context })).result
  assert.ok(acme.rows.length > 0 && acme.rows.every((row) => row.supplier === 'Acme Components'))
  assert.equal((await runAiReadTool('supplier_risks', { supplier: 'Nobody Ltd' }, { facts, context })).error, 'supplier_not_found')
  const overdue = (await runAiReadTool('supplier_risks', { type: 'po_overdue' }, { facts, context })).result
  assert.ok(overdue.rows.length > 0 && overdue.rows.every((row) => row.type === 'po_overdue' && row.ref.type === 'purchase_order'))
  // Finance reads supplier invoices only: the other kinds are named hidden.
  const financeContext = await loadAiSkillContext(aiSkillScenario({ roleKey: 'finance-specialist' }).ctx)
  const finance = (await runAiReadTool('supplier_risks', {}, { facts: await readAiSkillFacts(financeContext), context: financeContext })).result
  assert.ok(finance.hidden.includes('orders') && finance.hidden.includes('receipts'))
  assert.doesNotMatch(JSON.stringify(finance), /PO-0\d\d|GRN-0\d\d/, 'no purchase order or receipt reaches finance')
})

test('list_contracts gives a contract\'s title, dates, value and terms, the value only to users who may see prices', async () => {
  const row = { id: 'CON-1', number: 'CON-0001', title: 'Flow controllers 2026', externalReference: 'ACME-MSA-7', type: 'supply', status: 'active', state: 'active', startDate: '2026-01-01', endDate: '2026-12-31', signedOn: '2025-12-15', noticeDays: 60, renewal: 'manual', counterpartyType: 'supplier', totalValue: '125000.0000', currency: 'USD', paymentTermsId: 'TERMS-30', notes: 'Free text the model never reads', supplier: { id: 'SUP-001', name: 'Acme Components' } }
  const run = async (prices) => {
    const scenario = aiSkillScenario()
    const contracts = { list: async () => ({ today: '2026-09-29', counts: { all: 1 }, access: { prices }, contracts: [prices ? row : { ...row, totalValue: null, restrictedFields: ['totalValue'] }] }) }
    const context = await loadAiSkillContext({ ...scenario.ctx, env: { FLOWCHAIN_ENABLE_CONTRACTS: 'true' }, aiReadServices: { contracts } })
    return (await runAiReadTool('list_contracts', {}, { facts: await readAiSkillFacts(context), context })).result
  }
  const buyer = await run(true)
  assert.equal(buyer.pricesHidden, false)
  assert.deepEqual(buyer.rows[0], {
    number: 'CON-0001', title: 'Flow controllers 2026', externalReference: 'ACME-MSA-7', type: 'supply', status: 'active', state: 'active', startDate: '2026-01-01', endDate: '2026-12-31', signedOn: '2025-12-15', noticeDays: 60, counterpartyType: 'supplier', totalValue: '125000.0000', currency: 'USD',
    supplier: 'Acme Components', paymentTerms: { code: 'TERMS-30' }, renewal: 'manual', ref: { type: 'contract', id: 'CON-1', label: 'CON-0001' },
  })
  const viewer = await run(false)
  assert.equal(viewer.pricesHidden, true)
  assert.equal(viewer.rows[0].totalValue, null)
  assert.equal(viewer.rows[0].currency, 'USD')
})

// 2026-11-07: "上个月销售额是多少？", top customers and best sellers had no tool.
test('sales_summary totals customer invoices in a period by customer, item or month, in one currency', async () => {
  const scenario = aiSkillScenario()
  const loaded = await loadAiSkillContext(scenario.ctx)
  const facts = await readAiSkillFacts(loaded)
  const seen = []
  const line = (sku, itemName, quantity, lineAmount) => ({ itemId: `ITEM-${sku}`, sku, itemName, quantity: String(quantity), unit: 'pcs', lineAmount: String(lineAmount) })
  const invoices = [
    { id: 'CI-1', customerNameSnapshot: 'Harbor Supply Co', invoiceDate: new Date('2026-10-03T00:00:00Z'), subtotalAmount: '100.0000', currency: 'GBP', lines: [line('X-1', 'Cake Stand', 10, 60), line('Y-2', 'Tea Towel', 5, 40)] },
    { id: 'CI-2', customerNameSnapshot: 'Redwood Retail', invoiceDate: new Date('2026-10-20T00:00:00Z'), subtotalAmount: '250.0000', currency: 'GBP', lines: [line('X-1', 'Cake Stand', 25, 250)] },
    { id: 'CI-3', customerNameSnapshot: 'Harbor Supply Co', invoiceDate: new Date('2026-10-21T00:00:00Z'), subtotalAmount: '50.0000', currency: 'USD', lines: [line('X-1', 'Cake Stand', 4, 50)] },
  ]
  const context = { ...loaded, prisma: { ...loaded.prisma, customerInvoice: { findMany: async (query) => { seen.push(query); return invoices } } } }
  const run = async (args) => (await runAiReadTool('sales_summary', { from: '2026-10-01', to: '2026-10-31', currency: 'GBP', ...args }, { facts, context })).result
  const customers = await run({})
  assert.deepEqual(seen[0].where.status, { notIn: ['draft', 'cancelled'] })
  assert.deepEqual([seen[0].where.invoiceDate.gte.toISOString(), seen[0].where.invoiceDate.lt.toISOString()], ['2026-10-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z'])
  assert.deepEqual([customers.currency, customers.invoices, customers.amount], ['GBP', 2, 350])
  assert.deepEqual(customers.rows.map((row) => [row.customer, row.invoices, row.amount, row.sharePercent]), [['Redwood Retail', 1, 250, 71.4], ['Harbor Supply Co', 1, 100, 28.6]])
  assert.deepEqual(customers.otherCurrencies, [{ currency: 'USD', invoices: 1, amount: 50 }])
  // The share of the rows so far, so the top N together comes from the tool.
  assert.deepEqual(customers.rows.map((row) => [row.rank, row.runningAmount, row.runningSharePercent]), [[1, 250, 71.4], [2, 350, 100]])
  const items = await run({ by: 'item' })
  assert.deepEqual(items.rows.map((row) => [row.sku, row.itemName, row.quantity, row.amount, row.sharePercent]), [['X-1', 'Cake Stand', 35, 310, 88.6], ['Y-2', 'Tea Towel', 5, 40, 11.4]])
  assert.deepEqual(items.rows[0].ref, { type: 'item', id: 'ITEM-X-1', label: 'X-1' })
  const oneItem = await run({ sku: 'Y-2' })
  assert.deepEqual([oneItem.amount, oneItem.quantity, oneItem.invoices, oneItem.rows.map((row) => row.customer)], [40, 5, 1, ['Harbor Supply Co']])
  const months = await run({ by: 'month' })
  assert.deepEqual(months.rows.map((row) => [row.month, row.amount]), [['2026-10', 350]])
  assert.deepEqual([months.rows[0].runningAmount, months.rows[0].runningSharePercent], [undefined, undefined])
  const harbor = await run({ customer: 'harbor', by: 'item' })
  assert.deepEqual(harbor.rows.map((row) => [row.sku, row.amount]), [['X-1', 60], ['Y-2', 40]])
  // Ranked by quantity, the item that sold the most units comes first, though
  // it earned less (2026-11-09 on Flash: "most units" named the top earner).
  const cheap = [...invoices, { id: 'CI-4', customerNameSnapshot: 'Redwood Retail', invoiceDate: new Date('2026-10-22T00:00:00Z'), subtotalAmount: '30.0000', currency: 'GBP', lines: [line('Z-3', 'Paper Clip', 300, 30)] }]
  const byUnits = async (args) => (await runAiReadTool('sales_summary', { from: '2026-10-01', to: '2026-10-31', currency: 'GBP', by: 'item', ...args }, { facts, context: { ...context, prisma: { ...context.prisma, customerInvoice: { findMany: async () => cheap } } } })).result
  assert.deepEqual((await byUnits({})).rows.map((row) => row.sku), ['X-1', 'Y-2', 'Z-3'])
  const units = await byUnits({ rankBy: 'quantity' })
  assert.equal(units.rankedBy, 'quantity')
  assert.deepEqual(units.rows.map((row) => [row.rank, row.sku, row.quantity]), [[1, 'Z-3', 300], [2, 'X-1', 35], [3, 'Y-2', 5]])
  // A named period is counted from the workspace day; to before from is refused.
  const lastMonth = (await runAiReadTool('sales_summary', { period: 'last_month' }, { facts, context })).result
  assert.ok(lastMonth.period.from.endsWith('-01') && lastMonth.period.to < String(facts.today || facts.asOf))
  assert.equal((await runAiReadTool('sales_summary', { from: '2026-10-31', to: '2026-10-01' }, { facts, context })).error, 'invalid_period')
  // Only for users who may read customer invoices.
  const tool = AI_READ_SERVICE_TOOLS.find((entry) => entry.name === 'sales_summary')
  assert.equal(tool.available(facts, context), true)
  assert.equal(tool.available(facts, { ...context, actor: { ...context.actor, permissionCodes: new Set() } }), false)
})

// 2026-11-07: "Which customer owes us the most?" read the first 100 of 542 open
// items, and a customer's items were filtered from that page only.
test('list_receivables by_customer totals every open item over all pages; one customer\'s items come from every page', async () => {
  const scenario = aiSkillScenario()
  const all = [
    ...Array.from({ length: 100 }, (_, index) => ({ id: `AR-A${index}`, obligationNumber: `AR-A${index}`, customerName: 'Harbor Supply Co', outstandingAmount: '1.00', currency: 'GBP', dueDate: '2026-01-05T00:00:00.000Z', status: 'open' })),
    ...Array.from({ length: 30 }, (_, index) => ({ id: `AR-B${index}`, obligationNumber: `AR-B${index}`, customerName: 'Redwood Retail', outstandingAmount: '10.00', currency: 'GBP', dueDate: index ? '2099-01-01T00:00:00.000Z' : '2026-02-01T00:00:00.000Z', status: 'open' })),
    { id: 'AR-PAID', obligationNumber: 'AR-PAID', customerName: 'Paid Up Ltd', outstandingAmount: '0.00', currency: 'GBP', dueDate: '2026-01-01T00:00:00.000Z', status: 'paid' },
  ]
  const pages = []
  const receivables = { listReceivables: async ({ page = 1, pageSize }) => { pages.push(page); return { total: all.length, items: all.slice((page - 1) * pageSize, page * pageSize) } } }
  const context = await loadAiSkillContext({ ...scenario.ctx, aiReadServices: { receivables } })
  const facts = await readAiSkillFacts(context)
  const result = (await runAiReadTool('list_receivables', { view: 'by_customer' }, { facts, context })).result
  assert.deepEqual(pages, [1, 2])
  assert.deepEqual(result.rows.map((row) => [row.customer, row.balance, row.items]), [['Redwood Retail', 300, 30], ['Harbor Supply Co', 100, 100]])
  assert.deepEqual([result.rows[0].overdueAmount, result.rows[0].oldestDueDate], [10, '2026-02-01'])
  assert.deepEqual(result.totals, [{ currency: 'GBP', balance: 400, items: 130, customers: 2 }])
  pages.length = 0
  const redwood = (await runAiReadTool('list_receivables', { customer: 'redwood', limit: 50 }, { facts, context })).result
  assert.deepEqual([pages, redwood.total, redwood.rows.length], [[1, 2], 30, 30])
})

// 2026-11-08: a lookup of the item's full name in the SKU field found
// nothing, and the answer would not state the stock.
test('stock_position and stock_projection find an item by its name, in any case, quotes or dash; several matches come back to choose from', async () => {
  const facts = await factsFor()
  const item = facts.inventory.rows.find((row) => row.sku === 'LDM-001')
  const named = `“${item.itemName.toUpperCase().replace('-', '‑')}”`
  const position = (await runAiReadTool('stock_position', { sku: named }, { facts })).result
  assert.deepEqual(position.rows.map((row) => row.sku), ['LDM-001'])
  const projection = (await runAiReadTool('stock_projection', { sku: item.itemName.toLowerCase() }, { facts })).result
  assert.equal(projection.sku, 'LDM-001')
  // The SKU still works, and a name nothing fits is not found.
  assert.equal((await runAiReadTool('stock_position', { sku: 'ldm-001' }, { facts })).result.rows[0].sku, 'LDM-001')
  assert.equal((await runAiReadTool('stock_position', { sku: 'No Such Item Here' }, { facts })).error, 'not_found')
  // Part of a name several items share.
  const twin = { ...facts, inventory: { ...facts.inventory, rows: [...facts.inventory.rows, { ...item, sku: 'LDM-001-B', itemName: `${item.itemName} Spare` }] } }
  const many = await runAiReadTool('stock_position', { sku: item.itemName.split(' ')[0] }, { facts: twin })
  assert.equal(many.error, 'ambiguous')
  assert.ok(many.candidates.some((row) => row.sku === 'LDM-001') && many.candidates.some((row) => row.sku === 'LDM-001-B'), JSON.stringify(many.candidates))
})

// 2026-11-08 on DeepSeek: "7.1556 件" a day, copied from four decimals.
test('the reorder list gives the model its daily demand to one decimal', async () => {
  const scenario = aiSkillScenario()
  const reorderList = { read: async () => ({ rows: [{ sku: 'SKU-1', itemName: 'Item', orderNow: true, orderByDate: '2026-11-08', demand: { averageDailyDemand: 7.1556 }, supplier: { id: 'SUP-1', name: 'Supplier One' } }] }) }
  const context = await loadAiSkillContext({ ...scenario.ctx, aiReadServices: { reorderList } })
  const row = (await runAiReadTool('reorder_list', {}, { facts: await readAiSkillFacts(context), context })).result.rows[0]
  assert.equal(row.averageDailyDemand, 7.2)
})

// 2026-11-09 on Flash (UCI scene): "available to promise for 85123A is 408
// pcs with these late lines counted (288 without)". The two named late orders
// gave two rows for 85123A, 288 and 168, with nothing to say which order each
// left out; without both it is 48.
test('late order impact names the orders each row leaves out, and judges named orders on one SKU together too', async () => {
  const po = (id, orderNumber, sku, remaining, overdueDays) => ({ id, orderNumber, isOpen: true, overdueDays, openLines: [{ sku, remaining, unit: 'pcs' }] })
  const facts = {
    asOf: '2026-11-10',
    purchaseOrders: { index: [po('po-22', 'PO-202610-0022', '85123A', 120, 5), po('po-24', 'PO-202610-0024', '85123A', 240, 3), po('po-23', 'PO-202610-0023', '84879', 450, 4)] },
    inventory: { rows: [
      { sku: '85123A', itemId: 'item-1', unit: 'pcs', available: 48, availableToPromise: 408, purchaseOrderIds: ['po-22', 'po-24'] },
      { sku: '84879', itemId: 'item-2', unit: 'pcs', available: 98, availableToPromise: 548, purchaseOrderIds: ['po-23'] },
    ] },
    salesOrders: [],
  }
  const rows = (result) => result.skus.map((row) => [row.sku, row.judgedOrders.join('+'), row.withoutTheseLines, row.withoutEveryLateLine ?? null, row.together ?? false])
  const named = (await runAiReadTool('late_order_impact', { orders: ['PO-202610-0022', 'PO-202610-0024', 'PO-202610-0023'] }, { facts })).result
  assert.deepEqual(rows(named), [
    ['85123A', 'PO-202610-0022', 288, null, false],
    ['85123A', 'PO-202610-0024', 168, null, false],
    ['84879', 'PO-202610-0023', 98, 98, false],
    ['85123A', 'PO-202610-0022+PO-202610-0024', 48, 48, true],
  ])
  // One named order of two leaves the other late line counted.
  const one = (await runAiReadTool('late_order_impact', { orders: ['PO-202610-0024'] }, { facts })).result
  assert.deepEqual(rows(one), [['85123A', 'PO-202610-0024', 168, null, false]])
  // With none named, the overdue orders are judged together.
  const all = (await runAiReadTool('late_order_impact', {}, { facts })).result
  assert.deepEqual(rows(all).sort(), [['84879', 'PO-202610-0023', 98, 98, false], ['85123A', 'PO-202610-0022+PO-202610-0024', 48, 48, false]])
})
