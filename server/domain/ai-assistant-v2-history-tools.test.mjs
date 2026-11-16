import test from 'node:test'
import assert from 'node:assert/strict'
import { aiSkillScenario } from './test-fixtures/ai-skill-scenario.mjs'
import { loadAiSkillContext } from './ai-skill-context.mjs'
import { readAiSkillFacts } from './ai-skill-readers.mjs'
import { runAiReadTool } from './ai-read-tool-runner.mjs'
import { AI_ASSISTANT_V2_HISTORY_TOOLS } from './ai-assistant-v2-history-tools.mjs'
import { assistantV2Partial } from './ai-assistant-v2-answer.mjs'

// Design audit 2026-11-15, batch B5 ("助手看到全部事实"): the tools covered open
// work only, a read cut at 500 records was answered as complete, and the
// business context was read two or three times per answer.

async function setUp({ truncated = [], ctx = {} } = {}) {
  const scenario = aiSkillScenario({ truncated })
  const context = await loadAiSkillContext({ ...scenario.ctx, ...ctx })
  const facts = await readAiSkillFacts(context, { openPurchaseRequests: true })
  const run = async (name, args = {}) => {
    const output = await runAiReadTool(name, args, { facts, context })
    assert.ok(output.ok, `${name}: ${output.error}`)
    return output.result
  }
  return { scenario, context, facts, run }
}
const tool = (name) => AI_ASSISTANT_V2_HISTORY_TOOLS.find((entry) => entry.name === name)

// L5-04: a finished order gave no lines, and its receipts were only the
// rejected and unposted ones.
test('a fully received purchase order gives every line and every receipt', async () => {
  const { run } = await setUp()
  const done = await run('get_purchase_order', { order: 'PO-003' })
  assert.deepEqual(done.openLines, [])
  assert.deepEqual(done.closedLines.map((line) => [line.sku, line.ordered, line.received, line.remaining]), [['LDM-003', 400, 400, 0]])
  assert.deepEqual(done.receipts.map((row) => [row.documentNumber, row.accepted, row.rejected]), [['GRN-003', 400, 5]])
  // An open order keeps its open lines, and its posted receipt with nothing rejected is there too.
  const open = await run('get_purchase_order', { order: 'PO-001' })
  assert.deepEqual(open.openLines.map((line) => [line.sku, line.remaining]), [['LDM-001', 30]])
  assert.deepEqual(open.receipts.map((row) => [row.documentNumber, row.accepted, row.rejected]), [['GRN-001', 20, 0]])
})

// L5-05: a read cut at the repository's limit was answered as complete.
test('a read cut at its limit is marked partial in the results and in the model\'s context', async () => {
  const { run, facts } = await setUp({ truncated: [{ subject: 'receipts', limit: 500 }, { subject: 'supplier_invoices', limit: 500 }] })
  const receipts = await run('list_receipts', { kind: 'unposted' })
  assert.deepEqual(receipts.partial?.sources, ['receipts'])
  assert.equal(receipts.partial.limit, 500)
  assert.match(receipts.partial.note, /latest/)
  assert.deepEqual((await run('list_supplier_invoices')).partial?.sources, ['supplier_invoices'])
  assert.deepEqual((await run('workspace_summary')).partial?.sources.sort(), ['receipts', 'supplier_invoices'])
  // A tool over a source read in full says nothing.
  assert.equal((await run('list_purchase_orders')).partial, undefined)
  assert.deepEqual(assistantV2Partial(facts).sources, [{ source: 'receipts', limit: 500 }, { source: 'supplier_invoices', limit: 500 }])
  const whole = await setUp()
  assert.equal(assistantV2Partial(whole.facts), null)
  assert.equal((await whole.run('list_receipts', { kind: 'unposted' })).partial, undefined)
})

// L5-15: the answer's tools read the business context again.
test('the business context is read once for the facts and reused by the tools of the same request', async () => {
  const { scenario, context, facts } = await setUp()
  // What the v2 loop does after reading the facts.
  context.routeContext.aiSkillBusinessContext = facts.businessContext
  const reads = () => scenario.calls.repositories.filter(([name]) => name === 'procurementRuntime.snapshot').length
  const before = reads()
  assert.ok(before >= 1)
  const found = await runAiReadTool('search_records', { query: 'PO-001' }, { facts, context })
  assert.ok(found.ok)
  assert.equal(reads(), before, 'search_records read the context again')
  // The context is never serialised with the facts.
  assert.ok(!Object.keys(facts).includes('businessContext'))
  assert.ok(!JSON.stringify(facts).includes('"businessContext"'))
})

// L5-04: stock movements and shipments had no tool.
test('stock_movements gives one item\'s movements in the window with totals, through the inventory service', async () => {
  const asked = []
  const movement = (date, type, quantityIn, quantityOut, document) => ({ occurredAt: `${date}T10:00:00.000Z`, movementType: type, quantityIn, quantityOut, adjustmentQty: 0, unit: 'pcs', sourceDocumentNumber: document })
  const stockMovements = { listMovements: async (query) => { asked.push(query); return { movements: [movement('2026-09-28', 'shipment', 0, 50, 'SHP-9'), movement('2026-09-20', 'receipt', 20, 0, 'GRN-001'), movement('2026-08-01', 'receipt', 100, 0, 'GRN-OLD')] } } }
  const { facts, context } = await setUp({ ctx: { aiReadServices: { stockMovements } } })
  const result = await tool('stock_movements').run({ sku: 'LDM-001', days: 30 }, { facts, context })
  assert.deepEqual(asked.map((query) => query.sku), ['LDM-001'])
  assert.deepEqual(result.rows.map((row) => [row.date, row.type, row.quantity, row.documentNumber]), [['2026-09-28', 'shipment', -50, 'SHP-9'], ['2026-09-20', 'receipt', 20, 'GRN-001']])
  assert.deepEqual(result.totals, { in: 20, out: 50, adjusted: 0, net: -30, unit: 'pcs' })
  assert.equal(result.partial, undefined)
  assert.deepEqual(await tool('stock_movements').run({ sku: 'NOPE-1' }, { facts, context }), { error: 'not_found' })
})

test('list_shipments gives one order\'s posted shipments, and only lines from the reader\'s warehouses', async () => {
  const shipment = (id, number, postedAt, lines, extra = {}) => ({ id, shipmentNumber: number, postedAt: new Date(postedAt), reversedAt: null, postingStatus: 'posted', salesOrder: { id: 'SO-001', orderNumber: 'SO-001', customerName: 'Redwood Retail' }, lines, ...extra })
  const line = (sku, quantity, warehouseId) => ({ sku, postedQuantity: String(quantity), unit: 'pcs', allocations: [{ warehouseId }] })
  const shipments = [
    shipment('S2', 'SHP-2', '2026-09-27T09:00:00Z', [line('LDM-001', 5, 'WH-2')]),
    shipment('S1', 'SHP-1', '2026-09-25T09:00:00Z', [line('LDM-001', 30, 'WH-1'), line('LDM-002', 4, 'WH-2')], { reversedAt: new Date('2026-09-26T09:00:00Z') }),
  ]
  const prisma = {
    salesOrder: { findFirst: async ({ where }) => (where.orderNumber === 'SO-001' ? { id: 'SO-001' } : null) },
    shipmentDocument: { findMany: async ({ where }) => shipments.filter((row) => !where.salesOrderId || row.salesOrder.id === where.salesOrderId) },
  }
  const context = (warehouseIds) => ({ actor: { permissionCodes: new Set(['shipment.read']), tenantId: 't1' }, tenantId: 't1', prisma, routeContext: { reportReadAccess: { warehouseIds } } })
  const facts = { today: '2026-09-29' }
  const all = await tool('list_shipments').run({ order: 'SO-001' }, { facts, context: context(null) })
  assert.deepEqual(all.rows.map((row) => [row.shipment, row.shipped, row.reversed ?? false, row.lines.map((entry) => `${entry.sku}:${entry.quantity}`).join(',')]), [['SHP-2', '2026-09-27', false, 'LDM-001:5'], ['SHP-1', '2026-09-25', true, 'LDM-001:30,LDM-002:4']])
  // A reader of WH-1 only sees the line shipped from it.
  const scoped = await tool('list_shipments').run({ order: 'SO-001' }, { facts, context: context(['WH-1']) })
  assert.deepEqual(scoped.rows.map((row) => [row.shipment, row.lines.map((entry) => entry.sku)]), [['SHP-1', ['LDM-001']]])
  assert.deepEqual(await tool('list_shipments').run({ order: 'SO-404' }, { facts, context: context(null) }), { error: 'not_found' })
  // Offered only with shipment.read.
  assert.equal(tool('list_shipments').available(facts, { ...context(null), actor: { permissionCodes: new Set() } }), false)
})

// L5-25: the reorder page showed the forecasting model's reorder point; the
// assistant's reorder list could not.
test('reorder_list adds the forecasting model\'s reorder point when asked, and reads the forecast only then', async () => {
  const passed = []
  const reorderList = { read: async (input) => { passed.push(input.forecastClient); return { rows: [{ sku: 'LDM-001', itemName: 'Flow Controller', orderNow: true, reorderPoint: 40, reorderPointForecast: { reorderPoint: 55, model: 'timesfm' } }], summary: {}, dataLimitations: [] } } }
  const forecastClient = { quantiles: async () => ({ values: [55] }) }
  const { run } = await setUp({ ctx: { aiReadServices: { reorderList }, forecastClient } })
  const plain = await run('reorder_list')
  assert.equal(passed.at(-1), null)
  assert.equal(plain.rows[0].forecastReorderPoint, undefined)
  assert.equal(plain.forecastAvailable, true)
  const asked = await run('reorder_list', { forecast: true })
  assert.equal(passed.at(-1), forecastClient)
  assert.equal(asked.rows[0].forecastReorderPoint, 55)
  // No forecast service: none is read, and the result says so.
  const none = await setUp({ ctx: { aiReadServices: { reorderList }, forecastClient: null } })
  assert.equal((await none.run('reorder_list', { forecast: true })).forecastAvailable, false)
  assert.equal(passed.at(-1), null)
})
