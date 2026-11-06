import test from 'node:test'
import assert from 'node:assert/strict'
import { AI_SKILL_OTHER_TENANT, AI_SKILL_TENANT, aiSkillActor, aiSkillScenario } from './test-fixtures/ai-skill-scenario.mjs'
import { loadAiSkillContext } from './ai-skill-context.mjs'
import { readAiSkillFacts } from './ai-skill-readers.mjs'
import { AI_READ_TOOLS } from './ai-read-tools.mjs'
import { AI_ASSISTANT_V2_TOOLS } from './ai-assistant-v2-data-tools.mjs'
import { AI_READ_TOOL_COLUMNS, aiReadToolDefinitions, aiReadToolRefs, aiReadToolsFor, runAiReadTool } from './ai-read-tool-runner.mjs'
import { runTodayPriorities } from './ai-skill-today-priorities.mjs'
import { buildReorderList } from './reorder-list.mjs'
import { attachReorderPointSuggestions } from './reorder-point-suggestion.mjs'
import { addCalendarDays } from '../../shared/purchase-request-prefill.mjs'
import { buildFirstRunChecklist } from './today-work.mjs'
import { firstRunSetupOptions, readFirstRunSetupCounts } from './first-run-setup.mjs'
import { reportReadAccessFor } from './report-read-access.mjs'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// LDM-001's link to its preferred supplier: 12 days' lead time, a minimum
// order of 100 and a reference price of 95 USD.
const link = (extra = {}) => ({ id: 'ITEM-001::SUP-001', payload: { itemId: 'ITEM-001', supplierId: 'SUP-001', preferred: true, active: true, approved: true, leadTimeDays: 12, minimumOrderQuantity: 100, referencePrice: 95, currency: 'USD', ...extra } })
const V2_ONLY = AI_ASSISTANT_V2_TOOLS.map((tool) => tool.name).filter((name) => name !== 'list_purchase_requests')

// The fixture workspace read as assistant v2 reads it: with the open purchase
// requests. `change` edits the fixture records before they are read.
async function v2({ roleKey = 'workspace-administrator', supplierLinks = [link()], change = null, actor = null, ctx = {} } = {}) {
  const scenario = aiSkillScenario({ roleKey, supplierLinks })
  change?.(scenario.data)
  if (actor) actor(scenario.ctx.aiSkillActor)
  const context = await loadAiSkillContext({ ...scenario.ctx, ...ctx })
  const facts = await readAiSkillFacts(context, { openPurchaseRequests: true })
  const run = async (name, args = {}) => runAiReadTool(name, args, { facts, context, assistantV2: true })
  return { scenario, context, facts, run }
}
// LDM-001 with a reorder point of 200: 200 - 28 available - 70 on PO-001 and
// PO-008 - 50 on PR-001 (submitted) leaves a gap of 52.
const highReorderPoint = (data) => {
  data.items[0].reorderPoint = 200
  data.balances[0].reorderPoint = 200
}

test('the v2 tools are offered to assistant v2 only; the model-first loop keeps its tools', async () => {
  const { facts, context, run } = await v2()
  const modelFirst = aiReadToolsFor(facts, context).map((tool) => tool.name)
  assert.deepEqual(modelFirst, AI_READ_TOOLS.filter((tool) => tool.available(facts, context)).map((tool) => tool.name))
  for (const name of V2_ONLY) assert.ok(!modelFirst.includes(name), `${name} is not offered to the model-first loop`)
  assert.deepEqual((await runAiReadTool('attention_list', {}, { facts, context })), { ok: false, error: 'unknown_tool' })
  const assistant = aiReadToolsFor(facts, context, { assistantV2: true })
  for (const name of V2_ONLY) assert.ok(assistant.some((tool) => tool.name === name), `${name} is offered to assistant v2`)
  // One list_purchase_requests each: v2's, with statuses, replaces the other.
  assert.equal(assistant.filter((tool) => tool.name === 'list_purchase_requests').length, 1)
  assert.ok(assistant.find((tool) => tool.name === 'list_purchase_requests').assistantV2Only)
  assert.ok(aiReadToolDefinitions(facts, { context, assistantV2: true }).every((tool) => tool.input_schema.additionalProperties === false))
  // The model-first tool still lists the requests awaiting approval only.
  const old = (await runAiReadTool('list_purchase_requests', {}, { facts, context })).result
  assert.deepEqual(old.rows.map((row) => row.request), ['PR-001'])
  assert.equal((await runAiReadTool('list_purchase_requests', { status: 'draft' }, { facts, context })).error, 'invalid_arguments')
  assert.deepEqual((await run('list_purchase_requests', { status: 'draft' })).result.rows.map((row) => row.request), ['PR-002'])
})

test('on facts read without the open requests, v2 keeps the model-first request list and refuses to suggest lines', async () => {
  const scenario = aiSkillScenario({ supplierLinks: [link()] })
  scenario.data.items[0].reorderPoint = 200
  scenario.data.balances[0].reorderPoint = 200
  const context = await loadAiSkillContext(scenario.ctx)
  const facts = await readAiSkillFacts(context)
  const offered = aiReadToolsFor(facts, context, { assistantV2: true }).filter((tool) => tool.name === 'list_purchase_requests')
  assert.equal(offered.length, 1)
  assert.ok(!offered[0].assistantV2Only, 'the model-first list stays')
  assert.deepEqual((await runAiReadTool('list_purchase_requests', {}, { facts, context, assistantV2: true })).result.rows.map((row) => row.request), ['PR-001'])
  assert.deepEqual(await runAiReadTool('suggest_purchase_lines', {}, { facts, context, assistantV2: true }), { ok: false, error: 'open_purchase_requests_not_read' })
  // Not offered at all is not allowed; never offered anywhere is unknown.
  assert.deepEqual(await runAiReadTool('list_purchase_requests', {}, { facts: null, context, assistantV2: true }), { ok: false, error: 'not_allowed' })
  assert.deepEqual(await runAiReadTool('made_up', {}, { facts, context, assistantV2: true }), { ok: false, error: 'unknown_tool' })
})

test('the open purchase requests are read only when asked for, so the existing facts stay as they are', async () => {
  const scenario = aiSkillScenario()
  const plain = await readAiSkillFacts(await loadAiSkillContext(scenario.ctx))
  assert.deepEqual(Object.keys(plain.purchaseRequests), ['awaitingApproval'])
  const { facts } = await v2()
  assert.deepEqual(facts.purchaseRequests.awaitingApproval, plain.purchaseRequests.awaitingApproval)
  assert.deepEqual(facts.purchaseRequests.open.map((row) => [row.id, row.status]), [['PR-001', 'submitted'], ['PR-002', 'draft']])
  assert.deepEqual(facts.purchaseRequests.open[0].lines, [{ sku: 'LDM-001', itemId: 'ITEM-001', quantity: 50, unit: 'pcs' }])
})

test('list_purchase_requests filters open requests by status and SKU, soonest required first', async () => {
  const { run } = await v2({ change: (data) => data.purchaseRequests.push({ id: 'PR-003', status: 'approved', priority: 'low', requiredDate: '2026-10-05T12:00:00.000Z', lines: [{ sku: 'LDM-001', itemId: 'ITEM-001', quantity: 10, unit: 'pcs' }, { sku: 'LDM-002', itemId: 'ITEM-002', quantity: 4, unit: 'pcs' }] }, { id: 'PR-004', status: 'converted', lines: [{ sku: 'LDM-001', quantity: 99, unit: 'pcs' }] }) })
  const all = (await run('list_purchase_requests')).result
  assert.deepEqual(all.rows.map((row) => row.request), ['PR-003', 'PR-001', 'PR-002'])
  assert.deepEqual(all.rows[0], {
    request: 'PR-003', status: 'approved', priority: 'low', requiredDate: '2026-10-05', skus: ['LDM-001', 'LDM-002'], lineCount: 2, quantity: null, unit: null,
    lines: [{ sku: 'LDM-001', quantity: 10, unit: 'pcs' }, { sku: 'LDM-002', quantity: 4, unit: 'pcs' }], ref: { type: 'purchase_request', id: 'PR-003', label: 'PR-003' },
  })
  assert.deepEqual((await run('list_purchase_requests', { status: 'approved' })).result.rows.map((row) => row.request), ['PR-003'])
  assert.deepEqual((await run('list_purchase_requests', { sku: 'ldm-002' })).result.rows.map((row) => row.request), ['PR-003'])
  assert.deepEqual((await run('list_purchase_requests', { status: 'submitted', sku: 'LDM-001' })).result.rows.map((row) => row.request), ['PR-001'])
})

test('attention_list wraps today\'s priorities and the open problems, ranked by date, never by a score', async () => {
  const { facts, run } = await v2()
  const today = (await run('attention_list')).result
  const engine = runTodayPriorities(facts, { top: Infinity })
  assert.equal(today.total, engine.total)
  assert.equal(today.rows.length, 5)
  assert.equal(today.more, engine.total - 5)
  assert.deepEqual(today.rows.map((row) => row.ref.id), engine.items.slice(0, 5).map((item) => item.entityId))
  assert.deepEqual(today.rows.map((row) => row.rank), [1, 2, 3, 4, 5])
  assert.deepEqual(today.rows[0], {
    rank: 1, type: 'po_overdue', also: ['po_partially_received'], severity: 'risk', label: 'PO-001', whenKind: 'overdue', days: 4, date: '2026-09-25', supplier: 'Acme Components',
    details: { sku: 'LDM-001', remaining: 30, unit: 'pcs', notSent: false }, ref: { type: 'purchase_order', id: 'PO-001', label: 'PO-001' },
  })
  assert.ok(JSON.stringify(today).indexOf('score') === -1)
  // Up to 10 rows, all of them when fewer.
  assert.equal((await run('attention_list', { limit: 10 })).result.rows.length, engine.total)
  assert.equal((await run('attention_list', { limit: 11 })).error, 'invalid_arguments')

  const problems = (await run('attention_list', { kind: 'problems', limit: 10 })).result
  const dates = problems.rows.map((row) => row.date).filter(Boolean)
  assert.deepEqual(dates, [...dates].sort(), 'the oldest printed date first')
  assert.ok(problems.rows.some((row) => row.type === 'supplier_exposure' && row.ref.type === 'supplier' && row.ref.id === 'SUP-001'))
  assert.ok(problems.rows.every((row) => !['po_due_7d', 'pr_awaiting_approval', 'rfq_ready_to_award'].includes(row.type)))

  // Signal types are filtered before the limit, so the total is theirs.
  const overdue = (await run('attention_list', { types: ['po_overdue'] })).result
  assert.deepEqual(overdue.rows.map((row) => row.label), ['PO-001', 'PO-008'])
  assert.equal(overdue.total, 2)
  assert.equal((await run('attention_list', { types: ['made_up'] })).error, 'invalid_arguments')
})

test('attention_list counts a draft request as cover, as suggest_purchase_lines does, and the skills still do not', async () => {
  const { facts, run } = await v2({ change: (data) => { highReorderPoint(data); data.purchaseRequests[1].lines = [{ id: 'PRL-002', sku: 'LDM-001', itemId: 'ITEM-001', quantity: 60, unit: 'pcs' }] } })
  const stock = (await run('attention_list', { focus: 'LDM-001', limit: 10 })).result.rows.find((row) => row.ref.type === 'item')
  const [suggested] = (await run('suggest_purchase_lines', { skus: ['LDM-001'] })).result.rows
  assert.deepEqual([stock.details.pendingRequests, stock.details.covered], [110, true])
  assert.deepEqual([suggested.openRequests, Boolean(suggested.covered)], [110, true])
  const engine = runTodayPriorities(facts, { top: Infinity }).items.find((item) => item.entityType === 'item' && item.entityId === 'ITEM-001')
  assert.equal(engine.data.pendingRequests, 50)
})

test('attention_list narrows to a purchase order, a SKU or a supplier, and refuses a record it cannot find', async () => {
  const { run } = await v2()
  const item = (await run('attention_list', { focus: 'LDM-001', limit: 10 })).result
  assert.deepEqual(item.focus, { label: 'LDM-001', ref: { type: 'item', id: 'ITEM-001', label: 'LDM-001' } })
  assert.ok(item.rows.length > 0)
  assert.ok(item.rows.every((row) => row.ref.id === 'ITEM-001' || row.details.sku === 'LDM-001'), 'only records tied to LDM-001')
  const order = (await run('attention_list', { focus: 'po 1', limit: 10 })).result
  assert.equal(order.focus.ref.id, 'PO-001')
  assert.ok(order.rows.some((row) => row.ref.id === 'PO-001'))
  const supplier = (await run('attention_list', { focus: 'Acme Components', limit: 10 })).result
  assert.ok(supplier.rows.length > 0 && supplier.rows.every((row) => row.supplier === 'Acme Components'))
  assert.deepEqual(await run('attention_list', { focus: 'Nothing like it' }), { ok: false, error: 'not_found' })
})

test('records_missing_data lists every record and the fields it lacks', async () => {
  const { facts, run } = await v2()
  const all = (await run('records_missing_data')).result
  assert.equal(all.total, facts.records.length)
  assert.deepEqual(all.rows, [
    { type: 'item', label: 'LDM-009', source: 'items', missing: ['unit', 'preferred_supplier', 'stock_threshold'], ref: { type: 'item', id: 'ITEM-009', label: 'LDM-009' } },
    { type: 'purchase_request', label: 'PR-002', source: 'purchase_requests', missing: ['required_date', 'lines'], ref: { type: 'purchase_request', id: 'PR-002', label: 'PR-002' } },
  ])
  assert.deepEqual(all.checked, facts.recordsChecked)
  assert.deepEqual((await run('records_missing_data', { source: 'items' })).result.rows.map((row) => row.label), ['LDM-009'])
})

test('records_missing_data never reports a field hidden from the user as missing', async () => {
  // A submitted invoice with no amount and no supplier.
  const change = (data) => data.supplierInvoices.push({ id: 'INV-009', invoiceNumber: 'INV-009', supplierId: '', supplierName: '', poId: 'PO-001', relatedPo: 'PO-001', currency: 'USD', status: 'submitted', matchStatus: 'pending', amount: null, totalAmount: null, varianceAmount: '0', invoiceDate: '2026-09-28T12:00:00.000Z', createdAt: '2026-09-28T12:00:00.000Z', updatedAt: '2026-09-28T12:00:00.000Z', lines: [] })
  const missingOf = async (options) => (await (await v2({ roleKey: 'finance-specialist', change, ...options })).run('records_missing_data', { source: 'supplier_invoices' })).result.rows.find((row) => row.label === 'INV-009')?.missing || []
  const full = await missingOf()
  assert.ok(full.includes('amount') && full.includes('supplier'), `a reader of amounts and suppliers is told: ${full}`)
  const restricted = await missingOf({ actor: (actor) => { actor.permissionCodes.delete('finance.amounts.read'); actor.permissionCodes.delete('finance.partner_snapshot.read') } })
  assert.ok(!restricted.includes('amount') && !restricted.includes('supplier'), `hidden fields are not reported: ${restricted}`)
})

test('suggest_purchase_lines raises the gap to the minimum order and fills supplier, need-by date and price', async () => {
  const { run } = await v2({ change: highReorderPoint })
  const result = (await run('suggest_purchase_lines')).result
  assert.equal(result.from, 'suggestions')
  assert.equal(result.pricesHidden, false)
  const [row] = result.rows
  assert.deepEqual(row.item, { id: 'ITEM-001', sku: 'LDM-001', name: 'Flow Controller', unit: 'pcs' })
  assert.deepEqual([row.onHand, row.available, row.safetyStock, row.reorderPoint, row.incoming, row.openRequests], [28, 28, 30, 200, 70, 50])
  assert.equal(row.gap, 52)
  assert.deepEqual(row.suggestedQuantity, { value: 100, source: 'raised_to_moq' })
  assert.deepEqual(row.supplier, { id: 'SUP-001', name: 'Acme Components', source: 'preferred_supplier' })
  assert.deepEqual(row.needByDate, { value: '2026-10-11', source: 'lead_time', leadTimeDays: 12, warning: null })
  assert.deepEqual(row.estimatedUnitPrice, { value: 95, currency: 'USD', source: 'reference_price' })
  assert.equal(row.covered, null)
  assert.deepEqual(row.ref, { type: 'item', id: 'ITEM-001', label: 'LDM-001' })
  // Without the submitted request the gap is above the minimum.
  const cancelled = await v2({ change: (data) => { highReorderPoint(data); data.purchaseRequests[0].status = 'cancelled' } })
  assert.deepEqual((await cancelled.run('suggest_purchase_lines')).result.rows[0].suggestedQuantity, { value: 102, source: 'reorder_gap' })
})

// LDM-001 ships 50 a day on 18 days of September: 900 over the 90-day window,
// 10 a day. Lead time 12 days.
const shipping = (data) => {
  data.shipmentLines = Array.from({ length: 18 }, (_, index) => ({ itemId: 'ITEM-001', unit: 'pcs', postedQuantity: 50, shipment: { postedAt: new Date(`2026-09-${String(index + 1).padStart(2, '0')}T16:00:00Z`) } }))
}

// A reader of every warehouse, as the reorder list asks.
const everyWarehouse = (actor) => { actor.allWarehouses = true }

// "Order what we need for the next 2 weeks" (2026-11-04) had no answer.
test('suggest_purchase_lines with coverDays sizes a line from recorded demand and says the basis', async () => {
  const { run } = await v2({ change: shipping, actor: everyWarehouse })
  const result = (await run('suggest_purchase_lines', { skus: ['LDM-001', 'LDM-002'], coverDays: 14 })).result
  assert.equal(result.coverDays, 14)
  const [ldm1, ldm2] = result.rows
  // 10 a day × (12 + 14) + 30 safety = 290; 290 - 28 available - 70 incoming - 50 requested = 142.
  assert.deepEqual(ldm1.cover, { days: 14, basis: 'recorded_demand', averageDailyDemand: 10, demandWindowDays: 90, shipmentDays: 18, leadTimeDays: 12, target: 290 })
  assert.deepEqual(ldm1.suggestedQuantity, { value: 142, source: 'cover_days' })
  // No shipments: the reorder point rule stands, and the row says why.
  assert.equal(ldm2.cover.basis, 'not_enough_shipment_history')
  assert.equal(ldm2.cover.target, null)
  assert.notEqual(ldm2.suggestedQuantity.source, 'cover_days')
  // A short period raised to the supplier's minimum order of 100.
  const short = (await run('suggest_purchase_lines', { skus: ['LDM-001'], coverDays: 3 })).result.rows[0]
  assert.deepEqual([short.cover.target, short.suggestedQuantity], [180, { value: 100, source: 'cover_days_raised_to_moq' }])
  // Without names, an item with recorded demand is suggested though it is above
  // its reorder point once the request is counted.
  const plain = await v2({ change: shipping, actor: everyWarehouse })
  const listed = (await plain.run('suggest_purchase_lines', { coverDays: 30 })).result
  assert.deepEqual(listed.rows.map((row) => [row.item.sku, row.suggestedQuantity.source]), [['LDM-001', 'cover_days']])
  // Without coverDays nothing changes.
  const before = (await plain.run('suggest_purchase_lines', { skus: ['LDM-001'] })).result.rows[0]
  assert.equal(before.cover, undefined)
  assert.equal(before.suggestedQuantity.source, 'covered_by_open_orders')
})

// 2026-11-05: "order 100 instead of 50, is it cheaper?" got the price and the
// cash tied up, never the trade between ordering less often and holding more.
// LDM-001: 10 a day (3,650 a year), reference price 95, minimum order 100.
test('order_quantity_costs weighs orders a year against holding cost, with the assumption it makes', async () => {
  const { run } = await v2({ change: shipping, actor: everyWarehouse })
  const result = (await run('order_quantity_costs', { sku: 'LDM-001', quantities: [200, 100, 50] })).result
  assert.deepEqual([result.unitPrice, result.currency, result.unitPriceSource, result.priceBreaksRecorded], [95, 'USD', 'reference_price', false])
  assert.deepEqual(result.demand, { averageDailyDemand: 10, annualDemand: 3650, basis: 'recorded_demand', windowDays: 90, shipmentDays: 18 })
  assert.deepEqual(result.supplier, { name: 'Acme Components', preferred: true, minimumOrderQuantity: 100, leadTimeDays: 12 })
  // 25% a year of 95 is 23.75 a unit; nothing the user gave.
  assert.deepEqual(result.assumptions, { holdingRatePercent: 25, holdingRateSource: 'assumed_planning_value', holdingCostCovers: ['capital', 'storage', 'insurance', 'obsolescence'], holdingCostPerUnitPerYear: 23.75, costPerOrder: null, costPerOrderSource: 'not_recorded' })
  // Sorted, each with its cycle stock held half the time.
  assert.deepEqual(result.options.map((row) => [row.quantity, row.belowSupplierMinimum, row.orderValue, row.daysOfDemand, row.ordersPerYear, row.averageCycleStock, row.holdingCostPerYear, row.orderingCostPerYear, row.totalCostPerYear]), [
    [50, true, 4750, 5, 73, 25, 593.75, null, null],
    [100, false, 9500, 10, 36.5, 50, 1187.5, null, null],
    [200, false, 19000, 20, 18.3, 100, 2375, null, null],
  ])
  // 100 → 200 saves 18.25 orders for 1,187.50 more holding: worth it above 23.75 × 100 × 200 / (2 × 3,650) = 65.07 an order.
  assert.deepEqual(result.comparisons[1], { smaller: 100, larger: 200, ordersSavedPerYear: 18.3, extraHoldingCostPerYear: 1187.5, breakEvenCostPerOrder: 65.07, cheaperAtUserCostPerOrder: null })
  // EOQ = √(2 × 3,650 × cost / 23.75), never below the minimum order.
  assert.deepEqual(result.economicOrderQuantity, { atUserCostPerOrder: null, examples: [{ costPerOrder: 25, quantity: 100, daysOfDemand: 10, ordersPerYear: 36.5 }, { costPerOrder: 50, quantity: 124, daysOfDemand: 12.4, ordersPerYear: 29.4 }, { costPerOrder: 100, quantity: 175, daysOfDemand: 17.5, ordersPerYear: 20.9 }], raisedToSupplierMinimum: true })
  // With the user's own figures: 20% a year and 80 an order make 200 the cheaper.
  const own = (await run('order_quantity_costs', { sku: 'LDM-001', quantities: [100, 200], holdingRatePercent: 20, costPerOrder: 80 })).result
  assert.deepEqual([own.assumptions.holdingRateSource, own.assumptions.costPerOrderSource, own.assumptions.holdingCostPerUnitPerYear], ['user', 'user', 19])
  assert.deepEqual(own.options.map((row) => [row.holdingCostPerYear, row.orderingCostPerYear, row.totalCostPerYear]), [[950, 2920, 3870], [1900, 1460, 3360]])
  assert.deepEqual([own.comparisons[0].breakEvenCostPerOrder, own.comparisons[0].cheaperAtUserCostPerOrder], [52.05, 200])
  assert.deepEqual(own.economicOrderQuantity, { atUserCostPerOrder: { quantity: 175, daysOfDemand: 17.5, ordersPerYear: 20.9 }, examples: [], raisedToSupplierMinimum: true })
  // An approved supplier by name, and one that is not approved for the item.
  assert.equal((await run('order_quantity_costs', { sku: 'LDM-001', quantities: [100], supplier: 'acme' })).result.supplier.name, 'Acme Components')
  assert.deepEqual(await run('order_quantity_costs', { sku: 'LDM-001', quantities: [100], supplier: 'Northstar' }), { ok: false, error: 'supplier_not_approved_for_item', details: ['Acme Components'] })
  assert.equal((await run('order_quantity_costs', { sku: 'NOPE-1', quantities: [1] })).error, 'not_found')
})

test('order_quantity_costs without recorded demand gives the order values and says why there is no yearly view', async () => {
  const { run } = await v2({ actor: everyWarehouse })
  const result = (await run('order_quantity_costs', { sku: 'LDM-001', quantities: [100, 200] })).result
  assert.deepEqual(result.demand, { averageDailyDemand: null, basis: 'not_enough_shipment_history', windowDays: 90 })
  assert.deepEqual(result.options.map((row) => [row.quantity, row.orderValue, row.ordersPerYear, row.holdingCostPerYear]), [[100, 9500, null, null], [200, 19000, null, null]])
  assert.deepEqual([result.comparisons, result.economicOrderQuantity], [[], null])
})

// 2026-11-05: "what does holding my stock cost me?" got "I can't tell".
test('inventory_value values stock at reference prices and states the holding rate it assumed', async () => {
  const { run, facts } = await v2()
  const result = (await run('inventory_value')).result
  const onHand = Number(facts.inventory.rows.find((row) => row.sku === 'LDM-001').onHand)
  // Only LDM-001 has an approved supplier with a price; the others are counted, not valued.
  assert.deepEqual(result.rows.map((row) => [row.sku, row.onHand, row.unitPrice, row.currency, row.value, row.sharePercent, row.cumulativeSharePercent, row.supplier]), [['LDM-001', onHand, 95, 'USD', onHand * 95, 100, 100, 'Acme Components']])
  assert.deepEqual(result.totals, [{ currency: 'USD', value: onHand * 95, holdingCostPerYear: Math.round(onHand * 95 * 25) / 100, holdingCostPerMonth: Math.round((onHand * 95 * 0.25 / 12) * 100) / 100, holdingCostPerDay: Math.round((onHand * 95 * 0.25 / 365) * 100) / 100 }])
  assert.deepEqual([result.itemsValued, result.itemsWithoutPrice, result.assumptions.holdingRatePercent, result.assumptions.holdingRateSource], [1, result.itemsWithStock - 1, 25, 'assumed_planning_value'])
  assert.equal((await run('inventory_value', { holdingRatePercent: 30 })).result.totals[0].holdingCostPerYear, Math.round(onHand * 95 * 30) / 100)
  assert.equal((await run('inventory_value', { skus: ['NOPE-1'] })).error, 'not_found')
})

// 2026-11-06: multi-item order trade-offs under a budget, minimum orders and
// open orders go to an exact solver (replenishment-solver.mjs). LDM-001:
// 28 on hand + 70 on PO-001 and PO-008 + 50 on PR-001 (submitted) = 148;
// 12 days' lead time + 7 review days; minimum 100 at 95 USD; 50 shipped on
// each of 18 days.
test('optimize_order_plan solves the order from the records and costs it beside no order, the reorder list and the user\'s plan', async () => {
  const { run } = await v2({ change: shipping, actor: everyWarehouse })
  const result = (await run('optimize_order_plan')).result
  assert.equal(result.status, 'optimal')
  assert.deepEqual(result.decision.lines.map((line) => [line.sku, line.quantity, line.unit, line.supplier, line.unitPrice, line.orderValue]), [['LDM-001', 202, 'pcs', 'Acme Components', 95, 19190]])
  assert.deepEqual([result.decision.spend, result.decision.expectedCost, result.decision.savingVsNoOrder], [19190, 414.37, 328.65])
  const [item] = result.items
  assert.deepEqual([item.sku, item.position, item.openRequests, item.cycleDays, item.minimumOrderQuantity, item.minimumOrderValue, item.optimalQuantity, item.reorderListQuantity, item.reason], ['LDM-001', 148, 50, 19, 100, 9500, 202, 0, 'ordered'])
  assert.deepEqual([item.chanceShortNoOrderPercent, item.chanceShortWithOptimalPercent], [52.1, 13.8])
  assert.deepEqual(result.plans.map((plan) => [plan.plan, plan.lines, plan.expectedCost, plan.costAboveOptimal]), [['optimal', 'LDM-001 202', 414.37, 0], ['no_order', '', 743.02, 328.65], ['reorder_list', '', 743.02, 328.65]])
  // What it could not plan, and why; never guessed.
  assert.deepEqual(result.notPlanned, [{ sku: 'LDM-002', reason: 'no_lead_time' }, { sku: 'LDM-003', reason: 'no_item_record' }])
  // The assumptions come back as data, as the other cost tools give them.
  assert.deepEqual(result.assumptions, { holdingRatePercent: 25, holdingRateSource: 'assumed_planning_value', shortageCostMultiple: 5, serviceLevelPercent: 83.3, shortageCostSource: 'assumed_planning_value', reviewDays: 7, reviewDaysSource: 'assumed_planning_value', budgetSource: 'none' })
  assert.deepEqual([result.method.solverStatus, result.method.gapPercent, result.method.scenarios, result.method.costSamples, result.method.demandWindowDays], ['optimal', 0, 200, 20000, 90])
  assert.deepEqual(aiReadToolRefs(result), [{ type: 'item', id: 'ITEM-001', label: 'LDM-001' }])

  // A budget below the minimum order's 9,500: nothing fits, and the result
  // says what lifting the limit would buy.
  const tight = (await run('optimize_order_plan', { budget: 5000 })).result
  assert.deepEqual([tight.decision.lines, tight.items[0].reason], [[], 'cut_by_budget'])
  assert.deepEqual(tight.budget, { amount: 5000, spend: 0, left: 5000, binds: true, spendWithoutLimit: 19190, costWithoutLimit: 414.37, costSavedWithoutLimit: 328.65 })
  assert.deepEqual(tight.plans.map((plan) => plan.plan), ['optimal', 'without_budget_limit', 'no_order', 'reorder_list'])
  // A plan the user proposes, below the minimum order.
  const yours = (await run('optimize_order_plan', { plan: [{ sku: 'ldm-001', quantity: 50 }] })).result
  assert.deepEqual(yours.plans.at(-1), { plan: 'your_plan', lines: 'LDM-001 50', spend: 4750, holdingCost: yours.plans.at(-1).holdingCost, shortageCost: yours.plans.at(-1).shortageCost, expectedCost: 626.06, costAboveOptimal: 211.69, withinBudget: true, overBudgetAmount: null, issues: ['LDM-001 below_minimum_order'] })
  // Over a budget: by how much, so the answer need not work it out.
  assert.equal((await run('optimize_order_plan', { budget: 4000, plan: [{ sku: 'LDM-001', quantity: 100 }] })).result.plans.at(-1).overBudgetAmount, 5500)
  assert.deepEqual([yours.decision.savingVsYourPlan, yours.items[0].planQuantity], [211.69, 50])
  // A service level the user gives sets the shortage cost: 95% is 19 x holding.
  const strict = (await run('optimize_order_plan', { serviceLevelPercent: 95 })).result
  assert.deepEqual([strict.assumptions.shortageCostMultiple, strict.assumptions.shortageCostSource, strict.decision.lines[0].quantity], [19, 'service_level', 452])
  // Lines it cannot plan, and SKUs it does not know.
  assert.deepEqual(await run('optimize_order_plan', { plan: [{ sku: 'LDM-002', quantity: 10 }] }), { ok: false, error: 'cannot_plan_item', details: ['LDM-002: no_lead_time'] })
  assert.equal((await run('optimize_order_plan', { skus: ['NOPE-1'] })).error, 'not_found')
  assert.equal((await run('optimize_order_plan', { plan: [{ sku: 'LDM-001' }] })).error, 'invalid_arguments')
  // A fixed line below the minimum order cannot be planned around.
  const fixed = (await run('optimize_order_plan', { fixedLines: [{ sku: 'LDM-001', quantity: 50 }] })).result
  assert.deepEqual([fixed.status, fixed.reason, fixed.decision], ['infeasible', 'fixed_below_minimum_order', null])
  // Only one supplier's items.
  assert.deepEqual((await run('optimize_order_plan', { supplier: 'acme' })).result.notPlanned, [{ sku: 'LDM-002', reason: 'no_lead_time' }])
})

test('optimize_order_plan refuses what the role may not see, and logs each call for a study when asked', async () => {
  // Prices hidden from the role: no plan can be costed.
  assert.equal((await (await v2({ roleKey: 'read-only-viewer', change: shipping, actor: everyWarehouse })).run('optimize_order_plan')).error, 'prices_hidden')
  // A reader of only some warehouses: the item's demand is the whole workspace's.
  const scoped = await v2({ change: (data) => { shipping(data); data.warehouses = [{ id: 'WH-1' }, { id: 'WH-2' }] }, ctx: { routeContext: { reportReadAccess: { warehouseIds: ['WH-1'] } } } })
  assert.equal((await scoped.run('optimize_order_plan')).error, 'warehouse_scope')
  const folder = mkdtempSync(join(tmpdir(), 'order-plan-log-'))
  try {
    const log = join(folder, 'calls.jsonl')
    const { run } = await v2({ change: shipping, actor: everyWarehouse, ctx: { env: { FLOWCHAIN_REPLENISHMENT_SOLVER_LOG: log } } })
    await run('optimize_order_plan', { budget: 25000 })
    const [line] = readFileSync(log, 'utf8').trim().split('\n').map((entry) => JSON.parse(entry))
    assert.deepEqual([line.caller, line.args, line.options.budget, line.input.items.map((entry) => [entry.sku, entry.openRequests]), line.result.optimal.quantities], ['assistant_v2', { budget: 25000 }, 25000, [['LDM-001', 50]], [202]])
    // And what the model was shown, for the study's "plan given to the LLM" arm.
    assert.deepEqual([line.toolResult.decision.lines.map((entry) => entry.quantity), line.toolResult.budget.binds], [[202], false])
  } finally {
    rmSync(folder, { recursive: true, force: true })
  }
})

test('suggest_purchase_lines with coverDays reads no demand for a reader of only some warehouses', async () => {
  const { run } = await v2({ change: (data) => { shipping(data); data.warehouses = [{ id: 'WH-1' }, { id: 'WH-2' }] }, ctx: { routeContext: { reportReadAccess: { warehouseIds: ['WH-1'] } } } })
  const [row] = (await run('suggest_purchase_lines', { skus: ['LDM-001'], coverDays: 14 })).result.rows
  assert.deepEqual([row.cover.basis, row.cover.averageDailyDemand], ['warehouse_scope', null])
})

// Stock rows that record no unit (the showcase's) left every form line with
// unit null; the item's own stock unit stands in.
test('suggest_purchase_lines gives the item\'s stock unit when the stock row records none', async () => {
  const { run } = await v2({ change: (data) => { highReorderPoint(data); data.balances[0].unit = null } })
  const [row] = (await run('suggest_purchase_lines', { skus: ['LDM-001'] })).result.rows
  assert.equal(row.item.unit, 'pcs')
})

test('suggest_purchase_lines counts a draft request as cover and names what covers the item', async () => {
  const { facts, run } = await v2({ change: (data) => { highReorderPoint(data); data.purchaseRequests[1].lines = [{ id: 'PRL-002', sku: 'LDM-001', itemId: 'ITEM-001', quantity: 60, unit: 'pcs' }] } })
  // The skills still count only the submitted request.
  assert.deepEqual(facts.purchaseRequests.awaitingApproval.map((row) => row.id), ['PR-001'])
  const [row] = (await run('suggest_purchase_lines')).result.rows
  assert.equal(row.openRequests, 110)
  assert.deepEqual(row.suggestedQuantity, { value: null, source: 'covered_by_open_orders' })
  assert.deepEqual(row.covered.by.map((entry) => [entry.label, entry.status, entry.ref.type]), [['PR-001', 'submitted', 'purchase_request'], ['PR-002', 'draft', 'purchase_request'], ['PO-001', 'partially_received', 'purchase_order'], ['PO-008', 'issued', 'purchase_order']])
  assert.ok(aiReadToolRefs((await run('suggest_purchase_lines')).result).some((ref) => ref.id === 'PR-002'))
})

test('suggest_purchase_lines warns when the stock runs short before the need-by date', async () => {
  const { run } = await v2({ change: (data) => { highReorderPoint(data); data.salesOrders[0].promisedDate = '2026-10-01' } })
  const [row] = (await run('suggest_purchase_lines')).result.rows
  // SO-001 takes 35 of the 28 available in the first week; PO-001 and PO-008
  // are past their promised dates, so no arrival is counted.
  assert.deepEqual(row.needByDate, { value: '2026-10-11', source: 'lead_time', leadTimeDays: 12, warning: { code: 'stock_short_before_need_by', weekOf: '2026-09-29' } })
})

test('suggest_purchase_lines returns the items the user named, and leaves the supplier empty when it is not clear', async () => {
  const links = [link({ preferred: false }), { id: 'ITEM-001::SUP-002', payload: { itemId: 'ITEM-001', supplierId: 'SUP-002', preferred: false, active: true, approved: true, leadTimeDays: 5, minimumOrderQuantity: 500 } }]
  const { run } = await v2({ supplierLinks: links, change: (data) => { highReorderPoint(data); data.items[0].preferredSupplierId = null } })
  const named = (await run('suggest_purchase_lines', { skus: ['ldm-001', 'LDM-002'] })).result
  assert.equal(named.from, 'named')
  assert.deepEqual(named.rows.map((row) => row.item.sku), ['LDM-001', 'LDM-002'])
  const [first, second] = named.rows
  // Two approved sources and none preferred: a person chooses; no minimum,
  // lead time or price of a supplier nobody chose is used.
  assert.equal(first.supplier, null)
  assert.deepEqual(first.supplierChoices.map((choice) => choice.id).sort(), ['SUP-001', 'SUP-002'])
  assert.deepEqual(first.suggestedQuantity, { value: 52, source: 'reorder_gap' })
  assert.deepEqual(first.needByDate, { value: null, source: 'lead_time_not_recorded', leadTimeDays: null, warning: null })
  assert.equal(first.estimatedUnitPrice, null)
  // A named item that needs nothing is still returned, saying so.
  assert.deepEqual(second.suggestedQuantity, { value: null, source: 'not_needed' })
  assert.deepEqual(await run('suggest_purchase_lines', { skus: ['NOPE-1'] }), { ok: false, error: 'not_found', details: ['NOPE-1'] })
})

test('suggest_purchase_lines never suggests an item that is not active, and says so for a named one', async () => {
  for (const inactive of [(item) => { item.status = 'inactive' }, (item) => { item.metadata = { inventoryItem: false } }]) {
    const { run } = await v2({ change: (data) => { highReorderPoint(data); inactive(data.items[0]) } })
    const suggested = (await run('suggest_purchase_lines')).result
    assert.deepEqual([suggested.rows, suggested.total], [[], 0])
    const [named] = (await run('suggest_purchase_lines', { skus: ['LDM-001'] })).result.rows
    assert.deepEqual(named.suggestedQuantity, { value: null, source: 'item_inactive' })
    assert.equal(named.covered, null)
  }
})

test('suggest_purchase_lines gives no quantity for a named item with no stock row', async () => {
  const { run } = await v2({ change: (data) => { data.items[2].reorderPoint = 50; data.items[2].safetyStock = 20 } })
  const [row] = (await run('suggest_purchase_lines', { skus: ['LDM-009'] })).result.rows
  assert.deepEqual(row.item, { id: 'ITEM-009', sku: 'LDM-009', name: 'Spare Gasket', unit: null })
  assert.deepEqual([row.onHand, row.available, row.reorderPoint, row.target, row.gap, row.covered], [null, null, null, null, null, null])
  assert.deepEqual(row.suggestedQuantity, { value: null, source: 'no_stock_position' })
})

test('suggest_purchase_lines names as cover only the requests whose lines count towards it', async () => {
  // PR-001 for 110 pcs covers the gap; the draft's line in boxes adds nothing.
  const { run } = await v2({ change: (data) => { highReorderPoint(data); data.purchaseRequests[0].lines[0].quantity = 110; data.purchaseRequests[1].lines = [{ id: 'PRL-002', sku: 'LDM-001', itemId: 'ITEM-001', quantity: 9, unit: 'box' }] } })
  const [row] = (await run('suggest_purchase_lines')).result.rows
  assert.equal(row.openRequests, 110)
  assert.deepEqual(row.covered.by.map((entry) => entry.label), ['PR-001', 'PO-001', 'PO-008'])
})

test('suggest_purchase_lines reads the suppliers of the items it returns only', async () => {
  const { scenario, run } = await v2({ supplierLinks: [link(), { id: 'ITEM-002::SUP-001', payload: { itemId: 'ITEM-002', supplierId: 'SUP-001', preferred: true, active: true, approved: true, leadTimeDays: 5 } }], change: (data) => { highReorderPoint(data); data.items[1].reorderPoint = 500; data.balances[1].reorderPoint = 500 } })
  assert.equal((await run('suggest_purchase_lines')).result.total, 2)
  scenario.calls.prisma.length = 0
  const one = (await run('suggest_purchase_lines', { limit: 1 })).result
  assert.deepEqual([one.rows.length, one.total, one.more], [1, 2, 1])
  assert.equal(scenario.calls.prisma.filter(([model]) => model === 'runtimeRecord').length, 1)
  assert.equal(scenario.calls.prisma.filter(([model]) => model === 'item').length, 1)
})

test('suggest_purchase_lines hides prices and suppliers from roles that may not see them', async () => {
  // A read-only viewer may not see prices: the reference price is null.
  const viewer = await v2({ roleKey: 'read-only-viewer', change: highReorderPoint })
  const shown = (await viewer.run('suggest_purchase_lines')).result
  assert.equal(shown.pricesHidden, true)
  assert.equal(shown.rows[0].estimatedUnitPrice, null)
  assert.equal(shown.rows[0].supplier.id, 'SUP-001')
  // Operations reads stock only: no supplier, no purchase order or request.
  const operations = await v2({ roleKey: 'operations-specialist', change: highReorderPoint })
  const stock = (await operations.run('suggest_purchase_lines')).result
  assert.equal(stock.suppliersHidden, true)
  assert.equal(stock.purchaseRequestsRead, false)
  assert.ok(stock.rows.length > 0 && stock.rows.every((row) => row.supplier === null && row.supplierChoices.length === 0 && row.estimatedUnitPrice === null))
  assert.doesNotMatch(JSON.stringify(stock), /PO-0\d\d|PR-0\d\d|Acme/)
  // Nobody gets a contact's email address.
  const withEmail = await v2({ change: (data) => { highReorderPoint(data); data.suppliers[0].email = 'orders@acme.example'; data.suppliers[0].contactName = 'Ada' } })
  assert.doesNotMatch(JSON.stringify((await withEmail.run('suggest_purchase_lines', { skus: ['LDM-001', 'LDM-002'] })).result), /@|Ada/)
})

test('suggest_purchase_lines reads only the asking user\'s workspace', async () => {
  const { scenario, run } = await v2({ change: highReorderPoint })
  scenario.calls.prisma.length = 0
  assert.equal((await run('suggest_purchase_lines')).ok, true)
  const reads = scenario.calls.prisma.filter(([model]) => ['item', 'runtimeRecord', 'supplier'].includes(model))
  assert.ok(reads.length >= 3)
  assert.ok(reads.every(([, , args]) => args.where.tenantId === AI_SKILL_TENANT))
  // A user of another workspace finds none of this one's items.
  const other = aiSkillScenario({ supplierLinks: [link()] })
  const actor = aiSkillActor('workspace-administrator', AI_SKILL_OTHER_TENANT)
  const context = await loadAiSkillContext({ ...other.ctx, identity: { ...other.ctx.identity, tenantId: AI_SKILL_OTHER_TENANT }, aiSkillActor: actor })
  const facts = await readAiSkillFacts(context, { openPurchaseRequests: true })
  assert.deepEqual(await runAiReadTool('suggest_purchase_lines', { skus: ['LDM-001'] }, { facts, context, assistantV2: true }), { ok: false, error: 'not_found', details: ['LDM-001'] })
  assert.deepEqual((await runAiReadTool('suggest_purchase_lines', {}, { facts, context, assistantV2: true })).result.rows, [])
})

test('reorder_list returns the preferred supplier\'s lead time, id and minimum order, and filters by SKU and supplier', async () => {
  const scenario = aiSkillScenario()
  // The reorder list over the fixture items, LDM-001 at a reorder point of
  // 200 so it is listed (no shipment history), linked to Acme with a lead
  // time of 12 days and a minimum order of 150.
  const items = scenario.data.items.map((row) => ({ ...row, status: 'active', reorderPoint: row.sku === 'LDM-001' ? 200 : row.reorderPoint }))
  const suppliers = scenario.data.suppliers.map((row) => ({ id: row.id, code: row.supplierCode, name: row.name, status: 'active' }))
  const reorderList = { read: async (input) => buildReorderList({ allocationRows: input.allocationRows, items, supplierLinks: [link({ minimumOrderQuantity: 150 })], suppliers, today: input.today, timeZone: input.timeZone, showPurchaseOrders: input.showPurchaseOrders }) }
  const context = await loadAiSkillContext({ ...scenario.ctx, aiReadServices: { reorderList } })
  const facts = await readAiSkillFacts(context)
  const list = (await runAiReadTool('reorder_list', {}, { facts, context })).result
  const row = list.rows.find((entry) => entry.sku === 'LDM-001')
  assert.equal(row.leadTimeDays, 12)
  assert.deepEqual([row.supplier, row.supplierId, row.minimumOrderQuantity, row.moqUnit], ['Acme Components', 'SUP-001', 150, 'pcs'])
  assert.equal(row.shortfall, 102)
  assert.deepEqual([row.requestQuantity, row.raisedToMinimum], [150, true])
  assert.ok(Array.isArray(row.flags) && row.flags.every((flag) => typeof flag.code === 'string'))
  // Every open line counts in the position, late or not, and says whether it is late.
  assert.ok(row.incomingLines.length && row.incomingLines.every((line) => typeof line.late === 'boolean'))
  assert.equal(row.position, row.onHand - row.reserved + row.incomingLines.reduce((sum, line) => sum + line.remaining, 0))
  assert.deepEqual(row.flags.filter((flag) => flag.code === 'po_line_late').map((flag) => flag.orderNumber), row.incomingLines.filter((line) => line.late).map((line) => line.orderNumber))
  assert.deepEqual((await runAiReadTool('reorder_list', { sku: 'ldm-001' }, { facts, context })).result.rows.map((entry) => entry.sku), ['LDM-001'])
  assert.deepEqual((await runAiReadTool('reorder_list', { supplier: 'acme' }, { facts, context })).result.rows.map((entry) => entry.sku), ['LDM-001'])
  assert.deepEqual((await runAiReadTool('reorder_list', { supplier: 'Summit Packaging' }, { facts, context })).result.rows, [])
  assert.equal((await runAiReadTool('reorder_list', { supplier: 'Nobody Ltd' }, { facts, context })).error, 'supplier_not_found')
})

test('reorder_list carries the suggested reorder point beside the recorded one, with what it rests on', async () => {
  const scenario = aiSkillScenario()
  const items = scenario.data.items.map((row) => ({ ...row, status: 'active', reorderPoint: row.sku === 'LDM-001' ? 200 : row.reorderPoint }))
  const suppliers = scenario.data.suppliers.map((row) => ({ id: row.id, code: row.supplierCode, name: row.name, status: 'active' }))
  // LDM-001 shipped 15 on each of the 90 days before today; Acme's lead time
  // is 12 days, so 19 days (12 + 7) of it is 285, above the recorded 200.
  const reorderList = {
    read: async (input) => {
      const shipmentLines = Array.from({ length: 90 }, (_, index) => ({ itemId: 'ITEM-001', unit: 'pcs', quantity: 15, postedAt: `${addCalendarDays(input.today, -90 + index)}T16:00:00Z` }))
      return attachReorderPointSuggestions(buildReorderList({ allocationRows: input.allocationRows, items, shipmentLines, supplierLinks: [link()], suppliers, today: input.today, timeZone: input.timeZone, showPurchaseOrders: input.showPurchaseOrders }), shipmentLines)
    },
  }
  const context = await loadAiSkillContext({ ...scenario.ctx, aiReadServices: { reorderList } })
  const facts = await readAiSkillFacts(context)
  const row = (await runAiReadTool('reorder_list', { sku: 'LDM-001' }, { facts, context })).result.rows[0]
  assert.deepEqual([row.reorderPoint, row.suggestedReorderPoint], [200, 285])
  const { basis, ...suggestion } = row.reorderPointSuggestion
  assert.deepEqual(suggestion, { recordedBelow: true, coverDays: 19, leadTimeDays: 12, reviewDays: 7, shipmentDays: 90, reason: null })
  assert.match(basis, /next 19 days \(lead time 12 \+ 7 review days\) in 5 of 6 past 19-day stretches/)
  // The rule's own figures are as without the suggestion.
  assert.equal(row.shortfall, 102)
})

// The services the read tools call, recorded, so every declared table has rows.
const RECORDED_SERVICES = {
  receivables: {
    listReceivables: async () => ({ total: 1, items: [{ id: 'AR-1', obligationNumber: 'AR-0001', customerInvoiceNumber: 'CI-0001', customerName: 'Redwood Retail', outstandingAmount: '100.00', paidAmount: '0.00', originalAmount: '100.00', currency: 'USD', dueDate: '2026-10-10', status: 'open', disputeStatus: 'none' }] }),
    aging: async () => ({ asOf: '2026-09-29', groups: [{ currency: 'USD', current: '100.00', '1_30': '0.00', '31_60': '0.00', '61_90': '0.00', '90_plus': '0.00', total: '100.00', count: 1 }] }),
  },
  contracts: { list: async () => ({ contracts: [{ id: 'CON-1', number: 'CON-0001', title: 'Flow controllers 2026', externalReference: 'ACME-MSA-7', type: 'supply', state: 'active', startDate: '2026-01-01', endDate: '2026-12-31', signedOn: '2025-12-15', noticeDays: 60, totalValue: '125000.0000', currency: 'USD', supplierId: 'SUP-001', supplierName: 'Acme Components' }] }) },
  priceHistory: {
    read: async () => ({ histories: [{ unit: 'pcs', currency: 'USD', status: 'ok', earlier: [{ unitPrice: '100', currency: 'USD', unit: 'pcs', orderedQuantity: 50, date: '2026-09-08', orderNumber: 'PO-001', supplierName: 'Acme Components', purchaseOrderId: 'PO-001' }] }] }),
    lastOrders: async () => ({ lastOrders: [{ supplierId: 'SUP-001', orderNumber: 'PO-008', day: '2026-09-13', purchaseOrderId: 'PO-008' }] }),
  },
  knowledge: {
    list: async () => ({ items: [{ id: 'DOC-1', title: 'Purchasing Policy', language: 'en-US' }] }),
    documents: async () => [{ pageContent: 'Escalate to the buyer manager when a supplier is 3 business days past the promised date.', metadata: { id: 'DOC-1-0', documentId: 'DOC-1', title: 'Purchasing Policy', heading: 'Follow-up and escalation', position: 0, language: 'en-US', contentHash: 'h1' } }],
  },
  // The RFQ page's comparison, as rfq-supplier-comparison-service.mjs returns it.
  rfqComparison: {
    getComparison: async (rfqId) => ({
      rfqId,
      responses: [{
        supplierId: 'SUP-002', supplierName: 'Summit Packaging',
        latestRevision: { currency: 'USD', validUntil: '2026-11-30T00:00:00.000Z', deliveryDate: '2026-11-20T00:00:00.000Z', lines: [{ sku: 'LDM-001', quantity: '50', unit: 'pcs', unitPrice: '92.5', deliveryDate: null }] },
      }],
      nonResponseParticipants: [{ supplierId: 'SUP-001', supplierName: 'Acme Components' }],
    }),
  },
}

test('every data tool declares its columns, and each declared column is in its result', async () => {
  const names = new Set([...AI_READ_TOOLS, ...AI_ASSISTANT_V2_TOOLS].map((tool) => tool.name))
  assert.deepEqual([...names].sort(), Object.keys(AI_READ_TOOL_COLUMNS).sort())
  const scenario = aiSkillScenario()
  const items = scenario.data.items.map((row) => ({ ...row, status: 'active', reorderPoint: row.sku === 'LDM-001' ? 200 : row.reorderPoint }))
  const suppliers = scenario.data.suppliers.map((row) => ({ id: row.id, code: row.supplierCode, name: row.name, status: 'active' }))
  const reorderList = { read: async (input) => buildReorderList({ allocationRows: input.allocationRows, items, supplierLinks: [link()], suppliers, today: input.today, timeZone: input.timeZone, showPurchaseOrders: input.showPurchaseOrders }) }
  const { facts, context, run } = await v2({ change: (data) => { highReorderPoint(data); shipping(data) }, actor: everyWarehouse, ctx: { env: { FLOWCHAIN_ENABLE_CONTRACTS: 'true' }, aiReadServices: { ...RECORDED_SERVICES, reorderList } } })
  // The calls that fill each table; a tool not named here is called once
  // without arguments.
  const calls = {
    get_purchase_order: [{ order: 'PO-001' }, { order: 'PO-002' }],
    list_supplier_invoices: [{ kind: 'differences' }],
    spend_analysis: [{}, { view: 'trend' }, { supplier: 'Acme Components' }],
    supplier_performance: [{ suppliers: ['Acme Components'] }],
    stock_projection: [{ sku: 'LDM-001' }],
    late_order_impact: [{ orders: ['PO-001'] }],
    calculate: [{ operation: 'percent', values: [1, 2] }],
    search_records: [{ query: 'LDM' }],
    list_receivables: [{}, { view: 'aging' }],
    price_history: [{ sku: 'LDM-001' }],
    search_documents: [{ query: 'supplier past the promised date escalate' }],
    // A row's details depend on its signal: today's list and the problems
    // between them hold every detail column.
    attention_list: [{ limit: 10 }, { kind: 'problems', limit: 10 }],
    item_suppliers: [{ sku: 'LDM-001' }],
    rfq_quotes: [{}],
    order_quantity_costs: [{ sku: 'LDM-001', quantities: [50, 100] }],
    optimize_order_plan: [{ plan: [{ sku: 'LDM-001', quantity: 100 }] }],
  }
  // A nested column under a null value (a rate with too few deliveries) is
  // there, and null. Each column must be in a row of one of the tool's calls.
  const at = (value, path) => (path ? path.split('.').reduce((entry, key) => (entry === null || entry === undefined ? entry : entry[key]), value) : value)
  const checked = new Set()
  for (const tool of aiReadToolsFor(facts, context, { assistantV2: true })) {
    const seen = new Map()
    for (const args of calls[tool.name] || [{}]) {
      const output = await run(tool.name, args)
      assert.ok(output.ok, `${tool.name} ${JSON.stringify(args)}: ${output.error}`)
      for (const [path, columns] of Object.entries(AI_READ_TOOL_COLUMNS[tool.name])) {
        const rows = path ? at(output.result, path) : [output.result]
        if (!Array.isArray(rows) || !rows.length) continue
        if (!seen.has(path)) seen.set(path, new Set())
        for (const column of columns) if (rows.some((row) => at(row, column) !== undefined)) seen.get(path).add(column)
        checked.add(`${tool.name} ${path}`)
      }
    }
    for (const [path, columns] of Object.entries(AI_READ_TOOL_COLUMNS[tool.name])) {
      if (!seen.has(path)) continue
      for (const column of columns) assert.ok(seen.get(path).has(column), `${tool.name} ${path} has ${column}`)
    }
  }
  // Every declared table, of every tool, had rows to check.
  const declared = Object.entries(AI_READ_TOOL_COLUMNS).flatMap(([name, tables]) => Object.keys(tables).map((path) => `${name} ${path}`))
  assert.deepEqual([...checked].sort(), declared.sort())
})

test('setup_status reports the first-day checklist exactly as Today builds it, with the item gaps', async () => {
  const env = { FLOWCHAIN_ENABLE_DATA_IMPORT: 'true', FLOWCHAIN_PERSISTENCE_MODE: 'database' }
  const { context, run } = await v2({ ctx: { env } })
  const result = (await run('setup_status')).result
  // The fixture: 3 items, 2 suppliers, 2 items in stock, no customers, one user.
  assert.deepEqual(result.steps.map((step) => [step.id, step.done, step.count]), [['items', true, 3], ['suppliers', true, 2], ['customers', false, 0], ['opening_stock', true, 2], ['teammates', false, 0]])
  assert.deepEqual([result.open, result.done, result.total, result.importOn], [true, 3, 5, true])
  // An administrator may do every step; with import on, each step opens the import page for its type.
  assert.deepEqual(result.steps.map((step) => [step.blocked, step.href]), [
    [null, '/app/master-data/import?type=items'], [null, '/app/master-data/import?type=suppliers'], [null, '/app/master-data/import?type=customers'],
    [null, '/app/master-data/import?type=opening-stock'], [null, '/app/settings/roles'],
  ])
  // The same counts and options give Today's checklist, step for step.
  const today = buildFirstRunChecklist(await readFirstRunSetupCounts(context.prisma, { tenantId: context.tenantId, now: context.now }), firstRunSetupOptions(reportReadAccessFor(context.actor), env))
  assert.deepEqual(result.steps, today.steps)
  // LDM-009 has no unit, preferred supplier or threshold: what records_missing_data reports.
  assert.deepEqual(result.gaps, { checked: 3, unit: 1, preferredSupplier: 1, thresholds: 1 })
  // How much the chat takes at once, so an answer can state it from a result.
  assert.deepEqual(result.limits, { pasteCharacters: 8000, setupCardRows: 25 })
  assert.deepEqual(aiReadToolRefs(result), [])
})

test('setup_status: without import a step opens its own page; a role that may not do a step gets no link; a read failure is an error', async () => {
  const plain = (await (await v2()).run('setup_status')).result
  assert.deepEqual(plain.steps.map((step) => step.href), ['/app/master-data/items', '/app/master-data/suppliers', '/app/master-data/customers', null, '/app/settings/roles'])
  assert.equal(plain.steps.find((step) => step.id === 'opening_stock').blocked, 'unavailable')
  assert.equal(plain.importOn, false)
  const viewer = (await (await v2({ roleKey: 'read-only-viewer' })).run('setup_status')).result
  assert.ok(viewer.steps.every((step) => step.href === null && step.blocked === 'permission'))
  // Every step done: the checklist is closed but still reported.
  // One model of the stand-in database answered differently.
  const swapped = (prisma, model, methods) => new Proxy({}, { get: (_target, key) => (key === model ? new Proxy({}, { get: (_inner, method) => methods[method] || prisma[model][method] }) : prisma[key]) })
  const done = await v2({ change: (data) => { data.customers = [{ id: 'CUST-1' }] } })
  const all = (await runAiReadTool('setup_status', {}, { facts: done.facts, context: { ...done.context, prisma: swapped(done.context.prisma, 'user', { count: async () => 2 }) }, assistantV2: true })).result
  assert.deepEqual([all.open, all.done], [false, 5])
  const broken = await v2()
  assert.deepEqual(await runAiReadTool('setup_status', {}, { facts: broken.facts, context: { ...broken.context, prisma: swapped(broken.context.prisma, 'supplier', { count: async () => { throw new Error('down') } }) }, assistantV2: true }), { ok: false, error: 'setup_counts_unavailable' })
})

// A supplier switch was judged without the other supplier's terms, and open
// quotes were out of reach (2026-11-05).
test('item_suppliers gives an item\'s approved suppliers with lead time, minimum and reference price', async () => {
  const { run } = await v2()
  const output = await run('item_suppliers', { sku: 'LDM-001' })
  assert.ok(output.ok, output.error)
  const [first] = output.result.suppliers
  assert.equal(output.result.sku, 'LDM-001')
  assert.equal(first.preferred, true)
  assert.equal(first.name, 'Acme Components')
  assert.equal(first.leadTimeDays, 12)
  assert.equal(typeof first.referencePrice, 'number')
  assert.deepEqual(first.ref, { type: 'supplier', id: 'SUP-001', label: 'Acme Components' })
  assert.equal((await run('item_suppliers', { sku: 'NOPE-9' })).error, 'not_found')
})

test('rfq_quotes reads each open RFQ\'s latest quotes through the RFQ comparison, only for a user who may see prices', async () => {
  const { run, context, facts } = await v2({ ctx: { aiReadServices: RECORDED_SERVICES } })
  const output = await run('rfq_quotes', {})
  assert.ok(output.ok, output.error)
  assert.deepEqual(output.result.rows[0], { rfq: output.result.rfqs[0].rfq, supplier: 'Summit Packaging', sku: 'LDM-001', quantity: 50, unit: 'pcs', unitPrice: 92.5, currency: 'USD', deliveryDate: '2026-11-20', validUntil: '2026-11-30', ref: output.result.rfqs[0].ref })
  assert.deepEqual(output.result.rfqs[0].notQuoted, ['Acme Components'])
  const tool = AI_ASSISTANT_V2_TOOLS.find((entry) => entry.name === 'rfq_quotes')
  assert.equal(tool.available(facts, context), true)
  assert.equal(tool.available(facts, { ...context, actor: { ...context.actor, permissionCodes: new Set() } }), false)
})
