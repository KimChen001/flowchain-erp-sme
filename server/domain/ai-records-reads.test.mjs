import test from 'node:test'
import assert from 'node:assert/strict'
import { aiSkillScenario } from './test-fixtures/ai-skill-scenario.mjs'
import { loadAiSkillContext } from './ai-skill-context.mjs'
import { openSalesOrdersOf, readAiSkillFacts } from './ai-skill-readers.mjs'
import { runAiReadTool } from './ai-read-tool-runner.mjs'
import { mapPurchaseRequest } from '../repositories/db-procurement-read-repository.mjs'

// 2026-11-20 question set: records the chat could not read. Two of six
// orders still to ship were missing (outside the latest 500 orders), a
// reserved line read as nothing to ship, rejected requests came without
// their reason, and reviewed invoice differences were not visible.

test('open orders outside the listed ones are read by id, for a reader of every warehouse', async () => {
  const reads = []
  const prisma = { salesOrder: { findMany: async ({ where }) => { reads.push(where); return where.id.in.includes('SO-2') ? [{ id: 'SO-2', orderNumber: 'SO-202611-0002', lines: [] }] : [] } } }
  const listed = [{ id: 'SO-1', orderNumber: 'SO-202611-0001' }, { id: 'SO-9', orderNumber: 'SO-202611-0009' }]
  const openIds = new Set(['SO-1', 'SO-2'])
  const every = await openSalesOrdersOf({ listed, openIds, prisma, tenantId: 'T' })
  assert.deepEqual(every.map((row) => row.id), ['SO-1', 'SO-2'])
  assert.deepEqual(reads, [{ tenantId: 'T', id: { in: ['SO-2'] } }])
  // A reader of some warehouses keeps the scoped list; nothing missing, no read.
  assert.deepEqual((await openSalesOrdersOf({ listed, openIds, prisma, tenantId: 'T', someWarehouses: true })).map((row) => row.id), ['SO-1'])
  reads.length = 0
  assert.deepEqual((await openSalesOrdersOf({ listed, openIds: new Set(['SO-1']), prisma, tenantId: 'T' })).map((row) => row.id), ['SO-1'])
  assert.equal(reads.length, 0)
  // A failing read keeps the listed ones.
  const failing = { salesOrder: { findMany: async () => { throw new Error('down') } } }
  assert.deepEqual((await openSalesOrdersOf({ listed, openIds, prisma: failing, tenantId: 'T' })).map((row) => row.id), ['SO-1'])
})

test('list_sales_orders gives each line still to ship and reserved; a reserved order is still to ship', async () => {
  const scenario = aiSkillScenario()
  scenario.data.salesOrders.push(
    { id: 'SO-002', salesOrderId: 'SO-002', workflowStatus: 'confirmed', status: 'confirmed', customerName: 'Harbor Goods', currency: 'USD', promisedDate: '2026-10-01', lines: [{ sku: 'LDM-001', orderedQuantity: 20, fulfilledQuantity: 0, reservedQuantity: 20 }] },
    { id: 'SO-003', salesOrderId: 'SO-003', workflowStatus: 'confirmed', status: 'confirmed', fulfillmentStatus: 'partially_fulfilled', customerName: 'Pine Street', currency: 'USD', promisedDate: '2026-10-02', lines: [{ sku: 'LDM-001', orderedQuantity: 12, fulfilledQuantity: 12, reservedQuantity: 0 }, { sku: 'LDM-002', orderedQuantity: 8, fulfilledQuantity: 2, reservedQuantity: 6 }] },
  )
  const context = await loadAiSkillContext(scenario.ctx)
  const facts = await readAiSkillFacts(context, { openPurchaseRequests: true })
  const result = (await runAiReadTool('list_sales_orders', {}, { facts, context })).result
  const byNumber = Object.fromEntries(result.rows.map((row) => [row.orderNumber, row]))
  assert.match(result.note, /stillToShip/)
  assert.deepEqual(byNumber['SO-001'].lines, [{ sku: 'LDM-001', stillToShip: 35, reserved: 0, notShippedOrReserved: 35 }])
  // Reserved in full: nothing left to reserve, all of it still to ship.
  assert.deepEqual(byNumber['SO-002'].lines, [{ sku: 'LDM-001', stillToShip: 20, reserved: 20, notShippedOrReserved: 0 }])
  // Partly shipped: the shipped line has nothing left; the other is reserved.
  assert.equal(byNumber['SO-003'].status, 'partially_shipped')
  assert.deepEqual(byNumber['SO-003'].lines, [{ sku: 'LDM-001', stillToShip: 0, reserved: 0, notShippedOrReserved: 0 }, { sku: 'LDM-002', stillToShip: 6, reserved: 6, notShippedOrReserved: 0 }])
})

// #430 review: the shared request mapper (and the legacy route that uses it
// without a permission check) gives no reason; the assistant reads it from
// the request records itself.
test('the shared request mapper gives no decision reason', () => {
  const mapped = mapPurchaseRequest({ id: 'PR-7', number: 'PR-202611-0007', status: 'rejected', metadata: { lastAction: 'reject', lastReason: 'Not needed now.', timeline: [{ action: 'reject', at: '2026-11-12T10:30:00Z' }] }, lines: [] })
  assert.equal('lastReason' in mapped, false)
  assert.equal(JSON.stringify(mapped).includes('Not needed now.'), false)
})

test('list_purchase_requests gives the rejected and cancelled requests with their reason, capped', async () => {
  const scenario = aiSkillScenario()
  scenario.data.purchaseRequests.push(
    { id: 'PR-007', number: 'PR-202611-0007', status: 'rejected', lines: [{ id: 'PRL-007', sku: 'LDM-002', quantity: 30, unit: 'pcs' }] },
    { id: 'PR-008', number: 'PR-202611-0008', status: 'cancelled', lines: [{ id: 'PRL-008', sku: 'LDM-001', quantity: 10, unit: 'pcs' }] },
  )
  const long = `No longer needed. ${'x'.repeat(400)}`
  const records = {
    'PR-007': { lastAction: 'reject', lastReason: 'Not needed now: stock and open orders cover it.', timeline: [{ action: 'submit', at: '2026-09-18T09:00:00Z' }, { action: 'reject', at: '2026-09-20T10:00:00Z' }] },
    'PR-008': { lastAction: 'cancel', lastReason: long, timeline: [{ action: 'cancel', at: '2026-09-22T10:00:00Z' }] },
  }
  const asked = []
  const purchaseRequest = { findMany: async ({ where }) => { asked.push(where); return where.id.in.map((id) => ({ id, metadata: records[id] || null })) } }
  const loaded = await loadAiSkillContext(scenario.ctx)
  const context = { ...loaded, prisma: new Proxy(loaded.prisma, { get: (target, key) => (key === 'purchaseRequest' ? purchaseRequest : target[key]) }) }
  const facts = await readAiSkillFacts(context, { openPurchaseRequests: true })
  const run = async (args) => (await runAiReadTool('list_purchase_requests', args, { facts, context })).result
  const all = await run({})
  assert.deepEqual([all.closed.rejected, all.closed.cancelled], [1, 1])
  assert.deepEqual(all.closed.latest.map((row) => [row.request, row.status, row.decidedOn, row.skus]), [
    ['PR-202611-0008', 'cancelled', '2026-09-22', ['LDM-001']],
    ['PR-202611-0007', 'rejected', '2026-09-20', ['LDM-002']],
  ])
  assert.equal(all.closed.latest[1].reason, 'Not needed now: stock and open orders cover it.')
  // Free text a person wrote, capped like any text a tool returns.
  assert.ok(all.closed.latest[0].reason.length <= 200 && all.closed.latest[0].reason.startsWith('No longer needed.'))
  // Only the closed requests' records are read.
  assert.deepEqual(asked.map((where) => [...where.id.in].sort()), [['PR-007', 'PR-008']])
  // Not in the open list itself, and not beside a status or SKU filter.
  assert.equal(all.rows.some((row) => ['rejected', 'cancelled'].includes(row.status)), false)
  assert.equal((await run({ status: 'submitted' })).closed, undefined)
})

test('list_supplier_invoices says how many differences were reviewed, and the latest', async () => {
  const scenario = aiSkillScenario()
  const base = await loadAiSkillContext(scenario.ctx)
  const facts = await readAiSkillFacts(base)
  const asked = []
  const financeMatchException = { findMany: async (query) => { asked.push(query.where); return [
    { supplierInvoiceId: 'SI-2', status: 'approved', exceptionType: 'price_variance', resolvedAt: new Date('2026-09-25T10:00:00Z'), supplierInvoice: { invoiceNumber: 'INV-SUP-22-0049' } },
    { supplierInvoiceId: 'SI-2', status: 'approved', exceptionType: 'quantity_variance', resolvedAt: new Date('2026-09-25T09:00:00Z'), supplierInvoice: { invoiceNumber: 'INV-SUP-22-0049' } },
    { supplierInvoiceId: 'SI-1', status: 'rejected', exceptionType: 'price_variance', resolvedAt: new Date('2026-09-20T10:00:00Z'), supplierInvoice: { invoiceNumber: 'INV-SUP-22-0031' } },
  ] } }
  const prisma = new Proxy(base.prisma, { get: (target, key) => (key === 'financeMatchException' ? financeMatchException : target[key]) })
  const context = { ...base, prisma }
  const summary = (await runAiReadTool('list_supplier_invoices', { kind: 'summary' }, { facts, context })).result.summary
  assert.equal(summary.reviewedDifferences.invoices, 2)
  assert.deepEqual([summary.reviewedDifferences.latest.invoice, summary.reviewedDifferences.latest.decision, summary.reviewedDifferences.latest.reviewedOn], ['INV-SUP-22-0049', 'approved', '2026-09-25'])
  // Only decisions a person took (approved or rejected), never a cancellation.
  assert.deepEqual(asked[0].status, { in: ['approved', 'rejected'] })
  // Without the records, no figure.
  const none = (await runAiReadTool('list_supplier_invoices', { kind: 'summary' }, { facts, context: base })).result.summary
  assert.equal('reviewedDifferences' in none, false)
})

// #430 review: reviews only for a reader of the match, as the match
// exceptions page; open orders past the read bound are said, not dropped.
test('reviewed differences need the match permission; orders past the bound are said', async () => {
  const scenario = aiSkillScenario()
  const base = await loadAiSkillContext(scenario.ctx)
  const facts = await readAiSkillFacts(base)
  const financeMatchException = { findMany: async () => [{ supplierInvoiceId: 'SI-1', status: 'approved', exceptionType: 'price_variance', resolvedAt: new Date('2026-09-25T10:00:00Z'), supplierInvoice: { invoiceNumber: 'INV-1' } }] }
  const prisma = new Proxy(base.prisma, { get: (target, key) => (key === 'financeMatchException' ? financeMatchException : target[key]) })
  const codes = new Set([...base.actor.permissionCodes].filter((code) => code !== 'finance.three_way_match.read'))
  const withoutMatch = { ...base, prisma, actor: { ...base.actor, permissionCodes: codes } }
  const summary = (await runAiReadTool('list_supplier_invoices', { kind: 'summary' }, { facts, context: withoutMatch })).result.summary
  assert.equal('reviewedDifferences' in summary, false)
  // Over 500 reviews: the count says it covers the latest ones.
  const many = Array.from({ length: 501 }, (_, index) => ({ supplierInvoiceId: `SI-${index}`, status: 'approved', exceptionType: 'price_variance', resolvedAt: new Date('2026-09-25T10:00:00Z'), supplierInvoice: { invoiceNumber: `INV-${index}` } }))
  const busy = new Proxy(base.prisma, { get: (target, key) => (key === 'financeMatchException' ? { findMany: async () => many } : target[key]) })
  const cut = (await runAiReadTool('list_supplier_invoices', { kind: 'summary' }, { facts, context: { ...base, prisma: busy } })).result.summary.reviewedDifferences
  assert.deepEqual([cut.invoices, cut.partial], [500, { limit: 500 }])
  // Open orders past the by-id bound.
  const openIds = new Set(Array.from({ length: 205 }, (_, index) => `SO-${index}`))
  const orders = await openSalesOrdersOf({ listed: [], openIds, prisma: { salesOrder: { findMany: async ({ where }) => where.id.in.map((id) => ({ id })) } }, tenantId: 'T' })
  assert.deepEqual([orders.length, orders.notRead], [200, 5])
})
