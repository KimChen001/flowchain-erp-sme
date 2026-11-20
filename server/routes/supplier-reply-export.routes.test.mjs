// The supplier reply outcome export (services/supplier-reply-export.mjs) on
// rows given in memory: the window, the outcomes (shared with the supplier
// evaluation page through domain/supplier-reply-outcome.mjs), DD-7's rule that
// reply text leaves only a public-data workspace, the revisions' sources and
// reply links, truncation, the About sheet and the route's answers. No
// database.
import test from 'node:test'
import assert from 'node:assert/strict'
import { handleSupplierReplyExportRoute } from './supplier-reply-export.routes.mjs'
import {
  SUPPLIER_REPLY_EXPORT_LIMIT, createSupplierReplyExportService, supplierReplyExportRows, supplierReplyExportWindow, supplierReplyLineOutcomes, tenantDayStart,
} from '../services/supplier-reply-export.mjs'

const TENANT = 'tenant-uci'
const NOW = new Date('2026-11-20T15:00:00Z')
const PUBLIC_NOTE = { dataset: 'uci', sourceWindow: { first: '2010-12-01', last: '2011-12-09' }, window: { first: '2025-12-01', last: '2026-12-09' }, shiftDays: 5479 }
const PERMISSIONS = ['settings.export.read', 'procurement.purchase_order.read']

const check = (lines, extra = {}) => ({ state: 'proposed', replyKind: 'dates', lines, flags: [], reason: null, dropped: 0, ...extra })
const line = (ref, outcome, issue = null, proposedDate = null, order = 'PO-1') => ({ ref, purchaseOrderLineId: `${order}-${ref}`, outcome, issue, currentDate: '2026-11-12', proposedDate, quote: null, dateKind: 'stated', readAs: null, readings: null, parts: null })
const reply = (fields) => ({ supplierId: 'SUP-1', source: 'paste', readingStatus: 'read', provider: 'gateway', model: 'model-a', promptVersion: 'supplier-reply-read-2', usage: null, instructionsIgnored: false, quotedTextHidden: false, decision: null, reasonCode: null, decidedById: null, decidedAt: null, editedLines: 0, revisionIds: null, supersededById: null, note: null, ...fields })
const REPLIES = [
  // Proposed L1 27 Nov, recorded 28 Nov: edited.
  reply({
    id: 'reply-recorded', purchaseOrderId: 'PO-1', receivedOn: '2026-11-17', createdAt: new Date('2026-11-17T09:00:00Z'), state: 'recorded',
    check: check([line('L1', 'proposed', null, '2026-11-27'), line('L2', 'needs_you', 'date_mismatch')], { flags: [{ kind: 'price_change', quote: 'x', orderNumber: null }] }),
    usage: { calls: 1, inputTokens: 900, outputTokens: 120, ms: 2100 }, quotedTextHidden: true,
    decision: 'recorded', decidedById: 'user-1', decidedAt: new Date('2026-11-17T09:42:30Z'), editedLines: 1, revisionIds: ['rev-1'],
    text: 'We can ship the balance on Friday 27 November.',
  }),
  reply({
    id: 'reply-wrong', purchaseOrderId: 'PO-1', receivedOn: '2026-11-18', createdAt: new Date('2026-11-18T10:00:00Z'), state: 'not_recorded',
    check: check([line('L1', 'proposed', null, '2026-12-03')]), usage: { calls: 2, inputTokens: 1800, outputTokens: 240 }, instructionsIgnored: true,
    decision: 'not_recorded', reasonCode: 'wrong_reading', decidedById: 'user-1', decidedAt: new Date('2026-11-18T10:05:00Z'),
    text: 'Week 49 at the earliest.', note: 'It read week 49 as 3 Dec',
  }),
  // AI off: nothing proposed, the date typed by hand. The service counted the line as edited.
  reply({
    id: 'reply-manual', purchaseOrderId: 'PO-2', supplierId: 'SUP-2', receivedOn: '2026-11-18', createdAt: new Date('2026-11-18T11:00:00Z'), state: 'recorded', readingStatus: 'ai_off', provider: null, model: null, promptVersion: null,
    check: null, decision: 'recorded', decidedById: 'user-2', decidedAt: new Date('2026-11-18T11:10:00Z'), editedLines: 1, revisionIds: ['rev-2'], text: 'New date 4 December.',
  }),
  // Recorded as proposed, but saving its revision ids failed: the audit row links them.
  reply({
    id: 'reply-unsaved', purchaseOrderId: 'PO-3', supplierId: 'SUP-2', receivedOn: '2026-11-19', createdAt: new Date('2026-11-19T09:00:00Z'), state: 'recorded',
    check: check([line('L1', 'proposed', null, '2026-12-01', 'PO-3')]), decision: 'recorded', decidedById: 'user-1', decidedAt: new Date('2026-11-19T09:01:00Z'), revisionIds: null, text: 'Shipping 1 December.',
  }),
  reply({ id: 'reply-old', purchaseOrderId: 'PO-2', supplierId: null, receivedOn: '2026-07-01', createdAt: new Date('2026-07-01T10:00:00Z'), state: 'nothing_to_record', check: check([], { state: 'nothing_to_record', replyKind: 'auto_reply' }), text: 'Out of office' }),
]
const revision = (id, order, lineId, previous, next, source, createdAt, reason, actorId = 'user-1') => ({ id, purchaseOrderId: order, purchaseOrderLineId: lineId, previousDate: new Date(`${previous}T12:00:00Z`), newDate: new Date(`${next}T12:00:00Z`), source, actorId, createdAt: new Date(createdAt), reason })
const REVISIONS = [
  // From the recorded reply, made late on 17 Nov in London.
  revision('rev-1', 'PO-1', 'PO-1-L1', '2026-11-12', '2026-11-28', 'supplier_reply', '2026-11-17T23:30:00Z', 'Supplier reply of 2026-11-17: "We can ship the balance on Friday 27 November."'),
  // Typed on the card with AI off: still from a reply.
  revision('rev-2', 'PO-2', 'PO-2-L1', '2026-11-01', '2026-12-04', 'supplier_reply', '2026-11-18T11:10:00Z', 'Supplier reply of 2026-11-18', 'user-2'),
  // By hand on the order page.
  revision('rev-4', 'PO-2', 'PO-2-L1', '2026-12-04', '2026-12-02', 'procurement_db_command_service', '2026-11-19T08:00:00Z', 'Called the supplier', 'user-2'),
  // From reply-unsaved; only its audit row names the reply.
  revision('rev-5', 'PO-3', 'PO-3-L1', '2026-11-14', '2026-12-01', 'supplier_reply', '2026-11-19T09:01:00Z', 'Supplier reply of 2026-11-19: "Shipping 1 December."'),
  // 00:30 on 21 Nov in London: after the window ending 20 Nov.
  revision('rev-3', 'PO-2', 'PO-2-L1', '2026-12-02', '2026-12-04', 'procurement_db_command_service', '2026-11-21T00:30:00Z', 'x', 'user-2'),
]
const AUDIT = REVISIONS.map((row) => ({
  entityId: row.purchaseOrderLineId, createdAt: row.createdAt, action: 'purchase_order_promise_revised',
  metadata: { revisionId: row.id, ...(row.id === 'rev-5' ? { origin: { type: 'supplier_reply', id: 'reply-unsaved' } } : row.source === 'supplier_reply' ? { origin: { type: 'supplier_reply', id: row.id === 'rev-1' ? 'reply-recorded' : 'reply-manual' } } : {}) },
}))

// A Prisma stand-in holding the rows above; findMany honours the filters the
// export uses, and select keeps only the fields asked for.
function fakePrisma({ publicData = true, timezone = 'Europe/London', replies = REPLIES, revisions = REVISIONS } = {}) {
  const seen = []
  const pick = (row, select) => (select ? Object.fromEntries(Object.keys(select).filter((key) => select[key]).map((key) => [key, row[key]])) : row)
  const inRange = (value, range) => (!range || ((range.gte === undefined || value >= range.gte) && (range.lte === undefined || value <= range.lte) && (range.lt === undefined || value < range.lt)))
  const inList = (value, filter) => (!filter || filter.in.includes(value))
  const pathValue = (metadata, path) => path.reduce((at, key) => at?.[key], metadata)
  return {
    seen,
    tenant: { findUnique: async ({ where }) => (where.id === TENANT ? { timezone } : null) },
    runtimeRecord: { findUnique: async ({ where }) => (publicData && where.tenantId_namespace_recordKey.namespace === 'workspace.public-data' ? { payload: PUBLIC_NOTE } : null) },
    supplierReply: {
      findMany: async ({ where, select, take }) => {
        seen.push({ model: 'supplierReply', select })
        return replies.filter((row) => where.tenantId === TENANT && inRange(row.receivedOn, where.receivedOn) && (!where.state || row.state === where.state)).slice(0, take).map((row) => pick(row, select))
      },
    },
    purchaseOrderPromiseRevision: {
      findMany: async ({ where, select, take }) => {
        seen.push({ model: 'purchaseOrderPromiseRevision', select })
        return revisions.filter((row) => where.tenantId === TENANT && inRange(row.createdAt, where.createdAt) && inList(row.id, where.id)).slice(0, take).map((row) => pick(row, select))
      },
    },
    auditLog: {
      findMany: async ({ where }) => AUDIT.filter((row) => row.action === where.action && inList(row.entityId, where.entityId) && inRange(row.createdAt, where.createdAt)
        && (!where.OR || where.OR.some(({ metadata }) => pathValue(row.metadata, metadata.path) === metadata.equals))).map((row) => ({ metadata: row.metadata })),
    },
    purchaseOrder: { findMany: async ({ where, select }) => [{ id: 'PO-1', number: 'PO-202610-0028', supplierId: 'SUP-1', supplierName: 'Acme Home Goods' }, { id: 'PO-2', number: 'PO-202610-0029', supplierId: 'SUP-2', supplierName: 'Globex Party Supplies' }, { id: 'PO-3', number: 'PO-202610-0030', supplierId: 'SUP-2', supplierName: 'Globex Party Supplies' }].filter((row) => where.id.in.includes(row.id)).map((row) => pick(row, select)) },
    purchaseOrderLine: { findMany: async ({ where }) => [{ id: 'PO-1-L1', sku: '85123A' }, { id: 'PO-2-L1', sku: '84879' }, { id: 'PO-3-L1', sku: '22423' }].filter((row) => where.id.in.includes(row.id)) },
    supplier: { findMany: async ({ where, select }) => [{ id: 'SUP-1', code: 'S-ACME', name: 'Acme Home Goods' }, { id: 'SUP-2', code: 'S-GLOBEX', name: 'Globex Party Supplies' }].filter((row) => where.id.in.includes(row.id)).map((row) => pick(row, select)) },
  }
}
const actorWith = (permissions) => async (_prisma, identity) => ({ tenantId: identity.tenantId, user: { id: identity.userId }, complete: true, authenticated: true, permissionCodes: new Set(permissions), roleIds: [], permissionSourceRoleIds: new Map() })
const IDENTITY = { authenticated: true, tenantId: TENANT, userId: 'user-admin' }
const serviceOf = (options = {}, permissions = PERMISSIONS) => createSupplierReplyExportService({ prisma: options.prisma || fakePrisma(options), now: () => NOW, resolveActor: actorWith(permissions) })
const byId = (rows, key) => Object.fromEntries(rows.map((row) => [row[key], row]))

test('the window defaults to the 90 days ending today, and refuses bad days, a reversed window or more than a year', () => {
  assert.deepEqual(supplierReplyExportWindow({}, '2026-11-20'), { from: '2026-08-23', to: '2026-11-20' })
  assert.deepEqual(supplierReplyExportWindow({ from: '2026-11-01', to: '2026-11-30' }, '2026-11-20'), { from: '2026-11-01', to: '2026-11-30' })
  assert.throws(() => supplierReplyExportWindow({ from: '2026-02-30' }, '2026-11-20'), { code: 'SUPPLIER_REPLY_EXPORT_DAY_INVALID', status: 422 })
  assert.throws(() => supplierReplyExportWindow({ from: '2026-11-21', to: '2026-11-20' }, '2026-11-20'), { code: 'SUPPLIER_REPLY_EXPORT_WINDOW_INVALID' })
  assert.throws(() => supplierReplyExportWindow({ from: '2025-11-01', to: '2026-11-20' }, '2026-11-20'), { code: 'SUPPLIER_REPLY_EXPORT_WINDOW_TOO_LONG' })
})

test('a workspace day starts at its own midnight, across offsets and a clock change', () => {
  assert.equal(tenantDayStart('2026-11-20', 'Europe/London').toISOString(), '2026-11-20T00:00:00.000Z')
  assert.equal(tenantDayStart('2026-11-20', 'America/New_York').toISOString(), '2026-11-20T05:00:00.000Z')
  assert.equal(tenantDayStart('2026-07-01', 'America/New_York').toISOString(), '2026-07-01T04:00:00.000Z')
  assert.equal(tenantDayStart('2026-11-20', 'Asia/Kathmandu').toISOString(), '2026-11-19T18:15:00.000Z')
  assert.equal(tenantDayStart('2026-03-29', 'Europe/London').toISOString(), '2026-03-29T00:00:00.000Z')
  assert.equal(supplierReplyLineOutcomes(REPLIES[0].check), 'L1:proposed; L2:needs_you/date_mismatch')
})

test('outside a public-data workspace the rows hold codes, ids and dates only (DD-7)', () => {
  const { replies, revisions } = supplierReplyExportRows({ replies: REPLIES.slice(0, 2), revisions: REVISIONS.slice(0, 1), includeText: false, timeZone: 'Europe/London' })
  for (const row of replies) for (const key of ['reply_text', 'decision_note', 'supplier_name']) assert.ok(!(key in row), key)
  assert.ok(!('reason' in revisions[0]))
  assert.doesNotMatch(JSON.stringify({ replies, revisions }), /ship the balance|week 49|Acme Home Goods/i)
})

test('a public-data workspace\'s export holds the replies with their outcomes, the window\'s revisions with their reply, and the text', async () => {
  const result = await serviceOf().exportOutcomes({ from: '2026-11-01', to: '2026-11-20' }, IDENTITY)
  assert.deepEqual([result.window, result.publicData, result.textIncluded, result.truncated, result.timeZone], [{ from: '2026-11-01', to: '2026-11-20' }, 'uci', true, { replies: false, revisions: false }, 'Europe/London'])
  const replies = byId(result.replies, 'reply_id')
  assert.deepEqual(Object.keys(replies), ['reply-recorded', 'reply-wrong', 'reply-manual', 'reply-unsaved'])
  const recorded = replies['reply-recorded']
  assert.deepEqual(
    [recorded.order_number, recorded.supplier_code, recorded.supplier_name, recorded.card_state, recorded.outcome, recorded.line_outcomes, recorded.proposed_dates, recorded.flags, recorded.lines_edited, recorded.lines_by_hand, recorded.revision_ids, recorded.minutes_to_decision, recorded.calls, recorded.input_tokens, recorded.output_tokens, recorded.prompt_version],
    ['PO-202610-0028', 'S-ACME', 'Acme Home Goods', 'proposed', 'recorded_edited', 'L1:proposed; L2:needs_you/date_mismatch', 'L1:2026-11-27', 'price_change', 1, 0, 'rev-1', 43, 1, 900, 120, 'supplier-reply-read-2'],
  )
  const wrong = replies['reply-wrong']
  assert.deepEqual([wrong.outcome, wrong.reason_code, wrong.lines_edited, wrong.instructions_ignored, wrong.reply_text, wrong.decision_note], ['not_recorded_wrong_reading', 'wrong_reading', null, true, 'Week 49 at the earliest.', 'It read week 49 as 3 Dec'])
  // Nothing was proposed: manual, not edited, though the service counted an edit.
  const manual = replies['reply-manual']
  assert.deepEqual([manual.card_state, manual.outcome, manual.lines_edited, manual.lines_by_hand], ['needs_you', 'recorded_manual', 0, 1])
  // Its revision ids were not saved: found through the audit row, and unchanged.
  const unsaved = replies['reply-unsaved']
  assert.deepEqual([unsaved.outcome, unsaved.revision_ids, unsaved.lines_edited], ['recorded_unchanged', 'rev-5', 0])
  // rev-3 was made on 21 Nov in the workspace's timezone: outside the window.
  assert.deepEqual(result.revisions.map((row) => [row.revision_id, row.source, row.reply_id, row.sku, row.previous_date, row.new_date, row.days_moved, row.revised_on]), [
    ['rev-1', 'supplier_reply', 'reply-recorded', '85123A', '2026-11-12', '2026-11-28', 16, '2026-11-17'],
    ['rev-2', 'supplier_reply', 'reply-manual', '84879', '2026-11-01', '2026-12-04', 33, '2026-11-18'],
    ['rev-4', 'manual', null, '84879', '2026-12-04', '2026-12-02', -2, '2026-11-19'],
    ['rev-5', 'supplier_reply', 'reply-unsaved', '22423', '2026-11-14', '2026-12-01', 17, '2026-11-19'],
  ])
  assert.match(result.revisions[0].reason, /Supplier reply of 2026-11-17/)
  const about = Object.fromEntries(result.about.map(({ field, value }) => [field, value]))
  assert.deepEqual(
    [about.as_of, about.window_from, about.window_to, about.time_zone, about.public_data, about.text_included, about.limit_per_sheet, about.replies_rows, about.replies_truncated, about.revisions_rows, about.revisions_truncated],
    ['2026-11-20T15:00:00.000Z', '2026-11-01', '2026-11-20', 'Europe/London', 'uci', true, SUPPLIER_REPLY_EXPORT_LIMIT, 4, false, 4, false],
  )
})

test('a workspace that is not public data never reads the reply text, notes, names or reasons from the database', async () => {
  const prisma = fakePrisma({ publicData: false })
  const result = await serviceOf({ prisma }).exportOutcomes({ from: '2026-11-01', to: '2026-11-20' }, IDENTITY)
  assert.deepEqual([result.publicData, result.textIncluded, result.replies.length, result.revisions.length], [null, false, 4, 4])
  for (const { select } of prisma.seen) for (const key of ['text', 'note', 'reason', 'name']) assert.ok(!select?.[key], key)
  assert.doesNotMatch(JSON.stringify(result.replies) + JSON.stringify(result.revisions), /ship the balance|week 49|Called the supplier|Acme Home Goods|Globex Party Supplies/i)
  assert.match(result.about.find((row) => row.field === 'text_rule').value, /left out/)
})

test('a sheet is marked cut only when it is, and then holds the earliest rows of the window', async () => {
  const many = Array.from({ length: SUPPLIER_REPLY_EXPORT_LIMIT + 3 }, (_, at) => revision(`rev-many-${String(at).padStart(5, '0')}`, 'PO-2', 'PO-2-L1', '2026-11-01', '2026-11-30', 'procurement_db_command_service', new Date(Date.parse('2026-11-02T00:00:00Z') + at * 60_000).toISOString(), 'x'))
  const cut = await serviceOf({ revisions: many }).exportOutcomes({ from: '2026-11-01', to: '2026-11-20' }, IDENTITY)
  assert.deepEqual([cut.truncated, cut.revisions.length, cut.revisions[0].revision_id, cut.revisions.at(-1).revision_id], [{ replies: false, revisions: true }, SUPPLIER_REPLY_EXPORT_LIMIT, 'rev-many-00000', `rev-many-0${SUPPLIER_REPLY_EXPORT_LIMIT - 1}`])
  const full = await serviceOf({ revisions: many.slice(0, SUPPLIER_REPLY_EXPORT_LIMIT) }).exportOutcomes({ from: '2026-11-01', to: '2026-11-20' }, IDENTITY)
  assert.deepEqual([full.truncated, full.revisions.length], [{ replies: false, revisions: false }, SUPPLIER_REPLY_EXPORT_LIMIT])
})

test('the export needs settings.export.read and the purchase order read permission', async () => {
  await assert.rejects(serviceOf({}, ['procurement.purchase_order.read']).exportOutcomes({}, IDENTITY), { status: 403 })
  await assert.rejects(serviceOf({}, ['settings.export.read']).exportOutcomes({}, IDENTITY), { status: 403 })
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
  assert.deepEqual([calls[0].status, calls[0].body.replies.length, calls[0].body.revisions.length], [200, 4, 4])
  assert.equal(await handleSupplierReplyExportRoute(ctxOf('GET', '/api/admin/supplier-reply-export?from=2026-11-21&to=2026-11-20', service)), true)
  assert.deepEqual(calls[1], { status: 422, body: { code: 'SUPPLIER_REPLY_EXPORT_WINDOW_INVALID', message: 'The start date is after the end date.' } })
  assert.equal(await handleSupplierReplyExportRoute(ctxOf('GET', '/api/admin/supplier-reply-export', serviceOf({}, []))), true)
  assert.equal(calls[2].status, 403)
})
