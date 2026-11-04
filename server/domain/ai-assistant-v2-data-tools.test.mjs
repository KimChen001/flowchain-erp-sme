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
}

test('every data tool declares its columns, and each declared column is in its result', async () => {
  const names = new Set([...AI_READ_TOOLS, ...AI_ASSISTANT_V2_TOOLS].map((tool) => tool.name))
  assert.deepEqual([...names].sort(), Object.keys(AI_READ_TOOL_COLUMNS).sort())
  const scenario = aiSkillScenario()
  const items = scenario.data.items.map((row) => ({ ...row, status: 'active', reorderPoint: row.sku === 'LDM-001' ? 200 : row.reorderPoint }))
  const suppliers = scenario.data.suppliers.map((row) => ({ id: row.id, code: row.supplierCode, name: row.name, status: 'active' }))
  const reorderList = { read: async (input) => buildReorderList({ allocationRows: input.allocationRows, items, supplierLinks: [link()], suppliers, today: input.today, timeZone: input.timeZone, showPurchaseOrders: input.showPurchaseOrders }) }
  const { facts, context, run } = await v2({ change: highReorderPoint, ctx: { env: { FLOWCHAIN_ENABLE_CONTRACTS: 'true' }, aiReadServices: { ...RECORDED_SERVICES, reorderList } } })
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
  }
  // A nested column under a null value (a rate with too few deliveries) is
  // there, and null.
  const at = (value, path) => (path ? path.split('.').reduce((entry, key) => (entry === null || entry === undefined ? entry : entry[key]), value) : value)
  const checked = new Set()
  for (const tool of aiReadToolsFor(facts, context, { assistantV2: true })) {
    for (const args of calls[tool.name] || [{}]) {
      const output = await run(tool.name, args)
      assert.ok(output.ok, `${tool.name} ${JSON.stringify(args)}: ${output.error}`)
      for (const [path, columns] of Object.entries(AI_READ_TOOL_COLUMNS[tool.name])) {
        const rows = path ? at(output.result, path) : [output.result]
        if (!Array.isArray(rows) || !rows.length) continue
        for (const column of columns) assert.ok(rows.some((row) => at(row, column) !== undefined), `${tool.name} ${path} has ${column}`)
        checked.add(`${tool.name} ${path}`)
      }
    }
  }
  // Every declared table, of every tool, had rows to check.
  const declared = Object.entries(AI_READ_TOOL_COLUMNS).flatMap(([name, tables]) => Object.keys(tables).map((path) => `${name} ${path}`))
  assert.deepEqual([...checked].sort(), declared.sort())
})
