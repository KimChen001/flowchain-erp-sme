import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { supplierReliabilityResponseSchema } from '../../shared/supplier-reliability-contract.mjs'
import { buildSupplierReliability, createSupplierReliabilityReadService, supplierReplyOutcome } from './supplier-reliability.mjs'
import { buildSupplierScorecard } from './supplier-scorecard.mjs'

const window = { from: '2026-08-23', to: '2026-11-20' }
const visible = { revisions: true, replies: true }
const at = (day) => new Date(`${day}T12:00:00Z`)
// An issued order whose one line is dated `day` (its original promise).
const order = (id, supplierId, day, extra = {}) => ({
  id, supplierId, status: 'issued', expectedDate: null, issuedAt: at('2026-08-01'), metadata: {},
  lines: [{ id: `${id}-L1`, originalPromisedDate: day ? at(day) : null, metadata: { promisedDate: extra.current || day }, receivedQuantity: 0 }],
  ...extra,
})
const revision = (purchaseOrderId, previous, next, source = 'purchase_order_promise_dates') => ({ purchaseOrderId, previousDate: previous ? at(previous) : null, newDate: at(next), source })
const reply = (supplierId, state, extra = {}) => ({ supplierId, state, readingStatus: 'read', check: { lines: [] }, reasonCode: null, editedLines: 0, createdAt: at('2026-11-10'), decidedAt: null, ...extra })
const build = (rows) => supplierReliabilityResponseSchema.parse(buildSupplierReliability({ suppliers: [{ id: 'acme' }, { id: 'quiet' }], window, asOf: window.to, visibility: visible, ...rows }))

test('revisions count changes only: a first promise and a same-day row are not revisions', () => {
  const result = build({
    purchaseOrders: [order('PO-1', 'acme', '2026-11-01')],
    revisions: [revision('PO-1', null, '2026-11-01'), revision('PO-1', '2026-11-01', '2026-11-01'), revision('PO-1', '2026-11-01', '2026-11-08')],
  })
  const row = result.suppliers.acme.revisions
  assert.deepEqual([row.orders, row.revisedOrders, row.revisions], [1, 1, 1])
  // One order and one revision: under the minimum sample, so no rate or average.
  assert.deepEqual([row.perOrder, row.averageDaysMoved, row.movedLater], [null, null, { count: 1, of: 1, share: null }])
})

test('every source counts, later is positive, and the figures appear from the minimum sample of 5', () => {
  const purchaseOrders = ['PO-1', 'PO-2', 'PO-3', 'PO-4', 'PO-5', 'PO-6'].map((id) => order(id, 'acme', '2026-11-01'))
  const revisions = [
    revision('PO-1', '2026-11-01', '2026-11-08'),
    revision('PO-1', '2026-11-08', '2026-11-11', 'supplier_reply'),
    revision('PO-2', '2026-11-01', '2026-10-30', 'supplier_reply'),
    revision('PO-3', '2026-11-01', '2026-11-05'),
    revision('PO-4', '2026-11-01', '2026-11-03'),
  ]
  const row = build({ purchaseOrders, revisions }).suppliers.acme.revisions
  assert.deepEqual([row.orders, row.revisedOrders, row.revisions], [6, 4, 5])
  assert.equal(row.perOrder, 0.83)
  // +7 +3 -2 +4 +2 = 14 over 5 revisions.
  assert.equal(row.averageDaysMoved, 2.8)
  assert.deepEqual(row.movedLater, { count: 4, of: 5, share: 0.8 })
})

test('orders outside the window, not sent, cancelled or without a supplier are not counted', () => {
  const purchaseOrders = [
    order('PO-in', 'acme', '2026-09-01'),
    order('PO-old', 'acme', '2026-08-01'),
    order('PO-late', 'acme', '2026-12-01'),
    // Approved, never issued, nothing received: the scorecard's "not sent".
    order('PO-unsent', 'acme', '2026-10-01', { status: 'approved', issuedAt: null }),
    order('PO-cancelled', 'acme', '2026-10-01', { status: 'cancelled' }),
    order('PO-none', null, '2026-10-01'),
    // No original promise: dated by its current date, as the scorecard does.
    order('PO-current', 'acme', null, { lines: [{ id: 'C-L1', originalPromisedDate: null, metadata: { promisedDate: '2026-10-15' }, receivedQuantity: 0 }] }),
  ]
  const revisions = purchaseOrders.map((row) => revision(row.id, '2026-10-01', '2026-10-09'))
  const row = build({ purchaseOrders, revisions }).suppliers.acme.revisions
  assert.deepEqual([row.orders, row.revisions], [2, 2])
})

test('every reply is in one outcome, and the outcomes add up to the replies received', () => {
  const replies = [
    reply('acme', 'recorded', { editedLines: 0, check: { lines: [{ outcome: 'proposed' }] }, decidedAt: at('2026-11-10') }),
    reply('acme', 'recorded', { editedLines: 2, check: { lines: [{ outcome: 'needs_you' }] }, decidedAt: at('2026-11-11') }),
    reply('acme', 'not_recorded', { reasonCode: 'wrong_reading', check: { lines: [{ outcome: 'proposed' }] } }),
    reply('acme', 'not_recorded', { reasonCode: 'supplier_will_confirm' }),
    reply('acme', 'not_recorded', { reasonCode: 'something_new' }),
    reply('acme', 'needs_you', { readingStatus: 'ai_off', check: null }),
    reply('acme', 'proposed', { check: { lines: [{ outcome: 'confirmed' }, { outcome: 'dropped' }] } }),
    reply('acme', 'nothing_to_record'),
    // From the order when the reply has no supplier recorded.
    reply(null, 'needs_you', { purchaseOrder: { supplierId: 'acme' } }),
    // A superseded paste is never a reply of its own.
    reply('acme', 'superseded'),
  ]
  const row = build({ replies }).suppliers.acme.replies
  assert.equal(row.received, 9)
  assert.equal(row.read, 8)
  assert.deepEqual(row.outcomes, { recordedUnchanged: 1, recordedEdited: 1, notRecorded: { wrong_reading: 1, supplier_will_confirm: 1, other: 1 }, needsYou: 2, proposed: 1, nothingToRecord: 1 })
  const { notRecorded, ...rest } = row.outcomes
  assert.equal(Object.values(rest).reduce((a, b) => a + b, 0) + Object.values(notRecorded).reduce((a, b) => a + b, 0), row.received)
  // Recorded unchanged, the dismissed wrong reading and the confirmed one: 3 of 8 read.
  assert.deepEqual(row.withStatedDate, { count: 3, of: 8, share: 0.375 })
  assert.equal(row.recorded, 2)
  assert.equal(row.medianHoursToRecord, null)
  assert.equal(supplierReplyOutcome({ state: 'superseded' }), null)
})

test('the median hours to record appear from 5 recorded replies', () => {
  const hours = [1, 3, 30, 2, 48]
  const replies = hours.map((value) => reply('acme', 'recorded', { createdAt: at('2026-11-10'), decidedAt: new Date(at('2026-11-10').getTime() + value * 3_600_000) }))
  const row = build({ replies }).suppliers.acme.replies
  assert.deepEqual([row.recorded, row.medianHoursToRecord], [5, 3])
})

test('a supplier with nothing in the window gets zero counts and null shares, not a missing row', () => {
  const result = build({})
  assert.deepEqual(result.suppliers.quiet.revisions, { orders: 0, revisedOrders: 0, revisions: 0, perOrder: null, averageDaysMoved: null, movedLater: { count: 0, of: 0, share: null } })
  assert.equal(result.suppliers.quiet.replies.withStatedDate.share, null)
  assert.equal(result.window.days, 90)
})

test('a reader without purchase order access gets null parts and nothing is counted', () => {
  const result = buildSupplierReliability({ suppliers: [{ id: 'acme' }], window, asOf: window.to, visibility: { revisions: false, replies: false }, purchaseOrders: [order('PO-1', 'acme', '2026-11-01')], replies: [reply('acme', 'recorded')] })
  assert.deepEqual(result.suppliers.acme, { revisions: null, replies: null })
})

// A stand-in database that answers the reads the service makes, and keeps
// what each was asked.
function standIn({ permissions = ['procurement.purchase_order.read'] } = {}) {
  const asked = {}
  const prisma = {
    tenant: { findUnique: async () => ({ timezone: 'Europe/London' }) },
    supplier: { findMany: async () => [{ id: 'acme' }] },
    purchaseOrder: { findMany: async (query) => { asked.orders = query; return [order('PO-1', 'acme', '2026-11-01')] } },
    purchaseOrderPromiseRevision: { findMany: async (query) => { asked.revisions = query; return [revision('PO-1', '2026-11-01', '2026-11-04')] } },
    supplierReply: { findMany: async (query) => { asked.replies = query; return [reply('acme', 'proposed')] } },
  }
  const actor = { complete: true, authenticated: true, tenantId: 't1', user: { id: 'u1' }, permissionCodes: new Set(permissions), allWarehouses: true, readWarehouseIds: [], operateWarehouseIds: [] }
  return { prisma, actor, asked }
}

test('the service reads the scorecard\'s 90 days in the workspace timezone and leaves superseded replies out', async () => {
  const { prisma, actor, asked } = standIn()
  const service = createSupplierReliabilityReadService({ prisma, now: () => new Date('2026-11-20T23:30:00Z') })
  const result = supplierReliabilityResponseSchema.parse(await service.read({ actor }))
  // 23:30 UTC is 23:30 in London on 20 Nov.
  assert.deepEqual([result.asOf, result.window], ['2026-11-20', { from: '2026-08-23', to: '2026-11-20', days: 90 }])
  assert.deepEqual(asked.replies.where, { tenantId: 't1', receivedOn: { gte: '2026-08-23', lte: '2026-11-20' }, state: { not: 'superseded' } })
  assert.deepEqual(asked.revisions.where, { tenantId: 't1', purchaseOrderId: { in: ['PO-1'] }, previousDate: { not: null } })
  assert.deepEqual([result.suppliers.acme.revisions.revisions, result.suppliers.acme.replies.outcomes.proposed], [1, 1])
})

test('without purchase order read the service reads no orders, revisions or replies', async () => {
  const { prisma, actor, asked } = standIn({ permissions: ['receiving.read'] })
  const result = await createSupplierReliabilityReadService({ prisma }).read({ actor })
  assert.deepEqual(result.visibility, { revisions: false, replies: false })
  assert.deepEqual([asked.orders, asked.revisions, asked.replies], [undefined, undefined, undefined])
  assert.deepEqual(result.suppliers.acme, { revisions: null, replies: null })
})

// The scorecard stays on the original promise (#363 §4.12): a date the
// supplier moved later does not make a late delivery on time, and the
// scorecard reads nothing this measure reads.
test('on time stays measured against the original promise, whatever the revisions say', () => {
  const promised = { id: 'PO-R', supplierId: 'acme', supplierName: 'Acme', currency: 'GBP', status: 'fully_received', issuedAt: at('2026-10-01'), expectedDate: null, metadata: {}, lines: [{ id: 'PO-R-L1', sku: 'SKU-1', itemName: 'Holder', unit: 'pcs', orderedQuantity: 10, receivedQuantity: 10, amount: 100, originalPromisedDate: at('2026-11-02'), metadata: { promisedDate: '2026-11-12' } }] }
  const receipts = [{ id: 'GRN-1', poId: 'PO-R', postedAt: '2026-11-09T12:00:00Z', lines: [{ purchaseOrderLineId: 'PO-R-L1', acceptedQty: 10, rejectedQty: 0 }] }]
  const scorecard = buildSupplierScorecard({ purchaseOrders: [promised], receipts, suppliers: [{ id: 'acme', name: 'Acme' }], period: window, asOfDay: window.to, timeZone: 'Europe/London' })
  const [row] = scorecard.suppliers
  // Received 9 Nov: 7 days after the original 2 Nov, before the revised 12 Nov.
  assert.equal(row.obligations[0].onTime, false)
  assert.equal(row.obligations[0].daysLate, 7)
  const reliability = buildSupplierReliability({ suppliers: [{ id: 'acme' }], purchaseOrders: [promised], revisions: [revision('PO-R', '2026-11-02', '2026-11-12', 'supplier_reply')], window, asOf: window.to, visibility: visible })
  assert.equal(reliability.suppliers.acme.revisions.revisions, 1)
  const source = readFileSync(new URL('./supplier-scorecard.mjs', import.meta.url), 'utf8')
  for (const word of ['supplierReply', 'purchaseOrderPromiseRevision', 'supplier-reliability']) assert.equal(source.includes(word), false, word)
})
