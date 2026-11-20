// The supplier reply outcome export (services/supplier-reply-export.mjs) on
// rows given in memory: the window, the outcome codes, DD-7's rule that reply
// text leaves only a public-data workspace, the revisions' sources and the
// route's answers. No database.
import test from 'node:test'
import assert from 'node:assert/strict'
import { handleSupplierReplyExportRoute } from './supplier-reply-export.routes.mjs'
import {
  createSupplierReplyExportService, supplierReplyExportRows, supplierReplyExportWindow, supplierReplyLineOutcomes, supplierReplyOutcome,
} from '../services/supplier-reply-export.mjs'

const TENANT = 'tenant-uci'
const NOW = new Date('2026-11-20T15:00:00Z')
const PUBLIC_NOTE = { dataset: 'uci', sourceWindow: { first: '2010-12-01', last: '2011-12-09' }, window: { first: '2025-12-01', last: '2026-12-09' }, shiftDays: 5479 }

const check = (lines, extra = {}) => ({ state: 'proposed', replyKind: 'dates', lines, flags: [], reason: null, dropped: 0, ...extra })
const line = (ref, outcome, issue = null, proposedDate = null) => ({ ref, purchaseOrderLineId: `PO-1-${ref}`, outcome, issue, currentDate: '2026-11-12', proposedDate, quote: null, dateKind: 'stated', readAs: null, readings: null, parts: null })
const REPLIES = [
  {
    id: 'reply-recorded', purchaseOrderId: 'PO-1', supplierId: 'SUP-1', source: 'paste', receivedOn: '2026-11-17', createdAt: new Date('2026-11-17T09:00:00Z'),
    state: 'recorded', readingStatus: 'read', provider: 'gateway', model: 'model-a', promptVersion: 'supplier-reply-read-2',
    check: check([line('L1', 'proposed', null, '2026-11-27'), line('L2', 'needs_you', 'date_mismatch')], { flags: [{ kind: 'price_change', quote: 'x', orderNumber: null }] }),
    usage: { calls: 1, inputTokens: 900, outputTokens: 120, ms: 2100 }, instructionsIgnored: false, quotedTextHidden: true,
    decision: 'recorded', reasonCode: null, decidedById: 'user-1', decidedAt: new Date('2026-11-17T09:42:30Z'), editedLines: 1, revisionIds: ['rev-1'], supersededById: null,
    text: 'We can ship the balance on Friday 27 November.', note: null,
  },
  {
    id: 'reply-wrong', purchaseOrderId: 'PO-1', supplierId: 'SUP-1', source: 'paste', receivedOn: '2026-11-18', createdAt: new Date('2026-11-18T10:00:00Z'),
    state: 'not_recorded', readingStatus: 'read', provider: 'gateway', model: 'model-a', promptVersion: 'supplier-reply-read-2',
    check: check([line('L1', 'proposed', null, '2026-12-03')]), usage: { calls: 2, inputTokens: 1800, outputTokens: 240 }, instructionsIgnored: true, quotedTextHidden: false,
    decision: 'not_recorded', reasonCode: 'wrong_reading', decidedById: 'user-1', decidedAt: new Date('2026-11-18T10:05:00Z'), editedLines: 0, revisionIds: null, supersededById: null,
    text: 'Week 49 at the earliest.', note: 'It read week 49 as 3 Dec',
  },
  {
    id: 'reply-old', purchaseOrderId: 'PO-2', supplierId: null, source: 'paste', receivedOn: '2026-07-01', createdAt: new Date('2026-07-01T10:00:00Z'),
    state: 'nothing_to_record', readingStatus: 'read', check: check([], { state: 'nothing_to_record', replyKind: 'auto_reply' }), usage: null, decision: null, revisionIds: null, text: 'Out of office', note: null,
  },
]
const REVISIONS = [
  // From the recorded reply, made late on 17 Nov in London.
  { id: 'rev-1', purchaseOrderId: 'PO-1', purchaseOrderLineId: 'PO-1-L1', previousDate: new Date('2026-11-12T12:00:00Z'), newDate: new Date('2026-11-28T12:00:00Z'), source: 'supplier_reply', actorId: 'user-1', createdAt: new Date('2026-11-17T23:30:00Z'), reason: 'Supplier reply of 17 Nov 2026: "We can ship the balance on Friday 27 November."' },
  // By hand on the order page.
  { id: 'rev-2', purchaseOrderId: 'PO-2', purchaseOrderLineId: 'PO-2-L1', previousDate: new Date('2026-11-01T12:00:00Z'), newDate: new Date('2026-10-30T12:00:00Z'), source: 'procurement_db_command_service', actorId: 'user-2', createdAt: new Date('2026-11-19T08:00:00Z'), reason: 'Called the supplier' },
  // 00:30 on 21 Nov in London: after the window ending 20 Nov.
  { id: 'rev-3', purchaseOrderId: 'PO-2', purchaseOrderLineId: 'PO-2-L1', previousDate: new Date('2026-10-30T12:00:00Z'), newDate: new Date('2026-11-04T12:00:00Z'), source: 'procurement_db_command_service', actorId: 'user-2', createdAt: new Date('2026-11-21T00:30:00Z'), reason: 'x' },
]

// A Prisma stand-in holding the rows above; findMany honours the filters the
// export uses, and select keeps only the fields asked for.
function fakePrisma({ publicData = true, timezone = 'Europe/London' } = {}) {
  const seen = []
  const pick = (row, select) => (select ? Object.fromEntries(Object.keys(select).filter((key) => select[key]).map((key) => [key, row[key]])) : row)
  const inRange = (value, range) => (!range || ((range.gte === undefined || value >= range.gte) && (range.lte === undefined || value <= range.lte) && (range.lt === undefined || value < range.lt)))
  const prisma = {
    seen,
    tenant: { findUnique: async ({ where }) => (where.id === TENANT ? { timezone } : null) },
    runtimeRecord: { findUnique: async ({ where }) => (publicData && where.tenantId_namespace_recordKey.namespace === 'workspace.public-data' ? { payload: PUBLIC_NOTE } : null) },
    supplierReply: {
      findMany: async ({ where, select, take }) => {
        seen.push({ model: 'supplierReply', select })
        return REPLIES.filter((row) => where.tenantId === TENANT && inRange(row.receivedOn, where.receivedOn) && (!where.state || row.state === where.state)).slice(0, take).map((row) => pick(row, select))
      },
    },
    purchaseOrderPromiseRevision: {
      findMany: async ({ where, select }) => {
        seen.push({ model: 'purchaseOrderPromiseRevision', select })
        return REVISIONS.filter((row) => where.tenantId === TENANT && inRange(row.createdAt, where.createdAt)).map((row) => pick(row, select))
      },
    },
    purchaseOrder: { findMany: async ({ where, select }) => [{ id: 'PO-1', number: 'PO-202610-0028', supplierId: 'SUP-1', supplierName: 'Acme Home Goods' }, { id: 'PO-2', number: 'PO-202610-0029', supplierId: 'SUP-2', supplierName: 'Globex Party Supplies' }].filter((row) => where.id.in.includes(row.id)).map((row) => pick(row, select)) },
    purchaseOrderLine: { findMany: async ({ where }) => [{ id: 'PO-1-L1', sku: '85123A' }, { id: 'PO-2-L1', sku: '84879' }].filter((row) => where.id.in.includes(row.id)) },
    supplier: { findMany: async ({ where, select }) => [{ id: 'SUP-1', code: 'S-ACME', name: 'Acme Home Goods' }, { id: 'SUP-2', code: 'S-GLOBEX', name: 'Globex Party Supplies' }].filter((row) => where.id.in.includes(row.id)).map((row) => pick(row, select)) },
  }
  return prisma
}
const actorWith = (permissions) => async (_prisma, identity) => ({ tenantId: identity.tenantId, user: { id: identity.userId }, complete: true, authenticated: true, permissionCodes: new Set(permissions), roleIds: [], permissionSourceRoleIds: new Map() })
const IDENTITY = { authenticated: true, tenantId: TENANT, userId: 'user-admin' }
const serviceOf = (options = {}, permissions = ['settings.export.read']) => createSupplierReplyExportService({ prisma: options.prisma || fakePrisma(options), now: () => NOW, resolveActor: actorWith(permissions) })

test('the window defaults to the 90 days ending today, and refuses bad days, a reversed window or more than a year', () => {
  assert.deepEqual(supplierReplyExportWindow({}, '2026-11-20'), { from: '2026-08-23', to: '2026-11-20' })
  assert.deepEqual(supplierReplyExportWindow({ from: '2026-11-01', to: '2026-11-30' }, '2026-11-20'), { from: '2026-11-01', to: '2026-11-30' })
  assert.throws(() => supplierReplyExportWindow({ from: '2026-02-30' }, '2026-11-20'), { code: 'SUPPLIER_REPLY_EXPORT_DAY_INVALID', status: 422 })
  assert.throws(() => supplierReplyExportWindow({ from: '2026-11-21', to: '2026-11-20' }, '2026-11-20'), { code: 'SUPPLIER_REPLY_EXPORT_WINDOW_INVALID' })
  assert.throws(() => supplierReplyExportWindow({ from: '2025-11-01', to: '2026-11-20' }, '2026-11-20'), { code: 'SUPPLIER_REPLY_EXPORT_WINDOW_TOO_LONG' })
})

test('outcome codes follow §4.12: recorded unchanged or edited, not recorded with its reason, and the open states as they are', () => {
  assert.equal(supplierReplyOutcome({ state: 'recorded', editedLines: 0 }), 'recorded_unchanged')
  assert.equal(supplierReplyOutcome({ state: 'recorded', editedLines: 2 }), 'recorded_edited')
  assert.equal(supplierReplyOutcome({ state: 'not_recorded', reasonCode: 'wrong_reading' }), 'not_recorded_wrong_reading')
  assert.equal(supplierReplyOutcome({ state: 'needs_you' }), 'needs_you')
  assert.equal(supplierReplyOutcome({ state: 'nothing_to_record' }), 'nothing_to_record')
  assert.equal(supplierReplyLineOutcomes(REPLIES[0].check), 'L1:proposed; L2:needs_you/date_mismatch')
})

test('outside a public-data workspace the rows hold codes, ids and dates only (DD-7)', () => {
  const { replies, revisions } = supplierReplyExportRows({ replies: REPLIES.slice(0, 2), revisions: REVISIONS.slice(0, 1), includeText: false, timeZone: 'Europe/London' })
  for (const row of replies) for (const key of ['reply_text', 'decision_note', 'supplier_name']) assert.ok(!(key in row), key)
  assert.ok(!('reason' in revisions[0]))
  assert.doesNotMatch(JSON.stringify({ replies, revisions }), /ship the balance|week 49|Acme Home Goods/i)
})

test('a public-data workspace\'s export holds both sheets, with the text, and only the window\'s rows', async () => {
  const prisma = fakePrisma()
  const result = await serviceOf({ prisma }).exportOutcomes({ from: '2026-11-01', to: '2026-11-20' }, IDENTITY)
  assert.deepEqual([result.window, result.publicData, result.textIncluded, result.truncated, result.timeZone], [{ from: '2026-11-01', to: '2026-11-20' }, 'uci', true, false, 'Europe/London'])
  assert.deepEqual(result.replies.map((row) => row.reply_id), ['reply-recorded', 'reply-wrong'])
  const [recorded, wrong] = result.replies
  assert.deepEqual(
    [recorded.order_number, recorded.supplier_code, recorded.supplier_name, recorded.outcome, recorded.line_outcomes, recorded.proposed_dates, recorded.flags, recorded.lines_edited, recorded.revision_ids, recorded.minutes_to_decision, recorded.calls, recorded.input_tokens, recorded.output_tokens, recorded.prompt_version],
    ['PO-202610-0028', 'S-ACME', 'Acme Home Goods', 'recorded_edited', 'L1:proposed; L2:needs_you/date_mismatch', 'L1:2026-11-27', 'price_change', 1, 'rev-1', 43, 1, 900, 120, 'supplier-reply-read-2'],
  )
  assert.deepEqual([wrong.outcome, wrong.reason_code, wrong.lines_edited, wrong.instructions_ignored, wrong.reply_text, wrong.decision_note], ['not_recorded_wrong_reading', 'wrong_reading', null, true, 'Week 49 at the earliest.', 'It read week 49 as 3 Dec'])
  // rev-3 was made on 21 Nov in the workspace's timezone: outside the window.
  assert.deepEqual(result.revisions.map((row) => [row.revision_id, row.source, row.reply_id, row.sku, row.previous_date, row.new_date, row.days_moved, row.revised_on]), [
    ['rev-1', 'supplier_reply', 'reply-recorded', '85123A', '2026-11-12', '2026-11-28', 16, '2026-11-17'],
    ['rev-2', 'manual', null, '84879', '2026-11-01', '2026-10-30', -2, '2026-11-19'],
  ])
  assert.match(result.revisions[0].reason, /Supplier reply of 17 Nov 2026/)
})

test('a workspace that is not public data never reads the reply text from the database', async () => {
  const prisma = fakePrisma({ publicData: false })
  const result = await serviceOf({ prisma }).exportOutcomes({ from: '2026-11-01', to: '2026-11-20' }, IDENTITY)
  assert.deepEqual([result.publicData, result.textIncluded, result.replies.length, result.revisions.length], [null, false, 2, 2])
  for (const { select } of prisma.seen) for (const key of ['text', 'note', 'reason', 'name']) assert.ok(!select?.[key], key)
  assert.doesNotMatch(JSON.stringify(result), /ship the balance|week 49|Called the supplier|Acme Home Goods|Globex Party Supplies/i)
})

test('the export needs settings.export.read', async () => {
  await assert.rejects(serviceOf({}, ['procurement.purchase_order.revise']).exportOutcomes({}, IDENTITY), { status: 403 })
})

test('the route answers GET /api/admin/supplier-reply-export only, with the export or the error\'s code', async () => {
  const calls = []
  const ctxOf = (method, path, service) => {
    const url = new URL(`http://local${path}`)
    return { req: { method }, url, identity: IDENTITY, res: {}, repositories: { supplierReplyExport: service }, send: (_res, status, body) => calls.push({ status, body }) }
  }
  const service = serviceOf()
  assert.equal(await handleSupplierReplyExportRoute(ctxOf('POST', '/api/admin/supplier-reply-export', service)), false)
  assert.equal(await handleSupplierReplyExportRoute(ctxOf('GET', '/api/admin/pilot-diagnostics', service)), false)
  assert.equal(await handleSupplierReplyExportRoute(ctxOf('GET', '/api/admin/supplier-reply-export?from=2026-11-01&to=2026-11-20', service)), true)
  assert.deepEqual([calls[0].status, calls[0].body.replies.length, calls[0].body.revisions.length], [200, 2, 2])
  assert.equal(await handleSupplierReplyExportRoute(ctxOf('GET', '/api/admin/supplier-reply-export?from=2026-11-21&to=2026-11-20', service)), true)
  assert.deepEqual(calls[1], { status: 422, body: { code: 'SUPPLIER_REPLY_EXPORT_WINDOW_INVALID', message: 'The start date is after the end date.' } })
  assert.equal(await handleSupplierReplyExportRoute(ctxOf('GET', '/api/admin/supplier-reply-export', serviceOf({}, []))), true)
  assert.equal(calls[2].status, 403)
})
